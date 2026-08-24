import path from 'node:path';
import express from 'express';
import config from './src/config.js';
import { DiskCache } from './src/cache.js';
import { DisplayController, requireDisplayToken } from './src/display.js';
import { createLogger } from './src/logger.js';
import modules from './src/modules/index.js';
import { createPresenceHandler } from './src/presence.js';
import { Scheduler } from './src/scheduler.js';
import { createEventStream } from './src/sse.js';
import { Store } from './src/store.js';

const log = createLogger('mirror');

const cache = new DiskCache(config.cacheFile);
cache.loadSync();

const store = new Store({ config, cache, modules, log: createLogger('store') });
const scheduler = new Scheduler({ store, config, log: createLogger('scheduler') });
const events = createEventStream({ store, log: createLogger('sse') });
const display = new DisplayController({ config, store, log: createLogger('display') });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.get('/api/state', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(store.snapshot());
});

app.get('/api/events', events.handler);

app.post('/api/display/on', requireDisplayToken(config), async (_req, res) => {
  res.json(await display.set(true, { source: 'api' }));
});

app.post('/api/display/off', requireDisplayToken(config), async (_req, res) => {
  res.json(await display.set(false, { source: 'api' }));
});

// Hermy.EXE dialogue: push a short output-only message to the mirror.
// Reuses the display token so nothing on the open tailnet can make the
// mirror talk. Body: { text, holdMs? }.
app.post('/api/say', requireDisplayToken(config), (req, res) => {
  const text = String(req.body?.text ?? '').trim().slice(0, 220);
  if (!text) return res.status(400).json({ error: 'text required' });
  const holdMs = Math.min(Math.max(Number(req.body?.holdMs) || 0, 0), 60_000);
  events.broadcast('say', { text, holdMs });
  res.json({ ok: true, clients: events.size });
});

// Presence ping: an mmWave sensor (or curl, for now) telling the mirror that
// someone is standing in front of it. The server keeps no presence state — it
// just relays the ping so the kiosk can run its animations at full intensity
// for a while. Same token as /api/say. Body (all optional):
// { present?, source?, holdMs? }.
app.post(
  '/api/presence',
  requireDisplayToken(config),
  createPresenceHandler({ events, log: createLogger('presence') }),
);

// Operational view; deliberately not under /api so the state blob stays exactly
// the shape the frontend contract promises.
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    mock: config.mock,
    uptimeSec: Math.round(process.uptime()),
    sseClients: events.size,
    display: { on: store.displayOn },
    modules: store.status(),
  });
});

// ---------------------------------------------------------------------------
// Frontend
// ---------------------------------------------------------------------------

app.get('/preview', (_req, res) => {
  res.sendFile(path.join(config.publicDir, 'preview.html'));
});

app.use(
  express.static(config.publicDir, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      // Kiosk reloads must pick up new markup; hashless assets can sit in cache
      // briefly but never long enough to matter across a deploy + restart.
      res.set('Cache-Control', filePath.endsWith('.html') ? 'no-store' : 'public, max-age=300');
    },
  }),
);

app.use((_req, res) => res.status(404).type('text/plain').send('not found\n'));

app.use((err, _req, res, _next) => {
  log.error(`unhandled: ${err?.message ?? err}`);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal error' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// A module blowing up must never take the process with it.
process.on('unhandledRejection', (err) => log.error(`unhandledRejection: ${err?.message ?? err}`));
process.on('uncaughtException', (err) => log.error(`uncaughtException: ${err?.stack ?? err}`));

const server = app.listen(config.port, config.host, () => {
  log.info(`listening on http://${config.host}:${config.port}${config.mock ? ' [MOCK]' : ''}`);
  log.info(`timezone ${config.timezone} · cache ${path.relative(config.root, config.cacheFile)}`);
  if (!config.mock) {
    if (config.google.calendarIds.length === 0) log.warn('GOOGLE_CALENDAR_IDS empty — calendar module idle');
    if (!config.notion.token) log.warn('NOTION_TOKEN empty — notion module is a stub (see SETUP_TODO.md)');
    if (!config.display.token) log.warn('DISPLAY_TOKEN empty — /api/display/* returns 503');
  }
});

// Fire the first refresh without blocking `listen`: the clock renders instantly
// and disk-cached data is already being served.
store.refreshAll('boot').then(() => log.info('initial refresh complete'));
scheduler.start();
display.startSchedule();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} — shutting down`);
  scheduler.stop();
  display.stop();
  events.closeAll();
  await cache.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

export { app, server, store };
