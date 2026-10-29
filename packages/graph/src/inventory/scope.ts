import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path} from 'effect';
import type {ProjectManifest} from '@threadnote/workspace/config';
import type {CodeGraphInventory, CodeGraphInventoryOptions} from './models.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {CodeGraphScopeApplicabilityEvidence} from '../scope/applicability.js';
import type {RepositoryIdentity} from '../types.js';
import {
  resolveCodeGraphIndexScope,
  resolveCodeGraphWorkspaceCatalog,
  type CodeGraphWorkspaceCatalog,
} from '../index_scope.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY, type CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import {readThreadnoteIgnoreSources, compileThreadnoteIgnore, isIgnoredByThreadnote} from '../threadnote_ignore.js';
import {CodeGraphInventoryError} from './error.js';
import {runCommandEffect} from '@threadnote/platform/command';
import {
  isZeroObjectId,
  parseGitTree,
  policyExclusionsForEntries,
  discoverDeclaredSourceRoots,
  ignoredPaths,
  readDirtyOverlay,
  type GitTreeEntry,
} from '../inventory.js';

export function codeGraphInventoryScopeMetadata(
  observation: Effect.Success<ReturnType<typeof observeCodeGraphIndexScope>> | undefined,
  options: CodeGraphInventoryOptions,
  accepted: readonly GitTreeEntry[],
  excluded: readonly GitTreeEntry[],
  overlay: string | undefined,
) {
  if (observation === undefined) return {};
  const committed = EffectArray.map(accepted, entry => [entry.path, entry.mode, entry.blobId]);
  return {
    scope: observation.scope,
    scopeProject: options.project,
    scopeIncludeOpaqueCorpusAssets: options.includeOpaqueCorpusAssets !== false,
    scopeIncludeOverlay: options.includeOverlay,
    scopeCatalogFingerprint: observation.catalog.fingerprint,
    scopeExclusions: {
      files: excluded.length,
      bytes: EffectArray.reduce(excluded, 0, (total, entry) => total + entry.size),
    },
    scopeInventoryFingerprint: sha256HexSync(JSON.stringify({committed, overlay: overlay ?? null})),
    scopeCommittedInventoryFingerprint: sha256HexSync(JSON.stringify({committed, overlay: null})),
  };
}

export function codeGraphInventoryScopeEvidence(
  inventory: CodeGraphInventory,
  identity: RepositoryIdentity,
  extractorSet: string,
  policyFingerprint: string,
): CodeGraphScopeApplicabilityEvidence | undefined {
  if (
    inventory.scope === undefined ||
    inventory.scopeInventoryFingerprint === undefined ||
    inventory.scopeCatalogFingerprint === undefined
  )
    return undefined;
  return {
    repositoryId: identity.repositoryId,
    worktreeId: identity.worktreeId,
    scopeKey: inventory.scope.scopeKey,
    definitionDigest: inventory.scope.definitionDigest,
    closureDigest: inventory.scope.closureDigest,
    inventoryFingerprint: inventory.scopeInventoryFingerprint,
    overlayFingerprint: inventory.overlayFingerprint,
    extractorSet,
    policyFingerprint,
    observedCommit: identity.headCommit,
    catalogFingerprint: inventory.scopeCatalogFingerprint,
  };
}

/** Preserve the historical clean-base inputs; a scoped commit keeps its resolved view metadata. */
export function committedCodeGraphInventory(inventory: CodeGraphInventory): CodeGraphInventory {
  return {
    ...(inventory.scope === undefined
      ? {}
      : {
          scope: inventory.scope,
          scopeProject: inventory.scopeProject,
          scopeIncludeOverlay: false,
          scopeIncludeOpaqueCorpusAssets: inventory.scopeIncludeOpaqueCorpusAssets,
          scopeExclusions: inventory.scopeExclusions,
          scopeCatalogFingerprint: inventory.scopeCatalogFingerprint,
          scopeInventoryFingerprint: inventory.scopeCommittedInventoryFingerprint,
          scopeCommittedInventoryFingerprint: inventory.scopeCommittedInventoryFingerprint,
          workspace: inventory.workspace,
        }),
    committedFiles: inventory.committedFiles,
    committedParsedFiles: inventory.committedParsedFiles,
    dirty: false,
    files: inventory.committedFiles,
    parsedFiles: inventory.committedParsedFiles,
    skipped: inventory.skipped,
  };
}

/** Read only resolution manifests across the repository before selecting ordinary sources. */
export const observeCodeGraphIndexScope = Effect.fn('codeGraph.observeIndexScope')(function* (
  identity: RepositoryIdentity,
  project: Pick<ProjectManifest, 'graph' | 'uri'>,
  options: {
    readonly includeOverlay?: boolean;
    readonly languagePacks?: CodeGraphLanguagePackRegistryShape;
    readonly cachedCatalog?: CodeGraphWorkspaceCatalog;
    readonly committed?: {
      readonly entries: readonly GitTreeEntry[];
      readonly declared: Effect.Success<ReturnType<typeof discoverDeclaredSourceRoots>>;
      readonly ignoreSources: {readonly committed: string; readonly local: string};
    };
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const languagePacks = options.languagePacks ?? BUILTIN_LANGUAGE_PACK_REGISTRY;
  const entries =
    options.committed?.entries ??
    (isZeroObjectId(identity.headCommit)
      ? []
      : parseGitTree(
          (yield* runCommandEffect('git', ['-C', identity.repoRoot, 'ls-tree', '-r', '-l', '-z', identity.headCommit], {
            maxOutputBytes: 0,
            timeoutMs: 0,
          })).stdout,
        ));
  const policyExcluded = policyExclusionsForEntries(entries);
  const declared =
    options.committed?.declared ??
    (yield* discoverDeclaredSourceRoots(
      identity,
      EffectArray.filter(entries, entry => !policyExcluded.has(entry.path)),
      languagePacks,
    ));
  const ignoreSources =
    options.committed?.ignoreSources ?? (yield* readThreadnoteIgnoreSources(fs, path, identity.repoRoot));
  const ignoreRules = compileThreadnoteIgnore(ignoreSources.committed, ignoreSources.local);
  const ignored = yield* ignoredPaths(identity.repoRoot, [...declared.files.keys()]);
  const files = new Map(
    EffectArray.filter(
      [...declared.files],
      ([relative]) => !ignored.has(relative) && !isIgnoredByThreadnote(relative, ignoreRules),
    ),
  );
  if (options.includeOverlay !== false) {
    const overlay = yield* readDirtyOverlay(
      identity,
      path,
      ignoreSources,
      ignoreRules,
      new Set(),
      languagePacks,
      declared.projectRoots,
      declared.sourceRoots,
      policyExcluded,
      new Map(EffectArray.map(entries, entry => [entry.path, entry])),
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      relative => languagePacks.isResolutionContext(relative),
    );
    for (const relative of overlay.changed) files.delete(relative);
    for (const file of overlay.files) files.set(file.path, file);
  }
  const catalog = yield* resolveCodeGraphWorkspaceCatalog(
    [...files.values()],
    languagePacks,
    options.cachedCatalog ?? declared.catalog,
  );
  const scope = yield* Effect.try({
    try: () => resolveCodeGraphIndexScope(project, catalog),
    catch: error =>
      CodeGraphInventoryError.of(error instanceof Error ? error.message : 'Unable to resolve graph scope.'),
  });
  return {catalog, scope};
});
