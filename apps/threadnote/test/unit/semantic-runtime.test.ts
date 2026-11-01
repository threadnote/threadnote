import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {it as effectIt} from '@effect/vitest';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import * as BunCrypto from '@effect/platform-bun/BunCrypto';
import {Cause, Effect, Fiber, FileSystem, Layer, Path, Queue, Schema, Stream} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {SystemInfo} from '@threadnote/platform/system';
import {CommandExecutor} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {semanticTreeDigest} from '../../src/semantic/fingerprint.js';
import * as fingerprint from '../../src/semantic/fingerprint.js';
import {type Observation, type QueryOutcome} from '@threadnote/semantic/contracts';
import {SemanticSetupFault, type SemanticSession, type DiagnosticDelta} from '../../src/semantic/provider.js';
import {
  makeSemanticAdmission,
  makeSemanticCoordinator,
  ensureSemanticEndpoint,
  semanticCatalogKey,
  verifyJavaSemanticCandidate,
  type JavaHostCandidate,
} from '../../src/semantic/coordinator.js';
import * as javaProvider from '../../src/semantic/providers/java.js';
import * as javaRuntime from '../../src/semantic/providers/java_runtime.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {
  LspFrameDecoder,
  LspFault,
  encodeLspFrame,
  makeLspClient,
  spawnLspWire,
  type LspWire,
} from '../../src/semantic/lsp_transport.js';
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
const admissionLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layer, TestSystemInfoLayer);
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
  const candidate = javaCandidate();
  const events: string[] = [];
  const control: {
    failAfterPid: boolean;
    rejectSdk: boolean;
    crash: boolean;
    available: boolean;
    afterCommit: Effect.Effect<void, unknown>;
  } = {
    failAfterPid: false,
    rejectSdk: false,
    crash: false,
    available: true,
    afterCommit: Effect.void,
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
  const factory = vi.spyOn(javaProvider, 'makeJavaAnalysis').mockImplementation((options, started, active) =>
    Effect.gen(function* () {
      const isActive = active ?? (() => true);
      constructions.push({options: structuredClone(options), isActive});
      let ended = false;
      const finish = Effect.sync(() => {
        if (!ended) finishes++;
        ended = true;
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
        evidence: {basis: 'semantic', observation, scope: 'project:fixture', completeness: 'partial', limitations: []},
      });
      const api = {
        upsert: (observation: Observation, _text: string, language: string) =>
          Effect.sync(() => {
            expect(language).toBe('java');
            documents.set(observation.uri, structuredClone(observation));
            return observation;
          }),
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
        invalidate: Effect.sync(() => {
          expect(isActive()).toBe(false);
          events.push('invalidate');
        }),
        close: finish.pipe(Effect.map(receipt => ({...receipt, graceful: true}))),
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
    constructions,
    factory,
    sdk,
    finishes: () => finishes,
    make: () => makeSemanticCoordinator({enabled: true, dataHome: home, java: candidate, worktree: basis.worktree}),
  };
});

describe.skipIf(process.platform === 'win32')('Java coordinator registration', () => {
  effectIt.layer(JavaCoordinatorTestLayer, {buildPerTest: true})(layerIt => {
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
        expect(yield* Effect.flip(f.make())).toMatchObject({
          _tag: 'SemanticSetupFault',
          component: 'sdk',
          reason: 'incompatible',
        });
        expect(
          yield* Effect.flip(
            ensureSemanticEndpoint({
              enabled: true,
              dataHome: f.home,
              java: f.candidate,
              worktree: f.basis.worktree,
              runtimeIdentity: sha256HexSync('private fixture runtime'),
            }),
          ),
        ).toMatchObject({_tag: 'SemanticSetupFault', component: 'sdk', reason: 'incompatible'});
        expect(yield* f.fs.readDirectory(f.home)).toEqual([]);
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
            (yield* Effect.exit(
              coordinator.use(attached.observation, 1000, api =>
                api.query('definition', attached.observation, {line: 0, character: 1}, 1000),
              ),
            ))._tag,
          ).toBe('Failure');
          yield* coordinator.closeView(attached.observation);
          f.control.crash = false;
        }
        expect((yield* Effect.exit(coordinator.attach(f.basis, f.text, 'java', 'prepared-main')))._tag).toBe('Failure');
        expect(f.factory).toHaveBeenCalledTimes(2);
        expect(f.finishes()).toBe(2);
        expect(yield* coordinator.status).toMatchObject({providers: 0, imports: 0, quarantined: 0});
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
describe.skipIf(process.platform === 'win32')('semantic real process transport', () => {
  effectIt.effect.each([
    {mode: '', graceful: true},
    {mode: 'panic-on-exit', graceful: false},
    {mode: 'close-input-on-shutdown', graceful: false},
  ])(
    'observes actual owned process cleanup for $mode',
    ({mode, graceful}) =>
      Effect.gen(function* () {
        const wire = yield* spawnLspWire({
          command: process.execPath,
          args: ['apps/threadnote/test/fixtures/semantic/fake-provider.ts', mode],
          cwd: process.cwd(),
          environment: process.env,
        });
        const client = yield* makeLspClient(wire);
        expect(yield* client.request('echo', {text: '🧵\r\n'}, 1000)).toEqual({text: '🧵\r\n'});
        const stopped = yield* client.close;
        expect(stopped.graceful).toBe(graceful);
        expect(stopped.drained).toBe(true);
        expect(stopped.stdioClosed).toBe(true);
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
