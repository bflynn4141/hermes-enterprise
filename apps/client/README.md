# `apps/client`

The workspace client: React 19, Motion 13, TypeScript strict, bundled by esbuild
into `dist/`, which the Worker's Static Assets binding serves with an SPA
fallback and `run_worker_first` on the API prefixes.

It runs against the real Worker. `pnpm e2e:live` boots Docker Postgres, the
migrations, `wrangler dev --local` with `AUTH_MODE=fake` and `MODEL_SCRIPTED=1`,
and drives the live scenarios; `qa/live/` holds the screenshots that run
produced.

**The suite has its own stack** (decision C43). It creates and migrates its own
database, `hermes_test`, and starts its own Worker on :8788 — it never touches
the `hermes` database or the :8787 Worker the developer is watching. See "Two
stacks" below.

Every tab is wired to a route now. Traces and the trace detail, Skills and
instruction review, Context fields, Settings → Usage, Agents caps and Data and
privacy, the Library's saved HTML render, effects on the receipt, workspace
delete and undelete, and onboarding through `POST /workspaces` and
`POST /invitations/:token/accept`. "Not available yet" survives in exactly two
places, Library → Connections and Library → Shared Intelligence, both M6's.

There is no framework and no router. Routing is `src/model/routes.ts`: two pure
functions over `packages/shared/refs.ts`, so the URL and `sameRef` are driven by
the same keys and a new ref key cannot be forgotten in one of them. The shell's
own path prefix is `/workspace/:ws`, and `/w/:ws` works too: the prefix moved
because `/w/*` is worker-first and its catch-all used to answer JSON (decision
C12), and the Worker's catch-all now serves the app to a navigation there
(server decision F1). `parseRoute` has always accepted both, so both are live
and nothing had to change.

## Commands

```sh
pnpm --filter client build      # production bundle into dist/
pnpm --filter client dev        # esbuild watch + a static server on 127.0.0.1:4180
pnpm --filter client test       # vitest: the reducer and the adapter
pnpm --filter client typecheck
pnpm --filter client e2e        # Playwright, against the mock bundle
pnpm e2e:live                   # the whole stack, then the live scenarios
pnpm --filter client acceptance:native-staging -- --manifest /absolute/rehearsal.json --report /absolute/evidence.json
pnpm db:reset                   # (root) demo database back to the seed — destructive
pnpm --filter client dev:step-up  # re-stamp the fake-auth step-up window
```

### Native staging acceptance (read-only)

`acceptance:native-staging` verifies a prepared Partnerships-to-Finance
rehearsal without starting a run or changing hosted state. It accepts only GET
responses from an HTTPS deployment whose health identifies `staging`, WorkOS
authentication and Hermes runs as healthy. It requires two distinct, mode-0600
Playwright storage-state files and confirms that they resolve to the expected
Partnerships and Finance people in the same workspace.

The manifest is operator-owned and stays outside the repository. Its shape is:

```json
{
  "schema_version": 1,
  "base_url": "https://staging-host",
  "workspace_id": "uuid",
  "intake_event_id": "uuid",
  "payload_hash": "sha256:64-lowercase-hex-characters",
  "handoff_id": "uuid",
  "request_id": "uuid",
  "decision_id": "uuid",
  "document_id": "uuid",
  "input_provenance": "sample",
  "roles": {
    "partnerships": {
      "auth_state": "/absolute/private/partnerships.json",
      "user_id": "uuid",
      "email": "the-expected-partnerships-login",
      "agent_id": "uuid",
      "runtime_profile": "the-bound-native-profile",
      "run_id": "uuid"
    },
    "finance": {
      "auth_state": "/absolute/private/finance.json",
      "user_id": "uuid",
      "email": "the-expected-finance-login",
      "agent_id": "uuid",
      "runtime_profile": "the-bound-native-profile",
      "run_id": "uuid"
    }
  }
}
```

Capture each storage state from that person's already authenticated browser
context, keep the files outside the checkout, and restrict them to the current
user (`chmod 600`). Then invoke the verifier explicitly:

```sh
HERMES_NATIVE_STAGING_ACCEPT=read-only pnpm --filter client acceptance:native-staging -- \
  --manifest /absolute/rehearsal.json \
  --report /absolute/native-staging-evidence.json
```

The command refuses CI, local endpoints, reused auth sessions, legacy skill
versions, incomplete tool inventories, scripted/fixture markers, simulated
execution and customer labeling for this sample rehearsal. It requires the
exact versioned Partnerships and Finance assignments, the current four-tool
Finance readiness inventory (`get_partner_handoff_result`, `list_requests`,
`get_request`, `skill_view`; the trace excludes the viewer-only `skill_view`),
one stored invocation of each role's required native bridge tool, a passed
authoritative Finance result, an approved human decision, the saved invoice
draft and its delivered allowlisted acknowledgment. The mode-0600 report keeps
only stable identifiers and reviewed contracts; it never contains cookies or
private tool payloads.

This evidence establishes that the prepared workflow used the native runtime
and real stored application state. It does not grade provider response quality.
The existing `e2e:live` command remains the local fake-auth, scripted-model
suite and cannot satisfy this acceptance check.

## Running it live

```sh
pnpm db:up && pnpm db:migrate
pnpm --filter @hermes/worker db:seed
AUTH_MODE=fake pnpm --filter client build     # into dist/, which the Worker serves
pnpm --filter @hermes/worker dev              # wrangler dev --local on :8787
open http://localhost:8787/workspace/11111111-1111-4111-8111-111111111111
```

The seed creates two users, and the sidebar's dev account switcher moves between
them: `maya@nous.example` (Admin) and `dana@nous.example` (Member). It is behind
`__AUTH_MODE__ === 'fake'`, so a production build eliminates it.

### Two stacks

| | dev stack | test stack |
|---|---|---|
| database | `hermes` | `hermes_test` |
| Worker | :8787, `pnpm --filter @hermes/worker dev` | :8788, started and stopped by `pnpm e2e:live` |
| variables | `apps/worker/.dev.vars` | `apps/worker/.dev.vars.test`, generated per run |
| model | whatever `.dev.vars` says, possibly a real provider | always scripted |
| reset | `pnpm db:reset` | `pnpm db:test:up` (idempotent, not destructive) |

They share the Docker container and nothing else. Every suite — `pnpm e2e:live`,
`pnpm db:test`, and the worker vitest projects — goes through
`scripts/test-db.mjs`, which creates `hermes_test` if it is absent and migrates
and seeds it.

The launcher refuses to start on 8787, refuses if the database it resolved is
not `hermes_test`, refuses if any generated connection string does not end in
`/hermes_test`, and refuses to reuse a Worker it did not start. Point it
somewhere else with `E2E_BASE_URL`:

```sh
E2E_BASE_URL=http://localhost:8798 pnpm e2e:live   # when 8788 is taken
```

`pnpm db:reset` is the **dev** database only. It recreates `hermes` rather than
tearing the Docker volume down — the volume is shared, and `hermes_test` is not
its business — and it **keeps the seed workspace's provider keys**, which are
the one thing in that database a script cannot regenerate.

### Real local mode, and what it costs

`wrangler.jsonc`'s development block ships `MODEL_SCRIPTED="1"` and
`NOUS_PORTAL_FIXTURE="1"`, so a local Worker answers turns from
`ScriptedProvider` and verifies provider keys from a built-in fixture. Nothing
reaches a network. To drive the product against the **real** Nous Portal API on a
real key, change exactly two values in `apps/worker/.dev.vars`:

```
MODEL_SCRIPTED="0"
NOUS_PORTAL_FIXTURE="0"
```

then **restart the Worker** — wrangler reads `.dev.vars` once, at startup — and
**re-verify the key in Settings -> Provider keys**, because the row in the
database was verified by the fixture and its catalog rows came from the
fixture's model list. Every turn after that costs money.

Two things are deliberately unaffected by those two values, and the reason is
decision C37: `.dev.vars` beats the process environment in wrangler, so
`pnpm e2e:live` used to inherit "real local mode" and send fifty turns to a real
provider while three comments said it was scripted.

* `pnpm e2e:live` generates `apps/worker/.dev.vars.test` from `.dev.vars` with
  `AUTH_MODE=fake`, `MODEL_SCRIPTED=1`, both provider fixtures enabled and the
  `hermes_test` connection strings forced, starts wrangler with `--env-file`
  pointing at it (which makes wrangler skip `.dev.vars` entirely), and then
  **sends one turn** and waits for the scripted provider's own sentence before
  it will run the suite. It will not reuse a Worker it did not start.
* `pnpm --filter @hermes/worker test` forces the same three as miniflare
  bindings in `vitest.config.ts`, which are applied after the pool reads
  `.dev.vars`.

The suite's port comes from `E2E_BASE_URL`, and the base URL is added to
`ALLOWED_ORIGINS` in the generated file, so the scripted suite runs beside a
real-mode Worker without disturbing it:

```sh
pnpm --filter @hermes/worker dev   # real mode, :8787, hermes
pnpm e2e:live                      # scripted, :8788, hermes_test
```

`apps/worker/.dev.vars` needs a `KEK_V1` (base64, 32 bytes) before a provider
key can be added — without one the route answers 503 `kek_unavailable`, which
says what is missing (server decision F5). `wrangler` only reads `.dev.vars` at
startup, so restart it after adding one.

Two things behave differently under fake auth, both of them the Worker's shape
rather than a client choice, and both recorded as decisions C16 and C24:

* the hub sockets are refused, because fake auth is a header and a browser
  cannot put a header on a WebSocket handshake. The client falls back to polling
  the same replay route, with the same cursor and the same ordering, so
  everything works — it is just a little slower. Playwright can set the header,
  so the live suite exercises the socket path.
* `authenticated_at` used to be stamped once and never moved, so decisions and
  provider-key changes started answering `reauth_required` five minutes after a
  dev workspace was first opened. The Worker now has a development step-up:
  `GET /auth/login?step_up=1` re-stamps the row in `AUTH_MODE=fake` and
  redirects back (server decision F4), and `stepUpUrl` returns it in both modes
  (decision C29), so there is one code path rather than an in-place challenge.

  One caveat that will bite somebody: the fake-mode step-up needs the
  `x-dev-user` header, and a browser cannot put a header on a top-level
  navigation. Playwright can, so the live suite exercises it; clicking through
  `wrangler dev` in a real browser gets a 401 there, and the answer is
  `pnpm --filter client dev:step-up`, which re-stamps the row from the shell.

## Mock server mode

The whole client runs without the Worker. `MOCK=1` builds it with `__MOCK__`
true and the adapter is handed a `fetch` and a socket factory from
`src/model/mock.ts` instead of the browser's — so every call still goes through
the same REST client and the same zod parse, and a mock response that does not
satisfy the contract fails here rather than drifting quietly. The run stream is
`packages/shared`'s `mockRunStream`, so the difficult sequences (a retried step
attempt, a stopped run, a request focused before it is created) are the
contract's own scenarios.

```sh
MOCK=1 pnpm --filter client dev     # http://127.0.0.1:4180
```

Query parameters pick the fixture:

| URL | What it shows |
|---|---|
| `/` | The seeded October 12 workspace: four requests, a blocked reply, a run |
| `/?data=empty&key=none` | Every first-run empty state, and the composer greyed with "Connect Nous Portal in Settings to start" |
| `/?seat=member` | The Member seat: the review pane reads "Admin decision required" |
| `/?key=invalid` | A rejected key: "Your deepseek key was rejected. Re-verify or rotate it" |
| `/onboarding/create`, `/onboarding/join?token=inv_demo` | The two onboarding routes, including credential-free completion in mock mode |
| `/?reply=markdown` | An Iris reply that uses the whole safe Markdown subset, including an `<img onerror>` that must render as text (decision C39) |
| `/?picker=1` | The real workspace-picker state machine; browser tests stub its directory responses |
| `/?memberWrites=fail` | Members with deterministic rejected writes, used to verify inline recovery |
| `/shared/mock-share-token` | The read-only share viewer |

`__MOCK__` is a build constant, so a production build eliminates the module, the
build deletes the orphan chunk esbuild still emits for the folded dynamic
import, and it greps `dist/app.js` for `x-dev-user` to prove the dev account
switcher is gone with it.

## Layout

The tested floor for the enterprise desktop shell is 900 CSS px. Below 1000 px
the Iris and app panes switch rather than squeeze side by side; phone-sized
navigation is not part of this shell yet.

```
src/model/    store.ts      the reducer, the entity cache, the two cursors
              adapter.ts    the one object components talk to
              rest.ts       the typed REST client; one policy, one route table
              hub.ts        the two sockets: ping, silence, replay-then-buffer
              auth.ts       the workos / fake seam and the step-up intent
              routes.ts     parseRoute / toHref over refs.ts
              mock.ts       the mock backend (MOCK=1 only)
src/app/      Shell, Sidebar, chat/, views/, onboarding/, shared/, ui/
              chat/markdown-subset.ts   the safe Markdown parser: an allowlist
              chat/Markdown.tsx         the only elements it can become
              chat/IrisText.tsx         one renderer, stream and final alike
              chat/refusal.ts           what the composer says when a turn is refused
              library-defaults.test.ts  the fixture-default audit (C42)
e2e/          scenarios.spec.ts   P1–P3, against the mock bundle
              live-transcript.spec.ts T1–T6: the scroll model and the run
                                  surface's order, from the browser's boxes
              qa-screens.spec.ts  the mock screenshots
              live.spec.ts        P4–P14, against wrangler dev
              live-findings.spec.ts the scenarios the server fixes unblocked
              live-m5a.spec.ts    M1–M8: the tabs that got routes, and the
                                  flows that got them second
              live-screens.spec.ts the live screenshots
              live-panel.spec.ts  N1–N7: the panel's three states and the
                                  sessions list, against the live stack
              panel-screens.spec.ts every page × three panel states × two widths
              panel-sidebar.spec.ts the sidebar's list plus every navigation,
                                  workspace and account-menu route (C34, C50)
              panel-narrow.spec.ts  900 and 1100 in all three states: the
                                  navigation keeps its own column
              panel-helpers.ts    the assertions the panel suites share
scripts/      e2e-live.mjs      boots the stack and runs the live suite
              live-fixture.mjs  a fresh workspace, and the step-up re-stamp
              dev-step-up.mjs   the step-up re-stamp on its own
qa/chat/      the scroll model, the activity row and the Markdown subset
qa/           one screenshot per screen, from e2e/qa-screens.spec.ts
qa/live/      the same screens against the real Worker
qa/tables/    the four list screens, from e2e/live-tables.spec.ts
qa/panel/     every page in open, rail and hidden at 1840 and 1440
```

## Panel

The Iris pane has three states, not two (decision C33). Collapsing it never
interrupts a run: the rail keeps reporting one.

The navigation column is 240 px at every width (decision C36). The demo
collapsed it to icons below 1180 px; that breakpoint was kept through the port
and became a bug, because `SidebarNav` renders at its own 224 px and collapses
on its own control, so all the breakpoint did was draw the navigation across
whatever was beside it. The way to buy horizontal room is to collapse Iris.

| State | What it is |
|---|---|
| `open` | The chat pane at the remembered width. Default 800 px at ≥ 1840 — the demo's 240 + 800 + 800 — and an equal split of the work area below it. Min 420 px, max 60 % of the work area. |
| `rail` | 56 px between the navigation and the app: the Iris mark in its live run state, an unread badge for what arrived while it was collapsed, New session and Sessions. Not shown below 1000 px, where the Chat/App switch takes over. |
| `hidden` | No rail. The app header's "Open Iris" is the way back. |

| Keys and controls | What happens |
|---|---|
| **⌘L** / **Ctrl+L** | Toggles `open` ↔ `rail` from anywhere in the shell. Ignored while typing in any input *except* the composer, where it still collapses and hands focus to the app pane. Reopening puts the cursor back in the composer. |
| Hide, in the chat header | → `rail` |
| **Hide completely**, in the session options menu (•••) | → `hidden` |
| Open Iris, in the app header · the rail's mark | → `open`, cursor in the composer |
| Drag the 6 px boundary | Resizes; the width is remembered per workspace and user in `localStorage`. |
| **←** / **→** on the boundary | ± 24 px. It is a focusable `role="separator"`. |
| **Home** / **End** | Minimum / maximum. |
| **Enter** or double-click | Back to the default for this window width — "nothing remembered", not "800". |

Follow and pin are unchanged by any of it: while collapsed, `run.focus` still
moves the app pane when following, and a decision receipt still counts on the
rail's badge.

Sessions behave differently too (decision C34). **New session** reuses a blank
session rather than creating a second one, opens the panel and focuses the
composer; a blank session is listed only while it is the one you are in; the
first turn names the session from its first six words and the finished run
renames it to the object it produced ("Ada Ling · application"); and a manual
rename wins permanently. `qa/panel/sidebar-before.png` and `sidebar-after.png`
are the same three clicks on either side of that change.

## The rules this package keeps

* **Nothing unvalidated reaches the reducer.** Every response and every socket
  frame is parsed with a schema from `packages/shared`. A block that fails
  validation renders "Could not display this block"; it never throws and never
  renders a button whose command was rejected.
* **The client never decides.** There is no `request/decide` reducer case. A
  decision is `POST /w/:ws/requests/:id/decisions` with a CSRF token,
  `X-Requested-From: inbox` and step-up, and the result is observed as
  `decision.recorded`. After a step-up redirect the pane re-renders and waits
  for a second, deliberate click — it never auto-replays.
* **A refusal is rendered, never swallowed.** Every send, guide and queue used
  to end in `.catch(() => undefined)`, so a 400 with a sentence in it produced
  nothing on screen. `chat/refusal.ts` maps the server's `reason` to an *action*
  and never to replacement copy — the Worker's words are shown verbatim, the
  client adds the route to the fix — the draft comes back with the caret, and a
  session is not named after a turn that never ran (decision C45).
* **A chat reply may use light Markdown; a tool argument may not.** The subset
  is paragraphs, bold, italics, inline code, fenced code, lists, headings to h3,
  blockquotes and simple tables, parsed by `chat/markdown-subset.ts` into a node
  union with no HTML node and no anchor node — the parser is the allowlist, so a
  `<script>` is nine characters of text and a link is its label beside a
  non-interactive chip carrying the bare URL (decision C39). `plainText()` in
  `packages/shared` is untouched and still refuses markup in every string a tool
  writes.
* **`MODEL_COMMANDS` is enforced client-side too**, as a second line after the
  server validator. The risk it closes is a person clicking a button the model
  labelled "Looks good" that carries `decide`.
* **A cache miss is a 300 ms skeleton, never "not found".** The session socket
  can name an entity the workspace socket has not delivered yet; "Request not
  found" appears only after a completed fetch that 404s.
* **Every animated state is driven by a server event.** The library's demo,
  loop and autoplay modes are off. `src/app/chat/RunSurface.tsx` is where the
  M3 components meet the run: `LoadingState` between `run.started` and the first
  delta, showing the active step's own label; `ThinkingState` over the step rows
  with an explicit `stage` of `floor(done / total * 4)`; `ToolChips` one per
  `tool_call_id`, behind the collapsed "Done · N steps" line; `TaskRows` for the
  queue and for a run parked on a question, and nothing else. A turn that called
  no tool draws no activity at all (decision C44). Then, *below all of it*
  (decision C40), the streamed text, through `IrisText`, the same component the
  finished message uses, so `message.final` changes nothing on screen.
  `StreamingText` is not adopted. `ApprovalCard`
  carries the `choice` and `confirm` blocks `ask_for_context` produces, and
  never decides. `PromptBar` and `AgentScreen` are deliberately not adopted
  (decisions C23 and C27); eleven other components are, and "The library,
  adopted and not" below says what each one needed.
* **A screen renders the server's sentence, not its own.** The usage
  disclaimer, the provider jurisdiction warnings, the erasure timing copy and an
  effect's `reason` are all strings the Worker writes, rendered verbatim. Each
  is a claim somebody could be held to, and a claim with two authors is a claim
  that drifts. Where the client writes copy it is about the client — "this
  server does not serve traces; the client is newer than the Worker it is
  talking to" — not about the data.

## Server findings

Things the Worker did that the client had to work around, in the order they cost
the most. **All nine are now fixed on the server** (`docs/DECISIONS.md`, series
F); the "what the client does meanwhile" decisions are left in place, because
each of them is still correct — a client that treats a `run.focus` on an unseen
request as its creation is right whether or not `request.created` also arrives.

| # | Where | What was wrong | Fixed by |
|---|---|---|---|
| 1 | `apps/worker/wrangler.jsonc` `run_worker_first`, with `app.all('/w/*')` in `src/index.ts` | A navigation to `/w/:ws` got `{"reason":"unknown_route"}` instead of the app: the catch-all fired before the SPA fallback. The shell moved to `/workspace/:ws` (C12). | F1 — one catch-all that reads `Sec-Fetch-Mode`/`Accept` and serves `env.ASSETS` for a navigation. **`/w/:ws` and `/workspace/:ws` both work now**; `parseRoute` already accepted both, so nothing had to change here. |
| 2 | `apps/worker/src/engine/tools.ts` (`propose_request`) | No `request.created` was published, so a member not on the proposing session's socket learned nothing until they reloaded (C21). | F3 — the outbox row is written in the same transaction as the `requests` insert and published to the WorkspaceHub. |
| 3 | `apps/worker/wrangler.jsonc` `run_worker_first` | `/workspaces` was not in the list, so `POST /workspaces` was answered by the assets binding with **405**. | F1/F2 — `/workspaces`, `/invitations/*` and `/shared/*` added, and `POST /invitations/:token/accept` written. |
| 4 | `apps/worker/src/auth/adapters.ts`, and no step-up route | Fake auth stamped `authenticated_at` once and never moved it, so every step-up action started failing five minutes in (C24). | F4 — `GET /auth/login?step_up=1` re-stamps it in `AUTH_MODE=fake`. Dev-only, and the five-minute rule is unchanged. |
| 5 | `apps/worker/src/keys/envelope.ts` via `src/routes/keys.ts` | A missing `KEK_V{n}` was a 500 `internal` rather than a 503. | F5 — 503 `kek_unavailable`. |
| 6 | `apps/worker/src/keys/store.ts` `removeProviderKey` | Removing an already-revoked key was a 500 rather than a 409. | F5 — 409 `already_revoked`. |
| 7 | `apps/worker/src/routes/auth.ts` `authSession` | Without `?ws=` it walked `workspace_directory` and answered 404 for a seeded workspace (C18). | F7 — it answers the user's workspaces, from the `member_directory` platform table, with stream heads omitted. |
| 8 | `apps/worker/src/runs/workflow.ts` `DEV_SCRIPT` | One fixed two-turn script with no failure path, so P8 and P9 could not be driven from the client. | F6 — the turn text or an `x-scripted-script` header names a scenario. |
| 9 | `apps/worker/src/runs/receipt.ts` | The receipt block names its request as `requestId` where other blocks use `command` or `request_id`. | Unchanged on the server; the client reads all three. |

### Driving the scripted scenarios

With `MODEL_SCRIPTED=1` (which `wrangler dev` and `pnpm e2e:live` both set), a
turn can name which `ScriptedProvider` script answers it — either in the text or
with an `x-scripted-script` header:

| Name | What happens |
|---|---|
| `completed` | The ordinary two-turn script: a proposal, then a reply. The default. |
| `transient_5xx` | A provider 503 on the first attempt, then the ordinary script. P8. |
| `partial_stream` | Deltas, then the stream tears; the step retries and the run completes. P9. |
| `auth_401` | A provider 401 on the first attempt. |
| `malformed_tool` | Tool arguments that are not JSON. |
| `waiting` | The model calls `ask_for_context` for `destination` and the run parks on it; answering from Agent → Context (or from the composer) resumes it and the ordinary script runs. M3, driven from a turn. |

One caveat on the last one: the name is matched as a *substring* of the turn
text, and `waiting` is the first scenario name that is also an ordinary English
word — so "still waiting on the references" selects it. Use the
`x-scripted-script` header when that matters. The whole mechanism is refused
outside `ENVIRONMENT=development`.

```sh
# from the composer, as a person would
Screen the applicant (partial_stream).

# or explicitly
curl -X POST .../turns -H 'x-scripted-script: transient_5xx' ...
```

The name is honoured on the **first attempt only**, so a Retry is allowed to
succeed — which is what makes "a 503, then a Retry that works" one flag rather
than two. It is refused outside `ENVIRONMENT=development`.

### What M5a found, driving the rest of the routes

The nine above were found by the M3 integration. Six more came out of wiring
the remaining tabs, and they are a different kind: each one is a place where a
client screen had never been opened against a live Worker, so the mismatch was
invisible until it was. **All six are closed now** — rows 10 to 12 on the client,
rows 13 to 15 on the server (`docs/DECISIONS.md`, series G).

| # | Where | What was wrong | Where it stands |
|---|---|---|---|
| 10 | `apps/worker/src/routes/usage.ts` and `src/usage/aggregate.ts` | `GET /w/:ws/usage` takes `?range=today\|7d\|30d\|90d` and answers `{ range, timezone, from, to, disclaimer, totals, by_day, by_session, by_key, caps }`. The client asked for `?from=&to=&group=` and parsed `usageResponseSchema` — `{ group, rows, daily_token_cap, tokens_today }` — which nothing has ever served. Every call was a `contract_violation` and the Usage tab rendered its error state. | **Client fixed.** `packages/shared/src/api-m5.ts` carries `usageReportSchema`, written from the handler; the mock's fixture is the live shape too, so they cannot drift again. The server is fine — the client was reading a sketch. Decision C25. |
| 11 | the routing table in `apps/worker/src/index.ts` | There is no `POST /w/:ws/instructions`. The client offered "Propose a change" and posted to it; the catch-all answered `unknown_route`. | **Client fixed, and deliberately not by asking for the route.** An instruction version carries `run_id` and `tool_call_id`; a human-authored one with both null is a row nothing can trace. The Skills tab is review-only now. Decision C26. |
| 12 | `apps/worker/src/routes/settings.ts` `patchSettings` | Notifications are `{ notifications: { approvals, blocked, digest } }`; the client sent `{ notify_approvals: true }`, which matches no field in `WORKSPACE_FIELDS` and is silently a no-op — no Admin check, no audit row, no error. | **Client fixed, and now the server refuses it too.** The screen re-renders from the `settingsView` the PATCH returns, the tab sends the nested shape, and the route answers 422 for a key it does not store (row 13, decision G5). |
| 13 | `apps/worker/src/routes/settings.ts` `patchSettings` | Same silent no-op, from the other side: `PATCH .../settings { reduce_motion }` (the sidebar's motion toggle) touches no workspace field either. The preference is client-local and the call does nothing. | **Fixed on the server** (decision G5): an unknown key is 422 `unknown_fields` with the names in the message. The client changed with it — Reduce motion is client-local and PATCHes nothing, and row 12's Notifications tab now sends `{ notifications: { approvals \| blocked \| digest } }` and renders from the `settingsView` it gets back. |
| 14 | `apps/worker/src/model/scripted.ts` / `src/runs/workflow.ts` `DEV_SCRIPTS` | The five scenarios cover provider failures and malformed tool arguments. None of them calls `ask_for_context`, so a run parked on a context key — the state the whole Context tab exists for — cannot be produced from the client at all. | **Fixed on the server** (decision G6): a sixth scenario, `waiting`, and — the half that was a real bug — `ask_for_context` now leaves the empty `agent_context_fields` row the Context tab lists, so the parked question is reachable from the screen. `e2e/live-findings.spec.ts` G6 drives M3 from a turn with nothing inserted. Writing it found a second bug: `step.waitForEvent` was called without `options.type`, so **no parked run could ever be woken** by either answer route (decision G8). |
| 15 | `apps/worker/src/routes/turns.ts`, `queueMessage` (line ~471) and `stopRun` (line ~344) | A read-then-write race between Stop and Queue. `queueMessage` reads `run.status` and inserts `paused` if the run is stopping, `queued` otherwise; `stopRun` does `UPDATE run_queue SET status='paused' ... WHERE status='queued'`. Nothing serialises the two, so an enqueue that read `working` before Stop committed inserts a `queued` row *after* Stop's sweep has run, and it stays `queued` — a queue item that will never be sent and is not shown as paused either. | **Fixed on the server** (decision G7): `loadRun` takes `SELECT ... FOR UPDATE`, so every control serialises on the `runs` row. `test/db/turns.test.ts` fires Stop and Queue together twenty times in both orders and fails reliably with the two words removed. P7 is deterministic; the live suite ran five times in a row without a flake. |

### Read routes, and the screens on them

`GET /w/:ws/traces`, `GET /w/:ws/traces/:runId`, `GET|POST /w/:ws/skills`,
`GET /w/:ws/instructions` with `accept`/`discard`, and
`GET|PATCH /w/:ws/context-fields` all exist, so the Agent tab's panes render
real rows. The trace detail carries the run's tool calls and their results (with
the 8 KB truncation marker intact, and shown truncated), the URLs `fetch_url`
retrieved, the focus history and the allowed-tools line.

One hazard that cost three bugs and is worth naming: **a list route and a detail
route that answer the same entity kind with different completeness**. `GET
/w/:ws/traces` fills `steps` and omits `tool_calls`, `fetched_urls` and `focus`;
the client's cache is keyed on id and cannot tell the two apart, so opening a
trace from the Traces tab found the list's half-row and rendered "This run
called no tools" for a run that had called one. `TraceDetail` forces one fetch
per trace opened, and three lists are invalidated by the events that change them.
Decision C28.

`e2e/live-findings.spec.ts` and `e2e/live-m5a.spec.ts` are the suites that drive
all of this — seven and eleven scenarios on top of the fourteen in
`live.spec.ts` — and `pnpm e2e:live` runs all of them plus the screenshots.

### The live scenarios

| Suite | What it drives |
|---|---|
| `live.spec.ts` | P4 two contexts racing one decision · P5 the Member seat · P6 guidance mid-run · P7 Stop · P8 Retry · P10 a dropped connection replaying · P11 the provider-key lifecycle · P13 the first-run empty states, both seats · P14 a proposal that decides nothing |
| `live-findings.spec.ts` | F1 `/w/:ws` boots the app · F2 create a workspace, accept an invitation · F3 `request.created` on the workspace stream · F8 Traces lists and opens a run · P8/P9 through the scripted scenarios |
| `live-m5a.spec.ts` | M1 the trace detail after a run · M2 an instruction accepted by an Admin and refused to a Member · M3 the context write that unparks a waiting run · M4 usage after a run, with the server's disclaimer · M5 create-workspace and accept-invite through the stepper, plus the picker · M6 workspace delete and undelete · M7 every empty state on a fresh workspace, both seats · M8 "Signed out" with the draft kept, and "Reconnecting…" |
| `live-screens.spec.ts` | the twenty-nine screenshots in `qa/live/` |
| `live-tables.spec.ts` | the four list screens in `qa/tables/` — Members and its Invitations tab, the Inbox list, Library → Documents, Traces — and the assertions that no column header, no "Evidence" and no sidebar headcount survive (decisions C46, C47) |
| `live-transcript.spec.ts` | T1 the send-scroll, measured frame by frame inside the page · T2 thirteen gap samples across a run · T3 a scroll-up mid-run that holds, with the chip · T4 clearance against the composer at its tallest · T5 one collapsed "Done · N steps" line above the answer, expandable, and no "Thinking" row · T6 the second question anchors like the first · T7 a refused turn's sentence, its draft and its unchanged title |
| `live-panel.spec.ts` | N1 ⌘L and where focus goes · N2 the drag handle, its clamp and its reload · N3 a run that completes behind the rail, and the badge · N4 every page in the rail state · N5 New session twice is one session · N6 the first turn names the session and the run renames it · N7 a manual rename wins · N8 the navigation keeps its column at 900 and 1100 |

### The library, adopted and not

Ten of the twenty-one components are in the product, each given real rows and
real callbacks:

| Component | Where | The care it needed |
|---|---|---|
| `LoadingState`, `ThinkingState`, `ToolChips`, `TaskRows`, `ApprovalCard` | `chat/RunSurface.tsx` | driven only by server events; demo, loop and autoplay off; and every content prop passed explicitly, because fifteen of the twenty-one default theirs to a gallery fixture (decision C42) |
| `DiffTable` | Skills, over an instruction proposal | the server accepts or discards a whole version, so the only toggle offered is the addition and Save *is* Accept |
| `Flowchart`, `CodeBlock` | the trace detail | read-only: no `onMove`, no `onSelect`, no `condition`. Node ids are the array index, because the engine reuses `provider` for every model call |
| `ContextCards` | the URLs a run fetched | one chunk per URL, badged `untrusted`, which is what a fetched page is |
| `RecommendationCard` | the Agent Overview | the meter is a count, not a confidence: three bars is complete evidence, two is evidence with named gaps. `onConfirm` navigates and nothing else |
| `FilterTable` | History | two axes, deliberately: the tabs pick the kind of activity, the table's filter picks the state |
| `InsightCards` | Settings → Usage | the carousel only: the library exports it and not the three cards it ships with, and the package publishes no subpath. The charts are drawn from `by_day` and `by_key` |
| `FineTuneCard` | Settings → Agents, the two integer caps | `onChange` fires per pointer move, so the write is debounced to one per gesture — which is also one `settings.changed` audit row per gesture |
| `SelectionActions` | a selected invoice line | `onRequestEdit` is supplied and never reaches a model: without it the component streams its own demo rewrite, and a fabricated sentence on an invoice is the one thing this product must not do |

Four are not adopted, and the reasons are the same shape:

* **`RecordsTable`** was adopted over Members and has been taken back out
  (decision C46). It is a database surface: a selection checkbox column, "Add
  calculation", a horizontal scroller, a count footer, and an **Evidence**
  header — from its own fixture columns — standing over a column about
  colleagues. Nobody sorts, pins or computes over a membership list, so every
  control on it was cost with no use. Members is the shell's own `.list-row`
  again, like the Inbox list, Library → Documents and Traces, which were never
  anything else.


* **`StreamingText`** re-animates on its own timer text the server already sent,
  cannot render a list or a table, and owns an action row and a "3 sources"
  disclosure that duplicate `ResponseFooter` and claim things the run did not do
  — which is how a reply to "testing" came to offer "Show the application
  evidence" (decision C41).

* **`PromptBar`** owns its draft in its own `useState` and exposes no controlled
  `value`, so a composer built on it could not render a restored draft — and
  "your draft is saved" would become a sentence the product does not keep
  (decision C23).
* **`AgentScreen`** ships a "Teach a loop" control whose own copy says "Capture
  is simulated in this showcase". On the one screen whose entire purpose is that
  what it shows happened, a button that claims to record and records nothing is
  the stub-with-a-green-tick this codebase refuses everywhere else. There is no
  prop that removes it (decision C27).
