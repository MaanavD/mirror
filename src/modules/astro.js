import { fetchJson } from '../http.js';
import { localDateKey, zonedParts } from '../time.js';

export const OPEN_METEO_DAILY = 'https://api.open-meteo.com/v1/forecast';

const SYNODIC_MONTH = 29.53058770576;
const J2000 = Date.UTC(2000, 0, 6, 18, 14, 0);

export function moonPhase(date = new Date()) {
  const diff = date.getTime() - J2000;
  const days = diff / 86_400_000;
  return ((days % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH;
}

export const PHASE_NAMES = [
  'NEW MOON',
  'WAXING CRESCENT',
  'FIRST QUARTER',
  'WAXING GIBBOUS',
  'FULL MOON',
  'WANING GIBBOUS',
  'LAST QUARTER',
  'WANING CRESCENT',
];

export function moonPhaseName(phase) {
  const idx = Math.round(phase / (SYNODIC_MONTH / 8)) % 8;
  return PHASE_NAMES[idx];
}

export function moonPhaseIndex(phase) {
  return Math.round(phase / (SYNODIC_MONTH / 8)) % 8;
}

/**
 * Inline SVG line-work moon glyph. Circle outline + terminator path,
 * currentColor, no fills. 8 phases, no API needed.
 */
export function moonGlyph(phase) {
  const idx = moonPhaseIndex(phase);

  let inner = '';
  if (idx !== 0 && idx !== 4) {
    const frac = phase / SYNODIC_MONTH;
    const bulge = 0.15 * Math.sin(frac * Math.PI * 2);
    const cx = (bulge * 10).toFixed(1);
    const sweep = idx < 4 ? 0 : 1;
    inner = `<path d="M0 9A9 9 0 0 1 0-9Q${cx} 0 0 9Z" stroke-width="1.2" fill="none" stroke="currentColor"/>`;
  }

  return `<svg viewBox="-10 -10 20 20" width="12" height="12" aria-hidden="true"><circle r="9" stroke-width="1.2" fill="none" stroke="currentColor"/>${inner}</svg>`;
}

export function buildUrl({ lat, lon, timezone }) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: 'sunrise,sunset,uv_index_max,daylight_duration',
    timezone,
  });
  return `${OPEN_METEO_DAILY}?${params}`;
}

export function shapeAstro(raw, { now = new Date(), timeZone = 'UTC' } = {}) {
  const todayKey = localDateKey(now, timeZone);
  const dailyTimes = raw?.daily?.time ?? [];
  const dayIndex = Math.max(0, dailyTimes.indexOf(todayKey));

  const sunriseRaw = raw?.daily?.sunrise?.[dayIndex] ?? null;
  const sunsetRaw = raw?.daily?.sunset?.[dayIndex] ?? null;
  const uv = raw?.daily?.uv_index_max?.[dayIndex] ?? null;
  const daylight = raw?.daily?.daylight_duration?.[dayIndex] ?? null;

  const sunrise = sunriseRaw ? formatTime(sunriseRaw) : null;
  const sunset = sunsetRaw ? formatTime(sunsetRaw) : null;

  const phase = moonPhase(now);

  return {
    moonPhase: phase,
    moonPhaseName: moonPhaseName(phase),
    svgMoon: moonGlyph(phase),
    sunrise,
    sunset,
    uv: uv != null && Number.isFinite(Number(uv)) ? Math.round(Number(uv)) : null,
    daylight: daylight != null && Number.isFinite(Number(daylight)) ? Number(daylight) : null,
  };
}

function formatTime(isoString) {
  const m = /T(\d{2}):(\d{2})/.exec(isoString);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

export function mockRaw({ now = new Date(), timeZone = 'UTC' } = {}) {
  const todayKey = localDateKey(now, timeZone);
  const tomorrowKey = localDateKey(
    new Date(now.getTime() + 26 * 3_600_000),
    timeZone,
  );
  const p = zonedParts(now, timeZone);
  const sunriseHour = Math.max(5, Math.min(8, 12 - Math.abs(p.month - 6)));
  const sunsetHour = Math.max(16, Math.min(21, 18 + Math.abs(p.month - 6) / 2));

  return {
    daily: {
      time: [todayKey, tomorrowKey],
      sunrise: [`${todayKey}T${String(sunriseHour).padStart(2, '0')}:14:00`, `${tomorrowKey}T${String(sunriseHour).padStart(2, '0')}:15:00`],
      sunset: [`${todayKey}T${String(sunsetHour).padStart(2, '0')}:22:00`, `${tomorrowKey}T${String(sunsetHour).padStart(2, '0')}:21:00`],
      uv_index_max: [6.2, 5.8],
      daylight_duration: [48120, 47940],
    },
  };
}

export const astroModule = {
  name: 'astro',
  refreshMs: 30 * 60_000,
  staleAfterMs: 90 * 60_000,

  async fetch({ config, now }) {
    const raw = await fetchJson(buildUrl(config), { timeoutMs: config.fetchTimeoutMs });
    return shapeAstro(raw, { now, timeZone: config.timezone });
  },

  mock({ config, now }) {
    return shapeAstro(mockRaw({ now, timeZone: config.timezone }), {
      now,
      timeZone: config.timezone,
    });
  },
};

export default astroModule;
