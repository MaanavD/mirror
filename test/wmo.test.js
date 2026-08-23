import assert from 'node:assert/strict';
import test from 'node:test';
import { GLYPH_CHARS, UNKNOWN, wmo, wmoCodes, wmoGlyph, wmoText } from '../src/modules/wmo.js';

test('maps the codes that actually show up in Seattle', () => {
  assert.equal(wmoText(0), 'clear');
  assert.equal(wmoText(2), 'partly cloudy');
  assert.equal(wmoText(3), 'overcast');
  assert.equal(wmoText(45), 'fog');
  assert.equal(wmoText(61), 'light rain');
  assert.equal(wmoText(63), 'rain');
  assert.equal(wmoText(65), 'heavy rain');
  assert.equal(wmoText(80), 'light showers');
  assert.equal(wmoText(95), 'thunderstorm');
});

test('cloud cover reads as progressive fill', () => {
  assert.deepEqual([0, 1, 2, 3].map(wmoGlyph), ['○', '◔', '◑', '◕']);
});

test('unknown, missing and junk codes degrade instead of throwing', () => {
  for (const input of [7, 999, -1, null, undefined, '', 'rain', NaN, {}, []]) {
    const result = wmo(input);
    assert.equal(result, UNKNOWN, `expected fallback for ${JSON.stringify(input)}`);
    assert.equal(result.text, 'unknown');
    assert.equal(result.glyph, '·');
  }
});

test('numeric strings still map (the API is JSON, but be forgiving)', () => {
  assert.equal(wmo('61').text, 'light rain');
  assert.equal(wmo('61').code, 61);
});

test('every mapped code has usable, lowercase text', () => {
  for (const code of wmoCodes()) {
    const { text } = wmo(code);
    assert.ok(text.length > 0, `code ${code} has empty text`);
    assert.equal(text, text.toLowerCase(), `code ${code} text is not lowercase`);
    assert.ok(text.length <= 20, `code ${code} text too long for 2–5ft reading: "${text}"`);
  }
});

test('glyphs stay inside the safe, non-emoji character set', () => {
  const allowed = new Set([...GLYPH_CHARS, ...UNKNOWN.glyph]);
  const emoji = /\p{Extended_Pictographic}|\uFE0F|[\u{1F000}-\u{1FAFF}]/u;

  for (const code of wmoCodes()) {
    const { glyph } = wmo(code);
    assert.ok(glyph.length > 0, `code ${code} has no glyph`);
    assert.ok(!emoji.test(glyph), `code ${code} glyph is emoji: ${glyph}`);
    for (const char of glyph) {
      assert.ok(allowed.has(char), `code ${code} uses unvetted glyph char ${char}`);
    }
  }
});

test('intensity is monotonic within a precipitation family', () => {
  for (const family of [
    [51, 53, 55],
    [61, 63, 65],
    [71, 73, 75],
    [80, 81, 82],
  ]) {
    const lengths = family.map((code) => wmoGlyph(code).length);
    assert.deepEqual(
      lengths,
      [...lengths].sort((a, b) => a - b),
      `family ${family.join(',')} glyphs do not escalate`,
    );
  }
});
