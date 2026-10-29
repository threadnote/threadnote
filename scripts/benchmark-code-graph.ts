import {Array as EffectArray} from 'effect';
import {BenchmarkLeaseTrace} from './benchmark-lease-trace.js';
import {provideScriptLayer, scriptError, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {
  Clock,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Schema,
  Tracer,
} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {readCodeGraphBuildStatuses} from '@threadnote/graph/build_status';
import {CodeGraphIndexer, type CodeGraphIndexOptions} from '@threadnote/graph/indexer';
import {CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM} from '@threadnote/graph/materialized_shard_cache_admission';
import {
  codeGraphEffectiveSymbolTermsQueryStatement,
  codeGraphSymbolPathScoreMultiplier,
  CodeGraphStore,
  type CodeGraphSqliteWriterSettings,
  type CodeGraphSqliteWriterTuning,
} from '@threadnote/graph/store';
import {
  CodeGraphAnalysis,
  type CodeGraphAnalysisOptions,
  type CodeGraphAnalysisResult,
} from '@threadnote/graph/analysis';
import {codeGraphAnalysisLimitsForView} from '@threadnote/graph/analysis/render';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {parserWorkerCapacity} from '@threadnote/graph/parser_worker';
import {
  CodeGraphQueryService,
  observationFromCodeGraphStatus,
  type CodeGraphInspectOptions,
  type CodeGraphStatusOptions,
} from '@threadnote/graph/query';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import type {
  CodeGraphActivationActivity,
  CodeGraphMaterializationSubphaseMilliseconds,
  CodeGraphProgress,
  CodeGraphQueryResult,
  CodeGraphStatus,
} from '@threadnote/graph/types';
import {
  managerGraphCatalog,
  ManagerGraphBusyError,
  ManagerGraphQueryLifecycle,
  managerGraphNodeDetail,
  managerGraphQuery,
  managerGraphVisualization,
} from '@threadnote/graph/visualization';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256FileHex} from '@threadnote/platform/digest';
import {ApplicationLayer, type ApplicationServices} from '@threadnote/threadnote/effect/runtime';
import {
  THREADNOTE_EMBEDDING_CONTEXTS_ENV,
  type EmbeddingContextPoolSize,
} from '@threadnote/inference/engine/node-llama-cpp';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {
  processResourceUsageMaxRssBytes,
  SystemInfo,
  type ProcessResourceUsageRuntime,
} from '@threadnote/platform/system';
import {CORE_EMBEDDING_MODEL_ID} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {codeGraphInspectionObservesWorktree, codeGraphMcpResponse} from '@threadnote/threadnote/mcp/server/index';
import {
  createGraphQueryRequestGate,
  managerGraphClientRenderProxy,
  type GraphQueryVisualization,
  type GraphVisualization,
} from '@threadnote/manager/graph';
import {MANAGER_GRAPH_MAX_EDGE_LIMIT, MANAGER_GRAPH_MAX_NODE_LIMIT} from '@threadnote/graph/visualization/limits';
import {
  BENCHMARK_ARTIFACT_VERSION,
  benchmarkMeasurement,
  parseBenchmarkArtifactV1,
  type BenchmarkArtifactV1,
} from '@threadnote/evidence/benchmark';
import {
  EXTERNAL_REPOSITORY_REQUIRED_MEASUREMENTS,
  INVENTORY_TIMING_REQUIRED_MEASUREMENTS,
  MATERIALIZATION_SUBPHASE_REQUIRED_MEASUREMENTS,
  RELEASE_EVIDENCE_HARNESS_DELTA_PATHS,
  isReviewedPublicBenchmarkRepository,
  projectExternalEvidenceMetadata,
  releaseEvidenceVersionForRef,
  validateExternalRepositoryEvidence,
  type ExternalRepositoryPublicVerification,
} from '@threadnote/evidence/external-evidence';
import {privacySafeExternalControlPath, privacySafeExternalControlQuery} from '@threadnote/evidence/public-controls';
import {
  codeGraphEvaluationFixtureHash,
  parseCodeGraphEvaluationFixtureV1,
} from '@threadnote/threadnote/evaluation/code-graph';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import {
  GENERATED_VECTOR_CONTROL_PATH,
  PRODUCTION_LARGE_CODE_GRAPH_PROFILE,
  PRODUCTION_WORKTREE_CHURN_SCENARIOS,
  VECTOR_SEMANTIC_CONTROL_QUERY,
  generatedSymbolName,
  makeOwnedTempDirectoryScoped,
  prepareCodeGraphFixture,
  prepareGeneratedCodeGraphFixture,
  prepareProductionCodeGraphFixture,
  productionEligibleFileCount,
  productionExcludedByteDistribution,
  productionRepositoryFileCount,
  validateProductionProfile,
  type ProductionCodeGraphFixtureProfile,
} from './code-graph-fixture.js';
import {
  parseCodeGraphBenchmarkSamplerArtifact,
  type CodeGraphBenchmarkSamplerArtifact,
} from './code-graph-benchmark-sampler.js';
import {
  verifyManagedDevelopmentRuntimeForSourceCheckout,
  type DevelopmentRuntimeEvidence,
} from './development-runtime.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const EXTERNAL_SAMPLER_READY_TIMEOUT_MS = 5_000;
const EXTERNAL_SAMPLER_STOP_TIMEOUT_MS = 5_000;
const EXTERNAL_SAMPLER_TERMINATE_TIMEOUT_MS = 1_000;
const STRUCTURAL_DIGEST_SNAPSHOT_LEASE_MILLISECONDS = 60 * 60_000;
const STRUCTURAL_DIGEST_SNAPSHOT_LEASE_RENEWAL_MILLISECONDS = 5 * 60_000;
const STRUCTURAL_DIGEST_ROW_CHUNK_SIZE = 10_000;
const LONG_SCALE_PROVENANCE_THRESHOLD = 100_000;
const EXACT_GIT_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PERFORMANCE_CONTROL_LANGUAGES = ['java', 'kotlin', 'typescript', 'bazel-build'] as const;
const MANAGER_QUERY_NODE_LIMIT = 200;
const VECTOR_SEMANTIC_CONTROL_RAW_SCORE_MINIMUM = 0.64;
const BENCHMARK_VECTOR_MODEL_DIRECTORY_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

export function vectorSemanticControlMinimumScore(expectedPath: string): number {
  return VECTOR_SEMANTIC_CONTROL_RAW_SCORE_MINIMUM * codeGraphSymbolPathScoreMultiplier(expectedPath, []);
}

export function benchmarkVectorModelDirectoryName(name: string): boolean {
  return BENCHMARK_VECTOR_MODEL_DIRECTORY_NAME.test(name);
}

const MANAGER_QUERY_EDGE_LIMIT = 500;
const EXTERNAL_QUERY_CONTROL_TIMEOUT_MS = 120_000;
const MANAGER_SEQUENCE_TIMEOUT_MS = 180_000;
const MANAGER_BUSY_RETRY_MILLISECONDS = 100;
const MANAGER_BUSY_RETRY_ATTEMPTS = 20;
const WORKTREE_GIT_COMMAND_TIMEOUT_MS = 30_000;
const WORKTREE_ISOLATION_TIMEOUT_MS = 300_000;
const PUBLIC_REPOSITORY_PROOF_TIMEOUT_MS = 60_000;
const TEST_PUBLIC_REPOSITORY_REMOTE_ENV = 'THREADNOTE_BENCHMARK_TEST_PUBLIC_REPOSITORY_REMOTE';
export const PRODUCTION_LARGE_TARGET_ATTAINMENT_MINIMUM_PERCENT = 90;
const CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'status.showUntrackedFiles=all',
  '-c',
  'diff.ignoreSubmodules=none',
  'status',
  '--porcelain=v1',
  '--untracked-files=all',
  '--ignore-submodules=none',
  '--no-renames',
] as const;

const ACTIVATION_STAGES = [
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
] as const satisfies readonly CodeGraphActivationActivity['stage'][];

const MATERIALIZATION_STAGES = [
  'loading-cache',
  'attributing',
  'preparing-rows',
  'restoring-indexes',
  'writing-symbols',
  'writing-lookups',
  'writing-terms',
  'writing-edges',
  'writing-references',
  'writing-candidates',
  'writing-analysis',
  'writing-receipt',
  'committing',
] as const satisfies readonly NonNullable<
  Extract<CodeGraphProgress, {readonly phase: 'materializing'}>['activity']
>['stage'][];

const MATERIALIZATION_SUBPHASES = [
  ['attributionCompute', 'attribution-compute'],
  ['factBatchPreparation', 'fact-batch-preparation'],
  ['shardAssociation', 'shard-association'],
  ['shardPersistence', 'shard-persistence'],
  ['shardSerialization', 'shard-serialization'],
] as const satisfies readonly (readonly [keyof CodeGraphMaterializationSubphaseMilliseconds, string])[];

export const CODE_GRAPH_SQLITE_WRITER_PROFILES = {
  current: {
    description: 'Current 32 MiB writer cache and 4 MiB (500-page at 8 KiB) WAL auto-checkpoint.',
    tuning: {mainCacheKiB: 32 * 1_024, walAutoCheckpointPages: 500},
  },
  'cache-8m': {
    description: 'Isolates an 8 MiB writer page cache.',
    tuning: {mainCacheKiB: 8 * 1_024, walAutoCheckpointPages: 500},
  },
  'cache-32m': {
    description: 'Isolates a 32 MiB writer page cache.',
    tuning: {mainCacheKiB: 32 * 1_024, walAutoCheckpointPages: 500},
  },
  'cache-64m': {
    description: 'Isolates a 64 MiB writer page cache.',
    tuning: {mainCacheKiB: 64 * 1_024, walAutoCheckpointPages: 500},
  },
  'cache-128m': {
    description: 'Isolates a 128 MiB writer page cache.',
    tuning: {mainCacheKiB: 128 * 1_024, walAutoCheckpointPages: 500},
  },
  'cache-256m': {
    description: 'Isolates a 256 MiB writer page cache.',
    tuning: {mainCacheKiB: 256 * 1_024, walAutoCheckpointPages: 500},
  },
  'mmap-256m': {
    description: 'Isolates a 256 MiB main-database mmap window.',
    tuning: {mainCacheKiB: 32 * 1_024, mmapSizeBytes: 256 * 1_024 * 1_024, walAutoCheckpointPages: 500},
  },
  'wal-checkpoint-8192': {
    description: 'Isolates an 8,192-page passive WAL auto-checkpoint cadence.',
    tuning: {mainCacheKiB: 32 * 1_024, walAutoCheckpointPages: 8_192},
  },
  'building-normal-full-publication': {
    description: 'Uses NORMAL only for reconstructible full-build rows and restores FULL before publication.',
    tuning: {
      mainCacheKiB: 32 * 1_024,
      reconstructibleBuildSynchronous: 'normal',
      walAutoCheckpointPages: 500,
    },
  },
  'combined-candidate': {
    description: 'Combines the independently measured candidates; never a production default by itself.',
    tuning: {
      mainCacheKiB: 256 * 1_024,
      mmapSizeBytes: 256 * 1_024 * 1_024,
      reconstructibleBuildSynchronous: 'normal',
      walAutoCheckpointPages: 8_192,
    },
  },
} as const satisfies Readonly<
  Record<string, {readonly description: string; readonly tuning: CodeGraphSqliteWriterTuning}>
>;

export type CodeGraphSqliteWriterProfile = keyof typeof CODE_GRAPH_SQLITE_WRITER_PROFILES;

function isCodeGraphSqliteWriterProfile(value: string): value is CodeGraphSqliteWriterProfile {
  return EffectArray.some(EffectRecord.keys(CODE_GRAPH_SQLITE_WRITER_PROFILES), key => key === value);
}
type SqliteWriterBenchmarkPhase = 'cold' | 'one-file-reindex' | 'same-overlay-reference';
export type SqliteWriterSettingsEvidence = CodeGraphSqliteWriterSettings & {
  readonly benchmarkPhase: SqliteWriterBenchmarkPhase;
};

export function validateSqliteWriterSettingsEvidence(
  profile: CodeGraphSqliteWriterProfile,
  evidence: readonly SqliteWriterSettingsEvidence[],
): void {
  const requested: CodeGraphSqliteWriterTuning = CODE_GRAPH_SQLITE_WRITER_PROFILES[profile].tuning;
  for (const benchmarkPhase of ['cold', 'one-file-reindex', 'same-overlay-reference'] as const) {
    const phaseEvidence = EffectArray.filter(evidence, settings => settings.benchmarkPhase === benchmarkPhase);
    const connection = EffectArray.filter(phaseEvidence, settings => settings.phase === 'connection').at(-1);
    if (!connection || Effect2.pipe(connection.journalMode, EffectString.toLowerCase) !== 'wal') {
      throw ScriptError.make({
        message: `SQLite writer profile ${profile} did not report a WAL connection for ${benchmarkPhase}.`,
      });
    }
    if (requested.mainCacheKiB !== undefined && connection.cacheSizePragma !== -requested.mainCacheKiB) {
      throw ScriptError.make({
        message: `SQLite writer profile ${profile} did not apply its cache size for ${benchmarkPhase}.`,
      });
    }
    if (requested.mmapSizeBytes !== undefined && connection.mmapSizeBytes !== requested.mmapSizeBytes) {
      throw ScriptError.make({
        message: `SQLite writer profile ${profile} did not apply its mmap size for ${benchmarkPhase}.`,
      });
    }
    if (
      requested.walAutoCheckpointPages !== undefined &&
      connection.walAutoCheckpointPages !== requested.walAutoCheckpointPages
    ) {
      throw ScriptError.make({
        message: `SQLite writer profile ${profile} did not apply its WAL checkpoint cadence for ${benchmarkPhase}.`,
      });
    }
  }
  if (requested.reconstructibleBuildSynchronous === 'normal') {
    for (const benchmarkPhase of ['cold', 'same-overlay-reference'] as const) {
      const phaseEvidence = EffectArray.filter(evidence, settings => settings.benchmarkPhase === benchmarkPhase);
      const building = Option.getOrElse(
        EffectArray.findFirstIndex(
          phaseEvidence,
          settings => settings.phase === 'building' && settings.synchronous === 1,
        ),
        () => -1,
      );
      const publication = Option.getOrElse(
        EffectArray.findFirstIndex(
          phaseEvidence,
          (settings, index) => index > building && settings.phase === 'publication' && settings.synchronous === 2,
        ),
        () => -1,
      );
      if (building < 0 || publication < 0) {
        throw ScriptError.make({
          message: `SQLite writer profile ${profile} did not restore FULL after NORMAL before ${benchmarkPhase} publication.`,
        });
      }
    }
  }
}

const DIRECT_PERSISTENT_ACTIVATION_STAGES = [
  'validating-input',
  'recording-completion',
  'committing-snapshot',
] as const satisfies readonly CodeGraphActivationActivity['stage'][];

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
] as const satisfies readonly CodeGraphActivationActivity['stage'][];

const ACTIVATION_COPY_STAGES = EffectArray.filter(
  ACTIVATION_STAGES,
  __effectArrayValue => !!(stage => Effect2.pipe(stage, EffectString.startsWith('copying-')))(__effectArrayValue),
);

const RESOLUTION_TRANSACTION_STAGES = [
  ['preparingBatch', 'preparing-batch'],
  ['writingAliases', 'writing-aliases'],
  ['writingEdges', 'writing-edges'],
  ['updatingAnalysis', 'updating-analysis'],
  ['retiringReferences', 'retiring-references'],
] as const;

const ACTIVATION_RELEASE_EVIDENCE_MEASUREMENTS = EffectArray.flatMap(['cold', 'one-file-reindex'] as const, prefix => [
  {name: `${prefix}-activation-observed-stages-n1`, unit: 'count'} as const,
  {name: `${prefix}-activation-longest-transaction-n1`, unit: 'milliseconds'} as const,
  {name: `${prefix}-maximum-progress-heartbeat-gap-n1`, unit: 'milliseconds'} as const,
  ...EffectArray.flatMap(ACTIVATION_STAGES, stage => [
    {name: `${prefix}-activation-${stage}-observed-n1`, unit: 'count'} as const,
    {name: `${prefix}-activation-${stage}-duration-n1`, unit: 'milliseconds'} as const,
    {name: `${prefix}-activation-${stage}-rows-n1`, unit: 'count'} as const,
  ]),
]);

const SAMPLER_RELEASE_EVIDENCE_MEASUREMENTS = EffectArray.flatMap(
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

const MATERIALIZATION_REPLAY_RELEASE_EVIDENCE_MEASUREMENTS = EffectArray.flatMap(
  ['cold', 'same-overlay-reference'] as const,
  prefix => [
    {name: `${prefix}-materialization-attributed-files-n1`, unit: 'count'} as const,
    {name: `${prefix}-materialization-cached-fact-bytes-total-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-materialization-cached-fact-replay-bytes-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-materialization-changed-fact-bytes-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-materialization-cross-generation-shard-files-n1`, unit: 'count'} as const,
    {name: `${prefix}-materialization-exact-generation-shard-files-n1`, unit: 'count'} as const,
    {name: `${prefix}-materialization-materialized-shard-cache-deferred-files-n1`, unit: 'count'} as const,
    {
      name: `${prefix}-materialization-materialized-shard-cache-deferred-raw-fact-bytes-n1`,
      unit: 'bytes',
    } as const,
    {name: `${prefix}-materialization-materialized-shard-replay-bytes-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-materialization-raw-fact-replay-bytes-n1`, unit: 'bytes'} as const,
  ],
);

const MATERIALIZATION_QUERY_INDEX_RESTORATION_RELEASE_EVIDENCE_MEASUREMENTS = [
  {name: 'cold-materialization-stage-restoring-indexes-n1', unit: 'milliseconds'},
  {name: 'same-overlay-reference-materialization-stage-restoring-indexes-n1', unit: 'milliseconds'},
  {name: 'one-file-reindex-materialization-stage-restoring-indexes-n1', unit: 'milliseconds'},
] as const;

const MATERIALIZATION_STORAGE_HIGH_WATER_RELEASE_EVIDENCE_MEASUREMENTS = [
  ...EffectArray.flatMap(['cold', 'one-file-reindex', 'same-overlay-reference'] as const, prefix => [
    {name: `${prefix}-materialization-durable-database-growth-high-water-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-materialization-durable-filesystem-high-water-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-materialization-durable-journal-high-water-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-materialization-durable-wal-high-water-n1`, unit: 'bytes'} as const,
  ]),
  ...EffectArray.flatMap(['cold', 'same-overlay-reference'] as const, prefix => [
    {name: `${prefix}-materialization-sidecar-database-high-water-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-materialization-sidecar-journal-high-water-n1`, unit: 'bytes'} as const,
    {name: `${prefix}-materialization-sidecar-wal-high-water-n1`, unit: 'bytes'} as const,
  ]),
] as const;

const RESOLUTION_TRANSACTION_RELEASE_EVIDENCE_MEASUREMENTS = EffectArray.map(
  ['cold', 'one-file-reindex', 'same-overlay-reference'] as const,
  prefix => ({name: `${prefix}-reference-resolution-longest-transaction-n1`, unit: 'milliseconds'}) as const,
);

export const PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS = [
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
  {name: 'one-file-reindex-incremental-work-attribution-context-files-n1', unit: 'count'},
  {name: 'one-file-reindex-incremental-work-base-facts-loaded-n1', unit: 'count'},
  {name: 'one-file-reindex-incremental-work-changed-files-n1', unit: 'count'},
  {name: 'one-file-reindex-incremental-work-deleted-files-n1', unit: 'count'},
  {name: 'one-file-reindex-incremental-work-fact-bytes-n1', unit: 'bytes'},
  {name: 'one-file-reindex-incremental-work-inventory-files-inspected-n1', unit: 'count'},
  {name: 'one-file-reindex-incremental-work-planned-rows-n1', unit: 'count'},
  {name: 'one-file-reindex-incremental-work-probed-dependency-paths-n1', unit: 'count'},
  {name: 'one-file-reindex-incremental-work-source-bytes-n1', unit: 'bytes'},
  {name: 'one-file-reindex-incremental-work-total-files-n1', unit: 'count'},
  {name: 'cold-primary-query-returned-nodes', unit: 'count'},
  {name: 'one-file-reindex-primary-query-returned-nodes', unit: 'count'},
  {name: 'same-overlay-full-rebuild-index', unit: 'milliseconds'},
  {name: 'same-overlay-full-rebuild-primary-query-returned-nodes', unit: 'count'},
  {name: 'primary-query-structural-parity', unit: 'count'},
  {name: 'structural-graph-digest-parity', unit: 'count'},
  {name: 'cold-sqlite-temp-database-pages-high-water-n1', unit: 'bytes'},
  {name: 'cold-sqlite-durable-database-pages-high-water-n1', unit: 'bytes'},
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
  {name: 'production-shape-file-target-attainment', unit: 'percent'},
  {name: 'production-shape-repository-file-target-attainment', unit: 'percent'},
  {name: 'production-shape-excluded-file-target-attainment', unit: 'percent'},
  {name: 'production-shape-symbol-target-attainment', unit: 'percent'},
  {name: 'production-shape-edge-target-attainment', unit: 'percent'},
  {name: 'production-shape-lexical-term-target-attainment', unit: 'percent'},
  ...INVENTORY_TIMING_REQUIRED_MEASUREMENTS,
  ...MATERIALIZATION_SUBPHASE_REQUIRED_MEASUREMENTS,
  ...MATERIALIZATION_REPLAY_RELEASE_EVIDENCE_MEASUREMENTS,
  ...MATERIALIZATION_QUERY_INDEX_RESTORATION_RELEASE_EVIDENCE_MEASUREMENTS,
  ...MATERIALIZATION_STORAGE_HIGH_WATER_RELEASE_EVIDENCE_MEASUREMENTS,
  ...RESOLUTION_TRANSACTION_RELEASE_EVIDENCE_MEASUREMENTS,
  ...SAMPLER_RELEASE_EVIDENCE_MEASUREMENTS,
  ...ACTIVATION_RELEASE_EVIDENCE_MEASUREMENTS,
] as const;

export const EXTERNAL_REPOSITORY_EVIDENCE_MEASUREMENTS = EXTERNAL_REPOSITORY_REQUIRED_MEASUREMENTS;

export interface ExternalRepositoryQueryControl {
  readonly expectedLanguage: string;
  readonly expectedPath: string;
  readonly query: string;
}

export interface PublicGitHubRepositoryEvidence {
  readonly name: string;
  readonly url: string;
}

export interface ManagerPerformanceEvidence {
  readonly catalogColdMilliseconds: readonly number[];
  readonly catalogWarmMilliseconds: readonly number[];
  readonly detailColdMilliseconds: readonly number[];
  readonly edgeBudget: number;
  readonly maxResponsePayloadBytes: readonly number[];
  readonly nodeBudget: number;
  readonly nodeDetailColdMilliseconds: readonly number[];
  readonly overviewColdMilliseconds: readonly number[];
  readonly overviewWarmMilliseconds: readonly number[];
  readonly queryMilliseconds: readonly number[];
  readonly queryPayloadBytes: readonly number[];
  readonly detailEdgeCount: number;
  readonly detailNodeCount: number;
  readonly layoutPreparationProxyMilliseconds: readonly number[];
  readonly overviewEdgeCount: number;
  readonly overviewNodeCount: number;
  readonly requestCancellationPassed: true;
  readonly snapshotBindingPassed: true;
  readonly staleResponseRejectionPassed: true;
}

export interface ConcurrentWorktreeEvidence {
  readonly cleanupPassed: true;
  readonly durationMilliseconds: number;
  readonly indexedFiles: number;
  readonly isolationPassed: true;
  readonly simultaneousWorktrees: number;
  readonly topology: 'bounded-synthetic-linked-worktrees-in-measured-primary-home';
}

export interface BenchmarkStorageEnvironment {
  readonly filesystem: string;
  readonly location: 'external' | 'internal' | 'unknown';
  readonly medium: 'rotational' | 'solid-state' | 'unknown' | 'virtual-or-network';
}

interface ProductionBenchmarkGovernanceEvidence {
  readonly filesystemsShared: true;
  readonly minimumFreeBytes: number;
  readonly primaryAvailableBytes: number;
  readonly primaryStorage: BenchmarkStorageEnvironment;
  readonly referenceAvailableBytes: number;
  readonly referenceStorage: BenchmarkStorageEnvironment;
}

export type BenchmarkRuntimeProvenance =
  | {
      readonly mode: 'github-actions-clean-source';
      readonly runnerArchitecture: 'ARM64' | 'X64';
      readonly runnerEnvironment: 'github-hosted' | 'self-hosted';
      readonly runnerOperatingSystem: 'Linux' | 'macOS' | 'Windows';
      readonly sourceCommit: string;
      readonly sourceLockfileSha256: string;
      readonly sourcePackageManifestSha256: string;
    }
  | ({readonly mode: 'managed-exact-head'; readonly processLeaseInspection: 'complete'} & DevelopmentRuntimeEvidence);

interface PreparedCodeGraphBenchmarkFixture {
  readonly externalCommit?: string;
  readonly externalControls?: readonly ExternalRepositoryQueryControl[];
  readonly fixtureIdentity?: string;
  readonly home: string;
  readonly incrementalSourcePath?: string;
  readonly profile?: ProductionCodeGraphFixtureProfile;
  readonly preserveHomes?: Effect.Effect<void>;
  readonly publicRepository?: PublicGitHubRepositoryEvidence;
  readonly publicRepositoryVerification?: ExternalRepositoryPublicVerification;
  readonly queryText?: string;
  readonly referenceHome?: string;
  readonly repository: string;
}

export interface CodeGraphBenchmarkRunCheckpoint {
  readonly phase: string;
  readonly state: 'complete' | 'failed' | 'running';
  readonly updatedAt: string;
  readonly version: 1;
}

interface CodeGraphBenchmarkRunCheckpointHandle {
  readonly mark: (phase: string) => Effect.Effect<void, unknown>;
  readonly finish: (state: 'complete' | 'failed') => Effect.Effect<void, never>;
}

const benchmarkCodeGraph = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const options = parseArguments(yield* scriptArguments());
    if (options.embeddingContexts !== undefined) {
      system.setEnvironmentVariable(THREADNOTE_EMBEDDING_CONTEXTS_ENV, String(options.embeddingContexts));
    }
    const threadnoteSourceRoot = yield* path.fromFileUrl(new URL('..', import.meta.url));
    const ratchet = options.ratchetPath ? yield* readJsonFile(options.ratchetPath) : undefined;
    if (ratchet !== undefined) validateCodeGraphBenchmarkRatchet(ratchet);
    const longScaleEvidenceRun = requiresLongScaleBenchmarkEvidence(options.scaleSymbols);
    const runtimeProvenanceRequired =
      options.profile === 'production-large' || options.repository !== undefined || longScaleEvidenceRun;
    const runtimeProvenance = runtimeProvenanceRequired
      ? yield* validateBenchmarkRuntimeProvenance(threadnoteSourceRoot)
      : undefined;
    const releaseEvidenceSource = yield* validateReleaseEvidenceSource(
      threadnoteSourceRoot,
      Effect2.pipe(system.environment().THREADNOTE_BENCHMARK_RELEASE_REF, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ) || undefined,
      Effect2.pipe(system.environment().THREADNOTE_BENCHMARK_RELEASE_SHA, effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      ) || undefined,
    );
    const largeEvidenceRun = options.profile === 'production-large' || options.repository !== undefined;
    const checkpointedEvidenceRun = largeEvidenceRun || longScaleEvidenceRun;
    const sampleProcessTree = checkpointedEvidenceRun || options.embeddingContexts !== undefined;
    const externalPrepared =
      options.repository !== undefined ? yield* prepareExternalCodeGraphFixture(options) : undefined;
    if (externalPrepared && releaseEvidenceSource) {
      assertPerformanceControlSet(externalPrepared.externalControls ?? []);
      if (!externalPrepared.publicRepository) {
        return yield* ScriptError.make({
          message: 'Release-bound external evidence requires a public GitHub repository.',
        });
      }
      if (!isReviewedPublicBenchmarkRepository(externalPrepared.publicRepository)) {
        return yield* ScriptError.make({
          message: 'Release-bound external evidence requires a reviewed public benchmark repository.',
        });
      }
    }
    const externalPreflight = externalPrepared
      ? yield* externalBenchmarkPreflight(
          fs,
          path,
          externalPrepared,
          options.minimumFreeGiB,
          options.retainHomes,
          runtimeProvenance,
        )
      : undefined;
    if (options.preflight) {
      if (!externalPreflight || !externalPrepared) {
        return yield* ScriptError.make({message: 'External benchmark preflight was not prepared.'});
      }
      yield* revalidateExternalBenchmarkPreflightState(
        threadnoteSourceRoot,
        externalPrepared.repository,
        externalPrepared.externalCommit,
        runtimeProvenance,
      );
      if (options.outputPath) {
        yield* atomicWrite(
          `${options.outputPath}.preflight.json`,
          `${JSON.stringify(externalPreflight, undefined, 2)}\n`,
        );
      }
      yield* printJson(externalPreflight);
      return;
    }
    if (externalPrepared && options.retainHomes) {
      yield* externalPrepared.preserveHomes ??
        Effect.fail(ScriptError.make({message: 'External benchmark homes could not be retained after preflight.'}));
    }
    const runCheckpoint =
      checkpointedEvidenceRun && options.outputPath
        ? yield* Effect.acquireRelease(
            makeBenchmarkRunCheckpoint(`${options.outputPath}.run.json`),
            (checkpoint, exit) => checkpoint.finish(Exit.isSuccess(exit) ? 'complete' : 'failed'),
          )
        : undefined;
    const fixturePath = yield* path.fromFileUrl(
      new URL(`../apps/threadnote/test/evaluation/fixtures/${options.fixture}/fixture.json`, import.meta.url),
    );
    const fixture = parseCodeGraphEvaluationFixtureV1(yield* readJsonFile(fixturePath));
    const bootstrapRoot =
      options.profile === 'production-large'
        ? yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-graph-benchmark-bootstrap-'})
        : undefined;
    const bootstrapSampler =
      options.profile === 'production-large' && bootstrapRoot
        ? yield* Effect.acquireRelease(
            startExternalSampler(
              fs,
              path,
              bootstrapRoot,
              path.join(bootstrapRoot, 'sqlite-temp'),
              path.join(bootstrapRoot, 'not-created.sqlite'),
              benchmarkSamplerCheckpointPath(path, bootstrapRoot, options.outputPath, 'bootstrap'),
              'bootstrap',
              options.rssPeakDiagnostics,
            ),
            (sampler, exit) => sampler.stop(Exit.isSuccess(exit) ? 'complete' : 'aborted').pipe(Effect.ignore),
          )
        : undefined;
    const prepared: PreparedCodeGraphBenchmarkFixture =
      externalPrepared !== undefined
        ? externalPrepared
        : options.profile === 'production-large'
          ? yield* prepareProductionCodeGraphFixture(productionProfile(options), options.vectors)
          : options.scaleSymbols === undefined
            ? yield* prepareCodeGraphFixture(options.fixture)
            : yield* prepareGeneratedCodeGraphFixture(options.scaleSymbols, options.vectors);
    const sameOverlayReferenceHome =
      prepared.referenceHome ?? (yield* makeOwnedTempDirectoryScoped('threadnote-code-graph-same-overlay-reference-'));
    let productionGovernance: ProductionBenchmarkGovernanceEvidence | undefined;
    if (prepared.profile) {
      productionGovernance = yield* productionBenchmarkGovernance(
        prepared.home,
        sameOverlayReferenceHome,
        options.minimumFreeGiB,
        runtimeProvenance?.mode === 'github-actions-clean-source' &&
          runtimeProvenance.runnerEnvironment === 'github-hosted' &&
          !options.vectors &&
          reducedProductionRatchetProfile(prepared.profile.sourceFiles, prepared.profile.targetGraphSymbols),
      );
    }
    yield* runCheckpoint?.mark('preparing-runtime') ?? Effect.void;
    yield* bootstrapSampler?.markPhase('preparing-runtime') ?? Effect.void;
    const embeddingModelId = options.vectors
      ? yield* prepareBenchmarkEmbedding(prepared.home, options.modelHome)
      : undefined;
    const queryText =
      options.queryText ??
      (options.vectors
        ? VECTOR_SEMANTIC_CONTROL_QUERY
        : (prepared.queryText ??
          (options.scaleSymbols === undefined
            ? options.fixture === 'code-graph-polyglot-v1'
              ? 'KotlinApp'
              : 'exclusive file lock'
            : generatedSymbolName(Math.max(0, options.scaleSymbols - 1)))));
    const indexer = yield* CodeGraphIndexer;
    const analysis = yield* CodeGraphAnalysis;
    const query = yield* CodeGraphQueryService;
    const benchmarkIdentity = yield* resolveRepositoryIdentity(prepared.repository);
    const benchmarkLayout = codeGraphLayout(
      path,
      prepared.home,
      benchmarkIdentity.checkoutId,
      benchmarkIdentity.worktreeId,
    );
    const databaseRoot = path.join(prepared.home, 'indexes', 'code-graph');
    const coldStorageBaseline = yield* codeGraphStorageTelemetry(fs, path, benchmarkLayout.databasePath, databaseRoot);
    const sqliteWriterProfile = options.sqliteWriterProfile
      ? CODE_GRAPH_SQLITE_WRITER_PROFILES[options.sqliteWriterProfile]
      : undefined;
    let sqliteWriterEvidencePhase: SqliteWriterBenchmarkPhase = 'cold';
    const sqliteWriterSettingsEvidence: SqliteWriterSettingsEvidence[] = [];
    const sqliteWriterIndexOptions = {
      ...(sqliteWriterProfile
        ? {
            onSqliteWriterConfigured: (settings: CodeGraphSqliteWriterSettings) =>
              Effect.sync(() => {
                sqliteWriterSettingsEvidence.push({...settings, benchmarkPhase: sqliteWriterEvidencePhase});
              }),
            sqliteWriterTuning: sqliteWriterProfile.tuning,
          }
        : {}),
      ...(options.materializationTransactionBatchLimit === undefined
        ? {}
        : {persistentMaterializationTransactionBatchLimit: options.materializationTransactionBatchLimit}),
    };
    const samplerRoot = path.join(prepared.home, 'benchmark-telemetry');
    const sqliteTemporaryRoot = path.join(samplerRoot, 'sqlite-temp');
    if (sampleProcessTree) {
      yield* fs.makeDirectory(sqliteTemporaryRoot, {recursive: true});
      system.setEnvironmentVariable('SQLITE_TMPDIR', sqliteTemporaryRoot);
    }
    const bootstrapExternalTelemetry = bootstrapSampler ? yield* bootstrapSampler.stop() : undefined;
    const coldStoragePeak = new SqliteStoragePeakTelemetry();
    yield* runCheckpoint?.mark('cold-index') ?? Effect.void;
    const coldRegistrationTracing = productionGovernance ? createBenchmarkRegistrationTracing() : undefined;
    const coldPhase = yield* measureSampledBenchmarkIndex(
      sampleProcessTree
        ? startExternalSampler(
            fs,
            path,
            samplerRoot,
            sqliteTemporaryRoot,
            benchmarkLayout.databasePath,
            benchmarkSamplerCheckpointPath(path, samplerRoot, options.outputPath, 'cold'),
            'cold',
            options.rssPeakDiagnostics,
          )
        : succeedUndefined,
      (timeline, sampler) =>
        indexer.index({
          cwd: prepared.repository,
          onTiming: stage => timeline.observeTiming(stage),
          onProgress: progress =>
            observeIndexProgress(timeline, progress).pipe(
              Effect.andThen(sampler?.mark(progress) ?? Effect.void),
              Effect.andThen(
                sampler ? Effect.void : observeSqliteStoragePeak(fs, coldStoragePeak, benchmarkLayout.databasePath),
              ),
            ),
          ...sqliteWriterIndexOptions,
          threadnoteHome: prepared.home,
        }),
      observeSqliteStoragePeak(fs, coldStoragePeak, benchmarkLayout.databasePath),
      coldRegistrationTracing,
    );
    const coldRegistrationDiagnostics = serializeBenchmarkRegistrationTracing(coldRegistrationTracing);
    const coldMeasurement = coldPhase.measurement;
    const coldExternalTelemetry = coldPhase.telemetry;
    const {
      finishedAt: coldFinished,
      processFinished: coldProcessFinished,
      processStarted: coldProcessStarted,
      result: cold,
      startedAt: coldStarted,
      timeline: coldTimeline,
    } = coldMeasurement;
    let embeddingContextPlan:
      | {
          readonly cpuMathCores: number;
          readonly effectiveContexts: number;
          readonly modelGpuLayers?: number;
          readonly requestedContexts: number;
          readonly threadCounts: readonly number[];
        }
      | undefined;
    if (options.vectors) {
      const runtime = yield* LocalModelRuntime;
      const diagnostics = yield* runtime.diagnostics.pipe(
        Effect.mapError(cause => scriptError(cause, 'Could not read the effective embedding context plan.')),
      );
      const plan = diagnostics.embeddingContextPlan;
      if (!plan || (options.embeddingContexts !== undefined && plan.requestedContexts !== options.embeddingContexts)) {
        return yield* ScriptError.make({
          message: 'The native worker did not report the effective embedding context plan.',
        });
      }
      embeddingContextPlan = {...plan, cpuMathCores: diagnostics.cpuMathCores};
    }
    const coldVectorMappingDigest = options.vectors
      ? yield* vectorMappingDigest(fs, path, benchmarkLayout.vectorRoot, benchmarkIdentity.worktreeId)
      : undefined;
    const coldStorageAfter = yield* codeGraphStorageTelemetry(fs, path, benchmarkLayout.databasePath, databaseRoot);
    yield* runCheckpoint?.mark('hot-query-and-mutation') ?? Effect.void;
    if (options.vectors) {
      if (
        EffectArray.some(cold.diagnostics, diagnostic =>
          Effect2.pipe(diagnostic, EffectString.includes('Vector graph retrieval unavailable')),
        )
      ) {
        return yield* ScriptError.make({message: EffectArray.join(cold.diagnostics, '\n')});
      }
      const semanticControl = yield* query.inspect({
        cwd: prepared.repository,
        operation: 'query',
        query: queryText,
        refresh: false,
        requestMaintenance: false,
        threadnoteHome: prepared.home,
      });
      const expectedPath =
        options.scaleSymbols === undefined && prepared.profile === undefined
          ? 'docs/architecture.md'
          : GENERATED_VECTOR_CONTROL_PATH;
      const minimumScore = vectorSemanticControlMinimumScore(expectedPath);
      if (!EffectArray.some(semanticControl.nodes, node => node.path === expectedPath && node.score >= minimumScore)) {
        const observed = EffectArray.join(
          EffectArray.map(
            semanticControl.nodes.slice(0, 5),
            node => `${node.path}:${node.name}:${node.score.toFixed(3)}`,
          ),
          ', ',
        );
        return yield* ScriptError.make({
          message: `Vector benchmark semantic positive control did not resolve; observed ${observed || 'no nodes'}.`,
        });
      }
    }
    const coldExternalQueryControls = prepared.externalControls
      ? yield* Effect.forEach(
          prepared.externalControls,
          control =>
            benchmarkExternalQueryControl(query, prepared.repository, prepared.home, control, cold.snapshot.id, 'cold'),
          {concurrency: 1},
        )
      : [];
    const coldPrimaryQueryEvidence =
      coldExternalQueryControls[0] ??
      assertPrimaryQueryPositiveControl(
        yield* query.inspect({
          cwd: prepared.repository,
          operation: 'query',
          query: queryText,
          refresh: false,
          requestMaintenance: false,
          threadnoteHome: prepared.home,
        }),
        cold.snapshot.id,
        'cold',
      );

    for (let index = 0; index < options.warmups; index += 1) {
      yield* query.inspect({
        cwd: prepared.repository,
        operation: 'query',
        query: queryText,
        requestMaintenance: false,
        threadnoteHome: prepared.home,
      });
      yield* query.inspect({
        cwd: prepared.repository,
        operation: 'query',
        query: queryText,
        refresh: false,
        requestMaintenance: false,
        threadnoteHome: prepared.home,
      });
    }
    const queryDurations: number[] = [];
    const queryCpuDurations: number[] = [];
    for (let index = 0; index < options.samples; index += 1) {
      const started = yield* Clock.currentTimeNanos;
      const processStarted = processTelemetry();
      yield* query.inspect({
        cwd: prepared.repository,
        operation: 'query',
        query: queryText,
        requestMaintenance: false,
        threadnoteHome: prepared.home,
      });
      queryDurations.push(Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND);
      queryCpuDurations.push(cpuMilliseconds(processStarted, processTelemetry()).total);
    }
    const exactReadyQueryDurations: number[] = [];
    const exactReadyQueryCpuDurations: number[] = [];
    const deferredQueryDurations: number[] = [];
    const deferredQueryCpuDurations: number[] = [];
    for (let index = 0; index < options.samples; index += 1) {
      let exactDigest: string | undefined;
      let deferredDigest: string | undefined;
      const order = index % 2 === 0 ? (['deferred', 'exact'] as const) : (['exact', 'deferred'] as const);
      for (const freshnessPolicy of order) {
        const started = yield* Clock.currentTimeNanos;
        const processStarted = processTelemetry();
        const status = yield* query.status(prepared.home, prepared.repository, {
          observeWorktree: freshnessPolicy === 'exact',
          requestMaintenance: false,
        });
        const result = yield* query.inspect({
          cwd: prepared.repository,
          operation: 'query',
          query: queryText,
          refresh: false,
          requestMaintenance: false,
          statusObservation: observationFromCodeGraphStatus(status),
          threadnoteHome: prepared.home,
        });
        const response = codeGraphMcpResponse(result);
        const duration = Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND;
        const cpu = cpuMilliseconds(processStarted, processTelemetry()).total;
        if (freshnessPolicy === 'deferred') {
          deferredQueryDurations.push(duration);
          deferredQueryCpuDurations.push(cpu);
          deferredDigest = queryResultStructuralDigest(result);
          if (result.freshness !== 'deferred') {
            return yield* ScriptError.make({
              message: 'The deferred-ready query benchmark observed the worktree unexpectedly.',
            });
          }
        } else {
          exactReadyQueryDurations.push(duration);
          exactReadyQueryCpuDurations.push(cpu);
          exactDigest = queryResultStructuralDigest(result);
          if (result.freshness !== 'current') {
            return yield* ScriptError.make({message: 'The exact query benchmark did not observe current evidence.'});
          }
        }
        if (
          result.snapshot.id !== cold.snapshot.id ||
          result.nodes.length === 0 ||
          response.structuredContent.operation !== 'query'
        ) {
          return yield* ScriptError.make({message: 'The ready-query benchmark did not retain its snapshot contract.'});
        }
      }
      if (exactDigest !== deferredDigest) {
        return yield* ScriptError.make({
          message: 'Exact and deferred ready-query benchmark results diverged structurally.',
        });
      }
    }

    const changedPath = path.join(
      prepared.repository,
      prepared.incrementalSourcePath ??
        (options.scaleSymbols === undefined
          ? options.fixture === 'code-graph-polyglot-v1'
            ? 'src/main.ts'
            : 'packages/search/src/vector-index.ts'
          : 'src/module-00000.ts'),
    );
    const originalChangedBytes = yield* fs.readFile(changedPath);
    const originalChangedSource = decodeBenchmarkSource(originalChangedBytes);
    const benchmarkChangedSource = semanticBenchmarkOverlay(changedPath, originalChangedSource);
    const benchmarkChangedBytes = new TextEncoder().encode(benchmarkChangedSource);
    const incrementalStoragePeak = new SqliteStoragePeakTelemetry();
    sqliteWriterEvidencePhase = 'one-file-reindex';
    const incrementalPhase = yield* Effect.acquireUseRelease(
      applyBenchmarkOverlay(fs, changedPath, originalChangedBytes, benchmarkChangedBytes),
      () =>
        Effect.gen(function* () {
          yield* runCheckpoint?.mark('incremental-index') ?? Effect.void;
          return yield* measureSampledBenchmarkIndex(
            sampleProcessTree
              ? startExternalSampler(
                  fs,
                  path,
                  samplerRoot,
                  sqliteTemporaryRoot,
                  benchmarkLayout.databasePath,
                  benchmarkSamplerCheckpointPath(path, samplerRoot, options.outputPath, 'incremental'),
                  'incremental',
                  options.rssPeakDiagnostics,
                )
              : succeedUndefined,
            (timeline, sampler) =>
              indexer.index({
                cwd: prepared.repository,
                onTiming: stage => timeline.observeTiming(stage),
                onProgress: progress =>
                  observeIndexProgress(timeline, progress).pipe(
                    Effect.andThen(sampler?.mark(progress) ?? Effect.void),
                    Effect.andThen(
                      sampler
                        ? Effect.void
                        : observeSqliteStoragePeak(fs, incrementalStoragePeak, benchmarkLayout.databasePath),
                    ),
                  ),
                ...sqliteWriterIndexOptions,
                threadnoteHome: prepared.home,
              }),
            observeSqliteStoragePeak(fs, incrementalStoragePeak, benchmarkLayout.databasePath),
          );
        }),
      () => restoreBenchmarkOverlay(fs, changedPath, benchmarkChangedBytes, originalChangedBytes),
    );
    const incrementalMeasurement = incrementalPhase.measurement;
    const incrementalExternalTelemetry = incrementalPhase.telemetry;
    const {
      finishedAt: incrementalFinished,
      processFinished: incrementalProcessFinished,
      processStarted: incrementalProcessStarted,
      result: incremental,
      startedAt: incrementalStarted,
      timeline: incrementalTimeline,
    } = incrementalMeasurement;
    if (prepared.externalCommit) {
      yield* verifyExternalRepositoryUnchanged(prepared.repository, prepared.externalCommit);
    }
    yield* runCheckpoint?.mark('post-incremental-query-and-analysis') ?? Effect.void;
    if (
      options.vectors &&
      EffectArray.some(incremental.diagnostics, diagnostic =>
        Effect2.pipe(diagnostic, EffectString.includes('Vector graph retrieval unavailable')),
      )
    ) {
      return yield* ScriptError.make({message: EffectArray.join(incremental.diagnostics, '\n')});
    }
    if (options.vectors) {
      const semanticControl = yield* query.inspect({
        cwd: prepared.repository,
        operation: 'query',
        query: queryText,
        refresh: false,
        requestMaintenance: false,
        threadnoteHome: prepared.home,
      });
      const expectedPath =
        options.scaleSymbols === undefined && prepared.profile === undefined
          ? 'docs/architecture.md'
          : GENERATED_VECTOR_CONTROL_PATH;
      if (
        semanticControl.snapshot.id !== incremental.snapshot.id ||
        !EffectArray.some(
          semanticControl.nodes,
          node => node.path === expectedPath && node.score >= vectorSemanticControlMinimumScore(expectedPath),
        )
      ) {
        const observed = EffectArray.join(
          EffectArray.map(
            semanticControl.nodes.slice(0, 5),
            node => `${node.path}:${node.name}:${node.score.toFixed(3)}`,
          ),
          ', ',
        );
        return yield* ScriptError.make({
          message:
            `Incremental vector benchmark semantic positive control did not resolve on the new snapshot; ` +
            `observed ${observed || 'no nodes'}.`,
        });
      }
    }
    const incrementalExternalQueryControls = prepared.externalControls
      ? yield* Effect.forEach(
          prepared.externalControls,
          control =>
            benchmarkExternalQueryControl(
              query,
              prepared.repository,
              prepared.home,
              control,
              incremental.snapshot.id,
              'incremental',
            ),
          {concurrency: 1},
        )
      : [];
    const incrementalPrimaryQueryEvidence =
      incrementalExternalQueryControls[0] ??
      assertPrimaryQueryPositiveControl(
        yield* query.inspect({
          cwd: prepared.repository,
          operation: 'query',
          query: queryText,
          refresh: false,
          requestMaintenance: false,
          threadnoteHome: prepared.home,
        }),
        incremental.snapshot.id,
        'incremental',
      );
    const mcpOperationMatrix = largeEvidenceRun
      ? yield* benchmarkMcpOperationMatrix(query, prepared.repository, prepared.home, queryText)
      : [];

    if (options.vectors) {
      yield* prepareBenchmarkEmbedding(sameOverlayReferenceHome, options.modelHome);
    }
    const sameOverlayReferenceIdentity = yield* resolveRepositoryIdentity(prepared.repository);
    const sameOverlayReferenceLayout = codeGraphLayout(
      path,
      sameOverlayReferenceHome,
      sameOverlayReferenceIdentity.checkoutId,
      sameOverlayReferenceIdentity.worktreeId,
    );
    const sameOverlaySamplerRoot = path.join(sameOverlayReferenceHome, 'benchmark-telemetry');
    const sameOverlaySqliteTemporaryRoot = path.join(sameOverlaySamplerRoot, 'sqlite-temp');
    if (sampleProcessTree) yield* fs.makeDirectory(sameOverlaySqliteTemporaryRoot, {recursive: true});
    const sameOverlayReferenceStoragePeak = new SqliteStoragePeakTelemetry();
    sqliteWriterEvidencePhase = 'same-overlay-reference';
    const previousSqliteTemporaryRoot = system.environment().SQLITE_TMPDIR;
    const sameOverlayReference = yield* Effect.sync(() => {
      if (sampleProcessTree) system.setEnvironmentVariable('SQLITE_TMPDIR', sameOverlaySqliteTemporaryRoot);
    }).pipe(
      Effect.andThen(
        Effect.acquireUseRelease(
          applyBenchmarkOverlay(fs, changedPath, originalChangedBytes, benchmarkChangedBytes),
          () =>
            Effect.gen(function* () {
              yield* runCheckpoint?.mark('same-overlay-reference-index') ?? Effect.void;
              const sampled = yield* measureSampledBenchmarkIndex(
                sampleProcessTree
                  ? startExternalSampler(
                      fs,
                      path,
                      sameOverlaySamplerRoot,
                      sameOverlaySqliteTemporaryRoot,
                      sameOverlayReferenceLayout.databasePath,
                      benchmarkSamplerCheckpointPath(
                        path,
                        sameOverlaySamplerRoot,
                        options.outputPath,
                        'same-overlay-reference',
                      ),
                      'same-overlay-reference',
                      options.rssPeakDiagnostics,
                    )
                  : succeedUndefined,
                (timeline, sampler) =>
                  indexer.index({
                    cwd: prepared.repository,
                    incrementalOverlay: false,
                    onTiming: stage => timeline.observeTiming(stage),
                    onProgress: progress =>
                      observeIndexProgress(timeline, progress).pipe(
                        Effect.andThen(sampler?.mark(progress) ?? Effect.void),
                        Effect.andThen(
                          sampler
                            ? Effect.void
                            : observeSqliteStoragePeak(
                                fs,
                                sameOverlayReferenceStoragePeak,
                                sameOverlayReferenceLayout.databasePath,
                              ),
                        ),
                      ),
                    ...sqliteWriterIndexOptions,
                    threadnoteHome: sameOverlayReferenceHome,
                  }),
                observeSqliteStoragePeak(fs, sameOverlayReferenceStoragePeak, sameOverlayReferenceLayout.databasePath),
              );
              const measurement = sampled.measurement;
              const summary = measurement.result;
              const controls = prepared.externalControls
                ? yield* Effect.forEach(
                    prepared.externalControls,
                    control =>
                      benchmarkExternalQueryControl(
                        query,
                        prepared.repository,
                        sameOverlayReferenceHome,
                        control,
                        summary.snapshot.id,
                        'same-overlay-reference',
                      ),
                    {concurrency: 1},
                  )
                : [];
              const primary =
                controls[0] ??
                assertPrimaryQueryPositiveControl(
                  yield* query.inspect({
                    cwd: prepared.repository,
                    operation: 'query',
                    query: queryText,
                    refresh: false,
                    requestMaintenance: false,
                    threadnoteHome: sameOverlayReferenceHome,
                  }),
                  summary.snapshot.id,
                  'same-overlay-reference',
                );
              return {
                controls,
                indexFinished: measurement.finishedAt,
                measurement,
                primary,
                summary,
                telemetry: sampled.telemetry,
              };
            }),
          () => restoreBenchmarkOverlay(fs, changedPath, benchmarkChangedBytes, originalChangedBytes),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (previousSqliteTemporaryRoot === undefined) delete system.environment().SQLITE_TMPDIR;
          else system.setEnvironmentVariable('SQLITE_TMPDIR', previousSqliteTemporaryRoot);
        }),
      ),
    );
    const sameOverlayReferenceStarted = sameOverlayReference.measurement.startedAt;
    const sameOverlayReferenceTimeline = sameOverlayReference.measurement.timeline;
    const sameOverlayReferenceTelemetry = sameOverlayReference.telemetry;
    if (sameOverlayReference.summary.materialization?.mode !== 'full') {
      return yield* ScriptError.make({message: 'Same-overlay reference build did not execute a full materialization.'});
    }
    if (prepared.externalCommit) {
      yield* verifyExternalRepositoryUnchanged(prepared.repository, prepared.externalCommit);
    }

    yield* runCheckpoint?.mark('post-build-analysis') ?? Effect.void;
    const coldStatusStarted = yield* Clock.currentTimeNanos;
    // The measured overlay was restored above. Observe its retained snapshot without
    // scheduling a refresh writer that would contend with the analysis lease.
    const analysisStatus = yield* query.status(prepared.home, prepared.repository, {requestMaintenance: false});
    const coldStatusDuration =
      Number((yield* Clock.currentTimeNanos) - coldStatusStarted) / NANOSECONDS_PER_MILLISECOND;
    if (!analysisStatus.readySnapshot) {
      return yield* ScriptError.make({
        message: 'Code graph benchmark could not resolve its ready snapshot for analysis.',
      });
    }
    const managerPerformance = prepared.externalCommit
      ? yield* benchmarkManagerPerformance(
          prepared.home,
          incremental.identity.repositoryId,
          incremental.snapshot.id,
          queryText,
          options.samples,
          options.warmups,
        )
      : undefined;
    const storageEnvironment =
      productionGovernance?.primaryStorage ??
      (prepared.externalCommit ? yield* benchmarkStorageEnvironment(prepared.home) : undefined);
    const analysisOptions = {
      databasePath: analysisStatus.databasePath,
      limits: codeGraphAnalysisLimitsForView('stats'),
      snapshot: analysisStatus.readySnapshot,
    } as const;
    for (let index = 0; index < Math.min(options.warmups, 1); index += 1) {
      yield* analysis.analyze(analysisOptions);
    }
    const analysisDurations: number[] = [];
    const analysisCpuDurations: number[] = [];
    const analysisStageTimings = new Map<BenchmarkTimingStage, {wall: number[]; cpu: number[]}>();
    const analysisLeaseTraces: ReturnType<BenchmarkLeaseTrace['report']>[] = [];
    let incrementalAnalysis: CodeGraphAnalysisResult | undefined;
    for (let index = 0; index < Math.min(options.samples, 3); index += 1) {
      const timings = new BenchmarkStageTimings();
      const leaseTrace = new BenchmarkLeaseTrace();
      const started = yield* Clock.currentTimeNanos;
      const processStarted = processTelemetry();
      const result = yield* analysis.analyze({
        ...analysisOptions,
        onTiming: stage => timings.observe(stage),
        onLeaseTiming: (operation, stage, boundary) => leaseTrace.observe(operation, stage, boundary),
      });
      analysisDurations.push(Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND);
      analysisCpuDurations.push(cpuMilliseconds(processStarted, processTelemetry()).total);
      analysisLeaseTraces.push(leaseTrace.report());
      for (const [stage, observation] of timings.observations()) {
        const samples = analysisStageTimings.get(stage) ?? {wall: [], cpu: []};
        samples.wall.push(observation.wallMilliseconds);
        samples.cpu.push(observation.cpuMilliseconds);
        analysisStageTimings.set(stage, samples);
      }
      if (result.coverage.topology.state !== 'not-requested' || result.usage.edgeVisits !== 0) {
        return yield* ScriptError.make({
          message: 'Code graph benchmark aggregate analysis unexpectedly executed a detail scan.',
        });
      }
      incrementalAnalysis = result;
    }
    if (!incrementalAnalysis?.coverage.complete) {
      return yield* ScriptError.make({message: 'Code graph benchmark analysis returned partial coverage.'});
    }
    const sameOverlayReferenceAnalysis = yield* analysis.analyze({
      databasePath: sameOverlayReferenceLayout.databasePath,
      limits: codeGraphAnalysisLimitsForView('stats'),
      snapshot: sameOverlayReference.summary.snapshot,
    });
    if (
      !sameOverlayReferenceAnalysis.coverage.complete ||
      sameOverlayReferenceAnalysis.coverage.topology.state !== 'not-requested' ||
      sameOverlayReferenceAnalysis.usage.edgeVisits !== 0
    ) {
      return yield* ScriptError.make({
        message: 'Code graph benchmark reference analysis unexpectedly required a detail scan.',
      });
    }
    const incrementalAnalysisDigest = codeGraphAnalysisAggregateDigest(incrementalAnalysis);
    const sameOverlayReferenceAnalysisDigest = codeGraphAnalysisAggregateDigest(sameOverlayReferenceAnalysis);
    if (incrementalAnalysisDigest !== sameOverlayReferenceAnalysisDigest) {
      return yield* ScriptError.make({
        message:
          `Computed analysis aggregate parity failed: incremental(sha256=${incrementalAnalysisDigest}) ` +
          `same-overlay-full(sha256=${sameOverlayReferenceAnalysisDigest}).`,
      });
    }

    const statusSamples = Math.max(1, Math.min(options.samples, largeEvidenceRun ? 3 : 10));
    const repositoryStatusDurations: number[] = [];
    const sidecarStatusDurations: number[] = [];
    const layout = benchmarkLayout;
    let observedStatusRecords = 0;
    for (let index = 0; index < statusSamples; index += 1) {
      const repositoryStatusStarted = yield* Clock.currentTimeNanos;
      yield* query.status(prepared.home, prepared.repository, {requestMaintenance: false});
      repositoryStatusDurations.push(
        Number((yield* Clock.currentTimeNanos) - repositoryStatusStarted) / NANOSECONDS_PER_MILLISECOND,
      );
      const sidecarStatusStarted = yield* Clock.currentTimeNanos;
      const statuses = yield* readCodeGraphBuildStatuses(layout);
      sidecarStatusDurations.push(
        Number((yield* Clock.currentTimeNanos) - sidecarStatusStarted) / NANOSECONDS_PER_MILLISECOND,
      );
      observedStatusRecords = Math.max(observedStatusRecords, statuses.length);
    }

    const storage = yield* codeGraphStorageTelemetry(fs, path, analysisStatus.databasePath, databaseRoot);
    const coldLexicalTermRows = sqliteLexicalTermRowCount(analysisStatus.databasePath, cold.snapshot.id);
    const sqliteVersion = sqliteVersionString(analysisStatus.databasePath);
    const sqlitePageSizeBytes = sqlitePageSize(analysisStatus.databasePath);
    yield* runCheckpoint?.mark('structural-parity') ?? Effect.void;
    const coldStructuralGraphEvidence = yield* sqliteStructuralGraphEvidence(
      analysisStatus.databasePath,
      cold.snapshot.id,
    );
    const incrementalStructuralGraphEvidence = yield* sqliteStructuralGraphEvidence(
      analysisStatus.databasePath,
      incremental.snapshot.id,
    );
    const coldStructuralGraphDigest = coldStructuralGraphEvidence.digest;
    const incrementalStructuralGraphDigest = incrementalStructuralGraphEvidence.digest;
    if (coldStructuralGraphDigest === incrementalStructuralGraphDigest) {
      return yield* ScriptError.make({
        message: 'The semantic one-file overlay did not change the structural code graph digest.',
      });
    }
    const sameOverlayReferenceStructuralGraphEvidence = yield* sqliteStructuralGraphEvidence(
      sameOverlayReferenceLayout.databasePath,
      sameOverlayReference.summary.snapshot.id,
    );
    const sameOverlayReferenceStructuralGraphDigest = sameOverlayReferenceStructuralGraphEvidence.digest;
    const structuralGraphParityEvidence = codeGraphStructuralParityEvidence(
      incrementalStructuralGraphEvidence,
      sameOverlayReferenceStructuralGraphEvidence,
    );
    if (!structuralGraphParityEvidence.parity) {
      if (options.outputPath) {
        yield* atomicWrite(
          `${options.outputPath}.structural-parity.json`,
          `${JSON.stringify(structuralGraphParityEvidence, undefined, 2)}\n`,
        );
      }
      return yield* ScriptError.make({message: codeGraphStructuralParityFailureMessage(structuralGraphParityEvidence)});
    }
    const incrementalPrimaryQueryResult = incrementalPrimaryQueryEvidence.result;
    const sameOverlayReferencePrimaryQueryResult = sameOverlayReference.primary.result;
    if (!incrementalPrimaryQueryResult || !sameOverlayReferencePrimaryQueryResult) {
      return yield* ScriptError.make({message: 'Primary query parity retained no result payload.'});
    }
    const primaryQueryParityEvidence = codeGraphQueryResultParityEvidence(
      incrementalPrimaryQueryResult,
      sameOverlayReferencePrimaryQueryResult,
    );
    if (!primaryQueryParityEvidence.parity) {
      if (options.outputPath) {
        yield* atomicWrite(
          `${options.outputPath}.query-parity.json`,
          `${JSON.stringify(primaryQueryParityEvidence, undefined, 2)}\n`,
        );
      }
      return yield* ScriptError.make({message: codeGraphQueryResultParityFailureMessage(primaryQueryParityEvidence)});
    }
    const coldLanguageCounts = sqliteLanguageCounts(analysisStatus.databasePath, cold.snapshot.id);
    const coldWorkspaceScopeRows = sqliteRowCount(
      analysisStatus.databasePath,
      'SELECT COUNT(*) AS count FROM workspace_scopes WHERE snapshot_id = ?',
      cold.snapshot.id,
    );
    const coldWorkspaceComponentRows = sqliteRowCount(
      analysisStatus.databasePath,
      'SELECT COUNT(*) AS count FROM workspace_components WHERE snapshot_id = ?',
      cold.snapshot.id,
    );
    const coldBazelWorkspaceScopeRows = sqliteRowCount(
      analysisStatus.databasePath,
      "SELECT COUNT(*) AS count FROM workspace_scopes WHERE snapshot_id = ? AND build_system = 'bazel'",
      cold.snapshot.id,
    );
    const coldBazelWorkspaceComponentRows = sqliteRowCount(
      analysisStatus.databasePath,
      "SELECT COUNT(*) AS count FROM workspace_components WHERE snapshot_id = ? AND build_system = 'bazel'",
      cold.snapshot.id,
    );
    const vectorRows = yield* vectorRowCount(fs, path, layout.vectorRoot);
    const coldCpu = cpuMilliseconds(coldProcessStarted, coldProcessFinished);
    const incrementalCpu = cpuMilliseconds(incrementalProcessStarted, incrementalProcessFinished);
    const coldMaterializationStorage = coldTimeline.materializationStorage();
    const incrementalMaterializationStorage = incrementalTimeline.materializationStorage();
    const sameOverlayReferenceMaterializationStorage = sameOverlayReferenceTimeline.materializationStorage();
    yield* runCheckpoint?.mark('concurrent-worktree-control') ?? Effect.void;
    const concurrentWorktreeEvidence = prepared.externalCommit
      ? yield* benchmarkConcurrentWorktreeIsolation(prepared.home)
      : undefined;
    const [commit, dirty, hardware] = yield* Effect.all(
      [
        threadnoteSourceGit(threadnoteSourceRoot, ['rev-parse', 'HEAD']),
        threadnoteSourceGit(threadnoteSourceRoot, CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS),
        system.hardwareInfo,
      ],
      {concurrency: 3},
    );
    const effectiveParserWorkers = parserWorkerCapacity({
      effectiveMemoryBytes: hardware.effectiveMemoryBytes,
      environment: system.environment(),
      hardwareConcurrency: navigator.hardwareConcurrency,
    });
    if (options.sqliteWriterProfile) {
      validateSqliteWriterSettingsEvidence(options.sqliteWriterProfile, sqliteWriterSettingsEvidence);
    }
    yield* runCheckpoint?.mark('finalizing-artifact') ?? Effect.void;
    let artifact: BenchmarkArtifactV1 = {
      createdAt: DateTime.formatIso(yield* DateTime.now),
      environment: {
        architecture: system.architecture,
        commit,
        cpu: hardware.cpuModel,
        dirty: dirty.length > 0,
        fixtureHash:
          prepared.fixtureIdentity !== undefined
            ? prepared.fixtureIdentity
            : prepared.profile !== undefined
              ? productionProfileIdentity(prepared.profile, options.vectors)
              : options.scaleSymbols === undefined
                ? codeGraphEvaluationFixtureHash(fixture)
                : `generated-code-graph-${options.vectors ? 'vectors-v2' : 'v1'}:${options.scaleSymbols}`,
        memoryBytes: hardware.memoryBytes,
        ...(embeddingModelId
          ? {model: {backend: 'node-llama-cpp', id: embeddingModelId, revision: 'builtin-pinned'}}
          : {}),
        node: `bun/${system.runtimeVersion}`,
        operatingSystem: hardware.operatingSystem,
        packageManager: `bun/${system.runtimeVersion}`,
        runner: 'threadnote-code-graph-e2e',
        runnerVersion: '1',
      },
      measurements: [
        ...externalSamplerMeasurements('bootstrap', bootstrapExternalTelemetry),
        benchmarkMeasurement('cold-index', 'milliseconds', [
          Number(coldFinished - coldStarted) / NANOSECONDS_PER_MILLISECOND,
        ]),
        ...indexPhaseMeasurements('cold', coldTimeline, options.vectors),
        ...indexPhaseResourceMeasurements('cold', coldTimeline),
        ...externalSamplerMeasurements('cold', coldExternalTelemetry),
        benchmarkMeasurement('one-file-reindex-index', 'milliseconds', [
          Number(incrementalFinished - incrementalStarted) / NANOSECONDS_PER_MILLISECOND,
        ]),
        ...indexPhaseMeasurements('one-file-reindex', incrementalTimeline, options.vectors),
        ...indexPhaseResourceMeasurements('one-file-reindex', incrementalTimeline),
        ...externalSamplerMeasurements('one-file-reindex', incrementalExternalTelemetry),
        ...indexPhaseMeasurements('same-overlay-reference', sameOverlayReferenceTimeline, false),
        ...indexPhaseResourceMeasurements('same-overlay-reference', sameOverlayReferenceTimeline),
        ...externalSamplerMeasurements('same-overlay-reference', sameOverlayReferenceTelemetry),
        benchmarkMeasurement(
          options.vectors ? 'hot-semantic-vector-query' : 'hot-exact-lexical-query',
          'milliseconds',
          queryDurations,
        ),
        benchmarkMeasurement('hot-query-process-cpu', 'milliseconds', queryCpuDurations),
        benchmarkMeasurement('hot-exact-ready-query-orchestration', 'milliseconds', exactReadyQueryDurations),
        benchmarkMeasurement(
          'hot-exact-ready-query-orchestration-process-cpu',
          'milliseconds',
          exactReadyQueryCpuDurations,
        ),
        benchmarkMeasurement('hot-deferred-ready-query-orchestration', 'milliseconds', deferredQueryDurations),
        benchmarkMeasurement(
          'hot-deferred-ready-query-orchestration-process-cpu',
          'milliseconds',
          deferredQueryCpuDurations,
        ),
        benchmarkMeasurement('whole-graph-structural-analysis', 'milliseconds', analysisDurations),
        benchmarkMeasurement('whole-graph-structural-analysis-process-cpu', 'milliseconds', analysisCpuDurations),
        ...EffectArray.flatMap([...analysisStageTimings], ([stage, samples]) => [
          benchmarkMeasurement(`whole-graph-structural-analysis-${stage}`, 'milliseconds', samples.wall),
          benchmarkMeasurement(`whole-graph-structural-analysis-${stage}-process-cpu`, 'milliseconds', samples.cpu),
        ]),
        benchmarkMeasurement('first-repository-status-read', 'milliseconds', [coldStatusDuration]),
        benchmarkMeasurement('hot-repository-status-read', 'milliseconds', repositoryStatusDurations),
        benchmarkMeasurement('hot-build-sidecar-status-read', 'milliseconds', sidecarStatusDurations),
        benchmarkMeasurement('cold-process-cpu-user', 'milliseconds', [coldCpu.user]),
        benchmarkMeasurement('cold-process-cpu-system', 'milliseconds', [coldCpu.system]),
        benchmarkMeasurement('cold-process-cpu-total', 'milliseconds', [coldCpu.total]),
        benchmarkMeasurement('incremental-process-cpu-user', 'milliseconds', [incrementalCpu.user]),
        benchmarkMeasurement('incremental-process-cpu-system', 'milliseconds', [incrementalCpu.system]),
        benchmarkMeasurement('incremental-process-cpu-total', 'milliseconds', [incrementalCpu.total]),
        benchmarkMeasurement('cold-process-peak-rss', 'bytes', [coldProcessFinished.peakRssBytes]),
        benchmarkMeasurement('cold-process-boundary-rss', 'bytes', [coldProcessFinished.rssBytes]),
        benchmarkMeasurement('incremental-process-peak-rss', 'bytes', [incrementalProcessFinished.peakRssBytes]),
        benchmarkMeasurement('incremental-process-boundary-rss', 'bytes', [incrementalProcessFinished.rssBytes]),
        benchmarkMeasurement('sqlite-main-disk', 'bytes', [storage.sqliteMainBytes]),
        benchmarkMeasurement('sqlite-wal-disk', 'bytes', [storage.sqliteWalBytes]),
        benchmarkMeasurement('sqlite-shm-disk', 'bytes', [storage.sqliteShmBytes]),
        benchmarkMeasurement('sqlite-journal-disk', 'bytes', [storage.sqliteJournalBytes]),
        benchmarkMeasurement('cold-sqlite-durable-database-growth', 'bytes', [
          Math.max(0, coldStorageAfter.sqliteMainBytes - coldStorageBaseline.sqliteMainBytes),
        ]),
        benchmarkMeasurement('cold-durable-filesystem-growth', 'bytes', [
          Math.max(0, coldStorageAfter.totalBytes - coldStorageBaseline.totalBytes),
        ]),
        benchmarkMeasurement('cold-sqlite-main-peak-observed', 'bytes', [
          codeGraphBenchmarkSqlitePeak(coldStoragePeak.sqliteMainBytes, coldExternalTelemetry, 'databasePeakBytes'),
        ]),
        benchmarkMeasurement('cold-sqlite-wal-peak-observed', 'bytes', [
          codeGraphBenchmarkSqlitePeak(coldStoragePeak.sqliteWalBytes, coldExternalTelemetry, 'walPeakBytes'),
        ]),
        benchmarkMeasurement('cold-sqlite-shm-peak-observed', 'bytes', [
          codeGraphBenchmarkSqlitePeak(coldStoragePeak.sqliteShmBytes, coldExternalTelemetry, 'shmPeakBytes'),
        ]),
        benchmarkMeasurement('cold-sqlite-journal-peak-observed', 'bytes', [
          codeGraphBenchmarkSqlitePeak(coldStoragePeak.sqliteJournalBytes, coldExternalTelemetry, 'journalPeakBytes'),
        ]),
        benchmarkMeasurement('incremental-sqlite-main-peak-observed', 'bytes', [
          codeGraphBenchmarkSqlitePeak(
            incrementalStoragePeak.sqliteMainBytes,
            incrementalExternalTelemetry,
            'databasePeakBytes',
          ),
        ]),
        benchmarkMeasurement('incremental-sqlite-wal-peak-observed', 'bytes', [
          codeGraphBenchmarkSqlitePeak(
            incrementalStoragePeak.sqliteWalBytes,
            incrementalExternalTelemetry,
            'walPeakBytes',
          ),
        ]),
        benchmarkMeasurement('incremental-sqlite-shm-peak-observed', 'bytes', [
          codeGraphBenchmarkSqlitePeak(
            incrementalStoragePeak.sqliteShmBytes,
            incrementalExternalTelemetry,
            'shmPeakBytes',
          ),
        ]),
        benchmarkMeasurement('incremental-sqlite-journal-peak-observed', 'bytes', [
          codeGraphBenchmarkSqlitePeak(
            incrementalStoragePeak.sqliteJournalBytes,
            incrementalExternalTelemetry,
            'journalPeakBytes',
          ),
        ]),
        benchmarkMeasurement('same-overlay-reference-sqlite-main-peak-observed', 'bytes', [
          codeGraphBenchmarkSqlitePeak(
            sameOverlayReferenceStoragePeak.sqliteMainBytes,
            sameOverlayReferenceTelemetry,
            'databasePeakBytes',
          ),
        ]),
        benchmarkMeasurement('same-overlay-reference-sqlite-wal-peak-observed', 'bytes', [
          codeGraphBenchmarkSqlitePeak(
            sameOverlayReferenceStoragePeak.sqliteWalBytes,
            sameOverlayReferenceTelemetry,
            'walPeakBytes',
          ),
        ]),
        benchmarkMeasurement('same-overlay-reference-sqlite-shm-peak-observed', 'bytes', [
          codeGraphBenchmarkSqlitePeak(
            sameOverlayReferenceStoragePeak.sqliteShmBytes,
            sameOverlayReferenceTelemetry,
            'shmPeakBytes',
          ),
        ]),
        benchmarkMeasurement('same-overlay-reference-sqlite-journal-peak-observed', 'bytes', [
          codeGraphBenchmarkSqlitePeak(
            sameOverlayReferenceStoragePeak.sqliteJournalBytes,
            sameOverlayReferenceTelemetry,
            'journalPeakBytes',
          ),
        ]),
        ...(coldExternalTelemetry
          ? [
              benchmarkMeasurement('cold-sqlite-temp-peak-observed', 'bytes', [
                externalTelemetryPeak(coldExternalTelemetry, 'temporaryPeakBytes'),
              ]),
            ]
          : []),
        ...(incrementalExternalTelemetry
          ? [
              benchmarkMeasurement('incremental-sqlite-temp-peak-observed', 'bytes', [
                externalTelemetryPeak(incrementalExternalTelemetry, 'temporaryPeakBytes'),
              ]),
            ]
          : []),
        benchmarkMeasurement('vector-index-disk', 'bytes', [storage.vectorBytes]),
        benchmarkMeasurement('build-status-sidecar-disk', 'bytes', [storage.buildStatusBytes]),
        benchmarkMeasurement('derived-index-unclassified-disk', 'bytes', [storage.unclassifiedRepositoryBytes]),
        benchmarkMeasurement('derived-index-disk', 'bytes', [storage.totalBytes]),
        benchmarkMeasurement('cold-lexical-term-rows', 'count', [coldLexicalTermRows]),
        benchmarkMeasurement('vector-rows', 'count', [vectorRows]),
        benchmarkMeasurement('cold-materialized-file-rows', 'count', [cold.snapshot.fileCount]),
        benchmarkMeasurement('cold-materialized-symbol-rows', 'count', [cold.snapshot.symbolCount]),
        benchmarkMeasurement('cold-materialized-edge-rows', 'count', [cold.snapshot.edgeCount]),
        benchmarkMeasurement('cold-materialized-lexical-term-rows', 'count', [coldLexicalTermRows]),
        benchmarkMeasurement('cold-language-category-count', 'count', [coldLanguageCounts.length]),
        ...languageAggregateMeasurements('cold', coldLanguageCounts),
        benchmarkMeasurement('cold-workspace-scope-rows', 'count', [coldWorkspaceScopeRows]),
        benchmarkMeasurement('cold-workspace-component-rows', 'count', [coldWorkspaceComponentRows]),
        benchmarkMeasurement('cold-bazel-workspace-scope-rows', 'count', [coldBazelWorkspaceScopeRows]),
        benchmarkMeasurement('cold-bazel-workspace-component-rows', 'count', [coldBazelWorkspaceComponentRows]),
        benchmarkMeasurement('one-file-reindex-materialization-staged-files', 'count', [
          incremental.materialization?.stagedFiles ?? 0,
        ]),
        benchmarkMeasurement('one-file-reindex-materialization-total-files', 'count', [
          incremental.materialization?.totalFiles ?? 0,
        ]),
        benchmarkMeasurement('one-file-reindex-incremental-work-attribution-context-files-n1', 'count', [
          incremental.incrementalWork?.attributionContextFiles ?? 0,
        ]),
        benchmarkMeasurement('one-file-reindex-incremental-work-base-facts-loaded-n1', 'count', [
          incremental.incrementalWork?.baseFactsLoaded ?? 0,
        ]),
        benchmarkMeasurement('one-file-reindex-incremental-work-changed-files-n1', 'count', [
          incremental.incrementalWork?.changedFiles ?? 0,
        ]),
        benchmarkMeasurement('one-file-reindex-incremental-work-deleted-files-n1', 'count', [
          incremental.incrementalWork?.deletedFiles ?? 0,
        ]),
        benchmarkMeasurement('one-file-reindex-incremental-work-fact-bytes-n1', 'bytes', [
          incremental.incrementalWork?.factBytes ?? 0,
        ]),
        benchmarkMeasurement('one-file-reindex-incremental-work-inventory-files-inspected-n1', 'count', [
          incremental.incrementalWork?.inventoryFilesInspected ?? 0,
        ]),
        benchmarkMeasurement('one-file-reindex-incremental-work-planned-rows-n1', 'count', [
          incremental.incrementalWork?.plannedRows ?? 0,
        ]),
        benchmarkMeasurement('one-file-reindex-incremental-work-probed-dependency-paths-n1', 'count', [
          incremental.incrementalWork?.probedDependencyPaths ?? 0,
        ]),
        benchmarkMeasurement('one-file-reindex-incremental-work-source-bytes-n1', 'bytes', [
          incremental.incrementalWork?.sourceBytes ?? 0,
        ]),
        benchmarkMeasurement('one-file-reindex-incremental-work-total-files-n1', 'count', [
          incremental.incrementalWork?.totalFiles ?? 0,
        ]),
        benchmarkMeasurement('cold-primary-query-returned-nodes', 'count', [coldPrimaryQueryEvidence.returnedNodes]),
        benchmarkMeasurement('one-file-reindex-primary-query-returned-nodes', 'count', [
          incrementalPrimaryQueryEvidence.returnedNodes,
        ]),
        benchmarkMeasurement('same-overlay-full-rebuild-index', 'milliseconds', [
          Number(sameOverlayReference.indexFinished - sameOverlayReferenceStarted) / NANOSECONDS_PER_MILLISECOND,
        ]),
        benchmarkMeasurement('same-overlay-full-rebuild-primary-query-returned-nodes', 'count', [
          sameOverlayReference.primary.returnedNodes,
        ]),
        benchmarkMeasurement('cold-to-incremental-primary-query-structural-parity', 'count', [
          coldPrimaryQueryEvidence.digest === incrementalPrimaryQueryEvidence.digest ? 1 : 0,
        ]),
        benchmarkMeasurement('primary-query-structural-parity', 'count', [
          incrementalPrimaryQueryEvidence.digest === sameOverlayReference.primary.digest ? 1 : 0,
        ]),
        benchmarkMeasurement('semantic-overlay-structural-graph-change', 'count', [
          coldStructuralGraphDigest === incrementalStructuralGraphDigest ? 0 : 1,
        ]),
        benchmarkMeasurement('structural-graph-digest-parity', 'count', [
          incrementalStructuralGraphDigest === sameOverlayReferenceStructuralGraphDigest ? 1 : 0,
        ]),
        ...externalQueryControlMeasurements('cold', coldExternalQueryControls),
        ...externalQueryControlMeasurements('incremental', incrementalExternalQueryControls),
        ...externalQueryControlMeasurements('same-overlay-reference', sameOverlayReference.controls),
        ...externalQueryControlParityMeasurements(incrementalExternalQueryControls, sameOverlayReference.controls),
        ...mcpOperationMatrixMeasurements(mcpOperationMatrix),
        ...managerPerformanceMeasurements(managerPerformance),
        ...concurrentWorktreeMeasurements(concurrentWorktreeEvidence),
        ...(prepared.profile
          ? productionShapeMeasurements(prepared.profile, {
              edges: cold.snapshot.edgeCount,
              files: cold.snapshot.fileCount,
              skipped: cold.skippedFiles,
              symbols: cold.snapshot.symbolCount,
              terms: coldLexicalTermRows,
            })
          : []),
      ],
      metadata: {
        activationMeasurement:
          'privacy-safe completed-stage duration and row counts; unobserved optional stages are retained as zero',
        coldEdges: cold.snapshot.edgeCount,
        coldFiles: cold.snapshot.fileCount,
        coldSkippedFiles: cold.skippedFiles,
        coldMaterializationStorageMode: coldMaterializationStorage?.materializationMode ?? 'unreported',
        coldSymbols: cold.snapshot.symbolCount,
        incrementalReusedFiles: incremental.reusedFiles,
        oneFileReindexMaterializationMode: incremental.materialization?.mode ?? 'unreported',
        oneFileReindexMaterializationStorageMode:
          incrementalMaterializationStorage?.materializationMode ?? 'unreported',
        oneFileReindexStagedFiles: incremental.materialization?.stagedFiles ?? 0,
        oneFileReindexTotalFiles: incremental.materialization?.totalFiles ?? 0,
        ...(incremental.materialization?.fallbackReason
          ? {oneFileReindexFallbackReason: incremental.materialization.fallbackReason}
          : {}),
        analysisSamples: analysisDurations.length,
        analysisLeaseDiagnostics: JSON.stringify({
          version: 1,
          samples: analysisLeaseTraces,
          interpretation:
            'Paired nested diagnostic boundaries per original sample; not assessed metrics. Writer-gate minus session separates lock acquisition/release; session minus body separates SQLite open/close. Includes observer overhead.',
        }),
        analysisCoverage: 'complete',
        ...(coldRegistrationDiagnostics === undefined
          ? {}
          : {coldRegistrationExistingSpans: coldRegistrationDiagnostics}),
        coldIndexSamples: 1,
        ...(coldVectorMappingDigest === undefined ? {} : {coldVectorMappingDigest}),
        cpuMeasurement: 'process.cpuUsage delta at operation boundary',
        completionTimingMeasurement:
          'opt-in path-free stage boundaries; index count/sum/maximum are n=1 aggregates, nested stages overlap; lease releases after activation completion remain included; analysis stages retain the original three samples',
        deferredReadyQueryMeasurement:
          'status + inspect + compact MCP serialization with worktree observation explicitly deferred; excludes maintenance, watcher bookkeeping, and MCP transport',
        effectiveParserMemoryBytes: hardware.effectiveMemoryBytes,
        effectiveParserWorkers,
        environmentOverrides: JSON.stringify(benchmarkEnvironmentProvenance()),
        ...(embeddingContextPlan === undefined
          ? {}
          : {
              embeddingContextCpuMathCores: embeddingContextPlan.cpuMathCores,
              embeddingContextPoolSizeEffective: embeddingContextPlan.effectiveContexts,
              embeddingContextPoolSizeRequested: embeddingContextPlan.requestedContexts,
              embeddingContextThreadCounts:
                embeddingContextPlan.threadCounts.length === 0
                  ? 'upstream-default'
                  : EffectArray.join(
                      EffectArray.map(embeddingContextPlan.threadCounts, item =>
                        item === null || item === undefined ? '' : String(item),
                      ),
                      ',',
                    ),
              ...(embeddingContextPlan.modelGpuLayers === undefined
                ? {}
                : {embeddingModelGpuLayers: embeddingContextPlan.modelGpuLayers}),
            }),
        diskMeasurement:
          'final bytes plus SQLite main/WAL/SHM peaks sampled at progress boundaries; vectors, sidecar, and unclassified bytes separate',
        incrementalIndexSamples: 1,
        inventorySubphaseMeasurement:
          'cumulative source reading, summed parser extraction, parser-fact serialization, and cache-persistence wall time; summed parser work can overlap',
        materializationMeasurement:
          'aggregate phase duration plus stage-attributed SQLite wall time, process CPU, boundary RSS, and row counts; no repository paths or source content',
        materializationSubphaseMeasurement:
          'inclusive attribution retained for continuity plus separately measured compute, serialization, shard persistence, shard association, and fact-batch preparation wall time',
        mcpOperationCount: mcpOperationMatrix.length,
        mcpOperationMeasurement:
          'status + inspect + compact serialization for query, node, neighbors, explain, impact, and path; excludes maintenance, watcher bookkeeping, and MCP transport; no graph content retained',
        ...(coldMaterializationStorage?.estimateBasis
          ? {coldMaterializationEstimateBasis: coldMaterializationStorage.estimateBasis}
          : {}),
        materializationStorageEstimateMeasurement:
          'warning-only cached-fact planning split across actual SQLite TEMP and durable graph filesystems, including one concurrent-build allowance',
        languageAggregateMeasurement:
          'privacy-safe cold snapshot file and symbol row counts grouped only by normalized language category',
        observedBuildStatusRecords: observedStatusRecords,
        percentileInterpretation:
          'samples=1 is one observation; p50/p95/p99 fields are identical summaries, not percentile estimates',
        observationLabel:
          'Cold index, incremental index, and every per-phase measurement are n=1 observations, not statistical estimates.',
        phaseMeasurement: 'first progress transition and explicit subphase completion boundaries',
        primaryQueryStructuralDigestCold: coldPrimaryQueryEvidence.digest,
        primaryQueryStructuralDigestIncremental: incrementalPrimaryQueryEvidence.digest,
        primaryQueryStructuralDigestSameOverlayReference: sameOverlayReference.primary.digest,
        queries:
          options.repository !== undefined
            ? (prepared.externalControls?.length ?? 0)
            : options.scaleSymbols === undefined && prepared.profile === undefined
              ? fixture.queries.length
              : 1,
        retrievalMode: options.vectors ? 'pinned-production-vectors' : 'lexical-only',
        ...(largeEvidenceRun && releaseEvidenceSource
          ? {
              releaseEvidenceRef: releaseEvidenceSource.ref,
              releaseEvidenceHarnessCommit: releaseEvidenceSource.harnessCommit,
              releaseEvidenceHarnessDeltaPaths: releaseEvidenceSource.harnessDeltaPaths,
              releaseEvidenceResolvedSha: releaseEvidenceSource.resolvedSha,
              releaseEvidenceSha: releaseEvidenceSource.sha,
              releaseEvidenceSourceMode: releaseEvidenceSource.sourceMode,
            }
          : {}),
        ...(runtimeProvenance ? benchmarkRuntimeProvenanceMetadata(runtimeProvenance) : {}),
        rssMeasurement:
          'boundary RSS plus process-lifetime resourceUsage.maxRSS normalized to bytes; ' +
          'Bun 1.4.2 and Node report KiB and are multiplied by 1024; legacy Bun 1.3 Darwin reports bytes; ' +
          'peak is cumulative, not phase-isolated',
        statusSamples,
        sqliteDurableStorageMeasurement:
          'SQLite durable database allocated-page high-water from direct materialization progress; WAL and SHM remain separately sampled filesystem artifacts',
        sqliteTemporaryStorageMeasurement:
          'SQLite TEMP database allocated-page high-water from materialization progress; excludes rollback journals and subjournals and remains separate from the filesystem sampler',
        sqlitePageSizeBytes,
        sqliteVersion,
        ...(options.materializationTransactionBatchLimit === undefined
          ? {}
          : {materializationTransactionBatchLimit: options.materializationTransactionBatchLimit}),
        ...(options.sqliteWriterProfile && sqliteWriterProfile
          ? {
              sqliteWriterEffectiveSettings: JSON.stringify(sqliteWriterSettingsEvidence),
              sqliteWriterProfile: options.sqliteWriterProfile,
              sqliteWriterProfileDescription: sqliteWriterProfile.description,
              sqliteWriterRequestedTuning: JSON.stringify(sqliteWriterProfile.tuning),
            }
          : {}),
        structuralGraphDigestCold: coldStructuralGraphDigest,
        structuralGraphDigestIncremental: incrementalStructuralGraphDigest,
        structuralGraphDigestSameOverlayReference: sameOverlayReferenceStructuralGraphDigest,
        structuralGraphDigestMeasurement:
          'leased, single-read-transaction canonical SHA-256 over privacy-safe effective files, symbols, terms, lookup keys, edges, workspace, re-export, and analysis rows; incremental parity compares with an independent fresh-home full rebuild of the same overlay',
        sameOverlayReferenceMaterializationMode: sameOverlayReference.summary.materialization?.mode ?? 'unreported',
        sameOverlayReferenceMaterializationStorageMode:
          sameOverlayReferenceMaterializationStorage?.materializationMode ?? 'unreported',
        sameRunnerComparisonKey: benchmarkComparisonKey({
          architecture: system.architecture,
          cpu: hardware.cpuModel,
          memoryBytes: hardware.memoryBytes,
          operatingSystem: hardware.operatingSystem,
          runnerClass: benchmarkRunnerLabel('THREADNOTE_BENCHMARK_RUNNER_CLASS', 'local-unclassified'),
        }),
        runnerClass: benchmarkRunnerLabel('THREADNOTE_BENCHMARK_RUNNER_CLASS', 'local-unclassified'),
        runnerIdentity: benchmarkRunnerLabel('THREADNOTE_BENCHMARK_RUNNER_ID', 'local'),
        runtimePlatform: system.platform,
        sampler: sampleProcessTree
          ? externalSamplerDescription(coldExternalTelemetry ?? bootstrapExternalTelemetry)
          : 'progress-boundary storage sampling',
        vectorEnabled: options.vectors,
        vectorRows,
        ...(embeddingModelId ? {embeddingModelId} : {}),
        ...(options.scaleSymbols === undefined ? {} : {scaleSymbols: options.scaleSymbols}),
        ...(prepared.externalCommit
          ? {
              benchmarkDiskFilesystem: storageEnvironment?.filesystem ?? 'unknown',
              benchmarkDiskLocation: storageEnvironment?.location ?? 'unknown',
              benchmarkDiskMedium: storageEnvironment?.medium ?? 'unknown',
              benchmarkInventoryEligibleFiles: coldTimeline.inventoryEligibleFiles(),
              benchmarkInventoryExcludedFiles: coldTimeline.inventoryExcludedFiles(),
              benchmarkLogicalCpuCount: navigator.hardwareConcurrency,
              externalBenchmarkHomesRetained: options.retainHomes,
              externalControlCount: prepared.externalControls?.length ?? 0,
              externalControlEvidence: retainedExternalControlEvidence(
                prepared.externalControls ?? [],
                coldExternalQueryControls,
              ),
              externalControlLanguages:
                Option.getOrUndefined(
                  Option.map(
                    Option.fromNullishOr(
                      Option.getOrUndefined(
                        Option.map(Option.fromNullishOr(prepared.externalControls), __effectArrayReceiver =>
                          EffectArray.map(__effectArrayReceiver, control => control.expectedLanguage),
                        ),
                      ),
                    ),
                    __effectArrayJoinReceiver => EffectArray.join(__effectArrayJoinReceiver, ','),
                  ),
                ) ?? '',
              externalQueryPositiveControl:
                'every cold and incremental control returned its expected tracked public path and language; reviewed public controls retained',
              externalRepositoryCommit: prepared.externalCommit,
              externalRepositoryMode: 'clean checkout with a byte-compared, scoped one-file overlay',
              externalRepositoryName: prepared.publicRepository?.name ?? '',
              externalRepositoryPublicVerification: prepared.publicRepositoryVerification ?? '',
              externalRepositoryUrl: prepared.publicRepository?.url ?? '',
              externalSemanticOverlay:
                'language-aware import or dependency with effective-state digest change enforcement',
              externalWorkspaceAggregate:
                'cold total and Bazel workspace scope/component counts; local roots omitted and public GitHub identity retained',
              managerEdgeBudget: managerPerformance?.edgeBudget ?? 0,
              managerDetailEdgeCount: managerPerformance?.detailEdgeCount ?? 0,
              managerDetailNodeCount: managerPerformance?.detailNodeCount ?? 0,
              managerLayoutPreparationMeasurement:
                'client-side graph layout-preparation only; excludes browser and WebGL paint',
              managerNodeBudget: managerPerformance?.nodeBudget ?? 0,
              managerOverviewEdgeCount: managerPerformance?.overviewEdgeCount ?? 0,
              managerOverviewNodeCount: managerPerformance?.overviewNodeCount ?? 0,
              managerRequestCancellationPassed: managerPerformance?.requestCancellationPassed ?? false,
              managerRequestLifecycleControl:
                'real Manager queries through the GraphWorkspace request gate: superseding aborts an in-flight request; a completed late response is rejected',
              managerSequenceTimeoutMilliseconds: MANAGER_SEQUENCE_TIMEOUT_MS,
              managerServiceResponseTimingIncludesSerialization: true,
              managerSnapshotBindingPassed: managerPerformance?.snapshotBindingPassed ?? false,
              managerStaleResponseRejectionPassed: managerPerformance?.staleResponseRejectionPassed ?? false,
              externalQueryControlTimeoutMilliseconds: EXTERNAL_QUERY_CONTROL_TIMEOUT_MS,
              simultaneousWorktrees: concurrentWorktreeEvidence?.simultaneousWorktrees ?? 0,
              worktreeIsolationCleanupPassed: concurrentWorktreeEvidence?.cleanupPassed ?? false,
              worktreeIsolationCommandTimeoutMilliseconds: WORKTREE_GIT_COMMAND_TIMEOUT_MS,
              worktreeIsolationIndexedFiles: concurrentWorktreeEvidence?.indexedFiles ?? 0,
              worktreeIsolationOuterTimeoutMilliseconds: WORKTREE_ISOLATION_TIMEOUT_MS,
              worktreeIsolationPassed: concurrentWorktreeEvidence?.isolationPassed ?? false,
              worktreeIsolationTopology: concurrentWorktreeEvidence?.topology ?? '',
            }
          : {}),
        ...(prepared.profile ? productionProfileArtifactMetadata(prepared.profile) : {}),
        ...(productionGovernance
          ? {
              benchmarkDiskFilesystem: productionGovernance.primaryStorage.filesystem,
              benchmarkDiskLocation: productionGovernance.primaryStorage.location,
              benchmarkDiskMedium: productionGovernance.primaryStorage.medium,
              benchmarkFilesystemsShared: productionGovernance.filesystemsShared,
              benchmarkGoverned: true,
              benchmarkMinimumFreeBytes: productionGovernance.minimumFreeBytes,
              benchmarkPrimaryAvailableBytesAtStart: productionGovernance.primaryAvailableBytes,
              benchmarkReferenceAvailableBytesAtStart: productionGovernance.referenceAvailableBytes,
              benchmarkReferenceDiskFilesystem: productionGovernance.referenceStorage.filesystem,
              benchmarkReferenceDiskLocation: productionGovernance.referenceStorage.location,
              benchmarkReferenceDiskMedium: productionGovernance.referenceStorage.medium,
            }
          : {}),
      },
      suite: prepared.externalCommit
        ? 'code-graph-external-repository-v1'
        : prepared.profile
          ? options.vectors
            ? 'code-graph-production-large-vectors-v2'
            : 'code-graph-production-large-v2'
          : options.vectors
            ? 'code-graph-vectors-v1'
            : options.scaleSymbols === undefined
              ? options.fixture
              : 'code-graph-scale-v1',
      version: BENCHMARK_ARTIFACT_VERSION,
      warmups: options.warmups,
    };
    if (prepared.externalCommit) {
      artifact = {...artifact, metadata: projectExternalEvidenceMetadata(artifact.metadata)};
    }
    parseBenchmarkArtifactV1(artifact);
    if (prepared.profile) {
      if (releaseEvidenceSource) {
        if (isGovernedReducedProductionProfile(artifact)) {
          assertGovernedReducedProductionReleaseEvidence(artifact);
        } else {
          assertProductionReleaseEvidence(artifact);
        }
      } else {
        assertProductionLargeEvidence(artifact);
      }
    }
    if (prepared.externalCommit) {
      assertExternalRepositoryEvidence(artifact);
      if (releaseEvidenceSource) assertExternalPerformanceEvidence(artifact);
    }
    let budgetFailure: ScriptError | undefined;
    if (options.failOnBudget) {
      const budgetPath = yield* path.fromFileUrl(
        new URL(`../apps/threadnote/test/evaluation/baselines/${options.fixture}/budgets.json`, import.meta.url),
      );
      const budget = yield* readJsonFile(budgetPath);
      budgetFailure = yield* Effect.try({
        catch: cause => scriptError(cause, 'Code graph performance budget failed.'),
        try: () => enforceCodeGraphBenchmarkBudget(artifact, budget, options.scaleSymbols),
      }).pipe(
        Effect.match({
          onFailure: failure => failure,
          onSuccess: () => undefined,
        }),
      );
    }
    const ratchetFailure =
      ratchet === undefined
        ? undefined
        : yield* Effect.try({
            catch: cause => scriptError(cause, 'Code graph performance ratchet failed.'),
            try: () => enforceCodeGraphBenchmarkRatchet(artifact, ratchet),
          }).pipe(
            Effect.match({
              onFailure: failure => failure,
              onSuccess: () => undefined,
            }),
          );
    if (runtimeProvenanceRequired) {
      const finalRuntimeProvenance = yield* validateBenchmarkRuntimeProvenance(threadnoteSourceRoot);
      if (JSON.stringify(finalRuntimeProvenance) !== JSON.stringify(runtimeProvenance)) {
        return yield* ScriptError.make({
          message: 'Threadnote benchmark runtime provenance changed during the measured run.',
        });
      }
    }
    if (prepared.externalCommit) {
      yield* verifyExternalRepositoryUnchanged(prepared.repository, prepared.externalCommit);
      if (prepared.publicRepository) {
        yield* verifyPublicRepositoryOrigin(
          prepared.repository,
          prepared.publicRepository,
          prepared.publicRepositoryVerification,
          prepared.externalCommit,
        );
      }
      yield* verifyBenchmarkSourceUnchanged(threadnoteSourceRoot, commit);
    }
    if (options.outputPath) yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    if (budgetFailure) return yield* budgetFailure;
    if (ratchetFailure) return yield* ratchetFailure;
    if (!options.quiet) yield* printJson(artifact);
  }),
);

export function directoryBytes(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
): Effect.Effect<number, unknown> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(directory))) return 0;
    let bytes = 0;
    for (const name of yield* fs.readDirectory(directory)) {
      const child = path.join(directory, name);
      const info = yield* fs.stat(child).pipe(
        Effect.asSome,
        Effect.catchIf(
          error => error instanceof PlatformError.PlatformError && error.reason._tag === 'NotFound',
          () => Effect.succeedNone,
        ),
      );
      if (Option.isNone(info)) continue;
      if (info.value.type === 'Directory') bytes += yield* directoryBytes(fs, path, child);
      else if (info.value.type === 'File') bytes += Number(info.value.size);
    }
    return bytes;
  }).pipe(
    Effect.catchIf(
      error => error instanceof PlatformError.PlatformError && error.reason._tag === 'NotFound',
      () => Effect.succeed(0),
    ),
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

export function decodeBenchmarkSource(source: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(source);
  } catch {
    throw ScriptError.make({
      message: 'The incremental benchmark source must be valid UTF-8 so it can be restored byte-for-byte.',
    });
  }
}

export const applyBenchmarkOverlay = Effect.fn('benchmarkCodeGraph.applyOverlay')(function* (
  fs: FileSystem.FileSystem,
  file: string,
  expectedContents: Uint8Array,
  benchmarkContents: Uint8Array,
) {
  const current = yield* fs.readFile(file);
  if (!sameBytes(current, expectedContents)) {
    return yield* ScriptError.make({
      message: 'The benchmark overlay file changed concurrently; Threadnote left the newer contents untouched.',
    });
  }
  yield* fs.writeFile(file, benchmarkContents);
});

export const restoreBenchmarkOverlay = Effect.fn('benchmarkCodeGraph.restoreOverlay')(function* (
  fs: FileSystem.FileSystem,
  file: string,
  benchmarkContents: Uint8Array,
  originalContents: Uint8Array,
) {
  const current = yield* fs.readFile(file);
  if (!sameBytes(current, benchmarkContents)) {
    return yield* ScriptError.make({
      message: 'The benchmark overlay file changed concurrently; Threadnote left the newer contents untouched.',
    });
  }
  yield* fs.writeFile(file, originalContents);
});

/**
 * A benchmark overlay must change extracted graph structure, not only bytes.
 * Keep the import/dependency harmless, deterministic, and valid for the source
 * language. It changes graph evidence while preserving the file's symbol
 * resolution surface, so the benchmark exercises the real incremental path.
 */
export function semanticBenchmarkOverlay(filePath: string, source: string): string {
  const normalized = Effect2.pipe(filePath, EffectString.replaceAll('\\', '/'), EffectString.toLowerCase);
  if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs)$/.test(normalized)) {
    return insertAfterInterpreter(source, "import 'threadnote-benchmark-overlay';");
  }
  if (/\.cjs$/.test(normalized)) return appendStatement(source, "require('threadnote-benchmark-overlay');");
  if (/\.(?:kt|kts)$/.test(normalized)) {
    return insertAfterPackage(source, 'import threadnote.benchmark.overlay');
  }
  if (/\.java$/.test(normalized)) {
    return insertAfterPackage(source, 'import threadnote.benchmark.Overlay;');
  }
  if (/\.swift$/.test(normalized)) return insertAfterInterpreter(source, 'import ThreadnoteBenchmarkOverlay');
  if (/\.go$/.test(normalized)) return insertAfterPackage(source, 'import _ "threadnote/benchmark/overlay"');
  if (/\.rs$/.test(normalized)) return insertAfterRustPreamble(source, 'use threadnote_benchmark_overlay as _;');
  if (/\.(?:c|cc|cpp|cxx|h|hh|hpp)$/.test(normalized)) {
    return insertAfterBom(source, '#include <threadnote_benchmark_overlay.h>');
  }
  if (/\.py$/.test(normalized)) return appendStatement(source, '__import__("threadnote_benchmark_overlay")');
  if (/(?:^|\/)(?:build(?:\.bazel)?|workspace(?:\.bazel)?|module\.bazel|[^/]+\.(?:bzl|axl))$/.test(normalized)) {
    return insertAfterBom(source, 'load("@threadnote_benchmark_overlay//:defs.bzl", "threadnote_benchmark_overlay")');
  }
  throw ScriptError.make({message: 'The incremental benchmark path must use a supported source language.'});
}

function sourceNewline(source: string): '\n' | '\r\n' {
  return Effect2.pipe(source, EffectString.includes('\r\n')) ? '\r\n' : '\n';
}

function appendStatement(source: string, statement: string): string {
  const newline = sourceNewline(source);
  return `${source}${Effect2.pipe(source, EffectString.endsWith('\n')) ? '' : newline}${statement}${newline}`;
}

function insertAfterBom(source: string, statement: string): string {
  const newline = sourceNewline(source);
  const offset = Effect2.pipe(source, EffectString.startsWith('\uFEFF')) ? 1 : 0;
  return `${Effect2.pipe(source, EffectString.slice(0, offset))}${statement}${newline}${Effect2.pipe(source, EffectString.slice(offset))}`;
}

function insertAfterInterpreter(source: string, statement: string): string {
  const bomOffset = Effect2.pipe(source, EffectString.startsWith('\uFEFF')) ? 1 : 0;
  if (!Effect2.pipe(source, EffectString.startsWith('#!', bomOffset))) return insertAfterBom(source, statement);
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
  const lineEnd = source.indexOf('\n', bomOffset);
  if (lineEnd < 0) return `${source}${sourceNewline(source)}${statement}${sourceNewline(source)}`;
  return `${Effect2.pipe(source, EffectString.slice(0, lineEnd + 1))}${statement}${sourceNewline(source)}${Effect2.pipe(source, EffectString.slice(lineEnd + 1))}`;
}

function insertAfterPackage(source: string, statement: string): string {
  const packageLine = /^[\t ]*package(?:[\t ]+[^\r\n;]+;?)[\t ]*$/m.exec(source);
  if (!packageLine || packageLine.index === undefined) return insertAfterBom(source, statement);
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
  const lineEnd = source.indexOf('\n', packageLine.index + packageLine[0].length);
  const offset = lineEnd < 0 ? source.length : lineEnd + 1;
  const separator = lineEnd < 0 && !Effect2.pipe(source, EffectString.endsWith('\n')) ? sourceNewline(source) : '';
  return `${Effect2.pipe(source, EffectString.slice(0, offset))}${separator}${statement}${sourceNewline(source)}${Effect2.pipe(source, EffectString.slice(offset))}`;
}

function insertAfterRustPreamble(source: string, statement: string): string {
  const newline = sourceNewline(source);
  const bomOffset = Effect2.pipe(source, EffectString.startsWith('\uFEFF')) ? 1 : 0;
  let offset = bomOffset;
  for (const line of Effect2.pipe(source, EffectString.slice(bomOffset), EffectString.split(/(?<=\n)/))) {
    const trimmed = Effect2.pipe(line, EffectString.trim);
    if (
      !Effect2.pipe(trimmed, EffectString.startsWith('#![')) &&
      !Effect2.pipe(trimmed, EffectString.startsWith('//!'))
    )
      break;
    offset += line.length;
  }
  return `${Effect2.pipe(source, EffectString.slice(0, offset))}${statement}${newline}${Effect2.pipe(source, EffectString.slice(offset))}`;
}

type BenchmarkIndexTimingStage = Parameters<NonNullable<CodeGraphIndexOptions['onTiming']>>[0];
type BenchmarkTimingStage =
  | BenchmarkIndexTimingStage
  | Parameters<NonNullable<CodeGraphAnalysisOptions['onTiming']>>[0]
  | 'snapshot-lease-release-after-complete';

interface BenchmarkStageTiming {
  count: number;
  cpuMilliseconds: number;
  maximumWallMilliseconds: number;
  wallMilliseconds: number;
}

/** Bounded aggregate diagnostics; no paths, tokens, per-call logs, or retained start records. */
export class BenchmarkStageTimings {
  readonly #observations = new Map<BenchmarkTimingStage, BenchmarkStageTiming>();

  observe(stage: BenchmarkTimingStage): Effect.Effect<Effect.Effect<void>> {
    return Effect.gen({self: this}, function* () {
      const started = yield* Clock.currentTimeNanos;
      const cpuStarted = process.cpuUsage();
      // oxlint-disable-next-line effecttsgo/return-effect-in-gen -- Return deferred completion work for the caller to run after the measured operation.
      return Clock.currentTimeNanos.pipe(
        Effect.tap(finished =>
          Effect.sync(() => {
            const cpu = process.cpuUsage(cpuStarted);
            const wallMilliseconds = Math.max(0, Number(finished - started) / NANOSECONDS_PER_MILLISECOND);
            const previous = this.#observations.get(stage);
            this.#observations.set(stage, {
              count: (previous?.count ?? 0) + 1,
              cpuMilliseconds: (previous?.cpuMilliseconds ?? 0) + (cpu.user + cpu.system) / 1_000,
              maximumWallMilliseconds: Math.max(previous?.maximumWallMilliseconds ?? 0, wallMilliseconds),
              wallMilliseconds: (previous?.wallMilliseconds ?? 0) + wallMilliseconds,
            });
          }),
        ),
        Effect.asVoid,
      );
    });
  }

  observations(): readonly (readonly [BenchmarkTimingStage, Readonly<BenchmarkStageTiming>])[] {
    return EffectArray.map([...this.#observations], ([stage, observation]) => [stage, {...observation}] as const);
  }

  measurements(prefix: string): ReturnType<typeof benchmarkMeasurement>[] {
    return EffectArray.flatMap(this.observations(), ([stage, observation]) => [
      benchmarkMeasurement(`${prefix}-completion-${stage}-count-n1`, 'count', [observation.count]),
      benchmarkMeasurement(`${prefix}-completion-${stage}-wall-total-n1`, 'milliseconds', [
        observation.wallMilliseconds,
      ]),
      benchmarkMeasurement(`${prefix}-completion-${stage}-wall-maximum-n1`, 'milliseconds', [
        observation.maximumWallMilliseconds,
      ]),
      benchmarkMeasurement(`${prefix}-completion-${stage}-process-cpu-total-n1`, 'milliseconds', [
        observation.cpuMilliseconds,
      ]),
    ]);
  }
}

export const BENCHMARK_REGISTRATION_SPAN_NAMES = [
  'codeGraph.resolveAndRecordLocalAssociation',
  'codeGraph.resolveRepositoryIdentityDetail',
  'codeGraph.withLocalProvenanceLock',
  'codeGraph.initializeSchema',
  'codeGraph.initializeSchemaFully',
  'codeGraph.configureConnection',
  'codeGraph.observeAdmissionEnvironment',
  'codeGraph.worktreeBuildRequestObservation',
  'codeGraph.attemptSparseReusableOverlay',
  'CommandExecutor.executeBinary',
] as const;
type BenchmarkRegistrationSpanName = (typeof BENCHMARK_REGISTRATION_SPAN_NAMES)[number];
interface BenchmarkRegistrationSpanSummary {
  readonly count: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly wallTotalMilliseconds: number;
  readonly wallMaximumMilliseconds: number;
}
export interface BenchmarkRegistrationTracing {
  readonly tracer: Tracer.Tracer;
  readonly begin: (at: bigint) => void;
  readonly close: (at: bigint) => void;
  readonly snapshot: () => {
    readonly version: 1;
    readonly started: boolean;
    readonly firstScanningObserved: boolean;
    readonly partialSpans: number;
    readonly invalidSpans: number;
    readonly overflow: boolean;
    readonly spans: Readonly<Partial<Record<BenchmarkRegistrationSpanName, BenchmarkRegistrationSpanSummary>>>;
  };
}
const REGISTRATION_COUNT_MAXIMUM = 1_000_000;
const REGISTRATION_MILLISECONDS_MAXIMUM = 86_400_000;

class BenchmarkRegistrationSpan extends Tracer.NativeSpan {
  constructor(
    private readonly record: (
      name: BenchmarkRegistrationSpanName,
      start: bigint,
      end: bigint,
      success: boolean,
    ) => void,
    private readonly selected: BenchmarkRegistrationSpanName | undefined,
    startTime: bigint,
  ) {
    super({
      name: selected ?? 'ignored',
      startTime,
      parent: Option.none(),
      annotations: Context.empty(),
      links: [],
      kind: 'internal',
      sampled: true,
    });
  }
  override end(at: bigint, exit: Exit.Exit<unknown, unknown>) {
    if (this.status._tag === 'Ended') return;
    let success = false;
    try {
      if (this.selected) {
        success = exit._tag === 'Success';
        this.record(this.selected, this.startTime, at, success);
      }
    } catch {
      // Diagnostic completion cannot replace the original Effect's exit.
    }
    super.end(typeof at === 'bigint' ? at : this.startTime, success ? Exit.void : Exit.fail(undefined));
  }
  override attribute() {}
  override event() {}
  override addLinks() {}
}

/**
 * Complete spans only: crossing the first-scanning boundary is counted as partial,
 * never clipped or attributed. The full cold Effect retains tracer interposition
 * after closure; that lifecycle overhead remains inside its original measurements.
 */
export function createBenchmarkRegistrationTracing(): BenchmarkRegistrationTracing {
  let startedAt: bigint | undefined;
  let closedAt: bigint | undefined;
  let latestCompletion = 0n;
  let partialSpans = 0;
  let invalidSpans = 0;
  let overflow = false;
  const summaries = new Map<BenchmarkRegistrationSpanName, BenchmarkRegistrationSpanSummary>();
  const increment = (value: number) => {
    overflow ||= value >= REGISTRATION_COUNT_MAXIMUM;
    return Math.min(value + 1, REGISTRATION_COUNT_MAXIMUM);
  };
  const record = (name: BenchmarkRegistrationSpanName, start: bigint, end: bigint, success: boolean) => {
    if (typeof end !== 'bigint' || end < start) {
      invalidSpans = increment(invalidSpans);
      return;
    }
    if (closedAt !== undefined && end > closedAt) {
      partialSpans = increment(partialSpans);
      return;
    }
    latestCompletion = end > latestCompletion ? end : latestCompletion;
    const previous = summaries.get(name);
    if ((previous?.count ?? 0) >= REGISTRATION_COUNT_MAXIMUM) {
      overflow = true;
      return;
    }
    const delta = end - start;
    const maximumNanos = BigInt(REGISTRATION_MILLISECONDS_MAXIMUM) * 1_000_000n;
    const wall = delta > maximumNanos ? REGISTRATION_MILLISECONDS_MAXIMUM : Number(delta) / 1_000_000;
    const total = (previous?.wallTotalMilliseconds ?? 0) + wall;
    overflow ||= delta > maximumNanos || total > REGISTRATION_MILLISECONDS_MAXIMUM;
    summaries.set(name, {
      count: (previous?.count ?? 0) + 1,
      successCount: (previous?.successCount ?? 0) + Number(success),
      failureCount: (previous?.failureCount ?? 0) + Number(!success),
      wallTotalMilliseconds: Math.min(total, REGISTRATION_MILLISECONDS_MAXIMUM),
      wallMaximumMilliseconds: Math.max(previous?.wallMaximumMilliseconds ?? 0, wall),
    });
  };
  const tracer = Tracer.make({
    span(options) {
      if (startedAt === undefined || closedAt !== undefined)
        return new BenchmarkRegistrationSpan(record, undefined, 0n);
      let selected: BenchmarkRegistrationSpanName | undefined;
      let start = 0n;
      try {
        const name = options.name;
        const at = options.startTime;
        if (typeof at === 'bigint' && at >= startedAt) {
          selected = Option.getOrUndefined(
            EffectArray.findFirst(BENCHMARK_REGISTRATION_SPAN_NAMES, value => value === name),
          );
          start = at;
        }
      } catch {
        // Never inspect or retain arbitrary span metadata.
      }
      return new BenchmarkRegistrationSpan(record, selected, start);
    },
  });
  return {
    tracer,
    begin: at => {
      if (typeof at === 'bigint' && at >= 0n && startedAt === undefined) startedAt = at;
    },
    close: at => {
      if (
        typeof at === 'bigint' &&
        startedAt !== undefined &&
        closedAt === undefined &&
        at >= startedAt &&
        at >= latestCompletion
      )
        closedAt = at;
    },
    snapshot: () => ({
      version: 1,
      started: startedAt !== undefined,
      firstScanningObserved: closedAt !== undefined,
      partialSpans,
      invalidSpans,
      overflow,
      spans: EffectRecord.fromEntries(EffectArray.map([...summaries], ([name, summary]) => [name, {...summary}])),
    }),
  };
}

function registrationTracingBoundary(
  tracing: BenchmarkRegistrationTracing | undefined,
  boundary: 'begin' | 'close',
  at: bigint,
): void {
  try {
    tracing?.[boundary](at);
  } catch {
    /* Observation never owns the measured boundary. */
  }
}

export function withBenchmarkRegistrationTracing<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  tracing?: BenchmarkRegistrationTracing,
): Effect.Effect<A, E, R> {
  try {
    return tracing ? Effect.withTracer(effect, tracing.tracer) : effect;
  } catch {
    return effect;
  }
}

export function serializeBenchmarkRegistrationTracing(tracing?: BenchmarkRegistrationTracing): string | undefined {
  try {
    if (!tracing) return undefined;
    const json = JSON.stringify(tracing.snapshot());
    return json.length <= 8192 ? json : undefined;
  } catch {
    return undefined;
  }
}

type IndexPhasePoint =
  | 'activating:complete'
  | 'activating:promoting'
  | 'activating:validating-input'
  | 'activating:writing-and-checkpointing'
  | 'embedding:complete'
  | 'embedding:start'
  | 'finish'
  | 'materializing:complete'
  | 'materializing:start'
  | 'registering:start'
  | 'resolving:complete'
  | 'resolving:references'
  | 'scanning:complete'
  | 'scanning:start'
  | 'start'
  | 'waiting:start';

export class IndexPhaseTimeline {
  readonly #completionTimings = new BenchmarkStageTimings();
  #activationCompleted = false;
  readonly #activationStages = new Map<
    CodeGraphActivationActivity['stage'],
    {readonly durationMilliseconds: number; readonly rows: number}
  >();
  readonly #points = new Map<IndexPhasePoint, bigint>();
  readonly #resources = new Map<IndexPhasePoint, ProcessTelemetry>();
  #lastProgressAt: bigint;
  #inventoryEligibleFiles = 0;
  #inventoryExcludedFiles = 0;
  #inventoryCachePersistenceMilliseconds = 0;
  #inventoryParserExtractionMilliseconds = 0;
  #inventoryReadingMilliseconds = 0;
  #inventorySerializationMilliseconds = 0;
  #maximumActivationTransactionMilliseconds = 0;
  #maximumProgressHeartbeatGapMilliseconds = 0;
  #materializationDeduplicatedEdges = 0;
  #materializationDeduplicatedReferences = 0;
  #materializedLookupKeys = 0;
  #materializedReferenceCandidates = 0;
  readonly #materializationStageMilliseconds = new Map<(typeof MATERIALIZATION_STAGES)[number], number>();
  readonly #materializationSubphaseMilliseconds = new Map<keyof CodeGraphMaterializationSubphaseMilliseconds, number>();
  #materializationStorage: IndexMaterializationStorageEvidence | undefined;
  #referenceResolutionAliasesDiscovered = 0;
  #referenceResolutionLongestTransactionMilliseconds = 0;
  #referenceResolutionMatchingMilliseconds = 0;
  #referenceResolutionPagesCompleted = 0;
  #referenceResolutionPassesObserved = 0;
  #referenceResolutionReferencesExamined = 0;
  #referenceResolutionResolved = 0;
  readonly #referenceResolutionTransactionStageMilliseconds = new Map<
    (typeof RESOLUTION_TRANSACTION_STAGES)[number][0],
    number
  >();
  #referenceResolutionTransactionMilliseconds = 0;
  #sqliteDurableDatabaseHighWaterBytes = 0;
  #sqliteTemporaryDatabaseHighWaterBytes = 0;

  constructor(
    startedAt: bigint,
    telemetry: ProcessTelemetry,
    private registrationTracing?: BenchmarkRegistrationTracing,
  ) {
    this.#lastProgressAt = startedAt;
    this.#points.set('start', startedAt);
    this.#resources.set('start', telemetry);
    registrationTracingBoundary(registrationTracing, 'begin', startedAt);
  }

  observe(progress: CodeGraphProgress, at: bigint, telemetry: ProcessTelemetry): void {
    this.#observeHeartbeat(at);
    switch (progress.phase) {
      case 'registering':
        this.#activationCompleted = false;
        this.#first('registering:start', at, telemetry);
        break;
      case 'waiting':
        this.#first('waiting:start', at, telemetry);
        break;
      case 'scanning':
        if (this.registrationTracing) {
          registrationTracingBoundary(this.registrationTracing, 'close', at);
          this.registrationTracing = undefined;
        }
        this.#first('scanning:start', at, telemetry);
        this.#inventoryEligibleFiles = Math.max(this.#inventoryEligibleFiles, progress.total);
        this.#inventoryExcludedFiles = Math.max(this.#inventoryExcludedFiles, progress.excluded);
        this.#inventoryCachePersistenceMilliseconds = Math.max(
          this.#inventoryCachePersistenceMilliseconds,
          progress.timings?.persistenceMilliseconds ?? 0,
        );
        this.#inventoryParserExtractionMilliseconds = Math.max(
          this.#inventoryParserExtractionMilliseconds,
          progress.timings?.extractionMilliseconds ?? 0,
        );
        this.#inventoryReadingMilliseconds = Math.max(
          this.#inventoryReadingMilliseconds,
          progress.timings?.readingMilliseconds ?? 0,
        );
        this.#inventorySerializationMilliseconds = Math.max(
          this.#inventorySerializationMilliseconds,
          progress.timings?.serializationMilliseconds ?? 0,
        );
        if (progress.completed >= progress.total) this.#set('scanning:complete', at, telemetry);
        break;
      case 'materializing':
        this.#first('materializing:start', at, telemetry);
        this.#materializationDeduplicatedEdges = Math.max(
          this.#materializationDeduplicatedEdges,
          progress.metrics?.rows?.deduplicatedEdges ?? 0,
        );
        this.#materializationDeduplicatedReferences = Math.max(
          this.#materializationDeduplicatedReferences,
          progress.metrics?.rows?.deduplicatedReferences ?? 0,
        );
        this.#materializedLookupKeys = Math.max(this.#materializedLookupKeys, progress.metrics?.rows?.lookupKeys ?? 0);
        this.#materializedReferenceCandidates = Math.max(
          this.#materializedReferenceCandidates,
          progress.metrics?.rows?.referenceCandidates ?? 0,
        );
        for (const stage of MATERIALIZATION_STAGES) {
          const milliseconds = progress.metrics?.stageMilliseconds?.[stage];
          if (milliseconds !== undefined) {
            this.#materializationStageMilliseconds.set(
              stage,
              Math.max(this.#materializationStageMilliseconds.get(stage) ?? 0, milliseconds),
            );
          }
        }
        for (const [subphase] of MATERIALIZATION_SUBPHASES) {
          const milliseconds = progress.metrics?.subphaseMilliseconds?.[subphase];
          if (milliseconds !== undefined) {
            this.#materializationSubphaseMilliseconds.set(
              subphase,
              Math.max(this.#materializationSubphaseMilliseconds.get(subphase) ?? 0, milliseconds),
            );
          }
        }
        if (progress.metrics?.storage) {
          this.#materializationStorage = {
            attributedFilesCompleted: progress.metrics.attributedFilesCompleted,
            ...(progress.metrics.cachedFactBytesTotal === undefined
              ? {}
              : {cachedFactBytesTotal: progress.metrics.cachedFactBytesTotal}),
            cachedFactReplayBytesCompleted: progress.metrics.cachedFactReplayBytesCompleted,
            changedFactBytesCompleted: progress.metrics.changedFactBytesCompleted,
            crossGenerationShardFilesCompleted: progress.metrics.crossGenerationShardFilesCompleted,
            exactGenerationShardFilesCompleted: progress.metrics.exactGenerationShardFilesCompleted,
            materializedShardCacheDeferredFilesCompleted: progress.metrics.materializedShardCacheDeferredFilesCompleted,
            materializedShardCacheDeferredRawFactBytesCompleted:
              progress.metrics.materializedShardCacheDeferredRawFactBytesCompleted,
            ...(progress.metrics.factsBytesTotal === undefined
              ? {}
              : {finalFactBytesTotal: progress.metrics.factsBytesTotal}),
            durableAvailableBytes: progress.metrics.storage.durableAvailableBytes,
            durableDatabaseGrowthHighWaterBytes: progress.metrics.storage.durableDatabaseGrowthHighWaterBytes,
            durableFilesystemHighWaterBytes: progress.metrics.storage.durableFilesystemHighWaterBytes,
            durableJournalHighWaterBytes: progress.metrics.storage.durableJournalHighWaterBytes,
            durableSidecarDatabaseHighWaterBytes: progress.metrics.storage.durableSidecarDatabaseHighWaterBytes,
            durableSidecarJournalHighWaterBytes: progress.metrics.storage.durableSidecarJournalHighWaterBytes,
            durableSidecarWalHighWaterBytes: progress.metrics.storage.durableSidecarWalHighWaterBytes,
            durableWalHighWaterBytes: progress.metrics.storage.durableWalHighWaterBytes,
            estimateBasis: progress.metrics.storage.estimateBasis,
            estimatedDurableFilesystemRequiredBytes: progress.metrics.storage.estimatedDurableFilesystemRequiredBytes,
            estimatedTemporaryFilesystemRequiredBytes:
              progress.metrics.storage.estimatedTemporaryFilesystemRequiredBytes,
            filesystemsShared: progress.metrics.storage.filesystemsShared,
            materializedShardReplayBytesCompleted: progress.metrics.materializedShardReplayBytesCompleted,
            materializationMode: progress.metrics.storage.materializationMode,
            rawFactReplayBytesCompleted: progress.metrics.rawFactReplayBytesCompleted,
            temporaryAvailableBytes: progress.metrics.storage.temporaryAvailableBytes,
          };
        }
        this.#sqliteTemporaryDatabaseHighWaterBytes = Math.max(
          this.#sqliteTemporaryDatabaseHighWaterBytes,
          progress.metrics?.storage?.temporaryDatabaseHighWaterBytes ?? 0,
        );
        this.#sqliteDurableDatabaseHighWaterBytes = Math.max(
          this.#sqliteDurableDatabaseHighWaterBytes,
          progress.metrics?.storage?.durableDatabaseHighWaterBytes ?? 0,
        );
        if (progress.completed >= progress.total) this.#set('materializing:complete', at, telemetry);
        break;
      case 'resolving':
        if (progress.subphase === 'references') {
          this.#first('resolving:references', at, telemetry);
          if (progress.activity) {
            this.#referenceResolutionAliasesDiscovered = Math.max(
              this.#referenceResolutionAliasesDiscovered,
              progress.activity.aliasesDiscovered,
            );
            this.#referenceResolutionLongestTransactionMilliseconds = Math.max(
              this.#referenceResolutionLongestTransactionMilliseconds,
              progress.activity.longestTransactionMilliseconds ?? 0,
            );
            this.#referenceResolutionMatchingMilliseconds = Math.max(
              this.#referenceResolutionMatchingMilliseconds,
              progress.activity.matchingMilliseconds,
            );
            this.#referenceResolutionPagesCompleted = Math.max(
              this.#referenceResolutionPagesCompleted,
              progress.activity.pagesCompleted,
            );
            this.#referenceResolutionPassesObserved = Math.max(
              this.#referenceResolutionPassesObserved,
              progress.activity.pass,
            );
            this.#referenceResolutionReferencesExamined = Math.max(
              this.#referenceResolutionReferencesExamined,
              progress.activity.referencesExamined,
            );
            this.#referenceResolutionResolved = Math.max(this.#referenceResolutionResolved, progress.activity.resolved);
            this.#referenceResolutionTransactionMilliseconds = Math.max(
              this.#referenceResolutionTransactionMilliseconds,
              progress.activity.transactionMilliseconds,
            );
            for (const [stage] of RESOLUTION_TRANSACTION_STAGES) {
              const milliseconds = progress.activity.transactionStageMilliseconds?.[stage];
              if (milliseconds !== undefined) {
                this.#referenceResolutionTransactionStageMilliseconds.set(
                  stage,
                  Math.max(this.#referenceResolutionTransactionStageMilliseconds.get(stage) ?? 0, milliseconds),
                );
              }
            }
          }
        } else this.#set('resolving:complete', at, telemetry);
        break;
      case 'activating':
        this.#maximumActivationTransactionMilliseconds = Math.max(
          this.#maximumActivationTransactionMilliseconds,
          progress.activity?.transactionMilliseconds ?? 0,
        );
        if (progress.activity?.state === 'completed') {
          this.#activationStages.set(progress.activity.stage, {
            durationMilliseconds: progress.activity.stageElapsedMilliseconds,
            rows: progress.activity.rows ?? 0,
          });
        }
        if (progress.subphase === 'validating-input') this.#first('activating:validating-input', at, telemetry);
        else if (progress.subphase === 'writing-and-checkpointing') {
          this.#first('activating:writing-and-checkpointing', at, telemetry);
        } else if (progress.subphase === 'promoting') this.#first('activating:promoting', at, telemetry);
        else if (progress.subphase === 'complete') {
          this.#activationCompleted = true;
          this.#set('activating:complete', at, telemetry);
        }
        break;
      case 'embedding':
        this.#first('embedding:start', at, telemetry);
        if (progress.completed >= progress.total) this.#set('embedding:complete', at, telemetry);
        break;
    }
  }

  observeTiming(stage: BenchmarkIndexTimingStage): Effect.Effect<Effect.Effect<void>> {
    return Effect.suspend(() =>
      this.#completionTimings.observe(
        stage === 'snapshot-lease-release' && this.#activationCompleted
          ? 'snapshot-lease-release-after-complete'
          : stage,
      ),
    );
  }

  completionTimingMeasurements(prefix: string): ReturnType<typeof benchmarkMeasurement>[] {
    return this.#completionTimings.measurements(prefix);
  }

  finish(at: bigint, telemetry: ProcessTelemetry): void {
    this.#observeHeartbeat(at);
    this.#set('finish', at, telemetry);
  }

  duration(from: IndexPhasePoint, to: IndexPhasePoint, ...fallbackTo: readonly IndexPhasePoint[]): number {
    const start = this.#points.get(from);
    if (start === undefined) return 0;
    const end = Option.getOrUndefined(
      EffectArray.findFirst(
        EffectArray.map([to, ...fallbackTo, 'finish' as const], point => this.#points.get(point)),
        (candidate): candidate is bigint => candidate !== undefined,
      ),
    );
    return Math.max(0, Number((end ?? start) - start) / NANOSECONDS_PER_MILLISECOND);
  }

  resources(
    from: IndexPhasePoint,
    to: IndexPhasePoint,
    ...fallbackTo: readonly IndexPhasePoint[]
  ): {readonly cpuMilliseconds: number; readonly rssBoundaryPeakBytes: number} {
    const started = this.#resources.get(from);
    const finished = Option.getOrUndefined(
      EffectArray.findFirst(
        EffectArray.map([to, ...fallbackTo, 'finish' as const], point => this.#resources.get(point)),
        (candidate): candidate is ProcessTelemetry => candidate !== undefined,
      ),
    );
    if (!started || !finished) return {cpuMilliseconds: 0, rssBoundaryPeakBytes: 0};
    return {
      cpuMilliseconds: cpuMilliseconds(started, finished).total,
      rssBoundaryPeakBytes: Math.max(started.rssBytes, finished.rssBytes),
    };
  }

  activationStage(
    stage: CodeGraphActivationActivity['stage'],
  ): {readonly durationMilliseconds: number; readonly rows: number} | undefined {
    return this.#activationStages.get(stage);
  }

  activationStageCount(): number {
    return this.#activationStages.size;
  }

  maximumActivationTransactionMilliseconds(): number {
    return this.#maximumActivationTransactionMilliseconds;
  }

  maximumProgressHeartbeatGapMilliseconds(): number {
    return this.#maximumProgressHeartbeatGapMilliseconds;
  }

  inventoryEligibleFiles(): number {
    return this.#inventoryEligibleFiles;
  }

  inventoryExcludedFiles(): number {
    return this.#inventoryExcludedFiles;
  }

  inventoryCachePersistenceMilliseconds(): number {
    return this.#inventoryCachePersistenceMilliseconds;
  }

  inventoryParserExtractionMilliseconds(): number {
    return this.#inventoryParserExtractionMilliseconds;
  }

  inventoryReadingMilliseconds(): number {
    return this.#inventoryReadingMilliseconds;
  }

  inventorySerializationMilliseconds(): number {
    return this.#inventorySerializationMilliseconds;
  }

  materializationDeduplicatedEdges(): number {
    return this.#materializationDeduplicatedEdges;
  }

  materializationDeduplicatedReferences(): number {
    return this.#materializationDeduplicatedReferences;
  }

  materializedLookupKeys(): number {
    return this.#materializedLookupKeys;
  }

  materializedReferenceCandidates(): number {
    return this.#materializedReferenceCandidates;
  }

  materializationStorage(): IndexMaterializationStorageEvidence | undefined {
    return this.#materializationStorage;
  }

  materializationStageMilliseconds(stage: (typeof MATERIALIZATION_STAGES)[number]): number | undefined {
    return this.#materializationStageMilliseconds.get(stage);
  }

  materializationSubphaseMilliseconds(
    subphase: keyof CodeGraphMaterializationSubphaseMilliseconds,
  ): number | undefined {
    return this.#materializationSubphaseMilliseconds.get(subphase);
  }

  referenceResolutionAliasesDiscovered(): number {
    return this.#referenceResolutionAliasesDiscovered;
  }

  referenceResolutionMatchingMilliseconds(): number {
    return this.#referenceResolutionMatchingMilliseconds;
  }

  referenceResolutionLongestTransactionMilliseconds(): number {
    return this.#referenceResolutionLongestTransactionMilliseconds;
  }

  referenceResolutionPagesCompleted(): number {
    return this.#referenceResolutionPagesCompleted;
  }

  referenceResolutionPassesObserved(): number {
    return this.#referenceResolutionPassesObserved;
  }

  referenceResolutionReferencesExamined(): number {
    return this.#referenceResolutionReferencesExamined;
  }

  referenceResolutionResolved(): number {
    return this.#referenceResolutionResolved;
  }

  referenceResolutionTransactionMilliseconds(): number {
    return this.#referenceResolutionTransactionMilliseconds;
  }

  referenceResolutionTransactionStageMilliseconds(
    stage: (typeof RESOLUTION_TRANSACTION_STAGES)[number][0],
  ): number | undefined {
    return this.#referenceResolutionTransactionStageMilliseconds.get(stage);
  }

  sqliteTemporaryDatabaseHighWaterBytes(): number {
    return this.#sqliteTemporaryDatabaseHighWaterBytes;
  }

  sqliteDurableDatabaseHighWaterBytes(): number {
    return this.#sqliteDurableDatabaseHighWaterBytes;
  }

  #first(point: IndexPhasePoint, at: bigint, telemetry: ProcessTelemetry): void {
    if (!this.#points.has(point)) this.#set(point, at, telemetry);
  }

  #observeHeartbeat(at: bigint): void {
    this.#maximumProgressHeartbeatGapMilliseconds = Math.max(
      this.#maximumProgressHeartbeatGapMilliseconds,
      Math.max(0, Number(at - this.#lastProgressAt) / NANOSECONDS_PER_MILLISECOND),
    );
    this.#lastProgressAt = at;
  }

  #set(point: IndexPhasePoint, at: bigint, telemetry: ProcessTelemetry): void {
    this.#points.set(point, at);
    this.#resources.set(point, telemetry);
  }
}

export interface BenchmarkIndexMeasurement<A> {
  readonly finishedAt: bigint;
  readonly processFinished: ProcessTelemetry;
  readonly processStarted: ProcessTelemetry;
  readonly result: A;
  readonly startedAt: bigint;
  readonly timeline: IndexPhaseTimeline;
}

export interface BenchmarkIndexSamplerHandle {
  readonly mark: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly stop: (state?: 'aborted' | 'complete') => Effect.Effect<CodeGraphBenchmarkSamplerArtifact, unknown>;
}

export interface SampledBenchmarkIndexMeasurement<A> {
  readonly measurement: BenchmarkIndexMeasurement<A>;
  readonly telemetry?: CodeGraphBenchmarkSamplerArtifact;
}

export function measureBenchmarkIndex<A, E, R>(
  run: (timeline: IndexPhaseTimeline) => Effect.Effect<A, E, R>,
  registrationTracing?: BenchmarkRegistrationTracing,
): Effect.Effect<BenchmarkIndexMeasurement<A>, E, R> {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeNanos;
    const processStarted = processTelemetry();
    const timeline = new IndexPhaseTimeline(startedAt, processStarted, registrationTracing);
    const result = yield* withBenchmarkRegistrationTracing(run(timeline), registrationTracing);
    const finishedAt = yield* Clock.currentTimeNanos;
    const processFinished = processTelemetry();
    timeline.finish(finishedAt, processFinished);
    return {finishedAt, processFinished, processStarted, result, startedAt, timeline};
  });
}

/**
 * Starts external observation only after all phase setup is complete, then
 * stops it after the final index-boundary storage sample. The scoped release
 * still aborts the sampler on interruption before an enclosing overlay scope
 * restores source bytes.
 */
export function measureSampledBenchmarkIndex<A>(
  startSampler: Effect.Effect<BenchmarkIndexSamplerHandle | undefined, unknown>,
  run: (timeline: IndexPhaseTimeline, sampler: BenchmarkIndexSamplerHandle | undefined) => Effect.Effect<A, unknown>,
  observeFinalStorage: Effect.Effect<void, unknown>,
  registrationTracing?: BenchmarkRegistrationTracing,
): Effect.Effect<SampledBenchmarkIndexMeasurement<A>, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      let stopped = false;
      const sampler = yield* Effect.acquireRelease(startSampler, (handle, exit) =>
        handle && !stopped
          ? handle.stop(Exit.isSuccess(exit) ? 'complete' : 'aborted').pipe(Effect.ignore)
          : succeedUndefined,
      );
      const measurement = yield* measureBenchmarkIndex(timeline => run(timeline, sampler), registrationTracing);
      yield* observeFinalStorage;
      const telemetry = sampler ? yield* sampler.stop('complete') : undefined;
      stopped = true;
      return {measurement, ...(telemetry ? {telemetry} : {})};
    }),
  );
}

export interface IndexMaterializationStorageEvidence {
  readonly attributedFilesCompleted?: number;
  readonly cachedFactBytesTotal?: number;
  readonly cachedFactReplayBytesCompleted?: number;
  readonly changedFactBytesCompleted?: number;
  readonly crossGenerationShardFilesCompleted?: number;
  readonly exactGenerationShardFilesCompleted?: number;
  readonly finalFactBytesTotal?: number;
  readonly durableAvailableBytes?: number;
  readonly durableDatabaseGrowthHighWaterBytes?: number;
  readonly durableFilesystemHighWaterBytes?: number;
  readonly durableJournalHighWaterBytes?: number;
  readonly durableSidecarDatabaseHighWaterBytes?: number;
  readonly durableSidecarJournalHighWaterBytes?: number;
  readonly durableSidecarWalHighWaterBytes?: number;
  readonly durableWalHighWaterBytes?: number;
  readonly estimateBasis?: 'cached-fact-bytes' | 'final-fact-bytes' | 'source-bytes-fallback';
  readonly estimatedDurableFilesystemRequiredBytes?: number;
  readonly estimatedTemporaryFilesystemRequiredBytes?: number;
  readonly filesystemsShared?: boolean;
  readonly materializedShardReplayBytesCompleted?: number;
  readonly materializedShardCacheDeferredFilesCompleted?: number;
  readonly materializedShardCacheDeferredRawFactBytesCompleted?: number;
  readonly materializationMode?: 'direct-persistent' | 'temporary-staged';
  readonly rawFactReplayBytesCompleted?: number;
  readonly temporaryAvailableBytes?: number;
}

function observeIndexProgress(timeline: IndexPhaseTimeline, progress: CodeGraphProgress): Effect.Effect<void> {
  return Clock.currentTimeNanos.pipe(
    Effect.tap(at => Effect.sync(() => timeline.observe(progress, at, processTelemetry()))),
  );
}

export function indexPhaseMeasurements(
  prefix: 'cold' | 'one-file-reindex' | 'same-overlay-reference',
  timeline: IndexPhaseTimeline,
  vectors: boolean,
): ReturnType<typeof benchmarkMeasurement>[] {
  return [
    ...timeline.completionTimingMeasurements(prefix),
    benchmarkMeasurement(`${prefix}-post-activation-completion`, 'milliseconds', [
      timeline.duration('activating:complete', 'finish'),
    ]),
    benchmarkMeasurement(`${prefix}-registration-lock-and-database-setup`, 'milliseconds', [
      timeline.duration('start', 'scanning:start', 'materializing:start'),
    ]),
    benchmarkMeasurement(`${prefix}-inventory-and-extraction`, 'milliseconds', [
      timeline.duration('scanning:start', 'scanning:complete', 'materializing:start'),
    ]),
    benchmarkMeasurement(`${prefix}-inventory-source-reading-n1`, 'milliseconds', [
      timeline.inventoryReadingMilliseconds(),
    ]),
    benchmarkMeasurement(`${prefix}-inventory-parser-extraction-summed-n1`, 'milliseconds', [
      timeline.inventoryParserExtractionMilliseconds(),
    ]),
    benchmarkMeasurement(`${prefix}-inventory-cache-persistence-n1`, 'milliseconds', [
      timeline.inventoryCachePersistenceMilliseconds(),
    ]),
    benchmarkMeasurement(`${prefix}-inventory-parser-fact-serialization-n1`, 'milliseconds', [
      timeline.inventorySerializationMilliseconds(),
    ]),
    benchmarkMeasurement(`${prefix}-post-committed-scan-overlay-and-workspace`, 'milliseconds', [
      timeline.duration('scanning:complete', 'materializing:start'),
    ]),
    benchmarkMeasurement(`${prefix}-pre-activation`, 'milliseconds', [
      timeline.duration('start', 'activating:validating-input'),
    ]),
    benchmarkMeasurement(`${prefix}-materialization`, 'milliseconds', [
      timeline.duration('materializing:start', 'resolving:references'),
    ]),
    benchmarkMeasurement(`${prefix}-reference-resolution`, 'milliseconds', [
      timeline.duration('resolving:references', 'resolving:complete'),
    ]),
    benchmarkMeasurement(`${prefix}-reference-resolution-matching-n1`, 'milliseconds', [
      timeline.referenceResolutionMatchingMilliseconds(),
    ]),
    benchmarkMeasurement(`${prefix}-reference-resolution-transactions-n1`, 'milliseconds', [
      timeline.referenceResolutionTransactionMilliseconds(),
    ]),
    benchmarkMeasurement(`${prefix}-reference-resolution-longest-transaction-n1`, 'milliseconds', [
      timeline.referenceResolutionLongestTransactionMilliseconds(),
    ]),
    ...EffectArray.map(RESOLUTION_TRANSACTION_STAGES, ([stage, measurement]) =>
      benchmarkMeasurement(`${prefix}-reference-resolution-transaction-stage-${measurement}-n1`, 'milliseconds', [
        timeline.referenceResolutionTransactionStageMilliseconds(stage) ?? 0,
      ]),
    ),
    benchmarkMeasurement(`${prefix}-reference-resolution-pages-n1`, 'count', [
      timeline.referenceResolutionPagesCompleted(),
    ]),
    benchmarkMeasurement(`${prefix}-reference-resolution-passes-n1`, 'count', [
      timeline.referenceResolutionPassesObserved(),
    ]),
    benchmarkMeasurement(`${prefix}-reference-resolution-references-examined-n1`, 'count', [
      timeline.referenceResolutionReferencesExamined(),
    ]),
    benchmarkMeasurement(`${prefix}-reference-resolution-resolved-n1`, 'count', [
      timeline.referenceResolutionResolved(),
    ]),
    benchmarkMeasurement(`${prefix}-reference-resolution-aliases-discovered-n1`, 'count', [
      timeline.referenceResolutionAliasesDiscovered(),
    ]),
    benchmarkMeasurement(`${prefix}-resolved-fact-accounting`, 'milliseconds', [
      timeline.duration('resolving:complete', 'activating:validating-input'),
    ]),
    benchmarkMeasurement(`${prefix}-pre-activation-validation`, 'milliseconds', [
      timeline.duration('activating:validating-input', 'activating:writing-and-checkpointing'),
    ]),
    benchmarkMeasurement(`${prefix}-snapshot-write-and-checkpoint`, 'milliseconds', [
      timeline.duration('activating:writing-and-checkpointing', 'activating:promoting', 'activating:complete'),
    ]),
    benchmarkMeasurement(`${prefix}-snapshot-promotion`, 'milliseconds', [
      timeline.duration('activating:promoting', 'activating:complete'),
    ]),
    benchmarkMeasurement(
      vectors ? `${prefix}-activation-and-vectors` : `${prefix}-activation-lexical-only`,
      'milliseconds',
      [timeline.duration('activating:validating-input', 'finish')],
    ),
    benchmarkMeasurement(`${prefix}-vector-index`, 'milliseconds', [
      timeline.duration('embedding:start', 'embedding:complete', 'finish'),
    ]),
    benchmarkMeasurement(`${prefix}-sqlite-temp-database-pages-high-water-n1`, 'bytes', [
      timeline.sqliteTemporaryDatabaseHighWaterBytes(),
    ]),
    benchmarkMeasurement(`${prefix}-sqlite-durable-database-pages-high-water-n1`, 'bytes', [
      timeline.sqliteDurableDatabaseHighWaterBytes(),
    ]),
    benchmarkMeasurement(`${prefix}-materialization-deduplicated-edge-rows-n1`, 'count', [
      timeline.materializationDeduplicatedEdges(),
    ]),
    benchmarkMeasurement(`${prefix}-materialization-deduplicated-reference-rows-n1`, 'count', [
      timeline.materializationDeduplicatedReferences(),
    ]),
    benchmarkMeasurement(`${prefix}-materialized-lookup-key-rows-n1`, 'count', [timeline.materializedLookupKeys()]),
    benchmarkMeasurement(`${prefix}-materialized-reference-candidate-rows-n1`, 'count', [
      timeline.materializedReferenceCandidates(),
    ]),
    ...EffectArray.map(MATERIALIZATION_STAGES, stage =>
      benchmarkMeasurement(`${prefix}-materialization-stage-${stage}-n1`, 'milliseconds', [
        timeline.materializationStageMilliseconds(stage) ?? 0,
      ]),
    ),
    ...EffectArray.flatMap(MATERIALIZATION_SUBPHASES, ([subphase, measurement]) => {
      const milliseconds = timeline.materializationSubphaseMilliseconds(subphase);
      return milliseconds === undefined
        ? []
        : [
            benchmarkMeasurement(`${prefix}-materialization-subphase-${measurement}-n1`, 'milliseconds', [
              milliseconds,
            ]),
          ];
    }),
    ...materializationStorageMeasurements(prefix, timeline.materializationStorage()),
    ...activationStageMeasurements(prefix, timeline),
  ];
}

export function materializationStorageMeasurements(
  prefix: 'cold' | 'one-file-reindex' | 'same-overlay-reference',
  storage: IndexMaterializationStorageEvidence | undefined,
): ReturnType<typeof benchmarkMeasurement>[] {
  if (!storage) return [];
  const measurements: ReturnType<typeof benchmarkMeasurement>[] = [];
  const add = (name: string, unit: 'bytes' | 'count', value: number | undefined) => {
    if (value !== undefined) measurements.push(benchmarkMeasurement(`${prefix}-${name}`, unit, [value]));
  };
  add('materialization-attributed-files-n1', 'count', storage.attributedFilesCompleted);
  add('materialization-cached-fact-bytes-total-n1', 'bytes', storage.cachedFactBytesTotal);
  add('materialization-cached-fact-replay-bytes-n1', 'bytes', storage.cachedFactReplayBytesCompleted);
  add('materialization-changed-fact-bytes-n1', 'bytes', storage.changedFactBytesCompleted);
  add('materialization-cross-generation-shard-files-n1', 'count', storage.crossGenerationShardFilesCompleted);
  add('materialization-exact-generation-shard-files-n1', 'count', storage.exactGenerationShardFilesCompleted);
  add('materialization-final-fact-bytes-total-n1', 'bytes', storage.finalFactBytesTotal);
  add(
    'materialization-materialized-shard-cache-deferred-files-n1',
    'count',
    storage.materializedShardCacheDeferredFilesCompleted,
  );
  add(
    'materialization-materialized-shard-cache-deferred-raw-fact-bytes-n1',
    'bytes',
    storage.materializedShardCacheDeferredRawFactBytesCompleted,
  );
  add('materialization-materialized-shard-replay-bytes-n1', 'bytes', storage.materializedShardReplayBytesCompleted);
  add('materialization-raw-fact-replay-bytes-n1', 'bytes', storage.rawFactReplayBytesCompleted);
  add(
    'materialization-estimated-temp-filesystem-required-n1',
    'bytes',
    storage.estimatedTemporaryFilesystemRequiredBytes,
  );
  add(
    'materialization-estimated-durable-filesystem-required-n1',
    'bytes',
    storage.estimatedDurableFilesystemRequiredBytes,
  );
  add('materialization-temp-filesystem-available-n1', 'bytes', storage.temporaryAvailableBytes);
  add('materialization-durable-filesystem-available-n1', 'bytes', storage.durableAvailableBytes);
  add('materialization-durable-database-growth-high-water-n1', 'bytes', storage.durableDatabaseGrowthHighWaterBytes);
  add('materialization-durable-filesystem-high-water-n1', 'bytes', storage.durableFilesystemHighWaterBytes);
  add('materialization-durable-journal-high-water-n1', 'bytes', storage.durableJournalHighWaterBytes);
  add('materialization-durable-wal-high-water-n1', 'bytes', storage.durableWalHighWaterBytes);
  add('materialization-sidecar-database-high-water-n1', 'bytes', storage.durableSidecarDatabaseHighWaterBytes);
  add('materialization-sidecar-journal-high-water-n1', 'bytes', storage.durableSidecarJournalHighWaterBytes);
  add('materialization-sidecar-wal-high-water-n1', 'bytes', storage.durableSidecarWalHighWaterBytes);
  add(
    'materialization-filesystems-shared-n1',
    'count',
    storage.filesystemsShared === undefined ? undefined : storage.filesystemsShared ? 1 : 0,
  );
  return measurements;
}

function activationStageMeasurements(
  prefix: 'cold' | 'one-file-reindex' | 'same-overlay-reference',
  timeline: IndexPhaseTimeline,
): ReturnType<typeof benchmarkMeasurement>[] {
  return [
    benchmarkMeasurement(`${prefix}-activation-observed-stages-n1`, 'count', [timeline.activationStageCount()]),
    benchmarkMeasurement(`${prefix}-activation-longest-transaction-n1`, 'milliseconds', [
      timeline.maximumActivationTransactionMilliseconds(),
    ]),
    benchmarkMeasurement(`${prefix}-maximum-progress-heartbeat-gap-n1`, 'milliseconds', [
      timeline.maximumProgressHeartbeatGapMilliseconds(),
    ]),
    ...EffectArray.flatMap(ACTIVATION_STAGES, stage => {
      const observed = timeline.activationStage(stage);
      return [
        benchmarkMeasurement(`${prefix}-activation-${stage}-observed-n1`, 'count', [observed ? 1 : 0]),
        benchmarkMeasurement(`${prefix}-activation-${stage}-duration-n1`, 'milliseconds', [
          observed?.durationMilliseconds ?? 0,
        ]),
        benchmarkMeasurement(`${prefix}-activation-${stage}-rows-n1`, 'count', [observed?.rows ?? 0]),
      ];
    }),
  ];
}

function indexPhaseResourceMeasurements(
  prefix: 'cold' | 'one-file-reindex' | 'same-overlay-reference',
  timeline: IndexPhaseTimeline,
): ReturnType<typeof benchmarkMeasurement>[] {
  const phases = [
    ['registration', 'start', 'scanning:start', 'materializing:start'],
    ['inventory-and-extraction', 'scanning:start', 'scanning:complete', 'materializing:start'],
    ['materialization', 'materializing:start', 'resolving:references', 'activating:validating-input'],
    ['reference-resolution', 'resolving:references', 'resolving:complete', 'activating:validating-input'],
    ['activation', 'activating:validating-input', 'activating:complete', 'finish'],
    ['post-activation-completion', 'activating:complete', 'finish', 'finish'],
    ['vector-index', 'embedding:start', 'embedding:complete', 'finish'],
  ] as const satisfies readonly (readonly [string, IndexPhasePoint, IndexPhasePoint, IndexPhasePoint])[];
  return EffectArray.flatMap(phases, ([name, from, to, fallback]) => {
    const resources = timeline.resources(from, to, fallback);
    return [
      benchmarkMeasurement(`${prefix}-${name}-process-cpu-n1`, 'milliseconds', [resources.cpuMilliseconds]),
      benchmarkMeasurement(`${prefix}-${name}-boundary-rss-n1`, 'bytes', [resources.rssBoundaryPeakBytes]),
    ];
  });
}

export function externalSamplerMeasurements(
  prefix: 'bootstrap' | 'cold' | 'one-file-reindex' | 'same-overlay-reference',
  artifact: CodeGraphBenchmarkSamplerArtifact | undefined,
): ReturnType<typeof benchmarkMeasurement>[] {
  if (!artifact) return [];
  const phases = EffectRecord.toEntries(artifact.phases);
  const processTreeMeasurements =
    artifact.version >= 3 &&
    artifact.processTelemetry.availability === 'available' &&
    artifact.processTelemetry.scope === 'recursive-process-tree'
      ? [
          benchmarkMeasurement(`${prefix}-external-process-tree-samples-n1`, 'count', [
            boundedPhaseTotal(phases, sample => sample.processSamples ?? 0),
          ]),
          benchmarkMeasurement(`${prefix}-external-process-tree-attempts-n1`, 'count', [
            boundedPhaseTotal(phases, sample => sample.processSampleAttempts ?? 0),
          ]),
          benchmarkMeasurement(`${prefix}-external-process-tree-failures-n1`, 'count', [
            boundedPhaseTotal(phases, sample => sample.processSampleFailures ?? 0),
          ]),
          benchmarkMeasurement(`${prefix}-external-process-tree-maximum-sample-gap-n1`, 'milliseconds', [
            Math.max(0, ...EffectArray.map(phases, ([, sample]) => sample.processSampleGapPeakMilliseconds ?? 0)),
          ]),
          benchmarkMeasurement(`${prefix}-external-process-count-peak-observed-n1`, 'count', [
            Math.max(0, ...EffectArray.map(phases, ([, sample]) => sample.processPeakCount ?? 0)),
          ]),
          benchmarkMeasurement(`${prefix}-external-process-cpu-n1`, 'milliseconds', [
            boundedPhaseTotal(phases, sample => sample.cpuMilliseconds ?? 0),
          ]),
          benchmarkMeasurement(`${prefix}-external-rss-peak-observed-n1`, 'bytes', [
            Math.max(0, ...EffectArray.map(phases, ([, sample]) => sample.rssPeakBytes ?? 0)),
          ]),
          ...(artifact.processTelemetry.ioCounters === 'linux-proc-read-write-bytes'
            ? [
                benchmarkMeasurement(`${prefix}-external-process-physical-read-n1`, 'bytes', [
                  boundedPhaseTotal(phases, sample => sample.ioReadBytes ?? 0),
                ]),
                benchmarkMeasurement(`${prefix}-external-process-physical-write-n1`, 'bytes', [
                  boundedPhaseTotal(phases, sample => sample.ioWriteBytes ?? 0),
                ]),
              ]
            : []),
        ]
      : [];
  const openTemporaryFileMeasurements =
    artifact.version >= 4 && artifact.temporaryTelemetry?.availability === 'available'
      ? [
          benchmarkMeasurement(`${prefix}-external-open-temp-process-tree-attempts-n1`, 'count', [
            boundedPhaseTotal(phases, sample => sample.temporaryOpenAttempts ?? 0),
          ]),
          benchmarkMeasurement(`${prefix}-external-open-temp-process-tree-failures-n1`, 'count', [
            boundedPhaseTotal(phases, sample => sample.temporaryOpenFailures ?? 0),
          ]),
          benchmarkMeasurement(`${prefix}-external-open-temp-process-tree-samples-n1`, 'count', [
            boundedPhaseTotal(phases, sample => sample.temporaryOpenSamples ?? 0),
          ]),
          benchmarkMeasurement(`${prefix}-external-sqlite-temp-combined-peak-observed-n1`, 'bytes', [
            Math.max(0, ...EffectArray.map(phases, ([, sample]) => sample.temporaryPeakBytes)),
          ]),
          benchmarkMeasurement(`${prefix}-external-sqlite-temp-linked-peak-observed-n1`, 'bytes', [
            Math.max(0, ...EffectArray.map(phases, ([, sample]) => sample.temporaryLinkedPeakBytes ?? 0)),
          ]),
          benchmarkMeasurement(`${prefix}-external-sqlite-temp-open-process-tree-peak-observed-n1`, 'bytes', [
            Math.max(0, ...EffectArray.map(phases, ([, sample]) => sample.temporaryOpenPeakBytes ?? 0)),
          ]),
        ]
      : [];
  return [
    benchmarkMeasurement(`${prefix}-external-sampler-version-n1`, 'count', [artifact.version]),
    benchmarkMeasurement(`${prefix}-external-storage-samples-n1`, 'count', [artifact.samples]),
    ...processTreeMeasurements,
    ...openTemporaryFileMeasurements,
    ...EffectArray.flatMap(phases, ([phase, sample]) => {
      const name =
        Effect2.pipe(
          phase,
          EffectString.replace(/[^a-z0-9]+/gi, '-'),
          EffectString.replace(/^-|-$/g, ''),
          EffectString.toLowerCase,
        ) || 'unknown';
      const processMeasurements =
        artifact.processTelemetry.availability === 'available' &&
        sample.cpuMilliseconds !== undefined &&
        sample.rssPeakBytes !== undefined
          ? [
              benchmarkMeasurement(`${prefix}-${name}-external-process-cpu-n1`, 'milliseconds', [
                sample.cpuMilliseconds,
              ]),
              benchmarkMeasurement(`${prefix}-${name}-external-rss-peak-observed-n1`, 'bytes', [sample.rssPeakBytes]),
              ...(sample.processPeakCount === undefined
                ? []
                : [
                    benchmarkMeasurement(`${prefix}-${name}-external-process-count-peak-observed-n1`, 'count', [
                      sample.processPeakCount,
                    ]),
                  ]),
              ...(sample.processSamples === undefined
                ? []
                : [
                    benchmarkMeasurement(`${prefix}-${name}-external-process-samples-n1`, 'count', [
                      sample.processSamples,
                    ]),
                  ]),
              ...(sample.processSampleAttempts === undefined
                ? []
                : [
                    benchmarkMeasurement(`${prefix}-${name}-external-process-attempts-n1`, 'count', [
                      sample.processSampleAttempts,
                    ]),
                  ]),
              ...(sample.processSampleFailures === undefined
                ? []
                : [
                    benchmarkMeasurement(`${prefix}-${name}-external-process-failures-n1`, 'count', [
                      sample.processSampleFailures,
                    ]),
                  ]),
              ...(sample.processSampleGapPeakMilliseconds === undefined
                ? []
                : [
                    benchmarkMeasurement(`${prefix}-${name}-external-process-maximum-sample-gap-n1`, 'milliseconds', [
                      sample.processSampleGapPeakMilliseconds,
                    ]),
                  ]),
              ...(sample.ioReadBytes === undefined
                ? []
                : [
                    benchmarkMeasurement(`${prefix}-${name}-external-process-physical-read-n1`, 'bytes', [
                      sample.ioReadBytes,
                    ]),
                  ]),
              ...(sample.ioWriteBytes === undefined
                ? []
                : [
                    benchmarkMeasurement(`${prefix}-${name}-external-process-physical-write-n1`, 'bytes', [
                      sample.ioWriteBytes,
                    ]),
                  ]),
            ]
          : [];
      return [
        ...processMeasurements,
        benchmarkMeasurement(`${prefix}-${name}-sqlite-main-peak-observed-n1`, 'bytes', [sample.databasePeakBytes]),
        benchmarkMeasurement(`${prefix}-${name}-sqlite-wal-peak-observed-n1`, 'bytes', [sample.walPeakBytes]),
        benchmarkMeasurement(`${prefix}-${name}-sqlite-shm-peak-observed-n1`, 'bytes', [sample.shmPeakBytes]),
        benchmarkMeasurement(`${prefix}-${name}-sqlite-temp-peak-observed-n1`, 'bytes', [sample.temporaryPeakBytes]),
        ...(sample.temporaryLinkedPeakBytes === undefined
          ? []
          : [
              benchmarkMeasurement(`${prefix}-${name}-sqlite-temp-linked-peak-observed-n1`, 'bytes', [
                sample.temporaryLinkedPeakBytes,
              ]),
            ]),
        ...(sample.temporaryOpenPeakBytes === undefined
          ? []
          : [
              benchmarkMeasurement(`${prefix}-${name}-sqlite-temp-open-process-tree-peak-observed-n1`, 'bytes', [
                sample.temporaryOpenPeakBytes,
              ]),
            ]),
      ];
    }),
  ];
}

function boundedPhaseTotal(
  phases: readonly (readonly [string, CodeGraphBenchmarkSamplerArtifact['phases'][string]])[],
  value: (sample: CodeGraphBenchmarkSamplerArtifact['phases'][string]) => number,
): number {
  return EffectArray.reduce(phases, 0, (total, [, sample]) => Math.min(Number.MAX_SAFE_INTEGER, total + value(sample)));
}

function externalTelemetryPeak(
  artifact: CodeGraphBenchmarkSamplerArtifact,
  field: 'databasePeakBytes' | 'journalPeakBytes' | 'shmPeakBytes' | 'temporaryPeakBytes' | 'walPeakBytes',
): number {
  return Math.max(0, ...EffectArray.map(EffectRecord.values(artifact.phases), phase => phase[field] ?? 0));
}

/**
 * Governed runs sample SQLite files independently every 25 ms. Keep the final
 * in-process boundary in the maximum, but do not require progress callbacks to
 * issue four redundant filesystem stats inside the measured path.
 */
export function codeGraphBenchmarkSqlitePeak(
  boundaryBytes: number,
  sampler: CodeGraphBenchmarkSamplerArtifact | undefined,
  field: 'databasePeakBytes' | 'journalPeakBytes' | 'shmPeakBytes' | 'walPeakBytes',
): number {
  return sampler === undefined ? boundaryBytes : Math.max(boundaryBytes, externalTelemetryPeak(sampler, field));
}

function externalSamplerDescription(artifact: CodeGraphBenchmarkSamplerArtifact | undefined): string {
  const storage =
    artifact?.temporaryTelemetry?.availability === 'available'
      ? `DB/WAL/SHM plus deduplicated linked temp-root and process-tree open SQLite scratch bytes sampled at ` +
        `${artifact.temporaryTelemetry.openFileSampleIntervalMilliseconds}ms with aggregate attempt/failure accounting; ` +
        `no paths retained`
      : 'DB/WAL/SHM and linked isolated SQLite temp-root bytes';
  if (!artifact) return `external 25ms sampler; process telemetry unavailable; ${storage}`;
  return artifact.processTelemetry.availability === 'available'
    ? artifact.processTelemetry.scope === 'recursive-process-tree'
      ? `external 25ms storage sampler; ${artifact.processTelemetry.source} observer-excluded recursive process-tree CPU/RSS ` +
        `at ${artifact.processTelemetry.sampleIntervalMilliseconds}ms with start-time identity validation` +
        `${artifact.processTelemetry.ioCounters ? ' and physical I/O counters' : ''}; ${storage}`
      : `external 25ms sampler; Linux /proc parent CPU/RSS with start-time identity validation; ${storage}`
    : `external 25ms sampler; process CPU/RSS unavailable on ${artifact.platform} ` +
        `(${artifact.processTelemetry.reason}); ${storage}`;
}

export interface ProcessTelemetry {
  readonly cpuSystemMicroseconds: number;
  readonly cpuUserMicroseconds: number;
  readonly peakRssBytes: number;
  readonly rssBytes: number;
}

function processTelemetry(): ProcessTelemetry {
  const cpu = process.cpuUsage();
  return {
    cpuSystemMicroseconds: cpu.system,
    cpuUserMicroseconds: cpu.user,
    peakRssBytes: processPeakRssBytes(),
    rssBytes: process.memoryUsage().rss,
  };
}

function cpuMilliseconds(
  started: ProcessTelemetry,
  finished: ProcessTelemetry,
): {readonly system: number; readonly total: number; readonly user: number} {
  const system = Math.max(0, finished.cpuSystemMicroseconds - started.cpuSystemMicroseconds) / 1_000;
  const user = Math.max(0, finished.cpuUserMicroseconds - started.cpuUserMicroseconds) / 1_000;
  return {system, total: system + user, user};
}

interface CodeGraphStorageTelemetry {
  readonly buildStatusBytes: number;
  readonly sqliteJournalBytes: number;
  readonly sqliteMainBytes: number;
  readonly sqliteShmBytes: number;
  readonly sqliteWalBytes: number;
  readonly totalBytes: number;
  readonly unclassifiedRepositoryBytes: number;
  readonly vectorBytes: number;
}

class SqliteStoragePeakTelemetry {
  sqliteJournalBytes = 0;
  sqliteMainBytes = 0;
  sqliteShmBytes = 0;
  sqliteWalBytes = 0;

  observe(main: number, wal: number, shm: number, journal: number): void {
    this.sqliteMainBytes = Math.max(this.sqliteMainBytes, main);
    this.sqliteWalBytes = Math.max(this.sqliteWalBytes, wal);
    this.sqliteShmBytes = Math.max(this.sqliteShmBytes, shm);
    this.sqliteJournalBytes = Math.max(this.sqliteJournalBytes, journal);
  }
}

function observeSqliteStoragePeak(
  fs: FileSystem.FileSystem,
  telemetry: SqliteStoragePeakTelemetry,
  databasePath: string,
): Effect.Effect<void, unknown> {
  return Effect.all(
    [
      regularFileBytes(fs, databasePath),
      regularFileBytes(fs, `${databasePath}-wal`),
      regularFileBytes(fs, `${databasePath}-shm`),
      regularFileBytes(fs, `${databasePath}-journal`),
    ],
    {concurrency: 4},
  ).pipe(
    Effect.tap(([main, wal, shm, journal]) => Effect.sync(() => telemetry.observe(main, wal, shm, journal))),
    Effect.asVoid,
  );
}

interface ExternalSamplerHandle {
  readonly mark: (progress: CodeGraphProgress) => Effect.Effect<void, unknown>;
  readonly markPhase: (phase: string) => Effect.Effect<void, unknown>;
  readonly stop: (state?: 'aborted' | 'complete') => Effect.Effect<CodeGraphBenchmarkSamplerArtifact, Error | unknown>;
}

export function parseCodeGraphBenchmarkRunCheckpoint(value: unknown): CodeGraphBenchmarkRunCheckpoint {
  if (typeof value !== 'object' || value === null)
    throw ScriptError.make({message: 'Benchmark run checkpoint must be an object.'});
  const checkpoint = ratchetRecord(value, 'Benchmark run checkpoint');
  const {phase, state, updatedAt, version} = checkpoint;
  if (
    version !== 1 ||
    (state !== 'complete' && state !== 'failed' && state !== 'running') ||
    typeof phase !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(phase) ||
    typeof updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw ScriptError.make({message: 'Benchmark run checkpoint is invalid.'});
  }
  return {
    phase,
    state,
    updatedAt,
    version: 1,
  };
}

const makeBenchmarkRunCheckpoint = Effect.fn('benchmarkCodeGraph.makeRunCheckpoint')(function* (outputPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const write = (phase: string, state: CodeGraphBenchmarkRunCheckpoint['state']) => {
    const checkpoint = parseCodeGraphBenchmarkRunCheckpoint({
      phase,
      state,
      updatedAt: new Date().toISOString(),
      version: 1,
    });
    return atomicWrite(outputPath, `${JSON.stringify(checkpoint)}\n`).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(SystemInfo, system),
    );
  };
  yield* write('preparing-fixture', 'running');
  return {
    finish: state => write('finished', state).pipe(Effect.ignore),
    mark: phase => write(phase, 'running'),
  } satisfies CodeGraphBenchmarkRunCheckpointHandle;
});

function benchmarkSamplerCheckpointPath(
  path: Path.Path,
  samplerRoot: string,
  outputPath: string | undefined,
  name: 'bootstrap' | 'cold' | 'incremental' | 'same-overlay-reference',
): string {
  return outputPath ? `${outputPath}.${name}.sampler.json` : path.join(samplerRoot, `${name}.checkpoint.json`);
}

export const startExternalSampler = Effect.fn('benchmarkCodeGraph.startExternalSampler')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  samplerRoot: string,
  temporaryRoot: string,
  databasePath: string,
  checkpointPath: string,
  name: 'bootstrap' | 'cold' | 'incremental' | 'same-overlay-reference',
  rssPeakDiagnostics = false,
) {
  yield* fs.makeDirectory(samplerRoot, {recursive: true});
  const phasePath = path.join(samplerRoot, `${name}.phase`);
  const stopPath = path.join(samplerRoot, `${name}.stop`);
  const outputPath = path.join(samplerRoot, `${name}.json`);
  const readyPath = path.join(samplerRoot, `${name}.ready`);
  yield* Effect.all(
    [
      fs.remove(stopPath, {force: true}),
      fs.remove(outputPath, {force: true}),
      fs.remove(readyPath, {force: true}),
      fs.remove(checkpointPath, {force: true}),
      fs.writeFileString(phasePath, name === 'bootstrap' ? 'preparing-fixture' : 'start'),
    ],
    {concurrency: 3},
  );
  const samplerScript = yield* path.fromFileUrl(new URL('./code-graph-benchmark-sampler.ts', import.meta.url));
  const subprocess = Bun.spawn({
    cmd: [
      process.execPath,
      samplerScript,
      '--pid',
      String(process.pid),
      '--database',
      databasePath,
      '--temp-root',
      temporaryRoot,
      '--phase',
      phasePath,
      '--stop',
      stopPath,
      '--output',
      outputPath,
      '--checkpoint-output',
      checkpointPath,
      '--interval-ms',
      '25',
      '--checkpoint-ms',
      '1000',
      '--ready',
      readyPath,
      ...(rssPeakDiagnostics ? ['--rss-peak-diagnostics', 'true'] : []),
    ],
    stderr: 'pipe',
    stdout: 'ignore',
  });
  yield* waitForExternalSamplerReady(fs, readyPath, subprocess).pipe(
    Effect.onError(() => terminateExternalSampler(subprocess)),
  );
  let currentPhase = name === 'bootstrap' ? 'preparing-fixture' : 'start';
  let stopped = false;
  const markPhase = (phase: string) => {
    if (phase === currentPhase) return Effect.void;
    currentPhase = phase;
    return fs.writeFileString(phasePath, phase);
  };
  return {
    mark: progress => {
      const phase = `${progress.phase}:${'subphase' in progress && progress.subphase ? progress.subphase : 'progress'}`;
      return markPhase(phase);
    },
    markPhase,
    stop: (state = 'complete') =>
      Effect.gen(function* () {
        if (!stopped) {
          yield* fs.writeFileString(phasePath, 'finish').pipe(Effect.ignore);
          const stopSignal = yield* Effect.exit(fs.writeFileString(stopPath, state));
          if (Exit.isFailure(stopSignal)) {
            yield* terminateExternalSampler(subprocess);
            return yield* ScriptError.make({
              message: 'Could not signal the code graph benchmark sampler to stop; it was terminated.',
            });
          }
          stopped = true;
        }
        let exitCode = yield* Effect.promise(() => subprocessExitWithin(subprocess, EXTERNAL_SAMPLER_STOP_TIMEOUT_MS));
        if (exitCode === undefined) {
          yield* terminateExternalSampler(subprocess);
          exitCode = yield* Effect.promise(() =>
            subprocessExitWithin(subprocess, EXTERNAL_SAMPLER_TERMINATE_TIMEOUT_MS),
          );
          return yield* ScriptError.make({
            message:
              `Code graph benchmark sampler did not stop within ${EXTERNAL_SAMPLER_STOP_TIMEOUT_MS} ms; ` +
              `it was terminated${exitCode === undefined ? ' without confirming exit' : ''}.`,
          });
        }
        if (exitCode !== 0) {
          const stderr = subprocess.stderr ? yield* Effect.promise(() => new Response(subprocess.stderr).text()) : '';
          return yield* ScriptError.make({
            message: `Code graph benchmark sampler exited with ${exitCode}: ${Effect2.pipe(stderr, EffectString.trim) || 'no diagnostic'}`,
          });
        }
        return parseCodeGraphBenchmarkSamplerArtifact(JSON.parse(yield* fs.readFileString(outputPath)));
      }),
  } satisfies ExternalSamplerHandle;
});

const waitForExternalSamplerReady = Effect.fn('benchmarkCodeGraph.waitForExternalSamplerReady')(function* (
  fs: FileSystem.FileSystem,
  readyPath: string,
  subprocess: ReturnType<typeof Bun.spawn>,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  while (!(yield* fs.exists(readyPath))) {
    if (subprocess.exitCode !== null) {
      return yield* ScriptError.make({message: `Code graph benchmark sampler exited before becoming ready.`});
    }
    if ((yield* Clock.currentTimeMillis) - startedAt >= EXTERNAL_SAMPLER_READY_TIMEOUT_MS) {
      return yield* ScriptError.make({
        message: `Code graph benchmark sampler was not ready within ${EXTERNAL_SAMPLER_READY_TIMEOUT_MS} ms.`,
      });
    }
    yield* Effect.sleep(10);
  }
});

const terminateExternalSampler = Effect.fn('benchmarkCodeGraph.terminateExternalSampler')(function* (
  subprocess: ReturnType<typeof Bun.spawn>,
) {
  if (subprocess.exitCode !== null) return;
  subprocess.kill();
  if (
    (yield* Effect.promise(() => subprocessExitWithin(subprocess, EXTERNAL_SAMPLER_TERMINATE_TIMEOUT_MS))) !== undefined
  ) {
    return;
  }
  subprocess.kill(9);
  yield* Effect.promise(() => subprocessExitWithin(subprocess, EXTERNAL_SAMPLER_TERMINATE_TIMEOUT_MS));
});

function subprocessExitWithin(
  subprocess: ReturnType<typeof Bun.spawn>,
  timeoutMilliseconds: number,
): Promise<number | undefined> {
  if (subprocess.exitCode !== null) return Promise.resolve(subprocess.exitCode);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), timeoutMilliseconds);
    timer.unref?.();
    void subprocess.exited.then(
      code => {
        clearTimeout(timer);
        resolve(code);
      },
      () => {
        clearTimeout(timer);
        resolve(-1);
      },
    );
  });
}

const codeGraphStorageTelemetry = Effect.fn('benchmarkCodeGraph.storageTelemetry')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  databasePath: string,
  databaseRoot: string,
) {
  const repositoryRoot = path.dirname(databasePath);
  const [
    totalBytes,
    repositoryBytes,
    sqliteMainBytes,
    sqliteWalBytes,
    sqliteShmBytes,
    sqliteJournalBytes,
    vectorBytes,
    buildStatusBytes,
  ] = yield* Effect.all(
    [
      directoryBytes(fs, path, databaseRoot),
      directoryBytes(fs, path, repositoryRoot),
      regularFileBytes(fs, databasePath),
      regularFileBytes(fs, `${databasePath}-wal`),
      regularFileBytes(fs, `${databasePath}-shm`),
      regularFileBytes(fs, `${databasePath}-journal`),
      directoryBytes(fs, path, path.join(repositoryRoot, 'vectors')),
      directoryBytes(fs, path, path.join(repositoryRoot, 'build-status')),
    ],
    {concurrency: 8},
  );
  return {
    buildStatusBytes,
    sqliteMainBytes,
    sqliteJournalBytes,
    sqliteShmBytes,
    sqliteWalBytes,
    totalBytes,
    unclassifiedRepositoryBytes: Math.max(
      0,
      repositoryBytes -
        sqliteMainBytes -
        sqliteWalBytes -
        sqliteShmBytes -
        sqliteJournalBytes -
        vectorBytes -
        buildStatusBytes,
    ),
    vectorBytes,
  } satisfies CodeGraphStorageTelemetry;
});

function regularFileBytes(fs: FileSystem.FileSystem, file: string): Effect.Effect<number, unknown> {
  return fs.stat(file).pipe(
    Effect.map(info => (info.type === 'File' ? Number(info.size) : 0)),
    Effect.orElseSucceed(() => 0),
  );
}

function sqliteRowCount(databasePath: string, query: string, ...parameters: readonly string[]): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database.query<{readonly count?: bigint | number} | null, SQLQueryBindings[]>(query).get(...parameters);
    const count = Number(row?.count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0)
      throw ScriptError.make({message: `Invalid SQLite row count for ${databasePath}.`});
    return count;
  } finally {
    database.close(false);
  }
}

function sqliteLexicalTermRowCount(databasePath: string, snapshotId: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const compact = database
      .query<{readonly count?: bigint | number} | null, SQLQueryBindings[]>(
        'SELECT posting_count AS count FROM lexical_storage_formats WHERE snapshot_id = ? LIMIT 1',
      )
      .get(snapshotId);
    const row =
      compact ??
      database
        .query<
          {
            readonly count?: bigint | number;
          } | null,
          SQLQueryBindings[]
        >('SELECT COUNT(*) AS count FROM symbol_terms WHERE snapshot_id = ?')
        .get(snapshotId);
    const count = Number(row?.count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw ScriptError.make({message: `Invalid SQLite lexical term row count for ${databasePath}.`});
    }
    return count;
  } finally {
    database.close(false);
  }
}

interface CodeGraphLanguageAggregate {
  readonly files: number;
  readonly language: string;
  readonly symbols: number;
}

function sqliteLanguageCounts(databasePath: string, snapshotId: string): readonly CodeGraphLanguageAggregate[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const files = sqliteGroupedLanguageCounts(
      database
        .query('SELECT language, COUNT(*) AS count FROM snapshot_files WHERE snapshot_id = ? GROUP BY language')
        .all(snapshotId),
    );
    const symbols = sqliteGroupedLanguageCounts(
      database
        .query('SELECT language, COUNT(*) AS count FROM symbols WHERE snapshot_id = ? GROUP BY language')
        .all(snapshotId),
    );
    return EffectArray.map([...new Set([...files.keys(), ...symbols.keys()])].sort(), language => ({
      files: files.get(language) ?? 0,
      language,
      symbols: symbols.get(language) ?? 0,
    }));
  } finally {
    database.close(false);
  }
}

function sqliteGroupedLanguageCounts(rows: readonly unknown[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const value of rows) {
    const row = ratchetRecord(value, 'SQLite language aggregate');
    const language = typeof row.language === 'string' ? row.language : '';
    const count = Number(typeof row.count === 'bigint' || typeof row.count === 'number' ? row.count : -1);
    if (!/^[a-z][a-z0-9-]*$/.test(language) || !Number.isSafeInteger(count) || count < 0) {
      throw ScriptError.make({message: 'Code graph database returned an invalid privacy-safe language aggregate.'});
    }
    counts.set(language, count);
  }
  return counts;
}

function sqliteVersionString(databasePath: string): string {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database
      .query<{readonly version?: string} | null, SQLQueryBindings[]>('SELECT sqlite_version() AS version')
      .get();
    const version = row?.version ?? '';
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      throw ScriptError.make({message: 'Code graph database returned an invalid SQLite version.'});
    }
    return version;
  } finally {
    database.close(false);
  }
}

function sqlitePageSize(databasePath: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database
      .query<{readonly page_size?: bigint | number} | null, SQLQueryBindings[]>('PRAGMA page_size')
      .get();
    const pageSize = Number(row?.page_size ?? 0);
    if (!Number.isSafeInteger(pageSize) || pageSize < 512 || pageSize > 65_536) {
      throw ScriptError.make({message: 'Code graph database returned an invalid SQLite page size.'});
    }
    return pageSize;
  } finally {
    database.close(false);
  }
}

/** @internal Exposed so parity tests can exercise the persisted-delta lookup surface in SQLite. */
export function codeGraphStructuralDigestSymbolLookupStatement(
  snapshotId: string,
  baseSnapshotId: string,
): {readonly parameters: readonly string[]; readonly text: string} {
  return {
    parameters: [snapshotId, baseSnapshotId, snapshotId, snapshotId, snapshotId],
    text: `WITH effective_rows AS (
      SELECT current_rows.lookup_key, current_rows.symbol_id, current_rows.resolution_domain,
        current_rows.exported, current_rows.provenance, current_rows.evidence_edge_id,
        current_rows.evidence_path
      FROM snapshot_symbol_lookup AS current_rows
      WHERE current_rows.snapshot_id = ?
      UNION ALL
      SELECT base_rows.lookup_key, base_rows.symbol_id, base_rows.resolution_domain,
        base_rows.exported, base_rows.provenance, base_rows.evidence_edge_id,
        base_rows.evidence_path
      FROM snapshot_symbol_lookup AS base_rows
      WHERE base_rows.snapshot_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_symbol_lookup AS overrides
          WHERE overrides.snapshot_id = ?
            AND overrides.lookup_key = base_rows.lookup_key
            AND overrides.symbol_id = base_rows.symbol_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM snapshot_symbol_deletions AS removed
          WHERE removed.snapshot_id = ? AND removed.symbol_id = base_rows.symbol_id
        )
        AND (
          base_rows.provenance = 'symbol'
          OR base_rows.evidence_path IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM snapshot_files AS changed
            WHERE changed.snapshot_id = ? AND changed.path = base_rows.evidence_path
          )
        )
    )
    SELECT lookup_key, symbol_id, resolution_domain, exported, provenance,
      evidence_edge_id, evidence_path
    FROM effective_rows ORDER BY lookup_key, symbol_id`,
  };
}

export interface CodeGraphStructuralDigestStreamEvidence {
  readonly digest: string;
  readonly name: string;
  readonly rowCount: number;
}

function codeGraphAnalysisAggregateDigest(
  analysis: Pick<CodeGraphAnalysisResult, 'confidenceAudit' | 'statistics'>,
): string {
  return new Bun.CryptoHasher('sha256')
    .update(JSON.stringify({confidenceAudit: analysis.confidenceAudit, statistics: analysis.statistics}))
    .digest('hex');
}

export interface CodeGraphStructuralGraphEvidence {
  readonly digest: string;
  readonly streams: readonly CodeGraphStructuralDigestStreamEvidence[];
}

export interface CodeGraphStructuralParityMismatch {
  readonly incremental: CodeGraphStructuralDigestStreamEvidence;
  readonly name: string;
  readonly sameOverlayReference: CodeGraphStructuralDigestStreamEvidence;
}

export interface CodeGraphStructuralParityEvidence {
  readonly incremental: CodeGraphStructuralGraphEvidence;
  readonly mismatchedStreams: readonly CodeGraphStructuralParityMismatch[];
  readonly parity: boolean;
  readonly sameOverlayReference: CodeGraphStructuralGraphEvidence;
  readonly version: 1;
}

export interface CodeGraphQueryResultDigestEvidence {
  readonly canonicalDigest: string;
  readonly edgeIdentityDigest: string;
  readonly elapsedTimePartial: boolean;
  readonly nodeIdentityDigest: string;
  readonly orderedDigest: string;
  readonly resultLimitPartial: boolean;
  readonly returnedEdges: number;
  readonly returnedNodes: number;
  readonly scorelessCanonicalDigest: string;
}

export interface CodeGraphQueryResultParityEvidence {
  readonly classification:
    'elapsed-time-partial' | 'membership-drift' | 'ordered-match' | 'ordering-only' | 'payload-drift' | 'score-only';
  readonly incremental: CodeGraphQueryResultDigestEvidence;
  readonly parity: boolean;
  readonly sameOverlayReference: CodeGraphQueryResultDigestEvidence;
  readonly version: 1;
}

interface CodeGraphStructuralDigestOptions {
  /** @internal Deterministic WAL interlock used by the benchmark harness regression. */
  readonly onReadTransactionStarted?: Effect.Effect<void, unknown>;
  /** @internal Observes lease renewal without exposing benchmark repository data. */
  readonly onSnapshotLeaseRenewed?: Effect.Effect<void, unknown>;
  /** @internal Allows a short renewal cadence in focused lease tests. */
  readonly snapshotLeaseRenewalMilliseconds?: number;
}

interface CodeGraphStructuralDigestReadSnapshot {
  readonly baseSnapshotId: Option.Option<string>;
  readonly database: Database;
}

interface CodeGraphStructuralDigestStream {
  readonly name: string;
  readonly parameters: readonly (number | string)[];
  readonly query: string;
}

/** @internal Exported so the benchmark harness can verify lease and read-snapshot interlocks. */
export const sqliteStructuralGraphEvidence = Effect.fn('benchmarkCodeGraph.structuralGraphEvidence')(function* (
  databasePath: string,
  snapshotId: string,
  options: CodeGraphStructuralDigestOptions = {},
) {
  const store = yield* CodeGraphStore;
  const requestedLeaseRenewalMilliseconds =
    options.snapshotLeaseRenewalMilliseconds ?? STRUCTURAL_DIGEST_SNAPSHOT_LEASE_RENEWAL_MILLISECONDS;
  const finiteLeaseRenewalMilliseconds = Number.isFinite(requestedLeaseRenewalMilliseconds)
    ? Math.floor(requestedLeaseRenewalMilliseconds)
    : STRUCTURAL_DIGEST_SNAPSHOT_LEASE_RENEWAL_MILLISECONDS;
  const leaseRenewalMilliseconds = Math.max(
    100,
    Math.min(STRUCTURAL_DIGEST_SNAPSHOT_LEASE_MILLISECONDS / 2, finiteLeaseRenewalMilliseconds),
  );
  const lease = yield* store.acquireSnapshotLease(
    databasePath,
    snapshotId,
    STRUCTURAL_DIGEST_SNAPSHOT_LEASE_MILLISECONDS,
  );
  return yield* Effect.acquireUseRelease(
    Effect.try({
      catch: cause =>
        ScriptError.make({message: 'Could not open the code graph structural digest read snapshot.', cause}),
      try: () => openCodeGraphStructuralDigestReadSnapshot(databasePath, snapshotId),
    }),
    readSnapshot =>
      Effect.gen(function* () {
        let lastLeaseRenewal = yield* Clock.currentTimeMillis;
        yield* options.onReadTransactionStarted ?? Effect.void;
        const renewLeaseIfDue = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (now - lastLeaseRenewal < leaseRenewalMilliseconds) return;
          yield* store.renewSnapshotLease(databasePath, lease, STRUCTURAL_DIGEST_SNAPSHOT_LEASE_MILLISECONDS);
          lastLeaseRenewal = now;
          yield* options.onSnapshotLeaseRenewed ?? Effect.void;
        });
        return yield* readCodeGraphStructuralGraphEvidence(readSnapshot, snapshotId, renewLeaseIfDue);
      }),
    readSnapshot => Effect.sync(() => closeCodeGraphStructuralDigestReadSnapshot(readSnapshot)),
  ).pipe(Effect.ensuring(store.releaseSnapshotLease(databasePath, lease).pipe(Effect.ignore)));
});

function openCodeGraphStructuralDigestReadSnapshot(
  databasePath: string,
  snapshotId: string,
): CodeGraphStructuralDigestReadSnapshot {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    database.run('BEGIN');
    const snapshot = Option.fromNullishOr(
      database
        .query<{readonly base_snapshot_id?: unknown}, SQLQueryBindings[]>(
          'SELECT base_snapshot_id FROM snapshots WHERE id = ? AND state = ? LIMIT 1',
        )
        .get(snapshotId, 'ready'),
    );
    if (Option.isNone(snapshot))
      throw ScriptError.make({message: 'Ready snapshot was unavailable for the structural graph digest.'});
    return {
      baseSnapshotId:
        typeof snapshot.value.base_snapshot_id === 'string'
          ? Option.some(snapshot.value.base_snapshot_id)
          : Option.none(),
      database,
    };
  } catch (cause) {
    try {
      database.run('ROLLBACK');
    } catch {
      // The read transaction may not have started; closing still releases the connection.
    }
    database.close(false);
    throw cause;
  }
}

function closeCodeGraphStructuralDigestReadSnapshot(readSnapshot: CodeGraphStructuralDigestReadSnapshot): void {
  try {
    readSnapshot.database.run('ROLLBACK');
  } finally {
    readSnapshot.database.close(false);
  }
}

const readCodeGraphStructuralGraphEvidence = Effect.fn('benchmarkCodeGraph.readStructuralGraphEvidence')(function* (
  readSnapshot: CodeGraphStructuralDigestReadSnapshot,
  snapshotId: string,
  renewLeaseIfDue: Effect.Effect<void, unknown>,
) {
  const database = readSnapshot.database;
  const digest = new Bun.CryptoHasher('sha256');
  const baseSnapshotId = Option.getOrElse(readSnapshot.baseSnapshotId, () => '');
  const effectiveParameters = [snapshotId, baseSnapshotId, snapshotId, snapshotId] as const;
  const symbolTerms = codeGraphEffectiveSymbolTermsQueryStatement(
    snapshotId,
    Option.isSome(readSnapshot.baseSnapshotId) ? readSnapshot.baseSnapshotId.value : undefined,
  );
  const symbolLookup = codeGraphStructuralDigestSymbolLookupStatement(snapshotId, baseSnapshotId);
  // Persisted analysis summaries are optional derived caches. Their computed
  // statistics are compared above; this digest covers the underlying graph facts
  // so paged fallback and precomputed-summary snapshots remain comparable.
  const streams = [
    {
      name: 'snapshot',
      parameters: [snapshotId],
      query: `SELECT commit_id, extractor_set, dirty, overlay_fingerprint,
            file_count, symbol_count, edge_count
          FROM snapshots WHERE id = ? AND state = 'ready'`,
    },
    {
      name: 'extractor-generation',
      parameters: [snapshotId],
      query: `SELECT generation FROM snapshot_extractor_generations
          WHERE snapshot_id = ?`,
    },
    {
      name: 'files',
      parameters: effectiveParameters,
      query: `${effectiveSnapshotRowsCte('snapshot_files', 'snapshot_file_deletions', 'path', 'path')}
          SELECT path, content_hash, language, mode, size, source
          FROM effective_rows ORDER BY path`,
    },
    {
      name: 'symbols',
      parameters: effectiveParameters,
      query: `${effectiveSnapshotRowsCte('symbols', 'snapshot_symbol_deletions', 'symbol_id', 'id')}
          SELECT id, content_hash, kind, name, qualified_name, path, language, arity, lookup_keys_json,
            resolution_domain, resolution_scope_id, package_name, exported, signature, documentation, span_json
          FROM effective_rows ORDER BY path, qualified_name, id`,
    },
    {
      name: 'symbol-terms',
      parameters: symbolTerms.parameters,
      query: symbolTerms.text,
    },
    {
      name: 'symbol-lookup',
      parameters: symbolLookup.parameters,
      query: symbolLookup.text,
    },
    {
      name: 'edges',
      parameters: effectiveParameters,
      query: `${effectiveSnapshotRowsCte('edges', 'snapshot_edge_deletions', 'edge_id', 'id')}
          SELECT id, source_id, source_name, relation, target_id, target_name, provenance, confidence,
            evidence_path, evidence_span_json
          FROM effective_rows ORDER BY source_name, relation, target_name, id`,
    },
    {
      name: 'workspace-scopes',
      parameters: [snapshotId],
      query: `SELECT id, build_system, name, root, provenance, diagnostics_json
          FROM workspace_scopes WHERE snapshot_id = ? ORDER BY id`,
    },
    {
      name: 'workspace-components',
      parameters: [snapshotId],
      query: `SELECT id, workspace_id, build_system, kind, name, root, resolution_domain,
            languages_json, source_roots_json, workspace_roots_json, provenance, diagnostics_json
          FROM workspace_components WHERE snapshot_id = ? ORDER BY id`,
    },
    {
      name: 'workspace-component-dependencies',
      parameters: [snapshotId],
      query: `SELECT source_component_id, target_component_id, provenance, evidence
          FROM workspace_component_dependencies WHERE snapshot_id = ?
          ORDER BY source_component_id, target_component_id, provenance`,
    },
    {
      name: 'reexport-provenance',
      parameters: effectiveParameters,
      query: `WITH effective_rows AS (
          SELECT current_rows.source_path, current_rows.local_name,
            current_rows.target_path, current_rows.imported_name
          FROM snapshot_reexport_provenance AS current_rows
          WHERE current_rows.snapshot_id = ?
          UNION ALL
          SELECT base_rows.source_path, base_rows.local_name,
            base_rows.target_path, base_rows.imported_name
          FROM snapshot_reexport_provenance AS base_rows
          WHERE base_rows.snapshot_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM snapshot_reexport_provenance AS overrides
              WHERE overrides.snapshot_id = ?
                AND overrides.source_path = base_rows.source_path
                AND overrides.local_name = base_rows.local_name
                AND overrides.target_path = base_rows.target_path
                AND overrides.imported_name = base_rows.imported_name
            )
            AND NOT EXISTS (
              SELECT 1 FROM snapshot_files AS changed
              WHERE changed.snapshot_id = ? AND changed.path = base_rows.source_path
            )
        )
        SELECT source_path, local_name, target_path, imported_name
        FROM effective_rows ORDER BY source_path, local_name, target_path, imported_name`,
    },
  ] as const satisfies readonly CodeGraphStructuralDigestStream[];
  const evidence: CodeGraphStructuralDigestStreamEvidence[] = [];
  for (const stream of streams) {
    digest.update(`${stream.name}\0`);
    const streamDigest = new Bun.CryptoHasher('sha256');
    streamDigest.update(`${stream.name}\0`);
    let rowCount = 0;
    const rows = database.query(stream.query).iterate(...stream.parameters);
    const iterator = rows[Symbol.iterator]();
    let complete = false;
    while (!complete) {
      for (let index = 0; index < STRUCTURAL_DIGEST_ROW_CHUNK_SIZE; index += 1) {
        const next = iterator.next();
        if (next.done) {
          complete = true;
          break;
        }
        const serialized = JSON.stringify(next.value, (_key, value) =>
          typeof value === 'bigint' ? value.toString() : value,
        );
        digest.update(serialized);
        digest.update('\n');
        streamDigest.update(serialized);
        streamDigest.update('\n');
        rowCount += 1;
        if (!Number.isSafeInteger(rowCount)) {
          return yield* ScriptError.make({message: `Structural digest stream ${stream.name} is too large.`});
        }
      }
      yield* renewLeaseIfDue;
    }
    evidence.push({digest: streamDigest.digest('hex'), name: stream.name, rowCount});
  }
  return {digest: digest.digest('hex'), streams: evidence};
});

export function codeGraphStructuralParityEvidence(
  incremental: CodeGraphStructuralGraphEvidence,
  sameOverlayReference: CodeGraphStructuralGraphEvidence,
): CodeGraphStructuralParityEvidence {
  const referenceStreams = new Map(EffectArray.map(sameOverlayReference.streams, stream => [stream.name, stream]));
  if (
    referenceStreams.size !== sameOverlayReference.streams.length ||
    incremental.streams.length !== sameOverlayReference.streams.length
  ) {
    throw ScriptError.make({message: 'Structural graph digest evidence returned an inconsistent stream set.'});
  }
  const mismatchedStreams = EffectArray.flatMap(incremental.streams, stream => {
    const reference = referenceStreams.get(stream.name);
    if (!reference)
      throw ScriptError.make({message: 'Structural graph digest evidence returned an inconsistent stream set.'});
    return stream.rowCount === reference.rowCount && stream.digest === reference.digest
      ? []
      : [{incremental: stream, name: stream.name, sameOverlayReference: reference}];
  });
  return {
    incremental,
    mismatchedStreams,
    parity: incremental.digest === sameOverlayReference.digest && mismatchedStreams.length === 0,
    sameOverlayReference,
    version: 1,
  };
}

export function codeGraphStructuralParityFailureMessage(evidence: CodeGraphStructuralParityEvidence): string {
  const mismatches = EffectArray.join(
    EffectArray.map(
      evidence.mismatchedStreams,
      mismatch =>
        `${mismatch.name} incremental(count=${mismatch.incremental.rowCount},sha256=${mismatch.incremental.digest}) ` +
        `same-overlay-full(count=${mismatch.sameOverlayReference.rowCount},sha256=${mismatch.sameOverlayReference.digest})`,
    ),
    '; ',
  );
  return `Structural graph digest parity failed: ${mismatches || 'composite digest mismatch'}.`;
}

function effectiveSnapshotRowsCte(
  table: 'edges' | 'snapshot_files' | 'symbols',
  deletions: 'snapshot_edge_deletions' | 'snapshot_file_deletions' | 'snapshot_symbol_deletions',
  deletionKey: 'edge_id' | 'path' | 'symbol_id',
  rowKey: 'id' | 'path',
): string {
  return `WITH effective_rows AS (
    SELECT current_rows.* FROM ${table} AS current_rows WHERE current_rows.snapshot_id = ?
    UNION ALL
    SELECT base_rows.* FROM ${table} AS base_rows
    WHERE base_rows.snapshot_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM ${table} AS overrides
        WHERE overrides.snapshot_id = ? AND overrides.${rowKey} = base_rows.${rowKey}
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${deletions} AS removed
        WHERE removed.snapshot_id = ? AND removed.${deletionKey} = base_rows.${rowKey}
      )
  )`;
}

const vectorRowCount = Effect.fn('benchmarkCodeGraph.vectorRowCount')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  vectorRoot: string,
) {
  if (!(yield* fs.exists(vectorRoot))) return 0;
  let count = 0;
  for (const model of yield* fs.readDirectory(vectorRoot)) {
    // Ordinary maintenance owns transient cursor files beside model directories. Filter them before stat so an
    // atomic cursor cleanup cannot race this evidence-only count between readDirectory and stat.
    if (!benchmarkVectorModelDirectoryName(model)) continue;
    const modelRoot = path.join(vectorRoot, model);
    const info = yield* fs.stat(modelRoot);
    if (info.type !== 'Directory') continue;
    for (const name of yield* fs.readDirectory(modelRoot)) {
      if (!/^vectors-v\d+\.sqlite$/.test(name)) continue;
      count += sqliteRowCount(path.join(modelRoot, name), 'SELECT COUNT(*) AS count FROM vectors');
    }
  }
  return count;
});

const vectorMappingDigest = Effect.fn('benchmarkCodeGraph.vectorMappingDigest')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  vectorRoot: string,
  worktreeId: string,
) {
  if (!(yield* fs.exists(vectorRoot))) {
    return yield* ScriptError.make({message: 'Vector mapping digest requires a vector database.'});
  }
  const hash = new Bun.CryptoHasher('sha256');
  let rows = 0;
  for (const model of (yield* fs.readDirectory(vectorRoot)).sort()) {
    if (!benchmarkVectorModelDirectoryName(model)) continue;
    const modelRoot = path.join(vectorRoot, model);
    if ((yield* fs.stat(modelRoot)).type !== 'Directory') continue;
    for (const name of (yield* fs.readDirectory(modelRoot)).sort()) {
      if (!/^vectors-v\d+\.sqlite$/.test(name)) continue;
      const database = new Database(path.join(modelRoot, name), {readonly: true, strict: true});
      try {
        const mappings = database
          .query<
            {
              readonly fingerprint?: unknown;
              readonly symbol_id?: unknown;
              readonly vector?: unknown;
            },
            SQLQueryBindings[]
          >(
            `SELECT vector.symbol_id, vector.fingerprint, vector.vector
             FROM vector_pointers AS pointer
             JOIN vectors AS vector ON vector.generation = pointer.generation
             WHERE pointer.worktree_id = ?
             ORDER BY vector.symbol_id`,
          )
          .all(worktreeId);
        updateVectorMappingDigest(hash, model);
        for (const mapping of mappings) {
          if (
            typeof mapping.symbol_id !== 'string' ||
            typeof mapping.fingerprint !== 'string' ||
            !(mapping.vector instanceof Uint8Array)
          ) {
            throw ScriptError.make({message: 'Vector database returned an invalid active mapping row.'});
          }
          updateVectorMappingDigest(hash, mapping.symbol_id);
          updateVectorMappingDigest(hash, mapping.fingerprint);
          updateVectorMappingDigest(hash, mapping.vector);
          rows += 1;
        }
      } finally {
        database.close(false);
      }
    }
  }
  if (rows === 0) return yield* ScriptError.make({message: 'Vector mapping digest found no active vector rows.'});
  return hash.digest('hex');
});

function updateVectorMappingDigest(hash: Bun.CryptoHasher, value: string | Uint8Array): void {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  hash.update(`${bytes.byteLength}:`);
  hash.update(bytes);
}

function productionShapeMeasurements(
  profile: ProductionCodeGraphFixtureProfile,
  actual: {
    readonly edges: number;
    readonly files: number;
    readonly skipped: number;
    readonly symbols: number;
    readonly terms: number;
  },
): ReturnType<typeof benchmarkMeasurement>[] {
  const percent = (value: number, target: number) => (value / target) * 100;
  return [
    benchmarkMeasurement('production-shape-file-target-attainment', 'percent', [
      percent(actual.files, profile.targetEligibleFiles),
    ]),
    benchmarkMeasurement('production-shape-repository-file-target-attainment', 'percent', [
      percent(actual.files + actual.skipped, profile.targetRepositoryFiles),
    ]),
    benchmarkMeasurement('production-shape-excluded-file-target-attainment', 'percent', [
      percent(actual.skipped, profile.classMix.generatedSvgFiles + profile.classMix.duplicateHeavyJsonFiles),
    ]),
    benchmarkMeasurement('production-shape-symbol-target-attainment', 'percent', [
      percent(actual.symbols, profile.targetGraphSymbols),
    ]),
    benchmarkMeasurement('production-shape-edge-target-attainment', 'percent', [
      percent(actual.edges, profile.targetGraphEdges),
    ]),
    benchmarkMeasurement('production-shape-lexical-term-target-attainment', 'percent', [
      percent(actual.terms, profile.targetLexicalTermRows),
    ]),
  ];
}

function languageAggregateMeasurements(
  prefix: 'cold',
  aggregates: readonly CodeGraphLanguageAggregate[],
): ReturnType<typeof benchmarkMeasurement>[] {
  return EffectArray.flatMap(aggregates, aggregate => [
    benchmarkMeasurement(`${prefix}-materialized-file-rows-language-${aggregate.language}`, 'count', [aggregate.files]),
    benchmarkMeasurement(`${prefix}-materialized-symbol-rows-language-${aggregate.language}`, 'count', [
      aggregate.symbols,
    ]),
  ]);
}

interface McpOperationBenchmarkResult {
  readonly durationMilliseconds: number;
  readonly edges: number;
  readonly nodes: number;
  readonly operation: CodeGraphQueryResult['operation'];
  readonly structuredBytes: number;
  readonly textBytes: number;
  readonly truncated: boolean;
  readonly warnings: number;
}

interface BenchmarkCodeGraphQuery {
  readonly inspect: (options: CodeGraphInspectOptions) => Effect.Effect<CodeGraphQueryResult, unknown>;
  readonly status: (
    threadnoteHome: string,
    cwd: string,
    options?: CodeGraphStatusOptions,
  ) => Effect.Effect<CodeGraphStatus, unknown>;
}

const benchmarkExternalQueryControl = Effect.fn('benchmarkCodeGraph.externalQueryControl')(function* (
  query: BenchmarkCodeGraphQuery,
  repository: string,
  threadnoteHome: string,
  control: ExternalRepositoryQueryControl,
  expectedSnapshotId: string,
  phase: 'cold' | 'incremental' | 'same-overlay-reference',
) {
  const started = yield* Clock.currentTimeNanos;
  const result = yield* query
    .inspect({
      cwd: repository,
      operation: 'query',
      query: control.query,
      refresh: false,
      requestMaintenance: false,
      threadnoteHome,
    })
    .pipe(
      Effect.timeoutOrElse({
        duration: EXTERNAL_QUERY_CONTROL_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            ScriptError.make({
              message: `External ${phase} query control timed out after ${EXTERNAL_QUERY_CONTROL_TIMEOUT_MS} milliseconds.`,
            }),
          ),
      }),
    );
  const durationMilliseconds = Math.max(
    Number.EPSILON,
    Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND,
  );
  return {
    ...assertExternalQueryPositiveControl(result, {
      expectedLanguage: control.expectedLanguage,
      expectedPath: control.expectedPath,
      expectedSnapshotId,
      phase,
    }),
    durationMilliseconds,
    language: control.expectedLanguage,
  } satisfies ExternalQueryControlResult;
});

const benchmarkMcpOperationMatrix = Effect.fn('benchmarkCodeGraph.mcpOperationMatrix')(function* (
  query: BenchmarkCodeGraphQuery,
  cwd: string,
  threadnoteHome: string,
  queryText: string,
) {
  const results: McpOperationBenchmarkResult[] = [];
  const execute = Effect.fn('benchmarkCodeGraph.mcpOperation')(function* (options: CodeGraphQueryOptionsForBenchmark) {
    const started = yield* Clock.currentTimeNanos;
    const {response, result} = yield* Effect.gen(function* () {
      const status = yield* query.status(threadnoteHome, cwd, {
        observeWorktree: codeGraphInspectionObservesWorktree(options.operation),
        requestMaintenance: false,
      });
      const result = yield* query.inspect({
        ...options,
        cwd,
        edgeLimit: 80,
        nodeLimit: 40,
        refresh: false,
        requestMaintenance: false,
        statusObservation: observationFromCodeGraphStatus(status),
        threadnoteHome,
      });
      return {response: codeGraphMcpResponse(result), result};
    }).pipe(Effect.timeout(25_000));
    const structuredBytes = encodedBytes(JSON.stringify(response.structuredContent));
    const textBytes = encodedBytes(response.text);
    if (structuredBytes > 24 * 1_024 || textBytes > 24 * 1_024) {
      return yield* ScriptError.make({message: `MCP ${options.operation} output exceeded its 24 KiB per-part budget.`});
    }
    const finished = yield* Clock.currentTimeNanos;
    results.push({
      durationMilliseconds: Number(finished - started) / NANOSECONDS_PER_MILLISECOND,
      edges: response.structuredContent.edges.length,
      nodes: response.structuredContent.nodes.length,
      operation: options.operation,
      structuredBytes,
      textBytes,
      truncated: response.structuredContent.output.truncated,
      warnings: response.structuredContent.warnings.length,
    });
    return result;
  });

  const lexical = yield* execute({operation: 'query', query: queryText});
  const seed = lexical.nodes[0];
  if (!seed) return yield* ScriptError.make({message: 'MCP operation matrix query returned no seed node.'});
  yield* execute({nodeId: seed.id, operation: 'node'});
  const neighbors = yield* execute({depth: 1, nodeId: seed.id, operation: 'neighbors'});
  yield* execute({operation: 'explain', symbol: seed.id});
  yield* execute({operation: 'impact', query: seed.id});
  const peer =
    Option.getOrUndefined(EffectArray.findFirst(neighbors.nodes, node => node.id !== seed.id))?.id ??
    Option.getOrUndefined(EffectArray.findFirst(neighbors.edges, edge => edge.sourceId === seed.id))?.targetId ??
    Option.getOrUndefined(EffectArray.findFirst(neighbors.edges, edge => edge.targetId === seed.id))?.sourceId ??
    seed.id;
  yield* execute({depth: 8, from: seed.id, operation: 'path', to: peer});
  return results;
});

type CodeGraphQueryOptionsForBenchmark = Omit<
  CodeGraphInspectOptions,
  'cwd' | 'edgeLimit' | 'nodeLimit' | 'refresh' | 'threadnoteHome'
>;

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

interface TimedEffectResult<A> {
  readonly durationMilliseconds: number;
  readonly payloadBytes: number;
  readonly value: A;
}

const timedJsonEffect = Effect.fn('benchmarkCodeGraph.timedJsonEffect')(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const started = yield* Clock.currentTimeNanos;
  const value = yield* effect;
  const encoded = JSON.stringify(value);
  const durationMilliseconds = Math.max(
    Number.EPSILON,
    Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND,
  );
  return {
    durationMilliseconds,
    payloadBytes: encodedBytes(encoded),
    value,
  } satisfies TimedEffectResult<A>;
});

export function assertManagerVisualizationBounds(
  label: string,
  graph: Pick<GraphVisualization, 'edges' | 'nodes' | 'paging'>,
  limits: {readonly edgeLimit: number; readonly nodeLimit: number},
): void {
  if (
    graph.nodes.length > limits.nodeLimit ||
    graph.edges.length > limits.edgeLimit ||
    graph.paging.nodeLimit !== limits.nodeLimit ||
    graph.paging.edgeLimit !== limits.edgeLimit
  ) {
    throw ScriptError.make({message: `Manager benchmark ${label} exceeded or misreported its requested graph budget.`});
  }
}

const benchmarkManagerPerformanceMeasured = Effect.fn('benchmarkCodeGraph.managerPerformanceMeasured')(function* (
  threadnoteHome: string,
  expectedRepositoryId: string,
  expectedSnapshotId: string,
  queryText: string,
  samples: number,
  warmups: number,
) {
  const catalogCold = yield* timedJsonEffect(managerGraphCatalog(threadnoteHome));
  const repositoryGroup = Option.getOrUndefined(
    EffectArray.findFirst(
      catalogCold.value.repositories,
      repository => repository.repositoryId === expectedRepositoryId,
    ),
  );
  const indexedView = Option.getOrUndefined(
    Option.map(Option.fromNullishOr(repositoryGroup?.views), __effectArrayReceiver =>
      Option.getOrUndefined(
        EffectArray.findFirst(
          __effectArrayReceiver,
          view => view.snapshot.id === expectedSnapshotId && view.snapshot.state === 'ready',
        ),
      ),
    ),
  );
  if (!indexedView) {
    return yield* ScriptError.make({message: 'Manager benchmark catalog did not expose the expected ready snapshot.'});
  }
  const expectedSnapshot = Option.some(expectedSnapshotId);
  const catalogWarmSamples = Math.max(1, Math.min(samples, 5));
  const catalogWarm = yield* Effect.forEach(
    Array.from({length: catalogWarmSamples}),
    () => timedJsonEffect(managerGraphCatalog(threadnoteHome)),
    {concurrency: 1},
  );
  const overviewCold = yield* timedJsonEffect(
    managerGraphVisualization(
      threadnoteHome,
      indexedView.id,
      'all',
      {edgeLimit: MANAGER_GRAPH_MAX_EDGE_LIMIT, nodeLimit: MANAGER_GRAPH_MAX_NODE_LIMIT},
      expectedSnapshot,
    ),
  );
  const overviewWarm = yield* Effect.forEach(
    Array.from({length: catalogWarmSamples}),
    () =>
      timedJsonEffect(
        managerGraphVisualization(
          threadnoteHome,
          indexedView.id,
          'all',
          {edgeLimit: MANAGER_GRAPH_MAX_EDGE_LIMIT, nodeLimit: MANAGER_GRAPH_MAX_NODE_LIMIT},
          expectedSnapshot,
        ),
      ),
    {concurrency: 1},
  );
  assertManagerVisualizationBounds('overview cold response', overviewCold.value, {
    edgeLimit: MANAGER_GRAPH_MAX_EDGE_LIMIT,
    nodeLimit: MANAGER_GRAPH_MAX_NODE_LIMIT,
  });
  if (overviewCold.value.nodes.length === 0) {
    return yield* ScriptError.make({message: 'Manager benchmark overview returned no graph nodes.'});
  }
  for (const sample of overviewWarm) {
    assertManagerVisualizationBounds('overview warm response', sample.value, {
      edgeLimit: MANAGER_GRAPH_MAX_EDGE_LIMIT,
      nodeLimit: MANAGER_GRAPH_MAX_NODE_LIMIT,
    });
  }
  const project =
    Option.getOrUndefined(EffectArray.findFirst(indexedView.projects, candidate => (candidate.symbolCount ?? 1) > 0)) ??
    indexedView.projects[0];
  if (!project) return yield* ScriptError.make({message: 'Manager benchmark snapshot has no project detail scope.'});
  const detailCold = yield* timedJsonEffect(
    managerGraphVisualization(
      threadnoteHome,
      indexedView.id,
      project.id,
      {edgeLimit: MANAGER_GRAPH_MAX_EDGE_LIMIT, nodeLimit: MANAGER_GRAPH_MAX_NODE_LIMIT},
      expectedSnapshot,
    ),
  );
  assertManagerVisualizationBounds('project detail response', detailCold.value, {
    edgeLimit: MANAGER_GRAPH_MAX_EDGE_LIMIT,
    nodeLimit: MANAGER_GRAPH_MAX_NODE_LIMIT,
  });
  if (detailCold.value.nodes.length === 0) {
    return yield* ScriptError.make({message: 'Manager benchmark selected project detail returned no graph nodes.'});
  }

  for (let index = 0; index < warmups; index += 1) {
    yield* managerGraphQuery(
      threadnoteHome,
      indexedView.id,
      queryText,
      {edgeLimit: MANAGER_QUERY_EDGE_LIMIT, nodeLimit: MANAGER_QUERY_NODE_LIMIT},
      expectedSnapshot,
    );
  }
  const querySamples = yield* Effect.forEach(
    Array.from({length: samples}),
    () =>
      timedJsonEffect(
        managerGraphQuery(
          threadnoteHome,
          indexedView.id,
          queryText,
          {edgeLimit: MANAGER_QUERY_EDGE_LIMIT, nodeLimit: MANAGER_QUERY_NODE_LIMIT},
          expectedSnapshot,
        ),
      ),
    {concurrency: 1},
  );
  const queryResult = querySamples[0]?.value;
  if (!queryResult || queryResult.nodes.length === 0) {
    return yield* ScriptError.make({message: 'Manager benchmark bounded query returned no graph nodes.'});
  }
  for (const sample of querySamples) {
    assertManagerVisualizationBounds('bounded query response', sample.value, {
      edgeLimit: MANAGER_QUERY_EDGE_LIMIT,
      nodeLimit: MANAGER_QUERY_NODE_LIMIT,
    });
  }
  const nodeDetail = yield* timedJsonEffect(
    managerGraphNodeDetail(threadnoteHome, indexedView.id, queryResult.nodes[0].id, expectedSnapshot),
  );
  const renderGraph = [overviewCold.value, detailCold.value, queryResult].sort(
    (left, right) => right.nodes.length + right.edges.length - (left.nodes.length + left.edges.length),
  )[0];
  const layoutPreparationProxyMilliseconds: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = yield* Clock.currentTimeNanos;
    const rendered = managerGraphClientRenderProxy(renderGraph);
    layoutPreparationProxyMilliseconds.push(
      Math.max(Number.EPSILON, Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND),
    );
    if (rendered.nodes !== renderGraph.nodes.length || rendered.matchedEdges > renderGraph.edges.length) {
      return yield* ScriptError.make({
        message: 'Manager benchmark layout-preparation proxy did not preserve its bounded graph input.',
      });
    }
  }

  const staleSnapshotRejected = yield* managerGraphVisualization(
    threadnoteHome,
    indexedView.id,
    'all',
    {edgeLimit: MANAGER_GRAPH_MAX_EDGE_LIMIT, nodeLimit: MANAGER_GRAPH_MAX_NODE_LIMIT},
    Option.some(`cgsn_${Effect2.pipe('0', EffectString.repeat(40))}`),
  ).pipe(Effect.match({onFailure: () => true, onSuccess: () => false}));
  const snapshotBindingPassed =
    overviewCold.value.repository.snapshot.id === expectedSnapshotId &&
    detailCold.value.repository.snapshot.id === expectedSnapshotId &&
    EffectArray.every(querySamples, sample => sample.value.repository.snapshot.id === expectedSnapshotId) &&
    nodeDetail.value.snapshotId === expectedSnapshotId &&
    staleSnapshotRejected;
  if (!snapshotBindingPassed) {
    return yield* ScriptError.make({message: 'Manager benchmark did not preserve exact snapshot binding.'});
  }

  const scope = `${indexedView.id}:${expectedSnapshotId}:${queryText}:${MANAGER_QUERY_NODE_LIMIT}:${MANAGER_QUERY_EDGE_LIMIT}`;
  const requestInput = {expectedQuery: queryText, expectedSnapshotId, scope};
  const services = yield* Effect.context<ApplicationServices>();
  const runManagerQuery = (signal?: AbortSignal): Promise<GraphQueryVisualization> =>
    Effect.runPromiseWith(services)(
      managerGraphQuery(
        threadnoteHome,
        indexedView.id,
        queryText,
        {edgeLimit: MANAGER_QUERY_EDGE_LIMIT, nodeLimit: MANAGER_QUERY_NODE_LIMIT},
        expectedSnapshot,
      ),
      signal ? {signal} : undefined,
    );
  const awaitRequestPair = <A, B>(left: Promise<A>, right: Promise<B>, cancel: () => void) =>
    Effect.tryPromise({
      try: signal => {
        const cancelOnInterrupt = (): void => cancel();
        signal.addEventListener('abort', cancelOnInterrupt, {once: true});
        return Promise.all([left, right] as const).finally(() =>
          signal.removeEventListener('abort', cancelOnInterrupt),
        );
      },
      catch: cause => scriptError(cause),
    });

  const cancellationGate = createGraphQueryRequestGate();
  const staleResponseGate = createGraphQueryRequestGate();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      cancellationGate.cancelCurrent();
      staleResponseGate.cancelCurrent();
    }),
  );
  const cancellableQueryStarted = yield* Deferred.make<void>();
  const cancellableQueryInterrupted = yield* Deferred.make<void>();
  let cancelledSignal: AbortSignal | undefined;
  const cancelledRequest = cancellationGate.request(requestInput, signal => {
    cancelledSignal = signal;
    return Effect.runPromiseWith(services)(
      managerGraphQuery(
        threadnoteHome,
        indexedView.id,
        queryText,
        {edgeLimit: MANAGER_QUERY_EDGE_LIMIT, nodeLimit: MANAGER_QUERY_NODE_LIMIT},
        expectedSnapshot,
      ).pipe(
        Effect.provideService(
          ManagerGraphQueryLifecycle,
          ManagerGraphQueryLifecycle.of({
            beforeTraversal: Deferred.succeed(cancellableQueryStarted, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        ),
        Effect.onInterrupt(() => Deferred.succeed(cancellableQueryInterrupted, undefined).pipe(Effect.asVoid)),
      ),
      {signal},
    );
  });
  yield* Deferred.await(cancellableQueryStarted);
  const acceptedAfterCancellation = cancellationGate.request(requestInput, runManagerQuery);
  yield* Deferred.await(cancellableQueryInterrupted);
  const [cancelledOutcome, acceptedAfterCancellationOutcome] = yield* awaitRequestPair(
    cancelledRequest.result,
    acceptedAfterCancellation.result,
    () => cancellationGate.cancelCurrent(),
  );
  const requestCancellationPassed =
    cancelledSignal?.aborted === true &&
    cancelledOutcome.state === 'cancelled' &&
    acceptedAfterCancellationOutcome.state === 'accepted';
  if (!requestCancellationPassed) {
    return yield* ScriptError.make({message: 'Manager benchmark request-cancellation control failed.'});
  }

  const lateQueryCompleted = yield* Deferred.make<void>();
  const releaseLateResponse = yield* Deferred.make<void>();
  let lateSignal: AbortSignal | undefined;
  const lateRequest = staleResponseGate.request(requestInput, signal => {
    lateSignal = signal;
    return Effect.runPromiseWith(services)(
      Effect.gen(function* () {
        const graph = yield* managerGraphQuery(
          threadnoteHome,
          indexedView.id,
          queryText,
          {edgeLimit: MANAGER_QUERY_EDGE_LIMIT, nodeLimit: MANAGER_QUERY_NODE_LIMIT},
          expectedSnapshot,
        );
        yield* Deferred.succeed(lateQueryCompleted, undefined);
        yield* Deferred.await(releaseLateResponse);
        return graph;
      }),
    );
  });
  yield* Deferred.await(lateQueryCompleted);
  const acceptedAfterLateResponse = staleResponseGate.request(requestInput, runManagerQuery);
  yield* Deferred.succeed(releaseLateResponse, undefined);
  const [lateOutcome, acceptedAfterLateResponseOutcome] = yield* awaitRequestPair(
    lateRequest.result,
    acceptedAfterLateResponse.result,
    () => staleResponseGate.cancelCurrent(),
  );
  if (lateOutcome.state === 'stale') {
    assertManagerVisualizationBounds('rejected late query response', lateOutcome.graph, {
      edgeLimit: MANAGER_QUERY_EDGE_LIMIT,
      nodeLimit: MANAGER_QUERY_NODE_LIMIT,
    });
  }
  const staleResponseRejectionPassed =
    lateSignal?.aborted === true &&
    lateOutcome.state === 'stale' &&
    acceptedAfterLateResponseOutcome.state === 'accepted';
  if (!staleResponseRejectionPassed) {
    return yield* ScriptError.make({message: 'Manager benchmark stale-response rejection control failed.'});
  }

  return {
    catalogColdMilliseconds: [catalogCold.durationMilliseconds],
    catalogWarmMilliseconds: EffectArray.map(catalogWarm, sample => sample.durationMilliseconds),
    detailColdMilliseconds: [detailCold.durationMilliseconds],
    detailEdgeCount: detailCold.value.edges.length,
    detailNodeCount: detailCold.value.nodes.length,
    edgeBudget: MANAGER_GRAPH_MAX_EDGE_LIMIT,
    maxResponsePayloadBytes: [
      catalogCold.payloadBytes,
      ...EffectArray.map(catalogWarm, sample => sample.payloadBytes),
      overviewCold.payloadBytes,
      ...EffectArray.map(overviewWarm, sample => sample.payloadBytes),
      detailCold.payloadBytes,
      nodeDetail.payloadBytes,
      ...EffectArray.map(querySamples, sample => sample.payloadBytes),
    ],
    nodeBudget: MANAGER_GRAPH_MAX_NODE_LIMIT,
    nodeDetailColdMilliseconds: [nodeDetail.durationMilliseconds],
    overviewColdMilliseconds: [overviewCold.durationMilliseconds],
    overviewEdgeCount: overviewCold.value.edges.length,
    overviewNodeCount: overviewCold.value.nodes.length,
    overviewWarmMilliseconds: EffectArray.map(overviewWarm, sample => sample.durationMilliseconds),
    queryMilliseconds: EffectArray.map(querySamples, sample => sample.durationMilliseconds),
    queryPayloadBytes: EffectArray.map(querySamples, sample => sample.payloadBytes),
    layoutPreparationProxyMilliseconds,
    requestCancellationPassed: true,
    snapshotBindingPassed: true,
    staleResponseRejectionPassed: true,
  } satisfies ManagerPerformanceEvidence;
});

export const benchmarkManagerPerformance = Effect.fn('benchmarkCodeGraph.managerPerformance')(function* (
  threadnoteHome: string,
  expectedRepositoryId: string,
  expectedSnapshotId: string,
  queryText: string,
  samples: number,
  warmups: number,
) {
  return yield* retryManagerBenchmarkBusy(() =>
    Effect.scoped(
      benchmarkManagerPerformanceMeasured(
        threadnoteHome,
        expectedRepositoryId,
        expectedSnapshotId,
        queryText,
        samples,
        warmups,
      ),
    ),
  ).pipe(
    Effect.timeoutOrElse({
      duration: MANAGER_SEQUENCE_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          ScriptError.make({
            message: `Manager benchmark sequence timed out after ${MANAGER_SEQUENCE_TIMEOUT_MS} milliseconds.`,
          }),
        ),
    }),
  );
});

/** @internal Models the Manager HTTP client's documented retry-after contract in benchmark callers. */
export function retryManagerBenchmarkBusy<A, E, R>(
  operation: () => Effect.Effect<A, E, R>,
  remainingAttempts = MANAGER_BUSY_RETRY_ATTEMPTS,
  retryDelayMilliseconds = MANAGER_BUSY_RETRY_MILLISECONDS,
): Effect.Effect<A, E, R> {
  return Effect.suspend(operation).pipe(
    Effect.catchIf(
      error => Schema.is(ManagerGraphBusyError)(error) && remainingAttempts > 0,
      () =>
        Effect.sleep(retryDelayMilliseconds).pipe(
          Effect.andThen(retryManagerBenchmarkBusy(operation, remainingAttempts - 1, retryDelayMilliseconds)),
        ),
    ),
  );
}

function mcpOperationMatrixMeasurements(
  results: readonly McpOperationBenchmarkResult[],
): ReturnType<typeof benchmarkMeasurement>[] {
  return EffectArray.flatMap(results, result => [
    benchmarkMeasurement(`mcp-${result.operation}-duration`, 'milliseconds', [result.durationMilliseconds]),
    benchmarkMeasurement(`mcp-${result.operation}-structured-output`, 'bytes', [result.structuredBytes]),
    benchmarkMeasurement(`mcp-${result.operation}-text-output`, 'bytes', [result.textBytes]),
    benchmarkMeasurement(`mcp-${result.operation}-returned-nodes`, 'count', [result.nodes]),
    benchmarkMeasurement(`mcp-${result.operation}-returned-edges`, 'count', [result.edges]),
    benchmarkMeasurement(`mcp-${result.operation}-truncated`, 'count', [result.truncated ? 1 : 0]),
    benchmarkMeasurement(`mcp-${result.operation}-warnings`, 'count', [result.warnings]),
  ]);
}

function managerPerformanceMeasurements(
  evidence: ManagerPerformanceEvidence | undefined,
): ReturnType<typeof benchmarkMeasurement>[] {
  if (!evidence) return [];
  return [
    benchmarkMeasurement('manager-catalog-cold', 'milliseconds', evidence.catalogColdMilliseconds),
    benchmarkMeasurement('manager-catalog-warm', 'milliseconds', evidence.catalogWarmMilliseconds),
    benchmarkMeasurement('manager-overview-cold', 'milliseconds', evidence.overviewColdMilliseconds),
    benchmarkMeasurement('manager-overview-warm', 'milliseconds', evidence.overviewWarmMilliseconds),
    benchmarkMeasurement('manager-detail-cold', 'milliseconds', evidence.detailColdMilliseconds),
    benchmarkMeasurement('manager-node-detail-cold', 'milliseconds', evidence.nodeDetailColdMilliseconds),
    benchmarkMeasurement(
      'manager-layout-preparation-proxy',
      'milliseconds',
      evidence.layoutPreparationProxyMilliseconds,
    ),
    benchmarkMeasurement('manager-response-payload', 'bytes', evidence.maxResponsePayloadBytes),
    benchmarkMeasurement('manager-bounded-query', 'milliseconds', evidence.queryMilliseconds),
    benchmarkMeasurement('manager-bounded-query-payload', 'bytes', evidence.queryPayloadBytes),
    benchmarkMeasurement('manager-overview-node-count', 'count', [evidence.overviewNodeCount]),
    benchmarkMeasurement('manager-overview-edge-count', 'count', [evidence.overviewEdgeCount]),
    benchmarkMeasurement('manager-detail-node-count', 'count', [evidence.detailNodeCount]),
    benchmarkMeasurement('manager-detail-edge-count', 'count', [evidence.detailEdgeCount]),
  ];
}

function concurrentWorktreeMeasurements(
  evidence: ConcurrentWorktreeEvidence | undefined,
): ReturnType<typeof benchmarkMeasurement>[] {
  return evidence
    ? [benchmarkMeasurement('concurrent-worktree-isolation-duration', 'milliseconds', [evidence.durationMilliseconds])]
    : [];
}

export interface ExternalQueryControlResult {
  readonly digest: string;
  readonly durationMilliseconds: number;
  readonly expectedMatches: number;
  readonly language: string;
  readonly result?: CodeGraphQueryResult;
  readonly returnedNodes: number;
  readonly stableNodeId: string;
}

function externalQueryControlMeasurements(
  phase: 'cold' | 'incremental' | 'same-overlay-reference',
  controls: readonly ExternalQueryControlResult[],
): ReturnType<typeof benchmarkMeasurement>[] {
  return EffectArray.flatMap(controls, control => [
    benchmarkMeasurement(`external-query-${phase}-${control.language}-duration`, 'milliseconds', [
      control.durationMilliseconds,
    ]),
    benchmarkMeasurement(`external-query-${phase}-${control.language}-returned-nodes`, 'count', [
      control.returnedNodes,
    ]),
    benchmarkMeasurement(`external-query-${phase}-${control.language}-expected-path-language-nodes`, 'count', [
      control.expectedMatches,
    ]),
  ]);
}

function externalQueryControlParityMeasurements(
  incremental: readonly ExternalQueryControlResult[],
  reference: readonly ExternalQueryControlResult[],
): ReturnType<typeof benchmarkMeasurement>[] {
  const referenceByLanguage = new Map(EffectArray.map(reference, control => [control.language, control]));
  return EffectArray.map(incremental, control =>
    benchmarkMeasurement(`external-query-${control.language}-same-overlay-structural-parity`, 'count', [
      referenceByLanguage.get(control.language)?.digest === control.digest &&
      referenceByLanguage.get(control.language)?.stableNodeId === control.stableNodeId
        ? 1
        : 0,
    ]),
  );
}

const performanceControlMetadataKey = (language: string): string => (language === 'bazel-build' ? 'bazel' : language);

export const performanceControlExpectedNodeLanguage = (language: string): string =>
  language === 'bazel-build' ? 'starlark' : language;

export function retainedExternalControlEvidence(
  controls: readonly ExternalRepositoryQueryControl[],
  coldResults: readonly ExternalQueryControlResult[],
): string {
  const resultByLanguage = new Map(EffectArray.map(coldResults, result => [result.language, result]));
  const entries = EffectArray.map(controls, control => {
    const result = resultByLanguage.get(control.expectedLanguage);
    if (!result) throw ScriptError.make({message: 'External control evidence is missing a cold query result.'});
    return [
      performanceControlMetadataKey(control.expectedLanguage),
      {
        path: privacySafeExternalControlPath(control.expectedPath),
        query: privacySafeExternalControlQuery(control.query),
        stableNodeId: result.stableNodeId,
      },
    ] as const;
  }).sort(([left], [right]) => Effect2.pipe(left, EffectString.localeCompare(right, ['en'])));
  if (new Set(EffectArray.map(entries, ([language]) => language)).size !== entries.length) {
    throw ScriptError.make({message: 'External control evidence contains duplicate public language categories.'});
  }
  return JSON.stringify(EffectRecord.fromEntries(entries));
}

export function assertPerformanceControlSet(controls: readonly ExternalRepositoryQueryControl[]): void {
  const actual = [...new Set(EffectArray.map(controls, control => control.expectedLanguage))].sort();
  const expected = [...PERFORMANCE_CONTROL_LANGUAGES].sort();
  if (
    controls.length !== PERFORMANCE_CONTROL_LANGUAGES.length ||
    actual.length !== expected.length ||
    EffectArray.some(actual, (language, index) => language !== expected[index])
  ) {
    throw ScriptError.make({
      message: `Release-bound external performance evidence requires exactly ${EffectArray.join(PERFORMANCE_CONTROL_LANGUAGES, ', ')} controls.`,
    });
  }
}

function assertExternalQueryPositiveControl(
  result: CodeGraphQueryResult,
  expected: {
    readonly expectedLanguage: string;
    readonly expectedPath: string;
    readonly expectedSnapshotId: string;
    readonly phase: 'cold' | 'incremental' | 'same-overlay-reference';
  },
): {
  readonly digest: string;
  readonly expectedMatches: number;
  readonly result: CodeGraphQueryResult;
  readonly returnedNodes: number;
  readonly stableNodeId: string;
} {
  const expectedNodes = EffectArray.filter(
    result.nodes,
    node =>
      node.path === expected.expectedPath &&
      node.language === performanceControlExpectedNodeLanguage(expected.expectedLanguage),
  );
  if (result.snapshot.id !== expected.expectedSnapshotId || result.nodes.length === 0 || expectedNodes.length === 0) {
    throw ScriptError.make({
      message:
        `External repository ${expected.phase} query did not resolve its expected tracked path and language; ` +
        'the query and path were omitted from this diagnostic.',
    });
  }
  return {
    digest: queryResultStructuralDigest(result),
    expectedMatches: expectedNodes.length,
    result,
    returnedNodes: result.nodes.length,
    stableNodeId: expectedNodes[0].id,
  };
}

function assertPrimaryQueryPositiveControl(
  result: CodeGraphQueryResult,
  expectedSnapshotId: string,
  phase: 'cold' | 'incremental' | 'same-overlay-reference',
): {readonly digest: string; readonly result: CodeGraphQueryResult; readonly returnedNodes: number} {
  if (result.snapshot.id !== expectedSnapshotId || result.nodes.length === 0) {
    throw ScriptError.make({message: `Code graph ${phase} primary query returned no current-snapshot nodes.`});
  }
  return {digest: queryResultStructuralDigest(result), result, returnedNodes: result.nodes.length};
}

function queryResultStructuralDigest(result: CodeGraphQueryResult): string {
  const digest = new Bun.CryptoHasher('sha256');
  digest.update(
    JSON.stringify({
      edges: result.edges,
      nodes: EffectArray.map(result.nodes, ({contentHash: _contentHash, ...node}) => node),
      operation: result.operation,
    }),
  );
  return digest.digest('hex');
}

function queryResultDigest(value: unknown): string {
  const digest = new Bun.CryptoHasher('sha256');
  digest.update(JSON.stringify(value));
  return digest.digest('hex');
}

function compareIdentity(left: {readonly id: string}, right: {readonly id: string}): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function queryResultDigestEvidence(result: CodeGraphQueryResult): CodeGraphQueryResultDigestEvidence {
  const nodes = EffectArray.map(result.nodes, ({contentHash: _contentHash, ...node}) => node);
  const canonicalNodes = [...nodes].sort(compareIdentity);
  const canonicalEdges = [...result.edges].sort(compareIdentity);
  const scorelessCanonicalNodes = EffectArray.map(canonicalNodes, ({score: _score, ...node}) => node);
  return {
    canonicalDigest: queryResultDigest({edges: canonicalEdges, nodes: canonicalNodes, operation: result.operation}),
    edgeIdentityDigest: queryResultDigest(EffectArray.map(canonicalEdges, edge => edge.id)),
    elapsedTimePartial: EffectArray.some(result.warnings, warning =>
      Effect2.pipe(warning, EffectString.includes('elapsed-time budget')),
    ),
    nodeIdentityDigest: queryResultDigest(EffectArray.map(canonicalNodes, node => node.id)),
    orderedDigest: queryResultStructuralDigest(result),
    resultLimitPartial: EffectArray.some(result.warnings, warning =>
      Effect2.pipe(warning, EffectString.includes('configured result limit')),
    ),
    returnedEdges: result.edges.length,
    returnedNodes: result.nodes.length,
    scorelessCanonicalDigest: queryResultDigest({
      edges: canonicalEdges,
      nodes: scorelessCanonicalNodes,
      operation: result.operation,
    }),
  };
}

/** @internal Privacy-safe classification for release-benchmark query parity failures. */
export function codeGraphQueryResultParityEvidence(
  incrementalResult: CodeGraphQueryResult,
  sameOverlayReferenceResult: CodeGraphQueryResult,
): CodeGraphQueryResultParityEvidence {
  const incremental = queryResultDigestEvidence(incrementalResult);
  const sameOverlayReference = queryResultDigestEvidence(sameOverlayReferenceResult);
  const parity = incremental.orderedDigest === sameOverlayReference.orderedDigest;
  const identitiesMatch =
    incremental.nodeIdentityDigest === sameOverlayReference.nodeIdentityDigest &&
    incremental.edgeIdentityDigest === sameOverlayReference.edgeIdentityDigest;
  const classification = parity
    ? 'ordered-match'
    : incremental.elapsedTimePartial || sameOverlayReference.elapsedTimePartial
      ? 'elapsed-time-partial'
      : incremental.canonicalDigest === sameOverlayReference.canonicalDigest
        ? 'ordering-only'
        : incremental.scorelessCanonicalDigest === sameOverlayReference.scorelessCanonicalDigest
          ? 'score-only'
          : identitiesMatch
            ? 'payload-drift'
            : 'membership-drift';
  return {classification, incremental, parity, sameOverlayReference, version: 1};
}

/** @internal Stable privacy-safe diagnostic; no query text, paths, symbols, or raw graph payloads are included. */
export function codeGraphQueryResultParityFailureMessage(evidence: CodeGraphQueryResultParityEvidence): string {
  const phase = (value: CodeGraphQueryResultDigestEvidence): string =>
    `nodes=${value.returnedNodes}, edges=${value.returnedEdges}, ` +
    `elapsedTimePartial=${value.elapsedTimePartial}, resultLimitPartial=${value.resultLimitPartial}, ` +
    `ordered=${Effect2.pipe(value.orderedDigest, EffectString.slice(0, 12))}, canonical=${Effect2.pipe(value.canonicalDigest, EffectString.slice(0, 12))}, ` +
    `scoreless=${Effect2.pipe(value.scorelessCanonicalDigest, EffectString.slice(0, 12))}, ` +
    `nodeIds=${Effect2.pipe(value.nodeIdentityDigest, EffectString.slice(0, 12))}, edgeIds=${Effect2.pipe(value.edgeIdentityDigest, EffectString.slice(0, 12))}`;
  return (
    `Primary query parity failed (${evidence.classification}); ` +
    `incremental ${phase(evidence.incremental)}; ` +
    `same-overlay-reference ${phase(evidence.sameOverlayReference)}.`
  );
}

export function assertProductionReleaseEvidence(artifact: BenchmarkArtifactV1): void {
  assertProductionLargeEvidence(artifact, 'full-release');
}

export function assertGovernedReducedProductionReleaseEvidence(artifact: BenchmarkArtifactV1): void {
  assertProductionLargeEvidence(artifact, 'governed-reduced-release');
}

function assertProductionLargeEvidence(
  artifact: BenchmarkArtifactV1,
  releaseProfile?: 'full-release' | 'governed-reduced-release',
): void {
  if (!Effect2.pipe(artifact.suite, EffectString.startsWith('code-graph-production-large-'))) {
    throw ScriptError.make({message: `Production release evidence has the wrong suite: ${artifact.suite}.`});
  }
  const measurements = new Map(EffectArray.map(artifact.measurements, measurement => [measurement.name, measurement]));
  const missing = EffectArray.flatMap(PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS, required => {
    const measurement = measurements.get(required.name);
    return measurement?.unit === required.unit ? [] : [`${required.name} (${required.unit})`];
  });
  missing.push(...missingMaterializationReplayEquations(measurements));
  missing.push(...missingMaterializationQueryIndexRestorationEvidence(measurements));
  missing.push(...missingMaterializationStorageHighWaterEvidence(measurements));
  if (artifact.metadata.oneFileReindexMaterializationMode !== 'incremental-overlay') {
    missing.push('one-file reindex incremental-overlay materialization mode');
  }
  if (artifact.metadata.coldMaterializationStorageMode !== 'direct-persistent') {
    missing.push('cold direct-persistent materialization storage mode');
  }
  if (artifact.metadata.sameOverlayReferenceMaterializationMode !== 'full') {
    missing.push('same-overlay full rebuild materialization mode');
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(artifact.metadata.sqliteVersion ?? ''))) {
    missing.push('SQLite version');
  }
  if (releaseProfile) {
    missing.push(...missingReleaseSourceProvenance(artifact));
    missing.push(
      ...(releaseProfile === 'full-release'
        ? missingReviewedProductionProfile(artifact)
        : missingGovernedReducedProductionProfile(artifact)),
    );
  }
  missing.push(...missingBenchmarkRuntimeProvenance(artifact));
  missing.push(...missingProductionShapeTargetAttainment(measurements, artifact, releaseProfile));
  missing.push(...missingDeterministicParityEvidence(measurements));
  missing.push(...missingSamplerObservations(measurements));
  missing.push(...missingActivationObservations(artifact, measurements));
  if (missing.length > 0) {
    throw ScriptError.make({message: `Production release evidence is incomplete: ${EffectArray.join(missing, ', ')}.`});
  }
}

function missingMaterializationStorageHighWaterEvidence(
  measurements: ReadonlyMap<string, BenchmarkArtifactV1['measurements'][number]>,
): readonly string[] {
  const value = (name: string) => {
    const measurement = measurements.get(name);
    return measurement === undefined ? undefined : exactSingleSampleCount(measurement);
  };
  const missing = EffectArray.flatMap(['cold', 'one-file-reindex', 'same-overlay-reference'] as const, prefix => {
    const filesystem = value(`${prefix}-materialization-durable-filesystem-high-water-n1`);
    const journal = value(`${prefix}-materialization-durable-journal-high-water-n1`);
    const wal = value(`${prefix}-materialization-durable-wal-high-water-n1`);
    const result: string[] = [];
    if (filesystem === undefined || filesystem <= 0) result.push(`${prefix} materialization filesystem high-water`);
    if (journal === undefined || wal === undefined || Math.max(journal, wal) <= 0) {
      result.push(`${prefix} materialization journal/WAL high-water`);
    }
    return result;
  });
  for (const prefix of ['cold', 'same-overlay-reference'] as const) {
    const database = value(`${prefix}-materialization-sidecar-database-high-water-n1`);
    const journal = value(`${prefix}-materialization-sidecar-journal-high-water-n1`);
    const wal = value(`${prefix}-materialization-sidecar-wal-high-water-n1`);
    if (database === undefined || database <= 0) missing.push(`${prefix} sorted-sidecar database high-water`);
    if (journal === undefined || journal <= 0) missing.push(`${prefix} sorted-sidecar journal high-water`);
    if (wal !== 0) missing.push(`${prefix} sorted-sidecar WAL exclusion`);
  }
  return missing;
}

function missingMaterializationQueryIndexRestorationEvidence(
  measurements: ReadonlyMap<string, BenchmarkArtifactV1['measurements'][number]>,
): readonly string[] {
  const missing = EffectArray.flatMap(['cold', 'same-overlay-reference'] as const, prefix => {
    const measurement = measurements.get(`${prefix}-materialization-stage-restoring-indexes-n1`);
    const duration = measurement === undefined ? undefined : exactSingleSampleCount(measurement);
    return duration !== undefined && duration > 0 ? [] : [`${prefix} full-build query-index restoration`];
  });
  const incremental = measurements.get('one-file-reindex-materialization-stage-restoring-indexes-n1');
  const incrementalDuration = incremental === undefined ? undefined : exactSingleSampleCount(incremental);
  if (incrementalDuration !== 0) missing.push('one-file reindex query-index restoration exclusion');
  return missing;
}

function missingMaterializationReplayEquations(
  measurements: ReadonlyMap<string, BenchmarkArtifactV1['measurements'][number]>,
): readonly string[] {
  return EffectArray.flatMap(['cold', 'same-overlay-reference'] as const, prefix => {
    const attributed = measurements.get(`${prefix}-materialization-attributed-files-n1`);
    const cachedTotal = measurements.get(`${prefix}-materialization-cached-fact-bytes-total-n1`);
    const cached = measurements.get(`${prefix}-materialization-cached-fact-replay-bytes-n1`);
    const deferredFiles = measurements.get(`${prefix}-materialization-materialized-shard-cache-deferred-files-n1`);
    const deferredRawBytes = measurements.get(
      `${prefix}-materialization-materialized-shard-cache-deferred-raw-fact-bytes-n1`,
    );
    const materialized = measurements.get(`${prefix}-materialization-materialized-shard-replay-bytes-n1`);
    const raw = measurements.get(`${prefix}-materialization-raw-fact-replay-bytes-n1`);
    if (!attributed || !cachedTotal || !cached || !deferredFiles || !deferredRawBytes || !materialized || !raw) {
      return [];
    }
    const attributedFiles = exactSingleSampleCount(attributed);
    const cachedFactBytesTotal = exactSingleSampleCount(cachedTotal);
    const cachedBytes = exactSingleSampleCount(cached);
    const deferredFileCount = exactSingleSampleCount(deferredFiles);
    const deferredBytes = exactSingleSampleCount(deferredRawBytes);
    const materializedBytes = exactSingleSampleCount(materialized);
    const rawBytes = exactSingleSampleCount(raw);
    const missing: string[] = [];
    if (
      cachedBytes === undefined ||
      materializedBytes === undefined ||
      rawBytes === undefined ||
      cachedBytes !== Math.min(Number.MAX_SAFE_INTEGER, materializedBytes + rawBytes)
    ) {
      missing.push(`${prefix} materialization replay-byte equation`);
    }
    const deferredWriteSubphases = EffectArray.map(['persistence', 'serialization'], subphase =>
      measurements.get(`${prefix}-materialization-subphase-shard-${subphase}-n1`),
    );
    if (
      cachedFactBytesTotal === undefined ||
      rawBytes === undefined ||
      deferredFileCount === undefined ||
      deferredBytes === undefined
    ) {
      missing.push(`${prefix} materialized-shard cache admission`);
    } else if (cachedFactBytesTotal > CODE_GRAPH_MATERIALIZED_SHARD_CACHE_WRITE_RAW_FACT_BYTES_MAXIMUM) {
      if (attributedFiles === undefined || deferredFileCount !== attributedFiles || deferredBytes !== rawBytes) {
        missing.push(`${prefix} large-build materialized-shard cache deferral`);
      }
      if (
        EffectArray.some(
          deferredWriteSubphases,
          measurement => measurement === undefined || exactSingleSampleCount(measurement) !== 0,
        )
      ) {
        missing.push(`${prefix} deferred materialized-shard physical-write exclusion`);
      }
    } else if (deferredFileCount !== 0 || deferredBytes !== 0) {
      missing.push(`${prefix} bounded-build materialized-shard cache persistence`);
    }
    return missing;
  });
}

function exactSingleSampleCount(measurement: BenchmarkArtifactV1['measurements'][number]): number | undefined {
  const values = [
    measurement.minimum,
    measurement.maximum,
    measurement.mean,
    measurement.p50,
    measurement.p95,
    measurement.p99,
  ];
  const value = values[0];
  return measurement.samples === 1 &&
    value !== undefined &&
    Number.isSafeInteger(value) &&
    EffectArray.every(values, candidate => candidate === value)
    ? value
    : undefined;
}

function missingProductionShapeTargetAttainment(
  measurements: ReadonlyMap<string, BenchmarkArtifactV1['measurements'][number]>,
  artifact: BenchmarkArtifactV1,
  releaseProfile?: 'full-release' | 'governed-reduced-release',
): readonly string[] {
  if (!isReviewedProductionProfile(artifact) && releaseProfile !== 'governed-reduced-release') return [];
  const requiredMeasurements = EffectArray.filter(
    PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS,
    (required: (typeof PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS)[number]): boolean =>
      Effect2.pipe(required.name, EffectString.startsWith('production-shape-')),
  );
  return EffectArray.flatMap(
    requiredMeasurements,
    (required: (typeof PRODUCTION_RELEASE_EVIDENCE_MEASUREMENTS)[number]) => {
      const measurement = measurements.get(required.name);
      if (!measurement || measurement.unit !== 'percent') return [];
      return measurement.minimum >= PRODUCTION_LARGE_TARGET_ATTAINMENT_MINIMUM_PERCENT
        ? []
        : [
            `${required.name} expected at least ` +
              `${PRODUCTION_LARGE_TARGET_ATTAINMENT_MINIMUM_PERCENT}% target attainment`,
          ];
    },
  );
}

function isReviewedProductionProfile(artifact: BenchmarkArtifactV1): boolean {
  const expected = productionProfileArtifactMetadata(PRODUCTION_LARGE_CODE_GRAPH_PROFILE);
  return EffectArray.every(EffectRecord.toEntries(expected), ([name, value]) => artifact.metadata[name] === value);
}

function missingReviewedProductionProfile(artifact: BenchmarkArtifactV1): readonly string[] {
  return isReviewedProductionProfile(artifact) ? [] : ['reviewed default production-large profile'];
}

function isGovernedReducedProductionProfile(artifact: BenchmarkArtifactV1): boolean {
  const expected = productionProfileArtifactMetadata(
    productionProfile({profile: 'production-large', profileFiles: 3_000, profileSymbols: 110_000}),
  );
  return EffectArray.every(EffectRecord.toEntries(expected), ([name, value]) => artifact.metadata[name] === value);
}

function missingGovernedReducedProductionProfile(artifact: BenchmarkArtifactV1): readonly string[] {
  const metadata = artifact.metadata;
  return isGovernedReducedProductionProfile(artifact) &&
    artifact.suite === 'code-graph-production-large-v2' &&
    metadata.vectorEnabled === false &&
    metadata.benchmarkGoverned === true &&
    typeof metadata.benchmarkMinimumFreeBytes === 'number' &&
    metadata.benchmarkMinimumFreeBytes >= PRODUCTION_RATCHET_REDUCED_MINIMUM_FREE_BYTES &&
    typeof metadata.benchmarkPrimaryAvailableBytesAtStart === 'number' &&
    metadata.benchmarkPrimaryAvailableBytesAtStart >= metadata.benchmarkMinimumFreeBytes &&
    typeof metadata.benchmarkReferenceAvailableBytesAtStart === 'number' &&
    metadata.benchmarkReferenceAvailableBytesAtStart >= metadata.benchmarkMinimumFreeBytes &&
    metadata.benchmarkSourceValidationMode === 'github-actions-clean-source' &&
    metadata.benchmarkGithubRunnerEnvironment === 'github-hosted' &&
    metadata.benchmarkGithubRunnerOperatingSystem === 'Linux' &&
    metadata.runtimePlatform === 'linux'
    ? []
    : ['governed hosted reduced production profile'];
}

export function assertExternalRepositoryEvidence(artifact: BenchmarkArtifactV1): void {
  validateExternalRepositoryEvidence(artifact, {
    managerEdgeBudget: MANAGER_GRAPH_MAX_EDGE_LIMIT,
    managerNodeBudget: MANAGER_GRAPH_MAX_NODE_LIMIT,
  });
}

export function assertExternalPerformanceEvidence(artifact: BenchmarkArtifactV1): void {
  validateExternalRepositoryEvidence(artifact, {
    expectedControlLanguages: PERFORMANCE_CONTROL_LANGUAGES,
    managerEdgeBudget: MANAGER_GRAPH_MAX_EDGE_LIMIT,
    managerNodeBudget: MANAGER_GRAPH_MAX_NODE_LIMIT,
    releaseBound: true,
  });
}

function missingDeterministicParityEvidence(
  measurements: ReadonlyMap<string, BenchmarkArtifactV1['measurements'][number]>,
): readonly string[] {
  return EffectArray.flatMap(
    [
      'cold-primary-query-returned-nodes',
      'one-file-reindex-primary-query-returned-nodes',
      'same-overlay-full-rebuild-primary-query-returned-nodes',
      'primary-query-structural-parity',
      'structural-graph-digest-parity',
    ],
    name => {
      const measurement = measurements.get(name);
      return measurement && measurement.minimum >= 1 ? [] : [`${name} positive result`];
    },
  );
}

function missingSamplerObservations(
  measurements: ReadonlyMap<string, BenchmarkArtifactV1['measurements'][number]>,
): readonly string[] {
  const requiredFailureMeasurements = new Set<string>();
  const missing = EffectArray.flatMap(['cold', 'one-file-reindex', 'same-overlay-reference'] as const, prefix => {
    const expectedPositive = [
      `${prefix}-external-storage-samples-n1`,
      `${prefix}-external-process-tree-samples-n1`,
      `${prefix}-external-process-tree-attempts-n1`,
      `${prefix}-external-process-count-peak-observed-n1`,
      `${prefix}-external-rss-peak-observed-n1`,
    ];
    const prefixMissing = EffectArray.flatMap(expectedPositive, name => {
      const measurement = measurements.get(name);
      return measurement && measurement.minimum >= 1 ? [] : [`${name} positive result`];
    });
    const samplerVersion = measurements.get(`${prefix}-external-sampler-version-n1`);
    if (!samplerVersion || samplerVersion.minimum < 4) {
      prefixMissing.push(`${prefix}-external-sampler-version-n1 expected sampler v4 or newer`);
    }
    const processTreeFailures = measurements.get(`${prefix}-external-process-tree-failures-n1`);
    requiredFailureMeasurements.add(`${prefix}-external-process-tree-failures-n1`);
    if (!processTreeFailures || processTreeFailures.maximum !== 0) {
      prefixMissing.push(`${prefix}-external-process-tree-failures-n1 expected zero inspection loss`);
    }
    if (!measurements.has(`${prefix}-external-process-tree-maximum-sample-gap-n1`)) {
      prefixMissing.push(`${prefix}-external-process-tree-maximum-sample-gap-n1 observed result`);
    }
    const openTemporaryFileAttempts = measurements.get(`${prefix}-external-open-temp-process-tree-attempts-n1`);
    if (!openTemporaryFileAttempts || openTemporaryFileAttempts.minimum < 1) {
      prefixMissing.push(`${prefix}-external-open-temp-process-tree-attempts-n1 positive result`);
    }
    const openTemporaryFileFailures = measurements.get(`${prefix}-external-open-temp-process-tree-failures-n1`);
    requiredFailureMeasurements.add(`${prefix}-external-open-temp-process-tree-failures-n1`);
    if (!openTemporaryFileFailures || openTemporaryFileFailures.maximum !== 0) {
      prefixMissing.push(`${prefix}-external-open-temp-process-tree-failures-n1 expected zero inspection loss`);
    }
    const openTemporaryFileSamples = measurements.get(`${prefix}-external-open-temp-process-tree-samples-n1`);
    if (!openTemporaryFileSamples || openTemporaryFileSamples.minimum < 1) {
      prefixMissing.push(`${prefix}-external-open-temp-process-tree-samples-n1 positive result`);
    }
    return prefixMissing;
  });
  for (const [name, measurement] of measurements) {
    if (
      (Effect2.pipe(name, EffectString.endsWith('-external-process-tree-failures-n1')) ||
        Effect2.pipe(name, EffectString.endsWith('-external-open-temp-process-tree-failures-n1'))) &&
      !requiredFailureMeasurements.has(name) &&
      measurement.maximum !== 0
    ) {
      missing.push(`${name} expected zero inspection loss`);
    }
  }
  return missing;
}

function missingReleaseSourceProvenance(artifact: BenchmarkArtifactV1): readonly string[] {
  const ref = artifact.metadata.releaseEvidenceRef;
  const resolvedSha = artifact.metadata.releaseEvidenceResolvedSha;
  const sha = artifact.metadata.releaseEvidenceSha;
  const sourceMode = artifact.metadata.releaseEvidenceSourceMode;
  const harnessCommit = artifact.metadata.releaseEvidenceHarnessCommit;
  let harnessDeltaPaths: readonly string[] = [];
  try {
    const parsed = JSON.parse(String(artifact.metadata.releaseEvidenceHarnessDeltaPaths ?? '[]'));
    if (EffectArray.isArray(parsed) && EffectArray.every(parsed, path => typeof path === 'string'))
      harnessDeltaPaths = parsed;
  } catch {
    // The shared missing-evidence result below reports malformed provenance.
  }
  const canonicalHarnessDelta =
    harnessDeltaPaths.length > 0 &&
    new Set(harnessDeltaPaths).size === harnessDeltaPaths.length &&
    EffectArray.every(harnessDeltaPaths, path =>
      (RELEASE_EVIDENCE_HARNESS_DELTA_PATHS as readonly string[]).includes(path),
    ) &&
    JSON.stringify([...harnessDeltaPaths].sort()) === JSON.stringify(harnessDeltaPaths);
  const sourceModeValid =
    (sourceMode === 'exact-release' &&
      harnessCommit === sha &&
      artifact.environment.commit === sha &&
      artifact.metadata.releaseEvidenceHarnessDeltaPaths === '[]') ||
    (sourceMode === 'release-plus-reviewed-harness-delta' &&
      harnessCommit === artifact.environment.commit &&
      harnessCommit !== sha &&
      canonicalHarnessDelta);
  return typeof ref === 'string' &&
    releaseEvidenceVersionForRef(ref) !== undefined &&
    typeof sha === 'string' &&
    EXACT_GIT_COMMIT_PATTERN.test(sha) &&
    resolvedSha === sha &&
    sourceModeValid &&
    !artifact.environment.dirty
    ? []
    : ['clean exact release source provenance'];
}

function missingBenchmarkRuntimeProvenance(artifact: BenchmarkArtifactV1): readonly string[] {
  const metadata = artifact.metadata;
  const mode = metadata.benchmarkSourceValidationMode;
  const sourceCommit = metadata.benchmarkMeasuredSourceCommit;
  const sourceLockfileSha256 = metadata.benchmarkMeasuredSourceLockfileSha256;
  const sourcePackageManifestSha256 = metadata.benchmarkMeasuredSourcePackageManifestSha256;
  if (
    metadata.benchmarkMeasuredExecutionMode !== 'local-source-application-layer' ||
    (mode !== 'managed-payload-exact-head-validated' && mode !== 'github-actions-clean-source') ||
    sourceCommit !== artifact.environment.commit ||
    typeof sourceCommit !== 'string' ||
    !EXACT_GIT_COMMIT_PATTERN.test(sourceCommit) ||
    typeof sourceLockfileSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sourceLockfileSha256) ||
    typeof sourcePackageManifestSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sourcePackageManifestSha256) ||
    artifact.environment.dirty
  ) {
    return ['clean exact local-source ApplicationLayer benchmark provenance'];
  }
  if (mode === 'github-actions-clean-source') {
    return metadata.benchmarkValidatedManagedPayload === 'not-applicable-github-actions-clean-source' &&
      (metadata.benchmarkGithubRunnerEnvironment === 'github-hosted' ||
        metadata.benchmarkGithubRunnerEnvironment === 'self-hosted') &&
      (metadata.benchmarkGithubRunnerArchitecture === 'ARM64' ||
        metadata.benchmarkGithubRunnerArchitecture === 'X64') &&
      (metadata.benchmarkGithubRunnerOperatingSystem === 'Linux' ||
        metadata.benchmarkGithubRunnerOperatingSystem === 'macOS' ||
        metadata.benchmarkGithubRunnerOperatingSystem === 'Windows')
      ? []
      : ['GitHub Actions source-only validation and runner disclosure'];
  }
  const managedVersion = metadata.benchmarkValidatedManagedVersion;
  return metadata.benchmarkValidatedManagedPayload === 'exact-head-not-executed' &&
    metadata.benchmarkValidatedManagedProcessLeaseInspection === 'complete' &&
    metadata.benchmarkValidatedManagedDependencyInstallation === 'bun install --frozen-lockfile' &&
    typeof managedVersion === 'string' &&
    (Effect2.pipe(managedVersion, EffectString.endsWith(`-local.g${sourceCommit}`)) ||
      Effect2.pipe(managedVersion, EffectString.endsWith(`.local.g${sourceCommit}`))) &&
    typeof metadata.benchmarkValidatedManagedPayloadFileCount === 'number' &&
    metadata.benchmarkValidatedManagedPayloadFileCount > 0 &&
    typeof metadata.benchmarkValidatedManagedPayloadBytes === 'number' &&
    metadata.benchmarkValidatedManagedPayloadBytes > 0 &&
    EffectArray.every(
      [
        metadata.benchmarkValidatedManagedExecutableSha256,
        metadata.benchmarkValidatedManagedPayloadManifestSha256,
        metadata.benchmarkValidatedManagedReleaseMetadataSha256,
      ],
      value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    ) &&
    typeof metadata.benchmarkValidatedManagedRuntime === 'string' &&
    metadata.benchmarkValidatedManagedRuntime.length > 0 &&
    typeof metadata.benchmarkValidatedManagedTarget === 'string' &&
    metadata.benchmarkValidatedManagedTarget.length > 0
    ? []
    : ['complete separately validated managed exact-HEAD payload provenance'];
}

function missingActivationObservations(
  artifact: BenchmarkArtifactV1,
  measurements: ReadonlyMap<string, BenchmarkArtifactV1['measurements'][number]>,
): readonly string[] {
  const missing = EffectArray.flatMap(['cold', 'one-file-reindex'] as const, prefix => {
    const storageMode =
      prefix === 'cold'
        ? artifact.metadata.coldMaterializationStorageMode
        : artifact.metadata.oneFileReindexMaterializationStorageMode;
    const expectedStages =
      storageMode === 'direct-persistent'
        ? DIRECT_PERSISTENT_ACTIVATION_STAGES
        : prefix === 'cold'
          ? ACTIVATION_STAGES
          : storageMode === 'temporary-staged'
            ? INCREMENTAL_STAGED_ACTIVATION_STAGES
            : DIRECT_PERSISTENT_ACTIVATION_STAGES;
    const name = `${prefix}-activation-observed-stages-n1`;
    const measurement = measurements.get(name);
    const missing =
      measurement && measurement.minimum >= expectedStages.length
        ? []
        : [`${name} expected at least ${expectedStages.length} real stages`];
    for (const stage of expectedStages) {
      const observedName = `${prefix}-activation-${stage}-observed-n1`;
      const observed = measurements.get(observedName);
      if (!observed || observed.minimum < 1) missing.push(`${observedName} positive result`);
    }
    return missing;
  });
  if (artifact.metadata.coldMaterializationStorageMode === 'direct-persistent') {
    const durableHighWater = measurements.get('cold-sqlite-durable-database-pages-high-water-n1');
    if (!durableHighWater || durableHighWater.minimum < 1) {
      missing.push('cold-sqlite-durable-database-pages-high-water-n1 positive result');
    }
    for (const stage of ACTIVATION_COPY_STAGES) {
      const observedName = `cold-activation-${stage}-observed-n1`;
      const observed = measurements.get(observedName);
      if (!observed || observed.maximum !== 0) {
        missing.push(`${observedName} expected zero direct-persistent activation copies`);
      }
    }
  }
  return missing;
}

const threadnoteSourceGit = Effect.fn('benchmarkCodeGraph.threadnoteSourceGit')(
  (sourceRoot: string, args: readonly string[]) =>
    repositoryGit(sourceRoot, args).pipe(Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim))),
);

function githubRunnerArchitecture(architecture: string): 'ARM64' | 'X64' | undefined {
  if (architecture === 'arm64') return 'ARM64';
  if (architecture === 'x64') return 'X64';
  return undefined;
}

function githubRunnerOperatingSystem(platform: string): 'Linux' | 'macOS' | 'Windows' | undefined {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  if (platform === 'win32') return 'Windows';
  return undefined;
}

export const validateBenchmarkRuntimeProvenance = Effect.fn('benchmarkCodeGraph.validateRuntimeProvenance')(function* (
  sourceRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const [sourceCommit, dirty] = yield* Effect.all(
    [
      threadnoteSourceGit(sourceRoot, ['rev-parse', 'HEAD']),
      threadnoteSourceGit(sourceRoot, CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS),
    ],
    {concurrency: 2},
  );
  if (!EXACT_GIT_COMMIT_PATTERN.test(sourceCommit) || dirty.length > 0) {
    return yield* ScriptError.make({
      message: 'Long code-graph benchmarks require a clean Threadnote checkout at an exact Git commit.',
    });
  }
  const environment = system.environment();
  if (environment.GITHUB_ACTIONS === 'true') {
    const githubWorkspace = Effect2.pipe(environment.GITHUB_WORKSPACE, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    );
    const githubSha = Effect2.pipe(environment.GITHUB_SHA, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    );
    const githubRunId = Effect2.pipe(environment.GITHUB_RUN_ID, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    );
    const githubRepository = Effect2.pipe(environment.GITHUB_REPOSITORY, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    );
    const runnerArchitecture = Effect2.pipe(environment.RUNNER_ARCH, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    );
    const runnerEnvironment = Effect2.pipe(environment.RUNNER_ENVIRONMENT, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    );
    const runnerOperatingSystem = Effect2.pipe(environment.RUNNER_OS, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    );
    const expectedRunnerArchitecture = githubRunnerArchitecture(system.architecture);
    const expectedRunnerOperatingSystem = githubRunnerOperatingSystem(system.platform);
    if (
      environment.CI !== 'true' ||
      githubSha !== sourceCommit ||
      !EXACT_GIT_COMMIT_PATTERN.test(githubSha ?? '') ||
      !githubWorkspace ||
      !/^\d+$/.test(githubRunId ?? '') ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository ?? '') ||
      (runnerEnvironment !== 'github-hosted' && runnerEnvironment !== 'self-hosted') ||
      expectedRunnerArchitecture === undefined ||
      runnerArchitecture !== expectedRunnerArchitecture ||
      expectedRunnerOperatingSystem === undefined ||
      runnerOperatingSystem !== expectedRunnerOperatingSystem
    ) {
      return yield* ScriptError.make({
        message: 'GitHub Actions benchmark provenance is incomplete or does not match the checkout commit.',
      });
    }
    const [realSourceRoot, realGithubWorkspace, sourceLockfileSha256, sourcePackageManifestSha256] = yield* Effect.all(
      [
        fs.realPath(sourceRoot),
        fs.realPath(githubWorkspace),
        sha256FileHex(path.join(sourceRoot, 'bun.lock')),
        sha256FileHex(path.join(sourceRoot, 'package.json')),
      ],
      {concurrency: 4},
    );
    const normalize = (value: string) =>
      system.platform === 'win32'
        ? Effect2.pipe(path.resolve(value), EffectString.toLocaleLowerCase('en-US'))
        : path.resolve(value);
    if (normalize(realSourceRoot) !== normalize(realGithubWorkspace)) {
      return yield* ScriptError.make({message: 'GitHub Actions benchmark provenance is not bound to this workspace.'});
    }
    yield* verifyBenchmarkSourceUnchanged(sourceRoot, sourceCommit);
    return {
      mode: 'github-actions-clean-source',
      runnerArchitecture,
      runnerEnvironment,
      runnerOperatingSystem,
      sourceCommit,
      sourceLockfileSha256,
      sourcePackageManifestSha256,
    } satisfies BenchmarkRuntimeProvenance;
  }
  const managed = yield* verifyManagedDevelopmentRuntimeForSourceCheckout(sourceRoot, sourceCommit);
  yield* verifyBenchmarkSourceUnchanged(sourceRoot, sourceCommit);
  return {
    ...managed,
    mode: 'managed-exact-head',
    processLeaseInspection: 'complete',
  } satisfies BenchmarkRuntimeProvenance;
});

export const revalidateExternalBenchmarkPreflightState = Effect.fn(
  'benchmarkCodeGraph.revalidateExternalPreflightState',
)(function* (
  sourceRoot: string,
  externalRepository: string,
  expectedExternalCommit: string | undefined,
  expectedRuntimeProvenance: BenchmarkRuntimeProvenance | undefined,
) {
  if (!expectedExternalCommit || !expectedRuntimeProvenance) {
    return yield* ScriptError.make({message: 'External benchmark preflight has incomplete provenance.'});
  }
  const runtimeProvenance = yield* validateBenchmarkRuntimeProvenance(sourceRoot);
  if (JSON.stringify(runtimeProvenance) !== JSON.stringify(expectedRuntimeProvenance)) {
    return yield* ScriptError.make({message: 'Threadnote benchmark runtime provenance changed during preflight.'});
  }
  yield* verifyExternalRepositoryUnchanged(externalRepository, expectedExternalCommit);
  // Keep the source checkout check last so no artifact is emitted after a
  // repository-only validation whose source evidence has already drifted.
  yield* verifyBenchmarkSourceUnchanged(sourceRoot, expectedRuntimeProvenance.sourceCommit);
  return runtimeProvenance;
});

function benchmarkRuntimeProvenanceMetadata(
  provenance: BenchmarkRuntimeProvenance,
): Readonly<Record<string, boolean | number | string>> {
  const common = {
    benchmarkMeasuredExecutionMode: 'local-source-application-layer',
    benchmarkMeasuredSourceCommit: provenance.sourceCommit,
    benchmarkMeasuredSourceLockfileSha256: provenance.sourceLockfileSha256,
    benchmarkMeasuredSourcePackageManifestSha256: provenance.sourcePackageManifestSha256,
    benchmarkSourceValidationMode:
      provenance.mode === 'managed-exact-head' ? 'managed-payload-exact-head-validated' : provenance.mode,
  } as const;
  return provenance.mode === 'github-actions-clean-source'
    ? {
        ...common,
        benchmarkGithubRunnerArchitecture: provenance.runnerArchitecture,
        benchmarkGithubRunnerEnvironment: provenance.runnerEnvironment,
        benchmarkGithubRunnerOperatingSystem: provenance.runnerOperatingSystem,
        benchmarkValidatedManagedPayload: 'not-applicable-github-actions-clean-source',
      }
    : {
        ...common,
        benchmarkValidatedManagedDependencyInstallation: provenance.dependencyInstallation,
        benchmarkValidatedManagedExecutableSha256: provenance.executableSha256,
        benchmarkValidatedManagedPayload: 'exact-head-not-executed',
        benchmarkValidatedManagedPayloadBytes: provenance.payloadBytes,
        benchmarkValidatedManagedPayloadFileCount: provenance.payloadFileCount,
        benchmarkValidatedManagedPayloadManifestSha256: provenance.payloadManifestSha256,
        benchmarkValidatedManagedProcessLeaseInspection: provenance.processLeaseInspection,
        benchmarkValidatedManagedReleaseMetadataSha256: provenance.releaseMetadataSha256,
        benchmarkValidatedManagedRuntime: provenance.runtime,
        benchmarkValidatedManagedTarget: provenance.target,
        benchmarkValidatedManagedVersion: provenance.version,
      };
}

export function resolvedReleaseEvidenceSource(
  ref: string,
  sha: string,
  resolvedSha: string,
  checkoutCommit: string,
  dirty: boolean,
  harnessDeltaPaths: readonly string[] = [],
  releaseIsAncestor = checkoutCommit === sha,
): {
  readonly ref: string;
  readonly resolvedSha: string;
  readonly sha: string;
  readonly harnessCommit: string;
  readonly harnessDeltaPaths: string;
  readonly sourceMode: 'exact-release' | 'release-plus-reviewed-harness-delta';
} {
  const normalizedDeltaPaths = [...harnessDeltaPaths].sort();
  const reviewedDelta =
    checkoutCommit !== sha &&
    releaseIsAncestor &&
    normalizedDeltaPaths.length > 0 &&
    new Set(normalizedDeltaPaths).size === normalizedDeltaPaths.length &&
    EffectArray.every(normalizedDeltaPaths, path =>
      (RELEASE_EVIDENCE_HARNESS_DELTA_PATHS as readonly string[]).includes(path),
    );
  if (
    releaseEvidenceVersionForRef(ref) === undefined ||
    !EXACT_GIT_COMMIT_PATTERN.test(sha) ||
    resolvedSha !== sha ||
    (!reviewedDelta && (checkoutCommit !== sha || harnessDeltaPaths.length > 0)) ||
    dirty
  ) {
    throw ScriptError.make({
      message:
        'Release benchmark provenance requires a locally resolvable tag and either its clean exact commit or a clean descendant with only reviewed harness changes.',
    });
  }
  return {
    ref,
    resolvedSha,
    sha,
    harnessCommit: checkoutCommit,
    harnessDeltaPaths: JSON.stringify(normalizedDeltaPaths),
    sourceMode: reviewedDelta ? 'release-plus-reviewed-harness-delta' : 'exact-release',
  };
}

export const releaseEvidenceSourcePathspecs = [
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

const validateReleaseEvidenceSource = Effect.fn('benchmarkCodeGraph.validateReleaseEvidenceSource')(function* (
  sourceRoot: string,
  ref: string | undefined,
  sha: string | undefined,
) {
  if (ref === undefined && sha === undefined) return undefined;
  if (
    ref === undefined ||
    sha === undefined ||
    releaseEvidenceVersionForRef(ref) === undefined ||
    !EXACT_GIT_COMMIT_PATTERN.test(sha)
  ) {
    return yield* ScriptError.make({
      message:
        'Release benchmark provenance requires a canonical Threadnote 4-or-newer release tag and its exact commit SHA.',
    });
  }
  const [commit, dirty, resolvedSha] = yield* Effect.all(
    [
      threadnoteSourceGit(sourceRoot, ['rev-parse', 'HEAD']),
      threadnoteSourceGit(sourceRoot, CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS),
      threadnoteSourceGit(sourceRoot, ['rev-parse', '--verify', `${ref}^{commit}`]),
    ],
    {concurrency: 3},
  );
  const [releaseMergeBase, harnessDeltaOutput] =
    commit === sha
      ? [sha, '']
      : yield* Effect.all(
          [
            threadnoteSourceGit(sourceRoot, ['merge-base', sha, commit]),
            threadnoteSourceGit(sourceRoot, [
              'diff',
              '--name-only',
              '--diff-filter=ACDMRTUXB',
              `${sha}..${commit}`,
              '--',
              ...releaseEvidenceSourcePathspecs,
            ]),
          ],
          {concurrency: 2},
        );
  const harnessDeltaPaths = EffectArray.filter(Effect2.pipe(harnessDeltaOutput, EffectString.split('\n')), Boolean);
  return yield* Effect.try(() =>
    resolvedReleaseEvidenceSource(
      ref,
      sha,
      resolvedSha,
      commit,
      dirty.length > 0,
      harnessDeltaPaths,
      releaseMergeBase === sha,
    ),
  );
});

export interface CodeGraphBenchmarkOptions {
  readonly embeddingContexts?: EmbeddingContextPoolSize;
  readonly externalControls: readonly ExternalRepositoryQueryControl[];
  readonly fixture: string;
  readonly homePath?: string;
  readonly incrementalPath?: string;
  readonly materializationTransactionBatchLimit?: 1 | 4;
  readonly minimumFreeGiB: number;
  readonly modelHome?: string;
  readonly outputPath?: string;
  readonly preflight: boolean;
  readonly profile?: 'production-large';
  readonly profileFiles?: number;
  readonly profileSymbols?: number;
  readonly queryText?: string;
  readonly quiet: boolean;
  readonly ratchetPath?: string;
  readonly referenceHomePath?: string;
  readonly repository?: string;
  readonly retainHomes: boolean;
  readonly rssPeakDiagnostics?: true;
  readonly samples: number;
  readonly scaleSymbols?: number;
  readonly sqliteWriterProfile?: CodeGraphSqliteWriterProfile;
  readonly warmups: number;
  readonly failOnBudget: boolean;
  readonly vectors: boolean;
}

export function parseCodeGraphBenchmarkArguments(args: readonly string[]): CodeGraphBenchmarkOptions {
  const structuredControls: ExternalRepositoryQueryControl[] = [];
  let expectedLanguage: string | undefined;
  let expectedPath: string | undefined;
  let embeddingContexts: EmbeddingContextPoolSize | undefined;
  let fixture = 'code-graph-v1';
  let homePath: string | undefined;
  let incrementalPath: string | undefined;
  let materializationTransactionBatchLimit: 1 | 4 | undefined;
  let minimumFreeGiB = 120;
  let modelHome: string | undefined;
  let outputPath: string | undefined;
  let preflight = false;
  let profile: 'production-large' | undefined;
  let profileFiles: number | undefined;
  let profileSymbols: number | undefined;
  let queryText: string | undefined;
  let quiet = false;
  let ratchetPath: string | undefined;
  let referenceHomePath: string | undefined;
  let repository: string | undefined;
  let retainHomes = false;
  let rssPeakDiagnostics = false;
  let samples = 25;
  let scaleSymbols: number | undefined;
  let sqliteWriterProfile: CodeGraphSqliteWriterProfile | undefined;
  let warmups = 5;
  let failOnBudget = false;
  let vectors = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--embedding-contexts') {
      const value = integer(args[++index], argument, 1);
      if (value !== 1 && value !== 2 && value !== 4 && value !== 8) {
        throw ScriptError.make({message: `${argument} must be 1, 2, 4, or 8.`});
      }
      embeddingContexts = value;
    } else if (argument === '--control') {
      structuredControls.push(parseExternalRepositoryQueryControl(required(args[++index], argument)));
    } else if (argument === '--expected-language') expectedLanguage = required(args[++index], argument);
    else if (argument === '--expected-path') expectedPath = required(args[++index], argument);
    else if (argument === '--fixture') fixture = required(args[++index], argument);
    else if (argument === '--home') homePath = required(args[++index], argument);
    else if (argument === '--incremental-path') incrementalPath = required(args[++index], argument);
    else if (argument === '--materialization-transaction-batches') {
      const value = integer(args[++index], argument, 1);
      if (value !== 1 && value !== 4) throw ScriptError.make({message: `${argument} must be 1 or 4.`});
      materializationTransactionBatchLimit = value;
    } else if (argument === '--minimum-free-gib') minimumFreeGiB = integer(args[++index], argument, 1);
    else if (argument === '--model-home') modelHome = required(args[++index], argument);
    else if (argument === '--query') queryText = required(args[++index], argument);
    else if (argument === '--reference-home') referenceHomePath = required(args[++index], argument);
    else if (argument === '--repository') repository = required(args[++index], argument);
    else if (argument === '--profile') {
      const value = required(args[++index], argument);
      if (value !== 'production-large')
        throw ScriptError.make({message: `Unknown code graph benchmark profile: ${value}`});
      profile = value;
    } else if (argument === '--profile-files') profileFiles = integer(args[++index], argument, 2);
    else if (argument === '--profile-symbols') profileSymbols = integer(args[++index], argument, 2);
    else if (argument === '--quiet') quiet = true;
    else if (argument === '--rss-peak-diagnostics') rssPeakDiagnostics = true;
    else if (argument === '--samples') samples = integer(args[++index], argument, 1);
    else if (argument === '--scale-symbols') scaleSymbols = integer(args[++index], argument, 1);
    else if (argument === '--sqlite-writer-profile') {
      const value = required(args[++index], argument);
      if (!isCodeGraphSqliteWriterProfile(value)) {
        throw ScriptError.make({message: `Unknown SQLite writer benchmark profile: ${value}`});
      }
      sqliteWriterProfile = value;
    } else if (argument === '--warmups') warmups = integer(args[++index], argument, 0);
    else if (argument === '--fail-on-budget') failOnBudget = true;
    else if (argument === '--ratchet') ratchetPath = required(args[++index], argument);
    else if (argument === '--preflight') preflight = true;
    else if (argument === '--retain-homes') retainHomes = true;
    else if (argument === '--vectors') vectors = true;
    else throw ScriptError.make({message: `Unknown code graph benchmark option: ${argument}`});
  }
  if (!/^code-graph-[a-z0-9-]+$/.test(fixture))
    throw ScriptError.make({message: `Invalid code graph fixture name: ${fixture}.`});
  if (vectors && fixture !== 'code-graph-v1') {
    throw ScriptError.make({message: 'The vector semantic control is currently defined only for code-graph-v1.'});
  }
  if (profile && scaleSymbols !== undefined) {
    throw ScriptError.make({
      message: '--profile and --scale-symbols are separate fixture modes and cannot be combined.',
    });
  }
  if ((profileFiles !== undefined || profileSymbols !== undefined) && profile !== 'production-large') {
    throw ScriptError.make({message: '--profile-files and --profile-symbols require --profile production-large.'});
  }
  const requiredProfileFreeGiB =
    !vectors && reducedProductionRatchetProfile(profileFiles, profileSymbols)
      ? PRODUCTION_RATCHET_REDUCED_MINIMUM_FREE_GIB
      : 120;
  if (profile === 'production-large' && minimumFreeGiB < requiredProfileFreeGiB) {
    throw ScriptError.make({
      message: `The selected production-large profile requires --minimum-free-gib of at least ${requiredProfileFreeGiB}.`,
    });
  }
  if (profile === 'production-large' && fixture !== 'code-graph-v1') {
    throw ScriptError.make({message: 'The production-large profile uses the code-graph-v1 query contract.'});
  }
  if (profile === 'production-large' && failOnBudget) {
    throw ScriptError.make({
      message: 'The opt-in production-large profile has no portable latency budget; retain and review its artifact.',
    });
  }
  if (sqliteWriterProfile !== undefined && sqliteWriterProfile !== 'current' && failOnBudget) {
    throw ScriptError.make({
      message: 'SQLite writer candidate runs retain comparison evidence and cannot use production budgets.',
    });
  }
  if (
    embeddingContexts !== undefined &&
    (!vectors || scaleSymbols !== 10_000 || profile !== undefined || repository !== undefined)
  ) {
    throw ScriptError.make({message: '--embedding-contexts requires --vectors --scale-symbols 10000.'});
  }
  if (embeddingContexts !== undefined && failOnBudget) {
    throw ScriptError.make({
      message: 'Embedding-context candidates retain comparison evidence and cannot use production budgets.',
    });
  }
  if (preflight && ratchetPath !== undefined) {
    throw ScriptError.make({
      message: '--ratchet evaluates a completed artifact and cannot be combined with --preflight.',
    });
  }
  if (ratchetPath !== undefined && outputPath === undefined) {
    throw ScriptError.make({message: '--ratchet requires --output so failed evidence remains reviewable.'});
  }
  const legacyControlValues = EffectArray.filter(
    [queryText, expectedPath, expectedLanguage],
    value => value !== undefined,
  ).length;
  if (structuredControls.length > 0 && legacyControlValues > 0) {
    throw ScriptError.make({
      message: '--control cannot be combined with legacy --query, --expected-path, or --expected-language flags.',
    });
  }
  if (legacyControlValues > 0 && legacyControlValues < 3) {
    throw ScriptError.make({
      message: 'Legacy external control flags require --query, --expected-path, and --expected-language together.',
    });
  }
  const externalControls =
    structuredControls.length > 0
      ? structuredControls
      : queryText && expectedPath && expectedLanguage
        ? [{expectedLanguage, expectedPath, query: queryText}]
        : [];
  if (
    new Set(EffectArray.map(externalControls, control => control.expectedLanguage)).size !== externalControls.length
  ) {
    throw ScriptError.make({message: 'External query controls must use unique language categories.'});
  }
  if (repository !== undefined) {
    if (profile !== undefined || scaleSymbols !== undefined || vectors) {
      throw ScriptError.make({
        message: '--repository cannot be combined with generated profiles, scale fixtures, or vectors.',
      });
    }
    if (!incrementalPath || externalControls.length === 0 || !outputPath) {
      throw ScriptError.make({
        message: '--repository requires --incremental-path, at least one --control, and --output.',
      });
    }
    if (failOnBudget) {
      throw ScriptError.make({
        message: 'External repositories retain same-runner evidence and do not use portable latency budgets.',
      });
    }
    if ((homePath === undefined) !== (referenceHomePath === undefined)) {
      throw ScriptError.make({message: '--home and --reference-home must be provided together.'});
    }
    if (retainHomes && (homePath === undefined || referenceHomePath === undefined)) {
      throw ScriptError.make({message: '--retain-homes requires explicit --home and --reference-home paths.'});
    }
  } else if (
    incrementalPath !== undefined ||
    externalControls.length > 0 ||
    homePath !== undefined ||
    referenceHomePath !== undefined ||
    retainHomes ||
    preflight
  ) {
    throw ScriptError.make({
      message:
        '--incremental-path, external controls, benchmark homes, --retain-homes, and --preflight require --repository.',
    });
  }
  return {
    embeddingContexts,
    externalControls,
    failOnBudget,
    fixture,
    homePath,
    incrementalPath,
    materializationTransactionBatchLimit,
    minimumFreeGiB,
    modelHome,
    outputPath,
    preflight,
    profile,
    profileFiles,
    profileSymbols,
    queryText: externalControls[0]?.query,
    quiet,
    ratchetPath,
    referenceHomePath,
    repository,
    retainHomes,
    ...(rssPeakDiagnostics ? {rssPeakDiagnostics: true as const} : {}),
    samples,
    scaleSymbols,
    sqliteWriterProfile,
    vectors,
    warmups,
  };
}

const parseArguments = parseCodeGraphBenchmarkArguments;

function parseExternalRepositoryQueryControl(value: string): ExternalRepositoryQueryControl {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw ScriptError.make({
      message: '--control must be a JSON object with query, expectedPath, and expectedLanguage strings.',
    });
  }
  if (typeof parsed !== 'object' || parsed === null || EffectArray.isArray(parsed)) {
    throw ScriptError.make({
      message: '--control must be a JSON object with query, expectedPath, and expectedLanguage strings.',
    });
  }
  const candidate = parsed as Partial<Record<keyof ExternalRepositoryQueryControl, unknown>>;
  const query = typeof candidate.query === 'string' ? Effect2.pipe(candidate.query, EffectString.trim) : '';
  const expectedPath =
    typeof candidate.expectedPath === 'string' ? Effect2.pipe(candidate.expectedPath, EffectString.trim) : '';
  const expectedLanguage =
    typeof candidate.expectedLanguage === 'string' ? Effect2.pipe(candidate.expectedLanguage, EffectString.trim) : '';
  if (!query || !expectedPath || !/^[a-z][a-z0-9-]*$/.test(expectedLanguage)) {
    throw ScriptError.make({
      message:
        '--control requires non-empty query and expectedPath strings plus a lowercase expectedLanguage category.',
    });
  }
  return {expectedLanguage, expectedPath, query};
}

const prepareExternalCodeGraphFixture = Effect.fn('benchmarkCodeGraph.prepareExternalRepository')(function* (
  options: CodeGraphBenchmarkOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!options.repository || !options.incrementalPath || options.externalControls.length === 0 || !options.outputPath) {
    return yield* ScriptError.make({message: 'External repository benchmark options are incomplete.'});
  }
  const requestedRoot = path.resolve(options.repository);
  const repository = yield* fs.realPath(
    path.resolve(
      Effect2.pipe((yield* repositoryGit(requestedRoot, ['rev-parse', '--show-toplevel'])).stdout, EffectString.trim),
    ),
  );
  const [externalCommit, dirty, origin] = yield* Effect.all(
    [
      repositoryGit(repository, ['rev-parse', 'HEAD']).pipe(
        Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim)),
      ),
      repositoryGit(repository, CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS).pipe(
        Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim)),
      ),
      repositoryGit(repository, ['remote', 'get-url', 'origin']).pipe(
        Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim)),
      ),
    ],
    {concurrency: 3},
  );
  if (!EXACT_GIT_COMMIT_PATTERN.test(externalCommit)) {
    return yield* ScriptError.make({message: 'External repository did not resolve to an exact Git commit.'});
  }
  if (dirty.length > 0) {
    return yield* ScriptError.make({message: 'External repository benchmark requires a clean checkout.'});
  }
  const publicRepository = publicGitHubRepositoryEvidence(origin);
  const publicRepositoryVerification = yield* verifyPublicRepositoryCommit(
    publicRepository,
    externalCommit,
    process.env,
  );

  const artifactPath = yield* canonicalizeProspectivePath(fs, path, options.outputPath);
  const artifactContainment = path.relative(repository, artifactPath);
  if (
    artifactContainment === '' ||
    (!path.isAbsolute(artifactContainment) &&
      artifactContainment !== '..' &&
      !Effect2.pipe(artifactContainment, EffectString.startsWith(`..${path.sep}`)))
  ) {
    return yield* ScriptError.make({
      message: '--output must be outside the external repository so benchmark evidence cannot modify the checkout.',
    });
  }

  const [incrementalPath, externalControls] = yield* Effect.all(
    [
      validateExternalTrackedRegularPath(fs, path, repository, options.incrementalPath, '--incremental-path'),
      Effect.forEach(
        options.externalControls,
        control =>
          validateExternalTrackedRegularPath(fs, path, repository, control.expectedPath, '--control expectedPath').pipe(
            Effect.map(expectedPath => ({
              ...control,
              expectedPath: privacySafeExternalControlPath(expectedPath),
              query: privacySafeExternalControlQuery(control.query),
            })),
          ),
        {concurrency: 4},
      ),
    ],
    {concurrency: 2},
  );

  // Reserve sequentially. Besides making error cleanup deterministic, this
  // catches case aliases on case-insensitive filesystems after the first path
  // has a canonical identity.
  const homeReservation = yield* acquireFreshBenchmarkHome(
    fs,
    path,
    options.homePath,
    'threadnote-code-graph-external-benchmark-',
    repository,
  );
  const referenceHomeReservation = yield* acquireFreshBenchmarkHome(
    fs,
    path,
    options.referenceHomePath,
    'threadnote-code-graph-same-overlay-reference-',
    repository,
  );
  const home = homeReservation.home;
  const referenceHome = referenceHomeReservation.home;
  if (home === referenceHome) {
    return yield* ScriptError.make({message: 'Primary and same-overlay reference benchmark homes must be different.'});
  }
  for (const benchmarkHome of [home, referenceHome]) {
    const containment = path.relative(repository, benchmarkHome);
    if (
      containment === '' ||
      (!path.isAbsolute(containment) &&
        containment !== '..' &&
        !Effect2.pipe(containment, EffectString.startsWith(`..${path.sep}`)))
    ) {
      return yield* ScriptError.make({message: 'Benchmark homes must be outside the external repository.'});
    }
  }
  return {
    externalCommit,
    externalControls,
    fixtureIdentity: `external-code-graph-v1:${externalCommit}`,
    home,
    incrementalSourcePath: incrementalPath,
    preserveHomes: Effect.sync(() => {
      homeReservation.preserve();
      referenceHomeReservation.preserve();
    }),
    publicRepository,
    publicRepositoryVerification,
    queryText: externalControls[0].query,
    referenceHome,
    repository,
  } satisfies PreparedCodeGraphBenchmarkFixture;
});

export function publicGitHubRepositoryEvidence(remote: string): PublicGitHubRepositoryEvidence {
  const trimmed = Effect2.pipe(remote, EffectString.trim);
  const scp = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(trimmed);
  const [owner, repository] = scp
    ? ([scp[1], scp[2]] as const)
    : (() => {
        let parsed: URL;
        try {
          parsed = new URL(trimmed);
        } catch {
          throw ScriptError.make({message: 'External benchmark origin must be a public GitHub repository URL.'});
        }
        const allowedSshUser =
          parsed.protocol === 'ssh:' && (parsed.username.length === 0 || parsed.username === 'git');
        const credentialsAllowed = parsed.protocol === 'https:' ? parsed.username.length === 0 : allowedSshUser;
        if (
          Effect2.pipe(parsed.hostname, EffectString.toLowerCase) !== 'github.com' ||
          !credentialsAllowed ||
          parsed.password.length > 0 ||
          parsed.port.length > 0 ||
          parsed.search.length > 0 ||
          parsed.hash.length > 0 ||
          !['https:', 'ssh:'].includes(parsed.protocol)
        ) {
          throw ScriptError.make({message: 'External benchmark origin must be a public GitHub repository URL.'});
        }
        const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(parsed.pathname);
        if (!match)
          throw ScriptError.make({message: 'External benchmark origin must be a public GitHub repository URL.'});
        return [match[1], match[2]] as const;
      })();
  const name = `${owner}/${repository}`;
  return {name, url: `https://github.com/${name}`};
}

export {privacySafeExternalControlPath, privacySafeExternalControlQuery} from '@threadnote/evidence/public-controls';

export function credentialsDisabledGitProofEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  home: string,
  globalConfig: string,
): Record<string, string | undefined> {
  const sanitized = {...environment};
  for (const key of EffectRecord.keys(sanitized)) {
    if (
      Effect2.pipe(key, EffectString.toUpperCase, EffectString.startsWith('GIT_')) ||
      [
        'GCM_CREDENTIAL_STORE',
        'GCM_INTERACTIVE',
        'GCM_PROVIDER',
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'NETRC',
        'SSH_ASKPASS',
        'SSH_ASKPASS_REQUIRE',
      ].includes(Effect2.pipe(key, EffectString.toUpperCase))
    ) {
      delete sanitized[key];
    }
  }
  return {
    ...sanitized,
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    HOME: home,
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    XDG_CONFIG_HOME: home,
  };
}

const exactCommitProofRemote = Effect.fn('benchmarkCodeGraph.exactCommitProofRemote')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  repository: PublicGitHubRepositoryEvidence,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const testRemote = Effect2.pipe(environment[TEST_PUBLIC_REPOSITORY_REMOTE_ENV], effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  if (!testRemote) return repository.url;
  if (
    environment.NODE_ENV !== 'test' ||
    Effect2.pipe(environment.THREADNOTE_BENCHMARK_RELEASE_REF, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ) ||
    Effect2.pipe(environment.THREADNOTE_BENCHMARK_RELEASE_SHA, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  ) {
    return yield* ScriptError.make({
      message: 'The local public-repository proof seam is test-only and unavailable for release evidence.',
    });
  }
  if (!path.isAbsolute(testRemote)) {
    return yield* ScriptError.make({message: 'The local public-repository proof seam requires an absolute Git path.'});
  }
  const resolved = yield* fs.realPath(testRemote);
  const info = yield* fs.stat(resolved);
  if (info.type !== 'Directory') {
    return yield* ScriptError.make({message: 'The local public-repository proof seam requires a Git directory.'});
  }
  return resolved;
});

export const verifyAnonymousPublicGitHubRepository = Effect.fn(
  'benchmarkCodeGraph.verifyAnonymousPublicGitHubRepository',
)(function* (
  repository: PublicGitHubRepositoryEvidence,
  externalCommit: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (!EXACT_GIT_COMMIT_PATTERN.test(externalCommit)) {
    return yield* ScriptError.make({message: 'External repository proof requires an exact Git commit.'});
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-public-repository-proof-'});
  const home = path.join(root, 'home');
  const templates = path.join(root, 'templates');
  const proofRepository = path.join(root, 'proof.git');
  const emptyGitConfig = path.join(root, 'empty.gitconfig');
  yield* fs.makeDirectory(home, {mode: 0o700, recursive: true});
  yield* fs.makeDirectory(templates, {mode: 0o700, recursive: true});
  yield* fs.writeFileString(emptyGitConfig, '');
  const proofEnvironment = credentialsDisabledGitProofEnvironment(environment, home, emptyGitConfig);
  const commonArguments = [
    '-c',
    'credential.helper=',
    '-c',
    'core.askPass=',
    '-c',
    'http.extraHeader=',
    '-c',
    'protocol.version=2',
  ] as const;
  const remote = yield* exactCommitProofRemote(fs, path, repository, environment);
  const protocolAllowance = remote === repository.url ? 'protocol.file.allow=never' : 'protocol.file.allow=always';
  const runProofGit = (args: readonly string[]) =>
    runCommandEffect('git', [...commonArguments, '-c', protocolAllowance, ...args], {
      env: proofEnvironment,
      maxOutputBytes: 16 * 1_024,
      timeoutMs: PUBLIC_REPOSITORY_PROOF_TIMEOUT_MS,
    });
  yield* runProofGit(['init', '--quiet', '--bare', `--template=${templates}`, proofRepository]).pipe(
    Effect.andThen(
      runProofGit([
        `--git-dir=${proofRepository}`,
        'fetch',
        '--quiet',
        '--force',
        '--no-tags',
        '--depth=1',
        '--filter=tree:0',
        remote,
        externalCommit,
      ]),
    ),
    Effect.mapError(() =>
      ScriptError.make({
        message:
          'External benchmark commit could not be fetched from the public repository through credentials-disabled anonymous HTTPS.',
      }),
    ),
  );
  const resolved = yield* runProofGit([
    `--git-dir=${proofRepository}`,
    'rev-parse',
    '--verify',
    'FETCH_HEAD^{commit}',
  ]).pipe(
    Effect.mapBoth({
      onSuccess: result => Effect2.pipe(result.stdout, EffectString.trim),
      onFailure: () =>
        ScriptError.make({message: 'External benchmark public-repository proof did not resolve the fetched commit.'}),
    }),
  );
  if (resolved !== externalCommit) {
    return yield* ScriptError.make({
      message: 'External benchmark public-repository proof resolved a different commit.',
    });
  }
  return 'anonymous-https-exact-commit-fetch' as const;
});

export const verifyPublicRepositoryCommit = Effect.fn('benchmarkCodeGraph.verifyPublicRepositoryCommit')(function* (
  repository: PublicGitHubRepositoryEvidence,
  externalCommit: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return yield* verifyAnonymousPublicGitHubRepository(repository, externalCommit, environment);
});

const acquireFreshBenchmarkHome = Effect.fn('benchmarkCodeGraph.acquireFreshHome')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  requested: string | undefined,
  prefix: string,
  repository: string,
) {
  if (requested === undefined) {
    const home = yield* fs.makeTempDirectoryScoped({prefix});
    return {home, preserve: () => {}} as const;
  }
  const target = yield* canonicalizeProspectivePath(fs, path, requested);
  const containment = path.relative(repository, target);
  if (
    containment === '' ||
    (!path.isAbsolute(containment) &&
      containment !== '..' &&
      !Effect2.pipe(containment, EffectString.startsWith(`..${path.sep}`)))
  ) {
    return yield* ScriptError.make({message: 'Benchmark homes must be outside the external repository.'});
  }
  const parent = path.dirname(target);
  yield* fs.makeDirectory(parent, {mode: 0o700, recursive: true});
  const canonicalParent = yield* fs.realPath(parent);
  const exclusiveTarget = path.join(canonicalParent, path.basename(target));
  return yield* Effect.acquireRelease(
    fs.makeDirectory(exclusiveTarget, {mode: 0o700}).pipe(
      Effect.mapError(() =>
        ScriptError.make({message: 'Explicit benchmark home paths must be fresh and exclusively reservable.'}),
      ),
      Effect.andThen(
        fs.realPath(exclusiveTarget).pipe(
          Effect.flatMap(home => {
            const finalContainment = path.relative(repository, home);
            return finalContainment === '' ||
              (!path.isAbsolute(finalContainment) &&
                finalContainment !== '..' &&
                !Effect2.pipe(finalContainment, EffectString.startsWith(`..${path.sep}`)))
              ? Effect.fail(ScriptError.make({message: 'Benchmark homes must be outside the external repository.'}))
              : Effect.succeed(home);
          }),
        ),
      ),
      Effect.onError(() => fs.remove(exclusiveTarget, {force: true, recursive: true}).pipe(Effect.ignore)),
      Effect.map(home => {
        let preserved = false;
        return {
          home,
          preserve: () => {
            preserved = true;
          },
          preserved: () => preserved,
        } as const;
      }),
    ),
    reservation =>
      reservation.preserved()
        ? Effect.void
        : fs.remove(reservation.home, {force: true, recursive: true}).pipe(Effect.ignore),
  );
});

const externalBenchmarkPreflight = Effect.fn('benchmarkCodeGraph.externalPreflight')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  prepared: PreparedCodeGraphBenchmarkFixture,
  minimumFreeGiB: number,
  retainHomes: boolean,
  runtimeProvenance: BenchmarkRuntimeProvenance | undefined,
) {
  const system = yield* SystemInfo;
  if (!externalBenchmarkPlatformSupported(process.platform)) {
    return yield* ScriptError.make({
      message: 'External code-graph evidence currently requires Linux or macOS process and storage telemetry.',
    });
  }
  if (!prepared.externalCommit || !prepared.incrementalSourcePath || !prepared.referenceHome) {
    return yield* ScriptError.make({message: 'External benchmark preflight requires a complete prepared fixture.'});
  }
  if (!runtimeProvenance) {
    return yield* ScriptError.make({message: 'External benchmark preflight requires exact runtime provenance.'});
  }
  const source = decodeBenchmarkSource(
    yield* fs.readFile(path.join(prepared.repository, prepared.incrementalSourcePath)),
  );
  semanticBenchmarkOverlay(prepared.incrementalSourcePath, source);
  const [tree, primaryCapacity, referenceCapacity, hardware] = yield* Effect.all(
    [
      repositoryGit(prepared.repository, ['rev-parse', 'HEAD^{tree}']).pipe(
        Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim)),
      ),
      filesystemCapacity(prepared.home),
      filesystemCapacity(prepared.referenceHome),
      system.hardwareInfo,
    ],
    {concurrency: 4},
  );
  const minimumFreeBytes = minimumFreeGiB * 1_073_741_824;
  if (primaryCapacity.availableBytes < minimumFreeBytes || referenceCapacity.availableBytes < minimumFreeBytes) {
    return yield* ScriptError.make({
      message: `External benchmark preflight requires at least ${minimumFreeGiB} GiB free on every benchmark-home filesystem.`,
    });
  }
  return {
    availableBytes: {
      primary: primaryCapacity.availableBytes,
      reference: referenceCapacity.availableBytes,
    },
    commit: prepared.externalCommit,
    effectiveParserMemoryBytes: hardware.effectiveMemoryBytes,
    effectiveParserWorkers: parserWorkerCapacity({
      effectiveMemoryBytes: hardware.effectiveMemoryBytes,
      environment: system.environment(),
      hardwareConcurrency: navigator.hardwareConcurrency,
    }),
    physicalMemoryBytes: hardware.memoryBytes,
    publicRepository: prepared.publicRepository,
    environment: benchmarkEnvironmentProvenance(),
    filesystemsShared: primaryCapacity.filesystem === referenceCapacity.filesystem,
    minimumFreeBytes,
    retainHomes,
    runtimeProvenance,
    semanticOverlaySupported: true,
    tree,
    version: 1,
  } as const;
});

const productionBenchmarkGovernance = Effect.fn('benchmarkCodeGraph.productionGovernance')(function* (
  primaryHome: string,
  referenceHome: string,
  minimumFreeGiB: number,
  allowGithubActionsHostedStorage: boolean,
) {
  const system = yield* SystemInfo;
  const [primaryCapacity, referenceCapacity, primaryStorage, referenceStorage] = yield* Effect.all(
    [
      filesystemCapacity(primaryHome),
      filesystemCapacity(referenceHome),
      benchmarkStorageEnvironment(primaryHome),
      benchmarkStorageEnvironment(referenceHome),
    ],
    {concurrency: 4},
  );
  const minimumFreeBytes = minimumFreeGiB * 1_073_741_824;
  if (primaryCapacity.availableBytes < minimumFreeBytes || referenceCapacity.availableBytes < minimumFreeBytes) {
    return yield* ScriptError.make({
      message: `Production-large benchmark requires at least ${minimumFreeGiB} GiB free on every benchmark-home filesystem.`,
    });
  }
  if (primaryCapacity.filesystem !== referenceCapacity.filesystem) {
    return yield* ScriptError.make({
      message: 'Production-large benchmark requires primary and reference homes on one filesystem.',
    });
  }
  const storageEnvironments = [primaryStorage, referenceStorage];
  // Standard GitHub-hosted Ubuntu runners contract SSD storage, while the
  // guest block layer may honestly expose `unknown` or even a rotational hint
  // for the provider's virtual device. Exact clean-source provenance and the
  // trusted github-hosted runner environment are authoritative for this one
  // reduced non-vector profile. Self-hosted and local runs still require a
  // direct solid-state observation.
  if (!productionBenchmarkStorageGoverned(system.platform, allowGithubActionsHostedStorage, storageEnvironments)) {
    return yield* ScriptError.make({message: 'Production-large benchmark requires solid-state storage.'});
  }
  if (
    system.platform === 'darwin' &&
    EffectArray.some(storageEnvironments, storage => storage.location !== 'internal')
  ) {
    return yield* ScriptError.make({message: 'Production-large benchmark requires internal storage on macOS.'});
  }
  return {
    filesystemsShared: true,
    minimumFreeBytes,
    primaryAvailableBytes: primaryCapacity.availableBytes,
    primaryStorage,
    referenceAvailableBytes: referenceCapacity.availableBytes,
    referenceStorage,
  } satisfies ProductionBenchmarkGovernanceEvidence;
});

export function productionBenchmarkStorageGoverned(
  platform: NodeJS.Platform,
  githubHostedSsdAttested: boolean,
  storageEnvironments: readonly BenchmarkStorageEnvironment[],
): boolean {
  if (storageEnvironments.length !== 2) return false;
  return (
    (githubHostedSsdAttested && platform === 'linux') ||
    EffectArray.every(storageEnvironments, storage => storage.medium === 'solid-state')
  );
}

const verifyPublicRepositoryOrigin = Effect.fn('benchmarkCodeGraph.verifyPublicRepositoryOrigin')(function* (
  repository: string,
  expected: PublicGitHubRepositoryEvidence,
  expectedVerification: ExternalRepositoryPublicVerification | undefined,
  externalCommit: string,
) {
  const remote = Effect2.pipe(
    (yield* repositoryGit(repository, ['remote', 'get-url', 'origin'])).stdout,
    EffectString.trim,
  );
  const actual = publicGitHubRepositoryEvidence(remote);
  if (actual.name !== expected.name || actual.url !== expected.url) {
    return yield* ScriptError.make({message: 'External benchmark public repository identity changed during the run.'});
  }
  const verification = yield* verifyPublicRepositoryCommit(actual, externalCommit, (yield* SystemInfo).environment());
  if (verification !== expectedVerification) {
    return yield* ScriptError.make({
      message: 'External benchmark public repository verification changed during the run.',
    });
  }
});

const filesystemCapacity = Effect.fn('benchmarkCodeGraph.filesystemCapacity')(function* (target: string) {
  const result = yield* runCommandEffect('df', ['-Pk', target], {timeoutMs: 10_000});
  const line = EffectArray.filter(
    Effect2.pipe(result.stdout, EffectString.trim, EffectString.split(/\r?\n/)),
    Boolean,
  ).at(-1);
  const columns =
    Effect2.pipe(
      line,
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.split(/\s+/)),
    ) ?? [];
  const capacityIndex = Option.getOrElse(
    EffectArray.findFirstIndex(columns, __effectArrayValue => !!(column => /^\d+%$/.test(column))(__effectArrayValue)),
    () => -1,
  );
  const availableKilobytes = Number(columns[capacityIndex - 1] ?? Number.NaN);
  const filesystem = columns[0] ?? '';
  if (!filesystem || capacityIndex < 3 || !Number.isSafeInteger(availableKilobytes) || availableKilobytes < 0) {
    return yield* ScriptError.make({message: 'Could not determine benchmark filesystem capacity.'});
  }
  return {availableBytes: availableKilobytes * 1_024, filesystem};
});

export const benchmarkStorageEnvironment = Effect.fn('benchmarkCodeGraph.storageEnvironment')(function* (
  target: string,
) {
  const statArguments = process.platform === 'darwin' ? ['-f', '%T', target] : ['-f', '-c', '%T', target];
  let filesystem = yield* runCommandEffect('stat', statArguments, {timeoutMs: 10_000}).pipe(
    Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim, EffectString.toLowerCase)),
    Effect.orElseSucceed(() => 'unknown'),
    Effect.map(value => (/^[a-z0-9._+-]{1,64}$/.test(value) ? value : 'unknown')),
  );
  let medium: BenchmarkStorageEnvironment['medium'] = 'unknown';
  let location: BenchmarkStorageEnvironment['location'] = 'unknown';
  if (process.platform === 'darwin') {
    const diskutil = Bun.which('diskutil') ?? '/usr/sbin/diskutil';
    const backingDevice = yield* filesystemCapacity(target).pipe(
      Effect.map(capacity => capacity.filesystem),
      Effect.orElseSucceed(() => target),
    );
    const info = yield* runCommandEffect(diskutil, ['info', backingDevice], {timeoutMs: 10_000}).pipe(
      Effect.map(result => result.stdout),
      Effect.orElseSucceed(() => ''),
    );
    const classification = benchmarkDarwinStorageClassification(info);
    if (filesystem === 'unknown') filesystem = classification.filesystem;
    medium = classification.medium;
    location = classification.location;
  } else if (process.platform === 'linux') {
    const source = yield* runCommandEffect('findmnt', ['-n', '-o', 'SOURCE', '--target', target], {
      timeoutMs: 10_000,
    }).pipe(
      Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim)),
      Effect.orElseSucceed(() => ''),
    );
    medium = benchmarkLinuxStorageClassification(filesystem, source, []);
    if (medium === 'unknown' && source.length > 0) {
      const rotational = yield* runCommandEffect('lsblk', ['-n', '-o', 'ROTA', source], {timeoutMs: 10_000}).pipe(
        Effect.map(result =>
          EffectArray.filter(Effect2.pipe(result.stdout, EffectString.trim, EffectString.split(/\s+/)), Boolean),
        ),
        Effect.orElseSucceed(() => [] as string[]),
      );
      medium = benchmarkLinuxStorageClassification(filesystem, source, rotational);
    }
  }
  return {filesystem, location, medium} satisfies BenchmarkStorageEnvironment;
});

export function benchmarkLinuxStorageClassification(
  filesystem: string,
  source: string,
  rotational: readonly string[],
): BenchmarkStorageEnvironment['medium'] {
  const virtualFilesystem =
    /^(?:9p|cifs|fuse(?:\..*)?|nfs\d*|overlay|overlayfs|ramfs|rootfs|smbfs|squashfs|tmpfs)$/iu.test(filesystem);
  const virtualSource = /^(?:fuse(?:\..*)?|none|overlay|ramfs|rootfs|squashfs|tmpfs)(?:\[.*\])?$/iu.test(source);
  if (virtualFilesystem || virtualSource) return 'virtual-or-network';
  if (rotational.includes('1')) return 'rotational';
  if (rotational.includes('0')) return 'solid-state';
  return 'unknown';
}

export function benchmarkDarwinStorageClassification(info: string): BenchmarkStorageEnvironment {
  const filesystemValue =
    /^\s*Type \(Bundle\):\s*([a-z0-9._+-]{1,64})\s*$/imu.exec(info)?.[1] ??
    /^\s*File System Personality:\s*([a-z0-9._+-]{1,64})\s*$/imu.exec(info)?.[1];
  const filesystem =
    Effect2.pipe(filesystemValue, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
    ) ?? 'unknown';
  const virtualOrNetwork = /^\s*(?:Virtual|Network):\s+Yes\s*$/imu.test(info);
  const medium: BenchmarkStorageEnvironment['medium'] = virtualOrNetwork
    ? 'virtual-or-network'
    : /^\s*Solid State:\s+Yes\s*$/imu.test(info)
      ? 'solid-state'
      : /^\s*Solid State:\s+No\s*$/imu.test(info)
        ? 'rotational'
        : 'unknown';
  const location: BenchmarkStorageEnvironment['location'] =
    /^\s*(?:Device Location:\s+Internal|Internal:\s+Yes)\s*$/imu.test(info)
      ? 'internal'
      : /^\s*(?:Device Location:\s+External|Internal:\s+No)\s*$/imu.test(info)
        ? 'external'
        : 'unknown';
  return {filesystem, location, medium};
}

export const benchmarkConcurrentWorktreeIsolation = Effect.fn('benchmarkCodeGraph.concurrentWorktreeIsolation')(
  function* (threadnoteHome: string, options: Readonly<{failureInjection?: 'after-index'}> = {}) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexer = yield* CodeGraphIndexer;
    const query = yield* CodeGraphQueryService;
    const root = yield* fs.makeTempDirectory({prefix: 'threadnote-code-graph-worktree-control-'});
    const repository = path.join(root, 'repository');
    const linkedWorktree = path.join(root, 'linked-worktree');
    const disabledHooks = path.join(root, 'disabled-hooks');
    const emptyGitConfig = path.join(root, 'empty.gitconfig');
    const repositoryRoots = new Set<string>();
    const inheritedEnvironment = (yield* SystemInfo).environment();
    const git = (cwd: string, args: readonly string[]) =>
      runCommandEffect('git', ['-c', `core.hooksPath=${disabledHooks}`, ...args], {
        cwd,
        env: {
          ...inheritedEnvironment,
          GCM_INTERACTIVE: 'never',
          GIT_CONFIG_GLOBAL: emptyGitConfig,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
        timeoutMs: WORKTREE_GIT_COMMAND_TIMEOUT_MS,
      });
    const cleanup = Effect.gen(function* () {
      for (const target of [...repositoryRoots, root]) {
        yield* fs.remove(target, {force: true, recursive: true}).pipe(Effect.ignore);
      }
      for (const target of [...repositoryRoots, root]) {
        if (yield* fs.exists(target)) {
          return yield* ScriptError.make({
            message: 'Concurrent worktree benchmark cleanup left a generated path behind.',
          });
        }
      }
    });
    const measured = Effect.gen(function* () {
      const started = yield* Clock.currentTimeNanos;
      yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
      yield* fs.makeDirectory(disabledHooks, {recursive: true});
      yield* fs.writeFileString(emptyGitConfig, '');
      yield* fs.writeFileString(
        path.join(repository, 'src', 'service.ts'),
        'export const committedWorktreeSentinel = 0;\n',
      );
      yield* git(repository, ['init', '--quiet']);
      yield* git(repository, ['config', 'user.name', 'Threadnote Benchmark']);
      yield* git(repository, ['config', 'user.email', 'benchmark@threadnote.invalid']);
      yield* git(repository, ['add', 'src/service.ts']);
      yield* git(repository, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
      yield* git(repository, ['worktree', 'add', '--quiet', '--detach', linkedWorktree, 'HEAD']);
      yield* Effect.all(
        [
          fs.writeFileString(path.join(repository, 'src', 'service.ts'), 'export const primaryWorktreeSentinel = 1;\n'),
          fs.writeFileString(
            path.join(linkedWorktree, 'src', 'service.ts'),
            'export const linkedWorktreeSentinel = 2;\n',
          ),
        ],
        {concurrency: 2},
      );
      const [primaryIdentity, linkedIdentity] = yield* Effect.all(
        [resolveRepositoryIdentity(repository), resolveRepositoryIdentity(linkedWorktree)],
        {concurrency: 2},
      );
      repositoryRoots.add(
        codeGraphLayout(path, threadnoteHome, primaryIdentity.checkoutId, primaryIdentity.worktreeId).repositoryRoot,
      );
      repositoryRoots.add(
        codeGraphLayout(path, threadnoteHome, linkedIdentity.checkoutId, linkedIdentity.worktreeId).repositoryRoot,
      );
      const [primary, linked] = yield* Effect.all(
        [indexer.index({cwd: repository, threadnoteHome}), indexer.index({cwd: linkedWorktree, threadnoteHome})],
        {concurrency: 2},
      );
      if (options.failureInjection === 'after-index') {
        return yield* ScriptError.make({message: 'Injected concurrent worktree benchmark failure after indexing.'});
      }
      const [primaryQuery, linkedQuery, primaryCrossQuery, linkedCrossQuery] = yield* Effect.all(
        [
          query.inspect({
            cwd: repository,
            operation: 'query',
            query: 'primaryWorktreeSentinel',
            refresh: false,
            requestMaintenance: false,
            threadnoteHome,
          }),
          query.inspect({
            cwd: linkedWorktree,
            operation: 'query',
            query: 'linkedWorktreeSentinel',
            refresh: false,
            requestMaintenance: false,
            threadnoteHome,
          }),
          query.inspect({
            cwd: repository,
            operation: 'query',
            query: 'linkedWorktreeSentinel',
            refresh: false,
            requestMaintenance: false,
            threadnoteHome,
          }),
          query.inspect({
            cwd: linkedWorktree,
            operation: 'query',
            query: 'primaryWorktreeSentinel',
            refresh: false,
            requestMaintenance: false,
            threadnoteHome,
          }),
        ],
        {concurrency: 2},
      );
      const isolationPassed =
        primary.identity.repositoryId === linked.identity.repositoryId &&
        primary.identity.checkoutId === linked.identity.checkoutId &&
        primary.identity.worktreeId !== linked.identity.worktreeId &&
        primary.snapshot.worktreeId === primary.identity.worktreeId &&
        linked.snapshot.worktreeId === linked.identity.worktreeId &&
        primaryQuery.snapshot.worktreeId === primary.identity.worktreeId &&
        linkedQuery.snapshot.worktreeId === linked.identity.worktreeId &&
        primaryCrossQuery.snapshot.worktreeId === primary.identity.worktreeId &&
        linkedCrossQuery.snapshot.worktreeId === linked.identity.worktreeId &&
        EffectArray.some(primaryQuery.nodes, node => node.name === 'primaryWorktreeSentinel') &&
        !EffectArray.some(primaryQuery.nodes, node => node.name === 'linkedWorktreeSentinel') &&
        EffectArray.some(linkedQuery.nodes, node => node.name === 'linkedWorktreeSentinel') &&
        !EffectArray.some(linkedQuery.nodes, node => node.name === 'primaryWorktreeSentinel') &&
        !EffectArray.some(primaryCrossQuery.nodes, node => node.name === 'linkedWorktreeSentinel') &&
        !EffectArray.some(linkedCrossQuery.nodes, node => node.name === 'primaryWorktreeSentinel');
      if (!isolationPassed) {
        return yield* ScriptError.make({message: 'Concurrent linked-worktree graph isolation control failed.'});
      }
      const durationMilliseconds = Math.max(
        Number.EPSILON,
        Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND,
      );
      return {
        cleanupPassed: true,
        durationMilliseconds,
        indexedFiles: primary.snapshot.fileCount + linked.snapshot.fileCount,
        isolationPassed: true,
        simultaneousWorktrees: 2,
        topology: 'bounded-synthetic-linked-worktrees-in-measured-primary-home',
      } satisfies ConcurrentWorktreeEvidence;
    });
    return yield* measured.pipe(
      Effect.timeoutOrElse({
        duration: WORKTREE_ISOLATION_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            ScriptError.make({
              message: `Concurrent worktree control timed out after ${WORKTREE_ISOLATION_TIMEOUT_MS} milliseconds.`,
            }),
          ),
      }),
      Effect.ensuring(cleanup.pipe(Effect.orDie)),
    );
  },
);

function benchmarkEnvironmentProvenance(): Readonly<Record<string, string>> {
  return sanitizedBenchmarkEnvironmentProvenance(process.env);
}

export function sanitizedBenchmarkEnvironmentProvenance(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  if (
    Effect2.pipe(environment.SQLITE_TMPDIR, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  )
    values.SQLITE_TMPDIR = 'configured-path-redacted';
  const idleTimeout = boundedEnvironmentInteger(
    environment,
    'THREADNOTE_CODE_GRAPH_PARSER_IDLE_TIMEOUT_MS',
    0,
    60 * 60_000,
  );
  const requestTimeout = boundedEnvironmentInteger(
    environment,
    'THREADNOTE_CODE_GRAPH_PARSER_TIMEOUT_MS',
    1_000,
    10 * 60_000,
  );
  const workers = boundedEnvironmentInteger(environment, 'THREADNOTE_CODE_GRAPH_PARSER_WORKERS', 1, 8);
  const embeddingContexts = Number(environment[THREADNOTE_EMBEDDING_CONTEXTS_ENV]);
  if (idleTimeout !== undefined) values.THREADNOTE_CODE_GRAPH_PARSER_IDLE_TIMEOUT_MS = String(idleTimeout);
  if (requestTimeout !== undefined) values.THREADNOTE_CODE_GRAPH_PARSER_TIMEOUT_MS = String(requestTimeout);
  if (workers !== undefined) values.THREADNOTE_CODE_GRAPH_PARSER_WORKERS = String(workers);
  if ([1, 2, 4, 8].includes(embeddingContexts)) {
    values[THREADNOTE_EMBEDDING_CONTEXTS_ENV] = String(embeddingContexts);
  }
  if (
    Effect2.pipe(environment.THREADNOTE_BENCHMARK_RUNNER_CLASS, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  ) {
    values.THREADNOTE_BENCHMARK_RUNNER_CLASS = benchmarkRunnerLabel(
      'THREADNOTE_BENCHMARK_RUNNER_CLASS',
      'local-unclassified',
      environment,
    );
  }
  if (
    Effect2.pipe(environment.THREADNOTE_BENCHMARK_RUNNER_ID, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  ) {
    values.THREADNOTE_BENCHMARK_RUNNER_ID = benchmarkRunnerLabel(
      'THREADNOTE_BENCHMARK_RUNNER_ID',
      'local',
      environment,
    );
  }
  return values;
}

export function externalBenchmarkPlatformSupported(platform: string): boolean {
  return platform === 'darwin' || platform === 'linux';
}

function boundedEnvironmentInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const parsed = Number.parseInt(environment[name] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? Math.min(maximum, parsed) : undefined;
}

function benchmarkRunnerLabel(
  name: 'THREADNOTE_BENCHMARK_RUNNER_CLASS' | 'THREADNOTE_BENCHMARK_RUNNER_ID',
  fallback: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = Effect2.pipe(environment[name], effectOptionalString =>
    effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
  );
  if (!value) return fallback;
  if (name === 'THREADNOTE_BENCHMARK_RUNNER_CLASS') {
    const normalized = Effect2.pipe(value, EffectString.toLowerCase);
    if (normalized === 'local-unclassified') return normalized;
    if (/^github-hosted-ubuntu-[a-z0-9.]+-x64$/.test(normalized)) return 'github-hosted-linux-x64';
    if (/^github-hosted-ubuntu-[a-z0-9.]+-arm64$/.test(normalized)) return 'github-hosted-linux-arm64';
    if (/^github-hosted-macos-[a-z0-9.]+-arm64$/.test(normalized)) return 'github-hosted-macos-arm64';
    if (/^github-hosted-windows-[a-z0-9.]+-x64$/.test(normalized)) return 'github-hosted-windows-x64';
    return 'other';
  }
  const digest = new Bun.CryptoHasher('sha256').update(value).digest('hex');
  return `runner-${Effect2.pipe(digest, EffectString.slice(0, 16))}`;
}

const validateExternalTrackedRegularPath = Effect.fn('benchmarkCodeGraph.validateExternalTrackedRegularPath')(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    repository: string,
    value: string,
    option: '--control expectedPath' | '--incremental-path',
  ) {
    if (path.isAbsolute(value)) {
      return yield* ScriptError.make({message: `${option} must name a repository-relative file.`});
    }
    const normalized = path.normalize(value);
    const source = path.resolve(repository, normalized);
    const containment = path.relative(repository, source);
    if (
      containment === '' ||
      containment === '..' ||
      Effect2.pipe(containment, EffectString.startsWith(`..${path.sep}`)) ||
      path.isAbsolute(containment)
    ) {
      return yield* ScriptError.make({message: `${option} must name a repository-relative file.`});
    }
    const canonicalSource = yield* fs.realPath(source);
    const canonicalContainment = path.relative(repository, canonicalSource);
    if (
      canonicalContainment === '' ||
      canonicalContainment === '..' ||
      Effect2.pipe(canonicalContainment, EffectString.startsWith(`..${path.sep}`)) ||
      path.isAbsolute(canonicalContainment)
    ) {
      return yield* ScriptError.make({message: `${option} resolved outside the external repository.`});
    }
    const gitPath = EffectArray.join(Effect2.pipe(containment, EffectString.split(path.sep)), '/');
    const tracked = yield* repositoryGit(repository, ['ls-files', '--stage', '--error-unmatch', '--', gitPath]);
    if (!/^100(?:644|755)\s/.test(tracked.stdout)) {
      return yield* ScriptError.make({message: `${option} must name a tracked regular file, not a link or submodule.`});
    }
    const info = yield* fs.stat(source);
    if (info.type !== 'File') {
      return yield* ScriptError.make({message: `${option} must name a tracked regular file.`});
    }
    return gitPath;
  },
);

const verifyExternalRepositoryUnchanged = Effect.fn('benchmarkCodeGraph.verifyExternalRepositoryUnchanged')(function* (
  repository: string,
  expectedCommit: string,
) {
  const [commit, dirty] = yield* Effect.all(
    [
      repositoryGit(repository, ['rev-parse', 'HEAD']).pipe(
        Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim)),
      ),
      repositoryGit(repository, CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS).pipe(
        Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim)),
      ),
    ],
    {concurrency: 2},
  );
  if (commit !== expectedCommit || dirty.length > 0) {
    return yield* ScriptError.make({
      message:
        'External repository changed during the benchmark; its evidence was rejected after restoring the overlay.',
    });
  }
});

const verifyBenchmarkSourceUnchanged = Effect.fn('benchmarkCodeGraph.verifyBenchmarkSourceUnchanged')(function* (
  sourceRoot: string,
  expectedCommit: string,
) {
  const [commit, dirty] = yield* Effect.all(
    [
      threadnoteSourceGit(sourceRoot, ['rev-parse', 'HEAD']),
      threadnoteSourceGit(sourceRoot, CONFIG_NEUTRAL_GIT_STATUS_ARGUMENTS),
    ],
    {concurrency: 2},
  );
  if (commit !== expectedCommit || dirty.length > 0) {
    return yield* ScriptError.make({
      message: 'Threadnote source changed during the external benchmark; its evidence was not published.',
    });
  }
});

const repositoryGit = Effect.fn('benchmarkCodeGraph.repositoryGit')((repository: string, args: readonly string[]) =>
  runCommandEffect('git', ['-C', repository, ...args], {
    maxOutputBytes: 16 * 1_048_576,
    timeoutMs: 5 * 60_000,
  }),
);

const canonicalizeProspectivePath = Effect.fn('benchmarkCodeGraph.canonicalizeProspectivePath')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
) {
  let current = path.resolve(target);
  const suffix: string[] = [];
  while (true) {
    const canonical = yield* fs.realPath(current).pipe(Effect.option);
    if (Option.isSome(canonical)) return path.join(canonical.value, ...suffix);
    const parent = path.dirname(current);
    if (parent === current) {
      return yield* ScriptError.make({message: `Could not resolve an existing parent for output path ${target}.`});
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
});

export function productionProfile(
  options: Pick<CodeGraphBenchmarkOptions, 'profile' | 'profileFiles' | 'profileSymbols'>,
): ProductionCodeGraphFixtureProfile {
  if (options.profile !== 'production-large')
    throw ScriptError.make({message: 'Production fixture profile was not selected.'});
  if (options.profileFiles === undefined && options.profileSymbols === undefined) {
    return PRODUCTION_LARGE_CODE_GRAPH_PROFILE;
  }
  const sourceFiles = options.profileFiles ?? PRODUCTION_LARGE_CODE_GRAPH_PROFILE.sourceFiles;
  const targetGraphSymbols = options.profileSymbols ?? PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetGraphSymbols;
  const sourceScale = sourceFiles / PRODUCTION_LARGE_CODE_GRAPH_PROFILE.sourceFiles;
  const symbolScale = targetGraphSymbols / PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetGraphSymbols;
  const workspaceCount = Math.max(2, Math.min(PRODUCTION_LARGE_CODE_GRAPH_PROFILE.workspaceCount, sourceFiles));
  const activeWorkspaceExcludedPackageCount = Math.min(
    PRODUCTION_LARGE_CODE_GRAPH_PROFILE.activeWorkspaceExcludedPackageCount,
    workspaceCount - 1,
  );
  const activeWorkspaceExcludedSourceFiles = Math.min(
    PRODUCTION_LARGE_CODE_GRAPH_PROFILE.activeWorkspaceExcludedSourceFiles,
    sourceFiles - 1,
  );
  const tsxSourceFiles = Math.min(
    sourceFiles - 1,
    Math.max(
      1,
      Math.round(
        sourceFiles *
          (PRODUCTION_LARGE_CODE_GRAPH_PROFILE.classMix.tsxSourceFiles /
            PRODUCTION_LARGE_CODE_GRAPH_PROFILE.sourceFiles),
      ),
    ),
  );
  const classMix = {
    duplicateHeavyJsonFiles: scaledProfileClassCount('duplicateHeavyJsonFiles', sourceScale),
    generatedSvgFiles: scaledProfileClassCount('generatedSvgFiles', sourceScale),
    nxProjectFiles: Math.min(workspaceCount, scaledProfileClassCount('nxProjectFiles', sourceScale)),
    packageManifestFiles: workspaceCount + 1,
    supportMarkdownFiles: scaledProfileClassCount('supportMarkdownFiles', sourceScale),
    tsconfigFiles: Math.min(workspaceCount + 1, scaledProfileClassCount('tsconfigFiles', sourceScale)),
    tsxSourceFiles,
    typescriptSourceFiles: sourceFiles - tsxSourceFiles,
    workspaceManifestFiles: 1,
  } as const;
  const targetEligibleFiles = productionEligibleFileCount(classMix);
  const targetRepositoryFiles = productionRepositoryFileCount(classMix);
  const metadataGraphSymbols = workspaceCount + 3;
  const declarationSymbols = targetGraphSymbols - sourceFiles - metadataGraphSymbols;
  if (declarationSymbols < sourceFiles) {
    throw ScriptError.make({
      message:
        '--profile-symbols must cover the requested files, manifest/module symbols, and at least one declaration per file.',
    });
  }
  return validateProductionProfile({
    activeWorkspaceExcludedPackageCount,
    activeWorkspaceExcludedSourceFiles,
    classMix,
    declarationSymbols,
    duplicateBlobs: {
      generatedSvgVariants: Math.min(
        PRODUCTION_LARGE_CODE_GRAPH_PROFILE.duplicateBlobs.generatedSvgVariants,
        classMix.generatedSvgFiles,
      ),
      heavyJsonPayloadBytes: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.duplicateBlobs.heavyJsonPayloadBytes,
      heavyJsonVariants: Math.min(
        PRODUCTION_LARGE_CODE_GRAPH_PROFILE.duplicateBlobs.heavyJsonVariants,
        classMix.duplicateHeavyJsonFiles,
      ),
    },
    highSignalConfigHardCapBytes: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.highSignalConfigHardCapBytes,
    id: 'production-large',
    lowSignalJsonExclusionThresholdBytes: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.lowSignalJsonExclusionThresholdBytes,
    maxCallsPerDeclaration: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.maxCallsPerDeclaration,
    sourceFiles,
    surrogate: PRODUCTION_LARGE_CODE_GRAPH_PROFILE.surrogate,
    targetEligibleFiles,
    targetGraphEdges: Math.max(1, Math.round(PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetGraphEdges * symbolScale)),
    targetGraphSymbols,
    targetLexicalTermRows: Math.max(
      1,
      Math.round(PRODUCTION_LARGE_CODE_GRAPH_PROFILE.targetLexicalTermRows * symbolScale),
    ),
    targetRepositoryFiles,
    version: 2,
    workspaceCount,
    worktreeChurnScenarioCount: PRODUCTION_WORKTREE_CHURN_SCENARIOS.length,
  });
}

function productionProfileIdentity(profile: ProductionCodeGraphFixtureProfile, vectors: boolean): string {
  return (
    `generated-code-graph-production-v${profile.version}-${vectors ? 'vectors' : 'lexical'}:` +
    `${profile.targetEligibleFiles}:${profile.targetGraphSymbols}:${profile.targetGraphEdges}:` +
    `${profile.targetRepositoryFiles}:${profile.targetLexicalTermRows}:${profile.workspaceCount}:` +
    `${EffectArray.join(
      EffectArray.map(EffectRecord.values(profile.classMix), item =>
        item === null || item === undefined ? '' : String(item),
      ),
      ':',
    )}:${profile.activeWorkspaceExcludedSourceFiles}:` +
    `${profile.duplicateBlobs.generatedSvgVariants}:${profile.duplicateBlobs.heavyJsonVariants}:` +
    `${profile.duplicateBlobs.heavyJsonPayloadBytes}:${profile.lowSignalJsonExclusionThresholdBytes}:` +
    `${profile.highSignalConfigHardCapBytes}`
  );
}

function scaledProfileClassCount(
  name: keyof Pick<
    ProductionCodeGraphFixtureProfile['classMix'],
    'duplicateHeavyJsonFiles' | 'generatedSvgFiles' | 'nxProjectFiles' | 'supportMarkdownFiles' | 'tsconfigFiles'
  >,
  scale: number,
): number {
  return Math.max(1, Math.round(PRODUCTION_LARGE_CODE_GRAPH_PROFILE.classMix[name] * scale));
}

export function productionProfileArtifactMetadata(
  profile: ProductionCodeGraphFixtureProfile,
): Readonly<Record<string, boolean | number | string>> {
  const excludedBytes = productionExcludedByteDistribution(profile);
  return {
    profile: profile.id,
    profileActiveWorkspaceExcludedPackages: profile.activeWorkspaceExcludedPackageCount,
    profileActiveWorkspaceExcludedSourceFiles: profile.activeWorkspaceExcludedSourceFiles,
    profileClassDuplicateHeavyJsonFiles: profile.classMix.duplicateHeavyJsonFiles,
    profileClassGeneratedSvgFiles: profile.classMix.generatedSvgFiles,
    profileClassNxProjectFiles: profile.classMix.nxProjectFiles,
    profileClassPackageManifestFiles: profile.classMix.packageManifestFiles,
    profileClassSupportMarkdownFiles: profile.classMix.supportMarkdownFiles,
    profileClassTsconfigFiles: profile.classMix.tsconfigFiles,
    profileClassTsxSourceFiles: profile.classMix.tsxSourceFiles,
    profileClassTypescriptSourceFiles: profile.classMix.typescriptSourceFiles,
    profileClassWorkspaceManifestFiles: profile.classMix.workspaceManifestFiles,
    profileDeclarationSymbols: profile.declarationSymbols,
    profileDuplicateGeneratedSvgVariants: profile.duplicateBlobs.generatedSvgVariants,
    profileDuplicateHeavyJsonPayloadBytes: profile.duplicateBlobs.heavyJsonPayloadBytes,
    profileDuplicateHeavyJsonVariants: profile.duplicateBlobs.heavyJsonVariants,
    profileTargetExcludedGeneratedSvgBytes: excludedBytes.generatedSvgBytes,
    profileTargetExcludedHeavyJsonBytes: excludedBytes.heavyJsonBytes,
    profileTargetExcludedLowMeaningBytes: excludedBytes.totalBytes,
    profileTargetExcludedLowMeaningFiles: profile.classMix.generatedSvgFiles + profile.classMix.duplicateHeavyJsonFiles,
    profileHighSignalConfigHardCapBytes: profile.highSignalConfigHardCapBytes,
    profileLowSignalJsonExclusionThresholdBytes: profile.lowSignalJsonExclusionThresholdBytes,
    profileMaxCallsPerDeclaration: profile.maxCallsPerDeclaration,
    profileSourceFiles: profile.sourceFiles,
    profileSurrogate: profile.surrogate,
    profileTargetEdges: profile.targetGraphEdges,
    profileTargetEligibleFiles: profile.targetEligibleFiles,
    profileTargetLexicalTermRows: profile.targetLexicalTermRows,
    profileTargetRepositoryFiles: profile.targetRepositoryFiles,
    profileTargetSymbols: profile.targetGraphSymbols,
    profileVersion: profile.version,
    profileWorkspaceExclusionPolicy: 'active-source-remains-eligible',
    profileWorkspaces: profile.workspaceCount,
    profileWorktreeChurnMode: 'declared-surrogate-scenarios-no-latency-claims',
    profileWorktreeChurnScenarioCount: profile.worktreeChurnScenarioCount,
    profileWorktreeChurnScenarios: EffectArray.join(PRODUCTION_WORKTREE_CHURN_SCENARIOS, ','),
  };
}

function benchmarkComparisonKey(input: {
  readonly architecture: string;
  readonly cpu: string;
  readonly memoryBytes: number;
  readonly operatingSystem: string;
  readonly runnerClass: string;
}): string {
  return EffectArray.join(
    EffectArray.map(
      [input.runnerClass, input.operatingSystem, input.architecture, input.cpu, input.memoryBytes],
      value => Effect2.pipe(String(value), EffectString.trim, EffectString.replace(/\s+/g, ' ')),
    ),
    '|',
  );
}

type BenchmarkRatchetPrimitive = boolean | number | string;
type BenchmarkMeasurementUnit = BenchmarkArtifactV1['measurements'][number]['unit'];

export interface CodeGraphBenchmarkMeasurementRatchetV1 {
  readonly meanMaximum?: number;
  readonly maximum?: number;
  readonly minimum?: number;
  readonly p50Maximum?: number;
  readonly p95Maximum?: number;
  readonly p99Maximum?: number;
  readonly samplesMinimum?: number;
  readonly unit: BenchmarkMeasurementUnit;
}

export interface CodeGraphBenchmarkRatchetV1 {
  readonly environment: Readonly<Record<string, BenchmarkRatchetPrimitive>>;
  readonly measurements: Readonly<Record<string, CodeGraphBenchmarkMeasurementRatchetV1>>;
  readonly metadata: Readonly<Record<string, BenchmarkRatchetPrimitive>>;
  readonly suite: string;
  readonly version: 1;
}

export interface CodeGraphBenchmarkRatchetPairedControl {
  readonly artifact: BenchmarkArtifactV1;
  readonly expectedCandidateCommit: string;
  readonly expectedCommit: string;
  readonly initialCandidateArtifact: BenchmarkArtifactV1;
}

interface PreparedCodeGraphBenchmarkRatchetSandwich {
  readonly candidateInterpolationWeight: number;
  readonly controlMeasurementsByName: ReadonlyMap<string, BenchmarkArtifactV1['measurements'][number][]>;
  readonly initialCandidateMeasurementsByName: ReadonlyMap<string, BenchmarkArtifactV1['measurements'][number][]>;
}

const PRODUCTION_RATCHET_RELATIVE_HEADROOM = 0.25;
const PRODUCTION_RATCHET_DETAILED_MILLISECOND_RELATIVE_HEADROOM = 0.75;
// Hosted VM scheduling can move short observations by tens or hundreds of
// milliseconds even when source and output are identical. Aggregate/objective
// timings get 100 ms absolute headroom; detailed single-observation splits get
// 300 ms. The aggregate 25% limit still dominates above 400 ms, including the
// end-to-end cold and incremental objectives this ratchet exists to protect.
const PRODUCTION_RATCHET_MILLISECOND_NOISE_HEADROOM = 100;
const PRODUCTION_RATCHET_DETAILED_MILLISECOND_NOISE_HEADROOM = 300;
const PRODUCTION_RATCHET_SANDWICH_MAXIMUM_SPAN_MILLISECONDS = 40 * 60_000;
// The first candidate observation is the screening measurement that starts a
// same-runner candidate-control-candidate sequence. When the protected-base
// control passes, the final candidate is the confirmatory observation. Admit
// one non-objective confirmatory wall-only boundary crossing only when the
// screening candidate passed, capped by both 1% and 5 ms. Static limits and
// hard objectives stay unchanged, and independently ratcheted CPU, RSS, work,
// and storage remain strict.
const PRODUCTION_RATCHET_CONFIRMATORY_WALL_TAIL_RELATIVE_TOLERANCE = 0.01;
const PRODUCTION_RATCHET_CONFIRMATORY_WALL_TAIL_ABSOLUTE_TOLERANCE_MILLISECONDS = 5;
// The bootstrap sampler covers fixture construction and Git setup before the
// product index begins. A short-lived helper can overlap only the screening
// observation even when the exact-base control and immediate candidate repeat
// both retain the reviewed process ceiling of four. Admit the one observed
// five-process screening case; product-phase process counts and every
// resource/work measurement stay strict. Pinning both values makes any future
// ratchet change require a fresh policy review instead of widening implicitly.
const PRODUCTION_RATCHET_SCREENING_BOOTSTRAP_PROCESS_COUNT_MAXIMUM = 4;
const PRODUCTION_RATCHET_SCREENING_BOOTSTRAP_PROCESS_COUNT_TOLERANCE = 1;
const PRODUCTION_RATCHET_SCREENING_BOOTSTRAP_PROCESS_COUNT = 'bootstrap-external-process-count-peak-observed-n1';
// Cold registration includes two race-fenced Git status observations and
// synchronous fresh SQLite setup on hosted virtual storage. Preserve a strict
// sub-five-second wall objective while allowing the independently ratcheted
// CPU, work, and storage measurements to distinguish host wait from product
// regressions. Same-overlay registration retains its narrower envelope.
const PRODUCTION_RATCHET_COLD_REGISTRATION_RELATIVE_HEADROOM = 5;
const PRODUCTION_RATCHET_SAME_OVERLAY_REGISTRATION_RELATIVE_HEADROOM = 2;
const PRODUCTION_RATCHET_REGISTRATION_MILLISECOND_TARGET = 5_000 - 1;
// A zero-byte seed can still observe a tiny SQLite journal or filesystem
// bookkeeping file on another hosted VM. Govern storage growth from the first
// material MiB instead of treating a 512-byte observation as a regression.
const PRODUCTION_RATCHET_BYTE_NOISE_HEADROOM = 1_048_576;
const PRODUCTION_RATCHET_MINIMUM_FREE_BYTES = 120 * 1_073_741_824;
// Keep the permanent lexical CI ratchet production-shaped but small enough to
// run in parallel with ordinary checks. Full-size and vector observations keep
// the release benchmark's 120 GiB floor.
const PRODUCTION_RATCHET_REDUCED_MINIMUM_FREE_GIB = 20;
const PRODUCTION_RATCHET_REDUCED_MINIMUM_FREE_BYTES = PRODUCTION_RATCHET_REDUCED_MINIMUM_FREE_GIB * 1_073_741_824;
const PRODUCTION_RATCHET_REDUCED_PROFILE_FILES_MAXIMUM = 3_000;
const PRODUCTION_RATCHET_REDUCED_PROFILE_SYMBOLS_MAXIMUM = 110_000;
const PRODUCTION_RATCHET_MILLISECOND_TARGETS = new Map<string, number>([
  ['cold-index', 60 * 60_000 - 1],
  ['cold-registration-lock-and-database-setup', PRODUCTION_RATCHET_REGISTRATION_MILLISECOND_TARGET],
  ['cold-reference-resolution-longest-transaction-n1', 15_000 - 1],
  ['one-file-reindex-index', 30_000 - 1],
  ['one-file-reindex-post-committed-scan-overlay-and-workspace', 5_000 - 1],
  ['one-file-reindex-registration-lock-and-database-setup', PRODUCTION_RATCHET_REGISTRATION_MILLISECOND_TARGET],
  ['one-file-reindex-reference-resolution-longest-transaction-n1', 15_000 - 1],
  ['same-overlay-reference-registration-lock-and-database-setup', PRODUCTION_RATCHET_REGISTRATION_MILLISECOND_TARGET],
  ['same-overlay-reference-reference-resolution-longest-transaction-n1', 15_000 - 1],
]);

/**
 * Generates independent reviewed limits from repeated, exact-commit governed
 * production observations. Transient sampler phase names are diagnostic rather
 * than assessed metrics; their stable operation-wide CPU, RSS, SQLite, and TEMP
 * aggregates remain independently ratcheted.
 */
export function createCodeGraphProductionRatchet(values: readonly BenchmarkArtifactV1[]): CodeGraphBenchmarkRatchetV1 {
  if (values.length < 3)
    throw ScriptError.make({message: 'Production ratchet generation requires at least three artifacts.'});
  const artifacts = EffectArray.map(values, parseBenchmarkArtifactV1);
  for (const artifact of artifacts) assertProductionLargeEvidence(artifact);
  const first = artifacts[0];
  const retainedMeasurements = EffectArray.map(artifacts, productionRatchetMeasurements);
  const measurementIndexes = EffectArray.map(
    retainedMeasurements,
    measurements => new Map(EffectArray.map(measurements, measurement => [measurement.name, measurement])),
  );
  const names = EffectArray.map(retainedMeasurements[0], measurement => measurement.name).sort();
  const generationIdentity = productionRatchetGenerationIdentity(first);
  const metadata = productionRatchetMetadata(first);
  for (const [index, artifact] of artifacts.slice(1).entries()) {
    const candidateNames = EffectArray.map(retainedMeasurements[index + 1], measurement => measurement.name).sort();
    if (
      artifact.suite !== first.suite ||
      JSON.stringify(candidateNames) !== JSON.stringify(names) ||
      artifact.environment.architecture !== first.environment.architecture ||
      artifact.environment.fixtureHash !== first.environment.fixtureHash ||
      artifact.environment.node !== first.environment.node ||
      artifact.environment.packageManager !== first.environment.packageManager ||
      artifact.environment.runner !== first.environment.runner ||
      artifact.environment.runnerVersion !== first.environment.runnerVersion ||
      JSON.stringify(productionRatchetMetadata(artifact)) !== JSON.stringify(metadata)
    ) {
      throw ScriptError.make({
        message: 'Production ratchet artifacts do not share one governed runner and fixture contract.',
      });
    }
    if (productionRatchetGenerationIdentity(artifact) !== generationIdentity) {
      throw ScriptError.make({
        message: 'Production ratchet artifacts do not share one exact source/runtime/storage contract.',
      });
    }
  }
  const measurements: Record<string, CodeGraphBenchmarkMeasurementRatchetV1> = {};
  for (const name of names) {
    const samples = EffectArray.map(measurementIndexes, index => index.get(name));
    if (EffectArray.some(samples, sample => sample === undefined)) {
      throw ScriptError.make({message: `Production ratchet measurement ${name} is missing.`});
    }
    const complete: BenchmarkArtifactV1['measurements'][number][] = [];
    for (const sample of samples) {
      if (sample === undefined) throw ScriptError.make({message: `Production ratchet measurement ${name} is missing.`});
      complete.push(sample);
    }
    const unit = complete[0].unit;
    if (EffectArray.some(complete, sample => sample.unit !== unit || sample.samples !== 1)) {
      throw ScriptError.make({message: `Production ratchet measurement ${name} has inconsistent samples or units.`});
    }
    measurements[name] = productionMeasurementRatchet(
      name,
      unit,
      EffectArray.map(complete, sample => sample.p50),
    );
  }
  return {
    environment: {
      architecture: first.environment.architecture,
      dirty: false,
      fixtureHash: first.environment.fixtureHash,
      node: first.environment.node,
      packageManager: first.environment.packageManager,
      runner: first.environment.runner,
      runnerVersion: first.environment.runnerVersion,
    },
    measurements,
    metadata,
    suite: first.suite,
    version: 1,
  };
}

// These observer-only subdivisions were added after the frozen production
// ratchet. Keep their complete observations in the artifact, while the original
// enclosing operation wall/CPU/resource measurements remain assessed. Enumerate
// the finite contract so a new stage, statistic, or prefix still fails closed.
const PRODUCTION_RATCHET_COMPLETION_DIAGNOSTICS = new Set([
  ...EffectArray.flatMap(['cold', 'one-file-reindex', 'same-overlay-reference'] as const, prefix => [
    ...EffectArray.flatMap(
      [
        'admission',
        'database-session',
        'database-session-body',
        'index-scope',
        'index-scope-body',
        'lifecycle-opportunity',
        'reference-reservation-owner-identity',
        'reference-reservation-claim',
        'reference-reservation-use',
        'reference-reservation-release',
        'reporter-completion',
        'share-drain',
        'snapshot-lease-release',
        'snapshot-lease-release-after-complete',
      ],
      stage =>
        EffectArray.map(
          ['count', 'process-cpu-total', 'wall-maximum', 'wall-total'],
          statistic => `${prefix}-completion-${stage}-${statistic}-n1`,
        ),
    ),
    `${prefix}-post-activation-completion`,
    `${prefix}-post-activation-completion-process-cpu-n1`,
  ]),
  ...EffectArray.flatMap(['lease-acquire', 'read-session', 'lease-release'], stage => [
    `whole-graph-structural-analysis-${stage}`,
    `whole-graph-structural-analysis-${stage}-process-cpu`,
  ]),
]);

function productionRatchetMeasurements(
  artifact: BenchmarkArtifactV1,
): readonly BenchmarkArtifactV1['measurements'][number][] {
  const retained = EffectArray.filter(
    artifact.measurements,
    measurement =>
      !dynamicExternalSamplerPhaseMeasurement(measurement.name) &&
      !unstableProductionRatchetMeasurement(measurement.name),
  );
  const names = EffectArray.map(retained, measurement => measurement.name);
  if (new Set(names).size !== names.length) {
    throw ScriptError.make({message: 'Production ratchet artifacts require unique assessed measurement names.'});
  }
  return EffectArray.filter(retained, measurement => !PRODUCTION_RATCHET_COMPLETION_DIAGNOSTICS.has(measurement.name));
}

function unstableProductionRatchetMeasurement(name: string): boolean {
  // Boundary RSS is the allocator/GC state at one instrumentation instant, not
  // a phase peak. Retain it in evidence, but govern memory with the external
  // process-tree RSS peaks that cover the complete operation.
  return (
    Effect2.pipe(name, EffectString.endsWith('-boundary-rss-n1')) ||
    Effect2.pipe(name, EffectString.endsWith('-external-process-tree-maximum-sample-gap-n1')) ||
    // Available capacity is a lower-bound admission condition, never an upper
    // performance bound. The governed preflight and metadata retain the 20 GiB
    // floor; more free space must not fail the ratchet.
    Effect2.pipe(name, EffectString.endsWith('-filesystem-available-n1'))
  );
}

function dynamicExternalSamplerPhaseMeasurement(name: string): boolean {
  const prefix = Option.getOrUndefined(
    EffectArray.findFirst(
      ['bootstrap', 'cold', 'one-file-reindex', 'same-overlay-reference'],
      __effectArrayValue =>
        !!(candidate => Effect2.pipe(name, EffectString.startsWith(`${candidate}-`)))(__effectArrayValue),
    ),
  );
  if (prefix === undefined) return false;
  const suffix = Effect2.pipe(name, EffectString.slice(prefix.length + 1));
  if (Effect2.pipe(suffix, EffectString.startsWith('external-'))) return false;
  return (
    /-external-(?:process|rss)-.+-n1$/u.test(suffix) ||
    /-sqlite-(?:main|shm|temp|wal)(?:-[a-z0-9-]+)?-peak-observed-n1$/u.test(suffix)
  );
}

function productionRatchetMetadata(artifact: BenchmarkArtifactV1): Readonly<Record<string, BenchmarkRatchetPrimitive>> {
  const profile = EffectRecord.fromEntries(
    EffectArray.map(EffectRecord.keys(productionProfileArtifactMetadata(PRODUCTION_LARGE_CODE_GRAPH_PROFILE)), name => [
      name,
      artifact.metadata[name],
    ]),
  );
  const githubHostedStorageAttested = productionRatchetGithubHostedStorageAttested(artifact.metadata);
  const selected = {
    ...profile,
    // Standard GitHub-hosted Linux runners are governed by the attested runner
    // contract. Their guest block layer may report the same SSD as rotational,
    // virtual, or unknown across hosts, so retain those observations in the
    // evidence artifact without turning them into unstable ratchet identity.
    ...(githubHostedStorageAttested
      ? {}
      : {
          benchmarkDiskFilesystem: artifact.metadata.benchmarkDiskFilesystem,
          benchmarkDiskLocation: artifact.metadata.benchmarkDiskLocation,
          benchmarkDiskMedium: artifact.metadata.benchmarkDiskMedium,
          benchmarkReferenceDiskFilesystem: artifact.metadata.benchmarkReferenceDiskFilesystem,
          benchmarkReferenceDiskLocation: artifact.metadata.benchmarkReferenceDiskLocation,
          benchmarkReferenceDiskMedium: artifact.metadata.benchmarkReferenceDiskMedium,
        }),
    benchmarkFilesystemsShared: artifact.metadata.benchmarkFilesystemsShared,
    benchmarkGoverned: artifact.metadata.benchmarkGoverned,
    benchmarkMinimumFreeBytes: artifact.metadata.benchmarkMinimumFreeBytes,
    benchmarkSourceValidationMode: artifact.metadata.benchmarkSourceValidationMode,
    ...(artifact.metadata.benchmarkSourceValidationMode === 'github-actions-clean-source'
      ? {
          benchmarkGithubRunnerArchitecture: artifact.metadata.benchmarkGithubRunnerArchitecture,
          benchmarkGithubRunnerEnvironment: artifact.metadata.benchmarkGithubRunnerEnvironment,
          benchmarkGithubRunnerOperatingSystem: artifact.metadata.benchmarkGithubRunnerOperatingSystem,
        }
      : {}),
    coldEdges: artifact.metadata.coldEdges,
    coldFiles: artifact.metadata.coldFiles,
    coldMaterializationStorageMode: artifact.metadata.coldMaterializationStorageMode,
    coldSymbols: artifact.metadata.coldSymbols,
    effectiveParserWorkers: artifact.metadata.effectiveParserWorkers,
    oneFileReindexMaterializationMode: artifact.metadata.oneFileReindexMaterializationMode,
    oneFileReindexMaterializationStorageMode: artifact.metadata.oneFileReindexMaterializationStorageMode,
    primaryQueryStructuralDigestCold: artifact.metadata.primaryQueryStructuralDigestCold,
    primaryQueryStructuralDigestIncremental: artifact.metadata.primaryQueryStructuralDigestIncremental,
    primaryQueryStructuralDigestSameOverlayReference:
      artifact.metadata.primaryQueryStructuralDigestSameOverlayReference,
    retrievalMode: artifact.metadata.retrievalMode,
    runnerClass: artifact.metadata.runnerClass,
    runtimePlatform: artifact.metadata.runtimePlatform,
    sameOverlayReferenceMaterializationMode: artifact.metadata.sameOverlayReferenceMaterializationMode,
    sameOverlayReferenceMaterializationStorageMode: artifact.metadata.sameOverlayReferenceMaterializationStorageMode,
    sqlitePageSizeBytes: artifact.metadata.sqlitePageSizeBytes,
    sqliteVersion: artifact.metadata.sqliteVersion,
    vectorEnabled: artifact.metadata.vectorEnabled,
  };
  // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
  if (EffectArray.some(Object.values(selected), value => !['boolean', 'number', 'string'].includes(typeof value))) {
    throw ScriptError.make({message: 'Production ratchet artifact metadata is incomplete.'});
  }
  return selected;
}

function productionRatchetGenerationIdentity(artifact: BenchmarkArtifactV1): string {
  const metadata = artifact.metadata;
  const githubHostedStorageAttested = productionRatchetGithubHostedStorageAttested(metadata);
  const minimumFreeBytes = metadata.benchmarkMinimumFreeBytes;
  const primaryAvailableBytes = metadata.benchmarkPrimaryAvailableBytesAtStart;
  const referenceAvailableBytes = metadata.benchmarkReferenceAvailableBytesAtStart;
  if (
    artifact.suite !== 'code-graph-production-large-v2' ||
    artifact.environment.dirty ||
    metadata.benchmarkGoverned !== true ||
    metadata.benchmarkFilesystemsShared !== true ||
    typeof minimumFreeBytes !== 'number' ||
    minimumFreeBytes < productionRatchetMinimumFreeBytes(metadata) ||
    typeof primaryAvailableBytes !== 'number' ||
    primaryAvailableBytes < minimumFreeBytes ||
    typeof referenceAvailableBytes !== 'number' ||
    referenceAvailableBytes < minimumFreeBytes ||
    !productionRatchetStorageGoverned(metadata) ||
    (metadata.runtimePlatform === 'darwin' &&
      (metadata.benchmarkDiskLocation !== 'internal' || metadata.benchmarkReferenceDiskLocation !== 'internal')) ||
    metadata.benchmarkDiskFilesystem !== metadata.benchmarkReferenceDiskFilesystem
  ) {
    throw ScriptError.make({message: 'Production ratchet generation requires complete governed storage evidence.'});
  }
  return JSON.stringify({
    commit: artifact.environment.commit,
    // The reviewed GitHub-hosted runner contract is the storage authority for
    // reduced CI observations. Do not reintroduce unstable guest filesystem
    // hints into cross-run seed identity after excluding them from metadata.
    filesystem: githubHostedStorageAttested ? 'github-hosted-attested' : metadata.benchmarkDiskFilesystem,
    lockfileSha256: metadata.benchmarkMeasuredSourceLockfileSha256,
    minimumFreeBytes,
    packageManifestSha256: metadata.benchmarkMeasuredSourcePackageManifestSha256,
    // Bun's compiled development executable is not reproducible byte-for-byte
    // across clean builds of the same exact source commit. Each observation is
    // still required to carry a separately validated executable and payload
    // digest by assertProductionLargeEvidence above; cross-run identity binds
    // the stable source and release contract instead of requiring those
    // per-build digests to agree.
    releaseMetadataSha256: metadata.benchmarkValidatedManagedReleaseMetadataSha256,
    runtime: metadata.benchmarkValidatedManagedRuntime,
    sourceCommit: metadata.benchmarkMeasuredSourceCommit,
    target: metadata.benchmarkValidatedManagedTarget,
    version: metadata.benchmarkValidatedManagedVersion,
  });
}

function productionRatchetStorageGoverned(metadata: Readonly<Record<string, unknown>>): boolean {
  if (metadata.benchmarkDiskMedium === 'solid-state' && metadata.benchmarkReferenceDiskMedium === 'solid-state') {
    return true;
  }
  return productionRatchetGithubHostedStorageAttested(metadata);
}

function productionRatchetGithubHostedStorageAttested(metadata: Readonly<Record<string, unknown>>): boolean {
  const observedStorageMedium = (value: unknown) =>
    value === 'rotational' || value === 'solid-state' || value === 'unknown' || value === 'virtual-or-network';
  return (
    observedStorageMedium(metadata.benchmarkDiskMedium) &&
    observedStorageMedium(metadata.benchmarkReferenceDiskMedium) &&
    metadata.benchmarkSourceValidationMode === 'github-actions-clean-source' &&
    metadata.benchmarkGithubRunnerEnvironment === 'github-hosted' &&
    (metadata.benchmarkGithubRunnerArchitecture === 'ARM64' || metadata.benchmarkGithubRunnerArchitecture === 'X64') &&
    metadata.benchmarkGithubRunnerOperatingSystem === 'Linux' &&
    metadata.runtimePlatform === 'linux' &&
    ((metadata.benchmarkGithubRunnerArchitecture === 'X64' && metadata.runnerClass === 'github-hosted-linux-x64') ||
      (metadata.benchmarkGithubRunnerArchitecture === 'ARM64' &&
        metadata.runnerClass === 'github-hosted-linux-arm64')) &&
    metadata.vectorEnabled === false &&
    reducedProductionRatchetProfile(metadata.profileSourceFiles, metadata.profileTargetSymbols)
  );
}

function productionRatchetMinimumFreeBytes(metadata: Readonly<Record<string, unknown>>): number {
  return metadata.vectorEnabled === false &&
    reducedProductionRatchetProfile(metadata.profileSourceFiles, metadata.profileTargetSymbols)
    ? PRODUCTION_RATCHET_REDUCED_MINIMUM_FREE_BYTES
    : PRODUCTION_RATCHET_MINIMUM_FREE_BYTES;
}

function reducedProductionRatchetProfile(profileFiles: unknown, profileSymbols: unknown): boolean {
  return (
    typeof profileFiles === 'number' &&
    Number.isSafeInteger(profileFiles) &&
    profileFiles >= 2 &&
    profileFiles <= PRODUCTION_RATCHET_REDUCED_PROFILE_FILES_MAXIMUM &&
    typeof profileSymbols === 'number' &&
    Number.isSafeInteger(profileSymbols) &&
    profileSymbols >= 2 &&
    profileSymbols <= PRODUCTION_RATCHET_REDUCED_PROFILE_SYMBOLS_MAXIMUM
  );
}

function productionMeasurementRatchet(
  name: string,
  unit: BenchmarkMeasurementUnit,
  values: readonly number[],
): CodeGraphBenchmarkMeasurementRatchetV1 {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const base = {samplesMinimum: 1, unit} as const;
  if (productionCoverageMeasurement(name, unit)) {
    // A longer operation legitimately produces more sampler attempts. Coverage
    // is lower-bounded; the separately ratcheted failure counters remain zero.
    return {...base, minimum: 1};
  }
  if (productionNonIncreasingWorkMeasurement(name, unit)) {
    // These counters measure the bounded work needed for the same parity-
    // checked one-file result. Less work is an improvement; retain the
    // observed ceiling without freezing a lower bound that would reject it.
    return {...base, maximum};
  }
  if (productionDeterministicMeasurement(name, unit)) {
    if (minimum !== maximum) {
      throw ScriptError.make({
        message: `Production ratchet deterministic measurement ${name} disagrees across governed observations.`,
      });
    }
    return {...base, maximum, minimum};
  }
  if (unit === 'milliseconds') {
    const objective = PRODUCTION_RATCHET_MILLISECOND_TARGETS.get(name);
    const detailedTiming = Effect2.pipe(name, EffectString.endsWith('-n1')) && objective === undefined;
    const coldRegistration = name === 'cold-registration-lock-and-database-setup';
    const sameOverlayRegistration = name === 'same-overlay-reference-registration-lock-and-database-setup';
    const relativeHeadroom = coldRegistration
      ? PRODUCTION_RATCHET_COLD_REGISTRATION_RELATIVE_HEADROOM
      : sameOverlayRegistration
        ? PRODUCTION_RATCHET_SAME_OVERLAY_REGISTRATION_RELATIVE_HEADROOM
        : detailedTiming
          ? PRODUCTION_RATCHET_DETAILED_MILLISECOND_RELATIVE_HEADROOM
          : PRODUCTION_RATCHET_RELATIVE_HEADROOM;
    const absoluteHeadroom = detailedTiming
      ? PRODUCTION_RATCHET_DETAILED_MILLISECOND_NOISE_HEADROOM
      : PRODUCTION_RATCHET_MILLISECOND_NOISE_HEADROOM;
    const observedLimit =
      maximum === 0
        ? absoluteHeadroom
        : Math.ceil(Math.max(maximum * (1 + relativeHeadroom), maximum + absoluteHeadroom));
    if (objective !== undefined && maximum > objective) {
      throw ScriptError.make({message: `Production ratchet objective ${name} has not been attained.`});
    }
    return {
      ...base,
      p95Maximum: Math.min(observedLimit, objective ?? Number.MAX_SAFE_INTEGER),
    };
  }
  if (unit === 'bytes') {
    return {
      ...base,
      p95Maximum: Math.max(
        PRODUCTION_RATCHET_BYTE_NOISE_HEADROOM,
        Math.ceil(maximum * (1 + PRODUCTION_RATCHET_RELATIVE_HEADROOM)),
      ),
    };
  }
  if (unit === 'operations_per_second') {
    return {...base, minimum: Math.floor(minimum * (1 - PRODUCTION_RATCHET_RELATIVE_HEADROOM) * 1_000) / 1_000};
  }
  if (unit === 'percent') return {...base, minimum};
  return {...base, maximum: Math.ceil(maximum * (1 + PRODUCTION_RATCHET_RELATIVE_HEADROOM))};
}

function productionNonIncreasingWorkMeasurement(name: string, unit: BenchmarkMeasurementUnit): boolean {
  return (
    unit === 'count' &&
    /^one-file-reindex-incremental-work-(?:attribution-context-files|base-facts-loaded|inventory-files-inspected|planned-rows|probed-dependency-paths)-n1$/u.test(
      name,
    )
  );
}

function productionCoverageMeasurement(name: string, unit: BenchmarkMeasurementUnit): boolean {
  return (
    unit === 'count' &&
    (Effect2.pipe(name, EffectString.endsWith('-attempts-n1')) ||
      Effect2.pipe(name, EffectString.endsWith('-samples-n1')))
  );
}

function productionDeterministicMeasurement(name: string, unit: BenchmarkMeasurementUnit): boolean {
  if (unit !== 'count') return false;
  return (
    Effect2.pipe(name, EffectString.includes('-parity')) ||
    Effect2.pipe(name, EffectString.includes('-returned-')) ||
    Effect2.pipe(name, EffectString.includes('-incremental-work-')) ||
    Effect2.pipe(name, EffectString.includes('-materialized-')) ||
    Effect2.pipe(name, EffectString.includes('-rows')) ||
    (Effect2.pipe(name, EffectString.includes('-activation-')) &&
      Effect2.pipe(name, EffectString.endsWith('-observed-n1'))) ||
    Effect2.pipe(name, EffectString.endsWith('-sampler-version-n1')) ||
    Effect2.pipe(name, EffectString.endsWith('-staged-files')) ||
    Effect2.pipe(name, EffectString.endsWith('-total-files')) ||
    Effect2.pipe(name, EffectString.endsWith('-vector-enabled')) ||
    /-(?:edges|files|packages|relations|symbols|terms|workspaces)(?:-n1)?$/u.test(name)
  );
}

/**
 * Enforces independent bounds for every measurement named by a reviewed
 * ratchet. Conditions bind the limits to one suite, fixture, and runner class;
 * unrelated or partial artifacts fail closed instead of silently skipping a
 * threshold.
 */
export function enforceCodeGraphBenchmarkRatchet(
  artifact: BenchmarkArtifactV1,
  value: unknown,
  pairedControl?: CodeGraphBenchmarkRatchetPairedControl,
): void {
  const ratchet = parseCodeGraphBenchmarkRatchet(value);
  const failures: string[] = [];
  if (artifact.suite !== ratchet.suite) {
    failures.push(`suite ${JSON.stringify(artifact.suite)} does not match ${JSON.stringify(ratchet.suite)}`);
  }
  for (const [name, expected] of EffectRecord.toEntries(ratchet.environment).sort(([left], [right]) =>
    Effect2.pipe(left, EffectString.localeCompare(right)),
  )) {
    const actual = Reflect.get(artifact.environment, name);
    if (actual !== expected) {
      failures.push(`environment.${name} ${formatRatchetValue(actual)} does not match ${formatRatchetValue(expected)}`);
    }
  }
  for (const [name, expected] of EffectRecord.toEntries(ratchet.metadata).sort(([left], [right]) =>
    Effect2.pipe(left, EffectString.localeCompare(right)),
  )) {
    const actual = artifact.metadata[name];
    if (actual !== expected) {
      failures.push(`metadata.${name} ${formatRatchetValue(actual)} does not match ${formatRatchetValue(expected)}`);
    }
  }
  if (ratchet.suite === 'code-graph-production-large-v2') {
    const assessedNames = EffectArray.map(
      productionRatchetMeasurements(artifact),
      measurement => measurement.name,
    ).sort();
    const ratchetedNames = EffectRecord.keys(ratchet.measurements).sort();
    if (JSON.stringify(assessedNames) !== JSON.stringify(ratchetedNames)) {
      const assessed = new Set(assessedNames);
      const ratcheted = new Set(ratchetedNames);
      const missing = EffectArray.filter(ratchetedNames, name => !assessed.has(name));
      const ungoverned = EffectArray.filter(assessedNames, name => !ratcheted.has(name));
      failures.push(
        `stable production measurement set changed` +
          `${missing.length > 0 ? `; missing: ${EffectArray.join(missing, ', ')}` : ''}` +
          `${ungoverned.length > 0 ? `; ungoverned: ${EffectArray.join(ungoverned, ', ')}` : ''}`,
      );
    }
  }
  const measurementsByName = benchmarkMeasurementsByName(artifact);
  const pairedEvidence = pairedControl
    ? prepareCodeGraphBenchmarkRatchetPairedControl(artifact, pairedControl, ratchet, failures)
    : undefined;
  let confirmatoryWallTailAcceptedName: string | undefined;
  for (const [name, limit] of EffectRecord.toEntries(ratchet.measurements).sort(([left], [right]) =>
    Effect2.pipe(left, EffectString.localeCompare(right)),
  )) {
    const matches = measurementsByName.get(name) ?? [];
    if (matches.length === 0) {
      failures.push(`${name} measurement is missing`);
      continue;
    }
    if (matches.length !== 1) {
      failures.push(`${name} measurement occurs ${matches.length} times instead of exactly once`);
      continue;
    }
    const measurement = matches[0];
    if (measurement.unit !== limit.unit) {
      failures.push(`${name} unit ${measurement.unit} does not match ${limit.unit}`);
      continue;
    }
    const staticFailures = codeGraphBenchmarkMeasurementRatchetFailures(name, measurement, limit);
    if (!pairedEvidence) {
      failures.push(...staticFailures);
      continue;
    }
    const initialMatches = pairedEvidence.initialCandidateMeasurementsByName.get(name) ?? [];
    if (initialMatches.length !== 1) {
      failures.push(
        `initial candidate ${name} measurement occurs ${initialMatches.length} times instead of exactly once`,
      );
      continue;
    }
    const initialMeasurement = initialMatches[0];
    if (initialMeasurement.unit !== measurement.unit || initialMeasurement.samples !== measurement.samples) {
      failures.push(`initial candidate ${name} unit or sample count does not match the remeasured candidate`);
      continue;
    }
    const initialStaticFailures = codeGraphBenchmarkMeasurementRatchetFailures(name, initialMeasurement, limit);
    const appendCandidateStaticFailures = () => {
      failures.push(...EffectArray.map(initialStaticFailures, failure => `initial candidate ${failure}`));
      failures.push(...EffectArray.map(staticFailures, failure => `remeasured candidate ${failure}`));
    };
    const hardObjective = PRODUCTION_RATCHET_MILLISECOND_TARGETS.get(name);
    if (staticFailures.length === 0 && initialStaticFailures.length === 0 && hardObjective === undefined) continue;
    const controlMatches = pairedEvidence.controlMeasurementsByName.get(name) ?? [];
    if (controlMatches.length !== 1) {
      failures.push(`paired control ${name} measurement occurs ${controlMatches.length} times instead of exactly once`);
      continue;
    }
    const controlMeasurement = controlMatches[0];
    if (controlMeasurement.unit !== measurement.unit || controlMeasurement.samples !== measurement.samples) {
      failures.push(`paired control ${name} unit or sample count does not match both candidates`);
      continue;
    }
    if (
      productionScreeningBootstrapProcessCountAccepted(
        name,
        initialMeasurement,
        controlMeasurement,
        limit,
        initialStaticFailures,
        staticFailures,
      )
    ) {
      continue;
    }
    if (hardObjective !== undefined) {
      const objectiveFailures = [
        ['initial candidate', initialMeasurement],
        ['paired control', controlMeasurement],
        ['remeasured candidate', measurement],
      ] as const;
      let objectiveFailed = false;
      for (const [label, candidate] of objectiveFailures) {
        if (candidate.p95 <= hardObjective) continue;
        objectiveFailed = true;
        failures.push(
          `${label} production ratchet objective ${name} has not been attained: p95 ${candidate.p95} exceeds ${hardObjective}`,
        );
      }
      if (objectiveFailed) continue;
      if (staticFailures.length === 0 && initialStaticFailures.length === 0) continue;
    }
    if (
      !productionHostSensitiveWallMeasurement(name, limit) ||
      limit.p95Maximum === undefined ||
      !candidateHasOnlyStaticP95Failure(initialMeasurement, limit, initialStaticFailures) ||
      !candidateHasOnlyStaticP95Failure(measurement, limit, staticFailures)
    ) {
      appendCandidateStaticFailures();
      continue;
    }
    if (controlMeasurement.p95 <= limit.p95Maximum) {
      const confirmatoryAcceptance = productionConfirmatoryWallP95Acceptance(
        name,
        measurement,
        limit,
        initialStaticFailures,
        staticFailures,
      );
      if (confirmatoryAcceptance === 'screening-cleared') {
        continue;
      }
      if (confirmatoryAcceptance === 'bounded-confirmatory-tail') {
        if (confirmatoryWallTailAcceptedName === undefined) {
          confirmatoryWallTailAcceptedName = name;
          continue;
        }
        appendCandidateStaticFailures();
        failures.push(
          `confirmatory wall tail tolerance is singular, but both ${confirmatoryWallTailAcceptedName} and ${name} require it`,
        );
        continue;
      }
      appendCandidateStaticFailures();
      continue;
    }
    const lowerCandidateP95 = Math.min(initialMeasurement.p95, measurement.p95);
    const upperCandidateP95 = Math.max(initialMeasurement.p95, measurement.p95);
    let dispersionLimit: CodeGraphBenchmarkMeasurementRatchetV1;
    try {
      dispersionLimit = productionMeasurementRatchet(name, measurement.unit, [lowerCandidateP95]);
    } catch (error) {
      failures.push(
        `candidate sandwich ${name} dispersion is not admissible: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const dispersionFailures = codeGraphBenchmarkMeasurementRatchetFailures(
      name,
      benchmarkMeasurement(name, measurement.unit, [upperCandidateP95]),
      dispersionLimit,
    );
    if (dispersionFailures.length > 0) {
      failures.push(...EffectArray.map(dispersionFailures, failure => `candidate sandwich dispersion ${failure}`));
      continue;
    }
    const sandwichP95 =
      initialMeasurement.p95 + (measurement.p95 - initialMeasurement.p95) * pairedEvidence.candidateInterpolationWeight;
    let pairedLimit: CodeGraphBenchmarkMeasurementRatchetV1;
    try {
      pairedLimit = productionMeasurementRatchet(name, measurement.unit, [controlMeasurement.p95]);
    } catch (error) {
      failures.push(
        `paired control ${name} is not admissible: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    failures.push(
      ...EffectArray.map(
        codeGraphBenchmarkMeasurementRatchetFailures(
          name,
          benchmarkMeasurement(name, measurement.unit, [sandwichP95]),
          pairedLimit,
        ),
        failure => `${failure} for the bounded candidate sandwich against the exact protected-base control`,
      ),
    );
  }
  if (failures.length > 0) {
    throw ScriptError.make({message: `Code graph performance ratchet failed: ${EffectArray.join(failures, '; ')}`});
  }
}

const PRODUCTION_PAIRED_WALL_MEASUREMENT_PATTERNS = [
  /^(?:cold|one-file-reindex|same-overlay-full-rebuild)-index$/u,
  /^(?:cold|one-file-reindex|same-overlay-reference)-(?:activation-(?:and-vectors|lexical-only)|inventory-and-extraction|materialization|maximum-progress-heartbeat-gap-n1|post-committed-scan-overlay-and-workspace|pre-activation|pre-activation-validation|reference-resolution|registration-lock-and-database-setup|resolved-fact-accounting|snapshot-promotion|snapshot-write-and-checkpoint|vector-index)$/u,
  /^(?:cold|one-file-reindex|same-overlay-reference)-activation-(?:checkpointing-snapshot|committing-snapshot|copying-(?:edges|files|lookup-keys|reexports|symbols|terms|workspace)|recording-completion|validating-input)-duration-n1$/u,
  /^(?:cold|one-file-reindex|same-overlay-reference)-(?:activation|reference-resolution)-longest-transaction-n1$/u,
  /^(?:cold|one-file-reindex|same-overlay-reference)-(?:inventory-cache-persistence|materialization-stage-committing)-n1$/u,
  /^(?:first-repository-status-read|hot-build-sidecar-status-read|hot-deferred-ready-query-orchestration|hot-exact-lexical-query|hot-exact-ready-query-orchestration|hot-repository-status-read|whole-graph-structural-analysis)$/u,
  /^mcp-(?:explain|impact|neighbors|node|path|query)-duration$/u,
] as const;

function productionHostSensitiveWallMeasurement(name: string, limit: CodeGraphBenchmarkMeasurementRatchetV1): boolean {
  return (
    limit.unit === 'milliseconds' &&
    limit.samplesMinimum === 1 &&
    limit.p95Maximum !== undefined &&
    // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
    EffectArray.every(Object.keys(limit), key => key === 'p95Maximum' || key === 'samplesMinimum' || key === 'unit') &&
    // Default every new millisecond metric to the static ratchet. Only
    // explicitly reviewed elapsed intervals may use a same-runner control;
    // cumulative parser, serialization, transaction, and general stage or
    // subphase work timers deliberately do not match this allowlist. The two
    // named persistence/commit splits above are synchronous hosted-storage
    // wall waits; independently ratcheted CPU, row/work, and byte/storage
    // measurements continue to govern the amount of work they perform.
    EffectArray.some(PRODUCTION_PAIRED_WALL_MEASUREMENT_PATTERNS, pattern => pattern.test(name))
  );
}

function candidateHasOnlyStaticP95Failure(
  measurement: BenchmarkArtifactV1['measurements'][number],
  limit: CodeGraphBenchmarkMeasurementRatchetV1,
  staticFailures: readonly string[],
): boolean {
  return (
    staticFailures.length === 0 ||
    (limit.p95Maximum !== undefined &&
      measurement.p95 > limit.p95Maximum &&
      (limit.samplesMinimum === undefined || measurement.samples >= limit.samplesMinimum) &&
      staticFailures.length === 1)
  );
}

function productionScreeningBootstrapProcessCountAccepted(
  name: string,
  initialCandidate: BenchmarkArtifactV1['measurements'][number],
  control: BenchmarkArtifactV1['measurements'][number],
  limit: CodeGraphBenchmarkMeasurementRatchetV1,
  initialStaticFailures: readonly string[],
  remeasuredStaticFailures: readonly string[],
): boolean {
  if (
    name !== PRODUCTION_RATCHET_SCREENING_BOOTSTRAP_PROCESS_COUNT ||
    limit.unit !== 'count' ||
    limit.maximum !== PRODUCTION_RATCHET_SCREENING_BOOTSTRAP_PROCESS_COUNT_MAXIMUM ||
    limit.samplesMinimum !== 1 ||
    // oxlint-disable-next-line effecttsgo/prefer-effect-record -- This value is not a total homogeneous readonly record accepted by Effect Record.
    !EffectArray.every(Object.keys(limit), key => key === 'maximum' || key === 'samplesMinimum' || key === 'unit') ||
    initialStaticFailures.length !== 1 ||
    remeasuredStaticFailures.length !== 0 ||
    initialCandidate.samples < limit.samplesMinimum ||
    initialCandidate.maximum !== limit.maximum + PRODUCTION_RATCHET_SCREENING_BOOTSTRAP_PROCESS_COUNT_TOLERANCE
  ) {
    return false;
  }
  return codeGraphBenchmarkMeasurementRatchetFailures(name, control, limit).length === 0;
}

function productionConfirmatoryWallP95Acceptance(
  name: string,
  remeasuredCandidate: BenchmarkArtifactV1['measurements'][number],
  limit: CodeGraphBenchmarkMeasurementRatchetV1,
  initialStaticFailures: readonly string[],
  remeasuredStaticFailures: readonly string[],
): 'bounded-confirmatory-tail' | 'screening-cleared' | undefined {
  // The screening observation exists to trigger this sequence. A passing
  // protected-base control followed by a passing confirmatory candidate is
  // sufficient to clear an initial wall-only static miss. The caller has
  // already enforced every hard objective on all three observations; having
  // an objective does not make a stricter static screening limit an objective.
  if (remeasuredStaticFailures.length === 0) return 'screening-cleared';
  // Objective-bearing metrics never receive confirmatory tail tolerance.
  if (PRODUCTION_RATCHET_MILLISECOND_TARGETS.has(name)) return undefined;
  if (initialStaticFailures.length !== 0 || limit.p95Maximum === undefined) return undefined;
  const tolerance = Math.min(
    limit.p95Maximum * PRODUCTION_RATCHET_CONFIRMATORY_WALL_TAIL_RELATIVE_TOLERANCE,
    PRODUCTION_RATCHET_CONFIRMATORY_WALL_TAIL_ABSOLUTE_TOLERANCE_MILLISECONDS,
  );
  return remeasuredCandidate.p95 <= limit.p95Maximum + tolerance ? 'bounded-confirmatory-tail' : undefined;
}

function benchmarkMeasurementsByName(
  artifact: BenchmarkArtifactV1,
): ReadonlyMap<string, BenchmarkArtifactV1['measurements'][number][]> {
  const measurementsByName = new Map<string, BenchmarkArtifactV1['measurements'][number][]>();
  for (const measurement of artifact.measurements) {
    const matches = measurementsByName.get(measurement.name) ?? [];
    matches.push(measurement);
    measurementsByName.set(measurement.name, matches);
  }
  return measurementsByName;
}

function codeGraphBenchmarkMeasurementRatchetFailures(
  name: string,
  measurement: BenchmarkArtifactV1['measurements'][number],
  limit: CodeGraphBenchmarkMeasurementRatchetV1,
): readonly string[] {
  const failures: string[] = [];
  if (limit.samplesMinimum !== undefined && measurement.samples < limit.samplesMinimum) {
    failures.push(`${name} has ${measurement.samples} samples, below ${limit.samplesMinimum}`);
  }
  if (limit.maximum !== undefined && measurement.maximum > limit.maximum) {
    failures.push(`${name} maximum ${measurement.maximum} exceeds ${limit.maximum}`);
  }
  if (limit.meanMaximum !== undefined && measurement.mean > limit.meanMaximum) {
    failures.push(`${name} mean ${measurement.mean} exceeds ${limit.meanMaximum}`);
  }
  if (limit.p50Maximum !== undefined && measurement.p50 > limit.p50Maximum) {
    failures.push(`${name} p50 ${measurement.p50} exceeds ${limit.p50Maximum}`);
  }
  if (limit.p95Maximum !== undefined && measurement.p95 > limit.p95Maximum) {
    failures.push(`${name} p95 ${measurement.p95} exceeds ${limit.p95Maximum}`);
  }
  if (limit.p99Maximum !== undefined && measurement.p99 > limit.p99Maximum) {
    failures.push(`${name} p99 ${measurement.p99} exceeds ${limit.p99Maximum}`);
  }
  if (limit.minimum !== undefined && measurement.minimum < limit.minimum) {
    failures.push(`${name} minimum ${measurement.minimum} is below ${limit.minimum}`);
  }
  return failures;
}

function prepareCodeGraphBenchmarkRatchetPairedControl(
  artifact: BenchmarkArtifactV1,
  pairedControl: CodeGraphBenchmarkRatchetPairedControl,
  ratchet: CodeGraphBenchmarkRatchetV1,
  failures: string[],
): PreparedCodeGraphBenchmarkRatchetSandwich | undefined {
  if (!EXACT_GIT_COMMIT_PATTERN.test(pairedControl.expectedCandidateCommit)) {
    failures.push('paired candidate expected commit is not an exact Git commit');
    return undefined;
  }
  if (!EXACT_GIT_COMMIT_PATTERN.test(pairedControl.expectedCommit)) {
    failures.push('paired control expected commit is not an exact Git commit');
    return undefined;
  }
  assertProductionLargeEvidence(artifact);
  const control = parseBenchmarkArtifactV1(pairedControl.artifact);
  const initialCandidate = parseBenchmarkArtifactV1(pairedControl.initialCandidateArtifact);
  assertProductionLargeEvidence(control);
  assertProductionLargeEvidence(initialCandidate);
  if (artifact.environment.commit !== pairedControl.expectedCandidateCommit) {
    failures.push(
      `paired candidate commit ${JSON.stringify(artifact.environment.commit)} does not match ` +
        JSON.stringify(pairedControl.expectedCandidateCommit),
    );
  }
  if (initialCandidate.environment.commit !== pairedControl.expectedCandidateCommit) {
    failures.push(
      `initial candidate commit ${JSON.stringify(initialCandidate.environment.commit)} does not match ` +
        JSON.stringify(pairedControl.expectedCandidateCommit),
    );
  }
  if (control.environment.commit !== pairedControl.expectedCommit) {
    failures.push(
      `paired control commit ${JSON.stringify(control.environment.commit)} does not match ` +
        JSON.stringify(pairedControl.expectedCommit),
    );
  }
  if (control.environment.commit === artifact.environment.commit) {
    failures.push('paired control must use a different protected-base commit');
  }
  if (
    control.suite !== ratchet.suite ||
    control.suite !== artifact.suite ||
    initialCandidate.suite !== artifact.suite
  ) {
    failures.push('paired sandwich suite does not match both candidates, the control, and reviewed ratchet');
  }
  for (const [name, expected] of EffectRecord.toEntries(ratchet.environment)) {
    for (const [label, candidate] of [
      ['paired control', control],
      ['initial candidate', initialCandidate],
    ] as const) {
      const actual = Reflect.get(candidate.environment, name);
      if (actual !== expected) {
        failures.push(
          `${label} environment.${name} ${formatRatchetValue(actual)} does not match ` + formatRatchetValue(expected),
        );
      }
    }
  }
  for (const name of ['sameRunnerComparisonKey', 'runnerIdentity'] as const) {
    for (const [label, candidate] of [
      ['paired control', control],
      ['initial candidate', initialCandidate],
    ] as const) {
      if (
        typeof candidate.metadata[name] !== 'string' ||
        candidate.metadata[name] !== artifact.metadata[name] ||
        candidate.metadata[name].length === 0
      ) {
        failures.push(`${label} metadata.${name} does not match the remeasured candidate`);
      }
    }
  }
  if (JSON.stringify(productionRatchetMetadata(control)) !== JSON.stringify(productionRatchetMetadata(artifact))) {
    failures.push('paired control does not share the candidate fixture, output, runtime, and storage contract');
  }
  if (
    JSON.stringify(productionRatchetMetadata(initialCandidate)) !== JSON.stringify(productionRatchetMetadata(artifact))
  ) {
    failures.push(
      'initial candidate does not share the remeasured candidate fixture, output, runtime, and storage contract',
    );
  }
  const controlNames = EffectArray.map(productionRatchetMeasurements(control), measurement => measurement.name).sort();
  const candidateNames = EffectArray.map(
    productionRatchetMeasurements(artifact),
    measurement => measurement.name,
  ).sort();
  const initialCandidateNames = EffectArray.map(
    productionRatchetMeasurements(initialCandidate),
    measurement => measurement.name,
  ).sort();
  if (JSON.stringify(controlNames) !== JSON.stringify(candidateNames)) {
    failures.push('paired control assessed measurement set does not match the candidate');
  }
  if (JSON.stringify(initialCandidateNames) !== JSON.stringify(candidateNames)) {
    failures.push('initial candidate assessed measurement set does not match the remeasured candidate');
  }
  const initialCandidateTime = Date.parse(initialCandidate.createdAt);
  const controlTime = Date.parse(control.createdAt);
  const remeasuredCandidateTime = Date.parse(artifact.createdAt);
  if (
    !Number.isFinite(initialCandidateTime) ||
    !Number.isFinite(controlTime) ||
    !Number.isFinite(remeasuredCandidateTime) ||
    initialCandidateTime >= controlTime ||
    controlTime >= remeasuredCandidateTime ||
    remeasuredCandidateTime - initialCandidateTime > PRODUCTION_RATCHET_SANDWICH_MAXIMUM_SPAN_MILLISECONDS
  ) {
    failures.push(
      'paired sandwich creation times must be strictly ordered candidate-control-candidate within 40 minutes',
    );
  }
  if (failures.length > 0) return undefined;
  return {
    candidateInterpolationWeight:
      (controlTime - initialCandidateTime) / (remeasuredCandidateTime - initialCandidateTime),
    controlMeasurementsByName: benchmarkMeasurementsByName(control),
    initialCandidateMeasurementsByName: benchmarkMeasurementsByName(initialCandidate),
  };
}

export function validateCodeGraphBenchmarkRatchet(value: unknown): void {
  parseCodeGraphBenchmarkRatchet(value);
}

function parseCodeGraphBenchmarkRatchet(value: unknown): CodeGraphBenchmarkRatchetV1 {
  const ratchet = ratchetRecord(value, 'Code graph performance ratchet');
  rejectRatchetUnknownKeys(ratchet, ['environment', 'measurements', 'metadata', 'suite', 'version'], 'ratchet');
  if (ratchet.version !== 1) throw ScriptError.make({message: 'Code graph performance ratchet version must be 1.'});
  if (typeof ratchet.suite !== 'string' || Effect2.pipe(ratchet.suite, EffectString.trim).length === 0) {
    throw ScriptError.make({message: 'Code graph performance ratchet suite must be a non-empty string.'});
  }
  const measurements = ratchetRecord(ratchet.measurements, 'Code graph performance ratchet measurements');
  const measurementEntries = EffectRecord.toEntries(measurements);
  if (measurementEntries.length === 0) {
    throw ScriptError.make({message: 'Code graph performance ratchet must constrain at least one measurement.'});
  }
  const parsedMeasurementEntries: [string, CodeGraphBenchmarkMeasurementRatchetV1][] = [];
  for (const [name, rawLimit] of measurementEntries.sort(([left], [right]) =>
    Effect2.pipe(left, EffectString.localeCompare(right)),
  )) {
    if (Effect2.pipe(name, EffectString.trim).length === 0) {
      throw ScriptError.make({message: 'Code graph performance ratchet measurement names must be non-empty.'});
    }
    const limit = ratchetRecord(rawLimit, `Code graph performance ratchet measurement ${name}`);
    rejectRatchetUnknownKeys(
      limit,
      ['maximum', 'meanMaximum', 'minimum', 'p50Maximum', 'p95Maximum', 'p99Maximum', 'samplesMinimum', 'unit'],
      `measurement ${name}`,
    );
    const unit = Schema.decodeUnknownSync(
      Schema.Literals(['bytes', 'count', 'milliseconds', 'operations_per_second', 'percent']),
    )(limit.unit);
    const minimum = optionalRatchetThreshold(limit.minimum, name, 'minimum');
    const maximum = optionalRatchetThreshold(limit.maximum, name, 'maximum');
    const meanMaximum = optionalRatchetThreshold(limit.meanMaximum, name, 'meanMaximum');
    const p50Maximum = optionalRatchetThreshold(limit.p50Maximum, name, 'p50Maximum');
    const p95Maximum = optionalRatchetThreshold(limit.p95Maximum, name, 'p95Maximum');
    const p99Maximum = optionalRatchetThreshold(limit.p99Maximum, name, 'p99Maximum');
    if (
      minimum === undefined &&
      maximum === undefined &&
      meanMaximum === undefined &&
      p50Maximum === undefined &&
      p95Maximum === undefined &&
      p99Maximum === undefined
    ) {
      throw ScriptError.make({
        message: `Code graph performance ratchet measurement ${name} requires at least one bound.`,
      });
    }
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw ScriptError.make({
        message: `Code graph performance ratchet measurement ${name} has minimum above maximum.`,
      });
    }
    const samplesMinimum = limit.samplesMinimum;
    if (
      samplesMinimum !== undefined &&
      (typeof samplesMinimum !== 'number' || !Number.isSafeInteger(samplesMinimum) || samplesMinimum < 1)
    ) {
      throw ScriptError.make({
        message: `Code graph performance ratchet measurement ${name} samplesMinimum must be a positive integer.`,
      });
    }
    parsedMeasurementEntries.push([
      name,
      {
        ...(maximum === undefined ? {} : {maximum}),
        ...(meanMaximum === undefined ? {} : {meanMaximum}),
        ...(minimum === undefined ? {} : {minimum}),
        ...(p50Maximum === undefined ? {} : {p50Maximum}),
        ...(p95Maximum === undefined ? {} : {p95Maximum}),
        ...(p99Maximum === undefined ? {} : {p99Maximum}),
        ...(samplesMinimum === undefined ? {} : {samplesMinimum}),
        unit,
      },
    ]);
  }
  const environment = parseRatchetConditions(ratchet.environment, 'environment');
  const metadata = parseRatchetConditions(ratchet.metadata, 'metadata');
  requireRatchetConditionKeys(environment, ['fixtureHash', 'node', 'runner', 'runnerVersion'], 'environment');
  requireRatchetConditionKeys(metadata, ['runnerClass', 'runtimePlatform', 'vectorEnabled'], 'metadata');
  return {
    environment,
    measurements: EffectRecord.fromEntries(parsedMeasurementEntries),
    metadata,
    suite: ratchet.suite,
    version: 1,
  };
}

function parseRatchetConditions(
  value: unknown,
  label: 'environment' | 'metadata',
): Readonly<Record<string, BenchmarkRatchetPrimitive>> {
  if (value === undefined) return {};
  const conditions = ratchetRecord(value, `Code graph performance ratchet ${label}`);
  const parsedEntries: [string, BenchmarkRatchetPrimitive][] = [];
  for (const [name, expected] of EffectRecord.toEntries(conditions).sort(([left], [right]) =>
    Effect2.pipe(left, EffectString.localeCompare(right)),
  )) {
    if (
      Effect2.pipe(name, EffectString.trim).length === 0 ||
      (typeof expected !== 'boolean' && typeof expected !== 'string' && typeof expected !== 'number') ||
      (typeof expected === 'number' && !Number.isFinite(expected))
    ) {
      throw ScriptError.make({
        message: `Code graph performance ratchet ${label}.${name || '<empty>'} must be a finite primitive.`,
      });
    }
    parsedEntries.push([name, expected]);
  }
  return EffectRecord.fromEntries(parsedEntries);
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function ratchetRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isUnknownRecord(value)) {
    throw ScriptError.make({message: `${label} must be an object.`});
  }
  return value;
}

function requireRatchetConditionKeys(
  conditions: Readonly<Record<string, BenchmarkRatchetPrimitive>>,
  required: readonly string[],
  label: 'environment' | 'metadata',
): void {
  const missing = EffectArray.filter(required, name => !(name in conditions));
  if (missing.length > 0) {
    throw ScriptError.make({
      message: `Code graph performance ratchet ${label} is missing condition(s): ${EffectArray.join(missing, ', ')}.`,
    });
  }
}

function rejectRatchetUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = EffectArray.filter(EffectRecord.keys(value), key => !allowed.includes(key)).sort();
  if (unknown.length > 0) {
    throw ScriptError.make({
      message: `Code graph performance ${label} has unknown field(s): ${EffectArray.join(unknown, ', ')}.`,
    });
  }
}

function optionalRatchetThreshold(
  value: unknown,
  name: string,
  bound: 'maximum' | 'meanMaximum' | 'minimum' | 'p50Maximum' | 'p95Maximum' | 'p99Maximum',
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw ScriptError.make({
      message: `Code graph performance ratchet measurement ${name} ${bound} must be non-negative finite.`,
    });
  }
  return value;
}

function formatRatchetValue(value: unknown): string {
  return value === undefined ? '<missing>' : JSON.stringify(value);
}

const CODE_GRAPH_HOT_QUERY_WALL_P95_TOLERANCE_RATIO_MAXIMUM = 0.05;
const CODE_GRAPH_HOT_QUERY_WALL_P50_TOLERANCE_RATIO_MAXIMUM = 0.05;
const CODE_GRAPH_HOT_QUERY_WALL_TOLERANCE_SAMPLES_MINIMUM = 25;

export function enforceCodeGraphBenchmarkBudget(
  artifact: BenchmarkArtifactV1,
  value: unknown,
  scaleSymbols: number | undefined,
): void {
  if (typeof value !== 'object' || value === null)
    throw ScriptError.make({message: 'Code graph budget file must be an object.'});
  const record = ratchetRecord(value, 'Code graph budget file');
  const vectorScalePerformance = record.vectorScalePerformance;
  const scalePerformance = record.scalePerformance;
  const developmentByPlatform = record.developmentPerformanceByPlatform;
  const developmentByRunnerClass = record.developmentPerformanceByRunnerClass;
  const scaleByRunnerClass = record.scalePerformanceByRunnerClass;
  const baseSelected =
    artifact.metadata.vectorEnabled === true
      ? scaleSymbols === undefined
        ? record.vectorPerformance
        : isUnknownRecord(vectorScalePerformance)
          ? vectorScalePerformance[String(scaleSymbols)]
          : undefined
      : scaleSymbols === undefined
        ? record.developmentPerformance
        : isUnknownRecord(scalePerformance)
          ? scalePerformance[String(scaleSymbols)]
          : undefined;
  const runtimePlatform = artifact.metadata.runtimePlatform;
  const runnerClass = artifact.metadata.runnerClass;
  const platformOverride =
    artifact.metadata.vectorEnabled !== true &&
    scaleSymbols === undefined &&
    typeof runtimePlatform === 'string' &&
    isUnknownRecord(developmentByPlatform) &&
    typeof developmentByPlatform[runtimePlatform] === 'object' &&
    developmentByPlatform[runtimePlatform] !== null
      ? developmentByPlatform[runtimePlatform]
      : undefined;
  const runnerDevelopmentOverride =
    artifact.metadata.vectorEnabled !== true &&
    scaleSymbols === undefined &&
    typeof runnerClass === 'string' &&
    benchmarkRunnerClassMatchesArtifact(runnerClass, runtimePlatform, artifact.environment.architecture) &&
    isUnknownRecord(developmentByRunnerClass) &&
    typeof developmentByRunnerClass[runnerClass] === 'object' &&
    developmentByRunnerClass[runnerClass] !== null
      ? developmentByRunnerClass[runnerClass]
      : undefined;
  const runnerScalePerformance =
    typeof runnerClass === 'string' && isUnknownRecord(scaleByRunnerClass)
      ? scaleByRunnerClass[runnerClass]
      : undefined;
  const runnerScaleOverride =
    artifact.metadata.vectorEnabled !== true &&
    scaleSymbols !== undefined &&
    typeof runnerClass === 'string' &&
    benchmarkRunnerClassMatchesArtifact(runnerClass, runtimePlatform, artifact.environment.architecture) &&
    isUnknownRecord(runnerScalePerformance) &&
    typeof runnerScalePerformance[String(scaleSymbols)] === 'object' &&
    runnerScalePerformance[String(scaleSymbols)] !== null
      ? runnerScalePerformance[String(scaleSymbols)]
      : undefined;
  const selected =
    typeof baseSelected === 'object' && baseSelected !== null
      ? {
          ...baseSelected,
          ...(platformOverride ?? {}),
          ...(runnerDevelopmentOverride ?? {}),
          ...(runnerScaleOverride ?? {}),
        }
      : baseSelected;
  if (typeof selected !== 'object' || selected === null) {
    throw ScriptError.make({
      message:
        `No reviewed ${artifact.metadata.vectorEnabled === true ? 'vector ' : ''}code graph performance budget exists ` +
        `for ${scaleSymbols ?? 'development'}.`,
    });
  }
  const budget = ratchetRecord(selected, 'Selected code graph budget');
  const hotQueryName =
    artifact.metadata.vectorEnabled === true ? 'hot-semantic-vector-query' : 'hot-exact-lexical-query';
  const checks = [
    ['cold-index', 'coldIndexP95MillisecondsMaximum'],
    ['cold-materialization', 'coldMaterializationP95MillisecondsMaximum'],
    ['one-file-reindex-index', 'oneFileIncrementalP95MillisecondsMaximum'],
    ['one-file-reindex-materialization', 'oneFileMaterializationP95MillisecondsMaximum'],
    ['whole-graph-structural-analysis', 'wholeGraphAnalysisP95MillisecondsMaximum'],
    ['incremental-process-peak-rss', 'processPeakRssBytesMaximum'],
    ['derived-index-disk', 'derivedIndexBytesMaximum'],
  ] as const;
  const failures: string[] = [];
  for (const [measurementName, budgetName] of checks) {
    const measurement = Option.getOrUndefined(
      EffectArray.findFirst(artifact.measurements, candidate => candidate.name === measurementName),
    );
    const maximum = budget[budgetName];
    if (!measurement) {
      failures.push(`missing ${measurementName} measurement`);
    } else if (typeof maximum !== 'number' || !Number.isFinite(maximum)) {
      failures.push(`missing numeric ${budgetName}`);
    } else if (measurement.p95 > maximum) {
      const statistic =
        measurement.samples === 1
          ? `single observation ${measurement.maximum}`
          : `p95 ${measurement.p95} over ${measurement.samples} samples`;
      failures.push(`${measurementName} ${statistic} exceeds ${maximum}`);
    }
  }
  const hotQuery = Option.getOrUndefined(
    EffectArray.findFirst(artifact.measurements, candidate => candidate.name === hotQueryName),
  );
  const hotQueryMaximum = budget.hotQueryP95MillisecondsMaximum;
  if (!hotQuery) {
    failures.push(`missing ${hotQueryName} measurement`);
  } else if (typeof hotQueryMaximum !== 'number' || !Number.isFinite(hotQueryMaximum)) {
    failures.push('missing numeric hotQueryP95MillisecondsMaximum');
  } else {
    const p50Maximum = budget.hotQueryP50MillisecondsMaximum;
    const processCpuMaximum = budget.hotQueryProcessCpuP95MillisecondsMaximum;
    const configuredSamplesMinimum = budget.hotQuerySamplesMinimum;
    const samplesMinimum =
      configuredSamplesMinimum === undefined
        ? CODE_GRAPH_HOT_QUERY_WALL_TOLERANCE_SAMPLES_MINIMUM
        : typeof configuredSamplesMinimum === 'number'
          ? configuredSamplesMinimum
          : Number.NaN;
    const configuredP50ToleranceRatio = budget.hotQueryWallP50ToleranceRatioMaximum;
    const p50ToleranceRatio =
      configuredP50ToleranceRatio === undefined
        ? 0
        : typeof configuredP50ToleranceRatio === 'number'
          ? configuredP50ToleranceRatio
          : Number.NaN;
    const p95ToleranceRatio = budget.hotQueryWallP95ToleranceRatioMaximum;
    const guardedToleranceConfigured =
      p50Maximum !== undefined ||
      processCpuMaximum !== undefined ||
      configuredSamplesMinimum !== undefined ||
      configuredP50ToleranceRatio !== undefined ||
      p95ToleranceRatio !== undefined;
    const guardConfigurationValid =
      typeof p50Maximum === 'number' &&
      Number.isFinite(p50Maximum) &&
      p50Maximum >= 0 &&
      typeof processCpuMaximum === 'number' &&
      Number.isFinite(processCpuMaximum) &&
      processCpuMaximum >= 0 &&
      Number.isSafeInteger(samplesMinimum) &&
      samplesMinimum >= CODE_GRAPH_HOT_QUERY_WALL_TOLERANCE_SAMPLES_MINIMUM &&
      Number.isFinite(p50ToleranceRatio) &&
      p50ToleranceRatio >= 0 &&
      p50ToleranceRatio <= CODE_GRAPH_HOT_QUERY_WALL_P50_TOLERANCE_RATIO_MAXIMUM &&
      typeof p95ToleranceRatio === 'number' &&
      Number.isFinite(p95ToleranceRatio) &&
      p95ToleranceRatio >= 0 &&
      p95ToleranceRatio <= CODE_GRAPH_HOT_QUERY_WALL_P95_TOLERANCE_RATIO_MAXIMUM;
    const processCpu = Option.getOrUndefined(
      EffectArray.findFirst(artifact.measurements, candidate => candidate.name === 'hot-query-process-cpu'),
    );
    if (guardedToleranceConfigured && !guardConfigurationValid) {
      failures.push(
        'hot query wall tolerance requires non-negative numeric p50 and process-CPU bounds, an integer sample minimum of at least 25, a p95 ratio from 0 to 0.05, and an optional p50 ratio from 0 to 0.05',
      );
    }
    if (guardConfigurationValid) {
      const boundedMedianMaximum = p50Maximum * (1 + p50ToleranceRatio);
      if (hotQuery.unit !== 'milliseconds') {
        failures.push(`${hotQueryName} measurement must use milliseconds`);
      }
      if (hotQuery.samples < samplesMinimum) {
        failures.push(`${hotQueryName} requires at least ${samplesMinimum} samples for wall tolerance`);
      }
      if (hotQuery.p50 > boundedMedianMaximum) {
        failures.push(`${hotQueryName} p50 ${hotQuery.p50} exceeds ${boundedMedianMaximum}`);
      }
      if (!processCpu) {
        failures.push('missing hot-query-process-cpu measurement');
      } else if (processCpu.unit !== 'milliseconds') {
        failures.push('hot-query-process-cpu measurement must use milliseconds');
      } else if (processCpu.samples !== hotQuery.samples) {
        failures.push('hot-query-process-cpu sample count must match the hot-query wall measurement');
      } else if (processCpu.p95 > processCpuMaximum) {
        failures.push(`hot-query-process-cpu p95 ${processCpu.p95} exceeds ${processCpuMaximum}`);
      }
    }
    const boundedMedianMaximum =
      typeof p50Maximum === 'number' && Number.isFinite(p50Maximum) ? p50Maximum * (1 + p50ToleranceRatio) : Number.NaN;
    const boundedTailMaximum = guardConfigurationValid ? hotQueryMaximum * (1 + p95ToleranceRatio) : hotQueryMaximum;
    const companionBoundsPassed =
      guardConfigurationValid &&
      hotQuery.unit === 'milliseconds' &&
      hotQuery.samples >= samplesMinimum &&
      hotQuery.p50 <= boundedMedianMaximum &&
      processCpu !== undefined &&
      processCpu.unit === 'milliseconds' &&
      processCpu.samples === hotQuery.samples &&
      processCpu.p95 <= processCpuMaximum;
    if (hotQuery.p95 > hotQueryMaximum && (!companionBoundsPassed || hotQuery.p95 > boundedTailMaximum)) {
      const statistic =
        hotQuery.samples === 1
          ? `single observation ${hotQuery.maximum}`
          : `p95 ${hotQuery.p95} over ${hotQuery.samples} samples`;
      failures.push(`${hotQueryName} ${statistic} exceeds ${hotQueryMaximum}`);
    }
  }
  if (failures.length > 0)
    throw ScriptError.make({message: `Code graph performance budget failed: ${EffectArray.join(failures, '; ')}`});
}

function benchmarkRunnerClassMatchesArtifact(
  runnerClass: string,
  runtimePlatform: boolean | number | string | undefined,
  architecture: string,
): boolean {
  const hosted = /^github-hosted-(linux|macos|windows)-(arm64|x64)$/u.exec(runnerClass);
  if (hosted === null) return true;
  const platform = hosted[1] === 'windows' ? 'win32' : hosted[1] === 'macos' ? 'darwin' : 'linux';
  return runtimePlatform === platform && Effect2.pipe(architecture, EffectString.toLowerCase) === hosted[2];
}

function processPeakRssBytes(): number {
  const maxRss = process.resourceUsage().maxRSS;
  const runtime: ProcessResourceUsageRuntime = 'bun' in process.versions ? 'bun' : 'node';
  return processResourceUsageMaxRssBytes(maxRss, process.platform, runtime);
}

export function requiresLongScaleBenchmarkEvidence(scaleSymbols: number | undefined): boolean {
  return (scaleSymbols ?? 0) >= LONG_SCALE_PROVENANCE_THRESHOLD;
}

const prepareBenchmarkEmbedding = Effect.fn('benchmarkCodeGraph.prepareEmbedding')(function* (
  targetHome: string,
  sourceHome?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const catalog = yield* LocalModelCatalog;
  const store = yield* LocalModelStore;
  const manifest = yield* catalog.get(CORE_EMBEDDING_MODEL_ID);
  const modelHome = sourceHome ?? targetHome;
  const status = yield* store.status(modelHome, manifest);
  const installed = status.installed
    ? yield* store.verify(modelHome, manifest)
    : yield* store.install(modelHome, manifest);
  if (modelHome !== targetHome) {
    const target = store.path(targetHome, manifest);
    yield* fs.makeDirectory(path.dirname(target), {recursive: true, mode: 0o700});
    yield* fs.copy(installed.path, target, {overwrite: true});
  }
  yield* selectLocalModel(targetHome, catalog, 'embedding', manifest.id);
  return manifest.id;
});

function integer(value: string | undefined, option: string, minimum: number): number {
  const parsed = Number.parseInt(required(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw ScriptError.make({message: `${option} must be at least ${minimum}`});
  return parsed;
}

function required(value: string | undefined, option: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(benchmarkCodeGraph, ApplicationLayer));
