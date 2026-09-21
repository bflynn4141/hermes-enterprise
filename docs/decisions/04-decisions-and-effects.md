# Human decisions and effects

Decision-route, effect, receipt, history, and document choices D1 through D11.

[Back to the decision index](../DECISIONS.md).

## D1. A conflict is a status code and a header, not a field in the body

**Decided.** Two tabs deciding the same request produce one `decisions` row. The
winner gets 201; the loser gets **200** with `X-Hermes-Conflict: true` and a body
holding the decision that exists. The body is exactly
`decisionResultSchema` — `decision_id`, `request_id`, `resulting_status`,
`effect_ids` — in both cases.

**Why not `conflict: true` in the body.** `decisionResultSchema` is `.strict()`
and the client parses every response against it (`apps/client/src/model/rest.ts`),
so a fifth key would fail to parse in the client and turn a handled race into a
`RestError`. The status code carries the same information, is the older
convention for it, and needs no contract change — which matters because
`packages/shared` is owned by the contract, not by one route.

**Why 200 and not 409.** The person in the second tab wants the outcome, not an
error about a race they did not know they were in. The demo's rule was that a
repeat or an opposite decision on a resolved request is *ignored*, and answering
with what is already true is the HTTP spelling of ignoring it.

**Would change it if.** The contract gains a decision-result envelope; then the
flag moves into the body and the header stays as a compatibility shim.

---

## D2. Five guards, and the two that mean nothing in `AUTH_MODE=fake`

**Decided.** `POST /w/:ws/requests/:id/decisions` checks, in order: an
allowlisted `Origin` (**required**, unlike every other state-changing route);
`X-Requested-From: inbox`; the double-submit CSRF token; an Admin session; and
step-up freshness of five minutes measured on `auth_sessions.authenticated_at`
for the caller's `sid`.

**How fake auth satisfies them in development.** `AUTH_MODE=fake` authenticates
with `x-dev-user`, so:

* **CSRF** is a no-op: `requireCsrf` returns immediately unless the mode is
  `workos`, because a foreign page cannot set a request header in the first
  place and a double-submit token would be checking a claim nothing makes. The
  guard is therefore tested in `workos` mode, against a real sealed cookie
  (`test/db/requests.test.ts`).
* **Step-up** is real even in fake mode: `fakeAuth` writes the same
  `auth_sessions` row the WorkOS adapter writes, keyed `dev-{user_id}`, with
  `authenticated_at = now()` the first time that `sid` is seen. So a fresh dev
  server decides successfully, and a dev session older than five minutes is
  refused with `reauth_required` exactly as production would refuse it. The
  development equivalent of `/auth/login?step_up=1` is
  `DELETE FROM auth_sessions WHERE sid = 'dev-<user_id>'`.
* **Origin** and **X-Requested-From** are unchanged in both modes: `curl` must
  send `Origin: http://localhost:8787` and `X-Requested-From: inbox`, and the
  README's walkthrough does.

**Why `Origin` is required here and optional elsewhere.** Everywhere else a
missing `Origin` is allowed, because `curl` and the tests are not browsers and
the cookie rules already cover the browser case. A decision is the highest-value
write in the product, and "the request did not say where it came from" is not an
answer worth accepting for it. The cost is that a non-browser client must set one
header; the test suite does.

---

## D3. `X-Requested-From` is not a security boundary, and is required anyway

**Decided.** The header is the fourth of five checks and is treated as what it
is: a statement by our own client about which surface issued the request, not
evidence about anything.

**Why keep it.** Two reasons, neither of which is "it stops an attacker".
First, a custom header forces a CORS preflight, so a cross-site form post or a
link cannot reach the route at all and the `Origin` allowlist gets to answer the
preflight. Second, it catches *our own* mistakes: a helper that replays a POST, a
future route that copies this one, a retry that fires from the wrong place. Those
arrive as a 403 with `reason: wrong_surface` rather than as a recorded decision
nobody made in the Inbox. The header lives in `src/domain/guards.ts` with that
argument written above it, so nobody later mistakes it for authentication.

---

## D4. Effects are planned from one table, and assigned away from the decider

**Decided.** `plannedEffects(kind, decision)` in `src/domain/effects.ts` is the
whole mapping: an approved application records one `access_grant`; an approved
invoice records `email_send` **and** `payment`; an approved agreement records
`signature` and `email_send`; every decline records none. Required role and
approval count come from `EFFECT_REQUIREMENTS` in `packages/shared`, so a payment
needing two `finance` holders is a contract fact rather than a literal in a
route. Rows are inserted `pending` with an `assignee_id`, and the assignment
query orders the decider **last**.

**Why two effects for an invoice.** "Created" is neither "sent" nor "paid", and
one row covering both would let a single approval imply both. The demo's receipt
said "Saved in Library · Not sent · No money moved": that is two absent things,
so it is two rows.

**Why the decider is assigned last.** An access grant or a payment carried out by
the same person who approved it is exactly the separation the reviewer roles
exist to create. Nothing *forbids* it — a one-Admin workspace has no alternative
and the query still assigns them — but the default should not hand it straight
back.

---

## D5. Every execution answers `unavailable`, and says so in a sentence

**Decided.** `POST /w/:ws/effects/:id/execute` records the attempt, sets
`status = 'unavailable'`, writes an `effect.executed` audit row, and returns
`EFFECT_UNAVAILABLE_REASON`: *"Not executed. This build sends nothing, pays
nothing, grants nothing and signs nothing."* A second press returns the same row
without appending a second audit row.

**Why not a stub that succeeds.** Because the entire approvals design is only
worth something if the row that says "not done" is telling the truth. A green
tick over an SMTP client that does not exist is worse than no button, and it is
the exact failure this repository is built to make impossible (CONVENTIONS,
invariant 5). The copy is one exported constant rather than three call sites,
because three copies of a promise drift.

**Guards.** Origin, CSRF, step-up, and the reviewer role the effect requires —
not Admin. Executing is not deciding; it is the separate act the decision handed
to somebody else.

---

## D6. History renders at read time; the counts are a second route

**Decided.** `events` holds ids and enum kinds only, so `GET /w/:ws/history`
joins each row to the subject rows it names and composes the sentence per
request. `GET /w/:ws/history/counts` is separate and reads
`v_decision_count`, `v_pending_grants`, `v_inbox_count` and
`v_created_documents`.

**Why read-time rendering.** It is the thing that makes erasure survivable. After
`redact_subject`, the request's label *is* `Deleted applicant` and its payload
*is* `{kind, redacted}`, so the same join produces "Maya admitted a deleted
applicant" and the page still renders — with no second code path and no stored
sentence to go back and rewrite. A test redacts a subject and asks for the page.

**Why the counts are not in the page.** `paginatedSchema(eventRowSchema)` is
`.strict()` and names three keys. It is also the better shape: the page changes
as you scroll and the counts do not, so a client backscrolling would otherwise
re-ask four aggregate questions it already knew the answers to.

**`blocked` is derived from the present.** The tab filters on the *current*
status of the subject rows — a request still `pending`, an effect still `pending`
or `assigned` — never on a flag stored on the event. An event is a fact about the
past; "is this still blocked" is a question about now.

---

## D7. `@react-pdf/renderer` under workerd: the spike was run, and the answer is no

**Found while building.** The plan lists it as **unverified**. It was installed,
imported and run inside the `worker` project (real workerd, the real
`wrangler.jsonc`). The library loads, the element tree builds, and then:

```
failed to asynchronously prepare wasm: CompileError:
WebAssembly.instantiate(): Wasm code generation disallowed by embedder
```

`@react-pdf/renderer` lays text out with `yoga-layout`, which ships its
WebAssembly as a base64 string and compiles it at runtime. Workers allow
WebAssembly only as a statically imported module in the bundle, so no export
condition of that library is reachable here. (`renderToBuffer` fails earlier and
differently — workerd resolves the browser condition, whose `renderToBuffer`
throws "a Node specific API" — but `pdf().toBlob()` reaches the same wall.)

**Decided.** The `renders` consumer renders a self-contained HTML file, stores it
at `w/{workspace}/documents/{document}/v{version}.html`, and writes **two**
statuses: `render_status = 'ready'`, because the render is real and complete, and
`pdf_status = 'unavailable'` with the reason above, because the PDF is not. The
dependency is not in `package.json`: shipping a library that cannot run to prove
it cannot run is weight, and this entry is the artefact.

**Why two columns.** One column with two meanings would have made the viewer say
"Rendering failed" about a document that renders perfectly well. The contract's
`pdf_status` has no `unavailable`, so the API maps it to `none` and puts the
sentence in `pdf_error` — the client then shows an explanation rather than an
error it would be wrong to retry.

**Would change it if.** yoga-layout gains a build that imports a `.wasm` module
statically, or the render moves to a service binding (a browser-rendering Worker,
a container) that is allowed to compile WebAssembly.

---

## D8. The render is a `jobs` row *and* a queue message

**Decided.** The decision's transaction writes a `render` job keyed
`render:{document_id}:{version}`. The job's runner sends the queue message. The
queue consumer does the rendering.

**Why both.** They do different jobs. The `jobs` row commits with the document,
so a render cannot be forgotten and the minute Cron retries the *send* until the
queue accepted it (invariant 6). The queue gives the work its own retries, a
dead-letter queue, and a consumer that is not holding a request open. Rendering
directly in the job runner would tie an HTML build to whichever request happened
to commit the decision; enqueuing directly from the transaction would send a
message about a row that might roll back.

---

## D9. The receipt derives its count when it is written, not when it was queued

**Decided.** The `receipt` job posts two messages into
`requests.session_id` — a `human` line and Iris's acknowledgement — and reads
`v_inbox_count` inside its own transaction to say "Three requests remain."

**Why not carry the count in the payload.** It would be the count at decision
time. Four decisions in quick succession would leave four confident, wrong
numbers in the transcript, and the transcript is the thing a person scrolls back
through to work out what happened.

**Idempotency, twice over.** `UNIQUE(kind, key)` on `jobs` with the key naming
the decision, and `client_id = receipt:{decision_id}:{role}` on the two messages
under `UNIQUE(session_id, client_id)`. The existence check runs *before*
`next_seq` is allocated, so a replay does not leave a gap in the session's
sequence numbers. A duplicated receipt is not cosmetic: it reads as a second
decision.

**The originating session, not the active one.** The request was proposed in one
conversation and the receipt belongs there, even when the person who decided it
was looking at another. A test writes a second, more recently active session and
asserts nothing lands in it.

---

## D10. A derived `subject_id`, so an erasure can find what the engine keyed by name

**Found while building.** `redact_subject(subject_id, workspace_id)` erases by
`subject_id`. The run engine writes only `subject_key` — the hashed, normalised
applicant identifier — and leaves `subject_id` null, so a data subject access
request had a key and no way to reach the rows.

**Decided.** Migration 0010 adds `subject_id_for(workspace_id, subject_key)`
(`md5(workspace || ':' || key)::uuid`, deterministic and tenant-scoped, needing
no extension) and a `BEFORE INSERT` trigger on `requests` that fills
`subject_id` from `subject_key` when it is null. `DELETE
/w/:ws/applicants/:subject_key` resolves the key to ids — falling back to the
function for rows written before the trigger existed — calls the procedure per
subject, and deletes the document prefixes from R2 *after* the commit.

**Why a trigger rather than a fix in the tool.** The tool is one writer of
`requests`; a trigger covers every writer, including the next one. And the whole
point of the erasure inventory is that it cannot depend on a future author
remembering.

**What it does not reach.** Attachments hang off a session rather than a subject
and have no per-person link to follow; they are covered by workspace deletion,
and Settings > Data and privacy says so.

---

## D11. The Library shows a pending request as a version 0 draft

**Decided.** `GET /w/:ws/documents` returns two kinds of row: pending `invoice`
and `agreement` **requests**, shaped as documents with `version: 0` and
`status: 'Draft · Awaiting review'`, and real `documents` rows, which exist only
after a decision approved one.

**Why no `documents` row before the decision.** The document is created *by* the
decision. A row written earlier would mean the Library held a saved document for
something nobody had approved, and the trigger in migration 0005 would then be
guarding a table that had already leaked the thing it was protecting. Version 0
is the tell a reader can use: a proposal has no version, because nothing has been
approved to be version 1 of.

**Versions and the render are sibling routes** (`/documents/:id/versions`,
`/documents/:id/render`) rather than keys in the entity, for the same reason as
D1: `documentEntitySchema` is `.strict()`.

---

# C12–C24: the client against the real Worker

Written while wiring `apps/client` to `wrangler dev --local` with `AUTH_MODE=fake`
and `MODEL_SCRIPTED=1`. Everything here is a place where the built server and the
client-port spec disagreed. The rule followed throughout was the brief's: the
server as built wins, the client adapts, and where the server looks wrong it is
recorded rather than changed.

---
