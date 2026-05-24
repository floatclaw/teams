/**
 * summarizeToolInput — 将工具调用转为人类可读的一行摘要
 *
 * 各 agent adapter（claude.js / pi.js 等）传入工具名和输入参数，返回摘要字符串。
 * claude 用大写工具名（Write/Edit/Read/Bash），pi 用小写（write/edit/read/bash/grep/find）。
 * 统一转小写后匹配，避免两端维护两份逻辑。
 *
 * 返回 null 表示该调用不值得在 UI 上展示（内部实现细节）。
 */
import { getPort } from './agent.js';

export function summarizeToolInput(tool, input) {
  if (!input) return null;
  const t = tool.toLowerCase();

  switch (t) {
    case 'websearch': return `搜索: ${input.query || ''}`.slice(0, 80);
    case 'webfetch':  return `读取: ${input.url || ''}`.slice(0, 80);

    case 'write':
      return `写入: ${String(input.file_path || input.path || '').split('/').pop()}`;
    case 'edit':
    case 'multiedit':
      return `编辑: ${String(input.file_path || input.path || '').split('/').pop()}`;
    case 'read':
      return `读取: ${String(input.file_path || input.path || '').split('/').pop()}`;

    case 'bash': {
      const cmd = (input.command || '').slice(0, 80);
      if (cmd.includes(`localhost:${getPort()}/api`)) return null;
      if (cmd.startsWith('node -e')) return null;
      return `执行: ${cmd}`;
    }

    case 'grep': return `搜索: ${(input.pattern || '').slice(0, 60)}`;
    case 'find': return `查找: ${(input.pattern || input.name || '').slice(0, 60)}`;

    default: return null;
  }
}
