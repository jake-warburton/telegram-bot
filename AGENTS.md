# Repo Guide

## Purpose

Telegram-controlled remote development and computer-use bot for a Mac.

This repo is the Telegram transport and orchestration layer. It is not the whole computer-use stack.

For the cross-repo ownership map, read [CAPABILITY-MATRIX.md](/Users/jakewarburton/Documents/repos/CAPABILITY-MATRIX.md) first.

## Maintenance Rule

Repo-facing docs in this repo are part of the implementation surface.

When features are added, removed, renamed, or materially changed, update these docs in the same change:

- [AGENTS.md](/Users/jakewarburton/Documents/repos/telegram-bot/AGENTS.md)
- [README.md](/Users/jakewarburton/Documents/repos/telegram-bot/README.md)
- [computer-use-integration.md](/Users/jakewarburton/Documents/repos/telegram-bot/docs/computer-use-integration.md)
- [codex-computer-use-handoff-plan.md](/Users/jakewarburton/Documents/repos/telegram-bot/docs/codex-computer-use-handoff-plan.md)

Do not leave repo capability notes stale after changing behavior.

## What This Repo Already Does

- runs Claude and Codex CLI commands from Telegram
- supports interactive `/claudechat`, `/codexchat`, and yolo variants
- keeps `/codexchat` context compact by rolling forward local summaries instead of endlessly resuming the same Codex thread
- mirrors interactive chat sessions into local transcript files and can open a Terminal viewer for them
- supports autonomous `/task` runs with bounded retries
- supports `/taskovernight` for longer-running red/green/refactor/verify Codex loops
- tracks working directory per Telegram chat
- runs arbitrary shell commands with `/run`
- reports status, project list, and current project
- starts and manages computer-use sessions
- sends screenshots to Telegram
- starts and stops screen recordings
- can periodically push screenshots with watch mode
- exposes a persistent Telegram reply keyboard for common guided flows
- attempts to auto-start `computer-use-host`
- attempts to auto-register `computer-use-mcp` for Codex
- includes a browser-based Telegram photo sender fallback for sandboxed agent runs

## Key Commands

- `/claude <prompt>`
- `/claudechat`
- `/codex <prompt>`
- `/codexchat`
- `/run <command>`
- `/chatterminal`
- `/projects`
- `/cd <project>`
- `/sessionstart`
- `/sessionstate`
- `/sessionscreenshot`
- `/sessionwatchon`
- `/sessionwatchoff`
- `/sessionrecordstart`
- `/sessionrecordstop`
- `/sessionartifacts`
- `/task`
- `/taskovernight`
- `/taskstatus`
- `/taskstop`

Common reply-keyboard flows:

- `Task`
- `Codex Chat`
- `Chat Terminal`
- `Screenshot`
- `Launch App`
- `Change Project`
- `Task Status`
- `Task Stop`

If you are changing command behavior, start in [`src/bot.ts`](/Users/jakewarburton/Documents/repos/telegram-bot/src/bot.ts).

## Important Files

- [`src/bot.ts`](/Users/jakewarburton/Documents/repos/telegram-bot/src/bot.ts)
  Main bot logic, command handlers, Codex/Claude integration, computer-use orchestration.
- [`src/state.ts`](/Users/jakewarburton/Documents/repos/telegram-bot/src/state.ts)
  Persistent bot state shape.
- [`config.json`](/Users/jakewarburton/Documents/repos/telegram-bot/config.json)
  CLI tool config and project root discovery.
- [`com.user.telegram-bot.plist`](/Users/jakewarburton/Documents/repos/telegram-bot/com.user.telegram-bot.plist)
  LaunchAgent template used by install.
- [`install.sh`](/Users/jakewarburton/Documents/repos/telegram-bot/install.sh)
  Installs the LaunchAgent and env file for headless startup.
- [`README.md`](/Users/jakewarburton/Documents/repos/telegram-bot/README.md)
  User-facing setup and command summary.

## Sibling Repos This Repo Depends On

- [`computer-use-host`](/Users/jakewarburton/Documents/repos/computer-use-host)
  Standalone local GUI automation host.
  Provides screenshots, recordings, app launch, clicks, typing, accessibility/window inspection.
- [`computer-use-mcp`](/Users/jakewarburton/Documents/repos/computer-use-mcp)
  MCP server that exposes host tools to Codex.

The bot should not reimplement host or MCP behavior if it already belongs in those repos.

## Computer Use Status

At the time of writing, this repo already:

- checks `COMPUTER_USE_HOST_URL`
- tries to auto-start the host if unavailable
- ensures a computer-use session exists for Codex
- tries to register the `computer-use` MCP server with Codex
- injects computer-use guidance into the first Codex turn
- compacts Codex chat context between Telegram messages and re-seeds the next turn from bounded local memory

Relevant code in [`src/bot.ts`](/Users/jakewarburton/Documents/repos/telegram-bot/src/bot.ts):

- host startup and diagnostics
- MCP registration
- session creation/reuse
- screenshot and recording delivery to Telegram
- Codex chat preparation
- autonomous task loop and task status tracking

Fallback utility for sandboxed agent runs:

- [`src/telegram-browser-photo.ts`](/Users/jakewarburton/Documents/repos/telegram-bot/src/telegram-browser-photo.ts)
  Builds a local HTML page that submits `sendPhoto` through Chrome instead of the shell network stack.

## Environment Variables

Core:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USERS`

Computer use:

- `COMPUTER_USE_HOST_URL`
- `COMPUTER_USE_HOST_REPO`
- `COMPUTER_USE_MCP_REPO`
- `COMPUTER_USE_HOST_AUTOSTART`
- `COMPUTER_USE_WATCH_INTERVAL_MS`
- `TELEGRAM_TASK_MAX_ATTEMPTS`
- `TELEGRAM_TASK_OVERNIGHT_MAX_ATTEMPTS`
- `TELEGRAM_TASK_OVERNIGHT_MAX_RUNTIME_HOURS`

## How `/codexchat` Works Here

When `/codexchat` starts, the bot tries to:

1. ensure the computer-use host is healthy
2. ensure the `computer-use` MCP server is registered in Codex
3. create or reuse a computer-use session
4. prepend computer-use instructions to the compacted Codex prompt it uses for each Telegram turn

So if a user asks Codex to use Firefox or inspect the screen, the expected path is through MCP tools, not raw shell commands.

To keep token usage bounded, the bot does not endlessly resume the same Codex thread. It keeps a compact local summary plus a few recent turns and sends each new Telegram message as a fresh ephemeral Codex run.

## How `/task` Works Here

`/task <goal>` is the bounded autonomous runner mode inside `telegram-bot`.

`/taskovernight <goal>` is the longer-running unattended mode.

The shared runner currently:

1. picks the Codex autonomous tool config
2. prepares computer-use context
3. runs Codex non-interactively with a structured output schema
4. keeps compact attempt memory between runs
5. retries up to a bounded attempt budget
6. for overnight mode, enforces a red/green/refactor/verify loop with a runtime deadline
7. persists task status per Telegram chat
8. allows `/taskstatus` and `/taskstop`

This is the current in-repo MVP before extracting fuller orchestration into `self-dev-runner`.

## Guided Telegram UX

The repo now includes a reply-keyboard-driven path for common actions so users do not need to depend on the slash-command picker for argument-taking commands.

Buttons such as `Task`, `Launch App`, and `Change Project` set a pending guided action and consume the next normal message as the argument.

Interactive chat sessions also maintain per-chat transcripts under `~/Library/Logs/telegram-bot/chat-transcripts/`. `/chatterminal` and the `Chat Terminal` button reopen a local Terminal tail for the active chat transcript.

## What To Read First For Computer Use

1. [`docs/computer-use-integration.md`](/Users/jakewarburton/Documents/repos/telegram-bot/docs/computer-use-integration.md)
2. [`docs/codex-computer-use-handoff-plan.md`](/Users/jakewarburton/Documents/repos/telegram-bot/docs/codex-computer-use-handoff-plan.md)
3. [`src/bot.ts`](/Users/jakewarburton/Documents/repos/telegram-bot/src/bot.ts)

## Current Caveats

- The bot is usually run headlessly via LaunchAgent, so there may be no visible Terminal window unless the transcript viewer is opened.
- GUI automation depends on macOS Screen Recording, Accessibility, and Automation permissions.
- If computer-use behavior is broken, the fault may be in sibling repos rather than this repo.
- Search for existing helper functions before adding new environment detection or Codex setup logic; a lot of this is already present.
- In a Codex sandbox, direct Node or shell calls to `api.telegram.org` may fail even when Chrome can still reach Telegram. In that case, use `npm run telegram:browser-photo -- --chat-id <chat-id> --photo <path> [--caption-file <path>]` and open the generated `file://...` page in Chrome.

## Agent Workflow Hint

If a task mentions:

- screenshots
- recordings
- Firefox/Chrome/app control
- Codex using GUI tools
- MCP registration

do not start by designing from scratch. First inspect:

- [`src/bot.ts`](/Users/jakewarburton/Documents/repos/telegram-bot/src/bot.ts)
- [`src/telegram-browser-photo.ts`](/Users/jakewarburton/Documents/repos/telegram-bot/src/telegram-browser-photo.ts) when the task is about getting media back to Telegram from a sandboxed agent
- [`computer-use-host`](/Users/jakewarburton/Documents/repos/computer-use-host)
- [`computer-use-mcp`](/Users/jakewarburton/Documents/repos/computer-use-mcp)
