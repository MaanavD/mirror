import { createLogger } from './logger.js';

/**
 * Two kinds of module cadence:
 *   - `refreshMs`  fixed interval (weather 15m, calendar 5m, notion 5m)
 *   - `nextRunAt`  wall-clock target (quote: 04:00 local, once a day)
 * Plus a slow tick that re-evaluates staleness so the dim dot can appear
 * without waiting for a fetch attempt.
 */
export class Scheduler {
  #store;
  #config;
  #log;
  #timers = new Set();
  #running = false;

  constructor({ store, config, log = createLogger('scheduler') }) {
    this.#store = store;
    this.#config = config;
    this.#log = log;
  }

  #track(timer) {
    timer.unref?.();
    this.#timers.add(timer);
    return timer;
  }

  start() {
    if (this.#running) return;
    this.#running = true;

    for (const name of this.#store.moduleNames) {
      const mod = this.#store.module(name);
      if (typeof mod.nextRunAt === 'function') this.#scheduleWallClock(mod);
      else if (typeof mod.refreshMsFor === 'function') this.#scheduleAdaptive(mod);
      else if (Number.isFinite(mod.refreshMs)) this.#scheduleInterval(mod);
    }

    this.#track(
      setInterval(() => {
        this.#store.recomputeStale();
      }, this.#config.refresh.tickMs),
    );

    this.#log.info('started');
  }

  #scheduleInterval(mod) {
    // Small jitter so four modules never fire in the same event-loop turn.
    const jitter = Math.floor(Math.random() * 5_000);
    this.#track(
      setInterval(() => {
        this.#store.refresh(mod.name, { reason: 'interval' }).catch(() => {});
      }, mod.refreshMs + jitter),
    );
  }

  #scheduleAdaptive(mod) {
    const schedule = () => {
      if (!this.#running) return;
      const delay = Math.max(1_000, Number(mod.refreshMsFor({
        data: this.#store.snapshot().modules[mod.name]?.data,
      })) || 30_000);
      const timer = setTimeout(async () => {
        this.#timers.delete(timer);
        await this.#store.refresh(mod.name, { reason: 'adaptive' }).catch(() => {});
        if (this.#running) schedule();
      }, delay);
      this.#track(timer);
    };
    schedule();
  }

  #scheduleWallClock(mod) {
    const schedule = () => {
      const now = new Date();
      const at = mod.nextRunAt(now, this.#config);
      const delay = Math.max(1_000, at.getTime() - now.getTime());
      this.#log.debug(`${mod.name} next run ${at.toISOString()}`);
      const timer = setTimeout(async () => {
        this.#timers.delete(timer);
        await this.#store.refresh(mod.name, { reason: 'wall-clock' }).catch(() => {});
        if (this.#running) schedule();
      }, delay);
      this.#track(timer);
    };
    schedule();
  }

  stop() {
    this.#running = false;
    for (const timer of this.#timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.#timers.clear();
  }
}

export default Scheduler;
