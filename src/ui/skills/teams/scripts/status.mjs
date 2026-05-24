#!/usr/bin/env node
// 查看 teams session 状态（任务队列 + 消息摘要）
// 用法: node status.mjs [sessionId] [--full]
//   不传 sessionId 时列出所有 sessions
//   --full 输出每条消息的完整内容

const args = process.argv.slice(2);
const full = args.includes('--full');
const sid = args.find(a => !a.startsWith('--'));
const BASE = 'http://localhost:3000';

if (!sid) {
  const list = await fetch(`${BASE}/sessions`).then(r => r.json()).catch(() => []);
  if (!list.length) { console.log('No sessions found'); process.exit(0); }
  console.log('Sessions:');
  list.forEach(s => console.log(`  ${s.id}  ${s.title || '(untitled)'}`));
  process.exit(0);
}

const s = await fetch(`${BASE}/sessions/${sid}`).then(r => r.json()).catch(() => null);
if (!s || !s.id) { console.error(`Session ${sid} not found`); process.exit(1); }

console.log(`Session: ${s.id}  "${s.title || ''}"`);

const tasks = s.taskSnapshot || [];
if (tasks.length) {
  console.log(`\nTask queue (${tasks.length}):`);
  tasks.forEach(t => {
    const flag = t.status === 'done' ? '✓' : t.status === 'claimed' ? '⏳' : '○';
    console.log(`  ${flag} #${t.id} [${t.status}] ${(t.description || '').slice(0, 70)}`);
  });
}

const msgs = s.messages || [];
if (msgs.length) {
  console.log(`\nMessages (${msgs.length}):`);
  msgs.forEach((m, i) => {
    if (full) {
      console.log(`\n--- [${i}] role=${m.role} roundId=${m.roundId} ---`);
      if (m.content)      console.log(m.content);
      else if (m.role === 'dispatch') console.log(`mode=${m.mode} tasks=${m.tasks?.length||0}\nreason: ${m.reason||''}`);
      else if (m.role === 'emerge')   console.log(`workerId=${m.workerId}\nreason: ${m.reason||''}\ndescription: ${m.description||''}`);
    } else {
      if (m.role === 'user')     console.log(`  [user]     ${(m.content||'').slice(0,70)}`);
      if (m.role === 'dispatch') console.log(`  [dispatch] mode=${m.mode} tasks=${m.tasks?.length||0}`);
      if (m.role === 'emerge')   console.log(`  [emerge]   ${m.workerId} → ${(m.description||'').slice(0,50)}`);
      if (m.role === 'result')   console.log(`  [result]   ${(m.content||'').slice(0,80)}...`);
    }
  });
}
