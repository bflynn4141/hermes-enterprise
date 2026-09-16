#!/usr/bin/env python3
"""Install the pinned official source and dependencies into ignored local state."""

import argparse
import hashlib
import json
import os
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
    lock = source / "uv.lock"
    try:
        subprocess.run(
            ["git", "-C", str(source), "ls-files", "--error-unmatch", "uv.lock"],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError as error:
        raise SystemExit("Official runtime uv.lock is not tracked at the pinned revision; refusing to install.") from error
    if not lock.is_file():
        raise SystemExit("Official runtime uv.lock is missing; refusing to install.")
    return lock


def sync_command(uv, source, python):
    # `sms` is the pinned tree's smallest declared extra containing aiohttp,
    # which the API-server platform imports. `uv sync --locked` consumes the
    # upstream lock's artifact hashes, overrides and exclude-newer policy. The
    # pinned project refuses wheel builds, so the launcher imports the verified
    # source tree directly instead of installing an editable package.
    return [
        uv, "--quiet", "sync", "--locked", "--no-dev", "--no-install-project",
        "--extra", "sms", "--project", str(source), "--python", str(python),
    ]


def write_inventory(uv, python, lock, destination):
    packages = subprocess.check_output(
        [uv, "--quiet", "pip", "freeze", "--python", str(python)], text=True,
    ).splitlines()
    payload = {
        "source_revision": REVISION,
        "uv_lock_sha256": hashlib.sha256(lock.read_bytes()).hexdigest(),
        "packages": sorted(line for line in packages if line.strip()),
    }
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(payload, file, indent=2)
        file.write("\n")
    temporary.replace(destination)


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
    lock = verify_source(source)
    uv = shutil.which("uv")
    if not uv:
        raise SystemExit("Install uv before running this installer.")
    venv = ROOT / ".state/venv"
    python = venv / "bin/python"
    sync_env = os.environ.copy()
    sync_env.pop("VIRTUAL_ENV", None)
    sync_env["UV_PROJECT_ENVIRONMENT"] = str(venv)
    subprocess.run(sync_command(uv, source, python if python.exists() else args.python_version),
                   check=True, env=sync_env)
    if not python.exists():
        raise SystemExit("Locked Hermes environment was not created.")
    write_inventory(uv, python, lock, ROOT / ".state/installed-packages.json")
    print("Installed official Hermes revision " + REVISION)
    print("Lock SHA-256: " + hashlib.sha256(lock.read_bytes()).hexdigest())
    print("Source: " + str(source))
    print("Python: " + str(python))
    print("Inventory: " + str(ROOT / ".state/installed-packages.json"))


if __name__ == "__main__":
    main()
