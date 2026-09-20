# Enterprise-configured Hermes skills

Hermes Enterprise packages reviewed procedures as official Hermes skills while keeping authority, credentials, source access and approvals in the enterprise control plane.

Existing Partnerships profiles keep the immutable
`enterprise_bridge:partner-program-screening` version `1.7.0` procedure. It
inspects stored evidence, separates evidence from inference and gaps, uses
bounded AgentCash searches under one-use Worker leases, prepares draft-only
outreach and stops for human review. Restarting a legacy profile does not add
the new handoff publisher.

The multi-party workflow is an explicit, per-profile transition:

| Assignment | Runtime package | Version | Artifact digest |
| --- | --- | --- | --- |
| Partnerships | `enterprise_bridge:partner-program-screening-v1-8` | `1.8.0` | `sha256:281bbfff95d40e202c3ced5d1cb30ebf432868bee100d0c2a647faa40757a9e5` |
| Finance | `enterprise_bridge:partner-invoice-review` | `1.0.1` | `sha256:bdb13d70f7a603f92eb47fc2d1c057c82f26658e61df8cf357790f23875753e4` |

The Partnerships 1.8 package adds only the governed publication of a previously
confirmed intake. Finance 1.0.1 checks a Finance-private invoice against an
explicitly shared engagement projection, flags duplicate invoices, missing
evidence, currency mismatches and amount mismatches, and prepares a
Finance-scoped human decision. It cannot approve, create an obligation from a
qualification, execute payment or send email. Historical Finance 1.0.0 remains
resolvable for old assignments but does not receive the new result tool or
satisfy strict multi-party admission.

## Why this matches Hermes

Official Hermes supports:

- `SKILL.md` packages with versioned procedure and metadata;
- read-only skills registered by a plugin;
- plugin system prompt sections, which freeze bounded plugin text into every new session's prompt;
- `metadata.hermes.config`, whose non-secret values are resolved from `skills.config` and injected when the skill loads; and
- skill bundles and external skill directories for other deployment shapes.

References:

- [Hermes Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [Hermes plugin API](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)

## Enterprise boundary

```text
reviewed SKILL.md in enterprise_bridge
             +
agent-scoped non-secret config from Worker
             ↓
dedicated Hermes profile · plugin-pinned skill sections
             ↓
Iris procedure + governed enterprise tools
             ↓
pending draft-only Inbox review · human decision
```

The runtime fetches `GET /internal/runtime/w/:workspace/agents/:agent/skills` with its agent-scoped bridge credential before it starts. The response is derived from that agent's active Enterprise skill assignment, names reviewed plugin skills and contains bounded non-secret configuration. The launcher validates the payload, rejects credential-shaped keys, writes `skills.config`, and fails startup if a named plugin skill is absent. The plugin fetches the same authenticated assignment when Hermes registers it, verifies the packaged `SKILL.md` bytes against the reviewed version and digests, and registers that text as numbered system prompt sections; startup and Cloud readiness fail unless the live render equals the sections recomputed from the reviewed bytes.

The dedicated enterprise profile removes Hermes's general bundled-skill catalog on startup and marks the profile as managed. Only plugin-packaged enterprise skills are available. The runtime exposes Hermes's read-only `skill_view` only for the exact assigned package so the model can re-read it; the pinned 0.21.3 release has no `skills.auto_load`, and the launcher and Cloud validator reject that key. `skills_list`, `skill_manage`, native skill discovery, background review and automatic skill creation remain disabled. The plugin vetoes any attempt to view another skill or a linked file. This prevents a bundled or agent-authored procedure from expanding the governed tool boundary.

New multi-party admission requires exact native readiness: runtime revision
`345cd2b057a452236de401d3534b8502a7465e8d`, plugin/version `1.7.0`, one current
skill with artifact and content digests equal to the assignment, the exact tool
inventory, and native cron disabled. Partnerships 1.8 requires AgentCash and a
wallet; Finance 1.0.1 requires both absent. Compatibility readiness keeps old
profiles operable, but it can never open new multi-party admission. The deployed
Partnerships 1.7 registry identity and its byte digest are explicitly tracked as
a legacy alias rather than treated as a current byte attestation.

The procedure and authority deliberately remain separate:

| Concern | Owner |
| --- | --- |
| Procedure, examples and verification | Versioned enterprise `SKILL.md` |
| Non-secret program settings | Versioned agent assignment → Worker manifest → `skills.config` |
| Provider and source credentials | Encrypted/server-side credential stores |
| Available tools | Agent capabilities and enterprise bridge |
| Approval requirements | Enterprise request and decision policy |
| Evidence and audit | Postgres artifacts, traces and Inbox history |

## Enterprise skill assignments

`enterprise_skill_assignments` binds one registered skill version to one agent.
It stores validated non-secret config, semantic capability grants, schedule,
approval policy, active/paused state and a monotonic revision. A database
trigger appends every revision to `enterprise_skill_assignment_revisions`.
The agent database role can read both tables and cannot write either one.

The Partner Program assignment includes source, program name, role, keywords,
bounded People Search filters, spend cap, triage weights, evidence threshold and
candidate limit. It fixes `no_outreach: true` and
`human_review_required: true`. Wallet material, `PARTNER_GITHUB_TOKEN`, Gmail
credentials and the Nous inference credential never enter an assignment or
runtime skill config.

Library → Skills exposes the assignment to an Admin as a schema-driven editor.
Each role-template assignment also pins an immutable artifact digest and its
Partnerships or Finance team. A run snapshots that assignment revision,
artifact, connection binding, capability, resource and exact allowed action.
The server rechecks active state, revision, artifact identity and explicit
denies before connector work. Private partner records are not granted to the
database `agent` role; only the app-owned connector service can project the
run's allowlisted result.

Saving creates a new revision. Pausing removes the skill manifest and its
assignment-derived tools from later runtime calls. Disabling the schedule stops
proactive discovery while preserving manual use. Each native run snapshots the
exact managed skill version and non-secret config in its immutable request.
New role-template assignments default to schedules off.

`PARTNER_SCREENING_CONFIG_JSON` remains a rolling-deployment compatibility
source. Ordinary list and detail reads never import it or enable a schedule.
Only an explicit setup/execution compatibility path may materialize revision 1;
after that, the database assignment is authoritative, including a paused state.

## Partnerships + Finance workflow

An Admin explicitly binds two distinct employees and two distinct agents to the
`partnerships-agent` and `finance-agent` role templates. Both templates use the
same `enterprise-partner-records` connector implementation with different
server-enforced scopes. Partnerships research, correspondence and sessions stay
private. Finance invoices, review notes and sessions stay private. A handoff
contains only shared partner identity, engagement reference/summary, authorized
currency and amount, evidence ids, pinned record revisions and one approved
source-session excerpt.

Only a human-authorized engagement plus an immutable confirmed invoice intake
can start the durable Finance review. The 1.8 model tool receives only the
intake event id and expected hash; it cannot supply invoice fields, recipient,
provenance or authority. Qualification, outreach approval and an unsigned
agreement draft do not satisfy this contract. The job is idempotent and
prepares one audience-scoped invoice request for the Finance principal. The
existing guarded decision route requires the named Finance reviewer, current
document binding and recent authentication. Approval saves a Library invoice
draft. Payment and email effects remain pending and have no executor. See
`docs/PARTNER-FINANCE-WORKFLOW.md` for the route and rollout runbook.

## Adding another enterprise package

1. Add a reviewed `SKILL.md` beneath `runtime/hermes/enterprise_bridge/skills/`.
2. Register it read-only in `enterprise_bridge.register`.
3. Register its config schema, editable field metadata and semantic capability requirements in `apps/worker/src/enterprise-skills/registry.ts`.
4. Create an assignment through a reviewed Admin path. Declare only non-secret `metadata.hermes.config` values and keep credentials in the appropriate server-side connection.
5. Map its semantic capability grants to exact governed tools and preserve human decision boundaries in the procedure.
6. Add runtime boundary tests, launcher validation and an end-to-end native probe before enabling the package.

Skill packages must never grant a tool, loosen an approval, carry a secret or become evidence. They describe how Iris should use authority the enterprise has already granted.
