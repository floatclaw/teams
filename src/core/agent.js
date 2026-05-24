/**
 * 通用 Agent 执行接口
 *
 * 支持的 adapter：
 *   - claude   : Claude Code CLI (claude --print --output-format stream-json)
 *   - pi       : pi agent CLI    (pi --print --mode json)
 *   - hermes   : Hermes agent CLI (hermes chat -q ... -Q)
 *   - openclaw : OpenClaw agent CLI (openclaw agent --local --json --message ...)
 *
 * 通过 config/agent.json 中的 "agent" 字段切换，未配置时默认使用 claude。
 * 端口、超时、并发等运行参数统一在 config/agent.json 配置，模型由各 adapter 默认值决定。
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dirname, '../..', 'config', 'agent.json');

function loadConfig() {
  if (existsSync(CONFIG_FILE)) {
    try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  }
  return {};
}

function resolveAdapterName() {
  return loadConfig().agent || 'claude';
}

// 缓存：name -> adapter module（已加载的 adapter 不重复导入）
// 注意：切换 agent.json 后需重启服务，或调用 clearAdapterCache() 使新配置生效
const _adapterCache = new Map();

async function getAdapter() {
  const name = resolveAdapterName();
  if (_adapterCache.has(name)) return _adapterCache.get(name);
  let adapter;
  if (name === 'pi') {
    adapter = await import('./adapters/pi.js');
  } else if (name === 'hermes') {
    adapter = await import('./adapters/hermes.js');
  } else if (name === 'openclaw') {
    adapter = await import('./adapters/openclaw.js');
  } else {
    adapter = await import('./adapters/claude.js');
  }
  _adapterCache.set(name, adapter);
  return adapter;
}

/** 清除 adapter 缓存，切换 agent.json 后调用可立即生效（无需重启） */
export function clearAdapterCache() {
  _adapterCache.clear();
}

/**
 * 统一 Agent 运行接口
 *
 * @param {object} opts
 * @param {string} opts.agentName        - agent 名称（用于日志/UI）
 * @param {string} opts.prompt           - 用户 prompt
 * @param {string} opts.systemPromptFile - system prompt 文件路径
 * @param {string} [opts.cwd]            - 工作目录
 * @param {*}      [opts.ws]             - WebSocket / sessionId（透传给 transport）
 * @param {Map}    [opts.abortControllers]
 * @param {function} [opts.onText]       - 文本增量回调
 * @returns {Promise<void>}
 */
export async function runAgent(opts) {
  const adapter = await getAdapter();
  // 自动注入 timeoutMs（各 adapter 按需使用，如 openclaw 需传 --timeout 给进程）
  const timeoutMs = opts.timeoutMs ?? getTaskTimeoutMs();
  return await adapter.run({ ...opts, timeoutMs });
}

/** 当前使用的 adapter 名称，供日志/UI 展示 */
export function currentAgentName() {
  return resolveAdapterName();
}

/** HTTP 服务端口 */
export function getPort() {
  return loadConfig().port || 3000;
}

/** 任务超时时间（ms），超时后 claimed 任务自动释放回 pending */
export function getTaskTimeoutMs() {
  return loadConfig().taskTimeoutMs || 600_000;
}

/** 非 SWARM 模式的 Worker 并发上限 */
export function getMaxWorkers() {
  return loadConfig().maxWorkers || 4;
}

/** SWARM 模式的认知角色列表，长度即并发数。角色定义维护在 config/agent.json */
export function getSwarmRoles() {
  return loadConfig().swarmRoles ?? [];
}
