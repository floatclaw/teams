/**
 * OpenClaw agent CLI adapter
 *
 * 调用方式：
 *   openclaw --log-level silent agent [--agent <name>] --json
 *            --session-id <id> --message <prompt>
 *
 * 输出格式：单体 JSON blob（stdout），结构：
 *   {
 *     "status": "ok",
 *     "result": {
 *       "payloads": [{ "text": "..." }],
 *       "meta": { "durationMs": ..., "agentMeta": { "model": ..., "usage": ... } }
 *     }
 *   }
 *
 * 注意：
 *   - 不需要 --local（通过 gateway 模式运行）
 *   - --log-level silent 必须放在全局位置（openclaw 和 agent 之间），
 *     否则插件 staging 日志会混入 stdout 导致 JSON 解析失败
 *   - system prompt 内嵌到 --message 头部（openclaw 不支持 --system-prompt）
 */

import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { send } from '../../transport/events.js';
import { recordWorkerStep } from '../session.js';
import { summarizeToolInput } from '../toolSummary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dirname, '../../..', 'config', 'agent.json');

function getOpenclawBin() {
  if (existsSync(CONFIG_FILE)) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      if (cfg.openclawBin) return cfg.openclawBin;
    } catch {}
  }
  return 'openclaw';
}

/**
 * @param {object} opts - 见 agent.js runAgent 说明
 *   model 字段在 openclaw 里是 agent name（通过 --agent <name> 传入）
 */
export function run({ agentName, prompt, systemPromptFile, model, cwd = __dirname, ws, abortControllers, onText, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let killed = false;
    const key = `${agentName}-${Date.now()}-${Math.random()}`;
    const sessionId = `teams-${Date.now()}`;

    const openclawBin = getOpenclawBin();

    // openclaw 不支持 --system-prompt-file，将 system prompt 内嵌到 message 头部
    let systemPromptContent = '';
    try { systemPromptContent = readFileSync(systemPromptFile, 'utf8').trim(); } catch {}
    const fullMessage = systemPromptContent
      ? `${systemPromptContent}\n\n${prompt}`
      : prompt;

    // 参数顺序：openclaw [全局参数] agent [子命令参数]
    // --log-level silent 必须在 agent 子命令之前，否则插件日志会污染 stdout
    const args = [
      '--log-level', 'silent',
      'agent',
      '--json',
      '--session-id', sessionId,
    ];
    // model 字段作为 openclaw agent name 传入（可选，为空时 openclaw 使用默认 agent）
    if (model) args.push('--agent', model);
    args.push('--message', fullMessage);

    const proc = spawn(openclawBin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      detached: true,
    });

    abortControllers.set(key, () => {
      killed = true;
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
    });

    // 收集完整 stdout（单体 JSON blob）
    let stdoutBuf = '';
    proc.stdout.on('data', chunk => { stdoutBuf += chunk.toString(); });

    // 收集 stderr 用于错误诊断（silent 模式下应该很少有内容）
    let stderrBuf = '';
    proc.stderr.on('data', chunk => { stderrBuf += chunk.toString(); });

    proc.on('close', code => {
      abortControllers.delete(key);
      if (killed) return resolve('');

      const raw = stdoutBuf.trim();

      if (!raw) {
        const detail = stderrBuf.slice(0, 300).trim() || '(no output)';
        reject(new Error(`[${agentName}] openclaw 无输出（退出码 ${code}）: ${detail}`));
        return;
      }

      // 解析单体 JSON blob
      let result;
      try {
        result = JSON.parse(raw);
      } catch (e) {
        reject(new Error(`[${agentName}] openclaw 输出无法解析为 JSON: ${raw.slice(0, 200)}`));
        return;
      }

      // 检查顶层 status
      if (result.status !== 'ok') {
        const errMsg = result.error || result.message || result.status || 'unknown error';
        reject(new Error(`[${agentName}] openclaw 返回错误: ${errMsg}`));
        return;
      }

      // 提取 payloads 文本
      const payloads = result.result?.payloads || [];
      for (const p of payloads) {
        if (p.text) {
          onText?.(p.text);
          send(ws, { type: 'agent_text', agent: agentName, text: p.text });
        }
      }

      // 工具调用步骤（从 executionTrace 提取，用于 UI 展示）
      const attempts = result.result?.meta?.executionTrace?.attempts || [];
      for (const attempt of attempts) {
        if (attempt.tool) {
          const toolText = summarizeToolInput(attempt.tool, attempt.input || {});
          if (toolText) {
            const step = { workerId: agentName, step: 'tool', tool: attempt.tool, text: toolText };
            send(ws, { type: 'worker_step', ...step });
            const sid = typeof ws === 'string' ? ws : null;
            if (sid) recordWorkerStep(sid, step);
          }
        }
      }

      send(ws, { type: 'agent_done', agent: agentName });
      resolve();
    });

    proc.on('error', err => { abortControllers.delete(key); reject(err); });
  });
}
