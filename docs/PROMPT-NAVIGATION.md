# Prompt-driven workspace views

September 15, 2026. Iris's existing `set_focus` tool now accepts a screen name,
without requiring a fabricated entity id. It uses the existing run event stream
and predefined client components; there is no new external API or generated UI.

In Work or Plan mode, with **Following Iris** enabled, try:

- Show me pending applications.
- Show resolved applications matching Ada.
- Who is in this workspace?
- What context are you missing?
- Open the documents library.

Supported screens: Overview, Context, Skills, Traces, Inbox, Inbox Rules,
Members, History (Decisions), and Documents. Inbox supports pending/resolved,
all/application/documents/invoice/agreement, and case-insensitive label/subject
search. A fresh Inbox tool call resets omitted filters. Existing entity calls
continue to open request/document reviews; proposals keep their existing saved
review focus.

Manual navigation, tabs, and filter edits pin the full view. Iris can update
its own focus in the background but cannot unpin the human's view. Follow Iris
returns to that session's latest focus, including filters. Other sessions do
not steal the active pane. URL fragments retain the selected filters on reload.
Ask-mode permissions are unchanged: Ask does not offer `set_focus`.

## Contract and guardrails

`set_focus({view: "inbox", filters: {status: "pending", kind: "application"}})`
is validated against a shared allowlist. Unknown views, invalid filters,
non-Inbox filters, mixed entity/view calls, and arbitrary extra fields are
rejected. Existing `{entity_type, entity_id}` calls remain valid.

View-only `run.focus` events carry null entity metadata. They never create
request rows, populate an entity cache entry, or increment the Inbox count.
The model prompt explicitly separates showing a view from proposing a request.
The client's existing motion is retained; filter updates do not remount the pane.

## Verification

- Shared contract tests: allowlisted views, defaults, validation, ref equality.
- Worker engine tests: tool → valid replayable focus event; legacy objects;
  unchanged mode boundaries; no requests, notes, context or instruction writes.
- Client tests: follow/pin/resume, inactive sessions, tabs, URL round trips,
  rendered filter subsets, empty filtered results, unchanged counts/entities.
- `apps/client/e2e/live-navigation.spec.ts`: real browser, turn API, Workflow,
  event stream and rendering at desktop and narrow widths, including reload.
  The provider reply is explicitly scripted by a test-only header. This proves
  the integration, not natural-language tool-selection quality.

The feature was developed in an isolated worktree. Live-stack verification uses
`hermes_navigation_test` and localhost:8791, separate from the developer's
`hermes` database and localhost:8787. No production deployment is included.

### Integrated verification, September 15

Integrated into the main local working tree without altering Claude's staged
files. Feature source is preserved on `codex/iris-prompt-navigation` at
`69e3536` plus `aececb9`; the main checkout was concurrently at `f91cf3e`.
The combined client build and all-package typecheck pass. Combined-checkout
checks: 80 shared tests, 161 client tests, 31 targeted engine/navigation/mode
tests. Before integration, all 388 worker unit tests passed. The real-stack
Playwright scenario passed at 1840×1000 and 900×900, including six navigation
turns, pin/resume, reset filters and reload; the isolated workspace remained
at zero Inbox requests.

A real-model check in Chrome was attempted on localhost:8787. It did not start
a run: the app rejected the selected model with “Only OpenRouter keys can be
used in this workspace,” and the picker showed “No longer listed by
OpenRouter” with no usable replacement. No credentials or provider settings
were changed. Natural-language tool selection remains to be checked after the
concurrent provider/catalog work is ready. This is the only outstanding live
validation for this feature; it is not evidence of a navigation failure.

Run the standard isolated suite with `pnpm e2e:live -- live-navigation.spec.ts`,
or point Playwright at a separately prepared scripted test Worker with
`E2E_BASE_URL`, `PGDATABASE`, and the existing Compose project's name.
