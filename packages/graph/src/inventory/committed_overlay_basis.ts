import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION, codeGraphInventoryExclusionReason} from './policy.js';
import {parseNameStatus} from './porcelain.js';
import type {CodeGraphRawDirtyOverlayPaths} from './models.js';
import {createLanguagePackLruCache, type CodeGraphWorkspaceCatalog} from '../index_scope.js';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import type {CodeGraphWorkspace} from '../languages/types.js';
import type {CodeGraphInventoryFile, RepositoryIdentity} from '../types.js';
import {normalizeRepositoryPath, type GitTreeEntry, type PolicyExclusionEntry} from './preview.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export function isZeroObjectId(value: string): boolean {
  return /^0{40}(?:0{24})?$/.test(value);
}

export const EMPTY_RAW_DIRTY_OVERLAY_PATHS: CodeGraphRawDirtyOverlayPaths = {
  addedPaths: [],
  changedPaths: [],
  deletedPaths: [],
  untrackedPaths: [],
};

export const observeRawDirtyOverlayPaths = Effect.fn('codeGraph.observeRawDirtyOverlayPaths')(function* (
  identity: RepositoryIdentity,
) {
  const unborn = isZeroObjectId(identity.headCommit);
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
  const changes = parseNameStatus(diffOutput);
  const untracked = new Set(
    EffectArray.map(
      EffectArray.filter(Effect2.pipe(untrackedOutput, EffectString.split('\0')), Boolean),
      normalizeRepositoryPath,
    ),
  );
  for (const value of untracked) changes.changed.add(value);
  return {
    addedPaths: [...changes.added],
    changedPaths: [...changes.changed],
    deletedPaths: [...changes.deleted],
    untrackedPaths: [...untracked],
  } satisfies CodeGraphRawDirtyOverlayPaths;
});

export interface CommittedOverlayBasis {
  readonly committedTreeEntries: ReadonlyMap<string, GitTreeEntry>;
  readonly committedPolicyExclusions: ReadonlyMap<string, PolicyExclusionEntry>;
  readonly projectRoots: readonly string[];
  readonly sourceRoots: readonly string[];
}

export interface DeclaredSourceRootsDiscovery {
  readonly catalog: CodeGraphWorkspaceCatalog;
  readonly files: ReadonlyMap<string, CodeGraphInventoryFile>;
  readonly projectRoots: readonly string[];
  readonly sourceRoots: readonly string[];
  readonly workspace: CodeGraphWorkspace;
}

const MAX_ENTRIES = 20_000;
const MAX_STRING_BYTES = 4 * 1_048_576;
let cached: {readonly key: string; readonly basis: CommittedOverlayBasis} | undefined;

const DECLARED_SOURCE_ROOTS_CACHE_MAXIMUM = 4;
const DECLARED_SOURCE_ROOTS_CACHE_BYTES = 16 * 1_048_576;
const declaredSourceRootsCache = createLanguagePackLruCache<DeclaredSourceRootsDiscovery>({
  maxBytes: DECLARED_SOURCE_ROOTS_CACHE_BYTES,
  maxEntries: DECLARED_SOURCE_ROOTS_CACHE_MAXIMUM,
});

export function declaredSourceRootsCacheKey(
  identity: RepositoryIdentity,
  contexts: readonly GitTreeEntry[],
): string | undefined {
  if (isZeroObjectId(identity.headCommit)) return undefined;
  const contextsDigest = sha256HexSync(
    EffectArray.join(
      EffectArray.map(contexts, entry => `${entry.path}\0${entry.mode}\0${entry.blobId}\0${entry.size}`),
      '\n',
    ),
  );
  return JSON.stringify([
    identity.repoRoot,
    identity.gitCommonDirectory,
    identity.objectFormat,
    identity.headCommit,
    CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
    contextsDigest,
  ]);
}

export function readCachedDeclaredSourceRoots(
  languagePacks: CodeGraphLanguagePackRegistryShape,
  key: string | undefined,
): Effect.Effect<DeclaredSourceRootsDiscovery | undefined> {
  return declaredSourceRootsCache.get(languagePacks, key);
}

export function writeCachedDeclaredSourceRoots(
  languagePacks: CodeGraphLanguagePackRegistryShape,
  key: string | undefined,
  value: DeclaredSourceRootsDiscovery,
): Effect.Effect<DeclaredSourceRootsDiscovery> {
  if (key === undefined) return Effect.succeed(value);
  let bytes = JSON.stringify(value.catalog).length * 2 + key.length * 2;
  for (const [relative, file] of value.files) {
    Object.freeze(file);
    bytes += (relative.length + file.blobId.length + file.contentHash.length + (file.content?.length ?? 0)) * 2 + 64;
    if (bytes > DECLARED_SOURCE_ROOTS_CACHE_BYTES) return Effect.succeed(value);
  }
  for (const root of [...value.projectRoots, ...value.sourceRoots]) {
    bytes += root.length * 2;
    if (bytes > DECLARED_SOURCE_ROOTS_CACHE_BYTES) return Effect.succeed(value);
  }
  const frozen: DeclaredSourceRootsDiscovery = Object.freeze({
    catalog: value.catalog,
    files: value.files,
    projectRoots: Object.freeze([...value.projectRoots]),
    sourceRoots: Object.freeze([...value.sourceRoots]),
    workspace: value.workspace,
  });
  return declaredSourceRootsCache.set(languagePacks, key, frozen, bytes);
}

export function committedOverlayBasis<E, R>(
  identity: RepositoryIdentity,
  discoverRoots: (
    entries: readonly GitTreeEntry[],
  ) => Effect.Effect<{readonly projectRoots: readonly string[]; readonly sourceRoots: readonly string[]}, E, R>,
) {
  return Effect.gen(function* () {
    const key = JSON.stringify([
      identity.repoRoot,
      identity.gitCommonDirectory,
      identity.objectFormat,
      identity.headCommit,
      CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
    ]);
    if (cached?.key === key) return cached.basis;
    const allTreeEntries = isZeroObjectId(identity.headCommit)
      ? []
      : parseGitTree(
          (yield* runCommandEffect('git', ['-C', identity.repoRoot, 'ls-tree', '-r', '-l', '-z', identity.headCommit], {
            maxOutputBytes: 0,
            timeoutMs: 0,
          })).stdout,
        );
    const committedPolicyExclusions = policyExclusionsForEntries(allTreeEntries);
    const roots = yield* discoverRoots(
      EffectArray.filter(allTreeEntries, entry => !committedPolicyExclusions.has(entry.path)),
    );
    const basis = {
      committedTreeEntries: new Map(EffectArray.map(allTreeEntries, entry => [entry.path, entry])),
      committedPolicyExclusions,
      projectRoots: roots.projectRoots,
      sourceRoots: roots.sourceRoots,
    } satisfies CommittedOverlayBasis;
    // Retain only one immutable HEAD basis; each caller still observes its dirty overlay.
    cached = retainable(key, allTreeEntries, roots) ? {key, basis} : undefined;
    return basis;
  });
}

function retainable(
  key: string,
  entries: readonly GitTreeEntry[],
  roots: Pick<CommittedOverlayBasis, 'projectRoots' | 'sourceRoots'>,
): boolean {
  if (entries.length > MAX_ENTRIES) return false;
  let upperBound = 3 * key.length;
  for (const entry of entries) {
    upperBound += 3 * entry.path.length + entry.blobId.length + entry.mode.length;
    if (upperBound > MAX_STRING_BYTES) return false;
  }
  for (const root of [...roots.projectRoots, ...roots.sourceRoots]) {
    upperBound += 3 * root.length;
    if (upperBound > MAX_STRING_BYTES) return false;
  }
  return true;
}

export function parseGitTree(output: string): readonly GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  for (const record of Effect2.pipe(output, EffectString.split('\0'))) {
    if (!record) continue;
    const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]+) +(-|\d+)\t([\s\S]+)$/.exec(record);
    if (!match || match[2] !== 'blob' || match[1] === '120000' || match[4] === '-') continue;
    const size = Number(match[4]);
    if (!Number.isSafeInteger(size) || size < 0) continue;
    entries.push({
      blobId: match[3],
      mode: match[1],
      path: Effect2.pipe(match[5], EffectString.replace(/^\.\/+/, '')),
      size,
    });
  }
  return entries;
}

export function policyExclusionsForEntries(entries: readonly GitTreeEntry[]): Map<string, PolicyExclusionEntry> {
  const exclusions = new Map<string, PolicyExclusionEntry>();
  for (const entry of entries) {
    const reason = codeGraphInventoryExclusionReason(entry.path, entry.size);
    if (reason !== undefined) exclusions.set(entry.path, {reason, size: entry.size});
  }
  return exclusions;
}
