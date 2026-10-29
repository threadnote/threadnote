import {Array as EffectArray} from 'effect';
import {credentialScrubberBlocker} from '@threadnote/platform/scrubber';
import type {BenchmarkArtifactV1, BenchmarkMeasurementV1} from './benchmark.js';
import {privacySafeExternalControlPath, privacySafeExternalControlQuery} from './public-controls.js';
import {Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const EXTERNAL_RELEASE_MINIMUM_SAMPLES = 25;
export const EXTERNAL_RELEASE_MINIMUM_WARMUPS = 5;

export const REVIEWED_PUBLIC_BENCHMARK_REPOSITORIES = ['JetBrains/intellij-community'] as const;

export const EXTERNAL_ACTIVATION_STAGES = [
  'validating-input',
  'copying-workspace',
  'copying-files',
  'copying-symbols',
  'copying-terms',
  'copying-edges',
  'copying-lookup-keys',
  'copying-reexports',
  'committing-snapshot',
  'checkpointing-snapshot',
  'recording-completion',
] as const;

const DIRECT_PERSISTENT_ACTIVATION_STAGES = [
  'validating-input',
  'recording-completion',
  'committing-snapshot',
] as const;

const INCREMENTAL_STAGED_ACTIVATION_STAGES = [
  'validating-input',
  'copying-workspace',
  'copying-files',
  'copying-symbols',
  'copying-terms',
  'copying-edges',
  'recording-completion',
  'committing-snapshot',
  'checkpointing-snapshot',
] as const;

const ACTIVATION_COPY_STAGES = EffectArray.filter(EXTERNAL_ACTIVATION_STAGES, stage =>
  Effect.pipe(stage, EffectString.startsWith('copying-')),
);

const SAMPLER_REQUIRED_MEASUREMENTS = EffectArray.flatMap(
  ['cold', 'one-file-reindex', 'same-overlay-reference'] as const,
  prefix => [
    {name: `${prefix}-external-sampler-version-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-storage-samples-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-process-tree-samples-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-process-tree-attempts-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-process-tree-failures-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-process-tree-maximum-sample-gap-n1`, unit: 'milliseconds'} as const,
    {name: `${prefix}-external-process-count-peak-observed-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-process-cpu-n1`, unit: 'milliseconds'} as const,
    {name: `${prefix}-external-rss-peak-observed-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-external-open-temp-process-tree-attempts-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-open-temp-process-tree-failures-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-open-temp-process-tree-samples-n1`, unit: 'count'} as const,
    {name: `${prefix}-external-sqlite-temp-combined-peak-observed-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-external-sqlite-temp-linked-peak-observed-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-external-sqlite-temp-open-process-tree-peak-observed-n1`, unit: 'bytes'} as const,
  ],
);

const ACTIVATION_REQUIRED_MEASUREMENTS = EffectArray.flatMap(['cold', 'one-file-reindex'] as const, prefix => [
  {name: `${prefix}-activation-observed-stages-n1`, unit: 'count'} as const,
  {name: `${prefix}-activation-longest-transaction-n1`, unit: 'milliseconds'} as const,
  {name: `${prefix}-maximum-progress-heartbeat-gap-n1`, unit: 'milliseconds'} as const,
  ...EffectArray.flatMap(EXTERNAL_ACTIVATION_STAGES, stage => [
    {name: `${prefix}-activation-${stage}-observed-n1`, unit: 'count'} as const,
    {name: `${prefix}-activation-${stage}-duration-n1`, unit: 'milliseconds'} as const,
    {name: `${prefix}-activation-${stage}-rows-n1`, unit: 'count'} as const,
  ]),
]);

export const INVENTORY_TIMING_REQUIRED_MEASUREMENTS = EffectArray.flatMap(
  ['cold', 'one-file-reindex', 'same-overlay-reference'] as const,
  prefix => [
    {name: `${prefix}-inventory-source-reading-n1`, unit: 'milliseconds'} as const,
    {name: `${prefix}-inventory-parser-extraction-summed-n1`, unit: 'milliseconds'} as const,
    {name: `${prefix}-inventory-cache-persistence-n1`, unit: 'milliseconds'} as const,
    {name: `${prefix}-inventory-parser-fact-serialization-n1`, unit: 'milliseconds'} as const,
  ],
);

const MATERIALIZATION_SUBPHASE_MEASUREMENT_NAMES = [
  'attribution-compute',
  'fact-batch-preparation',
  'shard-association',
  'shard-persistence',
  'shard-serialization',
] as const;

export const MATERIALIZATION_SUBPHASE_REQUIRED_MEASUREMENTS = EffectArray.flatMap(
  ['cold', 'same-overlay-reference'] as const,
  prefix =>
    EffectArray.map(
      MATERIALIZATION_SUBPHASE_MEASUREMENT_NAMES,
      subphase => ({name: `${prefix}-materialization-subphase-${subphase}-n1`, unit: 'milliseconds'}) as const,
    ),
);

const CORE_REQUIRED_MEASUREMENTS = [
  {name: 'cold-materialization', unit: 'milliseconds'},
  {name: 'cold-materialization-process-cpu-n1', unit: 'milliseconds'},
  {name: 'cold-materialization-boundary-rss-n1', unit: 'bytes'},
  {name: 'cold-materialized-file-rows', unit: 'count'},
  {name: 'cold-materialized-symbol-rows', unit: 'count'},
  {name: 'cold-materialized-edge-rows', unit: 'count'},
  {name: 'cold-materialized-lexical-term-rows', unit: 'count'},
  {name: 'one-file-reindex-materialization', unit: 'milliseconds'},
  {name: 'one-file-reindex-materialization-process-cpu-n1', unit: 'milliseconds'},
  {name: 'one-file-reindex-materialization-boundary-rss-n1', unit: 'bytes'},
  {name: 'one-file-reindex-materialization-staged-files', unit: 'count'},
  {name: 'one-file-reindex-materialization-total-files', unit: 'count'},
  {name: 'cold-primary-query-returned-nodes', unit: 'count'},
  {name: 'one-file-reindex-primary-query-returned-nodes', unit: 'count'},
  {name: 'same-overlay-full-rebuild-index', unit: 'milliseconds'},
  {name: 'same-overlay-full-rebuild-primary-query-returned-nodes', unit: 'count'},
  {name: 'primary-query-structural-parity', unit: 'count'},
  {name: 'structural-graph-digest-parity', unit: 'count'},
  {name: 'cold-sqlite-temp-database-pages-high-water-n1', unit: 'bytes'},
  {name: 'cold-sqlite-durable-database-pages-high-water-n1', unit: 'bytes'},
  {name: 'cold-materialization-cached-fact-bytes-total-n1', unit: 'bytes'},
  {name: 'cold-materialization-estimated-temp-filesystem-required-n1', unit: 'bytes'},
  {name: 'cold-materialization-estimated-durable-filesystem-required-n1', unit: 'bytes'},
  {name: 'cold-materialization-temp-filesystem-available-n1', unit: 'bytes'},
  {name: 'cold-materialization-durable-filesystem-available-n1', unit: 'bytes'},
  {name: 'cold-materialization-filesystems-shared-n1', unit: 'count'},
  {name: 'cold-materialization-deduplicated-edge-rows-n1', unit: 'count'},
  {name: 'cold-materialization-deduplicated-reference-rows-n1', unit: 'count'},
  {name: 'one-file-reindex-sqlite-temp-database-pages-high-water-n1', unit: 'bytes'},
  {name: 'one-file-reindex-materialization-deduplicated-edge-rows-n1', unit: 'count'},
  {name: 'one-file-reindex-materialization-deduplicated-reference-rows-n1', unit: 'count'},
  {name: 'cold-language-category-count', unit: 'count'},
  {name: 'cold-workspace-scope-rows', unit: 'count'},
  {name: 'cold-workspace-component-rows', unit: 'count'},
  {name: 'cold-bazel-workspace-scope-rows', unit: 'count'},
  {name: 'cold-bazel-workspace-component-rows', unit: 'count'},
  {name: 'manager-catalog-cold', unit: 'milliseconds'},
  {name: 'manager-catalog-warm', unit: 'milliseconds'},
  {name: 'manager-overview-cold', unit: 'milliseconds'},
  {name: 'manager-overview-warm', unit: 'milliseconds'},
  {name: 'manager-detail-cold', unit: 'milliseconds'},
  {name: 'manager-node-detail-cold', unit: 'milliseconds'},
  {name: 'manager-layout-preparation-proxy', unit: 'milliseconds'},
  {name: 'manager-response-payload', unit: 'bytes'},
  {name: 'manager-bounded-query', unit: 'milliseconds'},
  {name: 'manager-bounded-query-payload', unit: 'bytes'},
  {name: 'manager-overview-node-count', unit: 'count'},
  {name: 'manager-overview-edge-count', unit: 'count'},
  {name: 'manager-detail-node-count', unit: 'count'},
  {name: 'manager-detail-edge-count', unit: 'count'},
  {name: 'concurrent-worktree-isolation-duration', unit: 'milliseconds'},
  {name: 'cold-sqlite-durable-database-growth', unit: 'bytes'},
  {name: 'cold-durable-filesystem-growth', unit: 'bytes'},
  {name: 'cold-sqlite-journal-peak-observed', unit: 'bytes'},
  {name: 'cold-sqlite-wal-peak-observed', unit: 'bytes'},
  ...INVENTORY_TIMING_REQUIRED_MEASUREMENTS,
  ...MATERIALIZATION_SUBPHASE_REQUIRED_MEASUREMENTS,
  ...SAMPLER_REQUIRED_MEASUREMENTS,
  ...ACTIVATION_REQUIRED_MEASUREMENTS,
] as const;

export const EXTERNAL_REPOSITORY_REQUIRED_MEASUREMENTS = CORE_REQUIRED_MEASUREMENTS;

export const RELEASE_EVIDENCE_HARNESS_DELTA_PATHS = [
  'scripts/benchmark-code-graph.ts',
  'apps/website/tools/site-performance-evidence.ts',
  'packages/evidence/src/external-evidence.ts',
  // Historical layouts remain valid for already-retained release evidence.
  'scripts/site-performance-evidence.ts',
  'src/evaluation/external_evidence.ts',
] as const;

const RELEASE_SITE_REQUIRED_MEASUREMENTS = [
  {name: 'cold-index', unit: 'milliseconds'},
  {name: 'cold-registration-lock-and-database-setup', unit: 'milliseconds'},
  {name: 'cold-inventory-and-extraction', unit: 'milliseconds'},
  {name: 'cold-reference-resolution', unit: 'milliseconds'},
  {name: 'cold-activation-lexical-only', unit: 'milliseconds'},
  {name: 'one-file-reindex-index', unit: 'milliseconds'},
  {name: 'hot-exact-lexical-query', unit: 'milliseconds'},
  {name: 'cold-materialized-reference-candidate-rows-n1', unit: 'count'},
  {name: 'cold-materialized-lookup-key-rows-n1', unit: 'count'},
  {name: 'sqlite-main-disk', unit: 'bytes'},
  {name: 'cold-process-peak-rss', unit: 'bytes'},
  {name: 'cold-sqlite-wal-peak-observed', unit: 'bytes'},
  {name: 'cold-sqlite-temp-peak-observed', unit: 'bytes'},
] as const;

export const EXTERNAL_PUBLIC_METADATA_KEYS = [
  'benchmarkDiskFilesystem',
  'benchmarkDiskMedium',
  'benchmarkInventoryEligibleFiles',
  'benchmarkInventoryExcludedFiles',
  'benchmarkLogicalCpuCount',
  'benchmarkMeasuredExecutionMode',
  'benchmarkMeasuredSourceCommit',
  'benchmarkMeasuredSourceLockfileSha256',
  'benchmarkMeasuredSourcePackageManifestSha256',
  'benchmarkGithubRunnerArchitecture',
  'benchmarkGithubRunnerEnvironment',
  'benchmarkGithubRunnerOperatingSystem',
  'benchmarkSourceValidationMode',
  'benchmarkValidatedManagedPayload',
  'benchmarkValidatedManagedDependencyInstallation',
  'benchmarkValidatedManagedExecutableSha256',
  'benchmarkValidatedManagedPayloadBytes',
  'benchmarkValidatedManagedPayloadFileCount',
  'benchmarkValidatedManagedPayloadManifestSha256',
  'benchmarkValidatedManagedProcessLeaseInspection',
  'benchmarkValidatedManagedReleaseMetadataSha256',
  'benchmarkValidatedManagedRuntime',
  'benchmarkValidatedManagedTarget',
  'benchmarkValidatedManagedVersion',
  'coldMaterializationStorageMode',
  'externalBenchmarkHomesRetained',
  'externalControlCount',
  'externalControlEvidence',
  'externalControlLanguages',
  'externalQueryControlTimeoutMilliseconds',
  'externalRepositoryCommit',
  'externalRepositoryMode',
  'externalRepositoryName',
  'externalRepositoryPublicVerification',
  'externalRepositoryUrl',
  'managerEdgeBudget',
  'managerLayoutPreparationMeasurement',
  'managerNodeBudget',
  'managerOverviewNodeCount',
  'managerOverviewEdgeCount',
  'managerDetailNodeCount',
  'managerDetailEdgeCount',
  'managerRequestCancellationPassed',
  'managerRequestLifecycleControl',
  'managerSequenceTimeoutMilliseconds',
  'managerServiceResponseTimingIncludesSerialization',
  'managerSnapshotBindingPassed',
  'managerStaleResponseRejectionPassed',
  'mcpOperationCount',
  'oneFileReindexMaterializationMode',
  'oneFileReindexMaterializationStorageMode',
  'releaseEvidenceRef',
  'releaseEvidenceHarnessCommit',
  'releaseEvidenceHarnessDeltaPaths',
  'releaseEvidenceResolvedSha',
  'releaseEvidenceSha',
  'releaseEvidenceSourceMode',
  'retrievalMode',
  'runnerClass',
  'runnerIdentity',
  'sameOverlayReferenceMaterializationMode',
  'sameOverlayReferenceMaterializationStorageMode',
  'simultaneousWorktrees',
  'sqliteVersion',
  'structuralGraphDigestCold',
  'structuralGraphDigestIncremental',
  'structuralGraphDigestSameOverlayReference',
  'worktreeIsolationCleanupPassed',
  'worktreeIsolationCommandTimeoutMilliseconds',
  'worktreeIsolationIndexedFiles',
  'worktreeIsolationOuterTimeoutMilliseconds',
  'worktreeIsolationPassed',
  'worktreeIsolationTopology',
] as const;

const EXTERNAL_PUBLIC_METADATA_KEY_SET = new Set<string>(EXTERNAL_PUBLIC_METADATA_KEYS);
const RELEASE_EVIDENCE_HARNESS_DELTA_PATH_SET = new Set<string>(RELEASE_EVIDENCE_HARNESS_DELTA_PATHS);
const EXACT_GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RELEASE_REF_PATTERN = /^refs\/tags\/v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:beta|rc)\.(0|[1-9]\d*))?)$/;
const SAFE_RUNNER_CLASS = /^(?:github-hosted-linux-(?:arm64|x64)|local-unclassified|other)$/;
const SAFE_RUNNER_IDENTITY = /^(?:local|runner-[0-9a-f]{16})$/;
const LOCAL_PATH_PATTERN =
  /(?:^|[\s"'`])(?:\/Users\/|\/home\/|\/mnt\/[a-z]\/Users\/|\/[a-z]\/Users\/|[A-Za-z]:[\\/]|\\\\)/i;
const INLINE_CREDENTIAL_PATTERN =
  /(?:ghp_|github_pat_|AKIA[0-9A-Z]{12,}|Bearer\s+\S+|(?:token|password|secret)\s*[:=]\s*\S+|https:\/\/[^/@\s:]+:[^/@\s]+@)/i;

export function releaseEvidenceVersionForRef(ref: string): string | undefined {
  const match = RELEASE_REF_PATTERN.exec(ref);
  if (!match) return undefined;
  const components = EffectArray.map(
    EffectArray.filter(match.slice(2), (component): component is string => component !== undefined),
    Number,
  );
  if (!EffectArray.every(components, Number.isSafeInteger) || Number(match[2]) < 4) return undefined;
  return match[1];
}

export interface PublicGitHubRepositoryEvidence {
  readonly name: string;
  readonly url: string;
}

export type ExternalRepositoryPublicVerification = 'anonymous-https-exact-commit-fetch';

export interface ExternalEvidenceValidationOptions {
  readonly expectedControlLanguages?: readonly string[];
  readonly managerEdgeBudget: number;
  readonly managerNodeBudget: number;
  readonly releaseBound?: boolean;
}

export function publicGitHubRepositoryEvidence(origin: string): PublicGitHubRepositoryEvidence {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('External benchmark repository origin must be a public GitHub HTTPS URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    Effect.pipe(parsed.hostname, EffectString.toLowerCase) !== 'github.com' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('External benchmark repository origin must be a public GitHub HTTPS URL.');
  }
  const components = EffectArray.filter(
    Effect.pipe(parsed.pathname, EffectString.replace(/\.git\/?$/, ''), EffectString.split('/')),
    Boolean,
  );
  if (
    components.length !== 2 ||
    EffectArray.some(components, component => !/^[A-Za-z0-9_.-]+$/.test(component)) ||
    EffectArray.some(components, component => component === '.' || component === '..')
  ) {
    throw new Error('External benchmark repository origin must identify one public GitHub owner/repository.');
  }
  const name = `${components[0]}/${components[1]}`;
  return {name, url: `https://github.com/${name}`};
}

export function isReviewedPublicBenchmarkRepository(repository: PublicGitHubRepositoryEvidence): boolean {
  return (REVIEWED_PUBLIC_BENCHMARK_REPOSITORIES as readonly string[]).includes(repository.name);
}

export function projectExternalEvidenceMetadata(
  metadata: Readonly<Record<string, boolean | number | string>>,
): Readonly<Record<string, boolean | number | string>> {
  const projected: Record<string, boolean | number | string> = {};
  for (const key of EXTERNAL_PUBLIC_METADATA_KEYS) {
    if (!(key in metadata)) continue;
    const value = metadata[key];
    if (
      (typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw new Error(`External benchmark metadata.${key} must be a finite primitive value.`);
    }
    projected[key] = value;
  }
  return projected;
}

export function validateExternalRepositoryEvidence(
  artifact: BenchmarkArtifactV1,
  options: ExternalEvidenceValidationOptions,
): void {
  const missing: string[] = [];
  if (artifact.suite !== 'code-graph-external-repository-v1') {
    throw new Error(`External repository evidence has the wrong suite: ${artifact.suite}.`);
  }
  assertExactArtifactShape(artifact);
  assertPublicMetadataShape(artifact.metadata);
  assertPrivacySafeArtifact(artifact);

  const measurements = measurementMap(artifact.measurements, missing);
  for (const required of CORE_REQUIRED_MEASUREMENTS) requireMeasurement(measurements, required, missing);
  if (options.releaseBound) {
    for (const required of RELEASE_SITE_REQUIRED_MEASUREMENTS) requireMeasurement(measurements, required, missing);
  }

  const metadata = artifact.metadata;
  if (metadata.oneFileReindexMaterializationMode !== 'incremental-overlay') {
    missing.push('one-file reindex incremental-overlay materialization mode');
  }
  if (metadata.coldMaterializationStorageMode !== 'direct-persistent') {
    missing.push('cold direct-persistent materialization storage mode');
  }
  if (metadata.sameOverlayReferenceMaterializationMode !== 'full') {
    missing.push('same-overlay full rebuild materialization mode');
  }
  const repositoryCommit = String(metadata.externalRepositoryCommit ?? '');
  if (!EXACT_GIT_COMMIT_PATTERN.test(repositoryCommit)) missing.push('exact external repository commit');
  if (!EXACT_GIT_COMMIT_PATTERN.test(artifact.environment.commit) || artifact.environment.dirty) {
    missing.push('clean exact Threadnote source commit');
  }
  if (artifact.environment.fixtureHash !== `external-code-graph-v1:${repositoryCommit}`) {
    missing.push('external fixture identity tied to its exact commit');
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(metadata.sqliteVersion ?? ''))) {
    missing.push('SQLite version');
  }
  requireMetadataString(metadata, 'benchmarkDiskFilesystem', missing, /^[a-z0-9._+-]{1,64}$/);
  requireMetadataLiteral(
    metadata,
    'benchmarkDiskMedium',
    ['rotational', 'solid-state', 'unknown', 'virtual-or-network'],
    missing,
  );
  for (const name of [
    'benchmarkInventoryEligibleFiles',
    'benchmarkLogicalCpuCount',
    'managerEdgeBudget',
    'managerNodeBudget',
    'simultaneousWorktrees',
    'externalQueryControlTimeoutMilliseconds',
    'managerSequenceTimeoutMilliseconds',
    'worktreeIsolationCommandTimeoutMilliseconds',
    'worktreeIsolationOuterTimeoutMilliseconds',
  ]) {
    requirePositiveInteger(metadata, name, missing);
  }
  requireNonNegativeInteger(metadata, 'benchmarkInventoryExcludedFiles', missing);
  requireMetadataLiteral(metadata, 'managerNodeBudget', [options.managerNodeBudget], missing);
  requireMetadataLiteral(metadata, 'managerEdgeBudget', [options.managerEdgeBudget], missing);
  if (metadata.managerSnapshotBindingPassed !== true) missing.push('Manager exact snapshot binding');
  if (metadata.managerRequestCancellationPassed !== true) missing.push('Manager superseded-request cancellation');
  if (metadata.managerStaleResponseRejectionPassed !== true) missing.push('Manager completed stale-response rejection');
  requireMetadataLiteral(metadata, 'managerServiceResponseTimingIncludesSerialization', [true], missing);
  requireMetadataLiteral(
    metadata,
    'managerLayoutPreparationMeasurement',
    ['client-side graph layout-preparation only; excludes browser and WebGL paint'],
    missing,
  );
  requireMetadataLiteral(
    metadata,
    'managerRequestLifecycleControl',
    [
      'real Manager queries through the GraphWorkspace request gate: superseding aborts an in-flight request; a completed late response is rejected',
    ],
    missing,
  );
  for (const name of ['managerOverviewNodeCount', 'managerDetailNodeCount'])
    requirePositiveInteger(metadata, name, missing);
  for (const name of ['managerOverviewEdgeCount', 'managerDetailEdgeCount'])
    requireNonNegativeInteger(metadata, name, missing);
  requireMetadataLiteral(metadata, 'mcpOperationCount', [6], missing);
  requireMetadataLiteral(metadata, 'retrievalMode', ['lexical-only'], missing);
  requireMetadataLiteral(metadata, 'worktreeIsolationPassed', [true], missing);
  requireMetadataLiteral(metadata, 'worktreeIsolationCleanupPassed', [true], missing);
  requireMetadataLiteral(
    metadata,
    'worktreeIsolationTopology',
    ['bounded-synthetic-linked-worktrees-in-measured-primary-home'],
    missing,
  );
  requireMetadataLiteral(metadata, 'worktreeIsolationIndexedFiles', [2], missing);
  if (typeof metadata.simultaneousWorktrees !== 'number' || metadata.simultaneousWorktrees < 2) {
    missing.push('at least two simultaneous worktrees');
  }

  validateRepositoryIdentity(metadata, Boolean(options.releaseBound), missing);
  const controlLanguages = externalControlLanguages(metadata);
  if (controlLanguages.length === 0) missing.push('external query control languages');
  if (metadata.externalControlCount !== controlLanguages.length) missing.push('external query control count');
  if (options.expectedControlLanguages && !sameSet(controlLanguages, options.expectedControlLanguages)) {
    missing.push(`exact ${EffectArray.join(options.expectedControlLanguages, ', ')} control set`);
  }
  validateControlEvidence(metadata, controlLanguages, missing);
  validateDeterministicParity(measurements, metadata, missing);
  validateSamplerEvidence(measurements, missing);
  validateActivationEvidence(measurements, metadata, missing);
  validateMcpEvidence(measurements, metadata, missing);
  validateLanguageControls(measurements, controlLanguages, missing);
  validateProvenance(artifact, Boolean(options.releaseBound), missing);
  validateDurableStorage(measurements, missing);
  if (options.releaseBound) validateReleaseSampling(artifact, measurements, missing);

  if (missing.length > 0) {
    throw new Error(`External repository evidence is incomplete: ${EffectArray.join([...new Set(missing)], ', ')}.`);
  }
}

function assertExactArtifactShape(artifact: BenchmarkArtifactV1): void {
  assertExactKeys(
    artifact,
    ['createdAt', 'environment', 'measurements', 'metadata', 'suite', 'version', 'warmups'],
    'root',
  );
  assertExactKeys(
    artifact.environment,
    [
      'architecture',
      'commit',
      'cpu',
      'dirty',
      'fixtureHash',
      'memoryBytes',
      'node',
      'operatingSystem',
      'packageManager',
      'runner',
      'runnerVersion',
    ],
    'environment',
  );
}

function assertExactKeys(value: object, expected: readonly string[], path: string): void {
  const actual = EffectRecord.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    EffectArray.some(actual, (key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`External benchmark ${path} has unknown or missing fields.`);
  }
}

function assertPublicMetadataShape(metadata: Readonly<Record<string, boolean | number | string>>): void {
  for (const [key, value] of EffectRecord.toEntries(metadata)) {
    if (!EXTERNAL_PUBLIC_METADATA_KEY_SET.has(key)) {
      throw new Error(`External benchmark metadata.${key} is not in the public allowlist.`);
    }
    if (
      (typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw new Error(`External benchmark metadata.${key} must be a finite primitive value.`);
    }
  }
}

function assertPrivacySafeArtifact(artifact: BenchmarkArtifactV1): void {
  for (const [path, value] of [
    // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
    ...EffectArray.filter(Object.entries(artifact.environment), ([, value]) => typeof value === 'string'),
    ...EffectArray.filter(EffectRecord.toEntries(artifact.metadata), ([, value]) => typeof value === 'string'),
  ] as readonly [string, string][]) {
    if (credentialScrubberBlocker(value) !== undefined || INLINE_CREDENTIAL_PATTERN.test(value)) {
      throw new Error(`External benchmark ${path} contains credential-like content.`);
    }
    if (LOCAL_PATH_PATTERN.test(value)) {
      throw new Error(`External benchmark ${path} contains a local filesystem path.`);
    }
  }
  if (!SAFE_RUNNER_CLASS.test(String(artifact.metadata.runnerClass ?? ''))) {
    throw new Error('External benchmark runnerClass must be a coarse privacy-safe class.');
  }
  if (!SAFE_RUNNER_IDENTITY.test(String(artifact.metadata.runnerIdentity ?? ''))) {
    throw new Error('External benchmark runnerIdentity must be a privacy-safe explicit identifier.');
  }
}

function measurementMap(
  input: readonly BenchmarkMeasurementV1[],
  missing: string[],
): ReadonlyMap<string, BenchmarkMeasurementV1> {
  const measurements = new Map<string, BenchmarkMeasurementV1>();
  for (const measurement of input) {
    if (measurements.has(measurement.name)) missing.push(`unique ${measurement.name} measurement`);
    measurements.set(measurement.name, measurement);
  }
  return measurements;
}

function requireMeasurement(
  measurements: ReadonlyMap<string, BenchmarkMeasurementV1>,
  required: Readonly<{name: string; unit: BenchmarkMeasurementV1['unit']}>,
  missing: string[],
): void {
  const measurement = measurements.get(required.name);
  if (!measurement || measurement.unit !== required.unit) missing.push(`${required.name} (${required.unit})`);
}

function requireMetadataString(
  metadata: BenchmarkArtifactV1['metadata'],
  name: string,
  missing: string[],
  pattern?: RegExp,
): void {
  const value = metadata[name];
  if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
    missing.push(`${name} metadata`);
  }
}

function requireMetadataLiteral(
  metadata: BenchmarkArtifactV1['metadata'],
  name: string,
  values: readonly (boolean | number | string)[],
  missing: string[],
): void {
  if (!values.includes(metadata[name])) missing.push(`${name} reviewed metadata`);
}

function requirePositiveInteger(metadata: BenchmarkArtifactV1['metadata'], name: string, missing: string[]): void {
  const value = metadata[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    missing.push(`${name} positive integer metadata`);
  }
}

function requireNonNegativeInteger(metadata: BenchmarkArtifactV1['metadata'], name: string, missing: string[]): void {
  const value = metadata[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    missing.push(`${name} non-negative integer metadata`);
  }
}

function validateRepositoryIdentity(
  metadata: BenchmarkArtifactV1['metadata'],
  releaseBound: boolean,
  missing: string[],
): void {
  try {
    const repository = publicGitHubRepositoryEvidence(String(metadata.externalRepositoryUrl ?? ''));
    if (repository.name !== metadata.externalRepositoryName) throw new Error('name mismatch');
    const verification = metadata.externalRepositoryPublicVerification;
    if (verification !== 'anonymous-https-exact-commit-fetch') {
      throw new Error('public verification missing');
    }
    if (releaseBound && !isReviewedPublicBenchmarkRepository(repository)) throw new Error('repository is not reviewed');
  } catch {
    missing.push(
      releaseBound
        ? 'verified reviewed public GitHub repository identity'
        : 'verified public GitHub repository identity',
    );
  }
}

function externalControlLanguages(metadata: BenchmarkArtifactV1['metadata']): readonly string[] {
  const value = metadata.externalControlLanguages;
  if (typeof value !== 'string' || value.length === 0) return [];
  const languages = Effect.pipe(value, EffectString.split(','));
  return Boolean(EffectArray.some(languages, language => !/^[a-z][a-z0-9-]*$/.test(language))) ||
    new Set(languages).size !== languages.length
    ? []
    : languages;
}

function validateControlEvidence(
  metadata: BenchmarkArtifactV1['metadata'],
  languages: readonly string[],
  missing: string[],
): void {
  try {
    const parsed: unknown = JSON.parse(String(metadata.externalControlEvidence ?? ''));
    if (!Predicate.isObject(parsed)) throw new Error('invalid controls');
    const evidence = parsed;
    const expectedKeys = EffectArray.map(languages, language =>
      language === 'bazel-build' ? 'bazel' : language,
    ).sort();
    if (!sameSet(EffectRecord.keys(evidence), expectedKeys)) throw new Error('control count mismatch');
    for (const key of expectedKeys) {
      const value = evidence[key];
      if (!Predicate.isObject(value)) throw new Error('invalid control');
      assertExactKeys(value, ['path', 'query', 'stableNodeId'], 'control');
      const control = value;
      if (typeof control.query !== 'string' || privacySafeExternalControlQuery(control.query) !== control.query) {
        throw new Error('invalid query');
      }
      if (typeof control.path !== 'string' || privacySafeExternalControlPath(control.path) !== control.path) {
        throw new Error('invalid path');
      }
      if (typeof control.stableNodeId !== 'string' || !/^cgs_[0-9a-f]{32,64}$/.test(control.stableNodeId)) {
        throw new Error('invalid stable node id');
      }
    }
  } catch {
    missing.push('privacy-safe external control evidence matching declared languages');
  }
}

function validateDeterministicParity(
  measurements: ReadonlyMap<string, BenchmarkMeasurementV1>,
  metadata: BenchmarkArtifactV1['metadata'],
  missing: string[],
): void {
  for (const name of [
    'cold-primary-query-returned-nodes',
    'one-file-reindex-primary-query-returned-nodes',
    'same-overlay-full-rebuild-primary-query-returned-nodes',
    'primary-query-structural-parity',
    'structural-graph-digest-parity',
  ]) {
    if ((measurements.get(name)?.minimum ?? 0) < 1) missing.push(`${name} positive result`);
  }
  const digests = [
    metadata.structuralGraphDigestCold,
    metadata.structuralGraphDigestIncremental,
    metadata.structuralGraphDigestSameOverlayReference,
  ];
  if (!EffectArray.every(digests, value => typeof value === 'string' && SHA256_PATTERN.test(value))) {
    missing.push('three structural graph SHA-256 digests');
  }
  if (digests[1] !== digests[2]) missing.push('incremental and independent overlay digest parity');
}

function validateSamplerEvidence(measurements: ReadonlyMap<string, BenchmarkMeasurementV1>, missing: string[]): void {
  for (const prefix of ['cold', 'one-file-reindex', 'same-overlay-reference'] as const) {
    for (const name of [
      `${prefix}-external-storage-samples-n1`,
      `${prefix}-external-process-tree-samples-n1`,
      `${prefix}-external-process-tree-attempts-n1`,
      `${prefix}-external-process-count-peak-observed-n1`,
      `${prefix}-external-rss-peak-observed-n1`,
      `${prefix}-external-open-temp-process-tree-attempts-n1`,
      `${prefix}-external-open-temp-process-tree-samples-n1`,
    ]) {
      if ((measurements.get(name)?.minimum ?? 0) < 1) missing.push(`${name} positive result`);
    }
    if ((measurements.get(`${prefix}-external-sampler-version-n1`)?.minimum ?? 0) < 4) {
      missing.push(`${prefix}-external-sampler-version-n1 expected sampler v4 or newer`);
    }
    for (const name of [
      `${prefix}-external-process-tree-failures-n1`,
      `${prefix}-external-open-temp-process-tree-failures-n1`,
    ]) {
      if (measurements.get(name)?.maximum !== 0) missing.push(`${name} expected zero inspection loss`);
    }
    if (!measurements.has(`${prefix}-external-process-tree-maximum-sample-gap-n1`)) {
      missing.push(`${prefix}-external-process-tree-maximum-sample-gap-n1 observed result`);
    }
  }
}

function validateActivationEvidence(
  measurements: ReadonlyMap<string, BenchmarkMeasurementV1>,
  metadata: BenchmarkArtifactV1['metadata'],
  missing: string[],
): void {
  for (const prefix of ['cold', 'one-file-reindex'] as const) {
    const storageMode =
      prefix === 'cold' ? metadata.coldMaterializationStorageMode : metadata.oneFileReindexMaterializationStorageMode;
    const expectedStages =
      storageMode === 'direct-persistent'
        ? DIRECT_PERSISTENT_ACTIVATION_STAGES
        : prefix === 'cold'
          ? EXTERNAL_ACTIVATION_STAGES
          : storageMode === 'temporary-staged'
            ? INCREMENTAL_STAGED_ACTIVATION_STAGES
            : DIRECT_PERSISTENT_ACTIVATION_STAGES;
    if ((measurements.get(`${prefix}-activation-observed-stages-n1`)?.minimum ?? 0) < expectedStages.length) {
      missing.push(`${prefix}-activation-observed-stages-n1 expected at least ${expectedStages.length} real stages`);
    }
    for (const stage of expectedStages) {
      const name = `${prefix}-activation-${stage}-observed-n1`;
      if ((measurements.get(name)?.minimum ?? 0) < 1) missing.push(`${name} positive result`);
    }
  }
  if (metadata.coldMaterializationStorageMode === 'direct-persistent') {
    if ((measurements.get('cold-sqlite-durable-database-pages-high-water-n1')?.minimum ?? 0) < 1) {
      missing.push('cold-sqlite-durable-database-pages-high-water-n1 positive result');
    }
    for (const stage of ACTIVATION_COPY_STAGES) {
      const name = `cold-activation-${stage}-observed-n1`;
      if (measurements.get(name)?.maximum !== 0)
        missing.push(`${name} expected zero direct-persistent activation copies`);
    }
  }
}

function validateMcpEvidence(
  measurements: ReadonlyMap<string, BenchmarkMeasurementV1>,
  metadata: BenchmarkArtifactV1['metadata'],
  missing: string[],
): void {
  if (metadata.mcpOperationCount !== 6) missing.push('complete six-operation MCP matrix');
  for (const operation of ['query', 'node', 'neighbors', 'explain', 'impact', 'path'] as const) {
    const duration = measurements.get(`mcp-${operation}-duration`);
    if (!duration || duration.unit !== 'milliseconds' || duration.maximum <= 0 || duration.maximum > 25_000) {
      missing.push(`mcp-${operation}-duration positive and within 25 seconds`);
    }
    for (const part of ['structured', 'text'] as const) {
      const output = measurements.get(`mcp-${operation}-${part}-output`);
      if (!output || output.unit !== 'bytes' || output.minimum < 1 || output.maximum > 24 * 1_024) {
        missing.push(`mcp-${operation}-${part}-output within 24 KiB`);
      }
    }
  }
}

function validateLanguageControls(
  measurements: ReadonlyMap<string, BenchmarkMeasurementV1>,
  languages: readonly string[],
  missing: string[],
): void {
  for (const language of languages) {
    const duration = measurements.get(`external-query-cold-${language}-duration`);
    if (!duration || duration.unit !== 'milliseconds' || duration.maximum <= 0) {
      missing.push(`external-query-cold-${language}-duration positive result`);
    }
    for (const name of [
      `cold-materialized-file-rows-language-${language}`,
      `cold-materialized-symbol-rows-language-${language}`,
      `external-query-cold-${language}-returned-nodes`,
      `external-query-cold-${language}-expected-path-language-nodes`,
      `external-query-incremental-${language}-returned-nodes`,
      `external-query-incremental-${language}-expected-path-language-nodes`,
      `external-query-same-overlay-reference-${language}-returned-nodes`,
      `external-query-same-overlay-reference-${language}-expected-path-language-nodes`,
      `external-query-${language}-same-overlay-structural-parity`,
    ]) {
      if ((measurements.get(name)?.minimum ?? 0) < 1) missing.push(`${name} positive result`);
    }
  }
  if (languages.includes('bazel-build')) {
    for (const name of ['cold-bazel-workspace-scope-rows', 'cold-bazel-workspace-component-rows']) {
      if ((measurements.get(name)?.minimum ?? 0) < 1) missing.push(`${name} positive result`);
    }
  }
}

function validateProvenance(artifact: BenchmarkArtifactV1, releaseBound: boolean, missing: string[]): void {
  const metadata = artifact.metadata;
  const releaseRef = metadata.releaseEvidenceRef;
  const releaseVersion = typeof releaseRef === 'string' ? releaseEvidenceVersionForRef(releaseRef) : undefined;
  const managedVersion = metadata.benchmarkValidatedManagedVersion;
  const managedVersionMatchesCommit =
    typeof managedVersion === 'string' &&
    (Effect.pipe(managedVersion, EffectString.endsWith(`-local.g${artifact.environment.commit}`)) ||
      Effect.pipe(managedVersion, EffectString.endsWith(`.local.g${artifact.environment.commit}`)));
  if (
    metadata.benchmarkMeasuredExecutionMode !== 'local-source-application-layer' ||
    metadata.benchmarkMeasuredSourceCommit !== artifact.environment.commit ||
    !EXACT_GIT_COMMIT_PATTERN.test(String(metadata.benchmarkMeasuredSourceCommit ?? '')) ||
    !SHA256_PATTERN.test(String(metadata.benchmarkMeasuredSourceLockfileSha256 ?? '')) ||
    !SHA256_PATTERN.test(String(metadata.benchmarkMeasuredSourcePackageManifestSha256 ?? ''))
  ) {
    missing.push('clean measured local-source ApplicationLayer provenance');
  }
  const mode = metadata.benchmarkSourceValidationMode;
  if (mode === 'github-actions-clean-source') {
    if (
      metadata.benchmarkValidatedManagedPayload !== 'not-applicable-github-actions-clean-source' ||
      (metadata.benchmarkGithubRunnerEnvironment !== 'github-hosted' &&
        metadata.benchmarkGithubRunnerEnvironment !== 'self-hosted') ||
      (metadata.benchmarkGithubRunnerArchitecture !== 'ARM64' &&
        metadata.benchmarkGithubRunnerArchitecture !== 'X64') ||
      (metadata.benchmarkGithubRunnerOperatingSystem !== 'Linux' &&
        metadata.benchmarkGithubRunnerOperatingSystem !== 'macOS' &&
        metadata.benchmarkGithubRunnerOperatingSystem !== 'Windows')
    ) {
      missing.push('GitHub Actions source-only validation and runner disclosure');
    }
  } else if (mode === 'managed-payload-exact-head-validated') {
    if (
      metadata.benchmarkValidatedManagedPayload !== 'exact-head-not-executed' ||
      metadata.benchmarkValidatedManagedDependencyInstallation !== 'bun install --frozen-lockfile' ||
      metadata.benchmarkValidatedManagedProcessLeaseInspection !== 'complete' ||
      !SHA256_PATTERN.test(String(metadata.benchmarkValidatedManagedExecutableSha256 ?? '')) ||
      !SHA256_PATTERN.test(String(metadata.benchmarkValidatedManagedPayloadManifestSha256 ?? '')) ||
      !SHA256_PATTERN.test(String(metadata.benchmarkValidatedManagedReleaseMetadataSha256 ?? '')) ||
      !isPositiveInteger(metadata.benchmarkValidatedManagedPayloadBytes) ||
      !isPositiveInteger(metadata.benchmarkValidatedManagedPayloadFileCount) ||
      typeof metadata.benchmarkValidatedManagedRuntime !== 'string' ||
      metadata.benchmarkValidatedManagedRuntime.length === 0 ||
      typeof metadata.benchmarkValidatedManagedTarget !== 'string' ||
      metadata.benchmarkValidatedManagedTarget.length === 0 ||
      !managedVersionMatchesCommit
    ) {
      missing.push('complete separately validated exact-HEAD managed payload provenance');
    }
  } else {
    missing.push('reviewed source validation mode');
  }
  if (releaseBound && mode !== 'managed-payload-exact-head-validated') {
    missing.push('release evidence with separately validated managed exact-HEAD payload');
  }
  if (releaseBound) {
    const sha = metadata.releaseEvidenceSha;
    const sourceMode = metadata.releaseEvidenceSourceMode;
    const harnessCommit = metadata.releaseEvidenceHarnessCommit;
    const harnessDeltaPaths = metadata.releaseEvidenceHarnessDeltaPaths;
    let parsedHarnessDeltaPaths: readonly string[] = [];
    try {
      const parsed = JSON.parse(String(harnessDeltaPaths ?? '[]'));
      if (EffectArray.isArray(parsed) && EffectArray.every(parsed, path => typeof path === 'string'))
        parsedHarnessDeltaPaths = parsed;
    } catch {
      // Report invalid release provenance through the shared missing-evidence path below.
    }
    const canonicalHarnessDelta =
      parsedHarnessDeltaPaths.length > 0 &&
      new Set(parsedHarnessDeltaPaths).size === parsedHarnessDeltaPaths.length &&
      EffectArray.every(parsedHarnessDeltaPaths, path => RELEASE_EVIDENCE_HARNESS_DELTA_PATH_SET.has(path)) &&
      JSON.stringify([...parsedHarnessDeltaPaths].sort()) === JSON.stringify(parsedHarnessDeltaPaths);
    const sourceModeValid =
      (sourceMode === 'exact-release' &&
        harnessCommit === sha &&
        artifact.environment.commit === sha &&
        harnessDeltaPaths === '[]') ||
      (sourceMode === 'release-plus-reviewed-harness-delta' &&
        typeof harnessCommit === 'string' &&
        EXACT_GIT_COMMIT_PATTERN.test(harnessCommit) &&
        harnessCommit === artifact.environment.commit &&
        harnessCommit !== sha &&
        canonicalHarnessDelta);
    if (
      releaseVersion === undefined ||
      (managedVersion !== `${releaseVersion}-local.g${artifact.environment.commit}` &&
        managedVersion !== `${releaseVersion}.local.g${artifact.environment.commit}`) ||
      typeof sha !== 'string' ||
      !EXACT_GIT_COMMIT_PATTERN.test(sha) ||
      metadata.releaseEvidenceResolvedSha !== sha ||
      !sourceModeValid ||
      artifact.environment.dirty
    ) {
      missing.push('clean exact release source provenance');
    }
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validateDurableStorage(measurements: ReadonlyMap<string, BenchmarkMeasurementV1>, missing: string[]): void {
  for (const name of ['cold-sqlite-durable-database-growth', 'cold-durable-filesystem-growth']) {
    const measurement = measurements.get(name);
    if (!measurement || measurement.unit !== 'bytes' || measurement.minimum <= 0) {
      missing.push(`${name} positive measured growth`);
    }
  }
  for (const name of ['cold-sqlite-wal-peak-observed', 'cold-sqlite-journal-peak-observed']) {
    const measurement = measurements.get(name);
    if (!measurement || measurement.unit !== 'bytes' || measurement.minimum < 0) {
      missing.push(`${name} measured high-water`);
    }
  }
}

function validateReleaseSampling(
  artifact: BenchmarkArtifactV1,
  measurements: ReadonlyMap<string, BenchmarkMeasurementV1>,
  missing: string[],
): void {
  if (!Number.isInteger(artifact.warmups) || artifact.warmups < EXTERNAL_RELEASE_MINIMUM_WARMUPS) {
    missing.push(`at least ${EXTERNAL_RELEASE_MINIMUM_WARMUPS} release warmups`);
  }
  for (const name of ['hot-exact-lexical-query', 'manager-bounded-query']) {
    const measurement = measurements.get(name);
    if (!measurement || measurement.samples < EXTERNAL_RELEASE_MINIMUM_SAMPLES) {
      missing.push(`${name} at least ${EXTERNAL_RELEASE_MINIMUM_SAMPLES} samples before p95 publication`);
    }
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    EffectArray.every([...left].sort(), (value, index) => value === [...right].sort()[index])
  );
}
