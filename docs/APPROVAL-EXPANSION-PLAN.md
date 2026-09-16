# Enterprise approval expansion

September 15, 2026 · Implementation plan and delegation contract

## Outcome

Make it easy for Maya to unblock Iris and other employees' agents without becoming the team's coordinator. Keep one Inbox beside the existing Iris conversation. Each request names the decision, the authorized human, its evidence, and what happens next.

Brian requested a complete enterprise demo, then authorized implementation in separate GPT-5.6 Sol tasks at xhigh with the current Hermes lead orchestrating. This plan covers ten additions to the existing application, invoice and agreement flows. It does not authorize external messages, real payments, legal execution, new paid services or production deployment.

## Baseline and constraints

- Integration repository: `outputs/hermes-enterprise`, branch `main`, implementation baseline `9a46b7d`.
- `packages/shared/src/enums.ts` currently permits application, invoice and agreement requests. Legacy approval produces admitted, created or drafted; those statuses do not mean external execution succeeded.
- `apps/worker/src/domain/decisions.ts` has a single admin decision path. Effects record required reviewers, but this is not a complete multi-person voting engine.
- `apps/client/src/app/views/Inbox.tsx` provides the split Inbox and full invoice/agreement review. Preserve it, including back navigation, source evidence and the Iris pane.
- Payment/signature intent currently lives in a review note. Notes must remain annotations, never a source of authorization for the new engine. Do not reinterpret old notes as valid votes or signatures.
- The official Hermes runtime is integrated, with one agent per profile. Its present native waits are bounded and cannot provide a multi-day approval checkpoint. See `HERMES-AGENT-RUNTIME.md`.
- No bank, signature, email or arbitrary deployment executor is available. Show an honest approved/waiting/unavailable state when a connector is absent.

## Approval families

The first five additions form the principal walkthrough. All ten get validated payloads, reusable detail components, representative fixtures and a decision/result path. Do not invent one UI per industry.

| Addition | Partner Program example | Human authority | Main preview | Approval consequence |
| --- | --- | --- | --- | --- |
| Plan and budget | Research potential partners each week | Maya; budget owner only above her limit | Goal, ordered steps, agents, output, cost range and cap | Authorize this plan version within these limits |
| Cross-team commitment | Ask a colleague's agent to check technical evidence | The receiving agent's responsible human | Requester → recipient, workload, due date, dependencies, acceptance criteria | Accept a bounded task; preserve the receiving agent's mandate |
| Temporary access | Read a restricted partner reference folder | Resource owner | Resource, read/write scope, purpose, expiry | Permit the specified access when a supported executor applies it |
| External communication | Send a reviewed introduction to selected prospects | Authorized sender/owner | Actual recipients, full message, attachments, sender and schedule | Authorize the exact outgoing message; sending is a separate effect |
| Shared learning | Publish Iris's improved screening checklist | Skill owner | Version diff, source references, reuse audience, excluded private data | Publish the reviewed reusable instructions; do not share source data implicitly |
| Deliverable acceptance | Accept the weekly partner shortlist | Result owner | Full artifact, evidence, missing information, version | Mark the artifact accepted and release its dependent work |
| Data disclosure | Share a partner summary with another organization | Data owner | Exact fields/files, recipient, redactions, retention | Authorize that disclosure to that audience only |
| System or record change | Update partner status or an onboarding workflow | System/record owner | Before/after diff, affected records, validation, rollback | Apply the approved change when an executor is available |
| Exception | Temporarily bypass an onboarding requirement | Owner of the rule | Rule, reason, compensating control, expiry | Allow one bounded exception; do not weaken the general policy |
| Agent governance | Change Iris's recurring schedule or allowed tools | Agent owner and relevant resource owner | Current → proposed settings and affected permissions | Apply the approved configuration version within existing authority |

Manager escalation is routing, not an eleventh approval type. A budget increase is a plan revision. Clarifications and unresolved disagreements are requests for input, not fabricated approve/decline choices. Work already allowed by an agent's mandate should not generate an approval just to demonstrate the UI.

## One coherent story

Maya owns Iris and the recurring Hermes Partner Program responsibility. Owen and Leah remain separate applicants. Robin Studio remains the existing provider for the invoice and services agreement; keep those records and their current decisions intact.

1. Iris proposes the recurring partner research plan. Maya can approve within her authority; a higher spending limit routes to a separately named budget approver.
2. Iris can continue permitted research while a colleague reviews temporary access or accepts a technical-review commitment for their own agent.
3. The accepted technical review feeds the partner shortlist. The result links to the specific work and evidence that produced it.
4. Maya reviews an exact outgoing introduction. Program terms remain unspecified until confirmed; the fixture must not invent a revenue share or send a message.
5. Iris proposes a reusable screening improvement. Publishing instructions does not publish private applicant evidence or silently change other agents.
6. Additional examples demonstrate deliverable acceptance, disclosure, record change, exception and governance, with the same shell and decision rules.

Colleague identities and authority in the new demo are explicit fictional fixture data. Do not infer a real organization hierarchy from a name. Every agent shown has its own human/profile binding. The demo must distinguish a simulated colleague agent from a provisioned official runtime.

## Minimal interface changes

- Keep sidebar → Iris chat → app. The Inbox must work with the harness visible and in the expanded app view.
- Keep the master list and detail pane, type filter, back behavior and full documents. Extend the list with a small type icon, concise subject, responsible reviewer and actual state.
- Add a compact reviewer filter: For me / Waiting on others / All. Counts refer to actionable requests, not individual votes. Pending work assigned to someone else must not inflate Maya's attention count.
- One common detail header: proposer/agent identity, title, version and current reviewer. One type-specific visual body. One compact reviewer sequence and consequence footer.
- Use a specific primary action: Approve plan, Accept task, Allow access, Approve send, Publish skill, Accept result, Allow sharing, Approve change, Allow exception. Use Request changes as the common secondary action; decline and routing can live in overflow. Show only actions the server says the viewer can take.
- Inline requests for changes create a new version for review. No sprawling modal stack or repeated explanation above the preview.
- In chat, render a compact card linked to the same request record. Show the actual reviewer/status and Open request. Do not duplicate decision state in transcript text.
- Overview draws attention to the same blockers and waiting work; History distinguishes the human verdict from the executor result.
- Preserve navy/indigo gradients, glass icons, existing typography and component spacing. Reuse existing motion primitives. A short row/status transition follows server confirmation, retains focus and scroll, and has an immediate reduced-motion path. No celebratory success for an action merely authorized.

## Shared contract and architecture

Extend the request system additively with `RequestKind = 'approval'` and a validated `payload.approval_type` discriminator. Keep the three legacy kinds and their existing statuses/routes compatible. The ten discriminators are:

`run_plan`, `team_commitment`, `access`, `communication`, `shared_learning`, `deliverable`, `data_disclosure`, `record_change`, `exception`, `agent_governance`.

The shared package owns their Zod schemas and TypeScript types. The backend worker owns and publishes the exact contract before dependent integration. Do not create divergent frontend/runtime definitions.

Each new payload includes:

- `approval_type`, `summary`, `consequence`, `details` (validated per type), `evidence` references and an explicit `illustrative` flag.
- Requester agent/user identity resolved against real workspace membership, target agent/resource identifiers where applicable, source session/run and dependent request identifiers.
- A stable authorization revision/hash separate from incidental note updates. Mutable notes never invalidate or grant approval, but material changes require a new authorization revision.
- Server-owned review policy: named eligible members or verified authority roles, sequential/parallel review steps, quorum and optional prevention of self-review. Agents cannot invent a more permissive policy.
- An expiry, recorded human votes and derived viewer capabilities. Authorization is bound to the reviewed payload, plan/document version, audience and limit.
- Durable execution/continuation links and result evidence. Authorization state, work state and provider effect state remain separate.

Proposed compatible API surface, finalized by the backend contract checkpoint:

| Endpoint | Purpose |
| --- | --- |
| Existing `GET /w/:ws/requests` and `GET /w/:ws/requests/:id` | Return old and new types through the same Inbox |
| `GET /w/:ws/requests/:id/approval` | Typed proposal, policy, votes, eligibility and execution/continuation state |
| `POST /w/:ws/requests/:id/approval/decisions` | Approve, decline or request changes, with expected authorization revision and idempotency key |
| `POST /w/:ws/requests/:id/approval/revisions` | Submit a changed proposal without retaining old votes |
| `POST /w/:ws/requests/:id/approval/route` | Authorized assignment/escalation, preserving the policy and audit |

Use existing authentication, CSRF, transaction, RLS, audit and replay mechanisms. Recheck membership, reviewer authority, expiry, dependencies and version inside the transaction. A removed reviewer, stale browser, repeated vote, concurrent decision or agent-crafted HTTP request must not bypass the gate. No approval by timeout. Do not permit an admin to stand in for an independently required second person.

Legacy documents remain fully usable. Where old document consent remains a prototype, label it accurately. The new generalized authorization cannot be granted via a note, a UI checkbox alone or a string match against fictional payload text.

## Runtime and budget behavior

- Hermes may propose an approval, inspect its status and explain the blocker. Only an authorized human records a decision.
- Persist continuation intent before ending a proposal run. Resume through a fresh, linked native run after approval, with the current agent/profile binding and reviewed inputs; do not pretend the old Python call stack survived indefinitely.
- Resume only eligible dependent work. Dedupe the continuation across webhook/replay/retry, preserve Stop/cancel, and recheck current permissions. A rejected, expired or superseded proposal never resumes. Unrelated work can continue.
- Begin with the configured Iris profile. A request for an unprovisioned colleague agent stays explicitly waiting for setup; fixtures can demonstrate simulated completion with a visible demo label.
- Show estimated currency cost prominently and token counts in details. Include model, all participating agents, retries and metered tools in the estimate where known. Estimate is not a provider quote or a guarantee.
- Fixture estimates are explicitly illustrative; they are not current pricing. Do not copy the earlier example's dollar/token numbers as measured facts.
- A hard cap requires reservations before calls, maximum output bounds, concurrency accounting and reconciliation. Stop before admitting work that cannot fit; request a revised budget. Unknown/unpriced execution fails closed. Do not advertise an exact enforced cap if an adapter cannot bound its in-flight cost.
- Reuse the current usage/model proxy controls; avoid a second billing system. Keep external money movement entirely separate from model-usage budget authorization.

## Delivery sequence and ownership

Three isolated GPT-5.6 Sol / xhigh work sessions, with the current Hermes task integrating. Main stays the known working app while workers build.

### A. Approval contract and server

Own `packages/shared/**`, new approval domain/routes, existing request/decision/effect integration, migrations `0022_*`, and related backend tests. Publish a first contract commit and `docs/APPROVAL-CONTRACT.md` early so the other tasks can import it. Then finish all ten schemas, policy/voting/versioning, routing and status projection. Maintain existing behavior and document connector limitations.

### B. Inbox and harness experience

Own `apps/client/**`: one reusable detail shell, ten visual payload renderers, reviewer route/status, request-changes flow, chat cards, attention counts and fixtures. Preserve Iris, full invoice/agreement flow and applicant evidence. Read A's published contract before finalizing API integration. Verify rendered split/expanded layouts and actual decisions for every fixture. Use UI Motion skill; no package/framework migration for polish.

### C. Hermes continuation and budget controls

Own `apps/worker/src/runtime/**`, `apps/worker/src/runs/**`, `apps/worker/src/engine/**`, `apps/worker/src/usage/**`, required model-proxy changes, `runtime/hermes/**`, migrations `0023_*` if necessary, and runtime-specific tests. Coordinate A's proposal and decision contract before linking it. Implement typed agent proposal/status tools, durable linked continuation and enforceable limits where supported. Report exact unavailable capability rather than returning fabricated execution success.

### Lead integration and QA

The lead owns main, final glue, migration ordering, isolated test databases, representative demo setup and end-to-end verification. Workers commit only their slice and report exact commits/checks. No worker starts/stops the existing localhost server, resets/seeds the user's current workspace, runs tests against a shared writable database concurrently, merges main or deploys. New demo data belongs to a dedicated resettable fixture workspace/scenario, not silently injected into the current four-item queue.

Integrate A's shared contract first, then A's server, C's runtime and B's client. Resolve interfaces before running the combined suite. If a task finishes with a dependency outstanding, the lead sends the completed contract/change back for a bounded follow-up; no competing edits in another task's checkout.

## Observable acceptance

1. Existing two applications, invoice and agreement keep their current states and full previews. Back-to-Inbox and Iris layout work throughout.
2. Every new type has a representative full preview, an eligible human decision, request-changes/decline behavior and a truthful next-state receipt.
3. A two-stage plan shows Maya's decision and the required next reviewer; one vote does not unlock a two-person requirement. Both views and counts agree after refresh.
4. A receiving owner can accept a task for their agent without granting the requester general control over it. Missing profile/resource/authority stays visible.
5. Changed proposal/version, expired permission, removed reviewer, self-review prohibition and duplicate submissions are rejected at the server, not merely hidden in the UI.
6. Approval persists across restart. The associated continuation is admitted at most once, uses the correct agent/profile, and stops or waits when its mandate or supported budget limit prevents execution.
7. No real mail, money, document signature, deployment, external disclosure or access grant happens in these tests. Unsupported executors say so. Fixture completion remains labeled as simulation.
8. Main Inbox, Overview, chat cards, History and agent-filtered Traces refer to the same IDs and actual states; a human verdict is not displayed as agent execution.
9. Relevant shared/client/worker unit, DB/RLS and browser tests pass. Exercise narrow split view, expanded app, keyboard navigation, slow/error states, rapid repeated actions and reduced motion in the rendered UI.

## Research basis

These are product design influences, not a claim that any referenced SDK is the Hermes runtime or that this list is an enterprise standard.

- [Microsoft agent design canvas](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/agent-design-canvas-framework): define autonomy, escalation and human decision boundaries.
- [Microsoft agent governance](https://learn.microsoft.com/en-us/microsoft-365/copilot/agent-essentials/m365-agents-admin-guide): review capabilities and sources before publication.
- [GitHub protected environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments): eligible reviewers and separation of duties.
- [HashiCorp approval workflow](https://developer.hashicorp.com/validated-designs/boundary/administration-guide/approval-workflow-integration): access target, purpose and duration.
- [OpenAI human-in-the-loop pattern](https://openai.github.io/openai-agents-python/human_in_the_loop/): explicit interruptions and persisted continuation state. Hermes support must be implemented and tested independently.

Progress, task IDs and integrated commits belong in `APPROVAL-EXPANSION-STATUS.md`; this document remains the scope and acceptance contract.
