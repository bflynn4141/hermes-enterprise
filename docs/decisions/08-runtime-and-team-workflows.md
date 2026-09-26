# Runtime and team workflow decisions

Current runtime, recovery, observability, team workflow, and managed-capacity decisions C48 through C89.

[Back to the decision index](../DECISIONS.md).

## C48. Iris executes in one official Hermes profile; the app owns enterprise authority

**Decided September 15, 2026.** The project owner approved the official Nous runtime and one
agent per profile, including the necessary architecture change. The native
Hermes process owns the agent loop and session transcript. The existing Worker
continues to own identity, tool permissions, review decisions and the auditable
record. OpenRouter supplies the selected model through the Worker’s credential
proxy; it is no longer the implementation of the agent loop.

An `agents.id` binds a separate profile/process and every session/run. Native
run/session/attempt identifiers are recorded alongside enterprise IDs. Traces
distinguish official execution from earlier runs, and remain scoped to the
agent and the viewer’s authorized sessions. State directories do not claim OS
sandboxing. Broad native tools and automatic memory/skill extraction stay off
until the enterprise ownership and retention lifecycle is integrated.

**Why.** A custom chat/tool loop cannot truthfully stand in for the official
Hermes agent. At the same time, using that runtime must preserve human approval
authority and the app’s existing isolation. Native plugin ContextVars provide
trusted correlation; model arguments and static MCP headers do not.

**Evidence and limits.** See [Official Hermes Agent runtime](../HERMES-AGENT-RUNTIME.md)
for the pinned source, actual conversation checks, configuration, and hosted
rollout requirements. Verified locally; no hosted runtime deployed by this work.

---

## C49. A model sync may add hundreds of rows; one response may not retire hundreds

**Context.** A real OpenRouter key synced 441 models into the local `hermes`
database. The aggregate Worker test command then ran its database project
directly. `db-config.mjs` defaulted that project back to `hermes`, four fixture
workspaces each synced the five usable rows in the seven-row OpenRouter fixture,
and `sync_openrouter_catalog` truthfully but disastrously marked the other 439
rows “No longer listed by OpenRouter.” OpenRouter still listed them.

**Decision.** Local aggregate tests again run the database project through
`scripts/db-test.mjs`, which owns `hermes_test`; a bare Vitest run also forces
both `PGDATABASE` and local Hyperdrive bindings to `hermes_test`. CI is the only
exception because its `hermes` service is disposable and already occupies port
5433. Independently, catalog sync refuses an empty response or a refresh below
half of an active catalog of at least twenty rows. A failed completeness check
preserves the last catalog and leaves the verified key available for retry.

**Why both.** Test isolation fixes the observed cause. The completeness guard
protects staging and future local work from the same outcome if a CDN truncates
a response, OpenRouter changes its schema, or another caller accidentally uses
a fixture. Retiring models is reversible; silently retiring hundreds from one
small response is still the wrong default.

**Would change it if.** OpenRouter publishes a versioned snapshot or explicit
deletion feed, at which point retirement should follow that signal instead of a
ratio guard.

---

## C50. The visible navigation control owns its action and its menu

**Decided September 15, 2026.** Every left-rail control must produce a visible
result: primary items open their page, New session and recent sessions open
Iris, session search opens and closes, and the collapse control can restore the
expanded rail. Workspace actions use the exact labels emitted by `SidebarNav`:
Switch workspace opens the root picker, Workspace settings opens Organization,
and Invite team members opens Members.

The library's visible footer button is the one account-menu trigger. The app
recovers that button through the public `footerIcon` slot and anchors the
popover to it; it does not render a second hidden trigger below a full-height
sidebar. The footer is a left-aligned 40 px row with the same inset and vertical
rhythm as primary navigation. Expanded rails keep 8 px side gutters, while the
52 px collapsed rail gives that space back so icons stay centered.

**Why.** The workspace callback previously compared `settings` and `members`
against full labels, so two menu items silently did nothing. The account menu
was anchored to a second button clipped below the rail, not the button a person
clicked. A broad session-row CSS selector also styled primary-navigation icon
spans as multiline copy. These looked like isolated polish problems but shared
one cause: behavior and layout were attached to elements other than the visible
control.

**Evidence.** `panel-sidebar.spec.ts` exercises every page destination,
workspace action, account shortcut, search, recent selection, New session,
collapse/expand, reduced-motion toggle and focus restoration. It also measures
40 px primary targets, at least 4 px between them, and the shared left edge of
the account and navigation rows.

**Would change it if.** `SidebarNav` exposes a first-class account trigger ref
or account-menu slot, at which point the marker bridge can be removed without
changing the visible behavior.

---

## C51. Applicant scores stay attached to evidence and provenance

**Decided September 15, 2026.** An application review leads with one plain-language
takeaway, then shows the structured criteria and the source channels Iris used.
Each criterion retains its own `source_ids`; LinkedIn, GitHub, YouTube and X use
compact visual marks, and source details remain one click away. Labels are
normalized for people (`Track Record`, `Capacity`, `Fit`) without changing the
stored criterion ids.

**Why.** Current screening tools make a recommendation easier to audit by tying
competency judgments to supporting evidence. Metaview links scorecard entries to
their underlying evidence, HireVue recommends defined competencies and scoring
rubrics, and PeopleGPT combines public profile signals across sources. Hermes
uses that shared pattern while keeping the Inbox denser than a recruiting ATS.

**Truth boundary.** The UI says `Cited by Iris` or `Sources used`; it does not say
`Verified` until the runtime records successful retrieval and identity matching.
Local fictional records are visibly marked `Illustrative`. A source logo proves
provenance only when the request payload carries that source id.

**Evidence.**
- https://www.metaview.ai/resources/blog/candidate-review
- https://www.hirevue.com/resources/research-paper/hirevue-structured-interviews
- https://juicebox.ai/blog/announcing-peoplegpt-2.0

---

## C52. The workspace uses the 80% type scale without scaling its controls

**Decided September 15, 2026.** The project owner chose the visual density of the workspace
at 80% browser zoom as the typography target. Client-owned font sizes and line
heights are therefore 80% of the previous scale, with a 10 px floor for the
smallest labels, including display type, conversation text, list rows, menus,
onboarding and document previews. The few hard-coded pixel sizes inside
`SidebarNav` are bridged from client CSS so the library rail and the native
panes read at one scale.

Widths, icons, padding and interactive target heights stay unchanged. In
particular, the navigation rows remain 40 px with their existing 8 px rail
gutters. This is intentionally a type-scale change, not `zoom: .8`: CSS zoom
would also turn a 40 px target into 32 px, disturb the panel-width arithmetic
and make the interface less usable for everyone rather than merely denser.

**Evidence.** `panel-sidebar.spec.ts` measures the vendored navigation label at
11.2 px and a native 32 px display heading at 25.6 px, then separately verifies
that all seven navigation targets remain at least 40 px high. The rendered
workspace is retained in `qa/panel/sidebar-after-shell.png`.

**Would change it if.** User testing shows that the compact type is difficult
to read at 100% system scaling. The next step would be a user-selectable density
preference, not another browser-wide transform.

---

## C53. Payment and signature approval capture intent before provider execution

**Decided September 15, 2026.** Invoice and agreement review use three visible
steps: review the complete document, prepare the payment or signature, and
confirm the exact authorization. The full document remains available throughout.
Payment review names the source account, payee, amount, and timing; agreement
review places the signer's entered name and consent directly in the signature
block. The final decision stores an audit note describing that authorization.

**Execution boundary.** Approval still creates the document and pending effects.
It does not manufacture a bank transfer or applied signature. The local demo
labels its bank connection as a prototype with no funds connected, and both
flows say that provider execution remains separate. A production connector must
turn the pending effect into an idempotent provider operation, persist the
provider reference, reconcile webhooks, and expose failure or reversal without
changing the human decision already on file.

**Why.** The reviewer needs to see the entire legal or financial artifact and
the concrete consequence before committing. Keeping the effect separate also
preserves the existing two-person finance requirement and prevents a document
approval from silently becoming external execution.

---

## C54. Onboarding previews approval boundaries instead of pretending to configure them

**Decided September 15, 2026.** The final workspace-creation step shows one
plain flow — Iris prepares, a reviewer decides, then the approved action runs —
followed by compact cards for the protected outcomes and their initial reviewer
roles. The groups cover the implemented approval vocabulary: plans and team
coordination, access and records, external communication, money movement, agent
and team changes, and shared learning. Payment names Finance explicitly.

This is a read-only policy preview. It has no toggles or workflow canvas because
a new workspace has only its creator, and the server owns the real policy and
authorization snapshot. Finance and specialist reviewers are added later when
the relevant people exist. Motion is intentionally limited to existing control
feedback; governance text does not animate or delay the create action.

**Why.** Ramp's admin setup first previews the active route, names role-based
reviewers and separation of duties, and reserves its workflow builder for later
configuration. GitHub environment approvals keep protected secrets unavailable
until review. Microsoft recommends that agent admins inspect capabilities,
data sources and custom actions, and that irreversible actions stay behind
approval. The onboarding screen therefore teaches the safety model without
asking a first-time admin to design a policy graph prematurely.

**Evidence.**
- https://support.ramp.com/setting-up-spend-request-approvals
- https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
- https://learn.microsoft.com/en-us/microsoft-365/copilot/agent-essentials/agent-lifecycle/agent-copilot-studio-requested
- https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/agent-design-canvas-framework

---

## C55. Nous Portal supplies inference; Hermes Agent remains the runtime

**Decided September 15, 2026.** Workspace model inference uses the Nous Portal
OpenAI-compatible API at `https://inference-api.nousresearch.com/v1`. Durable
catalog IDs use `nous:<vendor>/<model>`, and all deployed environments set
`ALLOWED_PROVIDERS=nous_portal`. The default is
`nous:anthropic/claude-sonnet-5` with medium effort. Existing OpenRouter code is
kept for historical records and transport regression tests, but is not offered
by the current product path.

The official Hermes Agent runtime still owns planning, transcript continuity,
tool orchestration and execution. Its agent-scoped Worker proxy supplies the
selected model and resolves the workspace's encrypted Nous Portal key on each
call. `HERMES_BRIDGE_SECRET` authenticates the runtime to that proxy; it is not
an inference credential and does not replace the workspace key.

Nous Portal's `/models` route is public, so it cannot validate a credential.
Key verification therefore sends one minimal one-token chat-completions request
before syncing the public catalog. The local fixture reproduces both responses
only in development and is absent from staging and production configuration.

**Why.** One product provider keeps setup and billing legible while still
offering the Portal catalog. Keeping the runtime and inference credentials
separate preserves tenant billing, rotation and audit attribution without
copying workspace secrets into Hermes profiles. A public catalog response alone
would create false-positive verification for invalid or revoked keys.

**Would change it if.** Nous Portal publishes a free authenticated key-introspection
endpoint, in which case verification should use it instead of a billed minimal
completion. Adding another customer-facing provider requires a separate policy,
catalog and UI decision rather than merely compiling another adapter.

---

## C56. Session refresh and runtime transport are resolved at their adapter boundaries

**Decided September 16, 2026.** A successful WorkOS session refresh is unsealed
again before authentication continues. WorkOS Node 10.13 returns the rotated
sealed session without a separate access token, so the application reads the new
JWT from that cookie instead of treating a missing response field as an empty
token. Transient refresh failures retain the existing cookie; terminal failures
still sign the user out.

Every Hermes operation also honors the transport on the agent's runtime binding.
Native profiles use the Runs paths directly; managed Cloud profiles use the one
fixed dashboard connector envelope for capabilities, submit, status, events,
steer and Stop. Health, browser admission and execution must use the same binding.

**Why.** The old refresh adapter turned ordinary access-token expiry into `not a
JWT` after a user had been signed in for several minutes. Separately, health and
execution honored `dashboard_connector` while the browser turn route silently
constructed a native client, so health was green but a real turn was rejected.
Both failures came from reconstructing an upstream contract instead of carrying
the adapter's authoritative result forward.

**Evidence.** The staging browser session refreshed without another login. A
real Iris turn then completed through Hermes Cloud with model
`nous:deepseek/deepseek-v4.1-flash`, native runtime identity and agent-scoped
traces. Regression coverage asserts the WorkOS refresh response shape and the
Cloud connector used during turn admission.

---

## C57. Chat acknowledges locally, then reconciles against the durable turn

**Decided September 16, 2026.** Pressing Send immediately projects the person's
message and one working state in the transcript. The projection carries the
turn's client idempotency key; the turn route persists that key on the user
message and emits it with `message.appended`, so either `run.started` or the
message event can reconcile the local state without a duplicate. A refusal
removes the projection and restores the draft. The UI never projects success,
tool use, or completion before an authoritative event.

Hermes Cloud streams native SSE with available-byte reads rather than an 8 KB
buffer-filling read. The Worker durably coalesces deltas over 75 ms and always
performs a trailing flush, so a pause cannot hold text until the one-second
runtime status poll. The connector disables intermediary response transforms
and buffering where supported. The coalescing clock starts again after a
durable write is delivered; database latency therefore cannot make an
already-buffered native burst fall into one write per token.

**Why.** The network round trips needed for admission and durable execution are
real, but they should not delay acknowledgment of the person's own action.
Separately, model tokens are useful only when each transport layer preserves
their cadence. Exact id reconciliation retains the fail-closed server contract
while making the feedback loop immediate.

---

## C58. Live text uses a transient WebSocket fast lane over durable checkpoints

**Decided September 16, 2026.** Native Hermes text is sent to the authorized
session Durable Object as a `message.preview` frame before its Postgres
checkpoint completes. The frame carries the run, step attempt, character offset
and fragment, but no stream id: it is a display hint, not history. Durable
`message.delta` events and `message.final` remain authoritative and replayable.

The client tracks its committed prefix separately from the text currently on
screen. A preview can append only at a matching offset. When the overlapping
durable delta arrives, it advances the committed prefix without appending a
second copy. Gaps and conflicts are ignored until replay or the next checkpoint
repairs them. A reconnect therefore may lose a momentary preview but cannot
lose, duplicate or invent transcript text.

Durable writes run serially on a dedicated restricted database connection beside
native stream consumption rather than blocking it or overlapping control
transactions on the run's connection. Only one checkpoint may be in flight;
additional tokens coalesce behind it, and the run drains every checkpoint before finalization. Preview
delivery is best effort, session-authorized and failure-tolerant, so a broken
socket falls back to the existing replay and polling paths without failing the
agent run.

**Why.** Postgres is the right source of truth and the wrong paint loop. Making
every visible fragment wait for a cross-region commit coupled perceived model
speed to database latency. The fast lane preserves the audit and recovery
contract while letting the UI reflect the runtime as soon as text reaches the
Worker.

---

## C59. Live chat separates runtime activity from answer text

**Decided September 16, 2026.** The official Hermes Runs stream is the source
for both parts of a live turn. `message.delta` continues through the transient
WebSocket preview lane and the durable transcript checkpoints. Native
`tool.started` and `tool.completed` events are also projected into ordinary
`run.step` events, so the chat can name the work Hermes is actually doing before
the answer begins. Tool steps use per-run generated identifiers because the
native lifecycle payload names the tool but does not expose a stable call id.

Hermes' internal `_thinking` event remains intentionally absent from the Runs
stream. The Enterprise UI does not fabricate reasoning text or animate a fake
answer during that interval. A quiet model-only interval is shown as one
thinking state; real tool activity replaces that label when it arrives.

**Why.** Codex-like responsiveness comes from multiple typed streams: activity
events while the agent works and text deltas while it writes. Forwarding only
the text stream made a healthy turn appear frozen during model reasoning or
tool use. Converting actual Hermes lifecycle events preserves auditability and
keeps the UI honest about what has and has not happened.

---

## C60. A run changes the composer's intent, not its identity

**Decided September 16, 2026.** The composer keeps mode, model, runtime and the
send button in the same bottom control area before, during and after a run.
Those selectors become read-only while the current run owns their values, but
their labels stay visible. The send button is anchored to the lower-right of
the control area rather than participating in its wrapping layout.

When a run is active, its two possible message intents appear as a compact
`Steer` / `Queue` switch above the input. The placeholder reflects the selected
intent. The switch enters with the existing short reveal and becomes immediate
under reduced motion.

**Why.** Removing the model after Send hid consequential context at the moment
a person most needed to understand a run. Putting the intent selector among
the persistent controls also caused the send button to jump to another row as
the Iris pane was resized. One stable composer preserves orientation while
still making clear whether the next message affects this run or follows it.

---

## C61. Agent activity is a truthful ambient signal, not a decorative loop

**Decided September 16, 2026.** Agent Overview carries one compact activity
surface that remains visible when the conversation is collapsed. It answers
three questions without opening chat: whether Iris is working, waiting, stopped
or idle; which task owns the current state; and, when a tool event exists, the
exact tool name beside a short human translation. `get_document_text → Reading
a source document` is intentionally both machine-legible and understandable.
The full arguments and results remain in the trace.

Live session state wins across the agent's sessions. When no run is live, the
newest server-sorted trace supplies the last real activity; a fresh workspace
says `No active work right now`. Only `working` animates. Waiting, stopped and
idle states are static, and the member's reduced-motion preference disables the
working mark and pulse as well. No timer cycles through fake steps, and this UI
does not claim to add background scheduling: actual proactive work still needs
a real workflow or scheduled run to emit these events.

**Why.** GitHub's agent panel uses live session status and a drill-down session
log; Replit separates Draft, Active, Queued, Ready and Done, then pairs finished
work with its work log and test results; Cursor's background-agent surface keeps
status available outside the main conversation. The shared pattern is ambient
state first, evidence on demand—not an animated avatar with no operational
meaning.

**Evidence.** `agent-activity.test.ts` covers live, waiting, recent-trace and
idle derivation. `agent-activity.spec.ts` proves a real mock run remains visible
after Iris collapses, pairs a tool with its human wording, keeps idle still and
removes all activity animation when reduced motion is on.

- https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents
- https://docs.replit.com/core-concepts/agent/task-system
- https://docs.cursor.com/background-agent

---

## C62. Workspace identity is carried by artwork and real member presence

**Decided September 16, 2026.** The workspace picker uses a responsive card
grid rather than administrative list rows. Each workspace gets one of three
project-owned technical-art illustrations selected by its purpose (interview,
partner network or finance/analysis), with the workspace name, the viewer's
role, the real member count and up to four real member avatars or initials. A
workspace can be opened from the whole card; creating another workspace is a
quieter dashed card in the same grid.

The visual direction combines the product's existing deep navy, cobalt and
condensed display face with the more tactile Nous language visible across its
public research and Portal surfaces: constrained ink colours, technical
diagrams, halftone grain and archival/manual geometry. The illustrations have
no embedded text, logos or invented people. They are compressed WebP assets,
and the build copies the public asset tree into the exact directory served by
the Worker.

**Data boundary.** `GET /auth/session` without a workspace id now includes a
presentation-only preview of four active members and a count, selected only
from workspace ids the authenticated user already belongs to. It omits email,
reviewer authority and membership metadata; the full records remain on the
workspace-scoped `/members` route. Initials are the fallback when WorkOS has no
profile image.

**Motion and access.** Hover raises the card three pixels and slightly enlarges
its artwork to clarify that the whole surface is interactive. Keyboard focus
uses the existing visible outline. The global reduced-motion path removes both
transforms, and the 390 px layout becomes one column without horizontal
overflow.

**Evidence.** Shared, client and Worker unit suites pass; Chromium covers empty,
single and multi-workspace directories and their member previews. A rendered
pass verified the current one-workspace layout, the 390 px layout, artwork load,
keyboard focus and an empty browser error log.

- https://nousresearch.com/
- https://portal.nousresearch.com/
- https://nousresearch.com/wp-content/uploads/2025/08/Hermes_4_Technical_Report.pdf

---

## C63. Idle activity describes the finished task, not a runtime phase

**Decided September 16, 2026.** The Overview card uses the task/session title
for a terminal run. The generic Hermes `Thinking` step is execution metadata;
its completed label must never appear as the last task beside `Idle`. A
completed response without a tool call says `Response completed · No tool calls`.

When a tool was called, a dedicated wrapping row keeps its name and plain-language
outcome visible. Native Hermes steps preserve the raw tool identifier, matching
enterprise bridge steps. Older humanized labels remain intact in history and
can still receive a readable translation. A failed tool says it failed; an
unfinished tool on a terminal run never claims success or ongoing execution.

Motion follows real state: the tool indicator pulses only during an active call
on a working run. Tool/state changes use the existing 160 ms, 4 px reveal;
completed and waiting calls remain still. App and system reduced-motion settings
remove the loops and reveal travel. Task and tool text wrap at narrow pane widths.

**Verification.** The observed staging trace was completed with one done
`Thinking` step and no tool calls. Regression tests reproduce that exact shape,
terminal tool states, and failed versus stopped runs. Mock browser coverage
checks the no-tool card, last-tool visibility in a narrow pane, collapsed Iris
activity and reduced motion. Activity browser tests now run in the CI mock suite.

---

## C64. Live output is paced from real bytes and activity names observable work

**Decided September 16, 2026.** Native Hermes output remains authoritative,
but the browser no longer paints each network burst as one visual jump. It
buffers received text and reveals complete grapheme clusters on animation
frames. Small backlogs move one or two characters per frame; larger backlogs
accelerate, and a final response catches up in a short accelerated tail. The
renderer never invents text, delays persistence or replaces the shared partial
Markdown parser.

`message.final` now commits the message while retaining its stream accumulator
until the visual reveal reaches the exact final text. During that handoff the
committed answer is hidden, preventing a duplicate bubble or an atomic swap.
Run and attempt keys protect a newer stream from a late final or completion
event. Reduced motion presents each received buffer immediately.

The activity line follows real phases: reasoning before visible output, the
human meaning of an active tool, and writing after answer text begins. Exact
runtime tool identifiers and their active/completed/failed state remain visible
throughout the working run. Hermes `reasoning.available` records a completed
reasoning boundary, but its preview text is deliberately not forwarded or
rendered; observable phase and tool events are useful product status, while a
provider preview is not a contract for private model reasoning.

**Evidence.** Reducer tests cover authoritative final handoff, retries, stale
events and incomplete messages. Reveal tests cover grapheme safety and adaptive
pacing. Runtime tests prove the reasoning boundary is recorded while its text
is absent from emitted events. Run-surface tests cover reasoning, progress,
writing and exact live tool activity. Client and Worker suites, workspace
typecheck, the production client build and Worker dry run pass.

- https://github.com/NousResearch/hermes-agent/blob/5d59366010640c1d6b8f170d8a4ee109db2bbdef/gateway/platforms/api_server_runs.py

---

## C65. The luminous scrollbar is a shared native control

**Decided September 16, 2026.** Every scroll surface uses the same semantic
scrollbar tokens. The visual keeps the supplied reference's fine purple rail,
bright focal point and fading energy line, adapted to both vertical and
horizontal overflow. It therefore applies consistently to chat, app panes,
document viewers, dialogs, editors and tables instead of depending on the
historical `.scroll` helper.

The sidebar session list clips horizontal overflow because its titles already
wrap or truncate; the horizontal scrollbar is reserved for surfaces such as
wide tables and documents where sideways navigation is intentional.

The implementation styles the browser's native scrollbar rather than replacing
it with JavaScript, preserving wheel, trackpad, keyboard and pointer behavior.
Chromium and WebKit receive the full layered gradient. Firefox receives the
bright purple core as a deliberate fallback because its scrollbar API does not
accept gradients. The treatment is static, so it does not imply progress or
movement and needs no separate reduced-motion behavior.

**Evidence.** Client typecheck, the production build, 224 unit tests and 56
Chromium browser scenarios pass. A native in-app-browser render at constrained
height confirmed the rail, energy line and focal glow on simultaneous
conversation and application scroll surfaces.

---

## C66. Live elapsed time belongs to the run, not the mounted component

**Decided September 17, 2026.** The active chat timer derives from the durable
`run.started` event timestamp. The optimistic turn uses the local send time
until that authoritative event reconciles it. Navigating to another session and
back can remount the activity component, but it cannot make the run appear to
have restarted.

The bundled `LoadingState` stopwatch is intentionally hidden only when the
server-backed timer is present. Its loader, phase label and reduced-motion
behavior remain unchanged. The visible replacement is presentation-only for
assistive technology so a ten-times-per-second clock does not repeatedly
announce; the changing phase label remains the status announcement.

Runtime readiness and the persisted run binding remain separate fail-closed
checks. They are independent reads, so the official-runtime adapter starts the
network health check and database lookup together instead of paying for them
serially before submission. No model, effort, approval, tool or persistence
behavior changes.

**Evidence.** A remount regression renders the same run at 3.7 seconds and
again at 24.1 seconds from its original timestamp. Store coverage verifies the
event time reaches the cached run. Runtime coverage holds the submission
readiness check open until the concurrent binding lookup starts, proving the
calls no longer serialize while both checks still execute.

---

## C67. A healthy WebSocket does not prove the transcript is complete

**Decided September 17, 2026.** The session hub periodically reconciles even
while WebSocket heartbeats remain healthy. It checks every two seconds while
the visible session has unresolved run or stream state and every thirty seconds
while idle. Returning to a visible tab and refreshing the hub ticket trigger
the same catch-up immediately.

The WebSocket remains the low-latency path. Durable replay is the completeness
check because a browser or best-effort forwarder can miss a committed terminal
batch without closing the transport. Replay and simultaneous live events use
the existing replay-first buffer order. The active session also compares its
authoritative run row and latest persisted messages with local state: a later
live event may legitimately advance the cursor past an earlier missed event,
which cursor replay alone cannot recover. The run read preserves the exact
terminal state instead of inferring completed from an idle session. Receiving
a terminal status forces this snapshot once, because that status may be the
later half of a partially delivered batch. A failed background check preserves
the healthy socket and retries at the bounded cadence.

**Evidence.** One transport regression keeps the socket open with a valid
`pong`, withholds the terminal batch, and verifies bounded replay without a
disconnect. A second advances the cursor with completed `run.status` while
withholding the earlier `message.final`, then verifies that the authoritative
message snapshot restores the response as soon as the tab becomes visible.

---

## C68. Native stream consumption must not await the control plane

**Decided September 17, 2026.** A delayed status check was able to hide an
entire native streamed response: the same loop stopped reading SSE while it
awaited status, and a completed status then aborted unread deltas. A controlled
300 ms status delay reproduced eight available text chunks but zero live
previews or durable deltas before the full final answer.

One independent native reader now feeds ordered coalescing preview and durable
checkpoint lanes. Status, Stop, Steer and tool activity cannot stall ingestion.
Database operations sharing one client remain serialized, while production
checkpoints use their dedicated connection. Lane sends are single-flight,
frames respect the wire size limit, and response/activity buffers are bounded.

Authoritative terminal status starts a bounded native tail drain, followed by
complete durable-write draining before finalization. Preview draining is
best-effort and limited to 250 ms, with queued sends discarded afterward. A
late preview cannot resurrect a finished client accumulator. The existing
final-status recovery remains necessary because the pinned native event queue
is single-consumer and non-replayable. No reconnect subscriber is added.

**Evidence.** Regression tests hold status, preview, checkpoint and main-client
database operations independently. Text still arrives during control delays;
completion cannot overtake durable writes or wait indefinitely for a preview;
large backlogs preserve exact text and offsets in bounded frames. Client tests
cover late previews after final/reveal and while a later run is active. Worker
telemetry records content-free relative delivery timings and counts, and a
throwing metrics observer cannot change successful completion.

**Live acceptance follow-up.** A real Cloud reply exposed a separate client
race: periodic semantic reconciliation treated the persisted assistant row's
`streaming` placeholder as a final answer. That cleared the already-visible
prefix, so later deltas rebuilt only a suffix until the genuine final arrived.
Only terminal message rows may enter `stream/final`; the adapter filters
streaming snapshots and the reducer enforces the same invariant defensively.
An older in-flight snapshot cannot revive a completed attempt or overwrite a
retry that has advanced the run's attempt number.

## C69. Transcript ownership must survive admission and final handoff races

**Decided September 17, 2026.** A reply appeared to disappear after streaming.
The affected open document retained an extra local `again` bubble after the
saved answer; a fresh document showed the correct saved conversation without
that extra bubble. The sequence-number failure was reproduced in adapter and
reducer tests: live `message.final` has no session sequence and uses
`MAX_SAFE_INTEGER` locally, the next optimistic question inherited that value
plus one, and its real user row could never satisfy the confirmation's
sequence comparison. The remaining local question anchored the viewport below
the reply when its live accumulator was removed.

Turn confirmation now uses the exact `client_turn_id`, or the admitted run id
plus the user text when a snapshot lacks that key. Local sequence numbers are
not identity. A repeated prompt from an older run cannot confirm a new turn
before admission establishes its run. POST and `run.started` also reconcile a
user row already received through a snapshot, and a delayed POST cannot change
a terminal run back to working. Background snapshots revisit already-seen user
rows while a pending turn remains. Optimistic sequences exclude the live-final
ordering sentinel.

Separately, a provider-turn final is not a run-completion event. Clearing the
finished text reveal before the transcript can render its durable replacement
left a blank gap while `run.status` was delayed. The reveal must retain
ownership until a matching durable answer is renderable. Tool rounds still
remain progress, not an invented completed run; an explicit next-turn reset
can replace the current live surface normally.

**Coverage.** Consecutive repeated prompts after a live final are tested through
both socket and snapshot delivery, including admission/event reordering,
already-seen-row recovery, and terminal-state preservation. Rendered browser
coverage holds final/status delivery apart and checks the no-blank, one-answer
handoff with normal and reduced motion, as well as continued tool turns. These
fixtures use real client state/rendering with synthetic events; they do not
claim native model or paid-tool evaluation.

---

## C70. Native terminal failures become safe structured product errors

**Decided September 17, 2026.** A terminal Hermes status may include a redacted
provider error, but it is still provider-controlled free text. The Enterprise
adapter uses that text only to choose one fixed failure class: authentication,
quota, rate limit, rejected request, temporary provider unavailability,
interrupted runtime or unknown. It persists and streams only our stable error
code, retryability and fixed user copy. The native text is never copied into
Postgres, browser events, traces or Worker logs.

The same structured error now reaches the chat status bar and the trace detail.
Permanent authentication, quota and rejected-request failures require action
and do not offer a misleading retry. Transient failures preserve completed
work and keep Retry available. A content-free `hermes.terminal_failure` event
records the class, retryability, native status, elapsed work and partial-output
length so an incident can be diagnosed without exposing a prompt, credential
or upstream response.

**Why.** The prior adapter discarded `status.error` and labeled every failure
`hermes_run_failed`. That made a provider rejection, expired connection and
temporary outage look identical, and made the Traces screen omit the only safe
diagnostic the product had. The repair belongs at the Hermes-to-Enterprise
boundary: changing the workflow engine would still lose the same field.

**Evidence.** Classifier tests cover every failure class and prove the native
text is absent from the persisted and logged projection. Adapter coverage
proves terminal classification and proxy-accounting isolation. A real-Postgres
route test proves trace detail returns the safe error, and client rendering
tests cover retryable and action-required trace states.

---

## C71. Keep Cloudflare Worker and Workflows around the official Hermes runtime

**Revalidated September 17, 2026.** Cloudflare remains the Enterprise control
plane and Hermes Cloud remains the agent runtime. The Worker owns identity,
tenant and approval policy, the durable Postgres audit and browser delivery.
One Workflow coordinates each run attempt. Hermes owns planning, model calls,
tool execution and its native session through the authenticated Runs API.

Hermes' current official guidance confirms the integration boundary rather
than prescribing an outside workflow product: custom HTTP control planes use
the API Server and its `/v1/runs`, status, event, stop, steer and approval
endpoints; hosted instances run on Hermes Cloud, while the official Docker
image is the supported self-hosted fallback. There is no official Hermes
recommendation to move its loop into Temporal, Trigger.dev, Inngest, Restate or
Cloudflare Agents.

The current alternatives do not improve this incident:

| Option | Current fit | Decision |
| --- | --- | --- |
| Cloudflare Workflows | Durable step retries and waits, unlimited per-step wall time within CPU limits, native Worker bindings, and up to 30-day completed-state retention; product truth already lives in Postgres | Keep |
| Cloudflare Agents SDK | Strong Durable Object runtime for building a different agent harness; it would duplicate or replace Hermes' loop and session model rather than supervise it | Do not adopt for this path |
| Trigger.dev or Inngest | Excellent TypeScript-first long jobs, streaming and managed run observability; each adds another control plane while Hermes still owns the real loop | Revisit only if run observability or portable background execution becomes a measured blocker |
| Temporal | The mature choice for vendor-neutral, multi-service workflows that must resume for months or years | Revisit for multi-cloud/customer-VPC orchestration or requirements Cloudflare cannot meet |
| Restate | Promising lightweight durable services, exactly-once communication and BYOC/self-hosting | Watch; no migration benefit today |

Changing orchestration is justified only by a measured requirement: customer
VPC or regional placement, multi-language workers, vendor-neutral workflow
history, cross-service compensation beyond the present run boundary, or a
Cloudflare limit observed in production. Better error projection, scoped
observability access and runtime telemetry are smaller and more direct repairs.

Primary references:

- https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- https://hermes-agent.nousresearch.com/docs/guides/manage-hermes-cloud-with-mcp
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/docker.md
- https://developers.cloudflare.com/workflows/reference/limits/
- https://developers.cloudflare.com/agents/runtime/execution/run-workflows/
- https://developers.cloudflare.com/agents/runtime/lifecycle/agent-class/
- https://trigger.dev/docs/introduction
- https://www.inngest.com/docs/learn/inngest-steps
- https://docs.temporal.io/
- https://docs.restate.dev/

---

## C73a. Version and canary the Hermes runtime boundary as one contract

**Decided September 17, 2026.** The native launcher now replaces provider
failure prose with a fixed, versioned terminal-error envelope before either
status persistence or SSE emission. The Worker validates the exact contract
schema, terminal schema, official Hermes source revision and release ring at
health and admission, then classifies only the structured code. Missing or
unknown envelopes fail closed instead of reviving free-text heuristics.

The pinned runtime probe is a required CI job. It launches the real official
gateway and AIAgent loop, injects deterministic local authentication, quota,
rate-limit, rejected-request and unavailable-provider failures, and verifies a
process restart becomes a structured interruption. This is fixture-only fault
injection; production exposes no fault switch.

The browser reducer records an authoritative per-run/turn final fence. Reset,
durable delta and preview frames at or below that fence cannot resurrect text
after the reveal handoff; a later turn remains valid. Delivery-order
permutations exercise the invariant rather than relying on one expected event
sequence.

Runtime stream timing and structured failures are emitted as content-free
Analytics Engine series and ring-tagged alert logs. A dedicated canary profile
must attest `canary`, while ordinary and dynamically provisioned profiles
attest `stable`. This makes launcher/adapter incompatibility observable before
fleet promotion and prevents an accidental binding swap from admitting it.

---

## C74a. Reduce fresh-run overhead and measure Iris time before streaming

**Decided September 18, 2026.** Fresh native submission may pass its recent
capability check once to the first execute callback, in memory and for no more
than five seconds. Persisted bindings, checkpoint replay, retry and expired or
rolled-back clocks still reattest. Admission remains independent. The launcher
declares five-minute prompt caching for exact allowed Claude models behind the
governed custom proxy, including per-run overrides.

Startup and provider-first-content measurements are separate from full provider
duration and existing stream metrics. They carry only timing, identifiers and
usage counts. Neither caching eligibility nor passing fixture tests proves
live cache hits or a real-world latency improvement. Model and effort selection
remain explicit because reducing reasoning can change quality.

See [IRIS-LATENCY.md](../IRIS-LATENCY.md) for evidence, tests, clock definitions,
Cloud profile rollout requirements and the pending live benchmark.

---

## C72. Runtime provider failures retain safe, actionable status classes

**Decided September 17, 2026.** The agent-scoped model bridge preserves the
upstream HTTP status but returns one fixed error code for each action a person
can take: reconnect authentication, restore quota, wait for a rate limit,
change an unavailable model, retry a provider outage, or correct a rejected
request. Provider response bodies remain outside the Enterprise trust boundary
and are cancelled without being stored, streamed or logged. Worker telemetry
records only provider, catalog model id, status and the fixed classification.

Nous credential verification uses the callable free
`stepfun/step-3.7-flash:free` route rather than the premium workspace default.
Verification answers whether the OAuth grant can invoke inference; a temporary
capacity outage on Claude must not mark that grant invalid or prevent a user
from reconnecting it. The product default remains a separate quality choice.

**Why.** A live Iris run reproduced three provider calls through the same saved
OAuth connection. Claude Sonnet 5 returned 503 three times, while a cataloged
DeepSeek route returned 404. Both were flattened to
`runtime_provider_rejected`. A control call through the same bridge and OAuth
grant completed on StepFun with HTTP 200 and authoritative streamed usage,
proving that identity, credential refresh and the Enterprise transport were
healthy. The failing boundary was model availability at Nous Portal.

The Hermes Teams Demo workspace and its proactive Iris session were moved
to the proven StepFun route so scheduled and interactive work can continue
while the premium routes are unavailable. That operational choice is visible
in the session and workspace model selectors; the bridge does not silently
substitute a different model.

**Evidence.** Runtime bridge tests cover 401, 402, 404, 422, 429 and 503, assert
that provider diagnostics never cross the boundary, and verify rejected calls
remain attributed to the exact credential and model. The Nous adapter test
pins the independent verification route. A live Hermes Cloud trace completed
the StepFun control request in one model call with no tool calls.

---

## C73b. Iris recovery preserves tasks, effects and model provenance

**Decided September 18, 2026.** Overview and trace expose Retry task without a
chat message. Idle Run now checks only the current authorized screening cadence;
its durable cycle key prevents a second allowance. Existing requests and paid
receipts are inspected before advancing an attempt. Completed discovery resumes
from stored candidate evidence; pending imports retain their native mapping, and
uncertain mutations or existing drafts block replay. Reviewing an already-created
draft permits future cadence work even when the original final response failed.

Manual and automatic retries share admission, ownership, provider, capacity and
approval-budget checks. Expected attempts make delayed duplicate requests no-ops.
An app transaction records the new attempt and a durable launch job before the
Workflow starts. Prior model/effort, trace, failure and trigger remain in the
recovery history. Paid authorization rechecks the active native attempt under the
same task-row lock so a late callback cannot reserve work after recovery advances.

Only an ordinary-chat failure that has completed read-only tools and can be
reduced to the server-enforced response-only contract retries automatically, up
to three total attempts with one- and five-minute delays. Pre-tool failures and
partner-screening recovery remain explicit manual Retry because the native Runs
contract does not accept an exact per-attempt tool/skill inventory. Sanitized
provider Retry-After deadlines can extend eligible waits; excessive waits pause
recovery. Cancellation, human review, stopped tasks, unavailable credentials,
quota and unresolved effects never become an unbounded retry loop. The UI uses
server-confirmed state and existing button feedback; its countdown is motionless
and does not repeatedly announce itself to screen readers.

**Hardened September 20, 2026.** Recovery rechecks for any newer session run
under the same agent admission lock immediately before it advances the failed
attempt; even a newer completed turn makes the queued recovery stale. The failed
attempt's model and effort are pinned rather than reread from mutable session
settings. The Worker persists the intersection of prior tool/skill snapshots and
current grants for audit, but does not treat those private fields as enforcement:
the public native Runs API deliberately strips them. Post-tool ordinary-chat
continuation is therefore a server-owned response-only mode: its native request
contains no tools or skills, the model proxy strips runtime-supplied tool
definitions, Enterprise tool dispatch rejects fresh calls, and direct paid-call
leases are refused before reservation. Automatic recovery
requires both that response-only contract and a managed token-digest runtime;
legacy HMAC profiles remain manual-only.
That automatic admission is persisted on the run rather than inferred later.
Before a retry Workflow selects the Hermes or legacy engine, it re-resolves the
managed binding and requires token-digest auth again. A deployment switch,
missing Hermes configuration or binding downgrade marks the attempt as a
non-retryable runtime-drift failure without provider or tool dispatch; the user
can still choose explicit manual Retry. First attempts incur no extra recovery
lookup. The drift write itself requires the exact expected attempt, automatic
marker, active status and no Stop request in one SQL predicate. The Workflow
rechecks after asynchronous binding resolution, and the adapter reloads an
automatic attempt before native work, so a delayed invocation can neither
fail nor submit work for its successor.
Automatic startup revalidates and locks that same predicate before emitting
`run.started`; it never resets a successor or a concurrent Stop to working.
Hermes acknowledges an idempotent native run with a bounded HTTP 202 before
streaming. The adapter therefore holds the exact-attempt row lock only across
that acknowledgement and durable native binding. Retry and Stop serialize at
that boundary, while model execution and streaming never hold the transaction.
An exact drift failure projects approval-continuation budgets and partner
handoffs in the same transaction; a stale no-op projects nothing.
The current fixed/free-route Iris binding is legacy HMAC, so this change does
not claim automatic continuation there: users retain explicit manual Retry until
that profile is migrated to a managed token-digest identity. Dynamically managed
token-digest profiles receive the bounded automatic path described above.

Catalog capabilities honor per-model reasoning efforts; DeepSeek V4.1 offers
`low`, `high`, `max`, with provider default `high`. Automation follows the
workspace policy, and retries preserve the failed attempt's exact model and
effort. The separate Jev typed classifier and production automation policy are
unchanged.

**Default rollout held.** The requested all-workspace V4.1 Flash/low migration
is prepared separately. A September 18 staging preflight of exact
`nous:deepseek/deepseek-v4.1-flash` at explicit low effort returned Nous HTTP 404
on all three native attempts (run `fb738cb4-c64c-4bf4-ae2a-132326ce6675`). The
public catalog still lists it; official routing and OAuth handling match the
application. Do not promote it globally until exact-model inference and tool
acceptance pass. Recovery can ship independently while configured defaults and
historical records remain intact.

**Evidence.** Focused PostgreSQL tests cover ownership, duplicate requests,
reviewed-cycle recovery, pinned-model snapshots, paid receipts, cadence keys,
cancellation, newer completed-turn races, prior-authority snapshots and
response-only paid-lease refusal. Runtime adapter and bridge tests assert saved
instructions cross the real native transport without relying on stripped private
fields, the provider sees no tool definitions, and fresh Enterprise calls are
rejected before writes. Admission tests reject legacy and unset deployments
before upstream I/O; execution-fence tests cover token-digest-to-legacy binding
drift and Hermes-to-legacy or unset deployment drift before engine selection.
Race tests move the attempt and request Stop at both startup and native dispatch;
PostgreSQL acceptance proves both writes wait through binding, while exact-only
failure tests prove approval budgets and partner handoffs cannot be projected by
a stale attempt.
Browser tests cover Overview/trace actions, no-output failure,
countdown, cancellation, navigation and narrow reduced-motion layout. Deployment
and live-provider acceptance were recorded in internal delivery notes and are
not reproduced here.

---

## C74b. Raindrop observes terminal Hermes runs through a content-free boundary

**Decided September 18, 2026.** Staging exports one AI event after an official
Hermes run has committed and delivered its terminal message and status. The
event contains model and lifecycle metadata, tool names and states, final-answer
presence and length, and fixed error taxonomies. Tenant and run identifiers are
one-way hashed. Prompts, answers, applicant data, tool arguments and results,
provider bodies and error messages remain inside Hermes.

The exporter uses Raindrop's documented batch ingestion contract directly. The
official JavaScript package was rejected for the Worker path because one event
export added 290 transitive packages and a blocked protobuf build script. A
small HTTP client keeps the Worker bundle and supply-chain surface bounded.

Raindrop runs after the canonical result and has a 2.5-second request deadline.
Its absence or failure is logged as metadata and cannot alter the run. Stable
pseudonymous event ids make Workflow replay idempotent. Development and
production default off; staging is active only when its server-side write key
exists. The first explicit agent signals are terminal error and tool use without
a final response.

**Evidence.** Unit tests assert the export query cannot select transcript or
tool contents, raw identifiers and error messages never reach request bodies,
negative signals attach to the same event, disabled mode does no work, and
vendor failures resolve without throwing. The Worker typecheck and dry-run
bundle verify Cloudflare compatibility without the vendor SDK.

---

## C75. Cloud response text uses a primed GET SSE hop and names its paid/free route

**Decided September 18, 2026.** The Hermes Cloud connector keeps one exact
machine-authenticated `/api/plugins/enterprise_bridge/control` path. Short
control operations continue to use POST envelopes. A run's event subscription
uses GET with only a validated `run_id`, sends a valid SSE comment immediately,
and writes each complete native SSE frame separately. The Worker requests
identity encoding and consumes the same native event contract as before. The
older POST events envelope remains for a one-release drain window.

The model selector now labels Nous Portal entries as `Paid route` or `Free
route` and exposes the exact model id on the control. Two StepFun routes with
the same human label can no longer be mistaken for one another. The route id is
preserved exactly when Enterprise removes the `nous:` catalog namespace for the
official Hermes runtime; there is no implicit fallback and no default-model
change in this repair.

**Why.** Staging proved that native output, durable final state and reload
persistence were correct, but a long answer remained absent in the browser
until the run ended. The existing component and Worker streaming tests could
not distinguish a provider that delivered late from an HTTP intermediary that
buffered the dashboard's POST response. A conventional primed GET SSE response
removes that avoidable ambiguity. It cannot manufacture tokens before an
upstream provider emits them, so first-delta telemetry remains the authority
for separating provider latency from transport latency.

**Evidence.** A delayed-native-chunk ASGI test proves the first delta leaves the
connector before terminal EOF. Worker tests prove GET, authentication,
no-compression request headers, keepalive tolerance, and exact paid/free runtime
model ids. Browser tests prove visible text grows before completion, the final
handoff has no blank frame, and committed output survives session navigation
and reload. Model-menu unit and browser tests cover the two same-label StepFun
routes and the selected exact id.

---

## C76. Creator-channel runs receive exact governed calls and X uses a $0.005 public-post connector

**Decided September 18, 2026.** An explicit Hermes creator, influencer,
consultant, or implementation search now causes the Worker to append the exact
approved AgentCash call to the native runtime input. The original user message
remains authoritative: the payment endpoint independently checks that it names
Hermes, an action such as search or test, and the requested channel before it
leases a call. Recovery input never receives a fresh paid-search instruction.

LinkedIn and YouTube keep the fixed $0.01 public-index search. X uses one fixed
read-only `fetcher.sh/api/twitter/search` request for the exact `"Hermes Agent"`
phrase, capped at $0.005. Its importer stores at most five canonical X
profile/post pairs, bounded public bio and post text, point-in-time follower and
engagement metrics, and explicit evidence gaps. It drops contact-like text,
provider metadata, payment receipts, locations, images, and unrelated response
fields. Direct messaging, outreach, and direct platform credentials remain
outside this connector.

The screening cost column uses millidollar precision so the audit row records
$0.005 instead of rounding it to $0.01. LinkedIn/YouTube and X use separate
run-bound idempotency keys, so an explicit multi-channel test can lease each
fixed call once without sharing or replaying an allowance.

**Why.** A staging acceptance prompt asked Iris to call the existing creator
search exactly once. The free model rate-limited; a paid-model retry then spent
ten tool steps reading unrelated Inbox records because the skill referred to
exact arguments that the app never supplied. The connector was implemented,
but model tool selection made it practically unreachable. Exact prompt
augmentation removes that hidden dependency while the Worker lease preserves
the spend and intent boundary.

**Evidence.** Three live AgentCash X calls verified the origin-hosted schema: a
narrow combined account query returned no users, `Nous Research` returned the
verified Nous profile, and the public-post search returned current Hermes
authors and posts. Unit tests cover explicit-intent detection, exact runtime
input, X sanitization, public metrics, skill metadata and source state. Python
plugin tests cover host allowlisting plus pre/post hooks. The PostgreSQL route
test covers the $0.005 lease, import, candidate/artifact persistence and exact
audited cost.

---

## C77. Dashboard-connector events use its authenticated POST dispatcher

**Decided September 18, 2026.** A Hermes Cloud run subscribes through the
fixed, service-authenticated `POST /api/plugins/enterprise_bridge/control`
operation envelope. The plugin's GET handler remains as a compatibility route
for hosts that expose plugin GET routes, but it is not the Enterprise Worker's
primary transport. The POST response is still a primed `StreamingResponse`;
its native relay uses nonblocking `read1`, emits complete SSE frames as soon as
they arrive, requests identity encoding, and disables intermediary transforms.

**Why.** Staging disproved C75's routing assumption. A real run reached native
submit and status repeatedly but never produced a native `/events` request:
the dashboard edge did not dispatch the plugin's GET handler. That left the
Worker to reconcile only the terminal status and made the completed answer
appear at once. The POST dispatcher is the route the dashboard actually
exposes. The buffering bug that originally motivated GET was in the connector's
blocking native read, which remains fixed independently of the HTTP method.

**Evidence.** The Worker regression test requires an authenticated POST events
envelope, the caller's execution signal, `text/event-stream`, identity encoding
and no-cache. The connector test requires that the POST events envelope enters
the same native stream relay used by GET. The incremental ASGI timing test
continues to prove the first delayed native frame leaves before terminal EOF.

---

## C78. Runtime startup phases share serial tenant-scoped transactions

**Decided September 18, 2026.** Hermes startup groups each related database
phase into one tenant-scoped transaction: initial run state, the started event,
submission preparation, and streaming-message setup. Queries remain serial on
the request-local `pg` client. The grouping reuses the existing agent-role
transaction rather than parallelizing queries or widening database grants.
Runtime binding resolution passes its already-loaded run into the adapter, and
content-free latency telemetry now separates startup reads, persistence,
delivery, execution persistence, and execution delivery.

**Why.** A live paid StepFun acceptance run streamed correctly but spent about
four seconds preparing the native request and another two seconds between the
native binding and stream subscription. Most methods opened their own `BEGIN`,
tenant `set_config`, and `COMMIT` sequence, multiplying Hyperdrive round trips.
The same client cannot safely execute these reads concurrently, so one serial
transaction per phase removes protocol overhead without changing authorization,
replay, idempotency, or event ordering.

**Evidence.** The adapter regression test requires the four grouped startup
boundaries. A real PostgreSQL test nests request snapshotting and native binding
inside one runtime transaction, interrupts it, and proves that both writes roll
back. Existing runtime, streaming, database, and Worker suites continue to
exercise retries, stop fences, event order, and terminal persistence.

---

## C79. Interactive admission publishes in order before its durable launch

**Decided September 18, 2026.** A new interactive turn commits its user message,
stream event, publish retry job and Workflow launch retry job together. After
commit, the request hands the exact returned event envelope directly to the
Session Hub, then creates the Workflow only after the hub acknowledges it. The
launch job names the publish job as a prerequisite, so background or Cron replay
cannot create a higher-id run event before the lower-id user message is visible.
Direct acknowledgements retire both idempotent jobs in one background tenant
transaction; a crash or RPC failure leaves the jobs for recovery.

Admission reuses the tenant transaction's membership result, reads session plus
duplicate state together, reads model plus credential state together, and writes
the initial message, engine turn and draft cleanup in one statement. Workflow
startup loads the run and dynamic runtime binding in one serial agent-role
transaction. Phase telemetry separates authentication, admission transaction,
post-commit jobs, ordered publish and Workflow creation.

The Enterprise model-list bridge now returns each catalog model's positive
`context_length` and validates provider credentials serially inside one runtime
transaction. Unknown context remains omitted rather than invented. This lets the
pinned official Hermes metadata resolver use the authoritative OpenAI-compatible
model record instead of making a failing `/api/show` probe on every warm turn.

**Evidence.** PostgreSQL route regressions force both the direct publish and
Workflow-create failure boundaries and prove publication precedes launch while
the durable jobs finish. Outbox tests compare the directly delivered envelope
with its committed id and trace. Unit/database tests cover known, null and invalid
context windows. The native probe runs the exact pinned Hermes gateway and
asserts a complete model/tool turn without any `/api/show` request.
---

## C80. Approval review starts with the decision and the content

**Decided September 18, 2026.** The project owner accepted the compact decision/header/email
arrangement and evidence expanding below. Each governed review starts with the
decision, exact per-step approval counts, policy ordering, expiry and the server's
eligibility reason. Specialized previews remain intact. Proposer, long summary,
request identity and policy metadata live in Request details. Review history shows
all votes from the current revision; it does not claim to be a cross-revision audit.

Communication drafts use **Approve draft** throughout Inbox, chat, Overview and
detail. This records review of copy and sends nothing. Authorized reviewers can
revise an email draft's actual subject/body through the existing revision contract;
sender, recipients, evidence, policy and external effects stay unchanged. Pending
revision entry is under More actions, and decision controls hide while editing.
Saving produces a fresh server-bound revision requiring a fresh decision. Stale
responses refetch for review; authentication never automatically replays an action. An unsaved email rewrite can
survive a sign-in redirect for at most 15 minutes, bounded by authorization expiry.
It restores only after a matching viewer/workspace/request/revision/hash refetch
with revision permission, and opens the editor for an explicit save. Cancel, success,
expiry or any binding/account mismatch clears the saved rewrite.

Invoice and agreement review uses **Approve invoice draft** and **Approve agreement
draft**. One workspace Admin approves the current legacy draft. The document preview
preserves supplied parties, currency, dates and terms; absent data is explicit.
Approval saves a Library draft. Bank setup, payment authorization and signature
consent ceremony are removed because those effects are unavailable. Historical
authorization text remains an internal note, not evidence of execution. Client
decisions bind the exact request snapshot rendered by the pane, even if the entity
cache advances before the click, using the backend's version/hash binding and refresh conflicts without
resubmitting.

Evidence expands below the content. Stored partner facts, dates and safe original
URLs load from the request-scoped evidence projection, with Iris's note labeled
separately. Opaque proposal references never become links. Unsupported sources and
unlinked legacy messages are stated as unavailable; email ingestion is outside this
release. Native disclosures open instantly. Preview transitions honor both system
and app reduced-motion preferences.

**Evidence.** Client regressions cover draft labels, per-step quorums, all votes,
real email-body revision, old-binding rejection, safe evidence links, and legacy
draft receipts. Browser checks cover all ten governed previews at desktop and narrow
widths, plus phone review with the existing sidebar collapsed. This change does not
redesign the phone navigation shell. The client requires the matching backend
review-binding helper and typed evidence endpoint; integrate and release together.

---

## C81. Proactive outreach advances through new candidates and sends only an exact approved email

**Decided September 18, 2026.** Recurring AgentCash People Search keeps the
existing six-hour cadence, one request per run and `$0.15` discovery ceiling.
The Worker, not the model, owns the provider page cursor. It advances only after
an exact paid response is imported and cycles after the final page. A durable
engagement ledger removes any candidate already drafted, declined, queued,
sent, or suppressed from later Iris candidate lists.

Iris may use only contact fields copied from stored professional enrichment and
verification evidence. Draft-only remains the default in every environment.
When an operator enables approved sending, the human decision creates a durable
outbox row bound to the request id, authorization revision and hash, and
recipient index. The sender must be a matching dedicated Gmail OAuth account;
credentials are envelope-encrypted and the connector requests `gmail.send`
plus OpenID identity without mailbox-read scope.

Delivery rechecks the approval, sender identity and suppression list. A
confirmed Gmail response records its message and thread ids and marks the
engagement sent. A network error or server response that cannot prove delivery
becomes `ambiguous` and stops automatic retries, because avoiding duplicate
unsolicited outreach is more important than hiding a manual review. Settings →
Email exposes connection, cadence, rollout mode, and waiting work.

**Evidence.** Unit coverage fixes OAuth scope/state, verified account identity,
header-safe MIME generation, provider requests, pagination and end-of-results
cycling. PostgreSQL coverage proves cursor persistence, repeat-candidate
exclusion, exact authorization binding, pending-mailbox behavior, encrypted
credential resolution, one confirmed send, receipt persistence and engagement
transition. Migration replay, the typed schema/grant matrix, client render and
the full database suite include the new boundary.

---

## C82. Modular workflows are Hermes skills with Enterprise assignments

**Decided September 18, 2026.** Hermes Enterprise uses Hermes's existing
extension model instead of introducing a parallel “Program” package type. A
skill is the versioned procedure. A plugin supplies trusted tools and hooks. An
Enterprise skill assignment binds one reviewed skill version to one agent's
validated non-secret config, semantic capability grants, proactive schedule,
approval policy and active/paused state.

The Partner Program is the first implementation. Existing environment policy
is imported once as assignment revision 1 so deployed agents keep working.
After materialization the database assignment is authoritative. The native
runtime derives both `skills.auto_load` and assignment tools from the active
row; pause removes both. Cron discovers persisted assignments and uses each
assignment's enabled flag and interval. Library → Skills renders the registry's
field metadata and lets an Admin save a new revision.

The assignment and its append-only revisions are tenant-isolated. The app role
may create and update an assignment; the agent role has read-only access. The
database enforces monotonic revisions and records every snapshot. Secrets,
provider credentials, evidence, Inbox approvals, external effects and receipts
remain in their existing control-plane stores. A skill still cannot grant
itself decision or send authority.

Runtime discovery and recovery status reads never materialize an assignment or
enable a schedule. The deployment-wide legacy Partner Program fallback is a
rollout compatibility projection only for an agent with no Enterprise team or
skill governance. Any explicit Enterprise role/assignment suppresses that
fallback, so a Finance agent cannot inherit Partnerships manifests or tools.
Applying a reviewed role template also replaces capability grants with the
template's exact allowlist instead of preserving arbitrary historic grants.

**Evidence.** Migration replay applies 46 migrations twice from a blank shadow
database. Unit tests prove active and paused runtime boundaries. PostgreSQL
coverage proves legacy import, revision history and agent-role visibility. The
full shared, client, Worker unit and database suites pass, and the production
client and Worker dry-run builds succeed. A mock browser check opens the
schema-driven editor, saves a changed priority and observes revision 2 without
console errors.

---

## C83. Cross-team agent coordination uses a governed Bot Mode bridge

**Decided September 19, 2026.** Partnerships-to-Finance coordination is hybrid.
The authenticated, revision-pinned database handoff remains the authority. The
recipient Finance session also receives one durable user-role turn using Hermes
0.21.3's canonical Bot Mode envelope,
`Message from 🤖 <display> (@<profile>): <body>`, with native `turn_author` bot
attribution. The transcript
renders that exact envelope as an agent timeline notice instead of a human
message bubble.

The Enterprise Worker generates the message from an immutable, human-confirmed
intake and the Finance-private invoice record; neither model can alter the
envelope, choose a recipient or author authority. The Partnerships tool receives
only the intake id and expected hash. The Worker rechecks the exact human
authorization, validity window, non-deleted source digests, frozen revisions,
assignment snapshots and run grants before its deterministic duplicate,
evidence, currency and amount checks create the only request. An unsigned
agreement draft is evidence to review, not proof that terms were authorized.

The Finance model gets read-only request/result tools and may explain the stored
result. It cannot call native `message_agent`, create or mutate a request,
approve, pay or send. The Finance human decision rechecks the same binding and
saves only an invoice draft. One bounded server acknowledgment records the
decision result without invoice content or an automatic agent reply, preventing
acknowledgement loops.

**Why.** Native Bot Mode's message shape and attribution make agent coordination
legible and compatible with the Hermes client, but unrestricted peer tools would
bypass Enterprise team scopes. Keeping transport visible and authority on the
server preserves both behaviors.

`input_provenance` is separate from execution simulation. Sample terms stay
sample throughout authorization, intake, correction and results, while a real
native execution over those terms remains non-simulated. Historical unknown
provenance is not relabeled customer data.

**Evidence.** Shared tests pin the current and legacy Bot Mode parsers. Runtime
tests require validated native bot attribution and reject malformed authors
before network I/O. The V2 PostgreSQL acceptance covers exact authorization,
same-key replay/conflict, revised terms, evidence deletion and validity drift,
assignment drift, one-successor correction, sample lineage, guarded human
decision and one acknowledgment. On September 19 it passed 8/8 alone and 12/12
with the legacy partner workflow suite. These fixtures use real Postgres/app
roles and guarded HTTP with fixture storage/auth and scripted run admission;
they do not constitute hosted two-account or live provider proof.

## C84. Native conversation ids start from the first Enterprise run

**Decided September 19, 2026.** The first Hermes run in an Enterprise session
uses its globally fresh Enterprise run id as the native `session_id`. Later
turns in that same Enterprise session reuse the latest persisted
`runtime_session_id`. The exact selected id is snapshotted with the native
request and bound to the run before execution.

**Why.** A staging reset can recreate deterministic Enterprise session ids
while the separately hosted Hermes SessionDB still retains its earlier
transcript. Passing the reused Enterprise id let an otherwise fresh prompt load
old native history and return an unrelated answer. A fresh run id breaks that
collision, while the persisted mapping preserves real multi-turn continuity.
Retries continue to use the snapshotted id so native idempotency fingerprints
remain stable across releases.

**Evidence.** Runtime unit coverage proves first-turn isolation, prior native
mapping reuse and exact binding. Restricted-role database coverage proves a new
run resolves to itself and a following run resolves to the earlier native
conversation root. The live staging acceptance requires a unique-marker prompt
in a new Enterprise session after deployment.

---

## C85. Multi-party admission is an opt-in, exact-attestation transition

**Decided September 19, 2026.** Existing Partnerships 1.7 profiles and work keep
their original runtime name, procedure and version-aware tool inventory. The
new role uses `enterprise_bridge:partner-program-screening-v1-8` version `1.8.0`
with artifact digest
`sha256:281bbfff95d40e202c3ced5d1cb30ebf432868bee100d0c2a647faa40757a9e5`.
Finance keeps its runtime name but new work uses version `1.0.1` with digest
`sha256:bdb13d70f7a603f92eb47fc2d1c057c82f26658e61df8cf357790f23875753e4`;
historical 1.0.0 remains resolvable.

The additive migration leaves admission disabled. Enabling it requires exact
attestation for both current role assignments, including agent/assignment id,
revision, version, artifact/content digest, complete tool inventory, pinned
runtime/plugin, native cron off and role-specific AgentCash state. The server
re-locks the role bindings after the remote probe and rechecks the saved
snapshot on every new intake. Relevant pause, revision, artifact or principal
drift closes admission; unrelated assignments do not. Compatibility readiness
can keep a legacy profile operational but can never admit the new workflow.

**Why.** A global package bump would silently change existing Iris tools and
could invalidate active assignments or require unrelated restarts. A stored
"ready" flag without revision binding would allow new work after the native
profile and Enterprise authority diverged. Per-profile opt-in preserves the
existing product while making new cross-team authority fail closed.

**Operational consequence.** Deploy the Worker and migration with admission
off, update only the selected profiles, verify both attestations, then enable
that workspace. A newly invited Finance employee must start with compatibility
discovery disabled, receive the Finance role immediately, and never have the
starter Partnerships search approved. Hosted acceptance still requires the
second real member and exact native probes; local fixtures cannot replace it.

---

## C86. Warm capacity begins with a narrow, revocable discovery credential

**Decided September 19, 2026.** A new Hermes Cloud pool profile receives its
permanent Enterprise agent UUID before it can become invitation capacity. A
stepped-up workspace Admin prepares one random 32-byte discovery bearer for
that unused identity. Enterprise returns the bearer once and stores only a
workspace-and-agent-scoped digest. Before verified registration, it expires in
24 hours and can call only the read-only skills and tools discovery routes.
Registration links the exact credential to live-attested capacity and keeps it
valid across restarts until assignment or revocation.

The bootstrap contract is the historical Partnerships 1.7 profile: exact
runtime, plugin source identity, role, configuration digest, skill artifact and
content digests, tool inventory, AgentCash wallet state and disabled native
cron. Its connector must also attest the exact permanent workspace and agent
IDs and the configured Enterprise public origin. Registration and invitation
acceptance probe the real connector. Acceptance performs network I/O outside
the database transaction, then locks and rechecks the invitation, capacity,
grant and first assignment materialization before atomically copying the digest
to a `token_digest` runtime binding. The stored readiness time is the probe's
actual completion time.

After assignment, every token-digest run re-attests the fixed managed process
and the agent's current explicit assignment before provider submission. This
allows reviewed P1.8 or Finance transitions without weakening source, origin,
artifact or tool checks. A managed flag, origin, plugin source, assignment or
inventory mismatch blocks execution. Existing fixed Iris bindings keep their
legacy HMAC and compatibility readiness behavior.

**Why.** A connector control secret proves access to the dashboard route but
does not prove which Enterprise identity or governed profile the native process
will load. A discovery credential lets the native initializer read only the
configuration it must validate, without creating an agent, granting execution
or exposing a reusable plaintext secret in the database. Linking readiness to
the same grant prevents synthetic or unclaimable capacity rows from satisfying
an invitation.

**Operational consequence.** The generated discovery bearer and the existing
Cloud connector control secret are separate Admin inputs. No Cloud lifecycle,
wallet funding or paid provider call occurs in prepare, registration or
acceptance. Revoking available capacity quarantines it; reserved capacity must
first be released by withdrawing its invitation. Existing opaque
`HERMES_RUNTIME_AGENTS` credentials are left unchanged.

## C87. Admin controls and personal settings have separate navigation

September 20, 2026. Settings previously rendered the same workspace-control tabs to every member, relying on individual controls and server checks to explain authority. This obscured which settings affected the organization and sent members into pages they could not manage.

Use the existing Admin section for organization policy, inbox rules, agent defaults, shared provider credentials and runtime capacity, organization usage, workspace connections, and Shared Intelligence administration. Show it only to current workspace admins. Guard destinations before mounting data-fetching components, including direct links and legacy Settings URLs; role changes must remove the privileged view.

Personal Settings remains available to everyone for their own notifications, personal Slack identity linking, and read-only privacy information. Own-agent configuration stays with Agents. Reading retention facts or linking a personal identity does not grant authority to change shared connections, attest provider policies, or inspect organization credentials.

Navigation explains authority; server routes independently enforce it. Protect administrative reads and writes while preserving the member-readable settings information required by ordinary application behavior. Do not return privileged metadata solely because the UI hides it. Keep member notification writes scoped to the authenticated user. Regression checks cover direct navigation and direct API access as well as visible controls.

An active approval reviewer may not yet have an agent assigned. Bootstrap must still return their authorized workspace and Inbox state with a null agent, never substitute another member’s private agent. Agent-dependent controls stay unavailable until an accessible agent exists.

Reuse existing design tokens and grouped navigation. Settings navigation changes immediately; additional animation would delay a utility task without clarifying state. Verify focus, responsive layout, and reduced-motion behavior. Implementation and release evidence were recorded in internal delivery notes and are not reproduced here.


### C87 navigation refinement — Admin View and User View

September 20: the project owner prefers a top-right Admin View / User View selector with section tabs in each view. Replace the grouped desktop navigation and narrow section dropdown with wrapping tabs at every width. The view selector navigates between existing authorized routes; it never changes membership or grants access. Members see User View only. Preserve direct-link and server enforcement. Reuse the shared keyboard-accessible Tabs component, with an immediate selected-tab underline so wrapping and reduced-motion remain clear.


### C87 navigation refinement — four consolidated tabs

The project owner’s follow-up replaces the ten-section wrapping strip with one row: Organization (workspace details, rules, privacy, usage), Agents (defaults, providers, capacity), Connections (Slack/email), Intelligence. Related controls use expandable sections, one open at a time, while preserving existing direct links. Mount only the open section so viewing Agents does not inadvertently enter the protected capacity credential flow. User View remains three personal tabs.


### C87 detail-page design — September20

The project owner requested a Vercel-inspired design pass beneath the unchanged Organization/Agents/Connections/Intelligence tabs and Admin/User View switch. Direction: selected settings become full detail pages with a quiet section index, clear heading, bordered sections, and actions in consistent footers. Integration pages must remain useful when unavailable: show actual status/setup requirements and explain operating scope without fabricating a connection or capability. Separate destructive management from primary setup. Preserve existing authorization, confirmation and lazy mounting of protected capacity. Keep motion immediate for utility navigation and respect existing reduced-motion.

References: https://vercel.com/docs/project-configuration/general-settings and https://vercel.com/docs/integrations/install-an-integration/manage-integrations-reference. Adapt section hierarchy and integration management concepts to Hermes tokens, rather than copying Vercel’s brand.

---

## C88. Managed readiness pins the inference route, not one catalog model

**Decided September 21, 2026.** A Cloud-managed Hermes process pins the custom
provider, Enterprise model-proxy URL, runtime credential and API mode for its
entire ready lifetime. It does not pin `agent.model`: each admitted run may use
the model selected and authorized by the Enterprise Worker through that same
proxy. Provider, URL, credential or API-mode drift still fails closed and
removes the process readiness artifact.

**Why.** The Worker intentionally supplies the selected Nous catalog model per
run. Treating the configured startup default as an immutable provider binding
made the first non-default selection look like route escape, permanently
closing native readiness before inference. The model name is request data at
this boundary; the authenticated proxy and its server-side catalog policy are
the governed route.

**Evidence.** The policy regression switches between two model names without
losing readiness, then proves a provider/base-URL escape still closes it. The
ordinary pinned Hermes 0.21.3 gateway probe submits both fixture models through
the same governed proxy, verifies both reach the real `AIAgent` loop with the
assigned skill prompt, and rechecks live readiness and health before exercising
the existing post-ready drift closures. Hosted acceptance still requires a
fresh gateway boot and successful staging runs across the intended demo model
matrix.

## C89. Handoff is a first-class object

**Decided September 20, 2026.** A governed cross-team workflow is modeled as a workspace-scoped `handoffs` row (key, teams, crossing allowlist, ordered steps, admission state and readiness attestation) rather than as implicit settings on `partner_workflow_settings` alone. Migration `0069_handoffs.sql` backfills the Partnerships → Finance workflow as `contractor-agreements` (admit applicant → Finance reviews the contractor agreement), adds nullable `handoff_id` foreign keys on `partner_workflow_settings` and invoice-instance `partner_handoffs`, and keeps `partner_workflow_settings` synchronized through a trigger so historical readers and rollout code continue to work.

**Why.** Library navigation, API discovery, and future workflows need one durable object to name, admit, and render. The Handoffs UI routes work through Inbox application and agreement requests rather than invoice intake forms. When admission is enabled, approving an application creates one pending Finance agreement draft linked by `workflow_provenance` (`partner-contractor-agreement:{applicationId}`); Handoffs In motion shows the pair. Admission reads and writes go through the handoff row; the settings table remains a compatibility mirror updated on every handoff admission change. Existing `POST /w/:ws/partner-workflow/*` routes are unchanged; list/detail live at `GET /w/:ws/handoffs` and `GET /w/:ws/handoffs/:id`. The client mounts the redesigned page on Library → Handoffs.

## C90. Authority comes from server-written keys; payments need two people

**Decided September 26, 2026** (roles-and-agents plan, piece 0; see
`docs/ROLES-AND-AGENTS-PLAN.md`).

- A Finance reviewer, not only an Admin, may decide a legacy request only when
  its `subject_key` is `partner-invoice-handoff:` or
  `partner-contractor-agreement:`. `domain/finance-decidable.ts` holds the rule
  once, and the decision route, the Inbox counts, "can I decide this" and the
  reviewer label all use it. The payload's `workflow_provenance` no longer
  grants anything, and `propose_request` refuses an agent payload that carries
  it.
- A payment effect executes only after two distinct holders of the Finance role
  press Execute. Each press is a row in `effect_confirmations` (migration
  0071); the same person pressing twice counts once, and the effect row is
  locked for the press so two holders cannot both complete the count.
- Agreements name the workspace's `legal_name` (Admin setting, falling back to
  the workspace name) as the first party instead of a hardcoded company.

**Why.** An agent can write any payload, including one copied from a real
handoff, so a payload field cannot confer authority; only server code can
produce those subject-key prefixes (`engine/tools.ts` `subjectKeyFor`). The
two-person payment rule had been stored in `effects.approvals_required` since
0002 but never checked. The hardcoded party would have been wrong for every
workspace but one.

**Evidence.** `test/db/handoffs.test.ts` keeps an invoice with forged
provenance Admin-only at the route and in the Inbox (it fails against the
previous checks), and checks the agreement's first party.
`test/db/effects.test.ts` walks the payment through a first confirmation, a
repeated press that does not count, and a second holder's press.
`test/unit/engine-redteam.test.ts` covers the refused proposal.
