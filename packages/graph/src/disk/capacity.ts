import {Schema} from 'effect';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CODE_GRAPH_SCHEMA_VERSION,
  type CodeGraphDiskCapacityFailureEvidence,
  CodeGraphDiskCapacityObservationError,
  CodeGraphDiskCapacityPressureError,
} from '../types.js';

export {CodeGraphDiskCapacityObservationError, CodeGraphDiskCapacityPressureError};

export const CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION = 2 as const;

const SQLITE_WAL_HEADER_BYTES = 32;
const SQLITE_WAL_FRAME_HEADER_BYTES = 24;

export type CodeGraphDirectPersistentCapacityOperation =
  | 'write code graph embedding demand'
  | 'write code graph vector generation'
  | 'admit code graph vector retirement'
  | 'apply persistent code graph materialization spool'
  | 'cache code graph file facts'
  | 'cache materialized code graph file shards'
  | 'prepare code graph vector retirement schema'
  | 'maintain code graph vector retirement'
  | 'publish persistent code graph snapshot'
  | 'publish persistent code graph materialization spool receipts'
  | 'promote ready code graph snapshot'
  | 'register persistent code graph materialization plan'
  | 'restore persistent code graph query indexes'
  | 'resolve persistent code graph reexport aliases'
  | 'resolve persistent code graph references'
  | 'retire code graph vector generation'
  | 'retire code graph vector pointer'
  | 'stage persistent code graph facts'
  | 'stage persistent code graph inventory'
  | 'stage persistent code graph workspace'
  | 'sort persistent code graph materialization spool'
  | 'prepare temporary incremental code graph activation'
  | 'publish temporary code graph snapshot'
  | 'resolve temporary code graph reexport aliases'
  | 'resolve temporary code graph references'
  | 'stage temporary code graph facts'
  | 'stage temporary code graph inventory'
  | 'stage temporary code graph workspace';

export const CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_OPERATIONS = [
  'write code graph embedding demand',
  'write code graph vector generation',
  'admit code graph vector retirement',
  'cache code graph file facts',
  'cache materialized code graph file shards',
  'prepare code graph vector retirement schema',
  'maintain code graph vector retirement',
  'publish persistent code graph snapshot',
  'promote ready code graph snapshot',
  'register persistent code graph materialization plan',
  'resolve persistent code graph reexport aliases',
  'resolve persistent code graph references',
  'retire code graph vector generation',
  'retire code graph vector pointer',
  'stage persistent code graph facts',
  'stage persistent code graph inventory',
  'stage persistent code graph workspace',
  'prepare temporary incremental code graph activation',
  'publish temporary code graph snapshot',
  'resolve temporary code graph reexport aliases',
  'resolve temporary code graph references',
  'stage temporary code graph facts',
  'stage temporary code graph inventory',
  'stage temporary code graph workspace',
] as const satisfies readonly CodeGraphDirectPersistentCapacityOperation[];

/** Internal reservation identities may be more precise than frozen anonymous telemetry labels. */
export const CODE_GRAPH_DISK_RESERVATION_OPERATIONS = [
  ...CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_OPERATIONS,
  'apply persistent code graph materialization spool',
  'publish persistent code graph materialization spool receipts',
  'restore persistent code graph query indexes',
  'sort persistent code graph materialization spool',
] as const satisfies readonly CodeGraphDirectPersistentCapacityOperation[];

export type CodeGraphCapacityFailureOperation =
  CodeGraphDirectPersistentCapacityOperation | 'observe code graph storage capacity' | 'protect code graph storage';

export function isCodeGraphCapacityFailureOperation(value: unknown): value is CodeGraphCapacityFailureOperation {
  return (
    value === 'observe code graph storage capacity' ||
    value === 'protect code graph storage' ||
    CODE_GRAPH_DISK_RESERVATION_OPERATIONS.some(operation => operation === value)
  );
}

export interface CodeGraphDirectPersistentCapacityBoundary {
  /** Exact UTF-8 bytes of the bounded logical payload when that evidence is available. */
  readonly finalFactBytes: number;
  /** Spool only: raw payload plus a bound for the additional ordered term dictionary. */
  readonly mainSortPayloadBytes?: number;
  readonly operation: CodeGraphDirectPersistentCapacityOperation;
  /** Main pager allocation target; omitted for the durable graph database. */
  readonly mainFilesystem?: 'durable' | 'temporary';
  /** Conservative maximum rows written by the bounded transaction. */
  readonly rowCount: number;
  /** SQLite TEMP writes consume the runtime temporary filesystem, not necessarily the durable graph filesystem. */
  readonly transientFilesystem?: 'durable' | 'temporary';
}

/**
 * The beta.30 production-shaped run is the retained seed for this envelope.
 * It is deliberately versioned with the store and extractor identities so a
 * future format cannot silently inherit stale byte amplification evidence.
 * Direct-persistent transactions write finalized normalized rows, not source
 * blobs; source/cache pressure belongs to the separately bounded cache phase.
 */
export const CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_CALIBRATION = {
  identityBase:
    `graph-v${CODE_GRAPH_SCHEMA_VERSION}:${CODE_GRAPH_EXTRACTOR_SET_VERSION}:direct-persistent:` +
    `capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}:extension-r${CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION}`,
  mainFactAmplification: 5,
  // The beta.30 production-shaped audit observed roughly 100 bytes of both
  // main-DB growth and WAL high-water per staged primary row. Round that
  // retained whole-run ratio up to 256 bytes so row-heavy batches cannot hide
  // behind unusually compact final-fact JSON.
  mainRowBytes: 256,
  transientFactAmplification: 3,
  transientRowBytes: 256,
} as const;

/**
 * Cache blobs have a separately versioned payload calibration. They write the
 * serialized JSON itself, so they must not silently inherit the normalized-row
 * evidence used by direct materialization transactions.
 */
export const CODE_GRAPH_CACHE_PERSISTENT_CAPACITY_CALIBRATION = {
  identityBase:
    `graph-v${CODE_GRAPH_SCHEMA_VERSION}:${CODE_GRAPH_EXTRACTOR_SET_VERSION}:cache-payload:` +
    `capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}:extension-r${CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION}`,
  mainFactAmplification: 5,
  mainRowBytes: 256,
  transientFactAmplification: 3,
  transientRowBytes: 256,
} as const;

/**
 * SQLite physical spool-sort fixtures measured ordered pages and sorter spill
 * above raw column bytes. The operation-specific 5/4 margin is applied below
 * to ordered payload (including a term-dictionary upper bound) and TEMP spill.
 * A separate quarter of ordered pages protects the DELETE-mode journal.
 */
export const CODE_GRAPH_SPOOL_SORT_CAPACITY_CALIBRATION = {
  identityBase:
    `graph-v${CODE_GRAPH_SCHEMA_VERSION}:${CODE_GRAPH_EXTRACTOR_SET_VERSION}:spool-sort:` +
    `capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}:extension-r${CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION}:physical-r1`,
  mainFactAmplification: 1,
  mainRowBytes: 256,
  physicalMarginDenominator: 4,
  physicalMarginNumerator: 5,
  recoveryFractionDenominator: 4,
  transientFactAmplification: 1,
  transientRowBytes: 256,
} as const;

/**
 * Vector-v2 retirement mutates a separate SQLite database with a different
 * row and index shape from the repository graph. Keep its conservative
 * envelope independently versioned so vector cleanup cannot silently inherit
 * a calibration for normalized lexical facts.
 */
/** Conservative metadata/payload envelope, independently identified from cleanup writes. */
export const CODE_GRAPH_EMBEDDING_DEMAND_CAPACITY_CALIBRATION = {
  identityBase: `graph-v3:embedding-demand-r1:capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}`,
  mainFactAmplification: 8,
  mainRowBytes: 1_024,
  transientFactAmplification: 8,
  transientRowBytes: 1_024,
} as const;

export const CODE_GRAPH_VECTOR_GENERATION_CAPACITY_CALIBRATION = {
  identityBase: `vector-v3:generation-r1:capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}`,
  mainFactAmplification: 8,
  mainRowBytes: 1_024,
  transientFactAmplification: 8,
  transientRowBytes: 1_024,
} as const;

export const CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_CAPACITY_CALIBRATION = {
  identityBase: `vector-v2:retirement-r1:index-publication:capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}`,
  mainFactAmplification: 6,
  mainRowBytes: 1_024,
  transientFactAmplification: 6,
  transientRowBytes: 1_024,
} as const;

export const CODE_GRAPH_VECTOR_RETIREMENT_PAGE_CAPACITY_CALIBRATION = {
  identityBase: `vector-v2:retirement-r1:vector-page:capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}`,
  mainFactAmplification: 8,
  mainRowBytes: 1_024,
  transientFactAmplification: 8,
  transientRowBytes: 1_024,
} as const;

export const CODE_GRAPH_VECTOR_RETIREMENT_ADMISSION_CAPACITY_CALIBRATION = {
  identityBase: `vector-v2:retirement-r1:admission:capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}`,
  mainFactAmplification: 8,
  mainRowBytes: 1_024,
  transientFactAmplification: 8,
  transientRowBytes: 1_024,
} as const;

/**
 * Conservative pre-telemetry envelope for an ordinary retirement unit. The
 * unit combines one exact schema/admission/page plan with two bounded atomic
 * cursor publications, so it must not inherit any single DB-only calibration.
 */
export const CODE_GRAPH_VECTOR_RETIREMENT_ORDINARY_UNIT_CAPACITY_CALIBRATION = {
  identityBase: `vector-v2:retirement-r1:ordinary-unit:capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}`,
  mainFactAmplification: 12,
  mainRowBytes: 2_048,
  transientFactAmplification: 12,
  transientRowBytes: 2_048,
} as const;

export const CODE_GRAPH_VECTOR_RETIREMENT_POINTER_CAPACITY_CALIBRATION = {
  identityBase: `vector-v2:retirement-r1:pointer-transition:capacity-v${CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION}`,
  mainFactAmplification: 8,
  mainRowBytes: 1_024,
  transientFactAmplification: 8,
  transientRowBytes: 1_024,
} as const;

export interface CodeGraphDirectPersistentCapacityDemandInput {
  readonly finalFactBytes: number;
  readonly lexicalFormatVersion: number;
  readonly mainFilesystem?: 'durable' | 'temporary';
  readonly observedMainHighWaterBytes?: number;
  readonly observedTransientHighWaterBytes?: number;
  readonly operation?: CodeGraphDirectPersistentCapacityOperation;
  readonly pageSize: number;
  readonly rowCount: number;
  readonly transientFilesystem?: 'durable' | 'temporary';
  readonly walAutoCheckpointPages: number;
}

export interface CodeGraphPersistentCapacityDemandInput extends Omit<
  CodeGraphDirectPersistentCapacityDemandInput,
  'finalFactBytes' | 'rowCount'
> {
  readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
}

export interface CodeGraphMeasuredDiskCapacityDemand {
  readonly calibrationIdentity: string;
  readonly mainFilesystem?: 'durable' | 'temporary';
  readonly mainHighWaterBytes: number;
  /** Defaults to the transient filesystem; spool rollback journals remain beside the durable sidecar. */
  readonly recoveryFilesystem?: 'durable' | 'temporary';
  readonly recoveryFloorBytes: number;
  readonly state: 'measured';
  readonly transientFilesystem: 'durable' | 'temporary';
  readonly transientHighWaterBytes: number;
}

export interface CodeGraphUnknownDiskCapacityDemand {
  readonly calibrationIdentity: string;
  readonly reason: 'calibration-input-unknown' | 'page-storage-unknown';
  readonly state: 'unknown';
}

export type CodeGraphDiskCapacityDemand = CodeGraphMeasuredDiskCapacityDemand | CodeGraphUnknownDiskCapacityDemand;

export interface CodeGraphDiskCapacityReservationProjectionInput {
  readonly demand: CodeGraphDiskCapacityDemand;
  readonly durableFilesystemKey: string;
  readonly freelistBytes: number;
  readonly temporaryFilesystemKey: string;
}

export type CodeGraphDiskCapacityReservationProjection =
  | {
      readonly calibrationIdentity: string;
      readonly filesystems: readonly {readonly bytes: number; readonly key: string}[];
      readonly state: 'measured';
    }
  | {
      readonly calibrationIdentity: string;
      readonly reason: CodeGraphUnknownDiskCapacityDemand['reason'] | 'filesystem-topology-unknown';
      readonly state: 'unknown';
    };

export interface CodeGraphDiskCapacityInput {
  readonly demand: CodeGraphDiskCapacityDemand;
  readonly durableAvailableBytes: number | undefined;
  readonly filesystemsShared: boolean | undefined;
  readonly freelistBytes: number;
  readonly reservedDurableBytes: number;
  readonly reservedTemporaryBytes: number;
  readonly temporaryAvailableBytes: number | undefined;
}

export interface CodeGraphDiskCapacityFilesystemDecision {
  readonly activeReservationBytes: number;
  readonly availableBytes: number;
  readonly requiredBytes: number;
  readonly role: 'durable' | 'shared' | 'temporary';
}

export interface CodeGraphDiskCapacitySelectedScope {
  readonly checkoutId: string;
  readonly scopeId?: string;
}

export type CodeGraphDiskCapacityDecision =
  | {
      readonly calibrationIdentity: string;
      readonly filesystems: readonly CodeGraphDiskCapacityFilesystemDecision[];
      readonly state: 'healthy';
    }
  | {
      readonly calibrationIdentity: string;
      readonly filesystems: readonly CodeGraphDiskCapacityFilesystemDecision[];
      readonly state: 'pressure';
    }
  | {
      readonly calibrationIdentity: string;
      readonly reason:
        | 'available-space-unknown'
        | 'calibration-input-unknown'
        | 'filesystem-topology-unknown'
        | 'page-storage-unknown'
        | 'reservation-input-unknown';
      readonly state: 'unknown';
    };

export function codeGraphDirectPersistentCapacityDemand(
  input: CodeGraphDirectPersistentCapacityDemandInput,
): CodeGraphDiskCapacityDemand {
  return codeGraphPersistentCapacityDemandForCalibration(input, CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_CALIBRATION);
}

export function codeGraphPersistentCapacityDemand(
  input: CodeGraphPersistentCapacityDemandInput,
): CodeGraphDiskCapacityDemand {
  const calibration =
    input.boundary.operation === 'cache code graph file facts' ||
    input.boundary.operation === 'cache materialized code graph file shards'
      ? CODE_GRAPH_CACHE_PERSISTENT_CAPACITY_CALIBRATION
      : input.boundary.operation === 'sort persistent code graph materialization spool'
        ? CODE_GRAPH_SPOOL_SORT_CAPACITY_CALIBRATION
        : CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_CALIBRATION;
  const demand = codeGraphPersistentCapacityDemandForCalibration(
    {
      ...input,
      finalFactBytes: input.boundary.finalFactBytes,
      mainFilesystem: input.boundary.mainFilesystem,
      rowCount: input.boundary.rowCount,
      transientFilesystem: input.boundary.transientFilesystem,
    },
    calibration,
  );
  if (input.boundary.operation !== 'sort persistent code graph materialization spool' || demand.state !== 'measured') {
    return demand;
  }
  const mainSortPayloadBytes = input.boundary.mainSortPayloadBytes ?? input.boundary.finalFactBytes;
  if (!nonNegativeSafeInteger(mainSortPayloadBytes)) {
    return {
      calibrationIdentity: `${CODE_GRAPH_SPOOL_SORT_CAPACITY_CALIBRATION.identityBase}:unmeasured`,
      reason: 'calibration-input-unknown',
      state: 'unknown',
    };
  }
  const spoolCalibration = CODE_GRAPH_SPOOL_SORT_CAPACITY_CALIBRATION;
  const mainHighWaterBytes = Math.max(
    demand.mainHighWaterBytes,
    saturatingCapacityRatioCeiling(
      Math.max(input.boundary.finalFactBytes, mainSortPayloadBytes),
      spoolCalibration.physicalMarginNumerator,
      spoolCalibration.physicalMarginDenominator,
    ),
  );
  return {
    ...demand,
    mainHighWaterBytes,
    recoveryFilesystem: 'durable',
    recoveryFloorBytes: Math.max(
      sqliteWalCapacityBytes(input.pageSize, input.walAutoCheckpointPages),
      saturatingCapacityRatioCeiling(mainHighWaterBytes, 1, spoolCalibration.recoveryFractionDenominator),
    ),
    transientHighWaterBytes: Math.max(
      demand.transientHighWaterBytes,
      saturatingCapacityRatioCeiling(
        input.boundary.finalFactBytes,
        spoolCalibration.physicalMarginNumerator,
        spoolCalibration.physicalMarginDenominator,
      ),
    ),
  };
}

export function codeGraphVectorRetirementCapacityDemand(
  input: CodeGraphDirectPersistentCapacityDemandInput,
): CodeGraphDiskCapacityDemand {
  const calibration =
    input.operation === 'write code graph embedding demand'
      ? CODE_GRAPH_EMBEDDING_DEMAND_CAPACITY_CALIBRATION
      : input.operation === 'write code graph vector generation'
        ? CODE_GRAPH_VECTOR_GENERATION_CAPACITY_CALIBRATION
        : input.operation === 'prepare code graph vector retirement schema'
          ? CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_CAPACITY_CALIBRATION
          : input.operation === 'retire code graph vector generation'
            ? CODE_GRAPH_VECTOR_RETIREMENT_PAGE_CAPACITY_CALIBRATION
            : input.operation === 'admit code graph vector retirement'
              ? CODE_GRAPH_VECTOR_RETIREMENT_ADMISSION_CAPACITY_CALIBRATION
              : input.operation === 'maintain code graph vector retirement'
                ? CODE_GRAPH_VECTOR_RETIREMENT_ORDINARY_UNIT_CAPACITY_CALIBRATION
                : input.operation === 'retire code graph vector pointer'
                  ? CODE_GRAPH_VECTOR_RETIREMENT_POINTER_CAPACITY_CALIBRATION
                  : undefined;
  return calibration === undefined
    ? {
        calibrationIdentity: 'vector-v2:retirement-r1:operation-unknown',
        reason: 'calibration-input-unknown',
        state: 'unknown',
      }
    : codeGraphPersistentCapacityDemandForCalibration(input, calibration);
}

function codeGraphPersistentCapacityDemandForCalibration(
  input: CodeGraphDirectPersistentCapacityDemandInput,
  calibration:
    | typeof CODE_GRAPH_DIRECT_PERSISTENT_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_CACHE_PERSISTENT_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_SPOOL_SORT_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_EMBEDDING_DEMAND_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_VECTOR_GENERATION_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_VECTOR_RETIREMENT_ADMISSION_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_VECTOR_RETIREMENT_ORDINARY_UNIT_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_VECTOR_RETIREMENT_POINTER_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_VECTOR_RETIREMENT_SCHEMA_CAPACITY_CALIBRATION
    | typeof CODE_GRAPH_VECTOR_RETIREMENT_PAGE_CAPACITY_CALIBRATION,
): CodeGraphDiskCapacityDemand {
  const unknown = (reason: CodeGraphUnknownDiskCapacityDemand['reason']): CodeGraphUnknownDiskCapacityDemand => ({
    calibrationIdentity: `${calibration.identityBase}:unmeasured`,
    reason,
    state: 'unknown',
  });
  if (!positiveSafeInteger(input.pageSize)) return unknown('page-storage-unknown');
  if (!positiveSafeInteger(input.lexicalFormatVersion)) return unknown('calibration-input-unknown');
  // Zero disables automatic checkpoints, so there is no measured pager floor
  // for this calibration version. Treat it as unknown instead of inventing a
  // WAL envelope.
  if (!positiveSafeInteger(input.walAutoCheckpointPages)) return unknown('calibration-input-unknown');
  if (
    !nonNegativeSafeInteger(input.finalFactBytes) ||
    !nonNegativeSafeInteger(input.observedMainHighWaterBytes ?? 0) ||
    !nonNegativeSafeInteger(input.observedTransientHighWaterBytes ?? 0) ||
    !nonNegativeSafeInteger(input.rowCount)
  ) {
    return unknown('calibration-input-unknown');
  }
  const finalFactBytes = input.finalFactBytes;
  const pageSize = input.pageSize;
  const rowCount = input.rowCount;
  const mainHighWaterBytes = Math.max(
    pageSize,
    saturatingCapacityMultiply(finalFactBytes, calibration.mainFactAmplification),
    saturatingCapacityMultiply(rowCount, calibration.mainRowBytes),
    input.observedMainHighWaterBytes ?? 0,
  );
  const transientHighWaterBytes = Math.max(
    pageSize,
    saturatingCapacityMultiply(finalFactBytes, calibration.transientFactAmplification),
    saturatingCapacityMultiply(rowCount, calibration.transientRowBytes),
    input.observedTransientHighWaterBytes ?? 0,
  );
  return {
    calibrationIdentity:
      `${calibration.identityBase}:` +
      `lexical-${input.lexicalFormatVersion}:page-${pageSize}:wal-${input.walAutoCheckpointPages}`,
    mainHighWaterBytes,
    ...(input.mainFilesystem === undefined ? {} : {mainFilesystem: input.mainFilesystem}),
    recoveryFloorBytes: Math.max(
      transientHighWaterBytes,
      sqliteWalCapacityBytes(pageSize, input.walAutoCheckpointPages),
    ),
    state: 'measured',
    transientFilesystem: input.transientFilesystem ?? 'durable',
    transientHighWaterBytes,
  };
}

/** Exact bytes occupied by a WAL header and the configured number of full page frames. */
export function sqliteWalCapacityBytes(pageSize: number, pageFrames: number): number {
  return saturatingCapacityAdd(
    SQLITE_WAL_HEADER_BYTES,
    saturatingCapacityMultiply(pageFrames, saturatingCapacityAdd(pageSize, SQLITE_WAL_FRAME_HEADER_BYTES)),
  );
}

/**
 * Projects one bounded transaction onto the exact filesystems that must carry
 * its durable and transient high-water allocations. The receipt ledger and
 * the independent admission oracle share this helper so shared filesystems
 * cannot be counted twice by one of those paths.
 */
export function codeGraphDiskCapacityReservationProjection(
  input: CodeGraphDiskCapacityReservationProjectionInput,
): CodeGraphDiskCapacityReservationProjection {
  const calibrationIdentity = input.demand.calibrationIdentity;
  if (input.demand.state === 'unknown') {
    return {calibrationIdentity, reason: input.demand.reason, state: 'unknown'};
  }
  if (
    !nonNegativeSafeInteger(input.demand.mainHighWaterBytes) ||
    !nonNegativeSafeInteger(input.demand.recoveryFloorBytes) ||
    !nonNegativeSafeInteger(input.demand.transientHighWaterBytes)
  ) {
    return {calibrationIdentity, reason: 'calibration-input-unknown', state: 'unknown'};
  }
  if (!validFilesystemKey(input.durableFilesystemKey) || !validFilesystemKey(input.temporaryFilesystemKey)) {
    return {calibrationIdentity, reason: 'filesystem-topology-unknown', state: 'unknown'};
  }

  const mainHighWaterBytes = capacityBytes(input.demand.mainHighWaterBytes);
  const mainOnDurable = input.demand.mainFilesystem !== 'temporary';
  const freelistBytes = mainOnDurable ? Math.min(mainHighWaterBytes, capacityBytes(input.freelistBytes)) : 0;
  const externalMainBytes = mainHighWaterBytes - freelistBytes;
  const transientHighWaterBytes = capacityBytes(input.demand.transientHighWaterBytes);
  const recoveryFloorBytes = capacityBytes(input.demand.recoveryFloorBytes);
  if (input.durableFilesystemKey === input.temporaryFilesystemKey) {
    return {
      calibrationIdentity,
      filesystems: [
        {
          bytes: saturatingCapacityAdd(externalMainBytes, transientHighWaterBytes, recoveryFloorBytes),
          key: input.durableFilesystemKey,
        },
      ],
      state: 'measured',
    };
  }

  const transientOnDurable = input.demand.transientFilesystem === 'durable';
  const recoveryOnDurable = (input.demand.recoveryFilesystem ?? input.demand.transientFilesystem) === 'durable';
  const filesystems = [
    {
      bytes: saturatingCapacityAdd(
        mainOnDurable ? externalMainBytes : 0,
        transientOnDurable ? transientHighWaterBytes : 0,
        recoveryOnDurable ? recoveryFloorBytes : 0,
      ),
      key: input.durableFilesystemKey,
    },
    ...(!mainOnDurable || !transientOnDurable || !recoveryOnDurable
      ? [
          {
            bytes: saturatingCapacityAdd(
              mainOnDurable ? 0 : externalMainBytes,
              transientOnDurable ? 0 : transientHighWaterBytes,
              recoveryOnDurable ? 0 : recoveryFloorBytes,
            ),
            key: input.temporaryFilesystemKey,
          },
        ]
      : []),
  ].filter(value => value.bytes > 0);
  return {calibrationIdentity, filesystems, state: 'measured'};
}

/** Pure capacity decision. Unknown topology or measurements always fail closed. */
export function evaluateCodeGraphDiskCapacity(input: CodeGraphDiskCapacityInput): CodeGraphDiskCapacityDecision {
  const calibrationIdentity = input.demand.calibrationIdentity;
  if (input.demand.state === 'unknown') {
    return {calibrationIdentity, reason: input.demand.reason, state: 'unknown'};
  }
  if (!nonNegativeSafeInteger(input.reservedDurableBytes) || !nonNegativeSafeInteger(input.reservedTemporaryBytes)) {
    return {calibrationIdentity, reason: 'reservation-input-unknown', state: 'unknown'};
  }
  if (input.filesystemsShared === undefined) {
    return {calibrationIdentity, reason: 'filesystem-topology-unknown', state: 'unknown'};
  }
  const durableAvailableBytes = availableCapacityBytes(input.durableAvailableBytes);
  const temporaryAvailableBytes = availableCapacityBytes(input.temporaryAvailableBytes);
  const reservedDurableBytes = capacityBytes(input.reservedDurableBytes);
  const reservedTemporaryBytes = capacityBytes(input.reservedTemporaryBytes);
  const durableKey = 'd'.repeat(64);
  const temporaryKey = input.filesystemsShared ? durableKey : 'e'.repeat(64);
  const projection = codeGraphDiskCapacityReservationProjection({
    demand: input.demand,
    durableFilesystemKey: durableKey,
    freelistBytes: input.freelistBytes,
    temporaryFilesystemKey: temporaryKey,
  });
  if (projection.state === 'unknown') {
    return {calibrationIdentity, reason: projection.reason, state: 'unknown'};
  }

  if (input.filesystemsShared) {
    const availableBytes = minimumDefined(durableAvailableBytes, temporaryAvailableBytes);
    if (availableBytes === undefined) {
      return {calibrationIdentity, reason: 'available-space-unknown', state: 'unknown'};
    }
    const filesystems = [
      {
        activeReservationBytes: saturatingCapacityAdd(reservedDurableBytes, reservedTemporaryBytes),
        availableBytes,
        requiredBytes: saturatingCapacityAdd(
          projection.filesystems[0]?.bytes ?? 0,
          reservedDurableBytes,
          reservedTemporaryBytes,
        ),
        role: 'shared',
      },
    ] as const;
    return {
      calibrationIdentity,
      filesystems,
      state: filesystems[0].availableBytes >= filesystems[0].requiredBytes ? 'healthy' : 'pressure',
    };
  }

  if (durableAvailableBytes === undefined) {
    return {calibrationIdentity, reason: 'available-space-unknown', state: 'unknown'};
  }
  const ownerBytes = new Map(projection.filesystems.map(value => [value.key, value.bytes]));
  const durableRequiredBytes = saturatingCapacityAdd(ownerBytes.get(durableKey) ?? 0, reservedDurableBytes);
  const temporaryRequiredBytes = saturatingCapacityAdd(ownerBytes.get(temporaryKey) ?? 0, reservedTemporaryBytes);
  if (temporaryRequiredBytes > 0 && temporaryAvailableBytes === undefined) {
    return {calibrationIdentity, reason: 'available-space-unknown', state: 'unknown'};
  }
  const filesystems: CodeGraphDiskCapacityFilesystemDecision[] = [
    {
      activeReservationBytes: reservedDurableBytes,
      availableBytes: durableAvailableBytes,
      requiredBytes: durableRequiredBytes,
      role: 'durable',
    },
  ];
  if (temporaryRequiredBytes > 0) {
    filesystems.push({
      activeReservationBytes: reservedTemporaryBytes,
      availableBytes: temporaryAvailableBytes!,
      requiredBytes: temporaryRequiredBytes,
      role: 'temporary',
    });
  }
  return {
    calibrationIdentity,
    filesystems,
    state: filesystems.every(value => value.availableBytes >= value.requiredBytes) ? 'healthy' : 'pressure',
  };
}

export function codeGraphDiskCapacityFailure(
  decision: CodeGraphDiskCapacityDecision,
  operation: string,
  scope?: CodeGraphDiskCapacitySelectedScope,
  pressureKind: 'physical' | 'reservation' = 'physical',
): CodeGraphDiskCapacityPressureError | CodeGraphDiskCapacityObservationError {
  const recovery = decision.state === 'pressure' && pressureKind === 'reservation' ? 'defer' : 'free-space';
  const evidence: CodeGraphDiskCapacityFailureEvidence = {
    activeReservations:
      decision.state === 'unknown'
        ? []
        : decision.filesystems
            .filter(filesystem => filesystem.activeReservationBytes > 0)
            .map(filesystem => ({bytes: filesystem.activeReservationBytes, role: filesystem.role})),
    calibrationIdentity: decision.calibrationIdentity,
    decisionLayer: 'bounded-write-reservation',
    estimateBasis: 'final-fact-bytes-and-row-count',
    filesystems:
      decision.state === 'unknown'
        ? []
        : decision.filesystems.map(({availableBytes, requiredBytes, role}) => ({
            availableBytes,
            requiredBytes,
            role,
          })),
    modelVersion: CODE_GRAPH_DISK_CAPACITY_MODEL_VERSION,
    ...(decision.state === 'unknown' ? {reason: decision.reason} : {}),
    recovery: decision.state === 'unknown' ? 'retry-read-only' : recovery,
    retryable: decision.state === 'unknown' || pressureKind === 'reservation',
    ...(scope === undefined ? {} : {scope}),
  };
  return decision.state === 'pressure'
    ? CodeGraphDiskCapacityPressureError.of(capacityOperation(operation), evidence)
    : CodeGraphDiskCapacityObservationError.of(evidence);
}

/** Only these typed failures preserve a deterministic persistent receipt prefix. */
export function isCodeGraphCapacityPause(cause: unknown): boolean {
  return (
    Schema.is(CodeGraphDiskCapacityPressureError)(cause) || Schema.is(CodeGraphDiskCapacityObservationError)(cause)
  );
}

export const isNonResumableCodeGraphBuildFailure = (cause: unknown): boolean =>
  !Schema.is(CodeGraphDiskCapacityObservationError)(cause) &&
  !(Schema.is(CodeGraphDiskCapacityPressureError)(cause) && cause.retryable);

export function saturatingCapacityAdd(...values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    const next = capacityBytes(value);
    if (next >= Number.MAX_SAFE_INTEGER - total) return Number.MAX_SAFE_INTEGER;
    total += next;
  }
  return total;
}

export function saturatingCapacityMultiply(value: number, multiplier: number): number {
  const left = capacityBytes(value);
  const right = capacityBytes(multiplier);
  if (left === 0 || right === 0) return 0;
  if (left > Number.MAX_SAFE_INTEGER / right) return Number.MAX_SAFE_INTEGER;
  return left * right;
}

function saturatingCapacityRatioCeiling(value: number, numerator: number, denominator: number): number {
  const scaled = (BigInt(value) * BigInt(numerator) + BigInt(denominator) - 1n) / BigInt(denominator);
  return Number(scaled > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : scaled);
}

/** Allocation-free UTF-8 byte count with TextEncoder-compatible lone-surrogate handling. */
export function codeGraphUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let encodedBytes: number;
    if (codeUnit <= 0x7f) encodedBytes = 1;
    else if (codeUnit <= 0x7ff) encodedBytes = 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        encodedBytes = 4;
        index += 1;
      } else {
        // WHATWG UTF-8 encoders replace an unpaired surrogate with U+FFFD.
        encodedBytes = 3;
      }
    } else {
      // BMP code points and unpaired low surrogates both occupy three bytes.
      encodedBytes = 3;
    }
    bytes = saturatingCapacityAdd(bytes, encodedBytes);
  }
  return bytes;
}

function capacityBytes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function availableCapacityBytes(value: number | undefined): number | undefined {
  return value === undefined || !Number.isSafeInteger(value) || value < 0 ? undefined : value;
}

function capacityOperation(operation: string): CodeGraphCapacityFailureOperation {
  switch (operation) {
    case 'admit code graph vector retirement':
    case 'apply persistent code graph materialization spool':
    case 'cache code graph file facts':
    case 'cache materialized code graph file shards':
    case 'maintain code graph vector retirement':
    case 'write code graph embedding demand':
    case 'write code graph vector generation':
    case 'prepare code graph vector retirement schema':
    case 'publish persistent code graph snapshot':
    case 'publish persistent code graph materialization spool receipts':
    case 'promote ready code graph snapshot':
    case 'register persistent code graph materialization plan':
    case 'restore persistent code graph query indexes':
    case 'resolve persistent code graph reexport aliases':
    case 'resolve persistent code graph references':
    case 'retire code graph vector generation':
    case 'retire code graph vector pointer':
    case 'stage persistent code graph facts':
    case 'stage persistent code graph inventory':
    case 'stage persistent code graph workspace':
    case 'sort persistent code graph materialization spool':
    case 'prepare temporary incremental code graph activation':
    case 'publish temporary code graph snapshot':
    case 'resolve temporary code graph reexport aliases':
    case 'resolve temporary code graph references':
    case 'stage temporary code graph facts':
    case 'stage temporary code graph inventory':
    case 'stage temporary code graph workspace':
      return operation;
    default:
      return 'protect code graph storage';
  }
}

function nonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validFilesystemKey(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function minimumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}
