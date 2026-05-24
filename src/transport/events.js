// 事件总线：执行引擎通过 emit 发布事件，各交互层通过 subscribe 订阅
// 执行引擎不感知交互方式，交互层按需注册

const subscribers = new Map(); // sessionId -> Set<handler>

export function subscribe(sessionId, handler) {
  if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
  subscribers.get(sessionId).add(handler);
  return () => unsubscribe(sessionId, handler); // 返回取消订阅函数
}

export function unsubscribe(sessionId, handler) {
  subscribers.get(sessionId)?.delete(handler);
}

export function emit(sessionId, event) {
  const handlers = subscribers.get(sessionId);
  if (!handlers?.size) return;
  for (const handler of handlers) {
    try { handler(event); } catch {}
  }
}

// send 是 emit 的别名，兼容执行引擎的调用方式
export function send(target, data) {
  if (typeof target === 'string') {
    emit(target, data);
  } else if (target?._sessionId) {
    emit(target._sessionId, data);
  }
}
