#!/bin/sh
# project-monitor —— 每日早晨摘要的启动包装器（供 launchd / cron 调用）。
#
# 用法: run-daily-summary.sh [额外参数...]
#   默认对「脚本所在仓库同级目录」的 project-tracker.xlsx 生成仪表板与当日摘要。
#
# 环境变量:
#   PM_DATA_DIR     数据目录（默认 $DSH_HOME/project-monitor，即插件权威存储）
#   PM_LEGACY       首次迁移来源工作簿（默认自动探测 <仓库根>/project-tracker.xlsx）
#   PM_NODE         node 可执行文件（默认依次尝试 DSH 运行时、/usr/bin/env node）
#   PM_EXTRA_ARGS   追加参数（例如 --text）
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(dirname -- "$SCRIPT_DIR")
REPO_DIR=$(dirname -- "$PLUGIN_DIR")

DATA_DIR=${PM_DATA_DIR:-"${DSH_HOME:-$HOME/.dsh}/project-monitor"}
# 旧工作簿只作为「首次迁移来源」：插件与 CLI 都会在存储为空时自动导入一次
LEGACY=${PM_LEGACY:-"$REPO_DIR/project-tracker.xlsx"}

# 1) 显式指定 2) DSH 桌面运行时 3) PATH 里的 node
if [ -n "${PM_NODE:-}" ]; then
  NODE=$PM_NODE
elif [ -x "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/node/bin/node" ]; then
  NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/node/bin/node"
elif [ -x "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" ]; then
  NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
else
  NODE=$(command -v node || true)
fi

if [ -z "${NODE:-}" ] || [ ! -x "$NODE" ]; then
  echo "project-monitor: 找不到可用的 node，请设置 PM_NODE" >&2
  exit 2
fi

# 每天早晨：读权威存储 → 刷新 Excel 导出 + 落盘当日摘要 + 打印纯文本摘要
# 若存储为空且存在旧工作簿，CLI 会迁移一次（幂等：有数据就跳过）。
if [ -f "$LEGACY" ]; then
  set -- --legacy "$LEGACY"
else
  set --
fi

exec "$NODE" "$PLUGIN_DIR/lib/cli.mjs" summary \
  --dir "$DATA_DIR" --text "$@" ${PM_EXTRA_ARGS:-}
