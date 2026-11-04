import {SecureRandom} from 'effect/crypto';
import {Effect, FileSystem, Option, Path} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {succeedUndefined} from '@threadnote/platform/optional';
import {codeGraphCandidateStageOwnership} from '../builder/admission.js';
import {CodeGraphStoreError, type RepositoryIdentity, type CodeGraphProgress} from '../types.js';
import {withCandidateCapacityWitness, consumeCandidateCapacity} from '../store/resolution/candidate_capacity.js';
import {
  codeGraphDiskCapacityFailure,
  codeGraphPersistentCapacityDemand,
  type CodeGraphDirectPersistentCapacityBoundary,
} from '../disk/capacity.js';
import {
  codeGraphCapacityTemporaryDirectory,
  codeGraphDiskReservationFilesystemKey,
  codeGraphSqliteTemporaryDirectoryUsable,
  type CodeGraphDiskReservationOptions,
  withCodeGraphDiskReservation,
  tryWithCodeGraphDiskReservationLease,
} from '../disk/reservation.js';
import {codeGraphDiskReservationLockPath, codeGraphDiskReservationRoot, type CodeGraphLayout} from '../layout.js';
import {inspectCodeGraphStorage} from '../storage.js';
import type {CodeGraphDirectPersistentCapacityProtector} from '../store/models.js';
import {CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION} from '../store/build/core.js';
import type {DirectPersistentCapacityProtection} from './types.js';
import {isDefaultCandidateSqliteClient} from '../store/session.js';
import {codeGraphCandidateWindowsTemporaryDirectory} from '../disk/reservation.js';

export interface DirectPersistentCapacityContext {
  readonly capacityProtection?: DirectPersistentCapacityProtection;
  readonly claimMode?: CodeGraphDiskReservationOptions['claimMode'];
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly layout: CodeGraphLayout;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly threadnoteHome: string;
}

export function codeGraphDirectPersistentCapacityProtector(
  input: DirectPersistentCapacityContext,
): CodeGraphDirectPersistentCapacityProtector {
  const protection = input.capacityProtection;
  if (!protection)
    return (boundary, _transaction) =>
      Effect.fail(
        codeGraphDiskCapacityFailure(
          {
            calibrationIdentity: 'direct-persistent-capacity-unavailable',
            reason: 'calibration-input-unknown',
            state: 'unknown',
          },
          boundary.operation,
        ),
      );
  const options = (
    boundary: CodeGraphDirectPersistentCapacityBoundary,
    candidateWindow?: import('../disk/reservation.js').CodeGraphCandidateReservationBinding,
  ): CodeGraphDiskReservationOptions<SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path | SystemInfo> => ({
    boundary,
    ...(boundary.operation === 'resolve persistent code graph references' && protection.onTiming
      ? {onTiming: protection.onTiming}
      : {}),
    claimMode: input.claimMode,
    ledgerLockPath: codeGraphDiskReservationLockPath(protection.path, input.threadnoteHome),
    ledgerRoot: codeGraphDiskReservationRoot(protection.path, input.threadnoteHome),
    maintenance: protection.maintenance
      .tick({
        allowIndexPreparation: true,
        anchorIdentity: input.identity,
        ...(input.layout.scopeId === undefined ? {} : {anchorScopeId: input.layout.scopeId}),
        automaticTail: false,
        checkoutId: input.layout.checkoutId,
        databasePath: input.layout.databasePath,
        joinActive: false,
        pressure: 'critical',
        threadnoteHome: input.threadnoteHome,
        writerLockPath: input.layout.databaseWriteLockPath,
      })
      .pipe(
        Effect.catchIf(
          error => ['busy', 'no-space'].includes(error.code),
          () => Effect.void,
        ),
      ),
    observe: observeDirectPersistentCapacity({
      boundary,
      fs: input.fs,
      identity: input.identity,
      layout: input.layout,
      protection: protection,
      threadnoteHome: input.threadnoteHome,
      candidateWindow,
    }),
    onDiagnostic: diagnostic => Effect.logWarning(diagnostic),
    onWaiting: (input.onProgress?.({phase: 'waiting', reason: 'disk-capacity'}) ?? Effect.void).pipe(Effect.ignore),
    scope: {
      checkoutId: input.layout.checkoutId,
      ...(input.layout.scopeId === undefined ? {} : {scopeId: input.layout.scopeId}),
    },
  });
  const provide = <A, E, R>(
    effect: Effect.Effect<A, E, R | SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path | SystemInfo>,
  ) =>
    effect.pipe(
      Effect.provideService(SecureRandom.SecureRandom, protection.crypto),
      Effect.provideService(FileSystem.FileSystem, input.fs),
      Effect.provideService(Path.Path, protection.path),
      Effect.provideService(SystemInfo, protection.system),
    );
  const protect: CodeGraphDirectPersistentCapacityProtector = (boundary, transaction) =>
    provide(withCodeGraphDiskReservation(options(boundary), transaction));
  const runCandidate = <A, E, R>(
    boundary: CodeGraphDirectPersistentCapacityBoundary,
    gate: import('../store/models.js').CodeGraphPreparationGate | undefined,
    useLease: (lease: import('../disk/reservation.js').CodeGraphDiskReservationLease) => Effect.Effect<A, E, R>,
    candidateWindow?: import('../disk/reservation.js').CodeGraphCandidateReservationBinding,
  ) =>
    Effect.gen(function* () {
      if (!gate?.candidateStage || !gate.coveredPreparation)
        return yield* CodeGraphStoreError.of('Candidate window requires owned stage/preparation capabilities.');
      const request = {...options(boundary, candidateWindow), ...(candidateWindow ? {candidateWindow} : {})};
      let maintained = false,
        waiting = false,
        backoff = 0;

      for (;;) {
        const scoped = yield* gate.candidateStage(
          provide(
            Effect.gen(function* () {
              const ownership = yield* codeGraphCandidateStageOwnership({
                threadnoteHome: input.threadnoteHome,
                identity: {checkoutId: input.identity.checkoutId, worktreeId: input.identity.worktreeId},
              });
              const attempted = yield* tryWithCodeGraphDiskReservationLease(request, useLease);
              return {ownership, attempted};
            }),
          ),
        );
        const attempted = scoped.attempted;
        if (attempted.state === 'completed') return attempted.value;
        // We are outside stage-slot, preparation, writer and receipt ownership here.
        if (
          scoped.ownership === 'borrowed' ||
          input.claimMode === 'nonblocking-one-attempt' ||
          (attempted.state === 'physical-pressure' && maintained)
        )
          return yield* codeGraphDiskCapacityFailure(
            attempted.decision ?? {
              state: 'pressure',
              calibrationIdentity: 'candidate-window-pressure',
              filesystems: [],
            },
            boundary.operation,
            request.scope,
            attempted.state === 'reservation-pressure' ? 'reservation' : 'physical',
          );
        if (attempted.state === 'physical-pressure') {
          maintained = true;
          yield* request.maintenance;
        } else {
          if (!waiting) {
            yield* request.onWaiting ?? Effect.void;
            waiting = true;
          }
          yield* Effect.sleep([25, 50, 100, 250][Math.min(backoff++, 3)]);
        }
      }
    });
  return Object.assign(protect, {
    candidateBootstrap: <A, E, R>(
      boundary: CodeGraphDirectPersistentCapacityBoundary,
      gate: import('../store/models.js').CodeGraphPreparationGate | undefined,
      effect: Effect.Effect<A, E, R>,
    ) => runCandidate(boundary, gate, () => effect),
    candidateWindow: <A, E, R>(
      plan: import('../store/resolution/candidate_capacity.js').CandidateCapacityPlan,
      binding: import('../store/resolution/candidate_capacity.js').CandidateWindowBinding,
      gate: import('../store/models.js').CodeGraphPreparationGate | undefined,
      use: (covered: CodeGraphDirectPersistentCapacityProtector) => Effect.Effect<A, E, R>,
    ) => {
      const boundary: CodeGraphDirectPersistentCapacityBoundary = {
        operation: 'stage persistent code graph facts',
        rowCount: plan.rows,
        finalFactBytes: plan.bytes,
        transientFilesystem: 'temporary',
        candidateWindow: {children: plan.children, rows: plan.rows, bytes: plan.bytes},
      };
      if (
        binding.databasePath !== input.layout.databasePath ||
        binding.snapshotId !== plan.snapshotId ||
        binding.sourceFingerprint !== plan.sourceFingerprint
      )
        return Effect.fail(
          CodeGraphStoreError.of(
            'Candidate source/database/snapshot binding does not match its actual capacity context.',
          ),
        );
      return runCandidate(
        boundary,
        gate,
        lease =>
          withCandidateCapacityWitness(lease, plan, binding, witness =>
            use((child, effect) => consumeCandidateCapacity(witness, binding, child, effect)),
          ),
        {...binding, planCanonical: JSON.stringify(plan)},
      );
    },
  });
}

const observeDirectPersistentCapacity = Effect.fn('codeGraph.observeDirectPersistentCapacity')(function* (input: {
  readonly boundary: CodeGraphDirectPersistentCapacityBoundary;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly layout: CodeGraphLayout;
  readonly protection: DirectPersistentCapacityProtection;
  readonly threadnoteHome: string;
  readonly candidateWindow?: import('../disk/reservation.js').CodeGraphCandidateReservationBinding;
}) {
  const system = input.protection.system;
  const windowsCandidate = system.platform === 'win32' && input.boundary.candidateWindow !== undefined;
  const factoryCurrent = () =>
    !windowsCandidate || isDefaultCandidateSqliteClient(input.candidateWindow?.sql, input.layout.databasePath);
  const selection = () =>
    codeGraphCandidateWindowsTemporaryDirectory({
      environment: system.environment(),
      runtimeVersion: system.runtimeVersion,
      path: input.protection.path,
    });
  const temporaryDirectory = factoryCurrent()
    ? yield* codeGraphCapacityTemporaryDirectory(
        {
          boundary: input.boundary,
          environment: input.protection.system.environment(),
          platform: input.protection.system.platform,
          temporaryDirectory: input.protection.temporaryDirectory,
          runtimeVersion: system.runtimeVersion,
          path: input.protection.path,
        },
        directory => codeGraphSqliteTemporaryDirectoryUsable(input.fs, directory),
      )
    : undefined;
  const [durableFilesystem, temporaryFilesystem] = yield* Effect.all(
    [
      input.fs.stat(input.layout.repositoryRoot).pipe(
        Effect.map(info => info.dev),
        Effect.option,
      ),
      temporaryDirectory === undefined
        ? Effect.succeedNone
        : input.fs.stat(temporaryDirectory).pipe(
            Effect.map(info => info.dev),
            Effect.option,
          ),
    ] as const,
    {concurrency: 2},
  );
  const filesystemsShared =
    Option.isSome(durableFilesystem) && Option.isSome(temporaryFilesystem)
      ? durableFilesystem.value === temporaryFilesystem.value
      : undefined;
  const probe = (target: string) =>
    input.protection.availableDiskBytes(target, input.boundary).pipe(Effect.orElseSucceed(() => undefined));
  const temporaryProbe = temporaryDirectory === undefined ? succeedUndefined : probe(temporaryDirectory);
  const availability =
    filesystemsShared === undefined
      ? Effect.succeed([undefined, undefined] as const)
      : filesystemsShared
        ? probe(input.layout.repositoryRoot).pipe(Effect.map(available => [available, available] as const))
        : Effect.all([probe(input.layout.repositoryRoot), temporaryProbe] as const, {
            concurrency: 2,
          });
  const [[durableAvailableBytes, temporaryAvailableBytes], storage] = yield* Effect.all(
    [
      availability,
      inspectCodeGraphStorage(input.threadnoteHome, input.identity.checkoutId, {openWhileLocked: true}).pipe(
        Effect.option,
      ),
    ] as const,
    {concurrency: 2},
  );
  const pageStorage =
    Option.isSome(storage) && storage.value.state === 'available' && storage.value.pageStorage.state === 'available'
      ? storage.value.pageStorage
      : undefined;
  const demand = codeGraphPersistentCapacityDemand({
    boundary: input.boundary,
    lexicalFormatVersion: CODE_GRAPH_LEXICAL_COMPACT_FORMAT_VERSION,
    pageSize: pageStorage?.pageSize ?? 0,
    walAutoCheckpointPages: input.protection.walAutoCheckpointPages,
  });
  // Every directory/device/space/storage observation above can yield. A stale Windows
  // selection is unknown, not a healthy observation of a newly uncharged filesystem.
  const selectionCurrent =
    factoryCurrent() && (!windowsCandidate || (temporaryDirectory !== undefined && selection() === temporaryDirectory));
  return {
    demand,
    durableAvailableBytes,
    durableFilesystemKey: Option.isSome(durableFilesystem)
      ? (codeGraphDiskReservationFilesystemKey(input.protection.system.platform, durableFilesystem.value) ??
        'durable-filesystem-unknown')
      : 'durable-filesystem-unknown',
    freelistBytes:
      input.boundary.operation === 'sort persistent code graph materialization spool' ||
      input.boundary.candidateWindow !== undefined
        ? 0
        : (pageStorage?.reclaimableBytes ?? 0),
    temporaryAvailableBytes: selectionCurrent ? temporaryAvailableBytes : undefined,
    temporaryFilesystemKey:
      selectionCurrent && Option.isSome(temporaryFilesystem)
        ? (codeGraphDiskReservationFilesystemKey(input.protection.system.platform, temporaryFilesystem.value) ??
          'temporary-filesystem-unknown')
        : 'temporary-filesystem-unknown',
    ...(windowsCandidate && selectionCurrent ? {candidateTemporaryDirectory: temporaryDirectory} : {}),
  };
});

/** @internal Narrow observation seam for capacity-topology integration coverage. */
export const observeDirectPersistentCapacityForTest = observeDirectPersistentCapacity;
