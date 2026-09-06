"""A conservative room-light cue, not an estimate of measured lux."""
import math
import time


def room_light_floor(entry, entity_ids, *, now=None, max_age=60, lit_max=8):
    """Return a 1..lit_max screen floor, or None for unknown/stale room state.

    The brightest selected Nanoleaf group wins: an off group must not dilute
    a lit one. Off lamps' remembered brightness is deliberately ignored.
    """
    if not entity_ids or not isinstance(entry, dict) or entry.get('stale') is not False:
        return None
    stamp = entry.get('fetchedAt')
    if isinstance(stamp, bool) or not isinstance(stamp, (int, float)) or not math.isfinite(stamp):
        return None
    age = (time.time() if now is None else now) - stamp / 1000
    if not -5 <= age <= max_age:
        return None
    data = entry.get('data')
    lights = data.get('lights') if isinstance(data, dict) else None
    if not isinstance(lights, list):
        return None
    by_id = {light.get('entityId'): light for light in lights if isinstance(light, dict)}
    levels = []
    for entity_id in entity_ids:
        light = by_id.get(entity_id)
        if not light or type(light.get('on')) is not bool:
            return None
        if not light['on']:
            levels.append(0)
            continue
        value = light.get('brightness')
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 255:
            return None
        levels.append(value / 255)
    return round(1 + (max(1, min(20, lit_max)) - 1) * max(levels))
