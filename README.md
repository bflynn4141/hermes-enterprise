# Hermes Teams Demo

An agent workspace where the agent does the work and people make the decisions.

A team talks to their agent, Iris, in one workspace. Iris screens applicants,
drafts invoices and agreements, and queues each one in an Inbox with a receipt.
A person reviews, approves or sends it back. Admissions, documents, sending,
payment and signature can only happen when a human decides, and that rule is
enforced by the database and the routes, not by a prompt or a policy document.

![The workspace: a chat with Iris on the left, the Iris overview and the Needs you list on the right](docs/assets/readme-overview.png)

> **Independent project.** Hermes Teams Demo is not affiliated with, endorsed
> by, or maintained by Nous Research. It runs the open-source
> [Hermes agent](https://github.com/NousResearch/hermes-agent) runtime and, by
> default, talks to the Nous Portal inference API. Trademarks belong to their
> owners. Licensed under [MIT](LICENSE).

## What it looks like

Every consequential action arrives in the Inbox as a request of a specific
type, with what the agent found and a decision a person has to make. The chat
stays on the left the whole time, so the conversation and the decision are one
flow. All data below is fixture data.

**1. An application, screened by Iris.** Iris scores the applicant against the
program's criteria and cites its sources. The Admin admits or declines. Iris
says it plainly in chat: it cannot admit anyone itself.

![Application review: Iris's screening scores and sources on the right, the chat that produced the request on the left, Admit and Decline at the bottom](docs/assets/flow-1-application-review.jpg)

**2. A services agreement.** The draft, its scope, fees and term, the sources
it cites, and who may approve. Approval saves an unsigned agreement to the
Library. Nothing is signed or sent.

![Agreement review: the draft agreement with its scope and fees, the approval requirement, and Approve agreement draft](docs/assets/flow-2-agreement-review.jpg)

**3. An invoice.** Same shape, different type: the amount, line items and
dates, and an approval that saves a draft without any payment ceremony.

![Invoice review: amount, issued and due dates, line items, and Approve invoice draft with the note that no payment or email is sent](docs/assets/flow-3-invoice-review.jpg)

**4. After the decision.** The request moves to Resolved with who decided and
when. The document is saved, still unsigned, and the chat card updates to
"Draft saved, unsigned, not sent".

![The agreement after approval: Saved unsigned, one of one Admin approval by Maya Chen, and the chat card showing draft saved](docs/assets/flow-4-agreement-saved.jpg)

**5. The receipt lands in the conversation.** The decision is recorded in the
session that asked for it, and Iris continues from there. What the decision
implies, such as granting access, is a separate effect a person executes later.

![Receipt in chat: Iris reports the applicant is admitted and access is pending, and the Resolved pane shows What this implies with a pending access grant](docs/assets/flow-5-receipt-in-chat.jpg)

## Try it in a minute

You need Node 22+, pnpm and Docker. Python 3.11 to 3.13 is only needed to run a
Hermes agent locally (see `runtime/hermes/README.md`). Everything except
`pnpm install` works offline.

```sh
pnpm install
pnpm db:up                                  # Postgres 17 in Docker on 127.0.0.1:5433
pnpm db:migrate                             # roles, then every pending migration

cd apps/worker
cp .env.example .env                        # local connection strings
cp .dev.vars.example .dev.vars              # secret names; empty is fine in fake mode
node scripts/seed-dev.mjs                   # one workspace, one Admin, one Member
cd ../..

AUTH_MODE=fake pnpm --filter client build   # the client, with a dev account switcher
pnpm --filter @hermes/worker exec wrangler dev --local
open http://localhost:8787/workspace/11111111-1111-4111-8111-111111111111
```

To run the whole thing end to end, with thirty-plus Playwright scenarios against
a real Postgres, Worker and client:

```sh
pnpm e2e:live
```

Hosted demo: [request access](https://staging.hermes.brianflynn.dev/demo).

## How the human-decision guarantee is enforced

The product's one promise is that the agent cannot decide. It is built as a
property of the data, so it holds even if the agent, the prompt or the UI is
wrong.

- **Three database roles, forced row-level security.** Every tenant request
  runs in one transaction that sets the workspace and user, and every table has
  RLS forced on. Start at `apps/worker/migrations/0003_rls.sql` and
  `0004_grants.sql`.
- **The `agent` role cannot write a decision.** It has no INSERT on
  `decisions`, `effects`, `members`, `invitations` or `jobs`, and no UPDATE on
  `requests`. A trigger limits what it may publish. CI asserts the whole grant
  matrix on every push.
- **One guarded route.** `POST /w/:ws/requests/:id/decisions` is the only path
  that changes a request's status. Five guards in front, one transaction
  behind. The rules live in `apps/worker/src/domain`, with no HTTP in them.
- **Effects are separate from decisions.** A decision records what a person
  decided. What it implies, such as an access grant, an email, a payment or a
  signature, is an `effects` row that a person with the required role executes.
  There is no code in this repository that sends outreach, moves money or
  signs anything, and there will not be.
- **Counts are views, receipts are rows.** Inbox counts and statuses are
  derived, so there is no counter to drift. Every run leaves a trace and every
  decision leaves a receipt in the session where it was asked for.

The long list of invariants, with the tests that hold each one, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#the-invariants-in-one-place).

## How this uses Hermes

This repository does not implement its own agent loop. It runs the official
Hermes agent and puts an enterprise boundary around it.

| Piece | What it is | Where |
|---|---|---|
| Upstream runtime | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) pinned at `345cd2b0`, package version 0.21.3. The installer verifies the commit, the lock file and the package inventory before anything runs. | `runtime/hermes/install.py`, `runtime/hermes/README.md` |
| Enterprise bridge | A Hermes plugin that connects a running agent to this Worker: it receives turns, streams events back, and exposes the workspace's tools and skills. A Cloud-managed profile refuses to start if the pinned runtime files or plugin digest do not match. | `runtime/hermes/enterprise_bridge/` |
| Runtime contract | The versioned agreement between the Worker and the bridge: event shapes, terminal error taxonomy, supported release rings. The Worker checks it at admission and in `/health`, and CI runs a canary against it. | `runtime/hermes/contract.json`, `packages/shared` |
| Tool and model boundary | Which tools a run may call, in which mode, and which provider it may reach. Provider keys are envelope-encrypted and resolve inside the single step that needs them. | `apps/worker/src/runtime`, `apps/worker/src/model` |
| Managed skills | Versioned Hermes skills the workspace packages and shares, such as Partner Program screening. | `docs/ENTERPRISE-SKILLS.md` |

Everything above the bridge is this project. Everything below it is upstream
Hermes, unmodified.

## Layout

```
packages/shared    the contract: events, refs, enums, document payloads, validators
apps/worker        the Cloudflare Worker: Hono routes, Durable Object hubs, the run
                   Workflow, the Drizzle schema, the SQL migrations
  src/domain       the decision transaction and effects plan, with no HTTP in them
apps/client        the workspace client: React 19, esbuild, served by the Worker
runtime/hermes     the pinned upstream runtime and the enterprise bridge plugin
docs/              ARCHITECTURE, DECISIONS, CONVENTIONS, runbooks
```

## Stack

Cloudflare Workers, Durable Objects, Workflows, Queues and R2. Postgres 17 on
Neon through Hyperdrive, with Drizzle for the schema. Hono for routes. WorkOS
AuthKit for sign-in. React 19 built with esbuild. Vitest and Playwright.

## Read next

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): what is real and what is
  stubbed, every route with a curl, uploads, decisions, tools and modes.
- [docs/DECISIONS.md](docs/DECISIONS.md): why things are the way they are.
  A change that contradicts a recorded decision needs a new entry.
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md): who owns which directory, how to
  add a migration, which invariants must never be violated.
- [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md): the threat model and
  current findings. To report a vulnerability, see [SECURITY.md](SECURITY.md).
- [CONTRIBUTING.md](CONTRIBUTING.md) if you want to change something.
