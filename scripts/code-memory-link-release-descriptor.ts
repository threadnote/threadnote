import {Array as EffectArray, Predicate} from 'effect';
import {CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT} from '@threadnote/threadnote/evaluation/code-memory-link-retained-bundle';
import {
  CODE_MEMORY_LINK_SCALE_ARTIFACT_ROOT,
  codeMemoryLinkScaleArtifactPath,
} from '@threadnote/threadnote/evaluation/code-memory-link-scale-contract';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_MEMORY_LINK_RELEASE_DESCRIPTOR_ROOT = '.github/release-evidence/code-memory-link' as const;
export const CODE_MEMORY_LINK_RELEASE_DESCRIPTOR_TYPE = 'code-memory-link-release-governance' as const;
export const CODE_MEMORY_LINK_RELEASE_DESCRIPTOR_VERSION = 1 as const;

export interface CodeMemoryLinkReleaseDescriptorV1 {
  readonly candidate: {
    readonly commit: string;
    readonly dependencyInstallation: 'bun install --frozen-lockfile';
    readonly payloadBytes: number;
    readonly payloadFileCount: number;
    readonly payloadManifestSha256: string;
    readonly releaseMetadataSha256: string;
    readonly runtime: string;
    readonly sourceLockfileSha256: string;
    readonly sourcePackageManifestSha256: string;
    readonly target: string;
    readonly testedCandidateExecutableSha256: string;
    readonly version: string;
  };
  readonly releaseTag: string;
  readonly retainedBundle: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly scaleArtifact: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly type: typeof CODE_MEMORY_LINK_RELEASE_DESCRIPTOR_TYPE;
  readonly version: typeof CODE_MEMORY_LINK_RELEASE_DESCRIPTOR_VERSION;
}

const COMMIT = /^[0-9a-f]{40}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const BUILD_TARGET = /^bun-[a-z0-9]+(?:-[a-z0-9]+)+$/u;
const DEVELOPMENT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:-|\.)local\.g[0-9a-f]{40}$/u;

export function codeMemoryLinkReleaseDescriptorPath(releaseTag: string): string {
  return `${CODE_MEMORY_LINK_RELEASE_DESCRIPTOR_ROOT}/${matching(releaseTag, RELEASE_TAG, 'release tag')}.json`;
}

export function parseCodeMemoryLinkReleaseDescriptorV1(input: {
  readonly expectedReleaseTag: string;
  readonly repositoryPath: string;
  readonly source: string;
}): CodeMemoryLinkReleaseDescriptorV1 {
  const expectedReleaseTag = matching(input.expectedReleaseTag, RELEASE_TAG, 'expected release tag');
  if (input.repositoryPath !== codeMemoryLinkReleaseDescriptorPath(expectedReleaseTag)) {
    invalid('descriptor path must be the exact version-bound release-evidence path');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.source);
  } catch (cause) {
    invalid(`descriptor must be valid JSON (${String(cause)})`);
  }
  const descriptor = record(decoded, 'descriptor');
  exactKeys(
    descriptor,
    ['candidate', 'releaseTag', 'retainedBundle', 'scaleArtifact', 'type', 'version'],
    'descriptor',
  );
  if (descriptor.type !== CODE_MEMORY_LINK_RELEASE_DESCRIPTOR_TYPE) invalid('descriptor type is unsupported');
  if (descriptor.version !== CODE_MEMORY_LINK_RELEASE_DESCRIPTOR_VERSION) invalid('descriptor version is unsupported');
  if (descriptor.releaseTag !== expectedReleaseTag) invalid('descriptor release tag differs from the expected tag');

  const candidate = record(descriptor.candidate, 'candidate');
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
      'sourceLockfileSha256',
      'sourcePackageManifestSha256',
      'target',
      'testedCandidateExecutableSha256',
      'version',
    ],
    'candidate',
  );
  if (candidate.dependencyInstallation !== 'bun install --frozen-lockfile') {
    invalid('candidate dependency installation is unsupported');
  }
  const retainedBundle = record(descriptor.retainedBundle, 'retained bundle');
  exactKeys(retainedBundle, ['path', 'sha256'], 'retained bundle');
  const retainedBundleSha256 = matching(retainedBundle.sha256, HASH, 'retained bundle SHA-256');
  const retainedBundlePath = matching(
    retainedBundle.path,
    new RegExp(`^${CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT}/([0-9a-f]{64})/bundle\\.json$`, 'u'),
    'retained bundle path',
  );
  const pathHash = new RegExp(`^${CODE_MEMORY_LINK_RETAINED_BUNDLE_ROOT}/([0-9a-f]{64})/bundle\\.json$`, 'u').exec(
    retainedBundlePath,
  )?.[1];
  if (pathHash !== retainedBundleSha256) invalid('retained bundle path and SHA-256 differ');

  const scaleArtifact = record(descriptor.scaleArtifact, 'scale artifact');
  exactKeys(scaleArtifact, ['path', 'sha256'], 'scale artifact');
  const scaleArtifactSha256 = matching(scaleArtifact.sha256, HASH, 'scale artifact SHA-256');
  const scaleArtifactPath = matching(
    scaleArtifact.path,
    new RegExp(`^${CODE_MEMORY_LINK_SCALE_ARTIFACT_ROOT}/[0-9a-f]{64}\\.json$`, 'u'),
    'scale artifact path',
  );
  if (scaleArtifactPath !== codeMemoryLinkScaleArtifactPath(scaleArtifactSha256)) {
    invalid('scale artifact path and SHA-256 differ');
  }

  const parsed: CodeMemoryLinkReleaseDescriptorV1 = {
    candidate: {
      commit: matching(candidate.commit, COMMIT, 'candidate commit'),
      dependencyInstallation: 'bun install --frozen-lockfile',
      payloadBytes: positiveInteger(candidate.payloadBytes, 'candidate payload bytes'),
      payloadFileCount: positiveInteger(candidate.payloadFileCount, 'candidate payload file count'),
      payloadManifestSha256: matching(candidate.payloadManifestSha256, HASH, 'candidate payload manifest SHA-256'),
      releaseMetadataSha256: matching(candidate.releaseMetadataSha256, HASH, 'candidate release metadata SHA-256'),
      runtime: nonEmpty(candidate.runtime, 'candidate runtime'),
      sourceLockfileSha256: matching(candidate.sourceLockfileSha256, HASH, 'candidate lockfile SHA-256'),
      sourcePackageManifestSha256: matching(
        candidate.sourcePackageManifestSha256,
        HASH,
        'candidate package manifest SHA-256',
      ),
      target: matching(candidate.target, BUILD_TARGET, 'candidate build target'),
      testedCandidateExecutableSha256: matching(
        candidate.testedCandidateExecutableSha256,
        HASH,
        'tested candidate executable SHA-256',
      ),
      version: matching(candidate.version, DEVELOPMENT_VERSION, 'candidate development version'),
    },
    releaseTag: expectedReleaseTag,
    retainedBundle: {path: retainedBundlePath, sha256: retainedBundleSha256},
    scaleArtifact: {path: scaleArtifactPath, sha256: scaleArtifactSha256},
    type: CODE_MEMORY_LINK_RELEASE_DESCRIPTOR_TYPE,
    version: CODE_MEMORY_LINK_RELEASE_DESCRIPTOR_VERSION,
  };
  if (`${JSON.stringify(parsed, undefined, 2)}\n` !== input.source) {
    invalid('descriptor must use the canonical JSON encoding');
  }
  return parsed;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = EffectRecord.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || EffectArray.some(actual, (key, index) => key !== expected[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || Effect.pipe(value, EffectString.trim).length === 0) invalid(`${label} is invalid`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid(`${label} is invalid`);
  return Number(value);
}

function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link release descriptor: ${message}.`);
}
