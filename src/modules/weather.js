import { fetchJson } from '../http.js';
import { localDateKey, parseFloatingLocal, startOfLocalDay, zonedParts } from '../time.js';
import { wmo } from './wmo.js';

export const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

const HOURS_SHOWN = 6;
const HOUR_STEP = 2;
const pad = (n) => String(n).padStart(2, '0');

export function buildUrl({ lat, lon, timezone }) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,weather_code',
    hourly: 'temperature_2m,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min,weather_code',
    minutely_15: 'precipitation',
    forecast_days: '2',
    timezone,
  });
  return `${OPEN_METEO}?${params}`;
}

const round = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

// F6 rain sparkline: minutely_15 precipitation over the next 2h, bucketed into
// 8 quarter-hour bars and rendered as block glyphs. Only painted when some
// bucket holds rain.
const SPARK_BUCKETS = 8;
const SPARK_BUCKET_MIN = 15;
const SPARK_LEVELS = ['▁', '▂', '▃', '▅', '▇'];

function sparkLevel(mm) {
  if (!Number.isFinite(mm) || mm <= 0) return 0;
  if (mm < 0.5) return 1;
  if (mm < 2) return 2;
  if (mm < 6) return 3;
  return 4;
}

/**
 * Open-Meteo minutely_15 precipitation -> 8-bucket sparkline for the next 2h.
 * Returns { bars, max } (bars is a string of block glyphs) or null when no rain
 * is expected in the window, so the UI keeps the weather block dry.
 */
export function shapeRainSparkline(raw, { now = new Date(), timeZone = 'UTC' } = {}) {
  const times = raw?.minutely_15?.time;
  const prec = raw?.minutely_15?.precipitation;
  if (!Array.isArray(times) || !Array.isArray(prec)) return null;

  const buckets = new Array(SPARK_BUCKETS).fill(0);
  for (let i = 0; i < times.length; i += 1) {
    const at = parseFloatingLocal(times[i], timeZone);
    if (!at) continue;
    const minutesFrom = (at.getTime() - now.getTime()) / 60_000;
    if (minutesFrom < -7.5) continue; // already well past
    const idx = Math.floor(minutesFrom / SPARK_BUCKET_MIN);
    if (idx < 0 || idx >= SPARK_BUCKETS) continue;
    const mm = Number(prec[i]);
    if (Number.isFinite(mm)) buckets[idx] += mm;
  }

  if (buckets.every((b) => b <= 0)) return null;
  const bars = buckets.map((b) => SPARK_LEVELS[sparkLevel(b)]).join('');
  return { bars, max: Number(Math.max(...buckets).toFixed(1)) };
}

/**
 * From Open-Meteo minutely_15 precipitation, find the first 15-minute slot
 * with >= `threshold` mm in the next `windowMin` minutes. Returns
 * { rainAtISO, mmFirstHour } (the ISO instant of that slot and the total mm
 * expected across the first hour from now) or null when no rain is coming.
 * Anything missing degrades to null — the mirror simply shows no chip.
 */
export function pickRain(
  raw,
  { now = new Date(), timeZone = 'UTC', threshold = 0.2, windowMin = 120 } = {},
) {
  const times = raw?.minutely_15?.time;
  const prec = raw?.minutely_15?.precipitation;
  if (!Array.isArray(times) || !Array.isArray(prec) || times.length === 0) return null;

  const hourEnd = now.getTime() + 60 * 60_000;
  let rainAt = null;
  let firstHour = 0;

  for (let i = 0; i < times.length; i += 1) {
    const at = parseFloatingLocal(times[i], timeZone);
    if (!at) continue;
    const minutesFrom = (at.getTime() - now.getTime()) / 60_000;
    const mm = Number(prec[i]);
    const finite = Number.isFinite(mm);

    if (at.getTime() >= now.getTime() && at.getTime() < hourEnd && finite) {
      firstHour += mm;
    }

    if (rainAt) continue;
    if (minutesFrom < -7.5) continue; // slot already well in the past
    if (minutesFrom > windowMin) break; // beyond the 2h window
    if (finite && mm >= threshold) rainAt = at;
  }

  if (!rainAt) return null;
  return { rainAtISO: rainAt.toISOString(), mmFirstHour: Number(firstHour.toFixed(1)) };
}

/**
 * Open-Meteo payload -> exactly what the mirror renders. Throws when the
 * payload has no usable current temperature so we never overwrite good cached
 * data with a shrug.
 */
export function shapeWeather(raw, { now = new Date(), timeZone = 'UTC' } = {}) {
  const temp = round(raw?.current?.temperature_2m);
  if (temp === null) throw new Error('weather payload missing current.temperature_2m');

  const code = raw?.current?.weather_code;
  const todayKey = localDateKey(now, timeZone);

  const dailyTimes = raw?.daily?.time ?? [];
  const dayIndex = Math.max(0, dailyTimes.indexOf(todayKey));
  const hi = round(raw?.daily?.temperature_2m_max?.[dayIndex]);
  const lo = round(raw?.daily?.temperature_2m_min?.[dayIndex]);

  // Tomorrow's outlook (additive field; everything above keeps its shape).
  const nextIndex = dayIndex + 1;
  const nextWmo = wmo(raw?.daily?.weather_code?.[nextIndex]);
  const tomorrow = {
    hi: round(raw?.daily?.temperature_2m_max?.[nextIndex]),
    lo: round(raw?.daily?.temperature_2m_min?.[nextIndex]),
    code: nextWmo.code,
    text: nextWmo.text,
    glyph: nextWmo.glyph,
  };

  const times = raw?.hourly?.time ?? [];
  const temps = raw?.hourly?.temperature_2m ?? [];
  const codes = raw?.hourly?.weather_code ?? [];
  const cutoff = now.getTime();

  const upcoming = [];
  for (let i = 0; i < times.length && upcoming.length < HOURS_SHOWN * HOUR_STEP; i += 1) {
    const at = parseFloatingLocal(times[i], timeZone);
    if (!at || at.getTime() + 3_600_000 <= cutoff) continue;
    upcoming.push({ at, temp: round(temps[i]), code: codes[i] });
  }

  const hours = [];
  for (let i = 0; i < upcoming.length && hours.length < HOURS_SHOWN; i += HOUR_STEP) {
    const slot = upcoming[i];
    const { hour } = zonedParts(slot.at, timeZone);
    const mapped = wmo(slot.code);
    hours.push({
      label: pad(hour),
      at: slot.at.toISOString(),
      temp: slot.temp,
      code: mapped.code,
      text: mapped.text,
      glyph: mapped.glyph,
    });
  }

  const current = wmo(code);
  return {
    unit: '°C',
    current: { temp, code: current.code, text: current.text, glyph: current.glyph },
    today: { hi, lo },
    tomorrow,
    hours,
    rain: pickRain(raw, { now, timeZone }),
    rain2h: shapeRainSparkline(raw, { now, timeZone }),
  };
}

/** A believable Seattle day: dry morning, rain moving in after lunch. */
export function mockRaw({ now = new Date(), timeZone = 'UTC' } = {}) {
  const dayStart = startOfLocalDay(now, timeZone);
  const time = [];
  const temperature = [];
  const weatherCode = [];

  for (let i = 0; i < 48; i += 1) {
    const at = new Date(dayStart.getTime() + i * 3_600_000);
    const p = zonedParts(at, timeZone);
    time.push(`${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:00`);

    const h = p.hour;
    const warmth = 11 + 6 * Math.sin(((h - 4) / 24) * Math.PI * 2);
    const raining = h >= 13 && h <= 20;
    temperature.push(Number((raining ? warmth - 1.5 : warmth).toFixed(1)));
    if (h < 9) weatherCode.push(h < 7 ? 45 : 1);
    else if (h < 13) weatherCode.push(2);
    else if (h < 16) weatherCode.push(61);
    else if (h < 19) weatherCode.push(63);
    else if (h <= 20) weatherCode.push(61);
    else weatherCode.push(3);
  }

  const today = localDateKey(now, timeZone);
  const tomorrow = localDateKey(new Date(dayStart.getTime() + 26 * 3_600_000), timeZone);
  const nowHour = zonedParts(now, timeZone).hour;

  // Quarter-hour rain so the F6 sparkline has something to draw in MOCK.
  const minutely = [];
  const minPrec = [];
  for (let i = 0; i < 8; i += 1) {
    const at = new Date(now.getTime() + i * 15 * 60_000);
    const p = zonedParts(at, timeZone);
    minutely.push(`${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`);
    minPrec.push(p.hour >= 14 && p.hour <= 16 ? 1.4 : 0.1);
  }

  return {
    minutely_15: { time: minutely, precipitation: minPrec },
    current: {
      temperature_2m: Number((11 + 6 * Math.sin(((nowHour - 4) / 24) * Math.PI * 2)).toFixed(1)),
      weather_code: nowHour >= 13 && nowHour <= 20 ? 63 : 2,
    },
    hourly: { time, temperature_2m: temperature, weather_code: weatherCode },
    daily: {
      time: [today, tomorrow],
      temperature_2m_max: [17.4, 19.1],
      temperature_2m_min: [11.2, 12.0],
      weather_code: [63, 80],
    },
  };
}

export const weatherModule = {
  name: 'weather',
  refreshMs: 15 * 60_000,
  staleAfterMs: 45 * 60_000,

  async fetch({ config, now }) {
    const raw = await fetchJson(buildUrl(config), { timeoutMs: config.fetchTimeoutMs });
    return shapeWeather(raw, { now, timeZone: config.timezone });
  },

  mock({ config, now }) {
    return shapeWeather(mockRaw({ now, timeZone: config.timezone }), {
      now,
      timeZone: config.timezone,
    });
  },
};

export default weatherModule;
