// How long ago something happened, in the words a list shows beside it.

const DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const DATE_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * "Just now", "4m ago", "2h 5m ago", "1d 1h 1m ago": days, hours and minutes,
 * leaving out any that are zero. From a week on, the date instead ("Sep 12"),
 * since "12d 3h 40m ago" is harder to read than the day it names. `compact`
 * keeps only the largest unit ("1d ago"), for a phone-width list.
 */
export function timeAgo(iso: string, now: number = Date.now(), { compact = false }: { compact?: boolean } = {}): string {
  const then = new Date(iso);
  if (Number.isNaN(then.valueOf())) return '';
  const minutes = Math.max(0, Math.floor((now - then.valueOf()) / 60_000));
  if (minutes < 1) return 'Just now';
  const days = Math.floor(minutes / 1_440);
  if (days >= 7) return (then.getFullYear() === new Date(now).getFullYear() ? DATE : DATE_YEAR).format(then);
  const hours = Math.floor((minutes % 1_440) / 60);
  const parts = [days && `${days}d`, hours && `${hours}h`, minutes % 60 && `${minutes % 60}m`].filter(Boolean);
  return `${compact ? parts[0] : parts.join(' ')} ago`;
}

/** The exact moment, for a tooltip beside `timeAgo`. */
export const fullTime = (iso: string): string => {
  const then = new Date(iso);
  return Number.isNaN(then.valueOf()) ? '' : FULL.format(then);
};
