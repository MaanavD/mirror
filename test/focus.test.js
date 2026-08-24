import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeFocus, currentEvent, nextEvent, formatTime12h } from '../src/modules/focus.js';

const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-08-24T16:00:00Z'); // 09:00 PDT

const ev = (title, startOffsetMin, endOffsetMin) => ({
  title,
  allDay: false,
  startMs: NOW.getTime() + startOffsetMin * 60_000,
  endMs: NOW.getTime() + endOffsetMin * 60_000,
  start: '',
  end: '',
});

test('no events -> nothing to focus on', () => {
  assert.equal(shapeFocus({ today: [] }, { now: NOW, timeZone: TZ }), null);
});

test('current event + next event both reported', () => {
  const cal = { today: [ev('standup', -30, 30), ev('design', 60, 120)] };
  const f = shapeFocus(cal, { now: NOW, timeZone: TZ });
  assert.equal(f.now.title, 'standup');
  assert.equal(f.next.title, 'design');
  assert.equal(f.next.inMin, 60);
});

test('only next when nothing is current', () => {
  const cal = { today: [ev('gym', 45, 105)] };
  const f = shapeFocus(cal, { now: NOW, timeZone: TZ });
  assert.equal(f.now, null);
  assert.equal(f.next.title, 'gym');
  assert.equal(f.next.inMin, 45);
});

test('all-day events are not a focus target', () => {
  const cal = { today: [{ title: 'holiday', allDay: true, startMs: 0, endMs: 0 }] };
  assert.equal(shapeFocus(cal, { now: NOW, timeZone: TZ }), null);
});

test('formatTime12h renders 12h with AM/PM', () => {
  assert.equal(formatTime12h(new Date('2026-08-24T15:00:00Z'), 'UTC'), '3:00 PM');
  assert.equal(formatTime12h(new Date('2026-08-24T01:30:00Z'), 'UTC'), '1:30 AM');
});

test('currentEvent / nextEvent helpers', () => {
  const events = [ev('a', -10, 10), ev('b', 20, 40)];
  assert.equal(currentEvent(events, NOW.getTime()).title, 'a');
  assert.equal(nextEvent(events, NOW.getTime()).title, 'b');
});
