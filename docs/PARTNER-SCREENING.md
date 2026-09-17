# Partner screening: live sources and Iris review

Hermes can collect public organization evidence from GitHub or public
professional evidence from AgentCash People Search, save immutable source
artifacts, and hand the candidates to the bound Iris agent for judgment. Source
collection never creates an application by itself.
Iris must inspect the stored evidence and may use `propose_approval` to create a
personalized, draft-only email in the Inbox. The source connector removes
contact details, so the draft names the prospect and shows that a verified
address is still needed. Approval records reviewed copy and never sends it.

Iris now receives this procedure as the native, read-only Hermes skill
`enterprise_bridge:partner-program-screening` version `1.4.0`. Its approved
non-secret program settings are injected through `skills.config`; source and
model credentials remain server-side. The skill is automatically in use when
this agent has a valid policy. It describes the review workflow but grants no
tool or decision authority. See [Enterprise-configured Hermes skills](./ENTERPRISE-SKILLS.md).

The connector's `deterministic_priority` is triage, not an Iris or Hermes
decision. Its four configurable criteria are keyword relevance, recent
repository activity, public adoption, and open-source signals. Each criterion
records the source artifact IDs behind its points. Capacity, interest,
availability, and consent remain explicit evidence gaps because public code
activity cannot establish them.

## Source support

| Source | State in this build | Authentication and cost | Policy boundary |
|---|---|---|---|
| GitHub | Live through `api.github.com` | Works anonymously at 60 core requests/hour, with search limited to 10 requests/minute. `PARTNER_GITHUB_TOKEN` raises the primary core allowance to 5,000/hour and authenticated search to 30/minute. GitHub does not charge per REST request. | Organization and repository records only. The connector drops user-owned search results and public email, and cannot contact anyone. GitHub prohibits using the service for spam, including unsolicited recruiting. |
| AgentCash People Search | Live through `stableenrich.dev/api/fullenrich/people-search` inside Iris's Nous Cloud profile | One request per run, capped at $0.15. The endpoint is free when it returns no match. The dedicated AgentCash wallet pays; no source API key is needed. | The model cannot select the URL, filters, or spend cap. The Worker accepts a response only from the native run that owns the screening job, removes contact data, and stores public professional fields. Results are prospects, never applicants, until a human reviews them. |
| Explicit GitHub URL intake | Live through the same connector | Same GitHub limits. URLs must be `https://github.com/<organization>` or one repository beneath it. | A URL is an input hint; the saved evidence is still fetched from the official API. The profile call must prove the owner is an organization. |
| YouTube | Not implemented | A Google Cloud project and `PARTNER_YOUTUBE_API_KEY` would be required. `search.list` currently costs one unit and has a separate default search quota of 100 calls/day. A credential alone does not mark this source live. | Build and policy review of a dedicated connector are still required. No YouTube request is made here. |
| X | Not implemented | Requires an approved developer account, project/app and `PARTNER_X_BEARER_TOKEN`. X charges from prepaid credits per API usage. A credential alone does not mark this source live. | A dedicated connector and a workspace budget must be approved first. No X request is made here. |
| LinkedIn | Unsupported for prospect discovery | Most access requires explicit LinkedIn approval. | The Profile API restricts other-member data and says it may not be stored; Marketing API restrictions prohibit using member data to identify prospects or leads. Hermes does not discover LinkedIn prospects. An applicant-supplied URL may only be a reference under an approved LinkedIn product. |

Source policy and quota references were checked on 2026-09-16:

- [GitHub REST search](https://docs.github.com/en/rest/search/search)
- [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
- [GitHub Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)
- [YouTube Data API search](https://developers.google.com/youtube/v3/docs/search/list)
- [YouTube API Services Terms](https://developers.google.com/youtube/terms/api-services-terms-of-service)
- [X user search access](https://docs.x.com/x-api/users/search/introduction)
- [X API rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)
- [X pay-per-usage billing](https://docs.x.com/x-api/fundamentals/post-cap)
- [LinkedIn API access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access)
- [LinkedIn Profile API restrictions](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/profile-api)
- [LinkedIn Marketing API restricted uses](https://learn.microsoft.com/en-us/linkedin/marketing/restricted-use-cases)

## Trust boundary and data flow

1. An Admin or Cloudflare Cron starts a run for an agent with an idempotency key. A newly invited
   member receives one onboarding run for their own explicitly configured AgentCash profile; later
   paid runs require an Admin. The server reads that agent's non-secret policy from
   `PARTNER_SCREENING_CONFIG_JSON`.
2. For GitHub, the server calls only fixed `https://api.github.com` endpoints. It has a
   10-second timeout, a 1 MB response cap, a per-run request cap, and a
   configurable minimum remaining-rate reserve. It does not retry a `403` or
   `429` and reports the reset time when GitHub provides it.
3. For People Search, the plugin presents the exact policy-derived AgentCash request to the
   Worker before payment. The Worker atomically leases that run's only `$0.15` call to the trusted
   native run and tool-call IDs. Iris then makes that exact request in Nous Cloud. The plugin's
   `post_tool_call` observer forwards the result with the same IDs; the authenticated Worker rejects
   unleased, changed, replay-conflicting, or mismatched results. A transport failure after leasing is
   not automatically retried under a new tool-call ID, preventing accidental duplicate payment.
4. A successful run commits sanitized source snapshots and candidates. Source
   artifacts are append-only. A SHA-256 content hash, fetch time, source update
   time, URL, API request count, rate-limit snapshot, score criteria,
   confidence, and gaps are preserved.
5. Onboarding calls the explicit handoff route after the provider is connected.
   Cloudflare Cron performs the same idempotent handoff automatically. The
   agent's auto-loaded Partner Program skill guides the review. It can call
   `list_partner_candidates` and `get_partner_candidate`; both
   are read-only and restricted to its own candidates.
6. Before handing work to Iris, the Worker installs an agent-specific
   communication policy reviewed by the responsible member. Iris may call
   `propose_approval` only with `draft_only: true`, the verified sender, a null
   recipient address and stored evidence. The resulting Inbox item has no
   delivery effect. Discovered prospects are never represented as applicants.

Cloudflare Cron uses six-hour idempotency buckets. Paid AgentCash runs have a
second kill switch, `PARTNER_SCREENING_PAID_AUTOMATION_ENABLED`; it defaults to
`0` in every environment. Enabling the general automation trigger therefore
cannot spend from a runtime wallet. Set the paid switch to `1` only after a
recurring budget is approved. At the default policy cap, the maximum is $0.15
per six-hour run for each configured agent.

Discovery credentials and model-provider credentials are separate. A
`PARTNER_GITHUB_TOKEN` can read the configured public source. The workspace's
encrypted Nous Portal key pays for Iris inference. Neither grants the other
capability.

## Configure the seeded local Iris agent

The local seed uses workspace `11111111-1111-4111-8111-111111111111`, Admin
`maya@nous.example`, and Iris agent
`44444444-4444-4444-8444-444444444444`. Copy the ordinary local setup from the
root README, then add a policy to `apps/worker/.dev.vars`:

```dotenv
PARTNER_SCREENING_CONFIG_JSON='{"44444444-4444-4444-8444-444444444444":{"source_purpose":"organization_partner_research","organization_only":true,"no_outreach":true,"role_label":"Potential technical ecosystem partner","search_queries":["developer education in:name,description,readme archived:false"],"intake_urls":[],"keywords":["developer education","agents","open source"],"ranking_weights":{"relevance":40,"activity":25,"adoption":20,"openness":15},"minimum_priority":50,"lookback_days":365,"max_candidates":5,"max_api_requests":12,"minimum_rate_remaining":5}}'

# Optional. Leave empty for GitHub's public unauthenticated API.
PARTNER_GITHUB_TOKEN=""
```

The ranking weights must total 100. A run supports at most three search queries,
ten explicit URLs, ten candidates, and thirty API requests. Keep the candidate
limit small: one enriched candidate normally costs two core API calls after the
search call. The source-matrix route is read-only and reports credentials only
as `authenticated`, `unauthenticated`, or `not_applicable`.

Start the Worker after applying migrations through
`0034_proactive_partner_outreach.sql`, then:

```sh
WS=11111111-1111-4111-8111-111111111111
IRIS=44444444-4444-4444-8444-444444444444
AUTH='x-dev-user: maya@nous.example'

curl -s -H "$AUTH" \
  "http://localhost:8787/w/$WS/partner-screening/agents/$IRIS/sources"

curl -sX POST -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"agent_id\":\"$IRIS\",\"idempotency_key\":\"github-demo-001\"}" \
  "http://localhost:8787/w/$WS/partner-screening/runs"
```

Reusing the idempotency key returns the original completed result and makes no
new GitHub calls. The response contains the stored candidates and the exact
prompt to give Iris. Running that prompt requires the official Hermes runtime
and a configured Nous Portal model key. Source ingestion itself does not.

For a deployment, set `PARTNER_SCREENING_CONFIG_JSON` as a Worker variable and
store `PARTNER_GITHUB_TOKEN` as a Worker secret. Do not put the token inside the
JSON policy. Run the migration before enabling the route.

### Proactive demo

`AUTOMATED_TRIGGERS_ENABLED=1` makes the existing every-minute Cloudflare Cron
admit one durable screening job per configured, started, admin-owned agent and
cadence bucket. `PARTNER_SCREENING_AUTOMATION_INTERVAL_MINUTES` defaults to 360
and is clamped to 5–1440. In staging,
`PARTNER_SCREENING_AUTOMATE_DEFAULT_AGENTS=1` applies the bounded onboarding
policy to started admin-owned agents without an agent-specific override. The
durable job creates/reuses an `Iris · Automated partner
screening` session, and submits the stored handoff prompt with a stable turn id.
Retries therefore reuse the screening run and Iris turn rather than paying or
proposing twice. Staging enables this gate; production leaves it off.

Cloudflare is the business-trigger scheduler. Native Hermes cron may be exposed
for a demo profile, but it should not schedule this same screening flow; doing so
would create two scheduler owners even though downstream ids are defensive.

## Live onboarding

With a valid policy, Partner Program onboarding starts a real connector run,
shows its request and monetary ceiling, and hands the work to Iris once Nous
Portal is connected. Development and staging default to one AgentCash People
Search call capped at $0.15 and at most five stored prospects. The old sample
route and fictional applicant UI are no longer exposed.

Development and staging may set `PARTNER_SCREENING_DEFAULT_CONFIG_JSON` so a
newly-created agent can run this first search before it has an agent-specific
policy. The staging default is capped at five prospects and one $0.15 request.
Production has no default and therefore fails closed until an approved policy
is configured.

This repository does not contain actual source credentials, the user's search
queries, the user's scoring policy, or deployment configuration. Until those
are supplied for the real Iris agent, the source matrix truthfully reports
GitHub as unconfigured. YouTube and X remain unimplemented, and LinkedIn
prospect discovery remains policy-blocked.
