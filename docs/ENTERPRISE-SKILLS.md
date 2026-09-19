# Enterprise-configured Hermes skills

Hermes Enterprise packages reviewed procedures as official Hermes skills while keeping authority, credentials, source access and approvals in the enterprise control plane.

The Partnerships package is `enterprise_bridge:partner-program-screening` version `1.7.0`. It is a real `SKILL.md` registered by the official runtime plugin and auto-loaded for Iris when that agent has a valid Partner Program assignment. It tells Iris how to inspect stored evidence, separate evidence from inference and gaps, run an explicitly requested fixed $0.01 LinkedIn/YouTube creator search or $0.005 X public-post search, choose one strongest prospect, enrich only that prospect's professional contact data, verify one professional email, prepare a draft-only outreach review, and stop for human review. AgentCash calls require exact one-use Worker leases; only sanitized imported evidence can support an Inbox proposal. The skill cannot send, call, text, message, invent contact data, or decide an application by itself.

The Finance package is `enterprise_bridge:partner-invoice-review` version `1.0.0`. It checks a Finance-private invoice against an explicitly shared engagement projection, flags duplicate invoices, missing evidence, currency mismatches and amount mismatches, and prepares a Finance-scoped human decision. It cannot approve the request, create an obligation from a qualification, execute a payment or send email.

## Why this matches Hermes

Official Hermes supports:

- `SKILL.md` packages with versioned procedure and metadata;
- read-only skills registered by a plugin;
- `skills.auto_load`, which preloads selected skills for a session;
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
dedicated Hermes profile · skills.auto_load
             ↓
Iris procedure + governed enterprise tools
             ↓
pending draft-only Inbox review · human decision
```

The runtime fetches `GET /internal/runtime/w/:workspace/agents/:agent/skills` with its agent-scoped bridge credential before it starts. The response is derived from that agent's active Enterprise skill assignment, names reviewed plugin skills and contains bounded non-secret configuration. The launcher validates the payload, rejects credential-shaped keys, writes `skills.auto_load` and `skills.config`, and fails startup if a named plugin skill is absent.

The dedicated enterprise profile removes Hermes's general bundled-skill catalog on startup and marks the profile as managed. Only plugin-packaged enterprise skills are available. The runtime exposes Hermes's read-only `skill_view` only for the exact assigned package because official `skills.auto_load` is gated on a skills tool being present. `skills_list`, `skill_manage`, native skill discovery, background review and automatic skill creation remain disabled. The plugin vetoes any attempt to view another skill or a linked file. This prevents a bundled or agent-authored procedure from expanding the governed tool boundary.

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

Only the authenticated invoice-review handoff route accepts an actual invoice
and starts the durable Finance review job. Qualification and outreach approval
do not call it. The job is idempotent, bounded to three attempts and prepares
one audience-scoped invoice request for the Finance principal. The existing
decision route still requires current document binding, recent authentication
and an authorized human. Payment and email effects remain pending and have no
executor. See `docs/PARTNER-FINANCE-WORKFLOW.md` for the local runbook.

## Adding another enterprise package

1. Add a reviewed `SKILL.md` beneath `runtime/hermes/enterprise_bridge/skills/`.
2. Register it read-only in `enterprise_bridge.register`.
3. Register its config schema, editable field metadata and semantic capability requirements in `apps/worker/src/enterprise-skills/registry.ts`.
4. Create an assignment through a reviewed Admin path. Declare only non-secret `metadata.hermes.config` values and keep credentials in the appropriate server-side connection.
5. Map its semantic capability grants to exact governed tools and preserve human decision boundaries in the procedure.
6. Add runtime boundary tests, launcher validation and an end-to-end native probe before enabling the package.

Skill packages must never grant a tool, loosen an approval, carry a secret or become evidence. They describe how Iris should use authority the enterprise has already granted.
