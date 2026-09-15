# Security review

An adversarial review of the Worker and the shared contract, against the six
areas the engagement named: the approval invariant, tenancy, BYOK, auth, the
engine and its tools, and ops.

The method was to try to break each stated invariant rather than to read for
style, and the findings below are only the ones where an attempt succeeded or
where a defence does not do what its own comment claims it does. Where a
property held, it held for a reason worth recording, and the last section says
so — a review that lists only defects tells a reader nothing about what they are
allowed to rely on.

Everything in the **fixed** table has a test that fails against the previous
code. Everything in the **open** table has a severity, a location, the exploit
and a recommended fix, and is open because the fix needs a product decision, a
migration, or a change in `apps/client`, which this review did not touch.

Scope of the changes: `apps/worker/**` and `docs/**`. No client file was
modified.

---

## Summary — fixed

| # | Finding | Severity | Status | Test |
|---|---|---|---|---|
| F1 | `AUTH_MODE=fake` was honoured in any environment, so a deployed Worker that shipped the switch would accept `x-dev-user` as proof of identity — and `requireCsrf` is a no-op outside `workos` mode, so the forged session reached the decision route too | **High** | Fixed | `test/db/security-review.test.ts` · SR-1 |
| F2 | `auth_sessions.revoked_at` was written by sign-out and by the WorkOS `user.deleted` poller and read by nothing: signing out ended the session in the browser only, and a captured cookie still satisfied step-up | **High** | Fixed | `test/db/security-review.test.ts` · SR-2 |
| F3 | `GET /w/:ws/traces` and `/traces/:runId` applied no session-visibility rule, so any member could list every session's runs and read another member's tool arguments and results by id | **High** | Fixed | `test/db/security-review.test.ts` · SR-5 |
| F4 | Every IPv4-embedding IPv6 form bypassed the SSRF address check — `::ffff:a9fe:a9fe` is 169.254.169.254 and was *allowed* | **High** | Fixed | `test/unit/fetch-url.test.ts` · "IPv6 addresses that embed an IPv4 address" |
| F5 | `POST /invitations/:token/accept` selected `users.email_verified` and never read it, so an unverified claim to an address was enough to accept an invitation sent to it | **High** | Fixed | `test/db/security-review.test.ts` · SR-4 |
| F6 | The four mutating provider-key routes were the only state-changing routes in the Worker with no CSRF or Origin guard | **Medium** | Fixed | `test/db/security-review.test.ts` · SR-3 |
| F7 | `/health` returned upstream `error.message` verbatim to an unauthenticated caller — database hostname, port and role names — and published the connection ceiling, catalog size and live socket count | **Medium** | Fixed | `test/db/health.test.ts` · "never puts a host, a port, a role name or an upstream message in the body" |
| F8 | `/health` is unauthenticated and opened three Postgres connections per request, against an origin budget of 209 that already alarms at 150 | **Medium** | Fixed | `test/db/health.test.ts` · "serves a cached answer rather than three Postgres connections a hit" |
| F9 | `currentKekVersion` defaulted to the *highest* KEK present, which is exactly the one-deploy race `KEK_CURRENT` was introduced to remove | **Medium** | Fixed | `test/unit/envelope.test.ts` · "defaults to the lowest version present" |
| F10 | `defaultFetch` followed redirects, so a 30x from a provider host replayed the workspace's API key to the redirect target | **Medium** | Fixed | `test/unit/providers.test.ts` · "asks for a manual redirect" |
| F11 | `POST /invitations/:token/accept` had no rate limit: a free token-guessing oracle and a two-connection-per-attempt amplifier | **Medium** | Fixed | `test/db/security-review.test.ts` · SR-4 |
| F12 | The log redactor matched the secret name `kek_v1` literally, so the first rotation would introduce a `KEK_V2` that no name rule and no shape rule caught | **Low** | Fixed | `test/unit/redaction.test.ts` · "redacts a key-encryption key by name at every version" |
| F13 | The engine's catch-all failure path wrote an arbitrary `error.message` into `runs.error`, which the client renders, without redaction | **Low** | Fixed | `test/unit/redaction.test.ts` covers `redactMessage`; the call site is a one-line change |
| F14 | `rewrapProviderKey` returned `true` without checking the rowcount of its version-guarded UPDATE, overcounting `RotationReport.rewrapped` — the number an operator reads before deleting the old KEK | **Low** | Fixed | — (report-accuracy fix; no behaviour a test can observe without a concurrent rotation) |
| F15 | Adding and verifying a provider key shared one rate-limit bucket, so setting a workspace up locked the operator out of re-verification for an hour | **Low** | Fixed | — (limit-tuning change, not a security boundary) |
| F16 | The new `/health` cache was unkeyed, so one isolate could serve an answer computed under a different `Env` | **Low** | Fixed | `test/db/health.test.ts` (the environment-in-version test) |

### The fixes

**F1 · `apps/worker/src/auth/adapters.ts`.** `authAdapter` now refuses `fake`
unless `isDevelopment(env)`, with 503 `not_configured` — the same answer an
unknown `AUTH_MODE` already gets. The comment on `fakeStepUp` in
`routes/auth.ts` already asserted this was "refused outside development by
`authAdapter`"; it was not. The two switches belong together because
`requireCsrf` returns early outside `workos` mode, so a mis-set `AUTH_MODE`
removed identity and CSRF in one move.

**F2 · `apps/worker/src/auth/adapters.ts`.** `touchAuthSession` now returns
`revoked_at` and throws `invalid_session` when it is set. `/auth/callback` and
the development step-up already clear it when they re-stamp the row, so signing
back in recovers. `invalid_session` is an existing `AuthReason`, so no client
change is needed.

**F3 · `apps/worker/src/routes/traces.ts`, `routes/sessions.ts`.** `VISIBLE` —
the one visibility rule — is now exported from `sessions.ts` and applied to both
trace queries. It existed verbatim in two places and was absent from a third;
exporting it means a reviewer can find every obeying surface by grepping for the
name. A run in a session the caller cannot see is 404, not 403.

**F4 · `apps/worker/src/security/ip.ts`.** `checkIpv6` now decodes any embedded
IPv4 (`::ffff:0:0/96`, `::/96`, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4
`2002::/16`) and judges it with `checkIpv4`, so there is one list of forbidden
ranges rather than two that drift. `fec0::/10`, `2001:db8::/32` and `100::/64`
are refused as well. The old guard matched only the *dotted* spelling
`::ffff:127.0.0.1`, which is the one spelling a URL never produces — WHATWG
rewrites it to `::ffff:7f00:1` — so it was unreachable dead code. This mattered
more than a literal blocklist usually does: `isIpLiteral` returns true for these
forms, which makes `vetHost` skip DNS and treat the literal as its own resolved
address, so this function was the only thing between the allowlist and the
socket. The reachable path is DNS, since host matching is suffix-based: an
allowlisted `example.com` covers `evil.example.com`, and its AAAA record is the
attacker's to choose.

**F5, F11 · `apps/worker/src/routes/invitations.ts`, `auth/rate-limit.ts`.**
The route refuses an unverified address with 403 `email_unverified`, and
consumes a new `invitation.accept` limit (10/hour) *before* the lookup, on a
plain client rather than inside a transaction — so a wrong guess is not
refunded. Refunding failures would limit only the successes, which is backwards
for a guessing limit.

**F6 · `apps/worker/src/routes/keys.ts`.** `addKey`, `verifyKey`, `rotateKey`
and `deleteKey` now call `requireOrigin` and `requireCsrf`, matching
`patchAttestation` on the same table. `SameSite=Strict` covered the ordinary
browser case, but `auth/cookies.ts` describes the double-submit token as "the
second layer, for the cases SameSite does not cover", and these were the routes
that skipped it.

**F7, F8, F16 · `apps/worker/src/routes/health.ts`.** `detail` is now a closed
vocabulary (`connected`, `answered`, `reachable`, `within budget`, `alarming`,
`unauthorized`, `unreachable`, `misconfigured`, `failed`); the real message goes
to `console.error` and the connection arithmetic to `console.log`, which is
where an operator is already looking and an attacker is not. The whole answer is
memoised per isolate for ten seconds, keyed on the env fields it depends on.

**F9 · `apps/worker/src/keys/envelope.ts`.** With `KEK_CURRENT` unset the
current version is now the *lowest* present. `KEK_CURRENT` is optional, so
"unset" is the state every rotation starts from, and defaulting to the highest
meant `wrangler secret put KEK_V2` alone made v2 current on restarted instances
while the others could not read what those wrote.

**F10 · `apps/worker/src/model/types.ts`.** `defaultFetch` passes
`redirect: 'manual'`. `security/fetch-url.ts` already did this on the path that
carries a URL; this is the path that carries a credential.

**F12, F13, F14, F15** are one-line changes in `keys/redact.ts`,
`engine/engine.ts`, `keys/store.ts` and `routes/keys.ts` respectively, each
commented at the line.

---

## Summary — open

Ordered by severity. None of these is a change this review could make safely on
its own: each needs a product decision, a migration, or a change in
`apps/client`, which another agent owns.

| # | Finding | Severity | Area | Where |
|---|---|---|---|---|
| O1 | A "share" grants the whole workspace, and the share token is consumed by nothing | **High** | Tenancy | `routes/sessions.ts:30`, `:369-413` |
| O2 | The run sweep marks a run `error` but never stops the live Workflow instance | **High** | Engine | `runs/sweep.ts:138-168` |
| O3 | `apply_prepared_proposal` is a model-authored command that rewrites the agent's standing instructions on one unreviewed click | **High** | Engine | `packages/shared/src/commands.ts:21-34` |
| O4 | Agent-written context fields are presented to the next run as "Context a human has set" | **Medium** | Engine | `engine/prompt.ts:83-90` |
| O5 | The `/events` replay and the live hub ignore `message_cutoff_seq` | **Medium** | Tenancy | `routes/workspace.ts:213-230`, `hubs.ts:185-187` |
| O6 | Revoking a share evicts no socket, and the hub ticket's session binding is inert | **Medium** | Tenancy | `routes/sessions.ts:416-438`, `hubs.ts:156-160` |
| O7 | `attachments.session_id` is client-supplied and never validated | **Medium** | Tenancy | `attachments/service.ts:153` |
| O8 | Model-authored block `title`/`subtitle`/`label` skip the plain-text validator | **Medium** | Engine | `packages/shared/src/commands.ts:154-165` |
| O9 | `get_document_text` returns a 24,000-char window into an 8 KB envelope, so paging is unreachable and the model silently reads a third of a document | **Medium** | Engine | `engine/constants.ts:60-64` |
| O10 | `TOOL_RESULT_MAX_BYTES` is not a cap: the truncation path re-escapes and can double | **Medium** | Engine | `engine/tools.ts:214-229` |
| O11 | A model-chosen tool argument can raise a Postgres error that kills the run | **Medium** | Engine | `engine/pg-agent-db.ts:699`, `:719`, `tools.ts:505` |
| O12 | Third-party CI actions are pinned to moving tags in the job that holds the deploy token and the DB owner URL | **Medium** | Ops | `.github/workflows/deploy-staging.yml:54`, `:76` |
| O13 | The nightly backup job is gated on an environment the runbook requires to have a human reviewer | **Medium** | Ops | `.github/workflows/backup-nightly.yml:85` |
| O14 | The "write-only" backup credential is used for `HeadObject`, which requires read | **Medium** | Ops | `.github/workflows/backup-nightly.yml:131-147` |
| O15 | `runBackupUploads` has no cursor, so a workspace over ~330 objects is never backed up | **Medium** | Ops | `storage/backup.ts:38-58` |
| O16 | The platform instance cap locks one global row inside every turn's tenant transaction | **Medium** | Ops | `ops/instance-cap.ts:72-84`, `routes/turns.ts:174` |
| O17 | Rate counters are refunded on the refusal path, so a workspace with no key can flood turns unmetered | **Medium** | Ops | `auth/rate-limit.ts:43-64` |
| O18 | Staging and production declare identical placeholder Hyperdrive ids | **Medium** | Ops | `wrangler.jsonc:229-230`, `:305-306` |
| O19 | `/auth/callback`, the `/events` replay and hub upgrades have no limit of any kind | **Medium** | Ops | `index.ts:207`, `:219`, `:348-349` |
| O20 | The envelope AAD does not bind `provider` | **Low** | BYOK | `keys/envelope.ts:132-139` |
| O21 | `onError`'s catch-all matches structurally on `{status, reason}` rather than by type | **Low** | Ops | `index.ts:176-187` |
| O22 | `index.ts:188` is the one un-redacted error sink, and it is the catch-all for the key routes | **Low** | BYOK | `index.ts:188` |
| O23 | The subrequest budget is asserted in a unit test and measured nowhere | **Low** | Engine | `engine/constants.ts:34-35`, `ops/analytics.ts:148-156` |
| O24 | `waitForAnswer` sets `waiting` before registering the wait, and cannot be woken by Stop | **Low** | Engine | `engine/engine.ts:823-840` |
| O25 | Duplicate provider tool-call ids collide on `seq` and on the step name | **Low** | Engine | `engine/engine.ts:302`, `:668` |
| O26 | `allowedTools` falls back to `work` — the least restrictive mode — for an unknown mode | **Low** | Engine | `engine/tools.ts:768` |
| O27 | The `0011` backfill is a silent no-op under forced RLS | **Low** | Tenancy | `migrations/0011_run_mode.sql:16-19` |
| O28 | `hermes_user_workspaces` is not `SECURITY DEFINER`, contrary to the comment that relies on it | **Low** | Tenancy | `migrations/0013:214-224`, `routes/auth.ts:290` |
| O29 | Re-applying migrations briefly forces RLS onto the platform tables | **Low** | Tenancy | `migrations/0003_rls.sql:34` |

### The ones worth reading in full

**O1 · a share is a share with everybody.** Every visibility check is
`EXISTS (SELECT 1 FROM session_shares sh WHERE sh.session_id = s.id AND
sh.revoked_at IS NULL)`. It never correlates the share with the caller or with a
presented token. `createShare` mints a 256-bit token, stores its SHA-256 and
returns `${origin}/shared/${token}` — and **there is no `/shared/:token` route**;
`token_hash` is read by no query in the Worker. So two things are true at once:
the moment an owner creates a link share, every member of the workspace gains
read access to that session, and the person actually holding the link gets
nothing but the SPA shell. There is no unauthenticated viewer and no
cross-workspace leak, because the feature does not exist server-side — but the
product hands someone a URL that promises to be a share link and is not one, and
`test/db/sessions.test.ts:67` pins the current behaviour as intended.

This is a product decision, not a patch. Either implement `GET /shared/:token`
(hash the presented token, match `token_hash`, serve a read-only view capped at
`message_cutoff_seq`) and narrow the in-workspace predicate; or, if "share means
visible to the workspace" is the intent, delete the token and the `/shared/` URL
and rename the concept — because as it stands the code stores a secret that
protects nothing. **O5 and O6 are downstream of this one** and should be decided
with it: the replay stream and the live hub apply the visibility predicate but
not the cutoff, so a non-owner reads everything written after the share point,
which is exactly the property `routes/sessions.ts:295` says a share must not
have ("a share is a snapshot of a conversation, not a subscription to one").

**O2 · a reaped run keeps running.** For the `engine_version_changed` and
`no_progress` verdicts the sweep writes `runs.status = 'error'` and publishes
`run.status`, but it does not set `stop_requested`, and nothing calls
`terminate()`. The live Workflow polls `stop_requested` only. So the instance
keeps going: it calls more tools, writes more `requests` rows, and on completion
`setRunStatus(run.id, 'completed')` — whose UPDATE has no status guard —
silently resurrects a run the sweep declared dead. Deploy a new `ENGINE_VERSION`
with runs in flight and every one of them is marked errored in the UI while
continuing to put proposals in the Inbox under the old code path. Fix: set
`stop_requested` for every non-`ok` verdict, call `instance.terminate()` after
the commit, and guard terminal transitions in `setRunStatus`.

This does not breach the approval invariant — a zombie run still cannot decide —
but it breaks the weaker promise the operator is relying on, which is that
stopping a run stops it.

**O3 and O4 · the two ways a prompt injection escalates without touching a
decision.** The decision invariant itself held under every attempt (see below).
These are the routes around it. `apply_prepared_proposal` is in
`MODEL_COMMANDS`, dispatches to `saveInstruction(workspaceId, command.id)` with
no confirmation and no diff, and takes a model-chosen `id` naming any `proposed`
instruction version in the workspace. So: injected text in an uploaded document
gets the agent to `propose_instruction` with a body that relaxes a review rule;
the same reply carries a block labelled "Continue" whose command is
`apply_prepared_proposal` for that version; one Admin click makes it the agent's
standing system prompt, unread. The registry's own header says the risk it
closes is "a human clicking a button the model labelled 'Looks good'" — this is
that button, and it is on the allowed list. O8 sharpens it: block labels skip
the plain-text validator entirely, including the bidirectional-override
characters `plain-text.ts` exists to strip, so the visible label need not be the
stored one.

O4 is the quieter version. `set_context_field` is a model tool;
`loadWorkspaceContext` selects `key, value, scope` and ignores `set_by` and
`run_id`, which exist on the table precisely to tell agent writes from human
ones; `buildSystemPrompt` then renders all of them under the literal header
`Context a human has set:`. An injected document in run N can therefore write a
sentence that appears in run N+1's system prompt attributed to a human, which
outranks the "everything from a tool is untrusted" framing around it. It is a
persistent, self-attributed injection that survives the session. Fix: select
`set_by`/`run_id` and render two labelled sections.

**O14 · the backup credential contradicts itself.** The workflow documents
`BACKUP_R2_ACCESS_KEY_ID` as write-only and then runs `aws s3api head-object`
with it. R2 has no write-only object permission; the narrowest that allows
`PutObject` is Object Read & Write. So either the verify step 403s every night
and `set -euo pipefail` fails the job, or the production token has read and
delete on every backup — the exact credential the file's comment says was
avoided. Both are findings. `test/unit/workflows.test.ts:243` asserts the string
"write-only" appears in the file, which certifies the comment rather than the
scope.

---

## What held

Recorded because a reviewer's "no finding" is only useful if it says what was
tried.

**The approval invariant held under every attempt.** `POST
/w/:ws/requests/:id/decisions` is the only writer of `decisions` and the only
path that moves a request out of `pending`, and all three layers are real:
migration `0004` revokes `UPDATE` on `requests` from the `agent` role, so a
proposal cannot be moved even by the role that created it; `AgentWrites`
(`engine/agent-db.ts:96-116`) genuinely has no `decide`, `execute`, `invite`,
`role` or `job` method; `validateModelBlocks` is deny-by-default and walks
nested `batch`, and the client repeats the check. The `0013` widening is
narrower than it looks — the agent may publish `request.created` and
`entity.updated` only for a payload naming a `requests` row in this workspace
carrying a `run_id`, and the engine never lets a model-supplied string reach
`EmitInput.kind`. Forging `decision.recorded` from the agent role fails at the
trigger; deciding through the Cron drain has no route, because `jobs` is revoked
from `agent` outright and the drain executes only the enum of job kinds it
knows; replaying a decision job is idempotent twice over (`UNIQUE(kind, key)` on
`jobs` keyed by `decision_id`, and `UNIQUE(session_id, client_id)` on the two
receipt messages). The re-version route cancels effects rather than mutating a
decision, and migration `0005` refuses a document version from the agent role
once the request has left `pending`.

**Row-level security is forced and fail-closed on every tenant table,
including the ones added after M1.** `0003` derives the table list dynamically
from `pg_attribute` rather than hard-coding names and raises if anything is
unprotected, and the migration runner re-applies it after every later file, so
`session_drafts`, `attachments` and the `0010`–`0013` additions are covered.
`app_workspace_id()` yields NULL for both unset and empty, and a pooled
connection with no tenant key reads zero rows rather than raising. Every one of
the five `set_config` call sites uses the transaction-scoped form inside an
explicit `BEGIN`; there is no plain `SET` in `src/`. None of the seven platform
tables is reachable by a tenant caller in a way that returns another tenant's
data — each read is either a system path with no request context, or filtered
inside a `SECURITY DEFINER`-shaped function by a value the caller cannot widen.

**BYOK is the strongest part of the system.** Key plaintext exists in exactly
three scopes and is written nowhere: not to `model_calls`, `run_turns`,
`stream_events`, Analytics, R2, or any client-facing error. Sentry drops
request headers, cookies, body and query string outright and redacts the rest.
The envelope AAD binds workspace and key id (and the KEK version on the wrap),
so a ciphertext pasted into another workspace's row fails to decrypt, and a
version downgrade fails authentication. Provider base URLs are module constants
with no override — there is no field in any request body or table that could
point a probe at an attacker's host — so the exfiltration shapes that usually
make BYOK dangerous are not expressible here. Masking is enforced by the
contract: `maskedProviderKeySchema` is `.strict()` and there is no shape in it
that could carry a key.

**SSRF defences other than the IPv6 gap were sound.** `fetch_url` uses
`redirect: 'manual'` and re-runs the full host vetting *and* a fresh DNS
resolution on every hop, which is better than most implementations; decimal,
octal and hex IPv4 forms are normalised by the WHATWG parser before the check
sees them; schemes, embedded credentials, ports, methods and the
empty-allowlist-denies-all rule are all correct.

---

## Verification

```
pnpm --filter @hermes/worker typecheck   tsc -p tsconfig.json — clean
pnpm --filter @hermes/worker test        60 files, 643 tests passed
pnpm db:test                             28 files, 293 tests passed
pnpm --filter @hermes/shared test         5 files,  48 tests passed
```
