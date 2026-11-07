import {Console, Effect} from 'effect';
import {
  activePersonalMemoryUrisFromText,
  existingReferencedUris,
  formatReferencedContextPointers,
  recallHygieneNudges,
  referencedUrisFromRecords,
  type MemoryRecord,
} from '@threadnote/memory/hygiene';

type ReadRecords<E, R> = (uris: readonly string[]) => Effect.Effect<readonly MemoryRecord[], E, R>;
const MAX_REFERENCED_CONTEXT = 5;

/**
 * Resolves the one-way `references:` pointers carried by the personal memories
 * recall just surfaced and appends bounded URI-only pointers. The caller can
 * explicitly read a relevant pointer without recall inlining unrelated text.
 */
export const referencedContextSection = Effect.fn('memory.referencedContextSection')(function* <E, R>(
  user: string,
  recallOutput: string,
  readRecords: ReadRecords<E, R>,
) {
  const surfacedUris = activePersonalMemoryUrisFromText(recallOutput, user);
  if (surfacedUris.length === 0) return undefined;
  const surfaced = yield* readRecords(surfacedUris);
  const referenced = referencedUrisFromRecords(surfaced, recallOutput);
  if (referenced.length === 0) return undefined;
  const candidates = referenced.slice(0, MAX_REFERENCED_CONTEXT);
  const existingRecords = yield* readRecords(candidates);
  return formatReferencedContextPointers(existingReferencedUris(candidates, existingRecords), MAX_REFERENCED_CONTEXT);
});

export const printRecallHygieneNudges = Effect.fn('memory.printRecallHygieneNudges')(function* <E, R>(
  user: string,
  recallOutput: string,
  readRecords: ReadRecords<E, R>,
) {
  const uris = activePersonalMemoryUrisFromText(recallOutput, user);
  if (uris.length === 0) return;
  const records = yield* readRecords(uris);
  const nudges = recallHygieneNudges(recallOutput, {records, user});
  if (nudges.length === 0) return;
  yield* Console.log('\nMemory hygiene hints:');
  for (const nudge of nudges) yield* Console.log(`- ${nudge}`);
});
