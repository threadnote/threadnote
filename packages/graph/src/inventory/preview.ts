import {Array as EffectArray, Option} from 'effect';
import type {ProjectManifest} from '@threadnote/workspace/config';
import {compareCodeUnits} from '../ordering.js';
import {BUILTIN_LANGUAGE_PACK_REGISTRY, type CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import {isOpaqueCorpusMediaPath} from '../languages/corpus/policy.js';
import type {CodeGraphFileRole} from '../languages/types.js';
import {
  codeGraphInventoryExclusionReason,
  CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
  type CodeGraphInventoryExclusionReason,
} from './policy.js';
import {compileThreadnoteIgnore, isIgnoredByThreadnote, type CompiledIgnoreRule} from '../threadnote_ignore.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface GitTreeEntry {
  readonly blobId: string;
  readonly mode: string;
  readonly path: string;
  readonly size: number;
}

export const CODE_GRAPH_INVENTORY_PREVIEW_VERSION = 1 as const;

export type CodeGraphInventoryPreviewDisposition = 'eligible' | 'skipped';
export type CodeGraphInventoryPreviewReason =
  | CodeGraphInventoryExclusionReason
  | 'admitted'
  | 'generated-directory'
  | 'git-ignore'
  | 'hidden-directory'
  | 'invalid-path'
  | 'opaque-corpus-deferred'
  | 'threadnote-ignore'
  | 'unsupported-language'
  | 'vendor-directory';

export interface CodeGraphInventoryPreviewEntry {
  readonly path: string;
  readonly size: number;
}

export interface CodeGraphInventoryPreviewGroup {
  /** Stable language-pack identifier, or `unmatched` when no pack accepts the path. */
  readonly classifier: string;
  readonly disposition: CodeGraphInventoryPreviewDisposition;
  readonly bytes: number;
  readonly files: number;
  readonly language: string;
  readonly reason: CodeGraphInventoryPreviewReason;
  readonly role: CodeGraphFileRole | 'unmatched';
}

export interface CodeGraphInventoryPreviewCount {
  readonly bytes: number;
  readonly files: number;
}

export interface CodeGraphInventoryPreview {
  readonly commit: string;
  readonly dirty: boolean;
  readonly groups: readonly CodeGraphInventoryPreviewGroup[];
  /** Changed paths that were not stable contained regular files and are absent from aggregate byte totals. */
  readonly omittedUnsafeWorktreeFiles: number;
  readonly policyVersion: typeof CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION;
  readonly repositoryId: string;
  readonly scope: 'head-and-worktree';
  readonly totals: {
    readonly eligible: CodeGraphInventoryPreviewCount;
    readonly repository: CodeGraphInventoryPreviewCount;
    readonly skipped: CodeGraphInventoryPreviewCount;
  };
  readonly type: 'code-graph-inventory-preview';
  readonly version: typeof CODE_GRAPH_INVENTORY_PREVIEW_VERSION;
  readonly worktreeId: string;
}

export interface CodeGraphInventoryPreviewSummaryOptions {
  readonly declaredProjectRoots?: readonly string[];
  readonly declaredSourceRoots?: readonly string[];
  readonly gitIgnoredPaths?: ReadonlySet<string>;
  readonly includeOpaqueCorpusAssets?: boolean;
  readonly languagePacks?: CodeGraphLanguagePackRegistryShape;
  readonly threadnoteIgnore?: string;
  readonly threadnoteIgnoreLocal?: string;
}

export interface CodeGraphInventoryPreviewOptions {
  readonly includeOverlay?: boolean;
  readonly includeOpaqueCorpusAssets?: boolean;
  readonly languagePacks?: CodeGraphLanguagePackRegistryShape;
  /** Configured scope to preview; absent retains complete-repository inventory behavior. */
  readonly project?: Pick<ProjectManifest, 'graph' | 'uri'>;
}

export interface PolicyExclusionEntry {
  readonly reason: CodeGraphInventoryExclusionReason;
  readonly size: number;
}

const PRUNED_DIRECTORIES = new Set([
  'bazel-bin',
  'bazel-out',
  'bazel-testlogs',
  'build',
  'coverage',
  'deriveddata',
  'dist',
  'graphify-out',
  'node_modules',
  'out',
  'pods',
]);
const GENERATED_DIRECTORIES = new Set([
  'bazel-bin',
  'bazel-out',
  'bazel-testlogs',
  'build',
  'coverage',
  'deriveddata',
  'dist',
  'graphify-out',
  'node_modules',
  'out',
]);
const AUTHORED_DOT_DIRECTORIES = new Set(['.aspect']);
// Keep the byte ceiling as the memory guard. A 128-entry cap fragments the
// heavy-tail fixture into three `git cat-file` children even though its
// content fits comfortably below that ceiling; on current Bun this startup
// cost dominates the measured read phase.
/**
 * Aggregate path/size metadata through the same admission rules used by the
 * inventory reader. The result is deliberately path-free and content-free.
 */
export function summarizeCodeGraphInventoryPreview(
  entries: readonly CodeGraphInventoryPreviewEntry[],
  options: CodeGraphInventoryPreviewSummaryOptions = {},
): Pick<CodeGraphInventoryPreview, 'groups' | 'policyVersion' | 'totals'> {
  const languagePacks = options.languagePacks ?? BUILTIN_LANGUAGE_PACK_REGISTRY;
  const ignoreRules = compileThreadnoteIgnore(options.threadnoteIgnore ?? '', options.threadnoteIgnoreLocal ?? '');
  const gitIgnoredPaths = options.gitIgnoredPaths ?? new Set<string>();
  const groups = new Map<string, CodeGraphInventoryPreviewGroup>();
  let eligibleBytes = 0;
  let eligibleFiles = 0;
  let repositoryBytes = 0;

  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) continue;
    const path = normalizeRepositoryPath(entry.path);
    const matched = languagePacks.match(path);
    const dimensions = Option.match(matched, {
      onNone: () => ({
        classifier: 'unmatched',
        language: 'unmatched',
        role: 'unmatched' as const,
      }),
      onSome: value => ({
        classifier: value.pack.id,
        language: value.language,
        role: value.role,
      }),
    });
    const policyReason = codeGraphInventoryExclusionReason(path, entry.size);
    const pathReason =
      policyReason === undefined
        ? repositoryPathExclusionReason(
            path,
            ignoreRules,
            languagePacks,
            options.declaredProjectRoots ?? [],
            options.declaredSourceRoots ?? [],
            options.includeOpaqueCorpusAssets !== false,
          )
        : undefined;
    const reason = policyReason ?? pathReason ?? (gitIgnoredPaths.has(path) ? 'git-ignore' : 'admitted');
    const disposition: CodeGraphInventoryPreviewDisposition = reason === 'admitted' ? 'eligible' : 'skipped';
    const key = EffectArray.join(
      [disposition, dimensions.language, dimensions.role, dimensions.classifier, reason],
      '\0',
    );
    const current = groups.get(key);
    groups.set(key, {
      ...dimensions,
      bytes: (current?.bytes ?? 0) + entry.size,
      disposition,
      files: (current?.files ?? 0) + 1,
      reason,
    });
    repositoryBytes += entry.size;
    if (disposition === 'eligible') {
      eligibleBytes += entry.size;
      eligibleFiles += 1;
    }
  }

  const repositoryFiles = EffectArray.reduce([...groups.values()], 0, (total, group) => total + group.files);
  const sortedGroups = [...groups.values()].sort((left, right) => {
    const leftKey = [
      left.disposition === 'eligible' ? '0' : '1',
      left.language,
      left.role,
      left.classifier,
      left.reason,
    ];
    const rightKey = [
      right.disposition === 'eligible' ? '0' : '1',
      right.language,
      right.role,
      right.classifier,
      right.reason,
    ];
    return compareCodeUnits(EffectArray.join(leftKey, '\0'), EffectArray.join(rightKey, '\0'));
  });
  return {
    groups: sortedGroups,
    policyVersion: CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
    totals: {
      eligible: {bytes: eligibleBytes, files: eligibleFiles},
      repository: {bytes: repositoryBytes, files: repositoryFiles},
      skipped: {
        bytes: repositoryBytes - eligibleBytes,
        files: repositoryFiles - eligibleFiles,
      },
    },
  };
}

export function isPotentialOverlayCandidate(value: string, languagePacks: CodeGraphLanguagePackRegistryShape): boolean {
  const repositoryPath = normalizeRepositoryPath(value);
  if (
    !repositoryPath ||
    Effect2.pipe(repositoryPath, EffectString.startsWith('/')) ||
    EffectArray.some(
      Effect2.pipe(repositoryPath, EffectString.split('/')),
      segment => segment === '..' || segment === '',
    )
  ) {
    return false;
  }
  const directories = Effect2.pipe(repositoryPath, EffectString.split('/')).slice(0, -1);
  if (
    EffectArray.some(directories, directory => {
      const normalized = Effect2.pipe(directory, EffectString.toLowerCase);
      return (
        (Effect2.pipe(directory, EffectString.startsWith('.')) && !AUTHORED_DOT_DIRECTORIES.has(normalized)) ||
        normalized === 'node_modules'
      );
    })
  ) {
    return false;
  }
  return isInventoryPolicyExtension(repositoryPath) || Option.isSome(languagePacks.match(repositoryPath));
}

export function isInventoryPolicyExtension(repositoryPath: string): boolean {
  return /\.(?:jsonc?|svg)$/i.test(repositoryPath);
}

export function repositoryPathExclusionReason(
  value: string,
  ignoreRules: readonly CompiledIgnoreRule[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
  declaredProjectRoots: readonly string[] = [],
  declaredSourceRoots: readonly string[] = [],
  includeOpaqueCorpusAssets = true,
): Exclude<CodeGraphInventoryPreviewReason, CodeGraphInventoryExclusionReason | 'admitted' | 'git-ignore'> | undefined {
  const path = normalizeRepositoryPath(value);
  if (
    !path ||
    Effect2.pipe(path, EffectString.startsWith('/')) ||
    EffectArray.some(Effect2.pipe(path, EffectString.split('/')), segment => segment === '..' || segment === '')
  ) {
    return 'invalid-path';
  }
  const directories = Effect2.pipe(path, EffectString.split('/')).slice(0, -1);
  const declaredRoots = [...declaredProjectRoots, ...declaredSourceRoots];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index];
    const normalizedDirectory = Effect2.pipe(directory, EffectString.toLowerCase);
    if (Effect2.pipe(directory, EffectString.startsWith('.')) && !AUTHORED_DOT_DIRECTORIES.has(normalizedDirectory)) {
      return 'hidden-directory';
    }
    const bazelOutputLink = Effect2.pipe(normalizedDirectory, EffectString.startsWith('bazel-'));
    if (!bazelOutputLink && !PRUNED_DIRECTORIES.has(normalizedDirectory)) continue;
    const prefix = EffectArray.join(directories.slice(0, index + 1), '/');
    // A generated-looking directory is authored source only when a manifest
    // declares that directory itself (or one of its descendants) as a
    // project/source root. A broad source root must not re-include nested
    // output such as packages/app/dist or packages/app/build.
    if (
      EffectArray.some(
        declaredRoots,
        root => root === prefix || Effect2.pipe(root, EffectString.startsWith(`${prefix}/`)),
      )
    )
      continue;
    if (!bazelOutputLink && !GENERATED_DIRECTORIES.has(normalizedDirectory)) {
      if (EffectArray.some(declaredSourceRoots, root => Effect2.pipe(prefix, EffectString.startsWith(`${root}/`))))
        continue;
      return 'vendor-directory';
    }
    return normalizedDirectory === 'node_modules' ? 'vendor-directory' : 'generated-directory';
  }
  if (isIgnoredByThreadnote(path, ignoreRules)) return 'threadnote-ignore';
  if (!includeOpaqueCorpusAssets && isOpaqueCorpusMediaPath(path)) return 'opaque-corpus-deferred';
  return Option.isSome(languagePacks.match(path)) ? undefined : 'unsupported-language';
}

export function normalizeRepositoryPath(value: string): string {
  return Effect2.pipe(value, EffectString.replace(/^\.\/+/, ''));
}
