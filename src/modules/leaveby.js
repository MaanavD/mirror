import fsp from 'node:fs/promises';
import path from 'node:path';
import { zonedParts } from '../time.js';

export const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
export const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';
export const BUFFER_MIN = 8;
// Preserve the existing module's behavior: very short trips do not earn a chip.
export const MIN_DRIVE_MIN = 10;
export const NOMINATIM_MIN_GAP_MS = 1_000;
export const LOCATION_MAX_CHARS = 18;

const geoCache = new Map();
const loadedCacheFiles = new Set();
let lastNominatimMs = 0;
let nominatimQueue = Promise.resolve();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function resetCache() {
  geoCache.clear();
  loadedCacheFiles.clear();
  lastNominatimMs = 0;
  nominatimQueue = Promise.resolve();
}

function cachePathFor(config) {
  if (config?.geocodeCacheFile) return path.resolve(config.geocodeCacheFile);
  if (config?.dataDir) return path.join(path.resolve(config.dataDir), 'geocode-cache.json');
  return null;
}

function usableCoords(value) {
  const lat = Number(value?.lat);
  const lon = Number(value?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

async function loadCache(cacheFile) {
  if (!cacheFile || loadedCacheFiles.has(cacheFile)) return;
  loadedCacheFiles.add(cacheFile);
  try {
    const parsed = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    for (const [location, value] of Object.entries(parsed ?? {})) {
      const coords = usableCoords(value);
      if (coords && location.trim()) geoCache.set(location, coords);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      // A corrupt cache must never take the dashboard down; the next lookup
      // will refresh that location and replace the file when possible.
    }
  }
}

async function persistCache(cacheFile) {
  if (!cacheFile) return;
  try {
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
    const values = Object.fromEntries(
      [...geoCache.entries()].filter(([, coords]) => usableCoords(coords)),
    );
    const temp = `${cacheFile}.${process.pid}.tmp`;
    await fsp.writeFile(temp, `${JSON.stringify(values, null, 2)}\n`, 'utf8');
    await fsp.rename(temp, cacheFile);
  } catch {
    // The in-memory result is still useful if disk persistence is unavailable.
  }
}

async function geocodeUncached(location, { cacheFile, fetchFn, sleepFn }) {
  const elapsed = Date.now() - lastNominatimMs;
  if (elapsed < NOMINATIM_MIN_GAP_MS) {
    await sleepFn(NOMINATIM_MIN_GAP_MS - elapsed);
  }
  lastNominatimMs = Date.now();

  const url = `${NOMINATIM_BASE}?format=json&q=${encodeURIComponent(location)}`;
  const res = await fetchFn(url, {
    headers: {
      'User-Agent': 'mirror-dashboard/1.0 (personal)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);

  const results = await res.json();
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`no results for "${location}"`);
  }

  const coords = usableCoords(results[0]);
  if (!coords) throw new Error(`invalid coordinates for "${location}"`);
  geoCache.set(location, coords);
  await persistCache(cacheFile);
  return coords;
}

export async function geocode(
  location,
  { cacheFile = null, nowMs = Date.now(), fetchFn = fetch, sleepFn = sleep } = {},
) {
  void nowMs;
  const key = String(location ?? '').trim();
  if (!key) throw new Error('empty location');

  await loadCache(cacheFile);
  const cached = geoCache.get(key);
  if (cached) return cached;

  // Serialise all uncached requests in this process. The timestamp is taken
  // immediately before each request, so Nominatim never sees >1 request/sec.
  const run = nominatimQueue.then(async () => {
    await loadCache(cacheFile);
    const hit = geoCache.get(key);
    if (hit) return hit;
    return geocodeUncached(key, { cacheFile, fetchFn, sleepFn });
  });
  nominatimQueue = run.catch(() => undefined);
  return run;
}

export async function route(homeLat, homeLon, destLat, destLon, { fetchFn = fetch } = {}) {
  const url = `${OSRM_BASE}/${homeLon},${homeLat};${destLon},${destLat}?overview=false`;
  const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);

  const data = await res.json();
  const leg = data?.routes?.[0]?.legs?.[0];
  if (!leg || !Number.isFinite(Number(leg.duration))) throw new Error('no route');

  return {
    driveMin: Math.ceil(Number(leg.duration) / 60),
    driveMeters: Math.round(Number(leg.distance) || 0),
  };
}

const pad = (n) => String(n).padStart(2, '0');

export function formatTime12h(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const suffix = p.hour < 12 ? 'AM' : 'PM';
  const h12 = p.hour % 12 || 12;
  return `${h12}:${pad(p.minute)} ${suffix}`;
}

export function formatCompactTime(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const suffix = p.hour < 12 ? 'A' : 'P';
  const h12 = p.hour % 12 || 12;
  return `${h12}:${pad(p.minute)}${suffix}`;
}

export function truncateLocation(location, maxChars = LOCATION_MAX_CHARS) {
  return String(location ?? '').trim().toUpperCase().slice(0, maxChars);
}

export function formatLeaveByLabel(leaveBy, location, timeZone) {
  return `LEAVE ${formatCompactTime(leaveBy, timeZone)} → ${truncateLocation(location)}`;
}

function eventStartMs(event) {
  const value = Number(event?.startMs ?? Date.parse(event?.start));
  return Number.isFinite(value) ? value : null;
}

export function findNextEventsWithLocation(calendarData, now, limit = 3) {
  if (!calendarData) return [];
  const nowMs = now.getTime();
  const candidates = [...(calendarData.today ?? []), ...(calendarData.tomorrow ?? [])]
    .filter((event) => {
      const startMs = eventStartMs(event);
      return !event?.allDay
        && !event?.past
        && startMs !== null
        && startMs > nowMs
        && Boolean(String(event.location ?? '').trim());
    })
    .sort((a, b) => eventStartMs(a) - eventStartMs(b));
  return candidates.slice(0, limit);
}

// Backwards-compatible helper retained for existing callers/tests.
export function findNextEventWithLocation(calendarData, now) {
  return findNextEventsWithLocation(calendarData, now, 1)[0] ?? null;
}

function fixedPlaceFallback(config, now) {
  const fallback = config?.leaveby?.fixedPlace
    ?? config?.leaveby?.fallback
    ?? config?.fixedPlaceLeaveBy;
  if (!fallback || typeof fallback !== 'object') return null;

  const leaveByMs = Number(fallback.leaveByMs);
  const driveMin = Number(fallback.driveMin);
  const leaveBy = Number.isFinite(leaveByMs)
    ? new Date(leaveByMs)
    : fallback.leaveBy
      ? new Date(`${now.toISOString().slice(0, 10)}T${fallback.leaveBy}`)
      : null;
  if (!leaveBy || Number.isNaN(leaveBy.getTime())) return null;
  if (leaveBy.getTime() <= now.getTime()) return null;

  return {
    eventTitle: String(fallback.eventTitle ?? fallback.title ?? ''),
    leaveBy: formatTime12h(leaveBy, config.timezone),
    leaveByMs: leaveBy.getTime(),
    driveMin: Number.isFinite(driveMin) ? driveMin : null,
    location: fallback.location ? String(fallback.location) : null,
    label: fallback.location
      ? formatLeaveByLabel(leaveBy, fallback.location, config.timezone)
      : null,
  };
}

function resultFor(event, driveMin, now, config) {
  const startMs = eventStartMs(event);
  const leaveByMs = startMs - (driveMin + BUFFER_MIN) * 60_000;
  if (leaveByMs <= now.getTime() || driveMin < MIN_DRIVE_MIN) return null;
  const leaveBy = new Date(leaveByMs);
  return {
    eventTitle: event.title,
    location: String(event.location).trim(),
    leaveBy: formatTime12h(leaveBy, config.timezone),
    leaveByMs,
    driveMin,
    label: formatLeaveByLabel(leaveBy, event.location, config.timezone),
  };
}

export const leavebyModule = {
  name: 'leaveby',
  refreshMs: 10 * 60_000,
  staleAfterMs: 15 * 60_000,

  async fetch({ config, now, getModule, log, fetchFn }) {
    const calendarData = getModule?.('calendar')?.data;
    const candidates = findNextEventsWithLocation(calendarData, now, 3);
    const cacheFile = cachePathFor(config);
    const requestFetch = fetchFn ?? fetch;
    const results = [];

    for (const event of candidates) {
      try {
        const coords = await geocode(event.location, { cacheFile, fetchFn: requestFetch });
        const { driveMin } = await route(
          config.homeLat,
          config.homeLon,
          coords.lat,
          coords.lon,
          { fetchFn: requestFetch },
        );
        const result = resultFor(event, driveMin, now, config);
        if (result) results.push(result);
      } catch (err) {
        log?.warn?.(`leaveby location failed (${event.location}): ${err?.message ?? err}`);
      }
    }

    if (results.length > 0) {
      results.sort((a, b) => a.leaveByMs - b.leaveByMs || a.eventTitle.localeCompare(b.eventTitle));
      return results[0];
    }

    // Preserve the pre-v2 fixed-place path when a deployment supplies one.
    return fixedPlaceFallback(config, now);
  },

  mock({ now, config }) {
    const eventStartMs = now.getTime() + 90 * 60_000;
    const leaveByMs = eventStartMs - (22 + BUFFER_MIN) * 60_000;
    const leaveBy = new Date(leaveByMs);
    return {
      eventTitle: 'design review — mirror',
      leaveBy: formatTime12h(leaveBy, config.timezone),
      leaveByMs,
      driveMin: 22,
      location: 'MIRROR HQ',
      label: formatLeaveByLabel(leaveBy, 'MIRROR HQ', config.timezone),
    };
  },
};

export default leavebyModule;
