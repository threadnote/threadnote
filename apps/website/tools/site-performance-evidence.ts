import {Array as EffectArray} from 'effect';
import {ScriptError} from './effect/errors.js';
import {isJsonObject} from '@threadnote/platform/json';
import {parseBenchmarkArtifactV1} from '@threadnote/evidence/benchmark';
import {RELEASE_EVIDENCE_HARNESS_DELTA_PATHS} from '@threadnote/evidence/external-evidence';
import {
  pendingPerformanceEvidence,
  retainedPerformanceArtifactFromHarness,
  validateRetainedPerformancePayload,
  type PerformanceEvidence,
  type RetainedPerformancePayload,
} from '@threadnote/evidence/performance';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const performanceArtifactRelativePath = 'apps/website/public/performance-evidence.json';
export const performanceBindingRelativePath = 'apps/website/performance/evidence.binding.json';
export function performanceArtifactPublicUrl(siteBase: string): string {
  const segments = EffectArray.filter(Effect.pipe(siteBase, EffectString.split('/')), Boolean);
  if (
    !Effect.pipe(siteBase, EffectString.startsWith('/')) ||
    !Effect.pipe(siteBase, EffectString.endsWith('/')) ||
    Effect.pipe(siteBase, EffectString.includes('//')) ||
    EffectArray.some(segments, segment => segment === '.' || segment === '..' || !/^[A-Za-z0-9._~-]+$/.test(segment))
  ) {
    throw ScriptError.make({message: 'THREADNOTE_SITE_BASE must be a root-relative directory path ending in /.'});
  }
  return `${siteBase}performance-evidence.json`;
}

export const performanceSourcePathspecs = [
  'src',
  'scripts',
  'manager',
  'config',
  'assets',
  'apps/threadnote/src',
  'apps/threadnote/package.json',
  'apps/threadnote/embedded',
  'apps/website/tools/site-performance-evidence.ts',
  ':(glob)packages/*/src/**',
  ':(glob)packages/*/package.json',
  ':(glob)packages/*/assets/**',
  ':(glob)packages/*/static/**',
  'package.json',
  'bun.lock',
  'tsconfig.json',
] as const;

export const performanceSiteOnlyGeneratorPaths = [
  'apps/website/tools/site-articles.ts',
  'apps/website/tools/site-doc-pages.ts',
  'apps/website/tools/site-performance-evidence.ts',
  'apps/website/tools/site-release-notes.ts',
  'apps/website/tools/site-release-social-image.ts',
  // Retain the pre-workspace paths so historical source commits remain verifiable.
  'scripts/site-articles.ts',
  'scripts/site-doc-pages.ts',
  'scripts/site-performance-evidence.ts',
  'scripts/site-release-notes.ts',
  'scripts/site-release-social-image.ts',
] as const;

export const measuredPerformanceSourcePathspecs = [
  ...performanceSourcePathspecs,
  ':(exclude)package.json',
  ...EffectArray.map(performanceSiteOnlyGeneratorPaths, path => `:(exclude)${path}`),
] as const;

// `git ls-tree` does not support glob pathspec magic, so enumerate the package tree and
// retain only runtime-owned package files below.
const measuredPerformanceSourceTreeRoots = [
  'src',
  'scripts',
  'manager',
  'config',
  'assets',
  'apps/threadnote',
  'packages',
  'bun.lock',
  'tsconfig.json',
] as const;
const measuredPerformanceSourceTreeExclusions = new Set<string>(performanceSiteOnlyGeneratorPaths);
const runtimePackageSourcePath = /^packages\/[^/]+\/(?:package\.json$|(?:src|assets|static)\/)/;

const cleanPerformanceSourcePathspecs = [
  ...performanceSourcePathspecs,
  ...EffectArray.map(performanceSiteOnlyGeneratorPaths, path => `:(exclude)${path}`),
] as const;

export type PerformanceArtifactBinding = Readonly<{
  schemaVersion: 1;
  artifactSha256: string;
  generatedAt: string;
  sourceThreadnoteCommit: string;
  sourceTreeSha256: string;
}>;

const sha40Pattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const allowedHarnessDeltaPaths = new Set<string>(RELEASE_EVIDENCE_HARNESS_DELTA_PATHS);

function exactRecord(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isJsonObject(value)) throw ScriptError.make({message: `Performance binding ${path} must be an object.`});
  const record = value;
  const actualKeys = EffectRecord.keys(record).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    EffectArray.some(actualKeys, (key, index) => key !== expectedKeys[index])
  ) {
    throw ScriptError.make({message: `Performance binding ${path} has unexpected or missing fields.`});
  }
  return record;
}

function matchingString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  pattern: RegExp,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw ScriptError.make({message: `Performance binding ${path}.${key} must be ${label}.`});
  }
  return value;
}

function assertPerformanceArtifactBinding(input: unknown): asserts input is PerformanceArtifactBinding {
  const binding = exactRecord(input, 'root', [
    'schemaVersion',
    'artifactSha256',
    'generatedAt',
    'sourceThreadnoteCommit',
    'sourceTreeSha256',
  ]);
  if (binding.schemaVersion !== 1)
    throw ScriptError.make({message: 'Performance binding root.schemaVersion must be 1.'});
  matchingString(binding, 'artifactSha256', 'root', sha256Pattern, 'a lowercase SHA-256 digest');
  matchingString(binding, 'generatedAt', 'root', utcTimestampPattern, 'an ISO-8601 UTC timestamp');
  matchingString(binding, 'sourceThreadnoteCommit', 'root', sha40Pattern, 'a lowercase 40-character Git commit');
  matchingString(binding, 'sourceTreeSha256', 'root', sha256Pattern, 'a lowercase SHA-256 digest');
}

export function validatePerformanceArtifactBinding(input: unknown): PerformanceArtifactBinding {
  assertPerformanceArtifactBinding(input);
  return input;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (EffectArray.isArray(value)) return `[${EffectArray.join(EffectArray.map(value, canonicalJson), ',')}]`;
  if (!isJsonObject(value)) throw ScriptError.make({message: 'Package manifest contains a non-JSON value.'});
  return `{${EffectArray.join(
    EffectArray.map(
      EffectRecord.toEntries(value).sort(([left], [right]) => Effect.pipe(left, EffectString.localeCompare(right))),
      ([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`,
    ),
    ',',
  )}}`;
}

export function canonicalPerformanceRuntimePackageManifest(manifestBytes: Uint8Array | string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof manifestBytes === 'string' ? manifestBytes : new TextDecoder().decode(manifestBytes));
  } catch {
    throw ScriptError.make({message: 'Threadnote package manifest is not valid JSON.'});
  }
  if (!isJsonObject(parsed)) {
    throw ScriptError.make({message: 'Threadnote package manifest must be an object.'});
  }
  const manifest = {...parsed};
  const scripts = manifest.scripts;
  if (isJsonObject(scripts)) {
    manifest.scripts = EffectRecord.fromEntries(
      EffectArray.filter(
        EffectRecord.toEntries(scripts),
        ([name]) => !Effect.pipe(name, EffectString.startsWith('site:')),
      ),
    );
  }
  return canonicalJson(manifest);
}

function parseRetainedPerformanceArtifactBytes(artifactBytes: Uint8Array): RetainedPerformancePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(artifactBytes));
  } catch {
    throw ScriptError.make({message: 'Retained performance artifact is not valid JSON.'});
  }
  parseBenchmarkArtifactV1(parsed);
  return validateRetainedPerformancePayload(parsed);
}

export function bindRetainedPerformanceArtifact(input: {
  readonly artifactBytes: Uint8Array;
  readonly artifactPublicUrl: string;
  readonly binding: unknown;
  // Legacy field names retained for callers; all three values describe binding.sourceThreadnoteCommit, never HEAD.
  readonly currentLockfileSha256: string;
  readonly currentPackageManifestSha256: string;
  readonly currentSourceTreeSha256: string;
}): PerformanceEvidence {
  const binding = validatePerformanceArtifactBinding(input.binding);
  if (!sha256Pattern.test(input.currentSourceTreeSha256)) {
    throw ScriptError.make({message: 'Measured performance source-tree digest is invalid.'});
  }
  const actualArtifactSha256 = sha256Hex(input.artifactBytes);
  if (actualArtifactSha256 !== binding.artifactSha256) {
    throw ScriptError.make({
      message: `Retained performance artifact SHA-256 mismatch: expected ${binding.artifactSha256}, got ${actualArtifactSha256}.`,
    });
  }
  if (input.currentSourceTreeSha256 !== binding.sourceTreeSha256) {
    throw ScriptError.make({
      message: 'Retained performance evidence does not match its measured Threadnote source tree.',
    });
  }

  const payload = parseRetainedPerformanceArtifactBytes(input.artifactBytes);
  if (payload.environment.commit !== binding.sourceThreadnoteCommit) {
    throw ScriptError.make({
      message: 'Retained performance artifact and binding name different Threadnote source commits.',
    });
  }
  const artifact = retainedPerformanceArtifactFromHarness(payload, {
    artifactUrl: input.artifactPublicUrl,
    artifactSha256: actualArtifactSha256,
    generatedAt: binding.generatedAt,
    currentLockfileSha256: input.currentLockfileSha256,
    currentPackageManifestSha256: input.currentPackageManifestSha256,
  });
  return {state: 'verified', artifact};
}

function decodeOutput(bytes: Uint8Array | undefined): string {
  return bytes ? Effect.pipe(new TextDecoder().decode(bytes), EffectString.trim) : '';
}

function runGit(repositoryRoot: string, arguments_: readonly string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync({
    cmd: ['git', ...arguments_],
    cwd: repositoryRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
}

function requireSuccessfulGit(result: ReturnType<typeof Bun.spawnSync>, operation: string): void {
  if (result.exitCode !== 0) {
    throw ScriptError.make({
      message: `Could not ${operation}: ${decodeOutput(result.stderr) || `git exited with ${result.exitCode}`}.`,
    });
  }
}

function assertPerformanceSourceCommitAvailable(repositoryRoot: string, sourceCommit: string): void {
  if (!sha40Pattern.test(sourceCommit)) {
    throw ScriptError.make({
      message: 'Retained performance source commit must be a lowercase 40-character Git commit.',
    });
  }
  const commit = runGit(repositoryRoot, ['cat-file', '-e', `${sourceCommit}^{commit}`]);
  if (commit.exitCode !== 0) {
    throw ScriptError.make({
      message: `Retained performance source commit ${sourceCommit} is unavailable; use a full Git checkout for the website build.`,
    });
  }
}

export function assertPerformanceSourceClean(repositoryRoot: string): void {
  const unstaged = runGit(repositoryRoot, ['diff', '--quiet', '--', ...cleanPerformanceSourcePathspecs]);
  if (unstaged.exitCode === 1) {
    throw ScriptError.make({message: 'Performance-bound sources contain tracked working-tree modifications.'});
  }
  requireSuccessfulGit(unstaged, 'inspect tracked performance-source modifications');

  const staged = runGit(repositoryRoot, ['diff', '--cached', '--quiet', '--', ...cleanPerformanceSourcePathspecs]);
  if (staged.exitCode === 1) {
    throw ScriptError.make({message: 'Performance-bound sources contain staged modifications.'});
  }
  requireSuccessfulGit(staged, 'inspect staged performance-source modifications');

  const untracked = runGit(repositoryRoot, ['ls-files', '--others', '-z', '--', ...cleanPerformanceSourcePathspecs]);
  requireSuccessfulGit(untracked, 'inspect untracked performance sources');
  if ((untracked.stdout?.byteLength ?? 0) > 0) {
    throw ScriptError.make({message: 'Performance-bound sources contain untracked files.'});
  }
}

function gitFileAt(repositoryRoot: string, revision: string, path: string): Uint8Array {
  const result = runGit(repositoryRoot, ['show', `${revision}:${path}`]);
  requireSuccessfulGit(result, `read ${path} at ${revision}`);
  return result.stdout ?? new Uint8Array();
}

export function assertPerformancePackageManifestMatchesCommit(repositoryRoot: string, sourceCommit: string): void {
  const current = canonicalPerformanceRuntimePackageManifest(gitFileAt(repositoryRoot, 'HEAD', 'package.json'));
  const measured = canonicalPerformanceRuntimePackageManifest(gitFileAt(repositoryRoot, sourceCommit, 'package.json'));
  if (current !== measured) {
    throw ScriptError.make({
      message:
        'Threadnote package manifest changed outside site-only scripts after the retained performance run; publish fresh evidence.',
    });
  }
}

export function assertPerformanceSourcesMatchCommit(repositoryRoot: string, sourceCommit: string): void {
  assertPerformanceSourceClean(repositoryRoot);
  assertPerformanceSourceCommitAvailable(repositoryRoot, sourceCommit);
  const changed = runGit(repositoryRoot, [
    'diff',
    '--quiet',
    sourceCommit,
    'HEAD',
    '--',
    ...measuredPerformanceSourcePathspecs,
  ]);
  if (changed.exitCode !== 0) {
    throw ScriptError.make({
      message: 'Threadnote runtime sources changed after the retained performance run; publish fresh evidence.',
    });
  }
  assertPerformancePackageManifestMatchesCommit(repositoryRoot, sourceCommit);
}

function verifyReleaseEvidenceSource(repositoryRoot: string, payload: RetainedPerformancePayload): void {
  const ref = String(payload.metadata.releaseEvidenceRef);
  const releaseSha = String(payload.metadata.releaseEvidenceSha);
  const sourceMode = String(payload.metadata.releaseEvidenceSourceMode);
  const harnessCommit = String(payload.metadata.releaseEvidenceHarnessCommit);
  const resolved = runGit(repositoryRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  requireSuccessfulGit(resolved, 'resolve the retained performance release tag');
  if (decodeOutput(resolved.stdout) !== releaseSha) {
    throw ScriptError.make({
      message: 'Retained performance release tag does not resolve to its recorded release commit.',
    });
  }
  if (
    sourceMode === 'exact-release' &&
    harnessCommit === releaseSha &&
    payload.environment.commit === releaseSha &&
    payload.metadata.releaseEvidenceHarnessDeltaPaths === '[]'
  ) {
    return;
  }
  if (
    sourceMode !== 'release-plus-reviewed-harness-delta' ||
    harnessCommit !== payload.environment.commit ||
    harnessCommit === releaseSha
  ) {
    throw ScriptError.make({message: 'Retained performance evidence has invalid release/harness source binding.'});
  }
  const mergeBase = runGit(repositoryRoot, ['merge-base', releaseSha, harnessCommit]);
  requireSuccessfulGit(mergeBase, 'verify the retained performance harness ancestry');
  if (decodeOutput(mergeBase.stdout) !== releaseSha) {
    throw ScriptError.make({message: 'Retained performance harness commit is not a descendant of its release commit.'});
  }
  const changed = runGit(repositoryRoot, [
    'diff',
    '--name-only',
    '--diff-filter=ACDMRTUXB',
    `${releaseSha}..${harnessCommit}`,
    '--',
    ...performanceSourcePathspecs,
  ]);
  requireSuccessfulGit(changed, 'inspect the retained performance harness delta');
  const deltaPaths = EffectArray.filter(
    Effect.pipe(decodeOutput(changed.stdout), EffectString.split('\n')),
    Boolean,
  ).sort();
  const recordedDelta = String(payload.metadata.releaseEvidenceHarnessDeltaPaths);
  if (
    JSON.stringify(deltaPaths) !== recordedDelta ||
    deltaPaths.length === 0 ||
    EffectArray.some(deltaPaths, path => !allowedHarnessDeltaPaths.has(path))
  ) {
    throw ScriptError.make({message: 'Retained performance harness delta contains unreviewed runtime-source changes.'});
  }
}

type PerformanceSourceTreeEntry = Readonly<{
  mode: string;
  objectId: string;
  path: string;
}>;

function performanceSourceTreeEntriesAtCommit(
  repositoryRoot: string,
  sourceCommit: string,
): readonly PerformanceSourceTreeEntry[] {
  assertPerformanceSourceCommitAvailable(repositoryRoot, sourceCommit);
  const listed = runGit(repositoryRoot, [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    sourceCommit,
    '--',
    ...measuredPerformanceSourceTreeRoots,
  ]);
  if (listed.exitCode !== 0) {
    throw ScriptError.make({
      message: `Could not inventory measured performance sources: ${decodeOutput(listed.stderr)}.`,
    });
  }
  const entries = EffectArray.filter(
    EffectArray.map(
      EffectArray.filter(Effect.pipe(new TextDecoder().decode(listed.stdout), EffectString.split('\0')), Boolean),
      entry => {
        const tabIndex = Effect.pipe(
          entry,
          EffectString.indexOf('\t'),
          Effect.Option.getOrElse(() => -1),
        );
        if (tabIndex === -1) throw ScriptError.make({message: 'Git returned an invalid performance source entry.'});
        const metadata = Effect.pipe(entry, EffectString.slice(0, tabIndex), EffectString.split(' '));
        const mode = metadata[0];
        const type = metadata[1];
        const objectId = metadata[2];
        const path = Effect.pipe(entry, EffectString.slice(tabIndex + 1));
        if (!mode || type !== 'blob' || !objectId || !sha40Pattern.test(objectId) || !path) {
          throw ScriptError.make({message: 'Git returned an incomplete performance source entry.'});
        }
        return {mode, objectId, path};
      },
    ),
    entry =>
      !measuredPerformanceSourceTreeExclusions.has(entry.path) &&
      (!Effect.pipe(entry.path, EffectString.startsWith('packages/')) || runtimePackageSourcePath.test(entry.path)),
  ).sort((left, right) => Effect.pipe(left.path, EffectString.localeCompare(right.path)));
  if (entries.length === 0) throw ScriptError.make({message: 'Performance source inventory is empty.'});
  return entries;
}

function hashPerformanceSourceTreeEntries(
  repositoryRoot: string,
  entries: readonly PerformanceSourceTreeEntry[],
): string {
  const batch = Bun.spawnSync({
    cmd: ['git', 'cat-file', '--batch'],
    cwd: repositoryRoot,
    stdin: new TextEncoder().encode(
      `${EffectArray.join(
        EffectArray.map(entries, entry => entry.objectId),
        '\n',
      )}\n`,
    ),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  requireSuccessfulGit(batch, 'read measured performance source blobs');
  const output = batch.stdout ?? new Uint8Array();

  const hasher = new Bun.CryptoHasher('sha256');
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd === -1)
      throw ScriptError.make({message: 'Git returned an incomplete performance source blob header.'});
    const [objectId, type, sizeText] = Effect.pipe(
      new TextDecoder().decode(output.subarray(offset, headerEnd)),
      EffectString.split(' '),
    );
    const size = Number(sizeText);
    if (objectId !== entry.objectId || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw ScriptError.make({message: 'Git returned an invalid performance source blob header.'});
    }
    const blobStart = headerEnd + 1;
    const blobEnd = blobStart + size;
    if (blobEnd >= output.byteLength || output[blobEnd] !== 10) {
      throw ScriptError.make({message: 'Git returned an incomplete performance source blob.'});
    }
    hasher.update(`${entry.mode}\0${entry.path}\0${size}\0`);
    hasher.update(output.subarray(blobStart, blobEnd));
    hasher.update('\0');
    offset = blobEnd + 1;
  }
  if (offset !== output.byteLength)
    throw ScriptError.make({message: 'Git returned unexpected performance source blob data.'});
  return hasher.digest('hex');
}

export function computePerformanceSourceTreeSha256AtCommit(repositoryRoot: string, sourceCommit: string): string {
  return hashPerformanceSourceTreeEntries(
    repositoryRoot,
    performanceSourceTreeEntriesAtCommit(repositoryRoot, sourceCommit),
  );
}

export async function computePerformanceSourceTreeSha256(repositoryRoot: string): Promise<string> {
  assertPerformanceSourceClean(repositoryRoot);
  const head = runGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  requireSuccessfulGit(head, 'resolve the current performance source commit');
  return computePerformanceSourceTreeSha256AtCommit(repositoryRoot, decodeOutput(head.stdout));
}

export function performanceSourceDependencyHashesAtCommit(
  repositoryRoot: string,
  sourceCommit: string,
): {
  readonly lockfileSha256: string;
  readonly packageManifestSha256: string;
} {
  assertPerformanceSourceCommitAvailable(repositoryRoot, sourceCommit);
  const lockfile = gitFileAt(repositoryRoot, sourceCommit, 'bun.lock');
  const packageManifest = gitFileAt(repositoryRoot, sourceCommit, 'package.json');
  return {
    lockfileSha256: sha256Hex(lockfile),
    packageManifestSha256: sha256Hex(packageManifest),
  };
}

export async function loadRetainedPerformanceEvidence(
  repositoryRoot: string,
  siteBase: string,
): Promise<PerformanceEvidence> {
  const artifactFile = Bun.file(`${repositoryRoot}/${performanceArtifactRelativePath}`);
  const bindingFile = Bun.file(`${repositoryRoot}/${performanceBindingRelativePath}`);
  const [artifactExists, bindingExists] = await Promise.all([artifactFile.exists(), bindingFile.exists()]);
  if (!artifactExists && !bindingExists) {
    return pendingPerformanceEvidence(
      'Final exact-HEAD cold, incremental, independent-rebuild, query, storage, and Manager evidence is still being retained and reviewed.',
    );
  }
  if (!artifactExists || !bindingExists) {
    throw ScriptError.make({
      message: 'Retained performance evidence requires both the local JSON artifact and its binding file.',
    });
  }

  let bindingInput: unknown;
  try {
    bindingInput = JSON.parse(await bindingFile.text());
  } catch {
    throw ScriptError.make({message: 'Retained performance binding is not valid JSON.'});
  }
  const binding = validatePerformanceArtifactBinding(bindingInput);
  // This page publishes historical release evidence. Later runtime changes must not rewrite its source identity;
  // new bindings remain strict against the current clean HEAD in writePerformanceArtifactBinding below.
  const measuredSourceTreeSha256 = computePerformanceSourceTreeSha256AtCommit(
    repositoryRoot,
    binding.sourceThreadnoteCommit,
  );
  const dependencyHashes = performanceSourceDependencyHashesAtCommit(repositoryRoot, binding.sourceThreadnoteCommit);
  const artifactBuffer = await artifactFile.arrayBuffer();
  const artifactBytes = new Uint8Array(artifactBuffer);
  verifyReleaseEvidenceSource(repositoryRoot, parseRetainedPerformanceArtifactBytes(artifactBytes));
  return bindRetainedPerformanceArtifact({
    artifactBytes,
    artifactPublicUrl: performanceArtifactPublicUrl(siteBase),
    binding,
    currentLockfileSha256: dependencyHashes.lockfileSha256,
    currentPackageManifestSha256: dependencyHashes.packageManifestSha256,
    currentSourceTreeSha256: measuredSourceTreeSha256,
  });
}

export async function writePerformanceArtifactBinding(repositoryRoot: string): Promise<PerformanceArtifactBinding> {
  const artifactFile = Bun.file(`${repositoryRoot}/${performanceArtifactRelativePath}`);
  if (!(await artifactFile.exists())) {
    throw ScriptError.make({
      message: `Place the reviewed payload at ${performanceArtifactRelativePath} before creating its binding.`,
    });
  }

  const artifactBytes = new Uint8Array(await artifactFile.arrayBuffer());
  const payload = parseRetainedPerformanceArtifactBytes(artifactBytes);
  assertPerformanceSourcesMatchCommit(repositoryRoot, payload.environment.commit);
  verifyReleaseEvidenceSource(repositoryRoot, payload);
  const sourceTreeSha256 = await computePerformanceSourceTreeSha256(repositoryRoot);
  const dependencyHashes = performanceSourceDependencyHashesAtCommit(repositoryRoot, payload.environment.commit);
  const binding = validatePerformanceArtifactBinding({
    schemaVersion: 1,
    artifactSha256: sha256Hex(artifactBytes),
    generatedAt: payload.createdAt,
    sourceThreadnoteCommit: payload.environment.commit,
    sourceTreeSha256,
  });
  retainedPerformanceArtifactFromHarness(payload, {
    artifactUrl: performanceArtifactPublicUrl('/'),
    artifactSha256: binding.artifactSha256,
    generatedAt: binding.generatedAt,
    currentLockfileSha256: dependencyHashes.lockfileSha256,
    currentPackageManifestSha256: dependencyHashes.packageManifestSha256,
  });
  await Bun.write(`${repositoryRoot}/${performanceBindingRelativePath}`, `${JSON.stringify(binding, undefined, 2)}\n`);
  return binding;
}

if (import.meta.main) {
  try {
    const binding = await writePerformanceArtifactBinding(process.cwd());
    process.stdout.write(
      `Wrote ${performanceBindingRelativePath}\n` +
        `Artifact SHA-256: ${binding.artifactSha256}\n` +
        `Source tree SHA-256: ${binding.sourceTreeSha256}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
