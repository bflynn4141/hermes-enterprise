import {
  handoffDetailSchema,
  handoffListSchema,
  type HandoffDetail,
  type HandoffInMotionItem,
  type HandoffList,
  type PartnerWorkflowHandoffV2,
  type PartnerWorkflowViewV2,
} from '@hermes/shared';
import type { QueryResultRow } from 'pg';
import type { Tx } from '../db/client.js';
import { PartnerWorkflowError } from '../partner-workflow/service.js';
import {
  PARTNER_INVOICE_REVIEW_DEFINITION,
  PARTNER_PROGRAM_MULTI_PARTY_DEFINITION,
} from '../enterprise-skills/registry.js';

export const PARTNER_INVOICES_HANDOFF_KEY = 'partner-invoices';

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
    [workspaceId, PARTNER_INVOICES_HANDOFF_KEY,
      'Partner invoices · Partnerships → Finance',
      'One governed invoice handoff. Private team context stays private; only authorized terms, confirmed invoice fields, and the final acknowledgment cross teams.',
      fromTeamId, toTeamId,
      JSON.stringify([
        { key: 'authorized_terms', label: 'Authorized terms', direction: 'forward' },
        { key: 'confirmed_invoice', label: 'Confirmed invoice fields', direction: 'forward' },
        { key: 'final_acknowledgment', label: 'Final acknowledgment', direction: 'return' },
      ]),
      JSON.stringify([
        { index: 1, owner: { team_slug: 'partnerships', kind: 'person' }, label: 'Records agreed terms with the source document', note: 'Creates a proposal for Finance' },
        { index: 2, owner: { team_slug: 'finance', kind: 'person' }, label: 'Verifies the terms and authorizes one invoice', note: 'Human decision in Inbox' },
        { index: 3, owner: { team_slug: 'partnerships', kind: 'person' }, label: 'Submits the received invoice with confirmed fields', note: 'Immutable intake' },
        { index: 4, owner: { team_slug: 'finance', kind: 'agent' }, label: 'Checks the invoice against the authorized terms and flags gaps', note: 'Evidence only · cannot approve' },
        { index: 5, owner: { team_slug: 'finance', kind: 'person' }, label: 'Approves or declines', note: 'Human decision in Inbox' },
        { index: 6, owner: { team_slug: 'finance', kind: 'person', return_team_slug: 'partnerships' }, label: 'One acknowledgment returns: invoice draft saved, or declined', note: 'No payment, email or signature' },
      ])],
  );
  const handoffId = inserted.rows[0]?.id ?? (await tx.query<{ id: string }>(
    `SELECT id FROM handoffs WHERE workspace_id=$1 AND key=$2`,
    [workspaceId, PARTNER_INVOICES_HANDOFF_KEY],
  )).rows[0]?.id;
  if (!handoffId) {
    throw new PartnerWorkflowError('workflow_not_configured', 'Could not create the partner-invoices handoff.');
  }
  return handoffId;
}

function resultKind(validationStatus: string): PartnerWorkflowHandoffV2['result_kind'] {
  if (validationStatus === 'passed') return 'checks_passed';
  if (validationStatus === 'needs_information') return 'needs_information';
  if (validationStatus === 'stale') return 'stale_source';
  if (validationStatus === 'failed') return 'failed_processing';
  return 'pending_checks';
}

function stageLabels(): Array<{ key: HandoffInMotionItem['stage']; label: string }> {
  return [
    { key: 'terms_recorded', label: 'Terms recorded' },
    { key: 'finance_verifying', label: 'Finance verifying' },
    { key: 'invoice', label: 'Invoice' },
    { key: 'decision', label: 'Decision' },
    { key: 'acknowledged', label: 'Acknowledged' },
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

function invoiceStage(handoff: PartnerWorkflowHandoffV2): HandoffInMotionItem['stage'] {
  if (handoff.outcome.acknowledgment === 'delivered'
      || handoff.outcome.human_decision === 'approved'
      || handoff.outcome.human_decision === 'declined') {
    return handoff.outcome.acknowledgment === 'delivered' ? 'acknowledged' : 'decision';
  }
  if (handoff.outcome.human_decision === 'pending') return 'decision';
  if (handoff.outcome.validation === 'passed' || handoff.outcome.agent_explanation === 'completed') return 'decision';
  if (handoff.outcome.validation !== 'queued') return 'invoice';
  return 'invoice';
}

function engagementStage(status: string): HandoffInMotionItem['stage'] {
  if (status === 'pending') return 'finance_verifying';
  return 'terms_recorded';
}

function waitingOnViewer(
  viewerRole: PartnerWorkflowViewV2['viewer_role'],
  item: HandoffInMotionItem,
): boolean {
  if (viewerRole === 'partnerships') {
    return item.stage === 'terms_recorded' && item.kind === 'engagement';
  }
  if (viewerRole === 'finance') {
    return item.stage === 'finance_verifying'
      || (item.stage === 'decision' && item.handoff?.outcome.human_decision === 'pending');
  }
  return false;
}

function buildInMotion(
  viewerRole: PartnerWorkflowViewV2['viewer_role'],
  handoffs: PartnerWorkflowHandoffV2[],
  engagements: PartnerWorkflowViewV2['engagements'],
): HandoffInMotionItem[] {
  const currentHandoffs = handoffs.filter((row) => row.current);
  const motion: HandoffInMotionItem[] = [];
  for (const engagement of engagements) {
    if (engagement.authorization_status !== 'authorized') continue;
    if (currentHandoffs.some((row) => row.partner_id === engagement.partner.id && row.engagement_reference === engagement.reference)) continue;
    const stage = engagementStage(engagement.authorization_status);
    motion.push({
      id: engagement.id,
      kind: 'engagement',
      title: `${engagement.partner.name} · ${engagement.reference}`,
      subtitle: `${engagement.input_provenance === 'sample' ? 'Sample' : 'Customer'} · ${engagement.currency} ${(engagement.authorized_total_minor / 100).toFixed(2)} · terms authorized`,
      stage,
      stages: stageStates(stage),
      handoff: null,
      engagement,
    });
  }
  for (const handoff of currentHandoffs) {
    const stage = invoiceStage(handoff);
    motion.push({
      id: handoff.id,
      kind: 'invoice',
      title: `${handoff.partner_name} · ${handoff.engagement_reference}`,
      subtitle: `${handoff.input_provenance === 'sample' ? 'Sample' : handoff.input_provenance === 'customer' ? 'Customer' : 'Unknown'} · ${handoff.invoice_currency} ${(handoff.invoice_total_minor / 100).toFixed(2)} · terms sent`,
      stage,
      stages: stageStates(stage),
      handoff,
      engagement: null,
    });
  }
  return motion.slice(0, 25);
}

function laneNotes(slug: 'partnerships' | 'finance', ready: boolean, scheduleEnabled: boolean, skillVersion: string | null): string[] {
  if (slug === 'partnerships') {
    return [
      'records terms, submits invoices',
      'prepares evidence, publishes the review',
      scheduleEnabled ? 'Partner program screening · schedule on' : 'Partner program screening · schedule off',
      skillVersion ? `${skillVersion} attested` : 'skill version unavailable',
    ];
  }
  return [
    'checks invoices, prepares evidence',
    'explains stored results only',
    scheduleEnabled ? 'Partner invoice review · schedule on' : 'Partner invoice review · schedule off',
    skillVersion ? `${skillVersion} attested` : 'skill version unavailable',
  ];
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
  const inMotion = buildInMotion(view.viewer_role, view.handoffs, view.engagements.map((row) => ({
    ...row,
    authorization_status: row.authorization_status,
  })));
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
  const inMotion = buildInMotion(view.viewer_role, view.handoffs, view.engagements.map((item) => ({
    ...item,
    authorization_status: item.authorization_status,
  })));
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

export { resultKind };
