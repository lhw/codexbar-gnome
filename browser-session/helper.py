#!/usr/bin/env python3
"""Explicit setup and user-service management for the browser helper."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

DIR = Path(__file__).resolve().parent
ROOT = DIR.parent
UNIT = "codexbar-browser-session.service"
UNIT_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "systemd/user"
UV = ["uv", "run", "--locked", "--python", "3.12", "--directory", str(DIR)]


def run(args):
    try:
        subprocess.run(args, check=True)
    except FileNotFoundError:
        raise RuntimeError(f"Required command not found: {args[0]}") from None
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"Command failed: {Path(args[0]).name} (exit {error.returncode})") from None
    except KeyboardInterrupt:
        raise SystemExit(130) from None


def setup():
    for command in ("uv", "glib-compile-schemas"):
        if not shutil.which(command):
            raise RuntimeError(f"Required command not found: {command}")
    run(["glib-compile-schemas", str(ROOT / "schemas")])
    run(["uv", "sync", "--locked", "--python", "3.12", "--directory", str(DIR)])


def install_service():
    if not shutil.which("systemctl"):
        raise RuntimeError("Required command not found: systemctl")
    setup()
    from runtime import service_text

    text = service_text(str(Path(shutil.which("uv")).resolve()), str(DIR))
    UNIT_DIR.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=f".{UNIT}.", dir=UNIT_DIR)
    try:
        with os.fdopen(fd, "w") as unit_file:
            unit_file.write(text)
            unit_file.flush()
            os.fsync(unit_file.fileno())
        os.replace(temp_path, UNIT_DIR / UNIT)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
    run(["systemctl", "--user", "daemon-reload"])
    run(["systemctl", "--user", "enable", UNIT])
    run(["systemctl", "--user", "restart", UNIT])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("setup", "profiles", "start", "once", "enable-service", "disable-service"))
    parser.add_argument("--json", action="store_true", help="emit profiles as JSON")
    args = parser.parse_args(argv)
    command = args.command
    if args.json and command != "profiles":
        parser.error("--json is only supported with profiles")
    if command == "setup":
        setup()
    elif command == "profiles":
        run(UV + ["python", "daemon.py", "--enable", "--list-profiles"] + (["--json"] if args.json else []))
    elif command in ("start", "once"):
        run(UV + ["python", "daemon.py", "--enable"] + (["--once"] if command == "once" else []))
    elif command == "enable-service":
        install_service()
    else:
        if not shutil.which("systemctl"):
            raise RuntimeError("Required command not found: systemctl")
        run(["systemctl", "--user", "disable", "--now", UNIT])
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, ValueError) as error:
        print(f"helper: {error}", file=sys.stderr)
        raise SystemExit(1)
