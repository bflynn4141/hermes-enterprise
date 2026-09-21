import { describe, expect, it } from 'vitest';
import { FRESH_MS, arrivalBag, markArrivals } from './fresh.js';

describe('arrival marks what landed while the list was open', () => {
  it('treats everything present at mount as history', () => {
    const bag = arrivalBag('s1', ['a', 'b']);
    expect(markArrivals(bag, ['a', 'b'], { now: 1_000 })).toEqual(new Set());
  });

  it('marks an id added later, and forgets it after the window', () => {
    const bag = arrivalBag('s1', ['a']);
    expect(markArrivals(bag, ['a', 'b'], { now: 1_000 })).toEqual(new Set(['b']));
    expect(markArrivals(bag, ['a', 'b'], { now: 1_000 + FRESH_MS - 1 })).toEqual(new Set(['b']));
    expect(markArrivals(bag, ['a', 'b'], { now: 1_000 + FRESH_MS })).toEqual(new Set());
  });

  it('does not mark a hydrate that fills an empty list', () => {
    const bag = arrivalBag('s1', []);
    expect(markArrivals(bag, ['a', 'b', 'c'], { now: 1_000 })).toEqual(new Set());
    // The first thing added *after* the hydrate is news.
    expect(markArrivals(bag, ['a', 'b', 'c', 'd'], { now: 2_000 })).toEqual(new Set(['d']));
  });

  it('ignores history prepended by Load earlier when appendOnly', () => {
    const bag = arrivalBag('s1', ['m3', 'm4']);
    expect(markArrivals(bag, ['m1', 'm2', 'm3', 'm4'], { appendOnly: true, now: 1_000 })).toEqual(new Set());
    expect(markArrivals(bag, ['m1', 'm2', 'm3', 'm4', 'm5'], { appendOnly: true, now: 1_000 })).toEqual(new Set(['m5']));
  });

  it('counts a reply inserted ahead of a question that is still pending', () => {
    const bag = arrivalBag('s1', ['m1', 'm2']);
    expect(markArrivals(bag, ['m1', 'm2', 'pending'], { appendOnly: true, now: 1_000 })).toEqual(new Set(['pending']));
    expect(markArrivals(bag, ['m1', 'm2', 'reply', 'pending'], { appendOnly: true, now: 1_500 })).toEqual(new Set(['reply', 'pending']));
  });

  it('counts the first reply in a new session, whose question is already there', () => {
    const bag = arrivalBag('s1', []);
    expect(markArrivals(bag, ['question'], { appendOnly: true, now: 1_000 })).toEqual(new Set());
    expect(markArrivals(bag, ['question', 'reply'], { appendOnly: true, now: 1_500 })).toEqual(new Set(['reply']));
  });
});
