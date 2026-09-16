# Enterprise approval contract

This is the shared contract checkpoint for the approval expansion. It is additive: `application`, `invoice`, and `agreement` retain their legacy decisions and effects, while `RequestKind = "approval"` uses the policy/vote/revision flow described here.

## Trust boundary

An agent or runtime calls `proposeApproval(context, input)`. `input` is `ProposeApprovalInput`; it contains a typed proposal, a server-known `policy_key`, requested targets/expiry and an idempotency key. It deliberately cannot contain requester identity, reviewer identities, a policy object, an authorization revision, or an authorization hash.

The server resolves and validates `context.workspaceId`, `context.agentId`, `context.userId`, `context.sessionId`, and `context.runId` against the active tenant and agent binding. It selects and snapshots the applicable immutable policy, verifies every named member/authority role in that workspace, chooses an allowed expiry, and computes `sha256:<canonical material fields>`. The stored `ApprovalPayload` is the flattened proposal plus that verified context, policy and authorization binding. Review notes are excluded from the hash and can never authorize work.

`policy_key` is a hint, not authority. The server first selects the applicable policy from approval type, verified requester agent, target resources and approved budget cap; a caller-supplied weaker/different key is rejected. Resource and receiving-agent owners must be mathematically required by the selected quorum, not merely listed among reviewers. A source run must still be `working` or `waiting` and must not have a Stop request when the proposal is created.

Material fields include the type-specific details, evidence references, consequence, target audience/resources, dependent requests, expiry, policy id/version, server-resolved resource versions/content digests and, for a run plan, every model/tool/token/currency limit. A revision recomputes the hash, increments the revision, supersedes old votes and returns the request to review. IDs alone are not immutable evidence: `resource_bindings` records the version and SHA-256 the server actually resolved. A missing digest leaves the associated executor unavailable.

`superseded` belongs to an old revision snapshot only. The top-level request always reflects its current revision (`pending`, `approved`, `declined`, `changes_requested`, `expired`, or `withdrawn`) and therefore does not add a `superseded` request status.

## Methods and routes

| Domain method | HTTP route | Shared input/output |
| --- | --- | --- |
| `proposeApproval(context, input)` | server/runtime integration; no public proposal route | `ProposeApprovalInput` → `ApprovalView` |
| `getApproval(viewer, requestId)` | `GET /w/:ws/requests/:id/approval` | `ApprovalView` |
| `decideApproval(viewer, requestId, input)` | `POST /w/:ws/requests/:id/approval/decisions` | `DecideApprovalInput` → `ApprovalView` |
| `reviseApproval(actor, requestId, input)` | `POST /w/:ws/requests/:id/approval/revisions` | `ReviseApprovalInput` → `ApprovalView` |
| `routeApproval(viewer, requestId, input)` | `POST /w/:ws/requests/:id/approval/route` | `RouteApprovalInput` → `ApprovalView` |

All commands require an idempotency key. The server stores a canonical command digest: an exact retry returns the original current view, while reusing the key with changed material is a conflict. Decisions, revisions and routing also require the exact current authorization revision and hash. The server rechecks membership, role eligibility, self-review, current sequential step, quorum, distinct human reviewers, expiry and dependencies inside the same transaction that records the command.

`approve`, `decline`, and `request_changes` are approval votes. They do not use the legacy `/decisions` route. A note is annotation only. In a sequential policy only the current step can vote; in a parallel policy all steps can progress. One member can never satisfy two votes in a `require_distinct_reviewers` policy.

Routing selects a currently active member who already satisfies the immutable step selector. It cannot add a reviewer, remove a step, lower quorum, disable self-review prevention, or change sequential/parallel behavior.

## Finalization and continuation hook

The server's transition from `pending` to final `approved` writes the `approval.finalized` audit event and a jobs-table row with kind `approval_continue` transactionally and exactly once. Its `ApprovalFinalizedHook` payload is keyed by `approval-finalized:<request_id>:<authorization_revision>:<authorization_hash>`. The runtime workstream consumes this durable job; it must still re-read `getApproval` before admission. This hook authorizes only continuation admission. It does not execute mail, access, disclosure, record changes, governance changes or any other provider effect.

The hook carries request/workspace ids, approval type, authorization revision/hash, expiry, verified requester agent/member, source session/run, dependent request ids, resolved resource bindings and the approved run-plan budget (when applicable). `declined`, `changes_requested`, `expired`, `superseded`, and `withdrawn` never emit a finalization hook. They remain queryable authorization states so retries can fail closed. A changed/expired/cancelled request cannot resume even if an earlier hook delivery is replayed.

Authorization, work and effect outcomes are separate in `ApprovalView`:

- `status` is the human authorization state.
- `work.status` describes dependent/continuation work.
- `effect.status` describes a provider-side consequence. Unsupported side effects remain `waiting` or `unavailable`; approval never implies execution.

`RequestEntity.approval.pending_for_viewer` and `.waiting_on_others` are server projections. Bootstrap counts expose `pending_for_me` and `pending_for_others`; each counts requests, never votes.

`ApprovalView.identities` is server-resolved display data for the requester agent, target agents and eligible reviewers. Clients must use it rather than extracting people from fixture prose. Inbox refs accept `filters.reviewer = "for_me" | "waiting" | "all"`; absence normalizes to `for_me`, including `sameRef` comparisons and model-authored Inbox focus.

## Ten proposal examples

Every example below is the `details` value beside the common fields:

```ts
{
  kind: 'approval',
  approval_type: '<one of the ten values>',
  summary: 'What the reviewer is deciding',
  consequence: 'What authorization permits, and what it does not execute',
  evidence: [{ id: 'source-1', kind: 'source', label: 'Reviewed source' }],
  illustrative: true,
  details: /* one object below */
}
```

### `run_plan`

```ts
{
  goal: 'Produce a cited partner shortlist each week',
  steps: [{ id: 'research', label: 'Research partners', agent_id: AGENT_ID, output: 'Cited shortlist' }],
  participating_agents: [{ agent_id: AGENT_ID, role: 'Researcher' }],
  deliverables: ['Weekly shortlist'],
  schedule: 'Mondays at 09:00 America/Los_Angeles',
  budget: { currency: 'USD', estimated_min_minor: 100, estimated_max_minor: 300, cap_minor: 500, estimated_input_tokens: 20000, estimated_output_tokens: 5000, total_token_cap: 25000, call_cap: 4, max_output_tokens_per_call: 5000, max_parallel_calls: 1, model_ids: ['configured-model'], metered_tools: ['search'], retries_included: 1, illustrative: true }
}
```

The four explicit maxima are enforcement inputs, not estimates. `call_cap` includes retries. The runtime must fail closed if its adapter cannot enforce `total_token_cap`, `call_cap`, `max_output_tokens_per_call`, or `max_parallel_calls`; authorization does not turn an estimate into a hard cap.

### `team_commitment`

```ts
{ requester_agent_id: IRIS_ID, recipient_agent_id: COLLEAGUE_AGENT_ID, receiving_owner_member_id: OWNER_ID, workload: 'Check technical evidence', due_at: '2026-09-20T17:00:00-07:00', dependencies: ['Shortlist'], acceptance_criteria: ['Every technical claim has a primary source'] }
```

### `access`

```ts
{ resource_id: 'partner-reference-folder', resource_label: 'Partner references', requested_agent_id: IRIS_ID, operations: ['read'], purpose: 'Verify partner claims', access_expires_at: '2026-09-30T17:00:00-07:00' }
```

### `communication`

```ts
{ channel: 'email', sender: { member_id: MAYA_ID, address: 'maya@example.test' }, recipients: [{ name: 'Selected prospect', address: 'prospect@example.test' }], subject: 'Introduction', body: 'The complete reviewed message', attachments: [], scheduled_for: '2026-09-18T09:00:00-07:00' }
```

### `shared_learning`

```ts
{ skill_id: 'partner-screening', title: 'Partner screening checklist', current_version: 'v1', proposed_version: 'v2', diff: '+ Verify official program source', source_evidence_ids: ['source-1'], reuse_audience: ['Partner program agents'], excluded_private_data: ['Applicant records', 'Private notes'] }
```

### `deliverable`

```ts
{ artifact_id: 'shortlist-2026-09-15', title: 'Weekly partner shortlist', version: 'v1', content: 'The full artifact under review', evidence_ids: ['source-1'], missing_information: ['Program terms remain unconfirmed'], releases_dependent_request_ids: [DEPENDENT_REQUEST_ID] }
```

### `data_disclosure`

```ts
{ recipient: { organization: 'Example Foundation', contact: 'reviewer@example.test' }, purpose: 'Partner diligence', items: [{ resource_id: 'partner-summary', fields: ['name', 'public_program_url'] }], redactions: ['Private notes'], retention_until: '2026-10-15T17:00:00-07:00' }
```

### `record_change`

```ts
{ system_id: 'crm', system_label: 'Partner CRM', changes: [{ record_id: 'partner-42', field: 'status', before: 'reviewing', after: 'qualified' }], validation: ['Status is an allowed value'], rollback: 'Restore status to reviewing' }
```

### `exception`

```ts
{ rule_id: 'two-references', rule_label: 'Two references required', reason: 'One verified reference is temporarily unavailable', scope: 'Partner 42 only', compensating_controls: ['Manual program-owner review'], exception_expires_at: '2026-09-22T17:00:00-07:00' }
```

### `agent_governance`

```ts
{ agent_id: IRIS_ID, current_schedule: 'Weekly', proposed_schedule: 'Weekdays', current_tools: ['web'], proposed_tools: ['web'], setting_changes: [], affected_permissions: [] }
```

The examples are fictional and illustrative. They authorize no real send, payment, access, disclosure, signature, deployment or record mutation.
