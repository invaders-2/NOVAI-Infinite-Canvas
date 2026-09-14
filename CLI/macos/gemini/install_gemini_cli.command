#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_PATH="$LOG_DIR/antigravity-cli-install-$(date +%Y%m%d-%H%M%S).log"

find_agy() {
    if command -v agy >/dev/null 2>&1; then
        command -v agy
        return 0
    fi
    find /Applications "$HOME/Applications" -maxdepth 5 -type f -name agy 2>/dev/null | head -n 1
}

write_env_value() {
    local key="$1"
    local value="$2"
    local env_path="$ROOT_DIR/API/.env"
    mkdir -p "$ROOT_DIR/API"
    touch "$env_path"
    if grep -q "^${key}=" "$env_path" 2>/dev/null; then
        sed -i '' "/^${key}=/d" "$env_path"
    fi
    printf '%s=%s\n' "$key" "$value" >> "$env_path"
}

{
    echo "=== Antigravity CLI install/update ==="
    echo "Workspace: $ROOT_DIR"
    echo ""

    AGY_BIN="$(find_agy || true)"
    if [ -z "$AGY_BIN" ] && command -v brew >/dev/null 2>&1; then
        echo "Trying Homebrew cask install..."
        brew install --cask google-antigravity || brew install --cask antigravity || true
        AGY_BIN="$(find_agy || true)"
    fi

    if [ -z "$AGY_BIN" ]; then
        echo "Antigravity CLI was not found."
        echo "Please install Google Antigravity from https://antigravity.google, then open a new Terminal and run:"
        echo "  agy --version"
        echo ""
        echo "After agy is available, rerun this script."
        echo ""
        echo "Log: $LOG_PATH"
        echo "Press Enter to close..."
        read -r
        exit 2
    fi

    echo "Antigravity CLI found: $AGY_BIN"
    "$AGY_BIN" --version || true
    write_env_value "AGY_BIN" "$AGY_BIN"
    write_env_value "ANTIGRAVITY_BIN" "$AGY_BIN"
    echo "Updated API/.env with AGY_BIN and ANTIGRAVITY_BIN."
    echo ""
    echo "Run 'agy' in Terminal to choose color scheme and sign in."
    echo "Then test:"
    echo "  agy -p \"只回复 OK\" --print-timeout 60s"
    echo ""
    echo "Log: $LOG_PATH"
    echo "Press Enter to close..."
    read -r
} 2>&1 | tee -a "$LOG_PATH"
