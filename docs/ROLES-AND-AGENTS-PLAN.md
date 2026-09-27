# Roles and agents plan

The goal: an Admin configures agents, and maps them to roles, responsibilities
and the approval types each role requests or decides, from the product instead
of from code.

Mapped against `main` at `82e3640` on September 26, 2026; the table below was
brought up to date after C90–C93 and C97. The pieces below are in build order;
each one ships something a person can try.

## Where things stand

| Area | Today | What an Admin can do |
|---|---|---|
| Roles | A catalog per workspace (C92): five built-ins plus any an Admin adds. Many people hold a role, and a member's job role stays on them after they join. Only the handoff lanes are still one person and one agent per side. | Admin → Roles: add, rename (custom roles), describe, staff and remove roles. Set a person's roles when inviting them or in Manage. Changes need a recent sign-in. |
| Agents | A directory of every agent with its owner, role, skills, runtime and approval switches (C91). No create, rename or delete. | Set any agent's role and permissions without reading its conversations; edit a skill assignment's settings, pause state and schedule; toggle approval for three operations. |
| Skills | Four packages, defined in code with pinned versions. The runtime proves each skill's exact bytes. | Nothing: no assign, unassign or version change. |
| Approval types | Seven business approvals (three decisions, four actions) routed by workspace rules (C93), plus typed approvals a workflow raises with its own reviewer. | Admin → Approvals: choose Admins and/or roles for each of the seven, how many different people an action needs, and whether the requester may approve. Workflow-raised approvals are listed read-only (C97). |
| Reviewer roles | Merged into roles (C92): holding a role is what a tag was. | The same as Roles. |
| Handoffs | A generic-looking table with two lanes, five stages and one seeded Partnerships → Finance handoff. | Pick each lane's person and agent by name, and turn it on or off. Saving the lanes and turning the handoff on need a recent sign-in, and an Admin cannot name themself for Finance (C97). |

The approval policy engine (`approval_policies`, `domain/approvals.ts`) is the
one part that is already generic. The work is mostly making roles data and
giving Admins controls over pieces that exist.

## Target model

1. **Role.** Defined by the workspace: a name and responsibilities, the skills,
   tools and connector scopes its agents get, the approval types it may
   request, and the approval types it decides.
2. **People in roles.** A member holds one or more roles, kept after they join.
   Reviewer tags fold into roles, so "who decides invoices" and "who is in
   Finance" are one fact.
3. **Agent profile.** An agent belongs to one role and acts for one principal
   person. Its skills, model and approval switches come from the role, and an
   Admin can adjust them within it.
4. **Approval routing.** Per approval type: which role or people decide, in how
   many steps, with what quorum. The existing policy engine, with an Admin
   screen.
5. **Handoffs.** Role to role, triggered by a decision, with the recipient
   resolved from the role rather than hardcoded.

Admins compose roles from a vetted catalog of skills; they do not author skill
packages. The runtime attests exact skill bytes, and free-form skills would
break that guarantee. Instructions and skill settings stay editable, as today.

## Decisions (Brian, September 26, 2026)

1. An Admin can change the role and permissions of any member's agent, but can
   never read that agent's conversations.
2. Many people per role; one principal per agent.
3. Reviewer tags merge into roles.
4. Documents use a workspace legal name. The demo uses the fictional
   "Hermes Teams Demo Co."

## Pieces

| # | Piece | What you can try | Status |
|---|---|---|---|
| 0 | Safety fixes: Finance authority from server-written subject keys, not payloads; the two-person payment rule enforced; a workspace legal name instead of a hardcoded party. | Nothing new to click; closes known gaps first. | Done, #184 (C90) |
| 1 | Admin → Agents directory with owner, role, skills, runtime and approval switches for every agent; Admins set any agent's role and permissions without seeing its conversations; person and agent pickers in the role binding form. | An Admin sees who does what and turns on the Partnerships → Finance handoff in a minute. | Done, #185 (C91) |
| 2 | Roles as data: a roles table seeded with Partnerships and Finance replaces the fixed checks; job roles persist on members; many people per role; invitations pick from the table; reviewer tags become role membership. | Admin → Roles: see who holds each role, add roles, staff them. Unblocks 3–5. | Done (C92) |
| 3 | Approval routing screen: per approval type, which roles (and whether Admins) approve, how many different people an action needs, and whether the requester may approve. No steps, named people or multi-person decisions yet. | Payments need three Finance people; a new member's roles say what they can approve. | Done (C93) |
| 4 | Agent configuration: create and rename agents, assign catalog skills (the unused create-assignment schema), a model per agent, approval switches for more operations. | Set up a third role's agent from the UI. | |
| 5 | Configurable handoffs: role to role, chosen trigger and request type, more than two lanes. | Wire a new cross-role flow without code. | Wait for a second real workflow |

## How this relates to Nous

Checked September 26, 2026 against the Nous Portal Business page, the Hermes
Agent security docs and Hermes Agent v2026.9.24 source.

- **Account roles.** A Nous Portal organization has Owner, Admin and Member;
  owners and admins manage roles, spend caps and API keys. Our workspace roles
  are Admin and Member. If we read a Nous `org_role`, Owner and Admin both
  map to our Admin. Nous gates billing on server capabilities such as
  `can_change_plan` rather than role names, and we should do the same for
  anything Nous-billed.
- **Functional roles, agent roles and approval routing.** Nous documents none.
  Our role catalog (C92) and approval rules (C93) are our own layer; skill
  frontmatter has no role field.
- **"Approvals" in Hermes** means an agent asking a person before a dangerous
  command (`approvals.mode`, `cron_mode`, `unattended_mode`). Our plugin sets
  those keys to deny for managed profiles. Our Approvals screen is about
  business decisions, and its copy says so.
- **Member-proposed shared skills** wait for an Nous org admin's approval;
  that is separate from our Library skills and we do not claim it is the same
  flow.

## Known gaps carried into later pieces

- Parked tool-call decisions (operation approvals) have no step-up, and
  `propose_approval` is not covered by the operation switches.
- `docs/APPROVAL-EXPANSION-STATUS.md` predates the shipped routes and runtime.
- Decisions take one person in this version; multi-person decisions would
  need votes on legacy requests like typed approvals have.
- Approval requests raised by workflows (outreach drafts, a new member's first
  search, record changes, Shared Intelligence) keep their own seeded policies.
  The Approvals screen lists them read-only (C97); an Admin cannot route them
  yet.
- An invitation's job always grants its role when the person joins (a Finance
  job also binds them to the Finance lane), so the Invite dialog shows that
  role ticked and fixed (C97). Inviting someone for a job without its role
  would need invitations to record that the Admin chose roles explicitly.
- Amount thresholds ("over $5k") are not supported yet.
