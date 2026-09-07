# Brio live dashboard — 2026-09-06

The Logitech Brio initially failed USB enumeration with descriptor errors (-71), alongside recurring Pi undervoltage events. Replacing the cable made it enumerate as 046d:085e Logitech BRIO Ultra HD Webcam on USB 2 (480 Mbps). Capture through /dev/v4l/by-id/*Logitech_BRIO*video-index0 succeeded.

## Deployment

- Pi: /opt/pi-agent/camera.py, smart-mirror-camera.service, port 8421. The service uses the existing AGENT_TOKEN from /etc/default/pi-agent and runs as maanav-pi with video access.
- Camera captures native MJPEG at 640x480, 10 fps. Frames are copied without re-encoding to reduce CPU/power demand. Only the latest frame is held in memory; frames older than two seconds are rejected. Capture retries after disconnect or a four-second stalled read.
- External camera requests require the Pi agent token. Hermes exposes the live preview through /api/camera/frame.jpg on the existing dashboard, authenticates upstream server-side, and coalesces concurrent viewers. No client-selected upstream URL or browser-visible Pi credential.
- The physical kiosk loads http://127.0.0.1:8421/dashboard?view=mirror. A loopback-only, allowlisted GET proxy fetches dashboard assets, state and SSE from Hermes. Its camera images stay local; remote clients cannot use the local dashboard proxy without passing the handler's separate access rules (non-frame routes are rejected).
- Web dashboard and mirror layout show a large camera panel at the centre-left, below the day timeline. View is horizontally mirrored by default; the web version has a Mirror view toggle. Failed capture hides the last image and shows the error. Hidden web tabs pause requests. Example scenarios do not request real camera images.
- No video files or audio are captured by this implementation.

## Validation

303 Node tests passed, plus Python camera tests covering JPEG chunk boundaries, corrupt-stream bounds, stale-frame rejection and local-vs-remote access rules. Multiple distinct frames were read from the Pi and through the deployed Hermes endpoint. Browser verification showed a decoded live image in the mirror layout. The local Pi image request completed in about 11 ms; remote preview requests took roughly 0.8–1.5 seconds during diagnosis, so remote frame rate is network-limited.

## Limitations

Pi undervoltage is unresolved. It was intermittent before camera capture and was actively asserted during initial 720p re-encoding, with occasional corrupt USB frames. Capture was reduced to native 640x480 MJPEG passthrough. This reduces software load but does not establish that the supply is adequate. Presence remains stuck high and has not been repaired by this work.

## Rollback

Hermes pre-camera files: data/ux-backups/20260906-brio/. Pi kiosk backup: /etc/systemd/system/smart-mirror-kiosk.service.before-local-camera-20260906. Restore the kiosk URL before disabling the camera service, since the kiosk now uses its local dashboard proxy. Revert the camera frontend and server route together. No existing display-agent or presence-controller code was modified.
