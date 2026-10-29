import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Option, Path} from 'effect';
import {
  compileThreadnoteIgnore,
  type CodeGraphInventoryOptions,
  type CodeGraphOverlayObservation,
  type GitTreeEntry,
  isOverlayAdmissionControlPath,
  readDirtyOverlay,
  sameInventoryPathSet,
} from '../inventory.js';
import {codeGraphInventoryReuseContract, readCodeGraphInventoryReuseEnvironment} from './reuse.js';
import {codeGraphInventoryExclusionReason} from './policy.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY} from '../languages/registry.js';
import type {CodeGraphWorkspace} from '../languages/types.js';
import {compareCodeUnits} from '../ordering.js';
import type {CodeGraphReusableCleanBaseSlice} from '../store/models.js';
import type {CodeGraphInventoryFile, RepositoryIdentity} from '../types.js';
import {codeGraphScopedBaseReusable} from '../scope/applicability.js';

/**
 * Changed-path-only dirty admission over a persisted clean base. The complete
 * base inventory remains in SQLite; this projection never represents it as a
 * JavaScript array.
 */
export interface CodeGraphReusableOverlayAdmission {
  readonly base: CodeGraphReusableCleanBaseSlice;
  readonly diagnostics: readonly string[];
  readonly files: readonly CodeGraphInventoryFile[];
  readonly overlayFingerprint: string;
  readonly parsedFiles: number;
  readonly skipped: number;
  readonly workspace: CodeGraphWorkspace;
}

/**
 * Admit an unchanged-file-set dirty overlay from only the requested persisted
 * rows. Deletions and resolution-context changes deliberately retain the full
 * inventory fallback until their dependency closure is represented sparsely.
 */
export const inventoryRepositoryFromReusableCleanBaseSlice = Effect.fn(
  'codeGraph.inventoryRepositoryFromReusableBaseSlice',
)(function* (
  identity: RepositoryIdentity,
  base: CodeGraphReusableCleanBaseSlice,
  options: CodeGraphInventoryOptions & {readonly overlayObservation: CodeGraphOverlayObservation},
) {
  const receipt = base.receipt.inventory;
  if (
    receipt === undefined ||
    base.snapshot.repositoryId !== identity.repositoryId ||
    base.snapshot.commit !== identity.headCommit ||
    base.snapshot.dirty ||
    base.snapshot.baseSnapshotId !== undefined
  ) {
    return Option.none<CodeGraphReusableOverlayAdmission>();
  }
  const languagePacks = options.languagePacks ?? BUILTIN_LANGUAGE_PACK_REGISTRY;
  if (options.project?.graph !== undefined && options.scopeObservation?.scope === undefined)
    return Option.none<CodeGraphReusableOverlayAdmission>();
  if (
    !(yield* codeGraphScopedBaseReusable(
      {inventory: options.scopeObservation ?? {}, identity, languagePacks},
      {...base, files: options.scopeObservation?.committedFiles ?? base.files},
    ))
  )
    return Option.none<CodeGraphReusableOverlayAdmission>();
  const includeOpaqueCorpusAssets = options.includeOpaqueCorpusAssets !== false;
  if (
    receipt.includeOpaqueCorpusAssets !== includeOpaqueCorpusAssets ||
    receipt.contract !== codeGraphInventoryReuseContract(languagePacks, includeOpaqueCorpusAssets)
  ) {
    return Option.none<CodeGraphReusableOverlayAdmission>();
  }
  const observation = options.overlayObservation;
  if (
    observation.changedPaths.length === 0 ||
    observation.changedPaths.length > 200 ||
    observation.addedPaths.length > 0 ||
    observation.deletedPaths.length > 0 ||
    observation.untrackedPaths.length > 0
  ) {
    return Option.none<CodeGraphReusableOverlayAdmission>();
  }
  const baseByPath = new Map(EffectArray.map(base.files, file => [file.path, file]));
  const requestedChanged = new Set(observation.changedPaths);
  if (
    requestedChanged.size !== observation.changedPaths.length ||
    baseByPath.size !== requestedChanged.size ||
    EffectArray.some(
      [...requestedChanged],
      relative =>
        !baseByPath.has(relative) ||
        isOverlayAdmissionControlPath(relative) ||
        languagePacks.isResolutionContext(relative),
    )
  ) {
    return Option.none<CodeGraphReusableOverlayAdmission>();
  }
  const observedFiles = new Map(EffectArray.map(observation.files, file => [file.path, file]));
  if (
    observedFiles.size !== observation.changedPaths.length ||
    EffectArray.some(observation.changedPaths, relative => {
      const file = observedFiles.get(relative);
      return file === undefined || codeGraphInventoryExclusionReason(relative, file.size) !== undefined;
    })
  ) {
    return Option.none<CodeGraphReusableOverlayAdmission>();
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* readCodeGraphInventoryReuseEnvironment(identity, fs, path);
  if (environment.fingerprint !== receipt.environmentFingerprint) {
    return Option.none<CodeGraphReusableOverlayAdmission>();
  }
  const projectRoots = [
    ...new Set([
      ...EffectArray.map(receipt.workspace.projects, project => project.root),
      ...EffectArray.map(receipt.workspace.workspaces, workspace => workspace.root),
    ]),
  ].sort(compareCodeUnits);
  const sourceRoots = [
    ...new Set(EffectArray.flatMap(receipt.workspace.projects, project => project.sourceRoots)),
  ].sort(compareCodeUnits);
  const committedTreeEntries = new Map(
    EffectArray.map(base.files, file => [
      file.path,
      {blobId: file.blobId, mode: file.mode, path: file.path, size: file.size} satisfies GitTreeEntry,
    ]),
  );
  const overlay = yield* readDirtyOverlay(
    identity,
    path,
    {committed: environment.threadnoteIgnore, local: environment.threadnoteIgnoreLocal},
    compileThreadnoteIgnore(environment.threadnoteIgnore, environment.threadnoteIgnoreLocal),
    options.cachedCommittedFileKeys ?? new Set(),
    languagePacks,
    projectRoots,
    sourceRoots,
    new Map(),
    committedTreeEntries,
    requestedChanged,
    includeOpaqueCorpusAssets,
    options.onContentBatch,
    options.onOverlayStart,
    observation,
  );
  if (
    !overlay.dirty ||
    overlay.fingerprint === undefined ||
    !sameInventoryPathSet(overlay.changed, requestedChanged) ||
    overlay.skipped !== 0 ||
    overlay.policySkippedDelta !== 0 ||
    overlay.files.length !== requestedChanged.size ||
    EffectArray.some(overlay.files, file => observedFiles.get(file.path)?.contentHash !== file.contentHash)
  ) {
    return Option.none<CodeGraphReusableOverlayAdmission>();
  }
  return Option.some({
    base,
    diagnostics: [
      ...receipt.diagnostics,
      `Reused persisted clean inventory admission for ${requestedChanged.size} changed path(s) without hydrating the complete base.`,
    ],
    files: overlay.files,
    overlayFingerprint: overlay.fingerprint,
    parsedFiles: overlay.parsedPaths.size,
    skipped: receipt.skipped,
    workspace: receipt.workspace,
  } satisfies CodeGraphReusableOverlayAdmission);
});
