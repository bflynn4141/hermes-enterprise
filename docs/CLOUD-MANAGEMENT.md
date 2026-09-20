# Cloud management integration

The first implementation slice is the read-only protocol boundary in
`apps/worker/src/hermes-cloud/management.ts`. It discovers Nous OAuth endpoints,
constructs an S256 authorization URL, refreshes an existing management grant,
and initializes MCP to retrieve the `agents` and `agent` tool schemas. It never
calls either tool or creates an instance. The admin connection is wired to
encrypted storage and Organization Settings; invitation jobs and paid
provisioning are not enabled.

The independent shared operation contract in `packages/shared/src/member-provisioning.ts`
defines validated preparation/delivery/cancellation states, concise UI presentation,
and a recovery-step planner. It is scaffolding for a revision-checked durable job,
not an executor. Unknown creation or delivery outcomes require reconciliation;
they do not authorize replay. Email states require verified preparation.

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

Output schemas are external data. They must be reviewed before creating a typed
adapter; they cannot authorize a lifecycle call. No automatic create retry is
safe until the actual provider idempotency/reconciliation contract is known.

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
   management connection; inspect actual schemas and organization billing.
2. Integrate background health/refresh under a connection lock and atomically
   store token rotation; add disconnect/revocation before enabling new work.
3. Retrieve the actual Cloud schemas and verify a supported governed plugin and
   profile bootstrap. Instance creation and Enterprise readiness are distinct.
4. Add durable invite/provisioning operations and transactional outbox jobs,
   retaining exact reservation semantics, role-readiness gates and email ordering.
5. Connect the compact Members states. Only server-confirmed setup completion
   may queue WorkOS email; a generic live instance must not be marked ready.

Initial live validation: public metadata passed. Authenticated schemas, selected
organization billing association, governed bootstrap, and paid creation are not
verified by this slice. No deployment flags or existing invitation behavior change.

Sources: [Cloud MCP guide](https://hermes-agent.nousresearch.com/docs/guides/manage-hermes-cloud-with-mcp),
[Business billing](https://portal.nousresearch.com/business),
[OAuth metadata](https://portal.nousresearch.com/.well-known/oauth-authorization-server).
