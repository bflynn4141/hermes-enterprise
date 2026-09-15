# `apps/client`

The workspace client: React 19, Motion 13, TypeScript strict, bundled by esbuild
into `dist/`, which the Worker's Static Assets binding serves with an SPA
fallback and `run_worker_first` on the API prefixes.

There is no framework and no router. Routing is `src/model/routes.ts`: two pure
functions over `packages/shared/refs.ts`, so the URL and `sameRef` are driven by
the same keys and a new ref key cannot be forgotten in one of them.

## Commands

```sh
pnpm --filter client build      # production bundle into dist/
pnpm --filter client dev        # esbuild watch + a static server on 127.0.0.1:4180
pnpm --filter client test       # vitest: the reducer and the adapter
pnpm --filter client typecheck
pnpm --filter client e2e        # Playwright, against the mock bundle
```

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
qa/           one screenshot per screen, from e2e/qa-screens.spec.ts
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
  loop and autoplay modes are off: `StreamingText` renders the accumulator that
  `message.delta` fills, `LoadingState` shows the active step's own label, and
  `ThinkingState` maps stages proportionally over the run's real steps.
