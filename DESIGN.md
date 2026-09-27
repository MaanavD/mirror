# DESIGN

How the mirror is laid out, why, and how to add to it.

## The constraint that decides everything

The panel is behind two-way glass. **Black pixels are a mirror; lit pixels are a
screen.** The question is never "what else could we show", it is "what is the
least that answers the question I have while standing here".

| Rule | Where it lives |
| --- | --- |
| `#000` is the only fill. No cards, no panels | `dashboard.css` |
| The corridor x 340–740, y 300–1552 is empty — that's you | `dashboard.css` header comment |
| One thing is said once. Whatever the headline names is not repeated in a rail | `renderStream` in `dashboard.js` |
| No spinners, no error text. Stale data disappears or says so in one muted line | every renderer returns early |
| Change fades in, identical data causes no visual event | `replace()` signatures |
| Burn-in: the canvas drifts ±3px every 10 min | bottom of `dashboard.js` |

## Geometry (1080×1920)

```
┌──────────────────────────────── 1080 ────────────────────────────────┐
│ 2:10 PM                                              ◐ 14°           │  top band
│ Sunday, September 27   ■ Flower on                   Partly cloudy   │  y 36–300
│ ▌NEXT 4:00 PM · in 1h 50m · Video call                               │
│ ▌FLUX demo dry run                                                   │
├──────────────┬───────────────────────────────┬───────────────────────┤
│ REST OF TODAY│                               │ WEATHER AHEAD         │
│ ◇ 12:30–2:30 │                               │ Rain around 5 PM      │
│   Last caff. │          (reflection)         │ 3 PM ◐ 15°  …         │  rails
│ · 2h free    │                               │ WORTH YOUR TIME       │  y 348–1520
│ □ 7:00 PM    │                               │ COMING UP             │
│ ◆ 12:30 AM   │                               │ SF Move     18 days   │
│   Bed → 8:30 │                               │                       │
├──────────────┴───────────────────────────────┴───────────────────────┤
│ agents · now playing · Hermy + quote                                 │  y 1552–1872
└──────────────────────────────────────────────────────────────────────┘
```

- **Headline** (`headlineFor` in `day-model.js`) — the single answer to "what
  matters right now". Priority: starting within 15 min → happening now → the
  sleep phase (wind-down / bedtime / morning) → next event → clear. One line of
  context in small type, then the thing itself in large type.
- **Rest of today** (`streamFor`) — one chronological list on one spine: events,
  free stretches ≥ 1h between them, the *next* sleep cutoff, bed. When nothing
  is left before bed, tomorrow's first two events take the space.
- **Right rail** — what the next hours hold (weather, then tasks, then dates).
- **Bottom band** — ambient: agents working, music, Hermy's line.

## Context: phase and linger

`public/sleep-model.js` turns the calendar and Eight Sleep into one night
schedule, shared by the browser and `src/night-guard.js`, so the bed time on the
glass is the bed time the hardware obeys.

| Phase | When | What changes |
| --- | --- | --- |
| `morning` | wake → +3h | Headline: last night's sleep + first commitment |
| `day` | — | Default |
| `winddown` | bed − 2h → bed | Warm palette (no blue), tasks and agents hidden, rail becomes "Tonight" with every remaining cutoff |
| `bedtime` | bed → bed + 30m | Clock and "Sleep now: 7h 40m" only, dimmed |
| `night` | → wake | Panel held dark by the guard; if released, the same minimal face, dimmer |

**Linger**: standing at the mirror for 8s (`sensors.present`) adds a second
layer — more stream rows, all four tasks, agent task names, light levels.
Everything in the first layer must stand on its own.

## Type and colour

VT323 for everything read, Press Start 2P only for small section labels and the
headline keyword. Palette tokens in `:root`; `body.warm` swaps them for the
evening. Sizes: clock 140, headline 50, rail titles 27–29, meta 20–22. Nothing
below 20px except pixel-font labels (12–14px, which read larger).

## Data flow

```
scheduler ──▶ store.refresh(name) ──▶ module.fetch({config, now, previous, log})
night-guard ─▶ store.setSleep()             └── throws ⇒ keep last-good, age into stale
                    ▼
              store (/api/state) ──▶ SSE ──▶ dashboard.js render() every 5s + on change
```

## Adding a module

1. `src/modules/<name>.js` exporting `{ name, refreshMs, staleAfterMs, fetch, mock }`.
   Keep shaping pure; **throw** on an unusable payload so last-good survives.
2. Register it in `src/modules/index.js`; add its freshness window to
   `WINDOWS` in `public/attention.js`.
3. Render it in `dashboard.js` with `replace(id, signature, build)` into a
   container in `dashboard.html`. Pick the band by the question it answers:
   *now* → headline, *later today* → stream row, *ambient* → bottom band.
   Never the corridor.
4. Add an `?example=` scenario in `dashboard-examples.js` and a pure test.
