// All date math goes through Intl — no moment, no date-fns.
// The server reasons in a configured IANA timezone; the browser clock uses the
// Pi's own local time so it never depends on this file (or the network).

const formatters = new Map();

function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of `date` as seen in `timeZone`. */
export function zonedParts(date, timeZone) {
  const out = {};
  for (const { type, value } of formatter(timeZone).formatToParts(date)) {
    if (type !== 'literal') out[type] = value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

/** Offset of `timeZone` from UTC at `date`, in minutes (east positive). */
export function tzOffsetMinutes(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const whole = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - whole) / 60_000);
}

/**
 * Instant at which the given wall-clock time occurs in `timeZone`.
 * Two passes so DST transitions land on the right side of the shift.
 */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const guessed = tzOffsetMinutes(new Date(naive), timeZone);
  const refined = tzOffsetMinutes(new Date(naive - guessed * 60_000), timeZone);
  return new Date(naive - refined * 60_000);
}

export function startOfLocalDay(date, timeZone, dayOffset = 0) {
  const p = zonedParts(date, timeZone);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day + dayOffset }, timeZone);
}

const pad = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" in `timeZone`. */
export function localDateKey(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "HH:MM" 24h in `timeZone`. */
export function localTimeLabel(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** RFC3339 with explicit offset, e.g. 2026-08-23T00:00:00-07:00 (Google's timeMin/timeMax). */
export function isoWithOffset(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const off = formatOffset(tzOffsetMinutes(date, timeZone));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${off}`;
}

/** Next occurrence of local `hour:minute` strictly after `from`. */
export function nextLocalTime(from, timeZone, hour, minute = 0) {
  const p = zonedParts(from, timeZone);
  let at = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour, minute }, timeZone);
  if (at.getTime() <= from.getTime()) {
    at = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day + 1, hour, minute }, timeZone);
  }
  return at;
}

/**
 * Day bucket for a rotation that happens at `rotateHour` local time: anything
 * before 04:00 still belongs to the previous day's quote.
 */
export function rotationDayKey(date, timeZone, rotateHour = 4) {
  return localDateKey(new Date(date.getTime() - rotateHour * 3_600_000), timeZone);
}

/** Parses a floating local timestamp ("2026-08-23T14:00") as an instant in `timeZone`. */
export function parseFloatingLocal(value, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value ?? ''));
  if (!m) return null;
  return zonedTimeToUtc(
    { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] },
    timeZone,
  );
}
