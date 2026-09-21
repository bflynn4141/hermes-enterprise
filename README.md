# Hermes Teams Demo

Hermes Teams Demo gives a small team one workspace where an AI agent can do the
legwork and people keep control of every decision.

The team talks to Iris, its workspace agent. Iris can research applicants,
gather evidence, and draft invoices or agreements. When the work needs a
decision, Iris sends a request to the Inbox. A person reviews the evidence and
chooses what happens next.

The database and API enforce this boundary. The agent role cannot admit a
person, approve a document, send outreach, move money, grant access, or sign an
agreement.

![Hermes workspace with a conversation on the left and the Iris overview on the right](docs/assets/readme-overview.png)

[Request access to the hosted demo](https://staging.hermes.brianflynn.dev/demo).

> **Independent project.** Nous Research does not maintain, endorse, or sponsor
> Hermes Teams Demo. This project runs the open source
> [Hermes Agent](https://github.com/NousResearch/hermes-agent) and uses the Nous
> Portal inference API by default. The trademark owners retain their respective
> marks. The [MIT License](LICENSE) covers this repository.

## How it works

1. **A person assigns work.** A team member asks Iris to research a question,
   screen an applicant, or prepare a draft.
2. **Iris does the legwork.** The agent uses approved tools, records its steps,
   and cites the sources behind its findings.
3. **Iris asks for a decision.** The app creates a specific request, such as an
   application or invoice, and sends it to the Inbox with the relevant evidence.
4. **A person decides.** An authorized team member approves, declines, or sends
   the request back.
5. **The app records the result.** Hermes adds a receipt to the original
   conversation and stores any follow-up action as a separate effect.

This flow keeps the conversation, evidence, decision, and receipt connected.
It also gives the system a clear point where human authority begins.

## What you can do

| Area | What the workspace supports |
| --- | --- |
| Conversations | Create sessions, talk to Iris, upload source material, and control a run with Stop, Guide, Queue, and Retry. A run can pause for a person's answer and continue afterward. |
| Review | Send applications, invoices, agreements, and access requests to the Inbox with evidence and approval rules. |
| Records | Review run traces, decision history, receipts, and saved HTML documents. |
| Team access | Sign in with WorkOS AuthKit, invite members, assign roles, and keep each workspace isolated with forced row-level security. |
| Agent setup | Configure context, assign managed skills, choose an allowed model, and bring a workspace-owned provider key. |

### What people still handle

The demo stops after a person records a decision. It does not send outreach,
transfer funds, grant access, or sign documents. Instead, the app records the
intended action as an effect. The execution endpoint returns `unavailable`, and
an authorized person completes the action outside the demo.

Approved documents render as HTML and remain unsigned and unsent. See
[Architecture](docs/ARCHITECTURE.md#what-is-real-and-what-is-not) for the full
list of implemented and stubbed behavior.

## See the approval flow

All screenshots below use fixture data.

### 1. Iris screens an application

Iris scores the applicant against the program criteria and cites its sources.
An Admin can admit or decline the applicant.

![Application review with screening scores, sources, and Admit and Decline actions](docs/assets/flow-1-application-review.jpg)

### 2. A person reviews an agreement

The request shows the draft, scope, fees, term, sources, and approval rule.
Approval saves an unsigned copy to the Library. The app does not sign or send
it.

![Agreement review with the draft terms, approval rule, and Approve agreement draft action](docs/assets/flow-2-agreement-review.jpg)

### 3. A person reviews an invoice

The invoice request shows the amount, dates, and line items. Approval saves the
draft without sending it or starting a payment.

![Invoice review with the amount, dates, line items, and approval action](docs/assets/flow-3-invoice-review.jpg)

### 4. Hermes records the decision

The request moves to Resolved and names the person who decided. The chat card
also updates so the team can see that the app saved the draft without signing
or sending it.

![Resolved agreement with the approver and a chat card that says the app saved an unsigned draft](docs/assets/flow-4-agreement-saved.jpg)

### 5. Iris receives the receipt

The receipt appears in the conversation that started the request. Iris can
continue from the decision, while any follow-up action remains a separate
effect.

![Conversation receipt with the decision and its pending follow-up effect](docs/assets/flow-5-receipt-in-chat.jpg)

## Run it locally

### Requirements

- Node.js 26 or newer
- pnpm 11.10.0
- Docker
- Python 3.11 to 3.13, Git, and `uv` only if you want to run Hermes Agent
  locally

### Install and prepare the database

```sh
pnpm install
pnpm db:up
pnpm db:migrate

cd apps/worker
cp .env.example .env
cp .dev.vars.example .dev.vars
node scripts/seed-dev.mjs
cd ../..
```

The seed creates one workspace, one Admin, and one Member. The local database
runs in Postgres 17 on `127.0.0.1:5433`.

### Start the app

```sh
AUTH_MODE=fake pnpm --filter client build
pnpm dev
```

Then open:

```text
http://localhost:8787/workspace/11111111-1111-4111-8111-111111111111
```

Fake auth adds a local account switcher, so you can test the Admin and Member
views without WorkOS credentials.

### Run the checks

```sh
pnpm typecheck
pnpm test
pnpm test:browser:mock
pnpm db:migrations:verify
pnpm e2e:live
```

`pnpm e2e:live` creates its own disposable Postgres container, runs the full
stack, and drives the browser flows with Playwright. It does not write test data
to the development database.

To install and start the official Hermes runtime, follow
[runtime/hermes/README.md](runtime/hermes/README.md).

## How Hermes keeps people in control

The approval boundary lives in the system rather than the prompt:

- **Database roles block agent decisions.** The `agent` role cannot insert
  decisions or effects, and it cannot update requests. It also cannot add
  members, invitations, or jobs. CI checks the full grant matrix on every push.
- **One API route records decisions.** Five guards protect
  `POST /w/:ws/requests/:id/decisions`, and one transaction records the result.
- **The app separates decisions from effects.** A decision captures a person's
  choice. A separate effect records any action that choice may require.
- **Every tenant request sets its scope.** Each transaction sets the workspace
  and user before Postgres applies forced row-level security.
- **Receipts preserve the trail.** Every run leaves a trace, and every decision
  leaves a receipt in the session that requested it.

Read the complete set of invariants and their tests in
[Architecture](docs/ARCHITECTURE.md#the-invariants-in-one-place).

## How this project uses Hermes Agent

This repository runs the official Hermes agent loop and adds the workspace,
security, and approval boundary around it.

| Component | Responsibility | Location |
| --- | --- | --- |
| Official runtime | Nous Research's Hermes Agent runs the agent loop. This repository pins commit `345cd2b0` and package version 0.21.3, then verifies the source, lock file, and installed packages. | [`runtime/hermes`](runtime/hermes) |
| Enterprise bridge | A Hermes plugin receives turns from the Worker, streams events back, and exposes only the tools and skills that the workspace allows. | [`runtime/hermes/enterprise_bridge`](runtime/hermes/enterprise_bridge) |
| Runtime contract | A versioned contract defines events, terminal errors, and supported release rings. The Worker checks the contract before it admits a run. | [`runtime/hermes/contract.json`](runtime/hermes/contract.json) |
| Worker boundary | The Worker chooses which tools and models a run may use. It decrypts a provider key only inside the step that calls that provider. | [`apps/worker/src/runtime`](apps/worker/src/runtime) |
| Managed skills | The workspace packages and assigns versioned Hermes skills, including Partner Program screening. | [`docs/ENTERPRISE-SKILLS.md`](docs/ENTERPRISE-SKILLS.md) |

## Repository layout

| Path | Contents |
| --- | --- |
| [`apps/client`](apps/client) | React workspace interface |
| [`apps/worker`](apps/worker) | Cloudflare Worker, API routes, Durable Objects, Workflows, queues, and SQL migrations |
| [`apps/worker/src/domain`](apps/worker/src/domain) | Decision rules and effect planning without HTTP concerns |
| [`packages/shared`](packages/shared) | Shared event, entity, reference, and document contracts |
| [`runtime/hermes`](runtime/hermes) | Pinned Hermes runtime installer and enterprise bridge |
| [`docs`](docs) | Architecture notes, decisions, conventions, security reviews, and runbooks |

The stack uses Cloudflare Workers, Durable Objects, Workflows, Queues, and R2;
Postgres 17 on Neon through Hyperdrive; Drizzle; Hono; WorkOS AuthKit; React 19;
Vitest; and Playwright.

## Read next

- [Architecture](docs/ARCHITECTURE.md) explains what works today, what remains
  stubbed, and how the main routes fit together.
- [Decisions](docs/DECISIONS.md) records the reasoning behind consequential
  implementation choices.
- [Conventions](docs/CONVENTIONS.md) explains directory ownership, migrations,
  and invariants that contributors must preserve.
- [Security review](docs/SECURITY-REVIEW.md) covers the threat model and current
  findings. Use [SECURITY.md](SECURITY.md) to report a vulnerability.
- [CONTRIBUTING.md](CONTRIBUTING.md) explains how to propose and verify a change.
