# Proactive first-run experience

Status: production substrate in main; guided UX in `codex/proactive-onboarding-preview` · September 15, 2026

## Implementation status

Main now persists the chosen agent name and instructions, creates the saved
instruction version, and seeds one deterministic setup session and message in
the workspace transaction. It also reports unavailable email ingress,
attachments and automated triggers as explicit capability flags. The reusable
Nous Portal connection flow is shared by Settings and onboarding; **Continue
with Nous** currently opens the official key page and the person returns to
paste the key.

The separate preview branch wires the guided Role → Loop → Boundaries → Test
experience into the real chat and app panes. Its evolving working-agreement
answers use workspace-scoped browser storage for design evaluation. A reviewed
server setup endpoint and the safe sample-Inbox creation path are still needed
before that guided layer should merge to main.

## Outcome

The first run should feel like the first working session with Iris, not an
administration wizard. A new owner should leave with one repeatable loop, clear
human review boundaries, a connected model provider, and one safe practice
result in the Inbox.

The first scenario is Maya configuring Iris for the Hermes Partner Program.
The design must generalize to other roles without turning the screen into a
template catalog.

## What is wrong today

- The setup asks for an agent name and instructions, but `POST /workspaces`
  sends only the workspace name. The agent-defining answers are discarded.
- The flow explains configuration before showing useful work.
- The new workspace opens into an empty composer and waits for the person to
  know what to ask.
- Connecting Nous Portal is buried in Settings, requires an unnecessary label,
  and provides no link to create a key.
- “Proactive” is not configured. A role description alone does not tell Iris
  what event starts work, how far it may proceed, or where a human must decide.

## Recommended flow

Keep sign-in and workspace creation short. After the workspace name is saved,
open the full product with the Iris panel visible and one durable session named
**Set up Iris**.

Iris speaks first with a deterministic `setup` message written by the product,
so this works before a model key exists and never implies that inference ran.
The app pane shows a live **Working agreement** that fills in as Maya answers.

The setup has four phases:

1. **Role** — what Maya owns.
2. **Loop** — the repeatable work Iris should run.
3. **Boundaries** — where Iris stops for a human.
4. **Test** — connect Nous and run a safe sample.

The step labels live in one compact progress row above the conversation. They
do not replace the normal shell or create a separate onboarding product.

```text
Role  →  Loop  →  Boundaries  →  Test
           └── Working agreement updates on the right ──┘
```

## The Partner Program conversation

### 1. Role

Iris:

> Let’s set up the work you want me to repeat. What do you own?

Choices:

- Partner Program
- Customer Success
- Customer Onboarding
- Procurement
- Something else

### 2. Loop

After **Partner Program**:

> Which loop should I run first?

Choices:

- Screen partner applications
- Onboard accepted partners
- Support active partners

After **Screen partner applications**:

> For each application, I can research the applicant, score the evidence, and
> prepare a recommendation. You decide who joins.

Actions: **Use this loop**, **Adjust**.

The right pane becomes a visual loop:

```text
Application → Research → Evidence brief → Human review
```

### 3. Boundaries

Show four selected review rows rather than another paragraph:

- Admit or reject an applicant — Maya
- Assign or change role and benefits — Maya
- Send an external message — Maya
- Sign an agreement or pay an invoice — Admin + Finance

Iris asks only:

> Should all four stop in your Inbox?

Actions: **Yes**, **Change reviewers**.

Program criteria and financial terms remain explicitly unset until Maya adds
real source material. Iris must call missing criteria a gap instead of inventing
them.

### 4. Trigger and test

For the first production slice, the truthful trigger is text:

> Start with a person, company, or profile URL.

Agent email ingestion, file attachments, forms, CRM events, and scheduled scans
should appear only after those paths reach the runtime. The current attachment
path does not deliver file contents to Hermes, and the generated HermesMail
address is not yet a production inbox.

Before the practice run, show the provider card described below. When it is
connected, Iris says:

> I’m ready. Want to see the loop with a sample application? Nothing will be
> sent or changed.

The sample produces one Inbox item marked **Sample**. It shows sources, evidence,
recommendation, and the exact consequence of approval. Finishing it returns to
the same session with:

> Your loop is ready. Send me a name or profile URL when you want to screen the
> first applicant.

## Nous Portal connection

### Ship now

No documented Nous API creates or retrieves keys. Use a guided copy/paste flow
with the official deep link:

`https://portal.nousresearch.com/api-keys`

Inline card:

**Connect Nous Portal**  
Iris uses Nous Portal for model access. Usage is billed to your Nous account.

1. **Open Nous Portal** — opens the key page in a new tab.
2. **Paste your key** — one password field.
3. **Connect and continue** — stores, verifies, and syncs models.

Security copy:

> Encrypted for this workspace and never shown again. Verification makes one
> minimal model request.

Remove the required label in first run. The server should default it to **Nous
Portal**. Preserve setup state through the recent-sign-in redirect and focus
the key field when the person returns; never read the clipboard automatically.

Success state:

> **Nous Portal connected**  
> {N} models are ready for Iris.

Errors should name the next action:

- Invalid: **Open Nous Portal**, **Try again**.
- Credits required: **Manage Nous account**.
- Temporary failure: keep the encrypted key and offer **Try verification
  again**; do not require another paste.
- Member: say that a workspace Admin must connect it.

### Target experience

Official Hermes supports Nous Portal OAuth with `inference:invoke`, rotating
refresh tokens, and short-lived inference JWTs. Hermes Enterprise must not
reuse the public `hermes-cli` client ID. The one-click target is **Continue with
Nous**, after Nous provisions an Enterprise client and approved redirect URIs.
Keep **Use an API key instead** as the fallback.

## What “proactive” means

Proactivity needs a working agreement, not a personality setting. Persist these
six facts:

| Field | Partner Program example |
| --- | --- |
| Goal | Find strong Hermes partners |
| Trigger | A person, company, or profile URL is submitted |
| Inputs | Program criteria and public evidence |
| Loop | Research, score, summarize, recommend |
| Review | Admission, role, benefits, outreach, agreements, money |
| Done | A cited brief is waiting for the right reviewer |

The default operating mode is **Work until review**. Iris may gather and
organize evidence, then stops at a decision the human owns. Event-driven sources
can start this loop later. Scheduled proactivity must be owned by the Enterprise
application scheduler; native Hermes cron remains disabled by policy.

## Minimal implementation

1. Create a `Set up Iris` session and deterministic setup message in the same
   transaction as the workspace.
2. Add a typed setup endpoint that persists answers into existing agent context
   fields, advances `agents.setup_step`, and resumes safely after refresh.
3. On confirmation, write one saved instruction version, copy the concise role
   summary to `agents.responsibility`, and change the agent from `draft` to
   `started`.
4. Render a server-owned Working agreement in the app pane. Setup choices call
   the setup endpoint directly; they do not require a provider run and do not
   use model-authored commands.
5. Move the manual Nous connection card into the Test phase, default its label,
   link to the official key page, and return structured verification failures.
6. Run the sample only after the provider is ready. Mark every synthetic object
   as Sample and prevent external effects.
7. Keep the completed setup session as the first entry in History rather than
   deleting the decisions that configured Iris.

This reuses `agents`, `agent_context_fields`, `instruction_versions`, sessions,
messages, and the current provider-key routes. A separate workflow table is not
needed until one agent can own multiple independently triggered loops.

## Motion

- Crossfade each setup question and use shared-layout movement for the Working
  agreement row that was just filled: 160–200 ms, existing ease-out token.
- On provider connection, show real states only: encrypting → verifying →
  syncing models → ready. Never animate invented progress.
- The first sample may reveal its four loop stages as they actually complete;
  no per-token animation.
- Reduced motion replaces movement with an immediate update and a short opacity
  change.

## Evidence and success criteria

Current enterprise agent builders reinforce four useful patterns: start from a
plain-language job, generate editable instructions, supply starter prompts, and
test before activation. Microsoft documents description-led agent generation,
suggested prompts, and a test chat; Intercom separates train, test, deploy and
requires an introductory agent message. The Hermes flow condenses those ideas
into one real session rather than recreating a builder UI.

- Microsoft Copilot Studio: <https://learn.microsoft.com/en-us/microsoft-copilot-studio/fundamentals-get-started>
- Suggested prompts: <https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-starter-prompts>
- Intercom Fin setup and testing: <https://www.intercom.com/help/en/articles/8286630-deploy-fin-ai-agent-over-chat>
- Nous Portal integration: <https://hermes-agent.nousresearch.com/docs/integrations/nous-portal>

Measure:

- No blank composer on first entry.
- At most four human questions before the Working agreement is reviewable.
- Setup survives refresh, reauthentication, and leaving the page.
- The person can identify what Iris does and what always requires review.
- First safe Inbox item within five minutes.
- No screen claims a key, source, message, payment, signature, or external
  action exists when it does not.
