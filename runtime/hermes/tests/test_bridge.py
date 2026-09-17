import json
import io
import pathlib
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import enterprise_bridge as plugin
from start import (
    assert_native_cron_empty,
    clean_environment,
    load_enterprise_skills,
    load_mcp_servers,
    native_cron_route,
    reset_managed_skill_home,
    validate_profile_path,
)

RUN_ID = "run_" + "a" * 32


class BridgeTests(unittest.TestCase):
    def bridge(self):
        return plugin.Bridge("https://enterprise.example/internal/runtime/w/w/agents/a", "test-token",
                             "http://127.0.0.1:8642", "native-token")

    def test_mapping_and_pending_preserve_identical_call(self):
        bridge = self.bridge()
        replies = iter([(200, {"status": "running"}), (409, {"reason": "mapping_pending"}),
                        (200, {"status": "running"}), (202, {"status": "pending"}),
                        (200, {"status": "running"}), (200, {"ok": True, "content": "result"})])
        calls = []

        def request(method, url, token, body=None):
            if body is not None:
                calls.append(body)
            return next(replies)

        with patch.object(bridge, "request", side_effect=request), patch.object(plugin, "trusted_identity", return_value=(RUN_ID, "call_actual")), patch.object(plugin.time, "sleep"):
            self.assertEqual(bridge.call("enterprise_echo", {"runtime_run_id": "spoofed"}), "result")
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(call == calls[0] for call in calls))
        self.assertEqual(calls[0]["runtime_run_id"], RUN_ID)
        self.assertEqual(calls[0]["tool_call_id"], "call_actual")

    def test_stop_ends_pending_without_another_call(self):
        bridge = self.bridge()
        replies = [(200, {"status": "running"}), (202, {"status": "pending"}), (200, {"status": "stopping"})]
        with patch.object(bridge, "request", side_effect=replies) as request, patch.object(plugin, "trusted_identity", return_value=(RUN_ID, "call_actual")), patch.object(plugin.time, "sleep"):
            result = json.loads(bridge.handler("enterprise_echo")({}))
        self.assertIn("stopping", result["error"])
        self.assertEqual(request.call_count, 3)

    def test_uncertain_transport_is_not_retried_or_exposed(self):
        bridge = self.bridge()
        with patch.object(bridge.opener, "open", side_effect=urllib.error.URLError("secret=DO_NOT_LEAK")) as request:
            with self.assertRaises(plugin.BridgeError) as raised:
                bridge.request("POST", bridge.base_url + "/calls", bridge.token, {})
        self.assertEqual(request.call_count, 1)
        self.assertIn("unknown", str(raised.exception))
        self.assertNotIn("DO_NOT_LEAK", str(raised.exception))

    def test_external_cleartext_and_redirect_are_rejected(self):
        with self.assertRaises(plugin.BridgeError):
            plugin.Bridge("http://enterprise.example", "token", "http://127.0.0.1:1", "token")
        with self.assertRaises(plugin.BridgeError):
            plugin.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example")

    def test_missing_trusted_context_fails_closed(self):
        bridge = self.bridge()
        with patch.object(plugin, "trusted_identity", side_effect=plugin.BridgeError("missing context")), patch.object(bridge, "request") as request:
            result = json.loads(bridge.handler("enterprise_echo")({"runtime_run_id": RUN_ID, "tool_call_id": "spoof"}))
        self.assertEqual(result, {"error": "missing context"})
        request.assert_not_called()

    def test_duplicate_schema_fails_closed(self):
        bridge = self.bridge()
        tool = {"name": "enterprise_echo", "parameters": {"type": "object"}}
        with patch.object(bridge, "request", return_value=(200, {"tools": [tool, tool]})):
            with self.assertRaises(plugin.BridgeError):
                bridge.tools()

    def test_plugin_registers_the_packaged_partner_skill(self):
        class Context:
            def __init__(self):
                self.skills = []
                self.hook = None

            def get_config(self, name, default=""):
                return {
                    "base_url": "https://enterprise.example/internal/runtime/w/w/agents/a",
                    "native_url": "http://127.0.0.1:8642",
                    "allowed_skills": ["enterprise_bridge:partner-program-screening"],
                }.get(name, default)

            def register_hook(self, _name, callback):
                self.hook = callback
                return None

            def register_skill(self, **kwargs):
                self.skills.append(kwargs)
                return object()

            def register_tool(self, **_kwargs):
                return object()

        context = Context()
        with patch.dict(plugin.os.environ, {
            "ENTERPRISE_RUNTIME_TOKEN": "enterprise-runtime-token",
            "API_SERVER_KEY": "native-runtime-token",
        }), patch.object(plugin.Bridge, "tools", return_value=[]):
            plugin.register(context)
        self.assertEqual(context.skills[0]["name"], "partner-program-screening")
        self.assertTrue(context.skills[0]["path"].is_file())
        self.assertIsNone(context.hook("skill_view", {"name": "enterprise_bridge:partner-program-screening"}))
        self.assertEqual(context.hook("skill_view", {"name": "other"})["action"], "block")
        self.assertEqual(context.hook("skill_manage", {})["action"], "block")

    def test_plugin_allows_only_bounded_agentcash_calls(self):
        class Context:
            def __init__(self):
                self.hook = None

            def get_config(self, name, default=""):
                return {
                    "base_url": "https://enterprise.example/internal/runtime/w/w/agents/a",
                    "native_url": "http://127.0.0.1:8642",
                    "allowed_skills": [],
                    "mcp_policy": [{
                        "server": "agentcash",
                        "tools": ["get_balance", "discover_api_endpoints", "check_endpoint_schema", "fetch"],
                        "allowed_hosts": ["stableenrich.dev", "stablesocial.dev"],
                        "max_amount_usd": 0.2,
                    }],
                }.get(name, default)

            def register_hook(self, _name, callback):
                self.hook = callback

            def register_skill(self, **_kwargs):
                return object()

            def register_tool(self, **_kwargs):
                return object()

        context = Context()
        with patch.dict(plugin.os.environ, {
            "ENTERPRISE_RUNTIME_TOKEN": "enterprise-runtime-token",
            "API_SERVER_KEY": "native-runtime-token",
        }), patch.object(plugin.Bridge, "tools", return_value=[]):
            plugin.register(context)
        self.assertIsNone(context.hook("mcp__agentcash__get_balance", {}))
        self.assertIsNone(context.hook("mcp__agentcash__discover_api_endpoints", {
            "url": "https://stableenrich.dev",
        }))
        self.assertIsNone(context.hook("mcp__agentcash__fetch", {
            "url": "https://stablesocial.dev/api/search", "maxAmount": 0.06,
        }))
        self.assertIn("host allowlist", context.hook("mcp__agentcash__fetch", {
            "url": "https://example.com", "maxAmount": 0.01,
        })["message"])
        self.assertIn("spend cap", context.hook("mcp__agentcash__fetch", {
            "url": "https://stablesocial.dev/api/search", "maxAmount": 0.21,
        })["message"])
        self.assertEqual(context.hook("mcp__agentcash__bridge", {})["action"], "block")

    def test_successful_people_search_is_imported_by_post_tool_hook(self):
        class Context:
            def __init__(self):
                self.hooks = {}

            def get_config(self, name, default=""):
                return {
                    "base_url": "https://enterprise.example/internal/runtime/w/w/agents/a",
                    "native_url": "http://127.0.0.1:8642",
                    "allowed_skills": [],
                    "mcp_policy": [{
                        "server": "agentcash",
                        "tools": ["fetch"],
                        "allowed_hosts": ["stableenrich.dev"],
                        "max_amount_usd": 0.2,
                    }],
                }.get(name, default)

            def register_hook(self, name, callback):
                self.hooks[name] = callback

            def register_skill(self, **_kwargs):
                return object()

            def register_tool(self, **_kwargs):
                return object()

        context = Context()
        with patch.dict(plugin.os.environ, {
            "ENTERPRISE_RUNTIME_TOKEN": "enterprise-runtime-token",
            "API_SERVER_KEY": "native-runtime-token",
        }), patch.object(plugin.Bridge, "tools", return_value=[]), \
                patch.object(plugin.Bridge, "import_people_search") as imported, \
                patch.object(plugin, "trusted_post_identity", return_value=(RUN_ID, "call_people")):
            plugin.register(context)
            context.hooks["post_tool_call"](
                tool_name="mcp__agentcash__fetch",
                args={
                    "url": "https://stableenrich.dev/api/fullenrich/people-search",
                    "method": "POST",
                    "maxAmount": 0.15,
                    "body": {"person_skills": ["Artificial Intelligence (AI)"]},
                },
                result=json.dumps({"people": [], "companies": {}, "metadata": {"total": 0}}),
                tool_call_id="call_people",
            )
        imported.assert_called_once()

    def test_post_tool_hook_ignores_other_agentcash_fetches(self):
        class Context:
            hooks = {}

            def get_config(self, name, default=""):
                return {
                    "base_url": "https://enterprise.example/internal/runtime/w/w/agents/a",
                    "native_url": "http://127.0.0.1:8642",
                    "allowed_skills": [],
                    "mcp_policy": [{
                        "server": "agentcash", "tools": ["fetch"],
                        "allowed_hosts": ["stableenrich.dev"], "max_amount_usd": 0.2,
                    }],
                }.get(name, default)

            def register_hook(self, name, callback):
                self.hooks[name] = callback

            def register_skill(self, **_kwargs):
                return object()

            def register_tool(self, **_kwargs):
                return object()

        context = Context()
        with patch.dict(plugin.os.environ, {
            "ENTERPRISE_RUNTIME_TOKEN": "enterprise-runtime-token",
            "API_SERVER_KEY": "native-runtime-token",
        }), patch.object(plugin.Bridge, "tools", return_value=[]), \
                patch.object(plugin.Bridge, "import_people_search") as imported:
            plugin.register(context)
            context.hooks["post_tool_call"](
                tool_name="mcp__agentcash__fetch",
                args={"url": "https://stableenrich.dev/api/exa/search", "method": "POST", "maxAmount": 0.15},
                result="{}",
                tool_call_id="call_other",
            )
        imported.assert_not_called()

    def test_cloud_control_auth_is_absent_without_a_secret(self):
        class Context:
            def register_dashboard_auth_provider(self, _provider):
                raise AssertionError("provider must not be registered")

        with patch.dict(plugin.os.environ, {}, clear=True):
            self.assertIsNone(plugin.register_control_auth(Context()))

    def test_cloud_control_secret_strength_fails_closed(self):
        self.assertIsNotNone(plugin.assess_control_secret("short"))
        self.assertIsNotNone(plugin.assess_control_secret("a" * 64))
        self.assertIsNone(plugin.assess_control_secret("0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"))

    def test_enterprise_skill_manifest_is_bounded_and_non_secret(self):
        payload = {"skills": [{
            "name": "enterprise_bridge:partner-program-screening", "version": "1.2.0",
            "auto_load": True, "config": {"partner_program": {"no_outreach": True}},
        }]}

        class Response(io.BytesIO):
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

        class Opener:
            def __init__(self, body):
                self.body = body

            def open(self, request, timeout=0):
                self.request, self.timeout = request, timeout
                return Response(json.dumps(self.body).encode())

        opener = Opener(payload)
        result = load_enterprise_skills("https://enterprise.example/internal/runtime/w/w/agents/a", "token", opener)
        self.assertEqual(result["auto_load"], ["enterprise_bridge:partner-program-screening"])
        self.assertEqual(result["config"]["partner_program"]["no_outreach"], True)
        self.assertEqual(opener.request.get_header("Authorization"), "Bearer token")
        self.assertEqual(opener.request.get_header("User-agent"), "Hermes-Enterprise-Bridge/1.0")
        with self.assertRaisesRegex(RuntimeError, "credentials"):
            load_enterprise_skills(
                "https://enterprise.example/internal/runtime/w/w/agents/a", "token",
                Opener({"skills": [{**payload["skills"][0], "config": {"api_key": "no"}}]}),
            )
        with self.assertRaisesRegex(RuntimeError, "HTTPS"):
            load_enterprise_skills("http://enterprise.example/runtime", "token", opener)

    def test_enterprise_profile_removes_unmanaged_bundled_skills(self):
        with tempfile.TemporaryDirectory() as temporary:
            profile = pathlib.Path(temporary)
            old = profile / "home/skills/bundled/example"
            old.mkdir(parents=True)
            (old / "SKILL.md").write_text("old")
            reset_managed_skill_home(profile)
            self.assertFalse(old.exists())
            self.assertEqual(
                (profile / "home/skills/.no-bundled-skills").read_text(),
                "managed by Hermes Enterprise\n",
            )

    def test_personal_environment_does_not_survive(self):
        with patch.dict(plugin.os.environ, {"OPENROUTER_API_KEY": "private", "TELEGRAM_BOT_TOKEN": "private", "HTTP_PROXY": "private", "HERMES_SESSION_KEY": "spoof"}):
            env = clean_environment(pathlib.Path("/source"), pathlib.Path("/isolated"), "runtime", "native")
        for name in ("OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN", "HTTP_PROXY", "HERMES_SESSION_KEY"):
            self.assertNotIn(name, env)
        self.assertEqual(env["HOME"], "/isolated/os-home")
        self.assertEqual(env["HERMES_HOME"], "/isolated/home")

    def test_mcp_config_is_explicit_allowlisted_and_secret_values_are_not_persisted(self):
        raw = json.dumps({"lookup": {
            "command": "/opt/lookup-mcp", "args": ["serve"],
            "env": {"LOOKUP_TOKEN": "${SCOPED_LOOKUP_TOKEN}"},
            "tools": {"include": ["find_person"]},
            "policy": {"allowed_hosts": [], "max_amount_usd": 0},
        }})
        servers, policies, environment = load_mcp_servers(raw, {"SCOPED_LOOKUP_TOKEN": "secret-value"})
        self.assertEqual(servers["lookup"]["env"], {"LOOKUP_TOKEN": "${SCOPED_LOOKUP_TOKEN}"})
        self.assertEqual(environment, {"SCOPED_LOOKUP_TOKEN": "secret-value"})
        self.assertNotIn("secret-value", json.dumps({"servers": servers, "policies": policies}))
        with self.assertRaisesRegex(RuntimeError, "tools.include"):
            load_mcp_servers(json.dumps({"wide": {"command": "tool", "tools": {"include": []}}}), {})
        with self.assertRaisesRegex(RuntimeError, "scoped variables"):
            load_mcp_servers(json.dumps({"leaky": {
                "command": "tool", "env": {"TOKEN": "literal-secret"},
                "tools": {"include": ["read"]},
            }}), {})

    def test_agentcash_demo_is_pinned_and_uses_a_dedicated_home_reference(self):
        servers, policies, environment = load_mcp_servers(
            "", {"AGENTCASH_HOME": "/srv/hermes-agentcash"}, agentcash_enabled=True,
        )
        self.assertEqual(servers["agentcash"]["args"], ["--yes", "agentcash@0.17.1"])
        self.assertEqual(servers["agentcash"]["tools"]["include"], [
            "get_balance", "discover_api_endpoints", "check_endpoint_schema", "fetch",
        ])
        self.assertEqual(environment, {"AGENTCASH_HOME": "/srv/hermes-agentcash"})
        self.assertEqual(policies[0]["max_amount_usd"], 0.2)
        with self.assertRaisesRegex(RuntimeError, "dedicated directory"):
            load_mcp_servers("", {"AGENTCASH_HOME": str(pathlib.Path.home())}, agentcash_enabled=True)

    def test_watchdog_guard_uses_real_socket_suffix_and_launch_pid(self):
        agent_id = "44444444-4444-4444-8444-444444444444"
        with self.assertRaises(ValueError):
            validate_profile_path(pathlib.Path("/Users/gia/.hermes-enterprise") / agent_id, "darwin", pid=83824)
        validate_profile_path(pathlib.Path("/Users/gia/.he-runtime") / agent_id, "darwin", pid=83824)
        with self.assertRaises(ValueError):
            validate_profile_path(pathlib.Path("/Users/gia/.he-runtime") / agent_id, "darwin", pid=2147483647)

    def test_watchdog_guard_counts_utf8_bytes(self):
        profile = pathlib.Path("/" + "é" * 35)
        self.assertLess(len(str(profile / "home/state/gateway.loop-tick.2147483647.sock")), 104)
        with self.assertRaises(ValueError):
            validate_profile_path(profile, "darwin", pid=83824)

    def test_native_cron_store_must_stay_empty(self):
        assert_native_cron_empty(lambda: [])
        with self.assertRaisesRegex(RuntimeError, "must not contain"):
            assert_native_cron_empty(lambda: [{"id": "outside-enterprise-admission"}])

    def test_native_cron_routes_are_identified_for_launcher_filtering(self):
        for path in ("/api/jobs", "/api/jobs/a", "/api/jobs/a/run", "/api/cron/fire"):
            self.assertTrue(native_cron_route(path), path)
        for path in ("/health", "/v1/capabilities", "/v1/runs", "/v1/runs/id/stop"):
            self.assertFalse(native_cron_route(path), path)


if __name__ == "__main__":
    unittest.main()
