import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardState } from '../src/dashboard-state.js';
import { focusTasks } from '../public/day-model.js';
import { buildAttention } from '../public/attention.js';

test('compact state preserves priorities, notices, freshness and progress without mutating history', () => {
  const now = Date.parse('2026-09-06T21:00:00Z');
  const personal = { id: 'p', title: 'Personal task', due: '2026-09-06', priority: 'High', url: 'https://example.test/p', area: 'Home' };
  const work = { id: 'w', title: 'Review work', status: 'Review', effortMinutes: 15, notes: 'x'.repeat(5000) };
  const entry = data => ({ data, fetchedAt: now, stale: false });
  const state = { generatedAt: new Date(now).toISOString(), display: { on: true }, modules: {
    notion: entry({ configured: true, items: [personal], groups: [{ items: [personal] }], completed: [{ id: 'done' }] }),
    workboard: entry({ configured: true, available: true, items: [work, { id: 'other', title: 'Already done', status: 'Done' }], all: [work], completed: [{ id: 'other' }], coverage: { complete: true } }),
    progress: entry({ weekCount: 3, items: [{ title: 'Finished work' }] }),
    agents: entry({ connected: true, items: [] }),
  } };
  const original = structuredClone(state);
  const compact = dashboardState(state);
  const visible = s => focusTasks(s, now).map(({ id, title, source, reason, effortMinutes }) => ({ id, title, source, reason, effortMinutes }));
  assert.deepEqual(visible(compact), visible(state));
  assert.deepEqual(buildAttention(compact, { now }), buildAttention(state, { now }));
  assert.deepEqual(compact.modules.progress, state.modules.progress);
  assert.deepEqual(compact.modules.agents, state.modules.agents);
  assert.equal(compact.modules.workboard.fetchedAt, now);
  assert.equal(compact.modules.workboard.data.all, undefined);
  assert.equal(compact.modules.notion.data.completed, undefined);
  assert.equal(compact.modules.workboard.data.items[0].notes, undefined);
  assert.equal(compact.modules.workboard.data.items.length, 1);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(state).length / 4);
  assert.deepEqual(state, original);
});

test('missing and stale modules retain their unavailable state', () => {
  const state = { modules: { notion: { data: null, stale: true, fetchedAt: null } } };
  assert.deepEqual(dashboardState(state), state);
});
