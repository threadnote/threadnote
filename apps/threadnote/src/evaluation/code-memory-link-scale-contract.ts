import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {benchmarkMeasurement, type BenchmarkMeasurementV1} from '@threadnote/evidence/benchmark';
import {Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_MEMORY_LINK_SCALE_VERSION = 1 as const;
export const CODE_MEMORY_LINK_SCALE_ID = 'code-memory-link-inverse-scale-v1' as const;
export const CODE_MEMORY_LINK_SCALE_ARTIFACT_ROOT =
  'apps/threadnote/test/evaluation/retained/code-memory-link-scale' as const;
export const CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS = 'github-hosted-macos-15-ARM64' as const;
export const CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY = 'threadnote/threadnote' as const;
export const CODE_MEMORY_LINK_SCALE_LEGACY_GITHUB_REPOSITORY = 'Kashkovsky/threadnote' as const;
export const CODE_MEMORY_LINK_SCALE_TRANSFERRED_GITHUB_REPOSITORY = CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY;
export const CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORIES = [
  CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY,
  CODE_MEMORY_LINK_SCALE_LEGACY_GITHUB_REPOSITORY,
] as const;
export const CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID = '1230070449' as const;
export const CODE_MEMORY_LINK_SCALE_GITHUB_JOB = 'code-memory-link-inverse-scale' as const;
export const CODE_MEMORY_LINK_SCALE_GITHUB_JOB_NAME =
  'Code-to-memory inverse selector · 100,000 memories · release macOS class' as const;
export const CODE_MEMORY_LINK_SCALE_CAPTURE_STEP =
  'Build and gate the production inverse-selector path at 100,000 memories' as const;
export const CODE_MEMORY_LINK_SCALE_ATTEST_STEP = 'Attest the inverse-selector capture' as const;
export const CODE_MEMORY_LINK_SCALE_GITHUB_WORKFLOW_PATH = '.github/workflows/benchmarks.yml' as const;
export const CODE_MEMORY_LINK_SCALE_SCENARIOS = [
  'file-backlinks',
  'symbol-backlink',
  'dense-shared-selector',
  'no-answer',
] as const;
export const CODE_MEMORY_LINK_SCALE_SEED = 'threadnote-code-memory-link-inverse-scale-v1-2026-08-29' as const;

export type CodeMemoryLinkScaleGitHubRepository = (typeof CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORIES)[number];

export function isCodeMemoryLinkScaleGitHubRepository(
  repository: string,
): repository is CodeMemoryLinkScaleGitHubRepository {
  return EffectArray.some(CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORIES, candidate => candidate === repository);
}

export type CodeMemoryLinkScaleScenarioId = (typeof CODE_MEMORY_LINK_SCALE_SCENARIOS)[number];
export type CodeMemoryLinkScaleEvidenceClass = 'development-smoke' | 'release-scale';

export const CODE_MEMORY_LINK_SCALE_FIXTURE = Object.freeze({
  foreignRepositoryId: Effect.pipe('b', EffectString.repeat(64)),
  project: 'threadnote-inverse-scale',
  repositoryId: Effect.pipe('a', EffectString.repeat(64)),
  seed: CODE_MEMORY_LINK_SCALE_SEED,
  scenarios: [
    {
      codePath: 'src/scale/file-backlinks.ts',
      expectedMemoryPaths: ['direct/direct-file-a.md', 'direct/direct-file-b.md'],
      expectedTruncatedSelectorCount: 0,
      id: 'file-backlinks',
    },
    {
      codePath: 'src/scale/symbol-backlink.ts',
      expectedMemoryPaths: ['direct/direct-symbol.md'],
      expectedTruncatedSelectorCount: 0,
      id: 'symbol-backlink',
      nodeId: `cgs_${Effect.pipe('c', EffectString.repeat(32))}`,
    },
    {
      codePath: 'src/scale/dense-shared-selector.ts',
      expectedMemoryPaths: Array.from(
        {length: 8},
        (_, index) => `noise/000/${Effect.pipe(String(index), EffectString.padStart(6, '0'))}.md`,
      ),
      expectedTruncatedSelectorCount: 2,
      id: 'dense-shared-selector',
      nodeId: `cgs_${Effect.pipe('d', EffectString.repeat(32))}`,
    },
    {
      codePath: 'src/scale/no-answer.ts',
      expectedMemoryPaths: [],
      expectedTruncatedSelectorCount: 0,
      id: 'no-answer',
    },
  ],
  user: 'inverse-scale',
} as const);

/** Changing fixture identity requires complete source review and an explicit hash update. */
export const CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH =
  '263da51c0e66a0409e365de96aea9cde3f3d4b607b414a0864684bea9cba55a6' as const;

export interface CodeMemoryLinkScaleBudgetV1 {
  readonly corpusMemoryCount: number;
  readonly denseBacklinkMemoryCount: number;
  readonly directBacklinkMemoryCount: number;
  readonly id: typeof CODE_MEMORY_LINK_SCALE_ID;
  readonly isolationDecoyMemoryCount: number;
  readonly maximumAddedPeakRssBytes: number;
  readonly maximumCorpusBytes: number;
  readonly maximumIndexBuildMilliseconds: number;
  readonly maximumLookupP95Milliseconds: number;
  readonly maximumLookupSampleMilliseconds: number;
  readonly maximumMaterializationMilliseconds: number;
  readonly maximumRecallStorageBytes: number;
  readonly minimumSamples: number;
  readonly minimumWarmups: number;
  readonly queryLimit: number;
  readonly seed: typeof CODE_MEMORY_LINK_SCALE_SEED;
  readonly version: typeof CODE_MEMORY_LINK_SCALE_VERSION;
}

export const CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET: CodeMemoryLinkScaleBudgetV1 = Object.freeze({
  corpusMemoryCount: 100_000,
  denseBacklinkMemoryCount: 99_996,
  directBacklinkMemoryCount: 3,
  id: CODE_MEMORY_LINK_SCALE_ID,
  isolationDecoyMemoryCount: 1,
  maximumAddedPeakRssBytes: 3 * 1024 * 1024 * 1024,
  maximumCorpusBytes: 256 * 1024 * 1024,
  maximumIndexBuildMilliseconds: 10 * 60 * 1_000,
  maximumLookupP95Milliseconds: 250,
  maximumLookupSampleMilliseconds: 1_000,
  maximumMaterializationMilliseconds: 5 * 60 * 1_000,
  maximumRecallStorageBytes: 2 * 1024 * 1024 * 1024,
  minimumSamples: 25,
  minimumWarmups: 5,
  queryLimit: 8,
  seed: CODE_MEMORY_LINK_SCALE_SEED,
  version: CODE_MEMORY_LINK_SCALE_VERSION,
});

export const CODE_MEMORY_LINK_SCALE_EXECUTION = Object.freeze({
  corpusStorage: 'canonical-memory-files',
  inverseLookup: 'loadRecallCodeLinks-real-sqlite-canonical-reread',
  queryLimit: CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET.queryLimit,
  recallIndex: 'loadRecallIndexData-force-refresh-real-sqlite',
  sampling: 'cold-then-sequential-warmups-and-measured-samples',
} as const);

/** Smoke runs may use fewer observations, but never unbounded statistical padding. */
export const CODE_MEMORY_LINK_SCALE_DEVELOPMENT_MAXIMUM_SAMPLES = 25;
export const CODE_MEMORY_LINK_SCALE_DEVELOPMENT_MAXIMUM_WARMUPS = 5;

export interface CodeMemoryLinkScaleLookupObservationV1 {
  readonly canonicalMismatchCount: number;
  readonly milliseconds: number;
  readonly returnedUris: readonly string[];
  readonly truncatedSelectorCount: number;
}

export interface CodeMemoryLinkScaleScenarioCaptureV1 {
  readonly cold: CodeMemoryLinkScaleLookupObservationV1;
  readonly expectedTruncatedSelectorCount: number;
  readonly expectedUris: readonly string[];
  readonly id: CodeMemoryLinkScaleScenarioId;
  readonly samples: readonly CodeMemoryLinkScaleLookupObservationV1[];
  readonly warmups: readonly CodeMemoryLinkScaleLookupObservationV1[];
}

export interface CodeMemoryLinkScaleRuntimeCaptureV1 {
  readonly corpus: {
    readonly corpusBytes: number;
    readonly denseBacklinkMemoryCount: number;
    readonly directBacklinkMemoryCount: number;
    readonly indexedMemoryCount: number;
    readonly isolationDecoyMemoryCount: number;
    readonly materializedMemoryCount: number;
    readonly noiseMemoryCount: number;
  };
  readonly fixtureHash: string;
  readonly resources: {
    readonly addedPeakRssBytes: number;
    readonly baselineRssBytes: number;
    readonly indexBuildMilliseconds: number;
    readonly materializationMilliseconds: number;
    readonly peakRssBytes: number;
    readonly recallDatabaseBytes: number;
    readonly recallStorageBytes: number;
  };
  readonly scenarios: readonly CodeMemoryLinkScaleScenarioCaptureV1[];
}

export interface CodeMemoryLinkScaleIdentityV1 {
  readonly architecture: string;
  readonly builtArtifactSha256: string;
  readonly candidateCommit: string;
  readonly candidateVersion: string;
  readonly cpu: string;
  readonly dirty: boolean;
  readonly gitStatusObserved: boolean;
  readonly github: CodeMemoryLinkScaleGithubProvenanceV1;
  readonly memoryBytes: number;
  readonly invocationMode: CodeMemoryLinkScaleEvidenceClass;
  readonly observedCommit: string;
  readonly operatingSystem: string;
  readonly packageManager: string;
  readonly runnerClass: string;
  readonly runnerArchitecture: string;
  readonly runnerEnvironment: string;
  readonly runnerOperatingSystem: string;
  readonly runtime: string;
  readonly sourceVersion: string;
}

/** Captured claims; release proof additionally requires independent candidate and runner bindings. */
export interface CodeMemoryLinkScaleGithubProvenanceV1 {
  readonly actions: boolean;
  readonly eventName: string;
  readonly job: string;
  readonly ref: string;
  readonly repository: string;
  readonly repositoryId: string;
  readonly runAttempt: number;
  readonly runId: number;
  readonly sha: string;
  readonly workflowRef: string;
  readonly workflowSha: string;
}

/** External candidate facts read from `git show C:package.json`, never from the retained artifact. */
export interface CodeMemoryLinkScaleCandidateBindingV1 {
  readonly candidateCommit: string;
  readonly candidateVersion: string;
  readonly packageManager: string;
  readonly runtime: string;
  readonly sourceVersion: string;
}

/** Trusted verifier input from the actual GitHub run/context, supplied separately from retained evidence.
 * The caller must authenticate its source; copying identity fields from the artifact is not a binding.
 */
export interface CodeMemoryLinkScaleRunnerBindingV1 {
  readonly github: CodeMemoryLinkScaleGithubProvenanceV1;
  readonly runnerClass: string;
  readonly runnerArchitecture: string;
  readonly runnerEnvironment: string;
  readonly runnerOperatingSystem: string;
}

export function parseCodeMemoryLinkScaleRunnerBindingV1(value: unknown): CodeMemoryLinkScaleRunnerBindingV1 {
  const binding = record(value, 'trusted runner binding');
  exactKeys(binding, ['github', 'runnerClass', 'runnerArchitecture', 'runnerEnvironment', 'runnerOperatingSystem']);
  return {
    github: parseGithubProvenance(binding.github),
    runnerClass: nonEmptyString(binding.runnerClass, 'trusted runner class'),
    runnerArchitecture: nonEmptyString(binding.runnerArchitecture, 'trusted runner architecture'),
    runnerEnvironment: nonEmptyString(binding.runnerEnvironment, 'trusted runner environment'),
    runnerOperatingSystem: nonEmptyString(binding.runnerOperatingSystem, 'trusted runner operating system'),
  };
}

const PACKAGE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function codeMemoryLinkScaleCandidateBindingV1(
  candidateCommit: string,
  packageManifest: unknown,
): CodeMemoryLinkScaleCandidateBindingV1 {
  const normalizedCommit = lowercaseHex(candidateCommit, 40, 'candidate binding commit');
  const manifest = record(packageManifest, 'candidate package manifest');
  const candidateVersion = nonEmptyString(manifest.version, 'candidate package version');
  if (!PACKAGE_VERSION.test(candidateVersion)) invalid('candidate package version must be an explicit SemVer');
  const packageManager = nonEmptyString(manifest.packageManager, 'candidate package manager');
  if (
    !Effect.pipe(packageManager, EffectString.startsWith('bun@')) ||
    !PACKAGE_VERSION.test(Effect.pipe(packageManager, EffectString.slice('bun@'.length)))
  ) {
    invalid('candidate package manager must pin an explicit Bun version');
  }
  return {
    candidateCommit: normalizedCommit,
    candidateVersion,
    packageManager,
    runtime: `bun/${Effect.pipe(packageManager, EffectString.slice('bun@'.length))}`,
    sourceVersion: `threadnote-${candidateVersion}`,
  };
}

export interface CodeMemoryLinkScaleMetricsV1 {
  readonly boundedResultAccuracy: number;
  readonly canonicalMismatchCount: number;
  readonly directFirstRate: number;
  readonly directPrecision: number;
  readonly directRecall: number;
  readonly duplicateResultCount: number;
  readonly lookupMilliseconds: BenchmarkMeasurementV1;
  readonly maximumReturnedMemories: number;
  readonly noAnswerAccuracy: number;
  readonly queryCount: number;
  readonly scenarioLookupMilliseconds: readonly {
    readonly id: CodeMemoryLinkScaleScenarioId;
    readonly measurement: BenchmarkMeasurementV1;
  }[];
  readonly truncatedSelectorCount: number;
  readonly unexpectedResultCount: number;
  readonly warmupCountMinimum: number;
}

export interface CodeMemoryLinkScaleArtifactV1 {
  readonly budgetHash: string;
  readonly capture: CodeMemoryLinkScaleRuntimeCaptureV1;
  readonly createdAt: string;
  readonly evidenceClass: CodeMemoryLinkScaleEvidenceClass;
  readonly execution: typeof CODE_MEMORY_LINK_SCALE_EXECUTION;
  readonly gate: {readonly failures: readonly string[]; readonly passed: boolean};
  readonly identity: CodeMemoryLinkScaleIdentityV1;
  readonly metrics: CodeMemoryLinkScaleMetricsV1;
  readonly suite: typeof CODE_MEMORY_LINK_SCALE_ID;
  readonly version: typeof CODE_MEMORY_LINK_SCALE_VERSION;
}

export function codeMemoryLinkScaleFixtureHash(): string {
  return sha256HexSync(`${JSON.stringify(CODE_MEMORY_LINK_SCALE_FIXTURE)}\n`);
}

export function codeMemoryLinkScaleArtifactPath(sha256: string): string {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) invalid('artifact path hash must be 64 lowercase hex characters');
  return `${CODE_MEMORY_LINK_SCALE_ARTIFACT_ROOT}/${sha256}.json`;
}

export function codeMemoryLinkScaleExpectedUris(id: CodeMemoryLinkScaleScenarioId): readonly string[] {
  const scenario = EffectOption.getOrUndefined(
    EffectArray.findFirst(CODE_MEMORY_LINK_SCALE_FIXTURE.scenarios, candidate => candidate.id === id),
  )!;
  return EffectArray.map(
    scenario.expectedMemoryPaths,
    memoryPath =>
      `threadnote://user/${CODE_MEMORY_LINK_SCALE_FIXTURE.user}/memories/durable/projects/${CODE_MEMORY_LINK_SCALE_FIXTURE.project}/${memoryPath}`,
  );
}

export function codeMemoryLinkScaleExpectedTruncatedSelectorCount(id: CodeMemoryLinkScaleScenarioId): number {
  return EffectOption.getOrUndefined(
    EffectArray.findFirst(CODE_MEMORY_LINK_SCALE_FIXTURE.scenarios, candidate => candidate.id === id),
  )!.expectedTruncatedSelectorCount;
}

export function codeMemoryLinkScaleBudgetHash(input: CodeMemoryLinkScaleBudgetV1): string {
  return sha256HexSync(`${JSON.stringify(parseCodeMemoryLinkScaleBudgetV1(input))}\n`);
}

/** Reject threshold, corpus, seed, or query-bound weakening. */
export function parseCodeMemoryLinkScaleBudgetV1(value: unknown): CodeMemoryLinkScaleBudgetV1 {
  const budget = record(value, 'budget');
  exactKeys(budget, EffectRecord.keys(CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET));
  for (const [key, expected] of EffectRecord.toEntries(CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET)) {
    if (budget[key] !== expected) invalid(`budget ${key} does not match the reviewed value ${expected}`);
  }
  return {...CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET};
}

/** Compute all correctness/resource metrics and derive release eligibility rather than trusting a label. */
export function evaluateCodeMemoryLinkScaleCapture(input: {
  readonly budget: CodeMemoryLinkScaleBudgetV1 | unknown;
  readonly candidateBinding?: CodeMemoryLinkScaleCandidateBindingV1;
  readonly runnerBinding?: CodeMemoryLinkScaleRunnerBindingV1;
  readonly capture: CodeMemoryLinkScaleRuntimeCaptureV1 | unknown;
  readonly createdAt: string;
  readonly identity: CodeMemoryLinkScaleIdentityV1 | unknown;
}): CodeMemoryLinkScaleArtifactV1 {
  const budget = parseCodeMemoryLinkScaleBudgetV1(input.budget);
  const identity = parseIdentity(input.identity);
  const capture = parseCapture(input.capture, identity.invocationMode);
  const createdAt = isoInstant(input.createdAt, 'createdAt');
  const fixtureHash = codeMemoryLinkScaleFixtureHash();
  const releaseShape =
    identity.invocationMode === 'release-scale' &&
    codeMemoryLinkScaleReleaseIdentityFailures(identity, input.candidateBinding, input.runnerBinding).length === 0 &&
    /^[0-9a-f]{64}$/u.test(identity.builtArtifactSha256) &&
    capture.fixtureHash === CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH &&
    capture.fixtureHash === fixtureHash &&
    capture.corpus.materializedMemoryCount === budget.corpusMemoryCount &&
    capture.corpus.indexedMemoryCount === budget.corpusMemoryCount &&
    EffectArray.every(
      capture.scenarios,
      scenario =>
        scenario.warmups.length === budget.minimumWarmups && scenario.samples.length === budget.minimumSamples,
    );
  const evidenceClass: CodeMemoryLinkScaleEvidenceClass = releaseShape ? 'release-scale' : 'development-smoke';
  const metrics = computeMetrics(capture, budget.queryLimit);
  const failures = gateFailures(
    budget,
    capture,
    identity,
    metrics,
    evidenceClass,
    input.candidateBinding,
    input.runnerBinding,
  ).sort(compareText);
  return {
    budgetHash: codeMemoryLinkScaleBudgetHash(budget),
    capture,
    createdAt,
    evidenceClass,
    execution: CODE_MEMORY_LINK_SCALE_EXECUTION,
    gate: {failures, passed: failures.length === 0},
    identity,
    metrics,
    suite: CODE_MEMORY_LINK_SCALE_ID,
    version: CODE_MEMORY_LINK_SCALE_VERSION,
  };
}

/** Parse retained JSON and rederive every metric, class, and gate decision. */
export function parseCodeMemoryLinkScaleArtifactV1(
  value: unknown,
  budgetInput: CodeMemoryLinkScaleBudgetV1 | unknown,
  candidateBinding?: CodeMemoryLinkScaleCandidateBindingV1,
  runnerBinding?: CodeMemoryLinkScaleRunnerBindingV1,
): CodeMemoryLinkScaleArtifactV1 {
  const artifact = record(value, 'artifact');
  exactKeys(artifact, [
    'budgetHash',
    'capture',
    'createdAt',
    'evidenceClass',
    'execution',
    'gate',
    'identity',
    'metrics',
    'suite',
    'version',
  ]);
  if (artifact.version !== CODE_MEMORY_LINK_SCALE_VERSION) invalid('artifact version must be 1');
  if (artifact.suite !== CODE_MEMORY_LINK_SCALE_ID) invalid(`artifact suite must be ${CODE_MEMORY_LINK_SCALE_ID}`);
  const claimedIdentity = parseIdentity(artifact.identity);
  if (claimedIdentity.invocationMode === 'release-scale' && candidateBinding === undefined) {
    invalid('release-scale artifacts require an independently derived candidate binding');
  }
  if (claimedIdentity.invocationMode === 'release-scale') {
    if (runnerBinding === undefined)
      invalid('release-scale artifacts require an independently supplied runner binding');
    const failures = runnerBindingFailures(claimedIdentity, runnerBinding);
    if (failures.length > 0) invalid(EffectArray.join(failures, '; '));
  }
  const expected = evaluateCodeMemoryLinkScaleCapture({
    budget: budgetInput,
    ...(candidateBinding === undefined ? {} : {candidateBinding}),
    ...(runnerBinding === undefined ? {} : {runnerBinding}),
    capture: artifact.capture,
    createdAt: stringValue(artifact.createdAt, 'artifact createdAt'),
    identity: artifact.identity,
  });
  if (artifact.budgetHash !== expected.budgetHash) invalid('artifact budget hash does not match reviewed budget');
  if (artifact.evidenceClass !== expected.evidenceClass) invalid('artifact evidence class is not derived correctly');
  if (JSON.stringify(artifact.execution) !== JSON.stringify(expected.execution)) {
    invalid('artifact execution path does not match the production scale contract');
  }
  if (JSON.stringify(artifact.metrics) !== JSON.stringify(expected.metrics)) {
    invalid('artifact metrics do not match the retained observations');
  }
  if (JSON.stringify(artifact.gate) !== JSON.stringify(expected.gate)) {
    invalid('artifact gate does not match the retained observations');
  }
  return expected;
}

/** The immutable attestation subject excludes derived metrics, class and gate.
 * Reconstruct these exact bytes from retained evidence, then verify its signature before promotion.
 */
export function codeMemoryLinkScaleAttestationSubjectV1(value: unknown): string {
  const artifact = record(value, 'capture artifact');
  const normalized = evaluateCodeMemoryLinkScaleCapture({
    budget: CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET,
    capture: artifact.capture,
    createdAt: stringValue(artifact.createdAt, 'capture createdAt'),
    identity: artifact.identity,
  });
  return `${JSON.stringify(
    {
      budgetHash: normalized.budgetHash,
      capture: normalized.capture,
      createdAt: normalized.createdAt,
      execution: normalized.execution,
      identity: normalized.identity,
      suite: normalized.suite,
      version: normalized.version,
    },
    undefined,
    2,
  )}\n`;
}

function computeMetrics(
  capture: CodeMemoryLinkScaleRuntimeCaptureV1,
  queryLimit: number,
): CodeMemoryLinkScaleMetricsV1 {
  const all = EffectArray.flatMap(capture.scenarios, scenario => [
    scenario.cold,
    ...scenario.warmups,
    ...scenario.samples,
  ]);
  const measured = EffectArray.flatMap(capture.scenarios, scenario => scenario.samples);
  const positive = EffectArray.filter(capture.scenarios, scenario => scenario.expectedUris.length > 0);
  const noAnswer = EffectArray.filter(capture.scenarios, scenario => scenario.expectedUris.length === 0);
  const positiveObservations = EffectArray.flatMap(positive, scenario =>
    EffectArray.map([scenario.cold, ...scenario.warmups, ...scenario.samples], observation => ({
      observation,
      scenario,
    })),
  );
  const noAnswerObservations = EffectArray.flatMap(noAnswer, scenario => [
    scenario.cold,
    ...scenario.warmups,
    ...scenario.samples,
  ]);
  const expectedPairs = EffectArray.reduce(
    positiveObservations,
    0,
    (total, {scenario}) => total + scenario.expectedUris.length,
  );
  const returnedExpected = EffectArray.reduce(
    positiveObservations,
    0,
    (total, {observation, scenario}) =>
      total +
      EffectArrayPipe(observation.returnedUris, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (uri, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && scenario.expectedUris.includes(uri),
        ),
      ).length,
  );
  const returnedPositive = EffectArray.reduce(
    positiveObservations,
    0,
    (total, {observation}) => total + observation.returnedUris.length,
  );
  const unexpectedResultCount = EffectArray.reduce(
    capture.scenarios,
    0,
    (total, scenario) =>
      total +
      EffectArray.reduce(
        [scenario.cold, ...scenario.warmups, ...scenario.samples],
        0,
        (scenarioTotal, observation) =>
          scenarioTotal +
          EffectArray.filter(observation.returnedUris, uri => !scenario.expectedUris.includes(uri)).length,
      ),
  );
  const duplicateResultCount = EffectArray.reduce(
    all,
    0,
    (total, observation) => total + observation.returnedUris.length - new Set(observation.returnedUris).size,
  );
  return {
    boundedResultAccuracy: mean(
      EffectArray.map(all, observation => (observation.returnedUris.length <= queryLimit ? 1 : 0)),
    ),
    canonicalMismatchCount: EffectArray.reduce(
      all,
      0,
      (total, observation) => total + observation.canonicalMismatchCount,
    ),
    directFirstRate: mean(
      EffectArray.map(positiveObservations, ({observation, scenario}) =>
        observation.returnedUris[0] !== undefined && scenario.expectedUris.includes(observation.returnedUris[0])
          ? 1
          : 0,
      ),
    ),
    directPrecision: ratio(returnedExpected, returnedPositive, 1),
    directRecall: ratio(returnedExpected, expectedPairs, 1),
    duplicateResultCount,
    lookupMilliseconds: benchmarkMeasurement(
      'code-memory-link-inverse-selector',
      'milliseconds',
      EffectArray.map(measured, observation => observation.milliseconds),
    ),
    maximumReturnedMemories: Math.max(0, ...EffectArray.map(all, observation => observation.returnedUris.length)),
    noAnswerAccuracy: mean(
      EffectArray.map(noAnswerObservations, observation => (observation.returnedUris.length === 0 ? 1 : 0)),
    ),
    queryCount: all.length,
    scenarioLookupMilliseconds: EffectArray.map(capture.scenarios, scenario => ({
      id: scenario.id,
      measurement: benchmarkMeasurement(
        `code-memory-link-inverse-selector-${scenario.id}`,
        'milliseconds',
        EffectArray.map(scenario.samples, observation => observation.milliseconds),
      ),
    })),
    truncatedSelectorCount: EffectArray.reduce(
      all,
      0,
      (total, observation) => total + observation.truncatedSelectorCount,
    ),
    unexpectedResultCount,
    warmupCountMinimum: Math.min(...EffectArray.map(capture.scenarios, scenario => scenario.warmups.length)),
  };
}

function gateFailures(
  budget: CodeMemoryLinkScaleBudgetV1,
  capture: CodeMemoryLinkScaleRuntimeCaptureV1,
  identity: CodeMemoryLinkScaleIdentityV1,
  metrics: CodeMemoryLinkScaleMetricsV1,
  evidenceClass: CodeMemoryLinkScaleEvidenceClass,
  candidateBinding?: CodeMemoryLinkScaleCandidateBindingV1,
  runnerBinding?: CodeMemoryLinkScaleRunnerBindingV1,
): string[] {
  const failures: string[] = [];
  if (evidenceClass !== 'release-scale') failures.push('artifact is a development smoke, not release-scale evidence');
  if (identity.invocationMode !== 'release-scale') failures.push('invocation mode is development-smoke');
  if (identity.candidateCommit !== identity.observedCommit) {
    failures.push(`observed commit ${identity.observedCommit}; required candidate ${identity.candidateCommit}`);
  }
  if (identity.dirty) failures.push('candidate checkout is dirty; required dirty=false');
  if (identity.invocationMode === 'release-scale') {
    failures.push(...codeMemoryLinkScaleReleaseIdentityFailures(identity, candidateBinding, runnerBinding));
  }
  if (!/^[0-9a-f]{64}$/u.test(identity.builtArtifactSha256)) {
    failures.push('built benchmark artifact digest is missing or malformed');
  }
  if (capture.fixtureHash !== CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH) {
    failures.push(`fixture hash ${capture.fixtureHash}; required ${CODE_MEMORY_LINK_SCALE_APPROVED_FIXTURE_HASH}`);
  }
  const corpus = capture.corpus;
  exactCount(failures, 'materialized memory corpus', corpus.materializedMemoryCount, budget.corpusMemoryCount);
  exactCount(failures, 'indexed memory corpus', corpus.indexedMemoryCount, budget.corpusMemoryCount);
  exactCount(failures, 'direct backlink memories', corpus.directBacklinkMemoryCount, budget.directBacklinkMemoryCount);
  exactCount(failures, 'dense backlink memories', corpus.denseBacklinkMemoryCount, budget.denseBacklinkMemoryCount);
  exactCount(
    failures,
    'repository-isolation decoys',
    corpus.isolationDecoyMemoryCount,
    budget.isolationDecoyMemoryCount,
  );
  exactCount(
    failures,
    'noise memories',
    corpus.noiseMemoryCount,
    budget.corpusMemoryCount - budget.directBacklinkMemoryCount - budget.isolationDecoyMemoryCount,
  );
  const scenarios = EffectArray.map(capture.scenarios, scenario => scenario.id);
  if (JSON.stringify(scenarios) !== JSON.stringify(CODE_MEMORY_LINK_SCALE_SCENARIOS)) {
    failures.push(`scenarios must execute ${EffectArray.join(CODE_MEMORY_LINK_SCALE_SCENARIOS, ', ')} in order`);
  }
  for (const scenario of capture.scenarios) {
    if (JSON.stringify(scenario.expectedUris) !== JSON.stringify(codeMemoryLinkScaleExpectedUris(scenario.id))) {
      failures.push(`${scenario.id} expected URI truth does not match the frozen fixture`);
    }
    const expectedTruncatedSelectorCount = codeMemoryLinkScaleExpectedTruncatedSelectorCount(scenario.id);
    if (scenario.expectedTruncatedSelectorCount !== expectedTruncatedSelectorCount) {
      failures.push(`${scenario.id} expected truncation truth does not match the frozen fixture`);
    }
    if (
      EffectArray.some(
        [scenario.cold, ...scenario.warmups, ...scenario.samples],
        observation => observation.truncatedSelectorCount !== expectedTruncatedSelectorCount,
      )
    ) {
      failures.push(
        `${scenario.id} must report exactly ${expectedTruncatedSelectorCount} bounded selector truncations per lookup`,
      );
    }
  }
  if (EffectArray.some(capture.scenarios, scenario => scenario.samples.length < budget.minimumSamples)) {
    failures.push(`every scenario requires at least ${budget.minimumSamples} measured samples`);
  }
  if (metrics.warmupCountMinimum < budget.minimumWarmups) {
    failures.push(`warmup count ${metrics.warmupCountMinimum}; minimum ${budget.minimumWarmups}`);
  }
  minimum(failures, 'direct Recall', metrics.directRecall, 1);
  minimum(failures, 'direct Precision', metrics.directPrecision, 1);
  minimum(failures, 'direct-first rate', metrics.directFirstRate, 1);
  minimum(failures, 'no-answer accuracy', metrics.noAnswerAccuracy, 1);
  minimum(failures, 'bounded-result accuracy', metrics.boundedResultAccuracy, 1);
  maximum(failures, 'lookup p95 milliseconds', metrics.lookupMilliseconds.p95, budget.maximumLookupP95Milliseconds);
  maximum(
    failures,
    'lookup sample maximum milliseconds',
    metrics.lookupMilliseconds.maximum,
    budget.maximumLookupSampleMilliseconds,
  );
  for (const scenario of metrics.scenarioLookupMilliseconds) {
    maximum(
      failures,
      `${scenario.id} lookup p95 milliseconds`,
      scenario.measurement.p95,
      budget.maximumLookupP95Milliseconds,
    );
  }
  maximum(failures, 'added peak RSS bytes', capture.resources.addedPeakRssBytes, budget.maximumAddedPeakRssBytes);
  maximum(failures, 'corpus bytes', corpus.corpusBytes, budget.maximumCorpusBytes);
  maximum(failures, 'recall storage bytes', capture.resources.recallStorageBytes, budget.maximumRecallStorageBytes);
  maximum(
    failures,
    'index build milliseconds',
    capture.resources.indexBuildMilliseconds,
    budget.maximumIndexBuildMilliseconds,
  );
  maximum(
    failures,
    'materialization milliseconds',
    capture.resources.materializationMilliseconds,
    budget.maximumMaterializationMilliseconds,
  );
  if (capture.resources.recallDatabaseBytes <= 0) failures.push('recall database bytes must be positive');
  if (corpus.corpusBytes <= 0) failures.push('corpus bytes must be positive');
  if (capture.resources.indexBuildMilliseconds <= 0) failures.push('index build milliseconds must be positive');
  if (capture.resources.materializationMilliseconds <= 0) {
    failures.push('materialization milliseconds must be positive');
  }
  if (capture.resources.recallStorageBytes < capture.resources.recallDatabaseBytes) {
    failures.push('recall storage bytes cannot be smaller than recall database bytes');
  }
  if (
    capture.resources.addedPeakRssBytes !==
    Math.max(0, capture.resources.peakRssBytes - capture.resources.baselineRssBytes)
  ) {
    failures.push('added peak RSS bytes do not match peak minus baseline');
  }
  if (metrics.maximumReturnedMemories > budget.queryLimit) {
    failures.push(`maximum returned memories ${metrics.maximumReturnedMemories}; limit ${budget.queryLimit}`);
  }
  if (metrics.canonicalMismatchCount !== 0) {
    failures.push(`canonical selector mismatches ${metrics.canonicalMismatchCount}; required 0`);
  }
  if (metrics.duplicateResultCount !== 0) {
    failures.push(`duplicate selector results ${metrics.duplicateResultCount}; required 0`);
  }
  if (metrics.unexpectedResultCount !== 0) {
    failures.push(`unexpected selector results ${metrics.unexpectedResultCount}; required 0`);
  }
  return failures;
}

function parseCapture(value: unknown, mode: CodeMemoryLinkScaleEvidenceClass): CodeMemoryLinkScaleRuntimeCaptureV1 {
  const capture = record(value, 'capture');
  exactKeys(capture, ['corpus', 'fixtureHash', 'resources', 'scenarios']);
  const corpus = record(capture.corpus, 'capture corpus');
  exactKeys(corpus, [
    'corpusBytes',
    'denseBacklinkMemoryCount',
    'directBacklinkMemoryCount',
    'indexedMemoryCount',
    'isolationDecoyMemoryCount',
    'materializedMemoryCount',
    'noiseMemoryCount',
  ]);
  const resources = record(capture.resources, 'capture resources');
  exactKeys(resources, [
    'addedPeakRssBytes',
    'baselineRssBytes',
    'indexBuildMilliseconds',
    'materializationMilliseconds',
    'peakRssBytes',
    'recallDatabaseBytes',
    'recallStorageBytes',
  ]);
  if (!EffectArray.isArray(capture.scenarios)) invalid('capture scenarios must be an array');
  if (capture.scenarios.length === 0) invalid('capture scenarios must be non-empty');
  const scenarios = EffectArray.map(capture.scenarios, value => parseScenario(value, mode));
  assertUnique(
    EffectArray.map(scenarios, scenario => scenario.id),
    'scenario ids',
  );
  return {
    corpus: {
      corpusBytes: nonNegativeInteger(corpus.corpusBytes, 'corpus bytes'),
      denseBacklinkMemoryCount: nonNegativeInteger(corpus.denseBacklinkMemoryCount, 'dense backlink memory count'),
      directBacklinkMemoryCount: nonNegativeInteger(corpus.directBacklinkMemoryCount, 'direct backlink memory count'),
      indexedMemoryCount: nonNegativeInteger(corpus.indexedMemoryCount, 'indexed memory count'),
      isolationDecoyMemoryCount: nonNegativeInteger(corpus.isolationDecoyMemoryCount, 'isolation decoy memory count'),
      materializedMemoryCount: nonNegativeInteger(corpus.materializedMemoryCount, 'materialized memory count'),
      noiseMemoryCount: nonNegativeInteger(corpus.noiseMemoryCount, 'noise memory count'),
    },
    fixtureHash: lowercaseHex(capture.fixtureHash, 64, 'fixture hash'),
    resources: {
      addedPeakRssBytes: nonNegativeInteger(resources.addedPeakRssBytes, 'added peak RSS bytes'),
      baselineRssBytes: nonNegativeInteger(resources.baselineRssBytes, 'baseline RSS bytes'),
      indexBuildMilliseconds: nonNegativeFinite(resources.indexBuildMilliseconds, 'index build milliseconds'),
      materializationMilliseconds: nonNegativeFinite(
        resources.materializationMilliseconds,
        'materialization milliseconds',
      ),
      peakRssBytes: nonNegativeInteger(resources.peakRssBytes, 'peak RSS bytes'),
      recallDatabaseBytes: nonNegativeInteger(resources.recallDatabaseBytes, 'recall database bytes'),
      recallStorageBytes: nonNegativeInteger(resources.recallStorageBytes, 'recall storage bytes'),
    },
    scenarios,
  };
}

function parseScenario(value: unknown, mode: CodeMemoryLinkScaleEvidenceClass): CodeMemoryLinkScaleScenarioCaptureV1 {
  const scenario = record(value, 'scenario');
  exactKeys(scenario, ['cold', 'expectedTruncatedSelectorCount', 'expectedUris', 'id', 'samples', 'warmups']);
  if (!isCodeMemoryLinkScaleScenarioId(scenario.id)) {
    invalid(`unsupported scenario ${String(scenario.id)}`);
  }
  if (!EffectArray.isArray(scenario.expectedUris)) invalid('scenario expectedUris must be an array');
  if (!EffectArray.isArray(scenario.samples)) invalid('scenario samples must be an array');
  if (scenario.samples.length === 0) invalid('scenario samples must be non-empty');
  if (!EffectArray.isArray(scenario.warmups)) invalid('scenario warmups must be an array');
  if (mode === 'release-scale') {
    if (
      scenario.samples.length !== CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET.minimumSamples ||
      scenario.warmups.length !== CODE_MEMORY_LINK_SCALE_APPROVED_BUDGET.minimumWarmups
    ) {
      invalid('release observation count must be exactly 25 samples and 5 warmups per scenario');
    }
  } else if (
    scenario.samples.length > CODE_MEMORY_LINK_SCALE_DEVELOPMENT_MAXIMUM_SAMPLES ||
    scenario.warmups.length > CODE_MEMORY_LINK_SCALE_DEVELOPMENT_MAXIMUM_WARMUPS
  ) {
    invalid('development observation count exceeds the maximum 25 samples or 5 warmups');
  }
  const expectedUris = EffectArray.map(scenario.expectedUris, (uri, index) =>
    nonEmptyString(uri, `expectedUris[${index}]`),
  );
  assertUnique(expectedUris, 'expected URIs');
  return {
    cold: parseObservation(scenario.cold),
    expectedTruncatedSelectorCount: nonNegativeInteger(
      scenario.expectedTruncatedSelectorCount,
      'expected truncated selector count',
    ),
    expectedUris,
    id: scenario.id,
    samples: EffectArray.map(scenario.samples, parseObservation),
    warmups: EffectArray.map(scenario.warmups, parseObservation),
  };
}

function parseObservation(value: unknown): CodeMemoryLinkScaleLookupObservationV1 {
  const observation = record(value, 'lookup observation');
  exactKeys(observation, ['canonicalMismatchCount', 'milliseconds', 'returnedUris', 'truncatedSelectorCount']);
  if (!EffectArray.isArray(observation.returnedUris)) invalid('returnedUris must be an array');
  return {
    canonicalMismatchCount: nonNegativeInteger(observation.canonicalMismatchCount, 'canonical mismatch count'),
    milliseconds: nonNegativeFinite(observation.milliseconds, 'lookup milliseconds'),
    returnedUris: EffectArray.map(observation.returnedUris, (uri, index) =>
      nonEmptyString(uri, `returnedUris[${index}]`),
    ),
    truncatedSelectorCount: nonNegativeInteger(observation.truncatedSelectorCount, 'truncated selector count'),
  };
}

function parseIdentity(value: unknown): CodeMemoryLinkScaleIdentityV1 {
  const identity = record(value, 'identity');
  exactKeys(identity, [
    'architecture',
    'builtArtifactSha256',
    'candidateCommit',
    'candidateVersion',
    'cpu',
    'dirty',
    'gitStatusObserved',
    'github',
    'invocationMode',
    'memoryBytes',
    'observedCommit',
    'operatingSystem',
    'packageManager',
    'runnerClass',
    'runnerArchitecture',
    'runnerEnvironment',
    'runnerOperatingSystem',
    'runtime',
    'sourceVersion',
  ]);
  if (typeof identity.dirty !== 'boolean') invalid('identity dirty must be boolean');
  if (typeof identity.gitStatusObserved !== 'boolean') invalid('identity gitStatusObserved must be boolean');
  if (identity.invocationMode !== 'development-smoke' && identity.invocationMode !== 'release-scale') {
    invalid('identity invocationMode must be development-smoke or release-scale');
  }
  return {
    architecture: nonEmptyString(identity.architecture, 'identity architecture'),
    builtArtifactSha256: stringValue(identity.builtArtifactSha256, 'built artifact digest'),
    candidateCommit: lowercaseHex(identity.candidateCommit, 40, 'candidate commit'),
    candidateVersion: nonEmptyString(identity.candidateVersion, 'candidate version'),
    cpu: nonEmptyString(identity.cpu, 'identity cpu'),
    dirty: identity.dirty,
    gitStatusObserved: identity.gitStatusObserved,
    github: parseGithubProvenance(identity.github),
    invocationMode: identity.invocationMode,
    memoryBytes: positiveInteger(identity.memoryBytes, 'identity memory bytes'),
    observedCommit: lowercaseHex(identity.observedCommit, 40, 'observed commit'),
    operatingSystem: nonEmptyString(identity.operatingSystem, 'identity operating system'),
    packageManager: nonEmptyString(identity.packageManager, 'identity package manager'),
    runnerClass: nonEmptyString(identity.runnerClass, 'identity runner class'),
    runnerArchitecture: nonEmptyString(identity.runnerArchitecture, 'identity runner architecture'),
    runnerEnvironment: nonEmptyString(identity.runnerEnvironment, 'identity runner environment'),
    runnerOperatingSystem: nonEmptyString(identity.runnerOperatingSystem, 'identity runner operating system'),
    runtime: nonEmptyString(identity.runtime, 'identity runtime'),
    sourceVersion: nonEmptyString(identity.sourceVersion, 'identity source version'),
  };
}

function parseGithubProvenance(value: unknown): CodeMemoryLinkScaleGithubProvenanceV1 {
  const github = record(value, 'identity GitHub provenance');
  exactKeys(github, [
    'actions',
    'eventName',
    'job',
    'ref',
    'repository',
    'repositoryId',
    'runAttempt',
    'runId',
    'sha',
    'workflowRef',
    'workflowSha',
  ]);
  if (typeof github.actions !== 'boolean') invalid('identity GitHub actions must be boolean');
  return {
    actions: github.actions,
    eventName: nonEmptyString(github.eventName, 'identity GitHub event name'),
    job: nonEmptyString(github.job, 'identity GitHub job'),
    ref: nonEmptyString(github.ref, 'identity GitHub ref'),
    repository: nonEmptyString(github.repository, 'identity GitHub repository'),
    repositoryId: nonEmptyString(github.repositoryId, 'identity GitHub repository ID'),
    runAttempt: positiveInteger(github.runAttempt, 'identity GitHub run attempt'),
    runId: positiveInteger(github.runId, 'identity GitHub run ID'),
    sha: lowercaseHex(github.sha, 40, 'identity GitHub SHA'),
    workflowRef: nonEmptyString(github.workflowRef, 'identity GitHub workflow ref'),
    workflowSha: lowercaseHex(github.workflowSha, 40, 'identity GitHub workflow SHA'),
  };
}

/** Reject release provenance that is missing, self-attested, or detached from the exact GitHub Actions candidate. */
export function codeMemoryLinkScaleReleaseIdentityFailures(
  identity: CodeMemoryLinkScaleIdentityV1,
  candidate?: CodeMemoryLinkScaleCandidateBindingV1,
  runner?: CodeMemoryLinkScaleRunnerBindingV1,
): readonly string[] {
  return [...runnerBindingFailures(identity, runner), ...codeMemoryLinkScaleReleaseClaimFailures(identity, candidate)];
}

/** Producer preflight only: these self-reported claims do not establish provenance. */
export function codeMemoryLinkScaleReleaseClaimFailures(
  identity: CodeMemoryLinkScaleIdentityV1,
  candidate?: CodeMemoryLinkScaleCandidateBindingV1,
): readonly string[] {
  const github = identity.github;
  return EffectArray.filter(
    [
      candidate === undefined ? 'release-scale evidence requires an independently derived candidate binding' : '',
      candidate === undefined || identity.candidateCommit === candidate.candidateCommit
        ? ''
        : `claimed candidate ${identity.candidateCommit}; required reviewed candidate ${candidate.candidateCommit}`,
      candidate === undefined || identity.candidateVersion === candidate.candidateVersion
        ? ''
        : `candidate version ${identity.candidateVersion}; required ${candidate.candidateVersion}`,
      candidate === undefined || identity.packageManager === candidate.packageManager
        ? ''
        : `package manager ${identity.packageManager}; required ${candidate.packageManager}`,
      candidate === undefined || identity.runtime === candidate.runtime
        ? ''
        : `runtime ${identity.runtime}; required ${candidate.runtime}`,
      candidate === undefined || identity.sourceVersion === candidate.sourceVersion
        ? ''
        : `source version ${identity.sourceVersion}; required ${candidate.sourceVersion}`,
      identity.observedCommit === identity.candidateCommit
        ? ''
        : `observed commit ${identity.observedCommit}; required candidate ${identity.candidateCommit}`,
      identity.dirty ? 'candidate checkout is dirty; required dirty=false' : '',
      identity.gitStatusObserved ? '' : 'candidate Git status could not be observed',
      github.actions ? '' : 'release evidence was not produced by GitHub Actions',
      isCodeMemoryLinkScaleGitHubRepository(github.repository)
        ? ''
        : `GitHub repository ${github.repository}; required one of ${EffectArray.join(CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORIES, ', ')}`,
      github.repositoryId === CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID
        ? ''
        : `GitHub repository ID ${github.repositoryId}; required ${CODE_MEMORY_LINK_SCALE_GITHUB_REPOSITORY_ID}`,
      github.job === CODE_MEMORY_LINK_SCALE_GITHUB_JOB
        ? ''
        : `GitHub job ${github.job}; required ${CODE_MEMORY_LINK_SCALE_GITHUB_JOB}`,
      github.eventName === 'schedule' || github.eventName === 'workflow_dispatch'
        ? ''
        : `GitHub event ${github.eventName}; required schedule or workflow_dispatch`,
      github.sha === identity.candidateCommit
        ? ''
        : `GitHub SHA ${github.sha}; required candidate ${identity.candidateCommit}`,
      github.workflowSha === identity.candidateCommit
        ? ''
        : `GitHub workflow SHA ${github.workflowSha}; required candidate ${identity.candidateCommit}`,
      github.workflowRef === `${github.repository}/${CODE_MEMORY_LINK_SCALE_GITHUB_WORKFLOW_PATH}@${github.ref}`
        ? ''
        : 'GitHub workflow ref does not identify the governed benchmarks workflow at the claimed ref',
      identity.runnerClass === CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS
        ? ''
        : `runner class ${identity.runnerClass}; required ${CODE_MEMORY_LINK_SCALE_RELEASE_RUNNER_CLASS}`,
      identity.runnerArchitecture === 'ARM64'
        ? ''
        : `runner architecture label ${identity.runnerArchitecture}; required ARM64`,
      identity.runnerEnvironment === 'github-hosted'
        ? ''
        : `runner environment ${identity.runnerEnvironment}; required github-hosted`,
      identity.runnerOperatingSystem === 'macOS'
        ? ''
        : `runner operating system label ${identity.runnerOperatingSystem}; required macOS`,
      identity.architecture === 'arm64' ? '' : `runner architecture ${identity.architecture}; required arm64`,
      /^Apple M1(?:$|\s)/u.test(identity.cpu) ? '' : `runner CPU ${identity.cpu}; required Apple M1 class`,
      Effect.pipe(identity.operatingSystem, EffectString.startsWith('macOS '))
        ? ''
        : `runner operating system ${identity.operatingSystem}; required macOS`,
    ],
    Boolean,
  );
}

function runnerBindingFailures(
  identity: CodeMemoryLinkScaleIdentityV1,
  runner?: CodeMemoryLinkScaleRunnerBindingV1,
): string[] {
  if (runner === undefined) return ['release-scale evidence requires an independently supplied runner binding'];
  const expected = parseCodeMemoryLinkScaleRunnerBindingV1(runner);
  const failures: string[] = [];
  for (const key of EffectRecord.keys(expected.github) as (keyof CodeMemoryLinkScaleGithubProvenanceV1)[]) {
    if (identity.github[key] !== expected.github[key])
      failures.push(`GitHub ${key} differs from the trusted runner binding`);
  }
  for (const key of ['runnerClass', 'runnerArchitecture', 'runnerEnvironment', 'runnerOperatingSystem'] as const) {
    if (identity[key] !== expected[key]) failures.push(`${key} differs from the trusted runner binding`);
  }
  return failures;
}

function exactCount(failures: string[], label: string, actual: number, expected: number): void {
  if (actual !== expected) failures.push(`${label} ${actual}; required ${expected}`);
}

function minimum(failures: string[], label: string, actual: number, required: number): void {
  if (actual < required) failures.push(`${label} ${formatMetric(actual)}; minimum ${formatMetric(required)}`);
}

function maximum(failures: string[], label: string, actual: number, allowed: number): void {
  if (actual > allowed) failures.push(`${label} ${formatMetric(actual)}; maximum ${formatMetric(allowed)}`);
}

function ratio(numerator: number, denominator: number, empty: number): number {
  return denominator === 0 ? empty : numerator / denominator;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : EffectArray.reduce(values, 0, (total, value) => total + value) / values.length;
}

function formatMetric(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : Effect.pipe(value.toFixed(6), EffectString.replace(/0+$/u, ''), EffectString.replace(/\.$/u, ''));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = EffectRecord.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) invalid(`unexpected keys ${EffectArray.join(actual, ', ')}`);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed < 1) invalid(`${label} must be positive`);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function isCodeMemoryLinkScaleScenarioId(value: unknown): value is CodeMemoryLinkScaleScenarioId {
  return (
    value === 'file-backlinks' ||
    value === 'symbol-backlink' ||
    value === 'dense-shared-selector' ||
    value === 'no-answer'
  );
}

function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    invalid(`${label} must be a non-negative finite number`);
  }
  return value;
}

function lowercaseHex(value: unknown, length: number, label: string): string {
  const parsed = stringValue(value, label);
  if (!new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(parsed)) invalid(`${label} must be ${length} lowercase hex`);
  return parsed;
}

function nonEmptyString(value: unknown, label: string): string {
  const parsed = stringValue(value, label);
  if (!Effect.pipe(parsed, EffectString.trim)) invalid(`${label} must be non-empty`);
  return parsed;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  return value;
}

function isoInstant(value: unknown, label: string): string {
  const parsed = nonEmptyString(value, label);
  if (new Date(parsed).toISOString() !== parsed) invalid(`${label} must be a canonical ISO instant`);
  return parsed;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): never {
  throw new Error(`Invalid CodeMemoryLink inverse scale v1: ${message}.`);
}
