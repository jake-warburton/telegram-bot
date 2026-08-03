# Codex Computer Use Handoff Plan

## Goal

Make `/codexchat` able to use the standalone computer-use stack during a Telegram chat session so Codex can:

- launch apps like Firefox
- take screenshots while working
- perform GUI actions
- observe the result of those actions
- send screenshots or recordings back to Telegram when useful

Target demo:

> `/codexchat`
>
> "Open Firefox, go to example.com, take a screenshot, and tell me what you see."

## Current status

What already works:

- `telegram-bot` bot-side integration for the first slice is implemented in this repo
- `telegram-bot` now has an MVP `/task` mode for bounded autonomous Codex runs
- `telegram-bot` now has `/taskovernight` for longer red/green/refactor/verify Codex loops
- `computer-use-host` exists as a standalone repo
- host API supports:
  - `GET /health`
  - `POST /sessions`
  - `GET /sessions/:id`
  - `POST /sessions/:id/actions/screenshot`
  - `POST /sessions/:id/actions/recording/start`
  - `POST /sessions/:id/actions/recording/stop`
- `telegram-bot` supports:
  - `/sessionstart`
  - `/sessionscreenshot`
  - `/sessionwatchon`
  - `/sessionwatchoff`
  - `/sessionrecordstart`
  - `/sessionrecordstop`
- `telegram-bot` will try to auto-start `computer-use-host` if it is not healthy
- `telegram-bot` now tries to prepare `computer-use-mcp` for `/codexchat` and `/codexchatyolo`
  - it checks for the sibling repo
  - it attempts idempotent Codex MCP registration
  - it creates or reuses a computer-use session for Codex chat and task flows
  - it injects screenshot-before / screenshot-after guidance into the compacted Codex prompt used for each Telegram turn
- `/codexchat` no longer relies on an endlessly growing Codex thread for continuity; it rebuilds each turn from compact local memory plus the current task message
- screenshot capture works on this Mac after Screen Recording permission was granted
- native `.mov` screen recording works through `/usr/sbin/screencapture`
- this repo includes a browser-form fallback in [`src/telegram-browser-photo.ts`](/Users/jakewarburton/Documents/repos/telegram-bot/src/telegram-browser-photo.ts) for sandboxed agent runs where direct shell access to `api.telegram.org` is blocked but Chrome still works

What does not work yet:

- `computer-use-mcp` is not implemented yet
- `/codexchat` still cannot access computer-use tools until `computer-use-mcp/src/server.js` exists
- host does not yet expose GUI action tools like:
  - `launch_app`
  - `focus_window`
  - `click`
  - `type_text`
  - `press_keys`
  - `scroll`
- the remaining implementation work is no longer in `telegram-bot`; it is in the sibling repos below

## Repos involved

- [telegram-bot](/Users/jakewarburton/Documents/repos/telegram-bot)
- [computer-use-host](/Users/jakewarburton/Documents/repos/computer-use-host)
- [computer-use-mcp](/Users/jakewarburton/Documents/repos/computer-use-mcp)

## If work stops here

The next checkpoint should explicitly leave this repo and continue in sibling directories.

Switch directories in this order:

1. Change into [computer-use-mcp](/Users/jakewarburton/Documents/repos/computer-use-mcp).
2. Build `src/server.js` and get the stdio MCP server running against the existing host HTTP API.
3. Then change into [computer-use-host](/Users/jakewarburton/Documents/repos/computer-use-host).
4. Add the missing GUI action endpoints needed by the MCP server.
5. Come back to [telegram-bot](/Users/jakewarburton/Documents/repos/telegram-bot) only for end-to-end verification and any follow-up prompt or UX cleanup.

Reason for the directory switch:

- the Telegram bot side already creates sessions, captures screenshots, starts and stops recordings, and attempts Codex MCP registration
- the hard blocker for real `/codexchat` GUI control is the missing MCP server implementation
- after that, the next blocker is the missing host-side GUI action surface

## Next implementation order

### 1. Finish `computer-use-mcp`

Create a real stdio MCP server in `computer-use-mcp` using `@modelcontextprotocol/sdk`.

Initial tools:

- `create_session`
- `capture_screenshot`
- `start_recording`
- `stop_recording`
- `launch_app`
- `focus_window`
- `click`
- `type_text`

The MCP server should call `computer-use-host` over HTTP.

### 2. Extend `computer-use-host`

Add the minimum GUI action endpoints needed for Firefox demo:

- `POST /sessions/:id/actions/launch-app`
- `POST /sessions/:id/actions/focus-window`
- `POST /sessions/:id/actions/click`
- `POST /sessions/:id/actions/type`
- `POST /sessions/:id/actions/key`

Implementation preference:

- app launch: `open -a`
- focus/window metadata: AppleScript or accessibility
- input: accessibility or Quartz/AppleScript based approach

### 3. Verify MCP registration from `telegram-bot`

In `telegram-bot`, before starting `/codexchat` or `/codexchatyolo`:

- ensure `computer-use-host` is healthy
- ensure `computer-use-mcp` is installed and runnable
- ensure Codex has an MCP server config for it

Use:

```bash
codex mcp add computer-use -- node /Users/jakewarburton/Documents/repos/computer-use-mcp/src/server.js
```

The registration step is already wired to be idempotent on the bot side. Once the MCP server exists, verify it against a real run.

### 4. Make `/codexchat` use the tools

When starting a Codex chat session:

- ensure a computer-use session exists
- include brief system instructions telling Codex when to use the MCP tools
- keep continuity in a bounded local summary so token usage does not grow without limit between Telegram messages
- encourage screenshot-before and screenshot-after for GUI actions

Suggested session instruction:

> If a task requires GUI interaction, use the `computer-use` MCP tools. Take a screenshot before acting when context is unclear, and after acting when verifying results.

### 5. Add Telegram-friendly review artifacts

For unattended workflows:

- keep `/sessionscreenshot`
- keep `/sessionrecordstart` and `/sessionrecordstop`
- later add automatic screenshot push on:
  - major screen change
  - task completion
  - task failure

## Concrete morning tasks

1. Scaffold `computer-use-mcp/src/server.js`.
2. Implement MCP tools for:
   - `create_session`
   - `capture_screenshot`
   - `start_recording`
   - `stop_recording`
3. Verify Codex can see those tools with `codex mcp list`.
4. Add `launch_app` to `computer-use-host`.
5. Register the MCP server before `/codexchat`.
6. Test with:
   - "Create a computer-use session"
   - "Take a screenshot"
   - "Open Firefox"
   - "Take another screenshot"
7. Only after that, add click/type support.

## Known issues

- `computer-use-host/scripts/ensure-running.sh` has an incomplete macOS lifecycle story.
- In this shell environment, `launchd` showed `EX_CONFIG`, and the fallback launch path became healthy but did not stay alive reliably under this harness.
- The bot-side auto-start logic is in place, but the host lifecycle should be hardened before depending on unattended long-running sessions.
- In some agent sandboxes, `node-telegram-bot-api` or raw `fetch` calls from the shell cannot reach Telegram even though Chrome can. When that happens, use `npm run telegram:browser-photo -- --chat-id <id> --photo <path> [--caption-file <path>]` and open the generated `file://...` page in Chrome.

## Recommended first success criterion

By the next checkpoint, this should work from Telegram:

1. Start `/codexchat`
2. Ask Codex to open Firefox
3. Ask Codex to take a screenshot
4. Ask Codex what it sees

That is enough to prove the MCP integration and perception loop are real before expanding to clicks and form entry.
