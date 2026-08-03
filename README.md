# Telegram Remote CLI Bot

Control your Mac remotely via Telegram. Run Claude, Codex, or any CLI tool from your phone.

## Agent Docs

If you are an AI agent re-entering this repo, read these first:

- [AGENTS.md](/Users/jakewarburton/Documents/repos/telegram-bot/AGENTS.md)
- [computer-use-integration.md](/Users/jakewarburton/Documents/repos/telegram-bot/docs/computer-use-integration.md)
- [codex-computer-use-handoff-plan.md](/Users/jakewarburton/Documents/repos/telegram-bot/docs/codex-computer-use-handoff-plan.md)

These repo-facing docs should be maintained alongside the code. If features are added, removed, or changed, update the docs in the same change.

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
COMPUTER_USE_HOST_URL=http://127.0.0.1:4317
COMPUTER_USE_HOST_REPO=/Users/jakewarburton/Documents/repos/computer-use-host
COMPUTER_USE_MCP_REPO=/Users/jakewarburton/Documents/repos/computer-use-mcp
TELEGRAM_TASK_MAX_ATTEMPTS=5
TELEGRAM_TASK_OVERNIGHT_MAX_ATTEMPTS=48
TELEGRAM_TASK_OVERNIGHT_MAX_RUNTIME_HOURS=8
```

Edit `config.json` to add your project directories and CLI tools.

### 3. Install

```bash
npm install
bash install.sh
```

This installs a launchd service that starts on boot and restarts on crash. During install, the repo's [`.env`](/Users/jakewarburton/Documents/repos/telegram-bot/.env) is copied to `~/.config/telegram-bot/.env` for launchd to read outside protected folders like `Documents`.

For computer-use screenshots, the bot will try to start the standalone host from [`computer-use-host`](/Users/jakewarburton/Documents/repos/computer-use-host) automatically with `npm run ensure`. Override the repo location with `COMPUTER_USE_HOST_REPO` if needed.

For `/codexchat` and `/codexchatyolo`, the bot will also look for [`computer-use-mcp`](/Users/jakewarburton/Documents/repos/computer-use-mcp), register it with Codex if needed, and create or reuse a computer-use session before chat starts. Each Telegram turn runs through a compacted Codex prompt so conversation context stays bounded instead of growing an unbounded Codex thread. If the MCP repo or `src/server.js` is still missing, chat still starts but without GUI tools.

### 4. Prevent Sleep

System Settings → Battery → Options → Prevent automatic sleeping when the display is off → **On**

## Commands

| Command | Description |
|---------|-------------|
| `/claude <prompt>` | Run Claude Code CLI |
| `/claudechat` | Start interactive Claude chat |
| `/claudechatyolo` | Start Claude chat with skipped permissions |
| `/codex <prompt>` | Run Codex CLI |
| `/codexchat` | Start interactive Codex chat |
| `/codexchatyolo` | Start Codex chat in full-auto mode |
| `/chatterminal` | Open the local Terminal transcript viewer for the active chat |
| `/endchat` | End the active chat session |
| `/run <command>` | Run any shell command |
| `/status` | System status (uptime, battery, cwd) |
| `/projects` | List project directories |
| `/cd <project>` | Switch working directory for this chat |
| `/sessionstart` | Start a computer-use session |
| `/sessionscreenshot` | Capture a screenshot from the computer-use host |
| `/task <goal>` | Run a bounded autonomous Codex task |
| `/taskovernight <goal>` | Run an overnight autonomous TDD Codex loop |
| `/taskstatus` | Show autonomous task status |
| `/taskstop` | Stop the active autonomous task |
| `/help` | List commands |

Project selection is now tracked per Telegram chat, so changing directories in one chat does not affect another chat.

`/codexchat` now carries Codex chat continuity in compact local memory. Each new Telegram message is sent as a fresh ephemeral Codex run with a bounded summary of earlier turns, plus the active computer-use session id and screenshot-before/screenshot-after guidance when the `computer-use` MCP server is available.

`/task` remains the bounded autonomous runner mode. `/taskovernight` adds a longer-running overnight mode that pushes Codex through a red/green/refactor/verify loop, keeps compact attempt memory between runs, persists richer task status, and can reuse the active computer-use session for screenshot-based verification between attempts.

For day-to-day use, you do not need to rely on the slash-command picker. The bot now exposes a persistent reply keyboard with guided flows for common actions such as:

- `Task`
- `Codex Chat`
- `Chat Terminal`
- `Screenshot`
- `Launch App`
- `Change Project`
- `Task Status`
- `Task Stop`

Buttons like `Task`, `Launch App`, and `Change Project` ask for the missing argument in a follow-up message instead of requiring `/command <arg>` in one shot.

For interactive chat sessions, the bot also writes a per-chat transcript under `~/Library/Logs/telegram-bot/chat-transcripts/` and tries to open a local Terminal window tailing that file when `/claudechat`, `/codexchat`, or their yolo variants start. If you close that window, use `/chatterminal` or the `Chat Terminal` button to reopen it.

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

## Troubleshooting

If you see repeated polling errors like `getaddrinfo ENOTFOUND api.telegram.org` or `connect ETIMEDOUT ...:443`, the bot process is running but the Mac cannot reach Telegram.

Typical causes:
- DNS is failing on the Mac or router
- A VPN, firewall, or DNS filter is blocking `api.telegram.org`
- Outbound HTTPS to Telegram is timing out on port `443`

The bot now logs a short diagnosis in `stderr.log` to distinguish between:
- system-wide DNS failure
- Telegram-specific DNS failure
- HTTPS connectivity failure after DNS succeeds

## Autonomous Task Tuning

Optional env vars:

- `TELEGRAM_TASK_MAX_ATTEMPTS`
- `TELEGRAM_TASK_OVERNIGHT_MAX_ATTEMPTS`
- `TELEGRAM_TASK_OVERNIGHT_MAX_RUNTIME_HOURS`

Defaults:

- `TELEGRAM_TASK_MAX_ATTEMPTS=5`
- `TELEGRAM_TASK_OVERNIGHT_MAX_ATTEMPTS=48`
- `TELEGRAM_TASK_OVERNIGHT_MAX_RUNTIME_HOURS=8`

## Browser Fallback For Agent Screenshot Sends

For normal bot operation, [`src/bot.ts`](/Users/jakewarburton/Documents/repos/telegram-bot/src/bot.ts) sends screenshots directly with `bot.sendPhoto(...)`.

For sandboxed agent runs, the shell or Node process may fail to reach `api.telegram.org` even when Chrome still can. This repo includes a fallback generator that writes a local HTML page which auto-submits `sendPhoto` through the browser instead of the shell network stack:

```bash
npm run telegram:browser-photo -- \
  --chat-id 8724653380 \
  --photo /path/to/screenshot.png \
  --caption-file /tmp/caption.txt
```

The script prints a `file://...` URL. Open that page in Chrome and it will submit the photo directly to the Telegram Bot API using a regular browser form post.

Why this path exists:
- `fetch(...)` from a local page can hang on larger photo uploads.
- the plain HTML form submit path worked reliably for screenshot delivery during sandboxed Codex runs.
- it preserves the useful browser-network workaround without changing the production bot code path.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.user.telegram-bot.plist
rm ~/Library/LaunchAgents/com.user.telegram-bot.plist
```
