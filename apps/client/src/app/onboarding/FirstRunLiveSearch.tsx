import { motion, useReducedMotion } from 'motion/react';
import {
  partnerScreeningSnapshotSchema,
  type PartnerCandidateSummary,
  type PartnerScreeningSnapshot,
} from '@hermes/shared';
import type { Rest } from '../../model/rest.js';
import { Glass, Icon } from '../ui/icons.js';

export type LiveSearchPhase =
  | 'idle'
  | 'searching'
  | 'awaiting_provider'
  | 'starting_iris'
  | 'screening'
  | 'complete'
  | 'error';

export interface LiveSearchView {
  phase: LiveSearchPhase;
  snapshot: PartnerScreeningSnapshot | null;
  message: string | null;
}

type RequestClient = Pick<Rest, 'request'>;

export async function startLivePartnerSearch(
  client: RequestClient,
  workspaceId: string,
  agentId: string,
  idempotencyKey: string,
): Promise<PartnerScreeningSnapshot> {
  return client.request(
    'POST',
    `/w/${encodeURIComponent(workspaceId)}/partner-screening/runs`,
    partnerScreeningSnapshotSchema,
    { agent_id: agentId, idempotency_key: idempotencyKey },
  );
}

export async function getLivePartnerSearch(
  client: RequestClient,
  workspaceId: string,
  runId: string,
): Promise<PartnerScreeningSnapshot> {
  return client.request(
    'GET',
    `/w/${encodeURIComponent(workspaceId)}/partner-screening/runs/${encodeURIComponent(runId)}`,
    partnerScreeningSnapshotSchema,
  );
}

export async function handoffLivePartnerSearch(
  client: RequestClient,
  workspaceId: string,
  runId: string,
): Promise<PartnerScreeningSnapshot> {
  return client.request(
    'POST',
    `/w/${encodeURIComponent(workspaceId)}/partner-screening/runs/${encodeURIComponent(runId)}/handoff`,
    partnerScreeningSnapshotSchema,
    {},
  );
}

function status(view: LiveSearchView, candidate: PartnerCandidateSummary): string {
  if (candidate.existing_request_id) return 'Needs review';
  if (view.phase === 'starting_iris' || view.phase === 'screening') return 'Iris screening';
  return 'Discovered';
}

function liveSummary(view: LiveSearchView): string {
  const candidates = view.snapshot?.candidates ?? [];
  const people = view.snapshot?.run.source === 'agentcash_people';
  const reviews = candidates.filter((candidate) => candidate.existing_request_id).length;
  if (view.phase === 'searching') return people ? 'Starting capped AgentCash People Search.' : 'Searching public GitHub organization evidence.';
  if (view.phase === 'awaiting_provider') return `${candidates.length} live candidates found. Connect the provider to let Iris screen them.`;
  if (view.phase === 'starting_iris' || view.phase === 'screening') return `Iris is screening ${candidates.length} live candidates. ${reviews} are in Inbox.`;
  if (view.phase === 'complete') return `Live screening finished. ${reviews} reviews are in Inbox.`;
  if (view.phase === 'error') return view.message ?? 'The live search needs attention.';
  return 'Preparing the first live partner search.';
}

export function FirstRunLiveSearch({
  view,
  onRetry,
  onOpenInbox,
}: {
  view: LiveSearchView;
  onRetry?: () => void;
  onOpenInbox?: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const candidates = view.snapshot?.candidates ?? [];
  const reviews = candidates.filter((candidate) => candidate.existing_request_id).length;
  const people = view.snapshot?.run.source === 'agentcash_people';
  const active = view.phase === 'searching' || view.phase === 'starting_iris' || view.phase === 'screening';
  const title = view.phase === 'searching'
    ? (people ? 'Starting People Search' : 'Searching public GitHub')
    : view.phase === 'awaiting_provider'
      ? 'Live search complete'
      : view.phase === 'starting_iris' || view.phase === 'screening'
        ? 'Iris is screening'
        : view.phase === 'error'
          ? 'Live search paused'
          : 'Live screening complete';
  const detail = view.phase === 'searching'
    ? (people ? 'Iris will make one AgentCash call capped at $0.15' : 'Public organization evidence is being fetched and stored')
    : view.phase === 'awaiting_provider'
      ? 'Connect Nous Portal to let Iris review the saved evidence'
      : view.phase === 'starting_iris' || view.phase === 'screening'
        ? 'Supported candidates will appear in Inbox for a human decision'
        : view.phase === 'error'
          ? (view.message ?? 'The saved evidence is still available')
          : `${reviews} review${reviews === 1 ? '' : 's'} waiting in Inbox`;

  return (
    <section className="first-run-live" aria-label="Live Partner Program search">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveSummary(view)}</p>
      <header className="first-run-live-head">
        <div>
          <span className="first-run-live-kicker"><Glass name="admission" size={27} />Hermes Partner Program</span>
          <h2>Live discovery</h2>
          <p>{people ? 'AgentCash · public professional profiles · no outreach or decisions' : 'Official GitHub API · public organizations · no outreach or decisions'}</p>
        </div>
        <button type="button" className="first-run-live-inbox" onClick={onOpenInbox} disabled={!onOpenInbox || reviews === 0}>
          <Glass name="inbox" size={23} />
          <span>Inbox</span>
          <strong aria-label={`${reviews} candidates need review`}>{reviews}</strong>
        </button>
      </header>

      <div className="first-run-live-summary" data-phase={view.phase}>
        <span className="first-run-live-orbit" aria-hidden="true"><span /></span>
        <span><strong>{title}</strong><small>{detail}</small></span>
        {view.phase === 'error' && onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}
      </div>

      {active && candidates.length === 0 ? (
        <div className="first-run-live-state">
          <span className="first-run-live-search" aria-hidden="true"><Icon name="search" size={18} /></span>
          <div><strong>Finding live partner candidates</strong><p>{people ? 'The connector permits one paid People Search call with a $0.15 ceiling.' : 'The connector has a five-request ceiling for this onboarding search.'}</p></div>
        </div>
      ) : null}

      {view.phase === 'error' && candidates.length === 0 ? (
        <div className="first-run-live-state" role="alert">
          <Icon name="info" size={18} />
          <div><strong>Couldn’t finish the live search</strong><p>{detail}</p></div>
        </div>
      ) : null}

      <div className="first-run-applications">
        {candidates.map((candidate) => (
          <motion.article
            layout
            key={candidate.id}
            className={`first-run-application ${candidate.existing_request_id ? 'is-needs_review' : 'is-researching'}`}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0.01 : 0.18 }}
          >
            <div className="first-run-application-top">
              <span className="first-run-application-avatar" aria-hidden="true">{candidate.display_name.slice(0, 1).toUpperCase()}</span>
              <span className="first-run-application-person">
                <strong>{candidate.display_name}</strong>
                <small>Discovery priority · {candidate.deterministic_priority}/100 · {candidate.confidence} confidence</small>
              </span>
              <span className="first-run-sample-pill">Live</span>
              <span className={`first-run-application-status ${candidate.existing_request_id ? 'is-needs_review' : 'is-researching'}`}>
                <span />{status(view, candidate)}
              </span>
            </div>
            <div className="first-run-application-result">
              <span>Evidence status</span>
              <strong>{candidate.evidence_gaps[0] ?? 'Public organization evidence was stored for Iris.'}</strong>
              {candidate.evidence_gaps.length > 1 ? <p>{candidate.evidence_gaps.slice(1).join(' ')}</p> : null}
              <ul aria-label={`Sources for ${candidate.display_name}`}>
                <li><a href={candidate.profile_url} target="_blank" rel="noreferrer">{candidate.source === 'agentcash_people' ? 'Professional profile' : 'GitHub organization'}<Icon name="external" size={11} /></a></li>
              </ul>
            </div>
          </motion.article>
        ))}
      </div>

      {view.phase === 'complete' ? (
        <footer className="first-run-live-foot">
          <span><Icon name="check" size={16} />Iris stopped before any decision or outreach.</span>
          <button type="button" onClick={onOpenInbox} disabled={!onOpenInbox || reviews === 0}>Review in Inbox<Icon name="arrow" size={14} /></button>
        </footer>
      ) : null}
      {view.snapshot ? <p className="first-run-live-disclosure">{view.snapshot.disclosure} {view.snapshot.budget.api_requests_used}/{view.snapshot.budget.api_requests_max} API requests used.</p> : null}
    </section>
  );
}
