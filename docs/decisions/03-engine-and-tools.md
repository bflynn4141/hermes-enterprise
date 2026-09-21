# Engine and tool decisions

Run engine decisions 40 through 48 and tool-policy decisions E1 through E7.

[Back to the decision index](../DECISIONS.md).

## 40. The engine publishes by handing rows to the hub, not by enqueuing a job

**Found while building.** Invariant 6 says every cross-system side effect after
a commit is a `jobs` row. The engine's side effects are event deliveries, and
`publishEvents` writes exactly such a row. But migration 0004 says
`REVOKE ALL ON jobs FROM agent`, and the Workflow runs on the `agent` role.

**Decided.** The engine writes `stream_events` in the same transaction as the
change, as every writer does, and then hands the committed rows to the
`SessionHub` itself by RPC. It enqueues no `publish` job. If that RPC is lost,
the rows are already committed and the client's reconnect path —
`GET /w/:ws/events?after=` — replays them.

**Why not widen the grant.** Because the grant is the invariant. "The agent role
has no INSERT on `jobs`" is one of the three sentences that make "the runtime
never decides" checkable, and the reason it is worth having is precisely that it
is inconvenient once. A job row is also a thing the agent could forge — a
`receipt` job carries a `decision_id` — so `jobs` is not an incidental
revocation.

**What is lost.** The outbox's "a connected client cannot miss a committed
event" becomes "a connected client cannot miss a committed event for longer than
one reconnect" for run events specifically. Route-written events (requests,
decisions, entity updates) keep the stronger property, because routes run as
`app` and do enqueue the job.

**Would change it if.** A `SECURITY DEFINER` function that enqueues only a
`publish` job for a range of `stream_events` ids in the current tenant turns out
to be worth the extra surface. It is a small function and it would restore the
stronger guarantee; it was not written because the weaker one is already the
behaviour every client sees after any disconnect.

---

## 41. Two consequences of an engine event are done by the Cron, as `app`

**Found while building.** Two things the plan asks for are writes the `agent`
role cannot make:

* a provider 401 marks the key row `invalid` — `workspace_provider_keys` is
  SELECT-only for `agent`;
* the run queue drains after a run finishes and pauses on Stop — `run_queue` is
  SELECT-only for `agent`.

**Decided.** The engine does the half it can: on a 401 it sets
`stop_requested` on the other working runs on that provider (it has UPDATE on
`runs`) and records `error.reason = 'key_invalid'` on its own run. The minute
Cron, which runs as `app`, then marks the key row invalid from that recorded
reason and drains the queue. The Stop route pauses the queue itself, in the same
transaction as the flag, so pausing is immediate; only the drain is on the
minute.

**What this costs.** Up to a minute between a 401 and the model menu saying
"Your key was rejected", and up to a minute between a run finishing and its
queued message starting. Both are visible in the UI as the state they actually
are, not as a lie.

**Why this is better than the alternative.** The alternative is one more grant
or one more `SECURITY DEFINER` function per consequence, and the list of
consequences only grows. Making the `app` role the place where an engine event
turns into a workspace-level change keeps the boundary in one direction: the
agent proposes and reports, and something with more authority acts on it. That
is the same shape as the decision route.

---

## 42. The engine is a function over an abstract `step`, not a Workflow method

**Decided.** `src/engine/engine.ts` exports `runAttempt(deps, step, input)`
against an `EngineStep` interface with `do` and `waitForEvent`. `RunAttempt` in
`src/runs/workflow.ts` wires the real `WorkflowStep`, a `PgAgentDb`, the
provider adapter and the SessionHub RPC, and does nothing else.

**Why.** The failure taxonomy is the part of this milestone most likely to be
wrong, and it is untestable inside workerd: there is no way to say "this step
fails at 40 percent of its stream, retries twice and then gives up" to a real
Workflow in a test. With a fake `step` that checkpoints results by name and
re-runs the body on a retryable throw, every row of the plan's table is a test
that runs in 300 ms with no network. What workerd then has to prove is much
smaller — the class registers, the RPC exists, `NonRetryableError` is real —
and `test/worker/runs.test.ts` proves exactly that.

**The cost.** Two step-option shapes to keep in sync, and a cast in the adapter
because `step.do` is typed to return `Serializable<T>`. The cast is one line and
sits next to the rule it depends on (step returns are ids only).

**A bug this shape caught immediately.** `step` is an RPC stub: pulling `do` off
it and calling `run.call(step, ...)` fails at run time with "the RPC receiver
does not implement the method call". The adapter now calls through the object.

---

## 43. Deltas are batched at 500 ms, and Stop rides the reply

**Decided.** The provider step accumulates text and flushes every 500 ms: one
`stream_events` row and one `SessionHub.forward` RPC per batch. The RPC's reply
carries `stop_requested`, and the engine also reads the row before every tool.

**Why.** The subrequest limit is per instance. The plan's rejected arithmetic is
twelve five-minute turns at one RPC per 250 ms — 14,400 against a 10,000
default. At 500 ms the same pathological run is 7,200 and a realistic
30-second-turn run is about 900. `test/unit/engine-config.test.ts` holds the
arithmetic so the number is checkable rather than remembered.

**Why Stop rides the reply rather than polling.** A separate poll doubles the
per-batch cost to buy nothing: the batch is already a round trip to the object
that holds the flag's cache.

**Note on the outbox id.** `stream_events` is INSERT-only for the `agent` role,
so `RETURNING id` is a read it may not do. The id comes from
`currval('stream_events_id_seq')` instead, which the role does hold
`USAGE, SELECT` on. `test/db/agent-db.test.ts` is the test that caught this, and
it is the reason that file exists at all: the in-memory `AgentDb` the engine
tests use would have passed with the wrong SQL forever.

---

## 44. `message.reset` carries a real message id, written before the first delta

**Decided.** The provider step upserts the assistant `messages` row with
`status = 'streaming'` and empty text *before* it starts the stream, so
`message.reset` and every `message.delta` name a real message id. The row is
keyed `(run_id, turn)`, so a step retry and a user Retry both replace it.

**Why.** The alternative was a synthetic id like `${run_id}:${turn}`, which the
event contract rejects — `message_id` is a uuid — and which would have made the
reducer maintain two id spaces. Writing the row first also means a crash between
the first delta and the end of the turn leaves a visible partial message rather
than nothing.

---

## 45. `run_turns` sequence numbers separate a turn's inputs from its answer

**Decided.** Within turn *N*: the tool results that feed it occupy seq 0, 1, 2…
in the order the model asked for them, a human's answer to `ask_for_context`
sits at seq 90, and the assistant's own message sits at seq 100.

**Why.** `run_turns` is keyed `(run_id, turn, seq)` and the first version wrote
both the opening user message and the assistant's reply at `(0, 0)`. Fixed
positions are the smallest thing that makes the ordering total, replayable and
obvious when reading a row by hand.

---

## 46. Blocks arrive in a fenced region, and the validator runs before anything renders

**Decided.** A model authors blocks by emitting a ```` ```hermes-blocks ````
fenced JSON array inside its text. The engine strips the fence from what the
human reads, runs the array through the shared `validateModelBlocks`, keeps what
passes and logs what does not with the command name.

**Why a fence rather than a tool.** A `render_block` tool would be a tool whose
whole purpose is to put a button in front of a human, and the forbidden-name
test would not catch a block carrying `decide` inside its arguments. Keeping
blocks in the text means every one of them goes through the same validator on
the same path, and there is exactly one path.

**The red-team test.** `test/unit/engine-redteam.test.ts` scripts a provider
emitting a `confirm` block carrying `request/decide` and asserts three things:
the block is dropped, no `decision.recorded` event exists in the outbox, and the
request the run proposed is still `pending`. The text survives, minus the fence,
so the human still reads the claim and can disagree with it.

---

## 47. `MODEL_SCRIPTED=1` is a development-only switch, asserted in two places

**Decided.** With `MODEL_SCRIPTED=1` the engine answers from `ScriptedProvider`
and resolves no key, so `wrangler dev --local` on a fresh checkout can run a
turn end to end with nothing in the key store. `providerFactory` throws unless
`ENVIRONMENT` is `development`, and `test/unit/engine-config.test.ts` asserts
that neither staging nor production sets the variable.

**Two things this caught.** A `ScriptedProvider` built per call rather than per
invocation replays script zero forever, which looks exactly like an agent stuck
in a loop until the turn cap stops it; and an agent with no
`agent_capabilities` rows gets no tools, which is right in a deployed
environment and useless in a freshly seeded one. The provider is memoised per
invocation, and the empty-capabilities fallback to the Work-mode tool set
applies only when `ENVIRONMENT` is `development`.

---

## 48. The M0 spike runs under vitest, and only when a key is in the environment

**Decided.** `apps/worker/scripts/spike.ts` performs the M0 spike against a real
provider: one streamed tool call, Stop measured against the 1 s budget, and a
reasoning replay. It runs with `pnpm spike`, which is `vitest run --project
spike`, and `vitest.config.ts` only defines that project when `HERMES_SPIKE_KEY`
is set.

**Why vitest rather than `node scripts/spike.ts`.** Node 26 strips types but
refuses parameter properties, which the provider adapters use throughout; vitest
is already a dependency and already knows how to load this repository's
TypeScript. Making the project conditional means CI, which never sets the
variable, cannot run the one file in this repository that touches the network —
and neither can `pnpm test` on a machine that happens to have a key exported.

**The key.** Read from `HERMES_SPIKE_KEY` and never written anywhere: not to a
file, not to a log line, not into an error message. The file says so at the top,
because the failure mode is somebody pasting a key into `.dev.vars` to make it
convenient.

---

# Series E — M3.5, the engine side

Numbered separately because M3.5 was built by three people at once; the E series
is the run engine's half (tools, allowlists, the classifier, the prompt and
`src/security/**`).

## E1. `fetch_url` is a module of its own, and the rules are written out

**Decided.** The tool in the registry is thirty lines; every rule lives in
`apps/worker/src/security/fetch-url.ts` and `ip.ts`, with the private ranges
enumerated in code rather than pulled from a library.

**Why the ranges are written out.** The list *is* the security property. A
dependency that dropped `100.64.0.0/10` in a minor release would be a silent
hole in the one check that stands between an uploaded document and a cloud
metadata endpoint, and the whole list is thirty lines. `::ffff:127.0.0.1` is
checked as IPv4, because an IPv4-mapped address is the oldest way past a naive
loopback test.

**Why a module and not a tool.** The tool's job is to turn a refusal into a
sentence a model can act on. Everything else — the deny list, the allowlist, the
resolution, the hop budget, the caps — is testable with no engine, no database
and no network, which is why `test/unit/fetch-url.test.ts` can carry both of the
plan's fixtures and still run in 40 ms.

**The residual risk, stated.** A Worker cannot pin a DNS answer to a socket.
We resolve, we check, and then `fetch()` resolves again on its own. Re-resolving
every hop narrows the window; it does not close it. The flipping-A-record
fixture documents the limit rather than pretending otherwise.

---

## E2. The allowlist lives in `workspace_settings.flags`, and empty means nothing

**Decided.** `flags.fetch_url_allowlist` is an array of domains an Admin
manages. No new table, and no grant change: the `agent` role already has SELECT
on `workspace_settings` (migration 0004).

**Why not a table.** One list per workspace, edited in Settings, read once per
`fetch_url` call. A table with one row per workspace and one column that matters
is a join in every read to answer a question a JSONB key already answers. If a
per-domain audit trail is ever wanted, that is the moment for a table.

**Why empty refuses everything.** A workspace that has not said where its agent
may read has said it may read nowhere. The alternative — empty means
unrestricted — is the configuration mistake that only shows up in the incident
report. A malformed flag (a string, a number, an object) also reads as empty,
for the same reason.

---

## E3. Modes are enforced by an intersection, and Plan prepares rather than writes

**Decided.** `allowedTools(mode, capabilityNames)` intersects the mode's tool
kinds with `agent_capabilities.tool_names`. Ask gets read tools only; Plan gets
Work's list but `executeTool` returns a `prepared` block for the four tools that
write; Work writes.

**Why the intersection.** It cannot widen in either direction: a mode cannot add
a tool the workspace did not configure, and a capability row cannot add one the
mode does not allow. An unknown mode string falls back to Work's *kinds*, still
intersected — a typo in a mode must not hand out tools nobody configured.

**Why Plan still validates.** A prepared `propose_request` runs the document
schema and the plain-text walk before returning. A plan whose payload would fail
when applied is not a plan; it is a failure moved to later, when the person has
already agreed to it.

**Why `ask_for_context` is not prepared.** It writes nothing — it parks the run
on a human answer — and a plan that cannot ask the question it needs answered is
not a plan. `set_focus` stays live in Plan for the same reason and is excluded
from Ask, where a pane that moves while somebody reads is something else
happening.

---

## E4. `runs.mode` is written at turn creation (migration 0011)

**Decided.** The mode is copied onto the `runs` row when the turn is created and
read from there. `PgAgentDb.loadRun` coalesces to the session's mode so a code
rollback still reads correctly on rows written before the column existed.

**The failure this prevents.** The engine used to join `sessions.mode` on every
`loadRun`. A person switching the selector from Plan to Work mid-run would have
changed what the run already in flight was allowed to do — the run would start
as a plan and finish by writing rows. "Plan writes nothing" is not a promise you
can keep if the answer is re-read every step.

---

## E5. The classifier labels; it never blocks

**Decided.** A deterministic pattern list (`src/security/injection.ts`) runs
over every tool result whose source is not `engine`, and adds `suspicion`,
`suspicion_rules` and a one-sentence reminder to the envelope. It never fails a
tool, never ends a run and never rewrites the data.

**Why deterministic rather than a model call.** A second model call inside a
tool step doubles the latency and the failure surface of every read; its input
is attacker-controlled text, so it is one more thing to inject; and a regexp
list is auditable — a reviewer reads the threat model in forty lines and a test
asserts each line.

**Why it must not block.** A classifier that can stop a run has false positives
that are outages, and one a model can argue with is not a control anyway. The
control is the human decision gate. Anthropic's own reporting puts residual
attack success near one percent even with training-level defenses, which is the
number that says this layer is worth having and also says it is not the last
one.

**The false-positive fixtures matter as much as the attacks.** An agent that
labels every CV "high" has taught everyone to ignore the label by Thursday, so
`test/unit/injection.test.ts` asserts silence on an ordinary application, an
ordinary invoice and a note that merely discusses approving something.

---

## E6. Plain text is refused at the writer, not escaped at the renderer

**Decided.** `plainText` and `findMarkup` in `packages/shared/src/plain-text.ts`
reject HTML tags, markdown links, angle-bracket autolinks, control characters
and bidi overrides. The tool schemas apply them to note bodies, instruction
bodies, context values and — by walking the parsed object — every string and
every key inside a proposal payload.

**Why the writer.** A renderer that escapes is one component away from a
renderer that does not, and that component will be the one somebody adds for
"just the invoice notes". A string that never reaches a row cannot be rendered
by anything.

**Why walk the payload instead of listing fields.** A document payload has forty
string fields across three kinds. Enumerating them in a second place is how the
two lists come apart; walking the parsed value covers a field added to
`documents.ts` next year on the day it is added.

**Why a bare URL is allowed.** It renders as text, it is not clickable, and
forbidding it would stop the agent citing where it read something — which is the
behaviour every other rule here is trying to encourage.

---

## E7. Late guidance is carried, not refused

**Decided.** Guidance typed after the run it was aimed at has finished is stored
on the session with `run_id` null; the route answers
`{status: 'next_message', copy: 'Applied to your next message'}` instead of a
409, and `PgAgentDb.loadGuidance` has the next run in that session read it
before its first provider step, at which point the row records which run finally
applied it.

**Why not a 409.** The person typed a sentence a fraction of a second after the
run stopped. Throwing it away to be technically correct about which run it
belonged to is the product being right at the user's expense; the copy the plan
names only becomes true if something carries it.

---

# M4: decisions, effects, receipts, History and documents

---
