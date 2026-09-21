# Provider and interface decisions

Provider decisions R1 through R13 and interface decisions C33 through C47, including C34b.

[Back to the decision index](../DECISIONS.md).

## R1. An OpenRouter catalog id is `openrouter:<vendor>/<model>`

**Decided.** `catalog.model_id` for a synced row is the provider's own id behind
one prefix: `openrouter:anthropic/claude-sonnet-4.6`. `openRouterCatalogId` and
`openRouterModelId` in `packages/shared/src/catalog.ts` are the only two places
that know, and the adapter strips the prefix before the request is built. The
column's contract widened from 64 to 128 characters, because OpenRouter already
publishes ids longer than 64 once prefixed.

**Why.** Three reasons, and only the third is the deciding one.

`catalog.model_id` is a single global primary key across every provider, and
OpenRouter re-exports ids other providers also publish. Today
`anthropic/claude-sonnet-4.6` collides with nothing; the day we add an Anthropic
row whose id is that string, or OpenRouter brokers something called `gpt-5-5`,
an unprefixed scheme has a primary-key conflict between two rows that are billed
to different accounts and reached over different transports.

Second, `model_calls.model_id` and `runs.model_id` are what somebody reads in
six months to answer "who paid for this". A prefixed id answers that without a
join to `catalog`, which matters because `catalog` is mutable and the run rows
are not.

Third, and the reason the alternative was rejected: the obvious alternative is
to store the raw id and let `provider` disambiguate. That works until you write
the *client*, where a model id travels alone — in a session row, in a URL, in a
menu's selected value — and every consumer would have to carry the provider
alongside it or look it up. One string that is self-describing is a smaller
contract than two that must stay together.

**Would change it if.** OpenRouter's ids ever collided with each other, at which
point the prefix is not enough and the id has to be a surrogate key with the
provider id as an attribute.

---

## R2. `openrouter_chat` is its own transport, not a second `deepseek_chat`

**Decided.** A fourth value in `TRANSPORTS`, a fourth adapter, a fourth case in
`providerForTransport`. Both speak OpenAI-compatible Chat Completions.

**Why.** The transport enum in this product does not mean "wire format", it
means "replay rules" — that is the sentence in `model/types.ts`, and it is what
makes the enum worth having. OpenRouter's rules differ from DeepSeek's in all
three places the interface cares about:

* Reasoning comes back as `reasoning_details`, an ordered array of typed blocks,
  and the docs require the whole consecutive sequence back unchanged. DeepSeek's
  is one `reasoning_content` string. See R3.
* The knob is `reasoning: { effort }`, not `reasoning_effort`.
* 402 means the workspace's OpenRouter account is out of credits, which no other
  provider in this product can say and which no other status maps to.

Sharing an adapter would have meant a `if (this.provider === 'openrouter')` in
six places inside `deepseek.ts`, which is the shape a second provider always
takes just before it becomes a third.

The duplication is real and it is priced: `toChatMessages`, the tool-call
reassembly and the usage read are near-copies. They are near-copies that are
free to diverge, which is the property that matters when the divergence is the
whole reason the file exists.

**Would change it if.** A third OpenAI-compatible broker arrives with the same
reasoning shape, at which point there is a shared base worth extracting because
there would be two things to share it between rather than one.

---

## R3. Reasoning is replayed as `reasoning_details`, in order, untouched

**Decided.** A fourth `ReasoningCarry` variant,
`{ kind: 'openrouter_reasoning_details', details }`, carrying the array as it
arrived. The adapter refuses a carry another transport produced rather than
coercing it, exactly as the other three do. `ReasoningDetail` is an open
interface with an index signature.

**Why.** The reasoning-tokens documentation is explicit: pass the assistant
message's `reasoning_details` back, and "the entire sequence of consecutive
reasoning blocks must match" — no rearranging. The blocks are typed
(`reasoning.text`, `reasoning.summary`, `reasoning.encrypted`) and an encrypted
one is opaque by construction, so there is no version of "normalise it" that is
not "drop some of it".

Two details are worth stating because they are where this goes wrong:

The deltas and the carry are separate events, as they are for every other
transport. `reasoning` (the plaintext string) is what a person reads and is
emitted as `reasoning_delta`; `reasoning_details` is the protocol and is emitted
once, at the end. A reducer that confused them would replay prose, which fails
on the *next* turn of a tool-using run and looks like a model problem.

The blocks accumulate by `index`: the same index across frames is one block
whose text is being appended to, and `data` is replaced rather than appended
because it arrives whole. A block that arrives with no index at all gets the
next one, so a provider that omits it does not collapse three blocks into one.

**Would change it if.** OpenRouter offered a documented normalised form that
round-trips every upstream's requirements. `reasoning` (the string) looks like
that form and is not: the docs recommend the array for tool-calling, which is
every run this product makes.

Cited: <https://openrouter.ai/docs/use-cases/reasoning-tokens>,
<https://openrouter.ai/docs/api-reference/streaming>.

---

## R4. 402 is permanent with copy, 502 and 503 are transient

**Decided.** `openRouterError` maps the documented table onto the existing
failure classes: 401 → `auth`, 402 → `permanent` as an `OpenRouterCreditsError`
whose message names credits and the page to add them, 403 → `auth`, 408 →
`transient`, 429 → `rate_limit`, 502 and 503 → `transient`, everything else
through the shared `classifyStatus`. A frame that carries an `error` object
mid-stream is mapped the same way instead of ending the stream quietly.

**Why.** Two of these are not the default and both are load-bearing.

`classifyStatus` already turned 402 into `permanent`, which is the right class:
retrying a request that was refused for want of money cannot succeed. What it
did not have was copy. "openrouter responded 402" tells an Admin nothing they
can act on, and the body cannot be quoted — `http.ts` refuses to carry provider
prose into an error string, for good reasons about keys ending up in logs. So
the copy is a constant of ours: the account is out of credits, add credit at
openrouter.ai/credits, run again.

502 and 503 would otherwise be `transient` anyway by the `>= 500` rule; they are
called out because on OpenRouter they mean something specific — the chosen
upstream is down, or no provider meets the routing requirements — and both are
worth retrying against a different upstream, which is what OpenRouter does on
the retry.

The mid-stream case is the one that would have been missed. OpenRouter can
answer 200, stream a few tokens, and then put a failure in the stream. Without
the check, a moderation block or an upstream dying halfway reads as a short but
successful answer, and the run completes with a truncated message nobody knows
is truncated.

**Found on the way.** `errorFromResponse` read `error.code` and passed it to
`redactString` without checking it was a string. OpenRouter's `error.code` is
the HTTP status as a *number*, the regular expression happily coerced it, and
`redactString` threw a `TypeError` from inside the error path — so every non-2xx
from this provider would have surfaced as a crash rather than a classified
`ProviderError`. One line, and a test for each status.

**Would change it if.** OpenRouter publishes a `Retry-After` we should honour
rather than leaving to the Workflow step's own backoff.

Cited: <https://openrouter.ai/docs/api-reference/errors>.

---

## R5. Attribution headers are constants, not configuration

**Decided.** `HTTP-Referer` and `X-Title` are two module constants in
`openrouter.ts`, sent on every request including the verification probe.

**Why.** They identify the *product*, not the deployment: a workspace looking at
its own OpenRouter dashboard should see one app name, whether the request came
from staging or production. Making them vars would mean a header assembled from
configuration on the one request in this codebase that also carries a customer's
credential, and a header is a place a value ends up somewhere it is logged.

**Would change it if.** A customer asks for their own attribution, at which
point it is per-workspace data and not configuration either.

---

## R6. The catalog is synced on verification, by a SECURITY DEFINER function

**Decided.** A successful OpenRouter verification fetches `GET /api/v1/models`
and writes the usable rows into `catalog` with `source = 'provider_list'`. The
write is one statement, `SELECT sync_openrouter_catalog($1, $2)`, and that
function is `SECURITY DEFINER`: `app` keeps its SELECT-only grant on `catalog`.
The weekly reverify job runs the same sync.

**Why the function rather than a grant.** `GRANT INSERT, UPDATE ON catalog TO
app` is one line and it is the wrong line. The catalog is the file that says
what a model costs, and "a price change is a new migration, so the change is
reviewable" is a property of this system that a route with UPDATE on the table
quietly ends. The function's body cannot name a provider other than
`openrouter`, and its upsert has `WHERE catalog.source = 'provider_list'`, so no
payload — hostile, malformed or merely wrong — can rewrite a seeded row. The
grant assertion in `test/db/grants.test.ts` still reads `catalog: ['SELECT']`,
which is what a reviewer looks at.

**What the sync refuses, and why it refuses quietly.** A row whose `prompt` or
`completion` price does not parse is skipped, not defaulted to zero — a
free-looking model that is not free is the error nobody catches until the
invoice. A row that cannot take text in and produce text out is skipped. A row
without tool calling is *written* and greyed with a reason, because every run in
this product calls a tool and a model you can see and cannot pick is better than
one that is mysteriously absent. The counts are returned and the Settings screen
shows the written one.

**What it does to a row that disappears.** Disabled with a reason, never
deleted: `sessions.model_id`, `runs.model_id` and `model_calls.model_id` all
reference `catalog`, and a session that named a model last week still has to
render.

**Where it is not.** Not in the verification transaction. The list is a call to
a third party and Hyperdrive pins a Postgres connection for the life of a
transaction, which is the same read-probe-record shape the rest of `keys/` uses.
And a sync that fails does not fail the verification: the key is good, the
catalog is stale, and the Settings row says when it last synced.

**Would change it if.** The list grows past what one statement should carry, at
which point it is a job with a cursor rather than a call.

---

## R7. The key row carries a count and a date, not the model list

**Decided.** Two new columns on `workspace_provider_keys`,
`synced_model_count` and `models_synced_at`, both null for every provider whose
`verified_models` is the whole answer. An OpenRouter key's `verified_models`
stays empty.

**Why.** `verified_models` is a `text[]` that the Settings screen renders and
every masked-key response carries. Several hundred ids in it would be a payload
nobody reads, on a route that is called on every Settings open. The count and
the date are what a person actually wants to know — "342 models synced · last
sync 15 Mar" — and the list itself is already in the catalog, where the model
menu reads it with search and paging.

They are recorded by their own function rather than by `setKeyStatus`, because
they are a different fact with a different lifetime: a key can verify without a
sync, and a stale count surviving a later failed verification would claim models
the workspace can no longer reach.

**Would change it if.** A second provider needs a list this long, at which point
the two columns want to be one `sync` jsonb rather than a pair per provider.

---

## R8. `GET /w/:ws/catalog` is paged and searched in SQL

**Decided.** `?q=`, `?provider=`, `?limit=` (50 default, 200 max) and `?after=`,
answering `{ models, total, next_cursor }`. `loadCatalog` — every row — still
exists for the places that know the count is small. Bootstrap now carries only
the seeded rows plus whatever this workspace's live sessions name.

**Why.** Before OpenRouter the table had four rows and returning all of them was
the simplest thing that could work. A workspace with a synced key has several
hundred, and there are two payloads that would quietly become large: the model
menu on every open, and `bootstrap` on every page load. The second is the worse
one, because nobody would notice it in a menu they only open sometimes.

The search runs in SQL rather than over a list the client already has, because
the list the client already has is one page of it. `position(lower(...))` rather
than `LIKE`, because the needle is user text and escaping `%` and `_` in it is
one more thing to get wrong.

**Found on the way.** The first version passed `workspaceId` as `$1` to both the
page query and the count query. The count query does not mention a workspace, so
Postgres refused to infer the parameter's type and the whole call failed with
42P18. The filter's placeholders are now numbered from `$1` and the workspace id
is appended last, for the page query only.

**Would change it if.** Someone wants to sort by price, at which point the
cursor cannot be `model_id` and becomes a composite.

---

## R9. `PATCH /w/:ws/sessions/:id` accepts `model_id`, and validates it

**Decided.** The patch route takes `model_id`, checks the catalog has it, and —
outside `MODEL_SCRIPTED` development — checks this workspace may actually run
it: not disabled, has tool calling, and has a verified key for its provider.

**Why.** It did not take it. The composer has sent `{ model_id }` on every model
pick since M3, the route answered 422 `empty_patch`, and the client swallowed it
with `.catch(() => undefined)`. Nothing broke, because the turns route carries a
`model_id` of its own and re-sent it — so picking a model and immediately
sending a message did the right thing, and picking a model and reloading the
page put the old one back.

With four models that was a curiosity. With three hundred it is a lie: you
search a long list, pick something specific, the menu shows it selected, and the
session did not keep it. That is the sort of bug that makes people stop trusting
a control.

Validated against what the workspace may run rather than against mere existence,
because a session pointing at a model the turns route will refuse is a failure
moved from the moment of the choice to the moment of the work.

**Would change it if.** Nothing. This is the route the client always thought it
was calling.

---

## R10. The model menu is searched and paged, and pinned rather than virtualised

**Decided.** `apps/client/src/app/chat/ModelMenu.tsx`: a search box that queries
the server, rows grouped by vendor prefix with a sticky heading, 60 rows a page
behind "Show more", price per million and context window on each row, the
workspace default marked "Company default", the effort control only for a model
with `supports_reasoning`, a tool-less model greyed with its reason, and
arrow-key navigation over the options.

**Why a component.** It was eight lines inside `Composer.tsx` because the
catalog was four rows. What changed is not the size of the list but what the
control *is*: not a list to read, but a thing to search.

**Why paged and not virtualised.** Virtualising is faster and is not free: it
breaks find-in-page, it breaks the roving focus, and it is a dependency or a
hundred lines of scroll maths. Sixty rows render in under a frame. If a single
vendor group ever needs three thousand rows visible at once, this is the line to
revisit.

**Why the grouping is a pure exported function.** `groupByVendor` is the
judgement the component makes about a list whose shape it did not choose, and
getting it wrong is silent — a row in the wrong group is just a row somebody
cannot find. It has a unit test; the rendering is covered by the live scenario.

**One thing worth naming.** Picking a row also upserts it into the client's
`catalog` entity cache. The composer's own button label reads that cache, which
is seeded from the deliberately-trimmed bootstrap, so a row picked out of the
paged list would not have been in it — and the button under the menu would keep
showing the old model until the next page load, which reads as the pick not
having worked.

**Would change it if.** The catalog grows a second axis worth browsing by
(modality, say), at which point the vendor headings become a filter row.

---

## R11. The OpenRouter verification fixture, and why it is a var

**Decided.** `OPENROUTER_FIXTURE=1` makes the Worker answer OpenRouter's `/key`
and `/models` from a built-in six-model fixture. Refused unless
`ENVIRONMENT=development`, opt-in per deployment, set in `wrangler.jsonc`'s
development vars only, and asserted absent from staging and production by the
same test that guards `MODEL_SCRIPTED`.

**Why it exists.** The deliverable asks for a live scenario that adds a key,
verifies it, syncs a catalog and picks one of the synced models in the real
client against the real Worker — with no network and no key. `MODEL_SCRIPTED`
already covers the *run*; nothing covered *verification and sync*, which is the
half this milestone is about.

**Why a fixture and not a mocked fetch in the test.** The test drives a browser
against a Worker in another process. There is no seam in the test to inject.

**Why it is safe enough.** It serves a fixed fixture no caller can influence, so
it is not a way to write arbitrary catalog rows; it answers 501 to anything but
the two endpoints, so a run that reached for it fails loudly rather than
answering fiction; and it is behind two independent gates, one of which is the
environment name the code already trusts for `MODEL_SCRIPTED`. The README says
it exists, in the section a person reads before adding a key, so nobody
discovers it by grep.

**Would change it if.** A staging environment ever wants to rehearse the
OpenRouter flow, at which point it needs a real key in Secrets Store and not
this.

---

## R12. OpenRouter is the only provider, and the rule is one variable in one module

**Decided.** `ALLOWED_PROVIDERS` is a Worker variable, `openrouter` in all three
environments in `wrangler.jsonc`, unset means `openrouter` rather than
everything, and `apps/worker/src/model/allowed.ts` is the only module that reads
it. Five places ask it the same question:

* installing, verifying or rotating a key (`routes/keys.ts`) → 422
  `provider_not_allowed`, "Only OpenRouter keys can be used in this workspace";
* `GET /w/:ws/catalog` and `bootstrap` → rows of other providers are not in the
  payload at all;
* `PATCH /w/:ws/sessions/:id` and `PATCH /w/:ws/settings` → the same 422 when a
  client names a model by id;
* `POST …/turns` → the same 422, and unlike the key check it is asked under
  `MODEL_SCRIPTED` too.

The four seeded rows stay in the `catalog` table and the other three adapters
stay in `src/model/`. `loadCatalog` *marks* them `provider_not_allowed`;
`loadCatalogPage` with `onlyAllowed` *drops* them.

**Why a variable and not a constant, a CHECK or a deleted adapter.** Three
alternatives, and each loses something that is still needed.

Deleting the adapters loses the tests. `deepseek_chat`, `anthropic_messages` and
`openai_responses` are where the per-transport reasoning-replay rules of
decision 26 are actually exercised, and those rules are the reason the transport
enum exists at all. `ScriptedProvider` drives them still.

A database CHECK loses the history and the future. `model_calls` rows from last
month reference `deepseek-flash`, `sessions.model_id` and `runs.model_id` are
foreign keys into `catalog`, and a row that cannot exist is a row those cannot
point at. And relaxing a CHECK for a customer who brings an Anthropic account is
a migration and a deploy, where this is a `wrangler deploy --var`.

A constant in code loses the ability to say so per environment, which is the
form the next request for this will take — a pilot that is OpenRouter-only and a
customer deployment that is not.

**Why unset means OpenRouter rather than everything.** A variable that widens
when it goes missing is a variable that widens during exactly the incident where
nobody is reading configuration. The fallback is the documented product, and a
unit test asserts the value in all three environments, because an environment
disagreeing with the other two is the deployment nobody meant to make.

**Why the catalog route drops the rows and `loadCatalog` keeps them.** They
answer different questions. A menu of models nobody can pick is what teaches
people to stop reading a menu, so the list has none. But the settings route is
handed a `model_id` by a client and has to say *why* it will not take it, and
"the catalog does not offer that model" sends an Admin looking for a row that is
right there. So the marking exists for the refusals and the filter for the list.

**Would change it if.** A customer brings their own vendor account, at which
point the variable grows a second name and the four seeded rows come back into
the menu on their own.

---

## R13. A fresh workspace starts on Sonnet 5, and a stale default is moved on verification

**Decided.** `DEFAULT_MODEL_ID` is `openrouter:anthropic/claude-sonnet-5`.
Migration 0016 writes a placeholder `catalog` row for it with
`source = 'provider_list'` and makes it the `workspace_settings.default_model_id`
column default. `promoteDefaultModel`, called inside the same transaction as
every OpenRouter catalog sync, moves a workspace whose default is not allowed,
not enabled or tool-less onto Sonnet 5 — or onto the first tool-capable row if
that account cannot reach it — carrying its unarchived sessions with it and
writing one `settings.changed` events row.

**Why a placeholder row rather than "no default".** `default_model_id` is a
foreign key into `catalog`, and the row it has to name does not exist until a
key has been verified and a list synced. The alternatives were a nullable column
— which every reader would then have to handle, for a state that lasts minutes —
or leaving the default on `deepseek-flash`, which is the bug: the composer would
refuse the first message of a new workspace with "Add a deepseek key in Settings
to start", about a provider the Settings screen no longer offers.

`source = 'provider_list'` and not `'seed'`, deliberately: a seeded row is one a
sync may never overwrite (decision R6), and this one *must* be overwritten. Its
price is Anthropic's published Sonnet figure rather than zero, because a row
that says free and is not is the error nobody notices until the invoice — and
the first sync replaces every column of it anyway.

**Why the promotion is on sync and not on read.** Bootstrap is a GET, and a GET
that writes makes "has this workspace ever changed a setting" unanswerable. The
sync is the only moment that is both a write and the moment the rows the new
default names come into existence. It also means the weekly reverify job fixes a
workspace nobody has touched.

**Why it carries the sessions.** A session's model is copied from the default
when it is created, not joined at read time (that is deliberate — a person
switching mid-run must change the next run, not this one). So moving only the
default would leave a workspace full of sessions naming a model every turn is
refused for, and the person would have to re-pick a model in each one. Archived
sessions are left: nobody is going to run one, and rewriting them would edit
history to no purpose.

**What it will not do.** It never overrules a default that is already runnable.
An Admin who chose Gemini keeps Gemini through every later sync; a sync is not a
reason to overrule somebody's choice.

**Would change it if.** OpenRouter ever stops listing a Sonnet, at which point
the preference is a list rather than one id — the fallback already handles it,
but silently, and a list would say so.

---

## C33. The Iris panel has three states, and a rail is the middle one

**Decided.** `ui.irisOpen: boolean` is gone. `ui.irisPanel` is `open | rail |
hidden`, `ui.irisWidth` is a nullable number of pixels, and `ui.irisUnread` is a
count.

* **OPEN** — the chat pane at the remembered width. With nothing remembered the
  demo's rule applies unchanged: 800 px at 1840 and wider, an equal split of the
  work area below it. Minimum 420 px, maximum 60 percent of the work area.
* **RAIL** — 56 px between the navigation and the app, carrying the Iris mark in
  its live run state, an unread badge, "Open Iris ⌘L", and New session and
  Sessions, both of which open the panel before they act.
* **HIDDEN** — no rail. The app header's "Open Iris" is the way back, which is
  the control that was already there.

`iris/toggle` still works, and still means what its callers meant: `open: true`
opens, `open: false` goes to the *rail* rather than to nothing, and no argument
is open↔rail. From `hidden` it can only open — hiding completely is a deliberate
choice and a toggle does not half-undo one. The preference is persisted per
workspace and user, beside drafts and for the same reason; `hermes:iris-open`
is migrated once and deleted, with `false` becoming `rail`.

**What was borrowed, and from where.** Fifteen minutes of reading, and four
things worth taking:

1. **One shortcut, and it is ⌘L.** Cursor binds both `Cmd I` and `Cmd L` to
   "Toggle Sidepanel" (https://cursor.com/docs/reference/keyboard-shortcuts).
   Two keys for one action is two things to document; we took the one that is
   already in people's hands and left ⌘I alone.
2. **A persistent affordance to reopen, and it is an icon strip.** Codex's IDE
   extension tells you to "choose the Codex icon" and, failing that, to run
   "Codex: Open Codex Sidebar" from the Command Palette
   (https://learn.chatgpt.com/docs/codex/ide) — the icon is an activity-bar
   entry, which is a 56 px rail. ChatGPT's desktop app toggles its sidebar with
   `⌘ + B` and leaves the rail behind
   (https://learn.chatgpt.com/docs/reference/commands). A panel that closes to
   nothing is a panel people lose.
3. **The collapsed affordance reports state.** Cursor puts "an orange dot on
   that tab" when a chat is awaiting input (https://cursor.com/changelog/0-48-x).
   Our rail does the same with a number on it, and the mark itself keeps the
   run's own state rather than going flat.
4. **"Hide it completely" belongs in an overflow menu.** Cursor added "a 'More
   Actions' ellipsis to hide the chat and configuring positioning directly"
   (https://cursor.com/changelog/2-3). Ours is in the session options menu, one
   level away from the ordinary Hide.

Two things were deliberately **not** borrowed. Cursor's multiple chat tabs
(`Cmd T`, `Cmd [`, `Cmd ]` — same source) and its Agents Window, which runs up
to eight agents in parallel (https://cursor.com/changelog/2-0,
https://cursor.com/changelog/3-0): this product has one Iris per session and a
Sessions popover that already does the switching, and a tab strip would be a
second session model beside the one the server has. Nothing in either product's
official documentation says whether the pane is resizable or how wide it
remembers being, so the width rules here are the demo's and ours.

**Why a rail rather than a narrower chat pane.** The failure a collapse has to
avoid is not "the chat is small", it is "the chat is gone and I did not mean
that". 56 px is too narrow to read and wide enough to say *something is
happening and here is how to get back* — which is the whole job. Below 1000 px
there is no room for even that beside a usable app pane, so the rail is not
shown there and the existing Chat/App switch is unchanged.

**Two things this touched that were not obvious.**

* `is-compact` used to be a fact about the *window* (`< 1560`), which was the
  same thing as a fact about the chat pane while the chat pane was always half
  of it. It is not any more: a 460 px pane in an 1840 px window needs the tighter
  paddings whatever the window says, so it is now either.
* **The app pane keeps a measure.** Collapsing hands the app 1544 px at 1840,
  and a dashboard at 1544 px is not a better dashboard — it is the same rows
  with a person's name at one edge and the button that acts on them at the
  other. The pane caps its content at 1180 px and grows its gutters, applied to
  the header, the subheader and the body together so nothing drifts out of line.
  `padding-inline: max(28px, calc((100% - 1180px) / 2))` costs nothing in the
  open layout, because at an 800 px pane the second term is negative.

**One judgement inside the shortcut.** ⌘L fires from anywhere in the shell
*except* an editable element — a shortcut that steals a keystroke mid-sentence
is a shortcut people turn off. The composer is the one exception: there it still
collapses, and focus moves to the app pane, because leaving focus inside a pane
that is about to be 56 px wide is the one outcome nobody wants. `irisShortcut`
in `src/app/panel.ts` is a pure function over the keystroke and its target, so
that rule is testable and readable rather than buried in a handler.

**The mark's fifth state.** Four of the rail's states are the ones the open
header already shows. `comparing` needed a rule, and it is a fact about
`run.steps` rather than a guess about the model: a working run that has finished
at least one step has something to compare against. Every animated state in this
client is driven by a server event, and this one is no exception.

**Would change it if.** If people turn out to use `hidden` as their default, the
rail is costing 56 px for nothing and the honest answer is a preference rather
than three states. If a second agent ever shares the pane, the rail becomes a
list and Cursor's tab model stops being the wrong shape.

---

## C34b. Three identical "New session" rows, and the four bugs behind them

**Decided.** Clicking New session three times used to produce three blank
sessions, all titled "New session", all identical in the sidebar
(`qa/panel/sidebar-before.png`). Four changes, and they are four different
bugs:

1. **New session reuses a blank session.** `createSession` looks for a session
   with no messages, no run and still the placeholder title, and opens that
   instead of creating a twin. It matches a *pending* one too, which is the
   whole race: the first click inserts a local row and posts, the second arrives
   before the POST answers, and a rule that skipped pending rows created the
   second session anyway. It also opens the panel and puts the cursor in the
   composer, because a New session that leaves you looking at a collapsed rail
   is a New session you have to click twice.
2. **A blank session is not listed** — in the sidebar or the sessions popover —
   unless it is the one you are in. One is the session you just opened; three is
   a list of nothing.
3. **The first turn names the session**, from its first six words, dispatched
   before the POST so the sidebar stops saying "New session" the moment Enter is
   pressed, and PATCHed so a reload agrees. When the run finishes, the object it
   produced renames it again — "Ada Ling · application" — derived from the
   session's focus ref and the request already in the entity cache. No route was
   added for either; both are `PATCH /w/:ws/sessions/:id`, which existed.
4. **A manual rename wins, permanently.** `titleSource` moves to `manual` and
   nothing auto-titles that session again. A title somebody typed is a decision,
   and a product that quietly undoes it is a product people stop trusting with
   names. Two races had to be closed for that to hold: a server row re-delivering
   the old title must not undo a local rename, and a server row still saying
   "New session" must not undo a local auto-title that the PATCH has not landed
   yet. `session/upsert` handles both.

Row lists call an unnamed session "Untitled session" rather than "New session".
The stored title is untouched; the point is that "New session" is the name of
the *control that creates one*, and two buttons a keystroke apart with the same
accessible name is a sidebar where one phrase means two things.

**The bug this uncovered, which is the one worth reading.** Focusing the
composer on New session made something reachable that never had been: typing
the first sentence *faster than `POST /w/:ws/sessions` answers*. The turn was
posted to the optimistic id — `POST /w/:ws/sessions/local-…/turns` — which the
Worker answers `400 {"reason":"bad_id"}`, and the message was simply gone. The
adapter now keeps the creation promise per local id and resolves it before any
route is built. Nothing was wrong with the optimistic session; what was wrong is
that an id which is deliberately not a uuid was allowed into a URL.

It is worth saying why nothing caught it. The optimistic id has been there since
the first commit, and so has the 400; the two never met because no control put a
cursor in the composer at the moment a session was being created. A latent bug
of this shape is not found by testing the thing that changed — it is found by a
scenario that does what a person would do, which is why `live-panel.spec.ts` N6
types rather than posting.

**Would change it if.** If auto-titling ever wants more than the first turn and
the focus ref — a summary, say — it stops being derivable in the client and
becomes a server concern, and the right shape is a title the run writes rather
than one the client guesses.

---

### C34b, continued (September 20, 2026): the name is the server's

The two automatic names used to be written from the client: the first six
words of the first turn, and, when a run completed, the object it produced.
The second needed the session's focus to point at the request, and focus is
only written while the app is following Iris. A workspace that opens in the
activation flow pins the pane, so the first session a new customer ran kept
its provisional name forever. On a reload, provenance was also lost: any
non-placeholder title read as a person's, so a refresh between the first turn
and the run's end silently disabled the rename.

Both names are now written by the server, and `sessions.title_source`
records who wrote them: `default`, `turn` (the turn route), `run` (the engine
in `finish`, from the earliest request the run proposed), or `manual` (a title
through `PATCH /sessions/:id`, or a row inserted with a real title). Only
`default` and `turn` may be replaced by a run; `manual` sticks, which is the
same rule as before but kept where it survives reloads and second devices.
The engine tells the session's socket with `entity.updated {entity_type:
'session'}`, which the agent role may now publish about a session one of its
runs belongs to (migration 0065 widens the 0013 guard by the same shape). The
client shows the first-turn name optimistically and persists nothing for it;
on the event it re-reads the row, and the reducer's manual-wins merge is
unchanged. The `Follow Iris` state no longer has any part in naming.

### C34b, and the follow mode itself (September 20, 2026): the pane never moves on its own

"Following Iris" let a run's `set_focus` move the app pane, and manual
navigation "pinned" it until Follow was pressed. It was the one piece of the
interface that moved without the person touching it, and its state machine
(follow, pinned, resume, filters retained through a resume) was where two of
the day's unexplained failures lived. It is removed. A run's focus is still
recorded on the session — `session.focus`, with the run that set it — and the
reply carries one line, `Open Inbox · Resolved`, that dispatches an ordinary
manual navigation when clicked. Selecting a session still shows the object it
was working on, because choosing the session is the person's act. The engine,
the `set_focus` tool and the `run.focus` event are unchanged; only the client
stopped acting on them uninvited.

## C35. The session row's status rides in its label, because the library has no slot

**Decided.** `SidebarNav` renders a recent's `label` and nothing else: `prompt`
reaches `onPick` and is never drawn, there is no second span, and the library
decides which row is current by comparing `label` to `activeTitle`. So the live
status is part of the label — "Partner applications · Needs review" — and
`activeTitle` is decorated identically so the comparison still works.

The row is allowed two lines rather than truncating. A person scanning this list
is scanning for "Working", and a row that ellipsises exactly that word answers
the wrong question.

The words are the demo's, not the server's raw value. `v_session_status` is the
*run's* status — `COALESCE(r.status, 'idle')` — so what arrives is `idle`,
`working`, `waiting`, `stopped`, `completed`. Those five map to Ready, Working,
Waiting, Stopped, Ready. Anything else the server sends is passed through
unchanged, because a screen renders the server's sentence rather than its own
and a server that writes a better one should win. A blank session gets no word
at all: "Ready" on a session nobody has used is a status about nothing.

**Why not fork the library.** It is not ours to edit, which is the standing rule
here, and the alternative — rendering our own list beside `SidebarNav`'s — means
duplicating its header, its search box and its selection model to gain one span.
A label that reads well is the cheaper honest answer.

**Would change it if.** The library grows a `sub` or a right slot on a recent,
which is a two-line change here and deletes this decision.

---

## C36. Navigation width follows the explicit disclosure, never the window breakpoint

**Decided.** `.shell.nav-collapsed { --nav-w: 76px }` and the automatic
breakpoint collapse remain gone. The navigation column is 240 px while the
component is expanded. When a person uses `SidebarNav`'s own disclosure, the
shell mirrors its public `data-sidebar-collapsed` state and gives the grid cell
the component's 52 px rail width. The `.sidebar` cell clips throughout the
transition.

**What was actually wrong.** The demo collapsed its hand-rolled navigation to
icons below 1180 px, and the rules that did it named `.brand-name`,
`.nav-label`, `.nav-item` and `.workspace`. M2 replaced all of that markup with
`SidebarNav` from the component library and kept the breakpoint. `SidebarNav`
sets its own width from its own state — 224 px expanded, 52 px collapsed, by its
own control — and none of those four selectors matches anything it renders. So
below 1180 px the *column* became 76 px while the *component* stayed 224 px, the
cell did not clip, and the navigation drew itself across the pane beside it,
starting at x=0. Three panel states and six page walks later, nothing had caught
it.

Two numbers also never added up: the cell's 20 px padding around a 224 px
component is 264 px in a 240 px column, so even at full width the component
overhung by 24 px — invisible only because the chat pane's own background
painted over it in the one state anybody looked at.

**Why mirror instead of force.** The library still owns the disclosure, inline
width, focus handling and expand control. The client does not override any of
those. It only observes the public state attribute after the control changes it
and gives the surrounding grid the matching width. This avoids `!important`, a
fork, and duplicate interaction state while allowing the explicit collapse a
person requested to release real workspace space.

**What the test had to change to see it.** Every assertion the panel suites
already made was about the grid, and the grid was always right: a grid item's
box *is* its column, whatever its contents do. `getBoundingClientRect()` was no
better — it reports an element's full box even where an ancestor clips it, so it
both missed the real overlap and invented false ones once the cell started
clipping. `expectNoNavOverlap` hit-tests instead: sample a vertical line of
pixels three px to the right of the column and ask `elementFromPoint` what is
there. If the answer is ever inside the navigation, a person can see it. That
assertion fails on the old code and passes on the new, which is the only
evidence worth having. A geometry regression also asserts that explicit
collapse changes the outer grid cell from 240 px to 52 px, not merely the inner
component.

Two smaller things went with the original breakpoint removal. `.shell-outer`
now clips: a focus or a `scrollIntoView` inside a pane was able to scroll the
whole shell 48 px off the top, which is never something the shell should do.
`ui.navCollapsed` is now written only when the explicit disclosure changes and
is read by the shell's column geometry.

**Would change it if.** The library grows a controlled `collapsed` prop, at
which point the breakpoint can come back and mean something.

---

## C37. The end-to-end suite runs on a file it owns, because `.dev.vars` beats the environment

**Context.** `apps/client/scripts/e2e-live.mjs` started `wrangler dev` with
`env: { AUTH_MODE: 'fake', MODEL_SCRIPTED: '1', OPENROUTER_FIXTURE: '1' }` on
the spawn, and both the README and `live.spec.ts`'s own header said the live
suite ran scripted. It did not. Wrangler does not take bindings from the process
environment: `getVarsForDev` reads `.dev.vars` and overwrites the config's vars
with what it finds. So on a machine whose `.dev.vars` said

```
MODEL_SCRIPTED="0"
OPENROUTER_FIXTURE="0"
```

— which is the *documented* way to run the product against a real OpenRouter
key locally — `pnpm e2e:live` sent fifty scenarios' worth of turns to a real
provider on somebody's real key, and said "MODEL_SCRIPTED=1" in three comments
while it did it. The same file is read by `@cloudflare/vitest-pool-workers`, so
`pnpm --filter @hermes/worker test` had the same hole.

**Decision.** The suite runs on variables it generates and checks.

1. `e2e-live.mjs` writes `apps/worker/.dev.vars.test` from `.dev.vars` with
   `AUTH_MODE=fake`, `MODEL_SCRIPTED=1` and `OPENROUTER_FIXTURE=1` forced, reads
   it back, and refuses to start if any of the three is not what it wrote.
2. `wrangler dev` is given `--env-file .dev.vars.test`. That flag rather than
   `--var`, and the reason is in wrangler's own code: `.dev.vars` is loaded only
   `if (!envFiles?.length)`, so naming an env file excludes it outright, where a
   `--var` is merged *underneath* the secrets `.dev.vars` loads and would lose
   the same race again.
3. The worker vitest project sets the same three as miniflare `bindings`, which
   are applied after the pool has read `.dev.vars`.
4. The file is generated, never committed: it carries the local Postgres strings
   and the local KEK, and a committed copy would be a key in the repository and
   a second place to keep in sync. `.gitignore` gained `.dev.vars.*`.

**And then it is proved rather than asserted.** Two guards, because the file
only proves what was *asked* for:

* a Worker already answering on the port is no longer reused. It used to be, so
  that a suite could be re-run against a stack you were watching in a browser —
  but that stack is `pnpm --filter @hermes/worker dev`, which reads `.dev.vars`,
  which is the file this script no longer trusts. `E2E_REUSE_WORKER=1` is the
  way back, and it names what it is opting into.
* before Playwright starts, the launcher sends **one turn** through the real
  HTTP routes and waits for the scripted provider's own sentence to come back.
  A Worker on a real provider either has no verified key for the seeded
  workspace and fails the turn, or answers something else; either way the suite
  stops after one turn instead of after fifty.

The port comes from `E2E_BASE_URL` rather than a constant, and the base URL is
added to `ALLOWED_ORIGINS` in the generated file, so the suite can run beside a
"real local mode" Worker on 8787 without touching it. That is how this change
was verified: the suite on 8799, the real Worker left alone on 8787.

**What it cost.** `pnpm e2e:live` is about ten seconds slower, all of it the
probe. That is the price of the sentence "the suite did not call a provider"
being a measurement rather than a claim.

**Would change it if.** Wrangler grows a documented precedence for process
environment over `.dev.vars`, at which point step 2 becomes unnecessary — step 1
and the probe would stay.

---

## C38. The transcript's scroll model: three positions, and a spacer that makes two of them one

**Context.** On send, the transcript did not move. The demo's rule — "a user
message or `nearBottom` scrolls to `scrollHeight`" — is correct in a transcript
that is already taller than its viewport and wrong in the one case that matters:
the moment a question is asked. `el.scrollTop = el.scrollHeight` on a short
transcript is a no-op, so the new question and the first lines of the reply were
drawn wherever there happened to be room, which at an 800 px pane is under the
subheader. The reported screenshot is a reply whose first line is cut off by the
breadcrumb.

**Decision.** Three positions, and nothing else moves the viewport.

| When | Where |
|---|---|
| a user message arrives | its top edge goes to the top of the transcript's content inset, and the reply streams into the space beneath it |
| a delta, while the reader is at the bottom (96 px) | the bottom |
| a delta, while the reader is not | nowhere. The **Jump to latest** chip appears, outside the scroll region |
| `message.final`, a step row, a receipt, a queue row | nowhere, unless the reader is pinned |
| a session switch | the remembered `scrollTop`, as the demo did |

**The spacer is the whole mechanism.** A `div` after `.transcript`, sized on
every layout to `clientHeight − (everything after the anchor's top)`. That makes
"the question at the top" and "scrolled to the bottom" the *same* scrollTop
while the reply is shorter than the viewport, so the two rules cannot fight: a
pinned reader is already reading from the top of their own question. When the
reply grows past the viewport the shortfall is zero, the spacer disappears, and
a pinned reader follows the text down exactly as before. This is how ChatGPT
does it — a bottom spacer / `min-height` on the last turn, sized so the maximum
scroll lands with the prompt at the top; it is not vendor-documented, and it is
cited here as reverse-engineered rather than published
(<https://jhakim.com/blog/handling-scroll-behavior-for-ai-chat-apps>).

Two details the arithmetic needed:

* **twice per layout.** The first pass measures `scrollHeight` while React is
  still committing the rest of the turn, so its answer is one layout behind and
  the first *painted* frame is short by exactly the transcript's top padding.
  The second pass measures the layout the first produced. It is a fixed point.
* **the inset.** "The top of the viewport" means the top of the transcript's
  own content inset, not the container's border edge. The first message of a
  session cannot reach the border — the padding is above it — so anchoring later
  ones flush would put the same message in two places depending on where it was
  in the conversation, and the flush one reads as clipped by the subheader,
  which is the defect. The scroll target is `anchorTop − paddingTop`.

**What was borrowed, and from where.**

* *pinned only while already pinned, cancelled by a scroll up.* The convention
  every client in this class has converged on; the canonical implementation is
  `use-stick-to-bottom`, which "allows the user to cancel the stickiness at any
  time by scrolling up" and discusses ~70 px as the re-engage threshold
  (<https://github.com/stackblitz-labs/use-stick-to-bottom>). Vercel's AI SDK
  ships it as the default primitive: `<Conversation>` "automatically scrolls to
  the bottom", with a `<ConversationScrollButton />` that "appears when not at
  the bottom" (<https://elements.ai-sdk.dev/components/conversation>). The demo
  already used 96 px and it is kept: it has to be larger than one line, or a
  reader sitting at the bottom is un-pinned by the line that arrives under them.
* *a scroll-to-bottom chip, outside the scroll region.* Cursor 3.0: "Added a
  'scroll to bottom' button in the agent panel that appears when content
  overflows" (<https://cursor.com/changelog/3-0>). Cursor's own forum is also
  the argument *for* the send-anchor: users ask it to "anchor the viewport at
  the top of that message so I can read downward as content streams in"
  (<https://forum.cursor.com/t/top-anchored-reading-for-chat-responses-or-opt-out-of-auto-scroll-to-bottom/162811>).
* *reduced motion.* Only one scroll in the file is animated — the chip, which is
  a deliberate human action and the only place orientation is worth an
  animation for. `scroll-behavior: auto` "scrolls instantly", and
  `prefers-reduced-motion: reduce` is the signal to use it
  (<https://developer.mozilla.org/en-US/docs/Web/CSS/scroll-behavior>). Every
  other move is an assignment to `scrollTop`, which is instant for everyone:
  animating the follow of a stream would mean the animation is always behind
  the text.

**What was considered and not used.** CSS `overflow-anchor` is the native
version of half of this, and MDN marks it *Limited availability* — "not Baseline
because it does not work in some of the most widely-used browsers" — which is
why `use-stick-to-bottom` reimplements it in JS
(<https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-anchor>).
`scroll-snap-align: start` pins a turn to the top declaratively, but MDN's own
warning rules it out here: "Never use `mandatory` if the content inside one of
your child elements will overflow the parent container", which is every reply
longer than the pane
(<https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_scroll_snap/Basic_concepts>).

**Claude.ai is described from observation, not cited.** Anthropic publishes no
changelog or doc for claude.ai's send and stream scrolling; the only public
artifacts are third-party (a userscript that exists to add a scroll-to-bottom
control, and Claude Code issues about auto-scroll overriding a reader's
position). It matches the convention above, and that is recorded here as an
observation rather than dressed up as a source.

**How it is tested.** `e2e/live-transcript.spec.ts`, from the browser's own
rectangles rather than from class names, because every one of these defects was
invisible in the DOM and obvious on screen. T1 records the anchor's offset on
every animation frame in the page — a round trip to the test process is too slow
to catch the first frame — and asserts it within 8 px of the inset. T2 samples
the gap thirteen times across a run and asserts it never exceeds 1 px. T3
scrolls to the top mid-run and asserts the position is unchanged 2.5 s later
with the chip up. T4 compares boxes against the composer at its tallest. T6
proves the second question anchors like the first.

**Would change it if.** `overflow-anchor` reaches Baseline, at which point the
`nearBottom` half could be the browser's job and the spacer would stay.

---

## C39. Chat replies may use light Markdown; tool arguments still may not

**Context.** The plan's prompt-injection section says every model-authored
string "renders as plain text in review panes: no markdown links, no HTML", and
`packages/shared/plain-text.ts` enforces it at the *writer*. That rule was
written about the strings a tool call puts in a row — a review note, an
instruction body, a proposal's evidence — and it was applied to chat prose as
well, in both directions: the transcript rendered `message.text` in a
`white-space: pre-wrap` span, and the system prompt told the agent to write
plain text. So a reply containing `**bold**` or a `- ` list arrived as literal
asterisks and hyphens, and the model — correctly following its instructions —
sometimes said things like "I won't output raw markdown syntax per my
constraints", which is the product apologising for a rule it did not need.

**Decision.** Split the rule along the line it was always about.

* **Tool arguments: unchanged.** `plainText()` and `findMarkup()` still refuse
  HTML, markdown links, autolinks and control characters in every string a tool
  writes. Nothing in this decision touches that file or any screen that renders
  its rows.
* **Chat prose: a safe subset.** Paragraphs, `**bold**`, `*italics*`,
  `` `inline code` ``, fenced code (through the library's `CodeBlock`), ordered
  and unordered lists, headings folded to h3, blockquotes and simple pipe
  tables.
* **Never, in either: HTML, and links as anchors.**

**The parser is the allowlist.** `src/app/chat/markdown-subset.ts` produces a
small node union with no HTML node and no anchor node; `Markdown.tsx` renders
only those nodes, with no `dangerouslySetInnerHTML` and no element chosen from
data. Every string reaches the DOM as a React child, which escapes it. That is
why a library was not used: every Markdown library worth having ships raw-HTML
passthrough and an anchor renderer, both on by default, and turning them off is
a configuration line somebody removes the day they want a `<br>` in a table.
Here there is nothing to turn off.

**Links render as text plus their destination.** A `link` node carries its label
and its href, and the renderer draws the label followed by a non-interactive
chip holding the bare URL. Selectable, copyable, not a click target. A
`javascript:` or `data:` target does not even get the ordinary chip — it is
marked refused and shown as the text it is. `![image](…)` becomes a link node
too, so nothing remote is ever fetched: a remote image in a reply is a beacon as
well as a link. The reasoning is the plan's own: "a destination hidden behind
words the human trusts" is the trick, and a reply is not a safer place for it
than a review note.

**Streaming.** `parseMarkdown` is a pure function of the accumulated text and is
called on every delta. Partial input is the normal case: an unterminated fence
is a code block that is still open, an unterminated `**` is two literal stars, a
table with only its header row is a table with no body. Nothing waits for a
terminator, so nothing pops into place when one arrives. The tree is re-parsed
rather than appended to, which is what stops a `**` being drawn as two stars and
then removed two characters later. A reply with nothing to mark up keeps the
plain span it always had (`hasMarkup`), so the common case keeps its exact
typography and no parser has any say over it.

**The prompt changed with it** (`apps/worker/src/engine/prompt.ts`, additive):
tool arguments are plain text, the reply may use light Markdown, and neither may
carry HTML or a markdown link. The paragraph about writing a URL out is kept
because it is still the instruction that matters.

**Tested** in `markdown-subset.test.ts`: `<script>`, `<img onerror>`,
`javascript:` targets, HTML entities, nested emphasis, an image, a reply that is
nothing but links, and a loop over every prefix of a structured reply asserting
no word is ever lost mid-stream.

**Would change it if.** A reply needs a second list level or a real anchor. The
first is a shape to add; the second is a product decision, not a renderer one.

---

## C40. Activity renders above the answer

**Context.** `RunSurface` rendered `LoadingState`, `ThinkingState` and
`ToolChips`, then `StreamingText`, then `TaskRows` — and the finished message
renders *above* the whole surface, because `RunSurface` sits after
`session.messages`. So a completed turn read: the answer, then the steps that
produced it. Codex, Cursor and Claude all put the trace above the reply.

**Decision.** Within a turn: `LoadingState`, `ThinkingState`, `ToolChips` and
`TaskRows`, then the streamed text. Reading downwards is reading in order — what
the agent did, then what it said. The queue and the waiting and failed states
are activity too: they say what the run is about to do or is stuck on, which is
a thing to read before the answer rather than after it.

When the run settles, `ThinkingState` is given stage 4 — its own collapsed
state — with `done` set to "Done · N steps", expandable, which is the shape
Claude's collapsed activity row has. Stage 4 is only claimed when the run is
actually over: a completed stage on an unfinished step list would draw a check
beside a step that failed. Worked time and the response actions stay in the
footer, where they were.

**Would change it if.** A turn ever produces activity *after* its text — a
follow-up tool call on the same turn — at which point the order is per-segment
rather than per-turn.

---

## C41. `StreamingText` is the third component not adopted

**September 19, 2026 clarification:** The current incremental reveal starts from
the text already present when its component mounts. Restored checkpoints are
visible immediately, never replayed from blank after navigation. Only subsequent
deltas use the existing reveal loop; reduced motion remains immediate. Mount,
remount, appended-delta and durable-final handoff regressions cover this boundary.

**Context.** A turn whose reply was the word "testing" rendered "3 sources" and
offered "Show the application evidence" and "Draft a follow-up for missing
details". Nothing had gone wrong: `StreamingText`'s `sources` and `followUps`
default to the gallery's fixtures, and `RunSurface` passed neither.

The prop fix is one line. The component was dropped anyway, for three reasons
that are the same shape as `PromptBar`'s and `AgentScreen`'s (C23, C27):

1. **It re-animates text the server already sent.** `loop={false}` stops the
   restart, but the component still reveals its `content` word by word on its
   own timer. The words were already delivered by `message.delta`. Every
   animated state in this client is driven by a server event; this one is driven
   by `WORD_MS`.
2. **It cannot render structure.** `content` is `{ text }[]`, joined with
   spaces. A reply with a list or a table has nowhere to go (C39).
3. **It owns an action row and a sources row** — copy, replay, helpful, "Add to
   Collective", a sources disclosure — that duplicate `ResponseFooter` and claim
   things this run did not do. "Replay response" re-runs the component's
   animation, which is a replay of nothing.

**Decision.** The stream renders through `IrisText`, the same component the
finished message uses, plus a CSS caret. `message.final` swapping one for the
other therefore changes nothing on screen, which is the property that was
missing before: the stream and the message had two different renderers and the
text visibly re-flowed when the run ended.

**Would change it if.** The library exposes a controlled `StreamingText` with no
built-in timer and no action row.

---

## C42. A fixture default is a lie with a plausible sentence in it

**Context.** C41's bug is not specific to `StreamingText`. Fifteen of the
twenty-one library components default a content prop to a gallery fixture, and
the fixtures are not lorem ipsum — they are "Maya Chen", "Leah's application",
"partner-review.ts", "Partner criteria v2". In a product whose entire claim is
that what it shows happened, a placeholder that reads like a real row is the
most dangerous kind there is.

**Decision.** Every call site passes every fixture-bearing prop explicitly, with
an empty array, an empty object or a real value. Three were found beyond
`StreamingText`: `ToolChips` was drawing the gallery's `review-notes.md`,
`screening.json` and `follow-ups.md` diff chips under every run's tool calls;
`CodeBlock` in the trace detail carried the gallery's diff; `ThinkingState` its
`additionalSources`.

**Tested in two halves, because either alone is insufficient.**
`src/app/library-defaults.test.ts` scans every `.ts`/`.tsx` file under `src/`
for each component's opening tags and asserts each required prop is present —
that is what catches a *new* call site, which a render test cannot, because it
does not know the call site exists. Then it renders each component to static
markup with an empty payload and asserts none of nineteen fixture strings
appears — that is what catches a prop that is passed but does not suppress the
fixture.

The tag scanner is written by hand rather than as a regex, and that is not
fussiness: JSX props are full of `>`, so `items={list.map((s) => s.title)}` ends
a lazy `<Tag …?>` match four props early and the audit then reports a prop that
is right there. It tracks brace depth and quoting and stops at the `>` that
closes the tag.

**Would change it if.** The library's next version makes the content props
required, which would move this from a test to a type error — the better place
for it.

---

## C43. The suites get their own database and their own port

**Context.** Every automated suite in this repository ran against `hermes` —
the database the developer's own `wrangler dev` on :8787 is showing them. The
symptoms were reported from the other side of the screen while this work was in
flight: the Inbox filling with scripted "Ada Ling" requests, one set per run;
about fifty sessions named "P4 race", "T1 send-scroll", "T3 scrolled away" in
the session list; and the workspace default model, which had been set to
`openrouter:anthropic/claude-sonnet-5` by hand, silently back at
`deepseek-flash` because `db:seed` runs at the start of `pnpm e2e:live` and
writes the seed's value.

The only cure was `pnpm db:reset`, which tore the Docker volume down and took
the verified provider key with it. (It did, in the course of this work. The key
is not recoverable and has to be added again.)

**Decision.** Two stacks that share the Docker container and nothing else.

| | dev stack | test stack |
|---|---|---|
| database | `hermes` | `hermes_test` |
| Worker | :8787, `pnpm --filter @hermes/worker dev` | :8788 by default, started and stopped by `pnpm e2e:live` |
| variables | `apps/worker/.dev.vars` | `apps/worker/.dev.vars.test`, generated per run |
| model | whatever `.dev.vars` says, possibly a real provider | always `MODEL_SCRIPTED=1` |

It is one variable, because `apps/worker/scripts/db-config.mjs` already
assembles every connection string from `PGDATABASE`. `scripts/test-db.mjs`
creates `hermes_test` if it is absent, migrates and seeds it, and hands back the
Hyperdrive strings; `pnpm e2e:live`, `pnpm db:test` and the worker vitest
projects all go through it, and `apps/client/scripts/live-fixture.mjs` — which
the live specs use to read rows back — defaults to it too.

**Four guards, because a default is not a guarantee.**

1. the launcher refuses to start if the port is 8787;
2. it refuses if the database it resolved is not `hermes_test`;
3. it refuses if any `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_*` in the
   generated file does not end in `/hermes_test`;
4. it will not reuse a Worker it did not start, and there is no flag for it any
   more (C37 had one). A Worker somebody else started was configured from
   `.dev.vars`: it is pointed at the dev database by definition.

`/health` turned out to be a popular path — 8788 on the machine this was written
on was an unrelated project answering `{"ok":true}` — so the probe checks the
*shape* (`{ status, version, checks: [...] }`) and says "something that is not
this Worker is listening" rather than mistaking it for a Hermes stack.

**`pnpm db:reset` changed too**, in two ways that follow from the same idea.
It recreates the `hermes` database rather than running `docker compose down -v`,
because the volume is shared and a suite may be using `hermes_test`. And it
**keeps the seed workspace's provider keys**: they are copied out with `\copy`
before the drop and copied back after the seed, which works because the seed's
workspace id is a constant and the seed writes no key rows of its own. A wrapped
provider key is somebody's real credential; it is the one thing in that database
that cannot be regenerated by running a script.

**Would change it if.** The suites move to a throwaway container per run, at
which point the database name stops mattering and the port guard is the only
thing worth keeping.

---

## C44. The activity block is one line, and only when a tool ran

**Context.** C40 put the trace above the answer, which was right, and left the
trace as it was, which was not. What it rendered under every reply was a
`ThinkingState` header ("✦ Done ▾") *and* a `TaskRows` list whose rows were
"✓ Thinking · Done ▾" and "✓ propose_request · Done ▾". Two of those three
things are noise:

* **"Thinking" is not a step.** The engine emits a `provider` step labelled
  "Thinking" for every model call — twice in the ordinary two-turn script. It is
  true of every turn, it is the same words every time, and there is nothing a
  reader can do with it.
* **A per-step "Done" pill restates its own container.** The block says "Done";
  the rows then each say "Done" again.
* **`TaskRows` is not a step list.** It has a details chevron per row and a
  Retry callback, which are affordances for a queued follow-up and a parked run
  — the two things a person can actually act on.

**Decision.** Three states, and the first one is nothing.

| | what is drawn |
|---|---|
| no tool call in the turn | **nothing.** No block, no header, no disclosure |
| working, a tool running | one line: `LoadingState`'s inline form, the tool's own label and the elapsed timer |
| settled | one muted line, `Done · N steps ▾`, expandable to `ToolChips` |

`TaskRows` stays, for the queue and for a run parked on a question, and nothing
else. Worked time and the response actions stay in the footer where they were.

The collapsed row is a plain `<details>` rather than `ThinkingState`, and the
reason is the same shape as the other library decisions: `ThinkingState` insists
on a step list with its own spinner and its own checks, and reserves 176 px for
it, for a trace that is usually one row.

**And a bug fell out of writing it.** `ToolChips` had never rendered a single
chip in this product, because `store.ts`'s `run.step` handler read `tool_call_id`
and `attempt` off the wire and then dropped both on the floor — so every step
looked like a non-tool step and every step looked like it belonged to the
current attempt. The README has claimed "`ToolChips` one per `tool_call_id`"
since M3. It does now. The same fix restores "Earlier attempt", which could not
have worked either.

**Would change it if.** A turn's trace grows something a reader acts on
mid-run — a permission prompt, a file being written — at which point the
collapsed line needs a second state that is not "done".

---

## C45. A refused turn says what the server said

**Context.** `POST /w/:ws/sessions/:id/turns` answered
`400 {"error":"Add a deepseek key in Settings to start","reason":"no_key"}` for
a new session still on the workspace default model. That is a good refusal: it
names the provider, it names the screen, it is a sentence for a person.

The composer threw it away. All three send paths ended in
`.catch(() => undefined)`, so from the outside: the draft vanished, nothing
appeared, no run started — and the session renamed itself to "testing" after a
turn that never ran.

**Decision.** Every refusal is rendered, and nothing is lost.

* **The server's sentence, verbatim.** `refusalFor()` maps a reason to an
  *action*, never to replacement copy: the Worker knows which provider, which
  cap and which number, and a client that rewrote any of it would drift. What
  the client adds is the route to the fix, which is the thing only the client
  knows — "Settings → Provider keys" for `no_key`, `key_invalid` and
  `key_revoked`.
* **A reason the client has never seen is still shown**, with its own words and
  no action, rather than being replaced by "Something went wrong" — which would
  be strictly less useful than what the server already wrote.
* **A request that never reached a Worker gets the one sentence the client
  writes itself.** `TypeError: Failed to fetch` is a message for a developer.
  The discriminator is whether there is a `reason` at all.
* **The draft comes back and the caret goes with it**, so the next thing typed
  is a correction rather than a retype.
* **The session's name is put back.** `autoTitle` still runs before the POST —
  the sidebar should stop saying "New session" the moment Enter is pressed — but
  the previous title is kept and restored if the turn is refused, unless a
  person has renamed it in between, because a manual rename wins permanently
  (C34b) even over the client undoing its own guess.

`role="alert"` rather than `role="status"`: the person pressed Enter and nothing
happened, so this is the answer to something they just did.

**Tested** in `refusal.test.ts` (seven cases, including "never returns an empty
string" and "never rewrites the provider name out of the server's copy") and as
T7 in `live-transcript.spec.ts`. T7 injects the 400 with Playwright's route
interception rather than provoking it, and says why in the test: `MODEL_SCRIPTED=1`
skips the provider-key check, and turning the scripted provider off is the one
thing the test stack must never do (C43). The body is the Worker's own, and
everything after the interception — the draft, the title, the corrected send
that succeeds — is the real client against the real stack.

**Not done, and named rather than assumed.** A new session's model still comes
from the workspace default even when that model has no verified key. Choosing a
different one for them is a product decision — it changes which model their work
runs on without being asked — and the honest version of it needs the banner to
say what was changed and why. The refusal above makes the current behaviour
legible, which is the part that was broken.

**Would change it if.** The turns route grows a `retry_after` that the client
should count down, which is the one refusal where a static sentence is not
enough.

---

## C46. Members is inline rows, not the library's database table

**Decided.** `RecordsTable` is out of the product. Members renders the shell's
own `.list-row`/`.members-row`: avatar, name (with "· You" on your own row),
the email under it, a role pill, a status pill, the joined date, and one action
on the right — Manage on a member, Resend or Reinvite plus Withdraw on an
invitation. The import is gone from `Workspace.tsx` and nothing else in the
client uses the component.

**Why.** `RecordsTable` is a *database* surface, and it brought a database's
furniture onto a screen about colleagues: a selection checkbox column, an "Add
calculation" affordance, a horizontal scroller, a "2 count" footer, and — from
the library's own fixture columns — a header called **Evidence** over a column
describing people. C27 argued the calculation column could be made honest by
filling `reviewGap` with real reviewer roles, and that much was true; it was
answering the wrong question. Nobody sorts, pins, multi-selects or computes
over a membership list, so every control on it was cost with no use, and
"Evidence" over a colleague's name is a sentence the product does not mean.
The word must never appear on this screen again.

The other three list screens named in the same review — the Inbox list, Library
→ Documents and the Traces list — were never adopted onto `RecordsTable`; they
have always been `.list-row`, and they stay that way. `FilterTable` keeps
History, where the state filter is a question an operator actually asks, and
session pinning stays where it always was, in the sessions popover. Sorting and
pinning are added where the product needs them and nowhere else.

The tabs changed with the rows. "All members" reads the WorkOS membership
mirror; "Invitations" now reads the **invitations list**, which is where an
unaccepted invitation lives. The mirror only ever holds people who have
accepted — `listMembers` joins `users` and the server writes no `invited` row on
that path — so the old tab (members filtered to a non-active status) was
filtering a set the server never fills, and always rendered empty. The row
actions are the routes that already existed: `POST …/invitations/:id/resend`
(one route behind two words, because the server accepts `pending` and `expired`
alike) and `POST …/invitations/:id/withdraw`. `memberCounts` counts the same
list, so the header's "N invited" and the tab agree.

**Would change it if.** A membership list grows a reason to sort or to act on
many rows at once — a workspace with hundreds of seats — at which point the
right answer is still probably a sort control on these rows, not a table with a
calculation column.

---

## C47. The sidebar's footer is a name, not a headcount

**Decided.** `SidebarNav`'s `footerLabel` is `state.user.name` and nothing else,
with the user's avatar as `footerIcon`. It is still the button that opens the
account menu. `memberCounts` is no longer read in `Sidebar.tsx`.

**Why.** It said "Maya Chen · 2 joined": a number about other people in the one
place on the screen that is about you, next to your own face. The count is not
lost — the Members header carries "N joined · M invited", and so does the
workspace menu's Members row in Settings → Organization — so the footer was a
third copy of a fact nobody goes there to read, and it made the identity row
read like a statistic.

**Would change it if.** The footer becomes a workspace switcher rather than an
identity, where a seat count would be about the thing being switched.


---
