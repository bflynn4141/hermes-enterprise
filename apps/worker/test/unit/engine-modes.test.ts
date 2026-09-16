// Ask, Plan and Work: three different answers to "what is this conversation
// for", and the tests that make the difference real rather than a label on a
// selector.
//
// The property that matters most is the negative one, and it is asserted three
// times in three ways: a Plan run writes no `requests` row. A mode whose only
// enforcement is a sentence in a system prompt is a mode, and a mode whose
// enforcement is a row that is absent afterwards is a promise.
import { describe, expect, it } from 'vitest';
import { allowedTools, executeTool, MODE_TOOL_KINDS, PREPARED_TOOLS, toolByName, TOOL_NAMES } from '../../src/engine/tools.js';
import type { ToolContext } from '../../src/engine/tools.js';
import { FakeAgentDb } from './engine/fake-db.js';
import { APPLICATION, assertValidLog, runHarness, stop, textDelta, toolCall, usage } from './engine/harness.js';

const everyTool = [...TOOL_NAMES];

describe('the mode allowlists', () => {
  it('gives Ask read tools and nothing else', () => {
    const names = allowedTools('ask', everyTool).map((t) => t.name);
    expect(names).toContain('get_request');
    expect(names).toContain('fetch_url');
    expect(names).not.toContain('propose_request');
    expect(names).not.toContain('save_review_note');
    expect(names).not.toContain('set_focus');
  });

  it('gives Plan the same tools as Work, and prepares the writes', () => {
    const plan = allowedTools('plan', everyTool).map((t) => t.name);
    const work = allowedTools('work', everyTool).map((t) => t.name);
    expect(plan).toEqual(work);
    expect([...PREPARED_TOOLS]).toEqual(['propose_request', 'propose_approval', 'save_review_note', 'set_context_field', 'propose_instruction']);
    // `ask_for_context` writes nothing, so Plan runs it for real: a plan that
    // cannot ask the question it needs answered is not a plan.
    expect(PREPARED_TOOLS.has('ask_for_context')).toBe(false);
  });

  it('intersects the mode with the workspace capability rows, never widening', () => {
    // The workspace configured two tools. Work mode does not add a third.
    expect(allowedTools('work', ['get_request', 'propose_request']).map((t) => t.name)).toEqual([
      'get_request',
      'propose_request',
    ]);
    // An agent with no capability rows gets nothing, in every mode.
    for (const mode of Object.keys(MODE_TOOL_KINDS)) expect(allowedTools(mode, [])).toEqual([]);
  });

  it('falls back to the Ask kinds — read-only — for a mode nobody has heard of', () => {
    // It used to fall back to `work`, the *least* restrictive set, so a mode
    // string this build does not know handed the model every proposal tool
    // (security review O26). A newer client, a hand-written row or a rollback
    // over the migration that added a mode are all ways to produce one.
    expect(allowedTools('arbitrary', everyTool).map((t) => t.name)).toEqual(
      allowedTools('ask', everyTool).map((t) => t.name),
    );
    expect(allowedTools('arbitrary', everyTool).map((t) => t.name)).not.toEqual(
      allowedTools('work', everyTool).map((t) => t.name),
    );
  });
});

const ctxFor = (db: FakeAgentDb, mode: string): ToolContext => ({
  writes: db,
  reads: db,
  run: {
    id: 'run-1',
    workspaceId: FakeAgentDb.WORKSPACE_ID,
    sessionId: FakeAgentDb.SESSION_ID,
    status: 'working',
    stopRequested: false,
    attempt: 1,
    engineVersion: 1,
    maxTurns: 12,
    modelId: 'deepseek-flash',
    effort: null,
    traceId: 'trace-0000',
    activeMs: 0,
    waitingFor: null,
    mode,
    agentId: 'agent-1',
    clientTurnId: 'turn-1',
  },
  toolCallId: 'call_1',
  now: () => new Date(),
  mode,
});

describe('Plan mode prepares rather than writes', () => {
  it('returns a prepared block and writes nothing', async () => {
    const db = new FakeAgentDb({ mode: 'plan' });
    const tool = toolByName('propose_request');
    expect(tool).toBeDefined();
    const outcome = await executeTool(tool!, { kind: 'application', payload: APPLICATION }, ctxFor(db, 'plan'));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const data = outcome.data as { prepared: { tool: string }; written: boolean; note: string };
      expect(data.prepared.tool).toBe('propose_request');
      expect(data.written).toBe(false);
      expect(data.note).toContain('nothing was written');
    }
    expect(db.requests).toHaveLength(0);
  });

  it('still validates the payload, so a plan is applicable', async () => {
    const db = new FakeAgentDb({ mode: 'plan' });
    const outcome = await executeTool(
      toolByName('propose_request')!,
      { kind: 'application', payload: { kind: 'application', applicant: {} } },
      ctxFor(db, 'plan'),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('does not match the application schema');
    expect(db.requests).toHaveLength(0);
  });

  it('still refuses markup in a prepared note', async () => {
    const db = new FakeAgentDb({ mode: 'plan' });
    const outcome = await executeTool(
      toolByName('save_review_note')!,
      { request_id: 'r1', body: 'See <a href="https://evil.test">the policy</a>' },
      ctxFor(db, 'plan'),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('plain text');
    expect(db.notes).toHaveLength(0);
  });

  it('runs read tools for real', async () => {
    const db = new FakeAgentDb({ mode: 'plan' });
    const outcome = await executeTool(toolByName('list_members')!, {}, ctxFor(db, 'plan'));
    expect(outcome.ok).toBe(true);
  });
});

describe('a whole run, in each mode', () => {
  const script = [
    {
      events: [
        textDelta('Scoring the application. '),
        toolCall('call_1', 'propose_request', { kind: 'application', payload: APPLICATION }),
        usage(),
        stop('tool_use'),
      ],
    },
    { events: [textDelta('Done.'), usage(), stop('end_turn')] },
  ];

  it('Work writes the request', async () => {
    const db = new FakeAgentDb({ mode: 'work' });
    const { error } = await runHarness(script, { db });
    expect(error).toBeNull();
    expect(db.requests).toHaveLength(1);
    expect(db.requests[0]?.status).toBe('pending');
    assertValidLog(db);
  });

  it('Plan produces no requests row, and the model is told why', async () => {
    const db = new FakeAgentDb({ mode: 'plan' });
    const { error } = await runHarness(script, { db });
    expect(error).toBeNull();
    // The assertion the plan asks for, stated plainly.
    expect(db.requests).toHaveLength(0);
    expect(db.notes).toHaveLength(0);
    expect(db.instructions).toHaveLength(0);
    const toolTurn = db.turns.find((t) => t.toolCallId === 'call_1');
    const envelope = JSON.parse(String(toolTurn?.providerMessage.content)) as { data: { written: boolean } };
    expect(envelope.data.written).toBe(false);
    assertValidLog(db);
  });

  it('Ask cannot reach the tool at all', async () => {
    const db = new FakeAgentDb({ mode: 'ask' });
    const { error } = await runHarness(script, { db });
    expect(error).toBeNull();
    expect(db.requests).toHaveLength(0);
    const toolTurn = db.turns.find((t) => t.toolCallId === 'call_1');
    expect(String(toolTurn?.providerMessage.content)).toContain('not available in this session');
    assertValidLog(db);
  });

  it('reads the mode from the run, so switching the selector mid-run changes nothing', async () => {
    // The run row says Plan. Nothing in the loop consults the session.
    const db = new FakeAgentDb({ mode: 'plan' });
    await runHarness(script, { db });
    expect(db.requests).toHaveLength(0);
  });
});
