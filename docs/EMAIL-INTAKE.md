# Agent email

Every agent has its own email address (decision
[C100](decisions/08-runtime-and-team-workflows.md), which extends
[C98](decisions/08-runtime-and-team-workflows.md)). People email the agent
directly, copy it on a thread, or route a shared address such as partners@ to
it. The agent reads each message and suggests a reply or a hand-off to another
role; a person approves anything that leaves the company, and an approved
reply goes out from the agent's own address through Cloudflare Email Service.
This page is the operator and developer reference.

Admins do not provision addresses. They configure roles (who holds each one,
which agent works in it), and an agent's role decides who reviews its mail:
its owner, plus the holders of its role. Addresses an Admin made for a role
before C100 (`kind = 'role'`) keep working and reply as before.

## The flow

1. **An agent gets its address** when it is created with an owner, or the
   first time anyone looks for it (bootstrap, Admin → Email), which is how
   agents made before C100 get theirs (`inbound-email/agent-address.ts`).
   Hermes creates `<agent-name>-<6 random characters>@<EMAIL_INTAKE_DOMAIN>`
   and gives the agent the suggestion tools and reply policies. An agent with
   no owner gets none: its mail would have nobody to review it.
2. **Mail arrives** through Cloudflare Email Routing at the Worker's `email()`
   handler (`src/index.ts`). `inbound-email/intake.ts` resolves the address to
   a workspace, parses the MIME, sanitizes the HTML, computes sender facts and
   stores the message with one `email_triage` job. Unknown or paused addresses
   are rejected at SMTP time; a repeated delivery is a no-op.
3. **The agent reads it** (`inbound-email/triage.ts`) in an intake-mode run in
   its owner's "Email · <agent>" session. An agent reads at most
   `AGENT_EMAIL_DAILY_READS` (default 50) a day on its own; past that a message
   waits with **Read it now**, because every address is on by default and a
   leaked one must not become an open tap on the model provider. It sees the sender facts and the
   visible text between nonce markers, and can call only `suggest_reply`,
   `suggest_handoff` and `get_workspace_context`. Those instructions go to
   the model only (`run_turns`); the conversation stores the turn as an
   email card (message kind `email`: sender and subject), and cards are kept
   out of later turns' history.
4. **Suggestions reach people** (`inbound-email/suggestions.ts`):
   - a reply is a communication approval in the Inbox, showing the original
     email rendered safely above the suggested words;
   - a hand-off is a task in the target role's Inbox, showing the same email.
5. **An approved reply** enters the outbox threaded under the original. A
   reply to an agent's own address is sent as the agent (`From: Iris
   <iris-…@…>`) through the `EMAIL` binding (`outbound-email/agent-send.ts`),
   with `In-Reply-To` and `References`; Cloudflare's message id is stored.
   Throttling retries; a refusal is `failed`; anything Cloudflare did not name
   as a refusal is `ambiguous` and never retried. Without the binding it is
   simulated where effects are simulated. A reply to an older role address is
   sent through a connected Gmail or Microsoft 365 sender, or waits for one.

## When the agent could not read a message

A triage run can fail for reasons that heal, most often the model provider
rate-limiting the agent (`hermes_provider_rate_limited`). Each message counts
its attempts (`triage_attempt`); the triage job's key and the run's client turn
id carry the number, so every retry is a fresh job and a fresh intake run.

- **Automatically.** Each minute the Cron (`scheduleEmailTriageRetries` in
  `inbound-email/triage.ts`) finds intake runs that ended with
  `hermes_provider_rate_limited` or `hermes_provider_unavailable` and puts the
  message back to `received` with a job that waits 1 minute after the first
  failure and 5 minutes after the second, or longer if the provider sent
  Retry-After. After three attempts it stops. Generic run recovery
  (`runs/recovery.ts`) skips `email-triage:` runs, so nothing else retries them.
- **By a person.** Admin → Email shows **Try again** on a message whose
  run failed or completed without saving a suggestion, or whose job failed
  before starting a run. A completed run alone does not prove the message
  needed no reply: a tool transport failure can also end that way. The button calls `POST /w/:ws/email/messages/:id/retry`, which anyone
  who may read the message can use (Origin and CSRF checked, 10 a minute). It
  answers 409 `not_retryable` while a run is working or an automatic retry is
  waiting, or if any reply or hand-off already exists, and 409 `inbox_paused` for a paused inbox.

Suggestion tools find their message by `triage_run_id`, so after a retry the
failed run can no longer attach anything to the message. Each retry writes an
`email_triage.retried` event naming the failed run.

## How it reads on screen

Wording follows [DESIGN.md](DESIGN.md). A suggested reply shows what to check
first, then the reply marked "Not sent", then the original email. Warnings are
written by the client from each warning's code and the stored facts, so older
messages read the same as new ones and no mail-protocol names appear. Admin →
Role inboxes uses one status vocabulary (Waiting for Iris, Reading, Ready for
review, No reply suggested, Trying again soon, Couldn't read it) and says why a
read failed.

While Role inboxes is open, its counts and recent messages refresh every five
seconds after the previous read completes. This picks up new arrivals and
finished triage attempts without reloading. Refreshing pauses when the tab is
hidden, resumes immediately on return, and stops when the page closes. A
temporary connection failure keeps the last readable rows with a retry notice;
only an explicit access-denied response hides message content. A retry or inbox
change invalidates older reads so they cannot overwrite the newer result.

## What the reviewer can trust

| Shown on the card | Where it comes from |
|---|---|
| "Sent from example.com, verified by the domain" | DMARC result in our receiver's Authentication-Results header only |
| Member / known contact / first email | Active member addresses; earlier senders and approved recipients |
| Cautions | Server string checks: failed DMARC, Reply-To on another domain, lookalike domain, a member's name from outside, bank-detail language, hidden text removed, link words naming another site |
| The email body | Rebuilt from an allowlist; rendered in a sandboxed iframe whose CSP allows no network request |
| "Links in this email" | Every link's real destination as plain text |
| Attachments | PDF, text, Markdown, CSV and HTML (first three, 5 MB each) are read as text; the reviewer can open exactly the text the agent read. Other files are listed with the reason they were not read. Text hidden inside a PDF cannot be detected. |

A caution never unlocks anything. It adds a second approver (another Admin or
holder of the role); if the workspace has nobody who could be second, the reply
is drafted but Hermes will not send it.

## Readable email content

Sender-controlled colors, font sizes and spacing are removed. Only enumerated
emphasis and alignment styles survive; repeated small/subscript/superscript tags
become normal-size text. Explicitly hidden content is still removed and counted.
This trades some email branding for a reviewer being able to read the words
provided to the agent.

If the HTML has no text and intake uses the plain-text MIME alternative, the
reviewer sees that same alternative. If HTML or text exceeds the rendering
budget, review falls back to the bounded plain text rather than a cut-off HTML
document. Previously stored messages also have their presentation rebuilt at
read time; a mismatch with the stored model text selects the plain-text view.
The stored evidence and its hash are not rewritten.

## Connecting a sender after approval

With real delivery enabled, an approved reply without a Gmail connection waits
without consuming its send-job key. Connecting the matching sender queues it.
The callback also repairs completed jobs left by older versions, including
queued replies with zero send attempts. Sent or uncertain deliveries are not
replayed. Development simulation still records a simulated send without Gmail.

Regression coverage includes delayed connection, historical job recovery,
repeated connections, invisible styles, nested shrinking tags, large inline
images, MIME alternatives, and unchanged historical evidence.

## Configuration

| Variable | Development | Staging / production |
|---|---|---|
| `EMAIL_INTAKE_DOMAIN` | `in.hermes.localhost` | unset until Email Routing is configured |
| `EMAIL_INTAKE_AUTHSERV_ID` | default `mx.cloudflare.net` | confirm against a real message's headers |
| `EMAIL_REPLY_MODE` | `send_after_approval` | `draft_only` |
| `EMAIL` binding (`send_email`) | Wrangler's local simulator | added once Email Sending is enabled for the domain |
| `AGENT_EMAIL_DAILY_READS` | default 50 | default 50 |
| `AGENT_EMAIL_RECIPIENT_MODE` | unset (anyone) | staging `members`: only the workspace's active members, read at send time; production unset while replies are drafts |

To turn it on for a deployed environment:

1. Add the receiving domain (for example `in.example.com`) to Cloudflare Email
   Routing and create a catch-all rule that sends to this Worker.
2. Send one real message and check its `Authentication-Results` header; set
   `EMAIL_INTAKE_AUTHSERV_ID` if the authserv-id is not `mx.cloudflare.net`.
3. Set `EMAIL_INTAKE_DOMAIN` in `wrangler.jsonc` for that environment.
4. For replies that actually send as the agent, enable Cloudflare Email Sending
   for the same domain (it adds its SPF, DKIM and DMARC records), add the
   `send_email` binding named `EMAIL` to that environment, and set
   `EMAIL_REPLY_MODE=send_after_approval`.

## Hosted Hermes agents

A hosted agent refuses to start when the tools the Worker advertises differ
from its pinned role binding, so the intake tools are shown only to a bridge
revision that asks for them (`GET /tools?features=email-intake`). An older
pool keeps discovering exactly its role and keeps running; it just cannot
answer email until it is re-pinned. The new revision accepts its role's tools
plus, at most, `suggest_reply`, `suggest_handoff` and `get_workspace_context`,
and the Worker's readiness check accepts the same.

While a hosted run reads an email, the Worker's model proxy offers the model
only those three tools, so AgentCash and every other native tool are not in
the request, and the AgentCash authorize routes refuse an intake run outright.

To enable it on staging after merge:

1. Install the plugin at the merge commit on each pool (dashboard install
   API, which needs a person's Portal consent per instance; see the Cloud
   bootstrap notes).
2. Set `HERMES_ENTERPRISE_PLUGIN_REVISION` to that commit and
   `HERMES_ENTERPRISE_PLUGIN_SHA256` to the plugin tree digest, then deploy.
   Readiness fails closed for any pool still on the old pin.

## Trying it locally

```sh
pnpm --filter @hermes/client exec node scripts/email-intake-stack.mjs
```

This starts a private stack on `http://localhost:8795` with its own Postgres
container and the scripted model. Create an inbox in Admin → Role inboxes, then
deliver a raw message the way Email Routing does in development:

```sh
curl -X POST "http://localhost:8795/cdn-cgi/handler/email?from=priya@northwind.example&to=<inbox address>" \
  -H 'content-type: message/rfc822' --data-binary @message.eml
```

The scripted agent always writes the same reply, which answers the Northwind
invoice email in the walkthrough. `pnpm --filter @hermes/client email-intake:record`
records that walkthrough end to end.

## Data

- `email_inboxes`, `email_inbox_directory`, `inbound_email_messages`
  (migration 0076). Message content columns are immutable to the app role;
  only triage bookkeeping changes (status, run, error, suggestions and, since
  0077, `triage_attempt`).
- `outbound_email_outbox` gains `inbound_message_id`, `in_reply_to`,
  `references_header` and a `simulated` state; approval effects gain
  `simulated`.
- Removing an inbox deletes its messages, withdraws its agent's capability row
  and retires its policies and approval resources.

## Known limits of this first pass

- Scanned PDFs without a text layer are not read (no OCR).
- The scripted development agent's words are fixed; a real model writes its own.
- Hosted Hermes agents need the pool re-pin above before they answer email.
- No mailbox sync: Hermes sees only what reaches the address.

## Hosted suggestion transactions

Reply and hand-off tools reserve their runtime call, release the agent-role
run lock, and then enter the app-role suggestion transaction. They finalize
the durable result afterward, using the same phased dispatch as approval
proposals. Holding the run lock during the app write would block the request’s
source-run foreign-key check and make the bridge time out. Replay uses the
original call identity so a lost response cannot create another suggestion.
