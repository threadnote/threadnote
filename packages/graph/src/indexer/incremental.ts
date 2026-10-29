import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {Effect, Option} from 'effect';
import {createRepositoryFactAttributor} from '../extractor.js';
import {finalCodeGraphFactBatches} from '../fact/budget.js';
import {
  assessProjectClosureSeeds,
  assessProjectFileSetClosureSeeds,
  partitionProjectResolutionSurfaceChanges,
  planProjectIncrementalClosure,
  PROJECT_INCREMENTAL_CLOSURE_MAX_FILES,
  PROJECT_INCREMENTAL_CLOSURE_MAX_SOURCE_BYTES,
  selectProjectIncrementalClosure,
} from '../incremental/closure.js';
import {
  CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_PAYLOAD_BYTES,
  CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_ROWS,
  assessCodeGraphIncrementalFactBytes,
  codeGraphIncrementalFactBatchesFitBudget,
  codeGraphIncrementalWorkFitsBudget,
  measureCodeGraphIncrementalWork,
  planCodeGraphIncrementalFoldForwardPaths,
} from '../incremental/work.js';
import {
  cachedFactsMetadata,
  extractorSetIdentity,
  extractorSetIdentityFromPackProvenance,
  loadCachedFacts,
  loadCachedFactsWithPackProvenance,
} from './materialization.js';
import {inventoryFilesForPaths} from './shared.js';
import type {CommittedBaseResult, IncrementalOverlayAssessment, IncrementalOverlayPreassessment} from './types.js';
import type {CodeGraphInventory} from '../inventory.js';
import {codeGraphInventorySha256Hex} from '../inventory/identity.js';
import {assessCodeGraphLanguagePackDelta} from '../languages/provenance.js';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import type {CodeGraphWorkspace} from '../languages/types.js';
import type {CodeGraphLayout} from '../layout.js';
import {compareCodeUnits} from '../ordering.js';
import {
  assessCodeGraphResolutionSymbolPublication,
  hasSameCodeGraphReexportResolutionSurface,
  hasSameCodeGraphResolutionSurface,
  type CodeGraphResolutionPublicationAssessment,
} from '../resolution/surface.js';
import {
  CODE_GRAPH_RESOLUTION_SURFACE_VERSION,
  CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
  type CodeGraphLanguagePackProvenance,
  type CodeGraphReusableBaseReceipt,
  type CodeGraphReusableBaseReceiptInput,
  type CodeGraphReusableCleanBase,
  type CodeGraphStoreShape,
} from '../store.js';
import {
  assessResolutionCandidateIncrementalClosure,
  assessWorkspaceTransitionIncrementalClosure,
  enrichPersistedTypeScriptReexports,
  reusableReexportSeeds,
} from './resolution_candidate_closure.js';
import {
  type CodeGraphFileFacts,
  type CodeGraphInventoryFile,
  type CodeGraphOverlayFallbackReason,
  type CodeGraphSnapshot,
} from '../types.js';
import {createWorkspaceAttributor} from '../workspace.js';
import {assessCodeGraphWorkspaceCompatibility, sameWorkspaceInventoryFile} from '../workspace/compatibility.js';
import {isRepositoryFactAttributionContextPath} from '../extractor_context.js';
import {codeGraphCommittedContentHash} from '../content_identity.js';

export {resolvePersistedReexportTerminals} from './resolution_candidate_closure.js';

export const assessIncrementalOverlay = Effect.fn('codeGraph.assessIncrementalOverlay')(function* (
  input: {
    readonly building: CodeGraphSnapshot;
    readonly committedBase?: CommittedBaseResult;
    readonly committedBaseReceipt?: CodeGraphReusableBaseReceipt;
    readonly force: boolean;
    readonly incrementalOverlayEnabled?: boolean;
    readonly inventory: CodeGraphInventory;
    readonly languagePacks: CodeGraphLanguagePackRegistryShape;
    readonly layout: CodeGraphLayout;
    readonly store: CodeGraphStoreShape;
    readonly totalFiles?: number;
  },
  workspace: CodeGraphWorkspace,
  suppliedPreassessment?: IncrementalOverlayPreassessment,
) {
  if (input.incrementalOverlayEnabled === false) {
    return {mode: 'fallback', reason: 'disabled'} satisfies IncrementalOverlayAssessment;
  }
  if (input.force) return {mode: 'fallback', reason: 'forced-full-rebuild'} satisfies IncrementalOverlayAssessment;
  const preassessment: IncrementalOverlayPreassessment =
    suppliedPreassessment ??
    (yield* assessIncrementalOverlayCompatibility(
      {
        extractorSet: input.building.extractorSet,
        inventory: input.inventory,
        languagePacks: input.languagePacks,
        layout: input.layout,
        store: input.store,
      },
      workspace,
    ));
  if (preassessment.mode === 'fallback') return preassessment;
  if (!input.committedBase)
    return {mode: 'fallback', reason: 'staging-unavailable'} satisfies IncrementalOverlayAssessment;
  if (
    input.building.extractorSet !== input.committedBase.snapshot.extractorSet &&
    preassessment.extractorTransition !== true
  ) {
    return {mode: 'fallback', reason: 'extractor-context-changed'} satisfies IncrementalOverlayAssessment;
  }
  let reuse: 'persisted-base' | 'staged-base' = 'staged-base';
  if (!input.committedBase.stagingReusable) {
    // Sparse admission already decoded the immutable receipt for this exact
    // leased READY snapshot. Reuse it instead of parsing the repository-sized
    // workspace/attribution payload a second time after scanning completes.
    const suppliedReceipt = input.committedBaseReceipt;
    if (suppliedReceipt !== undefined && suppliedReceipt.snapshotId !== input.committedBase.snapshot.id) {
      return {mode: 'fallback', reason: 'staging-unavailable'} satisfies IncrementalOverlayAssessment;
    }
    const receipt =
      suppliedReceipt ??
      (yield* input.store.reusableBaseReceipt(
        input.layout.databasePath,
        input.committedBase.snapshot.id,
        input.committedBase.snapshot.dirty ? {allowDirtyRoot: true} : undefined,
      ));
    if (
      !receipt ||
      receipt.formatVersion !== CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION ||
      receipt.resolutionSurfaceVersion !== CODE_GRAPH_RESOLUTION_SURFACE_VERSION ||
      receipt.workspaceFingerprint !== preassessment.committedWorkspace.fingerprint ||
      (preassessment.resolutionClosure !== 'full' &&
        receipt.fileSetFingerprint !== preassessment.baseFileSetFingerprint)
    ) {
      return {mode: 'fallback', reason: 'staging-unavailable'} satisfies IncrementalOverlayAssessment;
    }
    reuse = 'persisted-base';
  }
  let reusableFacts = preassessment.facts;
  if (reuse === 'persisted-base' && preassessment.resolutionClosure !== 'full') {
    const affectedPaths =
      preassessment.resolutionClosure === 'project'
        ? new Set(EffectArray.map(preassessment.files, file => file.path))
        : undefined;
    const seeds = EffectArray.filter(
      reusableReexportSeeds(preassessment.facts),
      seed => !affectedPaths?.has(seed.path),
    );
    if (seeds.length > 0) {
      const reexports = yield* input.store.reusableReexports(
        input.layout.databasePath,
        input.committedBase.snapshot.id,
        seeds,
        {allowDirtyRoot: input.committedBase.snapshot.dirty, maxRows: 10_000},
      );
      if (reexports === undefined) {
        return {mode: 'fallback', reason: 'staging-unavailable'} satisfies IncrementalOverlayAssessment;
      }
      if (reexports.length > 10_000) {
        return {mode: 'fallback', reason: 'reexport-closure-unbounded'} satisfies IncrementalOverlayAssessment;
      }
      if (preassessment.resolutionClosure === 'project') {
        if (
          EffectArray.some(
            reexports,
            reexport => affectedPaths!.has(reexport.sourcePath) || affectedPaths!.has(reexport.targetPath),
          )
        ) {
          return {mode: 'fallback', reason: 'project-closure-incomplete'} satisfies IncrementalOverlayAssessment;
        }
      }
      const enrichedFacts = enrichPersistedTypeScriptReexports(preassessment.facts, reexports);
      if (!enrichedFacts) {
        return {mode: 'fallback', reason: 'reexport-closure-unbounded'} satisfies IncrementalOverlayAssessment;
      }
      reusableFacts = enrichedFacts;
    }
  }
  const finalBatches = finalCodeGraphFactBatches(reusableFacts);
  const deletionOnlyProjectClosure =
    reusableFacts.length === 0 &&
    (preassessment.deletedPaths?.length ?? 0) > 0 &&
    preassessment.resolutionClosure === 'project';
  if (!deletionOnlyProjectClosure && !codeGraphIncrementalFactBatchesFitBudget(finalBatches)) {
    return {mode: 'fallback', reason: 'fact-budget-expanded'} satisfies IncrementalOverlayAssessment;
  }
  const facts = EffectArray.flatMap(finalBatches, batch => EffectArray.map(batch, value => value.facts));
  const work = measureCodeGraphIncrementalWork({
    deletedPaths: preassessment.deletedPaths,
    facts,
    files: preassessment.files,
    observation: preassessment.proportionalWork,
    totalFiles: input.totalFiles ?? input.inventory.files.length,
  });
  if (!codeGraphIncrementalWorkFitsBudget(work)) {
    return {mode: 'fallback', reason: 'incremental-rewrite-unbounded'} satisfies IncrementalOverlayAssessment;
  }
  if (input.committedBase.foldForward) {
    const foldForwardPathPlan = planCodeGraphIncrementalFoldForwardPaths(
      input.committedBase.foldForward.priorDeltaPaths,
      [...EffectArray.map(preassessment.files, file => file.path), ...(preassessment.deletedPaths ?? [])],
    );
    if (
      !foldForwardPathPlan ||
      input.committedBase.foldForward.priorStagedRows + work.plannedRows >
        CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_ROWS ||
      input.committedBase.foldForward.priorStagedPayloadBytes + work.factBytes >
        CODE_GRAPH_INCREMENTAL_FOLD_FORWARD_MAX_PAYLOAD_BYTES
    ) {
      return {mode: 'fallback', reason: 'incremental-rewrite-unbounded'} satisfies IncrementalOverlayAssessment;
    }
  }
  return {
    closureProjects: preassessment.closureProjects,
    deletedPaths: preassessment.deletedPaths,
    facts,
    files: preassessment.files,
    mode: 'eligible',
    resolutionClosure: preassessment.resolutionClosure,
    resolutionPublicationAssessment: preassessment.resolutionPublicationAssessment,
    reuse,
    work,
  } satisfies IncrementalOverlayAssessment;
});

export const assessIncrementalOverlayCompatibility = Effect.fn('codeGraph.assessIncrementalOverlayCompatibility')(
  function* (
    input: {
      readonly extractorSet: string;
      readonly inventory: CodeGraphInventory;
      readonly languagePacks: CodeGraphLanguagePackRegistryShape;
      readonly layout: CodeGraphLayout;
      readonly store: CodeGraphStoreShape;
    },
    workspace: CodeGraphWorkspace,
  ) {
    if (input.extractorSet !== extractorSetIdentity(input.inventory.committedFiles, input.languagePacks)) {
      return {mode: 'fallback', reason: 'extractor-context-changed'} satisfies IncrementalOverlayPreassessment;
    }
    const committedWorkspace =
      input.inventory.workspace ?? (yield* input.languagePacks.discoverWorkspace(input.inventory.committedFiles));
    const committedByPath = new Map(EffectArray.map(input.inventory.committedFiles, file => [file.path, file]));
    const effectiveByPath = new Map(EffectArray.map(input.inventory.files, file => [file.path, file]));
    const deletedFiles = EffectArray.filter(input.inventory.committedFiles, file => !effectiveByPath.has(file.path));
    const deletedPaths = EffectArray.map(deletedFiles, file => file.path);
    const modifiedFiles = EffectArray.filter(input.inventory.files, file => {
      const committed = committedByPath.get(file.path);
      return (
        committed === undefined ||
        committed.contentHash !== file.contentHash ||
        committed.language !== file.language ||
        committed.mode !== file.mode ||
        committed.size !== file.size ||
        committed.source !== file.source
      );
    });
    if (modifiedFiles.length === 0 && deletedPaths.length === 0) {
      return {mode: 'fallback', reason: 'no-materialized-changes'} satisfies IncrementalOverlayPreassessment;
    }
    const workspaceCompatibility = assessCodeGraphWorkspaceCompatibility(committedWorkspace, workspace);
    if (workspaceCompatibility.mode === 'fallback') {
      return yield* assessWorkspaceTransitionIncrementalClosure({
        baseFiles: input.inventory.committedFiles,
        baseFileSetFingerprint: reusableBaseFileSetFingerprint(input.inventory.committedFiles),
        committedWorkspace,
        currentChangedFiles: modifiedFiles,
        currentFiles: input.inventory.files,
        currentWorkspace: workspace,
        languagePacks: input.languagePacks,
        layout: input.layout,
        store: input.store,
      });
    }
    if (deletedPaths.length > 0 || EffectArray.some(modifiedFiles, file => !committedByPath.has(file.path))) {
      return yield* assessProjectFileSetIncrementalClosureCompatibility({
        baseFiles: input.inventory.committedFiles,
        baseFileSetFingerprint: reusableBaseFileSetFingerprint(input.inventory.committedFiles),
        baseWorkspace: committedWorkspace,
        currentChangedFiles: modifiedFiles,
        currentFiles: input.inventory.files,
        currentWorkspace: workspace,
        deletedFiles,
        languagePacks: input.languagePacks,
        layout: input.layout,
        store: input.store,
        workspaceSeedProjectIds:
          workspaceCompatibility.mode === 'project-closure' ? workspaceCompatibility.seedProjectIds : [],
      });
    }
    const committedFiles = EffectArray.map(modifiedFiles, file => committedByPath.get(file.path)!);
    const changedDecodeBudget = yield* assessProjectClosureChangedDecodeBudget({
      baseFiles: committedFiles,
      currentFiles: modifiedFiles,
      databasePath: input.layout.databasePath,
      languagePacks: input.languagePacks,
      store: input.store,
    });
    if (changedDecodeBudget.mode === 'fallback') return changedDecodeBudget;
    const [committedCache, effectiveCache] = yield* Effect.all(
      [
        loadCachedFacts(input.store, input.layout.databasePath, committedFiles, input.languagePacks),
        loadCachedFacts(input.store, input.layout.databasePath, modifiedFiles, input.languagePacks),
      ],
      {concurrency: 1},
    );
    if (
      EffectArray.some(committedFiles, file => !committedCache.facts.has(file.path)) ||
      EffectArray.some(modifiedFiles, file => !effectiveCache.facts.has(file.path))
    ) {
      return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
    }
    const committedRawFacts = EffectArray.map(committedFiles, file =>
      input.languagePacks.postprocessFile(file, committedCache.facts.get(file.path)!),
    );
    const effectiveRawFacts = EffectArray.map(modifiedFiles, file =>
      input.languagePacks.postprocessFile(file, effectiveCache.facts.get(file.path)!),
    );
    const committedFacts = attributeInventoryFacts(
      input.inventory.committedFiles,
      committedWorkspace,
      committedRawFacts,
    );
    const effectiveFacts = attributeInventoryFacts(input.inventory.files, workspace, effectiveRawFacts);
    const committedFactsByPath = new Map(EffectArray.map(committedFacts, file => [file.path, file]));
    const resolutionSurfaceChanged = EffectArray.some(effectiveFacts, file => {
      const committed = committedFactsByPath.get(file.path);
      return !committed || !hasSameCodeGraphResolutionSurface(committed.symbols, file.symbols);
    });
    const resolutionPublicationAssessment = resolutionSurfaceChanged
      ? (firstChangedResolutionPublicationAssessment(committedFacts, effectiveFacts) ??
        firstResolutionPublicationAssessment(effectiveFacts))
      : firstResolutionPublicationAssessment(effectiveFacts);
    const reexportResolutionSurfaceChanged = !hasSameCodeGraphReexportResolutionSurface(
      EffectArray.flatMap(committedFacts, file => file.references ?? []),
      EffectArray.flatMap(effectiveFacts, file => file.references ?? []),
    );
    if (!reexportResolutionSurfaceChanged && !resolutionSurfaceChanged && workspaceCompatibility.mode === 'unchanged') {
      if (!codeGraphIncrementalFactBatchesFitBudget(finalCodeGraphFactBatches(effectiveFacts))) {
        return {mode: 'fallback', reason: 'fact-budget-expanded'} satisfies IncrementalOverlayPreassessment;
      }
      return {
        baseFileSetFingerprint: reusableBaseFileSetFingerprint(input.inventory.committedFiles),
        committedWorkspace,
        facts: effectiveFacts,
        files: modifiedFiles,
        mode: 'compatible',
        ...(resolutionPublicationAssessment ? {resolutionPublicationAssessment} : {}),
      } satisfies IncrementalOverlayPreassessment;
    }
    const closure = yield* assessProjectIncrementalClosureCompatibility({
      baseFiles: input.inventory.committedFiles,
      baseFileSetFingerprint: reusableBaseFileSetFingerprint(input.inventory.committedFiles),
      baseWorkspace: committedWorkspace,
      changedBaseFacts: committedFacts,
      changedCurrentFacts: effectiveFacts,
      currentChangedFiles: modifiedFiles,
      currentFiles: input.inventory.files,
      currentWorkspace: workspace,
      languagePacks: input.languagePacks,
      layout: input.layout,
      store: input.store,
      workspaceSeedProjectIds:
        workspaceCompatibility.mode === 'project-closure' ? workspaceCompatibility.seedProjectIds : [],
    });
    return resolutionPublicationAssessment ? {...closure, resolutionPublicationAssessment} : closure;
  },
);

export const assessReusableCleanBaseCompatibility = Effect.fn('codeGraph.assessReusableCleanBaseCompatibility')(
  function* (
    input: {
      readonly candidate: CodeGraphReusableCleanBase;
      readonly inventory: CodeGraphInventory;
      readonly languagePacks: CodeGraphLanguagePackRegistryShape;
      readonly layout: CodeGraphLayout;
      readonly store: CodeGraphStoreShape;
    },
    workspace: CodeGraphWorkspace,
    modifiedFiles: readonly CodeGraphInventoryFile[],
  ) {
    const currentExtractorSet = extractorSetIdentity(input.inventory.files, input.languagePacks);
    const extractorTransition = input.candidate.snapshot.extractorSet !== currentExtractorSet;
    const packDelta = extractorTransition
      ? assessCodeGraphLanguagePackDelta(
          input.candidate.receipt.packProvenance,
          input.languagePacks.activePackProvenance(EffectArray.map(input.inventory.files, file => file.path)),
        )
      : ({changedPackIds: [], mode: 'compatible'} as const);
    if (
      packDelta.mode === 'fallback' ||
      (extractorTransition &&
        input.candidate.snapshot.extractorSet !==
          extractorSetIdentityFromPackProvenance(input.candidate.receipt.packProvenance))
    ) {
      return {mode: 'fallback', reason: 'extractor-context-changed'} satisfies IncrementalOverlayPreassessment;
    }
    const baseWorkspace = input.candidate.receipt.inventory?.workspace;
    if (input.candidate.receipt.workspaceFingerprint !== workspace.fingerprint && baseWorkspace === undefined) {
      return {mode: 'fallback', reason: 'workspace-changed'} satisfies IncrementalOverlayPreassessment;
    }
    const committedWorkspace = baseWorkspace ?? workspace;
    const workspaceCompatibility = assessCodeGraphWorkspaceCompatibility(committedWorkspace, workspace);
    if (workspaceCompatibility.mode === 'fallback') {
      if (
        extractorTransition ||
        baseWorkspace === undefined ||
        input.candidate.receipt.workspaceFingerprint !== baseWorkspace.fingerprint
      )
        return workspaceCompatibility;
      const contexts = input.candidate.receipt.inventory?.attributionFiles;
      if (contexts === undefined) return workspaceCompatibility;
      const contextByPath = new Map(EffectArray.map(contexts, file => [file.path, file]));
      const baseByPath = new Map(EffectArray.map(input.candidate.files, file => [file.path, file]));
      if (
        contextByPath.size !== contexts.length ||
        EffectArray.some(contexts, file => {
          const base = baseByPath.get(file.path);
          return (
            !base ||
            !isRepositoryFactAttributionContextPath(file.path) ||
            !input.languagePacks.isResolutionContext(file.path) ||
            file.source !== 'commit' ||
            !sameWorkspaceInventoryFile(base, {...file, size: base.size}) ||
            (base.blobId !== undefined &&
              base.blobId !== `snapshot:${base.contentHash}` &&
              base.blobId !== file.blobId) ||
            file.blobId === undefined ||
            !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(file.blobId) ||
            codeGraphCommittedContentHash(file.blobId.length === 64 ? 'sha256' : 'sha1', file.blobId) !==
              file.contentHash ||
            file.size !== Buffer.byteLength(file.content, 'utf8')
          );
        })
      )
        return workspaceCompatibility;
      // Receipt bodies are compact resolver inputs; retain original source sizes
      // and source hashes instead of mistaking compact bytes for the Git blob.
      const baseFiles = EffectArray.map(input.candidate.files, file =>
        contextByPath.has(file.path) ? {...file, content: contextByPath.get(file.path)!.content} : file,
      );
      if (
        EffectArray.some(
          baseFiles,
          file => isRepositoryFactAttributionContextPath(file.path) && file.content === undefined,
        )
      )
        return workspaceCompatibility;
      return yield* assessWorkspaceTransitionIncrementalClosure({
        baseFiles,
        baseFileSetFingerprint: reusableBaseFileSetFingerprint(input.candidate.files),
        committedWorkspace,
        currentChangedFiles: modifiedFiles,
        currentFiles: input.inventory.files,
        currentWorkspace: workspace,
        languagePacks: input.languagePacks,
        layout: input.layout,
        store: input.store,
      });
    }
    const workspaceSeedProjectIds =
      workspaceCompatibility.mode === 'project-closure' ? workspaceCompatibility.seedProjectIds : [];
    const currentPaths = new Set(EffectArray.map(input.inventory.files, file => file.path));
    const deletedFiles = EffectArray.filter(input.candidate.files, file => !currentPaths.has(file.path));
    const deletedPaths = EffectArray.map(deletedFiles, file => file.path);
    if (modifiedFiles.length === 0 && deletedPaths.length === 0) {
      return {mode: 'fallback', reason: 'no-materialized-changes'} satisfies IncrementalOverlayPreassessment;
    }
    const baseByPath = new Map(EffectArray.map(input.candidate.files, file => [file.path, file]));
    if (deletedPaths.length > 0 || EffectArray.some(modifiedFiles, file => !baseByPath.has(file.path))) {
      if (extractorTransition) {
        return {mode: 'fallback', reason: 'extractor-context-changed'} satisfies IncrementalOverlayPreassessment;
      }
      return yield* assessProjectFileSetIncrementalClosureCompatibility({
        baseFiles: input.candidate.files,
        baseFileSetFingerprint: reusableBaseFileSetFingerprint(input.candidate.files),
        baseWorkspace: committedWorkspace,
        currentChangedFiles: modifiedFiles,
        currentFiles: input.inventory.files,
        currentWorkspace: workspace,
        deletedFiles,
        languagePacks: input.languagePacks,
        layout: input.layout,
        store: input.store,
        workspaceSeedProjectIds,
      });
    }
    const baseFiles = inventoryFilesForPaths(
      input.candidate.files,
      EffectArray.map(modifiedFiles, file => file.path),
    );
    if (!baseFiles) {
      return {mode: 'fallback', reason: 'file-set-changed'} satisfies IncrementalOverlayPreassessment;
    }
    const changedDecodeBudget = extractorTransition
      ? projectClosureSourceBudgetFits(baseFiles) && projectClosureSourceBudgetFits(modifiedFiles)
        ? ({mode: 'eligible'} as const)
        : ({mode: 'fallback', reason: 'project-closure-unbounded'} as const)
      : yield* assessProjectClosureChangedDecodeBudget({
          baseFiles,
          currentFiles: modifiedFiles,
          databasePath: input.layout.databasePath,
          languagePacks: input.languagePacks,
          store: input.store,
        });
    if (changedDecodeBudget.mode === 'fallback') return changedDecodeBudget;
    const [baseCache, currentCache] = yield* Effect.all(
      [
        extractorTransition
          ? loadCachedFactsWithPackProvenance(
              input.store,
              input.layout.databasePath,
              baseFiles,
              input.languagePacks,
              input.candidate.receipt.packProvenance,
            )
          : loadCachedFacts(input.store, input.layout.databasePath, baseFiles, input.languagePacks),
        loadCachedFacts(input.store, input.layout.databasePath, modifiedFiles, input.languagePacks),
      ],
      {concurrency: 1},
    );
    if (
      EffectArray.some(baseFiles, file => !baseCache.facts.has(file.path)) ||
      EffectArray.some(modifiedFiles, file => !currentCache.facts.has(file.path))
    ) {
      return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
    }
    if (extractorTransition) {
      const baseBudget = projectClosureCachedFactBudgetFallback(baseCache, baseFiles.length);
      if (baseBudget !== undefined) return baseBudget;
      const currentBudget = projectClosureCachedFactBudgetFallback(currentCache, modifiedFiles.length);
      if (currentBudget !== undefined) return currentBudget;
    }
    const baseRawFacts = EffectArray.map(baseFiles, file =>
      input.languagePacks.postprocessFile(file, baseCache.facts.get(file.path)!),
    );
    const currentRawFacts = EffectArray.map(modifiedFiles, file =>
      input.languagePacks.postprocessFile(file, currentCache.facts.get(file.path)!),
    );
    const baseFacts = attributeInventoryFacts(input.candidate.files, committedWorkspace, baseRawFacts);
    const currentFacts = attributeInventoryFacts(input.inventory.files, workspace, currentRawFacts);
    const baseFactsByPath = new Map(EffectArray.map(baseFacts, file => [file.path, file]));
    const resolutionSurfaceChanged = EffectArray.some(currentFacts, file => {
      const base = baseFactsByPath.get(file.path);
      return !base || !hasSameCodeGraphResolutionSurface(base.symbols, file.symbols);
    });
    const resolutionPublicationAssessment = resolutionSurfaceChanged
      ? (firstChangedResolutionPublicationAssessment(baseFacts, currentFacts) ??
        firstResolutionPublicationAssessment(currentFacts))
      : firstResolutionPublicationAssessment(currentFacts);
    const reexportResolutionSurfaceChanged = !hasSameCodeGraphReexportResolutionSurface(
      EffectArray.flatMap(baseFacts, file => file.references ?? []),
      EffectArray.flatMap(currentFacts, file => file.references ?? []),
    );
    if (reexportResolutionSurfaceChanged || resolutionSurfaceChanged || workspaceSeedProjectIds.length > 0) {
      const closure = yield* assessProjectIncrementalClosureCompatibility({
        baseFiles: input.candidate.files,
        baseFileSetFingerprint: reusableBaseFileSetFingerprint(input.candidate.files),
        baseWorkspace: committedWorkspace,
        changedBaseFacts: baseFacts,
        changedCurrentFacts: currentFacts,
        currentChangedFiles: modifiedFiles,
        currentFiles: input.inventory.files,
        currentWorkspace: workspace,
        languagePacks: input.languagePacks,
        layout: input.layout,
        store: input.store,
        workspaceSeedProjectIds,
      });
      const result =
        closure.mode === 'compatible' && extractorTransition
          ? {...closure, extractorTransition: true as const}
          : closure;
      return resolutionPublicationAssessment ? {...result, resolutionPublicationAssessment} : result;
    }
    if (!codeGraphIncrementalFactBatchesFitBudget(finalCodeGraphFactBatches(currentFacts))) {
      return {mode: 'fallback', reason: 'fact-budget-expanded'} satisfies IncrementalOverlayPreassessment;
    }
    // Incremental facts are attributed from a candidate-specific subset. They
    // must not populate the full-materialization shard namespace: different
    // bases can otherwise union into a falsely complete deterministic batch.
    return {
      baseFileSetFingerprint: reusableBaseFileSetFingerprint(input.candidate.files),
      committedWorkspace,
      ...(extractorTransition ? {extractorTransition: true as const} : {}),
      facts: currentFacts,
      files: modifiedFiles,
      mode: 'compatible',
      ...(resolutionPublicationAssessment ? {resolutionPublicationAssessment} : {}),
    } satisfies IncrementalOverlayPreassessment;
  },
);

const assessProjectIncrementalClosureCompatibility = Effect.fn(
  'codeGraph.assessProjectIncrementalClosureCompatibility',
)(function* (input: {
  readonly baseFiles: readonly CodeGraphInventoryFile[];
  readonly baseFileSetFingerprint: string;
  readonly baseWorkspace: CodeGraphWorkspace;
  readonly changedBaseFacts: readonly CodeGraphFileFacts[];
  readonly changedCurrentFacts: readonly CodeGraphFileFacts[];
  readonly currentChangedFiles: readonly CodeGraphInventoryFile[];
  readonly currentFiles: readonly CodeGraphInventoryFile[];
  readonly currentWorkspace: CodeGraphWorkspace;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly layout: CodeGraphLayout;
  readonly store: CodeGraphStoreShape;
  readonly workspaceSeedProjectIds: readonly string[];
}) {
  const seeds = assessProjectClosureSeeds({
    committedFacts: input.changedBaseFacts,
    effectiveFacts: input.changedCurrentFacts,
    projects: input.currentWorkspace.projects,
  });
  if (seeds.mode === 'fallback') {
    return seeds satisfies IncrementalOverlayPreassessment;
  }
  if (seeds.candidateScanRequired) {
    if (input.workspaceSeedProjectIds.length > 0 || (seeds.candidateLookupKeys?.length ?? 0) === 0) {
      return {mode: 'fallback', reason: 'resolution-surface-changed'} satisfies IncrementalOverlayPreassessment;
    }
    return yield* assessResolutionCandidateIncrementalClosure({
      baseFileSetFingerprint: input.baseFileSetFingerprint,
      baseFiles: input.baseFiles,
      candidateReexports: seeds.candidateReexports ?? [],
      committedWorkspace: input.baseWorkspace,
      currentChangedFiles: input.currentChangedFiles,
      currentFiles: input.currentFiles,
      currentWorkspace: input.currentWorkspace,
      initialLookupKeys: seeds.candidateLookupKeys!,
      languagePacks: input.languagePacks,
      layout: input.layout,
      projectCount: seeds.seedProjectIds.length,
      store: input.store,
    });
  }
  const seedProjectIds = [...new Set([...seeds.seedProjectIds, ...input.workspaceSeedProjectIds])].sort(
    compareCodeUnits,
  );
  const planned = yield* assessPlannedProjectIncrementalClosure({
    baseFileSetFingerprint: input.baseFileSetFingerprint,
    committedWorkspace: input.baseWorkspace,
    currentChangedFiles: input.currentChangedFiles,
    currentFiles: input.currentFiles,
    currentWorkspace: input.currentWorkspace,
    languagePacks: input.languagePacks,
    layout: input.layout,
    seedProjectIds,
    store: input.store,
  });
  if (
    planned.mode !== 'fallback' ||
    planned.reason !== 'project-closure-unbounded' ||
    (seeds.candidateLookupKeys?.length ?? 0) === 0 ||
    input.workspaceSeedProjectIds.length > 0
  ) {
    return planned;
  }
  return yield* assessResolutionCandidateIncrementalClosure({
    baseFileSetFingerprint: input.baseFileSetFingerprint,
    baseFiles: input.baseFiles,
    committedWorkspace: input.baseWorkspace,
    currentChangedFiles: input.currentChangedFiles,
    currentFiles: input.currentFiles,
    currentWorkspace: input.currentWorkspace,
    initialLookupKeys: seeds.candidateLookupKeys!,
    candidateReexports: seeds.candidateReexports ?? [],
    languagePacks: input.languagePacks,
    layout: input.layout,
    projectCount: seedProjectIds.length,
    store: input.store,
  });
});

const assessProjectFileSetIncrementalClosureCompatibility = Effect.fn(
  'codeGraph.assessProjectFileSetIncrementalClosureCompatibility',
)(function* (input: {
  readonly baseFiles: readonly CodeGraphInventoryFile[];
  readonly baseFileSetFingerprint: string;
  readonly baseWorkspace: CodeGraphWorkspace;
  readonly currentChangedFiles: readonly CodeGraphInventoryFile[];
  readonly currentFiles: readonly CodeGraphInventoryFile[];
  readonly currentWorkspace: CodeGraphWorkspace;
  readonly deletedFiles: readonly CodeGraphInventoryFile[];
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly layout: CodeGraphLayout;
  readonly store: CodeGraphStoreShape;
  readonly workspaceSeedProjectIds: readonly string[];
}) {
  if (input.baseWorkspace.projects.length === 0 || input.currentWorkspace.projects.length === 0) {
    return {mode: 'fallback', reason: 'file-set-changed'} satisfies IncrementalOverlayPreassessment;
  }
  const baseByPath = new Map(EffectArray.map(input.baseFiles, file => [file.path, file]));
  const addedFiles = EffectArray.filter(input.currentChangedFiles, file => !baseByPath.has(file.path));
  const existingModifiedFiles = EffectArrayPipe(input.currentChangedFiles, __effectArrayValues =>
    EffectArray.filter(
      __effectArrayValues,
      (file, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && baseByPath.has(file.path),
    ),
  );
  const seeds = assessProjectFileSetClosureSeeds({
    baseProjects: input.baseWorkspace.projects,
    currentChangedPaths: EffectArray.map(addedFiles, file => file.path),
    currentProjects: input.currentWorkspace.projects,
    currentResolutionDomainByPath: projectClosureResolutionDomainByPath(addedFiles, input.languagePacks),
    deletedPaths: EffectArray.map(input.deletedFiles, file => file.path),
    deletedResolutionDomainByPath: projectClosureResolutionDomainByPath(input.deletedFiles, input.languagePacks),
  });
  if (seeds.mode === 'fallback') {
    return {
      ...(seeds.fallbackDetail === undefined
        ? {}
        : {
            fallbackAssessment: {
              addedFiles: addedFiles.length,
              changedFiles: input.currentChangedFiles.length,
              deletedFiles: input.deletedFiles.length,
              detail: seeds.fallbackDetail,
              stage: 'file-set-seed-assessment' as const,
            },
          }),
      mode: 'fallback',
      reason: seeds.reason,
    } satisfies IncrementalOverlayPreassessment;
  }
  const modificationSeeds = yield* assessExistingProjectModificationSeeds({
    baseFiles: input.baseFiles,
    baseWorkspace: input.baseWorkspace,
    currentFiles: input.currentFiles,
    currentModifiedFiles: existingModifiedFiles,
    currentWorkspace: input.currentWorkspace,
    languagePacks: input.languagePacks,
    layout: input.layout,
    store: input.store,
  });
  if (modificationSeeds.mode === 'fallback') return modificationSeeds;
  const unownedResolutionDomains = seeds.unownedResolutionDomains ?? [];
  const fileSetResolutionSeeds =
    unownedResolutionDomains.length === 0
      ? undefined
      : yield* assessAddedProjectResolutionSeeds({
          addedFiles: EffectArray.filter(addedFiles, file =>
            unownedResolutionDomains.includes(
              projectClosureResolutionDomainByPath([file], input.languagePacks).get(file.path) ?? '',
            ),
          ),
          deletedFiles: EffectArrayPipe(input.deletedFiles, __effectArrayValues2 =>
            EffectArray.filter(
              __effectArrayValues2,
              (file, __effectArrayIndex2) =>
                __effectArrayIndex2 in __effectArrayValues2 &&
                unownedResolutionDomains.includes(
                  projectClosureResolutionDomainByPath([file], input.languagePacks).get(file.path) ?? '',
                ),
            ),
          ),
          currentFiles: input.currentFiles,
          currentWorkspace: input.currentWorkspace,
          languagePacks: input.languagePacks,
          layout: input.layout,
          store: input.store,
        });
  if (fileSetResolutionSeeds?.mode === 'fallback') return fileSetResolutionSeeds;
  const seedProjectIds = [
    ...new Set([...seeds.seedProjectIds, ...modificationSeeds.seedProjectIds, ...input.workspaceSeedProjectIds]),
  ].sort(compareCodeUnits);
  const planned = yield* assessPlannedProjectIncrementalClosure({
    baseFileSetFingerprint: input.baseFileSetFingerprint,
    committedWorkspace: input.baseWorkspace,
    currentChangedFiles: input.currentChangedFiles,
    currentFiles: input.currentFiles,
    currentWorkspace: input.currentWorkspace,
    deletedPaths: EffectArray.map(input.deletedFiles, file => file.path),
    languagePacks: input.languagePacks,
    layout: input.layout,
    seedProjectIds,
    store: input.store,
  });
  const candidateLookupKeys = [
    ...(modificationSeeds.candidateLookupKeys ?? []),
    ...(fileSetResolutionSeeds?.candidateLookupKeys ?? []),
  ];
  const candidateReexports = [
    ...(modificationSeeds.candidateReexports ?? []),
    ...(fileSetResolutionSeeds?.candidateReexports ?? []),
  ];
  if (unownedResolutionDomains.length > 0 || modificationSeeds.candidateScanRequired) {
    const pureUnownedCandidate =
      seedProjectIds.length === 0 &&
      input.baseWorkspace.diagnostics.length === 0 &&
      input.currentWorkspace.diagnostics.length === 0 &&
      planned.mode === 'fallback' &&
      planned.reason === 'project-closure-incomplete';
    const zeroPublicationUnownedFileSet =
      pureUnownedCandidate &&
      existingModifiedFiles.length === 0 &&
      candidateLookupKeys.length === 0 &&
      candidateReexports.length === 0 &&
      fileSetResolutionSeeds?.mode === 'eligible';
    if (zeroPublicationUnownedFileSet) {
      return zeroPublicationUnownedFileSetCompatibility({
        addedFiles,
        baseFileSetFingerprint: input.baseFileSetFingerprint,
        committedWorkspace: input.baseWorkspace,
        deletedPaths: EffectArray.map(input.deletedFiles, file => file.path),
        facts: fileSetResolutionSeeds.currentFacts,
      });
    }
    if ((planned.mode === 'compatible' || pureUnownedCandidate) && candidateLookupKeys.length > 0) {
      const candidate = yield* assessResolutionCandidateIncrementalClosure({
        baseAttributionContext: {files: input.currentFiles, workspace: input.currentWorkspace},
        baseFileSetFingerprint: input.baseFileSetFingerprint,
        baseFiles: input.baseFiles,
        candidateReexports,
        committedWorkspace: input.baseWorkspace,
        currentChangedFiles: input.currentChangedFiles,
        currentFiles: input.currentFiles,
        currentWorkspace: input.currentWorkspace,
        initialLookupKeys: candidateLookupKeys,
        languagePacks: input.languagePacks,
        layout: input.layout,
        projectCount: planned.mode === 'compatible' ? (planned.closureProjects ?? 0) : 0,
        ...(planned.mode === 'compatible' ? {requiredFiles: planned.files} : {}),
        deletedPaths: EffectArray.map(input.deletedFiles, file => file.path),
        store: input.store,
      });
      if (candidate.mode === 'compatible') return candidate;
      if (unownedResolutionDomains.length === 0 || candidate.reason !== 'project-closure-incomplete') {
        return candidate;
      }
      return {
        ...candidate,
        fallbackAssessment: {
          addedFiles: addedFiles.length,
          changedFiles: input.currentChangedFiles.length,
          deletedFiles: input.deletedFiles.length,
          detail: 'resolution-domain-unowned',
          stage: 'file-set-seed-assessment',
          unownedResolutionDomainFiles:
            EffectArrayPipe(input.currentChangedFiles, __effectArrayValues2 =>
              EffectArray.filter(
                __effectArrayValues2,
                (file, __effectArrayIndex2) =>
                  __effectArrayIndex2 in __effectArrayValues2 &&
                  unownedResolutionDomains.includes(
                    projectClosureResolutionDomainByPath([file], input.languagePacks).get(file.path) ?? '',
                  ),
              ),
            ).length +
            EffectArrayPipe(input.deletedFiles, __effectArrayValues2 =>
              EffectArray.filter(
                __effectArrayValues2,
                (file, __effectArrayIndex2) =>
                  __effectArrayIndex2 in __effectArrayValues2 &&
                  unownedResolutionDomains.includes(
                    projectClosureResolutionDomainByPath([file], input.languagePacks).get(file.path) ?? '',
                  ),
              ),
            ).length,
          unownedResolutionDomains,
        },
      } satisfies IncrementalOverlayPreassessment;
    }
    return planned;
  }
  if (
    planned.mode !== 'fallback' ||
    planned.reason !== 'project-closure-unbounded' ||
    input.deletedFiles.length > 0 ||
    input.workspaceSeedProjectIds.length > 0
  ) {
    return planned;
  }
  const additionSeeds = yield* assessAddedProjectResolutionSeeds({
    addedFiles,
    currentFiles: input.currentFiles,
    currentWorkspace: input.currentWorkspace,
    languagePacks: input.languagePacks,
    layout: input.layout,
    store: input.store,
  });
  if (additionSeeds.mode === 'fallback') return planned;
  return yield* assessResolutionCandidateIncrementalClosure({
    // Added modules can make previously unresolved base references
    // resolvable. Re-attribute cached base facts against the current bounded
    // file context so the candidate projection selects those consumers.
    baseAttributionContext: {files: input.currentFiles, workspace: input.currentWorkspace},
    baseFileSetFingerprint: input.baseFileSetFingerprint,
    baseFiles: input.baseFiles,
    candidateReexports: [...(modificationSeeds.candidateReexports ?? []), ...(additionSeeds.candidateReexports ?? [])],
    committedWorkspace: input.baseWorkspace,
    currentChangedFiles: input.currentChangedFiles,
    currentFiles: input.currentFiles,
    currentWorkspace: input.currentWorkspace,
    initialLookupKeys: [...(modificationSeeds.candidateLookupKeys ?? []), ...(additionSeeds.candidateLookupKeys ?? [])],
    languagePacks: input.languagePacks,
    layout: input.layout,
    projectCount: seedProjectIds.length,
    store: input.store,
  });
});

const assessAddedProjectResolutionSeeds = Effect.fn('codeGraph.assessAddedProjectResolutionSeeds')(function* (input: {
  readonly addedFiles: readonly CodeGraphInventoryFile[];
  readonly deletedFiles?: readonly CodeGraphInventoryFile[];
  readonly currentFiles: readonly CodeGraphInventoryFile[];
  readonly currentWorkspace: CodeGraphWorkspace;
  readonly languagePacks: CodeGraphLanguagePackRegistryShape;
  readonly layout: CodeGraphLayout;
  readonly store: CodeGraphStoreShape;
}) {
  const deletedFiles = input.deletedFiles ?? [];
  if (!projectClosureSourceBudgetFits([...input.addedFiles, ...deletedFiles])) {
    return {mode: 'fallback', reason: 'project-closure-unbounded'} satisfies IncrementalOverlayPreassessment;
  }
  const [currentMetadata, deletedMetadata] = yield* Effect.all(
    [
      cachedFactsMetadata(input.store, input.layout.databasePath, input.addedFiles, input.languagePacks),
      cachedFactsMetadata(input.store, input.layout.databasePath, deletedFiles, input.languagePacks),
    ],
    {concurrency: 1},
  );
  if (
    currentMetadata.files !== input.addedFiles.length ||
    currentMetadata.bytesByPath.size !== input.addedFiles.length ||
    deletedMetadata.files !== deletedFiles.length ||
    deletedMetadata.bytesByPath.size !== deletedFiles.length
  ) {
    return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
  }
  const combinedBudget = projectClosureCombinedCachedFactBudgetFallback(
    [currentMetadata, deletedMetadata],
    input.addedFiles.length + deletedFiles.length,
  );
  if (combinedBudget !== undefined) return combinedBudget;
  const [currentCache, deletedCache] = yield* Effect.all(
    [
      loadCachedFacts(input.store, input.layout.databasePath, input.addedFiles, input.languagePacks),
      loadCachedFacts(input.store, input.layout.databasePath, deletedFiles, input.languagePacks),
    ],
    {concurrency: 1},
  );
  if (
    EffectArray.some(input.addedFiles, file => !currentCache.facts.has(file.path)) ||
    EffectArray.some(deletedFiles, file => !deletedCache.facts.has(file.path))
  ) {
    return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
  }
  const currentRawFacts = EffectArray.map(input.addedFiles, file =>
    input.languagePacks.postprocessFile(file, currentCache.facts.get(file.path)!),
  );
  const currentFacts = attributeInventoryFacts(input.currentFiles, input.currentWorkspace, currentRawFacts);
  const deletedRawFacts = EffectArray.map(deletedFiles, file =>
    input.languagePacks.postprocessFile(file, deletedCache.facts.get(file.path)!),
  );
  const deletedFacts = attributeInventoryFacts(input.currentFiles, input.currentWorkspace, deletedRawFacts);
  const emptyFacts = (facts: readonly CodeGraphFileFacts[]) =>
    EffectArray.map(facts, (facts): CodeGraphFileFacts => ({
      diagnostics: [],
      edges: [],
      path: facts.path,
      references: [],
      symbols: [],
    }));
  const seeds = assessProjectClosureSeeds({
    committedFacts: [...emptyFacts(currentFacts), ...deletedFacts],
    effectiveFacts: [...currentFacts, ...emptyFacts(deletedFacts)],
    projects: input.currentWorkspace.projects,
  });
  return seeds.mode === 'fallback' ? seeds : {...seeds, currentFacts};
});

function zeroPublicationUnownedFileSetCompatibility(input: {
  readonly addedFiles: readonly CodeGraphInventoryFile[];
  readonly baseFileSetFingerprint: string;
  readonly committedWorkspace: CodeGraphWorkspace;
  readonly deletedPaths: readonly string[];
  readonly facts: readonly CodeGraphFileFacts[];
}): IncrementalOverlayPreassessment {
  const deletionOnly = input.facts.length === 0 && input.deletedPaths.length > 0;
  if (!deletionOnly && !codeGraphIncrementalFactBatchesFitBudget(finalCodeGraphFactBatches(input.facts))) {
    return {mode: 'fallback', reason: 'fact-budget-expanded'};
  }
  return {
    baseFileSetFingerprint: input.baseFileSetFingerprint,
    closureProjects: 0,
    committedWorkspace: input.committedWorkspace,
    deletedPaths: input.deletedPaths,
    facts: input.facts,
    files: input.addedFiles,
    mode: 'compatible',
    resolutionClosure: 'project',
  };
}

const assessExistingProjectModificationSeeds = Effect.fn('codeGraph.assessExistingProjectModificationSeeds')(
  function* (input: {
    readonly baseFiles: readonly CodeGraphInventoryFile[];
    readonly baseWorkspace: CodeGraphWorkspace;
    readonly currentFiles: readonly CodeGraphInventoryFile[];
    readonly currentModifiedFiles: readonly CodeGraphInventoryFile[];
    readonly currentWorkspace: CodeGraphWorkspace;
    readonly languagePacks: CodeGraphLanguagePackRegistryShape;
    readonly layout: CodeGraphLayout;
    readonly store: CodeGraphStoreShape;
  }) {
    if (input.currentModifiedFiles.length === 0) {
      return {
        candidateLookupKeys: [],
        candidateReexports: [],
        mode: 'eligible',
        planningOperations: {ownershipChecks: 0, pathIndexProjects: 0},
        seedProjectIds: [],
      } as const;
    }
    const baseModifiedFiles = inventoryFilesForPaths(
      input.baseFiles,
      EffectArray.map(input.currentModifiedFiles, file => file.path),
    );
    if (!baseModifiedFiles) {
      return {mode: 'fallback', reason: 'file-set-changed'} satisfies IncrementalOverlayPreassessment;
    }
    const budget = yield* assessProjectClosureChangedDecodeBudget({
      baseFiles: baseModifiedFiles,
      currentFiles: input.currentModifiedFiles,
      databasePath: input.layout.databasePath,
      languagePacks: input.languagePacks,
      store: input.store,
    });
    if (budget.mode === 'fallback') return budget;
    const [baseCache, currentCache] = yield* Effect.all(
      [
        loadCachedFacts(input.store, input.layout.databasePath, baseModifiedFiles, input.languagePacks),
        loadCachedFacts(input.store, input.layout.databasePath, input.currentModifiedFiles, input.languagePacks),
      ],
      {concurrency: 1},
    );
    if (
      EffectArray.some(baseModifiedFiles, file => !baseCache.facts.has(file.path)) ||
      EffectArray.some(input.currentModifiedFiles, file => !currentCache.facts.has(file.path))
    ) {
      return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
    }
    const baseRawFacts = EffectArray.map(baseModifiedFiles, file =>
      input.languagePacks.postprocessFile(file, baseCache.facts.get(file.path)!),
    );
    const currentRawFacts = EffectArray.map(input.currentModifiedFiles, file =>
      input.languagePacks.postprocessFile(file, currentCache.facts.get(file.path)!),
    );
    // Compare both sides in the current repository file context. Persisted
    // clean-base inventory rows intentionally omit manifest bodies, so using
    // them as an attribution context would erase otherwise-stable package
    // names. File-set additions/deletions and workspace changes are already
    // admitted separately and seed the resolver closure.
    const baseFacts = attributeInventoryFacts(input.currentFiles, input.baseWorkspace, baseRawFacts);
    const currentFacts = attributeInventoryFacts(input.currentFiles, input.currentWorkspace, currentRawFacts);
    const partition = partitionProjectResolutionSurfaceChanges(baseFacts, currentFacts);
    if (partition === undefined) {
      return {mode: 'fallback', reason: 'resolution-surface-changed'} satisfies IncrementalOverlayPreassessment;
    }
    if (partition.changedEffectiveFacts.length === 0) {
      return {
        candidateLookupKeys: [],
        candidateReexports: [],
        mode: 'eligible',
        planningOperations: {ownershipChecks: 0, pathIndexProjects: 0},
        seedProjectIds: [],
      } as const;
    }
    return assessProjectClosureSeeds({
      committedFacts: partition.changedCommittedFacts,
      effectiveFacts: partition.changedEffectiveFacts,
      projects: input.currentWorkspace.projects,
    });
  },
);

function projectClosureResolutionDomainByPath(
  files: readonly CodeGraphInventoryFile[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): ReadonlyMap<string, string> {
  const output = new Map<string, string>();
  for (const file of files) {
    const match = Option.getOrUndefined(languagePacks.match(file.path));
    if (match !== undefined) output.set(file.path, match.pack.resolutionStrategy.domain);
  }
  return output;
}

const assessPlannedProjectIncrementalClosure = Effect.fn('codeGraph.assessPlannedProjectIncrementalClosure')(
  function* (input: {
    readonly baseFileSetFingerprint: string;
    readonly committedWorkspace: CodeGraphWorkspace;
    readonly currentChangedFiles: readonly CodeGraphInventoryFile[];
    readonly currentFiles: readonly CodeGraphInventoryFile[];
    readonly currentWorkspace: CodeGraphWorkspace;
    readonly deletedPaths?: readonly string[];
    readonly languagePacks: CodeGraphLanguagePackRegistryShape;
    readonly layout: CodeGraphLayout;
    readonly seedProjectIds: readonly string[];
    readonly store: CodeGraphStoreShape;
  }) {
    const selection = selectProjectIncrementalClosure({
      files: input.currentFiles,
      modifiedPaths: EffectArray.map(input.currentChangedFiles, file => file.path),
      projects: input.currentWorkspace.projects,
      seedProjectIds: input.seedProjectIds,
      workspaceDiagnostics: input.currentWorkspace.diagnostics,
    });
    if (selection.mode === 'fallback') {
      return selection satisfies IncrementalOverlayPreassessment;
    }
    const currentByPath = new Map(EffectArray.map(input.currentFiles, file => [file.path, file]));
    const affectedFiles = EffectArray.map(selection.affectedPaths, path => currentByPath.get(path)!);
    const metadata = yield* cachedFactsMetadata(
      input.store,
      input.layout.databasePath,
      affectedFiles,
      input.languagePacks,
    );
    const plan = planProjectIncrementalClosure({
      cachedFactBytesByPath: metadata.bytesByPath,
      files: input.currentFiles,
      modifiedPaths: EffectArray.map(input.currentChangedFiles, file => file.path),
      projects: input.currentWorkspace.projects,
      seedProjectIds: input.seedProjectIds,
      workspaceDiagnostics: input.currentWorkspace.diagnostics,
    });
    if (plan.mode === 'fallback') {
      return plan satisfies IncrementalOverlayPreassessment;
    }
    if (metadata.files !== affectedFiles.length || plan.affectedPaths.length !== affectedFiles.length) {
      return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
    }
    const currentCache = yield* loadCachedFacts(
      input.store,
      input.layout.databasePath,
      affectedFiles,
      input.languagePacks,
    );
    if (EffectArray.some(affectedFiles, file => !currentCache.facts.has(file.path))) {
      return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
    }
    const currentRawFacts = EffectArray.map(affectedFiles, file =>
      input.languagePacks.postprocessFile(file, currentCache.facts.get(file.path)!),
    );
    const currentFacts = attributeInventoryFacts(input.currentFiles, input.currentWorkspace, currentRawFacts);
    if (!codeGraphIncrementalFactBatchesFitBudget(finalCodeGraphFactBatches(currentFacts))) {
      return {mode: 'fallback', reason: 'fact-budget-expanded'} satisfies IncrementalOverlayPreassessment;
    }
    return {
      baseFileSetFingerprint: input.baseFileSetFingerprint,
      closureProjects: plan.projectIds.length,
      committedWorkspace: input.committedWorkspace,
      deletedPaths: input.deletedPaths,
      facts: currentFacts,
      files: affectedFiles,
      mode: 'compatible',
      resolutionClosure: 'project',
    } satisfies IncrementalOverlayPreassessment;
  },
);

const assessProjectClosureChangedDecodeBudget = Effect.fn('codeGraph.assessProjectClosureChangedDecodeBudget')(
  function* (input: {
    readonly baseFiles: readonly CodeGraphInventoryFile[];
    readonly currentFiles: readonly CodeGraphInventoryFile[];
    readonly databasePath: string;
    readonly languagePacks: CodeGraphLanguagePackRegistryShape;
    readonly store: CodeGraphStoreShape;
  }) {
    if (!projectClosureSourceBudgetFits(input.baseFiles) || !projectClosureSourceBudgetFits(input.currentFiles)) {
      return {mode: 'fallback', reason: 'project-closure-unbounded'} satisfies IncrementalOverlayPreassessment;
    }
    const [baseMetadata, currentMetadata] = yield* Effect.all(
      [
        cachedFactsMetadata(input.store, input.databasePath, input.baseFiles, input.languagePacks),
        cachedFactsMetadata(input.store, input.databasePath, input.currentFiles, input.languagePacks),
      ],
      {concurrency: 1},
    );
    if (
      baseMetadata.files !== input.baseFiles.length ||
      baseMetadata.bytesByPath.size !== input.baseFiles.length ||
      currentMetadata.files !== input.currentFiles.length ||
      currentMetadata.bytesByPath.size !== input.currentFiles.length
    ) {
      return {mode: 'fallback', reason: 'cache-incomplete'} satisfies IncrementalOverlayPreassessment;
    }
    const baseBudget = projectClosureCachedFactBudgetFallback(baseMetadata, input.baseFiles.length);
    if (baseBudget !== undefined) return baseBudget;
    const currentBudget = projectClosureCachedFactBudgetFallback(currentMetadata, input.currentFiles.length);
    if (currentBudget !== undefined) return currentBudget;
    return {mode: 'eligible'} as const;
  },
);

function projectClosureCachedFactBudgetFallback(
  metadata: {readonly bytes: number; readonly bytesByPath: ReadonlyMap<string, number>},
  changedFiles: number,
): Extract<IncrementalOverlayPreassessment, {readonly mode: 'fallback'}> | undefined {
  const assessment = assessCodeGraphIncrementalFactBytes({
    aggregateBytes: metadata.bytes,
    factBytes: metadata.bytesByPath.values(),
  });
  if (assessment.mode === 'eligible') return undefined;
  if (assessment.mode === 'invalid') return {mode: 'fallback', reason: 'cache-incomplete'};
  return {
    fallbackBoundary: {
      changedFiles,
      limit: assessment.limit,
      metric: 'cached-fact-bytes',
      observedAtDecision: assessment.observedAtDecision,
      stage: 'project-closure-selection',
    },
    mode: 'fallback',
    reason: 'project-closure-unbounded',
  };
}

function projectClosureCombinedCachedFactBudgetFallback(
  metadata: readonly {readonly bytes: number; readonly bytesByPath: ReadonlyMap<string, number>}[],
  changedFiles: number,
): Extract<IncrementalOverlayPreassessment, {readonly mode: 'fallback'}> | undefined {
  let aggregateBytes = 0;
  const factBytes: number[] = [];
  for (const current of metadata) {
    if (
      !Number.isSafeInteger(current.bytes) ||
      current.bytes < 0 ||
      current.bytes > Number.MAX_SAFE_INTEGER - aggregateBytes
    ) {
      return {mode: 'fallback', reason: 'cache-incomplete'};
    }
    aggregateBytes += current.bytes;
    factBytes.push(...current.bytesByPath.values());
  }
  const assessment = assessCodeGraphIncrementalFactBytes({aggregateBytes, factBytes});
  if (assessment.mode === 'eligible') return undefined;
  if (assessment.mode === 'invalid') return {mode: 'fallback', reason: 'cache-incomplete'};
  return {
    fallbackBoundary: {
      changedFiles,
      limit: assessment.limit,
      metric: 'cached-fact-bytes',
      observedAtDecision: assessment.observedAtDecision,
      stage: 'project-closure-selection',
    },
    mode: 'fallback',
    reason: 'project-closure-unbounded',
  };
}

function projectClosureSourceBudgetFits(files: readonly CodeGraphInventoryFile[]): boolean {
  if (files.length > PROJECT_INCREMENTAL_CLOSURE_MAX_FILES) return false;
  let sourceBytes = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0) return false;
    if (file.size > PROJECT_INCREMENTAL_CLOSURE_MAX_SOURCE_BYTES - sourceBytes) return false;
    sourceBytes += file.size;
  }
  return true;
}

export function reusableBaseFileSetFingerprint(files: readonly CodeGraphInventoryFile[]): string {
  return codeGraphInventorySha256Hex(
    'reusable-base-file-set-v1\n',
    files,
    file => `${file.path}\0${file.language}\0${file.mode}`,
  );
}

export function reusableBaseComponentRankingJson(workspace: CodeGraphWorkspace): string {
  return JSON.stringify(workspace.projects.slice(0, 256));
}

export function currentSnapshotReusableBaseReceipt(
  inventory: CodeGraphInventory,
  workspace: CodeGraphWorkspace,
  packProvenance: readonly CodeGraphLanguagePackProvenance[],
): CodeGraphReusableBaseReceiptInput {
  return {
    fileSetFingerprint: reusableBaseFileSetFingerprint(inventory.files),
    ...(inventory.reuseReceipt ? {inventory: {...inventory.reuseReceipt, workspace}} : {}),
    packProvenance,
    workspaceFingerprint: workspace.fingerprint,
  };
}

function attributeInventoryFacts(
  files: readonly CodeGraphInventoryFile[],
  workspace: CodeGraphWorkspace,
  facts: readonly CodeGraphFileFacts[],
): readonly CodeGraphFileFacts[] {
  return deriveCachedCodeGraphFacts(files, workspace, facts);
}

/**
 * Rehydrates parser-only cached facts into the current repository derivation.
 * Resolution must precede workspace scoping because raw parser references can
 * intentionally defer their lookup tiers until the whole file set is known.
 */
export function deriveCachedCodeGraphFacts(
  files: readonly CodeGraphInventoryFile[],
  workspace: CodeGraphWorkspace,
  facts: readonly CodeGraphFileFacts[],
): readonly CodeGraphFileFacts[] {
  return createCachedCodeGraphFactsAttributor(files, workspace)(facts);
}

export function createCachedCodeGraphFactsAttributor(
  files: readonly CodeGraphInventoryFile[],
  workspace: CodeGraphWorkspace,
): (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[] {
  const attributeRepositoryFacts = createRepositoryFactAttributor(files);
  const attributeWorkspace = createWorkspaceAttributor(workspace);
  return facts => attributeWorkspace(attributeRepositoryFacts(facts));
}

function firstResolutionPublicationAssessment(
  facts: readonly CodeGraphFileFacts[],
): CodeGraphResolutionPublicationAssessment | undefined {
  for (const symbol of EffectArray.flatMap(facts, file => file.symbols)) {
    if (symbol.exported || symbol.resolutionDomain !== 'typescript') continue;
    return assessCodeGraphResolutionSymbolPublication(symbol);
  }
  return undefined;
}

function firstChangedResolutionPublicationAssessment(
  committedFacts: readonly CodeGraphFileFacts[],
  effectiveFacts: readonly CodeGraphFileFacts[],
): CodeGraphResolutionPublicationAssessment | undefined {
  const committedById = new Map(
    EffectArray.map(
      EffectArray.flatMap(committedFacts, file => file.symbols),
      symbol => [symbol.id, symbol],
    ),
  );
  const effectiveById = new Map(
    EffectArray.map(
      EffectArray.flatMap(effectiveFacts, file => file.symbols),
      symbol => [symbol.id, symbol],
    ),
  );
  for (const symbol of effectiveById.values()) {
    const committed = committedById.get(symbol.id);
    if (committed && hasSameCodeGraphResolutionSurface([committed], [symbol])) continue;
    const assessment = assessCodeGraphResolutionSymbolPublication(symbol);
    if (assessment.published) return assessment;
  }
  for (const symbol of committedById.values()) {
    if (effectiveById.has(symbol.id)) continue;
    const assessment = assessCodeGraphResolutionSymbolPublication(symbol);
    if (assessment.published) return assessment;
  }
  return undefined;
}

export {hasSameCodeGraphResolutionSurface} from '../resolution/surface.js';

export function overlayFallbackDescription(reason: CodeGraphOverlayFallbackReason): string {
  switch (reason) {
    case 'cache-incomplete':
      return 'cached facts were incomplete';
    case 'disabled':
      return 'incremental overlay reuse was disabled';
    case 'dynamic-aliases':
      return 'changed files participate in dynamic alias resolution';
    case 'extractor-context-changed':
      return 'resolution context changed';
    case 'fact-budget-expanded':
      return 'final attributed facts exceeded one bounded incremental transaction';
    case 'file-set-changed':
      return 'eligible files were added or deleted';
    case 'forced-full-rebuild':
      return 'a full rebuild was requested';
    case 'incremental-rewrite-unbounded':
      return 'the changed closure exceeded the bounded incremental rewrite budget';
    case 'no-materialized-changes':
      return 'no graph-eligible file content changed';
    case 'project-closure-incomplete':
      return 'the declared project dependency closure was incomplete or ambiguous';
    case 'project-closure-unbounded':
      return 'the project dependency closure exceeded the bounded four-batch materialization envelope';
    case 'reexport-closure-unbounded':
      return 'persisted reexport provenance exceeded the bounded project-closure lookup';
    case 'resolution-surface-changed':
      return 'a declaration or lookup surface changed';
    case 'staging-identity-mismatch':
      return 'the reusable staging identity was not current';
    case 'staging-unavailable':
      return 'the compatible clean staging generation was unavailable';
    case 'workspace-changed':
      return 'workspace attribution changed';
  }
}
