import { describe, expect, it } from 'vitest';
import {
  createSharedIntelligenceProposalSchema,
  sharedIntelligenceTriageAssessmentSchema,
  sharedIntelligenceProposalSchema,
  sharedIntelligenceWorkspaceSchema,
} from '../src/shared-intelligence.js';

describe('Shared Intelligence wire contracts', () => {
  it('requires unique audiences and evidence runs', () => {
    const duplicate = '00000000-0000-4000-8000-000000000001';
    const parsed = createSharedIntelligenceProposalSchema.safeParse({
      agent_id: duplicate,
      title: 'Lesson',
      goal: 'Goal',
      lesson: 'Reusable lesson',
      rationale: 'Evidence rationale',
      team_ids: [duplicate, duplicate],
      evidence: [{ run_id: duplicate, approved_excerpt: 'Visible quote' }, { run_id: duplicate, approved_excerpt: 'Visible quote' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('distinguishes a quoted human assertion from an agent response', () => {
    const base = {
      id: '00000000-0000-4000-8000-000000000001',
      run_id: '00000000-0000-4000-8000-000000000002',
      session_id: '00000000-0000-4000-8000-000000000003',
      source_message_id: '00000000-0000-4000-8000-000000000004',
      session_title: 'Review',
      run_ended_at: '2026-09-19T12:00:00.000Z',
      source_sha256: 'a'.repeat(64),
      approved_excerpt: 'The customer accepted the proposal.',
      excerpt_sha256: 'b'.repeat(64),
      provenance: 'verified_quote',
      tool_names: [], step_labels: [], outcome: 'runtime_completed', revoked_at: null,
    };
    const proposal = {
      id: '00000000-0000-4000-8000-000000000005', title: 'Lesson', goal: 'Goal', lesson: 'Lesson', rationale: 'Rationale',
      agent_id: '00000000-0000-4000-8000-000000000006', agent_name: 'Iris',
      audiences: [{ id: '00000000-0000-4000-8000-000000000007', slug: 'partnerships', name: 'Partnerships' }],
      evidence: [{ ...base, source_message_role: 'user' }],
      assessment: {
        status: 'complete', composite_score: 75, route: 'heightened_review', axes: null, evidence_count: 1,
        rubric_version: '1', model_id: 'jev-1.13.0', model_version: 'jev-1.13.0-20260901', state_sha256: 'c'.repeat(64),
        latency_ms: 15, failure_class: null, warnings: ['Human assertion is not independently verified.'],
      },
      status: 'needs_review', approval_request_id: null, library_source_id: null, library_version_id: null,
      created_at: '2026-09-19T12:00:00.000Z', published_at: null, revoked_at: null,
    };
    expect(sharedIntelligenceProposalSchema.parse(proposal).evidence[0]?.source_message_role).toBe('user');
    expect(sharedIntelligenceWorkspaceSchema.safeParse({ teams: proposal.audiences, eligible_runs: [], discoveries: [], proposals: [proposal], data_boundary: 'Owner-visible completed runs only.' }).success).toBe(true);
  });

  it('accepts only bounded typed Jev triage signals and code-owned reasons', () => {
    const assessment = sharedIntelligenceTriageAssessmentSchema.parse({
      status: 'complete', priority_score: 82, recommendation: 'include', confidence: .8,
      axes: {
        relevance: { score: 3, confidence: .8 }, impact: { score: 2.5, confidence: .8 }, novelty: { score: 2, confidence: .8 },
        corroboration: { score: 2.5, confidence: .8 }, urgency: { score: 2, confidence: .8 }, uncertainty: { score: .5, confidence: .8 }, sensitivity: { score: .25, confidence: .8 },
      },
      reason_codes: ['goal_aligned', 'corroborated'],
      goal_snapshot: {
        id: '00000000-0000-4000-8000-000000000009', scope: 'workspace', team_id: null, team_name: null,
        title: 'Reduce review rework', detail: 'Make repeated reviews faster.', revision: 1,
        content_sha256: 'e'.repeat(64), active: true, created_at: '2026-09-19T12:00:00.000Z',
      },
      comparison_snapshot: [], evidence_count: 2, rubric_version: '2',
      model_id: 'jev-1.13.0', model_version: 'jev-1.13.0-test', state_sha256: 'd'.repeat(64),
      latency_ms: 20, failure_class: null, assessed_at: '2026-09-19T12:01:00.000Z', warnings: ['Human decision required.'],
    });
    expect(assessment.recommendation).toBe('include');
    expect(assessment.reason_codes).toEqual(['goal_aligned', 'corroborated']);
    expect(sharedIntelligenceTriageAssessmentSchema.safeParse({ ...assessment, priority_score: 101 }).success).toBe(false);
  });
});
