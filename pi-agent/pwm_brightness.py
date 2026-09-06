"""Keep the existing 1.6us minimum on-pulse when dimming below 4%.

25kHz is retained at >=4%. Below that, a 6.25kHz carrier allows a true 1%
PWM duty without shortening the pulse below the previously working minimum.
Actual panel visibility at this frequency still needs a human visual check.
"""
def pwm_settings(percent):
    percent = min(100, max(1, int(percent)))
    period = 160_000 if percent < 4 else 40_000
    return percent, period, int(period * percent / 100)
