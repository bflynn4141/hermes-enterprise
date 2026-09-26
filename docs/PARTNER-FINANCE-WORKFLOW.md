# Partnerships + Finance handoff

This **Handoff** (`contractor-agreements`) gives two employees one agent each.
Partnerships admits applicants; when the handoff is enabled, admit automatically
prepares one pending contractor agreement for Finance. Finance reviews that
draft. Models explain evidence; they do not create authority, choose a
recipient, approve, pay, sign or send. Legacy invoice-intake APIs remain for
compatibility but are not the Handoffs surface.

## Setup and admission

An Admin applies the two role templates with
`POST /w/:ws/partner-workflow/configure`, which creates the workspace's
`contractor-agreements` handoff row. The Handoffs page lives at **Library → Handoffs**
(`GET /w/:ws/handoffs`, `GET /w/:ws/handoffs/:id`). The request binds two distinct active
members to two distinct agents. Applying a template replaces semantic grants
with the reviewed allowlist, pauses that agent's other role assignment and
turns its schedule off. Reapplying the same template is idempotent and does not
advance the assignment revision.

Configuration alone does not admit invoices. Migration 0049 and new workspace
settings start with admission disabled. Enabling
`POST /w/:ws/partner-workflow/admission` requires both native profiles to attest
the exact current agent, assignment id and revision, skill version and artifact
digest, complete tool inventory, pinned runtime/plugin identity and the role's
AgentCash state. The route re-locks the role and assignment rows after the
native probes. Every later invoice intake rechecks the saved attestation
against the current bindings. Pausing or revising either relevant assignment
therefore closes admission until a fresh probe; an unrelated assignment is
ignored.

The opt-in roles are:

| Role | Native package | Version | Governed tools |
| --- | --- | --- | --- |
| Partnerships | `enterprise_bridge:partner-program-screening-v1-8` | `1.8.0` | Existing Partnerships tools plus `publish_partner_invoice_review` |
| Finance | `enterprise_bridge:partner-invoice-review` | `1.0.1` | `get_partner_handoff_result`, `list_requests`, `get_request`, `skill_view` |

Finance does not need AgentCash or a wallet. Existing Partnerships 1.7 and
Finance 1.0.0 assignments remain historical/compatible definitions and do not
satisfy new-workflow admission.

## Exact human authority and immutable intake

An unsigned agreement draft, a qualification, an outreach proposal and a model
statement are never proof of an authorized engagement. Partnerships proposes
terms through `POST /w/:ws/partner-workflow/engagement-authorizations`. The
server binds a `record_change` approval to:

- the named Finance reviewer and exact approval revision/hash;
- the selected partner and reference, amount, currency and validity dates;
- one-invoice scope and `sample` or `customer` input provenance; and
- a Partnerships-owned attachment id, digest and exact permitted excerpt.

Finance's human approval atomically rechecks the stored source and materializes
the allowlisted engagement record. Replacement approved terms supersede older
authority for the same partner/reference, including an authority reserved by an
undecided handoff. Undecided old handoffs become stale and their pending Finance
requests are withdrawn. Decided receipts remain immutable.

Partnerships then confirms an invoice with
`POST /w/:ws/partner-workflow/invoice-intakes`. The server derives the caller,
source session/run, Finance recipient and role assignments. It hashes and saves
an immutable intake containing the exact authorization, frozen invoice source
and parsed invoice. A repeated caller/idempotency key with the same hash returns
the original intake; changed input conflicts. One authorization can reserve one
invoice lineage. A correction uses
`POST /w/:ws/partner-workflow/handoffs/:id/corrections`, creates one successor
revision and withdraws an undecided predecessor. Sample lineage can never be
promoted to customer data.

The Partnerships model can publish only that confirmed intake by calling:

```text
publish_partner_invoice_review({ intake_event_id, expected_payload_hash })
```

The tool accepts no caller-authored invoice fields, recipient, authority or
provenance. Its run grant is pinned to the intake's handoff. The historical
`POST /w/:ws/partner-workflow/invoice-review-handoffs` endpoint remains present
for rollout compatibility but rejects new caller-authored authority.

## Review, decision and acknowledgment

The Worker rechecks both non-deleted attachment digests, authorization dates,
record revisions, role assignments and run grants. It deterministically checks
duplicate number/payee/amount, currency, authorized total and evidence before
creating any Finance request. The Finance model receives one Bot Mode-compatible
turn and may explain the stored result. It cannot write the request.

Only the named active Finance audience member with the Finance reviewer role can
use the guarded human decision route. The click binds the exact request version
and payload hash and rechecks the captured Finance assignment/grant and all
authority/evidence again under row locks. Approval saves an invoice **draft**.
It does not authorize or execute payment, delivery, email or signature. The
return acknowledgment is one bounded, deterministic row/job containing partner
identity, reference, result code, reviewer display and time; it carries no
invoice body and cannot start another agent loop.

`GET /w/:ws/partner-workflow/handoffs/:id/result` returns the shared result only
to a configured human role or an exact run grant. Delivery, deterministic
validation, model explanation, human decision and acknowledgment remain
separate outcome dimensions. A model error cannot erase passed server checks,
and passed checks cannot imply human approval.

## Privacy

Finance requests and their documents, notes, effects, history, counts, event
replay and live events are audience-scoped. A removed member is excluded at
delivery time. Generic agent request/document methods fail closed for any row
with an audience because those methods have no named human principal. Finance
receives the frozen shared handoff projection and its own session; it does not
receive Partnerships records or source-session history. Legacy requests without
an audience keep workspace visibility.

## Sample data and execution mode

`input_provenance` is durable and independent from `simulated`. Sample terms
are labeled demonstration-only in the approval, intake, handoff, result and UI;
they do not imply an external agreement. A real native run over sample input
still records `simulated: false`. Historical records without provenance display
as unknown rather than being relabeled customer data. Deterministic fixtures may
use simulated execution, and are not evidence of native model quality.

## Rollout and safe Finance enrollment

Deploy the additive Worker and migration first with admission disabled. Install
and restart only profiles explicitly moved to Partnerships 1.8 or Finance 1.0.1,
verify their exact readiness, then enable admission for that workspace. Do not
rewrite existing 1.7 assignments, globally pause schedules or invalidate legacy
runs.

A Finance employee can also be invited directly into the Finance job role. With
`HERMES_MEMBER_PROVISIONING_ENABLED=1`, the invitation dialog offers Finance
only while the workspace holds a verified, unreserved Finance instance
(`Settings → Runtime capacity`, role Finance). `POST /w/:ws/invitations` with
`role_template_key: 'finance-agent'` answers 409 `member_setup_role_unavailable`
otherwise, so no setup operation is created that is known to fail. The setup
job reserves that exact instance for the invitation and, once that reservation
is verified current, queues the WorkOS invitation email in the same transaction;
WorkOS creating the invitation is also what lets a brand-new person sign up
through AuthKit. The invitee then sees the invitation on their workspace picker
and on a join page that names the workspace and job role. Acceptance promotes
the instance to the member's agent, and a resend keeps the reservation it
already holds and re-queues delivery only once the successor is ready. The
role is advertised per workspace in `bootstrap.capabilities.member_invitations`.

Invitation onboarding may create the compatibility Iris profile, so a new
Finance member must not begin default discovery before role setup. The safe
sequence is: accept the invite with the compatibility assignment's schedule
disabled, do not approve its starter search, immediately configure that
member/agent as Finance (which pauses any Partnerships assignment and schedule),
restart with the Finance 1.0.1 package, verify readiness, and only then enable
new admission. This sequence changes no other workspace schedule.

## Verification

Use only the isolated `hermes_test` database:

```sh
pnpm --filter @hermes/worker test:unit
PGDATABASE=hermes_test pnpm --filter @hermes/worker exec vitest run --project db \
  test/db/partner-workflow.test.ts test/db/partner-workflow-v2.test.ts test/db/handoffs.test.ts
pnpm --filter @hermes/worker typecheck
pnpm db:migrations:verify
```

The local two-employee rehearsal runs against the real Worker and an owned
Postgres container: an Admin invites a second employee from the Members screen,
the employee accepts through the join screen, the Admin binds both employees
and agents in Library, and admission is refused in words because no pinned
runtime attests over HTTPS.

```sh
pnpm e2e:live -- live-partner-finance.spec.ts
```

Fixtures prove server authority and database behavior. Native profile probes and
a real two-member workspace are separate release evidence. Until both employees
exist and the reviewed profiles attest in the hosted workspace, local tests must
not be described as a live multi-party acceptance.
