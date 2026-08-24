import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BUFFER_MIN,
  NOMINATIM_MIN_GAP_MS,
  leavebyModule,
  resetCache,
  truncateLocation,
} from '../src/modules/leaveby.js';

const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-08-24T16:00:00Z');

function event(id, title, start, location) {
  const startMs = new Date(start).getTime();
  return {
    id,
    title,
    allDay: false,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 30 * 60_000).toISOString(),
    startMs,
    endMs: startMs + 30 * 60_000,
    past: false,
    location,
  };
}

function agenda(events) {
  return { configured: true, timeZone: TZ, today: events, tomorrow: [] };
}

function nominatim(lat, lon) {
  return new Response(JSON.stringify([{ lat: String(lat), lon: String(lon) }]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function osrm(seconds) {
  return new Response(JSON.stringify({ routes: [{ legs: [{ duration: seconds, distance: 1000 }] }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function config(cacheDir) {
  return {
    homeLat: 47.6062,
    homeLon: -122.3321,
    timezone: TZ,
    dataDir: cacheDir,
  };
}

test('F9 selects among the next three located events and emits the compact label', async () => {
  resetCache();
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'leaveby-v2-'));
  const calls = [];
  const events = [
    event('e1', 'too far', '2026-08-24T17:00:00Z', 'SBP Fremont'),
    event('e2', 'first usable', '2026-08-24T18:30:00Z', 'Mission Bay'),
    event('e3', 'later usable', '2026-08-24T19:00:00Z', 'Dogpatch'),
    event('e4', 'must not be considered', '2026-08-24T20:00:00Z', 'Potrero Hill'),
  ];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('nominatim')) {
      const locations = {
        'SBP Fremont': [47.65, -122.35],
        'Mission Bay': [37.77, -122.39],
        Dogpatch: [37.76, -122.39],
      };
      const [lat, lon] = locations[new URL(url).searchParams.get('q')];
      return nominatim(lat, lon);
    }
    if (String(url).includes('router.project-osrm.org')) {
      const q = String(url);
      if (q.includes('37.77')) return osrm(22 * 60);
      if (q.includes('37.76')) return osrm(15 * 60);
      return osrm(120 * 60);
    }
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    const result = await leavebyModule.fetch({
      config: config(cacheDir),
      now: NOW,
      getModule: () => ({ data: agenda(events) }),
      log: { warn() {} },
      fetchFn: fakeFetch,
    });

    assert.equal(BUFFER_MIN, 8);
    assert.equal(result.eventTitle, 'first usable');
    assert.equal(result.location, 'Mission Bay');
    assert.equal(result.driveMin, 22);
    assert.equal(result.label, 'LEAVE 11:00A → MISSION BAY');
    assert.equal(calls.filter((call) => call.url.includes('nominatim')).length, 3);
    assert.equal(calls.filter((call) => call.url.includes('router.project-osrm.org')).length, 3);
    for (const call of calls.filter((entry) => entry.url.includes('nominatim'))) {
      assert.equal(call.init.headers['User-Agent'], 'mirror-dashboard/1.0 (personal)');
    }
    assert.equal(NOMINATIM_MIN_GAP_MS, 1_000);
    assert.equal(truncateLocation('abcdefghijklmnopqrs'), 'ABCDEFGHIJKLMNOPQR');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('F9 persists geocodes and does not call Nominatim again for cached locations', async () => {
  resetCache();
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'leaveby-v2-cache-'));
  const location = '123 Main Street';
  const target = event('cached', 'cached event', '2026-08-24T18:30:00Z', location);
  let nominatimCalls = 0;
  let routeCalls = 0;
  const fakeFetch = async (url) => {
    if (String(url).includes('nominatim')) {
      nominatimCalls += 1;
      return nominatim(47.61, -122.33);
    }
    routeCalls += 1;
    return osrm(22 * 60);
  };

  try {
    const args = {
      config: config(cacheDir),
      now: NOW,
      getModule: () => ({ data: agenda([target]) }),
      log: { warn() {} },
      fetchFn: fakeFetch,
    };
    const first = await leavebyModule.fetch(args);
    assert.equal(first.label, 'LEAVE 11:00A → 123 MAIN STREET');
    resetCache();
    const second = await leavebyModule.fetch(args);
    assert.equal(second.label, first.label);
    assert.equal(nominatimCalls, 1);
    assert.equal(routeCalls, 2);

    const cache = JSON.parse(await readFile(path.join(cacheDir, 'geocode-cache.json'), 'utf8'));
    assert.deepEqual(cache[location], { lat: 47.61, lon: -122.33 });
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('F9 keeps a configured fixed-place leave-by fallback when no located events exist', async () => {
  resetCache();
  const now = new Date('2026-08-24T16:00:00Z');
  const result = await leavebyModule.fetch({
    config: {
      ...config(null),
      leaveby: {
        fixedPlace: {
          eventTitle: 'legacy fixed place',
          location: 'Legacy Place',
          leaveByMs: now.getTime() + 30 * 60_000,
          driveMin: 22,
        },
      },
    },
    now,
    getModule: () => ({ data: agenda([]) }),
    log: { warn() {} },
    fetchFn: async () => { throw new Error('should not fetch'); },
  });
  assert.equal(result.label, 'LEAVE 9:30A → LEGACY PLACE');
});

test('F9 degrades to the existing hidden state when geocoding or routing fails', async () => {
  resetCache();
  const now = new Date('2026-08-24T16:00:00Z');
  const target = event('broken', 'broken event', '2026-08-24T18:30:00Z', 'Nowhere');
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'leaveby-v2-fail-'));
  try {
    const result = await leavebyModule.fetch({
      config: config(cacheDir),
      now,
      getModule: () => ({ data: agenda([target]) }),
      log: { warn() {} },
      fetchFn: async () => new Response('upstream down', { status: 503 }),
    });
    assert.equal(result, null);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
