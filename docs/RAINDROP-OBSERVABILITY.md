# Raindrop observability

Hermes exports one Raindrop AI event after an official Hermes run reaches a
durable terminal state. The browser already has the terminal message before the
export starts. Raindrop timeouts, invalid credentials and outages therefore do
not change the run status or delay the visible response.

## What leaves Hermes

The event contains operational metadata: environment, runtime, model, mode,
terminal status, attempt, active duration, whether a final answer exists, its
character count, and tool names plus lifecycle states. Workspace, agent,
session, run and trace identifiers are one-way hashed before export.

Prompts, assistant text, names, email addresses, phone numbers, tool arguments,
tool results, provider errors and approval payloads are not selected by the
export query and cannot be serialized by the exporter. Raindrop receives a
synthetic summary such as “Run completed … final response recorded … Tools:
list_requests (done).” This makes operational failures classifiable without
creating another store of candidate or customer data.

The exporter also attaches a negative agent signal when a run ends in error or
uses at least one tool without recording a final assistant response. Other
semantic quality signals should be added only after a privacy review explicitly
approves sending more content.

## Configuration

`RAINDROP_OBSERVABILITY_MODE=active` enables the code path. It still does
nothing without `RAINDROP_WRITE_KEY`, which must be stored as a Worker secret.
`RAINDROP_PROJECT_ID` is optional when the key already targets the intended
project.

```sh
pnpm --filter @hermes/worker exec wrangler secret put RAINDROP_WRITE_KEY --env staging
```

Staging declares the mode active. Development and production default to off.
After adding the staging secret, deploy the Worker and run one completed run,
one provider failure, and one tool-use run. Raindrop should show one event per
attempt, and the two failure cases should carry the corresponding negative
signal. Local Worker logs record the Hermes run id beside Raindrop's hashed
event id for correlation.

## Failure behavior

Each request has a 2.5-second deadline. Failures are reduced to HTTP status (or
no status for a network error) and passed through the existing redacted log
path. The write key and request body are never logged. Replays use a stable
event id derived from run id and attempt so a Workflow retry does not invent a
second logical event.

