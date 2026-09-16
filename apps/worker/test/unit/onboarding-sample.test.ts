import { describe, expect, it } from 'vitest';
import { dueSampleTransitions, SAMPLE_RUN_DURATION_MS } from '../../src/onboarding/sample-partner-runs.js';

describe('first-run sample timeline', () => {
  it('starts empty, then receives and stages both applications over eleven seconds', () => {
    expect(dueSampleTransitions(0)).toEqual([]);
    expect(dueSampleTransitions(1_000).map((step) => step.key)).toEqual(['owen:received']);
    expect(dueSampleTransitions(3_000).map((step) => step.key)).toEqual([
      'owen:received',
      'owen:researching',
      'leah:received',
    ]);
    expect(dueSampleTransitions(6_499).map((step) => step.key)).toEqual([
      'owen:received',
      'owen:researching',
      'leah:received',
      'leah:researching',
      'owen:screened',
    ]);
    expect(dueSampleTransitions(SAMPLE_RUN_DURATION_MS).map((step) => step.key)).toEqual([
      'owen:received',
      'owen:researching',
      'leah:received',
      'leah:researching',
      'owen:screened',
      'owen:needs_review',
      'leah:screened',
      'leah:needs_review',
    ]);
  });
});
