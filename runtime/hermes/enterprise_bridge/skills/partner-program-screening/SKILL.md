---
name: partner-program-screening
description: Screen partner prospects and prepare cited human reviews.
version: 1.5.0
metadata:
  hermes:
    category: enterprise
    tags: [partners, screening, approvals]
    requires_tools: [mcp__agentcash__fetch, list_partner_candidates, get_partner_candidate, propose_approval]
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

1. If the run prompt contains the exact approved `mcp__agentcash__fetch` arguments, call it exactly once. Do not add, remove, or change filters, the URL, or the $0.15 cap. The enterprise pre-tool hook reserves the run's one payment allowance; the post-tool hook imports and sanitizes the successful response.
2. Call `list_partner_candidates` to see candidates collected under the enterprise's approved source policy. If the AgentCash call succeeded but no stored candidate appears, stop and report that the evidence import needs attention; do not pay for a retry.
3. Call `get_partner_candidate` for each candidate you may advance. Read the stored artifacts rather than relying on the discovery summary alone.
4. Treat `deterministic_priority` only as discovery triage. Make an independent assessment using the configured program, role, dimensions, and keywords.
5. Separate three things in the review:
   - **Evidence:** claims directly supported by cited artifact IDs.
   - **Inference:** a restrained conclusion drawn from that evidence.
   - **Gap:** anything the public evidence cannot establish, including interest, availability, consent, capacity, or commercial fit.
6. A discovered prospect has not applied. Never use `propose_request` with `kind: application` for a discovered person or organization.
7. Choose exactly one strongest candidate per run. Call `get_partner_candidate` for it. If `next_contact_call` is present, call `mcp__agentcash__fetch` with those exact arguments and read the candidate again. Continue only through the returned contact-enrichment, email-verification, and bounded verification-poll calls. Never alter the arguments, repeat a completed paid call, or enrich a second candidate.
8. When the server prompt supplies the exact outreach-draft policy, sender and reviewer context, use `propose_approval` with `approval_type: communication` and `details.draft_only: true`. Set one recipient with the stored candidate ID and name. Use only `preferred_verified_email` as the address; otherwise use null. Copy only stored phone numbers and public social profiles for human review.
9. Personalize the subject and body with cited professional evidence. Cite both the candidate artifacts and contact enrichment ID. Invite the candidate to explore or apply without claiming prior interest, approval, benefits or terms. State that approval records reviewed copy and does not send, call, text, or message anyone.
10. Stop after preparing the pending draft. A person must review the copy and choose any future delivery path separately.

## Boundaries

- Do not contact a candidate, send a message, submit an application, or imply the person or organization applied.
- Do not admit a partner, assign a role, promise benefits, approve terms, spend money, or sign anything.
- Do not use sources or credentials outside the governed enterprise tools.
- Do not cite a URL unless its stored artifact ID appears in the candidate record.
- AgentCash results are not Inbox evidence until the approved connector imports
  and stores them. Do not infer sensitive traits or make an automated decision
  about a person. Contact enrichment may store only professional emails, phones
  with provider type, and trusted LinkedIn, X/Twitter, or Facebook URLs. Never
  use personal emails, addresses, demographics, relatives, or financial data.
- Phone numbers and social profiles are review-only data. Never call, text, or
  message a candidate, and never use an unverified or accept-all email address.
- Do not lower the configured evidence threshold to fill a quota.

## Verification

Before finishing, confirm that the run enriched no more than one candidate, every proposed communication is marked draft-only and pending human review, any recipient email is the stored verified professional email, every phone and profile is stored review-only data, all evidence IDs are stored, evidence gaps are named, and no outreach or external effect occurred.
