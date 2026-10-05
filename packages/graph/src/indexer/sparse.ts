import {Effect, FileSystem, Option} from 'effect';
import type {CodeGraphBuildAnonymousTelemetryReporter} from '../runtime_ports.js';
import {
  buildAndActivate,
  retiredSnapshotCleanupReporter,
  reuseReadySnapshot,
  settleInterruptedCodeGraphBuild,
} from './build.js';
import {assessIncrementalOverlay} from './incremental.js';
import {createRepositoryFactAttributionContext, type RepositoryFactAttributionContext} from '../extractor_context.js';
import {finalCodeGraphFactBatches} from '../fact/budget.js';
import {
  assessProjectClosureSeeds,
  declaredProjectResolutionClosureProjectIds,
  planProjectIncrementalClosure,
  selectProjectIncrementalClosure,
} from '../incremental/closure.js';
import {assessCodeGraphIncrementalFactBytes, codeGraphIncrementalFactBatchesFitBudget} from '../incremental/work.js';
import type {CodeGraphEmbeddingIndexShape} from '../embedding.js';
import {
  CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS,
  cachedFactsMetadata,
  cachedFileKeys,
  codeGraphDirectPersistentCapacityProtector,
  extractorSetIdentityFromPackProvenance,
  loadCachedFacts,
  messageOf,
  promoteReadySnapshotWithCapacity,
  sparseOverlayGraphContentIdentity,
  sparseOverlaySnapshotIdentity,
  withIncrementalMaterializationStorageTelemetry,
  verifyIndexInput,
  type CodeGraphCacheContentCoalescer,
} from './materialization.js';
import type {
  CodeGraphIndexOptions,
  CommittedBaseResult,
  DirectPersistentCapacityProtection,
  IncrementalOverlayPreassessment,
} from './types.js';
import type {CodeGraphInventory, CodeGraphOverlayObservation} from '../inventory.js';
import {
  inventoryRepositoryFromReusableCleanBaseSlice,
  type CodeGraphReusableOverlayAdmission,
} from '../inventory/sparse.js';
import {codeGraphLanguagePackProvenance, type CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import type {CodeGraphLayout} from '../layout.js';
import {compareCodeUnits} from '../ordering.js';
import {
  assessCodeGraphResolutionSymbolPublication,
  hasSameCodeGraphReexportResolutionSurface,
  hasSameCodeGraphResolutionSurface,
} from '../resolution/surface.js';
import type {CodeGraphStoreShape} from '../store/shape.js';
import type {CodeGraphFileFacts, CodeGraphIndexSummary, RepositoryIdentity} from '../types.js';
import {createWorkspaceAttributor} from '../workspace.js';

/**
 * Complete the body-only persisted-base path without hydrating or hashing the
 * repository-wide inventory. Unsupported dependency shapes return `None`
 * before activation staging so the ordinary full-inventory path remains the
 * correctness fallback.
 */
export const attemptSparseReusableOverlay = Effect.fn('codeGraph.attemptSparseReusableOverlay')(function* (input: {
  readonly anonymousTelemetry: CodeGraphBuildAnonymousTelemetryReporter;
  readonly cacheCoalescer: CodeGraphCacheContentCoalescer;
  readonly capacityProtection: DirectPersistentCapacityProtection;
  readonly embedding: CodeGraphEmbeddingIndexShape;
  readonly ensureVectors: boolean;
  readonly fs: FileSystem.FileSystem;
  readonly identity: RepositoryIdentity;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly layout: CodeGraphLayout;
  readonly observation: CodeGraphOverlayObservation;
  readonly scopeObservation?: CodeGraphInventory;
  /** Checked immediately before a sparse route can alter ready/build authority. */
  readonly beforePublication?: Effect.Effect<void, unknown>;
  readonly onInvalidBaseCache: Effect.Effect<void>;
  readonly options: CodeGraphIndexOptions;
  readonly requestedOverlay: {readonly dirty: boolean; readonly fingerprint?: string};
  readonly startedAt: number;
  readonly store: CodeGraphStoreShape;
}) {
  const changedPaths = input.observation.changedPaths;
  if (
    input.options.force ||
    input.options.incrementalOverlay === false ||
    changedPaths.length === 0 ||
    changedPaths.length > 200 ||
    input.observation.addedPaths.length > 0 ||
    input.observation.deletedPaths.length > 0 ||
    input.observation.untrackedPaths.length > 0 ||
    input.store.reusableCleanBaseForCommitPaths === undefined
  ) {
    return Option.none<CodeGraphIndexSummary>();
  }
  const base = yield* input.store.reusableCleanBaseForCommitPaths(
    input.layout.databasePath,
    input.identity.repositoryId,
    input.identity.headCommit,
    changedPaths,
    input.scopeObservation?.scope?.scopeKey,
  );
  if (base === undefined || base.receipt.inventory === undefined) return Option.none<CodeGraphIndexSummary>();
  const packProvenance = currentBasePackProvenance(base.receipt.packProvenance, input.languagePacks);
  if (
    packProvenance === undefined ||
    extractorSetIdentityFromPackProvenance(packProvenance) !== base.snapshot.extractorSet ||
    !Number.isSafeInteger(base.snapshot.fileCount) ||
    base.snapshot.fileCount < changedPaths.length
  ) {
    return Option.none<CodeGraphIndexSummary>();
  }
  const changedBaseMetadata = yield* cachedFactsMetadata(
    input.store,
    input.layout.databasePath,
    base.files,
    input.languagePacks,
  );
  if (
    changedBaseMetadata.files !== base.files.length ||
    changedBaseMetadata.bytesByPath.size !== base.files.length ||
    assessCodeGraphIncrementalFactBytes({
      aggregateBytes: changedBaseMetadata.bytes,
      factBytes: changedBaseMetadata.bytesByPath.values(),
    }).mode !== 'eligible'
  ) {
    return Option.none<CodeGraphIndexSummary>();
  }
  const changedBaseCache = yield* loadCachedFacts(
    input.store,
    input.layout.databasePath,
    base.files,
    input.languagePacks,
  );
  if (base.files.some(file => !changedBaseCache.facts.has(file.path))) {
    if (input.store.discardInvalidCachedFacts !== undefined) {
      yield* input.store.discardInvalidCachedFacts(input.layout.databasePath, base.files);
    }
    yield* input.onInvalidBaseCache;
    return Option.none<CodeGraphIndexSummary>();
  }
  const targetedCachedFileKeys = yield* cachedFileKeys(
    input.store,
    input.layout.databasePath,
    input.languagePacks,
    input.options.onProgress,
    input.observation.files,
  );
  const admitted = yield* inventoryRepositoryFromReusableCleanBaseSlice(input.identity, base, {
    ...input.options,
    scopeObservation: input.scopeObservation,
    cachedCommittedFileKeys: targetedCachedFileKeys,
    includeOpaqueCorpusAssets: input.ensureVectors,
    languagePacks: input.languagePacks,
    overlayObservation: input.observation,
    onContentBatch: input.cacheCoalescer.onContentBatch,
    onOverlayStart: () => input.cacheCoalescer.beginOverlayExtraction,
  });
  if (Option.isNone(admitted)) return Option.none<CodeGraphIndexSummary>();
  yield* input.cacheCoalescer.flush;
  const admission = admitted.value;
  const extractedFiles = yield* input.cacheCoalescer.sparseExtractedFiles;
  const inventory: CodeGraphInventory = {
    ...input.scopeObservation,
    committedFiles: base.files,
    committedParsedFiles: 0,
    diagnostics: admission.diagnostics,
    dirty: true,
    files: admission.files,
    overlayFingerprint: admission.overlayFingerprint,
    parsedFiles: Math.min(base.snapshot.fileCount, Math.max(admission.parsedFiles, extractedFiles)),
    skipped: admission.skipped,
    workspace: admission.workspace,
  };
  yield* input.anonymousTelemetry.observeInventory(inventory);
  yield* input.anonymousTelemetry.observeExtractedFactBytes(yield* input.cacheCoalescer.extractedFactBytes);
  // Sparse admission hydrates only the bounded changed/fanout slice. A forced
  // heap-wide collection scales with the process's prior high-water instead of
  // that slice, turning one-file indexing into repository-sized pause time.
  yield* Effect.yieldNow;

  const logicalSnapshotId = sparseOverlaySnapshotIdentity(
    input.identity,
    base.snapshot.id,
    base.snapshot.extractorSet,
    admission.overlayFingerprint,
    input.scopeObservation?.scope,
  );
  const existing = yield* input.store.readySnapshot(
    input.layout.databasePath,
    input.identity.worktreeId,
    input.scopeObservation?.scope?.scopeKey,
  );
  const reusableReady = yield* input.store.currentLexicalReadySnapshotById(
    input.layout.databasePath,
    logicalSnapshotId,
  );
  if (reusableReady !== undefined) {
    yield* verifyIndexInput(input.identity, true, input.options.threadnoteHome, input.requestedOverlay, inventory);
    if (existing?.id !== reusableReady.id) {
      yield* input.beforePublication ?? Effect.void;
      yield* promoteReadySnapshotWithCapacity(
        {
          capacityProtection: input.capacityProtection,
          fs: input.fs,
          identity: input.identity,
          layout: input.layout,
          onProgress: input.options.onProgress,
          store: input.store,
          threadnoteHome: input.options.threadnoteHome,
        },
        reusableReady.id,
      );
    }
    return Option.some(
      yield* reuseReadySnapshot({
        embedding: input.embedding,
        ensureVectors: input.ensureVectors,
        identity: input.identity,
        layout: input.layout,
        onProgress: input.options.onProgress,
        reusedFiles: base.snapshot.fileCount - inventory.parsedFiles,
        skippedFiles: admission.skipped,
        snapshot: reusableReady,
        startedAt: input.startedAt,
        store: input.store,
        threadnoteHome: input.options.threadnoteHome,
        totalFiles: base.snapshot.fileCount,
      }),
    );
  }

  // Keep the base lease local to this attempt. An ordinary lease acquired for
  // an active view inherits retirement responsibility; releasing it only when
  // the caller's outer index scope closes would retire the detached warm base
  // after an ordinary full fallback replaces that view.
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* input.store
        .acquireSnapshotLease(input.layout.databasePath, base.snapshot.id, CODE_GRAPH_ACTIVATION_LEASE_MILLISECONDS)
        .pipe(Effect.option);
      if (Option.isNone(lease)) return Option.none<CodeGraphIndexSummary>();
      const leaseToken = yield* Effect.acquireRelease(Effect.succeed(lease.value), token =>
        input.store.releaseSnapshotLease(input.layout.databasePath, token).pipe(Effect.ignore),
      );
      const committedBase: CommittedBaseResult = {
        diagnostics: [
          `Dirty snapshot reused compatible persisted base ${base.snapshot.id} without hydrating the complete inventory.`,
        ],
        leaseToken: Option.some(leaseToken),
        snapshot: base.snapshot,
        stagingReusable: false,
      };
      const preassessment = yield* assessReusableOverlayAdmissionCompatibility({
        admission,
        baseRawFacts: base.files.map(file =>
          input.languagePacks.postprocessFile(file, changedBaseCache.facts.get(file.path)!),
        ),
        languagePacks: input.languagePacks,
        layout: input.layout,
        store: input.store,
      });
      if (preassessment.mode === 'fallback') return Option.none<CodeGraphIndexSummary>();
      const building = {
        baseSnapshotId: base.snapshot.id,
        commit: input.identity.headCommit,
        dirty: true,
        edgeCount: 0,
        extractorSet: base.snapshot.extractorSet,
        fileCount: 0,
        graphContentId: sparseOverlayGraphContentIdentity(
          base.snapshot.graphContentId ?? base.snapshot.id,
          base.snapshot.extractorSet,
          admission.overlayFingerprint,
          input.scopeObservation?.scope,
        ),
        id: logicalSnapshotId,
        overlayFingerprint: admission.overlayFingerprint,
        repositoryId: input.identity.repositoryId,
        scopeId: input.scopeObservation?.scope?.scopeKey,
        state: 'building' as const,
        symbolCount: 0,
        worktreeId: input.identity.worktreeId,
      };
      const incrementalAssessment = yield* assessIncrementalOverlay(
        {
          building,
          committedBase,
          committedBaseReceipt: base.receipt,
          force: false,
          incrementalOverlayEnabled: true,
          inventory,
          languagePacks: input.languagePacks,
          layout: input.layout,
          store: input.store,
          totalFiles: base.snapshot.fileCount,
        },
        admission.workspace,
        preassessment,
      );
      if (incrementalAssessment.mode === 'fallback') return Option.none<CodeGraphIndexSummary>();
      yield* input.store.retireIncompleteWorktreeSnapshots(
        input.layout.databasePath,
        input.identity.repositoryId,
        input.identity.worktreeId,
        new Set([logicalSnapshotId]),
        retiredSnapshotCleanupReporter(input.options.onProgress),
        {cleanupMode: 'required', scopeId: input.scopeObservation?.scope?.scopeKey},
      );
      yield* input.options.onProgress?.({
        completed: 0,
        phase: 'materializing',
        reused: base.snapshot.fileCount - incrementalAssessment.files.length,
        total: incrementalAssessment.files.length,
        unit: 'files',
      }) ?? Effect.void;
      const preparedMaterialization = yield* withIncrementalMaterializationStorageTelemetry(
        input.fs,
        input.layout.databasePath,
        input.store.preparePersistedIncrementalActivation(
          input.layout.databasePath,
          base.snapshot.id,
          incrementalAssessment.files,
          incrementalAssessment.facts,
          {
            deletedPaths: incrementalAssessment.deletedPaths,
            resolutionClosure: incrementalAssessment.resolutionClosure,
          },
          codeGraphDirectPersistentCapacityProtector({
            capacityProtection: input.capacityProtection,
            fs: input.fs,
            identity: input.identity,
            layout: input.layout,
            onProgress: input.options.onProgress,
            threadnoteHome: input.options.threadnoteHome,
          }),
        ),
      );
      const prepared = preparedMaterialization.result;
      if (!prepared) return Option.none<CodeGraphIndexSummary>();
      yield* input.beforePublication ?? Effect.void;
      yield* input.store.markBuilding(input.layout.databasePath, input.identity, building);
      if (preassessment.committedWorkspace.fingerprint !== admission.workspace.fingerprint) {
        yield* input.store.stageWorkspaceCatalog(
          input.layout.databasePath,
          admission.workspace,
          codeGraphDirectPersistentCapacityProtector({
            capacityProtection: input.capacityProtection,
            fs: input.fs,
            identity: input.identity,
            layout: input.layout,
            onProgress: input.options.onProgress,
            threadnoteHome: input.options.threadnoteHome,
          }),
        );
      }
      const workspace = {
        diagnostics: admission.workspace.diagnostics,
        fingerprint: admission.workspace.fingerprint,
        projects: [],
        workspaces: [],
      };
      return Option.some(
        yield* buildAndActivate({
          activatePointer: true,
          building,
          capacityProtection: input.capacityProtection,
          committedBase,
          embedding: input.embedding,
          ensureVectors: input.ensureVectors,
          existing,
          force: false,
          fs: input.fs,
          identity: input.identity,
          incrementalAssessment,
          incrementalMaterializationStorageTelemetry: preparedMaterialization.storage,
          incrementalOverlayEnabled: true,
          incrementalPrepared: true,
          inventory,
          languagePacks: input.languagePacks,
          layout: input.layout,
          onProgress: input.options.onProgress,
          persistentMaterializationTransactionBatchLimit: input.options.persistentMaterializationTransactionBatchLimit,
          requestedOverlay: input.requestedOverlay,
          sparseProjection: {packProvenance, totalFiles: base.snapshot.fileCount},
          startedAt: input.startedAt,
          store: input.store,
          threadnoteHome: input.options.threadnoteHome,
          workspace,
        }).pipe(
          Effect.onInterrupt(() =>
            settleInterruptedCodeGraphBuild(input.store, input.layout.databasePath, building.id),
          ),
          Effect.tapError(cause => input.store.markFailed(input.layout.databasePath, building.id, messageOf(cause))),
        ),
      );
    }),
  );
});

function currentBasePackProvenance(
  persisted: readonly ReturnType<typeof codeGraphLanguagePackProvenance>[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
) {
  const activeIds = new Set(persisted.map(pack => pack.id));
  const current = languagePacks.packs
    .filter(pack => activeIds.has(pack.id))
    .map(codeGraphLanguagePackProvenance)
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const expected = [...persisted].sort((left, right) => compareCodeUnits(left.id, right.id));
  return current.length === expected.length && current.every((pack, index) => samePackProvenance(pack, expected[index]))
    ? current
    : undefined;
}

function samePackProvenance(
  left: ReturnType<typeof codeGraphLanguagePackProvenance>,
  right: ReturnType<typeof codeGraphLanguagePackProvenance>,
) {
  return (
    left.cacheIdentity === right.cacheIdentity &&
    left.derivationIdentity === right.derivationIdentity &&
    left.id === right.id &&
    left.resolutionDomain === right.resolutionDomain &&
    left.resolutionVersion === right.resolutionVersion
  );
}

/**
 * Prepare a body-only persisted-base delta without hydrating the complete base
 * inventory. Any unsupported or incomplete dependency evidence falls back
 * before staging begins.
 */
export const assessReusableOverlayAdmissionCompatibility = Effect.fn(
  'codeGraph.assessReusableOverlayAdmissionCompatibility',
)(function* (input: {
  readonly admission: CodeGraphReusableOverlayAdmission;
  readonly baseRawFacts: readonly CodeGraphFileFacts[];
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly layout: CodeGraphLayout;
  readonly store: CodeGraphStoreShape;
}) {
  if (input.store.existingSnapshotFilePaths === undefined) {
    return {mode: 'fallback', reason: 'staging-unavailable'} satisfies IncrementalOverlayPreassessment;
  }
  const base = input.admission.base;
  const inventoryReceipt = base.receipt.inventory;
  if (inventoryReceipt === undefined) {
    return {mode: 'fallback', reason: 'staging-unavailable'} satisfies IncrementalOverlayPreassessment;
  }
  const currentCache = yield* loadCachedFacts(
    input.store,
    input.layout.databasePath,
    input.admission.files,
    input.languagePacks,
  );
  if (input.admission.files.some(file => !currentCache.facts.has(file.path))) {
    return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
  }
  const currentRawFacts = input.admission.files.map(file =>
    input.languagePacks.postprocessFile(file, currentCache.facts.get(file.path)!),
  );
  const baseRawFactsByPath = new Map(input.baseRawFacts.map(file => [file.path, file]));
  const orderedBaseRawFacts = base.files.map(file => baseRawFactsByPath.get(file.path));
  if (orderedBaseRawFacts.some(file => file === undefined) || baseRawFactsByPath.size !== base.files.length) {
    return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
  }
  const completeBaseRawFacts: CodeGraphFileFacts[] = [];
  for (const fact of orderedBaseRawFacts) {
    if (fact !== undefined) completeBaseRawFacts.push(fact);
  }
  const repositoryAttribution = createRepositoryFactAttributionContext(inventoryReceipt.attributionFiles);
  const candidates = repositoryAttribution.candidatePaths([...completeBaseRawFacts, ...currentRawFacts]);
  const existingPaths = yield* input.store.existingSnapshotFilePaths(
    input.layout.databasePath,
    base.snapshot.id,
    candidates,
  );
  if (existingPaths === undefined) {
    return {mode: 'fallback', reason: 'project-closure-unbounded'} satisfies IncrementalOverlayPreassessment;
  }
  const attributeRepository = repositoryAttribution.attribute(new Set(existingPaths));
  const attributeWorkspace = createWorkspaceAttributor(input.admission.workspace);
  const currentFacts = attributeWorkspace(attributeRepository(currentRawFacts));
  const attributedBaseRawFacts = attributeWorkspace(attributeRepository(completeBaseRawFacts));
  // Materialized shards preserve exact prior batch attribution when present,
  // but they are a derived optimization rather than an admission prerequisite.
  // Reattribute the authoritative bounded raw base slice when a large clean
  // build deliberately deferred that cache.
  const baseShards =
    input.store.loadSnapshotMaterializedFileShards === undefined
      ? undefined
      : yield* input.store.loadSnapshotMaterializedFileShards(input.layout.databasePath, base.snapshot.id, base.files);
  const baseFacts =
    baseShards !== undefined && base.files.every(file => baseShards.facts.has(file.path))
      ? base.files.map(file => baseShards.facts.get(file.path)!)
      : attributedBaseRawFacts;
  const baseFactsByPath = new Map(baseFacts.map(file => [file.path, file]));
  const resolutionSurfaceChanged = currentFacts.some(file => {
    const prior = baseFactsByPath.get(file.path);
    return prior === undefined || !hasSameCodeGraphResolutionSurface(prior.symbols, file.symbols);
  });
  const reexportSurfaceChanged = !hasSameCodeGraphReexportResolutionSurface(
    baseFacts.flatMap(file => file.references ?? []),
    currentFacts.flatMap(file => file.references ?? []),
  );
  if (resolutionSurfaceChanged || reexportSurfaceChanged) {
    return yield* assessSparseProjectClosure({
      admission: input.admission,
      baseFacts,
      currentFacts,
      languagePacks: input.languagePacks,
      layout: input.layout,
      repositoryAttribution,
      store: input.store,
    });
  }
  if (!codeGraphIncrementalFactBatchesFitBudget(finalCodeGraphFactBatches(currentFacts))) {
    return {mode: 'fallback', reason: 'fact-budget-expanded'} satisfies IncrementalOverlayPreassessment;
  }
  return {
    baseFileSetFingerprint: base.receipt.fileSetFingerprint,
    committedWorkspace: input.admission.workspace,
    facts: currentFacts,
    files: input.admission.files,
    mode: 'compatible',
    proportionalWork: {
      attributionContextFiles: inventoryReceipt.attributionFiles.length,
      baseFactsLoaded: base.files.length,
      inventoryFilesInspected: base.files.length,
      probedDependencyPaths: candidates.length,
    },
    ...firstResolutionPublicationAssessment(currentFacts),
  } satisfies IncrementalOverlayPreassessment;
});

const assessSparseProjectClosure = Effect.fn('codeGraph.assessSparseProjectClosure')(function* (input: {
  readonly admission: CodeGraphReusableOverlayAdmission;
  readonly baseFacts: readonly CodeGraphFileFacts[];
  readonly currentFacts: readonly CodeGraphFileFacts[];
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly layout: CodeGraphLayout;
  readonly repositoryAttribution: RepositoryFactAttributionContext;
  readonly store: CodeGraphStoreShape;
}) {
  if (input.store.snapshotProjectClosureFiles === undefined || input.store.existingSnapshotFilePaths === undefined) {
    return {mode: 'fallback', reason: 'staging-unavailable'} satisfies IncrementalOverlayPreassessment;
  }
  const projects = input.admission.workspace.projects;
  const seeds = assessProjectClosureSeeds({
    committedFacts: input.baseFacts,
    effectiveFacts: input.currentFacts,
    projects,
  });
  if (seeds.mode === 'fallback') return seeds satisfies IncrementalOverlayPreassessment;
  const projectIds = declaredProjectResolutionClosureProjectIds(projects, seeds.seedProjectIds);
  if (projectIds === undefined) {
    return {mode: 'fallback', reason: 'project-closure-incomplete'} satisfies IncrementalOverlayPreassessment;
  }
  const projectsById = new Map(projects.map(project => [project.id, project]));
  const prefixes = projectIds.flatMap(id => {
    const project = projectsById.get(id);
    return project === undefined ? [] : [project.root, ...project.sourceRoots];
  });
  if (projectIds.some(id => !projectsById.has(id)) || prefixes.some(prefix => prefix.length === 0)) {
    return {mode: 'fallback', reason: 'project-closure-unbounded'} satisfies IncrementalOverlayPreassessment;
  }
  const base = input.admission.base;
  const baseClosureFiles = yield* input.store.snapshotProjectClosureFiles(
    input.layout.databasePath,
    base.snapshot.id,
    prefixes,
  );
  if (baseClosureFiles === undefined) {
    return {mode: 'fallback', reason: 'project-closure-unbounded'} satisfies IncrementalOverlayPreassessment;
  }
  const changedByPath = new Map(input.admission.files.map(file => [file.path, file]));
  const currentFiles = baseClosureFiles.map(file => changedByPath.get(file.path) ?? file);
  if (input.admission.files.some(file => !currentFiles.some(candidate => candidate.path === file.path))) {
    return {mode: 'fallback', reason: 'project-closure-incomplete'} satisfies IncrementalOverlayPreassessment;
  }
  const selection = selectProjectIncrementalClosure({
    files: currentFiles,
    modifiedPaths: input.admission.files.map(file => file.path),
    projects,
    seedProjectIds: seeds.seedProjectIds,
    workspaceDiagnostics: input.admission.workspace.diagnostics,
  });
  if (selection.mode === 'fallback') return selection satisfies IncrementalOverlayPreassessment;
  const currentByPath = new Map(currentFiles.map(file => [file.path, file]));
  const affectedFiles = selection.affectedPaths.map(path => currentByPath.get(path)!);
  const metadata = yield* cachedFactsMetadata(
    input.store,
    input.layout.databasePath,
    affectedFiles,
    input.languagePacks,
  );
  const plan = planProjectIncrementalClosure({
    cachedFactBytesByPath: metadata.bytesByPath,
    files: currentFiles,
    modifiedPaths: input.admission.files.map(file => file.path),
    projects,
    seedProjectIds: seeds.seedProjectIds,
    workspaceDiagnostics: input.admission.workspace.diagnostics,
  });
  if (plan.mode === 'fallback') return plan satisfies IncrementalOverlayPreassessment;
  if (metadata.files !== affectedFiles.length || plan.affectedPaths.length !== affectedFiles.length) {
    return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
  }
  const cache = yield* loadCachedFacts(input.store, input.layout.databasePath, affectedFiles, input.languagePacks);
  if (affectedFiles.some(file => !cache.facts.has(file.path))) {
    return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
  }
  const rawFacts = affectedFiles.map(file => input.languagePacks.postprocessFile(file, cache.facts.get(file.path)!));
  const inventoryReceipt = base.receipt.inventory!;
  const candidates = input.repositoryAttribution.candidatePaths(rawFacts);
  const existingPaths = yield* input.store.existingSnapshotFilePaths(
    input.layout.databasePath,
    base.snapshot.id,
    candidates,
  );
  if (existingPaths === undefined) {
    return {mode: 'fallback', reason: 'project-closure-unbounded'} satisfies IncrementalOverlayPreassessment;
  }
  const attributeRepository = input.repositoryAttribution.attribute(new Set(existingPaths));
  const attributeWorkspace = createWorkspaceAttributor(input.admission.workspace);
  const facts = attributeWorkspace(attributeRepository(rawFacts));
  if (!codeGraphIncrementalFactBatchesFitBudget(finalCodeGraphFactBatches(facts))) {
    return {mode: 'fallback', reason: 'fact-budget-expanded'} satisfies IncrementalOverlayPreassessment;
  }
  return {
    baseFileSetFingerprint: base.receipt.fileSetFingerprint,
    closureProjects: plan.projectIds.length,
    committedWorkspace: input.admission.workspace,
    facts,
    files: affectedFiles,
    mode: 'compatible',
    proportionalWork: {
      attributionContextFiles: inventoryReceipt.attributionFiles.length,
      baseFactsLoaded: affectedFiles.length,
      inventoryFilesInspected: currentFiles.length,
      probedDependencyPaths: candidates.length,
    },
    resolutionClosure: 'project',
    ...firstChangedResolutionPublicationAssessment(input.baseFacts, input.currentFacts),
  } satisfies IncrementalOverlayPreassessment;
});

function firstChangedResolutionPublicationAssessment(
  committedFacts: readonly CodeGraphFileFacts[],
  effectiveFacts: readonly CodeGraphFileFacts[],
) {
  const committedById = new Map(committedFacts.flatMap(file => file.symbols).map(symbol => [symbol.id, symbol]));
  const effectiveById = new Map(effectiveFacts.flatMap(file => file.symbols).map(symbol => [symbol.id, symbol]));
  for (const symbol of effectiveById.values()) {
    const committed = committedById.get(symbol.id);
    if (committed && hasSameCodeGraphResolutionSurface([committed], [symbol])) continue;
    const assessment = assessCodeGraphResolutionSymbolPublication(symbol);
    if (assessment.published) return {resolutionPublicationAssessment: assessment} as const;
  }
  for (const symbol of committedById.values()) {
    if (effectiveById.has(symbol.id)) continue;
    const assessment = assessCodeGraphResolutionSymbolPublication(symbol);
    if (assessment.published) return {resolutionPublicationAssessment: assessment} as const;
  }
  return firstResolutionPublicationAssessment(effectiveFacts);
}

function firstResolutionPublicationAssessment(facts: readonly CodeGraphFileFacts[]) {
  for (const symbol of facts.flatMap(file => file.symbols)) {
    if (symbol.exported || symbol.resolutionDomain !== 'typescript') continue;
    return {resolutionPublicationAssessment: assessCodeGraphResolutionSymbolPublication(symbol)} as const;
  }
  return {};
}
