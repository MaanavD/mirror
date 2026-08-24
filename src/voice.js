import { createLogger } from './logger.js';

/**
 * Hermy's voice: plays cached ElevenLabs clips through the Pi agent's /speak
 * endpoint. Clips are pre-generated (~/.hermes/scripts/hermy_voice_pack.py)
 * and live on the Pi at /opt/pi-agent/voice — this module only ever names a
 * clip, so a dead API key can never mute or break the mirror.
 *
 * Event → clip mapping is deliberately sparse and rate-limited: the mirror
 * speaks on transitions, never on a timer, and at most once per QUIET_MS
 * except for leave_now which is always allowed through.
 */
const QUIET_MS = 20 * 60_000;

export class Voice {
  #config;
  #log;
  #lastSpoke = 0;
  #seen = new Map(); // dedupe key -> true

  constructor({ config, log = createLogger('voice') }) {
    this.#config = config;
    this.#log = log;
  }

  /** POST the clip name to the Pi agent. Fire-and-forget; failures only log. */
  async play(clip, { force = false } = {}) {
    const { piAgentUrl, piAgentToken } = this.#config.display;
    if (!piAgentUrl || this.#config.mock) return { voice: 'disabled' };
    const now = Date.now();
    if (!force && now - this.#lastSpoke < QUIET_MS) return { voice: 'quiet' };
    this.#lastSpoke = now;
    try {
      const res = await fetch(`${piAgentUrl}/speak`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(piAgentToken ? { authorization: `Bearer ${piAgentToken}` } : {}),
        },
        body: JSON.stringify({ clip }),
        signal: AbortSignal.timeout(5000),
      });
      const body = await res.json().catch(() => ({}));
      this.#log.info(`speak ${clip}: ${res.status}`);
      return { voice: res.ok ? 'ok' : 'error', ...body };
    } catch (err) {
      this.#log.warn(`speak ${clip} failed: ${err.message}`);
      return { voice: 'unreachable' };
    }
  }

  /** Once per key (per process lifetime): transition sounds, not states. */
  async once(key, clip, opts) {
    if (this.#seen.has(key)) return { voice: 'dup' };
    this.#seen.set(key, true);
    return this.play(clip, opts);
  }

  /**
   * Called by the scheduler after each refresh with the module map.
   * Watches for transitions worth speaking about.
   */
  observe(modules, { now = new Date() } = {}) {
    const day = now.toISOString().slice(0, 10);

    // Virus count dropping to zero => area clean.
    const notion = modules.notion?.data;
    if (notion?.total === 0) this.once(`clean:${day}`, 'all_clear');

    // Weather battle spinning up.
    const hermy = modules.hermy?.data;
    if (hermy?.battle && hermy?.enemy) this.once(`battle:${day}:${hermy.enemy}`, 'storm_battle');

    // Readiness extremes, once per day, first observation only.
    const wellness = modules.wellness?.data;
    if (wellness?.score >= 90) this.once(`ready-hi:${day}`, 'readiness_high');
    else if (wellness?.score > 0 && wellness?.score < 55) this.once(`ready-lo:${day}`, 'readiness_low');

    // Flight day (a 0-day countdown renders TODAY).
    const items = modules.countdown?.data?.items ?? [];
    if (items.some((i) => i.days === 0 && i.kind === 'flight'))
      this.once(`flight:${day}`, 'flight_day');
  }
}
