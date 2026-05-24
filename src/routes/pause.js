import { join } from 'path';
import { emit } from '../transport/events.js';
import { sessionCache, saveSession, loadSession } from '../core/session.js';
import { activeQueues } from '../core/runner.js';
import { TaskQueue } from '../core/taskQueue.js';

/**
 * POST /pause
 * 暂停指定 session 下正在运行的 round：
 *  1. SIGKILL 所有 worker 进程
 *  2. 把 claimed 任务释放回 pending（恢复后可重新认领）
 *  3. 标记 dispatcherStatus = 'paused'
 */
export function registerPauseRoute(router, { activeRounds, DATA_DIR }) {
  router.post('/pause', (req, res, body) => {
    const { sessionId } = JSON.parse(body || '{}');

    // 1. 杀掉所有 worker 进程
    for (const [, round] of activeRounds) {
      if (round.sessionId === sessionId) {
        for (const ctrl of round.abortControllers.values()) ctrl();
        round.abortControllers.clear();
      }
    }

    // 2. 把 claimed 任务释放回 pending
    const session = sessionCache.get(sessionId) || loadSession(sessionId);
    if (session) {
      const roundId = session.currentRoundId || session.agentState?.roundId;
      if (roundId) {
        const roundDir = join(DATA_DIR, session.id, 'rounds', roundId);
        try {
          const tq = new TaskQueue(roundDir);
          tq.releaseAllClaimed();
        } catch { /* 任务目录不存在时忽略 */ }
      }

      // 3. 标记 paused
      if (session.agentState) {
        session.agentState.dispatcherStatus = 'paused';
        saveSession(session);
      }
    }

    emit(sessionId, { type: 'paused' });
    res.writeHead(200); res.end('{"ok":true}');
  });
}
