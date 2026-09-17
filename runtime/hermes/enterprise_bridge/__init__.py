"""A narrow native Hermes plugin. The official AIAgent owns the complete agent loop."""

import json
import os
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request

TOOLSET = "enterprise_bridge"
MAX_BODY_BYTES = 2 * 1024 * 1024
CONTROL_ROUTE = "/api/plugins/enterprise_bridge/control"
CONTROL_PROVIDER = "enterprise-control"
SERVICE_USER_AGENT = "Hermes-Enterprise-Bridge/1.0"
MCP_COMPONENT = re.compile(r"[^A-Za-z0-9_]")
AGENTCASH_PEOPLE_SEARCH_URL = "https://stableenrich.dev/api/fullenrich/people-search"


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

    def request(self, method, url, token, body=None):
        data = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
        request = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "Bearer " + token, "Content-Type": "application/json",
            "Accept": "application/json", "User-Agent": SERVICE_USER_AGENT,
        })
        try:
            response = self.opener.open(request, timeout=self.request_timeout)
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
            },
        )
        if status not in {200, 201} or not isinstance(body, dict) or body.get("ok") is not True:
            raise BridgeError("AgentCash People Search evidence import failed.")
        return body

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


def register(ctx):
    # Register the Cloud control surface before tool discovery. If the Worker is
    # temporarily unavailable, dashboard startup still leaves the route either
    # strongly authenticated or absent; it never falls open.
    register_control_auth(ctx)
    bridge = Bridge(
        ctx.get_config("base_url", ""), os.environ.get("ENTERPRISE_RUNTIME_TOKEN", ""),
        ctx.get_config("native_url", "http://127.0.0.1:8642"), os.environ.get("API_SERVER_KEY", ""),
        request_timeout=ctx.get_config("request_timeout_seconds", 5),
        pending_timeout=ctx.get_config("pending_timeout_seconds", 86400),
    )
    # Install the veto before network discovery; a discovery failure exposes zero tools.
    assigned_skills = {
        name for name in ctx.get_config("allowed_skills", [])
        if isinstance(name, str) and re.fullmatch(r"[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+", name)
    }
    agentcash_arguments = approved_agentcash_arguments(ctx.get_config("partner_program", {}))
    allowed = {"skill_view"}
    mcp_policy = {}
    for item in ctx.get_config("mcp_policy", []):
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
        if tool_name == "mcp__agentcash__fetch" and args != agentcash_arguments:
            return {"action": "block", "message": "Only the exact approved AgentCash People Search request is allowed."}
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
                    bridge.authorize_people_search(run_id, call_id, args)
                except Exception:
                    return {"action": "block", "message": "AgentCash payment authorization failed closed."}
            return None
        if tool_name not in allowed:
            return {"action": "block", "message": "Only governed enterprise tools are enabled in this profile."}

    def import_agentcash_result(tool_name="", args=None, result=None, tool_call_id="", **_kwargs):
        # Observer hooks are deliberately exact: the pre-hook already blocked
        # every other AgentCash call and reserved this tool-call id before pay.
        if tool_name != "mcp__agentcash__fetch" or not isinstance(args, dict):
            return None
        if args != agentcash_arguments:
            return None
        try:
            run_id, trusted_call_id = trusted_hook_identity(tool_call_id)
            bridge.import_people_search(run_id, trusted_call_id, args, result)
        except Exception:
            # post_tool_call is observational and must never mutate the model's
            # original tool result. The managed skill verifies import by listing
            # stored candidates and stops if none appear.
            return None
        return None

    ctx.register_hook("post_tool_call", import_agentcash_result)
    ctx.register_hook("pre_tool_call", guard)
    skill_path = pathlib.Path(__file__).parent / "skills" / "partner-program-screening" / "SKILL.md"
    ctx.register_skill(
        name="partner-program-screening",
        path=skill_path,
        description="Screen partner prospects and prepare cited human reviews.",
        frontmatter={"version": "1.3.0", "metadata": {"hermes": {"category": "enterprise"}}},
    )
    for schema in bridge.tools():
        name = schema["name"]
        handle = ctx.register_tool(name=name, toolset=TOOLSET, schema=schema,
                                   handler=bridge.handler(name))
        if handle is None:
            raise BridgeError("An enterprise tool conflicts with another runtime tool.")
        allowed.add(name)
