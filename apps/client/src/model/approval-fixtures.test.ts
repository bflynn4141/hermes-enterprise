import { describe, expect, it } from 'vitest';
import { APPROVAL_TYPES, approvalViewSchema, mockUuid, type ApprovalType } from '@hermes/shared';
import { createApprovalDemoFixtures } from './approval-fixtures.js';

const REQUESTER_AGENT = mockUuid(42);
const MAYA_MEMBER = mockUuid(43);
const RECIPIENT_AGENT = mockUuid(1_020);

function fixtures() {
  return createApprovalDemoFixtures({
    workspaceId: mockUuid(1),
    sessionId: mockUuid(2),
    runId: mockUuid(3),
    requesterAgentId: REQUESTER_AGENT,
    mayaUserId: mockUuid(4),
    mayaMemberId: MAYA_MEMBER,
    alexUserId: mockUuid(5),
    alexMemberId: mockUuid(6),
    at: (offsetMinutes = 0) => new Date(Date.UTC(2026, 8, 15, 12, offsetMinutes)).toISOString(),
  });
}

const expectedTargets: Record<ApprovalType, { agents: string[]; members: string[]; resources: string[] }> = {
  run_plan: { agents: [REQUESTER_AGENT, RECIPIENT_AGENT].sort(), members: [], resources: [] },
  team_commitment: { agents: [RECIPIENT_AGENT], members: [MAYA_MEMBER], resources: [] },
  access: { agents: [RECIPIENT_AGENT], members: [MAYA_MEMBER], resources: ['drive:partner-feedback'] },
  communication: { agents: [], members: [MAYA_MEMBER], resources: [] },
  shared_learning: { agents: [], members: [MAYA_MEMBER], resources: ['partner-evidence'] },
  deliverable: { agents: [], members: [MAYA_MEMBER], resources: ['onboarding-recommendation'] },
  data_disclosure: { agents: [], members: [MAYA_MEMBER], resources: ['pilot:summary:2026-q4'] },
  record_change: { agents: [], members: [MAYA_MEMBER], resources: ['crm-demo'] },
  exception: { agents: [], members: [MAYA_MEMBER], resources: ['review-window-48h'] },
  agent_governance: { agents: [RECIPIENT_AGENT], members: [MAYA_MEMBER], resources: [] },
};

const expectedEffects: Record<ApprovalType, string> = {
  run_plan: 'none',
  team_commitment: 'none',
  access: 'access',
  communication: 'communication',
  shared_learning: 'shared_learning_publish',
  deliverable: 'none',
  data_disclosure: 'data_disclosure',
  record_change: 'record_change',
  exception: 'none',
  agent_governance: 'agent_governance_change',
};

describe('approval demo fixtures', () => {
  it('creates one schema-valid view for every approval type', () => {
    const demo = fixtures();
    const views = [...demo.views.values()];

    expect(views.map((view) => view.payload.approval_type)).toEqual(APPROVAL_TYPES);
    expect(demo.requests).toHaveLength(APPROVAL_TYPES.length);
    for (const view of views) expect(() => approvalViewSchema.parse(view)).not.toThrow();
  });

  it('matches the server-derived agents, owners, resources, and effect contract', () => {
    for (const view of fixtures().views.values()) {
      const type = view.payload.approval_type;
      const expected = expectedTargets[type];
      expect(view.payload.context.target_agent_ids).toEqual(expected.agents);
      expect(view.payload.context.target_member_ids).toEqual(expected.members);
      expect(view.payload.context.target_resource_ids).toEqual(expected.resources);
      expect(view.identities.target_agents.map((agent) => agent.id).sort()).toEqual(expected.agents);
      expect(view.effect.kind).toBe(expectedEffects[type]);
      expect(view.effect.status).toBe(expectedEffects[type] === 'none' ? 'not_required' : 'unavailable');
      expect(view.payload.policy.prevent_self_review).toBe(true);
      expect(view.payload.policy.require_distinct_reviewers).toBe(true);
    }
  });
});
