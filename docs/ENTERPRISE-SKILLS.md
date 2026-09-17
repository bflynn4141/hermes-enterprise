# Enterprise-configured Hermes skills

Hermes Enterprise packages reviewed procedures as official Hermes skills while keeping authority, credentials, source access and approvals in the enterprise control plane.

The first package is `enterprise_bridge:partner-program-screening` version `1.3.0`. It is a real `SKILL.md` registered by the official runtime plugin and auto-loaded for Iris when that agent has a valid Partner Program policy. It tells Iris how to inspect stored evidence, separate evidence from inference and gaps, prepare an application request, and stop for human review. AgentCash is limited to the exact Worker-configured People Search request and needs a one-use Worker lease before payment; only sanitized imported evidence can support an Inbox proposal. The skill cannot contact anyone or decide an application by itself.

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
pending Inbox request · human decision
```

The runtime fetches `GET /internal/runtime/w/:workspace/agents/:agent/skills` with its agent-scoped bridge credential before it starts. The response names reviewed plugin skills and contains bounded non-secret configuration. The launcher validates the payload, rejects credential-shaped keys, writes `skills.auto_load` and `skills.config`, and fails startup if a named plugin skill is absent.

The dedicated enterprise profile removes Hermes's general bundled-skill catalog on startup and marks the profile as managed. Only plugin-packaged enterprise skills are available. The runtime exposes Hermes's read-only `skill_view` only for the exact assigned package because official `skills.auto_load` is gated on a skills tool being present. `skills_list`, `skill_manage`, native skill discovery, background review and automatic skill creation remain disabled. The plugin vetoes any attempt to view another skill or a linked file. This prevents a bundled or agent-authored procedure from expanding the governed tool boundary.

The procedure and authority deliberately remain separate:

| Concern | Owner |
| --- | --- |
| Procedure, examples and verification | Versioned enterprise `SKILL.md` |
| Non-secret program settings | Agent-scoped Worker manifest → `skills.config` |
| Provider and source credentials | Encrypted/server-side credential stores |
| Available tools | Agent capabilities and enterprise bridge |
| Approval requirements | Enterprise request and decision policy |
| Evidence and audit | Postgres artifacts, traces and Inbox history |

## Partner Program configuration

The current slice derives skill settings from `PARTNER_SCREENING_CONFIG_JSON`, including source, program name, role, keywords, bounded People Search filters, spend cap, triage weights, evidence threshold and candidate limit. The manifest also fixes `no_outreach: true` and `human_review_required: true`. Wallet material, `PARTNER_GITHUB_TOKEN`, and the Nous inference credential are never returned by the skill endpoint or written into the profile's skill config.

The skill appears as **In use** on the Agent and Library skill surfaces whenever the bound agent has a valid policy. The same version is auto-loaded in the native runtime.

Today this configuration is deployment-managed and takes effect after the profile restarts. Each run snapshots the exact managed skill version and non-secret configuration in its immutable runtime request, so a later audit can reconstruct the procedure the agent received. A production Admin editor should write a validated workspace policy, create an immutable config version, and restart or reload the affected profile. That editor and hot reload are not part of this slice.

## Adding another enterprise package

1. Add a reviewed `SKILL.md` beneath `runtime/hermes/enterprise_bridge/skills/`.
2. Register it read-only in `enterprise_bridge.register`.
3. Add an agent-scoped manifest entry in `apps/worker/src/runtime/skills.ts`.
4. Declare only non-secret `metadata.hermes.config` values. Put credentials in the appropriate server-side connection instead.
5. Require the exact governed tools in the skill metadata and preserve human decision boundaries in the procedure.
6. Add a UI card, runtime manifest tests, launcher validation and an end-to-end native probe before enabling the package.

Skill packages must never grant a tool, loosen an approval, carry a secret or become evidence. They describe how Iris should use authority the enterprise has already granted.
