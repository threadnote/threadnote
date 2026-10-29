import {Array as EffectArray, Schema} from 'effect';
import {isReadonlyArray} from '@threadnote/platform/readonly-array';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CODE_GRAPH_RESULT_VERSION,
  CODE_GRAPH_SCHEMA_VERSION,
} from '@threadnote/graph/types';
import {
  QUERY_SEMANTIC_TIME_BUDGET_MILLISECONDS,
  QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS,
} from '@threadnote/graph/query';
import * as EffectRecord from 'effect/Record';

export const READY_QUERY_EVIDENCE_VERSION = 1 as const;
export const READY_QUERY_EVIDENCE_SUITE = 'code-graph-ready-query-large' as const;
export const READY_QUERY_MINIMUM_FILES = 200_000;
export const READY_QUERY_MINIMUM_SAMPLES = 25;
export const READY_QUERY_MINIMUM_WARMUPS = 5;
export const READY_QUERY_DEFERRED_P95_MILLISECONDS_MAXIMUM = 500;
export const READY_QUERY_RESPONSE_BYTES_MAXIMUM = 24 * 1_024;
export const READY_QUERY_FIXED_RATE_INTERVAL_MILLISECONDS = 1_000;
export const READY_QUERY_DEFERRED_TIMEOUT_MILLISECONDS = 5_000;
export const READY_QUERY_EXACT_TIMEOUT_MILLISECONDS = 30_000;
export const READY_QUERY_LOGICAL_CPU_MINIMUM = 8;
export const READY_QUERY_CPU_PRESSURE_PERCENT_MAXIMUM = 10;
export const READY_QUERY_IO_PRESSURE_PERCENT_MAXIMUM = 10;
export const READY_QUERY_MEMORY_PRESSURE_PERCENT_MAXIMUM = 10;
export const READY_QUERY_REPOSITORY = 'JetBrains/intellij-community' as const;
export const READY_QUERY_REPOSITORY_COMMIT = '3cbdad9ee6c8a5135fc0f01cc90114fc25c0655c' as const;
export const READY_QUERY_REPOSITORY_TREE = '047481e05148b1c11a52fa813e13323c23abbc0d' as const;
export const READY_QUERY_GITHUB_REPOSITORY = 'threadnote/threadnote' as const;
export const READY_QUERY_LEGACY_GITHUB_REPOSITORY = 'Kashkovsky/threadnote' as const;
export const READY_QUERY_TRANSFERRED_GITHUB_REPOSITORY = READY_QUERY_GITHUB_REPOSITORY;
export const READY_QUERY_GITHUB_REPOSITORIES = [
  READY_QUERY_GITHUB_REPOSITORY,
  READY_QUERY_LEGACY_GITHUB_REPOSITORY,
] as const;
export const READY_QUERY_GITHUB_REPOSITORY_ID = '1230070449' as const;
export const READY_QUERY_GITHUB_EVENT = 'workflow_dispatch' as const;
export const READY_QUERY_GITHUB_REF = 'refs/heads/main' as const;
export const READY_QUERY_GITHUB_ENVIRONMENT = 'large-repository-evidence' as const;
export const READY_QUERY_GITHUB_JOB = 'ready-query-evidence' as const;
export const READY_QUERY_GITHUB_WORKFLOW_PATH = '.github/workflows/code-graph-ready-query-evidence.yml' as const;
export const READY_QUERY_GITHUB_WORKFLOW_REF =
  `${READY_QUERY_GITHUB_REPOSITORY}/${READY_QUERY_GITHUB_WORKFLOW_PATH}@${READY_QUERY_GITHUB_REF}` as const;
const READY_QUERY_LEGACY_GITHUB_WORKFLOW_REF =
  `${READY_QUERY_LEGACY_GITHUB_REPOSITORY}/${READY_QUERY_GITHUB_WORKFLOW_PATH}@${READY_QUERY_GITHUB_REF}` as const;
export const READY_QUERY_ENVIRONMENT_ATTESTATION =
  `intellij-ready-query-v1:${READY_QUERY_REPOSITORY_COMMIT}:${READY_QUERY_REPOSITORY_TREE}` as const;

export type ReadyQueryGitHubRepository = (typeof READY_QUERY_GITHUB_REPOSITORIES)[number];
export type ReadyQueryGitHubWorkflowRef =
  `${ReadyQueryGitHubRepository}/${typeof READY_QUERY_GITHUB_WORKFLOW_PATH}@${typeof READY_QUERY_GITHUB_REF}`;

export function isReadyQueryGitHubRepository(value: string | undefined): value is ReadyQueryGitHubRepository {
  return EffectArray.some(READY_QUERY_GITHUB_REPOSITORIES, repository => repository === value);
}

export function readyQueryGitHubWorkflowRef(repository: ReadyQueryGitHubRepository): ReadyQueryGitHubWorkflowRef {
  return `${repository}/${READY_QUERY_GITHUB_WORKFLOW_PATH}@${READY_QUERY_GITHUB_REF}`;
}

export const READY_QUERY_CONTROLS = [
  {
    expectedLanguage: 'java',
    expectedPath: 'platform/core-api/src/com/intellij/openapi/progress/ProgressManager.java',
    id: 'java-progress-manager',
    query: 'ProgressManager',
  },
  {
    expectedLanguage: 'kotlin',
    expectedPath: 'plugins/gradle/src/org/jetbrains/plugins/gradle/GradleWarmupConfigurator.kt',
    id: 'kotlin-gradle-warmup-configurator',
    query: 'GradleWarmupConfigurator',
  },
  {
    expectedLanguage: 'starlark',
    expectedPath: 'build/jvm-rules/rules/impl/kotlinc-options.bzl',
    id: 'bazel-kotlinc-options',
    query: 'KotlincOptions',
  },
  {
    expectedLanguage: 'typescript',
    expectedPath: 'plugins/ui.webview/webview-src/packages/controls/src/elements/button/button.ts',
    id: 'typescript-webview-button',
    query: 'plugins/ui.webview/webview-src/packages/controls/src/elements/button/button.ts',
  },
] as const;

export type ReadyQueryControlId = (typeof READY_QUERY_CONTROLS)[number]['id'];
export type ReadyQueryFreshness = 'current' | 'deferred';
export type ReadyQueryStageDisposition = 'fallback' | 'measured' | 'skipped';
export type ReadyQueryStage =
  'query-repository-identity' | 'query-serialization' | 'query-strict-reobservation' | 'query-worktree-observation';

export interface ReadyQueryStageSeriesV1 {
  readonly disposition: ReadyQueryStageDisposition;
  readonly durationMilliseconds: readonly number[];
  readonly phase: 'graph.query.execute' | 'graph.query.snapshot' | 'graph.query.status';
  readonly stage: ReadyQueryStage;
}

export interface ReadyQueryTimingSeriesV1 {
  readonly endToEndMilliseconds: readonly number[];
  readonly freshness: ReadyQueryFreshness;
  readonly intervalMilliseconds?: number;
  readonly maxConcurrency: 1;
  readonly mode: 'fixed-rate' | 'sequential';
  readonly queueLatencyIncluded: true;
  readonly queueLatencyMilliseconds: readonly number[];
  readonly resultDigests: readonly string[];
  readonly serviceMilliseconds: readonly number[];
  readonly snapshotDigests: readonly string[];
  readonly stages: readonly ReadyQueryStageSeriesV1[];
  readonly structuredResponseBytes: readonly number[];
  readonly textResponseBytes: readonly number[];
  readonly unattributedMilliseconds: readonly number[];
  readonly warmups: number;
}

export interface ReadyQueryControlEvidenceV1 {
  readonly deferredDigest: string;
  readonly deferredFreshness: 'deferred';
  readonly deferredStructuredResponseBytes: number;
  readonly deferredTextResponseBytes: number;
  readonly exactDigest: string;
  readonly exactFreshness: 'current';
  readonly exactStructuredResponseBytes: number;
  readonly exactTextResponseBytes: number;
  readonly expectedMatch: true;
  readonly id: ReadyQueryControlId;
  readonly language: string;
}

export interface ReadyQueryEvidenceV1 {
  readonly latencyBoundary: 'composed-status-inspect-serialization';
  readonly controls: readonly ReadyQueryControlEvidenceV1[];
  readonly createdAt: string;
  readonly fixture: {
    readonly clean: true;
    readonly commit: typeof READY_QUERY_REPOSITORY_COMMIT;
    readonly publicCommitProof: 'anonymous-https-exact-commit-fetch';
    readonly repository: typeof READY_QUERY_REPOSITORY;
    readonly trackedFiles: number;
    readonly tree: typeof READY_QUERY_REPOSITORY_TREE;
  };
  readonly host: {
    readonly available: true;
    readonly contended: false;
    readonly cpuPressurePercentMaximum: number;
    readonly ioPressurePercentMaximum: number;
    readonly logicalCpuCount: number;
    readonly maxRunnableProcesses: number;
    readonly memoryPressurePercentMaximum: number;
    readonly observations: number;
    readonly policy: 'linux-proc-v1';
    readonly reasons: readonly (
      'cpu-pressure' | 'cpu-steal' | 'io-pressure' | 'memory-pressure' | 'run-queue' | 'swap-activity'
    )[];
    readonly stealTicksDelta: number;
    readonly swapInputPagesDelta: number;
    readonly swapOutputPagesDelta: number;
  };
  readonly measurements: {
    readonly deferred: ReadyQueryTimingSeriesV1;
    readonly exact: ReadyQueryTimingSeriesV1;
  };
  readonly isolation: {
    readonly builderExclusion: 'maintenance-registration-intent-repository-lock-worktree-drain-v1';
    readonly builderExclusionScope: 'inside-status-through-artifact-write';
    readonly buildingSnapshotsAtEntry: 0;
    readonly buildingSnapshotsAtExit: 0;
    readonly databaseWriterLock: 'not-held';
    readonly fullWriterIsolation: 'not-attested';
    readonly storageCapacityIsolation: 'not-attested';
  };
  readonly runner: 'dedicated-preprovisioned-linux-x64';
  readonly requestProfile: {
    readonly deferredTimeoutMilliseconds: typeof READY_QUERY_DEFERRED_TIMEOUT_MILLISECONDS;
    readonly depth: 1;
    readonly edgeLimit: 40;
    readonly exactTimeoutMilliseconds: typeof READY_QUERY_EXACT_TIMEOUT_MILLISECONDS;
    readonly includeHeuristic: false;
    readonly includeModelAssociations: false;
    readonly nodeLimit: 20;
    readonly operation: 'query';
    readonly semanticBudgetMilliseconds: typeof QUERY_SEMANTIC_TIME_BUDGET_MILLISECONDS;
    readonly semanticPolicy: 'runtime-available-lexical-first';
    readonly traversalBudgetMilliseconds: typeof QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS;
  };
  readonly runtime: {
    readonly compatible: true;
    readonly extractorSet: typeof CODE_GRAPH_EXTRACTOR_SET_VERSION;
    readonly persistentExtensionRevision: typeof CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION;
    readonly resultVersion: typeof CODE_GRAPH_RESULT_VERSION;
    readonly schemaVersion: typeof CODE_GRAPH_SCHEMA_VERSION;
  };
  readonly snapshot: {
    readonly commit: typeof READY_QUERY_REPOSITORY_COMMIT;
    readonly dirty: false;
    readonly edgeCount: number;
    readonly extractorSet: typeof CODE_GRAPH_EXTRACTOR_SET_VERSION;
    readonly fileCount: number;
    readonly idSha256: string;
    readonly state: 'ready';
    readonly symbolCount: number;
  };
  readonly source: {
    readonly clean: true;
    readonly commit: string;
    readonly github: {
      readonly environment: typeof READY_QUERY_GITHUB_ENVIRONMENT;
      readonly environmentAttestation: typeof READY_QUERY_ENVIRONMENT_ATTESTATION;
      readonly eventName: typeof READY_QUERY_GITHUB_EVENT;
      readonly job: typeof READY_QUERY_GITHUB_JOB;
      readonly ref: typeof READY_QUERY_GITHUB_REF;
      readonly refProtected: true;
      readonly repository: ReadyQueryGitHubRepository;
      readonly repositoryId: typeof READY_QUERY_GITHUB_REPOSITORY_ID;
      readonly repositoryEnablement: 'enabled';
      readonly runnerArch: 'X64';
      readonly runnerEnvironment: 'self-hosted';
      readonly runnerOs: 'Linux';
      readonly runAttempt: string;
      readonly runId: string;
      readonly sha: string;
      readonly workflowRef: ReadyQueryGitHubWorkflowRef;
      readonly workflowSha: string;
    };
    readonly lockfileSha256: string;
    readonly packageManifestSha256: string;
    readonly validationMode: 'github-actions-clean-source';
  };
  readonly suite: typeof READY_QUERY_EVIDENCE_SUITE;
  readonly version: typeof READY_QUERY_EVIDENCE_VERSION;
}

const ReadyQueryTimingSeriesSchema = Schema.Struct({
  endToEndMilliseconds: Schema.Array(Schema.Finite),
  freshness: Schema.Literals(['current', 'deferred']),
  intervalMilliseconds: Schema.optionalKey(Schema.Finite),
  maxConcurrency: Schema.Literal(1),
  mode: Schema.Literals(['fixed-rate', 'sequential']),
  queueLatencyIncluded: Schema.Literal(true),
  queueLatencyMilliseconds: Schema.Array(Schema.Finite),
  resultDigests: Schema.Array(Schema.String),
  serviceMilliseconds: Schema.Array(Schema.Finite),
  snapshotDigests: Schema.Array(Schema.String),
  stages: Schema.Array(
    Schema.Struct({
      disposition: Schema.Literals(['fallback', 'measured', 'skipped']),
      durationMilliseconds: Schema.Array(Schema.Finite),
      phase: Schema.Literals(['graph.query.execute', 'graph.query.snapshot', 'graph.query.status']),
      stage: Schema.Literals([
        'query-repository-identity',
        'query-serialization',
        'query-strict-reobservation',
        'query-worktree-observation',
      ]),
    }),
  ),
  structuredResponseBytes: Schema.Array(Schema.Finite),
  textResponseBytes: Schema.Array(Schema.Finite),
  unattributedMilliseconds: Schema.Array(Schema.Finite),
  warmups: Schema.Finite,
});

const ReadyQuerySemanticPreflightSchema = Schema.StructWithRest(
  Schema.Struct({
    isolation: Schema.Unknown,
    host: Schema.StructWithRest(Schema.Struct({reasons: Schema.Unknown}), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
    source: Schema.StructWithRest(Schema.Struct({github: Schema.Unknown, validationMode: Schema.Unknown}), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const ReadyQueryEvidenceSchema = Schema.Struct({
  latencyBoundary: Schema.Literal('composed-status-inspect-serialization'),
  controls: Schema.Array(
    Schema.Struct({
      deferredDigest: Schema.String,
      deferredFreshness: Schema.Literal('deferred'),
      deferredStructuredResponseBytes: Schema.Finite,
      deferredTextResponseBytes: Schema.Finite,
      exactDigest: Schema.String,
      exactFreshness: Schema.Literal('current'),
      exactStructuredResponseBytes: Schema.Finite,
      exactTextResponseBytes: Schema.Finite,
      expectedMatch: Schema.Literal(true),
      id: Schema.Literals([
        'java-progress-manager',
        'kotlin-gradle-warmup-configurator',
        'bazel-kotlinc-options',
        'typescript-webview-button',
      ]),
      language: Schema.String,
    }),
  ),
  createdAt: Schema.String,
  fixture: Schema.Struct({
    clean: Schema.Literal(true),
    commit: Schema.Literal(READY_QUERY_REPOSITORY_COMMIT),
    publicCommitProof: Schema.Literal('anonymous-https-exact-commit-fetch'),
    repository: Schema.Literal(READY_QUERY_REPOSITORY),
    trackedFiles: Schema.Finite,
    tree: Schema.Literal(READY_QUERY_REPOSITORY_TREE),
  }),
  host: Schema.Struct({
    available: Schema.Literal(true),
    contended: Schema.Literal(false),
    cpuPressurePercentMaximum: Schema.Finite,
    ioPressurePercentMaximum: Schema.Finite,
    logicalCpuCount: Schema.Finite,
    maxRunnableProcesses: Schema.Finite,
    memoryPressurePercentMaximum: Schema.Finite,
    observations: Schema.Finite,
    policy: Schema.Literal('linux-proc-v1'),
    reasons: Schema.Array(
      Schema.Literals(['cpu-pressure', 'cpu-steal', 'io-pressure', 'memory-pressure', 'run-queue', 'swap-activity']),
    ),
    stealTicksDelta: Schema.Finite,
    swapInputPagesDelta: Schema.Finite,
    swapOutputPagesDelta: Schema.Finite,
  }),
  measurements: Schema.Struct({deferred: ReadyQueryTimingSeriesSchema, exact: ReadyQueryTimingSeriesSchema}),
  isolation: Schema.Struct({
    builderExclusion: Schema.Literal('maintenance-registration-intent-repository-lock-worktree-drain-v1'),
    builderExclusionScope: Schema.Literal('inside-status-through-artifact-write'),
    buildingSnapshotsAtEntry: Schema.Literal(0),
    buildingSnapshotsAtExit: Schema.Literal(0),
    databaseWriterLock: Schema.Literal('not-held'),
    fullWriterIsolation: Schema.Literal('not-attested'),
    storageCapacityIsolation: Schema.Literal('not-attested'),
  }),
  runner: Schema.Literal('dedicated-preprovisioned-linux-x64'),
  requestProfile: Schema.Struct({
    deferredTimeoutMilliseconds: Schema.Literal(READY_QUERY_DEFERRED_TIMEOUT_MILLISECONDS),
    depth: Schema.Literal(1),
    edgeLimit: Schema.Literal(40),
    exactTimeoutMilliseconds: Schema.Literal(READY_QUERY_EXACT_TIMEOUT_MILLISECONDS),
    includeHeuristic: Schema.Literal(false),
    includeModelAssociations: Schema.Literal(false),
    nodeLimit: Schema.Literal(20),
    operation: Schema.Literal('query'),
    semanticBudgetMilliseconds: Schema.Literal(QUERY_SEMANTIC_TIME_BUDGET_MILLISECONDS),
    semanticPolicy: Schema.Literal('runtime-available-lexical-first'),
    traversalBudgetMilliseconds: Schema.Literal(QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS),
  }),
  runtime: Schema.Struct({
    compatible: Schema.Literal(true),
    extractorSet: Schema.Literal(CODE_GRAPH_EXTRACTOR_SET_VERSION),
    persistentExtensionRevision: Schema.Literal(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION),
    resultVersion: Schema.Literal(CODE_GRAPH_RESULT_VERSION),
    schemaVersion: Schema.Literal(CODE_GRAPH_SCHEMA_VERSION),
  }),
  snapshot: Schema.Struct({
    commit: Schema.Literal(READY_QUERY_REPOSITORY_COMMIT),
    dirty: Schema.Literal(false),
    edgeCount: Schema.Finite,
    extractorSet: Schema.Literal(CODE_GRAPH_EXTRACTOR_SET_VERSION),
    fileCount: Schema.Finite,
    idSha256: Schema.String,
    state: Schema.Literal('ready'),
    symbolCount: Schema.Finite,
  }),
  source: Schema.Struct({
    clean: Schema.Literal(true),
    commit: Schema.String,
    github: Schema.Struct({
      environment: Schema.Literal(READY_QUERY_GITHUB_ENVIRONMENT),
      environmentAttestation: Schema.Literal(READY_QUERY_ENVIRONMENT_ATTESTATION),
      eventName: Schema.Literal(READY_QUERY_GITHUB_EVENT),
      job: Schema.Literal(READY_QUERY_GITHUB_JOB),
      ref: Schema.Literal(READY_QUERY_GITHUB_REF),
      refProtected: Schema.Literal(true),
      repository: Schema.Literals(READY_QUERY_GITHUB_REPOSITORIES),
      repositoryId: Schema.Literal(READY_QUERY_GITHUB_REPOSITORY_ID),
      repositoryEnablement: Schema.Literal('enabled'),
      runnerArch: Schema.Literal('X64'),
      runnerEnvironment: Schema.Literal('self-hosted'),
      runnerOs: Schema.Literal('Linux'),
      runAttempt: Schema.String,
      runId: Schema.String,
      sha: Schema.String,
      workflowRef: Schema.Literals([READY_QUERY_GITHUB_WORKFLOW_REF, READY_QUERY_LEGACY_GITHUB_WORKFLOW_REF]),
      workflowSha: Schema.String,
    }),
    lockfileSha256: Schema.String,
    packageManifestSha256: Schema.String,
    validationMode: Schema.Literal('github-actions-clean-source'),
  }),
  suite: Schema.Literal(READY_QUERY_EVIDENCE_SUITE),
  version: Schema.Literal(READY_QUERY_EVIDENCE_VERSION),
});

const EXACT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_STAGE_DISPOSITIONS = {
  deferred: new Map([
    ['graph.query.status/query-repository-identity', 'measured'],
    ['graph.query.status/query-worktree-observation', 'skipped'],
    ['graph.query.execute/query-strict-reobservation', 'skipped'],
    ['graph.query.execute/query-serialization', 'measured'],
  ]),
  exact: new Map([
    ['graph.query.status/query-repository-identity', 'measured'],
    ['graph.query.status/query-worktree-observation', 'measured'],
    ['graph.query.execute/query-strict-reobservation', 'skipped'],
    ['graph.query.execute/query-serialization', 'measured'],
  ]),
} as const;

export function parseReadyQueryEvidenceV1(value: unknown): ReadyQueryEvidenceV1 {
  assertRecord(value, 'Ready-query evidence must be an object.');
  assertExactKeys(
    value,
    [
      'controls',
      'createdAt',
      'fixture',
      'host',
      'isolation',
      'latencyBoundary',
      'measurements',
      'requestProfile',
      'runner',
      'runtime',
      'snapshot',
      'source',
      'suite',
      'version',
    ],
    'artifact',
  );
  if (Schema.is(ReadyQuerySemanticPreflightSchema)(value)) {
    const source = value.source;
    if (isUnknownRecord(source)) {
      assert(source.validationMode === 'github-actions-clean-source', 'Ready-query source validation mode is invalid.');
      const github = source.github;
      if (isUnknownRecord(github)) {
        const repository = github.repository;
        assert(
          typeof repository === 'string' &&
            isReadyQueryGitHubRepository(repository) &&
            github.repositoryId === READY_QUERY_GITHUB_REPOSITORY_ID &&
            github.eventName === READY_QUERY_GITHUB_EVENT &&
            github.job === READY_QUERY_GITHUB_JOB &&
            github.ref === READY_QUERY_GITHUB_REF &&
            github.refProtected === true &&
            github.repositoryEnablement === 'enabled' &&
            github.runnerEnvironment === 'self-hosted' &&
            github.runnerOs === 'Linux' &&
            github.runnerArch === 'X64' &&
            github.workflowRef === readyQueryGitHubWorkflowRef(repository) &&
            github.environment === READY_QUERY_GITHUB_ENVIRONMENT &&
            github.environmentAttestation === READY_QUERY_ENVIRONMENT_ATTESTATION &&
            github.sha === source.commit &&
            github.workflowSha === source.commit &&
            typeof github.sha === 'string' &&
            EXACT_COMMIT.test(github.sha) &&
            typeof github.runId === 'string' &&
            /^[1-9]\d*$/.test(github.runId) &&
            typeof github.runAttempt === 'string' &&
            /^[1-9]\d*$/.test(github.runAttempt),
          'Ready-query evidence is not bound to the canonical protected GitHub workflow run.',
        );
      }
    }
    const host = value.host;
    if (isUnknownRecord(host)) {
      assert(EffectArray.isArray(host.reasons), 'Ready-query host contention reasons are invalid.');
      assert(host.reasons.length === 0, 'Host contention invalidates ready-query evidence.');
    }
    const isolation = value.isolation;
    if (isUnknownRecord(isolation)) {
      assert(
        isolation.builderExclusion === 'maintenance-registration-intent-repository-lock-worktree-drain-v1' &&
          isolation.builderExclusionScope === 'inside-status-through-artifact-write' &&
          isolation.buildingSnapshotsAtEntry === 0 &&
          isolation.buildingSnapshotsAtExit === 0 &&
          isolation.databaseWriterLock === 'not-held' &&
          isolation.fullWriterIsolation === 'not-attested' &&
          isolation.storageCapacityIsolation === 'not-attested',
        'Ready-query artifact does not prove the reviewed builder-exclusion boundary.',
      );
    }
  }
  if (!Schema.is(ReadyQueryEvidenceSchema)(value)) {
    throw new Error('Ready-query evidence has invalid field types.');
  }
  const artifact: ReadyQueryEvidenceV1 = value;
  assert(artifact.version === READY_QUERY_EVIDENCE_VERSION, 'Ready-query evidence version is unsupported.');
  assert(artifact.suite === READY_QUERY_EVIDENCE_SUITE, 'Ready-query evidence suite is invalid.');
  assert(
    artifact.latencyBoundary === 'composed-status-inspect-serialization',
    'Ready-query evidence latency boundary is invalid.',
  );
  assert(Number.isFinite(Date.parse(artifact.createdAt)), 'Ready-query evidence creation time is invalid.');
  assert(artifact.runner === 'dedicated-preprovisioned-linux-x64', 'Ready-query evidence runner is not governed.');
  validateRequestProfile(artifact.requestProfile);
  validateSource(artifact.source);
  validateIsolation(artifact.isolation);
  validateFixture(artifact.fixture);
  validateRuntimeAndSnapshot(artifact.runtime, artifact.snapshot);
  const controls = validateControls(artifact.controls);
  assertRecord(artifact.measurements, 'Ready-query measurements are missing.');
  assertExactKeys(artifact.measurements, ['deferred', 'exact'], 'measurements');
  validateSeries('deferred', artifact.measurements?.deferred, controls.get(READY_QUERY_CONTROLS[0].id), artifact);
  validateSeries('exact', artifact.measurements?.exact, controls.get(READY_QUERY_CONTROLS[0].id), artifact);
  validateHost(artifact.host, artifact.measurements);
  return artifact;
}

export function readyQueryPercentile(values: readonly number[], quantile: number): number {
  assert(values.length > 0, 'Ready-query percentile requires at least one sample.');
  assert(Number.isFinite(quantile) && quantile > 0 && quantile <= 1, 'Ready-query percentile is invalid.');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}

function validateSource(source: ReadyQueryEvidenceV1['source'] | undefined): void {
  assertRecord(source, 'Ready-query source provenance is missing.');
  assertExactKeys(
    source,
    ['clean', 'commit', 'github', 'lockfileSha256', 'packageManifestSha256', 'validationMode'],
    'source provenance',
  );
  assert(source.clean === true && EXACT_COMMIT.test(source.commit), 'Ready-query source must be clean and exact.');
  assert(SHA256.test(source.lockfileSha256), 'Ready-query source lockfile digest is invalid.');
  assert(SHA256.test(source.packageManifestSha256), 'Ready-query source manifest digest is invalid.');
  assert(source.validationMode === 'github-actions-clean-source', 'Ready-query source validation mode is invalid.');
  assertRecord(source.github, 'Ready-query GitHub workflow provenance is missing.');
  assertExactKeys(
    source.github,
    [
      'environment',
      'environmentAttestation',
      'eventName',
      'job',
      'ref',
      'refProtected',
      'repository',
      'repositoryId',
      'repositoryEnablement',
      'runnerArch',
      'runnerEnvironment',
      'runnerOs',
      'runAttempt',
      'runId',
      'sha',
      'workflowRef',
      'workflowSha',
    ],
    'GitHub workflow provenance',
  );
  assert(
    isReadyQueryGitHubRepository(source.github.repository) &&
      source.github.repositoryId === READY_QUERY_GITHUB_REPOSITORY_ID &&
      source.github.eventName === READY_QUERY_GITHUB_EVENT &&
      source.github.job === READY_QUERY_GITHUB_JOB &&
      source.github.ref === READY_QUERY_GITHUB_REF &&
      source.github.refProtected === true &&
      source.github.repositoryEnablement === 'enabled' &&
      source.github.runnerEnvironment === 'self-hosted' &&
      source.github.runnerOs === 'Linux' &&
      source.github.runnerArch === 'X64' &&
      source.github.workflowRef === readyQueryGitHubWorkflowRef(source.github.repository) &&
      source.github.environment === READY_QUERY_GITHUB_ENVIRONMENT &&
      source.github.environmentAttestation === READY_QUERY_ENVIRONMENT_ATTESTATION &&
      source.github.sha === source.commit &&
      source.github.workflowSha === source.commit &&
      EXACT_COMMIT.test(source.github.sha) &&
      /^[1-9]\d*$/.test(source.github.runId) &&
      /^[1-9]\d*$/.test(source.github.runAttempt),
    'Ready-query evidence is not bound to the canonical protected GitHub workflow run.',
  );
}

function validateIsolation(isolation: ReadyQueryEvidenceV1['isolation'] | undefined): void {
  assertRecord(isolation, 'Ready-query builder exclusion evidence is missing.');
  assertExactKeys(
    isolation,
    [
      'builderExclusion',
      'builderExclusionScope',
      'buildingSnapshotsAtEntry',
      'buildingSnapshotsAtExit',
      'databaseWriterLock',
      'fullWriterIsolation',
      'storageCapacityIsolation',
    ],
    'builder exclusion evidence',
  );
  assert(
    isolation.builderExclusion === 'maintenance-registration-intent-repository-lock-worktree-drain-v1' &&
      isolation.builderExclusionScope === 'inside-status-through-artifact-write' &&
      isolation.buildingSnapshotsAtEntry === 0 &&
      isolation.buildingSnapshotsAtExit === 0 &&
      isolation.databaseWriterLock === 'not-held' &&
      isolation.fullWriterIsolation === 'not-attested' &&
      isolation.storageCapacityIsolation === 'not-attested',
    'Ready-query artifact does not prove the reviewed builder-exclusion boundary.',
  );
}

function validateFixture(fixture: ReadyQueryEvidenceV1['fixture'] | undefined): void {
  assertRecord(fixture, 'Ready-query fixture provenance is missing.');
  assertExactKeys(
    fixture,
    ['clean', 'commit', 'publicCommitProof', 'repository', 'trackedFiles', 'tree'],
    'fixture provenance',
  );
  assert(fixture.repository === READY_QUERY_REPOSITORY, 'Ready-query fixture repository is not reviewed.');
  assert(fixture.commit === READY_QUERY_REPOSITORY_COMMIT, 'Ready-query fixture commit is not pinned.');
  assert(
    fixture.clean === true && fixture.tree === READY_QUERY_REPOSITORY_TREE,
    'Ready-query fixture must be clean and exact.',
  );
  assert(
    fixture.publicCommitProof === 'anonymous-https-exact-commit-fetch',
    'Ready-query fixture lacks anonymous public commit proof.',
  );
  assertIntegerAtLeast(fixture.trackedFiles, READY_QUERY_MINIMUM_FILES, 'fixture tracked files');
}

function validateRuntimeAndSnapshot(
  runtime: ReadyQueryEvidenceV1['runtime'] | undefined,
  snapshot: ReadyQueryEvidenceV1['snapshot'] | undefined,
): void {
  assertRecord(runtime, 'Ready-query runtime evidence is missing.');
  assertExactKeys(
    runtime,
    ['compatible', 'extractorSet', 'persistentExtensionRevision', 'resultVersion', 'schemaVersion'],
    'runtime evidence',
  );
  assert(
    runtime.compatible === true &&
      runtime.schemaVersion === CODE_GRAPH_SCHEMA_VERSION &&
      runtime.persistentExtensionRevision === CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION &&
      runtime.resultVersion === CODE_GRAPH_RESULT_VERSION &&
      runtime.extractorSet === CODE_GRAPH_EXTRACTOR_SET_VERSION,
    'Ready-query snapshot is not compatible with this runtime.',
  );
  assertRecord(snapshot, 'Ready-query snapshot evidence is missing.');
  assertExactKeys(
    snapshot,
    ['commit', 'dirty', 'edgeCount', 'extractorSet', 'fileCount', 'idSha256', 'state', 'symbolCount'],
    'snapshot evidence',
  );
  assert(
    snapshot.state === 'ready' &&
      snapshot.dirty === false &&
      snapshot.commit === READY_QUERY_REPOSITORY_COMMIT &&
      snapshot.extractorSet === runtime.extractorSet &&
      SHA256.test(snapshot.idSha256),
    'Ready-query snapshot is not a clean pinned ready snapshot.',
  );
  assertIntegerAtLeast(snapshot.fileCount, READY_QUERY_MINIMUM_FILES, 'snapshot files');
  assertIntegerAtLeast(snapshot.symbolCount, 1, 'snapshot symbols');
  assertIntegerAtLeast(snapshot.edgeCount, 0, 'snapshot edges');
}

function validateControls(controls: readonly ReadyQueryControlEvidenceV1[] | undefined) {
  assert(isReadonlyArray(controls), 'Ready-query controls are missing.');
  const byId = new Map<ReadyQueryControlId, ReadyQueryControlEvidenceV1>(
    EffectArray.map(controls, (control: ReadyQueryControlEvidenceV1) => [control.id, control] as const),
  );
  assert(
    byId.size === READY_QUERY_CONTROLS.length && controls.length === byId.size,
    'Ready-query controls are incomplete.',
  );
  for (const expected of READY_QUERY_CONTROLS) {
    const control = byId.get(expected.id);
    assertRecord(control, `Ready-query control ${expected.id} is missing.`);
    assertExactKeys(
      control,
      [
        'deferredDigest',
        'deferredFreshness',
        'deferredStructuredResponseBytes',
        'deferredTextResponseBytes',
        'exactDigest',
        'exactFreshness',
        'exactStructuredResponseBytes',
        'exactTextResponseBytes',
        'expectedMatch',
        'id',
        'language',
      ],
      `control ${expected.id}`,
    );
    assert(
      control !== undefined && control.language === expected.expectedLanguage,
      `Ready-query control ${expected.id} is invalid.`,
    );
    assert(
      control.expectedMatch === true &&
        control.exactFreshness === 'current' &&
        control.deferredFreshness === 'deferred' &&
        SHA256.test(control.exactDigest) &&
        control.exactDigest === control.deferredDigest,
      `Ready-query control ${expected.id} lost freshness or digest parity.`,
    );
    for (const bytes of [
      control.exactStructuredResponseBytes,
      control.exactTextResponseBytes,
      control.deferredStructuredResponseBytes,
      control.deferredTextResponseBytes,
    ]) {
      assertFiniteRange(bytes, 1, READY_QUERY_RESPONSE_BYTES_MAXIMUM, `control ${expected.id} response bytes`);
    }
  }
  return byId;
}

function validateSeries(
  kind: 'deferred' | 'exact',
  series: ReadyQueryTimingSeriesV1 | undefined,
  primary: ReadyQueryControlEvidenceV1 | undefined,
  artifact: ReadyQueryEvidenceV1,
): void {
  assertRecord(series, `Ready-query ${kind} measurements are missing.`);
  assertExactKeys(
    series,
    [
      'endToEndMilliseconds',
      'freshness',
      ...(kind === 'deferred' ? ['intervalMilliseconds'] : []),
      'maxConcurrency',
      'mode',
      'queueLatencyIncluded',
      'queueLatencyMilliseconds',
      'resultDigests',
      'serviceMilliseconds',
      'snapshotDigests',
      'stages',
      'structuredResponseBytes',
      'textResponseBytes',
      'unattributedMilliseconds',
      'warmups',
    ],
    `${kind} measurements`,
  );
  const samples = series.endToEndMilliseconds;
  assert(EffectArray.isArray(samples), `Ready-query ${kind} samples are missing.`);
  assertIntegerAtLeast(samples.length, READY_QUERY_MINIMUM_SAMPLES, `${kind} samples`);
  assertIntegerAtLeast(series.warmups, READY_QUERY_MINIMUM_WARMUPS, `${kind} warmups`);
  assert(series.maxConcurrency === 1 && series.queueLatencyIncluded === true, `${kind} scheduling is not exact.`);
  assert(series.freshness === (kind === 'exact' ? 'current' : 'deferred'), `${kind} freshness is invalid.`);
  if (kind === 'deferred') {
    assert(
      series.mode === 'fixed-rate' && series.intervalMilliseconds === READY_QUERY_FIXED_RATE_INTERVAL_MILLISECONDS,
      'Deferred queries must use the reviewed fixed-rate schedule.',
    );
  } else {
    assert(
      series.mode === 'sequential' && series.intervalMilliseconds === undefined,
      'Exact queries must be sequential.',
    );
  }
  const aligned = [
    series.queueLatencyMilliseconds,
    series.resultDigests,
    series.serviceMilliseconds,
    series.snapshotDigests,
    series.structuredResponseBytes,
    series.textResponseBytes,
    series.unattributedMilliseconds,
  ];
  assert(
    EffectArray.every(aligned, values => EffectArray.isArray(values) && values.length === samples.length),
    `${kind} samples are incomplete.`,
  );
  assert(isReadonlyArray(series.stages), `${kind} stage coverage is missing.`);
  const stageMap = new Map<string, ReadyQueryStageSeriesV1>(
    EffectArray.map(
      series.stages,
      (stage: ReadyQueryStageSeriesV1) => [`${stage.phase}/${stage.stage}`, stage] as const,
    ),
  );
  const expectedStages = REQUIRED_STAGE_DISPOSITIONS[kind];
  assert(
    stageMap.size === expectedStages.size && series.stages.length === stageMap.size,
    `${kind} stage coverage is incomplete.`,
  );
  for (const [key, disposition] of expectedStages) {
    const stage = stageMap.get(key);
    assertRecord(stage, `${kind} stage ${key} is missing.`);
    assertExactKeys(stage, ['disposition', 'durationMilliseconds', 'phase', 'stage'], `${kind} stage ${key}`);
    assert(stage?.disposition === disposition, `${kind} stage ${key} disposition is invalid.`);
    assert(stage.durationMilliseconds.length === samples.length, `${kind} stage ${key} samples are incomplete.`);
    validateFiniteSeries(stage.durationMilliseconds, `${kind} stage ${key}`);
    if (disposition === 'skipped')
      assert(
        EffectArray.every(stage.durationMilliseconds, value => value === 0),
        `${kind} skipped stage ${key} consumed time.`,
      );
  }
  const expectedDigest = kind === 'exact' ? primary?.exactDigest : primary?.deferredDigest;
  for (let index = 0; index < samples.length; index += 1) {
    const queue = series.queueLatencyMilliseconds[index];
    const service = series.serviceMilliseconds[index];
    const unattributed = series.unattributedMilliseconds[index];
    validateFiniteSeries([samples[index], queue, service, unattributed], `${kind} timing`);
    assert(closeEnough(samples[index], queue + service), `${kind} end-to-end timing does not include queue latency.`);
    assert(kind === 'deferred' || queue === 0, 'Sequential exact queries cannot report queue latency.');
    const attributed = EffectArray.reduce(
      [...stageMap.values()],
      0,
      (sum, stage) => sum + stage.durationMilliseconds[index],
    );
    assert(closeEnough(service, attributed + unattributed), `${kind} stage timing does not reconcile.`);
    assert(series.resultDigests[index] === expectedDigest, `${kind} result digest parity failed.`);
    assert(series.snapshotDigests[index] === artifact.snapshot.idSha256, `${kind} snapshot binding failed.`);
    assertFiniteRange(
      series.structuredResponseBytes[index],
      1,
      READY_QUERY_RESPONSE_BYTES_MAXIMUM,
      `${kind} structured response bytes`,
    );
    assertFiniteRange(
      series.textResponseBytes[index],
      1,
      READY_QUERY_RESPONSE_BYTES_MAXIMUM,
      `${kind} text response bytes`,
    );
  }
  if (kind === 'deferred') {
    assert(
      readyQueryPercentile(samples, 0.95) <= READY_QUERY_DEFERRED_P95_MILLISECONDS_MAXIMUM,
      `Deferred ready-query p95 exceeds ${READY_QUERY_DEFERRED_P95_MILLISECONDS_MAXIMUM} ms.`,
    );
  }
}

function validateHost(
  host: ReadyQueryEvidenceV1['host'] | undefined,
  measurements: ReadyQueryEvidenceV1['measurements'],
): void {
  assertRecord(host, 'Ready-query host contention evidence is missing.');
  assertExactKeys(
    host,
    [
      'available',
      'contended',
      'cpuPressurePercentMaximum',
      'ioPressurePercentMaximum',
      'logicalCpuCount',
      'maxRunnableProcesses',
      'memoryPressurePercentMaximum',
      'observations',
      'policy',
      'reasons',
      'stealTicksDelta',
      'swapInputPagesDelta',
      'swapOutputPagesDelta',
    ],
    'host evidence',
  );
  assert(
    host.available === true && host.policy === 'linux-proc-v1',
    'Ready-query host contention evidence is unavailable.',
  );
  assert(EffectArray.isArray(host.reasons), 'Ready-query host contention reasons are invalid.');
  assertIntegerAtLeast(host.logicalCpuCount, READY_QUERY_LOGICAL_CPU_MINIMUM, 'logical CPU count');
  assertIntegerAtLeast(
    host.observations,
    measurements.deferred.endToEndMilliseconds.length + measurements.exact.endToEndMilliseconds.length,
    'host observations',
  );
  assertIntegerAtLeast(host.maxRunnableProcesses, 0, 'maximum runnable processes');
  assertIntegerAtLeast(host.stealTicksDelta, 0, 'steal ticks');
  assertIntegerAtLeast(host.swapInputPagesDelta, 0, 'swap input pages');
  assertIntegerAtLeast(host.swapOutputPagesDelta, 0, 'swap output pages');
  assertFiniteRange(host.cpuPressurePercentMaximum, 0, 100, 'CPU pressure percent');
  assertFiniteRange(host.ioPressurePercentMaximum, 0, 100, 'I/O pressure percent');
  assertFiniteRange(host.memoryPressurePercentMaximum, 0, 100, 'memory pressure percent');
  const reasons = [
    ...(host.cpuPressurePercentMaximum > READY_QUERY_CPU_PRESSURE_PERCENT_MAXIMUM ? (['cpu-pressure'] as const) : []),
    ...(host.stealTicksDelta > 0 ? (['cpu-steal'] as const) : []),
    ...(host.ioPressurePercentMaximum > READY_QUERY_IO_PRESSURE_PERCENT_MAXIMUM ? (['io-pressure'] as const) : []),
    ...(host.memoryPressurePercentMaximum > READY_QUERY_MEMORY_PRESSURE_PERCENT_MAXIMUM
      ? (['memory-pressure'] as const)
      : []),
    ...(host.maxRunnableProcesses > host.logicalCpuCount ? (['run-queue'] as const) : []),
    ...(host.swapInputPagesDelta > 0 || host.swapOutputPagesDelta > 0 ? (['swap-activity'] as const) : []),
  ];
  assert(
    host.contended === false && host.reasons.length === 0 && reasons.length === 0,
    'Host contention invalidates ready-query evidence.',
  );
}

function validateFiniteSeries(values: readonly number[], label: string): void {
  for (const value of values) assertFiniteRange(value, 0, Number.MAX_VALUE, label);
}

function validateRequestProfile(profile: ReadyQueryEvidenceV1['requestProfile'] | undefined): void {
  assertRecord(profile, 'Ready-query request profile is missing.');
  assertExactKeys(
    profile,
    [
      'depth',
      'deferredTimeoutMilliseconds',
      'edgeLimit',
      'exactTimeoutMilliseconds',
      'includeHeuristic',
      'includeModelAssociations',
      'nodeLimit',
      'operation',
      'semanticBudgetMilliseconds',
      'semanticPolicy',
      'traversalBudgetMilliseconds',
    ],
    'request profile',
  );
  assert(
    profile.operation === 'query' &&
      profile.deferredTimeoutMilliseconds === READY_QUERY_DEFERRED_TIMEOUT_MILLISECONDS &&
      profile.exactTimeoutMilliseconds === READY_QUERY_EXACT_TIMEOUT_MILLISECONDS &&
      profile.nodeLimit === 20 &&
      profile.edgeLimit === 40 &&
      profile.depth === 1 &&
      profile.includeHeuristic === false &&
      profile.includeModelAssociations === false &&
      profile.semanticPolicy === 'runtime-available-lexical-first' &&
      profile.semanticBudgetMilliseconds === QUERY_SEMANTIC_TIME_BUDGET_MILLISECONDS &&
      profile.traversalBudgetMilliseconds === QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS,
    'Ready-query request profile is incompatible.',
  );
}

function assertIntegerAtLeast(value: number, minimum: number, label: string): void {
  assert(Number.isSafeInteger(value) && value >= minimum, `Ready-query ${label} must be at least ${minimum}.`);
}

function assertFiniteRange(value: number, minimum: number, maximum: number, label: string): void {
  assert(Number.isFinite(value) && value >= minimum && value <= maximum, `Ready-query ${label} is out of range.`);
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.05;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function assertRecord<T>(value: T, message: string): asserts value is T & object {
  assert(typeof value === 'object' && value !== null && !EffectArray.isArray(value), message);
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const expectedKeys = new Set(expected);
  const actual = EffectRecord.keys(value);
  assert(
    actual.length === expectedKeys.size && EffectArray.every(actual, key => expectedKeys.has(key)),
    `Ready-query ${label} contains unknown or missing fields.`,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
