# Restore drill

A backup nobody has restored is a hypothesis. This is the procedure that turns
it into a fact, and the plan schedules it at M1, M4 and then quarterly.

Budget 90 minutes. Do it on a weekday morning, not after an incident: the first
time you read this should not be the time you need it.

**Nothing here touches production.** Every step restores into a throwaway
database and a throwaway Neon branch. If a step tells you to connect to
production, you are reading the wrong file.

---

## 0. What you need

| Thing | Where it comes from |
|---|---|
| A dump object | `s3://<backups bucket>/pg/hermes-YYYY/MM/DD/HHMM.dump`, written by `.github/workflows/backup-nightly.yml` |
| R2 read credentials | A **separate** token from the backup job's, which is write-only. Mint a temporary read token for the drill and delete it afterwards. |
| `pg_restore` 17 | `brew install postgresql@17`, or the CI image |
| The KEK versions the target environment holds | `wrangler secret list --env <env>` |
| A WorkOS API key, optionally | Only if you are drilling the membership reconciliation against a real organization |

---

## 1. Fetch the dump

```sh
export ACCOUNT_ID=...            # Cloudflare account
export BUCKET=hermes-backups-production
export AWS_ACCESS_KEY_ID=...     # the temporary read token
export AWS_SECRET_ACCESS_KEY=...
export AWS_DEFAULT_REGION=auto
export ENDPOINT="https://${ACCOUNT_ID}.r2.cloudflarestorage.com"

# Last night's, and the newest is not always the one you want: if you are
# drilling a recovery from a bad deploy, take the one from before it.
aws s3 ls "s3://${BUCKET}/pg/" --recursive --endpoint-url "$ENDPOINT" | tail -5
aws s3 cp "s3://${BUCKET}/pg/hermes-2026/09/15/0240.dump" ./drill.dump --endpoint-url "$ENDPOINT"
```

**Record the object's size and timestamp in the drill log.** A dump that is
suspiciously smaller than the previous night's is the failure this whole
exercise exists to catch, and it is invisible unless somebody writes the number
down each time.

---

## 2. Restore into a throwaway database

```sh
# Local Docker is enough for the reconciliation queries. A Neon branch is
# closer to production and is what to use for a quarterly drill.
pnpm db:down && pnpm db:up
pnpm --filter @hermes/worker db:roles      # the three roles; the dump has --no-owner

pg_restore --dbname "postgres://owner:localdev@127.0.0.1:5433/hermes" \
  --no-owner --clean --if-exists --exit-on-error ./drill.dump
```

`--exit-on-error` matters. Without it `pg_restore` reports a zero exit status
after skipping every statement it could not apply, and a partially restored
database is exactly the thing this drill is meant to distinguish from a
restored one.

### Then prove the schema is the schema

```sh
pnpm db:migrate
```

Re-applying every migration against the restored database is the fastest check
that the dump is from a compatible schema: the runner compares the fingerprint
before and after, and a mismatch means the dump predates a migration the code
now assumes.

---

## 3. The reconciliation

```sh
# Read-only. Reports; changes nothing.
export DATABASE_URL_OWNER="postgres://owner:localdev@127.0.0.1:5433/hermes"
export HERMES_KEK_VERSIONS=1        # what `wrangler secret list` showed
pnpm restore:check
```

Four checks, and each one is silent in a different way if you skip it:

### documents

Lists every document claiming `render_status = 'ready'` with a storage key.
Postgres and R2 are restored from different places at different times, so the
rows can come back without the objects. Check the keys:

```sh
# For each storage_key the check reported:
wrangler r2 object get "$BUCKET_UPLOADS/$KEY" --local=false >/dev/null || echo "missing: $KEY"
```

Then mark the missing ones, so the product says "no longer available" instead of
rendering a spinner forever:

```sh
HERMES_MISSING_KEYS="w/…/documents/…,w/…/documents/…" pnpm restore:check --fix
```

### memberships

The check with a security consequence. WorkOS kept accepting sign-ins during
whatever outage led to the restore; the restored `members` table is from before
it. Someone removed during the gap can sign in again.

```sh
WORKOS_API_KEY=sk_… pnpm restore:check
```

Rows tagged `risk: access` are the urgent ones — active here, not active at
WorkOS. Reconcile them through the product's own route (`DELETE /members/:id`),
not with SQL: the route runs the transaction that revokes shares, unassigns
effects, stops runs and queues the evict fan-out, and a hand-written UPDATE
does none of that.

### kek

Reports the KEK versions the restored provider keys are wrapped under. Every one
of them must still be a secret in the environment you are restoring into. If it
is not, **those keys are unreadable and no rotation can fix it** — the KEK that
could unwrap them is gone. The remedy is to revoke the rows and ask each
workspace Admin to add a new key, which is why old `KEK_V{n}` secrets stay until
every backup that could hold DEKs wrapped under them has expired.

### instances

Lists the runs that were working or waiting at the moment of the dump. Workflow
instances outlive a database restore, so before letting traffic in:

```sh
wrangler workflows instances list hermes-run-attempt --env <env>
# Terminate any instance not in the check's list, and any whose attempt number
# is ahead of its run row's. Both will happily keep writing to a run that no
# longer exists or has been retried past them.
wrangler workflows instances terminate hermes-run-attempt <instance-id> --env <env>
```

Then let the minute Cron's orphan sweep run: it marks runs with no live
instance as `error {retryable: true}`, which is what puts a Retry button in
front of the person whose turn was interrupted.

`jobs` needs nothing. Every job key contains an id and every runner is
idempotent, so a replayed job either finds its work already done or does it
once. That is the property `UNIQUE(kind, key)` was for.

---

## 4. Write it down

In the drill log (`docs/RUNBOOK.md` links to it), record:

- the dump's object key, size and age;
- wall-clock time from step 1 to a green `pnpm restore:check`;
- every check that failed and what it turned out to be;
- anything in this file that was wrong.

The third line is the one that makes the drill worth doing, and the fourth is
the one that makes the next drill shorter.

---

## What this drill does not cover

Stated plainly, because a drill that implies more coverage than it has is worse
than none:

- **R2 objects.** The uploads copy is a separate nightly job
  (`backup_uploads`), and restoring it is a bucket-to-bucket copy this drill
  does not perform. The documents check above is what detects the gap.
- **Durable Object storage.** The hubs hold no truth; there is nothing to
  restore. If that ever stops being true, this section stops being true with it.
- **Workflow instance state.** Not restorable, by design. The instances check
  is the mitigation.
- **Point-in-time recovery.** Neon's 7-day history window is a different and
  faster path for a recent mistake, and it is the first thing to reach for when
  the data loss is hours old rather than days. Drill it separately.
