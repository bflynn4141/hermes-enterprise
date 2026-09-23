# Documentation index

Use this page to choose the right source before loading a large document. The
first two sections describe the current repository. The final section preserves
dated evidence and proposals that may no longer describe current behavior.

## Start here

| Document | Purpose |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | Current system shape, authority boundaries, implemented limits, local operation, and invariants |
| [Conventions](CONVENTIONS.md) | Directory ownership, naming, migrations, tests, and dependency rules |
| [Decision index](DECISIONS.md) | Split, searchable record of consequential implementation choices |
| [Runbook](RUNBOOK.md) | Deployment, health, incident, restore, and operator procedures |
| [Security review](SECURITY-REVIEW.md) | Threat model, controls, and security findings |
| [Contributor guide](../CONTRIBUTING.md) | Setup, pull request expectations, and required checks |

## Current subsystem references

| Area | Documents |
| --- | --- |
| Approvals and permissions | [Approval contract](APPROVAL-CONTRACT.md), [approval runtime](APPROVAL-RUNTIME.md), [agent operation permissions](AGENT-OPERATION-PERMISSIONS.md) |
| Hermes runtime | [Official runtime integration](HERMES-AGENT-RUNTIME.md), [cloud management](CLOUD-MANAGEMENT.md), [enterprise skills](ENTERPRISE-SKILLS.md) |
| Team workflows | [Partnerships and Finance](PARTNER-FINANCE-WORKFLOW.md), [partner screening](PARTNER-SCREENING.md), [inbound email evidence](INBOUND-EMAIL-EVIDENCE.md) |
| Provider and identity | [Nous Portal OAuth](NOUS-PORTAL-OAUTH.md), [WorkOS production checklist](WORKOS-PRODUCTION-CHECKLIST.md) |
| Product behavior | [Prompt navigation](PROMPT-NAVIGATION.md), [Iris latency](IRIS-LATENCY.md), [Raindrop observability](RAINDROP-OBSERVABILITY.md) |

## Dated delivery evidence and proposals

These files explain how a feature was evaluated or delivered. They are useful
for history, but the architecture, conventions, code, and tests take precedence
when a claim conflicts with current behavior.

| Type | Documents |
| --- | --- |
| Delivery records | [First provisioning](PROVISIONING.md), [Approval Inbox delivery](APPROVAL-INBOX-DELIVERY.md), [approval expansion status](APPROVAL-EXPANSION-STATUS.md), [production readiness status](PRODUCTION-READINESS-STATUS.md) |
| Plans and proposals | [Approval expansion plan](APPROVAL-EXPANSION-PLAN.md), [first-run experience proposal](FIRST-RUN-EXPERIENCE-PROPOSAL.md) |
| Audits and findings | [Hermes compliance audit](HERMES-COMPLIANCE-AUDIT.md), [production readiness findings](PRODUCTION-READINESS-FINDINGS.md), [production readiness sweep](PRODUCTION-READINESS-SWEEP.md), [QA quality-of-life audit](QA-QOL-AUDIT.md) |
| Research | [Slack integration research](SLACK-INTEGRATION-RESEARCH.md) |

When behavior changes, update the current subsystem reference and add or amend
an architecture decision. Do not silently rewrite a dated audit to make it look
current.
