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
- for a managed Cloud connector, the exact full plugin revision and deterministic installed-tree digest recorded in both the supervised environment and Worker binding;
- for the private plugin repository, a temporary repository-scoped read-only deploy key, a supported mode-`0600` private-file path and a separately verified `known_hosts` file; revoke and remove the key after pinned installation;
- schedules disabled for the rehearsal.

New multi-party Partnerships requires `enterprise_bridge:partner-program-screening-v1-8` version `1.8.0` and `publish_partner_invoice_review`. Finance requires `enterprise_bridge:partner-invoice-review` version `1.0.1` with the exact governed tools `get_partner_handoff_result`, `list_requests` and `get_request`. Finance does not require AgentCash, an AgentCash wallet or any MCP server. The bundle also preserves the original `enterprise_bridge:partner-program-screening` version `1.7.0` package for existing discovery assignments; that legacy name never attests as the new multi-party package.

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

Each file needs `ENTERPRISE_WORKSPACE_ID`, `ENTERPRISE_AGENT_ID`, `ENTERPRISE_URL`, `ENTERPRISE_RUNTIME_TOKEN` and, when already provisioned, `API_SERVER_KEY`. A Cloud-hosted profile also needs `HERMES_ENTERPRISE_CONTROL_SECRET`. A profile with `HERMES_ENTERPRISE_CLOUD_MANAGED=1` additionally requires `HERMES_ENTERPRISE_PLUGIN_REVISION` and `HERMES_ENTERPRISE_PLUGIN_SHA256`; compute the latter from the final reviewed local checkout with the command in `README.md`, record both values in the Worker binding and supervised environment, and require the former to match the pinned install metadata. Native startup rehashes the installer copy, so the Cloud console does not need to execute Python. Partnerships may contain the separately reviewed AgentCash settings. Leave those settings out of Finance.

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

The Finance attestation must contain only its assigned Finance skill, `get_partner_handoff_result`, `list_requests`, `get_request` and `skill_view`, with `agentcash_enabled: false`. The generic request reads remain server-scoped to the Finance audience; their presence does not widen record visibility. The Partnerships attestation must contain only its assigned Partnerships skill and granted tools plus `skill_view`. A missing, stale, differently bound or differently hashed package fails startup.

## Local native acceptance

Run unit checks first, then the explicit native fixture harness:

```sh
python3 -m unittest discover -s runtime/hermes/tests -v
python3 runtime/hermes/tests/probe_native.py \
  --source /absolute/path/to/pinned/hermes-agent \
  --python /absolute/path/to/pinned/venv/bin/python
PYTHONPATH=/absolute/path/to/pinned/hermes-agent \
  /absolute/path/to/pinned/venv/bin/python \
  runtime/hermes/tests/probe_cloud_managed.py \
  --source /absolute/path/to/pinned/hermes-agent \
  --python /absolute/path/to/pinned/venv/bin/python
```

The native probe launches the actual pinned HTTP gateway and AIAgent under disposable profile roots. New Partnerships calls `publish_partner_invoice_review`; Finance calls `get_partner_handoff_result`; the bridge supplies trusted native run and tool-call IDs. A third profile loads the byte-identical legacy Partnerships 1.7 package, calls its existing discovery tool, restarts against the additive bundle and replays its durable admission. The probe verifies that each session prompt carries exactly its assigned package and the exact tool inventories, Finance without AgentCash, and rejection of a Finance attempt to call the Partnerships tool. Its model and Enterprise services are local fixtures, so a pass proves native wiring, compatibility and isolation rather than hosted provider quality or real business data.

The second probe runs the ordinary Cloud supervisor command with local Worker
and model fixtures. It verifies gate-first startup, failed plugin registration,
stale readiness removal, live boot-bound health, provider escape rejection,
post-202 provider gating, restart closure after the managed flag is lost, and
startup/post-ready plugin-byte drift closure. It does not install anything on
Cloud or prove a real provider completion.

## Staging sequence

1. Deploy additive database migrations and compatible Worker/client contracts while new intake remains disabled. Keep every existing assignment, including an empty manifest and `enterprise_bridge:partner-program-screening@1.7.0`, unchanged.
2. In the unclaimed pool's empty `/opt/data/.ssh`, use the supported Files page to create the task-owned OpenSSH config, mode-`0600` read-only deploy key and verified `known_hosts` file documented in `README.md`. Verify the strict host/key binding, then install the additive connector through `plugins install git@github.com:bflynn4141/hermes-enterprise.git#runtime/hermes/enterprise_bridge --ref <full-commit-sha> --enable`. After the pinned install succeeds, remove only those task-owned SSH files and revoke the deploy key. Keep the managed flag off and do not attach a customer, schedule or run. Confirm only the inert native capabilities response; an uploaded directory or Cloud Healthy badge is insufficient.
3. Create the expiring workspace/agent-scoped preflight grant for the intended legacy P1.7 role. It may authorize only authenticated GET `/skills` and `/tools`, must save the exact runtime name, version, historical artifact identity, reviewed content identity and tool list, and must grant no run/model/tool/spend/capacity authority. Use a newly minted bearer; never reuse the stale bootstrap bundle or rewrite an unreadable shared runtime map.
4. From the final reviewed checkout, compute the deterministic digest of `runtime/hermes/enterprise_bridge` and bind it to the same full commit used by the installer. Apply the exact governed config and environment, persist the same 64-lowercase-hex runtime token/native key/control secret plus the full pinned `HERMES_ENTERPRISE_PLUGIN_REVISION` and `HERMES_ENTERPRISE_PLUGIN_SHA256` across restart, reference the first two secrets from config as `${ENTERPRISE_RUNTIME_TOKEN}` and `${API_SERVER_KEY}`, set `HERMES_ENTERPRISE_CLOUD_MANAGED=1`, then restart. Do not promote or claim the pool until live connector readiness matches the current gateway boot/digest, exact plugin revision/tree digest, role inventory, empty cron policy and AgentCash requirement. P1.7 remains unready until its actual wallet and MCP tool inventory exist. A disabled plugin or import failure before its `register()` entrypoint means the native patch and connector are absent; keep that loopback-only profile unclaimed and unready.
5. On a quiet legacy profile, retain the complete profile directory, supervisor definition and previous runtime bundle. Install the additive bundle and restart with the existing agent, workspace and 1.7 assignment. Read readiness and confirm the legacy name, version, digest and tool grants are unchanged. Existing discovery/chat may continue in legacy mode.
6. If either compatibility check fails, stop that process, restore the retained bundle and profile directory, and restart its unchanged assignment. Revoke the preflight grant. New admission remains closed, so this rollback does not reinterpret or delete existing history.
7. Accept the invitation with the separately authenticated human principal, then atomically promote the same token digest to the ready runtime binding. Promotion must recheck the saved exact role manifest and live readiness; the preflight grant expires or is revoked and cannot remain a second authority path.
8. Configure one selected new Partnerships profile with the distinct `partner-program-screening-v1-8` assignment. Confirm its `/skills` manifest has the exact 1.8 identity and `/tools` includes `publish_partner_invoice_review`; never mutate the legacy assignment in place.
9. Configure the selected Finance profile with `partner-invoice-review@1.0.1`. A Finance profile must be built and restarted with the Finance-only skill/config, no AgentCash MCP or wallet, and the exact tools `get_partner_handoff_result`, `list_requests`, `get_request` plus readiness-only `skill_view`; changing only its database role is insufficient.
10. Read both connector readiness documents and compare workspace, agent, runtime revision, plugin name/version/revision/artifact digest, skill artifacts, tool inventory, native-cron policy and role-specific AgentCash state with the fixed bindings. A database assignment, host health or an online Cloud badge is not native readiness.
11. Enable the selected workspace only after both new profiles pass. Rehearse with two independently authenticated user contexts and retain the native run, handoff, request, decision and source-version identifiers.
12. If readiness, privacy, evidence or provider checks fail, stop new admission and keep existing legacy profiles, history and receipts readable. Do not reverse additive migrations.

The package split is the admission boundary: legacy 1.7 assignments resolve only the original name and bytes, while new multi-party admission requires the versioned 1.8 identity. A running legacy process need not be stopped merely because the bundle contains a newer opt-in skill. The Worker must report a mismatch for an attempted 1.8 admission without killing unrelated legacy sessions.

Hosted acceptance requires real provider completions and real tool calls for both roles, including valid, mismatch, no-request needs-information, stale-source and failed-processing results. Record observed latency, retries, token usage and cost. Never substitute the fixture harness, a scripted model, a second UI seat selected by one login, or an online profile badge for this proof.
