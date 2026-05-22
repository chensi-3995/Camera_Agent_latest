#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="${PYTHON_BIN:-/home/jxq/miniconda3/bin/python}"
CONFIG_PATH="${CONFIG_PATH:-$SCRIPT_DIR/server_config.json}"

cd "$SCRIPT_DIR"
exec "$PYTHON_BIN" server_recorder.py --config "$CONFIG_PATH"
