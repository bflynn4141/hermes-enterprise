# Role inboxes

A role inbox is an email address that belongs to a role, such as Partnerships.
People forward or copy mail to it; the role's agent reads each message and
suggests a reply or a hand-off to another role; a person approves anything that
leaves the company. Decision [C98](decisions/08-runtime-and-team-workflows.md)
records the reasoning. This page is the operator and developer reference.

## The flow

1. **An Admin adds an inbox** in Admin → Role inboxes: a role, the agent that
   reads it (it must have an owner, who replies in their own name) and a name.
   Hermes creates `<role>-<8 random characters>@<EMAIL_INTAKE_DOMAIN>`.
2. **Mail arrives** through Cloudflare Email Routing at the Worker's `email()`
   handler (`src/index.ts`). `inbound-email/intake.ts` resolves the address to
   a workspace, parses the MIME, sanitizes the HTML, computes sender facts and
   stores the message with one `email_triage` job. Unknown or paused addresses
   are rejected at SMTP time; a repeated delivery is a no-op.
3. **The agent reads it** (`inbound-email/triage.ts`) in an intake-mode run in
   its owner's "Email · <inbox>" session. It sees the sender facts and the
   visible text between nonce markers, and can call only `suggest_reply`,
   `suggest_handoff` and `get_workspace_context`.
4. **Suggestions reach people** (`inbound-email/suggestions.ts`):
   - a reply is a communication approval in the Inbox, showing the original
     email rendered safely above the suggested words;
   - a hand-off is a task in the target role's Inbox, showing the same email.
5. **An approved reply** enters the outbox threaded under the original. It is
   sent through a connected Gmail sender, waits for one, or, where the effect
   executor is simulated, is recorded as simulated.

## What the reviewer can trust

| Shown on the card | Where it comes from |
|---|---|
| "Sent from example.com, verified by the domain" | DMARC result in our receiver's Authentication-Results header only |
| Member / known contact / first email | Active member addresses; earlier senders and approved recipients |
| Cautions | Server string checks: failed DMARC, Reply-To on another domain, lookalike domain, a member's name from outside, bank-detail language, hidden text removed, link words naming another site |
| The email body | Rebuilt from an allowlist; rendered in a sandboxed iframe whose CSP allows no network request |
| "Links in this email" | Every link's real destination as plain text |
| Attachments | Listed with size; never opened, never given to the agent |

A caution never unlocks anything. It adds a second approver (another Admin or
holder of the role); if the workspace has nobody who could be second, the reply
is drafted but Hermes will not send it.

## Configuration

| Variable | Development | Staging / production |
|---|---|---|
| `EMAIL_INTAKE_DOMAIN` | `in.hermes.localhost` | unset until Email Routing is configured |
| `EMAIL_INTAKE_AUTHSERV_ID` | default `mx.cloudflare.net` | confirm against a real message's headers |
| `EMAIL_REPLY_MODE` | `send_after_approval` (delivery is simulated) | `draft_only` |

To turn it on for a deployed environment:

1. Add the receiving domain (for example `in.example.com`) to Cloudflare Email
   Routing and create a catch-all rule that sends to this Worker.
2. Send one real message and check its `Authentication-Results` header; set
   `EMAIL_INTAKE_AUTHSERV_ID` if the authserv-id is not `mx.cloudflare.net`.
3. Set `EMAIL_INTAKE_DOMAIN` in `wrangler.jsonc` for that environment.
4. For replies that actually send, connect a Gmail sender (Admin → Email) and
   set `EMAIL_REPLY_MODE=send_after_approval`.

For hosted Hermes agents, the enterprise bridge must also allow the
`suggest_reply` and `suggest_handoff` tools for the inbox agent's skill, and
the pools must be re-pinned; the legacy engine uses them today.

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
  only triage bookkeeping changes.
- `outbound_email_outbox` gains `inbound_message_id`, `in_reply_to`,
  `references_header` and a `simulated` state; approval effects gain
  `simulated`.
- Removing an inbox deletes its messages, withdraws its agent's capability row
  and retires its policies and approval resources.

## Known limits of this first pass

- Attachments are listed only; nothing reads a PDF.
- The scripted development agent's words are fixed; a real model writes its own.
- Hosted Hermes agents need the bridge allowlist change and a re-pin (above).
- No mailbox sync: Hermes sees only what reaches the address.
