# SETUP_TODO

What is blocked, what it blocks, and how to unblock it. Everything here is
configuration or access — no code is waiting to be written.

---

## 1. BLOCKED — Notion database not shared with the integration

**This is the one real blocker.** `NOTION_DATABASE_ID=881a49492c1344ccba79ec5cd0d6b939`
is not accessible to any integration, so the todos module runs as a stub.

Current behaviour: `/api/state` reports
`notion: { data: { configured: false, stub: true, reason: "…" }, … }` and the
dashboard renders nothing in the todo column. No error, no empty-state text — a
module with nothing to say says nothing.

To unblock:

1. Create an internal integration at <https://www.notion.so/my-integrations>.
2. Put its token in `.env` as `NOTION_TOKEN` (starts `ntn_`, older ones
   `secret_`). Capabilities: **Read content** is enough.
3. Open the todo database in Notion → `···` (top right) → **Connections** →
   **Connect to** → the integration.
4. `sudo systemctl restart mirror-server` and check
   `curl -fsS localhost:8390/healthz | jq .modules.notion`.

The code path is already complete in `src/modules/notion.js`: schema
introspection at startup, area/category property detection, incomplete-only
filter, grouping, 8-visible cap with `+N more`. Nothing is hard-coded to specific
column names, so it should work against the real schema without changes.

**Verify once it is connected** (these are assumptions the introspection makes):

- The grouping property is a `select`, `status` or `multi_select` whose name
  contains area / category / bucket / domain / life / pillar. Expected values
  include "Career / BFL", "Health / sleep", "SF / life". If the column is named
  something else entirely, the first select-ish property is used instead —
  confirm it picked the right one via `/healthz`.
- "Done" is a `checkbox` whose name contains done/complete/finish/shipped, or a
  `status` property. If completion is modelled some other way (a formula, a
  relation, a date), `buildFilter()` in `src/modules/notion.js` needs one extra
  branch.

---

## 2. Google Calendar credentials not present

Not blocked on anyone else — just not done yet.

- [ ] Enable the Calendar API, create a *Desktop app* OAuth client, download to
      `secrets/client_secret.json`
- [ ] Do the one-off `access_type=offline&prompt=consent` exchange and save
      `secrets/token.json` as `{ "refresh_token": "1//0g…" }`
- [ ] Set `GOOGLE_CALENDAR_IDS` (comma-separated; `primary` plus any shared
      calendars)
- [ ] `chmod 600 secrets/*.json`

Step-by-step commands are in [README.md](README.md#google-calendar). Until then
the calendar module reports `configured: false` and renders nothing.

Note: while the OAuth consent screen is in *Testing*, Google expires refresh
tokens for external test users after 7 days. Either add yourself as a test user
and accept the weekly re-auth, or publish the app (no verification needed for a
single-user read-only scope).

---

## 3. Secrets to generate

- [ ] `DISPLAY_TOKEN` — `openssl rand -hex 32`. Until set, `/api/display/on|off`
      returns **503** (fails closed).
- [ ] `PI_AGENT_TOKEN` — `openssl rand -hex 32`. Same value in the server's
      `.env` and the Pi's `~/.config/mirror/pi-agent.env`.
- [ ] `PI_AGENT_URL` — the Pi's tailnet hostname, e.g. `http://pi.tailnet:8420`.

---

## 4. Pi-side setup not yet performed

- [ ] Desktop autologin (`raspi-config` → Boot / Auto Login)
- [ ] Portrait transform persisted in `~/.config/labwc/autostart` — confirm the
      output name is really `HDMI-A-1` and whether 90 or 270 matches the mount
- [ ] `mirror-kiosk.service` installed with `MIRROR_HOST` substituted
- [ ] `loginctl enable-linger` so the user services survive a headless reboot
- [ ] pi-agent installed to `/opt/mirror/pi-agent`, user added to `video`
- [ ] Confirm which power backend actually works on this Pi:
      `curl -fsS localhost:8420/health` reports the one it settled on
- [ ] Screen blanking disabled (`raspi-config nonint do_blanking 1`) so only the
      mirror decides when the panel is dark

---

## 5. Eight Sleep wake trigger not wired

Eight Sleep has no first-party webhook. The plan is a Home Assistant automation
on bed presence → `POST /api/display/on`; a plain cron wake is the fallback.
Examples in [README.md](README.md#eight-sleep--display-on).

- [ ] Decide the trigger source (Home Assistant / IFTTT / cron)
- [ ] Confirm `DISPLAY_OFF_TIME=00:30` is the right blackout time, and whether
      `DISPLAY_ON_TIME` should be set as a belt-and-braces wake

---

## 6. Nice-to-have, explicitly deferred

- Self-hosted Playfair Display woff2 in `public/fonts/` — right now the design
  falls back to the system serif on the Pi (Georgia is not installed on
  Raspberry Pi OS, so it lands on DejaVu Serif). Worth doing; not blocking.
- A second `data/cache.json` backup copy. The write is already atomic, so this is
  paranoia rather than a fix.
- Verifying the WMO glyphs against the Pi's actual installed fonts. They are
  restricted to a vetted set (see `src/modules/wmo.js`) and the test enforces it,
  but confirming on the real panel is the only way to be sure there is no tofu.
