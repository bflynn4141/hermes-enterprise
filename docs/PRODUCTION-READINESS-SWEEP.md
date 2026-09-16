# Production readiness sweep

September 15, 2026 · Active delivery plan

## Outcome

Turn the current interview/demo application into a production-shaped Hermes Enterprise build without deleting useful test coverage or silently presenting simulated capabilities as live. This work answers three questions:

1. Which prototype, QA, fixture and placeholder paths are still present, and can any of them reach a deployed user?
2. Can people authenticate through WorkOS using email and enterprise SSO with safe sessions and workspace membership?
3. Does the agent execution path use the official Hermes Agent correctly at the pinned version and against the current public contract?

The Hermes lead owns integration. Existing approval tasks retain their files until their commits are integrated. New work uses isolated branches and does not reset the running workspace, change external WorkOS settings, spend money, send email, move funds, apply a signature or deploy production.

## Current evidence

### WorkOS is substantially implemented

The Worker already has AuthKit redirect/callback/session/logout routes, a sealed cookie, local JWT verification, refresh handling, server-side revocation, recent-auth step-up, CSRF/origin guards, organization and membership mirroring, invitations, role updates and WorkOS Events reconciliation. Staging and production already declare `AUTH_MODE=workos`; fake auth and scripted models are guarded to development.

The remaining work is production validation and gap closure: hosted AuthKit must expose the intended email method and SSO, callback/logout redirect URIs and cookie policy must be correct in each environment, multi-organization selection must be deliberate, and a complete real sign-in must be exercised in a WorkOS test environment. WorkOS Hosted UI provides email and SSO from the same redirect; which methods appear is controlled in the WorkOS dashboard. The app should remain invite-first unless product scope explicitly adds open signup.

### Hermes is real, pinned and governed, with an upgrade question

The app launches the official Hermes gateway and `AIAgent`, uses `/v1/runs`, native sessions, idempotent submission, SSE plus status reconciliation, stop and steer, one isolated profile per enterprise agent, a scoped model proxy and an allowlisted enterprise plugin. The bridge prevents the model from claiming workspace/run identity and keeps human decisions in enterprise routes.

The installed source pin is `5d59366010640c1d6b8f170d8a4ee109db2bbdef`, reporting package 0.21.3. The latest official release is also 0.21.3 (`v2026.9.14`), but the public tag currently resolves to a different commit. Do not upgrade based on the version string alone: compare commits and API/tool-context behavior, then rerun the native gateway probe. Current official docs now cover durable run idempotency, per-profile API keys, single-consumer SSE, `/v1/runs/{id}/approval`, approval transports and middleware. Business approvals in the Enterprise Inbox are separate from Hermes dangerous-tool approval and must not be conflated.

### QA artifacts are not automatically defects

The repository intentionally contains mock backends, scripted models, fake auth, fixture seeds, browser tests and approximately 69 MB of tracked visual QA baselines. The sweep classifies each item as:

- test-only and correctly excluded from deployed behavior;
- intentional illustrative/demo data that must remain visibly labeled;
- production-reachable placeholder or simulated success that must be removed or fail closed;
- obsolete/dead artifact safe to remove after retaining any unique evidence.

File names such as `placeholder.invalid`, test doubles and `unavailable` receipts are not findings by themselves. Reachability and truthfulness determine severity.

## Workstreams

### A. Placeholder and QA inventory

Run independent client, server and repository sweeps. Record exact file/line, configuration gate, production reachability, user impact and disposition. Search generated bundles as well as source so compile-time flags are proven eliminated. Inspect the deployed-environment configuration for fake auth, scripted providers, provider fixtures, hardcoded identities, demo bank/signature language, mock request creation, localhost callbacks and test routes.

Deliver `docs/PRODUCTION-READINESS-FINDINGS.md` with P0–P3 findings and an appendix of legitimate test-only code. Remediation happens only after the approval branches land, grouped by file owner to avoid conflicting edits. Removing tracked visual baselines is a separate repository-size decision; it is not required to make runtime behavior safe.

### B. WorkOS email and SSO

Audit the existing WorkOS port and routes against current AuthKit docs. Keep Hosted UI as the single authentication surface so email, SSO, MFA and recovery share one session implementation.

Required behavior:

- unauthenticated users see one clear sign-in action; Hosted UI selects email or the configured SSO connection;
- callback exchanges the code once, seals the session, verifies/links the local user and resolves a valid workspace membership;
- multiple organizations produce an explicit workspace choice rather than an arbitrary first active membership;
- invitation sign-in returns to the intended workspace and cannot become an open redirect;
- refresh, logout, server revocation, step-up and WorkOS outages preserve the current fail-closed behavior;
- staging/production refuse to start healthy when WorkOS secrets, origins or redirect configuration are missing;
- the production client bundle contains no dev account switcher/header;
- real SSO remains dependent on a configured WorkOS organization, verified domain and SAML/OIDC connection. Code cannot manufacture that external customer configuration.

Use an isolated WorkOS test environment or official test mode when credentials are available. Never print credentials. If no test credentials exist, complete deterministic adapter/route/browser coverage and leave one explicit external verification checklist; do not claim email delivery or IdP login was tested.

### C. Official Hermes compliance

Compare the exact pinned tree, the current stable tag and current official docs for:

- source provenance and dependency reproducibility;
- profile/home isolation, API keys and process supervision;
- run request/status/event/stop/steer/approval contracts and idempotency;
- session continuity and concurrent-writer behavior;
- tool registration, trusted context binding, policy checks and failure on unknown tools;
- model proxy, provider credentials, usage accounting and budget enforcement;
- SSE disconnect/single-consumer recovery and terminal reconciliation;
- tool/business approval separation, cancellation and durable continuation;
- memory/skills/cron/delegation disabled or governed as claimed;
- data deletion, retention and hosted runtime operational gaps.

Classify each item as compliant, compliant-by-design but operationally unverified, divergent intentionally, or incorrect. Any source-pin change requires the official native probe, Python tests, Worker runtime tests and one real governed session with no paid/external side effect. Keep official Hermes as the runtime; a gateway-compatible model API is inference transport, not a replacement agent loop.

## Ordering and isolation

1. Existing approval server, Inbox and runtime tasks finish and return commits.
2. Read-only QA and Hermes audits may run in parallel because they write no shared source.
3. WorkOS implementation owns auth files and tests in its isolated worktree. It avoids request/approval/runtime files.
4. The lead integrates approval contracts first, then WorkOS, then approval server/runtime/UI, and finally targeted production-readiness fixes. Migration numbers remain reserved: approval server `0022`, approval runtime `0023`; later work begins at `0024` only after checking integrated main.
5. Combined verification uses an isolated test database and ports. The existing localhost workspace and official Iris process remain untouched until the integrated build passes.

## Acceptance

- Every placeholder finding has a disposition with evidence; no broad deletion is based on a keyword alone.
- A production build provably excludes fake account controls and refuses fake/scripted execution outside development.
- Email and SSO share the real WorkOS session path; callback, refresh, logout, invitation, workspace selection and step-up have meaningful tests. External dashboard/IdP steps are named precisely.
- The Hermes report cites the exact pin and current official sources. Claims distinguish locally tested behavior from hosted production readiness.
- Existing application, invoice, agreement, applicant evidence, Iris sidebar and approval expansion continue to pass after integration.
- The final report states what is implemented, what is simulated, what is configured externally, what is tested and what remains unavailable.

## Current official references

- WorkOS [Hosted UI](https://workos.com/docs/authkit/hosted-ui), [sessions](https://workos.com/docs/authkit/sessions), and [users and organizations](https://workos.com/docs/authkit/users-organizations).
- Hermes Agent [API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server), [profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles), [security](https://hermes-agent.nousresearch.com/docs/user-guide/security), and [plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins).
