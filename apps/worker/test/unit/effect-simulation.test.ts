// The simulated effect executor: which environments may use it, and that what
// it writes can never be read as a real execution.
import { describe, expect, it } from 'vitest';
import { EFFECT_KINDS, effectSimulationSchema, type EffectKind } from '@hermes/shared';
import {
  EFFECT_SIMULATED_REASON,
  effectExecutorMode,
  simulateEffect,
  simulatedEnforcement,
  simulationReference,
} from '../../src/domain/effects.js';

describe('effectExecutorMode', () => {
  it('is unavailable unless the variable asks for simulation', () => {
    expect(effectExecutorMode({ ENVIRONMENT: 'development' })).toBe('unavailable');
    expect(effectExecutorMode({ ENVIRONMENT: 'development', EFFECT_EXECUTOR_MODE: 'off' })).toBe('unavailable');
    expect(effectExecutorMode({ ENVIRONMENT: 'development', EFFECT_EXECUTOR_MODE: 'simulated' })).toBe('simulated');
    expect(effectExecutorMode({ ENVIRONMENT: 'staging', EFFECT_EXECUTOR_MODE: 'simulated' })).toBe('simulated');
  });

  it('ignores the variable in production, so a mistaken var cannot stage a customer ledger', () => {
    expect(effectExecutorMode({ ENVIRONMENT: 'production', EFFECT_EXECUTOR_MODE: 'simulated' })).toBe('unavailable');
  });
});

describe('simulateEffect', () => {
  const now = new Date('2026-09-20T12:00:00.000Z');

  it('produces a parseable record for every kind, with a visibly synthetic reference', () => {
    for (const kind of EFFECT_KINDS) {
      const simulation = simulateEffect(kind, {}, now, simulationReference(kind, () => 'ABC123'));
      expect(effectSimulationSchema.parse(simulation)).toEqual(simulation);
      expect(simulation.reference).toMatch(/^SIM-[A-Z]{3}-ABC123$/);
      expect(simulation.steps.length).toBeGreaterThanOrEqual(2);
      // Every step is in the past and in order: the receipt reads settled, not in flight.
      const times = simulation.steps.map((step) => Date.parse(step.at));
      expect(Math.max(...times)).toBeLessThan(now.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it('says in its own summary that nothing moved, was sent, granted or signed', () => {
    const summaries: Record<EffectKind, string> = {
      payment: simulateEffect('payment', { payeeName: 'Robin Ellis', currency: 'usd', totalMinor: 90000 }, now).summary,
      signature: simulateEffect('signature', { documentNumber: 'AGR-1', parties: ['Nous Research', 'Robin Ellis'] }, now).summary,
      email_send: simulateEffect('email_send', { documentNumber: 'INV-1', payeeName: 'Robin Ellis' }, now).summary,
      access_grant: simulateEffect('access_grant', { subjectName: 'ada@example.test' }, now).summary,
    };
    expect(summaries.payment).toBe('USD 900.00 to Robin Ellis · simulated settlement · no money moved');
    expect(summaries.signature).toBe('AGR-1 · 2 simulated signatures · nothing legally signed');
    expect(summaries.email_send).toBe('INV-1 to Robin Ellis · simulated delivery · no email sent');
    expect(summaries.access_grant).toBe('Workspace access for ada@example.test · simulated grant · no access changed');
  });

  it('names signers from the agreement parties and caps them', () => {
    const simulation = simulateEffect('signature', { parties: ['A', 'B', 'C', 'D'] }, now);
    const signed = simulation.steps.filter((step) => step.label.endsWith('signed (simulated)'));
    expect(signed.map((step) => step.label)).toEqual(['A signed (simulated)', 'B signed (simulated)', 'C signed (simulated)']);
    expect(simulation.steps.length).toBeLessThanOrEqual(6);
  });
});

describe('simulatedEnforcement', () => {
  it('records result simulated, never executed, with the honest sentence', () => {
    const record = simulatedEnforcement('user-1', simulateEffect('payment', {}, new Date()));
    expect(record.result).toBe('simulated');
    expect(record.reason).toBe(EFFECT_SIMULATED_REASON);
    expect(record.reason).toMatch(/no email, payment, access or signature action was completed/i);
    expect(JSON.stringify(record)).not.toMatch(/"result":"executed"/);
  });
});
