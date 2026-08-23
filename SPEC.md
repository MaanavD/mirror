# mirror — smart mirror dashboard

Two-way mirror, 40" 1080x1920 portrait panel behind glass, driven by a Raspberry Pi
running Chromium kiosk pointed at THIS server (runs on the tailnet host, not the Pi).
Fresh build. Node 22, Express, vanilla frontend, no build step, no heavy framework.

## Mirror physics (non-negotiable)
- Background pure #000 everywhere. Black = invisible mirror. No grays/tints as fills.
- Light-on-black only. White/near-white primary, dim gray secondary. No large bright areas.
- CENTER of the panel stays sparse (viewer's face/body). Anchor content top, left edge, bottom.
- Readable 2–5 ft: generous type, no dense text, no tiny labels.
- No scrollbars, no cursor (hide it), no focus rings. `overflow: hidden` everywhere.
- Burn-in: shift whole layout by a few px every ~10 min (subtle transform, slow transition).
- No spinners ever. Slow fades on data changes.

## Modules
1. Clock + date. Hero. 24h. Client-side JS, never network-dependent.
2. Weather, Seattle, °C. Open-Meteo (no key):
   https://api.open-meteo.com/v1/forecast?latitude=47.6062&longitude=-122.3321&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=America%2FLos_Angeles
   Current temp + condition, today hi/lo, compact next-few-hours strip. Map WMO codes to
   minimal text/line glyphs (no emoji, no colorful icon fonts).
3. Calendar: Google Calendar v3 with refresh-token OAuth. Multiple calendar ids from
   .env `GOOGLE_CALENDAR_IDS` (comma-separated). TODAY (time + title) and TOMORROW
   (first 2–3). All-day events handled. Merge calendars chronologically.
   Token refresh: POST https://oauth2.googleapis.com/token with client_id/client_secret/
   refresh_token from env paths GOOGLE_CLIENT_SECRET_FILE + GOOGLE_TOKEN_FILE (JSON files;
   client secret has {installed:{client_id,client_secret}}, token has {refresh_token}).
4. Quote: ZenQuotes /api/today, rotated daily at 4am (server-side), NOT per refresh.
   Prefer motivational/grind tone (keyword filter: work, discipline, effort, persist,
   grind, build, courage, action; else fall back). Local JSON fallback list of ~15
   hard-work quotes for API-down. Tiny near-invisible "inspired by ZenQuotes" credit
   (required by their terms), very dim.
5. Notion todos: STUB behind mock layer for now (DB not yet shared with integration).
   Module code structured so real impl drops in: introspect DB schema at startup,
   group by category/area select property (areas like "Career / BFL", "Health / sleep",
   "SF / life"), incomplete only, cap 8 visible + "+N more". Env: NOTION_TOKEN,
   NOTION_DATABASE_ID=881a49492c1344ccba79ec5cd0d6b939. List in SETUP_TODO.md.

## Architecture
- Express server owns all API calls + secrets. `GET /api/state` returns one JSON blob:
  { generatedAt, modules: { weather: {data, fetchedAt, stale}, calendar: {...},
  quote: {...}, notion: {...} }, display: {on: bool} }.
- Serves static frontend from /public.
- SSE at `GET /api/events` pushing state on change; frontend falls back to 60s polling.
- Server refresh cadences: weather 15 min, calendar 5 min, notion 5 min, quote daily 4am.
- Offline resilience FIRST-CLASS: every module caches last-good to disk
  (data/cache.json), serves stale with stale:true. Frontend shows a single tiny dim dot
  (opacity ~0.25) when any module is stale — never text, never "reconnecting", never a
  raw loading state. On boot with no network: clock renders immediately, cached data
  hydrates from localStorage AND server disk cache.
- All fetches: hard timeouts (10s), never crash the server on module failure.

## Display power split (server relays to a thin Pi agent)
- Server exposes POST /api/display/on and /api/display/off, protected by
  header `Authorization: Bearer ${DISPLAY_TOKEN}` from .env.
- Server relays to Pi agent at PI_AGENT_URL (e.g. http://pi.tailnet:8420) with
  PI_AGENT_TOKEN. If unreachable, still flips soft state.
- Soft state also drives the frontend: display off => frontend fades everything to
  pure black (on a mirror, black IS off). SSE pushes this instantly.
- Scheduled fallback: DISPLAY_OFF_TIME (default 00:30) in config; on-trigger is external
  (Eight Sleep / curl) but also support DISPLAY_ON_TIME optional.
- pi-agent/ subdir: single-file Node http server (no deps), POST /display/on|off with
  bearer token; tries `wlr-randr --output HDMI-A-1 --off/--on`, falls back to
  `vcgencmd display_power 0/1`, falls back to DPMS (`xset dpms force off`). Detects
  which works at runtime (try in order, remember first success). Plus systemd unit.

## Config
.env (gitignored) + fully commented .env.example: PORT (8390), LAT, LON, TIMEZONE,
GOOGLE_CLIENT_SECRET_FILE, GOOGLE_TOKEN_FILE, GOOGLE_CALENDAR_IDS, NOTION_TOKEN,
NOTION_DATABASE_ID, ZENQUOTES_MODE=today, DISPLAY_TOKEN, PI_AGENT_URL, PI_AGENT_TOKEN,
DISPLAY_OFF_TIME, MOCK=0.

## Dev/mock mode
`npm run dev` => MOCK=1: all modules serve realistic mock data (a full day of varied
calendar events incl. all-day, weather with a rain afternoon, 7 notion todos across 3
areas, a quote). Plus /preview route wrapping the dashboard in a scaled 1080x1920 frame
for laptop iteration.

## Two mockups (BEFORE full build styling is finalized)
Static, self-contained HTML files with embedded mock data at /mockups/editorial.html and
/mockups/instrument.html, served by the same server. Both 1080x1920 portrait, both obey
mirror physics, both include all five modules laid out top/left/bottom with sparse center:

A. EDITORIAL: high-contrast serif display (Playfair Display or similar via @font-face
   fallback to Georgia; self-host or system fallback — kiosk may be offline, so system
   serif stack is the base). Lowercase small-caps labels, hairline rules (1px, ~18%
   white), broadsheet masthead feel. Clock is the masthead.
B. INSTRUMENT: grotesk/mono system (system-ui + ui-monospace stack), tabular numerals
   (font-variant-numeric: tabular-nums), quiet tick marks, micro-dividers, flight
   instrument feel. Fine hairline scales on the hours strip.

No emoji anywhere. No color except white/gray ramp (allow ONE muted accent per direction:
editorial a warm off-white #f5efe6 tint on the clock; instrument a dim instrument-green
or amber ONLY as a 1px accent, both optional and removable).

## Repo deliverables
- README.md: full setup — Pi kiosk config (Chromium --kiosk --noerrdialogs
  --disable-session-crashed-bubble --disable-features=Translate, autostart via systemd
  user service, portrait rotation on Wayland/labwc Bookworm), pointing kiosk at
  http://<tailnet-host>:8390, Google OAuth steps, Notion integration steps, Eight Sleep
  webhook wiring example (curl to /api/display/on), pi-agent install.
- systemd/: mirror-server.service (this host), mirror-kiosk.service + pi-agent.service (Pi).
- DESIGN.md: layout system + how to add a module.
- SETUP_TODO.md: Notion DB share pending; anything else blocked.
- Clean commits as you go (git already initialized; commit author Hermes <hermes@local>).
- Tests: a small test for WMO code mapping, quote fallback, cache staleness logic
  (node --test, no test framework dep).

## Dependency budget
express, dotenv only. No axios (use fetch), no moment (use Intl), no googleapis SDK
(raw REST), no notion SDK (raw REST). Zero-dep pi-agent.
