import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WorkboardUnavailableError,
  buildFeed,
  effortMinutes,
  normalizeRow,
  parseReaderOutput,
  priorityFor,
  runReader,
} from '../src/modules/workboard.js';

const NOW = Date.parse('2026-09-06T12:00:00Z');

test('normalizes Command Board rows into the stable work item shape', () => {
  const item = normalizeRow({
    id: 'page-1',
    url: 'https://app.notion.com/page-1',
    Task: 'Ship the mirror feed',
    Status: 'Done',
    'date:Due:start': '2026-09-05',
    Effort: '60m',
    Lane: 'Ops',
    Source: 'agent',
    'date:Last activity:start': '2026-09-06T10:00:00Z',
  }, { now: NOW });

  assert.deepEqual(item, {
    id: 'page-1',
    url: 'https://app.notion.com/page-1',
    title: 'Ship the mirror feed',
    status: 'Done',
    due: '2026-09-05',
    effortMinutes: 60,
    area: 'Ops',
    source: 'work',
    lastActivity: '2026-09-06T10:00:00Z',
    completedAt: null,
    priority: 0,
    priorityReason: 'Done',
  });
});

test('does not infer completion time from Last activity and leaves Deep work unquantified', () => {
  assert.equal(effortMinutes('Deep work'), null);
  const item = normalizeRow({
    id: 'done-1', Task: 'Completed item', Status: 'Done', Effort: 'Deep work',
    'date:Last activity:start': '2026-09-06',
  });
  assert.equal(item.completedAt, null);
  assert.equal(item.lastActivity, '2026-09-06');
});

test('builds open and completed views while preserving explicit coverage', () => {
  const feed = buildFeed([
    { id: 'a', Task: 'Active', Status: 'Active', Lane: 'Ops' },
    { id: 'b', Task: 'Done', Status: 'Done' },
    { id: 'c', Task: 'Trashed', Status: 'Trashed' },
  ], { complete: true, pages: 1, fetchedRows: 3, maxRows: 100 });

  assert.equal(feed.items.length, 3);
  assert.deepEqual(feed.open.map((item) => item.id), ['a']);
  assert.deepEqual(feed.completed.map((item) => item.id), ['b']);
  assert.deepEqual(feed.baselines, { all: 3, open: 1, completed: 1, exact: true });
  assert.equal(feed.weeklyProgress.doneTotal, 1);
  assert.equal(feed.weeklyProgress.completedThisWeek, null);
});

test('marks capped reader output as a lower bound rather than an exact count', () => {
  const feed = buildFeed([
    { id: 'a', Task: 'First', Status: 'Done' },
    { id: 'b', Task: 'Second', Status: 'Active' },
  ], { complete: false, truncated: true, pages: 10, fetchedRows: 2, maxRows: 2 });

  assert.equal(feed.coverage.complete, false);
  assert.equal(feed.coverage.countKind, 'lower-bound');
  assert.equal(feed.counts.exact, false);
});

test('priority uses due date and status without using activity recency', () => {
  assert.deepEqual(priorityFor({ status: 'Review', due: null, now: NOW }), { score: 85, reason: 'Ready for review' });
  assert.deepEqual(priorityFor({ status: 'Inbox', due: '2026-09-06', now: NOW }), { score: 95, reason: 'Due today' });
  assert.deepEqual(priorityFor({ status: 'Inbox', due: '2026-09-20', now: NOW }), { score: 20, reason: 'Inbox' });
});

test('reader JSON errors become unavailable data errors', () => {
  assert.throws(() => parseReaderOutput('{bad json'), WorkboardUnavailableError);
  assert.throws(() => parseReaderOutput(JSON.stringify({ rows: null })), WorkboardUnavailableError);
});

test('reader command failure is surfaced and remains timeout bounded', async () => {
  let invocation;
  await assert.rejects(
    runReader({
      script: '/tmp/read_workboard.py',
      timeoutMs: 99_999,
      execFileImpl(command, args, options, callback) {
        invocation = { command, args, options };
        callback(Object.assign(new Error('bridge unavailable'), { code: 1 }), '', 'bridge unavailable');
      },
    }),
    (error) => error instanceof WorkboardUnavailableError && /failed/.test(error.message),
  );
  assert.equal(invocation.command, 'python3');
  assert.deepEqual(invocation.args.slice(0, 2), ['/tmp/read_workboard.py', '--page-size']);
  assert.equal(invocation.options.timeout, 30_000);
  assert.equal(invocation.options.maxBuffer, 4 * 1024 * 1024);
});

test('reader success returns stdout for feed parsing', async () => {
  const result = await runReader({
    script: '/tmp/read_workboard.py',
    execFileImpl(command, args, options, callback) {
      callback(null, JSON.stringify({ rows: [], coverage: { complete: true } }), '');
    },
  });
  assert.deepEqual(parseReaderOutput(result.stdout), { rows: [], coverage: { complete: true } });
});
