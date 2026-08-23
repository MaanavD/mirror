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
    timezone,
  });
  return `${OPEN_METEO}?${params}`;
}

const round = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

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

  return {
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
