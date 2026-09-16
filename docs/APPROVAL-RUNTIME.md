# Approval runtime

Enterprise approval is an authorization boundary, not a remote-control API.
An agent can propose a typed approval and read its status. Only eligible humans
can vote, route, revise, or finalize it, and final approval never executes an
external provider effect by itself.

## Lifecycle

1. `propose_approval` validates a typed `ProposeApprovalInput`. The server
   derives requester identity and source run/session, selects and snapshots the
   applicable immutable policy, binds reviewed resources, and computes the
   revision authorization hash. The model cannot supply those fields.
2. If the proposal asks to continue work after approval, the runtime stores a
   pending continuation intent for the exact request revision. The intent names
   a provisioned agent profile and session; it contains no free-form continuation
   prompt.
3. Human commands are optimistic and revision-bound. A revision supersedes the
   old authorization and its votes. The final quorum writes one
   `approval.finalized` audit fact and one durable `approval_continue` job.
4. The job re-reads the current `ApprovalView` in the same transaction that
   admits work. The hook payload is a locator and checkpoint, not authority.
5. A successful admission creates one new linked enterprise run. It never
   attempts to revive the Python stack or provider stream that proposed the
   approval. A deterministic message derived from the reviewed payload becomes
   the new run's first input.

The request view projects authorization and execution separately. `approved`
means the human policy was satisfied; `work.status = admitted` means a new run
was actually created. Unsupported effects remain explicitly `unavailable`.

## Admission gates

Admission fails closed unless all of these still hold:

- request, workspace, revision, authorization hash, expiry, requester, source,
  target agent, and dependencies exactly match the finalization hook;
- the current server view is still approved and the source run was not stopped;
- every reviewed resource is immutable and digest/version bound;
- dependent requests are in an accepted terminal state;
- the target session is writable, its agent is started, and the agent has an
  active responsible human owner;
- the configured isolated Hermes profile still maps to that exact agent;
- no live run already owns that agent profile;
- the engine, workspace caps, platform instance cap, provider allowlist, model
  catalog entry, and provider-key status permit a new run; and
- a non-illustrative USD `run_plan` budget names the session model and supplies
  enforceable token, call, output, parallelism, retry, and cost limits.

Today only `run_plan` has a runtime executor. The other approval types retain
their human authorization record and surface `approval_type_has_no_runtime_executor`
instead of pretending an access grant, message, disclosure, record mutation,
or governance change happened.

Temporary provisioning and capacity failures remain visible as blocked work and
can be retried by the durable job. Stale, expired, changed, stopped, or
unsupported authorizations are terminal refusals.

## Hard model-call budget

`approval_runtime_budgets` stores the normalized reviewed limit for one admitted
continuation. Immediately before each provider request, the model bridge:

1. rechecks the admitted continuation and the server's current approval
   projection;
2. requires the exact reviewed catalog model and a price with a recorded
   catalog verification date;
3. imposes the reviewed output limit when the native client omits one and
   rejects a larger explicit limit;
4. computes a conservative tokenizer-independent input bound and upper cost;
5. atomically reserves cost, tokens, one call, and one parallel slot in
   Postgres; and
6. starts the provider request only after that reservation succeeds.

Streaming requests force provider usage metadata. A completed response replaces
the reservation with reported usage and catalog-priced actual cost. A provider
rejection releases cost and tokens but still consumes the call. A disconnect,
cancellation, malformed response, or successful response without trustworthy
usage consumes the full reservation. This deliberately prefers under-utilizing
an approved budget to spending beyond it.

The proxy also writes one `model_calls` row per actual provider request, using
the credential ID selected before that request and its own usage, latency, and
provider result. The native run's terminal aggregate is not written as another
model call. This prevents a later key rotation from relabelling earlier spend
and prevents multi-call native runs from collapsing into one misleading row.
For approved continuations, settlement and that audit row share one database
transaction: a failure leaves the conservative reservation held rather than
committing an unaccounted settlement.

The agent role can inspect budget state but cannot update it. Reservations and
reconciliation run through tenant-bound `SECURITY DEFINER` functions that lock
the run, continuation, and budget rows. This makes concurrent calls and retries
share one authoritative counter.

## Durable state

- `approval_continuations`: revision-bound pending, blocked, refused, or
  admitted continuation intents and their linked run.
- `approval_runtime_budgets`: normalized reviewed limits and aggregate reserved
  and actual usage.
- `approval_model_reservations`: one pre-provider reservation and its exactly-once
  settlement state.
- `approval_requests.work_status`, `work_reason`, and `continuation_id`: the
  cross-surface projection shown alongside authorization status.

Idempotency is layered. Agent proposals key off the durable tool call, intents
are unique per request revision and source tool call, finalization jobs are
unique per request/revision/hash, and runs are unique per continuation revision.
Workflow creation happens after the database commit and treats an existing
instance ID as a successful replay.

## Operating boundaries

- Approval never broadens ordinary tool permissions or provider access.
- Reviewer identity, owner identity, policy selection, authorization hashes,
  and finalization are server-derived.
- No approval type currently performs a third-party side effect.
- A changed resource must be submitted as a new revision; mutable resources are
  not admitted.
- Missing profiles and unsupported models are explicit work-state reasons, not
  silent fallback to another agent or model.

Use an isolated test database for migrations and authorization tests. The
deterministic native-runtime probe is the supported no-provider verification
path; do not point approval tests at a shared writable development database or
use paid model calls.

## Scripted no-spend demonstration

`test/db/approval-runtime.test.ts` is the executable end-to-end demonstration.
It creates a non-illustrative reviewed plan, persists an explicit continuation
intent, records a real human approval through the route, consumes the durable
job, admits exactly one linked run, and creates only a stub Workflow instance.
It then proves pre-call reservation, parallel-call refusal, exactly-once usage
reconciliation, agent-role write denial, and terminal work projection. No
provider request is made. An approval without an explicit intent follows the
same finalization path but creates no run and reports
`no_runtime_continuation_requested`.

## Known adjacent gaps

This layer does not make unsupported input appear supported. Turn attachments
are not yet delivered to Hermes, so the turn route rejects any nonempty
`attachments` array before persisting a message or admitting a run. Native Runs
health, initial admission, Workflow replay, and reconciliation require the
expected `/v1/capabilities` Runs contract and durable idempotency. The remaining
adjacent gap is budget scope: the reservation introduced here is the reviewed
continuation's hard budget; ordinary runs still rely on the existing workspace
daily cap at turn admission rather than a per-provider-call daily-cap
reservation.
