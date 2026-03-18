# Telegram Remote CLI Bot

Control your Mac remotely via Telegram. Run Claude, Codex, or any CLI tool from your phone.

## Setup

### 1. Create Telegram Bot

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot`, follow prompts, save the token
3. Message [@userinfobot](https://t.me/userinfobot) to get your user ID

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:
```
TELEGRAM_BOT_TOKEN=your-token-from-botfather
TELEGRAM_ALLOWED_USERS=your-user-id
```

Edit `config.json` to add your project directories and CLI tools.

### 3. Install

```bash
npm install
bash install.sh
```

This installs a launchd service that starts on boot and restarts on crash.

### 4. Prevent Sleep

System Settings → Battery → Options → Prevent automatic sleeping when the display is off → **On**

## Commands

| Command | Description |
|---------|-------------|
| `/claude <prompt>` | Run Claude Code CLI |
| `/codex <prompt>` | Run Codex CLI |
| `/run <command>` | Run any shell command |
| `/status` | System status (uptime, battery, cwd) |
| `/projects` | List project directories |
| `/cd <project>` | Switch working directory |
| `/help` | List commands |

## Adding CLI Tools

Edit `config.json`:

```json
{
  "cli_tools": {
    "mytool": {
      "command": "mytool",
      "args": ["--flag"],
      "promptArg": "append",
      "description": "Run My Tool"
    }
  }
}
```

Restart the bot: `launchctl unload ~/Library/LaunchAgents/com.user.telegram-bot.plist && launchctl load ~/Library/LaunchAgents/com.user.telegram-bot.plist`

## Logs

```bash
tail -f ~/Library/Logs/telegram-bot/stdout.log
tail -f ~/Library/Logs/telegram-bot/stderr.log
```

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.user.telegram-bot.plist
rm ~/Library/LaunchAgents/com.user.telegram-bot.plist
```
