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
* reading provider keys is itself a step-up action, so a 401 there is
  `reauth_required`, not "signed out". `ui.providerKeysLocked` keeps "no keys"
  and "not allowed to look right now" as different screens.

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
* **`RecordsTable`**'s optional calculation column fabricates
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
