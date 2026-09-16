# Hermes Enterprise QA and quality-of-life audit

September 15, 2026

## Scope and baseline

- Audited the isolated `codex/hermes-qa-qol` worktree from integrated baseline `75a6ef3359d8d2ca8a8e9b272d8a61544f4f6e08`.
- Exercised onboarding, the workspace picker, sidebar and pane navigation, Iris transcript/composer, Inbox list/detail and approval flows, Members, Settings, empty/error states, keyboard access, reduced motion, and 1440 px / 900 px layouts.
- Provider/catalog code, provider-key settings, Hermes runtime integration, authentication architecture, schemas/migrations, deployment configuration, and the Nous Portal migration were not changed.

## Findings

| Severity | Finding and reproduction | Resolution |
| --- | --- | --- |
| High | In a development build, open the seeded workspace under React StrictMode. The canceled first async bootstrap could finish after cleanup, prepend the same message window a second time, and leave another adapter/hub alive. Each transcript `data-message-id` appeared twice and the whole response repeated below the fold. | The bootstrap now cancels before start, disposes during an interrupted start, and ignores late errors/state writes. A browser regression asserts transcript message IDs are unique. |
| Medium | Open `Members` in the approval fixture. The header said `2 joined · 2 invited`, while the Invitations tab contained one row. A pending membership mirror and its matching invitation were added as two people. | Invitation counts now deduplicate normalized email addresses across both sources. A unit test covers the transitional overlap. |
| Medium | Serve the production client without a reachable API and open `/`. A workspace-directory failure was classified as “signed in, no workspaces,” incorrectly offering workspace creation. | Only an actual 404 renders the empty picker. Other failures render a clear retryable “Could not load your workspaces” state; 401 still renders sign-in. |
| Medium | Reject any Members write, such as invite, resend, withdraw, role change, or removal. The UI discarded the rejection; invite/removal dialogs also closed and “Saved” could appear before the server replied. | Each action now waits for the server, disables only while pending, acknowledges only confirmed success, and shows an inline alert on failure. Failed forms and confirmation dialogs remain open with their input intact. |
| Low | Run the credential-free mock and finish create-workspace or invitation acceptance. The walkthrough stopped before the write, so those client transitions could not be tested without a live database. | Mock mode now implements both writes in memory and carries a created workspace name across the onboarding navigation. Browser tests complete both routes. |
| Low | The workspace picker had live happy-path coverage but no deterministic browser coverage for its response matrix. | Mock-browser coverage now distinguishes signed out, 404/no membership, zero, one, multiple, and network-failure responses. |
| Low | The mock put a pending invite in both the accepted-members mirror and invitations list, contradicting the server model and teaching fixtures to tolerate the wrong source of truth. | Pending invitations now live only in the mock invitations list. Selector deduplication remains as a defensive bridge for transitional server data. |

## Walkthrough result

- Onboarding steps retain entered values when moving back; the 900 px layout keeps the approval-boundary cards and actions within the viewport.
- Sidebar collapse/expand, Chat/App switching, Inbox list/detail navigation, approval request changes/revision/routing, legacy application/invoice/agreement details, and Iris composer waiting/error behaviors remained usable.
- Members and Settings remained within the 900 px viewport with no document-level horizontal overflow.
- The narrow approval path remains keyboard reachable and uses the immediate reduced-motion path already covered by Playwright.
- Members write failures were exercised in the rendered UI; errors remain visible, and invite email input survives a rejected write.
- The tested responsive floor for this desktop shell is 900 CSS px. Below that, a phone-sized navigation treatment is a separate product change rather than an accidental promise of support.

## Remaining limitations

- Mock onboarding validates client transitions and contract shapes; the existing live suite remains authoritative for persistence, invitation identity matching, and authorization.
- Workspace-directory success with multiple real memberships was not mutated in the shared database; the deterministic browser fixture covers rendering while the live suite remains authoritative for the real route.
- This was desktop-browser and 900 px responsive emulation, not physical-device testing.
- Re-run the focused composer, model-menu, Settings, and empty-state walkthrough after the Nous provider migration is integrated; this branch intentionally does not touch that concurrent scope.
