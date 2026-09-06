# Nanoleaf connectivity diagnosis — 2026-09-06

The web dashboard and Pi dashboard read Nanoleaf states from Home Assistant on Hermes. Hermes routes the home subnet 10.0.0.0/24 through the smart-mirror Pi using Tailscale. The mirror brightness controller also uses this HA-backed feed.

## Observations

- HA briefly reported Bedstagons on while Flower was unavailable, then both became unavailable.
- Hermes reported smart-mirror offline, with the Pi still selected as the primary subnet router. Direct authenticated Nanoleaf API reads from Hermes timed out after six seconds.
- From the Mac on the home LAN, both authenticated Nanoleaf state reads completed in 22 ms: Flower (10.0.0.136) off, Bedstagons (10.0.0.129) on at 50 percent brightness. Existing integration credentials worked; no re-pairing or light changes were needed.
- SSH to the Pi failed over both its Tailscale address and its last known LAN address. Prior diagnosis measured substantial Pi Wi-Fi loss and latency. The current outage cannot be conclusively attributed to the radio without access to the Pi.

## Software fix

Previously, either an unavailable state or a failed request for one lamp discarded both lamps. The module now retains valid on/off readings independently, reports unavailable entity IDs separately, and returns null only when no configured light has a usable reading. Unknown lamps are never reported as off. The existing brightness controller conservatively falls back to daylight when any selected lamp is unknown.

Regression tests reproduced both the unavailable-state and failed-request cases before the fix. All 300 Node tests pass; the seven Nanoleaf tests also pass on Hermes. Live end-to-end recovery remains unverified while the Pi is unreachable.

## Next step

Restore the Pi network connection, then verify both HA states and /api/lighting. The Nanoleaf hardware, IPs and saved credentials passed direct local checks. A reliable always-on LAN gateway would remove the mirror Pi Wi-Fi connection as a dependency for remote HA access, but no routing changes were made during this diagnosis.
