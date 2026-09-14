import { execFile as execFileCallback } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const EIGHT_SLEEP_CLIENT = '/home/hermes/.hermes/scripts/eight_sleep_client.py';
export const EIGHT_SLEEP_ALARMS = 'https://app-api.8slp.net/v2/users/{uid}/alarms';
export const EIGHT_SLEEP_ENV_FILE = '/home/hermes/.hermes/.env';
export const CACHE_TTL_MS = 30 * 60_000;
export const DEFAULT_SLEEP_HOURS = 8;
export const DEFAULT_WAKE_DAY_CUTOFF_HOUR = 4;
// Maanav's standing target bed time; wellness/profile.json overrides it.
export const DEFAULT_TARGET_BEDTIME = '23:30';
export const DEFAULT_WELLNESS_PROFILE_FILE = '/home/maanav/.hermes/wellness/profile.json';
// A recorded night longer than this is a bad session, not a night of sleep.
const MAX_SESSION_HOURS = 16;

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
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
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

function filteredEightSleepEnv(envFile = EIGHT_SLEEP_ENV_FILE) {
  const values = {};
  try {
    const source = readFileSync(envFile, 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const match = /^\s*(EIGHT_SLEEP_EMAIL|EIGHT_SLEEP_PASSWORD)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      let value = match[2];
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      if (value) values[match[1]] = value;
    }
  } catch {
    // The service may use process-level credentials; absence of this optional
    // file is handled by the Eight Sleep client and logged without secrets.
  }
  return values;
}

function childEnv({ timezone, envFile = EIGHT_SLEEP_ENV_FILE } = {}) {
  const env = {
    ...process.env,
    EIGHT_SLEEP_TZ: timezone ?? process.env.EIGHT_SLEEP_TZ ?? 'America/Los_Angeles',
  };
  // Do not replace explicit process credentials. Only add the two narrowly
  // scoped keys the client needs when the service omitted them.
  for (const [key, value] of Object.entries(filteredEightSleepEnv(envFile))) {
    if (!String(env[key] ?? '').trim()) env[key] = value;
  }
  return env;
}

async function runJson(args, { timezone, timeoutMs = 10_000, envFile = EIGHT_SLEEP_ENV_FILE } = {}) {
  const result = await pythonRunner('python3', args, {
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    env: childEnv({ timezone, envFile }),
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
  // score/hrv here are multi-night averages (the readiness window), not last
  // night. `nights` lets the dashboard label them as such.
  const nights = rounded(raw.nights_analyzed, raw.nightsAnalyzed, raw.nights);
  return {
    score: Math.max(0, Math.min(100, score)),
    hrv: Math.max(0, hrv),
    nights: nights !== null && nights > 0 ? nights : null,
  };
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

function localDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!values.year || !values.month || !values.day) return null;
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function localDateString(date, timezone) {
  const parts = localDateParts(date, timezone);
  if (!parts || Object.values(parts).some((value) => !Number.isFinite(value))) return null;
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function dateOnlyShift(dateString, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString ?? ''));
  if (!match) return null;
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return Number.isNaN(shifted.getTime()) ? null : shifted.toISOString().slice(0, 10);
}

// Convert a wall-clock date/time in an IANA timezone to an instant without
// relying on the host machine's timezone. Iterating the displayed offset also
// handles daylight-saving transitions for the normal, non-ambiguous times used
// by daily alarms.
function zonedDateTime(dateString, { hour, minute }, timezone) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString ?? ''));
  if (!dateMatch || !Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  const desired = Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), hour, minute);
  let timestamp = desired;
  for (let i = 0; i < 3; i += 1) {
    const actual = localDateParts(new Date(timestamp), timezone);
    const clock = localTimeParts(new Date(timestamp), timezone);
    if (!actual || !clock) return null;
    const displayed = Date.UTC(actual.year, actual.month - 1, actual.day, clock.hour, clock.minute);
    timestamp += desired - displayed;
  }
  const result = new Date(timestamp);
  return Number.isNaN(result.getTime()) ? null : result;
}

export function formatAlarmTime({ hour, minute }) {
  const suffix = hour >= 12 ? 'P' : 'A';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, '0')}${suffix}`;
}

export function nextAlarm(payload, { now = new Date(), timezone = 'America/Los_Angeles' } = {}) {
  const details = nextAlarmDetails(payload, { now, timezone });
  return details ? formatAlarmTime(details) : null;
}

export function nextAlarmDetails(payload, { now = new Date(), timezone = 'America/Los_Angeles' } = {}) {
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
    options.push({ ...parts, minutes, delta, alarm });
  }
  options.sort((a, b) => a.delta - b.delta);
  if (!options.length) return null;
  const selected = options[0];
  const today = localDateString(now, timezone);
  if (!today) return null;
  const alarmDate = selected.minutes >= currentMinutes ? today : dateOnlyShift(today, 1);
  const at = zonedDateTime(alarmDate, selected, timezone);
  return at ? { ...selected, at, date: alarmDate } : null;
}

function parseDateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function wakeUsableDate(wakeDate, nowDate, timezone, cutoffHour) {
  const today = localDateString(nowDate, timezone);
  if (!today || !wakeDate) return { usable: false, freshness: 'unknown' };
  if (wakeDate === today) return { usable: true, freshness: 'fresh' };
  const current = localTimeParts(nowDate, timezone);
  const yesterday = dateOnlyShift(today, -1);
  if (wakeDate === yesterday && current && current.hour < cutoffHour) {
    return { usable: true, freshness: 'overnight' };
  }
  return { usable: false, freshness: 'stale' };
}

/** Normalize the standalone `wake` command without exposing its raw payload. */
export function normalizeWake(payload, {
  now = new Date(),
  timezone = 'America/Los_Angeles',
  wakeDayCutoffHour = DEFAULT_WAKE_DAY_CUTOFF_HOUR,
} = {}) {
  const raw = assertOk(payload, 'wake');
  const wakeAt = parseDateValue(raw.wake_local) ?? parseDateValue(raw.wake_utc);
  const wakeDate = raw.wake_date_local || (wakeAt ? localDateString(wakeAt, timezone) : null);
  const dateState = wakeAt && wakeAt.getTime() > now.getTime()
    ? { usable: false, freshness: 'future' }
    : wakeUsableDate(wakeDate, now, timezone, wakeDayCutoffHour);
  const incomplete = raw.incomplete === true;
  const freshness = incomplete ? 'incomplete' : dateState.freshness;
  const ageMinutes = finite(raw.minutes_since_wake, Number(raw.hours_since_wake) * 60);
  return {
    at: wakeAt?.toISOString() ?? null,
    date: wakeDate || null,
    source: 'eight_sleep',
    incomplete,
    ageMinutes,
    // Nightly values: this session only, never a multi-night average.
    durationHours: finite(raw.sleep_duration_h, raw.sleep_duration_hours, raw.sleepDurationH),
    score: rounded(raw.sleep_score, raw.sleepScore),
    usable: Boolean(wakeAt && dateState.usable && !incomplete),
    fresh: Boolean(wakeAt && dateState.usable && !incomplete),
    freshness,
  };
}

/** The configured target bed time, defaulting to Maanav's 23:30. */
export function sleepTarget(targetBed = null, source = null, fallback = DEFAULT_TARGET_BEDTIME) {
  const configured = timeParts(targetBed, null);
  const parts = configured ?? timeParts(fallback, null);
  if (!parts) return null;
  return {
    hour: parts.hour,
    minute: parts.minute,
    minutes: parts.hour * 60 + parts.minute,
    clock: formatAlarmTime(parts),
    // Never present a fallback as if the profile said it.
    source: source ?? (configured ? 'configuration' : `default ${fallback}`),
  };
}

function readTargetBedtime(file = DEFAULT_WELLNESS_PROFILE_FILE) {
  if (!file) return null;
  try {
    const profile = JSON.parse(readFileSync(file, 'utf8'));
    return profile?.sleep?.target_bed_local ?? null;
  } catch {
    // A missing or hand-broken profile keeps the built-in target.
    return null;
  }
}

function bedtimeCandidate(payload, { now, timezone, wakeDate }) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const candidates = [
    raw.suggested_bedtime,
    raw.suggestedBedtime,
    raw.recommended_bedtime,
    raw.recommendedBedtime,
    raw.bedtime,
    raw.bedtimeAt,
    raw.sleep_time,
    raw.sleepTime,
    raw.sleep_window?.start,
    raw.sleepWindow?.start,
  ];
  for (const value of candidates) {
    const parsed = parseDateValue(value);
    if (parsed) return parsed;
    const parts = timeParts(value, timezone);
    if (parts && wakeDate) return zonedDateTime(wakeDate, parts, timezone);
  }
  return null;
}

/**
 * Produce the bounded day window consumed by the dashboard. The Eight Sleep
 * wake is only usable for its local waking day (or the previous day before
 * the 4am overnight cutoff). Bedtime is an Eight Sleep recommendation only
 * when one is explicitly present; otherwise it is an estimate from the next
 * daily alarm minus the configured default sleep opportunity. `sleepTarget`
 * is the configured bed time (wellness profile) and is always labeled as a
 * target, never as a measurement.
 */
export function normalizeDayWindow({
  wake = null,
  readiness = null,
  alarms = null,
  now = new Date(),
  timezone = 'America/Los_Angeles',
  defaultSleepHours = DEFAULT_SLEEP_HOURS,
  wakeDayCutoffHour = DEFAULT_WAKE_DAY_CUTOFF_HOUR,
  targetBedtime = null,
  targetBedtimeSource = null,
} = {}) {
  let normalizedWake = null;
  if (wake) {
    try {
      normalizedWake = normalizeWake(wake, { now, timezone, wakeDayCutoffHour });
    } catch {
      // A failed wake command must not erase a usable alarm or readiness result.
      normalizedWake = { at: null, date: null, source: 'eight_sleep', incomplete: false, fresh: false, freshness: 'unavailable', usable: false };
    }
  }
  const target = sleepTarget(targetBedtime, targetBedtimeSource);
  const wakeUsable = normalizedWake?.usable === true;
  const window = {
    wakeAt: wakeUsable ? normalizedWake.at : null,
    bedtimeAt: null,
    day: wakeUsable ? normalizedWake.date : null,
    wakeDate: normalizedWake?.date ?? null,
    bedtimeDate: null,
    wakeSource: normalizedWake?.source ?? 'eight_sleep',
    bedtimeSource: null,
    wakeFresh: normalizedWake?.fresh ?? false,
    wakeFreshness: normalizedWake?.freshness ?? 'unavailable',
    bedtimeFresh: false,
    bedtimeFreshness: 'unavailable',
    estimated: false,
    incomplete: normalizedWake?.incomplete ?? false,
    basis: null,
    sleepHours: null,
    // Last night's own numbers. Stale and incomplete sessions are rejected
    // here so nothing downstream can present them as a fresh night.
    lastNight: wakeUsable ? {
      date: normalizedWake.date ?? null,
      wakeAt: normalizedWake.at,
      durationHours: Number.isFinite(normalizedWake.durationHours)
        && normalizedWake.durationHours > 0
        && normalizedWake.durationHours <= MAX_SESSION_HOURS
        ? Math.round(normalizedWake.durationHours * 10) / 10
        : null,
      score: Number.isFinite(normalizedWake.score) && normalizedWake.score > 0 ? normalizedWake.score : null,
    } : null,
    sleepTargetMinutes: target?.minutes ?? null,
    sleepTargetClock: target?.clock ?? null,
    sleepTargetSource: target?.source ?? 'unavailable',
  };
  if (!wakeUsable) return window;

  const wakeInstant = Date.parse(normalizedWake.at);
  const explicit = bedtimeCandidate(readiness, { now, timezone, wakeDate: normalizedWake.date });
  const explicitAge = explicit && Number.isFinite(wakeInstant)
    ? explicit.getTime() - wakeInstant
    : null;
  if (explicit && explicitAge > 0 && explicitAge <= 24 * 60 * 60_000) {
    window.bedtimeAt = explicit.toISOString();
    window.bedtimeDate = localDateString(explicit, timezone);
    window.bedtimeSource = 'eight_sleep';
    window.bedtimeFresh = true;
    window.bedtimeFreshness = 'current';
    window.basis = 'Eight Sleep recommendation';
    return window;
  }

  const sleepHours = Number(defaultSleepHours);
  const alarm = nextAlarmDetails(alarms, { now, timezone });
  if (!alarm || !Number.isFinite(sleepHours) || sleepHours <= 0) return window;
  const sleepOpportunityMs = sleepHours * 60 * 60_000;
  let bedtime = new Date(alarm.at.getTime() - sleepOpportunityMs);
  // A morning refresh can observe a same-day alarm after the user has already
  // woken. Advance the alarm by one local civil day before subtracting the
  // sleep opportunity so the window always ends after its actual wake.
  if (bedtime.getTime() <= wakeInstant) {
    const nextDate = dateOnlyShift(alarm.date, 1);
    const nextAlarm = nextDate ? zonedDateTime(nextDate, alarm, timezone) : null;
    if (nextAlarm) bedtime = new Date(nextAlarm.getTime() - sleepOpportunityMs);
  }
  if (Number.isNaN(bedtime.getTime())) return window;
  if (bedtime.getTime() <= wakeInstant) return window;
  window.bedtimeAt = bedtime.toISOString();
  window.bedtimeDate = localDateString(bedtime, timezone);
  window.bedtimeSource = 'estimated';
  window.bedtimeFresh = true;
  window.bedtimeFreshness = 'current';
  window.estimated = true;
  window.basis = `next alarm minus ${sleepHours}h default sleep opportunity`;
  window.sleepHours = sleepHours;
  return window;
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
  if (!Number.isFinite(Number(score)) || !Number.isFinite(Number(hrv))) return 'STEADY';
  if (score < 60 || hrv < 35) return 'TIRED';
  if (score >= 85 && hrv >= 60 && (events === null || events <= 3)) return 'CHARGED';
  return 'STEADY';
}

export function shapeWellness({
  readiness = null,
  alarm = null,
  calendar = null,
  weather = null,
  dayWindow = null,
} = {}) {
  let normalized = { score: null, hrv: null };
  if (readiness) {
    try {
      normalized = normalizeReadiness(readiness);
    } catch {
      // Sleep-window data remains useful when readiness metrics are unavailable.
    }
  }
  const emotion = emotionFor({
    score: normalized.score,
    hrv: normalized.hrv,
    calendarEvents: calendarEventCount(calendar),
    weather,
  });
  // Plain words on glass: "SLEEP 88" reads instantly, "READY 88" needed a
  // manual (Maanav, Aug 24). Score is the Eight Sleep sleep-quality score.
  const parts = [];
  if (normalized.hrv !== null) parts.push(`HRV ${normalized.hrv}`);
  if (normalized.score !== null) parts.push(`SLEEP ${normalized.score}`);
  if (alarm) parts.push(`ALARM ${alarm}`);
  return {
    emotion,
    score: normalized.score,
    hrv: normalized.hrv,
    nights: normalized.nights ?? null,
    alarm: alarm || null,
    subline: parts.join(' · '),
    dayWindow,
  };
}

async function fetchLive({ config, now, getModule, log }) {
  const timezone = config?.timezone ?? 'America/Los_Angeles';
  const timeoutMs = config?.fetchTimeoutMs ?? 10_000;
  const envFile = config?.eightSleepEnvFile ?? EIGHT_SLEEP_ENV_FILE;
  const [readinessResult, wakeResult, alarmsResult] = await Promise.allSettled([
    runJson([EIGHT_SLEEP_CLIENT, 'readiness'], { timezone, timeoutMs, envFile }),
    runJson([EIGHT_SLEEP_CLIENT, 'wake'], { timezone, timeoutMs, envFile }),
    runJson(['-c', ALARM_CLIENT_SCRIPT], { timezone, timeoutMs, envFile }),
  ]);
  const readiness = readinessResult.status === 'fulfilled' ? readinessResult.value : null;
  const wake = wakeResult.status === 'fulfilled' ? wakeResult.value : null;
  const alarms = alarmsResult.status === 'fulfilled' ? alarmsResult.value : null;
  const successful = [readiness, wake, alarms].filter((payload) => payload && payload.ok !== false);
  if (!successful.length) {
    const firstError = [readinessResult, wakeResult, alarmsResult]
      .find((result) => result.status === 'rejected')?.reason;
    throw new Error(`Eight Sleep unavailable: ${firstError?.message ?? 'all commands failed'}`);
  }
  for (const [label, result] of [['readiness', readinessResult], ['wake', wakeResult], ['alarm', alarmsResult]]) {
    if (result.status === 'rejected') log?.warn?.(`Eight Sleep ${label} fetch failed: ${result.reason?.message ?? result.reason}`);
  }
  const normalizedReadiness = readiness
    ? (() => {
      try { return normalizeReadiness(readiness); } catch { return null; }
    })()
    : null;
  const alarm = alarms ? nextAlarm(alarms, { now, timezone }) : null;
  // The wellness profile owns the target bed time; the service config and the
  // built-in default are honest fallbacks and are labeled as such.
  const profileTarget = readTargetBedtime(config?.wellness?.profileFile ?? DEFAULT_WELLNESS_PROFILE_FILE);
  const configuredTarget = config?.wellness?.targetBedtime;
  const dayWindow = normalizeDayWindow({
    wake,
    readiness,
    alarms,
    now,
    timezone,
    defaultSleepHours: config?.defaultSleepHours ?? DEFAULT_SLEEP_HOURS,
    wakeDayCutoffHour: config?.wakeDayCutoffHour ?? DEFAULT_WAKE_DAY_CUTOFF_HOUR,
    targetBedtime: profileTarget ?? configuredTarget ?? DEFAULT_TARGET_BEDTIME,
    targetBedtimeSource: profileTarget ? 'wellness profile' : configuredTarget ? 'service config' : `default ${DEFAULT_TARGET_BEDTIME}`,
  });
  return shapeWellness({
    readiness: normalizedReadiness,
    alarm,
    dayWindow,
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
      dayWindow: null,
      now,
    });
  },
};

export default wellnessModule;
