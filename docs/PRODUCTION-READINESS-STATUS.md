# Production readiness — delivery status

Updated September 15, 2026. Scope: [production-readiness plan](PRODUCTION-READINESS-SWEEP.md).

## Integration

- Lead: `01a09653-559f-7c90-bf22-0a9f9a3e5fed` on local.
- Main checkout: `/Users/gia/Documents/Codex/2026-09-12/hermes-interview/outputs/hermes-enterprise`.
- Plan baseline: `92083de`.
- Existing approval tasks remain active and own approval server, Inbox and runtime files.
- The running localhost workspace and Iris profile are not test targets for these tasks.

## New isolated tasks

| Workstream | Native task | Branch / worktree | State |
| --- | --- | --- | --- |
| WorkOS email + SSO | `01a0a78b-0709-7950-8be9-c7b1599abfdf` | `codex/workos-auth-hardening` · `/Users/gia/Documents/Codex/2026-09-15/hermes-workos-auth` | Auditing existing implementation, then fixing verified gaps |
| Official Hermes compliance | `01a0a78b-5ebb-7d92-95b4-e9e9493405fc` | `codex/hermes-runtime-compliance` · `/Users/gia/Documents/Codex/2026-09-15/hermes-runtime-compliance` | Read-only source/docs/pin audit while approval runtime work is active |
| Production placeholder cleanup | `01a0a791-83d8-7211-9549-7820b098d3df` | `codex/production-placeholder-cleanup` · `/Users/gia/Documents/Codex/2026-09-15/hermes-production-cleanup` | Fixing share truthfulness, provider-key re-verification and development seed guards |
| CI and artifact hardening | `01a0a793-8669-7301-a9c4-12f826e6ed59` | `codex/repository-production-hardening` · `/Users/gia/Documents/Codex/2026-09-15/hermes-repository-hardening` | Fixing test coverage, deployment gates, production assets, secret copies and migration verification |

Three internal read-only subagents completed client, server and repository sweeps. Their deduplicated report is [PRODUCTION-READINESS-FINDINGS.md](PRODUCTION-READINESS-FINDINGS.md). The approval Inbox branch was integrated as `d6eba9d`; the production-placeholder task began from the post-Inbox baseline so it can safely own its narrow files.

## Findings requiring action

- **P0 · share audience is misleading:** the UI offers Workspace and named-member audiences, but redemption currently authorizes any bearer-token holder. Revoke errors are also swallowed before the UI clears the share. Remove the false audience promise or enforce membership/recipient binding, and keep a failed revoke visibly active.
- **P1 · provider-key revalidation is not actually scheduled/executed:** weekly enqueue is uncalled, direct jobs omit the ready queue and the registered runner is a placeholder. Stale/revoked keys and catalog/pricing data can remain trusted.
- **P1 · development seeding can target an arbitrary owner database:** `seed-dev.mjs` needs local/refuse-production checks and an explicit exceptional override.
- **P1 · WorkOS login transaction needs review:** state appears to be only a return path rather than browser-bound state; token issuer/client claims require validation against the current documented token contract.
- **P1 · Sign out invokes sign in:** the sidebar's production action uses `signInUrl` instead of the existing logout route. Routed to the WorkOS task.
- **P2 · WorkOS sync can be marked done while unavailable:** deployed WorkOS mode should retry visibly; invitation UI must not imply email delivery when no WorkOS organization/port exists.
- **P2 · external effects and PDF generation remain unavailable:** this is currently honest in backend state, but every reachable UI action must retain that boundary.
- **P2 · staging/production do not currently select `AGENT_RUNTIME=hermes`:** local Hermes integration exists; hosted environments still require runtime hosts/profile supervision and bindings.

These are interim findings. No cleanup deletion or remediation commit has been integrated yet.
