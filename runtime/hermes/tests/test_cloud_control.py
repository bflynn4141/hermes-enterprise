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

        with patch.dict("os.environ", {"HERMES_ENTERPRISE_SOURCE_REVISION": cloud.SOURCE_REVISION}), \
                patch.object(control.opener, "open", side_effect=open_request):
            status, body = control.dispatch({"operation": "capabilities"})
        self.assertEqual(status, 200)
        self.assertEqual(body["object"], "hermes.api_server.capabilities")
        self.assertEqual(body["enterprise_contract"], {
            "schema_version": 1,
            "source_revision": "5d59366010640c1d6b8f170d8a4ee109db2bbdef",
            "release_ring": "stable",
            "terminal_errors": {"supported": True, "schema_version": 1},
        })
        self.assertEqual(captured["url"], "http://127.0.0.1:8642/v1/capabilities")
        self.assertEqual(captured["auth"], "Bearer native-secret")
        self.assertNotIn("native-secret", json.dumps(body))

    def test_connector_rejects_a_conflicting_native_contract(self):
        control = self.control()
        with patch.dict("os.environ", {"HERMES_ENTERPRISE_SOURCE_REVISION": cloud.SOURCE_REVISION}), \
                patch.object(control, "_request", return_value=(200, {
                    "object": "hermes.api_server.capabilities",
                    "enterprise_contract": {"schema_version": 99},
                })):
            status, body = control.dispatch({"operation": "capabilities"})
        self.assertEqual(status, 502)
        self.assertNotIn("schema_version", json.dumps(body))

    def test_connector_requires_an_explicit_reviewed_source_attestation(self):
        control = self.control()
        with patch.dict("os.environ", {"HERMES_ENTERPRISE_SOURCE_REVISION": "different"}), \
                patch.object(control, "_request", return_value=(200, {
                    "object": "hermes.api_server.capabilities",
                })):
            with self.assertRaisesRegex(RuntimeError, "source revision"):
                control.dispatch({"operation": "capabilities"})

    def test_status_projects_provider_text_before_it_crosses_the_connector(self):
        control = self.control()
        secret = "SECRET_NATIVE_PROVIDER_BODY"
        with patch.object(control, "_request", return_value=(200, {
                "run_id": RUN_ID, "status": "failed",
                "error": "HTTP 429 too many requests " + secret,
        })):
            status, body = control.dispatch({"operation": "status", "run_id": RUN_ID})
        self.assertEqual(status, 200)
        self.assertEqual(body["terminal_error"]["code"], "provider_rate_limited")
        self.assertNotIn(secret, json.dumps(body))

    def test_native_stream_yields_available_bytes_without_waiting_for_eof(self):
        class IncrementalResponse:
            def __init__(self):
                self.parts = [b"data: {\"event\":\"message.delta\"}\n\n", b""]
                self.closed = False

            def read(self, _limit=-1):
                raise AssertionError("buffer-filling read must not be used for SSE")

            def read1(self, _limit=-1):
                return self.parts.pop(0)

            def close(self):
                self.closed = True

        response = IncrementalResponse()
        stream = cloud._stream_native(response)
        self.assertEqual(next(stream), b"data: {\"event\":\"message.delta\"}\n\n")
        self.assertFalse(response.closed)
        with self.assertRaises(StopIteration):
            next(stream)
        self.assertTrue(response.closed)

    def test_native_stream_projects_failed_frames_without_buffering_the_whole_run(self):
        secret = "SECRET_STREAM_BODY"

        class IncrementalResponse:
            def __init__(self):
                self.parts = [
                    ("data: " + json.dumps({"event": "run.failed", "run_id": RUN_ID,
                                             "error": "HTTP 503 unavailable " + secret}) + "\n\n").encode(),
                    b"",
                ]
            def read1(self, _limit=-1):
                return self.parts.pop(0)
            def close(self):
                pass

        wire = b"".join(cloud._stream_native(IncrementalResponse())).decode()
        self.assertIn('"code":"provider_unavailable"', wire)
        self.assertNotIn(secret, wire)

    def test_native_stream_projects_an_unterminated_failed_frame(self):
        secret = "SECRET_UNTERMINATED_STREAM_BODY"

        class IncrementalResponse:
            def __init__(self):
                self.parts = [
                    b"event: run.failed\n",
                    ("data:" + json.dumps({
                        "event": "run.failed", "run_id": RUN_ID,
                        "error": "HTTP 401 unauthorized " + secret,
                    })).encode(),
                    b"",
                ]
                self.closed = False
            def read1(self, _limit=-1):
                return self.parts.pop(0)
            def close(self):
                self.closed = True

        response = IncrementalResponse()
        wire = b"".join(cloud._stream_native(response)).decode()
        self.assertTrue(response.closed)
        self.assertIn('"code":"provider_auth"', wire)
        self.assertNotIn(secret, wire)
        self.assertTrue(wire.endswith("\n\n"))


if __name__ == "__main__":
    unittest.main()
