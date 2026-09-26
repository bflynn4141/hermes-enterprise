#!/usr/bin/env python3
"""Compare an official Hermes release with the validated ones, and add it.

    check  reports what a candidate release changes that this plugin relies on:
           version, relied-on module digests, toolsets, governed config defaults.
    add    makes the edit a person commits to validate a release: the candidate
           becomes the primary pin, and every older validated release stays.
           Run both probes before committing it (docs/RUNBOOK.md).

Both read upstream files with `git show` from a clone that holds the pinned and
candidate commits (a depth-1 fetch of each is enough). Neither imports or runs
upstream code: toolsets and config defaults are read as Python literals.
"""

import argparse
import ast
import hashlib
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNTIMES_PATH = ROOT / "enterprise_bridge/runtimes.py"
CONNECTOR_PATH = ROOT / "enterprise_bridge/dashboard/plugin_api.py"
CONTRACT_PATH = ROOT / "contract.json"
INSTALL_PATH = ROOT / "install.py"

# Every config default enterprise_bridge/cloud_managed.py `_validate_config`
# requires a specific value for. Managed configs set these explicitly, so a
# changed default only matters when a config omits the key, which is how
# gateway.multiplex_profiles broke the pools on Sep 25, 2026.
GOVERNED_KEYS = (
    "fallback_providers", "fallback_model", "providers", "custom_providers",
    "agent.max_iterations", "agent.api_max_retries",
    "tools.tool_search.enabled",
    "memory.memory_enabled", "memory.user_profile_enabled", "memory.nudge_interval",
    "auxiliary.background_review.enabled", "auxiliary.title_generation.enabled",
    "curator.enabled",
    "approvals.unattended_mode", "approvals.cron_mode",
    "cron.allow_agent_scheduling",
    "gateway.multiplex_profiles", "gateway.api_server.max_concurrent_runs",
)
ABSENT = "(absent)"
COMPUTED = "(computed)"


def git_show(repo, revision, path):
    result = subprocess.run(["git", "-C", str(repo), "show", f"{revision}:{path}"], capture_output=True)
    return result.stdout if result.returncode == 0 else None


def module_file(repo, revision, module):
    """The source bytes of a dotted module at a revision, or None when it is gone."""
    base = module.replace(".", "/")
    for path in (base + ".py", base + "/__init__.py"):
        data = git_show(repo, revision, path)
        if data is not None:
            return data
    return None


def _assigned(source, name):
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return node.value
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == name:
            return node.value
    raise ValueError(f"{name} is not assigned at module level")


def literal(node):
    """Evaluate literal syntax; anything computed (calls, names) becomes COMPUTED."""
    if isinstance(node, ast.Dict):
        value = {}
        for key, item in zip(node.keys, node.values):
            if key is None:  # `**spread` of a helper: its keys are not literal
                continue
            value[literal(key)] = literal(item)
        return value
    if isinstance(node, (ast.List, ast.Tuple)):
        return [literal(item) for item in node.elts]
    try:
        return ast.literal_eval(node)
    except ValueError:
        return COMPUTED


def toolset_names(source):
    return sorted(key for key in literal(_assigned(source, "TOOLSETS")) if isinstance(key, str))


def default_value(defaults, dotted):
    value = defaults
    for part in dotted.split("."):
        if not isinstance(value, dict) or part not in value:
            return ABSENT
        value = value[part]
    return value


def hermes_version(source):
    return literal(_assigned(source, "__version__"))


def validated_runtimes(path=RUNTIMES_PATH):
    return literal(_assigned(path.read_text(), "RUNTIMES"))


def check(repo, candidate, base):
    runtimes = validated_runtimes()
    primary_version = next(iter(runtimes))
    primary = runtimes[primary_version]["revision"]
    base = base or primary

    def read(revision, path):
        data = git_show(repo, revision, path)
        if data is None:
            raise SystemExit(f"{path} is missing at {revision}; fetch that commit first.")
        return data.decode()

    candidate_version = hermes_version(read(candidate, "hermes_cli/__init__.py"))
    modules = []
    for name in runtimes[primary_version]["source_digests"]:
        before, after = module_file(repo, base, name), module_file(repo, candidate, name)
        actual = hashlib.sha256(after).hexdigest() if after is not None else None
        modules.append({"module": name, "sha256": actual,
                        "status": "missing" if after is None else "same" if after == before else "changed"})
    base_toolsets = set(toolset_names(read(base, "toolsets.py")))
    candidate_toolsets = set(toolset_names(read(candidate, "toolsets.py")))
    base_defaults = literal(_assigned(read(base, "hermes_cli/config_defaults.py"), "DEFAULT_CONFIG"))
    candidate_defaults = literal(_assigned(read(candidate, "hermes_cli/config_defaults.py"), "DEFAULT_CONFIG"))
    defaults = []
    for key in GOVERNED_KEYS:
        before, after = default_value(base_defaults, key), default_value(candidate_defaults, key)
        if before != after:
            defaults.append({"key": key, "before": before, "after": after})
    return {
        "candidate": {"revision": candidate, "version": candidate_version},
        "base": {"revision": base, "version": hermes_version(read(base, "hermes_cli/__init__.py")),
                 "primary": base == primary},
        "already_validated": candidate_version in runtimes and runtimes[candidate_version]["revision"] == candidate,
        "modules": modules,
        "toolsets_added": sorted(candidate_toolsets - base_toolsets),
        "toolsets_removed": sorted(base_toolsets - candidate_toolsets),
        "defaults_changed": defaults,
    }


def render(report, tag=None):
    candidate, base = report["candidate"], report["base"]
    label = f"{tag} ({candidate['version']})" if tag else candidate["version"]
    lines = [
        f"**Candidate:** Hermes {label}, `{candidate['revision'][:12]}`",
        f"**Compared with:** Hermes {base['version']}, `{base['revision'][:12]}`"
        + (" (primary validated release)" if base["primary"] else ""),
        "",
    ]
    changed = [m for m in report["modules"] if m["status"] != "same"]
    lines.append(f"**Relied-on modules:** {len(report['modules']) - len(changed)} of {len(report['modules'])} unchanged.")
    for module in changed:
        lines.append(f"- `{module['module']}` {module['status']}: review its private seams before validating.")
    lines.append("")
    if report["toolsets_added"] or report["toolsets_removed"]:
        lines.append("**Toolsets:** every managed config must disable new toolsets in `agent.disabled_toolsets` "
                     "before an instance restarts onto this release.")
        lines += [f"- added `{name}`" for name in report["toolsets_added"]]
        lines += [f"- removed `{name}`" for name in report["toolsets_removed"]]
    else:
        lines.append("**Toolsets:** unchanged.")
    lines.append("")
    if report["defaults_changed"]:
        lines.append("**Governed config defaults changed:** set these explicitly in every managed config.")
        lines += [f"- `{item['key']}`: `{item['before']!r}` → `{item['after']!r}`" for item in report["defaults_changed"]]
    else:
        lines.append("**Governed config defaults:** unchanged.")
    return "\n".join(lines) + "\n"


def _format_runtimes(runtimes):
    lines = ["RUNTIMES = {"]
    for version, runtime in runtimes.items():
        lines += [f'    "{version}": {{', f'        "revision": "{runtime["revision"]}",', '        "source_digests": {']
        lines += [f'            "{name}": "{digest}",' for name, digest in runtime["source_digests"].items()]
        lines += ["        },", "    },"]
    return "\n".join(lines + ["}"])


def with_runtime(text, version, revision, digests):
    """runtimes.py text with a release added as the new primary entry."""
    runtimes = literal(_assigned(text, "RUNTIMES"))
    runtimes.pop(version, None)
    runtimes = {version: {"revision": revision, "source_digests": digests}, **runtimes}
    return re.sub(r"^RUNTIMES = \{\n.*?^\}", lambda _: _format_runtimes(runtimes), text, count=1, flags=re.M | re.S)


def with_connector_revision(text, version, revision):
    """plugin_api.py text with the version -> revision map gaining a first entry."""
    current = literal(_assigned(text, "SUPPORTED_SOURCE_REVISIONS"))
    current.pop(version, None)
    entries = {version: revision, **current}
    block = "\n".join(["SUPPORTED_SOURCE_REVISIONS = {", *[f'    "{v}": "{r}",' for v, r in entries.items()], "}"])
    return re.sub(r"^SUPPORTED_SOURCE_REVISIONS = \{\n.*?^\}", lambda _: block, text, count=1, flags=re.M | re.S)


def add(repo, revision):
    source = git_show(repo, revision, "hermes_cli/__init__.py")
    if source is None:
        raise SystemExit(f"{revision} is not in {repo}; fetch it first.")
    version = hermes_version(source.decode())
    primary = next(iter(validated_runtimes()))
    digests = {}
    for name in validated_runtimes()[primary]["source_digests"]:
        data = module_file(repo, revision, name)
        if data is None:
            raise SystemExit(f"{name} no longer exists in Hermes {version}; the plugin needs porting, not a new entry.")
        digests[name] = hashlib.sha256(data).hexdigest()
    RUNTIMES_PATH.write_text(with_runtime(RUNTIMES_PATH.read_text(), version, revision, digests))
    CONNECTOR_PATH.write_text(with_connector_revision(CONNECTOR_PATH.read_text(), version, revision))
    contract = json.loads(CONTRACT_PATH.read_text())
    contract["source_revision"] = revision
    contract["supported_source_revisions"] = [revision] + [r for r in contract["supported_source_revisions"] if r != revision]
    CONTRACT_PATH.write_text(json.dumps(contract, indent=2) + "\n")
    INSTALL_PATH.write_text(re.sub(r'^REVISION = "[0-9a-f]{40}"$', f'REVISION = "{revision}"',
                                   INSTALL_PATH.read_text(), count=1, flags=re.M))
    print(f"Added Hermes {version} ({revision[:12]}) as the primary validated release.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    check_parser = commands.add_parser("check")
    check_parser.add_argument("--repo", type=pathlib.Path, required=True, help="upstream hermes-agent clone")
    check_parser.add_argument("--candidate", required=True, help="candidate commit")
    check_parser.add_argument("--base", help="commit to compare with (default: the primary validated release)")
    check_parser.add_argument("--tag", help="release tag, for the report")
    check_parser.add_argument("--json", type=pathlib.Path, help="also write the report as JSON here")
    add_parser = commands.add_parser("add")
    add_parser.add_argument("--repo", type=pathlib.Path, required=True, help="upstream hermes-agent clone")
    add_parser.add_argument("--revision", required=True, help="full commit of the official release")
    args = parser.parse_args()
    if args.command == "check":
        report = check(args.repo, args.candidate, args.base)
        if args.json:
            args.json.write_text(json.dumps(report, indent=2) + "\n")
        sys.stdout.write(render(report, args.tag))
    else:
        if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
            raise SystemExit("--revision must be a full 40-character commit")
        add(args.repo, args.revision)


if __name__ == "__main__":
    main()
