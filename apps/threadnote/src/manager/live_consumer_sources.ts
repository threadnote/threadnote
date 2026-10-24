import {Context, Effect} from 'effect';

/** The authoritative read contributes only a finite time boundary, never its payload. */
export const ManagerConsumerClockHints = Context.Reference<{
  readonly register: (
    topic: 'home' | 'automatic-memory',
    project: string,
    nextChangeAt?: number,
  ) => Effect.Effect<void>;
}>('threadnote/ManagerConsumerClockHints', {defaultValue: () => ({register: () => Effect.void})});

/** Inclusive rolling windows change one millisecond after their lower-bound timestamp. */
export function nextManagerWindowChange(
  now: number,
  periodMilliseconds: number,
  timestamps: Iterable<number>,
): number | undefined {
  let next = Infinity;
  for (const timestamp of timestamps) {
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp > now) next = Math.min(next, timestamp);
    const expires = timestamp + periodMilliseconds + 1;
    if (expires > now) next = Math.min(next, expires);
  }
  return Number.isFinite(next) ? next : undefined;
}
