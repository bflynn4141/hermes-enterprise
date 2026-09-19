# Decisions

Choices made while building M1 where the production plan was silent, plus the
places where reality differed from what the plan assumed. Each one says what was
decided, why, and what would change it.

## Navigation rail releases its grid column — September 15, 2026

The left navigation's explicit collapse control now contracts both the shared
`SidebarNav` and its application grid column from 240px to the component's 52px
rail. Previously only the inner component changed width, leaving 188px of empty
navigation background. The shell mirrors the component's disclosed state and
uses the existing grid-column transition; reduced-motion preferences still make
the change immediate.

## Empty-chat welcome — September 15, 2026

Brian's supplied reference replaces the left-aligned ready message and subtitle
with a centered Iris icon above one line: “What do you need help with?” The
group is centered in the available transcript area above the composer. The
no-session state uses the same copy and preserves Start; carried context keeps
its informational notice. No new motion. Verified rendered centering and a
single text line at desktop and 900px, plus focused tests and client typecheck.
The application bundle is rebuilt; visual QA used an isolated mock preview
because the local Worker on 8787 was stopped during this pass.

## Prompt-driven pane navigation — September 15, 2026

Extend the existing `set_focus` capability and `run.focus` event rather than
adding an external API or model-generated components. Validated screen names
and Inbox filters select predefined views; view-only focus carries null entity
metadata and creates no business rows. Full refs own the pane, filters and URL,
so pin/resume and refresh preserve what the human chose. Ask-mode permissions
and existing motion remain unchanged. Implementation and verification status:
[Prompt-driven workspace views](PROMPT-NAVIGATION.md).

---

## 1. Migrations are hand-written SQL; Drizzle is the typed view

**Decided.** `apps/worker/migrations/*.sql` is the source of truth. The Drizzle
schema in `src/db/schema.ts` mirrors it, and a test compares the two table by
table and column by column. `drizzle-kit` is not installed.

**Why.** The schema's substance is row-level security, forced policies, partial
unique indexes, triggers, a grant matrix and an expand/contract discipline. None
of that survives a round trip through a schema generator, so a generated
migration would be a migration whose most important half was written by hand
anyway. Keeping the SQL primary means the reviewable artefact is the one that
runs. The cost is drift, and the drift test is the answer to that.

**Would change it if.** Drizzle gains first-class RLS, policy and grant
expression, and the generated SQL becomes reviewable.

---

## 2. Migration replay is proved on a disposable shadow database

**Decided.** `pnpm db:migrate` validates the immutable ledger and applies only
pending files. `pnpm db:migrations:verify` creates a randomly named disposable
database, applies the catalog, fingerprints the schema (columns, constraints,
indexes, policies, RLS flags, triggers, grants and views), replays the catalog,
compares the fingerprint and drops the database in `finally`. CI runs both;
deployments run only the pending-only command.

**Why.** A half-applied deploy has to be recoverable by running the runner
again. "These statements are idempotent" is easy to believe and easy to get
wrong — one `CREATE INDEX` without `IF NOT EXISTS` is enough. The proof belongs
off the live target: replaying static catalog DML in production does more than
apply pending schema and couples a deploy to current data assumptions.

**Note.** Editing a migration that has already been applied is refused, because
staging and production would then disagree about what `0002` is. While iterating
against a throwaway database, `MIGRATE_ALLOW_EDIT=1` lifts that.

---

## 3. Roles are created by a script, not by a migration

**Decided.** `apps/worker/scripts/roles.mjs` creates `owner`, `app` and `agent`
and hands the schema to `owner`. `pnpm db:migrate` runs it first.

**Why.** Roles are cluster objects, not schema objects, and migrations run *as*
`owner`, which does not exist the first time. In staging and production the same
three roles are created once by whoever provisions the Neon project.

The script also sets `NOBYPASSRLS NOSUPERUSER` on all three, including `owner`.
A role that can bypass row-level security would quietly undo `FORCE ROW LEVEL
SECURITY`; a test asserts none of the three can.

---

## 4. `rate_counters` is the one tenant-shaped table outside RLS

**Decided.** It carries `workspace_id` but has no policy, and
`hermes_tenant_tables()` excludes it by name.

**Why.** A per-user limit that can be evaded by failing to set the tenant key is
not a limit. The counter is keyed by user first, so a user cannot spread a burst
across workspaces either. Every other table with a `workspace_id` is covered
automatically: the RLS migration ends by raising if any tenant table lacks
forced RLS, so a new table fails the migration rather than leaking.

---

## 5. `workspaces` is filtered on `id`, not `workspace_id`

**Decided.** Its policy is `id = app_workspace_id()`; every other tenant table
uses `workspace_id = app_workspace_id()`. Both spellings come from one helper
function, and a test asserts each table has exactly one policy with exactly the
expected predicate.

---

## 6. Removal is a status change; `app` holds no DELETE on `members`

**Decided.** The `app` role may INSERT and UPDATE `members` but not DELETE.
Removing someone sets `status = 'inactive'`. The last-Admin trigger still covers
DELETE, for the owner-level paths (a migration, a WorkOS reconciliation).

**Why.** History has to keep rendering after a removal, and a deleted row takes
its own audit trail with it. The same reasoning removed DELETE from `requests`,
`documents`, `effects`, `runs`, `events` and `stream_events`. Erasure goes
through `redact_subject`, which rewrites subject text and leaves the ids.

---

## 7. Job keys must contain an id; `UNIQUE(kind, key)` is global

**Found while testing.** The uniqueness is not per workspace. A key like
`receipt:latest` would let one workspace's enqueue silently suppress another's,
and the suppressed tenant could not even see the row that blocked it, because
RLS hides it. Every key the product writes therefore contains a uuid, the
docstring on `enqueueJob` says so, and a test pins the collision down so the
behaviour is documented rather than discovered.

---

## 8. Three Vitest projects, two runtimes

**Decided.** `unit` and `db` run in Node; `worker` runs inside workerd through
`@cloudflare/vitest-pool-workers`, reading the same `wrangler.jsonc` a deploy
reads.

**Why the split.** The pool installed cleanly, and the workerd project earns its
place: it proves the Worker boots with the real bindings, that `/health` reaches
a Durable Object, and that the routes behave in the real runtime.

What it cannot do is reach Postgres. `node-postgres` is CommonJS and requires
`node:net` and `node:dns`; Vitest's module runner cannot hand those to workerd
(`deps.optimizer` fails to resolve the builtins, and `server.deps.inline` fails
on the CommonJS entry). The deployed bundle is fine — esbuild resolves it, and
`wrangler dev --local` serves `/health` against Docker Postgres through both
Hyperdrive bindings — so this is a test-harness limitation, not a runtime one.
So the tests that need a database (row-level security, the grant matrix, the
triggers, the jobs claim, the routes end to end) run in Node against the same
Docker Postgres, with the identical Hono app and an `Env` whose Hyperdrive
bindings carry the same connection strings.

Two consequences, both deliberate:

* `src/db/client.ts` imports `pg` lazily, so the Worker's module graph can be
  loaded by tooling that cannot transform a CommonJS dependency.
* The Node projects alias `cloudflare:workers` and `cloudflare:workflows` to
  stubs in `test/stubs/`. Nothing is tested through those stubs; the classes
  that use the real modules are covered by the workerd project.

**Would change it if.** The pool gains a way to bundle a CommonJS dependency
with node builtins, or we move to a Postgres driver that is ESM and uses
`connect()` from `cloudflare:sockets`.

---

## 9. `compatibility_date` is pinned to the test runtime's ceiling

**Decided.** `2026-08-22`, the newest date the workerd binary bundled with
`@cloudflare/vitest-pool-workers` accepts.

**Why.** A later date makes the Worker unstartable in tests. A Worker we cannot
run in workerd is a Worker we cannot test in workerd, which is worth more than
three weeks of compatibility flags. Raise both together when the pool updates.

---

## 10. Durable Objects use `exports`, not `migrations`

**Decided.** `wrangler.jsonc` declares both hub classes in the `exports` map,
per environment, with `storage: "sqlite"`. The `migrations` array is absent; the
two are mutually exclusive.

**Why.** The plan requires `exports`. Its consequences are accepted: gradual
deployments are not supported with it, and removing a class name deletes that
namespace and all of its stored data permanently. Both hubs hold no truth, so
the second consequence costs one reconnect — but a rename is still a `renamed`
tombstone, never an edit. A unit test asserts the top level and both
environments declare the same classes.

---

## 11. Hyperdrive local connection strings live in `.env`, not `.dev.vars`

**Found while running.** `.dev.vars` carries Worker secrets, which the Worker
reads at runtime. Wrangler resolves
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` from its own process
environment while it parses `wrangler.jsonc`, before the Worker exists. So there
are two example files: `.env.example` for those two, `.dev.vars.example` for
every secret. Both are gitignored in their real form.

The alternative, `localConnectionString` inside `wrangler.jsonc`, was rejected:
it puts a credential in a committed file, and a unit test now asserts that
string never appears there.

---

## 12. `/health` reads `catalog`, not `schema_migrations`

**Decided.** Both roles can read `catalog`, so one query proves both
connections. `schema_migrations` is readable by `app` only.

**Why.** The alternative was granting the `agent` role SELECT on
`schema_migrations` for the sake of a health check. Widening the agent role's
grants to make a status page prettier is exactly the trade this product should
not make.

---

## 13. Money is stored in minor units

**Decided.** `amount_minor` and `total_minor` are integers; the invoice schema
refuses a total that does not equal the sum of its lines, and a due date before
the issue date.

**Why.** An approval is of exact content. Floating-point dollars make 1200.00
and 1199.999999 the same approval, and a total that disagrees with its lines is
a document the reviewer cannot check by reading it.

---

## 14. `chat/send` was renamed `chat/prompt`

**Found while testing.** The forbidden-name test — which refuses any model
command or tool named after a human action — flagged `chat/send`. The command
only puts text in the composer, but a registry entry with `send` in its name is
exactly the thing that rule exists to catch, and arguing with the rule is how
the rule stops working. Renamed.

---

## 15. Catalog rows, and why two are disabled

**Decided.** Four rows, seeded by migration `0007`. `deepseek-flash` and
`claude-sonnet-4-6` are enabled; `claude-opus-4-7` is disabled because the cost
per screening run is an order of magnitude above Sonnet and the pilot has a $50
spend alarm; `gpt-5-5` is disabled until the M3 reasoning-replay engine test for
the Responses transport passes. The demo's Nous Portal row is not carried: it
was a proposed demo configuration, never a verified deployment.

A row is offered to a workspace only when `disabled_reason IS NULL` **and** that
workspace holds a verified key for the row's provider. In M1 no workspace holds
a key, so `bootstrap` returns four rows, all `enabled: false` — which is what
makes "Add a provider key in Settings to start" an empty state rather than an
error.

Prices are the figures the production plan recorded on 2026-09-14 and carry
`pricing_verified_on`. They are treated as illustrative until re-verified
against each vendor's own pricing page; the Usage screen says "estimated, billed
by your provider". A price change is a new migration.

---

## 16. The event contract's stream ids are strings

**Decided.** `stream_events.id` is a bigserial; the contract carries it as a
decimal string and the run-log validator compares ids as `BigInt`.

**Why.** JSON numbers lose integers past 2^53. A replay cursor that silently
rounds is a client that silently skips events. A test compares ids either side
of 2^53 to keep that honest.

---

## 17. A replay row that no longer parses triggers `resync`

**Decided.** `GET /w/:ws/events` parses every row against the contract. A row
that fails sets `resync: true` and the page returns no events.

**Why.** The alternative is dropping the row, which leaves a hole in a
transcript the reader has no way to notice. Telling the client to refetch is
cheap and honest.

---

## 18. A non-member gets 404, not 403

**Decided.** `TenancyError('not_a_member')` maps to 404.

**Why.** Whether a workspace exists is itself information a non-member should
not have. The membership lookup runs *inside* the tenant transaction, under the
policy it is checking, so there is no window in which a query runs with the
wrong tenant key.

---

## 19. The fake auth adapter refuses unknown users

**Decided.** `AUTH_MODE=fake` looks the `x-dev-user` value up in `users` by id
or email and returns 401 `unknown_user` if there is no row. `AUTH_MODE=workos`
returns 503 `not_configured` until M2 rather than falling back.

**Why.** The worst possible failure mode is a production Worker trusting a
header because its auth mode was misconfigured. A unit test asserts both
deployed environments set `AUTH_MODE=workos`.

---

## 20. What M1 deliberately does not have

No decision route (M4), no run engine (M3), no WebSocket upgrade route (M2, the
hubs exist and are tested through `/health`), no provider-key routes (M2), no
`POST /workspaces` (M2), no Sentry wiring (the DSN is named in
`.dev.vars.example`; the client is added with the auth middleware in M2), no
`@react-pdf/renderer` or pdfjs spike (M1's remaining half-day; both are recorded
as **unverified** in the plan and neither blocks the rails).

---

## 21. The AAD is split so that a KEK rotation touches only the DEK

**Decided.** The data ciphertext is sealed under
`hermes/provider-key/v1|{workspace_id}|{key_id}`; the wrapped DEK is sealed under
`hermes/provider-dek/v1|{workspace_id}|{key_id}|{kek_version}`.

**Why the split is exactly there.** If the data ciphertext bound the KEK
version, rotating the master secret would mean decrypting and re-encrypting
every tenant's provider key — the one operation where plaintext would have to
exist, in bulk, in a maintenance job. Binding the version only in the wrap makes
a rotation 48 bytes per row and means `rewrapDek` never materialises a provider
key at all. Both halves bind `(workspace_id, key_id)`, so a ciphertext moved to
another row, or read as another tenant, fails to authenticate rather than
decrypting quietly. That is a second, independent check of what row-level
security already enforces: a policy regression alone is not enough to leak a
key, and neither is a bug in the crypto layer.

**Would change it if.** A provider key ever needed to be re-encrypted for
another reason (a cipher change), in which case the data ciphertext gets its own
version field and the same argument applies one level down.

---

## 22. `KEK_CURRENT` exists so a rotation is two deploys

**Decided.** New material is encrypted under `KEK_CURRENT` when it is set, and
under the highest `KEK_V{n}` present otherwise.

**Why.** Without it, the moment `KEK_V2` lands as a secret it becomes current,
and an older instance still serving requests — a deploy is not instantaneous —
cannot read what a newer one has just written. With it the order is: add the
secret, deploy, confirm every instance holds it, then set `KEK_CURRENT=2`. Old
versions stay as secrets until every backup that could hold DEKs wrapped under
them has expired; deleting `KEK_V1` the day after a rotation makes last week's
`pg_dump` unreadable.

---

## 23. Nothing in this database can enumerate across tenants, including the KEK rotation

**Found while building.** `runKekRotation` needs the list of workspaces holding
keys. There is no query that answers it: every tenant table is FORCE ROW LEVEL
SECURITY, `workspaces` is filtered on `id = app_workspace_id()`, and all three
roles are `NOBYPASSRLS` — `owner` included, by decision 3.

**Decided.** That is the isolation working, not a gap. The workspace list is a
parameter: `runKekRotation` takes a `listTargets` and a `withWorkspace`, reads
each workspace's rows inside that workspace's own transaction, and the
production Workflow is one `step.do` per workspace with the list supplied by the
provisioning connection that also applies migrations — already inside the trust
boundary named in CONVENTIONS.md. The alternative, a fourth role with
`BYPASSRLS` or a widened `app`, would hand every route the reach that one
maintenance job wanted.

**Would change it if.** A second maintenance job needed the same enumeration, at
which point it is worth a dedicated role that only the ops path can authenticate
as, rather than two injected cursors.

---

## 24. The provider probe happens with no transaction open

**Decided.** Adding, verifying and rotating a key each run three phases: read in
one transaction, probe the provider with nothing open, record in a second.

**Why.** Hyperdrive in transaction mode pins one Postgres connection for the
life of a transaction. A verification probe inside a transaction would hold a
connection for as long as the provider took to answer, and the connection alarm
in section 5 sits at 150 against roughly 209 available. The cost is that the two
halves are not atomic: the worst case is a key whose status is one probe stale,
and the next probe corrects it. The alternative trades a correctness property
nobody can observe for an availability property everybody can.

**Consequence.** The key is stored *before* it is verified, so a probe that
times out leaves an `unverified` row the Admin can retry rather than losing the
key they pasted — which is how a key ends up being pasted a second time, into
somewhere worse.

---

## 25. Two 403s, then a one-token probe

**Decided.** A 403 from a provider's list-models endpoint leaves the key
`unverified` with a `reverify` job. The second consecutive 403 switches the
probe to a 1-token `messages` call; 200 there is `verified (scoped)`, and the
row records only the model that was actually called.

**Why not one 403.** A single 403 is also what a transient gateway problem looks
like, and the messages probe spends the Admin's money. **Why not treat 403 as
invalid:** Anthropic's scoped keys can infer and cannot enumerate, so a
workspace with a perfectly good key would be told its key was rejected. The
count lives on the `reverify` job's payload rather than on the key row, so it is
scoped to one verification episode and disappears when the job completes.

**Consequence.** `verified_models` for a scoped key holds one entry. Claiming
the rest of the catalog would be an invention the model menu acts on.

---

## 26. Reasoning is carried per transport, not normalised

**Decided.** `ReasoningCarry` is a three-way union — Anthropic signed thinking
blocks, DeepSeek `reasoning_content`, OpenAI `reasoning.encrypted_content` — and
an adapter refuses a carry another transport produced.

**Why.** All three vendors require their own thing back and two of them verify
it: Anthropic checks a signature, OpenAI decrypts. A normalised "reasoning text"
would be a paraphrase, and the failure it produces is the worst kind — the first
turn works and the second is a 400 the user cannot act on. DeepSeek's is the
dangerous one, because it is *not* verified: a re-encoded `reasoning_content`
degrades continuity invisibly. So the payload is stored as it arrived and
replayed byte for byte, and the type system refuses the mix-up rather than
coercing it.

**Consequence.** Effort is a property of the run, not the turn. Anthropic
rejects a replayed thinking block when the thinking configuration changed
mid-conversation, so `runs.effort` is fixed at creation and every turn maps
through the same catalog `effort_map`.

---

## 27. Catalog policy and key state are different answers

**Decided.** `GET /w/:ws/catalog` returns `enabled`, a `disabled_code` from
`catalog | no_key | key_unverified | key_invalid`, and prose. Catalog policy
wins: a row the pilot does not offer says so even when the workspace holds a
good key.

**Why.** "Not enabled for the pilot" and "add your Anthropic key" are different
screens with different actions, and collapsing them into one absence is how a
model menu teaches people that adding a key does nothing. The code is what the
client keys its copy off; the prose is for a human, and a string comparison on
prose is not a contract.

**The Nous Portal row is still absent, and the catalog rows are unchanged.**
Section 4 says it "stays disabled and unverified". It is: `workspace_provider_keys.provider`
has no `nous_portal` value and there is no adapter, so no workspace could ever
enable one. Adding a row that can never be reached would also break the two M1
tests that assert the live `catalog` table equals `CATALOG_SEED` row for row —
tests in files this milestone does not own — in exchange for nothing a user
could see. Reclassifying Sonnet 4.6, Opus 4.7 or GPT-5.5 was declined for the
same reason: decision 15 gives each disabled row a concrete, checkable reason,
and replacing a checkable reason with a category is a loss.

---

## 28. Redaction is two defences, by name and by shape

**Decided.** `logEvent` and `logError` in `src/keys/redact.ts` are the only way
this milestone's code writes a log line. Fields named `authorization`,
`x-api-key`, `cf-aig-authorization` and a dozen others are replaced whatever
they hold; every string, at any depth, also has key shapes replaced.

**Why both.** By name alone misses a key that arrived under a field nobody
predicted — a provider error body, an interpolated message. By shape alone
misses a credential that does not look like one, which every gateway token is.
The error path matters as much as the log path: a provider that echoes the
offending request back would otherwise put the key in an error string, and an
error string reaches a log, a Sentry event and `runs.error`. So
`errorFromResponse` reads the body, keeps at most an enum-shaped `type`, and
discards the rest.

**Note.** No credential-shaped literal appears in the tests. They are assembled
at runtime from harmless parts, because a test for "a key must never appear in a
log" that ships a key-shaped string is a test that trips gitleaks and teaches
the next person to add an allowlist entry.

---

## 29. Two platform tables exist because no role may read two tenants

**Decided.** Migration `0008` adds `workspace_directory` (workspace id ↔ WorkOS
organization id) and `job_ready` (job id, workspace id, due time), both outside
row-level security, both holding ids and nothing else, and names them in the
`hermes_tenant_tables()` exclusion list beside `rate_counters`.

**Why.** Every tenant table is `FORCE ROW LEVEL SECURITY` and all three roles
are `NOBYPASSRLS`, including `owner`, so there is no connection in this system
that can see two workspaces at once. That is the property the product rests on,
and it makes two ordinary questions unanswerable: the minute Cron's "which
workspaces have a job due?" and the auth callback's "which workspace is
organization `org_123`?" — the second asked before any tenant key exists at all.

The alternatives were worse. A fourth role with `BYPASSRLS` would be a
connection that can read every tenant, which is the thing we refuse to create. A
`SECURITY DEFINER` function does not help: it runs as `owner`, and `FORCE` binds
the owner too. Spreading the Cron over every workspace by guessing ids is not a
design.

So each cross-tenant question gets a narrow table holding only what the question
needs. The cost is honest: a leak of either table reveals that a workspace
exists and that it has work pending. The `job_ready` row is written and deleted
in the same transactions as the job it points at, so the pointer cannot outlive
its job.

**Would change it if.** Postgres gained a way to grant "read this table across
policies" for one query, or the jobs table itself moved to a store outside the
tenant boundary.

---

## 30. The Cron runs a tenant transaction with no membership check

**Decided.** `withWorkspaceTransaction(env, workspaceId, fn)` sets
`app.workspace_id` and `app.user_id` (to a fixed system uuid) and skips the
members lookup that `withTenantTransaction` performs.

**Why.** The membership lookup answers "may this caller be here?", and for a
Cron there is no caller. The alternative — a service member seated in every
workspace — would be a row that could decide, be assigned an effect, or show up
in the Members list, which is a much larger surface than a second function. The
tenant key is still set, so row-level security still constrains every statement
inside; what is absent is only the authorisation half, and the authorisation is
that the Cron is not a person.

---

## 31. Step-up guards the member routes, since the decision route is M4

**Decided.** `requireStepUp` refuses a role change or a removal whose session
authenticated more than five minutes ago, with 401 `reauth_required`. The
freshness comes from `auth_sessions(sid, authenticated_at)`, written by
`/auth/callback` and by the fake adapter.

**Why.** The plan attaches step-up to the decision route, which does not exist
yet. Building the mechanism without a route that uses it would leave it
untested until M4, and the member routes are the other place where an
unattended laptop is the threat: promoting yourself an accomplice to Admin is
as consequential as approving one admission. `/auth/login?step_up=1` is the way
back, asking AuthKit for `max_age: 0`. WorkOS retains the `sid`, advances the
access token's `auth_time`, and the callback persists that value as
`authenticated_at`.

**Note.** Whether `max_age: 0` also re-challenges MFA is still **unverified**;
it needs a live WorkOS environment, and it is listed in the final report as
something to check in the dashboard.

---

## 32. A demotion runs the removal transaction, minus the two steps about the past

**Decided.** `revokeAccess` is one function with an `action` of `remove` or
`demote`. Both unassign effects, request a stop on the person's working runs,
write the audit row, and enqueue `workos_sync` and `evict`. Only a removal also
revokes the shares they created and marks their sessions read-only.

**Why.** The plan lists one transaction for both, and one function is what keeps
the route and the events poller from drifting. But a demoted Admin is still a
member: freezing their sessions would take away work they are still entitled to
do, and revoking links they handed out would be a punishment for a role change.
What a demotion must do is invalidate what they could do *as an Admin* — hold an
effect assignment, hold an open socket authorised under the old role — and both
of those it does.

---

## 33. `FakeWorkOS` implements the port; there is no local emulator in this build

**Decided.** `src/auth/workos.ts` defines a `WorkOSPort` interface, the SDK
implementation is the only thing that imports `@workos-inc/node`, and the tests
inject a double through `setWorkOSPortForTests`. `AUTH_MODE` has two values,
`fake` and `workos`; there is no `emulate`.

**Why.** WorkOS documents a testing story, but it needs a live environment and
credentials, which makes it a network dependency in the test suite and an
onboarding step for anyone running `pnpm test` offline. The port is smaller than
the SDK and is also the document that answers "what does WorkOS know about us?".

The double is real where it matters: the access token it issues is a genuine
RS256 JWT signed by a key it publishes as a JWKS, so the production verifier
checks a real signature, handles an unknown `kid` and honours `exp`. What it
fakes is the seal (base64 JSON) and the network.

**Would change it if.** WorkOS ships an emulator that runs from a container with
no account, at which point `AUTH_MODE=emulate` becomes a third adapter and these
tests keep working unchanged.

**On the SDK under workerd.** `@workos-inc/node` 10.13.0 publishes a `workerd`
export condition resolving to a fetch-based build, so importing the package by
name is correct and the `/worker` subpath is not needed. `wrangler dev --local`
serves `/auth/session` with the SDK in the bundle, and the workerd test project
boots the Worker with it in the module graph.

---

## 34. The server serves the client's schemas, not a second set of its own

**Found while building.** The client work and the server work reached
`packages/shared` from two directions and both defined an auth-session shape, a
message shape and a run-step shape. Two schemas for one payload is two
contracts, and the one that drifts is the one nobody is reading.

**Decided.** The routes parse their responses with the schemas in
`entities.ts` — `sessionSchema`, `messageSchema`, `paginatedSchema`,
`memberEntitySchema`, `invitationEntitySchema`, `shareResponseSchema`,
`authSessionSchema` — and `api-m2.ts` carries only the one shape that was
genuinely new, the per-session draft. The entity `runStepSchema` was renamed
`runStepEntitySchema`, because `events.ts` already exports a `runStepSchema` for
the `run.step` event and an ambiguous re-export from the package index is a
compile error rather than a judgement call.

---

## 35. Hub tickets are receipts for an authorisation the Worker already made

**Decided.** `GET /auth/session` returns an HMAC-signed ticket carrying
`{user_id, workspace_id, session_id, exp}`, valid ten minutes. The client sends
it on the socket every four minutes; the hub verifies the signature, extends
`authorized_until`, and closes the socket when a ticket stops arriving or fails
to verify.

**Why not have the hub ask the database.** Because then a hub would hold a
Postgres connection, and the whole design of the hubs is that they hold nothing
and query nothing — that is what makes a hub eviction cost one reconnect rather
than a page of errors. The Worker has just done the membership lookup under
row-level security; the ticket is that answer, signed, with an expiry short
enough that a removal takes effect within one window even if the `evict`
fan-out is lost entirely.

**Note.** In development, with no `HUB_TICKET_SECRET` and no
`WORKOS_COOKIE_PASSWORD`, the key is a constant so that `wrangler dev` works
from a fresh checkout. In `staging` and `production` a missing secret throws
rather than falling back, because a predictable ticket key would let anyone mint
an authorisation receipt.

---

## 36. Inviting someone who is already a member writes an accepted row

**Decided.** `POST /w/:ws/invitations` for an address that already belongs to an
active member does not send anything and does not error. It writes an
`invitations` row with status `accepted`, pointing at that member, and returns
it.

**Why.** The intent is obvious and a second email would only confuse the
recipient, so an error would be pedantry. But a silent 200 with nothing behind
it leaves the Admin wondering whether it worked, and leaves no trace that anyone
asked. The row is the honest middle: nothing was sent, something is recorded,
and the Members screen shows a state the Admin can read.

---

# Client

Choices made while porting the demo client into `apps/client` (M2), where the
client-port specification was silent, and the places where the specification and
this repository disagreed. Where they disagreed, the repository's
`packages/shared` won; each of those is noted.

---

<!-- The U series is uploads and extraction (M3.5); C is the client. Numbered
     separately so two people can add decisions at once without colliding over
     where the numeric series ends. -->

## U1. The bytes are checked on `complete`, not on declare

**Decided.** `POST /attachments` records what the client *says* — a name, a size
and a MIME type — and mints a presigned PUT. `POST /attachments/:id/complete`
streams the object back through the binding, compares the first bytes with the
declared type, computes the sha256 the row keeps, and refuses a mismatch.

**Why.** Nothing at declaration time has seen a byte. The upload goes browser to
R2 so that 20 MB never passes through a Worker request, which means the only
moment we can check the content is after it exists. A renamed executable is the
named case in the plan; the general form is that the name, the size and the type
are three separate claims and all three are the client's.

A refusal deletes the object. Leaving it for the daily sweep would mean a file
we have just decided is lying about what it is sits in a workspace's store for a
day, and the sweep is a cleanup for things nobody decided about.

**Would change it if.** R2 gained a server-side content check on PUT, which is
not a thing S3-compatible storage does.

---

## U2. Verification runs with no transaction open, and the verdict commits either way

**Found while testing.** The first version marked the row `failed` inside the
tenant transaction and then threw, which rolled the mark back. The row sat at
`uploading` about bytes that had already been deleted, and nothing would ever
say why. A test caught it; the test is `refuses a renamed executable and deletes
the object`.

**Decided.** `complete` is three steps: one transaction to load the row (which
is also the membership check), verification with nothing open, and one
transaction to record the verdict — which commits whether the verdict is ready
or failed. The object is deleted after that commit.

**Why the middle step holds no transaction.** It streams up to 20 MB. A Postgres
connection held for the length of a download is a connection out of a budget the
plan alarms on at 150, and the work needs no database at all.

---

## U3. A presigned URL is signed by hand, not by a dependency

**Decided.** `src/storage/sigv4.ts` implements SigV4 query signing on Web
Crypto, about eighty lines. `aws4fetch` is not installed.

**Why.** The signature is HMAC and string concatenation in a documented order.
Every dependency here is pinned exactly and asks for a reason in this file
before it is added, and "concatenates strings in the right order" is not one.
The test is the interesting half: it asserts that the signature changes when the
method changes and when the key changes, which is what stops a PUT URL being
replayable as a DELETE and a URL for one object being pointed at another.

**Would change it if.** We needed multipart uploads, whose signing is genuinely
involved, or chunked payload signing.

---

## U4. Local development uploads through the Worker, and the route is development-only

**Decided.** `wrangler dev --local` simulates R2 on disk. There is no account
behind it and therefore no S3 credentials, so there is nothing to sign with.
With the three `R2_*` secrets absent the declare route answers
`upload.direct: true` and a URL on this Worker — `PUT /w/:ws/attachments/:id/upload`
— which writes through the binding. Outside `ENVIRONMENT=development` that route
answers 404.

**Why 404 rather than 403.** Saying "you may not" advertises that the route
exists. Outside development it does not.

**Why at all.** The alternative is that local uploads are impossible and the
whole path is untestable without an R2 account, or that the client grows a
second code path for development. This way the client PUTs to whatever URL it
was handed, in both places.

---

## U5. Extracted text lives in R2, next to its object

**Decided.** `{storage_key}.txt`. Postgres keeps two numbers, `text_length` and
`token_estimate`.

**Why.** Extracted text is derived, re-derivable and can be megabytes. A column
holding it turns every `SELECT *` on the table into a transfer of the whole
corpus, and makes the erasure inventory's answer for "where is the applicant's
text" two places instead of one. The two numbers are in the row because a list
needs to say "about 12,000 tokens" without reading a byte.

---

## U6. `get_document_text` returns 6,000 tokens and an offset, never a document

**Decided.** `getDocumentText(env, workspaceId, fileId, offset)` returns at most
6,000 estimated tokens and the offset to ask for next. Four characters to a
token, deliberately crude.

**Why.** A tool result is model input. A 20 MB extracted PDF returned in one
call is a context-window error at best and a large bill at worst. Paging also
makes the read interruptible: a stopped run stops between pages.

The page ends on a line break where one is available inside the window, because
cutting mid-line is how a model comes to quote half a clause as though it were
the whole one. A document with no line breaks is cut where the cap falls, since
the alternative is no progress.

---

## U7. Queue routing matches on the queue name's stem, not on a list of names

**Decided.** One `queue()` handler serves four queues whose names are suffixed
per environment (`hermes-extract`, `-staging`, `-production`, and a `-dlq` for
each). The router matches the stem and the suffix.

**Why.** A router listing exact names silently stops handling a queue the day
someone adds an environment, and the symptom is extractions that never happen
with no error anywhere. A queue this build does not recognise is retried, never
acked: an unknown queue means a deploy is behind, and acking deletes the
messages it is behind on.

Messages are acked and retried one at a time rather than per batch, so one
unreadable PDF does not send four healthy documents round the retry loop with
it.

---

## U8. A failure with a reason beats a retry that cannot succeed

**Decided.** The `extract` consumer distinguishes two kinds of failure. An
`ExtractionFailure` — no text layer, an unparseable PDF, an object over the
cutoff — is written onto the row as `failed` with its reason immediately.
Anything else is retried up to `max_retries: 3`, and the dead-letter consumer
writes `failed` with a reason when the retries run out.

**Why.** Retrying a PDF that has no text layer three times produces the same
nothing three times and tells the reviewer four minutes later than we could
have. The DLQ consumer exists for the other case, and for the general rule: a
message that exhausts its retries with no dead-letter queue is deleted, and the
row it was about says "preparing" forever. DLQ messages themselves expire after
four days, so reading a dashboard is not a plan either.

---

## U9. `unpdf` under workerd: the spike was run, and it works

**Decided.** `unpdf@1.8.1` is a dependency of the Worker. It is a serverless
build of pdfjs with the Node-only paths removed; it loads in workerd and
extracts text from a real PDF. About 570 KB gzipped of the bundle, which takes
the Worker from roughly 335 KB to 909 KB gzipped against a 10 MB limit.

**Why this is recorded rather than assumed.** Section 4 of the plan marked pdfjs
under workerd **unverified** and left it as an M1 spike. The spike is
`test/worker/uploads.test.ts`, which parses a hand-written one-page PDF in the
Workers runtime on every CI run, so a runtime or library upgrade that breaks it
fails CI rather than quietly producing empty documents.

**Why the import is still dynamic and guarded.** A static import of a module
that fails to initialise under workerd makes the *whole Worker* fail to start —
every route, for a PDF parser. The guarded dynamic import makes that one
extraction fail with a reason instead.

**A scan with no text layer is a failure, not an empty success.** The file is
fine; there is simply no text in it. An empty document presented as extracted
would be a lie the reviewer cannot see, so it is `failed` with a reason they can
act on.

---

## U10. An attachment is soft-deleted; a Context source is not

**Decided.** `DELETE /w/:ws/attachments/:id` sets `status = 'deleted'` and
`deleted_at`, and removes the objects. `DELETE /w/:ws/files/:id` removes the
row.

**Why the difference.** A message may reference an attachment, and History has
to keep rendering: the viewer shows "no longer available" rather than a hole. A
Context source is a setting rather than history — it governs future runs, and a
tombstone in a settings list is noise.

Both delete the object *and* its `.txt`. Leaving the text behind would leave the
document's contents in the store under a key derived from the one just deleted,
which reads as done and is not.

---

## U11. No audit event kind for an upload, yet

**Decided.** Uploading, completing and deleting a file writes no `events` row.

**Why.** `events.kind` is a CHECK constraint whose values are the shared
`EVENT_KINDS` list, asserted equal by a test. Adding `attachment.*` means a
migration that alters the constraint, a change to the shared contract, a rule in
the run-log validator and a decision about whether the `agent` role may publish
it — none of which belongs in the same change as the storage layer, and the
`agent` role cannot publish anything outside `message.*` and `run.*` anyway.

**What it costs.** History does not show "Maya added policy.pdf". The row
carries `uploaded_by` and `created_at`, so the fact is not lost, only unindexed
by the audit.

**Would change it if.** The pilot's attestation needs uploads in History, which
is an M5a question.

---

## C1. `provider-keys.ts` owns the provider-key contract, not the port

**Repository wins.** The client-port spec sketches a `ProviderKey` row with
`verified_models` as a count. `packages/shared/src/provider-keys.ts` — written
for the M2 key routes — already defines `maskedProviderKeySchema`, where
`verified_models` is the list of model ids and `last4` and
`fingerprint_prefix` have exact lengths. The client consumes that shape;
`entities.ts` keeps the name `ProviderKey` only as an alias, and the Settings
tab shows `verified_models.length`.

**Why.** Two shapes with one name in one package index is an ambiguous
re-export, which is a compile error rather than a judgement call — and the
stricter shape is the one a route already returns.

The same rule renamed the client's cached step shape to `runStepEntitySchema`:
`events.ts` already exports `runStepSchema` for the `run.step` *event*, and the
two are different shapes.

---

## C2. The library exports three atoms, not twelve

**Found while porting.** The spec's M2 table adopts
`Button, Chip, EntityChip, StatusPill, ValuePill, Switch, SegmentedControl, ProgressRing, Shimmer, StreamText, TextRow`
from `@hermes/motion-components`. The package's `index.ts` exports only
`Button`, `StreamText` and `Shimmer`; the other atoms exist in `src` and have
type declarations, but are not in the export map, and the library is not ours to
edit.

**Decided.** Adopt what is exported, keep the rest in `src/app/ui/primitives.tsx`
(which the spec already keeps for `Popover, Dialog, Disclosure, Tip, Avatar,
Panel, MenuItem`), and record it here rather than reaching into
`node_modules/@hermes/motion-components/src`.

**Would change it if.** The library adds them to its index; the swap is then one
import line per atom.

---

## C3. `SidebarNav` renders the whole sidebar column, and the account menu stays local

**Decided.** `SidebarNav` is adopted as the spec requires: the six sections are
its `navItems`, the Inbox badge is `counts.inbox` (from `v_inbox_count`),
`recents` is the sessions page, and `workspace`/`footerLabel` come from
bootstrap. `onNavigate` and `onPick` dispatch the same `nav/app … manual: true`
every other control uses, so the follow rule keeps one code path.

What is *not* delegated is the account menu: the spec moves the reduce-motion
toggle there, and the component's footer is a single click target. So a slim
Nous-styled account row sits below it and carries the toggle, the settings
shortcuts and the dev account switcher.

---

## C4. `HermesMotionProvider` wraps the app in `.hermes-ui`

**Found while running.** The provider renders its own `div.hermes-ui`, so the
whole shell is a descendant of the library's CSS scope. Two consequences:

* the height chain from `#root` to the shell runs through that div, which has
  no height of its own — the shell collapsed to its content height until
  `#root > .hermes-ui { height: 100% }` was added;
* the seven tokens the two stylesheets share (`--ink`, `--line`,
  `--line-strong`, `--line-soft`, `--conversation`, `--panel`, `--ease-out`)
  resolve to the library's values inside the wrapper rather than the product's.

The library was authored for this product and its values match closely enough
that the rendered result is coherent (see `apps/client/qa/`), so they are left
as they are rather than re-declared on the wrapper — re-declaring them would
change how the library's own components look, which is the opposite of adopting
them. The build prints the overlapping names on every run.

**The duplicate-token check** the plan asks for is therefore the honest form of
the question: it fails the build if the library declares a custom property at
`:root`, `html`, `body` or `*` — a scope that could reach the product's own
elements — and otherwise lists the scoped overlap.

---

## C5. `erasableSyntaxOnly` is off, and `exactOptionalPropertyTypes` stays off

**Found while typechecking.** The spec asks for both. `packages/shared` uses
constructor parameter properties (`RestError`, the mock-stream `Builder`), which
`erasableSyntaxOnly` refuses; the client typechecks the shared sources directly
through `paths`, so the flag would fail on code that is not the client's. esbuild
transforms parameter properties correctly, so the flag buys nothing here.

`exactOptionalPropertyTypes` is off to match `tsconfig.base.json`, which the
worker and the shared package are already written against. Turning it on is a
repository-wide change, not a client one.

---

## C6. Mock server mode is a `fetch` and a socket factory, not a second server

**Decided.** `MOCK=1` builds the client with `__MOCK__` true, and the adapter is
handed `createMockBackend()`'s `fetch` and socket factory instead of the
browser's. Everything still goes through the same REST client and the same zod
parse, so a mock response that does not satisfy the contract fails in the
client's own tests rather than drifting quietly. The run stream is
`packages/shared`'s `mockRunStream`, so the difficult sequences are the
contract's own scenarios rather than a second set invented for the mock.

    MOCK=1 pnpm --filter client build     # bundle that needs no worker
    MOCK=1 PORT=4180 node build.mjs --serve

Query parameters pick the fixture: `?data=empty` for the first-run empty states,
`?seat=member` for the Member seat, `?key=none|invalid` for the provider-key
banners. `__MOCK__` is a build constant, so a production build eliminates the
module; the build then deletes the orphan chunk esbuild still emits for the
folded dynamic import, and greps `dist/app.js` for `x-dev-user` to prove the dev
switcher is gone too.

---

## C7. Opening a session loads one message window; "Load earlier" pages backwards

**Found while running.** Neither the bootstrap nor the event contract carries a
session's existing transcript: bootstrap lists sessions, and the socket carries
what happens next. So `openSession` fetches the most recent window once
(`GET .../messages?limit=100`) and `loadEarlier` pages backwards from
`oldestSeq`. Without it a reload showed an empty transcript for a session that
had one.

---

## C8. A decision refetches its request row

**Found while testing.** `decision.recorded` carries `resulting_status` and the
effect ids — enough for the badge and the list, not enough for the review pane,
which needs the whole row. The client therefore refetches the request after a
decision commits (`ensure(kind, id, force)`), rather than patching a status into
the cached row and hoping the rest still matches.

---

## C9. A `resync` event re-bootstraps; it is not only a cache drop

**Found while testing.** The reducer's `cache/clear` empties the entity cache and
the message windows, but the client then has no data at all. The adapter treats
a `resync` event — and a replay page with `{resync: true}` — as: drop the
caches, re-run `GET bootstrap`, re-attach both sockets. Drafts and UI state
survive it, including across the re-bootstrap, because the server has never seen
what someone typed.

---

## C10. The Playwright suite runs against mock mode; the system scenarios wait for the worker

**Decided.** `pnpm --filter client e2e` runs P1 to P3 from the spec's §11 table
against the mock bundle, plus a Member-seat check and a screenshot sweep. Those
are the scenarios that are about the *client*: the empty states, the triage
list, follow/pin, the review pane, the badge arithmetic.

P4 to P14 assert what the *server* does — two browser contexts racing one
decision, the guarded route refusing a Member, guidance mid-run, Stop, a
provider 5xx, a dropped socket, the share viewer's polling, the injection
fixture. They need `wrangler dev` with Docker Postgres, `AUTH_MODE=fake` and the
scripted provider, and they land with the M2/M3 worker routes. `E2E_BASE_URL`
points the same config at that server.

---

## C11. What the port deliberately left behind

The presenter, the intro slides, the "one week later" interstitial, the scripted
conversation engine (`conversation.mjs`), the fixtures and the seeded sessions.
The demo's local event log (`eventTime`, `uid('evt')`, the fabricated `events`
array) is gone with them: History reads `events` rows.

Three demo behaviours changed because the port fixed a bug the demo had:

1. `sameRef` compares `field`, so navigating from the blocker card to the
   destination field pins the view instead of being mistaken for "already the
   focus" (spec §4.6.1);
2. a receipt is written into the session that produced the request, not into
   whatever session happens to be active, and an inactive session shows an
   unread marker instead (spec §4.6.2);
3. an acknowledgement is a server message that exists only after the commit, so
   the demo's third bug — acknowledging before the state settles — is
   structurally gone.

---

# M3: the run engine

Numbering starts at 40 so that M3.5's attachments work, which was in flight at
the same time, keeps 37 to 39.

---

## 40. The engine publishes by handing rows to the hub, not by enqueuing a job

**Found while building.** Invariant 6 says every cross-system side effect after
a commit is a `jobs` row. The engine's side effects are event deliveries, and
`publishEvents` writes exactly such a row. But migration 0004 says
`REVOKE ALL ON jobs FROM agent`, and the Workflow runs on the `agent` role.

**Decided.** The engine writes `stream_events` in the same transaction as the
change, as every writer does, and then hands the committed rows to the
`SessionHub` itself by RPC. It enqueues no `publish` job. If that RPC is lost,
the rows are already committed and the client's reconnect path —
`GET /w/:ws/events?after=` — replays them.

**Why not widen the grant.** Because the grant is the invariant. "The agent role
has no INSERT on `jobs`" is one of the three sentences that make "the runtime
never decides" checkable, and the reason it is worth having is precisely that it
is inconvenient once. A job row is also a thing the agent could forge — a
`receipt` job carries a `decision_id` — so `jobs` is not an incidental
revocation.

**What is lost.** The outbox's "a connected client cannot miss a committed
event" becomes "a connected client cannot miss a committed event for longer than
one reconnect" for run events specifically. Route-written events (requests,
decisions, entity updates) keep the stronger property, because routes run as
`app` and do enqueue the job.

**Would change it if.** A `SECURITY DEFINER` function that enqueues only a
`publish` job for a range of `stream_events` ids in the current tenant turns out
to be worth the extra surface. It is a small function and it would restore the
stronger guarantee; it was not written because the weaker one is already the
behaviour every client sees after any disconnect.

---

## 41. Two consequences of an engine event are done by the Cron, as `app`

**Found while building.** Two things the plan asks for are writes the `agent`
role cannot make:

* a provider 401 marks the key row `invalid` — `workspace_provider_keys` is
  SELECT-only for `agent`;
* the run queue drains after a run finishes and pauses on Stop — `run_queue` is
  SELECT-only for `agent`.

**Decided.** The engine does the half it can: on a 401 it sets
`stop_requested` on the other working runs on that provider (it has UPDATE on
`runs`) and records `error.reason = 'key_invalid'` on its own run. The minute
Cron, which runs as `app`, then marks the key row invalid from that recorded
reason and drains the queue. The Stop route pauses the queue itself, in the same
transaction as the flag, so pausing is immediate; only the drain is on the
minute.

**What this costs.** Up to a minute between a 401 and the model menu saying
"Your key was rejected", and up to a minute between a run finishing and its
queued message starting. Both are visible in the UI as the state they actually
are, not as a lie.

**Why this is better than the alternative.** The alternative is one more grant
or one more `SECURITY DEFINER` function per consequence, and the list of
consequences only grows. Making the `app` role the place where an engine event
turns into a workspace-level change keeps the boundary in one direction: the
agent proposes and reports, and something with more authority acts on it. That
is the same shape as the decision route.

---

## 42. The engine is a function over an abstract `step`, not a Workflow method

**Decided.** `src/engine/engine.ts` exports `runAttempt(deps, step, input)`
against an `EngineStep` interface with `do` and `waitForEvent`. `RunAttempt` in
`src/runs/workflow.ts` wires the real `WorkflowStep`, a `PgAgentDb`, the
provider adapter and the SessionHub RPC, and does nothing else.

**Why.** The failure taxonomy is the part of this milestone most likely to be
wrong, and it is untestable inside workerd: there is no way to say "this step
fails at 40 percent of its stream, retries twice and then gives up" to a real
Workflow in a test. With a fake `step` that checkpoints results by name and
re-runs the body on a retryable throw, every row of the plan's table is a test
that runs in 300 ms with no network. What workerd then has to prove is much
smaller — the class registers, the RPC exists, `NonRetryableError` is real —
and `test/worker/runs.test.ts` proves exactly that.

**The cost.** Two step-option shapes to keep in sync, and a cast in the adapter
because `step.do` is typed to return `Serializable<T>`. The cast is one line and
sits next to the rule it depends on (step returns are ids only).

**A bug this shape caught immediately.** `step` is an RPC stub: pulling `do` off
it and calling `run.call(step, ...)` fails at run time with "the RPC receiver
does not implement the method call". The adapter now calls through the object.

---

## 43. Deltas are batched at 500 ms, and Stop rides the reply

**Decided.** The provider step accumulates text and flushes every 500 ms: one
`stream_events` row and one `SessionHub.forward` RPC per batch. The RPC's reply
carries `stop_requested`, and the engine also reads the row before every tool.

**Why.** The subrequest limit is per instance. The plan's rejected arithmetic is
twelve five-minute turns at one RPC per 250 ms — 14,400 against a 10,000
default. At 500 ms the same pathological run is 7,200 and a realistic
30-second-turn run is about 900. `test/unit/engine-config.test.ts` holds the
arithmetic so the number is checkable rather than remembered.

**Why Stop rides the reply rather than polling.** A separate poll doubles the
per-batch cost to buy nothing: the batch is already a round trip to the object
that holds the flag's cache.

**Note on the outbox id.** `stream_events` is INSERT-only for the `agent` role,
so `RETURNING id` is a read it may not do. The id comes from
`currval('stream_events_id_seq')` instead, which the role does hold
`USAGE, SELECT` on. `test/db/agent-db.test.ts` is the test that caught this, and
it is the reason that file exists at all: the in-memory `AgentDb` the engine
tests use would have passed with the wrong SQL forever.

---

## 44. `message.reset` carries a real message id, written before the first delta

**Decided.** The provider step upserts the assistant `messages` row with
`status = 'streaming'` and empty text *before* it starts the stream, so
`message.reset` and every `message.delta` name a real message id. The row is
keyed `(run_id, turn)`, so a step retry and a user Retry both replace it.

**Why.** The alternative was a synthetic id like `${run_id}:${turn}`, which the
event contract rejects — `message_id` is a uuid — and which would have made the
reducer maintain two id spaces. Writing the row first also means a crash between
the first delta and the end of the turn leaves a visible partial message rather
than nothing.

---

## 45. `run_turns` sequence numbers separate a turn's inputs from its answer

**Decided.** Within turn *N*: the tool results that feed it occupy seq 0, 1, 2…
in the order the model asked for them, a human's answer to `ask_for_context`
sits at seq 90, and the assistant's own message sits at seq 100.

**Why.** `run_turns` is keyed `(run_id, turn, seq)` and the first version wrote
both the opening user message and the assistant's reply at `(0, 0)`. Fixed
positions are the smallest thing that makes the ordering total, replayable and
obvious when reading a row by hand.

---

## 46. Blocks arrive in a fenced region, and the validator runs before anything renders

**Decided.** A model authors blocks by emitting a ```` ```hermes-blocks ````
fenced JSON array inside its text. The engine strips the fence from what the
human reads, runs the array through the shared `validateModelBlocks`, keeps what
passes and logs what does not with the command name.

**Why a fence rather than a tool.** A `render_block` tool would be a tool whose
whole purpose is to put a button in front of a human, and the forbidden-name
test would not catch a block carrying `decide` inside its arguments. Keeping
blocks in the text means every one of them goes through the same validator on
the same path, and there is exactly one path.

**The red-team test.** `test/unit/engine-redteam.test.ts` scripts a provider
emitting a `confirm` block carrying `request/decide` and asserts three things:
the block is dropped, no `decision.recorded` event exists in the outbox, and the
request the run proposed is still `pending`. The text survives, minus the fence,
so the human still reads the claim and can disagree with it.

---

## 47. `MODEL_SCRIPTED=1` is a development-only switch, asserted in two places

**Decided.** With `MODEL_SCRIPTED=1` the engine answers from `ScriptedProvider`
and resolves no key, so `wrangler dev --local` on a fresh checkout can run a
turn end to end with nothing in the key store. `providerFactory` throws unless
`ENVIRONMENT` is `development`, and `test/unit/engine-config.test.ts` asserts
that neither staging nor production sets the variable.

**Two things this caught.** A `ScriptedProvider` built per call rather than per
invocation replays script zero forever, which looks exactly like an agent stuck
in a loop until the turn cap stops it; and an agent with no
`agent_capabilities` rows gets no tools, which is right in a deployed
environment and useless in a freshly seeded one. The provider is memoised per
invocation, and the empty-capabilities fallback to the Work-mode tool set
applies only when `ENVIRONMENT` is `development`.

---

## 48. The M0 spike runs under vitest, and only when a key is in the environment

**Decided.** `apps/worker/scripts/spike.ts` performs the M0 spike against a real
provider: one streamed tool call, Stop measured against the 1 s budget, and a
reasoning replay. It runs with `pnpm spike`, which is `vitest run --project
spike`, and `vitest.config.ts` only defines that project when `HERMES_SPIKE_KEY`
is set.

**Why vitest rather than `node scripts/spike.ts`.** Node 26 strips types but
refuses parameter properties, which the provider adapters use throughout; vitest
is already a dependency and already knows how to load this repository's
TypeScript. Making the project conditional means CI, which never sets the
variable, cannot run the one file in this repository that touches the network —
and neither can `pnpm test` on a machine that happens to have a key exported.

**The key.** Read from `HERMES_SPIKE_KEY` and never written anywhere: not to a
file, not to a log line, not into an error message. The file says so at the top,
because the failure mode is somebody pasting a key into `.dev.vars` to make it
convenient.

---

# Series E — M3.5, the engine side

Numbered separately because M3.5 was built by three people at once; the E series
is the run engine's half (tools, allowlists, the classifier, the prompt and
`src/security/**`).

## E1. `fetch_url` is a module of its own, and the rules are written out

**Decided.** The tool in the registry is thirty lines; every rule lives in
`apps/worker/src/security/fetch-url.ts` and `ip.ts`, with the private ranges
enumerated in code rather than pulled from a library.

**Why the ranges are written out.** The list *is* the security property. A
dependency that dropped `100.64.0.0/10` in a minor release would be a silent
hole in the one check that stands between an uploaded document and a cloud
metadata endpoint, and the whole list is thirty lines. `::ffff:127.0.0.1` is
checked as IPv4, because an IPv4-mapped address is the oldest way past a naive
loopback test.

**Why a module and not a tool.** The tool's job is to turn a refusal into a
sentence a model can act on. Everything else — the deny list, the allowlist, the
resolution, the hop budget, the caps — is testable with no engine, no database
and no network, which is why `test/unit/fetch-url.test.ts` can carry both of the
plan's fixtures and still run in 40 ms.

**The residual risk, stated.** A Worker cannot pin a DNS answer to a socket.
We resolve, we check, and then `fetch()` resolves again on its own. Re-resolving
every hop narrows the window; it does not close it. The flipping-A-record
fixture documents the limit rather than pretending otherwise.

---

## E2. The allowlist lives in `workspace_settings.flags`, and empty means nothing

**Decided.** `flags.fetch_url_allowlist` is an array of domains an Admin
manages. No new table, and no grant change: the `agent` role already has SELECT
on `workspace_settings` (migration 0004).

**Why not a table.** One list per workspace, edited in Settings, read once per
`fetch_url` call. A table with one row per workspace and one column that matters
is a join in every read to answer a question a JSONB key already answers. If a
per-domain audit trail is ever wanted, that is the moment for a table.

**Why empty refuses everything.** A workspace that has not said where its agent
may read has said it may read nowhere. The alternative — empty means
unrestricted — is the configuration mistake that only shows up in the incident
report. A malformed flag (a string, a number, an object) also reads as empty,
for the same reason.

---

## E3. Modes are enforced by an intersection, and Plan prepares rather than writes

**Decided.** `allowedTools(mode, capabilityNames)` intersects the mode's tool
kinds with `agent_capabilities.tool_names`. Ask gets read tools only; Plan gets
Work's list but `executeTool` returns a `prepared` block for the four tools that
write; Work writes.

**Why the intersection.** It cannot widen in either direction: a mode cannot add
a tool the workspace did not configure, and a capability row cannot add one the
mode does not allow. An unknown mode string falls back to Work's *kinds*, still
intersected — a typo in a mode must not hand out tools nobody configured.

**Why Plan still validates.** A prepared `propose_request` runs the document
schema and the plain-text walk before returning. A plan whose payload would fail
when applied is not a plan; it is a failure moved to later, when the person has
already agreed to it.

**Why `ask_for_context` is not prepared.** It writes nothing — it parks the run
on a human answer — and a plan that cannot ask the question it needs answered is
not a plan. `set_focus` stays live in Plan for the same reason and is excluded
from Ask, where a pane that moves while somebody reads is something else
happening.

---

## E4. `runs.mode` is written at turn creation (migration 0011)

**Decided.** The mode is copied onto the `runs` row when the turn is created and
read from there. `PgAgentDb.loadRun` coalesces to the session's mode so a code
rollback still reads correctly on rows written before the column existed.

**The failure this prevents.** The engine used to join `sessions.mode` on every
`loadRun`. A person switching the selector from Plan to Work mid-run would have
changed what the run already in flight was allowed to do — the run would start
as a plan and finish by writing rows. "Plan writes nothing" is not a promise you
can keep if the answer is re-read every step.

---

## E5. The classifier labels; it never blocks

**Decided.** A deterministic pattern list (`src/security/injection.ts`) runs
over every tool result whose source is not `engine`, and adds `suspicion`,
`suspicion_rules` and a one-sentence reminder to the envelope. It never fails a
tool, never ends a run and never rewrites the data.

**Why deterministic rather than a model call.** A second model call inside a
tool step doubles the latency and the failure surface of every read; its input
is attacker-controlled text, so it is one more thing to inject; and a regexp
list is auditable — a reviewer reads the threat model in forty lines and a test
asserts each line.

**Why it must not block.** A classifier that can stop a run has false positives
that are outages, and one a model can argue with is not a control anyway. The
control is the human decision gate. Anthropic's own reporting puts residual
attack success near one percent even with training-level defenses, which is the
number that says this layer is worth having and also says it is not the last
one.

**The false-positive fixtures matter as much as the attacks.** An agent that
labels every CV "high" has taught everyone to ignore the label by Thursday, so
`test/unit/injection.test.ts` asserts silence on an ordinary application, an
ordinary invoice and a note that merely discusses approving something.

---

## E6. Plain text is refused at the writer, not escaped at the renderer

**Decided.** `plainText` and `findMarkup` in `packages/shared/src/plain-text.ts`
reject HTML tags, markdown links, angle-bracket autolinks, control characters
and bidi overrides. The tool schemas apply them to note bodies, instruction
bodies, context values and — by walking the parsed object — every string and
every key inside a proposal payload.

**Why the writer.** A renderer that escapes is one component away from a
renderer that does not, and that component will be the one somebody adds for
"just the invoice notes". A string that never reaches a row cannot be rendered
by anything.

**Why walk the payload instead of listing fields.** A document payload has forty
string fields across three kinds. Enumerating them in a second place is how the
two lists come apart; walking the parsed value covers a field added to
`documents.ts` next year on the day it is added.

**Why a bare URL is allowed.** It renders as text, it is not clickable, and
forbidding it would stop the agent citing where it read something — which is the
behaviour every other rule here is trying to encourage.

---

## E7. Late guidance is carried, not refused

**Decided.** Guidance typed after the run it was aimed at has finished is stored
on the session with `run_id` null; the route answers
`{status: 'next_message', copy: 'Applied to your next message'}` instead of a
409, and `PgAgentDb.loadGuidance` has the next run in that session read it
before its first provider step, at which point the row records which run finally
applied it.

**Why not a 409.** The person typed a sentence a fraction of a second after the
run stopped. Throwing it away to be technically correct about which run it
belonged to is the product being right at the user's expense; the copy the plan
names only becomes true if something carries it.

---

# M4: decisions, effects, receipts, History and documents

---

## D1. A conflict is a status code and a header, not a field in the body

**Decided.** Two tabs deciding the same request produce one `decisions` row. The
winner gets 201; the loser gets **200** with `X-Hermes-Conflict: true` and a body
holding the decision that exists. The body is exactly
`decisionResultSchema` — `decision_id`, `request_id`, `resulting_status`,
`effect_ids` — in both cases.

**Why not `conflict: true` in the body.** `decisionResultSchema` is `.strict()`
and the client parses every response against it (`apps/client/src/model/rest.ts`),
so a fifth key would fail to parse in the client and turn a handled race into a
`RestError`. The status code carries the same information, is the older
convention for it, and needs no contract change — which matters because
`packages/shared` is owned by the contract, not by one route.

**Why 200 and not 409.** The person in the second tab wants the outcome, not an
error about a race they did not know they were in. The demo's rule was that a
repeat or an opposite decision on a resolved request is *ignored*, and answering
with what is already true is the HTTP spelling of ignoring it.

**Would change it if.** The contract gains a decision-result envelope; then the
flag moves into the body and the header stays as a compatibility shim.

---

## D2. Five guards, and the two that mean nothing in `AUTH_MODE=fake`

**Decided.** `POST /w/:ws/requests/:id/decisions` checks, in order: an
allowlisted `Origin` (**required**, unlike every other state-changing route);
`X-Requested-From: inbox`; the double-submit CSRF token; an Admin session; and
step-up freshness of five minutes measured on `auth_sessions.authenticated_at`
for the caller's `sid`.

**How fake auth satisfies them in development.** `AUTH_MODE=fake` authenticates
with `x-dev-user`, so:

* **CSRF** is a no-op: `requireCsrf` returns immediately unless the mode is
  `workos`, because a foreign page cannot set a request header in the first
  place and a double-submit token would be checking a claim nothing makes. The
  guard is therefore tested in `workos` mode, against a real sealed cookie
  (`test/db/requests.test.ts`).
* **Step-up** is real even in fake mode: `fakeAuth` writes the same
  `auth_sessions` row the WorkOS adapter writes, keyed `dev-{user_id}`, with
  `authenticated_at = now()` the first time that `sid` is seen. So a fresh dev
  server decides successfully, and a dev session older than five minutes is
  refused with `reauth_required` exactly as production would refuse it. The
  development equivalent of `/auth/login?step_up=1` is
  `DELETE FROM auth_sessions WHERE sid = 'dev-<user_id>'`.
* **Origin** and **X-Requested-From** are unchanged in both modes: `curl` must
  send `Origin: http://localhost:8787` and `X-Requested-From: inbox`, and the
  README's walkthrough does.

**Why `Origin` is required here and optional elsewhere.** Everywhere else a
missing `Origin` is allowed, because `curl` and the tests are not browsers and
the cookie rules already cover the browser case. A decision is the highest-value
write in the product, and "the request did not say where it came from" is not an
answer worth accepting for it. The cost is that a non-browser client must set one
header; the test suite does.

---

## D3. `X-Requested-From` is not a security boundary, and is required anyway

**Decided.** The header is the fourth of five checks and is treated as what it
is: a statement by our own client about which surface issued the request, not
evidence about anything.

**Why keep it.** Two reasons, neither of which is "it stops an attacker".
First, a custom header forces a CORS preflight, so a cross-site form post or a
link cannot reach the route at all and the `Origin` allowlist gets to answer the
preflight. Second, it catches *our own* mistakes: a helper that replays a POST, a
future route that copies this one, a retry that fires from the wrong place. Those
arrive as a 403 with `reason: wrong_surface` rather than as a recorded decision
nobody made in the Inbox. The header lives in `src/domain/guards.ts` with that
argument written above it, so nobody later mistakes it for authentication.

---

## D4. Effects are planned from one table, and assigned away from the decider

**Decided.** `plannedEffects(kind, decision)` in `src/domain/effects.ts` is the
whole mapping: an approved application records one `access_grant`; an approved
invoice records `email_send` **and** `payment`; an approved agreement records
`signature` and `email_send`; every decline records none. Required role and
approval count come from `EFFECT_REQUIREMENTS` in `packages/shared`, so a payment
needing two `finance` holders is a contract fact rather than a literal in a
route. Rows are inserted `pending` with an `assignee_id`, and the assignment
query orders the decider **last**.

**Why two effects for an invoice.** "Created" is neither "sent" nor "paid", and
one row covering both would let a single approval imply both. The demo's receipt
said "Saved in Library · Not sent · No money moved": that is two absent things,
so it is two rows.

**Why the decider is assigned last.** An access grant or a payment carried out by
the same person who approved it is exactly the separation the reviewer roles
exist to create. Nothing *forbids* it — a one-Admin workspace has no alternative
and the query still assigns them — but the default should not hand it straight
back.

---

## D5. Every execution answers `unavailable`, and says so in a sentence

**Decided.** `POST /w/:ws/effects/:id/execute` records the attempt, sets
`status = 'unavailable'`, writes an `effect.executed` audit row, and returns
`EFFECT_UNAVAILABLE_REASON`: *"Not executed. This build sends nothing, pays
nothing, grants nothing and signs nothing."* A second press returns the same row
without appending a second audit row.

**Why not a stub that succeeds.** Because the entire approvals design is only
worth something if the row that says "not done" is telling the truth. A green
tick over an SMTP client that does not exist is worse than no button, and it is
the exact failure this repository is built to make impossible (CONVENTIONS,
invariant 5). The copy is one exported constant rather than three call sites,
because three copies of a promise drift.

**Guards.** Origin, CSRF, step-up, and the reviewer role the effect requires —
not Admin. Executing is not deciding; it is the separate act the decision handed
to somebody else.

---

## D6. History renders at read time; the counts are a second route

**Decided.** `events` holds ids and enum kinds only, so `GET /w/:ws/history`
joins each row to the subject rows it names and composes the sentence per
request. `GET /w/:ws/history/counts` is separate and reads
`v_decision_count`, `v_pending_grants`, `v_inbox_count` and
`v_created_documents`.

**Why read-time rendering.** It is the thing that makes erasure survivable. After
`redact_subject`, the request's label *is* `Deleted applicant` and its payload
*is* `{kind, redacted}`, so the same join produces "Maya admitted a deleted
applicant" and the page still renders — with no second code path and no stored
sentence to go back and rewrite. A test redacts a subject and asks for the page.

**Why the counts are not in the page.** `paginatedSchema(eventRowSchema)` is
`.strict()` and names three keys. It is also the better shape: the page changes
as you scroll and the counts do not, so a client backscrolling would otherwise
re-ask four aggregate questions it already knew the answers to.

**`blocked` is derived from the present.** The tab filters on the *current*
status of the subject rows — a request still `pending`, an effect still `pending`
or `assigned` — never on a flag stored on the event. An event is a fact about the
past; "is this still blocked" is a question about now.

---

## D7. `@react-pdf/renderer` under workerd: the spike was run, and the answer is no

**Found while building.** The plan lists it as **unverified**. It was installed,
imported and run inside the `worker` project (real workerd, the real
`wrangler.jsonc`). The library loads, the element tree builds, and then:

```
failed to asynchronously prepare wasm: CompileError:
WebAssembly.instantiate(): Wasm code generation disallowed by embedder
```

`@react-pdf/renderer` lays text out with `yoga-layout`, which ships its
WebAssembly as a base64 string and compiles it at runtime. Workers allow
WebAssembly only as a statically imported module in the bundle, so no export
condition of that library is reachable here. (`renderToBuffer` fails earlier and
differently — workerd resolves the browser condition, whose `renderToBuffer`
throws "a Node specific API" — but `pdf().toBlob()` reaches the same wall.)

**Decided.** The `renders` consumer renders a self-contained HTML file, stores it
at `w/{workspace}/documents/{document}/v{version}.html`, and writes **two**
statuses: `render_status = 'ready'`, because the render is real and complete, and
`pdf_status = 'unavailable'` with the reason above, because the PDF is not. The
dependency is not in `package.json`: shipping a library that cannot run to prove
it cannot run is weight, and this entry is the artefact.

**Why two columns.** One column with two meanings would have made the viewer say
"Rendering failed" about a document that renders perfectly well. The contract's
`pdf_status` has no `unavailable`, so the API maps it to `none` and puts the
sentence in `pdf_error` — the client then shows an explanation rather than an
error it would be wrong to retry.

**Would change it if.** yoga-layout gains a build that imports a `.wasm` module
statically, or the render moves to a service binding (a browser-rendering Worker,
a container) that is allowed to compile WebAssembly.

---

## D8. The render is a `jobs` row *and* a queue message

**Decided.** The decision's transaction writes a `render` job keyed
`render:{document_id}:{version}`. The job's runner sends the queue message. The
queue consumer does the rendering.

**Why both.** They do different jobs. The `jobs` row commits with the document,
so a render cannot be forgotten and the minute Cron retries the *send* until the
queue accepted it (invariant 6). The queue gives the work its own retries, a
dead-letter queue, and a consumer that is not holding a request open. Rendering
directly in the job runner would tie an HTML build to whichever request happened
to commit the decision; enqueuing directly from the transaction would send a
message about a row that might roll back.

---

## D9. The receipt derives its count when it is written, not when it was queued

**Decided.** The `receipt` job posts two messages into
`requests.session_id` — a `human` line and Iris's acknowledgement — and reads
`v_inbox_count` inside its own transaction to say "Three requests remain."

**Why not carry the count in the payload.** It would be the count at decision
time. Four decisions in quick succession would leave four confident, wrong
numbers in the transcript, and the transcript is the thing a person scrolls back
through to work out what happened.

**Idempotency, twice over.** `UNIQUE(kind, key)` on `jobs` with the key naming
the decision, and `client_id = receipt:{decision_id}:{role}` on the two messages
under `UNIQUE(session_id, client_id)`. The existence check runs *before*
`next_seq` is allocated, so a replay does not leave a gap in the session's
sequence numbers. A duplicated receipt is not cosmetic: it reads as a second
decision.

**The originating session, not the active one.** The request was proposed in one
conversation and the receipt belongs there, even when the person who decided it
was looking at another. A test writes a second, more recently active session and
asserts nothing lands in it.

---

## D10. A derived `subject_id`, so an erasure can find what the engine keyed by name

**Found while building.** `redact_subject(subject_id, workspace_id)` erases by
`subject_id`. The run engine writes only `subject_key` — the hashed, normalised
applicant identifier — and leaves `subject_id` null, so a data subject access
request had a key and no way to reach the rows.

**Decided.** Migration 0010 adds `subject_id_for(workspace_id, subject_key)`
(`md5(workspace || ':' || key)::uuid`, deterministic and tenant-scoped, needing
no extension) and a `BEFORE INSERT` trigger on `requests` that fills
`subject_id` from `subject_key` when it is null. `DELETE
/w/:ws/applicants/:subject_key` resolves the key to ids — falling back to the
function for rows written before the trigger existed — calls the procedure per
subject, and deletes the document prefixes from R2 *after* the commit.

**Why a trigger rather than a fix in the tool.** The tool is one writer of
`requests`; a trigger covers every writer, including the next one. And the whole
point of the erasure inventory is that it cannot depend on a future author
remembering.

**What it does not reach.** Attachments hang off a session rather than a subject
and have no per-person link to follow; they are covered by workspace deletion,
and Settings > Data and privacy says so.

---

## D11. The Library shows a pending request as a version 0 draft

**Decided.** `GET /w/:ws/documents` returns two kinds of row: pending `invoice`
and `agreement` **requests**, shaped as documents with `version: 0` and
`status: 'Draft · Awaiting review'`, and real `documents` rows, which exist only
after a decision approved one.

**Why no `documents` row before the decision.** The document is created *by* the
decision. A row written earlier would mean the Library held a saved document for
something nobody had approved, and the trigger in migration 0005 would then be
guarding a table that had already leaked the thing it was protecting. Version 0
is the tell a reader can use: a proposal has no version, because nothing has been
approved to be version 1 of.

**Versions and the render are sibling routes** (`/documents/:id/versions`,
`/documents/:id/render`) rather than keys in the entity, for the same reason as
D1: `documentEntitySchema` is `.strict()`.

---

# C12–C24: the client against the real Worker

Written while wiring `apps/client` to `wrangler dev --local` with `AUTH_MODE=fake`
and `MODEL_SCRIPTED=1`. Everything here is a place where the built server and the
client-port spec disagreed. The rule followed throughout was the brief's: the
server as built wins, the client adapts, and where the server looks wrong it is
recorded rather than changed.

---

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

## C34. Focus belongs to the field, not to a bright ring inside it

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

## R1. An OpenRouter catalog id is `openrouter:<vendor>/<model>`

**Decided.** `catalog.model_id` for a synced row is the provider's own id behind
one prefix: `openrouter:anthropic/claude-sonnet-4.6`. `openRouterCatalogId` and
`openRouterModelId` in `packages/shared/src/catalog.ts` are the only two places
that know, and the adapter strips the prefix before the request is built. The
column's contract widened from 64 to 128 characters, because OpenRouter already
publishes ids longer than 64 once prefixed.

**Why.** Three reasons, and only the third is the deciding one.

`catalog.model_id` is a single global primary key across every provider, and
OpenRouter re-exports ids other providers also publish. Today
`anthropic/claude-sonnet-4.6` collides with nothing; the day we add an Anthropic
row whose id is that string, or OpenRouter brokers something called `gpt-5-5`,
an unprefixed scheme has a primary-key conflict between two rows that are billed
to different accounts and reached over different transports.

Second, `model_calls.model_id` and `runs.model_id` are what somebody reads in
six months to answer "who paid for this". A prefixed id answers that without a
join to `catalog`, which matters because `catalog` is mutable and the run rows
are not.

Third, and the reason the alternative was rejected: the obvious alternative is
to store the raw id and let `provider` disambiguate. That works until you write
the *client*, where a model id travels alone — in a session row, in a URL, in a
menu's selected value — and every consumer would have to carry the provider
alongside it or look it up. One string that is self-describing is a smaller
contract than two that must stay together.

**Would change it if.** OpenRouter's ids ever collided with each other, at which
point the prefix is not enough and the id has to be a surrogate key with the
provider id as an attribute.

---

## R2. `openrouter_chat` is its own transport, not a second `deepseek_chat`

**Decided.** A fourth value in `TRANSPORTS`, a fourth adapter, a fourth case in
`providerForTransport`. Both speak OpenAI-compatible Chat Completions.

**Why.** The transport enum in this product does not mean "wire format", it
means "replay rules" — that is the sentence in `model/types.ts`, and it is what
makes the enum worth having. OpenRouter's rules differ from DeepSeek's in all
three places the interface cares about:

* Reasoning comes back as `reasoning_details`, an ordered array of typed blocks,
  and the docs require the whole consecutive sequence back unchanged. DeepSeek's
  is one `reasoning_content` string. See R3.
* The knob is `reasoning: { effort }`, not `reasoning_effort`.
* 402 means the workspace's OpenRouter account is out of credits, which no other
  provider in this product can say and which no other status maps to.

Sharing an adapter would have meant a `if (this.provider === 'openrouter')` in
six places inside `deepseek.ts`, which is the shape a second provider always
takes just before it becomes a third.

The duplication is real and it is priced: `toChatMessages`, the tool-call
reassembly and the usage read are near-copies. They are near-copies that are
free to diverge, which is the property that matters when the divergence is the
whole reason the file exists.

**Would change it if.** A third OpenAI-compatible broker arrives with the same
reasoning shape, at which point there is a shared base worth extracting because
there would be two things to share it between rather than one.

---

## R3. Reasoning is replayed as `reasoning_details`, in order, untouched

**Decided.** A fourth `ReasoningCarry` variant,
`{ kind: 'openrouter_reasoning_details', details }`, carrying the array as it
arrived. The adapter refuses a carry another transport produced rather than
coercing it, exactly as the other three do. `ReasoningDetail` is an open
interface with an index signature.

**Why.** The reasoning-tokens documentation is explicit: pass the assistant
message's `reasoning_details` back, and "the entire sequence of consecutive
reasoning blocks must match" — no rearranging. The blocks are typed
(`reasoning.text`, `reasoning.summary`, `reasoning.encrypted`) and an encrypted
one is opaque by construction, so there is no version of "normalise it" that is
not "drop some of it".

Two details are worth stating because they are where this goes wrong:

The deltas and the carry are separate events, as they are for every other
transport. `reasoning` (the plaintext string) is what a person reads and is
emitted as `reasoning_delta`; `reasoning_details` is the protocol and is emitted
once, at the end. A reducer that confused them would replay prose, which fails
on the *next* turn of a tool-using run and looks like a model problem.

The blocks accumulate by `index`: the same index across frames is one block
whose text is being appended to, and `data` is replaced rather than appended
because it arrives whole. A block that arrives with no index at all gets the
next one, so a provider that omits it does not collapse three blocks into one.

**Would change it if.** OpenRouter offered a documented normalised form that
round-trips every upstream's requirements. `reasoning` (the string) looks like
that form and is not: the docs recommend the array for tool-calling, which is
every run this product makes.

Cited: <https://openrouter.ai/docs/use-cases/reasoning-tokens>,
<https://openrouter.ai/docs/api-reference/streaming>.

---

## R4. 402 is permanent with copy, 502 and 503 are transient

**Decided.** `openRouterError` maps the documented table onto the existing
failure classes: 401 → `auth`, 402 → `permanent` as an `OpenRouterCreditsError`
whose message names credits and the page to add them, 403 → `auth`, 408 →
`transient`, 429 → `rate_limit`, 502 and 503 → `transient`, everything else
through the shared `classifyStatus`. A frame that carries an `error` object
mid-stream is mapped the same way instead of ending the stream quietly.

**Why.** Two of these are not the default and both are load-bearing.

`classifyStatus` already turned 402 into `permanent`, which is the right class:
retrying a request that was refused for want of money cannot succeed. What it
did not have was copy. "openrouter responded 402" tells an Admin nothing they
can act on, and the body cannot be quoted — `http.ts` refuses to carry provider
prose into an error string, for good reasons about keys ending up in logs. So
the copy is a constant of ours: the account is out of credits, add credit at
openrouter.ai/credits, run again.

502 and 503 would otherwise be `transient` anyway by the `>= 500` rule; they are
called out because on OpenRouter they mean something specific — the chosen
upstream is down, or no provider meets the routing requirements — and both are
worth retrying against a different upstream, which is what OpenRouter does on
the retry.

The mid-stream case is the one that would have been missed. OpenRouter can
answer 200, stream a few tokens, and then put a failure in the stream. Without
the check, a moderation block or an upstream dying halfway reads as a short but
successful answer, and the run completes with a truncated message nobody knows
is truncated.

**Found on the way.** `errorFromResponse` read `error.code` and passed it to
`redactString` without checking it was a string. OpenRouter's `error.code` is
the HTTP status as a *number*, the regular expression happily coerced it, and
`redactString` threw a `TypeError` from inside the error path — so every non-2xx
from this provider would have surfaced as a crash rather than a classified
`ProviderError`. One line, and a test for each status.

**Would change it if.** OpenRouter publishes a `Retry-After` we should honour
rather than leaving to the Workflow step's own backoff.

Cited: <https://openrouter.ai/docs/api-reference/errors>.

---

## R5. Attribution headers are constants, not configuration

**Decided.** `HTTP-Referer` and `X-Title` are two module constants in
`openrouter.ts`, sent on every request including the verification probe.

**Why.** They identify the *product*, not the deployment: a workspace looking at
its own OpenRouter dashboard should see one app name, whether the request came
from staging or production. Making them vars would mean a header assembled from
configuration on the one request in this codebase that also carries a customer's
credential, and a header is a place a value ends up somewhere it is logged.

**Would change it if.** A customer asks for their own attribution, at which
point it is per-workspace data and not configuration either.

---

## R6. The catalog is synced on verification, by a SECURITY DEFINER function

**Decided.** A successful OpenRouter verification fetches `GET /api/v1/models`
and writes the usable rows into `catalog` with `source = 'provider_list'`. The
write is one statement, `SELECT sync_openrouter_catalog($1, $2)`, and that
function is `SECURITY DEFINER`: `app` keeps its SELECT-only grant on `catalog`.
The weekly reverify job runs the same sync.

**Why the function rather than a grant.** `GRANT INSERT, UPDATE ON catalog TO
app` is one line and it is the wrong line. The catalog is the file that says
what a model costs, and "a price change is a new migration, so the change is
reviewable" is a property of this system that a route with UPDATE on the table
quietly ends. The function's body cannot name a provider other than
`openrouter`, and its upsert has `WHERE catalog.source = 'provider_list'`, so no
payload — hostile, malformed or merely wrong — can rewrite a seeded row. The
grant assertion in `test/db/grants.test.ts` still reads `catalog: ['SELECT']`,
which is what a reviewer looks at.

**What the sync refuses, and why it refuses quietly.** A row whose `prompt` or
`completion` price does not parse is skipped, not defaulted to zero — a
free-looking model that is not free is the error nobody catches until the
invoice. A row that cannot take text in and produce text out is skipped. A row
without tool calling is *written* and greyed with a reason, because every run in
this product calls a tool and a model you can see and cannot pick is better than
one that is mysteriously absent. The counts are returned and the Settings screen
shows the written one.

**What it does to a row that disappears.** Disabled with a reason, never
deleted: `sessions.model_id`, `runs.model_id` and `model_calls.model_id` all
reference `catalog`, and a session that named a model last week still has to
render.

**Where it is not.** Not in the verification transaction. The list is a call to
a third party and Hyperdrive pins a Postgres connection for the life of a
transaction, which is the same read-probe-record shape the rest of `keys/` uses.
And a sync that fails does not fail the verification: the key is good, the
catalog is stale, and the Settings row says when it last synced.

**Would change it if.** The list grows past what one statement should carry, at
which point it is a job with a cursor rather than a call.

---

## R7. The key row carries a count and a date, not the model list

**Decided.** Two new columns on `workspace_provider_keys`,
`synced_model_count` and `models_synced_at`, both null for every provider whose
`verified_models` is the whole answer. An OpenRouter key's `verified_models`
stays empty.

**Why.** `verified_models` is a `text[]` that the Settings screen renders and
every masked-key response carries. Several hundred ids in it would be a payload
nobody reads, on a route that is called on every Settings open. The count and
the date are what a person actually wants to know — "342 models synced · last
sync 15 Mar" — and the list itself is already in the catalog, where the model
menu reads it with search and paging.

They are recorded by their own function rather than by `setKeyStatus`, because
they are a different fact with a different lifetime: a key can verify without a
sync, and a stale count surviving a later failed verification would claim models
the workspace can no longer reach.

**Would change it if.** A second provider needs a list this long, at which point
the two columns want to be one `sync` jsonb rather than a pair per provider.

---

## R8. `GET /w/:ws/catalog` is paged and searched in SQL

**Decided.** `?q=`, `?provider=`, `?limit=` (50 default, 200 max) and `?after=`,
answering `{ models, total, next_cursor }`. `loadCatalog` — every row — still
exists for the places that know the count is small. Bootstrap now carries only
the seeded rows plus whatever this workspace's live sessions name.

**Why.** Before OpenRouter the table had four rows and returning all of them was
the simplest thing that could work. A workspace with a synced key has several
hundred, and there are two payloads that would quietly become large: the model
menu on every open, and `bootstrap` on every page load. The second is the worse
one, because nobody would notice it in a menu they only open sometimes.

The search runs in SQL rather than over a list the client already has, because
the list the client already has is one page of it. `position(lower(...))` rather
than `LIKE`, because the needle is user text and escaping `%` and `_` in it is
one more thing to get wrong.

**Found on the way.** The first version passed `workspaceId` as `$1` to both the
page query and the count query. The count query does not mention a workspace, so
Postgres refused to infer the parameter's type and the whole call failed with
42P18. The filter's placeholders are now numbered from `$1` and the workspace id
is appended last, for the page query only.

**Would change it if.** Someone wants to sort by price, at which point the
cursor cannot be `model_id` and becomes a composite.

---

## R9. `PATCH /w/:ws/sessions/:id` accepts `model_id`, and validates it

**Decided.** The patch route takes `model_id`, checks the catalog has it, and —
outside `MODEL_SCRIPTED` development — checks this workspace may actually run
it: not disabled, has tool calling, and has a verified key for its provider.

**Why.** It did not take it. The composer has sent `{ model_id }` on every model
pick since M3, the route answered 422 `empty_patch`, and the client swallowed it
with `.catch(() => undefined)`. Nothing broke, because the turns route carries a
`model_id` of its own and re-sent it — so picking a model and immediately
sending a message did the right thing, and picking a model and reloading the
page put the old one back.

With four models that was a curiosity. With three hundred it is a lie: you
search a long list, pick something specific, the menu shows it selected, and the
session did not keep it. That is the sort of bug that makes people stop trusting
a control.

Validated against what the workspace may run rather than against mere existence,
because a session pointing at a model the turns route will refuse is a failure
moved from the moment of the choice to the moment of the work.

**Would change it if.** Nothing. This is the route the client always thought it
was calling.

---

## R10. The model menu is searched and paged, and pinned rather than virtualised

**Decided.** `apps/client/src/app/chat/ModelMenu.tsx`: a search box that queries
the server, rows grouped by vendor prefix with a sticky heading, 60 rows a page
behind "Show more", price per million and context window on each row, the
workspace default marked "Company default", the effort control only for a model
with `supports_reasoning`, a tool-less model greyed with its reason, and
arrow-key navigation over the options.

**Why a component.** It was eight lines inside `Composer.tsx` because the
catalog was four rows. What changed is not the size of the list but what the
control *is*: not a list to read, but a thing to search.

**Why paged and not virtualised.** Virtualising is faster and is not free: it
breaks find-in-page, it breaks the roving focus, and it is a dependency or a
hundred lines of scroll maths. Sixty rows render in under a frame. If a single
vendor group ever needs three thousand rows visible at once, this is the line to
revisit.

**Why the grouping is a pure exported function.** `groupByVendor` is the
judgement the component makes about a list whose shape it did not choose, and
getting it wrong is silent — a row in the wrong group is just a row somebody
cannot find. It has a unit test; the rendering is covered by the live scenario.

**One thing worth naming.** Picking a row also upserts it into the client's
`catalog` entity cache. The composer's own button label reads that cache, which
is seeded from the deliberately-trimmed bootstrap, so a row picked out of the
paged list would not have been in it — and the button under the menu would keep
showing the old model until the next page load, which reads as the pick not
having worked.

**Would change it if.** The catalog grows a second axis worth browsing by
(modality, say), at which point the vendor headings become a filter row.

---

## R11. The OpenRouter verification fixture, and why it is a var

**Decided.** `OPENROUTER_FIXTURE=1` makes the Worker answer OpenRouter's `/key`
and `/models` from a built-in six-model fixture. Refused unless
`ENVIRONMENT=development`, opt-in per deployment, set in `wrangler.jsonc`'s
development vars only, and asserted absent from staging and production by the
same test that guards `MODEL_SCRIPTED`.

**Why it exists.** The deliverable asks for a live scenario that adds a key,
verifies it, syncs a catalog and picks one of the synced models in the real
client against the real Worker — with no network and no key. `MODEL_SCRIPTED`
already covers the *run*; nothing covered *verification and sync*, which is the
half this milestone is about.

**Why a fixture and not a mocked fetch in the test.** The test drives a browser
against a Worker in another process. There is no seam in the test to inject.

**Why it is safe enough.** It serves a fixed fixture no caller can influence, so
it is not a way to write arbitrary catalog rows; it answers 501 to anything but
the two endpoints, so a run that reached for it fails loudly rather than
answering fiction; and it is behind two independent gates, one of which is the
environment name the code already trusts for `MODEL_SCRIPTED`. The README says
it exists, in the section a person reads before adding a key, so nobody
discovers it by grep.

**Would change it if.** A staging environment ever wants to rehearse the
OpenRouter flow, at which point it needs a real key in Secrets Store and not
this.

---

## R12. OpenRouter is the only provider, and the rule is one variable in one module

**Decided.** `ALLOWED_PROVIDERS` is a Worker variable, `openrouter` in all three
environments in `wrangler.jsonc`, unset means `openrouter` rather than
everything, and `apps/worker/src/model/allowed.ts` is the only module that reads
it. Five places ask it the same question:

* installing, verifying or rotating a key (`routes/keys.ts`) → 422
  `provider_not_allowed`, "Only OpenRouter keys can be used in this workspace";
* `GET /w/:ws/catalog` and `bootstrap` → rows of other providers are not in the
  payload at all;
* `PATCH /w/:ws/sessions/:id` and `PATCH /w/:ws/settings` → the same 422 when a
  client names a model by id;
* `POST …/turns` → the same 422, and unlike the key check it is asked under
  `MODEL_SCRIPTED` too.

The four seeded rows stay in the `catalog` table and the other three adapters
stay in `src/model/`. `loadCatalog` *marks* them `provider_not_allowed`;
`loadCatalogPage` with `onlyAllowed` *drops* them.

**Why a variable and not a constant, a CHECK or a deleted adapter.** Three
alternatives, and each loses something that is still needed.

Deleting the adapters loses the tests. `deepseek_chat`, `anthropic_messages` and
`openai_responses` are where the per-transport reasoning-replay rules of
decision 26 are actually exercised, and those rules are the reason the transport
enum exists at all. `ScriptedProvider` drives them still.

A database CHECK loses the history and the future. `model_calls` rows from last
month reference `deepseek-flash`, `sessions.model_id` and `runs.model_id` are
foreign keys into `catalog`, and a row that cannot exist is a row those cannot
point at. And relaxing a CHECK for a customer who brings an Anthropic account is
a migration and a deploy, where this is a `wrangler deploy --var`.

A constant in code loses the ability to say so per environment, which is the
form the next request for this will take — a pilot that is OpenRouter-only and a
customer deployment that is not.

**Why unset means OpenRouter rather than everything.** A variable that widens
when it goes missing is a variable that widens during exactly the incident where
nobody is reading configuration. The fallback is the documented product, and a
unit test asserts the value in all three environments, because an environment
disagreeing with the other two is the deployment nobody meant to make.

**Why the catalog route drops the rows and `loadCatalog` keeps them.** They
answer different questions. A menu of models nobody can pick is what teaches
people to stop reading a menu, so the list has none. But the settings route is
handed a `model_id` by a client and has to say *why* it will not take it, and
"the catalog does not offer that model" sends an Admin looking for a row that is
right there. So the marking exists for the refusals and the filter for the list.

**Would change it if.** A customer brings their own vendor account, at which
point the variable grows a second name and the four seeded rows come back into
the menu on their own.

---

## R13. A fresh workspace starts on Sonnet 5, and a stale default is moved on verification

**Decided.** `DEFAULT_MODEL_ID` is `openrouter:anthropic/claude-sonnet-5`.
Migration 0016 writes a placeholder `catalog` row for it with
`source = 'provider_list'` and makes it the `workspace_settings.default_model_id`
column default. `promoteDefaultModel`, called inside the same transaction as
every OpenRouter catalog sync, moves a workspace whose default is not allowed,
not enabled or tool-less onto Sonnet 5 — or onto the first tool-capable row if
that account cannot reach it — carrying its unarchived sessions with it and
writing one `settings.changed` events row.

**Why a placeholder row rather than "no default".** `default_model_id` is a
foreign key into `catalog`, and the row it has to name does not exist until a
key has been verified and a list synced. The alternatives were a nullable column
— which every reader would then have to handle, for a state that lasts minutes —
or leaving the default on `deepseek-flash`, which is the bug: the composer would
refuse the first message of a new workspace with "Add a deepseek key in Settings
to start", about a provider the Settings screen no longer offers.

`source = 'provider_list'` and not `'seed'`, deliberately: a seeded row is one a
sync may never overwrite (decision R6), and this one *must* be overwritten. Its
price is Anthropic's published Sonnet figure rather than zero, because a row
that says free and is not is the error nobody notices until the invoice — and
the first sync replaces every column of it anyway.

**Why the promotion is on sync and not on read.** Bootstrap is a GET, and a GET
that writes makes "has this workspace ever changed a setting" unanswerable. The
sync is the only moment that is both a write and the moment the rows the new
default names come into existence. It also means the weekly reverify job fixes a
workspace nobody has touched.

**Why it carries the sessions.** A session's model is copied from the default
when it is created, not joined at read time (that is deliberate — a person
switching mid-run must change the next run, not this one). So moving only the
default would leave a workspace full of sessions naming a model every turn is
refused for, and the person would have to re-pick a model in each one. Archived
sessions are left: nobody is going to run one, and rewriting them would edit
history to no purpose.

**What it will not do.** It never overrules a default that is already runnable.
An Admin who chose Gemini keeps Gemini through every later sync; a sync is not a
reason to overrule somebody's choice.

**Would change it if.** OpenRouter ever stops listing a Sonnet, at which point
the preference is a list rather than one id — the fallback already handles it,
but silently, and a list would say so.

---

## C33. The Iris panel has three states, and a rail is the middle one

**Decided.** `ui.irisOpen: boolean` is gone. `ui.irisPanel` is `open | rail |
hidden`, `ui.irisWidth` is a nullable number of pixels, and `ui.irisUnread` is a
count.

* **OPEN** — the chat pane at the remembered width. With nothing remembered the
  demo's rule applies unchanged: 800 px at 1840 and wider, an equal split of the
  work area below it. Minimum 420 px, maximum 60 percent of the work area.
* **RAIL** — 56 px between the navigation and the app, carrying the Iris mark in
  its live run state, an unread badge, "Open Iris ⌘L", and New session and
  Sessions, both of which open the panel before they act.
* **HIDDEN** — no rail. The app header's "Open Iris" is the way back, which is
  the control that was already there.

`iris/toggle` still works, and still means what its callers meant: `open: true`
opens, `open: false` goes to the *rail* rather than to nothing, and no argument
is open↔rail. From `hidden` it can only open — hiding completely is a deliberate
choice and a toggle does not half-undo one. The preference is persisted per
workspace and user, beside drafts and for the same reason; `hermes:iris-open`
is migrated once and deleted, with `false` becoming `rail`.

**What was borrowed, and from where.** Fifteen minutes of reading, and four
things worth taking:

1. **One shortcut, and it is ⌘L.** Cursor binds both `Cmd I` and `Cmd L` to
   "Toggle Sidepanel" (https://cursor.com/docs/reference/keyboard-shortcuts).
   Two keys for one action is two things to document; we took the one that is
   already in people's hands and left ⌘I alone.
2. **A persistent affordance to reopen, and it is an icon strip.** Codex's IDE
   extension tells you to "choose the Codex icon" and, failing that, to run
   "Codex: Open Codex Sidebar" from the Command Palette
   (https://learn.chatgpt.com/docs/codex/ide) — the icon is an activity-bar
   entry, which is a 56 px rail. ChatGPT's desktop app toggles its sidebar with
   `⌘ + B` and leaves the rail behind
   (https://learn.chatgpt.com/docs/reference/commands). A panel that closes to
   nothing is a panel people lose.
3. **The collapsed affordance reports state.** Cursor puts "an orange dot on
   that tab" when a chat is awaiting input (https://cursor.com/changelog/0-48-x).
   Our rail does the same with a number on it, and the mark itself keeps the
   run's own state rather than going flat.
4. **"Hide it completely" belongs in an overflow menu.** Cursor added "a 'More
   Actions' ellipsis to hide the chat and configuring positioning directly"
   (https://cursor.com/changelog/2-3). Ours is in the session options menu, one
   level away from the ordinary Hide.

Two things were deliberately **not** borrowed. Cursor's multiple chat tabs
(`Cmd T`, `Cmd [`, `Cmd ]` — same source) and its Agents Window, which runs up
to eight agents in parallel (https://cursor.com/changelog/2-0,
https://cursor.com/changelog/3-0): this product has one Iris per session and a
Sessions popover that already does the switching, and a tab strip would be a
second session model beside the one the server has. Nothing in either product's
official documentation says whether the pane is resizable or how wide it
remembers being, so the width rules here are the demo's and ours.

**Why a rail rather than a narrower chat pane.** The failure a collapse has to
avoid is not "the chat is small", it is "the chat is gone and I did not mean
that". 56 px is too narrow to read and wide enough to say *something is
happening and here is how to get back* — which is the whole job. Below 1000 px
there is no room for even that beside a usable app pane, so the rail is not
shown there and the existing Chat/App switch is unchanged.

**Two things this touched that were not obvious.**

* `is-compact` used to be a fact about the *window* (`< 1560`), which was the
  same thing as a fact about the chat pane while the chat pane was always half
  of it. It is not any more: a 460 px pane in an 1840 px window needs the tighter
  paddings whatever the window says, so it is now either.
* **The app pane keeps a measure.** Collapsing hands the app 1544 px at 1840,
  and a dashboard at 1544 px is not a better dashboard — it is the same rows
  with a person's name at one edge and the button that acts on them at the
  other. The pane caps its content at 1180 px and grows its gutters, applied to
  the header, the subheader and the body together so nothing drifts out of line.
  `padding-inline: max(28px, calc((100% - 1180px) / 2))` costs nothing in the
  open layout, because at an 800 px pane the second term is negative.

**One judgement inside the shortcut.** ⌘L fires from anywhere in the shell
*except* an editable element — a shortcut that steals a keystroke mid-sentence
is a shortcut people turn off. The composer is the one exception: there it still
collapses, and focus moves to the app pane, because leaving focus inside a pane
that is about to be 56 px wide is the one outcome nobody wants. `irisShortcut`
in `src/app/panel.ts` is a pure function over the keystroke and its target, so
that rule is testable and readable rather than buried in a handler.

**The mark's fifth state.** Four of the rail's states are the ones the open
header already shows. `comparing` needed a rule, and it is a fact about
`run.steps` rather than a guess about the model: a working run that has finished
at least one step has something to compare against. Every animated state in this
client is driven by a server event, and this one is no exception.

**Would change it if.** If people turn out to use `hidden` as their default, the
rail is costing 56 px for nothing and the honest answer is a preference rather
than three states. If a second agent ever shares the pane, the rail becomes a
list and Cursor's tab model stops being the wrong shape.

---

## C34. Three identical "New session" rows, and the four bugs behind them

**Decided.** Clicking New session three times used to produce three blank
sessions, all titled "New session", all identical in the sidebar
(`qa/panel/sidebar-before.png`). Four changes, and they are four different
bugs:

1. **New session reuses a blank session.** `createSession` looks for a session
   with no messages, no run and still the placeholder title, and opens that
   instead of creating a twin. It matches a *pending* one too, which is the
   whole race: the first click inserts a local row and posts, the second arrives
   before the POST answers, and a rule that skipped pending rows created the
   second session anyway. It also opens the panel and puts the cursor in the
   composer, because a New session that leaves you looking at a collapsed rail
   is a New session you have to click twice.
2. **A blank session is not listed** — in the sidebar or the sessions popover —
   unless it is the one you are in. One is the session you just opened; three is
   a list of nothing.
3. **The first turn names the session**, from its first six words, dispatched
   before the POST so the sidebar stops saying "New session" the moment Enter is
   pressed, and PATCHed so a reload agrees. When the run finishes, the object it
   produced renames it again — "Ada Ling · application" — derived from the
   session's focus ref and the request already in the entity cache. No route was
   added for either; both are `PATCH /w/:ws/sessions/:id`, which existed.
4. **A manual rename wins, permanently.** `titleSource` moves to `manual` and
   nothing auto-titles that session again. A title somebody typed is a decision,
   and a product that quietly undoes it is a product people stop trusting with
   names. Two races had to be closed for that to hold: a server row re-delivering
   the old title must not undo a local rename, and a server row still saying
   "New session" must not undo a local auto-title that the PATCH has not landed
   yet. `session/upsert` handles both.

Row lists call an unnamed session "Untitled session" rather than "New session".
The stored title is untouched; the point is that "New session" is the name of
the *control that creates one*, and two buttons a keystroke apart with the same
accessible name is a sidebar where one phrase means two things.

**The bug this uncovered, which is the one worth reading.** Focusing the
composer on New session made something reachable that never had been: typing
the first sentence *faster than `POST /w/:ws/sessions` answers*. The turn was
posted to the optimistic id — `POST /w/:ws/sessions/local-…/turns` — which the
Worker answers `400 {"reason":"bad_id"}`, and the message was simply gone. The
adapter now keeps the creation promise per local id and resolves it before any
route is built. Nothing was wrong with the optimistic session; what was wrong is
that an id which is deliberately not a uuid was allowed into a URL.

It is worth saying why nothing caught it. The optimistic id has been there since
the first commit, and so has the 400; the two never met because no control put a
cursor in the composer at the moment a session was being created. A latent bug
of this shape is not found by testing the thing that changed — it is found by a
scenario that does what a person would do, which is why `live-panel.spec.ts` N6
types rather than posting.

**Would change it if.** If auto-titling ever wants more than the first turn and
the focus ref — a summary, say — it stops being derivable in the client and
becomes a server concern, and the right shape is a title the run writes rather
than one the client guesses.

---

## C35. The session row's status rides in its label, because the library has no slot

**Decided.** `SidebarNav` renders a recent's `label` and nothing else: `prompt`
reaches `onPick` and is never drawn, there is no second span, and the library
decides which row is current by comparing `label` to `activeTitle`. So the live
status is part of the label — "Partner applications · Needs review" — and
`activeTitle` is decorated identically so the comparison still works.

The row is allowed two lines rather than truncating. A person scanning this list
is scanning for "Working", and a row that ellipsises exactly that word answers
the wrong question.

The words are the demo's, not the server's raw value. `v_session_status` is the
*run's* status — `COALESCE(r.status, 'idle')` — so what arrives is `idle`,
`working`, `waiting`, `stopped`, `completed`. Those five map to Ready, Working,
Waiting, Stopped, Ready. Anything else the server sends is passed through
unchanged, because a screen renders the server's sentence rather than its own
and a server that writes a better one should win. A blank session gets no word
at all: "Ready" on a session nobody has used is a status about nothing.

**Why not fork the library.** It is not ours to edit, which is the standing rule
here, and the alternative — rendering our own list beside `SidebarNav`'s — means
duplicating its header, its search box and its selection model to gain one span.
A label that reads well is the cheaper honest answer.

**Would change it if.** The library grows a `sub` or a right slot on a recent,
which is a two-line change here and deletes this decision.

---

## C36. Navigation width follows the explicit disclosure, never the window breakpoint

**Decided.** `.shell.nav-collapsed { --nav-w: 76px }` and the automatic
breakpoint collapse remain gone. The navigation column is 240 px while the
component is expanded. When a person uses `SidebarNav`'s own disclosure, the
shell mirrors its public `data-sidebar-collapsed` state and gives the grid cell
the component's 52 px rail width. The `.sidebar` cell clips throughout the
transition.

**What was actually wrong.** The demo collapsed its hand-rolled navigation to
icons below 1180 px, and the rules that did it named `.brand-name`,
`.nav-label`, `.nav-item` and `.workspace`. M2 replaced all of that markup with
`SidebarNav` from the component library and kept the breakpoint. `SidebarNav`
sets its own width from its own state — 224 px expanded, 52 px collapsed, by its
own control — and none of those four selectors matches anything it renders. So
below 1180 px the *column* became 76 px while the *component* stayed 224 px, the
cell did not clip, and the navigation drew itself across the pane beside it,
starting at x=0. Three panel states and six page walks later, nothing had caught
it.

Two numbers also never added up: the cell's 20 px padding around a 224 px
component is 264 px in a 240 px column, so even at full width the component
overhung by 24 px — invisible only because the chat pane's own background
painted over it in the one state anybody looked at.

**Why mirror instead of force.** The library still owns the disclosure, inline
width, focus handling and expand control. The client does not override any of
those. It only observes the public state attribute after the control changes it
and gives the surrounding grid the matching width. This avoids `!important`, a
fork, and duplicate interaction state while allowing the explicit collapse a
person requested to release real workspace space.

**What the test had to change to see it.** Every assertion the panel suites
already made was about the grid, and the grid was always right: a grid item's
box *is* its column, whatever its contents do. `getBoundingClientRect()` was no
better — it reports an element's full box even where an ancestor clips it, so it
both missed the real overlap and invented false ones once the cell started
clipping. `expectNoNavOverlap` hit-tests instead: sample a vertical line of
pixels three px to the right of the column and ask `elementFromPoint` what is
there. If the answer is ever inside the navigation, a person can see it. That
assertion fails on the old code and passes on the new, which is the only
evidence worth having. A geometry regression also asserts that explicit
collapse changes the outer grid cell from 240 px to 52 px, not merely the inner
component.

Two smaller things went with the original breakpoint removal. `.shell-outer`
now clips: a focus or a `scrollIntoView` inside a pane was able to scroll the
whole shell 48 px off the top, which is never something the shell should do.
`ui.navCollapsed` is now written only when the explicit disclosure changes and
is read by the shell's column geometry.

**Would change it if.** The library grows a controlled `collapsed` prop, at
which point the breakpoint can come back and mean something.

---

## C37. The end-to-end suite runs on a file it owns, because `.dev.vars` beats the environment

**Context.** `apps/client/scripts/e2e-live.mjs` started `wrangler dev` with
`env: { AUTH_MODE: 'fake', MODEL_SCRIPTED: '1', OPENROUTER_FIXTURE: '1' }` on
the spawn, and both the README and `live.spec.ts`'s own header said the live
suite ran scripted. It did not. Wrangler does not take bindings from the process
environment: `getVarsForDev` reads `.dev.vars` and overwrites the config's vars
with what it finds. So on a machine whose `.dev.vars` said

```
MODEL_SCRIPTED="0"
OPENROUTER_FIXTURE="0"
```

— which is the *documented* way to run the product against a real OpenRouter
key locally — `pnpm e2e:live` sent fifty scenarios' worth of turns to a real
provider on somebody's real key, and said "MODEL_SCRIPTED=1" in three comments
while it did it. The same file is read by `@cloudflare/vitest-pool-workers`, so
`pnpm --filter @hermes/worker test` had the same hole.

**Decision.** The suite runs on variables it generates and checks.

1. `e2e-live.mjs` writes `apps/worker/.dev.vars.test` from `.dev.vars` with
   `AUTH_MODE=fake`, `MODEL_SCRIPTED=1` and `OPENROUTER_FIXTURE=1` forced, reads
   it back, and refuses to start if any of the three is not what it wrote.
2. `wrangler dev` is given `--env-file .dev.vars.test`. That flag rather than
   `--var`, and the reason is in wrangler's own code: `.dev.vars` is loaded only
   `if (!envFiles?.length)`, so naming an env file excludes it outright, where a
   `--var` is merged *underneath* the secrets `.dev.vars` loads and would lose
   the same race again.
3. The worker vitest project sets the same three as miniflare `bindings`, which
   are applied after the pool has read `.dev.vars`.
4. The file is generated, never committed: it carries the local Postgres strings
   and the local KEK, and a committed copy would be a key in the repository and
   a second place to keep in sync. `.gitignore` gained `.dev.vars.*`.

**And then it is proved rather than asserted.** Two guards, because the file
only proves what was *asked* for:

* a Worker already answering on the port is no longer reused. It used to be, so
  that a suite could be re-run against a stack you were watching in a browser —
  but that stack is `pnpm --filter @hermes/worker dev`, which reads `.dev.vars`,
  which is the file this script no longer trusts. `E2E_REUSE_WORKER=1` is the
  way back, and it names what it is opting into.
* before Playwright starts, the launcher sends **one turn** through the real
  HTTP routes and waits for the scripted provider's own sentence to come back.
  A Worker on a real provider either has no verified key for the seeded
  workspace and fails the turn, or answers something else; either way the suite
  stops after one turn instead of after fifty.

The port comes from `E2E_BASE_URL` rather than a constant, and the base URL is
added to `ALLOWED_ORIGINS` in the generated file, so the suite can run beside a
"real local mode" Worker on 8787 without touching it. That is how this change
was verified: the suite on 8799, the real Worker left alone on 8787.

**What it cost.** `pnpm e2e:live` is about ten seconds slower, all of it the
probe. That is the price of the sentence "the suite did not call a provider"
being a measurement rather than a claim.

**Would change it if.** Wrangler grows a documented precedence for process
environment over `.dev.vars`, at which point step 2 becomes unnecessary — step 1
and the probe would stay.

---

## C38. The transcript's scroll model: three positions, and a spacer that makes two of them one

**Context.** On send, the transcript did not move. The demo's rule — "a user
message or `nearBottom` scrolls to `scrollHeight`" — is correct in a transcript
that is already taller than its viewport and wrong in the one case that matters:
the moment a question is asked. `el.scrollTop = el.scrollHeight` on a short
transcript is a no-op, so the new question and the first lines of the reply were
drawn wherever there happened to be room, which at an 800 px pane is under the
subheader. Brian's screenshot is a reply whose first line is cut off by the
breadcrumb.

**Decision.** Three positions, and nothing else moves the viewport.

| When | Where |
|---|---|
| a user message arrives | its top edge goes to the top of the transcript's content inset, and the reply streams into the space beneath it |
| a delta, while the reader is at the bottom (96 px) | the bottom |
| a delta, while the reader is not | nowhere. The **Jump to latest** chip appears, outside the scroll region |
| `message.final`, a step row, a receipt, a queue row | nowhere, unless the reader is pinned |
| a session switch | the remembered `scrollTop`, as the demo did |

**The spacer is the whole mechanism.** A `div` after `.transcript`, sized on
every layout to `clientHeight − (everything after the anchor's top)`. That makes
"the question at the top" and "scrolled to the bottom" the *same* scrollTop
while the reply is shorter than the viewport, so the two rules cannot fight: a
pinned reader is already reading from the top of their own question. When the
reply grows past the viewport the shortfall is zero, the spacer disappears, and
a pinned reader follows the text down exactly as before. This is how ChatGPT
does it — a bottom spacer / `min-height` on the last turn, sized so the maximum
scroll lands with the prompt at the top; it is not vendor-documented, and it is
cited here as reverse-engineered rather than published
(<https://jhakim.com/blog/handling-scroll-behavior-for-ai-chat-apps>).

Two details the arithmetic needed:

* **twice per layout.** The first pass measures `scrollHeight` while React is
  still committing the rest of the turn, so its answer is one layout behind and
  the first *painted* frame is short by exactly the transcript's top padding.
  The second pass measures the layout the first produced. It is a fixed point.
* **the inset.** "The top of the viewport" means the top of the transcript's
  own content inset, not the container's border edge. The first message of a
  session cannot reach the border — the padding is above it — so anchoring later
  ones flush would put the same message in two places depending on where it was
  in the conversation, and the flush one reads as clipped by the subheader,
  which is the defect. The scroll target is `anchorTop − paddingTop`.

**What was borrowed, and from where.**

* *pinned only while already pinned, cancelled by a scroll up.* The convention
  every client in this class has converged on; the canonical implementation is
  `use-stick-to-bottom`, which "allows the user to cancel the stickiness at any
  time by scrolling up" and discusses ~70 px as the re-engage threshold
  (<https://github.com/stackblitz-labs/use-stick-to-bottom>). Vercel's AI SDK
  ships it as the default primitive: `<Conversation>` "automatically scrolls to
  the bottom", with a `<ConversationScrollButton />` that "appears when not at
  the bottom" (<https://elements.ai-sdk.dev/components/conversation>). The demo
  already used 96 px and it is kept: it has to be larger than one line, or a
  reader sitting at the bottom is un-pinned by the line that arrives under them.
* *a scroll-to-bottom chip, outside the scroll region.* Cursor 3.0: "Added a
  'scroll to bottom' button in the agent panel that appears when content
  overflows" (<https://cursor.com/changelog/3-0>). Cursor's own forum is also
  the argument *for* the send-anchor: users ask it to "anchor the viewport at
  the top of that message so I can read downward as content streams in"
  (<https://forum.cursor.com/t/top-anchored-reading-for-chat-responses-or-opt-out-of-auto-scroll-to-bottom/162811>).
* *reduced motion.* Only one scroll in the file is animated — the chip, which is
  a deliberate human action and the only place orientation is worth an
  animation for. `scroll-behavior: auto` "scrolls instantly", and
  `prefers-reduced-motion: reduce` is the signal to use it
  (<https://developer.mozilla.org/en-US/docs/Web/CSS/scroll-behavior>). Every
  other move is an assignment to `scrollTop`, which is instant for everyone:
  animating the follow of a stream would mean the animation is always behind
  the text.

**What was considered and not used.** CSS `overflow-anchor` is the native
version of half of this, and MDN marks it *Limited availability* — "not Baseline
because it does not work in some of the most widely-used browsers" — which is
why `use-stick-to-bottom` reimplements it in JS
(<https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-anchor>).
`scroll-snap-align: start` pins a turn to the top declaratively, but MDN's own
warning rules it out here: "Never use `mandatory` if the content inside one of
your child elements will overflow the parent container", which is every reply
longer than the pane
(<https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_scroll_snap/Basic_concepts>).

**Claude.ai is described from observation, not cited.** Anthropic publishes no
changelog or doc for claude.ai's send and stream scrolling; the only public
artifacts are third-party (a userscript that exists to add a scroll-to-bottom
control, and Claude Code issues about auto-scroll overriding a reader's
position). It matches the convention above, and that is recorded here as an
observation rather than dressed up as a source.

**How it is tested.** `e2e/live-transcript.spec.ts`, from the browser's own
rectangles rather than from class names, because every one of these defects was
invisible in the DOM and obvious on screen. T1 records the anchor's offset on
every animation frame in the page — a round trip to the test process is too slow
to catch the first frame — and asserts it within 8 px of the inset. T2 samples
the gap thirteen times across a run and asserts it never exceeds 1 px. T3
scrolls to the top mid-run and asserts the position is unchanged 2.5 s later
with the chip up. T4 compares boxes against the composer at its tallest. T6
proves the second question anchors like the first.

**Would change it if.** `overflow-anchor` reaches Baseline, at which point the
`nearBottom` half could be the browser's job and the spacer would stay.

---

## C39. Chat replies may use light Markdown; tool arguments still may not

**Context.** The plan's prompt-injection section says every model-authored
string "renders as plain text in review panes: no markdown links, no HTML", and
`packages/shared/plain-text.ts` enforces it at the *writer*. That rule was
written about the strings a tool call puts in a row — a review note, an
instruction body, a proposal's evidence — and it was applied to chat prose as
well, in both directions: the transcript rendered `message.text` in a
`white-space: pre-wrap` span, and the system prompt told the agent to write
plain text. So a reply containing `**bold**` or a `- ` list arrived as literal
asterisks and hyphens, and the model — correctly following its instructions —
sometimes said things like "I won't output raw markdown syntax per my
constraints", which is the product apologising for a rule it did not need.

**Decision.** Split the rule along the line it was always about.

* **Tool arguments: unchanged.** `plainText()` and `findMarkup()` still refuse
  HTML, markdown links, autolinks and control characters in every string a tool
  writes. Nothing in this decision touches that file or any screen that renders
  its rows.
* **Chat prose: a safe subset.** Paragraphs, `**bold**`, `*italics*`,
  `` `inline code` ``, fenced code (through the library's `CodeBlock`), ordered
  and unordered lists, headings folded to h3, blockquotes and simple pipe
  tables.
* **Never, in either: HTML, and links as anchors.**

**The parser is the allowlist.** `src/app/chat/markdown-subset.ts` produces a
small node union with no HTML node and no anchor node; `Markdown.tsx` renders
only those nodes, with no `dangerouslySetInnerHTML` and no element chosen from
data. Every string reaches the DOM as a React child, which escapes it. That is
why a library was not used: every Markdown library worth having ships raw-HTML
passthrough and an anchor renderer, both on by default, and turning them off is
a configuration line somebody removes the day they want a `<br>` in a table.
Here there is nothing to turn off.

**Links render as text plus their destination.** A `link` node carries its label
and its href, and the renderer draws the label followed by a non-interactive
chip holding the bare URL. Selectable, copyable, not a click target. A
`javascript:` or `data:` target does not even get the ordinary chip — it is
marked refused and shown as the text it is. `![image](…)` becomes a link node
too, so nothing remote is ever fetched: a remote image in a reply is a beacon as
well as a link. The reasoning is the plan's own: "a destination hidden behind
words the human trusts" is the trick, and a reply is not a safer place for it
than a review note.

**Streaming.** `parseMarkdown` is a pure function of the accumulated text and is
called on every delta. Partial input is the normal case: an unterminated fence
is a code block that is still open, an unterminated `**` is two literal stars, a
table with only its header row is a table with no body. Nothing waits for a
terminator, so nothing pops into place when one arrives. The tree is re-parsed
rather than appended to, which is what stops a `**` being drawn as two stars and
then removed two characters later. A reply with nothing to mark up keeps the
plain span it always had (`hasMarkup`), so the common case keeps its exact
typography and no parser has any say over it.

**The prompt changed with it** (`apps/worker/src/engine/prompt.ts`, additive):
tool arguments are plain text, the reply may use light Markdown, and neither may
carry HTML or a markdown link. The paragraph about writing a URL out is kept
because it is still the instruction that matters.

**Tested** in `markdown-subset.test.ts`: `<script>`, `<img onerror>`,
`javascript:` targets, HTML entities, nested emphasis, an image, a reply that is
nothing but links, and a loop over every prefix of a structured reply asserting
no word is ever lost mid-stream.

**Would change it if.** A reply needs a second list level or a real anchor. The
first is a shape to add; the second is a product decision, not a renderer one.

---

## C40. Activity renders above the answer

**Context.** `RunSurface` rendered `LoadingState`, `ThinkingState` and
`ToolChips`, then `StreamingText`, then `TaskRows` — and the finished message
renders *above* the whole surface, because `RunSurface` sits after
`session.messages`. So a completed turn read: the answer, then the steps that
produced it. Codex, Cursor and Claude all put the trace above the reply.

**Decision.** Within a turn: `LoadingState`, `ThinkingState`, `ToolChips` and
`TaskRows`, then the streamed text. Reading downwards is reading in order — what
the agent did, then what it said. The queue and the waiting and failed states
are activity too: they say what the run is about to do or is stuck on, which is
a thing to read before the answer rather than after it.

When the run settles, `ThinkingState` is given stage 4 — its own collapsed
state — with `done` set to "Done · N steps", expandable, which is the shape
Claude's collapsed activity row has. Stage 4 is only claimed when the run is
actually over: a completed stage on an unfinished step list would draw a check
beside a step that failed. Worked time and the response actions stay in the
footer, where they were.

**Would change it if.** A turn ever produces activity *after* its text — a
follow-up tool call on the same turn — at which point the order is per-segment
rather than per-turn.

---

## C41. `StreamingText` is the third component not adopted

**September 19, 2026 clarification:** The current incremental reveal starts from
the text already present when its component mounts. Restored checkpoints are
visible immediately, never replayed from blank after navigation. Only subsequent
deltas use the existing reveal loop; reduced motion remains immediate. Mount,
remount, appended-delta and durable-final handoff regressions cover this boundary.

**Context.** A turn whose reply was the word "testing" rendered "3 sources" and
offered "Show the application evidence" and "Draft a follow-up for missing
details". Nothing had gone wrong: `StreamingText`'s `sources` and `followUps`
default to the gallery's fixtures, and `RunSurface` passed neither.

The prop fix is one line. The component was dropped anyway, for three reasons
that are the same shape as `PromptBar`'s and `AgentScreen`'s (C23, C27):

1. **It re-animates text the server already sent.** `loop={false}` stops the
   restart, but the component still reveals its `content` word by word on its
   own timer. The words were already delivered by `message.delta`. Every
   animated state in this client is driven by a server event; this one is driven
   by `WORD_MS`.
2. **It cannot render structure.** `content` is `{ text }[]`, joined with
   spaces. A reply with a list or a table has nowhere to go (C39).
3. **It owns an action row and a sources row** — copy, replay, helpful, "Add to
   Collective", a sources disclosure — that duplicate `ResponseFooter` and claim
   things this run did not do. "Replay response" re-runs the component's
   animation, which is a replay of nothing.

**Decision.** The stream renders through `IrisText`, the same component the
finished message uses, plus a CSS caret. `message.final` swapping one for the
other therefore changes nothing on screen, which is the property that was
missing before: the stream and the message had two different renderers and the
text visibly re-flowed when the run ended.

**Would change it if.** The library exposes a controlled `StreamingText` with no
built-in timer and no action row.

---

## C42. A fixture default is a lie with a plausible sentence in it

**Context.** C41's bug is not specific to `StreamingText`. Fifteen of the
twenty-one library components default a content prop to a gallery fixture, and
the fixtures are not lorem ipsum — they are "Maya Chen", "Leah's application",
"partner-review.ts", "Partner criteria v2". In a product whose entire claim is
that what it shows happened, a placeholder that reads like a real row is the
most dangerous kind there is.

**Decision.** Every call site passes every fixture-bearing prop explicitly, with
an empty array, an empty object or a real value. Three were found beyond
`StreamingText`: `ToolChips` was drawing the gallery's `review-notes.md`,
`screening.json` and `follow-ups.md` diff chips under every run's tool calls;
`CodeBlock` in the trace detail carried the gallery's diff; `ThinkingState` its
`additionalSources`.

**Tested in two halves, because either alone is insufficient.**
`src/app/library-defaults.test.ts` scans every `.ts`/`.tsx` file under `src/`
for each component's opening tags and asserts each required prop is present —
that is what catches a *new* call site, which a render test cannot, because it
does not know the call site exists. Then it renders each component to static
markup with an empty payload and asserts none of nineteen fixture strings
appears — that is what catches a prop that is passed but does not suppress the
fixture.

The tag scanner is written by hand rather than as a regex, and that is not
fussiness: JSX props are full of `>`, so `items={list.map((s) => s.title)}` ends
a lazy `<Tag …?>` match four props early and the audit then reports a prop that
is right there. It tracks brace depth and quoting and stops at the `>` that
closes the tag.

**Would change it if.** The library's next version makes the content props
required, which would move this from a test to a type error — the better place
for it.

---

## C43. The suites get their own database and their own port

**Context.** Every automated suite in this repository ran against `hermes` —
the database the developer's own `wrangler dev` on :8787 is showing them. The
symptoms were reported from the other side of the screen while this work was in
flight: the Inbox filling with scripted "Ada Ling" requests, one set per run;
about fifty sessions named "P4 race", "T1 send-scroll", "T3 scrolled away" in
the session list; and the workspace default model, which had been set to
`openrouter:anthropic/claude-sonnet-5` by hand, silently back at
`deepseek-flash` because `db:seed` runs at the start of `pnpm e2e:live` and
writes the seed's value.

The only cure was `pnpm db:reset`, which tore the Docker volume down and took
the verified provider key with it. (It did, in the course of this work. The key
is not recoverable and has to be added again.)

**Decision.** Two stacks that share the Docker container and nothing else.

| | dev stack | test stack |
|---|---|---|
| database | `hermes` | `hermes_test` |
| Worker | :8787, `pnpm --filter @hermes/worker dev` | :8788 by default, started and stopped by `pnpm e2e:live` |
| variables | `apps/worker/.dev.vars` | `apps/worker/.dev.vars.test`, generated per run |
| model | whatever `.dev.vars` says, possibly a real provider | always `MODEL_SCRIPTED=1` |

It is one variable, because `apps/worker/scripts/db-config.mjs` already
assembles every connection string from `PGDATABASE`. `scripts/test-db.mjs`
creates `hermes_test` if it is absent, migrates and seeds it, and hands back the
Hyperdrive strings; `pnpm e2e:live`, `pnpm db:test` and the worker vitest
projects all go through it, and `apps/client/scripts/live-fixture.mjs` — which
the live specs use to read rows back — defaults to it too.

**Four guards, because a default is not a guarantee.**

1. the launcher refuses to start if the port is 8787;
2. it refuses if the database it resolved is not `hermes_test`;
3. it refuses if any `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_*` in the
   generated file does not end in `/hermes_test`;
4. it will not reuse a Worker it did not start, and there is no flag for it any
   more (C37 had one). A Worker somebody else started was configured from
   `.dev.vars`: it is pointed at the dev database by definition.

`/health` turned out to be a popular path — 8788 on the machine this was written
on was an unrelated project answering `{"ok":true}` — so the probe checks the
*shape* (`{ status, version, checks: [...] }`) and says "something that is not
this Worker is listening" rather than mistaking it for a Hermes stack.

**`pnpm db:reset` changed too**, in two ways that follow from the same idea.
It recreates the `hermes` database rather than running `docker compose down -v`,
because the volume is shared and a suite may be using `hermes_test`. And it
**keeps the seed workspace's provider keys**: they are copied out with `\copy`
before the drop and copied back after the seed, which works because the seed's
workspace id is a constant and the seed writes no key rows of its own. A wrapped
provider key is somebody's real credential; it is the one thing in that database
that cannot be regenerated by running a script.

**Would change it if.** The suites move to a throwaway container per run, at
which point the database name stops mattering and the port guard is the only
thing worth keeping.

---

## C44. The activity block is one line, and only when a tool ran

**Context.** C40 put the trace above the answer, which was right, and left the
trace as it was, which was not. What it rendered under every reply was a
`ThinkingState` header ("✦ Done ▾") *and* a `TaskRows` list whose rows were
"✓ Thinking · Done ▾" and "✓ propose_request · Done ▾". Two of those three
things are noise:

* **"Thinking" is not a step.** The engine emits a `provider` step labelled
  "Thinking" for every model call — twice in the ordinary two-turn script. It is
  true of every turn, it is the same words every time, and there is nothing a
  reader can do with it.
* **A per-step "Done" pill restates its own container.** The block says "Done";
  the rows then each say "Done" again.
* **`TaskRows` is not a step list.** It has a details chevron per row and a
  Retry callback, which are affordances for a queued follow-up and a parked run
  — the two things a person can actually act on.

**Decision.** Three states, and the first one is nothing.

| | what is drawn |
|---|---|
| no tool call in the turn | **nothing.** No block, no header, no disclosure |
| working, a tool running | one line: `LoadingState`'s inline form, the tool's own label and the elapsed timer |
| settled | one muted line, `Done · N steps ▾`, expandable to `ToolChips` |

`TaskRows` stays, for the queue and for a run parked on a question, and nothing
else. Worked time and the response actions stay in the footer where they were.

The collapsed row is a plain `<details>` rather than `ThinkingState`, and the
reason is the same shape as the other library decisions: `ThinkingState` insists
on a step list with its own spinner and its own checks, and reserves 176 px for
it, for a trace that is usually one row.

**And a bug fell out of writing it.** `ToolChips` had never rendered a single
chip in this product, because `store.ts`'s `run.step` handler read `tool_call_id`
and `attempt` off the wire and then dropped both on the floor — so every step
looked like a non-tool step and every step looked like it belonged to the
current attempt. The README has claimed "`ToolChips` one per `tool_call_id`"
since M3. It does now. The same fix restores "Earlier attempt", which could not
have worked either.

**Would change it if.** A turn's trace grows something a reader acts on
mid-run — a permission prompt, a file being written — at which point the
collapsed line needs a second state that is not "done".

---

## C45. A refused turn says what the server said

**Context.** `POST /w/:ws/sessions/:id/turns` answered
`400 {"error":"Add a deepseek key in Settings to start","reason":"no_key"}` for
a new session still on the workspace default model. That is a good refusal: it
names the provider, it names the screen, it is a sentence for a person.

The composer threw it away. All three send paths ended in
`.catch(() => undefined)`, so from the outside: the draft vanished, nothing
appeared, no run started — and the session renamed itself to "testing" after a
turn that never ran.

**Decision.** Every refusal is rendered, and nothing is lost.

* **The server's sentence, verbatim.** `refusalFor()` maps a reason to an
  *action*, never to replacement copy: the Worker knows which provider, which
  cap and which number, and a client that rewrote any of it would drift. What
  the client adds is the route to the fix, which is the thing only the client
  knows — "Settings → Provider keys" for `no_key`, `key_invalid` and
  `key_revoked`.
* **A reason the client has never seen is still shown**, with its own words and
  no action, rather than being replaced by "Something went wrong" — which would
  be strictly less useful than what the server already wrote.
* **A request that never reached a Worker gets the one sentence the client
  writes itself.** `TypeError: Failed to fetch` is a message for a developer.
  The discriminator is whether there is a `reason` at all.
* **The draft comes back and the caret goes with it**, so the next thing typed
  is a correction rather than a retype.
* **The session's name is put back.** `autoTitle` still runs before the POST —
  the sidebar should stop saying "New session" the moment Enter is pressed — but
  the previous title is kept and restored if the turn is refused, unless a
  person has renamed it in between, because a manual rename wins permanently
  (C34) even over the client undoing its own guess.

`role="alert"` rather than `role="status"`: the person pressed Enter and nothing
happened, so this is the answer to something they just did.

**Tested** in `refusal.test.ts` (seven cases, including "never returns an empty
string" and "never rewrites the provider name out of the server's copy") and as
T7 in `live-transcript.spec.ts`. T7 injects the 400 with Playwright's route
interception rather than provoking it, and says why in the test: `MODEL_SCRIPTED=1`
skips the provider-key check, and turning the scripted provider off is the one
thing the test stack must never do (C43). The body is the Worker's own, and
everything after the interception — the draft, the title, the corrected send
that succeeds — is the real client against the real stack.

**Not done, and named rather than assumed.** A new session's model still comes
from the workspace default even when that model has no verified key. Choosing a
different one for them is a product decision — it changes which model their work
runs on without being asked — and the honest version of it needs the banner to
say what was changed and why. The refusal above makes the current behaviour
legible, which is the part that was broken.

**Would change it if.** The turns route grows a `retry_after` that the client
should count down, which is the one refusal where a static sentence is not
enough.

---

## C46. Members is inline rows, not the library's database table

**Decided.** `RecordsTable` is out of the product. Members renders the shell's
own `.list-row`/`.members-row`: avatar, name (with "· You" on your own row),
the email under it, a role pill, a status pill, the joined date, and one action
on the right — Manage on a member, Resend or Reinvite plus Withdraw on an
invitation. The import is gone from `Workspace.tsx` and nothing else in the
client uses the component.

**Why.** `RecordsTable` is a *database* surface, and it brought a database's
furniture onto a screen about colleagues: a selection checkbox column, an "Add
calculation" affordance, a horizontal scroller, a "2 count" footer, and — from
the library's own fixture columns — a header called **Evidence** over a column
describing people. C27 argued the calculation column could be made honest by
filling `reviewGap` with real reviewer roles, and that much was true; it was
answering the wrong question. Nobody sorts, pins, multi-selects or computes
over a membership list, so every control on it was cost with no use, and
"Evidence" over a colleague's name is a sentence the product does not mean.
The word must never appear on this screen again.

The other three list screens named in the same review — the Inbox list, Library
→ Documents and the Traces list — were never adopted onto `RecordsTable`; they
have always been `.list-row`, and they stay that way. `FilterTable` keeps
History, where the state filter is a question an operator actually asks, and
session pinning stays where it always was, in the sessions popover. Sorting and
pinning are added where the product needs them and nowhere else.

The tabs changed with the rows. "All members" reads the WorkOS membership
mirror; "Invitations" now reads the **invitations list**, which is where an
unaccepted invitation lives. The mirror only ever holds people who have
accepted — `listMembers` joins `users` and the server writes no `invited` row on
that path — so the old tab (members filtered to a non-active status) was
filtering a set the server never fills, and always rendered empty. The row
actions are the routes that already existed: `POST …/invitations/:id/resend`
(one route behind two words, because the server accepts `pending` and `expired`
alike) and `POST …/invitations/:id/withdraw`. `memberCounts` counts the same
list, so the header's "N invited" and the tab agree.

**Would change it if.** A membership list grows a reason to sort or to act on
many rows at once — a workspace with hundreds of seats — at which point the
right answer is still probably a sort control on these rows, not a table with a
calculation column.

---

## C47. The sidebar's footer is a name, not a headcount

**Decided.** `SidebarNav`'s `footerLabel` is `state.user.name` and nothing else,
with the user's avatar as `footerIcon`. It is still the button that opens the
account menu. `memberCounts` is no longer read in `Sidebar.tsx`.

**Why.** It said "Maya Chen · 2 joined": a number about other people in the one
place on the screen that is about you, next to your own face. The count is not
lost — the Members header carries "N joined · M invited", and so does the
workspace menu's Members row in Settings → Organization — so the footer was a
third copy of a fact nobody goes there to read, and it made the identity row
read like a statistic.

**Would change it if.** The footer becomes a workspace switcher rather than an
identity, where a seat count would be about the thing being switched.


---

## C48. Iris executes in one official Hermes profile; the app owns enterprise authority

**Decided September 15, 2026.** Brian approved the official Nous runtime and one
agent per profile, including the necessary architecture change. The native
Hermes process owns the agent loop and session transcript. The existing Worker
continues to own identity, tool permissions, review decisions and the auditable
record. OpenRouter supplies the selected model through the Worker’s credential
proxy; it is no longer the implementation of the agent loop.

An `agents.id` binds a separate profile/process and every session/run. Native
run/session/attempt identifiers are recorded alongside enterprise IDs. Traces
distinguish official execution from earlier runs, and remain scoped to the
agent and the viewer’s authorized sessions. State directories do not claim OS
sandboxing. Broad native tools and automatic memory/skill extraction stay off
until the enterprise ownership and retention lifecycle is integrated.

**Why.** A custom chat/tool loop cannot truthfully stand in for the official
Hermes agent. At the same time, using that runtime must preserve human approval
authority and the app’s existing isolation. Native plugin ContextVars provide
trusted correlation; model arguments and static MCP headers do not.

**Evidence and limits.** See [Official Hermes Agent runtime](HERMES-AGENT-RUNTIME.md)
for the pinned source, actual conversation checks, configuration, and hosted
rollout requirements. Verified locally; no hosted runtime deployed by this work.

---

## C49. A model sync may add hundreds of rows; one response may not retire hundreds

**Context.** A real OpenRouter key synced 441 models into the local `hermes`
database. The aggregate Worker test command then ran its database project
directly. `db-config.mjs` defaulted that project back to `hermes`, four fixture
workspaces each synced the five usable rows in the seven-row OpenRouter fixture,
and `sync_openrouter_catalog` truthfully but disastrously marked the other 439
rows “No longer listed by OpenRouter.” OpenRouter still listed them.

**Decision.** Local aggregate tests again run the database project through
`scripts/db-test.mjs`, which owns `hermes_test`; a bare Vitest run also forces
both `PGDATABASE` and local Hyperdrive bindings to `hermes_test`. CI is the only
exception because its `hermes` service is disposable and already occupies port
5433. Independently, catalog sync refuses an empty response or a refresh below
half of an active catalog of at least twenty rows. A failed completeness check
preserves the last catalog and leaves the verified key available for retry.

**Why both.** Test isolation fixes the observed cause. The completeness guard
protects staging and future local work from the same outcome if a CDN truncates
a response, OpenRouter changes its schema, or another caller accidentally uses
a fixture. Retiring models is reversible; silently retiring hundreds from one
small response is still the wrong default.

**Would change it if.** OpenRouter publishes a versioned snapshot or explicit
deletion feed, at which point retirement should follow that signal instead of a
ratio guard.

---

## C50. The visible navigation control owns its action and its menu

**Decided September 15, 2026.** Every left-rail control must produce a visible
result: primary items open their page, New session and recent sessions open
Iris, session search opens and closes, and the collapse control can restore the
expanded rail. Workspace actions use the exact labels emitted by `SidebarNav`:
Switch workspace opens the root picker, Workspace settings opens Organization,
and Invite team members opens Members.

The library's visible footer button is the one account-menu trigger. The app
recovers that button through the public `footerIcon` slot and anchors the
popover to it; it does not render a second hidden trigger below a full-height
sidebar. The footer is a left-aligned 40 px row with the same inset and vertical
rhythm as primary navigation. Expanded rails keep 8 px side gutters, while the
52 px collapsed rail gives that space back so icons stay centered.

**Why.** The workspace callback previously compared `settings` and `members`
against full labels, so two menu items silently did nothing. The account menu
was anchored to a second button clipped below the rail, not the button a person
clicked. A broad session-row CSS selector also styled primary-navigation icon
spans as multiline copy. These looked like isolated polish problems but shared
one cause: behavior and layout were attached to elements other than the visible
control.

**Evidence.** `panel-sidebar.spec.ts` exercises every page destination,
workspace action, account shortcut, search, recent selection, New session,
collapse/expand, reduced-motion toggle and focus restoration. It also measures
40 px primary targets, at least 4 px between them, and the shared left edge of
the account and navigation rows.

**Would change it if.** `SidebarNav` exposes a first-class account trigger ref
or account-menu slot, at which point the marker bridge can be removed without
changing the visible behavior.

---

## C51. Applicant scores stay attached to evidence and provenance

**Decided September 15, 2026.** An application review leads with one plain-language
takeaway, then shows the structured criteria and the source channels Iris used.
Each criterion retains its own `source_ids`; LinkedIn, GitHub, YouTube and X use
compact visual marks, and source details remain one click away. Labels are
normalized for people (`Track Record`, `Capacity`, `Fit`) without changing the
stored criterion ids.

**Why.** Current screening tools make a recommendation easier to audit by tying
competency judgments to supporting evidence. Metaview links scorecard entries to
their underlying evidence, HireVue recommends defined competencies and scoring
rubrics, and PeopleGPT combines public profile signals across sources. Hermes
uses that shared pattern while keeping the Inbox denser than a recruiting ATS.

**Truth boundary.** The UI says `Cited by Iris` or `Sources used`; it does not say
`Verified` until the runtime records successful retrieval and identity matching.
Local fictional records are visibly marked `Illustrative`. A source logo proves
provenance only when the request payload carries that source id.

**Evidence.**
- https://www.metaview.ai/resources/blog/candidate-review
- https://www.hirevue.com/resources/research-paper/hirevue-structured-interviews
- https://juicebox.ai/blog/announcing-peoplegpt-2.0

---

## C52. The workspace uses the 80% type scale without scaling its controls

**Decided September 15, 2026.** Brian chose the visual density of the workspace
at 80% browser zoom as the typography target. Client-owned font sizes and line
heights are therefore 80% of the previous scale, with a 10 px floor for the
smallest labels, including display type, conversation text, list rows, menus,
onboarding and document previews. The few hard-coded pixel sizes inside
`SidebarNav` are bridged from client CSS so the library rail and the native
panes read at one scale.

Widths, icons, padding and interactive target heights stay unchanged. In
particular, the navigation rows remain 40 px with their existing 8 px rail
gutters. This is intentionally a type-scale change, not `zoom: .8`: CSS zoom
would also turn a 40 px target into 32 px, disturb the panel-width arithmetic
and make the interface less usable for everyone rather than merely denser.

**Evidence.** `panel-sidebar.spec.ts` measures the vendored navigation label at
11.2 px and a native 32 px display heading at 25.6 px, then separately verifies
that all seven navigation targets remain at least 40 px high. The rendered
workspace is retained in `qa/panel/sidebar-after-shell.png`.

**Would change it if.** User testing shows that the compact type is difficult
to read at 100% system scaling. The next step would be a user-selectable density
preference, not another browser-wide transform.

---

## C53. Payment and signature approval capture intent before provider execution

**Decided September 15, 2026.** Invoice and agreement review use three visible
steps: review the complete document, prepare the payment or signature, and
confirm the exact authorization. The full document remains available throughout.
Payment review names the source account, payee, amount, and timing; agreement
review places the signer's entered name and consent directly in the signature
block. The final decision stores an audit note describing that authorization.

**Execution boundary.** Approval still creates the document and pending effects.
It does not manufacture a bank transfer or applied signature. The local demo
labels its bank connection as a prototype with no funds connected, and both
flows say that provider execution remains separate. A production connector must
turn the pending effect into an idempotent provider operation, persist the
provider reference, reconcile webhooks, and expose failure or reversal without
changing the human decision already on file.

**Why.** The reviewer needs to see the entire legal or financial artifact and
the concrete consequence before committing. Keeping the effect separate also
preserves the existing two-person finance requirement and prevents a document
approval from silently becoming external execution.

---

## C54. Onboarding previews approval boundaries instead of pretending to configure them

**Decided September 15, 2026.** The final workspace-creation step shows one
plain flow — Iris prepares, a reviewer decides, then the approved action runs —
followed by compact cards for the protected outcomes and their initial reviewer
roles. The groups cover the implemented approval vocabulary: plans and team
coordination, access and records, external communication, money movement, agent
and team changes, and shared learning. Payment names Finance explicitly.

This is a read-only policy preview. It has no toggles or workflow canvas because
a new workspace has only its creator, and the server owns the real policy and
authorization snapshot. Finance and specialist reviewers are added later when
the relevant people exist. Motion is intentionally limited to existing control
feedback; governance text does not animate or delay the create action.

**Why.** Ramp's admin setup first previews the active route, names role-based
reviewers and separation of duties, and reserves its workflow builder for later
configuration. GitHub environment approvals keep protected secrets unavailable
until review. Microsoft recommends that agent admins inspect capabilities,
data sources and custom actions, and that irreversible actions stay behind
approval. The onboarding screen therefore teaches the safety model without
asking a first-time admin to design a policy graph prematurely.

**Evidence.**
- https://support.ramp.com/setting-up-spend-request-approvals
- https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
- https://learn.microsoft.com/en-us/microsoft-365/copilot/agent-essentials/agent-lifecycle/agent-copilot-studio-requested
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/agent-design-canvas-framework

---

## C55. Nous Portal supplies inference; Hermes Agent remains the runtime

**Decided September 15, 2026.** Workspace model inference uses the Nous Portal
OpenAI-compatible API at `https://inference-api.nousresearch.com/v1`. Durable
catalog IDs use `nous:<vendor>/<model>`, and all deployed environments set
`ALLOWED_PROVIDERS=nous_portal`. The default is
`nous:anthropic/claude-sonnet-5` with medium effort. Existing OpenRouter code is
kept for historical records and transport regression tests, but is not offered
by the current product path.

The official Hermes Agent runtime still owns planning, transcript continuity,
tool orchestration and execution. Its agent-scoped Worker proxy supplies the
selected model and resolves the workspace's encrypted Nous Portal key on each
call. `HERMES_BRIDGE_SECRET` authenticates the runtime to that proxy; it is not
an inference credential and does not replace the workspace key.

Nous Portal's `/models` route is public, so it cannot validate a credential.
Key verification therefore sends one minimal one-token chat-completions request
before syncing the public catalog. The local fixture reproduces both responses
only in development and is absent from staging and production configuration.

**Why.** One product provider keeps setup and billing legible while still
offering the Portal catalog. Keeping the runtime and inference credentials
separate preserves tenant billing, rotation and audit attribution without
copying workspace secrets into Hermes profiles. A public catalog response alone
would create false-positive verification for invalid or revoked keys.

**Would change it if.** Nous Portal publishes a free authenticated key-introspection
endpoint, in which case verification should use it instead of a billed minimal
completion. Adding another customer-facing provider requires a separate policy,
catalog and UI decision rather than merely compiling another adapter.

---

## C56. Session refresh and runtime transport are resolved at their adapter boundaries

**Decided September 16, 2026.** A successful WorkOS session refresh is unsealed
again before authentication continues. WorkOS Node 10.13 returns the rotated
sealed session without a separate access token, so the application reads the new
JWT from that cookie instead of treating a missing response field as an empty
token. Transient refresh failures retain the existing cookie; terminal failures
still sign the user out.

Every Hermes operation also honors the transport on the agent's runtime binding.
Native profiles use the Runs paths directly; managed Cloud profiles use the one
fixed dashboard connector envelope for capabilities, submit, status, events,
steer and Stop. Health, browser admission and execution must use the same binding.

**Why.** The old refresh adapter turned ordinary access-token expiry into `not a
JWT` after a user had been signed in for several minutes. Separately, health and
execution honored `dashboard_connector` while the browser turn route silently
constructed a native client, so health was green but a real turn was rejected.
Both failures came from reconstructing an upstream contract instead of carrying
the adapter's authoritative result forward.

**Evidence.** The staging browser session refreshed without another login. A
real Iris turn then completed through Hermes Cloud with model
`nous:deepseek/deepseek-v4.1-flash`, native runtime identity and agent-scoped
traces. Regression coverage asserts the WorkOS refresh response shape and the
Cloud connector used during turn admission.

---

## C57. Chat acknowledges locally, then reconciles against the durable turn

**Decided September 16, 2026.** Pressing Send immediately projects the person's
message and one working state in the transcript. The projection carries the
turn's client idempotency key; the turn route persists that key on the user
message and emits it with `message.appended`, so either `run.started` or the
message event can reconcile the local state without a duplicate. A refusal
removes the projection and restores the draft. The UI never projects success,
tool use, or completion before an authoritative event.

Hermes Cloud streams native SSE with available-byte reads rather than an 8 KB
buffer-filling read. The Worker durably coalesces deltas over 75 ms and always
performs a trailing flush, so a pause cannot hold text until the one-second
runtime status poll. The connector disables intermediary response transforms
and buffering where supported. The coalescing clock starts again after a
durable write is delivered; database latency therefore cannot make an
already-buffered native burst fall into one write per token.

**Why.** The network round trips needed for admission and durable execution are
real, but they should not delay acknowledgment of the person's own action.
Separately, model tokens are useful only when each transport layer preserves
their cadence. Exact id reconciliation retains the fail-closed server contract
while making the feedback loop immediate.

---

## C58. Live text uses a transient WebSocket fast lane over durable checkpoints

**Decided September 16, 2026.** Native Hermes text is sent to the authorized
session Durable Object as a `message.preview` frame before its Postgres
checkpoint completes. The frame carries the run, step attempt, character offset
and fragment, but no stream id: it is a display hint, not history. Durable
`message.delta` events and `message.final` remain authoritative and replayable.

The client tracks its committed prefix separately from the text currently on
screen. A preview can append only at a matching offset. When the overlapping
durable delta arrives, it advances the committed prefix without appending a
second copy. Gaps and conflicts are ignored until replay or the next checkpoint
repairs them. A reconnect therefore may lose a momentary preview but cannot
lose, duplicate or invent transcript text.

Durable writes run serially on a dedicated restricted database connection beside
native stream consumption rather than blocking it or overlapping control
transactions on the run's connection. Only one checkpoint may be in flight;
additional tokens coalesce behind it, and the run drains every checkpoint before finalization. Preview
delivery is best effort, session-authorized and failure-tolerant, so a broken
socket falls back to the existing replay and polling paths without failing the
agent run.

**Why.** Postgres is the right source of truth and the wrong paint loop. Making
every visible fragment wait for a cross-region commit coupled perceived model
speed to database latency. The fast lane preserves the audit and recovery
contract while letting the UI reflect the runtime as soon as text reaches the
Worker.

---

## C59. Live chat separates runtime activity from answer text

**Decided September 16, 2026.** The official Hermes Runs stream is the source
for both parts of a live turn. `message.delta` continues through the transient
WebSocket preview lane and the durable transcript checkpoints. Native
`tool.started` and `tool.completed` events are also projected into ordinary
`run.step` events, so the chat can name the work Hermes is actually doing before
the answer begins. Tool steps use per-run generated identifiers because the
native lifecycle payload names the tool but does not expose a stable call id.

Hermes' internal `_thinking` event remains intentionally absent from the Runs
stream. The Enterprise UI does not fabricate reasoning text or animate a fake
answer during that interval. A quiet model-only interval is shown as one
thinking state; real tool activity replaces that label when it arrives.

**Why.** Codex-like responsiveness comes from multiple typed streams: activity
events while the agent works and text deltas while it writes. Forwarding only
the text stream made a healthy turn appear frozen during model reasoning or
tool use. Converting actual Hermes lifecycle events preserves auditability and
keeps the UI honest about what has and has not happened.

---

## C60. A run changes the composer's intent, not its identity

**Decided September 16, 2026.** The composer keeps mode, model, runtime and the
send button in the same bottom control area before, during and after a run.
Those selectors become read-only while the current run owns their values, but
their labels stay visible. The send button is anchored to the lower-right of
the control area rather than participating in its wrapping layout.

When a run is active, its two possible message intents appear as a compact
`Steer` / `Queue` switch above the input. The placeholder reflects the selected
intent. The switch enters with the existing short reveal and becomes immediate
under reduced motion.

**Why.** Removing the model after Send hid consequential context at the moment
a person most needed to understand a run. Putting the intent selector among
the persistent controls also caused the send button to jump to another row as
the Iris pane was resized. One stable composer preserves orientation while
still making clear whether the next message affects this run or follows it.

---

## C61. Agent activity is a truthful ambient signal, not a decorative loop

**Decided September 16, 2026.** Agent Overview carries one compact activity
surface that remains visible when the conversation is collapsed. It answers
three questions without opening chat: whether Iris is working, waiting, stopped
or idle; which task owns the current state; and, when a tool event exists, the
exact tool name beside a short human translation. `get_document_text → Reading
a source document` is intentionally both machine-legible and understandable.
The full arguments and results remain in the trace.

Live session state wins across the agent's sessions. When no run is live, the
newest server-sorted trace supplies the last real activity; a fresh workspace
says `No active work right now`. Only `working` animates. Waiting, stopped and
idle states are static, and the member's reduced-motion preference disables the
working mark and pulse as well. No timer cycles through fake steps, and this UI
does not claim to add background scheduling: actual proactive work still needs
a real workflow or scheduled run to emit these events.

**Why.** GitHub's agent panel uses live session status and a drill-down session
log; Replit separates Draft, Active, Queued, Ready and Done, then pairs finished
work with its work log and test results; Cursor's background-agent surface keeps
status available outside the main conversation. The shared pattern is ambient
state first, evidence on demand—not an animated avatar with no operational
meaning.

**Evidence.** `agent-activity.test.ts` covers live, waiting, recent-trace and
idle derivation. `agent-activity.spec.ts` proves a real mock run remains visible
after Iris collapses, pairs a tool with its human wording, keeps idle still and
removes all activity animation when reduced motion is on.

- https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents
- https://docs.replit.com/core-concepts/agent/task-system
- https://docs.cursor.com/background-agent

---

## C62. Workspace identity is carried by artwork and real member presence

**Decided September 16, 2026.** The workspace picker uses a responsive card
grid rather than administrative list rows. Each workspace gets one of three
project-owned technical-art illustrations selected by its purpose (interview,
partner network or finance/analysis), with the workspace name, the viewer's
role, the real member count and up to four real member avatars or initials. A
workspace can be opened from the whole card; creating another workspace is a
quieter dashed card in the same grid.

The visual direction combines the product's existing deep navy, cobalt and
condensed display face with the more tactile Nous language visible across its
public research and Portal surfaces: constrained ink colours, technical
diagrams, halftone grain and archival/manual geometry. The illustrations have
no embedded text, logos or invented people. They are compressed WebP assets,
and the build copies the public asset tree into the exact directory served by
the Worker.

**Data boundary.** `GET /auth/session` without a workspace id now includes a
presentation-only preview of four active members and a count, selected only
from workspace ids the authenticated user already belongs to. It omits email,
reviewer authority and membership metadata; the full records remain on the
workspace-scoped `/members` route. Initials are the fallback when WorkOS has no
profile image.

**Motion and access.** Hover raises the card three pixels and slightly enlarges
its artwork to clarify that the whole surface is interactive. Keyboard focus
uses the existing visible outline. The global reduced-motion path removes both
transforms, and the 390 px layout becomes one column without horizontal
overflow.

**Evidence.** Shared, client and Worker unit suites pass; Chromium covers empty,
single and multi-workspace directories and their member previews. A rendered
pass verified the current one-workspace layout, the 390 px layout, artwork load,
keyboard focus and an empty browser error log.

- https://nousresearch.com/
- https://portal.nousresearch.com/
- https://nousresearch.com/wp-content/uploads/2025/08/Hermes_4_Technical_Report.pdf

---

## C63. Idle activity describes the finished task, not a runtime phase

**Decided September 16, 2026.** The Overview card uses the task/session title
for a terminal run. The generic Hermes `Thinking` step is execution metadata;
its completed label must never appear as the last task beside `Idle`. A
completed response without a tool call says `Response completed · No tool calls`.

When a tool was called, a dedicated wrapping row keeps its name and plain-language
outcome visible. Native Hermes steps preserve the raw tool identifier, matching
enterprise bridge steps. Older humanized labels remain intact in history and
can still receive a readable translation. A failed tool says it failed; an
unfinished tool on a terminal run never claims success or ongoing execution.

Motion follows real state: the tool indicator pulses only during an active call
on a working run. Tool/state changes use the existing 160 ms, 4 px reveal;
completed and waiting calls remain still. App and system reduced-motion settings
remove the loops and reveal travel. Task and tool text wrap at narrow pane widths.

**Verification.** The observed staging trace was completed with one done
`Thinking` step and no tool calls. Regression tests reproduce that exact shape,
terminal tool states, and failed versus stopped runs. Mock browser coverage
checks the no-tool card, last-tool visibility in a narrow pane, collapsed Iris
activity and reduced motion. Activity browser tests now run in the CI mock suite.

---

## C64. Live output is paced from real bytes and activity names observable work

**Decided September 16, 2026.** Native Hermes output remains authoritative,
but the browser no longer paints each network burst as one visual jump. It
buffers received text and reveals complete grapheme clusters on animation
frames. Small backlogs move one or two characters per frame; larger backlogs
accelerate, and a final response catches up in a short accelerated tail. The
renderer never invents text, delays persistence or replaces the shared partial
Markdown parser.

`message.final` now commits the message while retaining its stream accumulator
until the visual reveal reaches the exact final text. During that handoff the
committed answer is hidden, preventing a duplicate bubble or an atomic swap.
Run and attempt keys protect a newer stream from a late final or completion
event. Reduced motion presents each received buffer immediately.

The activity line follows real phases: reasoning before visible output, the
human meaning of an active tool, and writing after answer text begins. Exact
runtime tool identifiers and their active/completed/failed state remain visible
throughout the working run. Hermes `reasoning.available` records a completed
reasoning boundary, but its preview text is deliberately not forwarded or
rendered; observable phase and tool events are useful product status, while a
provider preview is not a contract for private model reasoning.

**Evidence.** Reducer tests cover authoritative final handoff, retries, stale
events and incomplete messages. Reveal tests cover grapheme safety and adaptive
pacing. Runtime tests prove the reasoning boundary is recorded while its text
is absent from emitted events. Run-surface tests cover reasoning, progress,
writing and exact live tool activity. Client and Worker suites, workspace
typecheck, the production client build and Worker dry run pass.

- https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/gateway/platforms/api_server_runs.py

---

## C65. The luminous scrollbar is a shared native control

**Decided September 16, 2026.** Every scroll surface uses the same semantic
scrollbar tokens. The visual keeps the supplied reference's fine purple rail,
bright focal point and fading energy line, adapted to both vertical and
horizontal overflow. It therefore applies consistently to chat, app panes,
document viewers, dialogs, editors and tables instead of depending on the
historical `.scroll` helper.

The sidebar session list clips horizontal overflow because its titles already
wrap or truncate; the horizontal scrollbar is reserved for surfaces such as
wide tables and documents where sideways navigation is intentional.

The implementation styles the browser's native scrollbar rather than replacing
it with JavaScript, preserving wheel, trackpad, keyboard and pointer behavior.
Chromium and WebKit receive the full layered gradient. Firefox receives the
bright purple core as a deliberate fallback because its scrollbar API does not
accept gradients. The treatment is static, so it does not imply progress or
movement and needs no separate reduced-motion behavior.

**Evidence.** Client typecheck, the production build, 224 unit tests and 56
Chromium browser scenarios pass. A native in-app-browser render at constrained
height confirmed the rail, energy line and focal glow on simultaneous
conversation and application scroll surfaces.

---

## C66. Live elapsed time belongs to the run, not the mounted component

**Decided September 17, 2026.** The active chat timer derives from the durable
`run.started` event timestamp. The optimistic turn uses the local send time
until that authoritative event reconciles it. Navigating to another session and
back can remount the activity component, but it cannot make the run appear to
have restarted.

The bundled `LoadingState` stopwatch is intentionally hidden only when the
server-backed timer is present. Its loader, phase label and reduced-motion
behavior remain unchanged. The visible replacement is presentation-only for
assistive technology so a ten-times-per-second clock does not repeatedly
announce; the changing phase label remains the status announcement.

Runtime readiness and the persisted run binding remain separate fail-closed
checks. They are independent reads, so the official-runtime adapter starts the
network health check and database lookup together instead of paying for them
serially before submission. No model, effort, approval, tool or persistence
behavior changes.

**Evidence.** A remount regression renders the same run at 3.7 seconds and
again at 24.1 seconds from its original timestamp. Store coverage verifies the
event time reaches the cached run. Runtime coverage holds the submission
readiness check open until the concurrent binding lookup starts, proving the
calls no longer serialize while both checks still execute.

---

## C67. A healthy WebSocket does not prove the transcript is complete

**Decided September 17, 2026.** The session hub periodically reconciles even
while WebSocket heartbeats remain healthy. It checks every two seconds while
the visible session has unresolved run or stream state and every thirty seconds
while idle. Returning to a visible tab and refreshing the hub ticket trigger
the same catch-up immediately.

The WebSocket remains the low-latency path. Durable replay is the completeness
check because a browser or best-effort forwarder can miss a committed terminal
batch without closing the transport. Replay and simultaneous live events use
the existing replay-first buffer order. The active session also compares its
authoritative run row and latest persisted messages with local state: a later
live event may legitimately advance the cursor past an earlier missed event,
which cursor replay alone cannot recover. The run read preserves the exact
terminal state instead of inferring completed from an idle session. Receiving
a terminal status forces this snapshot once, because that status may be the
later half of a partially delivered batch. A failed background check preserves
the healthy socket and retries at the bounded cadence.

**Evidence.** One transport regression keeps the socket open with a valid
`pong`, withholds the terminal batch, and verifies bounded replay without a
disconnect. A second advances the cursor with completed `run.status` while
withholding the earlier `message.final`, then verifies that the authoritative
message snapshot restores the response as soon as the tab becomes visible.

---

## C68. Native stream consumption must not await the control plane

**Decided September 17, 2026.** A delayed status check was able to hide an
entire native streamed response: the same loop stopped reading SSE while it
awaited status, and a completed status then aborted unread deltas. A controlled
300 ms status delay reproduced eight available text chunks but zero live
previews or durable deltas before the full final answer.

One independent native reader now feeds ordered coalescing preview and durable
checkpoint lanes. Status, Stop, Steer and tool activity cannot stall ingestion.
Database operations sharing one client remain serialized, while production
checkpoints use their dedicated connection. Lane sends are single-flight,
frames respect the wire size limit, and response/activity buffers are bounded.

Authoritative terminal status starts a bounded native tail drain, followed by
complete durable-write draining before finalization. Preview draining is
best-effort and limited to 250 ms, with queued sends discarded afterward. A
late preview cannot resurrect a finished client accumulator. The existing
final-status recovery remains necessary because the pinned native event queue
is single-consumer and non-replayable. No reconnect subscriber is added.

**Evidence.** Regression tests hold status, preview, checkpoint and main-client
database operations independently. Text still arrives during control delays;
completion cannot overtake durable writes or wait indefinitely for a preview;
large backlogs preserve exact text and offsets in bounded frames. Client tests
cover late previews after final/reveal and while a later run is active. Worker
telemetry records content-free relative delivery timings and counts, and a
throwing metrics observer cannot change successful completion.

**Live acceptance follow-up.** A real Cloud reply exposed a separate client
race: periodic semantic reconciliation treated the persisted assistant row's
`streaming` placeholder as a final answer. That cleared the already-visible
prefix, so later deltas rebuilt only a suffix until the genuine final arrived.
Only terminal message rows may enter `stream/final`; the adapter filters
streaming snapshots and the reducer enforces the same invariant defensively.
An older in-flight snapshot cannot revive a completed attempt or overwrite a
retry that has advanced the run's attempt number.

## C69. Transcript ownership must survive admission and final handoff races

**Decided September 17, 2026.** A reply appeared to disappear after streaming.
The affected open document retained an extra local `again` bubble after the
saved answer; a fresh document showed the correct saved conversation without
that extra bubble. The sequence-number failure was reproduced in adapter and
reducer tests: live `message.final` has no session sequence and uses
`MAX_SAFE_INTEGER` locally, the next optimistic question inherited that value
plus one, and its real user row could never satisfy the confirmation's
sequence comparison. The remaining local question anchored the viewport below
the reply when its live accumulator was removed.

Turn confirmation now uses the exact `client_turn_id`, or the admitted run id
plus the user text when a snapshot lacks that key. Local sequence numbers are
not identity. A repeated prompt from an older run cannot confirm a new turn
before admission establishes its run. POST and `run.started` also reconcile a
user row already received through a snapshot, and a delayed POST cannot change
a terminal run back to working. Background snapshots revisit already-seen user
rows while a pending turn remains. Optimistic sequences exclude the live-final
ordering sentinel.

Separately, a provider-turn final is not a run-completion event. Clearing the
finished text reveal before the transcript can render its durable replacement
left a blank gap while `run.status` was delayed. The reveal must retain
ownership until a matching durable answer is renderable. Tool rounds still
remain progress, not an invented completed run; an explicit next-turn reset
can replace the current live surface normally.

**Coverage.** Consecutive repeated prompts after a live final are tested through
both socket and snapshot delivery, including admission/event reordering,
already-seen-row recovery, and terminal-state preservation. Rendered browser
coverage holds final/status delivery apart and checks the no-blank, one-answer
handoff with normal and reduced motion, as well as continued tool turns. These
fixtures use real client state/rendering with synthetic events; they do not
claim native model or paid-tool evaluation.

---

## C70. Native terminal failures become safe structured product errors

**Decided September 17, 2026.** A terminal Hermes status may include a redacted
provider error, but it is still provider-controlled free text. The Enterprise
adapter uses that text only to choose one fixed failure class: authentication,
quota, rate limit, rejected request, temporary provider unavailability,
interrupted runtime or unknown. It persists and streams only our stable error
code, retryability and fixed user copy. The native text is never copied into
Postgres, browser events, traces or Worker logs.

The same structured error now reaches the chat status bar and the trace detail.
Permanent authentication, quota and rejected-request failures require action
and do not offer a misleading retry. Transient failures preserve completed
work and keep Retry available. A content-free `hermes.terminal_failure` event
records the class, retryability, native status, elapsed work and partial-output
length so an incident can be diagnosed without exposing a prompt, credential
or upstream response.

**Why.** The prior adapter discarded `status.error` and labeled every failure
`hermes_run_failed`. That made a provider rejection, expired connection and
temporary outage look identical, and made the Traces screen omit the only safe
diagnostic the product had. The repair belongs at the Hermes-to-Enterprise
boundary: changing the workflow engine would still lose the same field.

**Evidence.** Classifier tests cover every failure class and prove the native
text is absent from the persisted and logged projection. Adapter coverage
proves terminal classification and proxy-accounting isolation. A real-Postgres
route test proves trace detail returns the safe error, and client rendering
tests cover retryable and action-required trace states.

---

## C71. Keep Cloudflare Worker and Workflows around the official Hermes runtime

**Revalidated September 17, 2026.** Cloudflare remains the Enterprise control
plane and Hermes Cloud remains the agent runtime. The Worker owns identity,
tenant and approval policy, the durable Postgres audit and browser delivery.
One Workflow coordinates each run attempt. Hermes owns planning, model calls,
tool execution and its native session through the authenticated Runs API.

Hermes' current official guidance confirms the integration boundary rather
than prescribing an outside workflow product: custom HTTP control planes use
the API Server and its `/v1/runs`, status, event, stop, steer and approval
endpoints; hosted instances run on Hermes Cloud, while the official Docker
image is the supported self-hosted fallback. There is no official Hermes
recommendation to move its loop into Temporal, Trigger.dev, Inngest, Restate or
Cloudflare Agents.

The current alternatives do not improve this incident:

| Option | Current fit | Decision |
| --- | --- | --- |
| Cloudflare Workflows | Durable step retries and waits, unlimited per-step wall time within CPU limits, native Worker bindings, and up to 30-day completed-state retention; product truth already lives in Postgres | Keep |
| Cloudflare Agents SDK | Strong Durable Object runtime for building a different agent harness; it would duplicate or replace Hermes' loop and session model rather than supervise it | Do not adopt for this path |
| Trigger.dev or Inngest | Excellent TypeScript-first long jobs, streaming and managed run observability; each adds another control plane while Hermes still owns the real loop | Revisit only if run observability or portable background execution becomes a measured blocker |
| Temporal | The mature choice for vendor-neutral, multi-service workflows that must resume for months or years | Revisit for multi-cloud/customer-VPC orchestration or requirements Cloudflare cannot meet |
| Restate | Promising lightweight durable services, exactly-once communication and BYOC/self-hosting | Watch; no migration benefit today |

Changing orchestration is justified only by a measured requirement: customer
VPC or regional placement, multi-language workers, vendor-neutral workflow
history, cross-service compensation beyond the present run boundary, or a
Cloudflare limit observed in production. Better error projection, scoped
observability access and runtime telemetry are smaller and more direct repairs.

Primary references:

- https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- https://hermes-agent.nousresearch.com/docs/guides/manage-hermes-cloud-with-mcp
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/docker.md
- https://developers.cloudflare.com/workflows/reference/limits/
- https://developers.cloudflare.com/agents/runtime/execution/run-workflows/
- https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/
- https://trigger.dev/docs/introduction
- https://www.inngest.com/docs/learn/inngest-steps
- https://docs.temporal.io/
- https://docs.restate.dev/

---

## C72. Runtime provider failures retain safe, actionable status classes

**Decided September 17, 2026.** The agent-scoped model bridge preserves the
upstream HTTP status but returns one fixed error code for each action a person
can take: reconnect authentication, restore quota, wait for a rate limit,
change an unavailable model, retry a provider outage, or correct a rejected
request. Provider response bodies remain outside the Enterprise trust boundary
and are cancelled without being stored, streamed or logged. Worker telemetry
records only provider, catalog model id, status and the fixed classification.

Nous credential verification uses the callable free
`stepfun/step-3.7-flash:free` route rather than the premium workspace default.
Verification answers whether the OAuth grant can invoke inference; a temporary
capacity outage on Claude must not mark that grant invalid or prevent a user
from reconnecting it. The product default remains a separate quality choice.

**Why.** A live Iris run reproduced three provider calls through the same saved
OAuth connection. Claude Sonnet 5 returned 503 three times, while a cataloged
DeepSeek route returned 404. Both were flattened to
`runtime_provider_rejected`. A control call through the same bridge and OAuth
grant completed on StepFun with HTTP 200 and authoritative streamed usage,
proving that identity, credential refresh and the Enterprise transport were
healthy. The failing boundary was model availability at Nous Portal.

The Brian Interview Demo workspace and its proactive Iris session were moved
to the proven StepFun route so scheduled and interactive work can continue
while the premium routes are unavailable. That operational choice is visible
in the session and workspace model selectors; the bridge does not silently
substitute a different model.

**Evidence.** Runtime bridge tests cover 401, 402, 404, 422, 429 and 503, assert
that provider diagnostics never cross the boundary, and verify rejected calls
remain attributed to the exact credential and model. The Nous adapter test
pins the independent verification route. A live Hermes Cloud trace completed
the StepFun control request in one model call with no tool calls.

---

## C73. Iris recovery preserves tasks, effects and model provenance

**Decided September 18, 2026.** Overview and trace expose Retry task without a
chat message. Idle Run now checks only the current authorized screening cadence;
its durable cycle key prevents a second allowance. Existing requests and paid
receipts are inspected before advancing an attempt. Completed discovery resumes
from stored candidate evidence; pending imports retain their native mapping, and
uncertain mutations or existing drafts block replay. Reviewing an already-created
draft permits future cadence work even when the original final response failed.

Manual and automatic retries share admission, ownership, provider, capacity and
approval-budget checks. Expected attempts make delayed duplicate requests no-ops.
An app transaction records the new attempt and a durable launch job before the
Workflow starts. Prior model/effort, trace, failure and trigger remain in the
recovery history. Paid authorization rechecks the active native attempt under the
same task-row lock so a late callback cannot reserve work after recovery advances.

For automated screening, only recognized provider outages and rate limits retry
automatically, up to three total attempts with one- and five-minute delays.
Sanitized provider Retry-After deadlines can extend those waits; excessive waits
pause recovery. Cancellation, human review, stopped tasks, unavailable credentials,
quota and unresolved effects never become an unbounded retry loop. The UI uses
server-confirmed state and existing button feedback; its countdown is motionless
and does not repeatedly announce itself to screen readers.

Catalog capabilities honor per-model reasoning efforts; DeepSeek V4.1 offers
`low`, `high`, `max`, with provider default `high`. Automation follows the
workspace policy, and retries use the task's current selected model. The
separate Jev typed classifier and production automation policy are unchanged.

**Default rollout held.** The requested all-workspace V4.1 Flash/low migration
is prepared separately. A September 18 staging preflight of exact
`nous:deepseek/deepseek-v4.1-flash` at explicit low effort returned Nous HTTP 404
on all three native attempts (run `fb738cb4-c64c-4bf4-ae2a-132326ce6675`). The
public catalog still lists it; official routing and OAuth handling match the
application. Do not promote it globally until exact-model inference and tool
acceptance pass. Recovery can ship independently while configured defaults and
historical records remain intact.

**Evidence.** Focused PostgreSQL tests cover ownership, duplicate requests,
reviewed-cycle recovery, current-model snapshots, paid receipts, cadence keys and
cancellation. Runtime adapter tests assert saved evidence instructions reach the
native submission. Browser tests cover Overview/trace actions, no-output failure,
countdown, cancellation, navigation and narrow reduced-motion layout. Deployment
and live-provider acceptance are recorded in the Tech Lead delivery note.

---

## C74. Raindrop observes terminal Hermes runs through a content-free boundary

**Decided September 18, 2026.** Staging exports one AI event after an official
Hermes run has committed and delivered its terminal message and status. The
event contains model and lifecycle metadata, tool names and states, final-answer
presence and length, and fixed error taxonomies. Tenant and run identifiers are
one-way hashed. Prompts, answers, applicant data, tool arguments and results,
provider bodies and error messages remain inside Hermes.

The exporter uses Raindrop's documented batch ingestion contract directly. The
official JavaScript package was rejected for the Worker path because one event
export added 290 transitive packages and a blocked protobuf build script. A
small HTTP client keeps the Worker bundle and supply-chain surface bounded.

Raindrop runs after the canonical result and has a 2.5-second request deadline.
Its absence or failure is logged as metadata and cannot alter the run. Stable
pseudonymous event ids make Workflow replay idempotent. Development and
production default off; staging is active only when its server-side write key
exists. The first explicit agent signals are terminal error and tool use without
a final response.

**Evidence.** Unit tests assert the export query cannot select transcript or
tool contents, raw identifiers and error messages never reach request bodies,
negative signals attach to the same event, disabled mode does no work, and
vendor failures resolve without throwing. The Worker typecheck and dry-run
bundle verify Cloudflare compatibility without the vendor SDK.

---

## C75. Cloud response text uses a primed GET SSE hop and names its paid/free route

**Decided September 18, 2026.** The Hermes Cloud connector keeps one exact
machine-authenticated `/api/plugins/enterprise_bridge/control` path. Short
control operations continue to use POST envelopes. A run's event subscription
uses GET with only a validated `run_id`, sends a valid SSE comment immediately,
and writes each complete native SSE frame separately. The Worker requests
identity encoding and consumes the same native event contract as before. The
older POST events envelope remains for a one-release drain window.

The model selector now labels Nous Portal entries as `Paid route` or `Free
route` and exposes the exact model id on the control. Two StepFun routes with
the same human label can no longer be mistaken for one another. The route id is
preserved exactly when Enterprise removes the `nous:` catalog namespace for the
official Hermes runtime; there is no implicit fallback and no default-model
change in this repair.

**Why.** Staging proved that native output, durable final state and reload
persistence were correct, but a long answer remained absent in the browser
until the run ended. The existing component and Worker streaming tests could
not distinguish a provider that delivered late from an HTTP intermediary that
buffered the dashboard's POST response. A conventional primed GET SSE response
removes that avoidable ambiguity. It cannot manufacture tokens before an
upstream provider emits them, so first-delta telemetry remains the authority
for separating provider latency from transport latency.

**Evidence.** A delayed-native-chunk ASGI test proves the first delta leaves the
connector before terminal EOF. Worker tests prove GET, authentication,
no-compression request headers, keepalive tolerance, and exact paid/free runtime
model ids. Browser tests prove visible text grows before completion, the final
handoff has no blank frame, and committed output survives session navigation
and reload. Model-menu unit and browser tests cover the two same-label StepFun
routes and the selected exact id.

---

## C76. Creator-channel runs receive exact governed calls and X uses a $0.005 public-post connector

**Decided September 18, 2026.** An explicit Hermes creator, influencer,
consultant, or implementation search now causes the Worker to append the exact
approved AgentCash call to the native runtime input. The original user message
remains authoritative: the payment endpoint independently checks that it names
Hermes, an action such as search or test, and the requested channel before it
leases a call. Recovery input never receives a fresh paid-search instruction.

LinkedIn and YouTube keep the fixed $0.01 public-index search. X uses one fixed
read-only `fetcher.sh/api/twitter/search` request for the exact `"Hermes Agent"`
phrase, capped at $0.005. Its importer stores at most five canonical X
profile/post pairs, bounded public bio and post text, point-in-time follower and
engagement metrics, and explicit evidence gaps. It drops contact-like text,
provider metadata, payment receipts, locations, images, and unrelated response
fields. Direct messaging, outreach, and direct platform credentials remain
outside this connector.

The screening cost column uses millidollar precision so the audit row records
$0.005 instead of rounding it to $0.01. LinkedIn/YouTube and X use separate
run-bound idempotency keys, so an explicit multi-channel test can lease each
fixed call once without sharing or replaying an allowance.

**Why.** A staging acceptance prompt asked Iris to call the existing creator
search exactly once. The free model rate-limited; a paid-model retry then spent
ten tool steps reading unrelated Inbox records because the skill referred to
exact arguments that the app never supplied. The connector was implemented,
but model tool selection made it practically unreachable. Exact prompt
augmentation removes that hidden dependency while the Worker lease preserves
the spend and intent boundary.

**Evidence.** Three live AgentCash X calls verified the origin-hosted schema: a
narrow combined account query returned no users, `Nous Research` returned the
verified Nous profile, and the public-post search returned current Hermes
authors and posts. Unit tests cover explicit-intent detection, exact runtime
input, X sanitization, public metrics, skill metadata and source state. Python
plugin tests cover host allowlisting plus pre/post hooks. The PostgreSQL route
test covers the $0.005 lease, import, candidate/artifact persistence and exact
audited cost.

---

## C77. Dashboard-connector events use its authenticated POST dispatcher

**Decided September 18, 2026.** A Hermes Cloud run subscribes through the
fixed, service-authenticated `POST /api/plugins/enterprise_bridge/control`
operation envelope. The plugin's GET handler remains as a compatibility route
for hosts that expose plugin GET routes, but it is not the Enterprise Worker's
primary transport. The POST response is still a primed `StreamingResponse`;
its native relay uses nonblocking `read1`, emits complete SSE frames as soon as
they arrive, requests identity encoding, and disables intermediary transforms.

**Why.** Staging disproved C75's routing assumption. A real run reached native
submit and status repeatedly but never produced a native `/events` request:
the dashboard edge did not dispatch the plugin's GET handler. That left the
Worker to reconcile only the terminal status and made the completed answer
appear at once. The POST dispatcher is the route the dashboard actually
exposes. The buffering bug that originally motivated GET was in the connector's
blocking native read, which remains fixed independently of the HTTP method.

**Evidence.** The Worker regression test requires an authenticated POST events
envelope, the caller's execution signal, `text/event-stream`, identity encoding
and no-cache. The connector test requires that the POST events envelope enters
the same native stream relay used by GET. The incremental ASGI timing test
continues to prove the first delayed native frame leaves before terminal EOF.

---

## C78. Runtime startup phases share serial tenant-scoped transactions

**Decided September 18, 2026.** Hermes startup groups each related database
phase into one tenant-scoped transaction: initial run state, the started event,
submission preparation, and streaming-message setup. Queries remain serial on
the request-local `pg` client. The grouping reuses the existing agent-role
transaction rather than parallelizing queries or widening database grants.
Runtime binding resolution passes its already-loaded run into the adapter, and
content-free latency telemetry now separates startup reads, persistence,
delivery, execution persistence, and execution delivery.

**Why.** A live paid StepFun acceptance run streamed correctly but spent about
four seconds preparing the native request and another two seconds between the
native binding and stream subscription. Most methods opened their own `BEGIN`,
tenant `set_config`, and `COMMIT` sequence, multiplying Hyperdrive round trips.
The same client cannot safely execute these reads concurrently, so one serial
transaction per phase removes protocol overhead without changing authorization,
replay, idempotency, or event ordering.

**Evidence.** The adapter regression test requires the four grouped startup
boundaries. A real PostgreSQL test nests request snapshotting and native binding
inside one runtime transaction, interrupts it, and proves that both writes roll
back. Existing runtime, streaming, database, and Worker suites continue to
exercise retries, stop fences, event order, and terminal persistence.

---

## C79. Interactive admission publishes in order before its durable launch

**Decided September 18, 2026.** A new interactive turn commits its user message,
stream event, publish retry job and Workflow launch retry job together. After
commit, the request hands the exact returned event envelope directly to the
Session Hub, then creates the Workflow only after the hub acknowledges it. The
launch job names the publish job as a prerequisite, so background or Cron replay
cannot create a higher-id run event before the lower-id user message is visible.
Direct acknowledgements retire both idempotent jobs in one background tenant
transaction; a crash or RPC failure leaves the jobs for recovery.

Admission reuses the tenant transaction's membership result, reads session plus
duplicate state together, reads model plus credential state together, and writes
the initial message, engine turn and draft cleanup in one statement. Workflow
startup loads the run and dynamic runtime binding in one serial agent-role
transaction. Phase telemetry separates authentication, admission transaction,
post-commit jobs, ordered publish and Workflow creation.

The Enterprise model-list bridge now returns each catalog model's positive
`context_length` and validates provider credentials serially inside one runtime
transaction. Unknown context remains omitted rather than invented. This lets the
pinned official Hermes metadata resolver use the authoritative OpenAI-compatible
model record instead of making a failing `/api/show` probe on every warm turn.

**Evidence.** PostgreSQL route regressions force both the direct publish and
Workflow-create failure boundaries and prove publication precedes launch while
the durable jobs finish. Outbox tests compare the directly delivered envelope
with its committed id and trace. Unit/database tests cover known, null and invalid
context windows. The native probe runs the exact pinned Hermes gateway and
asserts a complete model/tool turn without any `/api/show` request.
---

## C80. Approval review starts with the decision and the content

**Decided September 18, 2026.** Brian accepted the compact decision/header/email
arrangement and evidence expanding below. Each governed review starts with the
decision, exact per-step approval counts, policy ordering, expiry and the server's
eligibility reason. Specialized previews remain intact. Proposer, long summary,
request identity and policy metadata live in Request details. Review history shows
all votes from the current revision; it does not claim to be a cross-revision audit.

Communication drafts use **Approve draft** throughout Inbox, chat, Overview and
detail. This records review of copy and sends nothing. Authorized reviewers can
revise an email draft's actual subject/body through the existing revision contract;
sender, recipients, evidence, policy and external effects stay unchanged. Pending
revision entry is under More actions, and decision controls hide while editing.
Saving produces a fresh server-bound revision requiring a fresh decision. Stale
responses refetch for review; authentication never automatically replays an action. An unsaved email rewrite can
survive a sign-in redirect for at most 15 minutes, bounded by authorization expiry.
It restores only after a matching viewer/workspace/request/revision/hash refetch
with revision permission, and opens the editor for an explicit save. Cancel, success,
expiry or any binding/account mismatch clears the saved rewrite.

Invoice and agreement review uses **Approve invoice draft** and **Approve agreement
draft**. One workspace Admin approves the current legacy draft. The document preview
preserves supplied parties, currency, dates and terms; absent data is explicit.
Approval saves a Library draft. Bank setup, payment authorization and signature
consent ceremony are removed because those effects are unavailable. Historical
authorization text remains an internal note, not evidence of execution. Client
decisions bind the exact request snapshot rendered by the pane, even if the entity
cache advances before the click, using the backend's version/hash binding and refresh conflicts without
resubmitting.

Evidence expands below the content. Stored partner facts, dates and safe original
URLs load from the request-scoped evidence projection, with Iris's note labeled
separately. Opaque proposal references never become links. Unsupported sources and
unlinked legacy messages are stated as unavailable; email ingestion is outside this
release. Native disclosures open instantly. Preview transitions honor both system
and app reduced-motion preferences.

**Evidence.** Client regressions cover draft labels, per-step quorums, all votes,
real email-body revision, old-binding rejection, safe evidence links, and legacy
draft receipts. Browser checks cover all ten governed previews at desktop and narrow
widths, plus phone review with the existing sidebar collapsed. This change does not
redesign the phone navigation shell. The client requires the matching backend
review-binding helper and typed evidence endpoint; integrate and release together.

---

## C81. Proactive outreach advances through new candidates and sends only an exact approved email

**Decided September 18, 2026.** Recurring AgentCash People Search keeps the
existing six-hour cadence, one request per run and `$0.15` discovery ceiling.
The Worker, not the model, owns the provider page cursor. It advances only after
an exact paid response is imported and cycles after the final page. A durable
engagement ledger removes any candidate already drafted, declined, queued,
sent, or suppressed from later Iris candidate lists.

Iris may use only contact fields copied from stored professional enrichment and
verification evidence. Draft-only remains the default in every environment.
When an operator enables approved sending, the human decision creates a durable
outbox row bound to the request id, authorization revision and hash, and
recipient index. The sender must be a matching dedicated Gmail OAuth account;
credentials are envelope-encrypted and the connector requests `gmail.send`
plus OpenID identity without mailbox-read scope.

Delivery rechecks the approval, sender identity and suppression list. A
confirmed Gmail response records its message and thread ids and marks the
engagement sent. A network error or server response that cannot prove delivery
becomes `ambiguous` and stops automatic retries, because avoiding duplicate
unsolicited outreach is more important than hiding a manual review. Settings →
Email exposes connection, cadence, rollout mode, and waiting work.

**Evidence.** Unit coverage fixes OAuth scope/state, verified account identity,
header-safe MIME generation, provider requests, pagination and end-of-results
cycling. PostgreSQL coverage proves cursor persistence, repeat-candidate
exclusion, exact authorization binding, pending-mailbox behavior, encrypted
credential resolution, one confirmed send, receipt persistence and engagement
transition. Migration replay, the typed schema/grant matrix, client render and
the full database suite include the new boundary.

---

## C82. Modular workflows are Hermes skills with Enterprise assignments

**Decided September 18, 2026.** Hermes Enterprise uses Hermes's existing
extension model instead of introducing a parallel “Program” package type. A
skill is the versioned procedure. A plugin supplies trusted tools and hooks. An
Enterprise skill assignment binds one reviewed skill version to one agent's
validated non-secret config, semantic capability grants, proactive schedule,
approval policy and active/paused state.

The Partner Program is the first implementation. Existing environment policy
is imported once as assignment revision 1 so deployed agents keep working.
After materialization the database assignment is authoritative. The native
runtime derives both `skills.auto_load` and assignment tools from the active
row; pause removes both. Cron discovers persisted assignments and uses each
assignment's enabled flag and interval. Library → Skills renders the registry's
field metadata and lets an Admin save a new revision.

The assignment and its append-only revisions are tenant-isolated. The app role
may create and update an assignment; the agent role has read-only access. The
database enforces monotonic revisions and records every snapshot. Secrets,
provider credentials, evidence, Inbox approvals, external effects and receipts
remain in their existing control-plane stores. A skill still cannot grant
itself decision or send authority.

Runtime discovery and recovery status reads never materialize an assignment or
enable a schedule. The deployment-wide legacy Partner Program fallback is a
rollout compatibility projection only for an agent with no Enterprise team or
skill governance. Any explicit Enterprise role/assignment suppresses that
fallback, so a Finance agent cannot inherit Partnerships manifests or tools.
Applying a reviewed role template also replaces capability grants with the
template's exact allowlist instead of preserving arbitrary historic grants.

**Evidence.** Migration replay applies 46 migrations twice from a blank shadow
database. Unit tests prove active and paused runtime boundaries. PostgreSQL
coverage proves legacy import, revision history and agent-role visibility. The
full shared, client, Worker unit and database suites pass, and the production
client and Worker dry-run builds succeed. A mock browser check opens the
schema-driven editor, saves a changed priority and observes revision 2 without
console errors.

---

## C83. Cross-team agent coordination uses a governed Bot Mode bridge

**Decided September 19, 2026.** Partnerships-to-Finance coordination is hybrid.
The authenticated, revision-pinned database handoff remains the authority. The
recipient Finance session also receives one durable user-role turn using Hermes
0.21.3's canonical Bot Mode envelope,
`Message from 🤖 <display> (@<profile>): <body>`, with native `turn_author` bot
attribution. The transcript
renders that exact envelope as an agent timeline notice instead of a human
message bubble.

The Enterprise Worker generates the message from an immutable, human-confirmed
intake and the Finance-private invoice record; neither model can alter the
envelope, choose a recipient or author authority. The Partnerships tool receives
only the intake id and expected hash. The Worker rechecks the exact human
authorization, validity window, non-deleted source digests, frozen revisions,
assignment snapshots and run grants before its deterministic duplicate,
evidence, currency and amount checks create the only request. An unsigned
agreement draft is evidence to review, not proof that terms were authorized.

The Finance model gets read-only request/result tools and may explain the stored
result. It cannot call native `message_agent`, create or mutate a request,
approve, pay or send. The Finance human decision rechecks the same binding and
saves only an invoice draft. One bounded server acknowledgment records the
decision result without invoice content or an automatic agent reply, preventing
acknowledgement loops.

**Why.** Native Bot Mode's message shape and attribution make agent coordination
legible and compatible with the Hermes client, but unrestricted peer tools would
bypass Enterprise team scopes. Keeping transport visible and authority on the
server preserves both behaviors.

`input_provenance` is separate from execution simulation. Sample terms stay
sample throughout authorization, intake, correction and results, while a real
native execution over those terms remains non-simulated. Historical unknown
provenance is not relabeled customer data.

**Evidence.** Shared tests pin the current and legacy Bot Mode parsers. Runtime
tests require validated native bot attribution and reject malformed authors
before network I/O. The V2 PostgreSQL acceptance covers exact authorization,
same-key replay/conflict, revised terms, evidence deletion and validity drift,
assignment drift, one-successor correction, sample lineage, guarded human
decision and one acknowledgment. On September 19 it passed 8/8 alone and 12/12
with the legacy partner workflow suite. These fixtures use real Postgres/app
roles and guarded HTTP with fixture storage/auth and scripted run admission;
they do not constitute hosted two-account or live provider proof.

## C84. Native conversation ids start from the first Enterprise run

**Decided September 19, 2026.** The first Hermes run in an Enterprise session
uses its globally fresh Enterprise run id as the native `session_id`. Later
turns in that same Enterprise session reuse the latest persisted
`runtime_session_id`. The exact selected id is snapshotted with the native
request and bound to the run before execution.

**Why.** A staging reset can recreate deterministic Enterprise session ids
while the separately hosted Hermes SessionDB still retains its earlier
transcript. Passing the reused Enterprise id let an otherwise fresh prompt load
old native history and return an unrelated answer. A fresh run id breaks that
collision, while the persisted mapping preserves real multi-turn continuity.
Retries continue to use the snapshotted id so native idempotency fingerprints
remain stable across releases.

**Evidence.** Runtime unit coverage proves first-turn isolation, prior native
mapping reuse and exact binding. Restricted-role database coverage proves a new
run resolves to itself and a following run resolves to the earlier native
conversation root. The live staging acceptance requires a unique-marker prompt
in a new Enterprise session after deployment.

---

## C85. Multi-party admission is an opt-in, exact-attestation transition

**Decided September 19, 2026.** Existing Partnerships 1.7 profiles and work keep
their original runtime name, procedure and version-aware tool inventory. The
new role uses `enterprise_bridge:partner-program-screening-v1-8` version `1.8.0`
with artifact digest
`sha256:281bbfff95d40e202c3ced5d1cb30ebf432868bee100d0c2a647faa40757a9e5`.
Finance keeps its runtime name but new work uses version `1.0.1` with digest
`sha256:bdb13d70f7a603f92eb47fc2d1c057c82f26658e61df8cf357790f23875753e4`;
historical 1.0.0 remains resolvable.

The additive migration leaves admission disabled. Enabling it requires exact
attestation for both current role assignments, including agent/assignment id,
revision, version, artifact/content digest, complete tool inventory, pinned
runtime/plugin, native cron off and role-specific AgentCash state. The server
re-locks the role bindings after the remote probe and rechecks the saved
snapshot on every new intake. Relevant pause, revision, artifact or principal
drift closes admission; unrelated assignments do not. Compatibility readiness
can keep a legacy profile operational but can never admit the new workflow.

**Why.** A global package bump would silently change existing Iris tools and
could invalidate active assignments or require unrelated restarts. A stored
"ready" flag without revision binding would allow new work after the native
profile and Enterprise authority diverged. Per-profile opt-in preserves the
existing product while making new cross-team authority fail closed.

**Operational consequence.** Deploy the Worker and migration with admission
off, update only the selected profiles, verify both attestations, then enable
that workspace. A newly invited Finance employee must start with compatibility
discovery disabled, receive the Finance role immediately, and never have the
starter Partnerships search approved. Hosted acceptance still requires the
second real member and exact native probes; local fixtures cannot replace it.

---

## C86. Warm capacity begins with a narrow, revocable discovery credential

**Decided September 19, 2026.** A new Hermes Cloud pool profile receives its
permanent Enterprise agent UUID before it can become invitation capacity. A
stepped-up workspace Admin prepares one random 32-byte discovery bearer for
that unused identity. Enterprise returns the bearer once and stores only a
workspace-and-agent-scoped digest. Before verified registration, it expires in
24 hours and can call only the read-only skills and tools discovery routes.
Registration links the exact credential to live-attested capacity and keeps it
valid across restarts until assignment or revocation.

The bootstrap contract is the historical Partnerships 1.7 profile: exact
runtime, plugin source identity, role, configuration digest, skill artifact and
content digests, tool inventory, AgentCash wallet state and disabled native
cron. Its connector must also attest the exact permanent workspace and agent
IDs and the configured Enterprise public origin. Registration and invitation
acceptance probe the real connector. Acceptance performs network I/O outside
the database transaction, then locks and rechecks the invitation, capacity,
grant and first assignment materialization before atomically copying the digest
to a `token_digest` runtime binding. The stored readiness time is the probe's
actual completion time.

After assignment, every token-digest run re-attests the fixed managed process
and the agent's current explicit assignment before provider submission. This
allows reviewed P1.8 or Finance transitions without weakening source, origin,
artifact or tool checks. A managed flag, origin, plugin source, assignment or
inventory mismatch blocks execution. Existing fixed Iris bindings keep their
legacy HMAC and compatibility readiness behavior.

**Why.** A connector control secret proves access to the dashboard route but
does not prove which Enterprise identity or governed profile the native process
will load. A discovery credential lets the native initializer read only the
configuration it must validate, without creating an agent, granting execution
or exposing a reusable plaintext secret in the database. Linking readiness to
the same grant prevents synthetic or unclaimable capacity rows from satisfying
an invitation.

**Operational consequence.** The generated discovery bearer and the existing
Cloud connector control secret are separate Admin inputs. No Cloud lifecycle,
wallet funding or paid provider call occurs in prepare, registration or
acceptance. Revoking available capacity quarantines it; reserved capacity must
first be released by withdrawing its invitation. Existing opaque
`HERMES_RUNTIME_AGENTS` credentials are left unchanged.
