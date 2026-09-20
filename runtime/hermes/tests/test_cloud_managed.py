import asyncio
import hashlib
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from enterprise_bridge import cloud_managed
from enterprise_bridge.runtime_policy import (
    EXPECTED_PLUGIN_SOURCES,
    NativePolicyState,
    install_native_api_policy,
    install_native_model_policy,
    plugin_tree_digest,
    validate_managed_plugin_source,
)


class Response:
    def __init__(self, status=200, body=None):
        self.status = status
        self.body = body
        self.headers = {}


class CloudManagedPolicyTests(unittest.TestCase):
    def binding(self, **changes):
        item = {
            "name": "enterprise_bridge:partner-program-screening",
            "runtime_name": "enterprise_bridge:partner-program-screening",
            "skill_key": "partner-program-screening",
            "version": "1.7.0",
            "artifact_digest": "sha256:" + "a" * 64,
            "state": "active",
            "assignment_revision": None,
            "grant_revision": 1,
            "binding_source": "preflight_grant",
            "binding_state": "prepared",
            "grant_expires_at": "2999-01-01T00:00:00Z",
            "capability_grants": sorted(cloud_managed.PARTNER_CAPABILITIES),
        }
        item.update(changes)
        return {
            "bindings": [item],
            "manifests": [{
                "name": item["name"], "version": item["version"],
                "artifact_digest": item["artifact_digest"],
            }],
        }

    def test_binding_accepts_honest_legacy_preflight_and_assigned_finance(self):
        preflight = cloud_managed._validate_binding(self.binding())
        self.assertEqual(preflight["tools"], cloud_managed.PARTNER_TOOLS)
        finance = self.binding(
            name="enterprise_bridge:partner-invoice-review",
            runtime_name="enterprise_bridge:partner-invoice-review",
            skill_key="partner-invoice-review",
            version="1.0.1",
            assignment_revision=3,
            grant_revision=None,
            binding_source="enterprise_assignment",
            binding_state=None,
            grant_expires_at=None,
            capability_grants=sorted(cloud_managed.FINANCE_CAPABILITIES),
        )
        validated = cloud_managed._validate_binding(finance)
        self.assertEqual(validated["tools"], {
            "get_partner_handoff_result", "list_requests", "get_request",
        })

    def test_binding_accepts_exact_finance_preflight_without_cross_role_authority(self):
        finance = self.binding(
            name="enterprise_bridge:partner-invoice-review",
            runtime_name="enterprise_bridge:partner-invoice-review",
            skill_key="partner-invoice-review",
            version="1.0.1",
            capability_grants=sorted(cloud_managed.FINANCE_CAPABILITIES),
        )
        validated = cloud_managed._validate_binding(finance)
        self.assertEqual(validated["tools"], {
            "get_partner_handoff_result", "list_requests", "get_request",
        })
        self.assertNotIn("publish_partner_invoice_review", validated["tools"])
        with self.assertRaisesRegex(RuntimeError, "identity or capabilities"):
            cloud_managed._validate_binding({
                **finance,
                "bindings": [{
                    **finance["bindings"][0],
                    "capability_grants": sorted(cloud_managed.PARTNER_CAPABILITIES),
                }],
            })

    def test_same_role_preflight_to_assignment_is_a_stable_monotonic_transition(self):
        preflight = cloud_managed._validate_binding(self.binding())
        assigned = cloud_managed._validate_binding(self.binding(
            assignment_revision=1,
            grant_revision=None,
            binding_source="enterprise_assignment",
            binding_state=None,
            grant_expires_at=None,
        ))
        self.assertEqual(assigned, preflight)
        phase = cloud_managed._advance_binding_phase(
            "preflight_grant", "preflight_grant",
        )
        phase = cloud_managed._advance_binding_phase(phase, "enterprise_assignment")
        self.assertEqual(phase, "enterprise_assignment")
        with self.assertRaisesRegex(RuntimeError, "regressed to preflight"):
            cloud_managed._advance_binding_phase(phase, "preflight_grant")

    def test_assigned_binding_may_never_downgrade_to_preflight(self):
        self.assertEqual(
            cloud_managed._advance_binding_phase(
                "enterprise_assignment", "enterprise_assignment",
            ),
            "enterprise_assignment",
        )
        with self.assertRaisesRegex(RuntimeError, "regressed to preflight"):
            cloud_managed._advance_binding_phase(
                "enterprise_assignment", "preflight_grant",
            )

    def test_partnership_mcp_home_matches_the_resolved_config_value(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary) / "agentcash"
            wallet = root / ".agentcash/wallet.json"
            wallet.parent.mkdir(parents=True)
            wallet.write_text("{}\n")
            assignment = {"auto_load": ["enterprise_bridge:partner-program-screening"]}
            settings = {"mcp_policy": cloud_managed.AGENTCASH_POLICY}
            server = {
                **cloud_managed.AGENTCASH_SERVER,
                "env": {"HOME": str(root)},
            }
            with patch.dict(cloud_managed.os.environ, {
                "HERMES_AGENTCASH_MCP_ENABLED": "1",
                "AGENTCASH_HOME": str(root),
            }, clear=False):
                partnership, tools = cloud_managed._validate_role_config(
                    {"mcp_servers": {"agentcash": server}}, settings, assignment,
                )
                self.assertTrue(partnership)
                self.assertEqual(tools, {"mcp__agentcash__fetch"})
                with self.assertRaisesRegex(RuntimeError, "MCP configuration"):
                    cloud_managed._validate_role_config(
                        {"mcp_servers": {"agentcash": cloud_managed.AGENTCASH_SERVER}},
                        settings,
                        assignment,
                    )

    def test_managed_skill_config_keeps_native_auto_load_unused(self):
        assignment = {"config": {"partner_program": {"no_outreach": True}}}
        exact = {"creation_nudge_interval": 0, "write_approval": True, "config": assignment["config"]}
        cloud_managed._validate_skill_config(exact, assignment)
        cloud_managed._validate_skill_config({**exact, "auto_load": []}, assignment)
        for drifted in (
            {**exact, "auto_load": ["enterprise_bridge:partner-program-screening"]},
            {**exact, "config": {}},
            {**exact, "creation_nudge_interval": 10},
            {**exact, "write_approval": False},
            None,
        ):
            with self.assertRaisesRegex(RuntimeError, "skill configuration is not exact"):
                cloud_managed._validate_skill_config(drifted, assignment)

    def test_binding_rejects_expired_or_role_drifted_preflight(self):
        with self.assertRaisesRegex(RuntimeError, "expired"):
            cloud_managed._validate_binding(self.binding(
                grant_expires_at="2020-01-01T00:00:00Z",
            ))
        with self.assertRaisesRegex(RuntimeError, "identity or capabilities"):
            cloud_managed._validate_binding(self.binding(capability_grants=["partner.shared.read"]))
        with self.assertRaisesRegex(RuntimeError, "preflight binding"):
            cloud_managed._validate_binding(self.binding(grant_revision=2))

    def test_attestation_file_cannot_open_latch_and_drift_closes_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "runtime-readiness.json"
            path.write_text("checked")
            state = NativePolicyState(path)
            self.assertFalse(state.ensure_current())
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            state.mark_ready(digest, lambda: None)
            self.assertTrue(state.ensure_current())
            path.write_text("forged")
            self.assertFalse(state.ensure_current())
            self.assertFalse(path.exists())

    def test_dynamic_proof_failure_removes_readiness(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "runtime-readiness.json"
            path.write_text("checked")
            state = NativePolicyState(path)

            def drifted():
                raise RuntimeError("provider drift")

            state.mark_ready(hashlib.sha256(path.read_bytes()).hexdigest(), drifted)
            self.assertFalse(state.ensure_current())
            self.assertIn("provider drift", state.error)
            self.assertFalse(path.exists())

    def test_route_gate_is_installed_before_bind_and_preserves_observe_and_stop(self):
        calls = []

        async def handler(_request):
            calls.append("called")
            return Response()

        rows = [
            ("GET", "/health", handler),
            ("GET", "/v1/capabilities", handler),
            ("POST", "/v1/runs", handler),
            ("GET", "/v1/runs/{run_id}", handler),
            ("GET", "/v1/runs/{run_id}/events", handler),
            ("POST", "/v1/runs/{run_id}/approval", handler),
            ("POST", "/v1/runs/{run_id}/steer", handler),
            ("POST", "/v1/runs/{run_id}/stop", handler),
            ("POST", "/v1/chat/completions", handler),
            ("POST", "/api/sessions/{session_id}/chat", handler),
            ("POST", "/api/jobs", handler),
        ]

        class Adapter:
            def _http_route_table(self):
                return list(rows)

        web = types.SimpleNamespace(json_response=lambda body, status: Response(status, body))
        aiohttp = types.ModuleType("aiohttp")
        aiohttp.web = web
        gateway = types.ModuleType("gateway")
        platforms = types.ModuleType("gateway.platforms")
        api_server = types.ModuleType("gateway.platforms.api_server")
        api_server.APIServerAdapter = Adapter
        with tempfile.TemporaryDirectory() as temporary, patch.dict(sys.modules, {
            "aiohttp": aiohttp,
            "gateway": gateway,
            "gateway.platforms": platforms,
            "gateway.platforms.api_server": api_server,
        }):
            path = pathlib.Path(temporary) / "runtime-readiness.json"
            state = NativePolicyState(path)
            with patch("enterprise_bridge.runtime_policy.assert_native_cron_empty"):
                install_native_api_policy(state)
                routed = {(method, path): fn for method, path, fn in Adapter()._http_route_table()}
                self.assertEqual(set(routed), {
                    ("GET", "/health"), ("GET", "/v1/capabilities"),
                    ("POST", "/v1/runs"), ("GET", "/v1/runs/{run_id}"),
                    ("GET", "/v1/runs/{run_id}/events"),
                    ("POST", "/v1/runs/{run_id}/approval"),
                    ("POST", "/v1/runs/{run_id}/steer"),
                    ("POST", "/v1/runs/{run_id}/stop"),
                })
                self.assertEqual(asyncio.run(routed[("POST", "/v1/runs")](None)).status, 503)
                self.assertEqual(asyncio.run(routed[("GET", "/health")](None)).status, 503)
                self.assertEqual(asyncio.run(routed[("GET", "/v1/capabilities")](None)).status, 200)
                self.assertEqual(asyncio.run(routed[("GET", "/v1/runs/{run_id}")](None)).status, 200)
                self.assertEqual(asyncio.run(routed[("POST", "/v1/runs/{run_id}/stop")](None)).status, 200)
                path.write_text("checked")
                state.mark_ready(hashlib.sha256(path.read_bytes()).hexdigest(), lambda: None)
                self.assertEqual(asyncio.run(routed[("POST", "/v1/runs")](None)).status, 200)
                health = asyncio.run(routed[("GET", "/health")](None))
                self.assertEqual(health.headers["X-Hermes-Enterprise-Boot"], state.boot_id)

    def test_model_gate_rechecks_each_provider_attempt_and_closes_later_iterations(self):
        calls = []

        def original(*_args, **_kwargs):
            calls.append("provider")
            return "response"

        readiness = iter((True, False))
        state = types.SimpleNamespace(ensure_provider_current=lambda _agent: next(readiness))
        conversation_loop = types.ModuleType("agent.conversation_loop")
        conversation_loop.perform_api_call = original
        agent = types.ModuleType("agent")
        agent.conversation_loop = conversation_loop
        with patch.dict(sys.modules, {
            "agent": agent,
            "agent.conversation_loop": conversation_loop,
        }):
            install_native_model_policy(state)
            self.assertEqual(conversation_loop.perform_api_call(object()), "response")
            with self.assertRaisesRegex(RuntimeError, "readiness is unavailable"):
                conversation_loop.perform_api_call(object())
        self.assertEqual(calls, ["provider"])

    def test_effective_provider_binding_rejects_request_or_fallback_escape(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "runtime-readiness.json"
            path.write_text("checked")
            state = NativePolicyState(path)
            expected = {
                "provider": "custom",
                "model": "governed-model",
                "base_url": "https://enterprise.example/model/v1",
                "api_key": "runtime-token",
                "api_mode": "chat_completions",
            }
            state.mark_ready(
                hashlib.sha256(path.read_bytes()).hexdigest(), lambda: None,
                provider_binding=expected,
            )
            self.assertTrue(state.ensure_provider_current(types.SimpleNamespace(**expected)))
            escaped = {**expected, "provider": "openrouter", "base_url": "https://openrouter.ai/api/v1"}
            self.assertFalse(state.ensure_provider_current(types.SimpleNamespace(**escaped)))
            self.assertFalse(path.exists())

    def test_legacy_policy_preserves_cron_failure_contract(self):
        async def handler(_request):
            return Response()

        class Adapter:
            def _http_route_table(self):
                return [("GET", "/health", handler)]

        web = types.SimpleNamespace(json_response=lambda body, status: Response(status, body))
        aiohttp = types.ModuleType("aiohttp")
        aiohttp.web = web
        gateway = types.ModuleType("gateway")
        platforms = types.ModuleType("gateway.platforms")
        api_server = types.ModuleType("gateway.platforms.api_server")
        api_server.APIServerAdapter = Adapter
        with patch.dict(sys.modules, {
            "aiohttp": aiohttp,
            "gateway": gateway,
            "gateway.platforms": platforms,
            "gateway.platforms.api_server": api_server,
        }), patch(
            "enterprise_bridge.runtime_policy.assert_native_cron_empty",
            side_effect=RuntimeError("cron remains configured"),
        ):
            install_native_api_policy()
            routed = {(method, path): fn for method, path, fn in Adapter()._http_route_table()}
            response = asyncio.run(routed[("GET", "/health")](None))
            self.assertEqual(response.status, 503)
            self.assertEqual(response.body["code"], "native_cron_not_empty")

    def test_source_attestation_rejects_byte_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = pathlib.Path(temporary) / "pinned.py"
            source.write_text("PINNED = True\n")
            fake_hermes = types.SimpleNamespace(__version__="0.21.3")
            fake_module = types.SimpleNamespace(__file__=str(source))
            digest = hashlib.sha256(source.read_bytes()).hexdigest()

            def import_module(name):
                return fake_module if name == "pinned.module" else __import__(name)

            with patch.dict(sys.modules, {"hermes_cli": fake_hermes}), \
                    patch.object(cloud_managed, "SOURCE_DIGESTS", {"pinned.module": digest}), \
                    patch.object(cloud_managed.importlib, "import_module", side_effect=import_module), \
                    patch.object(cloud_managed.inspect, "getsourcefile", return_value=str(source)):
                self.assertEqual(cloud_managed.validate_native_source()["pinned.module"], source)
                source.write_text("PINNED = False\n")
                with self.assertRaisesRegex(RuntimeError, "source drifted"):
                    cloud_managed.validate_native_source()

    def test_plugin_source_accepts_only_canonical_pinned_repo_transports(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = pathlib.Path(temporary)
            plugin = home / "plugins/enterprise_bridge"
            plugin.mkdir(parents=True)
            (plugin / "plugin.yaml").write_text("name: enterprise_bridge\n")
            revision = "c" * 40
            digest = plugin_tree_digest(plugin)
            metadata = home / "plugins/.install-metadata.json"
            with patch.dict(cloud_managed.os.environ, {
                "HERMES_ENTERPRISE_PLUGIN_REVISION": revision,
                "HERMES_ENTERPRISE_PLUGIN_SHA256": digest,
            }):
                for source in EXPECTED_PLUGIN_SOURCES:
                    metadata.write_text(json.dumps({
                        "enterprise_bridge": {
                            "pinned": True, "revision": revision, "source": source,
                        },
                    }))
                    self.assertEqual(
                        validate_managed_plugin_source(plugin, home)["source"], source,
                    )
                metadata.write_text(json.dumps({
                    "enterprise_bridge": {
                        "pinned": True, "revision": revision,
                        "source": "git@github.com:other/repository.git#runtime/hermes/enterprise_bridge",
                    },
                }))
                with self.assertRaisesRegex(RuntimeError, "pinned source"):
                    validate_managed_plugin_source(plugin, home)

    def test_provider_drift_is_rejected(self):
        identity = {"base": "https://enterprise.example/runtime", "token": "token"}
        resolver = types.ModuleType("hermes_cli.runtime_provider")
        resolver.resolve_runtime_provider = lambda **_kwargs: {
            "base_url": identity["base"] + "/model/v1",
            "api_key": "different",
            "api_mode": "chat_completions",
        }
        with patch.dict(sys.modules, {"hermes_cli.runtime_provider": resolver}):
            with self.assertRaisesRegex(RuntimeError, "resolver is misbound"):
                cloud_managed._validate_provider(identity)


if __name__ == "__main__":
    unittest.main()
