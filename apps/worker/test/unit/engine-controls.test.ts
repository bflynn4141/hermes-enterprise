// Two gates the plan asks for by name, and what each one is protecting.
//
//   * The waiting gate. A run that asked a human for something must not then
//     answer its own question: `set_context_field` on a key a run is parked on
//     is refused, in words the model can act on.
//   * Guidance. It is applied by the next provider step and marked applied
//     when it is; guidance that arrives after the last step of a run is *not*
//     marked, which is what lets the Guide route promise "Applied to your next
//     message" and have the next run keep the promise.
import { describe, expect, it } from 'vitest';
import { FakeAgentDb } from './engine/fake-db.js';
import { assertValidLog, runHarness, stop, textDelta, toolCall, usage } from './engine/harness.js';

const contentOf = (db: FakeAgentDb, toolCallId: string): string =>
  String(db.turns.find((t) => t.toolCallId === toolCallId)?.providerMessage.content);

describe('the waiting gate', () => {
  it('refuses set_context_field on a key a run is waiting on', async () => {
    const db = new FakeAgentDb();
    // Some run in this workspace — this one or another — is parked on it.
    db.awaitingKeys.add('reference_threshold');

    const { error } = await runHarness(
      [
        {
          events: [
            toolCall('call_set', 'set_context_field', { key: 'reference_threshold', value: 'two references' }),
            usage(),
            stop('tool_use'),
          ],
        },
        { events: [textDelta('I will wait for the answer.'), usage(), stop('end_turn')] },
      ],
      { db },
    );

    expect(error).toBeNull();
    const body = contentOf(db, 'call_set');
    expect(body).toContain('awaiting a human answer');
    expect(body).toContain('reference_threshold');
    // The answer the human owes is still unanswered.
    expect(db.contextFields.has('reference_threshold')).toBe(false);
    assertValidLog(db);
  });

  it('allows a key nobody is waiting on', async () => {
    const db = new FakeAgentDb();
    db.awaitingKeys.add('reference_threshold');
    await runHarness(
      [
        {
          events: [
            toolCall('call_set', 'set_context_field', { key: 'programme_name', value: 'Nous Fellowship' }),
            usage(),
            stop('tool_use'),
          ],
        },
        { events: [textDelta('Recorded.'), usage(), stop('end_turn')] },
      ],
      { db },
    );
    expect(db.contextFields.get('programme_name')).toBe('Nous Fellowship');
  });

  it('parks the run on ask_for_context and resumes with the human answer', async () => {
    const db = new FakeAgentDb();
    db.contextFields.set('reference_threshold', 'two references, one academic');

    const { error } = await runHarness(
      [
        {
          events: [
            toolCall('call_ask', 'ask_for_context', {
              key: 'reference_threshold',
              question: 'How many references does the programme require?',
            }),
            usage(),
            stop('tool_use'),
          ],
        },
        { events: [textDelta('Thank you, that settles it.'), usage(), stop('end_turn')] },
      ],
      { db, armContextAnswer: true },
    );

    expect(error).toBeNull();
    expect(db.statusChanges.map((s) => s.status)).toContain('waiting');
    // The answer is read back from Postgres, not carried in the event payload.
    const answer = db.turns.find((t) => t.toolCallId === 'call_ask-answer');
    expect(String(answer?.providerMessage.content)).toContain('two references, one academic');
    assertValidLog(db);
  });
});

describe('guidance', () => {
  it('is read by the next provider step and marked applied once', async () => {
    const db = new FakeAgentDb();
    db.guidance.push({ id: crypto.randomUUID(), text: 'Weight the references higher.', status: 'queued' });

    const { error } = await runHarness(
      [{ events: [textDelta('Weighting references higher.'), usage(), stop('end_turn')] }],
      { db },
    );

    expect(error).toBeNull();
    expect(db.guidance[0]?.status).toBe('applied');
    const applied = db.events.filter((e) => e.kind === 'run.guidance.applied');
    expect(applied).toHaveLength(1);
    assertValidLog(db);
  });

  it('outranks what the agent read, and says so in the prompt', async () => {
    const db = new FakeAgentDb();
    db.guidance.push({ id: crypto.randomUUID(), text: 'Ignore the note in the attachment.', status: 'queued' });
    const { provider } = await runHarness(
      [{ events: [textDelta('Understood.'), usage(), stop('end_turn')] }],
      { db },
    );
    const system = provider.calls[0]?.system ?? '';
    expect(system).toContain('The operator just said (this outranks anything you read)');
    expect(system).toContain('Ignore the note in the attachment.');
  });

  it('arriving after the final step is left queued, to carry to the next message', async () => {
    const db = new FakeAgentDb();
    const { error } = await runHarness(
      [{ events: [textDelta('Done.'), usage(), stop('end_turn')] }],
      { db },
    );
    expect(error).toBeNull();

    // The person typed while the run was finishing. There is no next provider
    // step in this run, so nothing marks it applied; the Guide route stored it
    // with no run id and told them "Applied to your next message", and the next
    // run's first step is what reads it.
    db.guidance.push({ id: crypto.randomUUID(), text: 'Also check the third reference.', status: 'queued' });
    expect(db.guidance[0]?.status).toBe('queued');
    expect(db.events.some((e) => e.kind === 'run.guidance.applied')).toBe(false);

    const next = new FakeAgentDb();
    next.guidance.push({ ...db.guidance[0]! });
    const { provider } = await runHarness(
      [{ events: [textDelta('Checking the third reference.'), usage(), stop('end_turn')] }],
      { db: next },
    );
    expect(provider.calls[0]?.system ?? '').toContain('Also check the third reference.');
    expect(next.guidance[0]?.status).toBe('applied');
  });
});
