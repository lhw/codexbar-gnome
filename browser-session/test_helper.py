import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("helper", Path(__file__).with_name("helper.py"))
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


class HelperTests(unittest.TestCase):
    def test_foreground_commands_are_explicit_and_opted_in(self):
        with patch.object(helper, "run") as run:
            helper.main(["profiles"])
            self.assertEqual(run.call_args.args[0][-3:], ["daemon.py", "--enable", "--list-profiles"])
            helper.main(["profiles", "--json"])
            self.assertEqual(run.call_args.args[0][-4:], ["daemon.py", "--enable", "--list-profiles", "--json"])
            helper.main(["once"])
            self.assertEqual(run.call_args.args[0][-2:], ["--enable", "--once"])
            helper.main(["start"])
            self.assertEqual(run.call_args.args[0][-2:], ["daemon.py", "--enable"])

    def test_setup_and_service_are_not_implicit(self):
        with patch.object(helper, "setup") as setup, patch.object(helper, "run") as run:
            helper.main(["profiles"])
            helper.main(["start"])
            setup.assert_not_called()
            self.assertEqual(run.call_count, 2)

    def test_invalid_command_is_rejected(self):
        with self.assertRaises(SystemExit):
            helper.main(["anything"])
        with self.assertRaises(SystemExit):
            helper.main(["start", "--json"])

    def test_service_install_is_private_atomic_and_does_not_follow_symlinks(self):
        with tempfile.TemporaryDirectory(dir="/tmp/opencode") as temp:
            root = Path(temp)
            unit_dir = root / "units"
            unit_dir.mkdir()
            unrelated = root / "untouched"
            unrelated.write_text("keep this")
            (unit_dir / helper.UNIT).symlink_to(unrelated)
            with patch.object(helper, "UNIT_DIR", unit_dir), patch.object(helper, "setup") as setup, \
                    patch.object(helper.shutil, "which", return_value="/usr/bin/uv"), patch.object(helper, "run") as run:
                helper.main(["enable-service"])
                setup.assert_called_once()
                self.assertEqual([call.args[0] for call in run.call_args_list], [
                    ["systemctl", "--user", "daemon-reload"],
                    ["systemctl", "--user", "enable", helper.UNIT],
                    ["systemctl", "--user", "restart", helper.UNIT]])
            unit = unit_dir / helper.UNIT
            self.assertFalse(unit.is_symlink())
            self.assertEqual(unit.stat().st_mode & 0o777, 0o600)
            self.assertIn("ExecStart=", unit.read_text())
            self.assertEqual(unrelated.read_text(), "keep this")
            self.assertEqual(list(unit_dir.iterdir()), [unit])

    def test_service_write_failure_cleans_up_and_never_starts_service(self):
        with tempfile.TemporaryDirectory(dir="/tmp/opencode") as temp:
            unit_dir = Path(temp)
            with patch.object(helper, "UNIT_DIR", unit_dir), patch.object(helper, "setup"), \
                    patch.object(helper.shutil, "which", return_value="/usr/bin/uv"), patch.object(helper, "run") as run, \
                    patch.object(helper.os, "replace", side_effect=OSError("write failed")):
                with self.assertRaises(OSError):
                    helper.install_service()
                run.assert_not_called()
            self.assertEqual(list(unit_dir.iterdir()), [])

    def test_ctrl_c_exits_without_a_traceback(self):
        with patch.object(helper.subprocess, "run", side_effect=KeyboardInterrupt):
            with self.assertRaises(SystemExit) as stopped:
                helper.run(["uv"])
            self.assertEqual(stopped.exception.code, 130)


if __name__ == "__main__":
    unittest.main()
