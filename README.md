# discord-monitor

Watch a Discord channel for new messages without a bot or API token. Works by intercepting Discord's own WebSocket Gateway inside a headless Chromium browser using your existing Discord login.

Each new message is emitted as a JSON line on stdout — pipe it anywhere.

## How it works

Discord's web app connects to `gateway.discord.gg` via WebSocket and receives real-time events including `MESSAGE_CREATE`. This tool runs a headless Chromium browser with your saved session, intercepts those WebSocket frames (including zlib-compressed ones), and re-emits matching messages as NDJSON on stdout.

No bot token. No server admin access. No API rate limits.

## Requirements

- Node.js 18+
- `npm install` (installs Playwright)

## Setup

```bash
cd ~/discord-monitor
npm install
```

## First run — log in

The first time (or when your session expires), run with `--login` to open a visible browser:

```bash
node monitor.js CHANNEL_ID --login
```

1. Log into Discord in the browser window that opens
2. Navigate to the channel you want to watch
3. Press Enter in the terminal

Your session is saved to `~/.discord-monitor/session.json`. All future runs are headless.

## Usage

```bash
node monitor.js CHANNEL_ID [--webhook URL] [--login] [--headless]
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--login` | Open headed browser for (re-)login |
| `--headless` | Force headless mode (session must exist) |
| `--webhook URL` | POST each message as JSON to this URL |

**Environment variables:**

| Variable | Description |
|----------|-------------|
| `DISCORD_WEBHOOK_URL` | Default webhook URL (overridden by `--webhook`) |

## Examples

**Watch a channel and print messages:**
```bash
node monitor.js 1236838019072397373
```

**Extract just the message content with jq:**
```bash
node monitor.js 1236838019072397373 | jq -r '.content'
```

**Forward to a webhook:**
```bash
node monitor.js 1236838019072397373 --webhook https://hooks.example.com/notify
```

**Pipe to another CLI:**
```bash
node monitor.js 1236838019072397373 | my-processor
```

**Run in the background, log to file:**
```bash
node monitor.js 1236838019072397373 >> messages.jsonl 2>monitor.log &
```

**macOS notification on every message:**
```bash
node monitor.js 1236838019072397373 | while read line; do
  content=$(echo "$line" | jq -r '.content')
  author=$(echo "$line" | jq -r '.author')
  osascript -e "display notification \"$content\" with title \"Discord: $author\""
done
```

## Output format

Each message is one JSON line:

```json
{
  "id": "1418675076882235513",
  "channel_id": "1236838019072397373",
  "guild_id": "1236838019072397373",
  "author": "username",
  "author_id": "123456789",
  "content": "hello world",
  "timestamp": "2026-07-01T18:00:00.000Z",
  "attachments": ["https://cdn.discordapp.com/..."],
  "embeds": []
}
```

## Session management

Sessions are stored at `~/.discord-monitor/session.json` (Playwright storage state — cookies + localStorage). Discord sessions typically last weeks.

**Re-login when session expires:**
```bash
node monitor.js CHANNEL_ID --login
```

## Notes

- Watches one channel per process. Run multiple instances for multiple channels.
- Discord compresses Gateway frames with zlib after the initial handshake. The monitor handles both compressed and uncompressed frames.
- If the Gateway closes (Discord reconnects automatically every few hours), the browser reconnects and monitoring resumes without losing messages.
- Only `MESSAGE_CREATE` events are emitted. Edits, deletions, and reactions are ignored.
