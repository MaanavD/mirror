import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson } from '../http.js';
import { nextLocalTime, rotationDayKey } from '../time.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Read once at import (tiny file, and it must be available with no network).
// Plain readFileSync rather than a JSON import so this module has no reliance
// on import-attribute support.
export const FALLBACK_QUOTES = Object.freeze(
  JSON.parse(fs.readFileSync(path.join(HERE, 'quotes-fallback.json'), 'utf8')),
);

export const CREDIT = 'inspired by ZenQuotes';
export const ZENQUOTES_BASE = 'https://zenquotes.io/api';

/** Grind-tone preference. A match wins; otherwise we take what we were given. */
export const TONE_KEYWORDS = Object.freeze([
  'work',
  'discipline',
  'effort',
  'persist',
  'grind',
  'build',
  'courage',
  'action',
]);

export function matchesTone(text) {
  const haystack = String(text ?? '').toLowerCase();
  return TONE_KEYWORDS.some((word) => haystack.includes(word));
}

/** ZenQuotes item ({ q, a }) -> our shape. Returns null if unusable. */
export function normalizeApiQuote(item) {
  const text = String(item?.q ?? '').trim();
  const author = String(item?.a ?? '').trim();
  if (!text) return null;
  // ZenQuotes returns a rate-limit notice in the `q` field of a 200 response.
  if (/too many requests/i.test(text)) return null;
  return { text, author: author || 'unknown' };
}

/** Stable per-day index so a restart never re-rolls the day's quote. */
export function hashDayKey(dayKey) {
  let hash = 2166136261;
  const s = String(dayKey ?? '');
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function pickFallback(dayKey, list = FALLBACK_QUOTES) {
  if (!list?.length) throw new Error('fallback quote list is empty');
  const quote = list[hashDayKey(dayKey) % list.length];
  return { text: quote.text, author: quote.author };
}

/**
 * Chooses the day's quote:
 *   1. an API quote whose wording matches the grind keywords
 *   2. otherwise the first usable API quote
 *   3. otherwise the local hard-work list (API down / rate limited)
 */
export function selectQuote(apiPayload, { dayKey, fallback = FALLBACK_QUOTES } = {}) {
  const candidates = (Array.isArray(apiPayload) ? apiPayload : [])
    .map(normalizeApiQuote)
    .filter(Boolean);

  const onTone = candidates.find((q) => matchesTone(q.text));
  if (onTone) return { ...onTone, source: 'zenquotes', onTone: true, day: dayKey, credit: CREDIT };
  if (candidates.length > 0) {
    return { ...candidates[0], source: 'zenquotes', onTone: false, day: dayKey, credit: CREDIT };
  }
  return { ...pickFallback(dayKey, fallback), source: 'fallback', onTone: true, day: dayKey, credit: CREDIT };
}

export const quoteModule = {
  name: 'quote',
  staleAfterMs: 36 * 60 * 60_000,

  // Server-side rotation: 04:00 local, once. Page refreshes never re-roll it.
  nextRunAt(now, config) {
    return nextLocalTime(now, config.timezone, config.quote.rotateHour, 0);
  },

  async fetch({ config, now, previous, log }) {
    const dayKey = rotationDayKey(now, config.timezone, config.quote.rotateHour);
    const cached = previous?.data;
    if (cached?.day === dayKey && cached?.text) {
      log.debug('quote already current for this rotation day, not re-fetching');
      return cached;
    }

    try {
      const payload = await fetchJson(`${ZENQUOTES_BASE}/${config.quote.mode}`, {
        timeoutMs: config.fetchTimeoutMs,
      });
      return selectQuote(payload, { dayKey });
    } catch (err) {
      log.warn(`zenquotes unavailable (${err.message}); using local list`);
      return selectQuote(null, { dayKey });
    }
  },

  mock({ config, now }) {
    const dayKey = rotationDayKey(now, config.timezone, config.quote.rotateHour);
    return selectQuote([{ q: 'Discipline equals freedom.', a: 'Jocko Willink' }], { dayKey });
  },
};

export default quoteModule;
