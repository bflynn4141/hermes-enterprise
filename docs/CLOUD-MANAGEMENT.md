# Cloud management integration

The first implementation slice is the read-only protocol boundary in
`apps/worker/src/hermes-cloud/management.ts`. It discovers Nous OAuth endpoints,
constructs an S256 authorization URL, refreshes an existing management grant,
and initializes MCP to retrieve the `agents` and `agent` tool schemas. It never
calls either tool or creates an instance. It is not yet connected to routes,
credential storage, invitation jobs, or UI.

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

## Remaining integration

1. Register/connect a deployment OAuth client through an approved admin flow.
2. Store management credentials separately, envelope-encrypted and workspace
   scoped. Bind state and PKCE to the initiating admin and callback. Verify the
   selected Portal organization server-side. Refresh with a connection lock and
   atomically store token rotation; disconnect/revocation must stop new work.
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
