# Workspace wallets

Wallet setup starts in **Admin → Connections → Wallets**. An Admin can request
enrollment for the workspace or agents. Member access lives in **Members →
Manage → Wallet access**. Requests
are durable and idempotent; requesting enrollment again does not create another
identity. A regular member can read their own enrollment status and their owned
agents' status, but cannot request enrollment or read other members' wallets.

## Current implementation boundary

Wallet features default off. Workspace and agent enrollment remain saved
requests. Owner setup creates a passkey-controlled Turnkey suborganization when
explicitly configured. Member wallet creation has an additional opt-in flag and
exact owner review; see [Member wallet access](MEMBER-WALLET-ACCESS.md).
No flow here signs a payment or transfers funds.

Set `TURNKEY_WALLETS_ENABLED=1` only in a deployment selected for enrollment
testing. For an isolated pull-request preview, add `--wallets` to the preview
command. Omission keeps the feature disabled. No Turnkey credentials are needed
or consumed by enrollment requests.

The target network is Base mainnet and the initial asset is native USDC. The
transfer-intent module validates and hashes a narrow, exact transfer envelope;
it is not yet connected to the Inbox or an executor. Local tests establish the
validation rules, not Turnkey policy acceptance or a successful mainnet transfer.

## Wallet owner setup

An Admin makes their passkey the owner of the workspace's wallets from
**Admin → Connections → Wallets → Wallet owner**. The Worker issues a
single-use, five-minute WebAuthn challenge; the browser creates the passkey
(biometrics or a PIN required); the Worker checks the ceremony came from this
deployment for that exact challenge, then asks Turnkey to create the workspace's
sub-organization with that passkey as its only root user. Email, SMS and OTP
recovery are disabled on the sub-organization, and Hermes's own API key is never
added to it.

Hermes then reads the sub-organization back with the parent organization's
read access. It shows **Owner verified** only when Turnkey reports a root
quorum of exactly one user, threshold one, with no API keys and exactly the
enrolled passkey, and no other users. Anything else is **Needs attention** and
wallets stay off.

A lost or unclear answer from Turnkey never triggers a second create. The
attempt is recorded as needing a check, and **Check setup** looks the
sub-organization up by its unique name (`hermes-ws-<workspace>-<attempt>`). Only
when it is still absent two minutes after the request ended is the attempt
closed as not created, so a new one can start.

Configuration (all required, or the owner card says setup is not configured):

- `TURNKEY_WALLETS_ENABLED=1` and `TURNKEY_PROVISIONING_ENABLED=1`
- `TURNKEY_PARENT_ORG_ID` and `TURNKEY_API_PUBLIC_KEY` (variables) and the
  `TURNKEY_API_PRIVATE_KEY` secret: the parent organization's API key, used only
  to create and read sub-organizations
- `TURNKEY_PASSKEY_RP_ID`: the WebAuthn relying party, normally the app's host.
  Passkeys only work on this domain and later approve payments, so it must not
  change once owners exist. At least one entry in `ALLOWED_ORIGINS` must be on it.
- In the Turnkey dashboard, add the app's origin to the parent organization's
  WebAuthn origins feature (`FEATURE_NAME_WEBAUTHN_ORIGINS`).

Verified so far against a faithful fake of Turnkey's API, a real browser passkey
(Chrome's virtual authenticator) and the mock app; not yet against Turnkey
itself.

## Custody and approvals

One Turnkey suborganization will represent a workspace. Workspace, member, and
agent wallets remain distinct. Customer recovery owners will control the root
quorum; changing someone's Hermes Admin role must not grant root custody.
Hermes sign-in and a saved enrollment request do not establish signing authority.
Every agent payment will need a member with the finance role to approve the exact
pending Turnkey request with their passkey; an approval recorded only in Hermes
never releases a signature. An owner-controlled wallet can be associated with a
member; that association does not enroll a provider user or grant payment access.

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

## Role spending drafts

Admin → Roles → a role → Spending limits saves proposed per-transfer USDC caps,
recipients and human approvals. Daily/monthly values record future intent only.
All saved drafts explicitly remain inactive. Saving never calls Turnkey or
consumes signatures. See [Role spending](ROLE-SPENDING.md) for current free-tier
constraints and the remaining activation prerequisites.
