import unittest
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from unittest.mock import patch
import tempfile
from pathlib import Path
import os
os.environ.setdefault('AGENT_TOKEN', 'local-test-only')
import agent
from daylight import daylight_brightness, solar_elevation
from pwm_brightness import pwm_settings

class DaylightTests(unittest.TestCase):
    def local(self, month, day, hour, minute=0):
        return datetime(2026,month,day,hour,minute,tzinfo=ZoneInfo('America/Los_Angeles'))

    def test_night_is_one_in_all_seasons(self):
        for month in (1,3,6,9,12):
            for hour in (0,2,4,22,23):
                self.assertEqual(daylight_brightness(self.local(month,5,hour)),1)

    def test_daylight_ramp_and_sunset(self):
        morning=[daylight_brightness(self.local(9,5,h)) for h in (6,7,8,9,10,11,12)]
        evening=[daylight_brightness(self.local(9,5,h)) for h in (14,15,16,17,18,19,20)]
        self.assertEqual(morning,sorted(morning))
        self.assertEqual(evening,sorted(evening,reverse=True))
        self.assertEqual(daylight_brightness(self.local(9,5,19,41)),1)
        self.assertEqual(daylight_brightness(self.local(9,5,13)),20)
        self.assertLess(daylight_brightness(self.local(12,5,13)),20)

    def test_known_seattle_sunrise_and_timezone_equivalence(self):
        dt=self.local(9,5,6,33)
        self.assertAlmostEqual(solar_elevation(dt,47.6062,-122.3321),-.833,delta=1)
        self.assertEqual(daylight_brightness(dt),daylight_brightness(dt.astimezone(timezone.utc)))
        with self.assertRaises(ValueError): solar_elevation(datetime(2026,9,5),47.6,-122.3)

    def test_pwm_keeps_25khz_carrier_with_a_duty_floor(self):
        for percent in range(1,101):
            pct,period,duty=pwm_settings(percent)
            self.assertEqual(period,40000)
            self.assertGreaterEqual(duty,1600)
            if percent>=4: self.assertAlmostEqual(duty/period*100,percent)
        self.assertEqual(pwm_settings(1),(1,40000,1600))
        self.assertEqual(pwm_settings(4),(4,40000,1600))
        self.assertEqual(pwm_settings(20),(20,40000,8000))

    def test_frequency_transitions_write_zero_before_period(self):
        with tempfile.TemporaryDirectory() as tmp:
            pwm=Path(tmp)
            for name,value in [('period',40000),('duty_cycle',40000),('enable',1)]: (pwm/name).write_text(str(value))
            real_write=agent.w
            def checked_write(path,value):
                if path.endswith('/period'):
                    self.assertEqual((pwm/'enable').read_text(),'0')
                    self.assertLessEqual(int((pwm/'duty_cycle').read_text()),value)
                real_write(path,value)
            with patch.object(agent,'PWM',tmp),patch.object(agent,'BRIGHT_FILE',str(pwm/'saved')),patch.object(agent.subprocess,'run'),patch.object(agent,'w',side_effect=checked_write):
                for pct in (1,2,3,4,100,1):
                    self.assertEqual(agent.apply_brightness(pct),pct)
                    self.assertEqual(agent.status(),{'on':True,'brightness':pct})
                agent.display(False)
                self.assertEqual((pwm/'enable').read_text(),'0')
                agent.display(True)
                self.assertEqual((pwm/'duty_cycle').read_text(),'1600')

if __name__=='__main__': unittest.main()
