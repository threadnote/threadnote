import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Logger, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  codeGraphVectorRetirementCapacityDemand,
  saturatingCapacityAdd,
  type CodeGraphDirectPersistentCapacityBoundary,
} from '@threadnote/graph/disk/capacity';
import {codeGraphDiskReservationRoot} from '@threadnote/graph/layout';
import {
  type CodeGraphOrdinaryVectorMaintenanceUnitInput,
  makeCodeGraphVectorRetirementCapacityProtector,
  retireCodeGraphVectorPointerWithCapacity,
  runCodeGraphOrdinaryVectorMaintenanceUnit,
} from '@threadnote/graph/vector/maintenance';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const isRecordedOperation = Schema.is(Schema.Struct({operation: Schema.optionalKey(Schema.Unknown)}));

function operationFromRecordedJson(content: string): string {
  const parsed: unknown = JSON.parse(content);
  if (parsed === null) throw new TypeError('Recorded vector operation must not be null.');
  if (!isRecordedOperation(parsed)) return 'invalid';
  return String(parsed.operation ?? 'invalid');
}

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const CHECKOUT_ID = Effect2.pipe('a', EffectString.repeat(64));
const VECTOR_DATABASE_NAME = 'vectors-v2.sqlite';
const LOAD_ROWS = 73_001;
const BYTE_PAGE_ROWS = 1_000;
const BYTE_PAGE_VECTOR_BYTES = 33_000;
const VectorLoadLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);
const loadEvidenceLogger = Logger.make<unknown, void>(options => {
  process.stdout.write(`${String(options.message)}\n`);
});
const loadEvidenceLoggerLayer = Logger.layer([loadEvidenceLogger]);

interface VectorCounts {
  readonly generations: number;
  readonly markers: number;
  readonly pointers: number;
  readonly retirementReady: boolean;
  readonly vectors: number;
}

interface VectorLoadMeasurement {
  readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
  readonly elapsedMilliseconds: number;
  readonly mainGrowthBytes: number;
  readonly rssBytes: number;
  readonly sharedGrowthBytes: number;
  readonly stage: 'admission' | 'page' | 'schema';
  readonly vectorsDeleted: number;
  readonly walGrowthBytes: number;
}

interface PendingMeasurement {
  readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
  readonly counts: VectorCounts;
  readonly mainBytes: number;
  readonly startedAtMilliseconds: number;
  readonly walBytes: number;
}

describe('code graph vector retirement load calibration', () => {
  effectIt.effect(
    'publishes r1 without backfill and retires 73,001 rows in exact bounded pages',
    () =>
      TestClock.withLive(
        runVectorLoadCase({
          event: 'code-graph-vector-retirement-row-load',
          expectedMinimumPageBoundaryRows: 1_009,
          maximumUnits: 256,
          rows: LOAD_ROWS,
          vectorBytes: 16,
          withPointer: true,
          verifyZeroBackfill: true,
        }),
      ).pipe(provideTestLayer(loadEvidenceLoggerLayer), provideTestLayer(VectorLoadLayer)),
    120_000,
  );

  effectIt.effect(
    'keeps a near-32 MiB thousand-row delete inside the combined reservation envelope',
    () =>
      TestClock.withLive(
        runVectorLoadCase({
          event: 'code-graph-vector-retirement-byte-load',
          expectedMinimumPageBoundaryBytes: 31 * 1_048_576,
          maximumUnits: 20,
          rows: BYTE_PAGE_ROWS,
          vectorBytes: BYTE_PAGE_VECTOR_BYTES,
          withPointer: false,
          verifyZeroBackfill: false,
        }),
      ).pipe(provideTestLayer(loadEvidenceLoggerLayer), provideTestLayer(VectorLoadLayer)),
    120_000,
  );
});

function runVectorLoadCase(options: {
  readonly event: string;
  readonly expectedMinimumPageBoundaryBytes?: number;
  readonly expectedMinimumPageBoundaryRows?: number;
  readonly maximumUnits: number;
  readonly rows: number;
  readonly vectorBytes: number;
  readonly verifyZeroBackfill: boolean;
  readonly withPointer: boolean;
}) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-retirement-load-'});
      const home = yield* fs.realPath(root);
      const input: CodeGraphOrdinaryVectorMaintenanceUnitInput = {checkoutId: CHECKOUT_ID, threadnoteHome: home};
      const modelRoot = path.join(home, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'vectors', 'model-load');
      const databasePath = path.join(modelRoot, VECTOR_DATABASE_NAME);
      yield* fs.makeDirectory(modelRoot, {recursive: true, mode: 0o700});
      const seedStartedAt = performance.now();
      yield* Effect.sync(() =>
        seedVectorDatabase(databasePath, options.rows, options.vectorBytes, options.withPointer),
      );
      yield* Effect.sync(() => checkpointDatabase(databasePath));
      const seedElapsedMilliseconds = performance.now() - seedStartedAt;
      const storage = readStorageProfile(databasePath);
      expect(storage).toEqual({pageSize: 4_096, walAutoCheckpointPages: 1_000});

      const measurements: VectorLoadMeasurement[] = [];
      let pending: PendingMeasurement | undefined;
      let pointerRetired = !options.withPointer;
      let finalState: 'complete' | 'deferred' | 'progress' | undefined;
      let deferredUnits = 0;
      const runStartedAt = performance.now();
      for (let unit = 0; unit < options.maximumUnits; unit += 1) {
        const beforeUnit = readVectorCounts(databasePath);
        const result = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(input, {
          afterModelCommitBeforeFinalCursorCas: () =>
            Effect.gen(function* () {
              if (pending === undefined)
                return yield* Effect.die(TestError.make({message: 'Vector load measurement was absent.'}));
              const after = readVectorCounts(databasePath);
              const afterMainBytes = yield* observedFileSize(fs, databasePath);
              const afterWalBytes = yield* observedFileSize(fs, `${databasePath}-wal`);
              const mainGrowthBytes = Math.max(0, afterMainBytes - pending.mainBytes);
              const walGrowthBytes = Math.max(0, afterWalBytes - pending.walBytes);
              const sharedGrowthBytes = Math.max(
                0,
                afterMainBytes + afterWalBytes - pending.mainBytes - pending.walBytes,
              );
              const vectorsDeleted = pending.counts.vectors - after.vectors;
              const stage =
                !pending.counts.retirementReady && after.retirementReady
                  ? ('schema' as const)
                  : pending.counts.markers < after.markers
                    ? ('admission' as const)
                    : vectorsDeleted > 0
                      ? ('page' as const)
                      : ('admission' as const);
              const demand = codeGraphVectorRetirementCapacityDemand({
                finalFactBytes: pending.boundary.finalFactBytes,
                lexicalFormatVersion: 1,
                operation: pending.boundary.operation,
                pageSize: storage.pageSize,
                rowCount: pending.boundary.rowCount,
                walAutoCheckpointPages: storage.walAutoCheckpointPages,
              });
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
              expect(vectorsDeleted).toBeGreaterThanOrEqual(0);
              expect(vectorsDeleted).toBeLessThanOrEqual(1_000);
              expect(yield* activeReceiptOperations(fs, path, home)).toEqual(['maintain code graph vector retirement']);
              measurements.push({
                boundary: pending.boundary,
                elapsedMilliseconds: performance.now() - pending.startedAtMilliseconds,
                mainGrowthBytes,
                rssBytes: process.memoryUsage().rss,
                sharedGrowthBytes,
                stage,
                vectorsDeleted,
                walGrowthBytes,
              });
              pending = undefined;
            }),
          availableDiskBytes: () => Effect.succeed(Number.MAX_SAFE_INTEGER),
          beforeCapacityAttempt: boundary =>
            Effect.gen(function* () {
              pending = {
                boundary,
                counts: readVectorCounts(databasePath),
                mainBytes: yield* observedFileSize(fs, databasePath),
                startedAtMilliseconds: performance.now(),
                walBytes: yield* observedFileSize(fs, `${databasePath}-wal`),
              };
            }),
          // The production deadline is an independent bounded-unit contract.
          // This load calibration records wall time as evidence, but host speed
          // must not decide whether the database transition is correct.
          deadlineMonotonicMilliseconds: 250,
          monotonicMilliseconds: () => 0,
          reservationMode: 'nonblocking-one-attempt',
        });
        finalState = result.state;
        expect(yield* activeReceiptOperations(fs, path, home)).toEqual([]);
        if (result.state === 'deferred') {
          // A transient zero-wait lock or reservation deferral must preserve
          // the exact database prefix and converge on retry.
          expect(readVectorCounts(databasePath)).toEqual(beforeUnit);
          pending = undefined;
          deferredUnits += 1;
          continue;
        }
        if (!pointerRetired && readVectorCounts(databasePath).retirementReady) {
          const beforePointer = readVectorCounts(databasePath);
          const protector = yield* makeCodeGraphVectorRetirementCapacityProtector({
            availableDiskBytes: () => Effect.succeed(Number.MAX_SAFE_INTEGER),
            claimMode: 'nonblocking-one-attempt',
            databasePath,
            threadnoteHome: home,
          });
          expect(
            yield* retireCodeGraphVectorPointerWithCapacity(
              databasePath,
              {expectedSnapshotId: 'snapshot-load', worktreeId: Effect2.pipe('b', EffectString.repeat(64))},
              {capacityProtector: protector},
            ),
          ).toBe(1);
          const afterPointer = readVectorCounts(databasePath);
          expect(afterPointer).toEqual({...beforePointer, markers: 1, pointers: 0});
          expect(afterPointer.vectors).toBe(options.rows);
          expect(yield* activeReceiptOperations(fs, path, home)).toEqual([]);
          pointerRetired = true;
        }
        if (result.state === 'complete') break;
        expect(result.state).toBe('progress');
      }

      expect(finalState).toBe('complete');
      expect(readVectorCounts(databasePath)).toEqual({
        generations: 0,
        markers: 0,
        pointers: 0,
        retirementReady: true,
        vectors: 0,
      });
      const schemaMeasurements = EffectArray.filter(measurements, measurement => measurement.stage === 'schema');
      const admissionMeasurements = EffectArray.filter(measurements, measurement => measurement.stage === 'admission');
      const pageMeasurements = EffectArray.filter(measurements, measurement => measurement.stage === 'page');
      expect(schemaMeasurements.length).toBeGreaterThanOrEqual(1);
      expect(admissionMeasurements.length).toBeGreaterThanOrEqual(1);
      expect(pageMeasurements.length).toBeGreaterThanOrEqual(1);
      expect(EffectArray.reduce(pageMeasurements, 0, (total, measurement) => total + measurement.vectorsDeleted)).toBe(
        options.rows,
      );
      expect(
        EffectArray.every(
          measurements,
          measurement => measurement.boundary.operation === 'maintain code graph vector retirement',
        ),
      ).toBe(true);
      if (options.expectedMinimumPageBoundaryRows !== undefined) {
        expect(
          Math.max(...EffectArray.map(pageMeasurements, measurement => measurement.boundary.rowCount)),
        ).toBeGreaterThanOrEqual(options.expectedMinimumPageBoundaryRows);
      }
      if (options.expectedMinimumPageBoundaryBytes !== undefined) {
        expect(
          Math.max(...EffectArray.map(pageMeasurements, measurement => measurement.boundary.finalFactBytes)),
        ).toBeGreaterThanOrEqual(options.expectedMinimumPageBoundaryBytes);
      }
      if (options.verifyZeroBackfill) {
        expect(schemaMeasurements[0]?.vectorsDeleted).toBe(0);
        expect(schemaMeasurements[0]?.sharedGrowthBytes).toBeLessThan(1_048_576);
      }

      yield* Effect.logInfo(
        JSON.stringify({
          admissionTransactions: admissionMeasurements.length,
          deferredUnits,
          event: options.event,
          maximumBoundaryBytes: Math.max(
            ...EffectArray.map(measurements, measurement => measurement.boundary.finalFactBytes),
          ),
          maximumBoundaryRows: Math.max(...EffectArray.map(measurements, measurement => measurement.boundary.rowCount)),
          maximumElapsedMilliseconds: Math.max(
            ...EffectArray.map(measurements, measurement => measurement.elapsedMilliseconds),
          ),
          maximumMainGrowthBytes: Math.max(
            ...EffectArray.map(measurements, measurement => measurement.mainGrowthBytes),
          ),
          maximumRssBytes: Math.max(...EffectArray.map(measurements, measurement => measurement.rssBytes)),
          maximumSharedGrowthBytes: Math.max(
            ...EffectArray.map(measurements, measurement => measurement.sharedGrowthBytes),
          ),
          maximumWalGrowthBytes: Math.max(...EffectArray.map(measurements, measurement => measurement.walGrowthBytes)),
          pageTransactions: pageMeasurements.length,
          pointerRetired,
          rows: options.rows,
          runElapsedMilliseconds: performance.now() - runStartedAt,
          schemaTransactions: schemaMeasurements.length,
          seedElapsedMilliseconds,
          vectorBytes: options.vectorBytes,
        }),
      );
    }),
  );
}

function seedVectorDatabase(databasePath: string, rows: number, vectorBytes: number, withPointer: boolean): void {
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
         ) VALUES ('generation-load', 'snapshot-load', 'model-load', ?, 384, 1, ?, 'ready', ?)`,
      )
      .run(Effect2.pipe('f', EffectString.repeat(64)), rows, new Date(0).toISOString());
    if (withPointer) {
      database
        .query("INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, 'generation-load')")
        .run(Effect2.pipe('b', EffectString.repeat(64)));
    }
    const vector = new Uint8Array(vectorBytes);
    const insert = database.prepare(
      `INSERT INTO vectors (generation, symbol_id, fingerprint, vector)
       VALUES ('generation-load', ?, ?, ?)`,
    );
    database.transaction(() => {
      for (let index = 0; index < rows; index += 1) {
        insert.run(
          `symbol-${Effect2.pipe(index.toString(), EffectString.padStart(6, '0'))}`,
          Effect2.pipe('e', EffectString.repeat(64)),
          vector,
        );
      }
    })();
    database.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 1000;');
  } finally {
    database.close(false);
  }
}

function checkpointDatabase(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    database.close(false);
  }
}

function readStorageProfile(databasePath: string): {
  readonly pageSize: number;
  readonly walAutoCheckpointPages: number;
} {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      pageSize: Number(
        requiredRow(database.query<{readonly page_size: number}, SQLQueryBindings[]>('PRAGMA page_size').get())
          .page_size,
      ),
      walAutoCheckpointPages: Number(
        requiredRow(
          database.query<{readonly wal_autocheckpoint: number}, SQLQueryBindings[]>('PRAGMA wal_autocheckpoint').get(),
        ).wal_autocheckpoint,
      ),
    };
  } finally {
    database.close(false);
  }
}

function readVectorCounts(databasePath: string): VectorCounts {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const hasMarkers =
      Number(
        requiredRow(
          database
            .query<{readonly count: number}, SQLQueryBindings[]>(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'vector_generation_retirements'",
            )
            .get(),
        ).count,
      ) === 1;
    return {
      generations: Number(
        requiredRow(
          database
            .query<{readonly count: number}, SQLQueryBindings[]>('SELECT COUNT(*) AS count FROM vector_generations')
            .get(),
        ).count,
      ),
      markers: hasMarkers
        ? Number(
            requiredRow(
              database
                .query<
                  {
                    readonly count: number;
                  },
                  SQLQueryBindings[]
                >('SELECT COUNT(*) AS count FROM vector_generation_retirements')
                .get(),
            ).count,
          )
        : 0,
      pointers: Number(
        requiredRow(
          database
            .query<{readonly count: number}, SQLQueryBindings[]>('SELECT COUNT(*) AS count FROM vector_pointers')
            .get(),
        ).count,
      ),
      retirementReady: hasMarkers,
      vectors: Number(
        requiredRow(
          database.query<{readonly count: number}, SQLQueryBindings[]>('SELECT COUNT(*) AS count FROM vectors').get(),
        ).count,
      ),
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
      fs.readFileString(path.join(root, name)).pipe(Effect.map(operationFromRecordedJson)),
    );
  });
}

function observedFileSize(fs: FileSystem.FileSystem, filePath: string) {
  return fs.stat(filePath).pipe(
    Effect.map(info => Number(info.size)),
    Effect.orElseSucceed(() => 0),
  );
}
