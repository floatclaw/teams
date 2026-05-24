// Web UI 交互层：通过 SSE 把事件推给浏览器
// 订阅事件总线，把事件序列化为 SSE 格式写入 HTTP 响应

import { subscribe } from '../../transport/events.js';

export function handleSSE(sessionId, req, res, activeRounds, sessionCache, loadSession, activeQueues) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(':ok\n\n');

  // 订阅事件总线，把事件推给浏览器
  const handler = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
  };
  const unsub = subscribe(sessionId, handler);

  // 连接建立时推送当前状态（执行中的 round）
  const session = sessionCache.get(sessionId) || loadSession(sessionId);
  if (session) {
    handler({ type: 'session_start', sessionId, title: session.title });
  }
  for (const [roundId, round] of activeRounds) {
    if (round.sessionId === sessionId) {
      // 优先从 messages 找当前 round 的 dispatch 消息，兼容旧数据回退到 session.dispatch
      const dispatchMsg = session?.messages?.findLast?.(m => m.role === 'dispatch' && m.roundId === roundId)
        || (session?.dispatch?.roundId === roundId ? session.dispatch : null);
      if (dispatchMsg) {
        handler({
          type: 'dispatch_ready',
          mode: dispatchMsg.mode,
          reason: dispatchMsg.reason,
          tasks: dispatchMsg.tasks,
          roundId,
        });
      }
      const aq = activeQueues.get(roundId);
      if (aq?.tq) handler({ type: 'queue_update', tasks: aq.tq.snapshot() });
    }
  }

  const heartbeat = setInterval(() => {
    try { res.write(':ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
  });
}
