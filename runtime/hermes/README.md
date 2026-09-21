# Official Hermes runtime

This directory installs and launches the official Nous Hermes agent loop behind the enterprise tool and model boundaries. It does not implement an alternative agent loop.

Pinned source: [NousResearch/hermes-agent at 345cd2b057a452236de401d3534b8502a7465e8d](https://github.com/NousResearch/hermes-agent/tree/345cd2b057a452236de401d3534b8502a7465e8d), reporting package version **0.21.3**. Do not upgrade this pin without running the native probe below: the plugin uses two pinned internal ContextVars for trusted correlation.

## Start an agent

Run these from the application repository root. Python 3.11–3.13, Git, and `uv` are required; the installer creates its own Python environment.

```sh
python3 runtime/hermes/install.py
python3 runtime/hermes/start.py \
  --env-file /absolute/path/to/agent-runtime.env \
  --model 'raw-model-id-from-the-enterprise-catalog'
```

To reuse an already cloned **pinned official** source tree, pass `--source /absolute/path/to/hermes-agent` to both commands. The installer rejects a different commit, modified tracked files, or an untracked/missing `uv.lock`. It uses `uv sync --locked --no-install-project` against that tree, so dependency artifacts are checked against the upstream lock while the launcher imports the exact verified source through `PYTHONPATH`; there is no editable package or live dependency resolution. The API server's `aiohttp` dependency comes from the upstream `sms` extra, its smallest aiohttp-only locked extra; the locked `mcp` extra supplies the MCP client SDK that configured MCP servers such as the AgentCash demo require. The resulting source revision, lock SHA-256, and exact package inventory are written to ignored local state at `runtime/hermes/.state/installed-packages.json`.

The gateway runs in the foreground; run it under the deployment's process supervisor for lasting service. `--port` defaults to `8642`; assign a different port to each additional agent.

## Hermes Cloud connector

Hermes Cloud publishes its authenticated dashboard/Gateway hostname while the
native API Server remains on loopback. Install this directory as a pinned user
plugin and enable it to add one machine-authenticated connector route:

```text
POST /api/plugins/enterprise_bridge/control
GET  /api/plugins/enterprise_bridge/control?run_id=run_…  # SSE only
```

Set a unique `HERMES_ENTERPRISE_CONTROL_SECRET` (at least 43 random URL-safe
characters) on the Cloud instance. The Worker stores that value as the
per-agent runtime `api_key`, sets the binding's `transport` to
`dashboard_connector`, and uses the full connector URL as `base_url`. The
plugin accepts only capabilities, submit, status, events, stop and steer. The
long-lived event stream uses GET on the same exact token-authenticated path so
intermediaries treat it as conventional SSE; it emits an immediate comment and
then flushes one complete native event frame at a time. All other operations
use POST. The connector forwards them to `http://127.0.0.1:8642` with
`API_SERVER_KEY`. The native key
never leaves the Cloud instance, and the connector cannot select another host
or path.

`ENTERPRISE_RUNTIME_TOKEN` continues to authenticate the reverse tool/model
bridge from the runtime to the Worker. Keep these three credentials distinct.
The Cloud profile still needs the same governed plugin settings and toolset
policy described below; exposing the connector alone does not constrain tools.

### Managed Cloud startup

An ordinary Hermes Cloud gateway can apply the same policy without replacing
its supervisor command. This repository is private, so provision a temporary
repository-scoped, read-only GitHub deploy key through a supported private-file
mechanism. Confirm the key is mode `0600` and provision a separately verified
`known_hosts` file. The Cloud dashboard runs with `HOME=/opt/data`; create these
task-owned files with its supported Files page:

```text
/opt/data/.ssh/config
/opt/data/.ssh/hermes-enterprise-deploy
/opt/data/.ssh/github-known-hosts
```

The task-owned OpenSSH config must contain only this strict host binding:

```sshconfig
Host github.com
  HostName github.com
  User git
  IdentityFile /opt/data/.ssh/hermes-enterprise-deploy
  IdentitiesOnly yes
  IdentityAgent none
  BatchMode yes
  StrictHostKeyChecking yes
  UserKnownHostsFile /opt/data/.ssh/github-known-hosts
```

Hermes Cloud's supported Files upload writes private files with mode `0600`;
verify each uploaded path before use. Hermes 0.21.3 runs Git noninteractively
and preserves normal OpenSSH `~/.ssh/config` resolution. Do not put a deploy key
or broad GitHub token in the clone URL or managed runtime environment. Install
this exact plugin subdirectory at the reviewed 40-character commit through the
Hermes Console:

```text
plugins install git@github.com:bflynn4141/hermes-enterprise.git#runtime/hermes/enterprise_bridge --ref <full-commit-sha> --enable
```

After the pinned install succeeds, remove only these task-owned SSH files
through the supported Files page and revoke the deploy key. The installed
plugin does not need repository access to run. The source validator accepts
only this canonical SSH source or the canonical HTTPS form for an already
supported credential-helper installation of the same repository and
subdirectory.

The Cloud Files page alone is not an installation boundary: uploading files to
`/opt/data/plugins` does not prove a commit pin, enable the plugin, or restart
the gateway. Use the supported plugin command and confirm the installed version
before setting `HERMES_ENTERPRISE_CLOUD_MANAGED=1` and restarting the ordinary
`hermes gateway run --external-supervisor` process.

Persist the same 64-lowercase-hex `ENTERPRISE_RUNTIME_TOKEN`, native
`API_SERVER_KEY` and control secret in the Cloud platform's environment across
the restart. The Hermes config must refer to the first two as
`${ENTERPRISE_RUNTIME_TOKEN}` and `${API_SERVER_KEY}`; do not copy either value
into readiness or documentation.

Also persist `HERMES_ENTERPRISE_PLUGIN_REVISION` as the full 40-character
installer revision and `HERMES_ENTERPRISE_PLUGIN_SHA256` as the deterministic
digest of the exact reviewed plugin tree. The revision must match the
`enterprise_bridge` record in
`$HERMES_HOME/plugins/.install-metadata.json`; that record must name the pinned
SSH or HTTPS source above exactly and have `pinned: true`. After final review,
compute the expected tree digest from the checkout at that exact commit:

```sh
PYTHONPATH=runtime/hermes python3 -c \
  'from enterprise_bridge.runtime_policy import plugin_tree_digest; print(plugin_tree_digest("runtime/hermes/enterprise_bridge"))'
```

Record both immutable values in the Worker binding and the supervised profile;
the Cloud console does not need to execute the digest command. The pinned
installer copies that exact repository subdirectory, and native startup
rehashes its installed copy against the reviewed value. Ordinary managed
startup stays closed when either value is absent or differs. Managed readiness
reports them as `plugin.revision` and `plugin.artifact_digest`, and every later
admission rehashes the installed tree. The digest covers framed relative paths
and file bytes, ignores only Python bytecode caches, and rejects symlinks; the
install metadata lives outside the tree, so there is no self-hash cycle.

Also persist `HERMES_ENTERPRISE_SOURCE_REVISION` as the full 40-character
pinned official Hermes commit (`345cd2b057a452236de401d3534b8502a7465e8d` for
this pin; it must equal `contract.json`'s `source_revision`). The connector
refuses to build its `enterprise_contract` block without this attestation, and
the Worker then reports `hermes:runs` as "Hermes request failed (502)". The
verified native launcher supplies this value itself; a stock Hermes Cloud
profile must set it explicitly. Every `update_env` on Hermes Cloud restarts the
instance, so set all three identity values in one call.

The managed flag is opt-in, so installing the additive bundle does not change
an existing Iris 1.7 gateway. In managed mode the plugin installs a persistent
API route gate before control authentication or Worker discovery. Only inert
capabilities plus governed run create/status/events/approval/steer/stop routes
remain. Create, approval and steer stay HTTP 503 until this exact process
validates its current source, identity, Worker assignment, plugin, skill bytes,
config, provider resolver, empty cron store and resolved tool inventory. Status,
events and stop remain available for an already-running run. The actual
conversation-loop provider boundary repeats the current proof before every
request, retry and later model iteration, including an authenticated refresh of
the binding; tool calls repeat it before dispatch. Drift after an HTTP 202
acceptance still removes readiness and latches the process closed before the
model request. Worker model and tool routes recheck the same bearer and current
run authority on every outbound call.

The first managed start writes a persistent profile marker. Removing the
managed flag on a later restart does not reopen connector submit or steer: a
marked profile must still present live readiness bound to the current native
boot and digest. Profiles that have never opted into managed mode retain the
existing connector behavior.

This gate begins inside the plugin's `register()` entrypoint. Hermes 0.21.3
discovers enabled plugins synchronously before it connects the API adapter, so
validation failures after registration begins leave the class-level gate in
place. A disabled plugin or an import failure before `register()` runs cannot
install that patch. In that state the connector is absent and the native API
must remain loopback-only and unreachable from the Enterprise control plane;
the profile is not eligible for readiness or promotion.

Managed startup needs the normal identity and credentials from
`credentials.env.example`, `HERMES_ENTERPRISE_MODEL`, and the exact governed
config below. It calls only the ordinary agent-scoped Worker `/skills` and
`/tools` discovery endpoints; it does not call its own native API to become
ready. A new unclaimed Cloud profile therefore needs a short-lived, exact
workspace/agent-scoped discovery grant for those two GET endpoints. That grant
must not authorize model, tool, run, capacity-claim or mutation routes. Reuse
the same random `ENTERPRISE_RUNTIME_TOKEN` when the binding is promoted instead
of swapping a Cloud secret during activation.

The Worker serves the manifest `config` without null leaves. Hermes 0.21.3
`save_config` drops every leaf equal to its (absent) default, so a Cloud
dashboard save can never persist `search_after: null`; managed startup compares
the pinned `partner_program` settings and `skills.config` byte-for-byte with
that served config, so both sides carry the YAML-representable projection.

Do not reconstruct or replace a shared static runtime-agent map from an old
bootstrap bundle. Install the connector while the pool is unclaimed, confirm
the inert native capabilities endpoint, create the scoped discovery grant, then
apply the role config and managed flag and restart. Promotion remains disabled
until the connector's `readiness` operation returns a live document whose
`boot_id` and readiness SHA-256 match the current gateway health headers. A
leftover JSON file or a healthy Cloud badge cannot establish readiness.

The env file has the fields shown in `credentials.env.example`. Provision `ENTERPRISE_RUNTIME_TOKEN` through the enterprise service's per-agent credential mechanism. `API_SERVER_KEY` is the random bearer secret the enterprise adapter uses to call this native runtime. Keep the file mode `0600`. There are **no workspace provider credentials** in this file. `--env-file` parses literal key/value data and never sources shell commands. CLI workspace, agent and URL flags override the corresponding file fields. Alternatively use `--token-file` with `--workspace-id`, `--agent-id` and `--enterprise-url`; the launcher then generates a native API key.

The default dedicated profile is `~/.he-runtime/<agent-uuid>/`, separate from the user's personal `~/.hermes`. It contains its own `home`, `os-home`, working directory, session database, run reservations, API key, and a copy of the plugin. `--state-root` selects another data directory; keep the path short enough for macOS Unix sockets. The launcher checks the actual `<profile>/home/state/gateway.loop-tick.<pid>.sock` suffix with its current PID (preserved by `execve`) and counts UTF-8 bytes against the macOS limit. No personal environment, bot token, provider key, proxy setting, `HERMES_HOME`, session identity or Python user path is inherited. The launcher takes an exclusive per-agent file lock and refuses to repurpose an existing profile for a different workspace/agent/enterprise URL.

When relocating an existing profile, first stop its gateway and verify the process exited, then move the **whole agent UUID directory** to the new state root. This preserves transcript databases, run idempotency reservations and API credentials. Restart with the same enterprise credentials; do not start a fresh empty directory while the previous profile is still running. The initial development profile used `~/.hermes-enterprise`; its longer prefix exceeded the watchdog socket limit on macOS.

Startup does a real authenticated `/tools` discovery and native tool/provider resolution before binding the API. By default it also refuses a profile whose native cron store is nonempty. `--verify-only` runs this preflight without starting the gateway. The enterprise service must already be reachable.

Startup requires every assigned skill manifest's version and immutable `artifact_digest` to match a reviewed package, then independently checks the installed `SKILL.md` `content_digest`. New artifacts use the same SHA-256 for both fields. The original Partnerships 1.7 tuple is the sole compatibility exception because deployed migration 0047 registered a historical artifact identity before native byte attestation; its exact content hash is still checked and reported. After plugin discovery the launcher verifies the live plugin registry, its pinned revision and installed-tree digest, resolved tool definitions and provider, then writes a non-secret `home/runtime-readiness.json`. The authenticated Cloud connector returns this checked runtime revision, four-field plugin identity, assigned skill identities, installed content digests and exact tool names. A database assignment or reachable process alone is not Ready. See [MULTI_PARTY_RUNBOOK.md](MULTI_PARTY_RUNBOOK.md) for the two-profile rollout and acceptance sequence.

## Supported configuration and scope

The generated config sets:

```yaml
model:
  provider: custom
  default: <raw catalog model ID>
  base_url: <enterprise>/internal/runtime/w/<workspace>/agents/<agent>/model/v1
  api_mode: chat_completions
  api_key: ${ENTERPRISE_RUNTIME_TOKEN}
platform_toolsets:
  api_server: [enterprise_bridge, enterprise_skill_reader]
tools:
  tool_search:
    enabled: off
gateway:
  multiplex_profiles: false
  api_server:
    max_concurrent_runs: 1
```

At startup the launcher also reads the authenticated model manifest once and
declares `providers.enterprise.models.<exact Claude model ID>.prompt_caching:
true` for the governed custom proxy, including allowed per-run Claude overrides
when the configured default is another model. The policy uses the five-minute
cache tier and does not change model, effort, routing, or tool permissions. An
unavailable manifest falls back to the configured model only. See
[Iris latency verification](../../docs/IRIS-LATENCY.md).

The launcher disables every native built-in toolset except a dedicated read-only `skill_view`, both built-in memory stores, memory/skill nudges, the autonomous skill curator, background review and title generation. MCP is empty by default. `ENTERPRISE_MCP_SERVERS_JSON` may add explicitly named stdio servers, but every one needs a bounded `tools.include` list and env values may only reference scoped variables from the credentials file. `HERMES_AGENTCASH_MCP_ENABLED=1` is the demo shortcut documented in that file. Only this plugin is enabled. The managed profile removes the bundled skill catalog; `skill_view` is restricted to the exact assigned enterprise package so the model can re-read it. A plugin pre-tool hook vetoes every other name outside its discovered enterprise or configured MCP tools. Startup fails closed unless the resolved static tool definitions contain only enterprise tools plus that viewer. It rejects provider fallback chains, alternate provider maps and API `model_routes`; the resolved custom provider, model, base URL, API mode and secret value are rechecked at each model request. Native `agent.max_iterations` is 12 and `agent.api_max_retries` is 1: the Worker persists provider retry deadlines and owns visible, durable recovery instead of letting one native process sleep for a provider's full `Retry-After`. The enterprise bridge remains responsible for its existing cost, turn, capability and approval policies. API requests should specify `provider: "custom"` plus the raw catalog model ID. Generic `OPENAI_API_KEY` does not authenticate an arbitrary custom URL on this pinned Hermes version; the config's explicit env-reference key does.

### Assigned skill text in every session

Hermes 0.21.3 has no `skills.auto_load`; the launcher and the managed Cloud validator reject it so an inert key cannot look like policy. The plugin pins the assigned skill itself through the pinned plugin API's system prompt sections (`register_system_prompt_section` in `hermes_cli/plugins.py`). At registration it fetches the authenticated assignment, refuses configured `allowed_skills` or `partner_program` values that differ from it, reads the exact packaged `SKILL.md` bytes, binds them to the reviewed package version and digests, and only then registers the text as numbered `enterprise-skill.NN` continuation sections. Hermes freezes those sections into the system prompt of each new session before the first model request and restores the persisted bytes on resume without re-running plugin code. The pinned runtime limits every section to 4,000 characters and all sections to 8,000 framed characters; the largest packaged skill uses about 7,900, so a skill edit that exceeds the budget fails at registration. Before readiness, both the launcher and the Cloud validator render the live sections through the plugin manager and require them to equal the sections recomputed from the reviewed bytes; the Cloud validator repeats that comparison at every provider and tool attempt. `skills.config` still carries the assignment's non-secret values for native skill consumers, but this release does not render them into the prompt.

`API_SERVER_HOST=127.0.0.1`, bearer auth, no CORS allowance, one active run per profile. By default the launcher removes native `/api/jobs*` and `/api/cron*` routes before the listener binds, and health returns 503 if the cron store later becomes nonempty. `HERMES_NATIVE_CRON_ENABLED=1` retains those authenticated routes, while `cron.allow_agent_scheduling` remains false; Cloudflare stays the owner of business triggers. The remaining native REST routes require the secret; expose the native listener only to the enterprise adapter. `HERMES_HOME` is data isolation, not an OS sandbox. The narrow tool boundary is what keeps the model from directly executing local shell/file/browser/delegation operations.

## Tool bridge protocol

All requests use `Authorization: Bearer ENTERPRISE_RUNTIME_TOKEN`. The token and URL bind the agent and workspace outside model arguments.

`GET /internal/runtime/w/<workspace>/agents/<agent>/tools` returns:

```json
{"tools":[{"name":"list_requests","description":"...","parameters":{"type":"object","properties":{}}}]}
```

Tools are discovered at startup. Restart after changing tool names/schemas. An empty or conflicting catalog fails preflight. The bridge rechecks capability and current run authority on every call, so revocations need not wait for a runtime restart.

`POST /internal/runtime/w/<workspace>/agents/<agent>/calls` receives:

```json
{"runtime_run_id":"run_<32 hex>","tool_call_id":"call_<provider ID>","name":"list_requests","arguments":{}}
```

`runtime_run_id` comes from `tools.approval_context._approval_session_key`; native `/v1/runs` binds it to its server-generated run ID. `tool_call_id` comes from `_approval_tool_call_id`, which `model_tools` binds around the registry dispatch. Both are ContextVars. There is no fallback to environment values, model arguments, mutable process-global identity or a made-up call ID. Calls outside this native run context fail closed. This was exercised through the real HTTP gateway and AIAgent, not only a patched unit handler.

The bridge must atomically reserve `(agent, runtime_run_id, tool_call_id)` and reject a different payload for an existing identity. The enterprise adapter records its mapping from native run ID to enterprise run/workspace. Calls arriving before that mapping exists receive **409 `{"reason":"mapping_pending"}`**; the plugin safely retries the identical request for at most five seconds.

- **200 `{"ok":true,"content":"..."}`**: return the existing untrusted-data envelope unchanged to Hermes.
- **200 `{"ok":false,"content":"..."}`**: return a tool error.
- **202 `{"status":"pending"}`**: no completed effect yet; repeat the identical request until context/approval arrives. Default overall wait limit is 24 hours. Each HTTP request is bounded to five seconds; return pending promptly rather than holding a long HTTP request open.
- **409 `{"reason":"stopped"}`**: stop waiting and return a controlled tool error.

Before each POST/retry, the plugin checks the native run status and stops if it is no longer running. It sleeps 250 ms between explicit pending responses. Network errors, redirects, malformed results and other HTTP errors fail closed without automatically replaying a possibly completed write. Authorization and raw exception bodies are never emitted in model-visible error text. The Worker should attach authoritative tool events to its own call record; the native tool SSE events have no call IDs, arguments or outputs.

MCP was not selected for this bridge: the pinned MCP client constructs HTTP headers from connection config and calls `session.call_tool(tool_name, arguments=args)` with no run-scoped metadata. Static MCP headers do not identify one enterprise run. The native plugin provides the required trusted context without forking the official agent loop.

The sole approved AgentCash MCP call has an additional pre-payment handshake.
The plugin sends its trusted native run id, tool-call id, and exact Worker-issued
arguments to `POST .../agentcash/people-search/authorize`. The Worker locks the
matching screening row and reserves its single request. Replaying the same
tool-call id is idempotent; a different second id fails before the MCP can pay.
Only that leased id may use `POST .../agentcash/people-search/import` afterward.
An uncertain authorization response fails closed, and an uncertain payment is
never automatically retried.

## Native Runs API contract at this pin

Send a bearer-authenticated `POST /v1/runs` with `input`, `session_id`, optional `instructions`, `provider: "custom"`, and `model`. Initial acceptance is HTTP 202:

```json
{"run_id":"run_<32 hex>","status":"started","replayed":false}
```

Use a stable `Idempotency-Key` for one logical turn. It must be 1–255 visible ASCII characters. The fingerprint includes the complete body and `X-Hermes-Session-Key`. Identical repeats return the same ID with `replayed:true` and `Idempotency-Replayed: true`; changed payload returns HTTP 409 `idempotency_key_conflict`. Always reuse the original exact submission body when resolving lost acceptance. Reservations persist in `runs_idempotency.db`, scoped to profile and API credential, with 24-hour terminal retention. The Worker validates the authenticated server-agent Runs endpoint contract and requires `runs_idempotency.durable === true` in deployment health, turn admission, Workflow submit/replay, and execution reconciliation. Hermes can fall back to memory if its SQLite store cannot open; that state is now unhealthy and cannot admit a native run. Restart does not automatically re-execute interrupted work; a retained nonterminal run whose owner died becomes `interrupted` when polled/replayed.

`GET /v1/runs/<id>` is authoritative reconciliation. Statuses: `queued`, `running`, `waiting_for_approval`, `stopping`, `completed`, `failed`, `cancelled`, `interrupted`. Polling includes `object:"hermes.run"`, `run_id`, `session_id`, model, Unix-second `created_at`/`updated_at`, and terminal output/usage or error. Non-idempotent terminal statuses remain in memory for one hour.

For continuation, reuse an enterprise-owned stable `session_id` and omit `conversation_history`/`previous_response_id`. Native Hermes loads the stored conversation including tool calls/results and resolves a pre-compression ID to the current continuation tip. Explicit `conversation_history` takes precedence and flattens entries to role/content strings; do not use it to round-trip structured tool history. An ordinary `/v1/runs` result does not create an OpenAI response ID, so do not chain runs via `previous_response_id`.

`GET /v1/runs/<id>/events` emits **only** `data: <JSON>\n\n` frames. The event name is in the JSON, not an SSE `event:` line. There are no SSE event IDs. All payloads have `{event, run_id, timestamp}` (Unix seconds):

| `event` | Additional fields |
| --- | --- |
| `message.delta` | `delta` |
| `tool.started` | `tool`, `preview` |
| `tool.completed` | `tool`, `duration` (seconds), `error` (boolean) |
| `reasoning.available` | `text` |
| `run.completed` | `output`, `usage:{input_tokens,output_tokens,total_tokens}`, optional `pending_steer` |
| `run.failed` | `error` |
| `run.cancelled` | none |
| `approval.request` | approval transport payload, `choices` |
| `approval.responded` | `choice`, optional `request_id`, `resolved` |
| `run.steered` | `accepted:true` |
| `subagent.start` / `subagent.complete` | optional child lifecycle fields; delegation is disabled here |

There is no `_thinking`, `run.started`, or `run.running` SSE event. Do not describe reasoning text as hidden model reasoning; it is only the runtime's provided preview field. A 30-second comment keepalive and terminal comment may appear. **One queue is consumed by subscribers**: this is not broadcast or replay. Disconnect removes the queue; `Last-Event-ID` is unsupported. The queue can expire after five minutes without a subscriber. The enterprise adapter should keep one connection, persist its own events, and poll the run after disconnect or stream completion. Reattaching the browser should use enterprise-persisted events, not a second native subscription.

`POST /v1/runs/<id>/stop` returns `{"run_id":"...","status":"stopping"}` immediately. It requests cooperative interruption; only terminal polling establishes that execution stopped. A queued run is cancelled before starting. Terminal stop requests return the existing status. Stop does not rewind completed enterprise effects. The pending-tool protocol above is necessary so a blocking HTTP call cannot prevent interruption indefinitely.

## Verification

```sh
python3 -m unittest discover -s runtime/hermes/tests -v
python3 runtime/hermes/tests/probe_native.py \
  --source /absolute/path/to/pinned/hermes-agent \
  --python runtime/hermes/.state/venv/bin/python
PYTHONPATH=/absolute/path/to/pinned/hermes-agent \
  /absolute/path/to/pinned/venv/bin/python \
  runtime/hermes/tests/probe_cloud_managed.py \
  --source /absolute/path/to/pinned/hermes-agent \
  --python /absolute/path/to/pinned/venv/bin/python
```

The native probe launches the actual official HTTP gateway and AIAgent with a **local fixture model and fixture enterprise server**, under disposable isolated homes. It starts dedicated opt-in Partnerships and Finance profiles, verifies each exact skill version/digest and tool inventory, proves every model request's system prompt carries exactly the assigned skill sections and no other package, exercises the real `publish_partner_invoice_review` and `get_partner_handoff_result` bridge calls, proves Finance has no AgentCash dependency, and proves a Finance attempt to call the Partnerships tool never reaches Enterprise. It also starts and restarts an existing Partnerships profile with the original byte-identical 1.7 package and discovery tool, checks the durable capability contract, admission replay/conflict, native cron route removal and health failure, native SSE payload/single-consumer behavior, stored tool history across turns, concurrency rejection and stop while waiting. It makes no paid provider calls and does not establish real model quality or production reachability. The unit tests cover spoofed argument identity, pending retry identity, stop, uncertain transport, redirect rejection, schema validation and environment isolation.

The Cloud-managed probe starts the ordinary supervised gateway command. It
proves the route gate survives a caught validation failure after plugin
registration begins, inert capabilities remain observable while unready, stale
readiness is removed, selected catalog models can change on the same governed
proxy, and fallback/provider-route escape configuration is rejected. It also
proves drift after HTTP 202 is stopped at the real provider
boundary, a managed profile restarted without its flag remains closed, and
one-byte plugin drift fails both startup and an already-ready latch. Its Worker
and model are fixtures; the probe does not establish hosted installation,
current provider availability or production quality.

## Official source anchors

- [Runs implementation and worker context binding](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/gateway/platforms/api_server_runs.py)
- [Durable run reservations](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/gateway/platforms/api_server_run_idempotency.py)
- [API adapter, SSE framing and agent construction](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/gateway/platforms/api_server.py)
- [Tool execution context binding](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/model_tools.py) and [approval ContextVars](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/tools/approval_context.py)
- [Custom provider resolution](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/hermes_cli/runtime_provider_backends.py)
- [MCP tool call path](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/tools/mcp_tool_handlers.py) and [connection headers](https://github.com/NousResearch/hermes-agent/blob/345cd2b057a452236de401d3534b8502a7465e8d/tools/mcp_tool_transport.py)
- [Official API documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) and [native plugin documentation](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)
