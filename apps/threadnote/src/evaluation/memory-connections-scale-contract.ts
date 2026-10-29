import {Array as EffectArray, Option as EffectOption} from 'effect';
import {pipe as EffectArrayPipe} from 'effect';

import {sha256HexSync} from '@threadnote/platform/sha256';
import {benchmarkMeasurement, type BenchmarkMeasurementV1} from '@threadnote/evidence/benchmark';
import {Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const MEMORY_CONNECTIONS_SCALE_ID = 'memory-connections-one-hop-scale-v1' as const;
export const MEMORY_CONNECTIONS_SCALE_VERSION = 1 as const;
export const MEMORY_CONNECTIONS_SCALE_RELEASE_RUNNER_CLASS = 'github-hosted-macos-15-ARM64' as const;
export const MEMORY_CONNECTIONS_SCALE_SCENARIOS = ['incoming-hub', 'sparse-incoming', 'no-answer'] as const;
export type MemoryConnectionsScaleScenarioId = (typeof MEMORY_CONNECTIONS_SCALE_SCENARIOS)[number];
export type MemoryConnectionsScaleEvidenceClass = 'development-smoke' | 'release-scale';
const CANDIDATE_PACKAGE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const MEMORY_CONNECTIONS_SCALE_FIXTURE = Object.freeze({
  project: 'threadnote',
  scenarios: [
    {
      expectedMemoryIds: Array.from(
        {length: 8},
        (_, index) => `tn_hub_${Effect.pipe(String(index), EffectString.padStart(6, '0'))}`,
      ),
      expectedTruncated: true,
      id: 'incoming-hub',
      premiseMemoryId: 'tn_scale_hub',
    },
    {
      expectedMemoryIds: ['tn_sparse_a', 'tn_sparse_b'],
      expectedTruncated: false,
      id: 'sparse-incoming',
      premiseMemoryId: 'tn_scale_sparse',
    },
    {
      expectedMemoryIds: [],
      expectedTruncated: false,
      id: 'no-answer',
      premiseMemoryId: 'tn_scale_empty',
    },
  ],
  seed: 'threadnote-memory-connections-one-hop-scale-v1-2026-08-31',
  unauthorizedProject: 'outside',
  user: 'memory-connections-scale',
} as const);

/** Changing corpus identity requires a complete source-reviewed hash update. */
export const MEMORY_CONNECTIONS_SCALE_APPROVED_FIXTURE_HASH =
  '136c49200cb5661faa60db25a682faa8793dcbb3cfe9da7387d396f32d0a5ee7' as const;

export interface MemoryConnectionsScaleBudgetV1 {
  readonly corpusMemoryCount: 100_000;
  readonly id: typeof MEMORY_CONNECTIONS_SCALE_ID;
  readonly maximumAddedPeakRssBytes: number;
  readonly maximumCanonicalRereadsPerLookup: 322;
  readonly maximumCorpusBytes: number;
  readonly maximumIndexBuildMilliseconds: number;
  readonly maximumLookupP95Milliseconds: 250;
  readonly maximumLookupSampleMilliseconds: 1_000;
  readonly maximumMaterializationMilliseconds: number;
  readonly maximumRawLinkRowsPerLookup: 257;
  readonly maximumRecallStorageBytes: number;
  readonly maximumResponseEstimatedTokens: 1_500;
  readonly minimumSamples: 25;
  readonly minimumWarmups: 5;
  readonly queryLimit: 8;
  readonly version: 1;
}

export const MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET: MemoryConnectionsScaleBudgetV1 = Object.freeze({
  corpusMemoryCount: 100_000,
  id: MEMORY_CONNECTIONS_SCALE_ID,
  maximumAddedPeakRssBytes: 3 * 1024 * 1024 * 1024,
  maximumCanonicalRereadsPerLookup: 322,
  maximumCorpusBytes: 256 * 1024 * 1024,
  maximumIndexBuildMilliseconds: 10 * 60 * 1_000,
  maximumLookupP95Milliseconds: 250,
  maximumLookupSampleMilliseconds: 1_000,
  maximumMaterializationMilliseconds: 5 * 60 * 1_000,
  maximumRawLinkRowsPerLookup: 257,
  maximumRecallStorageBytes: 2 * 1024 * 1024 * 1024,
  maximumResponseEstimatedTokens: 1_500,
  minimumSamples: 25,
  minimumWarmups: 5,
  queryLimit: 8,
  version: 1,
});

export interface MemoryConnectionsScaleConnectionReceiptEvidenceV1 {
  readonly currentness: string;
  readonly direction: string;
  readonly distance: number;
  readonly neighborMemoryId: string | null;
  readonly origin: string;
  readonly relationOrdinal: number;
  readonly relationType: string;
  readonly requestedOrdinal: number;
  readonly resolution: string;
  readonly sourceMemoryId: string | null;
  readonly targetMemoryId: string | null;
}

export interface MemoryConnectionsScalePremiseReceiptEvidenceV1 {
  readonly memoryId: string | null;
  readonly requestedOrdinal: number;
  readonly state: string;
}

export interface MemoryConnectionsScaleObservationV1 {
  readonly canonicalRereads: number;
  readonly estimatedTokens: number;
  readonly milliseconds: number;
  readonly omittedConnectionReceiptCount: number;
  readonly omittedPremiseReceiptCount: number;
  readonly projectedConnections: readonly MemoryConnectionsScaleConnectionReceiptEvidenceV1[];
  readonly projectedCoverageConnectionCount: number;
  readonly projectedCoveragePremiseCount: number;
  readonly projectedCoverageResultCount: number;
  readonly projectedConnectionCoverageTruncated: boolean;
  readonly projectedOutputTruncated: boolean;
  readonly projectedPremises: readonly MemoryConnectionsScalePremiseReceiptEvidenceV1[];
  readonly rawLinkRows: number;
  readonly retrievalTruncated: boolean;
  readonly returnedMemoryIds: readonly string[];
}

export interface MemoryConnectionsScaleScenarioCaptureV1 {
  readonly cold: MemoryConnectionsScaleObservationV1;
  readonly expectedMemoryIds: readonly string[];
  readonly expectedTruncated: boolean;
  readonly id: MemoryConnectionsScaleScenarioId;
  readonly samples: readonly MemoryConnectionsScaleObservationV1[];
  readonly warmups: readonly MemoryConnectionsScaleObservationV1[];
}

export interface MemoryConnectionsScaleCaptureV1 {
  readonly corpus: {
    readonly authorizedHubMemoryCount: number;
    readonly corpusBytes: number;
    readonly indexedMemoryCount: number;
    readonly materializedMemoryCount: number;
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
  readonly scenarios: readonly MemoryConnectionsScaleScenarioCaptureV1[];
}

export interface MemoryConnectionsScaleIdentityV1 {
  readonly architecture: string;
  readonly builtArtifactSha256: string;
  readonly candidateCommit: string;
  readonly cpu: string;
  readonly dirty: boolean;
  readonly gitStatusObserved: boolean;
  readonly githubActions: boolean;
  readonly invocationMode: MemoryConnectionsScaleEvidenceClass;
  readonly observedCommit: string;
  readonly operatingSystem: string;
  readonly packageManager: string;
  readonly runnerArchitecture: string;
  readonly runnerClass: string;
  readonly runnerEnvironment: string;
  readonly runnerOperatingSystem: string;
  readonly runtime: string;
  readonly sourceVersion: string;
}

/** Candidate metadata read from the exact Git object by the producer or verifier. */
export interface MemoryConnectionsScaleCandidateBinding {
  readonly commit: string;
  readonly packageManager: string;
  readonly runtime: string;
  readonly sourceVersion: string;
}

export interface MemoryConnectionsScaleMetricsV1 {
  readonly boundedResultAccuracy: number;
  readonly duplicateResultCount: number;
  readonly incorrectConnectionCurrentnessCount: number;
  readonly incorrectConnectionReceiptIdentityCount: number;
  readonly incorrectConnectionResolutionCount: number;
  readonly incorrectPremiseReceiptIdentityCount: number;
  readonly incorrectPremiseStateCount: number;
  readonly lookupMilliseconds: BenchmarkMeasurementV1;
  readonly maximumCanonicalRereads: number;
  readonly maximumEstimatedTokens: number;
  readonly maximumRawLinkRows: number;
  readonly maximumReturnedMemories: number;
  readonly noAnswerAccuracy: number;
  readonly precision: number;
  readonly projectedConnectionCoverageAccuracy: number;
  readonly projectedOutputCompletenessAccuracy: number;
  readonly projectedReceiptAccountingAccuracy: number;
  readonly recall: number;
  readonly truncationAccuracy: number;
  readonly unexpectedReceiptIdentityCount: number;
  readonly unexpectedResultCount: number;
}

export interface MemoryConnectionsScaleArtifactV1 {
  readonly capture: MemoryConnectionsScaleCaptureV1;
  readonly createdAt: string;
  readonly evidenceClass: MemoryConnectionsScaleEvidenceClass;
  readonly gate: {readonly failures: readonly string[]; readonly passed: boolean};
  readonly identity: MemoryConnectionsScaleIdentityV1;
  readonly metrics: MemoryConnectionsScaleMetricsV1;
  readonly suite: typeof MEMORY_CONNECTIONS_SCALE_ID;
  readonly version: 1;
}

export function memoryConnectionsScaleFixtureHash(): string {
  return sha256HexSync(`${JSON.stringify(MEMORY_CONNECTIONS_SCALE_FIXTURE)}\n`);
}

export function memoryConnectionsScaleExpectedIds(id: MemoryConnectionsScaleScenarioId): readonly string[] {
  return EffectOption.getOrUndefined(
    EffectArray.findFirst(MEMORY_CONNECTIONS_SCALE_FIXTURE.scenarios, scenario => scenario.id === id),
  )!.expectedMemoryIds;
}

export function memoryConnectionsScaleCandidateBinding(
  commit: string,
  packageManifest: unknown,
): MemoryConnectionsScaleCandidateBinding {
  if (!/^[0-9a-f]{40}$/u.test(commit)) invalid('candidate binding requires an exact lowercase Git SHA-1');
  const manifest = record(packageManifest, 'candidate package manifest');
  const version = nonEmptyString(manifest.version, 'candidate package version');
  if (!CANDIDATE_PACKAGE_VERSION.test(version)) invalid('candidate package version must be an explicit version');
  const packageManager = nonEmptyString(manifest.packageManager, 'candidate package manager');
  if (
    !Effect.pipe(packageManager, EffectString.startsWith('bun@')) ||
    !CANDIDATE_PACKAGE_VERSION.test(Effect.pipe(packageManager, EffectString.slice('bun@'.length)))
  ) {
    invalid('candidate package manager must pin an explicit Bun version');
  }
  return {
    commit,
    packageManager,
    runtime: `bun/${Effect.pipe(packageManager, EffectString.slice('bun@'.length))}`,
    sourceVersion: `threadnote-${version}`,
  };
}

function expectedScaleConnectionReceipts(
  id: MemoryConnectionsScaleScenarioId,
): readonly MemoryConnectionsScaleConnectionReceiptEvidenceV1[] {
  const scenario = EffectOption.getOrUndefined(
    EffectArray.findFirst(MEMORY_CONNECTIONS_SCALE_FIXTURE.scenarios, value => value.id === id),
  )!;
  return EffectArray.map(scenario.expectedMemoryIds, memoryId => ({
    currentness: 'current',
    direction: 'incoming',
    distance: 1,
    neighborMemoryId: memoryId,
    origin: 'relation',
    relationOrdinal: 0,
    relationType: 'related_to',
    requestedOrdinal: 0,
    resolution: 'resolved',
    sourceMemoryId: memoryId,
    targetMemoryId: scenario.premiseMemoryId,
  }));
}

function connectionReceiptIdentityMatches(
  actual: MemoryConnectionsScaleConnectionReceiptEvidenceV1,
  expected: MemoryConnectionsScaleConnectionReceiptEvidenceV1 | undefined,
): boolean {
  return (
    expected !== undefined &&
    actual.direction === expected.direction &&
    actual.distance === expected.distance &&
    actual.neighborMemoryId === expected.neighborMemoryId &&
    actual.origin === expected.origin &&
    actual.relationOrdinal === expected.relationOrdinal &&
    actual.relationType === expected.relationType &&
    actual.requestedOrdinal === expected.requestedOrdinal &&
    actual.sourceMemoryId === expected.sourceMemoryId &&
    actual.targetMemoryId === expected.targetMemoryId
  );
}

export function parseMemoryConnectionsScaleBudgetV1(value: unknown): MemoryConnectionsScaleBudgetV1 {
  if (!Predicate.isObject(value)) invalid('budget must be an object');
  const budget = value;
  const expectedEntries = EffectRecord.toEntries(MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET);
  if (EffectRecord.keys(budget).length !== expectedEntries.length)
    invalid('budget fields do not match the approved contract');
  for (const [key, expected] of expectedEntries) {
    if (budget[key] !== expected) invalid(`budget ${key} does not match the reviewed value ${expected}`);
  }
  return {...MEMORY_CONNECTIONS_SCALE_APPROVED_BUDGET};
}

/** Recompute correctness and release eligibility from captured observations. */
export function evaluateMemoryConnectionsScaleCapture(input: {
  readonly budget: MemoryConnectionsScaleBudgetV1 | unknown;
  readonly candidate?: MemoryConnectionsScaleCandidateBinding;
  readonly capture: MemoryConnectionsScaleCaptureV1 | unknown;
  readonly createdAt: string;
  readonly identity: MemoryConnectionsScaleIdentityV1 | unknown;
}): MemoryConnectionsScaleArtifactV1 {
  const budget = parseMemoryConnectionsScaleBudgetV1(input.budget);
  const capture = parseCapture(input.capture);
  const identity = parseIdentity(input.identity);
  const createdAt = isoInstant(input.createdAt, 'createdAt');
  const releaseIdentityFailures = memoryConnectionsScaleReleaseIdentityFailures(identity, input.candidate);
  const releaseShape =
    identity.invocationMode === 'release-scale' &&
    releaseIdentityFailures.length === 0 &&
    /^[0-9a-f]{64}$/u.test(identity.builtArtifactSha256) &&
    capture.fixtureHash === MEMORY_CONNECTIONS_SCALE_APPROVED_FIXTURE_HASH &&
    capture.corpus.authorizedHubMemoryCount === budget.corpusMemoryCount - 6 &&
    capture.corpus.materializedMemoryCount === budget.corpusMemoryCount &&
    capture.corpus.indexedMemoryCount === budget.corpusMemoryCount &&
    EffectArray.every(
      capture.scenarios,
      scenario => scenario.warmups.length >= budget.minimumWarmups && scenario.samples.length >= budget.minimumSamples,
    );
  const evidenceClass: MemoryConnectionsScaleEvidenceClass = releaseShape ? 'release-scale' : 'development-smoke';
  const all = EffectArrayPipe(capture.scenarios, __effectFlatMapValues =>
    EffectArray.flatMap(__effectFlatMapValues, (scenario, __effectFlatMapIndex) =>
      __effectFlatMapIndex in __effectFlatMapValues ? [scenario.cold, ...scenario.warmups, ...scenario.samples] : [],
    ),
  );
  const measured = EffectArrayPipe(capture.scenarios, __effectArrayValues2 =>
    EffectArray.flatMap(__effectArrayValues2, (scenario, __effectArrayIndex2) =>
      __effectArrayIndex2 in __effectArrayValues2 ? scenario.samples : [],
    ),
  );
  let expectedCount = 0;
  let returnedCount = 0;
  let truePositiveCount = 0;
  let unexpectedResultCount = 0;
  let duplicateResultCount = 0;
  let unexpectedReceiptIdentityCount = 0;
  let incorrectConnectionCurrentnessCount = 0;
  let incorrectConnectionReceiptIdentityCount = 0;
  let incorrectConnectionResolutionCount = 0;
  let incorrectPremiseReceiptIdentityCount = 0;
  let incorrectPremiseStateCount = 0;
  for (const scenario of capture.scenarios) {
    const expected = new Set(scenario.expectedMemoryIds);
    const fixture = EffectOption.getOrUndefined(
      EffectArray.findFirst(MEMORY_CONNECTIONS_SCALE_FIXTURE.scenarios, value => value.id === scenario.id),
    )!;
    const expectedReceiptMemoryIds = new Set([...scenario.expectedMemoryIds, fixture.premiseMemoryId]);
    const expectedConnectionReceipts = expectedScaleConnectionReceipts(scenario.id);
    for (const observation of [scenario.cold, ...scenario.warmups, ...scenario.samples]) {
      expectedCount += expected.size;
      returnedCount += observation.returnedMemoryIds.length;
      truePositiveCount += EffectArrayPipe(observation.returnedMemoryIds, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (id, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && expected.has(id),
        ),
      ).length;
      unexpectedResultCount += EffectArrayPipe(observation.returnedMemoryIds, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (id, __effectArrayIndex) => __effectArrayIndex in __effectArrayValues && !expected.has(id),
        ),
      ).length;
      duplicateResultCount += observation.returnedMemoryIds.length - new Set(observation.returnedMemoryIds).size;
      for (const [index, receipt] of observation.projectedConnections.entries()) {
        if (receipt.currentness !== 'current') incorrectConnectionCurrentnessCount += 1;
        if (receipt.resolution !== 'resolved') incorrectConnectionResolutionCount += 1;
        if (!connectionReceiptIdentityMatches(receipt, expectedConnectionReceipts[index])) {
          incorrectConnectionReceiptIdentityCount += 1;
        }
        unexpectedReceiptIdentityCount += EffectArray.filter(
          EffectArray.filter(
            [receipt.neighborMemoryId, receipt.sourceMemoryId, receipt.targetMemoryId],
            (memoryId): memoryId is string => memoryId !== null,
          ),
          memoryId => !expectedReceiptMemoryIds.has(memoryId),
        ).length;
      }
      for (const receipt of observation.projectedPremises) {
        if (receipt.state !== 'current') incorrectPremiseStateCount += 1;
        if (receipt.memoryId !== fixture.premiseMemoryId || receipt.requestedOrdinal !== 0) {
          incorrectPremiseReceiptIdentityCount += 1;
        }
        if (receipt.memoryId !== null && !expectedReceiptMemoryIds.has(receipt.memoryId)) {
          unexpectedReceiptIdentityCount += 1;
        }
      }
    }
  }
  const noAnswer = EffectArray.flatMap(
    EffectArrayPipe(capture.scenarios, __effectFilterValues =>
      EffectArray.filter(
        __effectFilterValues,
        (scenario, __effectFilterIndex) =>
          __effectFilterIndex in __effectFilterValues && scenario.expectedMemoryIds.length === 0,
      ),
    ),
    scenario => [scenario.cold, ...scenario.warmups, ...scenario.samples],
  );
  const metrics: MemoryConnectionsScaleMetricsV1 = {
    boundedResultAccuracy: mean(
      EffectArray.map(all, value => (value.returnedMemoryIds.length <= budget.queryLimit ? 1 : 0)),
    ),
    duplicateResultCount,
    incorrectConnectionCurrentnessCount,
    incorrectConnectionReceiptIdentityCount,
    incorrectConnectionResolutionCount,
    incorrectPremiseReceiptIdentityCount,
    incorrectPremiseStateCount,
    lookupMilliseconds: benchmarkMeasurement(
      'memory-connections-one-hop',
      'milliseconds',
      EffectArray.map(measured, value => value.milliseconds),
    ),
    maximumCanonicalRereads: Math.max(0, ...EffectArray.map(all, value => value.canonicalRereads)),
    maximumEstimatedTokens: Math.max(0, ...EffectArray.map(all, value => value.estimatedTokens)),
    maximumRawLinkRows: Math.max(0, ...EffectArray.map(all, value => value.rawLinkRows)),
    maximumReturnedMemories: Math.max(0, ...EffectArray.map(all, value => value.returnedMemoryIds.length)),
    noAnswerAccuracy: mean(EffectArray.map(noAnswer, value => (value.returnedMemoryIds.length === 0 ? 1 : 0))),
    precision: ratio(truePositiveCount, returnedCount),
    projectedConnectionCoverageAccuracy: mean(
      EffectArrayPipe(capture.scenarios, __effectArrayValues2 =>
        EffectArray.flatMap(__effectArrayValues2, (scenario, __effectArrayIndex2) =>
          __effectArrayIndex2 in __effectArrayValues2
            ? EffectArray.map([scenario.cold, ...scenario.warmups, ...scenario.samples], value =>
                projectedConnectionCoverageIsExact(value) ? 1 : 0,
              )
            : [],
        ),
      ),
    ),
    projectedOutputCompletenessAccuracy: mean(EffectArray.map(all, value => (value.projectedOutputTruncated ? 0 : 1))),
    projectedReceiptAccountingAccuracy: mean(
      EffectArrayPipe(capture.scenarios, __effectArrayValues2 =>
        EffectArray.flatMap(__effectArrayValues2, (scenario, __effectArrayIndex2) =>
          __effectArrayIndex2 in __effectArrayValues2
            ? EffectArray.map([scenario.cold, ...scenario.warmups, ...scenario.samples], value =>
                value.projectedConnections.length + value.omittedConnectionReceiptCount ===
                  scenario.expectedMemoryIds.length &&
                value.projectedPremises.length + value.omittedPremiseReceiptCount === 1
                  ? 1
                  : 0,
              )
            : [],
        ),
      ),
    ),
    recall: ratio(truePositiveCount, expectedCount),
    truncationAccuracy: mean(
      EffectArrayPipe(capture.scenarios, __effectArrayValues2 =>
        EffectArray.flatMap(__effectArrayValues2, (scenario, __effectArrayIndex2) =>
          __effectArrayIndex2 in __effectArrayValues2
            ? EffectArray.map([scenario.cold, ...scenario.warmups, ...scenario.samples], value =>
                value.retrievalTruncated === scenario.expectedTruncated ? 1 : 0,
              )
            : [],
        ),
      ),
    ),
    unexpectedReceiptIdentityCount,
    unexpectedResultCount,
  };
  const failures: string[] = [];
  if (evidenceClass !== 'release-scale') failures.push('artifact is a development smoke, not release-scale evidence');
  if (identity.invocationMode === 'release-scale') failures.push(...releaseIdentityFailures);
  if (!/^[0-9a-f]{64}$/u.test(identity.builtArtifactSha256)) {
    failures.push('built benchmark artifact digest is missing or malformed');
  }
  if (capture.fixtureHash !== MEMORY_CONNECTIONS_SCALE_APPROVED_FIXTURE_HASH)
    failures.push('fixture hash is not approved');
  exact(failures, 'materialized memory corpus', capture.corpus.materializedMemoryCount, budget.corpusMemoryCount);
  exact(failures, 'indexed memory corpus', capture.corpus.indexedMemoryCount, budget.corpusMemoryCount);
  exact(failures, 'authorized dense-hub corpus', capture.corpus.authorizedHubMemoryCount, budget.corpusMemoryCount - 6);
  if (
    EffectArray.join(
      EffectArray.map(capture.scenarios, value => value.id),
      ',',
    ) !== EffectArray.join(MEMORY_CONNECTIONS_SCALE_SCENARIOS, ',')
  ) {
    failures.push('scale scenarios are missing or out of order');
  }
  for (const scenario of capture.scenarios) {
    if (
      EffectArray.join(scenario.expectedMemoryIds, ',') !==
      EffectArray.join(memoryConnectionsScaleExpectedIds(scenario.id), ',')
    ) {
      failures.push(`${scenario.id} expected truth differs from the frozen fixture`);
    }
    const fixtureScenario = EffectOption.getOrUndefined(
      EffectArray.findFirst(MEMORY_CONNECTIONS_SCALE_FIXTURE.scenarios, value => value.id === scenario.id),
    )!;
    if (scenario.expectedTruncated !== fixtureScenario.expectedTruncated) {
      failures.push(`${scenario.id} expected truncation differs from the frozen fixture`);
    }
    if (
      EffectArray.some(
        [scenario.cold, ...scenario.warmups, ...scenario.samples],
        observation => !sameJson(observation.returnedMemoryIds, scenario.expectedMemoryIds),
      )
    ) {
      failures.push(`${scenario.id} result order or identity differs from the frozen fixture`);
    }
    if (scenario.samples.length < budget.minimumSamples) failures.push(`${scenario.id} has too few measured samples`);
    if (scenario.warmups.length < budget.minimumWarmups) failures.push(`${scenario.id} has too few warmups`);
  }
  minimum(failures, 'precision', metrics.precision, 1);
  minimum(failures, 'recall', metrics.recall, 1);
  minimum(failures, 'no-answer accuracy', metrics.noAnswerAccuracy, 1);
  minimum(failures, 'truncation accuracy', metrics.truncationAccuracy, 1);
  minimum(failures, 'projected connection coverage accuracy', metrics.projectedConnectionCoverageAccuracy, 1);
  minimum(failures, 'projected output completeness accuracy', metrics.projectedOutputCompletenessAccuracy, 1);
  minimum(failures, 'projected receipt accounting accuracy', metrics.projectedReceiptAccountingAccuracy, 1);
  minimum(failures, 'bounded-result accuracy', metrics.boundedResultAccuracy, 1);
  maximum(failures, 'lookup p95 milliseconds', metrics.lookupMilliseconds.p95, budget.maximumLookupP95Milliseconds);
  maximum(
    failures,
    'lookup maximum milliseconds',
    metrics.lookupMilliseconds.maximum,
    budget.maximumLookupSampleMilliseconds,
  );
  maximum(failures, 'response estimated tokens', metrics.maximumEstimatedTokens, budget.maximumResponseEstimatedTokens);
  maximum(
    failures,
    'canonical rereads per lookup',
    metrics.maximumCanonicalRereads,
    budget.maximumCanonicalRereadsPerLookup,
  );
  maximum(failures, 'raw link rows per lookup', metrics.maximumRawLinkRows, budget.maximumRawLinkRowsPerLookup);
  maximum(failures, 'corpus bytes', capture.corpus.corpusBytes, budget.maximumCorpusBytes);
  maximum(failures, 'added peak RSS bytes', capture.resources.addedPeakRssBytes, budget.maximumAddedPeakRssBytes);
  maximum(failures, 'recall storage bytes', capture.resources.recallStorageBytes, budget.maximumRecallStorageBytes);
  maximum(
    failures,
    'materialization milliseconds',
    capture.resources.materializationMilliseconds,
    budget.maximumMaterializationMilliseconds,
  );
  maximum(
    failures,
    'index build milliseconds',
    capture.resources.indexBuildMilliseconds,
    budget.maximumIndexBuildMilliseconds,
  );
  if (capture.corpus.corpusBytes <= 0) failures.push('corpus bytes must be positive');
  if (capture.resources.recallDatabaseBytes <= 0) failures.push('recall database bytes must be positive');
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
  if (metrics.duplicateResultCount !== 0) failures.push('duplicate results must be zero');
  if (metrics.incorrectConnectionCurrentnessCount !== 0)
    failures.push('connection currentness must match the frozen current fixture');
  if (metrics.incorrectConnectionReceiptIdentityCount !== 0)
    failures.push('connection receipt identities and roles must match the frozen projected prefix');
  if (metrics.incorrectConnectionResolutionCount !== 0)
    failures.push('connection resolution must match the frozen resolved fixture');
  if (metrics.incorrectPremiseReceiptIdentityCount !== 0)
    failures.push('premise receipt identity and role must match the frozen fixture');
  if (metrics.incorrectPremiseStateCount !== 0)
    failures.push('premise currentness must match the frozen current fixture');
  if (metrics.unexpectedReceiptIdentityCount !== 0) failures.push('unexpected receipt identities must be zero');
  if (metrics.unexpectedResultCount !== 0) failures.push('unexpected results must be zero');
  return {
    capture,
    createdAt,
    evidenceClass,
    gate: {failures: [...new Set(failures)].sort(), passed: failures.length === 0},
    identity,
    metrics,
    suite: MEMORY_CONNECTIONS_SCALE_ID,
    version: 1,
  };
}

/** Parse retained JSON and independently rederive every metric, class, and gate decision. */
export function parseMemoryConnectionsScaleArtifactV1(
  value: unknown,
  budget: MemoryConnectionsScaleBudgetV1 | unknown,
  candidate?: MemoryConnectionsScaleCandidateBinding,
): MemoryConnectionsScaleArtifactV1 {
  const artifact = record(value, 'artifact');
  exactKeys(artifact, ['capture', 'createdAt', 'evidenceClass', 'gate', 'identity', 'metrics', 'suite', 'version']);
  if (artifact.version !== MEMORY_CONNECTIONS_SCALE_VERSION) invalid('artifact version must be 1');
  if (artifact.suite !== MEMORY_CONNECTIONS_SCALE_ID) invalid(`artifact suite must be ${MEMORY_CONNECTIONS_SCALE_ID}`);
  const expected = evaluateMemoryConnectionsScaleCapture({
    budget,
    candidate,
    capture: artifact.capture,
    createdAt: nonEmptyString(artifact.createdAt, 'artifact createdAt'),
    identity: artifact.identity,
  });
  if (artifact.evidenceClass !== expected.evidenceClass) invalid('artifact evidence class is not derived correctly');
  if (!sameJson(artifact.metrics, expected.metrics)) invalid('artifact metrics do not match the retained observations');
  if (!sameJson(artifact.gate, expected.gate)) invalid('artifact gate does not match the retained observations');
  return expected;
}

/** Fail closed when hosted release evidence is relabeled or detached from its exact candidate. */
export function memoryConnectionsScaleReleaseIdentityFailures(
  identity: MemoryConnectionsScaleIdentityV1,
  candidate?: MemoryConnectionsScaleCandidateBinding,
): readonly string[] {
  const packageManagerRuntime = Effect.pipe(identity.packageManager, EffectString.startsWith('bun@'))
    ? `bun/${Effect.pipe(identity.packageManager, EffectString.slice('bun@'.length))}`
    : '';
  return EffectArray.filter(
    [
      candidate === undefined ? 'release evidence requires an independently derived candidate binding' : '',
      candidate === undefined || /^[0-9a-f]{40}$/u.test(candidate.commit)
        ? ''
        : 'candidate binding commit is not exact lowercase Git SHA-1',
      candidate === undefined ||
      (Effect.pipe(candidate.packageManager, EffectString.startsWith('bun@')) &&
        CANDIDATE_PACKAGE_VERSION.test(Effect.pipe(candidate.packageManager, EffectString.slice('bun@'.length))))
        ? ''
        : 'candidate binding package manager must pin an explicit Bun version',
      candidate === undefined ||
      candidate.runtime === `bun/${Effect.pipe(candidate.packageManager, EffectString.slice('bun@'.length))}`
        ? ''
        : 'candidate binding runtime does not match its package manager',
      candidate === undefined ||
      (Effect.pipe(candidate.sourceVersion, EffectString.startsWith('threadnote-')) &&
        CANDIDATE_PACKAGE_VERSION.test(Effect.pipe(candidate.sourceVersion, EffectString.slice('threadnote-'.length))))
        ? ''
        : 'candidate binding source version must name an explicit Threadnote package version',
      candidate === undefined || identity.candidateCommit === candidate.commit
        ? ''
        : `claimed candidate ${identity.candidateCommit}; required reviewed candidate ${candidate.commit}`,
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
      identity.dirty ? 'release candidate checkout is dirty' : '',
      identity.gitStatusObserved ? '' : 'release candidate Git status could not be observed',
      identity.githubActions ? '' : 'release evidence was not produced by GitHub Actions',
      identity.runnerClass === MEMORY_CONNECTIONS_SCALE_RELEASE_RUNNER_CLASS
        ? ''
        : `runner class ${identity.runnerClass}; required ${MEMORY_CONNECTIONS_SCALE_RELEASE_RUNNER_CLASS}`,
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
      identity.runtime === packageManagerRuntime
        ? ''
        : `runtime ${identity.runtime}; required package-manager runtime ${packageManagerRuntime || 'bun/<version>'}`,
      Effect.pipe(identity.packageManager, EffectString.startsWith('bun@')) &&
      CANDIDATE_PACKAGE_VERSION.test(Effect.pipe(identity.packageManager, EffectString.slice('bun@'.length)))
        ? ''
        : 'package manager must pin an explicit Bun version',
      Effect.pipe(identity.sourceVersion, EffectString.startsWith('threadnote-')) &&
      CANDIDATE_PACKAGE_VERSION.test(Effect.pipe(identity.sourceVersion, EffectString.slice('threadnote-'.length)))
        ? ''
        : 'source version must name an explicit Threadnote package version',
    ],
    Boolean,
  );
}

function parseCapture(value: unknown): MemoryConnectionsScaleCaptureV1 {
  const capture = record(value, 'capture');
  exactKeys(capture, ['corpus', 'fixtureHash', 'resources', 'scenarios']);
  const corpus = record(capture.corpus, 'capture corpus');
  exactKeys(corpus, ['authorizedHubMemoryCount', 'corpusBytes', 'indexedMemoryCount', 'materializedMemoryCount']);
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
  const scenarios = EffectArray.map(
    boundedArray(capture.scenarios, 'capture scenarios', 1, MEMORY_CONNECTIONS_SCALE_SCENARIOS.length),
    parseScenario,
  );
  assertUnique(
    EffectArray.map(scenarios, scenario => scenario.id),
    'scenario ids',
  );
  return {
    corpus: {
      authorizedHubMemoryCount: nonNegativeInteger(corpus.authorizedHubMemoryCount, 'authorized hub memory count'),
      corpusBytes: nonNegativeInteger(corpus.corpusBytes, 'corpus bytes'),
      indexedMemoryCount: nonNegativeInteger(corpus.indexedMemoryCount, 'indexed memory count'),
      materializedMemoryCount: nonNegativeInteger(corpus.materializedMemoryCount, 'materialized memory count'),
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

function parseScenario(value: unknown): MemoryConnectionsScaleScenarioCaptureV1 {
  const scenario = record(value, 'scenario');
  exactKeys(scenario, ['cold', 'expectedMemoryIds', 'expectedTruncated', 'id', 'samples', 'warmups']);
  if (!isScenarioId(scenario.id)) invalid(`unsupported scenario ${String(scenario.id)}`);
  if (typeof scenario.expectedTruncated !== 'boolean') invalid('scenario expectedTruncated must be boolean');
  const expectedMemoryIds = EffectArray.map(
    boundedArray(scenario.expectedMemoryIds, 'scenario expectedMemoryIds', 0, 64),
    (memoryId, index) => nonEmptyString(memoryId, `expected memory id ${index}`),
  );
  assertUnique(expectedMemoryIds, 'expected memory ids');
  return {
    cold: parseObservation(scenario.cold),
    expectedMemoryIds,
    expectedTruncated: scenario.expectedTruncated,
    id: scenario.id,
    samples: EffectArray.map(boundedArray(scenario.samples, 'scenario samples', 1, 256), parseObservation),
    warmups: EffectArray.map(boundedArray(scenario.warmups, 'scenario warmups', 0, 256), parseObservation),
  };
}

function parseObservation(value: unknown): MemoryConnectionsScaleObservationV1 {
  const observation = record(value, 'lookup observation');
  exactKeys(observation, [
    'canonicalRereads',
    'estimatedTokens',
    'milliseconds',
    'omittedConnectionReceiptCount',
    'omittedPremiseReceiptCount',
    'projectedConnections',
    'projectedCoverageConnectionCount',
    'projectedCoveragePremiseCount',
    'projectedCoverageResultCount',
    'projectedConnectionCoverageTruncated',
    'projectedOutputTruncated',
    'projectedPremises',
    'rawLinkRows',
    'retrievalTruncated',
    'returnedMemoryIds',
  ]);
  return {
    canonicalRereads: nonNegativeInteger(observation.canonicalRereads, 'canonical rereads'),
    estimatedTokens: nonNegativeInteger(observation.estimatedTokens, 'estimated tokens'),
    milliseconds: nonNegativeFinite(observation.milliseconds, 'lookup milliseconds'),
    omittedConnectionReceiptCount: nonNegativeInteger(
      observation.omittedConnectionReceiptCount,
      'omitted connection receipt count',
    ),
    omittedPremiseReceiptCount: nonNegativeInteger(
      observation.omittedPremiseReceiptCount,
      'omitted premise receipt count',
    ),
    projectedConnections: EffectArray.map(
      boundedArray(observation.projectedConnections, 'projected connections', 0, 64),
      parseConnectionReceipt,
    ),
    projectedCoverageConnectionCount: nonNegativeInteger(
      observation.projectedCoverageConnectionCount,
      'projected coverage connection count',
    ),
    projectedCoveragePremiseCount: nonNegativeInteger(
      observation.projectedCoveragePremiseCount,
      'projected coverage premise count',
    ),
    projectedCoverageResultCount: nonNegativeInteger(
      observation.projectedCoverageResultCount,
      'projected coverage result count',
    ),
    projectedConnectionCoverageTruncated: booleanValue(
      observation.projectedConnectionCoverageTruncated,
      'projected connection coverage truncated',
    ),
    projectedOutputTruncated: booleanValue(observation.projectedOutputTruncated, 'projected output truncated'),
    projectedPremises: EffectArray.map(
      boundedArray(observation.projectedPremises, 'projected premises', 0, 8),
      parsePremiseReceipt,
    ),
    rawLinkRows: nonNegativeInteger(observation.rawLinkRows, 'raw link rows'),
    retrievalTruncated: booleanValue(observation.retrievalTruncated, 'retrieval truncated'),
    returnedMemoryIds: EffectArray.map(
      boundedArray(observation.returnedMemoryIds, 'returned memory ids', 0, 64),
      (memoryId, index) => nonEmptyString(memoryId, `returned memory id ${index}`),
    ),
  };
}

function parseConnectionReceipt(value: unknown): MemoryConnectionsScaleConnectionReceiptEvidenceV1 {
  const receipt = record(value, 'connection receipt');
  exactKeys(receipt, [
    'currentness',
    'direction',
    'distance',
    'neighborMemoryId',
    'origin',
    'relationOrdinal',
    'relationType',
    'requestedOrdinal',
    'resolution',
    'sourceMemoryId',
    'targetMemoryId',
  ]);
  return {
    currentness: nonEmptyString(receipt.currentness, 'connection currentness'),
    direction: nonEmptyString(receipt.direction, 'connection direction'),
    distance: nonNegativeInteger(receipt.distance, 'connection distance'),
    neighborMemoryId: nullableString(receipt.neighborMemoryId, 'connection neighbor memory id'),
    origin: nonEmptyString(receipt.origin, 'connection origin'),
    relationOrdinal: nonNegativeInteger(receipt.relationOrdinal, 'connection relation ordinal'),
    relationType: nonEmptyString(receipt.relationType, 'connection relation type'),
    requestedOrdinal: nonNegativeInteger(receipt.requestedOrdinal, 'connection requested ordinal'),
    resolution: nonEmptyString(receipt.resolution, 'connection resolution'),
    sourceMemoryId: nullableString(receipt.sourceMemoryId, 'connection source memory id'),
    targetMemoryId: nullableString(receipt.targetMemoryId, 'connection target memory id'),
  };
}

function parsePremiseReceipt(value: unknown): MemoryConnectionsScalePremiseReceiptEvidenceV1 {
  const receipt = record(value, 'premise receipt');
  exactKeys(receipt, ['memoryId', 'requestedOrdinal', 'state']);
  return {
    memoryId: nullableString(receipt.memoryId, 'premise memory id'),
    requestedOrdinal: nonNegativeInteger(receipt.requestedOrdinal, 'premise requested ordinal'),
    state: nonEmptyString(receipt.state, 'premise state'),
  };
}

function parseIdentity(value: unknown): MemoryConnectionsScaleIdentityV1 {
  const identity = record(value, 'identity');
  exactKeys(identity, [
    'architecture',
    'builtArtifactSha256',
    'candidateCommit',
    'cpu',
    'dirty',
    'gitStatusObserved',
    'githubActions',
    'invocationMode',
    'observedCommit',
    'operatingSystem',
    'packageManager',
    'runnerArchitecture',
    'runnerClass',
    'runnerEnvironment',
    'runnerOperatingSystem',
    'runtime',
    'sourceVersion',
  ]);
  if (typeof identity.dirty !== 'boolean') invalid('identity dirty must be boolean');
  if (typeof identity.gitStatusObserved !== 'boolean') invalid('identity gitStatusObserved must be boolean');
  if (typeof identity.githubActions !== 'boolean') invalid('identity githubActions must be boolean');
  if (identity.invocationMode !== 'development-smoke' && identity.invocationMode !== 'release-scale') {
    invalid('identity invocationMode must be development-smoke or release-scale');
  }
  return {
    architecture: nonEmptyString(identity.architecture, 'identity architecture'),
    builtArtifactSha256: stringValue(identity.builtArtifactSha256, 'built artifact digest'),
    candidateCommit: lowercaseHex(identity.candidateCommit, 40, 'candidate commit'),
    cpu: nonEmptyString(identity.cpu, 'identity cpu'),
    dirty: identity.dirty,
    gitStatusObserved: identity.gitStatusObserved,
    githubActions: identity.githubActions,
    invocationMode: identity.invocationMode,
    observedCommit: lowercaseHex(identity.observedCommit, 40, 'observed commit'),
    operatingSystem: nonEmptyString(identity.operatingSystem, 'identity operating system'),
    packageManager: nonEmptyString(identity.packageManager, 'identity package manager'),
    runnerArchitecture: nonEmptyString(identity.runnerArchitecture, 'identity runner architecture'),
    runnerClass: nonEmptyString(identity.runnerClass, 'identity runner class'),
    runnerEnvironment: nonEmptyString(identity.runnerEnvironment, 'identity runner environment'),
    runnerOperatingSystem: nonEmptyString(identity.runnerOperatingSystem, 'identity runner operating system'),
    runtime: nonEmptyString(identity.runtime, 'identity runtime'),
    sourceVersion: nonEmptyString(identity.sourceVersion, 'identity source version'),
  };
}

function projectedConnectionCoverageIsExact(value: MemoryConnectionsScaleObservationV1): boolean {
  const returnedMemoryIds = new Set(value.returnedMemoryIds);
  const receiptBackedMemoryIds = new Set(
    EffectArrayPipe(value.projectedConnections, __effectFlatMapValues =>
      EffectArray.flatMap(__effectFlatMapValues, (connection, __effectFlatMapIndex) =>
        __effectFlatMapIndex in __effectFlatMapValues
          ? connection.neighborMemoryId !== null && returnedMemoryIds.has(connection.neighborMemoryId)
            ? [connection.neighborMemoryId]
            : []
          : [],
      ),
    ),
  );
  const hasRequiredActionableBundle =
    value.returnedMemoryIds.length === 0 ||
    EffectArray.some(
      value.projectedConnections,
      connection =>
        connection.resolution === 'resolved' &&
        (connection.currentness === 'current' || connection.currentness === 'historical') &&
        connection.neighborMemoryId !== null &&
        returnedMemoryIds.has(connection.neighborMemoryId) &&
        EffectArray.some(
          value.projectedPremises,
          premise =>
            premise.requestedOrdinal === connection.requestedOrdinal &&
            (premise.state === 'current' || premise.state === 'historical'),
        ),
    );
  return (
    hasRequiredActionableBundle &&
    value.projectedConnectionCoverageTruncated ===
      (value.retrievalTruncated || value.omittedConnectionReceiptCount > 0 || value.omittedPremiseReceiptCount > 0) &&
    value.projectedCoverageConnectionCount === value.projectedConnections.length &&
    value.projectedCoveragePremiseCount === value.projectedPremises.length &&
    value.projectedCoverageResultCount === receiptBackedMemoryIds.size
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 1 : EffectArray.reduce(values, 0, (total, value) => total + value) / values.length;
}

function exact(failures: string[], label: string, actual: number, expected: number): void {
  if (actual !== expected) failures.push(`${label} ${actual}; required ${expected}`);
}

function minimum(failures: string[], label: string, actual: number, expected: number): void {
  if (actual < expected) failures.push(`${label} ${actual}; minimum ${expected}`);
}

function maximum(failures: string[], label: string, actual: number, expected: number): void {
  if (actual > expected) failures.push(`${label} ${actual}; maximum ${expected}`);
}

function boundedArray(value: unknown, label: string, minimum: number, maximum: number): readonly unknown[] {
  if (!EffectArray.isArray(value) || value.length < minimum || value.length > maximum) {
    invalid(`${label} must contain between ${minimum} and ${maximum} entries`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value) || EffectArray.isArray(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const actual = EffectRecord.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (!sameJson(actual, expected)) invalid(`unexpected keys ${EffectArray.join(actual, ', ')}`);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value;
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

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : nonEmptyString(value, label);
}

function nonEmptyString(value: unknown, label: string): string {
  const parsed = stringValue(value, label);
  if (!Effect.pipe(parsed, EffectString.trim) || parsed.length > 2_048)
    invalid(`${label} must be non-empty and at most 2048 characters`);
  return parsed;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
  return value;
}

function isoInstant(value: unknown, label: string): string {
  const parsed = nonEmptyString(value, label);
  const date = new Date(parsed);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== parsed) {
    invalid(`${label} must be a canonical ISO instant`);
  }
  return parsed;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function isScenarioId(value: unknown): value is MemoryConnectionsScaleScenarioId {
  return value === 'incoming-hub' || value === 'sparse-incoming' || value === 'no-answer';
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): never {
  throw new Error(`Invalid memory-connections scale contract: ${message}.`);
}
