#!/usr/bin/env node
// 轮询等待 teams session 完成并打印最终 result
// 用法: node wait-result.mjs <sessionId> [timeoutSeconds=600]

const [,, sid, timeoutArg] = process.argv;
if (!sid) { console.error('Usage: node wait-result.mjs <sessionId>'); process.exit(1); }

const BASE = 'http://localhost:3000';
const timeout = (parseInt(timeoutArg) || 600) * 1000;
const start = Date.now();

process.stderr.write(`Waiting for session ${sid}...\n`);

while (Date.now() - start < timeout) {
  const s = await fetch(`${BASE}/sessions/${sid}`).then(r => r.json()).catch(() => null);
  if (!s) { process.stderr.write('Server unreachable, retrying...\n'); }
  else {
    const msgs = s.messages || [];
    // 找最新一轮的 result
    const results = msgs.filter(m => m.role === 'result');
    if (results.length) {
      const last = results[results.length - 1];
      process.stdout.write(last.content || '');
      process.exit(0);
    }
    // 打印进度提示
    const tasks = s.taskSnapshot || [];
    const done = tasks.filter(t => t.status === 'done').length;
    const total = tasks.length;
    if (total) process.stderr.write(`  progress: ${done}/${total} tasks done\n`);
  }
  await new Promise(r => setTimeout(r, 5000));
}

process.stderr.write('Timeout waiting for result\n');
process.exit(1);
