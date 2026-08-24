import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flightLabel, daysUntil, shapeCountdown, countdownModule } from '../src/modules/countdown.js';

const TZ = 'America/Los_Angeles';
// A fixed instant: 2026-08-24 09:00 PDT.
const NOW = new Date('2026-08-24T16:00:00Z');

test('flightLabel extracts the destination from Flighty summaries', () => {
  assert.equal(flightLabel('Flight to San Francisco (AC 739)'), 'SAN FRANCISCO');
  assert.equal(flightLabel('Flight to Athens (AC 896)'), 'ATHENS');
  // Anything that is not Flighty-shaped falls back to the raw title.
  assert.equal(flightLabel('SEA→SFO'), 'SEA→SFO');
});

test('daysUntil counts local calendar days, not 24h blocks', () => {
  assert.equal(daysUntil('2026-08-24', NOW, TZ), 0);
  assert.equal(daysUntil('2026-08-31', NOW, TZ), 7);
  assert.equal(daysUntil('2026-10-15', NOW, TZ), 52);
  assert.equal(daysUntil('not-a-date', NOW, TZ), null);
});

test('shapeCountdown lists the flight before milestones and drops the past', () => {
  const shaped = shapeCountdown(
    {
      flight: { summary: 'Flight to San Francisco (AC 739)', startMs: NOW.getTime() + 7 * 86_400_000 },
      milestones: [
        { label: 'sf move', date: '2026-10-15' },
        { label: 'gone', date: '2026-08-01' },
      ],
    },
    { now: NOW, timeZone: TZ },
  );
  assert.deepEqual(shaped.items.map((i) => [i.kind, i.label, i.days]), [
    ['flight', 'SAN FRANCISCO', 7],
    ['milestone', 'SF MOVE', 52],
  ]);
});

test('shapeCountdown survives having no flight and no milestones', () => {
  const shaped = shapeCountdown({ flight: null, milestones: [] }, { now: NOW, timeZone: TZ });
  assert.deepEqual(shaped.items, []);
});

test('a flight past the horizon is not worth a countdown', () => {
  const shaped = shapeCountdown(
    { flight: { summary: 'Flight to Tokyo (NH 1)', startMs: NOW.getTime() + 200 * 86_400_000 }, milestones: [] },
    { now: NOW, timeZone: TZ },
  );
  assert.deepEqual(shaped.items, []);
});

test('mock renders both kinds so the layout can be reviewed offline', () => {
  const data = countdownModule.mock({
    config: { timezone: TZ, countdown: { milestones: [{ label: 'sf move', date: '2026-10-15' }] } },
    now: NOW,
  });
  assert.equal(data.items.length, 2);
  assert.equal(data.items[0].kind, 'flight');
  assert.equal(data.items[1].kind, 'milestone');
});

// Layout guard: the countdown is the one left-column element allowed below the
// masthead clip line (y=280), so it must never reach the corridor at x=340.
test('the countdown stack cannot reach the corridor', () => {
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const rule = /\.countdown-strip\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '.countdown-strip rule missing');
  const cap = /max-width:\s*(\d+)px/.exec(rule[1]);
  assert.ok(cap, '.countdown-strip has no max-width, so a long label could cross x=340');
  assert.ok(40 + Number(cap[1]) <= 340, 'countdown can print into the corridor');
});
