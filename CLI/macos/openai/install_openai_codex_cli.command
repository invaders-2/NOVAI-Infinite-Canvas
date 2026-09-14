#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_PATH="$LOG_DIR/openai-codex-cli-install-$(date +%Y%m%d-%H%M%S).log"

{
    echo "=== OpenAI Codex CLI install/update ==="
    echo "Workspace: $ROOT_DIR"
    echo ""

    if ! command -v curl >/dev/null 2>&1; then
        echo "curl is required. Install curl first, then run this script again."
        exit 1
    fi

    echo "Installing/updating Codex CLI with the OpenAI standalone installer..."
    if curl -fsSL https://chatgpt.com/codex/install.sh | sh; then
        :
    elif command -v npm >/dev/null 2>&1; then
        echo "Standalone installer was unavailable. Falling back to npm package install..."
        npm install -g @openai/codex
    else
        echo "Install failed, and npm is not available for fallback."
        exit 2
    fi

    echo ""
    if command -v npm >/dev/null 2>&1; then
        echo "Installing/updating GPT Image 2 helper: npm install -g gpt-image-2-skill"
        if npm install -g gpt-image-2-skill; then
            :
        else
            echo "gpt-image-2-skill install failed. Codex CLI can still run, but Image 2 helper will be unavailable."
        fi
    else
        echo "npm is not available. Skipping gpt-image-2-skill install."
    fi

    echo ""
    if command -v codex >/dev/null 2>&1; then
        echo "Codex CLI found: $(command -v codex)"
        codex --version || true
        if command -v gpt-image-2-skill >/dev/null 2>&1; then
            echo "GPT Image 2 helper found: $(command -v gpt-image-2-skill)"
        else
            echo "GPT Image 2 helper is not available in this Terminal PATH yet."
        fi
        echo ""
        echo "Done. Run 'codex' in Terminal to sign in and start using OpenAI Codex CLI."
    else
        echo "Codex CLI was installed, but 'codex' is not available in this Terminal PATH yet."
        echo "Open a new Terminal, then run: codex"
        exit 3
    fi

    echo ""
    echo "Log: $LOG_PATH"
    echo "Press Enter to close..."
    read -r
} 2>&1 | tee -a "$LOG_PATH"
