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
