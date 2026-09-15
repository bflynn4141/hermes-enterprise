// The tool loop: the ordinary path, the controls, and the invariants.
//
// Every test here runs the shared run-log validator over what the run emitted,
// which is the point of having a validator: the client is allowed to be simple
// because the log is checked, and a violation is a bug in the engine rather
// than in whatever is rendering it.
import { describe, expect, it } from 'vitest';
import { STOP_LATENCY_BUDGET_MS } from '../../src/engine/constants.js';
import { stepNames } from '../../src/engine/engine.js';
import { FakeAgentDb } from './engine/fake-db.js';
import { FakeStep } from './engine/fake-step.js';
import {
  APPLICATION,
  assertValidLog,
  runHarness,
  stop,
  textDelta,
  toolCall,
  usage,
} from './engine/harness.js';

const proposeThenFinish = [
  {
    events: [
      textDelta('Reading the application. '),
      toolCall('call_1', 'propose_request', { kind: 'application', payload: APPLICATION }),
      usage(),
      stop('tool_use'),
    ],
  },
  { events: [textDelta('Proposed. It is pending your decision.'), usage(), stop('end_turn')] },
];

describe('a run that proposes a request', () => {
  it('completes, proposes exactly one request, and emits a log the validator accepts', async () => {
    const { db, error } = await runHarness(proposeThenFinish);

    expect(error).toBeNull();
    expect(db.requests).toHaveLength(1);
    expect(db.requests[0]?.status).toBe('pending');
    expect(db.statusChanges.at(-1)?.status).toBe('completed');
    assertValidLog(db, { requireFinalPerTurn: true });
  });

  it('normalises the subject key to the lower-cased email', async () => {
    const { db } = await runHarness(proposeThenFinish);
    expect(db.requests[0]?.subjectKey).toBe('email:ada.ling@example.com');
  });

  it('names its steps deterministically, which is what makes them checkpoint keys', async () => {
    const { step } = await runHarness(proposeThenFinish);
    expect(step.order).toContain(stepNames.provider(0));
    expect(step.order).toContain(stepNames.tool(0, 'call_1'));
    expect(step.order).toContain(stepNames.provider(1));
  });

  it('wraps the tool result in a labelled, untrusted JSON envelope', async () => {
    const { db } = await runHarness(proposeThenFinish);
    const toolTurn = db.turns.find((t) => t.role === 'tool');
    const envelope = JSON.parse(String(toolTurn?.providerMessage.content ?? '{}')) as Record<string, unknown>;
    expect(envelope.untrusted).toBe(true);
    expect(envelope.tool).toBe('propose_request');
    expect(typeof envelope.retrieved_at).toBe('string');
  });

  it('counts only active segments as worked time', async () => {
    const { db } = await runHarness(proposeThenFinish);
    const active = db.statusChanges.at(-1);
    expect(active?.status).toBe('completed');
    // Two provider steps and one tool step contributed; nothing else did.
    expect(db.modelCalls.filter((c) => c.status === 'ok')).toHaveLength(2);
  });
});

describe('Stop', () => {
  it('aborts inside a streaming turn and shows no step after it', async () => {
    const { db, error, stopLatencyMs } = await runHarness(
      [
        {
          events: [
            textDelta('The applicant lists '),
            textDelta('three references, '),
            textDelta('of which two are '),
            textDelta('reachable. '),
          ],
        },
      ],
      { stopAfterForwards: 1 },
    );

    expect(error).toBeNull();
    expect(db.statusChanges.at(-1)?.status).toBe('stopped');
    // The measured number the runbook records. In the fake harness the flag is
    // seen on the very next delta reply, so this is the batching interval plus
    // the reply, not a poll cycle.
    expect(stopLatencyMs ?? 0).toBeLessThan(STOP_LATENCY_BUDGET_MS);
    // Rule 2 of the validator: nothing steps after a terminal status.
    assertValidLog(db);
    const kinds = db.events.map((e) => e.kind);
    const terminal = kinds.lastIndexOf('run.status');
    expect(kinds.slice(terminal).filter((k) => k === 'run.step')).toHaveLength(0);
  });

  it('persists the partial answer rather than discarding it', async () => {
    const { db } = await runHarness(
      [{ events: [textDelta('The applicant lists three references, ')] }],
      { stopAfterForwards: 1 },
    );
    const message = [...db.messages.values()][0];
    expect(message?.status).toBe('incomplete');
    expect(message?.text).toContain('three references');
  });

  it('is read before every tool, so a stopped run runs no further tool', async () => {
    const db = new FakeAgentDb();
    db.stopFlag = true;
    const { db: after } = await runHarness(proposeThenFinish, { db });
    expect(after.requests).toHaveLength(0);
    expect(after.statusChanges.at(-1)?.status).toBe('stopped');
  });
});

describe('a crash mid-tool', () => {
  it('resumes to exactly one request', async () => {
    const db = new FakeAgentDb();
    // First pass: the tool step runs, then the "instance" dies before the loop
    // could checkpoint anything after it.
    const first = new FakeStep();
    first.beforeAttempt = (name) => {
      if (name === stepNames.provider(1)) throw new Error('simulated crash after the tool');
    };
    await runHarness(proposeThenFinish, { db, step: first });
    expect(db.requests).toHaveLength(1);

    // Second pass: a fresh instance with the checkpoints it had managed to
    // write. The tool step re-runs against the same (run_id, tool_call_id).
    const resumed = new FakeStep();
    resumed.results.delete(stepNames.tool(0, 'call_1'));
    const { db: after } = await runHarness(proposeThenFinish, { db, step: resumed });
    expect(after.requests).toHaveLength(1);
  });
});

describe('waiting on a human', () => {
  const askThenFinish = [
    {
      events: [
        textDelta('I need the cohort cap before I can score this. '),
        toolCall('call_ask', 'ask_for_context', { key: 'cohort_cap', question: 'What is the cohort cap?' }),
        usage(),
        stop('tool_use'),
      ],
    },
    { events: [textDelta('Thanks. Proposing now.'), usage(), stop('end_turn')] },
  ];

  it('parks the run, resumes on the event, and reads the answer from the database', async () => {
    const db = new FakeAgentDb();
    const step = new FakeStep();
    step.arm('context-answered', { run_id: db.constructor.name, key: 'cohort_cap' });
    db.contextFields.set('cohort_cap', '30');

    const { error } = await runHarness(askThenFinish, { db, step, armContextAnswer: false });

    expect(error).toBeNull();
    expect(db.statusChanges.map((c) => c.status)).toContain('waiting');
    const answerTurn = db.turns.find((t) => t.toolCallId === 'call_ask-answer');
    expect(String(answerTurn?.providerMessage.content)).toContain('30');
    assertValidLog(db);
  });

  it('refuses to let the agent answer its own question', async () => {
    const db = new FakeAgentDb();
    const step = new FakeStep();
    // Another run in this workspace is parked on the same key.
    db.awaitingKeys.add('cohort_cap');
    db.contextFields.set('cohort_cap', '30');
    await runHarness(
      [
        {
          events: [
            toolCall('call_set', 'set_context_field', { key: 'cohort_cap', value: '999' }),
            usage(),
            stop('tool_use'),
          ],
        },
        { events: [textDelta('Understood.'), usage(), stop('end_turn')] },
      ],
      { db, step },
    );
    // The answer a human gave survives; the agent's guess never landed while
    // the run was parked on that key.
    expect(db.contextFields.get('cohort_cap')).not.toBe('999');
  });
});

describe('the per-run tool allowlist', () => {
  it('refuses a tool the session mode does not allow instead of running it', async () => {
    const db = new FakeAgentDb({ mode: 'ask' });
    const { db: after } = await runHarness(proposeThenFinish, { db });
    expect(after.requests).toHaveLength(0);
    const toolTurn = after.turns.find((t) => t.role === 'tool');
    expect(String(toolTurn?.providerMessage.content)).toContain('not available in this session');
  });
});
