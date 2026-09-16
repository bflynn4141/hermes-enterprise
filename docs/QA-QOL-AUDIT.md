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

## Walkthrough result

- Onboarding steps retain entered values when moving back; the 900 px layout keeps the approval-boundary cards and actions within the viewport.
- Sidebar collapse/expand, Chat/App switching, Inbox list/detail navigation, approval request changes/revision/routing, legacy application/invoice/agreement details, and Iris composer waiting/error behaviors remained usable.
- Members and Settings remained within the 900 px viewport with no document-level horizontal overflow.
- The narrow approval path remains keyboard reachable and uses the immediate reduced-motion path already covered by Playwright.

## Remaining limitations

- Mock mode deliberately returns `501` for `POST /workspaces`, so this pass verified onboarding through the final review screen but did not create a mock workspace. Creating one against the shared live development database was avoided.
- Workspace-directory success with multiple real memberships was not mutated in this pass; the existing live suite remains the authoritative integration coverage for the real route.
- This was desktop-browser and 900 px responsive emulation, not physical-device testing.
