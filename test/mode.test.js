import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTIVE,
  ACTIVE_HOLD_MS,
  CALM,
  NIGHT,
  createModeMachine,
  isNightAt,
} from '../public/mode.js';

// A hand-cranked clock: every test drives time forward explicitly so nothing
// depends on wall-clock timing.
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      return t;
    },
  };
}

const day = (h, m = 0) => new Date(2026, 0, 5, h, m, 0);

// ---------------------------------------------------------------------------
// Night window (22:30 → 05:00, local time)
// ---------------------------------------------------------------------------

test('isNightAt is false through the evening until 22:30', () => {
  assert.equal(isNightAt(day(12)), false);
  assert.equal(isNightAt(day(22, 0)), false);
  assert.equal(isNightAt(day(22, 29)), false);
});

test('isNightAt covers 22:30 through 04:59', () => {
  assert.equal(isNightAt(day(22, 30)), true);
  assert.equal(isNightAt(day(23, 59)), true);
  assert.equal(isNightAt(day(0, 15)), true);
  assert.equal(isNightAt(day(4, 59)), true);
});

test('isNightAt ends exactly at 05:00', () => {
  assert.equal(isNightAt(day(5, 0)), false);
  assert.equal(isNightAt(day(5, 1)), false);
});

// ---------------------------------------------------------------------------
// calm → active → calm
// ---------------------------------------------------------------------------

test('defaults to calm', () => {
  const machine = createModeMachine({ now: fakeClock().now, isNight: () => false });
  assert.equal(machine.mode, CALM);
  assert.equal(machine.activeUntil, 0);
  assert.equal(machine.lastReason, null);
});

test('a trigger switches to active and records the reason', () => {
  const clock = fakeClock();
  const machine = createModeMachine({ now: clock.now, isNight: () => false });
  assert.equal(machine.trigger('say'), ACTIVE);
  assert.equal(machine.mode, ACTIVE);
  assert.equal(machine.lastReason, 'say');
  assert.equal(machine.activeUntil, clock.now() + ACTIVE_HOLD_MS);
});

test('active decays back to calm after the hold window', () => {
  const clock = fakeClock();
  const machine = createModeMachine({ now: clock.now, holdMs: 90_000, isNight: () => false });
  machine.trigger('presence');
  clock.advance(89_999);
  assert.equal(machine.mode, ACTIVE, 'still active one ms before the window closes');
  clock.advance(1);
  assert.equal(machine.mode, CALM, 'calm the instant the window closes');
});

test('a second trigger extends the window instead of stacking', () => {
  const clock = fakeClock();
  const machine = createModeMachine({ now: clock.now, holdMs: 90_000, isNight: () => false });
  machine.trigger('say');
  clock.advance(80_000);
  machine.trigger('track');
  assert.equal(machine.activeUntil, clock.now() + 90_000);
  clock.advance(80_000);
  assert.equal(machine.mode, ACTIVE, 'the extension is still running');
  clock.advance(10_001);
  assert.equal(machine.mode, CALM);
});

// ---------------------------------------------------------------------------
// Night override
// ---------------------------------------------------------------------------

test('night overrides calm', () => {
  const machine = createModeMachine({ now: fakeClock().now, isNight: () => true });
  assert.equal(machine.mode, NIGHT);
});

test('night overrides an active burst, which resumes if night ends first', () => {
  const clock = fakeClock();
  let night = true;
  const machine = createModeMachine({
    now: clock.now,
    holdMs: 90_000,
    isNight: () => night,
  });
  assert.equal(machine.trigger('say'), NIGHT, 'a say during the night stays night');
  clock.advance(10_000);
  night = false;
  assert.equal(machine.mode, ACTIVE, 'the burst is still inside its window');
  clock.advance(80_001);
  assert.equal(machine.mode, CALM);
});

// ---------------------------------------------------------------------------
// prefers-reduced-motion
// ---------------------------------------------------------------------------

test('reducedMotion never escalates to active', () => {
  const clock = fakeClock();
  const machine = createModeMachine({
    now: clock.now,
    reducedMotion: true,
    isNight: () => false,
  });
  assert.equal(machine.reducedMotion, true);
  assert.equal(machine.trigger('say'), CALM);
  assert.equal(machine.mode, CALM);
});

test('reducedMotion still reports night', () => {
  const machine = createModeMachine({
    now: fakeClock().now,
    reducedMotion: true,
    isNight: () => true,
  });
  machine.trigger('presence');
  assert.equal(machine.mode, NIGHT);
});

// ---------------------------------------------------------------------------
// onChange contract
// ---------------------------------------------------------------------------

test('onChange fires once per transition, with previous mode and reason', () => {
  const clock = fakeClock();
  const seen = [];
  const machine = createModeMachine({
    now: clock.now,
    holdMs: 90_000,
    isNight: () => false,
    onChange: (change) => seen.push(change),
  });

  machine.trigger('say');
  machine.trigger('say');
  machine.tick();
  assert.deepEqual(seen, [{ mode: ACTIVE, previous: null, reason: 'say' }]);

  clock.advance(90_001);
  machine.tick();
  machine.tick();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], { mode: CALM, previous: ACTIVE, reason: 'say' });
});

test('tick returns the mode without announcing an unchanged one', () => {
  let calls = 0;
  const machine = createModeMachine({
    now: fakeClock().now,
    isNight: () => false,
    onChange: () => {
      calls += 1;
    },
  });
  assert.equal(machine.tick(), CALM);
  assert.equal(calls, 1, 'the first tick announces the starting mode');
  assert.equal(machine.tick(), CALM);
  assert.equal(calls, 1, 'a steady mode is not re-announced');
});

test('sync re-announces the current mode for the first paint', () => {
  const seen = [];
  const machine = createModeMachine({
    now: fakeClock().now,
    isNight: () => false,
    onChange: (change) => seen.push(change),
  });
  assert.equal(machine.sync(), CALM);
  assert.equal(machine.sync(), CALM);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { mode: CALM, previous: null, reason: 'init' });
  assert.equal(machine.announced, CALM);
});

test('the machine needs no arguments at all', () => {
  const machine = createModeMachine();
  assert.ok([CALM, ACTIVE, NIGHT].includes(machine.mode));
  assert.equal(typeof machine.tick(), 'string');
});
