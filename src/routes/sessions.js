import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { activeQueues } from '../core/runner.js';
import { TaskQueue } from '../core/taskQueue.js';

/**
 * GET  /sessions          列出最近 50 条会话
 * GET  /sessions/:id      获取单条会话详情（附带超时任务自动释放）
 * DELETE /sessions/:id    删除会话及其所有数据
 */
export function registerSessionsRoute(router, { DATA_DIR, SESSIONS_DIR }) {
  router.get('/sessions', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      const files = readdirSync(SESSIONS_DIR)
        .filter(f => f.endsWith('.json'))
        .sort().reverse().slice(0, 50)
        .map(f => {
          const s = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8'));
          return { id: s.id, title: s.title, createdAt: s.createdAt };
        });
      res.end(JSON.stringify(files));
    } catch { res.end('[]'); }
  });

  router.delete('/sessions/:id', (req, res, _body, params) => {
    const { id } = params;
    try {
      const f = join(SESSIONS_DIR, `${id}.json`);
      if (existsSync(f)) rmSync(f);
      const d = join(DATA_DIR, id);
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
      res.writeHead(200); res.end('{"ok":true}');
    } catch (e) { res.writeHead(500); res.end(`{"error":"${e.message}"}`); }
  });

  router.get('/sessions/:id', (req, res, _body, params) => {
    const { id } = params;
    const sessionFile = join(SESSIONS_DIR, `${id}.json`);
    if (!existsSync(sessionFile)) { res.writeHead(404); res.end('{}'); return; }

    const session = JSON.parse(readFileSync(sessionFile, 'utf8'));

    // 修复卡住的 claimed 任务：非活跃 round 里超时的 claimed 任务释放回 pending
    const roundsDir = join(DATA_DIR, id, 'rounds');
    if (existsSync(roundsDir) && !activeQueues.has(session.currentRoundId)) {
      let dirty = false;
      for (const roundId of readdirSync(roundsDir)) {
        if (activeQueues.has(roundId)) continue;
        const tq = new TaskQueue(join(roundsDir, roundId));
        const released = tq.releaseStale(30 * 60 * 1000); // 30 分钟视为超时
        if (released.length) {
          console.log(`[GET /sessions/${id}] round ${roundId}: 释放超时任务 → ${released.join(', ')}`);
          dirty = true;
        }
      }
      if (dirty && session.currentRoundId && existsSync(join(roundsDir, session.currentRoundId))) {
        const tq = new TaskQueue(join(roundsDir, session.currentRoundId));
        session.taskSnapshot = tq.snapshot();
        writeFileSync(sessionFile, JSON.stringify(session, null, 2));
      }
    }

    const msgs = session.messages || [];
    const hasUserMsg = msgs.some(m => m.role === 'user' && m.roundId === session.currentRoundId);
    const hasResult  = msgs.some(m => m.role === 'result' && m.roundId === session.currentRoundId);
    const isRunning  = hasUserMsg && !hasResult;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...session, isRunning }));
  });
}
