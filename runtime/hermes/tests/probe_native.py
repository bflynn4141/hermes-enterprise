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
            elif self.path.endswith("/models"):
                self.reply(200, {"object": "list", "data": [{"id": "test/fixture", "object": "model"}]})
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
            catalog_names.update(t["function"]["name"] for t in body.get("tools", []))
            messages = body["messages"]
            if messages[-1]["role"] == "tool":
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
            with log_file.open("w") as log:
                process = subprocess.Popen([sys.executable, str(ROOT / "start.py"), "--source", str(args.source),
                    "--python", str(args.python), "--workspace-id", "test-workspace", "--agent-id", agent_id,
                    "--enterprise-url", f"http://127.0.0.1:{server.server_port}", "--model", "test/fixture",
                    "--token-file", str(token_file), "--port", str(port), "--state-root", str(state_root)], stdout=log, stderr=log)
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
                    return response.code, json.loads(response.read())

            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise AssertionError("Native startup failed:\n" + log_file.read_text())
                if (profile / "api.key").exists():
                    native_key = (profile / "api.key").read_text().strip()
                    try:
                        if request("GET", "/v1/capabilities")[0] == 200:
                            break
                    except OSError:
                        pass
                time.sleep(0.2)
            else:
                raise AssertionError("Native startup timed out:\n" + log_file.read_text())
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
            assert catalog_names == {"enterprise_echo"}, catalog_names
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
            print("PASS: actual official gateway + AIAgent loop + plugin + local fixture model.")
            print("Verified trusted run/call identity, exact tool allowlist, custom model proxy, SSE payload/single-consumer behavior, admission replay/conflict, session tool history, concurrency rejection, and stop while awaiting context.")
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
