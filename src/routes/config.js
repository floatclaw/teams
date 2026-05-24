import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { clearAdapterCache } from '../core/agent.js';

/** 检测 agent CLI 是否已安装，返回 { installed, bin } */
function checkAgentInstalled(agentName, cfg = {}) {
  const checks = {
    claude:   ['claude'],
    pi:       ['pi'],
    hermes:   ['hermes'],
    openclaw: [cfg.openclawBin || 'openclaw'],
  };
  const candidates = checks[agentName] || [agentName];
  for (const candidate of candidates) {
    try {
      const bin = candidate.split(' ')[0];
      execSync(`which ${bin}`, { stdio: 'ignore', timeout: 3000 });
      return { installed: true, bin: candidate };
    } catch {}
  }
  return { installed: false, bin: candidates[0] };
}

/**
 * GET  /config/agent          读取当前 agent 配置
 * GET  /config/agent/check    检测所有 agent CLI 安装状态
 * POST /config/agent          更新 agent 字段，切换前检测 CLI 是否可用
 */
export function registerConfigRoute(router, { AGENT_CONFIG_FILE }) {
  router.get('/config/agent', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      const cfg = JSON.parse(readFileSync(AGENT_CONFIG_FILE, 'utf8'));
      res.end(JSON.stringify(cfg));
    } catch { res.end(JSON.stringify({ agent: 'claude' })); }
  });

  // 批量检测所有 agent 安装状态
  router.get('/config/agent/check', (req, res) => {
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(AGENT_CONFIG_FILE, 'utf8')); } catch {}
    const agents = ['claude', 'pi', 'hermes', 'openclaw'];
    const result = {};
    for (const name of agents) {
      result[name] = checkAgentInstalled(name, cfg);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });

  router.post('/config/agent', (req, res, body) => {
    try {
      const updates = JSON.parse(body);
      let cfg = {};
      try { cfg = JSON.parse(readFileSync(AGENT_CONFIG_FILE, 'utf8')); } catch {}

      if (updates.agent !== undefined) {
        // 切换前检测 CLI 是否可用
        const check = checkAgentInstalled(updates.agent, cfg);
        if (!check.installed) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            notInstalled: true,
            agent: updates.agent,
            bin: check.bin,
            error: `${updates.agent} CLI 未安装（尝试查找: ${check.bin}）`,
          }));
          return;
        }
        cfg.agent = updates.agent;
      }
      delete cfg.model; // 移除遗留的 model 字段
      writeFileSync(AGENT_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      clearAdapterCache(); // 切换 agent 后立即清缓存，下次调用生效
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, config: cfg }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });
}
