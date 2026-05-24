import { emit } from '../transport/events.js';
import { slog } from '../core/logger.js';
import { recordWorkerStep, saveSession } from '../core/session.js';
import { activeQueues } from '../core/runner.js';
import { checkDuplicate } from '../core/dedup.js';
import { SUMMARY_RE } from '../core/taskQueue.js';

/**
 * POST /api/claim   — Worker 认领下一个任务
 * POST /api/done    — Worker 完成任务
 * POST /api/add     — Worker 追加涌现任务（含 LLM 去重 + blockedBy 自动补全）
 * POST /api/status  — 查询任务池状态
 */
export function registerApiRoutes(router, { addLocks }) {
  router.post('/api/:action', (req, res, body, params) => {
    (async () => {
      try {
        const data = JSON.parse(body);
        const { roundId, workerId } = data;
        const entry = activeQueues.get(roundId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!entry) { res.end(JSON.stringify({ error: 'round not found' })); return; }

        const { tq, sessionId, session: aqSession } = entry;
        const action = params.action;

        const pushStep = (step) => {
          recordWorkerStep(sessionId, step);
          emit(sessionId, { type: 'worker_step', ...step });
        };

        // ── /api/claim ───────────────────────────────────────────────
        if (action === 'claim') {
          // SWARM 模式任务池为空：Worker-1 还在规划中，让其他 Worker 等待
          if (entry.mode === 'SWARM' && tq.snapshot().length === 0) {
            res.end(JSON.stringify({ task: null, waitForPlanner: true }));
            return;
          }

          const task = tq.claim(workerId);

          // 整合任务保护：仍有未完成的非整合任务时，暂不认领整合任务
          if (task && SUMMARY_RE.test(task.description.slice(0, 30))) {
            const nonSummaryPending = tq.snapshot().filter(t =>
              t.id !== task.id &&
              !SUMMARY_RE.test(t.description.slice(0, 30)) &&
              (t.status === 'pending' || t.status === 'claimed')
            );
            if (nonSummaryPending.length > 0) {
              tq.release(task.id);
              res.end(JSON.stringify({ task: null, waitForEmerged: true }));
              return;
            }
          }

          if (task) {
            pushStep({ workerId, step: 'claim', taskId: task.id, text: task.description });
            if (aqSession) {
              aqSession.taskSnapshot = tq.snapshot();
              if (aqSession.agentState?.workers?.[workerId]) {
                aqSession.agentState.workers[workerId] = { status: 'running', task: task.description.slice(0, 60) };
              }
            }
          }
          res.end(JSON.stringify({ task: task || null }));
          return;
        }

        // ── /api/done ────────────────────────────────────────────────
        if (action === 'done') {
          const { taskId, result } = data;
          tq.complete(taskId, result);
          pushStep({ workerId, step: 'done', taskId, text: result?.slice(0, 100) || '完成' });
          if (aqSession) {
            aqSession.taskSnapshot = tq.snapshot();
            if (aqSession.agentState?.workers?.[workerId]) {
              aqSession.agentState.workers[workerId] = { status: 'running', task: '寻找下一个任务...' };
            }
            setImmediate(() => saveSession(aqSession));
          }
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // ── /api/add ─────────────────────────────────────────────────
        if (action === 'add') {
          if (entry.mode && entry.mode !== 'SWARM') {
            res.end(JSON.stringify({ error: `mode ${entry.mode} does not allow adding tasks` }));
            return;
          }

          let { description, blockedBy = [], reason = '', type = 'normal' } = data;
          const ctx = `session=${sessionId} round=${roundId} worker=${workerId}`;

          // 互斥锁：同一 round 的 /api/add 串行执行，防止并发重复追加
          const prev = addLocks.get(roundId) || Promise.resolve();
          const next = prev.then(async () => {
            const existing = tq.snapshot();
            const isSummaryTask = SUMMARY_RE.test(description.slice(0, 30));

            // LLM 去重：队列非空时调用，判断重叠情况
            if (existing.length > 0) {
              try {
                slog('INFO', ctx, `[dedup] 开始去重，队列共 ${existing.length} 条，新任务: ${description.slice(0, 80)}`);
                const dedupResult = await checkDuplicate(description, existing);
                slog('INFO', ctx, `[dedup] 结果=${dedupResult.result}${dedupResult.duplicateOf ? ` (与 #${dedupResult.duplicateOf} 重叠)` : ''} | ${dedupResult.reason}`);

                if (dedupResult.result === 'duplicate') {
                  slog('INFO', ctx, `[dedup] ✗ 拒绝追加：与任务 #${dedupResult.duplicateOf} 重复`);
                  console.log(`[/api/add] ${workerId} 追加任务被 LLM 判为重复（与任务 ${dedupResult.duplicateOf}）：${dedupResult.reason}`);
                  res.end(JSON.stringify({ duplicate: true, duplicateOf: dedupResult.duplicateOf, reason: dedupResult.reason }));
                  return;
                }
                if (dedupResult.result === 'overlap' && !isSummaryTask && dedupResult.trimmedDescription) {
                  slog('INFO', ctx, `[dedup] ~ 部分重叠，裁剪描述为: ${dedupResult.trimmedDescription.slice(0, 80)}`);
                  console.log(`[/api/add] ${workerId} 任务部分重叠，裁剪为差异部分：${dedupResult.reason}`);
                  description = dedupResult.trimmedDescription;
                }
                if (dedupResult.result === 'none') {
                  slog('INFO', ctx, `[dedup] ✓ 无重叠，放行`);
                }
              } catch (e) {
                slog('WARN', ctx, `[dedup] ⚠ LLM 去重失败，放行：${e.message}`);
                console.warn('[/api/add] LLM 去重失败，放行：', e.message);
              }
            } else {
              slog('INFO', ctx, `[dedup] 队列为空，跳过去重`);
            }

            // 涌现判断
            const isSwarm = entry.mode === 'SWARM';
            const workerHasDone = existing.some(t => t.status === 'done' && t.claimedBy === workerId);
            const isEmerged = !isSummaryTask && (isSwarm ? existing.length > 0 : workerHasDone);

            // 整合任务：服务端自动把所有非整合探索任务 id 补入 blockedBy，防止 Worker 漏写
            let effectiveBlockedBy = blockedBy;
            if (isSummaryTask) {
              const allExploreIds = existing
                .filter(t => !SUMMARY_RE.test(t.description.slice(0, 30)))
                .map(t => t.id);
              effectiveBlockedBy = [...new Set([...allExploreIds, ...blockedBy])];
            }

            const newId = tq.add(description, effectiveBlockedBy, workerId, isEmerged, reason, type);

            // 新的非整合任务加入后，立即把新任务 id 追加进已有整合任务的 blockedBy（维持拓扑图正确连线）
            if (!isSummaryTask) {
              const afterAdd = tq.snapshot();
              for (const st of afterAdd.filter(t => SUMMARY_RE.test(t.description.slice(0, 30)))) {
                if (!(st.blockedBy || []).includes(newId)) {
                  tq.updateBlockedBy(st.id, [...(st.blockedBy || []), newId]);
                }
              }
            }

            pushStep({ workerId, step: 'add_task', taskId: newId, text: description.slice(0, 100) });

            if (isEmerged && reason) {
              const snap = tq.snapshot();
              const newTask = snap.find(t => t.id === newId);
              const emergeMsg = { role: 'emerge', taskId: newId, workerId, reason, description: description.slice(0, 80), type, label: newTask?.label || null, icon: newTask?.icon || null, ts: Date.now(), roundId };
              if (aqSession) {
                aqSession.messages.push(emergeMsg);
                // 同步更新 dispatch 消息的 tasks，让前端刷新后直接渲染涌现任务
                const dispMsg = aqSession.messages.findLast?.(m => m.role === 'dispatch' && m.roundId === roundId)
                  || [...aqSession.messages].reverse().find(m => m.role === 'dispatch' && m.roundId === roundId);
                if (dispMsg) dispMsg.tasks = snap;
                if (aqSession.dispatch?.roundId === roundId) aqSession.dispatch.tasks = snap;
                setImmediate(() => saveSession(aqSession));
              }
              emit(sessionId, { type: 'task_emerged', ...emergeMsg, allTasks: snap });
            }
            res.end(JSON.stringify({ id: newId }));
          }).catch(e => {
            res.end(JSON.stringify({ error: e.message }));
          });
          addLocks.set(roundId, next);
          return;
        }

        // ── /api/status ──────────────────────────────────────────────
        if (action === 'status') {
          res.end(JSON.stringify({ tasks: tq.snapshot() }));
          return;
        }

        res.end(JSON.stringify({ error: 'unknown api action' }));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    })();
  });
}
