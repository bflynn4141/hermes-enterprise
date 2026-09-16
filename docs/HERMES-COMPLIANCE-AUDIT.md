# Hermes runtime compliance audit

**Audit date:** September 15, 2026 (America/Los_Angeles)

**Enterprise baseline:** `92083deba27f741317c43f1e64a85231db44c79f`

**Bounded remediation base:** `a44a09782e9989cafbdc02b52ec5b21c6010d3cc`

**Official Hermes pin:** `5d59366010640c1d6b8f170d8a4ee109db2bbdef`

**Decision:** **No — the current integration is not ready for hosted customer data.** The core, fixture-tested execution path is the official Hermes gateway and agent loop, and its Runs API/tool bridge is substantially correct. The bounded code remediation closed reproducible installation, durable-idempotency admission, misleading attachment handling, and latent native-cron reachability. Production release remains blocked by incomplete runtime-profile lifecycle/erasure, no proven hosted supervisor/shared profile fence or whole-process sandbox, model-spend enforcement/accounting gaps, and runtime reconciliation gaps.

## Bounded answers

| Question | Answer |
| --- | --- |
| Is this the official Hermes loop rather than a replacement loop? | **Yes.** The launcher executes the pinned official `hermes gateway run`, and the native fixture probe exercised the official HTTP gateway plus `AIAgent`. |
| Is the pin the stable `v2026.9.14` / `0.21.3` release? | **No.** The stable tag object is `7a963716b81be13ba513d4f127633b7da493aff2`, which points to code commit `345cd2b057a452236de401d3534b8502a7465e8d`. The pin is an unreleased snapshot **751 commits after** that commit even though both trees report package version `0.21.3`. |
| Does the tested pin implement the Runs API contract the adapter expects? | **Yes, for the fixture-tested contract.** Submit/idempotency, status, session continuation, single-consumer SSE, stop, concurrency, trusted run/tool-call context, and governed tool dispatch passed. |
| Is a Hermes profile an OS security boundary? | **No.** It isolates Hermes state and configuration only. The official trust model requires a whole-process sandbox for production/shared use with untrusted content. |
| Do attached files reach Hermes? | **No.** The client sends attachment references, but the turn route drops them and the runtime submits only text. Hermes receives neither content nor an immutable attachment reference. |
| Are native dangerous-tool approvals the Enterprise business-approval workflow? | **No.** They are separate mechanisms and should stay separate. Native dangerous tools are absent and unattended native approvals deny; Enterprise business approvals remain durable server-owned application state. |
| Should the project move to stable `v2026.9.14` now? | **No.** That is a 751-commit downgrade and omits later lease/runtime fixes used by the audited pin. |
| Should the project move to current upstream `main` now? | **No.** It was only 10 commits ahead at audit time but is still untagged. There is no compliance benefit that justifies changing the reviewed pin. |

## Release and provenance finding

The official [September 14 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.14) calls `v2026.9.14` a stable downstream/Docker release and identifies package version `0.21.3`. Git object inspection establishes the identities precisely:

```text
v2026.9.14 tag object     7a963716b81be13ba513d4f127633b7da493aff2
v2026.9.14 code commit    345cd2b057a452236de401d3534b8502a7465e8d
enterprise pin            5d59366010640c1d6b8f170d8a4ee109db2bbdef
upstream main at audit    416a8177c25d87aa9929dfcf31f7964137d7fcdd
pin vs stable             751 commits after / 0 before
main vs pin               10 commits after / 0 before
git describe(pin)         v2026.9.14-751-g5d5936601
```

The tag is annotated but the fetched Git tag object contains no cryptographic signature. The enterprise installer provides strong source identity by HTTPS-fetching the exact commit and rejecting a different `HEAD`, tracked modifications, or a missing/untracked `uv.lock` (`runtime/hermes/install.py`). It now synchronizes dependencies with `uv sync --locked --no-dev --no-install-project` from that exact tree. The upstream package intentionally refuses non-editable wheel builds, so the launcher imports the verified tree directly through `PYTHONPATH`; no editable package is installed. The upstream `sms` extra is selected because it is the smallest declared locked extra containing the API server's `aiohttp`. The install records the source SHA, lock SHA-256, and exact package inventory in ignored local state.

The official [security policy](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/SECURITY.md) and [GitHub advisory page](https://github.com/NousResearch/hermes-agent/security/advisories) were reviewed. GitHub showed no published repository advisories at the audit time; that is not evidence that a newly resolved dependency set is vulnerability-free.

The stable-to-pin comparison matters operationally. The Runs implementation and idempotency store are unchanged, but the pin includes later session-turn lease, context propagation, plugin, and model-tool changes. Current upstream `main` did not change the audited Runs/idempotency/context files in its 10 commits after the pin. Package version strings therefore cannot substitute for commit identity or a native probe.

## Compliance matrix

Statuses are limited to **compliant**, **intentional divergence**, **operationally unverified**, and **incorrect**. Priority is remediation urgency; `—` means no defect was found in the audited boundary. There are **no P0 findings**.

| Area | Status | Priority | Evidence and consequence | Smallest safe remediation |
| --- | --- | --- | --- | --- |
| Official source identity | compliant | — | Exact official repository and commit are hard-coded and verified; tracked changes abort startup (`runtime/hermes/install.py:10-20,29-35`). The probe ran the official gateway and `AIAgent`, not a mocked loop. | Retain exact-SHA and clean-tree checks. Record source SHA in deployment inventory. |
| Stable-release identity | intentional divergence | P2 | Pin `5d593660…` is an unreleased snapshot 751 commits after stable code commit `345cd2b…`, while both say `0.21.3`. Calling it merely “0.21.3” would obscure provenance, though the current README names the SHA. | Keep the SHA explicit everywhere. Wait for a release containing the required fixes; review the tag-to-pin diff before repinning. |
| Dependency reproducibility and artifacts | compliant | — | The installer requires the pinned clean tree and tracked `uv.lock`, uses `uv sync --locked --no-dev --no-install-project`, and records source SHA, lock SHA-256 and the resolved package inventory (`runtime/hermes/install.py`). The launcher executes the verified tree directly, avoiding the upstream-prohibited wheel build and any editable package install. The native probe passed in that environment. | Keep locked sync, inventory capture, and the exact-environment native probe mandatory at every pin change. |
| One agent ↔ one profile mapping | compliant | — | Worker configuration is keyed by agent and enforces workspace ownership (`apps/worker/src/runtime/config.ts:22-38`). Postgres advisory locks and active-run queries serialize a profile (`apps/worker/src/runtime/store.ts:38-58,66-85`); native concurrency is one (`runtime/hermes/start.py:71`). | Keep the three layers and test concurrent admission in deployment. |
| Host-level uniqueness / split-brain | operationally unverified | **P1** | The launcher lock is scoped to `<state-root>/<agent>/launcher.lock` (`runtime/hermes/start.py:164-179`). Starting the same agent under another state root or host bypasses it. No production provisioner/supervisor currently proves a single assignment. Two profiles could diverge session/idempotency state while the Worker points at only one. | Make agent-to-host/profile assignment durable and unique; have the supervisor acquire a shared lease before launch and reject a second assignment. |
| Profile isolation versus OS sandbox | operationally unverified | **P1** | Separate `HOME`, `HERMES_HOME`, workspace, config, and clean environment are real (`runtime/hermes/start.py:36-45,155-181`). They are not an OS boundary. Official Hermes says plugin/hook/skill code runs in-process and recommends a whole-process wrapper for production/shared untrusted inputs ([security policy](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/SECURITY.md#terminal-backend-isolation)). | Run each profile as non-root in a whole-process sandbox/container with explicit filesystem mounts and egress policy; verify from the hosted path. |
| Runtime credentials and network binding | compliant | — | Personal environment/provider keys are stripped; only scoped Enterprise token and native API key survive (`runtime/hermes/start.py:36-45`). Files are written `0600`; the native listener is loopback; production Worker bindings require HTTPS and an agent/workspace-scoped HMAC bridge (`apps/worker/src/runtime/config.ts:22-67`). | Keep native API keys server-only, rotate them through the supervisor, and firewall hosted endpoints to the Worker path. |
| Runs submit/idempotency/session lease/status | compliant | — | Official pin supplies scoped durable reservations, conflict detection, owner recovery, pollable terminal status, and durable cross-process session turn leases ([Runs source](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/gateway/platforms/api_server_runs.py), [store](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/gateway/platforms/api_server_run_idempotency.py), [lease](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/agent/turn_facade_lease.py)). The Enterprise adapter snapshots the exact request and uses a stable attempt key (`apps/worker/src/runtime/adapter.ts:69-95`; `apps/worker/src/runtime/store.ts:38-58`). | Preserve exact-body replay and status reconciliation. |
| Durable-idempotency capability gate | compliant | — | `HermesClient.capabilities()` validates bearer auth, server-agent execution, the exact Runs endpoint/method contract, required features, and durable positive-retention idempotency (`apps/worker/src/runtime/client.ts`). Worker health checks every configured profile; turn admission checks before inserting a run; Workflow submit/replay and execution reconciliation recheck live capabilities (`apps/worker/src/routes/health.ts`, `apps/worker/src/routes/turns.ts`, `apps/worker/src/runtime/adapter.ts`). Unit tests cover refusal and replay, and the native probe replays the same key/body after a full gateway restart. | Keep health, admission, and replay checks aligned with the audited pin's contract. |
| SSE single-consumer / replay | compliant | — | Upstream uses one destructive queue and drops it on disconnect ([`_handle_run_events`](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/gateway/platforms/api_server_runs.py#L722)). Enterprise opens one native stream, persists its own events, and falls back to authoritative polling without native resubscription (`apps/worker/src/runtime/adapter.ts:120-161`). | Retain exactly one native consumer. Browsers must replay Enterprise events only. |
| Stop and steer | compliant | — | Native stop is cooperative and polling proves terminal state; steer returns 409 when unavailable. The adapter polls controls, carries unaccepted guidance forward, and does not equate a stop acknowledgement with completion (`apps/worker/src/runtime/client.ts:53-63`; `apps/worker/src/runtime/adapter.ts:145-184`). Fixture probe covered stop while waiting. | Add hosted interruption and post-stop tool/model denial tests. |
| Native dangerous-tool approval | intentional divergence | — | Official `/v1/runs/{id}/approval` resolves dangerous-command choices (`once/session/always/deny`), not business decisions ([Runs source](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/gateway/platforms/api_server_runs.py#L777)). Native toolsets are absent and unattended/cron native approvals deny (`runtime/hermes/start.py:63-78`), so the Enterprise client intentionally does not implement this endpoint. | Keep native dangerous tools absent. If one is ever added, implement and separately test the native approval transport before enabling it. |
| Enterprise business approval | intentional divergence | — | Business approval is a durable Enterprise proposal/authorization workflow, not permission for a native shell/file side effect (`docs/APPROVAL-CONTRACT.md`). Conflating it with native `/approval` would grant the wrong authority and lose durable application semantics. | Continue with fresh linked Enterprise runs after a business decision; never route the business UI to native dangerous-tool approval. |
| Trusted tool-call context and idempotency | compliant | — | The plugin obtains native run and call IDs from pinned ContextVars and has no model/env fallback (`runtime/hermes/enterprise_bridge/__init__.py`; upstream [`approval_context.py`](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/tools/approval_context.py)). The Worker rebinds run/workspace/agent, authorizes the current capability, locks per agent, hashes the native call identity, rejects argument conflicts, and replays committed results (`apps/worker/src/runtime/bridge.ts:38-135`). | Keep the exact-pin native probe mandatory because the plugin imports underscored internals. |
| Plugin enablement, middleware and approval transport | compliant | P3 | Only `enterprise_bridge` is enabled; all built-in toolsets/MCP/tool-search are disabled; startup enumerates definitions and fails unless every tool belongs to the plugin (`runtime/hermes/start.py:63-95`). No LLM/tool request middleware or plugin approval transport is selected, which is appropriate while native dangerous tools are absent. Upstream `pre_tool_call` hook exceptions are fail-open ([`agent/tool_executor.py`](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/agent/tool_executor.py#L628)), but the static catalog restriction and server-side callback authorization remain independent controls. | Keep both layers. Add a probe that deliberately crashes the hook and proves no non-enterprise tool can appear or execute. |
| Memory, skill, delegation, MCP and background features | compliant | — | Native tool definitions are reduced to Enterprise only, which also suppresses skill index/auto-load prompt injection upstream; memory extraction/profile, nudges, background review/title generation, MCP, tool search, and delegation tools are disabled (`runtime/hermes/start.py:63-78`; upstream [`system_prompt.py`](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/agent/system_prompt.py#L299)). Native session transcripts intentionally remain enabled. | Add a generated-config assertion to the deployment health check and review it at every pin change. |
| Native cron | compliant | — | The launcher refuses a nonempty profile cron store before gateway startup, removes `/api/jobs*` and `/api/cron*` from the native route table before binding (including multiplex mirrors), and wraps native health/capabilities so a later nonempty store makes the profile unhealthy (`runtime/hermes/start.py`). The disposable native probe proved the route is 404 and injected disabled state makes health return 503. The upstream scheduler still exists, but Enterprise has no tool or HTTP path that can create a job. | Keep the empty-store and route assertions in the exact-pin probe. A hosted firewall/private route remains part of the unverified deployment boundary. |
| Attachment delivery | intentional divergence | — | Attachments are not delivered yet, but the turn route now rejects every nonempty or malformed `attachments` value with `attachments_unsupported` before loading a session, persisting a message, consuming admission budget, or creating a run (`apps/worker/src/routes/turns.ts`). A real-Postgres regression test proves no run is inserted. | Full support still requires tenant/session ownership and ready/not-deleted validation; persist IDs plus SHA-256/MIME/name/extraction version in the immutable run snapshot; send bounded, clearly untrusted extracted content or expose a governed `read_attachment` tool. Never trust client labels/URLs. |
| Model routing and secret isolation | compliant | — | The bridge accepts only the active agent/profile run and selected allowed Nous Portal model, resolves the workspace's encrypted inference key server-side, whitelists request fields, rejects redirects, and never returns provider bodies (`apps/worker/src/runtime/bridge.ts`). The workspace inference key remains separate from the Hermes runtime bridge credential. Launcher preflight validates the custom provider URL/key/mode (`runtime/hermes/start.py:96-103`). | Retain server-side model selection and per-call active-run checks. |
| Spend caps and usage/key attribution | incorrect | **P1** | Daily tokens are checked only before the Enterprise run (`apps/worker/src/routes/turns.ts:236-245`; `apps/worker/src/model/usage.ts:92-149`). Hermes can make multiple model calls afterward with no reservation or per-call budget check. Usage is stored once at native terminal status and attributed to whatever credential is current at finalization, not necessarily the key(s) used (`apps/worker/src/runtime/adapter.ts:165-191`). A run can overshoot a cap and key rotation can produce incorrect audit attribution. | Reserve/enforce budget in the model proxy before every provider call; record each call's key ID, usage, latency, and provider result as it occurs; reconcile/refund reservations from authoritative usage. |
| Runtime loss / reconnect / reconciliation | incorrect | P2 | SSE loss alone correctly falls back to polling. Any status/control transport failure exits the Workflow step, best-effort stops the native run, and immediately finalizes Enterprise state as retryable error (`apps/worker/src/runtime/adapter.ts:205-227`). If stop also fails, native work can continue until its Enterprise tool/model authority is rejected; a user retry starts another attempt and can duplicate model spend. | Persist a `reconciling` state, retry status with a bounded backoff across Worker restarts, and only finalize after a terminal native status or a supervised orphan timeout. |
| Concurrency | compliant | — | One active Enterprise Hermes run per agent is transactionally enforced, native gateway concurrency is one, and official session turn leases serialize shared native sessions. Fixture probe observed 429 rejection while a run waited. | Exercise the same test across two hosted Worker instances and a runtime restart. |
| Retention, deletion and backup | incorrect | **P1** | Official Hermes persists transcript/session state, run idempotency, API key, plugin/config, and cron stores under the profile. Enterprise workspace erasure covers Postgres/R2 but has no runtime-profile stop/revoke/delete or backup lifecycle. The gap is already disclosed in `docs/HERMES-AGENT-RUNTIME.md:88-95`. Hosted customer data could survive a workspace deletion or miss required restore controls. | Add a profile lifecycle service: stop and fence the process, revoke both credentials, delete or retain the entire bound profile according to policy, include backups, and record/test erasure and restore. |
| Hosted supervisor and production reachability | operationally unverified | **P1** | The launcher declares `--external-supervisor` (`runtime/hermes/start.py:106-108`), whose official contract requires restart on exit 75. No staging/production host, private route, restart policy, health gate, log/metric path, backup, or profile provisioner exists (`docs/HERMES-AGENT-RUNTIME.md:76-86`). | Deploy one isolated test profile behind the intended private route and supervisor; verify restart/exit-75, crash recovery, capability gate, fencing, secrets, logs, erasure, and a complete user turn before customer rollout. |

## Probe and test evidence

The following checks were run from this audit worktree without touching the running localhost services, live Iris state, production systems, or paid providers:

```text
Python 3.12.12 (locked runtime environment)
runtime/hermes/tests: 14 passed
native fixture probe: PASS
Node 26.8.1
Worker unit: 495 passed
Worker DB health/turns: 34 passed (isolated hermes_test)
Worker workerd: 29 passed
workspace typecheck: PASS
shared/client/Worker build: PASS
```

The native probe used a disposable Hermes home, exact pinned upstream source, a local fixture Enterprise server, and a deterministic fixture model. It verified:

- official HTTP gateway plus `AIAgent` execution;
- required authenticated server-agent Runs capabilities and durable reservations;
- durable same-key/same-body replay after a complete gateway restart;
- native cron route removal and health failure on injected nonempty cron state;
- exact Enterprise tool allowlist and custom model proxy;
- trusted native run/tool-call IDs and tool-history continuation;
- admission replay and payload conflict;
- expected single-consumer SSE behavior;
- concurrency rejection; and
- stop while an Enterprise context tool was pending.

The probe does **not** establish production readiness. It does not simulate a mid-stream network partition; exercise native `/approval` or all steer races; prove supervisor-managed crash recovery or cross-host fencing; test profile erasure/backups; deliver actual attachment content; perform a vulnerability scan of the locked environment; or validate real-provider quality, key rotation, per-call usage, latency, or spend caps.

## Required remediation order

1. **Close production control gaps:** implement the supervisor, shared profile fence, whole-process isolation, and profile retention/erasure lifecycle.
2. **Enforce spend at the proxy:** per-call reservation/accounting with the actual credential identity.
3. **Harden recovery:** durable runtime reconciliation, hosted interruption/orphan tests, and the remaining hook-failure probe.
4. **Implement attachments end to end:** immutable attachment identity/content is still intentionally unsupported even though false-success admission now fails closed.

## Pin recommendation

**Keep the exact current pin for local/integration work; do not ship it to hosted customer data yet. Do not move backward to stable `v2026.9.14`, and do not jump to current `main`. Wait for the next official stable release that contains the required post-`v2026.9.14` runtime/context fixes, then treat any move as a separate lead-reviewed upgrade.**

That upgrade must retain locked installation plus the exact-shape native probe's capability durability, restart replay, and cron assertions, then expand coverage for hook failure, end-to-end attachments, supervisor recovery, erasure, and model-call budget/accounting. Passing package version equality is not evidence of compatibility.
