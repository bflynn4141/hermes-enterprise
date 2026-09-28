# Workspace wallets

Wallet setup starts in **Admin → Connections → Wallets**. An Admin can request
enrollment for the workspace, an active member, or that member's agent. Requests
are durable and idempotent; requesting enrollment again does not create another
identity. A regular member can read their own enrollment status and their owned
agents' status, but cannot request enrollment or read other members' wallets.

## Current implementation boundary

This first increment records enrollment requests, not provider wallets. Every
request remains **Needs owner setup**, with no address, until a later provider
enrollment and verification flow exists. It does not contact Turnkey, create a
suborganization, collect keys or passkeys, sign a transaction, or transfer funds.
The feature defaults off. Enabling it allows enrollment requests only.

Set `TURNKEY_WALLETS_ENABLED=1` only in a deployment selected for enrollment
testing. For an isolated pull-request preview, add `--wallets` to the preview
command. Omission keeps the feature disabled. No Turnkey credentials are needed
or consumed by this increment.

The target network is Base mainnet and the initial asset is native USDC. The
transfer-intent module validates and hashes a narrow, exact transfer envelope;
it is not yet connected to the Inbox or an executor. Local tests establish the
validation rules, not Turnkey policy acceptance or a successful mainnet transfer.

## Custody and approvals

One Turnkey suborganization will represent a workspace. Workspace, member, and
agent wallets remain distinct. Customer recovery owners will control the root
quorum; changing someone's Hermes Admin role must not grant root custody.
Hermes sign-in and a saved enrollment request do not establish signing authority.

Before signing becomes available, implementation must bind verified provider
identities and addresses to these records, verify the customer root ceremony,
reconcile provider policies, and connect immutable transaction intents to the
existing guarded Inbox approval flow. Approval must remain separate from signing,
broadcast, and confirmed payment. A provider timeout must never trigger blind
recreation or replacement payments.

The [implementation plan](plans/2026-09-28-turnkey-workspace-wallets.md) records
the remaining provider checks, isolation tests, enrollment, permission changes,
and mainnet acceptance gates. Existing AgentCash wallets are not imported or
funded by this feature.
