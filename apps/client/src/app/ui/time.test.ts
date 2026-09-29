import { describe, expect, it } from 'vitest';
import { timeAgo } from './time.js';

const now = Date.parse('2026-09-28T12:00:00Z');
const before = (ms: number): string => new Date(now - ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

describe('timeAgo', () => {
  it('counts days, hours and minutes, leaving out the zeros', () => {
    expect(timeAgo(before(20_000), now)).toBe('Just now');
    expect(timeAgo(before(MIN), now)).toBe('1m ago');
    expect(timeAgo(before(2 * HOUR), now)).toBe('2h ago');
    expect(timeAgo(before(2 * HOUR + 5 * MIN), now)).toBe('2h 5m ago');
    expect(timeAgo(before(DAY), now)).toBe('1d ago');
    expect(timeAgo(before(DAY + HOUR + MIN), now)).toBe('1d 1h 1m ago');
    expect(timeAgo(before(6 * DAY + 23 * HOUR), now)).toBe('6d 23h ago');
  });

  it('names the date from a week on, and a future time reads as now', () => {
    expect(timeAgo(before(7 * DAY), now)).toMatch(/Sep 21|21 Sep/);
    expect(timeAgo(before(-5 * MIN), now)).toBe('Just now');
    expect(timeAgo('not a date', now)).toBe('');
  });
});
