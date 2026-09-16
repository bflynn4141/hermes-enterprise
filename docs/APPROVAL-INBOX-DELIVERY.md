# Enterprise approval inbox · client delivery

The client now renders the generalized approval contract in the existing Iris split-pane product. The default mock workspace is unchanged: it still contains Leah and Owen’s applications, Robin’s invoice, and Robin’s agreement. The expanded scenario is deliberately opt-in:

```text
/?scenario=approvals
```

It adds ten explicitly illustrative approvals, nine currently assigned to Maya and one waiting on Alex. The scenario is entirely in memory. **Reset** in the Inbox tools (or a reload) restores its initial state. No email, access grant, disclosure, record update, skill publication, agent configuration change, payment, or other external effect is connected.

## What shipped

- One approval review shell with specialized previews for plan/budget, team commitment, temporary access, communication, shared learning, deliverable acceptance, data disclosure, record change, policy exception, and agent governance.
- Reviewer-aware `For me`, `Waiting on others`, and `All` views, with the sidebar count representing requests assigned to the current viewer rather than votes.
- Named requester agents, responsible humans, current reviewers, reviewer order/quorum, expiry, evidence versions/digests, and authorization revision.
- Type-specific action language plus request changes, decline, reviewer routing, and proposal revision. Every mutation is bound to the expected authorization revision and hash and uses an idempotency key.
- A two-stage plan: Maya’s approval advances the request to Alex without starting work. Authorization, dependent work, and provider effects remain separate states in the result view.
- Current-state approval cards in Iris that deep-link to the same request ids used by Inbox.
- Responsive split-pane and narrow-pane layouts, keyboard-operable rows/actions, and reduced-motion-aware detail transitions.

## Verification

The browser suite in `apps/client/e2e/approval-inbox.spec.ts` covers the opt-in boundary, all ten previews, reviewer filtering/counts, two-stage progression, reset, a completed authorization with an unavailable external effect, request changes and revision, reviewer routing, chat-card deep links, the three legacy detail views, keyboard entry, reduced motion, and narrow-width containment.

Run focused verification with:

```bash
pnpm --filter @hermes/client typecheck
pnpm --filter @hermes/client test
E2E_PORT=4191 pnpm --filter @hermes/client exec playwright test e2e/approval-inbox.spec.ts
MOCK=1 pnpm --filter @hermes/client build
```

The repository currently declares Node `>=26`; checks performed on the local Node 22 host print that engine warning but otherwise use the pinned workspace dependencies.
