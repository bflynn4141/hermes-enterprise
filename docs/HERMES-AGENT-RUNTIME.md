# Official Hermes Agent runtime

Hermes Enterprise now has an execution adapter for the official Nous runtime,
pinned to `345cd2b057a452236de401d3534b8502a7465e8d` (package 0.21.3).
The Worker remains the enterprise control plane and system of record.

## Identity and state

One `agents.id` maps to one profile: `agent-<uuid>`. Each runs in a separate
process with a separate `HERMES_HOME`, OS home, session database and working
directory. The launcher refuses a second process on the same profile. Profiles
isolate application state; they are not an OS sandbox or a substitute for RBAC.

Sessions and runs retain enterprise `agent_id`. A run also records its runtime
kind, profile, native run/session IDs and attempt. Existing traces retain their
previous-runtime label; new official runs display `Hermes Agent`. Trace reads
remain restricted to the agent and sessions the viewer can access.

## Execution

1. The browser sends a turn through the existing authenticated Worker route.
2. The Worker validates membership, session ownership, model, limits and agent
   binding. It snapshots the native submission in Postgres, never in Workflow
   checkpoint payloads.
3. A Workflow submits `POST /v1/runs` with an attempt-specific idempotency key.
   The native session ID is the enterprise session ID. Hermes owns its continued
   transcript. Existing conversation messages seed the first native run.
4. Native text deltas feed one enterprise assistant message. Tool callbacks
   persist the real tool IDs, arguments and results in the existing trace rows.
5. Final message, usage, duration and events commit atomically. Hub delivery
   happens afterward; delivery failure does not turn completed work into failure.
6. Stop immediately reaches the native run. The app confirms terminal execution
   before showing Stopped, including a native failure caused by revoking tool
   authority after Stop. Human guidance uses native steer; unconsumed guidance
   carries into the next message. Human-context pauses use the composer to answer
   the same run. A persisted per-attempt clock excludes those waits from Worked.

The native SSE queue has **no replay**. Reconnection uses native run status and
final output; browser replay comes from durable enterprise events. No raw model
reasoning is required for the activity indicator.

### Streaming delivery and completion

The sole native SSE reader never awaits status, human controls, database writes
or hub delivery. It feeds independent, ordered preview and durable-checkpoint
lanes. The first chunk is eligible immediately; later chunks coalesce within
75 ms when a lane is available, with a trailing flush and 32,768-code-unit
frame limit. Each lane has at most one delivery in flight. Received response
text is capped at 4 Mi code units; queued tool/activity operations are capped at
256. Exceeding a bound fails explicitly and preserves received partial output.

For Hermes Cloud bindings, the long-lived connector hop is a conventional GET
SSE response on the same exact service-authenticated `/control` path used by
POST control operations. It commits headers with an immediate SSE comment,
asks intermediaries for identity encoding, and relays one complete native frame
per ASGI body write. This removes POST-response and compression thresholds from
the first-delta path without widening the connector's host, path or operation
allowlist. The legacy POST `events` envelope remains temporarily drainable by
an older Worker.

Tool activity and control reads serialize whole operations on the main database
client; production delta checkpoints use their existing dedicated connection.
Native completion wakes status reconciliation. If status wins the race, the
reader has a one-second tail-drain window before cancellation. Every received
durable checkpoint and queued database operation finishes before the final
transaction. Best-effort previews get at most 250 ms to drain; any queued
previews are discarded afterward. The client rejects previews that arrive
after the corresponding final has already been revealed.

The `hermes.stream` structured log contains run/attempt/trace identifiers,
relative times to first received native delta, delivered preview and committed
checkpoint, delta/character/preview counts, and the native stream end reason.
It contains no prompt, response, tool content or hidden reasoning. These are
Worker boundary timings, not provider time-to-first-token or browser paint
measurements. A logging failure cannot change the run outcome.

Disconnect recovery still uses authoritative final status. This repair does
not create a native replay journal or hide model latency with artificial typing.

## Tools and credentials

The official runtime loads a narrow enterprise plugin. The plugin also registers
reviewed, read-only enterprise skills. The Worker returns an agent-scoped
non-secret skill manifest before startup; the plugin verifies the assigned
package bytes against it and pins that text into every new session's system
prompt through Hermes's plugin prompt-section API (the pinned 0.21.3 release has
no `skills.auto_load`). Non-secret values travel in `skills.config`. It
gets runtime run and call IDs from native ContextVars, not model arguments. The Worker maps those IDs
to the current agent/run/attempt, then rechecks mode and tool permissions. A
repeated call returns its stored result; changed arguments under the same ID are
refused. Old attempts and stopped runs cannot execute tools.

The bridge uses the existing restricted Postgres `agent` role. It can read
workspace context/documents, prepare Inbox requests, write review notes and
propose context/instruction changes. Human approval, payments, signatures, role
changes and invitation authority remain in the enterprise routes.

Nous Portal supplies model inference. The native runtime calls an authenticated,
agent-scoped model proxy; the Worker resolves the workspace's current encrypted
Nous Portal key for each call. That key is separate from `HERMES_BRIDGE_SECRET`,
which authenticates the runtime process to the Worker. Provider keys are never
copied into profile configuration. Only the selected catalog model can be
called. Each profile executes one run at a time, enforced in the Worker and
native API.

## Running locally

See [the runtime launcher](../runtime/hermes/README.md) for install, start,
configuration and source-contract checks. Enable `AGENT_RUNTIME=hermes` and
provide `HERMES_BRIDGE_SECRET`; `HERMES_RUNTIME_AGENTS` contains fixed profiles
only. Unclaimed warm-pool identities use discovery grants and verified capacity;
after acceptance, invitee profiles resolve from encrypted dynamic bindings. Missing bindings fail
explicitly; there is no silent fallback to a chat loop.
Bindings default to `"release_ring":"stable"`. A dedicated rollout profile may
declare `"release_ring":"canary"` only when its launcher also sets
`HERMES_ENTERPRISE_RELEASE_RING=canary`; the Worker rejects any ring, contract,
terminal schema or official-source-pin mismatch before admitting a turn.
The legacy/scripted path remains available for existing deployments and offline
contract tests during rollout.

The first connected profile is Iris in the local workspace. The UI reports
Local execution, separately from the remotely served model. Existing sessions
resolve their location from the current profile binding too. Iris’s dedicated
state lives under `~/.he-runtime/44444444-4444-4444-8444-444444444444/`; the personal
`~/.hermes` installation is untouched.

## Staging acceptance and production limits

Staging now binds Iris to a managed Hermes Cloud profile through the authenticated
dashboard connector described below. The acceptance run on September 16, 2026
used WorkOS, a workspace Nous Portal OAuth grant, DeepSeek V4.1 Flash and the
official Hermes `0.21.3` runtime. The persisted run was scoped to Iris's agent ID,
reported `runtime_kind = hermes`, completed in 39 seconds with six governed tool
calls, and created no requests, decisions, effects or outbound communication.
The Traces UI displayed it as `Hermes Agent · work` under Iris.

Production-demo invitation delivery now requires a durable reservation on a
real, pre-verified warm-pool instance. The reservation is locked in the same
database transaction as the invitation; an exhausted pool returns an Admin
capacity error before WorkOS is called. Duplicate invitations reuse the same
reservation, withdrawal or authoritative expiration releases it, and resend
transfers it to the successor invitation.

Acceptance creates the member-owned Iris and consumes that exact reservation.
The instance already has its final enterprise workspace and agent IDs, scoped
runtime token, connector control secret, isolated AgentCash home, disabled
native cron, reviewed plugin, and dedicated wallet. Acceptance reuses that
permanent agent ID and atomically creates an envelope-encrypted dynamic binding
from the verified capacity record. No Cloud API call, profile mutation, restart,
retry job, or Admin action occurs in the member path; the returned bootstrap is
`ready`. There is no simulated, generic-Hermes, or Admin-bootstrap fallback.

The official Cloud management MCP uses an interactive OAuth/PKCE user session;
it has no separate API key or client secret for an unattended Worker. It also
cannot install the reviewed private plugin or apply the complete governed
profile as part of invitation acceptance. An operator therefore prepares and
pays for pool instances before registering them as capacity. The unsupported
JIT auto-provisioner was removed rather than retained behind a switch.
Automated replenishment stays out of scope until Nous exposes a supported
template/plugin bootstrap and non-interactive management contract. The application
never creates or funds Cloud instances or AgentCash wallets on the invitation
path. Workspace creation does not automatically start a Cloud runtime. A
native run keeps its process while waiting and is bounded by the adapter’s
55-minute execution window (60-minute Workflow step timeout). Multi-day human
waits need a durable suspend/resume lifecycle before production rollout. Inbox
proposals do not hold the runtime open while a reviewer decides.

Native shell, filesystem, browser and delegation tools are not enabled. MCP and
native cron remain off by default. For an explicit demo profile,
`HERMES_NATIVE_CRON_ENABLED=1` retains the official cron REST surface while
agent self-scheduling stays disabled, and `ENTERPRISE_MCP_SERVERS_JSON` enables
only named stdio servers with a required tool allowlist. The AgentCash shortcut
`HERMES_AGENTCASH_MCP_ENABLED=1` pins AgentCash 0.17.1 and exposes only `fetch`.
The plugin accepts only the Worker-supplied exact People Search URL, POST body,
and $0.15 cap; balance, discovery, schema inspection, StableSocial, alternate
paths and changed arguments are unavailable to the model. Its `AGENTCASH_HOME`
must be a dedicated funded directory, not a personal home. Before the paid
call, a `pre_tool_call` hook obtains an atomic one-use lease for the exact
native run and tool-call id. A different or second call is rejected before
payment. The `post_tool_call` hook forwards the response to the run-bound
Worker importer; contact data is discarded before the result can become Inbox
evidence. Members may use this only for the single `onboarding:`-keyed run on
their own attested pool Iris. Further paid searches remain Admin-authorized.
Without those gates, the launcher refuses nonempty native cron state, removes
native cron REST routes before binding, and makes native health fail if a job
later appears. Automatic memory extraction, background review and learning nudges
are disabled while enterprise ownership and retention integration is completed.
The official runtime still persists its session transcript. Production erasure,
backup and retention must cover that profile store as well as Postgres/R2 before
opening this execution path to hosted customer data. Dedicated profiles remove
the general bundled-skill catalog; the plugin pins only the reviewed, assigned
package into each new session's prompt. The only native skill tool retained is
`skill_view`, restricted by the plugin to the assigned package. Skill
listing, creation and self-editing remain disabled. See
[Enterprise-configured Hermes skills](./ENTERPRISE-SKILLS.md). Hermesmail remains
a concept address, not a provisioned mailbox.

Roll out the Worker before restarting a profile with this launcher. The launcher
loads its agent-scoped skill manifest from the authenticated Worker during
startup and deliberately fails closed if that endpoint is absent or invalid.
After the Worker is healthy, restart profiles so the new skill/config snapshot
takes effect; existing running profiles continue using their prior configuration.

Official references: [Runs API](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server),
[profiles](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md),
and [security](https://github.com/NousResearch/hermes-agent/blob/main/SECURITY.md).

## Hosted topology decision — September 16, 2026

The local profile is healthy, but it listens on `127.0.0.1`. A Cloudflare
Worker's loopback belongs to the Worker isolate, not to the developer's Mac, so
the deployed control plane cannot use the local URL directly. This is a network
boundary rather than a Hermes failure.

An authenticated Cloudflare Quick Tunnel to the unchanged official runtime was
verified from a Worker running on Cloudflare's network:

| Probe | Result |
| --- | --- |
| `GET /health` through the tunnel | `200`, Hermes Agent `0.21.3` |
| `GET /v1/capabilities` without a key | `401` |
| The same capabilities request with `API_SERVER_KEY` | `200`, including the durable Runs endpoints |

The tunnel proved the network diagnosis and adapter contract. It is not the
selected staging or production topology: the Mac must remain online, Quick
Tunnel URLs are ephemeral, and the runtime must be restarted in a separate
staging profile whose `enterprise_url` points back to staging. The temporary
tunnel and its Worker secrets were removed after the proof.

Hermes Cloud is the selected managed-hosting target. A Medium instance named
`iris-enterprise-staging` is running in the **Hermes Teams Demo** Portal
organization on Hermes `0.21.3`. The official Cloud management MCP provides
instance lifecycle and configuration tools through interactive OAuth/PKCE.
It does not issue a separate service API key or client secret. This authorizes
the Cloud management plane, not the agent's `/v1/runs` API, and is intentionally
absent from the invitation acceptance path.

The live Cloud hostname exposes the authenticated dashboard/Gateway. Its public
`/api/status` reports the loopback API Server as connected at
`http://127.0.0.1:8642`, but public `/health` and `/v1/capabilities` requests
fall through to dashboard HTML. Hermes Desktop reaches this host through a
human Portal OAuth session and the Gateway WebSocket; that is not a
server-to-server Runs credential. The Cloud instance therefore needs a narrow
connector from its authenticated dashboard origin to its loopback Runs API.

Cloudflare remains the Enterprise application control plane: it owns identity,
approvals, audit data, model credentials, and the reverse tool/model bridge. It
must not proxy a developer laptop or impersonate the agent runtime. A Cloud
instance binds to the Worker through the reviewed `enterprise_bridge` plugin.
The plugin contributes one fixed service-authenticated dashboard endpoint. It
accepts only capabilities, submit, status, events, stop and steer operations.
Control operations use POST; the event stream uses GET with a validated
`run_id` query on that same exact path, then forwards to the loopback API Server
with the native key. It is not an arbitrary path proxy.
`HERMES_RUNTIME_AGENTS` records an existing fixed profile endpoint with
`transport: "dashboard_connector"` and the separate per-agent control secret.
The native `API_SERVER_KEY` never leaves Hermes Cloud.

Existing fixed profiles remain in the opaque `HERMES_RUNTIME_AGENTS` map.
Unclaimed invitee profiles are not added to that deployment variable. They use
a one-time discovery credential, `hermes_cloud_capacity` for reservation and
`agent_runtime_bindings` for execution. Connector control secrets are
envelope-encrypted; discovery and assigned runtime bearers are stored only as
workspace-and-agent-scoped SHA-256 digests.

Registration verifies the permanent identity, clean Enterprise origin,
durable connector, exact native and plugin source identity, P1.7 artifact and
content, complete tool inventory, dedicated AgentCash wallet, and disabled cron
before capacity becomes `available`. Invitation acceptance performs a new live
connector probe outside the database transaction, then locks and rechecks the
same invitation, capacity, grant, identity and assignment snapshot before it
promotes the digest binding. The database records the actual probe completion
time; it never manufactures readiness from a stored row. A revoked or drifted
grant quarantines capacity, and an Admin must withdraw an invitation before
revoking its reserved grant. Assigned capacity is never returned to the pool;
retirement requires destroying or securely wiping its persistent state outside
this application.

### Registering warm capacity

An operator first configures a paid Cloud instance and dedicated AgentCash
wallet, installs the reviewed Enterprise bridge, disables native cron, and
starts the instance with its permanent Enterprise workspace and agent identities.
A recently authenticated workspace Admin opens Runtime pools and prepares a
credential for that unused permanent agent UUID. Enterprise generates the
64-hex discovery bearer and displays it once. Its prepared form expires after
24 hours and authorizes only `GET /skills` and `GET /tools`; linking verified
capacity removes the expiry until assignment or revocation.

The operator copies that discovery bearer into the managed native initializer.
It is distinct from the connector control secret already provisioned in Cloud.
The Admin then registers the existing instance through
`POST /w/:workspace/admin/hermes-capacity` with the Cloud agent ID, instance
name, clean HTTPS connector URL, existing connector control secret, preflight
agent ID and discovery grant ID. The response and every grant response are
`no-store`. Enterprise never displays, imports or changes the native
`API_SERVER_KEY`.

The route checks connector capabilities and the complete live attestation
before inserting `available` capacity. It stores the connector control secret
only as a workspace-KEK envelope and rejects an identity already present in
agents, runtime bindings or capacity, as well as duplicate Cloud agents and
connector URLs. This operation registers existing capacity; it does not create
an instance, install a plugin, call a paid API or fund a wallet.

Set `AGENT_RUNTIME=hermes`, `HERMES_POOL_LOW_CAPACITY_THRESHOLD`,
`HERMES_BRIDGE_SECRET`, `HERMES_ENTERPRISE_PUBLIC_URL`, the workspace KEK, and
the reviewed `HERMES_ENTERPRISE_PLUGIN_REVISION` (40 lowercase hex) and
`HERMES_ENTERPRISE_PLUGIN_SHA256` (`sha256:` plus 64 lowercase hex) in every
deployed environment. Keep only existing fixed profiles in
`HERMES_RUNTIME_AGENTS`; do not rewrite its opaque live credentials while
adding pool capacity. Health fails closed when either reviewed plugin value is
missing or malformed. The final values come from the reviewed native plugin
commit and deterministic installed-tree build, and must match the values used
by that Cloud profile. A dated internal warning is emitted when available
capacity reaches the threshold.

The official image can persist user-managed plugins, skills and configuration
under its data volume. Hermes Desktop can install an agent plugin into a
selected Cloud profile from a Git repository, including a private repository
and an exact commit pin. That makes the Enterprise bridge portable to Cloud,
but it does not yet make provisioning deterministic. The documented Cloud MCP
can update environment variables and move an instance to the current official
image; it does not expose profile import, plugin installation, arbitrary
configuration writes, a custom image, or a pinned Hermes image digest.

Before production, move the remaining launcher-only policy into the pinned
Enterprise plugin and profile configuration so the ordinary managed Hermes
process can enforce it. That policy currently removes native cron routes,
limits the API Server to the Enterprise bridge plus read-only assigned skills,
disables unmanaged memory and background features, and verifies the reverse
provider binding. Cloud bootstrap must then install the pinned plugin, apply the
profile configuration and secrets, and fail health checks if any step is
missing. A manual Desktop install is acceptable for the first acceptance test,
not for fleet provisioning.

The acceptance test for the Cloud instance is:

1. install the Enterprise bridge at its reviewed commit and apply the governed
   profile configuration without modifying the immutable Hermes source tree;
2. verify capabilities, submit/events/stop/steer, idempotency, the governed tool
   set, and the reverse Enterprise tool/model bridge; and
3. register the instance through the restricted capacity operation, issue and
   accept a real invitation, then run one complete staged turn from the assigned
   dynamic binding.

That staged turn passed on September 16, 2026. The connector's dashboard
manifest, agent plugin and `plugins.enabled` entry all use the single identifier
`enterprise_bridge`; its fixed service route is
`/api/plugins/enterprise_bridge/control`. Keeping one identifier matters because
Hermes independently gates the agent plugin and dashboard API against the enabled
set. A mismatched dashboard name can leave the agent tools loaded while silently
skipping the control endpoint.

Do not substitute an interactive `agent_dashboard:access` session or an
`mcp:manage_agents` token for `API_SERVER_KEY`. If Cloud does not publish the
Runs endpoint, request one of these contracts from Nous:

1. a public or private Runs endpoint with a rotatable service credential; or
2. a Portal service-to-service proxy that preserves the Runs API, agent identity,
   stop/steer semantics and durable idempotency.

The connector is the current acceptance-test path. For fleet production, ask
Nous to make the same contract first-class: a per-agent, rotatable service
credential and public/private Runs endpoint. If that contract remains
unavailable, the reviewed plugin is a contained compatibility layer; the next
fallback is the official pinned Docker/runtime image under our own supervisor,
not a tunnel to a laptop.

## Enterprise bridge architecture decision — September 16, 2026

**Revalidated September 17, 2026.** Current Hermes, Cloudflare and durable
execution documentation still supports this split. The broader comparison and
migration triggers are recorded in [C71](decisions/08-runtime-and-team-workflows.md#c71-keep-cloudflare-worker-and-workflows-around-the-official-hermes-runtime).

The Worker remains the right boundary for the current product, but its role is
narrow: authenticate people and channels, enforce workspace and approval
policy, keep the durable audit record, and orchestrate calls to Hermes Cloud.
Hermes Cloud owns model/tool execution. Postgres remains the authoritative
tenant state. Workflows checkpoint orchestration. Durable Objects fan out live
events and hold no authoritative business data.

| Option | Decision | Reason |
| --- | --- | --- |
| Cloudflare Worker + Workflows + Hermes Cloud | Keep | The Worker handles short policy/database operations, while Workflows support durable steps and waits. The existing code already isolates tenant policy from the runtime. |
| Put approvals and enterprise policy inside Iris | Reject | The runtime is the executor and can change profile/plugin state. It must not become the authority that decides its own permissions, spending or approvals. |
| Full Temporal migration | Defer | Temporal is a strong durable-execution platform, but it would add another control plane and rewrite already-tested orchestration without fixing the present Hermes Cloud ingress gap. Revisit only for portability, multi-cloud workers or orchestration requirements Cloudflare cannot meet. |
| AWS Step Functions migration | Reject for this stack | It adds an AWS control plane and its HTTP tasks have a 60-second hard duration; it does not improve the current Cloud-to-Hermes contract. |
| Long-lived agent execution inside a Worker request | Reject | Worker requests are not the agent host. Cloudflare can terminate in-flight requests during runtime updates after a grace period, and each isolate has 128 MB memory. Hermes Cloud must own the long-running process. |
| A separate Fly/Cloud Run proxy | Reserve fallback | Use only if Hermes Cloud cannot load the reviewed connector plugin or provide a native service endpoint. A second proxy service adds secrets, deploys and failure modes while enforcing no policy the Worker does not already own. |

This is not a blanket endorsement of Workers for every future deployment. Move
the control plane when a measured requirement demands private regional
networking, customer VPC deployment, a non-JavaScript SDK unavailable at the
edge, or vendor-neutral durable orchestration. Current platform limits leave
substantial room: paid Workflows support unlimited wall time per step, waiting
instances do not consume active concurrency, and completed instance state is
retained for 30 days. We already persist the durable product audit in Postgres,
so Workflow retention is operational recovery data rather than the customer
record.

Primary references: [Cloudflare Worker limits](https://developers.cloudflare.com/workers/platform/limits/),
[Cloudflare Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/),
[Temporal durable execution](https://docs.temporal.io/),
[AWS Step Functions quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html),
[Hermes programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration),
and the [Hermes API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server).

## Verified locally — September 15, 2026

The previously recorded real-call checks used the workspace’s encrypted
OpenRouter credential and `anthropic/claude-sonnet-5` through the official
pinned AIAgent. They predate the Nous Portal migration and are retained as
historical runtime evidence. Current automated checks use the Nous Portal
fixture; no paid Nous Portal inference call is claimed here.

| Check | Observed result |
| --- | --- |
| Context and Inbox read | Native tools returned actual local data; one structured assistant response and correlated trace. |
| Session continuity | A following turn recalled “silver lantern” from its prior native session. |
| Human context answer | Run `0a2e656f-cf56-456c-abec-585406b11611` resumed through the composer; 8,673 ms active, 20,013 ms human wait excluded. |
| Human-review proposal | Run `55dd1ac9-c4d3-4774-93c4-16edb2b5a1ca` created one fictional QA-only application, left pending, and focused it on the right. No decision, invitation or external message. |
| Stop while waiting | Run `34434547-50e1-45b9-bd76-67c505425600` reached Stopped after native termination; further tools were blocked. |
| Native state move/restart | Session and idempotency databases retained; watchdog healthy; durable native admission confirmed. |
| Original localhost:8787 | Run `f6ad2eb0-2a3f-4955-bb42-eef06aca83b5` read the pending Inbox and focused Traces; the next turn recalled “silver lantern” after restart. |

The QA session is **Official Hermes runtime verification**. Its deliberately
labeled test request is `9ed1133e-aa40-4b71-b279-4dc006663838`. Initial failed
verification attempts remain visible in Traces; they are not relabeled as
successes.

Automated verification includes shared/client/Worker unit checks, the full
Worker database suite under the restricted roles, native workerd transport,
eight isolated browser regressions for context/Stop/key disclosure, Python
launcher/plugin checks and the real official-gateway fixture probe.

Local delivery is active at `http://localhost:8787`, with Iris’s official runtime
on port `8642`. The temporary app on `8790` has been stopped. Worker database
checks passed 368 tests, workerd 29, and the affected Stop routes 19 additional
checks. All workspace typechecks passed after integration.
