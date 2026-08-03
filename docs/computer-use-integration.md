# Telegram Bot Computer-Use Integration

## Goal

Allow the Telegram bot to connect to the standalone computer-use stack so it can:

- start and stop computer-use sessions
- request screenshots from the active session
- receive screenshots and recordings on the phone
- feed screenshots and host state into autonomous overnight Codex loops
- approve or deny risky actions
- review final artifacts after an unattended run

## Boundary

`telegram-bot` should stay a transport and operator interface.

It should not own:

- screenshot capture
- screen recording
- local input injection
- accessibility inspection
- artifact persistence

Those belong in `computer-use-host`.

## Proposed architecture

- `telegram-bot`
  - Telegram auth
  - command parsing
  - message/media delivery
  - approval replies
- `computer-use-host`
  - screenshots
  - recordings
  - app control
  - session state
  - artifact storage
  - policy enforcement
- `computer-use-telegram-bridge`
  - adapter between the bot and the host
  - event subscription
  - artifact upload logic
  - media throttling and watch mode

`telegram-bot` can either call the bridge over HTTP/WebSocket or absorb the bridge logic later. For now, separate repos keep the integration cleaner.

## Minimum commands

- `/session start <profile>`
- `/session status`
- `/session screenshot`
- `/session watch on`
- `/session watch off`
- `/session record start`
- `/session record stop`
- `/session approve <action-id>`
- `/session reject <action-id>`
- `/session artifacts`
- `/session stop`

## Media behavior

Screenshots:

- send low-latency preview to chat as a Telegram photo when possible
- send full-resolution screenshot as a document when detail matters
- include a short caption with session id, active app, and step summary
- if an agent sandbox cannot reach `api.telegram.org` directly but Chrome can, fall back to the browser-post helper in [`src/telegram-browser-photo.ts`](/Users/jakewarburton/Documents/repos/telegram-bot/src/telegram-browser-photo.ts)

Recordings:

- send short clips for milestone completion, failures, and explicit user request
- avoid continuous long recordings unless explicitly enabled
- store the canonical recording in host artifacts and send Telegram a copy or link

## Watch mode

Watch mode is the key unattended workflow.

It also supports the overnight `/taskovernight` path, where the bot can keep sending Codex fresh screenshots and post-attempt verification artifacts without requiring an ever-growing chat context.

When enabled, the bot should automatically send media for:

- app launched
- major screen change
- milestone completed
- evaluation failed
- approval required
- session finished

Watch mode needs throttling so long sessions do not spam Telegram.

Suggested defaults:

- at most one automatic screenshot every 30 seconds
- always bypass throttle for failure, approval, and completion events

## Approval flow

If `computer-use-host` blocks an action, the bot should send:

- what action was attempted
- why it was blocked
- latest screenshot
- approval buttons or command ids

The bot reply should map cleanly to:

- approve once
- reject once
- stop session

## First implementation slice

1. Add bridge client config to `telegram-bot`.
2. Implement `/session screenshot` as the first end-to-end media flow.
3. Implement event-driven screenshot delivery from `computer-use-host`.
4. Implement recording upload for explicit `/session record stop`.
5. Implement approval events and reply handling.
6. Add watch mode and final summary delivery.

## Success criteria

You can leave your desk, start or monitor a computer-use session from Telegram, receive screenshots and short recordings on your phone, and return later with a clear record of what happened.

## Sandbox fallback

In some Codex or shell harnesses, direct Node or shell requests to the Telegram Bot API fail even though the browser still has outbound access.

For that case, this repo now carries a reusable fallback:

```bash
npm run telegram:browser-photo -- \
  --chat-id <telegram-chat-id> \
  --photo /path/to/screenshot.png \
  --caption-file /tmp/caption.txt
```

It writes a local HTML page that:

- embeds the local image as base64
- reconstructs it into a browser `File`
- submits `sendPhoto` with a standard HTML form post

The form-post path is intentional. It was more reliable than `fetch(...)` for screenshot uploads from a local browser page.
