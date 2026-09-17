#!/usr/bin/env python3
"""Run UxPlay and hold the mirror on while a client is mirroring."""
from __future__ import annotations

import glob
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import threading
import urllib.request

AGENT_URL = os.environ.get("PI_AGENT_LOCAL_URL", "http://127.0.0.1:8420").rstrip("/")
AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "")
# Short hold: the renew loop refreshes it every minute, so a missed release
# expires on its own instead of pinning the inverter on for hours.
HOLD_SECONDS = 180
RENEW_SECONDS = 60
RELEASE_GRACE_SECONDS = float(os.environ.get("AIRPLAY_RELEASE_GRACE_SECONDS", "10"))

# UxPlay 1.71 never prints "Removing/Connection closed for socket"; these are the
# strings it actually emits when a client tears the mirroring session down.
DISCONNECT_MARKERS = re.compile(
    r"Destroying connection|client HTTP request POST stop|TEARDOWN request"
)

stop_event = threading.Event()
state_lock = threading.Lock()
mirroring = False
release_timer: threading.Timer | None = None
release_seq = 0
process: subprocess.Popen[str] | None = None


def post_manual(mode: str) -> None:
    payload = {"mode": mode}
    if mode == "on":
        payload["duration_s"] = HOLD_SECONDS
    request = urllib.request.Request(
        f"{AGENT_URL}/display/manual",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {AGENT_TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            response.read(256)
        print(f"airplay display hold: {mode}", flush=True)
    except Exception as exc:
        print(f"airplay display hold failed ({mode}): {exc}", flush=True)


def set_mirroring(active: bool) -> None:
    global mirroring, release_timer, release_seq
    with state_lock:
        # ponytail: UxPlay churns sockets mid-session, so a close is only a real
        # disconnect if nothing re-initializes within RELEASE_GRACE_SECONDS.
        if release_timer is not None:
            release_timer.cancel()
            release_timer = None
        if not active and mirroring:
            release_seq += 1
            seq = release_seq
            release_timer = threading.Timer(RELEASE_GRACE_SECONDS, release_hold, (seq,))
            release_timer.daemon = True
            release_timer.start()
            return
        mirroring = active
    if active:
        post_manual("on")


def release_hold(seq: int | None = None) -> None:
    global mirroring
    with state_lock:
        if not mirroring or (seq is not None and seq != release_seq):
            return
        mirroring = False
    post_manual("auto")
    # The Mac's TEARDOWN only tears down audio (96=1, 110=0), so UxPlay keeps
    # its waylandsink surface up and the last mirrored frame stays on the panel.
    # Killing it drops the surface; systemd Restart=always brings it back ready
    # for the next client. seq is None only on our own shutdown path.
    # ponytail: an audio-only teardown mid-session would also end mirroring here;
    # narrow the marker if that ever happens in practice.
    if seq is not None and process is not None and process.poll() is None:
        print("airplay: teardown, restarting uxplay to drop the frame", flush=True)
        process.terminate()


def renew_hold() -> None:
    while not stop_event.wait(RENEW_SECONDS):
        with state_lock:
            active = mirroring
        if active:
            post_manual("on")


def wayland_environment() -> dict[str, str]:
    env = os.environ.copy()
    for candidate in sorted(glob.glob("/run/user/1000/wayland-*")):
        try:
            if stat.S_ISSOCK(os.stat(candidate).st_mode):
                env["WAYLAND_DISPLAY"] = Path(candidate).name
                return env
        except OSError:
            continue
    raise RuntimeError("no Wayland socket is available")


def forward_signal(signum: int, _frame: object) -> None:
    stop_event.set()
    if process is not None and process.poll() is None:
        process.send_signal(signum)


def main() -> int:
    global process
    command = sys.argv[1:]
    if not command:
        print("usage: uxplay_wrapper.py COMMAND [ARGS...]", file=sys.stderr)
        return 2
    signal.signal(signal.SIGTERM, forward_signal)
    signal.signal(signal.SIGINT, forward_signal)
    post_manual("auto")
    threading.Thread(target=renew_hold, name="airplay-hold-renew", daemon=True).start()
    try:
        process = subprocess.Popen(
            command,
            env=wayland_environment(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.rstrip("\n")
            # UxPlay only announces connect/disconnect under -d, and -d also
            # prints a GStreamer bus message per frame. Read them, log neither.
            if "bus message" not in line:
                print(line, flush=True)
            if "Mirroring initialized successfully" in line:
                set_mirroring(True)
            elif DISCONNECT_MARKERS.search(line):
                set_mirroring(False)
        return process.wait()
    finally:
        stop_event.set()
        release_hold()


if __name__ == "__main__":
    raise SystemExit(main())
