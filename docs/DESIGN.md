# Interface language, email and Admin design

This is the reference for how Hermes talks to people on screen, and for the
email and inbox surfaces in particular. It was written for the September 27,
2026 email UX pass. The research behind the email patterns (ChatGPT's Gmail
drafts, Superhuman, Gmail with Gemini, Outlook Copilot, Front, Missive, HEY,
Help Scout) is summarized at the end.

## Voice

The [partner watch](PARTNER-WATCH.md) follows the same restrained language:
one source line, cadence and spending limits, the latest result, and a quiet
last/next check line on the existing agent overview. Configure stays in a
dialog. A clicked Run now says "Check requested" until durable results arrive.
A quiet later check retains the latest review link. Simulated execution says
"Sample watch"; a missing deployment, source or model is an actionable setup
state, never a claim that scheduled work is live. Existing status and dialog
motion follows real activity and reduced-motion preferences.

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

## Connections

Admin → Connections holds one page per connected service (Slack, Email). Set
on September 27, 2026 from a review of how agent products add and manage
connections: Composio, Arcade, Pipedream Connect, Claude's and ChatGPT's
connectors, Merge Agent Handler, Paragon and Notion AI.

- **A list, not a gallery, while there are few.** Galleries belong to large
  catalogs (Claude's directory, Composio). With two to six services, each is a
  tab with its logo; add an "Add connection" gallery only past about six.
- **Every connection shows its service's logo** (`BrandIcon`, from the CC0
  Iconify logos set) in its tab and on its card, so it is recognisable before
  it is read.
- **Status only when it says something.** No badge for "Not connected"; the
  Connect button says it. A healthy connection is a green `StatusDot`
  "Connected" beside the title. Only a connection that needs someone gets a pill: "Needs
  attention". Never a status row repeating the title.
- **Name the account agents act as.** A connected card shows which account
  (Sends from, the Slack workspace) without opening anything.
- **Say what stops before disconnecting.** The confirmation names what stops
  working; earlier work stays.
- **Agents have their own email; nobody adds an inbox.** Admin → Email shows
  one card per agent: its mark, name and a status dot (Receiving, or amber
  Paused), who reviews its mail and how many emails it has as two icon facts
  ("Partnerships reviews", "Owner reviews"), Pause, a red Replace address, and
  the address as a Snippet. Recent email are rows with the sender's initials,
  the subject, "2 to do" and "Check the sender" pills, and the state as a
  status dot. Sentences appear only where someone must act (a failed read).
  The Outreach account card is only for outreach from a Google or Microsoft
  mailbox (C100).
- **Organization connections and personal links stay distinct.** The Slack
  install and the Gmail sending account belong to the workspace; a person's
  Slack identity link is theirs.

Next, when the data exists (not built yet): a "What agents can do" list per
connection that links each action to its approval rule rather than repeating
it; who has linked their Slack identity; last used and a periodic health check
so an expired token shows here before an approved action fails.

## Design system rules

These hold across the app. `apps/client/src/app/design-system.test.ts` checks
the ones a pattern can catch, in `pnpm check:quick`, and names the primitive to
use when it fails. The mock build shows every primitive in its states at
`?ui=library` (`apps/client/src/app/design-system/Library.tsx`); add a new
primitive there when you add it to `ui/primitives.tsx`.

- **Destructive actions are red.** A button that deletes, removes,
  disconnects, revokes or replaces is `<Button danger>`; the confirmation that
  carries it out is `danger primary` (solid red), labelled with the same verb
  and noun ("Replace address", never "Confirm"), and focus starts on the safe
  choice. The dialog says what stops working and ends "This can't be undone."
  when it can't. From Vercel Geist's error button and shadcn's destructive
  variant. Checked: any `Button` whose words include Delete, Remove,
  Disconnect, Revoke or Replace address must carry `danger`.
- **A state is a `StatusDot`.** A coloured dot and its word: green healthy
  (Connected, Receiving), accent waiting for a person (Ready for review), amber
  paused or needs a look, red failed, grey quiet. Only work in progress pulses,
  and not under reduced motion (Geist's StatusDot, AI Elements' Tool states).
  A one-sentence reason goes in `hint`, shown on hover, not beside it.
- **Pills are one or two words about a record**, with an optional icon: `info`
  for counts ("2 to do"), `warn` for something to check ("Check the sender"),
  `danger` for something wrong.
- **A value people copy is a `Snippet`**: the value in monospace and a copy
  icon that becomes a check (AI Elements' Snippet), not a separate Copy button.
- **A list row is an `Item`**: media to recognise it by, a title and one line,
  and at most two controls (shadcn's Item, Geist's Entity). Prefer icons with
  a word ("Owner reviews", "4 emails") over a sentence of facts.

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
`prefers-reduced-motion`. No new animation system. A `StatusDot` changes
colour over 150 ms and pulses only while work is in progress; a `Snippet`'s
copy icon swaps to a check for 1.6 s. Reduced motion keeps both as instant
changes.

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

Agent UI components (reviewed September 28, 2026, for the Admin → Email
cleanup):

- Vercel AI Elements (elements.ai-sdk.dev): Tool shows its state as a small
  badge with an icon, coloured by meaning (Running pulses, Completed green,
  Error red, Awaiting Approval amber); Snippet copies a value with an icon that
  turns into a check; Confirmation shows only the part that matches the
  approval state.
- Vercel Geist (vercel.com/geist): StatusDot pairs a dot with its word and
  animates only while building; Button has an error type for destructive
  actions, labelled verb plus noun; Entity rows keep one or two controls and
  move the rest to a menu; a destructive modal focuses Cancel first.
- shadcn/ui (ui.shadcn.com): Button and Badge have a destructive variant;
  Item is media, title, description and actions; AlertDialog's action takes
  the destructive variant.

## Wallet enrollment (September 28, 2026)

Wallet setup lives inside Admin → Connections; member status appears in Members.
Keep the existing Admin navigation and settings cards. A saved request says
“Needs owner setup,” never “Connected” or “Ready.” Explain that owner enrollment
and verification are still required before an address exists. Keep signing and
payment status separate.

Use immediate updates for request/status changes. There is no provisioning
animation because this increment performs no provider provisioning; ordinary
loading feedback reflects only an actual API request. This needs no spatial
animation, including in reduced-motion mode. Preserve the sign-in-again action
when setup requires recent authentication.
