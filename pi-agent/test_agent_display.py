"""status() must report off when the two backlight halves disagree."""
import importlib.util, os, sys

os.environ.setdefault("AGENT_TOKEN", "test")
sys.path.insert(0, "/home/maanav")
spec = importlib.util.spec_from_file_location("agent", "/home/maanav/agent.py")
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

a.PWM = "/tmp/fake-pwm"
os.makedirs(a.PWM, exist_ok=True)
a._active_override = lambda: None
a.saved_pct = lambda: 20


def set_pwm(enabled):
    with open(f"{a.PWM}/enable", "w") as f:
        f.write("1" if enabled else "0")


# PWM on, inverter high: the panel is lit.
set_pwm(True)
a.inverter_is_on = lambda: True
assert a.status()["on"] is True

# PWM on, inverter low: black panel. Reporting on=true here is what let the
# controller latch display_on and never re-wake.
a.inverter_is_on = lambda: False
assert a.status()["on"] is False

# pinctrl unreadable: unknown is not on.
a.inverter_is_on = lambda: None
assert a.status()["on"] is False

set_pwm(False)
a.inverter_is_on = lambda: True
assert a.status()["on"] is False

# inverter() reports failure instead of pretending the write landed.
a.subprocess.run = lambda *args, **kwargs: None
a.inverter_is_on = lambda: False
assert a.inverter(True) is False
a.inverter_is_on = lambda: True
assert a.inverter(True) is True
print("ok")
