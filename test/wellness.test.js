import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  clearWellnessCache,
  emotionFor,
  formatAlarmTime,
  normalizeDayWindow,
  normalizeWake,
  nextAlarm,
  nextAlarmDetails,
  setAlarm,
  setPythonRunner,
  shapeWellness,
  sleepTarget,
  wellnessModule,
} from '../src/modules/wellness.js';

const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-08-24T12:00:00Z');
// profileFile: '' keeps the suite off the real wellness profile on this machine.
const CONFIG = { timezone: TZ, fetchTimeoutMs: 10_000, wellness: { profileFile: '' } };

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
    if (args.includes('wake')) {
      return { stdout: JSON.stringify({ ok: true, wake_local: '2026-08-24T04:42:30-07:00', wake_date_local: '2026-08-24', incomplete: false, source: 'eight_sleep' }) };
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
    assert.equal(data.emotion, 'STEADY');
    assert.equal(data.score, 78);
    assert.equal(data.hrv, 62);
    assert.equal(data.nights, null, 'a readiness payload without a night count is not labeled as an average of N');
    assert.equal(data.alarm, '6:40A');
    assert.equal(data.subline, 'HRV 62 · SLEEP 78 · ALARM 6:40A');
    assert.deepEqual(data.dayWindow, {
      wakeAt: '2026-08-24T11:42:30.000Z',
      bedtimeAt: '2026-08-25T05:40:00.000Z',
      day: '2026-08-24',
      wakeDate: '2026-08-24',
      bedtimeDate: '2026-08-24',
      wakeSource: 'eight_sleep',
      bedtimeSource: 'estimated',
      wakeFresh: true,
      wakeFreshness: 'fresh',
      bedtimeFresh: true,
      bedtimeFreshness: 'current',
      estimated: true,
      incomplete: false,
      basis: 'next alarm minus 8h default sleep opportunity',
      sleepHours: 8,
      lastNight: { date: '2026-08-24', wakeAt: '2026-08-24T11:42:30.000Z', durationHours: null, score: null },
      sleepTargetMinutes: 1410,
      sleepTargetClock: '11:30P',
      sleepTargetSource: 'default 23:30',
    });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].args.slice(-2), ['/home/hermes/.hermes/scripts/eight_sleep_client.py', 'readiness']);
    assert.deepEqual(calls[1].args.slice(-2), ['/home/hermes/.hermes/scripts/eight_sleep_client.py', 'wake']);
    assert.equal(calls[2].file, 'python3');
    assert.equal(calls[2].args[0], '-c');
    assert.match(calls[2].args[1], /app-api\.8slp\.net\/v2\/users\/\{uid\}\/alarms/);
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
    assert.equal(calls, 3, 'the three subprocesses should run only once while fresh');
    await wellnessModule.fetch({ config: CONFIG, now: new Date(NOW.getTime() + 31 * 60_000) });
    assert.equal(calls, 6, 'the three subprocesses should run again after the cache window');
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
    if (args.includes('wake')) return { stdout: JSON.stringify({ ok: false, error: 'missing credentials' }) };
    throw new Error('alarm unavailable');
  });
  try {
    const data = await wellnessModule.fetch({ config: CONFIG, now: NOW });
    assert.equal(data.emotion, 'STEADY');
    assert.equal(data.score, 78);
    assert.equal(data.hrv, 62);
    assert.equal(data.alarm, null);
    assert.equal(data.subline, 'HRV 62 · SLEEP 78');
  } finally {
    restore();
    clearWellnessCache();
  }
});

test('a readiness outage does not block the independent wake and bedtime window', async () => {
  clearWellnessCache();
  const restore = setPythonRunner(async (_file, args) => {
    if (args.includes('readiness')) return { stdout: JSON.stringify({ ok: false, error: 'readiness unavailable' }) };
    if (args.includes('wake')) return { stdout: JSON.stringify({
      ok: true,
      wake_local: '2026-08-24T04:42:30-07:00',
      wake_date_local: '2026-08-24',
      incomplete: false,
      source: 'eight_sleep',
    }) };
    return { stdout: JSON.stringify({ alarms: [{ enabled: true, time: '06:40' }] }) };
  });
  try {
    const data = await wellnessModule.fetch({ config: CONFIG, now: NOW });
    assert.equal(data.score, null);
    assert.equal(data.hrv, null);
    assert.equal(data.dayWindow.wakeAt, '2026-08-24T11:42:30.000Z');
    assert.equal(data.dayWindow.bedtimeSource, 'estimated');
    assert.equal(data.dayWindow.estimated, true);
  } finally {
    restore();
    clearWellnessCache();
  }
});

test('missing numeric readiness values stay unavailable rather than becoming zero', async () => {
  clearWellnessCache();
  const previousEmail = process.env.EIGHT_SLEEP_EMAIL;
  const previousPassword = process.env.EIGHT_SLEEP_PASSWORD;
  process.env.EIGHT_SLEEP_EMAIL = 'test@example.invalid';
  process.env.EIGHT_SLEEP_PASSWORD = 'test-password';
  const envs = [];
  const restore = setPythonRunner(async (_file, args, options) => {
    envs.push(options.env);
    if (args.includes('readiness')) return { stdout: JSON.stringify({ ok: true, score: null, hrv: '' }) };
    if (args.includes('wake')) return { stdout: JSON.stringify({ ok: false, error: 'no wake' }) };
    return { stdout: JSON.stringify({ alarms: [] }) };
  });
  try {
    const data = await wellnessModule.fetch({ config: CONFIG, now: NOW });
    assert.equal(data.score, null);
    assert.equal(data.hrv, null);
    assert.equal(envs[0].EIGHT_SLEEP_EMAIL, 'test@example.invalid');
    assert.equal(envs[0].EIGHT_SLEEP_PASSWORD, 'test-password');
  } finally {
    restore();
    clearWellnessCache();
    if (previousEmail === undefined) delete process.env.EIGHT_SLEEP_EMAIL;
    else process.env.EIGHT_SLEEP_EMAIL = previousEmail;
    if (previousPassword === undefined) delete process.env.EIGHT_SLEEP_PASSWORD;
    else process.env.EIGHT_SLEEP_PASSWORD = previousPassword;
  }
});

test('all Eight Sleep subprocess failures preserve stale-module behavior', async () => {
  clearWellnessCache();
  const restore = setPythonRunner(async () => { throw new Error('credentials unavailable'); });
  try {
    await assert.rejects(() => wellnessModule.fetch({ config: CONFIG, now: NOW }), /Eight Sleep unavailable/);
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

test('wake window uses the actual wake and estimates bedtime from the next alarm', () => {
  const wake = normalizeWake({
    ok: true,
    wake_local: '2026-08-24T23:42:30-07:00',
    wake_date_local: '2026-08-24',
    incomplete: false,
    source: 'eight_sleep',
  }, { now: new Date('2026-08-25T07:00:00Z'), timezone: TZ });
  assert.equal(wake.usable, true, 'previous-day wake remains usable before the overnight cutoff');
  const window = normalizeDayWindow({
    wake: { ok: true, wake_local: '2026-08-24T23:42:30-07:00', wake_date_local: '2026-08-24', incomplete: false, source: 'eight_sleep' },
    alarms: { alarms: [{ enabled: true, time: '06:40' }] },
    now: new Date('2026-08-25T07:00:00Z'),
    timezone: TZ,
  });
  assert.equal(window.day, '2026-08-24');
  assert.equal(window.wakeAt, '2026-08-25T06:42:30.000Z');
  assert.equal(window.bedtimeAt, '2026-08-26T05:40:00.000Z');
  assert.equal(window.bedtimeSource, 'estimated');
  assert.equal(window.estimated, true);
});

test('stale and incomplete wakes cannot bound the current day', () => {
  const stale = normalizeDayWindow({
    wake: { ok: true, wake_local: '2026-08-23T08:00:00-07:00', wake_date_local: '2026-08-23', incomplete: false, source: 'eight_sleep' },
    alarms: { alarms: [{ enabled: true, time: '06:40' }] },
    now: new Date('2026-08-24T18:00:00Z'),
    timezone: TZ,
  });
  assert.equal(stale.wakeAt, null);
  assert.equal(stale.wakeFresh, false);
  assert.equal(stale.wakeFreshness, 'stale');
  const incomplete = normalizeDayWindow({
    wake: { ok: true, wake_local: '2026-08-24T08:00:00-07:00', wake_date_local: '2026-08-24', incomplete: true, source: 'eight_sleep' },
    now: new Date('2026-08-24T18:00:00Z'),
    timezone: TZ,
  });
  assert.equal(incomplete.wakeAt, null);
  assert.equal(incomplete.wakeFreshness, 'incomplete');
});

test('readiness recommendation wins over estimated alarm bedtime', () => {
  const window = normalizeDayWindow({
    wake: { ok: true, wake_local: '2026-08-24T08:00:00-07:00', wake_date_local: '2026-08-24', incomplete: false, source: 'eight_sleep' },
    readiness: { ok: true, suggested_bedtime: '2026-08-24T22:30:00-07:00' },
    alarms: { alarms: [{ enabled: true, time: '06:40' }] },
    now: new Date('2026-08-24T18:00:00Z'),
    timezone: TZ,
  });
  assert.equal(window.bedtimeAt, '2026-08-25T05:30:00.000Z');
  assert.equal(window.bedtimeSource, 'eight_sleep');
  assert.equal(window.estimated, false);
});

test('early wake before a DST alarm rolls bedtime to the next local civil day', () => {
  const window = normalizeDayWindow({
    wake: { ok: true, wake_local: '2026-11-01T01:30:00-07:00', wake_date_local: '2026-11-01', incomplete: false, source: 'eight_sleep' },
    alarms: { alarms: [{ enabled: true, time: '06:40' }] },
    now: new Date('2026-11-01T09:30:00Z'),
    timezone: TZ,
  });
  assert.equal(window.wakeAt, '2026-11-01T08:30:00.000Z');
  assert.equal(window.bedtimeAt, '2026-11-02T06:40:00.000Z');
  assert.equal(window.bedtimeDate, '2026-11-01');
  assert.equal(window.bedtimeSource, 'estimated');
});

test('a bedtime recommendation outside the waking day falls back to an ordered estimate', () => {
  const window = normalizeDayWindow({
    wake: { ok: true, wake_local: '2026-08-24T08:00:00-07:00', wake_date_local: '2026-08-24', incomplete: false, source: 'eight_sleep' },
    readiness: { ok: true, suggested_bedtime: '2026-08-26T22:30:00-07:00' },
    alarms: { alarms: [{ enabled: true, time: '06:40' }] },
    now: new Date('2026-08-24T18:00:00Z'),
    timezone: TZ,
  });
  assert.equal(window.bedtimeSource, 'estimated');
  assert.equal(window.estimated, true);
  assert.equal(window.bedtimeAt, '2026-08-25T05:40:00.000Z');
});

// Keep the pure shape contract visible to future changes.
test('shapeWellness exposes the renderer and day-window contracts', () => {
  assert.deepEqual(Object.keys(shapeWellness({ readiness: { score: 78, hrv: 62 }, alarm: '6:40A' })).sort(), [
    'alarm', 'dayWindow', 'emotion', 'hrv', 'nights', 'score', 'subline',
  ]);
});

test('a fresh night reports its own duration and score, never the multi-night average', () => {
  const window = normalizeDayWindow({
    wake: {
      ok: true,
      wake_local: '2026-09-11T09:00:30-07:00',
      wake_date_local: '2026-09-11',
      incomplete: false,
      sleep_duration_h: 8.2,
      sleep_score: 90,
      source: 'eight_sleep',
    },
    readiness: { ok: true, sleep_score_avg: 80, hrv_rmssd_avg: 45.91, nights_analyzed: 6 },
    now: new Date('2026-09-11T16:30:00Z'),
    timezone: TZ,
  });
  assert.deepEqual(window.lastNight, {
    date: '2026-09-11',
    wakeAt: '2026-09-11T16:00:30.000Z',
    durationHours: 8.2,
    score: 90,
  });
  const shaped = shapeWellness({ readiness: { ok: true, sleep_score_avg: 80, hrv_rmssd_avg: 45.91, nights_analyzed: 6 }, dayWindow: window });
  assert.equal(shaped.score, 80, 'the panel score stays the readiness average');
  assert.equal(shaped.nights, 6, 'the average is labeled with the nights it covers');
});

test('stale, incomplete and implausible nights are rejected instead of shown', () => {
  const wake = extra => ({
    ok: true,
    wake_local: '2026-08-24T08:00:00-07:00',
    wake_date_local: '2026-08-24',
    incomplete: false,
    sleep_duration_h: 7.4,
    sleep_score: 88,
    source: 'eight_sleep',
    ...extra,
  });
  const common = { alarms: { alarms: [{ enabled: true, time: '06:40' }] }, now: new Date('2026-08-24T18:00:00Z'), timezone: TZ };
  const incomplete = normalizeDayWindow({ wake: wake({ incomplete: true }), ...common });
  assert.equal(incomplete.lastNight, null);
  assert.equal(incomplete.sleepTargetMinutes, 1410, 'the bed target survives an unusable night');
  const stale = normalizeDayWindow({ wake: wake({ wake_date_local: '2026-08-22', wake_local: '2026-08-22T08:00:00-07:00' }), ...common });
  assert.equal(stale.lastNight, null);
  assert.equal(stale.sleepTargetClock, '11:30P');
  const implausible = normalizeDayWindow({ wake: wake({ sleep_duration_h: 41 }), ...common });
  assert.equal(implausible.lastNight.durationHours, null);
  assert.equal(implausible.lastNight.score, 88, 'a bad duration does not discard a usable score');
  const missing = normalizeDayWindow({ wake: wake({ sleep_duration_h: null, sleep_score: null }), ...common });
  assert.deepEqual(missing.lastNight, { date: '2026-08-24', wakeAt: '2026-08-24T15:00:00.000Z', durationHours: null, score: null });
});

test('the target bed time comes from the wellness profile and is labeled as a target', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wellness-profile-'));
  const file = path.join(dir, 'profile.json');
  const config = { ...CONFIG, wellness: { profileFile: file } };
  try {
    assert.equal(sleepTarget('22:45', 'wellness profile').clock, '10:45P');
    assert.equal(sleepTarget('22:45', 'wellness profile').minutes, 22 * 60 + 45);

    writeFileSync(file, JSON.stringify({ sleep: { target_bed_local: '22:45' } }));
    clearWellnessCache();
    const restore = setPythonRunner(async (_file, args) => {
      if (args.includes('readiness')) return { stdout: JSON.stringify({ ok: true, score: 80, hrv: 46, nights_analyzed: 6 }) };
      if (args.includes('wake')) return { stdout: JSON.stringify({ ok: true, wake_local: '2026-08-24T08:00:00-07:00', wake_date_local: '2026-08-24', incomplete: false, sleep_duration_h: 8.1, sleep_score: 90 }) };
      return { stdout: JSON.stringify({ alarms: [] }) };
    });
    try {
      const data = await wellnessModule.fetch({ config, now: NOW });
      assert.equal(data.dayWindow.sleepTargetClock, '10:45P');
      assert.equal(data.dayWindow.sleepTargetMinutes, 1365);
      assert.equal(data.dayWindow.sleepTargetSource, 'wellness profile');
      assert.equal(data.dayWindow.bedtimeSource, null, 'no false bedtime is invented from the target');

      // An unreadable profile keeps the built-in 23:30 and says so.
      writeFileSync(file, '{ not json');
      clearWellnessCache();
      const fallback = await wellnessModule.fetch({ config, now: NOW });
      assert.equal(fallback.dayWindow.sleepTargetClock, '11:30P');
      assert.equal(fallback.dayWindow.sleepTargetSource, 'default 23:30');
    } finally {
      restore();
      clearWellnessCache();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dashboard renders an always-visible sleep line outside the Around you panel', () => {
  const html = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/dashboard.css', import.meta.url), 'utf8');
  const masthead = html.indexOf('class="masthead"');
  const lights = html.indexOf('id="room-lights"');
  const sleep = html.indexOf('id="sleep-line"');
  const cutoffs = html.indexOf('id="sleep-cutoffs"');
  const timeline = html.indexOf('class="day-timeline"');
  const details = html.indexOf('id="details-panel"');
  assert.ok(masthead < lights && lights < sleep && sleep < timeline, 'the sleep line must sit in the masthead');
  assert.ok(sleep < details, 'the sleep line is not inside the Around you panel');
  assert.ok(cutoffs < timeline, 'the cutoff block stays before the day bar in the document');
  assert.match(app, /renderSleep\(m,now,model\.timeZone\)/);
  assert.match(app, /replace\('sleep-line'/);
  assert.match(app, /\$\('sleep-line'\)/);
  assert.match(app, /sleepPlanFor\(state\?\.modules\?\.calendar/);
  assert.match(app, /timeline-cutoff/);
  assert.match(css, /\.sleep-line\s*\{[\s\S]*?display:\s*flex/);
  assert.match(css, /\.mirror\s+#sleep-cutoffs\s*\{\s*display:\s*none/);
  assert.match(css, /\.mirror\s+\.day-timeline\s*\{[\s\S]*?display:\s*block/);
});
