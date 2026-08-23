import { zonedParts } from '../time.js';

export const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
export const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';
export const BUFFER_MIN = 5;
export const MIN_DRIVE_MIN = 10;
export const NOMINATIM_MIN_GAP_MS = 2_000;

const geoCache = new Map();
let lastNominatimMs = 0;

export function resetCache() {
  geoCache.clear();
  lastNominatimMs = 0;
}

export async function geocode(location, { nowMs = Date.now(), fetchFn = fetch } = {}) {
  const cached = geoCache.get(location);
  if (cached) return cached;

  const elapsed = nowMs - lastNominatimMs;
  if (elapsed < NOMINATIM_MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, NOMINATIM_MIN_GAP_MS - elapsed));
  }

  const url = `${NOMINATIM_BASE}?format=json&q=${encodeURIComponent(location)}`;
  lastNominatimMs = Date.now();

  const res = await fetchFn(url, {
    headers: { 'User-Agent': 'smart-mirror/1.0', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);

  const results = await res.json();
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`no results for "${location}"`);
  }

  const { lat, lon } = results[0];
  const coords = { lat: Number(lat), lon: Number(lon) };
  geoCache.set(location, coords);
  return coords;
}

export async function route(homeLat, homeLon, destLat, destLon, { fetchFn = fetch } = {}) {
  const url = `${OSRM_BASE}/${homeLon},${homeLat};${destLon},${destLat}?overview=false`;
  const res = await fetchFn(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);

  const data = await res.json();
  const leg = data?.routes?.[0]?.legs?.[0];
  if (!leg) throw new Error('no route');

  return {
    driveMin: Math.ceil(leg.duration / 60),
    driveMeters: Math.round(leg.distance),
  };
}

const pad = (n) => String(n).padStart(2, '0');

export function formatTime12h(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const suffix = p.hour < 12 ? 'AM' : 'PM';
  const h12 = p.hour % 12 || 12;
  return `${h12}:${pad(p.minute)} ${suffix}`;
}

export function findNextEventWithLocation(calendarData, now) {
  if (!calendarData?.today) return null;
  const nowMs = now.getTime();
  const candidates = calendarData.today.filter(
    (e) => !e.allDay && !e.past && e.startMs > nowMs && e.location,
  );
  candidates.sort((a, b) => a.startMs - b.startMs);
  return candidates[0] ?? null;
}

export const leavebyModule = {
  name: 'leaveby',
  refreshMs: 10 * 60_000,
  staleAfterMs: 15 * 60_000,

  async fetch({ config, now, getModule, log, fetchFn }) {
    try {
      const calendarData = getModule?.('calendar')?.data;
      const event = findNextEventWithLocation(calendarData, now);
      if (!event) return null;

      const opts = { nowMs: now.getTime() };
      if (fetchFn) opts.fetchFn = fetchFn;
      const { lat, lon } = await geocode(event.location, opts);

      const routeOpts = {};
      if (fetchFn) routeOpts.fetchFn = fetchFn;
      const { driveMin } = await route(
        config.homeLat,
        config.homeLon,
        lat,
        lon,
        routeOpts,
      );

      const eventStart = new Date(event.startMs);
      const leaveByMs = eventStart.getTime() - (driveMin + BUFFER_MIN) * 60_000;
      const leaveBy = new Date(leaveByMs);

      if (leaveBy.getTime() <= now.getTime()) return null;
      if (driveMin < MIN_DRIVE_MIN) return null;

      return {
        eventTitle: event.title,
        leaveBy: formatTime12h(leaveBy, config.timezone),
        driveMin,
      };
    } catch (err) {
      log.warn(`leaveby failed: ${err?.message ?? err}`);
      return null;
    }
  },

  mock({ now, config }) {
    const eventStartMs = now.getTime() + 90 * 60_000;
    const eventStart = new Date(eventStartMs);
    const leaveByMs = eventStartMs - (22 + BUFFER_MIN) * 60_000;
    return {
      eventTitle: 'design review — mirror',
      leaveBy: formatTime12h(new Date(leaveByMs), config.timezone),
      driveMin: 22,
    };
  },
};

export default leavebyModule;
