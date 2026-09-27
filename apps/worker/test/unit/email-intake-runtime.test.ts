// Hosted runs reading a received email (C98): the tools a bridge discovers,
// what the model proxy lets the model see, and the AgentCash refusal.
import { describe, expect, it } from 'vitest';
import { discoverableTools, refuseIntakeRun, restrictToIntakeTools } from '../../src/runtime/bridge.js';

const fn = (name: string) => ({ type: 'function', function: { name, parameters: { type: 'object' } } });

describe('restrictToIntakeTools', () => {
  it('offers the model only the intake tools', () => {
    const forwarded: Record<string, unknown> = {
      tools: [fn('suggest_reply'), fn('mcp__agentcash__fetch'), fn('fetch_url'), fn('suggest_handoff'), fn('skill_view')],
      tool_choice: 'auto',
    };
    restrictToIntakeTools(forwarded);
    expect((forwarded.tools as ReturnType<typeof fn>[]).map((tool) => tool.function.name)).toEqual(['suggest_reply', 'suggest_handoff']);
    expect(forwarded.tool_choice).toBe('auto');
  });

  it('turns a forced choice of a removed tool back into auto', () => {
    const forwarded: Record<string, unknown> = {
      tools: [fn('suggest_reply'), fn('mcp__agentcash__fetch')],
      tool_choice: { type: 'function', function: { name: 'mcp__agentcash__fetch' } },
    };
    restrictToIntakeTools(forwarded);
    expect(forwarded.tool_choice).toBe('auto');
  });

  it('drops the tool fields entirely when nothing is left', () => {
    const forwarded: Record<string, unknown> = { tools: [fn('mcp__agentcash__fetch')], tool_choice: 'required', parallel_tool_calls: true };
    restrictToIntakeTools(forwarded);
    expect(forwarded).toEqual({});
  });
});

describe('discoverableTools', () => {
  const configured = ['list_requests', 'propose_approval', 'suggest_reply', 'suggest_handoff', 'get_workspace_context'];

  it('keeps an older bridge on exactly its role tools', () => {
    expect(discoverableTools(configured, undefined).map((tool) => tool.name).sort()).toEqual(['list_requests', 'propose_approval']);
  });

  it('shows the intake tools to a bridge that accepts them', () => {
    expect(discoverableTools(configured, 'email-intake').map((tool) => tool.name).sort())
      .toEqual(['get_workspace_context', 'list_requests', 'propose_approval', 'suggest_handoff', 'suggest_reply']);
  });
});

describe('refuseIntakeRun', () => {
  it('refuses AgentCash authorization while a run reads an email, and nothing else', () => {
    expect(() => refuseIntakeRun({ mode: 'intake' })).toThrow(expect.objectContaining({ reason: 'intake_run_outbound_refused' }));
    expect(() => refuseIntakeRun({ mode: 'work' })).not.toThrow();
  });
});
