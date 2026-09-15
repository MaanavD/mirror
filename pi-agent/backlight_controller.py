#!/usr/bin/env python3
"""Presence + ambient-light controller for the smart-mirror backlight.

The existing pi-agent remains the only process that writes PWM/GPIO hardware.
This daemon reads LD2410C/BH1750, asks pi-agent for gradual brightness changes,
and keeps the dashboard's soft display state in sync.
"""
from __future__ import annotations

import fcntl
import json
import math
import os
import signal
import sys
import threading
import time
import urllib.request
from datetime import datetime
from daylight import daylight_brightness
from room_lighting import room_light_floor

AGENT_URL = os.environ.get("PI_AGENT_LOCAL_URL", "http://127.0.0.1:8420").rstrip("/")
AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "")
MIRROR_URL = os.environ.get("MIRROR_API_URL", "").rstrip("/")
MIRROR_TOKEN = os.environ.get("MIRROR_DISPLAY_TOKEN", "")

PRESENCE_GPIO = int(os.environ.get("PRESENCE_GPIO", "23"))
I2C_DEVICE = os.environ.get("BH1750_DEVICE", "/dev/i2c-1")
I2C_ADDRESS = int(os.environ.get("BH1750_ADDRESS", "0x23"), 0)

POLL_SECONDS = max(0.25, float(os.environ.get("CONTROLLER_POLL_SECONDS", "0.25")))
MANUAL_OVERRIDE_POLL_SECONDS = 1.0
SENSOR_PUSH_SECONDS = max(1.0, float(os.environ.get("SENSOR_PUSH_SECONDS", "2")))
ABSENCE_OFF_SECONDS = max(0.0, float(os.environ.get("ABSENCE_OFF_SECONDS", "60")))
PRESENCE_REFRESH_SECONDS = max(10.0, float(os.environ.get("PRESENCE_REFRESH_SECONDS", "45")))
WAKE_FADE_SECONDS = max(0.25, float(os.environ.get("WAKE_FADE_SECONDS", "1.2")))
SLEEP_FADE_SECONDS = max(0.25, float(os.environ.get("SLEEP_FADE_SECONDS", "2")))
BRIGHTNESS_FADE_SECONDS = max(0.25, float(os.environ.get("BRIGHTNESS_FADE_SECONDS", "3")))
NANOLEAF_ENTITIES = tuple(filter(None, (item.strip() for item in os.environ.get("NANOLEAF_ENTITIES", "").split(","))))
NANOLEAF_POLL_SECONDS = 15.0
NANOLEAF_MAX_PERCENT = min(20, max(1, int(os.environ.get("NANOLEAF_MAX_PERCENT", "8"))))

MIN_PERCENT = min(100, max(1, int(os.environ.get("BRIGHTNESS_MIN_PERCENT", "1"))))
MAX_PERCENT = min(100, max(MIN_PERCENT, int(os.environ.get("BRIGHTNESS_MAX_PERCENT", "100"))))
QUIET_MAX_PERCENT = min(MAX_PERCENT, max(MIN_PERCENT, int(os.environ.get("QUIET_MAX_PERCENT", "1"))))
QUIET_START = os.environ.get("QUIET_START", "22:30")
QUIET_END = os.environ.get("QUIET_END", "05:00")
FALLBACK_PERCENT = min(MAX_PERCENT, max(MIN_PERCENT, int(os.environ.get("FALLBACK_PERCENT", "20"))))
DAYLIGHT_LAT = float(os.environ.get("DAYLIGHT_LAT", "47.6062"))
DAYLIGHT_LON = float(os.environ.get("DAYLIGHT_LON", "-122.3321"))


def fallback_brightness(now=None):
    return min(MAX_PERCENT, max(MIN_PERCENT, daylight_brightness(now, DAYLIGHT_LAT, DAYLIGHT_LON, FALLBACK_PERCENT)))


PRESENCE_SOURCE = os.environ.get("PRESENCE_SOURCE", "ld2410")[:40] or "ld2410"

# Calibrated for a mirror backlight: low room light stays dim; bright rooms get
# more panel headroom. The points are a calibration knob, not a claimed lux law.
LUX_POINTS = (
    (0.0, MIN_PERCENT),
    (1.0, MIN_PERCENT),
    (5.0, 6),
    (20.0, 10),
    (100.0, 18),
    (300.0, 28),
    (1000.0, 45),
    (5000.0, 70),
    (20000.0, MAX_PERCENT),
)

I2C_SLAVE = 0x0703


def log(message: str) -> None:
    print(f"{datetime.now().astimezone().isoformat(timespec='seconds')} [mirror-controller] {message}", flush=True)


def parse_clock(value: str) -> int:
    try:
        hour, minute = (int(part) for part in value.split(":", 1))
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return hour * 60 + minute
    except (TypeError, ValueError):
        pass
    raise ValueError(f"invalid clock time: {value!r}")


def in_quiet_hours(now: datetime | None = None) -> bool:
    now = now or datetime.now().astimezone()
    current = now.hour * 60 + now.minute
    start = parse_clock(QUIET_START)
    end = parse_clock(QUIET_END)
    if start == end:
        return True
    if start < end:
        return start <= current < end
    return current >= start or current < end


def brightness_for_lux(lux: float) -> int:
    """Interpolate the calibration points on a log-lux scale."""
    if not math.isfinite(lux) or lux < 0:
        return fallback_brightness()
    if lux <= LUX_POINTS[0][0]:
        return MIN_PERCENT
    for (low_lux, low_pct), (high_lux, high_pct) in zip(LUX_POINTS, LUX_POINTS[1:]):
        if lux <= high_lux:
            low_x = math.log10(max(low_lux, 0.1))
            high_x = math.log10(high_lux)
            x = math.log10(max(lux, 0.1))
            ratio = (x - low_x) / (high_x - low_x)
            return round(low_pct + (high_pct - low_pct) * max(0.0, min(1.0, ratio)))
    return MAX_PERCENT


def read_bh1750() -> float:
    """Take one high-resolution BH1750 measurement using only the stdlib."""
    fd = os.open(I2C_DEVICE, os.O_RDWR)
    try:
        fcntl.ioctl(fd, I2C_SLAVE, I2C_ADDRESS)
        os.write(fd, b"\x10")  # continuous high-resolution measurement
        time.sleep(0.18)
        raw = os.read(fd, 2)
    finally:
        os.close(fd)
    if len(raw) != 2:
        raise OSError(f"BH1750 returned {len(raw)} bytes")
    return int.from_bytes(raw, "big") / 1.2


def post_json(url: str, token: str, path: str, payload: dict | None = None) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(f"{url}{path}", data=data, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=5) as response:
        body = response.read(4096)
    parsed = json.loads(body or b"{}")
    if not isinstance(parsed, dict):
        raise ValueError("expected JSON object")
    return parsed


class Controller:
    def __init__(self) -> None:
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.sensor = None
        self.present = None
        self.lux = None
        self.current_percent = 0
        self.target_percent = fallback_brightness()
        self.display_on = False
        self.last_presence_at = None
        self.lighting_entry = None
        self.lighting_thread = None
        self.last_lighting_poll = None
        self.brightness_source = "daylight"
        self.fade_key = None
        self.fade_started_at = 0.0
        self.fade_from = 0
        self.fade_duration = WAKE_FADE_SECONDS
        self.last_presence_push = 0.0
        self.last_sensor_push = 0.0
        self.sensor_push_thread = None
        self.last_light_error_at = 0.0
        self.last_light_report_at = 0.0
        self.last_action_error_at = 0.0
        self.last_error = None
        self.manual_override = None
        self.last_override_poll = None

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "present": self.present,
                "lux": round(self.lux, 2) if self.lux is not None else None,
                "brightness": self.current_percent,
                "target": self.target_percent,
                "brightnessSource": self.brightness_source,
                "on": self.display_on,
                "manualOverride": dict(self.manual_override) if self.manual_override else None,
                "quiet": in_quiet_hours(),
                "lastError": self.last_error,
            }

    def _record_error(self, message: str, *, light: bool = False) -> None:
        now = time.monotonic()
        interval = 30.0 if light else 10.0
        last = self.last_light_error_at if light else self.last_action_error_at
        if now - last >= interval:
            log(message)
            if light:
                self.last_light_error_at = now
            else:
                self.last_action_error_at = now
        with self.lock:
            self.last_error = message[:200]

    def _agent(self, path: str, payload: dict | None = None) -> dict:
        if not AGENT_TOKEN:
            raise RuntimeError("AGENT_TOKEN is not configured")
        return post_json(AGENT_URL, AGENT_TOKEN, path, payload)

    def _agent_status(self) -> dict:
        if not AGENT_TOKEN:
            raise RuntimeError("AGENT_TOKEN is not configured")
        request = urllib.request.Request(
            f"{AGENT_URL}/display/status",
            headers={"Authorization": f"Bearer {AGENT_TOKEN}"},
        )
        with urllib.request.urlopen(request, timeout=3) as response:
            value = json.loads(response.read(4096) or b"{}")
        if not isinstance(value, dict):
            raise ValueError("expected agent status object")
        return value

    def _refresh_manual_override(self, now: float) -> None:
        if not AGENT_TOKEN:
            return
        with self.lock:
            if (self.last_override_poll is not None
                    and now - self.last_override_poll < MANUAL_OVERRIDE_POLL_SECONDS):
                return
            self.last_override_poll = now
        try:
            remote = self._agent_status()
            override = remote.get("override")
            if override is not None and not isinstance(override, dict):
                raise ValueError("invalid manual override status")
            on = remote.get("on")
            brightness = remote.get("brightness")
            with self.lock:
                self.manual_override = dict(override) if override else None
                if isinstance(on, bool):
                    self.display_on = on
                    if on and isinstance(brightness, (int, float)):
                        self.current_percent = int(brightness)
                    elif not on:
                        self.current_percent = 0
        except Exception as exc:
            self._record_error(f"backlight status failed: {exc}")

    def _mirror(self, path: str, payload: dict | None = None) -> dict:
        if not MIRROR_URL or not MIRROR_TOKEN:
            return {}
        return post_json(MIRROR_URL, MIRROR_TOKEN, path, payload)

    def _set_hardware(self, on: bool) -> None:
        if on:
            self._agent("/display/brightness", {"percent": MIN_PERCENT})
            self._agent("/display/on")
            with self.lock:
                self.current_percent = MIN_PERCENT
                self.display_on = True
        else:
            self._agent("/display/off")
            with self.lock:
                self.current_percent = 0
                self.display_on = False

    def _set_brightness(self, percent: int) -> None:
        percent = min(MAX_PERCENT, max(MIN_PERCENT, int(percent)))
        self._agent("/display/brightness", {"percent": percent})
        with self.lock:
            self.current_percent = percent
            self.display_on = True

    def _sync_display(self, on: bool) -> None:
        try:
            self._set_hardware(on)
        except Exception as exc:
            self._record_error(f"backlight action failed: {exc}")
        if MIRROR_URL and MIRROR_TOKEN:
            try:
                result = self._mirror("/api/display/on" if on else "/api/display/off")
                log(f"dashboard display {'on' if on else 'off'}: relay={result.get('relay', 'unknown')}")
            except Exception as exc:
                self._record_error(f"dashboard display sync failed: {exc}")

    def _push_presence(self) -> None:
        if not MIRROR_URL or not MIRROR_TOKEN:
            return
        try:
            self._mirror(
                "/api/presence",
                {"present": True, "source": PRESENCE_SOURCE, "holdMs": 90_000},
            )
            with self.lock:
                self.last_presence_push = time.monotonic()
            log("presence sent to dashboard")
        except Exception as exc:
            self._record_error(f"dashboard presence failed: {exc}")

    def _push_sensor_snapshot(self) -> None:
        if not MIRROR_URL or not MIRROR_TOKEN:
            return
        snapshot = self.snapshot()
        payload = {"present": snapshot["present"], "lux": snapshot["lux"]}

        def push() -> None:
            try:
                self._mirror("/api/sensors", payload)
            except Exception as exc:
                self._record_error(f"dashboard sensor telemetry failed: {exc}")
            finally:
                with self.lock:
                    self.sensor_push_thread = None

        with self.lock:
            if self.sensor_push_thread is not None and self.sensor_push_thread.is_alive():
                return
            self.sensor_push_thread = threading.Thread(target=push, name="sensor-telemetry", daemon=True)
            self.sensor_push_thread.start()

    def _read_presence(self) -> bool | None:
        if PRESENCE_SOURCE == 'camera':
            from camera_presence import read_presence_state
            return read_presence_state()
        if self.sensor is None:
            from gpiozero import DigitalInputDevice
            self.sensor = DigitalInputDevice(PRESENCE_GPIO, pull_up=False)
        return bool(self.sensor.value)

    def _refresh_lighting(self, now: float) -> None:
        """Network refresh never blocks presence sampling or a brightness fade."""
        if not MIRROR_URL or not NANOLEAF_ENTITIES:
            return
        with self.lock:
            if self.lighting_thread is not None and self.lighting_thread.is_alive():
                return
            if self.last_lighting_poll is not None and now - self.last_lighting_poll < NANOLEAF_POLL_SECONDS:
                return
            self.last_lighting_poll = now
            def refresh():
                try:
                    request = urllib.request.Request(f"{MIRROR_URL}/api/lighting", headers={"Cache-Control": "no-cache"})
                    with urllib.request.urlopen(request, timeout=3) as response:
                        entry = json.loads(response.read(16384))
                    with self.lock:
                        self.lighting_entry = entry if isinstance(entry, dict) else None
                except (OSError, ValueError):
                    # Last-good data expires by its source timestamp below.
                    pass
            self.lighting_thread = threading.Thread(target=refresh, name="room-lighting", daemon=True)
            self.lighting_thread.start()

    def _brightness_target(self, lux: float | None) -> int:
        if lux is not None:
            target, source = brightness_for_lux(lux), "lux"
        else:
            target, source = fallback_brightness(), "daylight"
            with self.lock:
                entry = self.lighting_entry
            floor = room_light_floor(entry, NANOLEAF_ENTITIES, lit_max=NANOLEAF_MAX_PERCENT)
            if floor is not None:
                target = max(target, floor)
                source = "daylight+nanoleaf"
        target = min(MAX_PERCENT, max(MIN_PERCENT, target))
        if in_quiet_hours():
            target = min(target, QUIET_MAX_PERCENT)
        with self.lock:
            self.brightness_source = source
        return target

    def _update_display(self, now: float, present: bool, target: int) -> None:
        """Hold through short dropouts; reverse fades from the current level."""
        with self.lock:
            current = self.current_percent
            is_on = self.display_on
            last_presence = self.last_presence_at
        awake = present or (last_presence is not None and now - last_presence < ABSENCE_OFF_SECONDS)
        if not is_on:
            self.fade_key = None
            if not awake:
                return
            self._sync_display(True)
            if not self.display_on:
                return  # Retry a failed wake on the next poll.
            current = self.current_percent
            # Start timing after the network/display wake has completed.
            now = time.monotonic()

        mode = "awake" if awake else "sleep"
        goal = target if awake else MIN_PERCENT
        key = (mode, goal)
        if key != self.fade_key:
            previous_mode = self.fade_key[0] if self.fade_key else None
            self.fade_duration = (SLEEP_FADE_SECONDS if not awake else
                                  BRIGHTNESS_FADE_SECONDS if previous_mode == "awake" else WAKE_FADE_SECONDS)
            self.fade_key = key
            self.fade_started_at = now
            self.fade_from = current
        progress = min(1.0, max(0.0, (now - self.fade_started_at) / self.fade_duration))
        eased = progress * progress * (3.0 - 2.0 * progress)
        next_percent = round(self.fade_from + (goal - self.fade_from) * eased)
        if next_percent != current:
            self._set_brightness(next_percent)
        if not awake and progress >= 1.0:
            self._sync_display(False)
            if not self.display_on:
                self.fade_key = None

    def run(self) -> None:
        log(
            f"starting presence={PRESENCE_SOURCE}, {I2C_DEVICE}@0x{I2C_ADDRESS:02x}, "
            f"quiet {QUIET_START}-{QUIET_END} cap={QUIET_MAX_PERCENT}%"
        )
        # The previous boot initializer turns the inverter on. Make the daemon's
        # state authoritative immediately, then wake again if presence is high.
        self._refresh_manual_override(time.monotonic())
        with self.lock:
            manual_override = self.manual_override
        if manual_override:
            log(f"manual display hold active: {manual_override.get('mode', 'unknown')}")
        else:
            self._sync_display(False)
        while not self.stop.is_set():
            now = time.monotonic()
            try:
                self._refresh_lighting(now)
                present = self._read_presence()
                with self.lock:
                    previous = self.present
                    self.present = present
                if previous is not present:
                    label = 'unavailable' if present is None else 'present' if present else 'clear'
                    log(f"presence source={PRESENCE_SOURCE}: {label}")
                if present:
                    self.last_presence_at = now
                elif present is False and previous is True:
                    log("presence cleared; waiting for absence timeout")

                try:
                    lux = read_bh1750()
                    with self.lock:
                        previous_lux = self.lux
                        self.lux = lux
                        self.last_error = None
                    if previous_lux is None or now - self.last_light_report_at >= 60:
                        log(f"BH1750 0x{I2C_ADDRESS:02x}: {lux:.1f} lux")
                        self.last_light_report_at = now
                except Exception as exc:
                    self._record_error(f"BH1750 read failed ({I2C_DEVICE}@0x{I2C_ADDRESS:02x}): {exc}", light=True)
                    lux = None
                    with self.lock:
                        self.lux = None

                if now - self.last_sensor_push >= SENSOR_PUSH_SECONDS:
                    self.last_sensor_push = now
                    self._push_sensor_snapshot()

                self._refresh_manual_override(time.monotonic())
                with self.lock:
                    manual_override = self.manual_override
                if manual_override is None:
                    target = self._brightness_target(lux)
                    with self.lock:
                        self.target_percent = target
                    self._update_display(time.monotonic(), present is True, target)
                # Keep the dashboard's optional presence cue after hardware wake.
                if present and now - self.last_presence_push >= PRESENCE_REFRESH_SECONDS:
                    self._push_presence()
            except Exception as exc:
                self._record_error(f"controller loop failed: {exc}")
            self.stop.wait(POLL_SECONDS)

    def close(self) -> None:
        self.stop.set()
        if self.sensor is not None:
            try:
                self.sensor.close()
            except Exception:
                pass


def self_test() -> None:
    assert brightness_for_lux(0) == MIN_PERCENT
    assert brightness_for_lux(5) <= brightness_for_lux(100)
    assert brightness_for_lux(100) <= brightness_for_lux(5000)
    assert brightness_for_lux(20_000) == MAX_PERCENT
    assert in_quiet_hours(datetime(2026, 9, 5, 23, 0).astimezone())
    assert in_quiet_hours(datetime(2026, 9, 5, 4, 59).astimezone())
    assert not in_quiet_hours(datetime(2026, 9, 5, 12, 0).astimezone())
    print("backlight_controller self-test ok")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    else:
        controller = Controller()

        def stop(_signum, _frame):
            controller.close()

        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGTERM, stop)
        try:
            controller.run()
        finally:
            controller.close()
