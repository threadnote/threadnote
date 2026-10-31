import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {Digest, Identifier} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {boundedFileDigest, readBounded, semanticSdkDigest, semanticTreeDigest} from '../fingerprint.js';
import {LspFault} from '../lsp_transport.js';
import {wellFormed} from '../provider.js';
import {makeJavaWorkspace} from './java_runtime.js';

export const JavaEnvironment = Schema.Struct({id: Identifier, metadataFile: Schema.String, metadataDigest: Digest});
export type JavaEnvironment = typeof JavaEnvironment.Type;

/** Host-pinned output of explicit build preparation; attachment never runs a build or imports repository metadata. */
export const JavaProjectModel = Schema.Struct({
  format: Schema.Literal('threadnote-prepared-java-project-v1'),
  build: Schema.Literals(['maven', 'gradle']),
  importer: Schema.Literals(['org.eclipse.m2e.core.maven2Nature', 'org.eclipse.buildship.core.gradleprojectnature']),
  provider: Schema.Literal('jdtls-1.63.0-202610191322'),
  worktree: Schema.String,
  project: Schema.String,
  sourceDigest: Digest,
  javaHome: Schema.String,
  javaSdkDigest: Digest,
  release: Schema.Literal(21),
  sourceRoots: Schema.Array(Schema.Struct({directory: Schema.String, required: Schema.Boolean})).check(
    Schema.isBetweenLength(1, 32),
  ),
  libraries: Schema.Array(Schema.Struct({file: Schema.String, digest: Digest})).check(Schema.isMaxLength(128)),
});
export type JavaProjectModel = typeof JavaProjectModel.Type;

const fail = () => LspFault.make({code: 'prerequisite'});
const inside = (root: string, file: string, separator: string) =>
  root === file || EffectString.startsWith(root + separator)(file);
const xml = (value: string) =>
  EffectString.replaceAll(
    "'",
    '&apos;',
  )(
    EffectString.replaceAll(
      '"',
      '&quot;',
    )(
      EffectString.replaceAll(
        '>',
        '&gt;',
      )(EffectString.replaceAll('<', '&lt;')(EffectString.replaceAll('&', '&amp;')(value))),
    ),
  );

/** Deterministic Eclipse serialization preserves the prepared classpath order. */
export function javaProjectMetadata(sourceUris: readonly string[], libraries: readonly string[]) {
  const links: string[] = [];
  const classpath: string[] = [];
  for (const [index, root] of sourceUris.entries()) {
    const name = `source-${index}`;
    links.push(`<link><name>${name}</name><type>2</type><locationURI>${xml(root)}</locationURI></link>`);
    classpath.push(`<classpathentry kind="src" path="${name}"/>`);
  }
  for (const library of libraries) classpath.push(`<classpathentry kind="lib" path="${xml(library)}"/>`);
  classpath.push(
    '<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21"/>',
  );
  classpath.push('<classpathentry kind="output" path="bin"/>');
  return {
    '.project': `<projectDescription><name>threadnote-java</name><comment/><projects/><buildSpec/><natures><nature>org.eclipse.jdt.core.javanature</nature></natures><linkedResources>${EffectArray.join(links, '')}</linkedResources></projectDescription>`,
    '.classpath': `<classpath>${EffectArray.join(classpath, '')}</classpath>`,
    '.settings/org.eclipse.jdt.core.prefs':
      'eclipse.preferences.version=1\norg.eclipse.jdt.core.compiler.compliance=21\norg.eclipse.jdt.core.compiler.source=21\norg.eclipse.jdt.core.compiler.codegen.targetPlatform=21\norg.eclipse.jdt.core.compiler.release=enabled\norg.eclipse.jdt.core.compiler.processAnnotations=disabled\n',
  };
}

/** One prepared Java 21 source project. Unprepared, changed or ambiguous models fail before provider startup. */
export const makeJavaProject = Effect.fn('semantic.makeJavaProject')(function* (options: {
  readonly project: string;
  readonly worktree: string;
  readonly privateDirectory: string;
  readonly javaHome: string;
  readonly environment: JavaEnvironment;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const selected = yield* Schema.decodeEffect(JavaEnvironment, {onExcessProperty: 'error'})(options.environment);
  const staticPath = (value: string) =>
    value.length > 0 &&
    value.length <= 8192 &&
    wellFormed(value) &&
    !/[\p{Cc}\uFFFE\uFFFF]/u.test(value) &&
    path.isAbsolute(value) &&
    path.resolve(value) === value &&
    !EffectString.split(path.sep)(value).includes('.git');
  const directory = (value: string) =>
    Effect.gen(function* () {
      if (!staticPath(value) || (yield* fs.realPath(value)) !== value || (yield* fs.stat(value)).type !== 'Directory')
        return yield* fail();
    });
  yield* directory(options.worktree);
  yield* directory(options.project);
  if (
    !inside(options.worktree, options.project, path.sep) ||
    !staticPath(selected.metadataFile) ||
    inside(options.worktree, selected.metadataFile, path.sep) ||
    inside(options.worktree, options.javaHome, path.sep) ||
    !staticPath(options.privateDirectory) ||
    inside(options.worktree, options.privateDirectory, path.sep) ||
    inside(options.privateDirectory, options.worktree, path.sep) ||
    inside(options.javaHome, options.privateDirectory, path.sep) ||
    inside(options.privateDirectory, options.javaHome, path.sep)
  )
    return yield* fail();
  if ((yield* fs.realPath(selected.metadataFile)) !== selected.metadataFile) return yield* fail();
  const metadataBytes = yield* readBounded(selected.metadataFile, 128 * 1024);
  if (sha256HexSync(metadataBytes) !== selected.metadataDigest) return yield* fail();
  const model = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(metadataBytes)) as unknown,
    catch: fail,
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(JavaProjectModel, {onExcessProperty: 'error'})));
  if (
    model.project !== options.project ||
    model.worktree !== options.worktree ||
    model.javaHome !== options.javaHome ||
    model.importer !==
      (model.build === 'maven' ? 'org.eclipse.m2e.core.maven2Nature' : 'org.eclipse.buildship.core.gradleprojectnature')
  )
    return yield* fail();
  const roots = EffectArray.map(model.sourceRoots, root => root.directory);
  const libraries = EffectArray.map(model.libraries, library => library.file);
  if (new Set(roots).size !== roots.length || new Set(libraries).size !== libraries.length) return yield* fail();
  for (const [index, root] of roots.entries()) {
    if (!staticPath(root) || !inside(options.worktree, root, path.sep)) return yield* fail();
    if (
      EffectArray.some(roots.slice(index + 1), other => inside(root, other, path.sep) || inside(other, root, path.sep))
    )
      return yield* fail();
  }
  const existing: string[] = [];
  const missing: string[] = [];
  for (const root of model.sourceRoots) {
    if (yield* fs.exists(root.directory)) {
      yield* directory(root.directory);
      existing.push(root.directory);
    } else {
      if (root.required) return yield* fail();
      missing.push(root.directory);
    }
  }
  if (!existing.length) return yield* fail();
  const verify = (projection?: {directory: string; digest: string}) =>
    Effect.gen(function* () {
      yield* directory(options.worktree);
      yield* directory(options.project);
      yield* directory(options.javaHome);
      if (
        (yield* fs.realPath(selected.metadataFile)) !== selected.metadataFile ||
        (yield* boundedFileDigest(selected.metadataFile, 128 * 1024)) !== selected.metadataDigest ||
        (yield* semanticTreeDigest(options.worktree)) !== model.sourceDigest ||
        (yield* semanticSdkDigest(options.javaHome)) !== model.javaSdkDigest
      )
        return yield* fail();
      for (const root of existing) yield* directory(root);
      for (const root of missing) if (yield* fs.exists(root)) return yield* fail();
      let libraryBytes = 0;
      for (const library of model.libraries) {
        if (!staticPath(library.file) || (yield* fs.realPath(library.file)) !== library.file) return yield* fail();
        const stat = yield* fs.stat(library.file);
        libraryBytes += Number(stat.size);
        if (
          stat.type !== 'File' ||
          libraryBytes > 512 * 1024 * 1024 ||
          (yield* boundedFileDigest(library.file, 64 * 1024 * 1024)) !== library.digest
        )
          return yield* fail();
      }
      if (projection && (yield* semanticTreeDigest(projection.directory)) !== projection.digest) return yield* fail();
    });
  yield* verify();
  let ancestor = options.privateDirectory;
  let depth = 0;
  while (!(yield* fs.exists(ancestor))) {
    if (++depth > 128 || path.dirname(ancestor) === ancestor) return yield* fail();
    ancestor = path.dirname(ancestor);
  }
  yield* directory(ancestor);
  yield* fs.makeDirectory(options.privateDirectory, {recursive: true, mode: 0o700});
  yield* directory(options.privateDirectory);
  if ((yield* fs.stat(options.privateDirectory)).mode & 0o077) return yield* fail();
  const workspace = yield* makeJavaWorkspace(options.privateDirectory);
  const privateRoot = workspace.directory;
  const project = path.join(privateRoot, 'project');
  yield* fs.makeDirectory(project, {mode: 0o700});
  yield* fs.makeDirectory(path.join(project, '.settings'), {mode: 0o700});
  const sourceUris = yield* Effect.forEach(existing, root => path.toFileUrl(root).pipe(Effect.map(url => url.href)));
  const files = javaProjectMetadata(sourceUris, libraries);
  for (const [relative, content] of EffectRecord.toEntries(files)) {
    const file = path.join(project, relative);
    yield* fs.writeFileString(file, content, {flag: 'wx', mode: 0o600});
  }
  const verifyProjection = verify({directory: project, digest: yield* semanticTreeDigest(project)});
  yield* verifyProjection;
  return {
    directory: privateRoot,
    workspace,
    project,
    verify: verifyProjection,
    sourceRoots: existing,
    roots: [options.javaHome],
    settings: {
      java: {
        project: {resourceFilters: []},
        autobuild: {enabled: false},
        import: {
          maven: {enabled: false},
          gradle: {enabled: false, wrapper: {enabled: false}, offline: {enabled: true}},
        },
        configuration: {
          updateBuildConfiguration: 'disabled',
          runtimes: [{name: 'JavaSE-21', path: options.javaHome, default: true}],
          annotationProcessing: {enabled: false},
        },
        maven: {downloadSources: false},
      },
    },
    profile: {
      kind: 'java-prepared-offline',
      build: model.build,
      release: model.release,
      environment: selected.id,
      metadataDigest: selected.metadataDigest,
      sourceRoots: existing,
      absentOptionalRoots: missing,
      libraries: model.libraries,
      repositoryExecution: false,
      dependencyAcquisition: false,
    },
  };
});
