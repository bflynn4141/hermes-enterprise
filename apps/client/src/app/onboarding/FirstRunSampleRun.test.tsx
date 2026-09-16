import { renderToStaticMarkup } from 'react-dom/server';
import type { Rest } from '../../model/rest.js';
import { FirstRunSampleRun, getSampleRun, normalizeSampleRun, startSampleRun, type SampleRunView } from './FirstRunSampleRun.js';

const RUN_ID = '10000000-0000-4000-8000-000000000001';
const AGENT_ID = '10000000-0000-4000-8000-000000000002';
const ATTEMPT_ID = '10000000-0000-4000-8000-000000000003';
const APPLICATION_ID = '10000000-0000-4000-8000-000000000004';
const DISCLOSURE = 'Sample data and deterministic timing. No provider, web search, outreach, or external action was used.' as const;
const at = '2026-09-15T20:00:00.000Z';

function backendSnapshot(state: 'received' | 'researching' | 'screened' | 'needs_review' = 'received', status: 'running' | 'completed' = 'running') {
  return {
    run: { id: RUN_ID, agent_id: AGENT_ID, session_id: null, setup_attempt_id: ATTEMPT_ID, status, simulation: true as const, disclosure: DISCLOSURE, started_at: at, completed_at: status === 'completed' ? at : null },
    applications: [{
      id: APPLICATION_ID,
      sample_key: 'owen' as const,
      display_name: 'Owen Reilly',
      state,
      sample: true as const,
      score: state === 'received' ? null : 86,
      takeaway: state === 'needs_review' ? 'Strong sample operator' : null,
      evidence: state === 'received' ? [] : [{ label: 'Track Record', summary: 'Built a fictional sample FDE bootcamp.' }],
      sources: state === 'received' ? [] : [{ id: 'github', name: 'GitHub', note: 'Fictional sample source.', sample: true as const }],
      request_id: state === 'needs_review' ? '10000000-0000-4000-8000-000000000005' : null,
      received_at: at,
      researching_at: state === 'received' ? null : at,
      screened_at: state === 'screened' || state === 'needs_review' ? at : null,
      needs_review_at: state === 'needs_review' ? at : null,
    }],
    events: [],
    cursor: { after: '0', head: '5' },
    next_poll_ms: status === 'completed' ? null : 900,
  };
}

describe('first-run sample run contract', () => {
  it('parses the exact worker schema and keeps screened distinct from review', () => {
    const snapshot = normalizeSampleRun(backendSnapshot('screened'));

    expect(snapshot).toMatchObject({
      runId: RUN_ID,
      status: 'running',
      cursor: '5',
      nextPollMs: 900,
      applications: [{ id: APPLICATION_ID, name: 'Owen Reilly', status: 'screened', requestId: null }],
    });
  });

  it('rejects an aliased or incomplete response instead of silently drifting', () => {
    expect(() => normalizeSampleRun({ run_id: RUN_ID, status: 'running' })).toThrow();
  });

  it('uses the worker contract and requests a full resumable snapshot', async () => {
    const request = vi.fn().mockResolvedValue(backendSnapshot());
    const client = { request: request as Rest['request'] };

    await startSampleRun(client, 'workspace-id', 'agent-id', '00000000-0000-4000-8000-000000000001');
    expect(request).toHaveBeenLastCalledWith(
      'POST',
      '/w/workspace-id/onboarding/sample-runs',
      expect.anything(),
      { agent_id: 'agent-id', setup_attempt_id: '00000000-0000-4000-8000-000000000001' },
    );

    await getSampleRun(client, 'workspace-id', RUN_ID);
    expect(request).toHaveBeenLastCalledWith(
      'GET',
      `/w/workspace-id/onboarding/sample-runs/${RUN_ID}?after=0`,
      expect.anything(),
    );
  });
});

describe('FirstRunSampleRun', () => {
  it('counts only applications that have reached human review', () => {
    const view: SampleRunView = {
      phase: 'running',
      message: null,
      snapshot: normalizeSampleRun(backendSnapshot('needs_review')),
    };

    const html = renderToStaticMarkup(<FirstRunSampleRun view={view} onOpenInbox={() => {}} />);
    expect(html).toContain('aria-label="1 applications need review"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Track Record: Built a fictional sample FDE bootcamp.');
    expect(html).toContain('Sample · GitHub');
    expect(html).toContain('no provider, web search, outreach, or decisions');
  });

  it('keeps saved applications visible when polling fails and exposes retry', () => {
    const view: SampleRunView = {
      phase: 'error',
      message: 'Connection interrupted.',
      snapshot: normalizeSampleRun(backendSnapshot('received')),
    };

    const html = renderToStaticMarkup(<FirstRunSampleRun view={view} onRetry={() => {}} />);
    expect(html).toContain('Owen Reilly');
    expect(html).toContain('Screening paused');
    expect(html).toContain('>Retry<');
  });
});
