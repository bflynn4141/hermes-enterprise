# Partnerships and Finance native rollout

This runbook installs two dedicated Hermes 0.21.3 profiles for the governed partner-invoice workflow while keeping existing Partnerships 1.7 profiles restartable. It does not create an employee, buy provider capacity, change a hosted profile, enable a schedule, or admit a workspace.

## Required bindings

Before changing a runtime, verify these fixed prerequisites through the Enterprise control plane:

- two joined human members with distinct Partnerships and Finance principals;
- two distinct agent IDs and two distinct dedicated native profiles, each permanently bound to the same target workspace as its principal;
- active role assignment, immutable skill artifact and exact tool grants for each agent;
- one reachable, approved model provider with enough existing capacity for two real runs;
- an HTTPS Enterprise URL and one unique runtime bridge token per agent;
- for a Cloud connector, one unique control secret per profile and a loopback native API key;
- schedules disabled for the rehearsal.

New multi-party Partnerships requires `enterprise_bridge:partner-program-screening-v1-8` version `1.8.0` and `publish_partner_invoice_review`. Finance requires `enterprise_bridge:partner-invoice-review` version `1.0.1` and `get_partner_handoff_result`. Finance does not require AgentCash, an AgentCash wallet or any MCP server. The bundle also preserves the original `enterprise_bridge:partner-program-screening` version `1.7.0` package for existing discovery assignments; that legacy name never attests as the new multi-party package.

The reviewed native artifacts are the exact `SKILL.md` bytes reported by `enterprise_bridge.packages.packaged_skills()`. Copy those versions and digests into the Worker registry and migration; do not transcribe a placeholder digest.

- `enterprise_bridge:partner-program-screening` `1.7.0`: historical registry `artifact_digest` `sha256:9f124ce44aa318b13e9f8ccfd92072d8b3ba6a22030eaad31cfafbfda3a1e2a9`; exact installed `content_digest` `sha256:cd26e70aa49de223f28216ea579d33c610305d3184a6c592c7841fa12aca6ddf`
- `enterprise_bridge:partner-program-screening-v1-8` `1.8.0`: artifact and content `sha256:281bbfff95d40e202c3ced5d1cb30ebf432868bee100d0c2a647faa40757a9e5`
- `enterprise_bridge:partner-invoice-review` `1.0.1`: artifact and content `sha256:bdb13d70f7a603f92eb47fc2d1c057c82f26658e61df8cf357790f23875753e4`

Migration 0047 is already deployed and its 1.7 registry row is immutable. The explicit two-digest mapping above is limited to that original runtime name and version: the launcher accepts the historical registry identity only while independently requiring the byte-identical original procedure. No other version may alias an artifact identity to different bytes. Readiness reports both values so operators can distinguish registry continuity from actual native content.

## Safe preflight

Use separate `0600` env files and separate short state roots. Check credential presence without printing values:

```sh
test -s /secure/path/partnerships.env
test -s /secure/path/finance.env
stat -f '%Sp %N' /secure/path/partnerships.env /secure/path/finance.env
awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/{print FILENAME ":" $1}' \
  /secure/path/partnerships.env /secure/path/finance.env | sort
```

Each file needs `ENTERPRISE_WORKSPACE_ID`, `ENTERPRISE_AGENT_ID`, `ENTERPRISE_URL`, `ENTERPRISE_RUNTIME_TOKEN` and, when already provisioned, `API_SERVER_KEY`. A Cloud-hosted profile also needs `HERMES_ENTERPRISE_CONTROL_SECRET`. Partnerships may contain the separately reviewed AgentCash settings. Leave those settings out of Finance.

Verify the Worker contract and the actual native package before binding a listener:

```sh
python3 runtime/hermes/start.py \
  --source /absolute/path/to/pinned/hermes-agent \
  --python /absolute/path/to/pinned/venv/bin/python \
  --env-file /secure/path/partnerships.env \
  --model 'approved/raw-model-id' \
  --port 8642 \
  --state-root /short/path/he-partnerships \
  --verify-only

python3 runtime/hermes/start.py \
  --source /absolute/path/to/pinned/hermes-agent \
  --python /absolute/path/to/pinned/venv/bin/python \
  --env-file /secure/path/finance.env \
  --model 'approved/raw-model-id' \
  --port 8643 \
  --state-root /short/path/he-finance \
  --verify-only
```

`--verify-only` performs authenticated skill and tool discovery, checks the package version and SHA-256 digest against the installed bytes, resolves the real custom provider settings, and writes `home/runtime-readiness.json`. Inspect only its non-secret inventory:

```sh
jq '{runtime_revision,plugin,workspace_id,agent_id,skills,tools,agentcash_enabled,native_cron_disabled}' \
  /short/path/he-partnerships/AGENT_UUID/home/runtime-readiness.json
jq '{runtime_revision,plugin,workspace_id,agent_id,skills,tools,agentcash_enabled,native_cron_disabled}' \
  /short/path/he-finance/AGENT_UUID/home/runtime-readiness.json
```

The Finance attestation must contain only its assigned Finance skill, `get_partner_handoff_result` and `skill_view`, with `agentcash_enabled: false`. The Partnerships attestation must contain only its assigned Partnerships skill and granted tools plus `skill_view`. A missing, stale, differently bound or differently hashed package fails startup.

## Local native acceptance

Run unit checks first, then the explicit native fixture harness:

```sh
python3 -m unittest discover -s runtime/hermes/tests -v
python3 runtime/hermes/tests/probe_native.py \
  --source /absolute/path/to/pinned/hermes-agent \
  --python /absolute/path/to/pinned/venv/bin/python
```

The native probe launches the actual pinned HTTP gateway and AIAgent under disposable profile roots. New Partnerships calls `publish_partner_invoice_review`; Finance calls `get_partner_handoff_result`; the bridge supplies trusted native run and tool-call IDs. A third profile loads the byte-identical legacy Partnerships 1.7 package, calls its existing discovery tool, restarts against the additive bundle and replays its durable admission. The probe verifies all auto-loaded packages and exact tool inventories, Finance without AgentCash, and rejection of a Finance attempt to call the Partnerships tool. Its model and Enterprise services are local fixtures, so a pass proves native wiring, compatibility and isolation rather than hosted provider quality or real business data.

## Staging sequence

1. Deploy additive database migrations and compatible Worker/client contracts while new intake remains disabled. Keep every existing assignment, including an empty manifest and `enterprise_bridge:partner-program-screening@1.7.0`, unchanged.
2. On a quiet legacy profile, retain the complete profile directory, supervisor definition and previous runtime bundle. Install the additive bundle and restart with the existing agent, workspace and 1.7 assignment. Read readiness and confirm the legacy name, version, digest and tool grants are unchanged. Existing discovery/chat may continue in legacy mode.
3. If the legacy check fails, stop that process, restore the retained bundle and profile directory, and restart its unchanged assignment. New admission remains closed, so this rollback does not reinterpret or delete existing history.
4. Configure one selected new Partnerships profile with the distinct `partner-program-screening-v1-8` assignment. Confirm its `/skills` manifest has the exact 1.8 identity and `/tools` includes `publish_partner_invoice_review`; never mutate the legacy assignment in place.
5. Configure the selected Finance profile with `partner-invoice-review@1.0.1`. Confirm its `/tools` contains only its role grants and that readiness reports `agentcash_enabled: false`.
6. Read both connector readiness documents and compare workspace, agent, runtime revision, plugin, skill artifacts, tool inventory, native-cron policy and role-specific AgentCash state with the fixed bindings. A database assignment, host health or an online Cloud badge is not native readiness.
7. Enable the selected workspace only after both new profiles pass. Rehearse with two independently authenticated user contexts and retain the native run, handoff, request, decision and source-version identifiers.
8. If readiness, privacy, evidence or provider checks fail, stop new admission and keep existing legacy profiles, history and receipts readable. Do not reverse additive migrations.

The package split is the admission boundary: legacy 1.7 assignments resolve only the original name and bytes, while new multi-party admission requires the versioned 1.8 identity. A running legacy process need not be stopped merely because the bundle contains a newer opt-in skill. The Worker must report a mismatch for an attempted 1.8 admission without killing unrelated legacy sessions.

Hosted acceptance requires real provider completions and real tool calls for both roles, including valid, mismatch, no-request needs-information, stale-source and failed-processing results. Record observed latency, retries, token usage and cost. Never substitute the fixture harness, a scripted model, a second UI seat selected by one login, or an online profile badge for this proof.
