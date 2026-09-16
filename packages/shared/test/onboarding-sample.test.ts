import { describe, expect, it } from 'vitest';
import { onboardingSampleSnapshotSchema } from '../src/index.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('onboarding sample contract', () => {
  it('requires the response to disclose the deterministic simulation', () => {
    const parsed = onboardingSampleSnapshotSchema.parse({
      run: {
        id: UUID,
        agent_id: OTHER,
        session_id: null,
        setup_attempt_id: UUID,
        status: 'running',
        simulation: true,
        disclosure: 'Sample data and deterministic timing. No provider, web search, outreach, or external action was used.',
        started_at: '2026-09-15T20:00:00.000Z',
        completed_at: null,
      },
      applications: [
        { id: UUID, sample_key: 'owen', display_name: 'Owen Blake', state: 'received', sample: true, score: null, takeaway: null, evidence: [], sources: [], request_id: null, received_at: '2026-09-15T20:00:00.000Z', researching_at: null, screened_at: null, needs_review_at: null },
        { id: OTHER, sample_key: 'leah', display_name: 'Leah Martinez', state: 'received', sample: true, score: null, takeaway: null, evidence: [], sources: [], request_id: null, received_at: '2026-09-15T20:00:00.000Z', researching_at: null, screened_at: null, needs_review_at: null },
      ],
      events: [],
      cursor: { after: '0', head: '0' },
      next_poll_ms: 1_000,
    });
    expect(parsed.run.simulation).toBe(true);
    expect(parsed.run.disclosure).toContain('No provider');
  });

  it('rejects a response that presents the sample as a real run', () => {
    expect(onboardingSampleSnapshotSchema.safeParse({ run: { simulation: false } }).success).toBe(false);
  });
});
