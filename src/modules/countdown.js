import { fetchJson } from '../http.js';
import { localDateKey, startOfLocalDay, zonedTimeToUtc } from '../time.js';
import { GoogleAuth } from './google-auth.js';

export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars';

// How far ahead a flight is worth counting down to. Past ~4 months a number of
// days reads as noise, not anticipation.
const FLIGHT_HORIZON_DAYS = 120;

// Fixed milestones live in COUNTDOWN_EVENTS ("label:YYYY-MM-DD,label:date").
// A milestone disappears on its own once the date passes.
export function parseMilestones(raw) {
  const out = [];
  for (const part of String(raw ?? '').split(',')) {
    const m = /^\s*([^:]+):(\d{4})-(\d{2})-(\d{2})\s*$/.exec(part);
    if (!m) continue;
    out.push({ label: m[1].trim(), date: `${m[2]}-${m[3]}-${m[4]}` });
  }
  return out;
}

// "Flight to San Francisco (AC 739)" -> "SAN FRANCISCO". Flighty writes this
// shape into the calendar; anything else falls back to the raw title.
export function flightLabel(summary) {
  const m = /flight to ([^(]+)/i.exec(String(summary ?? ''));
  return (m ? m[1] : String(summary ?? 'flight')).trim().toUpperCase();
}

export function daysUntil(dateKey, now, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return null;
  const target = zonedTimeToUtc({ year: +m[1], month: +m[2], day: +m[3] }, timeZone);
  const today = startOfLocalDay(now, timeZone);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export function shapeCountdown({ flight, milestones }, { now, timeZone }) {
  const items = [];

  if (flight) {
    const days = daysUntil(localDateKey(new Date(flight.startMs), timeZone), now, timeZone);
    if (days !== null && days >= 0 && days <= FLIGHT_HORIZON_DAYS) {
      items.push({ kind: 'flight', label: flightLabel(flight.summary), days });
    }
  }

  for (const stone of milestones) {
    const days = daysUntil(stone.date, now, timeZone);
    if (days !== null && days >= 0) {
      items.push({ kind: 'milestone', label: stone.label.toUpperCase(), days });
    }
  }

  return { items };
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

async function nextFlight(config, now) {
  const ids = config.google.calendarIds;
  if (ids.length === 0) return null;

  const accessToken = await authFor(config).accessToken();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + FLIGHT_HORIZON_DAYS * 86_400_000).toISOString();

  const results = await Promise.allSettled(ids.map(async (id) => {
    const params = new URLSearchParams({
      timeMin, timeMax, q: 'flight', singleEvents: 'true', orderBy: 'startTime', maxResults: '5',
    });
    const payload = await fetchJson(`${CALENDAR_API}/${encodeURIComponent(id)}/events?${params}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      timeoutMs: config.fetchTimeoutMs,
    });
    return payload.items ?? [];
  }));

  let best = null;
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const item of result.value) {
      if (item.status === 'cancelled') continue;
      if (!/flight to /i.test(item.summary ?? '')) continue;
      const start = new Date(item.start?.dateTime ?? item.start?.date ?? NaN);
      if (Number.isNaN(start.getTime()) || start.getTime() < now.getTime()) continue;
      if (!best || start.getTime() < best.startMs) {
        best = { summary: item.summary, startMs: start.getTime() };
      }
    }
  }
  return best;
}

export const countdownModule = {
  name: 'countdown',
  refreshMs: 60 * 60_000,
  staleAfterMs: 6 * 60 * 60_000,

  async fetch({ config, now }) {
    const flight = await nextFlight(config, now).catch(() => null);
    return shapeCountdown(
      { flight, milestones: config.countdown.milestones },
      { now, timeZone: config.timezone },
    );
  },

  mock({ config, now }) {
    return shapeCountdown(
      {
        flight: { summary: 'Flight to San Francisco (AC 739)', startMs: now.getTime() + 8 * 86_400_000 },
        milestones: config.countdown.milestones.length
          ? config.countdown.milestones
          : [{ label: 'sf move', date: localDateKey(new Date(now.getTime() + 53 * 86_400_000), config.timezone) }],
      },
      { now, timeZone: config.timezone },
    );
  },
};

export default countdownModule;
