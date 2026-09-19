"""Immutable identities for skills packaged with the Enterprise bridge."""

import hashlib
import pathlib


PLUGIN_NAME = "enterprise_bridge"
PLUGIN_VERSION = "1.7.0"

SKILL_DEFINITIONS = (
    {
        "name": "enterprise_bridge:partner-program-screening",
        "bare_name": "partner-program-screening",
        "version": "1.7.0",
        # Migration 0047 deployed this immutable registry identity before the
        # native package began attesting exact installed bytes. Preserve that
        # identity only for this legacy tuple; content_digest below still
        # proves the byte-identical reviewed 1.7 procedure.
        "artifact_digest": "sha256:9f124ce44aa318b13e9f8ccfd92072d8b3ba6a22030eaad31cfafbfda3a1e2a9",
        "description": "Screen partner prospects and prepare cited human reviews.",
    },
    {
        "name": "enterprise_bridge:partner-program-screening-v1-8",
        "bare_name": "partner-program-screening-v1-8",
        "version": "1.8.0",
        "description": "Screen partner prospects and publish confirmed invoice intake for Finance.",
    },
    {
        "name": "enterprise_bridge:partner-invoice-review",
        "bare_name": "partner-invoice-review",
        "version": "1.0.1",
        "description": "Explain authoritative partner invoice checks for a Finance reviewer.",
    },
)


def sha256_file(path):
    """Return the artifact identity of the exact reviewed SKILL.md bytes."""
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def packaged_skills(plugin_root=None):
    """Return package metadata with a digest computed from the installed bytes."""
    root = pathlib.Path(plugin_root) if plugin_root is not None else pathlib.Path(__file__).parent
    result = {}
    for definition in SKILL_DEFINITIONS:
        path = root / "skills" / definition["bare_name"] / "SKILL.md"
        if not path.is_file() or path.is_symlink():
            raise RuntimeError(f"Enterprise skill package is missing: {definition['name']}.")
        result[definition["name"]] = {
            **definition,
            "path": path,
            "artifact_digest": definition.get("artifact_digest", sha256_file(path)),
            "content_digest": sha256_file(path),
        }
    return result
