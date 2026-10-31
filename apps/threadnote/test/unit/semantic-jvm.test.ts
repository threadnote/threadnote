/* oxlint-disable effecttsgo/strict-effect-provide -- Filesystem model tests provide only the Bun OS services. */
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as EffectArray from 'effect/Array';
import * as EffectString from 'effect/String';
import {Crypto, Deferred, Effect, Exit, Fiber, FileSystem, Path, Schema, Scope} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {semanticSdkDigest, semanticTreeDigest} from '../../src/semantic/fingerprint.js';
import {Position, type Observation} from '@threadnote/semantic/contracts';
import {LspFault, type LspClient} from '../../src/semantic/lsp_transport.js';
import {makeSemanticNotifications} from '../../src/semantic/provider.js';
import {
  makeJavaSession,
  makeJavaSourceUri,
  mapJavaSourceResponse,
  type JavaSessionOptions,
} from '../../src/semantic/providers/java.js';
import {
  materializeJavaDiagnosticBundle,
  makeJavaDiagnosticModel,
} from '../../src/semantic/providers/java_diagnostics.js';
import {javaDiagnosticBundle} from '../../src/semantic/providers/java_diagnostics_bundle.js';
import {javaTypeDefinitionCommand} from '../../src/semantic/providers/java_snapshot.js';
import {
  makeJavaProject,
  javaProjectMetadata,
  type JavaProjectModel,
} from '../../src/semantic/providers/java_project.js';

const fixture = (libraryName = 'dependency') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-project-'}));
    const project = path.join(root, 'source');
    const source = path.join(project, 'src/main/java');
    const javaHome = path.join(root, 'jdk');
    for (const directory of [source, javaHome, path.join(project, '.git'), path.join(project, '.settings')])
      yield* fs.makeDirectory(directory, {recursive: true});
    yield* fs.writeFileString(path.join(source, 'Main.java'), 'class Main {}\n');
    yield* fs.writeFileString(path.join(project, 'pom.xml'), '<project/>');
    yield* fs.writeFileString(path.join(project, 'build.gradle'), "plugins { id 'java' }\n");
    yield* fs.writeFileString(path.join(project, '.git/HEAD'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
    yield* fs.writeFileString(path.join(project, '.project'), '<untrusted-builder>execute-me</untrusted-builder>');
    yield* fs.writeFileString(path.join(project, '.classpath'), '<untrusted-classpath/>');
    yield* fs.writeFileString(path.join(project, '.settings/org.eclipse.jdt.core.prefs'), 'untrusted=true\n');
    yield* fs.writeFileString(path.join(javaHome, 'release'), 'JAVA_VERSION="21.0.13"\n');
    const rawLibrary = path.join(root, libraryName + '.jar');
    yield* fs.writeFileString(rawLibrary, 'pinned dependency bytes');
    const library = yield* fs.realPath(rawLibrary);
    const model: JavaProjectModel = {
      format: 'threadnote-prepared-java-project-v1',
      build: 'maven',
      importer: 'org.eclipse.m2e.core.maven2Nature',
      provider: 'jdtls-1.63.0-202610191322',
      worktree: project,
      project,
      sourceDigest: yield* semanticTreeDigest(project),
      javaHome,
      javaSdkDigest: yield* semanticSdkDigest(javaHome),
      release: 21,
      sourceRoots: [{directory: source, required: true}],
      libraries: [{file: library, digest: sha256HexSync('pinned dependency bytes')}],
    };
    const metadataFile = path.join(root, 'prepared-model.json');
    const writeModel = (value: JavaProjectModel) =>
      Effect.gen(function* () {
        const text = JSON.stringify(value);
        yield* fs.writeFileString(metadataFile, text);
        return {id: 'java-main', metadataFile, metadataDigest: sha256HexSync(text)};
      });
    const environment = yield* writeModel(model);
    const options = {project, worktree: project, javaHome, privateDirectory: path.join(root, 'analysis'), environment};
    return {fs, path, root, project, source, javaHome, library, model, options, writeModel};
  });

describe('Java prepared project boundary', () => {
  effectIt.effect(
    'retains the whole prepared project and runtime when a scope closes without confirmed process drain',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const inner = yield* Scope.make();
        const project = yield* makeJavaProject(f.options).pipe(Effect.provideService(Scope.Scope, inner));
        const runtimeEvidence = f.path.join(project.directory, 'runtime-evidence');
        yield* f.fs.writeFileString(runtimeEvidence, 'synthetic undrained provider evidence');
        yield* project.workspace.hold;
        yield* Effect.addFinalizer(() => Effect.die('Synthetic undrained launch')).pipe(
          Effect.provideService(Scope.Scope, inner),
        );
        expect((yield* Effect.exit(Scope.close(inner, Exit.void)))._tag).toBe('Failure');
        expect(yield* f.fs.exists(f.path.join(project.project, '.project'))).toBe(true);
        expect(yield* f.fs.readFileString(runtimeEvidence)).toBe('synthetic undrained provider evidence');
      }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('uses host-pinned build metadata and preserves every original source and Eclipse file', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = yield* semanticTreeDigest(f.project);
      const project = yield* makeJavaProject(f.options);
      const description = yield* f.fs.readFileString(f.path.join(project.project, '.project'));
      expect(description).toContain('<buildSpec/>');
      expect(description).toContain('<nature>org.eclipse.jdt.core.javanature</nature>');
      expect(description).not.toContain('execute-me');
      expect(yield* f.fs.readFileString(f.path.join(project.project, '.classpath'))).not.toContain('untrusted');
      expect(project.settings.java.import.maven.enabled).toBe(false);
      expect(project.settings.java.import.gradle.enabled).toBe(false);
      expect(project.settings.java.configuration.updateBuildConfiguration).toBe('disabled');
      expect(project.profile.repositoryExecution).toBe(false);
      expect(project.profile.dependencyAcquisition).toBe(false);
      expect(yield* semanticTreeDigest(f.project)).toBe(before);
      yield* project.verify;
    }).pipe(Effect.provide(BunServices.layer)),
  );

  effectIt.effect('retains absent optional model roots and invalidates when one appears', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const generated = f.path.join(f.project, 'target/generated-sources/annotations');
      const environment = yield* f.writeModel({
        ...f.model,
        sourceRoots: [...f.model.sourceRoots, {directory: generated, required: false}],
      });
      const project = yield* makeJavaProject({...f.options, environment});
      expect(project.profile.absentOptionalRoots).toEqual([generated]);
      expect(project.sourceRoots).toEqual([f.source]);
      yield* f.fs.makeDirectory(generated, {recursive: true});
      expect((yield* Effect.exit(project.verify))._tag).toBe('Failure');
    }).pipe(Effect.provide(BunServices.layer)),
  );

  for (const change of ['source', 'configuration', 'head', 'sdk', 'library', 'metadata', 'projection'] as const)
    effectIt.effect(`invalidates changed ${change} bytes without altering source`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const project = yield* makeJavaProject(f.options);
        const file = {
          source: f.path.join(f.source, 'Main.java'),
          configuration: f.path.join(f.project, 'pom.xml'),
          head: f.path.join(f.project, '.git/HEAD'),
          sdk: f.path.join(f.javaHome, 'release'),
          library: f.library,
          metadata: f.options.environment.metadataFile,
          projection: f.path.join(project.project, '.classpath'),
        }[change];
        yield* f.fs.writeFileString(file, 'changed');
        const before = yield* semanticTreeDigest(f.project);
        expect((yield* Effect.exit(project.verify))._tag).toBe('Failure');
        expect(yield* semanticTreeDigest(f.project)).toBe(before);
      }).pipe(Effect.provide(BunServices.layer)),
    );

  effectIt.effect('refuses repository-supplied models before making a private projection', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const metadataFile = f.path.join(f.project, 'model.json');
      const text = JSON.stringify(f.model);
      yield* f.fs.writeFileString(metadataFile, text);
      const result = yield* Effect.exit(
        makeJavaProject({
          ...f.options,
          environment: {id: 'java-main', metadataFile, metadataDigest: sha256HexSync(text)},
        }),
      );
      expect(result._tag).toBe('Failure');
      expect(yield* f.fs.exists(f.options.privateDirectory)).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  effectIt.effect('refuses duplicate, overlapping, escaping or missing required source roots', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const sourceRoots of [
        [...f.model.sourceRoots, ...f.model.sourceRoots],
        [...f.model.sourceRoots, {directory: f.path.dirname(f.source), required: true}],
        [{directory: f.root, required: true}],
        [{directory: f.path.join(f.project, 'missing'), required: true}],
      ]) {
        const environment = yield* f.writeModel({...f.model, sourceRoots});
        expect((yield* Effect.exit(makeJavaProject({...f.options, environment})))._tag).toBe('Failure');
        expect(yield* f.fs.exists(f.options.privateDirectory)).toBe(false);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );

  effectIt.effect('refuses mismatched importer provenance before making a private projection', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const environment = yield* f.writeModel({...f.model, build: 'gradle'});
      expect((yield* Effect.exit(makeJavaProject({...f.options, environment})))._tag).toBe('Failure');
      expect(yield* f.fs.exists(f.options.privateDirectory)).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  effectIt.effect('decodes only the pinned byte image during a deterministic metadata swap and restoration', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const crypto = yield* Crypto.Crypto;
      const pinned = yield* f.fs.readFileString(f.options.environment.metadataFile);
      const otherLibrary = f.path.join(f.root, 'unapproved.jar');
      yield* f.fs.writeFileString(otherLibrary, 'unapproved bytes');
      const other = JSON.stringify({
        ...f.model,
        libraries: [{file: otherLibrary, digest: sha256HexSync('unapproved bytes')}],
      });
      let swapped = false;
      const swapping: typeof crypto = {
        ...crypto,
        digest: (algorithm, bytes) =>
          crypto.digest(algorithm, bytes).pipe(
            Effect.tap(() =>
              swapped
                ? Effect.void
                : Effect.gen(function* () {
                    swapped = true;
                    yield* f.fs.writeFileString(f.options.environment.metadataFile, other);
                  }),
            ),
          ),
      };
      const restoring: typeof f.fs = {
        ...f.fs,
        realPath: file =>
          f.fs
            .realPath(file)
            .pipe(
              Effect.tap(() =>
                file === f.options.environment.metadataFile && swapped
                  ? f.fs.writeFileString(file, pinned)
                  : Effect.void,
              ),
            ),
      };
      const project = yield* makeJavaProject(f.options).pipe(
        Effect.provideService(Crypto.Crypto, swapping),
        Effect.provideService(FileSystem.FileSystem, restoring),
      );
      expect(swapped).toBe(true);
      expect(yield* f.fs.readFileString(f.options.environment.metadataFile)).toBe(pinned);
      const classpath = yield* f.fs.readFileString(f.path.join(project.project, '.classpath'));
      expect(classpath).toContain(f.library);
      expect(classpath).not.toContain(otherLibrary);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  effectIt.effect('refuses a private directory under a symlink ancestor before writing source', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const alias = f.path.join(f.root, 'alias');
      yield* f.fs.symlink(f.project, alias);
      const before = yield* semanticTreeDigest(f.project);
      expect(
        (yield* Effect.exit(makeJavaProject({...f.options, privateDirectory: f.path.join(alias, 'new/deep')})))._tag,
      ).toBe('Failure');
      expect(yield* semanticTreeDigest(f.project)).toBe(before);
      expect(yield* f.fs.exists(f.path.join(f.project, 'new'))).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  effectIt.effect('refuses SDK-contained private storage before changing SDK bytes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = yield* semanticSdkDigest(f.javaHome);
      expect(
        (yield* Effect.exit(makeJavaProject({...f.options, privateDirectory: f.path.join(f.javaHome, 'analysis')})))
          ._tag,
      ).toBe('Failure');
      expect(yield* semanticSdkDigest(f.javaHome)).toBe(before);
      expect(yield* f.fs.exists(f.path.join(f.javaHome, 'analysis'))).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  for (const extra of ['.factorypath', '.settings/org.eclipse.jdt.apt.core.prefs'])
    effectIt.effect(`invalidates an added unapproved private metadata file ${extra}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const project = yield* makeJavaProject(f.options);
        yield* f.fs.writeFileString(f.path.join(project.project, extra), 'unapproved');
        expect((yield* Effect.exit(project.verify))._tag).toBe('Failure');
      }).pipe(Effect.provide(BunServices.layer)),
    );

  it('round trips reserved XML and Unicode paths with stable order and no input mutation', () => {
    const name = fc
      .array(fc.constantFrom('a', '&', '<', '>', '"', "'", 'é', '😀', '$'), {minLength: 1, maxLength: 12})
      .map(parts => EffectArray.join(parts, ''));
    fc.assert(
      fc.property(fc.array(name, {minLength: 1, maxLength: 8}), names => {
        const sources = EffectArray.map(names, value => 'file:///sources/' + encodeURIComponent(value));
        const libraries = EffectArray.map(names, value => '/dependencies/' + value + '.jar');
        const before = JSON.stringify([sources, libraries]);
        const files = javaProjectMetadata(sources, libraries);
        const entities: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
        const decode = (text: string) =>
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Each XML entity needs a distinct callback replacement; Effect String.replace accepts a fixed string.
          text.replace(/&(amp|lt|gt|quot|apos);/gu, (_, entity: string) => entities[entity]);
        const paths = Array.from(
          EffectString.matchAll(/<classpathentry kind="lib" path="([^"]*)"\/>/gu)(files['.classpath']),
          match => decode(match[1]),
        );
        const links = Array.from(
          EffectString.matchAll(/<locationURI>([^<]*)<\/locationURI>/gu)(files['.project']),
          match => decode(match[1]),
        );
        expect(paths).toEqual(libraries);
        expect(links).toEqual(sources);
        expect(javaProjectMetadata(sources, libraries)).toEqual(files);
        expect(JSON.stringify([sources, libraries])).toBe(before);
      }),
      {numRuns: 32},
    );
  });
});

const sessionFixture = Effect.gen(function* () {
  const f = yield* fixture();
  const prepared = yield* makeJavaProject(f.options);
  const bundle = yield* materializeJavaDiagnosticBundle(prepared.directory);
  const diagnosticModel = yield* makeJavaDiagnosticModel({
    project: prepared.project,
    javaHome: f.javaHome,
    sourceRoots: prepared.sourceRoots,
    libraries: [f.library],
  });
  const uri = (yield* f.path.toFileUrl(f.path.join(f.source, 'Main.java'))).href;
  const text = 'class Main {}\n';
  const basis: Observation = {
    version: 1,
    repository: 'java-test',
    worktree: (yield* f.path.toFileUrl(f.project)).href,
    project: (yield* f.path.toFileUrl(f.project)).href,
    configuration: EffectString.repeat(64)('a'),
    toolchain: EffectString.repeat(64)('b'),
    provider: {id: 'jdtls', version: '1.63.0', generation: 0},
    view: {kind: 'overlay', id: 'java-view', owner: 'test', epoch: 0},
    uri,
    content: sha256HexSync(text),
    documentVersion: 1,
    projectEpoch: 0,
  };
  const create = (
    response: Schema.Json,
    serverVersion = '1.63.0-SNAPSHOT',
    timing?: {
      initialized: Deferred.Deferred<void>;
      release: Deferred.Deferred<void>;
      returned: Deferred.Deferred<void>;
      calls: {method: string; params: Schema.Json | undefined}[];
    },
    runtime: JavaSessionOptions['runtime'] = {projectJavaHome: f.javaHome, verify: Effect.void},
  ) =>
    Effect.gen(function* () {
      const notifications = makeSemanticNotifications();
      const calls: {method: string; params: Schema.Json | undefined}[] = timing?.calls ?? [];
      const client: LspClient = {
        pid: 1,
        request: (method, params) =>
          Effect.gen(function* (): Effect.fn.Return<Schema.Json, LspFault> {
            calls.push({method, params});
            if (method === 'initialize') {
              if (!timing) notifications.receive('language/status', {type: 'ServiceReady'});
              return {
                serverInfo: {name: 'JDT Language Server (Standard)', version: serverVersion},
                capabilities: {
                  definitionProvider: true,
                  typeDefinitionProvider: true,
                  documentSymbolProvider: true,
                  renameProvider: true,
                  codeActionProvider: true,
                  executeCommandProvider: {commands: [javaDiagnosticBundle.command, javaTypeDefinitionCommand]},
                },
              };
            }
            if (method === 'workspace/executeCommand') {
              const call = yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                  command: Schema.Literal(javaTypeDefinitionCommand),
                  arguments: Schema.Array(Schema.Struct({requestToken: Schema.String, position: Position})),
                }),
              )(params).pipe(Effect.mapError(() => LspFault.make({code: 'protocol'})));
              expect(call.arguments).toHaveLength(1);
              return {
                protocolVersion: 1,
                requestToken: call.arguments[0].requestToken,
                uri,
                contentSha256: sha256HexSync(text),
                utf16Length: text.length,
                inputs: [{uri, contentSha256: sha256HexSync(text), utf16Length: text.length}],
                model: {
                  ...diagnosticModel,
                  compilerOptions: {
                    'org.eclipse.jdt.core.compiler.compliance': '21',
                    'org.eclipse.jdt.core.compiler.source': '21',
                    'org.eclipse.jdt.core.compiler.codegen.targetPlatform': '21',
                    'org.eclipse.jdt.core.compiler.release': 'enabled',
                  },
                  annotationProcessing: 'disabled-for-snapshot',
                },
                position: call.arguments[0].position,
                typeDefinition: Schema.is(Schema.Struct({typeDefinition: Schema.Json}))(response)
                  ? response.typeDefinition
                  : {status: 'unsupported', reason: 'binary-type'},
              };
            }
            return method === 'textDocument/documentSymbol' ? [] : response;
          }),
        notify: (method, params) =>
          Effect.gen(function* () {
            calls.push({method, params});
            if (method === 'initialized' && timing) {
              yield* Effect.forkChild(
                Deferred.await(timing.release).pipe(
                  Effect.andThen(Effect.sync(() => notifications.receive('language/status', {type: 'ServiceReady'}))),
                ),
              );
              yield* Deferred.succeed(timing.initialized, undefined);
            }
          }),
        close: Effect.succeed({
          code: 0,
          drained: true,
          forced: false,
          stdioClosed: true,
          graceful: true,
          fault: undefined,
        }),
      };
      const session = yield* makeJavaSession(client, {
        basis,
        notifications,
        roots: [],
        profile: prepared.profile,
        startupMilliseconds: 1000,
        prepared,
        bundle,
        diagnosticModel,
        runtime,
      });
      if (timing) yield* Deferred.succeed(timing.returned, undefined);
      const current = yield* session.upsert(basis, text, 'java', 1000);
      return {session, current, calls};
    });
  return {...f, prepared, basis, uri, text, create};
});
const range = {start: {line: 0, character: 6}, end: {line: 0, character: 10}};

describe('Java session source targets', () => {
  effectIt.effect('refuses attachment when the runtime project SDK differs from the prepared model', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const result = yield* Effect.exit(
        f.create({}, undefined, undefined, {projectJavaHome: f.root, verify: Effect.void}),
      );
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('rechecks runtime integrity before later operations and sends no query after SDK drift', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const drifted = yield* Deferred.make<void>();
      const verify = Deferred.isDone(drifted).pipe(
        Effect.flatMap(changed => (changed ? LspFault.make({code: 'prerequisite'}) : Effect.void)),
      );
      const {session, current, calls} = yield* f.create([], undefined, undefined, {
        projectJavaHome: f.javaHome,
        verify,
      });
      yield* Deferred.succeed(drifted, undefined);
      expect((yield* Effect.exit(session.query('definition', current, range.start, 1000)))._tag).toBe('Failure');
      expect(EffectArray.some(calls, call => call.method === 'textDocument/definition')).toBe(false);
      expect(yield* session.available).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('retires a session when SDK integrity changes during a provider response', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const history: {calls: readonly {method: string}[]} = {calls: []};
      const verify = Effect.suspend(() =>
        EffectArray.some(history.calls, call => call.method === 'textDocument/definition')
          ? LspFault.make({code: 'prerequisite'})
          : Effect.void,
      );
      const {session, current, calls} = yield* f.create([], undefined, undefined, {
        projectJavaHome: f.javaHome,
        verify,
      });
      history.calls = calls;
      expect((yield* Effect.exit(session.query('definition', current, range.start, 1000)))._tag).toBe('Failure');
      expect(EffectArray.some(calls, call => call.method === 'textDocument/definition')).toBe(true);
      expect(yield* session.available).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('captures query observation and cursor before the asynchronous SDK preflight', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gate = {armed: false};
      const verify = Effect.suspend(() => {
        if (!gate.armed) return Effect.void;
        gate.armed = false;
        return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
      });
      const {session, current, calls} = yield* f.create([], undefined, undefined, {
        projectJavaHome: f.javaHome,
        verify,
      });
      const requested = structuredClone(current);
      const position = {...range.start};
      gate.armed = true;
      const querying = yield* Effect.forkChild(session.query('definition', requested, position, 1000));
      yield* Deferred.await(entered);
      Reflect.set(requested, 'documentVersion', 999);
      position.character = 999;
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(querying)).status).toBe('ok');
      expect(EffectArray.findLast(calls, call => call.method === 'textDocument/definition')).toMatchObject({
        value: {params: {position: range.start}},
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('invalidates a ready no-op attachment when the outer SDK postflight fails', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const gate = {armed: false, checks: 0};
      const verify = Effect.suspend(() =>
        gate.armed && ++gate.checks === 2 ? LspFault.make({code: 'prerequisite'}) : Effect.void,
      );
      const {session, current, calls} = yield* f.create([], undefined, undefined, {
        projectJavaHome: f.javaHome,
        verify,
      });
      const before = calls.length;
      gate.armed = true;
      expect((yield* Effect.exit(session.upsert(current, f.text, 'java', 1000)))._tag).toBe('Failure');
      expect(calls).toHaveLength(before);
      expect(yield* session.available).toBe(false);
      expect(yield* session.observation(current.uri)).toBeUndefined();
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('captures rename observation and cursor before the asynchronous SDK preflight', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gate = {armed: false};
      const verify = Effect.suspend(() => {
        if (!gate.armed) return Effect.void;
        gate.armed = false;
        return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
      });
      const {session, current, calls} = yield* f.create(
        {changes: {[f.uri]: [{range, newText: 'Next'}]}},
        undefined,
        undefined,
        {projectJavaHome: f.javaHome, verify},
      );
      const requested = structuredClone(current);
      const position = {...range.start};
      gate.armed = true;
      const preparing = yield* Effect.forkChild(session.prepare('rename', requested, position, 'Next', 1000));
      yield* Deferred.await(entered);
      Reflect.set(requested, 'documentVersion', 999);
      position.character = 999;
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(preparing)).status).toBe('ok');
      expect(EffectArray.findLast(calls, call => call.method === 'textDocument/rename')).toMatchObject({
        value: {params: {position: range.start}},
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('captures attachment identity before the asynchronous SDK preflight', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gate = {armed: false};
      const verify = Effect.suspend(() => {
        if (!gate.armed) return Effect.void;
        gate.armed = false;
        return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
      });
      const {session, current} = yield* f.create([], undefined, undefined, {projectJavaHome: f.javaHome, verify});
      const changed = 'class Next {}\n';
      const requested = {...current, documentVersion: 2, content: sha256HexSync(changed)};
      gate.armed = true;
      const attaching = yield* Effect.forkChild(session.upsert(requested, changed, 'java', 1000));
      yield* Deferred.await(entered);
      requested.documentVersion = 999;
      requested.content = sha256HexSync('different caller request');
      yield* Deferred.succeed(release, undefined);
      const attached = yield* Fiber.join(attaching);
      expect(attached.documentVersion).toBe(2);
      expect(attached.content).toBe(sha256HexSync(changed));
      expect(yield* session.observation(current.uri)).toEqual(attached);
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('keeps one attachment deadline and invalidates a view when its SDK postflight stalls', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const entered = yield* Deferred.make<void>();
      const gate = {armed: false, checks: 0};
      const verify = Effect.suspend(() =>
        gate.armed && ++gate.checks === 2
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      );
      const {session, current} = yield* f.create([], undefined, undefined, {projectJavaHome: f.javaHome, verify});
      gate.armed = true;
      const attaching = yield* Effect.forkChild(session.upsert(current, f.text, 'java', 1000));
      yield* Deferred.await(entered);
      yield* TestClock.adjust(1001);
      expect(yield* Effect.flip(Fiber.join(attaching))).toMatchObject({_tag: 'LspFault', code: 'timeout'});
      expect(yield* session.available).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('refuses a superseded attachment after SDK postflight without retiring the newer view', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gate = {armed: false, checks: 0};
      const verify = Effect.suspend(() =>
        gate.armed && ++gate.checks === 2
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      );
      const {session, current} = yield* f.create([], undefined, undefined, {projectJavaHome: f.javaHome, verify});
      gate.armed = true;
      const older = yield* Effect.forkChild(session.upsert(current, f.text, 'java', 1000));
      yield* Deferred.await(entered);
      const changed = 'class Next {}\n';
      const newer = yield* session.upsert(
        {...current, documentVersion: 2, content: sha256HexSync(changed)},
        changed,
        'java',
        1000,
      );
      yield* Deferred.succeed(release, undefined);
      expect(yield* Effect.flip(Fiber.join(older))).toMatchObject({_tag: 'SemanticSessionFault', reason: 'stale'});
      expect(yield* session.available).toBe(true);
      expect(yield* session.observation(current.uri)).toEqual(newer);
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect.prop(
    'preserves the newer view when an older attachment arrives after a delayed SDK preflight',
    [
      Schema.Int.check(Schema.isBetween({minimum: 2, maximum: 64})),
      Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 64})),
    ],
    ([olderVersion, increment]) =>
      Effect.gen(function* () {
        const f = yield* sessionFixture;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const gate = {armed: false};
        const verify = Effect.suspend(() => {
          if (!gate.armed) return Effect.void;
          gate.armed = false;
          return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
        });
        const {session, current} = yield* f.create([], undefined, undefined, {projectJavaHome: f.javaHome, verify});
        gate.armed = true;
        const older = yield* Effect.forkChild(
          session.upsert({...current, documentVersion: olderVersion}, f.text, 'java', 1000),
        );
        yield* Deferred.await(entered);
        const newer = yield* session.upsert(
          {...current, documentVersion: olderVersion + increment},
          f.text,
          'java',
          1000,
        );
        yield* Deferred.succeed(release, undefined);
        expect(yield* Effect.flip(Fiber.join(older))).toMatchObject({_tag: 'SemanticSessionFault', reason: 'conflict'});
        expect(yield* session.available).toBe(true);
        expect(yield* session.observation(current.uri)).toEqual(newer);
      }).pipe(Effect.provide(BunServices.layer)),
    {arbitrary: {runs: 32}},
  );
  effectIt.effect('preserves a healthy view after a pre-mutation invalid attachment is refused', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const {session, current} = yield* f.create([]);
      const invalid = {...current, documentVersion: 2, content: sha256HexSync('different caller text')};
      expect(yield* Effect.flip(session.upsert(invalid, f.text, 'java', 1000))).toMatchObject({
        _tag: 'SemanticSessionFault',
        reason: 'invalid',
      });
      expect(yield* session.available).toBe(true);
      expect(yield* session.observation(current.uri)).toEqual(current);
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('waits for delayed ServiceReady before returning the factory or opening any document', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const timing = {
        initialized: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
        returned: yield* Deferred.make<void>(),
        calls: [] as {method: string; params: Schema.Json | undefined}[],
      };
      const fiber = yield* Effect.forkChild(f.create([], undefined, timing));
      yield* Deferred.await(timing.initialized);
      yield* Effect.yieldNow;
      expect(yield* Deferred.isDone(timing.returned)).toBe(false);
      expect(EffectArray.some(timing.calls, call => EffectString.startsWith('textDocument/')(call.method))).toBe(false);
      yield* Deferred.succeed(timing.release, undefined);
      const {current} = yield* Fiber.join(fiber);
      expect(current.uri).toBe(f.uri);
      expect(yield* Deferred.isDone(timing.returned)).toBe(true);
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('bounds a missing ServiceReady without exposing a session or opening a document', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const timing = {
        initialized: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
        returned: yield* Deferred.make<void>(),
        calls: [] as {method: string; params: Schema.Json | undefined}[],
      };
      const fiber = yield* Effect.forkChild(f.create([], undefined, timing));
      yield* Deferred.await(timing.initialized);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(1001);
      expect((yield* Effect.exit(Fiber.join(fiber)))._tag).toBe('Failure');
      expect(yield* Deferred.isDone(timing.returned)).toBe(false);
      expect(EffectArray.some(timing.calls, call => EffectString.startsWith('textDocument/')(call.method))).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('maps a physical root alias without changing canonical source spelling', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const alias = f.path.join(f.root, 'Alias');
      yield* f.fs.symlink(f.source, alias);
      const sourceUri = yield* makeJavaSourceUri([f.source]);
      const canonical = (yield* f.path.toFileUrl(f.path.join(f.source, 'Main.java'))).href;
      expect(yield* sourceUri((yield* f.path.toFileUrl(f.path.join(alias, 'Main.java'))).href)).toBe(canonical);
      expect(yield* sourceUri(canonical)).toBe(canonical);
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('maps JDT Unicode URI spelling through the same physical source identity checks', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const alias = f.path.join(f.root, 'Alias');
      yield* f.fs.symlink(f.source, alias);
      const name = 'ΔCafé.java';
      yield* f.fs.writeFileString(f.path.join(f.source, name), 'class ΔCafé {}\n');
      const canonical = (yield* f.path.toFileUrl(yield* f.fs.realPath(f.path.join(f.source, name)))).href;
      const sourceUri = yield* makeJavaSourceUri([f.source]);
      const providerUri = (yield* f.path.toFileUrl(alias)).href + '/' + name;
      expect(yield* sourceUri(providerUri)).toBe(canonical);
      expect(yield* sourceUri(canonical)).toBe(canonical);
      for (const suffix of ['?query', '#fragment', '/%2Fbad', '\n', '\ud800'])
        expect((yield* Effect.exit(sourceUri(providerUri + suffix)))._tag).toBe('Failure');
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('refuses outside hard links, nested symlink escapes, virtual sources and root replacement', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const sourceUri = yield* makeJavaSourceUri([f.source]);
      const file = f.path.join(f.source, 'Main.java');
      const outside = f.path.join(f.root, 'Outside.java');
      yield* f.fs.link(file, outside);
      yield* f.fs.symlink(outside, f.path.join(f.source, 'Escape.java'));
      for (const uri of [
        'jdt://contents/dependency/Main.class',
        (yield* f.path.toFileUrl(outside)).href,
        (yield* f.path.toFileUrl(f.path.join(f.source, 'Escape.java'))).href,
      ])
        expect((yield* Effect.exit(sourceUri(uri)))._tag).toBe('Failure');
      yield* f.fs.rename(f.source, f.source + '-old');
      yield* f.fs.makeDirectory(f.source);
      yield* f.fs.writeFileString(file, 'class Main {}\n');
      expect((yield* Effect.exit(sourceUri((yield* f.path.toFileUrl(file)).href)))._tag).toBe('Failure');
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('refuses duplicate physical roots and overlapping source scopes', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const roots of [
        [f.source, f.source],
        [f.project, f.source],
      ])
        expect((yield* Effect.exit(makeJavaSourceUri(roots)))._tag).toBe('Failure');
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect.prop(
    'preserves complete edit sets, opaque data and input bytes; translation is idempotent',
    [
      Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 10000}))).check(
        Schema.isBetweenLength(1, 10),
      ),
    ],
    ([names]) =>
      Effect.gen(function* () {
        const changes: Record<string, Schema.Json> = {};
        const expected: Record<string, Schema.Json> = {};
        for (const name of names) {
          const edits = [{range, newText: String(name)}];
          changes[`file:///alias/${name}.java`] = edits;
          expected[`file:///project/${name}.java`] = edits;
        }
        const input = [{title: 'Change', data: {uri: 'file:///alias/opaque'}, edit: {changes}}];
        const before = JSON.stringify(input);
        const sourceUri = (value: string) =>
          Effect.succeed(EffectString.replace('file:///alias/', 'file:///project/')(value));
        const output = yield* mapJavaSourceResponse('textDocument/codeAction', input, sourceUri);
        expect(output).toEqual([{...input[0], edit: {changes: expected}}]);
        expect(yield* mapJavaSourceResponse('textDocument/codeAction', output, sourceUri)).toEqual(output);
        expect(JSON.stringify(input)).toBe(before);
      }),
    {arbitrary: {runs: 32}},
  );
  effectIt.effect('maps only location slots and retains hierarchy routing data unchanged', () =>
    Effect.gen(function* () {
      const sourceUri = (value: string) => Effect.succeed(EffectString.replace('alias', 'source')(value));
      const input = [
        {from: {uri: 'file:///alias/Main.java', range, data: {uri: 'file:///alias/opaque'}}, fromRanges: [range]},
      ];
      expect(yield* mapJavaSourceResponse('callHierarchy/incomingCalls', input, sourceUri)).toEqual([
        {...input[0], from: {...input[0].from, uri: 'file:///source/Main.java'}},
      ]);
      const links = [{targetUri: 'file:///alias/Main.java', targetRange: range, targetSelectionRange: range}];
      expect(yield* mapJavaSourceResponse('textDocument/definition', links, sourceUri)).toEqual([
        {...links[0], targetUri: 'file:///source/Main.java'},
      ]);
      expect(
        yield* mapJavaSourceResponse('textDocument/hover', {contents: 'file:///alias/Main.java'}, sourceUri),
      ).toEqual({contents: 'file:///alias/Main.java'});
    }),
  );
  effectIt.effect('refuses an entire edit response when two target aliases collapse to one file', () =>
    Effect.gen(function* () {
      const response = {
        changes: {
          'file:///alias/Main.java': [{range, newText: 'One'}],
          'file:///source/Main.java': [{range, newText: 'Two'}],
        },
      };
      expect(
        (yield* Effect.exit(
          mapJavaSourceResponse('textDocument/rename', response, () => Effect.succeed('file:///source/Main.java')),
        ))._tag,
      ).toBe('Failure');
    }),
  );
  effectIt.effect('uses private initialization, captures early readiness, and prepares complete canonical edits', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const alias = f.path.join(f.root, 'Alias');
      yield* f.fs.symlink(f.source, alias);
      const providerUri = (yield* f.path.toFileUrl(f.path.join(alias, 'Main.java'))).href;
      const {session, current, calls} = yield* f.create({changes: {[providerUri]: [{range, newText: 'Next'}]}});
      const result = yield* session.prepare('rename', current, range.start, 'Next', 1000);
      expect(result.status).toBe('ok');
      expect(result).toMatchObject({
        items: [{files: [{uri: f.uri, content: sha256HexSync(f.text), documentVersion: 1}]}],
      });
      expect(calls[0]).toMatchObject({
        method: 'initialize',
        params: {
          rootUri: (yield* f.path.toFileUrl(f.prepared.project)).href,
          initializationOptions: {
            bundles: [f.path.join(f.prepared.directory, javaDiagnosticBundle.jarSha256 + '.jar')],
          },
        },
      });
      expect(EffectArray.filter(calls, call => call.method === 'workspace/didChangeConfiguration')).toHaveLength(1);
      expect(yield* f.fs.readFileString(f.path.join(f.source, 'Main.java'))).toBe(f.text);
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect(
    'reports unsupported virtual targets with the current observation and retains no partial rename',
    () =>
      Effect.gen(function* () {
        const f = yield* sessionFixture;
        const {session, current} = yield* f.create({
          changes: {
            [f.uri]: [{range, newText: 'Next'}],
            'jdt://contents/dependency/Main.class': [{range, newText: 'Next'}],
          },
        });
        const result = yield* session.prepare('rename', current, range.start, 'Next', 1000);
        expect(result).toMatchObject({status: 'unsupported', evidence: {observation: current}});
        expect('items' in result).toBe(false);
        expect(yield* f.fs.readFileString(f.path.join(f.source, 'Main.java'))).toBe(f.text);
      }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('rejects an incompatible server before opening a document', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      expect((yield* Effect.exit(f.create([], '1.62.0')))._tag).toBe('Failure');
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect(
    'uses the fixed captured-AST command and refuses unavailable binary types without the broken native route',
    () =>
      Effect.gen(function* () {
        const f = yield* sessionFixture;
        const {session, current, calls} = yield* f.create([]);
        expect(yield* session.query('type-definition', current, range.start, 1000)).toMatchObject({
          status: 'unsupported',
          evidence: {observation: current},
        });
        expect(EffectArray.some(calls, call => call.method === 'textDocument/typeDefinition')).toBe(false);
        expect(EffectArray.some(calls, call => call.method === 'workspace/executeCommand')).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('retains complete import actions while refusing whole resource/command actions explicitly', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const good = {title: 'Import', edit: {changes: {[f.uri]: [{range, newText: 'Next'}]}}};
      const resource = {title: 'Create class', edit: {documentChanges: [{kind: 'create', uri: f.uri + '.new'}]}};
      const command = {title: 'Run command', command: {command: 'untrusted'}, edit: {changes: {'jdt://opaque': []}}};
      const first = yield* f.create([resource, good, command]);
      const result = yield* first.session.prepare('code-action', first.current, range.start, undefined, 1000);
      expect(result).toMatchObject({status: 'ok', items: [{title: 'Import', files: [{uri: f.uri}]}]});
      if (result.status === 'ok') expect(result.items).toHaveLength(1);
      const second = yield* f.create([resource, command]);
      expect(yield* second.session.prepare('code-action', second.current, range.start, undefined, 1000)).toMatchObject({
        status: 'unsupported',
      });
      expect(yield* f.fs.readFileString(f.path.join(f.source, 'Main.java'))).toBe(f.text);
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect(
    'checks a returned source-type hash against the actual session text before returning its location',
    () =>
      Effect.gen(function* () {
        const f = yield* sessionFixture;
        const source = {
          status: 'source',
          location: {uri: f.uri, range, contentSha256: sha256HexSync(f.text), utf16Length: f.text.length},
        };
        const valid = yield* f.create({typeDefinition: source});
        expect(yield* valid.session.query('type-definition', valid.current, range.start, 1000)).toMatchObject({
          status: 'ok',
          items: [{uri: f.uri, range}],
        });
        const invalid = yield* f.create({
          typeDefinition: {...source, location: {...source.location, contentSha256: EffectString.repeat(64)('c')}},
        });
        expect(
          (yield* Effect.exit(invalid.session.query('type-definition', invalid.current, range.start, 1000)))._tag,
        ).toBe('Failure');
        expect(yield* f.fs.readFileString(f.path.join(f.source, 'Main.java'))).toBe(f.text);
      }).pipe(Effect.provide(BunServices.layer)),
  );
});
