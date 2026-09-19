# Partnerships + Finance workflow

This local workflow gives two employees one agent each. Partnerships uses Iris
for candidate evidence and draft-only outreach. Finance uses a separate agent
for invoice checks and a human Finance decision. The agents share connector
code, not unrestricted data access.

## Authorization model

- An Admin applies the role templates with
  `POST /w/:ws/partner-workflow/configure` and two distinct agent/principal
  bindings. Reapplying a reviewed template replaces semantic capability grants
  with that template's exact allowlist; arbitrary historic grants are not
  retained. New schedules are off.
- Runtime skill discovery and recovery status reads are side-effect free. The
  deployment-wide legacy Partnerships policy is projected only for genuinely
  ungoverned rollout agents; it cannot attach Partnerships manifests or tools
  to a Finance-governed agent.
- Each active run uses a grant snapshot tied to the exact assignment revision,
  immutable skill artifact, connection binding, capability, resource and
  action. Pause, revision changes, revocation and explicit denies fail closed.
- `partner_records`, handoffs, run grants and workflow executions are app-role
  only. The database agent role cannot query them directly.
- Partnerships and Finance can list or fetch only their own team records.
  Finance receives a strict handoff projection, not the Partnerships record or
  source session. The Inbox links only to the Finance-owned review session.
- A scoped Finance request is visible only to its named audience, including by
  direct id, search and related documents/effects/notes. Legacy Inbox requests
  without an audience keep their existing workspace visibility.

## Trigger and decision boundary

`POST /w/:ws/partner-workflow/invoice-review-handoffs` is the only workflow
trigger. It requires an actual schema-valid invoice, engagement reference,
authorized currency and amount, non-empty evidence, the Partnerships-owned
source session/run and an idempotency key. A qualification, outreach draft or
outreach approval cannot satisfy that schema and starts no Finance work.

The durable job freezes the engagement and invoice revisions, checks the
current role assignment and connector grants, then checks duplicate number,
payee and amount, currency, authorized amount and evidence. Discrepancies create
a Finance-private needs-information record. A valid input creates one pending
invoice request for the Finance principal. Replay returns the original handoff;
stale revisions stop the review.

For a non-simulated event, the same transaction also persists a one-way agent
message using Hermes Bot Mode's canonical envelope:

```text
Message from 🤖 Iris (@<source-profile>): <server-generated handoff body>
```

That user-role turn carries native `turn_author` bot attribution and starts the
Finance model run after the transaction commits. The UI renders it as a compact
agent timeline notice rather than a human message bubble. The message is only a
visible coordination surface: the signed/scoped database handoff remains the
authority, and the model receives only `list_requests` and `get_request`. It
cannot create or mutate a request, call native `message_agent`, approve, pay, or
send. The bridge emits one idempotent Partnerships-to-Finance message and no
automatic reply, preventing acknowledgement loops.

The Finance agent cannot approve. The existing guarded decision route requires
the Finance human reviewer, a current payload hash/version and recent sign-in.
Approval saves the invoice and only records pending downstream effects. This
repository still has no payment or email executor.

## Local verification

The deterministic fixture sets `simulated: true`; its session copy and Inbox
evidence are labeled Simulated. It uses the same Bot Mode-compatible envelope
but performs no model call, so it is not evidence of live model quality. A
non-simulated event admits an actual Finance run; the server still owns every
check and request write, and no path sends email or moves money.

Run the focused checks with the repository's separate test database:

```sh
pnpm test:unit
PGDATABASE=hermes_test pnpm --filter @hermes/worker exec vitest run --project db test/db/partner-workflow.test.ts
pnpm typecheck
pnpm build
```

Run `pnpm db:migrations:verify` against a disposable migration database before
release. Do not point tests at a developer or production Hermes database.

## Next step: role selection during onboarding

Brian identified role selection during onboarding as the next product step on
September 19, 2026. Let users choose Partnerships or Finance and try the
corresponding employee experience with its assigned agent. Reuse the reviewed
role templates, persist the choice, and show the matching setup and scoped
Inbox. Role selection must preserve the existing Admin assignment and human
approval boundaries. This follow-up is recorded, not implemented in this change.
