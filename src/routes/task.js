import { emit } from '../transport/events.js';
import { sessionCache, saveSession, loadSession } from '../core/session.js';
import { runRound } from '../core/runner.js';

/**
 * POST /task
 * 提交新任务，立即返回 sessionId，异步执行 runRound
 */
export function registerTaskRoute(router, { DATA_DIR, PORT, activeRounds, addLocks }) {
  router.post('/task', (req, res, body) => {
    (async () => {
      try {
        const { content, sessionId } = JSON.parse(body);

        let session = sessionCache.get(sessionId) || (sessionId && loadSession(sessionId));
        if (!session) {
          session = {
            id: Date.now().toString(),
            title: content.slice(0, 40),
            createdAt: new Date().toISOString(),
            messages: [], rounds: [],
          };
        }
        sessionCache.set(session.id, session);
        saveSession(session);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessionId: session.id, title: session.title }));

        emit(session.id, { type: 'session_start', sessionId: session.id, title: session.title });

        const abortControllers = new Map();
        const roundId = Date.now().toString();
        activeRounds.set(roundId, { abortControllers, sessionId: session.id });

        try {
          await runRound(content, session, session.id, abortControllers, roundId, DATA_DIR, PORT);
        } finally {
          activeRounds.delete(roundId);
          addLocks.delete(roundId);
        }
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
      }
    })();
  });
}
