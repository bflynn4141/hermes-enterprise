import ast
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import hermes_release  # noqa: E402


DEFAULTS = '''
def _aux(timeout):
    return {"timeout": timeout}

DEFAULT_CONFIG = {
    "gateway": {"multiplex_profiles": True, "api_server": {"max_concurrent_runs": 10}},
    "auxiliary": {"background_review": {"enabled": True, **_aux(120)}},
    "curator": _aux(30),
}
'''


class HermesReleaseTest(unittest.TestCase):
    def test_toolset_names_are_the_dict_keys(self):
        source = 'TOOLSETS = {"web": {"tools": []}, "setup": {"tools": ["x"]}}\nOTHER = {"nope": 1}\n'
        self.assertEqual(hermes_release.toolset_names(source), ["setup", "web"])

    def test_defaults_read_literals_without_running_upstream_code(self):
        defaults = hermes_release.literal(hermes_release._assigned(DEFAULTS, "DEFAULT_CONFIG"))
        self.assertIs(hermes_release.default_value(defaults, "gateway.multiplex_profiles"), True)
        self.assertEqual(hermes_release.default_value(defaults, "gateway.api_server.max_concurrent_runs"), 10)
        self.assertIs(hermes_release.default_value(defaults, "auxiliary.background_review.enabled"), True)
        self.assertEqual(hermes_release.default_value(defaults, "curator.enabled"), hermes_release.ABSENT)
        self.assertEqual(defaults["curator"], hermes_release.COMPUTED)
        self.assertEqual(hermes_release.default_value(defaults, "cron.allow_agent_scheduling"), hermes_release.ABSENT)

    def test_governed_keys_are_all_checked_by_managed_readiness(self):
        source = (ROOT / "enterprise_bridge/cloud_managed.py").read_text()
        for key in hermes_release.GOVERNED_KEYS:
            quoted = ", ".join(f'"{part}"' for part in key.split("."))
            self.assertTrue(quoted in source or f'config.get("{key}")' in source, key)

    def test_adding_a_release_makes_it_primary_and_keeps_the_others(self):
        text = hermes_release.RUNTIMES_PATH.read_text()
        current = hermes_release.validated_runtimes()
        digests = {name: "0" * 64 for name in next(iter(current.values()))["source_digests"]}
        updated = hermes_release.with_runtime(text, "9.9.9", "a" * 40, digests)
        runtimes = hermes_release.literal(hermes_release._assigned(updated, "RUNTIMES"))
        self.assertEqual(list(runtimes), ["9.9.9", *current])
        self.assertEqual(runtimes["9.9.9"], {"revision": "a" * 40, "source_digests": digests})
        self.assertIn("PRIMARY_VERSION = next(iter(RUNTIMES))", updated)
        ast.parse(updated)

    def test_rewriting_unchanged_files_is_byte_identical(self):
        text = hermes_release.RUNTIMES_PATH.read_text()
        version, runtime = next(iter(hermes_release.validated_runtimes().items()))
        self.assertEqual(hermes_release.with_runtime(text, version, runtime["revision"], runtime["source_digests"]), text)
        connector = hermes_release.CONNECTOR_PATH.read_text()
        self.assertEqual(hermes_release.with_connector_revision(connector, version, runtime["revision"]), connector)

    def test_connector_map_gains_the_release_first(self):
        text = 'A = 1\nSUPPORTED_SOURCE_REVISIONS = {\n    "0.1.0": "' + "b" * 40 + '",\n}\nB = 2\n'
        updated = hermes_release.with_connector_revision(text, "0.2.0", "c" * 40)
        self.assertEqual(hermes_release.literal(hermes_release._assigned(updated, "SUPPORTED_SOURCE_REVISIONS")),
                         {"0.2.0": "c" * 40, "0.1.0": "b" * 40})
        self.assertTrue(updated.startswith("A = 1\n") and updated.endswith("}\nB = 2\n"))


if __name__ == "__main__":
    unittest.main()
