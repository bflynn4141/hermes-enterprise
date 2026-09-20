import json
import pathlib
import sys
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from install import REVISION  # noqa: E402
from start import (  # noqa: E402
    CONTRACT,
    ENTERPRISE_TERMINAL_PREFIX,
    NATIVE_FAILURE_REASON_CODES,
    governed_terminal_fields,
    runtime_contract,
    terminal_error,
)


class RuntimeContractTests(unittest.TestCase):
    def test_contract_and_source_pin_cannot_drift(self):
        self.assertEqual(CONTRACT["source_revision"], REVISION)
        self.assertEqual(CONTRACT["contract_version"], 1)
        self.assertEqual(CONTRACT["terminal_error_schema_version"], 1)

    def test_fault_matrix_has_stable_machine_readable_results(self):
        cases = (
            ("Provider authentication failed: token expired SECRET_AUTH", "provider_auth", "auth", False),
            ("HTTP 402: insufficient credits SECRET_QUOTA", "provider_quota", "quota", False),
            ("HTTP 429: too many requests SECRET_RATE", "provider_rate_limited", "rate_limit", True),
            ("HTTP 400: maximum context length exceeded SECRET_REQUEST", "request_rejected", "rejected", False),
            ("HTTP 503: provider temporarily unavailable SECRET_UPSTREAM", "provider_unavailable", "unavailable", True),
            ("private unexpected failure SECRET_UNKNOWN", "runtime_unknown", "unknown", True),
        )
        for raw, code, category, retryable in cases:
            with self.subTest(code=code):
                projected = terminal_error(raw)
                self.assertEqual(projected, {
                    "schema_version": 1,
                    "code": code,
                    "category": category,
                    "retryable": retryable,
                    "source": "request" if code == "request_rejected" else "runtime" if code == "runtime_unknown" else "provider",
                })
                self.assertNotIn("SECRET_", json.dumps(projected))

    def test_interruption_is_structured_without_native_text(self):
        projected = terminal_error("private runtime details SECRET_INTERRUPT", "interrupted")
        self.assertEqual(projected["code"], "runtime_interrupted")
        self.assertTrue(projected["retryable"])
        self.assertEqual(projected["source"], "runtime")
        self.assertNotIn("SECRET_INTERRUPT", json.dumps(projected))

    def test_pinned_native_failure_reasons_map_without_prose(self):
        expected = {
            "auth": "provider_auth",
            "billing": "provider_quota",
            "rate_limit": "provider_rate_limited",
            "context_overflow": "request_rejected",
            "server_error": "provider_unavailable",
            "unknown": "runtime_unknown",
        }
        for reason, code in expected.items():
            with self.subTest(reason=reason):
                self.assertEqual(NATIVE_FAILURE_REASON_CODES[reason], code)
                self.assertEqual(terminal_error(ENTERPRISE_TERMINAL_PREFIX + code)["code"], code)

    def test_terminal_wire_fields_replace_provider_text_with_fixed_copy(self):
        raw = "HTTP 429 request id req-secret and token SECRET_TOKEN"
        fields = governed_terminal_fields("failed", {"error": raw, "usage": {"total_tokens": 8}})
        self.assertEqual(fields["error"], "The selected model is rate limited.")
        self.assertEqual(fields["terminal_error"]["code"], "provider_rate_limited")
        self.assertEqual(fields["usage"], {"total_tokens": 8})
        self.assertNotIn(raw, json.dumps(fields))
        self.assertNotIn("SECRET_TOKEN", json.dumps(fields))

    def test_terminal_projection_is_idempotent_across_status_hydration(self):
        first = governed_terminal_fields("failed", {
            "error": ENTERPRISE_TERMINAL_PREFIX + "provider_auth",
        })
        second = governed_terminal_fields("failed", first)
        self.assertEqual(second, first)
        self.assertEqual(second["terminal_error"]["code"], "provider_auth")

    def test_capability_attestation_names_exact_contract_pin_and_ring(self):
        with patch.dict("os.environ", {"HERMES_ENTERPRISE_RELEASE_RING": "canary"}):
            attestation = runtime_contract()
        self.assertEqual(attestation, {
            "schema_version": 1,
            "source_revision": REVISION,
            "release_ring": "canary",
            "terminal_errors": {"supported": True, "schema_version": 1},
        })

    def test_unknown_release_ring_fails_closed(self):
        with patch.dict("os.environ", {"HERMES_ENTERPRISE_RELEASE_RING": "experimental"}):
            with self.assertRaisesRegex(RuntimeError, "canary or stable"):
                runtime_contract()


if __name__ == "__main__":
    unittest.main()
