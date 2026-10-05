import {Crypto, Effect, FileSystem, Option, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {
  codeGraphVectorRetirementCapacityDemand,
  type CodeGraphDirectPersistentCapacityBoundary,
} from '../disk/capacity.js';
import {codeGraphDiskReservationFilesystemKey, withCodeGraphDiskReservation} from '../disk/reservation.js';
import {codeGraphDiskReservationLockPath, codeGraphDiskReservationRoot} from '../layout.js';
import {classifyCodeGraphLifecycle} from '../lifecycle/classification.js';
import {
  boundedRetirementLimit,
  codeGraphVectorCoreSchemaCurrent,
  codeGraphVectorCoreSchemaState,
  codeGraphVectorRetirementSchemaState,
  inspectCodeGraphVectorPageStorage,
  inspectLegacyPointerIndexPlan,
  inspectVectorPageStorageSql,
  lastStatementChangeCount,
  sameLegacyPointerIndexPlan,
  sameVectorPageStorage,
  selectVectorRetirementMarker,
  useExistingVectorDatabase,
  useReadOnlyVectorDatabase,
  validBoundedText,
  vectorRetirementPageAuthorityBytes,
  type CodeGraphVectorPageStorage,
  type CodeGraphVectorRetirementMarker,
  type LegacyPointerIndexPlan,
} from './retirement/inspection.js';
import {
  CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL,
  CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL,
  CODE_GRAPH_VECTOR_RETIREMENT_ASSOCIATION_INDEX_SQL,
  CODE_GRAPH_VECTOR_RETIREMENT_PAGE_BYTES,
  CODE_GRAPH_VECTOR_RETIREMENT_PAGE_FIXED_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_PAGE_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_BYTES,
  CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL,
  CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS,
  CodeGraphVectorRetirementError,
  MAXIMUM_SAFE_INTEGER_SQL,
  VECTOR_CREATED_AT_BYTES,
  VECTOR_FINGERPRINT_BYTES,
  VECTOR_GENERATION_BYTES,
  VECTOR_MODEL_ID_BYTES,
  VECTOR_MODEL_SHA256_BYTES,
  VECTOR_SNAPSHOT_BYTES,
  VECTOR_SYMBOL_BYTES,
  storedSchemaSql,
} from './retirement/schema.js';

export {
  codeGraphVectorRetirementLegacyPointerProbeStatement,
  inspectCodeGraphVectorPageStorage,
  selectCodeGraphVectorRetirementMarker,
  type CodeGraphVectorPageStorage,
  type CodeGraphVectorRetirementMarker,
  type LegacyPointerIndexPlan,
} from './retirement/inspection.js';
export {
  CODE_GRAPH_VECTORS_TABLE_SQL,
  CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL,
  CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL,
  CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL,
  CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL,
  CODE_GRAPH_VECTOR_RETIREMENT_ASSOCIATION_INDEX_SQL,
  CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_BYTES,
  CODE_GRAPH_VECTOR_RETIREMENT_LEGACY_POINTER_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_PAGE_BYTES,
  CODE_GRAPH_VECTOR_RETIREMENT_PAGE_FIXED_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_PAGE_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_BYTES,
  CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_ROWS,
  CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL,
  CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS,
  CODE_GRAPH_VECTOR_REUSE_INDEX_SQL,
} from './retirement/schema.js';

export type CodeGraphVectorRetirementPreparationResult = {readonly state: 'prepared' | 'ready'};

export type CodeGraphVectorRetirementPageResult =
  | {readonly remaining: false; readonly rowsDeleted: 0; readonly state: 'stale'}
  | {readonly remaining: false; readonly rowsDeleted: number; readonly state: 'complete'}
  | {
      readonly marker: CodeGraphVectorRetirementMarker;
      readonly remaining: true;
      readonly rowsDeleted: number;
      readonly state: 'progress';
    };

export interface CodeGraphVectorRetirementPageInput {
  readonly epoch?: number;
  readonly generation: string;
  readonly requestedLimit?: number;
  readonly retirementId?: number;
}

export interface CodeGraphVectorRetirementCapacityProtector {
  <A, E, R>(
    boundary: CodeGraphDirectPersistentCapacityBoundary,
    transaction: Effect.Effect<A, E, R>,
    storage: CodeGraphVectorPageStorage,
  ): Effect.Effect<A, unknown, R>;
}

export interface CodeGraphVectorRetirementExecutionOptions {
  readonly capacityProtector: CodeGraphVectorRetirementCapacityProtector;
}

export interface CodeGraphVectorRetirementCapacityProtectionOptions {
  readonly availableDiskBytes?: (
    path: string,
    boundary: CodeGraphDirectPersistentCapacityBoundary,
  ) => Effect.Effect<number | undefined, unknown>;
  readonly databasePath: string;
  readonly claimMode?: 'nonblocking-one-attempt' | 'wait';
  readonly temporaryDirectory?: string;
  readonly threadnoteHome: string;
}

/** Builds the home-global receipt bracket used by vector schema/page writers. */
export const makeCodeGraphVectorRetirementCapacityProtector = Effect.fn(
  'codeGraph.makeVectorRetirementCapacityProtector',
)(function* (options: CodeGraphVectorRetirementCapacityProtectionOptions) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const temporaryDirectory = options.temporaryDirectory ?? system.tempDirectory;
  const protector: CodeGraphVectorRetirementCapacityProtector = (boundary, transaction, storage) =>
    withCodeGraphDiskReservation(
      {
        boundary,
        claimMode: options.claimMode,
        ledgerLockPath: codeGraphDiskReservationLockPath(path, options.threadnoteHome),
        ledgerRoot: codeGraphDiskReservationRoot(path, options.threadnoteHome),
        maintenance: Effect.void,
        observe: observeCodeGraphVectorRetirementCapacity({
          boundary,
          databasePath: options.databasePath,
          fs,
          path,
          probe: options.availableDiskBytes ?? ((target: string) => system.availableDiskBytes(target)),
          storage,
          system,
          temporaryDirectory,
        }),
      },
      transaction,
    ).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(SystemInfo, system),
    );
  return protector;
});

const observeCodeGraphVectorRetirementCapacity = Effect.fn('codeGraph.observeVectorRetirementCapacity')(
  function* (input: {
    readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
    readonly databasePath: string;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly probe: (
      path: string,
      boundary: CodeGraphDirectPersistentCapacityBoundary,
    ) => Effect.Effect<number | undefined, unknown>;
    readonly system: SystemInfoShape;
    readonly storage: CodeGraphVectorPageStorage;
    readonly temporaryDirectory: string;
  }) {
    const durableRoot = input.path.dirname(input.databasePath);
    const [durableInfo, temporaryInfo, durableAvailableBytes, temporaryAvailableBytes, storage] = yield* Effect.all(
      [
        input.fs.stat(durableRoot).pipe(Effect.option),
        input.fs.stat(input.temporaryDirectory).pipe(Effect.option),
        input.probe(durableRoot, input.boundary).pipe(Effect.orElseSucceed(() => undefined)),
        input.probe(input.temporaryDirectory, input.boundary).pipe(Effect.orElseSucceed(() => undefined)),
        inspectCodeGraphVectorPageStorage(input.databasePath).pipe(Effect.option),
      ] as const,
      {concurrency: 2},
    );
    const pageStorage = Option.getOrUndefined(storage);
    if (pageStorage === undefined || !sameVectorPageStorage(input.storage, pageStorage)) {
      return yield* CodeGraphVectorRetirementError.make({
        message: 'Code graph vector page storage changed before reservation.',
      });
    }
    const durableDevice = Option.isSome(durableInfo) ? durableInfo.value.dev : undefined;
    const temporaryDevice = Option.isSome(temporaryInfo) ? temporaryInfo.value.dev : undefined;
    return {
      demand: codeGraphVectorRetirementCapacityDemand({
        finalFactBytes: input.boundary.finalFactBytes,
        lexicalFormatVersion: 1,
        operation: input.boundary.operation,
        pageSize: pageStorage?.pageSize ?? 0,
        rowCount: input.boundary.rowCount,
        walAutoCheckpointPages: pageStorage?.walAutoCheckpointPages ?? 0,
      }),
      durableAvailableBytes,
      durableFilesystemKey:
        codeGraphDiskReservationFilesystemKey(input.system.platform, durableDevice) ?? 'durable-filesystem-unknown',
      // SQLite freelist pages cannot fund the ordinary cursor's external
      // temp/final files, so the combined operation admits against raw space.
      freelistBytes:
        input.boundary.operation === 'maintain code graph vector retirement' ? 0 : (pageStorage?.freelistBytes ?? 0),
      temporaryAvailableBytes,
      temporaryFilesystemKey:
        codeGraphDiskReservationFilesystemKey(input.system.platform, temporaryDevice) ?? 'temporary-filesystem-unknown',
    };
  },
);

export type CodeGraphVectorRetirementPagePlan =
  | {readonly result: Extract<CodeGraphVectorRetirementPageResult, {readonly state: 'stale'}>; readonly state: 'stale'}
  | {
      readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
      readonly generation: string;
      readonly generationManifest: CodeGraphVectorGenerationManifest;
      readonly lastSymbolId?: string;
      readonly marker: CodeGraphVectorRetirementMarker;
      readonly requestedLimit: number;
      readonly selectedRowCount: number;
      readonly state: 'planned';
      readonly storage: CodeGraphVectorPageStorage;
    };

export interface CodeGraphVectorPointerRetirementInput {
  readonly expectedSnapshotId: string;
  readonly worktreeId: string;
}

interface CodeGraphVectorPointerRetirementObservation {
  readonly generationManifest: CodeGraphVectorGenerationManifest;
  readonly worktreeId: string;
}

export type CodeGraphVectorPointerRetirementPlan =
  | {readonly result: 0; readonly state: 'unchanged'}
  | {
      readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
      readonly input: CodeGraphVectorPointerRetirementInput;
      readonly observation: CodeGraphVectorPointerRetirementObservation;
      readonly state: 'planned';
      readonly storage: CodeGraphVectorPageStorage;
    };

const observeVectorPointerRetirement = Effect.fn('codeGraph.observeVectorPointerRetirement')(function* (
  sql: SqlClient.SqlClient,
  input: CodeGraphVectorPointerRetirementInput,
) {
  const rows = yield* sql.unsafe<{
    readonly generation: unknown;
    readonly snapshot_id: unknown;
    readonly worktree_id: unknown;
  }>(
    `SELECT
       CASE WHEN typeof(pointer.worktree_id) = 'text'
              AND length(CAST(pointer.worktree_id AS BLOB)) = 64
              AND pointer.worktree_id NOT GLOB '*[^0-9a-f]*'
            THEN pointer.worktree_id ELSE NULL END AS worktree_id,
       CASE WHEN typeof(pointer.generation) = 'text'
              AND length(CAST(pointer.generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
              AND instr(pointer.generation, char(0)) = 0
            THEN pointer.generation ELSE NULL END AS generation,
       CASE WHEN typeof(generation.snapshot_id) = 'text'
              AND length(CAST(generation.snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
              AND instr(generation.snapshot_id, char(0)) = 0
            THEN generation.snapshot_id ELSE NULL END AS snapshot_id
     FROM vector_pointers AS pointer
     JOIN vector_generations AS generation ON generation.generation = pointer.generation
     WHERE pointer.worktree_id = ?
     LIMIT 2`,
    [input.worktreeId],
  );
  if (rows.length === 0) return undefined;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.worktree_id !== input.worktreeId ||
    typeof row.generation !== 'string' ||
    typeof row.snapshot_id !== 'string'
  ) {
    return yield* CodeGraphVectorRetirementError.make({
      message: 'Code graph vector pointer retirement authority is invalid.',
    });
  }
  if (row.snapshot_id !== input.expectedSnapshotId) return undefined;
  const generationManifest = yield* inspectBoundedVectorGenerationManifest(sql, row.generation);
  if (generationManifest.snapshotId !== input.expectedSnapshotId) {
    return yield* CodeGraphVectorRetirementError.make({
      message: 'Code graph vector pointer retirement authority changed.',
    });
  }
  if ((yield* selectVectorRetirementMarker(sql, row.generation)) !== undefined) {
    return yield* CodeGraphVectorRetirementError.make({
      message: 'Code graph vector pointer retirement marker is already authoritative.',
    });
  }
  return {generationManifest, worktreeId: input.worktreeId} satisfies CodeGraphVectorPointerRetirementObservation;
});

function sameVectorPointerRetirementObservation(
  left: CodeGraphVectorPointerRetirementObservation,
  right: CodeGraphVectorPointerRetirementObservation,
): boolean {
  return (
    left.worktreeId === right.worktreeId &&
    sameVectorGenerationManifest(left.generationManifest, right.generationManifest)
  );
}

export const planCodeGraphVectorPointerRetirement = Effect.fn('codeGraph.planVectorPointerRetirement')(function* (
  databasePath: string,
  input: CodeGraphVectorPointerRetirementInput,
) {
  if (!/^[0-9a-f]{64}$/.test(input.worktreeId) || !validBoundedText(input.expectedSnapshotId, VECTOR_SNAPSHOT_BYTES)) {
    return yield* CodeGraphVectorRetirementError.make({
      message: 'Code graph vector pointer retirement target is invalid.',
    });
  }
  return yield* useExistingVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA foreign_keys = ON');
      yield* sql.unsafe('PRAGMA busy_timeout = 0');
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement schema is incompatible.',
        });
      }
      const observation = yield* observeVectorPointerRetirement(sql, input);
      if (observation === undefined) {
        return {result: 0, state: 'unchanged'} as const satisfies CodeGraphVectorPointerRetirementPlan;
      }
      return {
        boundary: {
          finalFactBytes:
            observation.generationManifest.finalFactBytes +
            new TextEncoder().encode(observation.generationManifest.generation).byteLength +
            new TextEncoder().encode(observation.generationManifest.snapshotId).byteLength +
            64 +
            512,
          operation: 'retire code graph vector pointer',
          rowCount: 4,
        },
        input,
        observation,
        state: 'planned',
        storage: yield* inspectVectorPageStorageSql(sql),
      } satisfies CodeGraphVectorPointerRetirementPlan;
    }),
  );
});

export const commitCodeGraphVectorPointerRetirement = Effect.fn('codeGraph.commitVectorPointerRetirement')(function* (
  databasePath: string,
  plan: Extract<CodeGraphVectorPointerRetirementPlan, {readonly state: 'planned'}>,
) {
  return yield* useExistingVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA foreign_keys = ON');
      yield* sql.unsafe('PRAGMA busy_timeout = 0');
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (
            !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
            (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready' ||
            !sameVectorPageStorage(plan.storage, yield* inspectVectorPageStorageSql(sql))
          ) {
            return yield* CodeGraphVectorRetirementError.make({
              message: 'Code graph vector pointer retirement authority changed.',
            });
          }
          const observed = yield* observeVectorPointerRetirement(sql, plan.input);
          if (observed === undefined) return 0;
          if (!sameVectorPointerRetirementObservation(plan.observation, observed)) {
            return yield* CodeGraphVectorRetirementError.make({
              message: 'Code graph vector pointer retirement plan changed.',
            });
          }
          yield* sql.unsafe(
            `UPDATE vector_retirement_state
             SET pointer_delete_worktree_id = ?,
                 pointer_delete_generation = ?,
                 pointer_delete_snapshot_id = ?
             WHERE singleton = 1
               AND pointer_delete_worktree_id IS NULL
               AND pointer_delete_generation IS NULL
               AND pointer_delete_snapshot_id IS NULL`,
            [plan.input.worktreeId, observed.generationManifest.generation, observed.generationManifest.snapshotId],
          );
          if ((yield* lastStatementChangeCount(sql)) !== 1) {
            return yield* CodeGraphVectorRetirementError.make({
              message: 'Code graph vector pointer retirement authority is busy.',
            });
          }
          yield* sql.unsafe('DELETE FROM vector_pointers WHERE worktree_id = ? AND generation = ?', [
            plan.input.worktreeId,
            observed.generationManifest.generation,
          ]);
          if ((yield* lastStatementChangeCount(sql)) !== 1) {
            return yield* CodeGraphVectorRetirementError.make({
              message: 'Code graph vector pointer retirement target changed.',
            });
          }
          const authority = yield* sql.unsafe(
            `SELECT 1 FROM vector_retirement_state
             WHERE singleton = 1
               AND pointer_delete_worktree_id IS NULL
               AND pointer_delete_generation IS NULL
               AND pointer_delete_snapshot_id IS NULL
             LIMIT 1`,
          );
          if (authority.length !== 1) {
            return yield* CodeGraphVectorRetirementError.make({
              message: 'Code graph vector pointer retirement authority was retained.',
            });
          }
          return 1;
        }),
      );
    }),
  );
});

export const retireCodeGraphVectorPointerWithCapacity = Effect.fn('codeGraph.retireVectorPointerWithCapacity')(
  function* (
    databasePath: string,
    input: CodeGraphVectorPointerRetirementInput,
    options: CodeGraphVectorRetirementExecutionOptions,
  ) {
    const plan = yield* planCodeGraphVectorPointerRetirement(databasePath, input);
    if (plan.state === 'unchanged') return plan.result;
    return yield* options.capacityProtector(
      plan.boundary,
      commitCodeGraphVectorPointerRetirement(databasePath, plan),
      plan.storage,
    );
  },
);

/**
 * Authorizes and consumes one exact pointer deletion in one transaction. The
 * credential is never committed: its AFTER trigger clears it after the exact
 * row is deleted, while every failure rolls the entire transaction back.
 */
export const deleteCodeGraphVectorPointerWithRetirement = Effect.fn('codeGraph.deleteVectorPointerWithRetirement')(
  function* (databasePath: string, input: CodeGraphVectorPointerRetirementInput) {
    if (
      !/^[0-9a-f]{64}$/.test(input.worktreeId) ||
      !validBoundedText(input.expectedSnapshotId, VECTOR_SNAPSHOT_BYTES)
    ) {
      return yield* CodeGraphVectorRetirementError.make({
        message: 'Code graph vector pointer retirement target is invalid.',
      });
    }
    return yield* useExistingVectorDatabase(
      databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('PRAGMA foreign_keys = ON');
        yield* sql.unsafe('PRAGMA busy_timeout = 0');
        if (
          !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
          (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
        ) {
          return yield* CodeGraphVectorRetirementError.make({
            message: 'Code graph vector retirement schema is incompatible.',
          });
        }
        return yield* deleteCodeGraphVectorPointerWithRetirementSql(sql, input);
      }),
    );
  },
);

export const deleteCodeGraphVectorPointerWithRetirementSql = Effect.fn(
  'codeGraph.deleteVectorPointerWithRetirementSql',
)(function* (sql: SqlClient.SqlClient, input: CodeGraphVectorPointerRetirementInput) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement schema is incompatible.',
        });
      }
      const rows = yield* sql.unsafe<{
        readonly generation: unknown;
        readonly snapshot_id: unknown;
      }>(
        `SELECT
           CASE
             WHEN typeof(pointer.generation) = 'text'
              AND length(CAST(pointer.generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
              AND instr(pointer.generation, char(0)) = 0
             THEN pointer.generation ELSE NULL
           END AS generation,
           CASE
             WHEN typeof(generation.snapshot_id) = 'text'
              AND length(CAST(generation.snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
              AND instr(generation.snapshot_id, char(0)) = 0
             THEN generation.snapshot_id ELSE NULL
           END AS snapshot_id
         FROM vector_pointers AS pointer
         JOIN vector_generations AS generation ON generation.generation = pointer.generation
         WHERE pointer.worktree_id = ?
         LIMIT 2`,
        [input.worktreeId],
      );
      if (rows.length === 0) return 0;
      const row = rows[0];
      if (rows.length !== 1 || typeof row?.generation !== 'string' || typeof row.snapshot_id !== 'string') {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector pointer retirement authority is invalid.',
        });
      }
      if (row.snapshot_id !== input.expectedSnapshotId) return 0;
      yield* sql.unsafe(
        `UPDATE vector_retirement_state
         SET pointer_delete_worktree_id = ?,
             pointer_delete_generation = ?,
             pointer_delete_snapshot_id = ?
         WHERE singleton = 1
           AND pointer_delete_worktree_id IS NULL
           AND pointer_delete_generation IS NULL
           AND pointer_delete_snapshot_id IS NULL`,
        [input.worktreeId, row.generation, row.snapshot_id],
      );
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector pointer retirement authority is busy.',
        });
      }
      yield* sql.unsafe('DELETE FROM vector_pointers WHERE worktree_id = ? AND generation = ?', [
        input.worktreeId,
        row.generation,
      ]);
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector pointer retirement target changed.',
        });
      }
      const authority = yield* sql.unsafe(
        `SELECT 1 FROM vector_retirement_state
         WHERE singleton = 1
           AND pointer_delete_worktree_id IS NULL
           AND pointer_delete_generation IS NULL
           AND pointer_delete_snapshot_id IS NULL
         LIMIT 1`,
      );
      if (authority.length !== 1) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector pointer retirement authority was retained.',
        });
      }
      return 1;
    }),
  );
});

export type CodeGraphVectorRetirementPreparationPlan =
  | {readonly state: 'ready'}
  | {
      readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
      readonly coreState: 'missing-pointer-index' | 'ready';
      readonly legacy?: LegacyPointerIndexPlan;
      readonly retirementState: 'absent';
      readonly state: 'planned';
      readonly storage: CodeGraphVectorPageStorage;
    };

export const planCodeGraphVectorRetirementPreparation = Effect.fn('codeGraph.planVectorRetirementPreparation')(
  function* (databasePath: string) {
    const observed = yield* useExistingVectorDatabase(
      databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('PRAGMA foreign_keys = ON');
        yield* sql.unsafe('PRAGMA busy_timeout = 0');
        const versions = yield* sql.unsafe<{readonly user_version: unknown}>('PRAGMA user_version');
        if (versions.length !== 1 || versions[0]?.user_version !== 2) {
          return yield* CodeGraphVectorRetirementError.make({
            message: 'Code graph vector database version is unsupported.',
          });
        }
        const coreState = yield* codeGraphVectorCoreSchemaState(sql);
        if (coreState === 'incompatible') {
          return yield* CodeGraphVectorRetirementError.make({
            message: 'Code graph vector database authority is incompatible.',
          });
        }
        if (coreState === 'ready') {
          const retirementState = yield* codeGraphVectorRetirementSchemaState(sql);
          if (retirementState === 'ready') return {state: 'ready'} as const;
          if (retirementState === 'incompatible') {
            return yield* CodeGraphVectorRetirementError.make({
              message: 'Code graph vector retirement schema is incompatible.',
            });
          }
          return {
            coreState,
            retirementState: 'absent' as const,
            state: 'planned',
            storage: yield* inspectVectorPageStorageSql(sql),
          } as const;
        }
        if ((yield* codeGraphVectorRetirementSchemaState(sql)) !== 'absent') {
          return yield* CodeGraphVectorRetirementError.make({
            message: 'Code graph vector retirement authority is incomplete.',
          });
        }
        const legacy = yield* inspectLegacyPointerIndexPlan(sql);
        return {
          coreState,
          legacy,
          retirementState: 'absent' as const,
          state: 'planned',
          storage: legacy.storage,
        } as const;
      }),
    );
    if (observed.state === 'ready') return observed satisfies CodeGraphVectorRetirementPreparationPlan;
    const boundary: CodeGraphDirectPersistentCapacityBoundary = {
      finalFactBytes:
        CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_BYTES +
        (observed.coreState === 'missing-pointer-index'
          ? observed.legacy.finalFactBytes +
            new TextEncoder().encode(storedSchemaSql(CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL)).byteLength
          : 0),
      operation: 'prepare code graph vector retirement schema',
      rowCount:
        CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_FIXED_ROWS +
        (observed.coreState === 'missing-pointer-index' ? observed.legacy.rows.length + 1 : 0),
    };
    return {...observed, boundary} satisfies CodeGraphVectorRetirementPreparationPlan;
  },
);

export const commitCodeGraphVectorRetirementPreparation = Effect.fn('codeGraph.commitVectorRetirementPreparation')(
  function* (
    databasePath: string,
    plan: Extract<CodeGraphVectorRetirementPreparationPlan, {readonly state: 'planned'}>,
  ) {
    return yield* useExistingVectorDatabase(
      databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('PRAGMA foreign_keys = ON');
        yield* sql.unsafe('PRAGMA busy_timeout = 0');
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const coreState = yield* codeGraphVectorCoreSchemaState(sql);
            if (
              coreState !== plan.coreState ||
              !sameVectorPageStorage(plan.storage, yield* inspectVectorPageStorageSql(sql))
            ) {
              return yield* CodeGraphVectorRetirementError.make({
                message: 'Code graph vector database authority changed during setup.',
              });
            }
            if ((yield* codeGraphVectorRetirementSchemaState(sql)) !== plan.retirementState) {
              return yield* CodeGraphVectorRetirementError.make({
                message: 'Code graph vector retirement authority changed during setup.',
              });
            }
            if (coreState === 'missing-pointer-index') {
              const revalidated = yield* inspectLegacyPointerIndexPlan(sql);
              if (plan.legacy === undefined || !sameLegacyPointerIndexPlan(plan.legacy, revalidated)) {
                return yield* CodeGraphVectorRetirementError.make({
                  message: 'Code graph vector pointer index plan changed during setup.',
                });
              }
              yield* sql.unsafe('PRAGMA temp_store = MEMORY');
              yield* sql.unsafe(CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL);
            }
            const result = yield* publishCodeGraphVectorRetirementSchema(sql);
            if (!(yield* codeGraphVectorCoreSchemaCurrent(sql))) {
              return yield* CodeGraphVectorRetirementError.make({
                message: 'Code graph vector database authority changed during setup.',
              });
            }
            return result;
          }),
        );
      }),
    );
  },
);

export const prepareCodeGraphVectorRetirement = Effect.fn('codeGraph.prepareVectorRetirement')(function* (
  databasePath: string,
  options: CodeGraphVectorRetirementExecutionOptions,
) {
  const plan = yield* planCodeGraphVectorRetirementPreparation(databasePath);
  if (plan.state === 'ready') return plan;
  return yield* options.capacityProtector(
    plan.boundary,
    commitCodeGraphVectorRetirementPreparation(databasePath, plan),
    plan.storage,
  );
});

export const initializeCodeGraphVectorRetirementSchema = Effect.fn('codeGraph.initializeVectorRetirementSchema')(
  function* (sql: SqlClient.SqlClient) {
    if (!(yield* codeGraphVectorCoreSchemaCurrent(sql))) {
      return yield* CodeGraphVectorRetirementError.make({
        message: 'Code graph vector database authority is incompatible.',
      });
    }
    const state = yield* codeGraphVectorRetirementSchemaState(sql);
    if (state === 'ready') return {state: 'ready'} as const;
    if (state === 'incompatible') {
      return yield* CodeGraphVectorRetirementError.make({
        message: 'Code graph vector retirement schema is incompatible.',
      });
    }
    return yield* sql.withTransaction(publishCodeGraphVectorRetirementSchema(sql));
  },
);

export const requireCodeGraphVectorRetirementSchema = Effect.fn('codeGraph.requireVectorRetirementSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  if (
    !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
    (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
  ) {
    return yield* CodeGraphVectorRetirementError.make({
      message: 'Code graph vector retirement schema requires explicit preparation.',
    });
  }
});

const publishCodeGraphVectorRetirementSchema = Effect.fn('codeGraph.publishVectorRetirementSchema')(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql.unsafe(CODE_GRAPH_VECTOR_RETIREMENT_STATE_TABLE_SQL);
  yield* sql.unsafe('INSERT INTO vector_retirement_state (singleton, admission_cursor) VALUES (1, NULL)');
  yield* sql.unsafe(CODE_GRAPH_VECTOR_RETIREMENTS_TABLE_SQL);
  yield* sql.unsafe("INSERT INTO sqlite_sequence (name, seq) VALUES ('vector_generation_retirements', 0)");
  yield* sql.unsafe(CODE_GRAPH_VECTOR_RETIREMENT_ASSOCIATION_INDEX_SQL);
  for (const trigger of CODE_GRAPH_VECTOR_RETIREMENT_TRIGGER_DEFINITIONS) yield* sql.unsafe(trigger.sql);
  if ((yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready') {
    return yield* CodeGraphVectorRetirementError.make({
      message: 'Code graph vector retirement schema changed during setup.',
    });
  }
  return {state: 'prepared'} as const;
});

/** @internal Exact indexed selector used to freeze a bounded vector deletion page. */
export function codeGraphVectorRetirementPageStatement(generation: string, requestedLimit: number) {
  const limit = boundedRetirementLimit(requestedLimit);
  return {
    parameters: [generation, limit] as const,
    text: `SELECT
       CASE
         WHEN typeof(symbol_id) = 'text'
          AND length(CAST(symbol_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SYMBOL_BYTES}
          AND instr(symbol_id, char(0)) = 0
         THEN symbol_id ELSE NULL
       END AS symbol_id,
       length(CAST(symbol_id AS BLOB)) AS symbol_bytes,
       CASE
         WHEN typeof(fingerprint) = 'text'
          AND length(CAST(fingerprint AS BLOB)) BETWEEN 1 AND ${VECTOR_FINGERPRINT_BYTES}
          AND instr(fingerprint, char(0)) = 0
         THEN length(CAST(fingerprint AS BLOB)) ELSE NULL
       END AS fingerprint_bytes,
       CASE
         WHEN typeof(vector) = 'blob'
          AND length(vector) BETWEEN 1 AND ${CODE_GRAPH_VECTOR_RETIREMENT_PAGE_BYTES}
         THEN length(vector) ELSE NULL
       END AS vector_bytes
     FROM vectors INDEXED BY sqlite_autoindex_vectors_1
     WHERE generation = ?
     ORDER BY vectors.symbol_id
     LIMIT ?`,
  };
}

interface BoundedVectorRetirementPage {
  readonly finalFactBytes: number;
  readonly lastSymbolId?: string;
  readonly rowCount: number;
}

interface CodeGraphVectorGenerationManifest {
  readonly count: number;
  readonly createdAt: string;
  readonly dimensions: number;
  readonly finalFactBytes: number;
  readonly generation: string;
  readonly modelId: string;
  readonly modelSha256: string;
  readonly snapshotId: string;
  readonly state: 'building' | 'ready';
  readonly templateVersion: number;
}

const inspectBoundedVectorRetirementPage = Effect.fn('codeGraph.inspectBoundedVectorRetirementPage')(function* (
  sql: SqlClient.SqlClient,
  generation: string,
  limit: number,
) {
  const statement = codeGraphVectorRetirementPageStatement(generation, limit);
  const manifests = yield* sql.unsafe<{
    readonly fingerprint_bytes: unknown;
    readonly symbol_bytes: unknown;
    readonly symbol_id: unknown;
    readonly vector_bytes: unknown;
  }>(statement.text, statement.parameters);
  const generationBytes = new TextEncoder().encode(generation).byteLength;
  let finalFactBytes = 0;
  let lastSymbolId: string | undefined;
  let rowCount = 0;
  for (const manifest of manifests) {
    if (
      typeof manifest.symbol_id !== 'string' ||
      !Number.isSafeInteger(manifest.symbol_bytes) ||
      !Number.isSafeInteger(manifest.fingerprint_bytes) ||
      !Number.isSafeInteger(manifest.vector_bytes)
    ) {
      return yield* CodeGraphVectorRetirementError.make({message: 'Code graph vector retirement manifest is invalid.'});
    }
    const rowBytes =
      Number(manifest.symbol_bytes) +
      Number(manifest.fingerprint_bytes) +
      Number(manifest.vector_bytes) +
      generationBytes +
      64;
    if (!Number.isSafeInteger(rowBytes) || rowBytes <= 0) {
      return yield* CodeGraphVectorRetirementError.make({message: 'Code graph vector retirement manifest is invalid.'});
    }
    if (finalFactBytes + rowBytes > CODE_GRAPH_VECTOR_RETIREMENT_PAGE_BYTES) break;
    finalFactBytes += rowBytes;
    lastSymbolId = manifest.symbol_id;
    rowCount += 1;
  }
  if (manifests.length > 0 && lastSymbolId === undefined) {
    return yield* CodeGraphVectorRetirementError.make({
      message: 'Code graph vector retirement page exceeds its byte bound.',
    });
  }
  return {finalFactBytes, lastSymbolId, rowCount} satisfies BoundedVectorRetirementPage;
});

const inspectBoundedVectorGenerationManifest = Effect.fn('codeGraph.inspectBoundedVectorGenerationManifest')(function* (
  sql: SqlClient.SqlClient,
  expectedGeneration: string,
) {
  const rows = yield* sql.unsafe<{
    readonly bounded_count: unknown;
    readonly bounded_created_at: unknown;
    readonly bounded_dimensions: unknown;
    readonly bounded_generation: unknown;
    readonly bounded_model_id: unknown;
    readonly bounded_model_sha256: unknown;
    readonly bounded_snapshot_id: unknown;
    readonly bounded_state: unknown;
    readonly bounded_template_version: unknown;
  }>(
    `SELECT
       CASE WHEN typeof(generation) = 'text'
              AND length(CAST(generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
              AND instr(generation, char(0)) = 0
            THEN generation ELSE NULL END AS bounded_generation,
       CASE WHEN typeof(snapshot_id) = 'text'
              AND length(CAST(snapshot_id AS BLOB)) BETWEEN 1 AND ${VECTOR_SNAPSHOT_BYTES}
              AND instr(snapshot_id, char(0)) = 0
            THEN snapshot_id ELSE NULL END AS bounded_snapshot_id,
       CASE WHEN typeof(model_id) = 'text'
              AND length(CAST(model_id AS BLOB)) BETWEEN 1 AND ${VECTOR_MODEL_ID_BYTES}
              AND instr(model_id, char(0)) = 0
            THEN model_id ELSE NULL END AS bounded_model_id,
       CASE WHEN typeof(model_sha256) = 'text'
              AND length(CAST(model_sha256 AS BLOB)) = ${VECTOR_MODEL_SHA256_BYTES}
              AND model_sha256 NOT GLOB '*[^0-9a-f]*'
            THEN model_sha256 ELSE NULL END AS bounded_model_sha256,
       CASE WHEN typeof(dimensions) = 'integer'
              AND dimensions BETWEEN 1 AND ${MAXIMUM_SAFE_INTEGER_SQL}
            THEN dimensions ELSE NULL END AS bounded_dimensions,
       CASE WHEN typeof(template_version) = 'integer'
              AND template_version BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
            THEN template_version ELSE NULL END AS bounded_template_version,
       CASE WHEN typeof(count) = 'integer'
              AND count BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
            THEN count ELSE NULL END AS bounded_count,
       CASE WHEN typeof(state) = 'text' AND state IN ('building', 'ready')
            THEN state ELSE NULL END AS bounded_state,
       CASE WHEN typeof(created_at) = 'text'
              AND length(CAST(created_at AS BLOB)) BETWEEN 1 AND ${VECTOR_CREATED_AT_BYTES}
              AND instr(created_at, char(0)) = 0
            THEN created_at ELSE NULL END AS bounded_created_at
     FROM vector_generations
     WHERE generation = ?
     LIMIT 2`,
    [expectedGeneration],
  );
  const row = rows[0];
  if (
    rows.length !== 1 ||
    typeof row?.bounded_generation !== 'string' ||
    row.bounded_generation !== expectedGeneration ||
    typeof row.bounded_snapshot_id !== 'string' ||
    typeof row.bounded_model_id !== 'string' ||
    typeof row.bounded_model_sha256 !== 'string' ||
    !Number.isSafeInteger(row.bounded_dimensions) ||
    !Number.isSafeInteger(row.bounded_template_version) ||
    !Number.isSafeInteger(row.bounded_count) ||
    (row.bounded_state !== 'building' && row.bounded_state !== 'ready') ||
    typeof row.bounded_created_at !== 'string'
  ) {
    return yield* CodeGraphVectorRetirementError.make({message: 'Code graph vector generation manifest is invalid.'});
  }
  const strings = [
    row.bounded_generation,
    row.bounded_snapshot_id,
    row.bounded_model_id,
    row.bounded_model_sha256,
    row.bounded_state,
    row.bounded_created_at,
  ];
  const finalFactBytes = strings.reduce((total, value) => total + new TextEncoder().encode(value).byteLength, 128);
  if (!Number.isSafeInteger(finalFactBytes)) {
    return yield* CodeGraphVectorRetirementError.make({message: 'Code graph vector generation manifest is invalid.'});
  }
  return {
    count: Number(row.bounded_count),
    createdAt: row.bounded_created_at,
    dimensions: Number(row.bounded_dimensions),
    finalFactBytes,
    generation: row.bounded_generation,
    modelId: row.bounded_model_id,
    modelSha256: row.bounded_model_sha256,
    snapshotId: row.bounded_snapshot_id,
    state: row.bounded_state,
    templateVersion: Number(row.bounded_template_version),
  } satisfies CodeGraphVectorGenerationManifest;
});

function sameVectorGenerationManifest(
  left: CodeGraphVectorGenerationManifest,
  right: CodeGraphVectorGenerationManifest,
): boolean {
  return (
    left.count === right.count &&
    left.createdAt === right.createdAt &&
    left.dimensions === right.dimensions &&
    left.finalFactBytes === right.finalFactBytes &&
    left.generation === right.generation &&
    left.modelId === right.modelId &&
    left.modelSha256 === right.modelSha256 &&
    left.snapshotId === right.snapshotId &&
    left.state === right.state &&
    left.templateVersion === right.templateVersion
  );
}

export const planCodeGraphVectorRetirementPage = Effect.fn('codeGraph.planVectorRetirementPage')(function* (
  databasePath: string,
  input: CodeGraphVectorRetirementPageInput,
) {
  const expectedRetirementId = input.retirementId ?? input.epoch;
  if (
    !validBoundedText(input.generation, VECTOR_GENERATION_BYTES) ||
    !Number.isSafeInteger(expectedRetirementId) ||
    Number(expectedRetirementId) <= 0
  ) {
    return yield* CodeGraphVectorRetirementError.make({message: 'Code graph vector retirement candidate is invalid.'});
  }
  const requestedLimit = input.requestedLimit ?? CODE_GRAPH_VECTOR_RETIREMENT_PAGE_ROWS;
  const limit = boundedRetirementLimit(requestedLimit);
  return yield* useExistingVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA foreign_keys = ON');
      yield* sql.unsafe('PRAGMA busy_timeout = 0');
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement schema is incompatible.',
        });
      }
      const marker = yield* selectVectorRetirementMarker(sql, input.generation);
      if (marker === undefined || marker.retirementId !== expectedRetirementId) {
        return {
          result: {remaining: false, rowsDeleted: 0, state: 'stale'} as const,
          state: 'stale',
        } satisfies CodeGraphVectorRetirementPagePlan;
      }
      if (marker.deleteAuthorized) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement authorization is invalid.',
        });
      }
      const pointers = yield* sql.unsafe(
        `SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
         WHERE generation = ? LIMIT 1`,
        [marker.generation],
      );
      const lifecycle = classifyCodeGraphLifecycle({
        authority: marker.deleteAuthorized ? 'unproven' : 'proven-disposable',
        protections: pointers.length === 0 ? [] : ['active-pin'],
        state: 'retired-generation',
      });
      if (lifecycle.disposition !== 'reclaim') {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement still has a live pointer.',
        });
      }
      const generationManifest = yield* inspectBoundedVectorGenerationManifest(sql, marker.generation);
      if (generationManifest.snapshotId !== marker.snapshotId) {
        return yield* CodeGraphVectorRetirementError.make({message: 'Code graph vector generation authority changed.'});
      }
      const page = yield* inspectBoundedVectorRetirementPage(sql, marker.generation, limit);
      return {
        boundary: {
          finalFactBytes:
            page.finalFactBytes + generationManifest.finalFactBytes + vectorRetirementPageAuthorityBytes(marker),
          operation: 'retire code graph vector generation',
          rowCount: page.rowCount + CODE_GRAPH_VECTOR_RETIREMENT_PAGE_FIXED_ROWS,
        },
        generation: marker.generation,
        generationManifest,
        ...(page.lastSymbolId === undefined ? {} : {lastSymbolId: page.lastSymbolId}),
        marker,
        requestedLimit: limit,
        selectedRowCount: page.rowCount,
        state: 'planned',
        storage: yield* inspectVectorPageStorageSql(sql),
      } satisfies CodeGraphVectorRetirementPagePlan;
    }),
  );
});

export const commitCodeGraphVectorRetirementPage = Effect.fn('codeGraph.commitVectorRetirementPage')(function* (
  databasePath: string,
  plan: Extract<CodeGraphVectorRetirementPagePlan, {readonly state: 'planned'}>,
) {
  return yield* useExistingVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA foreign_keys = ON');
      yield* sql.unsafe('PRAGMA busy_timeout = 0');
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          if (
            !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
            (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
          ) {
            return yield* CodeGraphVectorRetirementError.make({
              message: 'Code graph vector retirement schema is incompatible.',
            });
          }
          if (!sameVectorPageStorage(plan.storage, yield* inspectVectorPageStorageSql(sql))) {
            return yield* CodeGraphVectorRetirementError.make({message: 'Code graph vector page storage changed.'});
          }
          const marker = yield* selectVectorRetirementMarker(sql, plan.generation);
          if (
            marker === undefined ||
            marker.retirementId !== plan.marker.retirementId ||
            marker.pageRevision !== plan.marker.pageRevision ||
            marker.snapshotId !== plan.marker.snapshotId ||
            marker.retiredByWorktreeId !== plan.marker.retiredByWorktreeId
          ) {
            return {remaining: false, rowsDeleted: 0, state: 'stale'} as const;
          }
          if (marker.deleteAuthorized) {
            return yield* CodeGraphVectorRetirementError.make({
              message: 'Code graph vector retirement authorization is invalid.',
            });
          }
          const pointers = yield* sql.unsafe(
            `SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
             WHERE generation = ? LIMIT 1`,
            [marker.generation],
          );
          const lifecycle = classifyCodeGraphLifecycle({
            authority: marker.deleteAuthorized ? 'unproven' : 'proven-disposable',
            protections: pointers.length === 0 ? [] : ['active-pin'],
            state: 'retired-generation',
          });
          if (lifecycle.disposition !== 'reclaim') {
            return yield* CodeGraphVectorRetirementError.make({
              message: 'Code graph vector retirement still has a live pointer.',
            });
          }
          const generationManifest = yield* inspectBoundedVectorGenerationManifest(sql, marker.generation);
          if (!sameVectorGenerationManifest(plan.generationManifest, generationManifest)) {
            return yield* CodeGraphVectorRetirementError.make({
              message: 'Code graph vector generation manifest changed.',
            });
          }
          const page = yield* inspectBoundedVectorRetirementPage(sql, marker.generation, plan.requestedLimit);
          if (
            page.finalFactBytes + generationManifest.finalFactBytes + vectorRetirementPageAuthorityBytes(marker) !==
              plan.boundary.finalFactBytes ||
            page.rowCount !== plan.selectedRowCount ||
            page.lastSymbolId !== plan.lastSymbolId
          ) {
            return yield* CodeGraphVectorRetirementError.make({message: 'Code graph vector retirement page changed.'});
          }
          let rowsDeleted = 0;
          if (page.lastSymbolId !== undefined) {
            yield* sql.unsafe(
              `DELETE FROM vectors
               WHERE generation = ? AND symbol_id <= ?`,
              [marker.generation, page.lastSymbolId],
            );
            rowsDeleted = yield* lastStatementChangeCount(sql);
            if (rowsDeleted !== page.rowCount) {
              return yield* CodeGraphVectorRetirementError.make({
                message: 'Code graph vector retirement page changed.',
              });
            }
          }
          const remaining = yield* sql.unsafe(
            `SELECT 1 FROM vectors INDEXED BY sqlite_autoindex_vectors_1
             WHERE generation = ? LIMIT 1`,
            [marker.generation],
          );
          if (remaining.length !== 0) {
            yield* sql.unsafe(
              `UPDATE vector_generation_retirements
               SET page_revision = page_revision + 1
               WHERE generation = ? AND retirement_id = ?
                 AND page_revision = ? AND delete_authorized = 0`,
              [marker.generation, marker.retirementId, marker.pageRevision],
            );
            if ((yield* lastStatementChangeCount(sql)) !== 1) {
              return yield* CodeGraphVectorRetirementError.make({
                message: 'Code graph vector retirement marker changed.',
              });
            }
            return {
              marker: {...marker, pageRevision: marker.pageRevision + 1},
              remaining: true,
              rowsDeleted,
              state: 'progress',
            } as const;
          }
          yield* sql.unsafe(
            `UPDATE vector_generation_retirements
             SET delete_authorized = 1
             WHERE generation = ? AND retirement_id = ?
               AND page_revision = ? AND delete_authorized = 0`,
            [marker.generation, marker.retirementId, marker.pageRevision],
          );
          if ((yield* lastStatementChangeCount(sql)) !== 1) {
            return yield* CodeGraphVectorRetirementError.make({
              message: 'Code graph vector retirement authorization changed.',
            });
          }
          yield* sql.unsafe('DELETE FROM vector_generations WHERE generation = ?', [marker.generation]);
          if ((yield* lastStatementChangeCount(sql)) !== 1) {
            return yield* CodeGraphVectorRetirementError.make({
              message: 'Code graph vector retirement generation changed.',
            });
          }
          return {remaining: false, rowsDeleted, state: 'complete'} as const;
        }),
      );
    }),
  );
});

export const retireCodeGraphVectorGenerationPage = Effect.fn('codeGraph.retireVectorGenerationPage')(function* (
  databasePath: string,
  input: CodeGraphVectorRetirementPageInput,
  options: CodeGraphVectorRetirementExecutionOptions,
) {
  const plan = yield* planCodeGraphVectorRetirementPage(databasePath, input);
  if (plan.state === 'stale') return plan.result;
  return yield* options.capacityProtector(
    plan.boundary,
    commitCodeGraphVectorRetirementPage(databasePath, plan),
    plan.storage,
  );
});

interface CodeGraphVectorRetirementAdmissionObservation {
  readonly admissionScanRevision?: number;
  readonly candidate?: CodeGraphVectorGenerationManifest;
  readonly cleanGenerationRevision?: number;
  readonly cursor?: string;
  readonly generationRevision: number;
  readonly marker?: CodeGraphVectorRetirementMarker;
  readonly pointerPresent: boolean;
}

export type CodeGraphVectorRetirementAdmissionResult =
  | {readonly state: 'empty'}
  | {readonly generation: string; readonly marker?: CodeGraphVectorRetirementMarker; readonly state: 'admitted'}
  | {readonly generation: string; readonly state: 'advanced'}
  | {readonly state: 'restarted'}
  | {readonly state: 'wrapped'};

export type CodeGraphVectorRetirementAdmissionPlan =
  | {
      readonly result: Extract<CodeGraphVectorRetirementAdmissionResult, {readonly state: 'empty'}>;
      readonly state: 'empty';
    }
  | {
      readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
      readonly observation: CodeGraphVectorRetirementAdmissionObservation;
      readonly state: 'planned';
      readonly storage: CodeGraphVectorPageStorage;
    };

const observeVectorRetirementAdmission = Effect.fn('codeGraph.observeVectorRetirementAdmission')(function* (
  sql: SqlClient.SqlClient,
) {
  const states = yield* sql.unsafe<{
    readonly admission_cursor: unknown;
    readonly admission_scan_revision: unknown;
    readonly clean_generation_revision: unknown;
    readonly generation_revision: unknown;
  }>(
    `SELECT CASE
       WHEN admission_cursor IS NULL THEN NULL
       WHEN typeof(admission_cursor) = 'text'
        AND length(CAST(admission_cursor AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
        AND instr(admission_cursor, char(0)) = 0
       THEN admission_cursor ELSE 0
     END AS admission_cursor,
     CASE
       WHEN typeof(generation_revision) = 'integer'
        AND generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
       THEN generation_revision ELSE -1
     END AS generation_revision,
     CASE
       WHEN admission_scan_revision IS NULL THEN NULL
       WHEN typeof(admission_scan_revision) = 'integer'
        AND admission_scan_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
       THEN admission_scan_revision ELSE -1
     END AS admission_scan_revision,
     CASE
       WHEN clean_generation_revision IS NULL THEN NULL
       WHEN typeof(clean_generation_revision) = 'integer'
        AND clean_generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
       THEN clean_generation_revision ELSE -1
     END AS clean_generation_revision
     FROM vector_retirement_state WHERE singleton = 1 LIMIT 2`,
  );
  const rawCursor = states[0]?.admission_cursor;
  const rawGenerationRevision = states[0]?.generation_revision;
  const rawAdmissionScanRevision = states[0]?.admission_scan_revision;
  const rawCleanGenerationRevision = states[0]?.clean_generation_revision;
  if (
    states.length !== 1 ||
    (rawCursor !== null && (typeof rawCursor !== 'string' || !validBoundedText(rawCursor, VECTOR_GENERATION_BYTES))) ||
    !Number.isSafeInteger(rawGenerationRevision) ||
    Number(rawGenerationRevision) < 0 ||
    (rawAdmissionScanRevision !== null &&
      (!Number.isSafeInteger(rawAdmissionScanRevision) ||
        Number(rawAdmissionScanRevision) < 0 ||
        Number(rawAdmissionScanRevision) > Number(rawGenerationRevision))) ||
    (rawCleanGenerationRevision !== null &&
      (!Number.isSafeInteger(rawCleanGenerationRevision) ||
        Number(rawCleanGenerationRevision) < 0 ||
        Number(rawCleanGenerationRevision) > Number(rawGenerationRevision))) ||
    (rawCursor === null) !== (rawAdmissionScanRevision === null) ||
    (rawAdmissionScanRevision !== null &&
      rawCleanGenerationRevision !== null &&
      Number(rawCleanGenerationRevision) > Number(rawAdmissionScanRevision)) ||
    (rawCleanGenerationRevision !== null &&
      Number(rawCleanGenerationRevision) === Number(rawGenerationRevision) &&
      (rawCursor !== null || rawAdmissionScanRevision !== null))
  ) {
    return yield* CodeGraphVectorRetirementError.make({
      message: 'Code graph vector retirement admission state is invalid.',
    });
  }
  const cursor = typeof rawCursor === 'string' ? rawCursor : undefined;
  const generationRevision = Number(rawGenerationRevision);
  const admissionScanRevision = rawAdmissionScanRevision === null ? undefined : Number(rawAdmissionScanRevision);
  const cleanGenerationRevision = rawCleanGenerationRevision === null ? undefined : Number(rawCleanGenerationRevision);
  const revisionState = {
    ...(admissionScanRevision === undefined ? {} : {admissionScanRevision}),
    ...(cleanGenerationRevision === undefined ? {} : {cleanGenerationRevision}),
    cursor,
    generationRevision,
    pointerPresent: false,
  } satisfies CodeGraphVectorRetirementAdmissionObservation;
  if (
    (admissionScanRevision !== undefined && admissionScanRevision !== generationRevision) ||
    (cursor === undefined && cleanGenerationRevision === generationRevision)
  ) {
    return revisionState;
  }
  const rows = yield* sql.unsafe<{readonly generation: unknown}>(
    `SELECT CASE
       WHEN typeof(generation) = 'text'
        AND length(CAST(generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
        AND instr(generation, char(0)) = 0
       THEN generation ELSE NULL
     END AS generation
     FROM vector_generations
     WHERE generation > ?
     ORDER BY vector_generations.generation
     LIMIT 1`,
    [cursor ?? ''],
  );
  if (rows.length === 0) {
    return revisionState;
  }
  const generation = rows[0]?.generation;
  if (typeof generation !== 'string') {
    return yield* CodeGraphVectorRetirementError.make({
      message: 'Code graph vector retirement admission row is invalid.',
    });
  }
  const candidate = yield* inspectBoundedVectorGenerationManifest(sql, generation);
  const marker = yield* selectVectorRetirementMarker(sql, generation);
  const pointers = yield* sql.unsafe(
    `SELECT 1 FROM vector_pointers INDEXED BY vector_pointer_generation_lookup
     WHERE generation = ? LIMIT 1`,
    [generation],
  );
  if (marker !== undefined && pointers.length !== 0) {
    return yield* CodeGraphVectorRetirementError.make({
      message: 'Code graph vector retirement admission authority is invalid.',
    });
  }
  if (marker !== undefined && (marker.snapshotId !== candidate.snapshotId || marker.deleteAuthorized)) {
    return yield* CodeGraphVectorRetirementError.make({
      message: 'Code graph vector retirement admission marker is invalid.',
    });
  }
  return {
    ...(admissionScanRevision === undefined ? {} : {admissionScanRevision}),
    candidate,
    ...(cleanGenerationRevision === undefined ? {} : {cleanGenerationRevision}),
    cursor,
    generationRevision,
    ...(marker === undefined ? {} : {marker}),
    pointerPresent: pointers.length !== 0,
  } satisfies CodeGraphVectorRetirementAdmissionObservation;
});

function sameVectorRetirementAdmissionObservation(
  left: CodeGraphVectorRetirementAdmissionObservation,
  right: CodeGraphVectorRetirementAdmissionObservation,
): boolean {
  return (
    left.admissionScanRevision === right.admissionScanRevision &&
    left.cleanGenerationRevision === right.cleanGenerationRevision &&
    left.cursor === right.cursor &&
    left.generationRevision === right.generationRevision &&
    left.pointerPresent === right.pointerPresent &&
    ((left.candidate === undefined && right.candidate === undefined) ||
      (left.candidate !== undefined &&
        right.candidate !== undefined &&
        sameVectorGenerationManifest(left.candidate, right.candidate))) &&
    ((left.marker === undefined && right.marker === undefined) ||
      (left.marker !== undefined &&
        right.marker !== undefined &&
        sameVectorRetirementMarker(left.marker, right.marker)))
  );
}

function sameVectorRetirementMarker(
  left: CodeGraphVectorRetirementMarker,
  right: CodeGraphVectorRetirementMarker,
): boolean {
  return (
    left.deleteAuthorized === right.deleteAuthorized &&
    left.generation === right.generation &&
    left.pageRevision === right.pageRevision &&
    left.retiredByWorktreeId === right.retiredByWorktreeId &&
    left.retirementId === right.retirementId &&
    left.snapshotId === right.snapshotId
  );
}

const applyVectorRetirementAdmissionObservation = Effect.fn('codeGraph.applyVectorRetirementAdmissionObservation')(
  function* (sql: SqlClient.SqlClient, observed: CodeGraphVectorRetirementAdmissionObservation) {
    const exactStateParameters = [
      observed.cursor ?? null,
      observed.admissionScanRevision ?? null,
      observed.cleanGenerationRevision ?? null,
      observed.generationRevision,
    ] as const;
    if (
      observed.admissionScanRevision !== undefined &&
      observed.admissionScanRevision !== observed.generationRevision
    ) {
      yield* sql.unsafe(
        `UPDATE vector_retirement_state
         SET admission_cursor = NULL,
             admission_scan_revision = NULL,
             clean_generation_revision = NULL
         WHERE singleton = 1
           AND admission_cursor IS ?
           AND admission_scan_revision IS ?
           AND clean_generation_revision IS ?
           AND generation_revision = ?`,
        exactStateParameters,
      );
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement admission revision changed.',
        });
      }
      return {state: 'restarted'} as const;
    }
    if (observed.candidate === undefined) {
      if (observed.cursor === undefined && observed.cleanGenerationRevision === observed.generationRevision) {
        return {state: 'empty'} as const;
      }
      yield* sql.unsafe(
        `UPDATE vector_retirement_state
         SET admission_cursor = NULL,
             admission_scan_revision = NULL,
             clean_generation_revision = generation_revision
         WHERE singleton = 1
           AND admission_cursor IS ?
           AND admission_scan_revision IS ?
           AND clean_generation_revision IS ?
           AND generation_revision = ?`,
        exactStateParameters,
      );
      if ((yield* lastStatementChangeCount(sql)) !== 1) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement admission cursor changed.',
        });
      }
      return {state: 'wrapped'} as const;
    }
    let marker = observed.marker;
    if (!observed.pointerPresent && marker === undefined) {
      yield* sql.unsafe(
        `INSERT INTO vector_generation_retirements (
           generation, snapshot_id, retired_by_worktree_id
         ) VALUES (?, ?, NULL)`,
        [observed.candidate.generation, observed.candidate.snapshotId],
      );
      marker = yield* selectVectorRetirementMarker(sql, observed.candidate.generation);
      if (marker === undefined) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement marker was not published.',
        });
      }
    }
    yield* sql.unsafe(
      `UPDATE vector_retirement_state
       SET admission_cursor = ?,
           admission_scan_revision = CASE
             WHEN admission_scan_revision IS NULL THEN generation_revision
             ELSE admission_scan_revision
           END
       WHERE singleton = 1
         AND admission_cursor IS ?
         AND admission_scan_revision IS ?
         AND clean_generation_revision IS ?
         AND generation_revision = ?`,
      [observed.candidate.generation, ...exactStateParameters],
    );
    if ((yield* lastStatementChangeCount(sql)) !== 1) {
      return yield* CodeGraphVectorRetirementError.make({
        message: 'Code graph vector retirement admission cursor changed.',
      });
    }
    return marker === undefined
      ? ({generation: observed.candidate.generation, state: 'advanced'} as const)
      : ({generation: observed.candidate.generation, marker, state: 'admitted'} as const);
  },
);

export const planCodeGraphVectorRetirementAdmission = Effect.fn('codeGraph.planVectorRetirementAdmission')(function* (
  databasePath: string,
) {
  return yield* useExistingVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA foreign_keys = ON');
      yield* sql.unsafe('PRAGMA busy_timeout = 0');
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement schema is incompatible.',
        });
      }
      const observation: CodeGraphVectorRetirementAdmissionObservation = yield* observeVectorRetirementAdmission(sql);
      if (
        observation.candidate === undefined &&
        observation.cursor === undefined &&
        observation.cleanGenerationRevision === observation.generationRevision
      ) {
        return {result: {state: 'empty'}, state: 'empty'} as const satisfies CodeGraphVectorRetirementAdmissionPlan;
      }
      const insertsMarker =
        observation.candidate !== undefined && !observation.pointerPresent && observation.marker === undefined;
      const cursorBytes =
        observation.cursor === undefined ? 0 : new TextEncoder().encode(observation.cursor).byteLength;
      const candidateBytes = observation.candidate?.finalFactBytes ?? 0;
      const markerBytes = insertsMarker
        ? new TextEncoder().encode(observation.candidate.generation).byteLength +
          new TextEncoder().encode(observation.candidate.snapshotId).byteLength +
          256
        : 0;
      return {
        boundary: {
          finalFactBytes: cursorBytes + candidateBytes + markerBytes + 256,
          operation: 'admit code graph vector retirement',
          rowCount: insertsMarker ? 4 : 1,
        },
        observation,
        state: 'planned',
        storage: yield* inspectVectorPageStorageSql(sql),
      } satisfies CodeGraphVectorRetirementAdmissionPlan;
    }),
  );
});

export const commitCodeGraphVectorRetirementAdmission = Effect.fn('codeGraph.commitVectorRetirementAdmission')(
  function* (databasePath: string, plan: Extract<CodeGraphVectorRetirementAdmissionPlan, {readonly state: 'planned'}>) {
    return yield* useExistingVectorDatabase(
      databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe('PRAGMA foreign_keys = ON');
        yield* sql.unsafe('PRAGMA busy_timeout = 0');
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            if (
              !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
              (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready' ||
              !sameVectorPageStorage(plan.storage, yield* inspectVectorPageStorageSql(sql))
            ) {
              return yield* CodeGraphVectorRetirementError.make({
                message: 'Code graph vector retirement admission authority changed.',
              });
            }
            const observed: CodeGraphVectorRetirementAdmissionObservation =
              yield* observeVectorRetirementAdmission(sql);
            if (!sameVectorRetirementAdmissionObservation(plan.observation, observed)) {
              return yield* CodeGraphVectorRetirementError.make({
                message: 'Code graph vector retirement admission plan changed.',
              });
            }
            return yield* applyVectorRetirementAdmissionObservation(sql, observed);
          }),
        );
      }),
    );
  },
);

export const admitOneCodeGraphVectorRetirementWithCapacity = Effect.fn(
  'codeGraph.admitOneVectorRetirementWithCapacity',
)(function* (databasePath: string, options: CodeGraphVectorRetirementExecutionOptions) {
  const plan = yield* planCodeGraphVectorRetirementAdmission(databasePath);
  if (plan.state === 'empty') return plan.result;
  return yield* options.capacityProtector(
    plan.boundary,
    commitCodeGraphVectorRetirementAdmission(databasePath, plan),
    plan.storage,
  );
});

export interface CodeGraphVectorRetirementMarkerSelector {
  readonly afterGeneration?: string;
  readonly retiredByWorktreeId?: string;
  readonly snapshotId?: string;
}

/** @internal Singleton revision proof used only by the sealed ordinary-lane verifier. */
export function codeGraphVectorRetirementCleanRevisionProbeStatement() {
  return {
    parameters: [] as const,
    text: `SELECT CASE
       WHEN admission_cursor IS NULL
        AND admission_scan_revision IS NULL
        AND typeof(generation_revision) = 'integer'
        AND generation_revision BETWEEN 0 AND ${MAXIMUM_SAFE_INTEGER_SQL}
        AND typeof(clean_generation_revision) = 'integer'
        AND clean_generation_revision = generation_revision
       THEN 1 ELSE 0
     END AS clean
     FROM vector_retirement_state
       INDEXED BY sqlite_autoindex_vector_retirement_state_1
     WHERE singleton = 1
     LIMIT 2`,
  };
}

export type CodeGraphVectorRetirementWorkInspection =
  {readonly state: 'admission'} | {readonly generation: string; readonly state: 'marker'} | {readonly state: 'clean'};

export interface CodeGraphVectorSnapshotUsage {
  readonly activePointerCount: number;
  /** Canonical path-free digest of every matching generation manifest and active pointer. */
  readonly evidenceDigest: string;
  readonly generationCount: number;
}

const CODE_GRAPH_VECTOR_SNAPSHOT_USAGE_LIMIT = 1_024;

/**
 * Read-only bounded evidence for selected snapshot deletion. An inactive
 * generation is retained for ordinary paged vector retirement, while any
 * pointer still joined to the snapshot makes physical graph deletion unsafe.
 */
export const inspectCodeGraphVectorSnapshotUsage = Effect.fn('codeGraph.inspectVectorSnapshotUsage')(function* (
  databasePath: string,
  snapshotId: string,
) {
  if (!validBoundedText(snapshotId, VECTOR_SNAPSHOT_BYTES)) {
    return yield* CodeGraphVectorRetirementError.make({message: 'Code graph vector snapshot identity is invalid.'});
  }
  return yield* useReadOnlyVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('PRAGMA busy_timeout = 0');
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement schema is incompatible.',
        });
      }
      const boundedLimit = CODE_GRAPH_VECTOR_SNAPSHOT_USAGE_LIMIT + 1;
      const generationRows = yield* sql.unsafe<{
        readonly count: unknown;
        readonly created_at: unknown;
        readonly dimensions: unknown;
        readonly generation: unknown;
        readonly model_id: unknown;
        readonly model_sha256: unknown;
        readonly state: unknown;
        readonly template_version: unknown;
      }>(
        `SELECT generation, model_id, model_sha256, dimensions, template_version, count, state, created_at
         FROM vector_generations
         WHERE snapshot_id = ?
         ORDER BY generation
         LIMIT ?`,
        [snapshotId, boundedLimit],
      );
      const pointerRows = yield* sql.unsafe<{
        readonly generation: unknown;
        readonly worktree_id: unknown;
      }>(
        `SELECT pointer.generation, pointer.worktree_id
         FROM vector_pointers AS pointer
         JOIN vector_generations AS generation ON generation.generation = pointer.generation
         WHERE generation.snapshot_id = ?
         ORDER BY pointer.generation, pointer.worktree_id
         LIMIT ?`,
        [snapshotId, boundedLimit],
      );
      if (
        generationRows.length > CODE_GRAPH_VECTOR_SNAPSHOT_USAGE_LIMIT ||
        pointerRows.length > CODE_GRAPH_VECTOR_SNAPSHOT_USAGE_LIMIT
      ) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector snapshot evidence exceeded its bound.',
        });
      }
      const generations = generationRows.map(row => {
        if (
          typeof row.generation !== 'string' ||
          !validBoundedText(row.generation, VECTOR_GENERATION_BYTES) ||
          typeof row.model_id !== 'string' ||
          !validBoundedText(row.model_id, VECTOR_MODEL_ID_BYTES) ||
          typeof row.model_sha256 !== 'string' ||
          !/^[0-9a-f]{64}$/u.test(row.model_sha256) ||
          !Number.isSafeInteger(row.dimensions) ||
          Number(row.dimensions) <= 0 ||
          !Number.isSafeInteger(row.template_version) ||
          Number(row.template_version) < 0 ||
          !Number.isSafeInteger(row.count) ||
          Number(row.count) < 0 ||
          (row.state !== 'building' && row.state !== 'ready') ||
          typeof row.created_at !== 'string' ||
          !validBoundedText(row.created_at, VECTOR_CREATED_AT_BYTES)
        ) {
          return undefined;
        }
        return [
          row.generation,
          row.model_id,
          row.model_sha256,
          Number(row.dimensions),
          Number(row.template_version),
          Number(row.count),
          row.state,
          row.created_at,
        ] as const;
      });
      const pointers = pointerRows.map(row => {
        if (
          typeof row.generation !== 'string' ||
          !validBoundedText(row.generation, VECTOR_GENERATION_BYTES) ||
          typeof row.worktree_id !== 'string' ||
          !/^[0-9a-f]{64}$/u.test(row.worktree_id)
        ) {
          return undefined;
        }
        return [row.generation, row.worktree_id] as const;
      });
      if (generations.some(row => row === undefined) || pointers.some(row => row === undefined)) {
        return yield* CodeGraphVectorRetirementError.make({message: 'Code graph vector snapshot evidence is invalid.'});
      }
      return {
        activePointerCount: pointers.length,
        evidenceDigest: sha256HexSync(
          `code-graph-vector-snapshot-usage-v1\n${JSON.stringify({generations, pointers, snapshotId})}`,
        ),
        generationCount: generations.length,
      } satisfies CodeGraphVectorSnapshotUsage;
    }),
  );
});

/** @internal Bounded read-only clean predicate for a fully locked model. */
export const inspectCodeGraphVectorRetirementWork = Effect.fn('codeGraph.inspectVectorRetirementWork')(function* (
  databasePath: string,
) {
  return yield* useReadOnlyVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement schema is incompatible.',
        });
      }
      const revisionStatement = codeGraphVectorRetirementCleanRevisionProbeStatement();
      const revisionRows = yield* sql.unsafe<{readonly clean: unknown}>(
        revisionStatement.text,
        revisionStatement.parameters,
      );
      if (revisionRows.length !== 1 || (revisionRows[0]?.clean !== 0 && revisionRows[0]?.clean !== 1)) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement clean revision is invalid.',
        });
      }
      if (revisionRows[0].clean === 0) return {state: 'admission'} as const;

      const markerStatement = codeGraphVectorRetirementMarkerPageStatement({});
      const markerRows = yield* sql.unsafe<{readonly generation: unknown; readonly retirement_id: unknown}>(
        markerStatement.text,
        markerStatement.parameters,
      );
      if (markerRows.length === 0) return {state: 'clean'} as const;
      const generation = markerRows[0]?.generation;
      const retirementId = markerRows[0]?.retirement_id;
      if (typeof generation !== 'string' || !Number.isSafeInteger(retirementId) || Number(retirementId) <= 0) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement marker probe is invalid.',
        });
      }
      const marker = yield* selectVectorRetirementMarker(sql, generation);
      if (marker === undefined || marker.retirementId !== retirementId) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement marker authority changed.',
        });
      }
      return {generation, state: 'marker'} as const;
    }),
  );
});

/** @internal Exact indexed selector shared by the residual and ordinary vector lanes. */
export function codeGraphVectorRetirementMarkerPageStatement(input: CodeGraphVectorRetirementMarkerSelector) {
  const afterGeneration = input.afterGeneration ?? '';
  if (input.retiredByWorktreeId === undefined && input.snapshotId === undefined) {
    return {
      parameters: [afterGeneration] as const,
      text: `SELECT
         CASE WHEN typeof(generation) = 'text'
                AND length(CAST(generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
                AND instr(generation, char(0)) = 0
              THEN generation ELSE NULL END AS generation,
         CASE WHEN typeof(retirement_id) = 'integer'
                AND retirement_id BETWEEN 1 AND ${MAXIMUM_SAFE_INTEGER_SQL}
              THEN retirement_id ELSE NULL END AS retirement_id
       FROM vector_generation_retirements
         INDEXED BY sqlite_autoindex_vector_generation_retirements_1
       WHERE generation > ?
       ORDER BY vector_generation_retirements.generation
       LIMIT 1`,
    };
  }
  return {
    parameters: [input.retiredByWorktreeId, input.snapshotId, afterGeneration] as const,
    text: `SELECT
       CASE WHEN typeof(generation) = 'text'
              AND length(CAST(generation AS BLOB)) BETWEEN 1 AND ${VECTOR_GENERATION_BYTES}
              AND instr(generation, char(0)) = 0
            THEN generation ELSE NULL END AS generation,
       CASE WHEN typeof(retirement_id) = 'integer'
              AND retirement_id BETWEEN 1 AND ${MAXIMUM_SAFE_INTEGER_SQL}
            THEN retirement_id ELSE NULL END AS retirement_id
     FROM vector_generation_retirements
       INDEXED BY vector_generation_retirement_association
     WHERE retired_by_worktree_id = ?
       AND snapshot_id = ?
       AND generation > ?
     ORDER BY vector_generation_retirements.generation,
              vector_generation_retirements.retirement_id
     LIMIT 1`,
  };
}

export const selectCodeGraphVectorRetirementMarkerCandidate = Effect.fn(
  'codeGraph.selectVectorRetirementMarkerCandidate',
)(function* (databasePath: string, input: CodeGraphVectorRetirementMarkerSelector = {}) {
  if (
    (input.afterGeneration !== undefined && !validBoundedText(input.afterGeneration, VECTOR_GENERATION_BYTES)) ||
    (input.retiredByWorktreeId === undefined) !== (input.snapshotId === undefined) ||
    (input.retiredByWorktreeId !== undefined && !/^[0-9a-f]{64}$/.test(input.retiredByWorktreeId)) ||
    (input.snapshotId !== undefined && !validBoundedText(input.snapshotId, VECTOR_SNAPSHOT_BYTES))
  ) {
    return yield* CodeGraphVectorRetirementError.make({
      message: 'Code graph vector retirement marker selector is invalid.',
    });
  }
  return yield* useReadOnlyVectorDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement schema is incompatible.',
        });
      }
      const statement = codeGraphVectorRetirementMarkerPageStatement(input);
      const rows = yield* sql.unsafe<{readonly generation: unknown; readonly retirement_id: unknown}>(
        statement.text,
        statement.parameters,
      );
      if (rows.length === 0) return undefined;
      const generation = rows[0]?.generation;
      const retirementId = rows[0]?.retirement_id;
      if (typeof generation !== 'string' || !Number.isSafeInteger(retirementId) || Number(retirementId) <= 0) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement marker selector is invalid.',
        });
      }
      const marker = yield* selectVectorRetirementMarker(sql, generation);
      if (
        marker === undefined ||
        marker.retirementId !== retirementId ||
        (input.retiredByWorktreeId !== undefined &&
          (marker.retiredByWorktreeId !== input.retiredByWorktreeId || marker.snapshotId !== input.snapshotId))
      ) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement marker authority changed.',
        });
      }
      return marker;
    }),
  );
});

/** @internal Existing-transaction seam used only by deterministic schema-race tests. */
export const admitOneCodeGraphVectorRetirement = Effect.fn('codeGraph.admitVectorRetirement')(function* (
  sql: SqlClient.SqlClient,
) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (
        !(yield* codeGraphVectorCoreSchemaCurrent(sql)) ||
        (yield* codeGraphVectorRetirementSchemaState(sql)) !== 'ready'
      ) {
        return yield* CodeGraphVectorRetirementError.make({
          message: 'Code graph vector retirement schema is incompatible.',
        });
      }
      const observed = yield* observeVectorRetirementAdmission(sql);
      return yield* applyVectorRetirementAdmissionObservation(sql, observed);
    }),
  );
});
