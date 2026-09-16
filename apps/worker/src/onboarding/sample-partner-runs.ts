import {
  onboardingSampleSnapshotSchema,
  type OnboardingSampleSnapshot,
  type OnboardingSampleApplicationState,
} from '@hermes/shared';
import { publishEvents } from '../jobs.js';
import type { TenantWork } from '../routes/tenant.js';
import { RouteError } from '../routes/tenant.js';

export const SAMPLE_DISCLOSURE =
  'Sample data and deterministic timing. No provider, web search, outreach, or external action was used.' as const;

const TIMELINE = [
  { key: 'owen:received', sampleKey: 'owen', state: 'received', offsetMs: 1_000 },
  { key: 'owen:researching', sampleKey: 'owen', state: 'researching', offsetMs: 3_000 },
  { key: 'leah:received', sampleKey: 'leah', state: 'received', offsetMs: 3_000 },
  { key: 'leah:researching', sampleKey: 'leah', state: 'researching', offsetMs: 5_500 },
  { key: 'owen:screened', sampleKey: 'owen', state: 'screened', offsetMs: 6_000 },
  { key: 'owen:needs_review', sampleKey: 'owen', state: 'needs_review', offsetMs: 7_500 },
  { key: 'leah:screened', sampleKey: 'leah', state: 'screened', offsetMs: 9_500 },
  { key: 'leah:needs_review', sampleKey: 'leah', state: 'needs_review', offsetMs: 11_000 },
] as const satisfies readonly {
  key: string;
  sampleKey: 'owen' | 'leah';
  state: OnboardingSampleApplicationState;
  offsetMs: number;
}[];

export const SAMPLE_RUN_DURATION_MS = 11_000;

export function dueSampleTransitions(elapsedMs: number): readonly (typeof TIMELINE)[number][] {
  return TIMELINE.filter((transition) => transition.offsetMs <= Math.max(0, elapsedMs));
}

const SOURCES = [
  { id: 'linkedin', name: 'LinkedIn', note: 'Fictional sample source; no profile was fetched.' },
  { id: 'github', name: 'GitHub', note: 'Fictional sample source; no repository was fetched.' },
  { id: 'youtube', name: 'YouTube', note: 'Fictional sample source; no video was fetched.' },
  { id: 'x', name: 'X', note: 'Fictional sample source; no post was fetched.' },
];

const FIXTURES = {
  owen: {
    name: 'Owen Blake',
    score: 86,
    takeaway: 'Created an FDE bootcamp; this simulated signal still needs verification.',
    payload: {
      kind: 'application',
      applicant: { name: 'Owen Blake', email: 'owen.sample@example.test', title: 'Sample applicant' },
      proposed_role: 'Sample · Technical Partner',
      score: 86,
      score_max: 100,
      criteria: [
        { id: 'track-record', label: 'Track Record', points: 29, points_max: 35, evidence: 'Simulated signal: created an FDE bootcamp.', source_ids: ['linkedin', 'youtube'] },
        { id: 'capacity', label: 'Capacity', points: 25, points_max: 30, evidence: 'Simulated signal: has led repeatable cohort programs.', source_ids: ['linkedin', 'github'] },
        { id: 'fit', label: 'Fit', points: 32, points_max: 35, evidence: 'Simulated signal: public work aligns with developer education.', source_ids: ['github', 'x'] },
      ],
      sources: SOURCES,
      missing: ['All evidence is simulated and must be verified before a real decision.'],
    },
  },
  leah: {
    name: 'Leah Martinez',
    score: 78,
    takeaway: 'Led repeatable partner onboarding programs; this simulated signal still needs verification.',
    payload: {
      kind: 'application',
      applicant: { name: 'Leah Martinez', email: 'leah.sample@example.test', title: 'Sample applicant' },
      proposed_role: 'Sample · Delivery Partner',
      score: 78,
      score_max: 100,
      criteria: [
        { id: 'track-record', label: 'Track Record', points: 27, points_max: 35, evidence: 'Simulated signal: launched two partner enablement programs.', source_ids: ['linkedin', 'youtube'] },
        { id: 'capacity', label: 'Capacity', points: 22, points_max: 30, evidence: 'Simulated signal: current availability was described but not verified.', source_ids: ['linkedin'] },
        { id: 'fit', label: 'Fit', points: 29, points_max: 35, evidence: 'Simulated signal: experience spans onboarding and technical education.', source_ids: ['github', 'x'] },
      ],
      sources: SOURCES,
      missing: ['All evidence is simulated and must be verified before a real decision.'],
    },
  },
} as const;

interface RunRow {
  id: string;
  agent_id: string;
  session_id: string | null;
  setup_attempt_id: string;
  status: 'running' | 'completed';
  started_at: Date;
  completed_at: Date | null;
  created_by: string;
}

interface ApplicationRow {
  id: string;
  sample_key: 'owen' | 'leah';
  display_name: string;
  state: OnboardingSampleApplicationState;
  payload: Record<string, unknown>;
  request_id: string | null;
  received_at: Date;
  researching_at: Date | null;
  screened_at: Date | null;
  needs_review_at: Date | null;
}

const eventDetail = (state: OnboardingSampleApplicationState): string => {
  switch (state) {
    case 'received': return 'Sample application received from fixture data.';
    case 'researching': return 'Simulating public-source research. No web request is made.';
    case 'screened': return 'Sample evidence brief prepared from fictional fixture data.';
    case 'needs_review': return 'Sample screening is ready for human review. No outreach was sent.';
  }
};

async function insertSampleEvent(
  work: TenantWork,
  input: {
    runId: string;
    applicationId?: string | null;
    eventKey: string;
    kind: string;
    state?: OnboardingSampleApplicationState | null;
    requestId?: string | null;
    detail: string;
    at: Date;
  },
): Promise<void> {
  await work.tx.query(
    `INSERT INTO onboarding_sample_events
       (workspace_id, run_id, application_id, event_key, kind, state, request_id, detail, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (run_id, event_key) DO NOTHING`,
    [
      work.workspaceId,
      input.runId,
      input.applicationId ?? null,
      input.eventKey,
      input.kind,
      input.state ?? null,
      input.requestId ?? null,
      input.detail,
      input.at,
    ],
  );
}

async function loadRun(work: TenantWork, runId: string, lock = false): Promise<RunRow> {
  const { rows } = await work.tx.query<RunRow>(
    `SELECT id, agent_id, session_id, setup_attempt_id, status, started_at, completed_at, created_by
       FROM onboarding_sample_runs
      WHERE workspace_id = $1 AND id = $2 AND created_by = $3
      ${lock ? 'FOR UPDATE' : ''}`,
    [work.workspaceId, runId, work.userId],
  );
  const run = rows[0];
  if (!run) throw new RouteError('no such onboarding sample run', 'unknown_sample_run', 404);
  return run;
}

async function loadApplications(work: TenantWork, runId: string): Promise<ApplicationRow[]> {
  const { rows } = await work.tx.query<ApplicationRow>(
    `SELECT id, sample_key, display_name, state, payload, request_id,
            received_at, researching_at, screened_at, needs_review_at
       FROM onboarding_sample_applications
      WHERE workspace_id = $1 AND run_id = $2
      ORDER BY CASE sample_key WHEN 'owen' THEN 0 ELSE 1 END`,
    [work.workspaceId, runId],
  );
  return rows;
}

async function createInboxRequest(
  work: TenantWork,
  run: RunRow,
  application: ApplicationRow,
): Promise<string> {
  if (application.request_id) return application.request_id;
  const fixture = FIXTURES[application.sample_key];
  const { rows } = await work.tx.query<{ id: string }>(
    `INSERT INTO requests
       (workspace_id, kind, subject_key, label, payload, status, session_id)
     VALUES ($1, 'application', $2, $3, $4::jsonb, 'pending', $5)
     RETURNING id`,
    [
      work.workspaceId,
      `sample:${run.id}:${application.sample_key}`,
      `Sample · ${fixture.name}`,
      JSON.stringify(fixture.payload),
      run.session_id,
    ],
  );
  const requestId = rows[0]?.id;
  if (!requestId) throw new Error('sample Inbox request was not created');

  await work.tx.query(
    `INSERT INTO events (workspace_id, actor_type, kind, request_id, session_id)
     VALUES ($1, 'agent', 'request.created', $2, $3)`,
    [work.workspaceId, requestId, run.session_id],
  );
  work.jobs.push(...await publishEvents(work.tx, work.workspaceId, [{
    kind: 'request.created',
    payload: {
      request_id: requestId,
      kind: 'application',
      status: 'pending',
      label: `Sample · ${fixture.name}`,
      run_id: null,
      session_id: run.session_id,
    },
  }]));
  return requestId;
}

/** Materialize every server-timed transition that is due, exactly once. */
export async function advanceSamplePartnerRun(
  work: TenantWork,
  runId: string,
  now = new Date(),
): Promise<RunRow> {
  let run = await loadRun(work, runId, true);
  if (run.status === 'completed') return run;

  const elapsedMs = Math.max(0, now.getTime() - run.started_at.getTime());
  const applications = await loadApplications(work, run.id);
  const byKey = new Map(applications.map((application) => [application.sample_key, application]));

  for (const transition of dueSampleTransitions(elapsedMs)) {
    const eventExists = await work.tx.query(
      `SELECT 1 FROM onboarding_sample_events WHERE run_id = $1 AND event_key = $2`,
      [run.id, `application:${transition.key}`],
    );
    if (eventExists.rowCount) continue;

    const scheduledAt = new Date(run.started_at.getTime() + transition.offsetMs);
    let application = byKey.get(transition.sampleKey);
    if (transition.state === 'received' && !application) {
      const fixture = FIXTURES[transition.sampleKey];
      const inserted = await work.tx.query<ApplicationRow>(
        `INSERT INTO onboarding_sample_applications
           (workspace_id, run_id, sample_key, display_name, state, payload, received_at)
         VALUES ($1,$2,$3,$4,'received',$5::jsonb,$6)
         ON CONFLICT (run_id, sample_key) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id, sample_key, display_name, state, payload, request_id,
                   received_at, researching_at, screened_at, needs_review_at`,
        [work.workspaceId, run.id, transition.sampleKey, fixture.name, JSON.stringify(fixture.payload), scheduledAt],
      );
      application = inserted.rows[0];
      if (application) byKey.set(application.sample_key, application);
    }
    if (!application) throw new Error(`sample application ${transition.sampleKey} is missing`);

    let requestId = application.request_id;
    if (transition.state === 'needs_review') {
      requestId = await createInboxRequest(work, run, application);
      application.request_id = requestId;
    }

    const timestampColumn = transition.state === 'received'
      ? 'received_at'
      : transition.state === 'researching'
      ? 'researching_at'
      : transition.state === 'screened'
        ? 'screened_at'
        : 'needs_review_at';
    await work.tx.query(
      `UPDATE onboarding_sample_applications
          SET state = $3, ${timestampColumn} = $4, request_id = COALESCE(request_id, $5)
        WHERE workspace_id = $1 AND id = $2`,
      [work.workspaceId, application.id, transition.state, scheduledAt, requestId],
    );
    application.state = transition.state;
    application[timestampColumn] = scheduledAt;

    await insertSampleEvent(work, {
      runId: run.id,
      applicationId: application.id,
      eventKey: `application:${transition.key}`,
      kind: `application.${transition.state}`,
      state: transition.state,
      requestId,
      detail: eventDetail(transition.state),
      at: scheduledAt,
    });
  }

  if (elapsedMs >= SAMPLE_RUN_DURATION_MS) {
    const completedAt = new Date(run.started_at.getTime() + SAMPLE_RUN_DURATION_MS);
    await work.tx.query(
      `UPDATE onboarding_sample_runs
          SET status = 'completed', completed_at = $3
        WHERE workspace_id = $1 AND id = $2 AND status = 'running'`,
      [work.workspaceId, run.id, completedAt],
    );
    await insertSampleEvent(work, {
      runId: run.id,
      eventKey: 'run:completed',
      kind: 'run.completed',
      detail: 'Both sample applications are waiting for human review.',
      at: completedAt,
    });
    run = { ...run, status: 'completed', completed_at: completedAt };
  }
  return run;
}

export async function startSamplePartnerRun(
  work: TenantWork,
  agentId: string,
  setupAttemptId: string,
): Promise<{ runId: string; created: boolean }> {
  // Starting the walkthrough creates shared Inbox requests, so workspace
  // membership alone is not enough authority. A person may only start the
  // agent bound to their own member profile.
  const agent = await work.tx.query(
    `SELECT 1
       FROM agents a
       JOIN agent_owners ao
         ON ao.workspace_id = a.workspace_id AND ao.agent_id = a.id
       JOIN members m
         ON m.workspace_id = ao.workspace_id AND m.id = ao.member_id
      WHERE a.workspace_id = $1 AND a.id = $2
        AND m.user_id = $3 AND m.status = 'active'`,
    [work.workspaceId, agentId, work.userId],
  );
  if (agent.rowCount !== 1) {
    throw new RouteError('this agent is not bound to your profile', 'agent_not_bound', 403);
  }

  // This walkthrough belongs to onboarding, not to an arbitrary chat. Leaving
  // it unbound prevents its Inbox requests from appearing to originate in the
  // oldest pre-existing session when a person has several conversations.
  const inserted = await work.tx.query<{ id: string; started_at: Date }>(
    `INSERT INTO onboarding_sample_runs
       (workspace_id, agent_id, created_by, session_id, setup_attempt_id)
     VALUES ($1,$2,$3,NULL,$4)
     ON CONFLICT (workspace_id, created_by, agent_id) DO NOTHING
     RETURNING id, started_at`,
    [work.workspaceId, agentId, work.userId, setupAttemptId],
  );
  const created = inserted.rows[0];
  const existing = created ? null : await work.tx.query<{ id: string; started_at: Date }>(
    `SELECT id, started_at FROM onboarding_sample_runs
      WHERE workspace_id = $1 AND created_by = $2 AND agent_id = $3`,
    [work.workspaceId, work.userId, agentId],
  );
  const row = created ?? existing?.rows[0];
  if (!row) throw new RouteError('the sample run could not be resumed', 'sample_run_conflict', 409);
  if (!created) return { runId: row.id, created: false };

  await insertSampleEvent(work, {
    runId: row.id,
    eventKey: 'run:started',
    kind: 'run.started',
    detail: 'Sample run started. No provider or external system is being used.',
    at: row.started_at,
  });
  return { runId: row.id, created: true };
}

export async function samplePartnerSnapshot(
  work: TenantWork,
  runId: string,
  after: string,
  now = new Date(),
): Promise<OnboardingSampleSnapshot> {
  const run = await advanceSamplePartnerRun(work, runId, now);
  const applications = await loadApplications(work, run.id);
  const events = await work.tx.query<{
    id: string;
    run_id: string;
    application_id: string | null;
    kind: string;
    state: OnboardingSampleApplicationState | null;
    request_id: string | null;
    detail: string;
    created_at: Date;
  }>(
    `SELECT id::text AS id, run_id, application_id, kind, state, request_id, detail, created_at
       FROM onboarding_sample_events
      WHERE workspace_id = $1 AND run_id = $2 AND id > $3::bigint
      ORDER BY id LIMIT 100`,
    [work.workspaceId, run.id, after],
  );
  const head = await work.tx.query<{ head: string }>(
    `SELECT COALESCE(max(id), 0)::text AS head
       FROM onboarding_sample_events WHERE workspace_id = $1 AND run_id = $2`,
    [work.workspaceId, run.id],
  );
  const elapsedMs = Math.max(0, now.getTime() - run.started_at.getTime());
  const next = TIMELINE.find((transition) => transition.offsetMs > elapsedMs)?.offsetMs ?? null;
  const nextPollMs = run.status === 'completed' || next === null
    ? null
    : Math.max(250, Math.min(1_500, next - elapsedMs));

  return onboardingSampleSnapshotSchema.parse({
    run: {
      id: run.id,
      agent_id: run.agent_id,
      session_id: run.session_id,
      setup_attempt_id: run.setup_attempt_id,
      status: run.status,
      simulation: true,
      disclosure: SAMPLE_DISCLOSURE,
      started_at: run.started_at.toISOString(),
      completed_at: run.completed_at?.toISOString() ?? null,
    },
    applications: applications.map((application) => {
      const fixture = FIXTURES[application.sample_key];
      const screened = application.state === 'screened' || application.state === 'needs_review';
      return {
        id: application.id,
        sample_key: application.sample_key,
        display_name: application.display_name,
        state: application.state,
        sample: true,
        score: screened ? fixture.score : null,
        takeaway: screened ? fixture.takeaway : null,
        evidence: screened
          ? fixture.payload.criteria.map((criterion) => ({ label: criterion.label, summary: criterion.evidence }))
          : [],
        sources: screened
          ? fixture.payload.sources.map((source) => ({ ...source, sample: true as const }))
          : [],
        request_id: application.request_id,
        received_at: application.received_at.toISOString(),
        researching_at: application.researching_at?.toISOString() ?? null,
        screened_at: application.screened_at?.toISOString() ?? null,
        needs_review_at: application.needs_review_at?.toISOString() ?? null,
      };
    }),
    events: events.rows.map((event) => ({
      id: event.id,
      run_id: event.run_id,
      application_id: event.application_id,
      kind: event.kind,
      state: event.state,
      request_id: event.request_id,
      detail: event.detail,
      at: event.created_at.toISOString(),
    })),
    cursor: { after, head: head.rows[0]?.head ?? '0' },
    next_poll_ms: nextPollMs,
  });
}
