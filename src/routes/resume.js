import { join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { sessionCache, loadSession } from '../core/session.js';
import { activeQueues, resumeRound } from '../core/runner.js';
import { TaskQueue } from '../core/taskQueue.js';

/**
 * POST /resume
 * 续跑一个已有 round（进程重启后，或手动恢复中断的任务）
 */
export function registerResumeRoute(router, { DATA_DIR, PORT, activeRounds, addLocks }) {
  router.post('/resume', (req, res, body) => {
    (async () => {
      try {
        const { sessionId, supplement } = JSON.parse(body || '{}');
        const session = sessionCache.get(sessionId) || loadSession(sessionId);
        if (!session) { res.writeHead(404); res.end('{"error":"session not found"}'); return; }

        const roundId = session.currentRoundId || session.agentState?.roundId;
        if (!roundId) { res.writeHead(400); res.end('{"error":"no active round"}'); return; }

        if (activeRounds.has(roundId)) { res.writeHead(400); res.end('{"error":"already running"}'); return; }

        const roundDir = join(DATA_DIR, session.id, 'rounds', roundId);
        const tq = new TaskQueue(roundDir);
        const hasPending = tq.snapshot().some(t => t.status === 'pending' || t.status === 'claimed');
        if (!hasPending) { res.writeHead(400); res.end('{"error":"no pending tasks"}'); return; }

        // 如果用户提供了补充指令，追加到 goal.md
        if (supplement?.trim()) {
          const goalFile = join(roundDir, 'work', 'goal.md');
          const existing = existsSync(goalFile) ? readFileSync(goalFile, 'utf8') : '';
          const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
          writeFileSync(goalFile, existing + `\n\n## 用户补充指令（${date}）\n\n${supplement.trim()}\n`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, roundId }));

        const abortControllers = new Map();
        activeRounds.set(roundId, { abortControllers, sessionId });

        try {
          await resumeRound(session, sessionId, abortControllers, roundId, DATA_DIR, PORT, addLocks);
        } finally {
          activeRounds.delete(roundId);
          addLocks.delete(roundId);
        }
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    })();
  });
}
