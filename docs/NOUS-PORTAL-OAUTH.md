# Nous Portal OAuth

Hermes Enterprise uses the official Nous **inference** device-authorization
contract. It does not reuse the similarly named dashboard login contract.

## Contract

The implementation follows the current official Hermes Agent source:

- `POST https://portal.nousresearch.com/api/oauth/device/code`
- client id provisioned by Nous for this deployment
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

Set both variables in an environment only after Nous provisions its client:

```text
NOUS_PORTAL_OAUTH_ENABLED=1
NOUS_PORTAL_OAUTH_CLIENT_ID=<provisioned client id>
```

When either is absent, `POST /w/:ws/provider-connections/nous/start` returns a
typed `unavailable` result with reason `oauth_not_configured`. The client identifies the deployment limitation and
reveals the manual workspace-key fallback. It never invents an authorization
URL or falls back to a dashboard token.

## Storage and lifecycle

Device codes and access/refresh bundles use the existing per-row envelope
encryption with workspace and row identifiers in AES-GCM AAD. API responses
expose only connection kind, status, and expiry. Model calls resolve the access
token inside the tenant transaction. Near expiry, the Worker holds the row
lock, redeems the rotating refresh token once, persists the newly encrypted
bundle, and only then returns the access token to the provider adapter. A
terminal refresh failure marks the connection invalid so the old token is not
replayed.

One live `nous_portal` connection exists per workspace. A successful reconnect
atomically revokes and zeroes the previous encrypted row while preserving it as
usage history. Removing the connection uses the existing provider removal
route.
