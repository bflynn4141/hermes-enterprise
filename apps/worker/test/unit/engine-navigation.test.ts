// Exercise the real engine's tool execution and event validation, substituting
// only the model and persistence. Navigation must never propose a request.
import { describe, expect, it } from 'vitest';
import { FOCUS_VIEWS, streamEventSchema, viewFocusRef } from '@hermes/shared';
import { FakeAgentDb } from './engine/fake-db.js';
import { assertValidLog, runHarness, stop, textDelta, toolCall, usage } from './engine/harness.js';

const script = (args: unknown) => [
  { events: [toolCall('focus_1', 'set_focus', args), usage(), stop('tool_use')] },
  { events: [textDelta('Here is the requested view.'), usage(), stop('end_turn')] },
];
const events = (db: FakeAgentDb) => db.streamEvents().map((event) => streamEventSchema.parse(event));

describe('navigation through the run engine', () => {
  it.each(FOCUS_VIEWS)('publishes %s without writing business records', async (view) => {
    const { db, error } = await runHarness(script({ view }));
    expect(error).toBeNull();
    const focus = events(db).filter((event) => event.kind === 'run.focus');
    expect(focus).toHaveLength(1);
    expect(focus[0]?.payload).toMatchObject({ ref: viewFocusRef({ view }), entity_type: null, entity_id: null });
    expect(db.requests).toHaveLength(0);
    expect(db.notes).toHaveLength(0);
    expect(db.contextFields.size).toBe(0);
    expect(db.instructions).toHaveLength(0);
    expect(events(db).some((event) => event.kind === 'request.created')).toBe(false);
    assertValidLog(db);
  });

  it('carries the full Inbox selection in a replayable focus event', async () => {
    const filters = { status: 'resolved', kind: 'application', query: 'Ada' } as const;
    const { db, error } = await runHarness(script({ view: 'inbox', filters }));
    expect(error).toBeNull();
    expect(events(db).find((event) => event.kind === 'run.focus')?.payload).toMatchObject({
      ref: { section: 'inbox', view: 'list', filters }, entity_type: null, entity_id: null,
    });
    assertValidLog(db);
  });

  it('preserves legacy request focus and its cache hint', async () => {
    const { db } = await runHarness(script({ entity_type: 'request', entity_id: 'existing-request' }));
    expect(events(db).find((event) => event.kind === 'run.focus')?.payload).toMatchObject({
      ref: { section: 'inbox', view: 'request', id: 'existing-request' }, entity_type: 'request', entity_id: 'existing-request',
    });
    assertValidLog(db);
  });

  it.each([
    { view: 'not-built' }, { entity_type: 'unknown', entity_id: 'x' },
    { view: 'inbox', filters: { status: 'approved' } },
    { view: 'members', filters: { query: 'x' } },
    { view: 'members', entity_id: 'x' },
  ])('rejects invalid navigation without emitting focus: %j', async (input) => {
    const { db } = await runHarness(script(input));
    expect(events(db).filter((event) => event.kind === 'run.focus')).toHaveLength(0);
    expect(db.requests).toHaveLength(0);
    assertValidLog(db);
  });

  it.each(['work', 'plan'])('supports navigation in %s', async (mode) => {
    const { db, error } = await runHarness(script({ view: 'members' }), { db: new FakeAgentDb({ mode }) });
    expect(error).toBeNull();
    expect(events(db).filter((event) => event.kind === 'run.focus')).toHaveLength(1);
    expect(db.requests).toHaveLength(0);
  });

  it('does not widen the existing Ask-mode permissions', async () => {
    const { db } = await runHarness(script({ view: 'members' }), { db: new FakeAgentDb({ mode: 'ask' }) });
    expect(events(db).filter((event) => event.kind === 'run.focus')).toHaveLength(0);
    expect(db.requests).toHaveLength(0);
  });
});
