// The night, as one schedule. Shared by the server (src/night-guard.js, which
// keeps the panel dark) and the browser (which picks the layout), so the bed
// time on the glass is always the bed time the hardware obeys.
//
//   day ─ winddown ─ bedtime ─ night ──────────── morning ─ day
//         bed−2h     bed       bed+grace          wake      wake+3h
//
// `night` is the only phase with teeth: presence no longer wakes the panel.
// Pure: no network, DOM or clock reads.
import { fresh, instant, dateKey, timeLabel, MINUTE } from './attention.js';
import { localInstant, firstMeetingTomorrow } from './day-model.js';

export const SLEEP_DEFAULTS = Object.freeze({
  bedtime: { hour: 0, minute: 30 },  // DISPLAY_OFF_TIME: the latest planned bed time
  sleepHours: 8,
  meetingPrepMinutes: 30,            // bed = first meeting − (sleep + prep)
  lockGraceMinutes: 30,              // bedtime → night: time to actually get into bed
  winddownMinutes: 120,
  morningMinutes: 180,
});

const HOUR = 60 * MINUTE;
const nextDay = (day) => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const previousDay = (day) => new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

function calendarReady(calendar, now) {
  return fresh(calendar, 'calendar', now)
    && calendar?.data?.configured !== false
    && calendar?.data?.coverageComplete !== false;
}

/** The latest planned bed time for the night that starts on civil `day`. */
function defaultBedAt(day, zone, { hour, minute }) {
  // 00:30 belongs to the following civil date; 23:30 to the same one.
  return localInstant(hour < 12 ? nextDay(day) : day, hour, zone, minute);
}

/** Enabled Eight Sleep alarm, if it rings within 16h after bed. */
function alarmAfter(wellness, bedAt, now) {
  if (!fresh(wellness, 'wellness', now)) return null;
  const at = instant(wellness.data?.alarmAt);
  if (!Number.isFinite(at)) return null;
  for (const candidate of [at, at + 24 * HOUR, at - 24 * HOUR]) {
    if (candidate > bedAt && candidate - bedAt <= 16 * HOUR) return candidate;
  }
  return null;
}

/** One night, anchored on the civil date its evening belongs to. */
export function nightFor(day, { zone, calendar, wellness, now, options = SLEEP_DEFAULTS }) {
  const o = { ...SLEEP_DEFAULTS, ...options };
  const latest = defaultBedAt(day, zone, o.bedtime);
  // firstMeetingTomorrow reads "tomorrow" off the clock it is given; noon on
  // `day` makes that the morning this night ends in.
  const noon = localInstant(day, 12, zone);
  const meeting = calendarReady(calendar, now) ? firstMeetingTomorrow(calendar, noon, zone) : null;
  const meetingAt = meeting ? instant(meeting.start) : NaN;
  const byMeeting = meetingAt - (o.sleepHours * HOUR + o.meetingPrepMinutes * MINUTE);
  // A late first meeting never licenses a later bed time than the default.
  const bedAt = Number.isFinite(byMeeting) && byMeeting < latest ? byMeeting : latest;
  const alarmAt = alarmAfter(wellness, bedAt, now);
  const wakeAt = alarmAt ?? bedAt + o.sleepHours * HOUR;
  return {
    night: day,
    winddownAt: bedAt - o.winddownMinutes * MINUTE,
    bedAt,
    lockAt: bedAt + o.lockGraceMinutes * MINUTE,
    wakeAt,
    morningUntil: wakeAt + o.morningMinutes * MINUTE,
    bedBasis: Number.isFinite(byMeeting) && byMeeting < latest ? 'first meeting' : 'default',
    wakeBasis: alarmAt ? 'alarm' : 'plan',
    firstMeeting: meeting ? { title: meeting.title, at: meetingAt } : null,
  };
}

export function phaseAt(n, now) {
  if (now < n.winddownAt) return 'day';
  if (now < n.bedAt) return 'winddown';
  if (now < n.lockAt) return 'bedtime';
  if (now < n.wakeAt) return 'night';
  if (now < n.morningUntil) return 'morning';
  return 'day';
}

/**
 * The schedule that governs `now`: last night's until its morning is over,
 * tonight's after that. `released` is 'manual' when a person turned the panel
 * on during the night; nothing ambient (lights, getting up) ends it early.
 */
export function sleepSchedule({ now = Date.now(), zone = 'America/Los_Angeles', calendar, wellness,
  options = SLEEP_DEFAULTS, released = null } = {}) {
  const today = dateKey(now, zone);
  const context = { zone, calendar, wellness, now, options };
  const last = nightFor(previousDay(today), context);
  const n = now < last.morningUntil ? last : nightFor(today, context);
  const phase = phaseAt(n, now);
  const releasedBy = phase === 'night' ? released : null;
  return {
    ...n,
    phase,
    locked: phase === 'night' && !releasedBy,
    released: releasedBy,
    // "Sleep now and you get…" — the honest bedtime number.
    sleepIfNowMinutes: ['winddown', 'bedtime', 'night'].includes(phase)
      ? Math.max(0, Math.round((n.wakeAt - now) / MINUTE)) : null,
  };
}

/** ISO projection for /api/state; the browser reads times back with instant(). */
export function publicSchedule(s, zone) {
  if (!s) return null;
  const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);
  return {
    phase: s.phase,
    night: s.night,
    winddownAt: iso(s.winddownAt),
    bedAt: iso(s.bedAt),
    lockAt: iso(s.lockAt),
    wakeAt: iso(s.wakeAt),
    morningUntil: iso(s.morningUntil),
    bedBasis: s.bedBasis,
    wakeBasis: s.wakeBasis,
    firstMeeting: s.firstMeeting ? { title: s.firstMeeting.title, at: iso(s.firstMeeting.at) } : null,
    locked: s.locked,
    released: s.released,
    label: `${timeLabel(s.bedAt, zone)} → ${timeLabel(s.wakeAt, zone)}`,
  };
}

/** Read a /api/state `sleep` block back into instants. */
export function scheduleFromState(block) {
  if (!block?.phase) return null;
  const t = (v) => instant(v);
  return {
    ...block,
    winddownAt: t(block.winddownAt), bedAt: t(block.bedAt), lockAt: t(block.lockAt),
    wakeAt: t(block.wakeAt), morningUntil: t(block.morningUntil),
    firstMeeting: block.firstMeeting ? { ...block.firstMeeting, at: t(block.firstMeeting.at) } : null,
  };
}
