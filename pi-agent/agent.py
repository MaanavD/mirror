#!/usr/bin/env python3
"""smart-mirror pi-agent: token-protected backlight power + brightness control.
Endpoints: POST /display/on, POST /display/off, POST /display/brightness,
POST /display/manual, GET /display/status, GET /healthz
Controls PWM backlight (pwmchip0/pwm0) + inverter enable on GPIO17."""
import json, os, subprocess, sys, time
from pwm_brightness import pwm_settings
from http.server import BaseHTTPRequestHandler, HTTPServer

TOKEN = os.environ["AGENT_TOKEN"]
PWM = "/sys/class/pwm/pwmchip0/pwm0"
PORT = int(os.environ.get("AGENT_PORT", "8420"))
PERIOD = 40000
BRIGHT_FILE = "/opt/pi-agent/brightness"
VOICE_DIR = "/opt/pi-agent/voice"
DEFAULT_PCT = 20
OVERRIDE_FILE = "/opt/pi-agent/manual_override.json"
MANUAL_DEFAULT_SECONDS = 30 * 60
MANUAL_MAX_SECONDS = 12 * 60 * 60
# A manual "on" at or below this brightness hands the panel back to the presence
# controller instead of leasing it. The floor is a dim request, not a command to
# stay lit, so the room can still sleep the mirror on its own.
SENSOR_MODE_MAX_PERCENT = max(1, int(os.environ.get("SENSOR_MODE_MAX_PERCENT", "1")))
_manual_override = None
_override_loaded = False

def w(path, val):
    with open(path, "w") as f:
        f.write(str(val))

def saved_pct():
    try:
        with open(BRIGHT_FILE) as f:
            return min(100, max(1, int(f.read().strip())))
    except (OSError, ValueError):
        return DEFAULT_PCT

def save_pct(pct):
    try:
        w(BRIGHT_FILE, pct)
    except OSError:
        pass


def _read_override():
    try:
        with open(OVERRIDE_FILE) as f:
            value = json.load(f)
        if not isinstance(value, dict) or value.get("mode") not in ("on", "off"):
            return None
        expires_at = float(value["expires_at"])
        if expires_at <= time.time():
            return None
        result = {"mode": value["mode"], "expires_at": expires_at}
        if "percent" in value:
            result["percent"] = int(value["percent"])
        return result
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def _clear_override():
    global _manual_override, _override_loaded
    _manual_override = None
    _override_loaded = True
    try:
        os.unlink(OVERRIDE_FILE)
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _active_override():
    global _manual_override, _override_loaded
    if not _override_loaded:
        _manual_override = _read_override()
        _override_loaded = True
    if _manual_override and _manual_override["expires_at"] <= time.time():
        _clear_override()
    return _manual_override


def _persist_override(override):
    global _manual_override, _override_loaded
    temporary = f"{OVERRIDE_FILE}.tmp"
    with open(temporary, "w") as f:
        json.dump(override, f)
    os.replace(temporary, OVERRIDE_FILE)
    _manual_override = override
    _override_loaded = True


def _integer(value, label):
    if isinstance(value, bool):
        raise ValueError(f"{label} must be an integer")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be an integer") from None
    if not number.is_integer():
        raise ValueError(f"{label} must be an integer")
    return int(number)


def in_sensor_mode(mode, percent):
    """True when a manual write hands the panel back to the presence loop."""
    return mode == "on" and percent is not None and percent <= SENSOR_MODE_MAX_PERCENT


def manual_control(payload):
    mode = str(payload.get("mode", "")).lower()
    if mode not in ("on", "off", "auto"):
        raise ValueError("mode must be on, off, or auto")
    if mode == "auto":
        if "percent" in payload:
            raise ValueError("percent requires mode on")
        _clear_override()
        return status()

    duration = _integer(payload.get("duration_s", MANUAL_DEFAULT_SECONDS), "duration_s")
    if not 1 <= duration <= MANUAL_MAX_SECONDS:
        raise ValueError(f"duration_s must be an integer from 1 to {MANUAL_MAX_SECONDS}")

    percent = None
    if "percent" in payload:
        if mode != "on":
            raise ValueError("percent requires mode on")
        percent = _integer(payload["percent"], "percent")
        if not 1 <= percent <= 100:
            raise ValueError("percent must be an integer from 1 to 100")

    # Apply first. A failed hardware write must not leave a hold behind.
    if mode == "on":
        apply_brightness(percent) if percent is not None else display(True)
    else:
        display(False)

    if in_sensor_mode(mode, percent):
        # Drop any hold, including one this call replaced: the presence
        # controller reads an empty override and takes the panel back.
        _clear_override()
        return status()

    override = {"mode": mode, "expires_at": time.time() + duration}
    if percent is not None:
        override["percent"] = percent
    _persist_override(override)
    return status()

def inverter(on: bool) -> bool:
    """Drive GPIO17 and confirm it landed; pinctrl failing silently leaves the
    PWM enabled behind a dark panel, which is the black-screen bug."""
    for _ in range(2):
        subprocess.run(["pinctrl", "set", "17", "op", "dh" if on else "dl"],
                       check=False)
        if inverter_is_on() == on:
            return True
    return False


def inverter_is_on():
    """None when pinctrl can't be read; callers treat unknown as not-on."""
    try:
        out = subprocess.run(["pinctrl", "get", "17"], capture_output=True,
                             text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return " hi " in f" {out.split('//')[0].replace('|', ' ')} "


def apply_brightness(pct):
    pct, period, duty = pwm_settings(pct)
    with open(f"{PWM}/period") as f:
        previous_period = int(f.read().strip())
    if previous_period != period:
        # Zero duty before reducing period; Linux rejects duty > new period.
        # Disable while changing frequency to avoid a transient bright pulse.
        w(f"{PWM}/enable", 0)
        w(f"{PWM}/duty_cycle", 0)
        w(f"{PWM}/period", period)
    w(f"{PWM}/duty_cycle", duty)
    w(f"{PWM}/enable", 1)
    inverter(True)
    save_pct(pct)
    return pct

def display(on: bool):
    if on:
        apply_brightness(saved_pct())
    else:
        inverter(False)
        w(f"{PWM}/duty_cycle", 0)
        w(f"{PWM}/enable", 0)

def status():
    try:
        with open(f"{PWM}/enable") as f:
            pwm_on = f.read().strip() == "1"
        # Both halves must agree. Reporting on=true with the inverter dark is
        # what let the controller sit on a black screen forever.
        on = bool(pwm_on and inverter_is_on())
        override = _active_override()
        override_status = None
        if override:
            override_status = {
                "mode": override["mode"],
                "expiresAt": round(override["expires_at"], 3),
            }
            if "percent" in override:
                override_status["percent"] = override["percent"]
        return {"on": on, "brightness": saved_pct(), "override": override_status}
    except OSError as e:
        return {"on": None, "error": str(e), "override": None}

def log_peers():
    """Name the local process talking to us: ss -p shows the client pid for
    loopback sockets, so an unexplained /display/on stops being a mystery."""
    try:
        out = subprocess.run(
            ["ss", "-tnp", "state", "established", "dport", "=", f":{PORT}"],
            capture_output=True, text=True, timeout=3).stdout
        for line in out.splitlines()[1:]:
            print(f"peer: {line.strip()}", flush=True)
    except Exception as e:
        print(f"peer: ss failed: {e}", flush=True)

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self):
        return self.headers.get("Authorization", "") == f"Bearer {TOKEN}"

    def do_GET(self):
        if self.path == "/healthz":
            return self._send(200, {"ok": True})
        if self.path == "/display/status":
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            return self._send(200, status())
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._authed():
            return self._send(401, {"error": "unauthorized"})
        if self.path.startswith("/display/"):
            log_peers()
        try:
            if self.path == "/display/manual":
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(payload, dict):
                    raise ValueError("JSON object required")
                return self._send(200, manual_control(payload))
            if self.path in ("/display/on", "/display/off"):
                if _active_override():
                    return self._send(200, {"ok": True, "ignored": "manual_override", **status()})
                display(self.path.endswith("/on"))
                return self._send(200, status())
            if self.path == "/display/brightness":
                if _active_override():
                    return self._send(200, {"ok": True, "ignored": "manual_override", **status()})
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
                apply_brightness(payload.get("percent", DEFAULT_PCT))
                return self._send(200, status())
            if self.path == "/speak":
                # {"clip": "<name>"} plays /opt/pi-agent/voice/<name>.mp3
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length) or b"{}")
                name = os.path.basename(str(payload.get("clip", "")))
                clip = os.path.join(VOICE_DIR, name + ".mp3")
                if not name or not os.path.isfile(clip):
                    return self._send(404, {"error": "no such clip", "clip": name})
                subprocess.Popen(
                    ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", clip],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return self._send(200, {"ok": True, "clip": name})
            if self.path.startswith("/speak/upload"):
                # ?name=<clip>: raw mp3 body cached to the voice dir.
                from urllib.parse import urlparse, parse_qs
                q = parse_qs(urlparse(self.path).query)
                name = os.path.basename(q.get("name", [""])[0])
                length = int(self.headers.get("Content-Length", "0"))
                if not name or length <= 0 or length > 5_000_000:
                    return self._send(400, {"error": "bad upload"})
                os.makedirs(VOICE_DIR, exist_ok=True)
                with open(os.path.join(VOICE_DIR, name + ".mp3"), "wb") as f:
                    f.write(self.rfile.read(length))
                return self._send(200, {"ok": True, "clip": name})
        except Exception as e:
            return self._send(500, {"error": str(e)})
        self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        # Only writes matter: a POST /display/* is someone changing the panel.
        # GET /display/status polls 30s apart from Home Assistant and would flood the journal.
        if self.command == "POST":
            code = args[1] if len(args) > 1 else "?"
            ua = self.headers.get("User-Agent", "none")
            ctype = self.headers.get("Content-Type", "none")
            print(f"{self.client_address[0]}:{self.client_address[1]} {self.path} -> {code} ua={ua!r} ct={ctype!r}", flush=True)


def self_test():
    assert in_sensor_mode("on", 1), "floor brightness must hand the panel back"
    assert not in_sensor_mode("on", 2), "2% and up keeps its hold"
    assert not in_sensor_mode("on", 100)
    assert not in_sensor_mode("on", None), "a bare on keeps its hold"
    assert not in_sensor_mode("off", 1), "off is never sensor mode"
    assert not in_sensor_mode("auto", None)
    print("pi-agent self-test ok")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
    else:
        HTTPServer(("0.0.0.0", PORT), H).serve_forever()
