/**
 * Mystery data (F43) — takes over the S3 data card on its weekly day.
 *
 * On the mystery day the card shows `???` plus a fact that is fully scrambled at
 * 6am and resolves to plain text by 9pm. The fact is computed from the mirror's
 * own data history; which fact is picked is date-seeded and remembered for the
 * week in data/mystery.json so it does not re-roll on every refresh.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDateKey, zonedParts } from '../time.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MYSTERY_FILE = path.join(path.dirname(HERE), 'data', 'mystery.json');

// Sunday is the weekly mystery day. Overridable for demos/tests via MYSTERY_DAY
// (0=Sunday .. 6=Saturday).
const MYSTERY_DAY = (() => {
  const v = Number(process.env.MYSTERY_DAY);
  return Number.isInteger(v) && v >= 0 && v <= 6 ? v : 0;
})();

const SCRAMBLE_CHARS = '!@#$%^&*?<>/\\|=+~';

export function isMysteryDay(now = new Date(), timeZone = 'UTC') {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(now);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] === MYSTERY_DAY;
}

/** 0 at 6am, 1 at 9pm, clamped outside that window. */
export function revealRatio(now = new Date(), timeZone = 'UTC') {
  const h = zonedParts(now, timeZone).hour;
  const r = (h - 6) / (21 - 6);
  return Math.max(0, Math.min(1, r));
}

/** Deterministic per-position scramble (so a glyph does not flicker between renders). */
export function scramble(plain, reveal = 0) {
  const text = String(plain ?? '');
  const n = text.length;
  if (n === 0) return '';
  const revealed = Math.round(Math.max(0, Math.min(1, reveal)) * n);
  let out = '';
  for (let i = 0; i < n; i += 1) {
    const ch = text[i];
    if (ch === ' ' || ch === '·') {
      out += ch;
      continue;
    }
    if (i < revealed) {
      out += ch;
    } else {
      out += SCRAMBLE_CHARS[(i * 7 + n) % SCRAMBLE_CHARS.length];
    }
  }
  return out;
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Builds candidate facts from whatever data history is available. */
export function candidateFacts(deps = {}) {
  const facts = [];
  const spotify = deps.spotify;
  if (spotify?.configured && spotify?.track?.artists?.length) {
    facts.push({ type: 'artist', plain: `TOP ACT ${spotify.track.artists[0].toUpperCase()}` });
  }
  const calendar = deps.calendar;
  if (calendar?.today?.length) {
    facts.push({ type: 'busy', plain: `BUSIEST ${calendar.today.length} EVENTS` });
  }
  const aqi = deps.aqi;
  if (aqi?.aqi != null) {
    facts.push({ type: 'air', plain: `AIR INDEX ${aqi.aqi}` });
  }
  const notion = deps.notion;
  if (notion?.total != null && notion.total > 0) {
    facts.push({ type: 'backlog', plain: `BACKLOG ${notion.total} TASKS` });
  }
  const weather = deps.weather;
  if (weather?.today?.hi != null) {
    facts.push({ type: 'peak', plain: `PEAK ${weather.today.hi} DEG` });
  }
  return facts;
}

const FALLBACK_FACTS = [
  'SIGNAL FROM THE FUTURE',
  'A NUMBER ONLY YOU KNOW',
  'THE GLASS REMEMBERS',
];

/** Picks a fact for the week, remembering it in data/mystery.json. */
export function pickMysteryFact(deps, { now = new Date(), timeZone = 'UTC' } = {}) {
  const weekKey = localDateKey(now, timeZone);
  const candidates = candidateFacts(deps);
  let fact;
  if (candidates.length) {
    const idx = hashStr(weekKey) % candidates.length;
    fact = candidates[idx];
  } else {
    const idx = hashStr(weekKey) % FALLBACK_FACTS.length;
    fact = { type: 'sealed', plain: FALLBACK_FACTS[idx] };
  }

  try {
    const prev = JSON.parse(fs.readFileSync(MYSTERY_FILE, 'utf8'));
    if (prev?.weekKey === weekKey && prev?.plain) return prev;
  } catch {
    // first time this week
  }
  const record = { weekKey, type: fact.type, plain: fact.plain };
  try {
    fs.mkdirSync(path.dirname(MYSTERY_FILE), { recursive: true });
    fs.writeFileSync(MYSTERY_FILE, JSON.stringify(record, null, 2));
  } catch {
    // storage unavailable: still return the fact for this render
  }
  return record;
}

export function shapeMystery(deps, { now = new Date(), timeZone = 'UTC' } = {}) {
  if (!isMysteryDay(now, timeZone)) return null;
  const fact = pickMysteryFact(deps, { now, timeZone });
  const reveal = revealRatio(now, timeZone);
  return {
    glyphs: '???',
    plain: fact.plain,
    type: fact.type,
    scrambled: scramble(fact.plain, reveal),
    reveal,
  };
}

export const mysteryModule = {
  name: 'mystery',
  refreshMs: 30 * 60_000,
  staleAfterMs: 60 * 60_000,

  async fetch({ config, now, getModule }) {
    const deps = {
      weather: getModule?.('weather')?.data ?? null,
      calendar: getModule?.('calendar')?.data ?? null,
      aqi: getModule?.('aqi')?.data ?? null,
      notion: getModule?.('notion')?.data ?? null,
      spotify: getModule?.('spotify')?.data ?? null,
    };
    return shapeMystery(deps, { now, timeZone: config.timezone });
  },

  mock({ config, now, getModule }) {
    const deps = {
      weather: getModule?.('weather')?.data ?? null,
      calendar: getModule?.('calendar')?.data ?? null,
      aqi: getModule?.('aqi')?.data ?? null,
      notion: getModule?.('notion')?.data ?? null,
      spotify: getModule?.('spotify')?.data ?? null,
    };
    return shapeMystery(deps, { now, timeZone: config.timezone });
  },
};

export default mysteryModule;
