# Iris response latency

## Compatible Worker release — September 18, 2026

This release removes one redundant capability request from a fresh Iris turn
and adds content-free timing across the existing streaming path. It keeps the
currently deployed Hermes Cloud protocol, model selection, reasoning effort,
error classification, authorization, budget and cancellation behavior.

A successful native submission can reuse its capability result once, in the
same in-memory Workflow invocation, for at most five seconds. Admission remains
independent. Existing bindings, restored checkpoints, execution retries, slow
submissions and backwards clocks recheck the live capability contract. Nothing
is cached across requests or persisted as proof of runtime readiness.

Fresh interactive runs therefore need two remote readiness checks instead of
three. This removes one network round trip; its actual user-visible benefit
must be measured on staging, not inferred from unit-test timings.

## Evidence and measurement

One historical staging sample took about 17 seconds from Send to visible text.
Its adapter reported the first native delta after 3,688 ms and the first Worker
preview another 20 ms later. The old adapter clock excluded admission, Workflow
startup, submission and readiness checks, so it was not provider time-to-first
token or Send-to-paint. The new instrumentation separates those intervals:

- `hermes.turn_admitted`: admission capability duration, total admission time
  and Workflow creation, correlated by run and trace.
- `hermes.latency`: Workflow setup, submit/execute capability checks, request
  preparation, native submit/binding, subscription start, first nonempty delta,
  first preview and first durable checkpoint. It records operation duration,
  elapsed time in this invocation and, when supplied, elapsed time since the
  server received the interactive turn.
- `runtime.provider_timing`: proxy preparation, response headers, first
  observed byte/frame/reasoning/content, completion and provider-reported cached
  input tokens, correlated per provider call and run.

Provider milestones ending in `_observed_ms` measure when the bridge sees the
data; downstream backpressure can contribute. Reasoning metrics record presence
only, never reasoning text. Empty frames, tool arguments and usage-only frames
do not count as first visible content. Telemetry must never fail the turn.

These clocks do not measure browser paint or pre-route authentication. Cross-
isolate elapsed time uses wall clocks. Group fresh attempts separately from
resumes, retries and provider failures when interpreting distributions.

Analytics Engine `hermes.latency` blobs are metric, workspace, run, model and
phase; doubles are operation duration, invocation elapsed and turn elapsed.
Unavailable turn time is `-1` in Analytics and `null` in logs. This compatible
release does not claim an attested release ring or alter existing metric shapes.

## Regression coverage

Tests cover fresh-check reuse, persisted replay, retries, expired checks,
backwards clocks, readiness failure, telemetry failure, incremental forwarding
before EOF, split UTF-8, reasoning versus content, empty frames, cancellation,
read failure and authoritative cached-token accounting. Existing browser
streaming and completed-text retention coverage remains in the release gate.

The main-based regression failed before the port in four cases. Afterward, all
103 focused Worker tests and the full workspace typecheck passed. Full CI and
staging acceptance remain release gates; no measured p50/p95 improvement is
claimed yet. The release task records the final deployed revision and live
acceptance result without conflating a local fixture with a real provider run.

## Separately staged runtime changes

[PR #44](https://github.com/bflynn4141/hermes-enterprise/pull/44) retains the
previously prepared strict native source/ring/error contract and Claude prompt
cache configuration. Those are intentionally **not** enabled by this compatible
Worker release. They require authenticated Hermes Cloud management, verification
of the actual native source, a matching connector update, and governed profile
configuration before enforcement can be deployed. Do not set a source revision
merely to satisfy a health check.

The current staging Cloud process does not use the local launcher, so changing
launcher configuration or deploying a Worker alone cannot enable Claude caching
there. No Cloud profile data, credentials or model defaults are changed here.

After that coordinated runtime rollout, collect a bounded benchmark stratified
by model, reasoning effort and cold/warm cache state. Record browser first text
alongside server timing, actual cached-input usage and failed runs. A successful
smoke turn proves connectivity and completion, not a latency distribution.
