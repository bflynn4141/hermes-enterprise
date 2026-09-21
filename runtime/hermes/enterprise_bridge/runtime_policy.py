"""Shared fail-closed native runtime policy for launcher and managed Cloud profiles."""

from __future__ import annotations

import functools
import hashlib
import json
import os
import pathlib
import re
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request

from .packages import PLUGIN_NAME, PLUGIN_VERSION, packaged_skills, sha256_file


RUNTIME_REVISION = "345cd2b057a452236de401d3534b8502a7465e8d"
RUNTIME_READINESS_FILENAME = "runtime-readiness.json"
MANAGED_PROFILE_MARKER_FILENAME = "enterprise-cloud-managed.json"
EXPECTED_PLUGIN_SOURCES = frozenset({
    "git@github.com:bflynn4141/hermes-enterprise.git#runtime/hermes/enterprise_bridge",
    "https://github.com/bflynn4141/hermes-enterprise.git#runtime/hermes/enterprise_bridge",
})
NATIVE_HEALTH_PATHS = frozenset({"/health", "/health/detailed", "/v1/health", "/v1/capabilities"})
# Plugin system-prompt sections at RUNTIME_REVISION (hermes_cli/plugins_dispatch.py).
# The pinned runtime strips each section, refuses one above 4,000 characters,
# skips everything past an 8,000-character framed total, and renders sections
# in id order. Assigned skill text is delivered as numbered continuation
# sections inside that budget; the live render is compared before readiness.
SKILL_SECTION_ID_PREFIX = "enterprise-skill"
NATIVE_PROMPT_SECTION_POSITION = "after_memory"
NATIVE_PROMPT_SECTION_MAX_CHARS = 4000
NATIVE_PROMPT_SECTIONS_TOTAL_CHARS = 8000
NATIVE_PROMPT_SECTIONS_START = "<!-- hermes-plugin-sections:start -->"
NATIVE_PROMPT_SECTIONS_END = "<!-- hermes-plugin-sections:end -->"
CLOUD_SAFE_ROUTES = frozenset({
    ("GET", "/health"),
    ("GET", "/health/detailed"),
    ("GET", "/v1/health"),
    ("GET", "/v1/capabilities"),
    ("POST", "/v1/runs"),
    ("GET", "/v1/runs/{run_id}"),
    ("GET", "/v1/runs/{run_id}/events"),
    ("POST", "/v1/runs/{run_id}/approval"),
    ("POST", "/v1/runs/{run_id}/steer"),
    ("POST", "/v1/runs/{run_id}/stop"),
})
CLOUD_SPEND_ROUTES = frozenset({
    ("POST", "/v1/runs"),
    ("POST", "/v1/runs/{run_id}/approval"),
    ("POST", "/v1/runs/{run_id}/steer"),
})


def private_write(path, text):
    """Atomically replace a private non-secret metadata file."""
    path = pathlib.Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(text)
    temporary.chmod(0o600)
    temporary.replace(path)


def remove_runtime_attestation(home):
    """Remove stale readiness before any managed startup validation begins."""
    path = pathlib.Path(home) / RUNTIME_READINESS_FILENAME
    try:
        path.unlink(missing_ok=True)
    except OSError as error:
        raise RuntimeError("Stale Enterprise runtime readiness could not be removed.") from error
    return path


def mark_managed_profile(home):
    """Persist the profile's opt-in boundary across later environment mistakes."""
    path = pathlib.Path(home) / MANAGED_PROFILE_MARKER_FILENAME
    private_write(path, json.dumps({
        "schema_version": 1,
        "managed_cloud": True,
    }, indent=2, sort_keys=True) + "\n")
    return path


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


class NativePolicyState:
    """In-process admission latch; a readiness file alone never opens native runs."""

    def __init__(self, readiness_path):
        self.readiness_path = pathlib.Path(readiness_path)
        self.boot_id = secrets.token_hex(16)
        self.ready = False
        self.error = "native readiness validation has not completed"
        self._readiness_digest = None
        self._validate_current = None
        self._provider_binding = None
        self._lock = threading.RLock()

    def mark_ready(self, readiness_digest, validate_current, provider_binding=None):
        with self._lock:
            self._readiness_digest = readiness_digest
            self._validate_current = validate_current
            self._provider_binding = dict(provider_binding) if provider_binding is not None else None
            self.error = ""
            self.ready = True

    def mark_failed(self, error):
        with self._lock:
            self.ready = False
            self.error = str(error)[:500]
            self._readiness_digest = None
            self._validate_current = None
            self._provider_binding = None
            try:
                self.readiness_path.unlink(missing_ok=True)
            except OSError:
                pass

    def ensure_current(self):
        """Recheck current process/file state before any provider or tool side effect."""
        with self._lock:
            if not self.ready or self._validate_current is None or self._readiness_digest is None:
                return False
            try:
                if self.readiness_path.is_symlink() or not self.readiness_path.is_file():
                    raise RuntimeError("native readiness file is unavailable")
                if sha256_path(self.readiness_path) != self._readiness_digest:
                    raise RuntimeError("native readiness file changed after validation")
                self._validate_current()
                return True
            except Exception as error:
                self.mark_failed(error)
                return False

    def ensure_provider_current(self, agent):
        """Recheck readiness and the effective agent route immediately before I/O."""
        if not self.ensure_current():
            return False
        with self._lock:
            expected = self._provider_binding
            try:
                if expected is None:
                    raise RuntimeError("managed provider binding is unavailable")
                actual = {
                    "provider": str(getattr(agent, "provider", "") or ""),
                    "base_url": str(getattr(agent, "base_url", "") or "").rstrip("/"),
                    "api_key": str(getattr(agent, "api_key", "") or ""),
                    "api_mode": str(getattr(agent, "api_mode", "") or ""),
                }
                if actual != expected:
                    raise RuntimeError("effective provider route differs from managed binding")
                return True
            except Exception as error:
                self.mark_failed(error)
                return False


def install_native_api_policy(state=None):
    """Remove cron and, for Cloud-managed profiles, expose only governed native routes.

    Hermes deliberately catches plugin registration errors. The in-process latch therefore
    guards provider-bearing routes independently of the attestation file and remains closed
    until the shared validator marks this exact gateway process ready.
    """
    from aiohttp import web
    from gateway.platforms.api_server import APIServerAdapter

    current = APIServerAdapter._http_route_table
    if getattr(current, "_enterprise_policy", False):
        if state is not None:
            current._enterprise_cloud_state = state
        return

    original = current

    def governed_routes(adapter):
        routes = []
        cloud_state = governed_routes._enterprise_cloud_state
        for method, path, handler in original(adapter):
            if native_cron_route(path):
                continue
            if cloud_state is not None and (method, path) not in CLOUD_SAFE_ROUTES:
                continue
            if path in NATIVE_HEALTH_PATHS:
                async def guarded_health(request, _handler=handler, _path=path):
                    response = await _handler(request)
                    if response.status >= 400:
                        return response
                    try:
                        assert_native_cron_empty()
                        current_state = governed_routes._enterprise_cloud_state
                        # Capabilities are inert and are the supported preflight
                        # used before a newly installed Cloud profile has a
                        # ready binding. Health stays tied to live readiness.
                        if (current_state is not None and _path != "/v1/capabilities"
                                and not current_state.ensure_current()):
                            raise RuntimeError("native readiness validation has not completed")
                    except Exception:
                        managed = governed_routes._enterprise_cloud_state is not None
                        return web.json_response({
                            "error": ("Enterprise native runtime policy failed." if managed
                                      else "Enterprise native cron policy failed."),
                            "code": ("native_readiness_unavailable" if managed
                                     else "native_cron_not_empty"),
                        }, status=503)
                    current_state = governed_routes._enterprise_cloud_state
                    if current_state is not None and _path != "/v1/capabilities":
                        response.headers["X-Hermes-Enterprise-Boot"] = current_state.boot_id
                        response.headers["X-Hermes-Enterprise-Readiness-SHA256"] = (
                            current_state._readiness_digest or ""
                        )
                    return response
                handler = guarded_health
            elif cloud_state is not None and (method, path) in CLOUD_SPEND_ROUTES:
                async def guarded_run(request, _handler=handler):
                    if not governed_routes._enterprise_cloud_state.ensure_current():
                        return web.json_response({
                            "error": "Enterprise native readiness is unavailable.",
                            "code": "native_readiness_unavailable",
                        }, status=503)
                    return await _handler(request)
                handler = guarded_run
            routes.append((method, path, handler))
        return routes

    governed_routes._enterprise_policy = True
    governed_routes._enterprise_cloud_state = state
    APIServerAdapter._http_route_table = governed_routes


def install_native_model_policy(state):
    """Recheck managed readiness at every conversation-loop provider attempt.

    ``POST /v1/runs`` returns after scheduling a background executor, so its
    route guard cannot cover drift between acceptance and the first provider
    request (or between later tool/model iterations).  The pinned conversation
    loop resolves this module-global function for every retry and iteration.
    """
    from agent import conversation_loop

    current = conversation_loop.perform_api_call
    if getattr(current, "_enterprise_model_policy", False):
        current._enterprise_cloud_state = state
        return
    original = current

    @functools.wraps(original)
    def guarded_provider_call(*args, **kwargs):
        current_state = guarded_provider_call._enterprise_cloud_state
        agent = args[0] if args else kwargs.get("agent")
        if (current_state is not None
                and (agent is None or not current_state.ensure_provider_current(agent))):
            raise RuntimeError("Enterprise native readiness is unavailable.")
        return original(*args, **kwargs)

    guarded_provider_call._enterprise_model_policy = True
    guarded_provider_call._enterprise_cloud_state = state
    conversation_loop.perform_api_call = guarded_provider_call


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Enterprise skill manifest redirects are not allowed.")


_SECRET_CONFIG_KEYS = {
    "access_key", "api_key", "credential", "credentials", "password",
    "private_key", "secret", "token",
}


def _validate_skill_config(value, *, depth=0, path="skills.config"):
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


def load_enterprise_skills(base_url, token, opener=None, packages=None, plugin_root=None):
    """Fetch and bind the agent-scoped assignment to reviewed package bytes."""
    parsed = urllib.parse.urlsplit(base_url)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or (parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"})):
        raise RuntimeError("Enterprise skill manifest needs HTTPS or loopback HTTP.")
    request = urllib.request.Request(
        base_url.rstrip("/") + "/skills", method="GET",
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/json",
            "User-Agent": "Hermes-Enterprise-Bridge/1.0",
        },
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
    if not isinstance(skills, list) or not skills or len(skills) > 16:
        raise RuntimeError("Enterprise skill manifest has an invalid skill list.")
    available = packages or packaged_skills(plugin_root)
    auto_load, merged_config, manifests, bindings = [], {}, [], []
    for skill in skills:
        if not isinstance(skill, dict):
            raise RuntimeError("Enterprise skill manifest contains an invalid skill.")
        name, version, digest, config = (skill.get("name"), skill.get("version"),
                                         skill.get("artifact_digest"), skill.get("config"))
        if (not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+", name)
                or not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version)
                or not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest)
                or not isinstance(config, dict) or skill.get("auto_load") is not True):
            raise RuntimeError("Enterprise skill manifest contains invalid metadata.")
        package = available.get(name)
        if (package is None or package["version"] != version
                or package["artifact_digest"] != digest):
            raise RuntimeError("Enterprise skill manifest does not match the reviewed native package.")
        if name in auto_load:
            raise RuntimeError("Enterprise skill manifest contains a duplicate package.")
        _validate_skill_config(config)
        for key, value in config.items():
            if key in merged_config and merged_config[key] != value:
                raise RuntimeError("Enterprise skill configuration conflicts across packages.")
            merged_config[key] = value
        auto_load.append(name)
        manifests.append({"name": name, "version": version, "artifact_digest": digest})
        bindings.append({
            key: skill.get(key)
            for key in (
                "name", "runtime_name", "skill_key", "version", "artifact_digest",
                "state", "assignment_revision", "grant_revision", "binding_source",
                "binding_state", "grant_expires_at", "capability_grants",
            )
        })
    return {
        "auto_load": auto_load,
        "config": merged_config,
        "manifests": manifests,
        # The launcher remains compatible with older manifests. Managed Cloud
        # startup applies the stricter binding lifecycle contract to this copy.
        "bindings": bindings,
    }


def actual_skill_attestation(manager, manifests, plugin_root=None):
    """Verify assigned skill metadata and exact bytes through the live registry."""
    metadata = {item.get("name"): item for item in manager.list_plugin_skill_metadata()}
    packages = packaged_skills(plugin_root)
    actual = []
    for manifest in manifests:
        name = manifest["name"]
        package = packages.get(name)
        path = manager.find_plugin_skill(name)
        details = metadata.get(name)
        frontmatter = details.get("frontmatter") if isinstance(details, dict) else None
        if (package is None or package["version"] != manifest["version"]
                or package["artifact_digest"] != manifest["artifact_digest"]
                or path is None or not pathlib.Path(path).is_file() or pathlib.Path(path).is_symlink()
                or not isinstance(frontmatter, dict)
                or frontmatter.get("version") != manifest["version"]
                or frontmatter.get("artifact_digest") != manifest["artifact_digest"]
                or frontmatter.get("content_digest") != package["content_digest"]
                or sha256_file(pathlib.Path(path)) != package["content_digest"]):
            raise RuntimeError("Governed skill preflight found a stale or misbound package: " + name)
        actual.append({**manifest, "content_digest": package["content_digest"]})
    return actual


def _continuation_chunks(text, limit):
    """Split verified skill text at line boundaries into stripped chunks within *limit*."""
    chunks, current = [], ""
    for line in text.split("\n"):
        if len(line.strip()) > limit:
            raise RuntimeError("Enterprise skill line exceeds the native prompt section limit.")
        candidate = line if not current else current + "\n" + line
        if len(candidate.strip()) > limit:
            if current.strip():
                chunks.append(current.strip())
            current = line
        else:
            current = candidate
    if current.strip():
        chunks.append(current.strip())
    return chunks


def rendered_prompt_sections_length(sections):
    """Mirror the pinned runtime's framed length for its aggregate section budget."""
    blocks = [
        f"## Plugin Context: {section_id}\n<!-- hermes-plugin-section-chars:{len(text)} -->\n\n{text}"
        for section_id, text in sections
    ]
    return len(NATIVE_PROMPT_SECTIONS_START + "\n" + "\n\n".join(blocks) + "\n" + NATIVE_PROMPT_SECTIONS_END)


def build_skill_prompt_sections(manifests, plugin_root=None, packages=None):
    """Return ordered (section_id, text) pairs pinning only the assigned, verified skills.

    Each manifest must name a packaged skill whose version and reviewed
    ``artifact_digest`` match. The exact SKILL.md bytes are read again, bound to
    the package ``content_digest``, and only then split into continuation
    sections that fit the pinned runtime's per-section and aggregate limits.
    Any mismatch fails closed; nothing unverified is ever returned.
    """
    available = packages or packaged_skills(plugin_root)
    texts = []
    for manifest in manifests:
        name = manifest.get("name")
        package = available.get(name)
        if (package is None or package["version"] != manifest.get("version")
                or package["artifact_digest"] != manifest.get("artifact_digest")):
            raise RuntimeError(f"Assigned enterprise skill is not the reviewed package: {name}")
        path = pathlib.Path(package["path"])
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"Enterprise skill package is unavailable: {name}")
        raw = path.read_bytes()
        if "sha256:" + hashlib.sha256(raw).hexdigest() != package["content_digest"]:
            raise RuntimeError(f"Enterprise skill bytes changed after package verification: {name}")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise RuntimeError(f"Enterprise skill package is not UTF-8 text: {name}") from error
        if NATIVE_PROMPT_SECTIONS_START in text or NATIVE_PROMPT_SECTIONS_END in text:
            raise RuntimeError(f"Enterprise skill contains a reserved native prompt marker: {name}")
        chunks = _continuation_chunks(text, NATIVE_PROMPT_SECTION_MAX_CHARS)
        if not chunks:
            raise RuntimeError(f"Enterprise skill package is empty: {name}")
        texts.extend(chunks)
    if len(texts) > 99:
        raise RuntimeError("Assigned enterprise skills need too many native prompt sections.")
    sections = [(f"{SKILL_SECTION_ID_PREFIX}.{index:02d}", text) for index, text in enumerate(texts, 1)]
    if rendered_prompt_sections_length(sections) > NATIVE_PROMPT_SECTIONS_TOTAL_CHARS:
        raise RuntimeError("Assigned enterprise skills exceed the native prompt section budget.")
    return sections


def actual_skill_prompt_attestation(manager, expected_sections):
    """Prove the live plugin manager renders exactly the verified sections for a new session."""
    rendered = manager.render_system_prompt_sections({})
    actual = [(item.id, item.content, item.plugin, item.position) for item in rendered]
    expected = [(section_id, text, PLUGIN_NAME, NATIVE_PROMPT_SECTION_POSITION)
                for section_id, text in expected_sections]
    if actual != expected:
        raise RuntimeError("Governed skill prompt sections differ from the verified assignment.")
    return [section_id for section_id, _ in expected_sections]


def actual_plugin_attestation(manager):
    matches = [item for item in manager.list_plugins() if item.get("name") == PLUGIN_NAME]
    if (len(matches) != 1 or matches[0].get("version") != PLUGIN_VERSION
            or matches[0].get("enabled") is not True or matches[0].get("error") is not None):
        raise RuntimeError("Governed plugin preflight found a stale or unavailable Enterprise bridge.")
    return {"name": matches[0]["name"], "version": matches[0]["version"]}


def write_runtime_attestation(home, metadata, plugin, skills, tool_names):
    attestation = {
        "schema_version": 1,
        "runtime_revision": RUNTIME_REVISION,
        "plugin": plugin,
        "workspace_id": metadata["workspace_id"],
        "agent_id": metadata["agent_id"],
        "enterprise_url": metadata["enterprise_url"],
        "skills": skills,
        "tools": sorted(tool_names),
        "agentcash_enabled": bool(metadata.get("agentcash_enabled")),
        "native_cron_disabled": not bool(metadata.get("native_cron_enabled")),
    }
    if metadata.get("managed_cloud") is True:
        attestation["managed_cloud"] = True
        attestation["boot_id"] = metadata["boot_id"]
    private_write(pathlib.Path(home) / RUNTIME_READINESS_FILENAME,
                  json.dumps(attestation, indent=2, sort_keys=True) + "\n")
    return attestation


def sha256_path(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def plugin_tree_digest(plugin_root):
    """Hash every immutable plugin file with unambiguous path/content framing."""
    root = pathlib.Path(plugin_root)
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError("Managed Enterprise plugin directory is unavailable")
    digest = hashlib.sha256()
    found = False
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root)
        if "__pycache__" in relative.parts or path.suffix in {".pyc", ".pyo"}:
            continue
        if path.is_symlink():
            raise RuntimeError("Managed Enterprise plugin tree contains a symlink")
        if not path.is_file():
            continue
        found = True
        name = relative.as_posix().encode()
        content = path.read_bytes()
        digest.update(len(name).to_bytes(4, "big"))
        digest.update(name)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    if not found:
        raise RuntimeError("Managed Enterprise plugin tree is empty")
    return "sha256:" + digest.hexdigest()


def validate_managed_plugin_source(plugin_root, home=None):
    """Bind install provenance to the exact installed plugin bytes."""
    root = pathlib.Path(plugin_root)
    hermes_home = pathlib.Path(home or os.environ.get("HERMES_HOME", ""))
    expected_root = hermes_home / "plugins" / PLUGIN_NAME
    revision = os.environ.get("HERMES_ENTERPRISE_PLUGIN_REVISION", "").strip().lower()
    expected_digest = os.environ.get("HERMES_ENTERPRISE_PLUGIN_SHA256", "").strip().lower()
    if (not hermes_home.is_absolute()
            or not re.fullmatch(r"[0-9a-f]{40}", revision)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_digest)):
        raise RuntimeError("Managed Enterprise plugin source binding is missing")
    try:
        if (expected_root.is_symlink() or root.resolve() != expected_root.resolve()
                or not expected_root.is_dir()):
            raise RuntimeError("Managed Enterprise plugin path is misbound")
    except OSError as error:
        raise RuntimeError("Managed Enterprise plugin path is unavailable") from error
    metadata_path = hermes_home / "plugins" / ".install-metadata.json"
    try:
        if (metadata_path.is_symlink() or not metadata_path.is_file()
                or metadata_path.stat().st_size > 65536):
            raise RuntimeError("Managed Enterprise plugin install metadata is unavailable")
        metadata = json.loads(metadata_path.read_bytes())
    except (OSError, ValueError, UnicodeDecodeError) as error:
        raise RuntimeError("Managed Enterprise plugin install metadata is invalid") from error
    record = metadata.get(PLUGIN_NAME) if isinstance(metadata, dict) else None
    if (not isinstance(record, dict)
            or set(record) != {"pinned", "revision", "source"}
            or record.get("pinned") is not True
            or record.get("revision") != revision
            or record.get("source") not in EXPECTED_PLUGIN_SOURCES):
        raise RuntimeError("Managed Enterprise plugin was not installed from the pinned source")
    actual_digest = plugin_tree_digest(expected_root)
    if actual_digest != expected_digest:
        raise RuntimeError("Managed Enterprise plugin bytes differ from the reviewed artifact")
    return {
        "revision": revision,
        "artifact_digest": actual_digest,
        "source": record["source"],
    }
