import test from 'node:test';
import assert from 'node:assert/strict';
import { Voice } from '../src/voice.js';

const cfg = (over = {}) => ({
  mock: false,
  display: { piAgentUrl: 'http://127.0.0.1:1', piAgentToken: 't' },
  ...over,
});

const silentLog = { info() {}, warn() {}, debug() {}, error() {} };

test('disabled without a pi agent url', async () => {
  const v = new Voice({ config: cfg({ display: {} }), log: silentLog });
  assert.deepEqual(await v.play('jackin'), { voice: 'disabled' });
});

test('disabled in mock mode', async () => {
  const v = new Voice({ config: cfg({ mock: true }), log: silentLog });
  assert.deepEqual(await v.play('jackin'), { voice: 'disabled' });
});

test('unreachable agent fails soft', async () => {
  const v = new Voice({ config: cfg(), log: silentLog });
  const r = await v.play('jackin', { force: true });
  assert.equal(r.voice, 'unreachable');
});

test('rate limit: second unforced play inside the window is quiet', async () => {
  const v = new Voice({ config: cfg(), log: silentLog });
  await v.play('a');
  const r = await v.play('b');
  assert.equal(r.voice, 'quiet');
});

test('once() dedupes by key', async () => {
  const v = new Voice({ config: cfg(), log: silentLog });
  await v.once('k', 'a', { force: true });
  const r = await v.once('k', 'a', { force: true });
  assert.equal(r.voice, 'dup');
});

test('observe maps readiness extremes and clean tasks to clips', async () => {
  const played = [];
  const v = new Voice({ config: cfg(), log: silentLog });
  v.play = async (clip) => (played.push(clip), { voice: 'ok' });
  v.observe({
    wellness: { data: { score: 95 } },
    notion: { data: { total: 0 } },
    hermy: { data: { battle: true, enemy: 'STORMY.EXE' } },
    countdown: { data: { items: [{ days: 0, kind: 'flight' }] } },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(played.sort(), ['all_clear', 'flight_day', 'readiness_high', 'storm_battle']);
  // second observe: all dup'd, nothing new
  played.length = 0;
  v.observe({ wellness: { data: { score: 95 } }, notion: { data: { total: 0 } } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(played, []);
});
