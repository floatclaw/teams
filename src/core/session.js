import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

export const sessionCache = new Map(); // sessionId -> session

let SESSIONS_DIR = '';

export function initSession(sessionsDir) {
  SESSIONS_DIR = sessionsDir;
}

export function saveSession(session) {
  writeFileSync(join(SESSIONS_DIR, `${session.id}.json`), JSON.stringify(session, null, 2));
}

export function recordWorkerStep(sessionId, step) {
  const s = sessionCache.get(sessionId);
  if (!s) return;
  if (!s.workerSteps) s.workerSteps = [];
  s.workerSteps.push({ ...step, ts: Date.now() });
  setImmediate(() => saveSession(s));
}

export function loadSession(sessionId) {
  const cached = sessionCache.get(sessionId);
  if (cached) return cached;
  try {
    const s = JSON.parse(readFileSync(join(SESSIONS_DIR, `${sessionId}.json`), 'utf8'));
    return s;
  } catch {
    return null;
  }
}

export function generateShareToken(sessionId) {
  const s = loadSession(sessionId);
  if (!s) return null;
  if (s.shareToken) return s.shareToken;
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  s.shareToken = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  setImmediate(() => saveSession(s));
  return s.shareToken;
}

export function findSessionByToken(token) {
  // 先搜缓存
  for (const s of sessionCache.values()) {
    if (s.shareToken === token) return s;
  }
  // 再扫文件
  if (!SESSIONS_DIR) return null;
  try {
    for (const file of readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const s = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf8'));
        if (s.shareToken === token) return s;
      } catch {}
    }
  } catch {}
  return null;
}
