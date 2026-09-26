import {
  handoffDetailSchema,
  handoffListSchema,
  type HandoffDetail,
  type HandoffInMotionItem,
  type HandoffList,
  type PartnerWorkflowViewV2,
} from '@hermes/shared';
import type { QueryResultRow } from 'pg';
import type { Tx } from '../db/client.js';
import { PartnerWorkflowError } from '../partner-workflow/errors.js';
import {
  PARTNER_INVOICE_REVIEW_DEFINITION,
  PARTNER_PROGRAM_MULTI_PARTY_DEFINITION,
} from '../enterprise-skills/registry.js';

export const CONTRACTOR_AGREEMENTS_HANDOFF_KEY = 'contractor-agreements';
/** @deprecated Use CONTRACTOR_AGREEMENTS_HANDOFF_KEY */
export const PARTNER_INVOICES_HANDOFF_KEY = CONTRACTOR_AGREEMENTS_HANDOFF_KEY;

interface HandoffRow extends QueryResultRow {
  id: string;
  key: string;
  name: string;
  description: string;
  from_team_id: string;
  to_team_id: string;
  crossing: unknown;
  steps: unknown;
  admission_state: 'disabled' | 'enabled';
  enabled_at: Date | null;
}

export async function readHandoffAdmission(
  tx: Tx,
  workspaceId: string,
  lock: 'share' | 'none' = 'share',
): Promise<{
  handoff_id: string | null;
  admission_state: 'disabled' | 'enabled';
  readiness: Record<string, {
    agent_id?: string; assignment_id?: string; assignment_revision?: number;
    skill_version?: string; artifact_digest?: string;
  }>;
}> {
  const lockClause = lock === 'share' ? ' FOR SHARE' : '';
  const row = (await tx.query<{
    id: string;
    admission_state: 'disabled' | 'enabled';
    readiness: Record<string, unknown>;
  }>(
    `SELECT id,admission_state,readiness FROM handoffs
      WHERE workspace_id=$1 AND key=$2${lockClause}`,
    [workspaceId, PARTNER_INVOICES_HANDOFF_KEY],
  )).rows[0];
  if (!row) {
    const legacy = (await tx.query<{
      handoff_id: string | null;
      admission_state: 'disabled' | 'enabled';
      readiness: Record<string, unknown>;
    }>(
      `SELECT handoff_id,admission_state,readiness FROM partner_workflow_settings WHERE workspace_id=$1${lockClause}`,
      [workspaceId],
    )).rows[0];
    return {
      handoff_id: legacy?.handoff_id ?? null,
      admission_state: legacy?.admission_state ?? 'disabled',
      readiness: (legacy?.readiness ?? {}) as HandoffDetail['readiness'][number] extends never ? never : Record<string, {
        agent_id?: string; assignment_id?: string; assignment_revision?: number;
        skill_version?: string; artifact_digest?: string;
      }>,
    };
  }
  return {
    handoff_id: row.id,
    admission_state: row.admission_state,
    readiness: row.readiness as Record<string, {
      agent_id?: string; assignment_id?: string; assignment_revision?: number;
      skill_version?: string; artifact_digest?: string;
    }>,
  };
}

export async function updateHandoffAdmission(
  tx: Tx,
  workspaceId: string,
  input: {
    admission_state: 'disabled' | 'enabled';
    enabled_by?: string | null;
    readiness?: Record<string, unknown>;
    readiness_checked_at?: Date | null;
  },
): Promise<string> {
  const updated = await tx.query<{ id: string }>(
    `UPDATE handoffs
        SET admission_state=$3,
            enabled_by=CASE WHEN $3='enabled' THEN $4 ELSE NULL END,
            enabled_at=CASE WHEN $3='enabled' THEN now() ELSE NULL END,
            readiness=COALESCE($5::jsonb, readiness),
            readiness_checked_at=CASE WHEN $3='enabled' THEN COALESCE($6, now()) ELSE readiness_checked_at END
      WHERE workspace_id=$1 AND key=$2
      RETURNING id`,
    [workspaceId, PARTNER_INVOICES_HANDOFF_KEY, input.admission_state,
      input.enabled_by ?? null, input.readiness ? JSON.stringify(input.readiness) : null,
      input.readiness_checked_at ?? null],
  );
  const id = updated.rows[0]?.id;
  if (id) return id;
  throw new PartnerWorkflowError('workflow_not_configured', 'Configure both employee role templates first.');
}

export async function ensurePartnerInvoicesHandoff(
  tx: Tx,
  workspaceId: string,
  fromTeamId: string,
  toTeamId: string,
): Promise<string> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO handoffs
       (workspace_id,key,name,description,from_team_id,to_team_id,crossing,steps,admission_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'disabled')
     ON CONFLICT (workspace_id,key) DO UPDATE SET updated_at=handoffs.updated_at
     RETURNING id`,
    [workspaceId, CONTRACTOR_AGREEMENTS_HANDOFF_KEY,
      'Contractor agreements · Partnerships → Finance',
      'After Partnerships admits an applicant, Finance reviews the independent contractor agreement. Private team context stays private; only the admitted partner identity, the agreement draft, and the final acknowledgment cross teams.',
      fromTeamId, toTeamId,
      JSON.stringify([
        { key: 'admitted_partner', label: 'Admitted partner', direction: 'forward' },
        { key: 'contractor_agreement', label: 'Contractor agreement draft', direction: 'forward' },
        { key: 'final_acknowledgment', label: 'Final acknowledgment', direction: 'return' },
      ]),
      JSON.stringify([
        { index: 1, owner: { team_slug: 'partnerships', kind: 'person' }, label: 'Screens and admits the applicant', note: 'Human decision in Inbox' },
        { index: 2, owner: { team_slug: 'partnerships', kind: 'person' }, label: 'Prepares the independent contractor agreement', note: 'Draft for Finance review' },
        { index: 3, owner: { team_slug: 'finance', kind: 'agent' }, label: 'Prepares agreement evidence for the reviewer', note: 'Evidence only · cannot approve' },
        { index: 4, owner: { team_slug: 'finance', kind: 'person' }, label: 'Approves or declines the contractor agreement', note: 'Human decision in Inbox' },
        { index: 5, owner: { team_slug: 'finance', kind: 'person', return_team_slug: 'partnerships' }, label: 'One acknowledgment returns: agreement draft saved, or declined', note: 'Nothing is signed, paid, or sent' },
      ])],
  );
  const handoffId = inserted.rows[0]?.id ?? (await tx.query<{ id: string }>(
    `SELECT id FROM handoffs WHERE workspace_id=$1 AND key=$2`,
    [workspaceId, CONTRACTOR_AGREEMENTS_HANDOFF_KEY],
  )).rows[0]?.id;
  if (!handoffId) {
    throw new PartnerWorkflowError('workflow_not_configured', 'Could not create the contractor-agreements handoff.');
  }
  return handoffId;
}

function stageLabels(): Array<{ key: HandoffInMotionItem['stage']; label: string }> {
  return [
    { key: 'terms_recorded', label: 'Admit' },
    { key: 'finance_verifying', label: 'Prep' },
    { key: 'invoice', label: 'Review' },
    { key: 'decision', label: 'Decide' },
    { key: 'acknowledged', label: 'Done' },
  ];
}

function stageStates(current: HandoffInMotionItem['stage']): HandoffInMotionItem['stages'] {
  const order = stageLabels().map((item) => item.key);
  const index = order.indexOf(current);
  return stageLabels().map((item, idx) => ({
    key: item.key,
    label: item.label,
    state: idx < index ? 'done' : idx === index ? 'current' : 'pending',
  }));
}

function waitingOnViewer(
  viewerRole: PartnerWorkflowViewV2['viewer_role'],
  item: HandoffInMotionItem,
): boolean {
  if (viewerRole === 'partnerships') return item.stage === 'terms_recorded';
  if (viewerRole === 'finance') return item.stage === 'invoice' || item.stage === 'decision';
  return false;
}

interface MotionRequestRow {
  id: string;
  kind: 'application' | 'agreement';
  status: string;
  label: string;
  source_application_id: string | null;
  updated_at: Date;
}

function contractorStage(
  applicationStatus: string | null,
  agreementStatus: string | null,
): HandoffInMotionItem['stage'] {
  if (applicationStatus === 'pending') return 'terms_recorded';
  if (applicationStatus === 'declined') return 'acknowledged';
  if (!agreementStatus || agreementStatus === 'pending') return 'decision';
  return 'acknowledged';
}

async function buildInMotion(
  tx: Tx,
  workspaceId: string,
  viewerRole: PartnerWorkflowViewV2['viewer_role'],
): Promise<HandoffInMotionItem[]> {
  if (viewerRole === 'unrelated') return [];

  const applications = await tx.query<MotionRequestRow>(
    `SELECT id, kind, status, label,
            NULL::text AS source_application_id, updated_at
       FROM requests
      WHERE workspace_id=$1 AND kind='application'
        AND status IN ('pending','admitted','declined')
      ORDER BY updated_at DESC
      LIMIT 25`,
    [workspaceId],
  );
  const agreements = await tx.query<MotionRequestRow>(
    `SELECT id, kind, status, label,
            payload #>> '{workflow_provenance,source_application_id}' AS source_application_id,
            updated_at
       FROM requests
      WHERE workspace_id=$1 AND kind='agreement'
        AND subject_key LIKE 'partner-contractor-agreement:%'
        AND status IN ('pending','drafted','declined')
      ORDER BY updated_at DESC
      LIMIT 25`,
    [workspaceId],
  );

  const byApplication = new Map<string, MotionRequestRow>();
  for (const row of agreements.rows) {
    if (row.source_application_id && !byApplication.has(row.source_application_id)) {
      byApplication.set(row.source_application_id, row);
    }
  }

  const items: HandoffInMotionItem[] = [];
  const seenAgreements = new Set<string>();

  for (const application of applications.rows) {
    const agreement = byApplication.get(application.id) ?? null;
    if (agreement) seenAgreements.add(agreement.id);
    // A handoff starts at admission. Pending or declined applications are
    // Partnerships' business and stay in Inbox until someone is admitted.
    if (application.status !== 'admitted' || !agreement) continue;
    if (agreement && agreement.status !== 'pending') continue;

    const stage = contractorStage(application.status, agreement?.status ?? null);
    if (stage === 'acknowledged') continue;
    const openRequestId = stage === 'terms_recorded'
      ? application.id
      : agreement && (stage === 'decision' || stage === 'invoice')
        ? agreement.id
        : agreement?.id ?? application.id;

    items.push({
      id: agreement?.id ?? application.id,
      kind: agreement ? 'agreement' : 'application',
      title: application.label.slice(0, 240) || 'Partner',
      subtitle: stage === 'terms_recorded' ? 'Awaiting admission'
        : stage === 'decision' ? 'Agreement ready for review'
          : agreement?.status === 'declined' ? 'Declined'
            : 'Done',
      stage,
      stages: stageStates(stage),
      handoff: null,
      engagement: null,
      open_request_id: openRequestId,
    });
    if (items.length >= 25) break;
  }

  if (items.length < 25) {
    for (const agreement of agreements.rows) {
      if (seenAgreements.has(agreement.id)) continue;
      if (agreement.status !== 'pending') continue;
      const stage = 'decision' as const;
      items.push({
        id: agreement.id,
        kind: 'agreement',
        title: agreement.label.slice(0, 240) || 'Agreement',
        subtitle: 'Agreement ready for review',
        stage,
        stages: stageStates(stage),
        handoff: null,
        engagement: null,
        open_request_id: agreement.id,
      });
      if (items.length >= 25) break;
    }
  }

  return items;
}

function laneNotes(slug: 'partnerships' | 'finance', ready: boolean, scheduleEnabled: boolean, skillVersion: string | null): string[] {
  if (slug === 'partnerships') {
    return ['Admit', 'Iris', scheduleEnabled ? 'On' : 'Off', skillVersion ?? '—'];
  }
  return ['Review', 'Ledger', scheduleEnabled ? 'On' : 'Off', skillVersion ?? '—'];
}

export async function loadHandoffsList(
  tx: Tx,
  workspaceId: string,
  userId: string,
  view: PartnerWorkflowViewV2,
): Promise<HandoffList> {
  const rows = await tx.query<HandoffRow & {
    from_slug: string; from_name: string; to_slug: string; to_name: string;
  }>(
    `SELECT h.*, ft.slug AS from_slug, ft.name AS from_name, tt.slug AS to_slug, tt.name AS to_name
       FROM handoffs h
       JOIN enterprise_teams ft ON ft.workspace_id=h.workspace_id AND ft.id=h.from_team_id
       JOIN enterprise_teams tt ON tt.workspace_id=h.workspace_id AND tt.id=h.to_team_id
      WHERE h.workspace_id=$1
      ORDER BY h.key`,
    [workspaceId],
  );
  const inMotion = await buildInMotion(tx, workspaceId, view.viewer_role);
  const waiting = inMotion.filter((item) => waitingOnViewer(view.viewer_role, item)).length;
  return handoffListSchema.parse(rows.rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    from_team: { id: row.from_team_id, slug: row.from_slug, name: row.from_name },
    to_team: { id: row.to_team_id, slug: row.to_slug, name: row.to_name },
    admission_state: row.admission_state,
    viewer_role: view.viewer_role,
    counts: { in_motion: inMotion.length, waiting_on_viewer: waiting },
  })));
}

export async function loadHandoffDetail(
  tx: Tx,
  workspaceId: string,
  handoffId: string,
  view: PartnerWorkflowViewV2,
): Promise<HandoffDetail> {
  const row = (await tx.query<HandoffRow>(
    `SELECT * FROM handoffs WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, handoffId],
  )).rows[0];
  if (!row) throw new PartnerWorkflowError('handoff_not_found', 'That handoff is not available in this workspace.');
  const inMotion = await buildInMotion(tx, workspaceId, view.viewer_role);
  const waiting = inMotion.filter((item) => waitingOnViewer(view.viewer_role, item)).length;
  const expectedDefinitions = {
    partnerships: PARTNER_PROGRAM_MULTI_PARTY_DEFINITION,
    finance: PARTNER_INVOICE_REVIEW_DEFINITION,
  } as const;
  const lanes = (['partnerships', 'finance'] as const).map((slug) => {
    const agent = view.agents.find((item) => item.team.slug === slug);
    const readiness = view.readiness.find((item) => item.role === slug);
    const ready = Boolean(readiness?.native_status === 'ready' && readiness.assignment_state === 'active');
    return {
      team: agent?.team ?? { id: slug === 'partnerships' ? row.from_team_id : row.to_team_id, slug, name: slug === 'partnerships' ? 'Partnerships' : 'Finance' },
      person: agent?.principal_name ?? null,
      agent: agent?.name ?? null,
      agent_id: agent?.id ?? null,
      skill: agent?.skill_name ?? null,
      readiness: readiness ?? {
        role: slug,
        configured: false,
        assignment_state: 'missing',
        native_status: 'unknown',
        skill_key: expectedDefinitions[slug].key,
        skill_version: null,
        artifact_digest: null,
        missing: ['principal', 'agent', 'assignment', 'skill', 'tools', 'provider'],
      },
      notes: laneNotes(slug, ready, agent?.schedule_enabled === true, agent?.skill_version ?? null),
    };
  });
  return handoffDetailSchema.parse({
    handoff: {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      admission_state: row.admission_state,
      enabled_at: row.enabled_at?.toISOString() ?? null,
      viewer_role: view.viewer_role,
    },
    lanes,
    crossing: row.crossing,
    steps: row.steps,
    actions: view.actions,
    configured: view.configured,
    readiness: view.readiness,
    partner_options: view.partner_options,
    engagements: view.engagements,
    in_motion: inMotion,
    connector: view.connector,
    counts: { in_motion: inMotion.length, waiting_on_viewer: waiting },
  });
}
