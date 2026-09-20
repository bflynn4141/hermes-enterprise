# Cloud management integration

The connection implementation begins with the protocol boundary in
`apps/worker/src/hermes-cloud/management.ts`. It discovers Nous OAuth endpoints,
constructs an S256 authorization URL, refreshes an existing management grant,
and initializes MCP to retrieve allowlisted management schemas. The separate
`apps/worker/src/hermes-cloud/lifecycle.ts` adapter can list and reconcile agents
through an exact read-only wrapper. Paid tool dispatch is intentionally not
exported until the durable job executor owns a tenant-scoped atomic claim. The
adapter is not wired to invitations. The admin connection is wired to
encrypted storage and Organization Settings. Local member-setup jobs are
feature-gated; invitation delivery and paid provisioning are not enabled by
this work.

The independent shared operation contract in `packages/shared/src/member-provisioning.ts`
defines validated preparation/delivery/cancellation states, concise UI presentation,
and a recovery-step planner. Migration `0061_member_provisioning_operations.sql`
and `apps/worker/src/member-provisioning/service.ts` now persist and execute the
local, revision-checked part of that state machine. Unknown creation or delivery
outcomes require reconciliation; they do not authorize replay. Email states
require verified preparation.

## Public protocol preflight

With the repository's required Node 26 runtime:

```sh
node apps/worker/scripts/cloud-management-preflight.mjs
```

This checks the live public resource and authorization metadata. It prints
public endpoints and whether the server advertises client credentials; that
advertisement does not prove service-account access for this deployment.

For an explicitly authorized management connection, the same script accepts
`HERMES_CLOUD_PREFLIGHT_ACCESS_TOKEN` and `HERMES_CLOUD_PREFLIGHT_SCOPE` from the
process environment. Use the approved secret injection mechanism, not command
arguments or shell-history literals. The script will then initialize MCP and
list argument schemas only. It does not query instances, spend, or billing data.
It refuses an inference-only grant. Do not use Enterprise runtime discovery
bearers, API Server keys, or provider inference credentials here.

Output schemas are external data and do not authorize lifecycle calls. Cloud's
authenticated `agent(action='create')` schema has no idempotency key. A persisted
`creating` label alone cannot prevent two workers from racing. The future paid
executor must first win a tenant/workspace/operation/organization-connection
one-use row transition; losers and every later wake use the separate read-only
exact-name reconciliation path. After paid `tools/call` is dispatched, every
response other than a fully validated exact-name result is outcome-unknown and
may not be replayed automatically.

## Authenticated contract verification — September 19, 2026

Using the existing organization-bound OAuth session, read-only live discovery
verified five tools: `agents`, `agent`, `team_gateway`, `service_credentials`
and `usage`. No secrets, identifiers, names or dollar amounts were recorded.

- `agents` successfully returned the organization inventory; `get`, `status`
  and `cost_estimate` returned the documented bounded shapes.
- `usage` successfully returned the organization ledger and complete daily
  credit/debit totals. This verifies organization billing attribution, not a
  current spend allowance or sufficient balance.
- `service_credentials(action='list')` succeeded for the organization and
  returned no existing credentials. The live schema supports owner/admin
  `create`, `list` and `revoke`; a created credential uses OAuth
  `client_credentials` for unattended short-lived management tokens.
- `agent(action='create')` accepts `name`, `size`, optional `region`, optional
  `model` and optional environment variables. It has no idempotency field. No
  create wrapper is exported in the connection slice.

The organization-bound refresh grant already supports background work after the
one-time browser authorization, so an additional machine credential is not a
prerequisite for the first executor. Creating one automatically would introduce
another one-time-secret operation and is intentionally deferred.

The authenticated contract still exposes no governed plugin install, profile
import, or arbitrary configuration action. `update_env` and `update_image` are
not sufficient to prove the reviewed Enterprise bridge and policy are present.
Accordingly, lifecycle, usage and unattended-auth support are now verified, but
`automatic_setup_ready` remains false until governed bootstrap and readiness are
server-verifiable.

## Admin connection

Migration `0057_cloud_management.sql` adds isolated management connection and
authorization-attempt tables. The agent role has no access to either table.
OAuth attempts and durable organization grants use separate authenticated
encryption namespaces; neither can authenticate as the other or as a provider
inference key. Active envelopes participate in namespace-preserving KEK rotation.
No inference credentials are reused.

`GET /w/:ws/cloud/connection` returns safe status only. Admin-only
`POST /w/:ws/cloud/connection/start` requires CSRF, allowed Origin and recent
authentication; registers a public PKCE client and returns the official Nous
authorization URL. The callback binds one-use state to workspace, admin and
authenticated session. It stores the refreshable grant encrypted, verifies the
organization through the authenticated account endpoint and reads MCP tool
schemas only. An unverifiable/mismatched replacement cannot overwrite an
existing organization-bound connection. Provider details never reach the UI.

The release owner must configure `HERMES_CLOUD_MANAGEMENT_ENABLED=1` and an
HTTPS origin in `HERMES_ENTERPRISE_PUBLIC_URL` that is also in `ALLOWED_ORIGINS`.
This enables connection only, not provisioning or spending. No flags were
changed by this implementation. Dynamic registration/account responses are
contract-tested fixtures until the first hosted authorization succeeds.

Settings intentionally reports `automatic_setup_ready=false` even after a
verified connection. Connected proves organization attribution and tool
discovery at authorization time, not billing linkage, ongoing health or native
role readiness. A first-time unverifiable connection remains explicitly
unverified and can be reconnected. Users do not enter tokens or instance IDs.

## Remaining integration

1. Release the connection slice and complete the already-authorized admin
   management connection in Enterprise; re-run authenticated contract
   verification through the stored workspace grant.
2. Integrate background health/refresh under a connection lock and atomically
   store token rotation; add disconnect/revocation before enabling new work.
3. Obtain a supported governed plugin/profile bootstrap contract from Nous, or
   publish the reviewed Enterprise bridge in an approved image/profile. Instance
   creation and Enterprise readiness remain distinct.
4. Complete the authenticated lifecycle executor behind the durable member-setup
   operation. This slice may reserve only compatible, pre-existing local capacity;
   it must fail closed as `cloud_contract_unverified` when the stored Cloud grant
   cannot prove the required lifecycle/bootstrap contract. Paid creation remains
   unavailable until a separate reviewed executor owns an atomic, tenant-scoped,
   one-use provider-dispatch claim.
5. After exact role readiness, add a separately reviewed transactional delivery
   handoff. The compact Members states are connected, but this runner does not
   queue WorkOS email and must not present setup completion as delivery.

Live read-only validation: public metadata, authenticated schemas, selected
organization billing attribution and read-only agent/usage operations passed.
Governed bootstrap and paid creation were not attempted. The member-setup behavior is behind
`HERMES_MEMBER_PROVISIONING_ENABLED`, which defaults off. No deployment flags or
existing invitation behavior changed.

Sources: [Cloud MCP guide](https://hermes-agent.nousresearch.com/docs/guides/manage-hermes-cloud-with-mcp),
[Business billing](https://portal.nousresearch.com/business),
[OAuth metadata](https://portal.nousresearch.com/.well-known/oauth-authorization-server).
