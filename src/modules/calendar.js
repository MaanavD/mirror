import { fetchJson } from '../http.js';
import { localDateKey, localTimeLabel, startOfLocalDay, zonedTimeToUtc } from '../time.js';
import { GoogleAuth } from './google-auth.js';

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars';

const TODAY_CAP = 6;
const TOMORROW_CAP = 3;

function allDayInstant(dateString, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString ?? ''));
  if (!m) return null;
  return zonedTimeToUtc({ year: +m[1], month: +m[2], day: +m[3] }, timeZone);
}

/** Google event -> flat shape, or null if it should never be shown. */
export function normalizeEvent(item, timeZone) {
  if (!item || item.status === 'cancelled') return null;
  const declined = item.attendees?.some((a) => a.self && a.responseStatus === 'declined');
  if (declined) return null;

  const allDay = Boolean(item.start?.date);
  const start = allDay
    ? allDayInstant(item.start.date, timeZone)
    : new Date(item.start?.dateTime ?? NaN);
  if (!start || Number.isNaN(start.getTime())) return null;

  // All-day `end.date` is exclusive; timed events may legitimately lack an end.
  const end = allDay
    ? (allDayInstant(item.end?.date, timeZone) ?? new Date(start.getTime() + 86_400_000))
    : new Date(item.end?.dateTime ?? item.start?.dateTime ?? start);

  return {
    id: item.id ?? `${item.summary ?? 'event'}-${start.toISOString()}`,
    title: (item.summary ?? '(untitled)').trim() || '(untitled)',
    allDay,
    start: start.toISOString(),
    end: end.toISOString(),
    startMs: start.getTime(),
    endMs: end.getTime(),
    timeLabel: allDay ? 'all day' : localTimeLabel(start, timeZone),
    calendarId: item.calendarId ?? null,
  };
}

function inWindow(event, from, to) {
  // All-day (and multi-day) events count for every day they touch; timed events
  // belong to the day they start in.
  if (event.allDay) return event.startMs < to && event.endMs > from;
  return event.startMs >= from && event.startMs < to;
}

const byStart = (a, b) =>
  Number(a.allDay ? 0 : 1) - Number(b.allDay ? 0 : 1) ||
  a.startMs - b.startMs ||
  a.title.localeCompare(b.title);

/** Merges every calendar's events into a today/tomorrow agenda. */
export function shapeAgenda(items, { now = new Date(), timeZone = 'UTC', calendars = 0 } = {}) {
  const t0 = startOfLocalDay(now, timeZone).getTime();
  const t1 = startOfLocalDay(now, timeZone, 1).getTime();
  const t2 = startOfLocalDay(now, timeZone, 2).getTime();
  const nowMs = now.getTime();

  const seen = new Set();
  const events = [];
  for (const item of items ?? []) {
    const event = normalizeEvent(item, timeZone);
    if (!event) continue;
    const key = `${event.id}:${event.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }

  const pick = (from, to, cap) => {
    const all = events.filter((e) => inWindow(e, from, to)).sort(byStart);
    return {
      events: all.slice(0, cap).map((e) => ({
        id: e.id,
        title: e.title,
        allDay: e.allDay,
        start: e.start,
        end: e.end,
        timeLabel: e.timeLabel,
        past: !e.allDay && e.endMs <= nowMs,
        calendarId: e.calendarId,
      })),
      more: Math.max(0, all.length - cap),
    };
  };

  const today = pick(t0, t1, TODAY_CAP);
  const tomorrow = pick(t1, t2, TOMORROW_CAP);

  return {
    configured: true,
    calendars,
    timeZone,
    today: today.events,
    todayMore: today.more,
    tomorrow: tomorrow.events,
    tomorrowMore: tomorrow.more,
  };
}

let auth = null;

function authFor(config) {
  if (!auth) {
    auth = new GoogleAuth({
      clientSecretFile: config.google.clientSecretFile,
      tokenFile: config.google.tokenFile,
      timeoutMs: config.fetchTimeoutMs,
    });
  }
  return auth;
}

async function fetchCalendar(id, { accessToken, timeMin, timeMax, timeoutMs }) {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });
  const url = `${CALENDAR_API}/${encodeURIComponent(id)}/events?${params}`;
  const payload = await fetchJson(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    timeoutMs,
  });
  return (payload.items ?? []).map((item) => ({ ...item, calendarId: id }));
}

export function mockAgenda({ now = new Date(), timeZone = 'UTC' } = {}) {
  const t0 = startOfLocalDay(now, timeZone).getTime();
  const t1 = startOfLocalDay(now, timeZone, 1).getTime();
  const at = (base, h, m = 0) => new Date(base + h * 3_600_000 + m * 60_000).toISOString();
  const dayOf = (base) => localDateKey(new Date(base), timeZone);

  const items = [
    { id: 'm1', summary: 'nyx offsite — all hands', start: { date: dayOf(t0) }, end: { date: dayOf(t1) } },
    { id: 'm2', summary: 'lift — pull', start: { dateTime: at(t0, 6, 30) }, end: { dateTime: at(t0, 7, 45) } },
    { id: 'm3', summary: 'standup', start: { dateTime: at(t0, 9, 15) }, end: { dateTime: at(t0, 9, 30) } },
    { id: 'm4', summary: 'design review — mirror', start: { dateTime: at(t0, 11, 0) }, end: { dateTime: at(t0, 12, 0) } },
    { id: 'm5', summary: 'lunch w/ priya', start: { dateTime: at(t0, 12, 30) }, end: { dateTime: at(t0, 13, 30) } },
    { id: 'm6', summary: 'flux 2 eval sync', start: { dateTime: at(t0, 15, 0) }, end: { dateTime: at(t0, 16, 0) } },
    { id: 'm7', summary: 'dinner — pike & pine', start: { dateTime: at(t0, 19, 30) }, end: { dateTime: at(t0, 21, 0) } },
    { id: 'm8', summary: 'dentist', start: { dateTime: at(t1, 8, 20) }, end: { dateTime: at(t1, 9, 0) } },
    { id: 'm9', summary: 'sf flight — SEA→SFO', start: { dateTime: at(t1, 13, 5) }, end: { dateTime: at(t1, 15, 15) } },
    { id: 'm10', summary: 'quarter close', start: { date: dayOf(t1) }, end: { date: dayOf(t1 + 86_400_000) } },
    { id: 'm11', summary: 'late night deploy window', start: { dateTime: at(t1, 22, 0) }, end: { dateTime: at(t1, 23, 0) } },
  ].map((item) => ({ ...item, calendarId: 'mock@group.calendar.google.com' }));

  return shapeAgenda(items, { now, timeZone, calendars: 2 });
}

export const calendarModule = {
  name: 'calendar',
  refreshMs: 5 * 60_000,
  staleAfterMs: 20 * 60_000,

  async fetch({ config, now, log }) {
    const ids = config.google.calendarIds;
    if (ids.length === 0) {
      return { configured: false, calendars: 0, timeZone: config.timezone, today: [], todayMore: 0, tomorrow: [], tomorrowMore: 0 };
    }

    const accessToken = await authFor(config).accessToken();
    const timeMin = startOfLocalDay(now, config.timezone).toISOString();
    const timeMax = startOfLocalDay(now, config.timezone, 2).toISOString();

    const results = await Promise.allSettled(
      ids.map((id) => fetchCalendar(id, { accessToken, timeMin, timeMax, timeoutMs: config.fetchTimeoutMs })),
    );

    const items = [];
    let ok = 0;
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        ok += 1;
        items.push(...result.value);
      } else {
        // One bad calendar id must not blank the whole agenda.
        log.warn(`calendar ${ids[i]} failed: ${result.reason?.message ?? result.reason}`);
        if (result.reason?.status === 401) authFor(config).invalidate();
      }
    }
    if (ok === 0) throw new Error(`all ${ids.length} calendar(s) failed`);

    return shapeAgenda(items, { now, timeZone: config.timezone, calendars: ok });
  },

  mock({ config, now }) {
    return mockAgenda({ now, timeZone: config.timezone });
  },
};

export default calendarModule;
