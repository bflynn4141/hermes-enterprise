# Roles and agents plan

The goal: an Admin configures agents, and maps them to roles, responsibilities
and the approval types each role requests or decides, from the product instead
of from code.

Mapped against `main` at `82e3640` on September 26, 2026. The pieces below are
in build order; each one ships something a person can try.

## Where things stand

| Area | Today | What an Admin can do |
|---|---|---|
| Roles | Two, Partnerships and Finance, fixed by database checks. One person and one agent per role. A member's job role lives only on their invitation. | Bind the two roles with raw ids. |
| Agents | No owner, role, model or skill fields on the agent itself. No create, rename or delete. | Edit a skill assignment's settings, pause state and schedule; toggle approval for three operations. An Admin cannot open another member's private agent. |
| Skills | Four packages, defined in code with pinned versions. The runtime proves each skill's exact bytes. | Nothing: no assign, unassign or version change. |
| Approval types | Five legacy request kinds, plus ten typed approvals running on a real policy engine (steps, quorum, no self-review, role or person selectors). | Nothing: policies are seeded in code, and an unseeded type fails with `no_applicable_policy`. |
| Reviewer roles | Free-text tags (`finance`, `access`, `legal`) that gate effects. | API only; no UI. |
| Handoffs | A generic-looking table with two lanes, five stages and one seeded Partnerships → Finance handoff. | Turn it on or off. |

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
| 0 | Safety fixes: Finance authority from server-written subject keys, not payloads; the two-person payment rule enforced; a workspace legal name instead of a hardcoded party. | Nothing new to click; closes known gaps first. | In progress (decision C90) |
| 1 | Admin → Agents directory with owner, role, skills, runtime and approval switches for every agent; Admins set any agent's role and permissions without seeing its conversations; person and agent pickers in the role binding form. | An Admin sees who does what and turns on the Partnerships → Finance handoff in a minute. | In progress |
| 2 | Roles as data: a roles table seeded with Partnerships and Finance replaces the fixed checks; job roles persist on members; many people per role; invitations pick from the table; reviewer tags become role membership. | No visible change; unblocks 3–5. | Next |
| 3 | Approval routing screen over the existing policy engine: per approval type, the deciding role or people, steps, quorum and self-review. | "Invoices over $5k need two Finance approvals," routed live. | |
| 4 | Agent configuration: create and rename agents, assign catalog skills (the unused create-assignment schema), a model per agent, approval switches for more operations. | Set up a third role's agent from the UI. | |
| 5 | Configurable handoffs: role to role, chosen trigger and request type, more than two lanes. | Wire a new cross-role flow without code. | Wait for a second real workflow |

## Known gaps carried into later pieces

- Parked tool-call decisions (operation approvals) have no step-up, and
  `propose_approval` is not covered by the operation switches.
- `docs/APPROVAL-EXPANSION-STATUS.md` predates the shipped routes and runtime.
- Legacy request kinds (application, invoice, agreement) route by hardcoded
  rules rather than policies; piece 3 should move them onto policies.
