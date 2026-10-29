#!/usr/bin/env bun
import {Array as EffectArray, Option as EffectOption} from 'effect';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Cause, Effect, Exit, FileSystem, Layer, Path} from 'effect';
import {ChildProcessSpawner} from 'effect/process/ChildProcessSpawner';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {CommandExecutor} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {
  ContextBriefCitationScaleGraphInstrumentation,
  evaluateContextBriefCitationScale,
  makeContextBriefCitationScaleGraphInstrumentation,
  type ContextBriefCitationScaleObservationWrapper,
} from '@threadnote/threadnote/evaluation/context-brief-citation-scale';
import {
  CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS,
  parseContextBriefCitationScaleBudgetV1,
  type ContextBriefCitationScaleObservationV2,
} from '@threadnote/threadnote/evaluation/context-brief-citation-scale-contract';
import {ScriptSystemInfoLayer, ScriptCommandExecutorLayer} from '../../scripts/effect/system-layer.js';
import {provideScriptLayer, ScriptError} from '../../scripts/effect/errors.js';
import {
  readContextBriefCitationScaleCandidate,
  startContextBriefCitationRssObserver,
} from '../../scripts/benchmark-context-brief-citations-target.js';
import {
  isContextBriefCitationRssObserverMode,
  runContextBriefCitationRssObserverMode,
} from '../../scripts/context-brief-citation-rss-observer.js';
import {Collector, summarize} from './citation-phase-collector.js';
import {
  DIAGNOSTIC_INVOCATION_MODE,
  DIAGNOSTIC_SAMPLES,
  DIAGNOSTIC_WARMUPS,
  DIAGNOSTIC_MEMORY_CANDIDATES,
  diagnosticEvidence,
  observationCoverage,
  parseDiagnosticArguments,
  type ObservationMarker,
} from './citation-phase-contract.js';

function isContextBriefCitationScaleObservation(value: unknown): value is ContextBriefCitationScaleObservationV2 {
  if (typeof value !== 'object' || value === null || EffectArray.isArray(value)) return false;
  return (
    'boundaryAddedRssBytes' in value &&
    typeof value.boundaryAddedRssBytes === 'number' &&
    'contextBriefMilliseconds' in value &&
    typeof value.contextBriefMilliseconds === 'number' &&
    'counters' in value &&
    isContextBriefCitationScaleCounters(value.counters) &&
    'estimatedTokens' in value &&
    typeof value.estimatedTokens === 'number' &&
    'exactValidationReceipts' in value &&
    typeof value.exactValidationReceipts === 'number' &&
    'memoryRetrievalMilliseconds' in value &&
    typeof value.memoryRetrievalMilliseconds === 'number' &&
    'profile' in value &&
    typeof value.profile === 'string' &&
    EffectArray.some(CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS, profile => profile === value.profile) &&
    'selectedMemories' in value &&
    typeof value.selectedMemories === 'number' &&
    'validationMilliseconds' in value &&
    typeof value.validationMilliseconds === 'number' &&
    'validationReceipts' in value &&
    typeof value.validationReceipts === 'number'
  );
}

function isContextBriefCitationScaleCounters(
  value: unknown,
): value is ContextBriefCitationScaleObservationV2['counters'] {
  if (typeof value !== 'object' || value === null || EffectArray.isArray(value)) return false;
  return (
    'activeViewFenceObservations' in value &&
    typeof value.activeViewFenceObservations === 'number' &&
    'coldGraphBuilds' in value &&
    typeof value.coldGraphBuilds === 'number' &&
    'distinctGraphDatabasePaths' in value &&
    typeof value.distinctGraphDatabasePaths === 'number' &&
    'effectiveEvidenceBatches' in value &&
    typeof value.effectiveEvidenceBatches === 'number' &&
    'leaseBalance' in value &&
    typeof value.leaseBalance === 'number' &&
    'maintenanceRequests' in value &&
    typeof value.maintenanceRequests === 'number' &&
    'peakLeaseBalance' in value &&
    typeof value.peakLeaseBalance === 'number' &&
    'productionStoreSessionCalls' in value &&
    typeof value.productionStoreSessionCalls === 'number' &&
    'snapshotLeaseAcquisitions' in value &&
    typeof value.snapshotLeaseAcquisitions === 'number' &&
    'snapshotLeaseReleases' in value &&
    typeof value.snapshotLeaseReleases === 'number' &&
    'statusObservations' in value &&
    typeof value.statusObservations === 'number'
  );
}

const collector = new Collector();
const fixtureRoots: string[] = [];
const markers: ObservationMarker[] = [];
const issues: string[] = [];
const proof = {before: '', after: '', reads: 0};
let evidence: ReturnType<typeof diagnosticEvidence> | undefined;
let output = 'artifacts/context-brief-citation-phase-diagnostic.json';
let reportComplete = false;

const native = Layer.mergeAll(
  Layer.effect(
    ChildProcessSpawner,
    Effect.map(ChildProcessSpawner, service => collector.spawner(service)),
  ),
  Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, fs => {
      const observed = collector.filesystem(fs);
      return new Proxy(observed, {
        get: (target, property, receiver) =>
          property === 'makeTempDirectoryScoped'
            ? (options: Parameters<typeof fs.makeTempDirectoryScoped>[0]) =>
                fs.makeTempDirectoryScoped(options).pipe(
                  Effect.tap(root =>
                    Effect.sync(() => {
                      if (options?.prefix === 'threadnote-context-brief-citation-scale-') fixtureRoots.push(root);
                    }),
                  ),
                )
            : Reflect.get(target, property, receiver),
      });
    }),
  ),
).pipe(Layer.provideMerge(BunServices.layer));
const system = ScriptSystemInfoLayer;
// The executor captures this observed spawner during layer construction.
const rawCommand = ScriptCommandExecutorLayer.pipe(Layer.provide(system), Layer.provide(native));
const command = Layer.effect(
  CommandExecutor,
  Effect.map(CommandExecutor, service => CommandExecutor.of(collector.command(service))),
).pipe(Layer.provide(rawCommand));
const platform = Layer.mergeAll(system, command).pipe(Layer.provideMerge(native));
const graph = makeContextBriefCitationScaleGraphInstrumentation();
const store = Layer.effect(
  CodeGraphStore,
  Effect.map(CodeGraphStore, original => CodeGraphStore.of(collector.store(graph.instrumentStore(original)))),
).pipe(Layer.provide(CodeGraphStore.layer.pipe(Layer.provideMerge(platform))));
const unexpected = () => Effect.die(new Error('Diagnostic must not start graph indexing or maintenance.'));
const dependencies = Layer.mergeAll(
  platform,
  store,
  Layer.succeed(ContextBriefCitationScaleGraphInstrumentation, graph),
  Layer.succeed(CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry([])),
  Layer.succeed(CodeGraphIndexer, CodeGraphIndexer.of({ensureCommit: unexpected, index: unexpected})),
  Layer.succeed(
    CodeGraphMaintenanceCoordinator,
    CodeGraphMaintenanceCoordinator.of({
      kickOrdinary: unexpected,
      kickReconciliation: unexpected,
      kickResidual: unexpected,
      request: unexpected,
      tick: unexpected,
    }),
  ),
  Layer.succeed(
    CodeGraphEmbeddingIndex,
    CodeGraphEmbeddingIndex.of({check: unexpected, ensure: unexpected, search: () => Effect.succeed(new Map())}),
  ),
);
const query = Layer.effect(
  CodeGraphQueryService,
  Effect.map(CodeGraphQueryService, original =>
    CodeGraphQueryService.of({
      ...original,
      withStatusSession: (home, cwd, expected, options, use) =>
        collector.phase(
          'initial',
          original.withStatusSession!(home, cwd, expected, options, status => collector.phase('evidence', use(status))),
        ),
      statusForPublishedIdentity: (...args) => collector.phase('closing', original.statusForPublishedIdentity(...args)),
    }),
  ),
).pipe(Layer.provideMerge(CodeGraphQueryService.layer.pipe(Layer.provideMerge(dependencies))));

const readIndexProof = (fs: FileSystem.FileSystem) =>
  Effect.gen(function* () {
    if (fixtureRoots.length !== 1) return yield* Effect.fail('fixture-root-coverage');
    // This is the original fixture generator's fixed local repository path.
    const sourceRoot = `${fixtureRoots[0]}/repositories/local-100k-repo-000`;
    const index = `${sourceRoot}/.git/index`;
    const stat = yield* fs.stat(index);
    if (stat.size > 16 * 1_048_576) return yield* Effect.fail('fixture-index-bound');
    proof.reads++;
    return sha256HexSync(yield* fs.readFile(index));
  }).pipe(Effect.timeout('5 seconds'));

const makeObservationWrapper =
  (fs: FileSystem.FileSystem): ContextBriefCitationScaleObservationWrapper =>
  (descriptor, observation) =>
    Effect.suspend(() => {
      const id = markers.length;
      const detail = descriptor.profileId === 'local-100k';
      markers.push({
        ...descriptor,
        id,
        details: detail ? 'collected' : 'intentionally-omitted',
        outcome: 'interrupted',
      });
      let counters: ContextBriefCitationScaleObservationV2['counters'] | undefined;
      let resultCounts:
        | Pick<
            ContextBriefCitationScaleObservationV2,
            'exactValidationReceipts' | 'validationReceipts' | 'selectedMemories'
          >
        | undefined;
      const before =
        detail && descriptor.pass === 'rss-memory' && descriptor.ordinal === 0
          ? readIndexProof(fs).pipe(
              Effect.tap(hash =>
                Effect.sync(() => {
                  proof.before = hash;
                }),
              ),
              Effect.catchCause(() =>
                Effect.sync(() => {
                  issues.push('initial-index-proof-unavailable');
                }),
              ),
            )
          : Effect.void;
      const after =
        detail && descriptor.pass === 'timed' && descriptor.ordinal === DIAGNOSTIC_SAMPLES - 1
          ? readIndexProof(fs).pipe(
              Effect.tap(hash =>
                Effect.sync(() => {
                  proof.after = hash;
                }),
              ),
              Effect.catchCause(() =>
                Effect.sync(() => {
                  issues.push('final-index-proof-unavailable');
                }),
              ),
            )
          : Effect.void;
      const measured = observation.pipe(
        Effect.tap(value =>
          Effect.sync(() => {
            if (isContextBriefCitationScaleObservation(value)) {
              const result = value;
              counters = result.counters;
              resultCounts = {
                exactValidationReceipts: result.exactValidationReceipts,
                validationReceipts: result.validationReceipts,
                selectedMemories: result.selectedMemories,
              };
            }
          }),
        ),
      );
      return before.pipe(
        Effect.andThen(
          detail
            ? collector.sample(id, measured, {
                canonicalIndex: `${fixtureRoots[0]}/repositories/local-100k-repo-000/.git/index`,
                sourceRoot: `${fixtureRoots[0]}/repositories/local-100k-repo-000`,
              })
            : measured,
        ),
        Effect.onExit(exit =>
          Effect.sync(() => {
            markers[id] = {
              ...markers[id],
              ...resultCounts,
              ...(counters === undefined ? {} : {counters}),
              outcome: Exit.isSuccess(exit)
                ? 'success'
                : Cause.hasInterrupts(exit.cause)
                  ? 'interrupted'
                  : Cause.hasDies(exit.cause)
                    ? 'defect'
                    : 'typed-error',
            };
          }).pipe(Effect.andThen(after)),
        ),
      );
    });

const program = Effect.scoped(
  Effect.gen(function* () {
    const options = parseDiagnosticArguments(process.argv.slice(2));
    output = options.output;
    const fs = yield* FileSystem.FileSystem;
    const sys = yield* SystemInfo;
    const binding = yield* readContextBriefCitationScaleCandidate(
      options.candidate,
      `threadnote-${yield* getThreadnoteVersion()}`,
    );
    const budget = parseContextBriefCitationScaleBudgetV1(
      JSON.parse(
        yield* fs.readFileString(
          'apps/threadnote/test/evaluation/baselines/context-brief-citations-v1/scale-budgets.json',
        ),
      ),
    );
    const artifact = yield* evaluateContextBriefCitationScale({
      budget,
      builtArtifactSha256: options.builtArtifactSha256,
      invocationMode: DIAGNOSTIC_INVOCATION_MODE,
      memoryCandidates: DIAGNOSTIC_MEMORY_CANDIDATES,
      profileIds: CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS,
      releaseCandidateCommit: options.candidate,
      releaseCandidateBinding: binding,
      samples: DIAGNOSTIC_SAMPLES,
      warmups: DIAGNOSTIC_WARMUPS,
      startRssObserver: startContextBriefCitationRssObserver(options.builtArtifactSha256),
      observeObservation: makeObservationWrapper(fs),
    });
    evidence = diagnosticEvidence(artifact);
    if (artifact.evidenceClass !== 'development-smoke' || artifact.gate.passed) issues.push('diagnostic-provenance');
    const coverage = observationCoverage(markers, DIAGNOSTIC_SAMPLES, DIAGNOSTIC_WARMUPS);
    if (
      !coverage.complete ||
      collector.dropped !== 0 ||
      collector.lateInvocationEvents !== 0 ||
      !proof.before ||
      proof.before !== proof.after ||
      proof.reads !== 2
    )
      issues.push('incomplete-diagnostic-coverage');
    if (
      EffectArray.some(
        markers,
        marker =>
          marker.counters?.coldGraphBuilds !== 0 ||
          marker.counters?.maintenanceRequests !== 0 ||
          marker.counters?.leaseBalance !== 0,
      )
    )
      issues.push('unexpected-production-counters');
    if (
      EffectArray.some(markers, marker => {
        const profile = EffectOption.getOrUndefined(
          EffectArray.findFirst(budget.profiles, profile => profile.id === marker.profileId),
        )!;
        return (
          marker.validationReceipts !== profile.citationCount ||
          marker.exactValidationReceipts !== profile.citationCount ||
          marker.selectedMemories !== profile.selectedMemories
        );
      })
    )
      issues.push('unexpected-receipt-coverage');
    if (
      !EffectArray.some(collector.events, event => event.kind === 'spawn') ||
      !EffectArray.some(collector.events, event => event.kind === 'child-exit')
    )
      issues.push('missing-process-boundaries');
    if (sys.platform !== 'darwin' || artifact.environment.architecture !== 'arm64')
      issues.push('unexpected-hosted-platform');
    collector.beginTeardown();
    if (issues.length > 0) return yield* ScriptError.make({message: 'Citation diagnostic coverage failed.'});
  }),
);

const writeReport = (exit: Exit.Exit<unknown, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const removed = yield* Effect.forEach(fixtureRoots, root => fs.exists(root).pipe(Effect.map(exists => !exists)));
    const cleanupPassed = fixtureRoots.length === 1 && EffectArray.every(removed, Boolean);
    if (!cleanupPassed) issues.push('fixture-cleanup-incomplete');
    if (collector.lateInvocationEvents !== 0) issues.push('observed-child-outlived-invocation');
    const coverage = observationCoverage(markers, DIAGNOSTIC_SAMPLES, DIAGNOSTIC_WARMUPS);
    reportComplete = Exit.isSuccess(exit) && cleanupPassed && issues.length === 0;
    const report = {
      kind: 'context-brief-citation-phase-diagnostic',
      version: 1,
      releaseQualification: false,
      result: reportComplete ? 'complete' : 'incomplete',
      evidence,
      coverage: {
        ...coverage,
        events: collector.events.length,
        maximumEvents: collector.maximumEvents,
        dropped: collector.dropped,
        lateEvents: collector.lateEvents,
        lateInvocationEvents: collector.lateInvocationEvents,
        teardownFileStoreEvents: collector.teardownEvents,
        canonicalIndexBytesUnchanged: Boolean(proof.before) && proof.before === proof.after,
        indexProof: proof,
        fixtureCleanupPassed: cleanupPassed,
        issues,
      },
      observations: EffectArray.map(markers, marker => ({
        ...marker,
        ...(marker.details === 'collected'
          ? {summary: summarize(EffectArray.filter(collector.events, event => event.sample === marker.id))}
          : {}),
      })),
      events: collector.events,
      limitations: [
        'Instrumented diagnostic only. No latency or memory result qualifies a release.',
        'Detailed spans cover local-profile observations only; all three original profile histories execute.',
        'Two canonical-index proof reads occur outside observation clocks, but alter file-cache history; wrappers/clock calls alter scheduling.',
        'Process exit and spawn spans include delivery/scheduling delay and do not prove OS CPU/run-queue time.',
        'File service spans cannot observe Git internal scans or native SQLite I/O; store session is inclusive.',
        'File/store bookkeeping after all observations is reported separately as teardown; invocation child/process overrun invalidates coverage.',
        'No Trace2 override, no raw command arguments/output, file paths or file contents are retained.',
      ],
    };
    yield* fs.makeDirectory(path.dirname(output), {recursive: true});
    yield* fs.writeFileString(output, JSON.stringify(report, null, 2) + '\n');
  });

if (import.meta.main) {
  const args = process.argv.slice(2);
  const collectAndReport = Effect.gen(function* () {
    const result = yield* program.pipe(Effect.exit);
    const report = yield* writeReport(result).pipe(Effect.exit);
    // Preserve the original failure/defect/interruption even when report persistence also fails.
    if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
    if (Exit.isFailure(report)) return yield* Effect.failCause(report.cause);
    if (!reportComplete) return yield* ScriptError.make({message: 'Citation diagnostic report is incomplete.'});
  });
  BunRuntime.runMain(
    isContextBriefCitationRssObserverMode(args)
      ? provideScriptLayer(runContextBriefCitationRssObserverMode(args), platform)
      : provideScriptLayer(collectAndReport, query),
  );
}
