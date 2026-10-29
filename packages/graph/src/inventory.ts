import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Option, Path} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runBinaryCommandEffect, runCommandEffect} from '@threadnote/platform/command';
import {codeGraphBlobReuseCacheKey} from './blob_reuse.js';
import {codeGraphCommittedContentHash} from './content_identity.js';
import {
  codeGraphCatFileBatches,
  CODE_GRAPH_CAT_FILE_BATCH_BYTES,
  CODE_GRAPH_CAT_FILE_BATCH_ENTRIES,
} from './inventory/batching.js';
import {
  inspectContainedStableRegularFile,
  materializeContainedStableRegularFile,
  type StableContainedRegularFileMetadata,
} from './inventory/contained_file.js';
import {
  acceptsBinaryContent,
  appearsBinary,
  appearsGitLfsPointer,
  decodeUtf8,
  repositoryContentOmissionReason,
  retainResolutionContext,
  shouldOmitRepositoryContent,
} from './inventory/content.js';
import {CodeGraphInventoryError} from './inventory/error.js';
import {parseNameStatus, parsePorcelainV1Status} from './inventory/porcelain.js';
import {worktreeStatusWithPrivateCache} from './git/status_cache.js';
import {committedOverlayBasis, parseGitTree, policyExclusionsForEntries} from './inventory/committed_overlay_basis.js';
import {
  codeGraphAttributionContextFilesForReceipt,
  codeGraphInventoryReuseContract,
  readCodeGraphInventoryReuseEnvironment,
} from './inventory/reuse.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY, type CodeGraphLanguagePackRegistryShape} from './languages/registry.js';
import {CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT, isOpaqueCorpusMediaPath} from './languages/corpus/policy.js';
import {
  codeGraphInventoryExclusionReason,
  CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
  CODE_GRAPH_INVENTORY_EXCLUSION_REASONS,
  type CodeGraphInventoryExclusionReason,
} from './inventory/policy.js';
import {compareCodeUnits} from './ordering.js';
import {workspaceHasUninventoriedMonikerEvidence} from './workspace.js';
import {resolveCodeGraphWorkspaceCatalog, type ResolvedCodeGraphIndexScope} from './index_scope.js';
import {
  codeGraphScopeAdmitsPath,
  codeGraphScopedBaseReusable,
  scopedCodeGraphWorkspace,
} from './scope/applicability.js';
import {
  compileThreadnoteIgnore,
  emptyThreadnoteIgnoreAdmissionPath,
  isIgnoredByThreadnote,
  isOverlayAdmissionControlPath,
  readThreadnoteIgnoreSources,
  type CompiledIgnoreRule,
  type ThreadnoteIgnoreSources,
} from './threadnote_ignore.js';
import {
  codeGraphExtractionPlanMetrics,
  codeGraphSourceSizeBucket,
  CODE_GRAPH_SCANNING_STARTED_PROGRESS,
} from './progress/telemetry.js';
import {type CodeGraphInventoryFile, type RepositoryIdentity} from './types.js';
import type {CodeGraphInventoryPolicyExclusionSummary, CodeGraphReusableCleanBase} from './store/models.js';
import {CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION} from './store/models.js';
import type {
  CodeGraphInventory,
  CodeGraphInventoryOptions,
  CodeGraphOverlayObservation,
  CodeGraphObservedOverlayFile,
  CodeGraphBuildRequestObservation,
} from './inventory/models.js';
import {codeGraphInventoryScopeMetadata, observeCodeGraphIndexScope} from './inventory/scope.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

import {
  CODE_GRAPH_INVENTORY_PREVIEW_VERSION,
  summarizeCodeGraphInventoryPreview,
  isPotentialOverlayCandidate,
  isInventoryPolicyExtension,
  repositoryPathExclusionReason,
  normalizeRepositoryPath,
} from './inventory/preview.js';
import type {
  GitTreeEntry,
  CodeGraphInventoryPreview,
  CodeGraphInventoryPreviewOptions,
  PolicyExclusionEntry,
} from './inventory/preview.js';
export {CODE_GRAPH_INVENTORY_PREVIEW_VERSION, summarizeCodeGraphInventoryPreview} from './inventory/preview.js';
export type {
  GitTreeEntry,
  CodeGraphInventoryPreviewDisposition,
  CodeGraphInventoryPreviewReason,
  CodeGraphInventoryPreviewEntry,
  CodeGraphInventoryPreviewGroup,
  CodeGraphInventoryPreviewCount,
  CodeGraphInventoryPreview,
  CodeGraphInventoryPreviewSummaryOptions,
  CodeGraphInventoryPreviewOptions,
  PolicyExclusionEntry,
} from './inventory/preview.js';
export {codeGraphInventoryScopeEvidence, observeCodeGraphIndexScope} from './inventory/scope.js';
export type {
  CodeGraphInventory,
  CodeGraphInventoryOptions,
  CodeGraphOverlayObservation,
  CodeGraphObservedOverlayFile,
  CodeGraphBuildRequestObservation,
  CodeGraphContentBatchContext,
} from './inventory/models.js';

export {codeGraphInventoryExclusionReason} from './inventory/policy.js';
export {codeGraphCatFileBatches} from './inventory/batching.js';
export {parseNameStatus} from './inventory/porcelain.js';
export {parseGitTree, policyExclusionsForEntries} from './inventory/committed_overlay_basis.js';
export {readContainedStableRegularFile, type ContainedReadInterlock} from './inventory/contained_file.js';
export {shouldOmitRepositoryContent} from './inventory/content.js';
export {
  compileThreadnoteIgnore,
  isIgnoredByThreadnote,
  isOverlayAdmissionControlPath,
  THREADNOTE_IGNORE_FILE,
  THREADNOTE_IGNORE_LOCAL_FILE,
  type CompiledIgnoreRule,
} from './threadnote_ignore.js';
export type {
  CodeGraphInventoryPolicyExclusionReasonSummary,
  CodeGraphInventoryPolicyExclusionSummary,
} from './store/models.js';

export const inventoryRepository = Effect.fn('codeGraph.inventoryRepository')(function* (
  identity: RepositoryIdentity,
  options: CodeGraphInventoryOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const languagePacks = options.languagePacks ?? BUILTIN_LANGUAGE_PACK_REGISTRY;
  const includeOpaqueCorpusAssets = options.includeOpaqueCorpusAssets !== false;
  // Committed-tree discovery, workspace classification, and ignore-policy
  // admission are inventory work. Mark the phase before those operations so
  // registration timing remains limited to lock and database setup.
  yield* options.onProgress?.(CODE_GRAPH_SCANNING_STARTED_PROGRESS) ?? Effect.void;
  const reuseEnvironment = yield* readCodeGraphInventoryReuseEnvironment(identity, fs, path);
  const allTreeEntries = isZeroObjectId(identity.headCommit)
    ? []
    : parseGitTree(
        (yield* runCommandEffect('git', ['-C', identity.repoRoot, 'ls-tree', '-r', '-l', '-z', identity.headCommit], {
          maxOutputBytes: 0,
          timeoutMs: 0,
        })).stdout,
      );
  const committedPolicyExclusions = policyExclusionsForEntries(allTreeEntries);
  const committedTreeEntries = new Map(EffectArray.map(allTreeEntries, entry => [entry.path, entry]));
  const policyAdmittedTreeEntries = EffectArray.filter(
    allTreeEntries,
    (entry, __effectArrayIndex) => __effectArrayIndex in allTreeEntries && !committedPolicyExclusions.has(entry.path),
  );
  const declaredWorkspace = yield* discoverDeclaredSourceRoots(identity, policyAdmittedTreeEntries, languagePacks);
  const ignoreRules = compileThreadnoteIgnore(
    reuseEnvironment.threadnoteIgnore,
    reuseEnvironment.threadnoteIgnoreLocal,
  );
  const scopeObservation =
    options.project?.graph === undefined
      ? undefined
      : yield* observeCodeGraphIndexScope(identity, options.project, {
          includeOverlay: options.includeOverlay,
          languagePacks,
          committed: {
            entries: allTreeEntries,
            declared: declaredWorkspace,
            ignoreSources: {
              committed: reuseEnvironment.threadnoteIgnore,
              local: reuseEnvironment.threadnoteIgnoreLocal,
            },
          },
        });
  const scope = scopeObservation?.scope;
  const admissionProjectRoots =
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(scopeObservation?.catalog.workspace.projects), __effectArrayReceiver =>
        EffectArray.map(__effectArrayReceiver, project => project.root),
      ),
    ) ?? declaredWorkspace.projectRoots;
  const admissionSourceRoots =
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(scopeObservation), __scopeObservation => {
        const __projects = __scopeObservation.catalog.workspace.projects;
        return EffectArray.flatMap(__projects, (project, __effectArrayIndex) =>
          __effectArrayIndex in __projects ? project.sourceRoots : [],
        );
      }),
    ) ?? declaredWorkspace.sourceRoots;
  const acceptedByPolicy = EffectArray.filter(policyAdmittedTreeEntries, entry =>
    acceptsRepositoryPathWithRules(
      entry.path,
      ignoreRules,
      languagePacks,
      admissionProjectRoots,
      admissionSourceRoots,
      includeOpaqueCorpusAssets,
    ),
  );
  const deferredOpaqueEntries = !includeOpaqueCorpusAssets
    ? EffectArray.filter(
        policyAdmittedTreeEntries,
        entry =>
          isOpaqueCorpusMediaPath(entry.path) &&
          acceptsRepositoryPathWithRules(
            entry.path,
            ignoreRules,
            languagePacks,
            admissionProjectRoots,
            admissionSourceRoots,
            true,
          ),
      )
    : [];
  const ignoredByGit = yield* ignoredPaths(
    identity.repoRoot,
    EffectArray.map([...acceptedByPolicy, ...deferredOpaqueEntries], entry => entry.path),
  );
  const admitted = EffectArray.filter(acceptedByPolicy, entry => !ignoredByGit.has(entry.path));
  const scopeExcluded = EffectArray.filter(admitted, entry => !codeGraphScopeAdmitsPath(scope, entry.path));
  const accepted = EffectArray.filter(admitted, entry => codeGraphScopeAdmitsPath(scope, entry.path));
  const acceptedPaths = new Set(EffectArray.map(accepted, entry => entry.path));
  const excluded = allTreeEntries.length - accepted.length;

  const committed = yield* readCommittedFiles(
    identity,
    accepted,
    excluded,
    options.scopeObservationOnly
      ? new Set(
          EffectArray.map(accepted, entry =>
            cacheKey(entry.path, codeGraphCommittedContentHash(identity.objectFormat, entry.blobId), languagePacks),
          ),
        )
      : (options.cachedCommittedFileKeys ?? new Set()),
    languagePacks,
    declaredWorkspace.files,
    options.onContentBatch,
    options.onParserWorkPlanned,
    options.onProgress,
  );
  const committedPolicyExclusionSummary = summarizePolicyExclusions(committedPolicyExclusions);
  const committedDiagnostics =
    committedPolicyExclusionSummary.files === 0
      ? []
      : [formatPolicyExclusionDiagnostic(committedPolicyExclusionSummary)];
  if (!includeOpaqueCorpusAssets) {
    const deferred = EffectArray.filter(deferredOpaqueEntries, entry => !ignoredByGit.has(entry.path));
    if (deferred.length > 0) {
      committedDiagnostics.push(
        `Deferred ${deferred.length} opaque corpus asset(s) / ${EffectArray.reduce(deferred, 0, (total, entry) => total + entry.size)} byte(s) during structural-only indexing.`,
      );
    }
  }
  const overlay =
    options.includeOverlay === false
      ? {
          changed: new Set<string>(),
          dirty: false,
          files: [],
          fingerprint: undefined,
          parsedPaths: new Set<string>(),
          policyExclusions: committedPolicyExclusions,
          policySkippedDelta: 0,
          skipped: 0,
        }
      : yield* readDirtyOverlay(
          identity,
          path,
          {
            committed: reuseEnvironment.threadnoteIgnore,
            local: reuseEnvironment.threadnoteIgnoreLocal,
          },
          ignoreRules,
          options.cachedCommittedFileKeys ?? new Set(),
          languagePacks,
          admissionProjectRoots,
          admissionSourceRoots,
          committedPolicyExclusions,
          committedTreeEntries,
          acceptedPaths,
          includeOpaqueCorpusAssets,
          options.onContentBatch
            ? (files, context) =>
                options.onContentBatch!(files, {
                  ...context,
                  progress: {
                    accepted: committed.files.length,
                    completed: accepted.length,
                    excluded,
                    phase: 'scanning',
                    skipped: committed.skipped,
                    total: accepted.length,
                    unit: 'files',
                  },
                })
            : undefined,
          options.onOverlayStart,
          options.overlayObservation,
          scope === undefined ? undefined : relative => codeGraphScopeAdmitsPath(scope, relative),
        );
  const filesByPath = new Map(EffectArray.map(committed.files, file => [file.path, file]));
  for (const changed of overlay.changed) filesByPath.delete(changed);
  for (const file of overlay.files) filesByPath.set(file.path, file);
  const files = [...filesByPath.values()].sort((left, right) => compareCodeUnits(left.path, right.path));
  const parsedPaths = new Set([...committed.parsedPaths, ...overlay.parsedPaths]);
  const skipped = excluded + committed.skipped + overlay.skipped + overlay.policySkippedDelta;
  const policyExclusions = summarizePolicyExclusions(overlay.policyExclusions);
  const diagnostics = policyExclusions.files === 0 ? [] : [formatPolicyExclusionDiagnostic(policyExclusions)];
  if (scopeExcluded.length > 0)
    diagnostics.push(`Excluded ${scopeExcluded.length} admitted file(s) outside the selected graph scope.`);
  if (!includeOpaqueCorpusAssets) {
    const deferred = EffectArray.filter(deferredOpaqueEntries, entry => !ignoredByGit.has(entry.path));
    if (deferred.length > 0) {
      diagnostics.push(
        `Deferred ${deferred.length} opaque corpus asset(s) / ${EffectArray.reduce(deferred, 0, (total, entry) => total + entry.size)} byte(s) during structural-only indexing.`,
      );
    }
  }
  const attributionFiles = codeGraphAttributionContextFilesForReceipt(committed.files, languagePacks);
  return {
    ...codeGraphInventoryScopeMetadata(scopeObservation, options, accepted, scopeExcluded, overlay.fingerprint),
    committedFiles: [...committed.files].sort((left, right) => compareCodeUnits(left.path, right.path)),
    committedParsedFiles: EffectArray.reduce(
      committed.files,
      0,
      (total, file) => total + (committed.parsedPaths.has(file.path) ? 1 : 0),
    ),
    diagnostics,
    dirty: overlay.dirty,
    files,
    overlayFingerprint: overlay.fingerprint,
    parsedFiles: EffectArray.reduce(files, 0, (total, file) => total + (parsedPaths.has(file.path) ? 1 : 0)),
    policyExclusions,
    ...(overlay.dirty || attributionFiles === undefined
      ? {}
      : {
          reuseReceipt: {
            attributionFiles,
            contract: codeGraphInventoryReuseContract(languagePacks, includeOpaqueCorpusAssets),
            diagnostics: committedDiagnostics,
            environmentFingerprint: reuseEnvironment.fingerprint,
            includeOpaqueCorpusAssets,
            policyExclusions: committedPolicyExclusionSummary,
            skipped: excluded + committed.skipped,
            version: CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
          },
        }),
    skipped,
    ...(scopeObservation !== undefined
      ? {
          workspace: scopedCodeGraphWorkspace(scopeObservation.catalog.workspace, scopeObservation.scope),
        }
      : EffectArray.some([...overlay.changed], relative => languagePacks.isResolutionContext(relative)) ||
          workspaceHasUninventoriedMonikerEvidence(
            declaredWorkspace.workspace,
            new Set(EffectArray.map(files, file => file.path)),
          )
        ? {}
        : {workspace: declaredWorkspace.workspace}),
  } satisfies CodeGraphInventory;
});

/**
 * Reconstruct a dirty inventory from a persisted clean base without scanning
 * HEAD. Admission is intentionally narrow: only modifications or deletions of
 * already-admitted files may proceed, and every contract or environment
 * mismatch falls back to the full inventory path.
 */
export const inventoryRepositoryFromReusableCleanBase = Effect.fn('codeGraph.inventoryRepositoryFromReusableBase')(
  function* (
    identity: RepositoryIdentity,
    base: CodeGraphReusableCleanBase,
    options: CodeGraphInventoryOptions & {
      readonly overlayObservation: CodeGraphOverlayObservation;
    },
  ) {
    if (options.project?.graph !== undefined && options.scopeObservation?.scope === undefined)
      return Option.none<CodeGraphInventory>();
    const receipt = base.receipt.inventory;
    if (
      receipt === undefined ||
      base.snapshot.repositoryId !== identity.repositoryId ||
      base.snapshot.commit !== identity.headCommit ||
      base.snapshot.dirty ||
      base.snapshot.baseSnapshotId !== undefined
    ) {
      return Option.none<CodeGraphInventory>();
    }
    const languagePacks = options.languagePacks ?? BUILTIN_LANGUAGE_PACK_REGISTRY;
    if (
      !(yield* codeGraphScopedBaseReusable({inventory: options.scopeObservation ?? {}, identity, languagePacks}, base))
    )
      return Option.none<CodeGraphInventory>();
    const includeOpaqueCorpusAssets = options.includeOpaqueCorpusAssets !== false;
    if (
      receipt.includeOpaqueCorpusAssets !== includeOpaqueCorpusAssets ||
      receipt.contract !== codeGraphInventoryReuseContract(languagePacks, includeOpaqueCorpusAssets)
    ) {
      return Option.none<CodeGraphInventory>();
    }
    const observation = options.overlayObservation;
    if (
      observation.addedPaths.length > 0 ||
      observation.untrackedPaths.length > 0 ||
      (observation.changedPaths.length === 0 && observation.deletedPaths.length === 0)
    ) {
      return Option.none<CodeGraphInventory>();
    }
    const baseByPath = new Map(EffectArray.map(base.files, file => [file.path, file]));
    const requestedChanged = new Set([...observation.changedPaths, ...observation.deletedPaths]);
    if (
      requestedChanged.size !== observation.changedPaths.length + observation.deletedPaths.length ||
      EffectArray.some(
        [...requestedChanged],
        relative =>
          !baseByPath.has(relative) ||
          isOverlayAdmissionControlPath(relative) ||
          languagePacks.isResolutionContext(relative),
      )
    ) {
      return Option.none<CodeGraphInventory>();
    }
    const observedFiles = new Map(EffectArray.map(observation.files, file => [file.path, file]));
    if (
      observedFiles.size !== observation.changedPaths.length ||
      EffectArray.some(observation.changedPaths, relative => {
        const file = observedFiles.get(relative);
        return file === undefined || codeGraphInventoryExclusionReason(relative, file.size) !== undefined;
      })
    ) {
      return Option.none<CodeGraphInventory>();
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* readCodeGraphInventoryReuseEnvironment(identity, fs, path);
    if (environment.fingerprint !== receipt.environmentFingerprint) return Option.none<CodeGraphInventory>();

    const projectRoots = [
      ...new Set([
        ...EffectArray.map(receipt.workspace.projects, project => project.root),
        ...EffectArray.map(receipt.workspace.workspaces, workspace => workspace.root),
      ]),
    ].sort(compareCodeUnits);
    const sourceRoots = [
      ...new Set(
        EffectArrayPipe(receipt.workspace.projects, __effectArrayValues =>
          EffectArray.flatMap(__effectArrayValues, (project, __effectArrayIndex3) =>
            __effectArrayIndex3 in __effectArrayValues ? project.sourceRoots : [],
          ),
        ),
      ),
    ].sort(compareCodeUnits);
    const committedTreeEntries = new Map(
      EffectArray.map(base.files, file => [
        file.path,
        {
          blobId: file.blobId,
          mode: file.mode,
          path: file.path,
          size: file.size,
        } satisfies GitTreeEntry,
      ]),
    );
    const overlay = yield* readDirtyOverlay(
      identity,
      path,
      {
        committed: environment.threadnoteIgnore,
        local: environment.threadnoteIgnoreLocal,
      },
      compileThreadnoteIgnore(environment.threadnoteIgnore, environment.threadnoteIgnoreLocal),
      options.cachedCommittedFileKeys ?? new Set(),
      languagePacks,
      projectRoots,
      sourceRoots,
      new Map(),
      committedTreeEntries,
      new Set(baseByPath.keys()),
      includeOpaqueCorpusAssets,
      options.onContentBatch,
      options.onOverlayStart,
      observation,
    );
    if (
      !overlay.dirty ||
      !sameInventoryPathSet(overlay.changed, requestedChanged) ||
      overlay.skipped !== 0 ||
      overlay.policySkippedDelta !== 0 ||
      EffectArray.some(overlay.files, file => observedFiles.get(file.path)?.contentHash !== file.contentHash)
    ) {
      return Option.none<CodeGraphInventory>();
    }
    const filesByPath = new Map(baseByPath);
    for (const changed of overlay.changed) filesByPath.delete(changed);
    for (const file of overlay.files) filesByPath.set(file.path, file);
    const files = [...filesByPath.values()].sort((left, right) => compareCodeUnits(left.path, right.path));
    return Option.some({
      ...options.scopeObservation,
      committedFiles: base.files,
      committedParsedFiles: 0,
      diagnostics: [
        ...receipt.diagnostics,
        `Reused persisted clean inventory admission for ${requestedChanged.size} changed path(s).`,
      ],
      dirty: true,
      files,
      overlayFingerprint: overlay.fingerprint,
      parsedFiles: overlay.parsedPaths.size,
      policyExclusions: receipt.policyExclusions,
      skipped: receipt.skipped,
      workspace: receipt.workspace,
    } satisfies CodeGraphInventory);
  },
);

export function sameInventoryPathSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && EffectArray.every([...left], value => right.has(value));
}

/**
 * Preview the current admission inventory without hydrating ordinary source
 * blobs. Only small resolution-context manifests may be read so declared
 * source roots match a real index operation.
 */
export const previewCodeGraphInventory = Effect.fn('codeGraph.previewInventory')(function* (
  identity: RepositoryIdentity,
  options: CodeGraphInventoryPreviewOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const languagePacks = options.languagePacks ?? BUILTIN_LANGUAGE_PACK_REGISTRY;
  const committedEntries = isZeroObjectId(identity.headCommit)
    ? []
    : parseGitTree(
        (yield* runCommandEffect('git', ['-C', identity.repoRoot, 'ls-tree', '-r', '-l', '-z', identity.headCommit], {
          maxOutputBytes: 0,
          timeoutMs: 0,
        })).stdout,
      );
  const policyAdmittedEntries = EffectArray.filter(
    committedEntries,
    (entry, __effectArrayIndex2) =>
      __effectArrayIndex2 in committedEntries &&
      codeGraphInventoryExclusionReason(entry.path, entry.size) === undefined,
  );
  const declaredWorkspace = yield* discoverDeclaredSourceRoots(identity, policyAdmittedEntries, languagePacks);
  const scopeObservation =
    options.project?.graph === undefined
      ? undefined
      : yield* observeCodeGraphIndexScope(identity, options.project, {
          includeOverlay: options.includeOverlay,
          languagePacks,
        });
  const scope = scopeObservation?.scope;
  const ignoreSources = yield* readThreadnoteIgnoreSources(fs, path, identity.repoRoot);
  const ignoreRules = compileThreadnoteIgnore(ignoreSources.committed, ignoreSources.local);
  const tree = yield* readInventoryPreviewTree(identity, path, committedEntries, options.includeOverlay !== false);
  const threadnoteIgnoredChangedPaths = new Set(
    EffectArray.filter([...tree.changes.changed], relative => isIgnoredByThreadnote(relative, ignoreRules)),
  );
  const changedContextCandidates = EffectArray.filter(
    [...tree.changes.changed],
    relative =>
      languagePacks.isResolutionContext(relative) &&
      !threadnoteIgnoredChangedPaths.has(relative) &&
      codeGraphInventoryExclusionReason(relative, tree.changedMetadata.get(relative)?.size ?? -1) === undefined,
  );
  const ignoredChangedContexts = yield* ignoredPaths(identity.repoRoot, changedContextCandidates);
  const effectiveRoots =
    options.includeOverlay === false
      ? {
          projectRoots: declaredWorkspace.projectRoots,
          sourceRoots: declaredWorkspace.sourceRoots,
        }
      : yield* discoverOverlaySourceRoots(
          identity,
          path,
          tree.changes.changed,
          tree.changedMetadata,
          ignoredChangedContexts,
          threadnoteIgnoredChangedPaths,
          languagePacks,
          declaredWorkspace.projectRoots,
          declaredWorkspace.sourceRoots,
        );
  const gitIgnoreCandidates = EffectArray.map(
    EffectArray.filter(
      tree.entries,
      entry =>
        codeGraphInventoryExclusionReason(entry.path, entry.size) === undefined &&
        repositoryPathExclusionReason(
          entry.path,
          ignoreRules,
          languagePacks,
          effectiveRoots.projectRoots,
          effectiveRoots.sourceRoots,
          options.includeOpaqueCorpusAssets !== false,
        ) === undefined,
    ),
    entry => entry.path,
  );
  const gitIgnoredPaths = yield* ignoredPaths(identity.repoRoot, gitIgnoreCandidates);
  const summary = summarizeCodeGraphInventoryPreview(
    EffectArray.filter(tree.entries, entry => codeGraphScopeAdmitsPath(scope, entry.path)),
    {
      declaredProjectRoots:
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(scopeObservation?.catalog.workspace.projects), __effectArrayReceiver =>
            EffectArray.map(__effectArrayReceiver, project => project.root),
          ),
        ) ?? effectiveRoots.projectRoots,
      declaredSourceRoots:
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(scopeObservation), __scopeObservation => {
            const __projects = __scopeObservation.catalog.workspace.projects;
            return EffectArray.flatMap(__projects, (project, __effectArrayIndex) =>
              __effectArrayIndex in __projects ? project.sourceRoots : [],
            );
          }),
        ) ?? effectiveRoots.sourceRoots,
      gitIgnoredPaths,
      languagePacks,
      includeOpaqueCorpusAssets: options.includeOpaqueCorpusAssets,
      threadnoteIgnore: ignoreSources.committed,
      threadnoteIgnoreLocal: ignoreSources.local,
    },
  );
  return {
    commit: identity.headCommit,
    dirty: tree.dirty,
    groups: summary.groups,
    omittedUnsafeWorktreeFiles: tree.omittedUnsafeWorktreeFiles,
    policyVersion: summary.policyVersion,
    repositoryId: identity.repositoryId,
    scope: 'head-and-worktree',
    totals: summary.totals,
    type: 'code-graph-inventory-preview',
    version: CODE_GRAPH_INVENTORY_PREVIEW_VERSION,
    worktreeId: identity.worktreeId,
  } satisfies CodeGraphInventoryPreview;
});

const readInventoryPreviewTree = Effect.fn('codeGraph.readInventoryPreviewTree')(function* (
  identity: RepositoryIdentity,
  path: Path.Path,
  committedEntries: readonly GitTreeEntry[],
  includeOverlay: boolean,
  excludedPathPrefix?: string,
) {
  const emptyChanges = {
    added: new Set<string>(),
    changed: new Set<string>(),
    deleted: new Set<string>(),
  };
  if (!includeOverlay) {
    return {
      changedMetadata: new Map<string, StableContainedRegularFileMetadata>(),
      changes: emptyChanges,
      dirty: false,
      entries: committedEntries,
      omittedUnsafeWorktreeFiles: 0,
      untracked: new Set<string>(),
    };
  }
  const fs = yield* FileSystem.FileSystem;
  const repositoryRoot = yield* fs.realPath(identity.repoRoot);
  const unborn = isZeroObjectId(identity.headCommit);
  const excludePath = (relative: string) =>
    excludedPathPrefix !== undefined &&
    (relative === excludedPathPrefix || Effect2.pipe(relative, EffectString.startsWith(`${excludedPathPrefix}/`)));
  const pathspec = excludedPathPrefix === undefined ? [] : ['--', '.', `:(top,exclude,literal)${excludedPathPrefix}`];
  const [diffOutput, untrackedOutput] = unborn
    ? [
        '',
        (yield* runCommandEffect(
          'git',
          ['-C', identity.repoRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', ...pathspec],
          {maxOutputBytes: 0, timeoutMs: 0},
        )).stdout,
      ]
    : yield* Effect.all(
        [
          runCommandEffect(
            'git',
            [
              '-C',
              identity.repoRoot,
              'diff',
              '--name-status',
              '-z',
              '--find-renames',
              identity.headCommit,
              ...(pathspec.length === 0 ? ['--'] : pathspec),
            ],
            {maxOutputBytes: 0, timeoutMs: 0},
          ).pipe(Effect.map(result => result.stdout)),
          runCommandEffect(
            'git',
            ['-C', identity.repoRoot, 'ls-files', '-z', '--others', '--exclude-standard', ...pathspec],
            {
              maxOutputBytes: 0,
              timeoutMs: 0,
            },
          ).pipe(Effect.map(result => result.stdout)),
        ],
        {concurrency: 2},
      );
  const changes = parseNameStatus(diffOutput);
  const untracked = new Set(
    EffectArray.filter(
      EffectArray.map(
        EffectArray.filter(Effect2.pipe(untrackedOutput, EffectString.split('\0')), Boolean),
        normalizeRepositoryPath,
      ),
      relative => !excludePath(relative),
    ),
  );
  for (const relative of untracked) {
    if (excludePath(relative)) continue;
    changes.added.add(relative);
    changes.changed.add(relative);
  }
  for (const collection of [changes.added, changes.changed, changes.deleted]) {
    for (const relative of collection) {
      if (excludePath(relative)) collection.delete(relative);
    }
  }
  const entries = new Map(EffectArray.map(committedEntries, entry => [entry.path, entry]));
  for (const relative of changes.deleted) entries.delete(relative);
  const changedMetadata = new Map<string, StableContainedRegularFileMetadata>();
  let omittedUnsafeWorktreeFiles = 0;
  for (const relative of [...changes.changed].sort(compareCodeUnits)) {
    entries.delete(relative);
    const inspected = yield* inspectContainedStableRegularFile(fs, path, repositoryRoot, relative).pipe(Effect.option);
    if (inspected._tag === 'None') {
      omittedUnsafeWorktreeFiles += 1;
      continue;
    }
    changedMetadata.set(relative, inspected.value);
    entries.set(relative, {
      blobId: 'worktree',
      mode: '100644',
      path: relative,
      size: inspected.value.size,
    });
  }
  return {
    changedMetadata,
    changes,
    dirty: changes.changed.size > 0 || changes.deleted.size > 0,
    entries: [...entries.values()].sort((left, right) => compareCodeUnits(left.path, right.path)),
    omittedUnsafeWorktreeFiles,
    untracked,
  };
});

export const worktreeOverlayState = Effect.fn('codeGraph.worktreeOverlayState')(function* (
  identity: RepositoryIdentity,
) {
  // Clean worktrees are overwhelmingly the common status/query path. Avoid a
  // full tree inventory and manifest hydration when Git can prove there is no
  // tracked or untracked worktree change at all.
  const porcelain = yield* runCommandEffect(
    'git',
    ['-C', identity.repoRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    {maxOutputBytes: 0, timeoutMs: 0},
  );
  if (porcelain.stdout.length === 0) return {dirty: false, fingerprint: undefined};
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const basis = yield* committedOverlayBasis(identity, entries =>
    discoverDeclaredSourceRoots(identity, entries, BUILTIN_LANGUAGE_PACK_REGISTRY),
  );
  const ignoreSources = yield* readThreadnoteIgnoreSources(fs, path, identity.repoRoot);
  const ignoreRules = compileThreadnoteIgnore(ignoreSources.committed, ignoreSources.local);
  const overlay = yield* readDirtyOverlay(
    identity,
    path,
    ignoreSources,
    ignoreRules,
    new Set(),
    BUILTIN_LANGUAGE_PACK_REGISTRY,
    basis.projectRoots,
    basis.sourceRoots,
    basis.committedPolicyExclusions,
    basis.committedTreeEntries,
  );
  return {dirty: overlay.dirty, fingerprint: overlay.fingerprint};
});

/**
 * Exact, policy-independent dirty input identity for build admission. Unlike
 * `worktreeOverlayState`, this does not hydrate the committed tree or discover
 * every workspace before the real inventory pass. Changed regular files are
 * still streamed through SHA-256 with the same containment and race checks, so
 * two processes can safely coalesce only the exact same worktree bytes.
 */
export const worktreeBuildRequestObservation = Effect.fn('codeGraph.worktreeBuildRequestObservation')(function* (
  identity: RepositoryIdentity,
  threadnoteHome?: string,
  scope?: ResolvedCodeGraphIndexScope,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = yield* fs.realPath(identity.repoRoot);
  const relativeHome =
    threadnoteHome === undefined
      ? undefined
      : normalizeRepositoryPath(
          path.relative(repositoryRoot, yield* canonicalizePotentialPath(fs, path, threadnoteHome)),
        );
  const excludedPathPrefix =
    relativeHome !== undefined &&
    relativeHome.length > 0 &&
    relativeHome !== '..' &&
    !Effect2.pipe(relativeHome, EffectString.startsWith('../')) &&
    !path.isAbsolute(relativeHome)
      ? relativeHome
      : undefined;
  const pathspec = excludedPathPrefix === undefined ? [] : ['--', '.', `:(top,exclude,literal)${excludedPathPrefix}`];
  const porcelain = yield* worktreeStatusWithPrivateCache(identity, threadnoteHome, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--renames',
    '--ignore-submodules=none',
    ...pathspec,
  ]);
  if (porcelain.stdout.length === 0) {
    return {
      overlay: {
        addedPaths: [],
        changedPaths: [],
        deletedPaths: [],
        files: [],
        untrackedPaths: [],
      },
      state: {dirty: false, fingerprint: undefined},
    } satisfies CodeGraphBuildRequestObservation;
  }
  const overlay = parsePorcelainV1Status(porcelain.stdout);
  if (scope !== undefined) {
    for (const paths of [overlay.changed, overlay.deleted, overlay.added, overlay.untracked]) {
      for (const relative of paths) {
        if (!codeGraphScopeAdmitsPath(scope, relative) && !isOverlayAdmissionControlPath(relative))
          paths.delete(relative);
      }
    }
  }
  const ignoreSources = yield* readThreadnoteIgnoreSources(fs, path, identity.repoRoot);
  const fileRows: string[] = [];
  const observedFiles: CodeGraphObservedOverlayFile[] = [];
  const skippedRows: string[] = [];
  for (const relative of [...overlay.changed].sort(compareCodeUnits)) {
    if (overlay.deleted.has(relative)) continue;
    const materialized = yield* materializeContainedStableRegularFile(
      fs,
      path,
      repositoryRoot,
      relative,
      () => true,
      undefined,
      identity.objectFormat,
    ).pipe(Effect.option);
    if (Option.isSome(materialized)) {
      const contentHash = materialized.value.codeGraphContentHash!;
      fileRows.push(`F\0${relative}\0${contentHash}`);
      observedFiles.push({
        contentHash,
        path: relative,
        size: materialized.value.size,
      });
    } else skippedRows.push(`S\0${relative}`);
  }
  const dirty = overlay.changed.size > 0 || overlay.deleted.size > 0;
  return {
    overlay: {
      addedPaths: [...overlay.added].sort(compareCodeUnits),
      changedPaths: [...overlay.changed].sort(compareCodeUnits),
      deletedPaths: [...overlay.deleted].sort(compareCodeUnits),
      files: observedFiles.sort((left, right) => compareCodeUnits(left.path, right.path)),
      untrackedPaths: [...overlay.untracked].sort(compareCodeUnits),
    },
    state: {
      dirty,
      fingerprint: dirty
        ? sha256HexSync(
            EffectArray.join(
              [
                'build-request-overlay-v2',
                `I\0${sha256HexSync(ignoreSources.committed)}`,
                `L\0${sha256HexSync(ignoreSources.local)}`,
                ...EffectArray.map([...overlay.deleted].sort(compareCodeUnits), relative => `D\0${relative}`),
                ...fileRows,
                ...skippedRows,
              ],
              '\n',
            ),
          )
        : undefined,
    },
  } satisfies CodeGraphBuildRequestObservation;
});

export const worktreeBuildRequestState = Effect.fn('codeGraph.worktreeBuildRequestState')(function* (
  identity: RepositoryIdentity,
  threadnoteHome?: string,
  scope?: ResolvedCodeGraphIndexScope,
) {
  return (yield* worktreeBuildRequestObservation(identity, threadnoteHome, scope)).state;
});

function summarizePolicyExclusions(
  exclusions: ReadonlyMap<string, PolicyExclusionEntry>,
): CodeGraphInventoryPolicyExclusionSummary {
  const byReason = new Map<CodeGraphInventoryExclusionReason, {bytes: number; files: number}>();
  let bytes = 0;
  for (const exclusion of exclusions.values()) {
    bytes += exclusion.size;
    const current = byReason.get(exclusion.reason) ?? {bytes: 0, files: 0};
    byReason.set(exclusion.reason, {
      bytes: current.bytes + exclusion.size,
      files: current.files + 1,
    });
  }
  return {
    bytes,
    files: exclusions.size,
    policyVersion: CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
    reasons: EffectArray.map(CODE_GRAPH_INVENTORY_EXCLUSION_REASONS, reason => ({
      bytes: byReason.get(reason)?.bytes ?? 0,
      files: byReason.get(reason)?.files ?? 0,
      reason,
    })),
  };
}

function formatPolicyExclusionDiagnostic(summary: CodeGraphInventoryPolicyExclusionSummary): string {
  return `Inventory admission policy v${summary.policyVersion} excluded ${summary.files} file(s) (${summary.bytes} bytes) before content loading: ${EffectArray.join(
    EffectArray.map(summary.reasons, reason => `${reason.reason}=${reason.files}/${reason.bytes} bytes`),
    ', ',
  )}.`;
}

/**
 * Resolve manifest-declared source roots before applying broad vendor/build-name pruning.
 *
 * A directory called `pods`, `build`, or `out` is usually generated, but those are also
 * legal module names. Only a checked-in workspace/build manifest can override the matching
 * directory prefix; nested generated directories remain pruned. Hidden directories and
 * node_modules never participate in this bootstrap pass.
 */
export const discoverDeclaredSourceRoots = Effect.fn('codeGraph.discoverDeclaredSourceRoots')(function* (
  identity: RepositoryIdentity,
  entries: readonly GitTreeEntry[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
) {
  const contexts = EffectArray.filter(entries, (entry, __effectArrayIndex) => {
    if (!(__effectArrayIndex in entries)) return false;
    if (entry.size > CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT || !languagePacks.isResolutionContext(entry.path)) {
      return false;
    }
    const directories = Effect2.pipe(entry.path, EffectString.split('/')).slice(0, -1);
    return !EffectArray.some(
      directories,
      directory =>
        Effect2.pipe(directory, EffectString.startsWith('.')) ||
        Effect2.pipe(directory, EffectString.toLowerCase) === 'node_modules',
    );
  });
  if (contexts.length === 0) {
    const catalog = yield* resolveCodeGraphWorkspaceCatalog([], languagePacks);
    return {
      catalog,
      files: new Map<string, CodeGraphInventoryFile>(),
      projectRoots: [],
      sourceRoots: [],
      workspace: catalog.workspace,
    };
  }

  const files: CodeGraphInventoryFile[] = [];
  for (const batch of codeGraphCatFileBatches(contexts)) {
    const expectedBytes = EffectArray.reduce(batch, 0, (total, entry) => total + entry.size) + batch.length * 256;
    const result = yield* runBinaryCommandEffect('git', ['-C', identity.repoRoot, 'cat-file', '--batch'], {
      input: new TextEncoder().encode(
        `${EffectArray.join(
          EffectArray.map(batch, entry => entry.blobId),
          '\n',
        )}\n`,
      ),
      maxOutputBytes: expectedBytes,
      timeoutMs: 0,
    });
    const blobs = parseGitCatFileBatch(result.stdout, batch);
    for (let index = 0; index < batch.length; index += 1) {
      const entry = batch[index];
      const bytes = blobs[index];
      if (!bytes || appearsGitLfsPointer(bytes) || appearsBinary(bytes)) continue;
      files.push(
        retainResolutionContext(
          {
            ...committedInventoryFile(identity, entry, languagePacks),
            content: decodeUtf8(bytes),
          },
          languagePacks,
        ),
      );
    }
  }
  const catalog = yield* resolveCodeGraphWorkspaceCatalog(files, languagePacks);
  const workspace = catalog.workspace;
  const projectRoots = [
    ...new Set(
      EffectArray.filter(
        EffectArray.map(
          EffectArray.map(workspace.projects, project => project.root),
          normalizeRepositoryPath,
        ),
        root =>
          root.length > 0 &&
          !EffectArray.some(Effect2.pipe(root, EffectString.split('/')), segment => segment === '..' || segment === ''),
      ),
    ),
  ].sort(compareCodeUnits);
  const sourceRoots = [
    ...new Set(
      EffectArray.filter(
        EffectArray.map(
          EffectArrayPipe(workspace.projects, __effectArrayValues =>
            EffectArray.flatMap(__effectArrayValues, (project, __effectArrayIndex3) =>
              __effectArrayIndex3 in __effectArrayValues ? project.sourceRoots : [],
            ),
          ),
          normalizeRepositoryPath,
        ),
        root =>
          root.length > 0 &&
          !EffectArray.some(Effect2.pipe(root, EffectString.split('/')), segment => segment === '..' || segment === ''),
      ),
    ),
  ].sort(compareCodeUnits);
  return {
    catalog,
    files: new Map(EffectArray.map(files, file => [file.path, file])),
    projectRoots,
    sourceRoots,
    workspace,
  };
});

const discoverOverlaySourceRoots = Effect.fn('codeGraph.discoverOverlaySourceRoots')(function* (
  identity: RepositoryIdentity,
  path: Path.Path,
  changedPaths: ReadonlySet<string>,
  changedMetadata: ReadonlyMap<string, StableContainedRegularFileMetadata>,
  ignoredChangedPaths: ReadonlySet<string>,
  threadnoteIgnoredChangedPaths: ReadonlySet<string>,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  declaredProjectRoots: readonly string[],
  declaredSourceRoots: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const repositoryRoot = yield* fs.realPath(identity.repoRoot);
  const overlayContextFiles: CodeGraphInventoryFile[] = [];
  for (const relative of [...changedPaths].sort(compareCodeUnits)) {
    if (!languagePacks.isResolutionContext(relative)) continue;
    if (ignoredChangedPaths.has(relative) || threadnoteIgnoredChangedPaths.has(relative)) continue;
    const directories = Effect2.pipe(relative, EffectString.split('/')).slice(0, -1);
    if (
      EffectArray.some(
        directories,
        directory =>
          Effect2.pipe(directory, EffectString.startsWith('.')) ||
          Effect2.pipe(directory, EffectString.toLowerCase) === 'node_modules',
      )
    ) {
      continue;
    }
    const metadata = changedMetadata.get(relative);
    if (metadata === undefined || codeGraphInventoryExclusionReason(relative, metadata.size) !== undefined) continue;
    const opened = yield* materializeContainedStableRegularFile(
      fs,
      path,
      repositoryRoot,
      relative,
      size => size > CORPUS_EXTRACTION_SOURCE_BYTES_LIMIT,
      metadata.size,
      identity.objectFormat,
    ).pipe(Effect.option);
    if (opened._tag === 'None' || opened.value.bytes === undefined) continue;
    if (appearsGitLfsPointer(opened.value.bytes) || appearsBinary(opened.value.bytes)) continue;
    const matched = languagePacks.match(relative);
    const contentHash = opened.value.codeGraphContentHash!;
    overlayContextFiles.push(
      retainResolutionContext(
        {
          blobId: `worktree:${contentHash}`,
          content: decodeUtf8(opened.value.bytes),
          contentHash,
          language: Option.match(matched, {
            onNone: () => 'text',
            onSome: value => value.language,
          }),
          mode: '100644',
          path: relative,
          rawContentHash: opened.value.contentHash,
          size: opened.value.size,
          source: 'worktree',
        },
        languagePacks,
      ),
    );
  }
  const overlayWorkspace =
    overlayContextFiles.length === 0 ? undefined : yield* languagePacks.discoverWorkspace(overlayContextFiles);
  const projectRoots = EffectArray.filter(
    EffectArray.map(
      [
        ...new Set([
          ...declaredProjectRoots,
          ...(Option.getOrUndefined(
            Option.map(Option.fromNullishOr(overlayWorkspace?.projects), __effectArrayReceiver =>
              EffectArray.map(__effectArrayReceiver, project => project.root),
            ),
          ) ?? []),
        ]),
      ],
      normalizeRepositoryPath,
    ),
    root =>
      root.length > 0 &&
      !EffectArray.some(Effect2.pipe(root, EffectString.split('/')), segment => segment === '..' || segment === ''),
  ).sort(compareCodeUnits);
  const sourceRoots = EffectArray.filter(
    EffectArray.map(
      [
        ...new Set([
          ...declaredSourceRoots,
          ...(Option.getOrUndefined(
            Option.map(Option.fromNullishOr(overlayWorkspace), __overlayWorkspace => {
              const __projects = __overlayWorkspace.projects;
              return EffectArray.flatMap(__projects, (project, __effectArrayIndex) =>
                __effectArrayIndex in __projects ? project.sourceRoots : [],
              );
            }),
          ) ?? []),
        ]),
      ],
      normalizeRepositoryPath,
    ),
    root =>
      root.length > 0 &&
      !EffectArray.some(Effect2.pipe(root, EffectString.split('/')), segment => segment === '..' || segment === ''),
  ).sort(compareCodeUnits);
  return {projectRoots, sourceRoots};
});

export function acceptsRepositoryPath(
  value: string,
  threadnoteIgnore = '',
  declaredProjectRoots: readonly string[] = [],
  declaredSourceRoots: readonly string[] = [],
  threadnoteIgnoreLocal = '',
): boolean {
  return acceptsRepositoryPathWithRules(
    value,
    compileThreadnoteIgnore(threadnoteIgnore, threadnoteIgnoreLocal),
    BUILTIN_LANGUAGE_PACK_REGISTRY,
    declaredProjectRoots,
    declaredSourceRoots,
  );
}

function acceptsRepositoryPathWithRules(
  value: string,
  ignoreRules: readonly CompiledIgnoreRule[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
  declaredProjectRoots: readonly string[] = [],
  declaredSourceRoots: readonly string[] = [],
  includeOpaqueCorpusAssets = true,
): boolean {
  return (
    repositoryPathExclusionReason(
      value,
      ignoreRules,
      languagePacks,
      declaredProjectRoots,
      declaredSourceRoots,
      includeOpaqueCorpusAssets,
    ) === undefined
  );
}

export function ignoredPaths(repoRoot: string, paths: readonly string[]) {
  if (paths.length === 0) return Effect.succeed(new Set<string>());
  const gitOptions = ['-C', repoRoot, '-c', 'core.ignorecase=false'];
  return runCommandEffect('git', [...gitOptions, 'check-ignore', '--no-index', '-z', '--stdin'], {
    allowFailure: true,
    input: new TextEncoder().encode(`${EffectArray.join(paths, '\0')}\0`),
    maxOutputBytes: 0,
    timeoutMs: 0,
  }).pipe(
    Effect.map(
      result =>
        new Set(
          EffectArray.map(
            EffectArray.filter(Effect2.pipe(result.stdout, EffectString.split('\0')), Boolean),
            normalizeRepositoryPath,
          ),
        ),
    ),
  );
}

const readCommittedFiles = Effect.fn('codeGraph.readCommittedFiles')(function* (
  identity: RepositoryIdentity,
  entries: readonly GitTreeEntry[],
  excluded: number,
  cachedCommittedFileKeys: ReadonlySet<string>,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  preloadedResolutionContexts: ReadonlyMap<string, CodeGraphInventoryFile>,
  onContentBatch?: CodeGraphInventoryOptions['onContentBatch'],
  onParserWorkPlanned?: CodeGraphInventoryOptions['onParserWorkPlanned'],
  onProgress?: CodeGraphInventoryOptions['onProgress'],
) {
  const files: CodeGraphInventoryFile[] = [];
  let skipped = 0;
  let completed = 0;
  const parsedPaths = new Set<string>();
  const needsContent: Array<GitTreeEntry & {readonly parse: boolean}> = [];
  const metadataOnlyContent: CodeGraphInventoryFile[] = [];
  for (const entry of entries) {
    const metadata = committedInventoryFile(identity, entry, languagePacks);
    const extractorSet = Option.getOrElse(languagePacks.cacheIdentityForPath(entry.path), () => 'unmatched');
    const blobReuseKey = codeGraphBlobReuseCacheKey(metadata, extractorSet);
    const cached =
      cachedCommittedFileKeys.has(cacheKey(entry.path, metadata.contentHash, languagePacks)) ||
      (blobReuseKey !== undefined && cachedCommittedFileKeys.has(blobReuseKey));
    const preloaded = preloadedResolutionContexts.get(entry.path);
    if (preloaded && cached) {
      files.push(preloaded);
      completed += 1;
    } else if (cached && !languagePacks.isResolutionContext(entry.path)) {
      files.push(metadata);
      completed += 1;
    } else if (!cached && repositoryContentOmissionReason(entry.path, entry.size, languagePacks) !== undefined) {
      const omittedMetadata = {
        ...metadata,
        contentOmittedReason: repositoryContentOmissionReason(entry.path, entry.size, languagePacks),
      } satisfies CodeGraphInventoryFile;
      metadataOnlyContent.push(omittedMetadata);
      files.push(retainResolutionContext(omittedMetadata, languagePacks));
      parsedPaths.add(entry.path);
      completed += 1;
    } else {
      needsContent.push({...entry, parse: !cached});
    }
  }
  const blobReuse = committedBlobReusePlan(identity, needsContent, languagePacks);
  const blobReuseCounts = blobReuse.counts;
  const orderedNeedsContent = [...needsContent].sort((left, right) => {
    const leftKey = blobReuse.keysByPath.get(left.path);
    const rightKey = blobReuse.keysByPath.get(right.path);
    const leftDuplicate = leftKey !== undefined && blobReuseCounts.has(leftKey);
    const rightDuplicate = rightKey !== undefined && blobReuseCounts.has(rightKey);
    if (leftDuplicate !== rightDuplicate) return leftDuplicate ? -1 : 1;
    if (leftDuplicate && rightDuplicate) {
      const keyOrder = compareCodeUnits(leftKey, rightKey);
      if (keyOrder !== 0) return keyOrder;
    }
    return compareCodeUnits(left.path, right.path);
  });
  const extractionPlan = codeGraphExtractionPlanMetrics([
    ...metadataOnlyContent,
    ...EffectArray.map(
      EffectArray.filter(
        orderedNeedsContent,
        (entry, __effectArrayIndex) => __effectArrayIndex in orderedNeedsContent && entry.parse,
      ),
      entry => committedInventoryFile(identity, entry, languagePacks),
    ),
  ]);
  const parserWorkFileCount = EffectArray.reduce(
    orderedNeedsContent,
    0,
    (count, entry) => count + (entry.parse ? 1 : 0),
  );
  let parserWorkPrepared = false;
  for (let offset = 0; offset < metadataOnlyContent.length; offset += CODE_GRAPH_CAT_FILE_BATCH_ENTRIES) {
    const batch = metadataOnlyContent.slice(offset, offset + CODE_GRAPH_CAT_FILE_BATCH_ENTRIES);
    yield* onContentBatch?.(batch, {
      extractionPlan,
      progress: {
        accepted: files.length,
        completed: completed - metadataOnlyContent.length + offset,
        excluded,
        phase: 'scanning',
        skipped,
        total: entries.length,
        unit: 'files',
      },
      readingMilliseconds: 0,
      sourceBytes: EffectArray.reduce(batch, 0, (total, file) => total + file.size),
    }) ?? Effect.void;
  }
  yield* onProgress?.({
    accepted: files.length,
    completed,
    excluded,
    phase: 'scanning',
    skipped,
    total: entries.length,
    unit: 'files',
  }) ?? Effect.void;
  for (const batch of codeGraphCatFileBatches(orderedNeedsContent)) {
    const first = batch[0];
    const matches = EffectArray.map(batch, entry => Option.getOrUndefined(languagePacks.match(entry.path)));
    const batchLanguages = new Set(EffectArray.map(matches, value => value?.language ?? 'text'));
    const batchClassifiers = new Set(EffectArray.map(matches, value => value?.pack.id ?? 'unmatched'));
    const batchRoles = new Set(EffectArray.map(matches, value => value?.role ?? 'unmatched'));
    const batchBytes = EffectArray.reduce(batch, 0, (total, entry) => total + entry.size);
    yield* onProgress?.({
      accepted: files.length,
      activity: {
        batchCompleted: 0,
        batchTotal: batch.length,
        bytes: batchBytes,
        classifier: batchClassifiers.size === 1 ? [...batchClassifiers][0] : 'mixed',
        language: batchLanguages.size === 1 ? [...batchLanguages][0] : 'mixed',
        path: first.path,
        role: batchRoles.size === 1 ? [...batchRoles][0] : 'mixed',
        sizeBucket: codeGraphSourceSizeBucket(batchBytes),
        stage: 'reading',
      },
      completed,
      excluded,
      phase: 'scanning',
      skipped,
      total: entries.length,
      unit: 'files',
    }) ?? Effect.void;
    const expectedBytes = EffectArray.reduce(batch, 0, (total, entry) => total + entry.size) + batch.length * 256;
    const prepareParserWork =
      !parserWorkPrepared && parserWorkFileCount > 0
        ? Effect.suspend(() => {
            parserWorkPrepared = true;
            return onParserWorkPlanned?.(parserWorkFileCount) ?? Effect.void;
          })
        : Effect.void;
    const [, {readingMilliseconds, result}] = yield* Effect.all(
      [
        prepareParserWork,
        Effect.suspend(() => {
          const readingStarted = performance.now();
          return runBinaryCommandEffect('git', ['-C', identity.repoRoot, 'cat-file', '--batch'], {
            input: new TextEncoder().encode(
              `${EffectArray.join(
                EffectArray.map(batch, entry => entry.blobId),
                '\n',
              )}\n`,
            ),
            maxOutputBytes: expectedBytes,
            timeoutMs: 0,
          }).pipe(
            Effect.map(result => ({
              readingMilliseconds: performance.now() - readingStarted,
              result,
            })),
          );
        }),
      ],
      {concurrency: 'unbounded'},
    );
    const blobs = parseGitCatFileBatch(result.stdout, batch);
    const contentBatch: CodeGraphInventoryFile[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const entry = batch[index];
      const bytes = blobs[index];
      if (!bytes || appearsGitLfsPointer(bytes)) {
        skipped += 1;
        continue;
      }
      const content = appearsBinary(bytes) ? undefined : decodeUtf8(bytes);
      const acceptsBinary = acceptsBinaryContent(entry.path, languagePacks);
      if (content === undefined && !acceptsBinary) {
        skipped += 1;
        continue;
      }
      const hydrated = {
        ...committedInventoryFile(identity, entry, languagePacks),
        // Text is decoded before the batch buffer can escape. Binary inputs must
        // retain an isolated copy instead of pinning the entire cat-file response.
        ...(content === undefined ? {bytes: bytes.slice()} : {content}),
      } satisfies CodeGraphInventoryFile;
      if (entry.parse) contentBatch.push(hydrated);
      const retained = retainResolutionContext(hydrated, languagePacks);
      files.push(retained);
    }
    if (contentBatch.length > 0) {
      yield* onContentBatch?.(contentBatch, {
        ...(blobReuseCounts.size === 0 ? {} : {blobReuseCounts}),
        extractionPlan,
        progress: {
          accepted: files.length,
          completed,
          excluded,
          phase: 'scanning',
          skipped,
          total: entries.length,
          unit: 'files',
        },
        readingMilliseconds,
        sourceBytes: EffectArray.reduce(contentBatch, 0, (total, file) => total + file.size),
      }) ?? Effect.void;
    }
    for (const file of contentBatch) parsedPaths.add(file.path);
    completed += batch.length;
    yield* onProgress?.({
      accepted: files.length,
      completed,
      excluded,
      phase: 'scanning',
      skipped,
      total: entries.length,
      unit: 'files',
    }) ?? Effect.void;
  }
  return {files, parsedPaths, skipped};
});

function committedBlobReusePlan(
  identity: RepositoryIdentity,
  entries: readonly (GitTreeEntry & {readonly parse: boolean})[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): {
  readonly counts: ReadonlyMap<string, number>;
  readonly keysByPath: ReadonlyMap<string, string>;
} {
  const counts = new Map<string, number>();
  const keysByPath = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.parse) continue;
    const key = committedBlobReuseKey(identity, entry, languagePacks);
    if (key === undefined) continue;
    keysByPath.set(entry.path, key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    counts: new Map(EffectArray.filter([...counts], ([, count]) => count > 1)),
    keysByPath,
  };
}

function committedBlobReuseKey(
  identity: RepositoryIdentity,
  entry: GitTreeEntry,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): string | undefined {
  const file = committedInventoryFile(identity, entry, languagePacks);
  const extractorSet = Option.getOrElse(languagePacks.cacheIdentityForPath(entry.path), () => 'unmatched');
  return codeGraphBlobReuseCacheKey(file, extractorSet);
}

function inventoryFileForCommittedEntry(
  entry: GitTreeEntry,
  contentHash: string,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): CodeGraphInventoryFile {
  const matched = languagePacks.match(entry.path);
  return {
    blobId: entry.blobId,
    contentHash,
    language: Option.match(matched, {
      onNone: () => 'text',
      onSome: value => value.language,
    }),
    mode: entry.mode,
    path: entry.path,
    size: entry.size,
    source: 'commit',
  };
}

function committedInventoryFile(
  repo: RepositoryIdentity,
  entry: GitTreeEntry,
  packs: CodeGraphLanguagePackRegistryShape,
): CodeGraphInventoryFile {
  return inventoryFileForCommittedEntry(entry, codeGraphCommittedContentHash(repo.objectFormat, entry.blobId), packs);
}

export function parseGitCatFileBatch(
  bytes: Uint8Array,
  entries: readonly Pick<GitTreeEntry, 'blobId' | 'size'>[],
): readonly Uint8Array[] {
  const output: Uint8Array[] = [];
  const headerDecoder = new TextDecoder();
  let offset = 0;
  for (const expected of entries) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0) throw CodeGraphInventoryError.of('Git cat-file batch ended before its header.');
    const header = headerDecoder.decode(bytes.subarray(offset, newline));
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!match || match[1] !== expected.blobId) {
      throw CodeGraphInventoryError.of(`Git cat-file returned an unexpected object for ${expected.blobId}.`);
    }
    const size = Number(match[2]);
    const start = newline + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || size < 0 || end >= bytes.byteLength || bytes[end] !== 10) {
      throw CodeGraphInventoryError.of(`Git cat-file returned a truncated object for ${expected.blobId}.`);
    }
    // Return a view for immediate classification/UTF-8 decoding. The inventory
    // path copies only binary payloads that must outlive this batch buffer.
    output.push(bytes.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== bytes.byteLength) throw CodeGraphInventoryError.of('Git cat-file batch returned trailing bytes.');
  return output;
}

export const readDirtyOverlay = Effect.fn('codeGraph.readDirtyOverlay')(function* (
  identity: RepositoryIdentity,
  path: Path.Path,
  ignoreSources: ThreadnoteIgnoreSources,
  ignoreRules: readonly CompiledIgnoreRule[],
  cachedFileKeys: ReadonlySet<string>,
  languagePacks: CodeGraphLanguagePackRegistryShape,
  declaredProjectRoots: readonly string[],
  declaredSourceRoots: readonly string[],
  committedPolicyExclusions: ReadonlyMap<string, PolicyExclusionEntry>,
  committedTreeEntries: ReadonlyMap<string, GitTreeEntry>,
  knownCommittedAcceptedPaths?: ReadonlySet<string>,
  includeOpaqueCorpusAssets = true,
  onContentBatch?: CodeGraphInventoryOptions['onContentBatch'],
  onOverlayStart?: CodeGraphInventoryOptions['onOverlayStart'],
  overlayObservation?: CodeGraphOverlayObservation,
  includePath?: (path: string) => boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const repositoryRoot = yield* fs.realPath(identity.repoRoot);
  const unborn = isZeroObjectId(identity.headCommit);
  let changes: ReturnType<typeof parseNameStatus>;
  let untracked: Set<string>;
  if (overlayObservation !== undefined) {
    changes = {
      added: new Set(overlayObservation.addedPaths),
      changed: new Set(overlayObservation.changedPaths),
      deleted: new Set(overlayObservation.deletedPaths),
    };
    untracked = new Set(overlayObservation.untrackedPaths);
  } else {
    const [diffOutput, untrackedOutput] = unborn
      ? [
          '',
          (yield* runCommandEffect(
            'git',
            ['-C', identity.repoRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
            {
              maxOutputBytes: 0,
              timeoutMs: 0,
            },
          )).stdout,
        ]
      : yield* Effect.all(
          [
            runCommandEffect(
              'git',
              ['-C', identity.repoRoot, 'diff', '--name-status', '-z', '--find-renames', identity.headCommit, '--'],
              {maxOutputBytes: 0, timeoutMs: 0},
            ).pipe(Effect.map(result => result.stdout)),
            runCommandEffect('git', ['-C', identity.repoRoot, 'ls-files', '-z', '--others', '--exclude-standard'], {
              maxOutputBytes: 0,
              timeoutMs: 0,
            }).pipe(Effect.map(result => result.stdout)),
          ],
          {concurrency: 2},
        );
    changes = parseNameStatus(diffOutput);
    untracked = new Set(
      EffectArray.map(
        EffectArray.filter(Effect2.pipe(untrackedOutput, EffectString.split('\0')), Boolean),
        normalizeRepositoryPath,
      ),
    );
    for (const value of untracked) changes.changed.add(value);
  }
  if (includePath !== undefined) {
    for (const paths of [changes.changed, changes.deleted, changes.added, untracked]) {
      for (const relative of paths) if (!includePath(relative)) paths.delete(relative);
    }
  }
  if (changes.changed.size > 0 || changes.deleted.size > 0) yield* onOverlayStart?.() ?? Effect.void;
  const relevantChangedPaths = EffectArray.filter([...new Set([...changes.changed, ...changes.deleted])], relative =>
    isPotentialOverlayCandidate(relative, languagePacks),
  );
  const threadnoteIgnoredChangedPaths = new Set(
    EffectArray.filter(relevantChangedPaths, relative => isIgnoredByThreadnote(relative, ignoreRules)),
  );
  const ignoredChangedPaths = yield* ignoredPaths(
    identity.repoRoot,
    EffectArray.filter(relevantChangedPaths, relative => !threadnoteIgnoredChangedPaths.has(relative)),
  );
  const committedPathWasAccepted = (relative: string): boolean => {
    if (knownCommittedAcceptedPaths !== undefined) return knownCommittedAcceptedPaths.has(relative);
    const entry = committedTreeEntries.get(relative);
    return (
      entry !== undefined &&
      !committedPolicyExclusions.has(relative) &&
      !ignoredChangedPaths.has(relative) &&
      acceptsRepositoryPathWithRules(
        relative,
        ignoreRules,
        languagePacks,
        declaredProjectRoots,
        declaredSourceRoots,
        includeOpaqueCorpusAssets,
      )
    );
  };
  const policyExclusions = new Map(committedPolicyExclusions);
  let policySkippedDelta = 0;
  for (const relative of [...changes.deleted]) {
    if (!policyExclusions.delete(relative)) continue;
    changes.deleted.delete(relative);
    policySkippedDelta -= 1;
  }
  const changedMetadata = new Map<string, StableContainedRegularFileMetadata>();
  for (const relative of EffectArray.filter(relevantChangedPaths, relative => changes.changed.has(relative)).sort(
    compareCodeUnits,
  )) {
    if (
      (ignoredChangedPaths.has(relative) || threadnoteIgnoredChangedPaths.has(relative)) &&
      !isInventoryPolicyExtension(relative)
    ) {
      continue;
    }
    const inspected = yield* inspectContainedStableRegularFile(fs, path, repositoryRoot, relative).pipe(Effect.option);
    if (inspected._tag === 'Some') changedMetadata.set(relative, inspected.value);
  }
  const overlayRoots = yield* discoverOverlaySourceRoots(
    identity,
    path,
    changes.changed,
    changedMetadata,
    ignoredChangedPaths,
    threadnoteIgnoredChangedPaths,
    languagePacks,
    declaredProjectRoots,
    declaredSourceRoots,
  );
  const effectiveDeclaredProjectRoots = overlayRoots.projectRoots;
  const effectiveDeclaredSourceRoots = overlayRoots.sourceRoots;
  const files: CodeGraphInventoryFile[] = [];
  let skipped = 0;
  const parsedPaths = new Set<string>();
  let contentBatch: CodeGraphInventoryFile[] = [];
  let contentBatchBytes = 0;
  let contentBatchReadingMilliseconds = 0;
  const changed = new Set([...changes.deleted, ...changes.changed]);
  const skippedPaths = new Set<string>();
  const markSkipped = (relative: string) => {
    skipped += 1;
    if (
      (untracked.has(relative) || changes.added.has(relative)) &&
      (!isOverlayAdmissionControlPath(relative) || emptyThreadnoteIgnoreAdmissionPath(relative, ignoreSources))
    ) {
      changed.delete(relative);
      return;
    }
    skippedPaths.add(relative);
  };
  const flushContentBatch = () => {
    const current = contentBatch;
    const readingMilliseconds = contentBatchReadingMilliseconds;
    const sourceBytes = contentBatchBytes;
    contentBatch = [];
    contentBatchBytes = 0;
    contentBatchReadingMilliseconds = 0;
    for (const file of current) parsedPaths.add(file.path);
    return current.length > 0
      ? (onContentBatch?.(current, {
          progress: {
            accepted: files.length,
            completed: files.length + skipped,
            excluded: 0,
            phase: 'scanning',
            skipped,
            total: changes.changed.size,
            unit: 'files',
          },
          readingMilliseconds,
          sourceBytes,
        }) ?? Effect.void)
      : Effect.void;
  };
  for (const relative of [...changes.changed].sort()) {
    const previousPolicyExclusion = policyExclusions.get(relative);
    const metadata = changedMetadata.get(relative);
    if (metadata === undefined) {
      if (previousPolicyExclusion !== undefined) {
        policyExclusions.delete(relative);
        changed.delete(relative);
        continue;
      }
      if (
        !isOverlayAdmissionControlPath(relative) &&
        !committedPathWasAccepted(relative) &&
        !committedTreeEntries.has(relative)
      ) {
        skipped += 1;
        changed.delete(relative);
        continue;
      }
      if (
        !isOverlayAdmissionControlPath(relative) &&
        !committedPathWasAccepted(relative) &&
        committedTreeEntries.has(relative)
      ) {
        changed.delete(relative);
        continue;
      }
      markSkipped(relative);
      continue;
    }
    const policyExclusionReason = codeGraphInventoryExclusionReason(relative, metadata.size);
    if (policyExclusionReason !== undefined) {
      policyExclusions.set(relative, {
        reason: policyExclusionReason,
        size: metadata.size,
      });
      if (
        previousPolicyExclusion === undefined &&
        (!committedTreeEntries.has(relative) || committedPathWasAccepted(relative))
      ) {
        policySkippedDelta += 1;
      }
      if (committedPathWasAccepted(relative)) {
        skippedPaths.add(relative);
      } else {
        changed.delete(relative);
      }
      continue;
    }
    if (previousPolicyExclusion !== undefined) policyExclusions.delete(relative);
    const absolute = path.resolve(identity.repoRoot, relative);
    const containment = path.relative(identity.repoRoot, absolute);
    if (
      containment === '..' ||
      Effect2.pipe(containment, EffectString.startsWith(`..${path.sep}`)) ||
      path.isAbsolute(containment) ||
      ignoredChangedPaths.has(relative) ||
      !acceptsRepositoryPathWithRules(
        relative,
        ignoreRules,
        languagePacks,
        effectiveDeclaredProjectRoots,
        effectiveDeclaredSourceRoots,
        includeOpaqueCorpusAssets,
      )
    ) {
      if (previousPolicyExclusion !== undefined) {
        changed.delete(relative);
        continue;
      }
      if (!committedPathWasAccepted(relative)) {
        if (!committedTreeEntries.has(relative)) skipped += 1;
        changed.delete(relative);
        continue;
      }
      markSkipped(relative);
      continue;
    }
    if (previousPolicyExclusion !== undefined) policySkippedDelta -= 1;
    const readingStarted = performance.now();
    const opened = yield* materializeContainedStableRegularFile(
      fs,
      path,
      repositoryRoot,
      relative,
      size => shouldOmitRepositoryContent(relative, size, languagePacks),
      metadata.size,
      identity.objectFormat,
    ).pipe(Effect.option);
    const readingMilliseconds = performance.now() - readingStarted;
    if (opened._tag === 'None') {
      markSkipped(relative);
      continue;
    }
    const materialized = opened.value;
    const codeGraphContentHash = materialized.codeGraphContentHash!;
    const matched = languagePacks.match(relative);
    if (materialized.bytes === undefined) {
      const contentOmittedReason = repositoryContentOmissionReason(relative, materialized.size, languagePacks);
      if (contentOmittedReason === undefined) {
        markSkipped(relative);
        continue;
      }
      const metadata = {
        blobId: `worktree:${codeGraphContentHash}`,
        contentHash: codeGraphContentHash,
        contentOmittedReason,
        language: Option.match(matched, {
          onNone: () => 'text',
          onSome: value => value.language,
        }),
        mode: '100644',
        path: relative,
        rawContentHash: materialized.contentHash,
        size: materialized.size,
        source: 'worktree',
      } satisfies CodeGraphInventoryFile;
      if (!cachedFileKeys.has(cacheKey(relative, codeGraphContentHash, languagePacks))) {
        if (contentBatch.length >= CODE_GRAPH_CAT_FILE_BATCH_ENTRIES) yield* flushContentBatch();
        contentBatch.push(metadata);
        contentBatchBytes += materialized.size;
        contentBatchReadingMilliseconds += readingMilliseconds;
      }
      files.push(retainResolutionContext(metadata, languagePacks));
      continue;
    }
    const bytes = materialized.bytes;
    if (appearsGitLfsPointer(bytes)) {
      markSkipped(relative);
      continue;
    }
    const content = appearsBinary(bytes) ? undefined : decodeUtf8(bytes);
    const acceptsBinary = acceptsBinaryContent(relative, languagePacks);
    if (content === undefined && !acceptsBinary) {
      markSkipped(relative);
      continue;
    }
    if (
      contentBatch.length > 0 &&
      (contentBatch.length >= CODE_GRAPH_CAT_FILE_BATCH_ENTRIES ||
        contentBatchBytes + bytes.byteLength > CODE_GRAPH_CAT_FILE_BATCH_BYTES)
    ) {
      yield* flushContentBatch();
    }
    const contentHash = codeGraphContentHash;
    const hydrated = {
      blobId: `worktree:${contentHash}`,
      ...(content === undefined ? {bytes} : {content}),
      contentHash,
      language: Option.match(matched, {
        onNone: () => 'text',
        onSome: value => value.language,
      }),
      mode: '100644',
      path: relative,
      rawContentHash: materialized.contentHash,
      size: bytes.byteLength,
      source: 'worktree',
    } satisfies CodeGraphInventoryFile;
    if (!cachedFileKeys.has(cacheKey(relative, contentHash, languagePacks))) {
      contentBatch.push(hydrated);
      contentBatchBytes += bytes.byteLength;
      contentBatchReadingMilliseconds += readingMilliseconds;
    }
    const retained = retainResolutionContext(hydrated, languagePacks);
    files.push(retained);
  }
  yield* flushContentBatch();
  const dirty = changed.size > 0;
  return {
    changed,
    dirty,
    files,
    fingerprint: dirty
      ? sha256HexSync(
          EffectArray.join(
            [
              `I\0${sha256HexSync(ignoreSources.committed)}`,
              `L\0${sha256HexSync(ignoreSources.local)}`,
              ...EffectArray.map([...changes.deleted].sort(), relative => `D\0${relative}`),
              ...EffectArray.map(files, file => `F\0${file.path}\0${file.contentHash}`).sort(),
              ...EffectArray.map([...skippedPaths].sort(), relative => `S\0${relative}`),
            ],
            '\n',
          ),
        )
      : undefined,
    parsedPaths,
    policyExclusions,
    policySkippedDelta,
    skipped,
  };
});

const canonicalizePotentialPath = Effect.fn('codeGraph.canonicalizePotentialPath')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
) {
  let current = path.resolve(target);
  const missingSegments: string[] = [];
  while (true) {
    const canonical = yield* fs.realPath(current).pipe(Effect.option);
    if (Option.isSome(canonical)) return path.join(canonical.value, ...missingSegments);
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
});

function cacheKey(path: string, contentHash: string, languagePacks: CodeGraphLanguagePackRegistryShape): string {
  return `${path}\0${contentHash}\0${Option.getOrElse(languagePacks.cacheIdentityForPath(path), () => 'unmatched')}`;
}

export function isZeroObjectId(value: string): boolean {
  return /^0{40}(?:0{24})?$/.test(value);
}
