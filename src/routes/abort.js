import { emit } from '../transport/events.js';
import { sessionCache, saveSession, loadSession } from '../core/session.js';

/**
 * POST /abort
 * 终止指定 session 下所有正在运行的 round
 */
export function registerAbortRoute(router, { activeRounds }) {
  router.post('/abort', (req, res, body) => {
    const { sessionId } = JSON.parse(body || '{}');
    for (const [, round] of activeRounds) {
      if (round.sessionId === sessionId) {
        for (const ctrl of round.abortControllers.values()) ctrl();
        round.abortControllers.clear();
      }
    }
    // 持久化 agentState：将 dispatcherStatus 标记为 aborted，避免历史加载时仍显示"运行中"
    const session = sessionCache.get(sessionId) || loadSession(sessionId);
    if (session?.agentState) {
      session.agentState.dispatcherStatus = 'aborted';
      saveSession(session);
    }
    emit(sessionId, { type: 'aborted' });
    res.writeHead(200); res.end('{"ok":true}');
  });
}
