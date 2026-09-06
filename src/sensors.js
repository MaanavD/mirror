import { createLogger } from './logger.js';

export const SENSOR_MAX_LUX = 100_000;
const FALSEY = new Set(['false', '0', 'no', 'off', 'absent', 'away', 'clear']);

export function normalizeSensors(body) {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  let present = null;
  if (typeof raw.present === 'boolean') {
    present = raw.present;
  } else if (typeof raw.present === 'string') {
    const value = raw.present.trim().toLowerCase();
    if (value) present = !FALSEY.has(value);
  }

  let lux = null;
  const hasLux = raw.lux !== null && raw.lux !== undefined
    && !(typeof raw.lux === 'string' && raw.lux.trim() === '');
  if (hasLux) {
    const requestedLux = Number(raw.lux);
    if (Number.isFinite(requestedLux) && requestedLux >= 0) {
      lux = Math.min(requestedLux, SENSOR_MAX_LUX);
    }
  }

  return {
    present,
    lux: lux === null ? null : Math.round(lux * 100) / 100,
  };
}

export function createSensorHandler({ events, state, log = createLogger('sensors') }) {
  return (req, res) => {
    const payload = normalizeSensors(req?.body);
    state.present = payload.present;
    state.lux = payload.lux;
    state.updatedAt = new Date().toISOString();
    events.broadcast('sensors', state);
    log.debug(`present=${String(payload.present)} lux=${String(payload.lux)}`);
    res.json({ ok: true, ...state, clients: events.size });
  };
}

export default createSensorHandler;
