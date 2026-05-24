import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { runAgent } from './agent.js';
import { slog } from './logger.js';

const AGENTS_DIR = join(new URL('.', import.meta.url).pathname, '../..', 'agents');

export async function runDispatcher(userMessage, session, getWs, abortControllers, dataDir) {
  const ws = typeof getWs === 'function' ? getWs() : getWs;
  const lctx = `session=${session.id}`;
  slog('INFO', lctx, `[dispatcher] 开始: ${userMessage.slice(0, 80)}`);

  // 最近 3 轮结果摘要（每轮最多 500 字，避免长报告撑爆 dispatcher 输出）
  const historyContext = getSessionHistoryContext(session, 3);

  // context.md：全量历史摘要（每轮 300 字），超过 3 轮时是唯一的历史线索
  let contextFileSummary = '';
  if (dataDir) {
    try {
      const contextFile = join(dataDir, session.id, 'workspace', 'context.md');
      if (existsSync(contextFile)) {
        const raw = readFileSync(contextFile, 'utf8');
        // 只取后 3000 字，避免过长
        contextFileSummary = raw.length > 3000 ? '...(更早历史已截断)\n' + raw.slice(-3000) : raw;
      }
    } catch {}
  }

  const contextSection = (historyContext || contextFileSummary)
    ? `\n\n## 本项目历史对话（按时间顺序）\n\n${historyContext || contextFileSummary}\n\n---\n\n以上是历史上下文。用户当前新输入：`
    : '';

  const prompt = `${contextSection}${userMessage}\n\n请直接输出 JSON，不要有任何其他文字。`;

  let fullText = '';
  await runAgent({
    agentName: 'dispatcher',
    prompt,
    systemPromptFile: join(AGENTS_DIR, 'dispatcher.md'),
    ws, abortControllers,
    onText: t => { fullText += t; },
  });

  // fullText 为空说明被 abort 打断，抛专用错误让 runner 静默退出
  if (!fullText.trim()) {
    slog('INFO', lctx, '[dispatcher] abort 打断');
    throw Object.assign(new Error('aborted'), { isAbort: true });
  }

  const codeBlock = fullText.match(/```(?:json)?\s*([\s\S]*?)```/s);
  const jsonStr = codeBlock ? codeBlock[1].trim() : fullText.trim();
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/) || fullText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Dispatcher 输出无效: ${fullText.slice(0, 200)}`);

  // 先直接解析；失败则逐步尝试修复
  try {
    const result = JSON.parse(jsonMatch[0]);
    slog('INFO', lctx, `[dispatcher] 解析成功: mode=${result.mode} tasks=${result.tasks?.length ?? 0}`);
    return result;
  } catch {
    // 修复1：字符串值内的裸换行/制表符转义（s flag 支持跨行匹配）
    const fixed1 = jsonMatch[0].replace(/"((?:[^"\\]|\\.)*)"/gs, (_, s) =>
      '"' + s.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"'
    );
    try {
      return JSON.parse(fixed1);
    } catch {
      // 修复2：状态机逐字符扫描，转义裸控制字符 + 中文全角引号
      try {
        const fixed = JSON.parse(fixBareNewlines(jsonMatch[0]));
        slog('INFO', lctx, `[dispatcher] 修复解析成功: mode=${fixed.mode}`);
        return fixed;
      } catch (e3) {
        slog('ERROR', lctx, `[dispatcher] JSON 解析失败: ${e3.message}`);
        throw new Error(`Dispatcher JSON 解析失败: ${e3.message}\n原始输出: ${fullText.slice(0, 300)}`);
      }
    }
  }
}

// 状态机：逐字符扫描 JSON，只转义字符串值内的裸控制字符
function fixBareNewlines(text) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\' && inString) { result += ch; escaped = true; continue; }
    if (ch === '"') {
      if (!inString) {
        // 开始一个字符串
        inString = true;
        result += ch;
        continue;
      }
      // 在字符串内：判断这个 " 是结束引号还是裸双引号
      // 用一个轻量启发：看后面紧跟的非空白字符是否是合法的 JSON 结构符
      let j = i + 1;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n' || text[j] === '\r')) j++;
      const nextNonWs = text[j] || '';
      if (nextNonWs === ',' || nextNonWs === '}' || nextNonWs === ']' || nextNonWs === ':') {
        // 合法的字符串结束
        inString = false;
        result += ch;
      } else {
        // 裸双引号，转义
        result += '\\"';
      }
      continue;
    }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
    }
    result += ch;
  }
  return result;
}

function getSessionHistoryContext(session, limit = 3) {
  try {
    const messages = session.messages || [];
    const pairs = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;
      const roundId = msg.roundId;
      // 向后找同一 roundId 的 result（中间可能有 dispatch/emerge 等消息）
      let result = null;
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].role === 'result' && messages[j].roundId === roundId) {
          result = messages[j];
          break;
        }
        // 遇到下一个 user 消息说明这一轮没有 result，停止
        if (messages[j].role === 'user') break;
      }
      if (result && result.content) {
        pairs.push({ user: msg.content, result: result.content });
      }
    }
    const recent = pairs.slice(-limit);
    if (!recent.length) return '';
    return recent.map((p, i) =>
      `### 第 ${i + 1} 轮\n用户：${p.user}\n\n结果摘要（仅供理解意图，勿内联正文）：${p.result.slice(0, 300)}${p.result.length > 300 ? '\n\n...（内容已截断，完整内容在工作目录文件中）' : ''}`
    ).join('\n\n---\n\n');
  } catch {
    return '';
  }
}
