/**
 * pi agent CLI adapter
 *
 * 对接 `pi --print --mode json`，
 * 将 pi 的 json 流事件格式映射为内部统一事件。
 *
 * pi 事件类型（关键）：
 *   agent_start         → agent_ready
 *   message_update      → assistantMessageEvent.type:
 *     text_delta        → agent_text / onText
 *     toolcall_end      → agent_tool_use
 *   tool_execution_end  → agent_tool_result
 *   agent_end           → agent_done
 *
 * 参数映射：
 *   systemPromptFile → 读取文件内容后通过 --append-system-prompt 传入
 *   model            → --model <pattern>（支持 provider/model 格式，如 anthropic/claude-sonnet-4-5）
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { send } from '../../transport/events.js';
import { recordWorkerStep } from '../session.js';
import { summarizeToolInput } from '../toolSummary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PI_BIN = 'pi';

/**
 * @param {object} opts - 见 agent.js runAgent 说明
 */
export function run({ agentName, prompt, systemPromptFile, model, cwd = __dirname, ws, abortControllers, onText }) {
  return new Promise((resolve, reject) => {
    let killed = false;
    const key = `${agentName}-${Date.now()}-${Math.random()}`;

    // pi 没有 --system-prompt-file，读取文件内容通过 --append-system-prompt 传入
    let systemPromptContent = '';
    try {
      systemPromptContent = readFileSync(systemPromptFile, 'utf8');
    } catch {}

    const args = [
      '--print',
      '--mode', 'json',
      '--no-session',
      '--append-system-prompt', systemPromptContent,
    ];

    // model 可以是 "sonnet"/"haiku" 等简写，也可以是 "anthropic/claude-sonnet-4-5" 这类全名
    // pi 默认 provider 是 google，如果传入的是纯 claude 简写，自动补全 provider
    if (model) {
      const resolvedModel = resolveModel(model);
      args.push('--model', resolvedModel);
    }

    args.push(prompt);

    const proc = spawn(PI_BIN, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });

    abortControllers.set(key, () => {
      killed = true;
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
    });

    let buffer = '';
    proc.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleEvent(JSON.parse(line), agentName, ws, onText);
        } catch { /* 忽略非 JSON 行 */ }
      }
    });

    let stderrBuf = '';
    proc.stderr.on('data', d => { stderrBuf += d.toString(); });

    proc.on('close', code => {
      abortControllers.delete(key);
      if (killed) return resolve('');
      if (code !== 0 && code !== null) {
        reject(new Error(`[${agentName}] pi 退出码 ${code}: ${stderrBuf.slice(0, 200)}`));
      } else {
        resolve();
      }
    });
    proc.on('error', err => { abortControllers.delete(key); reject(err); });
  });
}

/**
 * 将简写模型名映射到 pi 支持的模型 ID
 *
 * 注意：pi 对 models.json 中自定义的 provider（如 deepseek、qwen）
 *       只识别纯模型 ID，不接受 "provider/model" 格式——
 *       带 "/" 的字符串会被 pi 当作 openrouter namespace 路由。
 *
 * 支持的简写：
 *   claude 系列: opus / sonnet / haiku  → anthropic/xxx（内置 provider，用 "/" 格式）
 *   deepseek 系列: deepseek / deepseek-v4-pro / deepseek-v4-flash / deepseek-chat
 *   qwen 系列: qwen / qwen-plus
 *   已含 "/" 且非自定义 provider 的全名直接透传
 */
function resolveModel(model) {
  // claude 系列简写：pi adapter 下无 Anthropic key，统一降级到 deepseek-chat
  if (model === 'opus' || model === 'sonnet' || model === 'haiku') return 'deepseek-chat';

  // deepseek 系列（自定义 provider，只传纯模型 ID）
  if (model === 'deepseek' || model === 'deepseek-v4-pro' || model === 'deepseek/deepseek-v4-pro') {
    return 'deepseek-v4-pro';
  }
  if (model === 'deepseek-v4-flash' || model === 'deepseek/deepseek-v4-flash') {
    return 'deepseek-v4-flash';
  }
  if (model === 'deepseek-chat' || model === 'deepseek/deepseek-chat') {
    return 'deepseek-chat';
  }

  // qwen 系列（自定义 provider，只传纯模型 ID）
  if (model === 'qwen' || model === 'qwen-plus' || model === 'qwen/qwen-plus') {
    return 'qwen-plus';
  }

  // 其他直接透传（由 pi 自行解析，含 "/" 的内置 provider 全名也适用）
  return model;
}

function handleEvent(event, agentName, ws, onText) {
  // agent 启动
  if (event.type === 'agent_start') {
    send(ws, { type: 'agent_ready', agent: agentName, model: 'pi' });
    return;
  }

  // 文本增量 & 工具调用
  if (event.type === 'message_update') {
    const ae = event.assistantMessageEvent;
    if (!ae) return;

    if (ae.type === 'text_delta') {
      onText?.(ae.delta);
      send(ws, { type: 'agent_text', agent: agentName, text: ae.delta });
    }

    if (ae.type === 'toolcall_end') {
      const tc = ae.toolCall;
      if (!tc) return;
      send(ws, { type: 'agent_tool_use', agent: agentName, tool: tc.name, input: tc.arguments });
      const toolText = summarizeToolInput(tc.name, tc.arguments);
      if (toolText) {
        const step = { workerId: agentName, step: 'tool', tool: tc.name, text: toolText };
        send(ws, { type: 'worker_step', ...step });
        const sid = typeof ws === 'string' ? ws : null;
        if (sid) recordWorkerStep(sid, step);
      }
    }
    return;
  }

  // 工具执行结果
  if (event.type === 'tool_execution_end') {
    const resultContent = event.result?.content;
    const content = Array.isArray(resultContent)
      ? resultContent.map(c => c.text || '').join('').slice(0, 500)
      : String(resultContent || '').slice(0, 500);
    send(ws, { type: 'agent_tool_result', agent: agentName, content });
    return;
  }

  // agent 完成
  if (event.type === 'agent_end') {
    // 计算总 cost（所有 assistant message 累加）
    const totalCost = (event.messages || [])
      .filter(m => m.role === 'assistant' && m.usage?.cost?.total)
      .reduce((sum, m) => sum + (m.usage.cost.total || 0), 0);
    const turns = (event.messages || []).filter(m => m.role === 'assistant').length;
    send(ws, { type: 'agent_done', agent: agentName, cost: totalCost || undefined, turns });
    return;
  }
}
