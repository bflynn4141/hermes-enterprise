# Hermes Enterprise

An agent workspace. Maya, a workspace Admin, talks to her agent Iris while the
app follows the work. Every decision — admissions, documents, sending, payment,
signature — is made by a human, and the product is built so that this is a
property of the database and the routes rather than a promise in a document.

This repository is milestone **M1: rails, contract and operations**. The run
engine, WorkOS sign-in, provider keys and the client arrive in M2 to M5.

## What is real, and what is not

| Real today | Stubbed, with a landing milestone |
|---|---|
| The full Postgres schema: 37 tables, forced row-level security, three roles, the grant matrix, the append-only audit, the derived views | The run engine. `RunAttempt` is registered as a Workflow and throws `NonRetryableError` (M3) |
| `GET /health`, `GET /w/:ws/bootstrap`, `GET /w/:ws/events?stream=&after=` | WorkOS AuthKit. `AUTH_MODE=fake` maps an `x-dev-user` header to a seeded user; the WorkOS adapter implements the same `getSession(c) -> {userId, sid, authenticatedAt}` (M2) |
| One transaction per tenant request, with `SET LOCAL app.workspace_id` and `app.user_id` derived from the path plus a members lookup | Provider keys. The `workspace_provider_keys` table and its envelope-encryption columns exist; nothing writes them yet (M2) |
| The zod event contract, the refs format, the run-log validator, the two command registries and the block validator, the mock event stream | The client. `apps/client/dist/index.html` is a placeholder shell; the demo's reducer is ported in M2 |
| `SessionHub` and `WorkspaceHub` Durable Objects: hibernating sockets, auto-response heartbeat, fan-out, eviction | Queue and cron handlers. Both are wired and log; the bodies land in M2 and M4 |
| Both wrangler environments, the queues with dead-letter queues, two cron triggers, two Hyperdrive bindings, the CPU limit | Outreach, payment and signature. **No code for these exists or ever will in this repository**; they are `effects` rows a human executes |

## Run it locally

Everything except `pnpm install` works offline.

```sh
pnpm install

# Postgres 17 in Docker on 127.0.0.1:5433 (5432 is often taken).
pnpm db:up

# Creates the three roles, applies every migration, then re-applies them all
# and asserts the schema fingerprint did not change.
pnpm db:migrate

pnpm typecheck
pnpm test          # shared unit tests, worker unit tests, workerd tests, database tests
```

To serve it:

```sh
cd apps/worker
cp .env.example .env              # the two Hyperdrive local connection strings
cp .dev.vars.example .dev.vars    # secret names; all empty in M1
node scripts/seed-dev.mjs         # one workspace, one Admin, one Member
npx wrangler dev --local
```

Then:

```sh
curl http://localhost:8787/health
curl -H "x-dev-user: maya@nous.example" \
  http://localhost:8787/w/11111111-1111-4111-8111-111111111111/bootstrap
curl -H "x-dev-user: maya@nous.example" \
  "http://localhost:8787/w/11111111-1111-4111-8111-111111111111/events?stream=workspace&after=0"
```

`/health` returns 200 only when Postgres answers through **both** Hyperdrive
configs (they are separate configs with separate database roles) and a Durable
Object round trip succeeds. Anything else is 503 with a per-check reason.

## Layout

```
packages/shared    the contract: events, refs, enums, document payloads,
                   the run-log validator, the command registries, the mock stream
apps/worker        the Cloudflare Worker: Hono routes, Durable Object hubs,
                   the Workflow stub, the Drizzle schema, the SQL migrations
apps/client        the client bundle (placeholder in M1)
docs/              DECISIONS.md, CONVENTIONS.md
```

`docs/CONVENTIONS.md` is the file to read before changing anything: it says who
owns which directory, how to add a migration, and which invariants must never be
violated.

## The invariants, in one place

1. **Decisions only through the guarded route.** `POST /w/:ws/requests/:id/decisions`
   is the only path that changes a request's status. It is not built yet (M4);
   nothing else may take its place.
2. **The agent role never decides.** The `agent` database role has no INSERT on
   `decisions`, `effects`, `members`, `invitations` or `jobs`, and no UPDATE on
   `requests` or `jobs`. A trigger limits what it may publish to the outbox to
   `message.*` and `run.*`. CI asserts the whole matrix.
3. **Effects are separate from decisions.** A decision records what a human
   decided. What that implies — an access grant, an email, a payment, a
   signature — is a separate `effects` row that a human with the required role
   executes. In the pilot every execution returns `unavailable`.
4. **Counts are derived.** `v_inbox_count`, `v_pending_grants`,
   `v_created_documents`, `v_decision_count` and `v_session_status` are views.
   There is no counter to drift.
5. **No real outreach, payment or signature code.** Not now, not later, not
   behind a flag.

## Stack

Node 26, pnpm workspaces, TypeScript strict everywhere. Cloudflare Workers with
Hono, Durable Objects, Workflows, Queues and Hyperdrive. Postgres 17 (Neon in
staging and production), Drizzle for typed queries and hand-written SQL for the
migrations. zod for the contract. Vitest, including the Workers pool for tests
that run inside workerd. Every dependency is pinned to an exact version.
