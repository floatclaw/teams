/**
 * 结构化日志模块
 *
 * 用法：
 *   在 server.js 启动时调用 initLogger(logFilePath) 设置输出文件，
 *   其他模块直接 import { slog } from './logger.js' 使用。
 *
 * slog(level, ctx, msg)
 *   level : 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'
 *   ctx   : 上下文标签，如 'session=xxx round=yyy worker=zzz'（可空）
 *   msg   : 日志正文
 *
 * 日志格式：
 *   2026-05-04T12:00:00.000Z [INFO][session=xxx round=yyy] [dedup] 开始去重 ...
 */

import { appendFileSync } from 'fs';

let LOG_FILE = '';

export function initLogger(logFilePath) {
  LOG_FILE = logFilePath;
}

export function slog(level, ctx, msg) {
  const prefix = ctx ? `[${ctx}]` : '';
  const line = `${new Date().toISOString()} [${level}]${prefix} ${msg}\n`;
  // 总是打 console（方便开发调试），有文件时同时写文件
  if (level === 'ERROR' || level === 'WARN') {
    console.warn(line.trimEnd());
  }
  if (LOG_FILE) {
    try { appendFileSync(LOG_FILE, line); } catch (_) {}
  }
}
