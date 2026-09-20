-- Governed Library sources are workspace-owned, immutable by version, and
-- visible only through explicit Enterprise-team grants. They are separate
-- from agent_files: sharing a guide must not copy it into private agent state.

CREATE TABLE IF NOT EXISTS library_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  slug          text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary       text NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_sources_workspace_slug_key UNIQUE (workspace_id, slug),
  CONSTRAINT library_sources_workspace_id_key UNIQUE (workspace_id, id)
);
DROP TRIGGER IF EXISTS library_sources_updated_at ON library_sources;
CREATE TRIGGER library_sources_updated_at BEFORE UPDATE ON library_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS library_source_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  source_id        uuid NOT NULL,
  version          integer NOT NULL CHECK (version > 0),
  version_label    text NOT NULL CHECK (length(version_label) BETWEEN 1 AND 40),
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content_markdown text NOT NULL CHECK (length(content_markdown) BETWEEN 1 AND 50000),
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_source_versions_source_fk FOREIGN KEY (workspace_id, source_id)
    REFERENCES library_sources (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT library_source_versions_number_key UNIQUE (source_id, version),
  CONSTRAINT library_source_versions_sha_key UNIQUE (source_id, sha256)
);

CREATE OR REPLACE FUNCTION prevent_library_source_version_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'library source versions are immutable';
END
$$;
DROP TRIGGER IF EXISTS library_source_versions_immutable ON library_source_versions;
CREATE TRIGGER library_source_versions_immutable BEFORE UPDATE ON library_source_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_library_source_version_update();

CREATE TABLE IF NOT EXISTS library_source_team_grants (
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  source_id     uuid NOT NULL,
  team_id       uuid NOT NULL,
  granted_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, source_id, team_id),
  CONSTRAINT library_source_team_grants_source_fk FOREIGN KEY (workspace_id, source_id)
    REFERENCES library_sources (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT library_source_team_grants_team_fk FOREIGN KEY (workspace_id, team_id)
    REFERENCES enterprise_teams (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS library_source_team_grants_team_idx
  ON library_source_team_grants (workspace_id, team_id, source_id);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'library_sources', 'library_source_versions', 'library_source_team_grants'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())',
      table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ensure_partner_program_guide(p_workspace_id uuid, p_actor_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  guide_source_id uuid;
  request_workspace_setting text := NULLIF(current_setting('app.workspace_id', true), '');
  request_workspace uuid := request_workspace_setting::uuid;
BEGIN
  IF request_workspace IS NOT NULL AND request_workspace <> p_workspace_id THEN
    RAISE EXCEPTION 'workspace boundary violation';
  END IF;
  IF request_workspace IS NULL THEN
    PERFORM set_config('app.workspace_id', p_workspace_id::text, true);
  END IF;

  SELECT id INTO guide_source_id
    FROM library_sources
   WHERE workspace_id=p_workspace_id AND slug='partner-program-guide';

  IF guide_source_id IS NULL THEN
    INSERT INTO library_sources (workspace_id,slug,title,summary,created_by)
    VALUES (
      p_workspace_id,
      'partner-program-guide',
      'Partner Program Guide',
      'Shared operating guide for partner research, engagement authorization, invoice intake, and Finance review.',
      p_actor_id
    )
    RETURNING id INTO guide_source_id;
  END IF;

  INSERT INTO library_source_versions
    (workspace_id,source_id,version,version_label,sha256,content_markdown,created_by)
  VALUES (
    p_workspace_id,
    guide_source_id,
    1,
    '0.1 draft',
    '10cca5f27ed6111c62c036ee68cc5aa96fe9ccb9e0ad4e1e590eb3d30b8cc05e',
    $guide$# Partner Program Guide

Version: 0.1 · Draft for review  
Intended audience: Partnerships and Finance employees and their assigned agents  
Proposed document owner: Partnerships, with Finance reviewing engagement and invoice sections  
Publication status: Published internally as a governed Library source for Partnerships and Finance; remains a draft pending program-owner review

## Purpose

This guide gives Partnerships and Finance a shared understanding of how a prospective partner moves from research to a reviewed engagement and invoice. It describes the existing Hermes workflow and identifies the business decisions still needed to complete the program.

The guide is reference material. Authority for a particular engagement comes from its recorded human approval and current terms.

## Program facts to establish

The working name is **Hermes Partner Program**. The following details need confirmation by the program owner before anyone presents them as an offer:

| Topic | Current status |
| --- | --- |
| Program objective and target partners | To be confirmed |
| Eligibility and acceptance criteria | To be confirmed; search filters and ranking scores are research aids |
| Partner benefits and our commitments | No standard benefits established in the reviewed sources |
| Partner responsibilities and deliverables | Defined in each approved engagement |
| Standard rates, commissions, discounts, or referral fees | No standard commercial terms established in the reviewed sources |
| Payment timing and method | To be confirmed separately from invoice review |
| Named program owner and Finance reviewer | Use the current workspace role assignments |

Until these decisions are recorded, outreach drafts should invite a conversation without promising admission, benefits, compensation, or commercial terms.

## Shared vocabulary

| Term | Meaning |
| --- | --- |
| Prospect | A person or organization identified through research. Discovery does not mean they applied or expressed interest. |
| Evidence | A stored source supporting a specific claim, with enough provenance for a reviewer to inspect it. |
| Assessment | A conclusion based on evidence. Interest, availability, capacity, and commercial fit may remain unknown. |
| Outreach draft | Proposed communication awaiting human review. Approving the draft records reviewed copy; it does not send it. |
| Authorized engagement | Exact terms approved by the designated human reviewer, including partner, reference, purpose, amount, currency, and validity dates. |
| Confirmed invoice intake | The received invoice and verified fields recorded against an authorized engagement. |
| Finance handoff | The permitted evidence and invoice information passed to Finance for review. |
| Saved invoice | The document retained after human review. Its saved status does not mean it has been paid or sent. |

## Responsibilities

**Partnerships** owns prospect research, evidence quality, proposed communication, proposed engagement terms, and confirmation of invoice inputs. Its agent prepares evidence and drafts for people to review.

**Finance** reviews engagement authorization and the invoice against the approved terms and supporting evidence. Its agent explains the recorded checks and identifies gaps. The designated Finance employee records the decision.

**Workspace administration** maintains employee and agent assignments and workflow availability. An administrative role does not by itself grant access to private team content.

## From prospect to invoice

1. **Research a prospect.** Use the sources available to the assigned agent. Separate supported facts, inferences, and missing information. A ranking score helps order research; it does not establish partner eligibility or acceptance.
2. **Prepare a human review.** Include the prospect’s identity, why they may fit, cited evidence, and unresolved questions. Prepare any outreach as a draft. Delivery requires its own authorized path.
3. **Record engagement terms.** Identify the partner, engagement reference, purpose, amount, currency, validity dates, and supporting source. The designated Finance reviewer approves the exact terms. An unsigned agreement or outreach approval does not establish an authorized engagement.
4. **Confirm the received invoice.** Check its fields against the source document and link it to the approved engagement. The current workflow supports one invoice lineage per authorization; a correction replaces an earlier revision within that lineage.
5. **Hand off to Finance.** Finance receives the permitted evidence and invoice information. The workflow checks duplicates, matching terms, currency, amount, evidence, and current authorization before preparing a review.
6. **Record the human decision.** Finance reviews the exact version presented. A successful review saves an invoice draft and returns a bounded acknowledgment to Partnerships. Payment, signature, and delivery remain separate actions.

## What makes a handoff ready

Partnerships should be able to provide:

- The correct partner identity and engagement reference.
- Current, human-approved terms with amount, currency, purpose, and valid dates.
- The supporting engagement source and the excerpt permitted for Finance.
- The received invoice source and confirmed invoice fields, including number, parties, dates, line items, and total.
- Clear identification of customer input or demonstration data.
- Any unresolved discrepancy and the revision being corrected, if applicable.

If a required fact or source is missing, the handoff needs clarification. Agents should describe the gap rather than supply an assumed amount, term, recipient, or approval.

## Information shared between teams

Both teams may reference this guide and the approved engagement information needed for their work. A case handoff shares the permitted evidence and status required by the receiving team.

Partnerships research and private conversations remain within their existing access scope. Finance review notes, invoices, and private conversations retain theirs. A shared guide does not broaden access to those records.

For example, Partnerships can learn that an invoice review was completed through its acknowledgment without receiving the Finance conversation or internal review notes.

## Sources, changes, and exceptions

When answering from this guide, identify it as **Partner Program Guide v0.1, draft**. Cite the relevant engagement or invoice record for case-specific claims. If this guide conflicts with recorded terms, flag the discrepancy and ask the responsible human to resolve it.

Changes to engagement terms or evidence may require a fresh review. Keep earlier versions available in the audit history and clearly identify the current version. Demonstration inputs must remain labeled as demonstration data even when a real agent processes them.

Suggested maintenance: Partnerships maintains the guide; Finance reviews changes affecting authorization, invoice requirements, or payment language. Record a new version and reviewer when program facts or responsibilities change.

## Basis for this draft

Prepared from the repository’s Partnerships + Finance workflow, enterprise skill documentation, and Partnerships screening procedure at commit `f40ddc91892e15cd3482d80ef5b9a864febf0d90`. These establish the implemented workflow; they do not establish approved commercial policy or verify current live workspace configuration.

- `docs/PARTNER-FINANCE-WORKFLOW.md`
- `docs/ENTERPRISE-SKILLS.md`
- `runtime/hermes/enterprise_bridge/skills/partner-program-screening-v1-8/SKILL.md`
- `apps/worker/src/partner-screening/config.ts`
$guide$,
    p_actor_id
  )
  ON CONFLICT (source_id, version) DO NOTHING;

  INSERT INTO library_source_team_grants (workspace_id,source_id,team_id,granted_by)
  SELECT p_workspace_id,guide_source_id,t.id,p_actor_id
    FROM enterprise_teams t
   WHERE t.workspace_id=p_workspace_id AND t.slug IN ('partnerships','finance')
  ON CONFLICT (workspace_id,source_id,team_id) DO NOTHING;

  IF request_workspace_setting IS NULL THEN
    PERFORM set_config('app.workspace_id', '', true);
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION ensure_partner_program_guide(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_partner_program_guide(uuid,uuid) TO app;
GRANT SELECT ON library_sources, library_source_versions, library_source_team_grants TO app;
REVOKE ALL ON library_sources, library_source_versions, library_source_team_grants FROM agent;

ALTER TABLE enterprise_teams NO FORCE ROW LEVEL SECURITY;
DO $seed$
DECLARE row record;
BEGIN
  FOR row IN SELECT DISTINCT workspace_id FROM enterprise_teams WHERE slug IN ('partnerships','finance') LOOP
    PERFORM ensure_partner_program_guide(row.workspace_id, NULL);
  END LOOP;
END
$seed$;
ALTER TABLE enterprise_teams FORCE ROW LEVEL SECURITY;
