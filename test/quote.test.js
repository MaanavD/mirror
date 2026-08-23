import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CREDIT,
  FALLBACK_QUOTES,
  hashDayKey,
  matchesTone,
  normalizeApiQuote,
  pickFallback,
  selectQuote,
  TONE_KEYWORDS,
} from '../src/modules/quote.js';

test('local fallback list is big enough and well formed', () => {
  assert.ok(FALLBACK_QUOTES.length >= 15, `only ${FALLBACK_QUOTES.length} fallback quotes`);
  for (const quote of FALLBACK_QUOTES) {
    assert.equal(typeof quote.text, 'string');
    assert.ok(quote.text.trim().length > 0);
    assert.ok(quote.text.length <= 140, `too long for the panel: "${quote.text}"`);
    assert.ok(quote.author.trim().length > 0, `missing author for "${quote.text}"`);
  }
});

test('tone filter recognises the grind keywords and ignores the rest', () => {
  for (const word of TONE_KEYWORDS) {
    assert.ok(matchesTone(`something about ${word} here`), `missed keyword ${word}`);
  }
  assert.ok(matchesTone('DISCIPLINE is everything'), 'should be case-insensitive');
  assert.ok(matchesTone('persistence pays'), 'should match on a stem');
  assert.equal(matchesTone('the sunset was pleasant'), false);
  assert.equal(matchesTone(''), false);
  assert.equal(matchesTone(undefined), false);
});

test('an on-tone API quote wins', () => {
  const chosen = selectQuote(
    [
      { q: 'The sunset was pleasant.', a: 'Nobody' },
      { q: 'Do the work.', a: 'Someone' },
    ],
    { dayKey: '2026-08-23' },
  );
  assert.equal(chosen.text, 'Do the work.');
  assert.equal(chosen.source, 'zenquotes');
  assert.equal(chosen.onTone, true);
  assert.equal(chosen.credit, CREDIT);
});

test('with no on-tone match we still use what the API gave us', () => {
  const chosen = selectQuote([{ q: 'The sunset was pleasant.', a: 'Nobody' }], { dayKey: '2026-08-23' });
  assert.equal(chosen.text, 'The sunset was pleasant.');
  assert.equal(chosen.source, 'zenquotes');
  assert.equal(chosen.onTone, false);
});

test('API down / empty / malformed falls back to the local list', () => {
  for (const payload of [null, undefined, [], {}, 'nope', [{}], [{ q: '   ' }]]) {
    const chosen = selectQuote(payload, { dayKey: '2026-08-23' });
    assert.equal(chosen.source, 'fallback', `payload ${JSON.stringify(payload)} should fall back`);
    assert.ok(FALLBACK_QUOTES.some((q) => q.text === chosen.text));
    assert.equal(chosen.credit, CREDIT);
  }
});

test("ZenQuotes' rate-limit notice is not treated as a quote", () => {
  const chosen = selectQuote(
    [{ q: 'Too many requests. Obtain an auth key for unlimited access.', a: 'zenquotes.io' }],
    { dayKey: '2026-08-23' },
  );
  assert.equal(chosen.source, 'fallback');
});

test('normalizeApiQuote trims, defaults the author, rejects the useless', () => {
  assert.deepEqual(normalizeApiQuote({ q: '  keep going  ', a: ' seneca ' }), {
    text: 'keep going',
    author: 'seneca',
  });
  assert.equal(normalizeApiQuote({ q: 'anon wisdom' }).author, 'unknown');
  assert.equal(normalizeApiQuote({ q: '' }), null);
  assert.equal(normalizeApiQuote(null), null);
});

test('fallback choice is stable per day and moves across days', () => {
  const monday = pickFallback('2026-08-24');
  assert.deepEqual(pickFallback('2026-08-24'), monday, 'same day must not re-roll');

  const days = Array.from({ length: 30 }, (_, i) =>
    new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10),
  );
  const distinct = new Set(days.map((day) => pickFallback(day).text));
  assert.ok(distinct.size >= 8, `only ${distinct.size} distinct quotes across 30 days`);
});

test('the day index stays inside the list for a full year of keys', () => {
  for (let i = 0; i < 366; i += 1) {
    const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    const index = hashDayKey(day) % FALLBACK_QUOTES.length;
    assert.ok(index >= 0 && index < FALLBACK_QUOTES.length);
    assert.ok(pickFallback(day).text.length > 0);
  }
});

test('the chosen quote carries its rotation day, so a restart cannot re-roll it', () => {
  assert.equal(selectQuote(null, { dayKey: '2026-08-23' }).day, '2026-08-23');
});

test('a custom fallback list is honoured (and an empty one is an error)', () => {
  const only = [{ text: 'grind', author: 'me' }];
  assert.equal(selectQuote(null, { dayKey: 'any', fallback: only }).text, 'grind');
  assert.throws(() => pickFallback('x', []), /empty/);
});
