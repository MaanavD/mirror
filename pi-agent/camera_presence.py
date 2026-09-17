#!/usr/bin/env python3
"""Low-resolution local person detection. Persist only a boolean in /run."""
import glob
import json
import math
import os
import pathlib
import threading
import time

STATE_FILE = pathlib.Path('/run/mirror-presence/state.json')
MODEL_DIR = pathlib.Path('/opt/pi-agent/models/mobilenet-ssd')
WIDTH, HEIGHT = 320, 240


def read_presence_state(path=STATE_FILE, *, now=None, max_age=5):
    try:
        data = json.loads(pathlib.Path(path).read_text())
        stamp = data.get('updatedAt')
        age = (time.time() if now is None else now) - stamp
        if isinstance(stamp, bool) or not math.isfinite(age) or not -1 <= age <= max_age:
            return None
        return data['present'] if type(data.get('present')) is bool else None
    except (OSError, ValueError, TypeError, KeyError):
        return None


class PresenceFilter:
    """Require two hits to wake; three misses clear the detector's output."""
    def __init__(self):
        self.present = False
        self.hits = self.misses = 0

    def update(self, detected):
        if detected:
            self.hits += 1
            self.misses = 0
            if self.hits >= 2:
                self.present = True
        else:
            self.misses += 1
            self.hits = 0
            if self.misses >= 3:
                self.present = False
        return self.present


def person_detected(rows, threshold=0.65):
    # MobileNet-SSD VOC label 15 is a person. Ignore all other classes.
    return any(len(row) >= 7 and row[1] == 15 and math.isfinite(float(row[2]))
               and row[2] >= threshold for row in rows)


def write_presence(present):
    # /run is volatile; no image, bounding box, identity or confidence is stored.
    body = {'present': present, 'updatedAt': time.time(), 'source': 'camera'}
    temporary = STATE_FILE.with_suffix('.tmp')
    temporary.write_text(json.dumps(body))
    temporary.replace(STATE_FILE)


class LatestFrame:
    def __init__(self, cv2):
        self.cv2 = cv2
        self.lock = threading.Lock()
        self.frame = None
        self.at = 0

    def snapshot(self):
        with self.lock:
            return (self.frame, self.at) if time.monotonic() - self.at < 2 else (None, 0)

    def run(self):
        cv2 = self.cv2
        while True:
            devices = [p for p in sorted(glob.glob('/dev/v4l/by-id/*video-index0')) if 'brio' in p.lower()]
            if not devices:
                time.sleep(2)
                continue
            capture = cv2.VideoCapture(devices[0], cv2.CAP_V4L2)
            try:
                capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))
                capture.set(cv2.CAP_PROP_FRAME_WIDTH, WIDTH)
                capture.set(cv2.CAP_PROP_FRAME_HEIGHT, HEIGHT)
                capture.set(cv2.CAP_PROP_FPS, 5)
                capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                while capture.isOpened():
                    ok, frame = capture.read()
                    if not ok:
                        break
                    # Fail closed if the camera ignores our capture resolution.
                    if frame.shape[:2] != (HEIGHT, WIDTH):
                        raise RuntimeError('Camera rejected low-resolution capture')
                    with self.lock:
                        self.frame = frame
                        self.at = time.monotonic()
            finally:
                capture.release()
                with self.lock:
                    self.frame = None
                    self.at = 0
            time.sleep(2)


def main():
    import cv2
    cv2.setNumThreads(1)
    cv2.ocl.setUseOpenCL(False)
    net = cv2.dnn.readNetFromCaffe(str(MODEL_DIR / 'deploy.prototxt'), str(MODEL_DIR / 'mobilenet_iter_73000.caffemodel'))
    net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
    net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
    frames = LatestFrame(cv2)
    reader = threading.Thread(target=frames.run, daemon=True)
    reader.start()
    filtering = PresenceFilter()
    previous, last_frame = 'starting', 0
    print('Camera presence: 320x240 capture, local inference, boolean output only', flush=True)
    while True:
        if not reader.is_alive():
            raise RuntimeError('Camera capture stopped')
        started = time.monotonic()
        frame, captured = frames.snapshot()
        present = None
        if frame is not None and captured != last_frame:
            blob = cv2.dnn.blobFromImage(frame, 0.007843, (300, 300), (127.5, 127.5, 127.5), swapRB=False, crop=False)
            net.setInput(blob)
            rows = net.forward().reshape(-1, 7)
            present = filtering.update(person_detected(rows))
            last_frame = captured
            del blob, rows
        else:
            filtering = PresenceFilter()
        del frame
        write_presence(present)
        if present is not previous:
            print('Camera presence: ' + ('unavailable' if present is None else 'present' if present else 'clear'), flush=True)
            previous = present
        time.sleep(max(0.1, 1 - (time.monotonic() - started)))


if __name__ == '__main__':
    main()
