import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The kiosk frontend has no DOM harness and no bundler, so the only contract
// between index.html, styles.css and app.js is the markup itself. These tests
// guard the two things a careless edit breaks silently on a mirror nobody is
// watching: the mount ids app.js binds at boot, and the edge-rail geometry that
// keeps the centre corridor (x 340..740) clear of the viewer's reflected head.

const read = (name) =>
  readFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), 'utf8');

const html = read('index.html');
const css = read('styles.css');
const js = read('app.js');

/** Byte offset of a marker in index.html, asserting it is there at all. */
function at(marker) {
  const i = html.indexOf(marker);
  assert.notEqual(i, -1, `index.html is missing ${marker}`);
  return i;
}

// ---------------------------------------------------------------------------
// Mount points
// ---------------------------------------------------------------------------

test('every element id app.js looks up exists in the markup', () => {
  const ids = new Set();
  for (const m of js.matchAll(/(?:\bq\('|getElementById\(')#?([\w-]+)/g)) ids.add(m[1]);

  // Sanity: the sweep found the real bindings, not an empty set.
  assert.ok(ids.has('cal-today'), 'id sweep missed the calendar mounts');
  assert.ok(ids.size >= 12, `id sweep only found ${ids.size} ids`);

  for (const id of ids) at(`id="${id}"`);
});

test('the calendar keeps both day slots under their existing ids', () => {
  assert.match(js, /calendar:\s*\[q\('#cal-today'\),\s*q\('#cal-tomorrow'\)\]/);
  assert.ok(html.includes('id="cal-today"'));
  assert.ok(html.includes('id="cal-tomorrow"'));
});

// ---------------------------------------------------------------------------
// Edge-rail composition
// ---------------------------------------------------------------------------

test('the agenda lives in the right rail, under the weather', () => {
  const rail = at('<div class="rail">');
  assert.ok(at('class="masthead"') < rail, 'the masthead is not the left rail');
  assert.ok(rail < at('id="wx-today"'), 'weather is outside the rail');
  assert.ok(at('id="wx-today"') < at('id="cal-today"'), 'the agenda is above the weather');
  assert.ok(at('id="cal-today"') < at('id="cal-tomorrow"'), 'tomorrow is above today');
  assert.ok(at('id="cal-tomorrow"') < at('id="leaveby"'), 'leave-by is above the agenda');
});

test('the two days stack as one column instead of sitting side by side', () => {
  const cols = [...html.matchAll(/class="cal-col/g)];
  assert.equal(cols.length, 2, 'expected exactly one column per day');
  assert.equal([...html.matchAll(/class="cal-head"/g)].length, 2);
  // The old layout labelled the second column with an inactive folder tab
  // parked at 52% of a full-width frame; at rail width there is no 52%.
  assert.ok(!html.includes('tab aux'), 'the side-by-side aux tab is back');
  assert.doesNotMatch(css, /\.tab\.aux/);
});

test('the right rail is a fixed narrow column pinned to the panel edge', () => {
  const token = /--rail-w:\s*(\d+)px/.exec(css);
  assert.ok(token, '--rail-w token missing');
  const width = Number(token[1]);
  assert.ok(width <= 400, `rail is ${width}px, wider than the 400px budget`);

  // 1080 - 40 (pad) - 400 = 640: still right of the reflected head's widest
  // point; the 400 budget was traded for calendar-title room (Aug 23).
  assert.ok(1080 - 40 - width >= 640, 'the rail reaches left of x=640');

  const deck = /\.deck\s*\{([^}]*)\}/.exec(css);
  assert.ok(deck, '.deck rule missing');
  assert.match(deck[1], /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*var\(--rail-w\)/);
});

test('the left rail cannot print below the top of the corridor', () => {
  const masthead = /\.masthead\s*\{([^}]*)\}/.exec(css);
  assert.ok(masthead, '.masthead rule missing');
  // The deck starts at y=72, so a 208px cap puts the clip line at y=280.
  const cap = /max-height:\s*(\d+)px/.exec(masthead[1]);
  assert.ok(cap, '.masthead has no max-height, so the clock stack is unbounded');
  assert.ok(72 + Number(cap[1]) <= 280, 'the masthead can reach into the corridor');
  assert.match(masthead[1], /overflow:\s*hidden/);
});

test('the rails clip above the bottom band, which keeps its own edge', () => {
  const rows = /grid-template-rows:\s*(\d+)px\s+(\d+)px\s+1fr/.exec(css);
  assert.ok(rows, '#root row template missing');
  const [railRow, openGlass] = [Number(rows[1]), Number(rows[2])];
  assert.equal(16 + railRow + openGlass, 1472, 'the bottom band moved off its edge');

  // The rail row is only a clip line, and the right rail is the one column with
  // no corridor above it (x 740..1040), so the row may be deepened to buy the
  // agenda vertical room — that is where the larger type came from. What it may
  // not do is reach the bottom band's lit content, which starts around y=1590.
  assert.ok(
    16 + railRow <= 1450,
    `the rail row clips at y=${16 + railRow}, into the bottom band's air`,
  );
});
