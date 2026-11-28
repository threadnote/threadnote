import {Database} from 'bun:sqlite';
import {Array as EffectArray, Effect} from 'effect';
import {vi} from 'vitest';
import {loadRecallIndexData, recallIndexStatus} from '../src/index.js';
import * as PreparationSource from '../src/index/vector-preparation-source.js';

/** The URIs of every body read at the vector preparation source port while the enclosing scope is open. */
export const recordRecallBodyReads = Effect.gen(function* () {
  const reads: string[] = [];
  const open = PreparationSource.openRecallVectorPreparationSource;
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      vi.spyOn(PreparationSource, 'openRecallVectorPreparationSource').mockImplementation(scope =>
        open(scope).pipe(
          Effect.map(source => ({
            ...source,
            hydrate: (metadata: Parameters<typeof source.hydrate>[0], options?: Parameters<typeof source.hydrate>[1]) =>
              Effect.sync(() => reads.push(...EffectArray.map(metadata, candidate => candidate.uri))).pipe(
                Effect.andThen(source.hydrate(metadata, options)),
              ),
          })),
        ),
      ),
    ),
    spy => Effect.sync(() => spy.mockRestore()),
  );
  return reads;
});

/**
 * Makes the next vector build a full walk over the same documents: a forced lexical refresh publishes a new
 * corpus generation, and without the lexical change log the build cannot plan a delta.
 */
export const forceRecallFullVectorWalk = (config: Parameters<typeof loadRecallIndexData>[0]) =>
  Effect.gen(function* () {
    yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false, memoryIds: []});
    yield* dropRecallChangeLog(config);
  });

/** Drops the lexical change log, so the next vector build of a new corpus generation is a full walk. */
export const dropRecallChangeLog = (config: Parameters<typeof loadRecallIndexData>[0]) =>
  Effect.gen(function* () {
    const lexical = (yield* recallIndexStatus(config, false)).databasePath;
    yield* Effect.sync(() => {
      const db = new Database(lexical);
      try {
        db.exec('PRAGMA foreign_keys = ON; DELETE FROM recall_change_publications');
      } finally {
        db.close();
      }
    });
  });
