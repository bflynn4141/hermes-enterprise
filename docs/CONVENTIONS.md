# Conventions

For anyone — human or agent — adding to this repository. Read the invariants
first; they are the part that cannot be renegotiated in a pull request.

## The invariants

These are properties of the system, not preferences. Each one has a test, and
the test is the thing to keep passing.

1. **A decision is recorded only by the guarded decision routes.**
   `POST /w/:ws/requests/:id/decisions` (M4) is the only writer of
   `decisions`. Typed approvals move a request out of `pending` through
   `POST /w/:ws/requests/:id/approval/decisions`, which applies the same
   step-up, surface, Origin and CSRF guards plus the approval policy's
   reviewer rules. Legacy requests require an Admin session; a governed
   Finance invoice additionally allows only its named active audience member
   with the Finance reviewer role. Both paths require step-up freshness, an
   `X-Requested-From: inbox` header, an allowlisted `Origin` and a CSRF token,
   and it does everything in one transaction. No other route, job, queue
   consumer, cron handler or tool may write `decisions` or move a request out of
   `pending`; a new path that does needs the same guards and its own tests.

2. **The `agent` role never decides.** Three layers, and all three stay:
   * the database grants (`migrations/0004_grants.sql`, asserted by
     `test/db/grants.test.ts`);
   * the `AgentDb` interface the Workflow receives, which will have no
     `decide`, `execute`, `invite`, `role` or `job` method;
   * the block validator (`packages/shared/src/commands.ts`), which rejects a
     model-authored block carrying a human-only command.

   If you find yourself wanting to grant the agent role one more privilege,
   that is the signal to add a route, not a grant.

3. **Effects are separate from decisions.** A decision records what a human
   decided. Anything that crosses a system boundary as a result — an access
   grant, an email, a payment, a signature — is an `effects` row in `pending`
   that a human with the required role executes. A decision never executes one.
   In the pilot every execution returns `unavailable` with honest copy.

4. **Counts are derived from views.** `v_inbox_count`, `v_pending_grants`,
   `v_created_documents`, `v_decision_count`, `v_session_status`. Never add a
   counter column. The demo's property that four requests reach zero in any
   order comes from deriving them.

5. **No real outreach, payment or signature code.** No SMTP, no payment
   provider, no signature provider, no webhook that triggers one. Not behind a
   flag, not "just for testing". The row records the requirement; a human acts.

6. **Every cross-system side effect after a commit is a `jobs` row**, written in
   the same transaction as the change, with a key containing a uuid.

7. **`workspace_id` comes from the URL path plus a members lookup.** Never from
   a header, a query parameter, a cookie or a request body. A test forges both a
   header and a query parameter and asserts they are ignored.

8. **`events` and `stream_events` are append-only.** No role has UPDATE or
   DELETE, and a trigger refuses both for the owner too. Erasure goes through
   `redact_subject`, which rewrites the subject rows and leaves the audit ids.

9. **Cross-team authority is server-derived and revision-bound.** A model may
   publish only an immutable intake id plus its expected hash. The server owns
   the human authorization, source digests, role/recipient, record revisions,
   run grants and correction lineage. An unsigned agreement draft or model
   assertion is never engagement authority. Revised terms invalidate older
   undecided bindings; decided receipts remain immutable.

10. **An audience follows the whole request graph.** A request with one or
    more `request_audiences` rows is visible only to an active named member
    through list/detail, documents, effects, notes, history, counts, event
    replay and live delivery. Generic agent reads have no named human principal
    and therefore exclude every scoped request/document. An empty live audience
    is deny-all, not workspace broadcast. Requests without an audience preserve
    legacy workspace visibility.

## Directory ownership

| Directory | Owns | Do not |
|---|---|---|
| `packages/shared` | The contract: event schemas, refs, enums, document payloads, the run-log validator, the command registries, the mock stream. Pure TypeScript with one dependency (`zod`). | Import anything from `apps/*`. Reach for `any`. Add a runtime dependency without a reason in `docs/DECISIONS.md`. |
| `apps/worker` | The Worker: routes, auth, the tenant transaction, the hubs, the Workflow, jobs, the Drizzle schema, the SQL migrations, the database scripts. | Redefine a contract type locally. Read `workspace_id` from anywhere but the path. Query outside `withTenantTransaction` on a tenant route. |
| `apps/client` | The client bundle (a placeholder until M2). | Talk to Postgres. Trust an event it did not validate against the contract. |

Cross-package imports go one way: `apps/*` may import `@hermes/shared`;
`packages/shared` imports nothing of ours.

## Adding a migration

1. Create `apps/worker/migrations/NNNN_short_name.sql`, numbered after the last
   one. Never edit an applied migration: staging and production would disagree
   about what that number means.
2. Write every statement so it can run twice — `CREATE TABLE IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`,
   `DROP POLICY IF EXISTS` before `CREATE POLICY`, `DROP TRIGGER IF EXISTS`
   before `CREATE TRIGGER`, `INSERT ... ON CONFLICT`. CI re-applies everything
   in a disposable shadow database and fails if the schema fingerprint moves.
3. Follow expand/contract: add the new thing, deploy, backfill, switch readers,
   and only then remove the old thing in a later migration. A code rollback must
   never need a reverse migration.
4. A new tenant table needs nothing extra for row-level security: `0003` covers
   every table with a `workspace_id` and raises if one is unprotected. It *does*
   need grants in `0004` and an entry in the expectation in
   `test/db/grants.test.ts` — which is the point, because that file is what a
   reviewer reads.
5. Add the table to `src/db/schema.ts` and to `ALL_TABLES`. The drift test fails
   otherwise.
6. Run `pnpm db:migrate`, then `pnpm db:migrations:verify`. While iterating on a
   migration you have already applied to your local database,
   `MIGRATE_ALLOW_EDIT=1 pnpm db:migrate`; drop the volume
   against a disposable test database before you finish. Never stop, rename or
   reset a shared local Postgres container merely because it predates the
   current task.

## Adding an event kind

1. Add the schema in `packages/shared/src/events.ts`, put it in the union, add
   it to `EVENT_KINDS_CONTRACT` and give it a stream in `EVENT_STREAM`.
2. Decide whether the `agent` role may publish it. If the kind is not
   `message.*` or `run.*`, the trigger in `0005` refuses it, which is the
   default and usually correct answer. The one widening is in `0013`:
   `request.created` and `entity.updated` are allowed, and only for a payload
   naming a `requests` row this workspace's run engine actually wrote. If you
   want a third exception, write the predicate — "this role may publish X" is
   the shape that eventually lets a tool publish `decision.recorded`.
3. If it changes the run state machine, add a rule to the run-log validator and
   a case to `test/run-log.test.ts`.
4. Add it to the mock stream if a client will need to render it.

## How tests run

```sh
pnpm test        # everything
pnpm test:unit   # only the tests that need no database
```

Five groups, plus explicit browser coverage:

| Group | Where | Needs |
|---|---|---|
| `packages/shared` | Node | nothing |
| `apps/client` unit | Node | nothing |
| `apps/worker` project `unit` | Node | nothing |
| `apps/worker` project `worker` | workerd, through `@cloudflare/vitest-pool-workers` and the real `wrangler.jsonc` | nothing |
| `apps/worker` project `db` | Node | Docker Postgres (`pnpm db:up && pnpm db:migrate`) |

`pnpm test:browser:mock` covers selected client flows in Chromium against the
mock adapter. It is credential-free and deliberately does not claim Worker,
database, WorkOS or provider coverage; `pnpm e2e:live` is the isolated real
Worker path.

The `db` project runs one file at a time: the tests share one database, and
racing them over the same rows would make failures depend on scheduling. Each
test seeds its own workspace with fresh uuids, so they do not collide.

`pnpm db:test` creates the roles and runs the `db` project on its own — the
grant assertion, the fail-closed row-level security test and the jobs claim.

## Style

* TypeScript strict, everywhere, including `noUncheckedIndexedAccess`. No `any`
  leaks out of `packages/shared`.
* Dependencies are pinned to exact versions. No ranges.
* Comments say *why*. The code already says what. A comment that restates the
  line below it is noise; a comment that records the failure a line prevents is
  the reason the line survives the next refactor.
* Every server module carries a header comment explaining what it is for and
  which invariant it serves, and every non-obvious rule has a test named after
  the behaviour rather than the function.
* Errors carry a machine-readable `reason`. The client keys its copy off it;
  a string comparison on a message is not a contract.
* Nothing logs a key, a token, a presigned URL or applicant text. `events` rows
  hold ids and enum kinds only.

## Secrets

Never commit one. `apps/worker/.dev.vars.example` names every secret the product
uses and holds a value for none; `apps/worker/.env.example` carries the two
local Hyperdrive connection strings wrangler needs. CI runs gitleaks, and a unit
test asserts `wrangler.jsonc` never carries a secret name or a
`localConnectionString`.

Whoever can deploy can ship code that decrypts every tenant's provider key, so
the deploy pipeline is part of the trust boundary: the Cloudflare API token is
scoped to this Worker, production needs an environment reviewer, and packages
are pinned.
