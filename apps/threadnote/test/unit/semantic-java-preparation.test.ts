import {cryptoLayer} from '@threadnote/platform/crypto';
/* oxlint-disable effecttsgo/strict-effect-provide -- Focused filesystem and deterministic clock tests, without application services. */
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {
  Arbitrary,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Schema,
  Scope,
  Stream,
} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import * as fingerprints from '../../src/semantic/fingerprint.js';
import {LspFault, makeLspClient, type LspWire} from '../../src/semantic/lsp_transport.js';
import {SemanticSetupFault} from '../../src/semantic/provider.js';
import * as javaRuntime from '../../src/semantic/providers/java_runtime.js';
import * as nativePlatform from '@threadnote/platform/system';
import * as javaPreparation from '../../src/semantic/providers/java_preparation.js';
import {makeJavaPreparation, type JavaPreparationHost} from '../../src/semantic/providers/java.js';
import {
  finishJavaPreparation,
  javaRuntimeQualification,
  makeJavaRuntime,
  makeJavaWorkspace,
  materializeJavaRuntimeConfiguration,
  type JavaRuntimeCandidate,
} from '../../src/semantic/providers/java_runtime.js';
import {semanticSdkDigest, semanticTreeDigest} from '../../src/semantic/fingerprint.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {makeJavaPreparedProject, javaPreparedProjection} from '../../src/semantic/providers/java_project.js';
import {javaFileUri} from '../../src/semantic/providers/java_snapshot.js';
import {
  JavaPreparedModel,
  JavaPreparedObservation,
  copyJavaPreparationInputs,
  consumeJavaPreparationConnection,
  javaPreparedModelCommand,
  javaPreparedModelJson,
  javaSourceEncodingImage,
  observeJavaPreparedImport,
  sealJavaPreparedModel,
  verifyJavaPreparationInputs,
  verifyJavaSourceEncoding,
  loadJavaPreparedModel,
} from '../../src/semantic/providers/java_preparation.js';

const candidate = (): JavaRuntimeCandidate => ({
  serverDirectory: '/host/jdtls',
  serverTreeDigest: javaRuntimeQualification.serverTreeDigest,
  runtimeJavaHome: '/host/jdk25',
  runtimeSdkDigest: javaRuntimeQualification.runtimeSdkDigest,
  projectJavaHome: '/host/jdk21',
  projectSdkDigest: javaRuntimeQualification.projectSdkDigest,
});
const macEffect = process.platform === 'darwin' && process.arch === 'arm64' ? effectIt.effect : effectIt.effect.skip;

const modelFixture = Effect.fn('test.javaPreparedModelFixture')(function* (
  control: {
    readonly deferImport?: boolean;
    readonly failure?: 'initialize' | 'status' | 'token' | 'missing-ready' | 'late-status';
    readonly changeSecondModel?: boolean;
    readonly afterSecondModel?: Effect.Effect<void>;
    readonly hostVerify?: Effect.Effect<void, LspFault>;
    readonly sourceBytes?: Uint8Array;
    readonly resourcePreferences?: string;
    readonly jarText?: string;
    readonly encodingCount?: number;
    readonly encodingDigest?: string;
    readonly passiveProject?: boolean;
    readonly noFilters?: boolean;
    readonly minimalBuildInputs?: boolean;
    readonly separateWorkspaceParent?: boolean;
    readonly observerGate?: {readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void>};
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-seal-'}));
  const project = path.join(parent, 'original');
  const artifactDirectory = path.join(parent, 'artifacts');
  const javaHome = path.join(parent, 'jdk');
  for (const directory of [project, artifactDirectory, javaHome]) yield* fs.makeDirectory(directory, {mode: 0o700});
  const uri = (file: string) => path.toFileUrl(file).pipe(Effect.map(url => url.href));
  for (const root of [project]) {
    yield* fs.makeDirectory(path.join(root, 'src/main/java'), {recursive: true});
    const main = path.join(root, 'src/main/java/Main.java');
    yield* control.sourceBytes ? fs.writeFile(main, control.sourceBytes) : fs.writeFileString(main, 'class Main {}\n');
  }
  if (control.resourcePreferences !== undefined) {
    yield* fs.makeDirectory(path.join(project, '.settings'), {mode: 0o700});
    yield* fs.writeFileString(
      path.join(project, '.settings/org.eclipse.core.resources.prefs'),
      control.resourcePreferences,
    );
  }
  yield* fs.writeFileString(path.join(project, 'pom.xml'), '<project>captured build configuration</project>');
  // Payload properties need the real Maven/source boundary, not unrelated build-tool inputs.
  const extraBuildInputs = control.minimalBuildInputs
    ? []
    : ['settings.gradle', 'build.gradle', 'gradle.properties', '.mvn/maven.config', '.project'];
  for (const relative of extraBuildInputs) {
    yield* fs.makeDirectory(path.dirname(path.join(project, relative)), {recursive: true});
    yield* fs.writeFileString(path.join(project, relative), 'captured input: ' + relative);
  }
  const workspaceParent = control.separateWorkspaceParent ? path.join(parent, 'setup') : parent;
  if (control.separateWorkspaceParent) yield* fs.makeDirectory(workspaceParent, {mode: 0o700});
  const workspace = yield* makeJavaWorkspace(workspaceParent);
  const inputs = yield* copyJavaPreparationInputs({project, worktree: project, workspace, build: 'maven'});
  const copiedProject = inputs.copiedProject;
  const runtimeDirectory = path.join(workspace.directory, 'jdt-fixture');
  yield* fs.makeDirectory(runtimeDirectory, {mode: 0o700});
  yield* fs.makeDirectory(path.join(javaHome, 'lib'));
  const jrt = path.join(javaHome, 'lib/jrt-fs.jar');
  yield* fs.writeFileString(jrt, 'synthetic SDK artifact');
  if (control.passiveProject) yield* fs.writeFileString(path.join(javaHome, 'lib/src.zip'), 'synthetic sources');
  yield* fs.makeDirectory(path.join(runtimeDirectory, 'm2'), {mode: 0o700});
  const jar = path.join(runtimeDirectory, 'm2/library.jar');
  const jarText = control.jarText ?? 'synthetic pinned library';
  yield* fs.writeFileString(jar, jarText);
  const common = {
    exported: false,
    combineAccessRules: false,
    inclusions: [],
    exclusions: [],
    attributes: [],
    accessRules: [],
  };
  const source = {
    ...common,
    kind: 3,
    contentKind: 1,
    path: '/fixture/src/main/java',
    exists: true,
    uri: yield* uri(path.join(copiedProject, 'src/main/java')),
    outputUri: yield* uri(path.join(copiedProject, 'target/classes')),
    inclusions: ['**/*.java'],
    exclusions: ['**/Excluded.java'],
    attributes: [{name: 'optional', value: 'true'}],
  };
  const absent = {
    ...source,
    path: '/fixture/src/test/java',
    exists: false,
    uri: yield* uri(path.join(copiedProject, 'src/test/java')),
    outputUri: yield* uri(path.join(copiedProject, 'target/test-classes')),
    attributes: [
      {name: 'optional', value: 'true'},
      {name: 'test', value: 'true'},
    ],
  };
  const jrePath =
    'org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21';
  const observation = yield* Schema.decodeUnknownEffect(JavaPreparedObservation)({
    protocolVersion: 1,
    requestToken: 'fixture',
    status: 'observed-cached',
    vm: {
      type: 'org.eclipse.jdt.internal.launching.macosx.MacOSXType',
      id: 'fixture',
      name: 'JavaSE-21',
      javaHomeUri: yield* uri(javaHome),
    },
    libraries: [
      {uri: yield* uri(jar), bytes: new TextEncoder().encode(jarText).length, sha256: sha256HexSync(jarText)},
    ],
    model: {
      projectUri: yield* uri(copiedProject),
      build: 'maven',
      projectCharset: 'UTF-8',
      sourceEncoding: {
        policy: 'utf8-no-bom-v1',
        sourceCount: control.encodingCount ?? 1,
        sourceDigest:
          control.encodingDigest ??
          sha256HexSync(
            'threadnote-java-source-encoding-v1\n23:src/main/java/Main.java' +
              sha256HexSync(control.sourceBytes ?? new TextEncoder().encode('class Main {}\n')),
          ),
      },
      rawTimestamp: 1,
      natures: ['org.eclipse.jdt.core.javanature', 'org.eclipse.m2e.core.maven2Nature'],
      cachedOptionsSha256: sha256HexSync('fixture'),
      compilerOptions: {
        'org.eclipse.jdt.core.compiler.compliance': '21',
        'org.eclipse.jdt.core.compiler.source': '21',
        'org.eclipse.jdt.core.compiler.codegen.targetPlatform': '21',
        'org.eclipse.jdt.core.compiler.release': 'enabled',
        'org.eclipse.jdt.core.compiler.processAnnotations': 'disabled',
        'org.eclipse.jdt.core.compiler.problem.unusedImport': 'error',
      },
      outputUri: yield* uri(path.join(copiedProject, 'target/classes')),
      resourceFilters: control.noFilters
        ? []
        : [
            {
              id: '123',
              path: '',
              type: 30,
              matcherId: 'org.eclipse.core.resources.regexFilterMatcher',
              arguments: 'node_modules|\\.git|__CREATED_BY_JAVA_LANGUAGE_SERVER__',
            },
          ],
      rawClasspath: [
        source,
        {...common, kind: 5, contentKind: 1, path: jrePath, combineAccessRules: control.passiveProject ?? false},
        {
          ...common,
          kind: 5,
          contentKind: 1,
          path: 'org.eclipse.m2e.MAVEN2_CLASSPATH_CONTAINER',
          combineAccessRules: control.passiveProject ?? false,
        },
        absent,
      ],
      resolvedClasspath: [
        source,
        {
          ...common,
          kind: 1,
          contentKind: 2,
          path: jrt,
          uri: yield* uri(jrt),
          ...(control.passiveProject ? {sourceAttachmentPath: path.join(javaHome, 'lib/src.zip')} : {}),
        },
        {
          ...common,
          kind: 1,
          contentKind: 2,
          path: jar,
          uri: yield* uri(jar),
          attributes: [{name: 'maven.version', value: '1.0'}],
        },
        absent,
      ],
    },
  });
  const messages = yield* Queue.unbounded<Record<string, unknown>, Cause.Done>();
  const methods: string[] = [];
  let stopped = false;
  let observations = 0;
  const wire: LspWire = {
    pid: 4242,
    messages: Stream.fromQueue(messages),
    failure: () => (stopped ? LspFault.make({code: 'exit'}) : undefined),
    beginClosing: Effect.void,
    finish: Effect.sync(() => {
      stopped = true;
    }).pipe(
      Effect.andThen(Queue.end(messages)),
      Effect.as({code: 0, drained: true, forced: false, stdioClosed: true, fault: undefined}),
    ),
    send: message =>
      Effect.gen(function* () {
        if (typeof message.method === 'string') methods.push(message.method);
        if (message.method === 'initialize') {
          if (control.failure === 'initialize') {
            yield* Queue.offer(messages, {
              jsonrpc: '2.0',
              id: message.id,
              error: {code: -32603, message: 'synthetic initialization failure'},
            });
            return;
          }
          yield* fs.writeFileString(path.join(copiedProject, '.classpath'), '<classpath>mock SDK output</classpath>');
          yield* Queue.offer(messages, {
            jsonrpc: '2.0',
            id: message.id,
            result: {capabilities: {executeCommandProvider: {commands: [javaPreparedModelCommand]}}},
          });
        } else if (message.method === 'initialized') {
          if (control.failure === 'missing-ready') return;
          yield* Queue.offer(messages, {
            jsonrpc: '2.0',
            method: 'language/status',
            params: {type: control.failure === 'status' ? 'Error' : 'ServiceReady'},
          });
        } else if (message.method === 'workspace/executeCommand') {
          observations++;
          const request = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              command: Schema.Literal(javaPreparedModelCommand),
              arguments: Schema.Tuple([
                Schema.Struct({protocolVersion: Schema.Literal(1), requestToken: Schema.String}),
              ]),
            }),
          )(message.params).pipe(Effect.mapError(() => LspFault.make({code: 'protocol'})));
          if (control.observerGate) {
            yield* Deferred.succeed(control.observerGate.entered, undefined);
            yield* Deferred.await(control.observerGate.release);
          }
          if (control.failure === 'late-status')
            yield* Queue.offer(messages, {jsonrpc: '2.0', method: 'language/status', params: {type: 'Error'}});
          if (observations === 2 && control.afterSecondModel) yield* control.afterSecondModel;
          yield* Queue.offer(messages, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              ...observation,
              model: {
                ...observation.model,
                rawTimestamp: control.changeSecondModel && observations > 1 ? 2 : observation.model.rawTimestamp,
              },
              requestToken: control.failure === 'token' ? 'wrong-token' : request.arguments[0].requestToken,
            },
          });
        } else if (message.method === 'shutdown') {
          yield* Queue.offer(messages, {jsonrpc: '2.0', id: message.id, result: null});
        } else if (message.method === 'exit') yield* Queue.end(messages);
      }).pipe(Effect.mapError(() => LspFault.make({code: 'protocol'}))),
  };
  const runtime = Object.freeze({
    pid: wire.pid,
    finish: wire.finish,
    directory: runtimeDirectory,
    verify: control.hostVerify ?? Effect.void,
    inputs,
    projectJavaHome: javaHome,
  });
  let deliverStatus: (method: string, params: unknown) => void = () => {};
  // This protocol fixture replaces only the qualified-process boundary; real SDK/process qualification uses native probes.
  const observe = Effect.suspend(() => {
    const runtimeGuard = vi
      .spyOn(javaRuntime, 'isJavaPreparationRuntime')
      .mockImplementation(value => value === runtime);
    const connect = vi
      .spyOn(javaRuntime, 'makeJavaPreparationClient')
      .mockImplementation((owned, admission, onNotification, settings) =>
        consumeJavaPreparationConnection(owned, admission).pipe(
          Effect.andThen(
            Effect.sync(() => {
              deliverStatus = onNotification;
            }),
          ),
          Effect.andThen(makeLspClient(wire, onNotification, settings)),
        ),
      );
    return observeJavaPreparedImport({runtime}).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          runtimeGuard.mockRestore();
          connect.mockRestore();
        }),
      ),
    );
  });
  const imported = control.deferImport ? observation : yield* observe;
  const options = {
    requestToken: imported.requestToken,
    build: 'maven' as const,
    inputs,
    runtimeDirectory,
    artifactDirectory,
    javaHome,
    javaSdkDigest: yield* semanticSdkDigest(javaHome),
    verify: Effect.void,
  };
  return {
    fs,
    path,
    project,
    copiedProject,
    runtimeDirectory,
    artifactDirectory,
    javaHome,
    jar,
    jarText,
    observation: imported,
    options,
    runtime,
    wire,
    workspace,
    emitError: Effect.sync(() => deliverStatus('language/status', {type: 'Error'})),
    observe,
    methods,
  };
});

const preparationCompositionLayer = Layer.merge(
  Layer.merge(BunServices.layer, cryptoLayer),
  Layer.succeed(ChildEnvironmentPolicy, {
    sanitizeExternal: environment => environment,
    preserveIntendedChild: environment => environment,
  }),
);
const preparationCompositionFixture = Effect.fn('test.javaPreparationCompositionFixture')(function* (
  control: {
    readonly beforeCapture?: Effect.Effect<void, LspFault>;
    readonly afterCapture?: Effect.Effect<void, LspFault>;
  } = {},
) {
  const fixture = yield* modelFixture({
    deferImport: true,
    passiveProject: true,
    noFilters: true,
    separateWorkspaceParent: true,
  });
  const events: string[] = [];
  let drained = false;
  const sdkControl = {rejectAfterModelLoad: false};
  const mark = (event: string) => Effect.sync(() => void events.push(event));
  const options = {
    project: fixture.project,
    worktree: fixture.project,
    candidate: {...candidate(), projectJavaHome: fixture.javaHome, projectSdkDigest: fixture.options.javaSdkDigest},
    privateDirectory: fixture.path.dirname(fixture.workspace.directory),
    artifactDirectory: fixture.artifactDirectory,
    build: 'maven' as const,
  };
  const host: JavaPreparationHost = {
    beforePreparationLaunch: () => {
      events.push('before-launch');
    },
    capturePreparationProvider: (_pid, finish) => {
      expect(finish).toBe(fixture.wire.finish);
      events.push('capture-finish');
    },
    verifySetup: mark('authorize'),
    onProviderStarted: pid =>
      Effect.sync(() => expect(pid).toBe(fixture.runtime.pid)).pipe(Effect.andThen(mark('admit'))),
    provisionOfflineCache: context =>
      Effect.sync(() => {
        expect(Object.isFrozen(context)).toBe(true);
        expect(context.gradleUserHome).toBe(fixture.path.join(fixture.runtimeDirectory, 'gradle'));
      }).pipe(Effect.andThen(mark('cache'))),
    drainBuildProcesses: () => mark('drain-build').pipe(Effect.as({drained: true})),
  };
  // Reuse preallocated genuine copied inputs; mock native launch and composition allocation, retaining real import/seal/read.
  const workspace = vi.spyOn(javaRuntime, 'makeJavaWorkspace').mockReturnValue(Effect.succeed(fixture.workspace));
  const copied = vi
    .spyOn(javaPreparation, 'copyJavaPreparationInputs')
    .mockReturnValue(Effect.succeed(fixture.options.inputs));
  const genuine = vi
    .spyOn(javaRuntime, 'isJavaPreparationRuntime')
    .mockImplementation(value => value === fixture.runtime);
  const connect = vi
    .spyOn(javaRuntime, 'makeJavaPreparationClient')
    .mockImplementation((owned, admission, onNotification, settings) =>
      consumeJavaPreparationConnection(owned, admission).pipe(
        Effect.andThen(mark('initialize')),
        Effect.andThen(makeLspClient(fixture.wire, onNotification, settings)),
      ),
    );
  const runtime = vi.spyOn(javaRuntime, 'makeJavaRuntime').mockReturnValue(
    Effect.succeed({
      identity: 'fixture',
      projectJavaHome: fixture.javaHome,
      verify: Effect.suspend(() =>
        sdkControl.rejectAfterModelLoad && events.includes('load-model')
          ? SemanticSetupFault.make({
              providerId: 'jdtls',
              component: 'sdk',
              reason: 'incompatible',
              requiredVersion: javaRuntimeQualification.serverVersion,
              requiredSdkVersion: javaRuntimeQualification.runtimeVersion,
              nextAction: 'Restore the fixture SDK',
            })
          : mark('verify-sdk'),
      ),
      analysis: () => Effect.die('Analysis must not launch during preparation'),
      preparation: launch =>
        Effect.gen(function* () {
          yield* fixture.workspace.hold;
          yield* Effect.addFinalizer(() =>
            finishJavaPreparation(
              fixture.workspace,
              mark('stop-provider').pipe(Effect.andThen(fixture.wire.finish)),
              Effect.suspend(() =>
                launch.drainBuildProcesses({
                  runtimeDirectory: fixture.runtimeDirectory,
                  gradleUserHome: fixture.path.join(fixture.runtimeDirectory, 'gradle'),
                }),
              ),
            ).pipe(Effect.andThen(Effect.sync(() => void (drained = true))), Effect.orDie),
          );
          yield* mark('spawn');
          if (control.beforeCapture) yield* control.beforeCapture;
          launch.capturePreparationProvider(fixture.wire.pid, fixture.wire.finish);
          if (control.afterCapture) yield* control.afterCapture;
          return fixture.runtime;
        }),
    }),
  );
  const originalLoad = loadJavaPreparedModel;
  const load = vi.spyOn(javaPreparation, 'loadJavaPreparedModel').mockImplementation(selected =>
    Effect.sync(() => {
      expect(drained).toBe(true);
      events.push('load-model');
    }).pipe(Effect.andThen(originalLoad(selected))),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const spy of [workspace, copied, genuine, connect, runtime, load]) spy.mockRestore();
    }),
  );
  return {
    ...fixture,
    options,
    host,
    events,
    runtimeFactory: runtime,
    workspaceFactory: workspace,
    load,
    sdkControl,
    drained: () => drained,
  };
});

describe('Java preparation composition', () => {
  effectIt.effect('returns a frozen, independently readable model after provider and build drain', () =>
    Effect.gen(function* () {
      const f = yield* preparationCompositionFixture();
      const input = structuredClone(f.options);
      const original = JSON.stringify(input);
      const host = {...f.host};
      host.onProviderStarted = pid =>
        f.host.onProviderStarted(pid).pipe(
          Effect.andThen(
            Effect.sync(() => {
              input.project = '/substituted';
              input.candidate.projectJavaHome = '/substituted-jdk';
              host.provisionOfflineCache = () => Effect.die('Caller mutated captured host callback');
            }),
          ),
        );
      expect(JSON.stringify(input)).toBe(original);
      const descriptor = yield* makeJavaPreparation(input, host);
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(f.drained()).toBe(true);
      expect(f.events.indexOf('before-launch')).toBeLessThan(f.events.indexOf('spawn'));
      expect(f.events.indexOf('capture-finish')).toBeLessThan(f.events.indexOf('admit'));
      expect(f.events.indexOf('admit')).toBeLessThan(f.events.indexOf('initialize'));
      expect(f.events.indexOf('cache')).toBeLessThan(f.events.indexOf('initialize'));
      expect(f.events.indexOf('stop-provider')).toBeLessThan(f.events.indexOf('drain-build'));
      expect(f.events.indexOf('drain-build')).toBeLessThan(f.events.indexOf('load-model'));
      expect(f.load).toHaveBeenCalledOnce();
      const loaded = yield* loadJavaPreparedModel({
        ...descriptor,
        project: f.project,
        worktree: f.project,
        javaHome: f.javaHome,
      });
      yield* loaded.verify;
      expect(loaded.model.build).toBe('maven');
      expect(loaded.model.libraries).toHaveLength(1);
      expect(yield* semanticTreeDigest(f.project)).toBe(f.runtime.inputs.sourceDigest);
      expect(EffectArray.filter(f.methods, method => method === 'workspace/executeCommand')).toHaveLength(2);
    }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect('denied host authority cannot allocate or launch setup', () =>
    Effect.gen(function* () {
      const f = yield* preparationCompositionFixture();
      const result = yield* Effect.exit(
        makeJavaPreparation(f.options, {...f.host, verifySetup: LspFault.make({code: 'prerequisite'})}),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(f.runtimeFactory).not.toHaveBeenCalled();
      expect(f.events).toEqual([]);
      expect(f.methods).toEqual([]);
    }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect(
    'captures the original finish before post-spawn verification failure and never reaches later bind',
    () =>
      Effect.gen(function* () {
        const captured = yield* Deferred.make<void>();
        const failVerification = yield* Deferred.make<void>();
        const f = yield* preparationCompositionFixture({
          afterCapture: Deferred.succeed(captured, undefined).pipe(
            Effect.andThen(Deferred.await(failVerification)),
            Effect.andThen(LspFault.make({code: 'prerequisite'})),
          ),
        });
        let originalFinish: Effect.Effect<import('../../src/semantic/lsp_transport.js').WireStop> | undefined;
        const operation = yield* Effect.forkChild(
          makeJavaPreparation(f.options, {
            ...f.host,
            capturePreparationProvider: (_pid, finish) => {
              originalFinish = finish;
            },
          }),
        );
        yield* Deferred.await(captured);
        expect(originalFinish).toBe(f.wire.finish);
        expect(f.events).toContain('before-launch');
        expect(f.events).not.toContain('admit');
        yield* Deferred.succeed(failVerification, undefined);
        expect(Exit.isFailure(yield* Fiber.await(operation))).toBe(true);
        expect(f.drained()).toBe(true);
        expect(originalFinish && (yield* originalFinish)).toMatchObject({drained: true, stdioClosed: true});
        expect(f.events).not.toContain('cache');
        expect(f.load).not.toHaveBeenCalled();
      }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect('keeps launch uncertainty when interrupted inside preparation before a finish reaches the host', () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<void>();
      const f = yield* preparationCompositionFixture({
        beforeCapture: Deferred.succeed(spawned, undefined).pipe(Effect.andThen(Effect.never)),
      });
      let finishCaptured = false;
      const operation = yield* Effect.forkChild(
        makeJavaPreparation(f.options, {
          ...f.host,
          capturePreparationProvider: () => {
            finishCaptured = true;
          },
        }),
      );
      yield* Deferred.await(spawned);
      yield* Fiber.interrupt(operation);
      expect(f.events).toContain('before-launch');
      expect(f.events).not.toContain('admit');
      expect(finishCaptured).toBe(false);
      expect(f.load).not.toHaveBeenCalled();
    }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect('registration refusal drains before any cache provisioning or import', () =>
    Effect.gen(function* () {
      const f = yield* preparationCompositionFixture();
      const result = yield* Effect.exit(
        makeJavaPreparation(f.options, {
          ...f.host,
          onProviderStarted: () =>
            Effect.sync(() => expect(f.events).toContain('capture-finish')).pipe(
              Effect.andThen(LspFault.make({code: 'capacity'})),
            ),
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(f.drained()).toBe(true);
      expect(f.events).not.toContain('cache');
      expect(f.methods).toEqual([]);
      expect(f.load).not.toHaveBeenCalled();
    }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect('authority lost during cache provisioning refuses import and still drains', () =>
    Effect.gen(function* () {
      const f = yield* preparationCompositionFixture();
      let permitted = true;
      const result = yield* Effect.exit(
        makeJavaPreparation(f.options, {
          ...f.host,
          verifySetup: Effect.suspend(() => (permitted ? Effect.void : LspFault.make({code: 'prerequisite'}))),
          provisionOfflineCache: () => Effect.sync(() => void (permitted = false)),
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(f.drained()).toBe(true);
      expect(f.methods).toEqual([]);
      expect(f.load).not.toHaveBeenCalled();
    }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect('source drift during shutdown prevents descriptor publication', () =>
    Effect.gen(function* () {
      const f = yield* preparationCompositionFixture();
      const result = yield* Effect.exit(
        makeJavaPreparation(f.options, {
          ...f.host,
          drainBuildProcesses: () =>
            f.fs.writeFileString(f.path.join(f.project, 'pom.xml'), 'changed during setup shutdown').pipe(
              Effect.mapError(() => LspFault.make({code: 'prerequisite'})),
              Effect.as({drained: true}),
            ),
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(f.drained()).toBe(true);
      expect(f.load).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect('source drift during the final host authorization check prevents descriptor publication', () =>
    Effect.gen(function* () {
      const f = yield* preparationCompositionFixture();
      const result = yield* Effect.exit(
        makeJavaPreparation(f.options, {
          ...f.host,
          verifySetup: Effect.suspend(() =>
            f.load.mock.calls.length
              ? f.fs.writeFileString(f.path.join(f.project, 'pom.xml'), 'changed during final host check')
              : Effect.void,
          ),
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(f.drained()).toBe(true);
      expect(f.load).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect('SDK verification runs after the persisted model loader before descriptor publication', () =>
    Effect.gen(function* () {
      const f = yield* preparationCompositionFixture();
      f.sdkControl.rejectAfterModelLoad = true;
      const result = yield* Effect.exit(makeJavaPreparation(f.options, f.host));
      expect(Exit.isFailure(result)).toBe(true);
      expect(f.drained()).toBe(true);
      expect(f.load).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect('a linked worktree spelling is rejected before runtime or workspace acquisition', () =>
    Effect.gen(function* () {
      const f = yield* preparationCompositionFixture();
      const alias = f.path.join(f.path.dirname(f.project), 'source-alias');
      yield* f.fs.symlink(f.project, alias);
      const result = yield* Effect.exit(
        makeJavaPreparation({...f.options, project: alias, worktree: alias, privateDirectory: f.project}, f.host),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(f.workspaceFactory).not.toHaveBeenCalled();
      expect(f.runtimeFactory).not.toHaveBeenCalled();
    }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect('a canonical project outside the selected worktree is rejected before allocation', () =>
    Effect.gen(function* () {
      const f = yield* preparationCompositionFixture();
      const result = yield* Effect.exit(
        makeJavaPreparation(
          {...f.options, project: f.artifactDirectory, privateDirectory: f.artifactDirectory},
          f.host,
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(f.workspaceFactory).not.toHaveBeenCalled();
      expect(f.runtimeFactory).not.toHaveBeenCalled();
      expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
    }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect('a linked Gradle SDK spelling is rejected before runtime or workspace acquisition', () =>
    Effect.gen(function* () {
      const f = yield* preparationCompositionFixture();
      const root = f.path.join(f.path.dirname(f.project), 'gradle-sdk');
      const alias = f.path.join(f.path.dirname(f.project), 'gradle-alias');
      yield* f.fs.makeDirectory(root, {mode: 0o700});
      yield* f.fs.symlink(root, alias);
      const result = yield* Effect.exit(
        makeJavaPreparation(
          {
            ...f.options,
            build: 'gradle',
            gradle: {
              sdkDirectory: alias,
              sdkDigest: '6da4ff86101bec03978e03b6acdb2d8ae958759c1da1dc69aa8e1d83f78ff9bc',
            },
            privateDirectory: root,
          },
          f.host,
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(f.workspaceFactory).not.toHaveBeenCalled();
      expect(f.runtimeFactory).not.toHaveBeenCalled();
      expect(yield* f.fs.readDirectory(root)).toEqual([]);
    }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect('unconfirmed build shutdown prevents returning a sealed descriptor', () =>
    Effect.gen(function* () {
      const f = yield* preparationCompositionFixture();
      const result = yield* Effect.exit(
        makeJavaPreparation(f.options, {
          ...f.host,
          drainBuildProcesses: () => Effect.succeed({drained: false}),
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(f.drained()).toBe(false);
      expect(f.methods).toContain('workspace/executeCommand');
      expect(f.load).not.toHaveBeenCalled();
      // The fixture owns no actual child; production retains the held workspace on this failure.
      yield* f.workspace.confirmDrained({drained: true, stdioClosed: true});
    }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect('interruption during cache provisioning awaits owned cleanup', () =>
    Effect.gen(function* () {
      const f = yield* preparationCompositionFixture();
      const entered = yield* Deferred.make<void>();
      const child = yield* makeJavaPreparation(f.options, {
        ...f.host,
        provisionOfflineCache: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(child);
      expect(f.drained()).toBe(true);
      expect(f.methods).toEqual([]);
      expect(f.load).not.toHaveBeenCalled();
    }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect('stalled cache provisioning times out and drains without initializing', () =>
    Effect.gen(function* () {
      const f = yield* preparationCompositionFixture();
      const entered = yield* Deferred.make<void>();
      const child = yield* makeJavaPreparation(f.options, {
        ...f.host,
        provisionOfflineCache: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      }).pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(180001);
      const result = yield* Fiber.join(child);
      expect(Exit.isFailure(result)).toBe(true);
      expect(f.drained()).toBe(true);
      expect(f.methods).toEqual([]);
    }).pipe(Effect.provide(preparationCompositionLayer)),
  );

  effectIt.effect.prop(
    'neither output parent can overlap source or any selected SDK before host execution',
    [
      Schema.Literals(['privateDirectory', 'artifactDirectory']),
      Schema.Literals(['worktree', 'serverDirectory', 'runtimeJavaHome', 'projectJavaHome', 'gradle']),
      Schema.Literals(['same', 'parent', 'child']),
    ],
    ([output, protectedRoot, relation]) =>
      Effect.gen(function* () {
        const f = yield* preparationCompositionFixture();
        const root =
          protectedRoot === 'worktree'
            ? f.project
            : protectedRoot === 'gradle'
              ? '/host/gradle'
              : f.options.candidate[protectedRoot];
        const directory =
          relation === 'same' ? root : relation === 'parent' ? f.path.dirname(root) : f.path.join(root, 'output');
        const result = yield* Effect.exit(
          makeJavaPreparation(
            {
              ...f.options,
              build: 'gradle',
              gradle: {
                sdkDirectory: '/host/gradle',
                sdkDigest: '6da4ff86101bec03978e03b6acdb2d8ae958759c1da1dc69aa8e1d83f78ff9bc',
              },
              [output]: directory,
            },
            f.host,
          ),
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(f.runtimeFactory).not.toHaveBeenCalled();
        expect(f.events).toEqual([]);
      }).pipe(Effect.provide(preparationCompositionLayer)),
    {arbitrary: {runs: 24}},
  );

  effectIt.effect.prop(
    'caller JSON cannot select execution authority, JVMs, bundles or commands',
    [Schema.Literals(['authorized', 'verifySetup', 'command', 'jvmArgs', 'bundle', 'policy'])],
    ([key]) =>
      Effect.gen(function* () {
        const f = yield* preparationCompositionFixture();
        const result = yield* Effect.exit(makeJavaPreparation({...f.options, [key]: true}, f.host));
        expect(Exit.isFailure(result)).toBe(true);
        expect(f.runtimeFactory).not.toHaveBeenCalled();
        expect(f.events).toEqual([]);
      }).pipe(Effect.provide(preparationCompositionLayer)),
    {arbitrary: {runs: 12}},
  );
});

describe('Java qualified JRE container spelling', () => {
  effectIt.effect('preserves the imported trailing separator through a passive projection', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture({passiveProject: true});
      const sealed = yield* sealJavaPreparedModel(f.observation, f.options);
      const jre =
        'org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21';
      const bindings = yield* Effect.forEach(
        EffectArray.filter(sealed.model.rawClasspath, entry => entry.kind === 3),
        entry =>
          f.path
            .toFileUrl(f.path.join(f.project, entry.path))
            .pipe(Effect.map(url => ({path: entry.path, uri: url.href}))),
      );
      const documentationUri = 'file:///threadnote-test-documentation/';
      const plain = javaPreparedProjection(sealed.model, bindings, documentationUri);
      const trailing = javaPreparedProjection(
        {
          ...sealed.model,
          rawClasspath: EffectArray.map(sealed.model.rawClasspath, entry =>
            entry.path === jre ? {...entry, path: jre + '/'} : entry,
          ),
        },
        bindings,
        documentationUri,
      );
      expect(trailing.image.resolvedClasspath).toEqual(plain.image.resolvedClasspath);
      expect(trailing.image.links).toEqual(plain.image.links);
      const expected = EffectArray.map(
        EffectArray.filter(plain.image.rawClasspath, entry => entry.path === jre),
        entry => ({...entry, path: jre + '/'}),
      );
      expect(expected).toHaveLength(1);
      expect(EffectArray.filter(trailing.image.rawClasspath, entry => entry.path === jre + '/')).toEqual(expected);
      expect(trailing.metadata['.classpath']).toContain(jre + '/');
      expect(trailing.digest).not.toBe(plain.digest);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );

  effectIt.effect('accepts only the two exact qualified spellings, not other containers or nested paths', () =>
    Effect.gen(function* () {
      // Only projection varies: keep one genuinely observed and sealed immutable model alive for all suffixes.
      const f = yield* modelFixture({passiveProject: true});
      const sealed = yield* sealJavaPreparedModel(f.observation, f.options);
      const jre =
        'org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21';
      const bindings = yield* Effect.forEach(
        EffectArray.filter(sealed.model.rawClasspath, entry => entry.kind === 3),
        entry =>
          f.path
            .toFileUrl(f.path.join(f.project, entry.path))
            .pipe(Effect.map(url => ({path: entry.path, uri: url.href}))),
      );
      const result = yield* Arbitrary.checkEffect(
        Arbitrary.schema(Schema.String.check(Schema.isMaxLength(12))),
        suffix =>
          Effect.try(() => {
            for (const extra of [suffix, '//', '/other', '-other']) {
              const model = {
                ...sealed.model,
                rawClasspath: EffectArray.map(sealed.model.rawClasspath, entry =>
                  entry.path === jre ? {...entry, path: jre + extra} : entry,
                ),
              };
              const projection = () =>
                javaPreparedProjection(model, bindings, 'file:///threadnote-test-documentation/');
              if (extra === '' || extra === '/') expect(projection).not.toThrow();
              else expect(projection).toThrow();
            }
            return true;
          }),
        {runs: 16},
      );
      expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
});

describe('Java passive prepared project', () => {
  const fixture = Effect.fn('test.javaPassiveProject')(function* (
    noFilters = false,
    jarText?: string,
    minimalBuildInputs = false,
  ) {
    const f = yield* modelFixture({passiveProject: true, noFilters, jarText, minimalBuildInputs});
    const sealed = yield* sealJavaPreparedModel(f.observation, f.options);
    const privateDirectory = f.path.join(f.artifactDirectory, 'analysis');
    yield* f.fs.makeDirectory(privateDirectory, {mode: 0o700});
    const options = {
      project: f.project,
      worktree: f.project,
      javaHome: f.javaHome,
      privateDirectory,
      environment: {id: 'java-v2', metadataFile: sealed.metadataFile, metadataDigest: sealed.metadataDigest},
    };
    return {...f, sealed, materializerOptions: options};
  });
  for (const noFilters of [false, true])
    effectIt.effect(`preserves prepared metadata with ${noFilters ? 'no' : 'the standard'} resource filter`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(noFilters);
        const methods = [...f.methods];
        const original = yield* f.fs.readFileString(f.sealed.metadataFile);
        const prepared = yield* makeJavaPreparedProject(f.materializerOptions);
        const bindings = yield* Effect.forEach(
          EffectArray.filter(f.sealed.model.rawClasspath, entry => entry.kind === 3),
          entry =>
            f.path
              .toFileUrl(f.path.join(f.project, entry.path))
              .pipe(Effect.map(url => ({path: entry.path, uri: javaFileUri(url)}))),
        );
        const expected = javaPreparedProjection(f.sealed.model, bindings, prepared.documentationUri);
        for (const [name, content] of EffectRecord.toEntries(expected.metadata))
          expect(yield* f.fs.readFileString(f.path.join(prepared.project, name))).toBe(content);
        expect(prepared.projectionDigest).toBe(expected.digest);
        expect(prepared.compilerOptions).toEqual(f.sealed.model.compilerOptions);
        expect(prepared.sourceRoots).toEqual([f.path.join(f.project, 'src/main/java')]);
        expect(prepared.absentSourceRoots).toEqual([f.path.join(f.project, 'src/test/java')]);
        expect(yield* f.fs.exists(prepared.absentSourceRoots[0])).toBe(false);
        for (const name of ['output-0', 'output-1']) {
          expect(yield* f.fs.readDirectory(f.path.join(prepared.project, name))).toEqual([]);
          expect((yield* f.fs.stat(f.path.join(prepared.project, name))).mode & 0o777).toBe(0o700);
        }
        expect(yield* f.fs.readDirectory(f.path.join(prepared.directory, 'documentation'))).toEqual([]);
        expect(prepared.settings.java.project.resourceFilters).toEqual(noFilters ? [] : ['node_modules', '\\.git']);
        expect(prepared.settings.java.configuration.runtimes[0].javadoc).toBe(prepared.documentationUri);
        expect(prepared.settings.java.compile.nullAnalysis).toEqual({
          mode: 'interactive',
          nonnull: [],
          nullable: [],
          nonnullbydefault: [],
        });
        yield* prepared.verify;
        expect(f.methods).toEqual(methods);
        expect(yield* f.fs.readFileString(f.sealed.metadataFile)).toBe(original);
        expect(yield* semanticTreeDigest(f.project)).toBe(f.sealed.model.sourceDigest);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );
  for (const mutation of [
    'metadata',
    'extra-file',
    'output',
    'documentation',
    'mode',
    'directory-inode',
    'file-inode',
  ] as const)
    effectIt.effect(`refuses passive project ${mutation} drift`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const prepared = yield* makeJavaPreparedProject(f.materializerOptions);
        const file = f.path.join(prepared.project, '.classpath');
        if (mutation === 'metadata') yield* f.fs.writeFileString(file, '<changed/>');
        else if (mutation === 'extra-file')
          yield* f.fs.writeFileString(f.path.join(prepared.project, 'extra'), 'extra', {mode: 0o600});
        else if (mutation === 'output')
          yield* f.fs.writeFileString(f.path.join(prepared.project, 'output-0/Main.class'), 'unexpected', {
            mode: 0o600,
          });
        else if (mutation === 'documentation')
          yield* f.fs.writeFileString(f.path.join(prepared.directory, 'documentation/index.html'), 'unexpected', {
            mode: 0o600,
          });
        else if (mutation === 'mode') yield* f.fs.chmod(file, 0o644);
        else if (mutation === 'directory-inode') {
          const directory = f.path.join(prepared.directory, 'documentation');
          yield* f.fs.rename(directory, f.path.join(prepared.directory, 'held-documentation'));
          yield* f.fs.makeDirectory(directory, {mode: 0o700});
        } else {
          const content = yield* f.fs.readFileString(file);
          yield* f.fs.rename(file, f.path.join(prepared.directory, 'held-classpath'));
          yield* f.fs.writeFileString(file, content, {mode: 0o600});
        }
        expect(Exit.isFailure(yield* Effect.exit(prepared.verify))).toBe(true);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );
  for (const replaced of ['project', '.settings'])
    effectIt.effect(`refuses ${replaced} substitution before writing outside the private project`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const sdkDigest = yield* semanticSdkDigest(f.javaHome);
        let substituted = false;
        const fs = FileSystem.makeNoop({
          ...f.fs,
          makeDirectory: (directory, options) =>
            f.fs.makeDirectory(directory, options).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if (f.path.basename(directory) !== replaced || substituted) return;
                  substituted = true;
                  yield* f.fs.rename(directory, directory + '-held');
                  yield* f.fs.symlink(f.javaHome, directory);
                }),
              ),
            ),
        });
        const result = yield* Effect.exit(
          makeJavaPreparedProject(f.materializerOptions).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
        );
        expect(substituted).toBe(true);
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* semanticSdkDigest(f.javaHome)).toBe(sdkDigest);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );
  effectIt.effect.prop(
    'isolates independent passive copies while conserving the prepared input',
    {
      payload: Arbitrary.map(
        Arbitrary.array(Arbitrary.schema(Schema.Literals(['a', '0', '&', '~', 'é', '𐐀'])), {
          minLength: 1,
          maxLength: 24,
        }),
        parts => EffectArray.join(parts, ''),
      ),
    },
    ({payload}) =>
      Effect.gen(function* () {
        const f = yield* fixture(false, payload, true);
        const original = yield* f.fs.readFileString(f.sealed.metadataFile);
        const first = yield* makeJavaPreparedProject(f.materializerOptions);
        const second = yield* makeJavaPreparedProject(f.materializerOptions);
        expect(first.directory).not.toBe(second.directory);
        expect(first.documentationUri).not.toBe(second.documentationUri);
        expect(first.model).toEqual(second.model);
        yield* f.fs.writeFileString(f.path.join(first.directory, 'documentation/index.html'), payload, {mode: 0o600});
        expect(Exit.isFailure(yield* Effect.exit(first.verify))).toBe(true);
        yield* second.verify;
        expect(yield* f.fs.readDirectory(f.path.join(second.directory, 'documentation'))).toEqual([]);
        expect(yield* f.fs.readFileString(f.sealed.metadataFile)).toBe(original);
        expect(yield* f.fs.readFileString(f.sealed.model.libraries[0].file)).toBe(payload);
        expect(yield* semanticTreeDigest(f.project)).toBe(f.sealed.model.sourceDigest);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    {arbitrary: {runs: 8}},
  );
  effectIt.effect('refuses overlapping private roots before constructing a project', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const privateDirectory of [f.project, f.javaHome, f.sealed.directory, f.path.dirname(f.project)])
        expect(
          Exit.isFailure(yield* Effect.exit(makeJavaPreparedProject({...f.materializerOptions, privateDirectory}))),
        ).toBe(true);
      expect(yield* f.fs.readDirectory(f.materializerOptions.privateDirectory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
});

describe('Java prepared model sealing', () => {
  effectIt.effect(
    'loads persisted facts after setup removal and protects the captured model from caller mutation',
    () =>
      Effect.gen(function* () {
        const f = yield* modelFixture();
        const sealed = yield* sealJavaPreparedModel(f.observation, f.options);
        const content = yield* f.fs.readFileString(sealed.metadataFile);
        const methods = [...f.methods];
        yield* f.fs.remove(f.copiedProject, {recursive: true});
        yield* f.fs.remove(f.runtimeDirectory, {recursive: true});
        const loaded = yield* loadJavaPreparedModel({
          metadataFile: sealed.metadataFile,
          metadataDigest: sealed.metadataDigest,
          project: f.project,
          worktree: f.project,
          javaHome: f.javaHome,
        });
        expect(javaPreparedModelJson(loaded.model)).toBe(content);
        expect(loaded.sourceRoots).toEqual([f.path.join(f.project, 'src/main/java')]);
        expect(loaded.absentSourceRoots).toEqual([f.path.join(f.project, 'src/test/java')]);
        expect(Reflect.set(loaded.model, 'project', '/different')).toBe(false);
        expect(Reflect.set(loaded.model.rawClasspath[0], 'path', 'different')).toBe(false);
        expect(Reflect.set(loaded.model.rawClasspath[0].attributes[0], 'value', 'false')).toBe(false);
        expect(Reflect.set(loaded.model.compilerOptions, 'org.eclipse.jdt.core.compiler.source', '17')).toBe(false);
        expect(Reflect.set(loaded.model.libraries[0], 'digest', EffectString.repeat(64)('0'))).toBe(false);
        expect(Reflect.set(loaded.sourceRoots, '0', '/different')).toBe(false);
        yield* loaded.verify;
        expect(javaPreparedModelJson(loaded.model)).toBe(content);
        expect(f.methods).toEqual(methods);
        expect(yield* f.fs.readFileString(sealed.metadataFile)).toBe(content);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  for (const mutation of [
    'metadata',
    'library',
    'extra-file',
    'mode',
    'source',
    'SDK',
    'library-inode',
    'source-root-inode',
  ] as const)
    effectIt.effect(`invalidates persisted verification after ${mutation} drift`, () =>
      Effect.gen(function* () {
        const f = yield* modelFixture();
        const sealed = yield* sealJavaPreparedModel(f.observation, f.options);
        const loaded = yield* loadJavaPreparedModel({
          metadataFile: sealed.metadataFile,
          metadataDigest: sealed.metadataDigest,
          project: f.project,
          worktree: f.project,
          javaHome: f.javaHome,
        });
        const library = sealed.model.libraries[0];
        if (mutation === 'metadata')
          yield* f.fs.writeFileString(sealed.metadataFile, javaPreparedModelJson(sealed.model) + '\n');
        else if (mutation === 'library')
          yield* f.fs.writeFileString(library.file, EffectString.repeat(library.bytes)('X'));
        else if (mutation === 'extra-file')
          yield* f.fs.writeFileString(f.path.join(sealed.directory, 'extra'), 'extra', {mode: 0o600});
        else if (mutation === 'mode') yield* f.fs.chmod(sealed.metadataFile, 0o644);
        else if (mutation === 'source')
          yield* f.fs.writeFileString(f.path.join(f.project, 'src/main/java/Main.java'), 'class Changed {}\n');
        else if (mutation === 'SDK')
          yield* f.fs.writeFileString(f.path.join(f.javaHome, 'lib/jrt-fs.jar'), 'changed SDK artifact');
        else if (mutation === 'library-inode') {
          yield* f.fs.rename(library.file, f.path.join(f.artifactDirectory, 'held-library.jar'));
          yield* f.fs.writeFileString(library.file, f.jarText, {mode: 0o600});
        } else {
          const root = loaded.sourceRoots[0];
          yield* f.fs.rename(root, f.path.join(f.artifactDirectory, 'held-source'));
          yield* f.fs.makeDirectory(root);
          yield* f.fs.writeFileString(f.path.join(root, 'Main.java'), 'class Main {}\n');
        }
        expect((yield* Effect.exit(loaded.verify))._tag).toBe('Failure');
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );
  effectIt.effect('refuses forged optional absence even with a matching current worktree digest', () =>
    Effect.gen(function* () {
      for (const kind of ['File', 'Directory'] as const) {
        const f = yield* modelFixture();
        const sealed = yield* sealJavaPreparedModel(f.observation, f.options);
        const optional = f.path.join(f.project, 'src/test/java');
        yield* f.fs.makeDirectory(f.path.dirname(optional), {recursive: true});
        if (kind === 'File') yield* f.fs.writeFileString(optional, 'not a source folder');
        else yield* f.fs.makeDirectory(optional);
        const forged = {...sealed.model, sourceDigest: yield* semanticTreeDigest(f.project)};
        const content = javaPreparedModelJson(forged);
        yield* f.fs.writeFileString(sealed.metadataFile, content);
        expect(
          (yield* Effect.exit(
            loadJavaPreparedModel({
              metadataFile: sealed.metadataFile,
              metadataDigest: sha256HexSync(content),
              project: f.project,
              worktree: f.project,
              javaHome: f.javaHome,
            }),
          ))._tag,
        ).toBe('Failure');
      }
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  for (const changed of ['config', 'SDK', 'artifact-inventory'] as const)
    effectIt.effect(`refuses late ${changed} drift during persisted verification`, () =>
      Effect.gen(function* () {
        const f = yield* modelFixture();
        const sealed = yield* sealJavaPreparedModel(f.observation, f.options);
        const loaded = yield* loadJavaPreparedModel({
          metadataFile: sealed.metadataFile,
          metadataDigest: sealed.metadataDigest,
          project: f.project,
          worktree: f.project,
          javaHome: f.javaHome,
        });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const originalRead = fingerprints.readBounded;
        const originalDigest = fingerprints.boundedFileDigest;
        const main = f.path.join(f.project, 'src/main/java/Main.java');
        let libraryReads = 0;
        const hold = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
        const spy =
          changed === 'artifact-inventory'
            ? vi
                .spyOn(fingerprints, 'boundedFileDigest')
                .mockImplementation((file, maximum) =>
                  file === sealed.model.libraries[0].file && ++libraryReads === 2
                    ? hold.pipe(Effect.andThen(originalDigest(file, maximum)))
                    : originalDigest(file, maximum),
                )
            : vi
                .spyOn(fingerprints, 'readBounded')
                .mockImplementation((file, maximum) =>
                  file === main && maximum === 4 * 1024 * 1024
                    ? hold.pipe(Effect.andThen(originalRead(file, maximum)))
                    : originalRead(file, maximum),
                );
        yield* Effect.gen(function* () {
          const verifying = yield* Effect.forkChild(loaded.verify);
          yield* Deferred.await(entered);
          if (changed === 'artifact-inventory')
            yield* f.fs.writeFileString(f.path.join(sealed.directory, 'extra'), 'late extra artifact', {mode: 0o600});
          else
            yield* f.fs.writeFileString(
              changed === 'config' ? f.path.join(f.project, 'pom.xml') : f.path.join(f.javaHome, 'lib/jrt-fs.jar'),
              'late changed bytes',
            );
          yield* Deferred.succeed(release, undefined);
          expect((yield* Effect.exit(Fiber.join(verifying)))._tag).toBe('Failure');
        }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );
  effectIt.effect('refuses noncanonical JSON and metadata symlinks before using persisted facts', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture();
      const sealed = yield* sealJavaPreparedModel(f.observation, f.options);
      const original = yield* f.fs.readFileString(sealed.metadataFile);
      const whitespace = original + ' ';
      yield* f.fs.writeFileString(sealed.metadataFile, whitespace);
      const options = {
        metadataFile: sealed.metadataFile,
        metadataDigest: sha256HexSync(whitespace),
        project: f.project,
        worktree: f.project,
        javaHome: f.javaHome,
      };
      expect((yield* Effect.exit(loadJavaPreparedModel(options)))._tag).toBe('Failure');
      const target = f.path.join(f.artifactDirectory, 'held-model.json');
      yield* f.fs.rename(sealed.metadataFile, target);
      yield* f.fs.writeFileString(target, original);
      yield* f.fs.symlink(target, sealed.metadataFile);
      expect(
        (yield* Effect.exit(loadJavaPreparedModel({...options, metadataDigest: sealed.metadataDigest})))._tag,
      ).toBe('Failure');
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect.prop(
    'round trips sealed artifact payloads without changing their pinned bytes or model',
    {
      payload: Arbitrary.map(
        Arbitrary.array(Arbitrary.schema(Schema.Literals(['a', 'b', '0', ' ', '%', '~', '[', ']', 'é', '𐐀'])), {
          minLength: 1,
          maxLength: 32,
        }),
        parts => EffectArray.join(parts, ''),
      ),
    },
    ({payload}) =>
      Effect.gen(function* () {
        const f = yield* modelFixture({jarText: payload, minimalBuildInputs: true});
        const sealed = yield* sealJavaPreparedModel(f.observation, f.options);
        const loaded = yield* loadJavaPreparedModel({
          metadataFile: sealed.metadataFile,
          metadataDigest: sealed.metadataDigest,
          project: f.project,
          worktree: f.project,
          javaHome: f.javaHome,
        });
        expect(loaded.model.libraries).toEqual([
          {
            file: sealed.model.libraries[0].file,
            digest: sha256HexSync(payload),
            bytes: new TextEncoder().encode(payload).length,
          },
        ]);
        expect(yield* f.fs.readFileString(loaded.model.libraries[0].file)).toBe(payload);
        yield* loaded.verify;
        expect(javaPreparedModelJson(loaded.model)).toBe(javaPreparedModelJson(sealed.model));
        expect(yield* f.fs.readFileString(sealed.metadataFile)).toBe(javaPreparedModelJson(sealed.model));
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    {arbitrary: {runs: 16}},
  );
  it('keeps canonical model bytes stable under compiler key reordering and JSON round trips', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/u), fc.constantFrom('error', 'warning', 'ignore', 'é𐐀'), {
          minKeys: 1,
          maxKeys: 8,
        }),
        options => {
          const compiler = EffectRecord.fromEntries(
            EffectArray.map(
              EffectRecord.toEntries(options),
              ([key, value]) => ['org.eclipse.jdt.core.compiler.problem.' + key, value] as const,
            ),
          );
          const model: JavaPreparedModel = {
            format: 'threadnote-prepared-java-project-v2',
            provider: 'jdtls-1.63.0-202610191322',
            build: 'maven',
            project: '/project',
            worktree: '/project',
            javaHome: '/sdk',
            sourceDigest: sha256HexSync('source'),
            javaSdkDigest: sha256HexSync('SDK'),
            projectCharset: 'UTF-8',
            sourceInputEncoding: 'utf8-original-inputs-v1',
            sourceEncoding: {policy: 'utf8-no-bom-v1', sourceCount: 0, sourceDigest: sha256HexSync('encoding')},
            compilerOptions: compiler,
            resourceFilters: [],
            output: 'target/classes',
            rawClasspath: [],
            resolvedClasspath: [],
            libraries: [],
          };
          const original = JSON.stringify(model);
          const encoded = javaPreparedModelJson(model);
          expect(JSON.parse(encoded)).toEqual(model);
          expect(javaPreparedModelJson(Schema.decodeSync(JavaPreparedModel)(JSON.parse(encoded)))).toBe(encoded);
          expect(
            javaPreparedModelJson({
              ...model,
              compilerOptions: EffectRecord.fromEntries(EffectRecord.toEntries(compiler).reverse()),
            }),
          ).toBe(encoded);
          expect(JSON.stringify(model)).toBe(original);
        },
      ),
      {numRuns: 32},
    );
  });
  effectIt.effect('rejects transient UTF8 reads that do not match the admitted source bytes', () =>
    Effect.gen(function* () {
      const baseline = new Uint8Array([0x2f, 0x2a, 0xe9, 0x2a, 0x2f]);
      const f = yield* modelFixture({sourceBytes: baseline});
      const original = f.path.join(f.project, 'src/main/java/Main.java');
      const copied = f.path.join(f.copiedProject, 'src/main/java/Main.java');
      const read = fingerprints.readBounded;
      let encodingReads = 0;
      const spy = vi.spyOn(fingerprints, 'readBounded').mockImplementation((file, maximum) => {
        if (maximum !== 4 * 1024 * 1024 || (file !== original && file !== copied)) return read(file, maximum);
        return Effect.gen(function* () {
          encodingReads++;
          yield* f.fs.writeFileString(file, 'class Main {}\n').pipe(Effect.orDie);
          return yield* read(file, maximum).pipe(Effect.ensuring(f.fs.writeFile(file, baseline).pipe(Effect.orDie)));
        });
      });
      const result = yield* sealJavaPreparedModel(f.observation, f.options).pipe(
        Effect.flip,
        Effect.ensuring(Effect.sync(() => spy.mockRestore())),
      );
      expect(encodingReads).toBeGreaterThan(0);
      expect(result).toMatchObject({_tag: 'LspFault', code: 'prerequisite'});
      expect(yield* semanticTreeDigest(f.project)).toBe(f.options.inputs.sourceDigest);
      expect(sha256HexSync(yield* f.fs.readFile(original))).toBe(sha256HexSync(baseline));
      expect(sha256HexSync(yield* f.fs.readFile(copied))).toBe(sha256HexSync(baseline));
      expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('binds observed preference absence to the original captured input inventory', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture({resourcePreferences: 'encoding/src/main/java/Main.java=ISO-8859-1\n'});
      const original = f.path.join(f.project, '.settings/org.eclipse.core.resources.prefs');
      const copied = f.path.join(f.copiedProject, '.settings/org.eclipse.core.resources.prefs');
      let observations = 0;
      const result = yield* sealJavaPreparedModel(f.observation, f.options).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          exists: file => {
            if (file !== original && file !== copied) return f.fs.exists(file);
            const backup = f.path.join(
              f.runtimeDirectory,
              file === original ? 'original-prefs-held' : 'copied-prefs-held',
            );
            return Effect.gen(function* () {
              observations++;
              yield* f.fs.rename(file, backup);
              return yield* f.fs.exists(file).pipe(Effect.ensuring(f.fs.rename(backup, file).pipe(Effect.orDie)));
            });
          },
        }),
        Effect.flip,
      );
      expect(observations).toBeGreaterThan(0);
      expect(result).toMatchObject({_tag: 'LspFault', code: 'prerequisite'});
      expect(yield* f.fs.exists(original)).toBe(true);
      expect(yield* f.fs.exists(copied)).toBe(true);
      expect(yield* semanticTreeDigest(f.project)).toBe(f.options.inputs.sourceDigest);
      expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('refuses non-UTF8 sources and resource encoding overrides despite a UTF8 project default', () =>
    Effect.gen(function* () {
      for (const control of [
        {sourceBytes: new Uint8Array([0xff, 0xfe, 0x63, 0, 0x6c, 0])},
        {sourceBytes: new Uint8Array([0x2f, 0x2a, 0xe9, 0x2a, 0x2f])},
        {sourceBytes: new TextEncoder().encode('\uFEFFclass Main {}\n')},
        {
          resourcePreferences:
            'eclipse.preferences.version=1\nencoding/<project>=UTF-8\nencoding/src/main/java/Main.java=ISO-8859-1\n',
        },
        {resourcePreferences: 'eclipse.preferences.version=1\nencoding/src/main/java/Main.java=\\u0055TF-8\n'},
        {resourcePreferences: 'encoding/src/main/java/Main.java=UTF-8 \n'},
        {resourcePreferences: 'encoding/src/main/java/Main.java ISO-8859-1=UTF-8\n'},
        {resourcePreferences: '\uFEFFencoding/src/main/java/Main.java=UTF-8\n'},
      ]) {
        const f = yield* modelFixture(control);
        expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
        expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
      }
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('records validated original UTF8 bytes and preference inputs without retaining setup paths', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture({
        resourcePreferences:
          '# controlled preferences\n\teclipse.preferences.version=1\n encoding/<project>=UTF-8\n\fencoding/src/main/java=UTF-8\nencoding/src/main/java/Main.java=UTF-8\n',
      });
      const sealed = yield* sealJavaPreparedModel(f.observation, f.options);
      expect(sealed.model.sourceInputEncoding).toBe('utf8-original-inputs-v1');
      expect(sealed.model.projectCharset).toBe('UTF-8');
      expect(sealed.model.sourceEncoding).toEqual(f.observation.model.sourceEncoding);
      expect(yield* f.fs.readFileString(sealed.metadataFile)).not.toContain(f.runtimeDirectory);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('refuses a native charset witness for a different source set or source bytes', () =>
    Effect.gen(function* () {
      for (const control of [{encodingCount: 0}, {encodingDigest: sha256HexSync('different source image')}]) {
        const f = yield* modelFixture(control);
        expect(yield* sealJavaPreparedModel(f.observation, f.options).pipe(Effect.flip)).toMatchObject({
          code: 'prerequisite',
        });
        expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
      }
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect.prop(
    'source charset images ignore enumeration order, preserve inputs and detect renamed or changed sources',
    [Schema.Array(Schema.Literals(['é', '𐐀', 'Ｚ', '😀', 'a'])).check(Schema.isBetweenLength(1, 8))],
    ([names]) =>
      Effect.sync(() => {
        const sources = Object.freeze(
          EffectArray.map(names, (name, index) =>
            Object.freeze({
              name: 'src/' + index + '-' + name + '.java',
              digest: sha256HexSync('source ' + name + index),
            }),
          ),
        );
        const before = JSON.stringify(sources);
        const image = javaSourceEncodingImage(sources);
        expect(image).toEqual(javaSourceEncodingImage(EffectArray.reverse(sources)));
        expect(image.sourceCount).toBe(sources.length);
        expect(
          javaSourceEncodingImage([{...sources[0], name: sources[0].name + 'x'}, ...EffectArray.drop(sources, 1)]),
        ).not.toEqual(image);
        expect(
          javaSourceEncodingImage([
            {...sources[0], digest: sha256HexSync('changed ' + sources[0].digest)},
            ...EffectArray.drop(sources, 1),
          ]),
        ).not.toEqual(image);
        expect(JSON.stringify(sources)).toBe(before);
      }),
    {arbitrary: {runs: 32}},
  );
  effectIt.effect.prop(
    'validates UTF8 sources once across overlapping roots without changing bytes',
    [Schema.Array(Schema.Literals(['a', 'é', '😀', '\r', '\n', '\uFEFF'])).check(Schema.isMaxLength(64))],
    ([characters]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const project = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-utf8-'}));
        const root = path.join(project, 'src');
        yield* fs.makeDirectory(root);
        const file = path.join(root, 'Main.java');
        const bytes = new TextEncoder().encode('class Main { /*' + EffectArray.join(characters, '') + '*/ }\n');
        yield* fs.writeFile(file, bytes);
        const nested = path.join(root, 'nested');
        yield* fs.makeDirectory(nested);
        yield* fs.writeFileString(path.join(nested, '𐐀.java'), 'class 𐐀 {}\n');
        const first = yield* verifyJavaSourceEncoding(project, [root, nested, root]);
        const second = yield* verifyJavaSourceEncoding(project, [nested, root]);
        const image = (sources: typeof first.sources) =>
          javaSourceEncodingImage(
            EffectArray.map(sources, source => ({
              name: path.relative(project, source.file),
              digest: source.digest,
            })),
          );
        expect(first.sources.length).toBe(2);
        expect(image(first.sources)).toEqual(image(second.sources));
        expect(sha256HexSync(yield* fs.readFile(file))).toBe(sha256HexSync(bytes));
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    {arbitrary: {runs: 16}},
  );
  effectIt.effect('refuses SDK drift during the final native observation before issuing a witness', () =>
    Effect.gen(function* () {
      let sdkIntact = true;
      const f = yield* modelFixture({
        deferImport: true,
        hostVerify: Effect.suspend(() => (sdkIntact ? Effect.void : LspFault.make({code: 'prerequisite'}))),
        afterSecondModel: Effect.sync(() => {
          sdkIntact = false;
        }),
      });
      expect((yield* Effect.exit(f.observe))._tag).toBe('Failure');
      expect(EffectArray.filter(f.methods, method => method === 'workspace/executeCommand')).toHaveLength(2);
      expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
      expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('authenticates the copy receipt and cleanup owner before preparation admission', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture({deferImport: true});
      const expected = {
        workspace: f.workspace,
        build: 'maven' as const,
        project: f.copiedProject,
        worktree: f.project,
      };
      yield* verifyJavaPreparationInputs(f.options.inputs, expected);
      for (const [inputs, binding] of [
        [{...f.options.inputs, verify: Effect.void}, expected],
        [f.options.inputs, {...expected, workspace: {...f.workspace}}],
        [f.options.inputs, {...expected, build: 'gradle' as const}],
        [f.options.inputs, {...expected, worktree: f.copiedProject}],
      ] as const)
        expect(yield* Effect.flip(verifyJavaPreparationInputs(inputs, binding))).toMatchObject({
          _tag: 'LspFault',
          code: 'prerequisite',
        });
      expect(yield* Effect.flip(consumeJavaPreparationConnection(f.runtime, {}))).toMatchObject({
        _tag: 'LspFault',
        code: 'prerequisite',
      });
      expect(f.methods).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('refuses a model paired with copied metadata changed during its observation', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const f = yield* modelFixture({deferImport: true, observerGate: {entered, release}});
      const observing = yield* Effect.forkChild(Effect.exit(f.observe));
      yield* Deferred.await(entered);
      yield* f.fs.writeFileString(
        f.path.join(f.copiedProject, '.classpath'),
        '<classpath>different generation</classpath>',
      );
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(observing))._tag).toBe('Failure');
      expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
      expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('refuses a changed cached model even when copied output bytes stay unchanged', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture({deferImport: true, changeSecondModel: true});
      expect((yield* Effect.exit(f.observe))._tag).toBe('Failure');
      expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
      expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('retains an Error received after ServiceReady during the native observation', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture({deferImport: true, failure: 'late-status'});
      expect((yield* Effect.exit(f.observe))._tag).toBe('Failure');
      expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
      expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('retires a completed observation when a later setup Error arrives before sealing', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture();
      yield* f.emitError;
      expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
      expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('keeps a missing readiness signal bounded and prevents a raw report from completing setup', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture({deferImport: true, failure: 'missing-ready'});
      const initialized = yield* Deferred.make<void>();
      // The fixed transport writes this notification before waiting for the readiness signal.
      const writing = f.wire.send;
      const spy = vi
        .spyOn(f.wire, 'send')
        .mockImplementation(message =>
          writing(message).pipe(
            Effect.andThen(message.method === 'initialized' ? Deferred.succeed(initialized, undefined) : Effect.void),
          ),
        );
      yield* Effect.gen(function* () {
        const observing = yield* Effect.forkChild(f.observe);
        yield* Deferred.await(initialized);
        yield* TestClock.adjust(45001);
        expect(yield* Effect.flip(Fiber.join(observing))).toMatchObject({_tag: 'LspFault', code: 'timeout'});
      }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
      expect(EffectArray.contains(f.methods, 'workspace/executeCommand')).toBe(false);
      expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('does not mix completed reports from two independent input proofs', () =>
    Effect.gen(function* () {
      const first = yield* modelFixture();
      const second = yield* modelFixture();
      expect((yield* Effect.exit(sealJavaPreparedModel(first.observation, second.options)))._tag).toBe('Failure');
      expect((yield* Effect.exit(sealJavaPreparedModel(second.observation, first.options)))._tag).toBe('Failure');
      expect(yield* first.fs.readDirectory(first.artifactDirectory)).toEqual([]);
      expect(yield* second.fs.readDirectory(second.artifactDirectory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('requires a genuine setup runtime and preserves a completed observation after rejected reuse', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture({deferImport: true});
      expect((yield* Effect.exit(observeJavaPreparedImport({runtime: {...f.runtime}})))._tag).toBe('Failure');
      expect(f.methods).toEqual([]);
      expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
      const observed = yield* f.observe;
      expect(f.methods).toEqual([
        'initialize',
        'initialized',
        'workspace/didChangeConfiguration',
        'workspace/executeCommand',
        'workspace/executeCommand',
      ]);
      expect(yield* Effect.flip(f.observe)).toMatchObject({_tag: 'LspFault', code: 'prerequisite'});
      const sealed = yield* sealJavaPreparedModel(observed, {...f.options, requestToken: observed.requestToken});
      expect(sealed.model.sourceDigest).toBe(f.options.inputs.sourceDigest);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('does not initialize or issue a model witness after a pre-import metadata insertion', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture({deferImport: true});
      yield* f.fs.writeFileString(
        f.path.join(f.copiedProject, '.classpath'),
        '<classpath>inserted before import</classpath>',
      );
      expect((yield* Effect.exit(f.observe))._tag).toBe('Failure');
      expect(f.methods).toEqual([]);
      expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
      expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('never upgrades initialization, readiness or observation-token failures into sealable outputs', () =>
    Effect.gen(function* () {
      for (const failure of ['initialize', 'status', 'token'] as const) {
        const f = yield* modelFixture({deferImport: true, failure});
        expect((yield* Effect.exit(f.observe))._tag).toBe('Failure');
        expect(yield* Effect.flip(f.observe)).toMatchObject({_tag: 'LspFault', code: 'prerequisite'});
        expect(EffectArray.filter(f.methods, method => method === 'initialize')).toHaveLength(1);
        expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
        expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
      }
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('cancels a pending native observation without issuing a completed setup witness', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const f = yield* modelFixture({deferImport: true, observerGate: {entered, release}});
      const observing = yield* Effect.forkChild(f.observe);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(observing).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      expect(yield* Effect.flip(f.observe)).toMatchObject({_tag: 'LspFault', code: 'prerequisite'});
      expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
      expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('rejects a copied-only Gradle script before import even when it is inside the project cache', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture();
      const script = "if (file('.gradle/extra.gradle').exists()) { apply from: '.gradle/extra.gradle' }\n";
      yield* f.fs.writeFileString(f.path.join(f.project, 'build.gradle'), script);
      const workspace = yield* makeJavaWorkspace(f.path.dirname(f.project));
      const inputs = yield* copyJavaPreparationInputs({
        project: f.project,
        worktree: f.project,
        workspace,
        build: 'gradle',
      });
      yield* f.fs.makeDirectory(f.path.join(inputs.copiedProject, '.gradle'));
      yield* f.fs.writeFileString(
        f.path.join(inputs.copiedProject, '.gradle/extra.gradle'),
        'ext.changedModel = true\n',
      );
      expect((yield* Effect.exit(inputs.verify))._tag).toBe('Failure');
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('refuses named metadata inserted during copying before issuing the initial proof', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture();
      const workspace = yield* makeJavaWorkspace(f.path.dirname(f.project));
      const copied = f.path.join(workspace.directory, 'source');
      const result = yield* copyJavaPreparationInputs({
        project: f.project,
        worktree: f.project,
        workspace,
        build: 'maven',
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          writeFile: (file, bytes, options) =>
            f.fs
              .writeFile(file, bytes, options)
              .pipe(
                Effect.andThen(
                  f.fs.writeFileString(f.path.join(copied, '.classpath'), '<classpath>unadmitted input</classpath>'),
                ),
              ),
        }),
        Effect.exit,
      );
      expect(result._tag).toBe('Failure');
      expect(yield* f.fs.readFileString(f.path.join(f.project, 'pom.xml'))).toBe(
        '<project>captured build configuration</project>',
      );
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('rejects newly added copied build configuration outside the closed importer-output policy', () =>
    Effect.gen(function* () {
      for (const relative of [
        'settings.gradle.kts',
        '.mvn/extensions.xml',
        '.mvn/jvm.config',
        'new-module/build.gradle',
      ]) {
        const f = yield* modelFixture();
        const file = f.path.join(f.copiedProject, relative);
        yield* f.fs.makeDirectory(f.path.dirname(file), {recursive: true});
        yield* f.fs.writeFileString(file, 'new unadmitted build input');
        expect((yield* Effect.exit(f.options.inputs.verify))._tag).toBe('Failure');
        expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
        expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
      }
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('uses only proof-owned source identities when a host options object retains extra fields', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture();
      let hostGuards = 0;
      const retainedOptions = {
        ...f.options,
        project: '/wrong-project',
        worktree: '/wrong-worktree',
        copiedProject: '/wrong-copy',
        copiedWorktree: '/wrong-copy',
        sourceDigest: sha256HexSync('wrong'),
        verify: Effect.sync(() => {
          hostGuards++;
        }),
      };
      const sealed = yield* sealJavaPreparedModel(f.observation, retainedOptions);
      expect(sealed.model.project).toBe(f.project);
      expect(sealed.model.sourceDigest).toBe(f.options.inputs.sourceDigest);
      expect(hostGuards).toBeGreaterThanOrEqual(3);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('bounds ownership acquisition and cleanup even inside masked resource lifecycle steps', () =>
    Effect.gen(function* () {
      for (const phase of ['acquire', 'release'] as const) {
        const f = yield* modelFixture();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        let cleanup = false;
        let calls = 0;
        const verify = Effect.suspend(() => {
          if (phase === 'release' && ++calls === 2) {
            cleanup = true;
            return LspFault.make({code: 'rejected'});
          }
          return Effect.void;
        });
        const sealing = yield* Effect.forkChild(
          sealJavaPreparedModel(f.observation, {...f.options, verify}).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...f.fs,
              realPath: file =>
                EffectString.startsWith(f.artifactDirectory + f.path.sep + 'prepared-java-')(file) &&
                (phase === 'acquire' || cleanup)
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(f.fs.realPath(file)),
                    )
                  : f.fs.realPath(file),
            }),
            Effect.onExit(() => Deferred.succeed(completed, undefined)),
          ),
        );
        yield* Effect.gen(function* () {
          yield* Deferred.await(entered);
          yield* TestClock.adjust(phase === 'acquire' ? 45001 : 30001);
          yield* Effect.yieldNow;
          expect(Option.isSome(yield* Deferred.poll(completed))).toBe(true);
        }).pipe(
          Effect.ensuring(Deferred.succeed(release, undefined)),
          Effect.ensuring(Fiber.await(sealing).pipe(Effect.asVoid)),
        );
        expect((yield* Fiber.await(sealing))._tag).toBe('Failure');
        expect((yield* f.fs.readDirectory(f.artifactDirectory)).length).toBe(1);
      }
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('bounds copied-input acquisition when canonical filesystem inspection stalls', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture();
      const workspace = yield* makeJavaWorkspace(f.path.dirname(f.project));
      const entered = yield* Deferred.make<void>();
      const copy = yield* Effect.forkChild(
        copyJavaPreparationInputs({project: f.project, worktree: f.project, workspace, build: 'maven'}).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            realPath: file =>
              file === f.project
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                : f.fs.realPath(file),
          }),
        ),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(45001);
      expect(yield* Effect.flip(Fiber.join(copy))).toMatchObject({_tag: 'LspFault', code: 'timeout'});
      expect(yield* f.fs.readDirectory(workspace.directory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect.prop(
    'binds every copied original build input, including metadata and nested configuration',
    [
      Schema.Literals([
        'pom.xml',
        'settings.gradle',
        'build.gradle',
        'gradle.properties',
        '.mvn/maven.config',
        '.project',
      ]),
    ],
    ([relative]) =>
      Effect.gen(function* () {
        const f = yield* modelFixture();
        yield* f.fs.writeFileString(f.path.join(f.copiedProject, relative), 'different imported build input');
        expect((yield* Effect.exit(f.options.inputs.verify))._tag).toBe('Failure');
        expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
        expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
        expect(yield* semanticTreeDigest(f.project)).toBe(f.options.inputs.sourceDigest);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    {arbitrary: {runs: 16}},
  );
  effectIt.effect('rejects forged proofs and keeps generated metadata outside the strict input image', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture();
      const forged = {...f.options.inputs, verify: Effect.void};
      expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, {...f.options, inputs: forged})))._tag).toBe(
        'Failure',
      );
      yield* f.fs.writeFileString(f.path.join(f.copiedProject, '.classpath'), '<classpath/>');
      expect((yield* Effect.exit(f.options.inputs.verify))._tag).toBe('Failure');
      expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('retains replaced artifact parents and children instead of deleting another directory', () =>
    Effect.gen(function* () {
      for (const [replaceParent, injectFailure] of [
        [false, false],
        [false, true],
        [true, false],
        [true, true],
      ] as const) {
        const f = yield* modelFixture();
        let calls = 0;
        let replaced = '';
        let retained = '';
        const result = yield* sealJavaPreparedModel(f.observation, {
          ...f.options,
          verify: Effect.suspend(() => {
            if (++calls !== 2) return Effect.void;
            return Effect.gen(function* () {
              replaced = replaceParent
                ? f.artifactDirectory
                : f.path.join(f.artifactDirectory, (yield* f.fs.readDirectory(f.artifactDirectory))[0]);
              retained = replaced + '-retained';
              yield* f.fs.rename(replaced, retained);
              yield* f.fs.makeDirectory(replaced, {mode: 0o700});
              yield* f.fs.writeFileString(f.path.join(replaced, 'unowned-sentinel'), 'preserve replacement');
              if (injectFailure) return yield* LspFault.make({code: 'rejected'});
            });
          }),
        }).pipe(Effect.exit);
        expect(result._tag).toBe('Failure');
        expect(yield* f.fs.readFileString(f.path.join(replaced, 'unowned-sentinel'))).toBe('preserve replacement');
        expect(yield* f.fs.exists(retained)).toBe(true);
      }
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('rejects sealed JAR or metadata mutations during the last publication awaits', () =>
    Effect.gen(function* () {
      for (const target of ['jar', 'metadata'] as const) {
        const f = yield* modelFixture();
        let calls = 0;
        const result = yield* sealJavaPreparedModel(f.observation, {
          ...f.options,
          verify: Effect.suspend(() => {
            if (++calls !== 3) return Effect.void;
            return Effect.gen(function* () {
              const root = f.path.join(f.artifactDirectory, (yield* f.fs.readDirectory(f.artifactDirectory))[0]);
              const name =
                target === 'metadata'
                  ? 'model.json'
                  : EffectArray.filter(yield* f.fs.readDirectory(root), name => EffectString.endsWith('.jar')(name))[0];
              yield* f.fs.writeFileString(f.path.join(root, name), 'changed after earlier digest');
            });
          }),
        }).pipe(Effect.exit);
        expect(result._tag).toBe('Failure');
        expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
      }
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('refuses an aliased cache ancestor before calling the bounded content reader', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture();
      const outside = f.path.join(f.path.dirname(f.project), 'outside-cache');
      const cache = f.path.join(f.runtimeDirectory, 'm2');
      yield* f.fs.rename(cache, outside);
      yield* f.fs.symlink(outside, cache);
      const actualRead = fingerprints.readBounded;
      let aliasReads = 0;
      const spy = vi.spyOn(fingerprints, 'readBounded').mockImplementation((file, maximum) => {
        if (file === f.jar) aliasReads++;
        return actualRead(file, maximum);
      });
      const result = yield* sealJavaPreparedModel(f.observation, f.options).pipe(
        Effect.exit,
        Effect.ensuring(Effect.sync(() => spy.mockRestore())),
      );
      expect(result._tag).toBe('Failure');
      expect(aliasReads).toBe(0);
      expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
      expect(yield* f.fs.readFileString(f.path.join(outside, 'library.jar'))).toBe(f.jarText);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('preserves compiler and ordered classpath facts after the setup workspace is removed', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture();
      const before = structuredClone(f.observation);
      const sealed = yield* sealJavaPreparedModel(f.observation, f.options);
      expect(f.observation).toEqual(before);
      expect(sealed.model.compilerOptions).toEqual(f.observation.model.compilerOptions);
      expect(sealed.model.resourceFilters).toEqual(f.observation.model.resourceFilters);
      expect(EffectArray.map(sealed.model.rawClasspath, entry => entry.kind)).toEqual([3, 5, 5, 3]);
      expect(EffectArray.map(sealed.model.resolvedClasspath, entry => entry.kind)).toEqual([3, 1, 1, 3]);
      expect(sealed.model.resolvedClasspath[0]).toMatchObject({
        path: 'src/main/java',
        output: 'target/classes',
        inclusions: ['**/*.java'],
        exclusions: ['**/Excluded.java'],
        attributes: [{name: 'optional', value: 'true'}],
      });
      expect(sealed.model.resolvedClasspath[3]).toMatchObject({
        path: 'src/test/java',
        exists: false,
        output: 'target/test-classes',
        attributes: [
          {name: 'optional', value: 'true'},
          {name: 'test', value: 'true'},
        ],
      });
      yield* f.fs.remove(f.copiedProject, {recursive: true});
      yield* f.fs.remove(f.runtimeDirectory, {recursive: true});
      const stored = yield* f.fs.readFileString(sealed.metadataFile);
      expect(sha256HexSync(stored)).toBe(sealed.metadataDigest);
      expect(yield* Schema.decodeUnknownEffect(JavaPreparedModel)(JSON.parse(stored))).toEqual(sealed.model);
      expect(EffectString.includes(f.copiedProject)(stored)).toBe(false);
      expect(EffectString.includes(f.runtimeDirectory)(stored)).toBe(false);
      expect(yield* f.fs.readFileString(sealed.model.libraries[0].file)).toBe(f.jarText);
      expect(yield* semanticTreeDigest(f.project)).toBe(f.options.inputs.sourceDigest);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('refuses unknown wire fields, authority selectors, conflicting roots and changed dependencies', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture();
      const invalid = [
        {...f.observation, command: 'arbitrary'},
        {...f.observation, requestToken: 'other'},
        {...f.observation, model: {...f.observation.model, build: 'gradle'}},
        {...f.observation, model: {...f.observation.model, projectUri: 'file:///outside'}},
        {
          ...f.observation,
          model: {
            ...f.observation.model,
            compilerOptions: {
              ...f.observation.model.compilerOptions,
              'org.eclipse.jdt.core.compiler.release': 'disabled',
            },
          },
        },
        {
          ...f.observation,
          model: {
            ...f.observation.model,
            resolvedClasspath: EffectArray.map(f.observation.model.resolvedClasspath, (entry, i) =>
              i === 0 ? {...entry, path: '/different/src/main/java/extra'} : entry,
            ),
          },
        },
        {
          ...f.observation,
          model: {
            ...f.observation.model,
            resourceFilters: [{...f.observation.model.resourceFilters[0], arguments: '.*'}],
          },
        },
        {...f.observation, libraries: [{...f.observation.libraries[0], sha256: sha256HexSync('changed')}]},
      ];
      for (const value of invalid) {
        expect((yield* Effect.exit(sealJavaPreparedModel(value, f.options)))._tag).toBe('Failure');
        expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
      }
      yield* f.fs.writeFileString(f.jar, 'changed dependency');
      expect((yield* Effect.exit(sealJavaPreparedModel(f.observation, f.options)))._tag).toBe('Failure');
      expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('captures the observation before an asynchronous host guard and removes canceled output', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const input = structuredClone(f.observation);
      const options = {
        ...f.options,
        verify: Effect.suspend(() =>
          ++calls === 1
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
      };
      const fiber = yield* Effect.forkChild(sealJavaPreparedModel(input, options));
      yield* Deferred.await(entered);
      // The caller still owns this object; modifying it cannot replace the captured compiler settings.
      const changed = {...input.model.compilerOptions, 'org.eclipse.jdt.core.compiler.problem.unusedImport': 'ignore'};
      Object.assign(input.model, {compilerOptions: changed});
      yield* Deferred.succeed(release, undefined);
      const sealed = yield* Fiber.join(fiber);
      expect(sealed.model.compilerOptions['org.eclipse.jdt.core.compiler.problem.unusedImport']).toBe('error');
      yield* f.fs.remove(sealed.directory, {recursive: true});
      const writing = yield* Deferred.make<void>();
      const canceled = yield* Effect.forkChild(
        sealJavaPreparedModel(f.observation, f.options).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            writeFileString: (file, content, writeOptions) =>
              f.fs
                .writeFileString(file, content, writeOptions)
                .pipe(Effect.andThen(Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never)))),
          }),
        ),
      );
      yield* Deferred.await(writing);
      yield* Fiber.interrupt(canceled);
      expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('removes sealed output when a copied source changes during metadata publication', () =>
    Effect.gen(function* () {
      const f = yield* modelFixture();
      const copiedSource = f.path.join(f.copiedProject, 'src/main/java/Main.java');
      const result = yield* sealJavaPreparedModel(f.observation, f.options).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...f.fs,
          writeFileString: (file, content, options) =>
            f.fs
              .writeFileString(file, content, options)
              .pipe(Effect.andThen(f.fs.writeFileString(copiedSource, 'class ChangedDuringSeal {}\n'))),
        }),
        Effect.exit,
      );
      expect(result._tag).toBe('Failure');
      expect(yield* f.fs.readDirectory(f.artifactDirectory)).toEqual([]);
      expect(yield* semanticTreeDigest(f.project)).toBe(f.options.inputs.sourceDigest);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect.prop(
    'canonical metadata round trips without losing classpath order or depending on object-key order',
    [
      Schema.Array(
        Schema.Array(Schema.Literals(['é', '😀', '\\', ':', '=', '"', '<', 'A'])).check(Schema.isMaxLength(24)),
      ).check(Schema.isMaxLength(12)),
    ],
    ([values]) =>
      Effect.gen(function* () {
        const f = yield* modelFixture();
        const sealed = yield* sealJavaPreparedModel(f.observation, f.options);
        const compiler = EffectRecord.fromEntries(
          EffectArray.map(
            values,
            (value, i) => ['org.eclipse.jdt.core.compiler.fixture' + i, EffectArray.join(value, '')] as const,
          ),
        );
        const model = {...sealed.model, compilerOptions: {...sealed.model.compilerOptions, ...compiler}};
        const reversedKeys = {
          ...model,
          compilerOptions: EffectRecord.fromEntries(EffectRecord.toEntries(model.compilerOptions).reverse()),
        };
        const encoded = javaPreparedModelJson(model);
        expect(javaPreparedModelJson(reversedKeys)).toBe(encoded);
        expect(javaPreparedModelJson(yield* Schema.decodeUnknownEffect(JavaPreparedModel)(JSON.parse(encoded)))).toBe(
          encoded,
        );
        expect(JSON.parse(encoded).resolvedClasspath).toEqual(model.resolvedClasspath);
        expect(model.compilerOptions).toEqual({...sealed.model.compilerOptions, ...compiler});
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    {arbitrary: {runs: 16}},
  );
});

describe('Java pinned runtime and preparation boundary', () => {
  effectIt.effect('closes process admission before awaiting workspace cleanup verification', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-close-claim-'}));
      const ownerScope = yield* Scope.make();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gate = {directory: '', armed: false};
      const workspace = yield* makeJavaWorkspace(parent).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          realPath: file =>
            fs.realPath(file).pipe(
              Effect.tap(() => {
                if (file !== gate.directory || !gate.armed) return Effect.void;
                gate.armed = false;
                return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
              }),
            ),
        }),
        Effect.provideService(Scope.Scope, ownerScope),
      );
      gate.directory = workspace.directory;
      gate.armed = true;
      const closing = yield* Effect.forkChild(Scope.close(ownerScope, Exit.void));
      yield* Deferred.await(entered);
      const claim = yield* Effect.exit(workspace.hold);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      expect(claim._tag).toBe('Failure');
      expect(yield* fs.exists(workspace.directory)).toBe(false);
      expect((yield* Effect.exit(workspace.confirmDrained({drained: true, stdioClosed: true})))._tag).toBe('Failure');
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect(
    'rejects an unqualified captured configuration image before any private write or downstream launch',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const writes: string[] = [];
        let launched = false;
        const captured = new TextEncoder().encode('osgi.bundles=unqualified-transient-image');
        const before = Array.from(captured);
        const result = yield* materializeJavaRuntimeConfiguration(captured, '/private/configuration').pipe(
          Effect.andThen(
            Effect.sync(() => {
              launched = true;
            }),
          ),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFile: file =>
              Effect.sync(() => {
                writes.push(file);
              }),
          }),
          Effect.exit,
        );
        expect(result._tag).toBe('Failure');
        expect(writes).toEqual([]);
        expect(launched).toBe(false);
        expect(Array.from(captured)).toEqual(before);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect.prop(
    'retains the entire workspace through finalizer failure until a complete drain receipt exists',
    [Schema.Array(Schema.Struct({drained: Schema.Boolean, stdioClosed: Schema.Boolean})).check(Schema.isMaxLength(8))],
    ([receipts]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-owner-'}));
        const ownerScope = yield* Scope.make();
        const workspace = yield* makeJavaWorkspace(parent).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const marker = path.join(workspace.directory, 'project-and-runtime-evidence');
        yield* fs.writeFileString(marker, 'synthetic retained diagnostics');
        yield* workspace.hold;
        for (const receipt of receipts) yield* Effect.exit(workspace.confirmDrained(receipt));
        yield* Effect.addFinalizer(() => Effect.die('Synthetic later finalizer failure')).pipe(
          Effect.provideService(Scope.Scope, ownerScope),
        );
        expect((yield* Effect.exit(Scope.close(ownerScope, Exit.void)))._tag).toBe('Failure');
        expect(yield* fs.exists(marker)).toBe(
          !EffectArray.some(receipts, receipt => receipt.drained && receipt.stdioClosed),
        );
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    {arbitrary: {runs: 32}},
  );
  effectIt.effect('cleans an unused workspace and refuses a second provider claim', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-owner-'}));
      const unusedScope = yield* Scope.make();
      const unused = yield* makeJavaWorkspace(parent).pipe(Effect.provideService(Scope.Scope, unusedScope));
      yield* Scope.close(unusedScope, Exit.void);
      expect(yield* fs.exists(unused.directory)).toBe(false);
      const usedScope = yield* Scope.make();
      const used = yield* makeJavaWorkspace(parent).pipe(Effect.provideService(Scope.Scope, usedScope));
      yield* used.hold;
      expect((yield* Effect.exit(used.hold))._tag).toBe('Failure');
      yield* used.confirmDrained({drained: true, stdioClosed: true});
      yield* Scope.close(usedScope, Exit.void);
      expect(yield* fs.exists(used.directory)).toBe(false);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect.prop(
    'requires independent positive provider and build drains before deleting a preparation workspace',
    [
      Schema.Struct({
        provider: Schema.Literals(['receipt', 'failure', 'defect']),
        build: Schema.Literals(['receipt', 'failure', 'defect']),
        providerDrained: Schema.Boolean,
        stdioClosed: Schema.Boolean,
        buildDrained: Schema.Boolean,
      }),
    ],
    ([input]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-dual-drain-'}));
        const owner = yield* Scope.make();
        const workspace = yield* makeJavaWorkspace(parent).pipe(Effect.provideService(Scope.Scope, owner));
        yield* workspace.hold;
        const attempts: string[] = [];
        const provider = Effect.suspend(() => {
          attempts.push('provider');
          if (input.provider === 'failure') return LspFault.make({code: 'exit'});
          if (input.provider === 'defect') return Effect.die('Synthetic provider drain defect');
          return Effect.succeed({
            code: 0,
            forced: false,
            drained: input.providerDrained,
            stdioClosed: input.stdioClosed,
            fault: undefined,
          });
        });
        const build = Effect.suspend(() => {
          attempts.push('build');
          if (input.build === 'failure') return LspFault.make({code: 'exit'});
          if (input.build === 'defect') return Effect.die('Synthetic build drain defect');
          return Effect.succeed({drained: input.buildDrained});
        });
        yield* Effect.addFinalizer(() => finishJavaPreparation(workspace, provider, build).pipe(Effect.orDie)).pipe(
          Effect.provideService(Scope.Scope, owner),
        );
        const closed = yield* Effect.exit(Scope.close(owner, Exit.void));
        const complete =
          input.provider === 'receipt' &&
          input.providerDrained &&
          input.stdioClosed &&
          input.build === 'receipt' &&
          input.buildDrained;
        expect(attempts).toEqual(['provider', 'build']);
        expect(Exit.isSuccess(closed)).toBe(complete);
        expect(yield* fs.exists(workspace.directory)).toBe(!complete);
        if (input.provider === 'defect' && input.build === 'defect' && Exit.isFailure(closed)) {
          expect(Cause.pretty(closed.cause)).toContain('Synthetic provider drain defect');
          expect(Cause.pretty(closed.cause)).toContain('Synthetic build drain defect');
        }
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    {arbitrary: {runs: 64}},
  );
  effectIt.effect(
    'interrupts a stalled build drain during uninterruptible scope finalization and retains evidence',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-drain-timeout-'}));
        const owner = yield* Scope.make();
        const workspace = yield* makeJavaWorkspace(parent).pipe(Effect.provideService(Scope.Scope, owner));
        yield* workspace.hold;
        const entered = yield* Deferred.make<void>();
        let interrupted = false;
        const build = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        );
        yield* Effect.addFinalizer(() =>
          finishJavaPreparation(
            workspace,
            Effect.succeed({code: 0, forced: false, drained: true, stdioClosed: true, fault: undefined}),
            build,
          ).pipe(Effect.orDie),
        ).pipe(Effect.provideService(Scope.Scope, owner));
        const closing = yield* Effect.forkChild(Effect.exit(Scope.close(owner, Exit.void)));
        yield* Deferred.await(entered);
        yield* TestClock.adjust(30001);
        expect((yield* Fiber.join(closing))._tag).toBe('Failure');
        expect(interrupted).toBe(true);
        expect(yield* fs.exists(workspace.directory)).toBe(true);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect.prop(
    'attempts detached build cleanup when the preparation program was already interrupted',
    [Schema.Boolean],
    ([buildDrained]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-canceled-drain-'}));
        const ready = yield* Deferred.make<void>();
        const attempts: string[] = [];
        let directory = '';
        const program = Effect.scoped(
          Effect.gen(function* () {
            const workspace = yield* makeJavaWorkspace(parent);
            directory = workspace.directory;
            yield* workspace.hold;
            yield* Effect.addFinalizer(() =>
              finishJavaPreparation(
                workspace,
                Effect.sync(() => {
                  attempts.push('provider');
                  return {code: 0, forced: false, drained: true, stdioClosed: true, fault: undefined};
                }),
                Effect.sync(() => {
                  attempts.push('build');
                  return {drained: buildDrained};
                }),
              ).pipe(Effect.orDie),
            );
            yield* Deferred.succeed(ready, undefined);
            return yield* Effect.never;
          }),
        );
        const preparation = yield* Effect.forkChild(program);
        yield* Deferred.await(ready);
        yield* Fiber.interrupt(preparation);
        expect(attempts).toEqual(['provider', 'build']);
        expect(yield* fs.exists(directory)).toBe(!buildDrained);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    {arbitrary: {runs: 16}},
  );
  effectIt.effect('reports missing host setup with exact server and separate project/runtime prerequisites', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(makeJavaRuntime(undefined));
      expect(error).toMatchObject({
        _tag: 'SemanticSetupFault',
        providerId: 'jdtls',
        component: 'provider',
        reason: 'missing',
        requiredVersion: '1.63.0-202610191322',
        requiredSdkVersion: '25.0.5+8',
      });
      expect(error).toHaveProperty('nextAction', expect.stringContaining('21.0.13+9'));
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );

  effectIt.effect('rejects caller-selected JVM arguments before touching any host SDK', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const reads: string[] = [];
      const malicious = {...candidate(), jvmArguments: ['-Dthreadnote.java.preparation=true']};
      const before = JSON.stringify(malicious);
      const error = yield* makeJavaRuntime(malicious).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: file =>
            Effect.sync(() => {
              reads.push(file);
              return false;
            }),
        }),
        Effect.flip,
      );
      expect(error).toMatchObject({_tag: 'SemanticSetupFault', reason: 'incompatible'});
      expect(reads).toEqual([]);
      expect(JSON.stringify(malicious)).toBe(before);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );

  effectIt.effect.prop(
    'rejects every unqualified SDK digest before SDK access without mutating host configuration',
    [
      Schema.Literals(['serverTreeDigest', 'runtimeSdkDigest', 'projectSdkDigest']),
      Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 63})),
      Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 15})),
    ],
    ([key, position, increment]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const selected = candidate();
        const digest = selected[key];
        const replacement = ((Number.parseInt(digest[position], 16) + increment) % 16).toString(16);
        const changed = {
          ...selected,
          [key]: EffectString.slice(0, position)(digest) + replacement + EffectString.slice(position + 1)(digest),
        };
        const before = JSON.stringify(changed);
        const reads: string[] = [];
        const error = yield* makeJavaRuntime(changed).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: file =>
              Effect.sync(() => {
                reads.push(file);
                return false;
              }),
          }),
          Effect.flip,
        );
        expect(error).toMatchObject({_tag: 'SemanticSetupFault', reason: 'incompatible'});
        expect(reads).toEqual([]);
        expect(JSON.stringify(changed)).toBe(before);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    {arbitrary: {runs: 32}},
  );

  macEffect('rejects a relative SDK path before filesystem access', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const reads: string[] = [];
      const error = yield* makeJavaRuntime({...candidate(), runtimeJavaHome: '../jdk25'}).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: file =>
            Effect.sync(() => {
              reads.push(file);
              return false;
            }),
        }),
        Effect.flip,
      );
      expect(error).toMatchObject({_tag: 'SemanticSetupFault', component: 'sdk', reason: 'incompatible'});
      expect(reads).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );

  macEffect('refuses an aliased SDK root and changed SDK contents', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-runtime-'}));
      const sdk = path.join(root, 'sdk');
      const alias = path.join(root, 'alias');
      yield* fs.makeDirectory(sdk);
      yield* fs.writeFileString(path.join(sdk, 'server.jar'), 'unqualified replacement');
      yield* fs.symlink(sdk, alias);
      for (const serverDirectory of [alias, sdk]) {
        const error = yield* Effect.flip(makeJavaRuntime({...candidate(), serverDirectory}));
        expect(error).toMatchObject({
          _tag: 'SemanticSetupFault',
          providerId: 'jdtls',
          reason: 'incompatible',
          component: 'provider',
        });
      }
      expect(yield* fs.readFileString(path.join(sdk, 'server.jar'))).toBe('unqualified replacement');
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );

  macEffect('bounds the entire SDK preflight even when host filesystem access stalls', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const entered = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        makeJavaRuntime(candidate()).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        ),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(45001);
      expect(yield* Effect.flip(Fiber.join(fiber))).toMatchObject({_tag: 'LspFault', code: 'timeout'});
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
});

it('refuses metadata-only Java platform rows without borrowing another platform image', () => {
  const selected = vi.spyOn(nativePlatform, 'runtimeNativePlatformTarget');
  try {
    for (const target of [
      'darwin-x64',
      'linux-arm64',
      'linux-arm64-musl',
      'linux-x64-baseline',
      'linux-x64-baseline-musl',
      'windows-arm64',
      'windows-x64-baseline',
      undefined,
    ]) {
      selected.mockReturnValue(target);
      expect(javaRuntime.javaRuntimePinsForHost()).toBeUndefined();
    }
  } finally {
    selected.mockRestore();
  }
});

it('selects complete source-pin fixtures and fences them in the canonical native target namespace', () => {
  const selected = vi.spyOn(nativePlatform, 'runtimeNativePlatformTarget');
  const digest = EffectString.repeat(64)('a');
  try {
    for (const [target, configurationDirectory] of [
      ['darwin-arm64', 'config_mac_arm'],
      ['darwin-x64', 'config_mac'],
      ['linux-arm64', 'config_linux_arm'],
      ['linux-arm64-musl', 'config_linux_arm'],
      ['linux-x64-baseline', 'config_linux'],
      ['linux-x64-baseline-musl', 'config_linux'],
      ['windows-arm64', 'config_win'],
      ['windows-x64-baseline', 'config_win'],
    ]) {
      const row = {
        status: 'candidate-artifacts-verified',
        productionQualified: false,
        artifacts: EffectArray.map(
          [
            {role: 'provider', version: javaRuntimeQualification.serverVersion},
            {role: 'runtime-sdk', version: '25.0.5.0.2'},
            {role: 'project-sdk', version: '21.0.13.0.2'},
          ],
          artifact => ({
            ...artifact,
            url: 'https://example.invalid/pinned-archive',
            archiveSha256: digest,
            licenseEvidence: [{url: 'https://example.invalid/pinned-notice', sha256: digest}],
          }),
        ),
        runtimePins: {...javaRuntimeQualification, configurationDirectory},
      };
      const pins = javaRuntime.selectJavaRuntimePlatformPins(target, row);
      expect(pins?.platform).toBe(target);
      selected.mockReturnValue(target);
      expect(javaRuntime.isCurrentJavaRuntimePlatform(pins!.platform)).toBe(true);
      selected.mockReturnValue(target === 'windows-arm64' ? 'windows-x64-baseline' : 'windows-arm64');
      expect(javaRuntime.isCurrentJavaRuntimePlatform(pins!.platform)).toBe(false);
      selected.mockReturnValue(undefined);
      expect(javaRuntime.isCurrentJavaRuntimePlatform(pins!.platform)).toBe(false);
      expect(
        javaRuntime.selectJavaRuntimePlatformPins(target, {...row, status: 'metadata-only', runtimePins: null}),
      ).toBeUndefined();
      expect(
        javaRuntime.selectJavaRuntimePlatformPins(target, {
          ...row,
          artifacts: EffectArray.map(row.artifacts, artifact => ({...artifact, licenseEvidence: []})),
        }),
      ).toBeUndefined();
      expect(javaRuntime.selectJavaRuntimePlatformPins('win32-arm64', row)).toBeUndefined();
    }
  } finally {
    selected.mockRestore();
  }
});
