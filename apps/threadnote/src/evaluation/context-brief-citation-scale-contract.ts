import {benchmarkMeasurement, type BenchmarkMeasurementV1} from '@threadnote/evidence/benchmark';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Predicate} from 'effect';

export const CONTEXT_BRIEF_CITATION_SCALE_VERSION = 1 as const;
export const CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS = ['local-100k', 'workset-50', 'workset-128'] as const;
export const CONTEXT_BRIEF_CITATION_SCALE_RELEASE_RUNNER_CLASS = 'github-hosted-macos-15-ARM64' as const;
export const CONTEXT_BRIEF_CITATION_SCALE_RELEASE_RUNTIME = 'bun/1.3.14' as const;
export const CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SOURCE_VERSION = 'threadnote-4.6.0' as const;
export const CONTEXT_BRIEF_CITATION_SCALE_ARTIFACT_SUITE = 'context-brief-citations-scale-v2' as const;
export const CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES = 100 as const;
export const CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS = 5 as const;
export const CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2 = {
  extractorSet: {
    id: 'empty-language-pack-provenance-v1',
    languagePackProvenance: [],
  },
  fixedInstant: '2026-08-26T00:00:00.000Z',
  legacyNoise: {
    body: 'Unrelated legacy memory fixture about ceramic glazing and coastal weather.',
    directory: 'noise',
    extension: '.md',
    ordinalWidth: 6,
    pathContract: 'noise/<thousand-shard>/<six-digit-ordinal>.md',
    schemaVersion: 1,
    shardSize: 1_000,
    shardWidth: 3,
    topic: 'legacy-scale-noise',
  },
  project: 'threadnote-scale',
  repositorySource: {
    contentContract: 'repository-relative-source-path-v1',
    directory: 'src/context-brief-scale',
    extension: '.ts',
    pathContract: 'src/context-brief-scale/<profile>/<run-token>/<citation-ordinal>.ts',
  },
  selectedMemory: {
    body: 'Context Brief citation scale sentinel <run-token> preserves bounded ready-graph evidence.',
    citationAllocation: 'round-robin-citation-index-v1',
    extension: '.md',
    memoryOrdinalWidth: 2,
    pathContract: '<first-profile-repository>/<profile>/<run-token>/<topic>.md',
    projectAssignment: 'first-profile-repository-v1',
    schemaVersion: 4,
    topicSeparator: '-',
    topicContract: '<profile>-<run-token>-<two-digit-memory-ordinal>',
  },
} as const;
/**
 * Changing this requires review of the complete fixture contract, not a benchmark rerun during verification.
 */
export const CONTEXT_BRIEF_CITATION_SCALE_REVIEWED_FIXTURE_IDENTITY_HASH =
  '42ac0ef188ce362d5c14235d339d09c138d4b69bda65e42c85d327b16e23c4df' as const;
const CANDIDATE_PACKAGE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
export const CONTEXT_BRIEF_CITATION_RSS_SAMPLING_SCHEDULE = 'absolute-monotonic-deadline-v1' as const;
export const CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3 = {
  breachThresholdMilliseconds: 100,
  hardMaximumGapMilliseconds: 550,
  maximumBreachRate: 0.1,
  maximumConsecutiveBreaches: 2,
  version: 3,
} as const;

export const CONTEXT_BRIEF_CITATION_SCALE_EXECUTION_V2 = {
  citationReceiptCache: 'cold-per-sample',
  coldGraphBuilds: 0,
  graphDatabaseSessionCounter:
    'instruments calls that reach the production CodeGraphStore.withSession implementation against real prebuilt SQLite files; OS file-descriptor opens are not separately counted',
  graphSnapshots: 'real-sqlite-prebuilt-ready',
  memoryMeasurement:
    'a first-use untimed pass runs before timing, uses begin/end barriers around each production observation and an observer-excluded external recursive process-tree sampler on absolute monotonic deadlines, then records a post-final-GC stop sample; the hard gates retain raw maximum gaps while bounding >100ms observation breaches to 10%, two consecutive breaches, and a 550ms hard maximum, and use observed tree peak minus its immediate baseline plus retained root growth through the final sample; boundary RSS remains diagnostic',
  recallIndex: 'real-sqlite-prebuilt-before-timing',
  timingScope:
    'observer-free warm real SQLite recall retrieval after first-use memory evidence, plus production Git identity/status observation, graph SQLite session/lease/evidence reads, citation grouping/validation, Context Brief assembly, and projection; every sample uses unseen citation IDs; fixture creation, recall indexing, ready-snapshot activation, catalog publication, and cold graph indexing are excluded',
} as const;

export type ContextBriefCitationScaleProfileId = (typeof CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS)[number];

export interface ContextBriefCitationRssSampleGapSummaryV1 {
  readonly maximumConsecutiveSampleGapBreaches: number;
  readonly maximumSampleGapMilliseconds: number;
  readonly sampleGapBreachCount: number;
  readonly sampleGapBreachRate: number;
}

/** Derive bounded scheduler quality evidence from observations in their execution order. */
export function contextBriefCitationRssSampleGapSummary(
  maximumGapsMilliseconds: readonly number[],
): ContextBriefCitationRssSampleGapSummaryV1 {
  if (maximumGapsMilliseconds.some(gap => !Number.isSafeInteger(gap) || gap < 0)) {
    invalid('RSS sample gaps must be non-negative safe integers');
  }
  let consecutiveBreaches = 0;
  let maximumConsecutiveSampleGapBreaches = 0;
  let sampleGapBreachCount = 0;
  for (const gap of maximumGapsMilliseconds) {
    if (gap > CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3.breachThresholdMilliseconds) {
      sampleGapBreachCount += 1;
      consecutiveBreaches += 1;
      maximumConsecutiveSampleGapBreaches = Math.max(maximumConsecutiveSampleGapBreaches, consecutiveBreaches);
    } else {
      consecutiveBreaches = 0;
    }
  }
  return {
    maximumConsecutiveSampleGapBreaches,
    maximumSampleGapMilliseconds: Math.max(0, ...maximumGapsMilliseconds),
    sampleGapBreachCount,
    sampleGapBreachRate:
      maximumGapsMilliseconds.length === 0 ? 0 : sampleGapBreachCount / maximumGapsMilliseconds.length,
  };
}

/** Gate scheduler quality without treating one bounded hosted-runner stall as a product regression. */
export function contextBriefCitationRssSampleGapFailures(
  summary: ContextBriefCitationRssSampleGapSummaryV1,
  observationCount: number,
): readonly string[] {
  return [
    summary.sampleGapBreachRate <= CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3.maximumBreachRate
      ? ''
      : `external RSS observer sample-gap breach rate ${summary.sampleGapBreachCount}/${observationCount} (${(
          summary.sampleGapBreachRate * 100
        ).toFixed(
          1,
        )}%) exceeds ${(CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3.maximumBreachRate * 100).toFixed(1)}%`,
    summary.maximumConsecutiveSampleGapBreaches <=
    CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3.maximumConsecutiveBreaches
      ? ''
      : `external RSS observer recorded ${summary.maximumConsecutiveSampleGapBreaches} consecutive sample-gap breaches; maximum ${CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3.maximumConsecutiveBreaches}`,
    summary.maximumSampleGapMilliseconds <= CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3.hardMaximumGapMilliseconds
      ? ''
      : `external RSS observer maximum sample gap ${summary.maximumSampleGapMilliseconds}ms exceeds hard maximum ${CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3.hardMaximumGapMilliseconds}ms`,
  ].filter(Boolean);
}

export interface ContextBriefCitationScaleProfileV1 {
  readonly citationCount: number;
  readonly citedRepositories: number;
  readonly id: ContextBriefCitationScaleProfileId;
  readonly maximumBriefP95Milliseconds: number;
  readonly maximumValidationP95Milliseconds: number;
  readonly selectedMemories: number;
  readonly worksetMembers: number;
}

export interface ContextBriefCitationScaleBudgetV1 {
  readonly corpusMemoryCandidates: number;
  readonly id: string;
  readonly maximumObservedAddedProcessTreeRssBytes: number;
  readonly maximumCitationsPerBrief: number;
  readonly maximumEstimatedTokens: number;
  readonly profiles: readonly ContextBriefCitationScaleProfileV1[];
  readonly version: typeof CONTEXT_BRIEF_CITATION_SCALE_VERSION;
}

export interface ContextBriefCitationScaleCountersV1 {
  readonly activeViewFenceObservations: number;
  readonly coldGraphBuilds: number;
  readonly distinctGraphDatabasePaths: number;
  readonly effectiveEvidenceBatches: number;
  readonly leaseBalance: number;
  readonly maintenanceRequests: number;
  readonly peakLeaseBalance: number;
  /** Calls reaching the production store's real SQLite session boundary. */
  readonly productionStoreSessionCalls: number;
  readonly snapshotLeaseAcquisitions: number;
  readonly snapshotLeaseReleases: number;
  readonly statusObservations: number;
}

export interface ContextBriefCitationScaleObservationV2 {
  /** Boundary-sampled current-process RSS retained as non-gating allocator diagnostics. */
  readonly boundaryAddedRssBytes: number;
  readonly contextBriefMilliseconds: number;
  readonly counters: ContextBriefCitationScaleCountersV1;
  readonly estimatedTokens: number;
  readonly exactValidationReceipts: number;
  readonly memoryRetrievalMilliseconds: number;
  readonly profile: ContextBriefCitationScaleProfileId;
  readonly selectedMemories: number;
  readonly validationMilliseconds: number;
  readonly validationReceipts: number;
}

export interface ContextBriefCitationScaleMemoryObservationV2 {
  readonly baselineProcessCount: number;
  readonly maximumSampleGapMilliseconds: number;
  readonly observedAddedProcessTreeRssBytes: number;
  readonly observedAddedRootRssBytes: number;
  readonly observedProcessTreeRssBaselineBytes: number;
  readonly observedProcessTreeRssPeakBytes: number;
  readonly observedRootRssBaselineBytes: number;
  readonly observedRootRssPeakBytes: number;
  readonly observationId: string;
  readonly ordinal: number;
  readonly peakProcessCount: number;
  readonly profile: ContextBriefCitationScaleProfileId;
  readonly rootStartIdentity: string;
  readonly sampleAttempts: number;
  readonly sampleFailures: number;
  readonly sampleIntervalMilliseconds: number;
  readonly samples: number;
  readonly source: 'darwin-ps' | 'linux-proc';
}

export interface ContextBriefCitationScaleMeasuredObservationV2 extends ContextBriefCitationScaleObservationV2 {
  /** Separate observer-excluded memory pass; its latency is never pooled into the timing distribution. */
  readonly memory: ContextBriefCitationScaleMemoryObservationV2;
  /** Production-workload result from the separate memory pass, retained for independent correctness verification. */
  readonly memoryWorkload: ContextBriefCitationScaleObservationV2;
}

export interface ContextBriefCitationScaleProfileResultV2 {
  readonly coldReadyGraphObservation: ContextBriefCitationScaleObservationV2;
  readonly counters: {
    readonly maximumActiveViewFenceObservations: number;
    readonly maximumDistinctGraphDatabasePaths: number;
    readonly maximumEffectiveEvidenceBatches: number;
    readonly maximumLeaseBalance: number;
    readonly maximumMaintenanceRequests: number;
    readonly maximumPeakLeaseBalance: number;
    readonly maximumProductionStoreSessionCalls: number;
    readonly maximumStatusObservations: number;
  };
  readonly measurements: {
    readonly boundaryAddedRssBytes: BenchmarkMeasurementV1;
    readonly contextBriefMilliseconds: BenchmarkMeasurementV1;
    readonly memoryRetrievalMilliseconds: BenchmarkMeasurementV1;
    readonly validationMilliseconds: BenchmarkMeasurementV1;
    readonly observedAddedProcessTreeRssBytes: BenchmarkMeasurementV1;
  };
  readonly memoryCoverage: {
    readonly descendantObservationCount: number;
    readonly descendantObservationRate: number;
    readonly maximumPeakProcessCount: number;
    readonly minimumSuccessfulSamples: number;
  };
  readonly observations: readonly ContextBriefCitationScaleMeasuredObservationV2[];
  readonly profile: ContextBriefCitationScaleProfileV1;
  readonly samples: number;
}

export interface ContextBriefCitationScaleGateV1 {
  readonly failures: readonly string[];
  readonly passed: boolean;
}

export interface ContextBriefCitationScaleReleaseIdentityV1 {
  readonly architecture: string;
  readonly candidateCommit: string;
  readonly commit: string;
  readonly cpu: string;
  readonly dirty: boolean;
  readonly gitStatusObserved: boolean;
  readonly githubActions: boolean;
  readonly operatingSystem: string;
  readonly runnerClass: string;
  readonly runnerArchitecture: string;
  readonly runnerEnvironment: string;
  readonly runnerOperatingSystem: string;
  readonly runtime: string;
  readonly sourceVersion: string;
}

/** External review context, read from the exact candidate Git object rather than the artifact. */
export interface ContextBriefCitationScaleCandidateBinding {
  readonly commit: string;
  readonly runtime: string;
  readonly sourceVersion: string;
}

export function contextBriefCitationScaleCandidateBinding(
  commit: string,
  packageManifest: unknown,
): ContextBriefCitationScaleCandidateBinding {
  if (!/^[0-9a-f]{40}$/u.test(commit)) invalid('candidate binding requires an exact lowercase Git SHA-1');
  const manifest = record(packageManifest, 'candidate package manifest');
  const version = boundedString(manifest.version, 'candidate package version');
  if (!CANDIDATE_PACKAGE_VERSION.test(version)) {
    invalid('candidate package version must be an explicit version');
  }
  const packageManager = boundedString(manifest.packageManager, 'candidate package manager');
  if (!packageManager.startsWith('bun@') || !CANDIDATE_PACKAGE_VERSION.test(packageManager.slice('bun@'.length))) {
    invalid('candidate package manager must pin an explicit Bun version');
  }
  return {commit, runtime: `bun/${packageManager.slice('bun@'.length)}`, sourceVersion: `threadnote-${version}`};
}

export type ContextBriefCitationScaleEvidenceClass = 'development-smoke' | 'release-scale';

export interface ContextBriefCitationScaleEnvironmentV2 extends ContextBriefCitationScaleReleaseIdentityV1 {
  readonly memoryBytes: number;
}

export type ContextBriefCitationScaleExecutionV2 = typeof CONTEXT_BRIEF_CITATION_SCALE_EXECUTION_V2 & {
  readonly builtArtifactSha256: string;
};

export interface ContextBriefCitationScaleFixtureV2 {
  readonly hash: string;
  readonly indexedMemoryCandidates: number;
  readonly legacyV1MemoryCandidates: number;
  readonly readyGraphSetupMilliseconds: number;
  readonly recallIndexBuildMilliseconds: number;
  readonly requestedMemoryCandidates: number;
  readonly worksetGenerationDigests: readonly [string, string];
  readonly worksetRepositoryIdentities: readonly [50, 128];
}

export interface ContextBriefCitationScaleFixturePlanProfileV2 {
  readonly citationCount: number;
  readonly citedRepositories: number;
  readonly citationsPerMemory: number;
  readonly id: ContextBriefCitationScaleProfileId;
  readonly selectedMemories: number;
  readonly selectedRecordsPerRun: number;
  readonly worksetMembers: number;
}

/** Bounded release-fixture shape derived from the reviewed budget and exact measurement schedule. */
export interface ContextBriefCitationScaleReviewedFixturePlanV2 {
  readonly contracts: typeof CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2;
  readonly counts: {
    readonly indexedMemoryCandidates: number;
    readonly legacyV1MemoryCandidates: number;
    readonly requestedMemoryCandidates: number;
    readonly selectedMemoryCandidates: number;
  };
  readonly profiles: readonly ContextBriefCitationScaleFixturePlanProfileV2[];
  readonly schedule: {
    readonly runCount: number;
    readonly samples: number;
    readonly warmups: number;
  };
  readonly selectedProfiles: readonly ContextBriefCitationScaleProfileId[];
  readonly version: 2;
}

export interface ContextBriefCitationScaleReviewedFixtureIdentityV2 extends ContextBriefCitationScaleReviewedFixturePlanV2 {
  readonly hash: string;
}

export function contextBriefCitationScaleFixturePlan(
  budget: Pick<ContextBriefCitationScaleBudgetV1, 'corpusMemoryCandidates' | 'profiles'>,
  memoryCandidates: number,
  profileIds: readonly ContextBriefCitationScaleProfileId[],
  samples: number,
  warmups: number,
): ContextBriefCitationScaleReviewedFixturePlanV2 {
  const measuredSamples = positiveInteger(samples, 'reviewed fixture samples');
  const measuredWarmups = nonNegativeSafeInteger(warmups, 'reviewed fixture warmups');
  const requestedMemoryCandidates = positiveInteger(memoryCandidates, 'reviewed fixture memory candidates');
  const runsPerProfile = measuredWarmups + measuredSamples * 2;
  if (!Number.isSafeInteger(runsPerProfile)) invalid('reviewed fixture run count must be a safe integer');
  const profilesById = new Map(budget.profiles.map(profile => [profile.id, profile]));
  if (profilesById.size !== CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS.length) {
    invalid('reviewed fixture profiles must have unique ids');
  }
  const selectedProfileIds = new Set(profileIds);
  if (selectedProfileIds.size !== profileIds.length) invalid('reviewed fixture selected profiles must be unique');
  const selectedProfiles = CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS.filter(profileId =>
    selectedProfileIds.has(profileId),
  );
  if (selectedProfiles.length !== profileIds.length) invalid('reviewed fixture selected profile is unknown');
  const profiles = CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS.map(profileId => {
    const profile = profilesById.get(profileId);
    if (!profile) invalid(`reviewed fixture is missing ${profileId}`);
    const citationCount = positiveInteger(profile.citationCount, `${profileId} citation count`);
    const citedRepositories = positiveInteger(profile.citedRepositories, `${profileId} cited repositories`);
    const selectedMemories = positiveInteger(profile.selectedMemories, `${profileId} selected memories`);
    const worksetMembers = positiveInteger(profile.worksetMembers, `${profileId} workset members`);
    const citationsPerMemory = citationCount / selectedMemories;
    if (!Number.isInteger(citationsPerMemory) || citationsPerMemory > 8) {
      invalid(`Invalid citation allocation for ${profileId}.`);
    }
    if (citedRepositories > worksetMembers) invalid(`${profileId} cited repositories exceed workset members`);
    return {
      citationCount,
      citedRepositories,
      citationsPerMemory,
      id: profileId,
      selectedMemories,
      selectedRecordsPerRun: selectedMemories,
      worksetMembers,
    };
  });
  const selectedMemoryCandidates = profiles
    .filter(profile => selectedProfileIds.has(profile.id))
    .reduce((total, profile) => total + profile.selectedRecordsPerRun * runsPerProfile, 0);
  if (!Number.isSafeInteger(selectedMemoryCandidates) || selectedMemoryCandidates > requestedMemoryCandidates) {
    invalid('reviewed fixture selected memories exceed the reviewed corpus');
  }
  return {
    contracts: CONTEXT_BRIEF_CITATION_SCALE_FIXTURE_CONTRACT_V2,
    counts: {
      indexedMemoryCandidates: requestedMemoryCandidates,
      legacyV1MemoryCandidates: requestedMemoryCandidates - selectedMemoryCandidates,
      requestedMemoryCandidates,
      selectedMemoryCandidates,
    },
    profiles,
    schedule: {runCount: runsPerProfile, samples: measuredSamples, warmups: measuredWarmups},
    selectedProfiles,
    version: 2,
  };
}

export function contextBriefCitationScaleFixturePlanHash(plan: ContextBriefCitationScaleReviewedFixturePlanV2): string {
  return sha256HexSync(`${JSON.stringify(plan)}\n`);
}

export function contextBriefCitationScaleFixtureCitationRepositoryOrdinal(
  citationOrdinal: number,
  citedRepositories: number,
): number {
  return citationOrdinal % citedRepositories;
}

/** Normalize the approved budget and schedule into the release fixture's complete semantic identity. */
export function contextBriefCitationScaleReviewedFixtureIdentity(
  budgetInput: ContextBriefCitationScaleBudgetV1 | unknown,
  samples: number,
  warmups: number,
): ContextBriefCitationScaleReviewedFixtureIdentityV2 {
  const budget = parseContextBriefCitationScaleBudgetV1(budgetInput);
  const normalized = contextBriefCitationScaleFixturePlan(
    budget,
    budget.corpusMemoryCandidates,
    CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS,
    samples,
    warmups,
  );
  return {...normalized, hash: contextBriefCitationScaleFixturePlanHash(normalized)};
}

export interface ContextBriefCitationScaleMemoryObserverV2 {
  readonly finalSample: {
    readonly processCount: number;
    readonly rootRssBytes: number;
    readonly sampleAttempts: number;
    readonly sampleFailures: number;
    readonly treeRssBytes: number;
  };
  readonly intervalMilliseconds: number;
  readonly maximumConsecutiveSampleGapBreaches: number;
  readonly maximumSampleGapMilliseconds: number;
  readonly observationCount: number;
  readonly observerExcluded: true;
  readonly processCountPeakObserved: number;
  readonly retainedRootRssGrowthBytes: number;
  readonly rootIdentityValidation: 'darwin-ps-lstart' | 'linux-proc-starttime';
  readonly rootStartIdentity: string;
  readonly sampleGapBreachCount: number;
  readonly sampleGapBreachRate: number;
  readonly sampleGapPolicy: typeof CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3;
  readonly sampleAttempts: number;
  readonly sampleFailures: number;
  readonly scope: 'recursive-process-tree';
  readonly samplingSchedule: typeof CONTEXT_BRIEF_CITATION_RSS_SAMPLING_SCHEDULE;
  readonly source: 'darwin-ps' | 'linux-proc';
  readonly successfulSamples: number;
  readonly version: 2;
}

export interface ContextBriefCitationScaleArtifactV2 {
  readonly createdAt: string;
  readonly evidenceClass: ContextBriefCitationScaleEvidenceClass;
  readonly environment: ContextBriefCitationScaleEnvironmentV2;
  readonly execution: ContextBriefCitationScaleExecutionV2;
  readonly fixture: ContextBriefCitationScaleFixtureV2;
  readonly gate: ContextBriefCitationScaleGateV1;
  readonly memoryObserver: ContextBriefCitationScaleMemoryObserverV2;
  readonly profiles: readonly ContextBriefCitationScaleProfileResultV2[];
  readonly samples: number;
  readonly suite: typeof CONTEXT_BRIEF_CITATION_SCALE_ARTIFACT_SUITE;
  readonly version: 2;
  readonly warmups: number;
}

const EXACT_PROFILE_SHAPES: Readonly<
  Record<
    ContextBriefCitationScaleProfileId,
    Pick<
      ContextBriefCitationScaleProfileV1,
      'citationCount' | 'citedRepositories' | 'selectedMemories' | 'worksetMembers'
    >
  >
> = {
  'local-100k': {citationCount: 96, citedRepositories: 1, selectedMemories: 24, worksetMembers: 1},
  'workset-50': {citationCount: 64, citedRepositories: 16, selectedMemories: 16, worksetMembers: 50},
  'workset-128': {citationCount: 96, citedRepositories: 32, selectedMemories: 24, worksetMembers: 128},
};

/** Parse the checked release envelope and reject silent shape or budget weakening. */
export function parseContextBriefCitationScaleBudgetV1(value: unknown): ContextBriefCitationScaleBudgetV1 {
  const budget = record(value, 'scale budget');
  exactKeys(budget, [
    'corpusMemoryCandidates',
    'id',
    'maximumObservedAddedProcessTreeRssBytes',
    'maximumCitationsPerBrief',
    'maximumEstimatedTokens',
    'profiles',
    'version',
  ]);
  if (budget.version !== 1) invalid('version must be 1');
  if (budget.id !== 'context-brief-citations-scale-v1') invalid('id is not the reviewed scale contract');
  if (budget.corpusMemoryCandidates !== 100_000) invalid('corpusMemoryCandidates must be 100000');
  if (budget.maximumCitationsPerBrief !== 96) invalid('maximumCitationsPerBrief must be 96');
  if (budget.maximumEstimatedTokens !== 1_500) invalid('maximumEstimatedTokens must be 1500');
  if (budget.maximumObservedAddedProcessTreeRssBytes !== 64 * 1_024 * 1_024) {
    invalid('maximumObservedAddedProcessTreeRssBytes must be 64 MiB');
  }
  if (!Array.isArray(budget.profiles) || budget.profiles.length !== CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS.length) {
    invalid('profiles must contain the three reviewed profiles');
  }
  const profiles = budget.profiles.map(parseProfile);
  for (const id of CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS) {
    if (profiles.filter(profile => profile.id === id).length !== 1) invalid(`profile ${id} must appear exactly once`);
  }
  return {
    corpusMemoryCandidates: 100_000,
    id: 'context-brief-citations-scale-v1',
    maximumObservedAddedProcessTreeRssBytes: 64 * 1_024 * 1_024,
    maximumCitationsPerBrief: 96,
    maximumEstimatedTokens: 1_500,
    profiles: CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS.map(id => profiles.find(profile => profile.id === id)!),
    version: 1,
  };
}

/** Aggregate repeated warm-ready observations and enforce safety, fan-out, and latency bounds. */
export function evaluateContextBriefCitationScaleProfile(
  budget: ContextBriefCitationScaleBudgetV1,
  profileId: ContextBriefCitationScaleProfileId,
  coldReadyGraphObservation: ContextBriefCitationScaleObservationV2,
  observations: readonly ContextBriefCitationScaleMeasuredObservationV2[],
): {readonly failures: readonly string[]; readonly result: ContextBriefCitationScaleProfileResultV2} {
  const profile = budget.profiles.find(candidate => candidate.id === profileId);
  if (!profile) throw new Error(`Unknown scale profile ${profileId}`);
  if (observations.length === 0) throw new Error(`Scale profile ${profileId} requires measured samples.`);
  const all = [coldReadyGraphObservation, ...observations];
  const memoryOrdinals = observations
    .map(observation => observation.memory.ordinal)
    .sort((left, right) => left - right);
  const expectedMemoryOrdinals = observations.map((_, index) => index);
  const memoryObservationIds = observations.map(observation => observation.memory.observationId);
  const measurements = {
    boundaryAddedRssBytes: measurement(
      'boundary-added-rss-diagnostic',
      observations.map(observation => observation.memoryWorkload.boundaryAddedRssBytes),
      'bytes',
    ),
    contextBriefMilliseconds: measurement(
      'context-brief-total',
      observations.map(observation => observation.contextBriefMilliseconds),
      'milliseconds',
    ),
    memoryRetrievalMilliseconds: measurement(
      'memory-retrieval',
      observations.map(observation => observation.memoryRetrievalMilliseconds),
      'milliseconds',
    ),
    validationMilliseconds: measurement(
      'citation-validation',
      observations.map(observation => observation.validationMilliseconds),
      'milliseconds',
    ),
    observedAddedProcessTreeRssBytes: measurement(
      'observed-added-process-tree-rss',
      observations.map(observation => observation.memory.observedAddedProcessTreeRssBytes),
      'bytes',
    ),
  };
  const descendantObservationCount = observations.filter(
    observation => observation.memory.peakProcessCount >= 2,
  ).length;
  const minimumDescendantObservations = profile.worksetMembers === 1 ? 1 : Math.ceil(observations.length * 0.8);
  const descendantCoverageRequirement =
    profile.worksetMembers === 1 ? 'required at least one sampled descendant' : 'required at least 80%';
  const memoryCoverage = {
    descendantObservationCount,
    descendantObservationRate: descendantObservationCount / observations.length,
    maximumPeakProcessCount: Math.max(...observations.map(observation => observation.memory.peakProcessCount)),
    minimumSuccessfulSamples: Math.min(...observations.map(observation => observation.memory.samples)),
  };
  const counters = {
    maximumActiveViewFenceObservations: maximum(all, observation => observation.counters.activeViewFenceObservations),
    maximumDistinctGraphDatabasePaths: maximum(all, observation => observation.counters.distinctGraphDatabasePaths),
    maximumEffectiveEvidenceBatches: maximum(all, observation => observation.counters.effectiveEvidenceBatches),
    maximumLeaseBalance: maximum(all, observation => observation.counters.leaseBalance),
    maximumMaintenanceRequests: maximum(all, observation => observation.counters.maintenanceRequests),
    maximumPeakLeaseBalance: maximum(all, observation => observation.counters.peakLeaseBalance),
    maximumProductionStoreSessionCalls: maximum(all, observation => observation.counters.productionStoreSessionCalls),
    maximumStatusObservations: maximum(all, observation => observation.counters.statusObservations),
  };
  const failures = [
    ...all.flatMap((observation, index) =>
      contextBriefCitationScaleObservationFailures(profile, budget, observation, index),
    ),
    ...observations.flatMap((observation, index) => memoryObservationFailures(profile, observation, index)),
    ...observations.flatMap((observation, index) =>
      contextBriefCitationScaleObservationFailures(profile, budget, observation.memoryWorkload, index).map(
        failure => `${failure} during the external RSS pass`,
      ),
    ),
    JSON.stringify(memoryOrdinals) === JSON.stringify(expectedMemoryOrdinals)
      ? ''
      : `${profile.id} memory ordinals are not the complete measured range`,
    new Set(memoryObservationIds).size === memoryObservationIds.length
      ? ''
      : `${profile.id} memory observation IDs are not unique`,
    descendantObservationCount >= minimumDescendantObservations
      ? ''
      : `${profile.id} observed workload descendants in ${descendantObservationCount}/${observations.length} memory observations; ${descendantCoverageRequirement}`,
    coldReadyGraphObservation.counters.effectiveEvidenceBatches === profile.citedRepositories
      ? ''
      : `${profile.id} cold ready-graph evidence batches ${coldReadyGraphObservation.counters.effectiveEvidenceBatches}; expected ${profile.citedRepositories}`,
    measurements.validationMilliseconds.p95 <= profile.maximumValidationP95Milliseconds
      ? ''
      : `${profile.id} validation p95 ${measurements.validationMilliseconds.p95.toFixed(1)}ms exceeds ${profile.maximumValidationP95Milliseconds}ms`,
    measurements.contextBriefMilliseconds.p95 <= profile.maximumBriefP95Milliseconds
      ? ''
      : `${profile.id} brief p95 ${measurements.contextBriefMilliseconds.p95.toFixed(1)}ms exceeds ${profile.maximumBriefP95Milliseconds}ms`,
    measurements.observedAddedProcessTreeRssBytes.maximum <= budget.maximumObservedAddedProcessTreeRssBytes
      ? ''
      : `${profile.id} observed added process-tree RSS ${measurements.observedAddedProcessTreeRssBytes.maximum} exceeds ${budget.maximumObservedAddedProcessTreeRssBytes}`,
  ].filter(Boolean);
  return {
    failures,
    result: {
      coldReadyGraphObservation,
      counters,
      measurements,
      memoryCoverage,
      observations,
      profile,
      samples: observations.length,
    },
  };
}

export function contextBriefCitationScaleGate(failures: readonly string[]): ContextBriefCitationScaleGateV1 {
  const stable = [...new Set(failures)].sort();
  return {failures: stable, passed: stable.length === 0};
}

/** Parse retained v2 JSON and independently rederive every evidenced profile aggregate and gate decision. */
export function parseContextBriefCitationScaleArtifactV2(
  value: unknown,
  budgetInput: ContextBriefCitationScaleBudgetV1 | unknown,
  candidate?: ContextBriefCitationScaleCandidateBinding,
): ContextBriefCitationScaleArtifactV2 {
  const budget = parseContextBriefCitationScaleBudgetV1(budgetInput);
  const artifact = record(value, 'scale artifact');
  exactKeys(artifact, [
    'createdAt',
    'environment',
    'evidenceClass',
    'execution',
    'fixture',
    'gate',
    'memoryObserver',
    'profiles',
    'samples',
    'suite',
    'version',
    'warmups',
  ]);
  if (artifact.version !== 2) invalid('artifact version must be 2');
  if (artifact.suite !== CONTEXT_BRIEF_CITATION_SCALE_ARTIFACT_SUITE) {
    invalid(`artifact suite must be ${CONTEXT_BRIEF_CITATION_SCALE_ARTIFACT_SUITE}`);
  }
  const createdAt = isoInstant(artifact.createdAt, 'artifact createdAt');
  const evidenceClass = parseEvidenceClass(artifact.evidenceClass);
  const environment = parseArtifactEnvironment(artifact.environment);
  const execution = parseArtifactExecution(artifact.execution);
  const fixture = parseArtifactFixture(artifact.fixture);
  const memoryObserver = parseArtifactMemoryObserver(artifact.memoryObserver);
  const samples = positiveInteger(artifact.samples, 'artifact samples');
  const warmups = nonNegativeSafeInteger(artifact.warmups, 'artifact warmups');
  if (evidenceClass === 'release-scale') {
    const reviewedFixture = contextBriefCitationScaleReviewedFixtureIdentity(budget, samples, warmups);
    if (reviewedFixture.hash !== CONTEXT_BRIEF_CITATION_SCALE_REVIEWED_FIXTURE_IDENTITY_HASH) {
      invalid('reviewed fixture identity does not match the approved contract');
    }
    if (fixture.indexedMemoryCandidates !== reviewedFixture.counts.indexedMemoryCandidates) {
      invalid('release artifact indexed memory candidates do not match the reviewed fixture');
    }
    if (fixture.requestedMemoryCandidates !== reviewedFixture.counts.requestedMemoryCandidates) {
      invalid('release artifact requested memory candidates do not match the reviewed fixture');
    }
    if (fixture.legacyV1MemoryCandidates !== reviewedFixture.counts.legacyV1MemoryCandidates) {
      invalid('release artifact legacy memory candidates do not match the reviewed fixture');
    }
  }
  if (!Array.isArray(artifact.profiles) || artifact.profiles.length === 0 || artifact.profiles.length > 3) {
    invalid('artifact profiles must contain between one and three profiles');
  }
  const evaluatedProfiles = artifact.profiles.map((profile, index) =>
    parseArtifactProfileResult(profile, budget, index),
  );
  assertUnique(
    evaluatedProfiles.map(evaluated => evaluated.result.profile.id),
    'artifact profile ids',
  );
  const profiles = evaluatedProfiles.map(evaluated => evaluated.result);
  for (const profile of profiles) {
    if (profile.samples !== samples) invalid(`${profile.profile.id} samples do not match artifact samples`);
  }
  validateMemoryObserverSummary(memoryObserver, profiles);
  const claimedGate = parseArtifactGate(artifact.gate);
  const failures = rederiveArtifactFailures({
    budget,
    candidate,
    environment,
    evidenceClass,
    execution,
    fixture,
    memoryObserver,
    profileFailures: evaluatedProfiles.flatMap(evaluated => evaluated.failures),
    profiles,
    samples,
    warmups,
  });
  const expectedGate = contextBriefCitationScaleGate(failures);
  if (!sameJson(claimedGate, expectedGate)) invalid('artifact gate does not match the retained evidence');
  return {
    createdAt,
    environment,
    evidenceClass,
    execution,
    fixture,
    gate: expectedGate,
    memoryObserver,
    profiles,
    samples,
    suite: CONTEXT_BRIEF_CITATION_SCALE_ARTIFACT_SUITE,
    version: 2,
    warmups,
  };
}

function parseEvidenceClass(value: unknown): ContextBriefCitationScaleEvidenceClass {
  if (value !== 'development-smoke' && value !== 'release-scale') {
    invalid('artifact evidenceClass must be development-smoke or release-scale');
  }
  return value;
}

function parseArtifactEnvironment(value: unknown): ContextBriefCitationScaleEnvironmentV2 {
  const environment = record(value, 'artifact environment');
  exactKeys(environment, [
    'architecture',
    'candidateCommit',
    'commit',
    'cpu',
    'dirty',
    'gitStatusObserved',
    'githubActions',
    'memoryBytes',
    'operatingSystem',
    'runnerArchitecture',
    'runnerClass',
    'runnerEnvironment',
    'runnerOperatingSystem',
    'runtime',
    'sourceVersion',
  ]);
  return {
    architecture: boundedString(environment.architecture, 'environment architecture'),
    candidateCommit: boundedString(environment.candidateCommit, 'environment candidate commit'),
    commit: boundedString(environment.commit, 'environment commit'),
    cpu: boundedString(environment.cpu, 'environment cpu'),
    dirty: booleanValue(environment.dirty, 'environment dirty'),
    gitStatusObserved: booleanValue(environment.gitStatusObserved, 'environment gitStatusObserved'),
    githubActions: booleanValue(environment.githubActions, 'environment githubActions'),
    memoryBytes: positiveInteger(environment.memoryBytes, 'environment memory bytes'),
    operatingSystem: boundedString(environment.operatingSystem, 'environment operating system'),
    runnerArchitecture: boundedString(environment.runnerArchitecture, 'environment runner architecture'),
    runnerClass: boundedString(environment.runnerClass, 'environment runner class'),
    runnerEnvironment: boundedString(environment.runnerEnvironment, 'environment runner environment'),
    runnerOperatingSystem: boundedString(environment.runnerOperatingSystem, 'environment runner operating system'),
    runtime: boundedString(environment.runtime, 'environment runtime'),
    sourceVersion: boundedString(environment.sourceVersion, 'environment source version'),
  };
}

function parseArtifactExecution(value: unknown): ContextBriefCitationScaleExecutionV2 {
  const execution = record(value, 'artifact execution');
  exactKeys(execution, ['builtArtifactSha256', ...Object.keys(CONTEXT_BRIEF_CITATION_SCALE_EXECUTION_V2)]);
  for (const [key, expected] of Object.entries(CONTEXT_BRIEF_CITATION_SCALE_EXECUTION_V2)) {
    if (execution[key] !== expected) invalid(`artifact execution ${key} does not match the reviewed path`);
  }
  return {
    builtArtifactSha256: stringValue(execution.builtArtifactSha256, 'built artifact digest', 256),
    ...CONTEXT_BRIEF_CITATION_SCALE_EXECUTION_V2,
  };
}

function parseArtifactFixture(value: unknown): ContextBriefCitationScaleFixtureV2 {
  const fixture = record(value, 'artifact fixture');
  exactKeys(fixture, [
    'hash',
    'indexedMemoryCandidates',
    'legacyV1MemoryCandidates',
    'readyGraphSetupMilliseconds',
    'recallIndexBuildMilliseconds',
    'requestedMemoryCandidates',
    'worksetGenerationDigests',
    'worksetRepositoryIdentities',
  ]);
  if (!Array.isArray(fixture.worksetGenerationDigests) || fixture.worksetGenerationDigests.length !== 2) {
    invalid('fixture workset generation digests must contain the 50- and 128-member generations');
  }
  if (
    !Array.isArray(fixture.worksetRepositoryIdentities) ||
    fixture.worksetRepositoryIdentities.length !== 2 ||
    fixture.worksetRepositoryIdentities[0] !== 50 ||
    fixture.worksetRepositoryIdentities[1] !== 128
  ) {
    invalid('fixture workset repository identities must be [50,128]');
  }
  return {
    hash: lowercaseHex(fixture.hash, 64, 'fixture hash'),
    indexedMemoryCandidates: positiveInteger(fixture.indexedMemoryCandidates, 'indexed memory candidates'),
    legacyV1MemoryCandidates: nonNegativeSafeInteger(fixture.legacyV1MemoryCandidates, 'legacy v1 memory candidates'),
    readyGraphSetupMilliseconds: nonNegativeFinite(
      fixture.readyGraphSetupMilliseconds,
      'ready graph setup milliseconds',
    ),
    recallIndexBuildMilliseconds: nonNegativeFinite(
      fixture.recallIndexBuildMilliseconds,
      'recall index build milliseconds',
    ),
    requestedMemoryCandidates: positiveInteger(fixture.requestedMemoryCandidates, 'requested memory candidates'),
    worksetGenerationDigests: [
      lowercaseHex(fixture.worksetGenerationDigests[0], 64, 'workset-50 generation digest'),
      lowercaseHex(fixture.worksetGenerationDigests[1], 64, 'workset-128 generation digest'),
    ],
    worksetRepositoryIdentities: [50, 128],
  };
}

function parseArtifactMemoryObserver(value: unknown): ContextBriefCitationScaleMemoryObserverV2 {
  const observer = record(value, 'artifact memory observer');
  exactKeys(observer, [
    'finalSample',
    'intervalMilliseconds',
    'maximumConsecutiveSampleGapBreaches',
    'maximumSampleGapMilliseconds',
    'observationCount',
    'observerExcluded',
    'processCountPeakObserved',
    'retainedRootRssGrowthBytes',
    'rootIdentityValidation',
    'rootStartIdentity',
    'sampleGapBreachCount',
    'sampleGapBreachRate',
    'sampleGapPolicy',
    'sampleAttempts',
    'sampleFailures',
    'scope',
    'samplingSchedule',
    'source',
    'successfulSamples',
    'version',
  ]);
  if (observer.version !== 2) invalid('memory observer version must be 2');
  if (observer.observerExcluded !== true) invalid('memory observer must exclude its own subtree');
  if (observer.scope !== 'recursive-process-tree') invalid('memory observer scope must be recursive-process-tree');
  if (observer.source !== 'darwin-ps' && observer.source !== 'linux-proc') {
    invalid('memory observer source is unsupported');
  }
  const rootIdentityValidation = parseRootIdentityValidation(observer.source, observer.rootIdentityValidation);
  const intervalMilliseconds = positiveInteger(observer.intervalMilliseconds, 'memory observer interval');
  if (intervalMilliseconds < 10 || intervalMilliseconds > 1_000) {
    invalid('memory observer interval must be between 10 and 1000 milliseconds');
  }
  const finalSample = parseMemoryObserverFinalSample(observer.finalSample);
  parseMemoryObserverSampleGapPolicy(observer.sampleGapPolicy);
  if (observer.samplingSchedule !== CONTEXT_BRIEF_CITATION_RSS_SAMPLING_SCHEDULE) {
    invalid('memory observer sampling schedule does not match the reviewed contract');
  }
  return {
    finalSample,
    intervalMilliseconds,
    maximumConsecutiveSampleGapBreaches: nonNegativeSafeInteger(
      observer.maximumConsecutiveSampleGapBreaches,
      'memory observer maximum consecutive sample-gap breaches',
    ),
    maximumSampleGapMilliseconds: nonNegativeSafeInteger(
      observer.maximumSampleGapMilliseconds,
      'memory observer maximum sample gap',
    ),
    observationCount: positiveInteger(observer.observationCount, 'memory observer observation count'),
    observerExcluded: true,
    processCountPeakObserved: positiveInteger(observer.processCountPeakObserved, 'memory observer peak process count'),
    retainedRootRssGrowthBytes: nonNegativeSafeInteger(
      observer.retainedRootRssGrowthBytes,
      'memory observer retained root RSS growth',
    ),
    rootIdentityValidation,
    rootStartIdentity: boundedString(observer.rootStartIdentity, 'memory observer root identity'),
    sampleGapBreachCount: nonNegativeSafeInteger(
      observer.sampleGapBreachCount,
      'memory observer sample-gap breach count',
    ),
    sampleGapBreachRate: boundedRate(observer.sampleGapBreachRate, 'memory observer sample-gap breach rate'),
    sampleGapPolicy: CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3,
    sampleAttempts: positiveInteger(observer.sampleAttempts, 'memory observer sample attempts'),
    sampleFailures: nonNegativeSafeInteger(observer.sampleFailures, 'memory observer sample failures'),
    scope: 'recursive-process-tree',
    samplingSchedule: CONTEXT_BRIEF_CITATION_RSS_SAMPLING_SCHEDULE,
    source: observer.source,
    successfulSamples: positiveInteger(observer.successfulSamples, 'memory observer successful samples'),
    version: 2,
  };
}

function parseMemoryObserverSampleGapPolicy(value: unknown): void {
  const policy = record(value, 'memory observer sample-gap policy');
  exactKeys(policy, [
    'breachThresholdMilliseconds',
    'hardMaximumGapMilliseconds',
    'maximumBreachRate',
    'maximumConsecutiveBreaches',
    'version',
  ]);
  if (
    policy.breachThresholdMilliseconds !==
      CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3.breachThresholdMilliseconds ||
    policy.hardMaximumGapMilliseconds !== CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3.hardMaximumGapMilliseconds ||
    policy.maximumBreachRate !== CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3.maximumBreachRate ||
    policy.maximumConsecutiveBreaches !== CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3.maximumConsecutiveBreaches ||
    policy.version !== CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3.version
  ) {
    invalid('memory observer sample-gap policy does not match the reviewed contract');
  }
}

function parseMemoryObserverFinalSample(value: unknown): ContextBriefCitationScaleMemoryObserverV2['finalSample'] {
  const sample = record(value, 'memory observer final sample');
  exactKeys(sample, ['processCount', 'rootRssBytes', 'sampleAttempts', 'sampleFailures', 'treeRssBytes']);
  const result = {
    processCount: positiveInteger(sample.processCount, 'memory observer final process count'),
    rootRssBytes: nonNegativeSafeInteger(sample.rootRssBytes, 'memory observer final root RSS'),
    sampleAttempts: positiveInteger(sample.sampleAttempts, 'memory observer final sample attempts'),
    sampleFailures: nonNegativeSafeInteger(sample.sampleFailures, 'memory observer final sample failures'),
    treeRssBytes: nonNegativeSafeInteger(sample.treeRssBytes, 'memory observer final tree RSS'),
  };
  if (result.rootRssBytes > result.treeRssBytes) invalid('memory observer final root RSS exceeds tree RSS');
  if (result.sampleFailures !== result.sampleAttempts - 1) {
    invalid('memory observer final sample accounting is inconsistent');
  }
  return result;
}

function parseArtifactGate(value: unknown): ContextBriefCitationScaleGateV1 {
  const gate = record(value, 'artifact gate');
  exactKeys(gate, ['failures', 'passed']);
  if (!Array.isArray(gate.failures) || gate.failures.length > 1_024) invalid('artifact gate failures are invalid');
  const failures = gate.failures.map((failure, index) => boundedString(failure, `gate failure ${index}`, 4_096));
  const stableFailures = [...new Set(failures)].sort();
  if (JSON.stringify(failures) !== JSON.stringify(stableFailures)) {
    invalid('artifact gate failures must be sorted and unique');
  }
  const passed = booleanValue(gate.passed, 'artifact gate passed');
  if (passed !== (failures.length === 0)) invalid('artifact gate passed value is inconsistent with its failures');
  return {failures, passed};
}

function parseArtifactProfileResult(
  value: unknown,
  budget: ContextBriefCitationScaleBudgetV1,
  profileIndex: number,
): {readonly failures: readonly string[]; readonly result: ContextBriefCitationScaleProfileResultV2} {
  const result = record(value, `artifact profile ${profileIndex}`);
  exactKeys(result, [
    'coldReadyGraphObservation',
    'counters',
    'measurements',
    'memoryCoverage',
    'observations',
    'profile',
    'samples',
  ]);
  const profile = parseProfile(result.profile);
  if (!Array.isArray(result.observations) || result.observations.length === 0 || result.observations.length > 256) {
    invalid(`${profile.id} observations must contain between one and 256 samples`);
  }
  const observations = result.observations.map((observation, index) =>
    parseMeasuredObservation(observation, profile.id, index),
  );
  const claimed: ContextBriefCitationScaleProfileResultV2 = {
    coldReadyGraphObservation: parseTimingObservation(
      result.coldReadyGraphObservation,
      `${profile.id} cold ready-graph observation`,
    ),
    counters: parseAggregateCounters(result.counters, profile.id),
    measurements: parseProfileMeasurements(result.measurements, profile.id),
    memoryCoverage: parseMemoryCoverage(result.memoryCoverage, profile.id),
    observations,
    profile,
    samples: positiveInteger(result.samples, `${profile.id} samples`),
  };
  const evaluated = evaluateContextBriefCitationScaleProfile(
    budget,
    profile.id,
    claimed.coldReadyGraphObservation,
    observations,
  );
  if (!sameJson(claimed, evaluated.result)) {
    invalid(`${profile.id} aggregates do not match its retained timing, memory workload, and RSS observations`);
  }
  return evaluated;
}

function parseAggregateCounters(
  value: unknown,
  profile: ContextBriefCitationScaleProfileId,
): ContextBriefCitationScaleProfileResultV2['counters'] {
  const counters = record(value, `${profile} aggregate counters`);
  exactKeys(counters, [
    'maximumActiveViewFenceObservations',
    'maximumDistinctGraphDatabasePaths',
    'maximumEffectiveEvidenceBatches',
    'maximumLeaseBalance',
    'maximumMaintenanceRequests',
    'maximumPeakLeaseBalance',
    'maximumProductionStoreSessionCalls',
    'maximumStatusObservations',
  ]);
  return {
    maximumActiveViewFenceObservations: nonNegativeSafeInteger(
      counters.maximumActiveViewFenceObservations,
      `${profile} maximum active-view fence observations`,
    ),
    maximumDistinctGraphDatabasePaths: nonNegativeSafeInteger(
      counters.maximumDistinctGraphDatabasePaths,
      `${profile} maximum distinct graph database paths`,
    ),
    maximumEffectiveEvidenceBatches: nonNegativeSafeInteger(
      counters.maximumEffectiveEvidenceBatches,
      `${profile} maximum effective evidence batches`,
    ),
    maximumLeaseBalance: nonNegativeSafeInteger(counters.maximumLeaseBalance, `${profile} maximum lease balance`),
    maximumMaintenanceRequests: nonNegativeSafeInteger(
      counters.maximumMaintenanceRequests,
      `${profile} maximum maintenance requests`,
    ),
    maximumPeakLeaseBalance: nonNegativeSafeInteger(
      counters.maximumPeakLeaseBalance,
      `${profile} maximum peak lease balance`,
    ),
    maximumProductionStoreSessionCalls: nonNegativeSafeInteger(
      counters.maximumProductionStoreSessionCalls,
      `${profile} maximum production store session calls`,
    ),
    maximumStatusObservations: nonNegativeSafeInteger(
      counters.maximumStatusObservations,
      `${profile} maximum status observations`,
    ),
  };
}

function parseProfileMeasurements(
  value: unknown,
  profile: ContextBriefCitationScaleProfileId,
): ContextBriefCitationScaleProfileResultV2['measurements'] {
  const measurements = record(value, `${profile} measurements`);
  exactKeys(measurements, [
    'boundaryAddedRssBytes',
    'contextBriefMilliseconds',
    'memoryRetrievalMilliseconds',
    'observedAddedProcessTreeRssBytes',
    'validationMilliseconds',
  ]);
  return {
    boundaryAddedRssBytes: parseBenchmarkMeasurement(measurements.boundaryAddedRssBytes, `${profile} boundary RSS`),
    contextBriefMilliseconds: parseBenchmarkMeasurement(
      measurements.contextBriefMilliseconds,
      `${profile} Context Brief latency`,
    ),
    memoryRetrievalMilliseconds: parseBenchmarkMeasurement(
      measurements.memoryRetrievalMilliseconds,
      `${profile} memory retrieval latency`,
    ),
    validationMilliseconds: parseBenchmarkMeasurement(
      measurements.validationMilliseconds,
      `${profile} validation latency`,
    ),
    observedAddedProcessTreeRssBytes: parseBenchmarkMeasurement(
      measurements.observedAddedProcessTreeRssBytes,
      `${profile} process-tree RSS`,
    ),
  };
}

function parseBenchmarkMeasurement(value: unknown, label: string): BenchmarkMeasurementV1 {
  const measurement = record(value, label);
  exactKeys(measurement, ['maximum', 'mean', 'minimum', 'name', 'p50', 'p95', 'p99', 'samples', 'unit']);
  const unit = measurement.unit;
  if (
    unit !== 'bytes' &&
    unit !== 'count' &&
    unit !== 'milliseconds' &&
    unit !== 'operations_per_second' &&
    unit !== 'percent'
  ) {
    invalid(`${label} unit is unsupported`);
  }
  const parsed = {
    maximum: nonNegativeFinite(measurement.maximum, `${label} maximum`),
    mean: nonNegativeFinite(measurement.mean, `${label} mean`),
    minimum: nonNegativeFinite(measurement.minimum, `${label} minimum`),
    name: boundedString(measurement.name, `${label} name`),
    p50: nonNegativeFinite(measurement.p50, `${label} p50`),
    p95: nonNegativeFinite(measurement.p95, `${label} p95`),
    p99: nonNegativeFinite(measurement.p99, `${label} p99`),
    samples: positiveInteger(measurement.samples, `${label} samples`),
    unit,
  } satisfies BenchmarkMeasurementV1;
  if (
    parsed.minimum > parsed.p50 ||
    parsed.p50 > parsed.p95 ||
    parsed.p95 > parsed.p99 ||
    parsed.p99 > parsed.maximum ||
    parsed.mean < parsed.minimum ||
    parsed.mean > parsed.maximum
  ) {
    invalid(`${label} summary is internally inconsistent`);
  }
  return parsed;
}

function parseMemoryCoverage(
  value: unknown,
  profile: ContextBriefCitationScaleProfileId,
): ContextBriefCitationScaleProfileResultV2['memoryCoverage'] {
  const coverage = record(value, `${profile} memory coverage`);
  exactKeys(coverage, [
    'descendantObservationCount',
    'descendantObservationRate',
    'maximumPeakProcessCount',
    'minimumSuccessfulSamples',
  ]);
  const descendantObservationRate = nonNegativeFinite(
    coverage.descendantObservationRate,
    `${profile} descendant observation rate`,
  );
  if (descendantObservationRate > 1) invalid(`${profile} descendant observation rate exceeds one`);
  return {
    descendantObservationCount: nonNegativeSafeInteger(
      coverage.descendantObservationCount,
      `${profile} descendant observation count`,
    ),
    descendantObservationRate,
    maximumPeakProcessCount: positiveInteger(coverage.maximumPeakProcessCount, `${profile} maximum peak process count`),
    minimumSuccessfulSamples: positiveInteger(
      coverage.minimumSuccessfulSamples,
      `${profile} minimum successful samples`,
    ),
  };
}

const OBSERVATION_KEYS = [
  'boundaryAddedRssBytes',
  'contextBriefMilliseconds',
  'counters',
  'estimatedTokens',
  'exactValidationReceipts',
  'memoryRetrievalMilliseconds',
  'profile',
  'selectedMemories',
  'validationMilliseconds',
  'validationReceipts',
] as const;

function parseMeasuredObservation(
  value: unknown,
  expectedProfile: ContextBriefCitationScaleProfileId,
  index: number,
): ContextBriefCitationScaleMeasuredObservationV2 {
  const observation = record(value, `${expectedProfile} measured observation ${index}`);
  exactKeys(observation, [...OBSERVATION_KEYS, 'memory', 'memoryWorkload']);
  const timing = parseTimingObservationRecord(observation, `${expectedProfile} measured observation ${index}`);
  const memory = parseMemoryObservation(observation.memory, expectedProfile, index);
  return {
    ...timing,
    memory,
    memoryWorkload: parseTimingObservation(
      observation.memoryWorkload,
      `${expectedProfile} memory workload observation ${index}`,
    ),
  };
}

function parseTimingObservation(value: unknown, label: string): ContextBriefCitationScaleObservationV2 {
  const observation = record(value, label);
  exactKeys(observation, OBSERVATION_KEYS);
  return parseTimingObservationRecord(observation, label);
}

function parseTimingObservationRecord(
  observation: Readonly<Record<string, unknown>>,
  label: string,
): ContextBriefCitationScaleObservationV2 {
  return {
    boundaryAddedRssBytes: nonNegativeSafeInteger(observation.boundaryAddedRssBytes, `${label} boundary RSS`),
    contextBriefMilliseconds: nonNegativeFinite(
      observation.contextBriefMilliseconds,
      `${label} Context Brief milliseconds`,
    ),
    counters: parseObservationCounters(observation.counters, label),
    estimatedTokens: nonNegativeSafeInteger(observation.estimatedTokens, `${label} estimated tokens`),
    exactValidationReceipts: nonNegativeSafeInteger(
      observation.exactValidationReceipts,
      `${label} exact validation receipts`,
    ),
    memoryRetrievalMilliseconds: nonNegativeFinite(
      observation.memoryRetrievalMilliseconds,
      `${label} memory retrieval milliseconds`,
    ),
    profile: parseProfileId(observation.profile, `${label} profile`),
    selectedMemories: nonNegativeSafeInteger(observation.selectedMemories, `${label} selected memories`),
    validationMilliseconds: nonNegativeFinite(observation.validationMilliseconds, `${label} validation milliseconds`),
    validationReceipts: nonNegativeSafeInteger(observation.validationReceipts, `${label} validation receipts`),
  };
}

function parseObservationCounters(value: unknown, label: string): ContextBriefCitationScaleCountersV1 {
  const counters = record(value, `${label} counters`);
  exactKeys(counters, [
    'activeViewFenceObservations',
    'coldGraphBuilds',
    'distinctGraphDatabasePaths',
    'effectiveEvidenceBatches',
    'leaseBalance',
    'maintenanceRequests',
    'peakLeaseBalance',
    'productionStoreSessionCalls',
    'snapshotLeaseAcquisitions',
    'snapshotLeaseReleases',
    'statusObservations',
  ]);
  return {
    activeViewFenceObservations: nonNegativeSafeInteger(
      counters.activeViewFenceObservations,
      `${label} active-view fence observations`,
    ),
    coldGraphBuilds: nonNegativeSafeInteger(counters.coldGraphBuilds, `${label} cold graph builds`),
    distinctGraphDatabasePaths: nonNegativeSafeInteger(
      counters.distinctGraphDatabasePaths,
      `${label} distinct graph database paths`,
    ),
    effectiveEvidenceBatches: nonNegativeSafeInteger(
      counters.effectiveEvidenceBatches,
      `${label} effective evidence batches`,
    ),
    leaseBalance: nonNegativeSafeInteger(counters.leaseBalance, `${label} lease balance`),
    maintenanceRequests: nonNegativeSafeInteger(counters.maintenanceRequests, `${label} maintenance requests`),
    peakLeaseBalance: nonNegativeSafeInteger(counters.peakLeaseBalance, `${label} peak lease balance`),
    productionStoreSessionCalls: nonNegativeSafeInteger(
      counters.productionStoreSessionCalls,
      `${label} production store session calls`,
    ),
    snapshotLeaseAcquisitions: nonNegativeSafeInteger(
      counters.snapshotLeaseAcquisitions,
      `${label} snapshot lease acquisitions`,
    ),
    snapshotLeaseReleases: nonNegativeSafeInteger(counters.snapshotLeaseReleases, `${label} snapshot lease releases`),
    statusObservations: nonNegativeSafeInteger(counters.statusObservations, `${label} status observations`),
  };
}

function parseMemoryObservation(
  value: unknown,
  expectedProfile: ContextBriefCitationScaleProfileId,
  index: number,
): ContextBriefCitationScaleMemoryObservationV2 {
  const memory = record(value, `${expectedProfile} memory observation ${index}`);
  exactKeys(memory, [
    'baselineProcessCount',
    'maximumSampleGapMilliseconds',
    'observedAddedProcessTreeRssBytes',
    'observedAddedRootRssBytes',
    'observedProcessTreeRssBaselineBytes',
    'observedProcessTreeRssPeakBytes',
    'observedRootRssBaselineBytes',
    'observedRootRssPeakBytes',
    'observationId',
    'ordinal',
    'peakProcessCount',
    'profile',
    'rootStartIdentity',
    'sampleAttempts',
    'sampleFailures',
    'sampleIntervalMilliseconds',
    'samples',
    'source',
  ]);
  if (memory.source !== 'darwin-ps' && memory.source !== 'linux-proc') {
    invalid(`${expectedProfile} memory observation ${index} source is unsupported`);
  }
  const observationId = boundedString(memory.observationId, `${expectedProfile} memory observation ${index} id`);
  const expectedId = `context-rss-${expectedProfile}-${index}`;
  if (observationId !== expectedId) invalid(`${expectedProfile} memory observation ${index} id must be ${expectedId}`);
  return {
    baselineProcessCount: positiveInteger(memory.baselineProcessCount, `${expectedProfile} baseline process count`),
    maximumSampleGapMilliseconds: nonNegativeSafeInteger(
      memory.maximumSampleGapMilliseconds,
      `${expectedProfile} maximum sample gap`,
    ),
    observedAddedProcessTreeRssBytes: nonNegativeSafeInteger(
      memory.observedAddedProcessTreeRssBytes,
      `${expectedProfile} added process-tree RSS`,
    ),
    observedAddedRootRssBytes: nonNegativeSafeInteger(
      memory.observedAddedRootRssBytes,
      `${expectedProfile} added root RSS`,
    ),
    observedProcessTreeRssBaselineBytes: nonNegativeSafeInteger(
      memory.observedProcessTreeRssBaselineBytes,
      `${expectedProfile} process-tree RSS baseline`,
    ),
    observedProcessTreeRssPeakBytes: nonNegativeSafeInteger(
      memory.observedProcessTreeRssPeakBytes,
      `${expectedProfile} process-tree RSS peak`,
    ),
    observedRootRssBaselineBytes: nonNegativeSafeInteger(
      memory.observedRootRssBaselineBytes,
      `${expectedProfile} root RSS baseline`,
    ),
    observedRootRssPeakBytes: nonNegativeSafeInteger(
      memory.observedRootRssPeakBytes,
      `${expectedProfile} root RSS peak`,
    ),
    observationId,
    ordinal: nonNegativeSafeInteger(memory.ordinal, `${expectedProfile} memory ordinal`),
    peakProcessCount: positiveInteger(memory.peakProcessCount, `${expectedProfile} peak process count`),
    profile: parseProfileId(memory.profile, `${expectedProfile} memory profile`),
    rootStartIdentity: boundedString(memory.rootStartIdentity, `${expectedProfile} root start identity`),
    sampleAttempts: positiveInteger(memory.sampleAttempts, `${expectedProfile} sample attempts`),
    sampleFailures: nonNegativeSafeInteger(memory.sampleFailures, `${expectedProfile} sample failures`),
    sampleIntervalMilliseconds: positiveInteger(
      memory.sampleIntervalMilliseconds,
      `${expectedProfile} sample interval`,
    ),
    samples: positiveInteger(memory.samples, `${expectedProfile} successful samples`),
    source: memory.source,
  };
}

function validateMemoryObserverSummary(
  observer: ContextBriefCitationScaleMemoryObserverV2,
  profiles: readonly ContextBriefCitationScaleProfileResultV2[],
): void {
  const observations = profiles.flatMap(profile => profile.observations.map(observation => observation.memory));
  if (observer.observationCount !== observations.length) {
    invalid('memory observer observation count does not match the retained profile observations');
  }
  const expectedSampleGapSummary = contextBriefCitationRssSampleGapSummary(
    observations.map(observation => observation.maximumSampleGapMilliseconds),
  );
  const expectedPeakProcessCount = Math.max(
    observer.finalSample.processCount,
    ...observations.map(observation => observation.peakProcessCount),
  );
  const expectedAttempts = safeSum(
    [...observations.map(observation => observation.sampleAttempts), observer.finalSample.sampleAttempts],
    'memory observer sample attempts',
  );
  const expectedFailures = safeSum(
    [...observations.map(observation => observation.sampleFailures), observer.finalSample.sampleFailures],
    'memory observer sample failures',
  );
  const expectedSuccessfulSamples = safeSum(
    [...observations.map(observation => observation.samples), 1],
    'memory observer successful samples',
  );
  const expectedRetainedGrowth = contextBriefCitationScaleRetainedRootRssGrowthBytes([
    ...observations.map(observation => observation.observedRootRssBaselineBytes),
    observer.finalSample.rootRssBytes,
  ]);
  for (const key of [
    'maximumConsecutiveSampleGapBreaches',
    'maximumSampleGapMilliseconds',
    'sampleGapBreachCount',
    'sampleGapBreachRate',
  ] as const) {
    if (observer[key] !== expectedSampleGapSummary[key]) {
      invalid(`memory observer ${key} does not match the retained observations`);
    }
  }
  if (observer.processCountPeakObserved !== expectedPeakProcessCount) {
    invalid('memory observer peak process count does not match the retained observations');
  }
  if (observer.sampleAttempts !== expectedAttempts) {
    invalid('memory observer sample attempts do not match the retained observations');
  }
  if (observer.sampleFailures !== expectedFailures) {
    invalid('memory observer sample failures do not match the retained observations');
  }
  if (observer.successfulSamples !== expectedSuccessfulSamples) {
    invalid('memory observer successful samples do not match the retained observations');
  }
  if (observer.retainedRootRssGrowthBytes !== expectedRetainedGrowth) {
    invalid('memory observer retained root RSS growth does not match the retained observations');
  }
  for (const observation of observations) {
    if (observation.sampleIntervalMilliseconds !== observer.intervalMilliseconds) {
      invalid('memory observer interval does not match a retained observation');
    }
    if (observation.source !== observer.source) {
      invalid('memory observer source does not match a retained observation');
    }
    if (observation.rootStartIdentity !== observer.rootStartIdentity) {
      invalid('memory observer root identity does not match a retained observation');
    }
  }
}

function rederiveArtifactFailures(input: {
  readonly budget: ContextBriefCitationScaleBudgetV1;
  readonly candidate?: ContextBriefCitationScaleCandidateBinding;
  readonly environment: ContextBriefCitationScaleEnvironmentV2;
  readonly evidenceClass: ContextBriefCitationScaleEvidenceClass;
  readonly execution: ContextBriefCitationScaleExecutionV2;
  readonly fixture: ContextBriefCitationScaleFixtureV2;
  readonly memoryObserver: ContextBriefCitationScaleMemoryObserverV2;
  readonly profileFailures: readonly string[];
  readonly profiles: readonly ContextBriefCitationScaleProfileResultV2[];
  readonly samples: number;
  readonly warmups: number;
}): readonly string[] {
  const failures = [
    input.evidenceClass === 'release-scale' ? '' : 'artifact is a development smoke, not release-scale evidence',
    input.memoryObserver.sampleFailures === 0
      ? ''
      : `external RSS observer recorded ${input.memoryObserver.sampleFailures} failed samples`,
    input.memoryObserver.finalSample.processCount === 1
      ? ''
      : `external RSS observer final retained-root sample contained ${input.memoryObserver.finalSample.processCount} processes; expected the benchmark root only`,
    input.memoryObserver.retainedRootRssGrowthBytes <= input.budget.maximumObservedAddedProcessTreeRssBytes
      ? ''
      : `retained root RSS growth ${input.memoryObserver.retainedRootRssGrowthBytes} exceeds ${input.budget.maximumObservedAddedProcessTreeRssBytes}`,
    ...contextBriefCitationRssSampleGapFailures(input.memoryObserver, input.memoryObserver.observationCount),
    ...input.profileFailures,
    sameJson(
      input.profiles.map(profile => profile.profile.id),
      input.budget.profiles.map(profile => profile.id),
    )
      ? ''
      : 'reviewed scale evidence must execute local-100k, workset-50, and workset-128 in order',
    input.fixture.indexedMemoryCandidates === input.budget.corpusMemoryCandidates
      ? ''
      : `indexed memory corpus ${input.fixture.indexedMemoryCandidates}; required ${input.budget.corpusMemoryCandidates}`,
    input.evidenceClass !== 'release-scale' ||
    (input.samples === CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES &&
      input.warmups === CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS)
      ? ''
      : `release evidence requires exactly ${CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES} samples and ${CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS} warmups; received ${input.samples}/${input.warmups}`,
    /^[0-9a-f]{64}$/u.test(input.execution.builtArtifactSha256)
      ? ''
      : 'benchmark execution artifact digest is missing or malformed',
  ];
  if (input.evidenceClass === 'release-scale') {
    failures.push(...contextBriefCitationScaleReleaseIdentityFailures(input.environment, input.candidate));
    if (
      input.memoryObserver.source !== 'darwin-ps' ||
      input.memoryObserver.rootIdentityValidation !== 'darwin-ps-lstart' ||
      input.memoryObserver.intervalMilliseconds !== 25 ||
      input.memoryObserver.samplingSchedule !== CONTEXT_BRIEF_CITATION_RSS_SAMPLING_SCHEDULE
    ) {
      failures.push(
        'release RSS evidence must use the reviewed observer-excluded Darwin 25ms absolute-deadline process-tree sampler',
      );
    }
  }
  return failures.filter(Boolean);
}

/** Measure retained root growth independently from each request's transient peak. */
export function contextBriefCitationScaleRetainedRootRssGrowthBytes(baselines: readonly number[]): number {
  if (baselines.length === 0) return 0;
  return Math.max(0, Math.max(...baselines) - baselines[0]);
}

/** Fail closed when hosted release evidence is relabeled or detached from its exact candidate. */
export function contextBriefCitationScaleReleaseIdentityFailures(
  identity: ContextBriefCitationScaleReleaseIdentityV1,
  candidate?: ContextBriefCitationScaleCandidateBinding,
): readonly string[] {
  // Omitting external review context preserves the immutable historical 4.6.0
  // artifact contract. New releases must supply a candidate-bound expectation.
  const expectedSourceVersion = candidate?.sourceVersion ?? CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SOURCE_VERSION;
  const expectedRuntime = candidate?.runtime ?? CONTEXT_BRIEF_CITATION_SCALE_RELEASE_RUNTIME;
  return [
    candidate === undefined || /^[0-9a-f]{40}$/u.test(candidate.commit)
      ? ''
      : 'candidate binding commit is not exact lowercase Git SHA-1',
    candidate === undefined ||
    (typeof candidate.sourceVersion === 'string' &&
      candidate.sourceVersion.startsWith('threadnote-') &&
      CANDIDATE_PACKAGE_VERSION.test(candidate.sourceVersion.slice('threadnote-'.length)))
      ? ''
      : 'candidate binding source version must name an explicit package version',
    candidate === undefined ||
    (typeof candidate.runtime === 'string' &&
      candidate.runtime.startsWith('bun/') &&
      CANDIDATE_PACKAGE_VERSION.test(candidate.runtime.slice('bun/'.length)))
      ? ''
      : 'candidate binding runtime must name an explicit Bun version',
    candidate === undefined || identity.candidateCommit === candidate.commit
      ? ''
      : `claimed candidate ${identity.candidateCommit}; required reviewed candidate ${candidate.commit}`,
    /^[0-9a-f]{40}$/u.test(identity.candidateCommit) ? '' : 'release candidate commit is not exact lowercase Git SHA-1',
    identity.commit === identity.candidateCommit
      ? ''
      : `observed commit ${identity.commit}; required candidate ${identity.candidateCommit}`,
    identity.dirty ? 'release candidate checkout is dirty' : '',
    identity.gitStatusObserved ? '' : 'release candidate Git status could not be observed',
    identity.githubActions ? '' : 'release evidence was not produced by GitHub Actions',
    identity.runnerClass === CONTEXT_BRIEF_CITATION_SCALE_RELEASE_RUNNER_CLASS
      ? ''
      : `runner class ${identity.runnerClass}; required ${CONTEXT_BRIEF_CITATION_SCALE_RELEASE_RUNNER_CLASS}`,
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
    identity.operatingSystem.startsWith('macOS ')
      ? ''
      : `runner operating system ${identity.operatingSystem}; required macOS`,
    identity.runtime === expectedRuntime ? '' : `runtime ${identity.runtime}; required ${expectedRuntime}`,
    identity.sourceVersion === expectedSourceVersion
      ? ''
      : `source version ${identity.sourceVersion}; required ${expectedSourceVersion}`,
  ].filter(Boolean);
}

function parseProfile(value: unknown): ContextBriefCitationScaleProfileV1 {
  const profile = record(value, 'scale profile');
  exactKeys(profile, [
    'citationCount',
    'citedRepositories',
    'id',
    'maximumBriefP95Milliseconds',
    'maximumValidationP95Milliseconds',
    'selectedMemories',
    'worksetMembers',
  ]);
  const id = parseProfileId(profile.id, 'profile id');
  const expected = EXACT_PROFILE_SHAPES[id];
  for (const key of ['citationCount', 'citedRepositories', 'selectedMemories', 'worksetMembers'] as const) {
    if (profile[key] !== expected[key]) invalid(`${id} ${key} does not match the reviewed shape`);
  }
  const maximumValidationP95Milliseconds = positiveInteger(profile.maximumValidationP95Milliseconds, 'validation p95');
  const maximumBriefP95Milliseconds = positiveInteger(profile.maximumBriefP95Milliseconds, 'brief p95');
  const maximum = id === 'local-100k' ? [250, 1_500] : id === 'workset-50' ? [950, 3_250] : [1_400, 5_000];
  if (maximumValidationP95Milliseconds !== maximum[0] || maximumBriefP95Milliseconds !== maximum[1]) {
    invalid(`${id} latency budget does not match the reviewed release target`);
  }
  return {...expected, id, maximumBriefP95Milliseconds, maximumValidationP95Milliseconds};
}

export function contextBriefCitationScaleObservationFailures(
  profile: ContextBriefCitationScaleProfileV1,
  budget: ContextBriefCitationScaleBudgetV1,
  observation: ContextBriefCitationScaleObservationV2,
  index: number,
): readonly string[] {
  const prefix = `${profile.id} observation ${index}`;
  const counters = observation.counters;
  const expectedStatusObservations = profile.citedRepositories * (profile.id === 'local-100k' ? 2 : 1);
  const expectedActiveViewFenceObservations = profile.id === 'local-100k' ? 0 : profile.citedRepositories * 2;
  return [
    observation.profile === profile.id ? '' : `${prefix} has wrong profile ${observation.profile}`,
    observation.selectedMemories === profile.selectedMemories
      ? ''
      : `${prefix} selected ${observation.selectedMemories}/${profile.selectedMemories} memories`,
    observation.validationReceipts === profile.citationCount
      ? ''
      : `${prefix} returned ${observation.validationReceipts}/${profile.citationCount} validation receipts`,
    observation.exactValidationReceipts === profile.citationCount
      ? ''
      : `${prefix} returned ${observation.exactValidationReceipts}/${profile.citationCount} exact validation receipts`,
    observation.estimatedTokens <= budget.maximumEstimatedTokens
      ? ''
      : `${prefix} emitted ${observation.estimatedTokens}/${budget.maximumEstimatedTokens} estimated tokens`,
    counters.productionStoreSessionCalls === profile.citedRepositories
      ? ''
      : `${prefix} opened ${counters.productionStoreSessionCalls} production graph-store sessions; expected ${profile.citedRepositories} (one per cited repository)`,
    counters.distinctGraphDatabasePaths === profile.citedRepositories
      ? ''
      : `${prefix} touched ${counters.distinctGraphDatabasePaths}/${profile.citedRepositories} cited graph databases`,
    counters.effectiveEvidenceBatches === profile.citedRepositories
      ? ''
      : `${prefix} issued ${counters.effectiveEvidenceBatches}/${profile.citedRepositories} repository evidence batches`,
    counters.statusObservations === expectedStatusObservations
      ? ''
      : `${prefix} made ${counters.statusObservations}/${expectedStatusObservations} snapshot status observations`,
    counters.activeViewFenceObservations === expectedActiveViewFenceObservations
      ? ''
      : `${prefix} made ${counters.activeViewFenceObservations}/${expectedActiveViewFenceObservations} active-view fence observations`,
    counters.snapshotLeaseAcquisitions === profile.citedRepositories &&
    counters.snapshotLeaseReleases === profile.citedRepositories &&
    counters.leaseBalance === 0
      ? ''
      : `${prefix} acquired/released ${counters.snapshotLeaseAcquisitions}/${counters.snapshotLeaseReleases} snapshot leases; expected ${profile.citedRepositories}/${profile.citedRepositories}`,
    counters.peakLeaseBalance <= 4 ? '' : `${prefix} exceeded validator concurrency 4`,
    counters.coldGraphBuilds === 0 ? '' : `${prefix} started cold graph indexing`,
    counters.maintenanceRequests === 0 ? '' : `${prefix} requested graph maintenance`,
  ].filter(Boolean);
}

function memoryObservationFailures(
  profile: ContextBriefCitationScaleProfileV1,
  observation: ContextBriefCitationScaleMeasuredObservationV2,
  index: number,
): readonly string[] {
  const prefix = `${profile.id} memory observation ${index}`;
  const memory = observation.memory;
  return [
    memory.profile === profile.id ? '' : `${prefix} has wrong profile ${memory.profile}`,
    memory.observationId.length > 0 ? '' : `${prefix} has no observation ID`,
    memory.rootStartIdentity.length > 0 ? '' : `${prefix} has no root start identity`,
    memory.sampleIntervalMilliseconds >= 10 ? '' : `${prefix} sampling interval is below 10ms`,
    memory.samples >= 3 ? '' : `${prefix} has fewer than three successful samples`,
    memory.sampleAttempts === memory.samples + memory.sampleFailures
      ? ''
      : `${prefix} sample accounting is inconsistent`,
    memory.sampleFailures === 0 ? '' : `${prefix} has ${memory.sampleFailures} failed samples`,
    memory.baselineProcessCount === 1
      ? ''
      : `${prefix} baseline process count ${memory.baselineProcessCount}; expected root only`,
    memory.observedRootRssBaselineBytes <= memory.observedProcessTreeRssBaselineBytes &&
    memory.observedRootRssPeakBytes <= memory.observedProcessTreeRssPeakBytes
      ? ''
      : `${prefix} root RSS exceeds process-tree RSS`,
    memory.observedRootRssPeakBytes >= memory.observedRootRssBaselineBytes &&
    memory.observedAddedRootRssBytes === memory.observedRootRssPeakBytes - memory.observedRootRssBaselineBytes
      ? ''
      : `${prefix} has inconsistent root RSS evidence`,
    memory.observedProcessTreeRssPeakBytes >= memory.observedProcessTreeRssBaselineBytes &&
    memory.observedAddedProcessTreeRssBytes ===
      memory.observedProcessTreeRssPeakBytes - memory.observedProcessTreeRssBaselineBytes
      ? ''
      : `${prefix} has inconsistent process-tree RSS evidence`,
  ].filter(Boolean);
}

function measurement(
  suffix: string,
  values: readonly number[],
  unit: BenchmarkMeasurementV1['unit'],
): BenchmarkMeasurementV1 {
  return benchmarkMeasurement(`context-brief-citations-scale-${suffix}`, unit, values);
}

function maximum(
  values: readonly ContextBriefCitationScaleObservationV2[],
  select: (value: ContextBriefCitationScaleObservationV2) => number,
): number {
  return Math.max(0, ...values.map(select));
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative integer`);
  }
  return value;
}

function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    invalid(`${label} must be a non-negative finite number`);
  }
  return value;
}

function boundedRate(value: unknown, label: string): number {
  const parsed = nonNegativeFinite(value, label);
  if (parsed > 1) invalid(`${label} must not exceed 1`);
  return parsed;
}

function safeSum(values: readonly number[], label: string): number {
  const result = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(result)) invalid(`${label} total exceeds the safe integer range`);
  return result;
}

function boundedString(value: unknown, label: string, maximumLength = 2_048): string {
  const parsed = stringValue(value, label, maximumLength);
  if (parsed.length === 0) invalid(`${label} must not be empty`);
  return parsed;
}

function stringValue(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length > maximumLength) {
    invalid(`${label} must be a string no longer than ${maximumLength} characters`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean`);
  return value;
}

function lowercaseHex(value: unknown, length: number, label: string): string {
  const parsed = stringValue(value, label, length);
  if (parsed.length !== length || !/^[0-9a-f]+$/u.test(parsed)) {
    invalid(`${label} must be exactly ${length} lowercase hexadecimal characters`);
  }
  return parsed;
}

function parseProfileId(value: unknown, label: string): ContextBriefCitationScaleProfileId {
  if (value === 'local-100k' || value === 'workset-50' || value === 'workset-128') return value;
  invalid(`${label} is unsupported`);
}

function parseRootIdentityValidation(
  source: unknown,
  value: unknown,
): ContextBriefCitationScaleMemoryObserverV2['rootIdentityValidation'] {
  if (source === 'darwin-ps' && value === 'darwin-ps-lstart') return value;
  if (source === 'linux-proc' && value === 'linux-proc-starttime') return value;
  invalid('memory observer source and root identity validation do not match');
}

function isoInstant(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64);
  const timestamp = Date.parse(parsed);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== parsed) {
    invalid(`${label} must be a canonical ISO instant`);
  }
  return parsed;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) invalid('contains unsupported or missing fields');
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

function invalid(detail: string): never {
  throw new Error(`Invalid Context Brief citation scale contract: ${detail}.`);
}
