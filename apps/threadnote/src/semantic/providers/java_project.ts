import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Effect, FileSystem, Option, Path, Schema} from 'effect';
import {Digest, Identifier} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {boundedFileDigest, readBounded, semanticSdkDigest, semanticTreeDigest} from '../fingerprint.js';
import {LspFault} from '../lsp_transport.js';
import {wellFormed} from '../provider.js';
import {makeJavaWorkspace} from './java_runtime.js';
import {JavaCompilerOptions, JavaProjectionImage, javaProjectionDigest} from './java_snapshot.js';

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

/** ASCII Java Properties preserve validated compiler strings independently of the preference reader's charset. */
export function javaCompilerPreferences(options: Readonly<Record<string, string>>) {
  const property = (value: string) => {
    let encoded = '';
    // Properties Unicode escapes represent UTF-16 units, including both halves of supplementary characters.
    for (let index = 0; index < value.length; index++) {
      const unit = Option.getOrThrow(EffectString.charCodeAt(index)(value));
      const character = value[index];
      if (unit < 0x20 || unit > 0x7e) encoded += '\\u' + EffectString.padStart(4, '0')(unit.toString(16));
      else encoded += /[\\ =:#!]/u.test(character) ? '\\' + character : character;
    }
    return encoded;
  };
  const entries = EffectRecord.toEntries(options).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    'eclipse.preferences.version=1\n' +
    EffectArray.join(
      EffectArray.map(entries, ([key, value]) => property(key) + '=' + property(value) + '\n'),
      '',
    )
  );
}

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
    '.settings/org.eclipse.jdt.core.prefs': javaCompilerPreferences({
      'org.eclipse.jdt.core.compiler.compliance': '21',
      'org.eclipse.jdt.core.compiler.source': '21',
      'org.eclipse.jdt.core.compiler.codegen.targetPlatform': '21',
      'org.eclipse.jdt.core.compiler.release': 'enabled',
      'org.eclipse.jdt.core.compiler.processAnnotations': 'disabled',
    }),
  };
}

/** Serialize an already transformed passive image. Filesystem ownership and reconstructed metadata need separate proofs. */
export function javaProjectionMetadata(
  image: typeof JavaProjectionImage.Type,
  compilerOptions: Readonly<Record<string, string>>,
  documentationUri?: string,
) {
  let fixed: typeof JavaProjectionImage.Type;
  let compiler: typeof JavaCompilerOptions.Type;
  try {
    fixed = Schema.decodeSync(JavaProjectionImage, {onExcessProperty: 'error'})(image);
    compiler = Schema.decodeSync(JavaCompilerOptions, {onExcessProperty: 'error'})(compilerOptions);
    javaProjectionDigest(fixed);
  } catch {
    throw fail();
  }
  if (compiler['org.eclipse.jdt.core.compiler.processAnnotations'] !== 'disabled') throw fail();
  const localUri = (value: string) => {
    // URL getters merge absent and empty components; the native URI contract requires both absent.
    if (/[?#]/u.test(value)) throw fail();
    try {
      const url = new URL(value);
      if (url.protocol !== 'file:' || url.host || url.href !== value) throw fail();
      if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@/%-]*$/u.test(url.pathname)) throw fail();
      const decodedPath = decodeURIComponent(url.pathname);
      if (!wellFormed(decodedPath) || /[\p{Cc}\uFFFE\uFFFF]/u.test(decodedPath)) throw fail();
    } catch {
      throw fail();
    }
  };
  if (documentationUri !== undefined) localUri(documentationUri);
  const alias = (value: string, kind: 'source' | 'output') => {
    const match = EffectString.match(new RegExp('^/threadnote-java/' + kind + '-(0|[1-9][0-9]?)$', 'u'))(value);
    if (Option.isNone(match) || Number(match.value[1]) > (kind === 'source' ? 31 : 32)) throw fail();
    return EffectString.slice('/threadnote-java/'.length)(value);
  };
  const portable = (value: string, absolute: boolean) => {
    if (
      !value ||
      /[:\\]/u.test(value) ||
      EffectString.includes('//')(value) ||
      EffectArray.some(EffectString.split('/')(value), part => part === '.' || part === '..') ||
      (absolute && (!EffectString.startsWith('/')(value) || EffectString.endsWith('/')(value)))
    )
      throw fail();
    return value;
  };
  const patterns = (values: readonly string[]) => {
    for (const value of values) {
      portable(value, false);
      if (EffectString.includes('|')(value)) throw fail();
    }
    return EffectArray.join(values, '|');
  };
  const sources = new Set<string>();
  const paths = new Set<string>();
  let containers = 0;
  const entries = EffectArray.map(fixed.rawClasspath, entry => {
    if (paths.has(entry.path)) throw fail();
    paths.add(entry.path);
    let kind: string;
    let entryPath: string;
    if (entry.kind === 3) {
      if (
        entry.contentKind !== 1 ||
        entry.combineAccessRules ||
        entry.exported ||
        entry.accessRules.length ||
        entry.sourceAttachmentPath !== undefined ||
        entry.sourceAttachmentRoot !== undefined
      )
        throw fail();
      kind = 'src';
      entryPath = alias(entry.path, 'source');
      sources.add(entryPath);
    } else {
      if (entry.inclusions.length || entry.exclusions.length || entry.outputPath !== undefined) throw fail();
      if (entry.kind === 5) {
        if (
          entry.path !==
            'org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21' ||
          entry.contentKind !== 1 ||
          !entry.combineAccessRules ||
          entry.sourceAttachmentPath !== undefined ||
          entry.sourceAttachmentRoot !== undefined
        )
          throw fail();
        containers++;
        kind = 'con';
        entryPath = entry.path;
      } else {
        if (entry.contentKind !== 2 || entry.combineAccessRules) throw fail();
        kind = 'lib';
        entryPath = portable(entry.path, true);
        if (EffectString.startsWith('/threadnote-java/')(entryPath)) throw fail();
      }
    }
    let attributes = ` kind="${kind}" path="${xml(entryPath)}"`;
    if (entry.exported) attributes += ' exported="true"';
    if (entry.outputPath !== undefined) attributes += ` output="${alias(entry.outputPath, 'output')}"`;
    if (entry.sourceAttachmentPath !== undefined)
      attributes += ` sourcepath="${xml(portable(entry.sourceAttachmentPath, true))}"`;
    if (entry.sourceAttachmentRoot !== undefined) {
      if (entry.sourceAttachmentPath === undefined) throw fail();
      if (entry.sourceAttachmentRoot) portable(entry.sourceAttachmentRoot, false);
      attributes += ` rootpath="${xml(entry.sourceAttachmentRoot)}"`;
    }
    if (entry.inclusions.length) attributes += ` including="${xml(patterns(entry.inclusions))}"`;
    if (entry.exclusions.length) attributes += ` excluding="${xml(patterns(entry.exclusions))}"`;
    const names = new Set<string>();
    const extras = EffectArray.map(entry.attributes, attribute => {
      if (!attribute.name || names.has(attribute.name)) throw fail();
      names.add(attribute.name);
      let value: string;
      if (attribute.name === 'javadoc_location') {
        if (
          !('valueSha256' in attribute) ||
          documentationUri === undefined ||
          sha256HexSync(documentationUri) !== attribute.valueSha256
        )
          throw fail();
        value = documentationUri;
      } else {
        if (!('value' in attribute)) throw fail();
        value = attribute.value;
      }
      return `<attribute name="${xml(attribute.name)}" value="${xml(value)}"/>`;
    });
    const rules = EffectArray.map(entry.accessRules, rule => {
      portable(rule.pattern, false);
      return `<accessrule kind="${['accessible', 'nonaccessible', 'discouraged'][rule.kind]}" pattern="${xml(rule.pattern)}"${rule.ignoreIfBetter ? ' ignoreifbetter="true"' : ''}/>`;
    });
    return `<classpathentry${attributes}><accessrules>${EffectArray.join(rules, '')}</accessrules><attributes>${EffectArray.join(extras, '')}</attributes></classpathentry>`;
  });
  if (containers !== 1 || sources.size !== fixed.links.length) throw fail();
  const linked = new Set<string>();
  const links = EffectArray.map(fixed.links, link => {
    if (!sources.has(link.path) || linked.has(link.path)) throw fail();
    linked.add(link.path);
    localUri(link.uri);
    return `<link><name>${link.path}</name><type>2</type><locationURI>${xml(link.uri)}</locationURI></link>`;
  });
  const filters = EffectArray.map(fixed.resourceFilters, filter => {
    if (!/^[1-9][0-9]{0,18}$/u.test(filter.id) || BigInt(filter.id) > 9223372036854775807n) throw fail();
    return `<filter><id>${filter.id}</id><name></name><type>30</type><matcher><id>${xml(filter.matcherId)}</id><arguments>${xml(filter.arguments)}</arguments></matcher></filter>`;
  });
  const files = {
    '.project': `<projectDescription><name>threadnote-java</name><comment/><projects/><buildSpec/><natures><nature>org.eclipse.jdt.core.javanature</nature></natures><linkedResources>${EffectArray.join(links, '')}</linkedResources><filteredResources>${EffectArray.join(filters, '')}</filteredResources></projectDescription>`,
    '.classpath': `<classpath>${EffectArray.join(entries, '')}<classpathentry kind="output" path="${alias(fixed.outputPath, 'output')}"/></classpath>`,
    '.settings/org.eclipse.jdt.core.prefs': javaCompilerPreferences(compiler),
    '.settings/org.eclipse.core.resources.prefs': 'eclipse.preferences.version=1\nencoding/<project>=UTF-8\n',
  };
  if (EffectRecord.reduce(files, 0, (bytes, value) => bytes + new TextEncoder().encode(value).length) > 2 * 1024 * 1024)
    throw fail();
  return files;
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
