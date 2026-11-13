import {type FFIFunction} from 'bun:ffi';
import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {it as effectIt} from '@effect/vitest';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import * as BunServices from '@effect/platform-bun/BunServices';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Queue,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {SystemInfo} from '@threadnote/platform/system';
import * as platformSystem from '@threadnote/platform/system';
import {TestClock as SemanticTestClock} from 'effect/testing';
import {CommandCleanupUnconfirmed, CommandExecutor} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {semanticTreeDigest} from '../../src/semantic/fingerprint.js';
import * as fingerprint from '../../src/semantic/fingerprint.js';
import {Observation, type QueryOutcome} from '@threadnote/semantic/contracts';
import {makeSemanticReadinessJobs, runSemanticSelectedVerification} from '../../src/semantic/readiness_jobs.js';
import {makeReadDeadline} from '@threadnote/platform/read_deadline';
import {
  makeWindowsSemanticSources,
  takeSemanticPrepared,
  SemanticPrivateSourceEvidence,
  SemanticSessionFault,
  SemanticJavaRuntimeVerifier,
  SemanticSetupFault,
  type SemanticSession,
  type DiagnosticDelta,
} from '../../src/semantic/provider.js';
import {
  makeSemanticAdmission,
  makeSemanticCoordinator,
  ensureSemanticEndpoint,
  serveSemanticEndpoint,
  requestSemanticEndpoint,
  semanticCatalogKey,
  verifyJavaSemanticCandidate,
  type JavaHostCandidate,
} from '../../src/semantic/coordinator.js';
import * as javaProvider from '../../src/semantic/providers/java.js';
import * as javaRuntime from '../../src/semantic/providers/java_runtime.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';
import {
  LspFrameDecoder,
  LspFault,
  encodeLspFrame,
  makeLspClient,
  spawnLspWire,
  SemanticWireStartup,
  type LspWire,
  type WireStop,
} from '../../src/semantic/lsp_transport.js';
// Intercept only libraries opened in the panic fixture's scope, using the same native seam as provider-process tests.
const nativeWaitpidSample = vi.hoisted(() => ({
  active: undefined as ((symbols: object) => void) | undefined,
}));
vi.mock('bun:ffi', async importOriginal => {
  const real = await importOriginal<typeof import('bun:ffi')>();
  return {
    ...real,
    dlopen: <Fns extends Record<string, FFIFunction>>(name: Parameters<typeof real.dlopen>[0], symbols: Fns) => {
      const library = real.dlopen(name, symbols);
      nativeWaitpidSample.active?.(library.symbols);
      return library;
    },
  };
});

type Message = Parameters<LspWire['send']>[0];
const fakeWire = Effect.gen(function* () {
  const incoming = yield* Queue.bounded<Message, Cause.Done>(64);
  const sent = yield* Queue.bounded<Message>(128);
  let finishes = 0;
  const wire: LspWire = {
    pid: 1,
    messages: Stream.fromQueue(incoming),
    failure: () => undefined,
    beginClosing: Effect.void,
    send: message =>
      Effect.sync(() => {
        if (message.method === 'shutdown') Queue.offerUnsafe(incoming, {jsonrpc: '2.0', id: message.id, result: null});
        else Queue.offerUnsafe(sent, message);
      }),
    finish: Effect.gen(function* () {
      finishes++;
      yield* Queue.end(incoming);
      return {code: 0, drained: true, forced: false, stdioClosed: true, fault: undefined};
    }),
  };
  return {wire, sent, incoming, finishes: () => finishes};
});
const admissionLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, cryptoLayer, TestSystemInfoLayer);
const javaCandidate = (): JavaHostCandidate => ({
  runtimeCandidate: {
    serverDirectory: '/qualified/jdtls',
    serverTreeDigest: javaRuntime.javaRuntimeQualification.serverTreeDigest,
    runtimeJavaHome: '/qualified/jdk25',
    runtimeSdkDigest: javaRuntime.javaRuntimeQualification.runtimeSdkDigest,
    projectJavaHome: '/qualified/jdk21',
    projectSdkDigest: javaRuntime.javaRuntimeQualification.projectSdkDigest,
  },
  environments: [
    {id: 'prepared-main', metadataFile: '/prepared/model.json', metadataDigest: sha256HexSync('prepared')},
  ],
});
const JavaCoordinatorTestLayer = Layer.effectContext(
  Layer.build(
    Layer.mergeAll(
      admissionLayer,
      Layer.succeed(ChildEnvironmentPolicy, {sanitizeExternal: () => ({}), preserveIntendedChild: () => ({})}),
      Layer.succeed(CommandExecutor, {
        execute: () => Effect.die('Java analysis must not run a host version/build command'),
        executeStreaming: () => Effect.die('Java analysis must not stream a build'),
      }),
    ),
  ).pipe(TestClock.withLive),
);
const javaCoordinatorFixture = Effect.fn('test.javaCoordinatorFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-coordinator-'}));
  const project = path.join(root, 'source');
  const home = path.join(root, 'home');
  for (const directory of [project, home]) yield* fs.makeDirectory(directory, {mode: 0o700});
  const text = 'class Main {}\n';
  const file = path.join(project, 'Main.java');
  yield* fs.writeFileString(file, text);
  const projectUri = (yield* path.toFileUrl(project)).href;
  const basis: Observation = {
    version: 1,
    repository: 'java-coordinator-test',
    worktree: projectUri,
    project: projectUri,
    configuration: sha256HexSync('initial'),
    toolchain: sha256HexSync('initial SDK'),
    provider: {id: 'jdtls', version: javaRuntime.javaRuntimeQualification.serverVersion, generation: 0},
    view: {kind: 'overlay', id: 'main', owner: 'test-owner', epoch: 0},
    uri: (yield* path.toFileUrl(file)).href,
    content: sha256HexSync(text),
    documentVersion: 1,
    projectEpoch: 0,
  };
  const defaultCandidate = javaCandidate();
  const sdkDirectory = path.join(root, 'sdk');
  const candidate = {
    ...defaultCandidate,
    runtimeCandidate: {
      ...defaultCandidate.runtimeCandidate,
      serverDirectory: path.join(sdkDirectory, 'jdtls'),
      runtimeJavaHome: path.join(sdkDirectory, 'jdk25'),
      projectJavaHome: path.join(sdkDirectory, 'jdk21'),
    },
  };
  yield* fs.makeDirectory(sdkDirectory, {mode: 0o700});
  for (const directory of [
    candidate.runtimeCandidate.serverDirectory,
    candidate.runtimeCandidate.runtimeJavaHome,
    candidate.runtimeCandidate.projectJavaHome,
  ])
    yield* fs.makeDirectory(directory, {mode: 0o700});
  const events: string[] = [];
  const upsertStarted = yield* Deferred.make<void>();
  const terminated = yield* Deferred.make<void>();
  const control: {
    failAfterPid: boolean;
    rejectSdk: boolean;
    crash: boolean;
    graceful: boolean;
    available: boolean;
    afterCommit: Effect.Effect<void, unknown>;
    blockUpsert: boolean;
    terminations: number;
    beforeSourceCapture: Effect.Effect<void>;
  } = {
    failAfterPid: false,
    rejectSdk: false,
    crash: false,
    graceful: true,
    available: true,
    afterCommit: Effect.void,
    blockUpsert: false,
    terminations: 0,
    beforeSourceCapture: Effect.void,
  };
  const constructions: {options: javaProvider.JavaAnalysisOptions; isActive: () => boolean}[] = [];
  let finishes = 0;
  // SDK/process construction are mocked; coordinator admission, selection, fingerprints and closure are real.
  const sdk = vi.spyOn(javaRuntime, 'makeJavaRuntime').mockImplementation(() =>
    Effect.suspend(() => {
      events.push('verify-sdk');
      return control.rejectSdk
        ? Effect.fail(
            SemanticSetupFault.make({
              providerId: 'jdtls',
              component: 'sdk',
              reason: 'incompatible',
              requiredVersion: javaRuntime.javaRuntimeQualification.serverVersion,
              requiredSdkVersion: javaRuntime.javaRuntimeQualification.runtimeVersion,
              nextAction: 'Restore the qualified fixture SDK',
            }),
          )
        : Effect.succeed({
            identity: sha256HexSync('fixture SDK'),
            projectJavaHome: candidate.runtimeCandidate.projectJavaHome,
            verify: Effect.sync((): undefined => {}),
            analysis: () => Effect.die('The coordinator must use the analysis factory'),
            preparation: () => Effect.die('The coordinator must never import or build'),
          });
    }),
  );
  const factory = vi
    .spyOn(javaProvider, 'makeJavaAnalysis')
    .mockImplementation((options, started, active, captureEditSource) =>
      Effect.gen(function* () {
        yield* Schema.decodeEffect(Observation)(options.basis);
        const startup = yield* SemanticWireStartup;
        const sourceEvidence = yield* SemanticPrivateSourceEvidence;
        const mutations = yield* Semaphore.make(1);
        startup?.termination(
          Effect.gen(function* () {
            control.terminations++;
            yield* Deferred.succeed(terminated, undefined);
          }),
        );
        const isActive = active ?? (() => true);
        constructions.push({options: structuredClone(options), isActive});
        let ended = false;
        const finish = Effect.sync(() => {
          if (!ended) finishes++;
          ended = true;
          startup?.cleanup('drained');
          return {code: 0, drained: true, stdioClosed: true, forced: false, fault: undefined};
        });
        yield* started(process.pid, finish);
        events.push('pid-bound');
        if (control.failAfterPid) return yield* LspFault.make({code: 'protocol'});
        const documents = new Map<string, Observation>();
        const outcome = (observation: Observation): QueryOutcome => ({
          version: 1,
          status: 'ok',
          items: [],
          evidence: {
            basis: 'semantic',
            observation,
            scope: 'project:fixture',
            completeness: 'partial',
            limitations: [],
          },
        });
        const api = {
          upsert: (observation: Observation, _text: string, language: string) =>
            mutations.withPermit(
              Effect.gen(function* () {
                if (control.blockUpsert) {
                  yield* Deferred.succeed(upsertStarted, undefined);
                  return yield* Effect.never.pipe(Effect.ensuring(Deferred.await(terminated)));
                }
                expect(language).toBe('java');
                if (sourceEvidence && observation.documentVersion === null) {
                  if (!captureEditSource) return yield* SemanticSessionFault.make({reason: 'stale'});
                  yield* control.beforeSourceCapture;
                  const captured = yield* captureEditSource(observation.uri);
                  yield* sourceEvidence.beforeUpsert(captured, documents.get(observation.uri));
                  yield* sourceEvidence.bind(captured, observation);
                }
                documents.set(observation.uri, structuredClone(observation));
                return observation;
              }),
            ),
          query: (_operation: Parameters<SemanticSession['query']>[0], observation: Observation) =>
            Effect.suspend(() => {
              if (control.crash) return LspFault.make({code: 'exit'});
              if (control.rejectSdk) {
                control.available = false;
                return LspFault.make({code: 'prerequisite'});
              }
              return Effect.succeed(outcome(observation));
            }),
          diagnostics: (observation: Observation) =>
            Effect.gen(function* () {
              if (!isActive()) return yield* LspFault.make({code: 'closing'});
              events.push('diagnostic-committed');
              const delta: DiagnosticDelta = {observation, items: [], added: [], remaining: [], resolved: []};
              yield* control.afterCommit;
              return delta;
            }),
          prepare: (_operation: Parameters<NonNullable<SemanticSession['prepare']>>[0], observation: Observation) =>
            Effect.succeed(outcome(observation)),
          observation: (uri: string) => Effect.succeed(documents.get(uri)),
          project: () =>
            Effect.succeed({
              configuration: options.basis.configuration,
              profile: {kind: 'prepared-java', build: 'maven'},
            }),
          available: Effect.sync(() => !ended && control.available),
          invalidate: Effect.gen(function* () {
            expect((yield* mutations.withPermitsIfAvailable(1)(Effect.void))._tag).toBe('Some');
            expect(isActive()).toBe(false);
            events.push('invalidate');
          }),
          close: finish.pipe(Effect.map(receipt => ({...receipt, graceful: control.graceful}))),
        };
        return {pid: process.pid, api};
      }),
    );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      sdk.mockRestore();
      factory.mockRestore();
    }),
  );
  return {
    fs,
    path,
    root,
    project,
    home,
    text,
    file,
    basis,
    candidate,
    events,
    control,
    upsertStarted,
    terminated,
    constructions,
    factory,
    sdk,
    finishes: () => finishes,
    make: () => makeSemanticCoordinator({enabled: true, dataHome: home, java: candidate, worktree: basis.worktree}),
  };
});

describe.skipIf(process.platform === 'win32')('Java coordinator registration', () => {
  effectIt.layer(JavaCoordinatorTestLayer, {buildPerTest: true})(layerIt => {
    // Positive delegation requires actual source-owned host pins; this is not all-platform SDK proof.
    layerIt.effect.skipIf(javaRuntime.javaRuntimePinsForHost() === undefined)(
      'Java runtime delegates repeated proof to the host port and retains the original refusing default',
      () =>
        Effect.gen(function* () {
          const f = yield* javaCoordinatorFixture();
          f.sdk.mockRestore();
          let proofs = 0;
          const runtime = yield* javaRuntime.makeJavaRuntime(f.candidate.runtimeCandidate).pipe(
            Effect.provideService(SemanticJavaRuntimeVerifier, candidate =>
              Effect.sync(() => {
                expect(candidate).toEqual(f.candidate.runtimeCandidate);
                proofs++;
              }),
            ),
          );
          expect(proofs).toBe(1);
          yield* runtime.verify;
          expect(proofs).toBe(2);
          // These authored directories contain no SDK; absence of a trusted host port must still refuse them.
          const refused = yield* javaRuntime.makeJavaRuntime(f.candidate.runtimeCandidate).pipe(Effect.result);
          expect(refused._tag).toBe('Failure');
          const original = yield* verifyJavaSemanticCandidate(f.candidate).pipe(
            Effect.provideService(SemanticJavaRuntimeVerifier, () => Effect.void),
            Effect.result,
          );
          expect(original._tag).toBe('Failure');
          expect(f.factory).not.toHaveBeenCalled();
        }).pipe(TestClock.withLive),
    );
    layerIt.effect.skipIf(javaRuntime.javaRuntimePinsForHost() !== undefined)(
      'Java runtime refuses an unvetted host before invoking the host verifier port',
      () =>
        Effect.gen(function* () {
          const f = yield* javaCoordinatorFixture();
          f.sdk.mockRestore();
          let proofs = 0;
          const refused = yield* javaRuntime.makeJavaRuntime(f.candidate.runtimeCandidate).pipe(
            Effect.provideService(SemanticJavaRuntimeVerifier, () =>
              Effect.sync(() => {
                proofs++;
              }),
            ),
            Effect.result,
          );
          expect(refused).toMatchObject({
            _tag: 'Failure',
            failure: {_tag: 'SemanticSetupFault', providerId: 'jdtls', reason: 'incompatible', component: 'provider'},
          });
          expect(proofs).toBe(0);
          const original = yield* javaRuntime.makeJavaRuntime(f.candidate.runtimeCandidate).pipe(Effect.result);
          expect(original._tag).toBe('Failure');
          const candidate = yield* verifyJavaSemanticCandidate(f.candidate).pipe(
            Effect.provideService(SemanticJavaRuntimeVerifier, () => Effect.void),
            Effect.result,
          );
          expect(candidate._tag).toBe('Failure');
          expect(f.factory).not.toHaveBeenCalled();
        }).pipe(TestClock.withLive),
    );
    layerIt.effect('interrupts a blocked owned semantic query when its HTTP client aborts', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        let delegated = 0;
        const original = f.factory.getMockImplementation();
        if (!original) throw new Error('Expected the owned analysis fixture');
        f.factory.mockImplementation((...arguments_) =>
          original(...arguments_).pipe(
            Effect.map(analysis => ({
              ...analysis,
              api: {
                ...analysis.api,
                query: (...request: Parameters<SemanticSession['query']>) =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(entered, undefined);
                    // Block before any query result or Java diagnostic publication commits.
                    yield* Deferred.await(release).pipe(
                      Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                    );
                    delegated++;
                    return yield* analysis.api.query(...request);
                  }),
              },
            })),
          ),
        );
        const coordinator = yield* f.make();
        const directory = yield* f.fs.realPath(
          yield* f.fs.makeTempDirectoryScoped({prefix: 'tn-abort-', directory: '/tmp'}),
        );
        const token = sha256HexSync('owned-http-abort');
        const endpoint = yield* serveSemanticEndpoint(coordinator, {directory, token, worktree: f.basis.worktree});
        const attachedReply = yield* requestSemanticEndpoint(endpoint.socket, token, {
          operation: 'attach',
          observation: f.basis,
          text: f.text,
          language: 'java',
          environment: 'prepared-main',
        });
        const attachment = Schema.Struct({observation: Observation, capability: Schema.String});
        const refusal = Schema.decodeUnknownResult(
          Schema.Struct({
            status: Schema.Literals(['unavailable', 'experimental', 'ok']),
            reason: Schema.optionalKey(
              Schema.Literals([
                'protocol',
                'prerequisite',
                'rejected',
                'setup',
                'capacity',
                'conflict',
                'closing',
                'stale',
              ]),
            ),
            setup: Schema.optionalKey(
              Schema.Struct({
                component: Schema.Literals(['provider', 'sdk', 'runtime', 'project']),
                reason: Schema.Literals(['missing', 'incompatible', 'unavailable']),
              }),
            ),
          }),
        )(attachedReply);
        const safeRefusal =
          refusal._tag === 'Success'
            ? {
                status: refusal.success.status,
                reason: refusal.success.reason,
                kind: refusal.success.setup?.component,
                code: refusal.success.setup?.reason,
              }
            : {status: 'unrecognized-refusal'};
        expect(Schema.is(attachment)(attachedReply), JSON.stringify(safeRefusal)).toBe(true);
        const attached = yield* Schema.decodeUnknownEffect(attachment)(attachedReply);
        const query = () =>
          requestSemanticEndpoint(
            endpoint.socket,
            token,
            {
              operation: 'query',
              observation: attached.observation,
              query: 'symbols',
              milliseconds: 10000,
            },
            attached.capability,
          );
        yield* Effect.gen(function* () {
          const client = yield* Effect.forkChild(query());
          yield* Deferred.await(entered);
          expect(delegated).toBe(0);
          yield* Fiber.interrupt(client);
          const clientExit = yield* Fiber.await(client);
          expect(clientExit._tag).toBe('Failure');
          // Real loopback synchronization only; this is not a250ms cancellation/native-drain benchmark.
          const cancelled = yield* Deferred.await(interrupted).pipe(Effect.timeoutOption(1000));
          expect(cancelled._tag, 'The server query must observe client abort before the release gate opens').toBe(
            'Some',
          );
          expect(delegated).toBe(0);
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
        expect(yield* query()).toMatchObject({status: 'ok'});
        expect(delegated).toBe(1);
        expect(yield* f.fs.readFileString(f.file)).toBe(f.text);
        expect(f.control.terminations).toBe(0);
        yield* requestSemanticEndpoint(
          endpoint.socket,
          token,
          {operation: 'close', observation: attached.observation},
          attached.capability,
        );
        expect(f.finishes()).toBe(1);
        expect(yield* coordinator.status).toMatchObject({providers: 0, queued: 0, quarantined: 0});
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('old generations cannot poison or retire a healthy replacement source session', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const native = yield* privateNativeSourceOracle(f.text);
        const platform = vi.spyOn(platformSystem, 'runtimePlatform', 'get').mockReturnValue('win32');
        yield* Effect.addFinalizer(() => Effect.sync(() => platform.mockRestore()));
        const coordinator = yield* f.make();
        const basis = {...f.basis, view: {...f.basis.view, kind: 'disk' as const}, documentVersion: null};
        const previous = yield* coordinator.attach(basis, f.text, 'java', 'prepared-main');
        yield* coordinator.closeView(previous.observation);
        const current = yield* coordinator.attach(basis, f.text, 'java', 'prepared-main');
        expect(current.observation.provider.generation).toBeGreaterThan(previous.observation.provider.generation);
        const captures = native.capture.mock.calls.length;
        expect(yield* Effect.flip(coordinator.use(previous.observation, 1000, () => Effect.void))).toMatchObject({
          _tag: 'SemanticSessionFault',
          reason: 'stale',
        });
        expect(native.capture.mock.calls.length).toBe(captures);
        expect(f.finishes()).toBe(1);
        expect(f.constructions[1].isActive()).toBe(true);
        expect(
          yield* coordinator.use(current.observation, 1000, api =>
            api.query('symbols', current.observation, undefined, 1000),
          ),
        ).toMatchObject({status: 'ok'});
        expect(yield* coordinator.status).toMatchObject({providers: 1, quarantined: 0, failures: []});
        yield* coordinator.closeView(current.observation);
        expect(f.finishes()).toBe(2);
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('an in-flight prepared result cannot poison a replacement source issuer', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const native = yield* privateNativeSourceOracle(f.text);
        const platform = vi.spyOn(platformSystem, 'runtimePlatform', 'get').mockReturnValue('win32');
        yield* Effect.addFinalizer(() => Effect.sync(() => platform.mockRestore()));
        const original = f.factory.getMockImplementation();
        if (!original) throw new Error('Missing owned provider fixture');
        f.factory.mockImplementation((options, started, active, capture) =>
          Effect.gen(function* () {
            const source = yield* SemanticPrivateSourceEvidence;
            const managed = yield* original(options, started, active, capture);
            return {
              ...managed,
              api: {
                ...managed.api,
                prepare: (_operation, observation) =>
                  Effect.gen(function* () {
                    if (!source || !capture) return yield* SemanticSessionFault.make({reason: 'stale'});
                    const captured = yield* capture(observation.uri);
                    const outcome: QueryOutcome = {
                      version: 1,
                      status: 'ok',
                      evidence: {
                        basis: 'semantic',
                        observation,
                        scope: 'project',
                        completeness: 'complete',
                        limitations: [],
                      },
                      items: [
                        {
                          kind: 'prepared-edit',
                          operation: 'rename',
                          sourceBasis: 'pre-request-synchronized-text-v1',
                          files: [{uri: observation.uri, content: observation.content, source: 'disk', observation}],
                        },
                      ],
                    };
                    yield* source.prepared(outcome, [{capture: captured, observation}]);
                    return outcome;
                  }),
              },
            };
          }),
        );
        const coordinator = yield* f.make();
        const basis = {...f.basis, view: {...f.basis.view, kind: 'disk' as const}, documentVersion: null};
        const previous = yield* coordinator.attach(basis, f.text, 'java', 'prepared-main');
        let replacement: Observation | undefined;
        let beforeJoin = 0;
        const refused = yield* coordinator
          .usePrepared(previous.observation, 1000, api =>
            Effect.gen(function* () {
              if (!api.prepare) return yield* SemanticSessionFault.make({reason: 'stale'});
              const produced = yield* api.prepare(
                'rename',
                previous.observation,
                {line: 0, character: 0},
                'Next',
                1000,
              );
              // The producing adapter has returned. Retire/install while the old host query is still in flight.
              yield* coordinator.closeView(previous.observation);
              replacement = (yield* coordinator.attach(basis, f.text, 'java', 'prepared-main')).observation;
              beforeJoin = native.capture.mock.calls.length;
              return produced;
            }),
          )
          .pipe(Effect.flip);
        expect(refused).toMatchObject({_tag: 'SemanticSessionFault', reason: 'stale'});
        expect(native.capture.mock.calls.length).toBe(beforeJoin);
        expect(f.finishes()).toBe(1);
        expect(f.factory).toHaveBeenCalledTimes(2);
        expect(f.constructions[1].isActive()).toBe(true);
        if (!replacement) throw new Error('Missing replacement observation');
        const current = replacement;
        const prepared = yield* coordinator.usePrepared(current, 1000, api => {
          if (!api.prepare) return SemanticSessionFault.make({reason: 'stale'});
          return api.prepare('rename', current, {line: 0, character: 0}, 'Next', 1000);
        });
        if (prepared.kind !== 'writer-prepared') throw new Error('Expected current issuer proof');
        prepared.assertCurrentSync();
        expect(yield* coordinator.status).toMatchObject({providers: 1, quarantined: 0, failures: []});
        expect(f.finishes()).toBe(1);
        yield* coordinator.closeView(current);
        expect(f.finishes()).toBe(2);
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('two initial source races keep stale classification and leave a stable attach available', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const native = yield* privateNativeSourceOracle(f.text);
        const platform = vi.spyOn(platformSystem, 'runtimePlatform', 'get').mockReturnValue('win32');
        yield* Effect.addFinalizer(() => Effect.sync(() => platform.mockRestore()));
        const coordinator = yield* f.make();
        const basis = {...f.basis, view: {...f.basis.view, kind: 'disk' as const}, documentVersion: null};
        native.text(f.text + '\n');
        expect(yield* Effect.flip(coordinator.attach(basis, f.text, 'java', 'prepared-main'))).toMatchObject({
          _tag: 'SemanticSessionFault',
          reason: 'stale',
        });
        expect(f.factory).not.toHaveBeenCalled();
        expect(yield* coordinator.status).toMatchObject({providers: 0, quarantined: 0, failures: []});
        native.text(f.text);
        f.control.beforeSourceCapture = Effect.sync(() => native.text(f.text + '\n'));
        expect(yield* Effect.flip(coordinator.attach(basis, f.text, 'java', 'prepared-main'))).toMatchObject({
          _tag: 'SemanticSessionFault',
          reason: 'stale',
        });
        expect(f.factory).toHaveBeenCalledOnce();
        expect(f.finishes()).toBe(1); // The post-launch race released only after the original owned finish.
        expect(yield* coordinator.status).toMatchObject({providers: 0, quarantined: 0, failures: []});
        native.text(f.text);
        f.control.beforeSourceCapture = Effect.void;
        const stable = yield* coordinator.attach(basis, f.text, 'java', 'prepared-main');
        expect(stable.observation.provider.generation).toBe(2);
        expect(f.factory).toHaveBeenCalledTimes(2);
        expect(yield* coordinator.status).toMatchObject({providers: 1, quarantined: 0, failures: []});
        yield* coordinator.closeView(stable.observation);
        expect(f.finishes()).toBe(2);
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('a current native mismatch retires only after the adapter mutation permit unwinds', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const native = yield* privateNativeSourceOracle(f.text);
        const platform = vi.spyOn(platformSystem, 'runtimePlatform', 'get').mockReturnValue('win32');
        yield* Effect.addFinalizer(() => Effect.sync(() => platform.mockRestore()));
        const coordinator = yield* f.make();
        const basis = {...f.basis, view: {...f.basis.view, kind: 'disk' as const}, documentVersion: null};
        const previous = yield* coordinator.attach(basis, f.text, 'java', 'prepared-main');
        native.change('replaced-native-object', 0);
        expect(yield* Effect.flip(coordinator.attach(basis, f.text, 'java', 'prepared-main'))).toMatchObject({
          _tag: 'SemanticSessionFault',
          reason: 'stale',
        });
        expect(f.events).toContain('invalidate'); // invalidate independently reacquires the actual test semaphore.
        expect(f.constructions[0].isActive()).toBe(false);
        expect(f.finishes()).toBe(1);
        expect(yield* coordinator.status).toMatchObject({providers: 0, quarantined: 0, failures: []});
        native.change('original', 0);
        const next = yield* coordinator.attach(basis, f.text, 'java', 'prepared-main');
        expect(next.observation.provider.generation).toBeGreaterThan(previous.observation.provider.generation);
        expect(f.constructions[1].isActive()).toBe(true);
        yield* coordinator.closeView(next.observation);
      }).pipe(TestClock.withLive),
    );
    layerIt.effect(
      'cold saved-disk creation supplies the computed configuration digest to the real provider basis boundary',
      () =>
        Effect.gen(function* () {
          const f = yield* javaCoordinatorFixture();
          const coordinator = yield* f.make();
          const basis = {...f.basis, view: {...f.basis.view, kind: 'disk' as const}, documentVersion: null};
          const result = yield* coordinator.attach(basis, f.text, 'java', 'prepared-main');
          const expected = yield* semanticTreeDigest(f.project);
          expect(f.constructions[0].options.basis.configuration).toBe(expected);
          expect(result.observation.configuration).toBe(expected);
          expect(Schema.is(Observation)(result.observation)).toBe(true);
          yield* coordinator.closeView(result.observation);
        }).pipe(TestClock.withLive),
    );
    layerIt.effect(
      'configuration verification cleanup uncertainty quarantines admitted creation with or without startup control',
      () =>
        Effect.gen(function* () {
          for (const supplied of [false, true]) {
            const f = yield* javaCoordinatorFixture();
            let unknown = false;
            const deadline = yield* makeReadDeadline(120000);
            const error = CommandCleanupUnconfirmed.make({
              executable: 'fixture',
              args: [],
              message: 'Owned cleanup unconfirmed',
            });
            const coordinator = yield* makeSemanticCoordinator({
              enabled: true,
              dataHome: f.home,
              java: f.candidate,
              worktree: f.basis.worktree,
              verifySelected: (_id, _candidate, _runtime, configurationOnly) =>
                configurationOnly ? Effect.fail(error) : Effect.succeed(sha256HexSync('verified')),
            });
            const result = yield* Effect.exit(
              coordinator.attach(
                f.basis,
                f.text,
                'java',
                'prepared-main',
                supplied
                  ? {
                      deadline,
                      remaining: Effect.succeed(118000),
                      stage: () => Effect.void,
                      termination: () => {},
                      cleanup: disposition => {
                        unknown ||= disposition === 'unknown';
                      },
                      cleanupUnknown: () => unknown,
                    }
                  : undefined,
              ),
            );
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure')
              expect(Cause.findErrorOption(result.cause)).toMatchObject({value: {_tag: 'CommandCleanupUnconfirmed'}});
            expect(unknown).toBe(supplied);
            expect(f.factory).not.toHaveBeenCalled();
            expect(yield* coordinator.status).toMatchObject({providers: 1, quarantined: 1, imports: 0});
          }
        }).pipe(TestClock.withLive),
    );
    layerIt.effect(
      'an uncertain warm configuration worker also conserves the original session reservation on close',
      () =>
        Effect.gen(function* () {
          const f = yield* javaCoordinatorFixture();
          let uncertain = false;
          const configuration = yield* semanticTreeDigest(f.project);
          const error = CommandCleanupUnconfirmed.make({
            executable: 'fixture',
            args: [],
            message: 'Owned cleanup unconfirmed',
          });
          const coordinator = yield* makeSemanticCoordinator({
            enabled: true,
            dataHome: f.home,
            java: f.candidate,
            worktree: f.basis.worktree,
            verifySelected: (_id, _candidate, _runtime, configurationOnly) =>
              !configurationOnly
                ? Effect.succeed(sha256HexSync('verified'))
                : uncertain
                  ? Effect.fail(error)
                  : Effect.succeed(configuration),
          });
          const attached = yield* coordinator.attach(f.basis, f.text, 'java', 'prepared-main');
          uncertain = true;
          const result = yield* coordinator.use(attached.observation, 1000, () => Effect.void).pipe(Effect.exit);
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure')
            expect(Cause.findErrorOption(result.cause)).toMatchObject({value: {_tag: 'CommandCleanupUnconfirmed'}});
          yield* coordinator.closeView(attached.observation);
          expect(yield* coordinator.status).toMatchObject({providers: 1, imports: 0, quarantined: 1});
          expect(f.finishes()).toBe(1);
        }).pipe(TestClock.withLive),
    );
    layerIt.effect('warm saved-disk startup binds its cancellation to the retained session capability', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture().pipe(TestClock.withLive);
        const coordinator = yield* f.make().pipe(TestClock.withLive);
        const basis = {...f.basis, view: {...f.basis.view, kind: 'disk' as const}, documentVersion: null};
        yield* coordinator.attach(basis, f.text, 'java', 'prepared-main').pipe(TestClock.withLive);
        f.control.blockUpsert = true;
        const source = {
          worktree: basis.worktree,
          project: basis.project,
          uri: basis.uri,
          language: 'java' as const,
          environment: 'prepared-main',
          profile: sha256HexSync('profile'),
          principal: sha256HexSync('principal'),
        };
        const jobs = yield* makeSemanticReadinessJobs({
          worktree: basis.worktree,
          prepare: (_source, _content, control) =>
            coordinator
              .attach(basis, f.text, 'java', 'prepared-main', control)
              .pipe(Effect.map(result => result.observation)),
          current: () => Effect.succeed(true),
          close: coordinator.closeView,
        });
        const started = yield* jobs.start(source, basis.content);
        if (started.status !== 'ok' || !started.job) throw new Error('Missing startup job');
        yield* Deferred.await(f.upsertStarted);
        const scope = [source.profile, source.principal, source.worktree] as const;
        const cancelled = yield* jobs.cancel(started.job, ...scope);
        expect(cancelled).toMatchObject({status: 'ok', progress: {state: 'cancelling', cleanup: 'pending'}});
        expect(f.control.terminations).toBe(0);
        yield* TestClock.adjust(2000);
        yield* Deferred.await(f.terminated);
        yield* Effect.yieldNow;
        expect(f.control.terminations).toBe(1);
        expect(f.constructions).toHaveLength(1);
        const terminal = yield* jobs.status(started.job, ...scope).pipe(
          Effect.tap(() => Effect.yieldNow),
          Effect.repeat({until: result => result.status === 'ok' && result.progress.state === 'cancelled'}),
        );
        expect(terminal).toMatchObject({
          status: 'ok',
          progress: {state: 'cancelled', cleanup: 'drained'},
        });
        expect(yield* coordinator.status.pipe(TestClock.withLive)).toMatchObject({providers: 0, quarantined: 0});
      }),
    );
    layerIt.effect('reports separate Java SDK requirements without starting a provider', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const coordinator = yield* f.make();
        const first = yield* coordinator.status;
        const expected = {
          // Only the retained Darwin arm64 image has shipped Java execution pins.
          platform: process.platform === 'darwin' && process.arch === 'arm64' ? 'darwin-arm64' : 'unavailable',
          runtimeSdk: {language: 'java', version: '25.0.5+8'},
          projectSdk: {language: 'java', version: '21.0.13+9'},
          nextAction: expect.stringContaining(
            'server Java 25.0.5+8 and separate project Java 21.0.13+9 SDKs with their qualified full-tree digests',
          ),
        };
        expect(first).toMatchObject({
          providers: 0,
          imports: 0,
          sessions: 0,
          providerProfiles: [
            {
              id: 'jdtls',
              version: '1.63.0-202610191322',
              status: 'experimental',
              prerequisites: 'host-qualified-candidate',
              requirements: expected,
              license: {qualification: 'pending', redistribution: 'release-gated'},
              capabilities: {apply: 'unsupported', commands: 'unsupported'},
            },
          ],
        });
        const requirements = first.providerProfiles[0].requirements;
        if (requirements) Reflect.set(requirements.runtimeSdk, 'version', 'caller mutation');
        expect((yield* coordinator.status).providerProfiles[0].requirements).toEqual(expected);
        expect(f.factory).not.toHaveBeenCalled();
      }).pipe(TestClock.withLive),
    );

    layerIt.effect('refuses existing semantic-parent links before they can redirect writes into source or SDKs', () =>
      Effect.gen(function* () {
        for (const role of ['source', 'serverDirectory', 'runtimeJavaHome', 'projectJavaHome', 'missing'] as const)
          yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* javaCoordinatorFixture();
              const target = role === 'source' ? f.project : f.path.join(f.root, 'protected');
              if (role !== 'source' && role !== 'missing') {
                yield* f.fs.makeDirectory(target, {mode: 0o700});
                yield* f.fs.writeFileString(f.path.join(target, 'protected.txt'), 'unchanged');
              }
              const semantic = f.path.join(f.home, 'semantic');
              yield* f.fs.symlink(target, semantic);
              const before = role === 'missing' ? undefined : yield* semanticTreeDigest(target);
              const entries = role === 'missing' ? undefined : yield* f.fs.readDirectory(target);
              const options = {
                enabled: true,
                dataHome: f.home,
                worktree: f.basis.worktree,
                java:
                  role === 'source' || role === 'missing'
                    ? f.candidate
                    : {...f.candidate, runtimeCandidate: {...f.candidate.runtimeCandidate, [role]: target}},
                runtimeIdentity: sha256HexSync('private fixture runtime'),
              };
              for (const endpoint of [false, true]) {
                expect(
                  yield* Effect.flip(
                    endpoint
                      ? ensureSemanticEndpoint(options).pipe(Effect.asVoid)
                      : makeSemanticCoordinator(options).pipe(Effect.asVoid),
                  ),
                ).toMatchObject({code: 'prerequisite'});
                expect(yield* f.fs.readLink(semantic)).toBe(target);
                expect(yield* f.fs.readDirectory(f.home)).toEqual(['semantic']);
                if (role === 'missing') expect(yield* f.fs.exists(target)).toBe(false);
                else {
                  expect(yield* f.fs.readDirectory(target)).toEqual(entries);
                  expect(yield* semanticTreeDigest(target)).toBe(before);
                }
                expect(f.sdk).not.toHaveBeenCalled();
                expect(f.factory).not.toHaveBeenCalled();
              }
            }),
          );
      }).pipe(TestClock.withLive),
    );
    layerIt.effect.prop(
      'refuses shared output overlapping source or any SDK before creating admission, endpoint or lock files',
      [
        Schema.Literals(['source', 'serverDirectory', 'runtimeJavaHome', 'projectJavaHome']),
        Schema.Literals(['same', 'child', 'parent']),
      ],
      ([role, relation]) =>
        Effect.gen(function* () {
          for (const endpoint of [false, true])
            yield* Effect.scoped(
              Effect.gen(function* () {
                const f = yield* javaCoordinatorFixture();
                const protectedRoot = f.path.join(
                  f.root,
                  relation === 'child' ? 'protected' : relation === 'same' ? 'semantic' : 'semantic/protected',
                );
                yield* f.fs.makeDirectory(protectedRoot, {recursive: true, mode: 0o700});
                yield* f.fs.writeFileString(f.path.join(protectedRoot, 'protected.txt'), 'unchanged');
                const home = relation === 'child' ? protectedRoot : f.root;
                const semantic = f.path.join(home, 'semantic');
                const entries = (yield* f.fs.exists(semantic)) ? yield* f.fs.readDirectory(semantic) : undefined;
                const before = yield* semanticTreeDigest(f.root);
                const options = {
                  enabled: true,
                  dataHome: home,
                  worktree: role === 'source' ? (yield* f.path.toFileUrl(protectedRoot)).href : f.basis.worktree,
                  java:
                    role === 'source'
                      ? f.candidate
                      : {
                          ...f.candidate,
                          runtimeCandidate: {...f.candidate.runtimeCandidate, [role]: protectedRoot},
                        },
                  runtimeIdentity: sha256HexSync('private fixture runtime'),
                };
                expect(
                  yield* Effect.flip(
                    endpoint
                      ? ensureSemanticEndpoint(options).pipe(Effect.asVoid)
                      : makeSemanticCoordinator(options).pipe(Effect.asVoid),
                  ),
                ).toMatchObject({code: 'prerequisite'});
                expect(yield* semanticTreeDigest(f.root)).toBe(before);
                expect((yield* f.fs.exists(semantic)) ? yield* f.fs.readDirectory(semantic) : undefined).toEqual(
                  entries,
                );
                expect(f.factory).not.toHaveBeenCalled();
              }),
            );
        }).pipe(TestClock.withLive),
      {arbitrary: {runs: 24}},
    );
    layerIt.effect('requires a canonical Java worktree before any shared write and binds later attachments to it', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const options = {enabled: true, dataHome: f.home, java: f.candidate};
        expect(yield* Effect.flip(makeSemanticCoordinator(options))).toMatchObject({code: 'prerequisite'});
        expect(yield* f.fs.readDirectory(f.home)).toEqual([]);
        const alias = f.path.join(f.root, 'source-alias');
        yield* f.fs.symlink(f.project, alias);
        const worktree = (yield* f.path.toFileUrl(alias)).href;
        for (const endpoint of [false, true]) {
          const launch = {...options, worktree, runtimeIdentity: sha256HexSync('private fixture runtime')};
          expect(
            yield* Effect.flip(
              endpoint
                ? ensureSemanticEndpoint(launch).pipe(Effect.asVoid)
                : makeSemanticCoordinator(launch).pipe(Effect.asVoid),
            ),
          ).toMatchObject({code: 'prerequisite'});
          expect(yield* f.fs.readDirectory(f.home)).toEqual([]);
        }
        const coordinator = yield* f.make();
        expect(
          yield* Effect.flip(coordinator.attach({...f.basis, worktree}, f.text, 'java', 'prepared-main')),
        ).toMatchObject({code: 'prerequisite'});
        expect(f.factory).not.toHaveBeenCalled();
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('checks physical SDK spellings before a shared write can bypass a lexical overlap check', () =>
      Effect.gen(function* () {
        for (const role of ['serverDirectory', 'runtimeJavaHome', 'projectJavaHome'] as const)
          yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* javaCoordinatorFixture();
              f.sdk.mockRestore();
              const runtimeCandidate = {...f.candidate.runtimeCandidate};
              const digests = new Map<string, string>();
              for (const [key, digest] of [
                ['serverDirectory', javaRuntime.javaRuntimeQualification.serverTreeDigest],
                ['runtimeJavaHome', javaRuntime.javaRuntimeQualification.runtimeSdkDigest],
                ['projectJavaHome', javaRuntime.javaRuntimeQualification.projectSdkDigest],
              ] as const) {
                const directory = f.path.join(f.root, key);
                yield* f.fs.makeDirectory(directory, {mode: 0o700});
                yield* f.fs.writeFileString(f.path.join(directory, 'protected.txt'), 'unchanged');
                runtimeCandidate[key] = directory;
                digests.set(directory, digest);
              }
              const home = runtimeCandidate[role];
              const alias = f.path.join(f.root, 'sdk-alias');
              yield* f.fs.symlink(home, alias);
              runtimeCandidate[role] = alias;
              // Only SDK bytes are mocked: production canonical-path validation still runs for every role.
              const hashing = vi
                .spyOn(fingerprint, 'semanticSdkDigest')
                .mockImplementation(root => Effect.succeed(digests.get(root) ?? sha256HexSync('unqualified')));
              yield* Effect.addFinalizer(() => Effect.sync(() => hashing.mockRestore()));
              const protectedRoots = [f.project, ...digests.keys()];
              const before = yield* Effect.forEach(protectedRoots, root => semanticTreeDigest(root));
              const options = {
                enabled: true,
                dataHome: home,
                worktree: f.basis.worktree,
                java: {...f.candidate, runtimeCandidate},
                runtimeIdentity: sha256HexSync('private fixture runtime'),
              };
              for (const endpoint of [false, true]) {
                expect(
                  yield* Effect.flip(
                    endpoint
                      ? ensureSemanticEndpoint(options).pipe(Effect.asVoid)
                      : makeSemanticCoordinator(options).pipe(Effect.asVoid),
                  ),
                ).toMatchObject({_tag: 'SemanticSetupFault', reason: 'incompatible'});
                expect(yield* f.fs.readDirectory(home)).toEqual(['protected.txt']);
                expect(yield* Effect.forEach(protectedRoots, root => semanticTreeDigest(root))).toEqual(before);
                expect(f.factory).not.toHaveBeenCalled();
              }
            }),
          );
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('rejects malformed catalogs before SDK access and preserves typed SDK setup failures', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        for (const candidate of [
          {...f.candidate, environments: []},
          {...f.candidate, environments: [f.candidate.environments[0], f.candidate.environments[0]]},
          {...f.candidate, preparation: {build: 'maven'}},
          {...f.candidate, runtimeCandidate: {...f.candidate.runtimeCandidate, commands: ['build']}},
          {...f.candidate, environments: [{...f.candidate.environments[0], policy: 'trusted'}]},
        ])
          expect(yield* Effect.flip(verifyJavaSemanticCandidate(candidate))).toMatchObject({code: 'prerequisite'});
        expect(f.sdk).not.toHaveBeenCalled();
        f.control.rejectSdk = true;
        const coordinator = yield* f.make();
        expect(f.sdk).not.toHaveBeenCalled();
        expect(yield* Effect.flip(coordinator.attach(f.basis, f.text, 'java', 'prepared-main'))).toMatchObject({
          _tag: 'SemanticSetupFault',
          component: 'sdk',
          reason: 'incompatible',
        });
        expect(yield* coordinator.status).toMatchObject({providers: 0, imports: 0, quarantined: 0});
        expect(yield* f.fs.exists(f.path.join(f.home, 'semantic', 'environments'))).toBe(false);
        expect(f.factory).not.toHaveBeenCalled();
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('selects an explicit sealed environment and binds PID before exposing the session', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const coordinator = yield* f.make();
        const attached = yield* coordinator.attach(f.basis, f.text, 'java', 'prepared-main');
        expect(f.constructions).toHaveLength(1);
        expect(f.constructions[0].options.candidate).toEqual(f.candidate.runtimeCandidate);
        expect(f.constructions[0].options.environment).toEqual(f.candidate.environments[0]);
        expect((yield* coordinator.status).providers).toBe(1);
        expect((yield* coordinator.status).imports).toBe(0);
        expect(attached.observation.provider.id).toBe('jdtls');
        expect(attached.edits).toBe('preparation-only');
        yield* coordinator.closeView(attached.observation);
        expect(f.constructions[0].isActive()).toBe(false);
        expect(f.finishes()).toBe(1);
        expect(yield* coordinator.status).toMatchObject({providers: 0, imports: 0, quarantined: 0});
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('unknown or omitted environment selection cannot launch or reserve a provider', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const coordinator = yield* f.make();
        for (const environment of [undefined, 'unknown']) {
          expect((yield* Effect.exit(coordinator.attach(f.basis, f.text, 'java', environment)))._tag).toBe('Failure');
          expect(yield* coordinator.status).toMatchObject({providers: 0, imports: 0, quarantined: 0});
        }
        expect(f.factory).not.toHaveBeenCalled();
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('initialization failure uses the captured stop receipt to release shared admission', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const coordinator = yield* f.make();
        f.control.failAfterPid = true;
        expect((yield* Effect.exit(coordinator.attach(f.basis, f.text, 'java', 'prepared-main')))._tag).toBe('Failure');
        expect(f.events).toContain('pid-bound');
        expect(f.finishes()).toBe(1);
        expect(yield* coordinator.status).toMatchObject({providers: 0, imports: 0, quarantined: 0});
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('returns the Java committed diagnostic delta without another asynchronous SDK rejection', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const coordinator = yield* f.make();
        const attached = yield* coordinator.attach(f.basis, f.text, 'java', 'prepared-main');
        f.control.afterCommit = Effect.sync(() => {
          f.control.rejectSdk = true;
        });
        const delta = yield* coordinator.use(attached.observation, 1000, api =>
          api.diagnostics(attached.observation, 1000),
        );
        expect(delta.observation).toEqual(attached.observation);
        expect(f.events.at(-1)).toBe('diagnostic-committed');
        f.control.rejectSdk = false;
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('source changes retire the old Java view without starting setup', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const coordinator = yield* f.make();
        const attached = yield* coordinator.attach(f.basis, f.text, 'java', 'prepared-main');
        yield* f.fs.writeFileString(f.file, 'class Changed {}\n');
        expect(
          (yield* Effect.exit(
            coordinator.use(attached.observation, 1000, api =>
              api.query('definition', attached.observation, {line: 0, character: 1}, 1000),
            ),
          ))._tag,
        ).toBe('Failure');
        expect(f.finishes()).toBe(1);
        expect(f.factory).toHaveBeenCalledOnce();
        expect(yield* coordinator.status).toMatchObject({providers: 0, imports: 0, quarantined: 0});
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('a retired Java API releases the provider before returning its prerequisite failure', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const coordinator = yield* f.make();
        const attached = yield* coordinator.attach(f.basis, f.text, 'java', 'prepared-main');
        f.control.rejectSdk = true;
        expect(
          yield* Effect.flip(
            coordinator.use(attached.observation, 1000, api =>
              api.query('definition', attached.observation, {line: 0, character: 1}, 1000),
            ),
          ),
        ).toMatchObject({code: 'prerequisite'});
        expect(f.finishes()).toBe(1);
        expect(yield* coordinator.status).toMatchObject({providers: 0, imports: 0, quarantined: 0});
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('switching prepared Java environments retires the old session before reattachment', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const second = {...f.candidate.environments[0], id: 'prepared-second', metadataDigest: sha256HexSync('second')};
        const coordinator = yield* makeSemanticCoordinator({
          enabled: true,
          dataHome: f.home,
          worktree: f.basis.worktree,
          java: {...f.candidate, environments: [...f.candidate.environments, second]},
        });
        const first = yield* coordinator.attach(f.basis, f.text, 'java', 'prepared-main');
        expect(yield* Effect.flip(coordinator.attach(f.basis, f.text, 'java', 'prepared-second'))).toMatchObject({
          code: 'rejected',
        });
        expect(f.constructions[0].isActive()).toBe(false);
        expect((yield* coordinator.status).providers).toBe(0);
        const other = yield* coordinator.attach(f.basis, f.text, 'java', 'prepared-second');
        expect(first.observation.toolchain).not.toBe(other.observation.toolchain);
        expect(f.constructions[1].options.environment).toEqual(second);
        expect((yield* coordinator.status).providers).toBe(1);
        yield* coordinator.closeView(other.observation);
        expect(f.finishes()).toBe(2);
        expect(yield* coordinator.status).toMatchObject({providers: 0, imports: 0, quarantined: 0});
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('Java reads renew the idle lease before the original attachment becomes ten minutes old', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const coordinator = yield* f.make();
        const attached = yield* coordinator.attach(f.basis, f.text, 'java', 'prepared-main');
        yield* TestClock.adjust(590000);
        yield* coordinator.use(attached.observation, 1000, api =>
          api.query('definition', attached.observation, {line: 0, character: 1}, 1000),
        );
        yield* TestClock.adjust(11000);
        expect(f.finishes()).toBe(0);
        expect((yield* coordinator.status.pipe(TestClock.withLive)).providers).toBe(1);
        yield* coordinator.closeView(attached.observation).pipe(TestClock.withLive);
        expect(f.finishes()).toBe(1);
        expect(yield* coordinator.status.pipe(TestClock.withLive)).toMatchObject({
          providers: 0,
          imports: 0,
          quarantined: 0,
        });
      }),
    );
    layerIt.effect('two crashes bound restart attempts and leave no admitted provider', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        const coordinator = yield* f.make();
        for (let attempt = 0; attempt < 2; attempt++) {
          const attached = yield* coordinator.attach(f.basis, f.text, 'java', 'prepared-main');
          f.control.crash = true;
          expect(
            yield* Effect.flip(
              coordinator.use(attached.observation, 1000, api =>
                api.query('definition', attached.observation, {line: 0, character: 1}, 1000),
              ),
            ),
          ).toMatchObject({_tag: 'LspFault', code: 'exit'});
          yield* coordinator.closeView(attached.observation);
          f.control.crash = false;
          expect(yield* coordinator.status).toMatchObject({
            providers: 0,
            imports: 0,
            quarantined: 0,
            failures: [
              {
                attempts: attempt + 1,
                cause: 'exit',
                nextAction:
                  attempt === 0
                    ? 'Reattach an explicit view once prerequisites are ready'
                    : 'Correct prerequisites and restart the idle coordinator explicitly',
              },
            ],
          });
        }
        expect(yield* Effect.flip(coordinator.attach(f.basis, f.text, 'java', 'prepared-main'))).toMatchObject({
          _tag: 'LspFault',
          code: 'prerequisite',
        });
        expect(f.factory).toHaveBeenCalledTimes(2);
        expect(f.finishes()).toBe(2);
        expect(yield* coordinator.status).toMatchObject({providers: 0, imports: 0, quarantined: 0});
      }).pipe(TestClock.withLive),
    );
    layerIt.effect('failed graceful Java shutdowns retain their cause and exhaust the same restart budget', () =>
      Effect.gen(function* () {
        const f = yield* javaCoordinatorFixture();
        f.control.graceful = false;
        const coordinator = yield* f.make();
        for (let attempt = 0; attempt < 2; attempt++) {
          const attached = yield* coordinator.attach(f.basis, f.text, 'java', 'prepared-main');
          yield* coordinator.closeView(attached.observation);
          expect(yield* coordinator.status).toMatchObject({
            providers: 0,
            imports: 0,
            quarantined: 0,
            failures: [
              {
                attempts: attempt + 1,
                cause: 'shutdown',
                nextAction:
                  attempt === 0
                    ? 'Reattach an explicit view once prerequisites are ready'
                    : 'Correct prerequisites and restart the idle coordinator explicitly',
              },
            ],
          });
          expect(f.finishes()).toBe(attempt + 1);
        }
        expect(yield* Effect.flip(coordinator.attach(f.basis, f.text, 'java', 'prepared-main'))).toMatchObject({
          code: 'prerequisite',
        });
        expect(f.factory).toHaveBeenCalledTimes(2);
      }).pipe(TestClock.withLive),
    );
  });
});
describe('Java catalog identity', () => {
  it('catalog identity is deterministic under environment order and binds each SDK role without mutation', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({min: 0, max: 32}), {minLength: 1, maxLength: 8}), ids => {
        const candidate = javaCandidate();
        const environments = EffectArray.map(ids, id => ({
          id: 'env-' + id,
          metadataFile: '/models/' + id + '.json',
          metadataDigest: sha256HexSync(String(id)),
        }));
        const java = {...candidate, environments};
        const before = JSON.stringify(java);
        const key = semanticCatalogKey({java});
        expect(semanticCatalogKey({java: {...java, environments: EffectArray.reverse(environments)}})).toBe(key);
        for (const field of [
          'serverDirectory',
          'serverTreeDigest',
          'runtimeJavaHome',
          'runtimeSdkDigest',
          'projectJavaHome',
          'projectSdkDigest',
        ] as const)
          expect(
            semanticCatalogKey({
              java: {...java, runtimeCandidate: {...java.runtimeCandidate, [field]: sha256HexSync(field)}},
            }),
          ).not.toBe(key);
        expect(
          semanticCatalogKey({
            java: {
              ...java,
              environments: [
                {...environments[0], metadataDigest: sha256HexSync('changed')},
                ...EffectArray.drop(environments, 1),
              ],
            },
          }),
        ).not.toBe(key);
        expect(JSON.stringify(java)).toBe(before);
      }),
      {numRuns: 24},
    );
  });
});
const admissionFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'semantic-admission-'});
  const directory = path.join(yield* fs.realPath(home), 'semantic');
  const first = yield* makeSemanticAdmission({directory});
  const second = yield* makeSemanticAdmission({directory});
  return {first, second, fs, path, directory};
});
describe.skipIf(process.platform === 'win32')('shared semantic admission', () => {
  effectIt.effect(
    'enforces the aggregate provider cap and preserves monotonic generations after release',
    () =>
      Effect.gen(function* () {
        const {first, second} = yield* admissionFixture;
        const held = [];
        for (let i = 0; i < 8; i++) {
          const reservation = yield* (i % 2 ? first : second).acquire(EffectString.repeat(64)(i < 4 ? 'a' : 'b'), 2000);
          yield* reservation.finishImport;
          held.push(reservation);
        }
        expect(yield* first.acquire(EffectString.repeat(64)('c'), 100).pipe(Effect.flip)).toMatchObject({
          code: 'timeout',
        });
        expect(yield* second.status).toMatchObject({providers: 8, imports: 0, queued: 0});
        const generation = held.at(-1)!.generation;
        for (const reservation of held) yield* reservation.release(true);
        const next = yield* second.acquire(EffectString.repeat(64)('c'), 2000);
        expect(next.generation).toBeGreaterThan(generation);
        yield* next.release(true);
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow filesystem/process lease test entrypoint.
        Effect.provide(admissionLayer),
        TestClock.withLive,
      ),
    10000,
  );
  effectIt.effect(
    'never reclaims an uncertain instance and quarantines an unregistered child after owner reuse',
    () =>
      Effect.gen(function* () {
        const {fs, path, directory} = yield* admissionFixture;
        const system = yield* SystemInfo;
        let observed: string | undefined = 'known-instance';
        const admission = yield* makeSemanticAdmission({directory, processGroupPresent: () => false}).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            isProcessRunning: () => true,
            canonicalProcessStartIdentity: () => Effect.succeed(observed),
          }),
        );
        const reservation = yield* admission.acquire(EffectString.repeat(64)('a'), 2000);
        observed = undefined;
        expect(yield* admission.status).toMatchObject({providers: 1, quarantined: 0});
        observed = 'new-instance';
        expect(yield* admission.status).toMatchObject({providers: 1, quarantined: 1});
        const ledger = JSON.parse(yield* fs.readFileString(path.join(directory, 'admission-v1.json')));
        expect(ledger.slots[0].owner.identity).toBe('known-instance');
        yield* reservation.release(false);
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow filesystem/process lease test entrypoint.
        Effect.provide(admissionLayer),
        TestClock.withLive,
      ),
    10000,
  );
  effectIt.effect(
    'bounds imports across two worktree coordinators and releases FIFO capacity',
    () =>
      Effect.gen(function* () {
        const {first, second} = yield* admissionFixture;
        const a = yield* first.acquire(EffectString.repeat(64)('a'), 2000);
        const b = yield* second.acquire(EffectString.repeat(64)('b'), 2000);
        const waiting = yield* Effect.forkChild(second.acquire(EffectString.repeat(64)('c'), 2000));
        yield* Effect.sleep(50);
        expect(yield* first.status).toMatchObject({providers: 2, imports: 2, queued: 1});
        yield* a.finishImport;
        const c = yield* Fiber.join(waiting);
        expect(yield* second.status).toMatchObject({providers: 3, imports: 2, queued: 0});
        yield* Effect.all([a.release(true), b.release(true), c.release(true)], {concurrency: 3});
        expect(yield* first.status).toMatchObject({providers: 0, imports: 0, queued: 0});
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow filesystem/process lease test entrypoint.
        Effect.provide(admissionLayer),
        TestClock.withLive,
      ),
    10000,
  );
  effectIt.effect(
    'lets an unrelated workspace pass a saturated workspace and removes cancelled tickets',
    () =>
      Effect.gen(function* () {
        const {first, second} = yield* admissionFixture;
        const held = [];
        for (let i = 0; i < 4; i++) {
          const reservation = yield* first.acquire(EffectString.repeat(64)('a'), 2000);
          yield* reservation.finishImport;
          held.push(reservation);
        }
        const blocked = yield* Effect.forkChild(first.acquire(EffectString.repeat(64)('a'), 2000));
        yield* Effect.sleep(50);
        const unrelated = yield* second.acquire(EffectString.repeat(64)('b'), 2000);
        expect(yield* second.status).toMatchObject({providers: 5, queued: 1});
        yield* Fiber.interrupt(blocked);
        expect(yield* first.status).toMatchObject({providers: 5, queued: 0});
        yield* unrelated.release(true);
        for (const reservation of held) yield* reservation.release(true);
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow filesystem/process lease test entrypoint.
        Effect.provide(admissionLayer),
        TestClock.withLive,
      ),
    10000,
  );
  effectIt.effect(
    'keeps uncertain cleanup occupied and refuses corrupt ledgers',
    () =>
      Effect.gen(function* () {
        const {first, second, fs, path, directory} = yield* admissionFixture;
        const reservation = yield* first.acquire(EffectString.repeat(64)('a'), 2000);
        yield* reservation.release(false);
        expect(yield* second.status).toMatchObject({providers: 1, imports: 0, quarantined: 1});
        yield* fs.writeFileString(path.join(directory, 'admission-v1.json'), '{', {mode: 0o600});
        expect(yield* second.status.pipe(Effect.flip)).toMatchObject({code: 'protocol'});
        expect(yield* fs.readFileString(path.join(directory, 'admission-v1.json'))).toBe('{');
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Narrow filesystem/process lease test entrypoint.
        Effect.provide(admissionLayer),
        TestClock.withLive,
      ),
    10000,
  );
});
describe('semantic LSP framing', () => {
  it('preserves multiple Unicode frames under arbitrary chunk boundaries', () => {
    fc.assert(
      fc.property(
        fc.jsonValue(),
        fc.array(fc.integer({min: 1, max: 64}), {minLength: 1, maxLength: 20}),
        (value, widths) => {
          const expected = [
            {jsonrpc: '2.0', id: 1, method: 'query', params: {value, text: '🧵\r\n'}},
            {jsonrpc: '2.0', id: 1, result: value},
          ];
          const parts = EffectArray.map(expected, encodeLspFrame);
          const bytes = new Uint8Array(EffectArray.reduce(parts, 0, (size, part) => size + part.length));
          let offset = 0;
          for (const part of parts) {
            bytes.set(part, offset);
            offset += part.length;
          }
          const decoder = new LspFrameDecoder();
          const actual: Message[] = [];
          for (let i = 0, part = 0; i < bytes.length; part++) {
            const end = Math.min(bytes.length, i + widths[part % widths.length]);
            actual.push(...decoder.push(bytes.subarray(i, end)));
            i = end;
          }
          decoder.finish();
          expect(actual).toEqual(JSON.parse(JSON.stringify(expected)));
        },
      ),
      {numRuns: 100},
    );
  });
  it.each([
    'Content-Length: 1\r\nContent-Length: 1\r\n\r\n0',
    'Content-Length: -1\r\n\r\n',
    'Content-Length: 9999999999999\r\n\r\n',
    'Content-Length: 2\r\n\r\n[]',
    'Content-Length: 1\r\n\r\n{',
  ])('rejects malformed frames', text => {
    expect(() => new LspFrameDecoder().push(new TextEncoder().encode(text))).toThrow();
  });
  it.each([
    {jsonrpc: '2.0', id: {}, result: null},
    {jsonrpc: '2.0', id: 1, method: 'query', result: null},
    {jsonrpc: '2.0', id: 1},
    {jsonrpc: '1.0', id: 1, result: null},
  ])('rejects ambiguous or invalid JSON-RPC envelopes', message => {
    expect(() => new LspFrameDecoder().push(encodeLspFrame(message))).toThrow(LspFault);
  });
  it('rejects incomplete frames at EOF and excessive headers', () => {
    const decoder = new LspFrameDecoder();
    decoder.push(new TextEncoder().encode('Content-Length: 30\r\n\r\n{'));
    expect(() => decoder.finish()).toThrow(LspFault);
    expect(() => new LspFrameDecoder().push(new Uint8Array(8193).fill(65))).toThrow(LspFault);
  });
});
describe('semantic LSP request lifecycle', () => {
  effectIt.effect('bounds cancellation even when the provider stops draining stdin', () =>
    Effect.gen(function* () {
      const fake = yield* fakeWire;
      let stalled = true;
      const client = yield* makeLspClient({
        ...fake.wire,
        send: message =>
          fake.wire.send(message).pipe(Effect.andThen(Effect.suspend(() => (stalled ? Effect.never : Effect.void)))),
      });
      const pending = yield* Effect.forkChild(client.request('slow', {}, 20).pipe(Effect.flip));
      expect((yield* Queue.take(fake.sent)).method).toBe('slow');
      yield* TestClock.adjust(20);
      expect((yield* Queue.take(fake.sent)).method).toBe('$/cancelRequest');
      yield* TestClock.adjust(100);
      expect(yield* Fiber.join(pending)).toMatchObject({code: 'timeout'});
      stalled = false;
      expect((yield* client.close).graceful).toBe(true);
    }),
  );
  effectIt.effect('correlates out-of-order responses without sharing pending requests', () =>
    Effect.gen(function* () {
      const fake = yield* fakeWire;
      const client = yield* makeLspClient(fake.wire);
      const first = yield* Effect.forkChild(client.request('first', {}, 1000));
      const a = yield* Queue.take(fake.sent);
      const second = yield* Effect.forkChild(client.request('second', {}, 1000));
      const b = yield* Queue.take(fake.sent);
      yield* Queue.offer(fake.incoming, {jsonrpc: '2.0', id: b.id, result: 'second'});
      yield* Queue.offer(fake.incoming, {jsonrpc: '2.0', id: a.id, result: 'first'});
      expect(yield* Fiber.join(first)).toBe('first');
      expect(yield* Fiber.join(second)).toBe('second');
    }),
  );
  effectIt.effect('expires one request, sends cancellation and ignores its late response', () =>
    Effect.gen(function* () {
      const fake = yield* fakeWire;
      const client = yield* makeLspClient(fake.wire);
      const old = yield* Effect.forkChild(client.request('old', {}, 100).pipe(Effect.flip));
      const a = yield* Queue.take(fake.sent);
      yield* TestClock.adjust(100);
      expect((yield* Fiber.join(old)).code).toBe('timeout');
      expect(yield* Queue.take(fake.sent)).toEqual({jsonrpc: '2.0', method: '$/cancelRequest', params: {id: a.id}});
      const current = yield* Effect.forkChild(client.request('current', {}, 1000));
      const b = yield* Queue.take(fake.sent);
      yield* Queue.offer(fake.incoming, {jsonrpc: '2.0', id: a.id, result: 'obsolete'});
      yield* Queue.offer(fake.incoming, {jsonrpc: '2.0', id: b.id, result: 'current'});
      expect(yield* Fiber.join(current)).toBe('current');
    }),
  );
  effectIt.effect('releases bounded pending slots after interruption', () =>
    Effect.gen(function* () {
      const fake = yield* fakeWire;
      const client = yield* makeLspClient(fake.wire);
      const fibers = [];
      for (let i = 0; i < 32; i++) {
        fibers.push(yield* Effect.forkChild(client.request('hold', {}, 1000)));
        yield* Queue.take(fake.sent);
      }
      expect((yield* client.request('overflow', {}, 1000).pipe(Effect.flip)).code).toBe('capacity');
      yield* Effect.forEach(fibers, fiber => Fiber.interrupt(fiber), {concurrency: 'unbounded'});
      for (let i = 0; i < 32; i++) expect((yield* Queue.take(fake.sent)).method).toBe('$/cancelRequest');
      const next = yield* Effect.forkChild(client.request('next', {}, 1000));
      const message = yield* Queue.take(fake.sent);
      yield* Queue.offer(fake.incoming, {jsonrpc: '2.0', id: message.id, result: true});
      expect(yield* Fiber.join(next)).toBe(true);
    }),
  );
  effectIt.effect('denies provider edits and performs shutdown exactly once', () =>
    Effect.gen(function* () {
      const fake = yield* fakeWire;
      const client = yield* makeLspClient(fake.wire);
      yield* Queue.offer(fake.incoming, {
        jsonrpc: '2.0',
        id: 'server-1',
        method: 'workspace/applyEdit',
        params: {edit: {}},
      });
      expect(yield* Queue.take(fake.sent)).toMatchObject({id: 'server-1', result: {applied: false}});
      const results = yield* Effect.all([client.close, client.close], {concurrency: 2});
      expect(EffectArray.every(results, result => result.graceful)).toBe(true);
      expect(fake.finishes()).toBe(1);
      expect((yield* Queue.take(fake.sent)).method).toBe('exit');
      expect((yield* client.request('late', {}, 1000).pipe(Effect.flip)).code).toBe('closing');
    }),
  );
});
describe('semantic owned-tree uncertainty', () => {
  effectIt.effect('cleans up native acquisition interrupted before the wire can return', () =>
    Effect.gen(function* () {
      const minted = yield* Deferred.make<void>();
      let owner: Fiber.Fiber<unknown, unknown> | undefined;
      let inputClosed = false,
        observed = 0,
        closed = 0;
      const eof = [false, false];
      const reads = [0, 0];
      const streams = EffectArray.map(
        eof,
        (_value, index) =>
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (reads[index]++ === 0) controller.enqueue(new Uint8Array());
              else {
                eof[index] = true;
                controller.close();
              }
            },
          }),
      );
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The synthetic capability is consumed only by mocked platform functions.
      const handle = {} as platformSystem.RuntimeOwnedProviderTree;
      const mocks = [
        vi.spyOn(platformSystem, 'runtimeSpawnOwnedProviderTree').mockImplementation(() => {
          owner!.interruptUnsafe();
          Deferred.doneUnsafe(minted, Effect.void);
          return {
            handle,
            pid: 42,
            identity: 'acquisition-instance',
            stdout: streams[0],
            stderr: streams[1],
            write: async () => {},
            closeInput: async () => {
              inputClosed = true;
            },
          };
        }),
        vi.spyOn(platformSystem, 'runtimeObserveOwnedProviderTree').mockImplementation(() => {
          observed++;
          return {
            state: inputClosed && EffectArray.every(eof, Boolean) ? 'drained' : 'running',
            leaderExitCode: 0,
            stdioClosed: EffectArray.every(eof, Boolean),
          };
        }),
        vi.spyOn(platformSystem, 'runtimeTerminateOwnedProviderTree').mockImplementation(() => {}),
        vi.spyOn(platformSystem, 'runtimeCloseOwnedProviderTree').mockImplementation(() => {
          closed++;
        }),
      ];
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const mock of mocks) mock.mockRestore();
        }),
      );
      const startup = yield* Effect.forkChild(
        Effect.scoped(
          Effect.withFiber(fiber => {
            owner = fiber;
            return spawnLspWire({command: '/trusted/server', args: [], cwd: '/project', environment: {}});
          }),
        ),
      );
      yield* Deferred.await(minted);
      yield* SemanticTestClock.adjust(6000);
      expect((yield* Fiber.await(startup))._tag).toBe('Failure');
      expect(inputClosed).toBe(true);
      expect(observed).toBeGreaterThan(0);
      expect(reads).toEqual([2, 2]);
      expect(closed).toBe(1);
    }).pipe(
      Effect.provideService(ChildEnvironmentPolicy, {sanitizeExternal: env => env, preserveIntendedChild: env => env}),
    ),
  );
  effectIt.effect('preserves malformed-frame failure while draining finite remaining bytes through EOF', () =>
    Effect.gen(function* () {
      const chunks = [encodeLspFrame({}), new Uint8Array([1]), new Uint8Array([2, 3]), new Uint8Array([4])];
      let pulled = 0,
        stdoutEof = false,
        stderrEof = false,
        dead = false,
        closed = 0;
      const modes: string[] = [];
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The synthetic capability is consumed only by mocked platform functions.
      const handle = {} as platformSystem.RuntimeOwnedProviderTree;
      const mocks = [
        vi.spyOn(platformSystem, 'runtimeSpawnOwnedProviderTree').mockReturnValue({
          handle,
          pid: 42,
          identity: 'malformed-output-instance',
          stdout: new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (pulled < chunks.length) controller.enqueue(chunks[pulled++]);
                else {
                  stdoutEof = true;
                  controller.close();
                }
              },
            },
            {highWaterMark: 1},
          ),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              stderrEof = true;
              controller.close();
            },
          }),
          write: async () => {},
          closeInput: async () => {},
        }),
        vi.spyOn(platformSystem, 'runtimeObserveOwnedProviderTree').mockImplementation(() => ({
          state: dead && stdoutEof && stderrEof ? 'drained' : 'running',
          leaderExitCode: dead ? 0 : null,
          stdioClosed: stdoutEof && stderrEof,
        })),
        vi.spyOn(platformSystem, 'runtimeTerminateOwnedProviderTree').mockImplementation((_handle, mode) => {
          modes.push(mode);
          dead = true;
        }),
        vi.spyOn(platformSystem, 'runtimeCloseOwnedProviderTree').mockImplementation(() => {
          closed++;
        }),
      ];
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const mock of mocks) mock.mockRestore();
        }),
      );
      const wire = yield* spawnLspWire({command: '/trusted/server', args: [], cwd: '/project', environment: {}});
      const finishing = yield* Effect.forkChild(wire.finish);
      yield* SemanticTestClock.adjust(6000);
      expect(yield* Fiber.join(finishing)).toMatchObject({drained: true, stdioClosed: true, fault: {code: 'protocol'}});
      expect(pulled).toBe(chunks.length);
      expect(stdoutEof).toBe(true);
      expect(modes).toEqual(['terminate']);
      expect(closed).toBe(1);
    }).pipe(
      Effect.provideService(ChildEnvironmentPolicy, {sanitizeExternal: env => env, preserveIntendedChild: env => env}),
    ),
  );
  effectIt.effect('retains unknown whole-tree ownership despite leader exit and stream EOF', () =>
    Effect.gen(function* () {
      const signals: string[] = [];
      const closed = vi.fn();
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Synthetic capability is used exclusively by the mocked platform functions below.
      const handle = {} as platformSystem.RuntimeOwnedProviderTree;
      const mocks = [
        vi.spyOn(platformSystem, 'runtimeSpawnOwnedProviderTree').mockReturnValue({
          handle,
          pid: 42,
          identity: 'original-instance',
          stdout: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          stderr: new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          write: async () => {},
          closeInput: async () => {},
        }),
        vi
          .spyOn(platformSystem, 'runtimeObserveOwnedProviderTree')
          .mockReturnValue({state: 'unknown', leaderExitCode: 0, stdioClosed: true}),
        vi.spyOn(platformSystem, 'runtimeTerminateOwnedProviderTree').mockImplementation((_handle, mode) => {
          signals.push(mode);
        }),
        vi.spyOn(platformSystem, 'runtimeCloseOwnedProviderTree').mockImplementation(closed),
      ];
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const mock of mocks) mock.mockRestore();
        }),
      );
      const wire = yield* spawnLspWire({command: '/trusted/server', args: [], cwd: '/project', environment: {}});
      const finishing = yield* Effect.forkChild(wire.finish);
      yield* Effect.yieldNow;
      yield* SemanticTestClock.adjust(6000);
      const stop = yield* Fiber.join(finishing);
      expect(stop).toMatchObject({code: 0, drained: false, stdioClosed: true, forced: true, fault: {code: 'exit'}});
      expect(signals).toEqual(['terminate', 'kill']);
      expect(closed).not.toHaveBeenCalled();
    }).pipe(
      Effect.provideService(ChildEnvironmentPolicy, {sanitizeExternal: env => env, preserveIntendedChild: env => env}),
    ),
  );
});
describe.skipIf(process.platform === 'win32')('semantic real process transport', () => {
  effectIt.effect.each([
    {mode: '', graceful: true},
    {mode: 'panic-on-exit', graceful: false},
    {mode: 'close-input-on-shutdown', graceful: false},
  ])(
    'observes actual owned process cleanup for $mode',
    ({mode, graceful}) =>
      Effect.gen(function* () {
        let failureEvidence: ((stop: WireStop & {graceful: boolean}) => string) | undefined;
        let assertNativeRecorder: ((evidence: string | undefined) => void) | undefined;
        if (mode === 'panic-on-exit') {
          const observe = platformSystem.runtimeObserveOwnedProviderTree;
          const terminate = platformSystem.runtimeTerminateOwnedProviderTree;
          const close = platformSystem.runtimeCloseOwnedProviderTree;
          const faultReason = Schema.Literals([
            'unsupported-platform',
            'identity',
            'path',
            'readonly',
            'source-changed',
            'private-storage',
            'io',
          ]);
          const state = Schema.Literals(['running', 'drained', 'unknown']);
          const own = (value: object, key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
          const exitCode = (value: unknown): number | null | 'unavailable' =>
            value === null
              ? null
              : typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
                ? value
                : 'unavailable';
          type ErrorCode = typeof faultReason.Type | 'not-thrown' | 'unavailable';
          const reason = (error: unknown): ErrorCode => {
            const value = error !== null && typeof error === 'object' ? own(error, 'reason') : undefined;
            return Schema.is(faultReason)(value) ? value : 'unavailable';
          };
          type Sample = {
            state: 'running' | 'drained' | 'unknown' | 'unavailable';
            code: ReturnType<typeof exitCode>;
            stdioClosed: boolean | 'unavailable';
          };
          let first: Sample | undefined, last: Sample | undefined;
          type Call =
            | 'observe-returned'
            | 'observe-threw'
            | 'terminate-returned'
            | 'terminate-threw'
            | 'kill-returned'
            | 'kill-threw'
            | 'close-returned'
            | 'close-threw';
          const changes: Sample[] = [],
            order: Call[] = [];
          const trace: {
            observeCalls: number;
            terminateCalls: number;
            closeCalls: number;
            changesTruncated: boolean;
            orderTruncated: boolean;
            observerIncomplete: boolean;
            observeError: ErrorCode;
            terminateError: ErrorCode;
            closeError: ErrorCode;
            closeOutcome: 'not-called' | 'returned' | 'threw';
          } = {
            observeCalls: 0,
            terminateCalls: 0,
            closeCalls: 0,
            changesTruncated: false,
            orderTruncated: false,
            observerIncomplete: false,
            observeError: 'not-thrown',
            terminateError: 'not-thrown',
            closeOutcome: 'not-called',
            closeError: 'not-thrown',
          };
          // Observation failure must never replace a native result/exception or suppress its real cleanup.
          const capture = (record: () => void) => {
            try {
              record();
            } catch {
              trace.observerIncomplete = true;
            }
          };
          const recordOrder = (event: Call) => {
            if (order.length < 16) order.push(event);
            else {
              order[15] = event;
              trace.orderTruncated = true;
            }
          };
          // Record only outcomes of the backend's own calls. No errno reads, additional probes or status bytes.
          const waitpidCounts = new Uint32Array(4),
            groupCounts = new Uint32Array(4);
          const restorations: (() => void)[] = [];
          // Register before interception: a failed acquisition must still restore every changed descriptor.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (let index = restorations.length - 1; index >= 0; index--) restorations[index]();
            }),
          );
          const previousSample = nativeWaitpidSample.active;
          restorations.push(() => {
            nativeWaitpidSample.active = previousSample;
          });
          nativeWaitpidSample.active = symbols => {
            const waitDescriptor = Object.getOwnPropertyDescriptor(symbols, 'waitpid');
            const waitpid: unknown = waitDescriptor?.value;
            if (!waitDescriptor || typeof waitpid !== 'function') return;
            restorations.push(() => Object.defineProperty(symbols, 'waitpid', waitDescriptor));
            Object.defineProperty(symbols, 'waitpid', {
              ...waitDescriptor,
              value(pid: number, status: Int32Array, options: number) {
                const result: unknown = waitpid(pid, status, options);
                // Only comparisons and preallocated typed-array writes occur before returning to the caller.
                // In particular, no allocation, callback, FFI or other native operation can overwrite errno.
                const index = result === pid ? 0 : result === 0 ? 1 : result === -1 ? 2 : 3;
                if (waitpidCounts[index] < 0xffff_ffff) waitpidCounts[index]++;
                return result;
              },
            });
          };
          const assertGroup = platformSystem.runtimeAssertProcessGroupExistsSync;
          const groupMock = vi.spyOn(platformSystem, 'runtimeAssertProcessGroupExistsSync');
          restorations.push(() => groupMock.mockRestore());
          groupMock.mockImplementation(group => {
            try {
              const result = assertGroup(group);
              if (groupCounts[0] < 0xffff_ffff) groupCounts[0]++;
              return result;
            } catch (error) {
              // process.kill has already captured errno into its exception before this JS boundary.
              capture(() => {
                const code = error !== null && typeof error === 'object' ? own(error, 'code') : undefined;
                const index = code === 'ESRCH' ? 1 : code === 'EPERM' ? 2 : 3;
                if (groupCounts[index] < 0xffff_ffff) groupCounts[index]++;
              });
              throw error;
            }
          });
          const mocks = [
            vi.spyOn(platformSystem, 'runtimeObserveOwnedProviderTree').mockImplementation(handle => {
              try {
                const result = observe(handle);
                capture(() => {
                  trace.observeCalls++;
                  recordOrder('observe-returned');
                  const nativeState = own(result, 'state'),
                    stdio = own(result, 'stdioClosed');
                  const sample: Sample = {
                    state: Schema.is(state)(nativeState) ? nativeState : 'unavailable',
                    code: exitCode(own(result, 'leaderExitCode')),
                    stdioClosed: typeof stdio === 'boolean' ? stdio : 'unavailable',
                  };
                  if (
                    sample.state === 'unavailable' ||
                    sample.code === 'unavailable' ||
                    sample.stdioClosed === 'unavailable'
                  )
                    trace.observerIncomplete = true;
                  first ??= sample;
                  if (
                    !last ||
                    last.state !== sample.state ||
                    last.code !== sample.code ||
                    last.stdioClosed !== sample.stdioClosed
                  ) {
                    if (changes.length < 8) changes.push(sample);
                    else trace.changesTruncated = true;
                  }
                  last = sample;
                });
                return result;
              } catch (error) {
                capture(() => {
                  trace.observeCalls++;
                  trace.observeError = reason(error);
                  recordOrder('observe-threw');
                });
                throw error;
              }
            }),
            vi.spyOn(platformSystem, 'runtimeTerminateOwnedProviderTree').mockImplementation((handle, signal) => {
              try {
                const result = terminate(handle, signal);
                capture(() => {
                  trace.terminateCalls++;
                  recordOrder(signal === 'kill' ? 'kill-returned' : 'terminate-returned');
                });
                return result;
              } catch (error) {
                capture(() => {
                  trace.terminateCalls++;
                  trace.terminateError = reason(error);
                  recordOrder(signal === 'kill' ? 'kill-threw' : 'terminate-threw');
                });
                throw error;
              }
            }),
            vi.spyOn(platformSystem, 'runtimeCloseOwnedProviderTree').mockImplementation(handle => {
              try {
                const result = close(handle);
                capture(() => {
                  trace.closeCalls++;
                  trace.closeOutcome = 'returned';
                  recordOrder('close-returned');
                });
                return result;
              } catch (error) {
                capture(() => {
                  trace.closeCalls++;
                  trace.closeOutcome = 'threw';
                  trace.closeError = reason(error);
                  recordOrder('close-threw');
                });
                throw error;
              }
            }),
          ];
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const mock of mocks) mock.mockRestore();
            }),
          );
          assertNativeRecorder = evidence => {
            // A real successful drain crosses both seams; this also detects an ineffective module interception.
            expect(waitpidCounts[0], evidence).toBeGreaterThan(0);
            expect(groupCounts[1], evidence).toBeGreaterThan(0);
          };
          failureEvidence = stop => {
            try {
              const fault = own(stop, 'fault');
              const faultCode = fault !== null && typeof fault === 'object' ? own(fault, 'code') : undefined;
              const boolean = (key: string) => {
                const value = own(stop, key);
                return typeof value === 'boolean' ? value : 'unavailable';
              };
              return JSON.stringify({
                stop: {
                  graceful: boolean('graceful'),
                  drained: boolean('drained'),
                  stdioClosed: boolean('stdioClosed'),
                  forced: boolean('forced'),
                  code: exitCode(own(stop, 'code')),
                  faultCode:
                    fault === undefined ? null : Schema.is(LspFault.fields.code)(faultCode) ? faultCode : 'unavailable',
                },
                first,
                changes,
                last,
                order,
                ...trace,
                posixCalls: {
                  waitpid: {
                    originalChild: waitpidCounts[0],
                    zero: waitpidCounts[1],
                    error: waitpidCounts[2],
                    other: waitpidCounts[3],
                  },
                  groupAssertion: {
                    returned: groupCounts[0],
                    ESRCH: groupCounts[1],
                    EPERM: groupCounts[2],
                    other: groupCounts[3],
                  },
                },
              });
            } catch {
              return '{"observerIncomplete":true}';
            }
          };
        }
        const wire = yield* spawnLspWire({
          command: process.execPath,
          args: ['apps/threadnote/test/fixtures/semantic/fake-provider.ts', mode],
          cwd: process.cwd(),
          environment: process.env,
        });
        const client = yield* makeLspClient(wire);
        expect(yield* client.request('echo', {text: '🧵\r\n'}, 1000)).toEqual({text: '🧵\r\n'});
        const stopped = yield* client.close;
        const evidence = failureEvidence?.(stopped);
        expect(stopped.graceful, evidence).toBe(graceful);
        expect(stopped.drained, evidence).toBe(true);
        expect(stopped.stdioClosed, evidence).toBe(true);
        assertNativeRecorder?.(evidence);
      }).pipe(
        TestClock.withLive,
        Effect.provideService(ChildEnvironmentPolicy, {
          sanitizeExternal: environment =>
            EffectRecord.fromEntries(
              EffectArray.filter(EffectRecord.toEntries(environment), ([key]) =>
                ['PATH', 'TMPDIR', 'LANG', 'SYSTEMROOT', 'SystemRoot', 'WINDIR'].includes(key),
              ),
            ),
          preserveIntendedChild: environment => environment,
        }),
      ),
    15000,
  );
});

const verifierProcessIo = Layer.mergeAll(BunServices.layer, cryptoLayer, TestSystemInfoLayer);
const verifierProcessLayer = Layer.merge(
  verifierProcessIo,
  TestCommandExecutorLayer.pipe(Layer.provide(verifierProcessIo)),
);
describe.skipIf(process.platform === 'win32')('selected verifier process control boundary', () => {
  effectIt.layer(verifierProcessLayer)(layerIt => {
    layerIt.effect('keeps status and cancel responsive during real child hashing and proves owned group exit', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const system = yield* SystemInfo;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'tn-readiness-cpu-'});
        const entrypoint = path.join(root, 'verifier.ts');
        const descendant = path.join(root, 'hash.ts');
        const ready = path.join(root, 'hashed.json');
        const bytes = new Uint8Array(8 * 1024 * 1024).fill(23);
        const expected = sha256HexSync(bytes);
        yield* fs.writeFileString(
          descendant,
          `import {createHash} from 'node:crypto';
import {renameSync,writeFileSync} from 'node:fs';
const bytes=new Uint8Array(8*1024*1024).fill(23);
const digest=createHash('sha256').update(bytes).digest('hex');
writeFileSync(${JSON.stringify(ready + '.tmp')},JSON.stringify({pid:process.ppid,descendant:process.pid,digest}));
renameSync(${JSON.stringify(ready + '.tmp')},${JSON.stringify(ready)});
const until=Date.now()+5000;
while(Date.now()<until)createHash('sha256').update(bytes).digest('hex');
`,
        );
        yield* fs.writeFileString(
          entrypoint,
          `import {spawn} from 'node:child_process';
spawn(process.execPath,[${JSON.stringify(descendant)}],{detached:false,stdio:'ignore'});
setTimeout(()=>{},6000);
`,
        );
        const basis: Observation = {
          version: 1,
          repository: 'verifier-test',
          worktree: 'file:///verifier-test',
          project: 'file:///verifier-test',
          configuration: expected,
          toolchain: expected,
          provider: {id: 'gopls', version: 'fixture', generation: 1},
          view: {kind: 'disk', id: 'fixture', owner: 'host', epoch: 0},
          uri: 'file:///verifier-test/a.go',
          content: expected,
          documentVersion: null,
          projectEpoch: 1,
        };
        const source = {...basis, language: 'go' as const, profile: expected, principal: expected};
        const jobs = yield* makeSemanticReadinessJobs({
          worktree: source.worktree,
          prepare: () =>
            runSemanticSelectedVerification('/private-fixture.json', 'gopls', expected, false, false).pipe(
              Effect.provideService(SystemInfo, {
                ...system,
                executablePath: process.execPath,
                developmentEntrypoint: entrypoint,
              }),
              Effect.as(basis),
            ),
          current: () => Effect.succeed(true),
          close: () => Effect.void,
        });
        const start = yield* jobs.start(source, expected);
        if (start.status !== 'ok' || !start.job) throw new Error('Missing test job');
        yield* fs.exists(ready).pipe(Effect.repeat({while: present => !present, schedule: Schedule.spaced(10)}));
        const child = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({pid: Schema.Int, descendant: Schema.Int, digest: Schema.String})),
        )(yield* fs.readFileString(ready));
        expect(child.digest).toBe(expected);
        expect(system.isProcessRunning(child.pid)).toBe(true);
        expect(system.isProcessRunning(child.descendant)).toBe(true);
        const scope = [source.profile, source.principal, source.worktree] as const;
        expect(yield* jobs.status(start.job, ...scope)).toMatchObject({status: 'ok', progress: {state: 'accepted'}});
        expect(system.isProcessRunning(child.descendant)).toBe(true);
        const before = yield* Clock.monotonicTimeNanos;
        expect(yield* jobs.cancel(start.job, ...scope)).toMatchObject({status: 'ok', progress: {state: 'cancelling'}});
        expect(Number((yield* Clock.monotonicTimeNanos) - before) / 1_000_000).toBeLessThan(250);
        const terminal = yield* jobs.status(start.job, ...scope).pipe(
          Effect.repeat({
            until: result => result.status === 'ok' && result.progress.state === 'cancelled',
            schedule: Schedule.spaced(10),
          }),
        );
        expect(Number((yield* Clock.monotonicTimeNanos) - before) / 1_000_000).toBeLessThanOrEqual(2000);
        expect(terminal).toMatchObject({status: 'ok', progress: {cleanup: 'drained'}});
        expect(system.isProcessRunning(child.pid)).toBe(false);
        expect(system.isProcessRunning(child.descendant)).toBe(false);
        expect(system.isProcessGroupRunning?.(child.pid)).toBe(false);
      }).pipe(TestClock.withLive),
    );
  });
});

// Native identity is an independent fixture oracle here; actual HANDLE/security capture is exercised on Windows.
const privateNativeSourceOracle = Effect.fn('test.privateNativeSourceOracle')(function* (text: string) {
  const ids = new WeakMap<
    platformSystem.RuntimeWindowsSourceEvidence,
    {object: string; snapshot: number; content: string}
  >();
  let object = 'original',
    snapshot = 0,
    capturedText = text;
  const capture = vi.spyOn(platformSystem, 'runtimeCaptureWindowsSource').mockImplementation(() => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Isolated native-capture token oracle; actual HANDLE authenticity is tested on Windows.
    const evidence = Object.freeze({}) as platformSystem.RuntimeWindowsSourceEvidence;
    ids.set(evidence, {object, snapshot, content: sha256HexSync(capturedText)});
    return {bytes: new TextEncoder().encode(capturedText), physicalIdentity: '["same","pair"]', evidence};
  });
  const compare = vi.spyOn(platformSystem, 'runtimeSameWindowsSourceEvidence').mockImplementation((a, b, exact) => {
    const first = ids.get(a),
      second = ids.get(b);
    return (
      !!first &&
      !!second &&
      first.object === second.object &&
      (!exact || (first.snapshot === second.snapshot && first.content === second.content))
    );
  });
  const exported = vi.spyOn(platformSystem, 'runtimeExportWindowsSourceWitness').mockImplementation(evidence => {
    const first = ids.get(evidence);
    if (!first) throw new Error('Unissued oracle evidence');
    return Object.freeze({object: first.object, snapshot: JSON.stringify([first.snapshot, first.content])});
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      capture.mockRestore();
      compare.mockRestore();
      exported.mockRestore();
    }),
  );
  return {
    capture,
    change: (nextObject: string, nextSnapshot: number) => {
      object = nextObject;
      snapshot = nextSnapshot;
    },
    text: (next: string) => {
      capturedText = next;
    },
  };
});

// These oracle-only paths intentionally use a POSIX Path layer on every host. Native Windows coverage is separate.
const privateSourceFixture = Effect.gen(function* () {
  const text = 'const target = 1;';
  const seed: Observation = {
    version: 1,
    repository: 'source-proof',
    worktree: 'file:///test',
    project: 'file:///test',
    configuration: sha256HexSync('config'),
    toolchain: sha256HexSync('tools'),
    provider: {id: 'typescript-language-server', version: '6.0.2', generation: 7},
    view: {kind: 'disk', id: 'disk', owner: 'host', epoch: 0},
    uri: 'file:///test/a.ts',
    content: sha256HexSync(text),
    documentVersion: null,
    projectEpoch: 7,
  };
  const oracle = yield* privateNativeSourceOracle(text);
  const sources = yield* makeWindowsSemanticSources('/test', seed, text);
  const firstUpsert = yield* sources.capture(seed.uri);
  yield* sources.port.beforeUpsert(firstUpsert, undefined);
  yield* sources.port.bind(firstUpsert, seed);
  const outcome = (observation: Observation = seed): QueryOutcome => ({
    version: 1,
    status: 'ok',
    evidence: {
      basis: 'semantic',
      observation,
      scope: 'project',
      completeness: 'complete',
      limitations: [],
    },
    items: [
      {
        kind: 'prepared-edit',
        operation: 'rename',
        sourceBasis: 'pre-request-synchronized-text-v1',
        files: [{uri: observation.uri, content: observation.content, source: 'disk', observation}],
      },
    ],
  });
  return {
    seed,
    text,
    sources,
    firstUpsert,
    outcome,
    capture: oracle.capture,
    change: oracle.change,
  };
});
effectIt.effect(
  'joins only the original prepared result, retains FIRST evidence, and keeps ordinary results proofless',
  () =>
    Effect.gen(function* () {
      const f = yield* privateSourceFixture;
      const listed: QueryOutcome = {
        version: 1,
        status: 'ok',
        evidence: {basis: 'semantic', observation: f.seed, scope: 'project', completeness: 'complete', limitations: []},
        items: [{kind: 'action-choice'}],
      };
      expect(f.sources.take(listed)).toEqual({kind: 'ordinary', outcome: listed});
      const closing = yield* f.sources.capture(f.seed.uri);
      yield* f.sources.port.bind(closing, f.seed);
      const result = f.outcome();
      yield* f.sources.port.prepared(result, [{capture: f.firstUpsert, observation: f.seed}]);
      const taken = takeSemanticPrepared(result, f.sources, () => true);
      expect(taken.kind).toBe('writer-prepared');
      if (taken.kind !== 'writer-prepared') throw new Error('Missing private proof');
      expect(taken.outcome).toBe(result);
      expect(taken.privateSourceRows[0].capture).not.toBe(f.firstUpsert);
      expect(taken.privateSourceRows[0].capture).not.toBe(closing);
      expect(JSON.stringify(result)).not.toMatch(/privateSource|certificate|volumeId|fileId/u);
      taken.assertCurrentSync();
      expect(() => takeSemanticPrepared(structuredClone(result), f.sources, () => true)).toThrow();
      expect(() => taken.assertCurrentSync()).toThrow();
    }).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scoped host evidence boundary test provides only Path.
      Effect.provide(BunPath.layerPosix),
    ),
);
effectIt.effect.prop(
  'superseded prepared rows and observations refuse without changing a healthy newer source epoch',
  [Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 16}))],
  ([advance]) =>
    Effect.gen(function* () {
      const f = yield* privateSourceFixture;
      const oldResult = f.outcome();
      yield* f.sources.port.prepared(oldResult, [{capture: f.firstUpsert, observation: f.seed}]);
      const old = takeSemanticPrepared(oldResult, f.sources, () => true);
      if (old.kind !== 'writer-prepared') throw new Error('Expected retained private rows');
      const next = {...f.seed, projectEpoch: f.seed.projectEpoch + advance};
      yield* f.sources.port.bind(f.firstUpsert, next);
      // A validation begun at the old epoch can reach this atomic bind after a newer upsert.
      expect((yield* f.sources.port.bind(f.firstUpsert, f.seed).pipe(Effect.exit))._tag).toBe('Failure');
      expect(f.sources.poisoned()).toBe(false);
      expect(() => old.assertCurrentSync()).toThrow(SemanticSessionFault);
      expect(() => f.sources.assertObservation(f.seed)).toThrow(SemanticSessionFault);
      expect(
        (yield* f.sources.port.prepared(f.outcome(), [{capture: f.firstUpsert, observation: f.seed}]).pipe(Effect.exit))
          ._tag,
      ).toBe('Failure');
      expect(f.sources.poisoned()).toBe(false);
      f.sources.assertObservation(next);
      const result = f.outcome(next);
      yield* f.sources.port.prepared(result, [{capture: f.firstUpsert, observation: next}]);
      const current = takeSemanticPrepared(result, f.sources, () => true);
      if (current.kind !== 'writer-prepared') throw new Error('Expected current private rows');
      current.assertCurrentSync();
      expect(current.privateSourceRows[0].observation.projectEpoch).toBe(next.projectEpoch);
      expect(f.sources.poisoned()).toBe(false);
    }).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scoped source-state property provides only Path.
      Effect.provide(BunPath.layerPosix),
    ),
);
effectIt.effect.prop(
  'same-byte compatibility collisions cannot upgrade native object or same-key metadata evidence',
  [Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 32})), Schema.Boolean],
  ([highBit, metadataOnly]) =>
    Effect.gen(function* () {
      const f = yield* privateSourceFixture;
      f.change(metadataOnly ? 'original' : String(1n << BigInt(64 + highBit)), metadataOnly ? 1 : 0);
      const changed = yield* f.sources.capture(f.seed.uri);
      const failed = metadataOnly ? f.sources.port.bind(changed, f.seed) : f.sources.port.beforeUpsert(changed, f.seed);
      expect((yield* failed.pipe(Effect.exit))._tag).toBe('Failure');
      f.change('original', 0);
      const restored = yield* f.sources.capture(f.seed.uri);
      expect((yield* f.sources.port.bind(restored, {...f.seed, projectEpoch: 8}).pipe(Effect.exit))._tag).toBe(
        'Failure',
      );
      expect(f.sources.poisoned()).toBe(true);
    }).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scoped host evidence boundary test provides only Path.
      Effect.provide(BunPath.layerPosix),
    ),
);
effectIt.effect('rejects forged capture objects, mixed prepared batches, and foreign session generations', () =>
  Effect.gen(function* () {
    for (const failure of ['capture', 'mixed', 'generation'])
      yield* Effect.scoped(
        Effect.gen(function* () {
          const f = yield* privateSourceFixture;
          if (failure === 'mixed') {
            const result = f.outcome();
            if (result.status !== 'ok') throw new Error('Expected prepared fixture');
            expect(() => f.sources.take({...result, items: [...result.items, {kind: 'action-choice'}]})).toThrow();
          } else {
            const effect =
              failure === 'capture'
                ? f.sources.port.bind({...f.firstUpsert}, f.seed)
                : f.sources.port.bind(f.firstUpsert, {...f.seed, provider: {...f.seed.provider, generation: 8}});
            expect((yield* effect.pipe(Effect.exit))._tag).toBe('Failure');
          }
          expect(f.sources.poisoned()).toBe(true);
        }),
      );
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- Scoped host evidence boundary test provides only Path.
    Effect.provide(BunPath.layerPosix),
  ),
);
