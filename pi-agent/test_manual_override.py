import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("AGENT_TOKEN", "test-agent-token")
import agent


class ManualOverride(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.override_file = Path(self.temp_dir.name) / "manual_override.json"
        self.globals = patch.multiple(
            agent,
            OVERRIDE_FILE=str(self.override_file),
            _manual_override=None,
            _override_loaded=True,
        )
        self.globals.start()
        self.addCleanup(self.globals.stop)
        self.addCleanup(self.temp_dir.cleanup)

    def test_manual_brightness_applies_and_persists_two_hour_hold(self):
        with patch.object(agent, "apply_brightness") as apply, patch.object(
            agent,
            "status",
            return_value={"on": True, "brightness": 42, "override": {"mode": "on"}},
        ):
            agent.manual_control({"mode": "on", "percent": 42, "duration_s": 7200})

        apply.assert_called_once_with(42)
        saved = json.loads(self.override_file.read_text())
        self.assertEqual(saved["mode"], "on")
        self.assertEqual(saved["percent"], 42)
        self.assertGreater(saved["expires_at"], agent.time.time() + 7190)

    def test_manual_off_uses_default_hold_and_auto_clears_it(self):
        with patch.object(agent, "display") as display, patch.object(
            agent,
            "status",
            return_value={"on": False, "brightness": 42, "override": {"mode": "off"}},
        ):
            agent.manual_control({"mode": "off"})
        display.assert_called_once_with(False)
        self.assertTrue(self.override_file.exists())
        self.assertEqual(agent._active_override()["mode"], "off")

        with patch.object(agent, "status", return_value={"on": False, "brightness": 42, "override": None}):
            agent.manual_control({"mode": "auto"})
        self.assertFalse(self.override_file.exists())
        self.assertIsNone(agent._active_override())

    def test_expired_hold_is_not_allowed_to_block_auto_writes(self):
        agent._manual_override = {"mode": "on", "expires_at": 10.0}
        with patch.object(agent.time, "time", return_value=11.0):
            self.assertIsNone(agent._active_override())
        self.assertFalse(self.override_file.exists())


if __name__ == "__main__":
    unittest.main()
