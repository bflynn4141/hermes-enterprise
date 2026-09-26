import asyncio
import importlib.util
import json
import pathlib
import tempfile
import threading
import unittest
from unittest.mock import AsyncMock, patch


MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "enterprise_bridge/dashboard/plugin_api.py"
SPEC = importlib.util.spec_from_file_location("enterprise_bridge_cloud_control", MODULE_PATH)
cloud = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(cloud)
PRIMARY = "f97608f178d1ffeca59860195ab7da295f7c8e5f"

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

    def test_readiness_identifies_the_streaming_connector_release(self):
        with tempfile.TemporaryDirectory() as directory:
            pathlib.Path(directory, cloud.RUNTIME_READINESS_FILENAME).write_text(json.dumps({
                "schema_version": 1,
                "runtime_revision": "f97608f178d1ffeca59860195ab7da295f7c8e5f",
                "plugin": {"name": "enterprise_bridge", "version": "1.7.0"},
                "workspace_id": "workspace",
                "agent_id": "agent",
                "enterprise_url": "https://enterprise.example",
                "skills": [{
                    "name": "enterprise_bridge:partner-invoice-review",
                    "version": "1.0.1",
                    "artifact_digest": "sha256:" + "a" * 64,
                    "content_digest": "sha256:" + "a" * 64,
                }],
                "tools": ["get_partner_handoff_result", "skill_view"],
                "agentcash_enabled": False,
                "native_cron_disabled": True,
            }))
            with patch.dict(cloud.os.environ, {"HERMES_HOME": directory}):
                status, body = self.control().dispatch({"operation": "readiness"})
        self.assertEqual(status, 200)
        self.assertEqual(body["version"], "1.7.0")
        self.assertEqual(body["runtime_revision"], "f97608f178d1ffeca59860195ab7da295f7c8e5f")
        self.assertEqual(body["skills"][0]["name"], "enterprise_bridge:partner-invoice-review")
        self.assertEqual(body["tools"], ["get_partner_handoff_result", "skill_view"])
        self.assertFalse(body["agentcash_enabled"])

    def test_readiness_fails_closed_without_the_native_attestation(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            cloud.os.environ, {"HERMES_HOME": directory}, clear=False,
        ):
            status, body = self.control().dispatch({"operation": "readiness"})
        self.assertEqual(status, 503)
        self.assertEqual(body["code"], "native_readiness_unavailable")

    def test_managed_readiness_requires_the_matching_live_gateway(self):
        with tempfile.TemporaryDirectory() as directory:
            pathlib.Path(directory, cloud.RUNTIME_READINESS_FILENAME).write_text(json.dumps({
                "schema_version": 1,
                "runtime_revision": "f97608f178d1ffeca59860195ab7da295f7c8e5f",
                "plugin": {
                    "name": "enterprise_bridge", "version": "1.7.0",
                    "revision": "c" * 40, "artifact_digest": "sha256:" + "d" * 64,
                },
                "workspace_id": "workspace",
                "agent_id": "agent",
                "enterprise_url": "https://enterprise.example",
                "skills": [{
                    "name": "enterprise_bridge:partner-invoice-review",
                    "version": "1.0.1",
                    "artifact_digest": "sha256:" + "a" * 64,
                    "content_digest": "sha256:" + "a" * 64,
                }],
                "tools": ["get_partner_handoff_result", "skill_view"],
                "agentcash_enabled": False,
                "native_cron_disabled": True,
                "managed_cloud": True,
                "boot_id": "b" * 32,
            }))
            control = self.control()
            with patch.dict(cloud.os.environ, {"HERMES_HOME": directory}), \
                    patch.object(control, "_managed_readiness_is_live", return_value=False):
                status, body = control.dispatch({"operation": "readiness"})
                self.assertEqual(status, 503)
                self.assertEqual(body["code"], "native_readiness_unavailable")
            with patch.dict(cloud.os.environ, {"HERMES_HOME": directory}), \
                    patch.object(control, "_managed_readiness_is_live", return_value=True):
                self.assertEqual(control.dispatch({"operation": "readiness"})[0], 200)

    def test_post_events_envelope_opens_the_native_stream(self):
        class Request:
            headers = {}

            async def body(self):
                return json.dumps({"operation": "events", "run_id": RUN_ID}).encode()

        stream = object()
        event_stream = AsyncMock(return_value=stream)
        control = object()
        with patch.object(cloud, "NativeControl", return_value=control), \
             patch.object(cloud, "_event_stream", event_stream):
            response = asyncio.run(cloud.enterprise_control(Request()))

        self.assertIs(response, stream)
        event_stream.assert_awaited_once_with(control, RUN_ID)

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

    def test_marked_managed_profile_blocks_spend_without_live_boot_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            pathlib.Path(directory, cloud.MANAGED_PROFILE_MARKER_FILENAME).write_text(json.dumps({
                "schema_version": 1, "managed_cloud": True,
            }))
            control = self.control()
            with patch.dict(cloud.os.environ, {"HERMES_HOME": directory}), \
                    patch.object(control, "_request") as request:
                status, body = control.dispatch({
                    "operation": "submit",
                    "idempotency_key": "enterprise-turn-1",
                    "body": {"input": "Review."},
                })
        self.assertEqual(status, 503)
        self.assertEqual(body["code"], "native_readiness_unavailable")
        request.assert_not_called()

    def test_marked_managed_profile_allows_spend_only_with_live_boot_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            pathlib.Path(directory, cloud.MANAGED_PROFILE_MARKER_FILENAME).write_text("managed\n")
            control = self.control()
            with patch.dict(cloud.os.environ, {"HERMES_HOME": directory}), \
                    patch.object(cloud, "load_runtime_attestation", return_value={
                        "managed_cloud": True, "boot_id": "b" * 32,
                    }), \
                    patch.object(control, "_managed_readiness_is_live", return_value=True), \
                    patch.object(control, "_request", return_value=(202, {"run_id": RUN_ID})) as request:
                status, _body = control.dispatch({
                    "operation": "submit",
                    "idempotency_key": "enterprise-turn-1",
                    "body": {"input": "Review."},
                })
        self.assertEqual(status, 202)
        request.assert_called_once()

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

        with patch.dict("os.environ", {"HERMES_ENTERPRISE_SOURCE_REVISION": PRIMARY}), \
                patch.object(cloud, "_running_hermes_version", return_value="0.21.5"), \
                patch.object(control.opener, "open", side_effect=open_request):
            status, body = control.dispatch({"operation": "capabilities"})
        self.assertEqual(status, 200)
        self.assertEqual(body["object"], "hermes.api_server.capabilities")
        self.assertEqual(body["enterprise_contract"], {
            "schema_version": 1,
            "source_revision": "f97608f178d1ffeca59860195ab7da295f7c8e5f",
            "release_ring": "stable",
            "terminal_errors": {"supported": True, "schema_version": 1},
        })
        self.assertEqual(captured["url"], "http://127.0.0.1:8642/v1/capabilities")
        self.assertEqual(captured["auth"], "Bearer native-secret")
        self.assertNotIn("native-secret", json.dumps(body))

    def test_connector_rejects_a_conflicting_native_contract(self):
        control = self.control()
        with patch.dict("os.environ", {"HERMES_ENTERPRISE_SOURCE_REVISION": PRIMARY}), \
                patch.object(cloud, "_running_hermes_version", return_value="0.21.5"), \
                patch.object(control, "_request", return_value=(200, {
                    "object": "hermes.api_server.capabilities",
                    "enterprise_contract": {"schema_version": 99},
                })):
            status, body = control.dispatch({"operation": "capabilities"})
        self.assertEqual(status, 502)
        self.assertNotIn("schema_version", json.dumps(body))

    def test_connector_reports_the_validated_release_actually_running(self):
        control = self.control()
        runtimes = {"0.21.5": PRIMARY, "0.21.6": "b" * 40}
        with patch.object(cloud, "SUPPORTED_SOURCE_REVISIONS", runtimes), \
                patch.dict("os.environ", {"HERMES_ENTERPRISE_SOURCE_REVISION": PRIMARY}), \
                patch.object(cloud, "_running_hermes_version", return_value="0.21.6"), \
                patch.object(control, "_request", return_value=(200, {"object": "hermes.api_server.capabilities"})):
            status, body = control.dispatch({"operation": "capabilities"})
        self.assertEqual(status, 200)
        self.assertEqual(body["enterprise_contract"]["source_revision"], "b" * 40)

    def test_connector_refuses_an_unvalidated_running_release(self):
        control = self.control()
        with patch.dict("os.environ", {"HERMES_ENTERPRISE_SOURCE_REVISION": PRIMARY}), \
                patch.object(cloud, "_running_hermes_version", return_value="0.21.9"), \
                patch.object(control, "_request", return_value=(200, {"object": "hermes.api_server.capabilities"})):
            with self.assertRaisesRegex(RuntimeError, "unvalidated Hermes release"):
                control.dispatch({"operation": "capabilities"})

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

    def test_native_stream_uses_read1_instead_of_a_buffer_filling_read(self):
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

        async def collect():
            response = IncrementalResponse()
            chunks = [chunk async for chunk in cloud._stream_native(response)]
            return response, chunks

        response, chunks = asyncio.run(collect())
        self.assertEqual(chunks, [
            cloud.SSE_CONNECTED,
            b"data: {\"event\":\"message.delta\"}\n\n",
        ])
        self.assertTrue(response.closed)

    def test_native_stream_splits_available_bytes_into_complete_sse_frames(self):
        class CombinedResponse:
            def __init__(self):
                self.parts = [
                    b"data: {\"delta\":\"one\"}\n\ndata: {\"delta\":",
                    b"\"two\"}\r\n\r\n",
                    b"",
                ]

            def read1(self, _limit=-1):
                return self.parts.pop(0)

            def close(self):
                pass

        async def collect():
            return [chunk async for chunk in cloud._stream_native(CombinedResponse())]

        self.assertEqual(asyncio.run(collect()), [
            cloud.SSE_CONNECTED,
            b"data: {\"delta\":\"one\"}\n\n",
            b"data: {\"delta\":\"two\"}\n\n",
        ])


class CloudStreamingTimingTests(unittest.IsolatedAsyncioTestCase):
    async def test_streaming_response_forwards_first_delayed_frame_before_eof(self):
        if not cloud.FASTAPI_AVAILABLE:
            self.skipTest("locked Hermes environment supplies FastAPI")

        release_tail = threading.Event()

        class DelayedResponse:
            code = 200

            def __init__(self):
                self.reads = 0
                self.closed = False

            def read1(self, _limit=-1):
                self.reads += 1
                if self.reads == 1:
                    return b'data: {"event":"message.delta","delta":"First"}\n\n'
                release_tail.wait(timeout=2)
                if self.reads == 2:
                    return b'data: {"event":"run.completed"}\n\n'
                return b""

            def close(self):
                self.closed = True

        native = DelayedResponse()
        response = cloud.StreamingResponse(
            cloud._stream_native(native),
            media_type="text/event-stream",
            headers=cloud.SSE_HEADERS,
        )
        sent = asyncio.Queue()

        async def send(message):
            await sent.put(message)

        async def receive():
            await asyncio.Event().wait()

        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": "GET", "scheme": "https", "path": "/control",
            "raw_path": b"/control", "query_string": b"", "headers": [],
            "client": ("127.0.0.1", 1), "server": ("test", 443), "root_path": "",
        }
        task = asyncio.create_task(response(scope, receive, send))
        try:
            start = await asyncio.wait_for(sent.get(), timeout=0.5)
            self.assertEqual(start["type"], "http.response.start")
            connected = await asyncio.wait_for(sent.get(), timeout=0.5)
            self.assertEqual(connected["body"], cloud.SSE_CONNECTED)
            first = await asyncio.wait_for(sent.get(), timeout=0.5)
            self.assertIn(b'"delta":"First"', first["body"])

            # The terminal native frame is still blocked. Seeing the first
            # delta now proves the response layer did not wait for EOF.
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(sent.get(), timeout=0.05)

            release_tail.set()
            terminal = await asyncio.wait_for(sent.get(), timeout=0.5)
            self.assertIn(b'"event":"run.completed"', terminal["body"])
            await asyncio.wait_for(task, timeout=0.5)
            self.assertTrue(native.closed)
        finally:
            release_tail.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)


if __name__ == "__main__":
    unittest.main()
