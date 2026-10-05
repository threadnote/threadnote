import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Database} from 'bun:sqlite';
import {Console, DateTime, Effect, Exit, FileSystem, Path, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore, type StoredCodeGraph} from '@threadnote/graph/store';
import type {CodeGraphProgress} from '@threadnote/graph/types';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  processResourceUsageMaxRssBytes,
  SystemInfo,
  type ProcessResourceUsageRuntime,
  type SystemInfoShape,
} from '@threadnote/platform/system';
import {
  BENCHMARK_ARTIFACT_VERSION,
  benchmarkMeasurement,
  parseBenchmarkArtifactV1,
  type BenchmarkArtifactV1,
} from '@threadnote/evidence/benchmark';
import {atomicWrite, hasScriptHelpFlag, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import {
  enforceCodeGraphBenchmarkRatchet,
  validateCodeGraphBenchmarkRatchet,
  type BenchmarkRuntimeProvenance,
  type BenchmarkStorageEnvironment,
  type CodeGraphBenchmarkRatchetV1,
} from './benchmark-code-graph.js';
import {
  CODE_GRAPH_HEAVY_TAIL_GENERATED_TYPESCRIPT_PATH,
  CODE_GRAPH_HEAVY_TAIL_PROFILE,
  CODE_GRAPH_HEAVY_TAIL_SMOKE_PROFILE,
  codeGraphHeavyTailEligibleFiles,
  parseCodeGraphHeavyTailProfile,
  prepareCodeGraphHeavyTailFixture,
  type CodeGraphHeavyTailProfile,
} from './code-graph-heavy-tail-fixture.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const CHILD_OUTPUT_LIMIT_BYTES = 1_048_576;

export interface HeavyTailLanguageTelemetry {
  readonly degradedFiles: number;
  readonly factsBytes: number;
  readonly files: number;
  readonly parseMilliseconds: number;
  readonly persistenceMilliseconds: number;
  readonly requestMilliseconds: number;
  readonly relations: number;
  readonly sourceBytes: number;
  readonly symbols: number;
}

export interface HeavyTailSlowFile {
  readonly bytes: number;
  readonly factsBytes: number;
  readonly language: string;
  readonly parseMilliseconds: number;
  readonly path: string;
  readonly requestMilliseconds: number;
}

export interface HeavyTailExtractionUtilization {
  /** Wall time during which at least one parser request was active. */
  readonly activeWallMilliseconds: number;
  /** Sum of parent-observed request durations divided by active wall time. */
  readonly averageConcurrency: number;
  readonly peakConcurrency: number;
  /** Sum of parent-observed request durations, including worker and JSON-line IPC. */
  readonly requestMilliseconds: number;
}

export interface HeavyTailChildRun {
  readonly cache: {
    readonly factsBytes: number;
    readonly files: number;
    readonly lowSignalJsonFactsBytes: number;
  };
  readonly cpuMilliseconds: number;
  readonly durationMilliseconds: number;
  readonly extraction: HeavyTailExtractionUtilization;
  readonly graph?: {
    readonly digest: string;
    readonly edges: number;
    readonly files: number;
    readonly generatedTypeScriptTailPreserved: boolean;
    readonly lowSignalJsonSymbols: number;
    readonly pathologicalTypeScriptTails: number;
    readonly symbols: number;
    readonly textlessSvgSymbols: number;
  };
  readonly interruptedAfterPersistedFiles?: number;
  readonly languages: Readonly<Record<string, HeavyTailLanguageTelemetry>>;
  readonly peakRssBytes: number;
  readonly readingMilliseconds: number;
  readonly reusedFiles?: number;
  readonly slowFiles: readonly HeavyTailSlowFile[];
  readonly state: 'complete' | 'interrupted';
  readonly version: 2;
  readonly workerCount: number;
}

export interface CodeGraphHeavyTailBenchmarkArtifact {
  readonly assertions: {
    readonly interruptionRetainedCache: true;
    readonly lowSignalJsonExcluded: true;
    readonly parallelMatchesSingle: true;
    readonly sixWorkersMatchSingle: true;
    readonly pathologicalTypeScriptSurfacePreserved: true;
    readonly resumeMatchesClean: true;
    readonly resumeReusedCache: true;
    readonly textlessSvgExcluded: true;
    readonly eightWorkersMatchSingle: true;
  };
  readonly createdAt: string;
  /** Hosted CI captures exercise correctness only; local governed captures may ratchet performance. */
  readonly evidenceClass?: HeavyTailEvidenceClass;
  readonly environment: {
    readonly architecture: string;
    readonly availableBytes?: number;
    readonly commit: string;
    readonly cpu: string;
    readonly dirty: boolean;
    readonly memoryBytes: number;
    readonly minimumFreeBytes?: number;
    readonly operatingSystem: string;
    readonly provenance?: BenchmarkRuntimeProvenance;
    readonly runtime: string;
    readonly runnerClass: string;
    readonly runnerIdentity: string;
    readonly storage?: BenchmarkStorageEnvironment;
  };
  readonly profile: CodeGraphHeavyTailProfile;
  readonly ratchetArtifact: BenchmarkArtifactV1;
  readonly runs: {
    readonly eightWorkers: HeavyTailChildRun;
    readonly interrupted: HeavyTailChildRun;
    readonly parallel: HeavyTailChildRun;
    readonly resumed: HeavyTailChildRun;
    readonly sixWorkers: HeavyTailChildRun;
    readonly single: HeavyTailChildRun;
  };
  readonly suite: 'code-graph-large-monorepo-heavy-tail-v2';
  readonly version: 3;
}

export interface LegacyCodeGraphHeavyTailBenchmarkArtifact extends Omit<
  CodeGraphHeavyTailBenchmarkArtifact,
  'ratchetArtifact' | 'version'
> {
  readonly ratchetArtifact?: undefined;
  readonly version: 2;
}

export type AnyCodeGraphHeavyTailBenchmarkArtifact =
  CodeGraphHeavyTailBenchmarkArtifact | LegacyCodeGraphHeavyTailBenchmarkArtifact;

export interface HeavyTailGovernanceEvidence {
  readonly availableBytes: number;
  readonly minimumFreeBytes: number;
  readonly runtimeProvenance: BenchmarkRuntimeProvenance;
  readonly storage: BenchmarkStorageEnvironment;
}

export interface CodeGraphHeavyTailBenchmarkArguments {
  readonly child: boolean;
  readonly candidateCommit?: string;
  readonly evidenceClass: HeavyTailEvidenceClass;
  readonly governed: boolean;
  readonly home?: string;
  readonly interruptAfterPersistedFiles?: number;
  readonly minimumFreeGiB: number;
  readonly outputPath?: string;
  readonly profilePath?: string;
  readonly ratchetPath?: string;
  readonly repository?: string;
  readonly smoke: boolean;
  readonly workers?: number;
}

export type HeavyTailEvidenceClass = 'correctness-only' | 'governed-performance';
const HEAVY_TAIL_THRESHOLD_POLICY = 'relative-15-percent-or-absolute-5ms; exact-zero-and-shape-strict';
const HEAVY_TAIL_OUTER_ARTIFACT_SHA256_METADATA = 'outerArtifactSha256';

const benchmark = Effect.scoped(
  Effect.gen(function* () {
    const input = yield* scriptArguments();
    if (hasScriptHelpFlag(input)) {
      yield* Console.log(usage());
      return;
    }
    const args = parseCodeGraphHeavyTailBenchmarkArguments(input);
    if (args.child) return yield* runChild(args);
    return yield* runParent(args);
  }),
);

const runParent = Effect.fn('benchmarkCodeGraphHeavyTail.parent')(function* (
  args: CodeGraphHeavyTailBenchmarkArguments,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const environment = system.environment();
  const configuredRunnerClass = environment.THREADNOTE_BENCHMARK_RUNNER_CLASS?.trim();
  const configuredRunnerIdentity = environment.THREADNOTE_BENCHMARK_RUNNER_ID?.trim();
  if (
    args.candidateCommit !== undefined &&
    (!configuredRunnerClass ||
      configuredRunnerClass === 'local-unclassified' ||
      !configuredRunnerIdentity ||
      configuredRunnerIdentity === 'local')
  ) {
    return yield* ScriptError.make({
      message:
        'Heavy-tail release capture requires explicit THREADNOTE_BENCHMARK_RUNNER_CLASS and THREADNOTE_BENCHMARK_RUNNER_ID bindings.',
    });
  }
  const sourceRoot = path.resolve(yield* path.fromFileUrl(new URL('..', import.meta.url)));
  const checkedHeavyTailRatchetPath = path.join(
    sourceRoot,
    'apps/threadnote/test/evaluation/baselines/code-graph-v1/heavy-tail-scheduler-ratchet.json',
  );
  if (args.candidateCommit !== undefined && path.resolve(args.ratchetPath!) !== checkedHeavyTailRatchetPath) {
    return yield* ScriptError.make({
      message: `Heavy-tail release capture requires the checked ratchet at ${checkedHeavyTailRatchetPath}.`,
    });
  }
  const governance = args.governed
    ? yield* prepareHeavyTailGovernance(system, sourceRoot, args.minimumFreeGiB)
    : undefined;
  const ratchet = args.ratchetPath === undefined ? undefined : yield* readJsonFile(args.ratchetPath);
  if (ratchet !== undefined) {
    const {validateCodeGraphBenchmarkRatchet} = yield* Effect.promise(() => import('./benchmark-code-graph.js'));
    validateCodeGraphBenchmarkRatchet(ratchet);
  }
  const profile = args.smoke ? CODE_GRAPH_HEAVY_TAIL_SMOKE_PROFILE : CODE_GRAPH_HEAVY_TAIL_PROFILE;
  const fixture = yield* prepareCodeGraphHeavyTailFixture(profile);
  const profilePath = path.join(fixture.root, 'profile.json');
  yield* fs.writeFileString(profilePath, `${JSON.stringify(profile)}\n`);

  const childScript = yield* path.fromFileUrl(new URL('./benchmark-code-graph-heavy-tail.ts', import.meta.url));
  const single = yield* spawnChild({
    childScript,
    home: path.join(fixture.root, 'home-single'),
    name: 'single',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: 1,
  });
  const parallel = yield* spawnChild({
    childScript,
    home: path.join(fixture.root, 'home-parallel'),
    name: 'parallel',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: profile.parallelWorkers,
  });
  const sixWorkers = yield* spawnChild({
    childScript,
    home: path.join(fixture.root, 'home-six-workers'),
    name: 'six-workers',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: 6,
  });
  const eightWorkers = yield* spawnChild({
    childScript,
    home: path.join(fixture.root, 'home-eight-workers'),
    name: 'eight-workers',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: 8,
  });
  const resumeHome = path.join(fixture.root, 'home-resume');
  const interrupted = yield* spawnChild({
    childScript,
    home: resumeHome,
    interruptAfterPersistedFiles: profile.interruptAfterPersistedFiles,
    name: 'interrupted',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: profile.parallelWorkers,
  });
  const resumed = yield* spawnChild({
    childScript,
    home: resumeHome,
    name: 'resumed',
    profilePath,
    repository: fixture.repository,
    root: fixture.root,
    workers: profile.parallelWorkers,
  });

  validateCompletedRun('single-worker', single, profile);
  validateCompletedRun('parallel-worker', parallel, profile);
  validateCompletedRun('six-worker', sixWorkers, profile);
  validateCompletedRun('eight-worker', eightWorkers, profile);
  validateCompletedRun('resumed', resumed, profile);
  if (interrupted.state !== 'interrupted' || interrupted.cache.files < 1) {
    return yield* ScriptError.make({message: 'The interruption run did not retain any durable parser cache rows.'});
  }
  if ((resumed.reusedFiles ?? 0) < 1) {
    return yield* ScriptError.make({message: 'The resumed run did not reuse facts persisted before interruption.'});
  }
  if (single.graph!.digest !== parallel.graph!.digest) {
    return yield* ScriptError.make({message: 'Single-worker and parallel code graphs differ.'});
  }
  if (single.graph!.digest !== sixWorkers.graph!.digest) {
    return yield* ScriptError.make({message: 'Single-worker and six-worker code graphs differ.'});
  }
  if (single.graph!.digest !== eightWorkers.graph!.digest) {
    return yield* ScriptError.make({message: 'Single-worker and eight-worker code graphs differ.'});
  }
  if (single.graph!.digest !== resumed.graph!.digest) {
    return yield* ScriptError.make({message: 'Interrupted/resumed and clean code graphs differ.'});
  }

  const hardware = yield* system.hardwareInfo;
  const [commit, dirty] =
    governance === undefined
      ? yield* Effect.all([git(sourceRoot, ['rev-parse', 'HEAD']), git(sourceRoot, ['status', '--porcelain'])], {
          concurrency: 2,
        })
      : [governance.runtimeProvenance.sourceCommit, ''];
  if (args.candidateCommit !== undefined && commit !== args.candidateCommit) {
    return yield* ScriptError.make({
      message: `Heavy-tail evidence observed commit ${commit}; required exact candidate ${args.candidateCommit}.`,
    });
  }
  if (args.governed && args.candidateCommit !== undefined && dirty.length > 0) {
    return yield* ScriptError.make({message: 'Governed heavy-tail release evidence requires a clean exact candidate.'});
  }
  if (governance !== undefined) {
    const {validateBenchmarkRuntimeProvenance} = yield* Effect.promise(() => import('./benchmark-code-graph.js'));
    const finalProvenance = yield* validateBenchmarkRuntimeProvenance(sourceRoot);
    if (JSON.stringify(finalProvenance) !== JSON.stringify(governance.runtimeProvenance)) {
      return yield* ScriptError.make({
        message: 'Heavy-tail benchmark source/runtime provenance changed during the run.',
      });
    }
  }
  const baseArtifact = {
    assertions: {
      interruptionRetainedCache: true,
      lowSignalJsonExcluded: true,
      parallelMatchesSingle: true,
      sixWorkersMatchSingle: true,
      pathologicalTypeScriptSurfacePreserved: true,
      resumeMatchesClean: true,
      resumeReusedCache: true,
      textlessSvgExcluded: true,
      eightWorkersMatchSingle: true,
    },
    createdAt: DateTime.formatIso(yield* DateTime.now),
    evidenceClass: args.evidenceClass,
    environment: {
      architecture: system.architecture,
      ...(governance === undefined
        ? {}
        : {
            availableBytes: governance.availableBytes,
            minimumFreeBytes: governance.minimumFreeBytes,
            provenance: governance.runtimeProvenance,
            storage: governance.storage,
          }),
      commit,
      cpu: hardware.cpuModel,
      dirty: dirty.length > 0,
      memoryBytes: hardware.memoryBytes,
      operatingSystem: hardware.operatingSystem,
      runtime: `bun/${system.runtimeVersion}`,
      runnerClass: configuredRunnerClass || 'local-unclassified',
      runnerIdentity: configuredRunnerIdentity || 'local',
    },
    profile,
    runs: {eightWorkers, interrupted, parallel, resumed, sixWorkers, single},
    suite: 'code-graph-large-monorepo-heavy-tail-v2',
    version: 3,
  } satisfies Omit<CodeGraphHeavyTailBenchmarkArtifact, 'ratchetArtifact'>;
  const artifact: CodeGraphHeavyTailBenchmarkArtifact = {
    ...baseArtifact,
    ratchetArtifact: codeGraphHeavyTailRatchetArtifact(baseArtifact, system.platform, governance),
  };
  parseCodeGraphHeavyTailBenchmarkArtifact(artifact);
  if (args.outputPath) yield* atomicWrite(args.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  yield* printJson(artifact);
  if (ratchet !== undefined) {
    const {enforceCodeGraphBenchmarkRatchet} = yield* Effect.promise(() => import('./benchmark-code-graph.js'));
    return yield* Effect.try({
      catch: cause =>
        Schema.is(ScriptError)(cause)
          ? cause
          : ScriptError.make({message: `Heavy-tail performance ratchet failed: ${String(cause)}`}),
      try: () => enforceCodeGraphBenchmarkRatchet(artifact.ratchetArtifact, ratchet),
    });
  }
});

const prepareHeavyTailGovernance = Effect.fn('benchmarkCodeGraphHeavyTail.prepareGovernance')(function* (
  system: SystemInfoShape,
  sourceRoot: string,
  minimumFreeGiB: number,
) {
  const minimumFreeBytes = minimumFreeGiB * 1_073_741_824;
  const {benchmarkStorageEnvironment, validateBenchmarkRuntimeProvenance} = yield* Effect.promise(
    () => import('./benchmark-code-graph.js'),
  );
  const [runtimeProvenance, storage, availableBytes] = yield* Effect.all(
    [
      validateBenchmarkRuntimeProvenance(sourceRoot),
      benchmarkStorageEnvironment(system.tempDirectory),
      system.availableDiskBytes(system.tempDirectory),
    ],
    {concurrency: 3},
  );
  if (availableBytes === undefined || availableBytes < minimumFreeBytes) {
    return yield* ScriptError.make({
      message: `Governed heavy-tail benchmark requires at least ${minimumFreeGiB} GiB free on its temporary filesystem.`,
    });
  }
  if (storage.medium !== 'solid-state') {
    return yield* ScriptError.make({
      message: `Governed heavy-tail benchmark requires solid-state storage; detected ${storage.medium}.`,
    });
  }
  if (system.platform === 'darwin' && storage.location !== 'internal') {
    return yield* ScriptError.make({
      message: `Governed heavy-tail benchmark requires the internal macOS device; detected ${storage.location}.`,
    });
  }
  return {availableBytes, minimumFreeBytes, runtimeProvenance, storage} satisfies HeavyTailGovernanceEvidence;
});

export function codeGraphHeavyTailRatchetArtifact(
  artifact: Omit<CodeGraphHeavyTailBenchmarkArtifact, 'ratchetArtifact'>,
  runtimePlatform: string,
  governance?: HeavyTailGovernanceEvidence,
): BenchmarkArtifactV1 {
  const evidenceClass =
    artifact.evidenceClass ?? (governance === undefined ? 'correctness-only' : 'governed-performance');
  const runs = [
    ['single', artifact.runs.single],
    ['parallel', artifact.runs.parallel],
    ['six-workers', artifact.runs.sixWorkers],
    ['eight-workers', artifact.runs.eightWorkers],
    ['interrupted', artifact.runs.interrupted],
    ['resumed', artifact.runs.resumed],
  ] as const;
  const measurements = runs.flatMap(([name, run]) =>
    heavyTailRunMeasurements(name, run, name !== 'interrupted' && name !== 'resumed'),
  );
  measurements.push(
    benchmarkMeasurement('parallel-duration-reduction', 'percent', [
      nonNegativePercentReduction(
        artifact.runs.single.durationMilliseconds,
        artifact.runs.parallel.durationMilliseconds,
      ),
    ]),
    benchmarkMeasurement('parallel-active-wall-reduction', 'percent', [
      nonNegativePercentReduction(
        artifact.runs.single.extraction.activeWallMilliseconds,
        artifact.runs.parallel.extraction.activeWallMilliseconds,
      ),
    ]),
    benchmarkMeasurement('resume-retained-cache-coverage', 'percent', [
      percentage(artifact.runs.resumed.reusedFiles ?? 0, artifact.runs.interrupted.cache.files),
    ]),
  );
  const fixtureHash = `code-graph-heavy-tail-v1:${sha256HexSync(JSON.stringify(artifact.profile))}`;
  const ratchetArtifact: BenchmarkArtifactV1 = {
    createdAt: artifact.createdAt,
    environment: {
      architecture: artifact.environment.architecture,
      commit: artifact.environment.commit,
      cpu: artifact.environment.cpu,
      dirty: artifact.environment.dirty,
      fixtureHash,
      memoryBytes: artifact.environment.memoryBytes,
      node: artifact.environment.runtime,
      operatingSystem: artifact.environment.operatingSystem,
      packageManager: artifact.environment.runtime,
      runner: 'threadnote-code-graph-heavy-tail',
      runnerVersion: '3',
    },
    measurements,
    metadata: {
      automaticParserWorkers: artifact.profile.parallelWorkers,
      candidateCommit: artifact.environment.commit,
      evidenceClass,
      governed: governance !== undefined,
      graphDigest: artifact.runs.single.graph?.digest ?? 'missing',
      minimumFreeGiB: governance === undefined ? 0 : governance.minimumFreeBytes / 1_073_741_824,
      [HEAVY_TAIL_OUTER_ARTIFACT_SHA256_METADATA]: sha256HexSync(canonicalJson(artifact)),
      profile: `${artifact.profile.id}-v${artifact.profile.version}`,
      runnerClass: artifact.environment.runnerClass,
      runnerIdentity: artifact.environment.runnerIdentity,
      runtimePlatform,
      storageFilesystem: governance?.storage.filesystem ?? 'unverified',
      storageLocation: governance?.storage.location ?? 'unverified',
      storageMedium: governance?.storage.medium ?? 'unverified',
      thresholdPolicy: HEAVY_TAIL_THRESHOLD_POLICY,
      vectorEnabled: false,
      workerCapacities: '1,4,6,8',
    },
    suite: 'threadnote-code-graph-heavy-tail',
    version: BENCHMARK_ARTIFACT_VERSION,
    warmups: 0,
  };
  return parseBenchmarkArtifactV1(ratchetArtifact);
}

interface HeavyTailMeasurementRatchet {
  readonly meanMaximum?: number;
  readonly maximum?: number;
  readonly minimum?: number;
  readonly p50Maximum?: number;
  readonly p95Maximum?: number;
  readonly p99Maximum?: number;
  readonly samplesMinimum: number;
  readonly unit: BenchmarkArtifactV1['measurements'][number]['unit'];
}

const HEAVY_TAIL_RATCHET_RELATIVE_HEADROOM = 0.15;
const HEAVY_TAIL_RATCHET_MILLISECOND_NOISE_HEADROOM = 5;
const HEAVY_TAIL_NUMERIC_EPSILON = 1e-6;

export interface CodeGraphHeavyTailRatchet {
  readonly environment: Readonly<Record<string, boolean | number | string>>;
  readonly measurements: Readonly<Record<string, HeavyTailMeasurementRatchet>>;
  readonly metadata: Readonly<Record<string, boolean | number | string>>;
  readonly suite: 'threadnote-code-graph-heavy-tail';
  readonly version: 1;
}

export interface HeavyTailReleaseFreshnessPolicy {
  readonly futureSkewMilliseconds: number;
  readonly maximumAgeMilliseconds: number;
  readonly maximumSpanMilliseconds: number;
  readonly notBefore: string;
  readonly observedAt: string;
}

export interface HeavyTailReleaseRatchetOptions {
  readonly candidateCommit: string;
  readonly checkedRatchet: unknown;
  readonly freshness: HeavyTailReleaseFreshnessPolicy;
  readonly runnerClass: string;
  readonly runnerIdentity: string;
}

export function createCodeGraphHeavyTailRatchet(
  artifacts: readonly CodeGraphHeavyTailBenchmarkArtifact[],
): CodeGraphHeavyTailRatchet {
  if (artifacts.length !== 3)
    throw ScriptError.make({message: 'Heavy-tail ratchet generation requires exactly three artifacts.'});
  const standards = artifacts.map(artifact => parseBenchmarkArtifactV1(artifact.ratchetArtifact));
  const first = standards[0];
  const sharedMetadata = heavyTailSharedRatchetMetadata(first.metadata);
  const generationIdentity = governedHeavyTailRatchetGenerationIdentity(artifacts[0], first);
  if (
    first.metadata.evidenceClass !== 'governed-performance' ||
    first.metadata.thresholdPolicy !== HEAVY_TAIL_THRESHOLD_POLICY
  ) {
    throw ScriptError.make({message: 'Heavy-tail ratchet generation requires governed-performance evidence.'});
  }
  if (artifacts.some(artifact => artifact.evidenceClass !== 'governed-performance')) {
    throw ScriptError.make({message: 'Heavy-tail ratchet generation requires governed-performance evidence.'});
  }
  const creationTimes = artifacts.map(artifact => Date.parse(artifact.createdAt));
  if (
    creationTimes.some(time => !Number.isFinite(time)) ||
    creationTimes.some((time, index) => index > 0 && time <= creationTimes[index - 1])
  ) {
    throw ScriptError.make({message: 'Heavy-tail ratchet artifacts require strictly ordered fresh run timestamps.'});
  }
  const firstNames = first.measurements.map(measurement => measurement.name).sort();
  for (let index = 1; index < standards.length; index += 1) {
    const artifact = standards[index];
    const names = artifact.measurements.map(measurement => measurement.name).sort();
    if (
      artifact.suite !== first.suite ||
      JSON.stringify(names) !== JSON.stringify(firstNames) ||
      artifact.environment.architecture !== first.environment.architecture ||
      artifact.environment.cpu !== first.environment.cpu ||
      artifact.environment.fixtureHash !== first.environment.fixtureHash ||
      artifact.environment.memoryBytes !== first.environment.memoryBytes ||
      artifact.environment.node !== first.environment.node ||
      artifact.environment.operatingSystem !== first.environment.operatingSystem ||
      artifact.environment.packageManager !== first.environment.packageManager ||
      artifact.environment.runner !== first.environment.runner ||
      artifact.environment.runnerVersion !== first.environment.runnerVersion ||
      artifact.metadata.evidenceClass !== first.metadata.evidenceClass ||
      artifact.metadata.thresholdPolicy !== HEAVY_TAIL_THRESHOLD_POLICY ||
      canonicalJson(heavyTailSharedRatchetMetadata(artifact.metadata)) !== canonicalJson(sharedMetadata)
    ) {
      throw ScriptError.make({
        message: 'Heavy-tail ratchet artifacts do not share one governed runner and fixture contract.',
      });
    }
    if (governedHeavyTailRatchetGenerationIdentity(artifacts[index], artifact) !== generationIdentity) {
      throw ScriptError.make({
        message: 'Heavy-tail ratchet artifacts do not share one exact source/runtime/storage contract.',
      });
    }
  }
  if (standards.some(artifact => artifact.environment.dirty || artifact.metadata.governed !== true)) {
    throw ScriptError.make({message: 'Heavy-tail ratchet generation requires clean governed artifacts.'});
  }
  const measurements: Record<string, HeavyTailMeasurementRatchet> = {};
  for (const name of firstNames) {
    const samples = standards.map(artifact => artifact.measurements.find(measurement => measurement.name === name)!);
    const unit = samples[0].unit;
    if (samples.some(sample => sample.unit !== unit || sample.samples !== 1)) {
      throw ScriptError.make({message: `Heavy-tail ratchet measurement ${name} has inconsistent samples or units.`});
    }
    measurements[name] = heavyTailMeasurementRatchet(
      name,
      unit,
      samples.map(sample => sample.p50),
    );
  }
  return {
    environment: {
      architecture: first.environment.architecture,
      cpu: first.environment.cpu,
      dirty: false,
      fixtureHash: first.environment.fixtureHash,
      memoryBytes: first.environment.memoryBytes,
      node: first.environment.node,
      operatingSystem: first.environment.operatingSystem,
      packageManager: first.environment.packageManager,
      runner: first.environment.runner,
      runnerVersion: first.environment.runnerVersion,
    },
    measurements,
    metadata: sharedMetadata,
    suite: 'threadnote-code-graph-heavy-tail',
    version: 1,
  };
}

function heavyTailSharedRatchetMetadata(metadata: BenchmarkArtifactV1['metadata']): BenchmarkArtifactV1['metadata'] {
  const {[HEAVY_TAIL_OUTER_ARTIFACT_SHA256_METADATA]: _outerArtifactSha256, ...shared} = metadata;
  return shared;
}

/**
 * Validates optional heavy-tail performance evidence, not release readiness. Hosted Actions captures deliberately
 * cannot satisfy this contract: governed performance evidence needs three fresh runs on one local runner.
 */
export function assertHeavyTailReleaseRatchet(
  artifacts: readonly CodeGraphHeavyTailBenchmarkArtifact[],
  options: HeavyTailReleaseRatchetOptions,
): CodeGraphHeavyTailRatchet {
  if (!/^[0-9a-f]{40}$/u.test(options.candidateCommit)) {
    throw ScriptError.make({message: 'Heavy-tail release evidence requires an exact 40-character candidate commit.'});
  }
  if (!options.runnerClass.trim() || options.runnerClass === 'local-unclassified') {
    throw ScriptError.make({message: 'Heavy-tail release evidence requires an explicit runner class.'});
  }
  if (!options.runnerIdentity.trim() || options.runnerIdentity === 'local') {
    throw ScriptError.make({message: 'Heavy-tail release evidence requires an explicit runner identity.'});
  }
  const freshness = validateHeavyTailReleaseFreshness(artifacts, options.freshness);
  validateCodeGraphBenchmarkRatchet(options.checkedRatchet);
  const observedRatchet = createCodeGraphHeavyTailRatchet(artifacts);
  for (const artifact of artifacts) {
    parseCodeGraphHeavyTailReleaseEvidence(artifact);
    const provenance = artifact.environment.provenance;
    if (
      artifact.environment.commit !== options.candidateCommit ||
      artifact.environment.dirty ||
      artifact.evidenceClass !== 'governed-performance' ||
      artifact.environment.runnerClass !== options.runnerClass ||
      artifact.environment.runnerIdentity !== options.runnerIdentity ||
      provenance?.mode !== 'managed-exact-head' ||
      provenance.sourceCommit !== options.candidateCommit
    ) {
      throw ScriptError.make({
        message:
          'Heavy-tail release evidence requires three clean governed local runs from the exact frozen candidate on the matching runner.',
      });
    }
    enforceCodeGraphBenchmarkRatchet(artifact.ratchetArtifact, options.checkedRatchet);
  }
  if (
    observedRatchet.metadata.evidenceClass !== 'governed-performance' ||
    observedRatchet.metadata.candidateCommit !== options.candidateCommit
  ) {
    throw ScriptError.make({message: 'Heavy-tail release evidence runner identity is not replayable.'});
  }
  if (observedRatchet.metadata.thresholdPolicy !== HEAVY_TAIL_THRESHOLD_POLICY) {
    throw ScriptError.make({message: 'Heavy-tail release evidence threshold policy cannot be weakened.'});
  }
  const ratchet = preserveCheckedHeavyTailRatchetLimits(
    observedRatchet,
    options.checkedRatchet as CodeGraphBenchmarkRatchetV1,
  );
  assertHeavyTailRatchetNoWeaker(ratchet, options.checkedRatchet as CodeGraphBenchmarkRatchetV1);
  return {
    ...ratchet,
    metadata: {
      ...ratchet.metadata,
      releaseFutureSkewMilliseconds: freshness.futureSkewMilliseconds,
      releaseMaximumEvidenceAgeMilliseconds: freshness.maximumAgeMilliseconds,
      releaseMaximumRunSpanMilliseconds: freshness.maximumSpanMilliseconds,
      releaseNotBefore: freshness.notBefore,
      releaseObservedAt: freshness.observedAt,
    },
  };
}

function preserveCheckedHeavyTailRatchetLimits(
  generated: CodeGraphHeavyTailRatchet,
  checked: CodeGraphBenchmarkRatchetV1,
): CodeGraphHeavyTailRatchet {
  const measurements: Record<string, HeavyTailMeasurementRatchet> = {};
  for (const [name, generatedLimit] of Object.entries(generated.measurements)) {
    const checkedLimit = checked.measurements[name];
    measurements[name] =
      checkedLimit === undefined || checkedLimit.unit !== generatedLimit.unit
        ? generatedLimit
        : {
            meanMaximum: tighterUpperBound(generatedLimit.meanMaximum, checkedLimit.meanMaximum),
            maximum: tighterUpperBound(generatedLimit.maximum, checkedLimit.maximum),
            minimum: tighterLowerBound(generatedLimit.minimum, checkedLimit.minimum),
            p50Maximum: tighterUpperBound(generatedLimit.p50Maximum, checkedLimit.p50Maximum),
            p95Maximum: tighterUpperBound(generatedLimit.p95Maximum, checkedLimit.p95Maximum),
            p99Maximum: tighterUpperBound(generatedLimit.p99Maximum, checkedLimit.p99Maximum),
            samplesMinimum: Math.max(generatedLimit.samplesMinimum, checkedLimit.samplesMinimum ?? 1),
            unit: generatedLimit.unit,
          };
  }
  return {...generated, measurements};
}

function tighterUpperBound(generated: number | undefined, checked: number | undefined): number | undefined {
  if (generated === undefined) return checked;
  if (checked === undefined) return generated;
  return Math.min(generated, checked);
}

function tighterLowerBound(generated: number | undefined, checked: number | undefined): number | undefined {
  if (generated === undefined) return checked;
  if (checked === undefined) return generated;
  return Math.max(generated, checked);
}

function validateHeavyTailReleaseFreshness(
  artifacts: readonly CodeGraphHeavyTailBenchmarkArtifact[],
  policy: HeavyTailReleaseFreshnessPolicy,
): HeavyTailReleaseFreshnessPolicy {
  const notBefore = Date.parse(policy.notBefore);
  const observedAt = Date.parse(policy.observedAt);
  if (
    !Number.isFinite(notBefore) ||
    !Number.isFinite(observedAt) ||
    notBefore > observedAt ||
    !nonNegativeInteger(policy.futureSkewMilliseconds) ||
    !positiveInteger(policy.maximumAgeMilliseconds) ||
    !positiveInteger(policy.maximumSpanMilliseconds)
  ) {
    throw ScriptError.make({message: 'Heavy-tail release freshness policy is invalid.'});
  }
  const creationTimes = artifacts.map(artifact => Date.parse(artifact.createdAt));
  if (creationTimes.some(time => time < notBefore || observedAt - time > policy.maximumAgeMilliseconds)) {
    throw ScriptError.make({
      message: 'Heavy-tail release evidence falls outside the independently supplied freshness window.',
    });
  }
  if (creationTimes.some(time => time > observedAt + policy.futureSkewMilliseconds)) {
    throw ScriptError.make({message: 'Heavy-tail release evidence exceeds the allowed future skew.'});
  }
  if (Math.max(...creationTimes) - Math.min(...creationTimes) > policy.maximumSpanMilliseconds) {
    throw ScriptError.make({message: 'Heavy-tail release evidence exceeds the maximum three-run span.'});
  }
  return policy;
}

function assertHeavyTailRatchetNoWeaker(
  generated: CodeGraphHeavyTailRatchet,
  checked: CodeGraphBenchmarkRatchetV1,
): void {
  for (const [name, checkedLimit] of Object.entries(checked.measurements)) {
    const generatedLimit = generated.measurements[name];
    if (generatedLimit === undefined || generatedLimit.unit !== checkedLimit.unit) {
      throw ScriptError.make({message: `Generated heavy-tail ratchet is weaker than the checked ratchet at ${name}.`});
    }
    for (const key of ['maximum', 'meanMaximum', 'p50Maximum', 'p95Maximum', 'p99Maximum'] as const) {
      const checkedValue = checkedLimit[key];
      const generatedValue = generatedLimit[key as keyof HeavyTailMeasurementRatchet];
      if (checkedValue !== undefined && (typeof generatedValue !== 'number' || generatedValue > checkedValue)) {
        throw ScriptError.make({
          message: `Generated heavy-tail ratchet is weaker than the checked ratchet at ${name}.${key}.`,
        });
      }
    }
    if (
      checkedLimit.minimum !== undefined &&
      (generatedLimit.minimum === undefined || generatedLimit.minimum < checkedLimit.minimum)
    ) {
      throw ScriptError.make({
        message: `Generated heavy-tail ratchet is weaker than the checked ratchet at ${name}.minimum.`,
      });
    }
    if (checkedLimit.samplesMinimum !== undefined && generatedLimit.samplesMinimum < checkedLimit.samplesMinimum) {
      throw ScriptError.make({
        message: `Generated heavy-tail ratchet is weaker than the checked ratchet at ${name}.samplesMinimum.`,
      });
    }
  }
}

function governedHeavyTailRatchetGenerationIdentity(
  artifact: CodeGraphHeavyTailBenchmarkArtifact,
  standard: BenchmarkArtifactV1,
): string {
  const {availableBytes, commit, minimumFreeBytes, provenance, storage} = artifact.environment;
  if (
    standard.environment.commit !== commit ||
    standard.metadata.governed !== true ||
    provenance === undefined ||
    provenance.sourceCommit !== commit ||
    storage === undefined ||
    availableBytes === undefined ||
    minimumFreeBytes === undefined ||
    minimumFreeBytes < 120 * 1_073_741_824 ||
    availableBytes < minimumFreeBytes ||
    storage.filesystem === 'unknown' ||
    storage.medium !== 'solid-state' ||
    (standard.metadata.runtimePlatform === 'darwin' && storage.location !== 'internal') ||
    standard.metadata.minimumFreeGiB !== minimumFreeBytes / 1_073_741_824 ||
    standard.metadata.storageFilesystem !== storage.filesystem ||
    standard.metadata.storageLocation !== storage.location ||
    standard.metadata.storageMedium !== storage.medium
  ) {
    throw ScriptError.make({message: 'Heavy-tail ratchet generation requires complete exact governed provenance.'});
  }
  return JSON.stringify({commit, minimumFreeBytes, provenance, storage});
}

function heavyTailMeasurementRatchet(
  name: string,
  unit: BenchmarkArtifactV1['measurements'][number]['unit'],
  values: readonly number[],
): HeavyTailMeasurementRatchet {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const base = {samplesMinimum: 1 as const, unit};
  const scheduleDependentResume = name.startsWith('interrupted-') || name.startsWith('resumed-');
  if (name.endsWith('-extraction-average-concurrency')) {
    return scheduleDependentResume
      ? {...base, maximum: Math.ceil(maximum - HEAVY_TAIL_NUMERIC_EPSILON)}
      : {...base, minimum: floorThreshold(minimum * 0.9)};
  }
  if (name.endsWith('-duration-reduction') || name.endsWith('-active-wall-reduction')) {
    return {...base, minimum: floorThreshold(minimum * 0.8)};
  }
  if (name === 'resume-retained-cache-coverage') return {...base, maximum: 100, minimum: 100};
  if (name.endsWith('-interrupted-after-persisted-files')) {
    return {
      ...base,
      maximum: codeGraphHeavyTailEligibleFiles(CODE_GRAPH_HEAVY_TAIL_PROFILE),
      minimum: CODE_GRAPH_HEAVY_TAIL_PROFILE.interruptAfterPersistedFiles,
    };
  }
  if (name === 'resumed-reused-files') {
    return {
      ...base,
      maximum: codeGraphHeavyTailEligibleFiles(CODE_GRAPH_HEAVY_TAIL_PROFILE),
      minimum: CODE_GRAPH_HEAVY_TAIL_PROFILE.interruptAfterPersistedFiles,
    };
  }
  if (name.endsWith('-reused-files')) {
    return {...base, maximum, minimum};
  }
  if (name === 'interrupted-cache-files') {
    return {
      ...base,
      maximum: codeGraphHeavyTailEligibleFiles(CODE_GRAPH_HEAVY_TAIL_PROFILE),
      minimum: CODE_GRAPH_HEAVY_TAIL_PROFILE.interruptAfterPersistedFiles,
    };
  }
  if (name.endsWith('-extraction-peak-concurrency') && scheduleDependentResume) {
    return {...base, maximum};
  }
  if (name.endsWith('-extraction-peak-concurrency') || deterministicHeavyTailMeasurement(name)) {
    return {...base, maximum, minimum};
  }
  if (unit === 'bytes' && name.endsWith('-source-bytes')) return {...base, maximum, minimum};
  if (unit === 'milliseconds') {
    return {
      ...base,
      p95Maximum:
        maximum === 0
          ? 0
          : Math.ceil(
              Math.max(
                maximum * (1 + HEAVY_TAIL_RATCHET_RELATIVE_HEADROOM),
                maximum + HEAVY_TAIL_RATCHET_MILLISECOND_NOISE_HEADROOM,
              ),
            ),
    };
  }
  if (unit === 'bytes') {
    return {...base, p95Maximum: Math.ceil(maximum * (1 + HEAVY_TAIL_RATCHET_RELATIVE_HEADROOM))};
  }
  return {...base, maximum: Math.ceil(maximum * 1.05)};
}

function deterministicHeavyTailMeasurement(name: string): boolean {
  return (
    name.includes('-graph-') ||
    name.endsWith('-cache-files') ||
    name.endsWith('-cache-low-signal-json-facts-bytes') ||
    name.endsWith('-degraded-files') ||
    name.endsWith('-files') ||
    name.endsWith('-relations') ||
    name.endsWith('-symbols')
  );
}

function floorThreshold(value: number): number {
  return Math.floor(value * 1_000) / 1_000;
}

function heavyTailRunMeasurements(
  name: string,
  run: HeavyTailChildRun,
  includeLanguageTelemetry: boolean,
): ReturnType<typeof benchmarkMeasurement>[] {
  const measurements = [
    benchmarkMeasurement(`${name}-duration`, 'milliseconds', [run.durationMilliseconds]),
    benchmarkMeasurement(`${name}-cpu`, 'milliseconds', [run.cpuMilliseconds]),
    benchmarkMeasurement(`${name}-peak-rss`, 'bytes', [run.peakRssBytes]),
    benchmarkMeasurement(`${name}-reading`, 'milliseconds', [run.readingMilliseconds]),
    benchmarkMeasurement(`${name}-extraction-active-wall`, 'milliseconds', [run.extraction.activeWallMilliseconds]),
    benchmarkMeasurement(`${name}-extraction-average-concurrency`, 'count', [run.extraction.averageConcurrency]),
    benchmarkMeasurement(`${name}-extraction-peak-concurrency`, 'count', [run.extraction.peakConcurrency]),
    benchmarkMeasurement(`${name}-extraction-request`, 'milliseconds', [run.extraction.requestMilliseconds]),
    benchmarkMeasurement(`${name}-cache-files`, 'count', [run.cache.files]),
    benchmarkMeasurement(`${name}-cache-facts-bytes`, 'bytes', [run.cache.factsBytes]),
    benchmarkMeasurement(`${name}-cache-low-signal-json-facts-bytes`, 'bytes', [run.cache.lowSignalJsonFactsBytes]),
  ];
  if (run.interruptedAfterPersistedFiles !== undefined) {
    measurements.push(
      benchmarkMeasurement(`${name}-interrupted-after-persisted-files`, 'count', [run.interruptedAfterPersistedFiles]),
    );
  }
  if (run.reusedFiles !== undefined) {
    measurements.push(benchmarkMeasurement(`${name}-reused-files`, 'count', [run.reusedFiles]));
  }
  const languages = includeLanguageTelemetry ? Object.entries(run.languages) : [];
  for (const [language, telemetry] of languages.sort(([left], [right]) => left.localeCompare(right))) {
    const prefix = `${name}-language-${language}`;
    measurements.push(
      benchmarkMeasurement(`${prefix}-degraded-files`, 'count', [telemetry.degradedFiles]),
      benchmarkMeasurement(`${prefix}-facts-bytes`, 'bytes', [telemetry.factsBytes]),
      benchmarkMeasurement(`${prefix}-files`, 'count', [telemetry.files]),
      benchmarkMeasurement(`${prefix}-parse`, 'milliseconds', [telemetry.parseMilliseconds]),
      benchmarkMeasurement(`${prefix}-persistence`, 'milliseconds', [telemetry.persistenceMilliseconds]),
      benchmarkMeasurement(`${prefix}-request`, 'milliseconds', [telemetry.requestMilliseconds]),
      benchmarkMeasurement(`${prefix}-relations`, 'count', [telemetry.relations]),
      benchmarkMeasurement(`${prefix}-source-bytes`, 'bytes', [telemetry.sourceBytes]),
      benchmarkMeasurement(`${prefix}-symbols`, 'count', [telemetry.symbols]),
    );
  }
  if (run.graph !== undefined) {
    measurements.push(
      benchmarkMeasurement(`${name}-graph-edges`, 'count', [run.graph.edges]),
      benchmarkMeasurement(`${name}-graph-files`, 'count', [run.graph.files]),
      benchmarkMeasurement(`${name}-graph-generated-tail-preserved`, 'count', [
        run.graph.generatedTypeScriptTailPreserved ? 1 : 0,
      ]),
      benchmarkMeasurement(`${name}-graph-low-signal-json-symbols`, 'count', [run.graph.lowSignalJsonSymbols]),
      benchmarkMeasurement(`${name}-graph-pathological-typescript-tails`, 'count', [
        run.graph.pathologicalTypeScriptTails,
      ]),
      benchmarkMeasurement(`${name}-graph-symbols`, 'count', [run.graph.symbols]),
      benchmarkMeasurement(`${name}-graph-textless-svg-symbols`, 'count', [run.graph.textlessSvgSymbols]),
    );
  }
  return measurements;
}

function nonNegativePercentReduction(baseline: number, candidate: number): number {
  return Math.max(0, percentage(baseline - candidate, baseline));
}

function percentage(numerator: number, denominator: number): number {
  return denominator <= 0 ? 0 : (numerator / denominator) * 100;
}

const runChild = Effect.fn('benchmarkCodeGraphHeavyTail.child')(function* (args: CodeGraphHeavyTailBenchmarkArguments) {
  const outputPath = required(args.outputPath, '--output');
  const repository = required(args.repository, '--repository');
  const home = required(args.home, '--home');
  const profilePath = required(args.profilePath, '--profile-file');
  const workerCount = args.workers ?? 1;
  parseCodeGraphHeavyTailProfile(yield* readJsonFile(profilePath));
  const path = yield* Path.Path;
  const indexer = yield* CodeGraphIndexer;
  const store = yield* CodeGraphStore;
  const identity = yield* resolveRepositoryIdentity(repository);
  const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
  const progress = new HeavyTailProgressTelemetry();
  const startedAt = process.hrtime.bigint();
  const startedCpu = process.cpuUsage();
  let interruptedAfterPersistedFiles: number | undefined;
  const exit = yield* Effect.exit(
    indexer.index({
      cwd: repository,
      onProgress: event =>
        Effect.sync(() => {
          progress.observe(event);
          if (
            args.interruptAfterPersistedFiles !== undefined &&
            event.phase === 'scanning' &&
            event.activity?.stage === 'persisting' &&
            event.activity.persistMilliseconds !== undefined
          ) {
            const persisted = progress.persistedFiles;
            if (persisted >= args.interruptAfterPersistedFiles) {
              interruptedAfterPersistedFiles = persisted;
              return true;
            }
          }
          return false;
        }).pipe(
          Effect.flatMap(shouldInterrupt =>
            shouldInterrupt
              ? Effect.fail(ScriptError.make({message: 'Expected heavy-tail benchmark interruption.'}))
              : Effect.void,
          ),
        ),
      threadnoteHome: home,
    }),
  );
  const durationMilliseconds = Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND;
  const cpu = process.cpuUsage(startedCpu);
  const cache = databaseCacheTelemetry(layout.databasePath);

  if (Exit.isFailure(exit)) {
    if (interruptedAfterPersistedFiles === undefined) return yield* Effect.failCause(exit.cause);
    const artifact: HeavyTailChildRun = {
      cache,
      cpuMilliseconds: (cpu.user + cpu.system) / 1_000,
      durationMilliseconds,
      extraction: progress.extraction(),
      interruptedAfterPersistedFiles,
      languages: progress.languages(),
      peakRssBytes: processPeakRssBytes(),
      readingMilliseconds: progress.readingMilliseconds,
      slowFiles: progress.slowFiles(),
      state: 'interrupted',
      version: 2,
      workerCount,
    };
    parseHeavyTailChildRun(artifact);
    yield* atomicWrite(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    return;
  }
  if (args.interruptAfterPersistedFiles !== undefined) {
    return yield* ScriptError.make({message: 'The heavy-tail benchmark completed before its requested interruption.'});
  }
  const summary = exit.value;
  const graph = yield* store.loadGraph(layout.databasePath, summary.snapshot.id);
  const graphShape = heavyTailGraphShape(graph);
  const artifact: HeavyTailChildRun = {
    cache,
    cpuMilliseconds: (cpu.user + cpu.system) / 1_000,
    durationMilliseconds,
    extraction: progress.extraction(),
    graph: {
      ...graphShape,
      files: summary.snapshot.fileCount,
    },
    languages: progress.languages(),
    peakRssBytes: processPeakRssBytes(),
    readingMilliseconds: progress.readingMilliseconds,
    reusedFiles: summary.reusedFiles,
    slowFiles: progress.slowFiles(),
    state: 'complete',
    version: 2,
    workerCount,
  };
  parseHeavyTailChildRun(artifact);
  yield* atomicWrite(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
});

class HeavyTailProgressTelemetry {
  readonly #activeExtractions = new Map<string, number>();
  readonly #extractionIntervals: Array<{readonly end: number; readonly start: number}> = [];
  readonly #languages = new Map<string, MutableLanguageTelemetry>();
  readonly #slowFiles: HeavyTailSlowFile[] = [];
  #peakExtractionConcurrency = 0;
  persistedFiles = 0;
  readingMilliseconds = 0;

  observe(progress: CodeGraphProgress): void {
    if (progress.phase !== 'scanning') return;
    this.readingMilliseconds = Math.max(this.readingMilliseconds, progress.timings?.readingMilliseconds ?? 0);
    const activity = progress.activity;
    if (!activity) return;
    const now = performance.now();
    if (activity.stage === 'extracting' && activity.parseMilliseconds === undefined) {
      if (!this.#activeExtractions.has(activity.path)) this.#activeExtractions.set(activity.path, now);
      this.#peakExtractionConcurrency = Math.max(this.#peakExtractionConcurrency, this.#activeExtractions.size);
      return;
    }
    const language = this.#languages.get(activity.language) ?? {
      degradedFiles: 0,
      factsBytes: 0,
      files: 0,
      parseMilliseconds: 0,
      persistenceMilliseconds: 0,
      requestMilliseconds: 0,
      relations: 0,
      sourceBytes: 0,
      symbols: 0,
    };
    this.#languages.set(activity.language, language);
    if (activity.stage === 'extracting' && activity.parseMilliseconds !== undefined) {
      const startedAt = this.#activeExtractions.get(activity.path) ?? now;
      this.#activeExtractions.delete(activity.path);
      const requestMilliseconds = Math.max(0, now - startedAt);
      this.#extractionIntervals.push({end: now, start: startedAt});
      language.files += 1;
      language.factsBytes += activity.factsBytes ?? 0;
      language.sourceBytes += activity.bytes;
      language.parseMilliseconds += activity.parseMilliseconds;
      language.requestMilliseconds += requestMilliseconds;
      language.symbols += activity.symbols ?? 0;
      language.relations += activity.relations ?? 0;
      if (activity.degraded) language.degradedFiles += 1;
      this.#slowFiles.push({
        bytes: activity.bytes,
        factsBytes: activity.factsBytes ?? 0,
        language: activity.language,
        parseMilliseconds: activity.parseMilliseconds,
        path: activity.path,
        requestMilliseconds,
      });
    }
    if (activity.stage === 'persisting' && activity.persistMilliseconds !== undefined) {
      language.persistenceMilliseconds += activity.persistMilliseconds;
      this.persistedFiles += activity.batchCompleted;
    }
  }

  languages(): Readonly<Record<string, HeavyTailLanguageTelemetry>> {
    return Object.fromEntries([...this.#languages.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  extraction(): HeavyTailExtractionUtilization {
    return heavyTailExtractionUtilization(this.#extractionIntervals, this.#peakExtractionConcurrency);
  }

  slowFiles(): readonly HeavyTailSlowFile[] {
    return [...this.#slowFiles]
      .sort((left, right) => right.parseMilliseconds - left.parseMilliseconds || left.path.localeCompare(right.path))
      .slice(0, 10);
  }
}

export function heavyTailExtractionUtilization(
  observations: readonly {readonly end: number; readonly start: number}[],
  peakConcurrency: number,
): HeavyTailExtractionUtilization {
  const intervals = [...observations].sort((left, right) => left.start - right.start || left.end - right.end);
  let activeWallMilliseconds = 0;
  let currentStart: number | undefined;
  let currentEnd: number | undefined;
  for (const interval of intervals) {
    if (currentStart === undefined || currentEnd === undefined) {
      currentStart = interval.start;
      currentEnd = interval.end;
    } else if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
    } else {
      activeWallMilliseconds += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    }
  }
  if (currentStart !== undefined && currentEnd !== undefined) activeWallMilliseconds += currentEnd - currentStart;
  const requestMilliseconds = intervals.reduce((total, interval) => total + (interval.end - interval.start), 0);
  return {
    activeWallMilliseconds,
    averageConcurrency: activeWallMilliseconds === 0 ? 0 : requestMilliseconds / activeWallMilliseconds,
    peakConcurrency,
    requestMilliseconds,
  };
}

interface MutableLanguageTelemetry {
  degradedFiles: number;
  factsBytes: number;
  files: number;
  parseMilliseconds: number;
  persistenceMilliseconds: number;
  requestMilliseconds: number;
  relations: number;
  sourceBytes: number;
  symbols: number;
}

function heavyTailGraphShape(graph: StoredCodeGraph) {
  const canonical = {
    edges: [...graph.edges].sort((left, right) => left.id.localeCompare(right.id)),
    symbols: [...graph.symbols].sort((left, right) => left.id.localeCompare(right.id)),
  };
  return {
    digest: sha256HexSync(JSON.stringify(canonical)),
    edges: graph.edges.length,
    generatedTypeScriptTailPreserved: graph.symbols.some(
      symbol =>
        symbol.path === CODE_GRAPH_HEAVY_TAIL_GENERATED_TYPESCRIPT_PATH && symbol.name === 'GeneratedSurfaceTail',
    ),
    lowSignalJsonSymbols: graph.symbols.filter(symbol => /^test\/__snapshots__\/.*\.snapshot\.json$/.test(symbol.path))
      .length,
    pathologicalTypeScriptTails: graph.symbols.filter(
      symbol => symbol.path.startsWith('src/pathological-') && symbol.name.startsWith('PreservedTail'),
    ).length,
    symbols: graph.symbols.length,
    textlessSvgSymbols: graph.symbols.filter(symbol => /^assets\/icons\/icon-\d+\.svg$/.test(symbol.path)).length,
  } satisfies Omit<NonNullable<HeavyTailChildRun['graph']>, 'files'>;
}

function validateCompletedRun(name: string, run: HeavyTailChildRun, profile: CodeGraphHeavyTailProfile): void {
  if (run.state !== 'complete' || !run.graph)
    throw ScriptError.make({message: `${name} heavy-tail run did not complete.`});
  if (run.graph.lowSignalJsonSymbols !== 0 || run.cache.lowSignalJsonFactsBytes !== 0) {
    throw ScriptError.make({message: `${name} heavy-tail run admitted excluded low-signal JSON.`});
  }
  if (run.graph.pathologicalTypeScriptTails !== profile.pathologicalTypeScriptFiles) {
    throw ScriptError.make({message: `${name} heavy-tail run lost declarations after pathological TypeScript calls.`});
  }
  if (!run.graph.generatedTypeScriptTailPreserved) {
    throw ScriptError.make({
      message: `${name} heavy-tail run lost declarations from generated TypeScript surface extraction.`,
    });
  }
  if (run.graph.textlessSvgSymbols !== 0) {
    throw ScriptError.make({message: `${name} heavy-tail run admitted excluded textless SVG.`});
  }
  if (run.graph.files !== codeGraphHeavyTailEligibleFiles(profile)) {
    throw ScriptError.make({
      message: `${name} heavy-tail run indexed ${run.graph.files} files; expected fixture shape mismatch.`,
    });
  }
  if (Object.values(run.languages).some(language => language.degradedFiles > 0)) {
    throw ScriptError.make({message: `${name} heavy-tail run degraded one or more parser files.`});
  }
}

function databaseCacheTelemetry(databasePath: string): HeavyTailChildRun['cache'] {
  const database = new Database(databasePath, {readonly: true});
  try {
    const total = database
      .query('SELECT COUNT(*) AS files, COALESCE(SUM(length(facts_json)), 0) AS factsBytes FROM file_blobs')
      .get() as {readonly factsBytes: number; readonly files: number};
    const json = database
      .query(
        "SELECT COALESCE(SUM(length(facts_json)), 0) AS factsBytes FROM file_blobs WHERE path_hint LIKE 'test/__snapshots__/%'",
      )
      .get() as {readonly factsBytes: number};
    return {
      factsBytes: Number(total.factsBytes),
      files: Number(total.files),
      lowSignalJsonFactsBytes: Number(json.factsBytes),
    };
  } finally {
    database.close();
  }
}

const spawnChild = Effect.fn('benchmarkCodeGraphHeavyTail.spawnChild')(function* (options: {
  readonly childScript: string;
  readonly home: string;
  readonly interruptAfterPersistedFiles?: number;
  readonly name: string;
  readonly profilePath: string;
  readonly repository: string;
  readonly root: string;
  readonly workers: number;
}) {
  const path = yield* Path.Path;
  const outputPath = path.join(options.root, `${options.name}.json`);
  const command = [
    process.execPath,
    options.childScript,
    '--child',
    '--repository',
    options.repository,
    '--home',
    options.home,
    '--profile-file',
    options.profilePath,
    '--workers',
    String(options.workers),
    '--output',
    outputPath,
  ];
  if (options.interruptAfterPersistedFiles !== undefined) {
    command.push('--interrupt-after-files', String(options.interruptAfterPersistedFiles));
  }
  const child = Bun.spawn({
    cmd: command,
    env: {...(yield* SystemInfo).environment(), THREADNOTE_CODE_GRAPH_PARSER_WORKERS: String(options.workers)},
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [exitCode, stdout, stderr] = yield* Effect.promise(() =>
    Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
  );
  if (exitCode !== 0) {
    return yield* ScriptError.make({
      message:
        `${options.name} heavy-tail child exited with ${exitCode}.\n` +
        boundedOutput('stdout', stdout) +
        boundedOutput('stderr', stderr),
    });
  }
  return parseHeavyTailChildRun(yield* readJsonFile(outputPath));
});

export function parseHeavyTailChildRun(value: unknown): HeavyTailChildRun {
  if (typeof value !== 'object' || value === null)
    throw ScriptError.make({message: 'Heavy-tail child artifact must be an object.'});
  const artifact = value as Partial<HeavyTailChildRun>;
  if (
    artifact.version !== 2 ||
    !['complete', 'interrupted'].includes(artifact.state ?? '') ||
    !positiveInteger(artifact.workerCount) ||
    !nonNegativeNumber(artifact.durationMilliseconds) ||
    !nonNegativeNumber(artifact.cpuMilliseconds) ||
    !nonNegativeInteger(artifact.peakRssBytes) ||
    !nonNegativeNumber(artifact.readingMilliseconds) ||
    typeof artifact.cache !== 'object' ||
    artifact.cache === null ||
    !nonNegativeInteger(artifact.cache.files) ||
    !nonNegativeInteger(artifact.cache.factsBytes) ||
    !nonNegativeInteger(artifact.cache.lowSignalJsonFactsBytes) ||
    !validExtractionUtilization(artifact.extraction, Number(artifact.workerCount)) ||
    typeof artifact.languages !== 'object' ||
    artifact.languages === null ||
    Object.values(artifact.languages).some(language => !validLanguageTelemetry(language)) ||
    (artifact.graph !== undefined && !validHeavyTailGraphShape(artifact.graph)) ||
    !Array.isArray(artifact.slowFiles) ||
    artifact.slowFiles.some(file => !validSlowFile(file))
  ) {
    throw ScriptError.make({message: 'Heavy-tail child artifact is invalid.'});
  }
  if (artifact.state === 'complete' && artifact.graph === undefined) {
    throw ScriptError.make({message: 'Completed heavy-tail child artifact must include a graph shape.'});
  }
  if (artifact.state === 'interrupted' && !positiveInteger(artifact.interruptedAfterPersistedFiles)) {
    throw ScriptError.make({
      message: 'Interrupted heavy-tail child artifact must include its durable interruption point.',
    });
  }
  if (artifact.state === 'interrupted' && artifact.interruptedAfterPersistedFiles !== artifact.cache.files) {
    throw ScriptError.make({
      message: 'Interrupted heavy-tail child artifact has inconsistent durable cache accounting.',
    });
  }
  return artifact as HeavyTailChildRun;
}

export function parseCodeGraphHeavyTailBenchmarkArtifact(value: unknown): AnyCodeGraphHeavyTailBenchmarkArtifact {
  if (typeof value !== 'object' || value === null)
    throw ScriptError.make({message: 'Heavy-tail benchmark artifact must be an object.'});
  const artifact = value as Partial<AnyCodeGraphHeavyTailBenchmarkArtifact>;
  if (
    (artifact.version !== 2 && artifact.version !== 3) ||
    artifact.suite !== 'code-graph-large-monorepo-heavy-tail-v2' ||
    typeof artifact.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(artifact.createdAt)) ||
    typeof artifact.runs !== 'object' ||
    artifact.runs === null
  ) {
    throw ScriptError.make({message: 'Heavy-tail benchmark artifact is invalid.'});
  }
  if (
    artifact.evidenceClass !== undefined &&
    artifact.evidenceClass !== 'correctness-only' &&
    artifact.evidenceClass !== 'governed-performance'
  ) {
    throw ScriptError.make({message: 'Heavy-tail benchmark artifact has an invalid evidence class.'});
  }
  parseCodeGraphHeavyTailProfile(artifact.profile);
  parseHeavyTailChildRun(artifact.runs.single);
  parseHeavyTailChildRun(artifact.runs.parallel);
  parseHeavyTailChildRun(artifact.runs.sixWorkers);
  parseHeavyTailChildRun(artifact.runs.eightWorkers);
  parseHeavyTailChildRun(artifact.runs.interrupted);
  parseHeavyTailChildRun(artifact.runs.resumed);
  if (artifact.version === 3) {
    const ratchetArtifact = parseBenchmarkArtifactV1(artifact.ratchetArtifact);
    if (
      ratchetArtifact.suite !== 'threadnote-code-graph-heavy-tail' ||
      ratchetArtifact.environment.commit !== artifact.environment?.commit ||
      (artifact.evidenceClass !== undefined && ratchetArtifact.metadata.evidenceClass !== artifact.evidenceClass)
    ) {
      throw ScriptError.make({message: 'Heavy-tail benchmark ratchet artifact is inconsistent.'});
    }
  }
  return artifact as AnyCodeGraphHeavyTailBenchmarkArtifact;
}

export function parseCodeGraphHeavyTailReleaseEvidence(value: unknown): CodeGraphHeavyTailBenchmarkArtifact {
  const artifact = parseCodeGraphHeavyTailBenchmarkArtifact(value);
  if (artifact.version !== 3 || artifact.evidenceClass !== 'governed-performance') {
    throw ScriptError.make({message: 'Heavy-tail release evidence requires a governed version 3 artifact.'});
  }
  if (
    typeof artifact.assertions !== 'object' ||
    artifact.assertions === null ||
    Array.isArray(artifact.assertions) ||
    typeof artifact.environment !== 'object' ||
    artifact.environment === null ||
    Array.isArray(artifact.environment)
  ) {
    throw ScriptError.make({message: 'Heavy-tail release evidence requires outer assertions and environment.'});
  }
  const assertions = replayHeavyTailAssertions(artifact);
  if (
    canonicalJson(artifact.assertions) !== canonicalJson(assertions) ||
    Object.values(assertions).some(value => !value)
  ) {
    throw ScriptError.make({message: 'Heavy-tail release evidence requires every outer correctness assertion.'});
  }
  const environment = artifact.environment;
  const storage = environment.storage;
  const provenance = environment.provenance;
  if (
    !nonEmptyString(environment.architecture) ||
    !nonEmptyString(environment.cpu) ||
    !nonEmptyString(environment.operatingSystem) ||
    !nonEmptyString(environment.runtime) ||
    !nonEmptyString(environment.runnerClass) ||
    !nonEmptyString(environment.runnerIdentity) ||
    !/^[0-9a-f]{40}$/u.test(environment.commit) ||
    environment.dirty ||
    !positiveInteger(environment.memoryBytes) ||
    !positiveInteger(environment.availableBytes) ||
    !positiveInteger(environment.minimumFreeBytes) ||
    environment.availableBytes < environment.minimumFreeBytes ||
    storage === undefined ||
    !nonEmptyString(storage.filesystem) ||
    storage.filesystem === 'unknown' ||
    storage.medium !== 'solid-state' ||
    !['internal', 'external'].includes(storage.location) ||
    !validManagedRuntimeProvenance(provenance, environment)
  ) {
    throw ScriptError.make({message: 'Heavy-tail release evidence has incomplete outer environment or provenance.'});
  }
  const standard = parseBenchmarkArtifactV1(artifact.ratchetArtifact);
  const {ratchetArtifact: _ratchetArtifact, ...outer} = artifact;
  const replayed = codeGraphHeavyTailRatchetArtifact(
    {...outer, assertions},
    managedRuntimePlatform(provenance.target)!,
    {
      availableBytes: environment.availableBytes,
      minimumFreeBytes: environment.minimumFreeBytes,
      runtimeProvenance: provenance,
      storage,
    },
  );
  if (canonicalJson(standard) !== canonicalJson(replayed)) {
    throw ScriptError.make({message: 'Heavy-tail release evidence outer and embedded contracts are inconsistent.'});
  }
  return artifact;
}

function replayHeavyTailAssertions(
  artifact: CodeGraphHeavyTailBenchmarkArtifact,
): CodeGraphHeavyTailBenchmarkArtifact['assertions'] {
  const {eightWorkers, interrupted, parallel, resumed, single, sixWorkers} = artifact.runs;
  const completed = [single, parallel, sixWorkers, eightWorkers, resumed] as const;
  for (const [name, run] of [
    ['single-worker', single],
    ['parallel', parallel],
    ['six-worker', sixWorkers],
    ['eight-worker', eightWorkers],
    ['resumed', resumed],
  ] as const) {
    validateCompletedRun(name, run, artifact.profile);
  }
  return {
    eightWorkersMatchSingle: single.graph!.digest === eightWorkers.graph!.digest,
    interruptionRetainedCache: interrupted.state === 'interrupted' && interrupted.cache.files > 0,
    lowSignalJsonExcluded: completed.every(
      run => run.graph!.lowSignalJsonSymbols === 0 && run.cache.lowSignalJsonFactsBytes === 0,
    ),
    parallelMatchesSingle: single.graph!.digest === parallel.graph!.digest,
    pathologicalTypeScriptSurfacePreserved: completed.every(
      run => run.graph!.pathologicalTypeScriptTails === artifact.profile.pathologicalTypeScriptFiles,
    ),
    resumeMatchesClean: single.graph!.digest === resumed.graph!.digest,
    resumeReusedCache: (resumed.reusedFiles ?? 0) > 0,
    sixWorkersMatchSingle: single.graph!.digest === sixWorkers.graph!.digest,
    textlessSvgExcluded: completed.every(run => run.graph!.textlessSvgSymbols === 0),
  } as CodeGraphHeavyTailBenchmarkArtifact['assertions'];
}

function validManagedRuntimeProvenance(
  value: BenchmarkRuntimeProvenance | undefined,
  environment: CodeGraphHeavyTailBenchmarkArtifact['environment'],
): value is Extract<BenchmarkRuntimeProvenance, {readonly mode: 'managed-exact-head'}> {
  if (value?.mode !== 'managed-exact-head') return false;
  const hashes = [
    value.executableSha256,
    value.payloadManifestSha256,
    value.releaseMetadataSha256,
    value.sourceLockfileSha256,
    value.sourcePackageManifestSha256,
  ];
  return (
    value.dependencyInstallation === 'bun install --frozen-lockfile' &&
    value.processLeaseInspection === 'complete' &&
    value.sourceCommit === environment.commit &&
    environment.runtime.startsWith('bun/') &&
    value.runtime === environment.runtime.replace(/^bun\//u, 'bun-') &&
    hashes.every(hash => /^[0-9a-f]{64}$/u.test(hash)) &&
    positiveInteger(value.payloadBytes) &&
    positiveInteger(value.payloadFileCount) &&
    nonEmptyString(value.target) &&
    managedRuntimePlatform(value.target) !== undefined &&
    value.target.split('-')[2] === environment.architecture &&
    nonEmptyString(value.version)
  );
}

function managedRuntimePlatform(target: string): string | undefined {
  const match = /^bun-(darwin|linux|windows)-(arm64|x64)(-musl)?(-baseline)?$/u.exec(target);
  if (
    match === null ||
    (match[3] !== undefined && match[1] !== 'linux') ||
    (match[4] !== undefined) !== (match[2] === 'x64' && match[1] !== 'darwin')
  )
    return undefined;
  return match[1] === 'windows' ? 'win32' : match[1];
}

export function parseCodeGraphHeavyTailBenchmarkArguments(
  args: readonly string[],
): CodeGraphHeavyTailBenchmarkArguments {
  let child = false;
  let candidateCommit: string | undefined;
  let evidenceClass: HeavyTailEvidenceClass | undefined;
  let governed = false;
  let home: string | undefined;
  let interruptAfterPersistedFiles: number | undefined;
  let minimumFreeGiB = 120;
  let outputPath: string | undefined;
  let profilePath: string | undefined;
  let ratchetPath: string | undefined;
  let repository: string | undefined;
  let smoke = false;
  let workers: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--child') child = true;
    else if (argument === '--candidate-commit') candidateCommit = required(args[++index], argument);
    else if (argument === '--evidence-class') {
      const value = required(args[++index], argument);
      if (value !== 'correctness-only' && value !== 'governed-performance') {
        throw ScriptError.make({message: '--evidence-class must be correctness-only or governed-performance.'});
      }
      evidenceClass = value;
    } else if (argument === '--governed') governed = true;
    else if (argument === '--home') home = required(args[++index], argument);
    else if (argument === '--interrupt-after-files') {
      interruptAfterPersistedFiles = integer(args[++index], argument, 1);
    } else if (argument === '--minimum-free-gib') minimumFreeGiB = integer(args[++index], argument, 1);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--profile-file') profilePath = required(args[++index], argument);
    else if (argument === '--ratchet') ratchetPath = required(args[++index], argument);
    else if (argument === '--repository') repository = required(args[++index], argument);
    else if (argument === '--smoke') smoke = true;
    else if (argument === '--workers') workers = integer(args[++index], argument, 1, 8);
    else throw ScriptError.make({message: `Unknown heavy-tail benchmark option: ${argument}`});
  }
  if (
    child &&
    (candidateCommit !== undefined ||
      evidenceClass !== undefined ||
      governed ||
      minimumFreeGiB !== 120 ||
      ratchetPath !== undefined ||
      smoke)
  ) {
    throw ScriptError.make({message: 'Parent-only heavy-tail benchmark options cannot be used with --child.'});
  }
  if (
    !child &&
    [home, profilePath, repository, workers, interruptAfterPersistedFiles].some(value => value !== undefined)
  ) {
    throw ScriptError.make({message: 'Child-only heavy-tail benchmark options require --child.'});
  }
  if (governed && minimumFreeGiB < 120) {
    throw ScriptError.make({message: '--governed requires --minimum-free-gib of at least 120.'});
  }
  if (candidateCommit !== undefined && !/^[0-9a-f]{40}$/u.test(candidateCommit)) {
    throw ScriptError.make({message: '--candidate-commit requires a 40-character lowercase SHA.'});
  }
  if (candidateCommit !== undefined && !governed) {
    throw ScriptError.make({message: '--candidate-commit requires --governed release evidence.'});
  }
  if (candidateCommit !== undefined && ratchetPath === undefined) {
    throw ScriptError.make({message: '--candidate-commit requires --ratchet with the checked heavy-tail thresholds.'});
  }
  if (governed && outputPath === undefined) {
    throw ScriptError.make({message: '--governed requires --output so exact evidence is retained.'});
  }
  if (governed && smoke) throw ScriptError.make({message: '--governed cannot be combined with --smoke.'});
  if (evidenceClass === 'governed-performance' && !governed) {
    throw ScriptError.make({message: 'governed-performance evidence requires --governed.'});
  }
  if (governed && evidenceClass === 'correctness-only') {
    throw ScriptError.make({message: 'Governed heavy-tail evidence cannot be correctness-only.'});
  }
  if (ratchetPath !== undefined && (!governed || outputPath === undefined)) {
    throw ScriptError.make({message: '--ratchet requires --governed and --output.'});
  }
  if (ratchetPath !== undefined && evidenceClass === 'correctness-only') {
    throw ScriptError.make({message: 'Correctness-only heavy-tail evidence cannot enforce a performance ratchet.'});
  }
  return {
    child,
    candidateCommit,
    evidenceClass: evidenceClass ?? (governed ? 'governed-performance' : 'correctness-only'),
    governed,
    home,
    interruptAfterPersistedFiles,
    minimumFreeGiB,
    outputPath,
    profilePath,
    ratchetPath,
    repository,
    smoke,
    workers,
  };
}

function integer(
  value: string | undefined,
  option: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number.parseInt(required(value, option), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw ScriptError.make({message: `${option} must be between ${minimum} and ${maximum}.`});
  }
  return parsed;
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

function usage(): string {
  return [
    'Usage: bun run bench:code-graph:heavy-tail -- [options]',
    '',
    'Runs the code-graph heavy-tail benchmark and optionally retains governed release evidence.',
    'Parent options: --smoke --governed --output <json> --ratchet <json>',
    '  --candidate-commit <40-hex> --evidence-class <correctness-only|governed-performance>',
    '  --minimum-free-gib <count>',
    'Child options: --child --repository <path> --home <path> --profile-file <json> --output <json>',
    '  --workers <1-8> --interrupt-after-files <count>',
  ].join('\n');
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validExtractionUtilization(value: unknown, workerCount: number): value is HeavyTailExtractionUtilization {
  if (typeof value !== 'object' || value === null) return false;
  const extraction = value as Partial<HeavyTailExtractionUtilization>;
  return (
    nonNegativeNumber(extraction.activeWallMilliseconds) &&
    nonNegativeNumber(extraction.averageConcurrency) &&
    nonNegativeInteger(extraction.peakConcurrency) &&
    nonNegativeNumber(extraction.requestMilliseconds) &&
    extraction.averageConcurrency <= workerCount + HEAVY_TAIL_NUMERIC_EPSILON &&
    extraction.peakConcurrency <= workerCount &&
    extraction.requestMilliseconds + HEAVY_TAIL_NUMERIC_EPSILON >= extraction.activeWallMilliseconds
  );
}

function validHeavyTailGraphShape(value: unknown): value is NonNullable<HeavyTailChildRun['graph']> {
  if (typeof value !== 'object' || value === null) return false;
  const graph = value as Partial<NonNullable<HeavyTailChildRun['graph']>>;
  return (
    typeof graph.digest === 'string' &&
    /^[0-9a-f]{64}$/u.test(graph.digest) &&
    nonNegativeInteger(graph.edges) &&
    nonNegativeInteger(graph.files) &&
    typeof graph.generatedTypeScriptTailPreserved === 'boolean' &&
    nonNegativeInteger(graph.lowSignalJsonSymbols) &&
    nonNegativeInteger(graph.pathologicalTypeScriptTails) &&
    nonNegativeInteger(graph.symbols) &&
    nonNegativeInteger(graph.textlessSvgSymbols)
  );
}

function validLanguageTelemetry(value: unknown): value is HeavyTailLanguageTelemetry {
  if (typeof value !== 'object' || value === null) return false;
  const language = value as Partial<HeavyTailLanguageTelemetry>;
  return (
    nonNegativeInteger(language.degradedFiles) &&
    nonNegativeInteger(language.factsBytes) &&
    nonNegativeInteger(language.files) &&
    nonNegativeNumber(language.parseMilliseconds) &&
    nonNegativeNumber(language.persistenceMilliseconds) &&
    nonNegativeNumber(language.requestMilliseconds) &&
    nonNegativeInteger(language.relations) &&
    nonNegativeInteger(language.sourceBytes) &&
    nonNegativeInteger(language.symbols) &&
    language.degradedFiles <= language.files &&
    language.requestMilliseconds + HEAVY_TAIL_NUMERIC_EPSILON >= language.parseMilliseconds
  );
}

function validSlowFile(value: unknown): value is HeavyTailSlowFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<HeavyTailSlowFile>;
  return (
    nonNegativeInteger(file.bytes) &&
    nonNegativeInteger(file.factsBytes) &&
    typeof file.language === 'string' &&
    nonNegativeNumber(file.parseMilliseconds) &&
    typeof file.path === 'string' &&
    nonNegativeNumber(file.requestMilliseconds) &&
    file.requestMilliseconds + HEAVY_TAIL_NUMERIC_EPSILON >= file.parseMilliseconds
  );
}

function boundedOutput(label: string, output: string): string {
  if (!output) return '';
  const bytes = new TextEncoder().encode(output);
  const bounded =
    bytes.byteLength <= CHILD_OUTPUT_LIMIT_BYTES
      ? output
      : new TextDecoder().decode(bytes.slice(bytes.byteLength - CHILD_OUTPUT_LIMIT_BYTES));
  return `${label}:\n${bounded}\n`;
}

function processPeakRssBytes(): number {
  const maxRss = process.resourceUsage().maxRSS;
  const runtime: ProcessResourceUsageRuntime = 'bun' in process.versions ? 'bun' : 'node';
  return processResourceUsageMaxRssBytes(maxRss, process.platform, runtime);
}

const git = Effect.fn('benchmarkCodeGraphHeavyTail.git')((cwd: string, args: readonly string[]) =>
  runCommandEffect('git', ['-C', cwd, ...args], {maxOutputBytes: 1_048_576, timeoutMs: 30_000}).pipe(
    Effect.map(result => result.stdout.trim()),
  ),
);

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(benchmark, ApplicationLayer));
