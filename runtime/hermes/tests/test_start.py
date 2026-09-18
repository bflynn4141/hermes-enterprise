import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import start


class ManagedAgentConfigTests(unittest.TestCase):
    def test_provider_retries_return_to_enterprise_recovery_instead_of_sleeping_in_process(self):
        config = start.managed_agent_config({
            "enterprise_bridge": {},
            "enterprise_skill_reader": {},
            "skills": {},
            "terminal": {},
        })

        self.assertEqual(config["api_max_retries"], 1)
        self.assertEqual(config["max_iterations"], 12)
        self.assertEqual(config["disabled_toolsets"], ["terminal"])


if __name__ == "__main__":
    unittest.main()
