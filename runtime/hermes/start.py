#!/usr/bin/env python3
"""Start exactly one isolated, governed official Hermes API profile for one agent."""

import argparse
import fcntl
import json
import os
import pathlib
import re
import secrets
import shlex
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

from install import ROOT, REVISION, verify_source

NATIVE_HEALTH_PATHS = frozenset({"/health", "/health/detailed", "/v1/health", "/v1/capabilities"})


def native_cron_route(path):
    return (
        path == "/api/jobs"
        or path.startswith("/api/jobs/")
        or path == "/api/cron/fire"
        or path.startswith("/api/cron/")
    )


def assert_native_cron_empty(load_jobs=None):
    if load_jobs is None:
        from cron.jobs import load_jobs
    jobs = load_jobs()
    if jobs:
        raise RuntimeError("Enterprise Hermes profiles must not contain native cron jobs.")


def install_native_api_policy():
    """Remove native cron routes and make native health assert an empty cron store."""
    from aiohttp import web
    from gateway.platforms.api_server import APIServerAdapter

    original = APIServerAdapter._http_route_table
    if getattr(original, "_enterprise_policy", False):
        return

    def governed_routes(adapter):
        routes = []
        for method, path, handler in original(adapter):
            if native_cron_route(path):
                continue
            if path in NATIVE_HEALTH_PATHS:
                async def guarded(request, _handler=handler):
                    response = await _handler(request)
                    if response.status >= 400:
                        return response
                    try:
                        assert_native_cron_empty()
                    except Exception:
                        return web.json_response({
                            "error": "Enterprise native cron policy failed.",
                            "code": "native_cron_not_empty",
                        }, status=503)
                    return response
                handler = guarded
            routes.append((method, path, handler))
        return routes

    governed_routes._enterprise_policy = True
    APIServerAdapter._http_route_table = governed_routes


def validate_profile_path(profile, platform=sys.platform, pid=None):
    # Match gateway.shutdown_watchdog.get_loop_tick_socket_path. execve keeps
    # this process's PID when it becomes the foreground official gateway.
    socket_path = profile / "home/state" / f"gateway.loop-tick.{os.getpid() if pid is None else pid}.sock"
    if platform == "darwin" and len(str(socket_path).encode("utf-8")) >= 104:
        raise ValueError("state-root is too long for the native macOS watchdog socket; use a shorter dedicated root")


def private_write(path, text):
    temporary = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(text)
    temporary.chmod(0o600)
    temporary.replace(path)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Enterprise skill manifest redirects are not allowed.")


_SECRET_CONFIG_KEYS = {
    "access_key", "api_key", "credential", "credentials", "password",
    "private_key", "secret", "token",
}


def _validate_skill_config(value, *, depth=0, path="skills.config"):
    """Bound non-secret config before it reaches config.yaml/model context."""
    if depth > 6:
        raise RuntimeError(f"{path} is too deeply nested.")
    if value is None or isinstance(value, (bool, int, float)):
        return
    if isinstance(value, str):
        if len(value) > 4096:
            raise RuntimeError(f"{path} is too long.")
        return
    if isinstance(value, list):
        if len(value) > 50:
            raise RuntimeError(f"{path} has too many values.")
        for index, item in enumerate(value):
            _validate_skill_config(item, depth=depth + 1, path=f"{path}[{index}]")
        return
    if isinstance(value, dict):
        if len(value) > 50:
            raise RuntimeError(f"{path} has too many fields.")
        for key, item in value.items():
            if not isinstance(key, str) or not key or len(key) > 80:
                raise RuntimeError(f"{path} contains an invalid key.")
            if key.lower() in _SECRET_CONFIG_KEYS:
                raise RuntimeError(f"{path}.{key} may not contain credentials.")
            _validate_skill_config(item, depth=depth + 1, path=f"{path}.{key}")
        return
    raise RuntimeError(f"{path} contains an unsupported value.")


def load_enterprise_skills(base_url, token, opener=None):
    """Fetch the agent-scoped, non-secret skill manifest from the Worker."""
    parsed = urllib.parse.urlsplit(base_url)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or (parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"})):
        raise RuntimeError("Enterprise skill manifest needs HTTPS or loopback HTTP.")
    request = urllib.request.Request(
        base_url.rstrip("/") + "/skills", method="GET",
        headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
    )
    transport = opener or urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))
    try:
        response = transport.open(request, timeout=5)
    except (OSError, urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as error:
        raise RuntimeError("Enterprise skill manifest could not be loaded.") from error
    with response:
        raw = response.read(65537)
        if getattr(response, "status", 200) != 200 or len(raw) > 65536:
            raise RuntimeError("Enterprise skill manifest was rejected.")
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as error:
        raise RuntimeError("Enterprise skill manifest returned invalid JSON.") from error
    skills = payload.get("skills") if isinstance(payload, dict) else None
    if not isinstance(skills, list) or len(skills) > 16:
        raise RuntimeError("Enterprise skill manifest has an invalid skill list.")
    auto_load, merged_config = [], {}
    for skill in skills:
        if not isinstance(skill, dict):
            raise RuntimeError("Enterprise skill manifest contains an invalid skill.")
        name, version, config = skill.get("name"), skill.get("version"), skill.get("config")
        if (not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+", name)
                or not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version)
                or not isinstance(config, dict) or skill.get("auto_load") is not True):
            raise RuntimeError("Enterprise skill manifest contains invalid metadata.")
        _validate_skill_config(config)
        for key, value in config.items():
            if key in merged_config and merged_config[key] != value:
                raise RuntimeError("Enterprise skill configuration conflicts across packages.")
            merged_config[key] = value
        if name not in auto_load:
            auto_load.append(name)
    return {"auto_load": auto_load, "config": merged_config}


def reset_managed_skill_home(profile):
    """Dedicated Enterprise profiles contain only plugin-packaged skills."""
    skills = profile / "home" / "skills"
    if skills.is_symlink():
        raise RuntimeError("Enterprise skill directory may not be a symlink.")
    if skills.exists():
        shutil.rmtree(skills)
    skills.mkdir(parents=True, mode=0o700)
    private_write(skills / ".no-bundled-skills", "managed by Hermes Enterprise\n")


def clean_environment(source, profile, token, api_key):
    # Nothing from personal provider config, bots, proxies, plugin paths or credentials survives.
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TZ", "TERM", "TMPDIR") if key in os.environ}
    env.update({
        "HOME": str(profile / "os-home"), "HERMES_HOME": str(profile / "home"),
        "PYTHONPATH": str(source), "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
        "ENTERPRISE_RUNTIME_TOKEN": token, "API_SERVER_KEY": api_key,
        "API_SERVER_ENABLED": "true", "API_SERVER_HOST": "127.0.0.1",
    })
    return env


def child(metadata_path):
    metadata = json.loads(pathlib.Path(metadata_path).read_text())
    source, profile = pathlib.Path(metadata["source"]), pathlib.Path(metadata_path).parent
    sys.path.insert(0, str(source))
    os.chdir(profile / "workspace")
    # Import only after HOME/HERMES_HOME/PYTHONPATH were replaced by execve.
    from hermes_cli.config import DEFAULT_CONFIG, load_config
    from toolsets import TOOLSETS

    # Official Hermes gates skills.auto_load on the presence of a skills tool.
    # A dedicated one-tool set keeps only the read-only viewer; the stock
    # `skills` toolset would also expose discovery and mutation.
    TOOLSETS["enterprise_skill_reader"] = {
        "description": "Read the assigned enterprise skill",
        "tools": ["skill_view"],
        "includes": [],
    }

    base = metadata["enterprise_url"] + "/internal/runtime/w/" + metadata["workspace_id"] + "/agents/" + metadata["agent_id"]
    enterprise_skills = load_enterprise_skills(base, os.environ["ENTERPRISE_RUNTIME_TOKEN"])
    config = {
        "_config_version": DEFAULT_CONFIG.get("_config_version", 12),
        "model": {"provider": "custom", "default": metadata["model"],
                  "base_url": base + "/model/v1", "api_mode": "chat_completions",
                  "api_key": "${ENTERPRISE_RUNTIME_TOKEN}"},
        "agent": {"max_iterations": 12,
                  # `skills` stays out of platform_toolsets, but cannot be in
                  # the subtraction list because it owns skill_view too.
                  "disabled_toolsets": sorted(set(TOOLSETS) - {"enterprise_bridge", "enterprise_skill_reader", "skills"})},
        "platform_toolsets": {"api_server": ["enterprise_bridge", "enterprise_skill_reader"]},
        "mcp_servers": {},
        "tools": {"tool_search": {"enabled": "off"}},
        "plugins": {"enabled": ["enterprise_bridge"], "entries": {"enterprise_bridge": {"settings": {
            "base_url": base, "native_url": "http://127.0.0.1:" + str(metadata["port"]),
            "request_timeout_seconds": 5, "pending_timeout_seconds": 86400,
        }}}},
        "gateway": {"multiplex_profiles": False, "api_server": {"max_concurrent_runs": 1},
                    "platforms": {"api_server": {"enabled": True, "extra": {
                        "host": "127.0.0.1", "port": metadata["port"], "key": "${API_SERVER_KEY}",
                    }}}},
        "approvals": {"unattended_mode": "deny", "cron_mode": "deny"},
        "memory": {"memory_enabled": False, "user_profile_enabled": False, "nudge_interval": 0},
        "skills": {"creation_nudge_interval": 0, "write_approval": True,
                   "auto_load": enterprise_skills["auto_load"], "config": enterprise_skills["config"]},
        "auxiliary": {"background_review": {"enabled": False}, "title_generation": {"enabled": False}},
    }
    private_write(profile / "home/config.yaml", json.dumps(config, indent=2) + "\n")
    os.environ["API_SERVER_PORT"] = str(metadata["port"])
    from hermes_cli.plugins import discover_plugins
    from hermes_cli.tools_config import _get_platform_tools
    from model_tools import get_tool_definitions
    assert_native_cron_empty()
    install_native_api_policy()
    discover_plugins()
    from hermes_cli.plugins import get_plugin_manager
    missing_skills = [name for name in enterprise_skills["auto_load"]
                      if get_plugin_manager().find_plugin_skill(name) is None]
    if missing_skills:
        raise SystemExit("Governed skill preflight failed: " + ", ".join(missing_skills))
    loaded = load_config()
    selected = _get_platform_tools(loaded, "api_server")
    definitions = get_tool_definitions(enabled_toolsets=sorted(selected),
                                       disabled_toolsets=config["agent"]["disabled_toolsets"],
                                       quiet_mode=True, skip_tool_search_assembly=True)
    from tools.registry import registry
    names = {item["function"]["name"] for item in definitions}
    if (selected != {"enterprise_bridge", "enterprise_skill_reader"} or "skill_view" not in names
            or any(registry.get_entry(name).toolset != "enterprise_bridge"
                   for name in names - {"skill_view"})
            or any(name in names for name in {"skills_list", "skill_manage"})):
        raise SystemExit(
            "Governed tool preflight failed: runtime did not expose enterprise tools plus read-only skill_view "
            f"(selected={sorted(selected)}, names={sorted(names)})."
        )
    # Verify the actual native provider resolver; do not print credential-bearing data.
    from hermes_cli.runtime_provider import resolve_runtime_provider
    runtime = resolve_runtime_provider(requested="custom")
    if (runtime.get("base_url", "").rstrip("/") != base + "/model/v1"
            or runtime.get("api_key") != os.environ["ENTERPRISE_RUNTIME_TOKEN"]
            or runtime.get("api_mode") != "chat_completions"):
        raise SystemExit("Enterprise model proxy preflight failed.")
    print(f"Verified official Hermes {REVISION[:12]}: {len(names)} governed tools; isolated agent {metadata['agent_id']}", flush=True)
    if metadata.get("verify_only"):
        return
    from hermes_cli.main import main
    sys.argv = ["hermes", "gateway", "run", "--external-supervisor"]
    main()


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "_child":
        child(sys.argv[2])
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace-id")
    parser.add_argument("--agent-id")
    parser.add_argument("--enterprise-url")
    parser.add_argument("--model", required=True)
    credentials = parser.add_mutually_exclusive_group(required=True)
    credentials.add_argument("--token-file", type=pathlib.Path)
    credentials.add_argument("--env-file", type=pathlib.Path, help="Dedicated enterprise credentials only; never sources shell code")
    parser.add_argument("--source", type=pathlib.Path, default=ROOT / ".state/source")
    parser.add_argument("--python", type=pathlib.Path, default=ROOT / ".state/venv/bin/python")
    parser.add_argument("--port", type=int, default=8642)
    parser.add_argument("--state-root", type=pathlib.Path, default=pathlib.Path.home() / ".he-runtime",
                        help="Separate runtime state; use a short path for macOS Unix sockets")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    supplied = {}
    if args.env_file:
        for line in args.env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, separator, value = line.partition("=")
            if not separator:
                parser.error("env-file must use NAME=value lines")
            parts = shlex.split(value, comments=True)
            if len(parts) != 1:
                parser.error("env-file values must be a single optionally quoted string")
            supplied[key.strip()] = parts[0]
    args.workspace_id = args.workspace_id or supplied.get("ENTERPRISE_WORKSPACE_ID")
    args.agent_id = args.agent_id or supplied.get("ENTERPRISE_AGENT_ID")
    args.enterprise_url = args.enterprise_url or supplied.get("ENTERPRISE_URL")
    if not all((args.workspace_id, args.agent_id, args.enterprise_url)):
        parser.error("workspace-id, agent-id and enterprise-url are required through flags or env-file")
    try:
        agent_id = str(uuid.UUID(args.agent_id))
    except ValueError:
        parser.error("agent-id must be a UUID")
    if not args.workspace_id or urllib.parse.quote(args.workspace_id, safe="") != args.workspace_id:
        parser.error("workspace-id must be a URL-safe identifier")
    source = args.source.resolve()
    # Source and Python may be reused read-only; profile and OS home never are.
    verify_source(source)
    if not args.python.exists():
        parser.error("Runtime Python is missing; run install.py first")
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    token = args.token_file.read_text().strip() if args.token_file else supplied.get("ENTERPRISE_RUNTIME_TOKEN", "")
    if len(token) < 16 or any(ch.isspace() for ch in token):
        parser.error("token-file must contain only a provisioned runtime bearer token")
    state_root = args.state_root.expanduser().resolve()
    personal_home = (pathlib.Path.home() / ".hermes").resolve()
    if state_root == personal_home or personal_home in state_root.parents:
        parser.error("state-root must be outside the personal ~/.hermes installation")
    profile = state_root / agent_id
    try:
        validate_profile_path(profile)
    except ValueError as error:
        parser.error(str(error))
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = open(profile / "launcher.lock", "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("This agent already has a running dedicated runtime.")
    os.set_inheritable(lock.fileno(), True)
    for name in ("home", "os-home", "workspace"):
        (profile / name).mkdir(exist_ok=True, mode=0o700)
    metadata_path = profile / "runtime.json"
    metadata = {"agent_id": agent_id, "workspace_id": args.workspace_id,
                "enterprise_url": args.enterprise_url.rstrip("/"), "model": args.model,
                "port": args.port, "source": str(source), "revision": REVISION,
                "verify_only": args.verify_only}
    if metadata_path.exists():
        previous = json.loads(metadata_path.read_text())
        if any(previous.get(key) != metadata[key] for key in ("agent_id", "workspace_id", "enterprise_url")):
            raise SystemExit("This profile is already bound to a different enterprise agent or workspace.")
    private_write(metadata_path, json.dumps(metadata, indent=2) + "\n")
    api_key_path = profile / "api.key"
    if supplied.get("API_SERVER_KEY"):
        if len(supplied["API_SERVER_KEY"]) < 16 or any(ch.isspace() for ch in supplied["API_SERVER_KEY"]):
            parser.error("API_SERVER_KEY must be a strong single-line secret")
        private_write(api_key_path, supplied["API_SERVER_KEY"] + "\n")
    elif not api_key_path.exists():
        private_write(api_key_path, secrets.token_hex(32) + "\n")
    reset_managed_skill_home(profile)
    shutil.copytree(ROOT / "enterprise_bridge", profile / "home/plugins/enterprise_bridge", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    env = clean_environment(source, profile, token, api_key_path.read_text().strip())
    print("Native API key file: " + str(api_key_path), flush=True)
    print("Native API URL: http://127.0.0.1:" + str(args.port), flush=True)
    os.execve(str(args.python.absolute()), [str(args.python.absolute()), str(ROOT / "start.py"), "_child", str(metadata_path)], env)


if __name__ == "__main__":
    main()
