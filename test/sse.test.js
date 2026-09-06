import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEventStream } from '../src/sse.js';

const fakeStore = { snapshot: () => ({ ok: true }), subscribe: () => () => {} };
const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test('a slow kiosk skips obsolete snapshots and resumes at the newest state', () => {
  let publish;
  const store = { snapshot: () => ({ revision: 0 }), subscribe: fn => { publish = fn; return () => {}; } };
  const events = createEventStream({ store, log: silentLog });
  const frames = [];
  const req = new EventEmitter(), res = new EventEmitter();
  res.writeHead = () => {};
  res.end = () => req.emit('close');
  res.write = chunk => { frames.push(chunk); return !chunk.startsWith('event: state'); };
  events.handler(req, res);
  for (let revision = 1; revision <= 100; revision++) publish({ revision });
  assert.equal(frames.filter(f => f.startsWith('event: state')).length, 1);
  events.broadcast('sensors', { present: false });
  events.broadcast('sensors', { present: true });
  res.write = chunk => { frames.push(chunk); return true; };
  res.emit('drain');
  const states = frames.filter(f => f.startsWith('event: state'));
  assert.equal(states.length, 2);
  assert.match(states[1], /"revision":100/);
  const sensors = frames.filter(f => f.startsWith('event: sensors'));
  assert.equal(sensors.length, 1);
  assert.match(sensors[0], /"present":true/);
  events.closeAll();
  assert.equal(events.size, 0);
});

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
