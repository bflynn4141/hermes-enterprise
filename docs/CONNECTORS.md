# Connectors: one description per outside connection

Status: Phase 2 of the Quest adoption plan, September 29, 2026. Built:

- The contract, per-connection statuses and Admin → Connections → Overview (#218).
- Disconnect for sending accounts and read-only Gmail (#219).
- A refresh the provider refuses with `invalid_grant` marks the sending account
  `error` (Needs attention) and parks its approved email until someone
  reconnects.

Code references below are to `main` at `b6d4b836`, when the gaps were found.

## Why

Hermes reaches five outside services today. Each was built on its own: its own
table, routes, status words and Admin screen. That worked for one or two. It
now hides real problems, found while mapping them for this note:

- **A Gmail or Microsoft account whose token stopped working still says
  Connected.** The account status has an `error` value, but no code writes it.
  A failed refresh throws inside the send job, the approved email stays
  `queued`, and the Admin screen shows nothing wrong.
- **A Gmail or Microsoft sending account can't be disconnected.** There's no
  route. The status enum has `revoked`, but nothing writes it. The read-only
  Gmail evidence mailbox is only revoked when someone connects a different one.
- **The agent's own address has no health signal.** If the Cloudflare binding
  or the domain's sending setup breaks, nothing says so until a send fails.
- **The `email_send` approval rule doesn't gate real email.** It routes the
  legacy effect rows that invoices and agreements create, which never execute.
  Real sends are gated by each email's own approval policy
  (`partner-outreach-*`, `email-reply-*`). Anyone reading Admin → Approvals
  would assume the opposite.

Quest (the product we compared against) keeps one manifest per connector:
setup, scopes, health, revoke and actions in one place, with the screen
rendered from it. The idea is worth taking. The implementation isn't; Quest's
manifests are Python plugins running in its server process.

## The contract

One `ConnectorDefinition` per connection in `packages/shared/src/connectors.ts`.
It is a plain description, so the client can render it and tests can check
it. Each connection also gets a small Worker-side adapter that answers three
questions from its existing tables.

```ts
type ConnectorDefinition = {
  key: 'gmail_sending' | 'microsoft_sending' | 'agent_address' | 'slack' | 'gmail_evidence';
  label: string;                        // "Gmail sending account"
  owner: 'workspace' | 'agent' | 'workspace_and_member';
  connect: 'admin_oauth' | 'automatic';
  operations: {
    key: string;                        // "send_approved_email"
    kind: 'read' | 'write';
    plain: string;                      // "Sends an email only after its reviewers approve the exact text"
    gate: 'approval_policy' | 'automatic';
  }[];
  outcomes: ('sent' | 'failed' | 'ambiguous' | 'simulated' | 'cancelled')[];
  settle: 'person' | null;              // who resolves an ambiguous outcome
  revoke: 'remote' | 'local' | null;    // null = not possible yet, shown as such
};

// Worker side, per connector (apps/worker/src/connectors/<key>.ts)
interface ConnectorAdapter {
  status(tx, workspaceId): Promise<ConnectorStatus>;   // from existing rows, no provider call
  check?(tx, env, workspaceId): Promise<ConnectorStatus>; // an explicit, rate-limited probe
  revoke?(work): Promise<void>;
}

type ConnectorStatus = {
  state: 'not_configured' | 'not_connected' | 'connected' | 'needs_attention' | 'paused';
  reason: string | null;                // one plain sentence when not connected
  identity: string | null;              // address or Slack workspace name, Admin only
  waiting: number;                      // approved work held back by this connection
  last_checked_at: string | null;
};
```

Not in the contract, on purpose:

- **Executors stay where they are.** `send-job.ts`, `agent-send.ts` and Slack
  `deliver.ts` already follow the invariant (approved outbox or recorded
  outcome), and #213 and #215 just hardened the email path. Moving them behind
  an interface would be churn with no user-visible change.
- **No approval route key.** The map showed email is gated by approval
  policies, Slack by nothing (its posts are conversation, not decisions). The
  `gate` field says which, per operation, in words an Admin can read.

## How each connection fits

| Connection | Owner | Connect | Writes | Gate | Ambiguous? | Revoke today | Health today |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gmail sending | Workspace | Admin OAuth | Send approved email | Approval policy | Yes, person settles | **None** | `error` never written |
| Microsoft sending | Workspace | Admin OAuth | Send approved email | Approval policy | Yes, person settles | **None** | `error` never written |
| Agent's own address | Agent | Automatic | Send approved reply | Approval policy | Yes, person settles | Pause or remove | **None** |
| Slack | Workspace, plus each member's link | Admin OAuth | Replies, review notices | Automatic | No (`client_msg_id`) | Remote uninstall | Set on auth errors |
| Gmail evidence (read-only) | Workspace | Admin OAuth | None (reads chosen threads) | — | — | **Only by connecting another mailbox** | `error` never written |

The read-only Gmail evidence connection is the closest thing to Phase 3's
document source, so it belongs in the contract from the start.

## What Admins will see

Admin → Connections becomes one list, one row per connection: its state, the
address or workspace it acts as, one sentence of what it can read and do
(rendered from `operations`), how many approved items it's holding back, and
Connect, Check or Disconnect. The existing detail pages (Email, Slack, agent
addresses) stay, linked from each row.

## Scope

Two ways to do Phase 2. Both write this contract and the Connections list.

- **Recommended.** Describe all five connections and give each a status
  adapter, then fix the three gaps above: write `needs_attention` when a
  sending account's token fails, add Disconnect for Gmail and Microsoft, and
  report the agent address's binding and domain state. Disconnect covers the
  read-only Gmail mailbox too. Leave executors alone.
  The screen tells the truth about every connection, and Phase 3's document
  connector starts from a contract that already fits five real cases.
- **Full.** The same, and also move every executor behind a common
  interface. That's the extra half of the work, it touches code #213 and #215
  just hardened, and nobody would see a difference.

## Order and dependencies

1. Shared types and the five status adapters, with unit tests per state.
2. `GET /w/:ws/connections` (Admin sees identities and counts; a Member sees
   state only) and the Connections list.
3. The three gap fixes, each its own PR. The token-failure fix waits for #217
   (rotated-token commit), which changes the same refresh code in
   `gmail-store.ts`.
4. Phase 3 adds a sixth definition, the document source, as read-only, with
   `gate: 'automatic'` for reading a file a person picked.
