import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeHermy, classifyWeather } from '../src/modules/hermy.js';

test('rain + thunderstorm => STORMY.EXE battle with both lines', () => {
  const out = shapeHermy(
    { weather: { current: { temp: 12, code: 95 }, rain: { rainAtISO: 'x' } } },
    {},
  );
  assert.equal(out.enemy, 'STORMY.EXE');
  assert.equal(out.battle, true);
  assert.ok(out.lines.includes('THUNDER! SEEK SHELTER.'));
  assert.ok(out.lines.includes('RAIN INBOUND. GRAB THE UMBRELLA.'));
});

test('heat >= 90F => HEATWAVE.EXE', () => {
  const out = shapeHermy({ weather: { current: { temp: 33, code: 1 } } }, {});
  assert.equal(out.enemy, 'HEATWAVE.EXE');
  assert.equal(out.battle, true);
});

test('flight within 24h adds a line', () => {
  const out = shapeHermy({ countdown: { items: [{ kind: 'flight', label: 'X', days: 0 }] } }, {});
  assert.ok(out.lines.includes('FLIGHT SOON. PACK THE BAG.'));
});

test('calm weather => no battle, no lines', () => {
  const out = shapeHermy({ weather: { current: { temp: 18, code: 1 } } }, {});
  assert.equal(out.enemy, null);
  assert.equal(out.battle, false);
  assert.equal(out.lines.length, 0);
});

test('every bark line stays within 34 characters', () => {
  const out = shapeHermy(
    {
      weather: { current: { temp: 35, code: 99 }, rain: { rainAtISO: 'x' } },
      countdown: { items: [{ kind: 'flight', label: 'X', days: 1 }] },
    },
    {},
  );
  for (const line of out.lines) assert.ok(line.length <= 34, `"${line}" is ${line.length} chars`);
});

test('classifyWeather only flags hostile codes', () => {
  const calm = classifyWeather({ current: { temp: 10, code: 1 } });
  assert.equal(calm.enemy, null);
  assert.equal(calm.reactions.length, 0);
});
