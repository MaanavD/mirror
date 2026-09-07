#!/usr/bin/env python3
"""Keep only the latest Brio JPEG in memory; expose it using the Pi agent token."""
import glob
import hmac
import json
import os
import pathlib
import select
import subprocess
import threading
import time
import urllib.request
from urllib.parse import urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_FRAME = 2_000_000
MIRROR_ORIGIN = 'http://100.97.0.104:8390'
LOCAL_ROUTES = {'/dashboard', '/dashboard.html', '/dashboard.js', '/dashboard.css',
                '/day-model.js', '/attention.js', '/live-updates.js', '/dashboard-examples.js',
                '/hermy-sheet-v4.png', '/api/state', '/api/events', '/api/sensors',
                '/api/frontend-version', '/api/lighting'}


class JPEGFrames:
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, chunk):
        self.buffer.extend(chunk)
        frames = []
        while True:
            start = self.buffer.find(b'\xff\xd8')
            if start < 0:
                self.buffer[:] = self.buffer[-1:]
                break
            if start:
                del self.buffer[:start]
            end = self.buffer.find(b'\xff\xd9', 2)
            if end < 0:
                if len(self.buffer) > MAX_FRAME:
                    self.buffer.clear()
                break
            end += 2
            if end <= MAX_FRAME:
                frames.append(bytes(self.buffer[:end]))
            del self.buffer[:end]
        return frames


def find_camera():
    for link in sorted(glob.glob('/dev/v4l/by-id/*video-index0')):
        if 'brio' in link.lower():
            return link
    for entry in sorted(pathlib.Path('/sys/class/video4linux').glob('video*'), key=lambda p: int(p.name[5:])):
        try:
            if 'brio' in (entry / 'name').read_text().lower():
                return '/dev/' + entry.name
        except OSError:
            continue
    return None


class Camera:
    def __init__(self):
        self.lock = threading.Lock()
        self.frame = None
        self.updated = 0
        self.error = 'Camera not connected'

    def snapshot(self):
        with self.lock:
            if self.frame and time.monotonic() - self.updated < 2:
                return self.frame, None
            return None, self.error or 'Camera signal lost'

    def run(self):
        while True:
            device = find_camera()
            if not device:
                with self.lock:
                    self.frame = None
                    self.error = 'Camera not connected'
                time.sleep(3)
                continue
            with self.lock:
                self.error = 'Starting Logitech Brio'
            command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
                       '-fflags', '+discardcorrupt', '-f', 'v4l2',
                       '-input_format', 'mjpeg', '-framerate', '10',
                       '-video_size', '640x480', '-i', device, '-an',
                       '-c:v', 'copy', '-f', 'image2pipe', 'pipe:1']
            process = subprocess.Popen(command, stdout=subprocess.PIPE)
            parser = JPEGFrames()
            try:
                while select.select([process.stdout], [], [], 4)[0]:
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    frames = parser.feed(chunk)
                    if frames:
                        with self.lock:
                            self.frame = frames[-1]
                            self.updated = time.monotonic()
                            self.error = None
            finally:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                process.stdout.close()
                with self.lock:
                    self.frame = None
                    self.error = 'Camera capture unavailable'
            time.sleep(3)


def handler(camera, token):
    class Handler(BaseHTTPRequestHandler):
        def _proxy(self):
            # Only local kiosk GETs to the fixed dashboard; no credentials or
            # request-supplied destinations are forwarded.
            request = urllib.request.Request(MIRROR_ORIGIN + self.path, headers={'Accept-Encoding': 'identity'})
            try:
                response = urllib.request.urlopen(request, timeout=35)
            except (OSError, urllib.error.URLError):
                self.send_error(502, 'Dashboard connection unavailable')
                return
            with response:
                self.send_response(response.status)
                self.send_header('Content-Type', response.headers.get('Content-Type', 'application/octet-stream'))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                try:
                    while chunk := response.read1(65536):
                        self.wfile.write(chunk)
                        self.wfile.flush()
                except (OSError, TimeoutError):
                    pass

        def do_GET(self):
            local = self.client_address[0] in ('127.0.0.1', '::1')
            parsed = urlsplit(self.path)
            if local and not parsed.netloc and parsed.path in LOCAL_ROUTES:
                return self._proxy()
            supplied = self.headers.get('Authorization', '')
            local_frame = local and self.path == '/api/camera/frame.jpg'
            if not local_frame and (not token or not hmac.compare_digest(supplied.encode(), ('Bearer ' + token).encode())):
                code, body, kind = 401, b'{"error":"Unauthorized"}', 'application/json'
            elif self.path not in ('/frame.jpg', '/api/camera/frame.jpg'):
                code, body, kind = 404, b'{"error":"Not found"}', 'application/json'
            else:
                frame, error = camera.snapshot()
                code = 200 if frame else 503
                body = frame or json.dumps({'error': error}).encode()
                kind = 'image/jpeg' if frame else 'application/json'
            self.send_response(code)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_args):
            pass
    return Handler


if __name__ == '__main__':
    camera = Camera()
    threading.Thread(target=camera.run, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', 8421), handler(camera, os.environ['AGENT_TOKEN'])).serve_forever()
