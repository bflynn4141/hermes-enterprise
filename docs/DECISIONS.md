# Architecture decision index

This index is the starting point for consequential implementation choices. The
decision record is split into smaller, chronological volumes so a reviewer or
agent can load the relevant context without reading a single 6,000-line file.

Decision IDs are stable references used by code comments and other documents.
The suffixes in C34a/C34b, C73a/C73b, and C74a/C74b make identifiers that were
previously reused unique; they do not change the underlying decisions.

| Volume | Scope |
| --- | --- |
| [Foundational decisions](decisions/01-foundations.md) | Initial product, data, tenancy, authorization, jobs, authentication, and hub choices. Includes decisions 1 through 36. |
| [Uploads and client foundations](decisions/02-uploads-and-client-foundations.md) | Upload decisions U1 through U11 and early client decisions C1 through C11. |
| [Engine and tool decisions](decisions/03-engine-and-tools.md) | Run engine decisions 40 through 48 and tool-policy decisions E1 through E7. |
| [Human decisions and effects](decisions/04-decisions-and-effects.md) | Decision-route, effect, receipt, history, and document choices D1 through D12, including simulated effect execution outside production. |
| [Client and operations decisions](decisions/05-client-and-operations.md) | Client decisions C12 through C24 and operations decisions O1 through O13. |
| [Integration fixes and hardening](decisions/06-integration-fixes.md) | Integration decisions F1 through F8, client decisions C25 through C34a, and hardening decisions G1 through G9. |
| [Provider and interface decisions](decisions/07-provider-and-interface.md) | Provider decisions R1 through R13 and interface decisions C33 through C47, including C34b. |
| [Runtime and team workflow decisions](decisions/08-runtime-and-team-workflows.md) | Current runtime, recovery, observability, team workflow, and managed-capacity decisions C48 through C88. |

## How to find a decision

- Search the directory: `rg "C73b|recovery" docs/decisions`.
- Start with the newest runtime and workflow choices in
  [Runtime and team workflow decisions](decisions/08-runtime-and-team-workflows.md).
- Add a new decision to the volume that owns its topic, then add a new volume
  when a file approaches roughly 1,500 lines.
- Never reuse an ID. Add a suffix if an established sequence must branch.
