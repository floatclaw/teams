# Teams — Multi-Agent Collaboration System

**Teams** is a lightweight multi-agent orchestration platform powered by Claude Code CLI. It coordinates multiple AI Workers in parallel, dynamically generates tasks, shares knowledge across agents, and aggregates final results — all through a real-time web UI.

**Teams** 是一个由 Claude Code CLI 驱动的轻量级多智能体协作平台。它将多个 AI Worker 并发调度，动态生成任务，跨 Agent 共享知识，并最终聚合输出结果 —— 全程通过实时 Web UI 可视化。

---

## Features / 核心特性

- **6 Collaboration Modes** — SOLO, PARALLEL, PIPELINE, HYBRID, SWARM, NOOP
- **6 种协作模式** — 单任务、并行、流水线、混合、蜂群自组织、闲聊
- **Dynamic Task Generation** — Workers spawn emergent tasks during execution; LLM-based deduplication prevents redundancy
- **动态任务涌现** — Worker 在执行中可产生新任务，LLM 自动去重
- **Real-time Monitoring** — SSE-based live task status, worker progress, and tool summaries in browser
- **实时监控** — 浏览器端基于 SSE 的任务状态、Worker 进度、工具调用摘要
- **Pluggable Adapters** — Swap between `claude`, `pi`, `hermes`, `openclaw` without restarting
- **可插拔适配器** — 无需重启即可热切换底层 Agent CLI
- **Pause / Resume** — Suspend a running round and continue later
- **暂停/恢复** — 支持中途挂起、稍后继续执行
- **Session History** — Multi-round conversations with persistent cross-round context
- **会话历史** — 多轮对话，跨轮知识持久化共享
- **Share Reports** — One-click public sharing of generated results
- **结果分享** — 一键生成可公开访问的报告链接
- **Zero Dependencies** — Pure Node.js, no npm packages required
- **零外部依赖** — 纯 Node.js 实现，无需安装任何 npm 包

---

## Collaboration Modes / 协作模式

| Mode | Description |
|------|-------------|
| **SOLO** | Single agent handles the entire task / 单 Agent 完成全部任务 |
| **PARALLEL** | Independent sub-tasks run concurrently, then aggregated / 多任务并发后聚合 |
| **PIPELINE** | Strict sequential dependency: output of one feeds the next / 严格顺序依赖流水线 |
| **HYBRID** | Parallel exploration + sequential synthesis (best for research & reports) / 并行探索 + 顺序综合，适合调研报告 |
| **SWARM** | Workers self-organize, claim and generate tasks freely / Worker 自由认领和涌现任务，无边界协作 |
| **NOOP** | Greeting / chitchat, no task execution / 闲聊，不触发任务执行 |

---

## Architecture / 架构

```
Browser (SSE) ←──── HTTP Server ←──── Task Queue (file-locked JSON)
                         │
              ┌──────────┴──────────┐
              │                     │
          Dispatcher            Workers (×N)
        (plans tasks)        (claim → execute → done)
              │                     │
        Agent Adapter         Agent Adapter
   (claude/pi/hermes/openclaw)
```

**Key design principles / 核心设计原则:**
- Business logic lives in Agent prompts, not server code / 业务逻辑在提示词中，不在服务代码里
- File system as shared communication layer / 文件系统作为 Worker 间通信介质
- Event bus decouples execution from UI transport / 事件总线解耦执行层与 UI 推送层
- New collaboration modes = new `.md` files only / 新增协作模式只需添加提示词文件

---

## Quick Start / 快速开始

### Prerequisites / 前提条件

- Node.js 18+
- [Claude Code CLI](https://claude.ai/code) installed and authenticated / 已安装并登录 Claude Code CLI

```bash
# Verify Claude CLI / 验证 Claude CLI
which claude
```

### Install & Run / 安装并运行

```bash
git clone https://github.com/floatclaw/teams.git
cd teams

# Copy config from example / 从示例复制配置文件
cp config/agent.example.json config/agent.json

npm start
# Server starts at: http://localhost:3001
```

No `npm install` needed — zero external dependencies.
无需 `npm install`，零外部依赖。

---

## Configuration / 配置

### `config/agent.json`

```json
{
  "agent": "claude",        // Adapter: claude | pi | hermes | openclaw
  "port": 3001,             // HTTP server port
  "taskTimeoutMs": 600000,  // Task timeout in ms (default 10 min)
  "maxWorkers": 4,          // Max concurrent workers
  "swarmRoles": [           // Worker personas for SWARM mode
    {
      "role": "广度探索者",
      "question": "还有哪些重要方向完全没被覆盖？",
      "strength": "发现空白领域、边界话题"
    }
  ]
}
```

---

## Data Storage / 数据存储

All persistent data is stored in `~/.teams/`:

```
~/.teams/
├── server.log                  # Structured server logs
└── {sessionId}/
    ├── workspace/
    │   ├── context.md          # Cross-round conversation history
    │   └── insights.md         # SWARM collective knowledge
    └── rounds/
        └── {roundId}/
            ├── tasks/
            │   ├── queue.json  # Task queue state
            │   └── queue.lock  # File-based concurrency lock
            └── work/
                ├── result.md           # Final aggregated output
                └── {taskId}.result.md  # Per-task results
```

---

## Worker API / Worker 接口

Workers communicate with the server via HTTP:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/claim` | POST | Claim a pending task / 认领任务 |
| `/api/done` | POST | Mark task complete with result / 提交任务结果 |
| `/api/add` | POST | Spawn an emergent sub-task / 涌现新任务 |
| `/api/status` | GET | Query task queue status / 查询任务队列 |

---

## Adding a New Collaboration Mode / 新增协作模式

1. Create `agents/modes/{mode-name}.md` with mode-specific Worker rules
2. Add the mode to the Dispatcher's planning logic in `agents/dispatcher.md`
3. No server code changes required / 无需修改服务代码

---

## Project Structure / 项目结构

```
teams/
├── src/
│   ├── server.js              # HTTP server & router
│   ├── core/
│   │   ├── runner.js          # Round lifecycle orchestration
│   │   ├── dispatcher.js      # Task planning via Agent
│   │   ├── worker.js          # Worker execution
│   │   ├── taskQueue.js       # File-locked task queue
│   │   ├── session.js         # Session persistence
│   │   ├── agent.js           # Unified agent interface
│   │   ├── dedup.js           # LLM-based task deduplication
│   │   └── adapters/          # claude / pi / hermes / openclaw
│   ├── routes/                # HTTP route handlers
│   ├── transport/
│   │   └── events.js          # Event bus (pub-sub)
│   └── ui/web/                # Vanilla JS + HTML frontend
├── agents/
│   ├── dispatcher.md          # Dispatcher system prompt
│   ├── worker.md              # Worker system prompt template
│   └── modes/                 # Per-mode prompt rules
└── config/
    └── agent.json             # Runtime configuration
```

---

## License / 许可证

MIT
