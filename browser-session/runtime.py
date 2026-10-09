"""Read the extension's opt-in settings without depending on PyGObject."""
import ast
from pathlib import Path
import subprocess

SCHEMA = "org.gnome.shell.extensions.codexbar"
SCHEMA_DIR = Path(__file__).resolve().parent.parent / "schemas"


def _get(key):
    if not (SCHEMA_DIR / "gschemas.compiled").is_file():
        raise RuntimeError("CodexBar settings schema is not compiled; run helper.py setup")
    try:
        result = subprocess.run(
            ["gsettings", "--schemadir", str(SCHEMA_DIR), "get", SCHEMA, key],
            capture_output=True, text=True, timeout=5, check=True,
        )
        value = result.stdout.strip()
        if value in {"true", "false"}:
            return value == "true"
        return ast.literal_eval(value)
    except (OSError, subprocess.SubprocessError, ValueError, SyntaxError):
        raise RuntimeError("Unable to read CodexBar settings with gsettings") from None


def _text(value, name, limit, optional=False):
    if not isinstance(value, str) or len(value) > limit or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise RuntimeError(f"Invalid CodexBar {name} setting")
    value = value.strip()
    if not value and optional:
        return None
    return value


def load_settings():
    enabled = _get("show-browser-summary")
    if not isinstance(enabled, bool):
        raise RuntimeError("Invalid CodexBar browser consent setting")
    profile = _text(_get("browser-profile"), "browser profile", 500)
    interval = _get("browser-refresh-interval")
    if isinstance(interval, bool) or not isinstance(interval, int) or not 1 <= interval <= 240:
        raise RuntimeError("Invalid CodexBar browser refresh interval")
    email = _text(_get("browser-codex-email"), "Codex email", 320, optional=True)
    solver = _text(_get("browser-flaresolverr-url"), "FlareSolverr URL", 2048, optional=True)
    return {"enabled": enabled, "profile": profile, "interval": interval * 60,
            "codex_email": email, "flaresolverr_url": solver}


def service_text(uv, directory):
    def safe_path(value):
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("service paths must not contain control characters")
        return value.replace("\\", "\\\\").replace(" ", "\\x20").replace("%", "%%")

    def command_arg(value):
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("service paths must not contain control characters")
        escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
        escaped = escaped.replace("$", "$$")
        return '"' + escaped + '"'

    return """[Unit]
Description=CodexBar browser-session usage helper

[Service]
Type=simple
WorkingDirectory={directory}
ExecStart={uv} run --locked --python 3.12 --directory {exec_directory} python helper.py start
Restart=on-failure
RestartSec=30
TimeoutStopSec=15
KillSignal=SIGTERM

[Install]
WantedBy=default.target
""".format(directory=safe_path(directory), exec_directory=command_arg(directory), uv=command_arg(uv))

