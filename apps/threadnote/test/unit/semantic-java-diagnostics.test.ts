/* oxlint-disable effecttsgo/strict-effect-provide -- OS-facing bundle tests provide only Bun filesystem/crypto services. */
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Deferred, Effect, Fiber, FileSystem, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {unzipSync} from 'fflate';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {Observation} from '@threadnote/semantic/contracts';
import {makeLspSession, makeSemanticNotifications, type LspDiagnosticRequest} from '../../src/semantic/provider.js';
import type {LspClient} from '../../src/semantic/lsp_transport.js';
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
} from '../../src/semantic/providers/java_snapshot.js';

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

describe('Java request diagnostics', () => {
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
    }).pipe(Effect.provide(BunServices.layer)),
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
    }).pipe(Effect.provide(BunServices.layer)),
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
    }).pipe(Effect.provide(BunServices.layer)),
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
    }).pipe(Effect.provide(BunServices.layer)),
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
    }).pipe(Effect.provide(BunServices.layer)),
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
      }).pipe(Effect.provide(BunServices.layer)),
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
      }).pipe(Effect.provide(BunServices.layer)),
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
    }).pipe(Effect.provide(BunServices.layer)),
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
    }).pipe(Effect.provide(BunServices.layer)),
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
    }).pipe(Effect.provide(BunServices.layer)),
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
          'dev/threadnote/semantic/PreparedProjectModel.class',
          'dev/threadnote/semantic/PreparedProjectModel$Host.class',
          'dev/threadnote/semantic/PreparedProjectModel$PassiveProjection.class',
          'dev/threadnote/semantic/PreparedProjectModel$Budget.class',
          'dev/threadnote/semantic/PreparedProjectModel$CacheImage.class',
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
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
