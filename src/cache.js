import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Normalises the many shapes a timestamp can arrive in (epoch ms, ISO string,
 * Date) to epoch ms, or null when unusable.
 */
export function toEpochMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    // Digits first: Date.parse of a bare epoch-ms string is implementation-defined.
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Staleness is age-based, so a restart that finds recent data on disk does NOT
 * light the dim dot, while a module whose upstream has been failing for a while
 * does. No data at all is always stale. Clock skew (future timestamps) is
 * treated as fresh rather than as a bug the mirror shouts about.
 */
export function isStale(fetchedAt, staleAfterMs, now = Date.now()) {
  const at = toEpochMs(fetchedAt);
  if (at === null) return true;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) return false;
  return now - at >= staleAfterMs;
}

/** True when any module in a state blob is serving stale data. */
export function anyStale(modules) {
  if (!modules || typeof modules !== 'object') return false;
  return Object.values(modules).some((entry) => Boolean(entry?.stale));
}

/**
 * Last-good data for every module, mirrored to a single JSON file so a cold
 * boot with no network still has something to render.
 */
export class DiskCache {
  #file;
  #entries = {};
  #flushTimer = null;
  #writing = null;
  #dirty = false;

  constructor(file) {
    this.#file = file;
  }

  get file() {
    return this.#file;
  }

  /** Synchronous on purpose: it runs once, before the first render can happen. */
  loadSync() {
    try {
      const raw = fs.readFileSync(this.#file, 'utf8');
      const parsed = JSON.parse(raw);
      this.#entries = parsed && typeof parsed === 'object' && parsed.entries ? parsed.entries : {};
    } catch {
      // missing or corrupt cache is a normal cold start, not an error
      this.#entries = {};
    }
    return this.#entries;
  }

  get(name) {
    return this.#entries[name];
  }

  all() {
    return { ...this.#entries };
  }

  set(name, entry) {
    this.#entries[name] = entry;
    this.#dirty = true;
    this.#scheduleFlush();
  }

  #scheduleFlush() {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flush().catch(() => {});
    }, 500);
    this.#flushTimer.unref?.();
  }

  /** Atomic write so a power cut mid-flush cannot leave a truncated cache. */
  async flush() {
    if (!this.#dirty) return;
    if (this.#writing) return this.#writing;
    this.#dirty = false;
    const payload = JSON.stringify({ version: 1, savedAt: Date.now(), entries: this.#entries }, null, 2);
    const tmp = `${this.#file}.${process.pid}.tmp`;
    this.#writing = (async () => {
      await fsp.mkdir(path.dirname(this.#file), { recursive: true });
      await fsp.writeFile(tmp, payload, 'utf8');
      await fsp.rename(tmp, this.#file);
    })();
    try {
      await this.#writing;
    } finally {
      this.#writing = null;
    }
  }

  async close() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    await this.flush().catch(() => {});
  }
}
