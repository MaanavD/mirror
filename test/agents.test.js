import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentsModule,
  fetchAgents,
  isWorkingHeartbeatLive,
  normalizeAgent,
  parseProbeOutput,
} from '../src/modules/agents.js';

const NOW = new Date('2026-09-06T08:00:00.000Z');
const NOW_S = NOW.getTime() / 1000;

test('normalizes live working agents and sanitizes visible text', () => {
  const item = normalizeAgent({
    name: ' Review\nPR ',
    title: 'Fix\u0000 the <mirror> dashboard',
    status: 'working',
    last_activity_at: NOW_S - 30,
    source: 'hermes-discord',
    thread_id: 'thread-1',
    url: 'https://discord.example/thread-1',
  }, NOW);

  assert.deepEqual(item, {
    id: 'thread-1',
    name: 'Review PR',
    task: 'Fix the <mirror> dashboard',
    status: 'working',
    live: true,
    lastActivityAt: NOW_S - 30,
    source: 'hermes-discord',
    url: 'https://discord.example/thread-1',
  });
});

test('working heartbeat expires after 180 seconds', () => {
  assert.equal(isWorkingHeartbeatLive('working', NOW_S - 180, NOW), true);
  assert.equal(isWorkingHeartbeatLive('working', NOW_S - 180.001, NOW), false);
  assert.equal(isWorkingHeartbeatLive('working', NOW_S + 31, NOW), false);
  assert.equal(isWorkingHeartbeatLive('working', NOW_S + 30, NOW), true);
});

test('waiting, done, and idle records are retained but never live', () => {
  const items = parseProbeOutput(JSON.stringify({ agents: [
    { name: 'Blocked', title: 'Needs approval', status: 'blocked', last_activity_at: NOW_S },
    { name: 'Finished', title: 'Shipped it', status: 'done', last_activity_at: NOW_S },
    { name: 'Quiet', title: 'Old work', status: 'idle', last_activity_at: NOW_S },
  ] }), NOW);

  assert.deepEqual(items.map(({ status, live }) => ({ status, live })), [
    { status: 'waiting', live: false },
    { status: 'done', live: false },
    { status: 'idle', live: false },
  ]);
});

test('uses session id when a Hermes row has no thread id', () => {
  const item = normalizeAgent({
    name: 'CLI agent',
    status: 'working',
    session_id: 'session-1',
    last_activity_at: NOW_S,
    source: 'hermes-ssh',
  }, NOW);
  assert.equal(item.id, 'session-1');
  assert.equal(item.source, 'hermes-ssh');
});

test('fetch invokes the bounded read-only probe and returns the contract', async () => {
  let call;
  const result = await fetchAgents({
    now: NOW,
    execImpl: async (...args) => {
      call = args;
      return { stdout: JSON.stringify({ agents: [] }) };
    },
  });

  assert.deepEqual(result, { connected: true, items: [] });
  assert.deepEqual(call[0], 'python3');
  assert.deepEqual(call[1], ['/home/hermes/deckbridge/hermes_agents_probe.py', '--limit', '10']);
  assert.equal(call[2].timeout, 8000);
  assert.equal(call[2].maxBuffer, 256 * 1024);
});

test('fetch failures escape for Store stale handling', async () => {
  await assert.rejects(
    fetchAgents({ execImpl: async () => { throw new Error('probe unavailable'); } }),
    /probe unavailable/,
  );
  assert.equal(agentsModule.refreshMs >= 5000 && agentsModule.refreshMs <= 10000, true);
  assert.equal(agentsModule.staleAfterMs, 30000);
});

test('invalid probe documents fail closed', () => {
  assert.throws(() => parseProbeOutput('{}', NOW), /agents array/);
  assert.throws(() => parseProbeOutput('not json', NOW), /invalid JSON/);
});
