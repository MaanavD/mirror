import crypto from 'node:crypto';
import { fetchJson, fetchText } from './http.js';
import { createLogger } from './logger.js';

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

  async manual(mode, { percent, durationSec = 1_800 } = {}) {
    const payload = { mode, duration_s: durationSec };
    if (percent !== undefined) payload.percent = percent;

    // Manual commands share this server path, while the presence daemon keeps
    // using set()/relay(). The Pi agent can therefore hold this state without
    // treating the daemon's next automatic write as a new manual command.
    if (mode !== 'auto') this.#store.setDisplay(mode === 'on');
    this.#log.info(`display ${mode} (${mode === 'auto' ? 'manual release' : 'manual'})`);
    const result = await this.relayManual(payload);
    return {
      ok: true,
      mode,
      on: mode === 'auto' ? this.#store.displayOn : mode === 'on',
      source: 'manual',
      ...result,
    };
  }

  async relayManual(payload) {
    const { piAgentUrl, piAgentToken, relayTimeoutMs } = this.#config.display;
    if (this.#config.mock) return { relay: 'mock' };
    if (!piAgentUrl) return { relay: 'disabled' };
    const url = `${piAgentUrl}/display/manual`;
    try {
      const agent = await fetchJson(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(piAgentToken ? { authorization: `Bearer ${piAgentToken}` } : {}),
        },
        body: JSON.stringify(payload),
        timeoutMs: relayTimeoutMs,
      });
      this.#log.info(`pi-agent manual ${payload.mode} ok`);
      return { relay: 'ok', agent };
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

  /** Guard-owned hold: the same Pi override as manual(), without a person. */
  async hold(mode, durationSec) {
    if (mode === 'off') this.#store.setDisplay(false);
    return this.relayManual(mode === 'auto' ? { mode } : { mode, duration_s: durationSec });
  }

}

export default DisplayController;
