import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Crypto, Deferred, Effect, Fiber, FileSystem, Layer, Path, Schema} from 'effect';
import * as FC from 'fast-check';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  CODE_GRAPH_VECTOR_RETIREMENT_ORDINARY_UNIT_CAPACITY_CALIBRATION,
  codeGraphDiskCapacityFailure,
  codeGraphVectorRetirementCapacityDemand,
  evaluateCodeGraphDiskCapacity,
} from '@threadnote/graph/disk/capacity';
import {SystemInfo} from '@threadnote/platform/system';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {
  type CodeGraphVectorRetirementCapacityProtector,
  type CodeGraphOrdinaryVectorMaintenanceUnitInput,
  type CodeGraphOrdinaryVectorMaintenanceUnitResult,
  admitOneCodeGraphVectorRetirementWithCapacity,
  codeGraphOrdinaryVectorMaintenanceBoundary,
  deleteCodeGraphVectorPointerWithRetirement,
  prepareCodeGraphVectorRetirement,
  runCodeGraphOrdinaryVectorMaintenanceUnit,
} from '@threadnote/graph/vector/maintenance';
import {
  codeGraphDiskReservationRoot,
  codeGraphVectorRetirementCursorLockPath,
  codeGraphVectorWriteLockPath,
} from '@threadnote/graph/layout';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const OrdinaryVectorTestLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);
const CHECKOUT_ID = Effect2.pipe('a', EffectString.repeat(64));
const PREPARATION = {
  deadlineMonotonicMilliseconds: 250,
  monotonicMilliseconds: () => 0,
  reservationMode: 'nonblocking-one-attempt',
} as const;
const CURSOR_FILE = '.ordinary-vector-retirement-v1.cursor';
const CURSOR_TEMPORARY = '.ordinary-vector-retirement-v1.cursor.tmp';
const identityCapacityProtector: CodeGraphVectorRetirementCapacityProtector = (_boundary, transaction) => transaction;

describe('code graph ordinary vector retirement maintenance', () => {
  effectIt.layer(OrdinaryVectorTestLayer)(layerIt => {
    layerIt.effect('binds the distinct combined boundary, calibration, and pressure operation', () =>
      Effect.sync(() => {
        const databaseBoundary = {
          finalFactBytes: 31,
          operation: 'retire code graph vector generation',
          rowCount: 7,
        } as const;
        const intent = 'intent';
        const finals = ['f', 'largest-final'];
        const boundary = codeGraphOrdinaryVectorMaintenanceBoundary(databaseBoundary, intent, finals);

        expect(boundary).toEqual({
          finalFactBytes:
            databaseBoundary.finalFactBytes +
            new TextEncoder().encode(`${intent}\n`).byteLength +
            new TextEncoder().encode(`${finals[1]}\n`).byteLength +
            2_048,
          operation: 'maintain code graph vector retirement',
          rowCount: databaseBoundary.rowCount + 4,
        });

        const demand = codeGraphVectorRetirementCapacityDemand({
          finalFactBytes: boundary.finalFactBytes,
          lexicalFormatVersion: 1,
          operation: boundary.operation,
          pageSize: 4_096,
          rowCount: boundary.rowCount,
          walAutoCheckpointPages: 1_000,
        });
        expect(demand.calibrationIdentity).toBe(
          `${CODE_GRAPH_VECTOR_RETIREMENT_ORDINARY_UNIT_CAPACITY_CALIBRATION.identityBase}:` +
            'lexical-1:page-4096:wal-1000',
        );
        const decision = evaluateCodeGraphDiskCapacity({
          demand,
          durableAvailableBytes: 0,
          filesystemsShared: false,
          freelistBytes: 0,
          reservedDurableBytes: 0,
          reservedTemporaryBytes: 0,
          temporaryAvailableBytes: Number.MAX_SAFE_INTEGER,
        });
        expect(decision.state).toBe('pressure');
        expect(codeGraphDiskCapacityFailure(decision, boundary.operation).operation).toBe(
          'maintain code graph vector retirement',
        );
      }),
    );

    fcEffectProp(
      layerIt,
      'adds exact cursor bytes and four rows deterministically for every bounded DB shape',
      {
        databaseBytes: FC.integer({max: 32 * 1_024 * 1_024, min: 0}),
        databaseRows: FC.integer({max: 1_004, min: 0}),
        final: FC.string({maxLength: 32}),
        intent: FC.string({maxLength: 32}),
      },
      ({databaseBytes, databaseRows, final, intent}) =>
        Effect.sync(() => {
          const boundary = codeGraphOrdinaryVectorMaintenanceBoundary(
            {
              finalFactBytes: databaseBytes,
              operation: 'admit code graph vector retirement',
              rowCount: databaseRows,
            },
            intent,
            [final],
          );
          expect(boundary).toEqual({
            finalFactBytes:
              databaseBytes +
              new TextEncoder().encode(`${intent}\n`).byteLength +
              new TextEncoder().encode(`${final}\n`).byteLength +
              2_048,
            operation: 'maintain code graph vector retirement',
            rowCount: databaseRows + 4,
          });
        }),
      {fastCheck: {numRuns: 32}},
    );

    layerIt.effect('stops after one rejected nonblocking receipt with zero cursor or DB mutation', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-pressure-'});
          const input = yield* makeVectorHome(fs, path, home);
          const databasePath = yield* makeModelDatabase(fs, path, input, 'model-a', [
            {generation: 'generation-a', vectorCount: 1},
          ]);
          let attempts = 0;
          const result = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(input, {
            ...PREPARATION,
            availableDiskBytes: () => Effect.succeed(0),
            beforeCapacityAttempt: boundary =>
              Effect.sync(() => {
                attempts += 1;
                expect(boundary.operation).toBe('maintain code graph vector retirement');
              }),
          });

          expect(result).toEqual({
            blockedCode: 'model-unavailable',
            retryAfterMilliseconds: 1_000,
            state: 'deferred',
          });
          expect(attempts).toBe(1);
          expect(yield* fs.exists(vectorCursorPath(path, input))).toBe(false);
          expect(hasTable(databasePath, 'vector_generation_retirements')).toBe(false);
          expect(readGenerations(databasePath)).toEqual(['generation-a']);
        }),
      ),
    );

    layerIt.effect('publishes intent only inside the ordinary receipt and recovers after a pre-lock crash', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-crash-'});
          const input = yield* makeVectorHome(fs, path, home);
          const databasePath = yield* makeModelDatabase(fs, path, input, 'model-a', [
            {generation: 'generation-a', vectorCount: 1},
          ]);
          let receiptOperations: string[] = [];

          const crashed = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(input, {
            ...PREPARATION,
            beforeModelCommit: () =>
              activeReceiptOperations(fs, path, input.threadnoteHome).pipe(
                Effect.tap(operations =>
                  Effect.sync(() => {
                    receiptOperations = operations;
                  }),
                ),
                Effect.andThen(Effect.fail(TestError.make({message: 'simulated crash after protected intent'}))),
              ),
          });

          expect(crashed.state).toBe('progress');
          expect(receiptOperations).toEqual(['maintain code graph vector retirement']);
          expect(yield* activeReceiptOperations(fs, path, input.threadnoteHome)).toEqual([]);
          expect(yield* fs.exists(vectorCursorPath(path, input))).toBe(true);
          expect(hasTable(databasePath, 'vector_generation_retirements')).toBe(false);

          expect((yield* runUntilComplete(input, 24)).at(-1)).toEqual({state: 'complete'});
          expect(readGenerations(databasePath)).toEqual([]);
        }),
      ),
    );

    layerIt.effect('recovers idempotently when schema, admission, or page commits before final cursor CAS', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-post-commit-'});
          const scenarios = ['schema', 'admission', 'page'] as const;

          for (const scenario of scenarios) {
            const input = yield* makeVectorHome(fs, path, path.join(root, scenario));
            const databasePath = yield* makeModelDatabase(fs, path, input, 'model-a', [
              {generation: 'generation-a', vectorCount: 1},
            ]);
            if (scenario !== 'schema') yield* prepareRetirementUntilReady(databasePath);
            if (scenario === 'page') {
              expect(
                yield* admitOneCodeGraphVectorRetirementWithCapacity(databasePath, {
                  capacityProtector: identityCapacityProtector,
                }),
              ).toMatchObject({generation: 'generation-a', state: 'admitted'});
              expect(
                yield* admitOneCodeGraphVectorRetirementWithCapacity(databasePath, {
                  capacityProtector: identityCapacityProtector,
                }),
              ).toEqual({state: 'wrapped'});
            }
            const sequenceBefore = readRetirementSequence(databasePath);
            let interrupted = 0;
            const crashed = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(input, {
              ...PREPARATION,
              afterModelCommitBeforeFinalCursorCas: () =>
                Effect.suspend(() => {
                  interrupted += 1;
                  return Effect.fail(TestError.make({message: `simulated ${scenario} post-commit crash`}));
                }),
            });

            expect(crashed.state, scenario).toBe('progress');
            expect(interrupted, scenario).toBe(1);
            expect(yield* fs.exists(vectorCursorPath(path, input)), scenario).toBe(true);
            expect(yield* activeReceiptOperations(fs, path, input.threadnoteHome), scenario).toEqual([]);
            expect(yield* fs.exists(modelWriteLockPath(path, input, 'model-a')), scenario).toBe(false);
            expect(
              yield* fs.exists(codeGraphVectorRetirementCursorLockPath(path, input.threadnoteHome, input.checkoutId)),
              scenario,
            ).toBe(false);

            if (scenario === 'schema') {
              expect(hasTable(databasePath, 'vector_generation_retirements')).toBe(true);
              expect(readRetirementMarkers(databasePath)).toEqual([]);
              expect(readGenerations(databasePath)).toEqual(['generation-a']);
            } else if (scenario === 'admission') {
              expect(readRetirementMarkers(databasePath)).toEqual([
                {generation: 'generation-a', retiredByWorktreeId: null},
              ]);
              expect(readRetirementSequence(databasePath)).toBe(sequenceBefore + 1);
            } else {
              expect(readGenerations(databasePath)).toEqual([]);
              expect(readRetirementMarkers(databasePath)).toEqual([]);
              expect(readRetirementSequence(databasePath)).toBe(sequenceBefore);
            }

            expect((yield* runUntilComplete(input, 32)).at(-1), scenario).toEqual({state: 'complete'});
            expect(readRetirementSequence(databasePath), scenario).toBeLessThanOrEqual(sequenceBefore + 1);
          }
        }),
      ),
    );

    layerIt.effect('releases receipt and locks when interrupted after DB commit before final cursor CAS', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-post-commit-cancel-'});
          const input = yield* makeVectorHome(fs, path, home);
          const databasePath = yield* makeModelDatabase(fs, path, input, 'model-a', [
            {generation: 'generation-a', vectorCount: 0},
          ]);
          yield* prepareRetirementUntilReady(databasePath);
          const commitCompleted = yield* Deferred.make<void>();

          const running = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(input, {
            ...PREPARATION,
            afterModelCommitBeforeFinalCursorCas: () =>
              Deferred.succeed(commitCompleted, undefined).pipe(Effect.andThen(Effect.never)),
          }).pipe(Effect.forkChild({startImmediately: true}));
          yield* Deferred.await(commitCompleted);

          expect(readRetirementMarkers(databasePath)).toEqual([
            {generation: 'generation-a', retiredByWorktreeId: null},
          ]);
          expect(readRetirementSequence(databasePath)).toBe(1);
          expect(yield* fs.exists(vectorCursorPath(path, input))).toBe(true);
          expect(yield* activeReceiptOperations(fs, path, input.threadnoteHome)).toEqual([
            'maintain code graph vector retirement',
          ]);

          yield* Fiber.interrupt(running);

          expect(yield* activeReceiptOperations(fs, path, input.threadnoteHome)).toEqual([]);
          expect(yield* fs.exists(modelWriteLockPath(path, input, 'model-a'))).toBe(false);
          expect(
            yield* fs.exists(codeGraphVectorRetirementCursorLockPath(path, input.threadnoteHome, input.checkoutId)),
          ).toBe(false);
          expect((yield* runUntilComplete(input, 32)).at(-1)).toEqual({state: 'complete'});
          expect(readGenerations(databasePath)).toEqual([]);
          expect(readRetirementMarkers(databasePath)).toEqual([]);
          expect(readRetirementSequence(databasePath)).toBe(1);
        }),
      ),
    );

    layerIt.effect('persists bounded clean-model checkpoints across sixty-four delayed process-style ticks', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-delayed-clean-'});
          const input = yield* makeVectorHome(fs, path, home);
          const names = Array.from(
            {length: 64},
            (_, index) => `model-${Effect2.pipe(index.toString(), EffectString.padStart(3, '0'))}`,
          );
          yield* Effect.forEach(
            names,
            name =>
              makeModelDatabase(fs, path, input, name, []).pipe(
                Effect.flatMap(databasePath =>
                  prepareRetirementUntilReady(databasePath).pipe(
                    Effect.andThen(
                      admitOneCodeGraphVectorRetirementWithCapacity(databasePath, {
                        capacityProtector: identityCapacityProtector,
                      }),
                    ),
                  ),
                ),
              ),
            {concurrency: 8, discard: true},
          );

          const tokens = new Set<string>();
          let final: CodeGraphOrdinaryVectorMaintenanceUnitResult | undefined;
          for (let tick = 0; tick < 64; tick += 1) {
            let now = -1;
            final = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(input, {
              deadlineMonotonicMilliseconds: 250,
              monotonicMilliseconds: () => ++now,
              reservationMode: 'nonblocking-one-attempt',
            });
            if (final.state === 'progress') tokens.add(final.cursorToken);
            if (final.state === 'complete') break;
          }

          expect(final).toEqual({state: 'complete'});
          expect(tokens.size).toBe(63);
        }),
      ),
    );

    layerIt.effect('completes empty roots, sixty-four empty model directories, and a vanished sole database', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-empty-'});

          const empty = yield* makeVectorHome(fs, path, path.join(root, 'empty'));
          expect(yield* runCodeGraphOrdinaryVectorMaintenanceUnit(empty, PREPARATION)).toEqual({state: 'complete'});
          expect(yield* fs.exists(vectorCursorPath(path, empty))).toBe(false);

          const directories = yield* makeVectorHome(fs, path, path.join(root, 'directories'));
          yield* makeModelDirectories(fs, path, directories, 64);
          expect(yield* runCodeGraphOrdinaryVectorMaintenanceUnit(directories, PREPARATION)).toEqual({
            state: 'complete',
          });
          expect(yield* fs.exists(vectorCursorPath(path, directories))).toBe(false);

          const vanished = yield* makeVectorHome(fs, path, path.join(root, 'vanished'));
          const databasePath = yield* makeModelDatabase(fs, path, vanished, 'model-a', [
            {generation: 'generation-a', vectorCount: 0},
          ]);
          const result = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(vanished, {
            ...PREPARATION,
            beforeInitialCursorLock: () => fs.remove(databasePath),
          });
          expect(result).toEqual({state: 'complete'});
          expect(yield* fs.exists(vectorCursorPath(path, vanished))).toBe(false);
        }),
      ),
    );

    layerIt.effect('keeps cursor locking outside a root replaced with an external symlink', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-root-race-'});
          const input = yield* makeVectorHome(fs, path, path.join(root, 'home'));
          const databasePath = yield* makeModelDatabase(fs, path, input, 'model-a', [
            {generation: 'generation-a', vectorCount: 1},
          ]);
          const originalRoot = vectorRoot(path, input);
          const movedRoot = path.join(root, 'moved-vectors');
          const external = path.join(root, 'external');
          yield* fs.makeDirectory(external, {recursive: true, mode: 0o700});
          yield* fs.writeFileString(path.join(external, 'sentinel'), 'preserve', {flag: 'wx'});

          const result = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(input, {
            ...PREPARATION,
            beforeInitialCursorLock: () =>
              fs.rename(originalRoot, movedRoot).pipe(Effect.andThen(fs.symlink(external, originalRoot))),
          });

          expect(result).toEqual({blockedCode: 'io-error', retryAfterMilliseconds: 1_000, state: 'deferred'});
          expect((yield* fs.readDirectory(external)).sort()).toEqual(['sentinel']);
          expect(yield* fs.readFileString(path.join(external, 'sentinel'))).toBe('preserve');
          expect(readGenerations(path.join(movedRoot, 'model-a', 'vectors-v2.sqlite'))).toEqual(['generation-a']);
          expect(databasePath).toBe(path.join(originalRoot, 'model-a', 'vectors-v2.sqlite'));
        }),
      ),
    );

    layerIt.effect('retires first-only zero-pointer and later orphan generations', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-first-only-'});
          const input = yield* makeVectorHome(fs, path, home);
          const databasePath = yield* makeModelDatabase(fs, path, input, 'model-a', [
            {generation: 'generation-live', pointer: Effect2.pipe('b', EffectString.repeat(64)), vectorCount: 0},
            {generation: 'generation-orphan', vectorCount: 0},
          ]);

          const results = yield* runUntilComplete(input, 32);

          expect(results.at(-1)).toEqual({state: 'complete'});
          expect(readGenerations(databasePath)).toEqual(['generation-live']);
          expect(yield* fs.exists(vectorCursorPath(path, input))).toBe(true);
        }),
      ),
    );

    layerIt.effect('retires an associated pointer marker through the same global ordinary page lane', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-associated-'});
          const input = yield* makeVectorHome(fs, path, home);
          const worktreeId = Effect2.pipe('c', EffectString.repeat(64));
          const databasePath = yield* makeModelDatabase(fs, path, input, 'model-a', [
            {generation: 'generation-associated', pointer: worktreeId, vectorCount: 1},
          ]);
          yield* prepareRetirementUntilReady(databasePath);
          expect(
            yield* deleteCodeGraphVectorPointerWithRetirement(databasePath, {
              expectedSnapshotId: 'snapshot-generation-associated',
              worktreeId,
            }),
          ).toBe(1);
          expect(readRetirementMarkers(databasePath)).toEqual([
            {generation: 'generation-associated', retiredByWorktreeId: worktreeId},
          ]);

          expect((yield* runUntilComplete(input, 24)).at(-1)).toEqual({state: 'complete'});
          expect(readGenerations(databasePath)).toEqual([]);
          expect(readRetirementMarkers(databasePath)).toEqual([]);
        }),
      ),
    );

    layerIt.effect('rotates after one bounded model unit so a huge first model cannot starve a later model', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-model-fairness-'});
          const input = yield* makeVectorHome(fs, path, home);
          const first = yield* makeModelDatabase(fs, path, input, 'model-a', [
            {generation: 'generation-a', vectorCount: 2_501},
          ]);
          const later = yield* makeModelDatabase(fs, path, input, 'model-z', [
            {generation: 'generation-z', vectorCount: 1},
          ]);

          const order: string[] = [];
          for (let tick = 0; tick < 24; tick += 1) {
            yield* runCodeGraphOrdinaryVectorMaintenanceUnit(input, PREPARATION);
            const firstCount = readVectorCount(first);
            const laterCount = readVectorCount(later);
            order.push(`${firstCount}:${laterCount}`);
            if (laterCount === 0) break;
          }

          expect(readVectorCount(later)).toBe(0);
          expect(readVectorCount(first)).toBeGreaterThan(0);
          expect(EffectArray.some(order, value => Effect2.pipe(value, EffectString.endsWith(':0')))).toBe(true);
        }),
      ),
    );

    layerIt.effect(
      'honors durable next-model intent past a busy first model and restarts after a busy last model',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-busy-rotation-'});

            const firstBusyInput = yield* makeVectorHome(fs, path, path.join(root, 'first-busy'));
            const busyFirst = yield* makeModelDatabase(fs, path, firstBusyInput, 'model-a', [
              {generation: 'generation-a', vectorCount: 1},
            ]);
            const healthyLater = yield* makeModelDatabase(fs, path, firstBusyInput, 'model-z', [
              {generation: 'generation-z', vectorCount: 1},
            ]);
            const firstLock = modelWriteLockPath(path, firstBusyInput, 'model-a');
            yield* withExclusiveFileLock(
              fs,
              firstLock,
              {retryIntervalMilliseconds: 1, staleAfterMilliseconds: 120_000, waitTimeoutMilliseconds: 0},
              Effect.gen(function* () {
                const busy = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(firstBusyInput, PREPARATION);
                expect(busy.state).toBe('progress');
                expect(hasTable(busyFirst, 'vector_generation_retirements')).toBe(false);

                yield* runCodeGraphOrdinaryVectorMaintenanceUnit(firstBusyInput, PREPARATION);
                expect(hasTable(healthyLater, 'vector_generation_retirements')).toBe(true);
                expect(yield* runUntil(firstBusyInput, () => readGenerations(healthyLater).length === 0, 24)).toBe(
                  true,
                );
              }),
            );
            expect(readGenerations(busyFirst)).toEqual(['generation-a']);
            expect(readGenerations(healthyLater)).toEqual([]);

            const lastBusyInput = yield* makeVectorHome(fs, path, path.join(root, 'last-busy'));
            const healthyFirst = yield* makeModelDatabase(fs, path, lastBusyInput, 'model-a', [
              {generation: 'generation-a', vectorCount: 1},
            ]);
            const busyLast = yield* makeModelDatabase(fs, path, lastBusyInput, 'model-z', [
              {generation: 'generation-z', vectorCount: 1},
            ]);
            yield* withExclusiveFileLock(
              fs,
              modelWriteLockPath(path, lastBusyInput, 'model-z'),
              {retryIntervalMilliseconds: 1, staleAfterMilliseconds: 120_000, waitTimeoutMilliseconds: 0},
              Effect.gen(function* () {
                yield* runCodeGraphOrdinaryVectorMaintenanceUnit(lastBusyInput, PREPARATION);
                const busy = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(lastBusyInput, PREPARATION);
                expect(busy.state).toBe('progress');
                expect(hasTable(busyLast, 'vector_generation_retirements')).toBe(false);

                yield* runCodeGraphOrdinaryVectorMaintenanceUnit(lastBusyInput, PREPARATION);
                expect(readRetirementMarkers(healthyFirst)).toHaveLength(1);
                expect(yield* runUntil(lastBusyInput, () => readGenerations(healthyFirst).length === 0, 24)).toBe(true);
              }),
            );
            expect(readGenerations(healthyFirst)).toEqual([]);
            expect(readGenerations(busyLast)).toEqual(['generation-z']);
          }),
        ),
    );

    layerIt.effect('advances past a huge first marker so a later small generation gets a page', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-marker-fairness-'});
          const input = yield* makeVectorHome(fs, path, home);
          const databasePath = yield* makeModelDatabase(fs, path, input, 'model-a', [
            {generation: 'generation-a', vectorCount: 2_501},
            {generation: 'generation-z', vectorCount: 1},
          ]);

          for (let tick = 0; tick < 24 && readGenerationVectorCount(databasePath, 'generation-z') > 0; tick += 1) {
            yield* runCodeGraphOrdinaryVectorMaintenanceUnit(input, PREPARATION);
          }

          expect(readGenerationVectorCount(databasePath, 'generation-z')).toBe(0);
          expect(readGenerationVectorCount(databasePath, 'generation-a')).toBeGreaterThan(0);
        }),
      ),
    );

    layerIt.effect('revisits a completed cursor when a new zero-pointer generation appears', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-reverify-'});
          const input = yield* makeVectorHome(fs, path, home);
          const databasePath = yield* makeModelDatabase(fs, path, input, 'model-a', [
            {generation: 'generation-live', pointer: Effect2.pipe('b', EffectString.repeat(64)), vectorCount: 0},
          ]);
          expect((yield* runUntilComplete(input, 24)).at(-1)).toEqual({state: 'complete'});
          insertGeneration(databasePath, {generation: 'generation-new', vectorCount: 1});

          const converged = yield* runUntil(input, () => !readGenerations(databasePath).includes('generation-new'), 24);

          expect(converged).toBe(true);
          expect(readGenerations(databasePath)).toEqual(['generation-live']);
        }),
      ),
    );

    layerIt.effect('rechecks an earlier model before sealing complete when work appears at the final wrap', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-final-seal-'});
          const input = yield* makeVectorHome(fs, path, home);
          const earlier = yield* makeModelDatabase(fs, path, input, 'model-a', [
            {generation: 'generation-live-a', pointer: Effect2.pipe('a', EffectString.repeat(64)), vectorCount: 0},
          ]);
          yield* makeModelDatabase(fs, path, input, 'model-z', [
            {generation: 'generation-live-z', pointer: Effect2.pipe('b', EffectString.repeat(64)), vectorCount: 0},
          ]);
          let inserted = false;
          let sealedResult: CodeGraphOrdinaryVectorMaintenanceUnitResult | undefined;
          for (let tick = 0; tick < 64 && !inserted; tick += 1) {
            sealedResult = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(input, {
              ...PREPARATION,
              beforeFinalVerification: () =>
                Effect.sync(() => {
                  insertGeneration(earlier, {generation: 'generation-late', vectorCount: 1});
                  inserted = true;
                }),
            });
          }

          expect(inserted).toBe(true);
          expect(sealedResult?.state).toBe('progress');
          expect(readGenerations(earlier)).toContain('generation-late');
          expect(yield* runUntil(input, () => !readGenerations(earlier).includes('generation-late'), 32)).toBe(true);
        }),
      ),
    );

    layerIt.effect('keeps every model lock held through the final clean cursor CAS', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const crypto = yield* Crypto.Crypto;
          const system = yield* SystemInfo;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-proof-lock-'});
          const input = yield* makeVectorHome(fs, path, home);
          const databasePath = yield* makeModelDatabase(fs, path, input, 'model-a', []);
          yield* prepareRetirementUntilReady(databasePath);
          expect(
            yield* admitOneCodeGraphVectorRetirementWithCapacity(databasePath, {
              capacityProtector: identityCapacityProtector,
            }),
          ).toEqual({state: 'wrapped'});
          const modelLockPath = codeGraphVectorWriteLockPath(
            path,
            input.threadnoteHome,
            input.checkoutId,
            sha256HexSync('model-a'),
          );
          let competingWriterBlocked = false;
          let competingWriterEntered = false;

          const result = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(input, {
            ...PREPARATION,
            afterFinalVerificationBeforeCursorCas: () =>
              withExclusiveFileLock(
                fs,
                modelLockPath,
                {
                  retryIntervalMilliseconds: 1,
                  staleAfterMilliseconds: 120_000,
                  waitTimeoutMilliseconds: 0,
                },
                Effect.sync(() => {
                  competingWriterEntered = true;
                  insertGeneration(databasePath, {generation: 'generation-race', vectorCount: 0});
                }),
              ).pipe(
                Effect.match({
                  onFailure: () => {
                    competingWriterBlocked = true;
                  },
                  onSuccess: () => undefined,
                }),
                Effect.provideService(Path.Path, path),
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(SystemInfo, system),
              ),
          });

          expect(result).toEqual({state: 'complete'});
          expect(competingWriterBlocked).toBe(true);
          expect(competingWriterEntered).toBe(false);
          expect(readGenerations(databasePath)).toEqual([]);
        }),
      ),
    );

    layerIt.effect('accepts exactly sixty-four model directories plus owned cursor files and rejects sixty-five', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-inventory-'});
          const bounded = yield* makeVectorHome(fs, path, path.join(root, 'bounded'));
          yield* makeModelDirectories(fs, path, bounded, 64);
          yield* Effect.sync(() =>
            seedVectorDatabase(modelDatabasePath(path, bounded, 'model-000'), [
              {generation: 'generation-a', vectorCount: 0},
            ]),
          );
          const first = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(bounded, PREPARATION);
          expect(first.state).toBe('progress');
          yield* fs.writeFileString(vectorCursorTemporaryPath(path, bounded), 'crash-temporary\n', {
            flag: 'wx',
            mode: 0o600,
          });

          const boundedResult = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(bounded, PREPARATION);

          expect(boundedResult.state).not.toBe('deferred');
          expect(yield* fs.exists(vectorCursorTemporaryPath(path, bounded))).toBe(false);
          expect(yield* fs.exists(vectorCursorPath(path, bounded))).toBe(true);

          const overflow = yield* makeVectorHome(fs, path, path.join(root, 'overflow'));
          yield* makeModelDirectories(fs, path, overflow, 65);
          yield* Effect.sync(() =>
            seedVectorDatabase(modelDatabasePath(path, overflow, 'model-000'), [
              {generation: 'generation-a', vectorCount: 0},
            ]),
          );

          const overflowResult = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(overflow, PREPARATION);

          expect(overflowResult).toEqual({
            blockedCode: 'invalid-sidecar',
            retryAfterMilliseconds: 30_000,
            state: 'deferred',
          });
          expect(readGenerations(modelDatabasePath(path, overflow, 'model-000'))).toEqual(['generation-a']);
        }),
      ),
    );

    layerIt.effect('uses one code-unit model order for punctuation and converges after process-style reloads', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-ordinary-vector-punctuation-'});
          const input = yield* makeVectorHome(fs, path, home);
          const dash = yield* makeModelDatabase(fs, path, input, 'a-foo', [
            {generation: 'generation-dash', vectorCount: 0},
          ]);
          const underscore = yield* makeModelDatabase(fs, path, input, 'a_foo', [
            {generation: 'generation-underscore', vectorCount: 0},
          ]);

          expect((yield* runUntilComplete(input, 40)).at(-1)).toEqual({state: 'complete'});
          expect(readGenerations(dash)).toEqual([]);
          expect(readGenerations(underscore)).toEqual([]);
        }),
      ),
    );
  });
});

interface GenerationFixture {
  readonly generation: string;
  readonly pointer?: string;
  readonly vectorCount: number;
}

function makeVectorHome(fs: FileSystem.FileSystem, path: Path.Path, threadnoteHome: string) {
  const input: CodeGraphOrdinaryVectorMaintenanceUnitInput = {checkoutId: CHECKOUT_ID, threadnoteHome};
  return fs.makeDirectory(vectorRoot(path, input), {recursive: true, mode: 0o700}).pipe(Effect.as(input));
}

function makeModelDatabase(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: CodeGraphOrdinaryVectorMaintenanceUnitInput,
  modelName: string,
  generations: readonly GenerationFixture[],
) {
  const databasePath = modelDatabasePath(path, input, modelName);
  return fs
    .makeDirectory(modelRoot(path, input, modelName), {recursive: true, mode: 0o700})
    .pipe(Effect.andThen(Effect.sync(() => seedVectorDatabase(databasePath, generations))), Effect.as(databasePath));
}

function makeModelDirectories(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: CodeGraphOrdinaryVectorMaintenanceUnitInput,
  count: number,
) {
  return Effect.forEach(
    Array.from({length: count}, (_, index) => `model-${Effect2.pipe(index.toString(), EffectString.padStart(3, '0'))}`),
    name => fs.makeDirectory(modelRoot(path, input, name), {recursive: true, mode: 0o700}),
    {concurrency: 8, discard: true},
  );
}

function runUntilComplete(input: CodeGraphOrdinaryVectorMaintenanceUnitInput, limit: number) {
  return Effect.gen(function* () {
    const results: CodeGraphOrdinaryVectorMaintenanceUnitResult[] = [];
    for (let tick = 0; tick < limit; tick += 1) {
      const result = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(input, PREPARATION);
      results.push(result);
      if (result.state === 'complete') return results;
    }
    return results;
  });
}

function runUntil(input: CodeGraphOrdinaryVectorMaintenanceUnitInput, predicate: () => boolean, limit: number) {
  return Effect.gen(function* () {
    for (let tick = 0; tick < limit; tick += 1) {
      yield* runCodeGraphOrdinaryVectorMaintenanceUnit(input, PREPARATION);
      if (predicate()) return true;
    }
    return false;
  });
}

function prepareRetirementUntilReady(databasePath: string) {
  return Effect.gen(function* () {
    for (let step = 0; step < 4; step += 1) {
      const result = yield* prepareCodeGraphVectorRetirement(databasePath, {
        capacityProtector: identityCapacityProtector,
      });
      if (result.state === 'ready') return;
    }
    return yield* Effect.die(TestError.make({message: 'Vector retirement schema did not become ready.'}));
  });
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
      Effect.gen(function* () {
        const content = yield* fs.readFileString(path.join(root, name));
        const receipt = yield* Schema.decodeUnknownEffect(
          Schema.StructWithRest(Schema.Struct({operation: Schema.optionalKey(Schema.Unknown)}), [
            Schema.Record(Schema.String, Schema.Unknown),
          ]),
        )(JSON.parse(content));
        return String(receipt.operation ?? 'invalid');
      }),
    );
  });
}

function vectorRoot(path: Path.Path, input: CodeGraphOrdinaryVectorMaintenanceUnitInput): string {
  return path.join(input.threadnoteHome, 'indexes', 'code-graph', 'repositories', input.checkoutId, 'vectors');
}

function modelRoot(path: Path.Path, input: CodeGraphOrdinaryVectorMaintenanceUnitInput, modelName: string): string {
  return path.join(vectorRoot(path, input), modelName);
}

function modelWriteLockPath(
  path: Path.Path,
  input: CodeGraphOrdinaryVectorMaintenanceUnitInput,
  modelName: string,
): string {
  return codeGraphVectorWriteLockPath(path, input.threadnoteHome, input.checkoutId, sha256HexSync(modelName));
}

function modelDatabasePath(
  path: Path.Path,
  input: CodeGraphOrdinaryVectorMaintenanceUnitInput,
  modelName: string,
): string {
  return path.join(modelRoot(path, input, modelName), 'vectors-v2.sqlite');
}

function vectorCursorPath(path: Path.Path, input: CodeGraphOrdinaryVectorMaintenanceUnitInput): string {
  return path.join(vectorRoot(path, input), CURSOR_FILE);
}

function vectorCursorTemporaryPath(path: Path.Path, input: CodeGraphOrdinaryVectorMaintenanceUnitInput): string {
  return path.join(vectorRoot(path, input), CURSOR_TEMPORARY);
}

function seedVectorDatabase(databasePath: string, generations: readonly GenerationFixture[]): void {
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
    for (const generation of generations) insertGenerationWithDatabase(database, generation);
  } finally {
    database.close(false);
  }
}

function insertGeneration(databasePath: string, fixture: GenerationFixture): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA foreign_keys = ON');
    insertGenerationWithDatabase(database, fixture);
  } finally {
    database.close(false);
  }
}

function insertGenerationWithDatabase(database: Database, fixture: GenerationFixture): void {
  database
    .query(
      `INSERT INTO vector_generations (
         generation, snapshot_id, model_id, model_sha256, dimensions,
         template_version, count, state, created_at
       ) VALUES (?, ?, ?, ?, 384, 1, ?, 'ready', ?)`,
    )
    .run(
      fixture.generation,
      `snapshot-${fixture.generation}`,
      'model-test',
      Effect2.pipe('f', EffectString.repeat(64)),
      fixture.vectorCount,
      new Date(0).toISOString(),
    );
  if (fixture.pointer !== undefined) {
    database
      .query('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)')
      .run(fixture.pointer, fixture.generation);
  }
  const insertVector = database.prepare(
    'INSERT INTO vectors (generation, symbol_id, fingerprint, vector) VALUES (?, ?, ?, ?)',
  );
  database.transaction(() => {
    for (let index = 0; index < fixture.vectorCount; index += 1) {
      const symbolId = `symbol-${fixture.generation}-${Effect2.pipe(index.toString(), EffectString.padStart(6, '0'))}`;
      insertVector.run(fixture.generation, symbolId, `fingerprint-${symbolId}`, new Uint8Array(16));
    }
  })();
}

function readGenerations(databasePath: string): string[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return EffectArray.map(
      database
        .query<{readonly generation: unknown}, []>('SELECT generation FROM vector_generations ORDER BY generation')
        .all(),
      row => String(row.generation),
    );
  } finally {
    database.close(false);
  }
}

function readRetirementMarkers(
  databasePath: string,
): Array<{readonly generation: string; readonly retiredByWorktreeId: string | null}> {
  if (!hasTable(databasePath, 'vector_generation_retirements')) return [];
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly generation: string; readonly retiredByWorktreeId: string | null}, SQLQueryBindings[]>(
        `SELECT generation, retired_by_worktree_id AS retiredByWorktreeId
         FROM vector_generation_retirements
         ORDER BY generation`,
      )
      .all();
  } finally {
    database.close(false);
  }
}

function readRetirementSequence(databasePath: string): number {
  if (!hasTable(databasePath, 'vector_generation_retirements')) return 0;
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database
      .query<{readonly seq?: unknown} | null, SQLQueryBindings[]>(
        "SELECT seq FROM sqlite_sequence WHERE name = 'vector_generation_retirements'",
      )
      .get();
    return row === null ? 0 : Number(row.seq);
  } finally {
    database.close(false);
  }
}

function readVectorCount(databasePath: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return Number(
      requiredRow(
        database.query<{readonly count: number}, SQLQueryBindings[]>('SELECT COUNT(*) AS count FROM vectors').get(),
      ).count,
    );
  } finally {
    database.close(false);
  }
}

function readGenerationVectorCount(databasePath: string, generation: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return Number(
      requiredRow(
        database
          .query<
            {
              readonly count: number;
            },
            SQLQueryBindings[]
          >('SELECT COUNT(*) AS count FROM vectors WHERE generation = ?')
          .get(generation),
      ).count,
    );
  } finally {
    database.close(false);
  }
}

function hasTable(databasePath: string, table: string): boolean {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return (
      Number(
        requiredRow(
          database
            .query<
              {
                readonly count: number;
              },
              SQLQueryBindings[]
            >("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table),
        ).count,
      ) === 1
    );
  } finally {
    database.close(false);
  }
}
