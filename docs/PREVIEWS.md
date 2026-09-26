# Pull request previews

A preview is a running copy of the app for one pull request, so a change can be
clicked through, on a phone if need be, before it merges. Merging never
deploys a preview, and a preview never touches staging or production.

## What a preview is

| Part | For pull request 164 |
| --- | --- |
| Worker | `hermes-pr-164` on the account's workers.dev subdomain |
| Database | Neon branch `pr-164` in the dedicated `hermes-previews` project, migrated and seeded with the development fixture; it expires after 14 days |
| Hyperdrive | `hermes-pr-164-app` and `hermes-pr-164-agent`, caching disabled, one per database role |
| Queues | `hermes-pr-164-extract`, `-renders` and their dead-letter queues |
| Workflows | `hermes-pr-164-run-attempt` and the three long waits |
| Durable Objects | the Worker's own namespaces |
| Uploads | the shared `hermes-uploads-previews` bucket; objects expire after 14 days |

It runs the development build: the seeded workspace, fake sign-in with the
account switcher, the scripted agent and the fixture model catalog. It does
not reach Hermes Cloud, WorkOS, a model provider, email or payments, so it
shows how the product behaves, not how a real model answers.

Cron triggers are off. The minute sweep would keep the preview's Neon compute
awake all day, and the request that commits a job already runs it.

## Why not Cloudflare's own preview URLs

Cloudflare does not generate version preview URLs for a Worker that implements
a Durable Object, and this one implements two. A preview version would also
share staging's database, queues and bucket, which is the thing a preview must
not do.

## The lock

Fake sign-in trusts an `x-dev-user` header, so a public preview without a lock
would let anyone act as the seeded Admin. `apps/worker/src/preview-gate.ts`
refuses every request except `/health` until a person enters the shared
passcode, then sets an HttpOnly cookie that the app shell, the API and both
socket upgrades carry. The gate is on only when the `PREVIEW_PASSCODE` secret
is set, and only `scripts/preview.mjs` sets it.

The passcode never goes in a PR comment. It lives in
`~/.config/hermes-previews/state.json` on the machine that runs previews:

```sh
node -e 'console.log(require(require("os").homedir()+"/.config/hermes-previews/state.json").passcode)'
```

## Commands

Run from the repository root, on a machine signed in to Wrangler and Neon
(`npx wrangler whoami`, `npx neonctl me`).

```sh
node scripts/preview.mjs init --neon-org <org-id>  # once per machine
node scripts/preview.mjs up <pr> --comment          # deploy or update, then comment the link on the PR
node scripts/preview.mjs down <pr>                  # delete every resource for that PR
node scripts/preview.mjs list
```

`up` is idempotent: run it again after pushing to redeploy the current checkout.
It migrates the branch, builds the client with `AUTH_MODE=fake`, deploys, and
fails unless `/health` answers 200, a request without the passcode is refused,
and the unlocked app shell and bootstrap load.

Run `down` when the pull request closes. The Neon branch expires on its own
after 14 days; the Worker, queues and Hyperdrive configs do not.

## Safety rails

- Every Cloudflare resource the script creates or deletes must be named
  `hermes-pr-<n>` or `hermes-pr-<n>-<part>`; anything else is refused.
- Every Neon call names the `hermes-previews` project, and the script refuses
  to continue if that project has any other name.
- No deploy credential is stored in GitHub. The script uses the Wrangler login
  of the machine that runs it. Staging and production deploy only through
  their GitHub environments, which require an approving reviewer.
- Account limits: Hyperdrive allows a limited number of configs per account,
  and each preview uses two. Take previews down rather than letting them pile up.
