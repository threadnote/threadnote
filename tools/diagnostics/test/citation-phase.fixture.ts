import {Array as EffectArray} from 'effect';
// Small deterministic synthetic parser fixture, matching the existing scale-contract test model.
// No benchmark, generated memory corpus or hosted capture is executed by this helper.
import {readFileSync} from '@threadnote/testing/node-fs';
import {
  CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3,
  CONTEXT_BRIEF_CITATION_RSS_SAMPLING_SCHEDULE,
  CONTEXT_BRIEF_CITATION_SCALE_ARTIFACT_SUITE,
  CONTEXT_BRIEF_CITATION_SCALE_EXECUTION_V2,
  CONTEXT_BRIEF_CITATION_SCALE_RELEASE_RUNNER_CLASS,
  CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES,
  CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS,
  contextBriefCitationScaleGate,
  evaluateContextBriefCitationScaleProfile,
  parseContextBriefCitationScaleBudgetV1,
  type ContextBriefCitationScaleArtifactV2,
  type ContextBriefCitationScaleCountersV1,
  type ContextBriefCitationScaleMeasuredObservationV2,
  type ContextBriefCitationScaleMemoryObservationV2,
  type ContextBriefCitationScaleObservationV2,
  type ContextBriefCitationScaleProfileV1,
} from '@threadnote/threadnote/evaluation/context-brief-citation-scale-contract';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const budget = parseContextBriefCitationScaleBudgetV1(
  JSON.parse(
    readFileSync('apps/threadnote/test/evaluation/baselines/context-brief-citations-v1/scale-budgets.json', 'utf8'),
  ),
);
function scaleArtifact(): ContextBriefCitationScaleArtifactV2 {
  const profiles = EffectArray.map(budget.profiles, profile => {
    const observation = scaleObservation(profile, {}, {}, {observationId: `context-rss-${profile.id}-0`});
    return evaluateContextBriefCitationScaleProfile(budget, profile.id, observation.memoryWorkload, [observation])
      .result;
  });
  return {
    createdAt: '2026-08-29T00:00:00.000Z',
    environment: {
      architecture: 'arm64',
      candidateCommit: 'unclaimed',
      commit: Effect.pipe('a', EffectString.repeat(40)),
      cpu: 'Apple M1 Max',
      dirty: true,
      gitStatusObserved: true,
      githubActions: false,
      memoryBytes: 64 * 1_024 * 1_024 * 1_024,
      operatingSystem: 'macOS 27.0',
      runnerArchitecture: 'arm64',
      runnerClass: 'local-unpinned',
      runnerEnvironment: 'local',
      runnerOperatingSystem: 'darwin',
      runtime: 'bun/1.3.14',
      sourceVersion: 'threadnote-4.6.0',
    },
    evidenceClass: 'development-smoke',
    execution: {
      builtArtifactSha256: Effect.pipe('b', EffectString.repeat(64)),
      ...CONTEXT_BRIEF_CITATION_SCALE_EXECUTION_V2,
    },
    fixture: {
      hash: Effect.pipe('c', EffectString.repeat(64)),
      indexedMemoryCandidates: 200,
      legacyV1MemoryCandidates: 128,
      readyGraphSetupMilliseconds: 1,
      recallIndexBuildMilliseconds: 1,
      requestedMemoryCandidates: 200,
      worksetGenerationDigests: [Effect.pipe('d', EffectString.repeat(64)), Effect.pipe('e', EffectString.repeat(64))],
      worksetRepositoryIdentities: [50, 128],
    },
    gate: contextBriefCitationScaleGate([
      'artifact is a development smoke, not release-scale evidence',
      'indexed memory corpus 200; required 100000',
    ]),
    memoryObserver: {
      finalSample: {
        processCount: 1,
        rootRssBytes: 512 * 1_024 * 1_024,
        sampleAttempts: 1,
        sampleFailures: 0,
        treeRssBytes: 512 * 1_024 * 1_024,
      },
      intervalMilliseconds: 25,
      maximumConsecutiveSampleGapBreaches: 0,
      maximumSampleGapMilliseconds: 25,
      observationCount: 3,
      observerExcluded: true,
      processCountPeakObserved: 2,
      retainedRootRssGrowthBytes: 0,
      rootIdentityValidation: 'darwin-ps-lstart',
      rootStartIdentity: 'root-start',
      sampleGapBreachCount: 0,
      sampleGapBreachRate: 0,
      sampleGapPolicy: CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3,
      sampleAttempts: 10,
      sampleFailures: 0,
      scope: 'recursive-process-tree',
      samplingSchedule: CONTEXT_BRIEF_CITATION_RSS_SAMPLING_SCHEDULE,
      source: 'darwin-ps',
      successfulSamples: 10,
      version: 2,
    },
    profiles,
    samples: 1,
    suite: CONTEXT_BRIEF_CITATION_SCALE_ARTIFACT_SUITE,
    version: 2,
    warmups: 0,
  };
}

export function releaseScaleArtifact(
  sourceVersion: string,
  runtime = 'bun/1.3.14',
): ContextBriefCitationScaleArtifactV2 {
  const base = scaleArtifact();
  const profiles = EffectArray.map(budget.profiles, profile => {
    const observations = Array.from({length: CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES}, (_, ordinal) =>
      scaleObservation(profile, {}, {}, {observationId: `context-rss-${profile.id}-${ordinal}`, ordinal}),
    );
    return evaluateContextBriefCitationScaleProfile(budget, profile.id, observations[0].memoryWorkload, observations)
      .result;
  });
  const observationCount = profiles.length * CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES;
  return {
    ...base,
    environment: {
      ...base.environment,
      candidateCommit: Effect.pipe('a', EffectString.repeat(40)),
      dirty: false,
      githubActions: true,
      runnerArchitecture: 'ARM64',
      runnerClass: CONTEXT_BRIEF_CITATION_SCALE_RELEASE_RUNNER_CLASS,
      runnerEnvironment: 'github-hosted',
      runnerOperatingSystem: 'macOS',
      runtime,
      sourceVersion,
    },
    evidenceClass: 'release-scale',
    fixture: {
      ...base.fixture,
      indexedMemoryCandidates: 100_000,
      legacyV1MemoryCandidates: 86_880,
      requestedMemoryCandidates: 100_000,
    },
    gate: {passed: true, failures: []},
    memoryObserver: {
      ...base.memoryObserver,
      observationCount,
      sampleAttempts: observationCount * 3 + 1,
      successfulSamples: observationCount * 3 + 1,
    },
    profiles,
    samples: CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES,
    warmups: CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS,
  };
}

function scaleObservation(
  profile: ContextBriefCitationScaleProfileV1,
  counters: Partial<ContextBriefCitationScaleCountersV1> = {},
  values: Partial<ContextBriefCitationScaleObservationV2> = {},
  memoryValues: Partial<ContextBriefCitationScaleMemoryObservationV2> = {},
): ContextBriefCitationScaleMeasuredObservationV2 {
  const observedRootRssBaselineBytes = memoryValues.observedRootRssBaselineBytes ?? 512 * 1_024 * 1_024;
  const observedAddedRootRssBytes = memoryValues.observedAddedRootRssBytes ?? 1_024;
  const observedProcessTreeRssBaselineBytes =
    memoryValues.observedProcessTreeRssBaselineBytes ?? observedRootRssBaselineBytes + 1_024;
  const observedAddedProcessTreeRssBytes = memoryValues.observedAddedProcessTreeRssBytes ?? 2_048;
  const timing: ContextBriefCitationScaleObservationV2 = {
    boundaryAddedRssBytes: 1_024,
    contextBriefMilliseconds: 10,
    counters: {
      activeViewFenceObservations: profile.id === 'local-100k' ? 0 : profile.citedRepositories * 2,
      coldGraphBuilds: 0,
      distinctGraphDatabasePaths: profile.citedRepositories,
      effectiveEvidenceBatches: profile.citedRepositories,
      leaseBalance: 0,
      maintenanceRequests: 0,
      peakLeaseBalance: Math.min(4, profile.citedRepositories),
      productionStoreSessionCalls: profile.citedRepositories,
      snapshotLeaseAcquisitions: profile.citedRepositories,
      snapshotLeaseReleases: profile.citedRepositories,
      statusObservations: profile.citedRepositories * (profile.id === 'local-100k' ? 2 : 1),
      ...counters,
    },
    estimatedTokens: 1_000,
    exactValidationReceipts: profile.citationCount,
    memoryRetrievalMilliseconds: 5,
    profile: profile.id,
    selectedMemories: profile.selectedMemories,
    validationMilliseconds: 4,
    validationReceipts: profile.citationCount,
    ...values,
  };
  return {
    ...timing,
    memory: {
      baselineProcessCount: 1,
      maximumSampleGapMilliseconds: 25,
      observedAddedProcessTreeRssBytes,
      observedAddedRootRssBytes,
      observedProcessTreeRssBaselineBytes,
      observedProcessTreeRssPeakBytes: observedProcessTreeRssBaselineBytes + observedAddedProcessTreeRssBytes,
      observedRootRssBaselineBytes,
      observedRootRssPeakBytes: observedRootRssBaselineBytes + observedAddedRootRssBytes,
      observationId: `${profile.id}-0`,
      ordinal: 0,
      peakProcessCount: 2,
      profile: profile.id,
      rootStartIdentity: 'root-start',
      sampleAttempts: 3,
      sampleFailures: 0,
      sampleIntervalMilliseconds: 25,
      samples: 3,
      source: 'darwin-ps',
      ...memoryValues,
    },
    memoryWorkload: timing,
  };
}
