import { describe, expect, it } from 'vitest';
import {
  formatBotModeAgentMessage,
  parseBotModeAgentMessage,
} from '../src/partner-workflow.js';

describe('Hermes Bot Mode message compatibility', () => {
  it('formats and parses the canonical emoji/profile envelope', () => {
    const wire = formatBotModeAgentMessage({
      display: 'Iris',
      profile: 'agent-1234',
      body: 'Review the authenticated Finance handoff.',
    });
    expect(wire).toBe('Message from 🤖 Iris (@agent-1234): Review the authenticated Finance handoff.');
    expect(parseBotModeAgentMessage(wire)).toEqual({
      display: 'Iris',
      profile: 'agent-1234',
      body: 'Review the authenticated Finance handoff.',
    });
  });

  it('reads the legacy envelope and ignores ordinary human messages', () => {
    expect(parseBotModeAgentMessage("[Message from agent 'Iris'] Review this.")).toEqual({
      display: 'Iris', profile: null, body: 'Review this.',
    });
    expect(parseBotModeAgentMessage('Please forward this to Iris.')).toBeNull();
  });

  it('refuses profiles that the Hermes Bot Mode client cannot recognize', () => {
    expect(() => formatBotModeAgentMessage({ display: 'Iris', profile: 'Iris Cloud', body: 'Review.' })).toThrow();
  });
});
