import assert from 'node:assert/strict';
import test from 'node:test';
import { filterStories, MIN_SCORE, normalizeStory, truncateTitle, TOP_N } from '../src/modules/news.js';
import newsModule from '../src/modules/news.js';

test('normalizeStory keeps title + score and rejects the unusable', () => {
  assert.deepEqual(normalizeStory({ title: 'Hello', score: 200 }), { title: 'Hello', score: 200 });
  assert.deepEqual(normalizeStory({ title: '  spaced  ', score: '150' }), { title: 'spaced', score: 150 });
  assert.deepEqual(normalizeStory({ title: 'no score' }).score, 0);
  assert.equal(normalizeStory({ title: '' }), null);
  assert.equal(normalizeStory({ score: 300 }), null);
  assert.equal(normalizeStory(null), null);
  assert.equal(normalizeStory(undefined), null);
  assert.equal(normalizeStory('nope'), null);
});

test('truncateTitle leaves short titles alone and caps long ones with an ellipsis', () => {
  const short = 'a'.repeat(40);
  assert.equal(truncateTitle(short), short);
  const long = 'b'.repeat(120);
  const cut = truncateTitle(long);
  assert.equal(cut.length, 70);
  assert.ok(cut.endsWith('…'), 'should end with an ellipsis');
  // Trims a dangling space before the ellipsis.
  assert.equal(truncateTitle('c'.repeat(69) + ' x'), 'c'.repeat(69) + '…');
});

test('filterStories drops the score floor, caps at TOP_N, and truncates', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    title: `Story ${i} ${'z'.repeat(120)}`,
    score: i * 100,
  }));
  const out = filterStories(items, { minScore: MIN_SCORE, limit: TOP_N });
  // scores 0..1900; >=150 means index 2..19 -> many, but capped at TOP_N (8).
  assert.equal(out.length, TOP_N);
  for (const story of out) {
    assert.ok(story.score >= MIN_SCORE, `kept a sub-floor story: ${story.score}`);
    assert.ok(story.title.length <= 70, 'title not truncated');
    assert.ok(!story.title.includes('z'.repeat(70)), 'title still overflowing');
  }
  // Preserves order: highest-id survivors first (index 2 is lowest kept score).
  assert.equal(out[0].score, 200);
});

test('filterStories returns nothing when everything is under the floor', () => {
  const items = [{ title: 'small', score: 10 }, { title: 'tinier', score: 5 }];
  assert.deepEqual(filterStories(items), []);
});

test('filterStories tolerates junk and missing fields without throwing', () => {
  const items = [null, undefined, {}, { score: 500 }, { title: 'ok', score: 999 }];
  const out = filterStories(items);
  assert.deepEqual(out, [{ title: 'ok', score: 999 }]);
});

test('fetch returns a normalized payload and skips low-score items (mocked fetch)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('topstories')) {
      return { ok: true, text: async () => JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) };
    }
    const id = Number(url.replace(/^.*\/item\/(\d+)\.json$/, '$1'));
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          title: `Headline number ${id}`,
          score: id * 100, // ids 1..10 -> 100..1000; floor is 150
        }),
    };
  };

  try {
    const log = { warn() {}, debug() {} };
    const data = await newsModule.fetch({ config: { fetchTimeoutMs: 1000 }, log });
    assert.ok(Array.isArray(data), 'expected an array payload');
    // ids 1..8 fetched; scores 100..800; >=150 -> ids 2..8 (7 stories)
    assert.ok(data.length >= 1 && data.length <= 8);
    for (const story of data) {
      assert.ok(story.score >= MIN_SCORE);
      assert.ok(story.title.length <= 70);
    }
    assert.equal(data[0].title, 'Headline number 2');
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetch returns null on a failed upstream (mocked fetch that throws)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  try {
    const log = { warn() {}, debug() {} };
    const data = await newsModule.fetch({ config: { fetchTimeoutMs: 1000 }, log });
    assert.equal(data, null);
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetch returns null when HN sends no stories (mocked fetch)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify([]) });
  try {
    const log = { warn() {}, debug() {} };
    const data = await newsModule.fetch({ config: { fetchTimeoutMs: 1000 }, log });
    assert.equal(data, null);
  } finally {
    globalThis.fetch = orig;
  }
});

test('mock() yields a usable, in-floor payload', () => {
  const data = newsModule.mock();
  assert.ok(Array.isArray(data) && data.length > 0);
  for (const story of data) {
    assert.ok(story.score >= MIN_SCORE);
    assert.ok(story.title.length > 0 && story.title.length <= 70);
  }
});
