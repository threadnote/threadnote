#!/usr/bin/env bun
import {Array as EffectArray} from 'effect';
import {ScriptCommandExecutorLayer} from './effect/system-layer.js';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Clock, Effect, FileSystem, Layer} from 'effect';
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256FileHex} from '@threadnote/platform/digest';
import {SystemInfo} from '@threadnote/platform/system';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {
  CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS,
  CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES,
  CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS,
  contextBriefCitationScaleCandidateBinding,
  parseContextBriefCitationScaleArtifactV2,
  parseContextBriefCitationScaleBudgetV1,
  type ContextBriefCitationScaleProfileId,
} from '@threadnote/threadnote/evaluation/context-brief-citation-scale-contract';
import {
  ContextBriefCitationScaleGraphInstrumentation,
  evaluateContextBriefCitationScale,
  makeContextBriefCitationScaleGraphInstrumentation,
  makeContextBriefCitationScaleEmbeddingIndex,
  type ContextBriefCitationScaleRssObserver,
} from '@threadnote/threadnote/evaluation/context-brief-citation-scale';
import {
  contextBriefCitationRssObserverArguments,
  CONTEXT_BRIEF_CITATION_RSS_MAXIMUM_OBSERVATIONS,
  isContextBriefCitationRssObserverMode,
  parseContextBriefCitationRssArtifact,
  parseContextBriefCitationRssReady,
  runContextBriefCitationRssObserverMode,
  waitForContextBriefCitationRssAcknowledgement,
  writeContextBriefCitationRssRequest,
  type ContextBriefCitationRssAcknowledgementV2,
  type ContextBriefCitationRssArtifactV2,
  type ContextBriefCitationRssReadyV2,
  type ContextBriefCitationRssRequestV2,
} from './context-brief-citation-rss-observer.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const DEFAULT_BUDGET = 'apps/threadnote/test/evaluation/baselines/context-brief-citations-v1/scale-budgets.json';
const RSS_OBSERVER_BARRIER_TIMEOUT_MILLISECONDS = 30_000;
const RSS_OBSERVER_EXIT_TIMEOUT_MILLISECONDS = 30_000;
const RSS_OBSERVER_KILL_TIMEOUT_MILLISECONDS = 5_000;
const RSS_OBSERVER_MAXIMUM_STDERR_BYTES = 64 * 1_024;
const RSS_OBSERVER_READY_TIMEOUT_MILLISECONDS = 30_000;

type ContextBriefCitationRssBarrierRequest =
  {readonly observationId: string; readonly operation: 'begin' | 'end'} | {readonly operation: 'stop'};

export interface ContextBriefCitationRssReadyProbe {
  readonly childExitCode: () => number | null;
  readonly readReady: Effect.Effect<ContextBriefCitationRssReadyV2 | undefined, Error>;
  readonly stderr: Promise<string>;
  readonly timeoutMilliseconds?: number;
}

export interface ContextBriefCitationRssTerminationControl {
  readonly exitCode: () => number | null;
  readonly kill: (signal?: number) => void;
  readonly waitForExit: () => Promise<number | undefined>;
}

export interface ContextBriefCitationRssControllerAdapter {
  readonly barrier: (
    request: ContextBriefCitationRssBarrierRequest,
    expected: ContextBriefCitationRssAcknowledgementV2['state'],
  ) => Effect.Effect<void, Error>;
  readonly childExitCode: () => number | null;
  readonly exitWithin: Effect.Effect<number | undefined>;
  readonly readArtifact: Effect.Effect<ContextBriefCitationRssArtifactV2, Error>;
  readonly ready: ContextBriefCitationRssReadyV2;
  readonly stderr: Promise<string>;
  readonly terminate: Effect.Effect<void, Error>;
}

export interface ContextBriefCitationScaleBenchmarkOptions {
  readonly budgetPath: string;
  readonly builtArtifactSha256: string;
  readonly candidateCommit?: string;
  readonly failOnBudget: boolean;
  readonly memoryCandidates: number;
  readonly outputPath?: string;
  readonly profileIds: readonly ContextBriefCitationScaleProfileId[];
  readonly samples: number;
  readonly warmups: number;
}

/** Bind the embedded build version to the reviewed package bytes before any scale fixture work. */
export const readContextBriefCitationScaleCandidate = Effect.fn('contextBriefCitationScale.readCandidate')(function* (
  candidateCommit: string,
  observedSourceVersion: string,
  cwd?: string,
) {
  if (!/^[0-9a-f]{40}$/u.test(candidateCommit)) {
    return yield* ScriptError.make({message: 'Release-scale evidence requires an exact candidate Git SHA-1.'});
  }
  const options = {cwd, maxOutputBytes: 128 * 1024, timeoutMs: 10_000};
  const head = yield* runCommandEffect('git', ['rev-parse', 'HEAD'], options);
  if (Effect2.pipe(head.stdout, EffectString.trim) !== candidateCommit) {
    return yield* ScriptError.make({message: 'Release-scale evidence requires the exact candidate checkout.'});
  }
  const status = yield* runCommandEffect(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignore-submodules=none',
      '--no-renames',
    ],
    options,
  );
  if (Effect2.pipe(status.stdout, EffectString.trim)) {
    return yield* ScriptError.make({message: 'Release-scale evidence requires an exact clean candidate checkout.'});
  }
  const manifest = yield* runCommandEffect('git', ['show', `${candidateCommit}:package.json`], options);
  const candidate = yield* Effect.try({
    try: () => contextBriefCitationScaleCandidateBinding(candidateCommit, JSON.parse(manifest.stdout)),
    catch: cause =>
      ScriptError.make({message: 'Could not validate the candidate package version and Bun runtime.', cause}),
  });
  if (observedSourceVersion !== candidate.sourceVersion) {
    return yield* ScriptError.make({
      message: `Built source version ${observedSourceVersion}; required candidate package version ${candidate.sourceVersion}.`,
    });
  }
  return candidate;
});

const program = Effect.scoped(
  Effect.gen(function* () {
    const options = parseContextBriefCitationScaleBenchmarkArguments(yield* scriptArguments());
    const budget = parseContextBriefCitationScaleBudgetV1(yield* readJsonFile(options.budgetPath));
    if (
      options.failOnBudget &&
      (options.memoryCandidates !== budget.corpusMemoryCandidates ||
        options.samples !== CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES ||
        options.warmups !== CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS ||
        JSON.stringify(options.profileIds) !== JSON.stringify(CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS) ||
        !/^[0-9a-f]{40}$/u.test(options.candidateCommit ?? ''))
    ) {
      return yield* ScriptError.make({
        message: `--fail-on-budget requires an exact candidate commit, the reviewed 100k corpus, all three profiles, exactly ${CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES} samples, and exactly ${CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS} warmups.`,
      });
    }
    const candidate = options.failOnBudget
      ? yield* readContextBriefCitationScaleCandidate(
          options.candidateCommit!,
          `threadnote-${yield* getThreadnoteVersion()}`,
        )
      : undefined;
    const evaluatedArtifact = yield* evaluateContextBriefCitationScale({
      budget,
      builtArtifactSha256: options.builtArtifactSha256,
      invocationMode: options.failOnBudget ? 'release-scale' : 'development-smoke',
      memoryCandidates: options.memoryCandidates,
      profileIds: options.profileIds,
      ...(options.candidateCommit === undefined ? {} : {releaseCandidateCommit: options.candidateCommit}),
      ...(candidate === undefined ? {} : {releaseCandidateBinding: candidate}),
      samples: options.samples,
      startRssObserver: startContextBriefCitationRssObserver(options.builtArtifactSha256),
      warmups: options.warmups,
    });
    const artifact = parseContextBriefCitationScaleArtifactV2(evaluatedArtifact, budget, candidate);
    if (options.outputPath !== undefined) {
      yield* atomicWrite(options.outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
    }
    yield* printJson(artifact);
    if (options.failOnBudget && !artifact.gate.passed) {
      return yield* ScriptError.make({message: EffectArray.join(artifact.gate.failures, '\n')});
    }
  }),
);

export function parseContextBriefCitationScaleBenchmarkArguments(
  args: readonly string[],
): ContextBriefCitationScaleBenchmarkOptions {
  let budgetPath = DEFAULT_BUDGET;
  let builtArtifactSha256 = '';
  let candidateCommit: string | undefined;
  let failOnBudget = false;
  let memoryCandidates = 100_000;
  let outputPath: string | undefined;
  let profileIds: readonly ContextBriefCitationScaleProfileId[] = CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS;
  let samples: number = CONTEXT_BRIEF_CITATION_SCALE_RELEASE_SAMPLES;
  let warmups: number = CONTEXT_BRIEF_CITATION_SCALE_RELEASE_WARMUPS;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--budget') budgetPath = required(args[++index], argument);
    else if (argument === '--built-artifact-sha256') builtArtifactSha256 = required(args[++index], argument);
    else if (argument === '--candidate-commit') candidateCommit = required(args[++index], argument);
    else if (argument === '--fail-on-budget') failOnBudget = true;
    else if (argument === '--memory-candidates') memoryCandidates = positiveInteger(args[++index], argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--profiles') profileIds = profiles(required(args[++index], argument));
    else if (argument === '--samples') samples = positiveInteger(args[++index], argument);
    else if (argument === '--warmups') warmups = nonNegativeInteger(args[++index], argument);
    else throw ScriptError.make({message: `Unknown Context Brief citation scale benchmark option: ${argument}`});
  }
  if (samples > Math.floor(CONTEXT_BRIEF_CITATION_RSS_MAXIMUM_OBSERVATIONS / profileIds.length)) {
    throw ScriptError.make({
      message: `The Context Brief RSS observer supports at most ${CONTEXT_BRIEF_CITATION_RSS_MAXIMUM_OBSERVATIONS} total profile/sample observations; received ${profileIds.length * samples}.`,
    });
  }
  return {
    budgetPath,
    builtArtifactSha256,
    ...(candidateCommit === undefined ? {} : {candidateCommit}),
    failOnBudget,
    memoryCandidates,
    ...(outputPath === undefined ? {} : {outputPath}),
    profileIds,
    samples,
    warmups,
  };
}

function profiles(value: string): readonly ContextBriefCitationScaleProfileId[] {
  const selected = EffectArray.filter(Effect2.pipe(value, EffectString.split(',')), Boolean);
  if (
    selected.length === 0 ||
    new Set(selected).size !== selected.length ||
    EffectArray.some(selected, profile => !isContextBriefCitationScaleProfileId(profile))
  ) {
    throw ScriptError.make({
      message: '--profiles must be a unique comma-separated subset of local-100k,workset-50,workset-128.',
    });
  }
  return EffectArray.filter(selected, isContextBriefCitationScaleProfileId);
}

function isContextBriefCitationScaleProfileId(value: string): value is ContextBriefCitationScaleProfileId {
  return EffectArray.some(CONTEXT_BRIEF_CITATION_SCALE_PROFILE_IDS, profile => profile === value);
}

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = nonNegativeInteger(value, option);
  if (parsed < 1) throw ScriptError.make({message: `${option} requires a positive integer.`});
  return parsed;
}

function nonNegativeInteger(value: string | undefined, option: string): number {
  const raw = required(value, option);
  if (!/^\d+$/u.test(raw)) throw ScriptError.make({message: `${option} requires a non-negative integer.`});
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw ScriptError.make({message: `${option} exceeds the safe integer range.`});
  return parsed;
}

function required(value: string | undefined, option: string): string {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Native optional chaining preserves the non-undefined return type after validation.
  if (!value?.trim()) throw ScriptError.make({message: `${option} requires a value.`});
  return value;
}

export const validateContextBriefCitationRssBundleDigest = Effect.fn(
  'contextBriefCitationScale.validateRssBundleDigest',
)(function* (observed: string, expected: string) {
  if (observed === expected) return;
  return yield* ScriptError.make({message: `Context Brief benchmark target digest ${observed}; expected ${expected}.`});
});

export const validateContextBriefCitationRssAcknowledgement = Effect.fn(
  'contextBriefCitationScale.validateRssAcknowledgement',
)(function* (
  request: ContextBriefCitationRssRequestV2,
  expected: ContextBriefCitationRssAcknowledgementV2['state'],
  acknowledgement: ContextBriefCitationRssAcknowledgementV2,
) {
  if (
    acknowledgement.sequence === request.sequence &&
    acknowledgement.version === request.version &&
    acknowledgement.state === expected &&
    (!('observationId' in request) ||
      ('observationId' in acknowledgement && acknowledgement.observationId === request.observationId))
  ) {
    return;
  }
  return yield* ScriptError.make({message: 'Context Brief RSS observer returned a mismatched barrier.'});
});

export const validateContextBriefCitationRssReadyArtifact = Effect.fn(
  'contextBriefCitationScale.validateRssReadyArtifact',
)(function* (ready: ContextBriefCitationRssReadyV2, artifact: ContextBriefCitationRssArtifactV2) {
  if (
    artifact.intervalMilliseconds === ready.intervalMilliseconds &&
    artifact.observerExcluded === ready.observerExcluded &&
    artifact.rootIdentityValidation === ready.rootIdentityValidation &&
    artifact.rootStartIdentity === ready.rootStartIdentity &&
    artifact.samplingSchedule === ready.samplingSchedule &&
    artifact.scope === ready.scope &&
    artifact.source === ready.source &&
    artifact.version === ready.version
  ) {
    return;
  }
  return yield* ScriptError.make({message: 'Context Brief RSS observer artifact changed its ready contract.'});
});

export function makeContextBriefCitationRssObserverController(
  adapter: ContextBriefCitationRssControllerAdapter,
): ContextBriefCitationScaleRssObserver {
  let activeObservationId: string | undefined;
  let finished = false;
  const observe: ContextBriefCitationScaleRssObserver['observe'] = (observationId, effect) =>
    Effect.acquireUseRelease(
      Effect.gen(function* () {
        if (finished || activeObservationId !== undefined) {
          return yield* ScriptError.make({message: 'Context Brief RSS observer received overlapping work.'});
        }
        yield* adapter.barrier({observationId, operation: 'begin'}, 'begun');
        activeObservationId = observationId;
      }),
      () => effect,
      () =>
        Effect.gen(function* () {
          if (activeObservationId !== observationId) {
            return yield* ScriptError.make({message: 'Context Brief RSS observer lost its active observation.'});
          }
          yield* adapter.barrier({observationId, operation: 'end'}, 'ended');
          activeObservationId = undefined;
        }),
    );
  const finish = Effect.gen(function* () {
    if (finished || activeObservationId !== undefined) {
      return yield* ScriptError.make({message: 'Context Brief RSS observer cannot finish in its current state.'});
    }
    yield* adapter.barrier({operation: 'stop'}, 'stopped');
    const exitCode = yield* adapter.exitWithin;
    if (exitCode === undefined) {
      yield* adapter.terminate;
      return yield* ScriptError.make({message: 'Context Brief RSS observer did not exit after its stop barrier.'});
    }
    if (exitCode !== 0) {
      return yield* ScriptError.make({
        message: `Context Brief RSS observer exited with ${exitCode}: ${yield* boundedObserverStderr(adapter.stderr)}`,
      });
    }
    const artifact = yield* adapter.readArtifact;
    yield* validateContextBriefCitationRssReadyArtifact(adapter.ready, artifact);
    finished = true;
    return artifact;
  });
  const close = Effect.gen(function* () {
    if (adapter.childExitCode() !== null) return;
    yield* adapter.terminate;
  });
  return {close, finish, observe};
}

export const waitForContextBriefCitationRssBarrierAcknowledgement = Effect.fn(
  'contextBriefCitationScale.waitForRssBarrierAcknowledgement',
)(function* (
  acknowledgementPath: string,
  sequence: number,
  timeoutMilliseconds: number,
  childExitCode: () => number | null,
  stderr: Promise<string>,
) {
  return yield* waitForContextBriefCitationRssAcknowledgement(
    acknowledgementPath,
    sequence,
    timeoutMilliseconds,
    childExitCode,
  ).pipe(
    Effect.catch(error =>
      childExitCode() === null
        ? Effect.fail(error)
        : Effect.gen(function* () {
            return yield* ScriptError.make({
              message: `${error.message} ${yield* boundedObserverStderr(stderr)}`,
              cause: error,
            });
          }),
    ),
  );
});

export const startContextBriefCitationRssObserver = Effect.fn('contextBriefCitationScale.startRssObserver')(function* (
  expectedBuiltArtifactSha256: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  if (system.platform !== 'darwin' && system.platform !== 'linux') {
    return yield* ScriptError.make({message: `Context Brief RSS observation does not support ${system.platform}.`});
  }
  const bundlePath = system.processArguments[1];
  if (bundlePath === undefined || bundlePath.length === 0) {
    return yield* ScriptError.make({message: 'Context Brief RSS observer could not resolve the benchmark target.'});
  }
  const observedBuiltArtifactSha256 = yield* sha256FileHex(bundlePath);
  yield* validateContextBriefCitationRssBundleDigest(observedBuiltArtifactSha256, expectedBuiltArtifactSha256);
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-context-brief-rss-observer-'});
  const paths = {
    acknowledgementPath: `${root}/acknowledgement.json`,
    outputPath: `${root}/artifact.json`,
    readyPath: `${root}/ready.json`,
    requestPath: `${root}/request.json`,
  };
  const intervalMilliseconds = system.platform === 'darwin' ? 25 : 10;
  const child = yield* Effect.try({
    try: () =>
      Bun.spawn({
        cmd: [
          system.executablePath,
          bundlePath,
          ...contextBriefCitationRssObserverArguments({
            ...paths,
            barrierTimeoutMilliseconds: RSS_OBSERVER_BARRIER_TIMEOUT_MILLISECONDS,
            intervalMilliseconds,
            rootProcessId: system.processId,
          }),
        ],
        maxBuffer: RSS_OBSERVER_MAXIMUM_STDERR_BYTES,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'ignore',
      }),
    catch: cause => ScriptError.make({message: 'Could not start the Context Brief RSS observer.', cause}),
  });
  const stderr = contextBriefCitationRssObserverStderr(child);
  const ready = yield* waitForContextBriefCitationRssReady({
    childExitCode: () => child.exitCode,
    readReady: Effect.gen(function* () {
      if (!(yield* fs.exists(paths.readyPath))) return undefined;
      const value = yield* readJsonFile(paths.readyPath).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      return yield* Effect.try({
        try: () => parseContextBriefCitationRssReady(value),
        catch: cause => ScriptError.make({message: 'Context Brief RSS observer ready evidence is invalid.', cause}),
      });
    }),
    stderr,
  }).pipe(Effect.tapError(() => terminateContextBriefCitationRssObserver(child)));
  if (ready.intervalMilliseconds !== intervalMilliseconds) {
    yield* terminateContextBriefCitationRssObserver(child);
    return yield* ScriptError.make({message: 'Context Brief RSS observer acknowledged the wrong sample interval.'});
  }
  let sequence = 0;
  const barrier = (
    request: ContextBriefCitationRssBarrierRequest,
    expected: ContextBriefCitationRssAcknowledgementV2['state'],
  ) =>
    Effect.gen(function* () {
      sequence += 1;
      const sequenced = {...request, sequence, version: 2 as const} as ContextBriefCitationRssRequestV2;
      yield* writeContextBriefCitationRssRequest(paths.requestPath, sequenced).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const acknowledgement = yield* waitForContextBriefCitationRssBarrierAcknowledgement(
        paths.acknowledgementPath,
        sequence,
        RSS_OBSERVER_BARRIER_TIMEOUT_MILLISECONDS,
        () => child.exitCode,
        stderr,
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      yield* validateContextBriefCitationRssAcknowledgement(sequenced, expected, acknowledgement);
    });
  return makeContextBriefCitationRssObserverController({
    barrier,
    childExitCode: () => child.exitCode,
    exitWithin: Effect.promise(() =>
      contextBriefCitationRssObserverExitWithin(child, RSS_OBSERVER_EXIT_TIMEOUT_MILLISECONDS),
    ),
    readArtifact: readJsonFile(paths.outputPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.flatMap(value =>
        Effect.try({
          try: () => parseContextBriefCitationRssArtifact(value),
          catch: cause => ScriptError.make({message: 'Context Brief RSS observer artifact is invalid.', cause}),
        }),
      ),
    ),
    ready,
    stderr,
    terminate: terminateContextBriefCitationRssObserver(child),
  });
});

export const waitForContextBriefCitationRssReady = Effect.fn('contextBriefCitationScale.waitForRssReady')(function* (
  probe: ContextBriefCitationRssReadyProbe,
) {
  const timeoutMilliseconds = probe.timeoutMilliseconds ?? RSS_OBSERVER_READY_TIMEOUT_MILLISECONDS;
  const startedAt = yield* Clock.currentTimeMillis;
  while (true) {
    const ready = yield* probe.readReady;
    if (ready !== undefined && probe.childExitCode() === null) return ready;
    if (probe.childExitCode() !== null) {
      return yield* ScriptError.make({
        message: `Context Brief RSS observer exited before ready: ${yield* boundedObserverStderr(probe.stderr)}`,
      });
    }
    if ((yield* Clock.currentTimeMillis) - startedAt >= timeoutMilliseconds) {
      return yield* ScriptError.make({
        message: 'Timed out waiting for the Context Brief RSS observer to become ready.',
      });
    }
    yield* Effect.sleep(10);
  }
});

export const terminateContextBriefCitationRssProcess = Effect.fn('contextBriefCitationScale.terminateRssProcess')(
  function* (control: ContextBriefCitationRssTerminationControl) {
    if (control.exitCode() !== null) return;
    yield* Effect.try({
      try: () => control.kill(),
      catch: cause => ScriptError.make({message: 'Could not terminate the Context Brief RSS observer.', cause}),
    });
    const terminated = yield* Effect.promise(control.waitForExit);
    if (terminated !== undefined || control.exitCode() !== null) return;
    yield* Effect.try({
      try: () => control.kill(9),
      catch: cause => ScriptError.make({message: 'Could not kill the Context Brief RSS observer.', cause}),
    });
    const killed = yield* Effect.promise(control.waitForExit);
    if (killed === undefined && control.exitCode() === null) {
      return yield* ScriptError.make({message: 'Context Brief RSS observer could not be confirmed stopped.'});
    }
  },
);

const terminateContextBriefCitationRssObserver = Effect.fn('contextBriefCitationScale.terminateRssObserver')(function* (
  child: ReturnType<typeof Bun.spawn>,
) {
  return yield* terminateContextBriefCitationRssProcess({
    exitCode: () => child.exitCode,
    kill: signal => child.kill(signal),
    waitForExit: () => contextBriefCitationRssObserverExitWithin(child, RSS_OBSERVER_KILL_TIMEOUT_MILLISECONDS),
  });
});

function contextBriefCitationRssObserverExitWithin(
  child: ReturnType<typeof Bun.spawn>,
  timeoutMilliseconds: number,
): Promise<number | undefined> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve(undefined), timeoutMilliseconds);
    timeout.unref?.();
    void child.exited.then(
      exitCode => {
        clearTimeout(timeout);
        resolve(exitCode);
      },
      () => {
        clearTimeout(timeout);
        resolve(undefined);
      },
    );
  });
}

function contextBriefCitationRssObserverStderr(child: ReturnType<typeof Bun.spawn>): Promise<string> {
  const stream = child.stderr;
  if (!(stream instanceof ReadableStream)) return Promise.resolve('');
  return new Response(stream).text().catch(() => '');
}

const boundedObserverStderr = Effect.fn('contextBriefCitationScale.boundedRssObserverStderr')(function* (
  stderr: Promise<string>,
) {
  const text = yield* Effect.promise(() => stderr);
  return Effect2.pipe(text, EffectString.trim, EffectString.slice(0, 4_096)) || 'no diagnostic';
});

const systemLayer = ScriptSystemInfoLayer;
const commandLayer = ScriptCommandExecutorLayer.pipe(Layer.provide(systemLayer));
const platformLayer = Layer.mergeAll(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));
const graphInstrumentation = makeContextBriefCitationScaleGraphInstrumentation();
const graphInstrumentationLayer = Layer.succeed(ContextBriefCitationScaleGraphInstrumentation, graphInstrumentation);
const realStoreLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(platformLayer));
const instrumentedStoreLayer = Layer.effect(
  CodeGraphStore,
  Effect.gen(function* () {
    const store = yield* CodeGraphStore;
    return CodeGraphStore.of(graphInstrumentation.instrumentStore(store));
  }),
).pipe(Layer.provide(realStoreLayer));
const forbiddenMaintenance = () =>
  graphInstrumentation.recordMaintenanceRequest.pipe(
    Effect.andThen(Effect.die(new Error('Scale benchmark must not run graph maintenance.'))),
  );
const queryDependencies = Layer.mergeAll(
  platformLayer,
  graphInstrumentationLayer,
  instrumentedStoreLayer,
  Layer.succeed(CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry([])),
  Layer.succeed(
    CodeGraphIndexer,
    CodeGraphIndexer.of({
      ensureCommit: () =>
        graphInstrumentation.recordColdGraphBuild.pipe(
          Effect.andThen(Effect.die(new Error('Scale benchmark must not start commit indexing.'))),
        ),
      index: () =>
        graphInstrumentation.recordColdGraphBuild.pipe(
          Effect.andThen(Effect.die(new Error('Scale benchmark must not start graph indexing.'))),
        ),
    }),
  ),
  Layer.succeed(
    CodeGraphMaintenanceCoordinator,
    CodeGraphMaintenanceCoordinator.of({
      kickOrdinary: forbiddenMaintenance,
      kickReconciliation: forbiddenMaintenance,
      kickResidual: forbiddenMaintenance,
      request: () => graphInstrumentation.recordMaintenanceRequest,
      tick: forbiddenMaintenance,
    }),
  ),
  Layer.succeed(CodeGraphEmbeddingIndex, makeContextBriefCitationScaleEmbeddingIndex(graphInstrumentation)),
);
const targetLayer = CodeGraphQueryService.layer.pipe(Layer.provideMerge(queryDependencies));

if (import.meta.main) {
  const args = process.argv.slice(2);
  BunRuntime.runMain(
    isContextBriefCitationRssObserverMode(args)
      ? provideScriptLayer(runContextBriefCitationRssObserverMode(args), platformLayer)
      : provideScriptLayer(program, targetLayer),
  );
}
