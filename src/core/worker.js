import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { runAgent, getSwarmRoles } from './agent.js';
import { saveSession } from './session.js';
import { send } from '../transport/events.js';
import { slog } from './logger.js';

const AGENTS_DIR = join(new URL('.', import.meta.url).pathname, '../..', 'agents');

export async function runWorker(workerId, role, tq, session, getWs, abortControllers, workspace, mode = 'PARALLEL', roundWorkDir, port, dataDir) {
  const w = () => typeof getWs === 'function' ? getWs() : getWs;
  const ws = w();

  const basePrompt = readFileSync(join(AGENTS_DIR, 'worker.md'), 'utf8');

  const modeMd = join(AGENTS_DIR, 'modes', `${mode.toLowerCase()}.md`);
  const modePrompt = existsSync(modeMd) ? readFileSync(modeMd, 'utf8') : '';

  const workerMd = join(AGENTS_DIR, `${role}.md`);
  const rolePrompt = existsSync(workerMd) ? readFileSync(workerMd, 'utf8') : '';

  const apiBase = `http://localhost:${port}/api`;

  const systemPrompt = basePrompt
    .replace(/API_BASE/g, apiBase)
    .replace(/ROUND_ID/g, session.currentRoundId)
    .replace(/WORKSPACE/g, workspace)
    .replace(/ROUND_WORK_DIR/g, roundWorkDir)
    .replace(/WORKER_ID/g, workerId)
    + (modePrompt ? `\n\n---\n\n${modePrompt}` : '')
    + (rolePrompt ? `\n\n---\n\n## 你的角色专长\n\n${rolePrompt}` : '')
;

  const tmpFile = join(dataDir, `worker-${workerId}-${role}.md`);
  writeFileSync(tmpFile, systemPrompt);

  const swarmRoles = getSwarmRoles();  // 已含默认角色兜底，不会为空
  const workerIdx = parseInt(workerId.replace('worker-', ''), 10) - 1;
  const cogRole = mode === 'SWARM'
    ? (swarmRoles[workerIdx] ?? swarmRoles[0])
    : null;

  const workerPrompt = `你是 Worker ${workerId}，协作模式：${mode}。

工作目录：${roundWorkDir}
历史上下文：${join(workspace, 'context.md')}（如存在可读取了解本项目历史）
roundId：${session.currentRoundId}
workerId：${workerId}
API Base：${apiBase}
${mode === 'SWARM' ? `
任务目标文件：${join(roundWorkDir, 'goal.md')}
群体洞察文件：${join(workspace, 'insights.md')}（读写都用此路径，跨轮次共享）
查看任务池：curl -s -X POST ${apiBase}/status -H 'Content-Type: application/json' -d '{"roundId":"${session.currentRoundId}","workerId":"${workerId}"}'
追加任务：curl -s -X POST ${apiBase}/add -H 'Content-Type: application/json' -d '{"roundId":"${session.currentRoundId}","workerId":"${workerId}","description":"...","blockedBy":[]}'

【你的认知偏好角色】${cogRole.role}
核心问题：${cogRole.question}
擅长发现：${cogRole.strength}
在执行任务、反思涌现时，优先从这个视角切入。写洞察时用格式 [${workerId}][标签] 洞察：xxx` : ''}

按照系统提示中的【${mode} 模式规则】执行，完成后输出一句话总结。

⚠️ 重要约束：如果你执行的是整合/汇总任务，最终报告必须写入 ${roundWorkDir}/result.md，不得使用其他文件名。`;

  if (session.agentState?.workers?.[workerId]) {
    session.agentState.workers[workerId] = { status: 'running', task: '正在认领任务...' };
    setImmediate(() => saveSession(session));
  }
  slog('INFO', `session=${session.id} round=${session.currentRoundId} worker=${workerId}`, `启动 role=${role} mode=${mode}`);
  send(w(), { type: 'worker_start', workerId, role });

  await runAgent({
    agentName: `${role}(${workerId})`,
    prompt: workerPrompt,
    systemPromptFile: tmpFile,
    cwd: roundWorkDir,
    ws: w(), abortControllers,
    onText: () => {},
  });

  if (session.agentState?.workers?.[workerId]) {
    session.agentState.workers[workerId] = { status: 'done', task: '全部完成' };
    setImmediate(() => saveSession(session));
  }
  slog('INFO', `session=${session.id} round=${session.currentRoundId} worker=${workerId}`, '退出');
  send(w(), { type: 'worker_done', workerId, role });
}
