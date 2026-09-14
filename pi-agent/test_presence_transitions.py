"""Replay presence traces through the actual controller loop without GPIO/HTTP."""
import unittest
from unittest.mock import patch
import backlight_controller as module


class PresenceTransitions(unittest.TestCase):
    def replay(self, samples, *, initially_on=False, target=20):
        clock = [100.0]
        controller = module.Controller()
        records = []
        controller.current_percent = target if initially_on else 0
        controller.display_on = initially_on
        controller.present = initially_on
        controller.last_presence_at = clock[0] if initially_on else None
        def sync(on):
            controller.display_on = on
            controller.current_percent = module.MIN_PERCENT if on else 0
            records.append((clock[0], 'on' if on else 'off', controller.current_percent))
        def brightness(value):
            controller.current_percent = value
            records.append((clock[0], 'brightness', value))
        # Skip only the startup force-off; replay still exercises the run loop.
        calls = [0]
        def startup_or_sync(on):
            calls[0] += 1
            if calls[0] > 1:
                sync(on)
        iterator = iter(samples)
        def read():
            return next(iterator)
        class Stop:
            count = 0
            def is_set(self):
                return self.count >= len(samples)
            def wait(self, seconds):
                self.count += 1
                clock[0] += seconds
        controller.stop = Stop()
        controller._read_presence = read
        controller._sync_display = startup_or_sync
        controller._set_brightness = brightness
        with patch.object(module.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(module, 'POLL_SECONDS', .25), \
             patch.object(module, 'ABSENCE_OFF_SECONDS', 2), \
             patch.object(module, 'MIRROR_URL', ''), \
             patch.object(module, 'read_bh1750', return_value=100), \
             patch.object(module, 'brightness_for_lux', return_value=target), \
             patch.object(module, 'in_quiet_hours', return_value=False), \
             patch.object(module, 'log'):
            controller.run()
        return controller, records

    def test_brief_dropout_does_not_restart_brightness(self):
        controller, records = self.replay([True, False, False, True], initially_on=True)
        self.assertEqual(records, [], 'A short dropout must not reset a lit display')
        self.assertEqual(controller.current_percent, 20)

    def test_wake_reaches_target_within_1_5_seconds(self):
        controller, records = self.replay([True] * 7)
        self.assertEqual(controller.current_percent, 20)
        self.assertEqual(sum(action == 'on' for _, action, _ in records), 1)

    def test_sleep_fades_after_grace_before_power_off(self):
        controller, records = self.replay([False] * 21, initially_on=True)
        levels = [v for t, action, v in records if action == 'brightness']
        self.assertTrue(any(1 < v < 20 for v in levels), 'Sleep needs intermediate brightness')
        self.assertEqual(levels, sorted(levels, reverse=True))
        self.assertFalse(controller.display_on)
        self.assertTrue(all(t >= 102 for t, _, _ in records), 'Do not fade during absence grace')
        self.assertGreaterEqual(next(t for t, action, _ in records if action == 'off'), 104)

    def test_return_during_fade_recovers_without_power_cycle(self):
        controller, records = self.replay([False] * 11 + [True] * 8, initially_on=True)
        self.assertTrue(controller.display_on)
        self.assertEqual(controller.current_percent, 20)
        self.assertTrue(all(action == 'brightness' for _, action, _ in records))

    def test_empty_room_does_not_wake(self):
        controller, records = self.replay([False] * 30)
        self.assertFalse(controller.display_on)
        self.assertEqual(records, [])

    def test_unavailable_camera_does_not_hold_display_on_forever(self):
        controller, records = self.replay([None] * 21, initially_on=True)
        self.assertIsNone(controller.present)
        self.assertFalse(controller.display_on)
        self.assertTrue(all(t >= 102 for t, _, _ in records))

    def test_night_wake_stays_at_one_percent(self):
        controller, records = self.replay([True] * 8, target=1)
        self.assertEqual(controller.current_percent, 1)
        self.assertTrue(all(value <= 1 for _, _, value in records))


if __name__ == '__main__':
    unittest.main()
