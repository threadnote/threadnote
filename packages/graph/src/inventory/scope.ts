import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path} from 'effect';
import type {ProjectManifest} from '@threadnote/workspace/config';
import type {
  CodeGraphCommittedScopeBasisCapture,
  CodeGraphInventory,
  CodeGraphInventoryOptions,
  CodeGraphRawDirtyOverlayPaths,
} from './models.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphExtractorSetIdentityFromIdentities} from '../graph_identity.js';
import {worktreeStatusWithPrivateCache} from '../git/status_cache.js';
import {codeGraphScopeAdmitsPath, type CodeGraphScopeApplicabilityEvidence} from '../scope/applicability.js';
import type {RepositoryIdentity} from '../types.js';
import {
  codeGraphProjectScopeIdentity,
  createLanguagePackLruCache,
  resolveCodeGraphIndexScope,
  resolveCodeGraphWorkspaceCatalog,
  type CodeGraphWorkspaceCatalog,
  type ResolvedCodeGraphIndexScope,
} from '../index_scope.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY, type CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import {compareCodeUnits} from '../ordering.js';
import {
  readThreadnoteIgnoreSources,
  compileThreadnoteIgnore,
  isIgnoredByThreadnote,
  isOverlayAdmissionControlPath,
} from '../threadnote_ignore.js';
import {CodeGraphInventoryError} from './error.js';
import type {PolicyExclusionEntry} from './preview.js';
import {codeGraphInventoryReuseContract, readCodeGraphInventoryReuseEnvironment} from './reuse.js';
import {runCommandEffect} from '@threadnote/platform/command';
import {
  EMPTY_RAW_DIRTY_OVERLAY_PATHS,
  isZeroObjectId,
  observeRawDirtyOverlayPaths,
  parseGitTree,
  policyExclusionsForEntries,
  discoverDeclaredSourceRoots,
  ignoredPaths,
  inventoryRepository,
  readDirtyOverlay,
  type GitTreeEntry,
} from '../inventory.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export function codeGraphInventoryScopeMetadata(
  observation: {readonly catalog: CodeGraphWorkspaceCatalog; readonly scope: ResolvedCodeGraphIndexScope} | undefined,
  options: CodeGraphInventoryOptions,
  accepted: readonly GitTreeEntry[],
  excluded: readonly GitTreeEntry[],
  overlay: string | undefined,
): Partial<CodeGraphInventory> {
  if (observation === undefined) return {};
  const committed = EffectArray.map(accepted, entry => [entry.path, entry.mode, entry.blobId]);
  return {
    scope: observation.scope,
    scopeProject: options.project,
    scopeIncludeOpaqueCorpusAssets: options.includeOpaqueCorpusAssets !== false,
    scopeIncludeOverlay: options.includeOverlay,
    scopeCatalogFingerprint: observation.catalog.fingerprint,
    ...(options.statusScopeObservationOnly
      ? {}
      : {
          scopeExclusions: {
            files: excluded.length,
            bytes: EffectArray.reduce(excluded, 0, (total, entry) => total + entry.size),
          },
        }),
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
    readonly overlayObservation?: CodeGraphRawDirtyOverlayPaths;
    readonly committed?: {
      readonly entries: readonly GitTreeEntry[];
      readonly policyExcluded?: ReadonlyMap<string, PolicyExclusionEntry>;
      readonly treeEntries?: ReadonlyMap<string, GitTreeEntry>;
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
  const policyExcluded = options.committed?.policyExcluded ?? policyExclusionsForEntries(entries);
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
    const rawOverlay = options.overlayObservation ?? (yield* observeRawDirtyOverlayPaths(identity));
    const hasResolutionOverlay = EffectArray.some([...rawOverlay.changedPaths, ...rawOverlay.deletedPaths], relative =>
      languagePacks.isResolutionContext(relative),
    );
    if (hasResolutionOverlay) {
      const committedTreeEntries =
        options.committed?.treeEntries !== undefined && options.committed.treeEntries.size > 0
          ? options.committed.treeEntries
          : new Map(EffectArray.map(entries, entry => [entry.path, entry]));
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
        committedTreeEntries,
        undefined,
        true,
        undefined,
        undefined,
        rawOverlay,
        relative => languagePacks.isResolutionContext(relative),
      );
      for (const relative of overlay.changed) files.delete(relative);
      for (const file of overlay.files) files.set(file.path, file);
    }
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

interface CommittedScopedBasis {
  readonly acceptedPaths: ReadonlySet<string>;
  readonly admissionProjectRoots: readonly string[];
  readonly admissionSourceRoots: readonly string[];
  readonly catalogFingerprint: string;
  readonly committedDigestRows: readonly (readonly [string, string, string])[];
  readonly committedExtractorSet: string;
  readonly committedFiles: readonly {readonly contentHash: string; readonly path: string}[];
  readonly committedInventoryFingerprint: string;
  readonly scope: ResolvedCodeGraphIndexScope;
  readonly scopedCommittedPolicyExclusions: ReadonlyMap<string, PolicyExclusionEntry>;
  readonly scopedCommittedTreeEntries: ReadonlyMap<string, GitTreeEntry>;
}

const COMMITTED_SCOPED_BASIS_CACHE_MAXIMUM = 8;
const COMMITTED_SCOPED_BASIS_ENTRIES_MAXIMUM = 25_000;
const COMMITTED_SCOPED_BASIS_CACHE_BYTES = 16 * 1_048_576;
const committedScopedBasisCache = createLanguagePackLruCache<CommittedScopedBasis>({
  maxBytes: COMMITTED_SCOPED_BASIS_CACHE_BYTES,
  maxEntries: COMMITTED_SCOPED_BASIS_CACHE_MAXIMUM,
});

function computeScopeExtractorSet(
  files: readonly {readonly path: string}[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): string {
  const paths = EffectArray.map(files, file => file.path);
  return codeGraphExtractorSetIdentityFromIdentities(
    languagePacks.activeCacheIdentities(paths),
    languagePacks.activeDerivationIdentities(paths),
  );
}

function committedScopedBasisCacheKey(
  identity: RepositoryIdentity,
  project: Pick<ProjectManifest, 'graph' | 'uri'>,
  environmentFingerprint: string,
  includeOpaqueCorpusAssets: boolean,
  languagePacks: CodeGraphLanguagePackRegistryShape,
): string | undefined {
  if (isZeroObjectId(identity.headCommit)) return undefined;
  const {definitionDigest, scopeKey} = codeGraphProjectScopeIdentity(project);
  return JSON.stringify([
    identity.repoRoot,
    identity.gitCommonDirectory,
    identity.objectFormat,
    identity.headCommit,
    scopeKey,
    definitionDigest,
    environmentFingerprint,
    includeOpaqueCorpusAssets,
    codeGraphInventoryReuseContract(languagePacks, includeOpaqueCorpusAssets),
    EffectArray.map(
      languagePacks.packs,
      pack =>
        `${pack.id}:${pack.version}:${pack.extractor.version}:${pack.resolutionStrategy.domain}:${pack.resolutionStrategy.version}`,
    ),
  ]);
}

function readCachedCommittedScopedBasis(
  languagePacks: CodeGraphLanguagePackRegistryShape,
  key: string | undefined,
): Effect.Effect<CommittedScopedBasis | undefined> {
  return committedScopedBasisCache.get(languagePacks, key);
}

function writeCachedCommittedScopedBasis(
  languagePacks: CodeGraphLanguagePackRegistryShape,
  key: string | undefined,
  basis: CommittedScopedBasis,
): Effect.Effect<CommittedScopedBasis> {
  if (key === undefined || basis.scopedCommittedTreeEntries.size > COMMITTED_SCOPED_BASIS_ENTRIES_MAXIMUM) {
    return Effect.succeed(basis);
  }
  let bytes = JSON.stringify(basis.scope).length * 2 + key.length * 2 + 256;
  for (const [relative, entry] of basis.scopedCommittedTreeEntries) {
    bytes += (relative.length * 2 + entry.blobId.length + entry.mode.length) * 2 + 48;
    if (bytes > COMMITTED_SCOPED_BASIS_CACHE_BYTES) return Effect.succeed(basis);
  }
  for (const file of basis.committedFiles) {
    bytes += (file.path.length + file.contentHash.length) * 2 + 32;
    if (bytes > COMMITTED_SCOPED_BASIS_CACHE_BYTES) return Effect.succeed(basis);
  }
  for (const root of [...basis.admissionProjectRoots, ...basis.admissionSourceRoots]) {
    bytes += root.length * 2;
    if (bytes > COMMITTED_SCOPED_BASIS_CACHE_BYTES) return Effect.succeed(basis);
  }
  return committedScopedBasisCache.set(languagePacks, key, basis, bytes);
}

/**
 * Observe scoped applicability for status/query freshness without repeating
 * repo-wide tree or manifest hydration on warm commits.
 */
export const observeCodeGraphStatusScope = Effect.fn('codeGraph.observeStatusScope')(function* (
  identity: RepositoryIdentity,
  project: Pick<ProjectManifest, 'graph' | 'uri'>,
  options: {
    readonly includeOpaqueCorpusAssets?: boolean;
    readonly languagePacks?: CodeGraphLanguagePackRegistryShape;
    readonly preobservedWorktreeChanged?:
      boolean | Effect.Effect<boolean | undefined, unknown, FileSystem.FileSystem | Path.Path>;
    readonly threadnoteHome?: string;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const languagePacks = options.languagePacks ?? BUILTIN_LANGUAGE_PACK_REGISTRY;
  const includeOpaqueCorpusAssets = options.includeOpaqueCorpusAssets !== false;
  const reuseEnvironment = yield* readCodeGraphInventoryReuseEnvironment(identity, fs, path);
  const preobserved = Effect.isEffect(options.preobservedWorktreeChanged)
    ? yield* options.preobservedWorktreeChanged
    : options.preobservedWorktreeChanged;
  const worktreeClean =
    preobserved === false
      ? true
      : preobserved === true || isZeroObjectId(identity.headCommit)
        ? false
        : (yield* worktreeStatusWithPrivateCache(identity, options.threadnoteHome, [
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=normal',
          ])).stdout.length === 0;
  const rawOverlayPaths = worktreeClean ? EMPTY_RAW_DIRTY_OVERLAY_PATHS : yield* observeRawDirtyOverlayPaths(identity);
  const hasScopeOrIgnoreControlChange =
    !worktreeClean &&
    EffectArray.some(
      [...rawOverlayPaths.changedPaths, ...rawOverlayPaths.deletedPaths],
      relative =>
        languagePacks.isResolutionContext(relative) ||
        isOverlayAdmissionControlPath(relative) ||
        relative === '.gitignore' ||
        Effect2.pipe(relative, EffectString.endsWith('/.gitignore')),
    );
  if (hasScopeOrIgnoreControlChange) {
    const inventory = yield* inventoryRepository(identity, {
      project,
      languagePacks,
      includeOpaqueCorpusAssets,
      scopeObservationOnly: true,
      statusScopeObservationOnly: true,
      overlayObservation: rawOverlayPaths,
    });
    return {
      scope: inventory.scope,
      evidence: codeGraphInventoryScopeEvidence(
        inventory,
        identity,
        computeScopeExtractorSet(inventory.files, languagePacks),
        reuseEnvironment.fingerprint,
      ),
    };
  }
  const basisKey = committedScopedBasisCacheKey(
    identity,
    project,
    reuseEnvironment.fingerprint,
    includeOpaqueCorpusAssets,
    languagePacks,
  );
  let basis = yield* readCachedCommittedScopedBasis(languagePacks, basisKey);
  if (basis === undefined) {
    let captured: CodeGraphCommittedScopeBasisCapture | undefined;
    const committedInventory = yield* inventoryRepository(identity, {
      includeOpaqueCorpusAssets,
      includeOverlay: false,
      languagePacks,
      onCommittedScopeBasis: value => {
        captured = value;
      },
      project,
      scopeObservationOnly: true,
      statusScopeObservationOnly: true,
    });
    const scope = captured!.scopeObservation.scope;
    const scopedTreeEntries = EffectArray.filter(captured!.allTreeEntries, entry =>
      codeGraphScopeAdmitsPath(scope, entry.path),
    );
    const scopedCommittedTreeEntries = new Map(EffectArray.map(scopedTreeEntries, entry => [entry.path, entry]));
    const scopedCommittedPolicyExclusions = new Map(
      EffectArray.flatMap(scopedTreeEntries, entry => {
        const exclusion = captured!.committedPolicyExclusions.get(entry.path);
        return exclusion === undefined ? [] : [[entry.path, exclusion] as const];
      }),
    );
    const committedFiles = EffectArray.map(committedInventory.committedFiles, file => ({
      contentHash: file.contentHash,
      path: file.path,
    }));
    const committedDigestRows = EffectArray.map(
      captured!.accepted,
      entry => [entry.path, entry.mode, entry.blobId] as const,
    );
    basis = yield* writeCachedCommittedScopedBasis(languagePacks, basisKey, {
      acceptedPaths: captured!.acceptedPaths,
      admissionProjectRoots: captured!.admissionProjectRoots,
      admissionSourceRoots: captured!.admissionSourceRoots,
      catalogFingerprint: captured!.scopeObservation.catalog.fingerprint,
      committedDigestRows,
      committedExtractorSet: computeScopeExtractorSet(committedFiles, languagePacks),
      committedFiles,
      committedInventoryFingerprint: committedInventory.scopeCommittedInventoryFingerprint!,
      scope,
      scopedCommittedPolicyExclusions,
      scopedCommittedTreeEntries,
    });
  }

  const hasInScopeOverlayCandidate =
    !worktreeClean &&
    EffectArray.some([...rawOverlayPaths.changedPaths, ...rawOverlayPaths.deletedPaths], relative =>
      codeGraphScopeAdmitsPath(basis.scope, relative),
    );
  if (!hasInScopeOverlayCandidate) {
    return {
      scope: basis.scope,
      evidence: {
        repositoryId: identity.repositoryId,
        worktreeId: identity.worktreeId,
        scopeKey: basis.scope.scopeKey,
        definitionDigest: basis.scope.definitionDigest,
        closureDigest: basis.scope.closureDigest,
        inventoryFingerprint: basis.committedInventoryFingerprint,
        overlayFingerprint: undefined,
        extractorSet: basis.committedExtractorSet,
        policyFingerprint: reuseEnvironment.fingerprint,
        observedCommit: identity.headCommit,
        catalogFingerprint: basis.catalogFingerprint,
      } satisfies CodeGraphScopeApplicabilityEvidence,
    };
  }

  const ignoreRules = compileThreadnoteIgnore(
    reuseEnvironment.threadnoteIgnore,
    reuseEnvironment.threadnoteIgnoreLocal,
  );
  const overlay = yield* readDirtyOverlay(
    identity,
    path,
    {
      committed: reuseEnvironment.threadnoteIgnore,
      local: reuseEnvironment.threadnoteIgnoreLocal,
    },
    ignoreRules,
    new Set(),
    languagePacks,
    basis.admissionProjectRoots,
    basis.admissionSourceRoots,
    basis.scopedCommittedPolicyExclusions,
    basis.scopedCommittedTreeEntries,
    basis.acceptedPaths,
    includeOpaqueCorpusAssets,
    undefined,
    undefined,
    rawOverlayPaths,
    relative => codeGraphScopeAdmitsPath(basis.scope, relative),
  );
  const filesByPath = new Map(EffectArray.map(basis.committedFiles, file => [file.path, file]));
  for (const changed of overlay.changed) filesByPath.delete(changed);
  for (const file of overlay.files) {
    filesByPath.set(file.path, {contentHash: file.contentHash, path: file.path});
  }
  const files = [...filesByPath.values()].sort((left, right) => compareCodeUnits(left.path, right.path));
  const inventoryFingerprint =
    overlay.fingerprint === undefined
      ? basis.committedInventoryFingerprint
      : sha256HexSync(JSON.stringify({committed: basis.committedDigestRows, overlay: overlay.fingerprint}));
  return {
    scope: basis.scope,
    evidence: {
      repositoryId: identity.repositoryId,
      worktreeId: identity.worktreeId,
      scopeKey: basis.scope.scopeKey,
      definitionDigest: basis.scope.definitionDigest,
      closureDigest: basis.scope.closureDigest,
      inventoryFingerprint,
      overlayFingerprint: overlay.fingerprint,
      extractorSet:
        overlay.changed.size === 0 && overlay.files.length === 0
          ? basis.committedExtractorSet
          : computeScopeExtractorSet(files, languagePacks),
      policyFingerprint: reuseEnvironment.fingerprint,
      observedCommit: identity.headCommit,
      catalogFingerprint: basis.catalogFingerprint,
    } satisfies CodeGraphScopeApplicabilityEvidence,
  };
});
