import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Crypto, Deferred, Effect, Fiber, FileSystem, Logger, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  codeGraphPersistentCapacityDemand,
  CodeGraphDiskCapacityPressureError,
  saturatingCapacityAdd,
  type CodeGraphDirectPersistentCapacityBoundary,
} from '@threadnote/graph/disk/capacity';
import {withCodeGraphDiskReservation} from '@threadnote/graph/disk/reservation';
import {
  CODE_GRAPH_DATABASE_PAGE_SIZE_BYTES,
  CodeGraphStore,
  type CodeGraphDirectPersistentCapacityProtector,
  type CodeGraphStoreShape,
} from '@threadnote/graph/store';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '@threadnote/graph/types';
import {CodeGraphStoreError, isCodeGraphStoreError} from '@threadnote/graph/types';
import {parseCodeGraphFileFacts} from '@threadnote/graph/fact/validation';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const LOAD_ROWS = 73_000;
const FILE_FACT_OPERATION = 'cache code graph file facts' as const;
const SHARD_OPERATION = 'cache materialized code graph file shards' as const;
const loadEvidenceLogger = Logger.make<unknown, void>(options => {
  process.stdout.write(`${String(options.message)}\n`);
});
const loadEvidenceLoggerLayer = Logger.layer([loadEvidenceLogger]);
type CacheMode = 'facts' | 'shards';

interface LoadEvidence {
  absoluteMainHighWaterBytes: number;
  absoluteWalHighWaterBytes: number;
  boundaries: CodeGraphDirectPersistentCapacityBoundary[];
  incrementalMainHighWaterBytes: number;
  incrementalSharedHighWaterBytes: number;
  incrementalWalHighWaterBytes: number;
  receipts: number;
  rssHighWaterBytes: number;
  transactions: number;
}

describe('code graph cache capacity load calibration', () => {
  effectIt.effect(
    'keeps 73,000 file blobs and 73,000 shards within measured SQLite/WAL transaction ceilings',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const crypto = yield* Crypto.Crypto;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const startedAtMilliseconds = performance.now();
          const rssBeforeBytes = process.memoryUsage().rss;
          const root = yield* fs.makeTempDirectory({prefix: 'threadnote-cache-capacity-load-'});
          yield* Effect.gen(function* () {
            const databasePath = path.join(root, 'graph.sqlite');
            const ledgerRoot = path.join(root, 'reservations');
            const ledgerLockPath = path.join(root, 'reservation.lock');
            const files = Array.from({length: LOAD_ROWS}, (_, index) => loadFile(index));
            const facts = EffectArray.map(files, file => emptyFacts(file.path));
            facts[0] = {...facts[0], diagnostics: [Effect2.pipe('界', EffectString.repeat(2_500_000))]};
            const store = yield* CodeGraphStore;
            yield* store.initialize(databasePath);
            const sqliteProfile = yield* Effect.sync(() => readSqliteProfile(databasePath));
            expect(sqliteProfile).toMatchObject({
              journalMode: 'wal',
              pageSize: CODE_GRAPH_DATABASE_PAGE_SIZE_BYTES,
              walAutoCheckpointPages: 1_000,
            });

            const evidence = new Map<CodeGraphDirectPersistentCapacityBoundary['operation'], LoadEvidence>([
              [FILE_FACT_OPERATION, emptyLoadEvidence()],
              [SHARD_OPERATION, emptyLoadEvidence()],
            ]);
            const protector: CodeGraphDirectPersistentCapacityProtector = (boundary, transaction) => {
              const operationEvidence = evidence.get(boundary.operation);
              if (!operationEvidence) return Effect.die(TestError.make({message: 'Unexpected cache load operation.'}));
              const demand = codeGraphPersistentCapacityDemand({
                boundary,
                lexicalFormatVersion: 1,
                pageSize: sqliteProfile.pageSize,
                walAutoCheckpointPages: sqliteProfile.walAutoCheckpointPages,
              });
              return withCodeGraphDiskReservation(
                {
                  boundary,
                  ledgerLockPath,
                  ledgerRoot,
                  maintenance: Effect.void,
                  observe: Effect.succeed({
                    demand,
                    durableAvailableBytes: Number.MAX_SAFE_INTEGER,
                    durableFilesystemKey: Effect2.pipe('a', EffectString.repeat(64)),
                    freelistBytes: 0,
                    temporaryAvailableBytes: Number.MAX_SAFE_INTEGER,
                    temporaryFilesystemKey: Effect2.pipe('a', EffectString.repeat(64)),
                  }),
                },
                Effect.gen(function* () {
                  const beforeMainBytes = yield* observedFileSize(fs, databasePath);
                  const beforeWalBytes = yield* observedFileSize(fs, `${databasePath}-wal`);
                  const activeReceipts = EffectArray.filter(
                    yield* fs.readDirectory(ledgerRoot),
                    __effectArrayValue =>
                      !!(name => Effect2.pipe(name, EffectString.endsWith('.json')))(__effectArrayValue),
                  );
                  expect(activeReceipts).toHaveLength(1);
                  operationEvidence.receipts += activeReceipts.length;
                  const result = yield* transaction;
                  const afterMainBytes = yield* observedFileSize(fs, databasePath);
                  const afterWalBytes = yield* observedFileSize(fs, `${databasePath}-wal`);
                  const mainGrowthBytes = Math.max(0, afterMainBytes - beforeMainBytes);
                  const walGrowthBytes = Math.max(0, afterWalBytes - beforeWalBytes);
                  const sharedGrowthBytes = Math.max(
                    0,
                    afterMainBytes + afterWalBytes - beforeMainBytes - beforeWalBytes,
                  );
                  expect(demand.state).toBe('measured');
                  if (demand.state === 'measured') {
                    expect(mainGrowthBytes).toBeLessThanOrEqual(
                      saturatingCapacityAdd(demand.mainHighWaterBytes, demand.recoveryFloorBytes),
                    );
                    expect(walGrowthBytes).toBeLessThanOrEqual(
                      saturatingCapacityAdd(demand.transientHighWaterBytes, demand.recoveryFloorBytes),
                    );
                    expect(sharedGrowthBytes).toBeLessThanOrEqual(
                      saturatingCapacityAdd(
                        demand.mainHighWaterBytes,
                        demand.transientHighWaterBytes,
                        demand.recoveryFloorBytes,
                      ),
                    );
                  }
                  operationEvidence.boundaries.push(boundary);
                  operationEvidence.transactions += 1;
                  operationEvidence.absoluteMainHighWaterBytes = Math.max(
                    operationEvidence.absoluteMainHighWaterBytes,
                    afterMainBytes,
                  );
                  operationEvidence.absoluteWalHighWaterBytes = Math.max(
                    operationEvidence.absoluteWalHighWaterBytes,
                    afterWalBytes,
                  );
                  operationEvidence.incrementalMainHighWaterBytes = Math.max(
                    operationEvidence.incrementalMainHighWaterBytes,
                    mainGrowthBytes,
                  );
                  operationEvidence.incrementalWalHighWaterBytes = Math.max(
                    operationEvidence.incrementalWalHighWaterBytes,
                    walGrowthBytes,
                  );
                  operationEvidence.incrementalSharedHighWaterBytes = Math.max(
                    operationEvidence.incrementalSharedHighWaterBytes,
                    sharedGrowthBytes,
                  );
                  operationEvidence.rssHighWaterBytes = Math.max(
                    operationEvidence.rssHighWaterBytes,
                    process.memoryUsage().rss,
                  );
                  return result;
                }),
              ).pipe(
                Effect.tap(() =>
                  fs
                    .readDirectory(ledgerRoot)
                    .pipe(
                      Effect.tap(entries =>
                        Effect.sync(() =>
                          expect(
                            EffectArray.filter(entries, name => Effect2.pipe(name, EffectString.endsWith('.json'))),
                          ).toEqual([]),
                        ),
                      ),
                    ),
                ),
                Effect.mapError(cause =>
                  isCodeGraphStoreError(cause)
                    ? cause
                    : CodeGraphStoreError.of('Cache load reservation fixture failed.'),
                ),
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(SystemInfo, system),
              );
            };

            yield* store.cacheFacts(databasePath, files, facts, 'cache-load-extractor-v1', protector);
            yield* store.cacheMaterializedFileShards(
              databasePath,
              files,
              facts,
              'cache-load-extractor-v1',
              'cache-load-derivation-v1',
              protector,
            );

            for (const operation of [FILE_FACT_OPERATION, SHARD_OPERATION]) {
              const measured = evidence.get(operation)!;
              expect(measured.transactions).toBe(143);
              expect(measured.receipts).toBe(143);
              expect(EffectArray.every(measured.boundaries.slice(0, -1), boundary => boundary.rowCount === 512)).toBe(
                true,
              );
              expect(measured.boundaries.at(-1)?.rowCount).toBe(296);
              const maximumBoundaryBytes = Math.max(
                ...EffectArray.map(measured.boundaries, boundary => boundary.finalFactBytes),
              );
              // The fixture contains a raw multi-megabyte fact. Compact fact
              // envelopes must make the persisted transaction materially
              // smaller while the physical main/WAL assertions below remain
              // the capacity authority.
              expect(maximumBoundaryBytes).toBeGreaterThan(64 * 1_024);
              expect(maximumBoundaryBytes).toBeLessThan(1 * 1_048_576);
              expect(
                EffectArray.every(
                  measured.boundaries,
                  boundary =>
                    boundary.operation === operation &&
                    boundary.rowCount <= 512 &&
                    boundary.finalFactBytes <= 32 * 1_048_576,
                ),
              ).toBe(true);
              expect(measured.absoluteMainHighWaterBytes).toBeGreaterThan(0);
              expect(measured.absoluteMainHighWaterBytes).toBeLessThan(256 * 1_048_576);
              expect(measured.absoluteWalHighWaterBytes).toBeLessThan(32 * 1_048_576);
              // A connection close may checkpoint and remove the WAL before
              // the post-transaction sample. Require positive combined
              // durable growth while retaining the independent WAL ceiling.
              expect(measured.incrementalSharedHighWaterBytes).toBeGreaterThan(0);
              yield* logLoadEvidence({
                absoluteMainHighWaterBytes: measured.absoluteMainHighWaterBytes,
                absoluteWalHighWaterBytes: measured.absoluteWalHighWaterBytes,
                event: 'code-graph-cache-capacity-load-operation',
                incrementalMainHighWaterBytes: measured.incrementalMainHighWaterBytes,
                incrementalSharedHighWaterBytes: measured.incrementalSharedHighWaterBytes,
                incrementalWalHighWaterBytes: measured.incrementalWalHighWaterBytes,
                maximumBoundaryBytes: Math.max(
                  ...EffectArray.map(measured.boundaries, boundary => boundary.finalFactBytes),
                ),
                operation,
                receipts: measured.receipts,
                rows: LOAD_ROWS,
                rssHighWaterBytes: measured.rssHighWaterBytes,
                summedBoundaryBytes: EffectArray.reduce(measured.boundaries, 0, (total, boundary) =>
                  saturatingCapacityAdd(total, boundary.finalFactBytes),
                ),
                transactions: measured.transactions,
              });
            }

            yield* Effect.sync(() => {
              const database = new Database(databasePath, {readonly: true, strict: true});
              try {
                expect(database.query('SELECT COUNT(*) AS count FROM file_blobs').get()).toEqual({count: LOAD_ROWS});
                expect(database.query('SELECT COUNT(*) AS count FROM materialized_file_shards').get()).toEqual({
                  count: LOAD_ROWS,
                });
                expect(database.query('PRAGMA foreign_key_check').all()).toEqual([]);
              } finally {
                database.close(false);
              }
            });
            yield* logLoadEvidence({
              elapsedMilliseconds: Math.round(performance.now() - startedAtMilliseconds),
              event: 'code-graph-cache-capacity-load-total',
              rssAfterBytes: process.memoryUsage().rss,
              rssBeforeBytes,
              rowsPerOperation: LOAD_ROWS,
            });
          }).pipe(Effect.ensuring(fs.remove(root, {force: true, recursive: true}).pipe(Effect.ignore)));
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    120_000,
  );

  effectIt.effect(
    'pauses, cancels before cache writers, preserves exact prefixes, and converges on retry',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const store = yield* CodeGraphStore;
          const files = Array.from({length: 513}, (_, index) => loadFile(index));
          const facts = EffectArray.map(files, file => emptyFacts(file.path));

          for (const mode of ['facts', 'shards'] as const) {
            for (const pressureAt of [1, 2] as const) {
              const pressureRoot = yield* fs.makeTempDirectory({
                prefix: `threadnote-cache-${mode}-pressure-${pressureAt}-`,
              });
              yield* Effect.gen(function* () {
                const databasePath = path.join(pressureRoot, 'graph.sqlite');
                const ledgerRoot = path.join(pressureRoot, 'reservations');
                const ledgerLockPath = path.join(pressureRoot, 'reservation.lock');
                yield* store.initialize(databasePath);
                yield* Effect.sync(() => installCacheMutationAudit(databasePath, mode));
                const profile = readSqliteProfile(databasePath);
                const reserve = <A, E, R>(
                  boundary: CodeGraphDirectPersistentCapacityBoundary,
                  transaction: Effect.Effect<A, E, R>,
                  availableBytes: number,
                ) =>
                  withCodeGraphDiskReservation(
                    {
                      boundary,
                      ledgerLockPath,
                      ledgerRoot,
                      maintenance: Effect.void,
                      observe: Effect.succeed({
                        demand: codeGraphPersistentCapacityDemand({
                          boundary,
                          lexicalFormatVersion: 1,
                          pageSize: profile.pageSize,
                          walAutoCheckpointPages: profile.walAutoCheckpointPages,
                        }),
                        durableAvailableBytes: availableBytes,
                        durableFilesystemKey: Effect2.pipe('b', EffectString.repeat(64)),
                        freelistBytes: 0,
                        temporaryAvailableBytes: availableBytes,
                        temporaryFilesystemKey: Effect2.pipe('b', EffectString.repeat(64)),
                      }),
                    },
                    transaction,
                  ).pipe(
                    Effect.mapError(cause =>
                      isCodeGraphStoreError(cause)
                        ? cause
                        : CodeGraphStoreError.of('Cache retry reservation fixture failed.'),
                    ),
                    Effect.provideService(Crypto.Crypto, crypto),
                    Effect.provideService(FileSystem.FileSystem, fs),
                    Effect.provideService(Path.Path, path),
                    Effect.provideService(SystemInfo, system),
                  );
                const exactTransaction = <A, E, R>(
                  boundary: CodeGraphDirectPersistentCapacityBoundary,
                  transaction: Effect.Effect<A, E, R>,
                ) =>
                  Effect.gen(function* () {
                    const before = readCacheMutationCount(databasePath);
                    const result = yield* transaction;
                    expect(readCacheMutationCount(databasePath) - before).toBe(boundary.rowCount);
                    return result;
                  });

                let attempts = 0;
                const pressureProtector: CodeGraphDirectPersistentCapacityProtector = (boundary, transaction) => {
                  attempts += 1;
                  return reserve(
                    boundary,
                    exactTransaction(boundary, transaction),
                    attempts === pressureAt ? 0 : Number.MAX_SAFE_INTEGER,
                  );
                };
                const pressure = yield* runCacheMode(store, mode, databasePath, files, facts, pressureProtector).pipe(
                  Effect.flip,
                );
                const committedPrefix = (pressureAt - 1) * 512;
                expect(pressure).toBeInstanceOf(CodeGraphDiskCapacityPressureError);
                expect(attempts).toBe(pressureAt);
                expect(readCacheRowCount(databasePath, mode)).toBe(committedPrefix);
                expect(readCacheMutationCount(databasePath)).toBe(committedPrefix);
                expectCacheMapping(databasePath, mode, files.slice(0, committedPrefix));
                expect(yield* activeReceiptCount(fs, ledgerRoot)).toBe(0);

                let retryTransactions = 0;
                const retryProtector: CodeGraphDirectPersistentCapacityProtector = (boundary, transaction) => {
                  retryTransactions += 1;
                  return reserve(boundary, exactTransaction(boundary, transaction), Number.MAX_SAFE_INTEGER);
                };
                yield* runCacheMode(store, mode, databasePath, files, facts, retryProtector);
                expect(retryTransactions).toBe(2);
                expect(readCacheRowCount(databasePath, mode)).toBe(513);
                expect(readCacheMutationCount(databasePath)).toBe(committedPrefix + 513);
                expectCacheMapping(databasePath, mode, files);
                expect(yield* activeReceiptCount(fs, ledgerRoot)).toBe(0);
              }).pipe(Effect.ensuring(fs.remove(pressureRoot, {force: true, recursive: true}).pipe(Effect.ignore)));
            }

            const beforeWriterRoot = yield* fs.makeTempDirectory({prefix: `threadnote-cache-${mode}-cancel-first-`});
            yield* Effect.gen(function* () {
              const databasePath = path.join(beforeWriterRoot, 'graph.sqlite');
              const ledgerRoot = path.join(beforeWriterRoot, 'reservations');
              const ledgerLockPath = path.join(beforeWriterRoot, 'reservation.lock');
              yield* store.initialize(databasePath);
              yield* Effect.sync(() => installCacheMutationAudit(databasePath, mode));
              const profile = readSqliteProfile(databasePath);
              const receiptAcquired = yield* Deferred.make<void>();
              const reserve = <A, E, R>(
                boundary: CodeGraphDirectPersistentCapacityBoundary,
                transaction: Effect.Effect<A, E, R>,
              ) =>
                withCodeGraphDiskReservation(
                  {
                    boundary,
                    ledgerLockPath,
                    ledgerRoot,
                    maintenance: Effect.void,
                    observe: Effect.succeed(
                      healthyReservationObservation(boundary, profile, Effect2.pipe('c', EffectString.repeat(64))),
                    ),
                  },
                  transaction,
                ).pipe(
                  Effect.mapError(cause =>
                    isCodeGraphStoreError(cause)
                      ? cause
                      : CodeGraphStoreError.of('Cache cancellation reservation fixture failed.'),
                  ),
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(SystemInfo, system),
                );
              const blocked: CodeGraphDirectPersistentCapacityProtector = (boundary, _transaction) =>
                reserve(boundary, Deferred.succeed(receiptAcquired, undefined).pipe(Effect.andThen(Effect.never)));
              const caching = yield* runCacheMode(store, mode, databasePath, [files[0]], [facts[0]], blocked).pipe(
                Effect.forkChild,
              );
              yield* Deferred.await(receiptAcquired);
              expect(yield* activeReceiptCount(fs, ledgerRoot)).toBe(1);
              expect(readCacheRowCount(databasePath, mode)).toBe(0);
              yield* Fiber.interrupt(caching);
              expect(yield* activeReceiptCount(fs, ledgerRoot)).toBe(0);
              expect(readCacheRowCount(databasePath, mode)).toBe(0);

              const healthy: CodeGraphDirectPersistentCapacityProtector = (boundary, transaction) =>
                reserve(boundary, transaction);
              yield* runCacheMode(store, mode, databasePath, [files[0]], [facts[0]], healthy);
              expect(readCacheRowCount(databasePath, mode)).toBe(1);
              expectCacheMapping(databasePath, mode, files.slice(0, 1));
            }).pipe(Effect.ensuring(fs.remove(beforeWriterRoot, {force: true, recursive: true}).pipe(Effect.ignore)));

            const prefixRoot = yield* fs.makeTempDirectory({prefix: `threadnote-cache-${mode}-cancel-prefix-`});
            yield* Effect.gen(function* () {
              const databasePath = path.join(prefixRoot, 'graph.sqlite');
              const ledgerRoot = path.join(prefixRoot, 'reservations');
              const ledgerLockPath = path.join(prefixRoot, 'reservation.lock');
              yield* store.initialize(databasePath);
              yield* Effect.sync(() => installCacheMutationAudit(databasePath, mode));
              const profile = readSqliteProfile(databasePath);
              const secondReceiptAcquired = yield* Deferred.make<void>();
              const reserve = <A, E, R>(
                boundary: CodeGraphDirectPersistentCapacityBoundary,
                transaction: Effect.Effect<A, E, R>,
              ) =>
                withCodeGraphDiskReservation(
                  {
                    boundary,
                    ledgerLockPath,
                    ledgerRoot,
                    maintenance: Effect.void,
                    observe: Effect.succeed(
                      healthyReservationObservation(boundary, profile, Effect2.pipe('d', EffectString.repeat(64))),
                    ),
                  },
                  transaction,
                ).pipe(
                  Effect.mapError(cause =>
                    isCodeGraphStoreError(cause)
                      ? cause
                      : CodeGraphStoreError.of('Cache prefix reservation fixture failed.'),
                  ),
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(SystemInfo, system),
                );
              let attempts = 0;
              const interruptedProtector: CodeGraphDirectPersistentCapacityProtector = (boundary, transaction) => {
                attempts += 1;
                const attempt = attempts;
                return reserve(
                  boundary,
                  attempt === 2
                    ? Deferred.succeed(secondReceiptAcquired, undefined).pipe(Effect.andThen(Effect.never))
                    : Effect.gen(function* () {
                        const before = readCacheMutationCount(databasePath);
                        const result = yield* transaction;
                        expect(readCacheMutationCount(databasePath) - before).toBe(boundary.rowCount);
                        return result;
                      }),
                );
              };
              const caching = yield* runCacheMode(store, mode, databasePath, files, facts, interruptedProtector).pipe(
                Effect.forkChild,
              );
              yield* Deferred.await(secondReceiptAcquired);
              expect(attempts).toBe(2);
              expect(yield* activeReceiptCount(fs, ledgerRoot)).toBe(1);
              expect(readCacheRowCount(databasePath, mode)).toBe(512);
              expect(readCacheMutationCount(databasePath)).toBe(512);
              expectCacheMapping(databasePath, mode, files.slice(0, 512));
              yield* Fiber.interrupt(caching);
              expect(yield* activeReceiptCount(fs, ledgerRoot)).toBe(0);
              expect(readCacheRowCount(databasePath, mode)).toBe(512);
              expectCacheMapping(databasePath, mode, files.slice(0, 512));

              let retryTransactions = 0;
              const healthy: CodeGraphDirectPersistentCapacityProtector = (boundary, transaction) => {
                retryTransactions += 1;
                return reserve(
                  boundary,
                  Effect.gen(function* () {
                    const before = readCacheMutationCount(databasePath);
                    const result = yield* transaction;
                    expect(readCacheMutationCount(databasePath) - before).toBe(boundary.rowCount);
                    return result;
                  }),
                );
              };
              yield* runCacheMode(store, mode, databasePath, files, facts, healthy);
              expect(retryTransactions).toBe(2);
              expect(readCacheRowCount(databasePath, mode)).toBe(513);
              expect(readCacheMutationCount(databasePath)).toBe(1_025);
              expectCacheMapping(databasePath, mode, files);
              expect(yield* activeReceiptCount(fs, ledgerRoot)).toBe(0);
            }).pipe(Effect.ensuring(fs.remove(prefixRoot, {force: true, recursive: true}).pipe(Effect.ignore)));
          }
        }).pipe(provideTestLayer(ApplicationLayer)),
      ),
    120_000,
  );
});

function loadFile(index: number): CodeGraphInventoryFile {
  const suffix = Effect2.pipe(index.toString(), EffectString.padStart(6, '0'));
  return {
    blobId: Effect2.pipe(index.toString(16), EffectString.padStart(40, '0')),
    contentHash: Effect2.pipe(index.toString(16), EffectString.padStart(64, '0')),
    language: 'typescript',
    mode: '100644',
    path: `src/load/file-${suffix}.ts`,
    size: 1,
    source: 'commit',
  };
}

function emptyFacts(path: string): CodeGraphFileFacts {
  return {diagnostics: [], edges: [], path, symbols: []};
}

function runCacheMode(
  store: CodeGraphStoreShape,
  mode: CacheMode,
  databasePath: string,
  files: readonly CodeGraphInventoryFile[],
  facts: readonly CodeGraphFileFacts[],
  protector: CodeGraphDirectPersistentCapacityProtector,
) {
  return mode === 'facts'
    ? store.cacheFacts(databasePath, files, facts, 'cache-retry-extractor-v1', protector)
    : store.cacheMaterializedFileShards(
        databasePath,
        files,
        facts,
        'cache-retry-extractor-v1',
        'cache-retry-derivation-v1',
        protector,
      );
}

function installCacheMutationAudit(databasePath: string, mode: CacheMode) {
  const database = new Database(databasePath, {strict: true});
  const table = mode === 'facts' ? 'file_blobs' : 'materialized_file_shards';
  try {
    database.exec(`
      CREATE TABLE cache_capacity_mutation_count (id INTEGER PRIMARY KEY CHECK (id = 1), mutation_count INTEGER NOT NULL);
      INSERT INTO cache_capacity_mutation_count (id, mutation_count) VALUES (1, 0);
      CREATE TRIGGER cache_capacity_insert AFTER INSERT ON ${table}
      BEGIN UPDATE cache_capacity_mutation_count SET mutation_count = mutation_count + 1 WHERE id = 1; END;
      CREATE TRIGGER cache_capacity_update AFTER UPDATE ON ${table}
      BEGIN UPDATE cache_capacity_mutation_count SET mutation_count = mutation_count + 1 WHERE id = 1; END;
    `);
  } finally {
    database.close(false);
  }
}

function readCacheMutationCount(databasePath: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return Number(
      requiredRow(
        database
          .query<
            {
              readonly mutation_count: number;
            },
            SQLQueryBindings[]
          >('SELECT mutation_count FROM cache_capacity_mutation_count WHERE id = 1')
          .get(),
      ).mutation_count,
    );
  } finally {
    database.close(false);
  }
}

function readCacheRowCount(databasePath: string, mode: CacheMode): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  const table = mode === 'facts' ? 'file_blobs' : 'materialized_file_shards';
  try {
    return Number(
      requiredRow(
        database.query<{readonly count: number}, SQLQueryBindings[]>(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).count,
    );
  } finally {
    database.close(false);
  }
}

function expectCacheMapping(
  databasePath: string,
  mode: CacheMode,
  expectedFiles: readonly CodeGraphInventoryFile[],
): void {
  const database = new Database(databasePath, {readonly: true, strict: true});
  const table = mode === 'facts' ? 'file_blobs' : 'materialized_file_shards';
  try {
    const rows = database
      .query<
        {
          readonly facts_json: string;
          readonly path_hint: string;
        },
        SQLQueryBindings[]
      >(`SELECT path_hint, facts_json FROM ${table} ORDER BY path_hint`)
      .all();
    expect(
      EffectArray.map(rows, row => ({
        factsPath: parseCodeGraphFileFacts(JSON.parse(row.facts_json)).path,
        pathHint: row.path_hint,
      })),
    ).toEqual(EffectArray.map(expectedFiles, file => ({factsPath: file.path, pathHint: file.path})));
  } finally {
    database.close(false);
  }
}

function healthyReservationObservation(
  boundary: CodeGraphDirectPersistentCapacityBoundary,
  profile: ReturnType<typeof readSqliteProfile>,
  filesystemKey: string,
) {
  return {
    demand: codeGraphPersistentCapacityDemand({
      boundary,
      lexicalFormatVersion: 1,
      pageSize: profile.pageSize,
      walAutoCheckpointPages: profile.walAutoCheckpointPages,
    }),
    durableAvailableBytes: Number.MAX_SAFE_INTEGER,
    durableFilesystemKey: filesystemKey,
    freelistBytes: 0,
    temporaryAvailableBytes: Number.MAX_SAFE_INTEGER,
    temporaryFilesystemKey: filesystemKey,
  };
}

function activeReceiptCount(fs: FileSystem.FileSystem, ledgerRoot: string) {
  return fs.readDirectory(ledgerRoot).pipe(
    Effect.map(
      entries => EffectArray.filter(entries, name => Effect2.pipe(name, EffectString.endsWith('.json'))).length,
    ),
    Effect.orElseSucceed(() => 0),
  );
}

function logLoadEvidence(evidence: Readonly<Record<string, number | string>>) {
  return Effect.logInfo(JSON.stringify(evidence)).pipe(provideTestLayer(loadEvidenceLoggerLayer));
}

function emptyLoadEvidence(): LoadEvidence {
  return {
    absoluteMainHighWaterBytes: 0,
    absoluteWalHighWaterBytes: 0,
    boundaries: [],
    incrementalMainHighWaterBytes: 0,
    incrementalSharedHighWaterBytes: 0,
    incrementalWalHighWaterBytes: 0,
    receipts: 0,
    rssHighWaterBytes: 0,
    transactions: 0,
  };
}

function readSqliteProfile(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const page = requiredRow(
      database.query<{readonly page_size: number}, SQLQueryBindings[]>('PRAGMA page_size').get(),
    );
    const journal = requiredRow(
      database.query<{readonly journal_mode: string}, SQLQueryBindings[]>('PRAGMA journal_mode').get(),
    );
    const checkpoint = requiredRow(
      database.query<{readonly wal_autocheckpoint: number}, SQLQueryBindings[]>('PRAGMA wal_autocheckpoint').get(),
    );
    return {
      journalMode: Effect2.pipe(journal.journal_mode, EffectString.toLowerCase),
      pageSize: Number(page.page_size),
      walAutoCheckpointPages: Number(checkpoint.wal_autocheckpoint),
    };
  } finally {
    database.close(false);
  }
}

function observedFileSize(fs: FileSystem.FileSystem, path: string) {
  return fs.stat(path).pipe(
    Effect.map(info => Number(info.size)),
    Effect.orElseSucceed(() => 0),
  );
}
