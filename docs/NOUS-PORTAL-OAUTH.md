# Nous Portal OAuth

Hermes Enterprise uses the official Nous **inference** device-authorization
contract. It does not reuse the similarly named dashboard login contract.

WorkOS remains the employee identity and workspace-authorization boundary. It
proves that the initiator is a current workspace Admin and recently
re-authenticated; it never exchanges a WorkOS token for a Nous token. The Admin
then authenticates separately with Nous Portal to grant inference access to the
workspace. Members and agents use that workspace connection without seeing the
credential or needing individual Nous accounts.

## Contract

The implementation follows the current official Hermes Agent source:

- `POST https://portal.nousresearch.com/api/oauth/device/code`
- official public device client `hermes-cli`, or a client provisioned by Nous
  for this deployment
- scope `inference:invoke`
- user approval at the returned `verification_uri_complete`
- polling `POST /api/oauth/token` with
  `urn:ietf:params:oauth:grant-type:device_code`
- refresh at `POST /api/oauth/token`, with the current rotating refresh token
  in `x-nous-refresh-token` and `grant_type=refresh_token` plus `client_id` in
  the form body

The Portal dashboard authorization-code client (`agent:{instance_id}`) is not
used. Its `agent_dashboard:access` token cannot authorize model inference.

## Configuration

Official Hermes Agent itself uses the public device-code client id
`hermes-cli`. The Portal currently accepts it with `inference:invoke`, so the
staging environment uses it for the first end-to-end proof:

```text
NOUS_PORTAL_OAUTH_ENABLED=1
NOUS_PORTAL_OAUTH_CLIENT_ID=hermes-cli
```

This is the client **identifier**, not a credential copied from
`~/.hermes/auth.json`. Running `hermes auth add nous` locally is unnecessary
and would create a separate local grant. The Enterprise Worker runs the same
device-code contract directly and stores its own encrypted workspace grant.

Before production, prefer a separately provisioned client id so Nous can
attribute, support, rate-limit or revoke the Enterprise application without
coupling it to every Hermes CLI installation. The public client is therefore a
staging proof path, not the final production ownership boundary.

When either is absent, `POST /w/:ws/provider-connections/nous/start` returns a
typed `unavailable` result with reason `oauth_not_configured`. The client identifies the deployment limitation and
reveals the manual workspace-key fallback. It never invents an authorization
URL or falls back to a dashboard token.

`NOUS_PORTAL_OAUTH_ENABLED=1` is declared for staging and production. Staging
also declares `hermes-cli`. Production remains unavailable until a separately
provisioned client id is installed:

```sh
pnpm --filter @hermes/worker exec wrangler secret put NOUS_PORTAL_OAUTH_CLIENT_ID --env production
```

Until production has that client id, the same screen deliberately exposes the
manual workspace-key fallback.

## Storage and lifecycle

Device codes and access/refresh bundles use the existing per-row envelope
encryption with workspace and row identifiers in AES-GCM AAD. API responses
expose only connection kind, status, and expiry. Model calls resolve the access
token inside the tenant transaction. Near expiry, the Worker holds the row
lock, redeems the rotating refresh token once, persists the newly encrypted
bundle, and only then returns the access token to the provider adapter. A
terminal refresh failure marks the connection invalid so the old token is not
replayed.

After authorization, the Worker asks the authenticated Nous
`/api/oauth/account` endpoint for display-safe user and organisation metadata.
When available, Admin Settings shows the Nous email or user id and organisation
that pays for the workspace. The `provider_key.added` event separately records
the WorkOS user who initiated the connection. If an older Portal deployment
does not expose account metadata, inference remains available and Settings
labels the grant as unattributed rather than trusting unverified token claims.

Fresh WorkOS authentication is required when the device grant starts. Polling
continues for the grant lifetime with the same active WorkOS user, current
Admin role and initiating-user check; it does not expire merely because Portal
approval takes longer than the five-minute step-up window.

One live `nous_portal` connection exists per workspace. A successful reconnect
atomically revokes and zeroes the previous encrypted row while preserving it as
usage history. Removing the connection uses the existing provider removal
route.
