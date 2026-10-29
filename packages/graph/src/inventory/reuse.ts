import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Path, Predicate, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {readOptionalText} from './contained_file.js';
import {readThreadnoteIgnoreSources} from '../threadnote_ignore.js';
import {CodeGraphInventoryError} from './error.js';
import {CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION, CODE_GRAPH_INVENTORY_EXCLUSION_REASONS} from './policy.js';
import type {CodeGraphLanguagePackRegistryShape} from '../languages/registry.js';
import {CodeGraphWorkspaceSchema} from '../languages/types.js';
import type {CodeGraphWorkspace} from '../languages/types.js';
import {
  CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
  type CodeGraphInventoryPolicyExclusionSummary,
  type CodeGraphInventoryReuseReceipt,
} from '../store/models.js';
import {mergeCodeGraphWorkspaces} from '../workspace.js';
import type {CodeGraphInventoryFile, RepositoryIdentity} from '../types.js';
import {codeGraphUtf8ByteLength} from '../disk/capacity.js';
import {compareCodeUnits} from '../ordering.js';
import type {CodeGraphAttributionContextFile} from '../store/models.js';
import {isRepositoryFactAttributionContextPath} from '../extractor_context.js';
import {createCachedCodeGraphContractHash} from '../cached_contract_hash.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const ATTRIBUTION_CONTEXT_FILES_MAXIMUM = 10_000;
const ATTRIBUTION_CONTEXT_BYTES_MAXIMUM = 16 * 1_048_576;
const inventoryContractHash = createCachedCodeGraphContractHash();
const opaqueInventoryContractHash = createCachedCodeGraphContractHash();

export function codeGraphAttributionContextFilesForReceipt(
  files: readonly CodeGraphInventoryFile[],
  languagePacks: CodeGraphLanguagePackRegistryShape,
): readonly CodeGraphAttributionContextFile[] | undefined {
  const context: CodeGraphAttributionContextFile[] = [];
  let contentBytes = 0;
  for (const file of files) {
    if (!languagePacks.isResolutionContext(file.path) || !isRepositoryFactAttributionContextPath(file.path)) continue;
    if (file.content === undefined || file.source !== 'commit') return undefined;
    const bytes = codeGraphUtf8ByteLength(file.content);
    if (
      context.length >= ATTRIBUTION_CONTEXT_FILES_MAXIMUM ||
      bytes > ATTRIBUTION_CONTEXT_BYTES_MAXIMUM - contentBytes
    ) {
      return undefined;
    }
    contentBytes += bytes;
    context.push({...file, content: file.content, size: bytes, source: 'commit'});
  }
  return context.sort((left, right) => compareCodeUnits(left.path, right.path));
}

/**
 * Bump when admission behavior changes without a corresponding language-pack
 * matcher or inventory policy revision. Persisted inventory reuse is denied
 * across different contract hashes.
 */
export const CODE_GRAPH_INVENTORY_REUSE_CONTRACT_VERSION = 2 as const;

export const readCodeGraphInventoryReuseEnvironment = Effect.fn('codeGraph.readInventoryReuseEnvironment')(function* (
  identity: RepositoryIdentity,
  fs: FileSystem.FileSystem,
  path: Path.Path,
) {
  const [gitInfoExcludeResult, globalExcludeResult] = yield* Effect.all(
    [
      runCommandEffect('git', ['-C', identity.repoRoot, 'rev-parse', '--git-path', 'info/exclude'], {
        allowFailure: true,
        maxOutputBytes: 16_384,
        timeoutMs: 0,
      }),
      runCommandEffect('git', ['-C', identity.repoRoot, 'config', '--path', '--get', 'core.excludesFile'], {
        allowFailure: true,
        maxOutputBytes: 16_384,
        timeoutMs: 0,
      }),
    ],
    {concurrency: 2},
  );
  if (
    gitInfoExcludeResult.exitCode !== 0 ||
    Effect2.pipe(gitInfoExcludeResult.stdout, EffectString.trim).length === 0
  ) {
    return yield* CodeGraphInventoryError.make({message: 'Git exclude policy path is unavailable.'});
  }
  if (globalExcludeResult.exitCode !== 0 && globalExcludeResult.exitCode !== 1) {
    return yield* CodeGraphInventoryError.make({message: 'Global Git exclude policy is unavailable.'});
  }
  const ignoreSources = yield* readThreadnoteIgnoreSources(fs, path, identity.repoRoot);
  const threadnoteIgnore = ignoreSources.committed;
  const threadnoteIgnoreLocal = ignoreSources.local;
  const observedGitInfoExcludePath = Effect2.pipe(gitInfoExcludeResult.stdout, EffectString.trim);
  const gitInfoExcludePath = path.isAbsolute(observedGitInfoExcludePath)
    ? observedGitInfoExcludePath
    : path.resolve(identity.repoRoot, observedGitInfoExcludePath);
  const system = yield* SystemInfo;
  const environment = system.environment();
  const defaultGlobalExcludePath = path.join(
    environment.XDG_CONFIG_HOME || path.join(environment.HOME || system.homeDirectory, '.config'),
    'git',
    'ignore',
  );
  // An explicitly empty config disables global excludes; only an absent key uses Git's default.
  const globalExcludePath =
    globalExcludeResult.exitCode === 1
      ? defaultGlobalExcludePath
      : Effect2.pipe(globalExcludeResult.stdout, EffectString.trim);
  const [gitInfoExclude, globalExclude] = yield* Effect.all(
    [
      readOptionalText(fs, gitInfoExcludePath),
      globalExcludePath.length === 0
        ? Effect.succeed('')
        : readOptionalText(
            fs,
            path.isAbsolute(globalExcludePath) ? globalExcludePath : path.resolve(identity.repoRoot, globalExcludePath),
          ),
    ],
    {concurrency: 2},
  );
  return {
    fingerprint: sha256HexSync(
      EffectArray.join(
        [
          'code-graph-inventory-environment-v1',
          `threadnote:${sha256HexSync(threadnoteIgnore)}`,
          `threadnote-local:${sha256HexSync(threadnoteIgnoreLocal)}`,
          `git-info-exclude:${sha256HexSync(gitInfoExclude)}`,
          `global-exclude:${sha256HexSync(globalExclude)}`,
        ],
        '\n',
      ),
    ),
    threadnoteIgnore,
    threadnoteIgnoreLocal,
  } as const;
});

export function codeGraphInventoryReuseContract(
  languagePacks: CodeGraphLanguagePackRegistryShape,
  includeOpaqueCorpusAssets: boolean,
): string {
  const packs = EffectArray.map(languagePacks.packs, pack => ({
    files: EffectArray.map(
      pack.files,
      matcher =>
        `${matcher.kind}:${Effect2.pipe(matcher.value, EffectString.toLowerCase)}:${matcher.language}:${matcher.role}`,
    ).sort(),
    id: pack.id,
  })).sort((left, right) => Effect2.pipe(left.id, EffectString.localeCompare(right.id)));
  const hashContract = includeOpaqueCorpusAssets ? opaqueInventoryContractHash : inventoryContractHash;
  return hashContract(
    languagePacks,
    JSON.stringify({
      admissionPolicy: CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
      contractVersion: CODE_GRAPH_INVENTORY_REUSE_CONTRACT_VERSION,
      includeOpaqueCorpusAssets,
      packs,
    }),
  );
}

export function encodeCodeGraphInventoryReuseReceipt(
  receipt: CodeGraphInventoryReuseReceipt | undefined,
): string | null {
  return receipt === undefined ? null : JSON.stringify(receipt);
}

export function decodeCodeGraphInventoryReuseReceipt(value: unknown): CodeGraphInventoryReuseReceipt | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 24 * 1_048_576) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Predicate.isObject(parsed)) return undefined;
    if (parsed.version !== CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION) return undefined;
    if (!isSha256(parsed.contract) || !isSha256(parsed.environmentFingerprint)) return undefined;
    if (typeof parsed.includeOpaqueCorpusAssets !== 'boolean') return undefined;
    if (!isNonNegativeSafeInteger(parsed.skipped)) return undefined;
    if (!isBoundedStringArray(parsed.diagnostics, 100, 2_000)) return undefined;
    if (!isPolicyExclusionSummary(parsed.policyExclusions)) return undefined;
    const attributionFiles = normalizedAttributionFiles(parsed.attributionFiles);
    if (attributionFiles === undefined) return undefined;
    const workspaceInput = parsed.workspace;
    const workspace = normalizedWorkspace(workspaceInput);
    if (
      !Predicate.isObject(workspaceInput) ||
      workspace === undefined ||
      workspace.fingerprint !== workspaceInput.fingerprint
    ) {
      return undefined;
    }
    return {
      attributionFiles,
      contract: parsed.contract,
      diagnostics: parsed.diagnostics,
      environmentFingerprint: parsed.environmentFingerprint,
      includeOpaqueCorpusAssets: parsed.includeOpaqueCorpusAssets,
      policyExclusions: parsed.policyExclusions,
      skipped: parsed.skipped,
      version: CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
      workspace,
    };
  } catch {
    return undefined;
  }
}

function normalizedAttributionFiles(value: unknown): readonly CodeGraphAttributionContextFile[] | undefined {
  if (!EffectArray.isArray(value) || value.length > ATTRIBUTION_CONTEXT_FILES_MAXIMUM) return undefined;
  const files: CodeGraphAttributionContextFile[] = [];
  const paths = new Set<string>();
  let contentBytes = 0;
  for (const input of value) {
    if (
      !Predicate.isObject(input) ||
      typeof input.blobId !== 'string' ||
      input.blobId.length === 0 ||
      input.blobId.length > 4_096 ||
      !isSha256(input.contentHash) ||
      typeof input.content !== 'string' ||
      typeof input.language !== 'string' ||
      input.language.length === 0 ||
      input.language.length > 128 ||
      typeof input.mode !== 'string' ||
      !/^\d{6}$/u.test(input.mode) ||
      typeof input.path !== 'string' ||
      input.path.length === 0 ||
      input.path.length > 4_096 ||
      paths.has(input.path) ||
      !isNonNegativeSafeInteger(input.size) ||
      input.source !== 'commit'
    ) {
      return undefined;
    }
    const bytes = codeGraphUtf8ByteLength(input.content);
    if (bytes !== input.size || bytes > ATTRIBUTION_CONTEXT_BYTES_MAXIMUM - contentBytes) return undefined;
    contentBytes += bytes;
    paths.add(input.path);
    files.push({
      blobId: input.blobId,
      content: input.content,
      contentHash: input.contentHash,
      language: input.language,
      mode: input.mode,
      path: input.path,
      size: input.size,
      source: 'commit',
    });
  }
  return files.sort((left, right) => compareCodeUnits(left.path, right.path));
}

function normalizedWorkspace(value: unknown): CodeGraphWorkspace | undefined {
  if (!Schema.is(CodeGraphWorkspaceSchema)(value) || !isSha256(value.fingerprint)) return undefined;
  try {
    return mergeCodeGraphWorkspaces([value]);
  } catch {
    return undefined;
  }
}

function isPolicyExclusionSummary(value: unknown): value is CodeGraphInventoryPolicyExclusionSummary {
  if (!Predicate.isObject(value)) return false;
  if (!isNonNegativeSafeInteger(value.bytes) || !isNonNegativeSafeInteger(value.files)) return false;
  if (
    value.policyVersion !== CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION ||
    !EffectArray.isArray(value.reasons) ||
    value.reasons.length !== CODE_GRAPH_INVENTORY_EXCLUSION_REASONS.length
  ) {
    return false;
  }
  const reasons = new Set<string>();
  let bytes = 0;
  let files = 0;
  const valid = EffectArray.every(value.reasons, reason => {
    if (!Predicate.isObject(reason)) return false;
    const bytesValue = reason.bytes;
    const filesValue = reason.files;
    const reasonValue = reason.reason;
    const accepted =
      isNonNegativeSafeInteger(bytesValue) &&
      isNonNegativeSafeInteger(filesValue) &&
      isCodeGraphInventoryExclusionReason(reasonValue) &&
      !reasons.has(reasonValue);
    if (accepted) {
      reasons.add(reasonValue);
      bytes += bytesValue;
      files += filesValue;
    }
    return accepted;
  });
  return valid && bytes === value.bytes && files === value.files;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCodeGraphInventoryExclusionReason(
  value: unknown,
): value is (typeof CODE_GRAPH_INVENTORY_EXCLUSION_REASONS)[number] {
  return (
    value === 'generic-json-size' ||
    value === 'high-signal-json-hard-cap' ||
    value === 'low-signal-json' ||
    value === 'svg'
  );
}

function isBoundedStringArray(value: unknown, maxItems: number, maxLength: number): value is readonly string[] {
  return (
    EffectArray.isArray(value) &&
    value.length <= maxItems &&
    EffectArray.every(value, item => typeof item === 'string' && item.length <= maxLength)
  );
}
