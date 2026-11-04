import {SecureRandom} from 'effect/crypto';
import {Array as EffectArray} from 'effect';
import {Context, Effect, Exit, FileSystem, Option, Path, Schema} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {syncDirectoryBestEffort} from '@threadnote/platform/file/durability';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {runtimeTextDirectoryNamePage, SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {withCodeGraphIndexTiming, type CodeGraphIndexTimingObserver} from '../indexer/types.js';
import {
  CODE_GRAPH_DISK_RESERVATION_OPERATIONS,
  codeGraphDiskCapacityFailure,
  codeGraphDiskCapacityReservationProjection,
  codeGraphUtf8ByteLength,
  evaluateCodeGraphDiskCapacity,
  saturatingCapacityAdd,
  type CodeGraphDirectPersistentCapacityBoundary,
  type CodeGraphDirectPersistentCapacityOperation,
  type CodeGraphDiskCapacityDecision,
  type CodeGraphDiskCapacityDemand,
  type CodeGraphDiskCapacitySelectedScope,
} from './capacity.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import {isDefaultCandidateSqliteClient} from '../store/session.js';

export const CODE_GRAPH_DISK_RESERVATION_LIMITS = {
  classificationConcurrency: 16,
  classificationTimeoutMilliseconds: 5_000,
  entryLimit: 1_024,
  lockRetryMilliseconds: 25,
  lockStaleMilliseconds: 120_000,
  lockWaitMilliseconds: 30_000,
  observationTimeoutMilliseconds: 5_000,
  receiptBytes: 4_096,
  releaseAttempts: 3,
  releaseRetryMilliseconds: 25,
} as const;

/** Qualified default Windows VFS intersection, not a general GetTempPath resolver. */
export function codeGraphCandidateWindowsTemporaryDirectory(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly runtimeVersion: string;
  readonly path: Pick<Path.Path, 'isAbsolute' | 'normalize'>;
}): string | undefined {
  if (input.runtimeVersion !== '1.4.4') return undefined;
  const ordinary = (value: string | undefined) => {
    if (!value) return undefined;
    // Bound before normalization, splitting or character work. A terminator must also fit259 units.
    if (
      value.length > 259 ||
      !/^[A-Za-z]:\\/.test(value) ||
      /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(value)
    )
      return undefined;
    const canonical = value.length > 3 && EffectString.endsWith('\\')(value) ? EffectString.slice(0, -1)(value) : value;
    if (
      canonical.length + 1 > 259 ||
      !input.path.isAbsolute(canonical) ||
      input.path.normalize(canonical) !== canonical
    )
      return undefined;
    const rest = EffectString.slice(3)(canonical);
    if (/[<>:"/|?*]/.test(rest)) return undefined;
    for (const unit of rest) if (unit < ' ') return undefined;
    for (const component of rest ? EffectString.split('\\')(rest) : [])
      if (
        !component ||
        component === '.' ||
        component === '..' ||
        /[. ]$/.test(component) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(component)
      )
        return undefined;
    return canonical;
  };
  // Copy scalar values synchronously; never retain the mutable environment map as evidence.
  const tmp = input.environment.TMP,
    temp = input.environment.TEMP;
  const a = ordinary(tmp),
    b = ordinary(temp);
  if ((tmp && a === undefined) || (temp && b === undefined) || (a && b && a !== b)) return undefined;
  return a ?? b;
}

/** Follow SQLite's Unix VFS search order for sorter spill files only. */
export function codeGraphCapacityTemporaryDirectory(
  input: {
    readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly platform: string;
    readonly temporaryDirectory: string;
    readonly runtimeVersion?: string;
    readonly path?: Pick<Path.Path, 'isAbsolute' | 'normalize'>;
  },
  usable: (directory: string) => Effect.Effect<boolean, never>,
): Effect.Effect<string | undefined> {
  if (
    input.platform === 'win32' &&
    input.boundary.candidateWindow !== undefined &&
    input.boundary.transientFilesystem === 'temporary'
  ) {
    const directory =
      input.runtimeVersion !== undefined && input.path !== undefined
        ? codeGraphCandidateWindowsTemporaryDirectory({
            environment: input.environment,
            runtimeVersion: input.runtimeVersion,
            path: input.path,
          })
        : undefined;
    return directory ? usable(directory).pipe(Effect.map(ok => (ok ? directory : undefined))) : succeedUndefined;
  }
  if (
    (input.boundary.operation !== 'sort persistent code graph materialization spool' &&
      input.boundary.candidateWindow === undefined) ||
    input.boundary.transientFilesystem !== 'temporary' ||
    input.platform === 'win32'
  ) {
    return Effect.succeed(input.temporaryDirectory);
  }
  return Effect.gen(function* () {
    const candidates = [input.environment.SQLITE_TMPDIR, input.environment.TMPDIR, '/var/tmp', '/usr/tmp', '/tmp', '.'];
    for (const directory of candidates) {
      if (directory && (yield* usable(directory))) return directory;
    }
    return undefined;
  });
}

export function codeGraphSqliteTemporaryDirectoryUsable(fs: FileSystem.FileSystem, directory: string) {
  return Effect.gen(function* () {
    const info = yield* fs.stat(directory).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== 'Directory') return false;
    // Looking up "/." requires search permission on the directory itself.
    const searchable = yield* fs.stat(`${directory}/.`).pipe(Effect.option);
    const writable = yield* fs.access(directory, {writable: true}).pipe(Effect.option);
    return Option.isSome(searchable) && Option.isSome(writable);
  });
}

const RECEIPT_NAME = /^v1-([0-9a-f]{64})\.json$/;
const TEMPORARY_NAME = /^\.v1-([0-9a-f]{64})\.json\.([0-9a-f]{64})\.tmp$/;
const HASH = /^[0-9a-f]{64}$/;
const CALIBRATION_IDENTITY = /^[A-Za-z0-9:._-]+$/;
const LINUX_PROCESS_START_IDENTITY = /^linux:[0-9]+$/;
const WINDOWS_PROCESS_START_IDENTITY = /^win32:(?:0|[1-9][0-9]{0,19})$/;
const DARWIN_PROCESS_START_IDENTITY =
  /^darwin-v2:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?: {2}[1-9]| (?:[12][0-9]|3[01])) (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] [0-9]{4}$/;
const WAIT_BACKOFF_MILLISECONDS = [25, 50, 100, 250] as const;
const RUNTIME_PLATFORMS = new Set<NodeJS.Platform>([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
]);
const OPERATIONS = new Set<CodeGraphDirectPersistentCapacityOperation>(CODE_GRAPH_DISK_RESERVATION_OPERATIONS);
const CodeGraphDiskReservationReceiptSchema = Schema.Struct({
  calibrationIdentity: Schema.String,
  filesystems: Schema.Array(Schema.Struct({bytes: Schema.Finite, key: Schema.String})),
  operation: Schema.Literals(CODE_GRAPH_DISK_RESERVATION_OPERATIONS),
  processId: Schema.Finite,
  processStartIdentity: Schema.String,
  token: Schema.String,
  version: Schema.Literal(1),
});
const CodeGraphDiskCapacityDecisionFilesystemSchema = Schema.Struct({
  activeReservationBytes: Schema.Finite,
  availableBytes: Schema.Finite,
  requiredBytes: Schema.Finite,
  role: Schema.Literals(['durable', 'shared', 'temporary']),
});
const CodeGraphDiskCapacityDecisionSchema = Schema.Union([
  Schema.Struct({
    calibrationIdentity: Schema.String,
    filesystems: Schema.Array(CodeGraphDiskCapacityDecisionFilesystemSchema),
    state: Schema.Literals(['healthy', 'pressure']),
  }),
  Schema.Struct({
    calibrationIdentity: Schema.String,
    reason: Schema.Literals([
      'available-space-unknown',
      'calibration-input-unknown',
      'filesystem-topology-unknown',
      'page-storage-unknown',
    ]),
    state: Schema.Literal('unknown'),
  }),
]);
// Recovery authority is local-process state for one exact immutable receipt.
// Receipt paths include the ledger identity, so a copied token/canonical body
// in another Threadnote home can never consume that authority.
const activeReservationReceipts = new Map<string, string>();
const recoverableOwnedReceipts = new Map<string, string>();

export interface CodeGraphDiskReservationReceipt {
  readonly calibrationIdentity: string;
  readonly filesystems: readonly CodeGraphDiskReservationFilesystem[];
  readonly operation: CodeGraphDirectPersistentCapacityOperation;
  readonly processId: number;
  readonly processStartIdentity: string;
  readonly token: string;
  readonly version: 1;
}

export interface CodeGraphDiskReservationFilesystem {
  readonly bytes: number;
  readonly key: string;
}

export interface CodeGraphDiskReservationObservation {
  readonly demand: CodeGraphDiskCapacityDemand;
  readonly durableAvailableBytes: number | undefined;
  readonly durableFilesystemKey: string;
  readonly freelistBytes: number;
  readonly temporaryAvailableBytes: number | undefined;
  readonly temporaryFilesystemKey: string;
  /** Candidate-only actual Windows selection; in-process evidence, never serialized in receipt-v1. */
  readonly candidateTemporaryDirectory?: string;
}

export interface CodeGraphDiskReservationOptions<R = never> {
  /** @internal Optional closed-stage timing for persistent reference resolution only. */
  readonly onTiming?: CodeGraphIndexTimingObserver;
  /** @internal Deterministic release fault boundary for lifecycle tests. */
  readonly beforeReleaseAttempt?: Effect.Effect<void, unknown, R>;
  readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
  /** Exact stage authority selected BEFORE its actual claim; absent on scalar/bootstrap receipts. */
  readonly candidateWindow?: CodeGraphCandidateReservationBinding;
  /** A worker tick gets one zero-wait claim and never sleeps or runs maintenance. */
  readonly claimMode?: 'nonblocking-one-attempt' | 'wait';
  readonly ledgerLockPath: string;
  readonly ledgerRoot: string;
  readonly maintenance: Effect.Effect<void, unknown, R>;
  readonly observe: Effect.Effect<CodeGraphDiskReservationObservation, unknown, R>;
  readonly onDiagnostic?: (diagnostic: string) => Effect.Effect<void, never, R>;
  readonly onWaiting?: Effect.Effect<void, never, R>;
  readonly scope?: CodeGraphDiskCapacitySelectedScope;
}

export interface CodeGraphDiskReservationLease {
  readonly canonicalReceipt: string;
  readonly receiptPath: string;
  readonly token: string;
}

export interface CodeGraphCandidateReservationBinding {
  readonly sql?: SqlClient.SqlClient;
  readonly databasePath: string;
  readonly snapshotId: string;
  readonly authority: string;
  readonly sourceFingerprint: string;
  readonly planCanonical: string;
}
interface IssuedReservation {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly system: SystemInfoShape;
  readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
  readonly candidateWindow: CodeGraphCandidateReservationBinding | undefined;
  readonly candidateTemporaryDirectory: string | undefined;
  active: boolean;
  callbackFiber: number | undefined;
  minted: boolean;
}
// Object identity is additional to the existing exact path/body recovery bookkeeping.
const issuedReservations = new WeakMap<CodeGraphDiskReservationLease, IssuedReservation>();

class CodeGraphDiskReservationLedgerError extends Schema.TaggedError<
  CodeGraphDiskReservationLedgerError,
  {readonly brand: unique symbol}
>()('CodeGraphDiskReservationLedgerError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

class CodeGraphDiskReservationClaimControl extends Schema.TaggedError<
  CodeGraphDiskReservationClaimControl,
  {readonly brand: unique symbol}
>()('CodeGraphDiskReservationClaimControl', {
  decision: Schema.optionalKey(Schema.Any),
  message: Schema.String,
  state: Schema.Literals(['physical-pressure', 'reservation-pressure', 'unknown']),
}) {
  static of(
    state: 'physical-pressure' | 'reservation-pressure' | 'unknown',
    decision?: CodeGraphDiskCapacityDecision,
  ): CodeGraphDiskReservationClaimControl {
    return CodeGraphDiskReservationClaimControl.make({
      ...(decision === undefined ? {} : {decision}),
      message: state,
      state,
    });
  }
}

interface ScannedReceipt {
  readonly canonicalReceipt: string;
  readonly name: string;
  readonly receipt: CodeGraphDiskReservationReceipt;
}

export function codeGraphDiskReservationFilesystemKey(
  platform: NodeJS.Platform,
  device: bigint | number | undefined,
): string | undefined {
  const normalizedDevice =
    typeof device === 'bigint'
      ? device > 0n
        ? device.toString(10)
        : undefined
      : Number.isSafeInteger(device) && device! > 0
        ? String(device)
        : undefined;
  if (!normalizedDevice || !RUNTIME_PLATFORMS.has(platform)) return undefined;
  return sha256HexSync(`${platform}\0${normalizedDevice}`);
}

/** Deterministic, saturating receipt aggregation used by admission and property tests. */
export function aggregateCodeGraphDiskReservationReceipts(
  receipts: readonly CodeGraphDiskReservationReceipt[],
): readonly CodeGraphDiskReservationFilesystem[] {
  const reservedByFilesystem = new Map<string, number>();
  for (const receipt of receipts) {
    for (const filesystem of receipt.filesystems) {
      reservedByFilesystem.set(
        filesystem.key,
        saturatingCapacityAdd(reservedByFilesystem.get(filesystem.key) ?? 0, filesystem.bytes),
      );
    }
  }
  return EffectArray.map([...reservedByFilesystem], ([key, bytes]) => ({bytes, key})).sort((left, right) =>
    Effect2.pipe(left.key, EffectString.localeCompare(right.key)),
  );
}

/** Strict canonical serializer for the immutable receipt-v1 wire format. */
export function serializeCodeGraphDiskReservationReceipt(receipt: CodeGraphDiskReservationReceipt): string {
  if (!validReceipt(receipt))
    throw CodeGraphDiskReservationLedgerError.make({message: 'Disk reservation receipt is invalid.'});
  const canonical = JSON.stringify({
    version: 1,
    token: receipt.token,
    processId: receipt.processId,
    processStartIdentity: receipt.processStartIdentity,
    operation: receipt.operation,
    calibrationIdentity: receipt.calibrationIdentity,
    filesystems: EffectArray.map(receipt.filesystems, value => ({key: value.key, bytes: value.bytes})),
  });
  if (codeGraphUtf8ByteLength(canonical) > CODE_GRAPH_DISK_RESERVATION_LIMITS.receiptBytes) {
    throw CodeGraphDiskReservationLedgerError.make({message: 'Disk reservation receipt exceeds its byte budget.'});
  }
  return canonical;
}

/** Parses only canonical v1 content whose token exactly matches its strict filename. */
export function parseCodeGraphDiskReservationReceipt(
  fileName: string,
  content: string,
): CodeGraphDiskReservationReceipt | undefined {
  const token = RECEIPT_NAME.exec(fileName)?.[1];
  if (!token || codeGraphUtf8ByteLength(content) > CODE_GRAPH_DISK_RESERVATION_LIMITS.receiptBytes) return undefined;
  try {
    const parsed = Schema.decodeUnknownSync(CodeGraphDiskReservationReceiptSchema)(JSON.parse(content));
    if (parsed.token !== token || !validReceipt(parsed)) return undefined;
    return serializeCodeGraphDiskReservationReceipt(parsed) === content ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claims a cross-process receipt without holding either the ledger or checkout
 * writer lock during maintenance or capacity backoff.
 */
export const acquireCodeGraphDiskReservation = Effect.fn('codeGraph.diskReservation.acquire')(function* <R>(
  options: CodeGraphDiskReservationOptions<R>,
) {
  const system = yield* SystemInfo;
  const processStartIdentity = yield* canonicalProcessStartIdentity(system, system.processId);
  if (!validProcessStartIdentity(processStartIdentity)) {
    return yield* codeGraphDiskCapacityFailure(
      {
        calibrationIdentity: 'disk-reservation-owner-identity-unavailable',
        reason: 'reservation-input-unknown',
        state: 'unknown',
      },
      options.boundary.operation,
      options.scope,
    );
  }

  let maintenanceAttempted = false;
  let waitingReported = false;
  let backoffIndex = 0;
  while (true) {
    const attempt = yield* claimAttempt(options, processStartIdentity).pipe(
      Effect.orElseSucceed(() => ({decision: undefined, state: 'unknown' as const})),
    );
    if (attempt.state === 'claimed') return attempt.lease;
    if (attempt.state === 'unknown') {
      return yield* codeGraphDiskCapacityFailure(
        attempt.decision ?? {
          calibrationIdentity: 'disk-reservation-observation-unavailable',
          reason: 'reservation-input-unknown',
          state: 'unknown',
        },
        options.boundary.operation,
        options.scope,
      );
    }
    if (attempt.state === 'physical-pressure') {
      if (options.claimMode === 'nonblocking-one-attempt') {
        return yield* codeGraphDiskCapacityFailure(attempt.decision, options.boundary.operation, options.scope);
      }
      if (maintenanceAttempted) {
        return yield* codeGraphDiskCapacityFailure(attempt.decision, options.boundary.operation, options.scope);
      }
      maintenanceAttempted = true;
      yield* options.maintenance.pipe(
        Effect.mapError(() =>
          codeGraphDiskCapacityFailure(
            {
              calibrationIdentity: 'disk-reservation-maintenance-unavailable',
              reason: 'reservation-input-unknown',
              state: 'unknown',
            },
            options.boundary.operation,
            options.scope,
          ),
        ),
      );
      continue;
    }
    if (options.claimMode === 'nonblocking-one-attempt') {
      return yield* codeGraphDiskCapacityFailure(
        attempt.decision,
        options.boundary.operation,
        options.scope,
        'reservation',
      );
    }
    if (!waitingReported) {
      yield* options.onWaiting ?? Effect.void;
      waitingReported = true;
    }
    yield* Effect.sleep(WAIT_BACKOFF_MILLISECONDS[Math.min(backoffIndex, WAIT_BACKOFF_MILLISECONDS.length - 1)]);
    backoffIndex += 1;
  }
});

/** Exact-token release; missing is idempotent and replacements are retained. */
export const releaseCodeGraphDiskReservation = Effect.fn('codeGraph.diskReservation.release')(function* <R>(
  options: Pick<CodeGraphDiskReservationOptions<R>, 'beforeReleaseAttempt' | 'ledgerLockPath' | 'ledgerRoot'>,
  lease: CodeGraphDiskReservationLease,
) {
  const issued = issuedReservations.get(lease);
  if (issued) issued.active = false;
  yield* options.beforeReleaseAttempt ?? Effect.void;
  const fs = yield* FileSystem.FileSystem;
  const result = yield* withLedgerLock(
    fs,
    options.ledgerLockPath,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const expectedPath = path.join(options.ledgerRoot, `v1-${lease.token}.json`);
      if (lease.receiptPath !== expectedPath || !HASH.test(lease.token)) return 'retained' as const;
      if (!(yield* fs.exists(expectedPath))) return 'missing' as const;
      if (yield* isSymbolicLink(fs, expectedPath)) return 'retained' as const;
      const info = yield* fs.stat(expectedPath);
      if (info.type !== 'File' || Number(info.size) > CODE_GRAPH_DISK_RESERVATION_LIMITS.receiptBytes) {
        return 'retained' as const;
      }
      const content = yield* fs.readFileString(expectedPath);
      if (
        content !== lease.canonicalReceipt ||
        parseCodeGraphDiskReservationReceipt(`v1-${lease.token}.json`, content)?.token !== lease.token
      ) {
        return 'retained' as const;
      }
      yield* fs.remove(expectedPath);
      yield* syncDirectoryBestEffort(fs, options.ledgerRoot);
      return 'released' as const;
    }),
  );
  activeReservationReceipts.delete(lease.receiptPath);
  if (result === 'missing' || result === 'released') recoverableOwnedReceipts.delete(lease.receiptPath);
  return result;
});

/** The finalizer never changes the already-observed result of the protected transaction. */
export function withCodeGraphDiskReservation<A, E, R, R2>(
  options: CodeGraphDiskReservationOptions<R>,
  transaction: Effect.Effect<A, E, R2>,
) {
  return Effect.gen(function* () {
    if (EffectArray.some(yield* CurrentCandidateReservations, owned => owned.ledgerRoot === options.ledgerRoot))
      return yield* unknownReservationFailure(options, 'nested-candidate-disk-reservation');
    const onTiming =
      options.boundary.operation === 'resolve persistent code graph references' ? options.onTiming : undefined;
    const system = yield* SystemInfo;
    const processStartIdentity = yield* withCodeGraphIndexTiming(
      onTiming,
      'reference-reservation-owner-identity',
      canonicalProcessStartIdentity(system, system.processId),
    );
    if (!validProcessStartIdentity(processStartIdentity)) {
      return yield* unknownReservationFailure(options, 'disk-reservation-owner-identity-unavailable');
    }

    let maintenanceAttempted = false;
    let waitingReported = false;
    let backoffIndex = 0;
    while (true) {
      // Each bracket acquisition performs one bounded, serialized claim. The
      // potentially unbounded contention backoff remains outside the bracket's
      // uninterruptible acquire mask. If cancellation arrives after receipt
      // publication, acquireUseRelease has already installed the finalizer.
      const attempted = yield* Effect.acquireUseRelease(
        withCodeGraphIndexTiming(
          onTiming,
          'reference-reservation-claim',
          claimAttempt(options, processStartIdentity).pipe(
            Effect.orElseSucceed(() => ({decision: undefined, state: 'unknown' as const})),
            Effect.flatMap(attempt =>
              attempt.state === 'claimed'
                ? Effect.succeed(attempt.lease)
                : Effect.fail(CodeGraphDiskReservationClaimControl.of(attempt.state, attempt.decision)),
            ),
          ),
        ),
        lease =>
          withCodeGraphIndexTiming(
            onTiming,
            'reference-reservation-use',
            observeScalarReservationScope(options.ledgerRoot, lease, transaction),
          ),
        lease =>
          withCodeGraphIndexTiming(onTiming, 'reference-reservation-release', reservationFinalizer(options, lease)),
      ).pipe(
        Effect.map(value => ({state: 'completed' as const, value})),
        Effect.catchIf(Schema.is(CodeGraphDiskReservationClaimControl), error =>
          Effect.succeed({
            decision:
              error.decision === undefined
                ? undefined
                : Option.getOrUndefined(
                    Schema.decodeUnknownOption(CodeGraphDiskCapacityDecisionSchema)(error.decision),
                  ),
            state: error.state,
          }),
        ),
      );
      if (attempted.state === 'completed') return attempted.value;
      if (attempted.state === 'unknown') {
        if (attempted.decision !== undefined) {
          return yield* codeGraphDiskCapacityFailure(attempted.decision, options.boundary.operation, options.scope);
        }
        return yield* unknownReservationFailure(options, 'disk-reservation-observation-unavailable');
      }
      if (attempted.state === 'physical-pressure') {
        if (options.claimMode === 'nonblocking-one-attempt') {
          return yield* codeGraphDiskCapacityFailure(
            attempted.decision ?? pressureDecision('disk-reservation-physical-pressure'),
            options.boundary.operation,
            options.scope,
          );
        }
        if (maintenanceAttempted) {
          return yield* codeGraphDiskCapacityFailure(
            attempted.decision ?? pressureDecision('disk-reservation-physical-pressure'),
            options.boundary.operation,
            options.scope,
          );
        }
        maintenanceAttempted = true;
        yield* options.maintenance.pipe(
          Effect.mapError(() => unknownReservationFailure(options, 'disk-reservation-maintenance-unavailable')),
        );
        continue;
      }
      if (options.claimMode === 'nonblocking-one-attempt') {
        return yield* codeGraphDiskCapacityFailure(
          attempted.decision ?? pressureDecision('disk-reservation-contention'),
          options.boundary.operation,
          options.scope,
          'reservation',
        );
      }
      if (!waitingReported) {
        yield* options.onWaiting ?? Effect.void;
        waitingReported = true;
      }
      yield* Effect.sleep(WAIT_BACKOFF_MILLISECONDS[Math.min(backoffIndex, WAIT_BACKOFF_MILLISECONDS.length - 1)]);
      backoffIndex += 1;
    }
  });
}

function reservationFinalizer<R>(options: CodeGraphDiskReservationOptions<R>, lease: CodeGraphDiskReservationLease) {
  return releaseCodeGraphDiskReservationWithRetry(options, lease).pipe(
    Effect.flatMap(result =>
      Effect.sync(() => {
        if (result === 'failed' && activeReservationReceipts.get(lease.receiptPath) === lease.canonicalReceipt) {
          recoverableOwnedReceipts.set(lease.receiptPath, lease.canonicalReceipt);
          activeReservationReceipts.delete(lease.receiptPath);
        }
      }).pipe(
        Effect.andThen(
          result === 'retained'
            ? (options.onDiagnostic?.('Code graph disk reservation release retained a changed receipt.') ?? Effect.void)
            : result === 'failed'
              ? (options.onDiagnostic?.('Code graph disk reservation release could not be completed.') ?? Effect.void)
              : Effect.void,
        ),
      ),
    ),
  );
}

function unknownReservationFailure(
  options: Pick<CodeGraphDiskReservationOptions<unknown>, 'boundary' | 'scope'>,
  calibrationIdentity: string,
) {
  return codeGraphDiskCapacityFailure(
    {calibrationIdentity, reason: 'reservation-input-unknown', state: 'unknown'},
    options.boundary.operation,
    options.scope,
  );
}

function pressureDecision(calibrationIdentity: string): CodeGraphDiskCapacityDecision {
  return {calibrationIdentity, filesystems: [], state: 'pressure'};
}

function releaseCodeGraphDiskReservationWithRetry<R>(
  options: CodeGraphDiskReservationOptions<R>,
  lease: CodeGraphDiskReservationLease,
) {
  return Effect.gen(function* () {
    for (let attempt = 1; attempt <= CODE_GRAPH_DISK_RESERVATION_LIMITS.releaseAttempts; attempt += 1) {
      const released = yield* Effect.exit(releaseCodeGraphDiskReservation(options, lease));
      if (Exit.isSuccess(released)) return released.value;
      if (attempt < CODE_GRAPH_DISK_RESERVATION_LIMITS.releaseAttempts) {
        yield* Effect.sleep(CODE_GRAPH_DISK_RESERVATION_LIMITS.releaseRetryMilliseconds * attempt);
      }
    }
    return 'failed' as const;
  });
}

const claimAttempt = Effect.fn('codeGraph.diskReservation.claimAttempt')(function* <R>(
  options: CodeGraphDiskReservationOptions<R>,
  processStartIdentity: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* withLedgerLock(
    fs,
    options.ledgerLockPath,
    Effect.gen(function* () {
      const crypto = yield* SecureRandom.SecureRandom;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      yield* ensureLedgerRoot(fs, options.ledgerRoot, system.platform);
      const snapshot = yield* scanLedger(fs, options.ledgerRoot, system);
      // The production observation is native statfs plus a read-only SQLite
      // connection with a 50 ms busy timeout. Keep a total outer bound as a
      // defense against unsupported-host fallbacks and injected adapters.
      const observation = yield* options.observe.pipe(
        Effect.timeoutOrElse({
          duration: CODE_GRAPH_DISK_RESERVATION_LIMITS.observationTimeoutMilliseconds,
          orElse: () =>
            Effect.fail(CodeGraphDiskReservationLedgerError.make({message: 'Disk reservation observation timed out.'})),
        }),
      );
      const filesystemsShared = observation.durableFilesystemKey === observation.temporaryFilesystemKey;
      const zero = evaluateCodeGraphDiskCapacity({
        demand: observation.demand,
        durableAvailableBytes: observation.durableAvailableBytes,
        filesystemsShared,
        freelistBytes: observation.freelistBytes,
        reservedDurableBytes: 0,
        reservedTemporaryBytes: 0,
        temporaryAvailableBytes: observation.temporaryAvailableBytes,
      });
      if (zero.state === 'unknown') return {decision: zero, state: 'unknown'} as const;
      if (zero.state === 'pressure') return {decision: zero, state: 'physical-pressure'} as const;

      const reservedDurableBytes = snapshot.reservedByFilesystem.get(observation.durableFilesystemKey) ?? 0;
      const reservedTemporaryBytes = filesystemsShared
        ? 0
        : (snapshot.reservedByFilesystem.get(observation.temporaryFilesystemKey) ?? 0);
      const reserved = evaluateCodeGraphDiskCapacity({
        demand: observation.demand,
        durableAvailableBytes: observation.durableAvailableBytes,
        filesystemsShared,
        freelistBytes: observation.freelistBytes,
        reservedDurableBytes,
        reservedTemporaryBytes,
        temporaryAvailableBytes: observation.temporaryAvailableBytes,
      });
      if (reserved.state === 'unknown') return {decision: reserved, state: 'unknown'} as const;
      if (reserved.state === 'pressure') return {decision: reserved, state: 'reservation-pressure'} as const;

      const projection = codeGraphDiskCapacityReservationProjection({
        demand: observation.demand,
        durableFilesystemKey: observation.durableFilesystemKey,
        freelistBytes: observation.freelistBytes,
        temporaryFilesystemKey: observation.temporaryFilesystemKey,
      });
      if (projection.state === 'unknown' || projection.filesystems.length < 1 || projection.filesystems.length > 2) {
        return {state: 'unknown'} as const;
      }
      const token = sha256HexSync(`${system.processId}\0${yield* crypto.uuidV4()}`);
      const receipt: CodeGraphDiskReservationReceipt = {
        calibrationIdentity: projection.calibrationIdentity,
        filesystems: [...projection.filesystems].sort((left, right) =>
          Effect2.pipe(left.key, EffectString.localeCompare(right.key)),
        ),
        operation: options.boundary.operation,
        processId: system.processId,
        processStartIdentity,
        token,
        version: 1,
      };
      const canonicalReceipt = serializeCodeGraphDiskReservationReceipt(receipt);
      const name = `v1-${token}.json`;
      const receiptPath = path.join(options.ledgerRoot, name);
      if (yield* fs.exists(receiptPath)) {
        return yield* CodeGraphDiskReservationLedgerError.make({message: 'Disk reservation token collided.'});
      }
      const temporaryToken = sha256HexSync(`${token}\0${yield* crypto.uuidV4()}`);
      const temporaryPath = path.join(options.ledgerRoot, `.${name}.${temporaryToken}.tmp`);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(temporaryPath, {flag: 'wx', mode: 0o600});
          yield* file.writeAll(new TextEncoder().encode(canonicalReceipt));
          yield* file.sync;
        }),
      ).pipe(
        Effect.andThen(system.platform === 'win32' ? Effect.void : fs.chmod(temporaryPath, 0o600)),
        Effect.andThen(fs.rename(temporaryPath, receiptPath)),
        Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)),
      );
      yield* syncDirectoryBestEffort(fs, options.ledgerRoot);
      activeReservationReceipts.set(receiptPath, canonicalReceipt);
      const lease = Object.freeze({canonicalReceipt, receiptPath, token});
      issuedReservations.set(lease, {
        fs,
        path,
        system,
        boundary: {
          ...options.boundary,
          ...(options.boundary.candidateWindow ? {candidateWindow: {...options.boundary.candidateWindow}} : {}),
        },
        candidateWindow: options.candidateWindow ? {...options.candidateWindow} : undefined,
        candidateTemporaryDirectory: observation.candidateTemporaryDirectory,
        active: true,
        callbackFiber: undefined,
        minted: false,
      });
      return {lease, state: 'claimed'} as const;
    }),
    options.claimMode === 'nonblocking-one-attempt' ? 0 : CODE_GRAPH_DISK_RESERVATION_LIMITS.lockWaitMilliseconds,
  );
});

function withLedgerLock<A, E, R>(
  fs: FileSystem.FileSystem,
  lockPath: string,
  effect: Effect.Effect<A, E, R>,
  waitTimeoutMilliseconds: number = CODE_GRAPH_DISK_RESERVATION_LIMITS.lockWaitMilliseconds,
) {
  return withExclusiveFileLock(
    fs,
    lockPath,
    {
      heartbeatIntervalMilliseconds: 40_000,
      recoverReusedProcessIdImmediately: true,
      retryIntervalMilliseconds: CODE_GRAPH_DISK_RESERVATION_LIMITS.lockRetryMilliseconds,
      staleAfterMilliseconds: CODE_GRAPH_DISK_RESERVATION_LIMITS.lockStaleMilliseconds,
      useCanonicalProcessStartIdentity: true,
      waitTimeoutMilliseconds,
    },
    effect,
  );
}

const ensureLedgerRoot = Effect.fn('codeGraph.diskReservation.ensureRoot')(function* (
  fs: FileSystem.FileSystem,
  root: string,
  platform: NodeJS.Platform,
) {
  if (yield* fs.exists(root)) {
    if (yield* isSymbolicLink(fs, root)) {
      return yield* CodeGraphDiskReservationLedgerError.make({message: 'Disk reservation root is symbolic.'});
    }
    const info = yield* fs.stat(root);
    if (info.type !== 'Directory') {
      return yield* CodeGraphDiskReservationLedgerError.make({message: 'Disk reservation root is not a directory.'});
    }
  } else {
    yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
  }
  if (platform !== 'win32') yield* fs.chmod(root, 0o700);
});

const scanLedger = Effect.fn('codeGraph.diskReservation.scan')(function* (
  fs: FileSystem.FileSystem,
  root: string,
  system: SystemInfoShape,
) {
  const names = yield* boundedDirectoryEntries(root);
  const receipts: ScannedReceipt[] = [];
  const temporaryNames: string[] = [];
  for (const name of names.sort()) {
    const receiptToken = RECEIPT_NAME.exec(name)?.[1];
    const temporary = TEMPORARY_NAME.test(name);
    if (!receiptToken && !temporary) {
      return yield* CodeGraphDiskReservationLedgerError.make({
        message: 'Disk reservation ledger has an unknown entry.',
      });
    }
    const path = yield* Path.Path;
    const target = path.join(root, name);
    if (yield* isSymbolicLink(fs, target)) {
      return yield* CodeGraphDiskReservationLedgerError.make({message: 'Disk reservation ledger entry is symbolic.'});
    }
    const info = yield* fs.stat(target);
    if (
      info.type !== 'File' ||
      !Number.isSafeInteger(Number(info.size)) ||
      Number(info.size) < 0 ||
      Number(info.size) > CODE_GRAPH_DISK_RESERVATION_LIMITS.receiptBytes ||
      (system.platform !== 'win32' && (info.mode & 0o777) !== 0o600)
    ) {
      return yield* CodeGraphDiskReservationLedgerError.make({message: 'Disk reservation ledger entry is invalid.'});
    }
    if (temporary) {
      temporaryNames.push(name);
      continue;
    }
    const content = yield* fs.readFileString(target);
    const receipt = parseCodeGraphDiskReservationReceipt(name, content);
    if (!receipt || receipt.token !== receiptToken) {
      return yield* CodeGraphDiskReservationLedgerError.make({message: 'Disk reservation receipt is malformed.'});
    }
    receipts.push({canonicalReceipt: content, name, receipt});
  }

  const processIds = [...new Set(EffectArray.map(receipts, value => value.receipt.processId))].sort(
    (left, right) => left - right,
  );
  const classifications = yield* Effect.forEach(
    processIds,
    processId =>
      classifyOwner(system, processId).pipe(Effect.map(classification => [processId, classification] as const)),
    {concurrency: CODE_GRAPH_DISK_RESERVATION_LIMITS.classificationConcurrency},
  ).pipe(
    Effect.timeoutOrElse({
      duration: CODE_GRAPH_DISK_RESERVATION_LIMITS.classificationTimeoutMilliseconds,
      orElse: () =>
        Effect.fail(CodeGraphDiskReservationLedgerError.make({message: 'Disk reservation owner scan timed out.'})),
    }),
    Effect.map(entries => new Map(entries)),
  );

  const path = yield* Path.Path;
  const retained: CodeGraphDiskReservationReceipt[] = [];
  const staleNames: string[] = [];
  const recoverableReceiptPathsToForget: string[] = [];
  for (const scanned of receipts) {
    const receiptPath = path.join(root, scanned.name);
    const classification = classifications.get(scanned.receipt.processId) ?? {state: 'unknown' as const};
    const exactRecoverableOwnedReceipt =
      scanned.receipt.processId === system.processId &&
      classification.state === 'running' &&
      classification.processStartIdentity === scanned.receipt.processStartIdentity &&
      recoverableOwnedReceipts.get(receiptPath) === scanned.canonicalReceipt;
    if (
      classification.state === 'dead' ||
      (classification.state === 'running' &&
        classification.processStartIdentity !== scanned.receipt.processStartIdentity) ||
      exactRecoverableOwnedReceipt
    ) {
      staleNames.push(scanned.name);
      if (exactRecoverableOwnedReceipt) recoverableReceiptPathsToForget.push(receiptPath);
    } else {
      // Unknown ownership is retained and charged conservatively.
      retained.push(scanned.receipt);
    }
  }
  for (const name of [...temporaryNames, ...staleNames]) {
    yield* fs.remove(path.join(root, name));
  }
  for (const receiptPath of recoverableReceiptPathsToForget) recoverableOwnedReceipts.delete(receiptPath);
  if (temporaryNames.length + staleNames.length > 0) yield* syncDirectoryBestEffort(fs, root);

  const reservedByFilesystem = new Map(
    EffectArray.map(aggregateCodeGraphDiskReservationReceipts(retained), value => [value.key, value.bytes]),
  );
  return {reservedByFilesystem};
});

function classifyOwner(system: SystemInfoShape, processId: number) {
  return Effect.gen(function* () {
    const running = yield* Effect.try(() => system.isProcessRunning(processId)).pipe(Effect.option);
    if (running._tag === 'None') return {state: 'unknown'} as const;
    if (!running.value) return {state: 'dead'} as const;
    const processStartIdentity = yield* canonicalProcessStartIdentity(system, processId);
    return validProcessStartIdentity(processStartIdentity)
      ? ({processStartIdentity, state: 'running'} as const)
      : ({state: 'unknown'} as const);
  });
}

function canonicalProcessStartIdentity(system: SystemInfoShape, processId: number) {
  return system.canonicalProcessStartIdentity?.(processId) ?? succeedUndefined;
}

function boundedDirectoryEntries(root: string): Effect.Effect<string[], unknown> {
  return runtimeTextDirectoryNamePage(root, CODE_GRAPH_DISK_RESERVATION_LIMITS.entryLimit).pipe(
    Effect.flatMap(page =>
      page.overflow
        ? Effect.fail(
            CodeGraphDiskReservationLedgerError.make({message: 'Disk reservation ledger entry bound was exceeded.'}),
          )
        : Effect.succeed([...page.names]),
    ),
  );
}

function isSymbolicLink(fs: FileSystem.FileSystem, target: string): Effect.Effect<boolean> {
  return fs.readLink(target).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
}

function validReceipt(receipt: CodeGraphDiskReservationReceipt): boolean {
  if (
    receipt.version !== 1 ||
    !HASH.test(receipt.token) ||
    !Number.isSafeInteger(receipt.processId) ||
    receipt.processId <= 0 ||
    !validProcessStartIdentity(receipt.processStartIdentity) ||
    !OPERATIONS.has(receipt.operation) ||
    !CALIBRATION_IDENTITY.test(receipt.calibrationIdentity) ||
    codeGraphUtf8ByteLength(receipt.calibrationIdentity) < 1 ||
    codeGraphUtf8ByteLength(receipt.calibrationIdentity) > 256 ||
    !EffectArray.isArray(receipt.filesystems) ||
    receipt.filesystems.length < 1 ||
    receipt.filesystems.length > 2
  ) {
    return false;
  }
  let previous = '';
  for (const filesystem of receipt.filesystems) {
    if (
      !HASH.test(filesystem.key) ||
      filesystem.key <= previous ||
      !Number.isSafeInteger(filesystem.bytes) ||
      filesystem.bytes < 0
    ) {
      return false;
    }
    previous = filesystem.key;
  }
  return true;
}

function validProcessStartIdentity(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    codeGraphUtf8ByteLength(value) <= 256 &&
    (LINUX_PROCESS_START_IDENTITY.test(value) ||
      WINDOWS_PROCESS_START_IDENTITY.test(value) ||
      DARWIN_PROCESS_START_IDENTITY.test(value))
  );
}

const CurrentCandidateReservations = Context.Reference<
  readonly {readonly ledgerRoot: string; readonly lease: CodeGraphDiskReservationLease}[]
>('graph/CandidateReservations', {defaultValue: () => []});

/** Exactly one claim while the stage slot is held. Acquisition pressure is distinct from protected-use failure. */
export function tryWithCodeGraphDiskReservationLease<A, E, R, R2>(
  options: CodeGraphDiskReservationOptions<R>,
  use: (lease: CodeGraphDiskReservationLease) => Effect.Effect<A, E, R2>,
) {
  return Effect.gen(function* () {
    if (
      EffectArray.some(yield* CurrentCandidateReservations, owned => owned.ledgerRoot === options.ledgerRoot) ||
      EffectArray.some(yield* CurrentScalarReservations, owned => owned.ledgerRoot === options.ledgerRoot)
    )
      return yield* unknownReservationFailure(options, 'nested-candidate-disk-reservation');
    const system = yield* SystemInfo;
    const identity = yield* canonicalProcessStartIdentity(system, system.processId);
    if (!validProcessStartIdentity(identity))
      return yield* unknownReservationFailure(options, 'disk-reservation-owner-identity-unavailable');
    // Return the whole attempt from acquire; finalizer registration precedes invoking any successful use callback.
    return yield* Effect.acquireUseRelease(
      claimAttempt({...options, claimMode: 'nonblocking-one-attempt'}, identity),
      attempt =>
        Effect.gen(function* () {
          if (attempt.state === 'claimed') {
            const issued = issuedReservations.get(attempt.lease);
            if (!issued || !issued.active)
              return yield* unknownReservationFailure(options, 'candidate-lease-unavailable');
            const ancestors = yield* CurrentCandidateReservations;
            const fiber = yield* Effect.fiberId;
            const value = yield* Effect.acquireUseRelease(
              Effect.sync(() => {
                issued.callbackFiber = fiber;
              }),
              () =>
                Effect.scoped(use(attempt.lease)).pipe(
                  Effect.provideService(CurrentCandidateReservations, [
                    ...ancestors,
                    {ledgerRoot: options.ledgerRoot, lease: attempt.lease},
                  ]),
                ),
              () =>
                Effect.sync(() => {
                  issued.callbackFiber = undefined;
                }),
            );
            return {state: 'completed' as const, value};
          }
          if (attempt.state === 'unknown')
            return yield* unknownReservationFailure(options, 'disk-reservation-observation-unavailable');
          return {state: attempt.state, decision: attempt.decision};
        }),
      attempt => (attempt.state === 'claimed' ? reservationFinalizer(options, attempt.lease) : Effect.void),
    );
  });
}

/** Current exact owned receipt, bounded before hydration; no ledger lock or second claim. */
export const assertCodeGraphDiskReservationLease = Effect.fn('codeGraph.assertReservationLease')(function* (
  lease: CodeGraphDiskReservationLease,
) {
  const fs = yield* FileSystem.FileSystem;
  if (
    activeReservationReceipts.get(lease.receiptPath) !== lease.canonicalReceipt ||
    (yield* isSymbolicLink(fs, lease.receiptPath))
  )
    return yield* CodeGraphDiskReservationLedgerError.make({message: 'Candidate reservation is no longer owned.'});
  const valid = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(lease.receiptPath, {flag: 'r'});
      const info = yield* file.stat;
      if (info.type !== 'File' || info.size > 4096n) return false;
      const buffer = new Uint8Array(4097);
      let offset = 0;
      while (offset < buffer.length) {
        const n = Number(yield* file.read(buffer.subarray(offset)));
        if (!Number.isSafeInteger(n) || n < 0 || n > buffer.length - offset) return false;
        if (n === 0) break;
        offset += n;
      }
      if (offset > 4096 || BigInt(offset) !== info.size) return false;
      const body = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(buffer.subarray(0, offset));
      return (
        body === lease.canonicalReceipt &&
        parseCodeGraphDiskReservationReceipt(`v1-${lease.token}.json`, body)?.token === lease.token &&
        activeReservationReceipts.get(lease.receiptPath) === body
      );
    }),
  );
  if (!valid)
    return yield* CodeGraphDiskReservationLedgerError.make({message: 'Candidate reservation receipt changed.'});
});

/** In-process mint authority; a copied receipt object cannot become an active registered lease. */
export function codeGraphDiskReservationLeaseOwned(lease: CodeGraphDiskReservationLease): boolean {
  return (
    issuedReservations.get(lease)?.active === true &&
    activeReservationReceipts.get(lease.receiptPath) === lease.canonicalReceipt &&
    parseCodeGraphDiskReservationReceipt(`v1-${lease.token}.json`, lease.canonicalReceipt)?.token === lease.token
  );
}

/** Single mint from the ORIGINAL issued candidate callback, never from a scalar/clone/copied plan. */
export const mintCodeGraphCandidateReservation = Effect.fn('codeGraph.mintCandidateReservation')(function* (
  lease: CodeGraphDiskReservationLease,
  expected: CodeGraphCandidateReservationBinding,
  boundary: {readonly children: number; readonly rows: number; readonly bytes: number},
) {
  // Source-owned, no filesystem/SQL/receipt work. Relevant async continuations call this
  // same check; a changed TEMP selection never rebases the already issued reservation.
  const refresh = Effect.gen(function* () {
    const issued = issuedReservations.get(lease);
    const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
    const path = yield* Effect.serviceOption(Path.Path);
    const system = yield* Effect.serviceOption(SystemInfo);
    if (
      !issued ||
      !codeGraphDiskReservationLeaseOwned(lease) ||
      issued.callbackFiber !== (yield* Effect.fiberId) ||
      Option.isNone(fs) ||
      fs.value !== issued.fs ||
      Option.isNone(path) ||
      path.value !== issued.path ||
      Option.isNone(system) ||
      system.value !== issued.system ||
      !EffectArray.some(yield* CurrentCandidateReservations, owned => owned.lease === lease) ||
      issued.candidateWindow?.sql !== expected.sql ||
      JSON.stringify(issued.candidateWindow) !== JSON.stringify(expected) ||
      issued.boundary.operation !== 'stage persistent code graph facts' ||
      issued.boundary.rowCount !== boundary.rows ||
      issued.boundary.finalFactBytes !== boundary.bytes ||
      JSON.stringify(issued.boundary.candidateWindow) !== JSON.stringify(boundary)
    )
      return yield* CodeGraphDiskReservationLedgerError.make({
        message: 'Candidate lease is foreign, scalar, stale or outside its exact issued callback.',
      });
    if (
      issued.system.platform === 'win32' &&
      (!isDefaultCandidateSqliteClient(expected.sql, expected.databasePath) ||
        issued.candidateTemporaryDirectory === undefined ||
        codeGraphCandidateWindowsTemporaryDirectory({
          environment: issued.system.environment(),
          runtimeVersion: issued.system.runtimeVersion,
          path: issued.path,
        }) !== issued.candidateTemporaryDirectory)
    )
      return yield* CodeGraphDiskReservationLedgerError.make({
        message: 'Candidate SQLite TEMP origin or selection changed.',
      });
  });
  const validate = Effect.gen(function* () {
    yield* refresh;
    const issued = issuedReservations.get(lease)!;
    yield* assertCodeGraphDiskReservationLease(lease).pipe(Effect.provideService(FileSystem.FileSystem, issued.fs));
    yield* refresh;
  });
  yield* validate;
  const issued = issuedReservations.get(lease)!;
  if (issued.minted)
    return yield* CodeGraphDiskReservationLedgerError.make({
      message: 'Candidate lease has already minted its single window.',
    });
  issued.minted = true;
  return {validate, refresh};
});

const CurrentScalarReservations = Context.Reference<
  readonly {readonly ledgerRoot: string; readonly lease: CodeGraphDiskReservationLease}[]
>('graph/ActualScalarReservations', {defaultValue: () => []});
function observeScalarReservationScope<A, E, R>(
  ledgerRoot: string,
  lease: CodeGraphDiskReservationLease,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const outer = yield* CurrentScalarReservations;
    return yield* effect.pipe(Effect.provideService(CurrentScalarReservations, [...outer, {ledgerRoot, lease}]));
  });
}
