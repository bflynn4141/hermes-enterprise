# Approval expansion — delivery status

Updated September 15, 2026. Scope: [implementation plan](APPROVAL-EXPANSION-PLAN.md).

## Integration

- Lead: one integrating session on the main checkout.
- Checkout: `<local checkout of this repository>`, branch `main`.
- Working app baseline: `9a46b7d`. Plan commit: `19d70b4`.
- Existing app: `http://localhost:8787`. Workers must not reset its data or restart its services.
- Delivery state: all three implementation tasks active. Shared contract `12920a6` integrated as `82b5042`; explicit budget maxima and resource bindings `0a46b61` integrated as `22d4269`. Server, runtime and UI implementation remain in progress.

## Owners

Each workstream ran in its own isolated work session with a separately created Git worktree at the committed plan baseline.

| Workstream | Branch |
| --- | --- |
| Contract and server | `codex/approval-server` |
| Inbox and chat | `codex/approval-inbox` |
| Runtime and budgets | `codex/approval-runtime` |

## Dependencies and verification

- Server worker publishes the shared contract checkpoint first. UI and runtime consume that exact commit and return their own commits for lead integration.
- Integration order: shared contract → server → runtime → client → combined verification.
- Worker database tests require isolated databases or a coordinated exclusive slot. No live workspace seeds, external sends, payments, signatures, paid model verification or production deploys.
- The lead will inspect exact diffs and exercise existing four-item paths plus all ten new approval families, reviewer routing, stale versions, duplicate decisions, continuation admission and budget refusal.
- Integrated contract verification: shared tests 87/87 passed; repository typechecks passed after both checkpoints. The shell used Node 22.22.0 and emitted the existing declared Node >=26 engine warning; no test/typecheck failure occurred. Later runtime checks must use a supported runtime where required.
- Lead review feedback sent to server: reject weaker-policy selection, validate recipient-owner bindings, bind supported mutable resource contents to versions/digests, and keep revision-history superseded state separate from the compatible request lifecycle.
- No new execution capability is verified yet. Any fixtures or unavailable provider/runtime capabilities must remain visible in the delivery report.
