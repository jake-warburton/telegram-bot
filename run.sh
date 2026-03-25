#!/bin/zsh
# Load env vars and start bot
source ~/.zshrc 2>/dev/null || true

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load .env file
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

exec "$(which node)" --import tsx/esm src/bot.ts
