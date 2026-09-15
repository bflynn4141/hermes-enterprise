import json
import pathlib
import sys
import unittest
import urllib.error
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import enterprise_bridge as plugin
from start import clean_environment, validate_profile_path

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

    def test_personal_environment_does_not_survive(self):
        with patch.dict(plugin.os.environ, {"OPENROUTER_API_KEY": "private", "TELEGRAM_BOT_TOKEN": "private", "HTTP_PROXY": "private", "HERMES_SESSION_KEY": "spoof"}):
            env = clean_environment(pathlib.Path("/source"), pathlib.Path("/isolated"), "runtime", "native")
        for name in ("OPENROUTER_API_KEY", "TELEGRAM_BOT_TOKEN", "HTTP_PROXY", "HERMES_SESSION_KEY"):
            self.assertNotIn(name, env)
        self.assertEqual(env["HOME"], "/isolated/os-home")
        self.assertEqual(env["HERMES_HOME"], "/isolated/home")

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


if __name__ == "__main__":
    unittest.main()
