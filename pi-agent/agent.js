#!/usr/bin/env node
/*
  mirror pi-agent — thin display power relay for the Raspberry Pi.

  Zero dependencies, single file. The mirror server POSTs here; this process
  does the one privileged-ish thing the server cannot do remotely: turn the
  panel's backlight off and on.

  Endpoints
    POST /display/on    Authorization: Bearer $PI_AGENT_TOKEN
    POST /display/off   Authorization: Bearer $PI_AGENT_TOKEN
    GET  /health        (no auth; no secrets in the response)

  Backends are tried in order and the first one that works is remembered:
    1. wlr-randr --output $PI_AGENT_OUTPUT --on|--off   (Wayland / labwc)
    2. vcgencmd display_power 1|0                       (Pi firmware)
    3. xset dpms force on|off                           (X11 / DPMS)

  Env
    PI_AGENT_TOKEN   required shared secret (must match the server's)
    PI_AGENT_PORT    default 8420
    PI_AGENT_OUTPUT  default HDMI-A-1
*/
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';

const PORT = Number(process.env.PI_AGENT_PORT || 8420);
const TOKEN = process.env.PI_AGENT_TOKEN || '';
const OUTPUT = process.env.PI_AGENT_OUTPUT || 'HDMI-A-1';
const CMD_TIMEOUT_MS = 8_000;

const BACKENDS = [
  { name: 'wlr-randr', cmd: 'wlr-randr', args: (on) => ['--output', OUTPUT, on ? '--on' : '--off'] },
  { name: 'vcgencmd', cmd: 'vcgencmd', args: (on) => ['display_power', on ? '1' : '0'] },
  { name: 'xset', cmd: 'xset', args: (on) => ['dpms', 'force', on ? 'on' : 'off'] },
];

// A system-launched agent has none of the session variables these tools need.
const ENV = {
  ...process.env,
  DISPLAY: process.env.DISPLAY || ':0',
  WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || 'wayland-1',
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`,
  PATH: `${process.env.PATH || ''}:/usr/bin:/usr/sbin:/opt/vc/bin`,
};

let preferred = null;

function log(message) {
  console.log(`${new Date().toISOString()} [pi-agent] ${message}`);
}

function run(backend, on) {
  return new Promise((resolve, reject) => {
    execFile(
      backend.cmd,
      backend.args(on),
      { timeout: CMD_TIMEOUT_MS, env: ENV },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${backend.name}: ${(stderr || err.message).trim()}`));
        else resolve(String(stdout).trim());
      },
    );
  });
}

/** Tries the remembered backend first, then everything in order. */
async function setDisplay(on) {
  const order = preferred
    ? [preferred, ...BACKENDS.filter((b) => b.name !== preferred.name)]
    : BACKENDS;
  const failures = [];

  for (const backend of order) {
    try {
      await run(backend, on);
      if (preferred?.name !== backend.name) {
        preferred = backend;
        log(`using backend "${backend.name}"`);
      }
      return { ok: true, backend: backend.name };
    } catch (err) {
      failures.push(err.message);
      if (preferred?.name === backend.name) preferred = null;
    }
  }
  return { ok: false, failures };
}

function authorized(req) {
  if (!TOKEN) return false;
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim());
  if (!m) return false;
  const a = crypto.createHash('sha256').update(TOKEN).digest();
  const b = crypto.createHash('sha256').update(m[1].trim()).digest();
  return crypto.timingSafeEqual(a, b);
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`${body}\n`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, `ok backend=${preferred?.name ?? 'undetermined'} output=${OUTPUT}`);
    return;
  }

  const on = url.pathname === '/display/on';
  const off = url.pathname === '/display/off';
  if (!on && !off) {
    send(res, 404, 'not found');
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, 'method not allowed');
    return;
  }
  if (!authorized(req)) {
    log(`rejected ${req.method} ${url.pathname} from ${req.socket.remoteAddress}`);
    send(res, 401, 'unauthorized');
    return;
  }

  const result = await setDisplay(on);
  if (result.ok) {
    log(`display ${on ? 'on' : 'off'} via ${result.backend}`);
    send(res, 200, `ok ${result.backend}`);
  } else {
    log(`display ${on ? 'on' : 'off'} FAILED: ${result.failures.join(' | ')}`);
    send(res, 502, `failed: ${result.failures.join(' | ')}`);
  }
});

if (!TOKEN) log('WARNING: PI_AGENT_TOKEN is empty — every request will be rejected');

server.listen(PORT, () => log(`listening on :${PORT} (output ${OUTPUT})`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`${signal} — exiting`);
    server.close(() => process.exit(0));
  });
}
