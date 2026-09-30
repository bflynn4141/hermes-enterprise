# Member wallet access

Member wallet creation uses the existing customer's workspace owner passkey.
The resulting wallet remains under the customer's workspace custody. A Hermes
member association is an application record, not a Turnkey user or signing grant.

## Implemented

- `GET /w/:ws/members/:id/wallet-access` returns verified account state separately
  from the latest proposed operation. Admins may inspect any member; other
  members may inspect only themselves.
- `POST .../wallet-access/proposals` accepts `create_wallet`. A fresh Admin
  sign-in creates one durable, immutable proposal with a five-minute expiry.
  Concurrent retries reuse the open operation. Its snapshot binds the workspace,
  member identity and status, current owner, provider organization and root
  credential to the exact provider request bytes.
- The current owner receives the exact body, WebAuthn challenge, RP ID and
  credential ID. `POST .../operations/:operationId/submit` accepts that proposal's
  hash and the owner's WebAuthn stamp. The server checks current Admin and owner
  status, snapshot, expiry, credential, origin, RP hash and user verification.
  Turnkey verifies the actual signature against its enrolled credential.
- `CREATE_WALLET` is the only child-organization mutation supported here. The
  server forwards the exact owner stamp in `X-Stamp-Webauthn`. The parent API key
  performs read-back queries only; it never signs this mutation.
- Ready requires provider read-back of the unique operation wallet name and one
  account with matching organization, wallet ID, Ethereum curve, derivation path
  and address format. Returned addresses are validated and normalized. A
  successful submit response alone never makes the account Ready.
- Pending operations can be cancelled. Expired or changed proposals cannot be
  submitted. Ambiguous outcomes remain locked against retries. The reconciliation
  endpoint reads the activity and wallet back without submitting another create.
  Not finding a wallet after an ambiguous response does not authorize a retry.

Provisioning is disabled unless `TURNKEY_MEMBER_WALLETS_ENABLED=1`, the existing
wallet/provisioning switches are also enabled, provider configuration is valid,
and the workspace has a verified active Admin owner. No deployment enables the
new switch automatically. Tests use an in-process provider fixture; real Turnkey
creation and physical passkey use have not been validated for this change.

## Payment authority and removal

A new wallet grants no member payment authority. The provider user mapping is
reserved but remains null until a separate member authenticator enrollment is
implemented. Finance tag changes also need a verified provider approval policy.
Grant/revoke payment-review proposals fail closed with
`member_payment_policy_required`; the API returns unknown payment-review state,
never an inferred confirmation based on the business Finance role.

Once a workspace has provider custody or a setup in progress, ordinary member
role edits, bulk role-holder changes and payment-rule changes cannot change
payment authority. The guard compares base and amount-threshold bands separately,
including group coverage for one-from-each quorums. It returns
`wallet_payment_permission_required`. Nonfinancial role edits and pre-custody
business workflows keep their existing behavior.

The same guard blocks the actual payment effect confirmation endpoint in custody
workspaces until a verified provider grant exists. This closes alternate paths
through invitation, provisioning or identity-provider role assignments. Invoice
and agreement draft review remain business approvals; they do not release funds.
No payment signing, broadcast, policy activation or paid-tier activation is added.
Role spending settings remain drafts as described in [Role spending](ROLE-SPENDING.md).
Account-wide free-tier usage is not measured or asserted by these APIs.

Removing an ordinary member revokes application access through the existing
transaction. A pending wallet proposal becomes changed. An in-flight creation
can still reconcile and retain the owner-controlled account for records; the UI
must not describe that as a member provider permission or claim provider access
was revoked. Ordinary removal/demotion of the current or pending wallet owner is
blocked with `wallet_owner_transfer_required`. Owner transfer is not implemented.
External identity-provider revocation still closes application access and marks
wallet custody as needing attention; it never invents a provider root revocation.

## Provider references

The implementation follows Turnkey's [WebAuthn stamp format](https://docs.turnkey.com/api-reference/overview/stamps)
and [official stamper](https://github.com/tkhq/sdk/blob/main/packages/webauthn-stamper/src/index.ts):
the challenge is the UTF-8 bytes of the request's SHA-256 hexadecimal string.
The stamp header contains JSON, without an additional base64 encoding.

[Create wallet](https://docs.turnkey.com/api-reference/activities/create-wallet),
[list wallets](https://docs.turnkey.com/api-reference/queries/list-wallets) and
[list wallet accounts](https://docs.turnkey.com/api-reference/queries/list-wallet-accounts)
define the request and read-back fields. Wallet accounts include organization ID,
wallet ID, curve, path format, path, address format and address. `list_wallets`
lists all organization wallets; account read-back requests up to 100 and fails
closed unless exactly the one expected account is returned.
