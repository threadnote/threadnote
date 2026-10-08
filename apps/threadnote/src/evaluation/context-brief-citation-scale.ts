import {Clock, Context, DateTime, Effect, FileSystem, Scope} from 'effect';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {CodeGraphStoreShape} from '@threadnote/graph/store/shape';
import {SystemInfo} from '@threadnote/platform/system';
import {compileContextBriefWith} from '@threadnote/context/compiler';
import {
  projectContextBrief,
  retrieveContextBriefMemoryEvidence,
  validateContextBriefMemoryCitations,
  type ContextBriefGraphEvidenceV1,
  type ContextBriefScopeV1,
} from '../context_brief/index.js';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {
  CONTEXT_BRIEF_CITATION_RSS_SAMPLE_GAP_POLICY_V3,
  CONTEXT_BRIEF_CITATION_RSS_SAMPLING_SCHEDULE,
  CONTEXT_BRIEF_CITATION_SCALE_EXECUTION_V2,
  CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES,
  CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS,
  contextBriefCitationRssSampleGapFailures,
  contextBriefCitationScaleGate,
  contextBriefCitationScaleRetainedRootRssGrowthBytes,
  contextBriefCitationScaleReleaseIdentityFailures,
  evaluateContextBriefCitationScaleProfile,
  type ContextBriefCitationScaleBudgetV1,
  type ContextBriefCitationScaleCandidateBinding,
  type ContextBriefCitationScaleCountersV1,
  type ContextBriefCitationScaleMeasuredObservationV2,
  type ContextBriefCitationScaleMemoryObservationV2,
  type ContextBriefCitationScaleObservationV2,
  type ContextBriefCitationScaleProfileId,
} from './context-brief-citation-scale-contract.js';
import {
  contextBriefCitationScaleProject,
  prepareContextBriefCitationScaleFixture,
  type ContextBriefCitationScalePreparedFixture,
  type ContextBriefCitationScalePreparedProfile,
} from './context-brief-citation-scale-fixture.js';

export interface ContextBriefCitationScaleRunOptions {
  readonly budget: ContextBriefCitationScaleBudgetV1;
  readonly builtArtifactSha256: string;
  readonly invocationMode: 'development-smoke' | 'release-scale';
  readonly memoryCandidates: number;
  readonly profileIds: readonly ContextBriefCitationScaleProfileId[];
  readonly releaseCandidateCommit?: string;
  readonly releaseCandidateBinding?: ContextBriefCitationScaleCandidateBinding;
  readonly startRssObserver: Effect.Effect<
    ContextBriefCitationScaleRssObserver,
    Error,
    FileSystem.FileSystem | Scope.Scope | SystemInfo
  >;
  readonly samples: number;
  readonly warmups: number;
}

export interface ContextBriefCitationScaleRssObservation {
  readonly maximumSampleGapMilliseconds: number;
  readonly observationId: string;
  readonly processCountBaseline: number;
  readonly processCountPeakObserved: number;
  readonly rootRssBaselineBytes: number;
  readonly rootRssGrowthObservedBytes: number;
  readonly rootRssPeakObservedBytes: number;
  readonly sampleAttempts: number;
  readonly sampleFailures: number;
  readonly successfulSamples: number;
  readonly treeRssBaselineBytes: number;
  readonly treeRssGrowthObservedBytes: number;
  readonly treeRssPeakObservedBytes: number;
}

export interface ContextBriefCitationScaleRssArtifact {
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
  readonly observations: readonly ContextBriefCitationScaleRssObservation[];
  readonly observerExcluded: true;
  readonly processCountPeakObserved: number;
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

export interface ContextBriefCitationScaleRssObserver {
  readonly close: Effect.Effect<void, Error>;
  readonly finish: Effect.Effect<ContextBriefCitationScaleRssArtifact, Error>;
  readonly observe: <A, E, R>(observationId: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Error, R>;
}

export interface ContextBriefCitationScaleArtifactV2 {
  readonly createdAt: string;
  readonly evidenceClass: 'development-smoke' | 'release-scale';
  readonly environment: {
    readonly architecture: string;
    readonly candidateCommit: string;
    readonly commit: string;
    readonly cpu: string;
    readonly dirty: boolean;
    readonly gitStatusObserved: boolean;
    readonly githubActions: boolean;
    readonly memoryBytes: number;
    readonly operatingSystem: string;
    readonly runnerClass: string;
    readonly runnerArchitecture: string;
    readonly runnerEnvironment: string;
    readonly runnerOperatingSystem: string;
    readonly runtime: string;
    readonly sourceVersion: string;
  };
  readonly execution: {
    readonly builtArtifactSha256: string;
    readonly citationReceiptCache: 'cold-per-sample';
    readonly coldGraphBuilds: 0;
    readonly graphDatabaseSessionCounter: string;
    readonly graphSnapshots: 'real-sqlite-prebuilt-ready';
    readonly memoryMeasurement: string;
    readonly recallIndex: 'real-sqlite-prebuilt-before-timing';
    readonly timingScope: string;
  };
  readonly fixture: {
    readonly hash: string;
    readonly indexedMemoryCandidates: number;
    readonly legacyV1MemoryCandidates: number;
    readonly readyGraphSetupMilliseconds: number;
    readonly recallIndexBuildMilliseconds: number;
    readonly requestedMemoryCandidates: number;
    readonly worksetGenerationDigests: readonly [string, string];
    readonly worksetRepositoryIdentities: readonly [50, 128];
  };
  readonly gate: {readonly failures: readonly string[]; readonly passed: boolean};
  readonly memoryObserver: Omit<ContextBriefCitationScaleRssArtifact, 'observations'> & {
    readonly observationCount: number;
    readonly retainedRootRssGrowthBytes: number;
  };
  readonly profiles: readonly ReturnType<typeof evaluateContextBriefCitationScaleProfile>['result'][];
  readonly samples: number;
  readonly suite: 'context-brief-citations-scale-v2';
  readonly version: 2;
  readonly warmups: number;
}

/** Run production recall, validator, compiler, and projector paths from a bundled benchmark target. */
export const evaluateContextBriefCitationScale = Effect.fn('evaluation.contextBriefCitationScale')(function* (
  options: ContextBriefCitationScaleRunOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const graph = yield* ContextBriefCitationScaleGraphInstrumentation;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-context-brief-citation-scale-'});
  const fixture = yield* prepareContextBriefCitationScaleFixture(root, {
    budget: options.budget,
    memoryCandidates: options.memoryCandidates,
    profileIds: options.profileIds,
    runCount: options.warmups + options.samples * 2,
    samples: options.samples,
    warmups: options.warmups,
  });
  const failures: string[] = [];
  if (options.invocationMode !== 'release-scale') {
    failures.push('artifact is a development smoke, not release-scale evidence');
  }
  const memoryWorkloads = new Map<string, ContextBriefCitationScaleObservationV2>();
  const rssEvidence = yield* Effect.acquireUseRelease(
    options.startRssObserver,
    observer =>
      Effect.gen(function* () {
        for (const profileId of options.profileIds) {
          for (let index = 0; index < options.samples; index += 1) {
            const observationId = rssObservationId(profileId, index);
            prepareContextBriefCitationScaleObservation(graph);
            const memoryRun = yield* observer.observe(
              observationId,
              runObservation(fixture, graph, profileId, index, {
                captureBoundaryRss: true,
                prepare: false,
              }),
            );
            memoryWorkloads.set(observationId, memoryRun);
          }
        }
        prepareContextBriefCitationScaleObservation(graph);
        return yield* observer.finish;
      }),
    observer => observer.close,
  );
  const timingProfiles = new Map<
    ContextBriefCitationScaleProfileId,
    {
      readonly cold: ContextBriefCitationScaleObservationV2;
      readonly observations: readonly ContextBriefCitationScaleObservationV2[];
    }
  >();
  for (const profileId of options.profileIds) {
    const cold = memoryWorkloads.get(rssObservationId(profileId, 0))!;
    for (let index = 0; index < options.warmups; index += 1) {
      yield* runObservation(fixture, graph, profileId, options.samples + index, {
        captureBoundaryRss: false,
        prepare: true,
      });
    }
    const observations: ContextBriefCitationScaleObservationV2[] = [];
    for (let index = 0; index < options.samples; index += 1) {
      observations.push(
        yield* runObservation(fixture, graph, profileId, options.samples + options.warmups + index, {
          captureBoundaryRss: false,
          prepare: true,
        }),
      );
      yield* Effect.yieldNow;
    }
    timingProfiles.set(profileId, {cold, observations});
  }
  const rssById = new Map(rssEvidence.observations.map(observation => [observation.observationId, observation]));
  const expectedRssIds = options.profileIds.flatMap(profileId =>
    Array.from({length: options.samples}, (_, index) => rssObservationId(profileId, index)),
  );
  if (
    rssEvidence.observations.length !== expectedRssIds.length ||
    expectedRssIds.some(id => !rssById.has(id)) ||
    rssEvidence.observations.some(observation => !expectedRssIds.includes(observation.observationId))
  ) {
    failures.push('external RSS observations do not match the complete profile/sample schedule');
  }
  if (rssEvidence.sampleFailures !== 0) {
    failures.push(`external RSS observer recorded ${rssEvidence.sampleFailures} failed samples`);
  }
  failures.push(...contextBriefCitationRssSampleGapFailures(rssEvidence, rssEvidence.observations.length));
  if (rssEvidence.finalSample.processCount !== 1) {
    failures.push(
      `external RSS observer final retained-root sample contained ${rssEvidence.finalSample.processCount} processes; expected the benchmark root only`,
    );
  }
  const retainedRootRssGrowthBytes = contextBriefCitationScaleRetainedRootRssGrowthBytes([
    ...rssEvidence.observations.map(observation => observation.rootRssBaselineBytes),
    rssEvidence.finalSample.rootRssBytes,
  ]);
  if (retainedRootRssGrowthBytes > options.budget.maximumObservedAddedProcessTreeRssBytes) {
    failures.push(
      `retained root RSS growth ${retainedRootRssGrowthBytes} exceeds ${options.budget.maximumObservedAddedProcessTreeRssBytes}`,
    );
  }
  const profileResults: ContextBriefCitationScaleArtifactV2['profiles'][number][] = [];
  for (const profileId of options.profileIds) {
    const timing = timingProfiles.get(profileId)!;
    const observations = timing.observations.map((observation, index) => {
      const observationId = rssObservationId(profileId, index);
      return {
        ...observation,
        memory: normalizeRssObservation(rssEvidence, rssById.get(observationId), profileId, index),
        memoryWorkload: memoryWorkloads.get(observationId)!,
      };
    }) satisfies readonly ContextBriefCitationScaleMeasuredObservationV2[];
    const evaluated = evaluateContextBriefCitationScaleProfile(options.budget, profileId, timing.cold, observations);
    profileResults.push(evaluated.result);
    failures.push(...evaluated.failures);
  }
  const reviewedProfiles = options.budget.profiles.map(profile => profile.id);
  if (JSON.stringify(options.profileIds) !== JSON.stringify(reviewedProfiles)) {
    failures.push('reviewed scale evidence must execute local-100k, workset-50, and workset-128 in order');
  }
  if (fixture.indexedMemoryCandidates !== options.budget.corpusMemoryCandidates) {
    failures.push(
      `indexed memory corpus ${fixture.indexedMemoryCandidates}; required ${options.budget.corpusMemoryCandidates}`,
    );
  }
  if (
    options.invocationMode === 'release-scale' &&
    (options.samples !== CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES ||
      options.warmups !== CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS)
  ) {
    failures.push(
      `release evidence requires exactly ${CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES} samples and ${CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS} warmups; received ${options.samples}/${options.warmups}`,
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(options.builtArtifactSha256)) {
    failures.push('benchmark execution artifact digest is missing or malformed');
  }
  const [hardware, sourceVersion] = yield* Effect.all([system.hardwareInfo, getThreadnoteVersion()]);
  const commitObservation = gitObservation(['rev-parse', 'HEAD']);
  const statusObservation = gitObservation(['status', '--porcelain']);
  const commit = commitObservation.success ? commitObservation.text || 'unknown' : 'unknown';
  const dirty = !statusObservation.success || statusObservation.text.length > 0;
  const runtimeEnvironment = system.environment();
  const environment = {
    architecture: system.architecture,
    candidateCommit: options.releaseCandidateCommit ?? 'unclaimed',
    commit,
    cpu: hardware.cpuModel,
    dirty,
    gitStatusObserved: statusObservation.success,
    githubActions: runtimeEnvironment.GITHUB_ACTIONS === 'true',
    memoryBytes: hardware.memoryBytes,
    operatingSystem: hardware.operatingSystem,
    runnerClass: runtimeEnvironment.THREADNOTE_BENCHMARK_RUNNER_CLASS ?? 'local-unpinned',
    runnerArchitecture: runtimeEnvironment.RUNNER_ARCH ?? system.architecture,
    runnerEnvironment: runtimeEnvironment.RUNNER_ENVIRONMENT ?? 'local',
    runnerOperatingSystem: runtimeEnvironment.RUNNER_OS ?? system.platform,
    runtime: `bun/${system.runtimeVersion}`,
    sourceVersion: `threadnote-${sourceVersion}`,
  };
  if (options.invocationMode === 'release-scale') {
    failures.push(
      ...contextBriefCitationScaleReleaseIdentityFailures(
        {...environment, candidateCommit: options.releaseCandidateCommit ?? ''},
        options.releaseCandidateBinding,
      ),
    );
    if (
      rssEvidence.source !== 'darwin-ps' ||
      rssEvidence.rootIdentityValidation !== 'darwin-ps-lstart' ||
      rssEvidence.intervalMilliseconds !== 25 ||
      rssEvidence.samplingSchedule !== CONTEXT_BRIEF_CITATION_RSS_SAMPLING_SCHEDULE
    ) {
      failures.push(
        'release RSS evidence must use the reviewed observer-excluded Darwin 25ms absolute-deadline process-tree sampler',
      );
    }
  }
  return {
    createdAt: DateTime.formatIso(yield* DateTime.now),
    evidenceClass: options.invocationMode,
    environment,
    execution: {
      builtArtifactSha256: options.builtArtifactSha256,
      ...CONTEXT_BRIEF_CITATION_SCALE_EXECUTION_V2,
    },
    fixture: {
      hash: fixture.fixtureHash,
      indexedMemoryCandidates: fixture.indexedMemoryCandidates,
      legacyV1MemoryCandidates: fixture.legacyV1MemoryCandidates,
      readyGraphSetupMilliseconds: fixture.readyGraphSetupMilliseconds,
      recallIndexBuildMilliseconds: fixture.recallIndexBuildMilliseconds,
      requestedMemoryCandidates: options.memoryCandidates,
      worksetGenerationDigests: [
        fixture.profiles.get('workset-50')!.generation!.digest,
        fixture.profiles.get('workset-128')!.generation!.digest,
      ],
      worksetRepositoryIdentities: [50, 128],
    },
    gate: contextBriefCitationScaleGate(failures),
    memoryObserver: {
      finalSample: rssEvidence.finalSample,
      intervalMilliseconds: rssEvidence.intervalMilliseconds,
      maximumConsecutiveSampleGapBreaches: rssEvidence.maximumConsecutiveSampleGapBreaches,
      maximumSampleGapMilliseconds: rssEvidence.maximumSampleGapMilliseconds,
      observationCount: rssEvidence.observations.length,
      observerExcluded: rssEvidence.observerExcluded,
      processCountPeakObserved: rssEvidence.processCountPeakObserved,
      rootIdentityValidation: rssEvidence.rootIdentityValidation,
      rootStartIdentity: rssEvidence.rootStartIdentity,
      retainedRootRssGrowthBytes,
      sampleGapBreachCount: rssEvidence.sampleGapBreachCount,
      sampleGapBreachRate: rssEvidence.sampleGapBreachRate,
      sampleGapPolicy: rssEvidence.sampleGapPolicy,
      sampleAttempts: rssEvidence.sampleAttempts,
      sampleFailures: rssEvidence.sampleFailures,
      scope: rssEvidence.scope,
      samplingSchedule: rssEvidence.samplingSchedule,
      source: rssEvidence.source,
      successfulSamples: rssEvidence.successfulSamples,
      version: rssEvidence.version,
    },
    profiles: profileResults,
    samples: options.samples,
    suite: 'context-brief-citations-scale-v2',
    version: 2,
    warmups: options.warmups,
  } satisfies ContextBriefCitationScaleArtifactV2;
});

const runObservation = Effect.fn('evaluation.contextBriefCitationScaleObservation')(function* (
  fixture: ContextBriefCitationScalePreparedFixture,
  graph: ContextBriefCitationScaleGraphInstrumentationShape,
  profileId: ContextBriefCitationScaleProfileId,
  ordinal: number,
  options: {readonly captureBoundaryRss: boolean; readonly prepare: boolean},
) {
  const system = yield* SystemInfo;
  const prepared = fixture.profiles.get(profileId)!;
  const token = fixture.runToken(profileId, ordinal);
  if (options.prepare) prepareContextBriefCitationScaleObservation(graph);
  const rssBefore = options.captureBoundaryRss ? system.memoryUsage().rss : 0;
  let boundaryPeakRss = rssBefore;
  let memoryRetrievalMilliseconds = 0;
  let validationMilliseconds = 0;
  let selectedMemories = 0;
  let validationReceipts = 0;
  let exactValidationReceipts = 0;
  const observeRss = () => {
    if (!options.captureBoundaryRss) return;
    boundaryPeakRss = Math.max(boundaryPeakRss, system.memoryUsage().rss);
  };
  const started = yield* Clock.currentTimeNanos;
  const brief = yield* compileContextBriefWith(
    {
      citationValidation: (scope, candidates, fence) =>
        Effect.gen(function* () {
          const phaseStarted = yield* Clock.currentTimeNanos;
          const validations = yield* validateContextBriefMemoryCitations(fixture.config, scope, candidates, fence);
          const phaseFinished = yield* Clock.currentTimeNanos;
          validationMilliseconds = Number(phaseFinished - phaseStarted) / 1_000_000;
          validationReceipts = validations.reduce((total, validation) => total + validation.receipts.length, 0);
          exactValidationReceipts = validations.reduce(
            (total, validation) => total + validation.receipts.filter(receipt => receipt.status === 'exact').length,
            0,
          );
          observeRss();
          return validations;
        }),
      graphEvidence: () => Effect.succeed(scaleGraphEvidence(prepared)),
      memoryEvidence: plan =>
        Effect.gen(function* () {
          const phaseStarted = yield* Clock.currentTimeNanos;
          const evidence = yield* retrieveContextBriefMemoryEvidence(fixture.config, plan);
          const phaseFinished = yield* Clock.currentTimeNanos;
          memoryRetrievalMilliseconds = Number(phaseFinished - phaseStarted) / 1_000_000;
          selectedMemories = evidence.candidates.length;
          observeRss();
          return evidence;
        }),
      projection: (logical, maximumEstimatedTokens) =>
        Effect.sync(() => {
          const projected = projectContextBrief(logical, maximumEstimatedTokens);
          observeRss();
          return projected;
        }),
    },
    {
      budgetTokens: fixtureBudgetTokens(prepared),
      mode: 'brief',
      scope: profileScope(prepared),
      task: token,
    },
  );
  const finished = yield* Clock.currentTimeNanos;
  observeRss();
  return {
    boundaryAddedRssBytes: Math.max(0, boundaryPeakRss - rssBefore),
    contextBriefMilliseconds: Number(finished - started) / 1_000_000,
    counters: graph.snapshot(),
    estimatedTokens: brief.measurement.estimatedTokens,
    exactValidationReceipts,
    memoryRetrievalMilliseconds,
    profile: profileId,
    selectedMemories,
    validationMilliseconds,
    validationReceipts,
  } satisfies ContextBriefCitationScaleObservationV2;
});

function prepareContextBriefCitationScaleObservation(graph: ContextBriefCitationScaleGraphInstrumentationShape): void {
  graph.reset();
  Bun.gc(true);
}

function rssObservationId(profileId: ContextBriefCitationScaleProfileId, ordinal: number): string {
  return `context-rss-${profileId}-${ordinal}`;
}

function normalizeRssObservation(
  artifact: ContextBriefCitationScaleRssArtifact,
  observation: ContextBriefCitationScaleRssObservation | undefined,
  profile: ContextBriefCitationScaleProfileId,
  ordinal: number,
): ContextBriefCitationScaleMemoryObservationV2 {
  if (observation === undefined) {
    return {
      maximumSampleGapMilliseconds: Number.MAX_SAFE_INTEGER,
      observedAddedProcessTreeRssBytes: 0,
      observedAddedRootRssBytes: 0,
      observedProcessTreeRssBaselineBytes: 0,
      observedProcessTreeRssPeakBytes: 0,
      observedRootRssBaselineBytes: 0,
      observedRootRssPeakBytes: 0,
      observationId: rssObservationId(profile, ordinal),
      ordinal,
      baselineProcessCount: 0,
      peakProcessCount: 0,
      profile,
      rootStartIdentity: '',
      sampleAttempts: 0,
      sampleFailures: 1,
      sampleIntervalMilliseconds: artifact.intervalMilliseconds,
      samples: 0,
      source: artifact.source,
    };
  }
  return {
    maximumSampleGapMilliseconds: observation.maximumSampleGapMilliseconds,
    observedAddedProcessTreeRssBytes: observation.treeRssGrowthObservedBytes,
    observedAddedRootRssBytes: observation.rootRssGrowthObservedBytes,
    observedProcessTreeRssBaselineBytes: observation.treeRssBaselineBytes,
    observedProcessTreeRssPeakBytes: observation.treeRssPeakObservedBytes,
    observedRootRssBaselineBytes: observation.rootRssBaselineBytes,
    observedRootRssPeakBytes: observation.rootRssPeakObservedBytes,
    observationId: observation.observationId,
    ordinal,
    baselineProcessCount: observation.processCountBaseline,
    peakProcessCount: observation.processCountPeakObserved,
    profile,
    rootStartIdentity: artifact.rootStartIdentity,
    sampleAttempts: observation.sampleAttempts,
    sampleFailures: observation.sampleFailures,
    sampleIntervalMilliseconds: artifact.intervalMilliseconds,
    samples: observation.successfulSamples,
    source: artifact.source,
  };
}

interface MutableCounters {
  activeViewFenceObservations: number;
  coldGraphBuilds: number;
  databasePaths: Set<string>;
  effectiveEvidenceBatches: number;
  leaseBalance: number;
  maintenanceRequests: number;
  peakLeaseBalance: number;
  productionStoreSessionCalls: number;
  snapshotLeaseAcquisitions: number;
  snapshotLeaseReleases: number;
  statusObservations: number;
}

export interface ContextBriefCitationScaleGraphInstrumentationShape {
  readonly instrumentStore: (store: CodeGraphStoreShape) => CodeGraphStoreShape;
  readonly recordColdGraphBuild: Effect.Effect<void>;
  readonly recordMaintenanceRequest: Effect.Effect<void>;
  readonly reset: () => void;
  readonly snapshot: () => ContextBriefCitationScaleCountersV1;
}

export class ContextBriefCitationScaleGraphInstrumentation extends Context.Service<
  ContextBriefCitationScaleGraphInstrumentation,
  ContextBriefCitationScaleGraphInstrumentationShape
>()('@threadnote/threadnote/evaluation/context-brief-citation-scale/ContextBriefCitationScaleGraphInstrumentation') {}

/** Instrument the real graph store boundary without replacing any SQLite behavior. */
export function makeContextBriefCitationScaleGraphInstrumentation(): ContextBriefCitationScaleGraphInstrumentationShape {
  let counters = emptyCounters();
  const observeDatabasePath = (databasePath: string) => {
    counters.databasePaths.add(databasePath);
  };
  const instrumentStore = (store: CodeGraphStoreShape): CodeGraphStoreShape =>
    CodeGraphStore.of({
      ...store,
      acquireSnapshotLease: (databasePath, snapshotId, durationMilliseconds, options) =>
        Effect.sync(() => {
          observeDatabasePath(databasePath);
          counters.snapshotLeaseAcquisitions += 1;
          counters.leaseBalance += 1;
          counters.peakLeaseBalance = Math.max(counters.peakLeaseBalance, counters.leaseBalance);
        }).pipe(Effect.andThen(store.acquireSnapshotLease(databasePath, snapshotId, durationMilliseconds, options))),
      effectiveSnapshotCitationEvidence: (databasePath, snapshotId, request) =>
        Effect.sync(() => {
          observeDatabasePath(databasePath);
          counters.effectiveEvidenceBatches += 1;
        }).pipe(Effect.andThen(store.effectiveSnapshotCitationEvidence(databasePath, snapshotId, request))),
      loadActiveViewFence: (databasePath, worktreeId) =>
        Effect.sync(() => {
          observeDatabasePath(databasePath);
          counters.activeViewFenceObservations += 1;
        }).pipe(Effect.andThen(store.loadActiveViewFence(databasePath, worktreeId))),
      readySnapshot: (databasePath, worktreeId) =>
        Effect.sync(() => {
          observeDatabasePath(databasePath);
          counters.statusObservations += 1;
        }).pipe(Effect.andThen(store.readySnapshot(databasePath, worktreeId))),
      readySnapshotById: (databasePath, snapshotId) =>
        Effect.sync(() => {
          observeDatabasePath(databasePath);
          counters.statusObservations += 1;
        }).pipe(Effect.andThen(store.readySnapshotById(databasePath, snapshotId))),
      releaseSnapshotLease: (databasePath, token, options) =>
        store.releaseSnapshotLease(databasePath, token, options).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              observeDatabasePath(databasePath);
              counters.snapshotLeaseReleases += 1;
              counters.leaseBalance -= 1;
            }),
          ),
        ),
      withSession: (databasePath, effect, options) =>
        Effect.sync(() => {
          observeDatabasePath(databasePath);
          counters.productionStoreSessionCalls += 1;
        }).pipe(Effect.andThen(store.withSession(databasePath, effect, options))),
    });
  const snapshot = (): ContextBriefCitationScaleCountersV1 => ({
    activeViewFenceObservations: counters.activeViewFenceObservations,
    coldGraphBuilds: counters.coldGraphBuilds,
    distinctGraphDatabasePaths: counters.databasePaths.size,
    effectiveEvidenceBatches: counters.effectiveEvidenceBatches,
    leaseBalance: counters.leaseBalance,
    maintenanceRequests: counters.maintenanceRequests,
    peakLeaseBalance: counters.peakLeaseBalance,
    productionStoreSessionCalls: counters.productionStoreSessionCalls,
    snapshotLeaseAcquisitions: counters.snapshotLeaseAcquisitions,
    snapshotLeaseReleases: counters.snapshotLeaseReleases,
    statusObservations: counters.statusObservations,
  });
  return {
    instrumentStore,
    recordColdGraphBuild: Effect.sync(() => {
      counters.coldGraphBuilds += 1;
    }),
    recordMaintenanceRequest: Effect.sync(() => {
      counters.maintenanceRequests += 1;
    }),
    reset: () => {
      counters = emptyCounters();
    },
    snapshot,
  };
}

function scaleGraphEvidence(prepared: ContextBriefCitationScalePreparedProfile): ContextBriefGraphEvidenceV1 {
  const resolvedSnapshots = prepared.repositories.map(repository => ({
    commit: repository.status.identity.headCommit,
    dirty: false,
    freshness: 'fresh' as const,
    repositoryId: repository.repositoryId,
    repositoryKey: repository.name,
    snapshotId: repository.snapshotId,
  }));
  return {
    cards: [],
    citationValidationFence:
      prepared.generation === undefined
        ? {
            kind: 'repository',
            repositoryId: prepared.repositories[0].repositoryId,
            snapshotId: prepared.repositories[0].snapshotId,
          }
        : {generation: prepared.generation, kind: 'workset', workset: prepared.workset!.name},
    contracts: [],
    coverage: {
      complete: true,
      consideredRepositories: prepared.profile.worksetMembers,
      readyRepositories: prepared.profile.worksetMembers,
      requestedRepositories: prepared.profile.worksetMembers,
      states: {current: prepared.profile.worksetMembers},
    },
    gaps: [],
    resolvedSnapshots,
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    warnings: [],
  };
}

function profileScope(prepared: ContextBriefCitationScalePreparedProfile): ContextBriefScopeV1 {
  return prepared.profile.id === 'local-100k'
    ? {
        callerCwd: prepared.repositories[0].root,
        kind: 'repository',
        project: contextBriefCitationScaleProject(prepared),
      }
    : {kind: 'workset', name: prepared.workset!.name, project: contextBriefCitationScaleProject(prepared)};
}

function fixtureBudgetTokens(_prepared: ContextBriefCitationScalePreparedProfile): number {
  return 1_500;
}

function emptyCounters(): MutableCounters {
  return {
    activeViewFenceObservations: 0,
    coldGraphBuilds: 0,
    databasePaths: new Set(),
    effectiveEvidenceBatches: 0,
    leaseBalance: 0,
    maintenanceRequests: 0,
    peakLeaseBalance: 0,
    productionStoreSessionCalls: 0,
    snapshotLeaseAcquisitions: 0,
    snapshotLeaseReleases: 0,
    statusObservations: 0,
  };
}

function gitObservation(arguments_: readonly string[]): {readonly success: boolean; readonly text: string} {
  const result = Bun.spawnSync({cmd: ['git', ...arguments_], stderr: 'ignore', stdout: 'pipe'});
  return {
    success: result.exitCode === 0,
    text: result.stdout ? new TextDecoder().decode(result.stdout).trim() : '',
  };
}
