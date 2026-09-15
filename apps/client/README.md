# `apps/client`

The workspace client: React 19, Motion 13, TypeScript strict, bundled by esbuild
into `dist/`, which the Worker's Static Assets binding serves with an SPA
fallback and `run_worker_first` on the API prefixes.

It runs against the real Worker. `pnpm e2e:live` boots Docker Postgres, the
migrations, `wrangler dev --local` with `AUTH_MODE=fake` and `MODEL_SCRIPTED=1`,
and drives fourteen scenarios through the live stack; `qa/live/` holds the
screenshots that run produced.

There is no framework and no router. Routing is `src/model/routes.ts`: two pure
functions over `packages/shared/refs.ts`, so the URL and `sameRef` are driven by
the same keys and a new ref key cannot be forgotten in one of them. The shell's
own path prefix is `/workspace/:ws`, not `/w/:ws`, because `/w/*` is
worker-first and its catch-all answers JSON — see "Server findings" below and
decision C12.

## Commands

```sh
pnpm --filter client build      # production bundle into dist/
pnpm --filter client dev        # esbuild watch + a static server on 127.0.0.1:4180
pnpm --filter client test       # vitest: the reducer and the adapter
pnpm --filter client typecheck
pnpm --filter client e2e        # Playwright, against the mock bundle
pnpm e2e:live                   # the whole stack, then the live scenarios
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
key can be added — without one the route answers 500. `wrangler` only reads
`.dev.vars` at startup, so restart it after adding one.

Two things behave differently under fake auth, both of them the Worker's shape
rather than a client choice, and both recorded as decisions C16 and C24:

* the hub sockets are refused, because fake auth is a header and a browser
  cannot put a header on a WebSocket handshake. The client falls back to polling
  the same replay route, with the same cursor and the same ordering, so
  everything works — it is just a little slower. Playwright can set the header,
  so the live suite exercises the socket path.
* there is no step-up route, and `authenticated_at` is stamped once and never
  moved, so decisions and provider-key changes start answering `reauth_required`
  five minutes after a dev workspace is first opened.
  `pnpm --filter client dev:step-up` re-stamps it.

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
              live-screens.spec.ts the live screenshots
scripts/      e2e-live.mjs      boots the stack and runs the live suite
              live-fixture.mjs  a fresh workspace, and the step-up re-stamp
              dev-step-up.mjs   the step-up re-stamp on its own
qa/           one screenshot per screen, from e2e/qa-screens.spec.ts
qa/live/      the same screens against the real Worker
```

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
  never decides. `PromptBar` is deliberately not adopted (decision C23).

## Server findings

Things the Worker does that the client had to work around, in the order they
cost the most. Each one is a small fix on the server side, and each has a
decision explaining what the client does meanwhile.

| # | Where | What is wrong |
|---|---|---|
| 1 | `apps/worker/wrangler.jsonc` `run_worker_first`, with `app.all('/w/*')` in `src/index.ts` | A navigation to `/w/:ws` gets `{"reason":"unknown_route"}` instead of the app: the catch-all fires before the SPA fallback. The shell moved to `/workspace/:ws` (C12). Fix: answer the catch-all from `env.ASSETS` for navigation requests. |
| 2 | `apps/worker/src/engine/tools.ts` (`propose_request`) | No `request.created` is published. `stream_events` for the seeded workspace holds 24 `run.focus` rows and zero `request.created`. A member who is not on the proposing session's socket learns nothing until they reload (C21). |
| 3 | `apps/worker/wrangler.jsonc` `run_worker_first` | `/workspaces` is not in the list, so `POST /workspaces` is answered by the assets binding with **405** and the create-workspace route is unreachable. The live suite writes the rows directly instead (`scripts/live-fixture.mjs`). Fix: add `/workspaces` to the list. |
| 4 | `apps/worker/src/auth/adapters.ts`, and no `/auth/dev/step-up` | Fake auth stamps `authenticated_at` once and never moves it, and there is no route that can. Every step-up action starts failing five minutes in (C24). |
| 5 | `apps/worker/src/keys/envelope.ts` via `src/routes/keys.ts` | A missing `KEK_V{n}` raises `KeyCryptoError`, which `app.onError` does not handle, so adding a provider key is a 500 with `reason: "internal"` rather than a 503 `not_configured`. `.dev.vars.example` ships `KEK_V1=""`, so a fresh checkout hits this. |
| 6 | `apps/worker/src/keys/store.ts` `removeProviderKey` | Removing an already-revoked key throws `KeyStoreError`, also unhandled by `app.onError`: a double-click on Remove is a 500 rather than a 409. |
| 7 | `apps/worker/src/routes/auth.ts` `authSession` | Without `?ws=` it walks `workspace_directory`, which only the WorkOS mirror writes, so a seeded development workspace answers 404 `no_workspace`. The client always passes `?ws=` (C18). |
| 8 | `apps/worker/src/runs/workflow.ts` `DEV_SCRIPT` | `MODEL_SCRIPTED=1` is one fixed two-turn script with no failure path, so the spec's P8 (provider 5xx then retry) and P9 (a tear at 40 %) cannot be driven from the client at all. `SCRIPTS` in `src/model/scripted.ts` already has both; only the selection is missing. |
| 9 | `apps/worker/src/runs/receipt.ts` | The receipt block names its request as `requestId`, where the contract's other blocks use a `command` or `request_id`. The client reads all three. |
