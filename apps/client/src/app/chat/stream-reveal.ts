/** Split text without cutting an emoji or composed character in half. */
export function splitGraphemes(text: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), ({ segment }) => segment);
  }
  return Array.from(text);
}

export function commonPrefixLength(left: readonly string[], right: readonly string[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

/**
 * Reveal a small live stream fluidly, then catch up quickly when bytes arrive
 * in a burst or the authoritative final lands. The count is based only on
 * real buffered text; it never invents progress.
 */
export function revealBatchSize(backlog: number, final: boolean): number {
  if (backlog <= 0) return 0;
  const live = backlog <= 24 ? 1 : backlog <= 80 ? 2 : backlog <= 180 ? 4 : backlog <= 420 ? 8 : 12;
  return final ? Math.max(live, Math.ceil(backlog * 0.35)) : live;
}
