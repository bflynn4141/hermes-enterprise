# Uploads and client foundations

Upload decisions U1 through U11 and early client decisions C1 through C11.

[Back to the decision index](../DECISIONS.md).

## U1. The bytes are checked on `complete`, not on declare

**Decided.** `POST /attachments` records what the client *says* — a name, a size
and a MIME type — and mints a presigned PUT. `POST /attachments/:id/complete`
streams the object back through the binding, compares the first bytes with the
declared type, computes the sha256 the row keeps, and refuses a mismatch.

**Why.** Nothing at declaration time has seen a byte. The upload goes browser to
R2 so that 20 MB never passes through a Worker request, which means the only
moment we can check the content is after it exists. A renamed executable is the
named case in the plan; the general form is that the name, the size and the type
are three separate claims and all three are the client's.

A refusal deletes the object. Leaving it for the daily sweep would mean a file
we have just decided is lying about what it is sits in a workspace's store for a
day, and the sweep is a cleanup for things nobody decided about.

**Would change it if.** R2 gained a server-side content check on PUT, which is
not a thing S3-compatible storage does.

---

## U2. Verification runs with no transaction open, and the verdict commits either way

**Found while testing.** The first version marked the row `failed` inside the
tenant transaction and then threw, which rolled the mark back. The row sat at
`uploading` about bytes that had already been deleted, and nothing would ever
say why. A test caught it; the test is `refuses a renamed executable and deletes
the object`.

**Decided.** `complete` is three steps: one transaction to load the row (which
is also the membership check), verification with nothing open, and one
transaction to record the verdict — which commits whether the verdict is ready
or failed. The object is deleted after that commit.

**Why the middle step holds no transaction.** It streams up to 20 MB. A Postgres
connection held for the length of a download is a connection out of a budget the
plan alarms on at 150, and the work needs no database at all.

---

## U3. A presigned URL is signed by hand, not by a dependency

**Decided.** `src/storage/sigv4.ts` implements SigV4 query signing on Web
Crypto, about eighty lines. `aws4fetch` is not installed.

**Why.** The signature is HMAC and string concatenation in a documented order.
Every dependency here is pinned exactly and asks for a reason in this file
before it is added, and "concatenates strings in the right order" is not one.
The test is the interesting half: it asserts that the signature changes when the
method changes and when the key changes, which is what stops a PUT URL being
replayable as a DELETE and a URL for one object being pointed at another.

**Would change it if.** We needed multipart uploads, whose signing is genuinely
involved, or chunked payload signing.

---

## U4. Local development uploads through the Worker, and the route is development-only

**Decided.** `wrangler dev --local` simulates R2 on disk. There is no account
behind it and therefore no S3 credentials, so there is nothing to sign with.
With the three `R2_*` secrets absent the declare route answers
`upload.direct: true` and a URL on this Worker — `PUT /w/:ws/attachments/:id/upload`
— which writes through the binding. Outside `ENVIRONMENT=development` that route
answers 404.

**Why 404 rather than 403.** Saying "you may not" advertises that the route
exists. Outside development it does not.

**Why at all.** The alternative is that local uploads are impossible and the
whole path is untestable without an R2 account, or that the client grows a
second code path for development. This way the client PUTs to whatever URL it
was handed, in both places.

---

## U5. Extracted text lives in R2, next to its object

**Decided.** `{storage_key}.txt`. Postgres keeps two numbers, `text_length` and
`token_estimate`.

**Why.** Extracted text is derived, re-derivable and can be megabytes. A column
holding it turns every `SELECT *` on the table into a transfer of the whole
corpus, and makes the erasure inventory's answer for "where is the applicant's
text" two places instead of one. The two numbers are in the row because a list
needs to say "about 12,000 tokens" without reading a byte.

---

## U6. `get_document_text` returns 6,000 tokens and an offset, never a document

**Decided.** `getDocumentText(env, workspaceId, fileId, offset)` returns at most
6,000 estimated tokens and the offset to ask for next. Four characters to a
token, deliberately crude.

**Why.** A tool result is model input. A 20 MB extracted PDF returned in one
call is a context-window error at best and a large bill at worst. Paging also
makes the read interruptible: a stopped run stops between pages.

The page ends on a line break where one is available inside the window, because
cutting mid-line is how a model comes to quote half a clause as though it were
the whole one. A document with no line breaks is cut where the cap falls, since
the alternative is no progress.

---

## U7. Queue routing matches on the queue name's stem, not on a list of names

**Decided.** One `queue()` handler serves four queues whose names are suffixed
per environment (`hermes-extract`, `-staging`, `-production`, and a `-dlq` for
each). The router matches the stem and the suffix.

**Why.** A router listing exact names silently stops handling a queue the day
someone adds an environment, and the symptom is extractions that never happen
with no error anywhere. A queue this build does not recognise is retried, never
acked: an unknown queue means a deploy is behind, and acking deletes the
messages it is behind on.

Messages are acked and retried one at a time rather than per batch, so one
unreadable PDF does not send four healthy documents round the retry loop with
it.

---

## U8. A failure with a reason beats a retry that cannot succeed

**Decided.** The `extract` consumer distinguishes two kinds of failure. An
`ExtractionFailure` — no text layer, an unparseable PDF, an object over the
cutoff — is written onto the row as `failed` with its reason immediately.
Anything else is retried up to `max_retries: 3`, and the dead-letter consumer
writes `failed` with a reason when the retries run out.

**Why.** Retrying a PDF that has no text layer three times produces the same
nothing three times and tells the reviewer four minutes later than we could
have. The DLQ consumer exists for the other case, and for the general rule: a
message that exhausts its retries with no dead-letter queue is deleted, and the
row it was about says "preparing" forever. DLQ messages themselves expire after
four days, so reading a dashboard is not a plan either.

---

## U9. `unpdf` under workerd: the spike was run, and it works

**Decided.** `unpdf@1.8.1` is a dependency of the Worker. It is a serverless
build of pdfjs with the Node-only paths removed; it loads in workerd and
extracts text from a real PDF. About 570 KB gzipped of the bundle, which takes
the Worker from roughly 335 KB to 909 KB gzipped against a 10 MB limit.

**Why this is recorded rather than assumed.** Section 4 of the plan marked pdfjs
under workerd **unverified** and left it as an M1 spike. The spike is
`test/worker/uploads.test.ts`, which parses a hand-written one-page PDF in the
Workers runtime on every CI run, so a runtime or library upgrade that breaks it
fails CI rather than quietly producing empty documents.

**Why the import is still dynamic and guarded.** A static import of a module
that fails to initialise under workerd makes the *whole Worker* fail to start —
every route, for a PDF parser. The guarded dynamic import makes that one
extraction fail with a reason instead.

**A scan with no text layer is a failure, not an empty success.** The file is
fine; there is simply no text in it. An empty document presented as extracted
would be a lie the reviewer cannot see, so it is `failed` with a reason they can
act on.

---

## U10. An attachment is soft-deleted; a Context source is not

**Decided.** `DELETE /w/:ws/attachments/:id` sets `status = 'deleted'` and
`deleted_at`, and removes the objects. `DELETE /w/:ws/files/:id` removes the
row.

**Why the difference.** A message may reference an attachment, and History has
to keep rendering: the viewer shows "no longer available" rather than a hole. A
Context source is a setting rather than history — it governs future runs, and a
tombstone in a settings list is noise.

Both delete the object *and* its `.txt`. Leaving the text behind would leave the
document's contents in the store under a key derived from the one just deleted,
which reads as done and is not.

---

## U11. No audit event kind for an upload, yet

**Decided.** Uploading, completing and deleting a file writes no `events` row.

**Why.** `events.kind` is a CHECK constraint whose values are the shared
`EVENT_KINDS` list, asserted equal by a test. Adding `attachment.*` means a
migration that alters the constraint, a change to the shared contract, a rule in
the run-log validator and a decision about whether the `agent` role may publish
it — none of which belongs in the same change as the storage layer, and the
`agent` role cannot publish anything outside `message.*` and `run.*` anyway.

**What it costs.** History does not show "Maya added policy.pdf". The row
carries `uploaded_by` and `created_at`, so the fact is not lost, only unindexed
by the audit.

**Would change it if.** The pilot's attestation needs uploads in History, which
is an M5a question.

---

## C1. `provider-keys.ts` owns the provider-key contract, not the port

**Repository wins.** The client-port spec sketches a `ProviderKey` row with
`verified_models` as a count. `packages/shared/src/provider-keys.ts` — written
for the M2 key routes — already defines `maskedProviderKeySchema`, where
`verified_models` is the list of model ids and `last4` and
`fingerprint_prefix` have exact lengths. The client consumes that shape;
`entities.ts` keeps the name `ProviderKey` only as an alias, and the Settings
tab shows `verified_models.length`.

**Why.** Two shapes with one name in one package index is an ambiguous
re-export, which is a compile error rather than a judgement call — and the
stricter shape is the one a route already returns.

The same rule renamed the client's cached step shape to `runStepEntitySchema`:
`events.ts` already exports `runStepSchema` for the `run.step` *event*, and the
two are different shapes.

---

## C2. The library exports three atoms, not twelve

**Found while porting.** The spec's M2 table adopts
`Button, Chip, EntityChip, StatusPill, ValuePill, Switch, SegmentedControl, ProgressRing, Shimmer, StreamText, TextRow`
from `@hermes/motion-components`. The package's `index.ts` exports only
`Button`, `StreamText` and `Shimmer`; the other atoms exist in `src` and have
type declarations, but are not in the export map, and the library is not ours to
edit.

**Decided.** Adopt what is exported, keep the rest in `src/app/ui/primitives.tsx`
(which the spec already keeps for `Popover, Dialog, Disclosure, Tip, Avatar,
Panel, MenuItem`), and record it here rather than reaching into
`node_modules/@hermes/motion-components/src`.

**Would change it if.** The library adds them to its index; the swap is then one
import line per atom.

---

## C3. `SidebarNav` renders the whole sidebar column, and the account menu stays local

**Decided.** `SidebarNav` is adopted as the spec requires: the six sections are
its `navItems`, the Inbox badge is `counts.inbox` (from `v_inbox_count`),
`recents` is the sessions page, and `workspace`/`footerLabel` come from
bootstrap. `onNavigate` and `onPick` dispatch the same `nav/app … manual: true`
every other control uses, so the follow rule keeps one code path.

What is *not* delegated is the account menu: the spec moves the reduce-motion
toggle there, and the component's footer is a single click target. So a slim
Nous-styled account row sits below it and carries the toggle, the settings
shortcuts and the dev account switcher.

---

## C4. `HermesMotionProvider` wraps the app in `.hermes-ui`

**Found while running.** The provider renders its own `div.hermes-ui`, so the
whole shell is a descendant of the library's CSS scope. Two consequences:

* the height chain from `#root` to the shell runs through that div, which has
  no height of its own — the shell collapsed to its content height until
  `#root > .hermes-ui { height: 100% }` was added;
* the seven tokens the two stylesheets share (`--ink`, `--line`,
  `--line-strong`, `--line-soft`, `--conversation`, `--panel`, `--ease-out`)
  resolve to the library's values inside the wrapper rather than the product's.

The library was authored for this product and its values match closely enough
that the rendered result is coherent (see `apps/client/qa/`), so they are left
as they are rather than re-declared on the wrapper — re-declaring them would
change how the library's own components look, which is the opposite of adopting
them. The build prints the overlapping names on every run.

**The duplicate-token check** the plan asks for is therefore the honest form of
the question: it fails the build if the library declares a custom property at
`:root`, `html`, `body` or `*` — a scope that could reach the product's own
elements — and otherwise lists the scoped overlap.

---

## C5. `erasableSyntaxOnly` is off, and `exactOptionalPropertyTypes` stays off

**Found while typechecking.** The spec asks for both. `packages/shared` uses
constructor parameter properties (`RestError`, the mock-stream `Builder`), which
`erasableSyntaxOnly` refuses; the client typechecks the shared sources directly
through `paths`, so the flag would fail on code that is not the client's. esbuild
transforms parameter properties correctly, so the flag buys nothing here.

`exactOptionalPropertyTypes` is off to match `tsconfig.base.json`, which the
worker and the shared package are already written against. Turning it on is a
repository-wide change, not a client one.

---

## C6. Mock server mode is a `fetch` and a socket factory, not a second server

**Decided.** `MOCK=1` builds the client with `__MOCK__` true, and the adapter is
handed `createMockBackend()`'s `fetch` and socket factory instead of the
browser's. Everything still goes through the same REST client and the same zod
parse, so a mock response that does not satisfy the contract fails in the
client's own tests rather than drifting quietly. The run stream is
`packages/shared`'s `mockRunStream`, so the difficult sequences are the
contract's own scenarios rather than a second set invented for the mock.

    MOCK=1 pnpm --filter client build     # bundle that needs no worker
    MOCK=1 PORT=4180 node build.mjs --serve

Query parameters pick the fixture: `?data=empty` for the first-run empty states,
`?seat=member` for the Member seat, `?key=none|invalid` for the provider-key
banners. `__MOCK__` is a build constant, so a production build eliminates the
module; the build then deletes the orphan chunk esbuild still emits for the
folded dynamic import, and greps `dist/app.js` for `x-dev-user` to prove the dev
switcher is gone too.

---

## C7. Opening a session loads one message window; "Load earlier" pages backwards

**Found while running.** Neither the bootstrap nor the event contract carries a
session's existing transcript: bootstrap lists sessions, and the socket carries
what happens next. So `openSession` fetches the most recent window once
(`GET .../messages?limit=100`) and `loadEarlier` pages backwards from
`oldestSeq`. Without it a reload showed an empty transcript for a session that
had one.

---

## C8. A decision refetches its request row

**Found while testing.** `decision.recorded` carries `resulting_status` and the
effect ids — enough for the badge and the list, not enough for the review pane,
which needs the whole row. The client therefore refetches the request after a
decision commits (`ensure(kind, id, force)`), rather than patching a status into
the cached row and hoping the rest still matches.

---

## C9. A `resync` event re-bootstraps; it is not only a cache drop

**Found while testing.** The reducer's `cache/clear` empties the entity cache and
the message windows, but the client then has no data at all. The adapter treats
a `resync` event — and a replay page with `{resync: true}` — as: drop the
caches, re-run `GET bootstrap`, re-attach both sockets. Drafts and UI state
survive it, including across the re-bootstrap, because the server has never seen
what someone typed.

---

## C10. The Playwright suite runs against mock mode; the system scenarios wait for the worker

**Decided.** `pnpm --filter client e2e` runs P1 to P3 from the spec's §11 table
against the mock bundle, plus a Member-seat check and a screenshot sweep. Those
are the scenarios that are about the *client*: the empty states, the triage
list, follow/pin, the review pane, the badge arithmetic.

P4 to P14 assert what the *server* does — two browser contexts racing one
decision, the guarded route refusing a Member, guidance mid-run, Stop, a
provider 5xx, a dropped socket, the share viewer's polling, the injection
fixture. They need `wrangler dev` with Docker Postgres, `AUTH_MODE=fake` and the
scripted provider, and they land with the M2/M3 worker routes. `E2E_BASE_URL`
points the same config at that server.

---

## C11. What the port deliberately left behind

The presenter, the intro slides, the "one week later" interstitial, the scripted
conversation engine (`conversation.mjs`), the fixtures and the seeded sessions.
The demo's local event log (`eventTime`, `uid('evt')`, the fabricated `events`
array) is gone with them: History reads `events` rows.

Three demo behaviours changed because the port fixed a bug the demo had:

1. `sameRef` compares `field`, so navigating from the blocker card to the
   destination field pins the view instead of being mistaken for "already the
   focus" (spec §4.6.1);
2. a receipt is written into the session that produced the request, not into
   whatever session happens to be active, and an inactive session shows an
   unread marker instead (spec §4.6.2);
3. an acknowledgement is a server message that exists only after the commit, so
   the demo's third bug — acknowledging before the state settles — is
   structurally gone.

---

# M3: the run engine

Numbering starts at 40 so that M3.5's attachments work, which was in flight at
the same time, keeps 37 to 39.

---
