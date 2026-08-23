import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { anyStale, DiskCache, isStale, toEpochMs } from '../src/cache.js';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 7, 23, 12, 0, 0);

test('toEpochMs accepts everything a cache file might contain', () => {
  assert.equal(toEpochMs(NOW), NOW);
  assert.equal(toEpochMs(new Date(NOW)), NOW);
  assert.equal(toEpochMs('2026-08-23T12:00:00.000Z'), NOW);
  assert.equal(toEpochMs(String(NOW)), NOW);
  for (const junk of [null, undefined, '', 'yesterday', NaN, {}, []]) {
    assert.equal(toEpochMs(junk), null, `expected null for ${JSON.stringify(junk)}`);
  }
});

test('no data is always stale', () => {
  assert.equal(isStale(null, 15 * MINUTE, NOW), true);
  assert.equal(isStale(undefined, 15 * MINUTE, NOW), true);
  assert.equal(isStale('nonsense', 15 * MINUTE, NOW), true);
});

test('fresh data is fresh, old data is stale, the boundary is inclusive', () => {
  const window = 45 * MINUTE;
  assert.equal(isStale(NOW - MINUTE, window, NOW), false);
  assert.equal(isStale(NOW - 44 * MINUTE, window, NOW), false);
  assert.equal(isStale(NOW - window, window, NOW), true);
  assert.equal(isStale(NOW - 3 * window, window, NOW), true);
});

test('a restart that finds recent data on disk does not light the dot', () => {
  // weather: 15 min cadence, 45 min stale window — two missed cycles are fine
  assert.equal(isStale(NOW - 20 * MINUTE, 45 * MINUTE, NOW), false);
  // but an hour of failures is not
  assert.equal(isStale(NOW - 60 * MINUTE, 45 * MINUTE, NOW), true);
});

test('ISO timestamps from the cache file work the same as epoch ms', () => {
  const iso = new Date(NOW - 10 * MINUTE).toISOString();
  assert.equal(isStale(iso, 45 * MINUTE, NOW), false);
  assert.equal(isStale(iso, 5 * MINUTE, NOW), true);
});

test('clock skew (future timestamp) is treated as fresh, not as an alarm', () => {
  assert.equal(isStale(NOW + 10 * MINUTE, 15 * MINUTE, NOW), false);
});

test('a module with no stale window never goes stale once it has data', () => {
  for (const window of [undefined, null, 0, -1, NaN, Infinity]) {
    assert.equal(isStale(NOW - 10 * 60 * MINUTE, window, NOW), false, `window ${window}`);
    assert.equal(isStale(null, window, NOW), true, `window ${window} with no data`);
  }
});

test('anyStale drives the single dim dot', () => {
  assert.equal(anyStale({ a: { stale: false }, b: { stale: false } }), false);
  assert.equal(anyStale({ a: { stale: false }, b: { stale: true } }), true);
  assert.equal(anyStale({}), false);
  assert.equal(anyStale(null), false);
  assert.equal(anyStale({ a: null, b: undefined }), false);
});

async function tmpCacheFile(name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mirror-cache-'));
  return path.join(dir, name);
}

test('a missing cache file is a normal cold start', async () => {
  const file = await tmpCacheFile('cache.json');
  const cache = new DiskCache(file);
  assert.deepEqual(cache.loadSync(), {});
  assert.equal(cache.get('weather'), undefined);
});

test('a corrupt cache file is ignored rather than fatal', async () => {
  const file = await tmpCacheFile('cache.json');
  await fsp.writeFile(file, '{ this is not json');
  assert.deepEqual(new DiskCache(file).loadSync(), {});

  await fsp.writeFile(file, '"a string"');
  assert.deepEqual(new DiskCache(file).loadSync(), {});

  await fsp.writeFile(file, '{"version":1}');
  assert.deepEqual(new DiskCache(file).loadSync(), {});
});

test('last-good data survives a round trip to disk', async () => {
  const file = await tmpCacheFile('cache.json');
  const write = new DiskCache(file);
  write.loadSync();
  write.set('weather', { data: { current: { temp: 13 } }, fetchedAt: NOW });
  write.set('quote', { data: { text: 'grind', day: '2026-08-23' }, fetchedAt: NOW });
  await write.close();

  assert.ok(fs.existsSync(file), 'cache file was not written');

  const read = new DiskCache(file);
  const entries = read.loadSync();
  assert.deepEqual(Object.keys(entries).sort(), ['quote', 'weather']);
  assert.equal(read.get('weather').data.current.temp, 13);
  assert.equal(read.get('weather').fetchedAt, NOW);

  // ...and the staleness verdict is reconstructed from what was on disk
  assert.equal(isStale(read.get('weather').fetchedAt, 45 * MINUTE, NOW + 10 * MINUTE), false);
  assert.equal(isStale(read.get('weather').fetchedAt, 45 * MINUTE, NOW + 90 * MINUTE), true);
});

test('flush leaves no temp files behind', async () => {
  const file = await tmpCacheFile('cache.json');
  const cache = new DiskCache(file);
  cache.loadSync();
  cache.set('notion', { data: { groups: [] }, fetchedAt: NOW });
  await cache.close();
  const siblings = await fsp.readdir(path.dirname(file));
  assert.deepEqual(siblings, ['cache.json']);
});
