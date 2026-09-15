// The failure taxonomy, one test per row of the plan's table.
//
// Each of these is a scripted provider and an assertion about what the run
// looks like afterwards — the status, the error's class and `retryable`, what
// the human is left holding, and whether the Workflow should try again. The
// classes exist so that the client can say five different true things instead
// of one vague one, and a class that is never asserted is a class that drifts.
import { describe, expect, it } from 'vitest';
import { NonRetryableError } from 'cloudflare:workflows';
import { PROVIDER_STEP_RETRY_LIMIT, transientBackoffMs, TRANSIENT_BACKOFF_MAX_MS } from '../../src/engine/constants.js';
import { stepNames } from '../../src/engine/engine.js';
import { FakeAgentDb } from './engine/fake-db.js';
import {
  APPLICATION,
  assertValidLog,
  authError,
  malformedError,
  permanentError,
  runHarness,
  stop,
  textDelta,
  toolCall,
  transientError,
  usage,
} from './engine/harness.js';

describe('transient', () => {
  it('retries the step and then errors as retryable, naming the step', async () => {
    const { db, step, error } = await runHarness([{ events: [], throwAfter: transientError() }]);

    expect(step.attempts.get(stepNames.provider(0))).toBe(PROVIDER_STEP_RETRY_LIMIT);
    const last = db.statusChanges.at(-1);
    expect(last?.status).toBe('error');
    expect(last?.error).toMatchObject({ class: 'transient', retryable: true, reason: 'provider_unavailable' });
    expect(last?.error?.step_id).toBe(stepNames.provider(0));
    // Retryable, so the Workflow itself is allowed to try the instance again.
    expect(error).toBeNull();
    assertValidLog(db);
  });

  it('backs off with full jitter, which is what stops three runs retrying in lockstep', () => {
    expect(transientBackoffMs(1, 0)).toBe(0);
    expect(transientBackoffMs(1, 1)).toBe(1_000);
    expect(transientBackoffMs(4, 1)).toBe(8_000);
    expect(transientBackoffMs(99, 1)).toBe(TRANSIENT_BACKOFF_MAX_MS);
  });

  it('shows the text once when a step retries after streaming part of it', async () => {
    const { db } = await runHarness([
      { events: [textDelta('The applicant lists three ')], throwAfter: transientError() },
      { events: [textDelta('The applicant lists three references.'), usage(), stop('end_turn')] },
    ]);

    // Two attempts, two resets, and exactly one final: the reducer discards the
    // superseded attempt because the reset carries a higher `step_attempt`.
    const resets = db.events.filter((e) => e.kind === 'message.reset');
    expect(resets).toHaveLength(2);
    expect(resets.map((r) => (r.payload as { step_attempt: number }).step_attempt)).toEqual([1, 2]);
    expect(db.events.filter((e) => e.kind === 'message.final')).toHaveLength(1);
    expect([...db.messages.values()]).toHaveLength(1);
    assertValidLog(db, { requireFinalPerTurn: true });
  });
});

describe('permanent', () => {
  it('does not retry a 400, and throws NonRetryableError so the instance stops', async () => {
    const { db, step, error } = await runHarness([{ events: [], throwAfter: permanentError() }]);

    expect(step.attempts.get(stepNames.provider(0))).toBe(PROVIDER_STEP_RETRY_LIMIT);
    const last = db.statusChanges.at(-1);
    expect(last?.error).toMatchObject({ class: 'permanent', retryable: false, reason: 'provider_rejected' });
    expect(error).toBeInstanceOf(NonRetryableError);
    assertValidLog(db);
  });
});

describe('auth: a provider 401', () => {
  it('stops the run, asks the other runs on that provider to stop, and refuses to retry', async () => {
    const { db, error } = await runHarness([{ events: [], throwAfter: authError() }]);

    const last = db.statusChanges.at(-1);
    expect(last?.error).toMatchObject({ class: 'auth', retryable: false, reason: 'key_invalid' });
    // What the agent role can do. Marking the key row itself invalid is the
    // Cron's, because `agent` has no UPDATE on workspace_provider_keys.
    expect(db.otherRunsStopped).toBeGreaterThan(0);
    expect(error).toBeInstanceOf(NonRetryableError);
    assertValidLog(db);
  });

  it('records the model call as an error against the key that was rejected', async () => {
    const { db } = await runHarness([{ events: [], throwAfter: authError() }]);
    expect(db.modelCalls.at(-1)).toMatchObject({ status: 'error', keyId: 'key-1' });
  });
});

describe('malformed tool JSON', () => {
  it('sends one corrective tool_result and then gives up permanently', async () => {
    const { db, error } = await runHarness([{ events: [textDelta('Calling a tool. ')], throwAfter: malformedError() }]);

    const corrective = db.turns.filter((t) => t.toolCallId?.startsWith('malformed-'));
    expect(corrective).toHaveLength(1);
    expect(String(corrective[0]?.providerMessage.content)).toContain('valid JSON');
    expect(db.statusChanges.at(-1)?.error).toMatchObject({ class: 'permanent', reason: 'malformed_tool_json' });
    expect(error).toBeInstanceOf(NonRetryableError);
    assertValidLog(db);
  });

  it('recovers when the corrected turn succeeds', async () => {
    const { db, error } = await runHarness([
      { events: [textDelta('Calling a tool. ')], throwAfter: malformedError() },
      {
        events: [
          toolCall('call_1', 'propose_request', { kind: 'application', payload: APPLICATION }),
          usage(),
          stop('tool_use'),
        ],
      },
      { events: [textDelta('Proposed.'), usage(), stop('end_turn')] },
    ]);
    expect(error).toBeNull();
    expect(db.requests).toHaveLength(1);
  });
});

describe('a partial stream', () => {
  it('leaves the message incomplete and says so in message.final', async () => {
    const { db } = await runHarness([
      { events: [textDelta('The applicant lists three '), textDelta('references, of which ')], throwAfter: transientError() },
    ]);

    const message = [...db.messages.values()][0];
    expect(message?.status).toBe('incomplete');
    const final = db.events.find((e) => e.kind === 'message.final');
    // Nothing finalises a torn turn: the run errors as retryable and Retry
    // re-runs the turn, replacing the partial rather than appending after it.
    expect(final).toBeUndefined();
    expect(db.statusChanges.at(-1)?.error).toMatchObject({ retryable: true });
  });

  it('is replaced, not appended to, when the turn is re-run', async () => {
    const db = new FakeAgentDb();
    await runHarness([{ events: [textDelta('half a sentence')], throwAfter: transientError() }], { db });
    expect([...db.messages.values()]).toHaveLength(1);

    // A user Retry: a new attempt, a fresh instance, the same run row.
    await runHarness(
      [{ events: [textDelta('a whole sentence, this time.'), usage(), stop('end_turn')] }],
      { db, attempt: 2 },
    );
    const messages = [...db.messages.values()];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe('a whole sentence, this time.');
    expect(messages[0]?.status).toBe('complete');
  });
});

describe('no usable key', () => {
  it('errors rather than streaming half a run', async () => {
    const db = new FakeAgentDb();
    db.credential = new Error('no deepseek key in this workspace');
    const { db: after } = await runHarness([{ events: [], throwAfter: transientError() }], { db });
    expect(after.statusChanges.at(-1)?.status).toBe('error');
  });
});
