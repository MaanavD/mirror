"""Offline solar-elevation brightness fallback; no weather or network dependency.

Solar geometry: NOAA General Solar Position Calculations
https://gml.noaa.gov/grad/solcalc/solareqns.PDF
Brightness mapping is a preference curve, not a measurement of indoor lux.
"""
import calendar
import math
from datetime import datetime, timezone


def solar_elevation(now, latitude, longitude):
    if now.tzinfo is None:
        raise ValueError('An aware datetime is required')
    now = now.astimezone(timezone.utc)
    hour = now.hour + now.minute / 60 + now.second / 3600
    year_days = 366 if calendar.isleap(now.year) else 365
    gamma = 2 * math.pi / year_days * (now.timetuple().tm_yday - 1 + (hour - 12) / 24)
    eqtime = 229.18 * (0.000075 + .001868*math.cos(gamma) - .032077*math.sin(gamma)
                       - .014615*math.cos(2*gamma) - .040849*math.sin(2*gamma))
    decl = (.006918 - .399912*math.cos(gamma) + .070257*math.sin(gamma)
            - .006758*math.cos(2*gamma) + .000907*math.sin(2*gamma)
            - .002697*math.cos(3*gamma) + .00148*math.sin(3*gamma))
    angle = math.radians((hour*60 + eqtime + 4*longitude) % 1440 / 4 - 180)
    lat = math.radians(latitude)
    sine = math.sin(lat)*math.sin(decl) + math.cos(lat)*math.cos(decl)*math.cos(angle)
    return math.degrees(math.asin(max(-1, min(1, sine))))


def daylight_brightness(now=None, latitude=47.6062, longitude=-122.3321, daytime_max=20):
    elevation = solar_elevation(now or datetime.now(timezone.utc), latitude, longitude)
    # 1% through sunset/night; a gentle dawn/dusk ramp, reaching the old 20%
    # fallback only when the sun is well above the horizon. Changes are faded
    # again by the controller before any hardware write.
    fraction = max(0, min(1, (elevation + .833) / 35.833))
    smooth = fraction * fraction * (3 - 2*fraction)
    return round(1 + (max(1, min(100, daytime_max)) - 1) * smooth)
