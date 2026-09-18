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
from enterprise_bridge.dashboard.plugin_api import NativeControl
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
PEOPLE_PROGRAM = {
    "source": "agentcash_people",
    "max_spend_usd": 0.15,
    "people_search": {
        "current_position_seniority_level": ["Founder", "Head"],
        "person_skills": ["Artificial Intelligence (AI)"],
        "current_position_titles": [],
        "person_locations": [],
    },
}
PEOPLE_ARGS = {
    "url": "https://stableenrich.dev/api/fullenrich/people-search",
    "method": "POST",
    "maxAmount": 0.15,
    "body": {
        "current_position_seniority_level": ["Founder", "Head"],
        "person_skills": ["Artificial Intelligence (AI)"],
        "excludeFields": ["educations", "languages"],
        "include_employment_history": False,
        "verbose": False,
        "offset": 0,
    },
}
CONTACT_ARGS = {
    "url": "https://stableenrich.dev/api/minerva/enrich",
    "method": "POST",
    "maxAmount": 0.05,
    "body": {
        "records": [{
            "record_id": "123e4567-e89b-12d3-a456-426614174000",
            "linkedin_url": "https://www.linkedin.com/in/example",
        }],
        "return_fields": ["full_name", "linkedin_url", "professional_emails", "phones", "twitter_url", "facebook_url"],
    },
}
CREATOR_ARGS = plugin.AGENTCASH_CREATOR_SEARCH_ARGUMENTS
X_CREATOR_ARGS = plugin.AGENTCASH_X_CREATOR_SEARCH_ARGUMENTS


class BridgeTests(unittest.TestCase):
    def bridge(self):
        return plugin.Bridge("https://enterprise.example/internal/runtime/w/w/agents/a", "test-token",
                             "http://127.0.0.1:8642", "native-token")

    def test_dashboard_readiness_attests_identity_and_wallet_without_exposing_it(self):
        with tempfile.TemporaryDirectory() as directory:
            wallet = pathlib.Path(directory) / ".agentcash" / "wallet.json"
            wallet.parent.mkdir()
            wallet.write_text('{"private":"never-return-this"}')
            with patch.dict(plugin.os.environ, {}, clear=False), patch.dict(
                __import__("os").environ,
                {
                    "API_SERVER_KEY": "native-token",
                    "ENTERPRISE_WORKSPACE_ID": "workspace-1",
                    "ENTERPRISE_AGENT_ID": "agent-1",
                    "ENTERPRISE_URL": "https://enterprise.example",
                    "HERMES_AGENTCASH_MCP_ENABLED": "1",
                    "HERMES_NATIVE_CRON_ENABLED": "0",
                    "AGENTCASH_HOME": directory,
                },
                clear=False,
            ):
                status, body = NativeControl().dispatch({"operation": "readiness"})
            self.assertEqual(status, 200)
            self.assertTrue(body["agentcash_wallet_present"])
            self.assertEqual(body["agent_id"], "agent-1")
            self.assertNotIn("never-return-this", json.dumps(body))

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

    def test_people_import_uses_observer_sized_timeout(self):
        bridge = self.bridge()
        with patch.object(bridge, "request", return_value=(201, {"ok": True})) as request:
            bridge.import_people_search(RUN_ID, "call_people", PEOPLE_ARGS, "{}")
        self.assertEqual(request.call_args.kwargs["timeout"], 25.0)

    def test_people_import_reports_only_safe_rejection_metadata(self):
        bridge = self.bridge()
        with patch.object(bridge, "request", return_value=(422, {
            "error": "raw provider body must not be logged",
            "reason": "partner_source_invalid_response",
        })):
            with self.assertRaises(plugin.BridgeError) as raised:
                bridge.import_people_search(RUN_ID, "call_people", PEOPLE_ARGS, "{}")
        self.assertEqual(
            str(raised.exception),
            "AgentCash People Search evidence import failed (422 partner_source_invalid_response).",
        )

    def test_creator_authorization_reports_only_safe_rejection_metadata(self):
        bridge = self.bridge()
        with patch.object(bridge, "request", return_value=(403, {
            "error": "raw database detail must not be logged",
            "reason": "partner_creator_search_not_authorized",
        })):
            with self.assertRaises(plugin.BridgeError) as raised:
                bridge.authorize_creator_search(RUN_ID, "call_creator", CREATOR_ARGS)
        self.assertEqual(
            str(raised.exception),
            "AgentCash creator-search authorization was rejected "
            "(403 partner_creator_search_not_authorized).",
        )

    def test_startup_recovery_replays_only_the_leased_spill_file(self):
        bridge = self.bridge()
        with tempfile.TemporaryDirectory() as directory:
            spill = pathlib.Path(directory) / "cache" / "spillover"
            spill.mkdir(parents=True)
            (spill / "call_people.txt").write_text('{"people":[]}', encoding="utf-8")
            pending = {
                "runtime_run_id": RUN_ID,
                "tool_call_id": "call_people",
                "arguments": PEOPLE_ARGS,
            }
            with patch.dict(plugin.os.environ, {"HERMES_HOME": directory}), \
                    patch.object(bridge, "request", return_value=(200, pending)) as request, \
                    patch.object(bridge, "import_people_search", return_value={"ok": True}) as imported:
                self.assertEqual(bridge.recover_pending_people_search(PEOPLE_ARGS), {"ok": True})
        self.assertEqual(request.call_args.kwargs["timeout"], 25.0)
        imported.assert_called_once_with(RUN_ID, "call_people", PEOPLE_ARGS, '{"people":[]}')

    def test_startup_recovery_rejects_a_symlinked_spill_file(self):
        bridge = self.bridge()
        with tempfile.TemporaryDirectory() as directory:
            spill = pathlib.Path(directory) / "cache" / "spillover"
            spill.mkdir(parents=True)
            target = pathlib.Path(directory) / "outside.txt"
            target.write_text('{"people":[]}', encoding="utf-8")
            (spill / "call_people.txt").symlink_to(target)
            pending = {
                "runtime_run_id": RUN_ID,
                "tool_call_id": "call_people",
                "arguments": PEOPLE_ARGS,
            }
            with patch.dict(plugin.os.environ, {"HERMES_HOME": directory}), \
                    patch.object(bridge, "request", return_value=(200, pending)), \
                    patch.object(bridge, "import_people_search") as imported:
                with self.assertRaises(plugin.BridgeError):
                    bridge.recover_pending_people_search(PEOPLE_ARGS)
        imported.assert_not_called()

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

    def test_warm_profile_discovers_its_managed_skill_and_agentcash_policy(self):
        class Context:
            def __init__(self):
                self.skills = []
                self.hook = None

            def get_config(self, name, default=""):
                return {
                    "base_url": "https://enterprise.example/internal/runtime/w/w/agents/a",
                    "native_url": "http://127.0.0.1:8642",
                }.get(name, default)

            def register_hook(self, _name, callback):
                self.hook = callback

            def register_skill(self, **kwargs):
                self.skills.append(kwargs)
                return object()

            def register_tool(self, **_kwargs):
                return object()

        manifest = {
            "name": "enterprise_bridge:partner-program-screening",
            "version": "1.7.0",
            "auto_load": True,
            "config": {"partner_program": PEOPLE_PROGRAM},
        }
        context = Context()
        with patch.dict(plugin.os.environ, {
            "ENTERPRISE_RUNTIME_TOKEN": "enterprise-runtime-token",
            "API_SERVER_KEY": "native-runtime-token",
            "HERMES_AGENTCASH_MCP_ENABLED": "1",
        }), patch.object(plugin.Bridge, "skills", return_value=[manifest]), \
                patch.object(plugin.Bridge, "tools", return_value=[]), \
                patch.object(plugin, "trusted_hook_identity", return_value=(RUN_ID, "call_people")), \
                patch.object(plugin.Bridge, "authorize_people_search"):
            plugin.register(context)
            self.assertEqual([skill["name"] for skill in context.skills], ["partner-program-screening"])
            self.assertIsNone(context.hook("skill_view", {"name": manifest["name"]}))
            self.assertIsNone(context.hook("mcp__agentcash__fetch", PEOPLE_ARGS, tool_call_id="unused"))

    def test_plugin_allows_only_bounded_agentcash_calls(self):
        class Context:
            def __init__(self):
                self.hook = None

            def get_config(self, name, default=""):
                return {
                    "base_url": "https://enterprise.example/internal/runtime/w/w/agents/a",
                    "native_url": "http://127.0.0.1:8642",
                    "allowed_skills": [],
                    "partner_program": PEOPLE_PROGRAM,
                    "mcp_policy": [{
                        "server": "agentcash",
                        "tools": ["fetch"],
                        "allowed_hosts": ["stableenrich.dev"],
                        "max_amount_usd": 0.15,
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
        }), patch.object(plugin.Bridge, "tools", return_value=[]), \
                patch.object(plugin.Bridge, "skills", return_value=[]), \
                patch.object(plugin, "trusted_hook_identity", return_value=(RUN_ID, "call_people")), \
                patch.object(plugin.Bridge, "authorize_people_search") as authorized:
            plugin.register(context)
            self.assertIsNone(context.hook("mcp__agentcash__fetch", PEOPLE_ARGS, tool_call_id="call_people"))
            authorized.assert_called_once_with(RUN_ID, "call_people", PEOPLE_ARGS)
        self.assertIn("allowlist", context.hook("mcp__agentcash__get_balance", {})["message"])
        for changed in (
            {**PEOPLE_ARGS, "url": "https://stableenrich.dev/api/other"},
            {**PEOPLE_ARGS, "method": "GET"},
            {**PEOPLE_ARGS, "maxAmount": 0.14},
            {**PEOPLE_ARGS, "body": {**PEOPLE_ARGS["body"], "offset": 1}},
        ):
            self.assertIn("exact approved", context.hook("mcp__agentcash__fetch", changed)["message"])
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
                    "partner_program": PEOPLE_PROGRAM,
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
                patch.object(plugin.Bridge, "skills", return_value=[]), \
                patch.object(plugin.Bridge, "import_people_search") as imported, \
                patch.object(plugin, "trusted_hook_identity", return_value=(RUN_ID, "call_people")):
            plugin.register(context)
            context.hooks["post_tool_call"](
                tool_name="mcp__agentcash__fetch",
                args=PEOPLE_ARGS,
                result=json.dumps({"people": [], "companies": {}, "metadata": {"total": 0}}),
                tool_call_id="call_people",
            )
        imported.assert_called_once()

    def test_creator_search_is_separately_authorized_and_imported(self):
        class Context:
            def __init__(self):
                self.hooks = {}

            def get_config(self, name, default=""):
                return {
                    "base_url": "https://enterprise.example/internal/runtime/w/w/agents/a",
                    "native_url": "http://127.0.0.1:8642",
                    "partner_program": PEOPLE_PROGRAM,
                    "mcp_policy": [{
                        "server": "agentcash", "tools": ["fetch"],
                        "allowed_hosts": ["stableenrich.dev"], "max_amount_usd": 0.15,
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
                patch.object(plugin.Bridge, "skills", return_value=[]), \
                patch.object(plugin.Bridge, "authorize_creator_search") as authorized, \
                patch.object(plugin.Bridge, "import_creator_search") as imported, \
                patch.object(plugin, "trusted_hook_identity", return_value=(RUN_ID, "call_creator")):
            plugin.register(context)
            self.assertIsNone(context.hooks["pre_tool_call"](
                "mcp__agentcash__fetch", CREATOR_ARGS, tool_call_id="call_creator"))
            context.hooks["post_tool_call"](
                tool_name="mcp__agentcash__fetch", args=CREATOR_ARGS,
                result=json.dumps({"results": []}), tool_call_id="call_creator",
            )
        authorized.assert_called_once_with(RUN_ID, "call_creator", CREATOR_ARGS)
        imported.assert_called_once_with(RUN_ID, "call_creator", CREATOR_ARGS, json.dumps({"results": []}))

    def test_x_creator_search_is_allowlisted_authorized_and_imported(self):
        class Context:
            def __init__(self):
                self.hooks = {}

            def get_config(self, name, default=""):
                return {
                    "base_url": "https://enterprise.example/internal/runtime/w/w/agents/a",
                    "native_url": "http://127.0.0.1:8642",
                    "partner_program": PEOPLE_PROGRAM,
                    "mcp_policy": [{
                        "server": "agentcash", "tools": ["fetch"],
                        "allowed_hosts": ["stableenrich.dev", "fetcher.sh"],
                        "max_amount_usd": 0.15,
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
                patch.object(plugin.Bridge, "skills", return_value=[]), \
                patch.object(plugin.Bridge, "authorize_creator_search") as authorized, \
                patch.object(plugin.Bridge, "import_creator_search") as imported, \
                patch.object(plugin, "trusted_hook_identity", return_value=(RUN_ID, "call_x_creator")):
            plugin.register(context)
            self.assertIsNone(context.hooks["pre_tool_call"](
                "mcp__agentcash__fetch", X_CREATOR_ARGS, tool_call_id="call_x_creator"))
            result = json.dumps({"status": 200, "data": {"tweets": []}})
            context.hooks["post_tool_call"](
                tool_name="mcp__agentcash__fetch", args=X_CREATOR_ARGS,
                result=result, tool_call_id="call_x_creator",
            )
        authorized.assert_called_once_with(RUN_ID, "call_x_creator", X_CREATOR_ARGS)
        imported.assert_called_once_with(RUN_ID, "call_x_creator", X_CREATOR_ARGS, result)

    def test_contact_enrichment_is_worker_authorized_and_imported(self):
        class Context:
            def __init__(self):
                self.hooks = {}

            def get_config(self, name, default=""):
                return {
                    "base_url": "https://enterprise.example/internal/runtime/w/w/agents/a",
                    "native_url": "http://127.0.0.1:8642",
                    "partner_program": PEOPLE_PROGRAM,
                    "mcp_policy": [{
                        "server": "agentcash", "tools": ["fetch"],
                        "allowed_hosts": ["stableenrich.dev"], "max_amount_usd": 0.15,
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
                patch.object(plugin.Bridge, "skills", return_value=[]), \
                patch.object(plugin.Bridge, "authorize_contact") as authorized, \
                patch.object(plugin.Bridge, "import_contact") as imported, \
                patch.object(plugin, "trusted_hook_identity", return_value=(RUN_ID, "call_contact")):
            plugin.register(context)
            self.assertIsNone(context.hooks["pre_tool_call"](
                "mcp__agentcash__fetch", CONTACT_ARGS, tool_call_id="call_contact"))
            context.hooks["post_tool_call"](
                tool_name="mcp__agentcash__fetch", args=CONTACT_ARGS,
                result=json.dumps({"records": []}), tool_call_id="call_contact",
            )
        authorized.assert_called_once_with(RUN_ID, "call_contact", CONTACT_ARGS)
        imported.assert_called_once_with(RUN_ID, "call_contact", CONTACT_ARGS, json.dumps({"records": []}))

    def test_post_tool_hook_ignores_other_agentcash_fetches(self):
        class Context:
            hooks = {}

            def get_config(self, name, default=""):
                return {
                    "base_url": "https://enterprise.example/internal/runtime/w/w/agents/a",
                    "native_url": "http://127.0.0.1:8642",
                    "allowed_skills": [],
                    "partner_program": PEOPLE_PROGRAM,
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
                patch.object(plugin.Bridge, "skills", return_value=[]), \
                patch.object(plugin.Bridge, "import_people_search") as imported:
            plugin.register(context)
            context.hooks["post_tool_call"](
                tool_name="mcp__agentcash__fetch",
                args={"url": "https://stableenrich.dev/api/exa/search", "method": "POST", "maxAmount": 0.01,
                      "body": {"query": "different"}},
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
            "name": "enterprise_bridge:partner-program-screening", "version": "1.7.0",
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
            "fetch",
        ])
        self.assertEqual(environment, {"AGENTCASH_HOME": "/srv/hermes-agentcash"})
        self.assertEqual(policies[0]["max_amount_usd"], 0.15)
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
