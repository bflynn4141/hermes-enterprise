# Partner screening: live sources and Iris review

Hermes can collect public organization evidence from GitHub or public
professional evidence from AgentCash People Search, save immutable source
artifacts, and hand the candidates to the bound Iris agent for judgment. Source
collection never creates an application by itself.
Iris must inspect the stored evidence and may use `propose_approval` to create a
personalized email in the Inbox. Discovery removes contact details.
After Iris selects one strongest prospect, it may run one bounded professional
contact lookup and email verification. The Inbox shows stored phones and public
profiles for human review and uses an email only after verification passes.
Draft-only approval records reviewed copy and sends nothing. When the separate
outreach-email rollout is enabled, a send approval can queue only its exact
reviewed revision through a dedicated Gmail sender. Calls, texts, and social
messages remain unavailable.

Iris receives this procedure as the native, read-only Hermes skill
`enterprise_bridge:partner-program-screening` version `1.7.0`. Its approved
non-secret program settings are injected through `skills.config`; source and
model credentials remain server-side. A versioned Enterprise skill assignment
controls whether the skill is active, its bounded settings, semantic capability
grants and proactive schedule. It describes the review workflow but grants no
decision authority. See [Enterprise-configured Hermes skills](./ENTERPRISE-SKILLS.md).

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
| AgentCash LinkedIn/YouTube creator search | Live through one fixed `stableenrich.dev/api/exa/search` request when the current user explicitly asks for Hermes creators, influencers, or consultants | One request capped at $0.01. It is separate from the recurring six-hour job and is not added to that budget. | Searches publicly indexed LinkedIn and YouTube pages without using either platform's member API. The Worker accepts the exact request only when the trusted native run contains matching user intent, removes contact-like text, and stores at most five cited results. Search relevance is not proof of audience size, influence, identity matching, availability, or consent. |
| AgentCash X creator search | Live through one fixed `fetcher.sh/api/twitter/search` request when the current user explicitly asks to search X/Twitter for Hermes creators, influencers, or consultants | One read-only request capped at $0.005. It is separate from recurring work and is never scheduled automatically. | Searches public posts for the exact `"Hermes Agent"` phrase and stores at most five cited author/post pairs. The Worker strips contact-like text and payment metadata. Point-in-time follower and post metrics do not prove engagement quality, identity matching, availability, or consent. |
| AgentCash contact enrichment + verification | Live through fixed Minerva and Hunter endpoints after Iris selects one candidate | At most one $0.05 enrichment and one $0.03 verification per native run. Async verification polls reuse the paid job and cannot add another candidate. | The Worker stores only professional emails, phones with provider type, and trusted LinkedIn/X/Facebook URLs. Personal emails, addresses, demographics, relatives, and financial fields are dropped. Phones and profiles are review-only; verified professional email may enter a draft. |
| Explicit GitHub URL intake | Live through the same connector | Same GitHub limits. URLs must be `https://github.com/<organization>` or one repository beneath it. | A URL is an input hint; the saved evidence is still fetched from the official API. The profile call must prove the owner is an organization. |
| YouTube direct API | Not implemented | A Google Cloud project and `PARTNER_YOUTUBE_API_KEY` would be required. `search.list` currently costs one unit and has a separate default search quota of 100 calls/day. | The creator search above reads indexed public results through Exa; it does not call the YouTube Data API or claim subscriber metrics. |
| X direct API | Not implemented | Would require an approved developer account, project/app and `PARTNER_X_BEARER_TOKEN`. | Hermes uses the bounded AgentCash connector above for public discovery and does not hold a direct X API credential. |
| LinkedIn direct API | Unsupported for prospect discovery | Most access requires explicit LinkedIn approval. | Hermes does not use the Profile or Marketing APIs for prospect discovery. The creator search above stores only public pages returned by the independent web index and does not claim private member data or LinkedIn-derived influence metrics. |

Source policy and quota references were checked on 2026-09-18:

- [GitHub REST search](https://docs.github.com/en/rest/search/search)
- [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
- [GitHub Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)
- [YouTube Data API search](https://developers.google.com/youtube/v3/docs/search/list)
- [YouTube API Services Terms](https://developers.google.com/youtube/terms/api-services-terms-of-service)
- [X user search access](https://docs.x.com/x-api/users/search/introduction)
- [X API rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)
- [X pay-per-usage billing](https://docs.x.com/x-api/fundamentals/post-cap)
- [fetcher.sh X/YouTube endpoint catalog](https://fetcher.sh/llms.txt)
- [LinkedIn API access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access)
- [LinkedIn Profile API restrictions](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/profile-api)
- [LinkedIn Marketing API restricted uses](https://learn.microsoft.com/en-us/linkedin/marketing/restricted-use-cases)

## Trust boundary and data flow

1. An Admin or Cloudflare Cron starts a run for an agent with an idempotency key. A newly invited
   member receives one onboarding run for their own explicitly configured AgentCash profile; later
   paid runs require an Admin. The server reads that agent's active Enterprise
   skill assignment. A valid `PARTNER_SCREENING_CONFIG_JSON` policy is imported
   once as revision 1 for rolling-deployment compatibility.
2. For GitHub, the server calls only fixed `https://api.github.com` endpoints. It has a
   10-second timeout, a 1 MB response cap, a per-run request cap, and a
   configurable minimum remaining-rate reserve. It does not retry a `403` or
   `429` and reports the reset time when GitHub provides it.
3. For People Search, the plugin presents the exact policy-derived AgentCash request to the
   Worker before payment. The Worker atomically leases that run's only `$0.15` call to the trusted
   native run and tool-call IDs. Iris then makes that exact request in Nous Cloud. The plugin's
   `post_tool_call` observer gets a dedicated 25-second import window and forwards the result with
   the same IDs; the authenticated Worker rejects unleased, changed, replay-conflicting, or mismatched
   results. Hermes stores large tool responses in a local spill file. If the observer is interrupted,
   the profile's next startup looks up only its one pending leased call and replays that exact file
   into the idempotent importer, even when the model run has already ended. A transport failure after
   leasing never starts another source request or substitutes a new tool-call ID, preventing accidental
   duplicate payment.
4. Creator search follows the same lease/import boundary. LinkedIn/YouTube uses
   one fixed `$0.01` request; X uses one fixed `$0.005` request. Before native
   submission the Worker appends the exact governed call to an explicit channel
   test, so tool selection does not depend on the model rediscovering a hidden
   constant. The payment lease still verifies the original user message names
   Hermes, the requested channel, an action such as search/test, and a creator,
   influencer, consultant, or implementation intent. These searches are never
   scheduled by Cloudflare Cron.
5. A successful run commits sanitized source snapshots and candidates. Source
   artifacts are append-only. A SHA-256 content hash, fetch time, source update
   time, URL, API request count, rate-limit snapshot, score criteria,
   confidence, and gaps are preserved.
   Recurring People Search also advances a server-owned page cursor. The model
   cannot change it, and candidates already present in the engagement ledger
   are omitted from later discovery lists.
6. Iris selects exactly one stored candidate. Each Minerva or Hunter request is
   reconstructed from database state, leased to one native run/tool-call ID,
   and imported through the same spill-recovery boundary. The Worker stores no
   raw enrichment response. A Hunter result is draft-eligible only when it is
   `valid` and syntax, MX, SMTP-server, and SMTP-check signals pass while
   disposable and blocked signals do not.
7. Onboarding calls the explicit handoff route after the provider is connected.
   Cloudflare Cron performs the same idempotent handoff automatically. The
   agent's pinned Partner Program skill guides the review. It can call
   `list_partner_candidates` and `get_partner_candidate`; both
   are read-only and restricted to its own candidates. Candidate detail exposes
   the exact active draft policy, reviewer audience and sender only when that
   server-owned context is ready; Iris must not infer any of those values.
8. Before handing work to Iris, the Worker installs an agent-specific
   communication policy reviewed by the responsible member. Iris may call
   `propose_approval` only under the deployment's draft or approved-send mode,
   with the verified sender and at least one source artifact linked to the
   selected candidate. Contact enrichment is optional for draft-only review:
   when no stored enrichment exists, the recipient address is null and the
   phone/social lists are empty. When enrichment exists, every contact field
   and the cited enrichment id must exactly match stored evidence. Approved-send
   mode still requires a verified professional email. Discovered prospects are
   never represented as applicants.
9. An approved send becomes an exact outbox row bound to the request,
   authorization revision and hash, and recipient index. A connected Gmail
   account must match the approved sender address. Suppressions are checked
   again immediately before delivery. A confirmed send stores the provider
   message and thread ids; an uncertain network or provider result stops as
   `ambiguous` rather than retrying into a possible duplicate.

Cloudflare Cron uses the active assignment's schedule, defaulting to six-hour
idempotency buckets. Pausing the assignment or disabling its schedule prevents
new proactive jobs. Paid AgentCash runs have a
second kill switch, `PARTNER_SCREENING_PAID_AUTOMATION_ENABLED`. Local and
production keep it at `0`; staging is `1` under the project owner's 2026-09-17 approval
for the hosted Hermes Teams Demo workspace. The approved staging maximum is $0.23 per six-hour run
for each configured agent: $0.15 discovery plus $0.05 enrichment and $0.03
verification for one shortlisted candidate. A new environment or agent still needs
its own recurring-budget approval before this switch can authorize spending.

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

The legacy environment policy is imported once. After startup, an Admin can
edit the assignment under **Library → Skills → Partner program screening →
Configure**. Every save creates an immutable revision; the database policy wins
over later environment changes.

The ranking weights must total 100. A run supports at most three search queries,
ten explicit URLs, ten candidates, and thirty API requests. Keep the candidate
limit small: one enriched candidate normally costs two core API calls after the
search call. The source-matrix route is read-only and reports credentials only
as `authenticated`, `unauthenticated`, or `not_applicable`.

Start the Worker after applying migrations through
`0046_enterprise_skill_assignments.sql`, then:

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
admit one durable screening job per active, scheduled, started, owned agent and
assignment cadence bucket. The assignment defaults to 360 minutes and is
validated between 5 and 1440. `PARTNER_SCREENING_AUTOMATION_INTERVAL_MINUTES`
remains the compatibility default for a policy that has not yet materialized. In staging,
`PARTNER_SCREENING_AUTOMATE_DEFAULT_AGENTS=1` applies the bounded onboarding
policy to started admin-owned agents without an agent-specific override. The
durable job creates/reuses an `Iris · Automated partner
screening` session, and submits the stored handoff prompt with a stable turn id.
Retries therefore reuse the screening run and Iris turn rather than paying or
proposing twice. Staging enables this gate; production leaves it off.

Cloudflare is the business-trigger scheduler. Native Hermes cron may be exposed
for a demo profile, but it should not schedule this same screening flow; doing so
would create two scheduler owners even though downstream ids are defensive.

## Dedicated Gmail sender

Email remains off unless both deployment gates are changed deliberately:

```dotenv
GMAIL_OUTREACH_ENABLED="1"
PARTNER_OUTREACH_EMAIL_MODE="send_after_approval"
```

The server also needs `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
`GMAIL_STATE_SECRET`, and the exact `GMAIL_REDIRECT_URI`. The Google OAuth web
client must enable the Gmail API and register the callback. Hermes requests the
narrow `gmail.send` sensitive scope plus OpenID email identity; it does not ask
to read the mailbox. Admins connect the dedicated address in Settings → Email.
Refresh credentials use the same envelope-encryption boundary as other provider
credentials.

Keep `PARTNER_OUTREACH_EMAIL_MODE=draft_only` while connecting and testing the
mailbox. Use a controlled recipient for the first approved message, inspect the
Gmail sent folder and Hermes outbox receipt, then enable send-after-approval.
Google may require OAuth app verification before use beyond configured test
users.

## Live onboarding

Partner Program onboarding records the member's working agreement; it never
creates Cloud infrastructure or starts a paid search. Invitation acceptance
persists an Inbox task for the partner criteria and a separate member-owned
approval for the first AgentCash People Search. Only the member's explicit
approval can enqueue that search after Iris is ready and Nous Portal is
connected. The reviewed allowance is one request, at most five stored
prospects, no outreach, and no more than $0.15. The old sample route and
fictional applicant UI are not exposed.

All environments carry the same bounded
`PARTNER_SCREENING_DEFAULT_CONFIG_JSON` so the accepted starter approval has an
executable policy. Production background automation remains disabled; the
presence of this policy is not authorization to spend. Missing or malformed
policy, a second call, or a request above the monetary cap fails closed.

This repository does not contain actual source credentials, the user's search
queries, the user's scoring policy, or deployment secrets. GitHub and recurring
People Search still depend on the agent's configured policy. Explicit
LinkedIn/YouTube and X creator discovery is live only when the bound AgentCash
wallet and native runtime profile are ready; direct LinkedIn, YouTube, and X
member APIs remain outside this build.
