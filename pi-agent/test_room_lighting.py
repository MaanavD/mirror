import threading
import unittest
from unittest.mock import patch
from room_lighting import room_light_floor
import backlight_controller as controller

A, B = 'light.shapes_a418', 'light.shapes_dedf'


def entry(a=False, b=True, brightness=127):
    return {'stale': False, 'fetchedAt': 100_000, 'data': {'lights': [
        {'entityId': A, 'on': a, 'brightness': 255},
        {'entityId': B, 'on': b, 'brightness': brightness},
    ]}}


class RoomLightingTests(unittest.TestCase):
    def test_only_selected_room_lights_count(self):
        self.assertEqual(room_light_floor(entry(), [A], now=100), 1)
        self.assertEqual(room_light_floor(entry(), [B], now=100), 4)
        self.assertEqual(room_light_floor(entry(), [A, B], now=100), 4)
        self.assertIsNone(room_light_floor(entry(), [], now=100))

    def test_off_ignores_remembered_brightness_and_full_is_bounded(self):
        self.assertEqual(room_light_floor(entry(b=False), [A, B], now=100), 1)
        self.assertEqual(room_light_floor(entry(a=True), [A, B], now=100), 8)

    def test_stale_unknown_and_incomplete_are_not_treated_as_dark(self):
        for payload in (None, {}, {**entry(), 'stale': True}, {**entry(), 'data': None}):
            self.assertIsNone(room_light_floor(payload, [B], now=100))
        self.assertIsNone(room_light_floor(entry(), [B], now=161))
        self.assertIsNone(room_light_floor(entry(), [B], now=90))
        self.assertIsNone(room_light_floor(entry(), ['light.other'], now=100))
        for value in (None, '127', True, float('nan'), -1, 256):
            self.assertIsNone(room_light_floor(entry(brightness=value), [B], now=100))

    def target(self, daylight, *, quiet=False, data=None, lux=None):
        c = controller.Controller()
        c.lighting_entry = data
        with patch.object(controller, 'NANOLEAF_ENTITIES', (A, B)), \
             patch.object(controller, 'fallback_brightness', return_value=daylight), \
             patch.object(controller, 'in_quiet_hours', return_value=quiet), \
             patch.object(controller, 'QUIET_MAX_PERCENT', 1), \
             patch.object(controller.time, 'time', return_value=100):
            result = c._brightness_target(lux)
        return result, c.brightness_source

    def test_daylight_wins_over_lamps_being_off(self):
        self.assertEqual(self.target(20, data=entry(b=False)), (20, 'daylight+nanoleaf'))

    def test_evening_light_floor_and_dark_room(self):
        self.assertEqual(self.target(1, data=entry()), (4, 'daylight+nanoleaf'))
        self.assertEqual(self.target(1, data=entry(b=False)), (1, 'daylight+nanoleaf'))

    def test_quiet_hours_always_keep_one_percent(self):
        self.assertEqual(self.target(20, quiet=True, data=entry(a=True))[0], 1)

    def test_missing_lighting_falls_back_and_lux_has_priority(self):
        self.assertEqual(self.target(6), (6, 'daylight'))
        with patch.object(controller, 'brightness_for_lux', return_value=2):
            self.assertEqual(self.target(20, data=entry(a=True), lux=1), (2, 'lux'))

    def test_network_fetch_does_not_block_control_loop_or_overlap(self):
        c = controller.Controller()
        started, release = threading.Event(), threading.Event()
        def blocked_request(*args, **kwargs):
            started.set()
            release.wait(2)
            raise OSError('simulated outage')
        with patch.object(controller, 'MIRROR_URL', 'http://mirror.test'), \
             patch.object(controller, 'NANOLEAF_ENTITIES', (B,)), \
             patch.object(controller.urllib.request, 'urlopen', side_effect=blocked_request) as request:
            try:
                c._refresh_lighting(100)
                self.assertTrue(started.wait(.5))
                original = c.lighting_thread
                c._refresh_lighting(120)
                self.assertIs(c.lighting_thread, original)
                self.assertEqual(request.call_count, 1)
            finally:
                release.set()
                c.lighting_thread.join(2)


if __name__ == '__main__':
    unittest.main()
