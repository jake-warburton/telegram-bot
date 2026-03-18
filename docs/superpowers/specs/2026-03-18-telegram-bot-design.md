# Telegram Remote CLI Bot — Design Spec

## Purpose

A Telegram bot that runs on a MacBook Air (always plugged in, sleep disabled) to remotely execute CLI tools (Claude, Codex, etc.) and shell commands. Single-user, personal-use tool for remote development access.

## Architecture

Single-file TypeScript bot (`src/bot.ts`) with a JSON config file. No framework, no plugins, no abstraction layers.

### Components

1. **Bot process** — long-running Node.js process managed by launchd
2. **Config file** (`config.json`) — defines CLI tools, project directories, timeouts
3. **launchd plist** — auto-starts bot on boot, restarts on crash

## Config Shape

```json
{
  "cli_tools": {
    "claude": {
      "command": "claude",
      "args": ["--print"],
      "promptArg": "append",
      "description": "Run Claude Code CLI"
    },
    "codex": {
      "command": "codex",
      "args": ["--quiet"],
      "promptArg": "append",
      "description": "Run Codex CLI"
    }
  },
  "projects": [
    "/Users/jakewarburton/Documents/repos/project-a",
    "/Users/jakewarburton/Documents/repos/project-b"
  ],
  "default_project": "/Users/jakewarburton/Documents/repos/project-a",
  "command_timeout_ms": 300000
}
```

- `promptArg: "append"` means the user's prompt is appended as the final argument after `args`
- CLI tools are registered as Telegram commands dynamically at startup

## Commands

| Command | Behavior |
|---------|----------|
| `/<tool> <prompt>` | Runs configured CLI tool in current working directory. E.g., `/claude explain this codebase` runs `claude --print "explain this codebase"` |
| `/status` | Returns: online confirmation, uptime, battery level, current working directory |
| `/run <cmd>` | Executes arbitrary shell command via `child_process.exec`. Returns stdout/stderr |
| `/projects` | Lists configured project directories (numbered) |
| `/cd <project>` | Sets working directory by name (basename match) or index number |
| `/help` | Lists all available commands with descriptions |

## Security

- **User ID whitelist**: Every incoming message is checked against `TELEGRAM_ALLOWED_USERS` env var (comma-separated user IDs). Messages from non-whitelisted users are silently ignored.
- `/run` is intentionally unrestricted for whitelisted users — this is a personal tool, not a shared service.

## Long Output Handling

- **Under 4096 chars**: Send as a single Telegram message in a markdown code block
- **Over 4096 chars**: Send as a `.txt` file attachment with a brief summary message

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs |

## launchd Service

Plist at `~/Library/LaunchAgents/com.user.telegram-bot.plist`:
- Runs on load (boot)
- Restarts on crash (`KeepAlive: true`)
- Logs stdout/stderr to `~/Library/Logs/telegram-bot/`
- Sets env vars from a `.env` file via a wrapper script

## File Structure

```
telegram-bot/
  src/bot.ts          # Single-file bot
  config.json         # CLI tools and project config
  package.json
  tsconfig.json
  .env.example        # Template for env vars
  install.sh          # Sets up launchd plist and logs directory
  com.user.telegram-bot.plist  # launchd plist template
```

## Dependencies

- `node-telegram-bot-api` — Telegram Bot API client
- `typescript`, `tsx` — TypeScript compilation/execution
- No other runtime dependencies

## Error Handling

- Command timeout: configurable via `command_timeout_ms`, sends timeout message to user
- Process errors: caught and sent as error messages to Telegram
- Bot crash: launchd restarts automatically

## Out of Scope

- Wake-on-LAN (Mac stays awake via energy settings)
- Interactive/stateful CLI sessions (tmux integration deferred)
- Multi-user support
- Message queuing or rate limiting
