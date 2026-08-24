import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeRainSparkline } from '../src/modules/weather.js';

function rawFrom(minutely, startISO) {
  const start = new Date(startISO);
  const time = [];
  const precipitation = [];
  minutely.forEach((mm, i) => {
    const t = new Date(start.getTime() + i * 15 * 60_000);
    time.push(t.toISOString().slice(0, 16));
    precipitation.push(mm);
  });
  return { minutely_15: { time, precipitation } };
}

const START = '2026-08-23T14:00:00.000Z';
const flat = (n) => Array.from({ length: 8 }, () => n);

test('no rain at all -> no sparkline', () => {
  assert.equal(shapeRainSparkline(rawFrom(flat(0), START), { now: new Date(START), timeZone: 'UTC' }), null);
});

test('rain -> 8 bars with at least one tall glyph', () => {
  const raw = rawFrom([0, 0, 1.4, 1.4, 0, 0, 0, 0], START);
  const out = shapeRainSparkline(raw, { now: new Date(START), timeZone: 'UTC' });
  assert.ok(out, 'expected a sparkline');
  assert.equal(out.bars.length, 8);
  assert.ok(/[▃▅▇]/.test(out.bars), `bars looked dry: ${out.bars}`);
});

test('rain beyond the 2h window is ignored', () => {
  // 9 slots; the 9th sits at exactly 120 min and falls outside the 8 buckets.
  const series = [...flat(0).slice(0, 8), 1.4];
  const out = shapeRainSparkline(rawFrom(series, START), { now: new Date(START), timeZone: 'UTC' });
  assert.equal(out, null);
});

test('malformed payload degrades to null', () => {
  assert.equal(shapeRainSparkline(null, { now: new Date(START), timeZone: 'UTC' }), null);
  assert.equal(shapeRainSparkline({}, { now: new Date(START), timeZone: 'UTC' }), null);
});
