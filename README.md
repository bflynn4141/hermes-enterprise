# Hermes Enterprise

An agent workspace. Maya, a workspace Admin, talks to her agent Iris while the
app follows the work. Every decision — admissions, documents, sending, payment,
signature — is made by a human, and the product is built so that this is a
property of the database and the routes rather than a promise in a document.

This repository is milestone **M1: rails, contract and operations**, the server
half of **M2: sign-in, workspaces, sessions, members, hubs and jobs**, and
**M3: the run engine** — turns, the tool loop, the four controls and the failure
taxonomy. The decision route arrives in M4.

## What is real, and what is not

| Real today | Stubbed, with a landing milestone |
|---|---|
| The full Postgres schema: 37 tables, forced row-level security, three roles, the grant matrix, the append-only audit, the derived views | The decision route. `POST /w/:ws/requests/:id/decisions` is deliberately absent until M4 |
| `GET /health`, `GET /w/:ws/bootstrap`, `GET /w/:ws/events?stream=&after=` | Attachments, documents and the Ask/Plan tool allowlists (M3.5) |
| The run engine: `POST /w/:ws/sessions/:id/turns`, the `RunAttempt` Workflow with deterministic step names, the twelve tools, Stop, Guide, Queue, Retry, waiting on a human, the failure taxonomy, and the minute orphan sweep | The `receipt` job. It is typed, parsed and logs; M4 posts the template into the originating session |
| WorkOS AuthKit behind the same `getSession(c) -> {userId, sid, authenticatedAt}` interface: `/auth/login` (with `max_age: 0` for step-up), `/auth/callback` (sealed cookie, user and membership mirror, `auth_sessions`), `/auth/session` (re-seal, stream heads, hub ticket), `/auth/logout`; local JWT verification against a JWKS cached ten minutes; refresh on expiry, 401 only on a terminal `invalid_grant`, 503 with `Retry-After` on a transient failure | The decision route. `POST /w/:ws/requests/:id/decisions` is deliberately absent until M4; nothing else may take its place |
| `POST /workspaces`, members and invitations (WorkOS `sendInvitation`, resend, withdraw, role change, removal) with the revocation transaction, the last-Admin rule, and the Events API poller that routes WorkOS-side changes through the same transaction | Outreach, payment and signature. **No code for these exists or ever will in this repository** |
| Sessions: create from the workspace defaults, list (owner-private plus shares), rename, pin, archive, drafts, message pagination, shares with a hashed token and a cutoff, feedback | Turns, stop, retry and guidance (M3) |
| Uploads end to end: presigned PUT, magic-byte sniff and sha256 on `complete`, the `extract` queue with a DLQ consumer that writes a reason, PDF text through `unpdf` under workerd, extracted text in R2 with a 6,000-token read cap, the daily orphan sweep and the erasure hooks | Rendered documents. The `renders` consumer is a scaffold with its dedupe and DLQ handling; `@react-pdf/renderer` under workerd is still unverified (M4) |
| Both WebSocket upgrade routes with the `Origin` check, the socket attachment, HMAC hub tickets, evict fan-out and `requestStop`; `publish`, `evict` and `workos_sync` jobs run by the committing request and drained by the minute Cron | The orphan sweep's Workflow-status half, and the `receipt`, `render` and `reverify` job runners (M3 and M4) |
| One transaction per tenant request, with `SET LOCAL app.workspace_id` and `app.user_id` derived from the path plus a members lookup | Nothing here. `resolveKey` now runs inside every provider step, so plaintext exists only for that step |
| Provider keys end to end: envelope encryption on Web Crypto, `resolveKey`, verification against each provider's list-models endpoint, rotation, removal, the KEK re-wrap routine, `GET /w/:ws/catalog` | The AI Gateway passthrough. Wired behind `MODEL_GATEWAY_MODE`, off in every environment, with a test that payload logging can never be on |
| The zod event contract, the refs format, the run-log validator, the two command registries and the block validator, the mock event stream | The client. `apps/client/dist/index.html` is a placeholder shell; the demo's reducer is ported in M2 |
| `SessionHub` and `WorkspaceHub` Durable Objects: hibernating sockets, auto-response heartbeat, fan-out, eviction, and the `forward` RPC that carries deltas out and Stop back | The nightly validator Workflow (M5a) |
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
cp .dev.vars.example .dev.vars    # secret names; empty is fine in fake mode
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

# The session refresh the client calls every four minutes: it re-seals the
# cookie and returns both stream heads and a hub ticket.
curl -H "x-dev-user: maya@nous.example" \
  "http://localhost:8787/auth/session?ws=11111111-1111-4111-8111-111111111111"

curl -X POST -H "x-dev-user: maya@nous.example" -H 'content-type: application/json' \
  -d '{"title":"Partner applications"}' \
  http://localhost:8787/w/11111111-1111-4111-8111-111111111111/sessions
```

`/health` returns 200 only when Postgres answers through **both** Hyperdrive
configs (they are separate configs with separate database roles) and a Durable
Object round trip succeeds. Anything else is 503 with a per-check reason.

## Bring your own key

Hermes never holds a model-provider account of its own. A workspace brings its
own key, the workspace is billed by its own provider, and the product's job is
to store that key so that nobody — including whoever runs this service — can
read it by accident.

**How Brian adds his Anthropic key.** In the client (M5) it is
Settings > Provider keys > Add: choose the provider, paste the key, Verify. The
route requires an Admin session and a sign-in from the last five minutes (the
same step-up the decision route uses), computes a SHA-256 fingerprint and the
last four characters, encrypts the key, and probes the provider's free
list-models endpoint. A 401 marks it invalid, a 200 marks it verified and
records which models it covers, and a 403, 429 or 5xx leaves it unverified with
a job to try again — because a throttled probe taught us nothing about the key.
Two 403s in a row means the key is probably scoped rather than broken, so the
probe becomes a one-token call and the key is marked "verified (scoped)".

Until that client exists, the same routes answer over the fake-auth dev server:

```sh
cd apps/worker
# A KEK for local development: 32 random bytes, base64. Put it in .dev.vars as
# KEK_V1. Never reuse it anywhere that matters.
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"

npx wrangler dev --local
```

```sh
WS=11111111-1111-4111-8111-111111111111
AUTH='x-dev-user: maya@nous.example'

# Add and verify in one call. The response carries the masked row only.
curl -sX POST "http://localhost:8787/w/$WS/provider-keys" \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{"provider":"anthropic","label":"Ops key","key":"<paste the key>"}'

# What Settings shows: provider, label, last4, fingerprint prefix, status,
# verified models, who added it, and the dates. Never the key.
curl -s -H "$AUTH" "http://localhost:8787/w/$WS/provider-keys"

# The model menu. Every row, with this workspace's answer attached.
curl -s -H "$AUTH" "http://localhost:8787/w/$WS/catalog"

# Re-verify, rotate (a new row that names the one it replaces), remove.
curl -sX POST "http://localhost:8787/w/$WS/provider-keys/$KEY_ID/verify" -H "$AUTH"
curl -sX POST "http://localhost:8787/w/$WS/provider-keys/$KEY_ID/rotate" \
  -H "$AUTH" -H 'content-type: application/json' -d '{"key":"<the new key>"}'
curl -sX DELETE "http://localhost:8787/w/$WS/provider-keys/$KEY_ID" -H "$AUTH"
```

Removing a key stops the runs that were using it and says how many, then zeroes
the ciphertext. Rotating keeps the old row so that `model_calls` history stays
answerable: a run from last month still points at the key that paid for it.

**How it is stored.** Envelope encryption on Web Crypto. Each key gets its own
AES-GCM data key; that data key is wrapped by a key-encryption key held as the
Worker secret `KEK_V{n}`. The additional authenticated data is split so the two
layers bind different things — the key ciphertext binds `(workspace_id, key_id)`
and the wrap binds `(workspace_id, key_id, kek_version)` — which is what lets a
KEK rotation re-wrap 48 bytes per row without any provider key's plaintext
existing anywhere. Moving a ciphertext to another row, or reading it as another
tenant, fails to decrypt: an independent check of what row-level security
already enforces.

The plaintext exists only inside the request that uses it. `resolveKey` runs
inside every provider step, so a rotated key is picked up at the next step and a
removed one stops the run at the next step. Nothing logs a key: every log line
this milestone writes goes through a redactor that strips `Authorization`,
`x-api-key` and `cf-aig-authorization` by name and key shapes by pattern, and a
test asserts that neither a log nor an error message survives carrying one.

**What the model menu does with it.** A catalog row is offered to a workspace
only when the catalog does not disable the row *and* the workspace holds a
verified key for that row's provider. The two are different answers and the API
says which: `disabled_code` is `catalog` for a model the pilot does not offer,
and `no_key`, `key_unverified` or `key_invalid` for one the workspace could
reach if it did something. Prices come from the catalog with the date they were
checked, and the Usage screen says "estimated, billed by your provider".

**Why not AI Gateway's own BYOK.** It stores keys in Secrets Store (100 per
account in beta, 20 gateways), its aliases work only on passthrough URLs with no
read-back, and any token with Run permission reaches every stored key. That is
fine for an account's own keys and wrong for tenant keys. An optional gateway
sits behind `MODEL_GATEWAY_MODE=passthrough`, is off in every environment, and
sends `cf-aig-collect-log-payload: false` on every request so that turning it on
does not create a second copy of every applicant's text. A test asserts there is
no configuration in which payload logging is on.


## Uploads

A file goes from the browser to R2 directly, and is checked when it arrives.

```
POST   /w/:ws/attachments              declare {name, size, mime} -> row + a presigned PUT
PUT    <the URL that came back>        the bytes, straight to R2 (the browser does this)
POST   /w/:ws/attachments/:id/complete sniff, hash, mark ready, enqueue `extract`
GET    /w/:ws/attachments/:id          metadata, plus a 5-minute presigned GET for the viewer
DELETE /w/:ws/attachments/:id          soft-delete the row, remove the object and its text
```

`/w/:ws/files` is the same five for `agent_files` — the agent's Context sources
— over the same bucket, the same sniff and the same extraction. Adding or
removing one is an Admin's act, because Context governs every future run.

**Limits.** 20 MB, one of `application/pdf`, `text/markdown`, `text/plain`, and
10 uploads per user per minute (a `rate_counters` upsert, counted at declaration
rather than completion: a script that mints a thousand URLs it never uses has
still asked us to sign a thousand URLs). The presigned PUT lasts 15 minutes; the
viewer's GET lasts 5.

**Why `complete` exists.** The name, the size and the type are all the client's
opinion. `complete` streams the object back through the binding, compares the
first bytes with the declared type, and computes the sha256 the row records. A
renamed executable declared as `text/plain` is refused, the row is marked
`failed` with the reason, and the object is deleted rather than left for the
daily sweep. Two tests cover exactly that, plus a size that disagrees with the
declaration.

**Extraction.** `complete` enqueues `extract`, whose consumer writes the text to
R2 next to the object as `{key}.txt` and puts `text_length` and `token_estimate`
on the row. The queue has `max_retries: 3` and a dead-letter queue, and the DLQ
has a consumer whose whole job is to write `extraction_status = 'failed'` with a
reason — without it an exhausted message is deleted and the row says "preparing"
forever. The engine reads the text through
`getDocumentText(env, workspaceId, fileId, offset)`, which returns at most 6,000
estimated tokens per call and the offset to ask for next.

PDF parsing uses `unpdf` (a serverless build of pdfjs). The plan marked pdfjs
under workerd **unverified** and left it as a spike; the spike was run and it
works, and `test/worker/uploads.test.ts` keeps it that way by parsing a real PDF
in the Workers runtime on every CI run. It costs about 570 KB gzipped. A PDF
that cannot be parsed, or a scan with no text layer, becomes a `failed` row with
an honest reason rather than an empty document presented as extracted.

**Secrets.** The bucket itself is a binding (`UPLOADS`) and needs no credential.
Three secrets exist only so the Worker can *sign* a presigned URL, so that 20 MB
of bytes never pass through a Worker request:

| Name | What it is |
|---|---|
| `R2_ACCOUNT_ID` | the Cloudflare account id; the S3 endpoint is `https://<account>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | an R2 API token scoped to the uploads bucket, Object Read & Write |
| `R2_SECRET_ACCESS_KEY` | its secret |

`R2_BUCKET` is a plain var per environment, not a secret: a presigned URL has to
spell the bucket out in its path, and a binding cannot supply a name.

**Local versus production.** `wrangler dev --local` simulates R2 on disk, with no
account and therefore nothing to sign with. With the three secrets absent, the
declare route answers `upload.direct: true` and a URL on this Worker —
`PUT /w/:ws/attachments/:id/upload` — which stores the bytes through the
binding. The client is unchanged either way: it PUTs to whatever URL it was
given. **That route is development-only**: outside `ENVIRONMENT=development` it
answers 404, as though it did not exist, and it still runs inside the tenant
transaction, so the caller must be a member and the row must already exist.

**Lifecycle, erasure and backup.** The nightly Cron deletes objects with no
completed `attachments` row after 24 hours — a presigned PUT is a promise the
browser may not keep, and an object nobody accounts for is otherwise permanent.
The workspace is the first segment of every key (`w/{workspace}/uploads/{id}`),
which is what makes erasure a prefix delete (`deleteWorkspacePrefix`) and what
lets the sweep ask the right tenant about an orphan without a database role that
can read across tenants. `backup_uploads` is a `jobs` row that copies a
workspace's uploads prefix to the backup bucket; it logs that it did nothing
where no `BACKUP_UPLOADS` binding exists, which is every development machine.


## Running a turn

The run engine is a Cloudflare Workflow, one instance per run attempt, id
`${run_id}-a${attempt}`. `create()` throws on a duplicate id and only
`createBatch()` is idempotent, so the `runs` row is the idempotency record: the
turns route inserts it first under `UNIQUE(session_id, client_turn_id)`, a
duplicate POST returns the existing run with 200, and only then is the instance
created, with a duplicate-id error treated as a no-op.

In development the engine answers from `ScriptedProvider`, so a fresh checkout
with no provider key can run a turn end to end offline:

```sh
cd apps/worker
node scripts/seed-dev.mjs
npx wrangler dev --local          # MODEL_SCRIPTED=1 is set in wrangler.jsonc
```

```sh
WS=11111111-1111-4111-8111-111111111111
AUTH='x-dev-user: maya@nous.example'

SID=$(curl -sX POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"title":"Partner applications"}' \
  "http://localhost:8787/w/$WS/sessions" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# `client_turn_id` is required: it is the client's idempotency key, and two
# concurrent POSTs of one turn yield one instance and two 200s.
curl -sX POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"client_turn_id":"turn-1","text":"Score the attached application."}' \
  "http://localhost:8787/w/$WS/sessions/$SID/turns"

# The whole run, replayed from the outbox:
curl -s -H "$AUTH" \
  "http://localhost:8787/w/$WS/events?stream=session&session_id=$SID&after=0"
```

The replay shows `run.started`, a `run.step` and a `message.reset` per provider
step attempt, batched `message.delta` rows, `message.final`, a `run.step` pair
per tool call, a `run.focus` when a tool opens or creates something, and one
`run.status`. The proposal lands in the Inbox as a `pending` request; nothing in
this repository can move it out of `pending` except the decision route (M4).

The four controls are rows first and RPCs second, so a lost RPC costs latency
rather than the control:

```sh
RUN=...   # the run_id the turns route returned
BASE="http://localhost:8787/w/$WS/sessions/$SID/runs/$RUN"

curl -sX POST -H "$AUTH" "$BASE/stop"                                  # stop_requested + stopping, then the hub
curl -sX POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"text":"Weight the references higher."}' "$BASE/guide"          # read between steps
curl -sX POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"text":"and then the second application"}' "$BASE/queue"        # drained after completion
curl -sX POST -H "$AUTH" "$BASE/retry"                                 # ${run_id}-a2, resuming at the failed turn
curl -sX POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"key":"cohort_cap","value":"30"}' "$BASE/context"               # answers a waiting run
```

### What the agent can and cannot do

Twelve tools: six reads (`list_requests`, `get_request`, `get_document_text`,
`get_workspace_context`, `get_history`, `list_members`), five proposals
(`propose_request`, `save_review_note`, `set_context_field`,
`propose_instruction`, `ask_for_context`) and one view change (`set_focus`).
There is no `decide`, `send`, `pay`, `sign`, `grant` or `invite` tool, and a
build-time test fails if a registered name ever looks like one.

Three layers keep it that way, and all three have tests: the database grants
(`migrations/0004_grants.sql`), the `AgentWrites` interface the tools receive
(six methods, with a type test asserting it has no `decide`, `execute`,
`invite`, `role` or `job` method), and the block validator, which drops a
model-authored button carrying a human-only command before anything renders it.

### The M0 spike against a real provider

The one thing here that touches the network, and it runs only when you give it a
key. Nothing is stored: the key is read from the environment and never written
to a file, a log line or an error message.

```sh
cd apps/worker
HERMES_SPIKE_PROVIDER=deepseek HERMES_SPIKE_KEY=sk-... \
  HERMES_SPIKE_MODEL=deepseek-chat pnpm spike
```

It prints the tool call, the measured Stop latency against the 1 s budget, the
delta-batch count and whether the reasoning replay was accepted. `pnpm test`
cannot run it: the vitest project only exists when `HERMES_SPIKE_KEY` is set.

## Signing in

Two modes, one interface. Every route asks `getSession(c)` and gets
`{ userId, sid, authenticatedAt }`; only the adapter behind it changes.

### `AUTH_MODE=fake` (the default for local development)

An `x-dev-user` header names a seeded user by id or email. The row must already
exist, so a typo is a 401 rather than an invented identity. Step-up works here
too: the adapter writes the same `auth_sessions` row the WorkOS one does, so
ageing that row exercises the five-minute freshness rule without WorkOS.

```sh
curl -H "x-dev-user: maya@nous.example" \
  "http://localhost:8787/auth/session?ws=11111111-1111-4111-8111-111111111111"
```

### `AUTH_MODE=workos`

Set three secrets in `apps/worker/.dev.vars` (or with `wrangler secret put` for
a deployed environment):

| Secret | What it is |
|---|---|
| `WORKOS_API_KEY` | The environment's secret key, `sk_...` |
| `WORKOS_CLIENT_ID` | The environment's client id, `client_...` |
| `WORKOS_COOKIE_PASSWORD` | At least 32 characters, ours to generate. Rotating it signs everyone out, so it happens off-hours |
| `HUB_TICKET_SECRET` | Optional; signs the WebSocket tickets. Falls back to `WORKOS_COOKIE_PASSWORD` |
| `WORKOS_REDIRECT_URI` | Optional; only when the browser reaches us on a different host than the Worker sees |

Then `AUTH_MODE=workos wrangler dev --local`, or deploy: staging and production
already set `AUTH_MODE=workos` in `wrangler.jsonc`, and a unit test asserts they
always will.

### What to configure in the WorkOS dashboard

Per environment (staging and production are separate WorkOS environments with
their own client id and secrets):

1. **Redirect URI** — exactly `https://<host>/auth/callback`
   (`http://localhost:8787/auth/callback` for local development). WorkOS matches
   it exactly; a trailing slash is a different URI.
2. **Roles** — two, with the slugs `admin` and `member`. The slugs are what the
   membership mirror reads; the display names are yours. `member` should be the
   default role for the organization.
3. **MFA** — on, environment-wide TOTP for non-SSO users. It is configured per
   environment or per organization, never per role.
4. **JIT provisioning — off.** With it on, anyone with a matching email domain
   joins an organization without an invitation, which would route around the
   invitation rules and the members mirror.
5. **Public sign-up — off.** People arrive by invitation or by creating a
   workspace while signed in; a public sign-up page creates accounts with no
   organization and no route into one.
6. **Email** — AuthKit sends the invitation and magic-link email. Configure a
   custom email provider if the default sender is not acceptable; this
   repository contains no mail code and never will.

`/auth/callback` mirrors the user and the membership from the authentication
response, so someone who has just accepted an invitation sees the workspace
immediately rather than when the poller next runs. The Events API poller on the
minute Cron catches everything changed in the dashboard and routes it through
the same transaction our own removal route uses.

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
