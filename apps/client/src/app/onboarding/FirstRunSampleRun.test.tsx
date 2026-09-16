import { renderToStaticMarkup } from 'react-dom/server';
import type { Rest } from '../../model/rest.js';
import { FirstRunSampleRun, getSampleRun, normalizeSampleRun, startSampleRun, type SampleRunView } from './FirstRunSampleRun.js';

describe('first-run sample run contract', () => {
  it('normalizes the provisional endpoint without leaking field-name choices into the UI', () => {
    const snapshot = normalizeSampleRun({
      run: { id: 'sample-run-1', status: 'in_progress' },
      applications: [
        { application_id: 'owen', display_name: 'Owen Reilly', state: 'screening', findings: ['Built a sample FDE bootcamp'], sources: ['GitHub'] },
        { id: 'leah', display_name: 'Leah Martinez', title: 'Community lead', state: 'pending-review', takeaway: 'Strong operator', sources: [{ id: 'x', name: 'X', url: 'https://example.com/leah' }] },
      ],
      events: [{ id: 'event-1', type: 'application.received', application_id: 'owen' }],
      cursor: { after: 3, head: '5' },
      next_poll_ms: 900,
    });

    expect(snapshot).toMatchObject({
      runId: 'sample-run-1',
      status: 'running',
      cursor: '5',
      nextPollMs: 900,
      applications: [
        { id: 'owen', name: 'Owen Reilly', status: 'researching', evidence: [{ claim: 'Built a sample FDE bootcamp' }] },
        { id: 'leah', name: 'Leah Martinez', detail: 'Community lead', status: 'needs_review', summary: 'Strong operator' },
      ],
    });
  });

  it('accepts a start response that wraps the first snapshot', () => {
    expect(normalizeSampleRun({
      run_id: 'sample-run-2',
      snapshot: { status: 'created', applications: [], events: [], cursor: null },
    })).toMatchObject({ runId: 'sample-run-2', status: 'starting', applications: [] });
  });

  it('rejects a response that cannot be resumed', () => {
    expect(() => normalizeSampleRun({ status: 'running' })).toThrow('run identifier');
  });

  it('uses the worker contract and requests a full resumable snapshot', async () => {
    const request = vi.fn().mockResolvedValue({
      run: { id: 'sample-run-5', status: 'running' },
      applications: [],
      events: [],
      cursor: { after: 0, head: 0 },
      next_poll_ms: 1_200,
    });
    const client = { request: request as Rest['request'] };

    await startSampleRun(client, 'workspace-id', 'agent-id', '00000000-0000-4000-8000-000000000001');
    expect(request).toHaveBeenLastCalledWith(
      'POST',
      '/w/workspace-id/onboarding/sample-runs',
      expect.anything(),
      { agent_id: 'agent-id', setup_attempt_id: '00000000-0000-4000-8000-000000000001' },
    );

    await getSampleRun(client, 'workspace-id', 'sample-run-5');
    expect(request).toHaveBeenLastCalledWith(
      'GET',
      '/w/workspace-id/onboarding/sample-runs/sample-run-5?after=0',
      expect.anything(),
    );
  });
});

describe('FirstRunSampleRun', () => {
  it('counts only applications that have reached human review', () => {
    const view: SampleRunView = {
      phase: 'running',
      message: null,
      snapshot: normalizeSampleRun({
        run_id: 'sample-run-3',
        status: 'running',
        applications: [
          { id: 'received', name: 'Owen Reilly', status: 'received' },
          { id: 'working', name: 'Leah Martinez', status: 'researching' },
          { id: 'review', name: 'Avery Chen', status: 'needs_review', summary: 'Sample evidence is ready', sources: ['GitHub'] },
        ],
        events: [],
        cursor: '2',
      }),
    };

    const html = renderToStaticMarkup(<FirstRunSampleRun view={view} onOpenInbox={() => {}} />);
    expect(html).toContain('aria-label="1 applications need review"');
    expect(html).toContain('Iris is reviewing sample evidence.');
    expect(html).toContain('Sample · GitHub');
    expect(html).toContain('no provider, web search, outreach, or decisions');
  });

  it('keeps saved applications visible when polling fails and exposes retry', () => {
    const view: SampleRunView = {
      phase: 'error',
      message: 'Connection interrupted.',
      snapshot: normalizeSampleRun({
        run_id: 'sample-run-4',
        status: 'running',
        applications: [{ id: 'owen', name: 'Owen Reilly', status: 'received' }],
        events: [],
        cursor: '1',
      }),
    };

    const html = renderToStaticMarkup(<FirstRunSampleRun view={view} onRetry={() => {}} />);
    expect(html).toContain('Owen Reilly');
    expect(html).toContain('Screening paused');
    expect(html).toContain('>Retry<');
  });
});
