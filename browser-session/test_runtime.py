import unittest
from unittest.mock import patch
import subprocess
import sys
from contextlib import redirect_stdout
from io import StringIO

import runtime


class RuntimeTests(unittest.TestCase):
    def test_settings_parse_actual_gsettings_output_and_convert_interval(self):
        outputs = ["true\n", "'chromium:Default'\n", "15\n", '"a\'b@example.com"\n', "''\n"]
        with patch.object(runtime.subprocess, "run", side_effect=[
            subprocess.CompletedProcess([], 0, stdout=value, stderr="") for value in outputs
        ]) as run:
            self.assertEqual(runtime.load_settings(), {
                "enabled": True, "profile": "chromium:Default", "interval": 900,
                "codex_email": "a'b@example.com", "flaresolverr_url": None,
            })
        self.assertEqual([item.args[0][-1] for item in run.call_args_list], [
            "show-browser-summary", "browser-profile", "browser-refresh-interval",
            "browser-codex-email", "browser-flaresolverr-url",
        ])

    def test_false_and_malformed_gsettings_output(self):
        with patch.object(runtime.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="false\n", stderr="")):
            self.assertIs(runtime._get("show-browser-summary"), False)
        with patch.object(runtime.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="not-a-value\n", stderr="")):
            with self.assertRaisesRegex(RuntimeError, "Unable to read"):
                runtime._get("show-browser-summary")

    def test_bad_settings_rejected(self):
        for values in (["yes"], [True, "x\n", 15, "", ""], [True, "x", 0, "", ""]):
            with self.subTest(values=values), patch.object(runtime, "_get", side_effect=values):
                with self.assertRaises(RuntimeError):
                    runtime.load_settings()

    def test_unit_escapes_paths_and_has_no_autostart_installation(self):
        text = runtime.service_text("/home/test/$bin/uv", "/home/test/a b%folder")
        self.assertIn("WorkingDirectory=/home/test/a\\x20b%%folder", text)
        self.assertIn('ExecStart="/home/test/$$bin/uv"', text)
        self.assertIn('--directory "/home/test/a b%%folder" python helper.py start', text)
        self.assertIn("WantedBy=default.target", text)
        with self.assertRaises(ValueError):
            runtime.service_text("/bad\npath/uv", "/safe/path")

    def test_service_text_cli_resolves_uv_without_side_effects(self):
        output = StringIO()
        with patch.object(sys, "argv", ["runtime.py", "--service-text"]), \
                patch.object(runtime.shutil, "which", return_value="/test/bin/uv"), \
                redirect_stdout(output):
            self.assertEqual(runtime.main(), 0)
        self.assertIn('ExecStart="/test/bin/uv"', output.getvalue())


if __name__ == "__main__":
    unittest.main()
