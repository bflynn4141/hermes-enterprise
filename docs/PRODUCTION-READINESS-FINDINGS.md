# Production readiness findings

September 15, 2026 · Source and configuration sweep

This inventory separates production-reachable gaps from intentional test and demo assets. A keyword such as `mock`, `fixture`, `placeholder` or `QA` is not a defect on its own. Severity reflects whether deployed behavior can mislead a person, weaken an authorization boundary, lose a requested operation or ship an unverified change.

## P0 — confidentiality or authorization

### Share audiences are presentation-only

- **Evidence:** `apps/client/src/app/chat/ChatPane.tsx` offers Workspace and named-member audiences, then sends the display label. `apps/worker/src/routes/sessions.ts` stores that label, while `apps/worker/src/routes/shares.ts` redeems an unbound bearer token for any holder.
- **Impact:** a person can reasonably believe a link is restricted to a workspace or recipient when it is a public capability URL. The client also clears local share state after a failed revoke, which can make a live link look disabled.
- **Disposition:** immediate remediation. Until recipient and membership binding exist, expose one truthful “Anyone with the link” option. Preserve the active state and show the error if revocation fails.
- **Owner:** isolated production-placeholder remediation task.

## P1 — production behavior or security

### Provider credential re-verification is recorded without running

- **Evidence:** `apps/worker/src/keys/reverify.ts` contains the real runner, but its weekly enqueue is never called. Enqueues in it and `apps/worker/src/keys/verify.ts` omit `job_ready`. `apps/worker/src/jobs.ts` handles `reverify_provider_key` with a log-only placeholder before the generic job wrapper marks the job done.
- **Impact:** revoked provider credentials can remain verified; model catalog, pricing and default-model decisions can remain stale.
- **Disposition:** wire the existing runner through the durable ready queue, schedule the weekly scan and cover retry/failure state.
- **Owner:** isolated production-placeholder remediation task; no approval-file overlap.

### WorkOS login state is not browser-bound

- **Evidence:** `apps/worker/src/routes/auth.ts` appears to send the sanitized return path as OAuth `state` and accepts it on callback without a nonce cookie or server record.
- **Impact:** login CSRF/session substitution remains possible even though the final return path is constrained.
- **Disposition:** bind a one-time, expiring state value to the initiating browser and carry the return path inside authenticated/encrypted state or a server transaction. Verify issuer and application/client claims against the current WorkOS access-token contract.
- **Owner:** WorkOS hardening task `01a0a78b-0709-7950-8be9-c7b1599abfdf`.

### WorkOS organization membership is incomplete on workspace creation

- **Evidence:** `apps/worker/src/routes/workspaces.ts` creates the WorkOS organization and a local member, but the current port does not create a WorkOS organization membership or refresh the session into the new organization.
- **Impact:** the local workspace can exist without an equivalent WorkOS authorization relationship; the creator may not receive an organization-scoped session.
- **Disposition:** create or reconcile the membership, then refresh/replace the session with the selected organization. Keep multiple-organization selection explicit instead of selecting the first active membership.
- **Owner:** WorkOS hardening task.

### The visible Sign out action starts a login

- **Evidence:** `apps/client/src/app/layout/Sidebar.tsx` labels the action Sign out but calls `adapter.auth.signInUrl`; `apps/client/src/adapters/rest.ts` resolves that to `/auth/login`.
- **Impact:** the person may remain signed in and begin another auth transaction.
- **Disposition:** route to the Worker logout endpoint and cover it in client/auth tests.
- **Owner:** WorkOS hardening task.

### Onboarding input does not configure the created agent

- **Evidence:** `apps/client/src/app/pages/Onboarding.tsx` collects agent name and instructions but sends only workspace `{name}`. `apps/worker/src/routes/workspaces.ts` inserts an agent named `Iris`. The optional `patchAgent` path in `apps/client/src/adapters/rest.ts` swallows the missing route, and no public agent PATCH route is registered. Agent setup actions therefore report progress without persistence.
- **Impact:** the first-run experience claims to create/configure the employee’s agent but discards the defining input.
- **Disposition:** complete the create/update contract and fail visibly. Coordinate after the active Inbox branch, which currently owns overlapping `Agent.tsx` work.
- **Owner:** later isolated onboarding task after approval Inbox integration.

### Chat attachments do not reach the agent runtime

- **Evidence:** the client uploads attachment records and sends their IDs with a turn, but `apps/worker/src/routes/turns.ts` creates a text-only provider message and does not resolve or pass those attachments to Hermes. The composer presents attached files as context for the next response.
- **Impact:** Iris can answer as though it considered a document that it never received.
- **Disposition:** resolve authorized attachment IDs to immutable content references, bind them to the turn/run request and prove one representative PDF reaches the official Hermes tool/runtime path. Until then, disable attachments for live runs or show an explicit unsupported state.
- **Owner:** runtime bridge work after the compliance audit; avoid overlapping the active approval-runtime branch.

### Development seeding can write to an arbitrary database

- **Evidence:** `apps/worker/scripts/seed-dev.mjs` accepts `DATABASE_URL_OWNER`, carries fixed QA identities and lacks an environment, hostname or explicit confirmation guard.
- **Impact:** an operator can seed prototype identities into a non-development database.
- **Disposition:** refuse non-local/non-test targets by default, require an explicit exceptional override and print the target without credentials before mutation.
- **Owner:** production-placeholder remediation task.

### CI does not run the client suite it describes as complete

- **Evidence:** root `package.json` runs shared and Worker tests for `pnpm test`; 13 client unit files and 17 Playwright specs are outside that command. `apps/worker/test/unit/workflows.test.ts` describes the root command as the full suite.
- **Impact:** a green required check can miss client regressions.
- **Disposition:** add the client unit suite to CI and make browser coverage an explicit named check with retained artifacts.
- **Owner:** repository hardening task after active UI work lands.

### Staging deployment is not gated by CI

- **Evidence:** `.github/workflows/deploy-staging.yml` triggers on every main push despite a comment describing a post-CI deployment.
- **Impact:** failing code can migrate and deploy to staging before checks finish.
- **Disposition:** use `workflow_run`/a reusable workflow or make deploy a dependent job in the required workflow.
- **Owner:** repository hardening task.

### Production preflight omits the client build

- **Evidence:** `.github/workflows/deploy-production.yml` runs a Wrangler dry run without first producing `apps/client/dist`. The client distribution is not tracked, and `apps/client/.gitignore` overrides the root unignore attempt.
- **Impact:** a clean production preflight can fail for missing assets or validate stale local assets instead of the commit being released.
- **Disposition:** run a clean client production build before Wrangler preflight and add a clean-checkout packaging test.
- **Owner:** repository hardening task.

## P2 — incomplete capability or misleading product state

### WorkOS drift and invitations can report success while unavailable

- **Evidence:** `apps/worker/src/jobs.ts` marks `workos_sync` done when its port/configuration is unavailable. `apps/worker/src/routes/members.ts` can create or resend a local pending invitation without a WorkOS organization/port and without sending an email. Workspace deletion can discard the local WorkOS link after skipping remote organization deletion.
- **Impact:** users see a pending invitation or completed reconciliation that did not occur, and remote organizations can become orphaned.
- **Disposition:** retry sync and remote deletion durably in WorkOS mode; return an explicit undelivered state outside it. Keep local-only development behavior visibly distinct.
- **Owner:** WorkOS hardening task.

### Notification and privacy settings assert capabilities not backed by the server

- **Evidence:** `apps/client/src/app/pages/Workspace.tsx` shows saved Email notifications, but the Worker only stores booleans and has no mail sender/digest. The Data and privacy section says every fact comes from the server while hardcoding training and sharing-policy claims in the client.
- **Impact:** people can believe mail will arrive or rely on privacy promises that are not an enforced server contract.
- **Disposition:** hide unavailable email controls or return an explicit capability; source data-use/sharing facts from a server-owned policy record before presenting them as enforced.
- **Owner:** production-placeholder remediation task, scheduled after active UI integration.

### Money movement, signatures and PDF generation are preview/approval only

- **Evidence:** `apps/worker/src/domain/effects.ts` has no bank, signature, access or mail executor; `apps/worker/src/routes/effects.ts` returns unavailable for execution. `apps/worker/src/documents/render.ts` provides HTML rather than server-generated PDF.
- **Impact:** the Inbox can review and authorize a requested effect, but the system cannot truthfully claim the external transfer, signature or PDF generation completed.
- **Disposition:** retain explicit preview/authorization language and `unavailable` receipts until providers are integrated. Treat “approved” and “executed” as separate durable states.
- **Owner:** approval server/UI tasks for truthful copy; provider integrations remain future work.

The integrated Inbox still labels its seeded payment account, signature and files as demo/illustrative and separates authorization from bank execution. Those strings are fixture presentation, not hidden production execution. Tenant-derived signer identity and real provider adapters remain launch work.

### Hosted environments do not select Hermes runtime

- **Evidence:** staging and production Wrangler variables do not set `AGENT_RUNTIME=hermes`; the hosted runtime also needs profile processes, API keys and network bindings.
- **Impact:** local Iris can use the official Hermes Agent while hosted deployments remain on the legacy runtime path.
- **Disposition:** do not flip the flag until per-agent profile supervision, secret distribution, health checks, network isolation and rollback are provisioned. Track as an operational launch gate.
- **Owner:** runtime compliance/operations, after the exact pin audit.

### Production migration tooling replays the full catalog

- **Evidence:** `apps/worker/scripts/migrate.mjs` replays every migration against its target as an idempotence proof, including static catalog DML such as `0007_seed_catalog.sql`.
- **Impact:** production deployment does more than apply pending migrations and couples verification to live data assumptions.
- **Disposition:** run replay/idempotence against a disposable shadow database in CI; apply pending migrations only to production.
- **Owner:** repository hardening task.

### Source maps are shipped with static assets

- **Evidence:** `apps/client/scripts/build.mjs` enables source maps unconditionally and the Worker serves the full client distribution.
- **Impact:** deployed maps expose application source and development-only implementation details. Compile-time dev paths are not themselves enabled, but the source is disclosed.
- **Disposition:** omit public production maps or upload them privately to the error service and exclude them from the static binding.
- **Owner:** repository hardening task.

### The root build does not build the deployable client

- **Evidence:** the root `package.json` build script covers shared and Worker packages only.
- **Impact:** a successful local or CI “build” can leave the static application missing or stale.
- **Disposition:** make the deployable root build produce a clean production client bundle and verify the Worker assets binding from that output.
- **Owner:** repository hardening task.

### Local live-E2E secret copy persists with broad permissions

- **Evidence:** `apps/client/scripts/e2e-live.mjs` copies `.dev.vars` to `.dev.vars.test`, does not clean it on exit and relies on the default file mode.
- **Impact:** local secrets gain a second, more broadly readable copy.
- **Disposition:** create the temporary file with mode `0600`, delete it in `finally` and reuse existing state without printing values.
- **Owner:** repository hardening task.

## Intentional test and demo assets

- `apps/client/qa/` currently contains about 210 tracked PNG artifacts (roughly 69 MB). They are visual evidence generated by test work, not bundled runtime state. Tests do not currently compare them as baselines. Decide separately whether to retain selected evidence, move it to CI artifacts or remove it after the active approval Inbox task lands.
- Mock backends, scripted model providers, fake-auth identities, fixed UUID fixtures and `placeholder.invalid` addresses remain valid when guarded to development/test and absent from production bundles.
- Demo applications, invoices and agreements are useful for the interview flow when the UI labels the workspace as fictional/demo data. Their presence in seeds is not proof of a production fallback.
- Existing `unavailable` effect receipts are the correct fail-closed behavior until real bank/signature/mail adapters exist.
- Partner-program, admissions and Nous-specific copy is acceptable only inside the labeled interview scenario. Generic tenant onboarding and default agent configuration must use workspace-owned content.

## Documentation residue

- `README.md` and `docs/CONVENTIONS.md` still describe earlier milestone/placeholders after those areas evolved.
- `docs/SECURITY-REVIEW.md`, `docs/HANDOFF-ASTRA.md` and parts of the runbook still present resolved Hyperdrive provisioning as future work.
- Preserve historical handoffs as records, but mark them archived and make the current status documents authoritative.

## Integration order

1. Integrate and verify the active approval server, Inbox and runtime branches.
2. Integrate WorkOS hardening after its auth and organization tests pass.
3. Apply a narrow production-placeholder fix for bearer-share truthfulness, provider re-verification and seed guards.
4. Complete onboarding persistence after the Inbox-owned `Agent.tsx` changes land.
5. Harden CI, deployment, maps, migrations and QA artifact retention on the integrated tree.
6. Keep hosted Hermes disabled until the compliance audit and operating prerequisites are closed.
