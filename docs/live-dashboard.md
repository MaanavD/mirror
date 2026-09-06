# Live mirror deployment

The Pi now runs `/dashboard?view=mirror`, using real data and hardware display state. `/` redirects there too, so older kiosk launch configurations also reach the current UI. `/dashboard-preview` remains the desktop preview wrapper; never use it or `example=` URLs as the physical kiosk target.

## Staying current

`src/frontend-release.js` hashes the dashboard HTML, CSS, JS dependencies, and sprite atlas from disk and embeds that version in the HTML. `/api/frontend-version` reports the current version with no-store caching. The browser checks every 30 seconds and reloads after observing the same changed version twice (normally within one minute of a completed deployment). This detects hot-copied files without a backend restart. Unchanged releases do not reload. Failed checks preserve the displayed page and retry; example scenarios do not auto-reload. SSE supplies live data, with the existing 60-second state poll as fallback.

The deployed Pi uses `systemd/smart-mirror-kiosk.service` (Debian 13, Weston). Its preflight script `/opt/pi-agent/wait_for_dashboard.py` waits for a valid live page before launching Chromium. `Restart=always` restarts Chromium/Weston after process exit. It does not diagnose a browser process that hangs without exiting. The older `mirror-kiosk.service` is an alternative user-session setup, not the deployed service.

## Installation / updates

1. Copy application changes to `/home/hermes/mirror` on Hermes. For backend changes, restart `mirror-server.service`; frontend-only changes are detected from disk.
2. Check `/healthz`, `/api/frontend-version`, and `/dashboard?view=mirror` before touching the kiosk.
3. When changing Pi startup behavior, install `pi-agent/wait_for_dashboard.py` at `/opt/pi-agent/wait_for_dashboard.py`, and `systemd/smart-mirror-kiosk.service` at `/etc/systemd/system/smart-mirror-kiosk.service` on the Pi. Run `systemctl daemon-reload` and restart the kiosk. The existing 45-second startup delay is preserved.
4. Confirm the Pi's service is active and Chromium's launch URL is the canonical live URL. Do not enable example/preview flags there.

September 6 cutover backup: Hermes `data/ux-backups/20260906-live-default/`; Pi `/etc/systemd/system/smart-mirror-kiosk.service.before-live-20260906`.

Validation: Node suite includes real HTTP route/hash tests and client release-change/outage tests. The Python controller tests cover presence fades, daylight and room-light behavior. No hardware light sensor repair is included in this release; brightness continues to use the existing fallback.

## Slow Wi-Fi recovery

The live dashboard uses `/api/state?view=dashboard` and `/api/events?view=dashboard`. These preserve displayed priorities, notices, agents, and computed progress while omitting duplicated task histories and completed task rows needed only by server-side accounting. The original full state contract remains available to other consumers.

SSE respects socket backpressure: while a write is blocked, only the newest pending snapshot is retained. This prevents a slow kiosk from accumulating obsolete snapshots. Named events coalesce to their latest value while blocked. Polling runs every 15 seconds with one request in flight, within the agent feed's 30-second freshness window. The agent strip displays "Reconnecting to Hermes" when the feed is stale rather than silently disappearing.

During the September 6 investigation, the Pi's Wi-Fi showed 40% packet loss to its local router and hundreds of milliseconds of latency; it was already on 5 GHz with power saving off. Reconnecting the same NetworkManager profile improved one short loss test but latency remained high. These software fixes reduce bandwidth and backlog; they do not establish that the radio/network problem is permanently repaired.
