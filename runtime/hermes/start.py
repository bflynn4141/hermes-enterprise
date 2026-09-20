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
from enterprise_bridge.runtime_policy import (
    actual_plugin_attestation,
    actual_skill_attestation,
    actual_skill_prompt_attestation,
    assert_native_cron_empty,
    build_skill_prompt_sections,
    install_native_api_policy,
    load_enterprise_skills,
    native_cron_route,
    private_write,
    write_runtime_attestation as _write_runtime_attestation,
)

MCP_NAME = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
ENV_REF = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")
MCP_SECRET_DENYLIST = frozenset({"ENTERPRISE_RUNTIME_TOKEN", "API_SERVER_KEY"})
AGENTCASH_TOOLS = ("fetch",)
CONTRACT = json.loads((ROOT / "contract.json").read_text())
if CONTRACT.get("source_revision") != REVISION:
    raise RuntimeError("runtime/hermes/contract.json must match the pinned official source revision.")
TERMINAL_ERROR_CODES = {
    "provider_auth": ("auth", False, "provider"),
    "provider_quota": ("quota", False, "provider"),
    "provider_rate_limited": ("rate_limit", True, "provider"),
    "request_rejected": ("rejected", False, "request"),
    "provider_unavailable": ("unavailable", True, "provider"),
    "runtime_interrupted": ("interrupted", True, "runtime"),
    "runtime_unknown": ("unknown", True, "runtime"),
}
TERMINAL_ERROR_MESSAGES = {
    "provider_auth": "The selected model connection needs attention.",
    "provider_quota": "The selected model account has no available quota.",
    "provider_rate_limited": "The selected model is rate limited.",
    "request_rejected": "The selected model rejected this request.",
    "provider_unavailable": "The model provider is temporarily unavailable.",
    "runtime_interrupted": "Hermes restarted before this run settled.",
    "runtime_unknown": "Hermes could not finish this run.",
}
ENTERPRISE_TERMINAL_PREFIX = "enterprise-terminal:"
NATIVE_FAILURE_REASON_CODES = {
    "auth": "provider_auth",
    "auth_permanent": "provider_auth",
    "billing": "provider_quota",
    "rate_limit": "provider_rate_limited",
    "upstream_rate_limit": "provider_rate_limited",
    "overloaded": "provider_unavailable",
    "server_error": "provider_unavailable",
    "timeout": "provider_unavailable",
    "ssl_cert_verification": "provider_unavailable",
    "context_overflow": "request_rejected",
    "payload_too_large": "request_rejected",
    "image_too_large": "request_rejected",
    "image_corrupt": "request_rejected",
    "model_not_found": "request_rejected",
    "provider_policy_blocked": "request_rejected",
    "content_policy_blocked": "request_rejected",
    "format_error": "request_rejected",
    "invalid_encrypted_content": "request_rejected",
    "multimodal_tool_content_unsupported": "request_rejected",
    "reasoning_mandatory": "request_rejected",
    "thinking_signature": "request_rejected",
    "long_context_tier": "request_rejected",
    "oauth_long_context_beta_forbidden": "request_rejected",
    "llama_cpp_grammar_pattern": "request_rejected",
    "unknown": "runtime_unknown",
}


def _matches(value, patterns):
    return any(re.search(pattern, value) for pattern in patterns)


def terminal_error(error=None, status="failed"):
    """Project provider-controlled text into the versioned safe wire contract."""
    signal = str(error or "").lower()[:2000]
    sentinel = re.fullmatch(re.escape(ENTERPRISE_TERMINAL_PREFIX) + r"([a-z_]+)", signal)
    if sentinel and sentinel.group(1) in TERMINAL_ERROR_CODES:
        code = sentinel.group(1)
    elif status == "interrupted" or _matches(signal, (
            r"gateway restarted", r"runtime_run_inactive", r"run (?:was )?interrupted")):
        code = "runtime_interrupted"
    elif _matches(signal, (
            r"provider authentication failed", r"\b(?:http\s*)?401\b", r"\bunauthori[sz]ed\b",
            r"\binvalid (?:api )?key\b", r"\bapi key (?:is )?(?:invalid|expired|missing)\b",
            r"\boauth\b.*\bexpired\b", r"\b(?:access |auth )?token\b.*\bexpired\b",
            r"\bcredentials?\b.*\b(?:invalid|expired|missing)\b")):
        code = "provider_auth"
    elif _matches(signal, (
            r"\b(?:http\s*)?402\b", r"\binsufficient (?:credits?|balance|funds)\b",
            r"\b(?:credits?|balance) exhausted\b", r"\bquota (?:exceeded|exhausted)\b",
            r"\bbilling (?:limit|disabled|required)\b")):
        code = "provider_quota"
    elif _matches(signal, (r"\b(?:http\s*)?429\b", r"\brate[ -]?limit(?:ed|ing)?\b", r"\btoo many requests\b")):
        code = "provider_rate_limited"
    elif _matches(signal, (
            r"\b(?:http\s*)?(?:400|404|405|413|415|422)\b", r"\bbad request\b",
            r"\binvalid request\b", r"\bcontext (?:length|window)\b", r"\bmaximum context\b",
            r"\bmodel (?:not found|is not supported|unsupported)\b", r"\bunsupported model\b")):
        code = "request_rejected"
    elif _matches(signal, (
            r"\b(?:http\s*)?(?:500|502|503|504)\b", r"\binternal server error\b",
            r"\btemporar(?:y|ily) unavailable\b", r"\bservice unavailable\b", r"\boverloaded\b",
            r"\btime(?:d)? out\b", r"\btimeout\b", r"\bconnection (?:reset|closed|failed|error)\b",
            r"\bnetwork (?:error|failure)\b")):
        code = "provider_unavailable"
    else:
        code = "runtime_unknown"
    category, retryable, source = TERMINAL_ERROR_CODES[code]
    return {
        "schema_version": CONTRACT["terminal_error_schema_version"],
        "code": code,
        "category": category,
        "retryable": retryable,
        "source": source,
    }


def governed_terminal_fields(status, fields):
    """Replace native error prose before status persistence or SSE emission."""
    if status not in {"failed", "interrupted"}:
        return dict(fields)
    existing = fields.get("terminal_error")
    existing_code = existing.get("code") if isinstance(existing, dict) else None
    if existing_code in TERMINAL_ERROR_CODES:
        category, retryable, source = TERMINAL_ERROR_CODES[existing_code]
        projected = {
            "schema_version": CONTRACT["terminal_error_schema_version"],
            "code": existing_code,
            "category": category,
            "retryable": retryable,
            "source": source,
        }
    else:
        projected = terminal_error(fields.get("error"), status)
    return {
        **fields,
        "error": TERMINAL_ERROR_MESSAGES[projected["code"]],
        "terminal_error": projected,
    }


def runtime_contract():
    ring = os.environ.get("HERMES_ENTERPRISE_RELEASE_RING", "stable").strip().lower()
    if ring not in CONTRACT["supported_release_rings"]:
        raise RuntimeError("HERMES_ENTERPRISE_RELEASE_RING must be canary or stable.")
    return {
        "schema_version": CONTRACT["contract_version"],
        "source_revision": CONTRACT["source_revision"],
        "release_ring": ring,
        "terminal_errors": {
            "supported": True,
            "schema_version": CONTRACT["terminal_error_schema_version"],
        },
    }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Enterprise skill manifest redirects are not allowed.")


def load_enterprise_cache_config(base_url, model, token, opener=None):
    """Declare cache support for exact Claude models served by the governed proxy.

    The Worker hostname hides the upstream Nous/OpenRouter identity from Hermes'
    automatic cache policy. Its allowed-model manifest also covers per-run model
    overrides when the profile's default is not Claude. Discovery is optional and
    happens only at startup; an outage must not prevent a healthy profile running.
    """
    parsed = urllib.parse.urlsplit(base_url)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or (parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"})):
        raise RuntimeError("Enterprise model manifest needs HTTPS or loopback HTTP.")
    proxy_url = base_url.rstrip("/") + "/model/v1"
    request = urllib.request.Request(proxy_url + "/models", method="GET", headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
        "User-Agent": "Hermes-Enterprise-Bridge/1.0",
    })
    transport = opener or urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))
    try:
        with transport.open(request, timeout=5) as response:
            raw = response.read(262145)
            if getattr(response, "status", 200) != 200 or len(raw) > 262144:
                raise ValueError("Model manifest rejected")
        payload = json.loads(raw)
        rows = payload.get("data") if isinstance(payload, dict) else None
        if (not isinstance(rows, list) or len(rows) > 1024
                or any(not isinstance(row, dict) or not isinstance(row.get("id"), str) for row in rows)):
            raise ValueError("Invalid model manifest")
        models = {row["id"] for row in rows}
    except (OSError, ValueError, RuntimeError, urllib.error.URLError):
        # No upstream response text or credentials in diagnostics. Only the
        # configured default can be safely inferred when discovery is unavailable.
        print("Enterprise prompt cache manifest unavailable; using configured model only.", file=sys.stderr)
        models = {model}
    cache_models = {
        model_id: {"prompt_caching": True}
        for model_id in sorted(models)
        if re.fullmatch(r"(?:anthropic/)?claude-[a-z0-9][a-z0-9._-]{0,111}", model_id)
    }
    return {
        "providers": {"enterprise": {
            "api": proxy_url, "key_env": "ENTERPRISE_RUNTIME_TOKEN",
            "transport": "chat_completions", "discover_models": False,
            "models": cache_models,
        }},
        # Keep Hermes' default five-minute tier; the one-hour tier has a higher
        # cache-write price and needs measured reuse before opting into it.
        "prompt_caching": {"cache_ttl": "5m"},
    }
def validate_profile_path(profile, platform=sys.platform, pid=None):
    # Match gateway.shutdown_watchdog.get_loop_tick_socket_path. execve keeps
    # this process's PID when it becomes the foreground official gateway.
    socket_path = profile / "home/state" / f"gateway.loop-tick.{os.getpid() if pid is None else pid}.sock"
    if platform == "darwin" and len(str(socket_path).encode("utf-8")) >= 104:
        raise ValueError("state-root is too long for the native macOS watchdog socket; use a shorter dedicated root")


def write_runtime_attestation(profile, metadata, plugin, skills, tool_names):
    """Backwards-compatible launcher wrapper around the shared policy writer."""
    return _write_runtime_attestation(
        profile / "home",
        {**metadata, "agentcash_enabled": "agentcash" in (metadata.get("mcp_servers") or {})},
        plugin,
        skills,
        tool_names,
    )


def reset_managed_skill_home(profile):
    """Dedicated Enterprise profiles contain only plugin-packaged skills."""
    skills = profile / "home" / "skills"
    if skills.is_symlink():
        raise RuntimeError("Enterprise skill directory may not be a symlink.")
    if skills.exists():
        shutil.rmtree(skills)
    skills.mkdir(parents=True, mode=0o700)
    private_write(skills / ".no-bundled-skills", "managed by Hermes Enterprise\n")


def load_mcp_servers(raw, supplied, agentcash_enabled=False):
    """Validate explicit stdio MCP definitions without persisting secret values."""
    try:
        document = json.loads(raw) if raw else {}
    except ValueError as error:
        raise RuntimeError("ENTERPRISE_MCP_SERVERS_JSON is not valid JSON.") from error
    if not isinstance(document, dict) or len(document) > 8:
        raise RuntimeError("Enterprise MCP config must contain at most eight named servers.")
    if agentcash_enabled:
        if "agentcash" in document:
            raise RuntimeError("The built-in AgentCash demo conflicts with an MCP server named agentcash.")
        if not supplied.get("AGENTCASH_HOME"):
            raise RuntimeError("AGENTCASH_HOME is required for the AgentCash demo MCP.")
        agentcash_home = pathlib.Path(supplied["AGENTCASH_HOME"]).expanduser().resolve()
        if agentcash_home == pathlib.Path.home().resolve() or agentcash_home == pathlib.Path(agentcash_home.anchor):
            raise RuntimeError("AGENTCASH_HOME must be a dedicated directory, not a personal home or filesystem root.")
        document["agentcash"] = {
            "command": "npx", "args": ["--yes", "agentcash@0.17.1"],
            "env": {"HOME": "${AGENTCASH_HOME}"},
            "tools": {
                "include": list(AGENTCASH_TOOLS), "resources": False, "prompts": False,
            },
            "policy": {"allowed_hosts": ["stableenrich.dev", "fetcher.sh"], "max_amount_usd": 0.15},
        }

    servers, policies, passthrough = {}, [], {}
    for name, entry in document.items():
        if not isinstance(name, str) or not MCP_NAME.fullmatch(name) or not isinstance(entry, dict):
            raise RuntimeError("Enterprise MCP names and entries are invalid.")
        command, args = entry.get("command"), entry.get("args", [])
        if not isinstance(command, str) or not command.strip() or len(command) > 512:
            raise RuntimeError(f"MCP server {name} has an invalid command.")
        if pathlib.Path(command).name.lower() in {"bash", "sh", "zsh", "dash", "fish", "cmd", "powershell", "pwsh"}:
            raise RuntimeError(f"MCP server {name} may not use a shell interpreter.")
        if (not isinstance(args, list) or len(args) > 24
                or any(not isinstance(value, str) or len(value) > 512 for value in args)):
            raise RuntimeError(f"MCP server {name} has invalid arguments.")
        tools = entry.get("tools")
        include = tools.get("include") if isinstance(tools, dict) else None
        if (not isinstance(include, list) or not include or len(include) > 24
                or any(not isinstance(value, str) or not MCP_NAME.fullmatch(value) for value in include)):
            raise RuntimeError(f"MCP server {name} requires a bounded tools.include allowlist.")
        configured_env = entry.get("env", {})
        if not isinstance(configured_env, dict) or len(configured_env) > 16:
            raise RuntimeError(f"MCP server {name} has invalid environment configuration.")
        for target, reference in configured_env.items():
            match = ENV_REF.fullmatch(reference) if isinstance(reference, str) else None
            if (not isinstance(target, str) or not MCP_NAME.fullmatch(target) or not match
                    or match.group(1) in MCP_SECRET_DENYLIST or match.group(1) not in supplied):
                raise RuntimeError(f"MCP server {name} environment values must reference supplied, scoped variables.")
            passthrough[match.group(1)] = supplied[match.group(1)]
        policy = entry.get("policy", {})
        if not isinstance(policy, dict):
            raise RuntimeError(f"MCP server {name} has an invalid policy.")
        hosts = policy.get("allowed_hosts", [])
        maximum = policy.get("max_amount_usd", 0)
        if (not isinstance(hosts, list) or len(hosts) > 16
                or any(not isinstance(host, str) or not re.fullmatch(r"[a-z0-9.-]{1,253}", host) for host in hosts)
                or not isinstance(maximum, (int, float)) or maximum < 0 or maximum > 1):
            raise RuntimeError(f"MCP server {name} has an invalid host or spend policy.")
        servers[name] = {"command": command, "args": args, "env": configured_env,
                         "tools": {"include": include}}
        for family in ("resources", "prompts"):
            if family in tools:
                if not isinstance(tools[family], bool):
                    raise RuntimeError(f"MCP server {name} has an invalid tools.{family} switch.")
                servers[name]["tools"][family] = tools[family]
        policies.append({"server": name, "tools": include, "allowed_hosts": hosts,
                         "max_amount_usd": float(maximum)})
    return servers, policies, passthrough


def clean_environment(source, profile, token, api_key, extra=None):
    # Nothing from personal provider config, bots, proxies, plugin paths or credentials survives.
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TZ", "TERM", "TMPDIR") if key in os.environ}
    env.update({
        "HOME": str(profile / "os-home"), "HERMES_HOME": str(profile / "home"),
        "PYTHONPATH": str(source), "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
        "ENTERPRISE_RUNTIME_TOKEN": token, "API_SERVER_KEY": api_key,
        "API_SERVER_ENABLED": "true", "API_SERVER_HOST": "127.0.0.1",
    })
    env.update(extra or {})
    return env


def managed_agent_config(toolset_names):
    """Keep retries durable and visible in Enterprise instead of sleeping inside one native run."""
    return {
        "max_iterations": 12,
        # The Worker persists provider Retry-After and owns bounded recovery.
        # A native retry can otherwise leave the product saying Working for up
        # to ten minutes with no new output or recoverable enterprise state.
        "api_max_retries": 1,
        # `skills` stays out of platform_toolsets, but cannot be in the
        # subtraction list because it owns skill_view too.
        "disabled_toolsets": sorted(set(toolset_names) - {"enterprise_bridge", "enterprise_skill_reader", "skills"}),
    }


def mcp_platform_selectors(mcp_servers):
    """Return the native platform selectors for configured MCP server aliases."""
    return sorted(mcp_servers)


def child(metadata_path):
    metadata = json.loads(pathlib.Path(metadata_path).read_text())
    source, profile = pathlib.Path(metadata["source"]), pathlib.Path(metadata_path).parent
    sys.path.insert(0, str(source))
    os.chdir(profile / "workspace")
    # Import only after HOME/HERMES_HOME/PYTHONPATH were replaced by execve.
    from hermes_cli.config import DEFAULT_CONFIG, load_config
    from toolsets import TOOLSETS

    # The plugin pins the verified skill text into every new session's system
    # prompt; Hermes 0.21.3 has no skills.auto_load. A dedicated one-tool set
    # keeps only the read-only viewer for re-reading the assigned package; the
    # stock `skills` toolset would also expose discovery and mutation.
    TOOLSETS["enterprise_skill_reader"] = {
        "description": "Read the assigned enterprise skill",
        "tools": ["skill_view"],
        "includes": [],
    }

    base = metadata["enterprise_url"] + "/internal/runtime/w/" + metadata["workspace_id"] + "/agents/" + metadata["agent_id"]
    enterprise_skills = load_enterprise_skills(base, os.environ["ENTERPRISE_RUNTIME_TOKEN"])
    mcp_servers = metadata.get("mcp_servers") or {}
    # Hermes platform selection names configured MCP server aliases and maps
    # them to registry-owned mcp-<name> toolsets after discovery.
    mcp_toolsets = mcp_platform_selectors(mcp_servers)
    platform_toolsets = ["enterprise_bridge", "enterprise_skill_reader", *mcp_toolsets]
    cache_config = load_enterprise_cache_config(base, metadata["model"], os.environ["ENTERPRISE_RUNTIME_TOKEN"])
    config = {
        "_config_version": DEFAULT_CONFIG.get("_config_version", 12),
        "model": {"provider": "custom", "default": metadata["model"],
                  "base_url": base + "/model/v1", "api_mode": "chat_completions",
                  "api_key": "${ENTERPRISE_RUNTIME_TOKEN}"},
        "agent": managed_agent_config(TOOLSETS),
        "platform_toolsets": {"api_server": platform_toolsets},
        "mcp_servers": mcp_servers,
        "tools": {"tool_search": {"enabled": "off"}},
        "plugins": {"enabled": ["enterprise_bridge"], "entries": {"enterprise_bridge": {"settings": {
            "base_url": base, "native_url": "http://127.0.0.1:" + str(metadata["port"]),
            "request_timeout_seconds": 5, "pending_timeout_seconds": 86400,
            "allowed_skills": enterprise_skills["auto_load"],
            "mcp_policy": metadata.get("mcp_policy") or [],
            "partner_program": enterprise_skills["config"].get("partner_program", {}),
        }}}},
        "gateway": {"multiplex_profiles": False, "api_server": {"max_concurrent_runs": 1},
                    "platforms": {"api_server": {"enabled": True, "extra": {
                        "host": "127.0.0.1", "port": metadata["port"], "key": "${API_SERVER_KEY}",
                    }}}},
        "approvals": {"unattended_mode": "deny", "cron_mode": "deny"},
        "cron": {"allow_agent_scheduling": False},
        "memory": {"memory_enabled": False, "user_profile_enabled": False, "nudge_interval": 0},
        "skills": {"creation_nudge_interval": 0, "write_approval": True,
                   "config": enterprise_skills["config"]},
        "auxiliary": {"background_review": {"enabled": False}, "title_generation": {"enabled": False}},
        **cache_config,
    }
    private_write(profile / "home/config.yaml", json.dumps(config, indent=2) + "\n")
    os.environ["API_SERVER_PORT"] = str(metadata["port"])
    from hermes_cli.plugins import discover_plugins
    from hermes_cli.tools_config import _get_platform_tools
    from model_tools import get_tool_definitions
    if not metadata.get("native_cron_enabled"):
        assert_native_cron_empty()
        install_native_api_policy()
    discover_plugins()
    from hermes_cli.plugins import get_plugin_manager
    manager = get_plugin_manager()
    try:
        actual_plugin = actual_plugin_attestation(manager)
        actual_skills = actual_skill_attestation(manager, enterprise_skills["manifests"])
        # The reviewed source tree defines the expected sections; the live
        # render comes from the profile's plugin copy. Equality proves the
        # exact assigned text reaches every new session.
        actual_skill_prompt_attestation(
            manager, build_skill_prompt_sections(enterprise_skills["manifests"]),
        )
    except RuntimeError as error:
        raise SystemExit(str(error)) from error
    loaded = load_config()
    selected = _get_platform_tools(loaded, "api_server")
    definitions = get_tool_definitions(enabled_toolsets=sorted(selected),
                                       disabled_toolsets=config["agent"]["disabled_toolsets"],
                                       quiet_mode=True, skip_tool_search_assembly=True)
    from tools.registry import registry
    names = {item["function"]["name"] for item in definitions}
    static_names = {name for name in names if not name.startswith("mcp__")}
    if (selected != set(platform_toolsets) or "skill_view" not in static_names
            or any(registry.get_entry(name).toolset != "enterprise_bridge"
                   for name in static_names - {"skill_view"})
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
    write_runtime_attestation(profile, metadata, actual_plugin, actual_skills, names)
    print(f"Verified official Hermes {REVISION[:12]}: {len(names)} governed tools; "
          f"native_cron={bool(metadata.get('native_cron_enabled'))}; mcp={sorted(mcp_servers)}; "
          f"isolated agent {metadata['agent_id']}", flush=True)
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
    release_ring = supplied.get("HERMES_ENTERPRISE_RELEASE_RING", "stable").strip().lower()
    if release_ring not in CONTRACT["supported_release_rings"]:
        parser.error("HERMES_ENTERPRISE_RELEASE_RING must be canary or stable")
    try:
        mcp_servers, mcp_policy, mcp_environment = load_mcp_servers(
            supplied.get("ENTERPRISE_MCP_SERVERS_JSON", ""), supplied,
            supplied.get("HERMES_AGENTCASH_MCP_ENABLED") == "1",
        )
    except RuntimeError as error:
        parser.error(str(error))
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
                "verify_only": args.verify_only,
                "native_cron_enabled": supplied.get("HERMES_NATIVE_CRON_ENABLED") == "1",
                "mcp_servers": mcp_servers, "mcp_policy": mcp_policy}
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
    runtime_environment = {
        **mcp_environment,
        "ENTERPRISE_WORKSPACE_ID": args.workspace_id,
        "ENTERPRISE_AGENT_ID": agent_id,
        "ENTERPRISE_URL": args.enterprise_url.rstrip("/"),
        "HERMES_ENTERPRISE_NATIVE_URL": "http://127.0.0.1:" + str(args.port),
        "HERMES_AGENTCASH_MCP_ENABLED": "1" if "agentcash" in mcp_servers else "0",
        "HERMES_NATIVE_CRON_ENABLED": "1" if supplied.get("HERMES_NATIVE_CRON_ENABLED") == "1" else "0",
        "HERMES_ENTERPRISE_SOURCE_REVISION": CONTRACT["source_revision"],
        "HERMES_ENTERPRISE_RELEASE_RING": release_ring,
    }
    if supplied.get("HERMES_ENTERPRISE_CONTROL_SECRET"):
        runtime_environment["HERMES_ENTERPRISE_CONTROL_SECRET"] = supplied["HERMES_ENTERPRISE_CONTROL_SECRET"]
    env = clean_environment(source, profile, token, api_key_path.read_text().strip(), runtime_environment)
    print("Native API key file: " + str(api_key_path), flush=True)
    print("Native API URL: http://127.0.0.1:" + str(args.port), flush=True)
    os.execve(str(args.python.absolute()), [str(args.python.absolute()), str(ROOT / "start.py"), "_child", str(metadata_path)], env)


if __name__ == "__main__":
    main()
