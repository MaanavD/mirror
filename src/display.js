import crypto from 'node:crypto';
import { fetchText } from './http.js';
import { createLogger } from './logger.js';
import { localDateKey, localTimeLabel } from './time.js';

/** Constant-time compare over digests so lengths can differ safely. */
export function tokensMatch(expected, provided) {
  if (!expected || !provided) return false;
  const a = crypto.createHash('sha256').update(String(expected)).digest();
  const b = crypto.createHash('sha256').update(String(provided)).digest();
  return crypto.timingSafeEqual(a, b);
}

export function bearerFrom(req) {
  const header = req.headers?.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return m ? m[1].trim() : null;
}

/** Fails closed: no DISPLAY_TOKEN configured => endpoint is unavailable. */
export function requireDisplayToken(config, log = createLogger('display')) {
  return (req, res, next) => {
    if (!config.display.token) {
      if (config.mock) return next();
      return res.status(503).json({ error: 'DISPLAY_TOKEN not configured' });
    }
    const provided = bearerFrom(req);
    if (!tokensMatch(config.display.token, provided)) {
      log.warn(`rejected ${req.method} ${req.path} from ${req.ip}`);
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };
}

/**
 * Soft state is authoritative for the mirror: on a two-way mirror pure black IS
 * off, so even with the Pi agent unreachable the panel goes dark. The relay is
 * a best-effort power saving on top.
 */
export class DisplayController {
  #config;
  #store;
  #log;
  #timer = null;
  #fired = new Map();

  constructor({ config, store, log = createLogger('display') }) {
    this.#config = config;
    this.#store = store;
    this.#log = log;
  }

  get on() {
    return this.#store.displayOn;
  }

  async relay(on) {
    const { piAgentUrl, piAgentToken, relayTimeoutMs } = this.#config.display;
    if (this.#config.mock) return { relay: 'mock' };
    if (!piAgentUrl) return { relay: 'disabled' };
    const url = `${piAgentUrl}/display/${on ? 'on' : 'off'}`;
    try {
      const body = await fetchText(url, {
        method: 'POST',
        headers: piAgentToken ? { authorization: `Bearer ${piAgentToken}` } : {},
        timeoutMs: relayTimeoutMs,
      });
      this.#log.info(`pi-agent ${on ? 'on' : 'off'} ok`);
      return { relay: 'ok', agent: body.slice(0, 200) };
    } catch (err) {
      this.#log.warn(`pi-agent unreachable (${url}): ${err.message}`);
      return { relay: 'unreachable', error: err.message };
    }
  }

  /** Flips soft state immediately (SSE pushes it), then tries the Pi. */
  async set(on, { source = 'api' } = {}) {
    const next = Boolean(on);
    this.#store.setDisplay(next);
    this.#log.info(`display ${next ? 'on' : 'off'} (${source})`);
    const result = await this.relay(next);
    return { ok: true, on: next, source, ...result };
  }

  startSchedule() {
    if (this.#timer) return;
    const { offTime, onTime } = this.#config.display;
    const check = () => {
      const now = new Date();
      const tz = this.#config.timezone;
      const label = localTimeLabel(now, tz);
      const day = localDateKey(now, tz);
      const at = (t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;

      // Once per day per trigger, even if the tick fires twice in a minute.
      if (offTime && label === at(offTime) && this.#fired.get('off') !== day) {
        this.#fired.set('off', day);
        this.set(false, { source: 'schedule' }).catch(() => {});
      }
      if (onTime && label === at(onTime) && this.#fired.get('on') !== day) {
        this.#fired.set('on', day);
        this.set(true, { source: 'schedule' }).catch(() => {});
      }
    };
    this.#timer = setInterval(check, 20_000);
    this.#timer.unref?.();
    this.#log.info(
      `schedule: off ${offTime ? `${offTime.hour}:${String(offTime.minute).padStart(2, '0')}` : 'never'}` +
        `, on ${onTime ? `${onTime.hour}:${String(onTime.minute).padStart(2, '0')}` : 'external only'}`,
    );
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

export default DisplayController;
