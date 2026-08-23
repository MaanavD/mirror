import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventStream } from '../src/sse.js';

const fakeStore = { snapshot: () => ({ ok: true }), subscribe: () => () => {} };
const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('broadcast with no clients is a no-op', () => {
  const events = createEventStream({ store: fakeStore, log: silentLog });
  assert.equal(events.size, 0);
  events.broadcast('say', { text: 'hello' }); // must not throw
});

test('broadcast writes a named SSE frame to connected clients', () => {
  const events = createEventStream({ store: fakeStore, log: silentLog });
  const written = [];
  const req = { on: () => {} };
  const res = {
    writeHead: () => {},
    write: (chunk) => written.push(chunk),
    end: () => {},
  };
  events.handler(req, res);
  assert.equal(events.size, 1);

  events.broadcast('say', { text: 'jack in!', holdMs: 5000 });
  const frame = written.find((w) => w.startsWith('event: say\n'));
  assert.ok(frame, 'say frame written');
  const data = JSON.parse(frame.split('\n')[1].replace('data: ', ''));
  assert.deepEqual(data, { text: 'jack in!', holdMs: 5000 });
  events.closeAll();
});

test('broadcast survives a client whose socket throws', () => {
  const events = createEventStream({ store: fakeStore, log: silentLog });
  const req = { on: () => {} };
  const res = {
    writeHead: () => {},
    write: (chunk) => {
      if (String(chunk).startsWith('event: say')) throw new Error('EPIPE');
    },
    end: () => {},
  };
  events.handler(req, res);
  events.broadcast('say', { text: 'x' }); // must not throw
  events.closeAll();
});
