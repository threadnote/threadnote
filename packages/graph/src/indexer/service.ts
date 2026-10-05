import {Clock, Context, Crypto, Effect, Exit, FileSystem, Layer, Option, Path, Schema} from 'effect';
import * as HttpClient from 'effect/http/HttpClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CommandExecutor} from '@threadnote/platform/command';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {
  codeGraphSnapshotAdmissionCurrent,
  observeCodeGraphAdmissionEnvironment,
  recordCodeGraphSnapshotAdmission,
} from '../admission_freshness.js';
import {assessCodeGraphScopeApplicability, codeGraphScopeAdmissionEvidence} from '../scope/applicability.js';
import {codeGraphScopeIdentityCompatible} from '../scope/identity.js';
import {makeCodeGraphBuildReporter, type CodeGraphBuildReporter} from '../build_status.js';
import {CODE_GRAPH_BUILDER_ADMISSION_CLASS_ENV, withCodeGraphBuilderAdmission} from '../builder/admission.js';
import type {CodeGraphBuilderAdmissionQueue} from '../builder/admission_scheduler.js';
import {makeCodeGraphBuildResourceCoordinator} from '../build/resources.js';
import {isNonResumableCodeGraphBuildFailure} from '../disk/capacity.js';
import {CodeGraphEmbeddingIndex} from '../embedding.js';
import {
  attemptReusableDirtyBase,
  buildAndActivate,
  buildOwnedCleanSnapshot,
  CODE_GRAPH_INTERRUPTED_BUILD_SUMMARY,
  codeGraphBuildRequestKey,
  ensureCommittedBase,
  retiredSnapshotCleanupReporter,
  reuseReadySnapshot,
  settleInterruptedCodeGraphBuild,
  withCodeGraphProcessLock,
  writerSessionOptions,
} from './build.js';
import {withSharedCodeGraphRequestGate} from './request/gate.js';
import {completedConcurrentSnapshot} from './concurrent_snapshot.js';
import {assessIncrementalOverlay, assessIncrementalOverlayCompatibility} from './incremental.js';
import {attemptSparseReusableOverlay} from './sparse.js';
import {
  cacheContentBatch,
  CODE_GRAPH_LOCK_OPTIONS,
  cachedFileKeys,
  codeGraphDirectPersistentCapacityProtector,
  directFullSnapshotIdentity,
  extractorSetIdentity,
  firstReadySnapshotById,
  forcedSnapshotIdentity,
  graphContentIdentity,
  messageOf,
  promoteReadySnapshotWithCapacity,
  reusableReadySnapshotForCleanCommit,
  snapshotIdentity,
  sparseOverlayGraphContentIdentity,
  verifyIndexInput,
} from './materialization.js';
import {
  CachedCodeGraphFactUnavailableDuringIndex,
  CodeGraphIndexOperationError,
  RepositoryMaintenanceInterrupted,
  RepositoryRegistrationLost,
  sameOverlayState,
  WorktreeChangedDuringIndex,
} from './shared.js';
import type {
  CodeGraphCommitLease,
  CodeGraphIndexerShape,
  CodeGraphIndexOptions,
  CommittedBaseResult,
  DirectPersistentCapacityProtection,
  IncrementalOverlayAssessment,
  IncrementalOverlayPreassessment,
  CodeGraphIndexResourceGate,
  CodeGraphPreparedSpoolBudgetGate,
} from './types.js';
import {codeGraphIndexEnsuresVectors} from './types.js';
import type {BoundedCodeGraphFact} from '../fact/budget.js';
import {
  type CodeGraphInventory,
  type CodeGraphOverlayObservation,
  codeGraphInventoryScopeEvidence,
  inventoryRepository,
  inventoryRepositoryFromReusableCleanBase,
  observeCodeGraphIndexScope,
  worktreeBuildRequestObservation,
} from '../inventory.js';
import {CodeGraphLanguagePackRegistry} from '../languages/registry.js';
import {codeGraphLayout} from '../layout.js';
import {runCodeGraphLifecycleOpportunity} from '../lifecycle/opportunity.js';
import {resolveAndRecordCodeGraphLocalAssociation} from '../local_provenance.js';
import {CodeGraphMaintenanceCoordinator} from '../maintenance/coordinator.js';
import {
  adoptCodeGraphBackgroundDemand,
  beginCodeGraphBackgroundPublication,
  codeGraphRefreshDemandFromEnvironment,
  CodeGraphRefreshDemandSuperseded,
} from '../refresh/demand.js';
import {codeGraphMaintenanceIntentActive, withCodeGraphMaintenanceRegistration} from '../maintenance/gate.js';
import {CodeGraphParserPool, warmPlannedParserCapacity} from '../parser_worker.js';
import {withCodeGraphPreparedSpoolBudget} from '../prepared_spool_budget.js';
import {repositoryIdentityMatchesExpectation, resolveRepositoryIdentity} from '../repository.js';
import {captureSharedGraphImportBase} from '../sharing/client.js';
import {
  drainQueuedGraphShareContributions,
  enqueueLocalGraphShareParseResults,
  hydrateSharedParseCache,
} from '../sharing/parse/cache.js';
import {graphShareEnrollmentPath} from '../sharing/layout.js';
import {finalizeGraphShareSignedCandidates} from '../sharing/signed/candidate.js';
import {CodeGraphStore} from '../store.js';
import {TreeSitterRuntime} from '../tree_sitter/runtime.js';
import type {CodeGraphIndexSummary, CodeGraphInventoryFile, CodeGraphProgress, CodeGraphSnapshot} from '../types.js';
import {
  CodeGraphObservability,
  CodeGraphProcessActivity,
  type CodeGraphBuildAnonymousTelemetryReporter,
  withCodeGraphBuildAnonymousTelemetry,
} from '../runtime_ports.js';

export class CodeGraphIndexer extends Context.Service<CodeGraphIndexer, CodeGraphIndexerShape>()(
  '@threadnote/graph/indexer/service/CodeGraphIndexer',
) {
  static readonly layer = Layer.effect(
    CodeGraphIndexer,
    Effect.gen(function* () {
      const observability = yield* CodeGraphObservability;
      const processActivity = yield* CodeGraphProcessActivity;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const maintenance = yield* CodeGraphMaintenanceCoordinator;
      const embedding = yield* CodeGraphEmbeddingIndex;
      const languagePacks = yield* CodeGraphLanguagePackRegistry;
      const treeSitter = yield* TreeSitterRuntime;
      const parserPool = yield* CodeGraphParserPool;
      const command = yield* CommandExecutor;
      const crypto = yield* Crypto.Crypto;
      const system = yield* SystemInfo;
      const http = yield* HttpClient.HttpClient;
      const releaseIdentity = yield* getThreadnoteVersion();
      const makeBuildResourceGates = Effect.fn('codeGraph.indexer.makeBuildResourceGates')(function* (input: {
        readonly admissionClass: ReturnType<typeof codeGraphBuilderAdmissionClass>;
        readonly checkoutId: string;
        readonly desiredOverlayDigest?: string;
        readonly onProgress?: CodeGraphIndexOptions['onProgress'];
        readonly reporter: CodeGraphBuildReporter;
        readonly resumeProgress: () => Effect.Effect<void, unknown>;
        readonly requestKey?: string;
        readonly threadnoteHome: string;
        readonly worktreeId: string;
      }) {
        const resources = yield* makeCodeGraphBuildResourceCoordinator(input.reporter.resource);
        let latestAdmissionQueue: CodeGraphBuilderAdmissionQueue | undefined;
        const admissionOptions = {
          admissionClass: input.admissionClass,
          identity: {
            checkoutId: input.checkoutId,
            worktreeId: input.worktreeId,
            ...(input.requestKey === undefined ? {} : {requestKey: input.requestKey}),
            ...(input.desiredOverlayDigest === undefined ? {} : {desiredOverlayDigest: input.desiredOverlayDigest}),
          },
          onQueue: (queue: CodeGraphBuilderAdmissionQueue) =>
            Effect.sync(() => {
              latestAdmissionQueue = queue;
            }).pipe(Effect.andThen(input.reporter.admission(queue)), Effect.ignore),
          onAdmitted: input.reporter.admission().pipe(Effect.ignore),
          onResumed: Effect.suspend(input.resumeProgress).pipe(Effect.ignore),
          onWaiting: Effect.suspend(() =>
            (
              input.onProgress?.({
                ...(latestAdmissionQueue === undefined ? {} : {admission: latestAdmissionQueue}),
                phase: 'waiting',
                reason: 'home-builder-cap',
              }) ?? Effect.void
            ).pipe(Effect.ignore),
          ),
          threadnoteHome: input.threadnoteHome,
        } as const;
        const admit: CodeGraphIndexResourceGate = effect =>
          withCodeGraphBuilderAdmission(admissionOptions, effect).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, system),
            Effect.provideService(CodeGraphProcessActivity, processActivity),
          );
        const legacyBuildAdmission: CodeGraphIndexResourceGate = effect =>
          admit(
            Effect.acquireUseRelease(
              resources.acquireLegacyBuilder,
              () => effect,
              () => resources.releaseLegacyBuilder,
            ),
          );
        const preparationGate: CodeGraphIndexResourceGate = effect =>
          admit(
            Effect.acquireUseRelease(
              resources.acquirePreparation,
              () => effect,
              () => resources.releasePreparation,
            ),
          );
        const extractionPreparationGate: CodeGraphIndexResourceGate = effect =>
          resources.current.pipe(Effect.flatMap(current => (current.legacyBuilder ? effect : preparationGate(effect))));
        const preparedSpoolBudgetGate: CodeGraphPreparedSpoolBudgetGate = (bytes, snapshotId, effect) =>
          withCodeGraphPreparedSpoolBudget(
            {
              bytes,
              checkoutId: input.checkoutId,
              onWaiting: (input.onProgress?.({phase: 'waiting', reason: 'prepared-spool-budget'}) ?? Effect.void).pipe(
                Effect.ignore,
              ),
              snapshotId,
              threadnoteHome: input.threadnoteHome,
            },
            Effect.acquireUseRelease(
              resources.acquirePreparedSpool(bytes),
              () => effect,
              () => resources.releasePreparedSpool(bytes),
            ),
          ).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, system),
            Effect.provideService(CodeGraphProcessActivity, processActivity),
          );
        return {
          extractionPreparationGate,
          legacyBuildAdmission,
          preparationGate,
          preparedSpoolBudgetGate,
          resources,
        } as const;
      });
      const enqueueSharedParserBatch = (
        identity: {readonly headCommit: string; readonly repositoryId: string},
        threadnoteHome: string,
        group: {
          readonly cacheIdentity: string;
          readonly facts: readonly BoundedCodeGraphFact[];
          readonly files: readonly CodeGraphInventoryFile[];
        },
        producer: {
          readonly platform: {readonly os: string; readonly architecture: string};
          readonly releaseIdentity: string;
        },
      ) =>
        enqueueLocalGraphShareParseResults({
          extractorSet: group.cacheIdentity,
          facts: group.facts,
          files: group.files,
          identity,
          producer,
          threadnoteHome,
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
          Effect.provideService(CodeGraphProcessActivity, processActivity),
          Effect.asVoid,
        );
      const indexAttempt = (
        request: CodeGraphIndexOptions,
        anonymousTelemetry: CodeGraphBuildAnonymousTelemetryReporter,
        attempt = 0,
        bypassCachedFacts = false,
      ): Effect.Effect<CodeGraphIndexSummary, unknown> =>
        Effect.scoped(
          Effect.gen(function* () {
            const initialIdentity = yield* resolveRepositoryIdentity(request.cwd);
            const producer = {
              platform: {
                architecture: system.architecture === 'aarch64' ? 'arm64' : system.architecture,
                os: system.platform,
              },
              releaseIdentity,
            };
            const admissionEnvironment = yield* observeCodeGraphAdmissionEnvironment(initialIdentity);
            const ensureVectors = codeGraphIndexEnsuresVectors(request);
            const scopedObservation =
              request.project?.graph === undefined
                ? undefined
                : yield* inventoryRepository(initialIdentity, {
                    project: request.project,
                    includeOverlay: request.includeOverlay,
                    includeOpaqueCorpusAssets: ensureVectors,
                    languagePacks,
                    scopeObservationOnly: true,
                  });
            const scope = scopedObservation?.scope;
            const scopeEvidence =
              scopedObservation === undefined
                ? undefined
                : codeGraphInventoryScopeEvidence(
                    scopedObservation,
                    initialIdentity,
                    extractorSetIdentity(scopedObservation.files, languagePacks),
                    admissionEnvironment,
                  );
            if (
              request.expectedIdentity &&
              !repositoryIdentityMatchesExpectation(initialIdentity, request.expectedIdentity)
            ) {
              return yield* CodeGraphIndexOperationError.make({
                message: 'Repository identity does not match the requested graph target.',
              });
            }
            const layout = codeGraphLayout(
              path,
              request.threadnoteHome,
              initialIdentity.checkoutId,
              initialIdentity.worktreeId,
              scope?.scopeKey,
            );
            const requestedBuildRequest = yield* worktreeBuildRequestObservation(
              initialIdentity,
              request.threadnoteHome,
              scope,
            ).pipe(Effect.provideService(Crypto.Crypto, crypto));
            const requestedOverlay = requestedBuildRequest.state;
            if (
              request.sourceVerification &&
              (request.force !== true ||
                request.sourceOnly !== true ||
                request.includeOverlay !== false ||
                requestedOverlay.dirty)
            ) {
              return yield* CodeGraphIndexOperationError.make({
                message: 'Source verification requires a clean, forced source-only build without overlays.',
              });
            }
            yield* anonymousTelemetry.observeOverlay(requestedOverlay.dirty);
            // Equivalent scoped observations update only applicability authority: no reporter, builder slot, or fact build.
            if (
              !request.force &&
              scopeEvidence !== undefined &&
              scope !== undefined &&
              (yield* fs.exists(layout.databasePath))
            ) {
              const reused = yield* withExclusiveFileLock(
                fs,
                layout.lockPath,
                CODE_GRAPH_LOCK_OPTIONS,
                Effect.gen(function* () {
                  const active = yield* store.loadScopeApplicability(
                    layout.databasePath,
                    initialIdentity.worktreeId,
                    scope.scopeKey,
                  );
                  if (assessCodeGraphScopeApplicability(active, scopeEvidence).buildRequired || active === undefined)
                    return undefined;
                  const ready = yield* store.readySnapshot(
                    layout.databasePath,
                    initialIdentity.worktreeId,
                    scope.scopeKey,
                  );
                  if (
                    ready === undefined ||
                    ready.id !== active.snapshotId ||
                    !(yield* codeGraphSnapshotAdmissionCurrent(
                      layout,
                      ready,
                      admissionEnvironment,
                      languagePacks,
                      false,
                      codeGraphScopeAdmissionEvidence(active),
                    ))
                  )
                    return undefined;
                  yield* verifyIndexInput(
                    initialIdentity,
                    true,
                    request.threadnoteHome,
                    requestedOverlay,
                    scopedObservation,
                  );
                  if ((yield* observeCodeGraphAdmissionEnvironment(initialIdentity)) !== admissionEnvironment)
                    return undefined;
                  yield* store.recordScopeApplicability(layout.databasePath, ready.id, scopeEvidence, scope);
                  yield* recordCodeGraphSnapshotAdmission(
                    layout,
                    ready,
                    admissionEnvironment,
                    languagePacks,
                    ensureVectors,
                    {scope: codeGraphScopeAdmissionEvidence(scopeEvidence)},
                  );
                  return yield* reuseReadySnapshot({
                    embedding,
                    ensureVectors,
                    identity: initialIdentity,
                    layout,
                    onProgress: request.onProgress,
                    reusedFiles: ready.fileCount,
                    skippedFiles: scopedObservation?.skipped ?? 0,
                    snapshot: ready,
                    startedAt: yield* Clock.currentTimeMillis,
                    store,
                    threadnoteHome: request.threadnoteHome,
                    totalFiles: ready.fileCount,
                  });
                }),
              );
              if (reused !== undefined) return reused;
            }
            const requestKey = request.force
              ? undefined
              : codeGraphBuildRequestKey(
                  initialIdentity,
                  requestedOverlay,
                  languagePacks,
                  request.incrementalOverlay,
                  ensureVectors,
                  admissionEnvironment,
                  scope,
                );
            // A demand token is carried only by an isolated background child.
            // It must adopt the exact observed target before any retry can use it.
            const refreshDemandToken =
              request.refreshDemandToken ?? codeGraphRefreshDemandFromEnvironment(system.environment());
            const refreshDemandIdentity = {
              scopeId: scope?.scopeKey,
              checkoutId: initialIdentity.checkoutId,
              threadnoteHome: request.threadnoteHome,
              worktreeId: initialIdentity.worktreeId,
            };
            if (refreshDemandToken !== undefined) {
              if (
                requestKey === undefined ||
                !(yield* adoptCodeGraphBackgroundDemand(refreshDemandIdentity, refreshDemandToken, requestKey))
              ) {
                return yield* CodeGraphRefreshDemandSuperseded.make({
                  message: 'Code graph refresh demand no longer owns the observed worktree target.',
                });
              }
            }
            let demandPublishing = false;
            const beginDemandPublication = () =>
              demandPublishing
                ? Effect.void
                : refreshDemandToken === undefined || requestKey === undefined
                  ? Effect.void
                  : beginCodeGraphBackgroundPublication(refreshDemandIdentity, refreshDemandToken, requestKey).pipe(
                      Effect.flatMap(result =>
                        result === 'publish'
                          ? Effect.sync(() => {
                              demandPublishing = true;
                            })
                          : CodeGraphRefreshDemandSuperseded.make({
                              message: 'Code graph refresh demand was superseded before publication.',
                            }),
                      ),
                    );
            const reporter = yield* withCodeGraphMaintenanceRegistration(
              request.threadnoteHome,
              Effect.gen(function* () {
                if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                  return yield* CodeGraphIndexOperationError.make({
                    message: 'Code graph repository root is a symbolic link.',
                  });
                }
                yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true, mode: 0o700});
                const reporter = yield* makeCodeGraphBuildReporter(
                  initialIdentity,
                  layout,
                  requestKey ? {key: requestKey} : undefined,
                );
                yield* anonymousTelemetry
                  .progress({phase: 'registering'})
                  .pipe(Effect.andThen(request.onProgress?.({phase: 'registering'}) ?? Effect.void));
                return reporter;
              }),
            );
            yield* Effect.forkScoped(reporter.heartbeat);
            let lastActiveProgress: CodeGraphProgress = {phase: 'registering'};
            const options: CodeGraphIndexOptions = {
              ...request,
              onProgress: progress =>
                Effect.sync(() => {
                  if (progress.phase !== 'waiting') lastActiveProgress = progress;
                }).pipe(
                  Effect.andThen(anonymousTelemetry.progress(progress)),
                  Effect.andThen(reporter.progress(progress)),
                  Effect.andThen(request.onProgress?.(progress) ?? Effect.void),
                ),
            };
            const buildResources = yield* makeBuildResourceGates({
              admissionClass: codeGraphBuilderAdmissionClass(options, system.environment()),
              checkoutId: initialIdentity.checkoutId,
              ...(requestedOverlay.fingerprint
                ? {desiredOverlayDigest: sha256HexSync(requestedOverlay.fingerprint)}
                : {}),
              onProgress: options.onProgress,
              reporter,
              requestKey,
              resumeProgress: () => options.onProgress?.(lastActiveProgress) ?? Effect.void,
              threadnoteHome: options.threadnoteHome,
              worktreeId: initialIdentity.worktreeId,
            });
            if (!options.sourceOnly && (yield* fs.exists(graphShareEnrollmentPath(path, initialIdentity.repoRoot)))) {
              yield* captureSharedGraphImportBase({
                cwd: request.cwd,
                identity: initialIdentity,
                onProgress: options.onProgress,
                threadnoteHome: request.threadnoteHome,
              });
            }
            const capacityProtection: DirectPersistentCapacityProtection = {
              availableDiskBytes:
                options.diskCapacityAvailableBytes ?? ((target: string) => system.availableDiskBytes(target)),
              crypto,
              maintenance,
              path,
              system,
              temporaryDirectory: system.tempDirectory,
              walAutoCheckpointPages: options.sqliteWriterTuning?.walAutoCheckpointPages ?? 1_000,
            };
            if (!options.sourceOnly)
              yield* hydrateSharedParseCache({
                databasePath: layout.databasePath,
                identity: initialIdentity,
                persistentCapacityProtector: codeGraphDirectPersistentCapacityProtector({
                  capacityProtection,
                  fs,
                  identity: initialIdentity,
                  layout,
                  onProgress: options.onProgress,
                  threadnoteHome: options.threadnoteHome,
                }),
                store,
                threadnoteHome: request.threadnoteHome,
              }).pipe(Effect.ignore);
            const repositoryBuild = withCodeGraphProcessLock(
              fs,
              layout.lockPath,
              () =>
                (options.onProgress?.({phase: 'waiting', reason: 'repository-lock'}) ?? Effect.void).pipe(
                  Effect.ignore,
                ),
              'index-repository',
              Effect.gen(function* () {
                if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                  return yield* CodeGraphIndexOperationError.make({
                    message: 'Code graph repository root is a symbolic link.',
                  });
                }
                if (!(yield* fs.exists(layout.repositoryRoot))) {
                  return yield* RepositoryRegistrationLost.make({});
                }
                if (yield* codeGraphMaintenanceIntentActive(options.threadnoteHome)) {
                  return yield* RepositoryMaintenanceInterrupted.make({});
                }
                const build = store
                  .withSession(
                    layout.databasePath,
                    Effect.gen(function* () {
                      const startedAt = yield* Clock.currentTimeMillis;
                      const {identity} = yield* resolveAndRecordCodeGraphLocalAssociation(
                        options.threadnoteHome,
                        options.cwd,
                        {
                          validateIdentity: identity => {
                            if (!repositoryIdentityMatchesExpectation(identity, initialIdentity)) {
                              return Effect.fail(
                                CodeGraphIndexOperationError.make({
                                  message: 'Repository identity changed while waiting for the graph lock.',
                                }),
                              );
                            }
                            if (
                              options.expectedIdentity &&
                              !repositoryIdentityMatchesExpectation(identity, options.expectedIdentity)
                            ) {
                              return Effect.fail(
                                CodeGraphIndexOperationError.make({
                                  message: 'Repository identity does not match the requested graph target.',
                                }),
                              );
                            }
                            return identity.headCommit === initialIdentity.headCommit
                              ? Effect.void
                              : Effect.fail(WorktreeChangedDuringIndex.make({}));
                          },
                        },
                      );
                      yield* store.initialize(layout.databasePath);
                      if ((yield* observeCodeGraphAdmissionEnvironment(identity)) !== admissionEnvironment) {
                        return yield* WorktreeChangedDuringIndex.make({});
                      }
                      let inventoryOverlayObservation: CodeGraphOverlayObservation;
                      {
                        const currentBuildRequest = yield* worktreeBuildRequestObservation(
                          identity,
                          options.threadnoteHome,
                          scope,
                        ).pipe(Effect.provideService(Crypto.Crypto, crypto));
                        const currentOverlay = currentBuildRequest.state;
                        if (!sameOverlayState(currentOverlay, requestedOverlay)) {
                          return yield* WorktreeChangedDuringIndex.make({});
                        }
                        inventoryOverlayObservation = currentBuildRequest.overlay;
                        if (requestKey) {
                          const completedByOwner = yield* completedConcurrentSnapshot(
                            store,
                            layout,
                            identity,
                            currentOverlay,
                            requestKey,
                            options.incrementalOverlay === false,
                          );
                          if (
                            completedByOwner &&
                            (scopeEvidence === undefined ||
                              (completedByOwner.scopeId === scope?.scopeKey &&
                                (yield* codeGraphSnapshotAdmissionCurrent(
                                  layout,
                                  completedByOwner,
                                  admissionEnvironment,
                                  languagePacks,
                                  false,
                                  codeGraphScopeAdmissionEvidence(scopeEvidence),
                                ))))
                          ) {
                            yield* verifyIndexInput(
                              identity,
                              true,
                              options.threadnoteHome,
                              requestedOverlay,
                              scopedObservation,
                            );
                            // Completed-concurrent promotion changes the ready authority.
                            yield* beginDemandPublication();
                            // This result is already materialized. Make bounded cleanup progress;
                            // another full drain is required only before creating new graph payload.
                            yield* store.retireIncompleteWorktreeSnapshots(
                              layout.databasePath,
                              identity.repositoryId,
                              identity.worktreeId,
                              new Set(),
                              retiredSnapshotCleanupReporter(options.onProgress),
                              {cleanupMode: 'deferred', scopeId: scope?.scopeKey},
                            );
                            yield* promoteReadySnapshotWithCapacity(
                              {
                                capacityProtection,
                                fs,
                                identity,
                                layout,
                                onProgress: options.onProgress,
                                store,
                                threadnoteHome: options.threadnoteHome,
                              },
                              completedByOwner.id,
                            );
                            return yield* reuseReadySnapshot({
                              embedding,
                              ensureVectors,
                              identity,
                              layout,
                              onProgress: options.onProgress,
                              reusedFiles: completedByOwner.fileCount,
                              skippedFiles: 0,
                              snapshot: completedByOwner,
                              startedAt,
                              store,
                              threadnoteHome: options.threadnoteHome,
                              totalFiles: completedByOwner.fileCount,
                            });
                          }
                        }
                      }
                      const cacheCoalescer = cacheContentBatch({
                        databasePath: layout.databasePath,
                        languagePacks,
                        onSourceParserBatch: group =>
                          Effect.gen(function* () {
                            yield* options.sourceVerification?.observeParserBatch(group) ?? Effect.void;
                            if (!options.sourceOnly)
                              yield* enqueueSharedParserBatch(identity, options.threadnoteHome, group, producer);
                          }),
                        onProgress: options.onProgress,
                        parserPool,
                        preparationGate: buildResources.extractionPreparationGate,
                        persistentCapacityProtector: codeGraphDirectPersistentCapacityProtector({
                          capacityProtection,
                          fs,
                          identity,
                          layout,
                          onProgress: options.onProgress,
                          threadnoteHome: options.threadnoteHome,
                        }),
                        store,
                        threadnoteHome: options.threadnoteHome,
                        treeSitter,
                      });
                      let bypassReusableInventoryBase = false;
                      yield* cacheCoalescer.beginSparseExtractionTracking;
                      const sparseOverlay = yield* buildResources
                        .legacyBuildAdmission(
                          bypassCachedFacts
                            ? Effect.succeed(Option.none<CodeGraphIndexSummary>())
                            : attemptSparseReusableOverlay({
                                anonymousTelemetry,
                                cacheCoalescer,
                                capacityProtection,
                                embedding,
                                ensureVectors,
                                fs,
                                identity,
                                languagePacks,
                                layout,
                                observation: inventoryOverlayObservation,
                                scopeObservation: scopedObservation,
                                beforePublication: beginDemandPublication().pipe(
                                  Effect.provideService(Crypto.Crypto, crypto),
                                  Effect.provideService(FileSystem.FileSystem, fs),
                                  Effect.provideService(Path.Path, path),
                                  Effect.provideService(SystemInfo, system),
                                  Effect.provideService(CodeGraphProcessActivity, processActivity),
                                ),
                                onInvalidBaseCache: Effect.sync(() => {
                                  bypassReusableInventoryBase = true;
                                }),
                                options,
                                requestedOverlay,
                                startedAt,
                                store,
                              }),
                        )
                        .pipe(
                          Effect.ensuring(
                            cacheCoalescer.endSparseExtractionTracking.pipe(
                              Effect.andThen(cacheCoalescer.discard),
                              Effect.andThen(parserPool.trimIdle),
                            ),
                          ),
                        );
                      if (Option.isSome(sparseOverlay)) return sparseOverlay.value;
                      const rawInventory = yield* Effect.gen(function* () {
                        const changedPathCount =
                          inventoryOverlayObservation.changedPaths.length +
                          inventoryOverlayObservation.deletedPaths.length;
                        const reusableInventoryBase =
                          !bypassCachedFacts &&
                          !bypassReusableInventoryBase &&
                          !options.force &&
                          options.incrementalOverlay !== false &&
                          changedPathCount > 0 &&
                          changedPathCount <= 200
                            ? yield* store.reusableCleanBaseForCommit(
                                layout.databasePath,
                                identity.repositoryId,
                                identity.headCommit,
                                scope?.scopeKey,
                              )
                            : undefined;
                        if (reusableInventoryBase !== undefined) {
                          const targetedCachedFileKeys = yield* cachedFileKeys(
                            store,
                            layout.databasePath,
                            languagePacks,
                            options.onProgress,
                            inventoryOverlayObservation.files,
                          );
                          const reusedInventory = yield* inventoryRepositoryFromReusableCleanBase(
                            identity,
                            reusableInventoryBase,
                            {
                              ...options,
                              scopeObservation: scopedObservation,
                              cachedCommittedFileKeys: targetedCachedFileKeys,
                              includeOpaqueCorpusAssets: ensureVectors,
                              languagePacks,
                              overlayObservation: inventoryOverlayObservation,
                              onContentBatch: cacheCoalescer.onContentBatch,
                              onOverlayStart: () => cacheCoalescer.beginOverlayExtraction,
                            },
                          );
                          if (Option.isSome(reusedInventory)) return reusedInventory.value;
                        }
                        const cachedCommittedFileKeys =
                          options.force || bypassCachedFacts
                            ? new Set<string>()
                            : yield* cachedFileKeys(store, layout.databasePath, languagePacks, options.onProgress);
                        return yield* inventoryRepository(identity, {
                          ...options,
                          cachedCommittedFileKeys,
                          includeOpaqueCorpusAssets: ensureVectors,
                          languagePacks,
                          overlayObservation: inventoryOverlayObservation,
                          onContentBatch: cacheCoalescer.onContentBatch,
                          onOverlayStart: () => cacheCoalescer.beginOverlayExtraction,
                          onParserWorkPlanned: fileCount =>
                            warmPlannedParserCapacity(parserPool, options.threadnoteHome, fileCount),
                        });
                      }).pipe(
                        Effect.tap(() => cacheCoalescer.flush),
                        Effect.ensuring(cacheCoalescer.discard.pipe(Effect.andThen(parserPool.trimIdle))),
                      );
                      if (
                        !codeGraphScopeIdentityCompatible(scope, rawInventory.scope) ||
                        (scopedObservation !== undefined &&
                          scopedObservation.scopeInventoryFingerprint !== rawInventory.scopeInventoryFingerprint)
                      ) {
                        return yield* WorktreeChangedDuringIndex.make({});
                      }
                      if (rawInventory.dirty) {
                        const capturedHashes = new Map(
                          inventoryOverlayObservation.files.map(file => [file.path, file.contentHash]),
                        );
                        const currentRequest = yield* worktreeBuildRequestObservation(
                          identity,
                          options.threadnoteHome,
                          scope,
                        ).pipe(Effect.provideService(Crypto.Crypto, crypto));
                        if (
                          !sameOverlayState(currentRequest.state, requestedOverlay) ||
                          rawInventory.files.some(
                            file => file.source === 'worktree' && capturedHashes.get(file.path) !== file.contentHash,
                          )
                        ) {
                          return yield* WorktreeChangedDuringIndex.make({});
                        }
                      }
                      const sparseExtractedFiles = yield* cacheCoalescer.sparseExtractedFiles;
                      const inventory = {
                        ...rawInventory,
                        parsedFiles: Math.min(
                          rawInventory.files.length,
                          rawInventory.parsedFiles + sparseExtractedFiles,
                        ),
                      } satisfies CodeGraphInventory;
                      yield* anonymousTelemetry.observeInventory(inventory);
                      yield* anonymousTelemetry.observeExtractedFactBytes(yield* cacheCoalescer.extractedFactBytes);
                      // Bulk inventory and extraction build large, short-lived maps and Git payloads. Reclaim them
                      // synchronously before SQLite activation so their heap high-water does not overlap the writer
                      // page cache. Small graphs avoid a stop-the-world collection whose pause exceeds their live heap.
                      yield* Effect.sync(() => {
                        if (codeGraphInventoryNeedsSynchronousReclamation(inventory.files)) {
                          Bun.gc(true);
                          Bun.shrink();
                        }
                      });
                      yield* Effect.yieldNow;
                      const extractorSet = extractorSetIdentity(inventory.files, languagePacks);
                      // Compose dirty graph content from the canonical committed graph plus the exact overlay.
                      // Sparse admission already has those two inputs, so full and proportional routes publish
                      // the same content identity without forcing the sparse route to hydrate every base row.
                      const graphContentId =
                        inventory.dirty && inventory.overlayFingerprint !== undefined
                          ? sparseOverlayGraphContentIdentity(
                              graphContentIdentity(extractorSet, inventory.committedFiles, scope),
                              extractorSet,
                              inventory.overlayFingerprint,
                              scope,
                            )
                          : graphContentIdentity(extractorSet, inventory.files, scope);
                      const logicalSnapshotId = snapshotIdentity(
                        identity,
                        inventory.dirty,
                        extractorSet,
                        inventory.files,
                        scope,
                      );
                      const forceGeneration = options.force
                        ? (yield* crypto.randomUUIDv4).replaceAll('-', '').slice(0, 16)
                        : undefined;
                      const forcedSnapshotId = forcedSnapshotIdentity(logicalSnapshotId, forceGeneration);
                      const directSnapshotId = directFullSnapshotIdentity(logicalSnapshotId);
                      const resumedForcedBuild =
                        options.force && options.sourceVerification === undefined
                          ? yield* store.resumableForcedBuild(layout.databasePath, logicalSnapshotId)
                          : undefined;
                      const readyCandidateIds = inventory.dirty
                        ? options.incrementalOverlay === false
                          ? [directSnapshotId]
                          : [logicalSnapshotId, directSnapshotId]
                        : [logicalSnapshotId];
                      const existing = yield* store.readySnapshot(
                        layout.databasePath,
                        identity.worktreeId,
                        scope?.scopeKey,
                      );
                      const reusableExisting = existing
                        ? yield* store.currentLexicalReadySnapshotById(layout.databasePath, existing.id)
                        : undefined;
                      const reusableReadyById = !options.force
                        ? reusableExisting && readyCandidateIds.includes(reusableExisting.id)
                          ? reusableExisting
                          : yield* firstReadySnapshotById(store, layout.databasePath, readyCandidateIds)
                        : undefined;
                      // Exact cgsn_* can miss when inventory source/provenance differs slightly
                      // from the shared clean row while graph content is identical. Prefer promote
                      // of a HEAD-matching clean ready snapshot over rematerializing.
                      const reusableReady =
                        reusableReadyById ??
                        (!options.force && !inventory.dirty
                          ? yield* reusableReadySnapshotForCleanCommit({
                              scopeId: scope?.scopeKey,
                              databasePath: layout.databasePath,
                              extractorSet,
                              graphContentId,
                              headCommit: identity.headCommit,
                              repositoryId: identity.repositoryId,
                              store,
                            })
                          : undefined);
                      // A ready candidate wins this request. Do not preserve an
                      // interrupted logical/direct sibling that cannot be used on
                      // the early-return path: a repository-sized persistent build
                      // would otherwise remain reachable forever unless the user
                      // explicitly selected that other materialization mode again.
                      const retainedSnapshotIds = reusableReady
                        ? new Set<string>()
                        : options.force
                          ? new Set([resumedForcedBuild?.id ?? forcedSnapshotId])
                          : inventory.dirty
                            ? new Set(readyCandidateIds)
                            : new Set([logicalSnapshotId]);
                      // Inventory is complete; every remaining route can promote or materialize.
                      yield* beginDemandPublication();
                      const reclaimSnapshots = (cleanupMode: 'deferred' | 'required') =>
                        store
                          .retireIncompleteWorktreeSnapshots(
                            layout.databasePath,
                            identity.repositoryId,
                            identity.worktreeId,
                            cleanupMode === 'deferred' ? new Set<string>() : retainedSnapshotIds,
                            retiredSnapshotCleanupReporter(options.onProgress),
                            {cleanupMode, scopeId: scope?.scopeKey},
                          )
                          .pipe(Effect.asVoid);
                      if (reusableReady) {
                        yield* reclaimSnapshots('deferred');
                        if (existing?.id !== reusableReady.id) {
                          yield* promoteReadySnapshotWithCapacity(
                            {
                              capacityProtection,
                              fs,
                              identity,
                              layout,
                              onProgress: options.onProgress,
                              store,
                              threadnoteHome: options.threadnoteHome,
                            },
                            reusableReady.id,
                          );
                        }
                        return yield* reuseReadySnapshot({
                          embedding,
                          ensureVectors,
                          identity,
                          layout,
                          onProgress: options.onProgress,
                          reusedFiles: inventory.files.length - inventory.parsedFiles,
                          skippedFiles: inventory.skipped,
                          snapshot: reusableReady,
                          startedAt,
                          store,
                          threadnoteHome: options.threadnoteHome,
                          totalFiles: inventory.files.length,
                        });
                      }
                      if (!inventory.dirty) {
                        return yield* buildOwnedCleanSnapshot({
                          buildOwner: reporter.ownerIdentity,
                          legacyBuildAdmission: buildResources.legacyBuildAdmission,
                          capacityProtection,
                          embedding,
                          ensureVectors,
                          existing,
                          fallbackSnapshotId: forcedSnapshotId,
                          force: options.force === true,
                          sourceVerification: options.sourceVerification,
                          fs,
                          identity,
                          inventory,
                          languagePacks,
                          layout,
                          logicalSnapshotId,
                          onProgress: options.onProgress,
                          persistentMaterializationTransactionBatchLimit:
                            options.persistentMaterializationTransactionBatchLimit,
                          preparationGate: buildResources.preparationGate,
                          preparedSpoolBudgetGate: buildResources.preparedSpoolBudgetGate,
                          reclaimSnapshots,
                          requestedOverlay,
                          startedAt,
                          store,
                          threadnoteHome: options.threadnoteHome,
                        });
                      }
                      // Short-lived builders cannot rely on detached cleanup before creating
                      // another graph payload. Ready-only returns above make bounded progress.
                      yield* reclaimSnapshots('required');
                      const scopeResolutionChanged =
                        scope !== undefined &&
                        [...inventoryOverlayObservation.changedPaths, ...inventoryOverlayObservation.deletedPaths].some(
                          relative => languagePacks.isResolutionContext(relative),
                        );
                      const canAttemptIncrementalOverlay =
                        inventory.dirty &&
                        options.incrementalOverlay !== false &&
                        options.force !== true &&
                        !scopeResolutionChanged;
                      const resumableDirectBuild =
                        inventory.dirty && !options.force
                          ? yield* store.resumableBuildById(layout.databasePath, directSnapshotId)
                          : undefined;
                      let workspace =
                        inventory.workspace ??
                        (yield* buildResources.preparationGate(languagePacks.discoverWorkspace(inventory.files)));
                      let committedBase: CommittedBaseResult | undefined;
                      let incrementalAssessment: IncrementalOverlayAssessment | undefined;
                      let incrementalPrepared = false;
                      let building: CodeGraphSnapshot;
                      let persistentOwnerToken: string | undefined;
                      if (resumedForcedBuild) {
                        building = resumedForcedBuild;
                        incrementalAssessment = {mode: 'fallback', reason: 'forced-full-rebuild'};
                        persistentOwnerToken = yield* store.claimPersistentBuild(
                          layout.databasePath,
                          identity,
                          building,
                          {logicalSnapshotId, owner: reporter.ownerIdentity},
                        );
                      } else if (resumableDirectBuild) {
                        building = resumableDirectBuild;
                        incrementalAssessment = {
                          mode: 'fallback',
                          reason: options.incrementalOverlay === false ? 'disabled' : 'staging-unavailable',
                        };
                        persistentOwnerToken = yield* store.claimPersistentBuild(
                          layout.databasePath,
                          identity,
                          building,
                          {logicalSnapshotId, owner: reporter.ownerIdentity},
                        );
                      } else if (!inventory.dirty && !options.force) {
                        building = {
                          commit: identity.headCommit,
                          dirty: false,
                          edgeCount: 0,
                          extractorSet,
                          fileCount: 0,
                          graphContentId,
                          id: logicalSnapshotId,
                          repositoryId: identity.repositoryId,
                          scopeId: scope?.scopeKey,
                          state: 'building',
                          symbolCount: 0,
                          worktreeId: identity.worktreeId,
                        };
                        persistentOwnerToken = yield* store.claimPersistentBuild(
                          layout.databasePath,
                          identity,
                          building,
                          {logicalSnapshotId, owner: reporter.ownerIdentity},
                        );
                      } else if (!canAttemptIncrementalOverlay) {
                        building = {
                          commit: identity.headCommit,
                          dirty: inventory.dirty,
                          edgeCount: 0,
                          extractorSet,
                          fileCount: 0,
                          graphContentId,
                          id: options.force ? forcedSnapshotId : directSnapshotId,
                          overlayFingerprint: inventory.overlayFingerprint,
                          repositoryId: identity.repositoryId,
                          scopeId: scope?.scopeKey,
                          state: 'building',
                          symbolCount: 0,
                          worktreeId: identity.worktreeId,
                        };
                        incrementalAssessment = {
                          mode: 'fallback',
                          reason: options.force
                            ? 'forced-full-rebuild'
                            : scopeResolutionChanged
                              ? 'workspace-changed'
                              : 'disabled',
                        };
                        persistentOwnerToken = yield* store.claimPersistentBuild(
                          layout.databasePath,
                          identity,
                          building,
                          {logicalSnapshotId, owner: reporter.ownerIdentity},
                        );
                      } else {
                        const reusableDirtyBase = yield* attemptReusableDirtyBase(
                          {
                            extractorSet,
                            identity,
                            inventory,
                            languagePacks,
                            layout,
                            persistentCapacityProtector: codeGraphDirectPersistentCapacityProtector({
                              capacityProtection,
                              fs,
                              identity,
                              layout,
                              onProgress: options.onProgress,
                              threadnoteHome: options.threadnoteHome,
                            }),
                            store,
                          },
                          workspace,
                        );
                        let preassessment: IncrementalOverlayPreassessment;
                        let incrementalBuilding: CodeGraphSnapshot | undefined;
                        if (Option.isSome(reusableDirtyBase)) {
                          committedBase = reusableDirtyBase.value.committedBase;
                          preassessment = reusableDirtyBase.value.preassessment;
                        } else {
                          preassessment = yield* assessIncrementalOverlayCompatibility(
                            {extractorSet, inventory, languagePacks, layout, store},
                            workspace,
                          );
                          if (preassessment.mode === 'compatible') {
                            committedBase = yield* ensureCommittedBase({
                              buildOwner: reporter.ownerIdentity,
                              legacyBuildAdmission: buildResources.legacyBuildAdmission,
                              capacityProtection,
                              embedding,
                              existing,
                              force: false,
                              forceGeneration,
                              fs,
                              identity,
                              inventory,
                              languagePacks,
                              layout,
                              onProgress: options.onProgress,
                              persistentMaterializationTransactionBatchLimit:
                                options.persistentMaterializationTransactionBatchLimit,
                              preparationGate: buildResources.preparationGate,
                              preparedSpoolBudgetGate: buildResources.preparedSpoolBudgetGate,
                              requestedOverlay,
                              startedAt,
                              store,
                              threadnoteHome: options.threadnoteHome,
                            });
                            if ((yield* observeCodeGraphAdmissionEnvironment(identity)) !== admissionEnvironment) {
                              return yield* WorktreeChangedDuringIndex.make({});
                            }
                            yield* recordCodeGraphSnapshotAdmission(
                              layout,
                              committedBase.snapshot,
                              admissionEnvironment,
                              languagePacks,
                              ensureVectors,
                              {
                                cleanOnly: true,
                                ...(scopeEvidence === undefined
                                  ? {}
                                  : {
                                      scope: {
                                        ...codeGraphScopeAdmissionEvidence(scopeEvidence),
                                        inventoryFingerprint: inventory.scopeCommittedInventoryFingerprint!,
                                        scopedOverlayFingerprint: undefined,
                                      },
                                    }),
                              },
                            );
                          }
                        }
                        if (preassessment.mode === 'fallback') {
                          incrementalAssessment = preassessment;
                        } else {
                          incrementalBuilding = {
                            baseSnapshotId: committedBase!.snapshot.id,
                            commit: identity.headCommit,
                            dirty: inventory.dirty,
                            edgeCount: 0,
                            extractorSet,
                            fileCount: 0,
                            graphContentId,
                            id: logicalSnapshotId,
                            overlayFingerprint: inventory.overlayFingerprint,
                            repositoryId: identity.repositoryId,
                            scopeId: scope?.scopeKey,
                            state: 'building',
                            symbolCount: 0,
                            worktreeId: identity.worktreeId,
                          };
                          incrementalAssessment = yield* buildResources.preparationGate(
                            assessIncrementalOverlay(
                              {
                                building: incrementalBuilding,
                                committedBase: committedBase!,
                                force: false,
                                incrementalOverlayEnabled: true,
                                inventory,
                                languagePacks,
                                layout,
                                store,
                              },
                              workspace,
                              preassessment,
                            ),
                          );
                        }
                        if (incrementalAssessment.mode === 'eligible') {
                          if (committedBase === undefined) {
                            return yield* CodeGraphIndexOperationError.make({
                              message: 'Incremental code graph preparation requires a committed base snapshot.',
                            });
                          }
                          const incrementalReusedFiles = inventory.files.length - incrementalAssessment.files.length;
                          const incrementalCapacityProtector = codeGraphDirectPersistentCapacityProtector({
                            capacityProtection,
                            fs,
                            identity,
                            layout,
                            onProgress: options.onProgress,
                            threadnoteHome: options.threadnoteHome,
                          });
                          yield* options.onProgress?.({
                            completed: 0,
                            phase: 'materializing',
                            reused: incrementalReusedFiles,
                            total: incrementalAssessment.files.length,
                            unit: 'files',
                          }) ?? Effect.void;
                          incrementalPrepared = yield* buildResources.legacyBuildAdmission(
                            incrementalAssessment.reuse === 'persisted-base'
                              ? store.preparePersistedIncrementalActivation(
                                  layout.databasePath,
                                  committedBase.snapshot.id,
                                  incrementalAssessment.files,
                                  incrementalAssessment.facts,
                                  {
                                    deletedPaths: incrementalAssessment.deletedPaths,
                                    ...(committedBase.foldForward
                                      ? {
                                          foldForward: {
                                            snapshotId: committedBase.foldForward.logicalSnapshotId,
                                            stagedPayloadBytes: committedBase.foldForward.priorStagedPayloadBytes,
                                            stagedRows: committedBase.foldForward.priorStagedRows,
                                          },
                                        }
                                      : {}),
                                    resolutionClosure: incrementalAssessment.resolutionClosure,
                                  },
                                  incrementalCapacityProtector,
                                )
                              : store.replaceStagedModifiedFiles(
                                  layout.databasePath,
                                  committedBase.snapshot.id,
                                  incrementalAssessment.files,
                                  incrementalAssessment.facts,
                                  incrementalCapacityProtector,
                                ),
                          );
                          if (!incrementalPrepared) {
                            incrementalAssessment = {mode: 'fallback', reason: 'staging-identity-mismatch'};
                          }
                        }
                        if (
                          incrementalPrepared &&
                          incrementalBuilding !== undefined &&
                          preassessment.mode === 'compatible'
                        ) {
                          building = incrementalBuilding;
                          yield* store.markBuilding(layout.databasePath, identity, building);
                          if (preassessment.committedWorkspace.fingerprint !== workspace.fingerprint) {
                            yield* store.stageWorkspaceCatalog(
                              layout.databasePath,
                              workspace,
                              codeGraphDirectPersistentCapacityProtector({
                                capacityProtection,
                                fs,
                                identity,
                                layout,
                                onProgress: options.onProgress,
                                threadnoteHome: options.threadnoteHome,
                              }),
                            );
                          }
                        } else {
                          building = {
                            commit: identity.headCommit,
                            dirty: inventory.dirty,
                            edgeCount: 0,
                            extractorSet,
                            fileCount: 0,
                            graphContentId,
                            id: directSnapshotId,
                            overlayFingerprint: inventory.overlayFingerprint,
                            repositoryId: identity.repositoryId,
                            scopeId: scope?.scopeKey,
                            state: 'building',
                            symbolCount: 0,
                            worktreeId: identity.worktreeId,
                          };
                          committedBase = undefined;
                          persistentOwnerToken = yield* store.claimPersistentBuild(
                            layout.databasePath,
                            identity,
                            building,
                            {logicalSnapshotId, owner: reporter.ownerIdentity},
                          );
                        }
                      }
                      if (incrementalPrepared) {
                        // The prepared delta already contains attributed facts
                        // and a staged workspace catalog. Retaining thousands
                        // of project/dependency objects through activation only
                        // makes one-file overlays overlap full-workspace memory
                        // with SQLite's effective-graph scans.
                        workspace = {
                          diagnostics: workspace.diagnostics,
                          fingerprint: workspace.fingerprint,
                          projects: [],
                          workspaces: [],
                        };
                      }
                      return yield* buildAndActivate({
                        activatePointer: true,
                        building,
                        capacityProtection,
                        existing,
                        embedding,
                        ensureVectors,
                        force: options.force === true,
                        fs,
                        identity,
                        inventory,
                        committedBase,
                        incrementalAssessment,
                        incrementalOverlayEnabled: options.incrementalOverlay !== false,
                        incrementalPrepared,
                        languagePacks,
                        legacyBuildAdmission: buildResources.legacyBuildAdmission,
                        layout,
                        onProgress: options.onProgress,
                        persistentMaterializationTransactionBatchLimit:
                          options.persistentMaterializationTransactionBatchLimit,
                        persistentOwnerToken,
                        preparationGate: buildResources.extractionPreparationGate,
                        preparedSpoolBudgetGate: buildResources.preparedSpoolBudgetGate,
                        requestedOverlay,
                        startedAt,
                        store,
                        threadnoteHome: options.threadnoteHome,
                        workspace,
                      }).pipe(
                        Effect.onInterrupt(() =>
                          settleInterruptedCodeGraphBuild(
                            store,
                            layout.databasePath,
                            building.id,
                            persistentOwnerToken,
                          ),
                        ),
                        Effect.catchIf(isNonResumableCodeGraphBuildFailure, cause =>
                          store
                            .markFailed(layout.databasePath, building.id, messageOf(cause), persistentOwnerToken)
                            .pipe(Effect.andThen(Effect.fail(cause))),
                        ),
                      );
                    }),
                    writerSessionOptions(
                      layout,
                      options,
                      () => reporter.progress(lastActiveProgress),
                      buildResources.resources,
                    ),
                  )
                  .pipe(
                    Effect.onInterrupt(() =>
                      reporter.fail(CodeGraphIndexOperationError.make({message: CODE_GRAPH_INTERRUPTED_BUILD_SUMMARY})),
                    ),
                    Effect.tap(summary =>
                      Effect.gen(function* () {
                        if ((yield* observeCodeGraphAdmissionEnvironment(initialIdentity)) !== admissionEnvironment) {
                          return yield* WorktreeChangedDuringIndex.make({});
                        }
                        yield* recordCodeGraphSnapshotAdmission(
                          layout,
                          summary.snapshot,
                          admissionEnvironment,
                          languagePacks,
                          ensureVectors,
                          scopeEvidence === undefined
                            ? undefined
                            : {scope: codeGraphScopeAdmissionEvidence(scopeEvidence)},
                        );
                        if (scopeEvidence !== undefined) {
                          yield* store.recordScopeApplicability(
                            layout.databasePath,
                            summary.snapshot.id,
                            scopeEvidence,
                            scope,
                          );
                        }
                      }),
                    ),
                    Effect.tap(summary => reporter.complete(summary)),
                    Effect.tapError(cause => reporter.fail(cause)),
                  );
                return yield* build;
              }),
              {
                onAcquired: () => reporter.markWorktreeLockHeld(true),
                onCompleted: () => reporter.markWorktreeLockHeld(false),
              },
            );
            const coordinatedBuild = repositoryBuild.pipe(
              Effect.ensuring(
                runCodeGraphLifecycleOpportunity({
                  maintenance,
                  opportunity: 'index-completion',
                  targets: [
                    {
                      anchorIdentity: initialIdentity,
                      ...(layout.scopeId === undefined ? {} : {anchorScopeId: layout.scopeId}),
                      checkoutId: layout.checkoutId,
                      databasePath: layout.databasePath,
                    },
                  ],
                  threadnoteHome: request.threadnoteHome,
                }).pipe(Effect.ignore),
              ),
            );
            const summary = yield* withSharedCodeGraphRequestGate({
              checkoutId: initialIdentity.checkoutId,
              effect: coordinatedBuild,
              fs,
              onProgress: options.onProgress,
              path,
              requestKey,
              requestedOverlay,
              threadnoteHome: options.threadnoteHome,
            });
            if (!options.sourceOnly && !summary.snapshot.dirty)
              yield* finalizeGraphShareSignedCandidates({
                databasePath: layout.databasePath,
                repositoryId: summary.identity.repositoryId,
                skippedFiles: summary.skippedFiles,
                snapshot: summary.snapshot,
                store,
                threadnoteHome: request.threadnoteHome,
              });
            if (!options.sourceOnly)
              yield* drainQueuedGraphShareContributions({
                identity: initialIdentity,
                threadnoteHome: request.threadnoteHome,
              }).pipe(Effect.ignore);
            return summary;
          }),
        ).pipe(
          Effect.provideService(CommandExecutor, command),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
          Effect.provideService(CodeGraphProcessActivity, processActivity),
          Effect.provideService(CodeGraphStore, store),
          Effect.provideService(CodeGraphLanguagePackRegistry, languagePacks),
          Effect.provideService(CodeGraphMaintenanceCoordinator, maintenance),
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.catchIf(
            cause =>
              request.sourceVerification === undefined && Schema.is(WorktreeChangedDuringIndex)(cause) && attempt === 0,
            () => indexAttempt(request, anonymousTelemetry, attempt + 1, bypassCachedFacts),
          ),
          Effect.catchIf(
            cause =>
              request.sourceVerification === undefined &&
              Schema.is(CachedCodeGraphFactUnavailableDuringIndex)(cause) &&
              !bypassCachedFacts,
            () => indexAttempt(request, anonymousTelemetry, attempt, true),
          ),
        );
      const index = (request: CodeGraphIndexOptions) =>
        Effect.flatMap(
          observability.makeBuildReporter(system.environment().THREADNOTE_MCP_BROKER_CHILD === '1' ? 'mcp' : 'cli'),
          anonymousTelemetry =>
            withCodeGraphBuildAnonymousTelemetry(anonymousTelemetry, indexAttempt(request, anonymousTelemetry)),
        );
      const ensureCommitWithSummary = (
        request: Omit<CodeGraphIndexOptions, 'force' | 'includeOverlay' | 'sourceVerification'> & {
          readonly commit: string;
        },
        anonymousTelemetry: CodeGraphBuildAnonymousTelemetryReporter,
        bypassCachedFacts = false,
      ): Effect.Effect<{readonly lease: CodeGraphCommitLease; readonly summary: CodeGraphIndexSummary}, unknown> =>
        Effect.scoped(
          Effect.gen(function* () {
            const initialIdentity = yield* resolveRepositoryIdentity(request.cwd);
            const commitScope =
              request.project?.graph === undefined
                ? undefined
                : (yield* observeCodeGraphIndexScope(
                    {...initialIdentity, headCommit: request.commit},
                    request.project,
                    {includeOverlay: false, languagePacks},
                  )).scope;
            const producer = {
              platform: {
                architecture: system.architecture === 'aarch64' ? 'arm64' : system.architecture,
                os: system.platform,
              },
              releaseIdentity,
            };
            if (
              request.expectedIdentity &&
              !repositoryIdentityMatchesExpectation(initialIdentity, request.expectedIdentity)
            ) {
              return yield* CodeGraphIndexOperationError.make({
                message: 'Repository identity does not match the requested graph target.',
              });
            }
            const layout = codeGraphLayout(
              path,
              request.threadnoteHome,
              initialIdentity.checkoutId,
              initialIdentity.worktreeId,
              commitScope?.scopeKey,
            );
            const reporter = yield* withCodeGraphMaintenanceRegistration(
              request.threadnoteHome,
              Effect.gen(function* () {
                if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                  return yield* CodeGraphIndexOperationError.make({
                    message: 'Code graph repository root is a symbolic link.',
                  });
                }
                yield* fs.makeDirectory(layout.repositoryRoot, {recursive: true, mode: 0o700});
                return yield* makeCodeGraphBuildReporter({...initialIdentity, headCommit: request.commit}, layout);
              }),
            );
            yield* Effect.forkScoped(reporter.heartbeat);
            let lastActiveProgress: CodeGraphProgress = {phase: 'registering'};
            const options = {
              ...request,
              onProgress: (progress: CodeGraphProgress) =>
                Effect.sync(() => {
                  if (progress.phase !== 'waiting') lastActiveProgress = progress;
                }).pipe(
                  Effect.andThen(anonymousTelemetry.progress(progress)),
                  Effect.andThen(reporter.progress(progress)),
                  Effect.andThen(request.onProgress?.(progress) ?? Effect.void),
                ),
            };
            const buildResources = yield* makeBuildResourceGates({
              admissionClass: codeGraphBuilderAdmissionClass(options, system.environment()),
              checkoutId: initialIdentity.checkoutId,
              onProgress: options.onProgress,
              reporter,
              resumeProgress: () => options.onProgress(lastActiveProgress),
              threadnoteHome: options.threadnoteHome,
              worktreeId: initialIdentity.worktreeId,
            });
            const commitIdentity = {...initialIdentity, headCommit: request.commit};
            const capacityProtection: DirectPersistentCapacityProtection = {
              availableDiskBytes:
                options.diskCapacityAvailableBytes ?? ((target: string) => system.availableDiskBytes(target)),
              crypto,
              maintenance,
              path,
              system,
              temporaryDirectory: system.tempDirectory,
              walAutoCheckpointPages: options.sqliteWriterTuning?.walAutoCheckpointPages ?? 1_000,
            };
            if (!options.sourceOnly && (yield* fs.exists(graphShareEnrollmentPath(path, initialIdentity.repoRoot)))) {
              yield* captureSharedGraphImportBase({
                cwd: request.cwd,
                identity: commitIdentity,
                onProgress: options.onProgress,
                threadnoteHome: request.threadnoteHome,
              });
            }
            if (!options.sourceOnly)
              yield* hydrateSharedParseCache({
                databasePath: layout.databasePath,
                identity: commitIdentity,
                persistentCapacityProtector: codeGraphDirectPersistentCapacityProtector({
                  capacityProtection,
                  fs,
                  identity: commitIdentity,
                  layout,
                  onProgress: options.onProgress,
                  threadnoteHome: options.threadnoteHome,
                }),
                store,
                threadnoteHome: request.threadnoteHome,
              }).pipe(Effect.ignore);
            const commitBuild = withCodeGraphProcessLock(
              fs,
              layout.lockPath,
              () =>
                (options.onProgress?.({phase: 'waiting', reason: 'repository-lock'}) ?? Effect.void).pipe(
                  Effect.ignore,
                ),
              'ensure-commit',
              Effect.gen(function* () {
                if ((yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))._tag === 'Some') {
                  return yield* CodeGraphIndexOperationError.make({
                    message: 'Code graph repository root is a symbolic link.',
                  });
                }
                if (!(yield* fs.exists(layout.repositoryRoot))) {
                  return yield* RepositoryRegistrationLost.make({});
                }
                if (yield* codeGraphMaintenanceIntentActive(options.threadnoteHome)) {
                  return yield* RepositoryMaintenanceInterrupted.make({});
                }
                return yield* store
                  .withSession(
                    layout.databasePath,
                    Effect.gen(function* () {
                      const {identity: currentIdentity} = yield* resolveAndRecordCodeGraphLocalAssociation(
                        options.threadnoteHome,
                        options.cwd,
                        {
                          validateIdentity: identity => {
                            if (!repositoryIdentityMatchesExpectation(identity, initialIdentity)) {
                              return Effect.fail(
                                CodeGraphIndexOperationError.make({
                                  message: 'Repository identity changed while waiting for the graph lock.',
                                }),
                              );
                            }
                            if (
                              options.expectedIdentity &&
                              !repositoryIdentityMatchesExpectation(identity, options.expectedIdentity)
                            ) {
                              return Effect.fail(
                                CodeGraphIndexOperationError.make({
                                  message: 'Repository identity does not match the requested graph target.',
                                }),
                              );
                            }
                            return Effect.void;
                          },
                        },
                      );
                      yield* store.initialize(layout.databasePath);
                      const identity = {...currentIdentity, headCommit: options.commit};
                      const cachedCommittedFileKeys = bypassCachedFacts
                        ? new Set<string>()
                        : yield* cachedFileKeys(store, layout.databasePath, languagePacks, options.onProgress);
                      const cacheCoalescer = cacheContentBatch({
                        databasePath: layout.databasePath,
                        languagePacks,
                        onSourceParserBatch: options.sourceOnly
                          ? undefined
                          : group => enqueueSharedParserBatch(identity, options.threadnoteHome, group, producer),
                        onProgress: options.onProgress,
                        parserPool,
                        preparationGate: buildResources.preparationGate,
                        persistentCapacityProtector: codeGraphDirectPersistentCapacityProtector({
                          capacityProtection,
                          fs,
                          identity,
                          layout,
                          onProgress: options.onProgress,
                          threadnoteHome: options.threadnoteHome,
                        }),
                        store,
                        threadnoteHome: options.threadnoteHome,
                        treeSitter,
                      });
                      const inventory = yield* inventoryRepository(identity, {
                        ...options,
                        cachedCommittedFileKeys,
                        includeOverlay: false,
                        languagePacks,
                        onContentBatch: cacheCoalescer.onContentBatch,
                      }).pipe(
                        Effect.tap(() => cacheCoalescer.flush),
                        Effect.ensuring(cacheCoalescer.discard.pipe(Effect.andThen(parserPool.trimIdle))),
                      );
                      yield* anonymousTelemetry.observeInventory(inventory);
                      yield* anonymousTelemetry.observeExtractedFactBytes(yield* cacheCoalescer.extractedFactBytes);
                      const committedBase = yield* ensureCommittedBase({
                        buildOwner: reporter.ownerIdentity,
                        legacyBuildAdmission: buildResources.legacyBuildAdmission,
                        capacityProtection,
                        embedding,
                        force: false,
                        fs,
                        identity,
                        inventory,
                        languagePacks,
                        layout,
                        onProgress: options.onProgress,
                        persistentMaterializationTransactionBatchLimit:
                          options.persistentMaterializationTransactionBatchLimit,
                        preparationGate: buildResources.preparationGate,
                        preparedSpoolBudgetGate: buildResources.preparedSpoolBudgetGate,
                        startedAt: yield* Clock.currentTimeMillis,
                        store,
                        threadnoteHome: options.threadnoteHome,
                      });
                      const snapshot = committedBase.snapshot;
                      const leaseToken = yield* store.acquireSnapshotLease(
                        layout.databasePath,
                        snapshot.id,
                        2 * 60_000,
                      );
                      return {
                        lease: {leaseToken, snapshot} satisfies CodeGraphCommitLease,
                        summary: committedBase.summary,
                      };
                    }),
                    writerSessionOptions(
                      layout,
                      options,
                      () => reporter.progress(lastActiveProgress),
                      buildResources.resources,
                    ),
                  )
                  .pipe(
                    Effect.onInterrupt(() =>
                      reporter.fail(CodeGraphIndexOperationError.make({message: CODE_GRAPH_INTERRUPTED_BUILD_SUMMARY})),
                    ),
                    Effect.tap(result => reporter.completeSnapshot(result.lease.snapshot)),
                    Effect.tapError(cause => reporter.fail(cause)),
                  );
              }),
              {
                onAcquired: () => reporter.markWorktreeLockHeld(true),
                onCompleted: () => reporter.markWorktreeLockHeld(false),
              },
            );
            const lease = yield* commitBuild.pipe(
              Effect.ensuring(
                runCodeGraphLifecycleOpportunity({
                  maintenance,
                  opportunity: 'index-completion',
                  targets: [
                    {
                      anchorIdentity: initialIdentity,
                      ...(layout.scopeId === undefined ? {} : {anchorScopeId: layout.scopeId}),
                      checkoutId: layout.checkoutId,
                      databasePath: layout.databasePath,
                    },
                  ],
                  threadnoteHome: request.threadnoteHome,
                }).pipe(Effect.ignore),
              ),
            );
            if (!options.sourceOnly)
              yield* finalizeGraphShareSignedCandidates({
                databasePath: layout.databasePath,
                repositoryId: lease.summary.identity.repositoryId,
                skippedFiles: lease.summary.skippedFiles,
                snapshot: lease.summary.snapshot,
                store,
                threadnoteHome: request.threadnoteHome,
              });
            if (!options.sourceOnly)
              yield* drainQueuedGraphShareContributions({
                identity: initialIdentity,
                threadnoteHome: request.threadnoteHome,
              }).pipe(Effect.ignore);
            return lease;
          }),
        ).pipe(
          Effect.provideService(CommandExecutor, command),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(SystemInfo, system),
          Effect.provideService(CodeGraphProcessActivity, processActivity),
          Effect.provideService(CodeGraphStore, store),
          Effect.provideService(CodeGraphLanguagePackRegistry, languagePacks),
          Effect.provideService(CodeGraphMaintenanceCoordinator, maintenance),
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.catchIf(
            cause => Schema.is(CachedCodeGraphFactUnavailableDuringIndex)(cause) && !bypassCachedFacts,
            () => ensureCommitWithSummary(request, anonymousTelemetry, true),
          ),
        );
      const ensureCommit = (
        request: Omit<CodeGraphIndexOptions, 'force' | 'includeOverlay' | 'sourceVerification'> & {
          readonly commit: string;
        },
      ) =>
        Effect.flatMap(
          observability.makeBuildReporter(system.environment().THREADNOTE_MCP_BROKER_CHILD === '1' ? 'mcp' : 'cli'),
          anonymousTelemetry =>
            ensureCommitWithSummary(request, anonymousTelemetry).pipe(
              Effect.onExit(exit =>
                anonymousTelemetry.terminal(
                  Exit.isSuccess(exit) ? Exit.succeed(exit.value.summary) : Exit.failCause(exit.cause),
                ),
              ),
              Effect.map(result => result.lease),
            ),
        );
      return CodeGraphIndexer.of({
        ensureCommit,
        index,
      });
    }),
  );
}

const CODE_GRAPH_SYNCHRONOUS_RECLAMATION_MINIMUM_FILES = 512;
const CODE_GRAPH_SYNCHRONOUS_RECLAMATION_MINIMUM_RETAINED_SOURCE_BYTES = 16 * 1_048_576;

/** @internal Keeps the synchronous GC barrier tied to source bytes that inventory actually retained. */
export function codeGraphInventoryNeedsSynchronousReclamation(
  files: readonly Pick<CodeGraphInventoryFile, 'bytes' | 'content' | 'size'>[],
): boolean {
  if (files.length >= CODE_GRAPH_SYNCHRONOUS_RECLAMATION_MINIMUM_FILES) return true;
  let retainedSourceBytes = 0;
  for (const file of files) {
    if (file.content === undefined && file.bytes === undefined) continue;
    retainedSourceBytes += file.size;
    if (retainedSourceBytes >= CODE_GRAPH_SYNCHRONOUS_RECLAMATION_MINIMUM_RETAINED_SOURCE_BYTES) return true;
  }
  return false;
}

function codeGraphBuilderAdmissionClass(
  options: Pick<CodeGraphIndexOptions, 'admissionClass'>,
  environment: Readonly<Record<string, string | undefined>>,
) {
  if (options.admissionClass) return options.admissionClass;
  return environment[CODE_GRAPH_BUILDER_ADMISSION_CLASS_ENV] === 'background'
    ? ('background' as const)
    : ('current-required' as const);
}
