import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mountLiveDashboard } from '../src/frontend-release.js';

test('live routes identify the loaded release and detect hot-copied assets without restarting', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mirror-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const file of ['dashboard.css', 'dashboard.js', 'live-updates.js', 'attention.js',
    'day-model.js', 'dashboard-examples.js', 'hermy-sheet-v4.png']) {
    await writeFile(path.join(dir, file), 'initial');
  }
  await writeFile(path.join(dir, 'dashboard.html'), '<head></head><body>Live dashboard</body>');
  const app = express();
  mountLiveDashboard(app, dir);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = await fetch(base, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/dashboard?view=mirror');
  assert.equal(root.headers.get('cache-control'), 'no-store');
  const before = await (await fetch(base + '/api/frontend-version')).json();
  const page = await fetch(base + '/dashboard?view=mirror');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), new RegExp(`content="${before.version}"`));
  await writeFile(path.join(dir, 'dashboard.css'), 'changed');
  const after = await (await fetch(base + '/api/frontend-version')).json();
  assert.notEqual(after.version, before.version);
  const alias = await fetch(base + '/dashboard.html');
  assert.match(await alias.text(), new RegExp(`content="${after.version}"`));
});
