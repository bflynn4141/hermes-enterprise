#!/usr/bin/env python3
"""Exercise real Hermes HTTP/run/plugin paths with an explicit local fake model.

No provider credentials or paid calls. This proves runtime integration, not model quality.
"""

import argparse
import http.server
import json
import pathlib
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from enterprise_bridge.packages import packaged_skills

PACKAGES = packaged_skills()
LEGACY_PARTNER_PACKAGE = PACKAGES["enterprise_bridge:partner-program-screening"]
PARTNER_PACKAGE = PACKAGES["enterprise_bridge:partner-program-screening-v1-8"]
FINANCE_PACKAGE = PACKAGES["enterprise_bridge:partner-invoice-review"]
INTAKE_EVENT_ID = "11111111-1111-4111-8111-111111111111"
HANDOFF_ID = "22222222-2222-4222-8222-222222222222"
PAYLOAD_HASH = "sha256:" + "a" * 64
PENDING_HASH = "sha256:" + "b" * 64


def tool_schema(name):
    if name == "publish_partner_invoice_review":
        return {
            "name": name,
            "description": "Publish one immutable confirmed invoice intake to Finance.",
            "parameters": {
                "type": "object",
                "properties": {
                    "intake_event_id": {"type": "string", "format": "uuid"},
                    "expected_payload_hash": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"},
                },
                "required": ["intake_event_id", "expected_payload_hash"],
                "additionalProperties": False,
            },
        }
    if name == "get_partner_handoff_result":
        return {
            "name": "get_partner_handoff_result",
            "description": "Read the authoritative result for one granted Finance handoff.",
            "parameters": {
                "type": "object",
                "properties": {"handoff_id": {"type": "string", "format": "uuid"}},
                "required": ["handoff_id"],
                "additionalProperties": False,
            },
        }
    return {
        "name": "list_partner_candidates",
        "description": "List candidates collected under the approved source policy.",
        "parameters": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    }


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, required=True)
    parser.add_argument("--python", type=pathlib.Path, required=True)
    args = parser.parse_args()
    model_calls, tool_calls, catalog_names, metadata_fallback_calls = [], [], {}, []
    token = secrets.token_hex(32)
    partner_agent_id, finance_agent_id, legacy_agent_id = (
        str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    )
    stale_roles = set()

    def role_for_path(path):
        if "/agents/" + partner_agent_id + "/" in path:
            return "partnerships"
        if "/agents/" + finance_agent_id + "/" in path:
            return "finance"
        if "/agents/" + legacy_agent_id + "/" in path:
            return "legacy_partnerships"
        return None

    role_contracts = {
        "partnerships": {
            "agent_id": partner_agent_id,
            "package": PARTNER_PACKAGE,
            "tool": "publish_partner_invoice_review",
            "arguments": {"intake_event_id": INTAKE_EVENT_ID, "expected_payload_hash": PAYLOAD_HASH},
            "skill_heading": "Partner Program Screening",
            "config": {"partner_program": {
                "program_name": "Hermes Partner Program",
                "role_label": "Technical ecosystem partner",
                "source_purpose": "organization_partner_research",
                "screening_dimensions": ["Track Record", "Capacity", "Fit"],
                "search_queries": ["developer agents"],
                "intake_urls": [], "keywords": ["agents"],
                "ranking_weights": {"relevance": 40, "activity": 25, "adoption": 20, "openness": 15},
                "minimum_priority": 50, "lookback_days": 365, "max_candidates": 5,
                "organization_only": True, "no_outreach": True, "human_review_required": True,
            }},
        },
        "finance": {
            "agent_id": finance_agent_id,
            "package": FINANCE_PACKAGE,
            "tool": "get_partner_handoff_result",
            "arguments": {"handoff_id": HANDOFF_ID},
            "skill_heading": "Partner Invoice Review",
            "config": {"invoice_review": {
                "duplicate_window_days": 365,
                "require_engagement_evidence": True,
                "connector": "enterprise-partner-records",
                "human_review_required": True,
                "payment_execution_available": False,
            }},
        },
        "legacy_partnerships": {
            "agent_id": legacy_agent_id,
            "package": LEGACY_PARTNER_PACKAGE,
            "tool": "list_partner_candidates",
            "arguments": {},
            "skill_heading": "Partner Program Screening",
            "config": {"partner_program": {
                "program_name": "Hermes Partner Program",
                "role_label": "Technical ecosystem partner",
                "source_purpose": "organization_partner_research",
                "screening_dimensions": ["Track Record", "Capacity", "Fit"],
                "search_queries": ["developer agents"],
                "intake_urls": [], "keywords": ["agents"],
                "ranking_weights": {"relevance": 40, "activity": 25, "adoption": 20, "openness": 15},
                "minimum_priority": 50, "lookback_days": 365, "max_candidates": 5,
                "organization_only": True, "no_outreach": True, "human_review_required": True,
            }},
        },
    }

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, code, data):
            raw = json.dumps(data).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def authorized(self):
            return self.headers.get("Authorization") == "Bearer " + token

        def do_GET(self):
            role = role_for_path(self.path)
            if not self.authorized():
                self.reply(401, {})
            elif self.path.endswith("/tools"):
                self.reply(200, {"tools": [tool_schema(role_contracts[role]["tool"])]} if role else {})
            elif self.path.endswith("/skills"):
                contract = role_contracts.get(role)
                if contract is None:
                    self.reply(404, {})
                    return
                package = contract["package"]
                self.reply(200, {"skills": [{
                    "name": package["name"],
                    "version": package["version"],
                    "artifact_digest": ("sha256:" + "0" * 64) if role in stale_roles else package["artifact_digest"],
                    "auto_load": True,
                    "config": contract["config"],
                }]})
            elif self.path.endswith("/models"):
                # The Enterprise bridge publishes the authoritative window in
                # the OpenAI-compatible list. The pinned Hermes runtime must
                # consume this without trying its Ollama `/api/show` fallback.
                self.reply(200, {"object": "list", "data": [{
                    "id": "test/fixture", "object": "model", "context_length": 131072,
                }]})
            else:
                self.reply(404, {})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            role = role_for_path(self.path)
            if not self.authorized():
                self.reply(401, {})
                return
            if self.path.endswith("/calls"):
                tool_calls.append({"role": role, **body})
                if body["arguments"].get("expected_payload_hash") == PENDING_HASH:
                    self.reply(202, {"status": "pending"})
                else:
                    self.reply(200, {"ok": True, "content": json.dumps({
                        "role": role, "tool": body["name"], "fixture": True,
                    })})
                return
            if self.path.endswith("/api/show"):
                metadata_fallback_calls.append(body)
                self.reply(500, {"error": "metadata fallback must not be needed"})
                return
            if not self.path.endswith("/chat/completions"):
                self.reply(404, {})
                return
            if role is None:
                self.reply(404, {})
                return
            model_calls.append({"role": role, "body": body})
            catalog_names.setdefault(role, set()).update(t["function"]["name"] for t in body.get("tools", []))
            messages = body["messages"]
            if messages[-1]["role"] == "tool":
                delta = {"role": "assistant", "content": "Fixture complete."}
                finish = "stop"
            else:
                arguments = dict(role_contracts[role]["arguments"])
                if role == "partnerships" and "WAIT_FOR_CONTEXT" in str(messages[-1].get("content")):
                    arguments["expected_payload_hash"] = PENDING_HASH
                tool_name = role_contracts[role]["tool"]
                if role == "finance" and "TRY_FORBIDDEN" in str(messages[-1].get("content")):
                    tool_name = role_contracts["partnerships"]["tool"]
                    arguments = dict(role_contracts["partnerships"]["arguments"])
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_" + uuid.uuid4().hex,
                         "type": "function", "function": {"name": tool_name, "arguments": json.dumps(arguments)}}]}
                finish = "tool_calls"
            if body.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for change, reason in ((delta, None), ({}, finish)):
                    chunk = {"id": "fixture", "object": "chat.completion.chunk", "created": int(time.time()),
                             "model": "test/fixture", "choices": [{"index": 0, "delta": change, "finish_reason": reason}]}
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            else:
                for call in delta.get("tool_calls", []):
                    call.pop("index", None)
                self.reply(200, {"id": "fixture", "object": "chat.completion", "model": "test/fixture",
                                 "choices": [{"index": 0, "message": delta, "finish_reason": finish}],
                                 "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}})

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    agent_id, port = partner_agent_id, free_port()
    state_root = pathlib.Path(tempfile.mkdtemp(prefix="he-", dir="/tmp"))
    profile = state_root / agent_id
    process = None
    try:
        with tempfile.TemporaryDirectory() as temporary:
            temporary = pathlib.Path(temporary)
            token_file, log_file = temporary / "token", temporary / "native.log"
            token_file.write_text(token)
            token_file.chmod(0o600)
            native_key = None

            def request(method, path, body=None, key=None):
                data = json.dumps(body).encode() if body is not None else None
                headers = {"Authorization": "Bearer " + (native_key or ""), "Content-Type": "application/json"}
                if key:
                    headers["Idempotency-Key"] = key
                req = urllib.request.Request(f"http://127.0.0.1:{port}" + path, data=data, method=method, headers=headers)
                try:
                    response = urllib.request.urlopen(req, timeout=45)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    raw = response.read()
                    try:
                        payload = json.loads(raw)
                    except (ValueError, UnicodeDecodeError):
                        payload = raw.decode(errors="replace")
                    return response.code, payload

            def start_native():
                with log_file.open("a") as log:
                    launched = subprocess.Popen([sys.executable, str(ROOT / "start.py"), "--source", str(args.source),
                        "--python", str(args.python), "--workspace-id", "test-workspace", "--agent-id", agent_id,
                        "--enterprise-url", f"http://127.0.0.1:{server.server_port}", "--model", "test/fixture",
                        "--token-file", str(token_file), "--port", str(port), "--state-root", str(state_root)], stdout=log, stderr=log)
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    if launched.poll() is not None:
                        raise AssertionError("Native startup failed:\n" + log_file.read_text())
                    if (profile / "api.key").exists():
                        key = (profile / "api.key").read_text().strip()
                        try:
                            probe = urllib.request.Request(f"http://127.0.0.1:{port}/v1/capabilities",
                                method="GET", headers={"Authorization": "Bearer " + key})
                            with urllib.request.urlopen(probe, timeout=5) as response:
                                capabilities = json.loads(response.read())
                            return launched, key, capabilities
                        except OSError:
                            pass
                    time.sleep(0.2)
                launched.terminate()
                launched.wait(timeout=10)
                raise AssertionError("Native startup timed out:\n" + log_file.read_text())

            process, native_key, capabilities = start_native()
            assert capabilities["object"] == "hermes.api_server.capabilities", capabilities
            assert capabilities["features"]["runs_idempotency"]["durable"] is True, capabilities
            assert request("GET", "/api/jobs")[0] == 404, "native cron routes remain reachable"
            body = {"input": "ECHO_VALUE", "session_id": "fixture-session", "provider": "custom", "model": "test/fixture"}
            code, accepted = request("POST", "/v1/runs", body, "fixture-first")
            assert code == 202, accepted
            run_id = accepted["run_id"]
            replay_code, replay = request("POST", "/v1/runs", body, "fixture-first")
            assert replay_code == 202 and replay["run_id"] == run_id and replay["replayed"], replay
            assert request("POST", "/v1/runs", {**body, "input": "other"}, "fixture-first")[0] == 409

            def settle(run_id):
                until = time.monotonic() + 45
                while time.monotonic() < until:
                    _, result = request("GET", "/v1/runs/" + run_id)
                    if result["status"] in {"completed", "failed", "cancelled", "interrupted"}:
                        return result
                    time.sleep(0.1)
                raise AssertionError("Run did not settle:\n" + log_file.read_text())

            result = settle(run_id)
            assert result["status"] == "completed", result
            assert result["output"] == "Fixture complete.", result
            assert metadata_fallback_calls == [], metadata_fallback_calls
            event_request = urllib.request.Request(f"http://127.0.0.1:{port}/v1/runs/{run_id}/events",
                headers={"Authorization": "Bearer " + native_key})
            with urllib.request.urlopen(event_request, timeout=10) as response:
                wire = response.read().decode()
            assert "\nevent:" not in wire and "\nid:" not in wire, wire
            events = [json.loads(line[6:]) for line in wire.splitlines() if line.startswith("data: ")]
            assert {"tool.started", "tool.completed", "run.completed"} <= {e["event"] for e in events}, events
            assert all(e["run_id"] == run_id and isinstance(e["timestamp"], (int, float)) for e in events), events
            assert request("GET", "/v1/runs/" + run_id + "/events")[0] == 404, "SSE unexpectedly replays"
            assert tool_calls and tool_calls[0]["runtime_run_id"] == run_id, {
                "calls": tool_calls, "tool_results": [message for call in model_calls for message in call["body"]["messages"] if message.get("role") == "tool"],
                "log": log_file.read_text(),
            }
            assert tool_calls[0]["tool_call_id"].startswith("call_"), tool_calls
            assert tool_calls[0]["name"] == "publish_partner_invoice_review", tool_calls
            assert tool_calls[0]["arguments"] == role_contracts["partnerships"]["arguments"], tool_calls
            assert catalog_names["partnerships"] == {"publish_partner_invoice_review", "skill_view"}, catalog_names
            assert any(
                "Partner Program Screening" in str(message.get("content", ""))
                for call in model_calls if call["role"] == "partnerships"
                for message in call["body"].get("messages", [])
            ), "Managed Partner Program skill was not auto-loaded into model context"
            partner_readiness = json.loads((profile / "home/runtime-readiness.json").read_text())
            assert partner_readiness["agent_id"] == partner_agent_id, partner_readiness
            assert partner_readiness["runtime_revision"] == "5d59366010640c1d6b8f170d8a4ee109db2bbdef"
            assert partner_readiness["skills"] == [{
                "name": PARTNER_PACKAGE["name"], "version": PARTNER_PACKAGE["version"],
                "artifact_digest": PARTNER_PACKAGE["artifact_digest"],
                "content_digest": PARTNER_PACKAGE["content_digest"],
            }], partner_readiness
            assert set(partner_readiness["tools"]) == {"publish_partner_invoice_review", "skill_view"}
            process.terminate()
            process.wait(timeout=20)
            process = None
            # The profile state, not the listener number, owns idempotency.
            # A fresh loopback port avoids macOS's post-close bind window.
            port = free_port()
            process, native_key, restarted_capabilities = start_native()
            assert restarted_capabilities["features"]["runs_idempotency"]["durable"] is True
            replay_code, replay = request("POST", "/v1/runs", body, "fixture-first")
            assert replay_code == 202 and replay["run_id"] == run_id and replay["replayed"], replay
            assert request("GET", "/v1/runs/" + run_id)[1]["status"] == "completed"
            second_body = {**body, "input": "SECOND_TURN"}
            _, second = request("POST", "/v1/runs", second_body, "fixture-second")
            assert settle(second["run_id"])["status"] == "completed"
            assert any(sum(m.get("role") == "tool" for m in call["body"]["messages"]) >= 2 for call in model_calls), "Session tool history missing"
            _, waiting = request("POST", "/v1/runs", {**body, "input": "WAIT_FOR_CONTEXT"}, "fixture-wait")
            waiting_id = waiting["run_id"]
            until = time.monotonic() + 20
            while not any(c["runtime_run_id"] == waiting_id for c in tool_calls) and time.monotonic() < until:
                time.sleep(0.1)
            assert any(c["runtime_run_id"] == waiting_id for c in tool_calls), "Pending tool never called"
            assert request("POST", "/v1/runs", {**body, "input": "concurrent"}, "fixture-concurrent")[0] == 429
            before_stop = time.monotonic()
            assert request("POST", "/v1/runs/" + waiting_id + "/stop", {})[0] == 200
            stopped = settle(waiting_id)
            assert stopped["status"] == "cancelled", stopped
            assert time.monotonic() - before_stop < 8, "Stop was not responsive"
            jobs_file = profile / "home/cron/jobs.json"
            jobs_file.parent.mkdir(parents=True, exist_ok=True)
            jobs_file.write_text(json.dumps({"jobs": [{"id": "forbidden-fixture", "enabled": False}]}))
            assert request("GET", "/health")[0] == 503, "native health ignored a nonempty cron store"
            process.terminate()
            process.wait(timeout=20)
            process = None

            # A second dedicated profile must load only Finance procedure and
            # tools. It intentionally has no MCP config or AgentCash home.
            agent_id, port = finance_agent_id, free_port()
            profile = state_root / agent_id
            native_key = None
            process, native_key, finance_capabilities = start_native()
            assert finance_capabilities["features"]["runs_idempotency"]["durable"] is True
            finance_body = {
                "input": "Explain the authoritative Finance result for the admitted handoff.",
                "session_id": "finance-fixture-session", "provider": "custom", "model": "test/fixture",
            }
            code, finance_accepted = request("POST", "/v1/runs", finance_body, "fixture-finance")
            assert code == 202, finance_accepted
            finance_run_id = finance_accepted["run_id"]
            finance_result = settle(finance_run_id)
            assert finance_result["status"] == "completed", finance_result
            finance_calls = [call for call in tool_calls if call["role"] == "finance"]
            assert len(finance_calls) == 1, finance_calls
            assert finance_calls[0]["runtime_run_id"] == finance_run_id, finance_calls
            assert finance_calls[0]["name"] == "get_partner_handoff_result", finance_calls
            assert finance_calls[0]["arguments"] == {"handoff_id": HANDOFF_ID}, finance_calls
            assert catalog_names["finance"] == {"get_partner_handoff_result", "skill_view"}, catalog_names
            assert any(
                "Partner Invoice Review" in str(message.get("content", ""))
                for call in model_calls if call["role"] == "finance"
                for message in call["body"].get("messages", [])
            ), "Managed Finance skill was not auto-loaded into model context"
            finance_readiness = json.loads((profile / "home/runtime-readiness.json").read_text())
            assert finance_readiness["agent_id"] == finance_agent_id, finance_readiness
            assert finance_readiness["skills"] == [{
                "name": FINANCE_PACKAGE["name"], "version": FINANCE_PACKAGE["version"],
                "artifact_digest": FINANCE_PACKAGE["artifact_digest"],
                "content_digest": FINANCE_PACKAGE["content_digest"],
            }], finance_readiness
            assert set(finance_readiness["tools"]) == {"get_partner_handoff_result", "skill_view"}
            assert finance_readiness["agentcash_enabled"] is False, finance_readiness

            before_forbidden = len(tool_calls)
            forbidden_body = {**finance_body, "input": "TRY_FORBIDDEN"}
            code, forbidden = request("POST", "/v1/runs", forbidden_body, "fixture-finance-forbidden")
            assert code == 202, forbidden
            forbidden_result = settle(forbidden["run_id"])
            assert forbidden_result["status"] in {"completed", "failed"}, forbidden_result
            assert len(tool_calls) == before_forbidden, "Finance reached the Partnerships publication tool"

            process.terminate()
            process.wait(timeout=20)
            process = None

            # The additive bundle must continue to resolve the original 1.7
            # name and exact bytes for existing governed assignments. Exercise
            # that assignment through the actual gateway, then restart the
            # same profile and replay its durable admission.
            agent_id, port = legacy_agent_id, free_port()
            profile = state_root / agent_id
            native_key = None
            process, native_key, legacy_capabilities = start_native()
            assert legacy_capabilities["features"]["runs_idempotency"]["durable"] is True
            legacy_body = {
                "input": "Continue the existing governed discovery workflow.",
                "session_id": "legacy-partnerships-fixture-session",
                "provider": "custom", "model": "test/fixture",
            }
            code, legacy_accepted = request("POST", "/v1/runs", legacy_body, "fixture-legacy")
            assert code == 202, legacy_accepted
            legacy_run_id = legacy_accepted["run_id"]
            legacy_result = settle(legacy_run_id)
            assert legacy_result["status"] == "completed", legacy_result
            legacy_calls = [call for call in tool_calls if call["role"] == "legacy_partnerships"]
            assert len(legacy_calls) == 1, legacy_calls
            assert legacy_calls[0]["runtime_run_id"] == legacy_run_id, legacy_calls
            assert legacy_calls[0]["name"] == "list_partner_candidates", legacy_calls
            assert legacy_calls[0]["arguments"] == {}, legacy_calls
            assert catalog_names["legacy_partnerships"] == {"list_partner_candidates", "skill_view"}, catalog_names
            assert any(
                "Partner Program Screening" in str(message.get("content", ""))
                for call in model_calls if call["role"] == "legacy_partnerships"
                for message in call["body"].get("messages", [])
            ), "Managed legacy Partner Program skill was not auto-loaded into model context"
            legacy_readiness = json.loads((profile / "home/runtime-readiness.json").read_text())
            assert LEGACY_PARTNER_PACKAGE["artifact_digest"] == (
                "sha256:9f124ce44aa318b13e9f8ccfd92072d8b3ba6a22030eaad31cfafbfda3a1e2a9"
            )
            assert LEGACY_PARTNER_PACKAGE["content_digest"] == (
                "sha256:cd26e70aa49de223f28216ea579d33c610305d3184a6c592c7841fa12aca6ddf"
            )
            assert legacy_readiness["skills"] == [{
                "name": LEGACY_PARTNER_PACKAGE["name"],
                "version": LEGACY_PARTNER_PACKAGE["version"],
                "artifact_digest": LEGACY_PARTNER_PACKAGE["artifact_digest"],
                "content_digest": LEGACY_PARTNER_PACKAGE["content_digest"],
            }], legacy_readiness
            assert set(legacy_readiness["tools"]) == {"list_partner_candidates", "skill_view"}
            process.terminate()
            process.wait(timeout=20)
            process = None
            port = free_port()
            process, native_key, _ = start_native()
            replay_code, replay = request("POST", "/v1/runs", legacy_body, "fixture-legacy")
            assert replay_code == 202 and replay["run_id"] == legacy_run_id and replay["replayed"], replay
            assert request("GET", "/v1/runs/" + legacy_run_id)[1]["status"] == "completed"
            process.terminate()
            process.wait(timeout=20)
            process = None

            legacy_verify_command = [
                sys.executable, str(ROOT / "start.py"), "--source", str(args.source),
                "--python", str(args.python), "--workspace-id", "test-workspace",
                "--agent-id", legacy_agent_id, "--enterprise-url", f"http://127.0.0.1:{server.server_port}",
                "--model", "test/fixture", "--token-file", str(token_file), "--port", str(free_port()),
                "--state-root", str(state_root), "--verify-only",
            ]
            stale_roles.add("legacy_partnerships")
            stale_legacy = subprocess.run(legacy_verify_command, capture_output=True, text=True, timeout=60)
            stale_roles.clear()
            assert stale_legacy.returncode != 0 and "does not match the reviewed native package" in (
                stale_legacy.stdout + stale_legacy.stderr
            ), stale_legacy.stdout + stale_legacy.stderr

            verify_command = [
                sys.executable, str(ROOT / "start.py"), "--source", str(args.source),
                "--python", str(args.python), "--workspace-id", "test-workspace",
                "--agent-id", finance_agent_id, "--enterprise-url", f"http://127.0.0.1:{server.server_port}",
                "--model", "test/fixture", "--token-file", str(token_file), "--port", str(free_port()),
                "--state-root", str(state_root), "--verify-only",
            ]
            stale_roles.add("finance")
            stale = subprocess.run(verify_command, capture_output=True, text=True, timeout=60)
            stale_roles.clear()
            assert stale.returncode != 0 and "does not match the reviewed native package" in (stale.stdout + stale.stderr), (
                stale.stdout + stale.stderr
            )
            misbound = subprocess.run(
                [*verify_command[:verify_command.index("--workspace-id") + 1], "other-workspace",
                 *verify_command[verify_command.index("--workspace-id") + 2:]],
                capture_output=True, text=True, timeout=60,
            )
            assert misbound.returncode != 0 and "already bound to a different enterprise agent or workspace" in (
                misbound.stdout + misbound.stderr
            ), misbound.stdout + misbound.stderr

            print("PASS: actual official gateway + AIAgent loop + plugin + local fixture model for opt-in Partnerships, Finance, and legacy Partnerships.")
            print("Verified all three assigned skills auto-load with exact version/digest and tool inventory; governed tools execute with trusted run/call identity; Finance has no AgentCash and a model-requested Partnerships tool never reaches Enterprise.")
            print("Also verified the deployed legacy 1.7 registry identity against byte-compatible content, legacy startup/restart replay, arbitrary legacy/current digest rejection, profile-binding rejection, durable capabilities, current-profile restart replay, cron route/health policy, custom model proxy, SSE payload/single-consumer behavior, admission replay/conflict, session tool history, concurrency rejection, and stop while awaiting context.")
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        server.shutdown()
        shutil.rmtree(state_root, ignore_errors=True)


if __name__ == "__main__":
    main()
