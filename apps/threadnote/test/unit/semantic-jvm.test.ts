/* oxlint-disable effecttsgo/strict-effect-provide -- Filesystem model tests provide only the Bun OS services. */
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
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
import {javaTypeDefinitionCommand, JavaProjectionImage} from '../../src/semantic/providers/java_snapshot.js';
import {
  makeJavaProject,
  javaCompilerPreferences,
  javaProjectMetadata,
  javaProjectionMetadata,
  javaPreparedProjection,
  javaPreparedSourceMember,
  type JavaProjectModel,
} from '../../src/semantic/providers/java_project.js';
import {javaPreparedModelJson, JavaPreparedModel} from '../../src/semantic/providers/java_preparation.js';

const decodeXmlEntities = (text: string) => {
  const entities: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Each XML entity needs a distinct callback replacement; Effect String.replace accepts a fixed string.
  return text.replace(/&(amp|lt|gt|quot|apos);/gu, (_, entity: string) => entities[entity]);
};

const fixture = (libraryName = 'dependency', javaHomeName = 'jdk') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-java-project-'}));
    const project = path.join(root, 'source');
    const source = path.join(project, 'src/main/java');
    const javaHome = path.join(root, javaHomeName);
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
  it('escapes compiler preferences using ASCII Java Properties syntax', () => {
    const prefix = 'eclipse.preferences.version=1\n';
    expect(javaCompilerPreferences({'compiler key:=#!\\': 'é😀'})).toBe(
      prefix + 'compiler\\ key\\:\\=\\#\\!\\\\=\\u00e9\\ud83d\\ude00\n',
    );
    expect(javaCompilerPreferences({compiler: ' \t\r\n\f:=#!\\ '})).toBe(
      prefix + 'compiler=\\ \\u0009\\u000d\\u000a\\u000c\\:\\=\\#\\!\\\\\\ \n',
    );
    expect(javaCompilerPreferences({z: '', a: '21'})).toBe(prefix + 'a=21\nz=\n');
  });
  it('keeps compiler preference framing deterministic, ASCII and independent of caller insertion order', () => {
    const value = fc
      .array(fc.constantFrom('a', 'é', '𐐀', '😀', ' ', '\\', '=', ':', '#', '!', '\t', '\n', '\0'), {
        minLength: 0,
        maxLength: 32,
      })
      .map(characters => EffectArray.join(characters, ''));
    fc.assert(
      fc.property(fc.array(value, {maxLength: 12}), values => {
        const options: Record<string, string> = {};
        for (const [index, value] of values.entries()) options['compiler.' + index + ' é:=#!\\'] = value;
        const before = JSON.stringify(options);
        Object.freeze(options);
        const encoded = javaCompilerPreferences(options);
        const reversed: Record<string, string> = {};
        for (const key of EffectRecord.keys(options).reverse()) reversed[key] = options[key];
        expect(javaCompilerPreferences(reversed)).toBe(encoded);
        expect(encoded).not.toMatch(/[^\x20-\x7e\n]/u);
        expect(EffectString.split('\n')(encoded)).toHaveLength(values.length + 2);
        expect(JSON.stringify(options)).toBe(before);
      }),
      {numRuns: 32},
    );
  });
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
        const paths = Array.from(
          EffectString.matchAll(/<classpathentry kind="lib" path="([^"]*)"\/>/gu)(files['.classpath']),
          match => decodeXmlEntities(match[1]),
        );
        const links = Array.from(
          EffectString.matchAll(/<locationURI>([^<]*)<\/locationURI>/gu)(files['.project']),
          match => decodeXmlEntities(match[1]),
        );
        expect(paths).toEqual(libraries);
        expect(links).toEqual(sources);
        expect(javaProjectMetadata(sources, libraries)).toEqual(files);
        expect(JSON.stringify([sources, libraries])).toBe(before);
      }),
      {numRuns: 32},
    );
  });

  const projectionFixture = (value = 'élève&<"𐐀') => {
    const fields = {
      exported: false,
      inclusions: [],
      exclusions: [],
      attributes: [{name: 'scope', value}],
      accessRules: [],
    };
    const source = {
      ...fields,
      kind: 3 as const,
      contentKind: 1 as const,
      path: '/threadnote-java/source-0',
      combineAccessRules: false,
      outputPath: '/threadnote-java/output-1',
      inclusions: ['demo/**'],
      exclusions: ['ignored/'],
    };
    const library = {
      ...fields,
      kind: 1 as const,
      contentKind: 2 as const,
      path: '/libraries/' + value + '.jar',
      combineAccessRules: false,
      exported: true,
      sourceAttachmentPath: '/sdk/source.zip',
      sourceAttachmentRoot: '',
      accessRules: [
        {kind: 2 as const, pattern: 'hidden/**', ignoreIfBetter: true},
        {kind: 0 as const, pattern: 'public/**', ignoreIfBetter: false},
      ],
    };
    const jre = {
      ...fields,
      kind: 5 as const,
      contentKind: 1 as const,
      path: 'org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21',
      combineAccessRules: true,
    };
    const image: typeof JavaProjectionImage.Type = {
      format: 'threadnote-passive-java-projection-v1',
      projectCharset: 'UTF-8',
      outputPath: '/threadnote-java/output-0',
      rawClasspath: [source, library, jre],
      resolvedClasspath: [source, library],
      links: [{path: 'source-0', uri: 'file:///original/' + encodeURIComponent(value), type: 2}],
      resourceFilters: [
        {
          id: '123456789',
          path: '',
          type: 30,
          matcherId: 'org.eclipse.core.resources.regexFilterMatcher',
          arguments: 'node_modules|\\.git|__CREATED_BY_JAVA_LANGUAGE_SERVER__',
        },
      ],
    };
    const compiler = {
      'org.eclipse.jdt.core.compiler.compliance': '21',
      'org.eclipse.jdt.core.compiler.source': '21',
      'org.eclipse.jdt.core.compiler.codegen.targetPlatform': '21',
      'org.eclipse.jdt.core.compiler.release': 'enabled',
      'org.eclipse.jdt.core.compiler.processAnnotations': 'disabled',
      'org.eclipse.jdt.core.compiler.annotation.nonnull': value,
    };
    return {image, compiler};
  };

  const preparedFixture = () => {
    const {compiler} = projectionFixture();
    const fields = {
      exported: false,
      combineAccessRules: false,
      inclusions: [],
      exclusions: [],
      accessRules: [],
      attributes: [{name: 'maven.pomderived', value: 'true'}],
    };
    const main = {
      ...fields,
      kind: 3 as const,
      contentKind: 1 as const,
      path: 'src/main/java',
      exists: true,
      output: 'target/classes',
    };
    const resources = {
      ...main,
      path: 'src/main/resources',
      exists: false,
      exclusions: ['**'],
      attributes: [{name: 'optional', value: 'true'}, ...fields.attributes],
    };
    const tests = {
      ...resources,
      path: 'src/test/java',
      exclusions: [],
      output: 'target/test-classes',
      attributes: [...resources.attributes, {name: 'test', value: 'true'}],
    };
    const generated = {...resources, path: 'target/generated-sources/annotations', exclusions: []};
    const {output: _output, ...defaultGenerated} = generated;
    const jre = {
      ...fields,
      kind: 5 as const,
      contentKind: 1 as const,
      combineAccessRules: true,
      path: 'org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21',
    };
    const importer = {...jre, path: 'org.eclipse.m2e.MAVEN2_CLASSPATH_CONTAINER'};
    const sdk = {
      ...fields,
      kind: 1 as const,
      contentKind: 2 as const,
      path: '/sdk/lib/jrt-fs.jar',
      sourceAttachmentPath: '/sdk/lib/src.zip',
      attributes: [
        {
          name: 'javadoc_location' as const,
          access: 'disabled' as const,
          valueSha256: sha256HexSync('original SDK documentation'),
        },
        ...fields.attributes,
      ],
    };
    const library = {
      ...fields,
      kind: 1 as const,
      contentKind: 2 as const,
      path: '/sealed/library.jar',
      exported: true,
      accessRules: [{pattern: 'internal/**', kind: 2 as const, ignoreIfBetter: true}],
      attributes: [
        ...fields.attributes,
        {name: 'maven.scope', value: 'test'},
        {name: 'test', value: 'true'},
        ...fields.attributes,
      ],
    };
    const model: JavaPreparedModel = {
      format: 'threadnote-prepared-java-project-v2',
      provider: 'jdtls-1.63.0-202610191322',
      build: 'maven',
      project: '/original',
      worktree: '/original',
      sourceDigest: sha256HexSync('sources'),
      javaHome: '/sdk',
      javaSdkDigest: sha256HexSync('SDK'),
      projectCharset: 'UTF-8',
      sourceInputEncoding: 'utf8-original-inputs-v1',
      sourceEncoding: {policy: 'utf8-no-bom-v1', sourceCount: 1, sourceDigest: sha256HexSync('encoding')},
      compilerOptions: compiler,
      output: 'target/classes',
      resourceFilters: [
        {
          id: '123456789',
          path: '',
          type: 30,
          matcherId: 'org.eclipse.core.resources.regexFilterMatcher',
          arguments: 'node_modules|\\.git|__CREATED_BY_JAVA_LANGUAGE_SERVER__',
        },
      ],
      rawClasspath: [main, resources, tests, jre, importer, defaultGenerated],
      resolvedClasspath: [main, resources, tests, sdk, library, defaultGenerated],
      libraries: [{file: library.path, digest: sha256HexSync('library'), bytes: 42}],
    };
    const bindings = EffectArray.map([main, resources, tests, defaultGenerated], entry => ({
      path: entry.path,
      uri: 'file:///original/' + entry.path,
    }));
    return {model, bindings, documentationUri: 'file:///private/empty-docs/'};
  };

  it('matches the pinned JDT source-pattern and UTF-16 boundary cases', () => {
    const {model} = preparedFixture();
    const check = (inclusions: readonly string[], exclusions: readonly string[], file: string) =>
      javaPreparedSourceMember(
        {
          ...model,
          rawClasspath: EffectArray.map(model.rawClasspath, (entry, i) =>
            i === 0 ? {...entry, inclusions, exclusions} : entry,
          ),
        },
        '/original/src/main/java/' + file,
      );
    // Developer-only oracle831 uses the exact pinned compiler Util.isExcluded and Eclipse IPath.append.
    for (const [pattern, file, expected] of [
      ['**/*.java', 'Main.java', true],
      ['/**/*.java', 'demo/Main.java', true],
      ['?.java', 'é.java', true],
      ['?.java', '𐐀.java', false],
      ['??.java', '𐐀.java', true],
      ['a/', 'a/Main.java', true],
      ['*/', 'Main.java', true],
      ['/', 'Main.java', false],
      ['**/*/**/', 'Main.java', false],
      ['*/**/**/', 'Main.java', false],
      ['**/?*/**/**', 'Main.java', false],
      ['a/**', 'a/Main.java', true],
      ['[a].java', '[a].java', true],
      ['**/Main.java', 'demo/main.java', false],
    ] as const)
      expect(check([pattern], [], file), pattern + ' :: ' + file).toBe(expected);
    expect(check(['**/*.java'], ['**/Excluded.java'], 'demo/Excluded.java')).toBe(false);
    expect(check(['**/*.java'], ['**/Excluded.java'], 'demo/Main.java')).toBe(true);
    expect(javaPreparedSourceMember(model, '/original/src/test/java/Main.java')).toBe(false);
    expect(javaPreparedSourceMember(model, '/unrelated/src/main/java/Main.java')).toBe(false);
    for (const name of ['node_modules', '.git', '__CREATED_BY_JAVA_LANGUAGE_SERVER__'])
      expect(check([], [], 'demo/' + name + '/Main.java')).toBe(false);
    expect(check([], [], 'node_modules_extra/Main.java')).toBe(true);
    expect(
      javaPreparedSourceMember({...model, resourceFilters: []}, '/original/src/main/java/node_modules/Main.java'),
    ).toBe(true);
    expect(() => check(['a//b'], [], 'Main.java')).toThrow();
    expect(() => check(['a/../b'], [], 'Main.java')).toThrow();
    expect(() => javaPreparedSourceMember(model, '/original/src/main/java/../Main.java')).toThrow();
  });

  it('bounds adversarial source-pattern work and refuses ambiguous roots', () => {
    const {model} = preparedFixture();
    const source = {...model.rawClasspath[0], inclusions: ['*' + EffectString.repeat(4096)('a')], exclusions: []};
    const expensive = {...model, rawClasspath: [source, ...model.rawClasspath.slice(1)]};
    let code: string | undefined;
    try {
      javaPreparedSourceMember(expensive, '/original/src/main/java/' + EffectString.repeat(4096)('b') + '.java');
    } catch (error) {
      if (Schema.is(LspFault)(error)) code = error.code;
      else throw error;
    }
    expect(code).toBe('capacity');
    const duplicate = {...model, rawClasspath: [model.rawClasspath[0], ...model.rawClasspath]};
    expect(() => javaPreparedSourceMember(duplicate, '/original/src/main/java/Main.java')).toThrow();
  });

  it('keeps exclusion monotonicity, case and input facts across generated source paths', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', 'é', '𐐀'), {minLength: 1, maxLength: 8}),
        fc.constantFrom('**', '**/*.java', '**/Never.java', '**/*/**/', '*/'),
        (parts, pattern) => {
          const {model} = preparedFixture();
          const name = EffectArray.join(parts, '') + '.java';
          const file = '/original/src/main/java/demo/' + name;
          const before = JSON.stringify(model);
          const withExclusions = (exclusions: readonly string[]) => ({
            ...model,
            rawClasspath: EffectArray.map(model.rawClasspath, (entry, i) => (i === 0 ? {...entry, exclusions} : entry)),
          });
          for (const exclusions of [[], ['demo/' + name]]) {
            const baseline = withExclusions(exclusions);
            const baselineBefore = JSON.stringify(baseline);
            const base = javaPreparedSourceMember(baseline, file);
            expect(base).toBe(exclusions.length === 0);
            const after = javaPreparedSourceMember(withExclusions([...exclusions, pattern]), file);
            expect(after && !base).toBe(false);
            expect(javaPreparedSourceMember(baseline, file)).toBe(base);
            expect(JSON.stringify(baseline)).toBe(baselineBefore);
          }
          expect(JSON.stringify(model)).toBe(before);
        },
      ),
      {numRuns: 64},
    );
  });

  it('translates sealed source/output identities and combined library facts without changing the original model', () => {
    const {model, bindings, documentationUri} = preparedFixture();
    const original = javaPreparedModelJson(model);
    const projected = javaPreparedProjection(model, bindings, documentationUri);
    expect(javaPreparedModelJson(model)).toBe(original);
    expect(EffectArray.map(projected.image.rawClasspath, entry => entry.path)).toEqual([
      '/threadnote-java/source-0',
      '/threadnote-java/source-1',
      '/threadnote-java/source-2',
      model.rawClasspath[3].path,
      '/sealed/library.jar',
      '/threadnote-java/source-3',
    ]);
    expect(EffectArray.map(projected.image.resolvedClasspath, entry => entry.path)).toEqual([
      '/threadnote-java/source-0',
      '/threadnote-java/source-1',
      '/threadnote-java/source-2',
      '/sdk/lib/jrt-fs.jar',
      '/sealed/library.jar',
      '/threadnote-java/source-3',
    ]);
    expect(EffectArray.map(projected.image.rawClasspath.slice(0, 3), entry => entry.outputPath)).toEqual([
      '/threadnote-java/output-0',
      '/threadnote-java/output-0',
      '/threadnote-java/output-1',
    ]);
    expect(projected.image.rawClasspath[5]).not.toHaveProperty('outputPath');
    expect(projected.image.rawClasspath[1].exclusions).toEqual(['**']);
    expect(projected.image.rawClasspath[4]).toMatchObject({
      exported: true,
      accessRules: model.resolvedClasspath[4].accessRules,
      attributes: [
        {name: 'maven.pomderived', value: 'true'},
        {name: 'maven.scope', value: 'test'},
        {name: 'test', value: 'true'},
      ],
    });
    expect(projected.image.resolvedClasspath[3].attributes[0]).toEqual({
      name: 'javadoc_location',
      access: 'disabled',
      valueSha256: sha256HexSync('file:/private/empty-docs/'),
    });
    expect(projected.image.resourceFilters).toEqual(model.resourceFilters);
    expect(projected.image.links).toEqual(
      EffectArray.map(bindings, (binding, index) => ({path: 'source-' + index, uri: binding.uri, type: 2})),
    );
    expect(projected.metadata['.classpath']).not.toContain('MAVEN2_CLASSPATH_CONTAINER');
    expect(javaPreparedProjection(model, bindings, documentationUri)).toEqual(projected);
  });

  it('distinguishes SDK Java URL documentation spelling from raw classpath URI spelling', () => {
    for (const documentationUri of ['file:///private/empty-docs/', 'file:///private/encoded%20%C3%A9%F0%90%90%80/']) {
      const {model, bindings} = preparedFixture();
      const library = model.resolvedClasspath[4];
      const selected = {
        ...model,
        resolvedClasspath: EffectArray.map(model.resolvedClasspath, entry =>
          entry === library
            ? {
                ...entry,
                attributes: [
                  ...entry.attributes,
                  {
                    name: 'javadoc_location' as const,
                    valueSha256: sha256HexSync('unreplayable original'),
                    access: 'disabled' as const,
                  },
                ],
              }
            : entry,
        ),
      };
      const {image, metadata} = javaPreparedProjection(selected, bindings, documentationUri);
      expect(image.rawClasspath[4].attributes.at(-1)).toEqual({
        name: 'javadoc_location',
        access: 'disabled',
        valueSha256: sha256HexSync(documentationUri),
      });
      expect(image.resolvedClasspath[3].attributes[0]).toEqual({
        name: 'javadoc_location',
        access: 'disabled',
        valueSha256: sha256HexSync('file:' + EffectString.slice('file://'.length)(documentationUri)),
      });
      expect(metadata['.classpath']).toContain('value="' + documentationUri + '"');
    }
  });

  it('preserves explicit library anchors and accepts the closed Gradle container shape without claiming Gradle qualification', () => {
    const {model, bindings, documentationUri} = preparedFixture();
    const library = {...model.resolvedClasspath[4], attributes: model.resolvedClasspath[4].attributes.slice(0, -1)};
    const selected: JavaPreparedModel = {
      ...model,
      build: 'gradle',
      rawClasspath: [
        ...model.rawClasspath.slice(0, 3),
        library,
        model.rawClasspath[3],
        {...model.rawClasspath[4], path: 'org.eclipse.buildship.core.gradleclasspathcontainer'},
        model.rawClasspath[5],
      ],
      resolvedClasspath: [
        ...model.resolvedClasspath.slice(0, 3),
        library,
        model.resolvedClasspath[3],
        model.resolvedClasspath[5],
      ],
    };
    expect(javaPreparedProjection(selected, bindings, documentationUri).image.rawClasspath[3]).toEqual(library);
    const duplicate = {...library, attributes: [...library.attributes, {name: 'maven.pomderived', value: 'true'}]};
    expect(() =>
      javaPreparedProjection(
        {
          ...selected,
          rawClasspath: EffectArray.map(selected.rawClasspath, entry => (entry === library ? duplicate : entry)),
          resolvedClasspath: EffectArray.map(selected.resolvedClasspath, entry =>
            entry === library ? duplicate : entry,
          ),
        },
        bindings,
        documentationUri,
      ),
    ).toThrow();
  });

  it('preserves dependency order, flags and nonduplicate attribute order under A0 projection', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), {minLength: 1, maxLength: 12}), flags => {
        const {model, bindings, documentationUri} = preparedFixture();
        const dependencies = EffectArray.map(flags, (exported, index) => ({
          ...model.resolvedClasspath[4],
          path: '/sealed/library-' + index + '.jar',
          exported,
        }));
        const selected = {
          ...model,
          libraries: EffectArray.map(dependencies, entry => ({
            file: entry.path,
            digest: sha256HexSync(entry.path),
            bytes: 42,
          })),
          resolvedClasspath: [...model.resolvedClasspath.slice(0, 4), ...dependencies, model.resolvedClasspath[5]],
        };
        const original = JSON.stringify(selected);
        const {image} = javaPreparedProjection(selected, bindings, documentationUri);
        expect(EffectArray.map(image.rawClasspath.slice(4, -1), entry => entry.path)).toEqual(
          EffectArray.map(dependencies, entry => entry.path),
        );
        expect(EffectArray.map(image.rawClasspath.slice(4, -1), entry => entry.exported)).toEqual(flags);
        expect(EffectArray.map(image.rawClasspath.slice(4, -1), entry => entry.attributes)).toEqual(
          EffectArray.map(dependencies, entry => entry.attributes.slice(0, -1)),
        );
        expect(JSON.stringify(selected)).toBe(original);
        const reordered = Schema.decodeSync(JavaPreparedModel)(
          JSON.parse(
            JSON.stringify(selected, (_key, value) =>
              value && !EffectArray.isArray(value) && typeof value === 'object'
                ? EffectRecord.fromEntries(EffectRecord.toEntries(value).reverse())
                : value,
            ),
          ),
        );
        expect(javaPreparedProjection(reordered, bindings, documentationUri).image).toEqual(image);
      }),
      {numRuns: 32},
    );
  });

  it('refuses ambiguous classpath expansion, source bindings, outputs and duplicate metadata', () => {
    const {model, bindings, documentationUri} = preparedFixture();
    const main = model.rawClasspath[0];
    const library = model.resolvedClasspath[4];
    const invalid: JavaPreparedModel[] = [
      {...model, rawClasspath: [...model.rawClasspath, main]},
      {...model, resolvedClasspath: [model.resolvedClasspath[1], main, ...model.resolvedClasspath.slice(2)]},
      {...model, resolvedClasspath: [...model.resolvedClasspath, library]},
      {...model, resolvedClasspath: model.resolvedClasspath.slice(0, -1)},
      {...model, rawClasspath: EffectArray.filter(model.rawClasspath, entry => entry.kind !== 5)},
      {
        ...model,
        libraries: [...model.libraries, {file: '/sealed/unreferenced.jar', digest: sha256HexSync('other'), bytes: 1}],
      },
      {...model, output: 'src/main/java/output'},
      {...model, output: 'target'},
      {...model, output: '../outside'},
      {
        ...model,
        resolvedClasspath: EffectArray.map(model.resolvedClasspath, entry =>
          entry === main ? {...entry, exists: false} : entry,
        ),
      },
      {
        ...model,
        resolvedClasspath: EffectArray.map(model.resolvedClasspath, entry =>
          entry === library
            ? {...entry, attributes: [...entry.attributes, {name: 'maven.scope', value: 'test'}]}
            : entry,
        ),
      },
      {
        ...model,
        resolvedClasspath: EffectArray.map(model.resolvedClasspath, entry =>
          entry === library
            ? {...entry, attributes: [...entry.attributes, {name: 'maven.pomderived', value: 'false'}]}
            : entry,
        ),
      },
      {
        ...model,
        resolvedClasspath: EffectArray.map(model.resolvedClasspath, entry =>
          entry === library ? {...entry, attributes: []} : entry,
        ),
      },
      {
        ...model,
        resolvedClasspath: EffectArray.map(model.resolvedClasspath, entry =>
          entry.path === '/sdk/lib/jrt-fs.jar' ? {...entry, path: '/sdk/other.jar'} : entry,
        ),
      },
    ];
    for (const candidate of invalid)
      expect(() => javaPreparedProjection(candidate, bindings, documentationUri)).toThrow();
    expect(() =>
      javaPreparedProjection(
        model,
        [{...bindings[0], uri: 'file:///other/src/main/java'}, ...bindings.slice(1)],
        documentationUri,
      ),
    ).toThrow();
    expect(() => javaPreparedProjection(model, bindings.slice(1), documentationUri)).toThrow();
    expect(() => javaPreparedProjection(model, bindings, 'https://example.invalid/docs/')).toThrow();
    for (const uri of ['file:////private/empty-docs/', 'file://///private/empty-docs/'])
      expect(() => javaPreparedProjection(model, bindings, uri)).toThrow();
  });

  it('preserves projected XML facts, semantic order and inputs across reserved Unicode values', () => {
    const name = fc
      .array(fc.constantFrom('a', '&', '<', '>', '"', "'", 'é', '𐐀', '$', '?', '#', '%', '[', ']', '|', '^'), {
        minLength: 1,
        maxLength: 12,
      })
      .map(parts => EffectArray.join(parts, ''));
    fc.assert(
      fc.property(name, value => {
        const {image, compiler} = projectionFixture(value);
        const before = JSON.stringify([image, compiler]);
        const files = javaProjectionMetadata(image, compiler);
        // These extract the fixed serializer fields; the pinned native fixture verifies Eclipse reconstruction.
        const entries = Array.from(
          EffectString.matchAll(/<classpathentry\b[^>]*>/gu)(files['.classpath']),
          match => match[0],
        );
        const attribute = (tag: string, name: string) => {
          const match = Array.from(EffectString.matchAll(new RegExp(' ' + name + '="([^"]*)"', 'gu'))(tag))[0];
          return match ? decodeXmlEntities(match[1]) : null;
        };
        expect(EffectArray.map(entries, entry => attribute(entry, 'path'))).toEqual([
          'source-0',
          image.rawClasspath[1].path,
          image.rawClasspath[2].path,
          'output-0',
        ]);
        expect(attribute(entries[0], 'output')).toBe('output-1');
        expect(attribute(entries[0], 'including')).toBe('demo/**');
        expect(attribute(entries[0], 'excluding')).toBe('ignored/');
        expect(attribute(entries[1], 'exported')).toBe('true');
        expect(attribute(entries[1], 'sourcepath')).toBe('/sdk/source.zip');
        expect(attribute(entries[1], 'rootpath')).toBe('');
        expect(
          Array.from(EffectString.matchAll(/<accessrule\b[^>]*>/gu)(files['.classpath']), rule => [
            attribute(rule[0], 'kind'),
            attribute(rule[0], 'pattern'),
            attribute(rule[0], 'ignoreifbetter'),
          ]),
        ).toEqual([
          ['discouraged', 'hidden/**', 'true'],
          ['accessible', 'public/**', null],
        ]);
        expect(
          Array.from(EffectString.matchAll(/<attribute\b[^>]*>/gu)(files['.classpath']), item =>
            attribute(item[0], 'value'),
          ),
        ).toEqual([value, value, value]);
        expect(
          Array.from(EffectString.matchAll(/<locationURI>([^<]*)<\/locationURI>/gu)(files['.project']), match =>
            decodeXmlEntities(match[1]),
          ),
        ).toEqual([image.links[0].uri]);
        expect(
          Array.from(EffectString.matchAll(/<filter><id>([^<]*)<\/id>/gu)(files['.project']), match => match[1]),
        ).toEqual([image.resourceFilters[0].id]);
        expect(
          Array.from(EffectString.matchAll(/<arguments>([^<]*)<\/arguments>/gu)(files['.project']), match =>
            decodeXmlEntities(match[1]),
          ),
        ).toEqual([image.resourceFilters[0].arguments]);
        expect(files['.settings/org.eclipse.jdt.core.prefs']).toBe(javaCompilerPreferences(compiler));
        expect(files['.settings/org.eclipse.core.resources.prefs']).toContain('encoding/<project>=UTF-8\n');
        expect(
          javaProjectionMetadata(image, EffectRecord.fromEntries(EffectRecord.toEntries(compiler).reverse())),
        ).toEqual(files);
        expect(JSON.stringify([image, compiler])).toBe(before);
      }),
      {numRuns: 32},
    );
  });

  it('refuses lossy projected metadata and constructor fields instead of dropping them', () => {
    const {image, compiler} = projectionFixture();
    for (const source of [
      {...image.rawClasspath[0], inclusions: ['']},
      {...image.rawClasspath[0], exclusions: ['left|right']},
      {...image.rawClasspath[0], exported: true},
      {...image.rawClasspath[0], combineAccessRules: true},
      {...image.rawClasspath[0], contentKind: 2 as const},
      {
        ...image.rawClasspath[0],
        attributes: [
          {name: 'test', value: 'true'},
          {name: 'test', value: 'true'},
        ],
      },
      {...image.rawClasspath[0], path: '/threadnote-java/source-32'},
      {...image.rawClasspath[0], outputPath: '/threadnote-java/output-33'},
      {...image.rawClasspath[0], sourceAttachmentPath: '/sdk/source.zip'},
      {...image.rawClasspath[0], accessRules: [{kind: 0 as const, pattern: '**', ignoreIfBetter: false}]},
    ])
      expect(() =>
        javaProjectionMetadata({...image, rawClasspath: [source, ...image.rawClasspath.slice(1)]}, compiler),
      ).toThrow();
    expect(() =>
      javaProjectionMetadata({...image, links: [{...image.links[0], path: 'source-1'}]}, compiler),
    ).toThrow();
    const unexpected = {...image, unexpected: true};
    expect(() => javaProjectionMetadata(unexpected, compiler)).toThrow();
    expect(() =>
      javaProjectionMetadata(image, {...compiler, 'org.eclipse.jdt.core.compiler.processAnnotations': 'enabled'}),
    ).toThrow();
  });

  it('serializes redacted raw documentation only with its exact supplied local URI', () => {
    const {image, compiler} = projectionFixture();
    const uri = 'file:///private/documentation/';
    const selected = {
      ...image,
      rawClasspath: EffectArray.map(image.rawClasspath, entry =>
        entry.kind === 1
          ? {
              ...entry,
              attributes: [
                {name: 'javadoc_location' as const, valueSha256: sha256HexSync(uri), access: 'disabled' as const},
              ],
            }
          : entry,
      ),
    };
    expect(() => javaProjectionMetadata(selected, compiler)).toThrow();
    expect(() => javaProjectionMetadata(selected, compiler, 'file:///private/other/')).toThrow();
    expect(javaProjectionMetadata(selected, compiler, uri)['.classpath']).toContain('value="' + uri + '"');
    expect(() => javaProjectionMetadata(selected, compiler, 'https://example.invalid/docs/')).toThrow();
  });

  it('requires absent URI components while preserving escaped filename delimiters', () => {
    const {image, compiler} = projectionFixture();
    for (const component of ['?', '#', '?query', '#fragment']) {
      const sourceUri = 'file:///original/src' + component;
      expect(() =>
        javaProjectionMetadata({...image, links: [{...image.links[0], uri: sourceUri}]}, compiler),
      ).toThrow();
      const documentationUri = 'file:///private/documentation/' + component;
      const selected = {
        ...image,
        rawClasspath: EffectArray.map(image.rawClasspath, entry =>
          entry.kind === 1
            ? {
                ...entry,
                attributes: [
                  {
                    name: 'javadoc_location' as const,
                    valueSha256: sha256HexSync(documentationUri),
                    access: 'disabled' as const,
                  },
                ],
              }
            : entry,
        ),
      };
      expect(() => javaProjectionMetadata(selected, compiler, documentationUri)).toThrow();
    }
    const encodedUri = 'file:///original/question%3Fhash%23';
    expect(
      javaProjectionMetadata({...image, links: [{...image.links[0], uri: encodedUri}]}, compiler)['.project'],
    ).toContain(encodedUri);
  });

  it('requires Java-compatible URI path spelling and well-formed decoded filenames', () => {
    const {image, compiler} = projectionFixture();
    for (const path of [
      'tail%',
      'bad%GG',
      'short%0',
      'nul%00',
      'control%0A',
      'utf8%80',
      'surrogate%ED%A0%80',
      'raw[bracket]',
      'raw|pipe',
      'raw^caret',
    ]) {
      const uri = 'file:///original/' + path;
      expect(() => javaProjectionMetadata({...image, links: [{...image.links[0], uri}]}, compiler)).toThrow();
      const selected = {
        ...image,
        rawClasspath: EffectArray.map(image.rawClasspath, entry =>
          entry.kind === 1
            ? {
                ...entry,
                attributes: [
                  {name: 'javadoc_location' as const, valueSha256: sha256HexSync(uri), access: 'disabled' as const},
                ],
              }
            : entry,
        ),
      };
      expect(() => javaProjectionMetadata(selected, compiler, uri)).toThrow();
    }
    for (const path of [
      'percent%25',
      'literal%2500',
      'question%3Fhash%23',
      '%5Bbracket%5D%7Cpipe%5E',
      '%C3%A9%F0%90%90%80',
    ]) {
      const uri = 'file:///original/' + path;
      expect(javaProjectionMetadata({...image, links: [{...image.links[0], uri}]}, compiler)['.project']).toContain(
        uri,
      );
      const selected = {
        ...image,
        rawClasspath: EffectArray.map(image.rawClasspath, entry =>
          entry.kind === 1
            ? {
                ...entry,
                attributes: [
                  {name: 'javadoc_location' as const, valueSha256: sha256HexSync(uri), access: 'disabled' as const},
                ],
              }
            : entry,
        ),
      };
      expect(javaProjectionMetadata(selected, compiler, uri)['.classpath']).toContain('value="' + uri + '"');
    }
  });
});

const makeSessionFixture = Effect.fn('test.javaSessionFixture')(function* (javaHomeName = 'jdk') {
  const f = yield* fixture('dependency', javaHomeName);
  const prepared = yield* makeJavaProject(f.options);
  const bundle = yield* materializeJavaDiagnosticBundle(prepared.directory);
  const diagnosticModel = yield* makeJavaDiagnosticModel({
    project: prepared.project,
    javaHome: f.javaHome,
    sourceRoots: prepared.sourceRoots,
    libraries: [f.library],
    compilerOptions: {
      'org.eclipse.jdt.core.compiler.compliance': '21',
      'org.eclipse.jdt.core.compiler.source': '21',
      'org.eclipse.jdt.core.compiler.codegen.targetPlatform': '21',
      'org.eclipse.jdt.core.compiler.release': 'enabled',
    },
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
    beforeResponse: (method: string) => Effect.Effect<void, LspFault> = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      const notifications = makeSemanticNotifications();
      const calls: {method: string; params: Schema.Json | undefined}[] = timing?.calls ?? [];
      const client: LspClient = {
        pid: 1,
        request: (method, params) =>
          Effect.gen(function* (): Effect.fn.Return<Schema.Json, LspFault> {
            calls.push({method, params});
            yield* beforeResponse(method);
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
                  command: Schema.Literals([javaTypeDefinitionCommand, javaDiagnosticBundle.command]),
                  arguments: Schema.Array(
                    Schema.Struct({requestToken: Schema.String, position: Schema.optional(Position)}),
                  ),
                }),
              )(params).pipe(Effect.mapError(() => LspFault.make({code: 'protocol'})));
              expect(call.arguments).toHaveLength(1);
              const header = {
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
              };
              if (call.command === javaDiagnosticBundle.command)
                return {
                  ...header,
                  diagnostics: Schema.is(Schema.Struct({diagnostics: Schema.Array(Schema.Json)}))(response)
                    ? response.diagnostics
                    : [],
                };
              if (!call.arguments[0].position) return yield* LspFault.make({code: 'protocol'});
              return {
                ...header,
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
      const options: JavaSessionOptions = {
        basis,
        notifications,
        roots: [],
        profile: prepared.profile,
        startupMilliseconds: 1000,
        prepared,
        bundle,
        diagnosticModel: structuredClone(diagnosticModel),
        runtime,
      };
      const session = yield* makeJavaSession(client, options);
      if (timing) yield* Deferred.succeed(timing.returned, undefined);
      const current = yield* session.upsert(basis, text, 'java', 1000);
      return {session, current, calls, options};
    });
  return {...f, prepared, basis, uri, text, create};
});
const sessionFixture = makeSessionFixture();
const range = {start: {line: 0, character: 6}, end: {line: 0, character: 10}};

describe('Java session source targets', () => {
  for (const operation of ['query', 'rename', 'diagnostics', 'upsert'] as const) {
    effectIt.effect(`checks SDK integrity after a rejected Java ${operation}`, () =>
      Effect.gen(function* () {
        for (const changed of [false, true]) {
          const f = yield* sessionFixture;
          const gate = {armed: false, responded: false, postflight: false};
          const {session, current} = yield* f.create(
            [],
            undefined,
            undefined,
            {
              projectJavaHome: f.javaHome,
              verify: Effect.suspend(() => {
                if (!gate.responded) return Effect.void;
                gate.postflight = true;
                return changed ? LspFault.make({code: 'prerequisite'}) : Effect.void;
              }),
            },
            () =>
              Effect.suspend(() => {
                if (!gate.armed) return Effect.void;
                gate.responded = true;
                return LspFault.make({code: 'rejected'});
              }),
          );
          gate.armed = true;
          const changedText = 'class Next {}\n';
          const work: Effect.Effect<unknown, unknown> =
            operation === 'query'
              ? session.query('definition', current, range.start, 1000)
              : operation === 'rename'
                ? session.prepare('rename', current, range.start, 'Next', 1000)
                : operation === 'diagnostics'
                  ? session.diagnostics(current, 1000)
                  : session.upsert(
                      {...current, documentVersion: 2, content: sha256HexSync(changedText)},
                      changedText,
                      'java',
                      1000,
                    );
          expect(yield* Effect.flip(work)).toMatchObject({
            _tag: 'LspFault',
            code: changed ? 'prerequisite' : 'rejected',
          });
          expect(gate.postflight).toBe(true);
          // A failed attachment already retires shared state; a read error with conserved inputs does not.
          expect(yield* session.available).toBe(!changed && operation !== 'upsert');
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );
  }

  effectIt.effect('keeps a rejected query postflight interruptible and retires a stalled SDK check', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const entered = yield* Deferred.make<void>();
      const gate = {armed: false, responded: false};
      const {session, current} = yield* f.create(
        [],
        undefined,
        undefined,
        {
          projectJavaHome: f.javaHome,
          verify: Effect.suspend(() =>
            gate.responded ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) : Effect.void,
          ),
        },
        () =>
          Effect.suspend(() => {
            if (!gate.armed) return Effect.void;
            gate.responded = true;
            return LspFault.make({code: 'rejected'});
          }),
      );
      gate.armed = true;
      const reading = yield* Effect.forkChild(session.query('definition', current, range.start, 1000));
      yield* Deferred.await(entered);
      yield* TestClock.adjust(1001);
      expect(yield* Effect.flip(Fiber.join(reading))).toMatchObject({_tag: 'LspFault', code: 'timeout'});
      expect(yield* session.available).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  for (const changeView of [false, true]) {
    effectIt.effect(
      `keeps unreturned diagnostics out of the delivered cursor after ${changeView ? 'a newer view' : 'a newer request'}`,
      () =>
        Effect.gen(function* () {
          const f = yield* sessionFixture;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const gate = {armed: false, checks: 0, total: 0};
          const response: {diagnostics: Schema.Json[]} = {diagnostics: []};
          const {session, current} = yield* f.create(response, undefined, undefined, {
            projectJavaHome: f.javaHome,
            verify: Effect.suspend(() => {
              gate.total++;
              return gate.armed && ++gate.checks === 2
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void;
            }),
          });
          const before = gate.total;
          expect((yield* session.diagnostics(current, 1000)).items).toEqual([]);
          expect(gate.total - before).toBe(2);
          response.diagnostics = [
            {range, severity: 1, code: '1', source: 'Java', message: 'not yet delivered', data: {arguments: []}},
          ];
          gate.armed = true;
          const reading = yield* Effect.forkChild(session.diagnostics(current, 1000));
          yield* Deferred.await(entered);
          const newer = changeView
            ? yield* session.upsert({...current, documentVersion: 2}, f.text, 'java', 1000)
            : current;
          if (changeView) response.diagnostics = [];
          const next = yield* session.diagnostics(newer, 1000);
          yield* Deferred.succeed(release, undefined);
          const obsolete = yield* Effect.exit(Fiber.join(reading));
          expect(obsolete._tag).toBe('Failure');
          expect(next.remaining).toEqual([]);
          expect(next.resolved).toEqual([]);
          expect(next.added).toHaveLength(changeView ? 0 : 1);
          expect(yield* session.available).toBe(true);
          expect(yield* session.observation(current.uri)).toEqual(newer);
        }).pipe(Effect.provide(BunServices.layer)),
    );
  }

  effectIt.effect('captures a diagnostics observation before asynchronous SDK preflight', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gate = {armed: false};
      const {session, current} = yield* f.create([], undefined, undefined, {
        projectJavaHome: f.javaHome,
        verify: Effect.suspend(() => {
          if (!gate.armed) return Effect.void;
          gate.armed = false;
          return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
        }),
      });
      gate.armed = true;
      const requested = structuredClone(current);
      const reading = yield* Effect.forkChild(session.diagnostics(requested, 1000));
      yield* Deferred.await(entered);
      Reflect.set(requested, 'documentVersion', 999);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(reading)).observation).toEqual(current);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  effectIt.effect('retires a rejected source response after private project metadata drift', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const gate = {armed: false};
      const {session, current} = yield* f.create([], undefined, undefined, undefined, () =>
        Effect.gen(function* () {
          if (!gate.armed) return;
          yield* f.fs
            .writeFileString(f.prepared.project + '/.classpath', 'changed private metadata')
            .pipe(Effect.mapError(() => LspFault.make({code: 'write'})));
          return yield* LspFault.make({code: 'rejected'});
        }),
      );
      gate.armed = true;
      expect(yield* Effect.flip(session.query('definition', current, range.start, 1000))).toMatchObject({
        _tag: 'LspFault',
        code: 'prerequisite',
      });
      expect(yield* session.available).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  effectIt.effect('admits the same prepared SDK with a tilde in its physical home and refuses a different SDK', () =>
    Effect.gen(function* () {
      const f = yield* makeSessionFixture('jdk~');
      const {session, current, calls, options} = yield* f.create([]);
      expect(options.diagnosticModel.javaHomeUri).toContain('/jdk~/');
      expect(yield* session.available).toBe(true);
      expect(current.uri).toBe(f.uri);
      expect(EffectArray.some(calls, call => call.method === 'initialize')).toBe(true);
      expect(
        (yield* Effect.exit(f.create([], undefined, undefined, {projectJavaHome: f.root, verify: Effect.void})))._tag,
      ).toBe('Failure');
    }).pipe(Effect.provide(BunServices.layer)),
  );
  effectIt.effect('keeps one admitted diagnostic model after caller-owned model replacement or nested changes', () =>
    Effect.gen(function* () {
      const f = yield* sessionFixture;
      const source = {
        status: 'source',
        location: {uri: f.uri, range, contentSha256: sha256HexSync(f.text), utf16Length: f.text.length},
      };
      for (const replacement of [false, true]) {
        const {session, current, calls, options} = yield* f.create({typeDefinition: source});
        const admitted = structuredClone(options.diagnosticModel);
        if (replacement) {
          Reflect.set(options, 'diagnosticModel', {...admitted, projectUri: 'file:///different-project/'});
        } else {
          Reflect.set(options.diagnosticModel, 'projectUri', 'file:///different-project/');
          Reflect.set(options.diagnosticModel.sourceRoots, '0', 'file:///different-source/');
          Reflect.set(options.diagnosticModel.libraries, '0', 'file:///different-library.jar');
          Reflect.set(
            options.diagnosticModel.compilerOptions!,
            'org.eclipse.jdt.core.compiler.problem.unusedImport',
            'error',
          );
        }
        expect(yield* session.query('type-definition', current, range.start, 1000)).toMatchObject({
          status: 'ok',
          items: [{uri: f.uri, range}],
        });
        expect(EffectArray.findLast(calls, call => call.method === 'workspace/executeCommand')).toMatchObject({
          value: {params: {arguments: [{...admitted}]}},
        });
        expect(yield* session.available).toBe(true);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
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
  effectIt.effect('maps host escaped tildes to Java spelling through the same physical source identity checks', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const directory = f.path.join(f.source, 'Folder~');
      yield* f.fs.makeDirectory(directory);
      const file = f.path.join(directory, 'Main.java');
      yield* f.fs.writeFileString(file, 'class Main {}\n');
      const sourceUri = yield* makeJavaSourceUri([directory]);
      const encoded = (yield* f.path.toFileUrl(file)).href;
      const canonical = (yield* f.path.toFileUrl(f.source)).href + '/Folder~/Main.java';
      expect(yield* sourceUri(encoded)).toBe(canonical);
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
