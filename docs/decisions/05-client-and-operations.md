# Client and operations decisions

Client decisions C12 through C24 and operations decisions O1 through O13.

[Back to the decision index](../DECISIONS.md).

## C12. The shell lives at `/workspace/:ws`, not `/w/:ws`

**Found while building.** `wrangler.jsonc` lists `/w/*` in `run_worker_first`,
and `index.ts` ends the table with `app.all('/w/*')` answering
`{"reason":"unknown_route"}` as JSON — deliberately, so that a `fetch` for data
is never handed `index.html`. The side effect is that `/w/:ws`, the URL the spec
gives the shell, never reaches the Static Assets binding's
single-page-application fallback either. Opening the app at its own URL returned
a 404 body.

**Decided.** The API keeps `/w/:ws/...`. The *shell* moves to
`/workspace/:ws[/s/:sessionId]`, which is not worker-first and so falls through
to the SPA handler. `parseRoute` still accepts `/w/:ws`, so the moment the
Worker answers a navigation request there with the shell, old links work again
with no change in the client.

**What would change it.** Three lines in `apps/worker/src/index.ts`: answer the
`/w/*` catch-all with `env.ASSETS.fetch(request)` when the request is a
navigation (`Sec-Fetch-Mode: navigate`, or `Accept` contains `text/html`) and
with JSON otherwise. Then `SHELL_PREFIX` goes back to `w` and this decision is
deleted.

---

## C13. A hub frame is a batch, and the ticket key is `ticket`

**Found while building.** Two shapes differed from the spec. The hubs send
`{"type":"events","events":[…]}` — one frame per committed batch, because
`publish` fans a whole transaction out at once and N frames would be N wakeups
of a hibernating Durable Object — and they reply to a re-ticket with
`{"type":"ticket.accepted"}`. `Hub.webSocketMessage` reads `parsed.ticket`,
where the spec said `{"type":"ticket","value":…}`.

**Decided.** The client reads the batch envelope (`hubFrameSchema` in
`packages/shared/src/wire.ts`), ignores `ticket.accepted`, still accepts a bare
event for the mock backend, and sends `{"type":"ticket","ticket":…}`. The server
is right on both counts; the spec was guessing.

---

## C14. The replay stream takes no session id, so a session hub filters

**Found while building.** The spec's replay call was
`?stream=session:<id>`. `GET /w/:ws/events` reads `stream=session|workspace` and
filters the session stream server-side to the sessions the caller owns or holds
a share on. A session hub therefore receives its siblings' rows.

**Decided.** `HubOptions.accept` — a session hub advances its cursor past every
row and applies only its own. The cursor still advances, so nothing is fetched
twice.

**And a second thing this forced.** A new session hub starts at
`bootstrap.heads.session`, not at zero. At zero it replays the entire
workspace's session history, 500 rows at a time, before it can deliver anything
live — which on a workspace with a few thousand events is several seconds of
nothing. The transcript comes from `GET .../messages`; the socket only ever
needs what happens from now on.

---

## C15. The catch-up pages until it reaches the head

**Found while building.** `MAX_REPLAY_PAGE` is 500 and the client applied one
page. A client that was away for a long run came back missing the middle of it,
which looks exactly like a dropped message. `eventsPageSchema` already carries
`head`; the client was throwing it away.

**Decided.** `catchUp` loops while `head > cursor`, up to 20 pages, and stops on
an empty page or a response with no head. The unit test that covers it asserts
both halves: the pages are applied in id order, and the loop stops at the head
rather than asking forever.

---

## C16. Fake auth cannot open a browser WebSocket, so the hub falls back to polling

**Found while building.** `AUTH_MODE=fake` authenticates from an `x-dev-user`
header. A browser cannot put a header on a WebSocket handshake, so both hub
upgrades are refused with 401 before a socket exists. Verified directly: the
same upgrade succeeds from Node with the header and fails without it.

**Decided.** After two refused handshakes the hub polls the replay route
instead — same cursor, same `onEvent`, same "drop anything at or below the
cursor" rule, so replay ordering is still the only ordering there is. The
cadence is adaptive: ~600 ms while any session has a live run, 4 s when nothing
is happening, because an idle tab polling three times a second is a bill and a
battery.

This is not only a development affordance. A socket that is refused for any
reason — a proxy that strips upgrades, a corporate middlebox — now degrades to a
slower product rather than a broken one.

Playwright *can* set the header on the context, and it reaches the handshake, so
the live suite exercises the socket path and a hand-driven browser exercises the
polling path. Both are covered.

---

## C17. Every run control names its run

**Found while building.** The spec had `POST .../sessions/:id/stop`. The Worker
has `POST .../sessions/:id/runs/:runId/{stop,guide,queue,retry,context}`.

**Decided.** The adapter resolves the run id from the reducer — the session
holds exactly one, set by `run.started` and cleared by `run/clear` — and a
control pressed when there is none is a no-op rather than an error. The server
is right: "the session's current run" is a race the client would have to win,
and the server already knows the answer.

---

## C18. There is no `/bootstrap/client`; four routes answer instead

**Found while building.** The spec asked for one route carrying members,
invitations, provider keys, the agent and a hub ticket. The Worker has no such
route, and adding one is the server's to do.

**Decided.** `loadExtra()` composes the same object from `/auth/session?ws=`,
`/w/:ws/members`, `/w/:ws/invitations` and `/w/:ws/provider-keys`, in parallel,
each independently optional. They are the four the shell would call on its first
render anyway. Two details fell out of it:

* `/auth/session` **must** carry `?ws=`. Without it the route walks
  `workspace_directory`, which only the WorkOS mirror writes, so a seeded
  development workspace is not in it and the answer is 404 `no_workspace`.
* the Admin-only provider-key read returns masked connection health without a
  recent-auth challenge. Connect, verify, rotate and remove still require
  step-up. `ui.providerKeysLocked` remains a rolling-deploy fallback for an
  older Worker that answers `reauth_required`; the client renders a protected
  state instead of falsely claiming no connection exists.

---

## C19. `unknown_route` is not `not_found`

**Found while building.** Several routes the client wants did not exist when it
was wired up, and some still do not. A 404 for all of them rendered "Request not
found" — which tells a reviewer a request was *redacted* when in fact this build
of the server cannot look.

**Decided.** A fourth entity state, `unavailable`, set only for a 404 whose
`reason` is `unknown_route`, rendering "Not available yet". `rest.optional()`
does the same for lists: an absent route yields the screen's empty state, and
any other failure still throws, because a 500 on a route that exists is a bug
and silence would hide it.

The decisions route is the one exception: it is never wrapped in `optional`. A
decision that silently did nothing is the one failure this product cannot have.

---

## C20. The composer is not greyed in scripted development

**Found while building.** `wrangler dev` runs `MODEL_SCRIPTED=1`, so a run needs
no provider key at all — but no catalog row is `enabled` without one, so the
spec's rule greyed the composer on a stack where sending works perfectly.

**Decided.** `hasVerifiedKey` returns `any` (may the composer send) and `banner`
(should the advice show) separately. They differ only when
`__AUTH_MODE__ === 'fake' && !__MOCK__` — real fake-auth development. The mock
bundle is excluded on purpose: `?key=none` and `?key=invalid` are the fixtures
the empty-state scenarios assert the greyed composer against. A production build
folds the constant to `false` and drops the branch.

---

## C21. `run.focus` on an unseen request is treated as its creation

**Found while building.** The engine writes the `requests` row and publishes
`run.focus`; it does not publish `request.created`. Confirmed against
`stream_events`: the seeded workspace has 24 `run.focus` rows and zero
`request.created` rows. The Inbox therefore said "No reviews waiting" while the
session that had just proposed the request was showing it in the app pane.

**Decided.** A `run.focus` naming a request the cache has never seen prepends
that id to `inbox:needs-review` and to `requests`, and bumps the inbox count —
exactly what `request.created` would have done. A later `request.created`, if
one is ever published, is a no-op because the id is already in both lists.

**What this does not fix.** Another member, in another session, still learns
nothing until they reload: `run.focus` is session-scoped and they are not on
that socket. Only the server can fix that, by publishing `request.created` to
the workspace stream when `propose_request` commits. Recorded as a server
finding in `apps/client/README.md`.

---

## C22. A list the shell loaded before the row existed is invalidated, not left stale

**Found while building.** `useWorkspaceLists` fetched each list once per mount.
On a fresh workspace that is before the first request exists, and nothing ever
refetched: the badge said 1 and the pane said "No reviews waiting".

**Decided.** `list/invalidate` drops a list record — `decision.recorded` drops
`history`, because a decision writes a row whose id the event does not carry —
and the effect's dependencies include which lists the cache currently holds, so
a dropped list is fetched again. `ensureList` is already idempotent, so a list
that is ready or in flight costs nothing.

---

## C23. `PromptBar` is not adopted in the product composer

**Decided.** The other five M3 components are adopted (`LoadingState`,
`ThinkingState`, `ToolChips`, `StreamingText`, `TaskRows`, plus `ApprovalCard`
for the `ask_for_context` blocks), composed in `src/app/chat/RunSurface.tsx` and
driven only by server events. `PromptBar` is not.

**Why.** It owns its draft in its own `useState` and exposes no controlled
`value` and no initial text. Adopting it would mean a composer that cannot
render a restored draft — and "Signed out. Sign in again to continue — your
draft is saved" would become a sentence the product does not keep (spec §4.7,
§12.4). The same reasoning the spec itself applies to `ChatComposer`, which it
also declines to adopt in the shell.

**What would change it.** A `value`/`onChange` pair on `PromptBar`, upstream.
The composer's chrome is otherwise ready for it: model rows already come from
the catalog with `disabled_reason`, runtime is already a segmented control, and
Attach already goes through the presign flow.

---

## C24. Fake mode has no step-up, so the client challenges in place

**Found while building.** The spec's `/auth/dev/step-up` does not exist, and
`/auth/login` is a 503 without WorkOS credentials. Worse, fake auth writes
`auth_sessions.authenticated_at` once, on the INSERT for `sid = dev-<user id>`;
nothing ever moves it. Five minutes after a dev workspace is first opened, every
decision and every provider-key route answers `reauth_required` for ever.

**Decided.** `stepUpUrl` returns `null` in fake mode. The intent is still stored
and the pane still renders its "Re-authenticated — confirm to continue" state
and still waits for a second, deliberate click — the client never auto-replays a
decision, which is the part that matters — but the browser is not sent into a
503. In `workos` mode it goes to `/auth/login?step_up=1&return_to=<path>`, and
`return_to` is a *path*: the Worker collapses anything else to `/`, so sending a
full URL would silently lose the destination.

For local work, `apps/client/scripts/dev-step-up.mjs` re-stamps the row — which
is exactly what `/auth/callback` does in the real flow — and `pnpm e2e:live`
runs it before the scenarios that need it.

---

# Series O — M5a operations

Usage and caps, the three long-wait Workflows, observability, backups, the
release pipeline and the runbook. Everything here is server-side; the Settings
screens that read it are the client's.

## O1. Three groupings and one sentence, and the sentence is the server's

`GET /w/:ws/usage` returns per-day, per-session and per-key rows, and every
response carries `disclaimer` — the fixed sentence saying these are our
arithmetic over published prices and the provider's invoice is the authority.

It would have been natural to put that copy in the client, beside the number it
qualifies. It is here instead, because a client that forgot to render it would
be a client that quietly made a claim we cannot stand behind, and the place that
computes a number is the place that should have to say what kind of number it
is. `model_calls.cost_usd_estimate` is priced from the catalog at call time;
cached-token discounts, promotional pricing and a price we have not re-verified
all move it away from the invoice. The same argument puts the DeepSeek
PRC-storage warning and the erasure-timing copy in `routes/settings.ts`.

Three queries rather than one with grouping sets. They return different shapes
and join different tables, and the single clever query would be the one rewritten
from scratch the first time one of the three had to change.

Usage is readable by **any member**. A Member can already see every run that
produced the numbers, and a spend figure only one person can see is a spend
figure nobody checks. Changing the caps is Admin-only, which is the half that
actually needs the permission.

## O2. The platform instance cap is its own table, not `rate_counters`

`rate_counters` is keyed `(user_id, action, window_start, workspace_id)`. That
is exactly right for "30 turns a minute" and exactly wrong for "how many
Workflow instances did this deployment create this hour", which is one row
across every user in every workspace. Seeding a synthetic system user to make
the shape fit would have made the counter look per-user to every future reader.

So `platform_counters (bucket, window_start, count)` — migration 0012, outside
row-level security for the same reason `job_ready` is: the question is
cross-tenant by nature, and it holds counts and nothing else.

Three properties are deliberate. It is counted **inside the turn's
transaction**, so a turn that fails for any other reason gives its budget back
with the rollback. It **fails open** on a missing or unparseable
`PLATFORM_MAX_INSTANCES_PER_HOUR`, because a deployment that meant to set it and
did not should behave as it did before the cap existed rather than refuse every
turn. And it **counts even with no cap configured**, because the counter is also
the metric: a platform that only counts once somebody chose a limit has no
number to choose the limit from.

The refusal is 429 `platform_capacity` with copy that says the workspace is
inside its own limits and this one is ours. The customer did nothing wrong, and
the log line is an incident on our side.

## O3. The 80 percent warning is a job, keyed by workspace and tenant day

Queued from the turn path when `checkCaps` already said `warn` — so it costs no
extra query on the hot path — and keyed `cap_warning:{workspace}:{day}`, which
makes it one warning per workspace per day however many turns cross the line.
The day is the *workspace's* day, in its own timezone, the same boundary the cap
resets on.

The runner **re-reads the caps** rather than trusting its payload. A job may run
a minute after it was queued; a warning quoting a stale number is a warning the
Admin cannot reconcile with the usage screen, and a cap raised in the meantime
should produce silence, not a warning about a limit that no longer applies.

It sends no email. This build sends nothing (CONVENTIONS, invariant 5): it
writes the `events` row, publishes `entity.updated`, and logs who *would* have
been told — Admins with `user_notification_settings.blocked`, because a Member
cannot change the cap and a notification you cannot act on is noise.

## O4. Deletion is immediate access revocation plus a seven-day sleep

`DELETE /w/:ws` (Admin, step-up) splits into two halves and the split is the
whole design. Immediately: shares revoked, sessions read-only, `stop_requested`
on every live run, an `evict` job per member, the workspace marked. After seven
days, inside `WorkspaceDeletion`: the WorkOS organization, then the rows, then
the R2 prefix.

Access goes **now** because the two reasons a workspace is deleted are "we are
done" and "someone got in", and the second cannot wait a week. Destruction waits
**seven days** because it is the only operation here with no undo, and the two
failure modes — a misclick and an intruder — look identical at the moment of the
request and completely different the next morning.

A Workflow rather than a `jobs` row with `next_at = now() + 7 days`: the job
would work and would also be indistinguishable from a job that is merely stuck.
A Workflow instance has a queryable status, a sleep the platform owns, and
`terminate()` as the cancel.

Three consequences worth naming.

**`hermes_delete_workspace` is SECURITY DEFINER.** `app` holds no DELETE on
`workspaces` — removal is a status change everywhere else (decision 6) — and a
role that could delete a tenant row is a role one bug away from deleting a
tenant. The procedure takes one workspace id and refuses a workspace nobody
asked to delete, so the grant does not widen what a stray call can destroy.

**Two guards gained an escape, and only one.** The last-Admin trigger and the
`events` append-only trigger both refuse the cascade from `workspaces`. Both now
skip *when the workspace row no longer exists*, which is true only during that
cascade: `app` cannot delete a workspace, so the condition cannot be reached
from a route. An UPDATE on `events` is still refused unconditionally.

**The cancel is belt and braces.** `POST /settings/undelete` clears the mark and
terminates the instance; the Workflow also re-reads the row after its sleep and
stops on its own if the terminate call was lost. Sessions stay read-only after an
undelete, because resuming runs that have been stopped for days against a world
that moved on is rarely what anyone wants.

## O5. The long-wait Workflows read `workspace_directory` for their tenant list

`KekRotation` and `NightlyValidator` both have to visit every workspace, and no
role in this database can enumerate across tenants (decision 23). The KEK
rotation function already solved this by taking the list as an injected
dependency; in production the injection has to come from somewhere.

It comes from `workspace_directory` (migration 0008), the platform table holding
workspace ids and WorkOS organization ids and nothing else. Reading it tells the
rotation which workspaces exist — which the minute Cron already knows — and
nothing about any of them; every key row is then read inside that workspace's
own transaction. The isolation is intact.

Step names carry the workspace id (`rotate-{id}`) rather than an index, because
a checkpoint key has to be stable across attempts and an index would move if the
list changed between them — which is exactly when it matters.

## O6. The validator's summary row is opened before the work, not written after

`validator_runs` gets a row with a null `finished_at` before the first page and
is closed after the last. A success-only record cannot express "the validator
stopped running", which is the failure this nightly check is most likely to
have: nobody notices the absence of an alert.

`detail` carries ids and counts only, capped at 50 each. The validator reads
stream event payloads on its way past — applicant text included — and a summary
that quoted one would put that text in a table the erasure inventory does not
cover. A test seeds an applicant name into a failing run and asserts it is not
in the row.

The human-only-decisions query is **two SELECTs, not one join with a CASE**. A
decision attributed to a non-member is a membership or migration problem; an
`events` row written as `agent` claiming a decision is a security incident, and
one count containing both would let the second hide inside the first. The test
forges each of them **as `owner`**, because no role the product runs as can
write either — which is the point: that is what a breach would look like.

## O7. Sentry is always wrapped and does nothing without a DSN

`withSentry(sentryOptions, handler)` is applied unconditionally;
`sentryOptions` returns `undefined` with no `SENTRY_DSN`, which is the SDK's
documented way to disable itself. There is no conditional import and no second
export: a build where observability is a different bundle is a build whose
production behaviour nobody exercised.

`sendDefaultPii: false` is the SDK's promise. `beforeSend` is ours: it drops the
request's headers, cookies, body and query string outright, keeps the user id
and nothing else about the user, and runs everything remaining through the same
redactor the logs use. An SDK upgrade that changed a default would otherwise be
a data leak discovered in a changelog. The query string goes because that is
where a presigned URL's signature lives.

`tracesSampleRate: 0`. Correlation is the app's own `trace_id`, which is on every
log line, every `model_calls` row and every `stream_events` row — and unlike a
Sentry trace it survives into the database, where an incident is actually
reconstructed. Sentry's Workflows support is unverified (plan section 14), which
is the other reason not to lean on it. `release` is the engine version rather
than a build hash, so an error groups by the number the rollback procedure moves
and the `runs` rows carry.

The dependency was added to `apps/worker` and the lockfile changed with it. That
is a shared file and another agent was working in `apps/client` at the time; the
alternative — a dynamic import of a package that may not be installed — would not
typecheck and would not build.

## O8. Analytics Engine is optional at every call site

The binding is declared in every environment and guarded at every use.
`wrangler dev --local` and the Node test project have no dataset, and a metric
helper that threw there would be the observability tooling causing the outage it
exists to explain. Every writer returns a boolean and swallows a throw.

The metrics answer questions Postgres cannot: "what is p95 provider latency
across every workspace" is not a question any role here can ask, and building a
role that could would hand every route the same reach. What is written is the
metric name, the workspace id, enum tags and numbers — never a prompt, a name or
a key.

Rates are not computed at write time. One row per tool result, with a 0/1
double, so the error rate can be re-sliced by tool and by day; a counter could
only ever answer the question it was defined with.

## O9. The connection alarm is a health metric, not a limiter

Two Hyperdrive configs of about 100 connections each against a Neon 0.5 CU
compute that accepts 209. There is no configuration that makes those numbers
safe together; what makes it safe is that neither config is near its ceiling,
and this is the number that says whether that is still true.

Nothing refuses a request at 150. Refusing would take the product down to avoid
taking it down. It logs, it appears on `/health` as a check that reports `ok` at
any count, and it carries its denominator — "152" means nothing and "152 of 209"
means the afternoon is about to go badly. `idle in transaction` is broken out
because it is the shape of the specific bug this system could have: a tenant
transaction that opened, set its keys and never committed pins a connection.

`/health` also gained the WorkOS JWKS check, in `AUTH_MODE=workos` only. With no
JWKS we can verify nothing, so every request is a 401 and the symptom —
everybody signed out at once — is indistinguishable from us having broken auth.

## O10. `pnpm restore:check` reports; it repairs exactly one thing

Four checks after a restore, each silent in a different way if skipped:
documents whose object did not come back with the row, memberships that WorkOS
changed during the outage, the KEK versions the restored key rows are wrapped
under, and the Workflow instances that outlived the database.

Only the first is repaired, and only with `--fix` and an explicit list of
missing keys. The other three need a human deciding what the truth is: a
membership is reconciled through the product's own route, so that shares,
effects and the evict fan-out happen; an unreadable KEK version cannot be fixed
at all and the answer is to revoke and re-add; an instance is terminated with
`wrangler`, which this script has no credential for and should not.

The membership check calls the WorkOS endpoint directly rather than through the
port. That is deliberate duplication: the alternative is booting a Worker to run
a reconciliation, and a restore is exactly the moment the Worker may not be up.

## O11. Production deploys are manual, confirmed, and gated on a reviewer

Staging deploys on a push to `main`, because a staging environment nobody
deploys to tests nothing. Production is `workflow_dispatch` with a typed
confirmation, a preflight job that runs the unit project, gitleaks and a dry run
with no secrets in scope, and a `deploy` job in a GitHub Environment whose
required reviewer is the actual control.

Migrations run **before** the deploy in both, from `MIGRATIONS_DATABASE_URL` as
`owner`. Expand/contract is what makes that safe — the window between them runs
old code against a new schema, which the schema was written to support — and it
is the same property that means a code rollback never needs a reverse migration.

`cancel-in-progress: false` on both. A cancelled `wrangler deploy` can leave the
Worker and the migrations disagreeing about the schema, which is the one state
expand/contract cannot save.

The nightly `pg_dump` runs in Actions rather than a Cron: `pg_dump` is a binary,
the dump is large, and a Worker has 30 seconds of CPU and no filesystem. Its R2
token is **write-only on the backups bucket** — a backup credential that can
read exfiltrates every backup, and one that can delete makes ransomware trivial
— and its database role is read-only. A dry-run job proves the commands on every
pull request that touches the file, with no secrets.

## O12. The workflow files get two kinds of lint

`actionlint` in CI knows YAML and the Actions schema. `test/unit/workflows.test.ts`
knows *us*: every job has a timeout, every action is pinned to a major version
rather than a branch, no workflow grants write permissions, both deploys carry a
concurrency group that does not cancel, production names no `push:` trigger, the
deploy job names an environment, and no `run:` interpolates `${{ secrets.* }}`
into a shell.

It parses the YAML with a small indentation reader rather than a dependency.
The questions it asks are shallow, and adding a YAML parser to the Worker's
dependency tree to answer them would be a runtime dependency carried for a test.
It also runs on a machine with no actionlint installed, which is every developer
machine.

## O13. What M5a deliberately does not have

Stated so the gaps are visible rather than discovered.

* **No email, still.** The 80 percent warning, the deletion notice and the
  compromise broadcast all record who would be told and tell nobody
  (CONVENTIONS, invariant 5).
* **The Stop latency number in the runbook is a placeholder.** The budget and
  the engine test exist; the production figure comes from the M0 spike against
  a real provider, which needs `HERMES_SPIKE_KEY`. The runbook says so in place
  rather than quoting a number nobody measured.
* **The `spend.daily` and per-run metric writers exist and are called from the
  nightly Cron only.** Wiring `run.duration`, `tool.result`, `provider.latency`,
  `socket.reconnect`, `stop.latency` and `instance.subrequests` into the engine
  and the hubs is a change to files the engine owns; the writers are here,
  tested, and ready for those call sites.
* **No deployment was run.** Both deploy workflows are written and linted and
  neither has been executed; the first-deploy checklist in `docs/RUNBOOK.md` is
  what has to happen before either can be.

---

# Series F — the server findings the live client integration produced

`apps/client/README.md` ends with a table of nine things the Worker did that the
client had to work around. Each of these is one of them: what was wrong, what
the server does now, and what it deliberately still refuses to do. Every one has
a test, and the tests are collected in `apps/worker/test/db/server-findings.test.ts`,
`apps/worker/test/unit/server-findings.test.ts` and
`apps/client/e2e/live-findings.spec.ts` so the file itself answers "did we fix
what the integration hit?".

---
