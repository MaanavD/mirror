/**
 * WMO weather interpretation codes -> lowercase text + a minimal line glyph.
 *
 * No emoji, no icon font: the kiosk may be offline and colourful glyphs break
 * mirror physics anyway. Glyphs are drawn from a deliberately tiny character
 * set that exists in the fonts shipped with Raspberry Pi OS (DejaVu / Noto):
 *
 *   ○ ◔ ◑ ◕   sky, filled in proportion to cloud cover
 *   ≡         fog
 *   ·         drizzle (repeated for intensity)
 *   ⋮         rain (repeated for intensity)
 *   ∗         snow (repeated for intensity)
 *   ≈         freezing, as a prefix
 *   ↯         thunder
 */
export const GLYPH_CHARS = '○◔◑◕≡·⋮∗≈↯';

export const UNKNOWN = Object.freeze({ code: null, text: 'unknown', glyph: '·' });

const TABLE = new Map(
  Object.entries({
    0: ['clear', '○'],
    1: ['mainly clear', '◔'],
    2: ['partly cloudy', '◑'],
    3: ['overcast', '◕'],

    45: ['fog', '≡'],
    48: ['freezing fog', '≈≡'],

    51: ['light drizzle', '·'],
    53: ['drizzle', '··'],
    55: ['heavy drizzle', '···'],
    56: ['freezing drizzle', '≈·'],
    57: ['freezing drizzle', '≈··'],

    61: ['light rain', '⋮'],
    63: ['rain', '⋮⋮'],
    65: ['heavy rain', '⋮⋮⋮'],
    66: ['freezing rain', '≈⋮'],
    67: ['freezing rain', '≈⋮⋮'],

    71: ['light snow', '∗'],
    73: ['snow', '∗∗'],
    75: ['heavy snow', '∗∗∗'],
    77: ['snow grains', '·∗'],

    80: ['light showers', '⋮'],
    81: ['showers', '⋮⋮'],
    82: ['violent showers', '⋮⋮⋮'],

    85: ['snow showers', '∗'],
    86: ['heavy snow showers', '∗∗'],

    95: ['thunderstorm', '↯'],
    96: ['thunderstorm, hail', '↯∗'],
    99: ['severe thunderstorm', '↯∗∗'],
  }).map(([code, [text, glyph]]) => [Number(code), Object.freeze({ code: Number(code), text, glyph })]),
);

/** Every mapped code, for tests and docs. */
export function wmoCodes() {
  return [...TABLE.keys()].sort((a, b) => a - b);
}

/**
 * Never throws, never returns undefined: unknown codes degrade to a dot.
 * Numeric strings are accepted; `''`, `[]` and friends are not (they would
 * coerce to 0 and silently claim "clear").
 */
export function wmo(code) {
  let n = null;
  if (typeof code === 'number') n = code;
  else if (typeof code === 'string' && code.trim() !== '') n = Number(code);
  if (n === null || !Number.isFinite(n)) return UNKNOWN;
  return TABLE.get(n) ?? UNKNOWN;
}

export function wmoText(code) {
  return wmo(code).text;
}

export function wmoGlyph(code) {
  return wmo(code).glyph;
}

export default wmo;
