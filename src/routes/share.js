import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateShareToken, findSessionByToken } from '../core/session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHARE_HTML = join(__dirname, '../ui/web/share.html');

export function registerShareRoute(router, { DATA_DIR }) {

  // POST /share/create — 为 session 生成分享 token
  router.post('/share/create', (req, res, body) => {
    try {
      const { sessionId } = JSON.parse(body);
      if (!sessionId) { res.writeHead(400); res.end(JSON.stringify({ error: 'sessionId required' })); return; }
      const token = generateShareToken(sessionId);
      if (!token) { res.writeHead(404); res.end(JSON.stringify({ error: 'session not found' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token, url: `/share/${token}` }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });

  // GET /share/:token — 返回分享页 HTML（数据内联）
  router.get('/share/:token', (req, res, _body, params) => {
    try {
      const session = findSessionByToken(params.token);
      if (!session) { res.writeHead(404); res.end('Not found'); return; }

      const data = buildShareData(session, DATA_DIR);
      const html = readFileSync(SHARE_HTML, 'utf8');
      // 将 </script> 替换为 </script>，使 HTML 解析器无法识别闭合标签，但 JSON.parse 能正确还原
      const _bs = String.fromCharCode(92);
      const safeJson = JSON.stringify(data).replace(/<\/script>/gi, _bs + 'u003c/script>');
      const injected = html.replace(
        '/*__SHARE_DATA__*/',
        `window.__SHARE_DATA__ = ${safeJson};`
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(injected);
    } catch (e) {
      res.writeHead(500); res.end(`Error: ${e.message}`);
    }
  });
}

function buildShareData(session, DATA_DIR) {
  const sessionId = session.id;

  // 找最后一个 roundId
  const lastRoundId = session.currentRoundId
    || (session.rounds?.length ? session.rounds[session.rounds.length - 1]?.roundId : null);

  const roundDir = lastRoundId ? join(DATA_DIR, sessionId, 'rounds', lastRoundId) : null;
  const workDir  = roundDir ? join(roundDir, 'work') : null;
  const taskDir  = roundDir ? join(roundDir, 'tasks') : null;

  // 读最终报告：优先 result.md，找不到时找 work 目录下最新的非子任务 md 文件
  const resultMd = safeRead(workDir && join(workDir, 'result.md'))
    || findFallbackResult(workDir);

  // 读目标
  const goalMd = safeRead(workDir && join(workDir, 'goal.md'));

  // 读任务列表
  let tasks = [];
  if (taskDir) {
    try { tasks = JSON.parse(readFileSync(join(taskDir, 'queue.json'), 'utf8')); } catch {}
  }

  // 读各子任务结果
  const taskResults = {};
  for (const t of tasks) {
    const content = safeRead(workDir && join(workDir, `${t.id}.result.md`));
    if (content) taskResults[t.id] = content;
  }

  // 读群体洞察
  const insightsMd = safeRead(join(DATA_DIR, sessionId, 'workspace', 'insights.md'));

  // 元信息
  const mode = session.dispatch?.mode || session.agentState?.roundId ? 'SWARM' : 'SOLO';
  const workerCount = Object.keys(session.agentState?.workers || {}).length;
  const title = goalMd
    ? goalMd.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '') || session.title
    : session.title || '任务结果';

  return {
    title,
    mode: session.dispatch?.mode || mode,
    createdAt: session.createdAt,
    workerCount,
    taskCount: tasks.length,
    resultMd: resultMd || '',
    goalMd: goalMd || '',
    insightsMd: insightsMd || '',
    tasks,
    taskResults,
  };
}

function safeRead(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try { return readFileSync(filePath, 'utf8'); } catch { return null; }
}

// 兜底：AI 可能没有按规范输出 result.md，找 work 目录下最新的非子任务 md 文件
function findFallbackResult(workDir) {
  if (!workDir || !existsSync(workDir)) return null;
  try {
    const EXCLUDE = /^(\d+\.result\.md|goal\.md|result\.md)$/;
    const files = readdirSync(workDir)
      .filter(f => f.endsWith('.md') && !EXCLUDE.test(f))
      .map(f => ({ f, mtime: statSync(join(workDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? readFileSync(join(workDir, files[0].f), 'utf8') : null;
  } catch { return null; }
}
