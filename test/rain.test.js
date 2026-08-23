import assert from 'node:assert/strict';
import test from 'node:test';
import { pickRain } from '../src/modules/weather.js';

// Build a minutely_15 payload from a list of mm values, starting at `startISO`
// (interpreted in UTC) with 15-minute slots.
function rawFrom(minutely, startISO) {
  const start = new Date(startISO);
  const time = [];
  const precipitation = [];
  minutely.forEach((mm, i) => {
    const t = new Date(start.getTime() + i * 15 * 60_000);
    time.push(t.toISOString().slice(0, 16)); // "YYYY-MM-DDTHH:MM" (UTC)
    precipitation.push(mm);
  });
  return { minutely_15: { time, precipitation } };
}

const START = '2026-08-23T14:00:00.000Z';
const flat = (n) => Array.from({ length: 16 }, () => n);

test('no rain at all -> no chip', () => {
  const raw = rawFrom(flat(0), START);
  assert.equal(pickRain(raw, { now: new Date(START), timeZone: 'UTC' }), null);
});

test('all-rain from now -> first slot flagged, full first hour summed', () => {
  const raw = rawFrom(flat(0.5), START);
  const got = pickRain(raw, { now: new Date(START), timeZone: 'UTC' });
  assert.ok(got, 'expected a rain slot');
  // First slot is the start instant.
  assert.equal(got.rainAtISO, START);
  // First hour = slots at 0/15/30/45 min = 4 * 0.5 = 2.0 mm.
  assert.equal(got.mmFirstHour, 2.0);
});

test('rain starting later in the 2h window is picked at its slot', () => {
  // 8 dry slots (120 min -> 16:00) then 0.5mm.
  const series = [...flat(0).slice(0, 8), ...flat(0.5).slice(0, 8)];
  const raw = rawFrom(series, START);
  const got = pickRain(raw, { now: new Date(START), timeZone: 'UTC' });
  assert.ok(got, 'expected rain within the window');
  assert.equal(got.rainAtISO, '2026-08-23T16:00:00.000Z');
  // First hour (0..45 min) stays dry.
  assert.equal(got.mmFirstHour, 0);
});

test('rain only beyond 120 min is ignored (dry chip)', () => {
  // 9 dry slots (135 min) then rain.
  const series = [...flat(0).slice(0, 9), 0.5];
  const raw = rawFrom(series, START);
  assert.equal(pickRain(raw, { now: new Date(START), timeZone: 'UTC' }), null);
});

test('threshold is inclusive: 0.2mm qualifies, 0.1mm does not', () => {
  const justUnder = rawFrom([0.1, 0.1, 0.1, 0.1], START);
  assert.equal(pickRain(justUnder, { now: new Date(START), timeZone: 'UTC' }), null);

  const atThreshold = rawFrom([0.2, 0.2, 0.2, 0.2], START);
  const got = pickRain(atThreshold, { now: new Date(START), timeZone: 'UTC' });
  assert.ok(got);
  assert.equal(got.rainAtISO, START);
});

test('first-hour total is bounded to the first 60 minutes', () => {
  // Dry for 45 min, then 1.0mm at 45 min and 1.0mm at 60 min.
  const series = [0, 0, 0, 1.0, 1.0, 0, 0, 0];
  const raw = rawFrom(series, START);
  const got = pickRain(raw, { now: new Date(START), timeZone: 'UTC' });
  assert.ok(got);
  assert.equal(got.rainAtISO, '2026-08-23T14:45:00.000Z');
  // Only the slot at 45 min is inside the first hour (60 is not).
  assert.equal(got.mmFirstHour, 1.0);
});

test('missing / malformed payload degrades to no chip', () => {
  assert.equal(pickRain(null, { now: new Date(START), timeZone: 'UTC' }), null);
  assert.equal(pickRain({}, { now: new Date(START), timeZone: 'UTC' }), null);
  assert.equal(
    pickRain({ minutely_15: {} }, { now: new Date(START), timeZone: 'UTC' }),
    null,
  );
  assert.equal(
    pickRain({ minutely_15: { time: [], precipitation: [] } }, { now: new Date(START), timeZone: 'UTC' }),
    null,
  );
});

test('respects a custom threshold and window', () => {
  // Rain at 30 min (index 2) of 0.5mm; window cut to 15 min so it is excluded.
  const raw = rawFrom([0, 0, 0.5, 0], START);
  assert.equal(
    pickRain(raw, { now: new Date(START), timeZone: 'UTC', threshold: 0.2, windowMin: 15 }),
    null,
  );
  // With a 60-min window it is found.
  const got = pickRain(raw, { now: new Date(START), timeZone: 'UTC', threshold: 0.2, windowMin: 60 });
  assert.ok(got);
  assert.equal(got.rainAtISO, '2026-08-23T14:30:00.000Z');
});
