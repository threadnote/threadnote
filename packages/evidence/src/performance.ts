import {Array as EffectArray} from 'effect';
import {privacySafeExternalControlPath, privacySafeExternalControlQuery} from './public-controls.js';
import {
  RELEASE_EVIDENCE_HARNESS_DELTA_PATHS,
  releaseEvidenceVersionForRef,
  validateExternalRepositoryEvidence,
} from './external-evidence.js';
import {isJsonObject} from '@threadnote/platform/json';
import {trimBoundaryCharacters} from '@threadnote/platform/string-boundaries';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import * as Schema from 'effect/Schema';

export const performanceControlLanguages = ['java', 'kotlin', 'typescript', 'bazel'] as const;

const retainedManagerNodeBudget = 500;
const retainedManagerEdgeBudget = 1_500;
const retainedWorktreeIsolationTopology = 'bounded-synthetic-linked-worktrees-in-measured-primary-home';
const retainedWorktreeIsolationIndexedFiles = 2;
const retainedPerformanceTargetMilliseconds = new Map<string, number>([
  ['cold-index', 60 * 60_000],
  ['one-file-reindex-index', 30_000],
  ['one-file-reindex-registration-lock-and-database-setup', 5_000],
  ['one-file-reindex-post-committed-scan-overlay-and-workspace', 5_000],
]);
function releaseEvidenceVersion(metadata: Record<string, unknown>): string {
  const releaseVersion = releaseEvidenceVersionForRef(metadataString(metadata, 'releaseEvidenceRef'));
  if (releaseVersion === undefined) {
    throw new Error(
      'Performance harness release evidence does not name a canonical Threadnote 4-or-newer release tag.',
    );
  }
  return releaseVersion;
}

export type PerformanceControlLanguage = (typeof performanceControlLanguages)[number];

type LanguageRecord<T> = Readonly<Record<PerformanceControlLanguage, T>>;

export type RetainedPerformanceArtifact = Readonly<{
  schemaVersion: 1;
  status: 'verified';
  artifact: Readonly<{
    url: string;
    sha256: string;
    generatedAt: string;
  }>;
  source: Readonly<{
    threadnote: Readonly<{
      version: string;
      commit: string;
      lockfileSha256: string;
      packageManifestSha256: string;
    }>;
    repository: Readonly<{
      name: string;
      url: string;
      commit: string;
      checkout: 'clean';
      publicVerification: 'anonymous-https-exact-commit-fetch';
    }>;
  }>;
  runner: Readonly<{
    class: string;
    id: string;
    hardware: string;
    operatingSystem: string;
    architecture: string;
    memoryBytes: number;
    logicalCpuCount: number;
    runtime: Readonly<{
      name: 'Bun';
      version: string;
      target: string;
      executionMode: 'local-source-application-layer';
      managedPayloadValidation: 'exact-head-not-executed';
      dependencyInstallation: 'bun install --frozen-lockfile';
      executableSha256: string;
      payloadManifestSha256: string;
      releaseMetadataSha256: string;
      payloadBytes: number;
      payloadFileCount: number;
      processLeaseInspection: 'complete';
    }>;
    database: Readonly<{
      name: 'SQLite';
      version: string;
    }>;
    disk: Readonly<{
      medium: string;
      filesystem: string;
    }>;
  }>;
  inventory: Readonly<{
    eligibleFiles: number;
    indexedFiles: number;
    excludedFiles: number;
    languages: LanguageRecord<number>;
  }>;
  graph: Readonly<{
    symbols: number;
    relationships: number;
    referenceCandidates: number;
    lookupKeys: number;
    lexicalPostings: number;
  }>;
  phases: Readonly<{
    cold: Readonly<{
      totalMilliseconds: number;
      discoveryMilliseconds: number;
      extractionMilliseconds: number;
      materializationMilliseconds: number;
      resolutionMilliseconds: number;
      activationMilliseconds: number;
    }>;
    incremental: Readonly<{
      totalMilliseconds: number;
      registrationMilliseconds: number;
      postCommittedScanMilliseconds: number;
      attributionContextFiles: number;
      baseFactsLoaded: number;
      changedFiles: number;
      deletedFiles: number;
      factBytes: number;
      inventoryFilesInspected: number;
      plannedRows: number;
      probedDependencyPaths: number;
      sourceBytes: number;
      totalFiles: number;
    }>;
    independentRebuild: Readonly<{
      totalMilliseconds: number;
    }>;
  }>;
  queries: Readonly<{
    sampleCount: number;
    p50Milliseconds: number;
    p95Milliseconds: number;
    maxMilliseconds: number;
  }>;
  controls: LanguageRecord<
    Readonly<{
      query: string;
      path: string;
      stableNodeId: string;
      milliseconds: number;
      passed: true;
    }>
  >;
  parity: Readonly<{
    cleanColdDigest: string;
    incrementalOverlayDigest: string;
    independentOverlayDigest: string;
    incrementalMatchesIndependent: true;
  }>;
  storage: Readonly<{
    databaseGrowthBytes: number;
    databaseBytes: number;
    peakResidentBytes: number;
    peakWalBytes: number;
    peakTemporaryBytes: number;
    durableFilesystemGrowthBytes: number;
    peakJournalBytes: number;
  }>;
  manager: Readonly<{
    catalogColdMilliseconds: number;
    catalogWarmMilliseconds: number;
    overviewColdMilliseconds: number;
    overviewEdgeCount: number;
    overviewNodeCount: number;
    overviewWarmMilliseconds: number;
    detailColdMilliseconds: number;
    nodeDetailColdMilliseconds: number;
    detailEdgeCount: number;
    detailNodeCount: number;
    layoutPreparationProxyMilliseconds: number;
    maxPayloadBytes: number;
    querySampleCount: number;
    queryP50Milliseconds: number;
    queryP95Milliseconds: number;
    queryMaxMilliseconds: number;
    queryMaxPayloadBytes: number;
    nodeBudget: number;
    edgeBudget: number;
    requestCancellationPassed: true;
    snapshotBindingPassed: true;
    staleResponseRejectionPassed: true;
  }>;
  concurrency: Readonly<{
    cleanupPassed: true;
    simultaneousWorktrees: number;
    durationMilliseconds: number;
    indexedFiles: 2;
    topology: 'bounded-synthetic-linked-worktrees-in-measured-primary-home';
    isolationPassed: true;
  }>;
}>;

export type RetainedPerformanceHarnessArtifact = Readonly<{
  createdAt: string;
  environment: Readonly<{
    architecture: string;
    commit: string;
    cpu: string;
    dirty: false;
    fixtureHash: string;
    memoryBytes: number;
    model?: Readonly<{backend: string; id: string; revision: string}>;
    node: string;
    operatingSystem: string;
    packageManager: string;
    runner: 'threadnote-code-graph-e2e';
    runnerVersion: '1';
  }>;
  measurements: readonly Readonly<{
    maximum: number;
    mean: number;
    minimum: number;
    name: string;
    p50: number;
    p95: number;
    p99: number;
    samples: number;
    unit: 'bytes' | 'count' | 'milliseconds' | 'operations_per_second' | 'percent';
  }>[];
  metadata: Readonly<Record<string, boolean | number | string>>;
  suite: 'code-graph-external-repository-v1';
  version: 1;
  warmups: number;
}>;

export type RetainedPerformancePayload = RetainedPerformanceHarnessArtifact;

const RetainedPerformancePayloadSchema = Schema.Struct({
  createdAt: Schema.String,
  environment: Schema.Struct({
    architecture: Schema.String,
    commit: Schema.String,
    cpu: Schema.String,
    dirty: Schema.Literal(false),
    fixtureHash: Schema.String,
    memoryBytes: Schema.Finite,
    model: Schema.optionalKey(Schema.Struct({backend: Schema.String, id: Schema.String, revision: Schema.String})),
    node: Schema.String,
    operatingSystem: Schema.String,
    packageManager: Schema.String,
    runner: Schema.Literal('threadnote-code-graph-e2e'),
    runnerVersion: Schema.Literal('1'),
  }),
  measurements: Schema.Array(
    Schema.Struct({
      maximum: Schema.Finite,
      mean: Schema.Finite,
      minimum: Schema.Finite,
      name: Schema.String,
      p50: Schema.Finite,
      p95: Schema.Finite,
      p99: Schema.Finite,
      samples: Schema.Finite,
      unit: Schema.Literals(['bytes', 'count', 'milliseconds', 'operations_per_second', 'percent']),
    }),
  ),
  metadata: Schema.Record(Schema.String, Schema.Union([Schema.Boolean, Schema.Finite, Schema.String])),
  suite: Schema.Literal('code-graph-external-repository-v1'),
  version: Schema.Literal(1),
  warmups: Schema.Finite,
});
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonRecord = Schema.decodeUnknownSync(JsonRecordSchema);
const decodeRetainedPerformancePayload = Schema.decodeUnknownSync(RetainedPerformancePayloadSchema, {
  errors: 'all',
  onExcessProperty: 'error',
});

export type PerformanceEvidence =
  | Readonly<{
      state: 'pending';
      reason: string;
    }>
  | Readonly<{
      state: 'verified';
      artifact: RetainedPerformanceArtifact;
    }>;

export type RetainedPerformanceObjective = Readonly<{
  measurement: string;
  label: string;
  observedMilliseconds: number;
  targetMilliseconds: number;
  passed: boolean;
}>;

const retainedPerformanceTargetLabels = new Map<string, string>([
  ['cold-index', 'Cold index'],
  ['one-file-reindex-index', 'One-file incremental'],
  ['one-file-reindex-registration-lock-and-database-setup', 'One-file registration'],
  ['one-file-reindex-post-committed-scan-overlay-and-workspace', 'Post-committed scan'],
]);

export function retainedPerformanceObjectiveResults(
  artifact: RetainedPerformanceArtifact,
): readonly RetainedPerformanceObjective[] {
  const observedMilliseconds = new Map<string, number>([
    ['cold-index', artifact.phases.cold.totalMilliseconds],
    ['one-file-reindex-index', artifact.phases.incremental.totalMilliseconds],
    ['one-file-reindex-registration-lock-and-database-setup', artifact.phases.incremental.registrationMilliseconds],
    [
      'one-file-reindex-post-committed-scan-overlay-and-workspace',
      artifact.phases.incremental.postCommittedScanMilliseconds,
    ],
  ]);
  return EffectArray.map([...retainedPerformanceTargetMilliseconds], ([measurement, targetMilliseconds]) => {
    const observed = observedMilliseconds.get(measurement);
    const label = retainedPerformanceTargetLabels.get(measurement);
    if (observed === undefined || label === undefined) {
      throw new Error(`Performance objective ${measurement} is not mapped to retained evidence.`);
    }
    return {
      measurement,
      label,
      observedMilliseconds: observed,
      targetMilliseconds,
      passed: observed < targetMilliseconds,
    };
  });
}

export const retainedPerformanceArtifactFieldPaths = [
  'schemaVersion',
  'status',
  'artifact.url',
  'artifact.sha256',
  'artifact.generatedAt',
  'source.threadnote.version',
  'source.threadnote.commit',
  'source.threadnote.lockfileSha256',
  'source.threadnote.packageManifestSha256',
  'source.repository.name',
  'source.repository.url',
  'source.repository.commit',
  'source.repository.checkout',
  'source.repository.publicVerification',
  'runner.class',
  'runner.id',
  'runner.hardware',
  'runner.operatingSystem',
  'runner.architecture',
  'runner.memoryBytes',
  'runner.logicalCpuCount',
  'runner.runtime.name',
  'runner.runtime.version',
  'runner.runtime.target',
  'runner.runtime.executionMode',
  'runner.runtime.managedPayloadValidation',
  'runner.runtime.dependencyInstallation',
  'runner.runtime.executableSha256',
  'runner.runtime.payloadManifestSha256',
  'runner.runtime.releaseMetadataSha256',
  'runner.runtime.payloadBytes',
  'runner.runtime.payloadFileCount',
  'runner.runtime.processLeaseInspection',
  'runner.database.name',
  'runner.database.version',
  'runner.disk.medium',
  'runner.disk.filesystem',
  'inventory.eligibleFiles',
  'inventory.indexedFiles',
  'inventory.excludedFiles',
  'inventory.languages.java',
  'inventory.languages.kotlin',
  'inventory.languages.typescript',
  'inventory.languages.bazel',
  'graph.symbols',
  'graph.relationships',
  'graph.referenceCandidates',
  'graph.lookupKeys',
  'graph.lexicalPostings',
  'phases.cold.totalMilliseconds',
  'phases.cold.discoveryMilliseconds',
  'phases.cold.extractionMilliseconds',
  'phases.cold.materializationMilliseconds',
  'phases.cold.resolutionMilliseconds',
  'phases.cold.activationMilliseconds',
  'phases.incremental.totalMilliseconds',
  'phases.incremental.registrationMilliseconds',
  'phases.incremental.postCommittedScanMilliseconds',
  'phases.incremental.attributionContextFiles',
  'phases.incremental.baseFactsLoaded',
  'phases.incremental.changedFiles',
  'phases.incremental.deletedFiles',
  'phases.incremental.factBytes',
  'phases.incremental.inventoryFilesInspected',
  'phases.incremental.plannedRows',
  'phases.incremental.probedDependencyPaths',
  'phases.incremental.sourceBytes',
  'phases.incremental.totalFiles',
  'phases.independentRebuild.totalMilliseconds',
  'queries.sampleCount',
  'queries.p50Milliseconds',
  'queries.p95Milliseconds',
  'queries.maxMilliseconds',
  'controls.java.query',
  'controls.java.path',
  'controls.java.stableNodeId',
  'controls.java.milliseconds',
  'controls.java.passed',
  'controls.kotlin.query',
  'controls.kotlin.path',
  'controls.kotlin.stableNodeId',
  'controls.kotlin.milliseconds',
  'controls.kotlin.passed',
  'controls.typescript.query',
  'controls.typescript.path',
  'controls.typescript.stableNodeId',
  'controls.typescript.milliseconds',
  'controls.typescript.passed',
  'controls.bazel.query',
  'controls.bazel.path',
  'controls.bazel.stableNodeId',
  'controls.bazel.milliseconds',
  'controls.bazel.passed',
  'parity.cleanColdDigest',
  'parity.incrementalOverlayDigest',
  'parity.independentOverlayDigest',
  'parity.incrementalMatchesIndependent',
  'storage.databaseGrowthBytes',
  'storage.databaseBytes',
  'storage.peakResidentBytes',
  'storage.peakWalBytes',
  'storage.peakTemporaryBytes',
  'storage.durableFilesystemGrowthBytes',
  'storage.peakJournalBytes',
  'manager.catalogColdMilliseconds',
  'manager.catalogWarmMilliseconds',
  'manager.overviewColdMilliseconds',
  'manager.overviewEdgeCount',
  'manager.overviewNodeCount',
  'manager.overviewWarmMilliseconds',
  'manager.detailColdMilliseconds',
  'manager.nodeDetailColdMilliseconds',
  'manager.detailEdgeCount',
  'manager.detailNodeCount',
  'manager.layoutPreparationProxyMilliseconds',
  'manager.maxPayloadBytes',
  'manager.querySampleCount',
  'manager.queryP50Milliseconds',
  'manager.queryP95Milliseconds',
  'manager.queryMaxMilliseconds',
  'manager.queryMaxPayloadBytes',
  'manager.nodeBudget',
  'manager.edgeBudget',
  'manager.requestCancellationPassed',
  'manager.snapshotBindingPassed',
  'manager.staleResponseRejectionPassed',
  'concurrency.cleanupPassed',
  'concurrency.simultaneousWorktrees',
  'concurrency.durationMilliseconds',
  'concurrency.indexedFiles',
  'concurrency.topology',
  'concurrency.isolationPassed',
] as const;

const sha40Pattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function rejectUnexpectedFields(value: unknown, path: string, keys: readonly string[]): void {
  if (!isJsonObject(value)) return;
  if (EffectArray.some(EffectRecord.keys(value), key => !keys.includes(key))) {
    throw new Error(`Performance evidence ${path} has unexpected or missing fields.`);
  }
}

function recordAt(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || EffectArray.isArray(value)) {
    throw new Error(`Performance evidence ${path} must be an object.`);
  }
  const record = decodeJsonRecord(value);
  const actualKeys = EffectRecord.keys(record).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    EffectArray.some(actualKeys, (key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`Performance evidence ${path} has unexpected or missing fields.`);
  }
  return record;
}

function stringAt(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string' || Effect.pipe(value, EffectString.trim).length === 0) {
    throw new Error(`Performance evidence ${path}.${key} must be a non-empty string.`);
  }
  return value;
}

function numberAt(record: Record<string, unknown>, key: string, path: string, integer = false): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`Performance evidence ${path}.${key} must be a non-negative ${integer ? 'integer' : 'number'}.`);
  }
  return value;
}

function positiveNumberAt(record: Record<string, unknown>, key: string, path: string, integer = false): number {
  const value = numberAt(record, key, path, integer);
  if (value === 0) {
    throw new Error(`Performance evidence ${path}.${key} must be greater than zero.`);
  }
  return value;
}

function literalValueAt<T extends string | number | boolean>(
  record: Record<string, unknown>,
  key: string,
  expected: T,
): T {
  if (record[key] !== expected) {
    throw new Error(`Performance evidence ${key} must be ${JSON.stringify(expected)}.`);
  }
  return expected;
}

function literalAt(
  record: Record<string, unknown>,
  key: string,
  path: string,
  expected: string | number | boolean,
): void {
  if (record[key] !== expected) {
    throw new Error(`Performance evidence ${path}.${key} must be ${JSON.stringify(expected)}.`);
  }
}

function httpsUrlAt(record: Record<string, unknown>, key: string, path: string): void {
  const value = stringAt(record, key, path);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error('not HTTPS');
  } catch {
    throw new Error(`Performance evidence ${path}.${key} must be an HTTPS URL.`);
  }
}

function sitePathAt(record: Record<string, unknown>, key: string, path: string): void {
  const value = stringAt(record, key, path);
  const parts = EffectArray.filter(Effect.pipe(value, EffectString.split('/')), Boolean);
  const directories = parts.slice(0, -1);
  if (
    !Effect.pipe(value, EffectString.startsWith('/')) ||
    parts.at(-1) !== 'performance-evidence.json' ||
    EffectArray.some(directories, part => part === '.' || part === '..' || !/^[A-Za-z0-9._~-]+$/.test(part))
  ) {
    throw new Error(`Performance evidence ${path}.${key} must be a root-relative site artifact path.`);
  }
}

function digestAt(record: Record<string, unknown>, key: string, path: string, pattern = sha256Pattern): void {
  if (!pattern.test(stringAt(record, key, path))) {
    throw new Error(`Performance evidence ${path}.${key} has an invalid digest.`);
  }
}

function validateLanguageRecord(
  value: unknown,
  path: string,
  validate: (record: Record<string, unknown>, key: string) => void,
): void {
  const record = recordAt(value, path, performanceControlLanguages);
  for (const language of performanceControlLanguages) validate(record, language);
}

export function assertRetainedPerformanceArtifact(input: unknown): asserts input is RetainedPerformanceArtifact {
  const root = recordAt(input, 'root', [
    'schemaVersion',
    'status',
    'artifact',
    'source',
    'runner',
    'inventory',
    'graph',
    'phases',
    'queries',
    'controls',
    'parity',
    'storage',
    'manager',
    'concurrency',
  ]);
  literalAt(root, 'schemaVersion', 'root', 1);
  literalAt(root, 'status', 'root', 'verified');

  const artifact = recordAt(root.artifact, 'artifact', ['url', 'sha256', 'generatedAt']);
  sitePathAt(artifact, 'url', 'artifact');
  digestAt(artifact, 'sha256', 'artifact');
  const generatedAt = stringAt(artifact, 'generatedAt', 'artifact');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(generatedAt)) {
    throw new Error('Performance evidence artifact.generatedAt must be an ISO-8601 UTC timestamp.');
  }

  const source = recordAt(root.source, 'source', ['threadnote', 'repository']);
  const threadnote = recordAt(source.threadnote, 'source.threadnote', [
    'version',
    'commit',
    'lockfileSha256',
    'packageManifestSha256',
  ]);
  const threadnoteVersion = stringAt(threadnote, 'version', 'source.threadnote');
  if (releaseEvidenceVersionForRef(`refs/tags/${threadnoteVersion}`) === undefined) {
    throw new Error(
      'Performance evidence source.threadnote.version must be a canonical Threadnote 4-or-newer release version.',
    );
  }
  digestAt(threadnote, 'commit', 'source.threadnote', sha40Pattern);
  digestAt(threadnote, 'lockfileSha256', 'source.threadnote');
  digestAt(threadnote, 'packageManifestSha256', 'source.threadnote');
  const repository = recordAt(source.repository, 'source.repository', [
    'name',
    'url',
    'commit',
    'checkout',
    'publicVerification',
  ]);
  stringAt(repository, 'name', 'source.repository');
  httpsUrlAt(repository, 'url', 'source.repository');
  digestAt(repository, 'commit', 'source.repository', sha40Pattern);
  literalAt(repository, 'checkout', 'source.repository', 'clean');
  if (repository.publicVerification !== 'anonymous-https-exact-commit-fetch') {
    throw new Error('Performance evidence source.repository.publicVerification is invalid.');
  }

  const runner = recordAt(root.runner, 'runner', [
    'class',
    'id',
    'hardware',
    'operatingSystem',
    'architecture',
    'memoryBytes',
    'logicalCpuCount',
    'runtime',
    'database',
    'disk',
  ]);
  stringAt(runner, 'class', 'runner');
  stringAt(runner, 'id', 'runner');
  stringAt(runner, 'hardware', 'runner');
  stringAt(runner, 'operatingSystem', 'runner');
  stringAt(runner, 'architecture', 'runner');
  positiveNumberAt(runner, 'memoryBytes', 'runner', true);
  positiveNumberAt(runner, 'logicalCpuCount', 'runner', true);
  const runtime = recordAt(runner.runtime, 'runner.runtime', [
    'name',
    'version',
    'target',
    'executionMode',
    'managedPayloadValidation',
    'dependencyInstallation',
    'executableSha256',
    'payloadManifestSha256',
    'releaseMetadataSha256',
    'payloadBytes',
    'payloadFileCount',
    'processLeaseInspection',
  ]);
  literalAt(runtime, 'name', 'runner.runtime', 'Bun');
  stringAt(runtime, 'version', 'runner.runtime');
  stringAt(runtime, 'target', 'runner.runtime');
  literalAt(runtime, 'executionMode', 'runner.runtime', 'local-source-application-layer');
  literalAt(runtime, 'managedPayloadValidation', 'runner.runtime', 'exact-head-not-executed');
  literalAt(runtime, 'dependencyInstallation', 'runner.runtime', 'bun install --frozen-lockfile');
  digestAt(runtime, 'executableSha256', 'runner.runtime');
  digestAt(runtime, 'payloadManifestSha256', 'runner.runtime');
  digestAt(runtime, 'releaseMetadataSha256', 'runner.runtime');
  positiveNumberAt(runtime, 'payloadBytes', 'runner.runtime', true);
  positiveNumberAt(runtime, 'payloadFileCount', 'runner.runtime', true);
  literalAt(runtime, 'processLeaseInspection', 'runner.runtime', 'complete');
  const database = recordAt(runner.database, 'runner.database', ['name', 'version']);
  literalAt(database, 'name', 'runner.database', 'SQLite');
  stringAt(database, 'version', 'runner.database');
  const disk = recordAt(runner.disk, 'runner.disk', ['medium', 'filesystem']);
  stringAt(disk, 'medium', 'runner.disk');
  stringAt(disk, 'filesystem', 'runner.disk');

  const inventory = recordAt(root.inventory, 'inventory', [
    'eligibleFiles',
    'indexedFiles',
    'excludedFiles',
    'languages',
  ]);
  const eligibleFiles = positiveNumberAt(inventory, 'eligibleFiles', 'inventory', true);
  const indexedFiles = positiveNumberAt(inventory, 'indexedFiles', 'inventory', true);
  numberAt(inventory, 'excludedFiles', 'inventory', true);
  if (indexedFiles > eligibleFiles) {
    throw new Error('Performance evidence inventory.indexedFiles cannot exceed eligibleFiles.');
  }
  validateLanguageRecord(inventory.languages, 'inventory.languages', (record, language) => {
    positiveNumberAt(record, language, 'inventory.languages', true);
  });

  const graph = recordAt(root.graph, 'graph', [
    'symbols',
    'relationships',
    'referenceCandidates',
    'lookupKeys',
    'lexicalPostings',
  ]);
  for (const key of EffectRecord.keys(graph)) positiveNumberAt(graph, key, 'graph', true);

  const phases = recordAt(root.phases, 'phases', ['cold', 'incremental', 'independentRebuild']);
  const cold = recordAt(phases.cold, 'phases.cold', [
    'totalMilliseconds',
    'discoveryMilliseconds',
    'extractionMilliseconds',
    'materializationMilliseconds',
    'resolutionMilliseconds',
    'activationMilliseconds',
  ]);
  for (const key of EffectRecord.keys(cold)) positiveNumberAt(cold, key, 'phases.cold');
  const incremental = recordAt(phases.incremental, 'phases.incremental', [
    'totalMilliseconds',
    'registrationMilliseconds',
    'postCommittedScanMilliseconds',
    'attributionContextFiles',
    'baseFactsLoaded',
    'changedFiles',
    'deletedFiles',
    'factBytes',
    'inventoryFilesInspected',
    'plannedRows',
    'probedDependencyPaths',
    'sourceBytes',
    'totalFiles',
  ]);
  positiveNumberAt(incremental, 'totalMilliseconds', 'phases.incremental');
  positiveNumberAt(incremental, 'registrationMilliseconds', 'phases.incremental');
  positiveNumberAt(incremental, 'postCommittedScanMilliseconds', 'phases.incremental');
  const totalFiles = positiveNumberAt(incremental, 'totalFiles', 'phases.incremental', true);
  const attributionContextFiles = numberAt(incremental, 'attributionContextFiles', 'phases.incremental', true);
  const baseFactsLoaded = numberAt(incremental, 'baseFactsLoaded', 'phases.incremental', true);
  const probedDependencyPaths = numberAt(incremental, 'probedDependencyPaths', 'phases.incremental', true);
  numberAt(incremental, 'deletedFiles', 'phases.incremental', true);
  positiveNumberAt(incremental, 'factBytes', 'phases.incremental', true);
  positiveNumberAt(incremental, 'plannedRows', 'phases.incremental', true);
  positiveNumberAt(incremental, 'sourceBytes', 'phases.incremental', true);
  const inventoryFilesInspected = numberAt(incremental, 'inventoryFilesInspected', 'phases.incremental', true);
  if (inventoryFilesInspected > totalFiles) {
    throw new Error('Performance evidence phases.incremental.inventoryFilesInspected cannot exceed totalFiles.');
  }
  literalAt(incremental, 'changedFiles', 'phases.incremental', 1);
  if (
    totalFiles > 1 &&
    EffectArray.some(
      [inventoryFilesInspected, attributionContextFiles, baseFactsLoaded, probedDependencyPaths],
      value => value >= totalFiles,
    )
  ) {
    throw new Error('Performance evidence one-file work must remain below a repository-wide scan.');
  }
  const rebuild = recordAt(phases.independentRebuild, 'phases.independentRebuild', ['totalMilliseconds']);
  positiveNumberAt(rebuild, 'totalMilliseconds', 'phases.independentRebuild');

  const queries = recordAt(root.queries, 'queries', [
    'sampleCount',
    'p50Milliseconds',
    'p95Milliseconds',
    'maxMilliseconds',
  ]);
  positiveNumberAt(queries, 'sampleCount', 'queries', true);
  const queryP50 = positiveNumberAt(queries, 'p50Milliseconds', 'queries');
  const queryP95 = positiveNumberAt(queries, 'p95Milliseconds', 'queries');
  const queryMax = positiveNumberAt(queries, 'maxMilliseconds', 'queries');
  if (queryP50 > queryP95 || queryP95 > queryMax) {
    throw new Error('Performance evidence query percentiles must be monotonic.');
  }

  validateLanguageRecord(root.controls, 'controls', (record, language) => {
    const control = recordAt(record[language], `controls.${language}`, [
      'query',
      'path',
      'stableNodeId',
      'milliseconds',
      'passed',
    ]);
    stringAt(control, 'query', `controls.${language}`);
    stringAt(control, 'path', `controls.${language}`);
    if (!/^cgs_[a-f0-9]{32,64}$/.test(stringAt(control, 'stableNodeId', `controls.${language}`))) {
      throw new Error(`Performance evidence controls.${language}.stableNodeId is invalid.`);
    }
    positiveNumberAt(control, 'milliseconds', `controls.${language}`);
    literalAt(control, 'passed', `controls.${language}`, true);
  });

  const parity = recordAt(root.parity, 'parity', [
    'cleanColdDigest',
    'incrementalOverlayDigest',
    'independentOverlayDigest',
    'incrementalMatchesIndependent',
  ]);
  for (const key of ['cleanColdDigest', 'incrementalOverlayDigest', 'independentOverlayDigest']) {
    digestAt(parity, key, 'parity');
  }
  literalAt(parity, 'incrementalMatchesIndependent', 'parity', true);
  if (parity.incrementalOverlayDigest !== parity.independentOverlayDigest) {
    throw new Error('Performance evidence overlay digests must match before publication.');
  }

  const storage = recordAt(root.storage, 'storage', [
    'databaseGrowthBytes',
    'databaseBytes',
    'peakResidentBytes',
    'peakWalBytes',
    'peakTemporaryBytes',
    'durableFilesystemGrowthBytes',
    'peakJournalBytes',
  ]);
  positiveNumberAt(storage, 'databaseGrowthBytes', 'storage', true);
  positiveNumberAt(storage, 'databaseBytes', 'storage', true);
  positiveNumberAt(storage, 'peakResidentBytes', 'storage', true);
  for (const key of ['peakWalBytes', 'peakTemporaryBytes', 'durableFilesystemGrowthBytes', 'peakJournalBytes']) {
    numberAt(storage, key, 'storage', true);
  }

  const manager = recordAt(root.manager, 'manager', [
    'catalogColdMilliseconds',
    'catalogWarmMilliseconds',
    'overviewColdMilliseconds',
    'overviewEdgeCount',
    'overviewNodeCount',
    'overviewWarmMilliseconds',
    'detailColdMilliseconds',
    'nodeDetailColdMilliseconds',
    'detailEdgeCount',
    'detailNodeCount',
    'layoutPreparationProxyMilliseconds',
    'maxPayloadBytes',
    'querySampleCount',
    'queryP50Milliseconds',
    'queryP95Milliseconds',
    'queryMaxMilliseconds',
    'queryMaxPayloadBytes',
    'nodeBudget',
    'edgeBudget',
    'requestCancellationPassed',
    'snapshotBindingPassed',
    'staleResponseRejectionPassed',
  ]);
  for (const key of [
    'catalogColdMilliseconds',
    'catalogWarmMilliseconds',
    'overviewColdMilliseconds',
    'overviewWarmMilliseconds',
    'detailColdMilliseconds',
    'nodeDetailColdMilliseconds',
    'layoutPreparationProxyMilliseconds',
  ]) {
    positiveNumberAt(manager, key, 'manager');
  }
  for (const key of ['overviewNodeCount', 'detailNodeCount']) positiveNumberAt(manager, key, 'manager', true);
  for (const key of ['overviewEdgeCount', 'detailEdgeCount']) numberAt(manager, key, 'manager', true);
  for (const key of ['maxPayloadBytes', 'querySampleCount', 'queryMaxPayloadBytes', 'nodeBudget', 'edgeBudget']) {
    positiveNumberAt(manager, key, 'manager', true);
  }
  const managerQueryP50 = positiveNumberAt(manager, 'queryP50Milliseconds', 'manager');
  const managerQueryP95 = positiveNumberAt(manager, 'queryP95Milliseconds', 'manager');
  const managerQueryMax = positiveNumberAt(manager, 'queryMaxMilliseconds', 'manager');
  if (managerQueryP50 > managerQueryP95 || managerQueryP95 > managerQueryMax) {
    throw new Error('Performance evidence Manager query percentiles must be monotonic.');
  }
  literalAt(manager, 'requestCancellationPassed', 'manager', true);
  literalAt(manager, 'snapshotBindingPassed', 'manager', true);
  literalAt(manager, 'staleResponseRejectionPassed', 'manager', true);
  literalAt(manager, 'nodeBudget', 'manager', retainedManagerNodeBudget);
  literalAt(manager, 'edgeBudget', 'manager', retainedManagerEdgeBudget);

  const concurrency = recordAt(root.concurrency, 'concurrency', [
    'cleanupPassed',
    'simultaneousWorktrees',
    'durationMilliseconds',
    'indexedFiles',
    'topology',
    'isolationPassed',
  ]);
  literalAt(concurrency, 'cleanupPassed', 'concurrency', true);
  const simultaneousWorktrees = positiveNumberAt(concurrency, 'simultaneousWorktrees', 'concurrency', true);
  if (simultaneousWorktrees < 2) {
    throw new Error('Performance evidence concurrency.simultaneousWorktrees must exercise concurrency.');
  }
  positiveNumberAt(concurrency, 'durationMilliseconds', 'concurrency');
  literalAt(concurrency, 'indexedFiles', 'concurrency', retainedWorktreeIsolationIndexedFiles);
  literalAt(concurrency, 'topology', 'concurrency', retainedWorktreeIsolationTopology);
  literalAt(concurrency, 'isolationPassed', 'concurrency', true);
}

type HarnessMeasurement = RetainedPerformanceHarnessArtifact['measurements'][number];

const harnessLanguageControls = [
  {display: 'java', harness: 'java'},
  {display: 'kotlin', harness: 'kotlin'},
  {display: 'typescript', harness: 'typescript'},
  {display: 'bazel', harness: 'bazel-build'},
] as const satisfies readonly {display: PerformanceControlLanguage; harness: string}[];

function openRecordAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || EffectArray.isArray(value)) {
    throw new Error(`Performance evidence ${path} must be an object.`);
  }
  return decodeJsonRecord(value);
}

function metadataString(metadata: Record<string, unknown>, key: string): string {
  return stringAt(metadata, key, 'harness.metadata');
}

function metadataNumber(metadata: Record<string, unknown>, key: string, integer = false): number {
  return numberAt(metadata, key, 'harness.metadata', integer);
}

function measurementMap(artifact: RetainedPerformanceHarnessArtifact): ReadonlyMap<string, HarnessMeasurement> {
  const measurements = new Map<string, HarnessMeasurement>();
  for (const measurement of artifact.measurements) {
    if (measurements.has(measurement.name)) {
      throw new Error(`Performance harness contains duplicate measurement ${measurement.name}.`);
    }
    measurements.set(measurement.name, measurement);
  }
  return measurements;
}

function requiredMeasurement(
  measurements: ReadonlyMap<string, HarnessMeasurement>,
  name: string,
  unit: HarnessMeasurement['unit'],
  positive = true,
): HarnessMeasurement {
  const measurement = measurements.get(name);
  if (!measurement || measurement.unit !== unit || (positive && measurement.maximum <= 0)) {
    throw new Error(`Performance harness requires ${name} (${unit})${positive ? ' with a positive result' : ''}.`);
  }
  return measurement;
}

function parseHarnessControls(metadata: Record<string, unknown>): LanguageRecord<{
  query: string;
  path: string;
  stableNodeId: string;
}> {
  let input: unknown;
  try {
    input = JSON.parse(metadataString(metadata, 'externalControlEvidence'));
  } catch {
    throw new Error('Performance harness metadata.externalControlEvidence must be valid JSON.');
  }
  const controls = recordAt(input, 'harness.metadata.externalControlEvidence', performanceControlLanguages);
  const entries = EffectArray.map(performanceControlLanguages, language => {
    const control = recordAt(controls[language], `harness.controls.${language}`, ['query', 'path', 'stableNodeId']);
    const query = stringAt(control, 'query', `harness.controls.${language}`);
    const path = stringAt(control, 'path', `harness.controls.${language}`);
    const stableNodeId = stringAt(control, 'stableNodeId', `harness.controls.${language}`);
    if (privacySafeExternalControlQuery(query) !== query) {
      throw new Error(`Performance harness controls.${language}.query is not canonical privacy-safe evidence.`);
    }
    if (privacySafeExternalControlPath(path) !== path) {
      throw new Error(`Performance harness controls.${language}.path is not canonical privacy-safe evidence.`);
    }
    if (!/^cgs_[a-f0-9]{32,64}$/.test(stableNodeId)) {
      throw new Error(`Performance harness controls.${language}.stableNodeId is invalid.`);
    }
    return {language, value: {path, query, stableNodeId}};
  });
  return {
    bazel: entries[3].value,
    java: entries[0].value,
    kotlin: entries[1].value,
    typescript: entries[2].value,
  };
}

function validateHarnessRuntimeProvenance(
  environment: Record<string, unknown>,
  metadata: Record<string, unknown>,
): void {
  const commit = stringAt(environment, 'commit', 'harness.environment');
  digestAt(environment, 'commit', 'harness.environment', sha40Pattern);
  literalAt(environment, 'dirty', 'harness.environment', false);
  literalAt(metadata, 'benchmarkMeasuredExecutionMode', 'harness.metadata', 'local-source-application-layer');
  literalAt(metadata, 'benchmarkSourceValidationMode', 'harness.metadata', 'managed-payload-exact-head-validated');
  literalAt(metadata, 'benchmarkMeasuredSourceCommit', 'harness.metadata', commit);
  digestAt(metadata, 'benchmarkMeasuredSourceLockfileSha256', 'harness.metadata');
  digestAt(metadata, 'benchmarkMeasuredSourcePackageManifestSha256', 'harness.metadata');
  literalAt(metadata, 'benchmarkValidatedManagedPayload', 'harness.metadata', 'exact-head-not-executed');
  literalAt(
    metadata,
    'benchmarkValidatedManagedDependencyInstallation',
    'harness.metadata',
    'bun install --frozen-lockfile',
  );
  literalAt(metadata, 'benchmarkValidatedManagedProcessLeaseInspection', 'harness.metadata', 'complete');
  for (const key of [
    'benchmarkValidatedManagedExecutableSha256',
    'benchmarkValidatedManagedPayloadManifestSha256',
    'benchmarkValidatedManagedReleaseMetadataSha256',
  ]) {
    digestAt(metadata, key, 'harness.metadata');
  }
  positiveNumberAt(metadata, 'benchmarkValidatedManagedPayloadBytes', 'harness.metadata', true);
  positiveNumberAt(metadata, 'benchmarkValidatedManagedPayloadFileCount', 'harness.metadata', true);
  const managedVersion = metadataString(metadata, 'benchmarkValidatedManagedVersion');
  const releaseVersion = releaseEvidenceVersion(metadata);
  if (
    managedVersion !== `${releaseVersion}-local.g${commit}` &&
    managedVersion !== `${releaseVersion}.local.g${commit}`
  ) {
    throw new Error('Performance harness managed version is not bound to its source commit.');
  }
  const managedRuntime = metadataString(metadata, 'benchmarkValidatedManagedRuntime');
  const environmentRuntime = stringAt(environment, 'node', 'harness.environment');
  if (
    !Effect.pipe(environmentRuntime, EffectString.startsWith('bun/')) ||
    managedRuntime !== `bun-${Effect.pipe(environmentRuntime, EffectString.slice(4))}`
  ) {
    throw new Error('Performance harness managed runtime does not match the measured Bun runtime.');
  }
  const target = metadataString(metadata, 'benchmarkValidatedManagedTarget');
  const architecture = stringAt(environment, 'architecture', 'harness.environment');
  if (!Effect.pipe(target, EffectString.endsWith(`-${architecture}`))) {
    throw new Error('Performance harness managed target does not match the measured architecture.');
  }
}

function validateHarnessMeasurements(
  artifact: RetainedPerformanceHarnessArtifact,
  metadata: Record<string, unknown>,
): void {
  const measurements = measurementMap(artifact);
  for (const [name, unit, positive = true] of [
    ['cold-index', 'milliseconds'],
    ['cold-registration-lock-and-database-setup', 'milliseconds'],
    ['cold-inventory-and-extraction', 'milliseconds'],
    ['cold-materialization', 'milliseconds'],
    ['cold-reference-resolution', 'milliseconds'],
    ['cold-activation-lexical-only', 'milliseconds'],
    ['one-file-reindex-index', 'milliseconds'],
    ['one-file-reindex-registration-lock-and-database-setup', 'milliseconds'],
    ['one-file-reindex-post-committed-scan-overlay-and-workspace', 'milliseconds'],
    ['one-file-reindex-incremental-work-attribution-context-files-n1', 'count'],
    ['one-file-reindex-incremental-work-base-facts-loaded-n1', 'count'],
    ['one-file-reindex-incremental-work-changed-files-n1', 'count'],
    ['one-file-reindex-incremental-work-deleted-files-n1', 'count', false],
    ['one-file-reindex-incremental-work-fact-bytes-n1', 'bytes'],
    ['one-file-reindex-incremental-work-inventory-files-inspected-n1', 'count'],
    ['one-file-reindex-incremental-work-planned-rows-n1', 'count'],
    ['one-file-reindex-incremental-work-probed-dependency-paths-n1', 'count', false],
    ['one-file-reindex-incremental-work-source-bytes-n1', 'bytes'],
    ['one-file-reindex-incremental-work-total-files-n1', 'count'],
    ['same-overlay-full-rebuild-index', 'milliseconds'],
    ['hot-exact-lexical-query', 'milliseconds'],
    ['cold-materialized-file-rows', 'count'],
    ['cold-materialized-symbol-rows', 'count'],
    ['cold-materialized-edge-rows', 'count'],
    ['cold-materialization-deduplicated-reference-rows-n1', 'count', false],
    ['cold-materialized-reference-candidate-rows-n1', 'count'],
    ['cold-materialized-lookup-key-rows-n1', 'count'],
    ['cold-materialized-lexical-term-rows', 'count'],
    ['sqlite-main-disk', 'bytes'],
    ['cold-process-peak-rss', 'bytes'],
    ['cold-sqlite-wal-peak-observed', 'bytes', false],
    ['cold-sqlite-temp-peak-observed', 'bytes', false],
    ['cold-sqlite-durable-database-pages-high-water-n1', 'bytes', false],
    ['primary-query-structural-parity', 'count'],
    ['structural-graph-digest-parity', 'count'],
    ['manager-catalog-cold', 'milliseconds'],
    ['manager-catalog-warm', 'milliseconds'],
    ['manager-overview-cold', 'milliseconds'],
    ['manager-overview-warm', 'milliseconds'],
    ['manager-detail-cold', 'milliseconds'],
    ['manager-node-detail-cold', 'milliseconds'],
    ['manager-layout-preparation-proxy', 'milliseconds'],
    ['manager-response-payload', 'bytes'],
    ['manager-bounded-query', 'milliseconds'],
    ['manager-bounded-query-payload', 'bytes'],
    ['manager-overview-node-count', 'count'],
    ['manager-overview-edge-count', 'count', false],
    ['manager-detail-node-count', 'count'],
    ['manager-detail-edge-count', 'count', false],
    ['cold-sqlite-durable-database-growth', 'bytes'],
    ['cold-durable-filesystem-growth', 'bytes'],
    ['cold-sqlite-journal-peak-observed', 'bytes', false],
    ['concurrent-worktree-isolation-duration', 'milliseconds'],
  ] as const) {
    requiredMeasurement(measurements, name, unit, positive);
  }
  for (const {harness} of harnessLanguageControls) {
    const files = requiredMeasurement(measurements, `cold-materialized-file-rows-language-${harness}`, 'count');
    requiredMeasurement(measurements, `external-query-cold-${harness}-duration`, 'milliseconds');
    const returned = requiredMeasurement(measurements, `external-query-cold-${harness}-returned-nodes`, 'count');
    const expected = requiredMeasurement(
      measurements,
      `external-query-cold-${harness}-expected-path-language-nodes`,
      'count',
    );
    const parity = requiredMeasurement(
      measurements,
      `external-query-${harness}-same-overlay-structural-parity`,
      'count',
    );
    if (files.minimum < 1 || returned.minimum < 1 || expected.minimum < 1 || parity.minimum < 1) {
      throw new Error(`Performance harness ${harness} control did not pass every retained sample.`);
    }
  }
  for (const name of ['primary-query-structural-parity', 'structural-graph-digest-parity']) {
    if (requiredMeasurement(measurements, name, 'count').minimum < 1) {
      throw new Error(`Performance harness ${name} did not pass.`);
    }
  }
  literalAt(metadata, 'retrievalMode', 'harness.metadata', 'lexical-only');
}

/**
 * Validates the complete benchmark harness artifact stored as the public evidence file.
 * The site derives every displayed measurement and provenance field from this one artifact.
 */
export function validateRetainedPerformancePayload(input: unknown): RetainedPerformancePayload {
  rejectUnexpectedFields(input, 'harness', [
    'createdAt',
    'environment',
    'measurements',
    'metadata',
    'suite',
    'version',
    'warmups',
  ]);
  const payload = decodeRetainedPerformancePayload(input);
  recordAt(payload, 'harness', ['createdAt', 'environment', 'measurements', 'metadata', 'suite', 'version', 'warmups']);
  literalAt(payload, 'suite', 'harness', 'code-graph-external-repository-v1');
  literalAt(payload, 'version', 'harness', 1);
  numberAt(payload, 'warmups', 'harness', true);
  const createdAt = stringAt(payload, 'createdAt', 'harness');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(createdAt)) {
    throw new Error('Performance harness createdAt must be an ISO-8601 UTC timestamp.');
  }

  const environmentInput = openRecordAt(payload.environment, 'harness.environment');
  const environmentKeys = [
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
    ...('model' in environmentInput ? ['model'] : []),
  ];
  const environment = recordAt(environmentInput, 'harness.environment', environmentKeys);
  for (const key of ['architecture', 'cpu', 'fixtureHash', 'node', 'operatingSystem', 'packageManager']) {
    stringAt(environment, key, 'harness.environment');
  }
  positiveNumberAt(environment, 'memoryBytes', 'harness.environment', true);
  literalAt(environment, 'runner', 'harness.environment', 'threadnote-code-graph-e2e');
  literalAt(environment, 'runnerVersion', 'harness.environment', '1');
  if ('model' in environment) {
    const model = recordAt(environment.model, 'harness.environment.model', ['backend', 'id', 'revision']);
    for (const key of ['backend', 'id', 'revision']) stringAt(model, key, 'harness.environment.model');
  }

  if (!EffectArray.isArray(payload.measurements) || payload.measurements.length === 0) {
    throw new Error('Performance harness measurements must be a non-empty array.');
  }
  for (const [index, inputMeasurement] of payload.measurements.entries()) {
    const measurement = recordAt(inputMeasurement, `harness.measurements[${index}]`, [
      'maximum',
      'mean',
      'minimum',
      'name',
      'p50',
      'p95',
      'p99',
      'samples',
      'unit',
    ]);
    stringAt(measurement, 'name', `harness.measurements[${index}]`);
    const minimum = numberAt(measurement, 'minimum', `harness.measurements[${index}]`);
    const p50 = numberAt(measurement, 'p50', `harness.measurements[${index}]`);
    const p95 = numberAt(measurement, 'p95', `harness.measurements[${index}]`);
    const p99 = numberAt(measurement, 'p99', `harness.measurements[${index}]`);
    const maximum = numberAt(measurement, 'maximum', `harness.measurements[${index}]`);
    const mean = numberAt(measurement, 'mean', `harness.measurements[${index}]`);
    positiveNumberAt(measurement, 'samples', `harness.measurements[${index}]`, true);
    if (!['bytes', 'count', 'milliseconds', 'operations_per_second', 'percent'].includes(String(measurement.unit))) {
      throw new Error(`Performance harness measurement ${String(measurement.name)} has an invalid unit.`);
    }
    if (minimum > p50 || p50 > p95 || p95 > p99 || p99 > maximum || mean < minimum || mean > maximum) {
      throw new Error(`Performance harness measurement ${String(measurement.name)} is not monotonic.`);
    }
  }

  const metadata = openRecordAt(payload.metadata, 'harness.metadata');
  for (const [key, value] of EffectRecord.toEntries(metadata)) {
    if (
      !['boolean', 'number', 'string'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw new Error(`Performance harness metadata.${key} must be a finite primitive value.`);
    }
  }
  validateHarnessRuntimeProvenance(environment, metadata);
  const sourceCommit = stringAt(environment, 'commit', 'harness.environment');
  const repositoryCommit = metadataString(metadata, 'externalRepositoryCommit');
  if (
    !sha40Pattern.test(repositoryCommit) ||
    environment.fixtureHash !== `external-code-graph-v1:${repositoryCommit}`
  ) {
    throw new Error('Performance harness external repository identity is not bound to its exact commit.');
  }
  literalAt(
    metadata,
    'externalRepositoryMode',
    'harness.metadata',
    'clean checkout with a byte-compared, scoped one-file overlay',
  );
  const repositoryName = metadataString(metadata, 'externalRepositoryName');
  const repositoryUrl = metadataString(metadata, 'externalRepositoryUrl');
  try {
    const parsed = new URL(repositoryUrl);
    const expectedPath = `/${trimBoundaryCharacters(repositoryName, '/')}`;
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'github.com' ||
      Effect.pipe(parsed.pathname, EffectString.replace(/\.git$/, '')) !== expectedPath
    ) {
      throw new Error('mismatch');
    }
  } catch {
    throw new Error('Performance harness repository name and public GitHub URL do not match.');
  }
  const releaseEvidenceSha = metadataString(metadata, 'releaseEvidenceSha');
  const releaseEvidenceHarnessCommit = metadataString(metadata, 'releaseEvidenceHarnessCommit');
  const releaseEvidenceSourceMode = metadataString(metadata, 'releaseEvidenceSourceMode');
  let releaseEvidenceHarnessDeltaPaths: readonly string[] = [];
  try {
    const parsed = JSON.parse(metadataString(metadata, 'releaseEvidenceHarnessDeltaPaths'));
    if (EffectArray.isArray(parsed) && EffectArray.every(parsed, path => typeof path === 'string')) {
      releaseEvidenceHarnessDeltaPaths = parsed;
    }
  } catch {
    // The fail-closed provenance check below reports malformed path evidence.
  }
  const canonicalHarnessDelta =
    releaseEvidenceHarnessDeltaPaths.length > 0 &&
    new Set(releaseEvidenceHarnessDeltaPaths).size === releaseEvidenceHarnessDeltaPaths.length &&
    EffectArray.every(releaseEvidenceHarnessDeltaPaths, path =>
      new Set<string>(RELEASE_EVIDENCE_HARNESS_DELTA_PATHS).has(path),
    ) &&
    JSON.stringify([...releaseEvidenceHarnessDeltaPaths].sort()) === JSON.stringify(releaseEvidenceHarnessDeltaPaths);
  if (
    (releaseEvidenceSourceMode === 'exact-release' &&
      (releaseEvidenceSha !== sourceCommit ||
        releaseEvidenceHarnessCommit !== sourceCommit ||
        metadata.releaseEvidenceHarnessDeltaPaths !== '[]')) ||
    (releaseEvidenceSourceMode === 'release-plus-reviewed-harness-delta' &&
      (releaseEvidenceHarnessCommit !== sourceCommit ||
        releaseEvidenceSha === sourceCommit ||
        !canonicalHarnessDelta)) ||
    (releaseEvidenceSourceMode !== 'exact-release' &&
      releaseEvidenceSourceMode !== 'release-plus-reviewed-harness-delta')
  ) {
    throw new Error('Performance harness release evidence is not bound to its source and reviewed harness delta.');
  }
  literalAt(metadata, 'releaseEvidenceResolvedSha', 'harness.metadata', releaseEvidenceSha);
  positiveNumberAt(metadata, 'benchmarkLogicalCpuCount', 'harness.metadata', true);
  metadataString(metadata, 'benchmarkDiskMedium');
  metadataString(metadata, 'benchmarkDiskFilesystem');
  positiveNumberAt(metadata, 'benchmarkInventoryEligibleFiles', 'harness.metadata', true);
  metadataNumber(metadata, 'benchmarkInventoryExcludedFiles', true);
  literalAt(metadata, 'managerNodeBudget', 'harness.metadata', retainedManagerNodeBudget);
  literalAt(metadata, 'managerEdgeBudget', 'harness.metadata', retainedManagerEdgeBudget);
  literalAt(metadata, 'managerSnapshotBindingPassed', 'harness.metadata', true);
  literalAt(metadata, 'managerRequestCancellationPassed', 'harness.metadata', true);
  literalAt(metadata, 'managerStaleResponseRejectionPassed', 'harness.metadata', true);
  literalAt(
    metadata,
    'managerRequestLifecycleControl',
    'harness.metadata',
    'real Manager queries through the GraphWorkspace request gate: superseding aborts an in-flight request; a completed late response is rejected',
  );
  const simultaneousWorktrees = positiveNumberAt(metadata, 'simultaneousWorktrees', 'harness.metadata', true);
  if (simultaneousWorktrees < 2) throw new Error('Performance harness must exercise concurrent worktrees.');
  literalAt(metadata, 'worktreeIsolationPassed', 'harness.metadata', true);
  literalAt(metadata, 'worktreeIsolationTopology', 'harness.metadata', retainedWorktreeIsolationTopology);
  literalAt(metadata, 'worktreeIsolationIndexedFiles', 'harness.metadata', retainedWorktreeIsolationIndexedFiles);
  for (const key of [
    'structuralGraphDigestCold',
    'structuralGraphDigestIncremental',
    'structuralGraphDigestSameOverlayReference',
  ]) {
    digestAt(metadata, key, 'harness.metadata');
  }
  if (metadata.structuralGraphDigestIncremental !== metadata.structuralGraphDigestSameOverlayReference) {
    throw new Error('Performance harness overlay digests must match before publication.');
  }
  if (!/^\d+\.\d+\.\d+/.test(metadataString(metadata, 'sqliteVersion'))) {
    throw new Error('Performance harness SQLite version is invalid.');
  }
  parseHarnessControls(metadata);
  validateHarnessMeasurements(payload, metadata);
  validateExternalRepositoryEvidence(payload, {
    expectedControlLanguages: EffectArray.map(harnessLanguageControls, control => control.harness),
    managerEdgeBudget: retainedManagerEdgeBudget,
    managerNodeBudget: retainedManagerNodeBudget,
    releaseBound: true,
  });
  return payload;
}

export function retainedPerformanceArtifactFromHarness(
  input: unknown,
  binding: Readonly<{
    artifactUrl: string;
    artifactSha256: string;
    generatedAt: string;
    currentLockfileSha256: string;
    currentPackageManifestSha256: string;
  }>,
): RetainedPerformanceArtifact {
  const harness = validateRetainedPerformancePayload(input);
  const metadata: Record<string, unknown> = harness.metadata;
  if (binding.generatedAt !== harness.createdAt) {
    throw new Error('Performance binding timestamp does not match the retained harness artifact.');
  }
  for (const [actual, metadataKey, label] of [
    [binding.currentLockfileSha256, 'benchmarkMeasuredSourceLockfileSha256', 'lockfile'],
    [binding.currentPackageManifestSha256, 'benchmarkMeasuredSourcePackageManifestSha256', 'package manifest'],
  ] as const) {
    if (!sha256Pattern.test(actual) || actual !== metadata[metadataKey]) {
      throw new Error(`Performance harness ${label} SHA-256 does not match the bound source tree.`);
    }
  }
  const measurements = measurementMap(harness);
  const measurement = (name: string, unit: HarnessMeasurement['unit'], positive = true) =>
    requiredMeasurement(measurements, name, unit, positive);
  const count = (name: string) => measurement(name, 'count').maximum;
  const duration = (name: string) => measurement(name, 'milliseconds').maximum;
  const bytes = (name: string, positive = true) => measurement(name, 'bytes', positive).maximum;
  const controlsInput = parseHarnessControls(metadata);
  const controlAt = (
    display: PerformanceControlLanguage,
    language: string,
  ): RetainedPerformanceArtifact['controls'][PerformanceControlLanguage] => ({
    ...controlsInput[display],
    milliseconds: duration(`external-query-cold-${language}-duration`),
    passed: true,
  });
  const controls: RetainedPerformanceArtifact['controls'] = {
    bazel: controlAt('bazel', 'bazel-build'),
    java: controlAt('java', 'java'),
    kotlin: controlAt('kotlin', 'kotlin'),
    typescript: controlAt('typescript', 'typescript'),
  };
  const query = measurement('hot-exact-lexical-query', 'milliseconds');
  const managerQuery = measurement('manager-bounded-query', 'milliseconds');

  const artifact: RetainedPerformanceArtifact = {
    schemaVersion: 1,
    status: 'verified',
    artifact: {
      url: binding.artifactUrl,
      sha256: binding.artifactSha256,
      generatedAt: binding.generatedAt,
    },
    source: {
      threadnote: {
        version: `v${releaseEvidenceVersion(metadata)}`,
        commit: harness.environment.commit,
        lockfileSha256: binding.currentLockfileSha256,
        packageManifestSha256: binding.currentPackageManifestSha256,
      },
      repository: {
        name: metadataString(metadata, 'externalRepositoryName'),
        url: metadataString(metadata, 'externalRepositoryUrl'),
        commit: metadataString(metadata, 'externalRepositoryCommit'),
        checkout: 'clean',
        publicVerification: literalValueAt(
          metadata,
          'externalRepositoryPublicVerification',
          'anonymous-https-exact-commit-fetch',
        ),
      },
    },
    runner: {
      class: metadataString(metadata, 'runnerClass'),
      id: metadataString(metadata, 'runnerIdentity'),
      hardware: harness.environment.cpu,
      operatingSystem: harness.environment.operatingSystem,
      architecture: harness.environment.architecture,
      memoryBytes: harness.environment.memoryBytes,
      logicalCpuCount: metadataNumber(metadata, 'benchmarkLogicalCpuCount', true),
      runtime: {
        name: 'Bun',
        version: Effect.pipe(harness.environment.node, EffectString.slice(4)),
        target: metadataString(metadata, 'benchmarkValidatedManagedTarget'),
        executionMode: 'local-source-application-layer',
        managedPayloadValidation: 'exact-head-not-executed',
        dependencyInstallation: 'bun install --frozen-lockfile',
        executableSha256: metadataString(metadata, 'benchmarkValidatedManagedExecutableSha256'),
        payloadManifestSha256: metadataString(metadata, 'benchmarkValidatedManagedPayloadManifestSha256'),
        releaseMetadataSha256: metadataString(metadata, 'benchmarkValidatedManagedReleaseMetadataSha256'),
        payloadBytes: metadataNumber(metadata, 'benchmarkValidatedManagedPayloadBytes', true),
        payloadFileCount: metadataNumber(metadata, 'benchmarkValidatedManagedPayloadFileCount', true),
        processLeaseInspection: 'complete',
      },
      database: {name: 'SQLite', version: metadataString(metadata, 'sqliteVersion')},
      disk: {
        medium: metadataString(metadata, 'benchmarkDiskMedium'),
        filesystem: metadataString(metadata, 'benchmarkDiskFilesystem'),
      },
    },
    inventory: {
      eligibleFiles: metadataNumber(metadata, 'benchmarkInventoryEligibleFiles', true),
      indexedFiles: count('cold-materialized-file-rows'),
      excludedFiles: metadataNumber(metadata, 'benchmarkInventoryExcludedFiles', true),
      languages: {
        bazel: count('cold-materialized-file-rows-language-bazel-build'),
        java: count('cold-materialized-file-rows-language-java'),
        kotlin: count('cold-materialized-file-rows-language-kotlin'),
        typescript: count('cold-materialized-file-rows-language-typescript'),
      },
    },
    graph: {
      symbols: count('cold-materialized-symbol-rows'),
      relationships: count('cold-materialized-edge-rows'),
      referenceCandidates: count('cold-materialized-reference-candidate-rows-n1'),
      lookupKeys: count('cold-materialized-lookup-key-rows-n1'),
      lexicalPostings: count('cold-materialized-lexical-term-rows'),
    },
    phases: {
      cold: {
        totalMilliseconds: duration('cold-index'),
        discoveryMilliseconds: duration('cold-registration-lock-and-database-setup'),
        extractionMilliseconds: duration('cold-inventory-and-extraction'),
        materializationMilliseconds: duration('cold-materialization'),
        resolutionMilliseconds: duration('cold-reference-resolution'),
        activationMilliseconds: duration('cold-activation-lexical-only'),
      },
      incremental: {
        totalMilliseconds: duration('one-file-reindex-index'),
        registrationMilliseconds: duration('one-file-reindex-registration-lock-and-database-setup'),
        postCommittedScanMilliseconds: duration('one-file-reindex-post-committed-scan-overlay-and-workspace'),
        attributionContextFiles: count('one-file-reindex-incremental-work-attribution-context-files-n1'),
        baseFactsLoaded: count('one-file-reindex-incremental-work-base-facts-loaded-n1'),
        changedFiles: count('one-file-reindex-incremental-work-changed-files-n1'),
        deletedFiles: measurement('one-file-reindex-incremental-work-deleted-files-n1', 'count', false).maximum,
        factBytes: bytes('one-file-reindex-incremental-work-fact-bytes-n1'),
        inventoryFilesInspected: count('one-file-reindex-incremental-work-inventory-files-inspected-n1'),
        plannedRows: count('one-file-reindex-incremental-work-planned-rows-n1'),
        probedDependencyPaths: measurement(
          'one-file-reindex-incremental-work-probed-dependency-paths-n1',
          'count',
          false,
        ).maximum,
        sourceBytes: bytes('one-file-reindex-incremental-work-source-bytes-n1'),
        totalFiles: count('one-file-reindex-incremental-work-total-files-n1'),
      },
      independentRebuild: {totalMilliseconds: duration('same-overlay-full-rebuild-index')},
    },
    queries: {
      sampleCount: query.samples,
      p50Milliseconds: query.p50,
      p95Milliseconds: query.p95,
      maxMilliseconds: query.maximum,
    },
    controls,
    parity: {
      cleanColdDigest: metadataString(metadata, 'structuralGraphDigestCold'),
      incrementalOverlayDigest: metadataString(metadata, 'structuralGraphDigestIncremental'),
      independentOverlayDigest: metadataString(metadata, 'structuralGraphDigestSameOverlayReference'),
      incrementalMatchesIndependent: true,
    },
    storage: {
      databaseGrowthBytes: bytes('cold-sqlite-durable-database-growth'),
      databaseBytes: bytes('sqlite-main-disk'),
      peakResidentBytes: bytes('cold-process-peak-rss'),
      peakWalBytes: bytes('cold-sqlite-wal-peak-observed', false),
      peakTemporaryBytes: bytes('cold-sqlite-temp-peak-observed', false),
      durableFilesystemGrowthBytes: bytes('cold-durable-filesystem-growth'),
      peakJournalBytes: bytes('cold-sqlite-journal-peak-observed', false),
    },
    manager: {
      catalogColdMilliseconds: duration('manager-catalog-cold'),
      catalogWarmMilliseconds: duration('manager-catalog-warm'),
      overviewColdMilliseconds: duration('manager-overview-cold'),
      overviewEdgeCount: count('manager-overview-edge-count'),
      overviewNodeCount: count('manager-overview-node-count'),
      overviewWarmMilliseconds: duration('manager-overview-warm'),
      detailColdMilliseconds: duration('manager-detail-cold'),
      nodeDetailColdMilliseconds: duration('manager-node-detail-cold'),
      detailEdgeCount: count('manager-detail-edge-count'),
      detailNodeCount: count('manager-detail-node-count'),
      layoutPreparationProxyMilliseconds: duration('manager-layout-preparation-proxy'),
      maxPayloadBytes: bytes('manager-response-payload'),
      querySampleCount: managerQuery.samples,
      queryP50Milliseconds: managerQuery.p50,
      queryP95Milliseconds: managerQuery.p95,
      queryMaxMilliseconds: managerQuery.maximum,
      queryMaxPayloadBytes: bytes('manager-bounded-query-payload'),
      nodeBudget: metadataNumber(metadata, 'managerNodeBudget', true),
      edgeBudget: metadataNumber(metadata, 'managerEdgeBudget', true),
      requestCancellationPassed: true,
      snapshotBindingPassed: true,
      staleResponseRejectionPassed: true,
    },
    concurrency: {
      cleanupPassed: true,
      simultaneousWorktrees: metadataNumber(metadata, 'simultaneousWorktrees', true),
      durationMilliseconds: duration('concurrent-worktree-isolation-duration'),
      indexedFiles: retainedWorktreeIsolationIndexedFiles,
      topology: retainedWorktreeIsolationTopology,
      isolationPassed: true,
    },
  };
  assertRetainedPerformanceArtifact(artifact);
  return artifact;
}

export function pendingPerformanceEvidence(reason: string): PerformanceEvidence {
  if (Effect.pipe(reason, EffectString.trim).length === 0)
    throw new Error('Pending performance evidence requires a reason.');
  return {state: 'pending', reason};
}
