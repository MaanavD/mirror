# Mirror feature wave 2 — architecture + worker briefs

Locked features: #1 now/next, #3 readiness+split, #6 rain sparkline, #9 leave-by v2,
#21 Hermy commentary, #22 chip drop, #41 virus busting, #42 weather battle,
#43 mystery data, #44 emotion window (+ sleep/alarm sub-line).

## Anti-bloat principle: slots, not tiles

No feature gets a permanent new region. The screen keeps its existing skeleton
(masthead clock left, right rail, center corridor empty, bottom band). New
features share four SLOTS with time/presence gating:

| Slot | Location | Occupants (rotation/priority) |
|---|---|---|
| S1 FOCUS LINE | top of bottom band, full width | #1 now/next (always in ACTIVE mode) |
| S2 WELLNESS | right rail, below countdown | #44 emotion window glyph + sub-line: readiness score, today's split (#3), next Eight Sleep alarm |
| S3 DATA CARD | bottom band right cell | #22 chip drop (daily) ⟷ #43 mystery data (takes over on its weekly day, decrypts 6am→9pm) |
| S4 HERMY | existing Hermy sprite area | #21 commentary lines, #42 battle stance vs weather enemy |

#6 rain sparkline extends the existing weather block in place (no new slot).
#9 leave-by v2 upgrades leaveby.js in place.
#41 virus busting replaces the existing Notion task list rendering in place.

## Mode gating (presence + time)

- Modes already exist: CALM/ACTIVE via /api/presence, night mode via schedule.
- CALM: S1 hidden, S2 glyph only (no sub-line), S3 static, Hermy idle.
- ACTIVE: everything live. NIGHT: unchanged minimal set, none of the new slots.
- Time weighting: S2 sub-line shows alarm+readiness in MORNING (wake→11am),
  split+deep-work in DAY, tomorrow's alarm in EVENING.

## Feature specs

### F1 now/next focus line (#1) — module: src/modules/focus.js
Derive from existing calendar module data. Format:
`NOW: <event> · ENDS 3:00PM   NEXT: <event> IN 45M`
No current event → `NEXT: gym IN 45M` only. Truncate single line, Press Start 2P,
integer-of-8 sizing. Server-side compute in /api/state.

### F3+F44 wellness/emotion window — module: src/modules/wellness.js
Inputs: eight_sleep readiness (port readiness() from
~/.hermes/scripts/eight_sleep_client.py into node or shell out to python3),
calendar density (events today / waking hours), weather code.
Emotion = composite → one of 5 PET glyphs (pixel-art, drawn as sprite or
unicode block art): CHARGED / STEADY / TIRED / OVERLOADED / STORMY.
Sub-line (time-weighted per gating table), e.g. `HRV 62 · PULL DAY · ALARM 6:40A`.
Eight Sleep creds via env (same as script). Alarm read: client-api routines
endpoint if available from trends payload; if not reachable, omit alarm segment.
Write support: stub function setAlarm() behind ENABLE_EIGHTSLEEP_WRITE=0, not wired to UI.

### F6 rain sparkline — extend src/modules/weather.js
Open-Meteo minutely_15 precipitation next 2h → 8-bucket sparkline using block
glyphs ▁▂▃▅▇ rendered in weather block only when any bucket > 0. Label `RAIN 2H`.

### F9 leave-by v2 — extend src/modules/leaveby.js
For next 3 calendar events WITH a location field: geocode (existing maps stack:
OSM/Nominatim + OSRM drive time), compute leave-by = start − drive − 8min buffer.
Chip shows soonest: `LEAVE 2:10P → SBP FREMONT`. Never hardcode places; events
without location are skipped. Cache geocodes (sqlite/json file) to respect rate limits.

### F41 virus busting — rework notion task rendering (public/app.js + notion.js)
Each open Notion task = a Mettaur-class virus sprite (2-3 tiny pixel variants,
drawn fresh, NOT ripped assets) + truncated task name. Task completed since last
poll = deletion flash animation (2 frames, ≤1.5s), then removed. >6 tasks →
show 6 + `+N VIRUSES`. Empty = `AREA CLEAN`.

### F21+F42 Hermy reactions — public/app.js state machine + src/modules/hermy.js
Event bus from state: rain incoming, readiness < threshold, flight ≤ 24h,
heat ≥ 90F, storm/wind codes. Each maps to a dialogue line (BN tone, ≤34 chars)
shown in Hermy's existing dialogue spot, rotating with idle lines.
Weather battle rides the same machine: severe weather → Hermy battle-stance
sprite frame + enemy nameplate `VS STORMY.EXE` / `HEATWAVE.EXE` / `GUST.EXE`.
No new layout region.

### F22 chip drop — module: src/modules/chipdrop.js
Daily deterministic pick (date-seeded) from ~20 chip defs, each binding a real
stat: AirShot→max gust today, Recover80→sleep score, LongSword→longest calendar
block, Barrier→AQI, etc. Card: chip name, pixel icon (drawn), stat line.
Renders in S3.

### F43 mystery data — module: src/modules/mystery.js
Sundays (or date-seeded 1/wk): S3 shows `???` + scrambled text; scramble resolves
progressively by hour (6am fully scrambled → 9pm plain). Fact computed from own
data history: best sleep of month, most-played artist (spotify), busiest day,
longest streak. Store weekly pick in data/mystery.json.

## Hard constraints (every worker)
- Pure black bg, BN/PET line work, Press Start 2P sizes = multiples of 8.
- Center corridor x=340..740 y=280..1600 stays EMPTY. Bottom band starts ≥y=1590
  (S1/S3 live inside existing band, may not grow it upward beyond 60px).
- Single-line truncation everywhere. No layout shift when data missing: hide, don't reflow.
- Every module: graceful degradation (API down → slot hidden), tests in test/,
  `node --test` green, no new npm deps without approval.
- Server modules follow existing pattern in src/modules/index.js registration.

## Worker fan-out plan
Isolated git worktrees per feature branch off master; two engines run
simultaneously on disjoint feature sets (no file overlap where possible):
- Lane A (opencode / free models): F6 rain, F1 focus line, F22 chip drop
- Lane B (ox-alpha via openrouter): F41 virus busting, F21+42 hermy, F43 mystery
- Lane C (kept local/main agent, cross-cutting): F44 wellness (creds), F9 leave-by v2 (geocode cache), slot gating framework, final integration
Quota: 3 failed attempts per feature then stop. Integration is manual: review
diff, run suite, corridor probe, screenshot, then single deploy.
