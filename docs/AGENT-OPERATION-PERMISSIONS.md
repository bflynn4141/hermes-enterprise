# Agent operation approval

The Permissions screen controls whether a supported tool operation asks an
Admin first. It never grants a tool, changes a run's mode, records a business
decision, executes an effect, or bypasses a paid-service boundary.

Only configured tools appear. Existing agents default to Off to preserve their
current behavior. Turning On applies at the next tool attempt, including an
already-running conversation. Plan-mode previews do not require consent, since
they do not perform the operation. Read operations still run and can require it.

## HTTP contract

- `GET /w/:ws/agents/:agent/permissions` returns `AgentPermissions`.
- `PATCH` the same route with `{ revision, operation_id, require_human_approval }`
  returns the saved view; stale revisions return `409 version_conflict`.
- `POST /w/:ws/agents/:agent/permissions/approvals/:approval` with
  `{ decision: 'approved' | 'denied' }` returns the updated view.

All mutations require Admin, Origin, and CSRF checks. Members can see policies,
not pending argument bodies. Policy changes and human decisions are audited.
Policy changes need no second approval ceremony.

## Durable execution

The shared tool executor checks consent before performing the supported action.
A pending record binds workspace, agent, run, tool-call ID, tool name, and exact
JSON arguments. The agent role can only insert pending records and read them;
it cannot change the policy or approve itself. A changed argument replay fails.

Pending calls remain pending when the toggle changes to Off. Human approval is
for one exact attempt, not future runs or all operations in the category. The
normal tool idempotency keys still protect replay. Capabilities are rechecked
before an approved action resumes. A human decline produces no write.

The native bridge polls the same pending attempt. The legacy Workflow waits
under one durable 30-day deadline and resumes the stored action. Unrelated
buffered context events cannot grant consent or fail the waiting run. Consent
does not create context fields; ordinary context answers are not approvals.

The UI recognizes `waiting_for` starting with `operation_approval:` and links
to Permissions, where the Admin can inspect escaped arguments and approve once
or decline. It must not render the normal free-text context answer control.
Raw arguments stay tenant-local in the approval row, alongside the existing
tool trace. Deleting the run cascades its approval records.

## Verification

`test/unit/operation-permissions.test.ts` covers catalog, strict policy inputs,
executor gates, plan previews, and legacy stale-wake approval/decline.
`test/unit/runtime-bridge.test.ts` covers pending native resume and replay.
`test/db/agent-operation-permissions.test.ts` exercises real routes, role/Origin/
revision checks, tenant isolation, On/Off/pending behavior, approve/decline,
immutability, and restricted-role execution. Existing grants, schema, and
native bridge suites cover the migration and integration boundaries.
