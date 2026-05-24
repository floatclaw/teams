/**
 * Hermes agent CLI adapter
 *
 * 对接 `hermes chat -q <prompt> -Q --source tool`
 * Hermes 输出格式（-Q quiet 模式）：
 *   第一行: session_id: <id>
 *   之后:   纯文本响应（非流式，完整输出）
 *
 * 参数映射：
 *   systemPromptFile → 读取文件内容，与 prompt 合并后通过 -q 传入
 *   model            → -m <model>（如 deepseek-v4-flash，hermes 自行匹配 provider）
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { send } from '../../transport/events.js';

const HERMES_BIN = 'hermes';

/**
 * @param {object} opts - 见 agent.js runAgent 说明
 */
export function run({ agentName, prompt, systemPromptFile, model, cwd = __dirname, ws, abortControllers, onText }) {
  return new Promise((resolve, reject) => {
    let killed = false;
    const key = `${agentName}-${Date.now()}-${Math.random()}`;

    // hermes 没有 --system-prompt-file，把 system prompt 内嵌到 query 头部
    let systemPromptContent = '';
    try { systemPromptContent = readFileSync(systemPromptFile, 'utf8').trim(); } catch {}

    const fullQuery = systemPromptContent
      ? `[SYSTEM INSTRUCTIONS]\n${systemPromptContent}\n\n[USER TASK]\n${prompt}`
      : prompt;

    const args = [
      'chat',
      '-q', fullQuery,
      '-Q',              // quiet：只输出最终响应 + session_id
      '--source', 'tool', // 不出现在用户 session 列表
      '--yolo',           // 跳过危险命令确认
    ];

    if (model) args.push('-m', model);

    const proc = spawn(HERMES_BIN, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    abortControllers.set(key, () => {
      killed = true;
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
    });

    send(ws, { type: 'agent_ready', agent: agentName, model: model || 'hermes' });

    let output = '';
    proc.stdout.on('data', chunk => { output += chunk.toString(); });

    let stderrBuf = '';
    proc.stderr.on('data', d => { stderrBuf += d.toString(); });

    proc.on('close', code => {
      abortControllers.delete(key);
      if (killed) return resolve('');
      if (code !== 0 && code !== null) {
        reject(new Error(`[${agentName}] hermes 退出码 ${code}: ${stderrBuf.slice(0, 200)}`));
        return;
      }

      // 解析输出：跳过 "session_id: ..." 首行，其余为响应文本
      const lines = output.split('\n');
      const textLines = lines.filter(l => !l.startsWith('session_id:'));
      const text = textLines.join('\n').trim();

      // 把完整文本作为一次性输出发送（hermes 非流式）
      if (text) {
        onText?.(text);
        send(ws, { type: 'agent_text', agent: agentName, text });
      }
      send(ws, { type: 'agent_done', agent: agentName });
      resolve();
    });
    proc.on('error', err => { abortControllers.delete(key); reject(err); });
  });
}
