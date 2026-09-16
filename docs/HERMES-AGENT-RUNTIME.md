# Official Hermes Agent runtime

Hermes Enterprise now has an execution adapter for the official Nous runtime,
pinned to `5d59366010640c1d6b8f170d8a4ee109db2bbdef` (package 0.21.3).
The Worker remains the enterprise control plane and system of record.

## Identity and state

One `agents.id` maps to one profile: `agent-<uuid>`. Each runs in a separate
process with a separate `HERMES_HOME`, OS home, session database and working
directory. The launcher refuses a second process on the same profile. Profiles
isolate application state; they are not an OS sandbox or a substitute for RBAC.

Sessions and runs retain enterprise `agent_id`. A run also records its runtime
kind, profile, native run/session IDs and attempt. Existing traces retain their
previous-runtime label; new official runs display `Hermes Agent`. Trace reads
remain restricted to the agent and sessions the viewer can access.

## Execution

1. The browser sends a turn through the existing authenticated Worker route.
2. The Worker validates membership, session ownership, model, limits and agent
   binding. It snapshots the native submission in Postgres, never in Workflow
   checkpoint payloads.
3. A Workflow submits `POST /v1/runs` with an attempt-specific idempotency key.
   The native session ID is the enterprise session ID. Hermes owns its continued
   transcript. Existing conversation messages seed the first native run.
4. Native text deltas feed one enterprise assistant message. Tool callbacks
   persist the real tool IDs, arguments and results in the existing trace rows.
5. Final message, usage, duration and events commit atomically. Hub delivery
   happens afterward; delivery failure does not turn completed work into failure.
6. Stop immediately reaches the native run. The app confirms terminal execution
   before showing Stopped, including a native failure caused by revoking tool
   authority after Stop. Human guidance uses native steer; unconsumed guidance
   carries into the next message. Human-context pauses use the composer to answer
   the same run. A persisted per-attempt clock excludes those waits from Worked.

The native SSE queue has **no replay**. Reconnection uses native run status and
final output; browser replay comes from durable enterprise events. No raw model
reasoning is required for the activity indicator.

## Tools and credentials

The official runtime loads a narrow enterprise plugin. It gets runtime run and
call IDs from native ContextVars, not model arguments. The Worker maps those IDs
to the current agent/run/attempt, then rechecks mode and tool permissions. A
repeated call returns its stored result; changed arguments under the same ID are
refused. Old attempts and stopped runs cannot execute tools.

The bridge uses the existing restricted Postgres `agent` role. It can read
workspace context/documents, prepare Inbox requests, write review notes and
propose context/instruction changes. Human approval, payments, signatures, role
changes and invitation authority remain in the enterprise routes.

OpenRouter remains the model provider. The native runtime calls an authenticated,
agent-scoped model proxy; the Worker resolves the workspace's current encrypted
key for each call. Provider keys are never copied into profile configuration.
Only the selected catalog model can be called. Each profile executes one run at
a time, enforced in the Worker and native API.

## Running locally

See [the runtime launcher](../runtime/hermes/README.md) for install, start,
configuration and source-contract checks. Enable `AGENT_RUNTIME=hermes` and
provide `HERMES_RUNTIME_AGENTS` and `HERMES_BRIDGE_SECRET` as server secrets.
Missing bindings fail explicitly; there is no silent fallback to a chat loop.
The legacy/scripted path remains available for existing deployments and offline
contract tests during rollout.

The first connected profile is Iris in the local workspace. The UI reports
Local execution, separately from the remotely served model. Existing sessions
resolve their location from the current profile binding too. Iris’s dedicated
state lives under `~/.he-runtime/44444444-4444-4444-8444-444444444444/`; the personal
`~/.hermes` installation is untouched.

## Deployment limits

This change does not deploy a runtime host to staging or production. The staging
Worker cannot reach a loopback profile on this computer. A hosted deployment
needs a private authenticated runtime endpoint for each configured profile and
process/container supervision. Provisioning additional profiles is explicit
configuration today; this change does not automatically start a runtime for every
new member. A native run keeps its process while waiting and is bounded by the
adapter’s 55-minute execution window (60-minute Workflow step timeout). Multi-day
human waits need a durable suspend/resume lifecycle before hosted rollout. Inbox
proposals do not hold the runtime open while a reviewer decides.

Native shell, filesystem, browser, arbitrary MCP, delegation and cron tools are
not enabled. The launcher additionally refuses nonempty native cron state,
removes native cron REST routes before binding, and makes native health fail if
a job later appears. Automatic memory extraction, background review and learning nudges
are disabled while enterprise ownership and retention integration is completed.
The official runtime still persists its session transcript. Production erasure,
backup and retention must cover that profile store as well as Postgres/R2 before
opening this execution path to hosted customer data. Shared skills stay governed
by the enterprise app; this change does not claim full native skill lifecycle
integration. Hermesmail remains a concept address, not a provisioned mailbox.

Official references: [Runs API](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server),
[profiles](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md),
and [security](https://github.com/NousResearch/hermes-agent/blob/main/SECURITY.md).

## Verified locally — September 15, 2026

Real calls used the workspace’s encrypted OpenRouter credential and its selected
`anthropic/claude-sonnet-5` catalog model, through the official pinned AIAgent.
These checks are separate from the native probe’s fixture model.

| Check | Observed result |
| --- | --- |
| Context and Inbox read | Native tools returned actual local data; one structured assistant response and correlated trace. |
| Session continuity | A following turn recalled “silver lantern” from its prior native session. |
| Human context answer | Run `0a2e656f-cf56-456c-abec-585406b11611` resumed through the composer; 8,673 ms active, 20,013 ms human wait excluded. |
| Human-review proposal | Run `55dd1ac9-c4d3-4774-93c4-16edb2b5a1ca` created one fictional QA-only application, left pending, and focused it on the right. No decision, invitation or external message. |
| Stop while waiting | Run `34434547-50e1-45b9-bd76-67c505425600` reached Stopped after native termination; further tools were blocked. |
| Native state move/restart | Session and idempotency databases retained; watchdog healthy; durable native admission confirmed. |
| Original localhost:8787 | Run `f6ad2eb0-2a3f-4955-bb42-eef06aca83b5` read the pending Inbox and focused Traces; the next turn recalled “silver lantern” after restart. |

The QA session is **Official Hermes runtime verification**. Its deliberately
labeled test request is `9ed1133e-aa40-4b71-b279-4dc006663838`. Initial failed
verification attempts remain visible in Traces; they are not relabeled as
successes.

Automated verification includes shared/client/Worker unit checks, the full
Worker database suite under the restricted roles, native workerd transport,
eight isolated browser regressions for context/Stop/key disclosure, Python
launcher/plugin checks and the real official-gateway fixture probe.

Local delivery is active at `http://localhost:8787`, with Iris’s official runtime
on port `8642`. The temporary app on `8790` has been stopped. Worker database
checks passed 368 tests, workerd 29, and the affected Stop routes 19 additional
checks. All workspace typechecks passed after integration.
