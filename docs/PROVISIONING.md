# Provisioning accounts, keys and settings for Hermes Enterprise

This is an operator procedure for whoever provisions the hosted environments (a browser plus a terminal on a machine with this repository checked out). It covers everything in RUNBOOK.md sections 11 to 13 that needs a dashboard or a credential, in the order the dependencies require. Read RUNBOOK.md and README.md first; this file tells you *how to click and type*, those tell you *why*.

Repository: `<local checkout of this repository>` (pnpm monorepo; the Worker lives in `apps/worker`).

## Ground rules

1. **Secrets never go into chat, screenshots, tracked files or commit messages.** Every secret has exactly two homes: the vendor dashboard where it was created, and `wrangler secret put` (which prompts for the value on stdin). Optionally a 1Password item. `git status` must never show a file containing one; `.dev.vars`, `.env` and `*.local` are gitignored.
2. **Report ids and names, not values.** Bucket names, Hyperdrive ids, WorkOS client ids and account ids are fine to report. API keys, secrets, connection strings and cookie passwords are not.
3. **Stop and confirm with the project owner** before: paying for anything (Workers Paid plan, Neon paid tier, WorkOS custom domain), accepting a vendor's terms for a new account, deleting anything, or when a page does not look like the step describes. Do not improvise around an unexpected screen.
4. **Prefer the terminal over clicking** where a CLI exists; every CLI step below is idempotent or says what to do on "already exists".
5. **Verify each phase** with the check at its end before moving on. Record results in the report template at the bottom.
6. Never run `wrangler deploy` to production; staging deploys go through the GitHub Actions pipeline once Phase G exists.

## Phase 0. Decisions the project owner must confirm before anything permanent is created

Confirm these with the project owner in one message before continuing:

| Decision | Why it is permanent | Default if the owner says "default" |
|---|---|---|
| Data residency: EU or default | R2 bucket jurisdiction and the Neon region cannot be changed after creation | default (US) |
| Hostnames | `ALLOWED_ORIGINS`, WorkOS redirect URIs and Workers custom domains all derive from them | `staging.<domain>` and `app.<domain>` on a zone already in the project's Cloudflare account |
| Which domain | must already be a zone in the Cloudflare account, or DNS moves first | ask |
| First provider for the spike | RUNBOOK §3 records the measured Stop latency from it | OpenRouter (the owner already holds a key) |

Prerequisites to confirm exist (do not create accounts without asking): the project's Cloudflare account (`npx wrangler whoami` in the repo confirms the login and prints the account id), a Neon account, a WorkOS account, a GitHub account with access to create a private repo, an OpenRouter account (the owner rotates the key; the operator never handles it).

## Phase A. Neon (database)

Neon comes before Cloudflare Hyperdrive because Hyperdrive needs the connection strings.

1. Sign in at https://console.neon.tech. Create project `hermes` in the region matching Phase 0 (EU → `eu-central-1` or the closest Neon EU region; default → `us-east-1`). Postgres 17.
2. Create two branches from `main`: `staging` and `production`. (Or two projects if the owner prefers full isolation; the runbook accepts either.)
3. For each branch's compute: **Settings → Compute → Autosuspend: off** (this is "scale-to-zero off"; it is only available on paid plans, so this may require the owner's OK to upgrade). Size 0.5 CU is enough; note the connection limit shown (209 at 0.5 CU).
4. For each branch, copy the **direct** connection string (not the pooled one; the toggle is labelled "Pooled connection" and must be off) for the `neondb_owner` role. Keep it in the terminal only.
5. Create the application roles and apply the migrations on each branch from the repo. The scripts read the connection strings from environment variables (`DATABASE_URL_SUPERUSER` for the Neon owner string; the scripts create `owner`, `app` and `agent` with passwords you pass as `DATABASE_URL_OWNER` / `DATABASE_URL_APP` / `DATABASE_URL_AGENT` strings using the same host). Nothing secret is printed:
   ```sh
   cd apps/worker
   export DATABASE_URL_SUPERUSER='<neon owner direct string, staging>'
   export DATABASE_URL_OWNER='postgres://owner:<new pw>@<neon host>/hermes?sslmode=require'
   export DATABASE_URL_APP='postgres://app:<new pw>@<neon host>/hermes?sslmode=require'
   export DATABASE_URL_AGENT='postgres://agent:<new pw>@<neon host>/hermes?sslmode=require'
   node scripts/roles.mjs && node scripts/migrate.mjs
   unset DATABASE_URL_SUPERUSER DATABASE_URL_OWNER DATABASE_URL_APP DATABASE_URL_AGENT
   ```
   Repeat for `production` with its own passwords. The `app` and `agent` strings are the ones Phase B.7 gives to Hyperdrive; the owner string is the GitHub `MIGRATIONS_DATABASE_URL`. Migrations must be applied by hand once before the first deploy.
6. Create a read-only role for backups on `production` (the roles script prints the SQL if it does not create it; otherwise in the Neon SQL editor: `CREATE ROLE backup LOGIN PASSWORD '...' ; GRANT pg_read_all_data TO backup;`).
7. Set a compute-size alert in Neon (Settings → Alerts) if the plan offers it.

Check: `psql '<owner string>' -c "select count(*) from schema_migrations"` returns the migration count (14 or more), and `\du` lists `app`, `agent`, `owner` (and `backup` on production).

Report: project name, region, branch names, role names. No strings.

## Phase B. Cloudflare

Sign in at https://dash.cloudflare.com with the project's Cloudflare login. Everything below is under that account.

1. **Workers Paid plan** (Workers & Pages → Plans). $5/month. Ask the owner before purchasing. Workflows, Queues and the 30 s CPU limit need it.
2. **Account security**: confirm 2FA is on for the account login (My Profile → Authentication). Do not change it yourself; report if it is off.
3. **R2 buckets** (R2 → Create bucket). Jurisdiction per Phase 0; it is set at creation and permanent. Names exactly:
   - `hermes-uploads-staging`
   - `hermes-uploads-backup-staging`
   - `hermes-uploads-production`
   - `hermes-uploads-backup-production`
   - `hermes-backups-production` (pg_dump objects)
   CLI equivalent from the repo: `npx wrangler r2 bucket create <name> [--jurisdiction eu]`.
4. **Lifecycle rules**: on both `*-backup-*` buckets and on `hermes-backups-production`, add a rule deleting objects after 30 days (bucket → Settings → Object lifecycle rules).
5. **R2 API tokens** (R2 → Manage R2 API Tokens → Create): 
   - `hermes-uploads-<env>`: permission **Object Read & Write**, scoped to the two `hermes-uploads-<env>` buckets only. Produces Access Key ID + Secret Access Key; these become `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` for that environment (Phase E). One per environment.
   - `hermes-backups-writer`: permission **Object Write only** (if the UI offers only Read & Write, choose that and note it in the report), scoped to `hermes-backups-production`. Becomes the GitHub `BACKUP_R2_*` secrets (Phase G).
   The account id shown on the R2 overview page is `R2_ACCOUNT_ID` and `BACKUP_R2_ACCOUNT_ID`.
6. **Queues** (eight). CLI from `apps/worker`:
   ```sh
   for q in hermes-extract-staging hermes-extract-staging-dlq hermes-renders-staging hermes-renders-staging-dlq \
            hermes-extract-production hermes-extract-production-dlq hermes-renders-production hermes-renders-production-dlq; do
     npx wrangler queues create "$q"
   done
   ```
   "already exists" is fine.
7. **Hyperdrive configs** (four). CLI, using the Neon **direct** strings from Phase A (they are consumed by the command and not stored in the repo):
   ```sh
   npx wrangler hyperdrive create hermes-app-staging        --connection-string='postgres://app:<pw>@<neon host>/hermes?sslmode=require'   --caching-disabled
   npx wrangler hyperdrive create hermes-agent-staging      --connection-string='postgres://agent:<pw>@<neon host>/hermes?sslmode=require' --caching-disabled
   npx wrangler hyperdrive create hermes-app-production     --connection-string='...' --caching-disabled
   npx wrangler hyperdrive create hermes-agent-production   --connection-string='...' --caching-disabled
   ```
   Each prints an id. Put the four ids into `apps/worker/wrangler.jsonc` in the `staging` and `production` `hyperdrive` blocks (replace the `0000…app0` / `…agent00` placeholders). If the CLI flag for disabling caching is named differently in the installed wrangler, use the dashboard (Workers & Pages → Hyperdrive → config → Settings → Caching: disabled) and confirm in the report.
8. **Analytics Engine** datasets `hermes_metrics_staging` and `hermes_metrics_production` (Workers & Pages → Analytics Engine). Optional; the Worker is a no-op without the binding.
9. **Workers custom domains**: after the first staging deploy (Phase H), add `staging.<domain>` to the staging Worker and `app.<domain>` to the production Worker (Worker → Settings → Domains & Routes → Add → Custom domain). The zone must be in this account.
10. **Billing notification** at $50/month (Billing → Notifications).
11. **CI API token** (My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template, then restrict to this account and, if the UI allows, to the `hermes-enterprise` Worker). This becomes the GitHub `CLOUDFLARE_API_TOKEN`. Do not reuse the OAuth login.

Check: `npx wrangler r2 bucket list`, `npx wrangler queues list`, `npx wrangler hyperdrive list` show every name above; `npx wrangler deploy --dry-run --env staging` parses with the real Hyperdrive ids.

Report: bucket names + jurisdiction, queue names, Hyperdrive ids, dataset names, which tokens were created and their scopes.

## Phase C. WorkOS

Sign in at https://dashboard.workos.com. Staging and Production are separate environments (top-left switcher); every step is done twice.

1. **Redirect URIs** (Authentication → Redirects): add exactly `https://staging.<domain>/auth/callback` in Staging and `https://app.<domain>/auth/callback` in Production. No trailing slash. Set the default/logout redirect to the hostname root.
2. **Roles** (Organizations → Roles): exactly two slugs, `admin` and `member`; `member` as the default. Delete or rename any others.
3. **Authentication settings** (Authentication tab): Email + password or Magic Auth on (Magic Auth recommended), **Email verification on**, **Public sign-up off**, **JIT provisioning off** (found under Organizations or Authentication depending on the current dashboard), **Bot detection on**.
4. **MFA** (Authentication → Multi-factor): on, environment-wide TOTP for non-SSO users (RUNBOOK §11; plan decision 5A).
5. **Sessions**: access token TTL 5 to 10 minutes (Authentication → Sessions).
6. **Invitations**: 7-day expiry (Organizations → Invitations settings) if configurable.
7. **Custom email provider**: Authentication → Email → provider Cloudflare (requires a Cloudflare email sending setup; if none exists, leave WorkOS default sending and note it).
8. Copy the **Client ID** (safe to report) and create an **API key** (secret; goes only into `wrangler secret put WORKOS_API_KEY` in Phase E). Do this per environment.

Check: the Staging environment's Overview shows the redirect URI, two roles and MFA on. Sign-in is verified end to end in Phase H.

Report: both Client IDs, the list of settings and their values. No API keys.

## Phase D. Values the operator generates locally

Run in a terminal; the values are consumed by Phase E and never written to a tracked file:

```sh
openssl rand -base64 32          # KEK_V1 (one per environment)
openssl rand -hex 32             # WORKOS_COOKIE_PASSWORD (>= 32 chars; one per environment)
openssl rand -hex 32             # HUB_TICKET_SECRET (one per environment)
```

If the owner wants them in 1Password, create items named `Hermes staging secrets` and `Hermes production secrets` and paste them there through the 1Password app, not through chat.

## Phase E. Worker secrets

From the repo root, once per environment (`E=staging`, then `E=production`). Each command prompts for the value; paste it and press Enter.

```sh
E=staging
pnpm --filter @hermes/worker exec wrangler secret put WORKOS_API_KEY --env $E
pnpm --filter @hermes/worker exec wrangler secret put WORKOS_CLIENT_ID --env $E
pnpm --filter @hermes/worker exec wrangler secret put WORKOS_COOKIE_PASSWORD --env $E
pnpm --filter @hermes/worker exec wrangler secret put WORKOS_ISSUER --env $E
pnpm --filter @hermes/worker exec wrangler secret put HUB_TICKET_SECRET --env $E
pnpm --filter @hermes/worker exec wrangler secret put KEK_V1 --env $E
pnpm --filter @hermes/worker exec wrangler secret put R2_ACCOUNT_ID --env $E
pnpm --filter @hermes/worker exec wrangler secret put R2_ACCESS_KEY_ID --env $E
pnpm --filter @hermes/worker exec wrangler secret put R2_SECRET_ACCESS_KEY --env $E
pnpm --filter @hermes/worker exec wrangler secret put SENTRY_DSN --env $E     # only if a Sentry project exists; otherwise skip
```

Then edit `apps/worker/wrangler.jsonc`: in each environment block set `KEK_CURRENT` to `"1"` (it is a var, not a secret) and `ALLOWED_ORIGINS` to the real hostname (`https://staging.<domain>` / `https://app.<domain>`), confirm the bucket names and Hyperdrive ids from Phase B, and commit that file only (`git add apps/worker/wrangler.jsonc && git commit -m "infra: real Hyperdrive ids, origins and KEK_CURRENT"`).

Check: `pnpm --filter @hermes/worker exec wrangler secret list --env staging` lists the names above (values are never shown). `git diff --cached` shows no secret values before committing.

## Phase F. Local proof before any deploy

```sh
pnpm install && pnpm db:up && pnpm db:migrate && pnpm typecheck && pnpm test && pnpm db:test
pnpm e2e:live
```

All must be green (as of this writing: 680 + 317 + 56 + 39 unit/db tests, 34+ live scenarios). If something fails here, stop and report; do not proceed to deploy.

## Phase G. GitHub

1. Create a **private** repository `hermes-enterprise` under the project's GitHub account (confirm which account). Add the remote and push `main`:
   ```sh
   git remote add origin git@github.com:<account>/hermes-enterprise.git
   git push -u origin main
   ```
2. Settings → Environments: create `staging` and `production`. On `production`, add the project owner as a **required reviewer**.
3. Per environment, add secrets and variables exactly as RUNBOOK §12's second table: `CLOUDFLARE_API_TOKEN` (Phase B.11), `CLOUDFLARE_ACCOUNT_ID`, `MIGRATIONS_DATABASE_URL` (the Neon **owner** direct string for that branch), and on production only `BACKUP_DATABASE_URL` (the read-only role), `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`; variables `STAGING_URL`, `PRODUCTION_URL`, `BACKUP_R2_BUCKET` (`hermes-backups-production`).
4. Confirm the Actions tab shows `ci.yml` green on the pushed commit.

## Phase H. First deploy and first real run (staging only)

1. `deploy-staging.yml` runs on the push to `main`. Watch it: migrations (already applied by hand, so it should report nothing to do), client build, `wrangler deploy --env staging`, smoke test.
2. Add the custom domain `staging.<domain>` to the staging Worker (Phase B.9) and confirm `curl https://staging.<domain>/health` returns `"status":"ok"` with checks `postgres:app`, `postgres:agent`, `hub:workspace`, `postgres:connections` and `workos:jwks` all true.
3. In a browser: open `https://staging.<domain>/`, sign in through WorkOS (the workspace Admin's email; a WorkOS invitation or the create-workspace flow), create the first workspace.
4. **Provider key**: Settings → Provider keys → Add → the Admin pastes the rotated OpenRouter key (the operator does not handle it; OpenRouter is the only provider the routes accept, so there is no provider to choose — decision R12) → **Add and verify** (requires an Admin session signed in within the last five minutes) → the row reads `Verified · N models synced` → **Sync models** refreshes the list. The workspace default becomes `openrouter:anthropic/claude-sonnet-5` at that moment if it was not already usable (decision R13), so the first message needs no model pick; the chat's model menu lists every OpenRouter model, and a row without tool calling is greyed with the reason.
5. Send one turn to Iris ("Screen this application: …" with any pasted text). Expect live steps, streamed text, a proposed request in the Inbox with badge 1. Admit it in the Inbox; expect the receipt in the session and a History row.
6. Record the Stop latency: with `HERMES_SPIKE_KEY` set to a key the owner provides in the terminal session only, run `pnpm --filter @hermes/worker spike` and paste the printed number into RUNBOOK §3.
7. Trigger `backup-nightly.yml` manually (Actions → Run workflow) and confirm an object landed in `hermes-backups-production` (or the staging bucket if the workflow targets staging first).
8. Run the restore drill (RUNBOOK §7) against the staging dump.

Production follows the same steps only after the project owner approves the `deploy-production.yml` run as the required reviewer.

## Report template (send to the project owner when done or blocked)

```
Phase 0 decisions: residency=…, hostnames=…, provider=…
Neon: project=…, region=…, branches=…, autosuspend=off/on, roles=…
Cloudflare: plan=…, buckets=[… (jurisdiction)], lifecycle=…, queues=8/8, hyperdrive ids: app-staging=…, agent-staging=…, app-production=…, agent-production=…, datasets=…, tokens created: [name → scope]
WorkOS: staging client id=…, production client id=…, settings: redirect=…, roles=admin/member, MFA=…, JIT=off, signup=off, email verification=on, TTL=…
Secrets set (names only): staging=[…], production=[…]
wrangler.jsonc committed: yes/no (commit …)
Local proof: typecheck/test/db:test/e2e:live = …
GitHub: repo=…, environments=…, required reviewer=…, ci=green/red
Staging: deploy run=…, /health=…, sign-in=…, workspace=…, provider key verified=yes/no, models synced=N, first run=…, admit+receipt=…
Blocked on: …
```
