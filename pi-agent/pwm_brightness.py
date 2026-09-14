"""Hold a 25kHz carrier at every level; the dim floor is duty, not frequency.

duty_cycle is nanoseconds, so at a 25kHz carrier (40us period) 1% is a 0.4us
pulse, shorter than the panel's LED driver resolves as a level. Stretching the
carrier to 6.25kHz to keep a 1.6us pulse was worse: the backlight whined at
that frequency and the panel flickered, because the driver sees one short pulse
per 160us instead of a steady average. Keep 25kHz and clamp the low end to a
4% duty floor (1.6us per 40us), which is the panel's minimum usable dim level.
"""
CARRIER_PERIOD_NS = 40_000  # 25kHz, inaudible and smooth for the LED driver
MIN_DUTY_PCT = 4


def pwm_settings(percent):
    percent = min(100, max(1, int(percent)))
    return percent, CARRIER_PERIOD_NS, int(CARRIER_PERIOD_NS * max(percent, MIN_DUTY_PCT) / 100)
