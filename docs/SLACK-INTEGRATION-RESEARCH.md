# Slack production setup and operations runbook

Last verified against Slack's official documentation: **2026-09-16**.

## Status and production decision

The current branch implements the first production slice: **Settings > Slack**,
admin/step-up workspace and Enterprise Grid organization OAuth, encrypted
rotating installation tokens, signed HTTP Events, durable `event_id`
deduplication, asynchronous ingest and reply delivery, per-member Slack identity
linking, and Slack `Retry-After` handling. A linked member's messages use that
member's existing Hermes agent binding, isolated runtime profile, and assigned
skills. Direct messages map to one private session; a channel thread is private
to the linked member who initiated it; approval decisions remain in the web
Inbox.

This integration is **implemented but not live**. No real Slack app,
credentials, installation, production deployment, or live Slack event has been
exercised. The committed manifest is a production template, not evidence of a
configured Slack app. Enterprise Grid workspace-access lifecycle events,
Socket Mode, slash commands, files, interactive approvals, and Slack's optional
`agent_view`/agent surfaces remain unimplemented.

The production transport is the **HTTP Events API**:

```text
Slack OAuth + signed HTTPS events
                ↓
Enterprise Slack adapter
  verify → deduplicate → acknowledge → queue
                ↓
Hermes Enterprise Worker
  installation → linked member → bound agent/profile → governed turn
                ↓
Slack Web API reply in the originating thread
```

This preserves the existing Worker as the control plane for `workspace_id`,
`agent_id`, membership, skills, policy, approvals, traces, and audit. Never
accept an enterprise `workspace_id` or `agent_id` from Slack message content or
client-supplied metadata. Resolve both from the encrypted Slack installation
record after verifying the request.

Use **Socket Mode only with a separate local/private development app** when a
public HTTPS tunnel is undesirable. Slack sends Socket Mode events over a
runtime WebSocket instead of the HTTP Request URL, and currently does not allow
Socket Mode apps in the public Slack Marketplace. Do not toggle the production
app between transports during live traffic. Socket Mode is not implemented
here either.

## Version-controlled manifest and exact URLs

The template uses the reserved placeholder host `slack-adapter.example.com`.
Replace that literal everywhere before importing the YAML into Slack:

| Purpose | Exact template URL | Required handler |
| --- | --- | --- |
| OAuth redirect | `https://slack-adapter.example.com/integrations/slack/oauth/callback` | `GET /integrations/slack/oauth/callback` |
| Events API | `https://slack-adapter.example.com/integrations/slack/events` | `POST /integrations/slack/events` |
| Interactivity, later | `https://slack-adapter.example.com/integrations/slack/interactivity` | `POST /integrations/slack/interactivity` |

The interactivity URL is intentionally absent from the active manifest because
there is no handler. Add it and set `settings.interactivity.is_enabled: true`
only when Block Kit actions have signature verification, authorization,
idempotency, and stale-action protection.

The OAuth `redirect_uri` sent to both Slack's authorize and access steps must be
the same HTTPS value configured in the manifest. With the placeholder replaced,
the install redirect has this shape:

```text
https://slack.com/oauth/v2/authorize?client_id=<SLACK_CLIENT_ID>&scope=app_mentions%3Aread%2Cchat%3Awrite%2Cim%3Ahistory&redirect_uri=https%3A%2F%2F<SLACK_ADAPTER_HOST>%2Fintegrations%2Fslack%2Foauth%2Fcallback&state=<ONE_TIME_STATE>
```

`<SLACK_ADAPTER_HOST>` is the hostname only, without `https://` or a trailing
slash. Generate `state` server-side, bind it to the initiating enterprise admin
and workspace, expire it quickly, consume it once, and reject the callback when
it does not match. The callback exchanges the temporary `code` with
`https://slack.com/api/oauth.v2.access`; Slack says the code expires after ten
minutes.

## Minimum permissions and event behavior

The baseline intentionally requests no user token and only three bot scopes:

| Scope | Why it is required |
| --- | --- |
| `app_mentions:read` | Receive explicit mentions of Iris in conversations the bot can access. |
| `im:history` | Receive `message.im` events in direct messages with the app. |
| `chat:write` | Send the response as the bot, including threaded replies. |

The only baseline bot events are:

- `app_mention` for explicit channel mentions;
- `message.im` for direct messages.

With this least-privilege baseline, every channel follow-up must mention Iris;
Slack will not deliver an unmentioned reply in an existing channel thread.
Supporting those replies later requires the matching `message.channels` or
`message.groups` event and history scope, plus a deliberate shared-thread
authorization model.

Do not add `channels:history`, `groups:history`, `mpim:history`, `files:read`,
`users:read`, `chat:write.public`, slash-command scopes, or user scopes until a
shipped feature needs them. The bot must be a member of a conversation to read
or post there with this baseline; it cannot silently post to every public
channel.

For each accepted event:

1. Reject events from bots, the app's own bot user, and unsupported message
   subtypes so Iris cannot answer itself or treat edits/deletes as new prompts.
2. Resolve the Slack installation and enterprise membership server-side.
3. Use `thread_ts ?? ts` as the Slack thread root. Map the installation,
   `channel`, and root timestamp to one enterprise session.
4. In channels, reply with `thread_ts` so the answer stays in the originating
   thread. In DMs, preserve Slack's incoming thread when present.
5. Keep governed decisions and approvals in the authoritative Hermes Inbox.
   The current delivery tells the user to open the Inbox but does not include a
   deep link. Slack does not grant payment, signature, or role-change authority.

Slack identity is linked explicitly. The installing admin's Slack identity is
linked from the verified OAuth grant. Every other member opens **Settings >
Slack**, creates a one-time command, and sends `link hmx_<ONE_TIME_CODE>` to the
app in a direct message within ten minutes. Hermes stores only the code digest,
consumes the code once, requires an active member with a bound agent, and
replaces that member's previous Slack identity link. An unlinked Slack user is
ignored rather than assigned to a workspace-wide or arbitrary agent.

Files and native interactive approvals are not in the baseline. Adding files
requires a separate scope, malware/content controls, the governed upload path,
and Slack provenance. Adding approval buttons requires the interactivity route
and step-up/replay rules before the manifest is expanded.

## HTTP receiver contract

The production receiver must perform these steps in order:

1. Read and retain the **raw** request body before JSON parsing.
2. Read `X-Slack-Request-Timestamp` and reject requests more than five minutes
   from server time.
3. Compute `v0=` plus the HMAC-SHA256 of
   `v0:<timestamp>:<raw-body>` with `SLACK_SIGNING_SECRET`, then compare it to
   `X-Slack-Signature` using a constant-time comparison.
4. Parse only after verification. For `event_callback`, validate the outer
   envelope and require its `api_app_id` to match the resolved installation.
5. For `url_verification` (which has no `api_app_id` in Slack's documented
   payload), return the `challenge` only after signature verification.
6. For `event_callback`, insert the globally unique Slack `event_id` into a
   unique-keyed inbox and enqueue processing in the same durable operation.
7. Return a 2xx within three seconds. Model execution and Slack Web API calls
   happen asynchronously, never in the acknowledgement path.

The current handler returns 403 for a bad or stale signature. A valid duplicate
receives a 2xx and does no new work. Slack supplies `X-Slack-Retry-Num` and
`X-Slack-Retry-Reason`; the current inbox records the retry number. Use
`event_id`, not either header, as the Events API idempotency key. Add the reason
to operational metadata if retry-cause reporting is needed.

Slack retries a failed event three times (approximately immediately, after one
minute, and after five minutes). A retry can arrive after the original request
actually committed, so every downstream turn creation and outbound reply must
also be idempotent. The current branch persists one delivery per source event,
uses deterministic `client_msg_id` values for the approval notice and final
reply, and stores Slack's returned message timestamp. This is best-effort
outbound deduplication, not a proof of exactly-once delivery: an ambiguous
network timeout still needs monitoring and reconciliation rather than an
assumption that the write failed.

## OAuth, secrets, and token rotation

### Runtime configuration

| Name | Secret? | Source and use |
| --- | --- | --- |
| `SLACK_ENABLED` | No | Set to `1` only after the migration, routes, secrets, and monitoring are ready. Defaults to `0`. |
| `SLACK_CLIENT_ID` | Treat as config | Slack Basic Information; build OAuth authorize and access requests. |
| `SLACK_CLIENT_SECRET` | Yes | Slack Basic Information; OAuth code exchange and token refresh. |
| `SLACK_SIGNING_SECRET` | Yes | Slack Basic Information; verify every inbound HTTP request. |
| `SLACK_STATE_SECRET` | Yes | Generate independently (at least 32 random bytes); authenticate expiring OAuth state. |
| `SLACK_REDIRECT_URI` | No | Exact absolute callback URL: `https://<SLACK_ADAPTER_HOST>/integrations/slack/oauth/callback`. |

Production bot access tokens and refresh tokens are **per installation data**,
not global environment variables. The current branch seals the token bundle in
`slack_installations` using the Worker's namespaced KEK/envelope-encryption
boundary and includes Slack credentials in KEK rewrapping. Never log
authorization codes, access tokens, refresh tokens, the client secret, the
signing secret, raw OAuth state, or decrypted installation rows.

The production manifest enables Slack token rotation. Slack says rotation cannot
be turned off after enablement, so test refresh behavior before importing the
template into the production app. With rotation enabled, Slack access tokens
expire in 12 hours and each refresh returns a new one-time refresh token. The
current store refreshes under a row lock when a caller resolves a token with
less than five minutes remaining and atomically replaces the encrypted access
token, one-time refresh token, and expiry. Slack API failures preserve
`Retry-After` for the durable job scheduler. Before production rollout,
exercise the real refresh path—including a first event after a long idle
period—and verify alerting and operator recovery for response/commit ambiguity,
`invalid_grant`, `token_revoked`, and Slack-side uninstall. Slack permits at
most two simultaneously active access tokens, so a failed refresh must not turn
into an unbounded refresh loop.

Disconnect revokes Hermes access, user links, pending deliveries, and the
cross-tenant routing pointer in one local transaction. A durable
`slack_revoke` job then calls `apps.uninstall`, honors `Retry-After`, and keeps
the token encrypted only until Slack confirms uninstall (or reports that the
token is already invalid); only then does it erase the credential envelope.
Replacing a different Slack target uses that same cleanup path. Reauthorizing
the same target erases the superseded credential without calling uninstall,
because uninstalling that target would also remove the fresh authorization.

Do not use an app configuration token at runtime. It is needed only if CI later
automates `apps.manifest.*`; in that case keep its access and refresh tokens in
the CI secret store. Manual dashboard import needs no configuration token.

## Enterprise Grid and organization installs

The manifest sets `org_deploy_enabled: true`, which makes the app eligible for
organization-wide deployment. The current OAuth and installation store accept
organization grants, including `team: null`, but the app has not been tested in
a Grid organization and does not yet handle workspace-access lifecycle events.

Store all of these fields from `oauth.v2.access`: `enterprise.id`, `team.id`,
`is_enterprise_install`, `app_id`, `bot_user_id`, granted scopes, and the
rotating credentials. For an organization install, Slack can return
`is_enterprise_install: true` and `team: null`; never require `team.id` as the
installation's primary key. Key installation data by app plus enterprise/team
identity and keep `enterprise_id` even for workspace installs inside a Grid
organization. Workspaces can later migrate into an Enterprise organization.

An org-wide OAuth install does not automatically add the app to workspaces.
After the callback, tell the Org Admin to choose workspaces in Slack at:

```text
https://app.slack.com/manage/<ENTERPRISE_ID>/integrations/profile/<SLACK_APP_ID>/workspaces/add
```

Before Grid general availability, extend the baseline manifest and adapter to
handle `team_access_granted`, `team_access_revoked`, `tokens_revoked`, and
`app_uninstalled`, and reconcile with `auth.teams.list`. Those events are not in
the current minimal manifest because no lifecycle handlers exist. Event
envelopes may contain only one authorization even when several installations
can see the event; shared-channel events also carry source/user team context.
Resolve the relevant installation from Slack's authorization context and never
assume the sender belongs to the enterprise merely because the channel is
shared. Explicitly test Slack Connect participants and deprovisioning.

## Rate limits and backpressure

- Events API delivery is capped at 30,000 events per workspace per app per 60
  minutes. Record `app_rate_limited` and alert on sustained loss/backlog.
- Acknowledge inbound events before processing and use a bounded durable queue.
  Backpressure must not turn into slow acknowledgements and duplicate turns.
- Web API limits are per method, workspace, and app. On HTTP 429, pause that
  method for that workspace for the exact `Retry-After` duration; do not block
  unrelated workspaces or methods.
- Design Slack writes around one message per second per channel. Coalesce
  progress into updates instead of emitting token-by-token messages.
- Retry 5xx/network failures with bounded exponential backoff and jitter only
  when the operation is known to be safe. Treat an unknown write outcome as a
  reconciliation case, not proof that the write failed.

Track acknowledgement latency, signature failures, duplicate rate, queue age,
OAuth/refresh errors, 429s by method and workspace, disconnected installs, and
outbound operations with unknown outcomes. Alert well before the Events API
failure threshold disables subscriptions.

## Local signed-event test

This test exercises the mounted signature-verification route without Slack
credentials or a public tunnel. Before starting the local Worker, put these
non-production values in the uncommitted `apps/worker/.dev.vars` file (the
signing secret must match the client shell below):

```dotenv
SLACK_ENABLED="1"
SLACK_CLIENT_ID="local-signature-test"
SLACK_CLIENT_SECRET="local-signature-test"
SLACK_SIGNING_SECRET="local-test-signing-secret"
SLACK_STATE_SECRET="local-state-secret-at-least-32-bytes"
SLACK_REDIRECT_URI="http://localhost:8787/integrations/slack/oauth/callback"
```

With the project's other local development settings present, start the Worker
from the repository root:

```sh
pnpm dev
```

Then run in another shell:

```sh
export SLACK_SIGNING_SECRET='local-test-signing-secret'
export SLACK_EVENTS_URL='http://127.0.0.1:8787/integrations/slack/events'

SLACK_TEST_TS="$(date +%s)"
SLACK_TEST_BODY='{"type":"url_verification","challenge":"local-test-challenge"}'
SLACK_TEST_BASE="v0:${SLACK_TEST_TS}:${SLACK_TEST_BODY}"
SLACK_TEST_DIGEST="$(printf '%s' "$SLACK_TEST_BASE" | openssl dgst -sha256 -hmac "$SLACK_SIGNING_SECRET" -hex | awk '{print $NF}')"

curl --fail-with-body \
  -H 'Content-Type: application/json' \
  -H "X-Slack-Request-Timestamp: ${SLACK_TEST_TS}" \
  -H "X-Slack-Signature: v0=${SLACK_TEST_DIGEST}" \
  --data-binary "$SLACK_TEST_BODY" \
  "$SLACK_EVENTS_URL"

unset SLACK_TEST_TS SLACK_TEST_BODY SLACK_TEST_BASE SLACK_TEST_DIGEST
unset SLACK_EVENTS_URL SLACK_SIGNING_SECRET
```

Expected response body: `{"challenge":"local-test-challenge"}`. Then verify
failure cases: alter one body byte after signing, use a timestamp more than five
minutes old, omit each signature header, and sign parsed/reformatted JSON
instead of the exact raw bytes. Each must fail closed with 403.

For the idempotency test, send the exact same signed `event_callback` twice with
one `event_id`; both deliveries should get 2xx, but the durable inbox, Hermes
turn, and Slack reply should each exist once. Keep the same `event_id`: Slack's
retry contract preserves it, and the current turn key intentionally treats a
different `event_id` as a different event.

For a real Slack local test of the current implementation, use a separate
development app and point its Request URL at an HTTPS tunnel to the local HTTP
receiver. Socket Mode is an acceptable future local/private-app transport, but
this repository has no Socket Mode client or `SLACK_APP_TOKEN` configuration.
If one is added later, keep it out of the Marketplace/production app and switch
back to HTTP before validating the production path.

## Optional `agent_view` — later, not implemented

Do not uncomment `features.agent_view` yet. The current baseline is an ordinary
bot Messages tab with DMs and mentions. Before enabling Slack's Agent messaging
experience:

1. Implement Agent Sessions status and title lifecycle, including transition
   out of `processing` on success, failure, cancellation, and timeout.
2. Subscribe to and honor `agent_session_stopped` so Slack's native stop button
   actually stops the Hermes run; add `app_home_opened` if opening the Messages
   tab needs onboarding behavior.
3. Revalidate the exact Slack scopes and SDK versions for the Agent Sessions and
   streaming methods selected at implementation time.
4. Test DM/thread session mapping, suggested prompts, stop races, retries, and
   Enterprise Grid before changing the production manifest.

Slack now uses `agent_view` for new agents. Do not add the older
`assistant_view`; migrating an existing app from `assistant_view` to
`agent_view` cannot be reversed.

## Remaining setup and rollout checklist

The application code exists; these deployment, credential, and live-validation
steps have not been completed:

1. Review and apply migration `0025_slack_integration.sql`, deploy the Worker
   and client, and initially leave `SLACK_ENABLED=0`.
2. Choose the production `<SLACK_ADAPTER_HOST>`. Replace every
   `slack-adapter.example.com` occurrence in the manifest and set the exact
   callback as `SLACK_REDIRECT_URI`. The callback and Events URL must be public
   HTTPS endpoints; a localhost value is allowed only by the local config.
3. Create separate Slack development and production apps. Use an app created
   only for development to exercise rotating tokens first. Do not import this
   token-rotation-on production template into the long-lived production app
   until that refresh test passes; Slack does not let an app turn rotation off.
4. Copy the production app's **Client ID**, **Client Secret**, and **Signing
   Secret** from Slack's Basic Information page into `SLACK_CLIENT_ID`,
   `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET`. Generate a distinct random
   `SLACK_STATE_SECRET` of at least 32 bytes. Store the three secrets in the
   production secret manager, not source control or the manifest.
5. Set the five ID/secret/URI values, change `SLACK_ENABLED=1`, and deploy.
   Import the reviewed manifest, then have Slack verify exactly
   `https://<SLACK_ADAPTER_HOST>/integrations/slack/events`. Keep Socket Mode
   off. Complete the organization's Slack app-approval process and, only if
   intended, Slack distribution/Marketplace review.
6. From Hermes **Settings > Slack**, have a recently reauthenticated workspace
   Admin choose **Connect Slack** and complete OAuth. Confirm the UI reports the
   expected workspace or organization and exactly the three baseline scopes.
   For every other pilot member, create a link command in the same settings
   panel and send it to the app in a DM within ten minutes.
7. Exercise a DM and an explicit channel `@mention` end to end. Verify the
   member's existing bound agent/profile and skills are used, the DM session is
   private, a channel reply stays in the initiator-locked thread, and an
   approval wait directs the member to the web Inbox.
8. Exercise signed-body rejection, replay-window rejection, duplicate
   `event_id`, membership revocation, an expired-token refresh, HTTP 429 with
   `Retry-After`, an ambiguous outbound timeout, disconnect, and Slack-side
   uninstall. Confirm secrets and message text do not appear in logs.
9. Before offering Enterprise Grid organization installs generally, implement
   and subscribe to `team_access_granted`, `team_access_revoked`,
   `tokens_revoked`, and `app_uninstalled`; reconcile with `auth.teams.list`;
   then test `team: null`, workspace add/remove, Slack Connect, and workspace
   migration in a Grid sandbox.
10. Enable wider production installs only after dashboards and alerts cover the
    operational signals listed above. Keep unmentioned channel replies, slash
    commands, native Slack approvals, files, Socket Mode, and `agent_view`
    disabled until their separate implementation and security tests pass.

## Official Slack references

- [App manifests and manifest reference](https://docs.slack.dev/app-manifests/),
  [schema fields](https://docs.slack.dev/reference/app-manifest/)
- [Installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth/)
  and [token rotation](https://docs.slack.dev/authentication/using-token-rotation/)
- [Verifying Slack requests](https://docs.slack.dev/authentication/verifying-requests-from-slack)
- [Events API delivery, acknowledgement, retries, and limits](https://docs.slack.dev/apis/events-api/)
- [`app_mention`](https://docs.slack.dev/reference/events/app_mention/) and
  [`message.im`](https://docs.slack.dev/reference/events/message.im/)
- [Web API rate limits](https://docs.slack.dev/apis/web-api/rate-limits/) and
  [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [Socket Mode limitations](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Developing for Enterprise organizations](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/)
- [Developing Slack agents](https://docs.slack.dev/ai/developing-agents/),
  [Agent Sessions](https://docs.slack.dev/ai/agent-sessions/), and
  [`agent_view` announcement](https://docs.slack.dev/changelog/2026/06/30/agent-messages-tab/)
