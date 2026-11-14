import {cryptoLayer} from '@threadnote/platform/crypto';
/* oxlint-disable effecttsgo/strict-effect-provide -- OS-facing bundle tests provide only Bun filesystem/crypto services. */
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Order, Path, Schema, Stream} from 'effect';
import {TestClock} from 'effect/testing';
import {unzipSync} from 'fflate';
import fc from 'fast-check';
import {describe, expect, it, vi} from 'vitest';
import * as javaRuntime from '../../src/semantic/providers/java_runtime.js';
import * as lsp from '../../src/semantic/lsp_transport.js';
import {makeJavaAnalysis, type JavaAnalysisOptions} from '../../src/semantic/providers/java.js';
import {semanticTreeDigest} from '../../src/semantic/fingerprint.js';
import * as fingerprints from '../../src/semantic/fingerprint.js';
import {loadJavaPreparedModel} from '../../src/semantic/providers/java_preparation.js';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SemanticActionChoice} from '../../src/semantic/action_choices.js';
import {Observation} from '@threadnote/semantic/contracts';
import {
  makeLspSession,
  makeSemanticNotifications,
  type LspDiagnosticRequest,
  type LspSessionPolicy,
} from '../../src/semantic/provider.js';
import {LspFault, type LspClient} from '../../src/semantic/lsp_transport.js';
import {javaDiagnosticBundle} from '../../src/semantic/providers/java_diagnostics_bundle.js';
import {
  materializeJavaDiagnosticBundle,
  makeJavaDiagnosticModel,
  readJavaDiagnosticReport,
  requestJavaDiagnostics,
  readJavaTypeDefinitionReport,
  requestJavaTypeDefinition,
  type JavaDiagnosticModel,
} from '../../src/semantic/providers/java_diagnostics.js';
import {
  JavaProjectionImage,
  javaProjectionDigest,
  javaTypeDefinitionCommand,
  javaFileUri,
} from '../../src/semantic/providers/java_snapshot.js';
import {preparedSessionFixture} from '../fixtures/semantic/jvm/prepared-session.js';

class PreparedEditFixture extends Context.Service<
  PreparedEditFixture,
  {readonly fixture: Effect.Success<ReturnType<typeof preparedSessionFixture>>; readonly digest: string}
>()('@threadnote/threadnote/test/unit/semantic-java-diagnostics.test/PreparedEditFixture') {}

const model: JavaDiagnosticModel = {
  projectUri: 'file:///private/projection',
  javaHomeUri: 'file:///sdk/java21',
  sourceRoots: ['file:///project/src'],
  libraries: ['file:///cache/dependency.jar'],
};
const request: LspDiagnosticRequest = {
  requestToken: 'request-1',
  target: {uri: 'file:///project/src/Main.java', text: 'class Main {}\n'},
  inputs: [
    {uri: 'file:///project/src/Main.java', text: 'class Main {}\n'},
    {uri: 'file:///project/src/Other.java', text: 'class Other {}\n'},
  ],
};
const diagnostic = {
  range: {start: {line: 0, character: 0}, end: {line: 0, character: 5}},
  severity: 2,
  code: '1',
  source: 'Java',
  message: 'A bounded warning',
  data: {arguments: ['Main']},
};
const report = () => ({
  protocolVersion: 1,
  requestToken: request.requestToken,
  uri: request.target.uri,
  contentSha256: sha256HexSync(request.target.text),
  utf16Length: request.target.text.length,
  model: {
    ...model,
    compilerOptions: {
      'org.eclipse.jdt.core.compiler.compliance': '21',
      'org.eclipse.jdt.core.compiler.source': '21',
      'org.eclipse.jdt.core.compiler.codegen.targetPlatform': '21',
      'org.eclipse.jdt.core.compiler.release': 'enabled',
    },
    annotationProcessing: 'disabled-for-snapshot',
  },
  inputs: EffectArray.map(request.inputs, input => ({
    uri: input.uri,
    contentSha256: sha256HexSync(input.text),
    utf16Length: input.text.length,
  })),
  diagnostics: [structuredClone(diagnostic)],
});
const projectionImage = (): typeof JavaProjectionImage.Type => ({
  format: 'threadnote-passive-java-projection-v1',
  projectCharset: 'UTF-8',
  outputPath: '/threadnote-java/output-0',
  rawClasspath: [
    {
      kind: 3,
      contentKind: 1,
      path: '/threadnote-java/source-0',
      exported: false,
      combineAccessRules: false,
      inclusions: ['**/*.java'],
      exclusions: ['internal/**'],
      attributes: [
        {name: 'optional', value: 'true'},
        {name: 'test', value: 'true'},
      ],
      accessRules: [
        {pattern: 'internal/**', kind: 1, ignoreIfBetter: true},
        {pattern: 'api/**', kind: 2, ignoreIfBetter: false},
      ],
      outputPath: '/threadnote-java/output-1',
    },
  ],
  resolvedClasspath: [
    {
      kind: 1,
      contentKind: 2,
      path: '/cache/dependency.jar',
      exported: true,
      combineAccessRules: false,
      inclusions: [],
      exclusions: [],
      attributes: [{name: 'maven.version', value: '1.0'}],
      accessRules: [],
      sourceAttachmentPath: '/sdk/java21/lib/src.zip',
    },
    {
      kind: 1,
      contentKind: 2,
      path: '/cache/other-version.jar',
      exported: false,
      combineAccessRules: false,
      inclusions: [],
      exclusions: [],
      attributes: [{name: 'maven.version', value: '2.0'}],
      accessRules: [],
    },
  ],
  links: [{path: 'source-0', uri: 'file:///project/src', type: 2}],
  resourceFilters: [
    {
      id: '1234',
      path: '',
      type: 30,
      matcherId: 'org.eclipse.core.resources.regexFilterMatcher',
      arguments: 'node_modules|\\.git|__CREATED_BY_JAVA_LANGUAGE_SERVER__',
    },
  ],
});
const client = (run: LspClient['request']): LspClient => ({
  pid: 1,
  request: run,
  notify: () => Effect.void,
  close: Effect.succeed({code: 0, drained: true, forced: false, stdioClosed: true, graceful: true, fault: undefined}),
});
const typePosition = {line: 0, character: 7};
const typeReport = () => ({
  protocolVersion: 1,
  requestToken: request.requestToken,
  uri: request.target.uri,
  contentSha256: sha256HexSync(request.target.text),
  utf16Length: request.target.text.length,
  model: report().model,
  inputs: report().inputs,
  position: typePosition,
  typeDefinition: {
    status: 'source',
    location: {
      uri: request.target.uri,
      range: {start: {line: 0, character: 6}, end: {line: 0, character: 10}},
      contentSha256: sha256HexSync(request.target.text),
      utf16Length: request.target.text.length,
    },
  },
});
const jarBytes = () =>
  Uint8Array.from(atob(javaDiagnosticBundle.jarBase64), character =>
    EffectString.charCodeAt(0)(character).pipe(value => (value._tag === 'Some' ? value.value : 0)),
  );

const sharedFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-session-'}));
  const projectUri = (yield* path.toFileUrl(directory)).href;
  const uri = (yield* path.toFileUrl(path.join(directory, 'Main.java'))).href;
  const text = 'class Main {}\n';
  yield* fs.writeFileString(path.join(directory, 'Main.java'), text);
  const basis: Observation = {
    version: 1,
    repository: 'java-test',
    worktree: projectUri,
    project: projectUri,
    configuration: EffectString.repeat(64)('a'),
    toolchain: EffectString.repeat(64)('b'),
    provider: {id: 'jdtls', version: '1.63.0', generation: 0},
    view: {kind: 'overlay', id: 'java-view', owner: 'test', epoch: 0},
    uri,
    content: sha256HexSync(text),
    documentVersion: 1,
    projectEpoch: 0,
  };
  return {fs, path, directory, projectUri, uri, text, basis, notifications: makeSemanticNotifications()};
});

const capabilities = {
  positionEncoding: 'utf-16',
  documentSymbolProvider: true,
  codeActionProvider: true,
  executeCommandProvider: {commands: [javaDiagnosticBundle.command]},
};
const sharedPolicy = {
  language: 'java' as const,
  workspaceName: 'java-test',
  acceptsServer: () => true,
  limitations: [],
  requiredCommands: [javaDiagnosticBundle.command],
};
const limitedSession = Effect.fn('test.limitedJavaSession')(function* (limits?: LspSessionPolicy['documentLimits']) {
  const f = yield* sharedFixture;
  const requests: string[] = [];
  const notices: string[] = [];
  const native = {
    ...client(method =>
      Effect.sync(() => {
        requests.push(method);
        return method === 'initialize' ? {capabilities} : [];
      }),
    ),
    notify: (method: string) =>
      Effect.sync(() => {
        notices.push(method);
      }),
  };
  const session = yield* makeLspSession(native, {
    basis: f.basis,
    notifications: f.notifications,
    roots: [],
    profile: {},
    ready: Effect.void,
    startupMilliseconds: 1000,
    policy: {...sharedPolicy, ...(limits === undefined ? {} : {documentLimits: limits})},
  });
  const uri = (slot: number) => new URL('Source' + slot + '.java', f.projectUri + '/').href;
  const attach = (slot: number, text: string, version: number) =>
    session.upsert(
      {...f.basis, uri: uri(slot), content: sha256HexSync(text), documentVersion: version},
      text,
      'java',
      1000,
    );
  return {session, requests, notices, uri, attach};
});

describe('Java request diagnostics', () => {
  describe.skipIf(process.platform === 'win32')('prepared session source admission', () => {
    effectIt.effect(
      'refuses cached observation publication after late SDK drift without issuing provider queries',
      () =>
        Effect.gen(function* () {
          const f = yield* preparedSessionFixture();
          let armed = false;
          let checks = 0;
          const made = yield* f.create([], options => {
            Reflect.set(
              options.runtime,
              'verify',
              Effect.gen(function* () {
                if (armed && ++checks === 2)
                  yield* f.fs.writeFileString(
                    f.path.join(f.javaHome, 'release'),
                    'changed SDK during observation publication',
                  );
              }),
            );
          });
          const session = yield* made.result;
          const observed = yield* session.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
          expect(yield* session.observation(observed.uri)).toEqual(observed);
          const calls = made.calls.length;
          armed = true;
          const result = yield* session.observation(observed.uri).pipe(Effect.result);
          expect(result._tag).toBe('Failure');
          expect(checks).toBe(2);
          expect(made.calls).toHaveLength(calls);
          expect(yield* session.available).toBe(false);
        }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );
    effectIt.effect('refuses a closed host before initialization and captures its lifecycle predicate', () =>
      Effect.gen(function* () {
        const f = yield* preparedSessionFixture();
        const refused = yield* f.create([], options => {
          Reflect.set(options, 'isActive', () => false);
        });
        expect(yield* Effect.flip(refused.result)).toMatchObject({code: 'closing'});
        expect(refused.calls).toEqual([]);

        let active = true;
        const made = yield* f.create([], options => {
          Reflect.set(options, 'isActive', () => active);
        });
        const session = yield* made.result;
        const observation = yield* session.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
        Reflect.set(made.options, 'isActive', () => true);
        active = false;
        const calls = made.calls.length;
        expect(
          yield* Effect.flip(session.query('definition', observation, {line: 0, character: 13}, 1000)),
        ).toMatchObject({code: 'closing'});
        expect(made.calls).toHaveLength(calls);
        expect(yield* session.available).toBe(false);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );
    effectIt.effect('refuses reads and diagnostic delivery when the host closes during compiler IO', () =>
      Effect.gen(function* () {
        for (const operation of ['definition', 'diagnostics'] as const)
          yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* preparedSessionFixture();
              let active = true,
                armed = false;
              const made = yield* f.create(
                [],
                options => {
                  Reflect.set(options, 'isActive', () => active);
                },
                method =>
                  Effect.sync(() => {
                    if (armed && (method === 'textDocument/definition' || method === 'workspace/executeCommand'))
                      active = false;
                  }),
              );
              const session = yield* made.result;
              const observation = yield* session.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
              armed = true;
              const read =
                operation === 'diagnostics'
                  ? session.diagnostics(observation, 1000).pipe(Effect.asVoid)
                  : session.query('definition', observation, {line: 0, character: 13}, 1000).pipe(Effect.asVoid);
              expect(yield* Effect.flip(read)).toMatchObject({code: 'closing'});
              expect(yield* session.available).toBe(false);
            }),
          );
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );
    for (const target of ['source', 'sdk', 'model', 'private', 'library', 'inventory'] as const) {
      effectIt.effect.prop(
        `preserves source and artifact refusal in both guards while reserving SDK bytes for the full guard (${target})`,
        [Schema.NonEmptyString.check(Schema.isMaxLength(32))],
        ([suffix]) =>
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* preparedSessionFixture();
              yield* f.prepared.verifySource;
              yield* f.prepared.verify;
              const files = {
                source: f.path.join(f.source, 'Main.java'),
                sdk: f.path.join(f.javaHome, 'release'),
                model: f.metadataFile,
                private: f.path.join(f.prepared.project, '.settings/org.eclipse.jdt.core.prefs'),
                library: f.library,
                inventory: f.path.join(f.path.dirname(f.metadataFile), 'unexpected'),
              };
              const original = target === 'inventory' ? '' : yield* f.fs.readFileString(files[target]);
              yield* f.fs.writeFileString(files[target], original + suffix, {mode: 0o600});
              const source = yield* Effect.exit(f.prepared.verifySource);
              const full = yield* Effect.exit(f.prepared.verify);
              expect(source._tag).toBe(target === 'sdk' ? 'Success' : 'Failure');
              expect(full._tag).toBe('Failure');
            }),
          ).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
        {arbitrary: {runs: 8}},
      );
    }
    effectIt.effect('encloses owned projection inspection with exactly one fresh model verification', () =>
      Effect.gen(function* () {
        const f = yield* preparedSessionFixture();
        const loaded = yield* loadJavaPreparedModel({
          project: f.project,
          worktree: f.project,
          javaHome: f.javaHome,
          metadataFile: f.metadataFile,
          metadataDigest: sha256HexSync(yield* f.fs.readFileString(f.metadataFile)),
        });
        const digest = fingerprints.semanticSdkDigest;
        const events: string[] = [];
        const spy = vi.spyOn(fingerprints, 'semanticSdkDigest').mockImplementation(root =>
          digest(root).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (root === f.javaHome) events.push('sdk');
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          yield* loaded.verifyWithOwnedProjection(Effect.sync(() => void events.push('projection')));
          expect(events).toEqual(['sdk', 'projection', 'sdk']);
          events.length = 0;
          yield* f.prepared.verify;
          expect(events).toEqual(['sdk', 'sdk']);
          events.length = 0;
          yield* f.prepared.verifySource;
          expect(events).toEqual([]);
        }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );
    effectIt.effect('rejects SDK, source and artifact mutation inside owned projection inspection', () =>
      Effect.gen(function* () {
        for (const target of ['sdk', 'source', 'model', 'library'] as const) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* preparedSessionFixture();
              const loaded = yield* loadJavaPreparedModel({
                project: f.project,
                worktree: f.project,
                javaHome: f.javaHome,
                metadataFile: f.metadataFile,
                metadataDigest: sha256HexSync(yield* f.fs.readFileString(f.metadataFile)),
              });
              const file = {
                sdk: f.path.join(f.javaHome, 'release'),
                source: f.path.join(f.source, 'Main.java'),
                model: f.metadataFile,
                library: f.library,
              }[target];
              const before = yield* f.fs.readFileString(file);
              let inspections = 0;
              const result = yield* loaded
                .verifyWithOwnedProjection(
                  Effect.sync(() => {
                    inspections++;
                  }).pipe(Effect.andThen(f.fs.writeFileString(file, before + 'changed'))),
                )
                .pipe(Effect.exit);
              expect(result._tag).toBe('Failure');
              expect(inspections).toBe(1);
            }),
          );
        }
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );
    effectIt.effect('retains exactly two full guards and retires on SDK drift inside a source-only exchange', () =>
      Effect.gen(function* () {
        const f = yield* preparedSessionFixture();
        let fullChecks = 0,
          sourceChecks = 0,
          changeSdk = false;
        const range = {start: {line: 0, character: 6}, end: {line: 0, character: 14}};
        const made = yield* f.create(
          [{uri: f.uris['Included.java'], range}],
          options => {
            Reflect.set(options, 'prepared', {
              ...f.prepared,
              verify: Effect.sync(() => {
                fullChecks++;
              }).pipe(Effect.andThen(f.prepared.verify)),
              verifySource: Effect.sync(() => {
                sourceChecks++;
              }).pipe(Effect.andThen(f.prepared.verifySource)),
            });
          },
          method =>
            changeSdk && method === 'textDocument/definition'
              ? f.fs.writeFileString(f.path.join(f.javaHome, 'release'), 'changed SDK')
              : Effect.void,
        );
        const session = yield* made.result;
        const observation = yield* session.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
        fullChecks = 0;
        sourceChecks = 0;
        expect((yield* session.query('definition', observation, {line: 0, character: 13}, 1000)).status).toBe('ok');
        expect(fullChecks).toBe(2);
        expect(sourceChecks).toBe(2);
        changeSdk = true;
        expect(
          yield* Effect.flip(session.query('definition', observation, {line: 0, character: 13}, 1000)),
        ).toMatchObject({code: 'prerequisite'});
        expect(yield* session.available).toBe(false);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );
    effectIt.effect('rejects SDK drift before compiler IO, on provider error, and before diagnostic delivery', () =>
      Effect.gen(function* () {
        for (const mode of ['before', 'error', 'diagnostics'] as const) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const f = yield* preparedSessionFixture();
              let armed = false;
              const changeSdk = f.fs.writeFileString(f.path.join(f.javaHome, 'release'), 'changed SDK');
              const made = yield* f.create([], undefined, method =>
                Effect.gen(function* () {
                  if (!armed || (method !== 'textDocument/definition' && method !== 'workspace/executeCommand')) return;
                  yield* changeSdk;
                  if (mode === 'error') return yield* LspFault.make({code: 'protocol'});
                }),
              );
              const session = yield* made.result;
              const observation = yield* session.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
              const calls = made.calls.length;
              if (mode === 'before') yield* changeSdk;
              else armed = true;
              const operation =
                mode === 'diagnostics'
                  ? session.diagnostics(observation, 1000).pipe(Effect.asVoid)
                  : session.query('definition', observation, {line: 0, character: 13}, 1000).pipe(Effect.asVoid);
              expect(yield* Effect.flip(operation)).toMatchObject({code: 'prerequisite'});
              if (mode === 'before') expect(made.calls).toHaveLength(calls);
              expect(yield* session.available).toBe(false);
            }),
          );
        }
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );
    effectIt.effect.prop(
      'binds compiler values independently of key order and rejects a changed value before initialize',
      [
        Schema.Struct({
          ranks: Schema.Array(Schema.Int.check(Schema.isBetween({minimum: -9, maximum: 9}))).check(
            Schema.isBetweenLength(5, 5),
          ),
          changed: Schema.Boolean,
          key: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 4})),
        }),
      ],
      ([control]) =>
        Effect.gen(function* () {
          const f = yield* preparedSessionFixture();
          const entries = EffectRecord.toEntries(f.prepared.model.compilerOptions);
          const ranked = EffectArray.map(entries, (entry, index) => ({entry, index, rank: control.ranks[index]}));
          const byRank: Order.Order<(typeof ranked)[number]> = (a, b) =>
            Order.Number(a.rank, b.rank) || Order.Number(a.index, b.index);
          const ordered = EffectArray.sort(ranked, byRank);
          const compilerOptions = EffectRecord.fromEntries(EffectArray.map(ordered, item => item.entry));
          if (control.changed)
            Reflect.set(compilerOptions, entries[control.key][0], entries[control.key][1] + '-changed');
          const made = yield* f.create([], options => {
            Reflect.set(options, 'diagnosticModel', {...options.diagnosticModel, compilerOptions});
          });
          if (control.changed) {
            expect(yield* Effect.flip(made.result)).toMatchObject({code: 'prerequisite'});
            expect(made.calls).toEqual([]);
          } else expect(yield* (yield* made.result).available).toBe(true);
        }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
      {arbitrary: {runs: 16}},
    );

    effectIt.effect('refuses the complete edit when a closed target changes A to B to A around conversion', () =>
      Effect.gen(function* () {
        const f = yield* preparedSessionFixture();
        const file = f.path.join(f.source, 'Included.java');
        const sealedText = f.texts['Included.java'];
        const transientText = 'class Unrelate {}\n';
        let armed = false;
        let guardDepth = 0;
        let targetStats = 0;
        let mutated = false;
        let restored = false;
        const guarded = (check: typeof f.prepared.verify) =>
          Effect.sync(() => {
            guardDepth++;
          }).pipe(
            Effect.andThen(check),
            Effect.ensuring(
              Effect.sync(() => {
                guardDepth--;
              }),
            ),
          );
        const hooked = {
          ...f.fs,
          stat: (...args: Parameters<typeof f.fs.stat>) =>
            Effect.gen(function* () {
              // Both post-response reads formerly saw B while every real source/model guard saw A.
              if (armed && guardDepth === 0 && args[0] === file && ++targetStats === 4) {
                yield* f.fs.writeFileString(file, transientText);
                mutated = true;
              }
              return yield* f.fs.stat(...args);
            }),
        };
        const response = {
          changes: {
            [f.uris['Main.java']]: [
              {range: {start: {line: 0, character: 6}, end: {line: 0, character: 10}}, newText: 'Next'},
            ],
            [f.uris['Included.java']]: [
              {range: {start: {line: 0, character: 6}, end: {line: 0, character: 14}}, newText: 'Next'},
            ],
          },
        };
        const made = yield* f
          .create(response, options => {
            Reflect.set(options, 'prepared', {
              ...f.prepared,
              verify: guarded(f.prepared.verify),
              verifySource: guarded(f.prepared.verifySource),
            });
            const runtimeVerify = options.runtime.verify;
            Reflect.set(
              options.runtime,
              'verify',
              Effect.gen(function* () {
                if (mutated && !restored) {
                  yield* f.fs.writeFileString(file, sealedText);
                  restored = true;
                }
                yield* runtimeVerify;
              }),
            );
          })
          .pipe(Effect.provideService(FileSystem.FileSystem, hooked));
        const session = yield* made.result;
        const view = yield* session.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
        armed = true;
        const result = yield* Effect.exit(session.prepare('rename', view, {line: 0, character: 15}, 'Next', 10000));
        expect(mutated).toBe(true);
        expect(restored).toBe(true);
        expect(sha256HexSync(transientText)).not.toBe(sha256HexSync(sealedText));
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(result.cause.reasons).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                error: expect.objectContaining({_tag: 'SemanticSessionFault', reason: 'stale'}),
              }),
            ]),
          );
        expect(yield* f.fs.readFileString(file)).toBe(sealedText);
        yield* f.prepared.verify;
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );

    effectIt.effect('does not activate projected reads when the prepared model is missing', () =>
      Effect.gen(function* () {
        const f = yield* preparedSessionFixture();
        const withoutModel = {...f.prepared};
        Reflect.deleteProperty(withoutModel, 'model');
        const made = yield* f.create([], options => {
          Reflect.set(options, 'prepared', withoutModel);
        });
        expect(yield* Effect.flip(made.result)).toMatchObject({code: 'prerequisite'});
        expect(made.calls).toEqual([]);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );

    effectIt.effect('keeps matcher exhaustion a typed capacity refusal without changing the attached view', () =>
      Effect.gen(function* () {
        const f = yield* preparedSessionFixture({
          inclusions: ['Main.java', ...EffectArray.replicate(EffectString.repeat(4000)('*') + 'Z', 32)],
        });
        const made = yield* f.create();
        const session = yield* made.result;
        const current = yield* session.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
        const before = made.calls.length;
        expect(
          yield* Effect.flip(
            session.upsert({...current, uri: f.uris['Included.java']}, f.texts['Main.java'], 'java', 1000),
          ),
        ).toMatchObject({_tag: 'LspFault', code: 'capacity'});
        expect(made.calls).toHaveLength(before);
        expect(yield* session.observation(current.uri)).toEqual(current);
        expect(yield* session.available).toBe(true);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );

    effectIt.effect(
      'selects closed Java quickfix text but refuses a versionless owned overlay without disk fallback',
      () =>
        Effect.gen(function* () {
          const f = yield* preparedSessionFixture();
          const range = {start: {line: 0, character: 6}, end: {line: 0, character: 10}};
          const raw = [
            {title: 'Fix Main', kind: 'quickfix', edit: {changes: {[f.uris['Main.java']]: [{range, newText: 'Next'}]}}},
          ];
          for (const disk of [true, false]) {
            const basis: Observation = {
              ...f.basis,
              documentVersion: disk ? null : 1,
              view: {...f.basis.view, kind: disk ? 'disk' : 'overlay'},
            };
            const made = yield* f.create(raw, options => {
              Reflect.set(options, 'basis', basis);
              Reflect.set(options, 'captureEditSource', (uri: string) =>
                Effect.gen(function* () {
                  expect(disk).toBe(true);
                  expect(uri).toBe(f.uris['Main.java']);
                  const text = yield* f.fs.readFileString(f.path.join(f.source, 'Main.java'));
                  return {uri, text, content: sha256HexSync(text), identity: 'controlled-main-identity'};
                }),
              );
            });
            const session = yield* made.result;
            const current = yield* session.upsert(basis, f.texts['Main.java'], 'java', 1000);
            const query = {range, only: ['quickfix']};
            const listed = yield* session.actions(current, query, 1000);
            if (listed.status !== 'ok') return yield* Effect.die('Expected Java action list');
            const choices = yield* Schema.decodeUnknownEffect(Schema.Array(SemanticActionChoice))(listed.items);
            const selected = yield* Effect.exit(session.actions(current, query, 1000, choices[0]));
            if (disk) {
              expect(selected).toMatchObject({
                _tag: 'Success',
                value: {
                  status: 'ok',
                  items: [
                    {
                      operation: 'code-action',
                      qualification: 'qualified-text-only',
                      files: [
                        {
                          beforeText: f.texts['Main.java'],
                          precondition: {sourceKind: 'disk', physicalIdentity: 'controlled-main-identity'},
                        },
                      ],
                    },
                  ],
                },
              });
            } else expect(selected._tag).toBe('Failure');
            expect(
              EffectArray.some(
                made.calls,
                call => call.method === 'codeAction/resolve' || call.method === 'workspace/applyEdit',
              ),
            ).toBe(false);
            expect(yield* f.fs.readFileString(f.path.join(f.source, 'Main.java'))).toBe(f.texts['Main.java']);
          }
        }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );

    effectIt.effect('rejects prepared model drift while a public Java action response is returning', () =>
      Effect.gen(function* () {
        const f = yield* preparedSessionFixture();
        const made = yield* f.create(
          [],
          options => Reflect.set(options, 'captureEditSource', () => Effect.die('No target expected')),
          method =>
            method === 'textDocument/codeAction' ? f.fs.writeFileString(f.metadataFile, 'changed model') : Effect.void,
        );
        const session = yield* made.result;
        const current = yield* session.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
        expect(
          (yield* Effect.exit(
            session.actions(current, {range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}}}, 1000),
          ))._tag,
        ).toBe('Failure');
        expect(yield* session.available).toBe(false);
        expect(yield* f.fs.readFileString(f.path.join(f.source, 'Main.java'))).toBe(f.texts['Main.java']);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );

    effectIt.effect('uses the verified v2 model, accepts compiler key permutations and preserves unsaved text', () =>
      Effect.gen(function* () {
        const f = yield* preparedSessionFixture();
        const location = {
          uri: f.uris['Included.java'],
          range: {start: {line: 0, character: 6}, end: {line: 0, character: 14}},
        };
        const made = yield* f.create([location], options => {
          Reflect.set(options, 'diagnosticModel', {
            ...options.diagnosticModel,
            compilerOptions: EffectRecord.fromEntries(
              EffectArray.reverse(EffectRecord.toEntries(f.prepared.model.compilerOptions)),
            ),
          });
        });
        const session = yield* made.result;
        const current = yield* session.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
        const result = yield* session.query('definition', current, {line: 0, character: 15}, 1000);
        expect(result.status).toBe('ok');
        if (result.status === 'ok') expect(result.items).toEqual([location]);
        const text = 'class Main { Included value; int unsaved; } // élève𐐀\n';
        const next = yield* session.upsert(
          {...current, documentVersion: 2, content: sha256HexSync(text)},
          text,
          'java',
          1000,
        );
        expect((yield* session.diagnostics(next, 1000)).observation).toEqual(next);
        expect(yield* f.fs.readFileString(f.path.join(f.source, 'Main.java'))).toBe(f.texts['Main.java']);
        yield* f.prepared.verify;
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );

    effectIt.effect('refuses every mismatched snapshot basis before initializing the provider', () =>
      Effect.gen(function* () {
        const f = yield* preparedSessionFixture();
        const outside = javaFileUri(yield* f.path.toFileUrl(f.parent));
        for (const [field, value] of [
          ['projectUri', outside],
          ['javaHomeUri', outside],
          ['projectionDigest', EffectString.repeat(64)('0')],
          ['sourceRoots', []],
          ['libraries', [f.uris['Included.java']]],
          ['compilerOptions', undefined],
          ['compilerOptions', {...f.prepared.model.compilerOptions, 'org.eclipse.jdt.core.compiler.source': '25'}],
        ] as const) {
          const made = yield* f.create([], options => {
            Reflect.set(options, 'diagnosticModel', {...options.diagnosticModel, [field]: value});
          });
          expect(yield* Effect.flip(made.result)).toMatchObject({_tag: 'LspFault', code: 'prerequisite'});
          expect(made.calls).toEqual([]);
        }
        for (const field of ['project', 'worktree'] as const) {
          const made = yield* f.create([], options => {
            Reflect.set(options, 'basis', {...options.basis, [field]: outside});
          });
          expect(yield* Effect.flip(made.result)).toMatchObject({code: 'prerequisite'});
          expect(made.calls).toEqual([]);
        }
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );

    effectIt.effect('refuses excluded, non-Java, absent and outside inputs without changing the view or wire', () =>
      Effect.gen(function* () {
        const f = yield* preparedSessionFixture();
        const outside = f.path.join(f.parent, 'Outside.java');
        yield* f.fs.writeFileString(outside, 'class Outside {}\n');
        const made = yield* f.create();
        const session = yield* made.result;
        const current = yield* session.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
        for (const uri of [
          f.uris['Excluded.java'],
          f.uris['Readme.txt'],
          javaFileUri(yield* f.path.toFileUrl(outside)),
          javaFileUri(yield* f.path.toFileUrl(f.path.join(f.source, 'Missing.java'))),
        ]) {
          const before = made.calls.length;
          expect(
            yield* Effect.flip(
              session.upsert({...current, uri, documentVersion: 2}, f.texts['Main.java'], 'java', 1000),
            ),
          ).toMatchObject({_tag: 'SemanticSessionFault', reason: 'invalid'});
          expect(made.calls).toHaveLength(before);
          expect(yield* session.observation(current.uri)).toEqual(current);
          expect(yield* session.observation(uri)).toBeUndefined();
          expect(yield* session.available).toBe(true);
        }
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );

    effectIt.effect('returns the physical canonical observation for an alias without mutating its caller', () =>
      Effect.gen(function* () {
        const f = yield* preparedSessionFixture();
        const alias = f.path.join(f.parent, 'source-alias');
        yield* f.fs.symlink(f.source, alias);
        const uri = javaFileUri(yield* f.path.toFileUrl(f.path.join(alias, 'Main.java')));
        const requested = {...f.basis, uri};
        const original = structuredClone(requested);
        const made = yield* f.create();
        const session = yield* made.result;
        const current = yield* session.upsert(requested, f.texts['Main.java'], 'java', 1000);
        expect(current.uri).toBe(f.uris['Main.java']);
        expect(requested).toEqual(original);
        expect(yield* session.observation(uri)).toBeUndefined();
        expect(yield* session.observation(current.uri)).toEqual(current);
        const open = EffectArray.findFirst(made.calls, call => call.method === 'textDocument/didOpen');
        expect(open).toMatchObject({value: {params: {textDocument: {uri: current.uri}}}});
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );

    // Exhaust the complete finite domain instead of sampling duplicate tuples
    // inside one cumulative property deadline.
    const excludedEditCases = EffectArray.flatMap(['Excluded.java', 'Readme.txt'] as const, excluded =>
      EffectArray.flatMap([0, 1, 2], position =>
        EffectArray.map([false, true], reverse => ({excluded, position, reverse})),
      ),
    );
    for (const representation of ['changes', 'documentChanges'] as const) {
      // Share only immutable project inputs across cases. f.create still gives
      // every operation a fresh session, notification stream and request state.
      const fixtureLayer = Layer.effect(
        PreparedEditFixture,
        Effect.gen(function* () {
          const fixture = yield* preparedSessionFixture();
          return {fixture, digest: yield* semanticTreeDigest(fixture.project)};
        }),
      ).pipe(Layer.provideMerge(Layer.merge(BunServices.layer, cryptoLayer)));
      effectIt.layer(fixtureLayer)(layerIt => {
        layerIt.effect.each(excludedEditCases)(
          `never returns a partial Java edit set when any target is excluded (${representation}, $excluded, position $position, reverse $reverse)`,
          ({excluded, position, reverse}) =>
            Effect.gen(function* () {
              const {fixture: f, digest} = yield* PreparedEditFixture;
              const before = yield* semanticTreeDigest(f.project);
              expect(before).toBe(digest);
              const range = {start: {line: 0, character: 6}, end: {line: 0, character: 10}};
              const safe = reverse ? ['Included.java', 'Main.java'] : ['Main.java', 'Included.java'];
              const targets = [...EffectArray.take(safe, position), excluded, ...EffectArray.drop(safe, position)];
              const edits = [{range, newText: 'Next'}];
              const edit: Schema.Json =
                representation === 'changes'
                  ? {changes: EffectRecord.fromEntries(EffectArray.map(targets, name => [f.uris[name], edits]))}
                  : {
                      documentChanges: EffectArray.map(targets, name => ({
                        textDocument: {uri: f.uris[name], version: null},
                        edits,
                      })),
                    };
              const safeAction = {
                title: 'Safe',
                edit: {changes: {[f.uris['Included.java']]: edits}},
              };
              for (const operation of ['rename', 'code-action'] as const) {
                const response: Schema.Json = operation === 'rename' ? edit : [{title: 'Incomplete', edit}, safeAction];
                const wireBefore = JSON.stringify(response);
                const made = yield* f.create(response);
                const session = yield* made.result;
                const current = yield* session.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
                const result = yield* session.prepare(
                  operation,
                  current,
                  {line: 0, character: 15},
                  operation === 'rename' ? 'Next' : undefined,
                  1000,
                );
                if (operation === 'rename') expect(result.status).toBe('unsupported');
                else {
                  expect(result.status).toBe('ok');
                  if (result.status === 'ok')
                    expect(result.items).toEqual([
                      expect.objectContaining({
                        title: 'Safe',
                        files: [expect.objectContaining({uri: f.uris['Included.java']})],
                      }),
                    ]);
                }
                expect(JSON.stringify(response)).toBe(wireBefore);
                expect(yield* session.available).toBe(true);
                expect(yield* session.observation(current.uri)).toEqual(current);
              }
              expect(yield* semanticTreeDigest(f.project)).toBe(before);
            }),
        );
      });
    }

    effectIt.effect('refuses complete Java edit sets with overlaps, duplicate targets or conflicting versions', () =>
      Effect.gen(function* () {
        const f = yield* preparedSessionFixture();
        const before = yield* semanticTreeDigest(f.project);
        const edit = {range: {start: {line: 0, character: 6}, end: {line: 0, character: 10}}, newText: 'Next'};
        const overlap = {...edit, range: {start: {line: 0, character: 8}, end: {line: 0, character: 12}}};
        const safe = {textDocument: {uri: f.uris['Included.java'], version: null}, edits: [edit]};
        const target = {textDocument: {uri: f.uris['Main.java'], version: null}, edits: [edit]};
        const valid = yield* f.create({documentChanges: [safe, target]});
        const validSession = yield* valid.result;
        const validView = yield* validSession.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
        const complete = yield* validSession.prepare('rename', validView, {line: 0, character: 15}, 'Next', 1000);
        expect(complete.status).toBe('ok');
        if (complete.status === 'ok')
          expect(complete.items).toEqual([
            expect.objectContaining({
              files: expect.arrayContaining([
                expect.objectContaining({uri: f.uris['Included.java']}),
                expect.objectContaining({uri: f.uris['Main.java']}),
              ]),
            }),
          ]);
        const cases: readonly Schema.Json[] = [
          {changes: {[f.uris['Included.java']]: [edit], [f.uris['Main.java']]: [edit, overlap]}},
          {documentChanges: [safe, {...target, edits: [overlap, edit]}]},
          {documentChanges: [safe, target, target]},
          {documentChanges: [safe, {...target, textDocument: {...target.textDocument, version: 42}}]},
        ];
        for (const raw of cases)
          for (const operation of ['rename', 'code-action'] as const) {
            const response = operation === 'rename' ? raw : [{title: 'Conflicting', edit: raw}];
            const original = JSON.stringify(response);
            const made = yield* f.create(response);
            const session = yield* made.result;
            const current = yield* session.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
            expect(
              yield* Effect.flip(
                session.prepare(
                  operation,
                  current,
                  {line: 0, character: 15},
                  operation === 'rename' ? 'Next' : undefined,
                  1000,
                ),
              ),
            ).toMatchObject({_tag: 'SemanticSessionFault', reason: 'invalid'});
            expect(JSON.stringify(response)).toBe(original);
            expect(yield* session.observation(current.uri)).toEqual(current);
            expect(yield* session.available).toBe(true);
          }
        expect(yield* semanticTreeDigest(f.project)).toBe(before);
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );

    effectIt.effect.prop(
      'duplicate Java edits refuse the whole preparation independently of representation and target order',
      [
        Schema.Literals(['changes', 'documentChanges']),
        Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 12})),
        Schema.Boolean,
      ],
      ([representation, start, reverse]) =>
        Effect.gen(function* () {
          const f = yield* preparedSessionFixture();
          const before = yield* semanticTreeDigest(f.project);
          const edit = {
            range: {start: {line: 0, character: start}, end: {line: 0, character: start + 1}},
            newText: 'Next',
          };
          const targets = [
            {textDocument: {uri: f.uris['Included.java'], version: null}, edits: [edit]},
            {textDocument: {uri: f.uris['Main.java'], version: null}, edits: [edit, structuredClone(edit)]},
          ];
          const ordered = reverse ? EffectArray.reverse(targets) : targets;
          const response: Schema.Json =
            representation === 'documentChanges'
              ? {documentChanges: ordered}
              : {
                  changes: EffectRecord.fromEntries(
                    EffectArray.map(ordered, target => [target.textDocument.uri, target.edits]),
                  ),
                };
          const original = JSON.stringify(response);
          const made = yield* f.create(response);
          const session = yield* made.result;
          const current = yield* session.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
          expect(
            yield* Effect.flip(session.prepare('rename', current, {line: 0, character: 15}, 'Next', 1000)),
          ).toMatchObject({
            _tag: 'SemanticSessionFault',
            reason: 'invalid',
          });
          expect(JSON.stringify(response)).toBe(original);
          expect(yield* session.observation(current.uri)).toEqual(current);
          expect(yield* semanticTreeDigest(f.project)).toBe(before);
        }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
      {arbitrary: {runs: 16}},
    );

    effectIt.effect('refuses an entire result or edit when one physical target is logically excluded', () =>
      Effect.gen(function* () {
        const f = yield* preparedSessionFixture();
        const range = {start: {line: 0, character: 6}, end: {line: 0, character: 14}};
        for (const operation of ['definition', 'rename', 'code-action'] as const) {
          const edit = {changes: {[f.uris['Excluded.java']]: [{range, newText: 'Next'}]}};
          const response =
            operation === 'definition'
              ? [
                  {uri: f.uris['Included.java'], range},
                  {uri: f.uris['Excluded.java'], range},
                ]
              : operation === 'rename'
                ? edit
                : [{title: 'Fix', kind: 'quickfix', edit}];
          const made = yield* f.create(response);
          const session = yield* made.result;
          const current = yield* session.upsert(f.basis, f.texts['Main.java'], 'java', 1000);
          const result =
            operation === 'definition'
              ? yield* session.query('definition', current, {line: 0, character: 15}, 1000)
              : yield* session.prepare(
                  operation,
                  current,
                  {line: 0, character: 15},
                  operation === 'rename' ? 'Next' : undefined,
                  1000,
                );
          expect(result.status).toBe('unsupported');
          expect(yield* session.available).toBe(true);
          expect(yield* f.fs.readFileString(f.path.join(f.source, 'Excluded.java'))).toBe(f.texts['Excluded.java']);
        }
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    );
  });

  effectIt.effect.prop(
    'preserves the prospective view model and refuses capacity without changing state or wire history',
    [
      Schema.Array(
        Schema.Struct({
          slot: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 4})),
          units: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 12})),
          supplementary: Schema.Boolean,
        }),
      ).check(Schema.isBetweenLength(1, 16)),
    ],
    ([commands]) =>
      Effect.gen(function* () {
        const f = yield* limitedSession({maxDocuments: 3, maxTextLength: 8, maxTotalTextLength: 12});
        const model = new Map<number, string>();
        for (const [index, command] of commands.entries()) {
          const text = EffectString.repeat(command.units)(command.supplementary ? '𐐀' : 'a');
          const prospective = new Map(model);
          prospective.set(command.slot, text);
          const allowed =
            prospective.size <= 3 &&
            text.length <= 8 &&
            EffectArray.reduce([...prospective.values()], 0, (total, value) => total + value.length) <= 12;
          const before = yield* Effect.forEach([...model.keys()], slot => f.session.observation(f.uri(slot)));
          const noticeCount = f.notices.length,
            requestCount = f.requests.length;
          const result = yield* Effect.exit(f.attach(command.slot, text, index + 1));
          if (allowed) {
            expect((yield* result).content).toBe(sha256HexSync(text));
            model.set(command.slot, text);
          } else {
            expect(yield* Effect.flip(result)).toMatchObject({_tag: 'LspFault', code: 'capacity'});
            expect(f.notices).toHaveLength(noticeCount);
            expect(f.requests).toHaveLength(requestCount);
            expect(yield* Effect.forEach([...model.keys()], slot => f.session.observation(f.uri(slot)))).toEqual(
              before,
            );
            if (!model.has(command.slot)) expect(yield* f.session.observation(f.uri(command.slot))).toBeUndefined();
          }
          for (const [slot, value] of model)
            expect((yield* f.session.observation(f.uri(slot)))?.content).toBe(sha256HexSync(value));
          expect(yield* f.session.available).toBe(true);
        }
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
    {arbitrary: {runs: 32}},
  );

  effectIt.effect('accepts exact limits, reuses replacement capacity and keeps captured policy limits', () =>
    Effect.gen(function* () {
      const limits = {maxDocuments: 2, maxTextLength: 8, maxTotalTextLength: 12};
      const f = yield* limitedSession(limits);
      limits.maxDocuments = 9;
      limits.maxTextLength = 99;
      limits.maxTotalTextLength = 999;
      yield* f.attach(0, 'aaaaaaaa', 1);
      yield* f.attach(1, 'bbbb', 1);
      expect(yield* Effect.flip(f.attach(0, 'aaaaaaaaa', 2))).toMatchObject({code: 'capacity'});
      expect(yield* Effect.flip(f.attach(2, '', 1))).toMatchObject({code: 'capacity'});
      yield* f.attach(0, 'aaaa', 3);
      yield* f.attach(1, 'bbbbbbbb', 2);
      expect(yield* Effect.flip(f.attach(0, 'aaaaa', 4))).toMatchObject({code: 'capacity'});
      expect(yield* f.session.available).toBe(true);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );

  effectIt.effect('retains the shared default text limit when a backend does not select smaller limits', () =>
    Effect.gen(function* () {
      const f = yield* limitedSession();
      const text = EffectString.repeat(2 * 1024 * 1024 + 1)('a');
      expect((yield* f.attach(0, text, 1)).content).toBe(sha256HexSync(text));
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );

  effectIt.effect('refuses invalid host limits before initializing the provider', () =>
    Effect.gen(function* () {
      const f = yield* sharedFixture;
      for (const limits of [
        {maxDocuments: 0, maxTextLength: 8, maxTotalTextLength: 12},
        {maxDocuments: 257, maxTextLength: 8, maxTotalTextLength: 12},
        {maxDocuments: 2, maxTextLength: 0.5, maxTotalTextLength: 12},
        {maxDocuments: 2, maxTextLength: 8, maxTotalTextLength: NaN},
      ]) {
        let initialized = false;
        const native = client(() =>
          Effect.sync(() => {
            initialized = true;
            return {capabilities};
          }),
        );
        expect(
          (yield* Effect.exit(
            makeLspSession(native, {
              basis: f.basis,
              notifications: f.notifications,
              roots: [],
              profile: {},
              ready: Effect.void,
              startupMilliseconds: 1000,
              policy: {...sharedPolicy, documentLimits: limits},
            }),
          ))._tag,
        ).toBe('Failure');
        expect(initialized).toBe(false);
      }
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );

  it('uses Java literal tilde spelling without decoding a physical percent sequence', () => {
    expect(javaFileUri(new URL('file:///project%7E/Main.java'))).toBe('file:///project~/Main.java');
    expect(javaFileUri(new URL('file:///project%257E/Main.java'))).toBe('file:///project%257E/Main.java');
    expect(javaFileUri(new URL('file:///project%25%7E/Main.java'))).toBe('file:///project%25~/Main.java');
  });
  it('preserves decoded file identity and URL input under repeated Java tilde normalization', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', '~', '%', '7', 'E', '?', '#', '[', ']', '|', '^', ' ', 'é', '𐐀'), {
          minLength: 1,
          maxLength: 24,
        }),
        parts => {
          const name = EffectArray.join(parts, '');
          const url = new URL(
            'file:///source/' + EffectString.replaceAll('~', '%7E')(encodeURIComponent(name)) + '.java',
          );
          const before = url.href;
          const uri = javaFileUri(url);
          expect(decodeURIComponent(new URL(uri).pathname)).toBe('/source/' + name + '.java');
          expect(javaFileUri(new URL(uri))).toBe(uri);
          expect(url.href).toBe(before);
        },
      ),
      {numRuns: 32},
    );
  });
  effectIt.effect('uses Java tilde spelling for project, SDK, source and library snapshot identities', () =>
    Effect.gen(function* () {
      const selected = yield* makeJavaDiagnosticModel({
        project: '/private/projection~',
        javaHome: '/sdk/java21~',
        sourceRoots: ['/project/source~'],
        libraries: ['/cache/dependency~.jar'],
      });
      expect(selected).toMatchObject({
        projectUri: 'file:///private/projection~/',
        javaHomeUri: 'file:///sdk/java21~/',
        sourceRoots: ['file:///project/source~/'],
        libraries: ['file:///cache/dependency~.jar'],
      });
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  it('binds full projection metadata and refuses missing, unsolicited or changed model evidence', () => {
    const projection = projectionImage();
    const selected = {
      ...model,
      compilerOptions: report().model.compilerOptions,
      projectionDigest: javaProjectionDigest(projection),
    };
    const raw = {...report(), model: {...report().model, projection}};
    expect(readJavaDiagnosticReport(raw, request, selected)).toEqual(raw.diagnostics);
    expect(() => readJavaDiagnosticReport(report(), request, selected)).toThrow();
    expect(() => readJavaDiagnosticReport(raw, request, model)).toThrow();
    expect(() =>
      readJavaDiagnosticReport(raw, request, {...model, projectionDigest: selected.projectionDigest}),
    ).toThrow();
    const changed = (value: typeof JavaProjectionImage.Type) => ({...raw, model: {...raw.model, projection: value}});
    const withoutAttachment = structuredClone(projection);
    Reflect.deleteProperty(withoutAttachment.resolvedClasspath[0], 'sourceAttachmentPath');
    for (const value of [
      {...projection, outputPath: projection.outputPath + '-changed'},
      {...projection, resolvedClasspath: [...projection.resolvedClasspath].reverse()},
      {
        ...projection,
        rawClasspath: EffectArray.map(projection.rawClasspath, entry => ({...entry, exported: !entry.exported})),
      },
      {
        ...projection,
        rawClasspath: EffectArray.map(projection.rawClasspath, entry => ({
          ...entry,
          combineAccessRules: !entry.combineAccessRules,
        })),
      },
      {
        ...projection,
        rawClasspath: EffectArray.map(projection.rawClasspath, entry => ({
          ...entry,
          accessRules: [...entry.accessRules].reverse(),
        })),
      },
      {
        ...projection,
        rawClasspath: EffectArray.map(projection.rawClasspath, entry => ({
          ...entry,
          attributes: [...entry.attributes].reverse(),
        })),
      },
      {...projection, rawClasspath: EffectArray.map(projection.rawClasspath, entry => ({...entry, accessRules: []}))},
      {...projection, rawClasspath: EffectArray.map(projection.rawClasspath, entry => ({...entry, exclusions: []}))},
      {
        ...projection,
        rawClasspath: EffectArray.map(projection.rawClasspath, entry => ({
          ...entry,
          outputPath: '/threadnote-java/output-2',
        })),
      },
      withoutAttachment,
      {...projection, links: [{...projection.links[0], uri: 'file:///different/src'}]},
      {...projection, resourceFilters: []},
    ])
      expect(() => readJavaDiagnosticReport(changed(value), request, selected)).toThrow();
  });
  it('frames projection fields deterministically without changing semantic array order or caller objects', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'é', '𐐀', '😀', ':', '[', ']', ';', '0'), {maxLength: 32}),
        characters => {
          const projection = {...projectionImage(), outputPath: '/threadnote-java/' + EffectArray.join(characters, '')};
          const before = JSON.stringify(projection);
          const reordered = {
            resourceFilters: projection.resourceFilters,
            links: projection.links,
            resolvedClasspath: projection.resolvedClasspath,
            rawClasspath: projection.rawClasspath,
            outputPath: projection.outputPath,
            projectCharset: projection.projectCharset,
            format: projection.format,
          };
          expect(javaProjectionDigest(reordered)).toBe(javaProjectionDigest(projection));
          expect(javaProjectionDigest({...projection, outputPath: projection.outputPath + ':'})).not.toBe(
            javaProjectionDigest(projection),
          );
          expect(JSON.stringify(projection)).toBe(before);
        },
      ),
      {numRuns: 32},
    );
  });
  effectIt.effect('retains the admitted projection identity when caller aliases change during verification', () =>
    Effect.gen(function* () {
      for (const kind of ['diagnostics', 'type-definition'] as const) {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const projection = projectionImage();
        const digest = javaProjectionDigest(projection);
        const selected: JavaDiagnosticModel = {
          ...model,
          compilerOptions: report().model.compilerOptions,
          projectionDigest: digest,
        };
        const raw = kind === 'diagnostics' ? report() : typeReport();
        const observed = {...raw, model: {...raw.model, projection}};
        const native = client((method, params) =>
          Effect.sync(() => {
            expect(method).toBe('workspace/executeCommand');
            expect(params).toMatchObject({arguments: [{projectionDigest: digest}]});
            return observed;
          }),
        );
        const verify = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
        const query =
          kind === 'diagnostics'
            ? requestJavaDiagnostics(native, selected, verify)(request, 1000).pipe(Effect.asVoid)
            : requestJavaTypeDefinition(native, selected, verify)(request, typePosition, 1000).pipe(Effect.asVoid);
        const querying = yield* Effect.forkChild(query);
        yield* Deferred.await(entered);
        Reflect.set(selected, 'projectionDigest', EffectString.repeat(64)('b'));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(querying);
      }
    }),
  );
  effectIt.effect('retains the admitted compiler basis when caller aliases change during verification', () =>
    Effect.gen(function* () {
      for (const kind of ['diagnostics', 'type-definition'] as const) {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const compilerOptions = {
          ...report().model.compilerOptions,
          'org.eclipse.jdt.core.compiler.problem.unusedImport': 'error',
        };
        const selected: JavaDiagnosticModel = {...model, sourceRoots: [...model.sourceRoots], compilerOptions};
        const raw = kind === 'diagnostics' ? report() : typeReport();
        const observed = {...raw, model: {...raw.model, compilerOptions: {...compilerOptions}}};
        const native = client((method, params) =>
          Effect.sync(() => {
            expect(method).toBe('workspace/executeCommand');
            expect(params).toMatchObject({arguments: [{...model, compilerOptions: observed.model.compilerOptions}]});
            return observed;
          }),
        );
        const verify = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
        const query =
          kind === 'diagnostics'
            ? requestJavaDiagnostics(native, selected, verify)(request, 1000).pipe(Effect.asVoid)
            : requestJavaTypeDefinition(native, selected, verify)(request, typePosition, 1000).pipe(Effect.asVoid);
        const querying = yield* Effect.forkChild(query);
        yield* Deferred.await(entered);
        Reflect.deleteProperty(selected, 'compilerOptions');
        Reflect.set(selected, 'sourceRoots', ['file:///different/root']);
        compilerOptions['org.eclipse.jdt.core.compiler.problem.unusedImport'] = 'ignore';
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(querying);
      }
    }),
  );
  effectIt.effect('refuses an oversized aggregate compiler basis before path work', () =>
    Effect.gen(function* () {
      const compilerOptions: Record<string, string> = {...report().model.compilerOptions};
      for (let index = 0; index < 20; index++)
        compilerOptions['org.eclipse.jdt.core.compiler.problem.fixture' + index] = EffectString.repeat(8192)('a');
      expect(
        (yield* Effect.exit(
          makeJavaDiagnosticModel({
            project: '/private/projection',
            javaHome: '/sdk/java21',
            sourceRoots: ['/project/src'],
            libraries: [],
            compilerOptions,
          }),
        ))._tag,
      ).toBe('Failure');
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  it('binds every supplied compiler option independently of object-key order', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/u), fc.constantFrom('error', 'warning', 'ignore', ''), {
          minKeys: 1,
          maxKeys: 8,
        }),
        options => {
          const extras = EffectArray.map(
            EffectRecord.toEntries(options),
            ([key, value]) => ['org.eclipse.jdt.core.compiler.problem.' + key, value] as const,
          );
          const expected: Record<string, string> = {
            ...report().model.compilerOptions,
            ...EffectRecord.fromEntries(extras),
          };
          const selected = {...model, compilerOptions: expected};
          const observed = {...report(), model: {...report().model, compilerOptions: {...expected}}};
          const before = JSON.stringify([observed, selected]);
          expect(readJavaDiagnosticReport(observed, request, selected)).toEqual(observed.diagnostics);
          expect(
            readJavaDiagnosticReport(observed, request, {
              ...selected,
              compilerOptions: EffectRecord.fromEntries(EffectRecord.toEntries(expected).reverse()),
            }),
          ).toEqual(observed.diagnostics);
          const [key, value] = extras[0];
          const changed = {...observed, model: {...observed.model, compilerOptions: {...expected, [key]: value + 'x'}}};
          expect(() => readJavaDiagnosticReport(changed, request, selected)).toThrow();
          const missing = {...expected};
          delete missing[key];
          expect(() =>
            readJavaDiagnosticReport(
              {...observed, model: {...observed.model, compilerOptions: missing}},
              request,
              selected,
            ),
          ).toThrow();
          expect(JSON.stringify([observed, selected])).toBe(before);
        },
      ),
      {numRuns: 32},
    );
  });
  effectIt.effect('captures and sends the complete prepared compiler basis through the fixed snapshot command', () =>
    Effect.gen(function* () {
      const compilerOptions = {
        ...report().model.compilerOptions,
        'org.eclipse.jdt.core.compiler.problem.unusedImport': 'error',
      };
      const selected = yield* makeJavaDiagnosticModel({
        project: '/private/projection',
        javaHome: '/sdk/java21',
        sourceRoots: ['/project/src'],
        libraries: ['/cache/dependency.jar'],
        compilerOptions,
      });
      compilerOptions['org.eclipse.jdt.core.compiler.problem.unusedImport'] = 'ignore';
      const observed = {
        ...report(),
        model: {...report().model, ...selected, annotationProcessing: 'disabled-for-snapshot'},
      };
      const native = client((method, params) =>
        Effect.sync(() => {
          expect(method).toBe('workspace/executeCommand');
          expect(params).toMatchObject({arguments: [{compilerOptions: selected.compilerOptions}]});
          expect(selected.compilerOptions?.['org.eclipse.jdt.core.compiler.problem.unusedImport']).toBe('error');
          return observed;
        }),
      );
      expect(yield* requestJavaDiagnostics(native, selected, Effect.void)(request, 1000)).toEqual(observed.diagnostics);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  it('round-trips well-formed Unicode type snapshots without mutation and rejects replay against changed text', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', 'é', '😀', '\r', '\n', '\t'), {maxLength: 30}), characters => {
        const prefix = '/*' + EffectArray.join(characters, '') + '*/\n';
        const text = prefix + 'class Main {}\n';
        const line = EffectString.split(/\r\n|\r|\n/u)(prefix).length - 1;
        const position = {line, character: 7};
        const captured = {
          ...request,
          target: {...request.target, text},
          inputs: EffectArray.map(request.inputs, input =>
            input.uri === request.target.uri ? {...input, text} : input,
          ),
        };
        const raw = {
          ...typeReport(),
          contentSha256: sha256HexSync(text),
          utf16Length: text.length,
          position,
          inputs: EffectArray.map(captured.inputs, input => ({
            uri: input.uri,
            contentSha256: sha256HexSync(input.text),
            utf16Length: input.text.length,
          })),
          typeDefinition: {
            status: 'source',
            location: {
              uri: captured.target.uri,
              range: {start: {line, character: 6}, end: {line, character: 10}},
              contentSha256: sha256HexSync(text),
              utf16Length: text.length,
            },
          },
        };
        const before = JSON.stringify([raw, captured]);
        const read = readJavaTypeDefinitionReport(raw, captured, model, position);
        expect(read).toEqual(raw.typeDefinition);
        if (read.status === 'source')
          Reflect.set(read.location.range.start, 'character', read.location.range.start.character + 1);
        expect(JSON.stringify([raw, captured])).toBe(before);
        const changed = {
          ...captured,
          target: {...captured.target, text: text + ' '},
          inputs: EffectArray.map(captured.inputs, input =>
            input.uri === captured.target.uri ? {...input, text: text + ' '} : input,
          ),
        };
        expect(() => readJavaTypeDefinitionReport(raw, changed, model, position)).toThrow();
      }),
      {numRuns: 32},
    );
  });
  it('binds source-type and explicit unsupported reports to the complete source/model and requested cursor', () => {
    const raw = typeReport();
    expect(readJavaTypeDefinitionReport(raw, request, model, typePosition)).toEqual(raw.typeDefinition);
    expect(
      readJavaTypeDefinitionReport(
        {...raw, typeDefinition: {status: 'unsupported', reason: 'binary-type'}},
        request,
        model,
        typePosition,
      ),
    ).toEqual({status: 'unsupported', reason: 'binary-type'});
    for (const wrong of [
      {...raw, position: {line: 0, character: 8}},
      {...raw, requestToken: 'older'},
      {...raw, inputs: [...raw.inputs].reverse()},
      {...raw, diagnostics: []},
    ])
      expect(() => readJavaTypeDefinitionReport(wrong, request, model, typePosition)).toThrow();
  });
  effectIt.effect('emits only the fixed type-definition command and retains verification and request identity', () =>
    Effect.gen(function* () {
      let checks = 0;
      const native = client((method, params) =>
        Effect.sync(() => {
          expect(method).toBe('workspace/executeCommand');
          expect(params).toMatchObject({
            command: javaTypeDefinitionCommand,
            arguments: [{requestToken: request.requestToken, position: typePosition}],
          });
          expect(checks).toBe(1);
          return typeReport();
        }),
      );
      const result = yield* requestJavaTypeDefinition(
        native,
        model,
        Effect.sync(() => {
          checks++;
        }),
      )(request, typePosition, 1000);
      expect(result).toEqual(typeReport().typeDefinition);
      expect(checks).toBe(2);
    }),
  );
  effectIt.effect('captures type-definition from the single session view without using the native nullable route', () =>
    Effect.gen(function* () {
      const f = yield* sharedFixture;
      const tokens: string[] = [];
      const native = client(method =>
        Effect.succeed(method === 'initialize' ? {capabilities: {...capabilities, typeDefinitionProvider: true}} : []),
      );
      const session = yield* makeLspSession(native, {
        basis: f.basis,
        notifications: f.notifications,
        roots: [],
        profile: {},
        ready: Effect.void,
        startupMilliseconds: 1000,
        policy: {
          ...sharedPolicy,
          requestTypeDefinition: (snapshot, position) =>
            Effect.sync(() => {
              expect(Object.isFrozen(snapshot)).toBe(true);
              expect(Object.isFrozen(snapshot.target)).toBe(true);
              expect(Object.isFrozen(snapshot.inputs)).toBe(true);
              expect(Object.isFrozen(position)).toBe(true);
              expect(snapshot.inputs).toEqual([{uri: f.uri, text: f.text}]);
              tokens.push(snapshot.requestToken);
              return [];
            }),
        },
      });
      const current = yield* session.upsert(f.basis, f.text, 'java', 1000);
      expect((yield* session.query('type-definition', current, typePosition, 1000)).status).toBe('ok');
      expect((yield* session.query('type-definition', current, typePosition, 1000)).status).toBe('ok');
      expect(new Set(tokens).size).toBe(2);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('refuses a delayed type-definition snapshot after a shared-view update', () =>
    Effect.gen(function* () {
      const f = yield* sharedFixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const native = client(method =>
        Effect.succeed(method === 'initialize' ? {capabilities: {...capabilities, typeDefinitionProvider: true}} : []),
      );
      const session = yield* makeLspSession(native, {
        basis: f.basis,
        notifications: f.notifications,
        roots: [],
        profile: {},
        ready: Effect.void,
        startupMilliseconds: 1000,
        policy: {
          ...sharedPolicy,
          requestTypeDefinition: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as([])),
        },
      });
      const current = yield* session.upsert(f.basis, f.text, 'java', 1000);
      const pending = yield* Effect.forkChild(session.query('type-definition', current, typePosition, 1000));
      yield* Deferred.await(entered);
      const changed = 'class Next {}\n';
      yield* session.upsert({...current, content: sha256HexSync(changed), documentVersion: 2}, changed, 'java', 1000);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(pending)).status).toBe('stale');
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  effectIt.effect('distinguishes directory identities from files and preserves ordered path identities', () =>
    Effect.gen(function* () {
      const f = yield* sharedFixture;
      const jar = f.path.join(f.directory, 'dependency & unicode é.jar');
      const root = f.path.join(f.directory, 'source & unicode é');
      const identity = yield* makeJavaDiagnosticModel({
        project: f.directory,
        javaHome: f.directory,
        sourceRoots: [root, f.directory],
        libraries: [jar],
      });
      expect(EffectString.endsWith('/')(identity.projectUri)).toBe(true);
      expect(EffectString.endsWith('/')(identity.javaHomeUri)).toBe(true);
      expect(EffectString.endsWith('/')(identity.sourceRoots[0])).toBe(true);
      expect(EffectString.endsWith('.jar')(identity.libraries[0])).toBe(true);
      expect(f.path.resolve(yield* f.path.fromFileUrl(new URL(identity.sourceRoots[0])))).toBe(root);
      expect(f.path.resolve(yield* f.path.fromFileUrl(new URL(identity.sourceRoots[1])))).toBe(f.directory);
      expect(yield* f.path.fromFileUrl(new URL(identity.libraries[0]))).toBe(jar);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
  it('accepts only the exact request and complete independently observed source/model inventory', () => {
    const native = report();
    const result = readJavaDiagnosticReport(native, request, model);
    expect(result).toEqual([diagnostic]);
    native.diagnostics[0].data.arguments[0] = 'caller changed input';
    expect(result[0].data.arguments).toEqual(['Main']);
  });

  it('rejects every authority-field mutation and missing/duplicate inputs', () => {
    const variants = [
      (r: ReturnType<typeof report>) => {
        r.requestToken += 'old';
      },
      (r: ReturnType<typeof report>) => {
        r.uri = request.inputs[1].uri;
      },
      (r: ReturnType<typeof report>) => {
        r.contentSha256 = sha256HexSync('different');
      },
      (r: ReturnType<typeof report>) => {
        r.utf16Length++;
      },
      (r: ReturnType<typeof report>) => {
        r.model.projectUri += '-different';
      },
      (r: ReturnType<typeof report>) => {
        r.model.javaHomeUri += '-different';
      },
      (r: ReturnType<typeof report>) => {
        r.model.sourceRoots = [];
      },
      (r: ReturnType<typeof report>) => {
        r.model.libraries = [];
      },
      (r: ReturnType<typeof report>) => {
        r.inputs.pop();
      },
      (r: ReturnType<typeof report>) => {
        r.inputs[1] = r.inputs[0];
      },
      (r: ReturnType<typeof report>) => {
        r.inputs[1].contentSha256 = sha256HexSync('changed dependency');
      },
      (r: ReturnType<typeof report>) => {
        r.inputs[1].utf16Length++;
      },
    ];
    for (const change of variants) {
      const native = report();
      change(native);
      expect(() => readJavaDiagnosticReport(native, request, model)).toThrow();
    }
  });

  it('rejects unobserved version claims and invalid UTF-16 positions or messages', () => {
    expect(() => readJavaDiagnosticReport({...report(), observedVersion: 1}, request, model)).toThrow();
    for (const item of [
      {...diagnostic, range: {start: {line: 2, character: 0}, end: {line: 2, character: 1}}},
      {...diagnostic, range: {start: {line: 0, character: 5}, end: {line: 0, character: 0}}},
      {...diagnostic, message: '\ud800'},
    ])
      expect(() => readJavaDiagnosticReport({...report(), diagnostics: [item]}, request, model)).toThrow();
  });

  it('ignores JSON key order while retaining source order and input nonmutation', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(
          ['protocolVersion', 'requestToken', 'uri', 'contentSha256', 'utf16Length', 'model', 'inputs', 'diagnostics'],
          {minLength: 8, maxLength: 8},
        ),
        keys => {
          const native = report();
          const before = JSON.stringify(native);
          const reordered = EffectRecord.fromEntries(
            EffectArray.map(keys, key => [key, Reflect.get(native, key)] as const),
          );
          expect(readJavaDiagnosticReport(reordered, request, model)).toEqual([diagnostic]);
          expect(JSON.stringify(native)).toBe(before);
          expect(() =>
            readJavaDiagnosticReport({...native, inputs: [...native.inputs].reverse()}, request, model),
          ).toThrow();
        },
      ),
      {numRuns: 32},
    );
  });

  effectIt.effect('uses one fixed private command and verifies the source basis before and after its result', () =>
    Effect.gen(function* () {
      let checks = 0;
      let calls = 0;
      const api = client((method, params) =>
        Effect.sync(() => {
          calls++;
          expect(method).toBe('workspace/executeCommand');
          expect(params).toEqual({
            command: javaDiagnosticBundle.command,
            arguments: [
              {
                protocolVersion: 1,
                requestToken: request.requestToken,
                uri: request.target.uri,
                ...model,
                inputs: report().inputs,
              },
            ],
          });
          return report();
        }),
      );
      const diagnostics = yield* requestJavaDiagnostics(
        api,
        model,
        Effect.sync(() => {
          checks++;
        }),
      )(request, 1000);
      expect(diagnostics).toEqual([diagnostic]);
      expect(calls).toBe(1);
      expect(checks).toBe(2);
    }),
  );

  effectIt.effect('refuses a changed basis after the provider responds', () =>
    Effect.gen(function* () {
      let checks = 0;
      const verify = Effect.suspend(() => (++checks === 1 ? Effect.void : Effect.fail('basis changed')));
      const result = yield* Effect.exit(
        requestJavaDiagnostics(
          client(() => Effect.succeed(report())),
          model,
          verify,
        )(request, 1000),
      );
      expect(result._tag).toBe('Failure');
      expect(checks).toBe(2);
    }),
  );

  effectIt.effect('rechecks rejected compiler reads and preserves errors only while the basis remains current', () =>
    Effect.gen(function* () {
      for (const operation of ['diagnostics', 'type-definition'] as const) {
        for (const changed of [false, true]) {
          let checks = 0;
          const verify = Effect.suspend(() => (++checks === 2 && changed ? Effect.fail('basis changed') : Effect.void));
          const api = client(() => LspFault.make({code: 'rejected'}));
          const read: Effect.Effect<unknown, unknown> =
            operation === 'diagnostics'
              ? requestJavaDiagnostics(api, model, verify)(request, 1000)
              : requestJavaTypeDefinition(api, model, verify)(request, {line: 0, character: 6}, 1000);
          expect(yield* Effect.flip(read)).toEqual(changed ? 'basis changed' : LspFault.make({code: 'rejected'}));
          expect(checks).toBe(2);
        }
      }
    }),
  );

  effectIt.effect('includes rejected compiler read postflight in the same interruptible deadline', () =>
    Effect.gen(function* () {
      let checks = 0;
      const entered = yield* Deferred.make<void>();
      const verify = Effect.suspend(() =>
        ++checks === 1 ? Effect.void : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const reading = yield* Effect.forkChild(
        requestJavaDiagnostics(
          client(() => LspFault.make({code: 'rejected'})),
          model,
          verify,
        )(request, 1000),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(1001);
      expect(yield* Effect.flip(Fiber.join(reading))).toMatchObject({_tag: 'LspFault', code: 'timeout'});
    }),
  );

  effectIt.effect('bounds the whole verification/request lifetime and interrupts a canceled report', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const api = client(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(interrupted, undefined)),
        ),
      );
      const fiber = yield* Effect.forkChild(
        Effect.exit(requestJavaDiagnostics(api, model, Effect.void)(request, 1000)),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(1001);
      expect((yield* Fiber.join(fiber))._tag).toBe('Failure');
      yield* Deferred.await(interrupted);
    }),
  );

  effectIt.effect(
    'captures readiness before initialize completes and uses only validated direct reports for code actions',
    () =>
      Effect.gen(function* () {
        const f = yield* sharedFixture;
        const ready = yield* Deferred.make<void>();
        let action: unknown;
        let deliveries = 0;
        const native = client((method, params) =>
          Effect.sync(() => {
            if (method === 'initialize') {
              expect(params).toMatchObject({rootUri: 'file:///private/java-project'});
              f.notifications.receive('language/status', {type: 'ServiceReady'});
              return {capabilities};
            }
            if (method === 'textDocument/codeAction') action = params;
            return [];
          }),
        );
        const session = yield* makeLspSession(native, {
          basis: f.basis,
          notifications: f.notifications,
          roots: [],
          profile: {},
          ready: Deferred.await(ready),
          startupMilliseconds: 1000,
          policy: {
            ...sharedPolicy,
            initializationRoot: 'file:///private/java-project',
            receive: (method, params) => {
              deliveries++;
              if (
                method === 'language/status' &&
                Schema.is(Schema.Struct({type: Schema.Literal('ServiceReady')}))(params)
              )
                Deferred.doneUnsafe(ready, Effect.void);
            },
            requestDiagnostics: snapshot =>
              Effect.sync(() => {
                expect(Object.isFrozen(snapshot.inputs)).toBe(true);
                expect(snapshot.inputs).toEqual([{uri: f.uri, text: f.text}]);
                return [diagnostic];
              }),
          },
        });
        expect(deliveries).toBe(1);
        f.notifications.receive('language/status', {type: 'ServiceReady'});
        expect(deliveries).toBe(2);
        const current = yield* session.upsert(f.basis, f.text, 'java', 1000);
        f.notifications.receive('textDocument/publishDiagnostics', {uri: f.uri, version: 1, diagnostics: [diagnostic]});
        yield* session.prepare('code-action', current, {line: 0, character: 1}, undefined, 1000);
        expect(action).toMatchObject({context: {diagnostics: []}});
        expect((yield* session.diagnostics(current, 1000)).added).toHaveLength(1);
        yield* session.prepare('code-action', current, {line: 0, character: 1}, undefined, 1000);
        expect(action).toMatchObject({context: {diagnostics: [diagnostic]}});
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );

  effectIt.effect(
    'rejects delayed direct reports after a dependency-only no-op mutation advances the shared view',
    () =>
      Effect.gen(function* () {
        const f = yield* sharedFixture;
        const dependencyUri = (yield* f.path.toFileUrl(f.path.join(f.directory, 'Other.java'))).href;
        const dependencyText = 'class Other {}\n';
        yield* f.fs.writeFileString(f.path.join(f.directory, 'Other.java'), dependencyText);
        const entered = yield* Deferred.make<void>();
        const response = yield* Deferred.make<readonly Schema.Json[]>();
        const session = yield* makeLspSession(
          client(method => Effect.succeed(method === 'initialize' ? {capabilities} : [])),
          {
            basis: f.basis,
            notifications: f.notifications,
            roots: [],
            profile: {},
            ready: Effect.void,
            startupMilliseconds: 1000,
            policy: {
              ...sharedPolicy,
              requestDiagnostics: snapshot => {
                expect(snapshot.inputs).toHaveLength(2);
                return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(response)));
              },
            },
          },
        );
        yield* session.upsert(f.basis, f.text, 'java', 1000);
        const dependency = {...f.basis, uri: dependencyUri, content: sha256HexSync(dependencyText)};
        yield* session.upsert(dependency, dependencyText, 'java', 1000);
        const current = yield* session.observation(f.uri);
        expect(current).toBeDefined();
        const pending = yield* Effect.forkChild(Effect.exit(session.diagnostics(current!, 1000)));
        yield* Deferred.await(entered);
        yield* session.upsert({...dependency, documentVersion: 2}, dependencyText, 'java', 1000);
        yield* Deferred.succeed(response, [diagnostic]);
        expect((yield* Fiber.join(pending))._tag).toBe('Failure');
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );

  effectIt.effect('refuses the session when the exact diagnostic extension command is missing', () =>
    Effect.gen(function* () {
      const f = yield* sharedFixture;
      let notifications = 0;
      const native = {
        ...client(() => Effect.succeed({capabilities: {...capabilities, executeCommandProvider: {commands: []}}})),
        notify: () =>
          Effect.sync(() => {
            notifications++;
          }),
      };
      expect(
        (yield* Effect.exit(
          makeLspSession(native, {
            basis: f.basis,
            notifications: f.notifications,
            roots: [],
            profile: {},
            ready: Effect.void,
            startupMilliseconds: 1000,
            policy: sharedPolicy,
          }),
        ))._tag,
      ).toBe('Failure');
      expect(notifications).toBe(0);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );

  effectIt.effect('materializes exact embedded bytes privately and rejects later tampering', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-bundle-'}));
      const bundle = yield* materializeJavaDiagnosticBundle(directory);
      expect(sha256HexSync(yield* fs.readFile(bundle.file))).toBe(javaDiagnosticBundle.jarSha256);
      expect((yield* materializeJavaDiagnosticBundle(directory)).file).toBe(bundle.file);
      yield* fs.chmod(bundle.file, 0o600);
      yield* fs.writeFileString(bundle.file, 'changed');
      expect((yield* Effect.exit(bundle.verify))._tag).toBe('Failure');
      expect((yield* Effect.exit(materializeJavaDiagnosticBundle(directory)))._tag).toBe('Failure');
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );

  effectIt.effect('rejects a relative materialization directory before writing any bundle', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-relative-'}));
      const relative = path.relative(path.resolve('.'), directory);
      expect(path.isAbsolute(relative)).toBe(false);
      expect((yield* Effect.exit(materializeJavaDiagnosticBundle(relative)))._tag).toBe('Failure');
      expect(yield* fs.readDirectory(directory)).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );

  effectIt.effect('binds embedded classes, metadata and build provenance to the exact checked-in sources', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL('../../../../', import.meta.url));
      const bytes = jarBytes();
      expect(sha256HexSync(bytes)).toBe(javaDiagnosticBundle.jarSha256);
      const entries = unzipSync(bytes);
      expect(EffectRecord.keys<string, Uint8Array>(entries).sort()).toEqual(
        [
          'META-INF/LICENSE',
          'META-INF/MANIFEST.MF',
          'dev/threadnote/semantic/DiagnosticSnapshot$Input.class',
          'dev/threadnote/semantic/DiagnosticSnapshot$Model.class',
          'dev/threadnote/semantic/DiagnosticSnapshot.class',
          'dev/threadnote/semantic/PreparedProjectModel$1.class',
          'dev/threadnote/semantic/PreparedProjectModel.class',
          'dev/threadnote/semantic/PreparedProjectModel$Host.class',
          'dev/threadnote/semantic/PreparedProjectModel$PassiveProjection.class',
          'dev/threadnote/semantic/PreparedProjectModel$Budget.class',
          'dev/threadnote/semantic/PreparedProjectModel$CacheImage.class',
          'dev/threadnote/semantic/PreparedProjectModel$GradleSetup.class',
          'dev/threadnote/semantic/PreparedProjectModel$ImportAttempt$State.class',
          'dev/threadnote/semantic/PreparedProjectModel$ImportAttempt.class',
          'dev/threadnote/semantic/PreparedProjectModel$StatusImage.class',
          'dev/threadnote/semantic/PreparedProjectModel$Unsupported.class',
          'dev/threadnote/semantic/TypeDefinitionSnapshot.class',
          'dev/threadnote/semantic/TypeDefinitionSnapshot$Result.class',
          'dev/threadnote/semantic/TypeDefinitionSnapshot$SourceImage.class',
          'plugin.xml',
        ].sort(),
      );
      for (const [name, content] of EffectRecord.toEntries(entries))
        if (EffectString.endsWith('.class')(name)) {
          expect(Array.from(content.slice(0, 4))).toEqual([0xca, 0xfe, 0xba, 0xbe]);
          expect(content[6] * 256 + content[7]).toBe(65);
        }
      const resources = [
        'apps/threadnote/src/semantic/providers/java-diagnostics/src/dev/threadnote/semantic/DiagnosticSnapshot.java',
        'apps/threadnote/src/semantic/providers/java-diagnostics/META-INF/MANIFEST.MF',
        'apps/threadnote/src/semantic/providers/java-diagnostics/plugin.xml',
        'apps/threadnote/tools/semantic/build-java-diagnostics.ts',
        'tools/semantic/build-java-diagnostics.ts',
        '.prettierrc.json',
        'LICENSE',
        'apps/threadnote/src/semantic/providers/java-diagnostics/src/dev/threadnote/semantic/TypeDefinitionSnapshot.java',
        'apps/threadnote/src/semantic/providers/java-diagnostics/src/dev/threadnote/semantic/PreparedProjectModel.java',
      ];
      expect(EffectRecord.keys(javaDiagnosticBundle.provenance.sourceDigests).sort()).toEqual([...resources].sort());
      for (const [relative, digest] of EffectRecord.toEntries(javaDiagnosticBundle.provenance.sourceDigests))
        expect(sha256HexSync(yield* fs.readFile(path.join(root, relative)))).toBe(digest);
      expect(Array.from(entries['META-INF/LICENSE'])).toEqual(
        Array.from(yield* fs.readFile(path.join(root, 'LICENSE'))),
      );
      expect(Array.from(entries['META-INF/MANIFEST.MF'])).toEqual(
        Array.from(yield* fs.readFile(path.join(root, resources[1]))),
      );
      expect(Array.from(entries['plugin.xml'])).toEqual(Array.from(yield* fs.readFile(path.join(root, resources[2]))));
    }).pipe(Effect.provide(Layer.merge(BunServices.layer, cryptoLayer))),
  );
});

const analysisFixture = Effect.fn('test.javaAnalysisFixture')(function* () {
  const f = yield* preparedSessionFixture();
  const events: string[] = [];
  const control = {failInitialization: false};
  let runtimeVerifications = 0;
  const verify = Effect.sync((): undefined => {
    runtimeVerifications++;
  });
  const stop = {code: 0, drained: true, forced: false, stdioClosed: true, fault: undefined};
  let stopped = false;
  const finish = Effect.sync(() => {
    if (!stopped) events.push('finish');
    stopped = true;
    return stop;
  });
  const wire: lsp.LspWire = {
    pid: 123,
    messages: Stream.never,
    failure: () => undefined,
    beginClosing: Effect.void,
    send: () => Effect.void,
    finish,
  };
  const runtimeSpy = vi.spyOn(javaRuntime, 'makeJavaRuntime').mockReturnValue(
    Effect.succeed({
      verify,
      identity: sha256HexSync('controlled SDK boundary'),
      projectJavaHome: f.javaHome,
      preparation: () => Effect.fail(LspFault.make({code: 'rejected'})),
      analysis: options =>
        Effect.gen(function* () {
          events.push('spawn');
          yield* options.workspace.hold;
          yield* Effect.addFinalizer(() => finish.pipe(Effect.flatMap(options.workspace.confirmDrained), Effect.orDie));
          return {wire, directory: options.workspace.directory, verify};
        }),
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => runtimeSpy.mockRestore()));
  const clientSpy = vi.spyOn(lsp, 'makeLspClient').mockImplementation((_wire, receive) =>
    Effect.succeed({
      pid: wire.pid,
      request: method =>
        Effect.gen(function* () {
          events.push(method);
          if (method === 'initialize') {
            if (control.failInitialization) return yield* LspFault.make({code: 'protocol'});
            receive?.('language/status', {type: 'ServiceReady'});
            return {
              serverInfo: {name: 'JDT Language Server (Standard)', version: '1.63.0-SNAPSHOT'},
              capabilities: {
                definitionProvider: true,
                referencesProvider: true,
                documentSymbolProvider: true,
                renameProvider: true,
                codeActionProvider: true,
                typeDefinitionProvider: true,
                executeCommandProvider: {commands: [javaDiagnosticBundle.command, javaTypeDefinitionCommand]},
              },
            };
          }
          return [];
        }),
      notify: method =>
        Effect.sync(() => {
          events.push(method);
        }),
      close: finish.pipe(Effect.map(receipt => ({...receipt, graceful: true}))),
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => clientSpy.mockRestore()));
  const options: JavaAnalysisOptions = {
    basis: structuredClone(f.basis),
    environment: {id: 'controlled-v2', metadataFile: f.metadataFile, metadataDigest: f.basis.configuration},
    privateDirectory: f.path.join(f.parent, 'analysis'),
  };
  const beforeDirectories = yield* f.fs.readDirectory(options.privateDirectory);
  return {
    ...f,
    events,
    options,
    runtimeSpy,
    clientSpy,
    control,
    beforeDirectories,
    runtimeVerifications: () => runtimeVerifications,
  };
});

const AnalysisTestLayer = Layer.mergeAll(
  Layer.merge(BunServices.layer, cryptoLayer),
  Layer.succeed(ChildEnvironmentPolicy, {
    sanitizeExternal: () => ({}),
    preserveIntendedChild: () => ({}),
  }),
);

describe('Java analysis attachment composition', () => {
  effectIt.effect('captures caller state before registration can change it', () =>
    Effect.gen(function* () {
      const f = yield* analysisFixture();
      const options = {...f.options, basis: {...f.options.basis}, environment: {...f.options.environment}};
      const attached = yield* makeJavaAnalysis(options, () =>
        Effect.sync(() => {
          options.basis.project = 'file:///reassigned-project';
          options.environment.metadataFile = f.path.join(f.parent, 'missing-model.json');
        }),
      );
      const observed = yield* attached.api.upsert(f.basis, f.texts['Main.java'], 'java', 10000);
      expect(observed.project).toBe(f.basis.project);
      expect(f.runtimeVerifications()).toBeGreaterThan(0);
      yield* attached.api.close;
      expect(yield* f.fs.readDirectory(f.options.privateDirectory)).toEqual(f.beforeDirectories);
    }).pipe(Effect.provide(AnalysisTestLayer)),
  );

  effectIt.effect.prop(
    'refuses private output trees overlapping any host SDK before writes or runtime construction',
    [
      Schema.Literals(['serverDirectory', 'runtimeJavaHome', 'projectJavaHome']),
      Schema.Literals(['same', 'child', 'parent']),
    ],
    ([key, relation]) =>
      Effect.gen(function* () {
        const f = yield* analysisFixture();
        const q = javaRuntime.javaRuntimeQualification;
        const candidate = {
          serverDirectory: f.path.join(f.parent, 'server-sdk'),
          serverTreeDigest: q.serverTreeDigest,
          runtimeJavaHome: f.path.join(f.parent, 'runtime-sdk'),
          runtimeSdkDigest: q.runtimeSdkDigest,
          projectJavaHome: f.javaHome,
          projectSdkDigest: q.projectSdkDigest,
        };
        const directory = candidate[key];
        const privateDirectory =
          relation === 'same'
            ? directory
            : relation === 'child'
              ? f.path.join(directory, 'analysis')
              : f.path.dirname(directory);
        const before = yield* f.fs.readDirectory(f.parent);
        const error = yield* Effect.flip(
          makeJavaAnalysis({...f.options, candidate, privateDirectory}, () => Effect.void),
        );
        expect(error).toMatchObject({_tag: 'LspFault', code: 'prerequisite'});
        expect(f.runtimeSpy).not.toHaveBeenCalled();
        expect(f.events).toEqual([]);
        expect(yield* f.fs.readDirectory(f.parent)).toEqual(before);
      }).pipe(Effect.provide(AnalysisTestLayer)),
    {arbitrary: {runs: 18}},
  );

  effectIt.effect('registers the actual child before initialization and closes its private workspace explicitly', () =>
    Effect.gen(function* () {
      const f = yield* analysisFixture();
      const before = JSON.stringify(f.options);
      const original = yield* semanticTreeDigest(f.project);
      const attached = yield* makeJavaAnalysis(f.options, pid =>
        Effect.sync(() => {
          expect(pid).toBe(123);
          f.events.push('admit');
        }),
      );
      expect(f.events.slice(0, 3)).toEqual(['spawn', 'admit', 'initialize']);
      expect(attached.pid).toBe(123);
      expect(yield* attached.api.available).toBe(true);
      const receipt = yield* attached.api.close;
      expect(receipt).toMatchObject({drained: true, stdioClosed: true, graceful: true});
      expect(yield* f.fs.readDirectory(f.options.privateDirectory)).toEqual(f.beforeDirectories);
      expect(EffectArray.filter(f.events, event => event === 'finish')).toHaveLength(1);
      expect(JSON.stringify(f.options)).toBe(before);
      expect(yield* semanticTreeDigest(f.project)).toBe(original);
    }).pipe(Effect.provide(AnalysisTestLayer)),
  );

  effectIt.effect('drains and removes an admitted private workspace when process registration is refused', () =>
    Effect.gen(function* () {
      const f = yield* analysisFixture();
      const error = yield* Effect.flip(
        makeJavaAnalysis(f.options, () => Effect.fail(LspFault.make({code: 'rejected'}))),
      );
      expect(error).toMatchObject({_tag: 'LspFault', code: 'rejected'});
      expect(f.events).toEqual(['spawn', 'finish']);
      expect(f.clientSpy).not.toHaveBeenCalled();
      expect(yield* f.fs.readDirectory(f.options.privateDirectory)).toEqual(f.beforeDirectories);
    }).pipe(Effect.provide(AnalysisTestLayer)),
  );

  effectIt.effect('bounds stalled registration and completes cleanup before reporting startup timeout', () =>
    Effect.gen(function* () {
      const f = yield* analysisFixture();
      const entered = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        makeJavaAnalysis(f.options, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(120001);
      expect(yield* Effect.flip(Fiber.join(fiber))).toMatchObject({_tag: 'LspFault', code: 'timeout'});
      expect(f.events).toEqual(['spawn', 'finish']);
      expect(f.clientSpy).not.toHaveBeenCalled();
      expect(yield* f.fs.readDirectory(f.options.privateDirectory)).toEqual(f.beforeDirectories);
    }).pipe(Effect.provide(AnalysisTestLayer)),
  );

  effectIt.effect('closes construction resources when initialization fails while the parent scope remains usable', () =>
    Effect.gen(function* () {
      const f = yield* analysisFixture();
      f.control.failInitialization = true;
      let finish: Effect.Effect<lsp.WireStop> | undefined;
      const result = yield* Effect.exit(
        makeJavaAnalysis(f.options, (pid, stop) =>
          Effect.sync(() => {
            expect(pid).toBe(123);
            finish = stop;
          }),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(f.events).toEqual(['spawn', 'initialize', 'finish']);
      if (!finish) return yield* Effect.die('Missing pre-initialize stop receipt');
      expect(yield* finish).toMatchObject({drained: true, stdioClosed: true, forced: false});
      expect(f.events).toEqual(['spawn', 'initialize', 'finish']);
      expect(yield* f.fs.readDirectory(f.options.privateDirectory)).toEqual(f.beforeDirectories);
      yield* f.fs.writeFileString(f.path.join(f.parent, 'parent-still-usable'), 'ok');
    }).pipe(Effect.provide(AnalysisTestLayer)),
  );

  effectIt.effect.prop(
    'rejects every caller-selected extra analysis option before SDK access, private writes or process registration',
    [Schema.Literals(['build', 'preparation', 'jvmArguments', 'commands', 'bundle', 'policy', 'configuration'])],
    ([key]) =>
      Effect.gen(function* () {
        const f = yield* analysisFixture();
        const options = {...f.options, [key]: 'not-authority'};
        const before = JSON.stringify(options);
        let called = false;
        const error = yield* Effect.flip(
          makeJavaAnalysis(options, () =>
            Effect.sync(() => {
              called = true;
            }),
          ),
        );
        expect(error).toMatchObject({_tag: 'LspFault', code: 'prerequisite'});
        expect(f.runtimeSpy).not.toHaveBeenCalled();
        expect(called).toBe(false);
        expect(f.events).toEqual([]);
        expect(JSON.stringify(options)).toBe(before);
        expect(yield* f.fs.readDirectory(f.options.privateDirectory)).toEqual(f.beforeDirectories);
      }).pipe(Effect.provide(AnalysisTestLayer)),
    {arbitrary: {runs: 16}},
  );
});
