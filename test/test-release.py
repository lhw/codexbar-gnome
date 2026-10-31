"""Exercise the workflow's actual shell blocks without changing GitHub releases."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github/workflows/release.yml").read_text()
SHA = "a" * 40


def script(step):
    block = WORKFLOW.split(f"- name: {step}\n", 1)[1].split("        run: |\n", 1)[1]
    lines = []
    for line in block.splitlines():
        if line and not line.startswith("          "):
            break
        lines.append(line)
    return textwrap.dedent("\n".join(lines))


class ReleaseTests(unittest.TestCase):
    def run_step(self, step, **env):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gh = root / "gh"
            gh.write_text(
                "#!/usr/bin/env python3\n"
                "import os, sys\n"
                "a = sys.argv[1:]\n"
                "if a[0] == 'api':\n"
                "    print(os.environ.get('DRAFTS', '') if '--paginate' in a else os.environ['ACTUAL_SHA'])\n"
                "elif a[:2] == ['release', 'view']:\n"
                "    print(os.environ.get('IS_DRAFT', 'true') if 'isDraft' in a else a[2])\n"
                "else:\n"
                "    with open(os.environ['CALLS'], 'a') as f: f.write(' '.join(a) + '\\n')\n"
            )
            gh.chmod(0o700)
            output, calls = root / "output", root / "calls"
            result = subprocess.run(
                ["bash", "-c", script(step)],
                cwd=root,
                capture_output=True,
                text=True,
                env={
                    **os.environ,
                    "PATH": f"{root}:{os.environ['PATH']}",
                    "GITHUB_REPOSITORY": "lhw/codexbar-gnome",
                    "GITHUB_OUTPUT": str(output),
                    "CALLS": str(calls),
                    "HEAD_SHA": SHA,
                    "EXPECTED_SHA": SHA,
                    "ACTUAL_SHA": SHA,
                    "REQUESTED_TAG": "",
                    "TAG": "v1.2.1",
                    **env,
                },
            )
            return (
                result,
                output.read_text() if output.exists() else "",
                calls.read_text() if calls.exists() else "",
            )

    def test_gate(self):
        for env, builds in [
            ({"DRAFTS": "v1.2.1"}, True),
            ({"DRAFTS": ""}, False),
            ({"DRAFTS": "v1.2.1", "HEAD_SHA": "b" * 40}, False),
            ({"REQUESTED_TAG": "v1.2.0"}, True),
        ]:
            with self.subTest(env=env):
                result, output, _ = self.run_step("Select release", **env)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"build={str(builds).lower()}\n", output)
                if builds:
                    self.assertIn(f"sha={SHA}\n", output)

    def test_invalid_tag_cannot_inject_outputs(self):
        result, output, _ = self.run_step(
            "Select release", REQUESTED_TAG="v1.2.1\nsha=evil"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output, "")

    def test_publication(self):
        result, _, calls = self.run_step("Attach ZIP and publish draft")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("release upload v1.2.1", calls)
        self.assertTrue(calls.endswith("release edit v1.2.1 --draft=false\n"))
        result, _, calls = self.run_step(
            "Attach ZIP and publish draft", IS_DRAFT="false"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, "")
        result, _, calls = self.run_step(
            "Attach ZIP and publish draft", ACTUAL_SHA="b" * 40
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, "")

    def test_least_privilege_and_pins(self):
        gate = WORKFLOW.split("\n  gate:\n", 1)[1].split("\n  build:\n", 1)[0]
        self.assertIn("permissions:\n      contents: write", gate)
        self.assertNotIn("actions/checkout@", gate)
        build = WORKFLOW.split("\n  build:\n", 1)[1].split("\n  publish:\n", 1)[0]
        self.assertNotIn("contents: write", build)
        self.assertNotIn("GH_TOKEN", build)
        self.assertIn("persist-credentials: false", build)
        self.assertIn("permissions:\n  contents: read", WORKFLOW)
        publish = WORKFLOW.split("\n  publish:\n", 1)[1]
        self.assertNotIn("actions/checkout@", publish)
        for path in (ROOT / ".github/workflows").glob("*.yml"):
            for action in re.findall(r"uses:\s*(\S+)", path.read_text()):
                self.assertRegex(action, r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")
        config = json.loads((ROOT / "release-please-config.json").read_text())
        self.assertTrue(config["packages"]["."]["draft"])
        self.assertTrue(config["packages"]["."]["force-tag-creation"])


if __name__ == "__main__":
    unittest.main()
