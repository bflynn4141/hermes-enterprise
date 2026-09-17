import { describe, expect, it } from 'vitest';
import { commonPrefixLength, revealBatchSize, splitGraphemes } from './stream-reveal.js';

describe('fluid stream reveal', () => {
  it('keeps composed characters whole', () => {
    expect(splitGraphemes('A👩🏽‍💻é')).toEqual(['A', '👩🏽‍💻', 'é']);
  });

  it('uses small live batches and accelerates only to consume real backlog', () => {
    expect(revealBatchSize(12, false)).toBe(1);
    expect(revealBatchSize(70, false)).toBe(2);
    expect(revealBatchSize(300, false)).toBe(8);
    expect(revealBatchSize(1200, true)).toBe(420);
    expect(revealBatchSize(0, true)).toBe(0);
  });

  it('finds the safe boundary when the authoritative final revises a draft', () => {
    expect(commonPrefixLength(splitGraphemes('Draft answer'), splitGraphemes('Definitive answer'))).toBe(1);
    expect(commonPrefixLength(splitGraphemes('Same prefix'), splitGraphemes('Same prefix, continued'))).toBe(11);
  });
});
