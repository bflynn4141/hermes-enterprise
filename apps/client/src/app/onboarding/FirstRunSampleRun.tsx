import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  onboardingSampleSnapshotSchema,
  type OnboardingSampleApplication,
  type OnboardingSampleSnapshot,
} from '@hermes/shared';
import type { Rest } from '../../model/rest.js';
import { Glass, Icon } from '../ui/icons.js';

export type SampleApplicationStatus = 'received' | 'researching' | 'screened' | 'needs_review';
export type SampleRunStatus = 'starting' | 'running' | 'completed' | 'failed';

export interface SampleSource {
  id: string;
  label: string;
  url: string | null;
}

export interface SampleEvidence {
  id: string;
  claim: string;
  sourceIds: readonly string[];
}

export interface SampleApplication {
  id: string;
  requestId: string | null;
  name: string;
  detail: string | null;
  status: SampleApplicationStatus;
  summary: string | null;
  evidence: readonly SampleEvidence[];
  sources: readonly SampleSource[];
}

export interface SampleRunEvent {
  id: string;
  kind: string;
  applicationId: string | null;
  createdAt: string | null;
}

export interface SampleRunSnapshot {
  runId: string;
  status: SampleRunStatus;
  applications: readonly SampleApplication[];
  events: readonly SampleRunEvent[];
  cursor: string | null;
  error: string | null;
  nextPollMs: number;
}

export type SampleRunPhase = 'idle' | 'starting' | 'resuming' | 'running' | 'complete' | 'error';

export interface SampleRunView {
  phase: SampleRunPhase;
  snapshot: SampleRunSnapshot | null;
  message: string | null;
}

type RequestClient = Pick<Rest, 'request'>;
function normalizeApplication(application: OnboardingSampleApplication): SampleApplication {
  return {
    id: application.id,
    requestId: application.request_id,
    name: application.display_name,
    detail: application.score === null ? 'Hermes Partner Program' : `Sample score · ${application.score}`,
    status: application.state,
    summary: application.takeaway,
    evidence: application.evidence.map((item, index) => ({
      id: `${application.id}-evidence-${index}`,
      claim: `${item.label}: ${item.summary}`,
      sourceIds: application.sources.map((source) => source.id),
    })),
    sources: application.sources.map((source) => ({ id: source.id, label: source.name, url: null })),
  };
}

export function normalizeSampleRun(value: unknown): SampleRunSnapshot {
  const snapshot: OnboardingSampleSnapshot = onboardingSampleSnapshotSchema.parse(value);
  return {
    runId: snapshot.run.id,
    status: snapshot.run.status,
    applications: snapshot.applications.map(normalizeApplication),
    events: snapshot.events.map((event) => ({
      id: event.id,
      kind: event.kind,
      applicationId: event.application_id,
      createdAt: event.at,
    })),
    cursor: snapshot.cursor.head,
    error: null,
    nextPollMs: snapshot.next_poll_ms ?? 1_200,
  };
}

export async function startSampleRun(client: RequestClient, workspaceId: string, agentId: string, setupAttemptId: string): Promise<SampleRunSnapshot> {
  const response = await client.request(
    'POST',
    `/w/${encodeURIComponent(workspaceId)}/onboarding/sample-runs`,
    onboardingSampleSnapshotSchema,
    { agent_id: agentId, setup_attempt_id: setupAttemptId },
  );
  return normalizeSampleRun(response);
}

export async function getSampleRun(client: RequestClient, workspaceId: string, runId: string): Promise<SampleRunSnapshot> {
  const response = await client.request(
    'GET',
    `/w/${encodeURIComponent(workspaceId)}/onboarding/sample-runs/${encodeURIComponent(runId)}?after=0`,
    onboardingSampleSnapshotSchema,
  );
  return normalizeSampleRun(response);
}

const STATUS_LABEL: Record<SampleApplicationStatus, string> = {
  received: 'Received',
  researching: 'Researching',
  screened: 'Screened',
  needs_review: 'Needs review',
};

function liveSummary(view: SampleRunView): string {
  if (view.phase === 'starting') return 'Starting the sample screening run.';
  if (view.phase === 'resuming') return 'Resuming the sample screening run.';
  if (view.phase === 'error') return view.message ?? 'The sample screening run needs attention.';
  const applications = view.snapshot?.applications ?? [];
  const reviews = applications.filter((application) => application.status === 'needs_review').length;
  if (view.phase === 'complete') return `${applications.length} sample applications screened. ${reviews} need review.`;
  if (applications.length === 0) return 'Looking for the first sample application.';
  const latest = applications[applications.length - 1];
  return `${applications.length} sample applications found. ${latest?.name ?? 'The latest application'} is ${latest ? STATUS_LABEL[latest.status].toLowerCase() : 'updating'}. ${reviews} need review.`;
}

export function FirstRunSampleRun({ view, onRetry, onOpenInbox }: { view: SampleRunView; onRetry?: () => void; onOpenInbox?: () => void }) {
  const reduceMotion = useReducedMotion() ?? false;
  const snapshot = view.snapshot;
  const applications = snapshot?.applications ?? [];
  const needsReview = applications.filter((application) => application.status === 'needs_review').length;
  const transition = reduceMotion ? { duration: 0.01 } : { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <section className="first-run-live" aria-label="Sample Partner Program applications">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveSummary(view)}</p>
      <header className="first-run-live-head">
        <div>
          <span className="first-run-live-kicker"><Glass name="admission" size={27} />Hermes Partner Program</span>
          <h2>Applications</h2>
          <p>Simulated applicants · no provider, web search, outreach, or decisions</p>
        </div>
        <button type="button" className="first-run-live-inbox" onClick={onOpenInbox} disabled={!onOpenInbox || view.phase !== 'complete'}>
          <Glass name="inbox" size={23} />
          <span>Inbox</span>
          <strong aria-label={`${needsReview} applications need review`}>{needsReview}</strong>
        </button>
      </header>

      <div className="first-run-live-summary" data-phase={view.phase}>
        <span className="first-run-live-orbit" aria-hidden="true"><span /></span>
        <span>
          <strong>{view.phase === 'complete' ? 'Screening complete' : view.phase === 'error' ? 'Screening paused' : 'Iris is screening'}</strong>
          <small>{view.phase === 'complete' ? `${needsReview} waiting in Inbox` : view.phase === 'error' ? (view.message ?? 'The last saved results are still here') : 'Results appear as the run advances'}</small>
        </span>
        {view.phase === 'error' && onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}
      </div>

      {view.phase === 'error' && applications.length === 0 ? (
        <div className="first-run-live-state" role="alert">
          <Icon name="info" size={18} />
          <div><strong>Couldn’t load the sample run</strong><p>{view.message ?? 'Check the connection and try again.'}</p></div>
        </div>
      ) : null}

      {(view.phase === 'starting' || view.phase === 'resuming' || view.phase === 'running') && applications.length === 0 ? (
        <div className="first-run-live-state">
          <span className="first-run-live-search" aria-hidden="true"><Icon name="search" size={18} /></span>
          <div><strong>{view.phase === 'resuming' ? 'Reconnecting to the run' : 'Looking for sample applications'}</strong><p>This can take a few seconds.</p></div>
        </div>
      ) : null}

      <div className="first-run-applications">
        <AnimatePresence initial={false}>
          {applications.map((application) => (
            <motion.article
              layout
              key={application.id}
              className={`first-run-application is-${application.status}`}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={transition}
            >
              <div className="first-run-application-top">
                <span className="first-run-application-avatar" aria-hidden="true">{application.name.slice(0, 1).toUpperCase()}</span>
                <span className="first-run-application-person">
                  <strong>{application.name}</strong>
                  <small>{application.detail ?? 'Hermes Partner Program'}</small>
                </span>
                <span className="first-run-sample-pill">Sample</span>
                <motion.span key={application.status} className={`first-run-application-status is-${application.status}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={transition}>
                  <span />{STATUS_LABEL[application.status]}
                </motion.span>
              </div>

              {application.status === 'received' ? <p className="first-run-application-wait">Application received. Screening has not started.</p> : null}
              {application.status === 'researching' ? <p className="first-run-application-wait"><Icon name="search" size={14} />Iris is reviewing sample evidence.</p> : null}
              {application.status === 'screened' ? <p className="first-run-application-wait"><Icon name="check" size={14} />Evidence brief ready. Adding it to Inbox.</p> : null}
              {application.status === 'needs_review' ? (
                <div className="first-run-application-result">
                  <span>Main takeaway</span>
                  <strong>{application.summary ?? application.evidence[0]?.claim ?? 'Evidence brief is ready for review.'}</strong>
                  {application.evidence.length > 0 && application.summary ? <p>{application.evidence[0]?.claim}</p> : null}
                  {application.sources.length > 0 ? (
                    <ul aria-label={`Sources for ${application.name}`}>
                      {application.sources.slice(0, 4).map((source) => (
                        <li key={source.id}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">Sample · {source.label}<Icon name="external" size={11} /></a> : `Sample · ${source.label}`}</li>
                      ))}
                    </ul>
                  ) : <p className="first-run-no-sources">No verified sources were returned. Review the evidence gap before deciding.</p>}
                </div>
              ) : null}
            </motion.article>
          ))}
        </AnimatePresence>
      </div>

      {view.phase === 'complete' && needsReview > 0 ? (
        <footer className="first-run-live-foot">
          <span><Icon name="check" size={16} />Iris stopped before any decision or outreach.</span>
          <button type="button" onClick={onOpenInbox} disabled={!onOpenInbox}>Review in Inbox<Icon name="arrow" size={14} /></button>
        </footer>
      ) : null}
    </section>
  );
}
