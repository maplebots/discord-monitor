# discord-monitor Agent Guide

Runtime tool for watching a Discord channel via browser WebSocket interception.

## What this project does

Runs a headless Chromium browser with a saved Discord session, intercepts the Gateway WebSocket, and emits `MESSAGE_CREATE` events for a target channel as NDJSON on stdout. No bot token required.

## Entry point

```bash
node monitor.js CHANNEL_ID [--webhook URL] [--login] [--headless]
```

## Key files

| File | Purpose |
|------|---------|
| `monitor.js` | Main script — browser launch, WS interception, zlib decompression, stdout emit |
| `package.json` | Single dependency: `playwright` |
| `~/.discord-monitor/session.json` | Saved Playwright storage state (cookies + localStorage). Not in repo. |

## Runtime behaviour

- Navigates to `discord.com/channels/CHANNEL_ID/CHANNEL_ID` — Discord redirects to the correct guild URL
- Intercepts all WebSocket connections; filters to `gateway.discord.gg`
- Discord uses a shared zlib stream per connection — the inflater is stateful and must not be recreated per frame
- Text frames arrive before zlib kicks in; binary frames are zlib-compressed. Both are handled
- Only `op=0, t=MESSAGE_CREATE` events matching the target `channel_id` are emitted
- Gateway closes every few hours; Discord reconnects automatically — no message loss

## Session

Stored at `~/.discord-monitor/session.json` (Playwright `storageState` format).

To create or refresh: run with `--login`, log in via the headed browser, press Enter. Never commit this file — it contains live auth cookies.

## Before running any command

Check whether a session exists:
```bash
ls ~/.discord-monitor/session.json
```

If missing, the monitor must be run with `--login` in a headed environment before it can run headlessly.

## Testing

Start the monitor and send a message to the target channel in Discord. Expect one JSON line on stdout within ~1 second.

```bash
node monitor.js CHANNEL_ID --headless | head -1
```

## Adding features

- **New event types** (edits, reactions, deletions): add cases in `handleGatewayMessage` checking `data.t` (`MESSAGE_UPDATE`, `MESSAGE_REACTION_ADD`, `MESSAGE_DELETE`)
- **Multiple channels**: run multiple processes, one per channel, and merge stdout with `tee` or a wrapper script
- **macOS notifications**: pipe stdout through `osascript` (see README)
- **Persistent logging**: redirect stdout to a `.jsonl` file; stderr stays on the terminal

## What NOT to do

- Do not store or log cookie values or the session file contents in any artifact
- Do not use `--login` in headless/CI environments — it requires an interactive browser
- Do not parse the zlib stream with `zlib.inflate` (stateless) — Discord uses a shared context; use `zlib.createInflate()` (streaming) so decompression state is preserved across frames
