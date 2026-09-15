# Official Hermes Agent runtime

The enterprise app should use the official Hermes Agent as its execution plane. The Worker remains the control plane and system of record.

## Identity

- One enterprise `agents.id` maps to one isolated Hermes profile.
- Every enterprise session and run stores `agent_id`.
- Store the official Hermes `profile`, `session_id`, and `run_id` as correlation metadata; none replaces the enterprise ids.
- Keep **Agent**, **Model**, and **Location** separate in the UI. Example: `Iris · DeepSeek · Cloud`.

Hermes profiles have independent homes, configuration, memory, sessions, skills, cron state, and credentials. The official guidance says two processes must not share one profile. An enterprise deployment should therefore isolate each agent profile in its own OpenShell sandbox or container.

## Request path

1. The browser sends a turn to the enterprise Worker.
2. The Worker authorizes the human, workspace, session, and `agent_id`.
3. The Worker starts an official Hermes run through `POST /v1/runs` and records both run ids.
4. Hermes streams lifecycle and tool events from `/v1/runs/{id}/events`.
5. The Worker translates those events into the existing message, step, status, and trace contracts.
6. The browser continues to receive the same session stream it uses today.

This keeps the browser away from the runtime bearer token and prevents a profile API from becoming a bypass around enterprise authorization.

## Tool boundary

Expose enterprise capabilities to Hermes through an MCP server with a narrow allowlist:

- read workspace context, documents, members, and requests;
- propose requests, instruction changes, and navigation focus;
- never directly approve, sign, pay, grant access, invite, or change roles.

Those guarded actions stay in the enterprise Worker and Inbox. Hermes may prepare a proposal; a named human records the decision.

## What the official runtime replaces

- the custom provider loop;
- manual tool-call iteration and retry handling;
- runtime session state;
- agent memory, skills, delegation, and scheduled work;
- direct OpenRouter calls from the Worker.

OpenRouter or another provider becomes model configuration inside Hermes. `Cloud` or `Local` remains where the Hermes profile runs, not which model it uses.

## What remains in Hermes Enterprise

- WorkOS identity, membership, and RBAC;
- agent-to-human binding and mandates;
- documents and private/shared context boundaries;
- approvals, money movement, signatures, and effects;
- audit history, retention, residency, usage caps, and notifications;
- durable enterprise ids and trace access control.

## Migration sequence

1. Persist and filter by `agent_id` on sessions, runs, and traces. **Implemented in this change.**
2. Add an `AgentRuntime` adapter and deploy one sandboxed Iris profile.
3. Route one test session through the official Runs API behind a feature flag.
4. Add the enterprise MCP tool server and map Hermes events to the current stream contract.
5. Compare complete conversations, approval proposals, stop/retry behavior, latency, and cost.
6. Move remaining sessions, then retire the custom engine.

Official references: [API server and Runs API](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server), [profiles](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md), [security and OpenShell](https://github.com/NousResearch/hermes-agent/blob/main/SECURITY.md), and [MCP tool filtering](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp).
