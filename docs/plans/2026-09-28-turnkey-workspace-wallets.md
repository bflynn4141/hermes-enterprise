# Turnkey workspace wallets — implementation plan

September 28, 2026. Owner: the Claude Desktop session **Organization member wallet addresses**; Brian moved this workstream from the Hermes Tech Lead the same evening. Status: first application increment in PR208, held until the first live Turnkey test passes. Durable enrollment requests, Admin/member UI, and pure mainnet transfer-intent validation; no hosted Turnkey proof, real wallet provisioning, Inbox transfer approval integration, signing, or broadcast yet.

## Outcome and decisions

Brian's Claude Desktop conversation, **Organization member wallet addresses**, specifies one Turnkey suborganization per Hermes workspace, a wallet per member, separate agent authority, and Admin-managed money permissions. It records customer workspace Admin passkeys as root; Hermes must not be in that root quorum. Brian explicitly selected **wallets + mainnet approvals** in this Codex task. Base mainnet and USDC are the proposed initial network/asset, inferred from the existing Base/AgentCash usage, not a newly approved recipient or spending amount.

First usable product flow: a workspace owner connects Turnkey and establishes customer-controlled recovery; a member and their agent receive distinct workspace wallet addresses; the agent proposes a concrete Base USDC transfer; the Inbox displays the exact transaction and collects the required human approvals; a separate, authorized execution step signs and submits those approved bytes and records the receipt. Merely provisioning a wallet or approving a request must never transfer funds.

The local permission experiment remains unfunded Base Sepolia native ETH, solely to inspect provider behavior. Its success will NOT be presented as mainnet USDC acceptance. Mainnet-specific signing, passkeys, policy enforcement and transaction receipts need separate verification.

## What exists, and what is missing

Initial repository reference inspected: origin/main **835c7b40**, PR199. Implementation checkout starts from **6c24ea43**, PR203, at `/Users/gia/projects/hermes-turnkey-wallets`. The local main checkout is older (035274cd) and contains unrelated uncommitted edits. Do not reset, stash, overwrite, or build the feature on that stale checkout; use an isolated checkout of current main for application changes.

Existing reusable pieces:

- Workspace isolation and current membership checks: `apps/worker/src/routes/tenant.ts`, `routes/members.ts`.
- Named roles and membership: `apps/worker/src/domain/roles.ts`, migration0072, shared role schemas.
- Amount-aware approval routing and independent reviewers: `domain/approval-routing.ts`, `routes/approvals.ts` and shared approval schemas.
- Audit/history and durable jobs.
- Exact-approved-revision outbox precedent: `outbound-email/outbox.ts` and `send-job.ts`; adapt the lifecycle pattern rather than reusing the email executor.

Missing at the initial review: customer enrollment and passkey registration; mappings between workspaces, principals, and wallets; provider policy synchronization; protected agent credentials; transaction preparation; durable signing and broadcast jobs; nonce management; chain reconciliation; wallet UI; and recovery and offboarding flows. The legacy effects route remains unavailable or explicitly simulated; it is not a working payment/signature executor.

## Trust and ownership model

1. Map each workspace to one verified Turnkey suborganization. Every row, lookup and job is workspace-scoped; never accept an arbitrary provider org/wallet identifier as authorization.
2. Distinguish human, agent and service principals. A human and their agent have separate provider users and wallets. These are workspace operational wallets, not a promise of private personal custody; disclose customer-root override and provider metadata visibility.
3. Reserve root for explicitly enrolled customer recovery owners. Ordinary Hermes Admin promotion must not automatically add root authority. Keep day-to-day wallet administration on scoped non-root credentials. Confirm the initial recovery participants and threshold during setup; never secretly install a Hermes fallback root.
4. WorkOS sign-in establishes application identity, not Turnkey signing authority. Bind a verified passkey enrollment challenge to workspace, user, nonce, expiry and allowed origin. Root credentials never reach Hermes or an agent runtime. Validate recovery and passkey origin configuration before storing value.
5. Agent request credentials stay in an encrypted signing service and never enter runtime prompts, tools, logs or traces. Such credentials still confer signing power even though Turnkey holds wallet private keys. Separate parent provisioning identity, workspace onboarding identity and agent signing identities.
6. Default to customer-authorized onboarding. Do not grant Hermes broad CREATE_USER rights until live tests prove that it cannot create a user with privileged tags or replacement credentials. API parameter presence is not proof those fields are expressible in a policy.
7. Hermes manages business approvals. Turnkey enforces a smaller independent boundary: exact wallet/principal, chain, asset/function/recipient, amount and fee limits. An Admin changing an application role does not instantly change provider authority.
8. **Every agent payment needs a human, enforced by Turnkey (Brian, September 28).** An agent wallet's payment policy has a consensus of the agent *and* a member holding the finance role. The agent's signing request waits in Turnkey (`CONSENSUS_NEEDED`); the Inbox **Approve** is that member's passkey approval of the exact pending activity (`approveActivity` with its fingerprint). Approvals recorded only in Hermes, by Hermes's service identity, or by members without the role release nothing. Hermes approval routing still decides who is asked and how many approvals are needed; Turnkey guarantees no agent payment is signed without a qualifying human.
9. **Member wallets are in the first version (Brian, September 28).** Each member has their own wallet bound to them by a per-member policy, alongside agent wallets and the workspace wallet.

## Ordered implementation

### 0. Establish a trustworthy provider test

Reuse `/Users/gia/Documents/Codex/2026-09-12/hermes-interview/outputs/turnkey-spike` rather than making another competing wallet experiment.

The spike now tests the product's shape (September 28 evening):

- Base Sepolia USDC `transfer`, read through an uploaded ABI: wallet, chain, token contract, `function_name == 'transfer'`, allowlisted `contract_call_args['to']`, capped `contract_call_args['value']`, zero ETH value, gas and `max_fee_per_gas` limits. USDC `approve` and plain ETH are expected to be refused.
- Agent payments: pending until approved; Hermes's approval and a non-finance member's approval do not release it; a finance member's approval does, and the signed bytes and signer are verified against the request. Admin grant and revocation of the finance role change who can approve.
- Member wallets: each member signs only their own wallet within a member cap; the agent, Hermes and other members are refused.
- Hermes escalation: writing a policy, editing a tag, signing, and creating a user already tagged finance are all expected to be refused.
- Fixed two defects in the earlier hardening. `@turnkey/sdk-server` returns rejected and consensus-needed activities as data rather than throwing, so outcomes now come from the returned activity's id and status; thrown errors are always inconclusive and print only class and code. The fee limit used `gas_price`, which does not bound EIP-1559 transactions; it now uses `max_fee_per_gas`.
- Kept: explicit `TURNKEY_RUN_TEST_SPIKE=1` opt-in, no `--keep`, cleanup in `finally`, signed bytes never logged or broadcast. Four policies, inside the lower-tier limit. TypeScript check and six offline tests pass.

Remaining before trusting the experiment: Brian's Turnkey account and API key, then a first live run. That run must settle three things before PR208 merges: whether Hermes's user-create permission can mint a finance-tagged user (this decides Hermes-driven versus Admin-passkey onboarding), whether `contract_call_args` addresses compare as lowercase hex, and how Turnkey reports policy refusals. The onboarding permission in the spike is a probe, NOT approved for the product.

### 1. Wallet enrollment and addresses

Create an additive, feature-gated provider module and migration using the next available migration number at implementation time:

- Workspace wallet configuration: provider organization, enrollment state, customer-root identity reference, current/desired policy version, last verified time, suspension reason.
- Wallet principals: workspace, principal kind, user/agent ID, provider user, credential reference and lifecycle status. Enforce exactly one applicable identity reference.
- Wallet accounts: principal, provider wallet/account, chain and verified address; unique natural keys scoped to workspace and network. Never derive ownership from display names.
- Provisioning operations: durable intent, idempotency/correlation key, provider activity ID, attempts, ambiguous state and reconciliation evidence. A network timeout must not blindly create another suborganization/wallet.
- Policy assignments/changes: desired and confirmed version plus digest, initiating Admin and passkey ceremony, provider activity and failure reason.

Connect Admin wallet setup, Members wallet identity/status, and agent wallet status. Show Not set up / Needs owner approval / Provisioning / Ready / Suspended / Needs reconciliation honestly. Readiness requires provider read-back, verified owner binding, completed enrollment and matching policy digest. Preserve the current Admin navigation (Workspace, Agents, Connections); place wallet setup under Connections, member addresses in Members and money permissions alongside Roles. Avoid creating another top-level navigation system.

### 2. Mainnet approval preparation

Start with one narrow action: Base mainnet USDC transfer to an explicitly allowed recipient. Confirm authoritative chain/token deployment and decimals before enabling it. Exclude arbitrary calldata, token approvals/permits, raw hash signing, typed-data signatures, contract deployment and other chains.

Prepare a canonical immutable intent binding workspace, source principal/account, chain, token contract, recipient, integer base-unit amount, call data, nonce, gas/fee ceiling, expiry, simulation result, policy version and approval revision. Decode the contract call: transaction native value is often zero for USDC and cannot bound the token amount. Amount math uses integers, never floating point.

Show asset/amount, recipient, source wallet, network, fee ceiling, purpose and evidence in the Inbox. For agent payments the Inbox approval is the finance member's passkey approval of the pending Turnkey activity, so the exact transaction is submitted to Turnkey when the approval request is created, and the approval screen shows the decoded bytes Turnkey will sign. A changed recipient, amount, calldata, chain or authority invalidates approval. Fee/nonce refreshes must remain within the explicitly approved envelope or request fresh approval. Existing requester/self-review/role routing rules remain authoritative; do not reduce them to make a single-owner demo pass.

### 3. Governed signing and execution

Implement a dedicated wallet operation ledger; do not turn the generic simulated effects endpoint into an unrestricted signer.

States: prepared → awaiting_approval → approved → signing → signed → submitting → submitted → confirmed, with expired/rejected/cancelled/failed/ambiguous branches. Signing is not payment; submission is not confirmation.

Store the pending Turnkey activity id and fingerprint on the operation, and record which member's passkey approved it. The operation stays awaiting_approval until Turnkey reports the activity COMPLETED; a Hermes-side approval alone never advances it. Claim an operation under a short transaction, check current member/agent permissions, approved revision/hash, expiry and provider policy version, then release DB locks before calling Turnkey. Persist provider activity IDs and reconcile uncertain outcomes before any retry. Reserve nonces per wallet/chain. Re-broadcast the identical signed transaction where safe; never automatically produce a replacement payment after an unknown outcome. Store sensitive signed bytes outside user-visible logs and agent context with tightly scoped access.

Before broadcast, verify the signed payload matches the approved envelope and recover its signer. Recheck revocation/suspension. Track transaction hash, chain receipt, failure and confirmations/reorganizations. A human-facing signed result must not be labelled paid.

Mainnet activation needs a connected wallet and a specific approved transfer: sender, recipient, asset, amount and maximum fee. Brian's mainnet choice establishes the target network; it does not fill in those missing transaction details. No automatic funding or sweeping existing AgentCash wallets.

### 4. Roles, revocation and recovery

- Model money permissions separately from a role's label. Map only needed financial capabilities to Turnkey tags; keep business workflow roles in Hermes.
- Render desired versus confirmed permissions. Provisioning failure leaves signing disabled, not half-authorized.
- For offboarding or role removal, immediately suspend Hermes execution and cancel eligible queued work; then revoke provider access and verify it. Block reenabling until reconciled. Lost connectivity does not justify pretending offboarding completed.
- Customer-root signatures may still act outside Hermes. Offboarding root owners requires the current root quorum; role removal alone cannot remove custody.
- Existing signatures cannot be cryptographically revoked. Document remaining signed/in-flight transactions and residual exposure; short expiries and nonce controls help but are not universal cancellation.
- Exercise recovery using customer-held authenticators without adding a Hermes root key. Never delete a funded wallet as a member-removal side effect.

### 5. Release gates

Local tests: tenant crossover, member/agent identity mismatch, role escalation, mutation after approval, demotion during signing, duplicate claims, nonce collisions, ambiguous provider responses, provider policy drift, pending consensus, quota exhaustion and unavailable dependencies.

Real Turnkey tests: passkey enrollment and origin binding; parent cannot sign in child org; wrong wallet/chain/recipient/value/call/fee denied; raw-message and token-approval bypasses denied; non-root service cannot grant roles/change root/export wallets; human grant/revoke produces verified provider changes. Include positive controls so outages cannot masquerade as successful denial tests.

Product acceptance: two genuinely distinct humans in one workspace plus a second workspace; distinct human/agent addresses; correct evidence and thresholds in Inbox; one specifically approved small mainnet USDC transfer through confirmed receipt; replay fails; policy removal stops new signatures. Do not fake the second reviewer, financial transaction, provider acceptance or confirmation.

Deploy behind disabled provider/signing/broadcast flags. Existing email, member setup and AgentCash paths stay unchanged. Enable one workspace after provider checks; separately authorize/enable mainnet execution after enrollment and exact-transaction acceptance. Rollback disables new work and continues reconciliation of in-flight operations; it does not undo submitted transactions.

## Capacity and commercial checkpoint

Turnkey currently documents 100 users and 100 wallets per suborganization, 10 tags, no nested suborganizations, and five policies on lower tiers versus up to250 on Enterprise. Humans, agents and services all consume capacity. A 50-human workspace with an agent per person plus a service identity exceeds100 users. One-suborg-per-workspace is a bounded initial model, not support for indefinite scale.

With member wallets in v1, each workspace needs one policy per member wallet plus one per agent payment policy (the agent's identity is in its consensus). Two members and one agent fit the five-policy lower tier; a larger pilot needs Enterprise (250). Measure generated policy count and onboarding capacity before promising a seat count. Seek vendor-confirmed limits or evaluate multiple sibling security domains for larger customers; do not silently change isolation or buy Enterprise. A small pilot can fit lower-tier limits, so “Enterprise is immediately required” is too strong. Signing can incur provider fees even with no blockchain broadcast; verify remaining allowance before live experiments.

## Sources and remaining blockers

Primary sources checked September28:

- [Turnkey organizations](https://docs.turnkey.com/features/organizations): tenant isolation, parent read access and organization features.
- [Root quorum](https://docs.turnkey.com/features/users/root-quorum): root bypass and separation from daily credentials.
- [Policies](https://docs.turnkey.com/features/policies/overview) and [policy language](https://docs.turnkey.com/features/policies/language): independent consensus/condition fields, explicit denials, activity targeting and parsed transaction inputs.
- [Resource limits](https://docs.turnkey.com/reference/resource-limits) and [pricing](https://www.turnkey.com/pricing): current quotas and signature pricing. Recheck before purchase/activation.

Not yet verified: Turnkey account/key availability, actual policy acceptance, customer root/recovery participants, approved initial spending ceilings/recipient list, mainnet token deployment binding and full multi-party execution. Claude's UI currently shows Turnkey's sign-in page; this is not proof that no account exists. No API key contents were accessed.
