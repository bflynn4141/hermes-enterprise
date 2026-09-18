import contextlib
import io
import json
import pathlib
import sys
import unittest
import urllib.error


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from start import load_enterprise_cache_config  # noqa: E402


BASE = "https://enterprise.example/internal/runtime/w/workspace/agents/agent"


class Response(io.BytesIO):
    status = 200


class Opener:
    def __init__(self, payload=None, error=None):
        self.payload, self.error, self.requests = payload, error, []

    def open(self, request, timeout=0):
        self.requests.append((request, timeout))
        if self.error:
            raise self.error
        return Response(json.dumps(self.payload).encode())


class PromptCacheTests(unittest.TestCase):
    def test_manifest_covers_claude_overrides_with_a_non_claude_default(self):
        models = ["test/fixture", "anthropic/claude-sonnet-5", "anthropic/claude-opus-4.7",
                  "stepfun/step-3.7-flash:free", "vendor/not-claude", "vendor/claude-sonnet-5"]
        opener = Opener({"data": [{"id": model} for model in models]})
        config = load_enterprise_cache_config(BASE, "test/fixture", "scoped-token", opener)
        provider = config["providers"]["enterprise"]
        self.assertEqual(provider["models"], {
            "anthropic/claude-sonnet-5": {"prompt_caching": True},
            "anthropic/claude-opus-4.7": {"prompt_caching": True},
        })
        self.assertEqual(provider["api"], BASE + "/model/v1")
        self.assertEqual(provider["key_env"], "ENTERPRISE_RUNTIME_TOKEN")
        self.assertEqual(provider["transport"], "chat_completions")
        self.assertFalse(provider["discover_models"])
        self.assertEqual(config["prompt_caching"], {"cache_ttl": "5m"})
        self.assertNotIn("model", config, "Cache capability declaration must not change the default model or effort")
        self.assertNotIn("scoped-token", json.dumps(config))
        self.assertEqual(len(opener.requests), 1)
        request, timeout = opener.requests[0]
        self.assertEqual(request.full_url, BASE + "/model/v1/models")
        self.assertEqual(request.get_header("Authorization"), "Bearer scoped-token")
        self.assertEqual(timeout, 5)

    def test_successful_manifest_does_not_grant_caching_to_unlisted_default(self):
        config = load_enterprise_cache_config(BASE, "anthropic/claude-unlisted", "token", Opener({"data": []}))
        self.assertEqual(config["providers"]["enterprise"]["models"], {})

    def test_unavailable_manifest_falls_back_only_to_a_real_claude_default(self):
        for default, expected in (
            ("anthropic/claude-sonnet-5", {"anthropic/claude-sonnet-5": {"prompt_caching": True}}),
            ("claude-sonnet-4-6", {"claude-sonnet-4-6": {"prompt_caching": True}}),
            ("stepfun/step-3.7-flash:free", {}),
            ("test/not-claude", {}),
            ("vendor/claude-sonnet-5", {}),
        ):
            with self.subTest(default=default), contextlib.redirect_stderr(io.StringIO()) as diagnostic:
                opener = Opener(error=urllib.error.URLError("SECRET_UPSTREAM_ERROR"))
                config = load_enterprise_cache_config(BASE, default, "SECRET_TOKEN", opener)
                self.assertEqual(config["providers"]["enterprise"]["models"], expected)
                self.assertNotIn("SECRET", diagnostic.getvalue())

    def test_malformed_manifest_is_optional_and_bounded(self):
        malformed = [None, {"data": None}, {"data": [None]}, {"data": [{"id": 1}]},
                     {"data": [{"id": "anthropic/claude-sonnet-5"}] * 1025},
                     {"data": [{"id": "x" * 262145}]}]
        for payload in malformed:
            with self.subTest(payload_type=type(payload).__name__), contextlib.redirect_stderr(io.StringIO()):
                config = load_enterprise_cache_config(BASE, "test/fixture", "token", Opener(payload))
                self.assertEqual(config["providers"]["enterprise"]["models"], {})

    def test_invalid_routes_fail_before_credentials_leave_profile(self):
        for base in ("http://enterprise.example/runtime", "https://user:secret@enterprise.example/runtime",
                     "https://enterprise.example/runtime?redirect=other", "file:///tmp/manifest"):
            with self.subTest(base=base):
                opener = Opener({"data": []})
                with self.assertRaisesRegex(RuntimeError, "HTTPS"):
                    load_enterprise_cache_config(base, "test/fixture", "token", opener)
                self.assertEqual(opener.requests, [])


if __name__ == "__main__":
    unittest.main()
