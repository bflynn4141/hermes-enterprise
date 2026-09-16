import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { z } from 'zod';
import type { Rest } from '../../model/rest.js';
import { Glass, Icon } from '../ui/icons.js';

export type SampleApplicationStatus = 'received' | 'researching' | 'needs_review';
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

type JsonRecord = Record<string, unknown>;
type RequestClient = Pick<Rest, 'request'>;

const unknownResponse = z.unknown();

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cursorToken(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return text(value);
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function applicationStatus(value: unknown): SampleApplicationStatus {
  const status = text(value)?.toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (status === 'needs_review' || status === 'ready' || status === 'pending_review' || status === 'screened') return 'needs_review';
  if (status === 'researching' || status === 'screening' || status === 'working' || status === 'in_progress') return 'researching';
  return 'received';
}

function runStatus(value: unknown): SampleRunStatus {
  const status = text(value)?.toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (status === 'complete' || status === 'completed' || status === 'done') return 'completed';
  if (status === 'failed' || status === 'error') return 'failed';
  if (status === 'starting' || status === 'queued' || status === 'created') return 'starting';
  return 'running';
}

function normalizeSource(value: unknown, index: number): SampleSource | null {
  if (typeof value === 'string') return { id: `source-${index}`, label: value, url: null };
  const source = record(value);
  const label = text(source.label) ?? text(source.name) ?? text(source.title);
  if (!label) return null;
  return {
    id: text(source.id) ?? `source-${index}`,
    label,
    url: text(source.url) ?? text(source.href),
  };
}

function normalizeEvidence(value: unknown, index: number): SampleEvidence | null {
  if (typeof value === 'string') return { id: `evidence-${index}`, claim: value, sourceIds: [] };
  const evidence = record(value);
  const claim = text(evidence.claim) ?? text(evidence.text) ?? text(evidence.summary) ?? text(evidence.evidence);
  if (!claim) return null;
  const rawSourceIds = array(evidence.source_ids ?? evidence.sourceIds);
  return {
    id: text(evidence.id) ?? `evidence-${index}`,
    claim,
    sourceIds: rawSourceIds.map(text).filter((id): id is string => id !== null),
  };
}

function normalizeApplication(value: unknown, index: number): SampleApplication {
  const application = record(value);
  const applicant = record(application.applicant);
  const evidence = array(application.evidence ?? application.findings)
    .map(normalizeEvidence)
    .filter((item): item is SampleEvidence => item !== null);
  const sources = array(application.sources)
    .map(normalizeSource)
    .filter((item): item is SampleSource => item !== null);
  return {
    id: text(application.id) ?? text(application.application_id) ?? `sample-application-${index}`,
    requestId: text(application.request_id) ?? text(application.requestId),
    name: text(application.display_name) ?? text(application.name) ?? text(application.label) ?? text(application.subject) ?? text(applicant.name) ?? `Sample applicant ${index + 1}`,
    detail: text(application.detail) ?? text(application.company) ?? text(application.title) ?? text(applicant.title),
    status: applicationStatus(application.state ?? application.status ?? application.stage),
    summary: text(application.summary) ?? text(application.takeaway) ?? text(application.recommendation),
    evidence,
    sources,
  };
}

function normalizeEvent(value: unknown, index: number): SampleRunEvent {
  const event = record(value);
  return {
    id: text(event.id) ?? `sample-event-${index}`,
    kind: text(event.kind) ?? text(event.type) ?? 'sample.updated',
    applicationId: text(event.application_id) ?? text(event.applicationId),
    createdAt: text(event.created_at) ?? text(event.createdAt) ?? text(event.at),
  };
}

/**
 * Keep the provisional endpoint contract in one place. The worker can rename
 * fields while it settles without spreading response-shape guesses through
 * the onboarding components.
 */
export function normalizeSampleRun(value: unknown): SampleRunSnapshot {
  const outer = record(value);
  const nested = record(outer.snapshot);
  const payload = Object.keys(nested).length ? nested : outer;
  const run = record(payload.run ?? outer.run);
  const cursor = record(payload.cursor);
  const runId = text(run.id) ?? text(run.run_id) ?? text(payload.run_id) ?? text(payload.runId) ?? text(payload.id) ?? text(outer.run_id) ?? text(outer.runId) ?? text(outer.id);
  if (!runId) throw new Error('The sample run response did not include a run identifier.');
  const nextPollMs = typeof payload.next_poll_ms === 'number' && Number.isFinite(payload.next_poll_ms)
    ? Math.max(500, Math.min(5_000, Math.round(payload.next_poll_ms)))
    : 1_200;
  return {
    runId,
    status: runStatus(run.status ?? payload.status),
    applications: array(payload.applications).map(normalizeApplication),
    events: array(payload.events).map(normalizeEvent),
    cursor: cursorToken(payload.cursor) ?? cursorToken(cursor.head) ?? cursorToken(cursor.after),
    error: text(run.error) ?? text(record(run.error).message) ?? text(payload.error) ?? text(record(payload.error).message),
    nextPollMs,
  };
}

export async function startSampleRun(client: RequestClient, workspaceId: string, agentId: string, setupAttemptId: string): Promise<SampleRunSnapshot> {
  const response = await client.request(
    'POST',
    `/w/${encodeURIComponent(workspaceId)}/onboarding/sample-runs`,
    unknownResponse,
    { agent_id: agentId, setup_attempt_id: setupAttemptId },
  );
  return normalizeSampleRun(response);
}

export async function getSampleRun(client: RequestClient, workspaceId: string, runId: string): Promise<SampleRunSnapshot> {
  const response = await client.request(
    'GET',
    `/w/${encodeURIComponent(workspaceId)}/onboarding/sample-runs/${encodeURIComponent(runId)}?after=0`,
    unknownResponse,
  );
  return normalizeSampleRun(response);
}

const STATUS_LABEL: Record<SampleApplicationStatus, string> = {
  received: 'Received',
  researching: 'Researching',
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
  return `${applications.length} sample applications found. ${reviews} need review.`;
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
        <button type="button" className="first-run-live-inbox" onClick={onOpenInbox} disabled={!onOpenInbox || needsReview === 0}>
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
