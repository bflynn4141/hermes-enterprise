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
except Exception:  # Unit tests exercise the transport helper without FastAPI.
    class APIRouter:  # type: ignore[no-redef]
        def post(self, *_args: Any, **_kwargs: Any):
            return lambda function: function

    class Request:  # type: ignore[no-redef]
        pass

    class JSONResponse:  # type: ignore[no-redef]
        def __init__(self, content: Any, status_code: int = 200):
            self.content, self.status_code = content, status_code

    class StreamingResponse:  # type: ignore[no-redef]
        def __init__(self, content: Any, status_code: int = 200, media_type: str = ""):
            self.content, self.status_code, self.media_type = content, status_code, media_type


router = APIRouter()

MAX_BODY_BYTES = 2 * 1024 * 1024
RUN_ID = re.compile(r"run_[A-Za-z0-9_-]{1,180}\Z")
VISIBLE_ASCII = re.compile(r"[\x21-\x7e]{1,255}\Z")
CONTRACT_VERSION = 1
TERMINAL_ERROR_SCHEMA_VERSION = 1
SOURCE_REVISION = "5d59366010640c1d6b8f170d8a4ee109db2bbdef"
TERMINAL_ERROR_CODES = {
    "provider_auth": ("auth", False, "provider", "The selected model connection needs attention."),
    "provider_quota": ("quota", False, "provider", "The selected model account has no available quota."),
    "provider_rate_limited": ("rate_limit", True, "provider", "The selected model is rate limited."),
    "request_rejected": ("rejected", False, "request", "The selected model rejected this request."),
    "provider_unavailable": ("unavailable", True, "provider", "The model provider is temporarily unavailable."),
    "runtime_interrupted": ("interrupted", True, "runtime", "Hermes restarted before this run settled."),
    "runtime_unknown": ("unknown", True, "runtime", "Hermes could not finish this run."),
}


def runtime_contract():
    if os.environ.get("HERMES_ENTERPRISE_SOURCE_REVISION", "").strip() != SOURCE_REVISION:
        raise RuntimeError("enterprise connector source revision is not attested")
    ring = os.environ.get("HERMES_ENTERPRISE_RELEASE_RING", "stable").strip().lower()
    if ring not in {"canary", "stable"}:
        raise RuntimeError("enterprise connector release ring is invalid")
    return {
        "schema_version": CONTRACT_VERSION,
        "source_revision": SOURCE_REVISION,
        "release_ring": ring,
        "terminal_errors": {"supported": True, "schema_version": TERMINAL_ERROR_SCHEMA_VERSION},
    }


def _terminal_error(error: Any = None, status: str = "failed"):
    signal = str(error or "").lower()[:2000]
    if status == "interrupted" or re.search(r"gateway restarted|runtime_run_inactive|run (?:was )?interrupted", signal):
        code = "runtime_interrupted"
    elif re.search(r"\b(?:http\s*)?401\b|unauthori[sz]ed|authentication failed|invalid (?:api )?key|token.*expired", signal):
        code = "provider_auth"
    elif re.search(r"\b(?:http\s*)?402\b|insufficient (?:credits?|balance|funds)|quota (?:exceeded|exhausted)|billing (?:limit|disabled|required)", signal):
        code = "provider_quota"
    elif re.search(r"\b(?:http\s*)?429\b|rate[ -]?limit(?:ed|ing)?|too many requests", signal):
        code = "provider_rate_limited"
    elif re.search(r"\b(?:http\s*)?(?:400|404|405|413|415|422)\b|bad request|invalid request|context (?:length|window)|maximum context|unsupported model", signal):
        code = "request_rejected"
    elif re.search(r"\b(?:http\s*)?(?:500|502|503|504)\b|temporar(?:y|ily) unavailable|service unavailable|overloaded|timeout|connection (?:reset|closed|failed|error)", signal):
        code = "provider_unavailable"
    else:
        code = "runtime_unknown"
    category, retryable, source, _ = TERMINAL_ERROR_CODES[code]
    return {"schema_version": TERMINAL_ERROR_SCHEMA_VERSION, "code": code, "category": category,
            "retryable": retryable, "source": source}


def govern_terminal_payload(payload: Any):
    if not isinstance(payload, dict):
        return payload
    status = str(payload.get("status") or "")
    if payload.get("event") == "run.failed":
        status = "failed"
    if status not in {"failed", "interrupted"}:
        return payload
    existing = payload.get("terminal_error")
    code = existing.get("code") if isinstance(existing, dict) else None
    if code in TERMINAL_ERROR_CODES:
        category, retryable, source, message = TERMINAL_ERROR_CODES[code]
        detail = {"schema_version": TERMINAL_ERROR_SCHEMA_VERSION, "code": code,
                  "category": category, "retryable": retryable, "source": source}
    else:
        detail = _terminal_error(payload.get("error"), status)
        message = TERMINAL_ERROR_CODES[detail["code"]][3]
    return {**payload, "error": message, "terminal_error": detail}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("native redirect refused")


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
            agentcash_home = os.environ.get("AGENTCASH_HOME", "").strip()
            wallet_path = pathlib.Path(agentcash_home) / ".agentcash" / "wallet.json" if agentcash_home else None
            return 200, {
                "object": "hermes.enterprise_bridge.readiness",
                "version": "1.6.0",
                "workspace_id": os.environ.get("ENTERPRISE_WORKSPACE_ID", ""),
                "agent_id": os.environ.get("ENTERPRISE_AGENT_ID", ""),
                "enterprise_url": os.environ.get("ENTERPRISE_URL", ""),
                "agentcash_enabled": os.environ.get("HERMES_AGENTCASH_MCP_ENABLED", "") == "1",
                "agentcash_wallet_present": bool(wallet_path and wallet_path.is_file()),
                "native_cron_disabled": os.environ.get("HERMES_NATIVE_CRON_ENABLED", "") != "1",
            }
        if operation == "capabilities":
            status, body = self._request("GET", "/v1/capabilities")
            if status == 200 and isinstance(body, dict):
                expected = runtime_contract()
                existing = body.get("enterprise_contract")
                if existing is not None and existing != expected:
                    return 502, {"error": "native Enterprise contract does not match connector"}
                body = {**body, "enterprise_contract": expected}
            return status, body
        if operation == "submit":
            key = payload.get("idempotency_key")
            body = payload.get("body")
            if not isinstance(key, str) or not VISIBLE_ASCII.fullmatch(key) or not isinstance(body, dict):
                return 400, {"error": "invalid submit envelope"}
            return self._request("POST", "/v1/runs", body, {"Idempotency-Key": key})
        if operation == "status":
            run_id = self.require_run_id(payload.get("run_id"))
            status, body = self._request("GET", "/v1/runs/" + run_id)
            return status, govern_terminal_payload(body)
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


def _project_sse_frame(frame: bytes) -> bytes:
    projected = []
    for line in frame.splitlines():
        if line.startswith(b"data:"):
            data = line[5:]
            if data.startswith(b" "):
                data = data[1:]
            if data == b"[DONE]":
                projected.append(b"data: [DONE]")
                continue
            try:
                payload = json.loads(data)
                line = b"data: " + json.dumps(
                    govern_terminal_payload(payload), separators=(",", ":"),
                ).encode()
            except (ValueError, UnicodeDecodeError):
                line = b": enterprise malformed data"
        projected.append(line)
    return b"\n".join(projected) + b"\n\n"


def _stream_native(response):
    buffered = b""
    try:
        # ``HTTPResponse.read(size)`` waits for the requested byte count or
        # EOF, which turns a short model response into one burst after the run
        # finishes. ``read1`` returns the bytes already available from the
        # socket, preserving the native SSE frame cadence through Hermes Cloud.
        read_available = getattr(response, "read1", None) or response.read
        while True:
            chunk = read_available(8192)
            if not chunk:
                break
            buffered += chunk
            while True:
                boundary = re.search(br"\r?\n\r?\n", buffered)
                if boundary is None:
                    break
                frame, buffered = buffered[:boundary.start()], buffered[boundary.end():]
                yield _project_sse_frame(frame)
        if buffered:
            # A peer may close without the optional final blank line. Project
            # that last frame through the same boundary before releasing it.
            yield _project_sse_frame(buffered)
    finally:
        response.close()


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
            response = await asyncio.to_thread(control.open_events, payload.get("run_id"))
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
                headers={
                    "Cache-Control": "no-cache, no-transform",
                    "X-Accel-Buffering": "no",
                },
            )
        status, body = await asyncio.to_thread(control.dispatch, payload)
        return JSONResponse(body, status_code=status)
    except ValueError as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    except Exception:
        return JSONResponse({"error": "enterprise connector failed closed"}, status_code=502)
