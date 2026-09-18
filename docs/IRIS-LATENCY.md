# Iris response latency

Investigated and implemented September 18, 2026. This records the evidence and
acceptance criteria; it does not claim a deployed improvement or measured p95.

## Findings

- A previous staging acceptance recorded about 17 seconds from Send to visible
  text, 3,688 ms from the adapter's execution timer to its first native delta,
  and another 20 ms to the first Worker preview. That is one historical sample.
  The adapter timer starts after admission, Workflow setup, submission and
  capability checks, so it is not provider time-to-first-token or Send-to-paint.
- The fresh interactive path performed one capability check during admission
  and two more inside the Workflow. The last immediately repeated the checked
  submission path. Actual remote call durations were not separately measured.
- At pinned Hermes source `5d59366010640c1d6b8f170d8a4ee109db2bbdef`, Claude
  caching behind the generic custom Worker hostname is disabled unless the
  exact proxy/model declares support. A native gateway regression failed
  before the configuration fix because outgoing requests had no cache markers.
- The model bridge's existing `model_calls.latency_ms` is measured at stream
  settlement. It includes the whole provider response and excludes preparation;
  it cannot establish first-token latency.
- Fresh read-only staging inspection found scheduled run
  `26d71fa5-065a-40cf-aaa9-efa302fc0346` failed after 36 seconds with no tools:
  `nous:stepfun/step-3.7-flash:free` was temporarily unavailable. Provider
  failures contribute to long waits independently of streaming behavior.

## Implemented change

1. A successful new submission hands its capability check to the first execute
   callback in memory, once, for at most five seconds. Normal fresh interactive
   runs make two remote capability checks instead of three. Slow submissions,
   clock rollback, existing native bindings, execution retries and restored
   Workflow checkpoints recheck the live contract. No readiness is cached
   across requests or persisted as proof for a later process.
2. The launcher declares prompt caching for exact allowed Claude wire models,
   including overrides from a non-Claude profile default, using a startup-only
   model manifest lookup and five-minute cache tier. Other models are unaffected.
   The Worker preserves cache markers and provider-reported cached token usage.
3. Content-free correlated timing separates admission, Workflow setup,
   capability requests, request preparation, native submission/binding,
   subscription start, first delta, first preview and durable checkpoint.
   Provider timing separates proxy preparation, response headers, first observed
   byte/frame/reasoning/content, completion and cached input tokens.

The selected model and reasoning effort are unchanged. Existing animation,
authorization, idempotency, budget, retry and cancellation behavior remains
covered. The smaller one-use optimization avoids introducing a new connector
submission protocol solely for latency before actual round-trip distributions
are available.

## Reading telemetry

- `hermes.turn_admitted`: admission capability duration, total admission time,
  Workflow creation time; joined by `run_id` and `trace_id`.
- `hermes.latency`: `phase`, `duration_ms` for a measured operation,
  `elapsed_ms` since this Workflow invocation, `turn_elapsed_ms` since server
  receipt of a new interactive turn. First-delta/preview/checkpoint milestones
  use invocation time for both duration and elapsed. Subscription-start means
  the request is about to open, not that response headers have arrived.
- Analytics Engine `hermes.latency` blobs are metric, workspace, run, model,
  ring, phase; doubles are phase duration, invocation elapsed, turn elapsed.
  A missing turn clock is -1 in Analytics and null in logs, never a zero.
- `runtime.provider_timing`: per-provider-call `call_trace_id` plus the run's
  identifiers. Timings ending in `_observed_ms` mean the bridge saw those bytes;
  downstream backpressure can contribute. Reasoning metrics record presence
  only, never reasoning text. Empty, usage-only and tool-argument frames do not
  count as first visible content.
- Existing `hermes.stream` column meanings remain unchanged. It is deliberately
  separate from startup timing.

These clocks do not measure browser paint or pre-route authentication/network
time. Server-to-Workflow elapsed time uses wall clocks across isolates; group
fresh attempts separately from resumes/retries when interpreting distributions.

## Verification

Regression coverage demonstrates:

- Before: two Workflow readiness calls on a fresh run; after: one. The admission
  check stays independent. A controlled 600 ms capability call plus an 800 ms
  submission is included in the 1,400 ms first-delta milestone.
- Durable replay and retries reattest; an expired/rolled-back fresh timestamp
  or failed readiness cannot open a stream. Telemetry failures do not fail runs.
- Actual pinned official gateway/AIAgent requests lacked Claude markers before
  the fix. Afterward, two fixture turns share cache-marked system prefixes and
  retain incremental text output. Unknown and non-Claude models have no markers.
- Provider chunks reach the caller before EOF and settlement. Split UTF-8,
  reasoning versus content, usage-only frames, cancellation, read errors,
  cache-control forwarding and authoritative cache accounting are covered.

The native integration probe uses a local fixture model and enterprise server,
not a paid provider. It proves the protocol and request shape, not real cache
hits, model quality, or a production latency reduction.

Verified locally on Node 26.8.2:

| Check | Result |
| --- | --- |
| Shared / client / Worker unit suites | 89 / 248 / 619 passed |
| Isolated PostgreSQL integration suite | 439 passed |
| Cloudflare Worker runtime suite | 29 passed |
| Browser streaming, clock and final-handoff scenarios | 10 passed |
| Python launcher/bridge/contract suite | 56 passed |
| Actual pinned native gateway/AIAgent probe | Passed |
| Workspace typecheck and application build/Worker dry run | Passed |

Database tests used a dedicated disposable local PostgreSQL container on port
5435, separate from existing developer and other task databases. An independent
review checked fresh-check reuse and replay behavior; its timing-label finding
was corrected to `stream_subscribe_started`.

## Rollout and live acceptance

This work builds on the separately committed runtime contract hardening
(`131c973`). The native connector/source/ring contract must match before a
Worker rollout; deploying the Worker alone can correctly refuse old profiles.
The current branch also integrates main `78d107d`.

For launcher-managed profiles, restart with the updated launcher after existing
work finishes. For stock Hermes Cloud, apply the exact cache capability mapping
in `runtime/hermes/README.md` to the existing profile and reload it. A Worker
deployment cannot update that Cloud configuration. Preserve profile data and
credentials. No live profile configuration, selected model or production
deployment was changed during this implementation.

After coordinated staging rollout, compare at least 30 bounded no-tool turns
per selected model/effort and cold/warm cache state. Record first visible text
in the browser alongside the server milestones; report p50/p95 and total
response duration. Require actual cached-input usage on repeat Claude turns.
Include tool, reconnect, Stop, retry, provider failure and completed-text
retention checks. Treat provider unavailability separately from successful
latency; do not hide failures by averaging only fast successful runs.

Sources: [Hermes custom provider configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models),
[Hermes caching and reasoning settings](https://hermes-agent.nousresearch.com/docs/user-guide/configuration).
