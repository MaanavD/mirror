import { createLogger } from './logger.js';

/*
  POST /api/presence — "someone is standing at the mirror".

  Nothing on the server changes: presence is a frontend motion cue, so the ping
  is normalised and re-broadcast on the existing SSE channel as a `presence`
  event. The kiosk turns that into a 90s `active` motion burst (public/mode.js).

  The eventual sender is an mmWave sensor on the Pi; until then curl and the
  Discord bot can drive it. Token-authed exactly like /api/say, wired in
  server.js, so nothing anonymous on the tailnet can poke the mirror.
*/

/** A sensor that spams presence must not be able to pin `active` forever. */
export const PRESENCE_MAX_HOLD_MS = 10 * 60_000;
export const PRESENCE_SOURCE_MAX = 40;
export const PRESENCE_DEFAULT_SOURCE = 'sensor';

const FALSEY = new Set(['false', '0', 'no', 'off', 'absent', 'away']);

/**
 * Presence defaults to true: a bare `POST /api/presence` with no body is the
 * common case (a sensor firing), and it should mean "he's here".
 */
export function normalizePresence(body) {
  const raw = body && typeof body === 'object' ? body : {};

  let present = true;
  if (raw.present !== undefined && raw.present !== null) {
    present =
      typeof raw.present === 'string'
        ? !FALSEY.has(raw.present.trim().toLowerCase())
        : Boolean(raw.present);
  }

  const source =
    String(raw.source ?? '').trim().slice(0, PRESENCE_SOURCE_MAX) || PRESENCE_DEFAULT_SOURCE;

  const requested = Number(raw.holdMs);
  const holdMs = Number.isFinite(requested)
    ? Math.min(Math.max(Math.round(requested), 0), PRESENCE_MAX_HOLD_MS)
    : 0;

  return { present, source, holdMs };
}

/** Express handler; `events` is the createEventStream() instance from src/sse.js. */
export function createPresenceHandler({ events, log = createLogger('presence') }) {
  return (req, res) => {
    const payload = normalizePresence(req?.body);
    events.broadcast('presence', payload);
    log.debug(`${payload.present ? 'present' : 'absent'} (${payload.source})`);
    res.json({ ok: true, ...payload, clients: events.size });
  };
}

export default createPresenceHandler;
