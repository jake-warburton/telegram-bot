#!/bin/bash
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME"
PLIST_NAME="com.user.telegram-bot"
PLIST_SRC="$INSTALL_DIR/$PLIST_NAME.plist"
PLIST_DST="$HOME_DIR/Library/LaunchAgents/$PLIST_NAME.plist"
LOG_DIR="$HOME_DIR/Library/Logs/telegram-bot"

echo "=== Telegram Bot Installer ==="

# Check prerequisites
if [ ! -f "$INSTALL_DIR/.env" ]; then
  echo "ERROR: .env file not found. Copy .env.example to .env and fill in your values."
  exit 1
fi

if [ ! -d "$INSTALL_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  cd "$INSTALL_DIR" && npm install
fi

# Create log directory
mkdir -p "$LOG_DIR"

# Make run.sh executable
chmod +x "$INSTALL_DIR/run.sh"

# Generate plist from template
sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
    -e "s|__HOME__|$HOME_DIR|g" \
    "$PLIST_SRC" > "$PLIST_DST"

# Unload if already loaded
launchctl unload "$PLIST_DST" 2>/dev/null || true

# Load the service
launchctl load "$PLIST_DST"

echo ""
echo "Installed and started!"
echo "  Logs: $LOG_DIR/"
echo "  Stop: launchctl unload $PLIST_DST"
echo "  Start: launchctl load $PLIST_DST"
