# Official Hermes runtime

This directory installs and launches the official Nous Hermes agent loop behind the enterprise tool and model boundaries. It does not implement an alternative agent loop.

Pinned source: [NousResearch/hermes-agent at 5d59366010640c1d6b8f170d8a4ee109db2bbdef](https://github.com/NousResearch/hermes-agent/tree/5d59366010640c1d6b8f170d8a4ee109db2bbdef), reporting package version **0.21.3**. Do not upgrade this pin without running the native probe below: the plugin uses two pinned internal ContextVars for trusted correlation.

## Start an agent

Run these from the application repository root. Python 3.11–3.13, Git, and `uv` are required; the installer creates its own Python environment.

```sh
python3 runtime/hermes/install.py
python3 runtime/hermes/start.py \
  --env-file /absolute/path/to/agent-runtime.env \
  --model 'raw-model-id-from-the-enterprise-catalog'
```

To reuse an already cloned **pinned official** source tree, pass `--source /absolute/path/to/hermes-agent` to both commands. The installer rejects a different commit, modified tracked files, or an untracked/missing `uv.lock`. It uses `uv sync --locked --no-install-project` against that tree, so dependency artifacts are checked against the upstream lock while the launcher imports the exact verified source through `PYTHONPATH`; there is no editable package or live dependency resolution. The API server's `aiohttp` dependency comes from the upstream `sms` extra, its smallest aiohttp-only locked extra. The resulting source revision, lock SHA-256, and exact package inventory are written to ignored local state at `runtime/hermes/.state/installed-packages.json`.

The gateway runs in the foreground; run it under the deployment's process supervisor for lasting service. `--port` defaults to `8642`; assign a different port to each additional agent.

The env file has the fields shown in `credentials.env.example`. Provision `ENTERPRISE_RUNTIME_TOKEN` through the enterprise service's per-agent credential mechanism. `API_SERVER_KEY` is the random bearer secret the enterprise adapter uses to call this native runtime. Keep the file mode `0600`. There are **no workspace provider credentials** in this file. `--env-file` parses literal key/value data and never sources shell commands. CLI workspace, agent and URL flags override the corresponding file fields. Alternatively use `--token-file` with `--workspace-id`, `--agent-id` and `--enterprise-url`; the launcher then generates a native API key.

The default dedicated profile is `~/.he-runtime/<agent-uuid>/`, separate from the user's personal `~/.hermes`. It contains its own `home`, `os-home`, working directory, session database, run reservations, API key, and a copy of the plugin. `--state-root` selects another data directory; keep the path short enough for macOS Unix sockets. The launcher checks the actual `<profile>/home/state/gateway.loop-tick.<pid>.sock` suffix with its current PID (preserved by `execve`) and counts UTF-8 bytes against the macOS limit. No personal environment, bot token, provider key, proxy setting, `HERMES_HOME`, session identity or Python user path is inherited. The launcher takes an exclusive per-agent file lock and refuses to repurpose an existing profile for a different workspace/agent/enterprise URL.

When relocating an existing profile, first stop its gateway and verify the process exited, then move the **whole agent UUID directory** to the new state root. This preserves transcript databases, run idempotency reservations and API credentials. Restart with the same enterprise credentials; do not start a fresh empty directory while the previous profile is still running. The initial development profile used `~/.hermes-enterprise`; its longer prefix exceeded the watchdog socket limit on macOS.

Startup does a real authenticated `/tools` discovery and native tool/provider resolution before binding the API. It also refuses a profile whose native cron store is nonempty. `--verify-only` runs this preflight without starting the gateway. The enterprise service must already be reachable.

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
  api_server: [enterprise_bridge]
tools:
  tool_search:
    enabled: off
gateway:
  multiplex_profiles: false
  api_server:
    max_concurrent_runs: 1
```

The launcher also disables every native built-in toolset, all MCP servers, both built-in memory stores, memory/skill nudges, background review and title generation. Only this plugin is enabled. A plugin pre-tool hook vetoes every name outside its discovered enterprise tools. Startup fails closed unless the resolved tool definitions contain only enterprise tools. Native `agent.max_iterations` is 12; the enterprise bridge remains responsible for its existing cost, turn, capability and approval policies. API requests should specify `provider: "custom"` plus the raw catalog model ID. Generic `OPENAI_API_KEY` does not authenticate an arbitrary custom URL on this pinned Hermes version; the config's explicit env-reference key does.

`API_SERVER_HOST=127.0.0.1`, bearer auth, no CORS allowance, one active run per profile. The launcher removes native `/api/jobs*` and `/api/cron*` routes before the listener binds. Native health and capabilities return 503 if the cron store later becomes nonempty. The remaining native REST routes require the secret; expose the native listener only to the enterprise adapter. `HERMES_HOME` is data isolation, not an OS sandbox. The narrow tool boundary is what keeps the model from directly executing local shell/file/browser/delegation operations.

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
```

The native probe launches the actual official HTTP gateway and AIAgent with a **local fixture model and fixture enterprise server**, under a disposable isolated home. It checks the durable capability contract, exact model/tool boundary, admission replay/conflict, a full gateway restart followed by durable replay, native cron route removal and health failure, native SSE payload/single-consumer behavior, stored tool history across turns, concurrency rejection and stop while waiting. It makes no paid provider calls and does not establish real model quality or production reachability. The unit tests cover spoofed argument identity, pending retry identity, stop, uncertain transport, redirect rejection, schema validation and environment isolation.

## Official source anchors

- [Runs implementation and worker context binding](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/gateway/platforms/api_server_runs.py)
- [Durable run reservations](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/gateway/platforms/api_server_run_idempotency.py)
- [API adapter, SSE framing and agent construction](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/gateway/platforms/api_server.py)
- [Tool execution context binding](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/model_tools.py) and [approval ContextVars](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/tools/approval_context.py)
- [Custom provider resolution](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/hermes_cli/runtime_provider_backends.py)
- [MCP tool call path](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/tools/mcp_tool_handlers.py) and [connection headers](https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/tools/mcp_tool_transport.py)
- [Official API documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) and [native plugin documentation](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)
