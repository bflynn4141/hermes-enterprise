"""Fixed, authenticated Hermes Cloud connector for the native Runs API.

Mounted at ``/api/plugins/enterprise_bridge/control``. The dashboard's generic
token-auth middleware protects this exact route with a per-agent service
credential registered by the agent plugin. The connector is deliberately an
operation allowlist, never an arbitrary loopback proxy.
"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import re
import urllib.error
import urllib.request
from typing import Any

try:
    from fastapi import APIRouter, Request
    from fastapi.responses import JSONResponse, StreamingResponse
    FASTAPI_AVAILABLE = True
except Exception:  # Unit tests exercise the transport helper without FastAPI.
    FASTAPI_AVAILABLE = False

    class APIRouter:  # type: ignore[no-redef]
        def post(self, *_args: Any, **_kwargs: Any):
            return lambda function: function

        def get(self, *_args: Any, **_kwargs: Any):
            return lambda function: function

    class Request:  # type: ignore[no-redef]
        pass

    class JSONResponse:  # type: ignore[no-redef]
        def __init__(self, content: Any, status_code: int = 200):
            self.content, self.status_code = content, status_code

    class StreamingResponse:  # type: ignore[no-redef]
        def __init__(
            self,
            content: Any,
            status_code: int = 200,
            media_type: str = "",
            headers: dict[str, str] | None = None,
        ):
            self.content, self.status_code, self.media_type, self.headers = content, status_code, media_type, headers or {}


router = APIRouter()

CONNECTOR_VERSION = "1.7.0"
MAX_BODY_BYTES = 2 * 1024 * 1024
READINESS_MAX_BYTES = 64 * 1024
RUNTIME_READINESS_FILENAME = "runtime-readiness.json"
RUN_ID = re.compile(r"run_[A-Za-z0-9_-]{1,180}\Z")
VISIBLE_ASCII = re.compile(r"[\x21-\x7e]{1,255}\Z")
SKILL_NAME = re.compile(r"[A-Za-z0-9_-]+:[A-Za-z0-9_-]+\Z")
SEMVER = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+\Z")
SHA256 = re.compile(r"sha256:[0-9a-f]{64}\Z")
TOOL_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}\Z")
SSE_CONNECTED = b": enterprise-bridge-connected\n\n"
SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("native redirect refused")


def load_runtime_attestation(home: pathlib.Path | None = None) -> dict[str, Any]:
    """Read the inventory written only after native plugin/tool preflight."""
    root = home or pathlib.Path(os.environ.get("HERMES_HOME", ""))
    path = root / RUNTIME_READINESS_FILENAME
    try:
        unavailable = (not str(root) or path.is_symlink() or not path.is_file()
                       or path.stat().st_size > READINESS_MAX_BYTES)
    except OSError as error:
        raise RuntimeError("native readiness attestation is unavailable") from error
    if unavailable:
        raise RuntimeError("native readiness attestation is unavailable")
    try:
        document = json.loads(path.read_bytes())
    except (OSError, ValueError, UnicodeDecodeError) as error:
        raise RuntimeError("native readiness attestation is invalid") from error
    if not isinstance(document, dict):
        raise RuntimeError("native readiness attestation is invalid")
    plugin = document.get("plugin")
    skills, tools = document.get("skills"), document.get("tools")
    if (document.get("schema_version") != 1
            or not isinstance(document.get("runtime_revision"), str)
            or not re.fullmatch(r"[0-9a-f]{40}", document["runtime_revision"])
            or plugin != {"name": "enterprise_bridge", "version": CONNECTOR_VERSION}
            or not all(isinstance(document.get(key), str) and document[key]
                       for key in ("workspace_id", "agent_id", "enterprise_url"))
            or not isinstance(skills, list) or len(skills) > 16
            or not isinstance(tools, list) or len(tools) > 128
            or not isinstance(document.get("agentcash_enabled"), bool)
            or not isinstance(document.get("native_cron_disabled"), bool)):
        raise RuntimeError("native readiness attestation is invalid")
    seen_skills = set()
    for skill in skills:
        if (not isinstance(skill, dict)
                or set(skill) != {"name", "version", "artifact_digest", "content_digest"}
                or not isinstance(skill.get("name"), str) or not SKILL_NAME.fullmatch(skill["name"])
                or skill["name"] in seen_skills
                or not isinstance(skill.get("version"), str) or not SEMVER.fullmatch(skill["version"])
                or not isinstance(skill.get("artifact_digest"), str)
                or not SHA256.fullmatch(skill["artifact_digest"])
                or not isinstance(skill.get("content_digest"), str)
                or not SHA256.fullmatch(skill["content_digest"])):
            raise RuntimeError("native readiness attestation is invalid")
        seen_skills.add(skill["name"])
    if (len(set(tools)) != len(tools) or "skill_view" not in tools
            or any(not isinstance(tool, str) or not TOOL_NAME.fullmatch(tool) for tool in tools)):
        raise RuntimeError("native readiness attestation is invalid")
    return document


class NativeControl:
    """Call only the loopback API Server operations the enterprise host needs."""

    def __init__(self, base_url: str | None = None, api_key: str | None = None):
        self.base_url = (base_url or os.environ.get("HERMES_ENTERPRISE_NATIVE_URL") or "http://127.0.0.1:8642").rstrip("/")
        self.api_key = (api_key or os.environ.get("API_SERVER_KEY") or "").strip()
        if not re.fullmatch(r"http://(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?", self.base_url):
            raise RuntimeError("enterprise connector requires a loopback native URL")
        if not self.api_key:
            raise RuntimeError("enterprise connector native credential is missing")
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))

    @staticmethod
    def require_run_id(value: Any) -> str:
        if not isinstance(value, str) or not RUN_ID.fullmatch(value):
            raise ValueError("invalid run id")
        return value

    def _request(self, method: str, path: str, body: Any = None, headers: dict[str, str] | None = None):
        encoded = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
        request_headers = {
            "Authorization": "Bearer " + self.api_key,
            "Accept": "application/json",
            "Connection": "close",
        }
        if encoded is not None:
            request_headers["Content-Type"] = "application/json"
        request_headers.update(headers or {})
        request = urllib.request.Request(self.base_url + path, data=encoded, method=method, headers=request_headers)
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read(MAX_BODY_BYTES + 1)
            if len(raw) > MAX_BODY_BYTES:
                return 502, {"error": "native response exceeded connector limit"}
            try:
                parsed = json.loads(raw) if raw else {}
            except (ValueError, UnicodeDecodeError):
                return 502, {"error": "native response was not JSON"}
            return response.code, parsed

    def dispatch(self, payload: dict[str, Any]):
        operation = payload.get("operation")
        if operation == "readiness":
            try:
                attestation = load_runtime_attestation()
            except RuntimeError:
                return 503, {
                    "error": "native readiness attestation is unavailable",
                    "code": "native_readiness_unavailable",
                }
            agentcash_home = os.environ.get("AGENTCASH_HOME", "").strip()
            wallet_path = pathlib.Path(agentcash_home) / ".agentcash" / "wallet.json" if agentcash_home else None
            return 200, {
                "object": "hermes.enterprise_bridge.readiness",
                "version": CONNECTOR_VERSION,
                "runtime_revision": attestation["runtime_revision"],
                "plugin": attestation["plugin"],
                "workspace_id": attestation["workspace_id"],
                "agent_id": attestation["agent_id"],
                "enterprise_url": attestation["enterprise_url"],
                "skills": attestation["skills"],
                "tools": attestation["tools"],
                "agentcash_enabled": attestation["agentcash_enabled"],
                "agentcash_wallet_present": bool(wallet_path and wallet_path.is_file()),
                "native_cron_disabled": attestation["native_cron_disabled"],
            }
        if operation == "capabilities":
            return self._request("GET", "/v1/capabilities")
        if operation == "submit":
            key = payload.get("idempotency_key")
            body = payload.get("body")
            if not isinstance(key, str) or not VISIBLE_ASCII.fullmatch(key) or not isinstance(body, dict):
                return 400, {"error": "invalid submit envelope"}
            return self._request("POST", "/v1/runs", body, {"Idempotency-Key": key})
        if operation == "status":
            run_id = self.require_run_id(payload.get("run_id"))
            return self._request("GET", "/v1/runs/" + run_id)
        if operation == "stop":
            run_id = self.require_run_id(payload.get("run_id"))
            return self._request("POST", "/v1/runs/" + run_id + "/stop", {})
        if operation == "steer":
            run_id = self.require_run_id(payload.get("run_id"))
            text = payload.get("input")
            if not isinstance(text, str) or not text.strip() or len(text) > 32768:
                return 400, {"error": "invalid steer input"}
            return self._request("POST", "/v1/runs/" + run_id + "/steer", {"input": text})
        return 400, {"error": "unsupported enterprise control operation"}

    def open_events(self, run_id: Any):
        run_id = self.require_run_id(run_id)
        request = urllib.request.Request(
            self.base_url + "/v1/runs/" + run_id + "/events",
            method="GET",
            headers={
                "Authorization": "Bearer " + self.api_key,
                "Accept": "text/event-stream",
                "Connection": "close",
            },
        )
        try:
            return self.opener.open(request, timeout=65)
        except urllib.error.HTTPError as error:
            return error


def _sse_boundary(buffer: bytes) -> tuple[int, int] | None:
    """Return the first complete SSE-frame boundary in ``buffer``."""
    lf = buffer.find(b"\n\n")
    crlf = buffer.find(b"\r\n\r\n")
    if lf < 0 and crlf < 0:
        return None
    if crlf >= 0 and (lf < 0 or crlf < lf):
        return crlf, 4
    return lf, 2


async def _stream_native(response):
    """Relay native SSE one complete frame at a time without blocking ASGI."""
    try:
        # Commit the streaming response before the model's first token. This is
        # a valid SSE comment, ignored by the Worker parser, and prevents an
        # otherwise silent POST/GET response from being mistaken for a small
        # bufferable payload by the dashboard edge.
        yield SSE_CONNECTED

        # ``HTTPResponse.read(size)`` waits for the requested byte count or
        # EOF, which turns a short model response into one burst after the run
        # finishes. ``read1`` returns the bytes already available from the
        # socket, preserving the native SSE frame cadence through Hermes Cloud.
        read_available = getattr(response, "read1", None) or response.read
        buffered = b""
        while True:
            chunk = await asyncio.to_thread(read_available, 8192)
            if not chunk:
                break
            buffered += chunk
            boundary = _sse_boundary(buffered)
            while boundary is not None:
                index, length = boundary
                end = index + length
                yield buffered[:end]
                buffered = buffered[end:]
                boundary = _sse_boundary(buffered)
        if buffered:
            # Match the native parser's tolerance for a final SSE frame without
            # a trailing blank line. The Worker still validates the JSON body.
            yield buffered
    finally:
        response.close()


async def _event_stream(control: NativeControl, run_id: Any):
    response = await asyncio.to_thread(control.open_events, run_id)
    if response.code >= 400:
        raw_error = await asyncio.to_thread(response.read, MAX_BODY_BYTES + 1)
        response.close()
        try:
            body = json.loads(raw_error)
        except (ValueError, UnicodeDecodeError):
            body = {"error": "native events request failed"}
        return JSONResponse(body, status_code=response.code)
    return StreamingResponse(
        _stream_native(response),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


@router.get("/control")
async def enterprise_events(run_id: str):
    """Compatibility route for hosts that expose plugin GET handlers."""
    try:
        return await _event_stream(NativeControl(), run_id)
    except ValueError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    except Exception:
        return JSONResponse({"error": "enterprise connector failed closed"}, status_code=502)


@router.post("/control")
async def enterprise_control(request: Request):
    content_length = request.headers.get("content-length", "")
    if content_length.isdigit() and int(content_length) > MAX_BODY_BYTES:
        return JSONResponse({"error": "request exceeded connector limit"}, status_code=413)
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        return JSONResponse({"error": "request exceeded connector limit"}, status_code=413)
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return JSONResponse({"error": "request was not JSON"}, status_code=400)
    if not isinstance(payload, dict):
        return JSONResponse({"error": "request envelope must be an object"}, status_code=400)

    try:
        control = NativeControl()
        if payload.get("operation") == "events":
            # Hermes Dashboard's service-authenticated plugin edge dispatches
            # POST envelopes. StreamingResponse and the priming comment still
            # commit the SSE response before the first native model token.
            return await _event_stream(control, payload.get("run_id"))
        status, body = await asyncio.to_thread(control.dispatch, payload)
        return JSONResponse(body, status_code=status)
    except ValueError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    except Exception:
        return JSONResponse({"error": "enterprise connector failed closed"}, status_code=502)
