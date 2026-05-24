import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { TaskQueue } from './taskQueue.js';
import { runDispatcher } from './dispatcher.js';
import { runWorker } from './worker.js';
import { getMaxWorkers, getSwarmRoles, getTaskTimeoutMs } from './agent.js';
import { saveSession } from './session.js';
import { send } from '../transport/events.js';
import { slog } from './logger.js';

export const activeQueues = new Map(); // roundId → { tq, workspace, sessionId, session, mode }

/**
 * 服务启动时扫描所有 session，把孤儿 round（进程重启后遗留的 claimed 任务）释放回 pending
 * 这样下次有 worker 认领时可以继续执行，不会永久卡住
 */
export function releaseOrphanTasks(dataDir) {
  const sessionsDir = join(dataDir, 'sessions');
  if (!existsSync(sessionsDir)) return;
  let totalReleased = 0;
  for (const file of readdirSync(sessionsDir).filter(f => f.endsWith('.json'))) {
    try {
      const session = JSON.parse(readFileSync(join(sessionsDir, file), 'utf8'));
      const roundsDir = join(dataDir, session.id, 'rounds');
      if (!existsSync(roundsDir)) continue;
      for (const roundId of readdirSync(roundsDir)) {
        const roundDir = join(roundsDir, roundId);
        const tq = new TaskQueue(roundDir);
        const released = tq.releaseStale(0); // timeout=0：立即释放所有 claimed（服务刚重启，没有任何活跃进程）
        if (released.length) {
          console.log(`[startup] session ${session.id} round ${roundId}: 释放孤儿任务 → ${released.join(', ')}`);
          totalReleased += released.length;
        }
      }
    } catch { /* 单个文件解析失败不影响其他 */ }
  }
  if (totalReleased) console.log(`[startup] 共释放 ${totalReleased} 个孤儿任务`);
}

// ─── 共享执行内核 ─────────────────────────────────────────────────────────────

/**
 * 启动 Worker 并等待全部完成，包含：
 *  - 轮询任务状态 + 超时释放
 *  - Promise.all 并发执行 workers
 *  - 错误处理 / abort 处理
 *  - 最终结果归集、context 追加、session_done 事件
 *
 * @param {object} opts
 * @param {TaskQueue} opts.tq
 * @param {object}   opts.session
 * @param {string}   opts.sessionId
 * @param {Map}      opts.abortControllers
 * @param {string}   opts.roundId
 * @param {string}   opts.mode
 * @param {string}   opts.workspace
 * @param {string}   opts.roundWorkDir
 * @param {number}   opts.port
 * @param {string}   opts.dataDir
 * @param {object[]} opts.teamMembers        - [{ workerId, role }]
 * @param {string}   opts.logTag             - 日志前缀，如 '[runner]' 或 '[resume]'
 * @param {string}   opts.contextLabel       - 写入 context.md 时的用户需求标签
 * @param {Function} [opts.onDone]           - 结果归集完成后的额外回调 (finalTasks, finalResult) => void
 */
async function executeWorkers({
  tq, session, sessionId, abortControllers,
  roundId, mode, workspace, roundWorkDir, port, dataDir,
  teamMembers, logTag, contextLabel, onDone,
}) {
  const getWs = () => sessionId;
  const lctx = `session=${sessionId} round=${roundId} mode=${mode}`;

  slog('INFO', lctx, `${logTag} 启动 ${teamMembers.length} 个 Worker`);

  const TASK_TIMEOUT_MS = getTaskTimeoutMs();
  let prevSnapshot = tq.snapshot().map(t => ({ id: t.id, status: t.status, claimedBy: t.claimedBy }));

  const pollInterval = setInterval(() => {
    const w = getWs();
    const released = tq.releaseStale(TASK_TIMEOUT_MS);
    if (released.length) {
      slog('WARN', lctx, `超时任务已释放 → ${released.join(', ')}`);
      send(w, { type: 'tasks_released', taskIds: released });
    }
    const snap = tq.snapshot();
    for (const task of snap) {
      const prev = prevSnapshot.find(p => p.id === task.id);
      if (!prev) {
        send(w, { type: 'task_added', task });
      } else if (prev.status !== task.status) {
        if (task.status === 'claimed') send(w, { type: 'task_claimed', taskId: task.id, workerId: task.claimedBy, description: task.description });
        if (task.status === 'done')    send(w, { type: 'task_done',    taskId: task.id, workerId: task.claimedBy });
      }
    }
    send(w, { type: 'queue_update', tasks: snap });
    prevSnapshot = snap.map(t => ({ id: t.id, status: t.status, claimedBy: t.claimedBy }));
  }, 200);

  try {
    await Promise.all(
      teamMembers.map(({ workerId, role }) =>
        runWorker(workerId, role, tq, session, getWs, abortControllers, workspace, mode, roundWorkDir, port, dataDir)
      )
    );
  } catch (e) {
    if (e.isAbort) {
      slog('INFO', lctx, `${logTag} abort 打断，静默退出`);
      saveSession(session); return;
    }
    slog('ERROR', lctx, `${logTag} Worker 异常: ${e.message}`);
    send(getWs(), { type: 'error', message: e.message });
    saveSession(session);
    return;
  } finally {
    clearInterval(pollInterval);
    activeQueues.delete(roundId);
  }

  const finalTasks = tq.snapshot();
  send(getWs(), { type: 'queue_update', tasks: finalTasks });

  const finalResult = resolveFinalResult(finalTasks, roundWorkDir, mode);
  slog('INFO', lctx, `${logTag} 全部完成，结果长度 ${finalResult.length} 字`);

  session.messages.push({ role: 'result', content: finalResult, ts: Date.now(), roundId, tasks: finalTasks, mode });
  saveSession(session);
  activeQueues.delete(roundId); // finally 里已删过，二次删除无害（Map.delete 幂等）

  appendContextSummary(workspace, contextLabel, finalResult, roundId, roundWorkDir);
  send(getWs(), { type: 'session_done', result: finalResult, sessionId: session.id, roundId });

  onDone?.(finalTasks, finalResult);
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 续跑一个已有的 round：不重新 dispatch，直接用已有任务池启动 workers
 * 用于进程崩溃/重启后恢复执行中断的任务
 */
export async function resumeRound(session, sessionId, abortControllers, roundId, dataDir, port, addLocks) {
  session.currentRoundId = roundId;
  slog('INFO', `session=${sessionId} round=${roundId}`, '[resume] 开始续跑');
  const roundDir = join(dataDir, session.id, 'rounds', roundId);
  const tq = new TaskQueue(roundDir);

  const workspace    = join(dataDir, session.id, 'workspace');
  const roundWorkDir = join(roundDir, 'work');

  // 找出本 round 的 dispatch 信息（模式、任务数）
  const dispatchMsg = session.messages?.findLast?.(m => m.role === 'dispatch' && m.roundId === roundId)
    || (session.dispatch?.roundId === roundId ? session.dispatch : null)
    || session.dispatch;
  const mode = dispatchMsg?.mode || 'SWARM';

  // 恢复 agentState：优先用已保存的 worker 数量，没有则按 mode 推算
  const existingWorkerCount = session.agentState?.workers
    ? Object.keys(session.agentState.workers).length
    : 0;
  const workerCount = existingWorkerCount > 0
    ? existingWorkerCount
    : (mode === 'SWARM'
        ? getSwarmRoles().length
        : Math.min(getMaxWorkers(), dispatchMsg?.tasks?.length || getSwarmRoles().length));

  if (!session.agentState) session.agentState = { dispatcherStatus: 'done', workers: {}, roundId };
  session.agentState.workers = Object.fromEntries(
    Array.from({ length: workerCount }, (_, i) => [`worker-${i + 1}`, { status: 'idle', task: '待命' }])
  );
  session.agentState.dispatcherStatus = 'done';
  saveSession(session);

  activeQueues.set(roundId, { tq, workspace, sessionId, session, mode, addLocks });

  const snapshot = tq.snapshot();
  send(sessionId, { type: 'dispatch_ready', mode, reason: dispatchMsg?.reason || '', tasks: snapshot, roundId });

  const teamMembers = Array.from({ length: workerCount }, (_, i) => ({
    workerId: `worker-${i + 1}`, role: 'worker',
  }));
  send(sessionId, { type: 'team_ready', members: teamMembers, tasks: snapshot });
  send(sessionId, { type: 'queue_update', tasks: snapshot });

  await executeWorkers({
    tq, session, sessionId, abortControllers,
    roundId, mode, workspace, roundWorkDir, port, dataDir,
    teamMembers,
    logTag: '[resume]',
    contextLabel: `[续跑 ${roundId}]`,
    onDone: () => {
      if (!session.title) session.title = `续跑 ${roundId.slice(-6)}`;
      saveSession(session);
    },
  });
}

export async function runRound(userMessage, session, sessionId, abortControllers, roundId, dataDir, port) {
  slog('INFO', `session=${sessionId} round=${roundId}`, `[runner] 新一轮开始: ${userMessage.slice(0, 80)}`);
  session.currentRoundId = roundId;

  const roundDir = join(dataDir, session.id, 'rounds', roundId);
  const tq = new TaskQueue(roundDir);

  const workspace    = join(dataDir, session.id, 'workspace');
  const roundWorkDir = join(roundDir, 'work');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(roundWorkDir, { recursive: true });

  session.messages.push({ role: 'user', content: userMessage, ts: Date.now(), roundId });

  activeQueues.set(roundId, { tq, workspace, sessionId, session, mode: 'PARALLEL' });

  session.agentState = { dispatcherStatus: 'running', workers: {}, roundId };
  saveSession(session);
  send(sessionId, { type: 'dispatcher_start' });

  let dispatch;
  try {
    dispatch = await runDispatcher(userMessage, session, () => sessionId, abortControllers, dataDir);
  } catch (e) {
    // abort 打断时静默退出，/abort 接口已发送 aborted 事件，不再重复报错
    if (e.isAbort) return;
    send(sessionId, { type: 'error', message: `Dispatcher 失败: ${e.message}` });
    return;
  }

  slog('INFO', `session=${sessionId} round=${roundId}`, `[runner] dispatch 完成: mode=${dispatch.mode} tasks=${dispatch.tasks?.length ?? 0}`);

  if (dispatch.mode === 'NOOP') {
    session.agentState.dispatcherStatus = 'done';
    session.dispatch = { mode: 'NOOP', reason: dispatch.reason, tasks: [], roundId };
    session.messages.push({ role: 'dispatch', mode: 'NOOP', reason: dispatch.reason, tasks: [], roundId, ts: Date.now() });
    const reply = dispatch.reason || '你好！有什么我可以帮你的吗？';
    session.messages.push({ role: 'result', content: reply, ts: Date.now(), roundId, tasks: [], mode: 'NOOP' });
    saveSession(session);
    send(sessionId, { type: 'dispatch_ready', mode: 'NOOP', reason: dispatch.reason, tasks: [] });
    send(sessionId, { type: 'session_done', result: reply, sessionId: session.id, roundId });
    activeQueues.delete(roundId);
    return;
  }

  // SWARM 模式：tasks 为空，把原始需求写入 goal.md，worker 自主探索
  if (dispatch.mode === 'SWARM') {
    writeFileSync(join(roundWorkDir, 'goal.md'), `# 任务目标\n\n${userMessage}\n`);
    // workspace/insights.md 是跨轮次共享的群体洞察文件，Worker 直接读写
    // 首轮时预创建，避免 Worker 第一次读取时报错
    const wsInsights = join(workspace, 'insights.md');
    if (!existsSync(wsInsights)) {
      writeFileSync(wsInsights, '# 群体洞察\n\n（尚无洞察，执行完任务后请追加）\n');
    }
  }

  const initTasks = dispatch.tasks.map(t => ({
    id: t.id, description: t.description, status: 'pending',
    blockedBy: t.blockedBy || [], meta: t.meta || {},
    claimedBy: null, claimedAt: null, result: null, doneAt: null,
  }));
  tq.init(initTasks);

  session.dispatch = { mode: dispatch.mode, reason: dispatch.reason, tasks: initTasks, roundId };
  session.messages.push({ role: 'dispatch', mode: dispatch.mode, reason: dispatch.reason, tasks: initTasks, roundId, ts: Date.now() });

  // SWARM：并发数 = 角色数；其他模式：min(maxWorkers, tasks 数)
  const workerCount = dispatch.mode === 'SWARM'
    ? getSwarmRoles().length
    : Math.min(getMaxWorkers(), initTasks.length);

  session.agentState.dispatcherStatus = 'done';
  session.agentState.workers = Object.fromEntries(
    Array.from({ length: workerCount }, (_, i) => [`worker-${i + 1}`, { status: 'idle', task: '待命' }])
  );
  saveSession(session);

  const aq = activeQueues.get(roundId);
  if (aq) aq.mode = dispatch.mode;

  send(sessionId, { type: 'dispatch_ready', mode: dispatch.mode, reason: dispatch.reason, tasks: initTasks, roundId });

  const teamMembers = Array.from({ length: workerCount }, (_, i) => ({
    workerId: `worker-${i + 1}`, role: 'worker',
  }));
  send(sessionId, { type: 'team_ready', members: teamMembers, tasks: initTasks });

  await executeWorkers({
    tq, session, sessionId, abortControllers,
    roundId, mode: dispatch.mode, workspace, roundWorkDir, port, dataDir,
    teamMembers,
    logTag: '[runner]',
    contextLabel: userMessage,
    onDone: (finalTasks, finalResult) => {
      if (!session.title || session.messages.filter(m => m.role === 'user').length === 1) {
        session.title = userMessage.slice(0, 40);
      }
      saveSession(session);
    },
  });
}

// ─── 结果归集 ─────────────────────────────────────────────────────────────────

function resolveFinalResult(finalTasks, roundWorkDir, mode) {
  // 1. 优先：固定约定的整合产出文件
  const fixedResult = join(roundWorkDir, 'result.md');
  if (existsSync(fixedResult)) {
    try { return readFileSync(fixedResult, 'utf8'); } catch {}
  }

  // 2. 按任务 id 的子任务结果文件（{taskId}.result.md）
  function readTaskResult(task) {
    if (!task) return '';
    const f = join(roundWorkDir, `${task.id}.result.md`);
    if (existsSync(f)) {
      try { return readFileSync(f, 'utf8'); } catch {}
    }
    return task.result || '';
  }

  // SOLO：唯一任务的结果
  if (mode === 'SOLO') {
    return readTaskResult(finalTasks[finalTasks.length - 1]);
  }

  // PIPELINE / HYBRID：从末尾往前找第一个有内容的任务结果（整合任务在最末）
  if (mode === 'PIPELINE' || mode === 'HYBRID') {
    for (let i = finalTasks.length - 1; i >= 0; i--) {
      const r = readTaskResult(finalTasks[i]);
      if (r) return r;
    }
    return '';
  }

  // PARALLEL / SWARM：拼接所有子任务结果兜底（整合 Worker 未产出 result.md 时）
  const allResults = finalTasks
    .map(t => readTaskResult(t))
    .filter(Boolean);
  if (allResults.length) return allResults.join('\n\n---\n\n');

  // 3. 最后兜底：按修改时间找最新非约定文件（保留兼容，但不再是主路径）
  try {
    const files = readdirSync(roundWorkDir)
      .filter(f => f.endsWith('.md') && f !== 'goal.md' && f !== 'result.md' && !f.match(/^\d+\.result\.md$/))
      .map(f => ({ name: f, mtime: statSync(join(roundWorkDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length) return readFileSync(join(roundWorkDir, files[0].name), 'utf8');
  } catch {}

  return '';
}

function appendContextSummary(workspace, userMessage, finalResult, roundId, roundWorkDir) {
  try {
    const contextFile = join(workspace, 'context.md');
    const date = new Date().toISOString().slice(0, 16).replace('T', ' ');

    // 收集本轮产出文件路径（排除 goal.md 和 *.result.md 子任务文件，只收录最终产出）
    let fileIndex = '';
    if (roundWorkDir) {
      try {
        const files = readdirSync(roundWorkDir)
          .filter(f => f.endsWith('.md') && f !== 'goal.md' && !f.match(/^\d+\.result\.md$/))
          .map(f => join(roundWorkDir, f));
        if (files.length) {
          fileIndex = `\n**产出文件：**\n${files.map(f => `- ${f}`).join('\n')}\n`;
        }
      } catch {}
    }

    const summary = `\n\n---\n\n## ${date}（${roundId.slice(-6)}）\n\n**用户需求：** ${userMessage.slice(0, 100)}${userMessage.length > 100 ? '...' : ''}\n\n**结果摘要：** ${finalResult.slice(0, 300)}${finalResult.length > 300 ? '...' : ''}\n${fileIndex}`;
    const existing = existsSync(contextFile) ? readFileSync(contextFile, 'utf8') : '# 本项目历史上下文\n\n每轮任务完成后自动追加，供后续轮次参考。';
    writeFileSync(contextFile, existing + summary);
  } catch {}
}


