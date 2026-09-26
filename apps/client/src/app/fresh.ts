// "This just arrived", decided by the client rather than by a timestamp.
//
// A receipt that settles in and an Inbox row that slides down are the two
// moments where something the agent did reaches a person, and both are only
// worth animating when they happen *while somebody is looking*. The obvious
// signal — `created_at` within the last few seconds — is wrong twice over: a
// session opened a moment after its reply landed would animate history, and a
// fixture dated in the future would animate forever. So the rule is arrival:
// an id is fresh when it was added to a list this component already held,
// and only for `FRESH_MS` after that.
//
// Two additions never count. Everything the list had at mount, or after a
// scope change (a different session, a different workspace), is history. And
// a batch that fills an *empty* list is a hydrate, not an arrival — the first
// reply in a new session still counts, because the question is already there.
import { useEffect, useRef, useState } from 'react';

export const FRESH_MS = 5_000;

export interface ArrivalBag {
  scope: string;
  known: Set<string>;
  arrived: Map<string, number>;
}

export function arrivalBag(scope: string, ids: readonly string[]): ArrivalBag {
  return { scope, known: new Set(ids), arrived: new Map() };
}

/**
 * Record what `ids` adds to the bag and answer which of them are still fresh.
 *
 * `appendOnly` is for ordered lists such as a transcript: ids *before* the
 * first one already known are history that `Load earlier` prepended, not new
 * mail. Anything after that point counts, wherever it lands — a reply is
 * inserted ahead of a still-pending question, and it is the reply that is new.
 */
export function markArrivals(bag: ArrivalBag, ids: readonly string[], options: { appendOnly?: boolean; now?: number } = {}): Set<string> {
  const now = options.now ?? Date.now();
  const { known, arrived } = bag;
  const fresh = new Set<string>();
  const hydrating = known.size === 0;
  const start = options.appendOnly ? Math.max(0, ids.findIndex((id) => known.has(id))) : 0;
  ids.forEach((id, index) => {
    if (!known.has(id)) {
      known.add(id);
      if (!hydrating && index >= start) arrived.set(id, now);
    }
    const at = arrived.get(id);
    if (at === undefined) return;
    if (now - at < FRESH_MS) fresh.add(id);
    else arrived.delete(id);
  });
  return fresh;
}

/** The ids in `ids` that arrived in the last `FRESH_MS`, by the rule above. A new `scope` starts over. */
export function useFreshIds(scope: string, ids: readonly string[], options: { appendOnly?: boolean; now?: number } = {}): ReadonlySet<string> {
  const bag = useRef<ArrivalBag | null>(null);
  if (!bag.current || bag.current.scope !== scope) bag.current = arrivalBag(scope, ids);
  return markArrivals(bag.current, ids, options);
}

export const BUMP_MS = 600;

/**
 * `true` for `BUMP_MS` after `value` goes up. A count that fell, or that
 * loaded with the page, is not news; one that rose while the page was open
 * is, and the caller turns this into a short-lived attribute.
 */
export function useBump(value: number): boolean {
  const previous = useRef(value);
  const [bumping, setBumping] = useState(false);
  useEffect(() => {
    const grew = value > previous.current;
    previous.current = value;
    if (!grew) return;
    setBumping(true);
    const timer = window.setTimeout(() => setBumping(false), BUMP_MS);
    return () => window.clearTimeout(timer);
  }, [value]);
  return bumping;
}
