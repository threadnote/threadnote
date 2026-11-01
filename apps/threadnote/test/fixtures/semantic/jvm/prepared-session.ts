import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import {Effect, FileSystem, Option, Path, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {type Observation, Position} from '@threadnote/semantic/contracts';
import {semanticSdkDigest, semanticTreeDigest} from '../../../../src/semantic/fingerprint.js';
import {LspFault, type LspClient} from '../../../../src/semantic/lsp_transport.js';
import {makeSemanticNotifications} from '../../../../src/semantic/provider.js';
import {makeJavaSession, type JavaSessionOptions} from '../../../../src/semantic/providers/java.js';
import {makeJavaPreparedProject, javaPreparedProjection} from '../../../../src/semantic/providers/java_project.js';
import {
  javaPreparedModelJson,
  javaSourceEncodingImage,
  type JavaPreparedModel,
} from '../../../../src/semantic/providers/java_preparation.js';
import {
  makeJavaDiagnosticModel,
  materializeJavaDiagnosticBundle,
} from '../../../../src/semantic/providers/java_diagnostics.js';
import {javaDiagnosticBundle} from '../../../../src/semantic/providers/java_diagnostics_bundle.js';
import {javaFileUri, javaTypeDefinitionCommand} from '../../../../src/semantic/providers/java_snapshot.js';

/** Controlled persisted-model/session fixture; the wire and SDK files do not qualify an actual Java engine or build. */
export const preparedSessionFixture = Effect.fn('test.preparedJavaSessionFixture')(function* (
  control: {readonly inclusions?: readonly string[]} = {},
) {
  const inclusions = [...(control.inclusions ?? ['**/*.java'])];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-v2-session-'}));
  const project = path.join(parent, 'original'),
    javaHome = path.join(parent, 'jdk');
  const source = path.join(project, 'src/main/java'),
    artifacts = path.join(parent, 'artifacts');
  const privateDirectory = path.join(parent, 'analysis');
  for (const directory of [source, path.join(javaHome, 'lib'), artifacts, privateDirectory])
    yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
  const texts = {
    'Main.java': 'class Main { Included value; } // élève𐐀\n',
    'Included.java': 'class Included {}\n',
    'Excluded.java': 'class Excluded {}\n',
    'Readme.txt': 'not a Java source\n',
  };
  const uris: Record<string, string> = {};
  for (const [name, text] of EffectRecord.toEntries(texts)) {
    const file = path.join(source, name);
    yield* fs.writeFileString(file, text, {mode: 0o600});
    uris[name] = javaFileUri(yield* path.toFileUrl(file));
  }
  for (const [name, text] of [
    ['release', 'JAVA_VERSION="21.0.13"\n'],
    ['lib/jrt-fs.jar', 'controlled SDK'],
    ['lib/src.zip', 'controlled SDK sources'],
  ])
    yield* fs.writeFileString(path.join(javaHome, name), text, {mode: 0o600});
  const common = {
    exported: false,
    combineAccessRules: false,
    inclusions: [],
    exclusions: [],
    attributes: [],
    accessRules: [],
  };
  const libraryText = 'controlled library bytes',
    libraryDigest = sha256HexSync(libraryText);
  const library = path.join(artifacts, libraryDigest + '.jar');
  yield* fs.writeFileString(library, libraryText, {mode: 0o600});
  const root = {
    ...common,
    kind: 3 as const,
    contentKind: 1 as const,
    path: 'src/main/java',
    exists: true,
    output: 'target/classes',
    inclusions,
    exclusions: ['**/Excluded.java'],
  };
  const model: JavaPreparedModel = {
    format: 'threadnote-prepared-java-project-v2',
    provider: 'jdtls-1.63.0-202610191322',
    build: 'maven',
    project,
    worktree: project,
    sourceDigest: yield* semanticTreeDigest(project),
    javaHome,
    javaSdkDigest: yield* semanticSdkDigest(javaHome),
    projectCharset: 'UTF-8',
    sourceInputEncoding: 'utf8-original-inputs-v1',
    sourceEncoding: javaSourceEncodingImage(
      EffectArray.map(
        EffectArray.filter(EffectRecord.toEntries(texts), ([name]) => name !== 'Readme.txt'),
        ([name, text]) => ({name: 'src/main/java/' + name, digest: sha256HexSync(text)}),
      ),
    ),
    compilerOptions: {
      'org.eclipse.jdt.core.compiler.compliance': '21',
      'org.eclipse.jdt.core.compiler.source': '21',
      'org.eclipse.jdt.core.compiler.codegen.targetPlatform': '21',
      'org.eclipse.jdt.core.compiler.release': 'enabled',
      'org.eclipse.jdt.core.compiler.processAnnotations': 'disabled',
    },
    resourceFilters: [],
    output: 'target/classes',
    rawClasspath: [
      root,
      {
        ...common,
        kind: 5,
        contentKind: 1,
        path: 'org.eclipse.m2e.MAVEN2_CLASSPATH_CONTAINER',
        combineAccessRules: true,
      },
      {
        ...common,
        kind: 5,
        contentKind: 1,
        path: 'org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21',
        combineAccessRules: true,
      },
    ],
    resolvedClasspath: [
      root,
      {...common, kind: 1, contentKind: 2, path: library},
      {
        ...common,
        kind: 1,
        contentKind: 2,
        path: path.join(javaHome, 'lib/jrt-fs.jar'),
        sourceAttachmentPath: path.join(javaHome, 'lib/src.zip'),
      },
    ],
    libraries: [{file: library, digest: libraryDigest, bytes: new TextEncoder().encode(libraryText).length}],
  };
  const text = javaPreparedModelJson(model),
    metadataFile = path.join(artifacts, 'model.json');
  yield* fs.writeFileString(metadataFile, text, {flag: 'wx', mode: 0o600});
  const prepared = yield* makeJavaPreparedProject({
    project,
    worktree: project,
    javaHome,
    privateDirectory,
    environment: {id: 'controlled-v2', metadataFile, metadataDigest: sha256HexSync(text)},
  });
  const bundle = yield* materializeJavaDiagnosticBundle(prepared.directory);
  const diagnosticModel = yield* makeJavaDiagnosticModel({
    project: prepared.project,
    javaHome,
    sourceRoots: prepared.sourceRoots,
    libraries: [library],
    compilerOptions: prepared.model.compilerOptions,
    projectionDigest: prepared.projectionDigest,
  });
  const projection = javaPreparedProjection(
    prepared.model,
    [{path: root.path, uri: javaFileUri(yield* path.toFileUrl(source))}],
    prepared.documentationUri,
  ).image;
  const projectUri = javaFileUri(yield* path.toFileUrl(project));
  const basis: Observation = {
    version: 1,
    repository: 'controlled-v2',
    project: projectUri,
    worktree: projectUri,
    configuration: sha256HexSync(text),
    toolchain: sha256HexSync('controlled SDK'),
    provider: {id: 'jdtls', version: '1.63.0', generation: 0},
    view: {kind: 'overlay', id: 'controlled-v2', owner: 'test', epoch: 0},
    uri: uris['Main.java'],
    content: sha256HexSync(texts['Main.java']),
    documentVersion: 1,
    projectEpoch: 0,
  };
  const create = (
    response: Schema.Json = [],
    alter?: (options: JavaSessionOptions) => void,
    beforeReply?: (method: string) => Effect.Effect<void, unknown>,
  ) =>
    Effect.gen(function* () {
      const notifications = makeSemanticNotifications();
      const calls: {method: string; params?: Schema.Json}[] = [];
      const client: LspClient = {
        pid: 1,
        request: (method, params) =>
          Effect.gen(function* (): Effect.fn.Return<Schema.Json, LspFault> {
            calls.push({method, params});
            yield* (beforeReply?.(method) ?? Effect.void).pipe(
              Effect.mapError(() => LspFault.make({code: 'protocol'})),
            );
            if (method === 'initialize') {
              notifications.receive('language/status', {type: 'ServiceReady'});
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
            if (method === 'workspace/executeCommand') {
              const call = yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                  command: Schema.Literals([javaDiagnosticBundle.command, javaTypeDefinitionCommand]),
                  arguments: Schema.Array(
                    Schema.Struct({
                      requestToken: Schema.String,
                      uri: Schema.String,
                      position: Schema.optional(Position),
                      inputs: Schema.Array(
                        Schema.Struct({uri: Schema.String, contentSha256: Schema.String, utf16Length: Schema.Int}),
                      ),
                    }),
                  ),
                }),
              )(params).pipe(Effect.mapError(() => LspFault.make({code: 'protocol'})));
              const input = call.arguments[0];
              const target = EffectArray.findFirst(input.inputs, item => item.uri === input.uri);
              if (Option.isNone(target)) return yield* LspFault.make({code: 'protocol'});
              const header = {
                protocolVersion: 1,
                requestToken: input.requestToken,
                uri: input.uri,
                contentSha256: target.value.contentSha256,
                utf16Length: target.value.utf16Length,
                inputs: input.inputs,
                model: {
                  projectUri: diagnosticModel.projectUri,
                  javaHomeUri: diagnosticModel.javaHomeUri,
                  sourceRoots: diagnosticModel.sourceRoots,
                  libraries: diagnosticModel.libraries,
                  compilerOptions: prepared.model.compilerOptions,
                  annotationProcessing: 'disabled-for-snapshot',
                  projection,
                },
              };
              if (call.command === javaDiagnosticBundle.command) return {...header, diagnostics: []};
              if (!input.position) return yield* LspFault.make({code: 'protocol'});
              return {
                ...header,
                position: input.position,
                typeDefinition: {status: 'unsupported', reason: 'no-source-type'},
              };
            }
            return method === 'textDocument/documentSymbol' ? [] : response;
          }),
        notify: (method, params) =>
          Effect.sync(() => {
            calls.push({method, params});
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
      const options: JavaSessionOptions = {
        basis: structuredClone(basis),
        notifications,
        roots: [],
        profile: {kind: 'controlled-v2'},
        startupMilliseconds: 1000,
        prepared,
        bundle,
        diagnosticModel: structuredClone(diagnosticModel),
        runtime: {projectJavaHome: javaHome, verify: Effect.void},
      };
      alter?.(options);
      const result = yield* Effect.exit(makeJavaSession(client, options));
      return {result, calls, options};
    });
  return {
    fs,
    path,
    parent,
    project,
    javaHome,
    source,
    texts,
    uris,
    basis,
    prepared,
    diagnosticModel,
    create,
    library,
    metadataFile,
  };
});
