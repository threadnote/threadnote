#!/usr/bin/env bun
import {Array as EffectArray} from 'effect';

import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_MEMORY_LINK_RELEASE_DEFERMENT_TYPE = 'code-memory-link-release-experiment-deferment';
export const CODE_MEMORY_LINK_RELEASE_DEFERMENT_VERSION = 1;
export const CODE_MEMORY_LINK_RELEASE_DEFERMENT_TAG = 'v4.6.0';
export const CODE_MEMORY_LINK_RELEASE_DEFERMENT_FOLLOW_UP = '4.6.1';
export const CODE_MEMORY_LINK_RELEASE_DEFERMENT_REASON =
  'pinned-codex-0.144.5-agent-turn-exceeded-192000-tokens-without-a-file-action';
export const CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_COMMIT = '9ac28435659ce421ebc78b302616eaac75112597';
export const CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_EXECUTABLE_SHA256 =
  '6a573c4bd227ec7ed49888be9dd416eaa0f38128e22ddad761c483ad1328cbfa';
export const CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_PAYLOAD_MANIFEST_SHA256 =
  'de2fdd4d67c0248e7e4f0e6ba302c6f9544febb875a5b401cb19f0873af96db2';
export const CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_RELEASE_METADATA_SHA256 =
  '48a60f7951200f591909a305fc89de8265d428c5905d90d020d007cdd36f40e4';
export const CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_VERSION =
  '4.6.0-local.g9ac28435659ce421ebc78b302616eaac75112597';
export const CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_COMMIT = '3d260ca72adc8b6493e75fa17d809ffcee89b3d4';
export const CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_TREE = '6fbc9e5b6dcaed8cdf75e9c6786511d63c20ed68';

const COMMIT = /^[0-9a-f]{40}$/u;
const MAXIMUM_GIT_OUTPUT_BYTES = 1_048_576;
const RELEASE_VERSION = '4.6.0';

export interface CodeMemoryLinkReleaseDefermentCandidateV1 {
  readonly commit: typeof CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_COMMIT;
  readonly dependencyInstallation: 'bun install --frozen-lockfile';
  readonly payloadBytes: 350_128_313;
  readonly payloadFileCount: 88;
  readonly payloadManifestSha256: typeof CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_PAYLOAD_MANIFEST_SHA256;
  readonly releaseMetadataSha256: typeof CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_RELEASE_METADATA_SHA256;
  readonly runtime: 'bun-1.3.14';
  readonly target: 'bun-darwin-arm64';
  readonly testedCandidateExecutableSha256: typeof CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_EXECUTABLE_SHA256;
  readonly version: typeof CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_VERSION;
}

export const CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE: CodeMemoryLinkReleaseDefermentCandidateV1 = {
  commit: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_COMMIT,
  dependencyInstallation: 'bun install --frozen-lockfile',
  payloadBytes: 350_128_313,
  payloadFileCount: 88,
  payloadManifestSha256: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_PAYLOAD_MANIFEST_SHA256,
  releaseMetadataSha256: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_RELEASE_METADATA_SHA256,
  runtime: 'bun-1.3.14',
  target: 'bun-darwin-arm64',
  testedCandidateExecutableSha256: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_EXECUTABLE_SHA256,
  version: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_VERSION,
};

export interface CodeMemoryLinkReleaseDefermentV1 {
  readonly candidate: CodeMemoryLinkReleaseDefermentCandidateV1;
  readonly deferredExperiment: {
    readonly canonicalTrialsExecuted: 0;
    readonly followUpVersion: typeof CODE_MEMORY_LINK_RELEASE_DEFERMENT_FOLLOW_UP;
    readonly minimumObservedProviderTokens: 192_000;
    readonly scope: 'code-memory-link-c-a-g-external-agent-experiment';
  };
  readonly reason: typeof CODE_MEMORY_LINK_RELEASE_DEFERMENT_REASON;
  readonly releaseTag: typeof CODE_MEMORY_LINK_RELEASE_DEFERMENT_TAG;
  readonly type: typeof CODE_MEMORY_LINK_RELEASE_DEFERMENT_TYPE;
  readonly version: typeof CODE_MEMORY_LINK_RELEASE_DEFERMENT_VERSION;
}

export interface CodeMemoryLinkReleaseDefermentGovernanceChange {
  readonly mode: string;
  readonly path: string;
  readonly status: 'A' | 'M';
}

export interface CodeMemoryLinkReleaseDefermentResolution {
  readonly candidate: CodeMemoryLinkReleaseDefermentCandidateV1;
  readonly governanceCommit: string;
  readonly initialGovernanceCommit: typeof CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_COMMIT;
  readonly waiverPath: string;
}

export function codeMemoryLinkReleaseDefermentPath(releaseTag: string): string {
  if (releaseTag !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_TAG) invalid('deferment is valid only for v4.6.0');
  return `.github/release-evidence/code-memory-link/${releaseTag}.deferment.json`;
}

export function parseCodeMemoryLinkReleaseDefermentV1(input: {
  readonly expectedReleaseTag: string;
  readonly repositoryPath: string;
  readonly source: string;
}): CodeMemoryLinkReleaseDefermentV1 {
  const expectedPath = codeMemoryLinkReleaseDefermentPath(input.expectedReleaseTag);
  if (input.repositoryPath !== expectedPath) invalid('deferment path differs from the exact version-bound path');
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.source);
  } catch (cause) {
    invalid(`deferment is not valid JSON (${String(cause)})`);
  }
  const value = record(decoded, 'deferment');
  exactKeys(value, ['candidate', 'deferredExperiment', 'reason', 'releaseTag', 'type', 'version'], 'deferment');
  if (value.type !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_TYPE) invalid('deferment type differs');
  if (value.version !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_VERSION) invalid('deferment version differs');
  if (value.releaseTag !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_TAG) invalid('deferment release tag differs');
  if (value.reason !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_REASON) invalid('deferment reason differs');

  const candidate = record(value.candidate, 'deferment candidate');
  exactKeys(
    candidate,
    [
      'commit',
      'dependencyInstallation',
      'payloadBytes',
      'payloadFileCount',
      'payloadManifestSha256',
      'releaseMetadataSha256',
      'runtime',
      'target',
      'testedCandidateExecutableSha256',
      'version',
    ],
    'deferment candidate',
  );
  if (
    candidate.commit !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_COMMIT ||
    candidate.dependencyInstallation !== 'bun install --frozen-lockfile' ||
    candidate.payloadBytes !== 350_128_313 ||
    candidate.payloadFileCount !== 88 ||
    candidate.payloadManifestSha256 !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_PAYLOAD_MANIFEST_SHA256 ||
    candidate.releaseMetadataSha256 !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_RELEASE_METADATA_SHA256 ||
    candidate.runtime !== 'bun-1.3.14' ||
    candidate.target !== 'bun-darwin-arm64' ||
    candidate.testedCandidateExecutableSha256 !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_EXECUTABLE_SHA256 ||
    candidate.version !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_VERSION
  ) {
    invalid('deferment candidate differs from the exact qualified 4.6.0 receipt');
  }

  const deferredExperiment = record(value.deferredExperiment, 'deferred experiment');
  exactKeys(
    deferredExperiment,
    ['canonicalTrialsExecuted', 'followUpVersion', 'minimumObservedProviderTokens', 'scope'],
    'deferred experiment',
  );
  if (
    deferredExperiment.canonicalTrialsExecuted !== 0 ||
    deferredExperiment.followUpVersion !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_FOLLOW_UP ||
    deferredExperiment.minimumObservedProviderTokens !== 192_000 ||
    deferredExperiment.scope !== 'code-memory-link-c-a-g-external-agent-experiment'
  ) {
    invalid('deferred experiment contract differs');
  }

  const parsed: CodeMemoryLinkReleaseDefermentV1 = {
    candidate: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE,
    deferredExperiment: {
      canonicalTrialsExecuted: 0,
      followUpVersion: CODE_MEMORY_LINK_RELEASE_DEFERMENT_FOLLOW_UP,
      minimumObservedProviderTokens: 192_000,
      scope: 'code-memory-link-c-a-g-external-agent-experiment',
    },
    reason: CODE_MEMORY_LINK_RELEASE_DEFERMENT_REASON,
    releaseTag: CODE_MEMORY_LINK_RELEASE_DEFERMENT_TAG,
    type: CODE_MEMORY_LINK_RELEASE_DEFERMENT_TYPE,
    version: CODE_MEMORY_LINK_RELEASE_DEFERMENT_VERSION,
  };
  if (`${JSON.stringify(parsed, undefined, 2)}\n` !== input.source)
    invalid('deferment must use canonical JSON encoding');
  return parsed;
}

export function assertCodeMemoryLinkReleaseDefermentGovernance(input: {
  readonly changes: readonly CodeMemoryLinkReleaseDefermentGovernanceChange[];
  readonly governanceCommit: string;
  readonly initialGovernanceParentCommit: string;
  readonly initialGovernanceTree: string;
  readonly packageVersion: string;
  readonly parentCommit: string;
  readonly waiver: CodeMemoryLinkReleaseDefermentV1;
  readonly waiverPath: string;
}): CodeMemoryLinkReleaseDefermentResolution {
  if (!COMMIT.test(input.governanceCommit)) invalid('governance commit is invalid');
  if (
    input.parentCommit !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_COMMIT ||
    input.initialGovernanceParentCommit !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_COMMIT ||
    input.initialGovernanceTree !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_TREE ||
    input.waiver.candidate.commit !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_COMMIT
  ) {
    invalid('deferment governance must be the exact bounded CI correction after the fixed qualified candidate C');
  }
  if (input.packageVersion !== RELEASE_VERSION) invalid('tracked package version differs from the deferred release');
  if (input.waiverPath !== codeMemoryLinkReleaseDefermentPath(CODE_MEMORY_LINK_RELEASE_DEFERMENT_TAG)) {
    invalid('deferment waiver path differs');
  }
  const expected: CodeMemoryLinkReleaseDefermentGovernanceChange[] = [
    {mode: '100644', path: '.github/workflows/publish.yml', status: 'M'},
    {mode: '100644', path: input.waiverPath, status: 'A'},
    {mode: '100644', path: 'scripts/verify-code-memory-link-release-deferment.ts', status: 'A'},
    {mode: '100644', path: 'apps/threadnote/test/unit/code-memory-link-release-deferment.test.ts', status: 'A'},
  ];
  const observed = [...input.changes].sort(compareChange);
  expected.sort(compareChange);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    invalid('deferment governance contains an unsupported, missing, or executable path');
  }
  return {
    candidate: CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE,
    governanceCommit: input.governanceCommit,
    initialGovernanceCommit: CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_COMMIT,
    waiverPath: input.waiverPath,
  };
}

export async function resolveCodeMemoryLinkReleaseDeferment(input: {
  readonly releaseTag: string;
  readonly repositoryRoot: string;
  readonly waiverPath: string;
}): Promise<CodeMemoryLinkReleaseDefermentResolution> {
  const governanceCommit = Effect.pipe(
    await git(input.repositoryRoot, ['rev-parse', 'HEAD^{commit}']),
    EffectString.trim,
  );
  const parents = Effect.pipe(
    await git(input.repositoryRoot, ['rev-list', '--parents', '-n', '1', governanceCommit]),
    EffectString.trim,
    EffectString.split(/\s+/u),
  );
  const parentCommit = parents[1];
  if (parents.length !== 2 || parents[0] !== governanceCommit || parentCommit === undefined) {
    invalid('deferment governance must have exactly one parent');
  }
  const expectedPaths = governancePaths(input.waiverPath);
  const [source, packageSource, changeSource, trackedSource, initialParentSource, initialGovernanceTree] =
    await Promise.all([
      git(input.repositoryRoot, ['show', `${governanceCommit}:${input.waiverPath}`]),
      git(input.repositoryRoot, ['show', `${governanceCommit}:package.json`]),
      git(input.repositoryRoot, [
        'diff',
        '--name-status',
        '--no-renames',
        CODE_MEMORY_LINK_RELEASE_DEFERMENT_CANDIDATE_COMMIT,
        governanceCommit,
      ]),
      git(input.repositoryRoot, ['ls-tree', '-z', governanceCommit, '--', ...expectedPaths]),
      git(input.repositoryRoot, [
        'rev-list',
        '--parents',
        '-n',
        '1',
        CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_COMMIT,
      ]),
      git(input.repositoryRoot, [
        'rev-parse',
        `${CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_COMMIT}^{tree}`,
      ]),
    ]);
  const initialParents = Effect.pipe(initialParentSource, EffectString.trim, EffectString.split(/\s+/u));
  const initialGovernanceParentCommit = initialParents[1];
  if (
    initialParents.length !== 2 ||
    initialParents[0] !== CODE_MEMORY_LINK_RELEASE_DEFERMENT_INITIAL_GOVERNANCE_COMMIT ||
    initialGovernanceParentCommit === undefined
  ) {
    invalid('initial deferment governance must have exactly one parent');
  }
  const waiver = parseCodeMemoryLinkReleaseDefermentV1({
    expectedReleaseTag: input.releaseTag,
    repositoryPath: input.waiverPath,
    source,
  });
  const packageValue = record(JSON.parse(packageSource), 'package manifest');
  if (typeof packageValue.version !== 'string') invalid('package manifest version is missing');
  const modes = parseTrackedModes(trackedSource);
  const changes = EffectArray.map(parseChanges(changeSource), change => {
    const mode = modes.get(change.path);
    if (mode !== '100644') invalid(`deferment governance path ${change.path} is not a regular 100644 blob`);
    return {mode, path: change.path, status: change.status};
  });
  return assertCodeMemoryLinkReleaseDefermentGovernance({
    changes,
    governanceCommit,
    initialGovernanceParentCommit,
    initialGovernanceTree: Effect.pipe(initialGovernanceTree, EffectString.trim),
    packageVersion: packageValue.version,
    parentCommit,
    waiver,
    waiverPath: input.waiverPath,
  });
}

function governancePaths(waiverPath: string): readonly string[] {
  return [
    '.github/workflows/publish.yml',
    waiverPath,
    'scripts/verify-code-memory-link-release-deferment.ts',
    'apps/threadnote/test/unit/code-memory-link-release-deferment.test.ts',
  ];
}

function parseChanges(source: string): readonly {readonly path: string; readonly status: 'A' | 'M'}[] {
  return EffectArray.map(
    EffectArray.filter(Effect.pipe(source, EffectString.trim, EffectString.split(/\r?\n/u)), Boolean),
    line => {
      const [status, repositoryPath, extra] = Effect.pipe(line, EffectString.split('\t'));
      if ((status !== 'A' && status !== 'M') || !repositoryPath || extra !== undefined) {
        invalid('deferment governance contains an unsupported Git change');
      }
      return {path: repositoryPath, status};
    },
  );
}

function parseTrackedModes(source: string): ReadonlyMap<string, string> {
  const modes = new Map<string, string>();
  for (const entry of EffectArray.filter(Effect.pipe(source, EffectString.split('\0')), Boolean)) {
    const match = /^(\d{6}) blob [0-9a-f]{40,64}\t(.+)$/u.exec(entry);
    if (match === null || match[1] === undefined || match[2] === undefined || modes.has(match[2])) {
      invalid('deferment governance contains an unsupported tracked object');
    }
    modes.set(match[2], match[1]);
  }
  return modes;
}

async function git(repositoryRoot: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({cmd: ['git', '-C', repositoryRoot, ...args], stderr: 'pipe', stdout: 'pipe'});
  const [stdout, stderr, exitCode] = await Promise.all([
    readBounded(child.stdout, MAXIMUM_GIT_OUTPUT_BYTES),
    readBounded(child.stderr, 64 * 1024),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Git command failed: ${Effect.pipe(stderr, EffectString.trim)}`);
  return stdout;
}

async function readBounded(stream: ReadableStream<Uint8Array>, maximumBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maximumBytes) throw new Error('Git output exceeded the bounded release-verification limit.');
    chunks.push(next.value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || EffectArray.isArray(value)) invalid(`${label} must be an object`);
  return EffectRecord.fromEntries(EffectRecord.toEntries(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const observed = EffectRecord.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) invalid(`${label} has unsupported or missing fields`);
}

function compareChange(
  left: {readonly mode: string; readonly path: string; readonly status: string},
  right: {readonly mode: string; readonly path: string; readonly status: string},
): number {
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.status !== right.status) return left.status < right.status ? -1 : 1;
  if (left.mode !== right.mode) return left.mode < right.mode ? -1 : 1;
  return 0;
}

function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link release deferment: ${message}.`);
}

function parseArguments(args: readonly string[]): {
  readonly mode: 'full' | 'print-candidate-commit' | 'print-candidate-receipt-json';
  readonly releaseTag: string;
  readonly waiverPath: string;
} {
  const values = new Map<string, string>();
  let mode: 'full' | 'print-candidate-commit' | 'print-candidate-receipt-json' = 'full';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) invalid('argument parsing failed');
    if (argument === '--print-candidate-commit') {
      if (mode !== 'full') invalid('only one print mode is supported');
      mode = 'print-candidate-commit';
      continue;
    }
    if (argument === '--print-candidate-receipt-json') {
      if (mode !== 'full') invalid('only one print mode is supported');
      mode = 'print-candidate-receipt-json';
      continue;
    }
    if (argument !== '--waiver' && argument !== '--release-tag') invalid(`unsupported argument ${argument}`);
    const value = args[index + 1];
    if (!value || values.has(argument)) invalid(`missing or repeated value for ${argument}`);
    values.set(argument, value);
    index += 1;
  }
  const releaseTag = values.get('--release-tag');
  const waiverPath = values.get('--waiver');
  if (!releaseTag || !waiverPath) invalid('--waiver and --release-tag are required');
  return {mode, releaseTag, waiverPath};
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const resolution = await resolveCodeMemoryLinkReleaseDeferment({
    releaseTag: parsed.releaseTag,
    repositoryRoot: process.cwd(),
    waiverPath: parsed.waiverPath,
  });
  if (parsed.mode === 'print-candidate-commit') {
    process.stdout.write(`${resolution.candidate.commit}\n`);
  } else if (parsed.mode === 'print-candidate-receipt-json') {
    process.stdout.write(`${JSON.stringify(resolution.candidate)}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify(
        {
          candidate: resolution.candidate,
          deferredExperiment: {
            followUpVersion: CODE_MEMORY_LINK_RELEASE_DEFERMENT_FOLLOW_UP,
            reason: CODE_MEMORY_LINK_RELEASE_DEFERMENT_REASON,
            status: 'deferred',
          },
          gate: {status: 'passed'},
          governance: {
            commit: resolution.governanceCommit,
            initialCommit: resolution.initialGovernanceCommit,
            waiverPath: resolution.waiverPath,
          },
          type: 'code-memory-link-release-deferment-evidence',
          version: 1,
        },
        undefined,
        2,
      )}\n`,
    );
  }
}

if (import.meta.main) {
  main().catch(cause => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
