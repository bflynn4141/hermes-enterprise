// The scripted scenarios a development turn can name.
//
// They exist so the client's own scenarios can be driven from a composer rather
// than from `psql`. The one added here is `waiting` (client finding 14): every
// other script covers a provider failure or a malformed tool call, and none of
// them produced `runs.status = 'waiting'` — the state the whole Context tab
// exists for. Driving M3 meant inserting a parked run and an empty field by
// hand, which tests the client's half and nothing of the server's.
import { describe, expect, it } from 'vitest';
import { DEV_SCRIPTS, pickDevScript } from '../../src/runs/workflow.js';
import { TOOL_NAMES } from '../../src/engine/tools.js';
import { DEFAULT_TOOL_NAMES } from '../../src/engine/pg-agent-db.js';

const firstToolCall = (name: string): { name: string; arguments: string } | null => {
  const script = DEV_SCRIPTS[name]?.[0];
  for (const event of script?.events ?? []) {
    if (event.type === 'tool_call') return event.call;
  }
  return null;
};

describe('DEV_SCRIPTS', () => {
  it('has a scenario whose first turn calls ask_for_context', () => {
    const call = firstToolCall('waiting');
    expect(call?.name).toBe('ask_for_context');
    const args = JSON.parse(call?.arguments ?? '{}') as { key?: string; question?: string };
    expect(args.key).toBe('destination');
    expect(args.question).toBeTruthy();
  });

  it('names a tool the engine actually has, and one a development agent is given', () => {
    // A scenario naming a tool that is not in the registry, or not in the
    // Work-mode set the seeded agent gets, would park on "that tool is not
    // available" instead of on a question.
    expect(TOOL_NAMES as readonly string[]).toContain('ask_for_context');
    expect(DEFAULT_TOOL_NAMES).toContain('ask_for_context');
  });

  it('resumes after the answer rather than parking forever', () => {
    // The question, then the ordinary two turns. A scenario that parked and
    // never resumed would leave the live suite with a run it cannot finish.
    expect(DEV_SCRIPTS.waiting?.length).toBeGreaterThan(1);
  });

  it('is selectable by header and by the words a person types', () => {
    expect(pickDevScript('waiting', undefined)).toBe('waiting');
    expect(pickDevScript(undefined, 'Screen the applicant (waiting).')).toBe('waiting');
    expect(pickDevScript('WAITING', undefined)).toBe('waiting');
    // Asserted rather than wished away: `waiting` is the first scenario name
    // that is also an ordinary English word, and the matcher is a substring
    // test, so a sentence that merely contains it selects the scenario. That is
    // acceptable because the whole mechanism is refused outside
    // `ENVIRONMENT=development` — but it is a real difference from
    // `transient_5xx`, and the README says so rather than leaving someone to
    // find it by typing "still waiting on the references" into a dev composer.
    expect(pickDevScript(undefined, 'I am waiting for the references.')).toBe('waiting');
    expect(pickDevScript(undefined, 'Screen the applicant.')).toBeUndefined();
  });
});
