# Role spending policy drafts

Admins can save a proposed Base USDC spending profile for any built-in or custom
responsibility role. Saving a draft does **not** grant payment review, signing,
or spending authority. There is no activation endpoint, provider mutation,
signature, broadcast, or payment in this feature. Workspace Admin status remains
separate from customer root-owner custody.

## Implemented contract

`GET /w/:ws/roles/:id/spending-policy` returns the current proposal, or revision
zero with a null policy. `PUT` accepts `expected_revision` and a strict version-1
`policy`. Both routes require an active workspace Admin; writes additionally
require recent sign-in, the existing origin check, and CSRF protection.

The policy pins Base mainnet (8453), native USDC
(`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`), and six decimal places. It records
an exact positive integer per-transfer amount in base units, a nonempty
recipient allowlist, and one to ten human approvals. Amounts are decimal strings,
never JavaScript floating-point numbers. Recipients must be canonical lowercase
addresses; zero, the token contract itself, and duplicates are rejected. No
wildcard destination, unattended quorum, arbitrary chain, or extra provider
configuration is accepted.

Optional day/month budget proposals must explicitly carry
`enforcement: not_implemented`. Their accounting window, reservation, settlement,
and reset semantics are not implemented. These are saved future requirements,
not enforced budgets.

Every response states `state: draft_only`, `enforcement: none`, and
`provider_activation_available: false`. All provider bindings and current quota
usage remain unverified. A wallet root setup or a successful proposal save does
not change these facts.

Each save appends one immutable revision with the author, role name, policy, and
timestamp. The role row lock and expected revision prevent lost updates; a stale
save returns HTTP 409 with `revision_conflict`. The audit revision, settings event,
and stream event commit together. Read and write responses use `no-store`.
Deleting a custom role preserves its draft history; recreating the same name
creates a new role ID and does not inherit the old proposal. The agent database
role has no access; the application role can only read and append revisions.

Admin → Roles → a role exposes a compact Spending limits card. Its editor accepts
USDC decimals without rounding, keeps future period budgets in a disclosure,
and offers Save draft only. Conflicts preserve the local input and disable
another save until the Admin explicitly reloads the latest saved draft. The
existing recent-sign-in flow handles step-up refusals. The card remounts across
workspace, signed-in user, and role changes. Dialog open/close reuses the existing
brief opacity fade; the future-limit disclosure changes immediately, with no
spatial animation or extra reduced-motion behavior needed.

## Planning and provider boundary

The pure planner creates descriptive rules, not executable Turnkey expressions.
Each role's approval consensus stays paired with its own transaction conditions.
It never separately unions all role tags and all ceilings or destinations. One
proposal consumes one prospective policy slot; all existing policies also count.
The planner blocks a total above five, unknown existing policy count, missing
verified role/wallet bindings, unverified ABI/provider state, and unknown
signature usage. Activation always remains blocked because its implementation,
owner authorization, and fee configuration are absent.

Before future activation, exact source wallets, verified human approver/tag
bindings, reviewed USDC ABI arguments, gas/fee ceilings, current owner
authorization, policy read-back, drift handling, and provider quota checks must
be implemented and tested. A broader existing allow policy could bypass a narrow
allow rule; all organization policies need review. Turnkey root quorum bypasses
policy restrictions, so these limits must never be described as restricting
customer recovery owners. [Policy evaluation](https://docs.turnkey.com/features/policies/overview)

Turnkey supports tag-based consensus, transaction chain and wallet conditions,
and ABI-decoded function/argument checks. For USDC, native transaction value is
normally zero: the token amount must be checked in the decoded transfer call.
The exact ABI, transfer selector, and recipient must also be pinned.
[Policy language](https://docs.turnkey.com/features/policies/language),
[smart contract interfaces](https://docs.turnkey.com/features/policies/smart-contract-interfaces)

## Free-tier constraints checked September 29, 2026

Turnkey advertises 25 free signatures per month and up to 1,000 free wallets on
Pay-as-you-go. Free, Pay-as-you-go, and Pro allow five policies per organization.
Each suborganization separately has 100 users, 100 wallets, and 10 tags. Human,
agent, and service identities consume those capacities. Transaction management
has separate transaction fees; additional signatures also cost money. Public
plan information is not proof of this account's remaining allowance. This
feature does not activate billing, auto-upgrade, or guarantee free execution.
[Pricing](https://www.turnkey.com/pricing),
[resource limits](https://docs.turnkey.com/reference/resource-limits)

The current official OpenAPI definitions expose velocity-control concepts:
SUM/COUNT, rolling or infinite windows, and organization/user/wallet grouping.
The published paths did not expose a corresponding creation endpoint during
this check, and no free-tier entitlement or role-wide grouping was established.
Treat cumulative provider budgets as unavailable/unverified until those facts
and enforcement behavior are confirmed; do not infer availability from a schema
type alone. [Official API specification](https://docs.turnkey.com/public_api.swagger.json)

Time-based policies describe scheduled or expiring permission windows. They do
not establish cumulative spending accounting.
[Time-based policies](https://docs.turnkey.com/features/policies/time-based-policies)

## Verification

Shared and Worker unit tests cover strict amount/network/recipient/quorum
validation, truthful status, independent role conditions, free policy-slot
accounting, and unavailable provider evidence. Database tests cover current
Admin/step-up/CSRF guards, tenant isolation, concurrent saves, immutable audit,
custom-role deletion, and absence of wallet or membership changes. These tests
do not prove live Turnkey policy acceptance or payment enforcement.
