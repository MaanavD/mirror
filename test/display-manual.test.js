import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { DisplayController } from '../src/display.js';

function fakeStore(initial = false) {
  return {
    displayOn: initial,
    setDisplay(value) {
      this.displayOn = value;
    },
  };
}

test('manual display commands relay one hold payload to pi-agent', async (t) => {
  let request;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      request = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ on: true, brightness: 42, override: { mode: 'on' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const store = fakeStore(false);
  const controller = new DisplayController({
    config: {
      mock: false,
      display: {
        piAgentUrl: `http://127.0.0.1:${server.address().port}`,
        piAgentToken: 'agent-test-token',
        relayTimeoutMs: 1_000,
      },
    },
    store,
    log: { info() {}, warn() {} },
  });

  const result = await controller.manual('on', { percent: 42, durationSec: 7_200 });

  assert.equal(store.displayOn, true);
  assert.equal(result.relay, 'ok');
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/display/manual');
  assert.equal(request.authorization, 'Bearer agent-test-token');
  assert.deepEqual(request.body, { mode: 'on', percent: 42, duration_s: 7_200 });
});

test('manual auto release leaves soft state for the presence controller', async () => {
  const store = fakeStore(true);
  const controller = new DisplayController({
    config: { mock: true, display: {} },
    store,
    log: { info() {}, warn() {} },
  });

  const result = await controller.manual('auto');

  assert.equal(store.displayOn, true);
  assert.equal(result.mode, 'auto');
  assert.equal(result.relay, 'mock');
});
