import { approvalEvidenceViewSchema, approvalPayloadSchema, type ApprovalEvidenceView } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { RouteError } from '../routes/tenant.js';

const unavailable = (): never => {
  throw new RouteError('This approval has no available stored evidence with that id.', 'approval_evidence_unavailable', 404);
};

/** Public source links only. This is not a fetch/proxy and never consumes proposal.ref. */
export function approvalEvidenceSourceUrl(value: unknown, source: string): string | null {
  if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0020\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    const path = url.pathname;
    const githubName = '[A-Za-z0-9_.-]+';
    const isGithub = source === 'github' && (
      (host === 'github.com' && new RegExp(`^/${githubName}(?:/${githubName})?/?$`, 'u').test(path))
      || (host === 'api.github.com' && (new RegExp(`^/orgs/${githubName}(?:/repos)?/?$`, 'u').test(path) || path === '/search/repositories'))
    );
    const isLinkedIn = ['agentcash_people', 'agentcash_creators'].includes(source)
      && ['linkedin.com', 'www.linkedin.com'].includes(host)
      && (/^\/in\/[A-Za-z0-9_%.-]+\/?$/u.test(path)
        || (source === 'agentcash_creators' && /^\/(?:posts|pulse)\/[A-Za-z0-9_%.-]+\/?$/u.test(path)));
    const youtube = source === 'agentcash_creators' && ['youtube.com', 'www.youtube.com'].includes(host);
    const videoId = url.searchParams.get('v');
    const isWatch = youtube && path === '/watch' && videoId !== null && /^[A-Za-z0-9_-]{11}$/u.test(videoId);
    const isYoutube = youtube && (isWatch || /^\/(?:@[A-Za-z0-9_.-]+|(?:channel|c)\/[A-Za-z0-9_-]+|shorts\/[A-Za-z0-9_-]{11})\/?$/u.test(path));
    const isX = source === 'agentcash_creators'
      && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host)
      && /^\/[A-Za-z0-9_]{1,30}(?:\/status\/\d{1,30})?\/?$/u.test(path);
    if (!isGithub && !isLinkedIn && !isYoutube && !isX) return null;
    const originalParams = new URLSearchParams(url.search);
    url.search = '';
    url.hash = '';
    if (isX) url.hostname = 'x.com';
    if (isWatch) url.searchParams.set('v', videoId!);
    if (isGithub && host === 'api.github.com') {
      for (const key of ['q', 'type', 'sort', 'direction', 'per_page']) {
        const parameter = originalParams.get(key);
        if (parameter !== null) url.searchParams.set(key, parameter);
      }
    }
    return url.toString();
  } catch { return null; }
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Explicit fact allowlist; no raw JSON, contact lists, nested URLs or runtime data. */
export function partnerSourceFacts(source: string, content: unknown): ApprovalEvidenceView['facts'] {
  const record = object(content);
  const facts: ApprovalEvidenceView['facts'] = [];
  const add = (label: string, value: unknown): void => {
    const text = typeof value === 'string' ? value.trim().slice(0, 2000) : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    if (text && facts.length < 40) facts.push({ label, value: text });
  };
  if (source === 'agentcash_people') {
    add('Name', record.full_name);
    add('Headline', record.headline);
    add('Professional background', record.description);
    add('Skills', Array.isArray(record.skills) ? record.skills.filter((skill): skill is string => typeof skill === 'string').slice(0, 50).join(', ') : null);
    const employment = object(record.current_employment);
    const company = object(record.company);
    add('Current role', employment.title);
    add('Role details', employment.description);
    add('Company', company.name);
    add('Company description', company.description);
  } else if (source === 'agentcash_creators') {
    add('Creator', record.creator_name);
    add('Platform', record.platform);
    add('Title', record.title);
    add('Author', record.author);
    add('Summary', record.summary);
    add('Excerpt', record.excerpt);
    if (Array.isArray(record.highlights)) record.highlights.slice(0, 8).forEach((value) => add('Highlight', value));
  } else if (source === 'github') {
    add('Organization', record.name ?? record.login ?? record.organization_login);
    add('Description', record.description);
    add('Evidence scope', record.evidence_scope);
    add('Public repositories', record.public_repos);
    if (Array.isArray(record.repositories)) {
      record.repositories.slice(0, 10).forEach((value) => {
        const repository = object(value);
        add('Repository', repository.full_name ?? repository.name);
        add('Repository description', repository.description);
        add('Stars', repository.stargazers_count);
      });
    }
  }
  return facts;
}

/** Caller must use inWorkspace. Evidence shares approval visibility, never session visibility. */
export async function getApprovalEvidence(tx: Tx, workspaceId: string, requestId: string, evidenceId: string): Promise<ApprovalEvidenceView> {
  // Hold the current revision stable until the evidence read commits. In particular,
  // an old citation cannot race a revision that removed it from the approval.
  const approval = (await tx.query<{
    payload: unknown; requester_agent_id: string; source_run_id: string | null;
    authorization_revision: number; authorization_hash: string;
  }>(
    `SELECT r.payload, ar.requester_agent_id, ar.source_run_id, ar.authorization_revision, ar.authorization_hash
       FROM approval_requests ar
       JOIN requests r ON r.id=ar.request_id AND r.workspace_id=ar.workspace_id
      WHERE ar.workspace_id=$1 AND ar.request_id=$2
      FOR SHARE OF ar, r`, [workspaceId, requestId],
  )).rows[0];
  if (!approval) return unavailable();
  const parsed = approvalPayloadSchema.safeParse(approval.payload);
  if (!parsed.success) return unavailable();
  const payload = parsed.data;
  if (payload.approval_type !== 'communication' || !payload.details.draft_only || payload.illustrative
      || payload.details.recipients.length !== 1
      || payload.policy.key !== `partner-outreach-draft-${approval.requester_agent_id}`
      || payload.context.requester.agent_id !== approval.requester_agent_id
      || payload.authorization.hash !== approval.authorization_hash
      || payload.authorization.revision !== approval.authorization_revision
      || payload.context.source.run_id !== approval.source_run_id) return unavailable();
  const evidence = payload.evidence.find((item) => item.id === evidenceId && ['artifact', 'source'].includes(item.kind));
  const recipient = payload.details.recipients[0]!;
  if (!evidence || !recipient.candidate_id) return unavailable();
  const base = { id: evidenceId, label: evidence.label, note: evidence.note ?? null };

  const artifact = (await tx.query<{
    source: string; source_url: string; source_updated_at: Date | null; fetched_at: Date;
    sha256: string; content: unknown;
  }>(
    `SELECT a.source, a.source_url, a.source_updated_at, a.fetched_at, a.sha256, a.content
       FROM partner_source_artifacts a
       JOIN partner_screening_runs discovery ON discovery.id=a.run_id AND discovery.workspace_id=a.workspace_id
       JOIN partner_screening_run_candidates rc ON rc.run_id=a.run_id AND rc.workspace_id=a.workspace_id
         AND a.id=ANY(rc.artifact_ids)
       JOIN partner_candidates c ON c.id=rc.candidate_id AND c.workspace_id=rc.workspace_id
      WHERE a.workspace_id=$1 AND a.id=$2 AND c.id=$3 AND c.agent_id=$4 AND discovery.agent_id=$4
        AND a.source=c.source AND a.source=discovery.source
      LIMIT 1`, [workspaceId, evidenceId, recipient.candidate_id, approval.requester_agent_id],
  )).rows[0];
  if (artifact) {
    const content = object(artifact.content);
    return approvalEvidenceViewSchema.parse({
      ...base, kind: 'partner_source',
      source_url: approvalEvidenceSourceUrl(artifact.source_url, artifact.source)
        ?? approvalEvidenceSourceUrl(content.professional_profile && object(content.professional_profile).url, artifact.source)
        ?? approvalEvidenceSourceUrl(content.creator_profile_url ?? content.html_url, artifact.source),
      fetched_at: artifact.fetched_at.toISOString(), source_updated_at: artifact.source_updated_at?.toISOString() ?? null,
      verified_at: null, sha256: artifact.sha256, facts: partnerSourceFacts(artifact.source, artifact.content),
    });
  }
  // Contact evidence is runtime-run scoped, unlike discovery artifacts. No "latest"
  // lookup here: the cited record must belong to this candidate and proposing run.
  if (evidence.kind !== 'artifact' || !approval.source_run_id) return unavailable();
  const contact = (await tx.query<{
    status: string; preferred_email: string | null; verification_status: string | null;
    verification_score: string | null; draft_eligible: boolean;
    fetched_at: Date | null; verified_at: Date | null;
  }>(
    `SELECT e.status, e.preferred_email, e.verification_status, e.verification_score,
            e.draft_eligible, e.fetched_at, e.verified_at
       FROM partner_contact_enrichments e
       JOIN partner_candidates c ON c.id=e.candidate_id AND c.workspace_id=e.workspace_id AND c.agent_id=e.agent_id
       JOIN runs r ON r.id=e.run_id AND r.workspace_id=e.workspace_id AND r.agent_id=e.agent_id
      WHERE e.workspace_id=$1 AND e.id=$2 AND e.candidate_id=$3 AND e.agent_id=$4 AND e.run_id=$5`,
    [workspaceId, evidenceId, recipient.candidate_id, approval.requester_agent_id, approval.source_run_id],
  )).rows[0];
  if (!contact || (recipient.address !== null && (!contact.draft_eligible || recipient.address !== contact.preferred_email))) return unavailable();
  const facts: ApprovalEvidenceView['facts'] = [{ label: 'Stored record status', value: contact.status }];
  if (recipient.address) facts.push({ label: 'Reviewed recipient', value: recipient.address });
  if (contact.verification_status) facts.push({ label: 'Email verification', value: contact.verification_status });
  if (contact.verification_score !== null) facts.push({ label: 'Verification score', value: String(contact.verification_score) });
  facts.push({ label: 'Eligible for draft', value: contact.draft_eligible ? 'Yes' : 'No' });
  return approvalEvidenceViewSchema.parse({
    ...base, kind: 'contact_verification', source_url: null,
    fetched_at: contact.fetched_at?.toISOString() ?? null, source_updated_at: null,
    verified_at: contact.verified_at?.toISOString() ?? null, sha256: null, facts,
  });
}
