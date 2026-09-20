#!/usr/bin/env python3
"""Probe the opt-in Cloud policy in an ordinary pinned Hermes gateway.

The Enterprise and model endpoints are local fixtures. This proves process
startup, admission gating and drift response; it makes no provider or hosted
calls and does not establish model quality.
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
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
from datetime import datetime, timedelta, timezone
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from enterprise_bridge import assess_control_secret
from enterprise_bridge.packages import packaged_skills
from enterprise_bridge.runtime_policy import (
    EXPECTED_PLUGIN_SOURCES,
    build_skill_prompt_sections,
    plugin_tree_digest,
)


FINANCE = packaged_skills()["enterprise_bridge:partner-invoice-review"]
PARTNER = packaged_skills()["enterprise_bridge:partner-program-screening"]
WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
AGENT_ID = "22222222-2222-4222-8222-222222222222"
MODEL = "test/cloud-managed-fixture"
PLUGIN_REVISION = "3" * 40
PLUGIN_SOURCE = "git@github.com:bflynn4141/hermes-enterprise.git#runtime/hermes/enterprise_bridge"
FINANCE_TOOLS = ("get_partner_handoff_result", "list_requests", "get_request")
FINANCE_CAPABILITIES = (
    "partner.shared.read", "partner.invoice.read", "partner.invoice.review.prepare",
)
PARTNER_TOOLS = (
    "list_partner_candidates", "get_partner_candidate",
    "list_requests", "get_request", "get_approval_status", "get_document_text",
    "save_review_note", "set_context_field", "ask_for_context", "set_focus",
    "propose_request", "propose_approval", "propose_instruction",
)
PARTNER_CAPABILITIES = (
    "partner.discovery.read", "partner.review.prepare", "partner.outreach.draft",
    "partner.records.qualification.write", "partner.handoff.publish",
)
PARTNER_PROGRAM = {
    "program_name": "Hermes Partner Program",
    "source": "agentcash_people",
    "source_purpose": "person_partner_research",
    "organization_only": False,
    "no_outreach": True,
    "role_label": "Potential ecosystem lead",
    "search_queries": [],
    "intake_urls": [],
    "keywords": ["artificial intelligence", "developer relations"],
    "people_search": {
        "current_position_seniority_level": ["Founder", "Head", "Director"],
        "person_skills": ["Artificial Intelligence (AI)", "Developer Relations"],
        "current_position_titles": [],
        "person_locations": [],
        "offset": 0,
        "search_after": None,
    },
    "ranking_weights": {"relevance": 40, "activity": 25, "adoption": 20, "openness": 15},
    "minimum_priority": 40,
    "lookback_days": 365,
    "max_candidates": 5,
    "max_api_requests": 1,
    "minimum_rate_remaining": 0,
    "max_spend_usd": 0.15,
    "screening_dimensions": ["Track Record", "Capacity", "Fit"],
    "human_review_required": True,
}
PARTNER_CONFIG = {"partner_program": PARTNER_PROGRAM}


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def schema(name):
    properties = {"handoff_id": {"type": "string"}} if name == "get_partner_handoff_result" else {}
    return {
        "name": name,
        "description": "Local process-probe tool.",
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": list(properties),
            "additionalProperties": False,
        },
    }


def request(port, key, method, path, body=None, timeout=10):
    encoded = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": "Bearer " + key, "Accept": "application/json"}
    if encoded is not None:
        headers["Content-Type"] = "application/json"
        headers["Idempotency-Key"] = "cloud-managed-process-probe"
    call = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=encoded, method=method, headers=headers,
    )
    try:
        response = urllib.request.urlopen(call, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        try:
            payload = json.loads(raw) if raw else {}
        except (ValueError, UnicodeDecodeError):
            payload = raw.decode(errors="replace")
        return response.code, payload, dict(response.headers.items())


def config_for(port, worker_port, token, native_key, toolsets, *, role="finance"):
    from enterprise_bridge.cloud_managed import (
        AGENTCASH_POLICY, AGENTCASH_SERVER, install_enterprise_reader_toolset,
    )
    from start import managed_agent_config
    from toolsets import TOOLSETS

    install_enterprise_reader_toolset()
    base = f"http://127.0.0.1:{worker_port}/internal/runtime/w/{WORKSPACE_ID}/agents/{AGENT_ID}"
    partnership = role == "partner"
    skill = PARTNER if partnership else FINANCE
    skill_config = PARTNER_CONFIG if partnership else {"invoice_review": {
        "duplicate_window_days": 365,
        "require_engagement_evidence": True,
        "connector": "enterprise-partner-records",
        "human_review_required": True,
        "payment_execution_available": False,
    }}
    agent = managed_agent_config(TOOLSETS)
    if partnership:
        agent["disabled_toolsets"] = [
            name for name in agent["disabled_toolsets"] if name != "agentcash"
        ]
    return {
        "_config_version": 12,
        "model": {
            "provider": "custom", "default": MODEL,
            "base_url": base + "/model/v1", "api_mode": "chat_completions",
            "api_key": token,
        },
        "agent": agent,
        "platform_toolsets": {"api_server": list(toolsets)},
        "mcp_servers": {"agentcash": AGENTCASH_SERVER} if partnership else {},
        "tools": {"tool_search": {"enabled": "off"}},
        "plugins": {"enabled": ["enterprise_bridge"], "entries": {"enterprise_bridge": {"settings": {
            "base_url": base,
            "native_url": f"http://127.0.0.1:{port}",
            "request_timeout_seconds": 2,
            "pending_timeout_seconds": 30,
            "allowed_skills": [skill["name"]],
            "mcp_policy": AGENTCASH_POLICY if partnership else [],
            "partner_program": PARTNER_PROGRAM if partnership else {},
        }}}},
        "gateway": {
            "multiplex_profiles": False,
            "api_server": {"max_concurrent_runs": 1},
            "platforms": {"api_server": {"enabled": True, "extra": {
                "host": "127.0.0.1", "port": port, "key": native_key,
            }}},
        },
        "approvals": {"unattended_mode": "deny", "cron_mode": "deny"},
        "cron": {"allow_agent_scheduling": False},
        "memory": {"memory_enabled": False, "user_profile_enabled": False, "nudge_interval": 0},
        "skills": {
            "creation_nudge_interval": 0, "write_approval": True,
            "config": skill_config,
        },
        "auxiliary": {
            "background_review": {"enabled": False},
            "title_generation": {"enabled": False},
        },
        "curator": {"enabled": False},
    }


def assert_pinned_skill(model_call, package, *, absent):
    """The system prompt carries exactly the assigned verified skill text and no other."""
    manifest = {key: package[key] for key in ("name", "version", "artifact_digest")}
    system_text = "\n".join(
        str(message.get("content", "")) for message in model_call.get("messages", [])
        if message.get("role") == "system"
    )
    for section_id, text in build_skill_prompt_sections([manifest]):
        assert f"## Plugin Context: {section_id}" in system_text, section_id
        assert text in system_text, "assigned skill section is missing from the system prompt"
    other = {key: absent[key] for key in ("name", "version", "artifact_digest")}
    for _section_id, text in build_skill_prompt_sections([other]):
        assert text not in system_text, "an unassigned skill reached the system prompt"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, required=True)
    parser.add_argument("--python", type=pathlib.Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve()
    # Preserve the venv launcher path; resolving its interpreter symlink would
    # discard pyvenv.cfg and start the bare base interpreter.
    python = args.python.absolute()
    if not python.is_file():
        parser.error("pinned runtime Python is unavailable")
    sys.path.insert(0, str(source))

    token = secrets.token_hex(32)
    native_key = secrets.token_hex(32)
    control_key = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"
    assert assess_control_secret(control_key) is None
    mode = {"artifact": "valid", "tools": "valid", "role": "finance"}
    model_calls = []
    skills_gate = {
        "count": 0,
        "block_after": None,
        "blocked": threading.Event(),
        "release": threading.Event(),
        "lock": threading.Lock(),
    }

    class Fixture(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, body):
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def authorized(self):
            return self.headers.get("Authorization") == "Bearer " + token

        def do_GET(self):
            if not self.authorized():
                self.reply(401, {})
                return
            if self.path.endswith("/skills"):
                with skills_gate["lock"]:
                    skills_gate["count"] += 1
                    should_block = (
                        skills_gate["block_after"] is not None
                        and skills_gate["count"] > skills_gate["block_after"]
                    )
                    if should_block:
                        skills_gate["block_after"] = None
                if should_block:
                    skills_gate["blocked"].set()
                    if not skills_gate["release"].wait(15):
                        self.reply(503, {})
                        return
                partnership = mode["role"] == "partner"
                skill = PARTNER if partnership else FINANCE
                capabilities = PARTNER_CAPABILITIES if partnership else FINANCE_CAPABILITIES
                skill_config = PARTNER_CONFIG if partnership else {"invoice_review": {
                    "duplicate_window_days": 365,
                    "require_engagement_evidence": True,
                    "connector": "enterprise-partner-records",
                    "human_review_required": True,
                    "payment_execution_available": False,
                }}
                digest = skill["artifact_digest"] if mode["artifact"] == "valid" else "sha256:" + "0" * 64
                self.reply(200, {"skills": [{
                    "name": skill["name"], "runtime_name": skill["name"],
                    "skill_key": "partner-program-screening" if partnership else "partner-invoice-review",
                    "version": skill["version"],
                    "artifact_digest": digest, "auto_load": True,
                    "state": "active", "assignment_revision": None if partnership else 1,
                    "grant_revision": 1 if partnership else None,
                    "binding_source": "preflight_grant" if partnership else "enterprise_assignment",
                    "binding_state": "prepared" if partnership else None,
                    "grant_expires_at": (
                        (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
                        if partnership else None
                    ),
                    "capability_grants": list(capabilities),
                    "config": skill_config,
                }]})
            elif self.path.endswith("/tools"):
                names = list(PARTNER_TOOLS if mode["role"] == "partner" else FINANCE_TOOLS)
                if mode["tools"] == "drifted":
                    names.append("publish_partner_invoice_review")
                self.reply(200, {"tools": [schema(name) for name in names]})
            elif self.path.endswith("/model/v1/models") or self.path.endswith("/models"):
                self.reply(200, {"object": "list", "data": [{
                    "id": MODEL, "object": "model", "context_length": 131072,
                }]})
            else:
                self.reply(404, {})

        def do_POST(self):
            if self.path == "/v1/query":
                length = int(self.headers.get("Content-Length", "0"))
                self.rfile.read(length)
                self.reply(200, {"vulns": []})
                return
            if not self.authorized():
                self.reply(401, {})
                return
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            if self.path.endswith("/chat/completions"):
                model_calls.append(body)
                if body.get("stream"):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    for delta, reason in ((
                        {"role": "assistant", "content": "Local managed fixture complete."}, None,
                    ), ({}, "stop")):
                        chunk = {
                            "id": "fixture", "object": "chat.completion.chunk",
                            "created": int(time.time()), "model": MODEL,
                            "choices": [{"index": 0, "delta": delta, "finish_reason": reason}],
                        }
                        self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                else:
                    self.reply(200, {
                        "id": "fixture", "object": "chat.completion", "model": MODEL,
                        "choices": [{"index": 0, "message": {
                            "role": "assistant", "content": "Local managed fixture complete.",
                        }, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 4, "completion_tokens": 4, "total_tokens": 8},
                    })
            else:
                self.reply(404, {})

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    root = pathlib.Path(tempfile.mkdtemp(prefix="he-managed-", dir="/tmp"))
    processes = []
    reviewed_plugin_digest = plugin_tree_digest(ROOT / "enterprise_bridge")
    assert PLUGIN_SOURCE in EXPECTED_PLUGIN_SOURCES

    def start_case(
        name, *, artifact="valid", tools="valid", provider_escape=None, plugin_drift=False,
        seed_stale=True, managed=True, role="finance",
    ):
        mode.update(artifact=artifact, tools=tools, role=role)
        profile = root / name
        home = profile / "home"
        for path in (home / "plugins", home / "skills", profile / "os-home", profile / "workspace"):
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
        plugin_root = home / "plugins/enterprise_bridge"
        shutil.copytree(ROOT / "enterprise_bridge", plugin_root, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        assert plugin_tree_digest(plugin_root) == reviewed_plugin_digest, (
            "installer-shaped plugin copy differs from the reviewed tree"
        )
        (home / "plugins/.install-metadata.json").write_text(json.dumps({
            "enterprise_bridge": {
                "pinned": True,
                "revision": PLUGIN_REVISION,
                "source": PLUGIN_SOURCE,
            },
        }, indent=2) + "\n")
        if plugin_drift:
            with (plugin_root / "packages.py").open("a") as file:
                file.write("\n# executable plugin drift\n")
        (home / "skills/.no-bundled-skills").write_text("managed by Hermes Enterprise\n")
        port = free_port()
        partnership = role == "partner"
        agentcash_home = profile / "agentcash-home"
        if partnership:
            wallet = agentcash_home / ".agentcash/wallet.json"
            wallet.parent.mkdir(parents=True, mode=0o700)
            wallet.write_text("{}\n")
            bin_dir = profile / "bin"
            bin_dir.mkdir(mode=0o700)
            fake_npx = bin_dir / "npx"
            fake_npx.write_text(
                f"#!{python}\n"
                "from mcp.server import MCPServer\n"
                "server = MCPServer('agentcash-process-probe')\n"
                "@server.tool(name='fetch')\n"
                "def fetch(url: str) -> str:\n"
                "    return 'unused local process fixture: ' + url\n"
                "server.run()\n"
            )
            fake_npx.chmod(0o700)
        toolsets = ["enterprise_bridge", "enterprise_skill_reader"]
        if partnership:
            toolsets.append("agentcash")
        if tools == "drifted":
            toolsets.append("terminal")
        config = config_for(port, server.server_port, token, native_key, toolsets, role=role)
        if provider_escape == "fallback":
            config["fallback_providers"] = [{
                "provider": "openrouter", "model": "escape/model",
            }]
        elif provider_escape == "model-route":
            config["gateway"]["platforms"]["api_server"]["extra"]["model_routes"] = {
                "escape": {
                    "provider": "custom", "model": "escape/model",
                    "base_url": "https://escape.invalid/v1", "api_key": "escape-secret",
                },
            }
        (home / "config.yaml").write_text(json.dumps(config, indent=2) + "\n")
        readiness = home / "runtime-readiness.json"
        if seed_stale:
            readiness.write_text('{"stale":true}\n')
        env = {
            key: os.environ[key]
            for key in ("PATH", "LANG", "LC_ALL", "TZ", "TERM", "TMPDIR") if key in os.environ
        }
        env.update({
            "HOME": str(profile / "os-home"),
            "HERMES_HOME": str(home),
            "PYTHONPATH": str(source),
            "PYTHONNOUSERSITE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "ENTERPRISE_WORKSPACE_ID": WORKSPACE_ID,
            "ENTERPRISE_AGENT_ID": AGENT_ID,
            "ENTERPRISE_URL": f"http://127.0.0.1:{server.server_port}",
            "ENTERPRISE_RUNTIME_TOKEN": token,
            "API_SERVER_KEY": native_key,
            "API_SERVER_ENABLED": "true",
            "API_SERVER_HOST": "127.0.0.1",
            "API_SERVER_PORT": str(port),
            "HERMES_ENTERPRISE_NATIVE_URL": f"http://127.0.0.1:{port}",
            "HERMES_ENTERPRISE_MODEL": MODEL,
            "HERMES_ENTERPRISE_CONTROL_SECRET": control_key,
            "HERMES_ENTERPRISE_PLUGIN_REVISION": PLUGIN_REVISION,
            "HERMES_ENTERPRISE_PLUGIN_SHA256": reviewed_plugin_digest,
            "HERMES_AGENTCASH_MCP_ENABLED": "1" if partnership else "0",
            "HERMES_NATIVE_CRON_ENABLED": "0",
            "OSV_ENDPOINT": f"http://127.0.0.1:{server.server_port}/v1/query",
        })
        if partnership:
            env["PATH"] = str(profile / "bin") + os.pathsep + env.get("PATH", "")
            env["AGENTCASH_HOME"] = str(agentcash_home)
        if managed:
            env["HERMES_ENTERPRISE_CLOUD_MANAGED"] = "1"
        log = (profile / "gateway.log").open("w")
        process = subprocess.Popen(
            [str(python), "-m", "hermes_cli.main", "gateway", "run", "--external-supervisor"],
            cwd=profile / "workspace", env=env, stdout=log, stderr=log,
        )
        processes.append((process, log))
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if process.poll() is not None:
                log.flush()
                raise AssertionError(f"{name} gateway exited:\n" + (profile / "gateway.log").read_text())
            try:
                status, payload, _ = request(port, native_key, "GET", "/v1/capabilities", timeout=2)
                if status == 200 and payload.get("object") == "hermes.api_server.capabilities":
                    return profile, port, readiness
            except OSError:
                pass
            time.sleep(0.1)
        raise AssertionError(f"{name} gateway did not bind:\n" + (profile / "gateway.log").read_text())

    def stop_latest():
        process, log = processes.pop()
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
        log.close()

    try:
        before = len(model_calls)
        profile, port, readiness = start_case("stale-artifact", artifact="stale")
        deadline = time.monotonic() + 5
        while readiness.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not readiness.exists(), "stale readiness survived failed artifact validation"
        assert request(port, native_key, "GET", "/health")[0] == 503
        assert request(port, native_key, "POST", "/api/sessions/other/chat", {})[0] == 404
        assert request(port, native_key, "GET", "/api/jobs")[0] == 404
        assert request(port, native_key, "POST", "/v1/runs", {
            "input": "must stay closed", "provider": "custom", "model": MODEL,
        })[0] == 503
        assert len(model_calls) == before, "provider was called while artifact validation failed"
        stop_latest()

        profile, port, readiness = start_case("tool-drift", tools="drifted")
        deadline = time.monotonic() + 5
        while readiness.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not readiness.exists(), "stale readiness survived tool drift"
        assert request(port, native_key, "POST", "/v1/runs", {
            "input": "must stay closed", "provider": "custom", "model": MODEL,
        })[0] == 503
        assert len(model_calls) == before, "provider was called while tool inventory drifted"
        stop_latest()

        for name, escape in (("fallback-provider", "fallback"), ("model-route", "model-route")):
            profile, port, readiness = start_case(name, provider_escape=escape)
            deadline = time.monotonic() + 5
            while readiness.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            assert not readiness.exists(), f"stale readiness survived configured {escape}"
            assert request(port, native_key, "POST", "/v1/runs", {
                "input": "must stay closed", "provider": "custom", "model": MODEL,
            })[0] == 503
            assert len(model_calls) == before, f"provider was called with configured {escape}"
            stop_latest()

        profile, port, readiness = start_case("plugin-drift", plugin_drift=True)
        deadline = time.monotonic() + 5
        while readiness.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not readiness.exists(), "stale readiness survived executable plugin drift"
        assert request(port, native_key, "POST", "/v1/runs", {
            "input": "must stay closed", "provider": "custom", "model": MODEL,
        })[0] == 503
        assert len(model_calls) == before, "provider was called with drifted plugin bytes"
        stop_latest()

        profile, port, readiness = start_case("post-accept-drift", seed_stale=False)
        deadline = time.monotonic() + 60
        while not readiness.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        if not readiness.exists():
            raise AssertionError(
                "post-accept drift case never became ready:\n" + (profile / "gateway.log").read_text()
            )
        skills_gate["blocked"].clear()
        skills_gate["release"].clear()
        with skills_gate["lock"]:
            # The route check consumes the next refresh. The execution-boundary
            # check then blocks inside authenticated discovery after HTTP 202.
            skills_gate["block_after"] = skills_gate["count"] + 1
        accepted = request(port, native_key, "POST", "/v1/runs", {
            "input": "must close between acceptance and provider execution",
            "session_id": "managed-post-accept-drift", "provider": "custom", "model": MODEL,
        })
        assert accepted[0] == 202, accepted
        if not skills_gate["blocked"].wait(10):
            with skills_gate["lock"]:
                gate_snapshot = {
                    "count": skills_gate["count"],
                    "block_after": skills_gate["block_after"],
                }
            raise AssertionError(
                "provider-boundary refresh did not pause after 202; "
                f"gate={gate_snapshot} model_calls={len(model_calls)} readiness={readiness.exists()}\n"
                + (profile / "gateway.log").read_text()
            )
        config_path = profile / "home/config.yaml"
        changed = json.loads(config_path.read_text())
        changed["auxiliary"]["background_review"]["enabled"] = True
        config_path.write_text(json.dumps(changed, indent=2) + "\n")
        calls_before_release = len(model_calls)
        skills_gate["release"].set()
        deadline = time.monotonic() + 10
        while readiness.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not readiness.exists(), "post-202 drift did not close managed readiness"
        time.sleep(0.2)
        assert len(model_calls) == calls_before_release, "provider was called after post-202 drift"
        stop_latest()

        profile, port, readiness = start_case("lost-managed-flag", seed_stale=False)
        deadline = time.monotonic() + 60
        while not readiness.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        if not readiness.exists():
            raise AssertionError(
                "managed restart case never became ready:\n" + (profile / "gateway.log").read_text()
            )
        marker = profile / "home/enterprise-cloud-managed.json"
        assert marker.is_file(), "managed profile marker was not persisted"
        stop_latest()
        profile, port, readiness = start_case(
            "lost-managed-flag", seed_stale=False, managed=False,
        )
        assert request(port, native_key, "GET", "/health")[0] == 200
        calls_before_downgrade = len(model_calls)
        from enterprise_bridge.dashboard.plugin_api import NativeControl
        with patch.dict(os.environ, {
            "HERMES_HOME": str(profile / "home"),
            "HERMES_ENTERPRISE_NATIVE_URL": f"http://127.0.0.1:{port}",
            "API_SERVER_KEY": native_key,
        }):
            downgraded_status, downgraded_body = NativeControl().dispatch({
                "operation": "submit",
                "idempotency_key": "managed-lost-flag",
                "body": {"input": "must remain closed after losing the managed flag"},
            })
        assert downgraded_status == 503, downgraded_body
        assert downgraded_body["code"] == "native_readiness_unavailable"
        assert len(model_calls) == calls_before_downgrade, "connector reached provider after flag loss"
        stop_latest()

        profile, port, readiness = start_case("ready", seed_stale=False)
        deadline = time.monotonic() + 60
        while not readiness.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        if not readiness.exists():
            raise AssertionError("managed readiness was not written:\n" + (profile / "gateway.log").read_text())
        document = json.loads(readiness.read_text())
        assert document["managed_cloud"] is True and document["boot_id"]
        assert document["plugin"] == {
            "name": "enterprise_bridge", "version": "1.7.0",
            "revision": PLUGIN_REVISION, "artifact_digest": reviewed_plugin_digest,
        }
        assert document["skills"] == [{
            "name": FINANCE["name"], "version": FINANCE["version"],
            "artifact_digest": FINANCE["artifact_digest"],
            "content_digest": FINANCE["content_digest"],
        }]
        assert set(document["tools"]) == {*FINANCE_TOOLS, "skill_view"}
        status, _, headers = request(port, native_key, "GET", "/health")
        assert status == 200
        normalized_headers = {key.lower(): value for key, value in headers.items()}
        assert normalized_headers.get("x-hermes-enterprise-boot") == document["boot_id"]
        assert normalized_headers.get("x-hermes-enterprise-readiness-sha256")
        with patch.dict(os.environ, {
            "HERMES_HOME": str(profile / "home"),
            "HERMES_ENTERPRISE_NATIVE_URL": f"http://127.0.0.1:{port}",
            "API_SERVER_KEY": native_key,
        }):
            dashboard_status, dashboard_readiness = NativeControl().dispatch({"operation": "readiness"})
        assert dashboard_status == 200
        assert dashboard_readiness["agent_id"] == AGENT_ID
        assert dashboard_readiness["plugin"] == document["plugin"]
        assert dashboard_readiness["skills"] == document["skills"]

        accepted = request(port, native_key, "POST", "/v1/runs", {
            "input": "Return one short sentence without tools.",
            "session_id": "managed-process-probe", "provider": "custom", "model": MODEL,
        })
        assert accepted[0] == 202, accepted
        deadline = time.monotonic() + 60
        while len(model_calls) == before and time.monotonic() < deadline:
            time.sleep(0.05)
        assert len(model_calls) > before, (
            "ready native submission never reached the local model fixture: "
            + (profile / "gateway.log").read_text()
        )
        assert_pinned_skill(model_calls[-1], FINANCE, absent=PARTNER)

        plugin_path = profile / "home/plugins/enterprise_bridge/packages.py"
        with plugin_path.open("a") as file:
            file.write("\n# drift after readiness\n")
        calls_before_drift = len(model_calls)
        assert request(port, native_key, "POST", "/v1/runs", {
            "input": "must close after plugin drift", "provider": "custom", "model": MODEL,
        })[0] == 503
        assert not readiness.exists(), "plugin drift did not remove managed readiness"
        assert len(model_calls) == calls_before_drift, "provider was called after managed plugin drift"
        stop_latest()

        partner_before = len(model_calls)
        profile, port, readiness = start_case(
            "partner-preflight", seed_stale=False, role="partner",
        )
        deadline = time.monotonic() + 150
        while not readiness.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        if not readiness.exists():
            raise AssertionError(
                "P1.7 preflight case never became ready:\n"
                + (profile / "gateway.log").read_text()
            )
        document = json.loads(readiness.read_text())
        assert document["agentcash_enabled"] is True
        assert document["skills"] == [{
            "name": PARTNER["name"], "version": PARTNER["version"],
            "artifact_digest": PARTNER["artifact_digest"],
            "content_digest": PARTNER["content_digest"],
        }]
        assert set(document["tools"]) == {
            *PARTNER_TOOLS, "skill_view", "mcp__agentcash__fetch",
        }
        status, _, headers = request(port, native_key, "GET", "/health")
        assert status == 200
        normalized_headers = {key.lower(): value for key, value in headers.items()}
        assert normalized_headers.get("x-hermes-enterprise-boot") == document["boot_id"]
        assert normalized_headers.get("x-hermes-enterprise-readiness-sha256")
        accepted = request(port, native_key, "POST", "/v1/runs", {
            "input": "Return one short sentence without tools.",
            "session_id": "managed-partner-preflight-probe",
            "provider": "custom", "model": MODEL,
        })
        assert accepted[0] == 202, accepted
        deadline = time.monotonic() + 60
        while len(model_calls) == partner_before and time.monotonic() < deadline:
            time.sleep(0.05)
        assert len(model_calls) > partner_before, (
            "ready P1.7 submission never reached the local model fixture: "
            + (profile / "gateway.log").read_text()
        )
        assert_pinned_skill(model_calls[-1], PARTNER, absent=FINANCE)
        stop_latest()

        print("PASS: ordinary pinned Hermes Cloud gateway installs the gate before fallible registration validation.")
        print("Verified pre-ready capabilities, stale/artifact/tool/config rejection, post-202 provider gating, lost-flag restart closure, exact Finance and authenticated P1.7 preflight readiness (including local AgentCash MCP discovery), live boot-bound health, and dynamic post-ready closure using local fixtures only.")
    finally:
        while processes:
            stop_latest()
        server.shutdown()
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
