import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  clearWellnessCache,
  emotionFor,
  formatAlarmTime,
  nextAlarm,
  setAlarm,
  setPythonRunner,
  shapeWellness,
  wellnessModule,
} from '../src/modules/wellness.js';

const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-08-24T12:00:00Z');
const CONFIG = { timezone: TZ, fetchTimeoutMs: 10_000 };

function calendar(count) {
  return { data: { today: Array.from({ length: count }, (_, i) => ({ id: `e${i}` })), todayMore: 0 } };
}

function weather(code = 0) {
  return { data: { current: { code, text: code >= 95 ? 'thunderstorm' : 'clear' } } };
}

test('fetch shells out to readiness and alarm client, then shapes the wellness line', async () => {
  clearWellnessCache();
  const calls = [];
  const restore = setPythonRunner(async (file, args) => {
    calls.push({ file, args });
    if (args.includes('readiness')) {
      return { stdout: JSON.stringify({ ok: true, sleep_score_avg: 78, hrv_rmssd_avg: 62 }) };
    }
    return { stdout: JSON.stringify({ alarms: [
      { enabled: false, time: '05:30' },
      { enabled: true, time: '06:40' },
      { enabled: true, time: '22:00' },
    ] }) };
  });
  try {
    const data = await wellnessModule.fetch({
      config: CONFIG,
      now: NOW,
      getModule: (name) => (name === 'calendar' ? calendar(2) : weather()),
    });
    assert.deepEqual(data, {
      emotion: 'STEADY',
      score: 78,
      hrv: 62,
      alarm: '6:40A',
      subline: 'HRV 62 · SLEEP 78 · ALARM 6:40A',
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args.slice(-2), ['/home/hermes/.hermes/scripts/eight_sleep_client.py', 'readiness']);
    assert.equal(calls[1].file, 'python3');
    assert.equal(calls[1].args[0], '-c');
    assert.match(calls[1].args[1], /app-api\.8slp\.net\/v2\/users\/\{uid\}\/alarms/);
  } finally {
    restore();
    clearWellnessCache();
  }
});

test('readiness and alarm results stay cached for thirty minutes', async () => {
  clearWellnessCache();
  let calls = 0;
  const restore = setPythonRunner(async (_file, args) => {
    calls += 1;
    return args.includes('readiness')
      ? { stdout: JSON.stringify({ ok: true, score: 78, hrv: 62 }) }
      : { stdout: JSON.stringify({ alarms: [{ enabled: true, time: '06:40' }] }) };
  });
  try {
    await wellnessModule.fetch({ config: CONFIG, now: NOW });
    await wellnessModule.fetch({ config: CONFIG, now: new Date(NOW.getTime() + 29 * 60_000) });
    assert.equal(calls, 2, 'the two subprocesses should run only once while fresh');
    await wellnessModule.fetch({ config: CONFIG, now: new Date(NOW.getTime() + 31 * 60_000) });
    assert.equal(calls, 4, 'both subprocesses should run again after the cache window');
  } finally {
    restore();
    clearWellnessCache();
  }
});

test('emotion composite covers charged, steady, tired, overloaded, and stormy', () => {
  assert.equal(emotionFor({ score: 92, hrv: 72, calendarEvents: 2, weather: weather(0) }), 'CHARGED');
  assert.equal(emotionFor({ score: 78, hrv: 62, calendarEvents: 2, weather: weather(0) }), 'STEADY');
  assert.equal(emotionFor({ score: 55, hrv: 62, calendarEvents: 2, weather: weather(0) }), 'TIRED');
  assert.equal(emotionFor({ score: 92, hrv: 72, calendarEvents: 8, weather: weather(0) }), 'OVERLOADED');
  assert.equal(emotionFor({ score: 92, hrv: 72, calendarEvents: 0, weather: weather(95) }), 'STORMY');
});

test('alarm parser chooses the next enabled daily alarm', () => {
  assert.equal(formatAlarmTime({ hour: 0, minute: 5 }), '12:05A');
  assert.equal(formatAlarmTime({ hour: 12, minute: 0 }), '12:00P');
  assert.equal(nextAlarm({ alarms: [
    { enabled: false, time: '09:05' },
    { enabled: true, time: '06:40' },
    { enabled: true, time: '10:15' },
  ] }, { now: NOW, timezone: TZ }), '6:40A');
});

test('an alarm outage leaves readiness visible without an alarm segment', async () => {
  clearWellnessCache();
  const restore = setPythonRunner(async (_file, args) => {
    if (args.includes('readiness')) return { stdout: JSON.stringify({ ok: true, score: 78, hrv: 62 }) };
    throw new Error('alarm unavailable');
  });
  try {
    const data = await wellnessModule.fetch({ config: CONFIG, now: NOW });
    assert.deepEqual(data, {
      emotion: 'STEADY',
      score: 78,
      hrv: 62,
      alarm: null,
      subline: 'HRV 62 · SLEEP 78',
    });
  } finally {
    restore();
    clearWellnessCache();
  }
});

test('setAlarm is an explicit disabled write stub', () => {
  const previous = process.env.ENABLE_EIGHTSLEEP_WRITE;
  delete process.env.ENABLE_EIGHTSLEEP_WRITE;
  assert.throws(() => setAlarm(), /ENABLE_EIGHTSLEEP_WRITE=1/);
  process.env.ENABLE_EIGHTSLEEP_WRITE = '1';
  assert.deepEqual(setAlarm(), { ok: false, implemented: false });
  if (previous === undefined) delete process.env.ENABLE_EIGHTSLEEP_WRITE;
  else process.env.ENABLE_EIGHTSLEEP_WRITE = previous;
});

test('wellness is registered below countdown and stays in the right rail', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const countdownAt = html.indexOf('id="countdown-line"');
  const wellnessAt = html.indexOf('id="wellness-line"');
  const railAt = html.indexOf('<div class="rail">');
  const faceAt = html.indexOf('<div class="face"');
  assert.ok(railAt < countdownAt && countdownAt < wellnessAt && wellnessAt < faceAt);
  assert.match(app, /wellness:\s*\[q\('#wellness-line'\)\]/);
  assert.match(app, /wellness:\s*renderWellness/);
  assert.match(css, /\.wellness-window\s*\{[\s\S]*margin-left:\s*24px/);
  assert.match(css, /\.wellness-subline\s*\{[\s\S]*font-size:\s*16px[\s\S]*text-overflow:\s*ellipsis/);
});

test('mock data produces the requested exact subline', () => {
  const data = wellnessModule.mock({ now: NOW });
  assert.equal(data.subline, 'HRV 62 · SLEEP 78 · ALARM 6:40A');
});

// Keep the pure shape contract visible to future changes.
test('shapeWellness exposes only the renderer contract', () => {
  assert.deepEqual(Object.keys(shapeWellness({ readiness: { score: 78, hrv: 62 }, alarm: '6:40A' })).sort(), [
    'alarm', 'emotion', 'hrv', 'score', 'subline',
  ]);
});
