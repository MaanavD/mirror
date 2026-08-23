import assert from 'node:assert/strict';
import test from 'node:test';
import { aqiModule, buildUrl, mockRaw, shapeAqi } from '../src/modules/aqi.js';

test('buildUrl includes lat, lon, and current params', () => {
  const url = buildUrl({ lat: 47.6, lon: -122.3 });
  assert.ok(url.startsWith('https://air-quality-api.open-meteo.com/v1/air-quality'));
  assert.ok(url.includes('latitude=47.6'));
  assert.ok(url.includes('longitude=-122.3'));
  assert.ok(url.includes('current=us_aqi'));
});

test('shapeAqi returns null for null / undefined / non-object', () => {
  assert.equal(shapeAqi(null), null);
  assert.equal(shapeAqi(undefined), null);
  assert.equal(shapeAqi('nope'), null);
  assert.equal(shapeAqi(42), null);
});

test('shapeAqi returns null when us_aqi is missing', () => {
  assert.equal(shapeAqi({ current: {} }), null);
  assert.equal(shapeAqi({ current: { pm2_5: 5 } }), null);
  assert.equal(shapeAqi({}), null);
});

test('shapeAqi classifies clean air (AQI < 60) as good', () => {
  const result = shapeAqi({ current: { us_aqi: 42, pm2_5: 8.3 } });
  assert.deepEqual(result, { aqi: 42, pm25: 8, level: 'good' });
});

test('shapeAqi classifies AQI 60 as moderate', () => {
  const result = shapeAqi({ current: { us_aqi: 60, pm2_5: 15 } });
  assert.equal(result.level, 'moderate');
  assert.equal(result.aqi, 60);
});

test('shapeAqi classifies AQI 100 as moderate', () => {
  const result = shapeAqi({ current: { us_aqi: 100, pm2_5: 30 } });
  assert.equal(result.level, 'moderate');
});

test('shapeAqi classifies AQI 101 as unhealthy', () => {
  const result = shapeAqi({ current: { us_aqi: 101, pm2_5: 35 } });
  assert.equal(result.level, 'unhealthy');
});

test('shapeAqi classifies AQI 150 as unhealthy', () => {
  const result = shapeAqi({ current: { us_aqi: 150, pm2_5: 55 } });
  assert.equal(result.level, 'unhealthy');
});

test('shapeAqi classifies AQI 151 as very-unhealthy', () => {
  const result = shapeAqi({ current: { us_aqi: 151, pm2_5: 75 } });
  assert.equal(result.level, 'very-unhealthy');
});

test('shapeAqi classifies AQI 300 as very-unhealthy', () => {
  const result = shapeAqi({ current: { us_aqi: 300, pm2_5: 200 } });
  assert.equal(result.level, 'very-unhealthy');
});

test('shapeAqi rounds non-integer AQI values', () => {
  const result = shapeAqi({ current: { us_aqi: 72.4, pm2_5: 12.7 } });
  assert.equal(result.aqi, 72);
  assert.equal(result.pm25, 13);
});

test('shapeAqi returns null pm25 when pm2_5 is missing', () => {
  const result = shapeAqi({ current: { us_aqi: 50 } });
  assert.equal(result.pm25, null);
});

test('mockRaw produces valid shapeAqi output', () => {
  const result = shapeAqi(mockRaw());
  assert.equal(typeof result.aqi, 'number');
  assert.equal(typeof result.pm25, 'number');
  assert.equal(typeof result.level, 'string');
});

test('module has required properties', () => {
  assert.equal(aqiModule.name, 'aqi');
  assert.equal(aqiModule.refreshMs, 30 * 60_000);
  assert.equal(aqiModule.staleAfterMs, 60 * 60_000);
  assert.equal(typeof aqiModule.fetch, 'function');
  assert.equal(typeof aqiModule.mock, 'function');
});
