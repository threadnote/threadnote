import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'fast-check';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';

import {codeGraphDiskReservationRoot, codeGraphVectorWriteLockPath} from '@threadnote/graph/layout';
import {codeGraphVectorViewId} from '@threadnote/graph/vector/identity';
import {
  type CodeGraphRemovedViewVectorUnitEntry,
  type CodeGraphRemovedViewVectorUnitInput,
  type CodeGraphRemovedViewVectorUnitPreparation,
  type CodeGraphRemovedViewVectorUnitResult,
  withPreparedCodeGraphRemovedViewVectorUnit,
} from '@threadnote/graph/vector/maintenance';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const RemovedViewVectorTestLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);
const CHECKOUT_ID = Effect2.pipe('a', EffectString.repeat(64));
const WORKTREE_ID = Effect2.pipe('b', EffectString.repeat(64));
const SNAPSHOT_ID = `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`;
const PREPARATION = {
  deadlineMonotonicMilliseconds: Number.MAX_SAFE_INTEGER,
  reservationMode: 'nonblocking-one-attempt',
} as const;
const MODEL_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 1,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: 0,
} as const;

describe('code graph removed-view vector cleanup', () => {
  effectIt.layer(RemovedViewVectorTestLayer)(layerIt => {
    layerIt.effect('retires only the selected scope through prepared cleanup units', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-removed-vector-scope-'});
        const input = yield* makeVectorHome(fs, path, home);
        yield* makeModelDirectories(fs, path, input, 1, ['model-scoped']);
        const databasePath = modelDatabasePath(path, input, 'model-scoped');
        const scopeId = `code-graph-scope:${Effect2.pipe('c', EffectString.repeat(64))}`;
        const scopeView = codeGraphVectorViewId(WORKTREE_ID, scopeId);
        yield* Effect.sync(() => {
          seedVectorDatabase(databasePath, {vectorCount: 3});
          const database = new Database(databasePath);
          try {
            database
              .query(
                `INSERT INTO vector_generations SELECT 'generation-scoped', 'snapshot-scoped', model_id, model_sha256, dimensions, template_version, 0, state, created_at FROM vector_generations WHERE generation = 'generation-live'`,
              )
              .run();
            database
              .query('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)')
              .run(scopeView, 'generation-scoped');
          } finally {
            database.close();
          }
        });
        let entry = cleanupEntry({scopeId, expectedSnapshotId: 'snapshot-scoped'});
        let complete = false;
        for (let step = 0; step < 8; step += 1) {
          const result = yield* withPreparedCodeGraphRemovedViewVectorUnit(input, entry, PREPARATION, commit => commit);
          if (result.state === 'complete') {
            complete = true;
            break;
          }
          expect(result.state).toBe('progress');
          if (result.state !== 'progress') break;
          entry = {...entry, cursorToken: result.cursorToken};
        }
        expect(complete).toBe(true);
        expect(readVectorState(databasePath)).toMatchObject({generations: 1, pointers: 1, retirements: 0, vectors: 3});
        yield* Effect.sync(() => {
          const database = new Database(databasePath, {readonly: true});
          try {
            expect(database.query('SELECT worktree_id, generation FROM vector_pointers').all()).toEqual([
              {worktree_id: WORKTREE_ID, generation: 'generation-live'},
            ]);
          } finally {
            database.close();
          }
        });
      }),
    );
    layerIt.effect('exports the bounded prepared vector-unit adapter', () =>
      Effect.sync(() => {
        expect(typeof withPreparedCodeGraphRemovedViewVectorUnit).toBe('function');
      }),
    );

    layerIt.effect('admits sixty-four actual model names and fails closed on the sixty-fifth', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-removed-vector-inventory-'});

          const boundedHome = path.join(root, 'bounded');
          const boundedInput = yield* makeVectorHome(fs, path, boundedHome);
          yield* makeModelDirectories(fs, path, boundedInput, 64);
          const boundedDatabase = modelDatabasePath(path, boundedInput, 'model-000');
          yield* Effect.sync(() => seedVectorDatabase(boundedDatabase, {vectorCount: 0}));
          const boundedUses: string[][] = [];

          const boundedResult = yield* withPreparedCodeGraphRemovedViewVectorUnit(
            boundedInput,
            cleanupEntry(),
            PREPARATION,
            commit =>
              Effect.gen(function* () {
                boundedUses.push(yield* activeReceiptOperations(fs, path, boundedInput.threadnoteHome));
                return yield* commit;
              }),
          );

          expect(activeCursor(boundedResult)).toMatchObject({mode: 'a', modelName: 'model-000', step: 1});
          expect(boundedUses).toEqual([['prepare code graph vector retirement schema']]);
          expect(readVectorState(boundedDatabase)).toMatchObject({pointers: 1, retirementPrepared: true});
          expect(yield* activeReceiptOperations(fs, path, boundedInput.threadnoteHome)).toEqual([]);

          const overflowHome = path.join(root, 'overflow');
          const overflowInput = yield* makeVectorHome(fs, path, overflowHome);
          yield* makeModelDirectories(fs, path, overflowInput, 65);
          const overflowDatabase = modelDatabasePath(path, overflowInput, 'model-000');
          yield* Effect.sync(() => seedVectorDatabase(overflowDatabase, {vectorCount: 3}));
          const beforeOverflow = readVectorState(overflowDatabase);
          const overflowUses: string[][] = [];

          const overflowResult = yield* withPreparedCodeGraphRemovedViewVectorUnit(
            overflowInput,
            cleanupEntry(),
            PREPARATION,
            commit =>
              Effect.gen(function* () {
                overflowUses.push(yield* activeReceiptOperations(fs, path, overflowInput.threadnoteHome));
                return yield* commit;
              }),
          );

          expect(overflowResult).toEqual({
            blockedCode: 'invalid-sidecar',
            retryAfterMilliseconds: 30_000,
            state: 'deferred',
          });
          expect(overflowUses).toEqual([[]]);
          expect(readVectorState(overflowDatabase)).toEqual(beforeOverflow);
          expect(yield* activeReceiptOperations(fs, path, overflowInput.threadnoteHome)).toEqual([]);
        }),
      ),
    );

    layerIt.effect('accepts only canonical cursors and resets a valid cursor when the inventory digest changes', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-removed-vector-cursor-'});
          const input = yield* makeVectorHome(fs, path, home);
          yield* makeModelDirectories(fs, path, input, 1);
          const databasePath = modelDatabasePath(path, input, 'model-000');
          yield* Effect.sync(() => seedVectorDatabase(databasePath, {vectorCount: 2}));
          const before = readVectorState(databasePath);
          const digest = Effect2.pipe('f', EffectString.repeat(64));
          const invalid = [
            '',
            `vp1:r:${digest}:model-000`,
            `vp1:n:${digest}`,
            `vp1:a:${digest}:model-000`,
            `vp1:a:${digest}:model-000:0`,
            `vp1:a:${digest}:model-000:01`,
            `vp1:a:${digest}:Model-000:1`,
            `vp1:x:${digest}:model-000:1`,
            `vp1:a:${digest}:model-000:${Number.MAX_SAFE_INTEGER + 1}`,
          ] as const;

          yield* Effect.forEach(
            invalid,
            cursorToken =>
              Effect.gen(function* () {
                let uses = 0;
                const result = yield* withPreparedCodeGraphRemovedViewVectorUnit<void, unknown, never>(
                  input,
                  cleanupEntry({cursorToken}),
                  PREPARATION,
                  commit =>
                    Effect.sync(() => {
                      uses += 1;
                    }).pipe(Effect.andThen(commit)),
                );
                expect(result, cursorToken).toEqual({
                  blockedCode: 'invalid-sidecar',
                  retryAfterMilliseconds: 30_000,
                  state: 'deferred',
                });
                expect(uses, cursorToken).toBe(1);
                expect(readVectorState(databasePath), cursorToken).toEqual(before);
              }),
            {concurrency: 1, discard: true},
          );

          const reset = yield* withPreparedCodeGraphRemovedViewVectorUnit(
            input,
            cleanupEntry({cursorToken: `vp1:r:${digest}`}),
            PREPARATION,
            commit => commit,
          );

          const parsedReset = resetCursor(reset);
          expect(parsedReset.digest).not.toBe(digest);
          expect(readVectorState(databasePath)).toEqual(before);
          expect(yield* activeReceiptOperations(fs, path, input.threadnoteHome)).toEqual([]);

          const exhaustedStep = yield* withPreparedCodeGraphRemovedViewVectorUnit(
            input,
            cleanupEntry({
              cursorToken: `vp1:a:${parsedReset.digest}:model-000:${Number.MAX_SAFE_INTEGER}`,
            }),
            PREPARATION,
            commit => commit,
          );
          expect(exhaustedStep).toEqual({
            blockedCode: 'invalid-sidecar',
            retryAfterMilliseconds: 30_000,
            state: 'deferred',
          });
          expect(readVectorState(databasePath)).toEqual(before);
          expect(yield* activeReceiptOperations(fs, path, input.threadnoteHome)).toEqual([]);
        }),
      ),
    );

    fcEffectProp(
      layerIt,
      'fails closed for every bounded cursor outside the vp1 grammar',
      {suffix: FC.string({maxLength: 64})},
      ({suffix}) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-removed-vector-cursor-property-'});
            const input = yield* makeVectorHome(fs, path, home);
            let uses = 0;

            const result = yield* withPreparedCodeGraphRemovedViewVectorUnit<void, unknown, never>(
              input,
              cleanupEntry({cursorToken: `outside-vp1/${suffix}`}),
              PREPARATION,
              commit =>
                Effect.sync(() => {
                  uses += 1;
                }).pipe(Effect.andThen(commit)),
            );

            expect(result).toEqual({
              blockedCode: 'invalid-sidecar',
              retryAfterMilliseconds: 30_000,
              state: 'deferred',
            });
            expect(uses).toBe(1);
            expect(yield* activeReceiptOperations(fs, path, input.threadnoteHome)).toEqual([]);
          }),
        ),
      {fastCheck: {numRuns: 16}},
    );

    layerIt.effect('never enters use after inventory, planning, or marker work exhausts the absolute deadline', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-removed-vector-deadline-'});

          const overflowInput = yield* makeVectorHome(fs, path, path.join(root, 'overflow'));
          yield* makeModelDirectories(fs, path, overflowInput, 65);
          const overflowDatabase = modelDatabasePath(path, overflowInput, 'model-000');
          yield* Effect.sync(() => seedVectorDatabase(overflowDatabase, {vectorCount: 3}));
          yield* assertDeadlineStopsBeforeUse(fs, path, overflowInput, cleanupEntry(), overflowDatabase, [0, 250]);

          const input = yield* makeVectorHome(fs, path, path.join(root, 'planned'));
          yield* makeModelDirectories(fs, path, input, 1, ['model-live']);
          const databasePath = modelDatabasePath(path, input, 'model-live');
          yield* Effect.sync(() => seedVectorDatabase(databasePath, {vectorCount: 3}));

          yield* assertDeadlineStopsBeforeUse(fs, path, input, cleanupEntry(), databasePath, [0, 0, 251]);
          yield* assertDeadlineStopsBeforeUse(fs, path, input, cleanupEntry(), databasePath, [0, 0, 0, 251]);

          const prepared = activeCursor((yield* runObservedUnit(fs, path, input, cleanupEntry())).result);
          yield* assertDeadlineStopsBeforeUse(
            fs,
            path,
            input,
            cleanupEntry({cursorToken: prepared.token}),
            databasePath,
            [0, 0, 0, 251],
          );

          const pointer = activeCursor(
            (yield* runObservedUnit(fs, path, input, cleanupEntry({cursorToken: prepared.token}))).result,
          );
          yield* assertDeadlineStopsBeforeUse(
            fs,
            path,
            input,
            cleanupEntry({cursorToken: pointer.token}),
            databasePath,
            [0, 0, 0, 0, 251],
          );
          yield* assertDeadlineStopsBeforeUse(
            fs,
            path,
            input,
            cleanupEntry({cursorToken: pointer.token}),
            databasePath,
            [0, 0, 0, 0, 0, 251],
          );
        }),
      ),
    );

    layerIt.effect(
      'fails closed on a non-worker reservation mode without acquiring a receipt or mutating vectors',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-removed-vector-mode-'});
            const input = yield* makeVectorHome(fs, path, home);
            yield* makeModelDirectories(fs, path, input, 1, ['model-live']);
            const databasePath = modelDatabasePath(path, input, 'model-live');
            yield* Effect.sync(() => seedVectorDatabase(databasePath, {vectorCount: 3}));
            const before = readVectorExactState(databasePath);
            let uses = 0;
            const invalidPreparation = {
              ...PREPARATION,
              reservationMode: 'wait' as const,
            };

            const result = yield* withPreparedCodeGraphRemovedViewVectorUnit<void, unknown, never>(
              input,
              cleanupEntry(),
              // @ts-expect-error -- exercise runtime rejection of an unsupported reservation mode.
              invalidPreparation,
              commit =>
                Effect.sync(() => {
                  uses += 1;
                }).pipe(Effect.andThen(commit)),
            );

            expect(result).toEqual({
              blockedCode: 'invalid-sidecar',
              retryAfterMilliseconds: 30_000,
              state: 'deferred',
            });
            expect(uses).toBe(1);
            expect(readVectorExactState(databasePath)).toEqual(before);
            expect(yield* activeReceiptOperations(fs, path, input.threadnoteHome)).toEqual([]);
          }),
        ),
    );

    layerIt.effect('rotates from a busy or poisoned sorted model so a distinct model can progress', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-removed-vector-rotation-'});

          const busyInput = yield* makeVectorHome(fs, path, path.join(root, 'busy'));
          yield* makeModelDirectories(fs, path, busyInput, 2, ['model-a', 'model-b']);
          const busyA = modelDatabasePath(path, busyInput, 'model-a');
          const busyB = modelDatabasePath(path, busyInput, 'model-b');
          yield* Effect.sync(() => {
            seedVectorDatabase(busyA, {vectorCount: 0});
            seedVectorDatabase(busyB, {vectorCount: 0});
          });
          const busyEvents: string[] = [];
          const busyResult = yield* withExclusiveFileLock(
            fs,
            codeGraphVectorWriteLockPath(path, busyInput.threadnoteHome, CHECKOUT_ID, sha256HexSync('model-a')),
            MODEL_LOCK_OPTIONS,
            withPreparedCodeGraphRemovedViewVectorUnit(busyInput, cleanupEntry(), PREPARATION, commit =>
              Effect.gen(function* () {
                busyEvents.push(
                  `use:${EffectArray.join(yield* activeReceiptOperations(fs, path, busyInput.threadnoteHome), ',')}`,
                );
                busyEvents.push('target-enter');
                const result = yield* commit;
                busyEvents.push('target-exit');
                return result;
              }),
            ),
          );
          const busyNext = nextCursor(busyResult);
          expect(busyNext).toMatchObject({mode: 'n', modelName: 'model-a'});
          expect(progressResult(busyResult).retryAfterMilliseconds).toBe(1_000);
          expect(busyEvents).toEqual([
            'use:prepare code graph vector retirement schema',
            'target-enter',
            'target-exit',
          ]);
          expect(readVectorState(busyA).retirementPrepared).toBe(false);
          expect(readVectorState(busyB).retirementPrepared).toBe(false);

          const afterBusy = yield* runObservedUnit(fs, path, busyInput, cleanupEntry({cursorToken: busyNext.token}));
          expect(activeCursor(afterBusy.result)).toMatchObject({modelName: 'model-b', step: 1});
          expect(afterBusy.receiptsBefore).toEqual(['prepare code graph vector retirement schema']);
          expect(readVectorState(busyA).retirementPrepared).toBe(false);
          expect(readVectorState(busyB).retirementPrepared).toBe(true);

          const poisonInput = yield* makeVectorHome(fs, path, path.join(root, 'poison'));
          yield* makeModelDirectories(fs, path, poisonInput, 2, ['model-a', 'model-b']);
          const poisonA = modelDatabasePath(path, poisonInput, 'model-a');
          const poisonB = modelDatabasePath(path, poisonInput, 'model-b');
          yield* Effect.sync(() => {
            seedPoisonVectorDatabase(poisonA);
            seedVectorDatabase(poisonB, {vectorCount: 0});
          });

          const poisoned = yield* runObservedUnit(fs, path, poisonInput, cleanupEntry());
          const poisonNext = nextCursor(poisoned.result);
          expect(poisonNext).toMatchObject({modelName: 'model-a'});
          expect(poisoned.receiptsBefore).toEqual([]);
          const afterPoison = yield* runObservedUnit(
            fs,
            path,
            poisonInput,
            cleanupEntry({cursorToken: poisonNext.token}),
          );
          expect(activeCursor(afterPoison.result)).toMatchObject({modelName: 'model-b', step: 1});
          expect(afterPoison.receiptsBefore).toEqual(['prepare code graph vector retirement schema']);
          expect(readVectorState(poisonB).retirementPrepared).toBe(true);
        }),
      ),
    );

    layerIt.effect('advances prepare, pointer, and bounded marker pages before completing one model', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-removed-vector-lifecycle-'});
          const input = yield* makeVectorHome(fs, path, home);
          yield* makeModelDirectories(fs, path, input, 1, ['model-live']);
          const databasePath = modelDatabasePath(path, input, 'model-live');
          yield* Effect.sync(() => seedVectorDatabase(databasePath, {vectorCount: 2_501}));

          const prepared = yield* runObservedUnit(fs, path, input, cleanupEntry());
          const preparedCursor = activeCursor(prepared.result);
          expect(preparedCursor).toMatchObject({modelName: 'model-live', step: 1});
          expect(prepared.receiptsBefore).toEqual(['prepare code graph vector retirement schema']);
          expect(prepared.receiptsAfter).toEqual(prepared.receiptsBefore);
          expect(readVectorState(databasePath)).toMatchObject({pointers: 1, retirements: 0, vectors: 2_501});

          const pointer = yield* runObservedUnit(fs, path, input, cleanupEntry({cursorToken: preparedCursor.token}));
          const pointerCursor = activeCursor(pointer.result);
          expect(pointerCursor).toMatchObject({digest: preparedCursor.digest, modelName: 'model-live', step: 2});
          expect(pointer.receiptsBefore).toEqual(['retire code graph vector pointer']);
          expect(readVectorState(databasePath)).toMatchObject({pointers: 0, retirements: 1, vectors: 2_501});

          const firstPage = yield* runObservedUnit(fs, path, input, cleanupEntry({cursorToken: pointerCursor.token}));
          const firstPageCursor = activeCursor(firstPage.result);
          expect(firstPageCursor).toMatchObject({digest: preparedCursor.digest, modelName: 'model-live', step: 3});
          expect(firstPage.receiptsBefore).toEqual(['retire code graph vector generation']);
          expect(readVectorState(databasePath)).toMatchObject({retirements: 1, vectors: 1_501});

          const secondPage = yield* runObservedUnit(
            fs,
            path,
            input,
            cleanupEntry({cursorToken: firstPageCursor.token}),
          );
          const secondPageCursor = activeCursor(secondPage.result);
          expect(secondPageCursor.step).toBe(4);
          expect(secondPage.receiptsBefore).toEqual(['retire code graph vector generation']);
          expect(readVectorState(databasePath)).toMatchObject({retirements: 1, vectors: 501});

          const finalPage = yield* runObservedUnit(
            fs,
            path,
            input,
            cleanupEntry({cursorToken: secondPageCursor.token}),
          );
          const finalPageCursor = activeCursor(finalPage.result);
          expect(finalPageCursor.step).toBe(5);
          expect(finalPage.receiptsBefore).toEqual(['retire code graph vector generation']);
          expect(readVectorState(databasePath)).toMatchObject({generations: 0, retirements: 0, vectors: 0});

          const modelDone = yield* runObservedUnit(fs, path, input, cleanupEntry({cursorToken: finalPageCursor.token}));
          const doneCursor = nextCursor(modelDone.result);
          expect(doneCursor).toMatchObject({digest: preparedCursor.digest, modelName: 'model-live'});
          expect(modelDone.receiptsBefore).toEqual([]);

          const complete = yield* runObservedUnit(fs, path, input, cleanupEntry({cursorToken: doneCursor.token}));
          expect(complete.result).toEqual({state: 'complete'});
          expect(complete.receiptsBefore).toEqual([]);
          expect(yield* activeReceiptOperations(fs, path, input.threadnoteHome)).toEqual([]);
        }),
      ),
    );

    layerIt.effect('rechecks every bounded model before returning complete', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-removed-vector-verify-'});
          const input = yield* makeVectorHome(fs, path, home);
          yield* makeModelDirectories(fs, path, input, 1, ['model-live']);
          const databasePath = modelDatabasePath(path, input, 'model-live');
          yield* Effect.sync(() => seedVectorDatabase(databasePath, {vectorCount: 0}));

          const prepared = activeCursor((yield* runObservedUnit(fs, path, input, cleanupEntry())).result);
          const pointer = activeCursor(
            (yield* runObservedUnit(fs, path, input, cleanupEntry({cursorToken: prepared.token}))).result,
          );
          const page = activeCursor(
            (yield* runObservedUnit(fs, path, input, cleanupEntry({cursorToken: pointer.token}))).result,
          );
          const done = nextCursor(
            (yield* runObservedUnit(fs, path, input, cleanupEntry({cursorToken: page.token}))).result,
          );
          yield* Effect.sync(() => insertReappearedPointer(databasePath));
          const beforeVerification = readVectorState(databasePath);

          const verification = yield* runObservedUnit(fs, path, input, cleanupEntry({cursorToken: done.token}));

          expect(resetCursor(verification.result)).toMatchObject({digest: done.digest, mode: 'r'});
          expect(verification.receiptsBefore).toEqual([]);
          expect(readVectorState(databasePath)).toEqual(beforeVerification);
        }),
      ),
    );
  });
});

function cleanupEntry(
  overrides: Partial<CodeGraphRemovedViewVectorUnitEntry> = {},
): CodeGraphRemovedViewVectorUnitEntry {
  return {
    expectedSnapshotId: SNAPSHOT_ID,
    phase: 'vector-pointers',
    worktreeId: WORKTREE_ID,
    ...overrides,
  };
}

function makeVectorHome(fs: FileSystem.FileSystem, path: Path.Path, threadnoteHome: string) {
  const input: CodeGraphRemovedViewVectorUnitInput = {checkoutId: CHECKOUT_ID, threadnoteHome};
  return fs
    .makeDirectory(path.join(threadnoteHome, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'vectors'), {
      recursive: true,
      mode: 0o700,
    })
    .pipe(Effect.as(input));
}

function makeModelDirectories(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: CodeGraphRemovedViewVectorUnitInput,
  count: number,
  exactNames?: readonly string[],
) {
  const names =
    exactNames ??
    Array.from({length: count}, (_, index) => `model-${Effect2.pipe(index.toString(), EffectString.padStart(3, '0'))}`);
  expect(names).toHaveLength(count);
  return Effect.forEach(names, name => fs.makeDirectory(modelRoot(path, input, name), {recursive: true, mode: 0o700}), {
    concurrency: 8,
    discard: true,
  });
}

function modelRoot(path: Path.Path, input: CodeGraphRemovedViewVectorUnitInput, modelName: string): string {
  return path.join(
    input.threadnoteHome,
    'indexes',
    'code-graph',
    'repositories',
    input.checkoutId,
    'vectors',
    modelName,
  );
}

function modelDatabasePath(path: Path.Path, input: CodeGraphRemovedViewVectorUnitInput, modelName: string): string {
  return path.join(modelRoot(path, input, modelName), 'vectors-v2.sqlite');
}

function seedVectorDatabase(databasePath: string, input: {readonly vectorCount: number}): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA user_version = 2;
      CREATE TABLE vector_generations (
        generation TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_sha256 TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK(dimensions > 0),
        template_version INTEGER NOT NULL,
        count INTEGER NOT NULL CHECK(count >= 0),
        state TEXT NOT NULL CHECK(state IN ('building', 'ready')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE vector_pointers (
        worktree_id TEXT PRIMARY KEY,
        generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE
      );
      CREATE INDEX vector_pointer_generation_lookup ON vector_pointers (generation);
      CREATE TABLE vectors (
        generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE,
        symbol_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (generation, symbol_id)
      ) WITHOUT ROWID;
      CREATE INDEX vector_reuse_lookup ON vectors (generation, symbol_id, fingerprint);
    `);
    database
      .query(
        `INSERT INTO vector_generations (
           generation, snapshot_id, model_id, model_sha256, dimensions,
           template_version, count, state, created_at
         ) VALUES (?, ?, ?, ?, 384, 1, ?, 'ready', ?)`,
      )
      .run(
        'generation-live',
        SNAPSHOT_ID,
        'model-test',
        Effect2.pipe('f', EffectString.repeat(64)),
        input.vectorCount,
        new Date(0).toISOString(),
      );
    database
      .query('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)')
      .run(WORKTREE_ID, 'generation-live');
    const insertVector = database.prepare(
      'INSERT INTO vectors (generation, symbol_id, fingerprint, vector) VALUES (?, ?, ?, ?)',
    );
    database.transaction(() => {
      for (let index = 0; index < input.vectorCount; index += 1) {
        const symbolId = `symbol-${Effect2.pipe(index.toString(), EffectString.padStart(6, '0'))}`;
        insertVector.run('generation-live', symbolId, `fingerprint-${symbolId}`, new Uint8Array(16));
      }
    })();
  } finally {
    database.close(false);
  }
}

function seedPoisonVectorDatabase(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA user_version = 1; CREATE TABLE poison (value TEXT)');
    database.query('INSERT INTO poison (value) VALUES (?)').run('preserve');
  } finally {
    database.close(false);
  }
}

function insertReappearedPointer(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database
      .query(
        `INSERT INTO vector_generations (
           generation, snapshot_id, model_id, model_sha256, dimensions,
           template_version, count, state, created_at
         ) VALUES (?, ?, ?, ?, 384, 1, 0, 'ready', ?)`,
      )
      .run(
        'generation-reappeared',
        SNAPSHOT_ID,
        'model-test',
        Effect2.pipe('f', EffectString.repeat(64)),
        new Date(1).toISOString(),
      );
    database
      .query('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)')
      .run(WORKTREE_ID, 'generation-reappeared');
  } finally {
    database.close(false);
  }
}

function readVectorState(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const hasTable = (name: string) =>
      Number(
        requiredRow(
          database
            .query<
              {
                readonly count: number;
              },
              SQLQueryBindings[]
            >("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(name),
        ).count,
      ) === 1;
    const count = (table: string) =>
      Number(
        requiredRow(
          database.query<{readonly count: number}, SQLQueryBindings[]>(`SELECT COUNT(*) AS count FROM ${table}`).get(),
        ).count,
      );
    const retirementPrepared = hasTable('vector_generation_retirements');
    return {
      generations: count('vector_generations'),
      pointers: count('vector_pointers'),
      retirementPrepared,
      retirements: retirementPrepared ? count('vector_generation_retirements') : 0,
      vectors: count('vectors'),
    };
  } finally {
    database.close(false);
  }
}

function readVectorExactState(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const hasTable = (name: string) =>
      Number(
        requiredRow(
          database
            .query<
              {
                readonly count: number;
              },
              SQLQueryBindings[]
            >("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(name),
        ).count,
      ) === 1;
    const hasRetirementState = hasTable('vector_retirement_state');
    const hasRetirements = hasTable('vector_generation_retirements');
    const hasSequence = hasTable('sqlite_sequence');
    return {
      generations: database.query('SELECT * FROM vector_generations ORDER BY generation').all(),
      pageState: {
        freelistCount: database.query('PRAGMA freelist_count').get(),
        pageCount: database.query('PRAGMA page_count').get(),
        pageSize: database.query('PRAGMA page_size').get(),
      },
      pointers: database.query('SELECT * FROM vector_pointers ORDER BY worktree_id').all(),
      retirements: hasRetirements
        ? database.query('SELECT * FROM vector_generation_retirements ORDER BY retirement_id').all()
        : [],
      schema: database.query('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name').all(),
      sequence: hasSequence
        ? database
            .query(
              `SELECT rowid, typeof(name) AS name_type, hex(CAST(name AS BLOB)) AS name_hex,
                      typeof(seq) AS seq_type, seq
               FROM sqlite_sequence
               ORDER BY rowid`,
            )
            .all()
        : [],
      state: hasRetirementState ? database.query('SELECT * FROM vector_retirement_state ORDER BY singleton').all() : [],
      userVersion: database.query('PRAGMA user_version').get(),
      vectors: database
        .query(
          `SELECT generation, symbol_id, fingerprint, length(vector) AS vector_bytes
           FROM vectors
           ORDER BY generation, symbol_id`,
        )
        .all(),
    };
  } finally {
    database.close(false);
  }
}

function activeReceiptOperations(fs: FileSystem.FileSystem, path: Path.Path, threadnoteHome: string) {
  return Effect.gen(function* () {
    const root = codeGraphDiskReservationRoot(path, threadnoteHome);
    if (!(yield* fs.exists(root))) return [] as string[];
    const names = EffectArray.filter(
      yield* fs.readDirectory(root),
      __effectArrayValue => !!(name => /^v1-[0-9a-f]{64}\.json$/.test(name))(__effectArrayValue),
    ).sort();
    return yield* Effect.forEach(names, name =>
      fs.readFileString(path.join(root, name)).pipe(
        Effect.map(content => {
          const value: unknown = JSON.parse(content);
          return Effect2.Predicate.isObject(value) && typeof value.operation === 'string' ? value.operation : 'invalid';
        }),
      ),
    );
  });
}

function runObservedUnit(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: CodeGraphRemovedViewVectorUnitInput,
  entry: CodeGraphRemovedViewVectorUnitEntry,
) {
  return Effect.gen(function* () {
    let receiptsBefore: string[] = [];
    let receiptsAfter: string[] = [];
    const result = yield* withPreparedCodeGraphRemovedViewVectorUnit(input, entry, PREPARATION, commit =>
      Effect.gen(function* () {
        receiptsBefore = yield* activeReceiptOperations(fs, path, input.threadnoteHome);
        const value = yield* commit;
        receiptsAfter = yield* activeReceiptOperations(fs, path, input.threadnoteHome);
        return value;
      }),
    );
    expect(yield* activeReceiptOperations(fs, path, input.threadnoteHome)).toEqual([]);
    return {receiptsAfter, receiptsBefore, result};
  });
}

function assertDeadlineStopsBeforeUse(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: CodeGraphRemovedViewVectorUnitInput,
  entry: CodeGraphRemovedViewVectorUnitEntry,
  databasePath: string,
  readings: readonly number[],
) {
  return Effect.gen(function* () {
    const before = readVectorExactState(databasePath);
    let uses = 0;
    let reads = 0;
    const preparation: CodeGraphRemovedViewVectorUnitPreparation = {
      deadlineMonotonicMilliseconds: 250,
      monotonicMilliseconds: () => readings[Math.min(reads++, readings.length - 1)],
      reservationMode: 'nonblocking-one-attempt',
    };

    const exit = yield* withPreparedCodeGraphRemovedViewVectorUnit(input, entry, preparation, commit =>
      Effect.sync(() => {
        uses += 1;
      }).pipe(Effect.andThen(commit)),
    ).pipe(Effect.exit);

    expect(exit._tag).toBe('Failure');
    expect(reads).toBe(readings.length);
    expect(uses).toBe(0);
    expect(readVectorExactState(databasePath)).toEqual(before);
    expect(yield* activeReceiptOperations(fs, path, input.threadnoteHome)).toEqual([]);
  });
}

interface ParsedCursor {
  readonly digest: string;
  readonly mode: 'a' | 'n' | 'r';
  readonly modelName?: string;
  readonly step?: number;
  readonly token: string;
}

function progressResult(
  result: CodeGraphRemovedViewVectorUnitResult,
): Extract<CodeGraphRemovedViewVectorUnitResult, {readonly state: 'progress'}> {
  expect(result.state).toBe('progress');
  if (result.state !== 'progress') throw TestError.make({message: 'Expected vector-unit progress.'});
  return result;
}

function parseCursor(result: CodeGraphRemovedViewVectorUnitResult): ParsedCursor {
  const progress = progressResult(result);
  const match = /^vp1:(r|n|a):([0-9a-f]{64})(?::([a-z0-9][a-z0-9._-]{0,127}))?(?::([0-9]+))?$/.exec(
    progress.cursorToken,
  );
  expect(match).not.toBeNull();
  if (match === null) throw TestError.make({message: 'Vector-unit cursor is not canonical.'});
  const mode = match[1];
  if (mode !== 'r' && mode !== 'n' && mode !== 'a') {
    throw TestError.make({message: 'Vector-unit cursor mode is not recognized.'});
  }
  return {
    digest: match[2],
    mode,
    ...(match[3] === undefined ? {} : {modelName: match[3]}),
    ...(match[4] === undefined ? {} : {step: Number(match[4])}),
    token: progress.cursorToken,
  };
}

function activeCursor(result: CodeGraphRemovedViewVectorUnitResult): ParsedCursor {
  const cursor = parseCursor(result);
  expect(cursor.mode).toBe('a');
  expect(cursor.modelName).toBeDefined();
  expect(cursor.step).toBeGreaterThan(0);
  return cursor;
}

function nextCursor(result: CodeGraphRemovedViewVectorUnitResult): ParsedCursor {
  const cursor = parseCursor(result);
  expect(cursor.mode).toBe('n');
  expect(cursor.modelName).toBeDefined();
  expect(cursor.step).toBeUndefined();
  return cursor;
}

function resetCursor(result: CodeGraphRemovedViewVectorUnitResult): ParsedCursor {
  const cursor = parseCursor(result);
  expect(cursor.mode).toBe('r');
  expect(cursor.modelName).toBeUndefined();
  expect(cursor.step).toBeUndefined();
  return cursor;
}
