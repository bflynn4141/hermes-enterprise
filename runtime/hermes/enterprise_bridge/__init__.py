"""A narrow native Hermes plugin. The official AIAgent owns the complete agent loop."""

import json
import logging
import os
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from .packages import packaged_skills
from .runtime_policy import build_skill_prompt_sections, load_enterprise_skills

TOOLSET = "enterprise_bridge"
MAX_BODY_BYTES = 2 * 1024 * 1024
CONTROL_ROUTE = "/api/plugins/enterprise_bridge/control"
CONTROL_PROVIDER = "enterprise-control"
SERVICE_USER_AGENT = "Hermes-Enterprise-Bridge/1.0"
MCP_COMPONENT = re.compile(r"[^A-Za-z0-9_]")
TOOL_CALL_ID = re.compile(r"[A-Za-z0-9_.:-]{1,128}\Z")
AGENTCASH_PEOPLE_SEARCH_URL = "https://stableenrich.dev/api/fullenrich/people-search"
AGENTCASH_CREATOR_SEARCH_URL = "https://stableenrich.dev/api/exa/search"
AGENTCASH_X_CREATOR_SEARCH_URL = "https://fetcher.sh/api/twitter/search?query=%22Hermes%20Agent%22&sort=Top"
AGENTCASH_CONTACT_ENRICH_URL = "https://stableenrich.dev/api/minerva/enrich"
AGENTCASH_EMAIL_VERIFY_URL = "https://stableenrich.dev/api/hunter/email-verifier"
CONTACT_RETURN_FIELDS = ["full_name", "linkedin_url", "professional_emails", "phones", "twitter_url", "facebook_url"]
AGENTCASH_CREATOR_SEARCH_ARGUMENTS = {
    "url": AGENTCASH_CREATOR_SEARCH_URL,
    "method": "POST",
    "maxAmount": 0.01,
    "body": {
        "query": '"Hermes Agent" "Nous Research" consultant creator tutorial implementation',
        "includeDomains": ["linkedin.com", "www.linkedin.com", "youtube.com", "www.youtube.com"],
        "numResults": 10,
        "type": "auto",
        "contents": {
            "summary": {
                "query": "Identify the person or channel and concise public evidence that they teach, implement, advise on, or consult about Nous Research Hermes Agent."
            },
            "highlights": {"query": "Hermes Agent consulting implementation tutorial", "maxCharacters": 600},
            "text": {"maxCharacters": 1500, "verbosity": "compact", "includeSections": ["body", "metadata"]},
            "livecrawl": "fallback",
            "maxAgeHours": 72,
            "extras": {"links": 10},
        },
    },
}
AGENTCASH_X_CREATOR_SEARCH_ARGUMENTS = {
    "url": AGENTCASH_X_CREATOR_SEARCH_URL,
    "method": "GET",
    "maxAmount": 0.005,
}


def is_creator_search_arguments(arguments):
    return arguments in (AGENTCASH_CREATOR_SEARCH_ARGUMENTS,
                         AGENTCASH_X_CREATOR_SEARCH_ARGUMENTS)


def approved_agentcash_arguments(program):
    """Build the one paid request from Worker-supplied, non-secret policy."""
    if not isinstance(program, dict) or program.get("source") != "agentcash_people":
        return None
    people = program.get("people_search")
    if not isinstance(people, dict) or program.get("max_spend_usd") != 0.15:
        return None
    body = {}
    for key in ("current_position_seniority_level", "person_skills",
                "current_position_titles", "person_locations"):
        value = people.get(key, [])
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            return None
        if value:
            body[key] = value
    if not body:
        return None
    body.update({
        "excludeFields": ["educations", "languages"],
        "include_employment_history": False,
        "verbose": False,
        "offset": 0,
    })
    return {"url": AGENTCASH_PEOPLE_SEARCH_URL, "method": "POST", "maxAmount": 0.15, "body": body}


def agentcash_contact_call_kind(arguments):
    """Syntactically narrow contact calls before authoritative Worker admission."""
    if not isinstance(arguments, dict):
        return None
    url, method, maximum = arguments.get("url"), arguments.get("method"), arguments.get("maxAmount")
    body = arguments.get("body")
    if url == AGENTCASH_CONTACT_ENRICH_URL and method == "POST" and maximum == 0.05:
        records = body.get("records") if isinstance(body, dict) else None
        if (isinstance(records, list) and len(records) == 1 and isinstance(records[0], dict)
                and re.fullmatch(r"[0-9a-f-]{36}", str(records[0].get("record_id", "")), re.I)
                and isinstance(records[0].get("linkedin_url"), str)
                and body.get("return_fields") == CONTACT_RETURN_FIELDS
                and set(body) == {"records", "return_fields"}):
            return "enrichment"
    if url == AGENTCASH_EMAIL_VERIFY_URL and method == "POST" and maximum == 0.03:
        if (isinstance(body, dict) and set(body) == {"email"}
                and isinstance(body.get("email"), str) and 3 <= len(body["email"]) <= 320):
            return "verification"
    if method == "GET" and maximum == 0.03 and "body" not in arguments and isinstance(url, str):
        try:
            parsed = urllib.parse.urlsplit(url)
        except ValueError:
            parsed = None
        if (parsed and parsed.scheme == "https" and parsed.hostname == "stableenrich.dev"
                and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
                and re.fullmatch(r"/api/hunter/email-verifier/jobs/[A-Za-z0-9_-]{1,160}", parsed.path)):
            return "verification_poll"
    return None


class BridgeError(Exception):
    """Only safe, fixed messages cross the model-visible boundary."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BridgeError("Enterprise bridge redirects are not allowed.")


def assess_control_secret(secret):
    """Require the same practical floor as Hermes' built-in drain credential."""
    if len(secret) < 43:
        return "control secret must contain at least 43 characters"
    if len(set(secret)) < 16:
        return "control secret must contain at least 16 distinct characters"
    return None


def register_control_auth(ctx):
    """Opt one fixed dashboard route into non-interactive service auth.

    The public Hermes Cloud hostname exposes the dashboard gateway, while the
    native Runs API listens on loopback.  This provider authenticates the
    Worker's per-agent credential only on the fixed connector route; it never
    grants bearer access to the rest of the dashboard.
    """
    secret = os.environ.get("HERMES_ENTERPRISE_CONTROL_SECRET", "").strip()
    if not secret:
        return None
    reason = assess_control_secret(secret)
    if reason:
        raise BridgeError(reason)

    import hmac
    from hermes_cli.dashboard_auth import DashboardAuthProvider, LoginStart, Session, TokenPrincipal
    from hermes_cli.dashboard_auth.token_auth import register_token_route

    class EnterpriseControlProvider(DashboardAuthProvider):
        name = CONTROL_PROVIDER
        display_name = "Hermes Enterprise control plane"
        supports_token = True
        supports_session = False

        def verify_token(self, *, token):
            if token and hmac.compare_digest(token.encode(), secret.encode()):
                return TokenPrincipal(
                    principal="hermes-enterprise-control",
                    provider=self.name,
                    scopes=("runs",),
                )
            return None

        def start_login(self, *, redirect_uri):
            raise NotImplementedError("This provider accepts service credentials only.")

        def complete_login(self, *, code, state, code_verifier, redirect_uri):
            raise NotImplementedError("This provider accepts service credentials only.")

        def verify_session(self, *, access_token):
            return None

        def refresh_session(self, *, refresh_token):
            raise NotImplementedError("This provider accepts service credentials only.")

        def revoke_session(self, *, refresh_token):
            return None

    handle = ctx.register_dashboard_auth_provider(EnterpriseControlProvider())
    if handle is None:
        raise BridgeError("Enterprise control authentication could not be registered.")
    register_token_route(CONTROL_ROUTE)
    return handle


def trusted_identity():
    # Pinned Hermes internals: there are no public context-only getters for both IDs.
    # Do not replace with os.getenv or get_current_session_key's env fallback.
    from tools.approval_context import _approval_session_key, _approval_tool_call_id
    from gateway.session_context import get_session_env

    run_id = _approval_session_key.get()
    call_id = _approval_tool_call_id.get()
    if (get_session_env("HERMES_SESSION_PLATFORM") != "api_server"
            or not re.fullmatch(r"run_[0-9a-f]{32}", run_id or "")
            or not isinstance(call_id, str) or not call_id or len(call_id) > 256):
        raise BridgeError("Enterprise tools require a trusted native run and tool call.")
    return run_id, call_id


def trusted_hook_identity(tool_call_id):
    """Bind a runtime hook callback to the native run without model input."""
    from tools.approval_context import _approval_session_key
    from gateway.session_context import get_session_env

    run_id = _approval_session_key.get()
    if (get_session_env("HERMES_SESSION_PLATFORM") != "api_server"
            or not re.fullmatch(r"run_[0-9a-f]{32}", run_id or "")
            or not isinstance(tool_call_id, str) or not tool_call_id
            or len(tool_call_id) > 256):
        raise BridgeError("AgentCash requires a trusted native run and tool call.")
    return run_id, tool_call_id


class Bridge:
    def __init__(self, base_url, token, native_url, native_token, *, request_timeout=5.0,
                 pending_timeout=86400.0):
        parsed = urllib.parse.urlsplit(base_url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or (parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"})):
            raise BridgeError("Enterprise bridge needs HTTPS or a loopback HTTP URL.")
        if not token or not native_token:
            raise BridgeError("Enterprise runtime credentials are missing.")
        self.base_url, self.token = base_url.rstrip("/"), token
        self.native_url, self.native_token = native_url.rstrip("/"), native_token
        self.request_timeout = min(5.0, max(0.1, float(request_timeout)))
        self.pending_timeout = max(1.0, float(pending_timeout))
        self.opener = urllib.request.build_opener(NoRedirect, urllib.request.ProxyHandler({}))

    def request(self, method, url, token, body=None, *, timeout=None):
        data = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
        request = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "Bearer " + token, "Content-Type": "application/json",
            "Accept": "application/json", "User-Agent": SERVICE_USER_AGENT,
        })
        try:
            response = self.opener.open(
                request,
                timeout=self.request_timeout if timeout is None else min(25.0, max(0.1, float(timeout))),
            )
        except urllib.error.HTTPError as error:
            response = error
        except (OSError, urllib.error.URLError, TimeoutError) as error:
            # Never repeat a possibly executed write after a transport failure.
            raise BridgeError("Enterprise bridge transport failed; the outcome may be unknown. Do not repeat the operation.") from error
        with response:
            raw = response.read(MAX_BODY_BYTES + 1)
            if len(raw) > MAX_BODY_BYTES:
                raise BridgeError("Enterprise bridge response exceeded its limit.")
            try:
                return response.code, json.loads(raw)
            except (ValueError, UnicodeDecodeError) as error:
                raise BridgeError("Enterprise bridge returned invalid JSON.") from error

    def tools(self):
        status, body = self.request("GET", self.base_url + "/tools", self.token)
        if status != 200 or not isinstance(body, dict) or not isinstance(body.get("tools"), list):
            raise BridgeError("Enterprise tool discovery failed.")
        result, names = [], set()
        for item in body["tools"]:
            tool = item.get("function", item) if isinstance(item, dict) else {}
            name = tool.get("name", "")
            if (not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,63}", name)
                    or name in names or not isinstance(tool.get("parameters"), dict)):
                raise BridgeError("Enterprise tool discovery returned an invalid schema.")
            names.add(name)
            result.append({"name": name, "description": str(tool.get("description", "")),
                           "parameters": tool["parameters"]})
        return result

    def ensure_running(self, run_id):
        status, body = self.request("GET", self.native_url + "/v1/runs/" + run_id, self.native_token)
        if status != 200 or body.get("status") not in {"running", "waiting_for_approval"}:
            raise BridgeError("The native run is stopping or no longer active.")

    def call(self, name, arguments):
        run_id, call_id = trusted_identity()
        # Runtime/workspace/agent identity is never extracted from model arguments.
        payload = {"runtime_run_id": run_id, "tool_call_id": call_id,
                   "name": name, "arguments": arguments}
        started = time.monotonic()
        while True:
            self.ensure_running(run_id)
            status, body = self.request("POST", self.base_url + "/calls", self.token, payload)
            if not isinstance(body, dict):
                raise BridgeError("Enterprise bridge returned an invalid result.")
            if status == 409 and body.get("reason") == "mapping_pending":
                if time.monotonic() - started >= 5.0:
                    raise BridgeError("Enterprise run registration is still pending.")
            elif status == 202 and body.get("status") == "pending":
                if time.monotonic() - started >= self.pending_timeout:
                    raise BridgeError("Enterprise tool wait expired.")
            elif status == 200 and isinstance(body.get("content"), str):
                if body.get("ok") is True:
                    return body["content"]
                return json.dumps({"error": body["content"]})
            elif status == 409 and body.get("reason") == "stopped":
                raise BridgeError("The enterprise run was stopped.")
            else:
                raise BridgeError("Enterprise tool request was rejected.")
            # Retrying these explicit NOT-EXECUTED/pending responses is safe. The
            # bridge must reserve (agent, runtime_run_id, tool_call_id) atomically.
            time.sleep(0.25)

    def handler(self, name):
        def invoke(arguments, **kwargs):
            try:
                if not isinstance(arguments, dict):
                    raise BridgeError("Enterprise tool arguments must be an object.")
                return self.call(name, arguments)
            except BridgeError as error:
                return json.dumps({"error": str(error)})
            except Exception:
                return json.dumps({"error": "Enterprise tool failed closed."})
        return invoke

    def import_people_search(self, run_id, tool_call_id, arguments, result):
        """Forward one successful paid response to the tenant-bound evidence importer."""
        if not isinstance(result, (str, dict, list)):
            raise BridgeError("AgentCash People Search returned an unsupported result.")
        status, body = self.request(
            "POST", self.base_url + "/agentcash/people-search/import", self.token,
            {
                "runtime_run_id": run_id,
                "tool_call_id": tool_call_id,
                "arguments": arguments,
                "result": result,
            }, timeout=25.0,
        )
        if status not in {200, 201} or not isinstance(body, dict) or body.get("ok") is not True:
            reason = body.get("reason") if isinstance(body, dict) else None
            safe_reason = reason if isinstance(reason, str) and re.fullmatch(r"[a-z0-9_:-]{1,80}", reason) else None
            detail = f"{status} {safe_reason}" if safe_reason else str(status)
            raise BridgeError(f"AgentCash People Search evidence import failed ({detail}).")
        return body

    def recover_pending_people_search(self, expected_arguments):
        """Replay one already-paid spill file; never issues a source request."""
        status, pending = self.request(
            "GET", self.base_url + "/agentcash/people-search/pending", self.token,
            timeout=25.0,
        )
        if status == 204:
            return None
        if status != 200 or not isinstance(pending, dict):
            raise BridgeError("AgentCash pending import lookup failed.")
        run_id = pending.get("runtime_run_id")
        tool_call_id = pending.get("tool_call_id")
        arguments = pending.get("arguments")
        if (not isinstance(run_id, str) or not re.fullmatch(r"run_[0-9a-f]{32}", run_id)
                or not isinstance(tool_call_id, str) or not TOOL_CALL_ID.fullmatch(tool_call_id)
                or arguments != expected_arguments):
            raise BridgeError("AgentCash pending import identity was rejected.")
        home = pathlib.Path(os.environ.get("HERMES_HOME", "/opt/data")).resolve()
        spill_dir = (home / "cache" / "spillover").resolve()
        spill_path = spill_dir / (tool_call_id + ".txt")
        try:
            stat = spill_path.lstat()
        except OSError as error:
            raise BridgeError("AgentCash pending result is not available in spill storage.") from error
        if spill_path.is_symlink() or not spill_path.is_file() or stat.st_size > MAX_BODY_BYTES:
            raise BridgeError("AgentCash pending result failed spill storage validation.")
        try:
            result = spill_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            raise BridgeError("AgentCash pending result could not be read safely.") from error
        return self.import_people_search(run_id, tool_call_id, arguments, result)

    def authorize_people_search(self, run_id, tool_call_id, arguments):
        """Reserve the run's only paid request before the wallet is touched."""
        status, body = self.request(
            "POST", self.base_url + "/agentcash/people-search/authorize", self.token,
            {
                "runtime_run_id": run_id,
                "tool_call_id": tool_call_id,
                "arguments": arguments,
            },
        )
        if status not in {200, 201} or not isinstance(body, dict) or body.get("ok") is not True:
            raise BridgeError("AgentCash payment authorization was rejected.")
        return body

    def authorize_creator_search(self, run_id, tool_call_id, arguments):
        """Reserve one user-requested public creator search before payment."""
        status, body = self.request(
            "POST", self.base_url + "/agentcash/creator-search/authorize", self.token,
            {"runtime_run_id": run_id, "tool_call_id": tool_call_id, "arguments": arguments},
        )
        if status not in {200, 201} or not isinstance(body, dict) or body.get("ok") is not True:
            reason = body.get("reason") if isinstance(body, dict) else None
            safe_reason = reason if isinstance(reason, str) and re.fullmatch(r"[a-z0-9_:-]{1,80}", reason) else None
            detail = f"{status} {safe_reason}" if safe_reason else str(status)
            raise BridgeError(f"AgentCash creator-search authorization was rejected ({detail}).")
        return body

    def import_creator_search(self, run_id, tool_call_id, arguments, result):
        if not isinstance(result, (str, dict, list)):
            raise BridgeError("AgentCash creator search returned an unsupported result.")
        status, body = self.request(
            "POST", self.base_url + "/agentcash/creator-search/import", self.token,
            {"runtime_run_id": run_id, "tool_call_id": tool_call_id,
             "arguments": arguments, "result": result}, timeout=25.0,
        )
        if status not in {200, 201} or not isinstance(body, dict) or body.get("ok") is not True:
            raise BridgeError("AgentCash creator evidence import failed.")
        return body

    def recover_pending_creator_search(self):
        """Replay one already-paid creator result; never issues a source request."""
        status, pending = self.request(
            "GET", self.base_url + "/agentcash/creator-search/pending", self.token, timeout=25.0,
        )
        if status == 204:
            return None
        if status != 200 or not isinstance(pending, dict):
            raise BridgeError("AgentCash pending creator import lookup failed.")
        run_id, tool_call_id, arguments = (pending.get("runtime_run_id"),
                                            pending.get("tool_call_id"), pending.get("arguments"))
        if (not isinstance(run_id, str) or not re.fullmatch(r"run_[0-9a-f]{32}", run_id)
                or not isinstance(tool_call_id, str) or not TOOL_CALL_ID.fullmatch(tool_call_id)
                or not is_creator_search_arguments(arguments)):
            raise BridgeError("AgentCash pending creator import identity was rejected.")
        home = pathlib.Path(os.environ.get("HERMES_HOME", "/opt/data")).resolve()
        spill_path = (home / "cache" / "spillover" / (tool_call_id + ".txt")).resolve()
        try:
            stat = spill_path.lstat()
        except OSError as error:
            raise BridgeError("AgentCash pending creator result is not available in spill storage.") from error
        if spill_path.is_symlink() or not spill_path.is_file() or stat.st_size > MAX_BODY_BYTES:
            raise BridgeError("AgentCash pending creator result failed spill storage validation.")
        try:
            result = spill_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            raise BridgeError("AgentCash pending creator result could not be read safely.") from error
        return self.import_creator_search(run_id, tool_call_id, arguments, result)

    def authorize_contact(self, run_id, tool_call_id, arguments):
        """Reserve the run-bound contact step before AgentCash is reached."""
        status, body = self.request(
            "POST", self.base_url + "/agentcash/contact/authorize", self.token,
            {"runtime_run_id": run_id, "tool_call_id": tool_call_id, "arguments": arguments},
        )
        if status not in {200, 201} or not isinstance(body, dict) or body.get("ok") is not True:
            raise BridgeError("AgentCash contact authorization was rejected.")
        return body

    def import_contact(self, run_id, tool_call_id, arguments, result):
        if not isinstance(result, (str, dict, list)):
            raise BridgeError("AgentCash contact lookup returned an unsupported result.")
        status, body = self.request(
            "POST", self.base_url + "/agentcash/contact/import", self.token,
            {"runtime_run_id": run_id, "tool_call_id": tool_call_id,
             "arguments": arguments, "result": result}, timeout=25.0,
        )
        if status not in {200, 201} or not isinstance(body, dict) or body.get("ok") is not True:
            raise BridgeError("AgentCash contact evidence import failed.")
        return body

    def recover_pending_contacts(self):
        """Replay already-paid contact spill files without issuing source calls."""
        status, body = self.request(
            "GET", self.base_url + "/agentcash/contact/pending", self.token, timeout=25.0,
        )
        if status != 200 or not isinstance(body, dict) or not isinstance(body.get("pending"), list):
            raise BridgeError("AgentCash pending contact lookup failed.")
        home = pathlib.Path(os.environ.get("HERMES_HOME", "/opt/data")).resolve()
        spill_dir = (home / "cache" / "spillover").resolve()
        imported = []
        for pending in body["pending"]:
            if not isinstance(pending, dict):
                raise BridgeError("AgentCash pending contact identity was rejected.")
            run_id, tool_call_id, arguments = (pending.get("runtime_run_id"),
                                                pending.get("tool_call_id"), pending.get("arguments"))
            if (not isinstance(run_id, str) or not re.fullmatch(r"run_[0-9a-f]{32}", run_id)
                    or not isinstance(tool_call_id, str) or not TOOL_CALL_ID.fullmatch(tool_call_id)
                    or agentcash_contact_call_kind(arguments) is None):
                raise BridgeError("AgentCash pending contact identity was rejected.")
            spill_path = spill_dir / (tool_call_id + ".txt")
            try:
                stat = spill_path.lstat()
            except OSError as error:
                raise BridgeError("AgentCash pending contact result is not available in spill storage.") from error
            if spill_path.is_symlink() or not spill_path.is_file() or stat.st_size > MAX_BODY_BYTES:
                raise BridgeError("AgentCash pending contact result failed spill storage validation.")
            try:
                result = spill_path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as error:
                raise BridgeError("AgentCash pending contact result could not be read safely.") from error
            imported.append(self.import_contact(run_id, tool_call_id, arguments, result))
        return imported


def register(ctx):
    # Managed Cloud startup installs the non-disposable native admission gate
    # before control auth, network discovery, or any context-owned hook that
    # Hermes would dispose after a caught register() failure.
    managed_state = None
    if os.environ.get("HERMES_ENTERPRISE_CLOUD_MANAGED", "").strip().lower() in {"1", "true", "yes", "on"}:
        from .cloud_managed import begin_managed_startup, is_gateway_process
        if is_gateway_process():
            managed_state = begin_managed_startup()
    if managed_state is not None:
        from .cloud_managed import install_enterprise_reader_toolset
        install_enterprise_reader_toolset()

    # Register the Cloud control surface before tool discovery. If the Worker is
    # temporarily unavailable, dashboard startup still leaves the route either
    # strongly authenticated or absent; it never falls open.
    control_auth = register_control_auth(ctx)
    if managed_state is not None and control_auth is None:
        raise BridgeError("Cloud-managed Enterprise control authentication is unavailable.")
    bridge = Bridge(
        ctx.get_config("base_url", ""), os.environ.get("ENTERPRISE_RUNTIME_TOKEN", ""),
        ctx.get_config("native_url", "http://127.0.0.1:8642"), os.environ.get("API_SERVER_KEY", ""),
        request_timeout=ctx.get_config("request_timeout_seconds", 5),
        pending_timeout=ctx.get_config("pending_timeout_seconds", 86400),
    )
    # The authenticated assignment is the only authority for which skills this
    # profile may view and which skill text is pinned into every new session.
    # Configured settings may restate it but never widen or replace it.
    plugin_root = pathlib.Path(__file__).parent
    try:
        assignment = load_enterprise_skills(bridge.base_url, bridge.token, plugin_root=plugin_root)
    except RuntimeError as error:
        raise BridgeError(str(error)) from error
    configured_skills = ctx.get_config("allowed_skills", [])
    if configured_skills and list(configured_skills) != assignment["auto_load"]:
        raise BridgeError("Configured allowed skills differ from the authenticated Enterprise assignment.")
    assigned_skills = set(assignment["auto_load"])
    assigned_program = assignment["config"].get("partner_program")
    assigned_program = assigned_program if isinstance(assigned_program, dict) else {}
    partner_program = ctx.get_config("partner_program", {})
    if not isinstance(partner_program, dict) or not partner_program:
        partner_program = assigned_program
    elif partner_program != assigned_program:
        raise BridgeError("Partner Program policy differs from the authenticated Enterprise assignment.")
    # Hermes 0.21.3 has no skills.auto_load. The pinned plugin API freezes
    # registered sections into each new session's system prompt before the
    # first model call, so the verified SKILL.md text is pinned here. Only this
    # plugin is enabled in a governed profile; the launcher and managed Cloud
    # validator compare the live render with the same verified sections.
    for section_id, text in build_skill_prompt_sections(assignment["manifests"], plugin_root):
        ctx.register_system_prompt_section(section_id, text)
    agentcash_arguments = approved_agentcash_arguments(partner_program)
    allowed = {"skill_view"}
    configured_mcp_policy = ctx.get_config("mcp_policy", [])
    if not configured_mcp_policy and os.environ.get("HERMES_AGENTCASH_MCP_ENABLED") == "1":
        configured_mcp_policy = [{
            "server": "agentcash", "tools": ["fetch"],
            "allowed_hosts": ["stableenrich.dev", "fetcher.sh"], "max_amount_usd": 0.15,
        }]
    mcp_policy = {}
    for item in configured_mcp_policy:
        if not isinstance(item, dict):
            continue
        server = MCP_COMPONENT.sub("_", str(item.get("server", "")))
        tools = item.get("tools") if isinstance(item.get("tools"), list) else []
        hosts = item.get("allowed_hosts") if isinstance(item.get("allowed_hosts"), list) else []
        maximum = item.get("max_amount_usd", 0)
        for tool in tools:
            normalized = MCP_COMPONENT.sub("_", str(tool))
            if server and normalized:
                mcp_policy[f"mcp__{server}__{normalized}"] = {
                    "allowed_hosts": frozenset(str(host).lower() for host in hosts),
                    "max_amount_usd": float(maximum) if isinstance(maximum, (int, float)) else 0,
                    "original_tool": str(tool),
                }

    def validate_mcp_call(tool_name, args):
        policy = mcp_policy.get(tool_name)
        if policy is None:
            return {"action": "block", "message": "This MCP tool is not in the enterprise allowlist."}
        args = args if isinstance(args, dict) else {}
        if (tool_name == "mcp__agentcash__fetch" and args != agentcash_arguments
                and not is_creator_search_arguments(args)
                and agentcash_contact_call_kind(args) is None):
            return {"action": "block", "message": "Only the exact approved Partner Program AgentCash requests are allowed."}
        if "url" in args:
            try:
                parsed = urllib.parse.urlsplit(args["url"])
            except (TypeError, ValueError):
                parsed = None
            if (parsed is None or parsed.scheme != "https" or not parsed.hostname
                    or parsed.username or parsed.password or parsed.fragment
                    or parsed.hostname.lower() not in policy["allowed_hosts"]):
                return {"action": "block", "message": "This MCP URL is outside the enterprise host allowlist."}
        if policy["original_tool"] == "fetch":
            amount = args.get("maxAmount")
            if (not isinstance(amount, (int, float)) or amount <= 0
                    or amount > policy["max_amount_usd"]):
                return {"action": "block", "message": "Set maxAmount within the enterprise per-call spend cap."}
            body = args.get("body")
            if body is not None and len(json.dumps(body, separators=(",", ":"))) > 20_000:
                return {"action": "block", "message": "This MCP request body exceeds the enterprise limit."}
        return None

    def guard(tool_name, args=None, tool_call_id="", **kwargs):
        if managed_state is not None and not managed_state.ensure_current():
            return {"action": "block", "message": "Enterprise native readiness is unavailable."}
        if tool_name == "skill_view":
            args = args if isinstance(args, dict) else {}
            if (args.get("name") in assigned_skills
                    and not args.get("file_path")
                    and set(args).issubset({"name", "preprocess"})):
                return None
            return {"action": "block", "message": "Only the assigned managed skill can be viewed."}
        if tool_name.startswith("mcp__"):
            decision = validate_mcp_call(tool_name, args)
            if decision is not None:
                return decision
            if tool_name == "mcp__agentcash__fetch":
                try:
                    run_id, call_id = trusted_hook_identity(tool_call_id)
                    if args == agentcash_arguments:
                        bridge.authorize_people_search(run_id, call_id, args)
                    elif is_creator_search_arguments(args):
                        bridge.authorize_creator_search(run_id, call_id, args)
                    else:
                        bridge.authorize_contact(run_id, call_id, args)
                except BridgeError as error:
                    logging.warning("AgentCash payment authorization failed: %s", error)
                    return {"action": "block", "message": "AgentCash payment authorization failed closed."}
                except Exception:
                    logging.warning("AgentCash payment authorization failed: unexpected error.")
                    return {"action": "block", "message": "AgentCash payment authorization failed closed."}
            return None
        if tool_name not in allowed:
            return {"action": "block", "message": "Only governed enterprise tools are enabled in this profile."}

    def import_agentcash_result(tool_name="", args=None, result=None, tool_call_id="", **_kwargs):
        # Observer hooks are deliberately exact: the pre-hook already blocked
        # every other AgentCash call and reserved this tool-call id before pay.
        if tool_name != "mcp__agentcash__fetch" or not isinstance(args, dict):
            return None
        try:
            run_id, trusted_call_id = trusted_hook_identity(tool_call_id)
            if args == agentcash_arguments:
                bridge.import_people_search(run_id, trusted_call_id, args, result)
            elif is_creator_search_arguments(args):
                bridge.import_creator_search(run_id, trusted_call_id, args, result)
            elif agentcash_contact_call_kind(args) is not None:
                bridge.import_contact(run_id, trusted_call_id, args, result)
        except Exception:
            # post_tool_call is observational and must never mutate the model's
            # original tool result. The managed skill verifies import by listing
            # stored candidates and stops if none appear.
            return None
        return None

    ctx.register_hook("post_tool_call", import_agentcash_result)
    ctx.register_hook("pre_tool_call", guard)
    for package in packaged_skills(pathlib.Path(__file__).parent).values():
        ctx.register_skill(
            name=package["bare_name"],
            path=package["path"],
            description=package["description"],
            frontmatter={
                "version": package["version"],
                "artifact_digest": package["artifact_digest"],
                "content_digest": package["content_digest"],
                "metadata": {"hermes": {"category": "enterprise"}},
            },
        )
    enterprise_tool_names = set()
    for schema in bridge.tools():
        name = schema["name"]
        handle = ctx.register_tool(name=name, toolset=TOOLSET, schema=schema,
                                   handler=bridge.handler(name))
        if handle is None:
            raise BridgeError("An enterprise tool conflicts with another runtime tool.")
        allowed.add(name)
        enterprise_tool_names.add(name)
    spill_root = pathlib.Path(os.environ.get("HERMES_HOME", "/opt/data")) / "cache" / "spillover"
    if managed_state is None and agentcash_arguments is not None and spill_root.is_dir():
        try:
            bridge.recover_pending_people_search(agentcash_arguments)
        except BridgeError as error:
            # The ordinary post-tool observer remains the primary path. A
            # restart recovery failure must not make the governed profile
            # unavailable or risk another paid request.
            logging.warning("AgentCash pending evidence recovery did not complete: %s", error)
        except Exception:
            logging.warning("AgentCash pending evidence recovery did not complete: unexpected error.")
        try:
            bridge.recover_pending_contacts()
        except BridgeError as error:
            logging.warning("AgentCash pending contact recovery did not complete: %s", error)
        except Exception:
            logging.warning("AgentCash pending contact recovery did not complete: unexpected error.")
        try:
            bridge.recover_pending_creator_search()
        except BridgeError as error:
            logging.warning("AgentCash pending creator recovery did not complete: %s", error)
        except Exception:
            logging.warning("AgentCash pending creator recovery did not complete: unexpected error.")
    if managed_state is not None:
        from .cloud_managed import start_initializer
        start_initializer({
            "base_url": ctx.get_config("base_url", ""),
            "native_url": ctx.get_config("native_url", "http://127.0.0.1:8642"),
            "allowed_skills": ctx.get_config("allowed_skills", []),
            "mcp_policy": ctx.get_config("mcp_policy", []),
            "partner_program": ctx.get_config("partner_program", {}),
        }, managed_state, enterprise_tool_names)
