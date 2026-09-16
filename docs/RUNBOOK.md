# Runbook

What to do, in order, when something needs doing. Written to be read at three in
the morning by someone who did not write it.

Every procedure here names the command and the expected output. A step that says
"check the logs" without saying what you are looking for is a step that gets
skipped.

---

## Contents

1. [Deploy](#1-deploy)
2. [Rollback](#2-rollback)
3. [Numbers: Stop latency, timeouts, limits](#3-numbers)
4. [KEK rotation](#4-kek-rotation)
5. [KEK or key-store compromise](#5-kek-or-key-store-compromise)
6. [Cookie password rotation](#6-cookie-password-rotation)
7. [Restore drill](#7-restore-drill)
8. [Orphan sweep](#8-orphan-sweep)
9. [Workspace deletion](#9-workspace-deletion)
10. [Alerts and thresholds](#10-alerts-and-thresholds)
11. [WorkOS dashboard settings](#11-workos-dashboard-settings)
12. [Secrets, per environment](#12-secrets-per-environment)
13. [First deploy checklist](#13-first-deploy-checklist)

---

## 1. Deploy

**Staging** deploys automatically on a push to `main`
(`.github/workflows/deploy-staging.yml`). **Production** is
`.github/workflows/deploy-production.yml`, manual, and gated on a GitHub
Environment with a required reviewer — because whoever can deploy can ship code
that decrypts every tenant's provider key.

Both do the same five things in the same order:

1. the unit project (exports parity, migration filenames, no secret in
   `wrangler.jsonc`) and gitleaks;
2. migrations against the target branch, as `owner`, from
   `MIGRATIONS_DATABASE_URL`;
3. the client build;
4. `wrangler deploy --env <env>`;
5. `GET /health` until it answers 200.

**Migrations run before the deploy, and that is safe because of expand/contract:**
a migration adds the new thing, the deploy starts using it, and the old thing is
removed in a *later* migration once no reader wants it. The window between step 2
and step 4 is therefore a window in which the old code runs against the new
schema, which is a state the schema was written to support. It is also why a code
rollback never needs a reverse migration.

**There is no gradual deployment.** Durable Object classes are declared in
`exports`, and Cloudflare documents that gradual deployments are not supported
with `exports`. A deploy stops in-flight object requests and terminates every
WebSocket; the hubs hold no truth, so that costs one reconnect per client.

### Before deploying a change to a Workflow step name

Step names are checkpoint keys. A running instance that resumes into a build
where a step has been renamed cannot find its checkpoint.

1. Bump `ENGINE_VERSION` in `wrangler.jsonc` for the target environment.
2. Deploy.
3. The minute Cron's sweep marks runs whose `engine_version` is behind as
   `error {retryable: true}`, which puts a Retry button in front of the person
   whose turn was interrupted rather than leaving them watching a dead stream.

A change that only *adds* a step at the end needs no bump. A change that renames,
removes or reorders one does.

---

## 2. Rollback

```sh
# What is deployed, and what was before it.
pnpm --filter @hermes/worker exec wrangler deployments list --env production

# Go back one.
pnpm --filter @hermes/worker exec wrangler rollback <version-id> --env production
```

Then confirm:

```sh
curl -sS https://<production host>/health | jq '.status, .version'
```

**A rollback never reverses a migration.** Expand/contract is what makes that
true: the schema the old code ran against is a subset of the schema now, so the
old code still works. If you find yourself wanting a reverse migration, the
migration that landed was not expand/contract and the fix is a new forward
migration, not a backwards one.

**A rollback never reverses a Durable Object lifecycle change.** Removing a class
name from `exports` deletes its namespace and all of its stored data
permanently. A rename is a `renamed` tombstone in that map, never an edit to the
class name.

### If a rollback is not enough: `ENGINE_PAUSED`

```sh
# Refuse to create new Workflow instances. Existing runs finish.
pnpm --filter @hermes/worker exec wrangler deploy --env production --var ENGINE_PAUSED:1
```

`POST /turns` then answers 409 `engine_paused` with copy that says the engine is
paused for a deploy. Everything else — the Inbox, decisions, the Library,
History — keeps working, which is the point: a broken run engine should not take
the approval queue down with it.

Unset it by deploying with `ENGINE_PAUSED:0`. Confirm with a turn.

### And the `ENGINE_VERSION` procedure

If the bad deploy renamed a step and instances are stuck:

1. `ENGINE_PAUSED=1` — stop the bleeding.
2. Roll back the code.
3. Bump `ENGINE_VERSION` anyway. The instances created by the bad build have
   checkpoints the rolled-back build cannot use either; bumping tells the sweep
   to fail them fast rather than letting them time out one at a time over the
   next thirty minutes.
4. `ENGINE_PAUSED=0`.
5. Watch `cron.orphans` in the logs: `{"at":"cron.orphans","swept":N}`.

---

## 3. Numbers

### Stop latency

**Budget: 1,000 ms** (`STOP_LATENCY_BUDGET_MS`, `src/engine/constants.ts`).

**Measured in the M0 spike: _[record the spike's number here]_ ms.**

> This placeholder is deliberate and is not a to-do that can be quietly dropped.
> The plan's M0 exit criterion is "honours Stop within 1 s (number recorded)",
> and the number belongs in this file because this is where someone looks when
> a customer says Stop felt slow. Until the spike has been run against a real
> provider with `HERMES_SPIKE_KEY` set, the honest entry is that we have the
> budget and the engine test that asserts against it, and not a production
> figure. `pnpm --filter @hermes/worker spike` produces it.

In production the figure comes from the `stop.latency` series in Analytics
Engine (`src/ops/analytics.ts`), which records the interval between the
`stop_requested` row being written and the engine acting on it, tagged with
where it was honoured (`delta`, `tool` or `step`).

If Stop is slow, the order to check:

1. Is the flag being written? `runs.stop_requested` should be true immediately.
2. Is the hub RPC arriving? The reply to a delta forward carries Stop, so a
   failing forward delays Stop by one batch interval (500 ms).
3. Is the run inside a long provider step? A 30-minute provider step honours
   Stop at the next delta, which for a model that is thinking and not yet
   streaming can be a while. `terminate()` is the backstop.

### Timeouts

| Thing | Value | Where |
|---|---|---|
| Provider step | 30 minutes, 3 retries, 10 s delay | `PROVIDER_STEP_TIMEOUT` |
| Tool step | 2 minutes, 3 retries, 5 s delay | `TOOL_STEP_TIMEOUT` |
| One tool execution | 30 s | `TOOL_EXECUTION_TIMEOUT_MS` |
| Waiting for a human answer | 30 days | `CONTEXT_WAIT_TIMEOUT` |
| Long-wait Workflow step | 10 minutes, 5 retries, 60 s delay | `LONG_STEP_CONFIG` |
| Worker CPU | 30 s | `wrangler.jsonc` `limits.cpu_ms` |
| Cron handler CPU | 30 s at sub-hour intervals | platform |
| Delta batching | 500 ms | `DELTA_BATCH_MS` |
| Subrequest budget | 10,000 per instance, alarm at 50 percent | `SUBREQUEST_BUDGET` |
| Run turns | 12 | `DEFAULT_MAX_TURNS` |
| Presigned PUT | 15 minutes | `src/storage/r2.ts` |
| Hub authorisation | 10 minutes, ticket every 4 | `src/auth/tickets.ts` |
| Job claim | 120 s | `CLAIM_SECONDS` |
| Workspace deletion grace | 7 days | `DELETION_SLEEP` |

---

## 4. KEK rotation

Rotating the master secret re-wraps every live key's DEK under a new version. It
never decrypts a provider key: the operation that sounds the most dangerous
handles the least.

**It is two deploys, and the order is the whole point** (decision 22).

```sh
# 1. Add the new secret. Nothing uses it yet.
pnpm --filter @hermes/worker exec wrangler secret put KEK_V2 --env production

# 2. Deploy. Every instance can now *read* v2; none writes it, because
#    KEK_CURRENT is still unset or 1.
pnpm --filter @hermes/worker exec wrangler deploy --env production

# 3. Re-wrap. One step per workspace, resumable at the workspace it failed on.
pnpm --filter @hermes/worker exec wrangler workflows trigger hermes-kek-rotation-production \
  --params '{"toVersion":2}'

# 4. Watch it.
pnpm --filter @hermes/worker exec wrangler workflows instances list hermes-kek-rotation-production
#    Look for {"at":"kek_rotation.workflow","toVersion":2,"failed":0} in the logs.

# 5. Only once `failed` is 0: make v2 the version new material is written under.
pnpm --filter @hermes/worker exec wrangler deploy --env production --var KEK_CURRENT:2
```

**Between steps 2 and 5 an instance holding the new secret but not the new
setting still writes v1, which every instance can read.** That is the property
that makes the rotation safe during a rolling deploy, and it is why the setting
is separate from the secret.

**Do not delete `KEK_V1`.** Not the next day, not the next week. Every backup
and every point-in-time window that could hold DEKs wrapped under v1 has to
expire first — 30 days for the nightly dump, 7 for Neon's history — and until
then deleting it makes a restore from that period unreadable. Diary it for
day 31.

Verify afterwards:

```sh
HERMES_KEK_VERSIONS=1,2 pnpm restore:check
# kek: 0 KEK versions in the restored data are not held by this environment
```

---

## 5. KEK or key-store compromise

The drill, and the real procedure. Plan section 5: re-wrapping does not help
once plaintext was reachable, so the customer has to rotate at the provider.
Everything below is in service of telling them that quickly and truthfully.

**Run the whole sequence. Do not stop when it looks contained.**

### 1. Stop the engine

```sh
pnpm --filter @hermes/worker exec wrangler deploy --env production --var ENGINE_PAUSED:1
```

New runs are refused; no new decryption happens. In-flight runs finish, which is
deliberate: killing them mid-step would not un-leak anything and would lose
work.

### 2. Revoke every key

```sql
-- As owner, per workspace (the workspace list is `workspace_directory`).
-- There is no cross-tenant UPDATE and deliberately so: every role is
-- NOBYPASSRLS, so this runs once per workspace inside its own transaction.
UPDATE workspace_provider_keys
   SET status = 'revoked', revoked_at = now(), updated_at = now()
 WHERE workspace_id = $1 AND revoked_at IS NULL;
```

Every turn then refuses at creation with `no_key`, naming the provider, which is
the copy the customer needs to see.

### 3. Rotate the KEK

Section 4, steps 1 to 5, to a fresh version. This does not recover anything; it
ensures the compromised secret unwraps nothing written from now on.

### 4. Write the audit rows

One per workspace, so it is in each customer's own History and not only in our
incident document:

```sql
INSERT INTO events (workspace_id, actor_type, kind, key_id)
SELECT $1, 'system', 'provider_key.revoked', id
  FROM workspace_provider_keys WHERE workspace_id = $1;
```

### 5. Tell every Admin, in these words

> Your provider key may have been exposed. We have revoked it in Hermes and
> rotated our own encryption keys, but **re-wrapping does not help once the
> plaintext was reachable**. You must rotate the key at your provider —
> Anthropic, OpenAI or DeepSeek — and add the new one in Settings. Until you do,
> your agent will not run.

Banner in the product *and* an email to every workspace Admin. The banner alone
reaches only people who sign in, which during an incident is the people already
watching.

### 6. Afterwards

- `ENGINE_PAUSED=0` once the first workspace has added a fresh key.
- Check the `provider.latency` series for calls after the compromise window:
  a spike from an unfamiliar region is evidence the key was used.
- The tabletop version of this drill is an M5a exit item. Run it with the whole
  team, out loud, with someone timing it.

---

## 6. Cookie password rotation

**Rotating `WORKOS_COOKIE_PASSWORD` signs everybody out.** Every sealed session
is encrypted with it; a new one cannot decrypt an old cookie, and the symptom is
every user in every workspace bounced to sign-in at the same moment.

So: **off-hours, announced, and never at the same time as anything else.**

```sh
# 1. Announce. A day's notice, naming the window.
# 2. In the window:
pnpm --filter @hermes/worker exec wrangler secret put WORKOS_COOKIE_PASSWORD --env production
#    32 characters minimum. `openssl rand -base64 32 | head -c 32`.
pnpm --filter @hermes/worker exec wrangler deploy --env production
# 3. Verify a fresh sign-in works, end to end, before you go to bed.
```

Do it when: it leaked, someone with access to it left, or annually.

Note that `HUB_TICKET_SECRET` falls back to `WORKOS_COOKIE_PASSWORD` when it is
unset, so rotating the cookie password also invalidates every outstanding hub
ticket. That costs one reconnect, which clients handle, but set
`HUB_TICKET_SECRET` explicitly in production so the two can be rotated apart.

---

## 7. Restore drill

The procedure is `scripts/restore-drill.md`, end to end, in about 90 minutes.
The short version:

```sh
aws s3 cp "s3://$BUCKET/pg/hermes-YYYY/MM/DD/HHMM.dump" ./drill.dump --endpoint-url "$ENDPOINT"
pg_restore --dbname "$THROWAWAY" --no-owner --clean --if-exists --exit-on-error ./drill.dump
pnpm db:migrate                       # proves the schema matches
HERMES_KEK_VERSIONS=1 pnpm restore:check
```

Four checks: documents against R2, memberships against WorkOS, the live-KEK
check, and the orphan instance list. Each one is silent in a different way if
skipped; `scripts/restore-drill.md` says how.

Schedule: M1, M4, then quarterly. Write down the wall-clock time each time. A
drill whose duration nobody records cannot be shown to be getting faster.

---

## 8. Orphan sweep

The minute Cron (`src/runs/sweep.ts`) compares `runs.status IN ('working',
'waiting')` with the Workflow instance's status and marks a run as
`error {retryable: true}` when:

- it has had no event for 10 minutes (`ORPHAN_NO_EVENT_MINUTES`); or
- `instance.status()` says the instance is dead, or `get()` throws because it
  was purged (instances are retained 30 days); or
- its `engine_version` is behind the deployed one.

`stop_requested` is read first, so a run the person already stopped is recorded
as stopped rather than as an error.

The nightly Cron also sweeps orphaned R2 objects: anything under a workspace's
uploads prefix with no completed `attachments` row after 24 hours
(`src/storage/lifecycle.ts`), and the instance-cap buckets older than two days.

**What it looks like when it is working:**

```
{"at":"cron.orphans","swept":0,"checked":3}
{"at":"cron.uploads","deleted":0}
{"at":"cron.counters","swept":24}
```

**When to worry:** `swept` consistently above zero means runs are dying, not
that the sweep is broken. Look at the `run.duration` series and at Sentry before
you look at the sweep.

**What it deliberately does not do:** terminate instances. An instance with no
run row is handled by the restore procedure, by a human, because terminating is
irreversible and the sweep runs every minute unattended.

---

## 9. Workspace deletion

`DELETE /w/:ws` (Admin, step-up) revokes access immediately and schedules the
destruction for seven days later.

**Immediately:** every share revoked, every session read-only, `stop_requested`
on every working run, an `evict` job per member so their sockets close now
rather than when their ten-minute ticket lapses, and the workspace marked.

**After seven days,** inside `WorkspaceDeletion`: the WorkOS organization, then
the rows (`hermes_delete_workspace`, which cascades), then the R2 prefix.

To cancel, inside the window:

```sh
curl -X POST "https://<host>/w/$WS/settings/undelete" ...   # Admin, step-up
```

That clears the mark and terminates the instance. The Workflow also re-reads the
row after its sleep and stops on its own if the terminate call was lost, which
is the belt to that brace.

To check what is pending:

```sh
pnpm --filter @hermes/worker exec wrangler workflows instances list hermes-workspace-deletion-production
```

Sessions stay read-only after an undelete. Putting them back is deliberate work,
because resuming runs that have been stopped for days against a world that moved
on is rarely what anyone wants.

---

## 10. Alerts and thresholds

| Alert | Threshold | Source | What it means | First move |
|---|---|---|---|---|
| Database connections | > 150 of 209 | `/health`, check `postgres:connections` | Two Hyperdrive configs of ~100 each against a 0.5 CU origin. Above 150 the next thing is refusals that look like the database being down. | Check `idle in transaction`: a tenant transaction that opened and never committed pins a connection. Then scale the Neon compute. |
| `/health` degraded | any 503 | uptime monitor | The body names the failing check | Read the body before anything else |
| Nightly validator | `ok = false` | `validator_runs`, and an `events` row per workspace | Either the run log is a sequence the state machine cannot produce, or **a decision has no human behind it** | The second is an incident: stop, read §5 of `docs/CONVENTIONS.md`, and check the grant matrix |
| Human-only decisions | `forged_decisions > 0` | same | A `decisions.decided_by` that is not a member, or an agent-authored decision event | `pnpm db:test` immediately: the grant assertion is the layer that should have prevented it |
| Tool error rate | > 20 percent over an hour | `tool.result` series | Usually one tool, usually `fetch_url` against a host that changed | Check the allowlist and the classifier logs |
| Provider p95 | > 60 s | `provider.latency` series | The provider is slow, or a model's effort setting is higher than anyone intended | Check the provider's status page before changing anything |
| Stop latency | p95 > 1,000 ms | `stop.latency` series | The budget in `engine/constants.ts` | §3 above |
| Subrequests per instance | > 5,000 (50 percent) | `instance.subrequests` series | A chatty run; the delta batching interval may be too short | Do not raise the budget first |
| Socket reconnects | a spike that does not subside | `socket.reconnect` series | A deploy terminates every socket, so a spike is normal; one that does not subside is clients that cannot get back in | Check `/auth/session` and the ticket path |
| Platform instance cap | any `ops.instance_cap` log line | Workers Logs | We refused a customer's turn for our own capacity | Raise `PLATFORM_MAX_INSTANCES_PER_HOUR` after checking it is not a loop of ours |
| Daily spend | > $50/month trend | `spend.daily` series, plus the Cloudflare billing notification | | Per-workspace breakdown is `GET /w/:ws/usage` |
| Nightly backup | job failed, or object < 4 KB | `.github/workflows/backup-nightly.yml` | An implausibly small dump usually means the role sees nothing | Re-run manually; if it fails again, §7 |
| DLQ depth | > 0 | Queues dashboard | An extraction or render exhausted its retries | The DLQ consumer writes the reason onto the row; read that first |

---

## 11. WorkOS dashboard settings

Set once per environment (staging and production are separate WorkOS
environments). Nothing in this repository can assert these, which is why they
are written down.

| Setting | Value | Why |
|---|---|---|
| Redirect URI | `https://<host>/auth/callback` | Must match exactly, including the scheme |
| JIT provisioning | **off** | An unexpected user provisioned into an organization is an unexpected member |
| Public sign-up | **off** | Joining is by invitation only |
| Email verification | **on** | The create-workspace recipe requires a verified email |
| MFA | **on**, environment-wide TOTP for non-SSO users | Plan decision 5A. Per-organization is the alternative; environment-wide is the recommendation |
| Bot detection | **on** | WorkOS owns it; we do not implement one |
| Roles | `admin`, `member` — exactly these two slugs | The `members` mirror maps them one to one; a third role would be silently treated as `member` |
| Invitation expiry | 7 days | Matches `invitations` |
| Custom email provider | Cloudflare | Plan decision 5. Removes the SPF/DKIM chore for auth email; digests and effect-assignment mail still need a verified sending domain |
| Session token TTL | 5 to 10 minutes | The client refreshes every 4 minutes via `GET /auth/session` |
| Custom AuthKit domain | **deferred** ($99/month) | The pilot signs in on the WorkOS-hosted host |

After changing any of them, sign in end to end. The failure mode of a wrong
redirect URI is a redirect loop that looks like a bug in our callback.

---

## 12. Secrets, per environment

`wrangler secret put <NAME> --env <staging|production>`, one at a time. None of
them has a default and none of them is in `wrangler.jsonc` (a unit test asserts
that).

```sh
E=production   # or staging

# Identity
pnpm --filter @hermes/worker exec wrangler secret put WORKOS_API_KEY --env $E
pnpm --filter @hermes/worker exec wrangler secret put WORKOS_CLIENT_ID --env $E
pnpm --filter @hermes/worker exec wrangler secret put WORKOS_COOKIE_PASSWORD --env $E   # >= 32 chars
pnpm --filter @hermes/worker exec wrangler secret put WORKOS_ISSUER --env $E            # exact OIDC discovery issuer
pnpm --filter @hermes/worker exec wrangler secret put HUB_TICKET_SECRET --env $E        # set explicitly; see §6

# Nous inference OAuth. The client id is public OAuth metadata, but is kept as
# an environment binding because Nous provisions it per deployment. Hosted
# sign-in stays on the manual-key fallback until it is present.
pnpm --filter @hermes/worker exec wrangler secret put NOUS_PORTAL_OAUTH_CLIENT_ID --env $E

# Envelope encryption. KEK_CURRENT is a var, not a secret (see §4).
pnpm --filter @hermes/worker exec wrangler secret put KEK_V1 --env $E

# Presigned uploads
pnpm --filter @hermes/worker exec wrangler secret put R2_ACCOUNT_ID --env $E
pnpm --filter @hermes/worker exec wrangler secret put R2_ACCESS_KEY_ID --env $E
pnpm --filter @hermes/worker exec wrangler secret put R2_SECRET_ACCESS_KEY --env $E

# Observability. Optional: with no DSN the SDK is disabled and the code path is
# identical.
pnpm --filter @hermes/worker exec wrangler secret put SENTRY_DSN --env $E
```

Confirm: `wrangler secret list --env $E`.

`WORKOS_REDIRECT_URI` is an ordinary variable pinned to each deployed host in
`wrangler.jsonc`. `/health` refuses staging or production if it is missing,
off-origin, or not exactly `/auth/callback`. The full dashboard and live test
sequence is `docs/WORKOS-PRODUCTION-CHECKLIST.md`.

### GitHub secrets and variables

| Name | Kind | Environment | Used by |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | staging, production | the deploy. **Scoped to this Worker**, not an account token |
| `CLOUDFLARE_ACCOUNT_ID` | secret | staging, production | the deploy |
| `MIGRATIONS_DATABASE_URL` | secret | staging, production | `scripts/migrate.mjs`, as `owner` on the target branch |
| `BACKUP_DATABASE_URL` | secret | production | `pg_dump`. **Read-only role** |
| `BACKUP_R2_ACCOUNT_ID` | secret | production | the backup upload |
| `BACKUP_R2_ACCESS_KEY_ID` | secret | production | **write-only on the backups bucket** |
| `BACKUP_R2_SECRET_ACCESS_KEY` | secret | production | as above |
| `STAGING_URL` | variable | staging | the smoke test |
| `PRODUCTION_URL` | variable | production | the smoke test |
| `BACKUP_R2_BUCKET` | variable | production | the backup upload |

---

## 13. First deploy checklist

For Brian, in order. Nothing later works if something earlier is missing, and
three of these are unchangeable once created — they are marked **permanent**.

### Cloudflare

- [ ] A Workers **Paid** plan on the account ($5/month). Workflows, Queues and a
      30-second CPU limit all need it.
- [ ] Account-level **MFA on**, and every human on the account holding the
      minimum role. The deploy pipeline is inside the BYOK trust boundary.
- [ ] **R2 buckets**, four, and their jurisdiction is **permanent** — set at
      creation and unchangeable. Decide EU or default *before* this step (plan
      decision 4):
      `hermes-uploads-staging`, `hermes-uploads-backup-staging`,
      `hermes-uploads-production`, `hermes-uploads-backup-production`.
- [ ] A **30-day lifecycle rule** on both backup buckets, and on the production
      backup bucket only after you have checked it is the backup bucket.
- [ ] A fifth bucket for the `pg_dump` objects if you want them separate from
      the uploads copy: `hermes-backups-production`.
- [ ] **R2 API tokens**: one read-write scoped to the uploads buckets (the
      Worker's presigned URLs), one **write-only** scoped to the backups bucket
      (the nightly job). Not one token for both.
- [ ] **Queues**, eight: `hermes-extract-{staging,production}`,
      `hermes-renders-{staging,production}`, and a `-dlq` for each. Every one of
      the four working queues must have its DLQ configured, or an exhausted
      message is deleted and the row it was about says "preparing" forever.
- [ ] **Hyperdrive configs**, four — one per role per environment — each
      pointing at Neon's **direct** connection string (not the pooler: Neon's
      pooler does not support `SET`), with **caching disabled**. Put their real
      ids into `wrangler.jsonc` in place of the placeholder ids.
- [ ] **Workflows**: nothing to create. `wrangler deploy` registers all four
      (`hermes-run-attempt`, `hermes-workspace-deletion`, `hermes-kek-rotation`,
      `hermes-nightly-validator`) per environment.
- [ ] **Analytics Engine** datasets `hermes_metrics_staging` and
      `hermes_metrics_production`. Optional: the code is a no-op without the
      binding, but then §10's thresholds have no series behind them.
- [ ] A **Cloudflare billing notification** at $50/month.

### Neon

- [ ] A Neon project. Its **region is permanent** — match the R2 jurisdiction
      decision above.
- [ ] Two branches (or two projects): `staging` and `production`.
- [ ] **Scale-to-zero OFF** on both. A cold start on the first request of the
      morning looks exactly like the database being down, and Hyperdrive's
      connection pool will have opened connections to a compute that is asleep.
- [ ] A **compute-size alert**, and note the connection ceiling for the size you
      chose: 209 on 0.5 CU. §10's connection threshold assumes it.
- [ ] Four roles per branch: `owner`, `app`, `agent` (created by
      `scripts/roles.mjs`) and a **read-only** role for the backup job.
- [ ] Run `pnpm db:migrate` against each branch as `owner`, once, by hand,
      before the first deploy.

### WorkOS

- [ ] Two environments, staging and production. They are separate; every
      setting in §11 is set twice.
- [ ] Every setting in §11, in both.
- [ ] The **custom email provider** (Cloudflare) configured, and one test email
      received.
- [ ] Note the client id and API key for each; they go in as secrets below.

### Secrets

- [ ] Every secret in §12, in both Cloudflare environments.
- [ ] Every GitHub secret and variable in §12's second table, in the
      corresponding **GitHub Environment** (not repository-wide: an environment
      secret is not readable from a pull request).
- [ ] The `production` GitHub Environment has a **required reviewer**. This is
      the control that makes production deploys a two-person operation, and
      nothing in the repository can enforce it.

### DNS

- [ ] `app.<domain>` and `staging.<domain>` as Workers custom domains, on the
      Cloudflare zone. One origin serves both the API and the client bundle,
      which is what lets the session cookie be `SameSite=Strict` — do not put
      the client on a separate host.
- [ ] Update `ALLOWED_ORIGINS` in `wrangler.jsonc` for both environments to the
      real hostnames. A wrong value here refuses every WebSocket upgrade and
      every guarded command, with `forbidden_origin`.
- [ ] Update the WorkOS redirect URIs to match, exactly.
- [ ] A verified **sending domain** for non-auth email (digests, effect
      assignment). Auth email goes through WorkOS and needs nothing.

### Then, in this order

1. [ ] `pnpm db:migrate` against staging as `owner`.
2. [ ] Push to `main`; watch `deploy-staging.yml` go green.
3. [ ] `curl https://staging.<domain>/health` — expect 200 and five checks,
       including `workos:jwks` and `postgres:connections`.
4. [ ] Sign in, create a workspace, add a provider key, run one turn end to end.
5. [ ] Trigger the backup workflow manually; confirm the object landed.
6. [ ] Run the restore drill (§7) against the staging dump. **Before**
       production holds real data, not after.
7. [ ] `pnpm db:migrate` against production.
8. [ ] Run `deploy-production.yml` manually; approve it as the reviewer;
       confirm `/health`.
9. [ ] Set the Cloudflare billing notification and the Neon compute alert.
10. [ ] Put §10's thresholds into whatever alerts on them, and check one fires.
11. [ ] Record the Stop latency number from the spike in §3.
