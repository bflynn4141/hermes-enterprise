import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import install


class InstallerTests(unittest.TestCase):
    def test_sync_uses_the_upstream_lock_without_an_editable_project_install(self):
        command = install.sync_command(
            "/usr/bin/uv", pathlib.Path("/source"), pathlib.Path("/python"),
        )
        self.assertIn("--locked", command)
        self.assertIn("--no-install-project", command)
        self.assertIn("--no-dev", command)
        self.assertNotIn("pip", command)
        self.assertEqual(command[command.index("--project") + 1], "/source")
        extras = [command[index + 1] for index, item in enumerate(command) if item == "--extra"]
        self.assertEqual(extras, ["sms", "mcp"])

    def test_source_verification_requires_the_exact_revision_clean_tree_and_tracked_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = pathlib.Path(temporary)
            (source / "uv.lock").write_text("version = 1\n")
            with patch.object(install.subprocess, "check_output", side_effect=[install.REVISION + "\n", ""]), \
                    patch.object(install.subprocess, "run") as run:
                self.assertEqual(install.verify_source(source), source / "uv.lock")
            run.assert_called_once_with(
                ["git", "-C", str(source), "ls-files", "--error-unmatch", "uv.lock"],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )

    def test_untracked_lock_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = pathlib.Path(temporary)
            (source / "uv.lock").write_text("version = 1\n")
            with patch.object(install.subprocess, "check_output", side_effect=[install.REVISION + "\n", ""]), \
                    patch.object(install.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "git")):
                with self.assertRaisesRegex(SystemExit, "not tracked"):
                    install.verify_source(source)


if __name__ == "__main__":
    unittest.main()
