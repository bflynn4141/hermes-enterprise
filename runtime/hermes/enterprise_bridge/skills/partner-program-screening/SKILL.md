---
name: partner-program-screening
description: Screen partner prospects and prepare cited human reviews.
version: 1.0.0
metadata:
  hermes:
    category: enterprise
    tags: [partners, screening, approvals]
    requires_tools: [list_partner_candidates, get_partner_candidate, propose_request]
    config:
      - key: partner_program.program_name
        description: Enterprise partner program name
        default: Hermes Partner Program
      - key: partner_program.role_label
        description: Role being evaluated for partner prospects
        default: Potential technical ecosystem partner
      - key: partner_program.source_purpose
        description: Approved purpose for public-source research
        default: organization_partner_research
      - key: partner_program.screening_dimensions
        description: Human-readable dimensions for the review
        default: [Track Record, Capacity, Fit]
      - key: partner_program.search_queries
        description: Approved public-source discovery queries
        default: []
      - key: partner_program.intake_urls
        description: Explicit public URLs approved for intake
        default: []
      - key: partner_program.keywords
        description: Enterprise relevance terms
        default: []
      - key: partner_program.ranking_weights
        description: Discovery triage weights
        default: {relevance: 40, activity: 25, adoption: 20, openness: 15}
      - key: partner_program.minimum_priority
        description: Minimum deterministic discovery priority
        default: 50
      - key: partner_program.lookback_days
        description: Public activity lookback window
        default: 365
      - key: partner_program.max_candidates
        description: Maximum candidates in one discovery run
        default: 5
      - key: partner_program.organization_only
        description: Limit discovery to organizations
        default: true
      - key: partner_program.no_outreach
        description: Prohibit messages and contact attempts
        default: true
      - key: partner_program.human_review_required
        description: Require a person to decide every application
        default: true
---

# Partner Program Screening

## When to Use

Use this skill when reviewing public organization evidence for the configured partner program or preparing partner applications for a human reviewer.

## Procedure

1. Call `list_partner_candidates` to see candidates collected under the enterprise's approved source policy.
2. Call `get_partner_candidate` for each candidate you may advance. Read the stored artifacts rather than relying on the discovery summary alone.
3. Treat `deterministic_priority` only as discovery triage. Make an independent assessment using the configured program, role, dimensions, and keywords.
4. Separate three things in the review:
   - **Evidence:** claims directly supported by cited artifact IDs.
   - **Inference:** a restrained conclusion drawn from that evidence.
   - **Gap:** anything the public evidence cannot establish, including interest, availability, consent, capacity, or commercial fit.
5. Use `propose_request` with `kind: application` only when the evidence is sufficient for human review. Preserve the candidate ID, source, priority, and exact stored evidence IDs required by the tool schema.
6. State the proposed role and explain Track Record, Capacity, and Fit concisely. Never convert an unknown into a positive claim.
7. Stop after preparing the pending application. A human decides whether the organization advances.

## Boundaries

- Do not contact a candidate, send a message, submit an application, or imply the organization applied.
- Do not admit a partner, assign a role, promise benefits, approve terms, spend money, or sign anything.
- Do not use sources or credentials outside the governed enterprise tools.
- Do not cite a URL unless its stored artifact ID appears in the candidate record.
- Do not lower the configured evidence threshold to fill a quota.

## Verification

Before finishing, confirm that every proposed application is pending human review, contains only stored evidence IDs, names its evidence gaps, and created no outreach or external effect.
