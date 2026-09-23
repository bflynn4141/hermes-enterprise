# Agent guide

Hermes Teams is an enterprise control plane around the official Hermes Agent
runtime. It adds tenant isolation, identity, policy, human approvals, durable
state, and browser delivery. Preserve those guarantees before optimizing code.

## Read first

1. [README.md](README.md) for the product and local setup.
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the current system shape and
   authority boundaries.
3. [docs/CONVENTIONS.md](docs/CONVENTIONS.md) for ownership and migration rules.
4. [docs/DECISIONS.md](docs/DECISIONS.md) for the indexed decision record.
5. [docs/README.md](docs/README.md) to distinguish current references from
   dated audits, proposals, and delivery notes.

More specific `AGENTS.md` files, if added later, take precedence in their own
directories.

## Code map

| Path | Owns |
| --- | --- |
| `apps/client` | React interface, client state, mock browser tests, and live Playwright flows |
| `apps/worker/src/routes` | HTTP parsing, authentication, authorization entry points, and responses |
| `apps/worker/src/domain` | Business rules that do not depend on HTTP |
| `apps/worker/src/runtime` | Hermes admission, bridge transport, credentials, and runtime contracts |
| `apps/worker/migrations` | Append-only SQL source of truth for schema, RLS, grants, and triggers |
| `packages/shared` | Shared wire schemas, events, refs, commands, and document contracts |
| `packages/motion-components` | Reviewed UI package source; `dist` is rebuilt, not hand-edited |
| `runtime/hermes` | Pinned official Hermes runtime installer and enterprise bridge |
| `docs` | Current references plus clearly labeled historical evidence |

## Invariants

- Resolve the workspace from the URL and perform tenant work in one scoped
  transaction. Never trust a workspace header or client-side filter.
- Only the guarded decision route records a human decision. The `agent`
  database role must never gain permission to decide, admit, grant, or enqueue
  privileged work.
- Keep decisions separate from effects. This repository does not execute real
  outreach, payment, access grants, or signatures.
- Write state, audit records, outbox events, and durable jobs in the same
  transaction. Make every external operation idempotent and retryable.
- Treat SQL migrations as immutable after merge. Keep Drizzle types as a mirror,
  not a migration generator.
- Keep domain code independent of routes. Keep the Worker runtime import graph
  acyclic; `pnpm lint:imports` enforces this.
- Do not weaken secret redaction, provider-key envelope encryption, runtime
  attestation, or release-ring checks to make a test pass.
- Preserve unrelated work and do not commit credentials, local worktrees,
  generated QA screenshots, `.agentcash`, `work`, or a stray `~` directory.

## Working loop

1. Locate the owning module and the decision or invariant behind it.
2. Reproduce behavior with the narrowest useful test.
3. Make the smallest coherent change at the correct boundary.
4. Run `pnpm check:quick` before broader checks.
5. Run the suites that match the risk:

```sh
pnpm test                 # all package, Worker, and database tests
pnpm db:migrations:verify # disposable migration replay and fingerprint
pnpm test:browser:mock    # credential-free browser behavior
pnpm e2e:live             # disposable Postgres plus the live Worker and browser
pnpm lint:secrets         # pinned, checksum-verified gitleaks scan
```

Changes to RLS, grants, migrations, decisions, provider credentials, or runtime
admission require focused tests in addition to typechecking. Validate interface
changes in a rendered browser at desktop and narrow widths.

For a user-visible change, deploy a preview once the pull request exists and
check the change there: `node scripts/preview.mjs up <pr> --comment`. It posts
the link on the PR; take it down with `down <pr>` when the PR closes. See
[docs/PREVIEWS.md](docs/PREVIEWS.md).

## Generated and review artifacts

- Build outputs under `apps/*/dist` and `packages/shared/dist` are generated and
  ignored.
- `packages/motion-components/dist` is committed so the vendored package is
  reviewable and consumable. Rebuild it from `src` with
  `pnpm --filter @hermes/motion-components build`.
- Playwright reports, test results, and `apps/client/qa` screenshots are local
  or CI artifacts, not source. Stable documentation images live in
  `docs/assets`.
- Update the current reference when behavior changes. Keep dated audits and
  proposals as evidence, and label superseded claims instead of treating them
  as current architecture.
