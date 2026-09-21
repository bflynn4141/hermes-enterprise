import json
import pathlib
import unittest


DASHBOARD = pathlib.Path(__file__).resolve().parents[1] / "enterprise_bridge" / "dashboard"


class DashboardBundleTests(unittest.TestCase):
    def test_manifest_declares_a_complete_dashboard_plugin(self):
        manifest = json.loads((DASHBOARD / "manifest.json").read_text())

        self.assertEqual(manifest["name"], "enterprise_bridge")
        self.assertEqual(manifest["tab"], {
            "path": "/enterprise-bridge",
            "position": "after:plugins",
        })
        self.assertEqual(manifest["entry"], "dist/index.js")
        self.assertEqual(manifest["css"], "dist/style.css")
        self.assertEqual(manifest["api"], "plugin_api.py")
        for relative in (manifest["entry"], manifest["css"], manifest["api"]):
            asset = DASHBOARD / relative
            self.assertTrue(asset.is_file(), relative)
            self.assertGreater(asset.stat().st_size, 0, relative)

    def test_bundle_registers_the_plugin_and_reads_only_authenticated_files(self):
        bundle = (DASHBOARD / "dist" / "index.js").read_text()

        self.assertIn(
            'window.__HERMES_PLUGINS__.register("enterprise_bridge", EnterpriseBridgePage);',
            bundle,
        )
        self.assertIn('SDK.fetchJSON("/api/files")', bundle)
        self.assertIn('SDK.fetchJSON("/api/files/read?path="', bundle)
        self.assertNotIn("/api/plugins/enterprise_bridge/control", bundle)
        self.assertNotIn("innerHTML", bundle)


if __name__ == "__main__":
    unittest.main()
