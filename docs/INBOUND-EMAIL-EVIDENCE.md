# Selected Gmail thread evidence

Hermes can import one Gmail thread that a workspace Admin explicitly selects. The import is an immutable evidence snapshot for an agent’s governed Library team. It is not a mailbox browser and it is not an email-sending integration.

## UX status: operator proof, not a finished picker

The current Connections form accepts a Gmail API `threadId`. That is a technical operator path, not a finished user-friendly selection flow. Google documents `threadId` as an opaque API resource identifier, but does not document a supported conversion from a Gmail browser URL or URL fragment to that identifier. Hermes therefore does not parse pasted Gmail links or claim that a browser link can be converted safely.

Google does provide a supported user-recognizable selection surface through a Google Workspace add-on in Gmail. When a user opens a message and invokes a contextual add-on action, the Gmail event object contains the currently open `gmail.messageId` and `gmail.threadId`. A future “Import to Hermes” Gmail add-on could pass that authenticated contextual thread ID to this existing exact-thread intake while the independent `gmail.readonly` connection remains the server-side content authority. That add-on, its event authentication, installation policy, and consent review are not implemented here.

Hermes must not substitute `users.threads.list` or mailbox search for that picker: doing so would broaden the product from explicit selected-thread intake into mailbox browsing. Until a supported contextual selector is built, describe this screen as an operator proof rather than a complete end-user flow.

Primary selection references:

- [Google Workspace add-on event objects](https://developers.google.com/workspace/add-ons/concepts/event-objects)
- [Extending the Gmail message UI](https://developers.google.com/workspace/add-ons/gmail/extending-message-ui)
- [Gmail thread management](https://developers.google.com/workspace/gmail/api/guides/threads)

## Authority boundary

- The evidence flow uses a separate Google OAuth client and token table from the outbound sender.
- Consent requests exactly `https://www.googleapis.com/auth/gmail.readonly`, with `include_granted_scopes=false`. A returned token carrying any additional scope is rejected.
- Hermes exposes no mailbox list or search route. An Admin pastes one provider thread ID for each import.
- The imported snapshot is immutable, versioned in the Library, and initially granted only to the selected agent’s explicit Enterprise team. Removing that Team grant revokes Library, context, and approval-evidence reads while retaining the immutable snapshot for audit. Importing the same thread again does not silently restore a revoked grant.
- Imported text is labeled as untrusted external evidence. It is never interpreted as runtime instructions.
- An inbound reply tied to the exact provider thread can mark a partner engagement replied and cancel later queued outreach. A strong explicit unsubscribe reply can also add a contact suppression. DSN-looking text is not authenticated delivery evidence: Hermes records it as unverified evidence only and does not suppress, change engagement state, or cancel outreach from it. These paths enqueue zero sends.
- A named approval-audience reviewer can read only a snapshot cited by that request’s exact immutable approval revision, and only while the snapshot’s Team grant remains current.
- Hermes exposes no external-completion receipt route. The typed approval flow does not create the legacy decision/effect binding that such a receipt would need, so recording one would overstate what the product can prove. Access, signature, email, and payment actions performed outside Hermes remain outside Hermes; pending effects remain pending or unavailable rather than being relabeled as executed.

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
4. Reimport unchanged content and verify the existing snapshot is returned. Remove its Team grant, then verify Library, context, and approval-evidence reads deny access while the audit snapshot remains stored; a reimport must fail rather than silently recreate the grant.
5. Import a test reply/unsubscribe and verify later queued outreach is cancelled, a suppression is recorded where applicable, and no `outbound_email_send` job is created. Separately import spoofable DSN-looking text and verify it remains unverified evidence without suppression or cancellation.
6. Verify `POST /w/:ws/effects/:id/external-evidence` is not exposed and ordinary effects remain pending/unavailable until a real executor exists.

No live mailbox was connected while implementing this feature. Enabling it requires the deployment configuration and a user’s explicit Google consent.
