# `apps/client`

The workspace client: React 19, Motion 13, TypeScript strict, bundled by esbuild
into `dist/`, which the Worker's Static Assets binding serves with an SPA
fallback and `run_worker_first` on the API prefixes.

It runs against the real Worker. `pnpm e2e:live` boots Docker Postgres, the
migrations, `wrangler dev --local` with `AUTH_MODE=fake` and `MODEL_SCRIPTED=1`,
and drives thirty-two scenarios through the live stack; `qa/live/` holds the
twenty-nine screenshots that run produced.

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
pnpm db:reset                   # (root) demo database back to the seed — destructive
pnpm --filter client dev:step-up  # re-stamp the fake-auth step-up window
```

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
| `/?data=empty&key=none` | Every first-run empty state, and the composer greyed with "Add a provider key in Settings to start" |
| `/?seat=member` | The Member seat: the review pane reads "Admin decision required" |
| `/?key=invalid` | A rejected key: "Your deepseek key was rejected. Re-verify or rotate it" |
| `/onboarding/create`, `/onboarding/join?token=…` | The two onboarding routes |
| `/shared/mock-share-token` | The read-only share viewer |

`__MOCK__` is a build constant, so a production build eliminates the module, the
build deletes the orphan chunk esbuild still emits for the folded dynamic
import, and it greps `dist/app.js` for `x-dev-user` to prove the dev account
switcher is gone with it.

## Layout

```
src/model/    store.ts      the reducer, the entity cache, the two cursors
              adapter.ts    the one object components talk to
              rest.ts       the typed REST client; one policy, one route table
              hub.ts        the two sockets: ping, silence, replay-then-buffer
              auth.ts       the workos / fake seam and the step-up intent
              routes.ts     parseRoute / toHref over refs.ts
              mock.ts       the mock backend (MOCK=1 only)
src/app/      Shell, Sidebar, chat/, views/, onboarding/, shared/, ui/
e2e/          scenarios.spec.ts   P1–P3, against the mock bundle
              qa-screens.spec.ts  the mock screenshots
              live.spec.ts        P4–P14, against wrangler dev
              live-findings.spec.ts the scenarios the server fixes unblocked
              live-m5a.spec.ts    M1–M8: the tabs that got routes, and the
                                  flows that got them second
              live-screens.spec.ts the live screenshots
              live-panel.spec.ts  N1–N7: the panel's three states and the
                                  sessions list, against the live stack
              panel-screens.spec.ts every page × three panel states × two widths
              panel-sidebar.spec.ts the sidebar's list, before and after C34
              panel-narrow.spec.ts  900 and 1100 in all three states: the
                                  navigation keeps its own column
              panel-helpers.ts    the assertions the panel suites share
scripts/      e2e-live.mjs      boots the stack and runs the live suite
              live-fixture.mjs  a fresh workspace, and the step-up re-stamp
              dev-step-up.mjs   the step-up re-stamp on its own
qa/           one screenshot per screen, from e2e/qa-screens.spec.ts
qa/live/      the same screens against the real Worker
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
  `tool_call_id`; `StreamingText` over the accumulator `message.delta` fills;
  `TaskRows` for the queue and the waiting and failed states. `ApprovalCard`
  carries the `choice` and `confirm` blocks `ask_for_context` produces, and
  never decides. `PromptBar` and `AgentScreen` are deliberately not adopted
  (decisions C23 and C27); eleven other components are, and "The library,
  adopted and not" below says what each one needed.
* **A screen renders the server's sentence, not its own.** The usage
  disclaimer, the DeepSeek jurisdiction warning, the erasure timing copy and an
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
| `live-panel.spec.ts` | N1 ⌘L and where focus goes · N2 the drag handle, its clamp and its reload · N3 a run that completes behind the rail, and the badge · N4 every page in the rail state · N5 New session twice is one session · N6 the first turn names the session and the run renames it · N7 a manual rename wins · N8 the navigation keeps its column at 900 and 1100 |

### The library, adopted and not

Eleven of the twenty-one components are in the product, each given real rows and
real callbacks:

| Component | Where | The care it needed |
|---|---|---|
| `LoadingState`, `ThinkingState`, `StreamingText`, `ToolChips`, `TaskRows`, `ApprovalCard` | `chat/RunSurface.tsx` | driven only by server events; demo, loop and autoplay off |
| `DiffTable` | Skills, over an instruction proposal | the server accepts or discards a whole version, so the only toggle offered is the addition and Save *is* Accept |
| `Flowchart`, `CodeBlock` | the trace detail | read-only: no `onMove`, no `onSelect`, no `condition`. Node ids are the array index, because the engine reuses `provider` for every model call |
| `ContextCards` | the URLs a run fetched | one chunk per URL, badged `untrusted`, which is what a fetched page is |
| `RecommendationCard` | the Agent Overview | the meter is a count, not a confidence: three bars is complete evidence, two is evidence with named gaps. `onConfirm` navigates and nothing else |
| `FilterTable` | History | two axes, deliberately: the tabs pick the kind of activity, the table's filter picks the state |
| `RecordsTable` | Members | no `onCalculate` — there is no route that would answer one — and `reviewGap` is filled with the member's recorded reviewer roles, so the optional column shows a real fact |
| `InsightCards` | Settings → Usage | the carousel only: the library exports it and not the three cards it ships with, and the package publishes no subpath. The charts are drawn from `by_day` and `by_key` |
| `FineTuneCard` | Settings → Agents, the two integer caps | `onChange` fires per pointer move, so the write is debounced to one per gesture — which is also one `settings.changed` audit row per gesture |
| `SelectionActions` | a selected invoice line | `onRequestEdit` is supplied and never reaches a model: without it the component streams its own demo rewrite, and a fabricated sentence on an invoice is the one thing this product must not do |

Two are not adopted, and the reasons are the same shape:

* **`PromptBar`** owns its draft in its own `useState` and exposes no controlled
  `value`, so a composer built on it could not render a restored draft — and
  "your draft is saved" would become a sentence the product does not keep
  (decision C23).
* **`AgentScreen`** ships a "Teach a loop" control whose own copy says "Capture
  is simulated in this showcase". On the one screen whose entire purpose is that
  what it shows happened, a button that claims to record and records nothing is
  the stub-with-a-green-tick this codebase refuses everywhere else. There is no
  prop that removes it (decision C27).
