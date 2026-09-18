import asyncio
import importlib.util
import json
import pathlib
import threading
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

    def test_readiness_identifies_the_streaming_connector_release(self):
        with patch.dict(cloud.os.environ, {
            "ENTERPRISE_WORKSPACE_ID": "workspace",
            "ENTERPRISE_AGENT_ID": "agent",
            "ENTERPRISE_URL": "https://enterprise.example",
        }):
            status, body = self.control().dispatch({"operation": "readiness"})
        self.assertEqual(status, 200)
        self.assertEqual(body["version"], "1.6.1")

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
            b"data: {\"delta\":\"two\"}\r\n\r\n",
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
