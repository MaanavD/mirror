import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUrl,
  moonPhase,
  moonPhaseIndex,
  moonPhaseName,
  moonGlyph,
  shapeAstro,
  PHASE_NAMES,
  OPEN_METEO_DAILY,
} from '../src/modules/astro.js';

// ---------------------------------------------------------------------------
// Moon phase computation — known dates → known phases
// ---------------------------------------------------------------------------

test('new moon: 2000-01-06 18:14 UTC', () => {
  const phase = moonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14, 0)));
  assert.ok(phase < 1, `expected ~0, got ${phase}`);
  assert.equal(moonPhaseName(phase), 'NEW MOON');
});

test('full moon: 2000-01-21 05:00 UTC', () => {
  const phase = moonPhase(new Date(Date.UTC(2000, 0, 21, 5, 0, 0)));
  assert.ok(phase > 13.5 && phase < 16, `expected ~14.77, got ${phase}`);
  assert.equal(moonPhaseName(phase), 'FULL MOON');
});

test('first quarter: ~2000-01-13 23:00 UTC', () => {
  const phase = moonPhase(new Date(Date.UTC(2000, 0, 13, 23, 0, 0)));
  assert.ok(phase > 6 && phase < 9, `expected ~7.38, got ${phase}`);
  assert.equal(moonPhaseName(phase), 'FIRST QUARTER');
});

test('last quarter: ~2000-01-29 12:00 UTC', () => {
  const phase = moonPhase(new Date(Date.UTC(2000, 0, 29, 12, 0, 0)));
  assert.ok(phase > 21 && phase < 24, `expected ~22.15, got ${phase}`);
  assert.equal(moonPhaseName(phase), 'LAST QUARTER');
});

test('waxing crescent: ~2000-01-09 12:00 UTC', () => {
  const phase = moonPhase(new Date(Date.UTC(2000, 0, 9, 12, 0, 0)));
  assert.ok(phase > 2 && phase < 5, `expected ~3, got ${phase}`);
  assert.equal(moonPhaseName(phase), 'WAXING CRESCENT');
});

test('waxing gibbous: ~2000-01-18 00:00 UTC', () => {
  const phase = moonPhase(new Date(Date.UTC(2000, 0, 18, 0, 0, 0)));
  assert.ok(phase > 10 && phase < 13, `expected ~11.5, got ${phase}`);
  assert.equal(moonPhaseName(phase), 'WAXING GIBBOUS');
});

test('waning gibbous: ~2000-01-24 00:00 UTC', () => {
  const phase = moonPhase(new Date(Date.UTC(2000, 0, 24, 0, 0, 0)));
  assert.ok(phase > 16 && phase < 20, `expected ~17.5, got ${phase}`);
  assert.equal(moonPhaseName(phase), 'WANING GIBBOUS');
});

test('waning crescent: ~2000-01-03 12:00 UTC', () => {
  const phase = moonPhase(new Date(Date.UTC(2000, 0, 3, 12, 0, 0)));
  assert.ok(phase > 25 && phase < 29, `expected ~27, got ${phase}`);
  assert.equal(moonPhaseName(phase), 'WANING CRESCENT');
});

// ---------------------------------------------------------------------------
// Phase index
// ---------------------------------------------------------------------------

test('moonPhaseIndex returns 0-7', () => {
  for (let i = 0; i < 8; i++) {
    const phase = (i / 8) * 29.53058770576;
    assert.equal(moonPhaseIndex(phase), i, `index for phase ${i}/8`);
  }
});

test('moonPhaseIndex wraps for negative-ish values', () => {
  assert.equal(moonPhaseIndex(0), 0);
  assert.equal(moonPhaseIndex(29.53058770576), 0);
});

// ---------------------------------------------------------------------------
// Phase names
// ---------------------------------------------------------------------------

test('all 8 phase names are present', () => {
  assert.equal(PHASE_NAMES.length, 8);
  for (const name of PHASE_NAMES) {
    assert.equal(typeof name, 'string');
    assert.ok(name.length > 0);
  }
});

// ---------------------------------------------------------------------------
// SVG glyph
// ---------------------------------------------------------------------------

test('moonGlyph returns an SVG string', () => {
  const svg = moonGlyph(0);
  assert.ok(svg.startsWith('<svg'), 'should start with <svg');
  assert.ok(svg.includes('viewBox'), 'should have viewBox');
  assert.ok(svg.includes('aria-hidden="true"'), 'should be aria-hidden');
});

test('new moon glyph has only a circle (no terminator)', () => {
  const svg = moonGlyph(0);
  assert.ok(svg.includes('<circle'), 'should have circle');
  assert.ok(!svg.includes('<path'), 'new moon should not have a terminator path');
});

test('full moon glyph has only a circle (no terminator)', () => {
  const svg = moonGlyph(14.76529385288);
  assert.ok(svg.includes('<circle'), 'should have circle');
  assert.ok(!svg.includes('<path'), 'full moon should not have a terminator path');
});

test('first quarter glyph has a terminator path', () => {
  const svg = moonGlyph(7.38264692644);
  assert.ok(svg.includes('<path'), 'first quarter should have a terminator path');
  assert.ok(svg.includes('Q'), 'terminator should use quadratic Bézier');
});

// ---------------------------------------------------------------------------
// shapeAstro normalization
// ---------------------------------------------------------------------------

function makeRaw(overrides = {}) {
  return {
    daily: {
      time: ['2026-08-23', '2026-08-24'],
      sunrise: ['2026-08-23T06:14:00', '2026-08-24T06:15:00'],
      sunset: ['2026-08-23T20:22:00', '2026-08-24T20:21:00'],
      uv_index_max: [6.2, 5.8],
      daylight_duration: [48120, 47940],
      ...overrides,
    },
  };
}

test('shapeAstro normalizes a full payload', () => {
  const now = new Date(Date.UTC(2026, 7, 23, 18, 0, 0));
  const result = shapeAstro(makeRaw(), { now, timeZone: 'America/Los_Angeles' });
  assert.equal(typeof result.moonPhase, 'number');
  assert.equal(typeof result.moonPhaseName, 'string');
  assert.ok(result.svgMoon.startsWith('<svg'), 'svgMoon should be an SVG string');
  assert.equal(result.sunrise, '06:14');
  assert.equal(result.sunset, '20:22');
  assert.equal(result.uv, 6);
  assert.equal(typeof result.daylight, 'number');
});

test('shapeAstro handles missing daily fields gracefully', () => {
  const now = new Date(Date.UTC(2026, 7, 23, 18, 0, 0));
  const raw = { daily: { time: ['2026-08-23'] } };
  const result = shapeAstro(raw, { now, timeZone: 'UTC' });
  assert.equal(result.sunrise, null);
  assert.equal(result.sunset, null);
  assert.equal(result.uv, null);
  assert.equal(result.daylight, null);
  assert.equal(typeof result.moonPhase, 'number');
});

test('shapeAstro handles null payload', () => {
  const result = shapeAstro(null, { now: new Date(), timeZone: 'UTC' });
  assert.equal(result.sunrise, null);
  assert.equal(result.sunset, null);
  assert.equal(result.uv, null);
});

test('shapeAstro uses today key to pick the right day', () => {
  const now = new Date(Date.UTC(2026, 7, 24, 12, 0, 0));
  const raw = makeRaw({
    sunrise: ['2026-08-23T06:14:00', '2026-08-24T06:15:00'],
    sunset: ['2026-08-23T20:22:00', '2026-08-24T20:21:00'],
    uv_index_max: [6.2, 5.8],
  });
  const result = shapeAstro(raw, { now, timeZone: 'UTC' });
  assert.equal(result.sunrise, '06:15');
  assert.equal(result.sunset, '20:21');
  assert.equal(result.uv, 6);
});

test('shapeAstro rounds uv to nearest integer', () => {
  const now = new Date(Date.UTC(2026, 7, 23, 12, 0, 0));
  const raw = makeRaw({ uv_index_max: [2.4, 3.7] });
  const result = shapeAstro(raw, { now, timeZone: 'UTC' });
  assert.equal(result.uv, 2);
});

// ---------------------------------------------------------------------------
// buildUrl
// ---------------------------------------------------------------------------

test('buildUrl includes daily fields for sunrise/sunset/uv/daylight', () => {
  const url = buildUrl({ lat: 47.6, lon: -122.3, timezone: 'America/Los_Angeles' });
  assert.ok(url.startsWith(OPEN_METEO_DAILY));
  assert.ok(url.includes('daily=sunrise'));
  assert.ok(url.includes('sunset'));
  assert.ok(url.includes('uv_index_max'));
  assert.ok(url.includes('daylight_duration'));
  assert.ok(url.includes('latitude=47.6'));
  assert.ok(url.includes('longitude=-122.3'));
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

test('shapeAstro degrades on empty arrays in daily', () => {
  const raw = { daily: { time: [], sunrise: [], sunset: [], uv_index_max: [], daylight_duration: [] } };
  const result = shapeAstro(raw, { now: new Date(), timeZone: 'UTC' });
  assert.equal(result.sunrise, null);
  assert.equal(result.sunset, null);
  assert.equal(result.uv, null);
  assert.equal(result.daylight, null);
});

test('shapeAstro handles non-numeric uv gracefully', () => {
  const now = new Date(Date.UTC(2026, 7, 23, 12, 0, 0));
  const raw = makeRaw({ uv_index_max: ['NaN', null] });
  const result = shapeAstro(raw, { now, timeZone: 'UTC' });
  assert.equal(result.uv, null);
});
