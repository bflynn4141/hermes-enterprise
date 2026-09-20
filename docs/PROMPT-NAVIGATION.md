# Prompt-driven workspace views

September 15, 2026; revised September 20, 2026. Iris's `set_focus` tool
accepts a screen name, without requiring a fabricated entity id. It uses the
existing run event stream and predefined client components; there is no new
external API or generated UI.

In Work or Plan mode, try:

- Show me pending applications.
- Show resolved applications matching Ada.
- Who is in this workspace?
- What context are you missing?
- Open the documents library.

Supported screens: Overview, Context, Skills, Traces, Inbox, Inbox Rules,
Members, History (Decisions), and Documents. Inbox supports pending/resolved,
all/application/documents/invoice/agreement, and case-insensitive label/subject
search. A fresh Inbox tool call resets omitted filters. Existing entity calls
continue to name request/document reviews; proposals keep their existing saved
review focus.

## Nothing moves on its own

The app pane moves only when a person moves it. A run's focus is recorded on
its session and the reply carries one line, `Open Inbox · Resolved`, that
navigates when clicked. Manual navigation, tabs and filter edits are never
replaced by Iris; other sessions do not touch the active pane; selecting a
session shows the object it was working on; URL fragments retain the selected
filters on reload. On small screens the link also switches to the App pane.

Earlier the pane followed Iris while "Following Iris" was on, and manual
navigation "pinned" it until Follow was pressed again. That state machine was
the one piece of the interface that moved without the person touching it, and
it is gone (DECISIONS, C34 continued and the September 20 entry beside it).
Ask-mode permissions are unchanged: Ask does not offer `set_focus`.

## Contract and guardrails

`set_focus({view: "inbox", filters: {status: "pending", kind: "application"}})`
is validated against a shared allowlist. Unknown views, invalid filters,
non-Inbox filters, mixed entity/view calls, and arbitrary extra fields are
rejected. Existing `{entity_type, entity_id}` calls remain valid.

View-only `run.focus` events carry null entity metadata. They never create
request rows, populate an entity cache entry, or increment the Inbox count.
The model prompt explicitly separates showing a view from proposing a request.

## Verification

- Shared contract tests: allowlisted views, defaults, validation, ref equality.
- Worker engine tests: tool → valid replayable focus event; legacy objects;
  unchanged mode boundaries; no requests, notes, context or instruction writes.
- Client tests: a focus is recorded and never moves the pane; opening the
  offered view applies its complete filters; a person's filters survive a new
  focus; inactive sessions; tabs; URL round trips.
- `apps/client/e2e/live-navigation.spec.ts`: real browser, turn API, Workflow,
  event stream, the link in the reply, and rendering at desktop and narrow
  widths, including reload. The provider reply is scripted by a test-only
  header. This proves the integration, not natural-language tool selection.

Run it with `pnpm e2e:live -- live-navigation.spec.ts` on a free port
(`E2E_BASE_URL=http://localhost:8791`).
