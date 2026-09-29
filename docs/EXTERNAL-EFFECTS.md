# What can happen twice

Audit date: September 29, 2026, against `main` at `ee1234cc`. Read-only source
review; line numbers are from that commit.

A durable job gives a retry, not exactly-once delivery. Jobs are leased for
120 seconds (`CLAIM_SECONDS` in `apps/worker/src/jobs.ts`). A job that throws
is retried with backoff and no attempt cap, and a job whose Worker dies is
reclaimed when its lease expires. So any call to an outside service can run
again after the service already acted, unless the code records that it
started and refuses to repeat an attempt whose outcome it never learned.

Approved email follows that rule (#213). A send found half-finished becomes
`ambiguous`, and a reviewer settles it (#215). This page checks every other
path that reaches outside the Worker.

## Can repeat, low consequence (accepted)

| Path | What repeats | Why it can | Consequence |
| --- | --- | --- | --- |
| Slack final reply, `integrations/slack/deliver.ts:135` | `chat.postMessage` | No in-progress marker. `sent` is written only after the post, and a 429, 5xx or network error after Slack accepted is rethrown and retried. `client_msg_id` is sent, but Slack doesn't document it as deduplicating | A second copy of Hermes's answer in the thread |
| Slack approval notice, `deliver.ts:118` | `chat.postMessage` | `approval_notified_at` is set only after the post | A second "needs your review" message |
| Guidance to a running agent, `runtime/adapter.ts:533` | `/steer` | Which guidance was sent is kept in memory; a replayed Workflow step starts with none | The agent receives the same instruction twice |
| Inbox triage classification, `inbox-triage/service.ts:206` | A paid Jev call | A `pending` assessment isn't checked before calling again | Cost only; the answer is read, never acted on |
| Engine and model-gateway calls | Model tokens | Retried Workflow steps | Cost only |

For chat messages, a duplicate beats the alternative, which is a reply that
silently never arrives. Treating a Slack post like an email (uncertain, wait for
a person) would add a review step to every lost acknowledgement. Revisit this
if Slack delivery ever carries an approved decision rather than a conversation.

## Safe to repeat

- **WorkOS invitation send and resend** (`jobs.ts:635`). The `sending` guard at `jobs.ts:555` refuses a repeat whose outcome is unknown. Approved email copied this rule.
- **WorkOS deactivate, role update and revoke** (`jobs.ts:717`). Each writes to a fixed id, so repeating it changes nothing.
- **Hermes run submit** (`runtime/client.ts:331`). It sends a stable `Idempotency-Key` (`enterprise-{run}-a{attempt}`), and an existing binding short-circuits (`adapter.ts:227`).
- **Workflow creation** (`runs/submit.ts:62`, `jobs.ts:804`, `runs/sweep.ts:461`). Instance ids are deterministic, and "already exists" counts as success.
- **Stops, Slack uninstall, WorkOS organization delete.** A repeat is harmless or reports "already done", which the code accepts.
- **Slack link confirmation** (`integrations/slack/ingest.ts:238`). The link code is consumed before the post, so a replay can lose the confirmation but never sends it twice.
- **R2 writes** (backups, event exports, extract and render queues). Deterministic keys, so a repeat overwrites with the same content.
- **Member provisioning.** It reserves capacity locally and queues a WorkOS job; it never calls a provider itself.
- **The effect executor** (`domain/effects.ts`). It has no real executor: it writes `unavailable` or `simulated`, and production is pinned to `unavailable`.

## Open questions

- **Paid AgentCash calls.** The Worker reserves the allowance (`runtime/bridge.ts:598`, `:1000`) and would approve the same `tool_call_id` again. Whether a replayed tool call can charge twice depends on the Hermes runtime, not this repository.
- **Token refresh (a different failure).** Slack, Gmail, Microsoft and Nous refresh an access token inside a database transaction (`integrations/slack/store.ts:198`, `outbound-email/gmail-store.ts:140`, `keys/store.ts:419`). If the Worker dies after the provider rotated the token but before commit, the new token is lost and the connection breaks until someone reconnects it. Nothing is duplicated, but it's worth its own fix.
- **Workspace creation** (`routes/workspaces.ts:91`). A client retry can create a second WorkOS organization. The runbook's reconciliation query covers the orphan.

## Rule for new outside effects

`docs/CONVENTIONS.md` invariant 5: no outside effect except through an approved
outbox or effect record with a recorded outcome. In practice:

1. Commit an in-progress state in its own transaction before calling out.
2. A job that finds that state again marks the attempt uncertain. It doesn't
   repeat the call unless the provider offers a real idempotency key or a
   lookup that proves what happened.
3. Give a person a way to settle an uncertain outcome, and write a regression
   test that seeds the in-progress state and asserts zero provider calls.
