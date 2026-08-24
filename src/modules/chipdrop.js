/**
 * Chip drop (F22) — the daily chip in the S3 data card.
 *
 * One chip is picked deterministically from the date (so it is stable all day),
 * each binding a real stat pulled from the rest of the mirror's state. On the
 * mystery day the mystery module takes over S3 instead, so chipdrop stands down.
 */

import { localDateKey, zonedParts } from '../time.js';
import { isMysteryDay } from './mystery.js';
import { calendarModule } from './calendar.js';
import { weatherModule } from './weather.js';
import { aqiModule } from './aqi.js';
import { notionModule } from './notion.js';
import { spotifyModule } from './spotify.js';
import { countdownModule } from './countdown.js';

const pad = (n) => String(n).padStart(2, '0');

function fmtClock(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const suffix = p.hour < 12 ? 'AM' : 'PM';
  const h12 = p.hour % 12 || 12;
  return `${h12}:${pad(p.minute)} ${suffix}`;
}

function fmtDur(ms) {
  const total = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}H ${pad(m)}M` : `${m}M`;
}

// ---- stat readers (pure, deps = { weather, calendar, aqi, notion, spotify, countdown })

function longestBlock(calendar) {
  const events = (calendar?.today ?? []).filter((e) => !e.allDay && e.endMs > e.startMs);
  if (!events.length) return null;
  const longest = events.reduce((a, b) => (b.endMs - b.startMs > a.endMs - a.startMs ? b : a));
  return `BLOCK ${fmtDur(longest.endMs - longest.startMs)}`;
}

function nextEventInfo(calendar, timeZone) {
  const now = Date.now();
  const next = (calendar?.today ?? [])
    .filter((e) => !e.allDay && e.startMs > now)
    .sort((a, b) => a.startMs - b.startMs)[0];
  return next ? `${next.title} ${fmtClock(new Date(next.startMs), timeZone)}` : null;
}

function todayCount(calendar) {
  const n = calendar?.today?.length ?? 0;
  return n ? `${n} EVENTS` : null;
}

function openTasks(notion) {
  const n = notion?.total ?? 0;
  return n ? `${n} TASKS` : null;
}

function nowArtist(spotify) {
  const a = spotify?.track?.artists?.[0];
  return a ? a.toUpperCase() : null;
}

// ~20 chips. Some bind stats that may be unavailable (e.g. sleep / wind); those
// degrade to a dash rather than hiding the whole card.
export const CHIPS = [
  { id: 'longsword', name: 'LONG SWORD', icon: 'calendar', resolve: (d) => longestBlock(d.calendar) },
  { id: 'barrier', name: 'BARRIER', icon: 'air', resolve: (d) => (d.aqi ? `${d.aqi.aqi} AQI` : null) },
  { id: 'heatedge', name: 'HEAT EDGE', icon: 'fire', resolve: (d) => (d.weather?.current ? `${d.weather.current.temp}°` : null) },
  { id: 'coldsnap', name: 'COLD SNAP', icon: 'snow', resolve: (d) => (d.weather?.today?.lo != null ? `LO ${d.weather.today.lo}°` : null) },
  { id: 'skyeye', name: 'SKY EYE', icon: 'sun', resolve: (d) => (d.weather?.tomorrow?.hi != null ? `TMR ${d.weather.tomorrow.hi}°` : null) },
  { id: 'raindance', name: 'RAIN DANCE', icon: 'rain', resolve: (d) => (d.weather?.rain2h ? `${d.weather.rain2h.max}MM` : null) },
  { id: 'taskstack', name: 'TASK STACK', icon: 'chip', resolve: (d) => openTasks(d.notion) },
  { id: 'nextfoe', name: 'NEXT FOE', icon: 'calendar', resolve: (d) => nextEventInfo(d.calendar, d.timeZone) },
  { id: 'quickstep', name: 'QUICK STEP', icon: 'chip', resolve: (d) => todayCount(d.calendar) },
  { id: 'pulserate', name: 'PULSE RATE', icon: 'note', resolve: (d) => nowArtist(d.spotify) },
  { id: 'pureair', name: 'PURE AIR', icon: 'air', resolve: (d) => (d.aqi ? `${d.aqi.level.toUpperCase()}` : null) },
  { id: 'recover80', name: 'RECOVER 80', icon: 'sleep', resolve: () => null },
  { id: 'airshot', name: 'AIR SHOT', icon: 'wind', resolve: () => null },
  { id: 'windwall', name: 'WIND WALL', icon: 'wind', resolve: () => null },
  { id: 'ironwall', name: 'IRON WALL', icon: 'chip', resolve: (d) => openTasks(d.notion) },
  { id: 'deepdive', name: 'DEEP DIVE', icon: 'calendar', resolve: (d) => longestBlock(d.calendar) },
  { id: 'combobreaker', name: 'COMBO BREAK', icon: 'chip', resolve: (d) => todayCount(d.calendar) },
  { id: 'sunburst', name: 'SUN BURST', icon: 'sun', resolve: (d) => (d.weather?.today?.hi != null ? `HI ${d.weather.today.hi}°` : null) },
  { id: 'nightowl', name: 'NIGHT OWL', icon: 'moon', resolve: (d) => (d.calendar?.today?.length ? `NIGHT ${d.calendar.today.length}` : null) },
  { id: 'countdown', name: 'COUNT DOWN', icon: 'chip', resolve: (d) => (d.countdown?.items?.[0] ? `${d.countdown.items[0].label} ${d.countdown.items[0].days}D` : null) },
];

export function pickChip(deps, { now = new Date(), timeZone = 'UTC' } = {}) {
  const seed = localDateKey(now, timeZone);
  const idx = hashStr(seed) % CHIPS.length;
  const chip = CHIPS[idx];
  const richer = { ...deps, timeZone };
  const statLine = chip.resolve(richer) ?? '—';
  return { id: chip.id, name: chip.name, icon: chip.icon, statLine };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function collectDeps(getModule) {
  return {
    weather: getModule?.('weather')?.data ?? null,
    calendar: getModule?.('calendar')?.data ?? null,
    aqi: getModule?.('aqi')?.data ?? null,
    notion: getModule?.('notion')?.data ?? null,
    spotify: getModule?.('spotify')?.data ?? null,
    countdown: getModule?.('countdown')?.data ?? null,
  };
}

// Builds deps from the other modules' mocks so the card renders offline.
function mockDeps(config, now) {
  const tz = config?.timezone;
  const ctx = { config: { timezone: tz, countdown: { milestones: [] } }, now };
  return {
    weather: weatherModule.mock(ctx),
    calendar: calendarModule.mock(ctx),
    aqi: aqiModule.mock(ctx),
    notion: notionModule.mock(ctx),
    spotify: spotifyModule.mock(ctx),
    countdown: countdownModule.mock(ctx),
  };
}

export const chipdropModule = {
  name: 'chipdrop',
  refreshMs: 6 * 60_000,
  staleAfterMs: 12 * 60_000,

  async fetch({ config, now, getModule }) {
    if (isMysteryDay(now, config.timezone)) return null; // mystery owns S3 today
    return pickChip(collectDeps(getModule), { now, timeZone: config.timezone });
  },

  mock({ config, now }) {
    if (isMysteryDay(now, config.timezone)) return null;
    return pickChip(mockDeps(config, now), { now, timeZone: config.timezone });
  },
};

export default chipdropModule;
