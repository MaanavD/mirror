import test from 'node:test';
import assert from 'node:assert/strict';
import { pickChip, CHIPS } from '../src/modules/chipdrop.js';

const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-08-24T16:00:00Z');

test('all chips bind real data (no permanent-dash chips)', () => {
  assert.ok(CHIPS.length >= 15, `only ${CHIPS.length} chips defined`);
  // A chip that resolves null on EMPTY deps is fine (data may be down), but
  // every chip must be able to produce a stat from plausible full deps.
  const soon = Date.now() + 3_600_000;
  const full = {
    calendar: {
      today: [
        { startMs: soon, endMs: soon + 5_700_000, title: 'X', allDay: false },
        { startMs: soon + 9_300_000, endMs: soon + 12_900_000, title: 'Y', allDay: false },
      ],
    },
    aqi: { aqi: 21, level: 'good' },
    weather: { current: { temp: 68 }, today: { hi: 71, lo: 55 }, tomorrow: { hi: 70 }, rain2h: { max: 2 } },
    notion: { total: 3 },
    spotify: { track: { artists: ['Daft Punk'] } },
    countdown: { items: [{ label: 'TORONTO', days: 3 }] },
    timeZone: 'America/Los_Angeles',
  };
  for (const chip of CHIPS) {
    assert.notEqual(chip.resolve(full), null, `${chip.id} resolves null even with full deps`);
  }
});

test('pick is date-seeded and stable through the day', () => {
  const deps = {
    calendar: { today: [{ title: 'a', startMs: 0, endMs: 95 * 60_000 }] },
    aqi: { aqi: 42 },
    weather: { current: { temp: 20 }, today: { hi: 24, lo: 12 }, tomorrow: { hi: 22 }, rain2h: { max: 1 } },
    notion: { total: 3 },
    spotify: { track: { artists: ['X'] } },
    countdown: { items: [{ label: 'SF', days: 8 }] },
  };
  const a = pickChip(deps, { now: NOW, timeZone: TZ });
  const b = pickChip(deps, { now: NOW, timeZone: TZ });
  assert.deepEqual(a, b);
  assert.ok(a.name && a.statLine);
});

test('different day can pick a different chip', () => {
  const deps = {};
  const a = pickChip(deps, { now: NOW, timeZone: TZ });
  const later = new Date('2026-08-25T16:00:00Z');
  const b = pickChip(deps, { now: later, timeZone: TZ });
  assert.ok(a.name && b.name);
});

test('a real stat resolves from data', () => {
  const deps = {
    calendar: {
      today: [
        { title: 'a', startMs: 0, endMs: 95 * 60_000 },
        { title: 'b', startMs: 0, endMs: 30 * 60_000 },
      ],
    },
  };
  const longsword = CHIPS.find((c) => c.id === 'longsword');
  assert.equal(longsword.resolve(deps), 'BLOCK 1H 35M');
});

test('missing stat resolves to null and pickChip shows a dash', () => {
  // Weather chip with no weather data degrades to a dash instead of hiding.
  const coldsnap = CHIPS.find((c) => c.id === 'coldsnap');
  assert.equal(coldsnap.resolve({}), null);
  const picked = pickChip({}, { now: NOW, timeZone: TZ });
  assert.ok(picked.statLine === '—', `expected dash, got ${picked.statLine}`);
});

