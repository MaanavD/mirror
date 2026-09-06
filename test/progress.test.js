import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PROGRESS_LEDGER_FILE,
  ledgerPath,
  localWeekStart,
  progressModule,
  readLedger,
  weekRange,
} from '../src/modules/progress.js';

const TZ = 'America/Los_Angeles';
const CONFIG_TIMEZONE = { timezone: TZ };
const baselineAt = new Date('2026-09-03T18:00:00Z');

function entry(data, { stale = false } = {}) {
  return { data, stale };
}

function notion(items = [], completed = []) {
  return { configured: true, items, completed };
}

function workboard(items, coverage = { complete: true, truncated: false }) {
  return { configured: true, available: true, all: items, coverage };
}

function context({ notionData, workData, notionStale = false, workStale = false, dataDir, fetchedAt = baselineAt }) {
  const modules = {
    notion: { ...entry(notionData, { stale: notionStale }), fetchedAt: new Date(fetchedAt).toISOString() },
    workboard: { ...entry(workData, { stale: workStale }), fetchedAt: new Date(fetchedAt).toISOString() },
  };
  return {
    config: { ...CONFIG_TIMEZONE, dataDir },
    getModule(name) { return modules[name] ?? null; },
  };
}

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'mirror-progress-'));
}

test('module has the progress cadence and current-week shape', async () => {
  const dir = await tempDir();
  try {
    assert.equal(progressModule.name, 'progress');
    assert.equal(progressModule.refreshMs, 60_000);
    assert.equal(progressModule.staleAfterMs, 20 * 60_000);
    const out = await progressModule.fetch({
      ...context({
        dataDir: dir,
        notionData: notion([{ id: 'p-open', title: 'Open personal task' }]),
        workData: workboard([{ id: 'w-done', title: 'Existing Done', status: 'Done' }]),
      }),
      now: baselineAt,
    });
    assert.equal(out.weekCount, 0);
    assert.equal(out.baselineDone, 1);
    assert.equal(out.timeZone, TZ);
    assert.equal(out.items.length, 0);
    assert.equal(out.trackingSince, baselineAt.toISOString());
    assert.equal(out.coverage.complete, true);
    assert.deepEqual(Object.keys(out.coverage.sources).sort(), ['notion', 'workboard']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('first valid read seeds Done baseline and persists atomically', async () => {
  const dir = await tempDir();
  try {
    const args = context({
      dataDir: dir,
      notionData: notion([{ id: 'p-done', title: 'Personal Done', status: 'Done' }]),
      workData: workboard([{ id: 'w-done', title: 'Work Done', status: 'Done' }]),
    });
    const out = await progressModule.fetch({ ...args, now: baselineAt });
    assert.equal(out.baselineDone, 2);
    assert.equal(out.weekCount, 0);
    const file = ledgerPath(dir);
    assert.equal(path.basename(file), PROGRESS_LEDGER_FILE);
    const saved = await readLedger(file);
    assert.equal(saved.sources.notion.baselineDone, 1);
    assert.equal(saved.sources.workboard.baselineDone, 1);
    assert.deepEqual(await fsp.readdir(dir), [PROGRESS_LEDGER_FILE]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('rejects legacy personal cache without completed partition or with top-level truncation', async () => {
  const dir = await tempDir();
  try {
    let out = await progressModule.fetch({
      ...context({
        dataDir: dir,
        notionData: { configured: true, items: [{ id: 'legacy-done', title: 'Looks done', status: 'Done' }] },
        workData: workboard([]),
      }),
      now: baselineAt,
    });
    assert.equal(out.coverage.sources.notion.available, false);
    assert.equal(out.coverage.sources.notion.reason, 'missing-completed');
    assert.equal(out.baselineDone, 0);

    out = await progressModule.fetch({
      ...context({
        dataDir: dir,
        notionData: { configured: true, items: [], completed: [], truncated: true },
        workData: workboard([]),
      }),
      now: new Date('2026-09-03T19:00:00Z'),
    });
    assert.equal(out.coverage.sources.notion.available, false);
    assert.equal(out.coverage.sources.notion.reason, 'truncated');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('rejects a source whose fetchedAt is older than the progress freshness window', async () => {
  const dir = await tempDir();
  try {
    const out = await progressModule.fetch({
      ...context({
        dataDir: dir,
        notionData: notion([]),
        workData: workboard([]),
        fetchedAt: new Date('2026-09-03T17:00:00Z'),
      }),
      now: baselineAt,
    });
    assert.equal(out.coverage.complete, false);
    assert.equal(out.coverage.sources.workboard.reason, 'stale');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('counts only an observed open to Done transition and deduplicates repeats', async () => {
  const dir = await tempDir();
  try {
    const initial = {
      ...context({
        dataDir: dir,
        notionData: notion([{ id: 'p1', title: 'Personal task' }]),
        workData: workboard([{ id: 'w1', title: 'Work task', status: 'Inbox' }]),
      }),
      now: baselineAt,
    };
    await progressModule.fetch(initial);

    const done = {
      ...context({
        dataDir: dir,
        notionData: notion([{ id: 'p1', title: 'Personal task' }]),
        workData: workboard([{ id: 'w1', title: 'Work task', status: 'Done' }]),
        fetchedAt: new Date('2026-09-03T19:00:00Z'),
      }),
      now: new Date('2026-09-03T19:00:00Z'),
    };
    let out = await progressModule.fetch(done);
    assert.equal(out.weekCount, 1);
    assert.deepEqual(out.items, [{ title: 'Work task', source: 'workboard', observedAt: '2026-09-03T19:00:00.000Z' }]);

    out = await progressModule.fetch(done);
    assert.equal(out.weekCount, 1);

    const reopened = {
      ...context({
        dataDir: dir,
        notionData: notion([{ id: 'p1', title: 'Personal task' }]),
        workData: workboard([{ id: 'w1', title: 'Work task', status: 'Active' }]),
        fetchedAt: new Date('2026-09-03T20:00:00Z'),
      }),
      now: new Date('2026-09-03T20:00:00Z'),
    };
    out = await progressModule.fetch(reopened);
    assert.equal(out.weekCount, 0);
    const recompleted = {
      ...context({
        dataDir: dir,
        notionData: notion([{ id: 'p1', title: 'Personal task' }]),
        workData: workboard([{ id: 'w1', title: 'Work task', status: 'Done' }]),
        fetchedAt: new Date('2026-09-03T21:00:00Z'),
      }),
      now: new Date('2026-09-03T21:00:00Z'),
    };
    out = await progressModule.fetch(recompleted);
    assert.equal(out.weekCount, 1);
    assert.deepEqual(out.items.map((item) => item.title), ['Work task']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('does not treat a trashed row becoming Done as an open to Done transition', async () => {
  const dir = await tempDir();
  try {
    await progressModule.fetch({
      ...context({ dataDir: dir, notionData: notion([]), workData: workboard([{ id: 'w1', title: 'Discarded', status: 'Trashed' }]) }),
      now: baselineAt,
    });
    const out = await progressModule.fetch({
      ...context({ dataDir: dir, notionData: notion([]), workData: workboard([{ id: 'w1', title: 'Discarded', status: 'Done' }]), fetchedAt: new Date('2026-09-03T19:00:00Z') }),
      now: new Date('2026-09-03T19:00:00Z'),
    });
    assert.equal(out.weekCount, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('personal completed rows and workboard Done rows both participate in the baseline', async () => {
  const dir = await tempDir();
  try {
    const out = await progressModule.fetch({
      ...context({
        dataDir: dir,
        notionData: notion(
          [{ id: 'p-open', title: 'Open personal task' }],
          [{ id: 'p-done', title: 'Completed personal task' }],
        ),
        workData: workboard([
          { id: 'w-done', title: 'Completed work task', status: 'Done' },
          { id: 'w-trash', title: 'Discarded work task', status: 'Trashed' },
        ]),
      }),
      now: baselineAt,
    });
    assert.equal(out.baselineDone, 2);
    assert.equal(out.weekCount, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a newly seen Done row is added to baseline rather than counted as progress', async () => {
  const dir = await tempDir();
  try {
    const initial = context({
      dataDir: dir,
      notionData: notion([]),
      workData: workboard([]),
    });
    await progressModule.fetch({ ...initial, now: baselineAt });
    const out = await progressModule.fetch({
      ...context({
        dataDir: dir,
        notionData: notion([]),
        workData: workboard([{ id: 'new-done', title: 'Already done on first sight', status: 'Done' }]),
        fetchedAt: new Date('2026-09-03T19:00:00Z'),
      }),
      now: new Date('2026-09-03T19:00:00Z'),
    });
    assert.equal(out.weekCount, 0);
    assert.equal(out.baselineDone, 1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('stale or truncated sources do not create fabricated transitions and are reflected in coverage', async () => {
  const dir = await tempDir();
  try {
    await progressModule.fetch({
      ...context({ dataDir: dir, notionData: notion([]), workData: workboard([{ id: 'w1', title: 'Task', status: 'Active' }]) }),
      now: baselineAt,
    });
    let out = await progressModule.fetch({
      ...context({
        dataDir: dir,
        notionData: notion([]),
        workData: workboard([{ id: 'w1', title: 'Task', status: 'Done' }], { complete: false, truncated: true }),
        fetchedAt: new Date('2026-09-03T19:00:00Z'),
      }),
      now: new Date('2026-09-03T19:00:00Z'),
    });
    assert.equal(out.weekCount, 0);
    assert.equal(out.coverage.complete, false);
    assert.equal(out.coverage.sources.workboard.reason, 'truncated');

    out = await progressModule.fetch({
      ...context({
        dataDir: dir,
        notionData: notion([]),
        workData: workboard([{ id: 'w1', title: 'Task', status: 'Done' }], { complete: true }),
        workStale: true,
        fetchedAt: new Date('2026-09-03T20:00:00Z'),
      }),
      now: new Date('2026-09-03T20:00:00Z'),
    });
    assert.equal(out.weekCount, 0);
    assert.equal(out.coverage.sources.workboard.reason, 'stale');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('weekly count follows Monday in the configured local timezone', async () => {
  const dir = await tempDir();
  try {
    const sunday = new Date('2026-09-07T06:50:00Z'); // Sep 6, 23:50 PDT
    const beforeMidnight = context({
      dataDir: dir,
      notionData: notion([]),
      workData: workboard([{ id: 'w1', title: 'Sunday completion', status: 'Active' }]),
      fetchedAt: sunday,
    });
    await progressModule.fetch({ ...beforeMidnight, now: sunday });
    const done = context({
      dataDir: dir,
      notionData: notion([]),
      workData: workboard([{ id: 'w1', title: 'Sunday completion', status: 'Done' }]),
      fetchedAt: new Date('2026-09-07T06:59:00Z'),
    });
    let out = await progressModule.fetch({ ...done, now: new Date('2026-09-07T06:59:00Z') });
    assert.equal(out.weekCount, 1);
    const afterMonday = await progressModule.fetch({ ...done, now: new Date('2026-09-07T07:01:00Z') });
    assert.equal(afterMonday.weekCount, 0);
    assert.equal(localWeekStart(new Date('2026-09-07T07:01:00Z'), TZ), '2026-09-07T07:00:00.000Z');
    assert.equal(weekRange(new Date('2026-09-07T07:01:00Z'), TZ).end.toISOString(), '2026-09-14T07:00:00.000Z');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
