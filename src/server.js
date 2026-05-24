import { createServer } from 'http';
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { handleSSE } from './ui/web/index.js';
import { sessionCache, initSession, loadSession } from './core/session.js';
import { activeQueues, releaseOrphanTasks } from './core/runner.js';
import { getPort } from './core/agent.js';
import { registerTaskRoute }     from './routes/task.js';
import { registerAbortRoute }    from './routes/abort.js';
import { registerPauseRoute }    from './routes/pause.js';
import { registerResumeRoute }   from './routes/resume.js';
import { registerSessionsRoute } from './routes/sessions.js';
import { registerConfigRoute }   from './routes/config.js';
import { registerApiRoutes }     from './routes/api.js';
import { registerShareRoute }    from './routes/share.js';
import { initLogger } from './core/logger.js';

// ─── 环境补全 ──────────────────────────────────────────────────────────────────
// 非交互式启动时环境变量是精简版，Keychain 不可用导致 claude CLI 报 Not logged in。
// 从用户 shell 补全环境变量，确保 claude 子进程能访问 Keychain。
try {
  const shellEnv = execSync(`${process.env.SHELL || '/bin/zsh'} -ilc 'env'`, { timeout: 5000 }).toString();
  let count = 0;
  for (const line of shellEnv.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.slice(0, idx);
      if (!process.env[key]) { process.env[key] = line.slice(idx + 1); count++; }
    }
  }
  console.log(`[env] shell 环境补全成功，新增 ${count} 个变量`);
} catch (e) { console.warn('[env] shell 环境补全失败:', e.message); }

// ─── 常量 ──────────────────────────────────────────────────────────────────────
const __dirname      = dirname(fileURLToPath(import.meta.url));
const PORT           = getPort();
const DATA_DIR       = join(process.env.HOME, '.teams');
const SESSIONS_DIR   = join(DATA_DIR, 'sessions');
const AGENT_CONFIG_FILE = join(__dirname, '..', 'config', 'agent.json');

mkdirSync(SESSIONS_DIR, { recursive: true });

// ─── 日志 ──────────────────────────────────────────────────────────────────────
initLogger(join(DATA_DIR, 'server.log'));

// ─── 初始化 ────────────────────────────────────────────────────────────────────
initSession(SESSIONS_DIR);
releaseOrphanTasks(DATA_DIR);

const activeRounds = new Map(); // roundId -> { abortControllers, sessionId }
const addLocks     = new Map(); // roundId -> Promise，保证 /api/add 串行执行

// ─── 极简 Router ───────────────────────────────────────────────────────────────
// 支持 get/post/delete/put，路径支持 :param 动态段
const routes = [];

function makeRouter() {
  const register = (method, pattern, handler) => {
    // 将 /sessions/:id 转换为正则，并提取参数名
    const paramNames = [];
    const regexStr = pattern
      .replace(/:([^/]+)/g, (_, name) => { paramNames.push(name); return '([^/]+)'; })
      .replace(/\//g, '\\/');
    routes.push({ method: method.toUpperCase(), regex: new RegExp(`^${regexStr}$`), paramNames, handler });
  };
  return {
    get:    (p, h) => register('GET', p, h),
    post:   (p, h) => register('POST', p, h),
    delete: (p, h) => register('DELETE', p, h),
    put:    (p, h) => register('PUT', p, h),
    // 通配段匹配（如 /api/:action），由各 route 文件自行判断 action
    match(method, urlPath) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = urlPath.match(r.regex);
        if (m) {
          const params = {};
          r.paramNames.forEach((n, i) => { params[n] = m[i + 1]; });
          return { handler: r.handler, params };
        }
      }
      return null;
    },
  };
}

const router = makeRouter();

// ─── 注册路由 ──────────────────────────────────────────────────────────────────
const ctx = { DATA_DIR, PORT, SESSIONS_DIR, AGENT_CONFIG_FILE, activeRounds, addLocks };
registerTaskRoute(router, ctx);
registerAbortRoute(router, ctx);
registerPauseRoute(router, ctx);
registerResumeRoute(router, ctx);
registerSessionsRoute(router, ctx);
registerConfigRoute(router, ctx);
registerApiRoutes(router, ctx);
registerShareRoute(router, ctx);

// ─── HTTP Server ───────────────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // 静态页面
  if (urlPath === '/' || urlPath === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(__dirname, 'ui', 'web', 'index.html')));
    return;
  }

  // 静态资源
  if (urlPath.startsWith('/static/')) {
    const filename = urlPath.slice('/static/'.length);
    const ext = filename.split('.').pop();
    const mime = { js: 'application/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml' }[ext] || 'application/octet-stream';
    try {
      const content = readFileSync(join(__dirname, 'ui', 'web', filename));
      res.writeHead(200, { 'Content-Type': mime });
      res.end(content);
    } catch {
      res.writeHead(404); res.end('Not Found');
    }
    return;
  }

  // SSE 订阅
  if (urlPath.startsWith('/stream/')) {
    const sessionId = urlPath.split('/stream/')[1];
    handleSSE(sessionId, req, res, activeRounds, sessionCache, loadSession, activeQueues);
    return;
  }

  // 路由派发
  const matched = router.match(req.method, urlPath);
  if (matched) {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => matched.handler(req, res, body, matched.params));
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

// ─── Agent 健康检查 ────────────────────────────────────────────────────────────
// 启动时检测 agent CLI 是否可用，发现问题提前报警，避免任务运行到一半才报错
(function checkAgentBin() {
  try {
    execSync(`which claude`, { stdio: 'ignore' });
    console.log(`[agent] ✓ claude 可用`);
  } catch {
    console.warn(`\n⚠️  [agent] 找不到 claude！\n`
      + `  agent CLI 不可用，任务执行将失败。\n`
      + `  确认已安装并在 PATH 中（npm install -g @anthropic-ai/claude-code）\n`
    );
  }
})();

// ─── 启动 ──────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n  teams  →  http://localhost:${PORT}\n`);
});
