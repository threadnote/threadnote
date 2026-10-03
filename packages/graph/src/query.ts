import {Clock, Context, Crypto, Effect, FileSystem, Layer, Option, Path, Schema} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {
  codeGraphDirectPersistentCapacityProtector,
  CodeGraphIndexer,
  type DirectPersistentCapacityProtection,
} from './indexer.js';
import {CodeGraphMaintenanceCoordinator} from './maintenance/coordinator.js';
import {currentCodeGraphBuildStatus} from './build_status.js';
import {worktreeOverlayState} from './inventory.js';
import type {CodeGraphCliPurgeProgress} from './cli/progress.js';
import {CodeGraphLanguagePackRegistry, type CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import {codeGraphLayout, type CodeGraphLayout} from './layout.js';
import {CODE_GRAPH_GATE_LOCK_OPTIONS, withCodeGraphTargetWorktreeLock} from './maintenance/gate.js';
import {purgeCodeGraphRepositoryRoot} from './maintenance.js';
import {
  recordVerifiedCodeGraphLocalAssociation,
  resolveAndRecordCodeGraphLocalAssociation,
} from './local_provenance.js';
import {compareCodeUnits} from './ordering.js';
import {sanitizeCodeGraphPresentationText as sanitizeText} from './presentation_text.js';
import {resolveRepositoryIdentity} from './repository.js';
import {
  attachCodeGraphStatusObservation,
  codeGraphSnapshotMatchesWorktree as snapshotMatches,
  observationFromCodeGraphStatus,
  observeCodeGraphQueryWorktree as observeWorktree,
  sameCodeGraphRepositoryIdentity as sameRepositoryIdentity,
  shouldAttachSharedReadySnapshot,
  skipCodeGraphQueryTelemetryStage,
  withCodeGraphQueryTelemetryStage,
  type CodeGraphQueryInterlock,
  type CodeGraphQueryTelemetryObserver,
  type CodeGraphSharedReadyAttachInterlock,
  type CodeGraphStatusObservation,
  type CodeGraphStatusOptions,
  type CodeGraphTraversalTimeBudgets,
} from './query/contract.js';
import {codeGraphSnapshotRuntimeCurrent} from './query/snapshot_runtime.js';
import {selectCompatibleReadyCodeGraphSnapshot} from './query/ready_snapshot.js';
import {
  codeGraphProjectCoverage,
  codeGraphQueryScopeCurrent,
  codeGraphQueryScopeReceipt,
  codeGraphQueryScopeSnapshotCompatible,
  discloseCodeGraphProjectCoverage,
  observeCodeGraphQueryScope,
  outsideCodeGraphProjectPaths,
  type CodeGraphQueryScope,
  type CodeGraphQueryScopeReceipt,
} from './query/scope.js';
import {codeGraphScopeAdmitsPath} from './scope/applicability.js';
import {isCodeGraphCapacityPause} from './disk/capacity.js';
import {pathQuery, QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS} from './query/path.js';
export {pathQuery, QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS} from './query/path.js';
import {adoptCodeGraphSnapshotAdmission, codeGraphSnapshotAdmissionCurrentForIdentity} from './admission_freshness.js';
import {
  exactCodeGraphImpactSelectorMatches,
  isStableCodeGraphNodeId,
  parseCodeGraphEndpointSelector,
} from './query/selector.js';
import {
  codeGraphLanguagePackStatuses,
  repositoryIdentityObservation,
  postPromotionObservation,
  resolvePublishedRepositoryIdentityObservation,
} from './query/status_helpers.js';
export {observationFromCodeGraphStatus, shouldAttachSharedReadySnapshot} from './query/contract.js';
export {codeGraphSnapshotMatchesCurrentLanguagePacks} from './query/snapshot_runtime.js';
export type {
  CodeGraphQueryInterlock,
  CodeGraphQueryTelemetryObserver,
  CodeGraphQueryTelemetryPhase,
  CodeGraphQueryTelemetryStage,
  CodeGraphQueryTelemetryStageDisposition,
  CodeGraphSharedReadyAttachInterlock,
  CodeGraphStatusObservation,
  CodeGraphStatusOptions,
  CodeGraphTraversalTimeBudgets,
} from './query/contract.js';
import {codeGraphSymbolSearchScoreMultiplier, CodeGraphStore, type CodeGraphStoreShape} from './store.js';
import {CodeGraphEmbeddingIndex, type CodeGraphEmbeddingIndexShape} from './embedding.js';
import {addUnavailableImpactBaseWarning} from './query/impact_base.js';
import {loadSharedGraphQuerySource} from './sharing/provenance.js';
import {
  CODE_GRAPH_RESULT_VERSION,
  CodeGraphRepositoryError,
  CodeGraphSnapshotUnavailable,
  CodeGraphStoreBusyError,
  CodeGraphStoreTransientIoError,
  type CodeGraphEdge,
  type CodeGraphProgress,
  type CodeGraphProvenance,
  type CodeGraphQueryNode,
  type CodeGraphQueryOptions,
  type CodeGraphQueryResult,
  type CodeGraphSnapshot,
  type CodeGraphStatus,
  type RepositoryIdentity,
  type RepositoryIdentityExpectation,
} from './types.js';

export interface CodeGraphInspectOptions extends CodeGraphQueryOptions {
  readonly baseCommit?: string;
  /** @internal Bounded read workers may reuse a ready base but must never start repository-sized indexing. */
  readonly baseCommitPolicy?: 'ensure' | 'ready-only';
  readonly interlock?: CodeGraphQueryInterlock;
  readonly requestMaintenance?: boolean;
  readonly onProgress?: (progress: CodeGraphProgress) => Effect.Effect<void>;
  readonly refresh?: boolean;
  readonly readyScopeReceipt?: CodeGraphQueryScopeReceipt;
  readonly deferProjectScopePresentation?: boolean;
  readonly seedQueryCount?: number;
  readonly seedQueries?: readonly string[];
  /** Internal pre-read observation returned by status; never serialized to command or MCP output. */
  readonly statusObservation?: CodeGraphStatusObservation;
  readonly telemetry?: CodeGraphQueryTelemetryObserver;
  readonly strictFreshness?: boolean;
  readonly threadnoteHome: string;
}
const CODE_GRAPH_SHARED_ATTACH_WRITER_WAIT_MILLISECONDS = 250;
export class CodeGraphQueryService extends Context.Service<
  CodeGraphQueryService,
  {
    /**
     * Promote a shared clean ready snapshot for HEAD onto this worktree when
     * the worktree is clean and has no matching active pointer yet. An explicit
     * local-read interlock may instead select compatible clean repository
     * evidence as stale without changing the worktree pointer.
     */
    readonly attachSharedReadySnapshot: (
      threadnoteHome: string,
      identity: RepositoryIdentity,
      /** @internal Fresh status returned for this exact identity avoids repeating its Git observation. */
      observedStatus?: CodeGraphStatus,
      interlock?: CodeGraphSharedReadyAttachInterlock,
    ) => Effect.Effect<CodeGraphStatus, unknown>;
    readonly inspect: (options: CodeGraphInspectOptions) => Effect.Effect<CodeGraphQueryResult, unknown>;
    readonly purge: (
      home: string,
      cwd: string,
      onProgress?: (progress: CodeGraphCliPurgeProgress) => Effect.Effect<void, unknown>,
    ) => Effect.Effect<string, unknown>;
    readonly status: (
      threadnoteHome: string,
      cwd: string,
      options?: CodeGraphStatusOptions,
    ) => Effect.Effect<CodeGraphStatus, unknown>;
    readonly statusForIdentity: (
      threadnoteHome: string,
      identity: RepositoryIdentity,
      options?: CodeGraphStatusOptions,
    ) => Effect.Effect<CodeGraphStatus, unknown>;
    /** @internal Revalidate a manifest path against one published workset member. */
    readonly statusForPublishedIdentity: (
      threadnoteHome: string,
      cwd: string,
      expected: RepositoryIdentityExpectation,
      options?: CodeGraphStatusOptions,
    ) => Effect.Effect<CodeGraphStatus, unknown>;
    /** @internal Keep status, lease, evidence reads, and the final fence on one SQLite session. */
    readonly withStatusSession?: <A, E, R>(
      threadnoteHome: string,
      cwd: string,
      expected: RepositoryIdentityExpectation | undefined,
      options: CodeGraphStatusOptions,
      use: (status: CodeGraphStatus) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | unknown, R>;
  }
>()('@threadnote/graph/query/CodeGraphQueryService') {
  static readonly layer = Layer.effect(
    CodeGraphQueryService,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const command = yield* CommandExecutor;
      const system = yield* SystemInfo;
      const store = yield* CodeGraphStore;
      const indexer = yield* CodeGraphIndexer;
      const maintenance = yield* CodeGraphMaintenanceCoordinator;
      const embedding = yield* CodeGraphEmbeddingIndex;
      const languagePacks = yield* CodeGraphLanguagePackRegistry;
      const withRepositoryServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(CommandExecutor, command),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
        );
      const requestMaintenance = (threadnoteHome: string, identity: RepositoryIdentity) => {
        const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
        return maintenance.request({
          allowIndexPreparation: true,
          anchorIdentity: identity,
          checkoutId: identity.checkoutId,
          databasePath: layout.databasePath,
          threadnoteHome,
          writerLockPath: layout.databaseWriteLockPath,
        });
      };
      const hasLiveWorktreeBuilder = (layout: CodeGraphLayout) =>
        currentCodeGraphBuildStatus(layout, layout.worktreeId).pipe(
          Effect.map(status => status?.coordination?.lockVerified === true && status.coordination.role === 'owner'),
          Effect.orElseSucceed(() => false),
        );
      const readReadySnapshotWhileBuilderStarts = <A, E>(layout: CodeGraphLayout, read: Effect.Effect<A, E>) =>
        read.pipe(
          Effect.catchIf(Schema.is(CodeGraphStoreTransientIoError), error =>
            hasLiveWorktreeBuilder(layout).pipe(
              Effect.flatMap(liveBuilder => (liveBuilder ? Effect.void : Effect.fail(error))),
            ),
          ),
        );
      const statusForIdentity = (
        threadnoteHome: string,
        identity: RepositoryIdentity,
        options?: CodeGraphStatusOptions,
        identityAlreadyObserved = false,
        preobservedWorktreeChanged?: boolean,
        callerCwd = identity.repoRoot,
      ) =>
        Effect.gen(function* () {
          if (!identityAlreadyObserved) yield* recordVerifiedCodeGraphLocalAssociation(threadnoteHome, identity);
          const projectScope = yield* observeCodeGraphQueryScope(
            threadnoteHome,
            callerCwd,
            identity,
            languagePacks,
            options ?? {},
          );
          yield* options?.afterIdentityObserved?.(identity, projectScope?.project) ?? Effect.void;
          const scopeKey = projectScope?.scope?.scopeKey;
          const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId, scopeKey);
          const candidate = yield* readReadySnapshotWhileBuilderStarts(
            layout,
            store.readySnapshot(layout.databasePath, identity.worktreeId, scopeKey),
          );
          const readySnapshot = candidate?.repositoryId === identity.repositoryId ? candidate : undefined;
          if (projectScope?.scope !== undefined) {
            const compatible =
              readySnapshot &&
              (yield* codeGraphQueryScopeSnapshotCompatible(
                projectScope,
                store,
                layout.databasePath,
                identity.worktreeId,
                readySnapshot,
              ));
            const current =
              readySnapshot !== undefined &&
              (yield* codeGraphQueryScopeCurrent(projectScope, store, layout, readySnapshot, identity, languagePacks));
            return attachCodeGraphStatusObservation(
              {
                databasePath: layout.databasePath,
                freshness: current ? 'current' : 'stale',
                identity,
                languagePacks: codeGraphLanguagePackStatuses(languagePacks),
                readySnapshot: compatible ? readySnapshot || undefined : undefined,
                stale: !current,
                projectCoverage: codeGraphProjectCoverage(projectScope, identity, readySnapshot || undefined, current),
              },
              {identity, projectScope, manifestPath: options?.manifestPath},
            );
          }
          const runtimeCurrent = readySnapshot
            ? yield* codeGraphSnapshotRuntimeCurrent(
                store,
                layout.databasePath,
                readySnapshot,
                languagePacks,
                options?.observeWorktree === false ? undefined : {layout, identity},
              )
            : false;
          const telemetryPhase = options?.telemetryPhase ?? 'graph.query.status';
          const overlay =
            options?.observeWorktree === false
              ? yield* skipCodeGraphQueryTelemetryStage(
                  options.telemetry,
                  telemetryPhase,
                  'query-worktree-observation',
                ).pipe(Effect.as(undefined))
              : yield* withCodeGraphQueryTelemetryStage(
                  options?.telemetry,
                  telemetryPhase,
                  'query-worktree-observation',
                  preobservedWorktreeChanged === false
                    ? Effect.succeed({dirty: false as const, fingerprint: undefined})
                    : worktreeOverlayState(identity),
                  options?.telemetryWorktreeDisposition,
                );
          const stale =
            !readySnapshot ||
            !runtimeCurrent ||
            readySnapshot.commit !== identity.headCommit ||
            (overlay !== undefined && !snapshotMatches(readySnapshot, identity.headCommit, overlay));
          const status = {
            ...(projectScope === undefined
              ? {}
              : {
                  projectCoverage: codeGraphProjectCoverage(projectScope, identity, readySnapshot || undefined, !stale),
                }),
            databasePath: layout.databasePath,
            freshness: stale ? 'stale' : overlay === undefined ? 'deferred' : 'current',
            identity,
            languagePacks: codeGraphLanguagePackStatuses(languagePacks),
            readySnapshot: readySnapshot ? {...readySnapshot, worktreeId: identity.worktreeId} : undefined,
            stale,
          } satisfies CodeGraphStatus;
          return attachCodeGraphStatusObservation(status, {
            identity,
            projectScope,
            manifestPath: options?.manifestPath,
            ...(overlay === undefined ? {} : {overlay}),
          });
        });
      const attachExactSharedReadySnapshot = (
        threadnoteHome: string,
        identity: RepositoryIdentity,
        observedStatus?: CodeGraphStatus,
        interlock?: CodeGraphSharedReadyAttachInterlock,
      ) =>
        Effect.gen(function* () {
          // statusForIdentity already attaches a non-writable observation; never re-attach
          // onto the same object (Object.defineProperty would throw).
          const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
          const observation = observedStatus && observationFromCodeGraphStatus(observedStatus);
          const selectionOptions = {
            project: observedStatus?.projectCoverage?.project,
            manifestPath: observation?.manifestPath,
          };
          const reusableStatus =
            observedStatus !== undefined &&
            observation?.overlay !== undefined &&
            sameRepositoryIdentity(observedStatus.identity, identity) &&
            sameRepositoryIdentity(observation.identity, identity)
              ? observedStatus
              : undefined;
          const status =
            reusableStatus &&
            (reusableStatus.stale ||
              (reusableStatus.readySnapshot &&
                (yield* codeGraphSnapshotAdmissionCurrentForIdentity(
                  layout,
                  reusableStatus.readySnapshot,
                  identity,
                  languagePacks,
                ))))
              ? reusableStatus
              : yield* statusForIdentity(threadnoteHome, identity, {
                  ...selectionOptions,
                  telemetry: interlock?.telemetry,
                  telemetryPhase: 'graph.query.snapshot',
                  telemetryWorktreeDisposition: 'fallback',
                });
          if (!status.stale && status.readySnapshot?.commit === identity.headCommit) return status;
          const overlay =
            observationFromCodeGraphStatus(status)?.overlay ??
            (yield* withCodeGraphQueryTelemetryStage(
              interlock?.telemetry,
              'graph.query.snapshot',
              'query-worktree-observation',
              worktreeOverlayState(identity),
              'fallback',
            ));
          if (overlay.dirty) return status;
          const candidate = yield* readReadySnapshotWhileBuilderStarts(
            layout,
            store.readySnapshotForCommit(layout.databasePath, identity.repositoryId, identity.headCommit),
          );
          const candidateRuntimeCurrent = candidate
            ? yield* codeGraphSnapshotRuntimeCurrent(store, layout.databasePath, candidate, languagePacks, {
                layout,
                identity,
                producingWorktree: true,
              })
            : false;
          if (
            candidate === undefined ||
            !candidateRuntimeCurrent ||
            !shouldAttachSharedReadySnapshot({
              candidate,
              headCommit: identity.headCommit,
              overlayDirty: overlay.dirty,
              readySnapshot: status.readySnapshot,
            })
          ) {
            return status;
          }
          yield* interlock?.afterOptimisticCandidate?.() ?? Effect.void;
          return yield* withCodeGraphTargetWorktreeLock(
            threadnoteHome,
            identity.checkoutId,
            identity.worktreeId,
            Effect.gen(function* () {
              // The initial observation is only an optimistic fast path. Once
              // the target builder is excluded, repeat the complete status and
              // candidate checks so a concurrent promotion or dirty overlay
              // cannot be overwritten by this opportunistic attach.
              const lockedStatus = yield* statusForIdentity(
                threadnoteHome,
                identity,
                {
                  ...selectionOptions,
                  telemetry: interlock?.telemetry,
                  telemetryPhase: 'graph.query.snapshot',
                  telemetryWorktreeDisposition: 'fallback',
                },
                true,
              );
              if (!lockedStatus.stale && lockedStatus.readySnapshot?.commit === identity.headCommit) {
                return lockedStatus;
              }
              const lockedOverlay = observationFromCodeGraphStatus(lockedStatus)?.overlay;
              if (lockedOverlay?.dirty !== false) return lockedStatus;
              const lockedCandidate = yield* readReadySnapshotWhileBuilderStarts(
                layout,
                store.readySnapshotForCommit(layout.databasePath, identity.repositoryId, identity.headCommit),
              );
              const lockedCandidateRuntimeCurrent = lockedCandidate
                ? yield* codeGraphSnapshotRuntimeCurrent(store, layout.databasePath, lockedCandidate, languagePacks, {
                    layout,
                    identity,
                    producingWorktree: true,
                  })
                : false;
              if (
                lockedCandidate === undefined ||
                !lockedCandidateRuntimeCurrent ||
                !shouldAttachSharedReadySnapshot({
                  candidate: lockedCandidate,
                  headCommit: identity.headCommit,
                  overlayDirty: lockedOverlay.dirty,
                  readySnapshot: lockedStatus.readySnapshot,
                })
              ) {
                return lockedStatus;
              }
              yield* interlock?.beforeIdentityResolution?.() ?? Effect.void;
              const promotionIdentity = yield* withCodeGraphQueryTelemetryStage(
                interlock?.telemetry,
                'graph.query.snapshot',
                'query-repository-identity',
                resolveRepositoryIdentity(identity.repoRoot),
              ).pipe(Effect.option);
              if (Option.isNone(promotionIdentity)) return lockedStatus;
              if (!sameRepositoryIdentity(promotionIdentity.value, identity)) {
                return yield* statusForIdentity(threadnoteHome, promotionIdentity.value, {
                  ...selectionOptions,
                  telemetry: interlock?.telemetry,
                  telemetryPhase: 'graph.query.snapshot',
                  telemetryWorktreeDisposition: 'fallback',
                });
              }
              const capacityProtection: DirectPersistentCapacityProtection = {
                availableDiskBytes:
                  interlock?.diskCapacityAvailableBytes ?? ((target: string) => system.availableDiskBytes(target)),
                crypto,
                maintenance,
                path,
                system,
                temporaryDirectory: system.tempDirectory,
                walAutoCheckpointPages: 1_000,
              };
              yield* store.promote(layout.databasePath, promotionIdentity.value, lockedCandidate.id, {
                persistentCapacityProtector: codeGraphDirectPersistentCapacityProtector({
                  capacityProtection,
                  // The target-worktree lock is already held here. Never wait
                  // for capacity or recursively run maintenance while holding
                  // that authority; a later request can retry the attach.
                  claimMode: 'nonblocking-one-attempt',
                  fs,
                  identity: promotionIdentity.value,
                  layout,
                  threadnoteHome,
                }),
                // Target-build exclusion is already held. Give an existing
                // checkout writer one bounded foreground window to finish so
                // opportunistic maintenance cannot make a clean attach flaky.
                waitTimeoutMilliseconds: CODE_GRAPH_SHARED_ATTACH_WRITER_WAIT_MILLISECONDS,
              });
              yield* interlock?.afterPromotion?.() ?? Effect.void;
              const published = yield* withCodeGraphQueryTelemetryStage(
                interlock?.telemetry,
                'graph.query.snapshot',
                'query-worktree-observation',
                postPromotionObservation(promotionIdentity.value),
                'fallback',
              );
              if (published.headCommit !== promotionIdentity.value.headCommit) {
                yield* interlock?.beforeIdentityResolution?.() ?? Effect.void;
                const publishedIdentity = yield* withCodeGraphQueryTelemetryStage(
                  interlock?.telemetry,
                  'graph.query.snapshot',
                  'query-repository-identity',
                  resolveRepositoryIdentity(identity.repoRoot),
                ).pipe(Effect.option);
                return Option.isSome(publishedIdentity)
                  ? yield* statusForIdentity(threadnoteHome, publishedIdentity.value, {
                      ...selectionOptions,
                      telemetry: interlock?.telemetry,
                      telemetryPhase: 'graph.query.snapshot',
                      telemetryWorktreeDisposition: 'fallback',
                    })
                  : lockedStatus;
              }
              const finalOverlay = published.overlay;
              const stale =
                finalOverlay?.dirty !== false ||
                !(yield* adoptCodeGraphSnapshotAdmission(
                  layout,
                  lockedCandidate,
                  promotionIdentity.value,
                  languagePacks,
                ));
              return attachCodeGraphStatusObservation(
                {
                  ...lockedStatus,
                  freshness: stale ? 'stale' : 'current',
                  identity: promotionIdentity.value,
                  readySnapshot: {...lockedCandidate, worktreeId: promotionIdentity.value.worktreeId},
                  stale,
                },
                finalOverlay === undefined ? undefined : {identity: promotionIdentity.value, overlay: finalOverlay},
              );
            }),
          ).pipe(Effect.catchIf(isPreWriteSharedReadyAttachFailure, () => Effect.succeed(status)));
        });
      const borrowSharedReadySnapshot = Effect.fn('codeGraph.query.borrowSharedReadySnapshot')(function* (
        threadnoteHome: string,
        status: CodeGraphStatus,
        telemetry?: CodeGraphQueryTelemetryObserver,
      ) {
        const identity = status.identity;
        const observation = observationFromCodeGraphStatus(status);
        const scopeKey = observation?.projectScope?.scope?.scopeKey;
        if (observation?.overlay === undefined) {
          yield* skipCodeGraphQueryTelemetryStage(telemetry, 'graph.query.snapshot', 'query-worktree-observation');
        }
        const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId, scopeKey);
        const statusSnapshotRuntimeCurrent =
          status.readySnapshot !== undefined &&
          status.readySnapshot.repositoryId === identity.repositoryId &&
          (yield* codeGraphSnapshotRuntimeCurrent(store, layout.databasePath, status.readySnapshot, languagePacks));
        if (statusSnapshotRuntimeCurrent) return status;
        const candidates =
          (yield* readReadySnapshotWhileBuilderStarts(
            layout,
            store.recentReadySnapshotsForRepository(layout.databasePath, identity.repositoryId, scopeKey),
          )) ?? [];
        let candidate: CodeGraphSnapshot | undefined;
        for (const recent of candidates) {
          const scopeCompatible =
            observation?.projectScope?.scope === undefined ||
            (yield* codeGraphQueryScopeSnapshotCompatible(
              observation.projectScope,
              store,
              layout.databasePath,
              recent.worktreeId,
              recent,
            ));
          if (
            recent.repositoryId === identity.repositoryId &&
            scopeCompatible &&
            (yield* codeGraphSnapshotRuntimeCurrent(store, layout.databasePath, recent, languagePacks))
          ) {
            candidate = recent;
            break;
          }
        }
        if (candidate === undefined) {
          return attachCodeGraphStatusObservation(
            {...status, freshness: 'stale', readySnapshot: undefined, stale: true},
            observation,
          );
        }
        return attachCodeGraphStatusObservation(
          {
            ...status,
            freshness: 'stale',
            readySnapshot: {...candidate, worktreeId: identity.worktreeId},
            stale: true,
            ...(observation?.projectScope === undefined
              ? {}
              : {projectCoverage: codeGraphProjectCoverage(observation.projectScope, identity, candidate, false)}),
          },
          {
            ...(observation ?? {}),
            borrowedSnapshotId: candidate.id,
            identity,
          },
        );
      });
      const attachSharedReadySnapshot = (
        threadnoteHome: string,
        identity: RepositoryIdentity,
        observedStatus?: CodeGraphStatus,
        interlock?: CodeGraphSharedReadyAttachInterlock,
      ) => {
        if (observedStatus?.projectCoverage?.kind === 'project') {
          return interlock?.allowBorrowedStale === true
            ? borrowSharedReadySnapshot(threadnoteHome, observedStatus, interlock.telemetry)
            : Effect.succeed(observedStatus);
        }
        const exact = attachExactSharedReadySnapshot(threadnoteHome, identity, observedStatus, interlock);
        if (interlock?.allowBorrowedStale !== true) return exact;
        return Effect.gen(function* () {
          if (observedStatus && !observedStatus.readySnapshot) {
            const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
            const lockAge = (yield* hasLiveWorktreeBuilder(layout))
              ? yield* fs.stat(layout.lockPath).pipe(
                  Effect.map(info => Option.getOrUndefined(info.mtime)?.getTime()),
                  Effect.orElseSucceed(() => undefined as number | undefined),
                )
              : undefined;
            if (
              lockAge !== undefined &&
              (yield* Clock.currentTimeMillis) - lockAge <= CODE_GRAPH_GATE_LOCK_OPTIONS.staleAfterMilliseconds
            ) {
              const borrowed = yield* borrowSharedReadySnapshot(threadnoteHome, observedStatus, interlock.telemetry);
              if (borrowed.readySnapshot) return borrowed;
            }
          }
          return yield* exact.pipe(
            Effect.flatMap(status => borrowSharedReadySnapshot(threadnoteHome, status, interlock.telemetry)),
          );
        });
      };
      return CodeGraphQueryService.of({
        attachSharedReadySnapshot: (threadnoteHome, identity, observedStatus, interlock) => {
          const attach = attachSharedReadySnapshot(threadnoteHome, identity, observedStatus, interlock);
          return withRepositoryServices(
            interlock?.requestMaintenance === false
              ? attach
              : attach.pipe(
                  Effect.tap(status =>
                    observationFromCodeGraphStatus(status)?.borrowedSnapshotId
                      ? Effect.void
                      : requestMaintenance(threadnoteHome, status.identity),
                  ),
                ),
          );
        },
        inspect: options =>
          withRepositoryServices(
            Effect.gen(function* () {
              const statusObservation = options.statusObservation;
              const identity =
                statusObservation?.identity ??
                (yield* withCodeGraphQueryTelemetryStage(
                  options.telemetry,
                  'graph.query.execute',
                  'query-repository-identity',
                  resolveAndRecordCodeGraphLocalAssociation(options.threadnoteHome, options.cwd),
                  'fallback',
                )).identity;
              const projectScope =
                statusObservation?.projectScope ??
                (options.readyScopeReceipt === undefined
                  ? yield* observeCodeGraphQueryScope(
                      options.threadnoteHome,
                      options.cwd,
                      identity,
                      languagePacks,
                      options,
                    )
                  : undefined);
              const scopeReceipt = options.readyScopeReceipt ?? codeGraphQueryScopeReceipt(projectScope);
              const layout = codeGraphLayout(
                path,
                options.threadnoteHome,
                identity.checkoutId,
                identity.worktreeId,
                scopeReceipt?.scope.scopeKey,
              );
              const existing =
                options.refresh === false
                  ? undefined
                  : statusObservation?.borrowedSnapshotId
                    ? yield* store.readySnapshotById(layout.databasePath, statusObservation.borrowedSnapshotId)
                    : yield* store.readySnapshot(
                        layout.databasePath,
                        identity.worktreeId,
                        scopeReceipt?.scope.scopeKey,
                      );
              const freshnessRequired =
                options.refresh === true || options.operation === 'impact' || options.operation === 'path';
              // This probe only decides refresh; inspectReadyGraph always validates the selected snapshot.
              const runtimeCurrent =
                existing && freshnessRequired
                  ? yield* codeGraphSnapshotRuntimeCurrent(store, layout.databasePath, existing, languagePacks, {
                      layout,
                      identity,
                    })
                  : false;
              const strictFreshness =
                options.strictFreshness ??
                (options.refresh === true || options.operation === 'impact' || options.operation === 'path');
              const observeBeforeRead = options.refresh !== false || strictFreshness;
              const overlay =
                statusObservation?.overlay !== undefined
                  ? statusObservation.overlay
                  : observeBeforeRead && projectScope?.scope === undefined
                    ? yield* withCodeGraphQueryTelemetryStage(
                        options.telemetry,
                        'graph.query.execute',
                        'query-worktree-observation',
                        observeWorktree(identity, options.interlock),
                        'fallback',
                      )
                    : statusObservation === undefined
                      ? yield* skipCodeGraphQueryTelemetryStage(
                          options.telemetry,
                          'graph.query.execute',
                          'query-worktree-observation',
                        ).pipe(Effect.as(undefined))
                      : undefined;
              const stale =
                scopeReceipt !== undefined
                  ? !existing ||
                    !(yield* codeGraphQueryScopeCurrent(scopeReceipt, store, layout, existing, identity, languagePacks))
                  : !existing ||
                    !runtimeCurrent ||
                    existing.commit !== identity.headCommit ||
                    (overlay !== undefined && !snapshotMatches(existing, identity.headCommit, overlay));
              let rebuilt = false;
              if (options.refresh !== false && (!existing || (stale && freshnessRequired))) {
                yield* indexer.index({
                  project: projectScope?.project,
                  cwd: options.cwd,
                  ensureVectors: false,
                  onProgress: options.onProgress,
                  threadnoteHome: options.threadnoteHome,
                });
                rebuilt = true;
              }
              const inspect = (baseSnapshotId?: string) =>
                Effect.gen(function* () {
                  const read = () =>
                    inspectReadyGraph({
                      baseSnapshotId,
                      borrowedSnapshotId: rebuilt ? undefined : statusObservation?.borrowedSnapshotId,
                      embedding,
                      expectedRepositoryId: identity.repositoryId,
                      layout,
                      languagePacks,
                      deferWorktreeObservation: overlay === undefined && !rebuilt,
                      observation: rebuilt ? undefined : {identity, ...(overlay === undefined ? {} : {overlay})},
                      options,
                      projectScope,
                      projectScopeReceipt: scopeReceipt,
                      store,
                      strictFreshness,
                    });
                  let result = yield* read();
                  if (options.refresh !== false && freshnessRequired && result.freshness === 'stale') {
                    yield* indexer.index({
                      project: projectScope?.project,
                      cwd: options.cwd,
                      ensureVectors: false,
                      onProgress: options.onProgress,
                      threadnoteHome: options.threadnoteHome,
                    });
                    rebuilt = true;
                    result = yield* read();
                    if (result.freshness === 'stale') {
                      return yield* WorktreeChangedDuringQuery.make({
                        message: 'Worktree files kept changing while refreshing the code graph; retry the operation.',
                      });
                    }
                  }
                  return result;
                });
              if (options.operation === 'impact' && options.baseCommit) {
                if (options.baseCommitPolicy === 'ready-only') {
                  const readyBase = yield* store.readySnapshotForCommit(
                    layout.databasePath,
                    identity.repositoryId,
                    options.baseCommit,
                    undefined,
                    scopeReceipt?.scope.scopeKey,
                  );
                  const readyBaseCurrent = readyBase
                    ? yield* codeGraphSnapshotRuntimeCurrent(store, layout.databasePath, readyBase, languagePacks)
                    : false;
                  const result =
                    readyBase && readyBaseCurrent
                      ? yield* Effect.acquireUseRelease(
                          store
                            .acquireSnapshotLease(layout.databasePath, readyBase.id, 2 * 60_000)
                            .pipe(Effect.map(leaseToken => ({leaseToken, snapshot: readyBase}))),
                          base => inspect(base.snapshot.id),
                          base => store.releaseSnapshotLease(layout.databasePath, base.leaseToken).pipe(Effect.ignore),
                        )
                      : addUnavailableImpactBaseWarning(yield* inspect());
                  if (options.requestMaintenance !== false) {
                    yield* requestMaintenance(options.threadnoteHome, identity);
                  }
                  return result;
                }
                const result = yield* Effect.acquireUseRelease(
                  indexer.ensureCommit({
                    project: projectScope?.project,
                    commit: options.baseCommit,
                    cwd: options.cwd,
                    onProgress: options.onProgress,
                    threadnoteHome: options.threadnoteHome,
                  }),
                  base => inspect(base.snapshot.id),
                  base => store.releaseSnapshotLease(layout.databasePath, base.leaseToken).pipe(Effect.ignore),
                );
                if (options.requestMaintenance !== false) {
                  yield* requestMaintenance(options.threadnoteHome, identity);
                }
                return result;
              }
              const result = yield* inspect();
              if (options.requestMaintenance !== false) {
                yield* requestMaintenance(options.threadnoteHome, identity);
              }
              return result;
            }),
          ),
        purge: (threadnoteHome, cwd, onProgress) =>
          withRepositoryServices(
            Effect.gen(function* () {
              const identity = yield* resolveRepositoryIdentity(cwd);
              const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
              return yield* purgeCodeGraphRepositoryRoot(
                threadnoteHome,
                identity.checkoutId,
                layout.repositoryRoot,
                onProgress,
              );
            }),
          ),
        status: (threadnoteHome, cwd, options) =>
          withRepositoryServices(
            Effect.gen(function* () {
              const {identity} = yield* withCodeGraphQueryTelemetryStage(
                options?.telemetry,
                'graph.query.status',
                'query-repository-identity',
                resolveAndRecordCodeGraphLocalAssociation(threadnoteHome, cwd),
              );
              const status = yield* statusForIdentity(threadnoteHome, identity, options, true, undefined, cwd);
              if (options?.requestMaintenance !== false) {
                yield* requestMaintenance(threadnoteHome, status.identity);
              }
              return status;
            }),
          ),
        statusForIdentity: (threadnoteHome, identity, options) => {
          const status = statusForIdentity(threadnoteHome, identity, options);
          return withRepositoryServices(
            options?.requestMaintenance === false
              ? status
              : status.pipe(Effect.tap(value => requestMaintenance(threadnoteHome, value.identity))),
          );
        },
        statusForPublishedIdentity: (threadnoteHome, cwd, expected, options) =>
          withRepositoryServices(
            Effect.gen(function* () {
              const observation = yield* withCodeGraphQueryTelemetryStage(
                options?.telemetry,
                'graph.query.status',
                'query-repository-identity',
                resolvePublishedRepositoryIdentityObservation(cwd, expected, options?.observeWorktree !== false),
              );
              const identity = observation.identity;
              const changed = options?.afterIdentityObserved === undefined ? observation.worktreeChanged : undefined;
              const status = yield* statusForIdentity(threadnoteHome, identity, options, true, changed, cwd);
              if (options?.requestMaintenance !== false) yield* requestMaintenance(threadnoteHome, identity);
              return status;
            }),
          ),
        withStatusSession: (threadnoteHome, cwd, expected, options, use) =>
          withRepositoryServices(
            Effect.gen(function* () {
              const observation = yield* expected === undefined
                ? withCodeGraphQueryTelemetryStage(
                    options.telemetry,
                    'graph.query.status',
                    'query-repository-identity',
                    resolveAndRecordCodeGraphLocalAssociation(threadnoteHome, cwd),
                  ).pipe(Effect.map(local => repositoryIdentityObservation(local.identity)))
                : withCodeGraphQueryTelemetryStage(
                    options.telemetry,
                    'graph.query.status',
                    'query-repository-identity',
                    resolvePublishedRepositoryIdentityObservation(cwd, expected, options.observeWorktree !== false),
                  );
              const identity = observation.identity;
              const changed = options.afterIdentityObserved === undefined ? observation.worktreeChanged : undefined;
              const layout = codeGraphLayout(path, threadnoteHome, identity.checkoutId, identity.worktreeId);
              const observe = statusForIdentity(threadnoteHome, identity, options, true, changed, cwd);
              const read = observe.pipe(Effect.flatMap(use));
              const readSession: typeof read = store.withSession(layout.databasePath, read, {existingOnly: true});
              const result = yield* (yield* fs.exists(layout.databasePath))
                ? readSession
                : observe.pipe(
                    Effect.flatMap(status => (status.readySnapshot === undefined ? use(status) : readSession)),
                  );
              if (options.requestMaintenance !== false) yield* requestMaintenance(threadnoteHome, identity);
              return result;
            }),
          ),
      });
    }),
  );
}

export const traversalQuery = Effect.fn('codeGraph.traversalQuery')(function* (
  store: CodeGraphStoreShape,
  databasePath: string,
  snapshotId: string,
  query: string,
  direction: 'both' | 'incoming' | 'outgoing',
  nodeLimit: number,
  edgeLimit: number,
  depth: number,
  allowedProvenances: readonly CodeGraphProvenance[],
  embedding: CodeGraphEmbeddingIndexShape,
  threadnoteHome: string,
  layout: CodeGraphLayout,
  impact: boolean,
  seedQueries?: readonly string[],
  baseSnapshotId?: string,
  timeBudgets: CodeGraphTraversalTimeBudgets = {},
  packageName?: string,
  seedQueryCount?: number,
) {
  const traversalTimeBudgetMilliseconds = boundedInteger(
    timeBudgets.traversalMilliseconds,
    QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS,
    100,
    QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS,
  );
  const semanticTimeBudgetMilliseconds = boundedInteger(
    timeBudgets.semanticMilliseconds,
    QUERY_SEMANTIC_TIME_BUDGET_MILLISECONDS,
    100,
    QUERY_SEMANTIC_TIME_BUDGET_MILLISECONDS,
  );
  let deadline = (yield* Clock.currentTimeMillis) + traversalTimeBudgetMilliseconds;
  const requestedSeedQueries = (seedQueries?.length ? seedQueries : [query]).slice(0, MAX_IMPACT_SEED_QUERIES);
  const impactSelector = impact && !seedQueries?.length ? parseCodeGraphEndpointSelector(query) : undefined;
  const structuredImpactSelector =
    impactSelector !== undefined &&
    (impactSelector.path !== undefined || isStableCodeGraphNodeId(impactSelector.symbol));
  const seedLimit = impact ? MAX_IMPACT_SEED_SYMBOLS : Math.min(nodeLimit, 12);
  const perSeedLimit = impact
    ? Math.max(1, Math.min(20, Math.ceil(MAX_IMPACT_SEED_SYMBOLS / requestedSeedQueries.length)))
    : Math.max(1, seedLimit);
  const normalizedPackageName = packageName?.trim().toLocaleLowerCase('en-US');
  const lexicalCandidateLimit = normalizedPackageName ? Math.min(500, Math.max(200, perSeedLimit * 20)) : perSeedLimit;
  const lexicalCandidateGroups = impactSelector?.path
    ? [yield* store.findSymbolsByPathAndName(databasePath, snapshotId, impactSelector.path, impactSelector.symbol)]
    : impactSelector && isStableCodeGraphNodeId(impactSelector.symbol)
      ? [
          (yield* store.symbolsByIds(databasePath, snapshotId, [impactSelector.symbol])).map(node => ({
            ...node,
            score: 1,
          })),
        ]
      : impact && seedQueries?.length
        ? yield* store.searchSymbolsByPaths(databasePath, snapshotId, requestedSeedQueries, lexicalCandidateLimit)
        : yield* store.searchSymbolsMany(databasePath, snapshotId, requestedSeedQueries, lexicalCandidateLimit);
  // The elapsed budget governs graph traversal, not an already-completed
  // lexical seed lookup that SQLite cannot interrupt. Impact keeps one
  // absolute budget across path recovery and traversal; ordinary queries get
  // the same complete traversal window regardless of snapshot representation.
  if (!impact) deadline = (yield* Clock.currentTimeMillis) + traversalTimeBudgetMilliseconds;
  const exactImpactSelectorGroups = impactSelector
    ? lexicalCandidateGroups.map(group => exactCodeGraphImpactSelectorMatches(impactSelector, group))
    : [];
  const impactSelectorResolvedExactly = exactImpactSelectorGroups.some(group => group.length > 0);
  const lexicalGroups = lexicalCandidateGroups.map(group => {
    const packageMatches = normalizedPackageName
      ? group.filter(node => node.packageName?.toLocaleLowerCase('en-US') === normalizedPackageName)
      : group;
    const exactMatches = impactSelector ? exactCodeGraphImpactSelectorMatches(impactSelector, packageMatches) : [];
    return (impactSelectorResolvedExactly ? exactMatches : packageMatches).slice(0, perSeedLimit);
  });
  const lexicalCandidatesExamined = lexicalCandidateGroups.reduce((total, group) => total + group.length, 0);
  const lexicalPackageMatches = lexicalGroups.reduce((total, group) => total + group.length, 0);
  let timedOut = yield* deadlineReached(deadline);
  const unresolvedQueries = requestedSeedQueries.filter((_, index) => lexicalGroups[index]?.length === 0);
  const recovered =
    impact && !timedOut && baseSnapshotId && unresolvedQueries.length > 0
      ? yield* recoverDeletedImpactSeeds(
          store,
          databasePath,
          snapshotId,
          baseSnapshotId,
          unresolvedQueries,
          allowedProvenances,
          depth,
          deadline,
        )
      : {
          nodes: [],
          recoveredPaths: 0,
          remainingDepthById: new Map<string, number>(),
          timedOut: false,
          truncated: false,
        };
  timedOut ||= recovered.timedOut || (yield* deadlineReached(deadline));
  const lexicalById = new Map<string, CodeGraphQueryNode>();
  for (const node of [...lexicalGroups.flat(), ...recovered.nodes]) {
    const current = lexicalById.get(node.id);
    if (!current || node.score > current.score) lexicalById.set(node.id, node);
  }
  const lexicalSeeds = impact
    ? fairImpactSeeds([...lexicalGroups, recovered.nodes], seedLimit)
    : [...lexicalById.values()]
        .sort((left, right) => right.score - left.score || compareCodeUnits(left.id, right.id))
        .slice(0, seedLimit);
  const semanticEligible =
    !timedOut &&
    !(impact && seedQueries?.length) &&
    !structuredImpactSelector &&
    !impactSelectorResolvedExactly &&
    lexicalSeeds.length < seedLimit;
  const semanticResult = !semanticEligible
    ? {scores: new Map<string, number>(), timedOut: false}
    : yield* embedding.search(threadnoteHome, layout, snapshotId, query, Math.min(nodeLimit, 12)).pipe(
        Effect.map(scores => ({scores, timedOut: false as const})),
        Effect.orElseSucceed(() => ({scores: new Map<string, number>(), timedOut: false as const})),
        Effect.timeoutOrElse({
          duration: semanticTimeBudgetMilliseconds,
          orElse: () =>
            Effect.succeed({
              scores: new Map<string, number>(),
              timedOut: true as const,
            }),
        }),
      );
  if (semanticEligible) {
    deadline = (yield* Clock.currentTimeMillis) + traversalTimeBudgetMilliseconds;
  }
  const semantic = semanticResult.scores;
  const semanticOnlyIds = [...semantic.keys()].filter(id => !lexicalById.has(id)).slice(0, 12);
  const semanticCandidates =
    semanticOnlyIds.length === 0 ? [] : yield* store.symbolsByIds(databasePath, snapshotId, semanticOnlyIds);
  const semanticOnly = semanticCandidates
    .filter(
      node =>
        normalizedPackageName === undefined || node.packageName?.toLocaleLowerCase('en-US') === normalizedPackageName,
    )
    .slice(0, Math.max(0, nodeLimit - lexicalSeeds.length));
  timedOut ||= yield* deadlineReached(deadline);
  const queryTerms = queryTermsForRanking(query);
  const rankedSeeds = [
    ...lexicalSeeds.map(node => ({
      ...node,
      score: Math.max(node.score, rankedSemanticScore(node, semantic.get(node.id) ?? 0, queryTerms)),
    })),
    ...semanticOnly.map(node => ({
      ...node,
      score: rankedSemanticScore(node, semantic.get(node.id) ?? 0, queryTerms),
    })),
  ];
  const seeds = impact
    ? rankedSeeds.slice(0, seedLimit)
    : rankedSeeds
        .sort((left, right) => right.score - left.score || compareCodeUnits(left.id, right.id))
        .slice(0, seedLimit);
  const nodes = new Map(impact ? [] : seeds.map(node => [node.id, node] as const));
  const seedNodes = new Map(seeds.map(node => [node.id, node]));
  const seedIds = new Set(seeds.map(node => node.id));
  const seedOrder = new Map(seeds.map((node, index) => [node.id, index]));
  const edges = new Map<string, CodeGraphEdge>();
  let frontier = new Map(seeds.map(node => [node.id, recovered.remainingDepthById.get(node.id) ?? depth] as const));
  let analysisTruncated = recovered.truncated;
  for (let currentDepth = 0; frontier.size > 0 && edges.size < edgeLimit && !timedOut; currentDepth += 1) {
    if (yield* deadlineReached(deadline)) {
      timedOut = true;
      break;
    }
    const activeFrontier = [...frontier].filter(([, remainingDepth]) => remainingDepth > 0);
    if (activeFrontier.length === 0) break;
    const remainingEdges = edgeLimit - edges.size;
    if (remainingEdges <= 0) break;
    const adjacent = yield* store.edgesForNodes(
      databasePath,
      snapshotId,
      activeFrontier.map(([id]) => id),
      direction,
      Math.min(impact ? MAX_IMPACT_ANALYSIS_EDGES : remainingEdges, remainingEdges),
      allowedProvenances,
    );
    if (yield* deadlineReached(deadline)) {
      timedOut = true;
      break;
    }
    if (impact && adjacent.length >= MAX_IMPACT_ANALYSIS_EDGES) analysisTruncated = true;
    const discovered: string[] = [];
    const discoveredDepths = new Map<string, number>();
    const discoveredScores = new Map<string, number>();
    for (const edge of adjacent) {
      if (edges.size >= edgeLimit) break;
      edges.set(edge.id, edge);
      const parentDepth = Math.max(
        edge.sourceId ? (frontier.get(edge.sourceId) ?? 0) : 0,
        edge.targetId ? (frontier.get(edge.targetId) ?? 0) : 0,
      );
      for (const id of adjacentNodeIds(edge, direction, frontier)) {
        if (id && !nodes.has(id) && !seedIds.has(id) && nodes.size + discovered.length < nodeLimit) {
          if (!discoveredScores.has(id)) discovered.push(id);
          discoveredDepths.set(id, Math.max(discoveredDepths.get(id) ?? 0, parentDepth - 1));
          discoveredScores.set(
            id,
            Math.max(
              discoveredScores.get(id) ?? 0,
              relationTraversalScore(edge.relation) * edge.confidence * (1 / (currentDepth + 1)),
            ),
          );
        }
      }
    }
    const hydrated = yield* store.symbolsByIds(databasePath, snapshotId, discovered);
    if (yield* deadlineReached(deadline)) {
      timedOut = true;
      break;
    }
    const score = 1 / (currentDepth + 2);
    for (const symbol of hydrated) {
      nodes.set(symbol.id, {...symbol, score: impact ? (discoveredScores.get(symbol.id) ?? score) : score});
    }
    frontier = new Map(hydrated.map(symbol => [symbol.id, discoveredDepths.get(symbol.id) ?? 0]));
  }
  const orderedImpactNodes = [...nodes.values(), ...[...seedNodes.values()].filter(seed => !nodes.has(seed.id))].sort(
    (left, right) => {
      const leftSeed = seedIds.has(left.id);
      const rightSeed = seedIds.has(right.id);
      if (leftSeed !== rightSeed) return leftSeed ? 1 : -1;
      if (leftSeed && rightSeed) return (seedOrder.get(left.id) ?? 0) - (seedOrder.get(right.id) ?? 0);
      return right.score - left.score || compareCodeUnits(left.path, right.path) || compareCodeUnits(left.id, right.id);
    },
  );
  const unresolvedSeedQueries = Math.max(0, unresolvedQueries.length - recovered.recoveredPaths);
  const warnings: string[] = [];
  const suppliedSeedQueryCount = seedQueryCount ?? seedQueries?.length ?? 0;
  if (seedQueries && suppliedSeedQueryCount > MAX_IMPACT_SEED_QUERIES) {
    warnings.push(
      `Impact analysis evaluated ${MAX_IMPACT_SEED_QUERIES} of ${suppliedSeedQueryCount} changed paths; ` +
        'results are partial.',
    );
  }
  if (impact && seedQueries?.length && unresolvedSeedQueries > 0) {
    warnings.push(`${unresolvedSeedQueries} changed path(s) did not resolve to indexed code symbols.`);
  } else if (impact && !seedQueries?.length && seeds.length === 0) {
    warnings.push('Impact selector did not resolve to indexed code symbols.');
  }
  if (recovered.recoveredPaths > 0) {
    warnings.push(
      `Impact analysis recovered ${recovered.recoveredPaths} deleted path(s) from base snapshot ` +
        `${baseSnapshotId}; only surviving current dependents are returned and base-only relationships are omitted.`,
    );
  }
  if (analysisTruncated)
    warnings.push('Impact analysis reached its internal relationship budget; results are partial.');
  if (semanticResult.timedOut) {
    warnings.push('Semantic graph search reached its elapsed-time budget; lexical graph results were returned.');
  }
  if (normalizedPackageName && lexicalPackageMatches === 0) {
    warnings.push(
      `No lexical graph match was observed in package "${packageName!.trim()}" among ` +
        `${lexicalCandidatesExamined} bounded candidate${lexicalCandidatesExamined === 1 ? '' : 's'}. ` +
        'This is a package-local absence hint, not proof that the behavior is absent.',
    );
  }
  if (timedOut) {
    warnings.push('Graph traversal reached its elapsed-time budget; results are partial.');
  } else if (edges.size >= edgeLimit || nodes.size >= nodeLimit) {
    warnings.push('Graph traversal reached a configured result limit.');
  }
  return {
    edges: [...edges.values()],
    nodes: (impact ? orderedImpactNodes : [...nodes.values()]).slice(0, nodeLimit),
    ...(normalizedPackageName
      ? {
          scope: {
            evidence: 'bounded-lexical-observation' as const,
            lexicalCandidatesExamined,
            lexicalMatches: lexicalPackageMatches,
            packageName: packageName!.trim(),
            type: 'package' as const,
          },
        }
      : {}),
    warnings,
  };
});

function queryTermsForRanking(query: string): readonly string[] {
  return [
    ...new Set(
      query
        .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
        .toLocaleLowerCase('en-US')
        .match(/[\p{L}\p{N}_$.-]{2,}/gu) ?? [],
    ),
  ].slice(0, 32);
}

function rankedSemanticScore(
  node: Pick<CodeGraphQueryNode, 'kind' | 'name' | 'path'>,
  score: number,
  queryTerms: readonly string[],
): number {
  return Math.max(
    0,
    Math.min(1, score * codeGraphSymbolSearchScoreMultiplier(node.path, node.kind, node.name, queryTerms)),
  );
}

function fairImpactSeeds(
  groups: readonly (readonly CodeGraphQueryNode[])[],
  limit: number,
): readonly CodeGraphQueryNode[] {
  const selected = new Map<string, CodeGraphQueryNode>();
  const orderedGroups = groups.map(group =>
    [...group].sort((left, right) => right.score - left.score || compareCodeUnits(left.id, right.id)),
  );
  for (const group of orderedGroups) {
    const representative = group.find(node => !selected.has(node.id));
    if (representative) selected.set(representative.id, representative);
    if (selected.size >= limit) return [...selected.values()];
  }
  const extras = orderedGroups
    .flat()
    .sort((left, right) => right.score - left.score || compareCodeUnits(left.id, right.id));
  for (const node of extras) {
    if (!selected.has(node.id)) selected.set(node.id, node);
    if (selected.size >= limit) break;
  }
  return [...selected.values()];
}

const recoverDeletedImpactSeeds = Effect.fn('codeGraph.recoverDeletedImpactSeeds')(function* (
  store: CodeGraphStoreShape,
  databasePath: string,
  currentSnapshotId: string,
  baseSnapshotId: string,
  paths: readonly string[],
  allowedProvenances: readonly CodeGraphProvenance[],
  depth: number,
  deadline: number,
) {
  const baseGroups = yield* store.searchSymbolsByPaths(
    databasePath,
    baseSnapshotId,
    paths,
    MAX_IMPACT_SYMBOLS_PER_SEED_QUERY,
  );
  if (yield* deadlineReached(deadline)) {
    return {
      nodes: [],
      recoveredPaths: 0,
      remainingDepthById: new Map<string, number>(),
      timedOut: true,
      truncated: false,
    };
  }
  const roots = fairImpactSeeds(baseGroups, MAX_IMPACT_RECOVERY_ROOTS);
  const rootIds = new Set(roots.map(node => node.id));
  const pathIndexesByNode = new Map<string, Set<number>>();
  for (const [pathIndex, group] of baseGroups.entries()) {
    for (const node of group) {
      if (!rootIds.has(node.id)) continue;
      const indexes = pathIndexesByNode.get(node.id) ?? new Set<number>();
      indexes.add(pathIndex);
      pathIndexesByNode.set(node.id, indexes);
    }
  }
  let frontier = [...rootIds];
  const recoveredNodes = new Map<string, CodeGraphQueryNode>();
  const remainingDepthById = new Map<string, number>();
  const recoveredPathIndexes = new Set<number>();
  let inspectedEdges = 0;
  let truncated = false;
  for (
    let currentDepth = 0;
    currentDepth < depth &&
    frontier.length > 0 &&
    recoveredNodes.size < MAX_IMPACT_SEED_SYMBOLS &&
    inspectedEdges < MAX_IMPACT_ANALYSIS_EDGES;
    currentDepth += 1
  ) {
    if (yield* deadlineReached(deadline)) {
      return {
        nodes: [],
        recoveredPaths: 0,
        remainingDepthById: new Map<string, number>(),
        timedOut: true,
        truncated,
      };
    }
    const adjacent: CodeGraphEdge[] = [];
    for (let offset = 0; offset < frontier.length && inspectedEdges + adjacent.length < MAX_IMPACT_ANALYSIS_EDGES;) {
      const frontierBatch = frontier.slice(offset, offset + MAX_STORE_ADJACENCY_NODE_IDS);
      offset += frontierBatch.length;
      const remainingEdges = MAX_IMPACT_ANALYSIS_EDGES - inspectedEdges - adjacent.length;
      const batch = yield* store.edgesForNodes(
        databasePath,
        baseSnapshotId,
        frontierBatch,
        'incoming',
        Math.min(MAX_STORE_ADJACENCY_EDGES, remainingEdges),
        allowedProvenances,
      );
      adjacent.push(...batch);
      if (batch.length >= Math.min(MAX_STORE_ADJACENCY_EDGES, remainingEdges)) truncated = true;
      if (yield* deadlineReached(deadline)) {
        return {
          nodes: [],
          recoveredPaths: 0,
          remainingDepthById: new Map<string, number>(),
          timedOut: true,
          truncated,
        };
      }
    }
    if (inspectedEdges + adjacent.length >= MAX_IMPACT_ANALYSIS_EDGES && frontier.length > 0) truncated = true;
    inspectedEdges += adjacent.length;
    const next: string[] = [];
    for (const edge of adjacent) {
      if (!edge.sourceId || !edge.targetId) continue;
      const pathIndexes = pathIndexesByNode.get(edge.targetId);
      if (!pathIndexes) continue;
      const knownIndexes = pathIndexesByNode.get(edge.sourceId) ?? new Set<number>();
      for (const index of pathIndexes) knownIndexes.add(index);
      if (!pathIndexesByNode.has(edge.sourceId)) next.push(edge.sourceId);
      pathIndexesByNode.set(edge.sourceId, knownIndexes);
    }
    const fairNext = fairImpactNodeIds(next, pathIndexesByNode, paths.length, MAX_IMPACT_SEED_SYMBOLS);
    if (fairNext.length < new Set(next).size) truncated = true;
    const current = yield* store.symbolsByIds(databasePath, currentSnapshotId, fairNext);
    if (yield* deadlineReached(deadline)) {
      return {
        nodes: [],
        recoveredPaths: 0,
        remainingDepthById: new Map<string, number>(),
        timedOut: true,
        truncated,
      };
    }
    const currentIds = new Set(current.map(node => node.id));
    for (const node of current) {
      recoveredNodes.set(node.id, {...node, score: 0.9 / (currentDepth + 1)});
      remainingDepthById.set(node.id, depth - currentDepth - 1);
      for (const index of pathIndexesByNode.get(node.id) ?? []) recoveredPathIndexes.add(index);
    }
    frontier = fairNext.filter(id => !currentIds.has(id));
  }
  const orderedRecoveredIds = fairImpactNodeIds(
    [...recoveredNodes.keys()],
    pathIndexesByNode,
    paths.length,
    MAX_IMPACT_SEED_SYMBOLS,
  );
  return {
    nodes: orderedRecoveredIds.map(id => recoveredNodes.get(id)!),
    recoveredPaths: recoveredPathIndexes.size,
    remainingDepthById,
    timedOut: false,
    truncated,
  };
});

function fairImpactNodeIds(
  ids: readonly string[],
  pathIndexesByNode: ReadonlyMap<string, ReadonlySet<number>>,
  pathCount: number,
  limit: number,
): readonly string[] {
  const unique = [...new Set(ids)];
  const selected = new Set<string>();
  for (let pathIndex = 0; pathIndex < pathCount && selected.size < limit; pathIndex += 1) {
    const representative = unique.find(id => pathIndexesByNode.get(id)?.has(pathIndex) && !selected.has(id));
    if (representative) selected.add(representative);
  }
  for (const id of unique) {
    if (selected.size >= limit) break;
    selected.add(id);
  }
  return [...selected];
}

const deadlineReached = Effect.fn('codeGraph.deadlineReached')(function* (deadline: number) {
  return (yield* Clock.currentTimeMillis) >= deadline;
});

const inspectReadyGraph = Effect.fn('codeGraph.inspectReadyGraph')(function* (input: {
  readonly baseSnapshotId?: string;
  readonly borrowedSnapshotId?: string;
  readonly deferWorktreeObservation: boolean;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly expectedRepositoryId: string;
  readonly layout: CodeGraphLayout;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly observation?: {
    readonly identity: RepositoryIdentity;
    readonly overlay?: {readonly dirty: boolean; readonly fingerprint?: string};
  };
  readonly options: CodeGraphInspectOptions;
  readonly projectScope?: CodeGraphQueryScope;
  readonly projectScopeReceipt?: CodeGraphQueryScopeReceipt;
  readonly store: CodeGraphStoreShape;
  readonly strictFreshness: boolean;
}) {
  const identity =
    input.observation?.identity ??
    (yield* withCodeGraphQueryTelemetryStage(
      input.options.telemetry,
      'graph.query.execute',
      'query-repository-identity',
      resolveRepositoryIdentity(input.options.cwd),
      'fallback',
    ));
  if (identity.repositoryId !== input.expectedRepositoryId) {
    return yield* CodeGraphRepositoryError.make({
      message: 'Repository identity changed while waiting for the graph lock.',
    });
  }
  const overlay =
    input.observation?.overlay ??
    (input.deferWorktreeObservation || input.projectScopeReceipt !== undefined
      ? undefined
      : yield* withCodeGraphQueryTelemetryStage(
          input.options.telemetry,
          'graph.query.execute',
          'query-worktree-observation',
          observeWorktree(identity, input.options.interlock),
          'fallback',
        ));
  const read = Effect.gen(function* () {
    const {snapshot: storedSnapshot, incompatibleSnapshotObserved} = yield* selectCompatibleReadyCodeGraphSnapshot({
      borrowedSnapshotId: input.borrowedSnapshotId,
      databasePath: input.layout.databasePath,
      identity,
      projectScope: input.projectScopeReceipt,
      store: input.store,
    });
    if (!storedSnapshot) {
      return yield* CodeGraphSnapshotUnavailable.make({
        message: incompatibleSnapshotObserved
          ? 'The ready graph has a different project definition or dependency closure. Rebuild the selected project graph.'
          : 'No ready native code graph snapshot exists. Run `threadnote graph index` first.',
      });
    }
    const snapshot = {...storedSnapshot, worktreeId: identity.worktreeId};
    const runtimeCurrent = yield* codeGraphSnapshotRuntimeCurrent(
      input.store,
      input.layout.databasePath,
      snapshot,
      input.languagePacks,
      overlay === undefined || input.projectScopeReceipt !== undefined ? undefined : {layout: input.layout, identity},
    );
    yield* input.options.interlock?.afterSnapshotSelected?.() ?? Effect.void;
    const nodeLimit = boundedInteger(input.options.nodeLimit, 20, 1, 200);
    const edgeLimit = boundedInteger(input.options.edgeLimit, 40, 1, 500);
    const depth = boundedInteger(
      input.options.depth,
      input.options.operation === 'impact' ? 3 : input.options.operation === 'neighbors' ? 1 : 2,
      0,
      8,
    );
    const allowedProvenances = selectedProvenances(input.options);
    const outsidePaths = input.options.deferProjectScopePresentation
      ? []
      : outsideCodeGraphProjectPaths(input.options, input.projectScope?.scope);
    const scopedSeedQueries = input.options.seedQueries?.filter(
      candidate =>
        input.options.deferProjectScopePresentation || codeGraphScopeAdmitsPath(input.projectScope?.scope, candidate),
    );
    const selected = yield* outsidePaths.length > 0 ||
    (scopedSeedQueries !== undefined && scopedSeedQueries.length === 0)
      ? Effect.succeed({nodes: [], edges: [], warnings: []})
      : (() => {
          switch (input.options.operation) {
            case 'node':
              return exactNodeQuery(
                input.store,
                input.layout.databasePath,
                snapshot.id,
                required(input.options.nodeId, 'node-id'),
              );
            case 'neighbors':
              return neighborQuery(
                input.store,
                input.layout.databasePath,
                snapshot.id,
                required(input.options.nodeId, 'node-id'),
                input.options.direction ?? 'both',
                nodeLimit,
                edgeLimit,
                depth,
                allowedProvenances,
              );
            case 'path':
              return pathQuery(
                input.store,
                input.layout.databasePath,
                snapshot.id,
                required(input.options.from, 'from'),
                required(input.options.to, 'to'),
                nodeLimit,
                edgeLimit,
                depth,
                allowedProvenances,
              );
            case 'impact':
              return traversalQuery(
                input.store,
                input.layout.databasePath,
                snapshot.id,
                required(input.options.query ?? input.options.symbol, 'query'),
                'incoming',
                nodeLimit,
                edgeLimit,
                depth,
                allowedProvenances,
                input.embedding,
                input.options.threadnoteHome,
                input.layout,
                true,
                scopedSeedQueries,
                impactBaseSnapshotId(snapshot, input.options, input.baseSnapshotId),
                undefined,
                undefined,
                input.options.seedQueryCount,
              );
            case 'explain':
              return traversalQuery(
                input.store,
                input.layout.databasePath,
                snapshot.id,
                required(input.options.symbol ?? input.options.query, 'symbol'),
                'both',
                nodeLimit,
                edgeLimit,
                Math.max(1, depth),
                allowedProvenances,
                input.embedding,
                input.options.threadnoteHome,
                input.layout,
                false,
                undefined,
                undefined,
              );
            case 'query':
              return traversalQuery(
                input.store,
                input.layout.databasePath,
                snapshot.id,
                required(input.options.query, 'query'),
                'both',
                nodeLimit,
                edgeLimit,
                Math.min(1, depth),
                allowedProvenances,
                input.embedding,
                input.options.threadnoteHome,
                input.layout,
                false,
                undefined,
                undefined,
                {},
                input.options.packageName,
              );
          }
        })();
    const safeSelection = sanitizeSelection(selected);
    const finalObservation = input.strictFreshness
      ? yield* withCodeGraphQueryTelemetryStage(
          input.options.telemetry,
          'graph.query.execute',
          'query-strict-reobservation',
          Effect.gen(function* () {
            const strictIdentity = yield* resolveRepositoryIdentity(input.options.cwd);
            if (
              strictIdentity.repositoryId !== input.expectedRepositoryId ||
              strictIdentity.worktreeId !== identity.worktreeId
            ) {
              return yield* CodeGraphRepositoryError.make({
                message: 'Repository identity changed during the graph read.',
              });
            }
            return {
              identity: strictIdentity,
              overlay:
                input.projectScopeReceipt !== undefined
                  ? undefined
                  : yield* observeWorktree(strictIdentity, input.options.interlock),
            };
          }),
        )
      : yield* skipCodeGraphQueryTelemetryStage(
          input.options.telemetry,
          'graph.query.execute',
          'query-strict-reobservation',
        ).pipe(Effect.as({identity, overlay}));
    const finalIdentity = finalObservation.identity;
    const finalOverlay = finalObservation.overlay;
    const finalScope =
      input.projectScopeReceipt !== undefined && input.strictFreshness
        ? yield* observeCodeGraphQueryScope(
            input.options.threadnoteHome,
            input.options.cwd,
            finalIdentity,
            input.languagePacks,
            input.options,
          )
        : input.projectScope;
    const finalScopeReceipt = codeGraphQueryScopeReceipt(finalScope) ?? input.projectScopeReceipt;
    const scopeCurrent =
      finalScopeReceipt !== undefined &&
      (yield* codeGraphQueryScopeCurrent(
        finalScopeReceipt,
        input.store,
        input.layout,
        snapshot,
        finalIdentity,
        input.languagePacks,
      ));
    if (
      input.strictFreshness &&
      !(yield* codeGraphQueryScopeSnapshotCompatible(
        finalScopeReceipt,
        input.store,
        input.layout.databasePath,
        finalIdentity.worktreeId,
        snapshot,
        true,
      ))
    ) {
      return yield* CodeGraphSnapshotUnavailable.make({
        message: 'The selected project definition or dependency closure changed during the graph read.',
      });
    }
    const admissionCurrent =
      input.projectScopeReceipt !== undefined
        ? scopeCurrent
        : !input.strictFreshness ||
          (yield* codeGraphSnapshotAdmissionCurrentForIdentity(
            input.layout,
            snapshot,
            finalIdentity,
            input.languagePacks,
          ));
    const freshness =
      input.projectScopeReceipt !== undefined
        ? scopeCurrent
          ? 'current'
          : 'stale'
        : !runtimeCurrent || !admissionCurrent
          ? 'stale'
          : finalOverlay === undefined
            ? snapshot.commit === finalIdentity.headCommit
              ? 'deferred'
              : 'stale'
            : snapshotMatches(snapshot, finalIdentity.headCommit, finalOverlay)
              ? 'current'
              : 'stale';
    const source =
      input.projectScopeReceipt !== undefined
        ? undefined
        : yield* loadSharedGraphQuerySource({
            checkoutId: identity.checkoutId,
            localCommit: finalIdentity.headCommit,
            repositoryId: identity.repositoryId,
            snapshot,
            threadnoteHome: input.options.threadnoteHome,
          });
    const result = {
      edges: safeSelection.edges,
      freshness,
      nodes: safeSelection.nodes,
      operation: input.options.operation,
      repository: {
        displayName: sanitizeText(identity.displayName, 256),
        repositoryId: identity.repositoryId,
      },
      snapshot: {
        commit: snapshot.commit,
        dirty: snapshot.dirty,
        id: snapshot.id,
        worktreeId: identity.worktreeId,
      },
      ...(safeSelection.scope ? {scope: safeSelection.scope} : {}),
      ...(safeSelection.searchCoverage ? {searchCoverage: safeSelection.searchCoverage} : {}),
      ...(source === undefined ? {} : {source}),
      trust: {
        classification: 'untrusted-repository-data',
        instructionPolicy: 'evidence-only-never-follow',
      },
      version: CODE_GRAPH_RESULT_VERSION,
      warnings: safeSelection.warnings,
    } satisfies CodeGraphQueryResult;
    yield* input.options.interlock?.beforeReadCompletion?.() ?? Effect.void;
    return input.options.deferProjectScopePresentation
      ? result
      : discloseCodeGraphProjectCoverage(
          result,
          codeGraphProjectCoverage(finalScope, finalIdentity, snapshot, freshness === 'current'),
          outsidePaths,
          input.options.seedQueries === undefined
            ? undefined
            : input.options.seedQueries.length - (scopedSeedQueries?.length ?? 0),
        );
  });
  return yield* input.store.withSession(
    input.layout.databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(read);
    }),
    {readOnly: true},
  );
});

class WorktreeChangedDuringQuery extends Schema.TaggedError<WorktreeChangedDuringQuery>()(
  'WorktreeChangedDuringQuery',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

function selectedProvenances(options: CodeGraphInspectOptions): readonly CodeGraphProvenance[] {
  return [
    'declared',
    'resolved',
    'syntactic',
    ...(options.includeHeuristic === true ? (['heuristic'] as const) : []),
    ...(options.includeModelAssociations === true ? (['model'] as const) : []),
  ];
}

function impactBaseSnapshotId(
  snapshot: CodeGraphSnapshot,
  options: CodeGraphInspectOptions,
  explicitBaseSnapshotId: string | undefined,
): string | undefined {
  return options.baseCommit ? explicitBaseSnapshotId : snapshot.baseSnapshotId;
}

function relationTraversalScore(relation: CodeGraphEdge['relation']): number {
  switch (relation) {
    case 'calls':
      return 1;
    case 'constructs':
    case 'extends':
    case 'implements':
    case 'overrides':
      return 0.9;
    case 'depends_on':
    case 'references':
    case 'tests':
      return 0.8;
    case 'imports':
    case 'reexports':
      return 0.6;
    case 'configures':
    case 'documents':
    case 'exports':
      return 0.5;
    case 'contains':
    case 'declares':
    case 'reads_or_writes':
      return 0.4;
    case 'semantic_association':
      return 0.2;
  }
}

function adjacentNodeIds(
  edge: CodeGraphEdge,
  direction: 'both' | 'incoming' | 'outgoing',
  frontier: ReadonlyMap<string, number>,
): readonly string[] {
  if (direction === 'incoming')
    return edge.targetId && frontier.has(edge.targetId) && edge.sourceId ? [edge.sourceId] : [];
  if (direction === 'outgoing')
    return edge.sourceId && frontier.has(edge.sourceId) && edge.targetId ? [edge.targetId] : [];
  const adjacent: string[] = [];
  if (edge.sourceId && frontier.has(edge.sourceId) && edge.targetId) adjacent.push(edge.targetId);
  if (edge.targetId && frontier.has(edge.targetId) && edge.sourceId) adjacent.push(edge.sourceId);
  return adjacent;
}

export const exactNodeQuery = Effect.fn('codeGraph.exactNodeQuery')(function* (
  store: CodeGraphStoreShape,
  databasePath: string,
  snapshotId: string,
  nodeId: string,
) {
  const symbols = yield* store.symbolsByIds(databasePath, snapshotId, [nodeId]);
  const symbol = symbols.find(candidate => candidate.id === nodeId);
  return symbol
    ? {edges: [], nodes: [{...symbol, score: 1}], warnings: []}
    : {edges: [], nodes: [], warnings: [`Code graph node "${nodeId}" was not found in the selected snapshot.`]};
});

export const neighborQuery = Effect.fn('codeGraph.neighborQuery')(function* (
  store: CodeGraphStoreShape,
  databasePath: string,
  snapshotId: string,
  nodeId: string,
  direction: 'both' | 'incoming' | 'outgoing',
  nodeLimit: number,
  edgeLimit: number,
  depth: number,
  allowedProvenances: readonly CodeGraphProvenance[],
) {
  const deadline = (yield* Clock.currentTimeMillis) + QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS;
  const initial = yield* exactNodeQuery(store, databasePath, snapshotId, nodeId);
  const seed = initial.nodes[0];
  if (!seed) return initial;

  const nodes = new Map<string, CodeGraphQueryNode>([[seed.id, seed]]);
  const edges = new Map<string, CodeGraphEdge>();
  const visited = new Set<string>([seed.id]);
  let frontier = [seed.id];
  let inspectedEdges = 0;
  let limited = false;
  let timedOut = false;

  for (let currentDepth = 0; currentDepth < depth && frontier.length > 0; currentDepth += 1) {
    if (nodes.size >= nodeLimit || inspectedEdges >= edgeLimit) {
      limited = true;
      break;
    }
    if (yield* deadlineReached(deadline)) {
      timedOut = true;
      break;
    }
    const remainingEdges = edgeLimit - inspectedEdges;
    const adjacent = yield* store.edgesForNodes(
      databasePath,
      snapshotId,
      frontier,
      direction,
      remainingEdges,
      allowedProvenances,
    );
    inspectedEdges += adjacent.length;
    if (adjacent.length >= remainingEdges) limited = true;
    if (yield* deadlineReached(deadline)) {
      timedOut = true;
      break;
    }

    const frontierDepths = new Map(frontier.map(id => [id, currentDepth] as const));
    const candidateIds = [
      ...new Set(
        adjacent.flatMap(edge => adjacentNodeIds(edge, direction, frontierDepths)).filter(id => !visited.has(id)),
      ),
    ];
    const remainingNodes = nodeLimit - nodes.size;
    if (candidateIds.length > remainingNodes) limited = true;
    const selectedIds = candidateIds.slice(0, remainingNodes);
    const hydrated = yield* store.symbolsByIds(databasePath, snapshotId, selectedIds);
    if (yield* deadlineReached(deadline)) {
      timedOut = true;
      break;
    }
    const selectedIdSet = new Set(selectedIds);
    const next = hydrated.filter(symbol => selectedIdSet.has(symbol.id) && !visited.has(symbol.id));
    for (const symbol of next) {
      visited.add(symbol.id);
      nodes.set(symbol.id, {...symbol, score: 1 / (currentDepth + 2)});
    }
    const visibleIds = new Set(nodes.keys());
    for (const edge of adjacent) {
      if (edge.sourceId && edge.targetId && visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId)) {
        edges.set(edge.id, edge);
      }
    }
    frontier = next.map(symbol => symbol.id);
  }

  const warnings: string[] = [];
  if (timedOut) warnings.push('Neighbor traversal reached its elapsed-time budget; results are partial.');
  else if (limited) warnings.push('Neighbor traversal reached a configured result limit.');
  return {edges: [...edges.values()], nodes: [...nodes.values()], warnings};
});

export {renderCodeGraphResult, type CodeGraphRenderTarget} from './query/render.js';

/**
 * Shared-ready attachment has not changed the target view when either of
 * these failures is reported. Keep this deliberately narrower than generic
 * retryable storage failures: reconnect, corruption, permission, schema, and
 * unknown failures must remain visible to the caller.
 */
function isPreWriteSharedReadyAttachFailure(cause: unknown): boolean {
  return Schema.is(CodeGraphStoreBusyError)(cause) || isCodeGraphCapacityPause(cause);
}

function sanitizeSelection(selection: {
  readonly edges: readonly CodeGraphEdge[];
  readonly nodes: readonly CodeGraphQueryNode[];
  readonly scope?: CodeGraphQueryResult['scope'];
  readonly searchCoverage?: CodeGraphQueryResult['searchCoverage'];
  readonly warnings: readonly string[];
}): {
  readonly edges: readonly CodeGraphEdge[];
  readonly nodes: readonly CodeGraphQueryNode[];
  readonly scope?: CodeGraphQueryResult['scope'];
  readonly searchCoverage?: CodeGraphQueryResult['searchCoverage'];
  readonly warnings: readonly string[];
} {
  const nodes = selection.nodes.map(node => ({
    ...node,
    documentation: node.documentation ? sanitizeText(node.documentation, 2_048) : undefined,
    id: sanitizeText(node.id, 256),
    kind: sanitizeText(node.kind, 128),
    language: sanitizeText(node.language, 128),
    name: sanitizeText(node.name, 256),
    packageName: node.packageName ? sanitizeText(node.packageName, 256) : undefined,
    path: sanitizeText(node.path, 1_024),
    qualifiedName: sanitizeText(node.qualifiedName, 512),
    signature: node.signature ? sanitizeText(node.signature, 1_024) : undefined,
  }));
  const edges = selection.edges.map(edge => ({
    ...edge,
    evidencePath: sanitizeText(edge.evidencePath, 1_024),
    id: sanitizeText(edge.id, 256),
    sourceId: edge.sourceId ? sanitizeText(edge.sourceId, 256) : undefined,
    sourceName: sanitizeText(edge.sourceName, 256),
    targetId: edge.targetId ? sanitizeText(edge.targetId, 256) : undefined,
    targetName: sanitizeText(edge.targetName, 256),
  }));
  const warnings = selection.warnings.map(warning => sanitizeText(warning, 1_024));
  const acceptedNodes: CodeGraphQueryNode[] = [];
  const acceptedEdges: CodeGraphEdge[] = [];
  let bytes = 0;
  let truncated = false;
  for (const node of nodes) {
    const size = encodedSize(node);
    if (bytes + size > CODE_GRAPH_RESULT_MAX_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    acceptedNodes.push(node);
  }
  for (const edge of edges) {
    const size = encodedSize(edge);
    if (bytes + size > CODE_GRAPH_RESULT_MAX_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    acceptedEdges.push(edge);
  }
  return {
    edges: acceptedEdges,
    nodes: acceptedNodes,
    ...(selection.scope
      ? {scope: {...selection.scope, packageName: sanitizeText(selection.scope.packageName, 256)}}
      : {}),
    ...(selection.searchCoverage ? {searchCoverage: selection.searchCoverage} : {}),
    warnings: truncated ? [...warnings, 'Graph result reached its output byte budget; results are partial.'] : warnings,
  };
}

function encodedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`Code graph ${name} is required.`);
  return trimmed;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Code graph limit must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
export const QUERY_SEMANTIC_TIME_BUDGET_MILLISECONDS = 10_000;
const CODE_GRAPH_RESULT_MAX_BYTES = 256 * 1_024;
const MAX_IMPACT_ANALYSIS_EDGES = 5_000;
const MAX_IMPACT_SEED_QUERIES = 200;
const MAX_IMPACT_SEED_SYMBOLS = 200;
const MAX_IMPACT_SYMBOLS_PER_SEED_QUERY = 20;
const MAX_IMPACT_RECOVERY_ROOTS = MAX_IMPACT_SEED_QUERIES * MAX_IMPACT_SYMBOLS_PER_SEED_QUERY;
const MAX_STORE_ADJACENCY_NODE_IDS = 500;
const MAX_STORE_ADJACENCY_EDGES = 500;
