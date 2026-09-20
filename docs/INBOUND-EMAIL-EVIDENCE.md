# Selected Gmail thread evidence

Hermes can import one Gmail thread that a workspace Admin explicitly selects. The import is an immutable evidence snapshot for an agent’s governed Library team. It is not a mailbox browser and it is not an email-sending integration.

## Authority boundary

- The evidence flow uses a separate Google OAuth client and token table from the outbound sender.
- Consent requests exactly `https://www.googleapis.com/auth/gmail.readonly`, with `include_granted_scopes=false`. A returned token carrying any additional scope is rejected.
- Hermes exposes no mailbox list or search route. An Admin pastes one provider thread ID for each import.
- The imported snapshot is immutable, versioned in the Library, and granted only to the selected agent’s explicit Enterprise team.
- Imported text is labeled as untrusted external evidence. It is never interpreted as runtime instructions.
- An inbound reply can mark a partner engagement replied and cancel later queued outreach. A strong explicit unsubscribe or standards-shaped hard bounce can also add a contact suppression. These paths enqueue zero sends.
- A person can attach the snapshot to an access-grant or signature effect as a claim that it completed elsewhere. The receipt says `evidence_recorded_not_provider_verified`, sets `provider_execution_by_hermes=false`, and does not change the effect’s execution status.
- External evidence receipts are unavailable for payment and email-send effects.

## Deployment setup

Keep the feature disabled until Google consent, data-handling, and production review are complete:

```dotenv
GMAIL_EVIDENCE_ENABLED="1"
GMAIL_EVIDENCE_CLIENT_ID="...apps.googleusercontent.com"
GMAIL_EVIDENCE_CLIENT_SECRET="..."
GMAIL_EVIDENCE_STATE_SECRET="at-least-32-random-characters"
GMAIL_EVIDENCE_REDIRECT_URI="https://enterprise.example/integrations/gmail-evidence/oauth/callback"
```

Do not populate these values from `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, or the outbound Gmail token. The Worker intentionally has no fallback between these namespaces.

Google classifies `gmail.readonly` as a restricted scope. Production use must follow Google’s OAuth verification requirements and, when restricted data is stored or transmitted through a server, may require a security assessment. Use the narrowest scope and disclose the immutable Library retention behavior in the consent and privacy materials.

Primary references:

- [Google Gmail OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google `users.threads.get`](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get)
- [Gmail API overview](https://developers.google.com/workspace/gmail/api/guides)

## Why the native Google path

Nylas exposes reply and bounce webhooks, but adopting it would add a paid/provider account, a new data processor, and broader mailbox synchronization authority. That is not necessary for explicit selected-thread import. See [Nylas webhook notifications](https://developer.nylas.com/docs/reference/api/webhook-notifications/).

Nous Hermes Agent’s Google Workspace skill combines Gmail, Calendar, and Drive authorization, while its email plugin couples IMAP polling to SMTP reply capability. Neither matches this server-owned, Gmail-only, no-send consent boundary. They remain useful references, not runtime dependencies:

- [Hermes Google Workspace skill](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/skills/google-workspace.md)
- [Hermes email plugin manifest](https://github.com/NousResearch/hermes-agent/blob/main/plugins/platforms/email/plugin.yaml)

## Operator verification

1. Confirm the redirect URI belongs to the dedicated evidence OAuth client.
2. Start consent from Library → Connections and verify the Google page shows only Gmail read-only access.
3. Import one known thread ID and verify it appears as a new immutable Library source version for the expected team.
4. Reimport unchanged content and verify the existing snapshot is returned.
5. Import a test reply/unsubscribe and verify later queued outreach is cancelled, a suppression is recorded where applicable, and no `outbound_email_send` job is created.
6. Record external access/signature evidence and verify the effect remains pending/unavailable rather than executed.

No live mailbox was connected while implementing this feature. Enabling it requires the deployment configuration and a user’s explicit Google consent.
