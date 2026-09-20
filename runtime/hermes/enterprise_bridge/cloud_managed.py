"""Fail-closed initialization for an ordinary supervised Hermes Cloud gateway."""

from __future__ import annotations

import importlib
import inspect
import logging
import os
import pathlib
import re
import sys
import threading
import time
import urllib.parse
import uuid
from datetime import datetime, timezone

from .packages import PLUGIN_NAME, PLUGIN_VERSION
from .runtime_policy import (
    NativePolicyState,
    RUNTIME_REVISION,
    actual_plugin_attestation,
    actual_skill_attestation,
    assert_native_cron_empty,
    install_native_api_policy,
    install_native_model_policy,
    load_enterprise_skills,
    mark_managed_profile,
    remove_runtime_attestation,
    sha256_path,
    validate_managed_plugin_source,
    write_runtime_attestation,
)


FLAG = "HERMES_ENTERPRISE_CLOUD_MANAGED"
EXPECTED_HERMES_VERSION = "0.21.3"
SOURCE_DIGESTS = {
    "agent.conversation_loop": "e8f8e140c43d0954a5d21c8a8edf2630e953b20b3e3a4e52db1405671cc25bb1",
    "gateway.platforms.api_server": "800b15a537c24636509187ddfd850eadec94873f18dec633466604d525403fce",
    "hermes_cli.plugins": "77853fdef1a8b9eac4904d21d78f0f746e324473c86806a5be2b148328fce094",
    "hermes_cli.plugins_loader": "38280b9a7f83e6f4c0e03dbec91cd986c41b3f3a7eff05772c844e5d4b3c58ff",
    "hermes_cli.runtime_provider": "97cd8da5116efe7323e6836d2683661602a985964bdb6f8f7f60f632e842ce30",
    "hermes_cli.tools_config": "039dc85e2494bd44b692ebdad022fdef40526f6048a3275efdeeb97939a16afd",
    "model_tools": "432ab8bcf79bbac321e76385aaa15ad6056999cbf372917f0dbf0ab13e2679dc",
    "cron.jobs": "0e444b6ce34f7dde94374e6826c07f69e4854a2eb160efad728838469a1d30ad",
}
AGENTCASH_SERVER = {
    "command": "npx",
    "args": ["--yes", "agentcash@0.17.1"],
    "env": {"HOME": "${AGENTCASH_HOME}"},
    # Hermes otherwise synthesizes four resource/prompt utility tools when an
    # MCP SDK advertises those capabilities. This role exposes only fetch.
    "tools": {"include": ["fetch"], "resources": False, "prompts": False},
}
AGENTCASH_POLICY = [{
    "server": "agentcash",
    "tools": ["fetch"],
    "allowed_hosts": ["stableenrich.dev", "fetcher.sh"],
    "max_amount_usd": 0.15,
}]
_ENTERPRISE_READER = {
    "description": "Read the assigned enterprise skill",
    "tools": ["skill_view"],
    "includes": [],
}
PARTNER_CAPABILITIES = frozenset({
    "partner.discovery.read",
    "partner.review.prepare",
    "partner.outreach.draft",
    "partner.records.qualification.write",
    "partner.handoff.publish",
})
FINANCE_CAPABILITIES = frozenset({
    "partner.shared.read",
    "partner.invoice.read",
    "partner.invoice.review.prepare",
})
PARTNER_TOOLS = frozenset({
    "list_partner_candidates", "get_partner_candidate",
    "list_requests", "get_request", "get_approval_status", "get_document_text",
    "save_review_note", "set_context_field", "ask_for_context", "set_focus",
    "propose_request", "propose_approval", "propose_instruction",
})
ROLE_BINDINGS = {
    ("enterprise_bridge:partner-program-screening", "1.7.0"): {
        "skill_key": "partner-program-screening",
        "capabilities": PARTNER_CAPABILITIES,
        "tools": PARTNER_TOOLS,
    },
    ("enterprise_bridge:partner-program-screening-v1-8", "1.8.0"): {
        "skill_key": "partner-program-screening",
        "capabilities": PARTNER_CAPABILITIES,
        "tools": PARTNER_TOOLS | {"publish_partner_invoice_review"},
    },
    ("enterprise_bridge:partner-invoice-review", "1.0.1"): {
        "skill_key": "partner-invoice-review",
        "capabilities": FINANCE_CAPABILITIES,
        "tools": frozenset({"get_partner_handoff_result", "list_requests", "get_request"}),
    },
}


def managed_flag_enabled(environ=None):
    value = (environ or os.environ).get(FLAG, "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def is_gateway_process(argv=None):
    """Use Hermes's pinned command parser; dashboard/console discovery must never attest."""
    from gateway.status import looks_like_gateway_runtime_command_line
    return looks_like_gateway_runtime_command_line(" ".join(argv or sys.argv))


def install_enterprise_reader_toolset():
    from toolsets import TOOLSETS
    existing = TOOLSETS.get("enterprise_skill_reader")
    if existing is not None and existing != _ENTERPRISE_READER:
        raise RuntimeError("enterprise_skill_reader conflicts with an existing native toolset")
    TOOLSETS["enterprise_skill_reader"] = dict(_ENTERPRISE_READER)


def begin_managed_startup():
    """Install the non-disposable closed route gate before any fallible operation."""
    home = pathlib.Path(os.environ.get("HERMES_HOME", "")).expanduser()
    if not str(home) or not home.is_absolute():
        raise RuntimeError("Cloud-managed Enterprise startup requires an absolute HERMES_HOME")
    state = NativePolicyState(home / "runtime-readiness.json")
    install_native_api_policy(state)
    install_native_model_policy(state)
    try:
        mark_managed_profile(home)
        remove_runtime_attestation(home)
    except Exception as error:
        state.mark_failed(error)
        raise
    return state


def _clean_url(raw, *, loopback_http=False):
    try:
        parsed = urllib.parse.urlsplit(raw)
    except (TypeError, ValueError) as error:
        raise RuntimeError("Enterprise URL is invalid") from error
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
            or (parsed.scheme != "https" and not (loopback_http and local and parsed.scheme == "http"))):
        raise RuntimeError("Enterprise URL must be clean HTTPS or allowed loopback HTTP")
    return raw.rstrip("/")


def validate_native_source():
    """Prove the source files whose private seams this plugin relies on."""
    import hermes_cli
    if getattr(hermes_cli, "__version__", None) != EXPECTED_HERMES_VERSION:
        raise RuntimeError("Cloud-managed Enterprise requires Hermes 0.21.3")
    paths = {}
    for module_name, expected in SOURCE_DIGESTS.items():
        module = importlib.import_module(module_name)
        source = inspect.getsourcefile(module)
        if not source:
            raise RuntimeError("Pinned Hermes source is unavailable: " + module_name)
        path = pathlib.Path(source)
        if path.is_symlink() or not path.is_file() or sha256_path(path) != expected:
            raise RuntimeError("Pinned Hermes source drifted: " + module_name)
        paths[module_name] = path
    return paths


def _validate_identity(settings):
    workspace_id = os.environ.get("ENTERPRISE_WORKSPACE_ID", "").strip()
    agent_id = os.environ.get("ENTERPRISE_AGENT_ID", "").strip()
    enterprise_url = _clean_url(os.environ.get("ENTERPRISE_URL", ""), loopback_http=True)
    try:
        uuid.UUID(workspace_id)
        uuid.UUID(agent_id)
    except ValueError as error:
        raise RuntimeError("Cloud-managed Enterprise identity must use UUIDs") from error
    token = os.environ.get("ENTERPRISE_RUNTIME_TOKEN", "")
    api_key = os.environ.get("API_SERVER_KEY", "")
    model = os.environ.get("HERMES_ENTERPRISE_MODEL", "").strip()
    if (not re.fullmatch(r"[0-9a-f]{64}", token)
            or len(api_key) < 16 or any(ch.isspace() for ch in api_key) or not model):
        raise RuntimeError("Cloud-managed Enterprise credentials or model binding are missing")
    base = f"{enterprise_url}/internal/runtime/w/{workspace_id}/agents/{agent_id}"
    if settings.get("base_url", "").rstrip("/") != base:
        raise RuntimeError("Enterprise plugin base URL is misbound")
    native_url = _clean_url(settings.get("native_url", ""), loopback_http=True)
    if urllib.parse.urlsplit(native_url).hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError("Enterprise native URL must stay loopback-only")
    if os.environ.get("HERMES_ENTERPRISE_NATIVE_URL", "").rstrip("/") != native_url:
        raise RuntimeError("Enterprise native URL environment is misbound")
    return {
        "workspace_id": workspace_id,
        "agent_id": agent_id,
        "enterprise_url": enterprise_url,
        "base": base,
        "native_url": native_url,
        "token": token,
        "api_key": api_key,
        "model": model,
    }


def _nested(document, *path):
    value = document
    for key in path:
        value = value.get(key) if isinstance(value, dict) else None
    return value


def _positive_integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _future_timestamp(value):
    if not isinstance(value, str):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.astimezone(timezone.utc) > datetime.now(timezone.utc)


def _validate_binding(assignment):
    """Validate one authenticated assignment or monotonic preflight binding."""
    bindings = assignment.get("bindings")
    if not isinstance(bindings, list) or len(bindings) != 1:
        raise RuntimeError("Managed Enterprise discovery requires one exact binding")
    item = bindings[0]
    role = ROLE_BINDINGS.get((item.get("name"), item.get("version")))
    capabilities = item.get("capability_grants")
    if (role is None or item.get("runtime_name") != item.get("name")
            or item.get("skill_key") != role["skill_key"] or item.get("state") != "active"
            or item.get("artifact_digest") != assignment["manifests"][0]["artifact_digest"]
            or not isinstance(capabilities, list)
            or any(not isinstance(value, str) for value in capabilities)
            or len(capabilities) != len(set(capabilities))
            or set(capabilities) != role["capabilities"]):
        raise RuntimeError("Managed Enterprise binding identity or capabilities are invalid")
    source = item.get("binding_source")
    if source == "preflight_grant":
        if ((item.get("name"), item.get("version")) != (
                "enterprise_bridge:partner-program-screening", "1.7.0"
        ) or item.get("grant_revision") != 1
                or item.get("binding_state") not in {
                    "prepared", "linked_available", "linked_reserved",
                }
                or (item.get("assignment_revision") is not None
                    and not _positive_integer(item.get("assignment_revision")))):
            raise RuntimeError("Managed Enterprise preflight binding is invalid")
        if item["binding_state"] == "prepared":
            if not _future_timestamp(item.get("grant_expires_at")):
                raise RuntimeError("Managed Enterprise preflight grant is expired")
        elif item.get("grant_expires_at") is not None:
            raise RuntimeError("Linked Enterprise preflight binding retained an expiry")
    elif source == "enterprise_assignment":
        if (not _positive_integer(item.get("assignment_revision"))
                or item.get("grant_revision") is not None
                or item.get("binding_state") is not None
                or item.get("grant_expires_at") is not None):
            raise RuntimeError("Managed Enterprise assignment binding is invalid")
    else:
        raise RuntimeError("Managed Enterprise binding source is invalid")
    return {
        "name": item["name"],
        "version": item["version"],
        "artifact_digest": item["artifact_digest"],
        "skill_key": item["skill_key"],
        "capabilities": frozenset(capabilities),
        "tools": role["tools"],
    }


def _advance_binding_phase(current, observed):
    """Allow one preflight-to-assignment promotion and forbid any downgrade."""
    if current == "enterprise_assignment":
        if observed != "enterprise_assignment":
            raise RuntimeError("Managed Enterprise assignment binding regressed to preflight")
        return current
    if current == "preflight_grant":
        if observed in {"preflight_grant", "enterprise_assignment"}:
            return observed
    raise RuntimeError("Managed Enterprise binding lifecycle is invalid")


def _validate_role_config(config, settings, assignment):
    names = assignment["auto_load"]
    if len(names) != 1:
        raise RuntimeError("Cloud-managed profile must have exactly one assigned enterprise skill")
    finance = names == ["enterprise_bridge:partner-invoice-review"]
    partnership = names in (["enterprise_bridge:partner-program-screening"],
                            ["enterprise_bridge:partner-program-screening-v1-8"])
    if not finance and not partnership:
        raise RuntimeError("Cloud-managed profile has an unsupported role assignment")
    expected_policy = [] if finance else AGENTCASH_POLICY
    if settings.get("mcp_policy", []) != expected_policy:
        raise RuntimeError("Enterprise MCP policy does not match the assigned role")
    enabled = os.environ.get("HERMES_AGENTCASH_MCP_ENABLED") == "1"
    if enabled != partnership:
        raise RuntimeError("AgentCash enablement does not match the assigned role")
    expected_mcp = {}
    if partnership:
        configured_home = os.environ.get("AGENTCASH_HOME", "")
        root = pathlib.Path(configured_home).expanduser()
        wallet = root / ".agentcash" / "wallet.json"
        if (not root.is_absolute() or root == pathlib.Path.home() or root == pathlib.Path(root.anchor)
                or wallet.is_symlink() or not wallet.is_file()):
            raise RuntimeError("Partnerships requires its dedicated AgentCash wallet")
        # Hermes expands ${AGENTCASH_HOME} while loading config.yaml. Compare
        # the resolved value to the same validated environment path rather than
        # the source placeholder retained in AGENTCASH_SERVER.
        expected_mcp = {"agentcash": {
            **AGENTCASH_SERVER,
            "env": {"HOME": configured_home},
        }}
    if (config.get("mcp_servers") or {}) != expected_mcp:
        raise RuntimeError("Enterprise MCP configuration does not match the assigned role")
    return partnership, ({"mcp__agentcash__fetch"} if partnership else set())


def _validate_config(identity, settings, assignment):
    from hermes_cli.config import get_config_path, load_config
    from toolsets import TOOLSETS
    config = load_config()
    if config.get("plugins", {}).get("enabled") != [PLUGIN_NAME]:
        raise RuntimeError("Only enterprise_bridge may be enabled in the governed profile")
    if (config.get("fallback_providers") not in (None, [])
            or config.get("fallback_model") not in (None, [], {})
            or config.get("providers") not in (None, {})
            or config.get("custom_providers") not in (None, {})):
        raise RuntimeError("Managed provider fallback or alternate provider configuration is forbidden")
    if settings.get("allowed_skills") != assignment["auto_load"]:
        raise RuntimeError("Configured allowed skills differ from the authenticated assignment")
    if settings.get("partner_program", {}) != assignment["config"].get("partner_program", {}):
        raise RuntimeError("Partner Program policy differs from the authenticated assignment")
    if (config.get("skills", {}).get("auto_load") != assignment["auto_load"]
            or config.get("skills", {}).get("config") != assignment["config"]
            or config.get("skills", {}).get("creation_nudge_interval") != 0
            or config.get("skills", {}).get("write_approval") is not True):
        raise RuntimeError("Managed skill configuration is not exact")
    partnership, expected_mcp_names = _validate_role_config(config, settings, assignment)
    # platform_toolsets names the configured MCP server alias. Hermes resolves
    # that alias to the registry-owned mcp-agentcash toolset after discovery.
    mcp_toolsets = ["agentcash"] if partnership else []
    expected_toolsets = ["enterprise_bridge", "enterprise_skill_reader", *mcp_toolsets]
    if _nested(config, "platform_toolsets", "api_server") != expected_toolsets:
        raise RuntimeError("API Server toolsets are not the governed role inventory")
    disabled = set(_nested(config, "agent", "disabled_toolsets") or [])
    allowed_toolsets = {"enterprise_bridge", "enterprise_skill_reader", "skills", *mcp_toolsets}
    if ((set(TOOLSETS) - allowed_toolsets) - disabled or disabled & allowed_toolsets
            or _nested(config, "agent", "max_iterations") != 12
            or _nested(config, "agent", "api_max_retries") != 1):
        raise RuntimeError("Native toolset suppression is incomplete")
    if (_nested(config, "tools", "tool_search", "enabled") != "off"
            or _nested(config, "memory", "memory_enabled") is not False
            or _nested(config, "memory", "user_profile_enabled") is not False
            or _nested(config, "memory", "nudge_interval") != 0
            or _nested(config, "auxiliary", "background_review", "enabled") is not False
            or _nested(config, "auxiliary", "title_generation", "enabled") is not False
            or _nested(config, "curator", "enabled") is not False):
        raise RuntimeError("Native memory, curator, tool search, or background model work remains enabled")
    if (_nested(config, "approvals", "unattended_mode") != "deny"
            or _nested(config, "approvals", "cron_mode") != "deny"
            or _nested(config, "cron", "allow_agent_scheduling") is not False
            or _nested(config, "gateway", "multiplex_profiles") is not False
            or _nested(config, "gateway", "api_server", "max_concurrent_runs") != 1):
        raise RuntimeError("Gateway admission or cron policy is not governed")
    platforms = _nested(config, "gateway", "platforms") or {}
    enabled_platforms = {name for name, entry in platforms.items()
                         if isinstance(entry, dict) and entry.get("enabled") is True}
    api = platforms.get("api_server") if isinstance(platforms, dict) else None
    extra = api.get("extra") if isinstance(api, dict) else None
    parsed_native = urllib.parse.urlsplit(identity["native_url"])
    if (enabled_platforms != {"api_server"} or not isinstance(extra, dict)
            or set(extra) != {"host", "port", "key"}
            or extra.get("host") not in {"localhost", "127.0.0.1", "::1"}
            or int(extra.get("port", 0)) != (parsed_native.port or 80)
            or extra.get("key") != identity["api_key"]):
        raise RuntimeError("Native API Server is not exact, loopback, bearer-authenticated, and single-profile")
    model = config.get("model")
    if (not isinstance(model, dict) or model.get("provider") != "custom"
            or model.get("default") != identity["model"]
            or str(model.get("base_url", "")).rstrip("/") != identity["base"] + "/model/v1"
            or model.get("api_mode") != "chat_completions"
            or model.get("api_key") != identity["token"]):
        raise RuntimeError("Enterprise model proxy configuration is misbound")
    path = pathlib.Path(get_config_path())
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("Managed Hermes config file is unavailable")
    return config, path, expected_toolsets, disabled, expected_mcp_names, partnership


def _tool_inventory(expected_toolsets, disabled, expected_enterprise, expected_mcp):
    from hermes_cli.tools_config import _get_platform_tools
    from hermes_cli.config import load_config
    from model_tools import get_tool_definitions
    from tools.registry import registry
    selected = _get_platform_tools(load_config(), "api_server")
    if selected != set(expected_toolsets):
        raise RuntimeError("Resolved API Server toolsets drifted")
    definitions = get_tool_definitions(
        enabled_toolsets=sorted(selected), disabled_toolsets=sorted(disabled),
        quiet_mode=True, skip_tool_search_assembly=True,
    )
    names = {item["function"]["name"] for item in definitions}
    expected = {"skill_view", *expected_enterprise, *expected_mcp}
    if names != expected:
        missing = expected - names
        if missing and missing <= expected_mcp and not (names - expected):
            return None
        raise RuntimeError("Resolved native tool inventory differs from the governed assignment")
    for name in expected_enterprise:
        entry = registry.get_entry(name)
        if entry is None or entry.toolset != "enterprise_bridge":
            raise RuntimeError("Enterprise tool registry ownership drifted")
    return names


def _validate_provider(identity):
    from hermes_cli.runtime_provider import resolve_runtime_provider
    runtime = resolve_runtime_provider(requested="custom")
    if (str(runtime.get("base_url", "")).rstrip("/") != identity["base"] + "/model/v1"
            or runtime.get("api_key") != identity["token"]
            or runtime.get("api_mode") != "chat_completions"):
        raise RuntimeError("Enterprise model proxy resolver is misbound")


def _initializer(settings, state, enterprise_tool_names):
    try:
        # register() runs while PluginManager holds its discovery lock. Starting
        # pinned module/tool imports from this worker before that lock is
        # released can invert the import and discovery locks during cold boot.
        # Join the completed discovery pass before doing any further imports.
        from hermes_cli.plugins import get_plugin_manager
        manager = get_plugin_manager()
        with manager._discovery_lock:
            pass
        source_paths = validate_native_source()
        identity = _validate_identity(settings)
        assignment = load_enterprise_skills(
            identity["base"], identity["token"], plugin_root=pathlib.Path(__file__).parent,
        )
        binding = _validate_binding(assignment)
        if set(enterprise_tool_names) != binding["tools"]:
            raise RuntimeError("Worker tool discovery differs from the exact role binding")
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                plugin = actual_plugin_attestation(manager)
                break
            except RuntimeError:
                time.sleep(0.05)
        else:
            raise RuntimeError("Enterprise plugin did not finish native registration")
        plugin_source = validate_managed_plugin_source(
            pathlib.Path(__file__).parent, pathlib.Path(os.environ["HERMES_HOME"]),
        )
        plugin = {
            **plugin,
            "revision": plugin_source["revision"],
            "artifact_digest": plugin_source["artifact_digest"],
        }
        skills = actual_skill_attestation(manager, assignment["manifests"], pathlib.Path(__file__).parent)
        _config, config_path, toolsets, disabled, expected_mcp, partnership = _validate_config(
            identity, settings, assignment,
        )
        assert_native_cron_empty()
        _validate_provider(identity)
        deadline = time.monotonic() + (125 if expected_mcp else 1)
        while True:
            names = _tool_inventory(toolsets, disabled, set(enterprise_tool_names), expected_mcp)
            if names is not None:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("Required AgentCash MCP tool was not registered by native startup")
            time.sleep(0.25)
        metadata = {
            "workspace_id": identity["workspace_id"],
            "agent_id": identity["agent_id"],
            "enterprise_url": identity["enterprise_url"],
            "agentcash_enabled": partnership,
            "native_cron_enabled": False,
            "managed_cloud": True,
            "boot_id": state.boot_id,
        }
        attestation = write_runtime_attestation(
            pathlib.Path(os.environ["HERMES_HOME"]), metadata, plugin, skills, names,
        )
        expected_config_digest = sha256_path(config_path)
        expected_skill_digests = {item["name"]: item["content_digest"] for item in skills}
        expected_assignment = {
            "auto_load": assignment["auto_load"],
            "config": assignment["config"],
            "manifests": assignment["manifests"],
        }
        binding_phase = assignment["bindings"][0]["binding_source"]

        def validate_current():
            nonlocal binding_phase
            # Refresh remote authority first, then check every local invariant.
            # This ordering closes a drift window while authenticated discovery
            # is in flight immediately before a provider attempt.
            current_assignment = load_enterprise_skills(
                identity["base"], identity["token"], plugin_root=pathlib.Path(__file__).parent,
            )
            current_binding = _validate_binding(current_assignment)
            if ({key: current_assignment[key] for key in expected_assignment} != expected_assignment
                    or current_binding != binding):
                raise RuntimeError("Authenticated Enterprise role binding changed after readiness")
            binding_phase = _advance_binding_phase(
                binding_phase, current_assignment["bindings"][0]["binding_source"],
            )
            if sha256_path(config_path) != expected_config_digest:
                raise RuntimeError("Managed Hermes config changed after readiness")
            for source_name, path in source_paths.items():
                if sha256_path(path) != SOURCE_DIGESTS[source_name]:
                    raise RuntimeError("Pinned Hermes source changed after readiness")
            current_skills = actual_skill_attestation(
                manager, assignment["manifests"], pathlib.Path(__file__).parent,
            )
            if {item["name"]: item["content_digest"] for item in current_skills} != expected_skill_digests:
                raise RuntimeError("Managed enterprise skill changed after readiness")
            if actual_plugin_attestation(manager) != {
                "name": plugin["name"], "version": plugin["version"],
            }:
                raise RuntimeError("Enterprise plugin identity changed after readiness")
            if validate_managed_plugin_source(
                pathlib.Path(__file__).parent, pathlib.Path(os.environ["HERMES_HOME"]),
            ) != plugin_source:
                raise RuntimeError("Enterprise plugin source changed after readiness")
            assert_native_cron_empty()
            _validate_provider(identity)
            if _tool_inventory(toolsets, disabled, set(enterprise_tool_names), expected_mcp) != names:
                raise RuntimeError("Governed native tool inventory changed after readiness")

        state.mark_ready(
            sha256_path(state.readiness_path),
            validate_current,
            provider_binding={
                "provider": "custom",
                "model": identity["model"],
                "base_url": identity["base"] + "/model/v1",
                "api_key": identity["token"],
                "api_mode": "chat_completions",
            },
        )
        logging.info(
            "Cloud-managed Enterprise runtime ready: Hermes %s (%s), %d governed tools",
            EXPECTED_HERMES_VERSION, RUNTIME_REVISION[:12], len(attestation["tools"]),
        )
    except Exception as error:
        state.mark_failed(error)
        logging.error("Cloud-managed Enterprise readiness failed closed: %s", error)


def start_initializer(settings, state, enterprise_tool_names):
    """Validate after register() returns, while native admission stays closed."""
    worker = threading.Thread(
        target=_initializer,
        args=(dict(settings), state, frozenset(enterprise_tool_names)),
        daemon=True,
        name="enterprise-cloud-readiness",
    )
    worker.start()
    return worker
