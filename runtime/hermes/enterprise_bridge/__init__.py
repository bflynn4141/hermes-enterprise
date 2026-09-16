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


class BridgeError(Exception):
    """Only safe, fixed messages cross the model-visible boundary."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BridgeError("Enterprise bridge redirects are not allowed.")


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
            "Accept": "application/json",
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


def register(ctx):
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
    allowed = {"skill_view"}

    def guard(tool_name, args=None, **kwargs):
        if tool_name == "skill_view":
            args = args if isinstance(args, dict) else {}
            if (args.get("name") in assigned_skills
                    and not args.get("file_path")
                    and set(args).issubset({"name", "preprocess"})):
                return None
            return {"action": "block", "message": "Only the assigned managed skill can be viewed."}
        if tool_name not in allowed:
            return {"action": "block", "message": "Only governed enterprise tools are enabled in this profile."}

    ctx.register_hook("pre_tool_call", guard)
    skill_path = pathlib.Path(__file__).parent / "skills" / "partner-program-screening" / "SKILL.md"
    ctx.register_skill(
        name="partner-program-screening",
        path=skill_path,
        description="Screen partner prospects and prepare cited human reviews.",
        frontmatter={"version": "1.0.0", "metadata": {"hermes": {"category": "enterprise"}}},
    )
    for schema in bridge.tools():
        name = schema["name"]
        handle = ctx.register_tool(name=name, toolset=TOOLSET, schema=schema,
                                   handler=bridge.handler(name))
        if handle is None:
            raise BridgeError("An enterprise tool conflicts with another runtime tool.")
        allowed.add(name)
