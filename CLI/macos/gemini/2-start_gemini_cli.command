#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT_DIR"

find_agy() {
    if command -v agy >/dev/null 2>&1; then
        command -v agy
        return 0
    fi
    find /Applications "$HOME/Applications" -maxdepth 5 -type f -name agy 2>/dev/null | head -n 1
}

AGY_BIN="$(find_agy || true)"
if [ -z "$AGY_BIN" ]; then
    echo "Antigravity CLI was not found."
    echo "Please run CLI/macos/gemini/install_gemini_cli.command first, then open a new Terminal."
    echo ""
    echo "Press Enter to close..."
    read -r
    exit 1
fi

echo "Starting Antigravity CLI: $AGY_BIN"
echo "If this is the first run, choose a color scheme and complete login."
echo ""
"$AGY_BIN"
