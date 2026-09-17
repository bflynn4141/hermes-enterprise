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
                "version": "1.5.0",
                "workspace_id": os.environ.get("ENTERPRISE_WORKSPACE_ID", ""),
                "agent_id": os.environ.get("ENTERPRISE_AGENT_ID", ""),
                "enterprise_url": os.environ.get("ENTERPRISE_URL", ""),
                "agentcash_enabled": os.environ.get("HERMES_AGENTCASH_MCP_ENABLED", "") == "1",
                "agentcash_wallet_present": bool(wallet_path and wallet_path.is_file()),
                "native_cron_disabled": os.environ.get("HERMES_NATIVE_CRON_ENABLED", "") != "1",
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


def _stream_native(response):
    try:
        # ``HTTPResponse.read(size)`` waits for the requested byte count or
        # EOF, which turns a short model response into one burst after the run
        # finishes. ``read1`` returns the bytes already available from the
        # socket, preserving the native SSE frame cadence through Hermes Cloud.
        read_available = getattr(response, "read1", response.read)
        while True:
            chunk = read_available(8192)
            if not chunk:
                break
            yield chunk
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
