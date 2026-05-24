---
name: teams
description: Submits complex tasks to the local teams multi-agent server (http://localhost:3001) for parallel execution using SWARM, PARALLEL, PIPELINE, or SOLO mode, then waits and returns the result. Use when the user says "teams，帮我", "teams 帮我", "用 teams", "交给 teams", "让 teams", "swarm 模式", "多 agent 并行", "并行调研", or when the task clearly requires multiple agents working in parallel (large-scale research, multi-dimensional analysis, parallel writing, etc.).
---

# Teams Multi-Agent

本地 server（`http://localhost:3001`）接受自然语言任务，自动选择执行模式，完成后返回汇总结果。

## 安装

首次使用，先 clone 项目：

```bash
git clone https://github.com/floatclaw/teams.git ~/projects/teams
```

然后执行 `manage.sh setup` 完成依赖安装和启动。

## Server 管理

```bash
bash src/ui/skills/teams/scripts/manage.sh check    # 检查安装和运行状态
bash src/ui/skills/teams/scripts/manage.sh setup    # 一键：检查→安装→启动（首次使用）
bash src/ui/skills/teams/scripts/manage.sh start    # 后台启动 server
bash src/ui/skills/teams/scripts/manage.sh stop     # 停止 server
bash src/ui/skills/teams/scripts/manage.sh restart  # 重启 server
bash src/ui/skills/teams/scripts/manage.sh install  # 仅安装 npm 依赖
```

所有命令须在项目根目录（`~/projects/teams`）下运行，或使用绝对路径。

## 提交任务

```bash
curl -s -X POST http://localhost:3001/task \
  -H 'Content-Type: application/json' \
  -d '{"content": "任务描述"}'
# 返回: {"sessionId": "1234567890", "title": "..."}
```

续跑已有会话（多轮对话）：在 `content` 之外加 `"sessionId": "已有ID"`

## 查看状态

```bash
node src/ui/skills/teams/scripts/status.mjs                      # 列出所有 sessions
node src/ui/skills/teams/scripts/status.mjs <sessionId>          # 查看任务队列和消息摘要
node src/ui/skills/teams/scripts/status.mjs <sessionId> --full   # 查看完整上下文（含完整 content）
```

任务状态：`pending` 等待 / `claimed` 执行中 / `done` 完成

## 中止任务

```bash
curl -s -X POST http://localhost:3001/abort \
  -H 'Content-Type: application/json' \
  -d '{"sessionId": "SESSION_ID"}'
```

## 标准工作流

1. `POST /task` → 拿到 `sessionId`，**立即告知用户任务已提交**，不阻塞等待
2. **每隔 1 分钟**调用 `status.mjs <sessionId>` 检查进度，并向用户报告当前状态（已完成几个任务、当前模式等）
3. 发现消息列表中出现 `[result]` 时，调用 `status.mjs <sessionId> --full` 获取完整结果并回显给用户
4. 多轮对话：带 `sessionId` 继续提交新任务

## 注意

- Server 未启动或未安装时，先运行 `src/ui/skills/teams/scripts/manage.sh setup`
- 任务描述里直接说明模式，如"用 swarm 模式调研..."；不指定时 Dispatcher 自动判断
- **依赖**：Node.js ≥ 18（内置 fetch，无需额外 npm 包）、bash、curl、lsof（macOS/Linux 自带）
