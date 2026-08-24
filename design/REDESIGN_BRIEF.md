# Mirror redesign brief (2026-08-23 night pass)

Target: /home/hermes/mirror, 1080x1920 portrait, two-way mirror OLED. Background stays pure #000; light-on-black only; no large bright fills. Mega Man Battle Network (PET console) grammar per design/BN_REFERENCE.md is locked: notched line-work frames, skewed header tabs, cursor markers, chip cards, cyan/blue/white with restrained alert colors.

## Hard layout constraints (from Maanav, at the mirror)
1. FACE ZONE: the vertical center band of the screen, roughly y=480..1250, must be black and content-free. His face reflects there. The current calendar frame sits exactly on his face. Nothing persistent may render in that zone (transient overlays like vinyl/now-playing are grandfathered but should sit low).
2. Calendar (today/tomorrow) must move OUT of the face zone. Put it in the top band or bottom band; redesign the top band composition freely as long as total lit area does not grow.
3. Hermy sprite stays lower-right, directly above the tasks frame (verify it renders there; fix if it doesn't).
4. Kill the moon data from the astro line. Keep sunrise / sunset / UV and make them MORE visible: larger type, small line-work glyphs (sun-up arrow, sun-down arrow, UV index), not a dim one-liner.
5. Quote stays lower-left, news line stays a single dim line, tasks stay lower-right.

## Wow pass (the actual point): motion & polish
Roommate verdict was "not that impressive". Fix with motion, not more data:
- Animated weather glyphs: line-work sun with slowly rotating rays; drizzle/rain as falling dashed streaks inside the glyph; clouds drifting 1-2px; snow if applicable. SVG or CSS only, subtle, OLED-safe (thin strokes, no fills).
- Ambient life: the existing status square breathes; add occasional scanline sweep across a frame (every few minutes, 1s, very dim), tab shimmer on data refresh, digits that flip/tick smoothly when the clock changes (translate/fade, not flip-card).
- Smooth transitions everywhere: module data changes crossfade (150-250ms); frames draw themselves in on first paint (stroke-dashoffset animation) after the JACK IN boot.
- Calm/flashy modes: implement a `mode` state machine in app.js: `calm` (default: everything above at ~40% intensity, slower cycles) and `active` (full animations). Trigger `active` for 90s on: SSE `say` event, track change on Spotify, or POST /api/presence (future mmWave sensor posts here; add the endpoint, token-authed like /api/say). Night mode (22:30-05:00) overrides both and stays as-is.
- prefers-reduced-motion must disable all of it (existing convention).

## Rules
- Never grow total lit area beyond current; the mirror is the product.
- All data contracts, /api/state shape, SSE behavior, and existing module code paths stay compatible. Do not break the 123 passing tests; add tests for the presence endpoint and mode machine.
- No new npm dependencies.
- Do not touch .env, secrets, or server integrations other than adding /api/presence.
- Commit in logical chunks with plain commit messages.
