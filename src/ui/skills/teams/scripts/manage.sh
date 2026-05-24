#!/usr/bin/env bash
# teams server 管理脚本
# 用法:
#   manage.sh check     检查安装和运行状态
#   manage.sh install   安装依赖（npm install）
#   manage.sh start     启动 server（后台运行）
#   manage.sh stop      停止 server
#   manage.sh restart   重启 server
#   manage.sh setup     一键：检查→安装→启动

set -euo pipefail

PROJ_DIR="$HOME/projects/teams"
PORT=3001
PID_FILE="$HOME/.teams/server.pid"
LOG_FILE="$HOME/.teams/server.log"

# ── 工具函数 ──────────────────────────────────────────────────────

is_running() {
  curl -s --max-time 2 "http://localhost:$PORT/sessions" > /dev/null 2>&1
}

get_pid() {
  if [ -f "$PID_FILE" ]; then
    cat "$PID_FILE"
  fi
}

# ── 子命令 ────────────────────────────────────────────────────────

cmd_check() {
  echo "=== Teams Server 状态检查 ==="

  # 1. 项目目录
  if [ -d "$PROJ_DIR" ]; then
    echo "✓ 项目目录: $PROJ_DIR"
  else
    echo "✗ 项目目录不存在: $PROJ_DIR"
    echo "  请先 clone 项目："
    echo "  git clone https://github.com/floatclaw/teams.git $PROJ_DIR"
    exit 1
  fi

  # 2. Node.js
  if command -v node &> /dev/null; then
    echo "✓ Node.js: $(node --version)"
  else
    echo "✗ Node.js 未安装，请先安装 Node.js >= 18"
    exit 1
  fi

  # 3. 依赖
  if [ -d "$PROJ_DIR/node_modules" ]; then
    echo "✓ 依赖已安装 (node_modules 存在)"
  else
    echo "✗ 依赖未安装，运行 manage.sh install"
  fi

  # 4. Claude Code
  if command -v claude &> /dev/null; then
    echo "✓ Claude Code: $(claude --version 2>/dev/null || echo '已安装')"
  else
    echo "✗ Claude Code 未安装，运行 manage.sh setup 自动安装"
    echo "  手动安装: npm install -g @anthropic-ai/claude-code"
  fi

  # 5. Server 运行状态
  if is_running; then
    pid=$(get_pid)
    echo "✓ Server 运行中 (port $PORT${pid:+, pid $pid})"
  else
    echo "✗ Server 未运行"
  fi
}

cmd_install() {
  echo "=== 安装依赖 ==="
  if [ ! -d "$PROJ_DIR" ]; then
    echo "✗ 项目目录不存在: $PROJ_DIR"
    exit 1
  fi
  cd "$PROJ_DIR"
  npm install
  echo "✓ 安装完成"
}

cmd_start() {
  echo "=== 启动 Server ==="
  if is_running; then
    echo "✓ Server 已在运行，跳过启动"
    return 0
  fi

  if [ ! -d "$PROJ_DIR/node_modules" ]; then
    echo "依赖未安装，先执行 install..."
    cmd_install
  fi

  mkdir -p "$(dirname "$PID_FILE")"
  cd "$PROJ_DIR"
  nohup node src/server.js >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "Server 启动中（pid $!）..."

  # 等待就绪（最多 15 秒）
  for i in $(seq 1 15); do
    if is_running; then
      echo "✓ Server 已就绪: http://localhost:$PORT"
      return 0
    fi
    sleep 1
  done

  echo "✗ Server 启动超时，查看日志: $LOG_FILE"
  exit 1
}

cmd_stop() {
  echo "=== 停止 Server ==="
  pid=$(get_pid)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    rm -f "$PID_FILE"
    echo "✓ Server 已停止（pid $pid）"
  else
    # 按端口查找
    pid=$(lsof -ti tcp:$PORT 2>/dev/null || true)
    if [ -n "$pid" ]; then
      kill $pid
      rm -f "$PID_FILE"
      echo "✓ Server 已停止（pid $pid）"
    else
      echo "Server 未在运行"
    fi
  fi
}

cmd_restart() {
  echo "=== 重启 Server ==="
  cmd_stop || true
  sleep 1
  cmd_start
}

cmd_setup() {
  echo "=== 一键安装并启动 ==="
  cmd_check || true   # 检查但不因为未安装/未运行而退出

  # 安装 npm 依赖
  if [ ! -d "$PROJ_DIR/node_modules" ]; then
    cmd_install
  fi

  # 安装 Claude Code（若未安装）
  if ! command -v claude &> /dev/null; then
    echo ""
    echo "=== 安装 Claude Code ==="
    if command -v npm &> /dev/null; then
      npm install -g @anthropic-ai/claude-code
      echo "✓ Claude Code 安装完成"
    else
      echo "✗ 无法自动安装 Claude Code（npm 不可用），请手动安装："
      echo "  npm install -g @anthropic-ai/claude-code"
    fi
  fi

  cmd_start
}

# ── 入口 ─────────────────────────────────────────────────────────

case "${1:-}" in
  check)   cmd_check ;;
  install) cmd_install ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  setup)   cmd_setup ;;
  *)
    echo "用法: manage.sh <check|install|start|stop|restart|setup>"
    echo ""
    echo "  check    检查安装和运行状态"
    echo "  install  安装 npm 依赖"
    echo "  start    后台启动 server"
    echo "  stop     停止 server"
    echo "  restart  重启 server"
    echo "  setup    一键：检查→安装→启动"
    exit 1
    ;;
esac
