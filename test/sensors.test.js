import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SENSOR_MAX_LUX,
  createSensorHandler,
  normalizeSensors,
} from '../src/sensors.js';

function fakeEvents(size = 2) {
  const sent = [];
  return { sent, size, broadcast: (event, payload) => sent.push({ event, payload: { ...payload } }) };
}

function fakeRes() {
  return {
    body: null,
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('normalizes live presence and lux values', () => {
  assert.deepEqual(normalizeSensors({ present: true, lux: 42.567 }), {
    present: true,
    lux: 42.57,
  });
  assert.deepEqual(normalizeSensors({ present: 'clear', lux: 'bad' }), {
    present: false,
    lux: null,
  });
});

test('rejects unsafe sensor values without inventing a reading', () => {
  assert.deepEqual(normalizeSensors({ present: {}, lux: -1 }), {
    present: null,
    lux: null,
  });
  assert.equal(normalizeSensors({ lux: 999_999 }).lux, SENSOR_MAX_LUX);
  assert.equal(normalizeSensors({ lux: null }).lux, null);
  assert.equal(normalizeSensors({}).lux, null);
  assert.equal(normalizeSensors({ lux: '  ' }).lux, null);
});

test('handler updates shared state and broadcasts telemetry', () => {
  const events = fakeEvents(1);
  const state = { present: null, lux: null, updatedAt: null };
  const res = fakeRes();
  createSensorHandler({ events, state, log: { debug() {} } })({
    body: { present: false, lux: 123.456 },
  }, res);

  assert.equal(events.sent.length, 1);
  assert.equal(events.sent[0].event, 'sensors');
  assert.equal(events.sent[0].payload.present, false);
  assert.equal(events.sent[0].payload.lux, 123.46);
  assert.match(state.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(res.body, { ok: true, ...state, clients: 1 });
});
