# WorkOS production checklist

This is the handoff between the code in this repository and the configuration
that only exists in WorkOS and Cloudflare. It is intentionally exact: a green
test suite proves our redirect, cookie, token and mirror logic; it cannot prove
that an email arrived, an IdP challenged a user, or a live WorkOS application
has the right settings.

## Contract implemented here

- AuthKit Hosted UI is the only sign-in/sign-up UI. `/auth/login` creates a
  random 256-bit state nonce and a signed, HTTP-only, ten-minute transaction
  cookie. The callback requires both, exchanges the code once, and clears the
  transaction cookie. Return paths and invitation tokens live in that cookie,
  not in caller-controlled callback parameters.
- User access tokens are RS256-verified against the application JWKS and must
  carry the configured `iss`, the current `WORKOS_CLIENT_ID` in `client_id`,
  `sub`, `sid`, `exp`, `iat`, and `auth_time`. WorkOS user tokens identify the
  application with `client_id`; this is not an `aud` check.
- The callback accepts only the organization in the verified token and
  authentication response, then verifies an active WorkOS membership for that
  exact user and organization. An unscoped callback never chooses the first
  membership; `/auth/session` returns the workspace list and the client makes
  the choice explicitly.
- Invitations and resends in `AUTH_MODE=workos` do not create new local pending
  state unless WorkOS has a linked organization and accepted the send. WorkOS
  sends the email; Hermes has no mail fallback.
- Workspace creation creates the WorkOS organization, makes the creator its
  `admin`, commits the local workspace, and refreshes the sealed session with
  the new organization. If that final refresh is transiently unavailable, the
  committed local membership remains usable and the failure is logged; the
  user can select the workspace or sign in again.
- Deployed fake auth fails readiness and requests. Missing WorkOS on an
  outbound sync keeps the job retryable, and a linked workspace is not deleted
  locally until its WorkOS organization deletion succeeds.

These choices follow WorkOS's current documentation for [Hosted UI](https://workos.com/docs/authkit/hosted-ui),
[session tokens](https://workos.com/docs/reference/authkit/session-tokens),
[reauthentication](https://workos.com/docs/authkit/reauthentication),
[organization creation and switching](https://workos.com/docs/authkit/users-organizations),
and [invitations](https://workos.com/docs/authkit/invitations).

## Cloudflare configuration, separately for staging and production

Set these Worker values in the matching WorkOS environment. Never reuse a
staging key, cookie password, or client ID in production.

| Value | Requirement |
|---|---|
| `AUTH_MODE` | `workos` (already pinned in `wrangler.jsonc`) |
| `WORKOS_API_KEY` | API key for this WorkOS application/environment |
| `WORKOS_CLIENT_ID` | Exact application client ID |
| `WORKOS_COOKIE_PASSWORD` | Random, at least 32 characters; rotation invalidates every sealed session |
| `WORKOS_ISSUER` | Exact `issuer` from the application's OIDC discovery document; no guessing or copying between applications |
| `WORKOS_REDIRECT_URI` | Exact HTTPS callback; pinned in `wrangler.jsonc` for both deployed hosts |
| `ALLOWED_ORIGINS` | The same HTTPS origin as the callback |
| `HUB_TICKET_SECRET` | Separate random secret recommended; otherwise the cookie password is used |

To obtain `WORKOS_ISSUER`, open
`https://api.workos.com/user_management/<WORKOS_CLIENT_ID>/.well-known/openid-configuration`
for the relevant environment/application and copy the `issuer` value exactly.
The explicit value matters because current WorkOS documentation includes both
legacy API-origin token examples and application-scoped issuers. Readiness is
red in staging/production if this value is absent.

Before any browser test, call `/health` and require `auth:config` and
`workos:jwks` to be green. A 503 is a deployment block, not a reason to switch
to fake auth.

## WorkOS Dashboard configuration

For each application/environment:

1. Under **Applications → Redirects**, add only the exact callback from
   `WORKOS_REDIRECT_URI`. Add the same-origin `/` as the post-logout return URI
   if the dashboard requests an allowlist.
2. Set **User invitation URL** to `https://<host>/auth/login`. WorkOS appends
   `invitation_token`; Hermes binds it into the browser transaction before
   forwarding to Hosted UI. Do not point invitation emails straight at the
   callback.
3. Disable public **Sign up**. A valid invitation token temporarily opens the
   Hosted UI registration path, which is WorkOS's invite-only model.
4. Keep WorkOS invitation email delivery enabled unless a real replacement
   mail system is implemented. Hermes deliberately contains no SMTP/custom
   invitation sender.
5. Create role slugs `admin` and `member`, with `member` as the ordinary default.
6. Disable domain/JIT auto-membership unless the product policy is deliberately
   changed; otherwise a matching domain bypasses invite intent.
7. Enable the intended hosted methods: Email + Password and/or Magic Auth for
   email sign-in, MFA policy for non-SSO users, and the required enterprise SSO
   connection(s). AuthKit chooses what Hosted UI displays from these dashboard
   settings.
8. Verify each SSO connection is attached to the intended WorkOS organization
   and verified domain. Do not use a production IdP in staging.
9. Review the application session lifetime and refresh policy. Hermes stores
   the sealed refresh session in an HTTP-only, Secure, SameSite=Strict cookie.

WorkOS documents the invitation URL and `invitation_token` behavior under
[custom emails](https://workos.com/docs/authkit/custom-emails), even when WorkOS
continues to send the default email. The role/membership API used during
workspace creation is the [organization membership API](https://workos.com/docs/reference/authkit/organization-membership).

## Staging acceptance test with real credentials

Use a clean private browser and test accounts that are safe to modify.

1. **Readiness:** `/health` is 200; `auth:config` says `configured` and
   `workos:jwks` says `reachable`.
2. **Email sign-in:** start at Hermes, confirm the browser leaves for AuthKit,
   complete the enabled email method, and return through `/auth/callback` once.
   Confirm the session cookie is HTTP-only/Secure/SameSite=Strict. A callback
   with a changed or missing state must return 400 `invalid_state` before code
   exchange.
3. **Invitation:** invite a new address from Hermes. Confirm an actual WorkOS
   email arrives, its link first reaches `/auth/login?invitation_token=...`, and
   the new/existing user joins only the intended organization. Confirm the
   Hermes pending row has a WorkOS invitation ID and becomes accepted after
   sign-in/event reconciliation.
4. **Multiple workspaces:** give one user two memberships. Complete sign-in and
   verify either AuthKit asks for the organization or Hermes presents its
   workspace picker; Hermes must never silently open whichever membership the
   API returned first.
5. **Enterprise SSO:** start from Hermes with the SSO-domain account, complete
   the real IdP challenge, and verify the returned `org_id`, local workspace,
   role, and email all match the configured organization.
6. **Refresh:** wait beyond the access-token lifetime and load an authenticated
   route. It should refresh and rotate the sealed cookie without signing out.
   A transient upstream failure returns 503 and leaves the cookie intact; a
   revoked/terminal refresh ends the session.
7. **Step-up:** age the local `authenticated_at`, attempt a guarded action, and
   complete `/auth/login?step_up=1`. Confirm the new token retains `sid`, has a
   later `auth_time`, and the action still requires the user's second explicit
   confirmation. For SSO/MFA users, confirm AuthKit invokes the expected factor
   or IdP.
8. **Logout:** use the visible **Sign out** control. It must navigate to
   `/auth/logout`, clear session/CSRF/transaction cookies, revoke the local
   `sid`, continue through the WorkOS logout URL, and return to the app signed
   out. Reusing the old sealed cookie must fail.
9. **Workspace creation:** create a workspace, verify the WorkOS organization
   and creator `admin` membership exist, then confirm the refreshed access
   token carries that organization.

Record the WorkOS environment, application/client ID suffix, timestamp, and
pass/fail evidence for each item. Do not record authorization codes, invitation
tokens, cookies, API keys, or full JWTs.

### Staging verification — September 15, 2026

- **Environment:** WorkOS Staging; hosted UI
  `reasonable-voyage-37-staging.authkit.app`; client suffix `…E90T`.
- **Entry point:** `https://staging.hermes.brianflynn.dev/auth/login` redirected
  to the expected AuthKit application. The live page displayed **Sign in to
  Hermes** with email, Google, Microsoft, GitHub, and Apple options.
- **Invite-only behavior:** public sign-up remains disabled. An application-wide
  invitation was created for the first test user at 7:27 PM Pacific and the
  WorkOS email event reached **Delivered**. The message also appeared in the
  destination inbox with subject **[STAGING] You’ve been invited to Hermes**.
- **Branding:** dark appearance, Inter, medium radius, the Hermes navy-to-violet
  gradient, Iris mark, glass card, and branded primary action were saved and
  visually verified on the live hosted page. The reusable source is in
  [`assets/hermes-authkit.css`](assets/hermes-authkit.css) and
  [`assets/hermes-authkit-icon.svg`](assets/hermes-authkit-icon.svg).

This verifies the hosted entry point and WorkOS-managed invitation delivery. It
does not yet verify invitation acceptance, callback state exchange, the session
cookie, MFA, organization membership reconciliation, refresh, step-up, logout,
workspace creation, or a real enterprise IdP. Complete those items using the
fresh invitation; an earlier magic-code challenge for an unknown user remains
invalid by design.

### Staging verification — September 20, 2026

- **Environment:** WorkOS Staging; client suffix `…E90T`; host
  `https://staging.hermes.brianflynn.dev`.
- **1. Readiness:** `GET /health` returned `200` with `status: ok`.
  `auth:config` = `configured`, `workos:jwks` = `reachable`, and
  `hermes:runs` = `ready`.
- **2. Login entry / state cookie:** `GET /auth/login` redirected to
  WorkOS `user_management/authorize` with the staging `client_id` and
  `redirect_uri=https://staging.hermes.brianflynn.dev/auth/callback`.
  Set-Cookie `hermes_auth_transaction` was `HttpOnly`, `Secure`,
  `SameSite=Lax`, `Max-Age=600`, `Path=/auth/callback`.
- **Invalid callback:** `GET /auth/callback?code=fake&state=wrong`
  returned `400` with the “Your sign-in expired” page and a link to
  `/auth/login` (no code exchange).
- **Authenticated shell:** An existing sealed session opened the
  workspace picker (one membership: Brian Interview Demo) and the
  workspace shell (Agents / Inbox / Members / Admin). Session cookie
  is not readable from JavaScript; only `hermes_csrf` appears in
  `document.cookie`.
- **8. Logout endpoint:** Unauthenticated `GET /auth/logout` cleared
  `hermes_session` (`HttpOnly; SameSite=Strict; Secure; Max-Age=0`),
  `hermes_csrf`, and `hermes_auth_transaction`, then redirected to `/`.
  Visible **Sign out** in the account menu targets this route (UI
  exercised in the staging browser session).

Still open for a clean private-browser pass with a disposable inbox and
SSO test IdP: invitation accept via emailed link, multi-org picker under
forced choice, enterprise SSO IdP challenge, access-token refresh
rotation, step-up / MFA, and workspace creation with WorkOS org mirror.

## What automated tests prove—and do not prove

`FakeWorkOS` signs genuine RS256 JWTs and publishes an in-memory JWKS. Database
tests exercise state binding, claim checks, membership mirroring, invitation
rollback, refresh/logout behavior, job retry state, workspace provisioning,
and fake-auth refusal deterministically. Client tests prove the visible sign-out
control uses `/auth/logout`, and the production build scans for fake-auth UI
markers.

The original code sweep had no WorkOS dashboard access, so its automated proof
remains deliberately bounded. A later staging check verified the real hosted
AuthKit page and WorkOS invitation delivery as recorded above. MFA, a real SSO
IdP, callback/session behavior, refresh rotation, membership reconciliation,
and WorkOS logout remain external acceptance work.
