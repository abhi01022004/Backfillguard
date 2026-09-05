import { useEffect, useRef } from 'react';
import type { EventType, SimulationEvent } from '@bg/shared';

/**
 * Refetches when a relevant event arrives, rather than polling.
 *
 * The live stream already says precisely when server state changed, so a timer would either lag behind it
 * or hammer the API for nothing. This runs `onTrigger` once per new matching event batch — keyed on the
 * highest matching sequence number, which is monotonic and gap-free, so a burst of ten conflicts inside one
 * frame produces one refetch rather than ten.
 *
 * Extracted because three separate hooks were about to repeat the same `reduce` plus
 * "have I already handled this sequence" bookkeeping, and the subtle part — comparing against a ref rather
 * than state so the effect does not re-run on its own output — is easy to get wrong once per copy.
 */
export function useEventTrigger(
  events: SimulationEvent[],
  types: readonly EventType[],
  onTrigger: () => void,
): void {
  const highest = events.reduce(
    (max, event) => ((types as readonly string[]).includes(event.type) ? Math.max(max, event.sequence) : max),
    0,
  );

  const handledRef = useRef(0);
  const callbackRef = useRef(onTrigger);
  callbackRef.current = onTrigger;

  useEffect(() => {
    if (highest === 0 || highest === handledRef.current) return;
    handledRef.current = highest;
    callbackRef.current();
  }, [highest]);
}
