import {Array as EffectArray} from 'effect';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Clock, DateTime, Effect, FileSystem, Option, Path} from 'effect';
import {
  observationFromCodeGraphStatus,
  CodeGraphQueryService,
  QUERY_SEMANTIC_TIME_BUDGET_MILLISECONDS,
  QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS,
  type CodeGraphInspectOptions,
} from '@threadnote/graph/query';
import type {
  CodeGraphQueryTelemetryObserver,
  CodeGraphQueryTelemetryPhase,
  CodeGraphQueryTelemetryStage,
  CodeGraphStatusOptions,
} from '@threadnote/graph/query/contract';
import {
  CODE_GRAPH_EXTRACTOR_SET_VERSION,
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CODE_GRAPH_RESULT_VERSION,
  CODE_GRAPH_SCHEMA_VERSION,
  type CodeGraphQueryResult,
  type CodeGraphStatus,
} from '@threadnote/graph/types';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256Hex} from '@threadnote/platform/digest';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runtimeHostHardwareInfo, SystemInfo} from '@threadnote/platform/system';
import {diagnoseCodeGraphDatabaseReadOnly} from '@threadnote/graph/store/health';
import {
  awaitCodeGraphWorktreeBuilds,
  withCodeGraphMaintenanceIntent,
  withCodeGraphMaintenanceRegistration,
} from '@threadnote/graph/maintenance/gate';
import {codeGraphRepositoryLockPath} from '@threadnote/graph/layout';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {
  READY_QUERY_CONTROLS,
  READY_QUERY_EVIDENCE_SUITE,
  READY_QUERY_EVIDENCE_VERSION,
  READY_QUERY_DEFERRED_TIMEOUT_MILLISECONDS,
  READY_QUERY_EXACT_TIMEOUT_MILLISECONDS,
  READY_QUERY_FIXED_RATE_INTERVAL_MILLISECONDS,
  READY_QUERY_ENVIRONMENT_ATTESTATION,
  READY_QUERY_GITHUB_ENVIRONMENT,
  READY_QUERY_GITHUB_EVENT,
  READY_QUERY_GITHUB_JOB,
  READY_QUERY_GITHUB_REF,
  READY_QUERY_GITHUB_REPOSITORY_ID,
  READY_QUERY_MINIMUM_FILES,
  READY_QUERY_LOGICAL_CPU_MINIMUM,
  READY_QUERY_MINIMUM_SAMPLES,
  READY_QUERY_MINIMUM_WARMUPS,
  READY_QUERY_REPOSITORY,
  READY_QUERY_REPOSITORY_COMMIT,
  READY_QUERY_REPOSITORY_TREE,
  isReadyQueryGitHubRepository,
  parseReadyQueryEvidenceV1,
  readyQueryGitHubWorkflowRef,
  type ReadyQueryControlEvidenceV1,
  type ReadyQueryEvidenceV1,
  type ReadyQueryStageDisposition,
  type ReadyQueryStageSeriesV1,
  type ReadyQueryTimingSeriesV1,
} from '@threadnote/threadnote/evaluation/ready/query_evidence';
import {
  readReadyQueryLinuxHostSample,
  readyQueryHostEvidence,
  type ReadyQueryLinuxHostSample,
} from '@threadnote/threadnote/evaluation/ready/query_host';
import {codeGraphMcpResponse} from '@threadnote/threadnote/mcp/server/code_graph';
import {
  publicGitHubRepositoryEvidence,
  revalidateExternalBenchmarkPreflightState,
  validateBenchmarkRuntimeProvenance,
  verifyPublicRepositoryCommit,
  type BenchmarkRuntimeProvenance,
} from './benchmark-code-graph.js';
import {atomicWrite, printJson, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1_048_576;
const READY_QUERY_REQUEST_PROFILE = {
  deferredTimeoutMilliseconds: READY_QUERY_DEFERRED_TIMEOUT_MILLISECONDS,
  depth: 1,
  edgeLimit: 40,
  exactTimeoutMilliseconds: READY_QUERY_EXACT_TIMEOUT_MILLISECONDS,
  includeHeuristic: false,
  includeModelAssociations: false,
  nodeLimit: 20,
  operation: 'query',
  semanticBudgetMilliseconds: QUERY_SEMANTIC_TIME_BUDGET_MILLISECONDS,
  semanticPolicy: 'runtime-available-lexical-first',
  traversalBudgetMilliseconds: QUERY_TRAVERSAL_TIME_BUDGET_MILLISECONDS,
} as const satisfies ReadyQueryEvidenceV1['requestProfile'];
const CONFIG_NEUTRAL_STATUS_ARGUMENTS = [
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

export interface ReadyQueryBenchmarkOptions {
  readonly home: string;
  readonly output: string;
  readonly preflight: boolean;
  readonly quiet: boolean;
  readonly repository: string;
}

interface ReadyQueryPreflightEvidence {
  readonly contract: typeof READY_QUERY_EVIDENCE_SUITE;
  readonly fixture: ReadyQueryEvidenceV1['fixture'];
  readonly kind: 'ready-query-preflight';
  readonly runtime: ReadyQueryEvidenceV1['runtime'];
  readonly snapshot: ReadyQueryEvidenceV1['snapshot'];
  readonly source: {
    readonly clean: true;
    readonly commit: string;
    readonly lockfileSha256: string;
    readonly packageManifestSha256: string;
    readonly validationMode: BenchmarkRuntimeProvenance['mode'];
  };
  readonly state: 'ready';
  readonly version: typeof READY_QUERY_EVIDENCE_VERSION;
}

interface PreparedReadyQueryBenchmark {
  readonly checkoutId: string;
  readonly evidence: ReadyQueryPreflightEvidence;
  readonly home: string;
  readonly output: string;
  readonly repository: string;
  readonly runtimeProvenance: BenchmarkRuntimeProvenance;
  readonly snapshotId: string;
}

interface StaticReadyQueryPreflight {
  readonly checkoutId: string;
  readonly fixture: ReadyQueryPreflightEvidence['fixture'];
  readonly home: string;
  readonly output: string;
  readonly repository: string;
  readonly runtime: ReadyQueryPreflightEvidence['runtime'];
  readonly runtimeProvenance: BenchmarkRuntimeProvenance;
  readonly source: ReadyQueryPreflightEvidence['source'];
}

interface QueryStageEvent {
  readonly disposition: ReadyQueryStageDisposition;
  readonly durationMilliseconds: number;
  readonly phase: CodeGraphQueryTelemetryPhase;
  readonly stage: CodeGraphQueryTelemetryStage;
}

interface ReadyQueryRequestResult {
  readonly digest: string;
  readonly freshness: 'current' | 'deferred';
  readonly matched: boolean;
  readonly serviceMilliseconds: number;
  readonly snapshotDigest: string;
  readonly stages: readonly QueryStageEvent[];
  readonly structuredResponseBytes: number;
  readonly textResponseBytes: number;
}

interface ReadyQueryService {
  readonly inspect: (options: CodeGraphInspectOptions) => Effect.Effect<CodeGraphQueryResult, unknown>;
  readonly status: (
    threadnoteHome: string,
    cwd: string,
    options?: CodeGraphStatusOptions,
  ) => Effect.Effect<CodeGraphStatus, unknown>;
}

export function parseReadyQueryBenchmarkArguments(args: readonly string[]): ReadyQueryBenchmarkOptions {
  let home: string | undefined;
  let output: string | undefined;
  let preflight = false;
  let quiet = false;
  let repository: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--home') home = required(args[++index], argument);
    else if (argument === '--output') output = required(args[++index], argument);
    else if (argument === '--preflight') preflight = true;
    else if (argument === '--quiet') quiet = true;
    else if (argument === '--repository') repository = required(args[++index], argument);
    else throw ScriptError.make({message: `Unknown ready-query benchmark option: ${argument}`});
  }
  if (!home || !output || !repository) {
    throw ScriptError.make({message: 'Ready-query evidence requires --repository, --home, and --output.'});
  }
  return {home, output, preflight, quiet, repository};
}

export const preflightReadyQueryBenchmark = Effect.fn('readyQueryEvidence.preflight')(function* (
  options: ReadyQueryBenchmarkOptions,
  sourceRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const environment = system.environment();
  const hardware = runtimeHostHardwareInfo();
  if (
    system.platform !== 'linux' ||
    system.architecture !== 'x64' ||
    hardware.logicalCpuCount < READY_QUERY_LOGICAL_CPU_MINIMUM ||
    environment.THREADNOTE_READY_QUERY_DEDICATED_RUNNER !== 'true'
  ) {
    return yield* ScriptError.make({
      message: 'Governed ready-query evidence requires the dedicated preprovisioned Linux runner.',
    });
  }
  const [repository, home, runtimeProvenance] = yield* Effect.all(
    [fs.realPath(options.repository), fs.realPath(options.home), validateBenchmarkRuntimeProvenance(sourceRoot)],
    {concurrency: 3},
  );
  const output = yield* canonicalizeProspectivePath(fs, path, options.output);
  if (
    pathIsWithin(path, output, repository) ||
    pathIsWithin(path, output, home) ||
    pathIsWithin(path, home, repository) ||
    pathIsWithin(path, repository, home)
  ) {
    return yield* ScriptError.make({
      message: 'Ready-query repository, ready home, and evidence output must be mutually isolated.',
    });
  }
  const [commit, tree, dirty, origin, trackedFiles] = yield* Effect.all(
    [
      git(repository, ['rev-parse', 'HEAD']).pipe(Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim))),
      git(repository, ['rev-parse', 'HEAD^{tree}']).pipe(
        Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim)),
      ),
      git(repository, CONFIG_NEUTRAL_STATUS_ARGUMENTS).pipe(
        Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim)),
      ),
      git(repository, ['remote', 'get-url', 'origin']).pipe(
        Effect.map(result => Effect2.pipe(result.stdout, EffectString.trim)),
      ),
      trackedFileCount(repository),
    ],
    {concurrency: 5},
  );
  const publicRepository = yield* Effect.try(() => publicGitHubRepositoryEvidence(origin));
  if (
    publicRepository.name !== READY_QUERY_REPOSITORY ||
    commit !== READY_QUERY_REPOSITORY_COMMIT ||
    tree !== READY_QUERY_REPOSITORY_TREE ||
    dirty.length > 0 ||
    trackedFiles < READY_QUERY_MINIMUM_FILES
  ) {
    return yield* ScriptError.make({
      message: 'Ready-query evidence requires the clean pinned >=200k-file IntelliJ fixture.',
    });
  }
  yield* validateTrackedControls(fs, repository);
  const [publicCommitProof, identity] = yield* Effect.all(
    [verifyPublicRepositoryCommit(publicRepository, commit, environment), resolveRepositoryIdentity(repository)],
    {concurrency: 2},
  );
  if (identity.headCommit !== commit) {
    return yield* ScriptError.make({message: 'Ready-query fixture identity changed during static preflight.'});
  }
  const source = {
    clean: true,
    commit: runtimeProvenance.sourceCommit,
    lockfileSha256: runtimeProvenance.sourceLockfileSha256,
    packageManifestSha256: runtimeProvenance.sourcePackageManifestSha256,
    validationMode: runtimeProvenance.mode,
  } satisfies ReadyQueryPreflightEvidence['source'];
  return {
    checkoutId: identity.checkoutId,
    fixture: {
      clean: true,
      commit: READY_QUERY_REPOSITORY_COMMIT,
      publicCommitProof,
      repository: READY_QUERY_REPOSITORY,
      trackedFiles,
      tree,
    },
    home,
    output,
    repository,
    runtime: {
      compatible: true,
      extractorSet: CODE_GRAPH_EXTRACTOR_SET_VERSION,
      persistentExtensionRevision: CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
      resultVersion: CODE_GRAPH_RESULT_VERSION,
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    },
    runtimeProvenance,
    source,
  } satisfies StaticReadyQueryPreflight;
});

export const benchmarkReadyQueryEvidence = Effect.scoped(
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const query = yield* CodeGraphQueryService;
    const system = yield* SystemInfo;
    const options = parseReadyQueryBenchmarkArguments(yield* scriptArguments());
    const sourceRoot = yield* path.fromFileUrl(new URL('..', import.meta.url));
    const staticPreflight = yield* preflightReadyQueryBenchmark(options, sourceRoot);
    yield* withReadyQueryBuilderExclusion(
      staticPreflight.home,
      staticPreflight.checkoutId,
      Effect.gen(function* () {
        const entryStatus = yield* exactReadyStatus(
          query,
          staticPreflight.home,
          staticPreflight.repository,
          'builder-exclusion entry',
        );
        const entryHealth = yield* assertReadyQueryDatabaseHealth(entryStatus);
        const prepared = yield* prepareReadyQuerySnapshot(staticPreflight, entryStatus);
        if (options.preflight) {
          yield* atomicWrite(prepared.output, `${JSON.stringify(prepared.evidence, undefined, 2)}\n`);
          if (!options.quiet) yield* printJson(prepared.evidence);
          return;
        }

        const source = qualifyingReadyQuerySource(prepared.runtimeProvenance, system.environment());
        const primary = READY_QUERY_CONTROLS[0];
        for (let index = 0; index < READY_QUERY_MINIMUM_WARMUPS; index += 1) {
          yield* runReadyQueryRequest(query, prepared, primary, 'exact');
          yield* runReadyQueryRequest(query, prepared, primary, 'deferred');
        }

        const hostSamples: ReadyQueryLinuxHostSample[] = [yield* readReadyQueryLinuxHostSample()];
        const observeHost = readReadyQueryLinuxHostSample().pipe(
          Effect.tap(sample => Effect.sync(() => hostSamples.push(sample))),
          Effect.asVoid,
        );
        const controls: ReadyQueryControlEvidenceV1[] = [];
        for (const control of READY_QUERY_CONTROLS) {
          const exact = yield* runReadyQueryRequest(query, prepared, control, 'exact');
          yield* observeHost;
          const deferred = yield* runReadyQueryRequest(query, prepared, control, 'deferred');
          yield* observeHost;
          if (!exact.matched || !deferred.matched || exact.digest !== deferred.digest) {
            return yield* ScriptError.make({message: `Ready-query control ${control.id} failed digest parity.`});
          }
          controls.push({
            deferredDigest: deferred.digest,
            deferredFreshness: 'deferred',
            deferredStructuredResponseBytes: deferred.structuredResponseBytes,
            deferredTextResponseBytes: deferred.textResponseBytes,
            exactDigest: exact.digest,
            exactFreshness: 'current',
            exactStructuredResponseBytes: exact.structuredResponseBytes,
            exactTextResponseBytes: exact.textResponseBytes,
            expectedMatch: true,
            id: control.id,
            language: control.expectedLanguage,
          });
        }

        const exactResults: ReadyQueryRequestResult[] = [];
        for (let index = 0; index < READY_QUERY_MINIMUM_SAMPLES; index += 1) {
          exactResults.push(yield* runReadyQueryRequest(query, prepared, primary, 'exact'));
          yield* observeHost;
        }
        const deferredResults: ReadyQueryRequestResult[] = [];
        const queueLatencies: number[] = [];
        const scheduleStarted = yield* Clock.currentTimeNanos;
        for (let index = 0; index < READY_QUERY_MINIMUM_SAMPLES; index += 1) {
          const scheduled =
            scheduleStarted +
            BigInt(index * READY_QUERY_FIXED_RATE_INTERVAL_MILLISECONDS) * BigInt(NANOSECONDS_PER_MILLISECOND);
          const beforeWait = yield* Clock.currentTimeNanos;
          if (beforeWait < scheduled) {
            yield* Effect.sleep(Number(scheduled - beforeWait) / NANOSECONDS_PER_MILLISECOND);
          }
          const started = yield* Clock.currentTimeNanos;
          queueLatencies.push(Math.max(0, Number(started - scheduled) / NANOSECONDS_PER_MILLISECOND));
          deferredResults.push(yield* runReadyQueryRequest(query, prepared, primary, 'deferred'));
          yield* observeHost;
        }

        const finalStatus = yield* exactReadyStatus(query, prepared.home, prepared.repository, 'final validation');
        const exitHealth = yield* assertReadyQueryDatabaseHealth(finalStatus);
        yield* assertPreparedSnapshotUnchanged(prepared, finalStatus);
        hostSamples.push(yield* readReadyQueryLinuxHostSample());
        const finalRuntimeProvenance = yield* revalidateExternalBenchmarkPreflightState(
          sourceRoot,
          prepared.repository,
          READY_QUERY_REPOSITORY_COMMIT,
          prepared.runtimeProvenance,
        );
        const finalSource = qualifyingReadyQuerySource(finalRuntimeProvenance, system.environment());
        if (JSON.stringify(finalSource) !== JSON.stringify(source)) {
          return yield* ScriptError.make({message: 'Ready-query GitHub workflow provenance changed during the run.'});
        }
        const artifact = {
          controls,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          fixture: prepared.evidence.fixture,
          host: readyQueryHostEvidence(hostSamples),
          isolation: {
            builderExclusion: 'maintenance-registration-intent-repository-lock-worktree-drain-v1',
            builderExclusionScope: 'inside-status-through-artifact-write',
            buildingSnapshotsAtEntry: entryHealth.buildingSnapshots,
            buildingSnapshotsAtExit: exitHealth.buildingSnapshots,
            databaseWriterLock: 'not-held',
            fullWriterIsolation: 'not-attested',
            storageCapacityIsolation: 'not-attested',
          },
          latencyBoundary: 'composed-status-inspect-serialization',
          measurements: {
            deferred: timingSeries('deferred', deferredResults, queueLatencies),
            exact: timingSeries(
              'exact',
              exactResults,
              EffectArray.map(exactResults, () => 0),
            ),
          },
          requestProfile: READY_QUERY_REQUEST_PROFILE,
          runner: 'dedicated-preprovisioned-linux-x64',
          runtime: prepared.evidence.runtime,
          snapshot: prepared.evidence.snapshot,
          source,
          suite: READY_QUERY_EVIDENCE_SUITE,
          version: READY_QUERY_EVIDENCE_VERSION,
        } satisfies ReadyQueryEvidenceV1;
        parseReadyQueryEvidenceV1(artifact);
        yield* atomicWrite(prepared.output, `${JSON.stringify(artifact)}\n`);
        if (!options.quiet) yield* printJson(artifact);
      }),
    );
  }),
);

const runReadyQueryRequest = Effect.fn('readyQueryEvidence.request')(function* (
  query: ReadyQueryService,
  prepared: PreparedReadyQueryBenchmark,
  control: (typeof READY_QUERY_CONTROLS)[number],
  freshness: 'exact' | 'deferred',
) {
  const stages: QueryStageEvent[] = [];
  const telemetry = queryStageObserver(stages);
  const started = yield* Clock.currentTimeNanos;
  const run = Effect.gen(function* () {
    const status = yield* query.status(prepared.home, prepared.repository, {
      observeWorktree: freshness === 'exact',
      requestMaintenance: false,
      telemetry,
    });
    const result = yield* query.inspect({
      cwd: prepared.repository,
      depth: READY_QUERY_REQUEST_PROFILE.depth,
      edgeLimit: READY_QUERY_REQUEST_PROFILE.edgeLimit,
      includeHeuristic: READY_QUERY_REQUEST_PROFILE.includeHeuristic,
      includeModelAssociations: READY_QUERY_REQUEST_PROFILE.includeModelAssociations,
      nodeLimit: READY_QUERY_REQUEST_PROFILE.nodeLimit,
      operation: READY_QUERY_REQUEST_PROFILE.operation,
      query: control.query,
      refresh: false,
      requestMaintenance: false,
      statusObservation: observationFromCodeGraphStatus(status),
      strictFreshness: false,
      telemetry,
      threadnoteHome: prepared.home,
    });
    const response = yield* telemetry.stage(
      'graph.query.execute',
      'query-serialization',
      Effect.sync(() => codeGraphMcpResponse(result)),
    );
    return {response, result};
  }).pipe(
    Effect.timeoutOrElse({
      duration:
        freshness === 'exact' ? READY_QUERY_EXACT_TIMEOUT_MILLISECONDS : READY_QUERY_DEFERRED_TIMEOUT_MILLISECONDS,
      orElse: () => Effect.fail(ScriptError.make({message: `Ready-query ${freshness} request timed out.`})),
    }),
  );
  const {response, result} = yield* run;
  const serviceMilliseconds = Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND;
  const expectedFreshness = freshness === 'exact' ? 'current' : 'deferred';
  if (
    result.freshness !== expectedFreshness ||
    result.snapshot.id !== prepared.snapshotId ||
    result.snapshot.commit !== READY_QUERY_REPOSITORY_COMMIT ||
    result.nodes.length === 0
  ) {
    return yield* ScriptError.make({message: `Ready-query ${freshness} request lost its snapshot contract.`});
  }
  return {
    digest: yield* queryResultDigest(result),
    freshness: expectedFreshness,
    matched: EffectArray.some(
      result.nodes,
      node => node.path === control.expectedPath && node.language === control.expectedLanguage,
    ),
    serviceMilliseconds,
    snapshotDigest: prepared.evidence.snapshot.idSha256,
    stages,
    structuredResponseBytes: encodedBytes(JSON.stringify(response.structuredContent)),
    textResponseBytes: encodedBytes(response.text),
  } satisfies ReadyQueryRequestResult;
});

function queryStageObserver(events: QueryStageEvent[]): CodeGraphQueryTelemetryObserver {
  return {
    skip: (phase, stage) =>
      Effect.sync(() => {
        events.push({disposition: 'skipped', durationMilliseconds: 0, phase, stage});
      }),
    stage: (phase, stage, effect, disposition) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeNanos;
        const value = yield* effect;
        events.push({
          disposition: disposition ?? 'measured',
          durationMilliseconds: Number((yield* Clock.currentTimeNanos) - started) / NANOSECONDS_PER_MILLISECOND,
          phase,
          stage,
        });
        return value;
      }),
  };
}

function timingSeries(
  kind: 'deferred' | 'exact',
  results: readonly ReadyQueryRequestResult[],
  queueLatencyMilliseconds: readonly number[],
): ReadyQueryTimingSeriesV1 {
  const stageKeys = [
    ['graph.query.status', 'query-repository-identity'],
    ['graph.query.status', 'query-worktree-observation'],
    ['graph.query.execute', 'query-strict-reobservation'],
    ['graph.query.execute', 'query-serialization'],
  ] as const;
  const expectedStageKeys = new Set(EffectArray.map(stageKeys, ([phase, stage]) => `${phase}/${stage}`));
  for (const result of results) {
    const observedStageKeys = EffectArray.map(result.stages, stage => `${stage.phase}/${stage.stage}`);
    if (
      observedStageKeys.length !== expectedStageKeys.size ||
      new Set(observedStageKeys).size !== observedStageKeys.length ||
      EffectArray.some(observedStageKeys, key => !expectedStageKeys.has(key))
    ) {
      throw ScriptError.make({message: 'Ready-query stage coverage contains an unexpected or duplicate event.'});
    }
  }
  const stages = EffectArray.map(stageKeys, ([phase, stage]) => {
    const observations = EffectArray.map(results, result => {
      const matches = EffectArray.filter(
        result.stages,
        candidate => candidate.phase === phase && candidate.stage === stage,
      );
      if (matches.length !== 1) throw ScriptError.make({message: `Ready-query stage ${phase}/${stage} is incomplete.`});
      return matches[0];
    });
    const disposition = observations[0].disposition;
    if (EffectArray.some(observations, observation => observation.disposition !== disposition)) {
      throw ScriptError.make({message: `Ready-query stage ${phase}/${stage} disposition changed within the run.`});
    }
    return {
      disposition,
      durationMilliseconds: EffectArray.map(observations, observation => observation.durationMilliseconds),
      phase,
      stage,
    } satisfies ReadyQueryStageSeriesV1;
  });
  const serviceMilliseconds = EffectArray.map(results, result => result.serviceMilliseconds);
  const attributed = EffectArray.map(results, (_, index) =>
    EffectArray.reduce(stages, 0, (sum, stage) => sum + stage.durationMilliseconds[index]),
  );
  return {
    endToEndMilliseconds: EffectArray.map(
      serviceMilliseconds,
      (service, index) => service + queueLatencyMilliseconds[index],
    ),
    freshness: kind === 'exact' ? 'current' : 'deferred',
    ...(kind === 'deferred' ? {intervalMilliseconds: READY_QUERY_FIXED_RATE_INTERVAL_MILLISECONDS} : {}),
    maxConcurrency: 1,
    mode: kind === 'deferred' ? 'fixed-rate' : 'sequential',
    queueLatencyIncluded: true,
    queueLatencyMilliseconds,
    resultDigests: EffectArray.map(results, result => result.digest),
    serviceMilliseconds,
    snapshotDigests: EffectArray.map(results, result => result.snapshotDigest),
    stages,
    structuredResponseBytes: EffectArray.map(results, result => result.structuredResponseBytes),
    textResponseBytes: EffectArray.map(results, result => result.textResponseBytes),
    unattributedMilliseconds: EffectArray.map(serviceMilliseconds, (service, index) =>
      Math.max(0, service - attributed[index]),
    ),
    warmups: READY_QUERY_MINIMUM_WARMUPS,
  };
}

const queryResultDigest = Effect.fn('readyQueryEvidence.resultDigest')((result: CodeGraphQueryResult) =>
  sha256Hex(
    JSON.stringify({
      edges: result.edges,
      nodes: EffectArray.map(result.nodes, ({contentHash: _contentHash, ...node}) => node),
      operation: result.operation,
    }),
  ),
);

const validateTrackedControls = Effect.fn('readyQueryEvidence.validateTrackedControls')(function* (
  fs: FileSystem.FileSystem,
  repository: string,
) {
  yield* Effect.forEach(
    READY_QUERY_CONTROLS,
    control =>
      Effect.gen(function* () {
        const tracked = yield* git(repository, ['ls-files', '--stage', '--error-unmatch', '--', control.expectedPath]);
        if (!/^100(?:644|755)\s/.test(tracked.stdout)) {
          return yield* ScriptError.make({message: `Ready-query control ${control.id} is not a tracked regular file.`});
        }
        const info = yield* fs.stat(`${repository}/${control.expectedPath}`);
        if (info.type !== 'File') {
          return yield* ScriptError.make({message: `Ready-query control ${control.id} is not a regular file.`});
        }
      }),
    {concurrency: 4},
  );
});

const trackedFileCount = Effect.fn('readyQueryEvidence.trackedFileCount')((repository: string) =>
  git(repository, ['ls-files', '-z']).pipe(
    Effect.map(result => {
      const output = result.stdout;
      return output.length === 0 ? 0 : Effect2.pipe(output, EffectString.split('\0')).length - 1;
    }),
  ),
);

const git = Effect.fn('readyQueryEvidence.git')((repository: string, args: readonly string[]) =>
  runCommandEffect('git', ['-C', repository, ...args], {
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    timeoutMs: 5 * 60_000,
  }),
);

function pathIsWithin(path: Path.Path, candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !Effect2.pipe(relative, EffectString.startsWith(`..${path.sep}`)))
  );
}

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const READY_QUERY_BUILDER_EXCLUSION_TIMEOUT_MILLISECONDS = 10 * 60_000;

export const withReadyQueryBuilderExclusion = Effect.fn('readyQueryEvidence.withBuilderExclusion')(function* <A, E, R>(
  threadnoteHome: string,
  checkoutId: string,
  effect: Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockOptions = {
    retryIntervalMilliseconds: 100,
    staleAfterMilliseconds: 120_000,
    waitTimeoutMilliseconds: READY_QUERY_BUILDER_EXCLUSION_TIMEOUT_MILLISECONDS,
  } as const;
  return yield* withCodeGraphMaintenanceRegistration(
    threadnoteHome,
    withCodeGraphMaintenanceIntent(
      threadnoteHome,
      withExclusiveFileLock(
        fs,
        codeGraphRepositoryLockPath(path, threadnoteHome, checkoutId),
        lockOptions,
        Effect.gen(function* () {
          yield* awaitCodeGraphWorktreeBuilds(
            threadnoteHome,
            checkoutId,
            READY_QUERY_BUILDER_EXCLUSION_TIMEOUT_MILLISECONDS,
          );
          return yield* effect;
        }),
      ),
    ),
    READY_QUERY_BUILDER_EXCLUSION_TIMEOUT_MILLISECONDS,
  );
});

function qualifyingReadyQuerySource(
  provenance: BenchmarkRuntimeProvenance,
  environment: Readonly<Record<string, string | undefined>>,
): ReadyQueryEvidenceV1['source'] {
  const github = {
    environment: Effect2.pipe(environment.THREADNOTE_READY_QUERY_ENVIRONMENT, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    environmentAttestation: Effect2.pipe(
      environment.THREADNOTE_READY_QUERY_ENVIRONMENT_ATTESTATION,
      effectOptionalString =>
        effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    eventName: Effect2.pipe(environment.GITHUB_EVENT_NAME, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    job: Effect2.pipe(environment.GITHUB_JOB, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    ref: Effect2.pipe(environment.GITHUB_REF, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    refProtected: Effect2.pipe(environment.GITHUB_REF_PROTECTED, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    repository: Effect2.pipe(environment.GITHUB_REPOSITORY, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    repositoryId: Effect2.pipe(environment.GITHUB_REPOSITORY_ID, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    repositoryEnablement: Effect2.pipe(environment.THREADNOTE_READY_QUERY_EVIDENCE_ENABLED, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    runnerArch: Effect2.pipe(environment.RUNNER_ARCH, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    runnerEnvironment: Effect2.pipe(environment.RUNNER_ENVIRONMENT, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    runnerOs: Effect2.pipe(environment.RUNNER_OS, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    runAttempt: Effect2.pipe(environment.GITHUB_RUN_ATTEMPT, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    runId: Effect2.pipe(environment.GITHUB_RUN_ID, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    sha: Effect2.pipe(environment.GITHUB_SHA, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    workflowRef: Effect2.pipe(environment.GITHUB_WORKFLOW_REF, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
    workflowSha: Effect2.pipe(environment.GITHUB_WORKFLOW_SHA, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    ),
  };
  if (
    provenance.mode !== 'github-actions-clean-source' ||
    environment.CI !== 'true' ||
    environment.GITHUB_ACTIONS !== 'true' ||
    !isReadyQueryGitHubRepository(github.repository) ||
    github.repositoryId !== READY_QUERY_GITHUB_REPOSITORY_ID ||
    github.eventName !== READY_QUERY_GITHUB_EVENT ||
    github.job !== READY_QUERY_GITHUB_JOB ||
    github.ref !== READY_QUERY_GITHUB_REF ||
    github.refProtected !== 'true' ||
    github.workflowRef !== readyQueryGitHubWorkflowRef(github.repository) ||
    github.environment !== READY_QUERY_GITHUB_ENVIRONMENT ||
    github.environmentAttestation !== READY_QUERY_ENVIRONMENT_ATTESTATION ||
    github.repositoryEnablement !== 'true' ||
    github.runnerEnvironment !== 'self-hosted' ||
    github.runnerOs !== 'Linux' ||
    github.runnerArch !== 'X64' ||
    github.sha !== provenance.sourceCommit ||
    github.workflowSha !== provenance.sourceCommit ||
    !/^[1-9]\d*$/.test(github.runId ?? '') ||
    !/^[1-9]\d*$/.test(github.runAttempt ?? '')
  ) {
    throw ScriptError.make({
      message:
        'Qualifying ready-query evidence requires the canonical enabled protected-main GitHub workflow environment.',
    });
  }
  const repository = github.repository;
  return {
    clean: true,
    commit: provenance.sourceCommit,
    github: {
      environment: READY_QUERY_GITHUB_ENVIRONMENT,
      environmentAttestation: READY_QUERY_ENVIRONMENT_ATTESTATION,
      eventName: READY_QUERY_GITHUB_EVENT,
      job: READY_QUERY_GITHUB_JOB,
      ref: READY_QUERY_GITHUB_REF,
      refProtected: true,
      repository,
      repositoryId: READY_QUERY_GITHUB_REPOSITORY_ID,
      repositoryEnablement: 'enabled',
      runnerArch: 'X64',
      runnerEnvironment: 'self-hosted',
      runnerOs: 'Linux',
      runAttempt: github.runAttempt!,
      runId: github.runId!,
      sha: provenance.sourceCommit,
      workflowRef: readyQueryGitHubWorkflowRef(repository),
      workflowSha: provenance.sourceCommit,
    },
    lockfileSha256: provenance.sourceLockfileSha256,
    packageManifestSha256: provenance.sourcePackageManifestSha256,
    validationMode: 'github-actions-clean-source',
  };
}

const prepareReadyQuerySnapshot = Effect.fn('readyQueryEvidence.prepareSnapshot')(function* (
  preflight: StaticReadyQueryPreflight,
  status: CodeGraphStatus,
) {
  const snapshot = status.readySnapshot;
  if (
    status.identity.checkoutId !== preflight.checkoutId ||
    status.identity.headCommit !== READY_QUERY_REPOSITORY_COMMIT ||
    status.freshness !== 'current' ||
    status.stale ||
    !snapshot ||
    snapshot.state !== 'ready' ||
    snapshot.commit !== READY_QUERY_REPOSITORY_COMMIT ||
    snapshot.dirty ||
    snapshot.extractorSet !== CODE_GRAPH_EXTRACTOR_SET_VERSION ||
    snapshot.fileCount < READY_QUERY_MINIMUM_FILES
  ) {
    return yield* ScriptError.make({
      message: 'The prepared ready home lacks a clean, current, runtime-compatible >=200k-file snapshot.',
    });
  }
  const evidence = {
    contract: READY_QUERY_EVIDENCE_SUITE,
    fixture: preflight.fixture,
    kind: 'ready-query-preflight',
    runtime: preflight.runtime,
    snapshot: {
      commit: READY_QUERY_REPOSITORY_COMMIT,
      dirty: false,
      edgeCount: snapshot.edgeCount,
      extractorSet: CODE_GRAPH_EXTRACTOR_SET_VERSION,
      fileCount: snapshot.fileCount,
      idSha256: yield* sha256Hex(snapshot.id),
      state: 'ready',
      symbolCount: snapshot.symbolCount,
    },
    source: preflight.source,
    state: 'ready',
    version: READY_QUERY_EVIDENCE_VERSION,
  } satisfies ReadyQueryPreflightEvidence;
  return {...preflight, evidence, snapshotId: snapshot.id} satisfies PreparedReadyQueryBenchmark;
});

const assertPreparedSnapshotUnchanged = Effect.fn('readyQueryEvidence.assertPreparedSnapshot')(function* (
  prepared: PreparedReadyQueryBenchmark,
  status: CodeGraphStatus,
) {
  if (
    status.identity.checkoutId !== prepared.checkoutId ||
    status.freshness !== 'current' ||
    status.stale ||
    status.readySnapshot?.id !== prepared.snapshotId ||
    status.readySnapshot.commit !== READY_QUERY_REPOSITORY_COMMIT ||
    status.readySnapshot.dirty
  ) {
    return yield* ScriptError.make({message: 'Ready-query snapshot or fixture changed inside builder exclusion.'});
  }
});

const exactReadyStatus = Effect.fn('readyQueryEvidence.exactStatus')(function* (
  query: ReadyQueryService,
  home: string,
  repository: string,
  phase: string,
) {
  return yield* query.status(home, repository, {observeWorktree: true, requestMaintenance: false}).pipe(
    Effect.timeoutOrElse({
      duration: READY_QUERY_EXACT_TIMEOUT_MILLISECONDS,
      orElse: () => Effect.fail(ScriptError.make({message: `Ready-query ${phase} status timed out.`})),
    }),
  );
});

const assertReadyQueryDatabaseHealth = Effect.fn('readyQueryEvidence.databaseHealth')(function* (
  status: CodeGraphStatus,
) {
  const health = yield* diagnoseCodeGraphDatabaseReadOnly(status.databasePath, false);
  if (
    health.integrity !== 'ok' ||
    health.schemaVersion !== CODE_GRAPH_SCHEMA_VERSION ||
    health.persistentExtensionSchemaRevision !== CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION ||
    health.readySnapshots < 1 ||
    health.buildingSnapshots !== 0
  ) {
    return yield* ScriptError.make({
      message: 'The prepared ready home database is not stable on the current schema and extension revision.',
    });
  }
  return {...health, buildingSnapshots: 0 as const};
});

const canonicalizeProspectivePath = Effect.fn('readyQueryEvidence.canonicalizeOutput')(function* (
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
      return yield* ScriptError.make({message: 'Could not resolve an existing parent for ready-query output.'});
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
});

function required(value: string | undefined, option: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(benchmarkReadyQueryEvidence, ApplicationLayer));
