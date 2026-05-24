/**
 * Claude Code CLI adapter
 *
 * 对接 `claude --print --output-format stream-json`，
 * 将 Claude 私有的 stream-json 事件格式统一转换为内部事件。
 */

import { spawn, execSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { send } from '../../transport/events.js';
import { recordWorkerStep } from '../session.js';
import { summarizeToolInput } from '../toolSummary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 启动时解析 claude 绝对路径，避免服务进程 PATH 不完整导致找不到
let CLAUDE_BIN = 'claude';
try { CLAUDE_BIN = execSync('which claude', { encoding: 'utf8' }).trim(); } catch {};

/**
 * @param {object} opts - 见 agent.js runAgent 说明
 */
export function run({ agentName, prompt, systemPromptFile, model = 'sonnet', cwd = __dirname, ws, abortControllers, onText }) {
  return new Promise((resolve, reject) => {
    let killed = false;
    const key = `${agentName}-${Date.now()}-${Math.random()}`;

    const proc = spawn(CLAUDE_BIN, [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--model', model,
      '--system-prompt-file', systemPromptFile,
      '--add-dir', join(__dirname, '../../..'),
      '-p', prompt,
    ], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: true });

    abortControllers.set(key, () => {
      killed = true;
      // 用进程组 SIGKILL 确保 claude 及其所有子进程（工具调用的 bash 等）全部终止
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
    });

    let buffer = '';
    let lastResult = null; // 记录最后一个 result 事件，用于退出码非0时提取实际错误原因
    proc.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'result') lastResult = evt;
          handleEvent(evt, agentName, ws, onText);
        } catch { /* 忽略非 JSON 行 */ }
      }
    });

    let stderrBuf = '';
    proc.stderr.on('data', d => { stderrBuf += d.toString(); });

    proc.on('close', code => {
      abortControllers.delete(key);
      if (killed) return resolve('');
      if (code !== 0 && code !== null) {
        // 优先从 result 事件里取实际错误原因（比如未登录），否则用 stderr
        const reason = lastResult?.result || stderrBuf || '';
        reject(new Error(`[${agentName}] 退出码 ${code}: ${reason.slice(0, 300)}`));
      } else {
        resolve();
      }
    });
    proc.on('error', err => { abortControllers.delete(key); reject(err); });
  });
}

function handleEvent(event, agentName, ws, onText) {
  if (event.type === 'assistant') {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text') {
        onText?.(block.text);
        send(ws, { type: 'agent_text', agent: agentName, text: block.text });
      }
      if (block.type === 'tool_use') {
        send(ws, { type: 'agent_tool_use', agent: agentName, tool: block.name, input: block.input });
        const toolText = summarizeToolInput(block.name, block.input);
        if (toolText) {
          const step = { workerId: agentName, step: 'tool', tool: block.name, text: toolText };
          send(ws, { type: 'worker_step', ...step });
          const sid = typeof ws === 'string' ? ws : null;
          if (sid) recordWorkerStep(sid, step);
        }
      }
    }
  }
  if (event.type === 'tool_result') {
    const content = typeof event.content === 'string'
      ? event.content.slice(0, 500)
      : JSON.stringify(event.content).slice(0, 500);
    send(ws, { type: 'agent_tool_result', agent: agentName, content });
  }
  if (event.type === 'result') {
    send(ws, { type: 'agent_done', agent: agentName, cost: event.total_cost_usd, turns: event.num_turns });
  }
  if (event.type === 'system') {
    send(ws, { type: 'agent_ready', agent: agentName, model: event.model });
  }
}
