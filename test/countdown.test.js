import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flightLabel, daysUntil, shapeCountdown, countdownModule } from '../src/modules/countdown.js';

const TZ = 'America/Los_Angeles';
// A fixed instant: 2026-08-24 09:00 PDT.
const NOW = new Date('2026-08-24T16:00:00Z');

test('flightLabel extracts the destination from Flighty summaries', () => {
  assert.equal(flightLabel('Flight to San Francisco (AC 739)'), 'SAN FRANCISCO');
  assert.equal(flightLabel('Flying to Toronto (AC 540)'), 'TORONTO');
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

// Layout guard: the countdown lives inside the right rail, whose row clips at
// the corridor's top band — so all it must promise is that it stays a single
// hidden-overflow column and never forces the rail wider.
test('the countdown stack stays inside the rail', () => {
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const rule = /\.countdown-strip\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '.countdown-strip rule missing');
  assert.match(rule[1], /flex-direction:\s*column/);
  assert.match(rule[1], /overflow:\s*hidden/);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const railAt = html.indexOf('<div class="rail">');
  const cdAt = html.indexOf('id="countdown-line"');
  const faceAt = html.indexOf('<div class="face"');
  assert.ok(railAt !== -1 && cdAt > railAt && cdAt < faceAt, 'countdown-line must live inside the right rail');
});
