import path from 'node:path';
import { execFile } from 'node:child_process';

export const WORKBOARD_DATA_SOURCE = 'collection://70dff988-c400-416b-ab81-950cea0ea987';
export const WORKBOARD_READER = 'scripts/read_workboard.py';
export const WORKBOARD_STATUSES = Object.freeze([
  'Active',
  'Inbox',
  'Briefed',
  'Agent working',
  'Review',
  'Done',
  'Blocked',
  'Trashed',
]);

const EFFORT_MINUTES = Object.freeze({ '15m': 15, '30m': 30, '60m': 60 });
const COMPLETED_STATUS = /^done$/i;
const TRASHED_STATUS = /^trashed$/i;

export class WorkboardUnavailableError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'WorkboardUnavailableError';
  }
}

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function isoOrNull(value) {
  const text = stringOrNull(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? text : null;
}

function titleFor(row) {
  return stringOrNull(row?.Task ?? row?.title) ?? '(untitled)';
}

function statusFor(row) {
  return stringOrNull(row?.Status ?? row?.status);
}

/** Map the finite effort options; Deep work has no minute value in the schema. */
export function effortMinutes(value) {
  const effort = stringOrNull(value);
  return effort ? EFFORT_MINUTES[effort] ?? null : null;
}

function completionEvidence(row, status) {
  // The Command Board schema has no completion timestamp.  Accept an explicit
  // field if a future read path adds one, but never turn Last activity into a
  // completion claim: it is an activity timestamp, not proof of Done.
  if (!COMPLETED_STATUS.test(status ?? '')) return null;
  return isoOrNull(row?.completedAt ?? row?.['date:Completed:start']);
}

function dueDeltaDays(due, now) {
  if (!due) return null;
  const day = Date.parse(`${due.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z');
  return Number.isFinite(day) && Number.isFinite(today) ? Math.round((day - today) / 86_400_000) : null;
}

/**
 * Derive a glanceable priority from status and due date only.
 * Last activity is intentionally not a priority signal.
 */
export function priorityFor({ status = null, due = null, now = Date.now() } = {}) {
  const normalized = String(status ?? '').trim().toLowerCase();
  const delta = dueDeltaDays(due, now);
  if (normalized === 'done') return { score: 0, reason: 'Done' };
  if (normalized === 'trashed') return { score: 0, reason: 'Trashed' };
  if (normalized === 'review') return { score: 85, reason: 'Ready for review' };
  if (normalized === 'blocked') return { score: 80, reason: 'Blocked' };
  if (delta === 0) return { score: 95, reason: 'Due today' };
  if (delta !== null && delta < 0 && delta >= -7) {
    return { score: Math.max(75, 82 + delta), reason: 'Overdue' };
  }
  if (normalized === 'active' || normalized === 'agent working') {
    return { score: 70, reason: normalized === 'agent working' ? 'Agent working' : 'Active' };
  }
  if (delta !== null && delta > 0 && delta <= 2) {
    return { score: 60 - delta, reason: delta === 1 ? 'Due tomorrow' : 'Due soon' };
  }
  if (delta !== null && delta < -14) return { score: 5, reason: 'Older reminder' };
  return { score: 20, reason: 'Inbox' };
}

/** Convert one SQL row into the stable mirror-facing shape. */
export function normalizeRow(row, { now = Date.now(), index = 0 } = {}) {
  if (!row || typeof row !== 'object') return null;
  const url = stringOrNull(row.url ?? row.URL);
  const id = stringOrNull(row.id) ?? url ?? `workboard-row-${index}`;
  const title = titleFor(row);
  const status = statusFor(row);
  const due = isoOrNull(row['date:Due:start'] ?? row.due);
  const lastActivity = isoOrNull(row['date:Last activity:start'] ?? row.lastActivity);
  const priority = priorityFor({ status, due, now });
  return {
    id,
    url,
    title,
    status,
    due,
    effortMinutes: effortMinutes(row.Effort ?? row.effort),
    area: stringOrNull(row.Lane ?? row.area),
    source: 'work',
    lastActivity,
    completedAt: completionEvidence(row, status),
    priority: priority.score,
    priorityReason: priority.reason,
  };
}

function coverageFor(coverage, itemCount) {
  const truncated = Boolean(coverage?.truncated);
  const complete = coverage?.complete === undefined ? !truncated : Boolean(coverage.complete);
  return {
    complete: complete && !truncated,
    truncated,
    pages: Number.isFinite(coverage?.pages) ? coverage.pages : null,
    fetchedRows: Number.isFinite(coverage?.fetchedRows) ? coverage.fetchedRows : itemCount,
    maxRows: Number.isFinite(coverage?.maxRows) ? coverage.maxRows : null,
    countKind: complete && !truncated ? 'exact' : 'lower-bound',
  };
}

/** Shape a complete or explicitly truncated reader result into feed data. */
export function buildFeed(rows, coverage, { now = Date.now() } = {}) {
  const items = (Array.isArray(rows) ? rows : [])
    .map((row, index) => normalizeRow(row, { now, index }))
    .filter(Boolean);
  const open = items.filter((item) => !COMPLETED_STATUS.test(item.status ?? '') && !TRASHED_STATUS.test(item.status ?? ''));
  const completed = items.filter((item) => COMPLETED_STATUS.test(item.status ?? ''));
  const normalizedCoverage = coverageFor(coverage, items.length);
  const counts = {
    all: items.length,
    open: open.length,
    completed: completed.length,
    exact: normalizedCoverage.complete,
  };
  const weeklyProgress = {
    available: true,
    doneTotal: completed.length,
    completedThisWeek: null,
    completedAtKnown: completed.filter((item) => item.completedAt !== null).length,
    coverage: normalizedCoverage.countKind,
    note: 'No completion timestamp is present in the Command Board schema; Last activity is not completion evidence.',
  };
  return {
    configured: true,
    available: true,
    availability: { available: true, source: 'work', reason: null },
    dataSource: WORKBOARD_DATA_SOURCE,
    items,
    all: items,
    open,
    completed,
    counts,
    baselines: { ...counts },
    coverage: normalizedCoverage,
    weeklyProgress,
    progress: weeklyProgress,
  };
}

export function normalizeRows(rows, options = {}) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => normalizeRow(row, { ...options, index }))
    .filter(Boolean);
}

export const normalizeItems = normalizeRows;

export function parseReaderOutput(stdout) {
  let parsed;
  try {
    parsed = typeof stdout === 'string' ? JSON.parse(stdout) : stdout;
  } catch (error) {
    throw new WorkboardUnavailableError('workboard reader returned invalid JSON', error);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rows)) {
    throw new WorkboardUnavailableError('workboard reader returned no rows');
  }
  return parsed;
}

/** Run the Python bridge with a hard timeout and a bounded output buffer. */
export function runReader({
  script,
  python = 'python3',
  pageSize = 100,
  maxRows = 1000,
  timeoutMs = 10_000,
  execFileImpl = execFile,
} = {}) {
  const reader = script ?? path.resolve('scripts/read_workboard.py');
  const boundedTimeout = Math.max(1_000, Math.min(Number(timeoutMs) || 10_000, 30_000));
  return new Promise((resolve, reject) => {
    execFileImpl(
      python,
      [reader, '--page-size', String(pageSize), '--max-rows', String(maxRows)],
      { timeout: boundedTimeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = error.killed || error.code === 'ETIMEDOUT' ? 'timed out' : 'failed';
          reject(new WorkboardUnavailableError(`workboard reader ${detail}`, error));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export const workboardModule = {
  name: 'workboard',
  refreshMs: 5 * 60_000,
  staleAfterMs: 20 * 60_000,

  async fetch({ config, now = new Date() } = {}) {
    const settings = config?.workboard ?? {};
    const result = await runReader({
      script: settings.readerScript ?? path.join(config?.root ?? process.cwd(), WORKBOARD_READER),
      python: settings.python ?? 'python3',
      pageSize: settings.pageSize ?? 100,
      maxRows: settings.maxRows ?? 1000,
      timeoutMs: settings.timeoutMs ?? config?.fetchTimeoutMs ?? 10_000,
    });
    const payload = parseReaderOutput(result.stdout);
    return buildFeed(payload.rows, payload.coverage, { now: now instanceof Date ? now.getTime() : now });
  },

  mock() {
    return buildFeed([], { complete: true, pages: 0, fetchedRows: 0, maxRows: 0 });
  },
};

export default workboardModule;
