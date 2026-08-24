import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUFFER_MIN,
  MIN_DRIVE_MIN,
  NOMINATIM_BASE,
  OSRM_BASE,
  findNextEventWithLocation,
  formatTime12h,
  geocode,
  leavebyModule,
  resetCache,
  route,
} from '../src/modules/leaveby.js';

function makeEvent(overrides) {
  const now = Date.now();
  const startMs = now + 90 * 60_000;
  return {
    id: 'e1',
    title: 'design review',
    allDay: false,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 60 * 60_000).toISOString(),
    startMs,
    endMs: startMs + 60 * 60_000,
    timeLabel: '2:00pm',
    past: false,
    calendarId: 'primary',
    location: '123 Main St, Seattle',
    ...overrides,
  };
}

function makeCalendarData(events) {
  return {
    configured: true,
    calendars: 1,
    timeZone: 'America/Los_Angeles',
    today: events,
    todayMore: 0,
    tomorrow: [],
    tomorrowMore: 0,
  };
}

function nominatimResponse(lat, lon) {
  return JSON.stringify([{ lat: String(lat), lon: String(lon), display_name: 'test' }]);
}

function osrmResponse(durationSec, distanceM) {
  return JSON.stringify({ routes: [{ legs: [{ duration: durationSec, distance: distanceM }] }] });
}

// ── findNextEventWithLocation ───────────────────────────────────────────

test('findNextEventWithLocation picks the earliest non-past event with location', () => {
  const now = new Date();
  const soon = now.getTime() + 30 * 60_000;
  const later = now.getTime() + 120 * 60_000;
  const events = [
    makeEvent({ startMs: soon, start: new Date(soon).toISOString(), endMs: soon + 3_600_000, past: false, location: 'A' }),
    makeEvent({ startMs: later, start: new Date(later).toISOString(), endMs: later + 3_600_000, past: false, location: 'B' }),
  ];
  const result = findNextEventWithLocation(makeCalendarData(events), now);
  assert.equal(result.location, 'A');
});

test('findNextEventWithLocation skips all-day events', () => {
  const now = new Date();
  const soon = now.getTime() + 30 * 60_000;
  const events = [
    makeEvent({ startMs: soon, start: new Date(soon).toISOString(), endMs: soon + 3_600_000, allDay: true, location: 'Airport' }),
    makeEvent({ startMs: soon + 60 * 60_000, start: new Date(soon + 60 * 60_000).toISOString(), endMs: soon + 2 * 3_600_000, past: false, location: 'Office' }),
  ];
  const result = findNextEventWithLocation(makeCalendarData(events), now);
  assert.equal(result.location, 'Office');
});

test('findNextEventWithLocation skips events without location', () => {
  const now = new Date();
  const soon = now.getTime() + 30 * 60_000;
  const events = [
    makeEvent({ startMs: soon, start: new Date(soon).toISOString(), endMs: soon + 3_600_000, location: null }),
    makeEvent({ startMs: soon + 60 * 60_000, start: new Date(soon + 60 * 60_000).toISOString(), endMs: soon + 2 * 3_600_000, location: '' }),
  ];
  const result = findNextEventWithLocation(makeCalendarData(events), now);
  assert.equal(result, null);
});

test('findNextEventWithLocation returns null for empty calendar', () => {
  assert.equal(findNextEventWithLocation(null, new Date()), null);
  assert.equal(findNextEventWithLocation({ today: [] }, new Date()), null);
});

test('findNextEventWithLocation skips past events', () => {
  const now = new Date();
  const past = now.getTime() - 30 * 60_000;
  const events = [
    makeEvent({ startMs: past, start: new Date(past).toISOString(), endMs: past + 3_600_000, past: true, location: 'Old' }),
  ];
  const result = findNextEventWithLocation(makeCalendarData(events), now);
  assert.equal(result, null);
});

// ── formatTime12h ──────────────────────────────────────────────────────

test('formatTime12h formats in 12h with AM/PM', () => {
  const date = new Date('2026-08-23T14:35:00-07:00');
  assert.equal(formatTime12h(date, 'America/Los_Angeles'), '2:35 PM');
});

test('formatTime12h formats midnight as 12:00 AM', () => {
  const date = new Date('2026-08-23T00:00:00-07:00');
  assert.equal(formatTime12h(date, 'America/Los_Angeles'), '12:00 AM');
});

test('formatTime12h formats noon as 12:00 PM', () => {
  const date = new Date('2026-08-23T12:00:00-07:00');
  assert.equal(formatTime12h(date, 'America/Los_Angeles'), '12:00 PM');
});

// ── geocode normalization ──────────────────────────────────────────────

test('geocode normalizes Nominatim response and caches', async () => {
  resetCache();
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return new Response(nominatimResponse(47.61, -122.33), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const r1 = await geocode('123 Main St', { nowMs: Date.now() + 3_000, fetchFn: fakeFetch });
  assert.equal(r1.lat, 47.61);
  assert.equal(r1.lon, -122.33);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].headers['User-Agent'] === 'mirror-dashboard/1.0 (personal)');

  // Second call should hit cache
  const r2 = await geocode('123 Main St', { nowMs: Date.now() + 3_000, fetchFn: fakeFetch });
  assert.deepEqual(r1, r2);
  assert.equal(calls.length, 1, 'should not fetch again');
});

test('geocode throws on empty results', async () => {
  resetCache();
  const fakeFetch = async () => new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(() => geocode('nope', { nowMs: Date.now() + 3_000, fetchFn: fakeFetch }), /no results/);
});

test('geocode throws on HTTP error', async () => {
  resetCache();
  const fakeFetch = async () => new Response('error', { status: 503 });
  await assert.rejects(() => geocode('fail', { nowMs: Date.now() + 3_000, fetchFn: fakeFetch }), /503/);
});

// ── route normalization ────────────────────────────────────────────────

test('route normalizes OSRM response to driveMin and driveMeters', async () => {
  const fakeFetch = async () => new Response(osrmResponse(1320, 12500), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const result = await route(47.6062, -122.3321, 47.61, -122.33, { fetchFn: fakeFetch });
  assert.equal(result.driveMin, 22);
  assert.equal(result.driveMeters, 12500);
});

test('route throws when no route found', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ routes: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(() => route(0, 0, 1, 1, { fetchFn: fakeFetch }), /no route/);
});

test('route throws on HTTP error', async () => {
  const fakeFetch = async () => new Response('error', { status: 500 });
  await assert.rejects(() => route(0, 0, 1, 1, { fetchFn: fakeFetch }), /500/);
});

// ── leavebyModule.fetch ────────────────────────────────────────────────

test('fetch returns leaveBy and driveMin for a valid event', async () => {
  resetCache();
  const now = new Date('2026-08-23T12:00:00-07:00');
  const eventStartMs = now.getTime() + 90 * 60_000;
  const event = makeEvent({
    startMs: eventStartMs,
    start: new Date(eventStartMs).toISOString(),
    endMs: eventStartMs + 3_600_000,
  });

  let fetchCount = 0;
  const fakeFetch = async (url) => {
    fetchCount++;
    if (String(url).includes('nominatim')) {
      return new Response(nominatimResponse(47.61, -122.33), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(osrmResponse(1320, 12500), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await leavebyModule.fetch({
    config: { homeLat: 47.6062, homeLon: -122.3321, timezone: 'America/Los_Angeles' },
    now,
    getModule: (name) => name === 'calendar' ? { data: makeCalendarData([event]) } : null,
    log: { warn() {}, debug() {} },
    fetchFn: fakeFetch,
  });

  assert.equal(result.eventTitle, 'design review');
  assert.equal(result.driveMin, 22);
  assert.ok(typeof result.leaveBy === 'string');
  assert.ok(result.leaveBy.includes('PM'));
  assert.equal(fetchCount, 2, 'should call both nominatim and osrm');
});

test('fetch returns null when no event with location', async () => {
  const now = new Date();
  const result = await leavebyModule.fetch({
    config: { homeLat: 47.6062, homeLon: -122.3321, timezone: 'America/Los_Angeles' },
    now,
    getModule: () => ({ data: makeCalendarData([]) }),
    log: { warn() {}, debug() {} },
    fetchFn: async () => { throw new Error('should not be called'); },
  });
  assert.equal(result, null);
});

test('fetch returns null when no calendar data', async () => {
  const now = new Date();
  const result = await leavebyModule.fetch({
    config: { homeLat: 47.6062, homeLon: -122.3321, timezone: 'America/Los_Angeles' },
    now,
    getModule: () => null,
    log: { warn() {}, debug() {} },
    fetchFn: async () => { throw new Error('should not be called'); },
  });
  assert.equal(result, null);
});

test('fetch returns null when leaveBy is in the past', async () => {
  resetCache();
  const now = new Date('2026-08-23T12:00:00-07:00');
  // Event is in 5 minutes but drive is 22 min — leaveBy would be in the past
  const eventStartMs = now.getTime() + 5 * 60_000;
  const event = makeEvent({
    startMs: eventStartMs,
    start: new Date(eventStartMs).toISOString(),
    endMs: eventStartMs + 3_600_000,
  });

  const fakeFetch = async (url) => {
    if (String(url).includes('nominatim')) {
      return new Response(nominatimResponse(47.61, -122.33), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(osrmResponse(1320, 12500), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await leavebyModule.fetch({
    config: { homeLat: 47.6062, homeLon: -122.3321, timezone: 'America/Los_Angeles' },
    now,
    getModule: (name) => name === 'calendar' ? { data: makeCalendarData([event]) } : null,
    log: { warn() {}, debug() {} },
    fetchFn: fakeFetch,
  });
  assert.equal(result, null);
});

test('fetch returns null when drive < MIN_DRIVE_MIN', async () => {
  resetCache();
  const now = new Date('2026-08-23T12:00:00-07:00');
  const eventStartMs = now.getTime() + 90 * 60_000;
  const event = makeEvent({
    startMs: eventStartMs,
    start: new Date(eventStartMs).toISOString(),
    endMs: eventStartMs + 3_600_000,
  });

  const fakeFetch = async (url) => {
    if (String(url).includes('nominatim')) {
      return new Response(nominatimResponse(47.61, -122.33), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // 5 min drive — below MIN_DRIVE_MIN
    return new Response(osrmResponse(300, 2000), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await leavebyModule.fetch({
    config: { homeLat: 47.6062, homeLon: -122.3321, timezone: 'America/Los_Angeles' },
    now,
    getModule: (name) => name === 'calendar' ? { data: makeCalendarData([event]) } : null,
    log: { warn() {}, debug() {} },
    fetchFn: fakeFetch,
  });
  assert.equal(result, null);
});

test('fetch degrades silently on geocode failure', async () => {
  resetCache();
  const now = new Date('2026-08-23T12:00:00-07:00');
  const event = makeEvent({
    startMs: now.getTime() + 90 * 60_000,
    start: new Date(now.getTime() + 90 * 60_000).toISOString(),
    endMs: now.getTime() + 150 * 60_000,
  });

  const fakeFetch = async () => { throw new Error('network down'); };

  const result = await leavebyModule.fetch({
    config: { homeLat: 47.6062, homeLon: -122.3321, timezone: 'America/Los_Angeles' },
    now,
    getModule: (name) => name === 'calendar' ? { data: makeCalendarData([event]) } : null,
    log: { warn() {}, debug() {} },
    fetchFn: fakeFetch,
  });
  assert.equal(result, null);
});

test('fetch degrades silently on route failure', async () => {
  resetCache();
  const now = new Date('2026-08-23T12:00:00-07:00');
  const event = makeEvent({
    startMs: now.getTime() + 90 * 60_000,
    start: new Date(now.getTime() + 90 * 60_000).toISOString(),
    endMs: now.getTime() + 150 * 60_000,
  });

  const fakeFetch = async (url) => {
    if (String(url).includes('nominatim')) {
      return new Response(nominatimResponse(47.61, -122.33), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('OSRM down');
  };

  const result = await leavebyModule.fetch({
    config: { homeLat: 47.6062, homeLon: -122.3321, timezone: 'America/Los_Angeles' },
    now,
    getModule: (name) => name === 'calendar' ? { data: makeCalendarData([event]) } : null,
    log: { warn() {}, debug() {} },
    fetchFn: fakeFetch,
  });
  assert.equal(result, null);
});

test('fetch returns null on Nominatim HTTP error', async () => {
  resetCache();
  const now = new Date('2026-08-23T12:00:00-07:00');
  const event = makeEvent({
    startMs: now.getTime() + 90 * 60_000,
    start: new Date(now.getTime() + 90 * 60_000).toISOString(),
    endMs: now.getTime() + 150 * 60_000,
  });

  const fakeFetch = async () => new Response('error', { status: 429 });

  const result = await leavebyModule.fetch({
    config: { homeLat: 47.6062, homeLon: -122.3321, timezone: 'America/Los_Angeles' },
    now,
    getModule: (name) => name === 'calendar' ? { data: makeCalendarData([event]) } : null,
    log: { warn() {}, debug() {} },
    fetchFn: fakeFetch,
  });
  assert.equal(result, null);
});

// ── mock ────────────────────────────────────────────────────────────────

test('mock returns a realistic shape', () => {
  const now = new Date('2026-08-23T12:00:00-07:00');
  const result = leavebyModule.mock({ now, config: { timezone: 'America/Los_Angeles' } });
  assert.equal(result.eventTitle, 'design review — mirror');
  assert.equal(result.driveMin, 22);
  assert.ok(typeof result.leaveBy === 'string');
  assert.ok(result.leaveBy.length > 0);
});

// ── module shape ────────────────────────────────────────────────────────

test('module has required properties', () => {
  assert.equal(leavebyModule.name, 'leaveby');
  assert.ok(Number.isFinite(leavebyModule.refreshMs));
  assert.ok(Number.isFinite(leavebyModule.staleAfterMs));
  assert.equal(typeof leavebyModule.fetch, 'function');
  assert.equal(typeof leavebyModule.mock, 'function');
});
