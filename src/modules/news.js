import { fetchJson } from '../http.js';

const HN_TOP = 'https://hacker-news.firebaseio.com/v0/topstories.json';
const HN_ITEM = (id) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

const TOP_N = 8;
const MIN_SCORE = 150;
const MAX_TITLE = 70;

export { MIN_SCORE, TOP_N };

/** HN item -> { title, score }, or null if it cannot be shown. */
export function normalizeStory(item) {
  if (!item || typeof item !== 'object') return null;
  const title = String(item.title ?? '').trim();
  const score = Number(item.score);
  if (!title) return null;
  return { title, score: Number.isFinite(score) ? score : 0 };
}

/** Hard cap so a long headline cannot run off the lit band. */
export function truncateTitle(title, max = MAX_TITLE) {
  const text = String(title ?? '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Collapses raw HN items into the deliberately small mirror payload:
 * title + score only, dropping anything under the score floor, capped at TOP_N.
 */
export function filterStories(items, { minScore = MIN_SCORE, limit = TOP_N } = {}) {
  return (Array.isArray(items) ? items : [])
    .map(normalizeStory)
    .filter(Boolean)
    .filter((story) => story.score >= minScore)
    .slice(0, limit)
    .map((story) => ({ title: truncateTitle(story.title), score: story.score }));
}

export const newsModule = {
  name: 'news',
  staleAfterMs: 45 * 60_000,
  refreshMs: 15 * 60_000,

  async fetch({ config, log }) {
    try {
      const ids = await fetchJson(HN_TOP, { timeoutMs: config.fetchTimeoutMs });
      if (!Array.isArray(ids) || ids.length === 0) {
        log.warn('news: HN returned no top stories');
        return null;
      }

      // Only the top 8 are ever fetched — a keyless public API, so stay light.
      const top = ids.slice(0, TOP_N);
      const items = await Promise.all(
        top.map((id) =>
          fetchJson(HN_ITEM(id), { timeoutMs: config.fetchTimeoutMs }).catch(() => null),
        ),
      );

      const stories = filterStories(items, { minScore: MIN_SCORE, limit: TOP_N });
      return stories.length ? stories : null;
    } catch (err) {
      log.warn(`news fetch failed: ${err.message}`);
      return null;
    }
  },

  mock() {
    return filterStories(
      [
        { title: 'Show HN: I built a smart mirror that runs on a Pi', score: 412 },
        { title: 'The quiet death of the RSS reader', score: 287 },
        { title: 'Why your side project should be boring', score: 231 },
        { title: 'A tiny terminal that fits in a tweet', score: 198 },
        { title: 'Reverse engineering the Battle Network PET', score: 176 },
      ],
      { minScore: MIN_SCORE, limit: TOP_N },
    );
  },
};

export default newsModule;
