import { describe, expect, it } from 'vitest';
import type { Message } from '@hermes/shared';
import { collapseHistoricalMessages, partitionRunMessages } from './message-groups.js';

const runId = '33333333-3333-4333-8333-333333333333';
const sessionId = '22222222-2222-4222-8222-222222222222';

function message(id: number, patch: Partial<Message> = {}): Message {
  return {
    id: `${id}`.padStart(8, '0') + '-0000-4000-8000-000000000000',
    session_id: sessionId,
    seq: id,
    role: 'iris',
    kind: null,
    text: '',
    blocks: [],
    status: 'complete',
    run_id: runId,
    ...patch,
  };
}

describe('provider-turn message grouping', () => {
  it('keeps internal tool turns as progress while a run is working', () => {
    const result = partitionRunMessages(
      [message(1, { text: 'Let me check the workspace.', worked_ms: 1800 }), message(2, { text: '', worked_ms: 2900 })],
      false,
    );

    expect(result.answer).toBeNull();
    expect(result.progress.map((item) => item.text)).toEqual(['Let me check the workspace.']);
  });

  it('renders one final answer and one aggregate Worked footer after tools finish', () => {
    const result = collapseHistoricalMessages([
      message(0, { role: 'user', text: 'How does this work?', worked_ms: null }),
      message(1, { text: 'Let me check the workspace.', worked_ms: 1800 }),
      message(2, { text: '', worked_ms: 2900 }),
      message(3, { text: 'Here is how Hermes works.', worked_ms: 8200 }),
    ]);

    expect(result).toHaveLength(2);
    expect(result[1]?.text).toBe('Here is how Hermes works.');
    expect(result[1]?.worked_ms).toBe(12_900);
  });

  it('leaves a direct answer unchanged', () => {
    const direct = message(1, { text: 'Krakatoa.', worked_ms: 1700 });
    expect(collapseHistoricalMessages([direct])).toEqual([direct]);
  });
});
