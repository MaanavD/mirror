import assert from 'node:assert/strict';
import test from 'node:test';
import { createReleaseCheck } from '../public/live-updates.js';

const old = 'a'.repeat(64), next = 'b'.repeat(64), partial = 'c'.repeat(64);
test('keeps the page through unchanged releases, partial deploys and outages, then reloads once', async () => {
  let release = old, reloads = 0;
  const check = createReleaseCheck({ version: old, fetchVersion: async () => {
    if (release instanceof Error) throw release;
    return release;
  }, reload: () => reloads++ });
  await check(); await check();
  assert.equal(reloads, 0);
  release = partial; await check();
  release = next; await check();
  assert.equal(reloads, 0);
  release = new Error('offline'); await check();
  release = next; await check();
  assert.equal(reloads, 0);
  await check(); await check();
  assert.equal(reloads, 1);
});

test('a deployment before the first poll is detected against loaded HTML', async () => {
  let reloads = 0;
  const check = createReleaseCheck({ version: old, fetchVersion: async () => next, reload: () => reloads++ });
  await check(); await check();
  assert.equal(reloads, 1);
});

test('overlapping checks and malformed responses cannot trigger a reload', async () => {
  let resolve, requests = 0, reloads = 0;
  const check = createReleaseCheck({ version: old, fetchVersion: () => {
    requests++;
    return new Promise(done => { resolve = done; });
  }, reload: () => reloads++ });
  const pending = check();
  await check();
  assert.equal(requests, 1);
  resolve(undefined); await pending;
  const another = check(); resolve('bad'); await another;
  assert.equal(reloads, 0);
});
