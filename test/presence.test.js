import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRESENCE_DEFAULT_SOURCE,
  PRESENCE_MAX_HOLD_MS,
  PRESENCE_SOURCE_MAX,
  createPresenceHandler,
  normalizePresence,
} from '../src/presence.js';

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// Stand-in for the SSE stream: records what would have gone out on the wire.
function fakeEvents(size = 2) {
  const sent = [];
  return {
    sent,
    size,
    broadcast(event, payload) {
      sent.push({ event, payload });
    },
  };
}

function fakeRes() {
  return {
    body: null,
    code: 200,
    status(code) {
      this.code = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

// ---------------------------------------------------------------------------
// normalizePresence
// ---------------------------------------------------------------------------

test('an empty ping means present, from the default source, with no hold', () => {
  assert.deepEqual(normalizePresence({}), {
    present: true,
    source: PRESENCE_DEFAULT_SOURCE,
    holdMs: 0,
  });
});

test('a missing or non-object body is treated as an empty ping', () => {
  for (const body of [undefined, null, 'nope', 7, []]) {
    assert.equal(normalizePresence(body).present, true);
    assert.equal(normalizePresence(body).source, PRESENCE_DEFAULT_SOURCE);
  }
});

test('present: false is honoured', () => {
  assert.equal(normalizePresence({ present: false }).present, false);
  assert.equal(normalizePresence({ present: 0 }).present, false);
});

test('string booleans from a shell-scripted sensor are honoured', () => {
  for (const value of ['false', 'FALSE', ' off ', '0', 'no', 'absent', 'away']) {
    assert.equal(normalizePresence({ present: value }).present, false, `"${value}" is absent`);
  }
  for (const value of ['true', 'yes', 'on', '1']) {
    assert.equal(normalizePresence({ present: value }).present, true, `"${value}" is present`);
  }
});

test('source is trimmed, bounded, and falls back when blank', () => {
  assert.equal(normalizePresence({ source: '  mmwave  ' }).source, 'mmwave');
  assert.equal(normalizePresence({ source: '' }).source, PRESENCE_DEFAULT_SOURCE);
  assert.equal(normalizePresence({ source: '   ' }).source, PRESENCE_DEFAULT_SOURCE);
  assert.equal(normalizePresence({ source: 'x'.repeat(200) }).source.length, PRESENCE_SOURCE_MAX);
});

test('holdMs is clamped into [0, PRESENCE_MAX_HOLD_MS]', () => {
  assert.equal(normalizePresence({ holdMs: 5_000 }).holdMs, 5_000);
  assert.equal(normalizePresence({ holdMs: -1 }).holdMs, 0);
  assert.equal(normalizePresence({ holdMs: 99_999_999 }).holdMs, PRESENCE_MAX_HOLD_MS);
  assert.equal(normalizePresence({ holdMs: '4500' }).holdMs, 4_500);
  assert.equal(normalizePresence({ holdMs: 1234.6 }).holdMs, 1_235);
});

test('holdMs garbage degrades to no hold', () => {
  assert.equal(normalizePresence({ holdMs: 'soon' }).holdMs, 0);
  assert.equal(normalizePresence({ holdMs: null }).holdMs, 0);
  assert.equal(normalizePresence({ holdMs: Infinity }).holdMs, 0);
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

test('the handler broadcasts one presence event and echoes the payload', () => {
  const events = fakeEvents(3);
  const res = fakeRes();
  createPresenceHandler({ events, log: silentLog })(
    { body: { source: 'mmwave', holdMs: 2_000 } },
    res,
  );

  assert.equal(events.sent.length, 1);
  assert.equal(events.sent[0].event, 'presence');
  assert.deepEqual(events.sent[0].payload, { present: true, source: 'mmwave', holdMs: 2_000 });
  assert.deepEqual(res.body, {
    ok: true,
    present: true,
    source: 'mmwave',
    holdMs: 2_000,
    clients: 3,
  });
  assert.equal(res.code, 200);
});

test('the handler accepts a bodyless request', () => {
  const events = fakeEvents(0);
  const res = fakeRes();
  createPresenceHandler({ events, log: silentLog })({}, res);

  assert.equal(events.sent.length, 1);
  assert.deepEqual(events.sent[0].payload, {
    present: true,
    source: PRESENCE_DEFAULT_SOURCE,
    holdMs: 0,
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.clients, 0);
});

test('an absence ping still broadcasts, so the kiosk can stand down', () => {
  const events = fakeEvents();
  const res = fakeRes();
  createPresenceHandler({ events, log: silentLog })({ body: { present: false } }, res);

  assert.deepEqual(events.sent[0].payload, {
    present: false,
    source: PRESENCE_DEFAULT_SOURCE,
    holdMs: 0,
  });
  assert.equal(res.body.present, false);
});

test('the handler defaults its logger', () => {
  const events = fakeEvents();
  const res = fakeRes();
  createPresenceHandler({ events })({ body: {} }, res); // must not throw
  assert.equal(events.sent.length, 1);
});
