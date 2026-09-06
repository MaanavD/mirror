#!/usr/bin/env python3
"""smart-mirror pi-agent: token-protected backlight power + brightness control.
Endpoints: POST /display/on, POST /display/off, POST /display/brightness,
GET /display/status, GET /healthz
Controls PWM backlight (pwmchip0/pwm0) + inverter enable on GPIO17."""
import json, os, subprocess
from pwm_brightness import pwm_settings
from http.server import BaseHTTPRequestHandler, HTTPServer

TOKEN = os.environ["AGENT_TOKEN"]
PWM = "/sys/class/pwm/pwmchip0/pwm0"
PORT = int(os.environ.get("AGENT_PORT", "8420"))
PERIOD = 40000
BRIGHT_FILE = "/opt/pi-agent/brightness"
VOICE_DIR = "/opt/pi-agent/voice"
DEFAULT_PCT = 20

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
    subprocess.run(["pinctrl", "set", "17", "op", "dh"], check=False)
    save_pct(pct)
    return pct

def display(on: bool):
    if on:
        apply_brightness(saved_pct())
    else:
        subprocess.run(["pinctrl", "set", "17", "op", "dl"], check=False)
        w(f"{PWM}/duty_cycle", 0)
        w(f"{PWM}/enable", 0)

def status():
    try:
        with open(f"{PWM}/enable") as f:
            on = f.read().strip() == "1"
        return {"on": on, "brightness": saved_pct()}
    except OSError as e:
        return {"on": None, "error": str(e)}

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
        try:
            if self.path in ("/display/on", "/display/off"):
                display(self.path.endswith("/on"))
                return self._send(200, status())
            if self.path == "/display/brightness":
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
        pass

if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), H).serve_forever()
