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


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, required=True)
    parser.add_argument("--python", type=pathlib.Path, required=True)
    args = parser.parse_args()
    model_calls, tool_calls, catalog_names = [], [], set()
    token = secrets.token_hex(32)

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
            if not self.authorized():
                self.reply(401, {})
            elif self.path.endswith("/tools"):
                self.reply(200, {"tools": [{"name": "enterprise_echo", "description": "Echo a value through the governed enterprise bridge.",
                                          "parameters": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}}]})
            elif self.path.endswith("/skills"):
                self.reply(200, {"skills": [{
                    "name": "enterprise_bridge:partner-program-screening",
                    "version": "1.1.0",
                    "auto_load": True,
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
                }]})
            elif self.path.endswith("/models"):
                self.reply(200, {"object": "list", "data": [
                    {"id": "test/fixture", "object": "model"},
                    {"id": "anthropic/claude-sonnet-5", "object": "model"},
                ]})
            else:
                self.reply(404, {})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            if not self.authorized():
                self.reply(401, {})
                return
            if self.path.endswith("/calls"):
                tool_calls.append(body)
                if body["arguments"].get("value") == "pending":
                    self.reply(202, {"status": "pending"})
                else:
                    self.reply(200, {"ok": True, "content": json.dumps({"value": body["arguments"].get("value")})})
                return
            if not self.path.endswith("/chat/completions"):
                self.reply(404, {})
                return
            model_calls.append(body)
            prompt = str(body.get("messages", []))
            faults = {
                "FAULT_AUTH": (401, "Provider authentication failed: SECRET_NATIVE_AUTH"),
                "FAULT_QUOTA": (402, "Insufficient credits: SECRET_NATIVE_QUOTA"),
                "FAULT_RATE_LIMIT": (429, "Too many requests: SECRET_NATIVE_RATE"),
                "FAULT_REJECTED": (400, "Maximum context length exceeded: SECRET_NATIVE_REQUEST"),
                "FAULT_UNAVAILABLE": (503, "Provider temporarily unavailable: SECRET_NATIVE_UPSTREAM"),
            }
            for marker, (status, message) in faults.items():
                if marker in prompt:
                    self.reply(status, {"error": {"message": message, "type": "fixture_fault", "code": marker.lower()}})
                    return
            catalog_names.update(t["function"]["name"] for t in body.get("tools", []))
            messages = body["messages"]
            cache_fixture = "CACHE_FIXTURE" in str(messages[-1].get("content"))
            if cache_fixture:
                delta = {"role": "assistant", "content": "Cache fixture complete."}
                finish = "stop"
            elif messages[-1]["role"] == "tool":
                delta = {"role": "assistant", "content": "Fixture complete."}
                finish = "stop"
            else:
                value = "pending" if "WAIT_FOR_CONTEXT" in str(messages[-1].get("content")) else "value"
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_" + uuid.uuid4().hex,
                         "type": "function", "function": {"name": "enterprise_echo", "arguments": json.dumps({"value": value})}}]}
                finish = "tool_calls"
            if body.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                changes = (
                    (({"role": "assistant", "content": "Cache "}, None),
                     ({"content": "fixture "}, None), ({"content": "complete."}, None), ({}, finish))
                    if cache_fixture else ((delta, None), ({}, finish))
                )
                for change, reason in changes:
                    chunk = {"id": "fixture", "object": "chat.completion.chunk", "created": int(time.time()),
                             "model": "test/fixture", "choices": [{"index": 0, "delta": change, "finish_reason": reason}]}
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                    self.wfile.flush()
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
    agent_id, port = str(uuid.uuid4()), free_port()
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
            assert capabilities["enterprise_contract"] == {
                "schema_version": 1,
                "source_revision": "5d59366010640c1d6b8f170d8a4ee109db2bbdef",
                "release_ring": "stable",
                "terminal_errors": {"supported": True, "schema_version": 1},
            }, capabilities
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
                "calls": tool_calls, "tool_results": [message for call in model_calls for message in call["messages"] if message.get("role") == "tool"],
                "log": log_file.read_text(),
            }
            assert tool_calls[0]["tool_call_id"].startswith("call_"), tool_calls
            assert catalog_names == {"enterprise_echo", "skill_view"}, catalog_names
            assert any(
                "Partner Program Screening" in str(message.get("content", ""))
                for call in model_calls for message in call.get("messages", [])
            ), "Managed Partner Program skill was not auto-loaded into model context"

            # The profile default is non-Claude. An allowed per-run Claude
            # override still needs the proxy-scoped cache policy from /models.
            assert all('"cache_control"' not in json.dumps(call) for call in model_calls), "Non-Claude requests acquired cache markers"
            cached_system_prefixes = []
            for turn in (1, 2):
                first_call = len(model_calls)
                cache_body = {**body, "input": f"CACHE_FIXTURE_{turn}", "session_id": "cache-fixture",
                              "model": "anthropic/claude-sonnet-5"}
                cache_code, cache_run = request("POST", "/v1/runs", cache_body, f"fixture-cache-{turn}")
                assert cache_code == 202, cache_run
                cache_result = settle(cache_run["run_id"])
                assert cache_result["status"] == "completed" and cache_result["output"] == "Cache fixture complete.", cache_result
                calls = model_calls[first_call:]
                assert calls and all(call["stream"] for call in calls), calls
                system_parts = [part for call in calls for message in call["messages"]
                                if message["role"] == "system" and isinstance(message.get("content"), list)
                                for part in message["content"] if part.get("cache_control") == {"type": "ephemeral"}]
                assert system_parts, "Allowed Claude override did not receive 5-minute prompt cache markers"
                cached_system_prefixes.append({part["text"] for part in system_parts})
                cache_wire = request("GET", "/v1/runs/" + cache_run["run_id"] + "/events")[1]
                cache_events = [json.loads(line[6:]) for line in cache_wire.splitlines() if line.startswith("data: ")]
                deltas = [event["delta"] for event in cache_events if event["event"] == "message.delta"]
                assert len(deltas) >= 2 and "".join(deltas) == "Cache fixture complete.", cache_events
            assert cached_system_prefixes[0] & cached_system_prefixes[1], "Follow-up turn changed every cached system prefix"
            for uncached_model in ("test/fixture", "anthropic/claude-unlisted"):
                first_call = len(model_calls)
                uncached_body = {**body, "input": "CACHE_FIXTURE_UNCACHED", "model": uncached_model,
                                 "session_id": "uncached-" + uncached_model.replace("/", "-")}
                code, uncached = request("POST", "/v1/runs", uncached_body, "fixture-uncached-" + uncached_model)
                assert code == 202 and settle(uncached["run_id"])["status"] == "completed", uncached
                assert model_calls[first_call:] and all('"cache_control"' not in json.dumps(call) for call in model_calls[first_call:]), \
                    "Unknown or non-Claude model acquired cache markers"
            for marker, expected in (
                    ("FAULT_AUTH", ("provider_auth", "auth", False)),
                    ("FAULT_QUOTA", ("provider_quota", "quota", False)),
                    ("FAULT_RATE_LIMIT", ("provider_rate_limited", "rate_limit", True)),
                    ("FAULT_REJECTED", ("request_rejected", "rejected", False)),
                    ("FAULT_UNAVAILABLE", ("provider_unavailable", "unavailable", True))):
                fault_body = {**body, "input": marker, "session_id": "fault-" + marker.lower()}
                fault_code, fault = request("POST", "/v1/runs", fault_body, "fixture-" + marker.lower())
                assert fault_code == 202, fault
                failed = settle(fault["run_id"])
                assert failed["status"] == "failed", failed
                detail = failed.get("terminal_error")
                assert detail and (detail["code"], detail["category"], detail["retryable"]) == expected, {
                    "status": failed,
                    "gateway_log": log_file.read_text(),
                }
                assert "SECRET_NATIVE" not in json.dumps(failed), failed

            # A retained nonterminal reservation whose owner disappears must
            # become a structured interrupted failure after restart.
            _, interrupted = request("POST", "/v1/runs", {**body, "input": "WAIT_FOR_CONTEXT", "session_id": "restart-interrupted"}, "fixture-interrupted")
            interrupted_id = interrupted["run_id"]
            until = time.monotonic() + 20
            while not any(c["runtime_run_id"] == interrupted_id for c in tool_calls) and time.monotonic() < until:
                time.sleep(0.1)
            assert any(c["runtime_run_id"] == interrupted_id for c in tool_calls), "Interrupted fixture never became active"
            # Simulate an ungraceful host/process loss. SIGTERM is cooperative
            # and correctly persists `cancelled`; only a disappeared owner
            # exercises restart hydration to `interrupted`.
            process.kill()
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
            interrupted_status = request("GET", "/v1/runs/" + interrupted_id)[1]
            assert interrupted_status["status"] == "interrupted", interrupted_status
            assert interrupted_status["terminal_error"]["code"] == "runtime_interrupted", interrupted_status
            assert interrupted_status["terminal_error"]["retryable"] is True, interrupted_status
            second_body = {**body, "input": "SECOND_TURN"}
            _, second = request("POST", "/v1/runs", second_body, "fixture-second")
            assert settle(second["run_id"])["status"] == "completed"
            assert any(sum(m.get("role") == "tool" for m in call["messages"]) >= 2 for call in model_calls), "Session tool history missing"
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
            print("PASS: actual official gateway + AIAgent loop + plugin + local fixture model.")
            print("Verified the versioned failure matrix, structured restart interruption, durable replay, cron route/health policy, trusted run/call identity, exact tool allowlist, custom model proxy, scoped Claude prompt caching across turns and model overrides, incremental cached-model output, SSE payload/single-consumer behavior, admission replay/conflict, session tool history, concurrency rejection, and stop while awaiting context.")
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
