# mirror

Smart mirror dashboard for a 40" 1080×1920 panel behind two-way glass.

A Raspberry Pi runs Chromium in kiosk mode pointed at **this server**, which
runs on a tailnet host — not on the Pi. The Pi renders; the server owns every
API call, every secret and the last-good cache.

```
┌────────────── tailnet host ──────────────┐        ┌──────── raspberry pi ────────┐
│  node server.js  :8390                   │        │  chromium --kiosk            │
│    /api/state  · /api/events (SSE)       │◀───────│    http://<host>:8390        │
│    /api/display/on|off                   │        │                              │
│    data/cache.json (last-good)           │───────▶│  pi-agent :8420              │
│    open-meteo · google cal · zenquotes   │        │    wlr-randr / vcgencmd/xset │
└──────────────────────────────────────────┘        └──────────────────────────────┘
```

Node 22, Express, vanilla frontend. No build step. Dependencies: `express` and
`dotenv` — that's the whole budget. The pi-agent has none.

---

## Quick start (mock data, no secrets)

```bash
npm install
npm run dev            # MOCK=1, watch mode
```

- `http://localhost:8390/` — the dashboard (looks correct only at 1080×1920)
- `http://localhost:8390/preview` — same page inside a scaled 1080×1920 frame
- `http://localhost:8390/mockups/editorial.html` — design direction A
- `http://localhost:8390/mockups/instrument.html` — design direction B
- `http://localhost:8390/healthz` — per-module fetch status

Mock mode serves a full varied day: all-day + timed events across today and
tomorrow, a Seattle afternoon of rain, 7 todos across 3 areas, a quote. No
network calls, no credentials.

```bash
npm test               # node --test, no test framework
```

---

## Install on the tailnet host

```bash
node --version                     # must be >= 22
git clone <this repo> ~/mirror && cd ~/mirror
npm ci --omit=dev
cp .env.example .env               # then edit — see Configuration
mkdir -p secrets                   # OAuth files live here (gitignored)

sudo cp systemd/mirror-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mirror-server
journalctl -u mirror-server -f
```

Adjust `User=`, `WorkingDirectory=` and `ReadWritePaths=` in the unit if you did
not check out to `/home/hermes/mirror`.

Verify:

```bash
curl -fsS localhost:8390/api/state | head -c 400
curl -fsS localhost:8390/healthz
```

---

## Configuration

Everything lives in `.env` (gitignored). `.env.example` is the annotated
reference; the table below is the summary.

| Key | Default | Notes |
| --- | --- | --- |
| `PORT` | `8390` | Kiosk URL is `http://<host>:8390` |
| `LAT` / `LON` | Seattle | Passed straight to Open-Meteo |
| `TIMEZONE` | `America/Los_Angeles` | Drives today/tomorrow, 4am rotation, schedule |
| `GOOGLE_CLIENT_SECRET_FILE` | `secrets/client_secret.json` | `{installed:{client_id,client_secret}}` |
| `GOOGLE_TOKEN_FILE` | `secrets/token.json` | `{refresh_token}` |
| `GOOGLE_CALENDAR_IDS` | — | Comma-separated; merged chronologically |
| `NOTION_TOKEN` | — | Empty ⇒ todos module is a stub |
| `NOTION_DATABASE_ID` | `881a4949…b939` | |
| `ZENQUOTES_MODE` | `today` | `today` or `random` |
| `DISPLAY_TOKEN` | — | Bearer token for `/api/display/*`; empty ⇒ 503 |
| `PI_AGENT_URL` | — | e.g. `http://pi.tailnet:8420`; empty ⇒ soft state only |
| `PI_AGENT_TOKEN` | — | Must match the Pi's |
| `DISPLAY_OFF_TIME` | `00:30` | Scheduled blackout, local `HH:MM` |
| `DISPLAY_ON_TIME` | — | Optional scheduled wake |
| `MOCK` | `0` | `1` ⇒ every module serves mock data |

Refresh cadences are code, not config: weather 15 min, calendar 5 min, notion
5 min, quote once daily at 04:00 local.

---

## Google Calendar

Raw Calendar v3 REST with refresh-token OAuth. No `googleapis` SDK.

1. **Project + API** — in [Google Cloud Console](https://console.cloud.google.com/),
   create (or pick) a project and enable **Google Calendar API**.
2. **OAuth consent screen** — External, publishing status *Testing* is fine. Add
   your own Google account under **Test users**. Scope:
   `https://www.googleapis.com/auth/calendar.readonly`.
3. **Client** — Credentials → Create credentials → **OAuth client ID** →
   *Desktop app*. Download the JSON to `secrets/client_secret.json`. It has the
   `{"installed": {"client_id": ..., "client_secret": ...}}` shape the server
   expects.
4. **Get a refresh token, once.** Open this URL in a browser (substitute your
   client id), approve, and copy the `code=` value out of the address bar of the
   page you land on (it will fail to load — that is fine):

   ```
   https://accounts.google.com/o/oauth2/v2/auth
     ?client_id=YOUR_CLIENT_ID
     &redirect_uri=http://localhost:8391
     &response_type=code
     &scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.readonly
     &access_type=offline
     &prompt=consent
   ```

   Add `http://localhost:8391` as an **Authorised redirect URI** on the client
   first. Then exchange the code:

   ```bash
   curl -s https://oauth2.googleapis.com/token \
     -d client_id=YOUR_CLIENT_ID \
     -d client_secret=YOUR_CLIENT_SECRET \
     -d code=THE_CODE \
     -d grant_type=authorization_code \
     -d redirect_uri=http://localhost:8391
   ```

   Save just the refresh token:

   ```bash
   printf '{ "refresh_token": "1//0g..." }\n' > secrets/token.json
   chmod 600 secrets/token.json
   ```

   `access_type=offline` + `prompt=consent` is what makes Google return a
   `refresh_token`; without `prompt=consent` a re-authorisation of the same
   client returns only an access token.
5. **Calendar ids** — `primary` for the authorising account. For shared or
   family calendars: Google Calendar → calendar settings → *Integrate calendar*
   → **Calendar ID** (`...@group.calendar.google.com`). Comma-separate them in
   `GOOGLE_CALENDAR_IDS`.

The server refreshes the access token itself and keeps it in memory only. If one
calendar id fails, the rest still render; only an all-calendars failure marks
the module stale.

---

## Notion todos

**Currently a stub — the database has not been shared with the integration.**
See [SETUP_TODO.md](SETUP_TODO.md). The full read path (schema introspection,
grouping by area, incomplete-only, 8-visible cap) is already implemented in
`src/modules/notion.js`; it starts working the moment the share and token exist.

1. Create an internal integration at
   [notion.so/my-integrations](https://www.notion.so/my-integrations); copy the
   token into `NOTION_TOKEN`.
2. Open the todo database in Notion → `···` → **Connections** → add the
   integration. *This is the blocked step.*
3. Restart the server. It introspects the DB schema at startup and picks:
   - the `title` property for the todo text,
   - a `select`/`status`/`multi_select` property whose name looks like an area or
     category (e.g. "Career / BFL", "Health / sleep", "SF / life") to group by,
   - a `checkbox` named done/complete, or a `status` property, to filter out
     finished items.

   Nothing is hard-coded to specific column names.

---

## Quote

ZenQuotes `/api/today`, fetched **once per day at 04:00 local** on the server —
not per page refresh, not per client. Quotes are preferred when they read like
work/discipline/effort/persistence/grind/build/courage/action; otherwise the
day's quote is used as-is. If the API is unreachable or rate-limited, a local
list of hard-work quotes (`src/modules/quotes-fallback.json`) is used, chosen
deterministically from the date so a restart cannot re-roll it.

The dashboard carries the ZenQuotes credit required by their terms, at ~9%
white — legible at arm's length, invisible across the room.

---

## Raspberry Pi kiosk

Raspberry Pi OS **Bookworm**, Wayland (labwc). Do this on the Pi.

### 1. Autologin to the desktop session

`sudo raspi-config` → *System Options* → *Boot / Auto Login* → **Desktop
Autologin**. The kiosk and pi-agent are *user* services and need a graphical
session to attach to.

### 2. Portrait rotation

Rotation is the compositor's job, not a Chromium flag. Confirm the output name
and set the transform:

```bash
wlr-randr                                              # lists outputs, e.g. HDMI-A-1
wlr-randr --output HDMI-A-1 --transform 90             # or 270, depending on mount
```

Persist it (labwc runs this on session start):

```bash
mkdir -p ~/.config/labwc
printf 'wlr-randr --output HDMI-A-1 --transform 90 &\n' >> ~/.config/labwc/autostart
chmod +x ~/.config/labwc/autostart
```

On a wayfire-based image instead, set `transform = 90` under the output section
of `~/.config/wayfire.ini`. On a legacy X11 image, use
`xrandr --output HDMI-1 --rotate left`.

After rotating, `wlr-randr` should report the logical size as 1080×1920.

### 3. Kiosk service

```bash
sed -i 's/MIRROR_HOST/your-tailnet-host/' systemd/mirror-kiosk.service
mkdir -p ~/.config/systemd/user
cp systemd/mirror-kiosk.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mirror-kiosk
sudo loginctl enable-linger "$USER"      # survives a headless reboot
journalctl --user -u mirror-kiosk -f
```

The unit runs Chromium with `--kiosk --noerrdialogs
--disable-session-crashed-bubble --disable-features=Translate` plus a few
quality-of-life flags. It deliberately does **not** use `--incognito`: the
dashboard keeps its last state in `localStorage` so a reboot with no network
still shows yesterday's data instead of an empty screen.

### 4. Hide the cursor and screen blanking

The CSS already sets `cursor: none`, so there is nothing to install. Disable the
compositor's own blanking so only the mirror decides when the panel is dark:

```bash
# labwc / wlroots
printf 'export WLR_NO_HARDWARE_CURSORS=1\n' >> ~/.profile
sudo raspi-config nonint do_blanking 1     # 1 = disable blanking
```

### 5. pi-agent (display power)

```bash
sudo mkdir -p /opt/mirror && sudo cp -r pi-agent /opt/mirror/
mkdir -p ~/.config/systemd/user ~/.config/mirror
cp systemd/pi-agent.service ~/.config/systemd/user/
printf 'PI_AGENT_TOKEN=%s\n' "$(openssl rand -hex 32)" > ~/.config/mirror/pi-agent.env
chmod 600 ~/.config/mirror/pi-agent.env
sudo usermod -aG video "$USER"             # for the vcgencmd fallback
systemctl --user daemon-reload
systemctl --user enable --now pi-agent
curl -fsS localhost:8420/health
```

Put the same token in the server's `PI_AGENT_TOKEN`, and the Pi's URL in
`PI_AGENT_URL`.

The agent tries `wlr-randr --output HDMI-A-1 --off/--on`, then
`vcgencmd display_power 0/1`, then `xset dpms force off/on`, and remembers the
first backend that works. `GET /health` reports which one it settled on.

---

## Display control

```bash
# on
curl -fsS -X POST http://HOST:8390/api/display/on \
  -H "Authorization: Bearer $DISPLAY_TOKEN"

# off
curl -fsS -X POST http://HOST:8390/api/display/off \
  -H "Authorization: Bearer $DISPLAY_TOKEN"
```

Response: `{"ok":true,"on":true,"source":"api","relay":"ok"}`. `relay` is `ok`,
`unreachable` (Pi asleep or offline — soft state still flipped), `disabled` (no
`PI_AGENT_URL`) or `mock`.

Soft state is what the mirror actually obeys: display off fades the whole
dashboard to pure black, pushed to every client instantly over SSE. On a two-way
mirror, black **is** off — the panel relay is a power optimisation on top.

`DISPLAY_OFF_TIME` (default 00:30) is a scheduled fallback so the mirror never
stays lit all night. Waking is external.

### Eight Sleep → display on

Eight Sleep has no first-party webhook, so trigger it from whatever already
watches your bed. Any of these work:

```bash
# Home Assistant automation (sleep tracking integration)
# configuration.yaml
rest_command:
  mirror_on:
    url: "http://HOST:8390/api/display/on"
    method: POST
    headers:
      authorization: !secret mirror_display_token

# automation
- alias: mirror on when I get up
  trigger:
    - platform: state
      entity_id: binary_sensor.eight_sleep_bed_presence
      to: "off"
      for: "00:02:00"
  action:
    - service: rest_command.mirror_on
```

```bash
# IFTTT / Shortcuts / anything that can make an HTTP request
curl -fsS -X POST http://HOST:8390/api/display/on \
  -H "Authorization: Bearer REDACTED"
```

```bash
# belt and braces: a cron wake at 06:00 local
0 6 * * * curl -fsS -X POST http://HOST:8390/api/display/on -H "Authorization: Bearer $DISPLAY_TOKEN"
```

---

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | The dashboard (kiosk target) |
| `GET` | `/api/state` | One JSON blob: all modules + display state |
| `GET` | `/api/events` | SSE; pushes the same blob on change |
| `POST` | `/api/display/on` | Bearer `DISPLAY_TOKEN` |
| `POST` | `/api/display/off` | Bearer `DISPLAY_TOKEN` |
| `GET` | `/healthz` | Per-module ok/error/age, SSE client count |
| `GET` | `/preview` | Scaled 1080×1920 frame (dev) |
| `GET` | `/mockups/editorial.html` | Design direction A |
| `GET` | `/mockups/instrument.html` | Design direction B |

`/api/state`:

```json
{
  "generatedAt": "2026-08-23T07:42:11.004Z",
  "modules": {
    "weather":  { "data": { "current": { "temp": 13, "text": "rain", "glyph": "⋮⋮" } }, "fetchedAt": 1787..., "stale": false },
    "calendar": { "data": { "today": [], "tomorrow": [] }, "fetchedAt": 1787..., "stale": false },
    "quote":    { "data": { "text": "…", "author": "…", "source": "zenquotes" }, "fetchedAt": 1787..., "stale": false },
    "notion":   { "data": { "groups": [], "more": 0, "stub": true }, "fetchedAt": 1787..., "stale": false }
  },
  "display": { "on": true }
}
```

---

## Offline behaviour

This is the part that matters on a wall.

- The clock is client-side and never waits for anything.
- Every module writes its last-good payload to `data/cache.json`; the server
  serves that at boot before the first fetch returns.
- The browser also keeps the last state in `localStorage`, so a Pi that reboots
  with the network down paints real content immediately.
- A module whose data has aged past its window is served with `stale: true`. The
  only UI for that is **one dot at 25% opacity** in the corner. No text, no
  "reconnecting", no spinner, ever.
- Every outbound request has a hard 10s timeout. A module failure is logged and
  otherwise invisible; the process does not exit.
- SSE drops are handled by falling back to 60s polling and retrying SSE every
  30s in the background.

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Blank black screen | `curl HOST:8390/api/state`; then `journalctl --user -u mirror-kiosk` |
| Dashboard but no data | `/healthz` — each module reports `ok` and `error` |
| Everything shifted a few px | Intentional: burn-in mitigation nudges the layout every ~10 min |
| Landscape, not portrait | `wlr-randr` transform not applied — see *Portrait rotation* |
| Calendar empty | `GOOGLE_CALENDAR_IDS` set? `/healthz` calendar error? token file readable? |
| `invalid_grant` in logs | Refresh token revoked or the consent screen is still in *Testing* with an expired grant — redo step 4 |
| Todos empty | Expected until the Notion DB is shared — see SETUP_TODO.md |
| `/api/display/*` 503 | `DISPLAY_TOKEN` is empty; the endpoint fails closed |
| `relay: unreachable` | pi-agent down or `PI_AGENT_URL` wrong; soft state still flipped |
| Panel never sleeps | pi-agent `/health` shows which backend it chose; check `video` group |

---

## Repo layout

```
server.js              express app, routes, boot, graceful shutdown
src/
  config.js            .env -> config (with defaults)
  cache.js             disk cache + staleness logic
  store.js             the /api/state blob, subscribers, refresh orchestration
  scheduler.js         interval + wall-clock cadences
  sse.js               GET /api/events
  display.js           bearer auth, soft state, Pi relay, schedule
  http.js              fetch with hard timeouts
  time.js              Intl-only timezone math
  logger.js
  modules/
    index.js           module registry
    weather.js         open-meteo -> what the panel shows
    wmo.js             WMO code -> text + line glyph
    calendar.js        google calendar v3, merge + today/tomorrow
    google-auth.js     refresh-token OAuth
    quote.js           zenquotes + tone filter + local fallback
    quotes-fallback.json
    notion.js          todos (stub until the DB is shared)
public/
  index.html app.js styles.css   the dashboard
  preview.html                   scaled dev frame
  mockups/editorial.html         design direction A
  mockups/instrument.html        design direction B
pi-agent/agent.js      zero-dep display power relay for the Pi
systemd/               mirror-server · mirror-kiosk · pi-agent units
test/                  node --test: wmo, quote fallback, cache staleness
data/                  runtime cache (gitignored)
```

See [DESIGN.md](DESIGN.md) for the layout system and how to add a module, and
[SETUP_TODO.md](SETUP_TODO.md) for what is still blocked.
