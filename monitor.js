#!/usr/bin/env node
// discord-monitor: watch a Discord channel via browser WebSocket interception
//
// Usage:
//   node monitor.js CHANNEL_ID [--webhook URL] [--login]
//   node monitor.js CHANNEL_ID | jq '.content'
//   node monitor.js CHANNEL_ID | my-other-cli
//
// First run: opens a visible browser. Navigate to the channel yourself, then
//            press Enter. Session is saved for future headless runs.
//
// Flags:
//   --login     Force re-login (clears saved session)
//   --webhook U Forward each message to this URL as JSON POST
//   --headless  Force headless (requires existing session)

'use strict';
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const http  = require('http');
const readline = require('readline');

const SESSION_DIR  = path.join(process.env.HOME, '.discord-monitor');
const SESSION_FILE = path.join(SESSION_DIR, 'session.json');

// ── CLI args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const channelId  = args.find(a => /^\d{17,20}$/.test(a));
  const wiIdx      = args.indexOf('--webhook');
  const webhookUrl = wiIdx !== -1 ? args[wiIdx + 1] : (process.env.DISCORD_WEBHOOK_URL || '');
  return {
    channelId,
    webhookUrl,
    login:    args.includes('--login'),
    headless: args.includes('--headless'),
  };
}

// ── Webhook forward ─────────────────────────────────────────────────────────

function postWebhook(url, payload) {
  try {
    const body = Buffer.from(JSON.stringify(payload));
    const u    = new URL(url);
    const lib  = u.protocol === 'https:' ? https : http;
    const req  = lib.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': body.length },
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (_) {}
}

// ── Zlib stream decompressor (Discord uses a shared context per connection) ─

function makeInflater(onMessage) {
  const inf = zlib.createInflate();   // Discord uses zlib header (not raw deflate)
  let   buf = '';

  inf.on('data', chunk => {
    buf += chunk.toString('utf8');
    // Each Z_SYNC_FLUSH yields exactly one complete JSON value — try to parse.
    // If partial, keep accumulating (rare but possible if a frame is very large).
    try {
      const data = JSON.parse(buf);
      buf = '';
      onMessage(data);
    } catch (_) {
      // Not complete yet — accumulate more chunks
    }
  });

  inf.on('error', () => { /* ignore decompression errors on stale frames */ });

  return inf;
}

// ── Enter to continue ────────────────────────────────────────────────────────

function waitEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { channelId, webhookUrl, login, headless } = parseArgs();

  if (!channelId) {
    process.stderr.write(
      'Usage: node monitor.js CHANNEL_ID [--webhook URL] [--login]\n' +
      '  --login     Open browser for (re-)login\n' +
      '  --headless  Force headless (session must exist)\n'
    );
    process.exit(1);
  }

  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const hasSession = fs.existsSync(SESSION_FILE) && !login;
  const useHeaded  = !hasSession || login || !headless;

  process.stderr.write(
    `[discord-monitor] channel=${channelId} ` +
    `headed=${useHeaded} session=${hasSession ? 'exists' : 'none'}\n`
  );

  const browser = await chromium.launch({ headless: !useHeaded, args: ['--no-sandbox'] });

  const context = hasSession
    ? await browser.newContext({ storageState: SESSION_FILE })
    : await browser.newContext();

  const page = await context.newPage();

  // ── Handle each incoming Gateway message ───────────────────────────────────
  function handleGatewayMessage(data) {
    if (data.op !== 0 || !data.d) return;           // only Dispatch events
    if (data.t !== 'MESSAGE_CREATE') return;
    if (data.d.channel_id !== channelId) return;     // filter to target channel

    const d = data.d;
    const msg = {
      id:          d.id,
      channel_id:  d.channel_id,
      guild_id:    d.guild_id || null,
      author:      d.author?.username ?? 'unknown',
      author_id:   d.author?.id ?? null,
      content:     d.content,
      timestamp:   d.timestamp,
      attachments: (d.attachments || []).map(a => a.url),
      embeds:      d.embeds || [],
    };

    process.stdout.write(JSON.stringify(msg) + '\n');

    if (webhookUrl) postWebhook(webhookUrl, msg);
  }

  // ── Intercept all WebSocket connections ────────────────────────────────────
  page.on('websocket', ws => {
    // Discord opens multiple WSs; only the gateway matters
    if (!ws.url().includes('gateway.discord.gg')) return;

    process.stderr.write(`[discord-monitor] Gateway connected: ${ws.url().split('?')[0]}\n`);

    const inflater = makeInflater(handleGatewayMessage);

    ws.on('framereceived', frame => {
      if (typeof frame.payload === 'string') {
        // Uncompressed text frame (initial messages before zlib kicks in)
        try { handleGatewayMessage(JSON.parse(frame.payload)); } catch (_) {}
      } else {
        // Binary frame — zlib-stream compressed. Feed into shared inflater.
        // frame.payload is a Buffer in Playwright's Node layer.
        inflater.write(Buffer.isBuffer(frame.payload)
          ? frame.payload
          : Buffer.from(frame.payload, 'binary'));
      }
    });

    ws.on('close', () => {
      process.stderr.write('[discord-monitor] Gateway closed — Discord will reconnect automatically\n');
    });
  });

  // ── Navigate and authenticate ──────────────────────────────────────────────
  // Discord guild channels: URL is /channels/GUILD_ID/CHANNEL_ID
  // We don't always know the guild ID, but navigating to /channels/CHANNEL_ID
  // redirects to the right place once logged in. Fall back to bare discord.com
  // so Discord's SPA can route us correctly.
  const discordUrl = `https://discord.com/channels/@me`;
  await page.goto(discordUrl, { waitUntil: 'domcontentloaded' });

  if (!hasSession || login) {
    process.stderr.write('\n[discord-monitor] Please:\n');
    process.stderr.write('  1. Log into Discord in the browser window\n');
    process.stderr.write(`  2. Navigate to channel ${channelId}\n`);
    process.stderr.write('  3. Press Enter here when you can see the channel\n\n');
    await waitEnter('Press Enter when ready > ');
    await context.storageState({ path: SESSION_FILE });
    process.stderr.write(`[discord-monitor] Session saved → ${SESSION_FILE}\n`);
  } else {
    // Headless: navigate directly using channel ID as both guild+channel
    // (Discord redirects to the correct guild URL from the channel ID alone)
    await page.goto(`https://discord.com/channels/${channelId}/${channelId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
  }

  process.stderr.write(
    `[discord-monitor] Watching channel ${channelId}` +
    (webhookUrl ? ` → webhook` : '') +
    ` — Ctrl-C to stop\n`
  );

  // Keep alive
  await new Promise(() => {});
}

main().catch(err => {
  process.stderr.write(`[discord-monitor] Fatal: ${err.message}\n`);
  process.exit(1);
});
