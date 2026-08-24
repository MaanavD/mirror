import { zonedParts } from '../time.js';
import { calendarModule } from './calendar.js';

const pad = (n) => String(n).padStart(2, '0');

/** "3:00 PM" 12h in `timeZone`. */
export function formatTime12h(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const suffix = p.hour < 12 ? 'AM' : 'PM';
  const h12 = p.hour % 12 || 12;
  return `${h12}:${pad(p.minute)} ${suffix}`;
}

/** The timed event currently in progress (started, not yet ended). */
export function currentEvent(events, nowMs) {
  return events.find((e) => !e.allDay && e.startMs <= nowMs && e.endMs > nowMs) ?? null;
}

/** The next timed event strictly after `now`. */
export function nextEvent(events, nowMs) {
  return (
    events
      .filter((e) => !e.allDay && e.startMs > nowMs)
      .sort((a, b) => a.startMs - b.startMs)[0] ?? null
  );
}

/**
 * Derives the NOW / NEXT focus line from calendar data.
 * Returns null when there is nothing to show (the line simply is not painted).
 */
export function shapeFocus(calendarData, { now = new Date(), timeZone = 'UTC' } = {}) {
  const events = Array.isArray(calendarData?.today) ? calendarData.today : [];
  const nowMs = now.getTime();
  const current = currentEvent(events, nowMs);
  const next = nextEvent(events, nowMs);
  if (!current && !next) return null;

  return {
    now: current
      ? { title: current.title, ends: formatTime12h(new Date(current.endMs), timeZone) }
      : null,
    next: next
      ? {
          title: next.title,
          inMin: Math.max(0, Math.round((next.startMs - nowMs) / 60_000)),
        }
      : null,
  };
}

export const focusModule = {
  name: 'focus',
  refreshMs: 60 * 1000,
  staleAfterMs: 20 * 60_000,

  async fetch({ config, now, getModule }) {
    const cal = getModule?.('calendar')?.data ?? null;
    return shapeFocus(cal, { now, timeZone: config.timezone });
  },

  // Mock pulls a synthesized agenda so the line renders offline for review.
  mock({ config, now, getModule }) {
    const cal =
      getModule?.('calendar')?.data ??
      calendarModule.mock({ config: { timezone: config?.timezone }, now });
    return shapeFocus(cal, { now, timeZone: config?.timezone });
  },
};

export default focusModule;
