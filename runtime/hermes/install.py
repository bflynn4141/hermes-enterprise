#!/usr/bin/env python3
"""Install the pinned official source and dependencies into ignored local state."""

import argparse
import pathlib
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
REVISION = "5d59366010640c1d6b8f170d8a4ee109db2bbdef"
REPOSITORY = "https://github.com/NousResearch/hermes-agent.git"


def verify_source(source):
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if actual != REVISION:
        raise SystemExit("Official source revision differs from runtime/hermes/install.py; refusing to start.")
    changed = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"], text=True)
    if changed.strip():
        raise SystemExit("Official runtime source has tracked changes; refusing to start.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, default=ROOT / ".state/source")
    parser.add_argument("--python-version", default="3.12")
    args = parser.parse_args()
    source = args.source.resolve()
    if not source.exists():
        source.mkdir(parents=True)
        subprocess.run(["git", "init", str(source)], check=True)
        subprocess.run(["git", "-C", str(source), "remote", "add", "origin", REPOSITORY], check=True)
        subprocess.run(["git", "-C", str(source), "fetch", "--depth", "1", "origin", REVISION], check=True)
        subprocess.run(["git", "-C", str(source), "checkout", "--detach", "FETCH_HEAD"], check=True)
    verify_source(source)
    uv = shutil.which("uv")
    if not uv:
        raise SystemExit("Install uv before running this installer.")
    venv = ROOT / ".state/venv"
    if not (venv / "bin/python").exists():
        subprocess.run([uv, "venv", "--python", args.python_version, str(venv)], check=True)
    subprocess.run([uv, "--quiet", "pip", "install", "--python", str(venv / "bin/python"),
                    "-e", str(source), "aiohttp==3.14.3"], check=True)
    print("Installed official Hermes revision " + REVISION)
    print("Source: " + str(source))
    print("Python: " + str(venv / "bin/python"))


if __name__ == "__main__":
    main()
