# DESIGN

How the mirror is laid out, why, and how to add to it.

## The constraint that decides everything

The panel is behind two-way glass. **Black pixels are a mirror; lit pixels are a
screen.** So the design problem is not "what looks good on a dark theme", it is
"how little can be lit and still be useful at 2–5 feet".

Consequences, all non-negotiable:

| Rule | Where it lives |
| --- | --- |
| `#000` is the only fill. No greys, no tints, no cards, no panels | `styles.css` — nothing sets a background except `#000` |
| Light on black; one white plus a grey ramp | `--fg`, `--fg-2/3/4`, `--rule` |
| No large bright areas | Type is large but thin; nothing is filled |
| Centre stays sparse | `.void` grid row, `min-height: 300px`, always empty |
| No scrollbars, no cursor, no focus rings | `overflow: hidden`, `cursor: none`, `:focus{outline:none}` |
| No spinners, ever | There is no loading state in `app.js` — only content or nothing |
| Slow fades on change | `.body { transition: opacity 900ms }` |
| Burn-in mitigation | `app.js` nudges `#root` a few px every 10 min, 6s ease |

The single exception to "no colour": a warm off-white `--tint: #f5efe6` on the
clock. Set it to `#ffffff` to remove it.

## Chosen direction

Two directions were mocked up first (`public/mockups/`):

- **A · editorial** — broadsheet masthead, display serif, small-caps labels,
  hairline rules. The clock is the masthead.
- **B · instrument** — grotesk + mono, tabular numerals, tick marks and
  micro-dividers, flight-panel feel.

Production is **A**, with one thing stolen from **B**: tabular numerals
everywhere a number can change (`font-variant-numeric: tabular-nums`), so
temperatures, times and the clock never shift their neighbours when they update.
Both mockups stay in the repo as self-contained references — they embed their own
mock data and need neither the server nor the network.

## Grid

`#root` is a five-row grid at exactly 1080×1920 with 68px padding:

```
┌──────────────────────────────── 1080 ────────────────────────────────┐
│ masthead   clock (244px serif) · hairline · date            ~520px   │  auto
├──────────────────────────────────────────────────────────────────────┤
│ weather    13° ⋮⋮ rain / hi·lo   +  6-cell hours strip      ~340px   │  auto
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│ void       ← the viewer's face and body live here. Empty.            │  1fr
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ lower      today + tomorrow      │      todo by area        ~560px   │  auto
├──────────────────────────────────────────────────────────────────────┤
│ quote      hairline · serif italic · author · credit        ~240px   │  auto
└──────────────────────────────────────────────────────────────────────┘
```

Content is anchored **top** (clock, weather), **left edge** (both lower columns
start at the left padding; the agenda column is the wider one) and **bottom**
(quote). The `1fr` void absorbs all slack, so the top block and the bottom block
are pinned to their edges regardless of how many events or todos exist.

### Type scale

Two families, both with offline-safe fallbacks:

- `--serif` — Playfair Display *if installed or self-hosted*, else Iowan Old
  Style / Palatino / Georgia. The `@font-face` uses `local()` sources only, so
  there is no network font fetch to fail. To self-host, drop a woff2 into
  `public/fonts/` and add a `url()` src.
- `--mono` — `ui-monospace` stack, used by the instrument mockup and available
  for any future tabular block.

| Role | Size | Colour |
| --- | --- | --- |
| clock | 244 | `--tint` |
| weather temp | 132 | `--fg` |
| quote | 44 | `--fg-2` |
| date | 40 | `--fg-2` |
| hours temp | 40 | `--fg` |
| event title | 36 | `--fg` |
| todo item | 32 | `--fg-2` |
| event time | 30 | `--fg-3` |
| section label | 21 small-caps, 0.3em tracking | `--fg-3` |
| credit | 15 | 9% white |

Nothing is smaller than 15px, and the only 15px thing is the ZenQuotes credit,
which is required to exist but not required to be read from across the room.

### Staleness, the only status UI

`#dot` — a 9px dot, bottom-right, `opacity: 0.25`, 2s fade. It appears when any
module in `/api/state` has `stale: true`. That is the entire vocabulary: no
badges, no timestamps, no "reconnecting", no error text.

Staleness is **age-based**, not attempt-based (`src/cache.js#isStale`): a module
is stale when its last good data is older than its window (weather 45 min,
calendar/notion 20 min, quote 36 h). A single failed fetch therefore does not
light the dot — two or three missed cycles do. A restart that finds recent data
in `data/cache.json` starts clean.

## Data flow

```
scheduler ──▶ store.refresh(name) ──▶ module.fetch({config, now, previous, log})
                    │                        │
                    │                        └── throws ⇒ keep last-good, age into stale
                    ▼
              store (the /api/state blob) ──▶ SSE subscribers ──▶ browser
                    │
                    └──▶ DiskCache (data/cache.json, atomic write)
```

On the client: clock paints → `localStorage` paints → `/api/state` paints → SSE
takes over (60s polling if it drops). Each module body cross-fades only when its
payload actually changed (`JSON.stringify` signature), so a refresh that returns
identical data causes no visual event at all.

## Adding a module

Five steps. Weather is the shortest example to copy.

**1. Write the module** — `src/modules/transit.js`:

```js
export const transitModule = {
  name: 'transit',
  refreshMs: 2 * 60_000,        // or: nextRunAt(now, config) for wall-clock cadence
  staleAfterMs: 10 * 60_000,

  async fetch({ config, now, previous, log }) {
    const raw = await fetchJson(url, { timeoutMs: config.fetchTimeoutMs });
    return shapeTransit(raw, { now, timeZone: config.timezone });  // pure, testable
  },

  mock({ config, now }) {
    return shapeTransit(mockRaw(), { now, timeZone: config.timezone });
  },
};
```

Rules that keep the mirror trustworthy:

- Keep the shaping function pure and separate from `fetch` — that is what tests
  can reach without a network.
- **Throw** on an unusable payload. Throwing preserves last-good data; returning
  a half-empty object overwrites it.
- Return only what the panel renders. `/api/state` is not a data lake.
- `mock()` must be as varied as a real bad day (empty lists, long strings,
  missing fields) — it is the only way the layout gets stress-tested.

**2. Register it** — `src/modules/index.js`:

```js
export const modules = [weatherModule, calendarModule, quoteModule, notionModule, transitModule];
```

That is all the server needs: the store hydrates it from disk, the scheduler
picks up its cadence, `/api/state` and SSE include it, and `/healthz` reports it.

**3. Give it a home in the markup** — `public/index.html`, inside the row that
suits it (top for glanceable numbers, lower deck for lists, never the `.void`):

```html
<section class="col" id="transit" data-module="transit">
  <div class="label">transit</div>
  <hr class="rule" />
  <div class="body"></div>
</section>
```

**4. Render it** — `public/app.js`: add the `.body` to `bodies`, add a renderer
to `renderers`. Build nodes with `el()` / `textContent` (never `innerHTML`), and
return early when the data is missing so the module simply is not there.

**5. Style it** — `public/styles.css`, reusing the tokens. If you find yourself
adding a colour or a background, the design has gone wrong.

Optional: add env keys to `config.js` **and** `.env.example` with a comment, and
a pure-function test in `test/`.

## Testing

`node --test`, no framework. The three suites cover the logic most likely to be
silently wrong for weeks:

- `test/wmo.test.js` — code→text/glyph mapping, unknown-code fallback, glyphs
  restricted to a vetted non-emoji character set, intensity escalates within a
  precipitation family.
- `test/quote.test.js` — tone filter, API-down fallback, rate-limit notice
  rejection, per-day determinism.
- `test/cache.test.js` — staleness boundaries, clock skew, corrupt/missing cache
  files, disk round-trip, atomic write leaves no temp files.
