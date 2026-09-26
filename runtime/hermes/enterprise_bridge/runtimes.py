"""Official Hermes releases this plugin is validated against.

Hermes Cloud moves an instance to the newest release whenever it restarts.
Add a release here, with both probes passing against it, before instances can
reach it; drop a release once no instance can still run it. The first entry is
the primary pin the local launcher installs. Each entry names the upstream
commit and the SHA-256 of every module whose private seams the plugin relies
on, so readiness proves the exact source it runs against.
"""

RUNTIMES = {
    "0.21.5": {
        "revision": "f97608f178d1ffeca59860195ab7da295f7c8e5f",
        "source_digests": {
            "agent.conversation_loop": "c93ee86e1da583abc7cc57417380cd71241ae028c04a4cb8456580b52ffbf3d8",
            "gateway.platforms.api_server": "fa83a20bd4f9f3a90a3ac010db0a68f548259587946ea80b81b2f3253bafd5ec",
            "hermes_cli.plugins": "51c7fdd506b187c8713e706a7b264614902b28039e79875770e4b120180b423c",
            "hermes_cli.plugins_dispatch": "fd1185e23edb80234e3f816a2fbbf990cdab37a3bf5c3d98b38337c7dd50e330",
            "hermes_cli.plugins_loader": "8f5761948f135faf5f75c112fcd0a819d8c44eb0652dcbc46517563961764ac3",
            "hermes_cli.runtime_provider": "8013320d5b8b393f1a21d7b7858b638772b9aaf1fe15718e9c85bc4a1c785d64",
            "hermes_cli.tools_config": "113274934cd85734005e04acc2b86216899ccde6db9eb632660eec784ee71fb7",
            "model_tools": "5d5a947d84f31f1ba4ef5267e28154b819e8f957a0b378739696f1ac305e1509",
            "cron.jobs": "24cbaf90ccec442ca34cf8ad200f30bed9de6ea74b90b7ae62d6f963aaf38763",
        },
    },
}
PRIMARY_VERSION = next(iter(RUNTIMES))
SUPPORTED_REVISIONS = frozenset(runtime["revision"] for runtime in RUNTIMES.values())
