import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ENTITY_IDS, nanoleafModule, normalizeNanoleafState, shapeNanoleaf } from '../src/modules/nanoleaf.js';

const config = (tokenFile, url = 'http://ha.test:8123') => ({
  ha: { url, tokenFile },
  nanoleaf: { entities: ENTITY_IDS },
  fetchTimeoutMs: 500,
});

async function tokenFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-ha-'));
  const file = path.join(dir, 'token');
  await fs.writeFile(file, 'fixture-token\n', { mode: 0o600 });
  return file;
}

function state(entityId, value, attributes = {}) {
  return { entity_id: entityId, state: value, attributes };
}

test('normalizes Home Assistant state without exposing raw attributes', () => {
  const result = normalizeNanoleafState(
    state('light.shapes_a418', 'on', {
      friendly_name: 'Nanoleaf Shapes A',
      rgb_color: [12.4, 180, 300],
      brightness: 128.4,
      effect: 'Rainbow',
    }),
    'light.shapes_a418',
  );

  assert.deepEqual(result, {
    entityId: 'light.shapes_a418',
    name: 'Nanoleaf Shapes A',
    state: 'on',
    on: true,
    rgb: [12, 180, 255],
    brightness: 128,
  });
});

test('off lights retain a remembered color but remain off', () => {
  const result = normalizeNanoleafState(
    state('light.shapes_dedf', 'off', { rgb_color: [80, 90, 100], brightness: 0 }),
    'light.shapes_dedf',
  );
  assert.equal(result.on, false);
  assert.equal(result.state, 'off');
  assert.deepEqual(result.rgb, [80, 90, 100]);
  assert.equal(result.brightness, 0);
});

test('shape requires both configured entities and preserves configured order', () => {
  const result = shapeNanoleaf([
    state('light.shapes_dedf', 'off'),
    state('light.shapes_a418', 'on', { rgb_color: [1, 2, 3] }),
  ]);
  assert.deepEqual(result.lights.map((light) => light.entityId), ENTITY_IDS);
  assert.equal(result.lights[0].on, true);
  assert.equal(result.lights[1].on, false);
  assert.throws(() => shapeNanoleaf([state(ENTITY_IDS[0], 'on')]), /incomplete/);
  assert.throws(() => normalizeNanoleafState(state(ENTITY_IDS[0], 'unavailable'), ENTITY_IDS[0]), /invalid/);
});

test('fetches both HA entities with a bearer token and returns render data', async () => {
  const file = await tokenFile();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.authorization });
    const entityId = decodeURIComponent(String(url).split('/').pop());
    const payload = entityId === 'light.shapes_a418'
      ? state(entityId, 'on', { friendly_name: 'Shapes A', rgb_color: [20, 40, 60], brightness: 200 })
      : state(entityId, 'off', { friendly_name: 'Shapes B', brightness: 0 });
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await nanoleafModule.fetch({ config: config(file), log: { warn() {} } });
    assert.equal(result.lights[0].name, 'Shapes A');
    assert.deepEqual(result.lights[0].rgb, [20, 40, 60]);
    assert.equal(result.lights[0].brightness, 200);
    assert.equal(result.lights[1].on, false);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.authorization === 'Bearer fixture-token'));
    assert.ok(calls.every((call) => call.url.startsWith('http://ha.test:8123/api/states/light.shapes_')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HA outage returns null so the frontend hides the module', async () => {
  const file = await tokenFile();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('connection refused');
  };
  try {
    assert.equal(await nanoleafModule.fetch({ config: config(file), log: { warn() {} } }), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
