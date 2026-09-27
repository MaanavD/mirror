import test from 'node:test';
import assert from 'node:assert/strict';
import { localInstant } from '../public/day-model.js';
import { sleepSchedule, publicSchedule, scheduleFromState, phaseAt } from '../public/sleep-model.js';
import { NightGuard } from '../src/night-guard.js';

const zone = 'America/Los_Angeles';
const at = (day, hour, minute = 0) => localInstant(day, hour, zone, minute);
const iso = (t) => new Date(t).toISOString();
const entry = (data, fetchedAt) => ({ data, stale: false, fetchedAt });
const meeting = (day, hour, title = 'Standup') => ({
  id: title, title, allDay: false, busy: true, start: iso(at(day, hour)), end: iso(at(day, hour + 1)),
});
const calendar = (events, now) => entry({ configured: true, timeZone: zone, events }, now);

test('no meeting: bed 12:30 AM, dark from 1:00 AM, wake 8:30 AM', () => {
  const now = at('2026-09-26', 21);
  const s = sleepSchedule({ now, zone, calendar: calendar([], now) });
  assert.equal(s.night, '2026-09-26');
  assert.equal(s.bedAt, at('2026-09-27', 0, 30));
  assert.equal(s.lockAt, at('2026-09-27', 1));
  assert.equal(s.wakeAt, at('2026-09-27', 8, 30));
  assert.equal(s.phase, 'day');
  assert.equal(phaseAt(s, at('2026-09-26', 23)), 'winddown');
  assert.equal(phaseAt(s, at('2026-09-27', 0, 45)), 'bedtime');
  assert.equal(phaseAt(s, at('2026-09-27', 3)), 'night');
  assert.equal(phaseAt(s, at('2026-09-27', 9)), 'morning');
});

test('an early first meeting pulls bed earlier; a late one never pushes it later', () => {
  const now = at('2026-09-27', 15);
  const early = sleepSchedule({ now, zone, calendar: calendar([meeting('2026-09-28', 8)], now) });
  assert.equal(early.bedAt, at('2026-09-27', 23, 30));
  assert.equal(early.bedBasis, 'first meeting');
  assert.equal(early.firstMeeting.title, 'Standup');
  const late = sleepSchedule({ now, zone, calendar: calendar([meeting('2026-09-28', 13)], now) });
  assert.equal(late.bedAt, at('2026-09-28', 0, 30));
  assert.equal(late.bedBasis, 'default');
});

test('after midnight the night in progress is last evening\'s, and it locks', () => {
  const now = at('2026-09-27', 3);
  const s = sleepSchedule({ now, zone, calendar: calendar([meeting('2026-09-27', 10)], now) });
  assert.equal(s.night, '2026-09-26');
  assert.equal(s.phase, 'night');
  assert.equal(s.locked, true);
  assert.equal(s.sleepIfNowMinutes, 330);
});

test('an enabled Eight Sleep alarm sets the wake time', () => {
  const now = at('2026-09-26', 22);
  const wellness = entry({ alarmAt: iso(at('2026-09-27', 7, 45)) }, now);
  const s = sleepSchedule({ now, zone, calendar: calendar([], now), wellness });
  assert.equal(s.wakeAt, at('2026-09-27', 7, 45));
  assert.equal(s.wakeBasis, 'alarm');
  // Next morning the "next" alarm is tomorrow's; this morning's still counts.
  const morning = at('2026-09-27', 8);
  const after = sleepSchedule({ now: morning, zone, calendar: calendar([], morning),
    wellness: entry({ alarmAt: iso(at('2026-09-28', 7, 45)) }, morning) });
  assert.equal(after.wakeAt, at('2026-09-27', 7, 45));
  assert.equal(after.phase, 'morning');
});

test('getting up in the night releases nothing; only a manual on does', () => {
  const now = at('2026-09-27', 3);
  const wellness = entry({ dayWindow: { wakeAt: iso(at('2026-09-27', 2, 40)) } }, now);
  assert.equal(sleepSchedule({ now, zone, calendar: calendar([], now), wellness }).locked, true);
  const manual = sleepSchedule({ now, zone, calendar: calendar([], now), released: 'manual' });
  assert.equal(manual.locked, false);
  assert.equal(manual.released, 'manual');
});

test('the /api/state projection round-trips', () => {
  const now = at('2026-09-26', 21);
  const s = sleepSchedule({ now, zone, calendar: calendar([meeting('2026-09-27', 8)], now) });
  const back = scheduleFromState(JSON.parse(JSON.stringify(publicSchedule(s, zone))));
  assert.equal(back.bedAt, s.bedAt);
  assert.equal(back.firstMeeting.at, s.firstMeeting.at);
  assert.equal(publicSchedule(s, zone).label, '11:30 PM → 7:30 AM');
});

function rig({ displayOn = false, lights = [] } = {}) {
  const holds = [];
  const store = {
    displayOn,
    sleep: null,
    modules: { calendar: calendar([], Date.now()), nanoleaf: entry({ lights }, Date.now()) },
    snapshot() { return { modules: this.modules }; },
    setSleep(v) { this.sleep = v; },
    setDisplay(v) { this.displayOn = v; },
  };
  const display = { async hold(mode, seconds) { holds.push([mode, seconds]); return { relay: 'ok' }; } };
  const guard = new NightGuard({
    config: { timezone: zone, sleep: {} }, store, display,
    log: { info() {}, warn() {} },
  });
  return { guard, store, holds };
}
const light = (entityId, on) => ({ entityId, on });

test('guard: holds the panel dark only once it is already off', async () => {
  const { guard, store, holds } = rig({ displayOn: true });
  const t = at('2026-09-27', 1, 30);
  await guard.tick(t);
  assert.deepEqual(holds, [], 'never blanks the mirror while someone is using it');
  assert.equal(store.sleep.phase, 'night');
  store.displayOn = false;
  await guard.tick(t + 60_000);
  assert.equal(holds[0][0], 'off');
  assert.equal(holds[0][1], Math.round((at('2026-09-27', 8, 30) - t - 60_000) / 1000));
  await guard.tick(t + 120_000);
  assert.equal(holds.length, 1, 'one hold per night, not one per tick');
});

test('guard: lights on at 3 AM keep the night dark; a manual on releases it', async () => {
  const { guard, store, holds } = rig({ lights: [light('a', false)] });
  const t = at('2026-09-27', 2);
  await guard.tick(t);
  store.modules.nanoleaf = entry({ lights: [light('a', true)] }, Date.now());
  await guard.tick(t + 30_000);
  assert.deepEqual(holds.map((h) => h[0]), ['off']);
  assert.equal(store.sleep.locked, true);
  await guard.noteManual('on', t + 60_000);
  assert.equal(store.sleep.released, 'manual');
  assert.equal(store.sleep.locked, false);
});

test('guard: releases at the wake time', async () => {
  const { guard, store, holds } = rig();
  await guard.tick(at('2026-09-27', 2));
  await guard.tick(at('2026-09-27', 8, 31));
  assert.equal(store.sleep.phase, 'morning');
  assert.deepEqual(holds.map((h) => h[0]), ['off', 'auto']);
});

test('guard: SLEEP_GUARD=0 publishes the schedule but never holds', async () => {
  const { store, holds } = rig();
  const guard = new NightGuard({ config: { timezone: zone, sleep: { guard: false } }, store,
    display: { async hold(...a) { holds.push(a); return { relay: 'ok' }; } }, log: { info() {}, warn() {} } });
  await guard.tick(at('2026-09-27', 2));
  assert.equal(store.sleep.locked, true);
  assert.deepEqual(holds, []);
});
