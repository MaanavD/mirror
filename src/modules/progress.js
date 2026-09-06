import fsp from 'node:fs/promises';
import path from 'node:path';
import { zonedParts, zonedTimeToUtc } from '../time.js';

export const PROGRESS_LEDGER_FILE = 'progress-ledger.json';
export const PROGRESS_SOURCES = Object.freeze(['notion', 'workboard']);
const LEDGER_VERSION = 1;
const MAX_SOURCE_AGE_MS = 20 * 60_000;
const DONE = /^(done|completed)$/i;
const TRASHED = /^trashed$/i;

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value ?? NaN);
  return Number.isNaN(date.getTime()) ? null : date;
}

function iso(value) {
  const date = asDate(value);
  return date ? date.toISOString() : null;
}

function sourceEntry(name, entry, now) {
  const data = entry?.data;
  if (!entry) return { source: name, available: false, reason: 'missing', stale: false, configured: false, complete: false };
  if (entry.stale) return { source: name, available: false, reason: 'stale', stale: true, configured: data?.configured !== false, complete: false };
  if (!data || data.configured === false) {
    return { source: name, available: false, reason: 'unconfigured', stale: false, configured: false, complete: false };
  }
  if (data.available === false) {
    return { source: name, available: false, reason: 'unavailable', stale: false, configured: true, complete: false };
  }
  if (data.truncated === true) {
    return { source: name, available: false, reason: 'truncated', stale: false, configured: true, complete: false };
  }
  if (name === 'notion' && !Array.isArray(data.completed)) {
    return { source: name, available: false, reason: 'missing-completed', stale: false, configured: true, complete: false };
  }
  const coverage = data.coverage;
  if (coverage?.truncated || coverage?.complete === false) {
    return { source: name, available: false, reason: 'truncated', stale: false, configured: true, complete: false };
  }
  const fetchedAt = asDate(entry.fetchedAt);
  const current = asDate(now) ?? new Date();
  if (!fetchedAt || current.getTime() - fetchedAt.getTime() > MAX_SOURCE_AGE_MS) {
    return { source: name, available: false, reason: 'stale', stale: true, configured: true, complete: false };
  }
  return { source: name, available: true, reason: null, stale: false, configured: true, complete: true };
}

function itemKey(source, item, index) {
  const value = item?.id ?? item?.url ?? item?.title;
  return `${source}:${value == null || String(value).trim() === '' ? `row-${index}` : String(value)}`;
}

function statusOf(item, forcedDone = false) {
  if (forcedDone || item?.done === true) return 'done';
  const status = String(item?.status ?? '').trim().toLowerCase();
  if (DONE.test(status)) return 'done';
  if (TRASHED.test(status)) return 'trashed';
  return 'open';
}

function sourceItems(name, data) {
  if (!data || typeof data !== 'object') return [];
  if (name === 'workboard') {
    const items = Array.isArray(data.all) ? data.all : (Array.isArray(data.items) ? data.items : []);
    return items.filter((item) => item && typeof item === 'object').map((item) => ({ item, forcedDone: false }));
  }

  // Personal Notion data normally has open items in `items`; accept explicit
  // open/completed arrays too so a future adapter can expose both halves.
  const byKey = new Map();
  const add = (item, forcedDone = false, index = 0) => {
    if (!item || typeof item !== 'object') return;
    const key = itemKey(name, item, index);
    byKey.set(key, { item, forcedDone });
  };
  (Array.isArray(data.items) ? data.items : []).forEach((item, index) => add(item, false, index));
  (Array.isArray(data.open) ? data.open : []).forEach((item, index) => add(item, false, index));
  (Array.isArray(data.completed) ? data.completed : []).forEach((item, index) => add(item, true, index));
  return [...byKey.values()];
}

function currentStates(name, data) {
  const states = new Map();
  sourceItems(name, data).forEach(({ item, forcedDone }, index) => {
    const key = itemKey(name, item, index);
    states.set(key, {
      status: statusOf(item, forcedDone),
      title: String(item.title ?? item.name ?? '(untitled)').trim() || '(untitled)',
    });
  });
  return states;
}

function emptyLedger() {
  return { version: LEDGER_VERSION, sources: {} };
}

function normalizeLedger(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== LEDGER_VERSION) return emptyLedger();
  const sources = {};
  for (const name of PROGRESS_SOURCES) {
    const source = raw.sources?.[name];
    if (!source || typeof source !== 'object') continue;
    const known = {};
    for (const [key, value] of Object.entries(source.known ?? {})) {
      if (!value || typeof value !== 'object') continue;
      known[key] = {
        status: ['open', 'done', 'trashed'].includes(value.status) ? value.status : 'open',
        title: String(value.title ?? '(untitled)'),
      };
    }
    const events = Array.isArray(source.events)
      ? source.events.filter((event) => event && typeof event === 'object' && iso(event.observedAt))
        .map((event) => ({
          key: String(event.key ?? ''),
          title: String(event.title ?? '(untitled)'),
          source: name,
          observedAt: iso(event.observedAt),
        })).filter((event) => event.key)
      : [];
    sources[name] = {
      trackingSince: iso(source.trackingSince),
      baselineDone: Number.isFinite(source.baselineDone) ? Math.max(0, Math.floor(source.baselineDone)) : 0,
      known,
      events,
    };
  }
  return { version: LEDGER_VERSION, sources };
}

export function ledgerPath(dataDir) {
  return path.join(path.resolve(dataDir || path.resolve('data')), PROGRESS_LEDGER_FILE);
}

export async function readLedger(file) {
  try {
    return normalizeLedger(JSON.parse(await fsp.readFile(file, 'utf8')));
  } catch {
    return emptyLedger();
  }
}

export async function writeLedger(file, ledger) {
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.mkdir(directory, { recursive: true });
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(normalizeLedger(ledger), null, 2)}\n`, 'utf8');
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Monday 00:00 and the following Monday in the requested local timezone. */
export function weekRange(now, timeZone) {
  const date = asDate(now) ?? new Date();
  const parts = zonedParts(date, timeZone);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  const dayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday];
  const daysBack = (dayIndex + 6) % 7;
  const start = zonedTimeToUtc({ year: parts.year, month: parts.month, day: parts.day - daysBack }, timeZone);
  const endParts = zonedParts(start, timeZone);
  const end = zonedTimeToUtc({ year: endParts.year, month: endParts.month, day: endParts.day + 7 }, timeZone);
  return { start, end };
}

export function localWeekStart(now, timeZone) {
  return weekRange(now, timeZone).start.toISOString();
}

function observeSource(ledger, name, snapshot, now) {
  if (!snapshot.available) return false;
  const data = snapshot.entry.data;
  const current = currentStates(name, data);
  const observedAt = iso(now);
  let source = ledger.sources[name];
  let changed = false;

  if (!source) {
    const known = {};
    let baselineDone = 0;
    for (const [key, state] of current) {
      known[key] = state;
      if (state.status === 'done') baselineDone += 1;
    }
    ledger.sources[name] = {
      trackingSince: observedAt,
      baselineDone,
      known,
      events: [],
    };
    return true;
  }

  for (const [key, state] of current) {
    const previous = source.known[key];
    // A row first seen as Done is baseline, including rows added after the
    // initial baseline. Only an observed open -> Done transition counts.
    if (previous?.status === 'open' && state.status === 'done') {
      source.events.push({ key, title: state.title, source: name, observedAt });
      changed = true;
    }
    if (!previous) {
      if (state.status === 'done') source.baselineDone += 1;
      changed = true;
    } else if (previous.status !== state.status || previous.title !== state.title) changed = true;
    source.known[key] = state;
  }
  return changed;
}

function outputFor(ledger, snapshots, now, timeZone) {
  const { start, end } = weekRange(now, timeZone);
  const startMs = start.getTime();
  const endMs = end.getTime();
  const events = [];
  let baselineDone = 0;
  let baselineKnown = 0;
  const sourceTrackingSince = {};
  for (const name of PROGRESS_SOURCES) {
    const source = ledger.sources[name];
    if (!source) continue;
    baselineDone += source.baselineDone;
    baselineKnown += 1;
    sourceTrackingSince[name] = source.trackingSince;
    for (const event of source.events) {
      const at = Date.parse(event.observedAt);
      if (Number.isFinite(at) && at >= startMs && at < endMs) events.push(event);
    }
  }
  const latest = new Map();
  for (const event of events) {
    const source = ledger.sources[event.source];
    const current = source?.known?.[event.key];
    // A reopen is evidence that the prior completion is no longer a current
    // completed task. A later open -> Done transition creates a new event.
    if (current?.status !== 'done') continue;
    const previous = latest.get(event.key);
    if (!previous || event.observedAt > previous.observedAt) latest.set(event.key, event);
  }
  const displayed = [...latest.values()];
  displayed.sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.source.localeCompare(b.source) || a.key.localeCompare(b.key));
  const coverageSources = Object.fromEntries(snapshots.map((snapshot) => [snapshot.name, {
    available: snapshot.available,
    stale: snapshot.stale,
    configured: snapshot.configured,
    complete: snapshot.complete,
    reason: snapshot.reason,
  }]));
  const trackingValues = Object.values(sourceTrackingSince).filter(Boolean).sort();
  return {
    weekCount: displayed.length,
    baselineDone,
    baselineKnown: baselineKnown === PROGRESS_SOURCES.length,
    trackingSince: trackingValues[0] ?? null,
    sourceTrackingSince,
    timeZone,
    items: displayed.map(({ title, source, observedAt }) => ({ title, source, observedAt })),
    coverage: {
      complete: snapshots.every((snapshot) => snapshot.available),
      sources: coverageSources,
      weekStart: start.toISOString(),
      weekEnd: end.toISOString(),
    },
  };
}

export const progressModule = {
  name: 'progress',
  refreshMs: 60_000,
  staleAfterMs: 20 * 60_000,

  async fetch({ config = {}, getModule = () => null, now = new Date() } = {}) {
    const timeZone = config.timezone
      ?? getModule('calendar')?.data?.timeZone
      ?? 'America/Los_Angeles';
    const snapshots = PROGRESS_SOURCES.map((name) => {
      const status = sourceEntry(name, getModule(name), now);
      return { name, ...status, entry: getModule(name) };
    });
    const file = ledgerPath(config.dataDir);
    const ledger = await readLedger(file);
    let changed = false;
    for (const snapshot of snapshots) changed = observeSource(ledger, snapshot.name, snapshot, now) || changed;
    if (changed) await writeLedger(file, ledger);
    return outputFor(ledger, snapshots, now, timeZone);
  },
};

export default progressModule;
