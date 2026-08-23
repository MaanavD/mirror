import { isStale } from './cache.js';
import { createLogger } from './logger.js';

/**
 * The single source of truth behind GET /api/state.
 *
 * Shape (contract with the frontend — keep it boring):
 *   { generatedAt, modules: { <name>: { data, fetchedAt, stale } }, display: { on } }
 *
 * A module never crashes the process: a failed refresh keeps the last-good data
 * and lets it age into `stale: true`.
 */
export class Store {
  #config;
  #cache;
  #modules = new Map();
  #log;
  #subscribers = new Set();
  #inflight = new Map();
  #status = new Map();
  #state;
  #signature = '';

  constructor({ config, cache, modules = [], log = createLogger('store') }) {
    this.#config = config;
    this.#cache = cache;
    this.#log = log;
    for (const mod of modules) this.#modules.set(mod.name, mod);

    this.#state = {
      generatedAt: new Date().toISOString(),
      modules: {},
      display: { on: true },
    };

    // Hydrate from disk so the very first /api/state is useful even offline.
    const persisted = cache.all();
    const now = Date.now();
    for (const name of this.#modules.keys()) {
      const saved = persisted[name];
      const fetchedAt = saved?.fetchedAt ?? null;
      this.#state.modules[name] = {
        data: saved?.data ?? null,
        fetchedAt,
        stale: isStale(fetchedAt, this.#staleAfter(name), now),
      };
      this.#status.set(name, { ok: null, at: null, error: null, source: saved ? 'disk' : 'empty' });
    }
    if (typeof persisted.display?.on === 'boolean') {
      this.#state.display.on = persisted.display.on;
    }
    this.#signature = this.#computeSignature();
  }

  get moduleNames() {
    return [...this.#modules.keys()];
  }

  module(name) {
    return this.#modules.get(name);
  }

  #staleAfter(name) {
    return this.#modules.get(name)?.staleAfterMs;
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  status() {
    const out = {};
    for (const [name, status] of this.#status) {
      const entry = this.#state.modules[name];
      out[name] = {
        ...status,
        fetchedAt: entry?.fetchedAt ?? null,
        stale: entry?.stale ?? true,
        hasData: entry?.data != null,
      };
    }
    return out;
  }

  subscribe(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  #computeSignature() {
    return JSON.stringify({ modules: this.#state.modules, display: this.#state.display });
  }

  /** Publishes only when something a viewer could notice actually changed. */
  #publish() {
    const next = this.#computeSignature();
    if (next === this.#signature) return false;
    this.#signature = next;
    this.#state.generatedAt = new Date().toISOString();
    const snapshot = this.snapshot();
    for (const fn of this.#subscribers) {
      try {
        fn(snapshot);
      } catch (err) {
        this.#log.warn('subscriber failed', err);
      }
    }
    return true;
  }

  setDisplay(on) {
    this.#state.display.on = Boolean(on);
    this.#cache.set('display', { on: this.#state.display.on, fetchedAt: Date.now() });
    this.#publish();
    return this.#state.display.on;
  }

  get displayOn() {
    return this.#state.display.on;
  }

  async refresh(name, { reason = 'scheduled' } = {}) {
    const mod = this.#modules.get(name);
    if (!mod) return null;
    if (this.#inflight.has(name)) return this.#inflight.get(name);

    const previous = this.#state.modules[name];
    const run = (async () => {
      const startedAt = Date.now();
      try {
        const ctx = {
          config: this.#config,
          log: this.#log.child(name),
          previous: previous ? structuredClone(previous) : null,
          now: new Date(),
          getModule: (modName) => this.#state.modules[modName] ?? null,
        };
        const data = this.#config.mock && mod.mock ? await mod.mock(ctx) : await mod.fetch(ctx);
        const fetchedAt = Date.now();
        this.#state.modules[name] = { data: data ?? null, fetchedAt, stale: false };
        this.#status.set(name, { ok: true, at: fetchedAt, error: null, source: this.#config.mock ? 'mock' : 'live' });
        this.#cache.set(name, { data: data ?? null, fetchedAt });
        this.#log.debug(`${name} refreshed in ${fetchedAt - startedAt}ms (${reason})`);
      } catch (err) {
        // Keep serving last-good; it will age into stale on its own.
        this.#status.set(name, {
          ok: false,
          at: Date.now(),
          error: err?.message ?? String(err),
          source: this.#status.get(name)?.source ?? 'empty',
        });
        this.#log.warn(`${name} refresh failed (${reason}): ${err?.message ?? err}`);
        this.#state.modules[name] = {
          data: previous?.data ?? null,
          fetchedAt: previous?.fetchedAt ?? null,
          stale: isStale(previous?.fetchedAt, this.#staleAfter(name)),
        };
      } finally {
        this.#inflight.delete(name);
      }
      this.#publish();
      return this.#state.modules[name];
    })();

    this.#inflight.set(name, run);
    return run;
  }

  async refreshAll(reason = 'boot') {
    await Promise.allSettled(this.moduleNames.map((name) => this.refresh(name, { reason })));
  }

  /** Re-evaluates ages so the dim dot appears without needing a fetch attempt. */
  recomputeStale(now = Date.now()) {
    for (const [name, entry] of Object.entries(this.#state.modules)) {
      entry.stale = isStale(entry.fetchedAt, this.#staleAfter(name), now);
    }
    return this.#publish();
  }
}

export default Store;
