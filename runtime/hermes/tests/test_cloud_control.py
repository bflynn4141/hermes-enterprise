import importlib.util
import json
import pathlib
import unittest
from unittest.mock import patch


MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "enterprise_bridge/dashboard/plugin_api.py"
SPEC = importlib.util.spec_from_file_location("enterprise_bridge_cloud_control", MODULE_PATH)
cloud = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(cloud)

RUN_ID = "run_" + "a" * 32


class Response:
    def __init__(self, status, body):
        self.code = status
        self._body = json.dumps(body).encode()

    def read(self, _limit=-1):
        return self._body

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class CloudControlTests(unittest.TestCase):
    def control(self):
        return cloud.NativeControl("http://127.0.0.1:8642", "native-secret")

    def test_connector_allows_only_declared_operations(self):
        control = self.control()
        with patch.object(control, "_request") as request:
            self.assertEqual(control.dispatch({"operation": "shell", "path": "/etc/passwd"}),
                             (400, {"error": "unsupported enterprise control operation"}))
        request.assert_not_called()

    def test_submit_forwards_only_native_body_and_idempotency_key(self):
        control = self.control()
        with patch.object(control, "_request", return_value=(202, {"run_id": RUN_ID})) as request:
            status, body = control.dispatch({
                "operation": "submit",
                "idempotency_key": "enterprise-turn-1",
                "body": {"input": "Review."},
                "path": "http://attacker.example/",
            })
        self.assertEqual((status, body), (202, {"run_id": RUN_ID}))
        request.assert_called_once_with(
            "POST", "/v1/runs", {"input": "Review."}, {"Idempotency-Key": "enterprise-turn-1"},
        )

    def test_run_operations_validate_the_native_identifier(self):
        control = self.control()
        for value in ("../other", "", 3, "run_" + "a" * 181):
            with self.assertRaises(ValueError):
                control.dispatch({"operation": "status", "run_id": value})

    def test_native_destination_is_loopback_only(self):
        with self.assertRaises(RuntimeError):
            cloud.NativeControl("https://runtime.example", "native-secret")

    def test_capabilities_use_the_native_key_without_returning_it(self):
        control = self.control()
        captured = {}

        def open_request(request, timeout=0):
            captured["url"] = request.full_url
            captured["auth"] = request.get_header("Authorization")
            captured["timeout"] = timeout
            return Response(200, {"object": "hermes.api_server.capabilities"})

        with patch.object(control.opener, "open", side_effect=open_request):
            status, body = control.dispatch({"operation": "capabilities"})
        self.assertEqual(status, 200)
        self.assertEqual(body["object"], "hermes.api_server.capabilities")
        self.assertEqual(captured["url"], "http://127.0.0.1:8642/v1/capabilities")
        self.assertEqual(captured["auth"], "Bearer native-secret")
        self.assertNotIn("native-secret", json.dumps(body))


if __name__ == "__main__":
    unittest.main()
