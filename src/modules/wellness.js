import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const EIGHT_SLEEP_CLIENT = '/home/hermes/.hermes/scripts/eight_sleep_client.py';
export const EIGHT_SLEEP_ALARMS = 'https://app-api.8slp.net/v2/users/{uid}/alarms';
export const CACHE_TTL_MS = 30 * 60_000;

const ALARM_CLIENT_SCRIPT = `
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(${JSON.stringify(EIGHT_SLEEP_CLIENT)}))
from eight_sleep_client import _creds, authenticate

email, password = _creds()
token, uid = authenticate(email, password)
url = ${JSON.stringify(EIGHT_SLEEP_ALARMS)}.replace('{uid}', uid)
request = urllib.request.Request(
    url,
    headers={
        'authorization': f'Bearer {token}',
        'user-agent': 'okhttp/4.9.3',
        'accept': 'application/json',
    },
    method='GET',
)
with urllib.request.urlopen(request, timeout=10) as response:
    sys.stdout.write(response.read().decode())
`;

let pythonRunner = (file, args, options) => execFile(file, args, options);
let cached = null;
let cachedAt = 0;

/** Replace the subprocess runner in tests, returning a restore function. */
export function setPythonRunner(runner) {
  if (typeof runner !== 'function') throw new TypeError('python runner must be a function');
  const previous = pythonRunner;
  pythonRunner = runner;
  return () => {
    pythonRunner = previous;
  };
}

export function clearWellnessCache() {
  cached = null;
  cachedAt = 0;
}

function finite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function rounded(...values) {
  const number = finite(...values);
  return number === null ? null : Math.round(number);
}

function parseJsonOutput(result) {
  const stdout = typeof result === 'string' ? result : result?.stdout;
  if (typeof stdout !== 'string') throw new Error('Eight Sleep command returned no stdout');
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('Eight Sleep command returned empty stdout');
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    throw new Error('Eight Sleep command returned invalid JSON');
  }
}

async function runJson(args, { timezone, timeoutMs = 10_000 } = {}) {
  const result = await pythonRunner('python3', args, {
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, EIGHT_SLEEP_TZ: timezone ?? process.env.EIGHT_SLEEP_TZ ?? 'America/Los_Angeles' },
  });
  return parseJsonOutput(result);
}

function assertOk(payload, label) {
  if (!payload || typeof payload !== 'object') throw new Error(`${label} returned no object`);
  if (payload.ok === false) throw new Error(payload.error || `${label} failed`);
  return payload;
}

export function normalizeReadiness(payload) {
  const raw = assertOk(payload, 'readiness');
  const score = rounded(
    raw.score,
    raw.readiness_score,
    raw.readinessScore,
    raw.readiness?.score,
    raw.sleep_score_avg,
    raw.sleep_score,
  );
  const hrv = rounded(
    raw.hrv,
    raw.hrv_rmssd_avg,
    raw.hrv_rmssd,
    raw.readiness?.hrv,
  );
  if (score === null || hrv === null) {
    throw new Error('readiness payload missing score or HRV');
  }
  return { score: Math.max(0, Math.min(100, score)), hrv: Math.max(0, hrv) };
}

function alarmEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [payload.alarms, payload.data?.alarms, payload.data, payload.alarm];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object' && extractAlarmTime(candidate)) return [candidate];
  }
  return extractAlarmTime(payload) ? [payload] : [];
}

function extractAlarmTime(alarm) {
  if (!alarm || typeof alarm !== 'object') return null;
  return alarm.time
    ?? alarm.alarmTime
    ?? alarm.timeOfDay
    ?? alarm.scheduledTime
    ?? alarm.schedule?.time
    ?? alarm.alarm?.time
    ?? null;
}

function isEnabled(alarm) {
  if (!alarm || typeof alarm !== 'object') return false;
  if (alarm.enabled === false || alarm.active === false || alarm.isEnabled === false) return false;
  const status = String(alarm.status ?? '').toLowerCase();
  return !['disabled', 'inactive', 'off'].includes(status);
}

function timeParts(raw, timezone) {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return localTimeParts(raw, timezone);
  }
  const value = String(raw ?? '').trim();
  const match = /(?:^|T|\s)(\d{1,2}):(\d{2})(?::\d{2})?/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function localTimeParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return Number.isFinite(hour) && Number.isFinite(minute) ? { hour: hour % 24, minute } : null;
}

export function formatAlarmTime({ hour, minute }) {
  const suffix = hour >= 12 ? 'P' : 'A';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, '0')}${suffix}`;
}

export function nextAlarm(payload, { now = new Date(), timezone = 'America/Los_Angeles' } = {}) {
  const current = localTimeParts(now, timezone);
  if (!current) return null;
  const currentMinutes = current.hour * 60 + current.minute;
  const options = [];
  for (const alarm of alarmEntries(payload)) {
    if (!isEnabled(alarm)) continue;
    const parts = timeParts(extractAlarmTime(alarm), timezone);
    if (!parts) continue;
    const minutes = parts.hour * 60 + parts.minute;
    const delta = (minutes - currentMinutes + 1_440) % 1_440;
    options.push({ ...parts, delta });
  }
  options.sort((a, b) => a.delta - b.delta);
  return options.length ? formatAlarmTime(options[0]) : null;
}

function calendarEventCount(moduleEntry) {
  const data = moduleEntry?.data ?? moduleEntry;
  if (!data || typeof data !== 'object') return null;
  if (Number.isFinite(Number(data.eventsToday))) return Number(data.eventsToday);
  if (Array.isArray(data.today)) return data.today.length + (Number(data.todayMore) || 0);
  return null;
}

function weatherCode(moduleEntry) {
  const data = moduleEntry?.data ?? moduleEntry;
  return finite(data?.current?.code, data?.weather_code, data?.code);
}

function weatherIsStormy(moduleEntry) {
  const data = moduleEntry?.data ?? moduleEntry;
  const code = weatherCode(moduleEntry);
  const text = String(data?.current?.text ?? data?.text ?? '').toLowerCase();
  return (code !== null && code >= 95 && code <= 99) || /storm|thunder|lightning/.test(text);
}

export function emotionFor({ score, hrv, calendarEvents = null, weather = null } = {}) {
  const events = finite(calendarEvents);
  const eventDensity = events === null ? null : events / 16; // waking-hours estimate
  if (weatherIsStormy(weather)) return 'STORMY';
  if (eventDensity !== null && eventDensity >= 0.5) return 'OVERLOADED';
  if (score < 60 || hrv < 35) return 'TIRED';
  if (score >= 85 && hrv >= 60 && (events === null || events <= 3)) return 'CHARGED';
  return 'STEADY';
}

export function shapeWellness({ readiness, alarm = null, calendar = null, weather = null } = {}) {
  const normalized = normalizeReadiness(readiness);
  const emotion = emotionFor({
    score: normalized.score,
    hrv: normalized.hrv,
    calendarEvents: calendarEventCount(calendar),
    weather,
  });
  const parts = [`HRV ${normalized.hrv}`, `READY ${normalized.score}`];
  if (alarm) parts.push(`ALARM ${alarm}`);
  return {
    emotion,
    score: normalized.score,
    hrv: normalized.hrv,
    alarm: alarm || null,
    subline: parts.join(' · '),
  };
}

async function fetchLive({ config, now, getModule, log }) {
  const timezone = config?.timezone ?? 'America/Los_Angeles';
  const timeoutMs = config?.fetchTimeoutMs ?? 10_000;
  const readiness = await runJson([EIGHT_SLEEP_CLIENT, 'readiness'], { timezone, timeoutMs });
  let alarm = null;
  try {
    const alarms = await runJson(['-c', ALARM_CLIENT_SCRIPT], { timezone, timeoutMs });
    alarm = nextAlarm(alarms, { now, timezone });
  } catch (error) {
    log?.warn?.(`Eight Sleep alarm fetch failed: ${error?.message ?? error}`);
  }
  return shapeWellness({
    readiness,
    alarm,
    calendar: getModule?.('calendar'),
    weather: getModule?.('weather'),
  });
}

export function setAlarm() {
  if (process.env.ENABLE_EIGHTSLEEP_WRITE !== '1') {
    throw new Error('Eight Sleep alarm writes require ENABLE_EIGHTSLEEP_WRITE=1');
  }
  // Deliberately inert until a write endpoint is validated; UI never calls this.
  return { ok: false, implemented: false };
}

export const wellnessModule = {
  name: 'wellness',
  refreshMs: CACHE_TTL_MS,
  staleAfterMs: 2 * CACHE_TTL_MS,

  async fetch(context) {
    const nowMs = context.now?.getTime?.() ?? Date.now();
    if (cached && nowMs - cachedAt >= 0 && nowMs - cachedAt < CACHE_TTL_MS) return cached;
    const data = await fetchLive(context);
    cached = data;
    cachedAt = nowMs;
    return data;
  },

  mock({ now }) {
    return shapeWellness({
      readiness: { ok: true, score: 78, hrv: 62 },
      alarm: '6:40A',
      now,
    });
  },
};

export default wellnessModule;
