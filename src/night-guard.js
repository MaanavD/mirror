import { createLogger } from './logger.js';
import { sleepSchedule, publicSchedule, SLEEP_DEFAULTS } from '../public/sleep-model.js';

/*
  Keeps the panel dark while Maanav sleeps.

  The Pi's presence loop wakes the backlight for anyone in front of the glass,
  including a 3 AM walk to the bathroom. During the `night` phase this guard
  parks a manual "off" hold on the pi-agent (the same hold the manual API uses,
  which the presence loop already obeys) until the planned wake time.

  - It only arms once the panel is already off, so being at the mirror past
    the lock time never blanks it mid-use; walking away does.
  - Nothing ambient ends it early: waking at 3 AM, lights, getting out of bed
    all leave the glass dark until the wake time. Only a manual "on" releases
    it, for the rest of that night.
  - The hold carries its own expiry (the wake time), so a server restart or
    crash can never leave the mirror dark into the day.
*/

const TICK_MS = 30_000;
const MAX_HOLD_S = 12 * 60 * 60;

export class NightGuard {
  #config;
  #store;
  #display;
  #log;
  #timer = null;
  #holding = false;
  #night = null;        // the civil date of the night #manual belongs to
  #manual = false;

  constructor({ config, store, display, log = createLogger('night') }) {
    this.#config = config;
    this.#store = store;
    this.#display = display;
    this.#log = log;
  }

  get options() {
    const s = this.#config.sleep ?? {};
    return {
      ...SLEEP_DEFAULTS,
      ...(s.bedtime ? { bedtime: s.bedtime } : {}),
      ...(Number.isFinite(s.lockGraceMinutes) ? { lockGraceMinutes: s.lockGraceMinutes } : {}),
      ...(Number.isFinite(s.sleepHours) ? { sleepHours: s.sleepHours } : {}),
    };
  }

  /** Pure view of what the guard would decide right now. */
  schedule(now = Date.now()) {
    const { modules } = this.#store.snapshot();
    const released = this.#manual ? 'manual' : null;
    return sleepSchedule({
      now,
      zone: this.#config.timezone,
      calendar: modules.calendar,
      wellness: modules.wellness,
      options: this.options,
      released,
    });
  }

  /** A person pressed "on": respect it until the next night. */
  noteManual(mode, now = Date.now()) {
    if (mode === 'on' && this.schedule(now).phase === 'night') {
      this.#manual = true;
      this.#holding = false;
      this.#log.info('night released (manual on)');
    }
    if (mode === 'auto') this.#manual = false;
    return this.tick(now).catch(() => {});
  }

  #newNight(s) {
    if (s.night === this.#night) return;
    this.#night = s.night;
    this.#manual = false;
  }

  async tick(now = Date.now()) {
    this.#newNight(this.schedule(now));
    const s = this.schedule(now);
    this.#store.setSleep(publicSchedule(s, this.#config.timezone));

    if (this.#config.sleep?.guard === false) return s;
    if (s.locked && !this.#holding && !this.#store.displayOn) {
      const seconds = Math.min(MAX_HOLD_S, Math.max(60, Math.round((s.wakeAt - now) / 1000)));
      const result = await this.#display.hold('off', seconds);
      if (result.relay === 'ok' || result.relay === 'mock') {
        this.#holding = true;
        this.#log.info(`night lock on until ${new Date(s.wakeAt).toISOString()}`);
      }
    } else if (!s.locked && this.#holding) {
      // Manual release or the wake time. At the wake time the hold has
      // already expired on the Pi; "auto" is then a harmless no-op.
      const result = await this.#display.hold('auto');
      if (result.relay === 'ok' || result.relay === 'mock') {
        this.#holding = false;
        this.#log.info(`night lock off (${s.released ?? s.phase})`);
      }
    }
    return s;
  }

  start() {
    if (this.#timer) return;
    this.tick().catch((err) => this.#log.warn(`tick failed: ${err.message}`));
    this.#timer = setInterval(() => {
      this.tick().catch((err) => this.#log.warn(`tick failed: ${err.message}`));
    }, TICK_MS);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

export default NightGuard;
