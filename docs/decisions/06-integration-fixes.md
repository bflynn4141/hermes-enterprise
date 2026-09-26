# Integration fixes and hardening

Integration decisions F1 through F8, client decisions C25 through C34a, and hardening decisions G1 through G9.

[Back to the decision index](../DECISIONS.md).

## F1. The catch-all reads the request, not the path

**Found by the client.** `app.all('/w/*')` answered `{"reason":"unknown_route"}`
to a browser navigating to `/w/:ws`, because `/w/*` is `run_worker_first` and the
catch-all fired before the assets binding's SPA fallback could. The shell moved
to `/workspace/:ws` to get out of the way (decision C12).

**Decided.** One catch-all, `app.all('*')`, that asks what the *request* wants
rather than what the path looks like (`src/routes/spa.ts`):

* `Sec-Fetch-Mode: navigate` on a GET or HEAD is a navigation, and gets
  `index.html` from `env.ASSETS`;
* without Fetch Metadata, `Accept` decides, and the *order* decides: `text/html`
  before `application/json` is a page, the other way round is data;
* anything else — every POST, every `fetch()`, anything under `/api/` — still
  gets `{"reason":"unknown_route"}` as JSON. A client that asked for data is
  never handed HTML, which is the property the old catch-all was protecting and
  the reason it is still there in spirit.

`/api/*` is exempt from the navigation branch on purpose: that prefix means
"data", and a person who typed an API URL into the address bar is better served
by the 404 than by the shell.

**What this means for the client.** `/w/:ws` now works. `/workspace/:ws` also
still works and nothing has to change — `parseRoute` already accepted both — so
this is a fix the client can adopt at its leisure rather than a migration.

**Also fixed here.** `run_worker_first` now lists `/workspaces`,
`/invitations/*` and `/shared/*` alongside the four prefixes it had. A Worker
route that is not in that list is not a broken route, it is an *absent* one: the
assets binding answers first, and a POST to a static asset is 405.

---

## F2. Two routes have no tenant in their path, and the second one is new

**Found by the client.** `POST /workspaces` was answered by the assets binding
with 405, so the create-workspace flow was unreachable and the live suite wrote
the rows directly (`scripts/live-fixture.mjs`). Accepting an invitation had no
route at all: the client sent people to `/auth/login?invitation_token=…`, which
is a 503 in `AUTH_MODE=fake`.

**Decided.** `POST /invitations/:token/accept` (`src/routes/invitations.ts`),
alongside `POST /workspaces`, with the run-worker-first entries that make both
reachable. The accept route:

* takes the token as *which invitation*, never as *who*. The signed-in session
  says who, and the two have to agree — the person's email must be the address
  the invitation was sent to — because a forwarded link would otherwise admit
  whoever received it;
* mirrors the membership through `mirrorMembership`, the same function
  `/auth/callback` and the WorkOS events poller use, so a membership that
  arrives by any of the three routes is one shape of row and flips the
  invitation to `accepted` the same way;
* answers with the whole bootstrap, from inside the transaction that admitted
  them, so there is no window in which they are a member of a workspace that
  reads as missing;
* answers one thing — 404 `invitation_unavailable` — for unknown, withdrawn,
  accepted and expired alike. Which of the four it is tells a guesser
  something and tells the holder of a real link nothing they can act on.

**The tenant problem, and the third platform table.** The route cannot set a
tenant key until it knows which workspace, and `invitations` is a tenant table
under forced row-level security. This is the same shape of question as "which
workspace is WorkOS organization X?", so it gets the same answer 0008 gave:
`invitation_directory`, a platform table holding a token, an invitation id and a
workspace id, maintained by a trigger on `invitations` rather than by the routes
— because three code paths write invitations and a fourth will exist by the time
anyone reads this. A row disappears the moment the invitation stops being
`pending`, so a forwarded link stops resolving when it stops being an invitation.

---

## F3. `propose_request` publishes `request.created`, in the insert's transaction

**Found by the client.** The engine wrote the `requests` row and published
`run.focus` and nothing else: the seeded workspace held 24 `run.focus` rows and
zero `request.created`. The client worked around it by treating a focus on an
unseen request as its creation (decision C21), which fixes the proposing
session's own pane and fixes nothing for anybody else — `run.focus` is
session-scoped, and another member is not on that socket.

**Decided.** `PgAgentDb.proposeRequest` writes the `request.created` outbox row
in the *same transaction* as the `requests` insert, and returns it; the tool
passes it back as `ToolOutcome.published`; the engine hands it to the
WorkspaceHub after the turn's session events. A note does the same with
`entity.updated`. Three consequences worth stating:

* **the same transaction, not "afterwards".** Emitting after the insert has a
  window in which the request exists and no event says so, and a crash inside
  that window leaves a request nobody is told about until they reload. That is
  the exact failure this decision is about, so it is not reintroduced one layer
  down;
* **a replayed step publishes nothing.** `ON CONFLICT DO NOTHING` already made
  the insert idempotent; the event is written only on the branch that inserted,
  so a Workflow step that ran twice produces one request and one event;
* **the publish is still best-effort.** A lost RPC costs a reconnect, not the
  event: the row is committed and `GET /w/:ws/events?after=` replays it. That is
  decision 40 unchanged.

**The trigger, and why it was widened rather than bypassed.** Migration 0005
refused every kind outside `message.*` and `run.*` from the `agent` role, which
is the right default and is what stops a tool publishing `decision.recorded`.
The alternative to widening it was to publish through the `app`-role Cron drain,
which would have made a proposal visible up to a minute after it was made — the
symptom this decision exists to remove.

So 0013 widens it by a predicate rather than by a kind:
`stream_events_agent_may_publish` allows `request.created` and
`entity.updated` **only when the payload names a `requests` row, in this
workspace, that carries a `run_id`** — and `run_id` is set by nothing but
`proposeRequest`. A tool cannot forge an event about a request it did not
create, and it still cannot publish `decision.recorded` at all.

**The decision invariant is untouched.** `request.created` says a proposal
exists and is `pending`. `pending` is the state the guarded decision route is
the only thing that can move a request out of (CONVENTIONS invariant 1), and
nothing in this change gives the agent role a way to write `decisions` or to
move a status. A test asserts the trigger still refuses an event about a
`requests` row a human made.

---

## F4. Fake mode has a step-up, and it is the clock rather than the rule

**Found by the client.** `auth_sessions.authenticated_at` is written once, on
the INSERT for `sid = dev-<user id>`, and nothing moved it. Five minutes after a
dev workspace was first opened, every decision and every provider-key route
answered `reauth_required` for ever; the client could only challenge in place
(decision C24) and a script re-stamped the row by hand.

**Decided.** `GET /auth/login?step_up=1` re-stamps the row when
`AUTH_MODE === 'fake'`, then redirects to `return_to` — which is exactly what
`/auth/callback` does in the real flow, and exactly what
`scripts/dev-step-up.mjs` was doing from outside.

**Dev-only, twice.** The branch is behind `AUTH_MODE === 'fake'`, which
`authAdapter` refuses outside development, and behind a second `isDevelopment`
check that answers 503 `not_configured` otherwise. It also goes through the
ordinary `getSession`, so a missing or unknown `x-dev-user` is a 401 here as
everywhere else, and `return_to` goes through `safeReturnPath`, so it cannot be
used as an open redirect.

**The five-minute rule is unchanged.** This moves the clock the rule reads. It
does not widen the window, and `requireStepUp` is not touched.

---

## F5. A known condition is never a 500

**Found by the client.** A missing `KEK_V{n}` raised `KeyCryptoError`, which
`app.onError` did not handle, so adding a provider key on a fresh checkout — and
`.dev.vars.example` ships `KEK_V1=""` — was a 500 with `reason: "internal"`.
Removing an already-revoked key was the same: a double-click on Remove was a
500 rather than a 409.

**Decided.** Four more branches in `app.onError`, in this order:

| Thrown | Answer | Why that one |
|---|---|---|
| `KeyCryptoError` `kek_missing` / `kek_version_unknown` / `kek_malformed` | 503 `kek_unavailable` | The deployment cannot encrypt anything until someone sets a secret. That is a configuration failure, and 503 is what says "not now" rather than "you broke it". |
| `KeyCryptoError` `plaintext_empty` | 422 | The request is wrong, and it is the caller's to fix. |
| `KeyCryptoError` `decrypt_failed` | still 500 | The key material is present and did not authenticate. Nothing about that is expected, and pretending it is would hide it. |
| `KeyStoreError` `already_revoked` / `duplicate_key` | 409 | "That already happened" is not an error the caller has to recover from. |
| `KeyStoreError` `not_found` | 404 | |
| any thrown error carrying a numeric `status` and a string `reason` | that status | An error that named its own status has already decided how it should be answered; mapping it to 500 here loses that on the way out, which is the whole failure this block exists to stop. |

`RouteError` gained `503` as an allowed status for the same reason: some
conditions are a property of the deployment rather than of the request.

---

## F6. `MODEL_SCRIPTED` takes a scenario name

**Found by the client.** `MODEL_SCRIPTED=1` was one fixed two-turn script with
no failure path, so the spec's P8 (a provider 5xx, then a Retry) and P9 (a tear
at 40 percent) could not be driven from the client at all — the scripts already
existed in `src/model/scripted.ts`, only the selection was missing.

**Decided.** `DEV_SCRIPTS` in `src/runs/workflow.ts` names five scenarios —
`completed`, `transient_5xx`, `partial_stream`, `auth_401`, `malformed_tool` —
and each one is *the failure followed by the ordinary script*, so a scenario
reads as "this goes wrong, then the run does what it always does".
`pickDevScript` takes an `x-scripted-script` header first and the turn's own
text second, because the point is to drive a scenario from the composer a person
is typing into: "Screen the applicant (partial_stream)" is a sentence and a
selection at once. An unrecognised name is not an error — it is prose that
happens to contain an underscore — so it falls back to the ordinary script.

**Honoured on the first attempt only.** A Retry is the second half of the P8
scenario and has to be allowed to succeed, so `RunAttempt` ignores the flag when
`attempt > 1`. One flag, two attempts, the scenario the spec describes.

**Still dev-only.** `MODEL_SCRIPTED=1` is itself refused outside
`ENVIRONMENT=development` (decision 47), and the selection is read only when it
is set — so no deployed environment can be asked for a scripted failure by
header.

---

## F7. `GET /auth/session` with no `?ws` answers the question instead of 404

**Found by the client.** Without `?ws=` the route walked `workspace_directory`,
which only the WorkOS mirror writes, so a seeded or locally created workspace
was invisible and a plainly-a-member account got 404 `no_workspace`. The client
learned to always pass `?ws=` (decision C18), which works and means the client
has to already know the answer.

**Decided.** The route answers with the user and their workspaces —
`authWorkspacesSchema`, a separate shape from `authSessionSchema` because the
two answers mean different things. It carries no stream heads and no hub ticket:
both are per-workspace, and minting a ticket for a workspace the caller has not
chosen would hand out an authorisation nobody asked for. The client picks one
and asks again by id, which is what it already does.

**The fourth platform table.** `members` is a tenant table under forced
row-level security and all three roles are `NOBYPASSRLS`, so "which workspaces
is this person in?" cannot be asked by any connection in this system — which is
the property the product is built on, not an obstacle to route around. A
`SECURITY DEFINER` function does not help: FORCE applies to the owner too.

So it gets the answer 0008 gave the other two cross-tenant questions:
`member_directory`, holding a user id, a workspace id, a role and a display
name, outside row-level security, **maintained by a trigger on `members`**. The
trigger rather than the routes, because `mirrorMembership`, `revokeAccess` and
the events poller all move that table and a mirror three code paths write is a
mirror one of them will forget. A second trigger on `workspaces` carries a
rename across. A membership that is not `active` loses its row, so the switcher
cannot offer a workspace the person has been removed from.

What a leak of it tells an attacker is which workspaces exist and who is in
them — ids, a role and a name, no applicant text, no payload. That is the price
0008 already paid for `job_ready`, stated again here rather than assumed.

`scripts/seed-dev.mjs` now upserts its members rather than `DO NOTHING`, because
the trigger fires on a write and a re-seed that wrote nothing would leave the
seeded workspace out of the switcher.

---

## F8. The Agent tab's read routes

**Found by the client.** `traces`, `skills`, `instructions` and `context-fields`
were in the client's route table and not in the Worker's, so every one of them
rendered "Not available yet" through `rest.optional()` (decision C19).

**Decided.** `src/routes/traces.ts` and `src/routes/agent-config.ts`, all under
`inWorkspace` with the `app` role like every other tenant route. Four things
worth recording:

* **A trace is a run, read back, and it is not new authority.** Every row it
  shows is already readable by a member through `messages`, `requests` or the
  replay stream; the point of the trace is that they are visible *together*, in
  one order, so a reader can see what the agent read before it proposed
  something. Opening one advances nothing and decides nothing.
* **A tool result is shown exactly as the model saw it**, 8 KB truncation marker
  and all. A trace that quietly re-expanded a truncated result would be a trace
  of a run that did not happen.
* **Saving an instruction version is Admin-only, and so is discarding one.**
  Saving changes what every future run is told to do, which is the same class of
  change as a provider key. Discarding is Admin-only for the duller reason that
  a Member silently dropping a proposal an Admin has not read is a change nobody
  can see afterwards. A second click on either is a 409, not a silent success.
* **`PATCH /w/:ws/context-fields/:field` is the human half of
  `ask_for_context`.** It writes the same row `POST .../runs/:runId/context`
  writes and then wakes the same Workflow, with the same ordering: the row
  commits inside the tenant transaction and only then is the run told, because a
  run woken before the commit would read the old value. Several sessions can be
  parked on one key, so it wakes all of them, and a lost wake-up costs latency
  rather than the answer — the engine's wait has its own timeout.

Both spellings of the two write routes are registered — `/instructions/:id/accept`
and `/instructions/:id/save`, `/skills` and `/skills/:id/adopt` — because the
client-port spec and the client's own route table disagree about the verb and
neither is wrong. They are the same handler; there is no second behaviour to
keep in step.

The shapes are `packages/shared`'s, extended additively:
`traceEntitySchema` gained `mode`, `model_id`, `active_ms`, `step_count`,
`tool_calls`, `fetched_urls` and `focus`, all optional, so a client that ignores
them still parses and a client that wants them does not need a second schema.

---

## C25. The usage screen was parsing a shape nobody served

**Decided.** `packages/shared/src/api-m5.ts` is new and carries
`usageReportSchema`, `settingsViewSchema`, `dataPrivacySchema`,
`attestationResultSchema`, `workspaceDeletionSchema` and `undeleteResultSchema`
— each written from the Worker's handler rather than from the client-port
spec's sketch. `rest.usage` now calls `GET /w/:ws/usage?range=` and parses
`usageReportSchema`.

**Why.** `entities.ts` has carried a `usageResponseSchema` since M2:
`{ group, from, to, rows, daily_token_cap, tokens_today }`. The route answers
`{ range, timezone, from, to, disclaimer, totals, by_day, by_session, by_key,
caps }`, and takes `?range=`, not `?from=&to=&group=`. Nothing had ever put the
two together, because the only producer of the old shape was `mock.ts` and the
only consumer was a screen that had never been opened against a live Worker. The
client's own rule — nothing unvalidated reaches the reducer — did its job and
turned every call into `contract_violation`, which the Usage tab rendered as its
error state. So the screen was not broken subtly; it was broken completely, and
quietly, on a path no test walked.

Three consequences, in order of how much they matter:

* the mock's fixture is now the live shape too, so the two cannot drift again
  without the mock suite failing;
* `usageResponseSchema` is left exported and untouched. It is additive-only
  policy: something outside this repository may be reading it, and deleting a
  published schema to fix a client is a second breakage;
* `disclaimer` is rendered beside the total, not in a footnote, because
  `src/usage/aggregate.ts` says so and because the sentence is a claim about
  whose arithmetic the number is. A client that wrote its own version of it
  would be a client making that claim on its own authority.

**Would change it if.** The two shapes are reconciled upstream. The honest fix
is one schema in `packages/shared` that both sides import, which is what
`api-m5.ts` is for the four routes it covers.

---

## C26. There is no "propose an instruction" button, because there is no route

**Decided.** `rest.proposeInstruction` is gone, and so is the composer for it on
the Skills tab. What is left is review: a proposal a run wrote, its provenance,
Accept and Discard — both Admin-only — and an empty state that says where a
proposal comes from.

**Why.** The client used to `POST /w/:ws/instructions`. The Worker's routing
table has `/instructions` (GET), `/instructions/:id/accept`, `/save`,
`/discard` and the DELETE, and nothing that creates a version; the catch-all
answered `unknown_route`, so the button could only ever have 404ed. It had
never been pressed against a live Worker.

Restoring it would mean asking for a route, and the route is the wrong thing to
ask for: an instruction version is written by the engine, with a `run_id` and a
`tool_call_id` that say which run proposed it and why, and `instruction_versions`
is shaped around that. A human-authored version with both columns null is a row
that can never be traced back to anything. The reviewable artefact is the
proposal; the thing a person does to it is decide.

**Would change it if.** A written-by-a-person instruction is wanted as a
first-class thing, in which case it needs its own provenance (`written by`,
not `proposed by a run`) and the list has to distinguish them. The schema
already has `provenance` for exactly that.

---

## C27. `AgentScreen` is not adopted, for the same reason as `PromptBar`

**Decided.** Six more library components are adopted in M5a — `DiffTable` over
an instruction proposal, `Flowchart` and `CodeBlock` on the trace detail,
`ContextCards` over the URLs a run fetched, `RecommendationCard` over what needs
a reviewer next, `FilterTable` over History, `RecordsTable` over Members,
`FineTuneCard` over the two integer caps and `SelectionActions` over a selected
invoice line. `AgentScreen` is not, and `PromptBar` still is not (C23, which is
unchanged: it owns its draft in its own `useState` and exposes no controlled
`value`).

**Why.** `AgentScreen` ships a "Teach a loop" control whose own copy says
"Capture is simulated in this showcase". In a gallery that is honest. In a
product it is a button that claims to record a demonstration and records
nothing, on the one screen whose entire purpose is that what it shows happened.
There is no prop that removes it. Adopting it would mean putting a stub with a
green tick next to a trace, which is the thing this codebase refuses everywhere
else (CONVENTIONS, invariant 5).

Three of the adoptions needed the same care, and got it rather than being
skipped:

* **`SelectionActions`** streams its own demo rewrite when `onRequestEdit` is
  absent. It is supplied, and it never reaches a model: both actions compose
  their text locally from the line the person clicked. Keeping the draft puts it
  in the composer, where a person still presses send.
* **`RecordsTable`** — *superseded by C46: it is out of the product.* Its
  optional calculation column fabricates
  `row.reviewGap ?? "Not assessed"` when `onCalculate` is absent. `onCalculate`
  is *not* supplied — there is no route that would answer one — and `reviewGap`
  is filled with a real fact the workspace holds: the member's recorded reviewer
  roles. With no model wired the library labels the control "Preview sample
  results", which is true.
* **`InsightCards`** exports the carousel and not the three cards it ships
  with, and the package publishes no subpath, so the cards are unreachable. The
  carousel is adopted and the three charts are drawn from `by_day` and `by_key`
  in `Workspace.tsx`. A range with fewer than two days renders no carousel at
  all, because a one-point line pretending to be a trend is a chart that lies.

**Would change it if.** `AgentScreen` gains a way to turn the capture control
off, or `PromptBar` gains `value`/`onChange`.

---

## C28. A list is invalidated by the event that changes it, not by a timer

**Decided.** Three more `list/invalidate` sites: `traces` on `run.started` and
on any `run.status` that is not `working`; `instructions` after an accept or a
discard; `context-fields` after the destination is answered. `adapter.invalidateList(key)`
is the seam, and `TraceDetail` additionally forces one `ensure('trace', id, true)`
per trace opened.

**Why.** `ensureList` is idempotent by design — a list that is `ready` costs
nothing — and that is exactly wrong after a write whose consequences only the
server knows. Accepting an instruction moves three rows at once (`proposed`
becomes `saved`, the previous `current` becomes an older `saved`), and which
row is now current is a query, not an inference. The same shape of bug appeared
three times and was found only by driving the live stack:

* the Traces tab said "No runs yet." while the transcript beside it streamed
  one, because the list was fetched when the shell mounted and a fresh workspace
  had no runs then;
* the Agent Overview went on saying "Missing · A reply is paused" after the
  destination had been written, because `ensure` is a no-op for an id already
  in the cache and the cached row was the stale one;
* opening a trace showed "This run called no tools" for a run that had called
  one, because the list and the detail are the same entity kind and
  `GET /w/:ws/traces` fills half of it.

The last one is the general hazard worth naming: **a list route and a detail
route that answer the same entity kind with different completeness will always
produce this**, and a cache keyed only on id cannot tell them apart. Forcing the
detail fetch is the narrow fix; the wide one would be a `partial` flag on the
cached record.

**Would change it if.** The entity cache learns which fields a row was filled
from, at which point the forced refetch becomes "fetch because this row is
partial" rather than "fetch because this screen is the detail".

---

## C29. Fake mode has a step-up now, so the client stopped inventing one

**Decided.** `stepUpUrl` returns `/auth/login?step_up=1&return_to=…` in both
modes; the in-place challenge C24 described is gone, and so is the null return.
`StepUpIntent.kind` gained `workspace` (delete and undelete) and `effect`
(executing an effect from the receipt).

**Why.** C24 was a workaround for a Worker that had no step-up route in
`AUTH_MODE=fake`: `authenticated_at` was stamped once and never moved, so every
guarded action started failing five minutes into a dev session and there was
nowhere to send the browser. Server decision F4 built the route. One URL in both
modes means one code path in the callers, which matters because the rule those
callers keep is the one thing on this screen that cannot be got wrong: **the
intent is stored before the redirect, read on the way back, and never replayed**.
The pane re-renders as "Re-authenticated — confirm to continue" and waits for a
second, deliberate click. That is asserted by `adapter.test.ts` and by P4.

One caveat, recorded because it will bite somebody: the fake-mode step-up needs
the `x-dev-user` header, and a browser cannot put a header on a top-level
navigation. Playwright can (`extraHTTPHeaders`), so the live suite exercises it;
a human clicking through `wrangler dev` in a real browser gets a 401 and should
use `pnpm --filter client dev:step-up` instead.

**Would change it if.** Nothing in `AUTH_MODE=fake` is meant to survive contact
with production, and this does not either — the branch is behind both
`AUTH_MODE === 'fake'` and an `ENVIRONMENT` check on the server.

---

## C30. Deleting a workspace is confirmed by typing its name, and cancelled from the same screen

**Decided.** Settings → Organization carries the delete for an Admin: a
confirmation dialog that enables its button only when the workspace's own name
is typed, step-up, and — once scheduled — a "Cancel deletion" on the same panel
until the grace period ends. The copy about *when* erasure is actually complete
is the server's `ERASURE_TIMING.copy`, rendered verbatim.

**Why.** Two halves happen at two times and a screen that blurred them would be
lying in one direction or the other. Access is revoked immediately — shares
revoked, sessions read-only, runs asked to stop, every member evicted from their
sockets — because one of the two reasons anybody presses this is "someone got
in". Destruction is seven days away because it is the operation with no undo.
The panel says both, in that order.

The cancel is on the screen rather than in a runbook for a reason the runbook
itself cannot fix: a seven-day sleep with no cancel is a seven-day sleep that
gets cancelled by an engineer with production credentials, which is how a team
learns to keep such credentials handy.

The typed name is not theatre. It is the one control in the product where
"clicked the wrong row" and "meant it" have to be distinguishable, and a second
confirm button distinguishes nothing.

**Would change it if.** A soft-delete-with-export is added, at which point the
screen should offer the export first and the deletion second.

---

## C31. The receipt's Execute records an attempt and says nothing was done

**Decided.** A pending effect on the receipt gets an Execute button. Pressing it
calls `POST /w/:ws/effects/:id/execute`, which answers `unavailable`, and the row
re-renders with the server's own `reason` string. Below the list, when any
effect is `unavailable`: "Nothing was sent, paid, granted or signed."

**Why.** This is the most important honest surface in the product and the
temptation is to hide it. A receipt that listed "Grant workspace access ·
pending" with no control reads as *somebody else is doing this*. Nobody is.
There is no executor in this repository — no SMTP client, no payment provider,
no signature provider, not behind a flag — so the truthful interaction is: you
press it, we record that you pressed it against your name, and we tell you the
work is still yours. The role check and the step-up are on it for the same
reason every audit-writing action has them.

The copy is the server's `reason` rather than a client string, because two
authors for one claim is one author too many.

**Would change it if.** An executor exists, in which case the button changes
meaning entirely and this decision should be re-argued from scratch rather than
amended.

---

## C32. "Not available yet" is now only Connections and Shared Intelligence

**Decided.** The placeholder copy is kept in exactly two places — Library →
Connections and Library → Shared Intelligence, both M6's — and removed
everywhere it stood in for a route that has since landed. Where a screen still
has to describe an older server, it says which: "This server does not serve
traces. The client is newer than the Worker it is talking to."

**Why.** `EMPTY.libraryUnavailable` was doing two jobs: "this milestone has not
happened" and "this build of the Worker is older than this client". They call
for different sentences, because the second one is a deployment fact a reader
can act on and the first is a roadmap fact they cannot. `PDF unavailable` is the
same correction on the document viewer: `pdf_status: 'none'` with a `pdf_error`
means there will never be a PDF in this build (decision D7 — the renderer needs
runtime WebAssembly and Workers refuse it), and rendering "PDF is being
prepared" for it was a spinner for something nobody was doing. The viewer now
says what is true and offers the HTML render, which exists and is served.

**Would change it if.** M6 lands, at which point both remaining uses go.

---

## C34a. Focus belongs to the field, not to a bright ring inside it

**Decided.** Focus is drawn on the container — `.field`, `.search`, `.composer`,
`.find-bar`, `.portal-input`, `.portal-editor` — as a 50% `--accent-ink`
(`#BBB8FF`) border with a soft `--accent-tint` halo (`0 0 0 3px
rgba(130,123,222,.14)`), transitioned over 150ms on `border-color` and
`box-shadow`. The control inside such a container draws nothing of its own. A
control with no focus-carrying container keeps a real ring, in the same accent
rather than the near-white `#c6c6ff` default.

**Why.** This is the treatment the component library already settled on for
`.prompt-surface` (hermes-motion-components `src/theme.css`, QA "Feedback
polish"); the product client had not adopted it, so every focused input showed
the library's `.hermes-ui input:focus-visible` stroke — a near-white 2px line
inside a dark field. The rules are appended additively and only restate the
focus half of the existing field rules. One detail is load-bearing: the bare-
control rule is written `:root :is(input, textarea, select,
[contenteditable]):focus-visible`, because the library's own
`.hermes-ui input:focus-visible` outweighs an unprefixed element selector and
would otherwise keep painting the white stroke. Buttons and links are untouched
and keep their `:focus-visible` rings. Reduced motion needs no new rule: the
file's global `prefers-reduced-motion` block already kills every transition,
which makes the focus change instant.

**Would change it if.** The library exports these field shells as components, at
which point the app should adopt them instead of restating their focus rules.

---

# Series G — the final server pass

The last of the security review's open findings and the six the client's
integration left on the server. Where a finding needed a product decision, it is
still open and the reason is at the end.

---

## G1. A share is redeemed at `/shared/:token`, and grants exactly one session

**Decided.** `GET /shared/:token` exists. It takes no session, hashes the
presented token, resolves the hash to one workspace through a new platform table
(`share_directory`, migration 0014, the same pattern 0013 used for invitation
tokens), and answers the session's title, its workspace's name and its messages
up to `message_cutoff_seq` — read-only, with `blocks` stripped. In exchange, the
in-workspace visibility predicate is now `owner_id = $me` and nothing else, in
all four places that had it: the session queries, the turns route, the `/events`
replay and the socket upgrade.

**Why.** The old predicate was `owner_id = me OR EXISTS (an unrevoked share on
this session)`, which correlated the share with neither the caller nor any
presented token. Two things were true at once: creating a link share silently
handed that session to every member of the workspace, and the person actually
holding the link got the SPA shell and nothing else, because `token_hash` was
read by no query in the Worker. The product handed somebody a URL that promised
to be a share link and was not one, and a test pinned the wrong half as
intended.

The review called this a product decision because there were two coherent
answers: implement the route, or delete the token and rename the concept. The
route is the one the rest of the system was already built for — the column
`message_cutoff_seq`, the comment on it ("a share is a snapshot of a
conversation, not a subscription to one"), the client's `SharedViewer`, its
polling with `If-None-Match`, `sharedSessionSchema` in the contract and the
`/shared/*` entry in `run_worker_first` all exist and all assume it. Deleting
the token would have meant deleting those too, and calling "visible to the whole
workspace" a share is the claim that would actually surprise someone.

Three consequences worth stating, because they are what closes O5 and O6 rather
than patching them:

* the replay stream and the live hub now carry nothing of a shared session to a
  non-owner, so the cutoff cannot be ignored on a path that no longer exists;
* revoking a share evicts no socket because a share grants no socket;
* revocation deletes the `share_directory` row, so a link stops resolving at the
  source rather than at the next read of `revoked_at`.

The one soft edge is the five-second per-isolate memo on the answer. The viewer
polls every ten seconds per open tab and the route is unauthenticated, so
without it one link left open in twenty tabs is twenty Postgres connections a
poll against an origin budget of 209 — the arithmetic that produced the
`/health` cache. The cost is that an isolate that has already answered can serve
a revoked transcript for up to five more seconds. That is stated in the file and
asserted in the test rather than left for someone to discover.

No rate limit: `rate_counters.user_id` has a foreign key to `users`, and there is
no honest user id for an anonymous link holder. A 256-bit token is not a
guessing oracle worth metering, and the amplifier — which is the real concern —
is what the memo answers.

**Would change it if.** Shares gain an expiry or a per-recipient identity, at
which point the directory row grows a column and the route reads it.

---

## G2. A reaped run is told to stop, and the row refuses to come back

**Decided.** Every non-`ok` sweep verdict now sets `stop_requested = true` in the
same statement as the status, calls `instance.terminate()` after the commit, and
`setRunStatus` refuses to move a run that is already `completed`, `stopped` or
`error`.

**Why.** For the `engine_version_changed` and `no_progress` verdicts the sweep
wrote `runs.status = 'error'` and stopped there. The live Workflow polls
`stop_requested` and nothing else, so the instance kept going: more tools, more
`requests` rows, and on completion a `setRunStatus(run.id, 'completed')` whose
UPDATE had no status guard, silently resurrecting a run a human had been told
was dead. Deploy a new `ENGINE_VERSION` with runs in flight and that is every one
of them — errored in the UI, still putting proposals in the Inbox under the old
code path.

The three parts are deliberately redundant and in increasing order of
confidence. **Whether `terminate()` interrupts a step already in flight is
unverified**: Cloudflare documents it as terminating the instance, and whether a
`step.do` that is mid-`await` is cut short or runs to completion and is then
discarded is not something this repository has measured. That is exactly why the
flag is set first — it is read at the next step boundary and needs nothing from
the platform — and why the terminal guard exists at all: the correctness of the
sweep does not rest on the call whose behaviour we cannot assert.

**Would change it if.** Someone measures `terminate()` against a long step, in
which case the comment saying we have not is the thing to replace.

---

## G3. `apply_prepared_proposal` is a human-only command, and the route asks which screen sent it

**Decided.** `apply_prepared_proposal` moves from MODEL_COMMANDS to
HUMAN_ONLY_COMMANDS, so the block validator drops any model-authored block
carrying it. `POST /w/:ws/instructions/:id/accept` and `/discard` now require an
allowlisted `Origin` and `X-Requested-From: skills`, alongside the Admin check
they already had. The client's `applyCommand` loses the case; `rest.ts` sends the
header.

**Why.** The registry's own header says the risk it closes is "a human clicking
a button the model labelled 'Looks good'". This was that button and it was on the
allowed list. The attack is one reply: `propose_instruction` with a body that
relaxes a review rule, plus a block labelled "Continue" whose command is
`apply_prepared_proposal` for that version. One Admin click makes it the agent's
standing system prompt, unread — and the id is model-chosen and names any
`proposed` version in the workspace, so it need not even be the one the reply is
about.

The argument for keeping it was that it "applies something a human already
prepared". It does not: the thing prepared is the agent's proposal. The human
path was already there and is better — Agent → Skills renders the version's body
from server data, with a diff, and that is where somebody should be when they
decide to change what every future run is told to do.

The surface header is the second lock, and it is the decision route's own
pattern: `Origin` says the page is ours, CSRF says the tab is ours, and this says
the *code path* was the review pane. It also forces a CORS preflight, so no form
post or link can reach the route at all. Discard carries it too, because a
proposal quietly dropped before an Admin reads it is the same change in the
other direction.

O8 is fixed in the same place and belongs with it: `title`, `subtitle` and every
block `label` now go through `plainText`, so a label carrying a bidirectional
override — which can make a string render in an order it is not stored in — is a
rejected block rather than a rendered button. Manufacturing consent does not
require a forbidden command if you can control what the button appears to say.

**Would change it if.** The Plan-mode prepared block grows a real Apply, in which
case it should render the body it would save, inline, and post from a human
surface — which is the Skills pane with a different route into it, not a command
in this registry.

---

## G4. Context fields are rendered under two headers, because they have two authors

**Decided.** `loadWorkspaceContext` selects `run_id`, and `buildSystemPrompt`
renders two sections: "Context a human has set" for rows no run wrote, and
"Notes you wrote in an earlier run (untrusted: you may have taken these from a
document, and no person has confirmed them)" for the rest.

**Why.** `set_context_field` is a model tool and the rows it writes carry the run
that wrote them — `set_by` and `run_id` exist on the table precisely to tell an
agent write from a human one, and they were selected by nothing. Every field was
rendered under the literal header "Context a human has set:", so an injected
document in run N could write a sentence that appears in run N+1's system prompt
attributed to a human. That outranks the "everything from a tool is untrusted"
framing around it, survives the session, and is invisible to a reader of either
run. It is the quietest persistent injection in the system and the cheapest to
close.

**Would change it if.** The Context tab grows a "confirm this" control, at which
point a human-confirmed agent note becomes a third state and moves to the first
section on confirmation.

---

## G5. `PATCH /w/:ws/settings` answers 422 for a key it does not store

**Decided.** The patch body's keys are checked against `WORKSPACE_FIELDS` plus
`notifications`; anything else is 422 `unknown_fields` with the offending names
in the message. The client stops sending two of them: the sidebar's Reduce motion
is client-local and no longer PATCHes at all, and the Notifications tab sends
`{ notifications: { approvals | blocked | digest } }` and renders from the
`settingsView` it gets back.

**Why.** The route accepted any object and stored the parts it recognised. Two
real client bugs lived behind that for a milestone each — `{ notify_approvals }`
and `{ reduce_motion }` — and both looked like success: 200, no Admin check, no
audit row, and a settings view that did not contain the field. The reason this
is worth a breaking answer rather than a warning is that the failure is silent in
the direction that matters: a misspelled cap or timezone would read as saved.

The error carries the names in `error` rather than in a new field because
`errorBodySchema` is `.strict()` and a fifth key would fail to parse in the
client, which is the same constraint that put the decision route's conflict flag
in a header.

**Would change it if.** The settings surface grows enough fields that a
per-field response becomes worth a contract change.

---

## G6. A scripted scenario that parks a run, and the placeholder row the question needs

**Decided.** `DEV_SCRIPTS.waiting`: the first turn calls `ask_for_context` for
`destination`, the run parks, and once a human answers, the ordinary two-turn
script runs. And `ask_for_context` now leaves an `agent_context_fields` row with
a NULL value behind (`ensureContextField`, `ON CONFLICT DO NOTHING`).

**Why.** The five existing scenarios cover provider failures and malformed tool
arguments; none produced `runs.status = 'waiting'`, which is the state the whole
Context tab exists for. M3 in the live suite therefore inserted the parked run
and the empty field with `psql` and drove the client half only.

The placeholder row is the part that is a fix rather than a fixture.
`ask_for_context` wrote `runs.waiting_for` and nothing else, and the Context tab
lists `agent_context_fields` — so even with a scripted scenario the screen would
have had nothing to render. `DO NOTHING` rather than `DO UPDATE`: a field
somebody already answered keeps its answer, and the run reads it back rather
than asking again.

The key is `destination` deliberately, because that is the field the client's
Context tab renders a form for; the scenario therefore drives the real M3 screen
end to end, which is what `live-findings.spec.ts` G6 asserts with nothing
inserted.

One wart, recorded rather than wished away: scenario names are matched as a
substring of the turn text, and `waiting` is the first name that is also an
ordinary English word, so "still waiting on the references" selects it. The whole
mechanism is refused outside `ENVIRONMENT=development`, so the cost is a
surprising dev run, and the README says so.

**Would change it if.** A sixth name collides badly enough to be worth requiring
the `x-scripted-script` header for the ambiguous ones.

---

## G7. `SELECT ... FOR UPDATE` on the `runs` row, in every control

**Decided.** `loadRun` in `routes/turns.ts` takes `FOR UPDATE`. Every control
goes through it: Stop, Guide, Queue, edit, remove, Retry and the context answer.

**Why.** Stop and Queue are both read-then-write on one `runs` row. Queue read
`run.status` and inserted `queued` unless the run was already stopping; Stop
moved every `queued` row to `paused`. Nothing serialised them, so an enqueue that
read `working` before Stop committed inserted its row *after* Stop's sweep had
run, and it stayed `queued` forever: never sent, and not shown as paused either.
It is what made P7 fail about one full-suite run in three.

Taking the lock in the loader rather than at each call site means a control added
next year gets it by construction. Every caller locks `runs` first and touches
`run_queue` second, so there is one lock order and no deadlock to find. Under
READ COMMITTED the row `FOR UPDATE` returns is the version that exists after
whatever transaction we waited for, which is the point: Queue sees `stopping` and
parks the item.

The regression test is twenty iterations in both orders, and it fails reliably
with the two words removed.

**Would change it if.** The controls stop being one-row transactions — a bulk
Stop across a session, say — at which point the lock order becomes something to
state rather than something to observe.

---

## G8. `waitForEvent` was never given the event type, so no parked run could be woken

**Decided.** `step.waitForEvent(CONTEXT_ANSWERED_EVENT, { type:
CONTEXT_ANSWERED_EVENT, timeout: CONTEXT_WAIT_TIMEOUT })`, and the `EngineStep`
interface requires `type` so the next call site cannot omit it.

**Why.** This one was found by writing G6's live scenario, and it is the reason
that scenario was worth writing. The first argument to `waitForEvent` is the
step's checkpoint key; the *event kind* is `options.type`, and that is what the
runtime matches a `sendEvent` against. With `type` omitted the waiter is
registered under `undefined`, `sendEvent` queues the answer under
`context-answered`, and the two never meet — so a run that asked a human a
question sat in `waiting` until the 30-day timeout no matter what anybody
answered, through either of the two routes built to answer it.

Nothing caught it, and it is worth saying why: the unit harness's fake `step`
resolved on the *name*, which is the argument the code did pass, so every engine
test agreed with the broken call. The fake now refuses a wait with no `type`,
which is the assertion that would have failed at the time.

It also says something about the shape of the milestone: the two routes that
answer a context question were both tested, the engine's waiting path was tested,
and the seam between them was exercised for the first time by a scenario that ran
the whole thing against a real Workflow.

**Would change it if.** Nothing. The signature is the fix.

---

## G9. The rest of the open findings, and what is left

**Decided.** Fixed in this pass, each with a test: O1, O2, O3, O4, O5, O6, O7,
O8, O9, O10, O17, O21, O22, O26 — see the security review's tables for the
one-line version of each. Left open: O11, O12, O13, O14, O15, O16, O18, O19, O20,
O23, O24, O25, O27, O28, O29.

**Why the open ones are open.** Four reasons, and they are different:

* **A migration whose safety this pass cannot establish.** O20 (the envelope AAD
  does not bind `provider`) is a re-wrap of every stored ciphertext: changing the
  additional data invalidates every existing envelope, so it needs the KEK
  rotation Workflow, a backfill and a window, not a one-line change. O27, O28 and
  O29 are migration-history fixes in the same family — a backfill that is a no-op
  under forced RLS, a function that is not `SECURITY DEFINER`, a moment during
  re-application when RLS is forced onto a platform table — and each needs a
  numbered migration whose re-application is proved against a database this pass
  would have to build to prove it.
* **Ops changes that are somebody's credential.** O12 (CI actions pinned to
  moving tags), O13 (the backup job gated on a reviewer environment), O14 (a
  "write-only" credential used for `HeadObject`), O18 (staging and production
  declaring identical placeholder Hyperdrive ids). Each is a real finding, each
  is a two-line diff, and each one is only true once somebody with the account
  re-scopes a token or creates a binding. Editing the YAML without doing that
  turns a visible finding into an invisible one.
* **A performance change with a cost this pass cannot price.** O16 (the platform
  instance cap locks one global row inside every turn's tenant transaction) is
  correct as written and contended by construction; the fix is an approximate
  counter or a shard, and which one depends on numbers nobody has yet. O15
  (`runBackupUploads` has no cursor past ~330 objects) and O19 (no limit on
  `/auth/callback`, the replay and hub upgrades) are the same shape: the change
  is small, the right limit is a product decision.
* **Small and genuinely uncertain.** O11 (a model-chosen tool argument can raise
  a Postgres error that kills the run), O23 (the subrequest budget is asserted
  and never measured), O24 (`waitForAnswer` sets `waiting` before registering the
  wait, and cannot be woken by Stop), O25 (duplicate provider tool-call ids
  collide on `seq`). O24 is worth a note: G8 changed the code around it, and the
  *ordering* it describes is still there — the status moves, then the wait
  registers — but the window is now one statement wide and the run is woken by a
  row that outlives it, so the failure it predicts needs a Stop rather than an
  answer. It stays open because "Stop should wake a waiting run" is a behaviour
  nobody has specified.

**Would change it if.** Any of the four reasons stops being true: an operator
with the account, a number for the cap, or a decision about what Stop means to a
waiting run.

---
