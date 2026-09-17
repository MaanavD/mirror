"""Hold survives UxPlay's mid-session socket churn; a real disconnect releases."""
import importlib.util
import time

spec = importlib.util.spec_from_file_location("w", "/home/maanav/uxplay_wrapper.py")
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

calls = []
w.RELEASE_GRACE_SECONDS = 0.3
w.post_manual = calls.append

w.set_mirroring(True)
assert calls == ["on"], calls

# Socket churn: close then immediate re-init must not drop the hold.
w.set_mirroring(False)
w.set_mirroring(True)
time.sleep(0.5)
assert calls == ["on", "on"], calls
assert w.mirroring is True

# Real disconnect: nothing re-initializes, so the hold releases after the grace.
w.set_mirroring(False)
time.sleep(0.1)
assert w.mirroring is True, "released before the grace elapsed"
time.sleep(0.5)
assert calls[-1] == "auto", calls
assert w.mirroring is False

# A real disconnect kills uxplay so the stuck last frame goes away.
class FakeProc:
    def __init__(self): self.killed = False
    def poll(self): return None
    def terminate(self): self.killed = True

w.mirroring = True
w.release_seq += 1
w.process = FakeProc()
w.release_hold(w.release_seq)
assert w.process.killed, "uxplay not restarted; last frame would stay on screen"

# Our own shutdown path (seq None) must not fight systemd over the process.
w.mirroring = True
w.process = FakeProc()
w.release_hold()
assert not w.process.killed

# The markers must match what UxPlay 1.71 really prints on teardown.
assert w.DISCONNECT_MARKERS.search("Destroying connection")
assert w.DISCONNECT_MARKERS.search("client HTTP request POST stop")
assert not w.DISCONNECT_MARKERS.search("Mirroring initialized successfully")
print("ok")
