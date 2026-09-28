# Interface language, email and Admin design

This is the reference for how Hermes talks to people on screen, and for the
email and inbox surfaces in particular. It was written for the September 27,
2026 email UX pass. The research behind the email patterns (ChatGPT's Gmail
drafts, Superhuman, Gmail with Gemini, Outlook Copilot, Front, Missive, HEY,
Help Scout) is summarized at the end.

## Voice

- Say what happened and what the person can do, in their words. The screen is
  for the people who run the team, not for the people who run the servers.
- One idea per sentence. Active voice. Name who did it: "Iris suggested a
  reply", "Dana marked this handled".
- Say "nothing was sent" when nothing was sent. Hermes's promise is that a
  person decides; the interface keeps saying so plainly, once per screen.
- Restrained labels. No tiny uppercase eyebrow text. Sentence case everywhere.

## Never on screen

These belong in logs, traces for operators, and docs. They are never rendered
in the product, including Admin screens and error states:

- Identifiers: UUIDs, hashes, digests, revision hashes, tool call ids, trace
  ids, message ids, provider message ids (`SIM-MSG-…`).
- Code: snake_case reasons (`hermes_provider_rate_limited`), enum values shown
  raw, tool names (`suggest_reply`), role slugs, JSON, file paths,
  environment variable names, OAuth scope strings.
- Protocol and infrastructure words: DMARC, SPF, DKIM, MIME, OAuth, API, token
  (as in credentials or model tokens), runtime, bridge, pool, pin, tenant,
  workflow instance, R2, Neon, webhook, idempotency, "digest", "revision N".
- Model and provider slugs (`nous:anthropic/claude-sonnet-5`,
  `nous_portal`). Use the model's display name ("Claude Sonnet 5") and the
  provider's brand name ("Nous Portal").

Allowed: brand names a customer recognizes and must act on (Gmail, Google
Workspace, Slack, Nous Portal), vendor names in data-processing disclosures,
and email addresses and domains the person is reading about.

When the server sends a reason code, the client maps it to a sentence. An
unmapped code falls back to a generic sentence ("Something went wrong. Nothing
was changed."), never to the server's text.

## Numbers and states

- "Needs 1 approval", "1 of 2 approved", not "0/1".
- A revised item is "Revised" or "Changed after review"; never "v2".
- Finished work never reads "Working". Every history row has a finished state
  word: Sent, Handled, Added, Removed, Retried, Blocked.

## Email surfaces

The pattern every tool we studied shares: the AI drafts, a person sends. The
draft sits next to the email it answers, is labelled as not sent, and has one
primary action. Warnings are plain sentences with one next step, at two
levels. Hand-offs look like a transfer to a team, not a new object.

### Status words

One vocabulary for the Inbox list, Admin → Role inboxes and the email chat:

| State | Words |
|---|---|
| Stored, not read yet | Waiting for Iris |
| Agent reading | Reading |
| A reply or hand-off is waiting for people | Ready for review (Inbox rows: "Reply ready") |
| Agent decided nothing is needed | No reply suggested |
| Waiting for an automatic retry | Trying again soon |
| Could not be read | Couldn't read it, with the reason and Try again |
| Arrived while the inbox was paused | Inbox paused |
| A flagged sender, on any row | Check the sender |

The agent's name is used where it is known ("Iris"); otherwise "the agent".

### A suggested reply

Order, top to bottom:

1. **Who and what.** "Reply to Priya Raman" · the email's subject · "Suggested
   by Iris for Partnerships · Not sent".
2. **Trust line.** One line under the sender: "Sender’s domain confirmed · First email
   from this address" or "Team member" or "Seen this address before".
3. **Cautions**, only when there are any, as one panel headed "Check before
   replying" with plain sentences, each saying what was noticed and what to
   do. A flagged sender adds "A second person approves this reply."
4. **The suggested reply**: To and Subject on one quiet line, then the body.
5. **The original email**: the safe rendering, its links (showing where each
   really goes) and attachments (showing what Iris read).
6. **Actions**: "Approve and send" (or "Approve reply" when the workspace only
   saves drafts), "Request changes", and in the overflow menu "Edit reply".

Severity levels:

- **Heads-up** (quiet, no colour): images were blocked, attachments were read.
  These are facts about safety that need no action; they sit as one muted line.
- **Check before replying** (warm, bordered): failed sender check, Reply-To on
  another domain, lookalike domain, a member's name from outside, bank details
  changing, hidden text removed, a link that goes somewhere other than it
  says. Never offer a "Looks safe" dismissal on these.

### A hand-off

The receiving team sees "Handed to Finance from Partnerships", Iris's note in
her words, "Iris can't pay, sign or reply from here", the same email view, and
one action: "Mark handled".

### Role inbox setup

Role inboxes sit at the top of Admin → Email, above the sending account. Setup follows the Help Scout order: choose the role and the
agent, name it, copy the address, then route mail to it with Google
Workspace's own menu names. A deployment without a receiving domain says so
in one sentence and names who can turn it on, never the configuration key.

### The email chat

An incoming email appears in the agent's "Email · Partnerships" conversation
as an email card (sender, subject, "Open in Inbox"), not as the instructions
the agent received. The agent's instructions are stored for the model only.

## Admin

Reworked on September 27, 2026 after the Admin page proved too hard to
navigate: 13 links stacked above the content in the side pane, so every page
started about 620px down, and most pages opened with paragraphs explaining how
the feature works. The pattern comes from Vercel's and Linear's settings (with
Stripe's and GitHub Primer's as checks).

- **Every page has its own address; navigation is two levels of tabs.** The
  left rail names only the three sections. The section's pages are tabs above
  the content, the same `Tabs` the Agent page uses; the tab names the page, so
  the page's own heading is for screen readers only. Where the pane is too
  narrow for a rail, the sections become a row of tabs too. No dropdown menus
  for navigation. The Admin/User view switch is gone; the sidebar's Settings
  and Admin entries already do that job.
- **Three sections, eleven pages, no section of one.** Workspace: General, Roles,
  Approvals, Usage, Data & privacy. Agents: Agents, Models, Capacity, Shared
  Intelligence. Connections: Slack, Email. A page that only held one setting
  joins the page it belongs to: the default model lives on Models, run limits
  on Usage, role inboxes on Email. Old links (`Agents`, `Inboxes`,
  `Inbox rules`) land on the page that absorbed them.
- **Nothing floats under the tabs.** A page starts with `AdminPageHeader`,
  which has a title for screen readers and an optional row of actions, and no
  description slot. Cards take a title, at most one sentence, the controls,
  and one footer action (Vercel's fieldset). A consequence worth knowing goes
  where the action is: "Saving also applies to work already waiting" appears
  beside Save once something changed. Only a drill-down (one agent, one role,
  one approval) shows a visible title with the record's own description.
- **Status lives in its row.** A connection's state is a pill in the card's
  Status or Connection row, not a second pill beside the page.
- **No how-it-works cards.** Settings pages hold settings. Step-by-step help
  that someone needs once goes behind a disclosure ("How to send email to an
  inbox"), closed by default. Explanations of the product belong in docs.
- **Say it once.** A number shown in a stat row is not repeated in a chart
  caption, and a list below a chart is not drawn again as a second chart.
- **Directions use the rail's names.** Messages that send someone to a page
  say "Admin → Models", "Admin → Capacity", "Admin → Email", matching the
  labels in the rail.

## Design system rules

These hold across the app. `apps/client/src/app/design-system.test.ts` checks
the ones a pattern can catch, in `pnpm check:quick`, and names the primitive to
use when it fails.

- **Navigation between views is `Tabs`.** A page with sibling views shows them
  as a tab row (`Tabs strong` for a page's top level, as on the Agent page). A
  dropdown is for choosing a value in a form, not for moving between pages.
  Only the phone layout falls back to a native select. Checked: no
  `role="tablist"` outside the primitive.
- **Anything empty is an `EmptyState`.** A list, tab, section or popover with
  nothing in it shows an icon and a short title, plus at most one line of
  detail, centered. Its action sits below the words, inside the empty state:
  while a list is empty, its "Add …" button moves out of the header and into
  the empty state, and returns to the header once there is something to list.
  Use `compact` inside a card, section or popover; the full size fills a page
  or tab. Never a bare "No … yet." sentence. `icon` accepts only glass icons
  that exist. A missing value in a field
  ("No owner", "No limit") is a value, not an empty state, and stays text.
  Checked: an emptiness test followed by a "No…"/"Nothing…" element, or any
  element reading "No … yet".
- **Sentence case, no uppercase eyebrows.** Checked: no `text-transform:
  uppercase` except an invoice's printed labels and the development-only
  account switcher.
- **Text is 12px or larger.** Older styles below 12px are being paid down; the
  check is a ratchet, so the count may fall but not rise.
- **A title and at most one sentence.** Checked for Admin pages: only the
  three drill-downs may use a visible heading with a description. Elsewhere
  reviewed against this document.

## Motion

Email surfaces reuse the app's existing transitions: row state changes
cross-fade (150 ms), panels open without spatial travel under
`prefers-reduced-motion`. No new animation system.

## Research summary

- ChatGPT with Gmail shows a draft and asks before sending any email.
- Superhuman writes drafts for messages that need a reply; "accepting the
  draft doesn't send the message"; edits happen in place.
- Outlook Copilot: Keep it / Discard / Regenerate, then the person presses
  Send.
- Gmail and Microsoft warnings: one plain sentence about what was noticed and
  one sentence of advice; no authentication jargon; two or three severity
  levels ("You don't often get email from …", "Be careful with this
  message").
- Front and Missive: assignment and transfer to another team, with the
  receiving person notified and the conversation at the top of their list.
- Help Scout and Front: forwarding setup shows the address with a copy button,
  then the provider's own menu path.
- Fyxer and Superhuman labels: short state words ("To respond", "Awaiting
  reply").
- No tool we found documents what it says when its AI fails to draft; the
  "Couldn't read it · Try again" wording is ours.
