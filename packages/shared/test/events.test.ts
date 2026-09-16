import { describe, expect, it } from 'vitest';
import {
  EVENT_KINDS_CONTRACT,
  EVENT_STREAM,
  SCHEMA_VERSION,
  isAgentWritableKind,
  mockRunStream,
  parseStreamEvent,
  safeParseStreamEvent,
  streamEventSchema,
  sameRef,
  refSchema,
  REQ,
  CTX_DEST,
  CTX,
} from '../src/index.js';

describe('event contract', () => {
  it('covers every kind the plan names, each carrying a schema_version', () => {
    const expected = [
      'run.started',
      'run.step',
      'run.status',
      'run.focus',
      'run.guidance.applied',
      'run.queue.updated',
      'message.appended',
      'message.delta',
      'message.reset',
      'message.final',
      'request.created',
      'decision.recorded',
      'entity.updated',
      'member.agent_joined',
      'resync',
    ];
    expect([...EVENT_KINDS_CONTRACT]).toEqual(expected);
    for (const kind of expected) expect(EVENT_STREAM[kind as keyof typeof EVENT_STREAM]).toBeDefined();
  });

  it('validates the invitation-derived member and agent join event', () => {
    expect(streamEventSchema.safeParse({
      id: '15',
      workspace_id: '00000000-0000-4000-8000-000000000001',
      session_id: null,
      schema_version: SCHEMA_VERSION,
      trace_id: 'invite-accepted',
      at: '2026-09-15T18:00:00.000Z',
      kind: 'member.agent_joined',
      payload: {
        source: 'invitation.accepted',
        invitation_id: '00000000-0000-4000-8000-000000000002',
        member_id: '00000000-0000-4000-8000-000000000003',
        agent_id: '00000000-0000-4000-8000-000000000004',
        coordination_request_id: '00000000-0000-4000-8000-000000000005',
      },
    }).success).toBe(true);
  });

  it('round-trips every event the mock stream produces', () => {
    const scenarios = ['completed', 'stopped', 'step_retry', 'waiting', 'error_retryable', 'proposes_request'] as const;
    for (const scenario of scenarios) {
      const events = mockRunStream(scenario);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.schema_version).toBe(SCHEMA_VERSION);
        const json: unknown = JSON.parse(JSON.stringify(event));
        expect(parseStreamEvent(json)).toEqual(event);
      }
    }
  });

  it('rejects an unknown kind and an unknown payload field', () => {
    const [first] = mockRunStream('completed');
    expect(safeParseStreamEvent({ ...first, kind: 'run.telepathy' }).success).toBe(false);
    const forged = { ...first!, payload: { ...first!.payload, smuggled: true } };
    expect(safeParseStreamEvent(forged).success).toBe(false);
  });

  it('rejects a non-numeric stream id, because replay compares ids', () => {
    const [first] = mockRunStream('completed');
    expect(safeParseStreamEvent({ ...first, id: 'head' }).success).toBe(false);
    expect(streamEventSchema.safeParse({ ...first, id: '9223372036854775807' }).success).toBe(true);
  });

  it('names exactly the prefixes the agent role may write', () => {
    expect(isAgentWritableKind('message.delta')).toBe(true);
    expect(isAgentWritableKind('run.step')).toBe(true);
    expect(isAgentWritableKind('decision.recorded')).toBe(false);
    expect(isAgentWritableKind('request.created')).toBe(false);
    expect(isAgentWritableKind('entity.updated')).toBe(false);
  });
});

describe('refs', () => {
  it('parses the demo shapes and rejects an unknown section', () => {
    expect(refSchema.parse(REQ('leah'))).toEqual({ section: 'inbox', view: 'request', id: 'leah' });
    expect(refSchema.safeParse({ section: 'nowhere' }).success).toBe(false);
  });

  it('compares the field the demo forgot', () => {
    expect(sameRef(CTX, CTX)).toBe(true);
    // The demo's sameRef returned true here because it never compared `field`.
    expect(sameRef(CTX, CTX_DEST)).toBe(false);
    expect(sameRef(null, CTX)).toBe(false);
  });
});
