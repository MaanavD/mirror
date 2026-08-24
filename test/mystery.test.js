import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMysteryDay,
  revealRatio,
  scramble,
  candidateFacts,
  shapeMystery,
} from '../src/modules/mystery.js';

const TZ = 'America/Los_Angeles';
// 2026-08-23 is a Sunday; 2026-08-24 is a Monday.
const SUNDAY = new Date('2026-08-23T20:00:00Z');
const MONDAY = new Date('2026-08-24T20:00:00Z');

test('isMysteryDay true on Sunday', () => {
  assert.equal(isMysteryDay(SUNDAY, TZ), true);
});

test('isMysteryDay false on Monday', () => {
  assert.equal(isMysteryDay(MONDAY, TZ), false);
});

test('revealRatio ramps 0 at 6am to 1 at 9pm (UTC-controlled)', () => {
  const at = (h) => revealRatio(new Date(`2026-08-23T${String(h).padStart(2, '0')}:30:00Z`), 'UTC');
  assert.equal(at(6), 0);
  assert.equal(at(21), 1);
  assert.ok(at(13) > 0 && at(13) < 1);
  assert.equal(at(3), 0); // before window clamps to 0
  assert.equal(at(23), 1); // after window clamps to 1
});

test('scramble is deterministic and reveals a prefix', () => {
  const a = scramble('HELLO WORLD', 0.4);
  const b = scramble('HELLO WORLD', 0.4);
  assert.equal(a, b);
  assert.equal(a.slice(0, 4), 'HELL'); // 0.4 * 11 ≈ 4 revealed
});

test('scramble fully reveals at ratio 1, hides at 0', () => {
  assert.equal(scramble('ABC', 1), 'ABC');
  assert.notEqual(scramble('ABC', 0), 'ABC');
});

test('candidateFacts pulls from available data', () => {
  const facts = candidateFacts({
    spotify: { configured: true, track: { artists: ['Bo'] } },
    calendar: { today: [1, 2, 3] },
    aqi: { aqi: 50 },
    notion: { total: 4 },
    weather: { today: { hi: 25 } },
  });
  assert.equal(facts.length, 5);
});

test('candidateFacts empty when nothing is available', () => {
  assert.equal(candidateFacts({}).length, 0);
});

test('shapeMystery null off the mystery day', () => {
  assert.equal(shapeMystery({}, { now: MONDAY, timeZone: TZ }), null);
});

test('shapeMystery returns ??? and a scrambled fact on the day', () => {
  const out = shapeMystery({ calendar: { today: [1, 2, 3, 4] } }, { now: SUNDAY, timeZone: TZ });
  assert.ok(out);
  assert.equal(out.glyphs, '???');
  assert.ok(out.plain);
  assert.equal(typeof out.scrambled, 'string');
});
