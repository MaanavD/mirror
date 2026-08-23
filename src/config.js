import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// dotenv is a declared dependency, but the app must not hard-fail without it:
// `node --test` and a bare `node server.js --help` should work pre-install, and
// under systemd the environment may already be populated.
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
} catch {
  // no dotenv: process.env is the only source
}

function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function num(name, fallback) {
  const raw = str(name);
  if (raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function flag(name, fallback = false) {
  const v = str(name);
  if (!v) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function list(name) {
  return str(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolvePath(name, fallback = '') {
  const v = str(name, fallback);
  return v ? path.resolve(ROOT, v) : '';
}

// "HH:MM" 24h -> {hour, minute} | null
export function parseClockTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

const MINUTE = 60_000;

export const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  dataDir: path.join(ROOT, 'data'),
  cacheFile: path.join(ROOT, 'data', 'cache.json'),

  port: num('PORT', 8390),
  host: '0.0.0.0',
  mock: flag('MOCK', false),

  lat: num('LAT', 47.6062),
  lon: num('LON', -122.3321),
  timezone: str('TIMEZONE', 'America/Los_Angeles'),

  homeLat: num('HOME_LAT', 47.6062),
  homeLon: num('HOME_LON', -122.3321),

  google: {
    clientSecretFile: resolvePath('GOOGLE_CLIENT_SECRET_FILE', 'secrets/client_secret.json'),
    tokenFile: resolvePath('GOOGLE_TOKEN_FILE', 'secrets/token.json'),
    calendarIds: list('GOOGLE_CALENDAR_IDS'),
  },

  notion: {
    token: str('NOTION_TOKEN'),
    databaseId: str('NOTION_DATABASE_ID', '881a49492c1344ccba79ec5cd0d6b939'),
    version: '2022-06-28',
  },

  ha: {
    url: str('HA_URL', 'http://100.97.0.104:8123').replace(/\/+$/, ''),
    tokenFile: resolvePath('HA_TOKEN_FILE', '/home/hermes/.hermes/ha_token'),
  },

  nanoleaf: {
    entities: ['light.shapes_a418', 'light.shapes_dedf'],
  },

  quote: {
    mode: /^(today|random)$/.test(str('ZENQUOTES_MODE', 'today')) ? str('ZENQUOTES_MODE', 'today') : 'today',
    rotateHour: 4,
  },

  spotify: {
    clientId: str('SPOTIFY_CLIENT_ID'),
    clientSecret: str('SPOTIFY_CLIENT_SECRET'),
    redirectUri: str('SPOTIFY_REDIRECT_URI'),
    refreshToken: str('SPOTIFY_REFRESH_TOKEN'),
  },

  display: {
    token: str('DISPLAY_TOKEN'),
    piAgentUrl: str('PI_AGENT_URL').replace(/\/+$/, ''),
    piAgentToken: str('PI_AGENT_TOKEN'),
    offTime: parseClockTime(str('DISPLAY_OFF_TIME', '00:30')) ?? { hour: 0, minute: 30 },
    onTime: parseClockTime(str('DISPLAY_ON_TIME')),
    // Kept under the 10s global ceiling: a POST /api/display/* must not hang.
    relayTimeoutMs: 5_000,
  },

  // Hard ceiling on every outbound request.
  fetchTimeoutMs: 10_000,

  refresh: {
    weatherMs: 15 * MINUTE,
    calendarMs: 5 * MINUTE,
    notionMs: 5 * MINUTE,
    leavebyMs: 10 * MINUTE,
    aqiMs: 30 * MINUTE,
    // How often staleness is re-evaluated (and the dim dot re-decided).
    tickMs: 30_000,
  },

  // A module goes stale once its last good data is older than this.
  staleAfter: {
    weatherMs: 45 * MINUTE,
    calendarMs: 20 * MINUTE,
    notionMs: 20 * MINUTE,
    leavebyMs: 15 * MINUTE,
    quoteMs: 36 * 60 * MINUTE,
    spotifyMs: 2 * MINUTE,
    aqiMs: 60 * MINUTE,
  },
};

export default config;
