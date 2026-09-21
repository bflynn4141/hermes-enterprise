# Production readiness — delivery status

Updated September 15, 2026. Scope: [production-readiness plan](PRODUCTION-READINESS-SWEEP.md).

## Integration

- Lead: `01a09653-559f-7c90-bf22-0a9f9a3e5fed` on local.
- Main checkout: `<local checkout of this repository>`.
- Plan baseline: `92083de`.
- Approval Inbox, server and runtime workstreams are integrated on `main`.
- The implementation tasks did not mutate the existing localhost workspace or Iris profile. After integration, the existing profile was started through the hardened launcher for the live smoke check recorded below.

## New isolated tasks

| Workstream | Native task | Branch / worktree | State |
| --- | --- | --- | --- |
| WorkOS email + SSO | `01a0a78b-0709-7950-8be9-c7b1599abfdf` | `codex/workos-auth-hardening` · `/Users/gia/Documents/Codex/2026-09-15/hermes-workos-auth` | Complete and integrated as `0683347` |
| Official Hermes compliance | `01a0a78b-5ebb-7d92-95b4-e9e9493405fc` | `codex/hermes-runtime-compliance` · `/Users/gia/Documents/Codex/2026-09-15/hermes-runtime-compliance` | Audit integrated as `4168c43` |
| Production placeholder cleanup | `01a0a791-83d8-7211-9549-7820b098d3df` | `codex/production-placeholder-cleanup` · `/Users/gia/Documents/Codex/2026-09-15/hermes-production-cleanup` | Complete and integrated as `f73b713` |
| CI and artifact hardening | `01a0a793-8669-7301-a9c4-12f826e6ed59` | `codex/repository-production-hardening` · `/Users/gia/Documents/Codex/2026-09-15/hermes-repository-hardening` | Complete and integrated as `a98e7d7` + `bfbfcfe` |
| Hermes code-level hardening | `01a0a7be-e7f5-74e1-b72d-407c88e170a1` | `codex/hermes-runtime-hardening` · `/Users/gia/Documents/Codex/2026-09-15/hermes-runtime-hardening` | Complete and integrated as `96fcfd1` |

Three internal read-only subagents completed client, server and repository sweeps. Their deduplicated report is [PRODUCTION-READINESS-FINDINGS.md](PRODUCTION-READINESS-FINDINGS.md). The approval Inbox branch was integrated as `d6eba9d`; the production-placeholder task began from the post-Inbox baseline so it can safely own its narrow files.

## Remediated in this pass

- Share creation is now a truthful bearer link labeled “Anyone with the link.” A failed revoke leaves it active and exposes a retryable error.
- Provider-key re-verification is scheduled weekly, enters `job_ready`, executes the real runner and preserves failure/backoff state.
- Development seeding refuses non-local/non-test targets without an explicit exceptional override.
- WorkOS authorization state is browser-bound and expiring; token issuer, client, subject, session and authentication-time claims are verified. Workspace creation provisions the creator membership; invites/sync/deletion fail closed; Sign out reaches `/auth/logout`.
- CI runs client tests, staging waits for successful CI, production preflight builds fresh assets, production maps are omitted, E2E secret copies are private/temporary and migration replay runs only on a disposable database.
- Hermes installs locked dependencies from the exact verified pin, requires the durable Runs capability at health/admission/reconciliation, exercises restart replay, rejects unsupported attachments before persistence and checks for latent native cron state/routes.
- Enterprise approvals and approved `run_plan` continuations now enforce reviewed per-call budgets and credential-specific accounting.

## Remaining production gates

- Staging AuthKit is configured for invite-only access and the real hosted page and one application-wide invitation delivery have been verified. Complete invitation acceptance, callback/session/MFA/logout, organization reconciliation and workspace creation, then attach and exercise a real enterprise SSO connection using [the acceptance checklist](WORKOS-PRODUCTION-CHECKLIST.md).
- Provision one hosted Hermes profile per agent with a unique supervisor/fence, whole-process sandbox, private network route, credential rotation, logs/metrics, profile erasure and backup/restore. Staging/production correctly remain on the legacy runtime until this exists.
- Implement full immutable attachment delivery or a governed attachment-read tool. The current live path rejects nonempty attachments rather than pretending Iris read them.
- Extend per-call reservations to ordinary runs, add durable orphan reconciliation, and integrate real payment/signature/mail/PDF executors. Approval and execution remain separate states.
- Persist onboarding agent name/instructions through a real create/update route; remove or server-source unsupported email-notification/privacy claims.
- Decide whether to retain, curate or move the 210 tracked QA PNGs (about 69 MB) to CI artifacts after visual-design work settles. They are not runtime code and were not deleted in this safety pass.

The detailed source inventory and intentional test-only exceptions remain in [PRODUCTION-READINESS-FINDINGS.md](PRODUCTION-READINESS-FINDINGS.md). Hermes-specific evidence and provenance are in [HERMES-COMPLIANCE-AUDIT.md](HERMES-COMPLIANCE-AUDIT.md).

## Integrated verification

- Node 26 workspace typecheck passed.
- Shared unit: 87 passed; client unit: 179 passed; Worker unit: 495 passed.
- Isolated PostgreSQL: 36 files / 403 tests passed after migrations 0022–0023.
- Workerd: 5 files / 29 tests passed in local Hermes mode.
- Root production build and Worker Wrangler dry run passed.
- Python Hermes tests: 14 passed; exact pinned official gateway + `AIAgent` fixture probe passed in the isolated hardening task.
- Local live smoke check passed with the existing Iris profile: the exact locked source verified, native `/health` returned `200`, and the enterprise `/health` returned `200` with `hermes:runs` ready. The process is attached to the current local development session; a durable hosted supervisor remains a production gate.
