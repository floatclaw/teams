#!/bin/bash
# setup.sh
# 初始化 teams 运行环境。
# 前置条件：
#   - Node.js 已安装
#   - claude CLI 已安装（npm install -g @anthropic-ai/claude-code）
#   - 已 clone 项目并在项目根目录下运行此脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== teams setup ==="
echo "项目目录: $PROJECT_DIR"

# ── Step 1: 安装依赖 ─────────────────────────────────────────────────────────
cd "$PROJECT_DIR"
if [ ! -d "node_modules" ]; then
  echo "[1/3] 安装 npm 依赖..."
  npm install
else
  echo "[1/3] node_modules 已存在，跳过"
fi

# ── Step 2: 初始化 config/agent.json ─────────────────────────────────────────
if [ ! -f "config/agent.json" ]; then
  echo "[2/3] 复制配置文件..."
  cp config/agent.example.json config/agent.json
else
  echo "[2/3] config/agent.json 已存在，跳过"
fi

# ── Step 3: 检查 claude CLI ───────────────────────────────────────────────────
if ! command -v claude &>/dev/null; then
  echo "[3/3] ⚠️  claude CLI 不可用，请先安装: npm install -g @anthropic-ai/claude-code"
else
  echo "[3/3] claude CLI 可用"
fi

# ── 启动服务 ──────────────────────────────────────────────────────────────────
PORT=$(node -e "
  try {
    const cfg = JSON.parse(require('fs').readFileSync('config/agent.json', 'utf8'));
    console.log(cfg.port || 3000);
  } catch { console.log(3000); }
" 2>/dev/null)

echo ""
echo "=== 环境就绪，启动服务 ==="
echo "访问: http://localhost:$PORT"
echo ""
node src/server.js
