# Decisions

Choices made while building M1 where the production plan was silent, plus the
places where reality differed from what the plan assumed. Each one says what was
decided, why, and what would change it.

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

## 2. Migrations prove their own idempotence on every run

**Decided.** `pnpm db:migrate` applies everything pending, fingerprints the
schema (columns, constraints, indexes, policies, RLS flags, triggers, grants,
views), re-applies every migration from the beginning, fingerprints again, and
fails if the two differ.

**Why.** A half-applied deploy has to be recoverable by running the runner
again. "These statements are idempotent" is easy to believe and easy to get
wrong — one `CREATE INDEX` without `IF NOT EXISTS` is enough. This turns the
claim into a check that runs every time rather than a test someone remembers to
write.

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
back, asking AuthKit for `max_age: 0`, which yields a new `sid` whose
`authenticated_at` is now.

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
