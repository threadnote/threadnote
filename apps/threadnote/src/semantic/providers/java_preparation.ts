import {Digest as EffectDigest, SecureRandom} from 'effect/crypto';
import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Clock, Deferred, Effect, Exit, Fiber, FileSystem, Option, Path, Schema} from 'effect';
import {Digest} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {boundedFileDigest, readBounded, semanticSdkDigest, semanticTreeDigest} from '../fingerprint.js';
import {LspFault} from '../lsp_transport.js';
import {wellFormed} from '../provider.js';
import {
  isJavaPreparationRuntime,
  makeJavaPreparationClient,
  type JavaPreparationRuntime,
  type JavaWorkspace,
} from './java_runtime.js';
import {materializeJavaDiagnosticBundle} from './java_diagnostics.js';

const text = Schema.String.check(
  Schema.isMaxLength(8192),
  Schema.makeFilter(wellFormed),
  Schema.isPattern(/^[^\p{Cc}\uFFFE\uFFFF]*$/u),
);
const strings = Schema.Array(text).check(Schema.isMaxLength(128));
const attribute = Schema.Union([
  Schema.Struct({name: text, value: text}),
  Schema.Struct({name: Schema.Literal('javadoc_location'), valueSha256: Digest, access: Schema.Literal('disabled')}),
]);
const entryFields = {
  kind: Schema.Literals([1, 3, 5]),
  contentKind: Schema.Literals([1, 2]),
  path: text,
  exported: Schema.Boolean,
  combineAccessRules: Schema.Boolean,
  inclusions: strings,
  exclusions: strings,
  attributes: Schema.Array(attribute).check(Schema.isMaxLength(32)),
  accessRules: Schema.Array(
    Schema.Struct({pattern: text, kind: Schema.Literals([0, 1, 2]), ignoreIfBetter: Schema.Boolean}),
  ).check(Schema.isMaxLength(32)),
  sourceAttachmentPath: Schema.optional(text),
  sourceAttachmentRoot: Schema.optional(text),
};
const observedEntry = Schema.Struct({
  ...entryFields,
  uri: Schema.optional(text),
  exists: Schema.optional(Schema.Boolean),
  outputUri: Schema.optional(text),
});
const preparedEntry = Schema.Struct({
  ...entryFields,
  exists: Schema.optional(Schema.Boolean),
  output: Schema.optional(text),
});
const resourceFilters = Schema.Array(
  Schema.Struct({
    id: text,
    path: Schema.Literal(''),
    type: Schema.Literal(30),
    matcherId: Schema.Literal('org.eclipse.core.resources.regexFilterMatcher'),
    arguments: Schema.Literal('node_modules|\\.git|__CREATED_BY_JAVA_LANGUAGE_SERVER__'),
  }),
).check(Schema.isMaxLength(1));
const compilerOptions = Schema.Record(Schema.String, text);
const sourceEncoding = Schema.Struct({
  policy: Schema.Literal('utf8-no-bom-v1'),
  sourceCount: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 20000})),
  sourceDigest: Digest,
});
const library = Schema.Struct({
  uri: text,
  sha256: Digest,
  bytes: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 64 * 1024 * 1024})),
});

/** The fixed setup command's successful wire shape. Refusals and unknown fields never become prepared models. */
export const JavaPreparedObservation = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  requestToken: Schema.String.check(Schema.isBetweenLength(1, 128), Schema.isPattern(/^[A-Za-z0-9._-]+$/u)),
  status: Schema.Literal('observed-cached'),
  vm: Schema.Struct({type: text, id: text, name: text, javaHomeUri: text}),
  libraries: Schema.Array(library).check(Schema.isMaxLength(128)),
  model: Schema.Struct({
    projectUri: text,
    build: Schema.Literals(['maven', 'gradle']),
    natures: Schema.Array(text).check(Schema.isMaxLength(8)),
    projectCharset: Schema.Literal('UTF-8'),
    sourceEncoding,
    rawTimestamp: Schema.Int,
    cachedOptionsSha256: Digest,
    compilerOptions,
    outputUri: text,
    resourceFilters,
    rawClasspath: Schema.Array(observedEntry).check(Schema.isMaxLength(162)),
    resolvedClasspath: Schema.Array(observedEntry).check(Schema.isMaxLength(512)),
  }),
});

/** Physical setup URIs are replaced with project-relative paths or sealed, host-owned artifact paths. */
export const JavaPreparedModel = Schema.Struct({
  format: Schema.Literal('threadnote-prepared-java-project-v2'),
  provider: Schema.Literal('jdtls-1.63.0-202610191322'),
  build: Schema.Literals(['maven', 'gradle']),
  project: text,
  worktree: text,
  sourceDigest: Digest,
  javaHome: text,
  javaSdkDigest: Digest,
  projectCharset: Schema.Literal('UTF-8'),
  sourceInputEncoding: Schema.Literal('utf8-original-inputs-v1'),
  sourceEncoding,
  compilerOptions,
  resourceFilters,
  output: text,
  rawClasspath: Schema.Array(preparedEntry).check(Schema.isMaxLength(162)),
  resolvedClasspath: Schema.Array(preparedEntry).check(Schema.isMaxLength(512)),
  libraries: Schema.Array(
    Schema.Struct({
      file: text,
      digest: Digest,
      bytes: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 64 * 1024 * 1024})),
    }),
  ).check(Schema.isMaxLength(128)),
});
export type JavaPreparedModel = typeof JavaPreparedModel.Type;

/** Matches the pinned native UTF-16 path ordering and length framing; caller supplies the complete verified source set. */
export function javaSourceEncodingImage(sources: readonly {readonly name: string; readonly digest: string}[]) {
  const ordered = EffectArray.map(sources, source => ({name: source.name, digest: source.digest})).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return Object.freeze({
    policy: 'utf8-no-bom-v1' as const,
    sourceCount: ordered.length,
    sourceDigest: sha256HexSync(
      'threadnote-java-source-encoding-v1\n' +
        EffectArray.join(
          EffectArray.map(ordered, source => source.name.length + ':' + source.name + source.digest),
          '',
        ),
    ),
  });
}

const fail = () => LspFault.make({code: 'prerequisite'});
const sameIdentity = (a: FileSystem.File.Info, b: FileSystem.File.Info) =>
  a.type === b.type && a.dev === b.dev && Option.isSome(a.ino) && Option.isSome(b.ino) && a.ino.value === b.ino.value;
const ownDirectory = Effect.fn('semantic.ownJavaDirectory')(function* (directory: string, privateMode = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    !Schema.is(text)(directory) ||
    EffectString.split(path.sep)(directory).includes('.git') ||
    (yield* fs.realPath(directory)) !== directory
  )
    return yield* fail();
  const original = yield* fs.stat(directory);
  if (original.type !== 'Directory' || Option.isNone(original.ino) || (privateMode && !!(original.mode & 0o077)))
    return yield* fail();
  const verify = Effect.gen(function* () {
    const current = yield* fs.stat(directory);
    if (
      (yield* fs.realPath(directory)) !== directory ||
      !sameIdentity(original, current) ||
      (privateMode && !!(current.mode & 0o077))
    )
      return yield* fail();
  });
  return {verify};
});

export interface JavaPreparationInputs {
  readonly build: 'maven' | 'gradle';
  readonly worktree: string;
  readonly project: string;
  readonly copiedWorktree: string;
  readonly copiedProject: string;
  readonly sourceDigest: string;
  readonly verify: Effect.Effect<void, unknown>;
}
interface JavaInputProof {
  readonly workspace: JavaWorkspace;
  readonly verifyPreparedOutputs: Effect.Effect<void, unknown>;
  readonly originalFiles: ReadonlyMap<string, string>;
  stage: 'copied' | 'preparing-import' | 'importing' | 'observed' | 'failed';
  runtime?: JavaPreparationRuntime;
  observationDigest?: string;
  outputDigest?: string;
  failure?: LspFault;
}
const inputProofs = new WeakMap<JavaPreparationInputs, JavaInputProof>();
const connectionAdmissions = new WeakMap<object, JavaPreparationRuntime>();

/** Validate persisted UTF-8 preferences and source bytes. Live per-resource charset attestation is a separate model fence. */
export const verifyJavaSourceEncoding = Effect.fn('semantic.verifyJavaSourceEncoding')(function* (
  project: string,
  sourceRoots: readonly string[],
) {
  const roots = [...sourceRoots];
  if (!roots.length || roots.length > 32) return yield* fail();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const owner = yield* ownDirectory(project);
  const sources: {readonly file: string; readonly digest: string}[] = [];
  let preferencesDigest: string | undefined;
  const preferences = path.join(project, '.settings/org.eclipse.core.resources.prefs');
  if (yield* fs.exists(preferences)) {
    if ((yield* fs.realPath(preferences)) !== preferences || (yield* fs.stat(preferences)).type !== 'File')
      return yield* fail();
    const bytes = yield* readBounded(preferences, 64 * 1024);
    preferencesDigest = sha256HexSync(bytes);
    const content = yield* Effect.try({
      try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes),
      catch: fail,
    });
    for (const raw of EffectString.split(/\r\n|\r|\n/u)(content)) {
      const line = EffectString.replace(/^[ \t\f]*/u, '')(raw);
      if (!line || EffectString.startsWith('#')(line) || EffectString.startsWith('!')(line)) continue;
      if (line !== 'eclipse.preferences.version=1' && !/^encoding\/[^\\:= \p{Cc}]*=UTF-8$/u.test(line))
        return yield* fail();
    }
    if (
      (yield* fs.realPath(preferences)) !== preferences ||
      (yield* boundedFileDigest(preferences, 64 * 1024)) !== preferencesDigest
    )
      return yield* fail();
  }
  const pending = [...roots];
  const visited = new Set<string>();
  let entries = 0;
  let bytesRead = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    if (visited.has(directory)) continue;
    if (!EffectString.startsWith(project + path.sep)(directory)) return yield* fail();
    yield* ownDirectory(directory);
    visited.add(directory);
    for (const name of yield* fs.readDirectory(directory)) {
      if (++entries > 20000) return yield* LspFault.make({code: 'capacity'});
      const file = path.join(directory, name);
      if ((yield* fs.realPath(file)) !== file) return yield* fail();
      const info = yield* fs.stat(file);
      if (info.type === 'Directory') pending.push(file);
      else if (info.type === 'File' && EffectString.endsWith('.java')(EffectString.toLowerCase(name))) {
        const bytes = yield* readBounded(file, 4 * 1024 * 1024);
        if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return yield* fail();
        const digest = sha256HexSync(bytes);
        if ((bytesRead += bytes.length) > 256 * 1024 * 1024) return yield* LspFault.make({code: 'capacity'});
        const text = yield* Effect.try({
          try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes),
          catch: fail,
        });
        if (text.length > 2 * 1024 * 1024 || !wellFormed(text)) return yield* LspFault.make({code: 'capacity'});
        sources.push({file, digest});
      } else if (info.type !== 'File') return yield* fail();
    }
  }
  yield* owner.verify;
  return Object.freeze({
    preferencesDigest,
    sources: Object.freeze(EffectArray.map(sources, source => Object.freeze(source))),
  });
});

/** Runtime prelaunch admission checks the original copy receipt, including its cleanup owner. */
export const verifyJavaPreparationInputs = Effect.fn('semantic.verifyJavaPreparationInputs')(function* (
  inputs: JavaPreparationInputs,
  expected: {
    readonly workspace: JavaWorkspace;
    readonly build: 'maven' | 'gradle';
    readonly project: string;
    readonly worktree: string;
  },
) {
  const proof = inputProofs.get(inputs);
  if (
    !proof ||
    proof.stage !== 'copied' ||
    proof.workspace !== expected.workspace ||
    inputs.build !== expected.build ||
    inputs.copiedProject !== expected.project ||
    inputs.worktree !== expected.worktree
  )
    return yield* fail();
  yield* inputs.verify;
});

/** Only the enclosed import can issue this ephemeral first-connection admission. */
export const consumeJavaPreparationConnection = Effect.fn('semantic.consumeJavaPreparationConnection')(function* (
  runtime: JavaPreparationRuntime,
  admission: object,
) {
  const proof = inputProofs.get(runtime.inputs);
  if (
    connectionAdmissions.get(admission) !== runtime ||
    !proof ||
    proof.runtime !== runtime ||
    proof.stage !== 'preparing-import'
  )
    return yield* fail();
  connectionAdmissions.delete(admission);
});

/** Copy the captured worktree inputs, including build configuration. Git payload is not an imported build input. */
export const copyJavaPreparationInputs = Effect.fn('semantic.copyJavaPreparationInputs')(
  function* (options: {
    readonly project: string;
    readonly worktree: string;
    readonly workspace: JavaWorkspace;
    readonly build: 'maven' | 'gradle';
  }) {
    const selected = {...options};
    if (!['maven', 'gradle'].includes(selected.build)) return yield* fail();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const digest = yield* EffectDigest.Digest;
    yield* selected.workspace.verify;
    const {verify: worktreeGuard} = yield* ownDirectory(selected.worktree);
    const {verify: projectGuard} = yield* ownDirectory(selected.project);
    const inside = (root: string, file: string) => root === file || EffectString.startsWith(root + path.sep)(file);
    if (
      !inside(selected.worktree, selected.project) ||
      inside(selected.worktree, selected.workspace.directory) ||
      inside(selected.workspace.directory, selected.worktree)
    )
      return yield* fail();
    const sourceDigest = yield* semanticTreeDigest(selected.worktree);
    const copiedWorktree = path.join(selected.workspace.directory, 'source');
    yield* fs.makeDirectory(copiedWorktree, {mode: 0o700});
    const {verify: copyGuard} = yield* ownDirectory(copiedWorktree, true);
    const entries: {relative: string; original: FileSystem.File.Info; copied: FileSystem.File.Info; digest?: string}[] =
      [];
    const pending = [''];
    let totalBytes = 0;
    while (pending.length) {
      const relative = pending.pop()!;
      const directory = path.join(selected.worktree, relative);
      const names = (yield* fs.readDirectory(directory)).sort();
      if (entries.length + names.length > 20000) return yield* LspFault.make({code: 'capacity'});
      for (const name of names) {
        const next = path.join(relative, name);
        if (next === '.git') continue;
        const original = path.join(selected.worktree, next);
        const copied = path.join(copiedWorktree, next);
        if ((yield* fs.realPath(original)) !== original) return yield* fail();
        const before = yield* fs.stat(original);
        if (Option.isNone(before.ino)) return yield* fail();
        yield* selected.workspace.verify;
        yield* copyGuard;
        if ((yield* fs.realPath(path.dirname(copied))) !== path.dirname(copied)) return yield* fail();
        if (before.type === 'Directory') {
          yield* fs.makeDirectory(copied, {mode: 0o700});
          entries.push({relative: next, original: before, copied: yield* fs.stat(copied)});
          pending.push(next);
        } else if (before.type === 'File') {
          if ((totalBytes += Number(before.size)) > 256 * 1024 * 1024 || Number(before.size) > 32 * 1024 * 1024)
            return yield* LspFault.make({code: 'capacity'});
          const bytes = yield* readBounded(original, 32 * 1024 * 1024);
          if (!sameIdentity(before, yield* fs.stat(original))) return yield* fail();
          yield* fs.writeFile(copied, bytes, {flag: 'wx', mode: before.mode & 0o111 ? 0o700 : 0o600});
          entries.push({
            relative: next,
            original: before,
            copied: yield* fs.stat(copied),
            digest: sha256HexSync(bytes),
          });
        } else return yield* fail();
      }
    }
    const baseline = new Set(EffectArray.map(entries, entry => entry.relative));
    const copiedProject = path.join(copiedWorktree, path.relative(selected.worktree, selected.project));
    const metadataFiles = new Set([
      '.project',
      '.classpath',
      '.factorypath',
      '.settings/org.eclipse.jdt.core.prefs',
      '.settings/org.eclipse.core.resources.prefs',
      '.settings/org.eclipse.jdt.apt.core.prefs',
      selected.build === 'maven'
        ? '.settings/org.eclipse.m2e.core.prefs'
        : '.settings/org.eclipse.buildship.core.prefs',
    ]);
    const verifyInventory = (allowPreparedOutputs: boolean) =>
      Effect.gen(function* () {
        const pending = [copiedWorktree];
        let count = 0;
        let bytes = 0;
        while (pending.length) {
          const directory = pending.pop()!;
          for (const name of yield* fs.readDirectory(directory)) {
            if (++count > 20000) return yield* LspFault.make({code: 'capacity'});
            const file = path.join(directory, name);
            if ((yield* fs.realPath(file)) !== file) return yield* fail();
            const info = yield* fs.stat(file);
            if (info.type !== 'File' && info.type !== 'Directory') return yield* fail();
            if (
              info.type === 'File' &&
              ((bytes += Number(info.size)) > 256 * 1024 * 1024 || Number(info.size) > 32 * 1024 * 1024)
            )
              return yield* LspFault.make({code: 'capacity'});
            if (!baseline.has(path.relative(copiedWorktree, file))) {
              if (!allowPreparedOutputs) return yield* fail();
              if (!inside(copiedProject, file)) return yield* fail();
              const relative = EffectString.replaceAll(path.sep, '/')(path.relative(copiedProject, file));
              const metadata = info.type === 'File' && metadataFiles.has(relative);
              const metadataDirectory = info.type === 'Directory' && relative === '.settings';
              const outputRoot = selected.build === 'maven' ? 'target' : 'build';
              const emptyOutputDirectory =
                info.type === 'Directory' &&
                (relative === outputRoot || EffectString.startsWith(outputRoot + '/')(relative));
              const gradleCache =
                selected.build === 'gradle' &&
                (relative === '.gradle' || EffectString.startsWith('.gradle/')(relative));
              if (!metadata && !metadataDirectory && !emptyOutputDirectory && !gradleCache) return yield* fail();
            }
            if (info.type === 'Directory') pending.push(file);
          }
        }
      });
    const verifyImage = (allowPreparedOutputs: boolean) =>
      Effect.gen(function* () {
        yield* worktreeGuard;
        yield* projectGuard;
        yield* selected.workspace.verify;
        yield* copyGuard;
        yield* verifyInventory(allowPreparedOutputs);
        if ((yield* semanticTreeDigest(selected.worktree)) !== sourceDigest) return yield* fail();
        for (const entry of entries) {
          const original = path.join(selected.worktree, entry.relative);
          const copied = path.join(copiedWorktree, entry.relative);
          const originalInfo = yield* fs.stat(original);
          const copiedInfo = yield* fs.stat(copied);
          if (
            (yield* fs.realPath(original)) !== original ||
            (yield* fs.realPath(copied)) !== copied ||
            !sameIdentity(entry.original, originalInfo) ||
            originalInfo.mode !== entry.original.mode ||
            !sameIdentity(entry.copied, copiedInfo) ||
            copiedInfo.mode !== entry.copied.mode
          )
            return yield* fail();
          if (
            entry.digest !== undefined &&
            ((yield* boundedFileDigest(original, 32 * 1024 * 1024)) !== entry.digest ||
              (yield* boundedFileDigest(copied, 32 * 1024 * 1024)) !== entry.digest)
          )
            return yield* fail();
        }
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(EffectDigest.Digest, digest),
      );
    const verify = verifyImage(false);
    yield* verify;
    const proof = Object.freeze({
      build: selected.build,
      worktree: selected.worktree,
      project: selected.project,
      copiedWorktree,
      copiedProject,
      sourceDigest,
      verify,
    });
    const originalFiles = new Map<string, string>();
    for (const entry of entries)
      if (entry.digest !== undefined) originalFiles.set(path.join(selected.worktree, entry.relative), entry.digest);
    inputProofs.set(proof, {
      workspace: selected.workspace,
      verifyPreparedOutputs: verifyImage(true),
      originalFiles,
      stage: 'copied',
    });
    return proof;
  },
  effect =>
    effect.pipe(
      Effect.timeoutOption(45000),
      Effect.flatMap(result =>
        Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}),
      ),
    ),
);
const jre =
  'org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-21';
const attributes = new Set([
  'maven.pomderived',
  'maven.groupId',
  'maven.artifactId',
  'maven.version',
  'maven.scope',
  'maven.classifier',
  'maven.optionaldependency',
  'optional',
  'test',
  'ignore_optional_problems',
  'm2e-apt',
  'gradle_scope',
  'gradle_used_by_scope',
  'module',
  'without_test_code',
  'limit-modules',
  'add-exports',
  'add-reads',
  'patch-module',
]);

const canonicalJson = (model: Schema.Json): string => {
  const canonical = (value: Schema.Json): Schema.Json => {
    if (EffectArray.isArray<Schema.Json>(value)) return EffectArray.map(value, canonical);
    if (value !== null && typeof value === 'object')
      return EffectRecord.fromEntries(
        EffectArray.map(
          EffectRecord.toEntries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ([key, item]) => [key, canonical(item)],
        ),
      );
    return value;
  };
  return JSON.stringify(canonical(model)) + '\n';
};
/** Serialization is stable under object-key reordering; array order is compiler evidence and must remain intact. */
export function javaPreparedModelJson(model: JavaPreparedModel): string {
  return canonicalJson(model);
}

/** Compare captured entry facts independently of JSON object-key insertion order. */
export function javaPreparedEntryJson(entry: JavaPreparedModel['rawClasspath'][number]): string {
  return canonicalJson(entry);
}

/** Verify host-pinned persisted facts and their private artifact image without importing a build or starting a provider. */
export const loadJavaPreparedModel = Effect.fn('semantic.loadJavaPreparedModel')(
  function* (options: {
    readonly metadataFile: string;
    readonly metadataDigest: string;
    readonly project: string;
    readonly worktree: string;
    readonly javaHome: string;
  }) {
    const selected = yield* Schema.decodeEffect(
      Schema.Struct({
        metadataFile: text,
        metadataDigest: Digest,
        project: text,
        worktree: text,
        javaHome: text,
      }),
      {onExcessProperty: 'error'},
    )({...options}).pipe(Effect.mapError(fail));
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const inside = (root: string, file: string) => root === file || EffectString.startsWith(root + path.sep)(file);
    const artifactRoot = path.dirname(selected.metadataFile);
    if (
      selected.metadataFile !== path.join(artifactRoot, 'model.json') ||
      !inside(selected.worktree, selected.project) ||
      inside(selected.worktree, artifactRoot) ||
      inside(artifactRoot, selected.worktree) ||
      inside(selected.worktree, selected.javaHome) ||
      inside(selected.javaHome, selected.worktree) ||
      inside(selected.javaHome, artifactRoot) ||
      inside(artifactRoot, selected.javaHome)
    )
      return yield* fail();
    const owners = yield* Effect.forEach(
      [
        {directory: artifactRoot, privateMode: true},
        {directory: selected.project, privateMode: false},
        {directory: selected.worktree, privateMode: false},
        {directory: selected.javaHome, privateMode: false},
      ],
      item => ownDirectory(item.directory, item.privateMode),
    );
    const metadataStat = yield* fs.lstat(selected.metadataFile);
    if (
      metadataStat.type !== 'File' ||
      Option.isNone(metadataStat.ino) ||
      (metadataStat.mode & 0o777) !== 0o600 ||
      Number(metadataStat.size) > 256 * 1024 ||
      (yield* fs.realPath(selected.metadataFile)) !== selected.metadataFile
    )
      return yield* fail();
    const bytes = yield* readBounded(selected.metadataFile, 256 * 1024);
    if (Number(metadataStat.size) !== bytes.length || sha256HexSync(bytes) !== selected.metadataDigest)
      return yield* fail();
    const content = yield* Effect.try({
      try: () => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes),
      catch: fail,
    });
    const model = yield* Effect.try({try: () => JSON.parse(content) as unknown, catch: fail}).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(JavaPreparedModel, {onExcessProperty: 'error'})),
      Effect.mapError(fail),
    );
    if (
      model.project !== selected.project ||
      model.worktree !== selected.worktree ||
      model.javaHome !== selected.javaHome ||
      javaPreparedModelJson(model) !== content
    )
      return yield* fail();
    const freeze = (value: Schema.Json): void => {
      if (value !== null && typeof value === 'object') {
        for (const child of EffectArray.isArray<Schema.Json>(value) ? value : EffectRecord.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    freeze(model);
    const expected = new Map<string, {readonly digest: string; readonly bytes: number}>([
      [selected.metadataFile, {digest: selected.metadataDigest, bytes: bytes.length}],
    ]);
    let libraryBytes = 0;
    for (const library of model.libraries) {
      if (
        library.file !== path.join(artifactRoot, library.digest + '.jar') ||
        expected.has(library.file) ||
        (libraryBytes += library.bytes) > 512 * 1024 * 1024
      )
        return yield* fail();
      expected.set(library.file, library);
    }
    const initialFiles = new Map<string, FileSystem.File.Info>([[selected.metadataFile, metadataStat]]);
    for (const file of expected.keys()) {
      if (file === selected.metadataFile) continue;
      const stat = yield* fs.lstat(file);
      if (
        stat.type !== 'File' ||
        Option.isNone(stat.ino) ||
        (stat.mode & 0o777) !== 0o600 ||
        Number(stat.size) !== expected.get(file)!.bytes ||
        (yield* fs.realPath(file)) !== file
      )
        return yield* fail();
      initialFiles.set(file, stat);
    }
    const sourceRoots: string[] = [],
      absentSourceRoots: string[] = [];
    const rootOwners: Effect.Success<ReturnType<typeof ownDirectory>>[] = [];
    const sourceNames = new Set<string>();
    for (const entry of model.rawClasspath) {
      if (entry.kind !== 3) continue;
      if (
        !entry.path ||
        sourceNames.has(entry.path) ||
        /\\/u.test(entry.path) ||
        EffectArray.some(
          EffectString.split('/')(entry.path),
          part => !part || part === '.' || part === '..' || part === '.git',
        ) ||
        entry.exists === undefined
      )
        return yield* fail();
      sourceNames.add(entry.path);
      const root = path.join(selected.project, ...EffectString.split('/')(entry.path));
      if (!inside(selected.project, root) || root === selected.project) return yield* fail();
      if (entry.exists) {
        rootOwners.push(yield* ownDirectory(root));
        sourceRoots.push(root);
      } else {
        if (
          !EffectArray.some(
            entry.attributes,
            attr => attr.name === 'optional' && 'value' in attr && attr.value === 'true',
          )
        )
          return yield* fail();
        absentSourceRoots.push(root);
      }
    }
    if (!sourceRoots.length || sourceNames.size > 32) return yield* fail();
    const absent = (file: string) =>
      Effect.gen(function* () {
        yield* fs.lstat(file).pipe(
          Effect.matchEffect({
            onSuccess: fail,
            onFailure: error => (error.reason._tag === 'NotFound' ? Effect.void : fail()),
          }),
        );
        let ancestor = path.dirname(file);
        for (let depth = 0; depth < 128; depth++) {
          const info = yield* fs
            .lstat(ancestor)
            .pipe(Effect.catchTag('PlatformError', error => (error.reason._tag === 'NotFound' ? Effect.void : fail())));
          if (info) {
            if (info.type !== 'Directory' || (yield* fs.realPath(ancestor)) !== ancestor) return yield* fail();
            return;
          }
          if (ancestor === selected.project || !inside(selected.project, ancestor)) return yield* fail();
          ancestor = path.dirname(ancestor);
        }
        return yield* fail();
      });
    const verifyInventory = Effect.gen(function* () {
      const names = yield* fs.readDirectory(artifactRoot);
      if (
        names.length !== expected.size ||
        EffectArray.some(names, name => !expected.has(path.join(artifactRoot, name)))
      )
        return yield* fail();
    });
    const verifyFile = (file: string) =>
      Effect.gen(function* () {
        const original = initialFiles.get(file)!;
        const pinned = expected.get(file)!;
        const current = yield* fs.lstat(file);
        if (
          current.type !== 'File' ||
          (yield* fs.realPath(file)) !== file ||
          !sameIdentity(original, current) ||
          (current.mode & 0o777) !== 0o600 ||
          Number(current.size) !== pinned.bytes ||
          Option.getOrUndefined(current.mtime)?.getTime() !== Option.getOrUndefined(original.mtime)?.getTime()
        )
          return yield* fail();
      });
    const verifyArtifacts = Effect.gen(function* () {
      yield* verifyInventory;
      for (const [file, pinned] of expected) {
        yield* verifyFile(file);
        if (
          (yield* boundedFileDigest(file, file === selected.metadataFile ? 256 * 1024 : 64 * 1024 * 1024)) !==
          pinned.digest
        )
          return yield* fail();
        yield* verifyFile(file);
      }
      yield* verifyInventory;
    });
    const verifySdk = Effect.gen(function* () {
      if ((yield* semanticSdkDigest(selected.javaHome)) !== model.javaSdkDigest) return yield* fail();
    }).pipe(Effect.asVoid);
    const verifyFingerprints = (sdk: typeof verifySdk) =>
      Effect.gen(function* () {
        if ((yield* semanticTreeDigest(selected.worktree)) !== model.sourceDigest) return yield* fail();
        yield* sdk;
      });
    const verifyUsing = (sdk: typeof verifySdk) =>
      Effect.gen(function* () {
        for (const owner of owners) yield* owner.verify;
        yield* verifyArtifacts;
        yield* verifyFingerprints(sdk);
        for (const owner of rootOwners) yield* owner.verify;
        for (const root of absentSourceRoots) yield* absent(root);
        const encoding = yield* verifyJavaSourceEncoding(selected.project, sourceRoots);
        const image = javaSourceEncodingImage(
          EffectArray.map(encoding.sources, source => ({
            name: EffectArray.join(EffectString.split(path.sep)(path.relative(selected.project, source.file)), '/'),
            digest: source.digest,
          })),
        );
        if (
          image.sourceCount !== model.sourceEncoding.sourceCount ||
          image.sourceDigest !== model.sourceEncoding.sourceDigest
        )
          return yield* fail();
        yield* verifyArtifacts;
        yield* verifyFingerprints(sdk);
        for (const file of expected.keys()) yield* verifyFile(file);
        for (const owner of owners) yield* owner.verify;
        for (const owner of rootOwners) yield* owner.verify;
        for (const root of absentSourceRoots) yield* absent(root);
        yield* verifyInventory;
        return encoding.sources;
      }).pipe(Effect.mapError(error => (Schema.is(LspFault)(error) ? error : fail())));
    const admitted = verifyUsing(verifySdk);
    const verify = admitted.pipe(Effect.asVoid);
    // Per-exchange source checks compose with the full SDK guards at public operation boundaries.
    const verifySource = verifyUsing(Effect.void).pipe(Effect.asVoid);
    // Retain the per-file byte image whose aggregate was checked against the sealed model.
    const sourceBasis = yield* admitted;
    return Object.freeze({
      model,
      sourceBasis,
      sourceRoots: Object.freeze(sourceRoots),
      absentSourceRoots: Object.freeze(absentSourceRoots),
      verify,
      verifySource,
    });
  },
  effect =>
    effect.pipe(
      Effect.mapError(error => (Schema.is(LspFault)(error) ? error : fail())),
      Effect.timeoutOption(45000),
      Effect.flatMap(result =>
        Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}),
      ),
    ),
);

export const javaPreparedModelCommand = 'threadnote.java.preparedProjectModel.v1';
export const JavaPreparationGradle = Schema.Struct({
  sdkDirectory: text,
  sdkDigest: Schema.Literal('6da4ff86101bec03978e03b6acdb2d8ae958759c1da1dc69aa8e1d83f78ff9bc'),
});

/** One fixed import protocol on a genuine setup process. A launch alone never upgrades the copied input proof. */
export const observeJavaPreparedImport = Effect.fn('semantic.observeJavaPreparedImport')(
  function* (options: {readonly runtime: JavaPreparationRuntime; readonly gradle?: typeof JavaPreparationGradle.Type}) {
    const runtime = options.runtime;
    const gradle = options.gradle === undefined ? undefined : {...options.gradle};
    const inputs = runtime.inputs;
    const proof = inputProofs.get(inputs);
    if (!isJavaPreparationRuntime(runtime) || !proof || proof.stage !== 'copied') return yield* fail();
    proof.stage = 'preparing-import';
    proof.runtime = runtime;
    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const random = yield* SecureRandom.SecureRandom;
      const root = proof.workspace.directory;
      if (
        !EffectString.startsWith(root + path.sep)(runtime.directory) ||
        EffectString.startsWith(inputs.copiedWorktree + path.sep)(runtime.directory) ||
        runtime.directory === inputs.copiedWorktree
      )
        return yield* fail();
      const {verify: runtimeOwner} = yield* ownDirectory(runtime.directory, true);
      if (inputs.build === 'gradle') {
        if (!gradle) return yield* fail();
        yield* Schema.decodeEffect(JavaPreparationGradle, {onExcessProperty: 'error'})(gradle);
        yield* ownDirectory(gradle.sdkDirectory);
        if (
          gradle.sdkDirectory === inputs.worktree ||
          EffectString.startsWith(inputs.worktree + path.sep)(gradle.sdkDirectory) ||
          gradle.sdkDirectory === root ||
          EffectString.startsWith(root + path.sep)(gradle.sdkDirectory)
        )
          return yield* fail();
      } else if (gradle) return yield* fail();
      const bundle = yield* materializeJavaDiagnosticBundle(root);
      const verifyHost = Effect.gen(function* () {
        yield* runtime.verify;
        yield* runtimeOwner;
        yield* bundle.verify;
        if (gradle && (yield* semanticSdkDigest(gradle.sdkDirectory)) !== gradle.sdkDigest) return yield* fail();
      });
      yield* verifyHost;
      const mavenSettings = path.join(runtime.directory, 'maven-settings.xml');
      const gradleHome = path.join(runtime.directory, 'gradle');
      const escape = (value: string) =>
        EffectString.replaceAll(
          '>',
          '&gt;',
        )(EffectString.replaceAll('<', '&lt;')(EffectString.replaceAll('&', '&amp;')(value)));
      if (inputs.build === 'maven')
        yield* fs.writeFileString(
          mavenSettings,
          '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"><localRepository>' +
            escape(path.join(runtime.directory, 'm2')) +
            '</localRepository></settings>',
          {flag: 'wx', mode: 0o600},
        );
      else
        yield* fs.writeFileString(
          path.join(gradleHome, 'gradle.properties'),
          'org.gradle.java.installations.auto-detect=false\norg.gradle.java.installations.auto-download=false\norg.gradle.java.installations.paths=' +
            EffectString.replaceAll('\\', '\\\\')(runtime.projectJavaHome) +
            '\norg.gradle.jvmargs=-Xmx256m\n',
          {flag: 'wx', mode: 0o600},
        );
      const settings = {
        java: {
          autobuild: {enabled: false},
          import: {
            maven: {enabled: inputs.build === 'maven', offline: {enabled: true}},
            gradle: {
              enabled: inputs.build === 'gradle',
              offline: {enabled: true},
              wrapper: {enabled: false},
              ...(gradle
                ? {home: gradle.sdkDirectory, user: {home: gradleHome}, java: {home: runtime.projectJavaHome}}
                : {}),
              annotationProcessing: {enabled: false},
            },
          },
          configuration: {
            updateBuildConfiguration: 'automatic',
            runtimes: [{name: 'JavaSE-21', path: runtime.projectJavaHome, default: true}],
            annotationProcessing: {enabled: false},
            ...(inputs.build === 'maven' ? {maven: {userSettings: mavenSettings}} : {}),
          },
          maven: {downloadSources: false},
          referencesCodeLens: {enabled: false},
        },
      };
      const ready = yield* Deferred.make<void, LspFault>();
      const Status = Schema.Struct({type: Schema.Literals(['ServiceReady', 'Error'])});
      const admission = Object.freeze({});
      connectionAdmissions.set(admission, runtime);
      const healthy = Effect.suspend(() => (proof.failure ? Effect.fail(proof.failure) : Effect.void));
      const client = yield* makeJavaPreparationClient(
        runtime,
        admission,
        (method, params) => {
          if (method !== 'language/status' || !Schema.is(Status)(params)) return;
          if (params.type === 'Error') proof.failure = LspFault.make({code: 'prerequisite'});
          Deferred.doneUnsafe(ready, proof.failure ? Effect.fail(proof.failure) : Effect.void);
        },
        settings,
      );
      let initializedClient = false;
      yield* Effect.addFinalizer(() =>
        initializedClient
          ? client.close.pipe(
              Effect.flatMap(receipt =>
                receipt.graceful && receipt.drained && receipt.stdioClosed
                  ? Effect.void
                  : LspFault.make({code: 'exit'}),
              ),
              Effect.orDie,
            )
          : runtime.finish.pipe(
              Effect.flatMap(receipt =>
                receipt.drained && receipt.stdioClosed ? Effect.void : LspFault.make({code: 'exit'}),
              ),
              Effect.orDie,
            ),
      );
      yield* verifyHost;
      // This is the last input admission before the fixed operation that imports this fresh data-directory project.
      yield* inputs.verify;
      yield* healthy;
      proof.stage = 'importing';
      const uri = (yield* path.toFileUrl(inputs.copiedProject)).href;
      const initialized = yield* client.request(
        'initialize',
        {
          processId: null,
          rootUri: uri,
          workspaceFolders: [{uri, name: 'threadnote-private-java21'}],
          capabilities: {general: {positionEncodings: ['utf-16']}, workspace: {configuration: true}},
          initializationOptions: {
            bundles: [bundle.file],
            settings,
            extendedClientCapabilities: {classFileContentsSupport: false, progressReportProvider: true},
          },
        },
        45000,
      );
      const capabilities = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          capabilities: Schema.Struct({
            executeCommandProvider: Schema.Struct({commands: Schema.Array(text).check(Schema.isMaxLength(2048))}),
          }),
        }),
      )(initialized);
      if (!capabilities.capabilities.executeCommandProvider.commands.includes(javaPreparedModelCommand))
        return yield* fail();
      yield* client.notify('initialized', {});
      initializedClient = true;
      yield* client.notify('workspace/didChangeConfiguration', {settings});
      yield* Deferred.await(ready);
      yield* healthy;
      yield* verifyHost;
      yield* proof.verifyPreparedOutputs;
      const outputDigest = yield* semanticTreeDigest(inputs.copiedWorktree);
      const observe = Effect.gen(function* () {
        yield* healthy;
        const requestToken = 'java-prepare-' + (yield* random.uuidV4());
        const raw = yield* client.request(
          'workspace/executeCommand',
          {command: javaPreparedModelCommand, arguments: [{protocolVersion: 1, requestToken}]},
          15000,
        );
        yield* healthy;
        if (new TextEncoder().encode(JSON.stringify(raw)).length > 256 * 1024)
          return yield* LspFault.make({code: 'capacity'});
        const observed = yield* Schema.decodeUnknownEffect(JavaPreparedObservation, {onExcessProperty: 'error'})(raw);
        if (observed.requestToken !== requestToken || observed.model.build !== inputs.build) return yield* fail();
        return observed;
      });
      const observed = yield* observe;
      yield* verifyHost;
      yield* proof.verifyPreparedOutputs;
      // Re-observe cached facts after slow host guards; copied bytes alone cannot attest workspace-cache stability.
      const confirmed = yield* observe;
      if (canonicalJson({...confirmed, requestToken: observed.requestToken}) !== canonicalJson(observed))
        return yield* fail();
      yield* verifyHost;
      if ((yield* semanticTreeDigest(inputs.copiedWorktree)) !== outputDigest) return yield* fail();
      yield* proof.verifyPreparedOutputs;
      yield* healthy;
      proof.outputDigest = outputDigest;
      proof.observationDigest = sha256HexSync(canonicalJson(observed));
      proof.stage = 'observed';
      return observed;
    }).pipe(
      Effect.onExit(exit =>
        Effect.sync(() => {
          if (Exit.isFailure(exit)) proof.stage = 'failed';
        }),
      ),
    );
  },
  effect =>
    effect.pipe(
      Effect.timeoutOption(45000),
      Effect.flatMap(result =>
        Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}),
      ),
    ),
);

export interface JavaPreparedModelOptions {
  readonly requestToken: string;
  readonly build: 'maven' | 'gradle';
  readonly inputs: JavaPreparationInputs;
  readonly runtimeDirectory: string;
  readonly artifactDirectory: string;
  readonly javaHome: string;
  readonly javaSdkDigest: string;
  /** Existing host setup guards; this function cannot authorize or launch repository code. */
  readonly verify: Effect.Effect<void, unknown>;
}

/** Seal one already-observed import. The caller exposes the descriptor only after both setup process owners drain. */
export function sealJavaPreparedModel(input: unknown, options: JavaPreparedModelOptions) {
  // Capture before the first asynchronous guard, so caller mutation cannot substitute another imported model.
  return Effect.try({
    try: () => {
      const captured = structuredClone(input);
      if (new TextEncoder().encode(JSON.stringify(captured)).length > 256 * 1024) throw fail();
      return captured;
    },
    catch: fail,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(JavaPreparedObservation, {onExcessProperty: 'error'})),
    Effect.flatMap(observation => {
      const inputs = options.inputs;
      const selected = {...options, ...inputs, inputs, verify: options.verify};
      return Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const importProof = inputProofs.get(selected.inputs);
        if (
          !importProof ||
          importProof.stage !== 'observed' ||
          importProof.failure ||
          !importProof.runtime ||
          !importProof.outputDigest ||
          importProof.observationDigest !== sha256HexSync(canonicalJson(observation)) ||
          inputs.build !== options.build
        )
          return yield* fail();
        if (
          selected.runtimeDirectory !== importProof.runtime.directory ||
          selected.javaHome !== importProof.runtime.projectJavaHome
        )
          return yield* fail();
        const healthy = Effect.suspend(() => (importProof.failure ? Effect.fail(importProof.failure) : Effect.void));
        const {verify: artifactParentGuard} = yield* ownDirectory(selected.artifactDirectory, true);
        const inside = (root: string, file: string) => root === file || EffectString.startsWith(root + path.sep)(file);
        const staticPath = (file: string) =>
          file.length > 0 &&
          file.length <= 8192 &&
          wellFormed(file) &&
          !/[\p{Cc}\uFFFE\uFFFF]/u.test(file) &&
          path.isAbsolute(file) &&
          path.resolve(file) === file &&
          !EffectString.split(path.sep)(file).includes('.git');
        const directory = (file: string, privateMode = false) =>
          Effect.gen(function* () {
            if (!staticPath(file) || (yield* fs.realPath(file)) !== file) return yield* fail();
            const info = yield* fs.stat(file);
            if (info.type !== 'Directory' || (privateMode && !!(info.mode & 0o077))) return yield* fail();
          });
        for (const file of [
          selected.project,
          selected.worktree,
          selected.copiedWorktree,
          selected.runtimeDirectory,
          selected.artifactDirectory,
          selected.javaHome,
        ])
          yield* directory(file, file === selected.artifactDirectory);
        if (
          !inside(selected.worktree, selected.project) ||
          inside(selected.copiedProject, selected.runtimeDirectory) ||
          inside(selected.runtimeDirectory, selected.copiedProject)
        )
          return yield* fail();
        const scopes = [
          selected.worktree,
          selected.copiedWorktree,
          selected.runtimeDirectory,
          selected.artifactDirectory,
          selected.javaHome,
        ];
        for (const [index, root] of scopes.entries())
          if (EffectArray.some(scopes.slice(index + 1), other => inside(root, other) || inside(other, root)))
            return yield* fail();
        const uriPath = (uri: string) =>
          Effect.gen(function* () {
            const url = yield* Effect.try({try: () => new URL(uri), catch: fail});
            if (url.protocol !== 'file:' || url.host || url.search || url.hash) return yield* fail();
            const file = path.resolve(yield* path.fromFileUrl(url));
            if (!staticPath(file)) return yield* fail();
            return file;
          });
        if (
          observation.requestToken !== selected.requestToken ||
          observation.model.build !== selected.build ||
          (yield* uriPath(observation.model.projectUri)) !== selected.copiedProject ||
          (yield* uriPath(observation.vm.javaHomeUri)) !== selected.javaHome ||
          observation.vm.name !== 'JavaSE-21'
        )
          return yield* fail();
        const importer =
          selected.build === 'maven'
            ? 'org.eclipse.m2e.core.maven2Nature'
            : 'org.eclipse.buildship.core.gradleprojectnature';
        if (
          observation.model.natures.length !== 2 ||
          new Set(observation.model.natures).size !== 2 ||
          !observation.model.natures.includes(importer) ||
          !observation.model.natures.includes('org.eclipse.jdt.core.javanature')
        )
          return yield* fail();
        const compiler = observation.model.compilerOptions;
        const compilerEntries = EffectRecord.toEntries(compiler);
        if (
          compilerEntries.length > 2048 ||
          !compilerEntries.length ||
          EffectArray.some(
            compilerEntries,
            ([key, value]) =>
              !EffectString.startsWith('org.eclipse.jdt.core.compiler.')(key) ||
              !wellFormed(key + value) ||
              /\p{Cc}/u.test(key + value),
          ) ||
          compiler['org.eclipse.jdt.core.compiler.compliance'] !== '21' ||
          compiler['org.eclipse.jdt.core.compiler.source'] !== '21' ||
          compiler['org.eclipse.jdt.core.compiler.codegen.targetPlatform'] !== '21' ||
          compiler['org.eclipse.jdt.core.compiler.release'] !== 'enabled' ||
          compiler['org.eclipse.jdt.core.compiler.processAnnotations'] !== 'disabled'
        )
          return yield* fail();
        const verify = Effect.gen(function* () {
          yield* healthy;
          yield* selected.verify;
          yield* importProof.runtime!.verify;
          yield* importProof.verifyPreparedOutputs;
          if ((yield* semanticTreeDigest(inputs.copiedWorktree)) !== importProof.outputDigest) return yield* fail();
          yield* artifactParentGuard;
          for (const file of scopes) yield* directory(file, file === selected.artifactDirectory);
          if (
            (yield* semanticTreeDigest(selected.worktree)) !== selected.sourceDigest ||
            (yield* semanticSdkDigest(selected.javaHome)) !== selected.javaSdkDigest
          )
            return yield* fail();
          yield* healthy;
        });
        yield* verify;
        const relative = (uri: string) =>
          Effect.gen(function* () {
            const file = yield* uriPath(uri);
            if (!inside(selected.copiedProject, file)) return yield* fail();
            return EffectString.replaceAll(path.sep, '/')(path.relative(selected.copiedProject, file));
          });
        const output = yield* relative(observation.model.outputUri);
        if (!output) return yield* fail();
        return yield* Effect.acquireUseRelease(
          Effect.gen(function* () {
            const remaining = 45000 - ((yield* Clock.currentTimeMillis) - startedAt);
            if (remaining <= 0) return yield* LspFault.make({code: 'timeout'});
            const fiber = yield* fs
              .makeTempDirectory({directory: selected.artifactDirectory, prefix: 'prepared-java-'})
              .pipe(
                Effect.flatMap(directory =>
                  ownDirectory(directory, true).pipe(Effect.map(owner => ({directory, verify: owner.verify}))),
                ),
                Effect.timeoutOption(remaining),
                Effect.interruptible,
                Effect.forkChild,
              );
            const result = yield* Fiber.join(fiber);
            return Option.isSome(result) ? result.value : yield* LspFault.make({code: 'timeout'});
          }),
          owner =>
            Effect.gen(function* () {
              const artifactRoot = owner.directory;
              const artifactGuard = artifactParentGuard.pipe(Effect.andThen(owner.verify));
              const sealed = new Map<string, {file: string; digest: string; bytes: number}>();
              const artifactFiles = new Map<string, FileSystem.File.Info>();
              let totalBytes = 0;
              for (const item of observation.libraries) {
                const file = yield* uriPath(item.uri);
                if (
                  !inside(path.join(selected.runtimeDirectory, 'm2'), file) &&
                  !inside(path.join(selected.runtimeDirectory, 'gradle'), file)
                )
                  return yield* fail();
                if (sealed.has(file) || (totalBytes += item.bytes) > 512 * 1024 * 1024) return yield* fail();
                if ((yield* fs.realPath(file)) !== file || (yield* fs.stat(file)).type !== 'File') return yield* fail();
                const bytes = yield* readBounded(file, 64 * 1024 * 1024);
                if (
                  (yield* fs.realPath(file)) !== file ||
                  bytes.length !== item.bytes ||
                  sha256HexSync(bytes) !== item.sha256
                )
                  return yield* fail();
                const target = path.join(artifactRoot, item.sha256 + '.jar');
                yield* artifactGuard;
                if (!(yield* fs.exists(target))) yield* fs.writeFile(target, bytes, {flag: 'wx', mode: 0o600});
                if ((yield* boundedFileDigest(target, 64 * 1024 * 1024)) !== item.sha256) return yield* fail();
                artifactFiles.set(target, yield* fs.stat(target));
                sealed.set(file, {file: target, digest: item.sha256, bytes: item.bytes});
              }
              const sources = new Map<string, boolean>();
              const verifySource = (name: string, exists: boolean) =>
                Effect.gen(function* () {
                  const original = path.join(selected.project, name);
                  const copied = path.join(selected.copiedProject, name);
                  if ((yield* fs.exists(original)) !== exists || (yield* fs.exists(copied)) !== exists)
                    return yield* fail();
                  if (exists) {
                    yield* directory(original);
                    yield* directory(copied);
                    if ((yield* semanticTreeDigest(original)) !== (yield* semanticTreeDigest(copied)))
                      return yield* fail();
                  }
                });
              let projectName: string | undefined;
              const normalize = (entry: typeof observedEntry.Type) =>
                Effect.gen(function* () {
                  for (const attr of entry.attributes)
                    if (
                      'value' in attr &&
                      (!attributes.has(attr.name) || !wellFormed(attr.value) || /\p{Cc}/u.test(attr.value))
                    )
                      return yield* fail();
                  const {uri, outputUri, ...rest} = entry;
                  const normalized = {...rest};
                  if (entry.kind === 3) {
                    if (
                      entry.contentKind !== 1 ||
                      uri === undefined ||
                      entry.exists === undefined ||
                      entry.sourceAttachmentPath !== undefined ||
                      entry.sourceAttachmentRoot !== undefined
                    )
                      return yield* fail();
                    const name = yield* relative(uri);
                    if (!name || !EffectString.endsWith('/' + name)(entry.path)) return yield* fail();
                    const prefix = EffectString.slice(0, -(name.length + 1))(entry.path);
                    if (!/^\/[^/]+$/u.test(prefix) || (projectName !== undefined && projectName !== prefix))
                      return yield* fail();
                    projectName = prefix;
                    normalized.path = name;
                    yield* verifySource(name, entry.exists);
                    sources.set(name, entry.exists);
                  } else if (entry.kind === 1) {
                    if (
                      entry.contentKind !== 2 ||
                      uri === undefined ||
                      entry.exists !== undefined ||
                      outputUri !== undefined
                    )
                      return yield* fail();
                    const file = yield* uriPath(uri);
                    if (entry.path !== file) return yield* fail();
                    const library = sealed.get(file);
                    if (library) normalized.path = library.file;
                    else if (!inside(selected.javaHome, file)) return yield* fail();
                    if (
                      entry.sourceAttachmentPath !== undefined &&
                      !inside(selected.javaHome, entry.sourceAttachmentPath)
                    )
                      return yield* fail();
                  } else {
                    const importerContainer =
                      selected.build === 'maven'
                        ? 'org.eclipse.m2e.MAVEN2_CLASSPATH_CONTAINER'
                        : 'org.eclipse.buildship.core.gradleclasspathcontainer';
                    if (
                      uri !== undefined ||
                      entry.exists !== undefined ||
                      outputUri !== undefined ||
                      entry.sourceAttachmentPath !== undefined ||
                      entry.sourceAttachmentRoot !== undefined ||
                      ![jre, jre + '/', importerContainer].includes(entry.path)
                    )
                      return yield* fail();
                  }
                  return {...normalized, ...(outputUri === undefined ? {} : {output: yield* relative(outputUri)})};
                });
              const rawClasspath = yield* Effect.forEach(observation.model.rawClasspath, normalize);
              const resolvedClasspath = yield* Effect.forEach(observation.model.resolvedClasspath, normalize);
              const existingSources = EffectArray.map(
                EffectArray.filter(Array.from(sources), ([, exists]) => exists),
                ([name]) => name,
              );
              const originalRoots = EffectArray.map(existingSources, name => path.join(selected.project, name));
              const encoding = yield* verifyJavaSourceEncoding(selected.project, originalRoots);
              const expectedSources = new Set(
                EffectArray.filter(
                  Array.from(importProof.originalFiles.keys()),
                  file =>
                    EffectString.endsWith('.java')(EffectString.toLowerCase(file)) &&
                    EffectArray.some(originalRoots, root => EffectString.startsWith(root + path.sep)(file)),
                ),
              );
              for (const source of encoding.sources)
                if (
                  !expectedSources.delete(source.file) ||
                  importProof.originalFiles.get(source.file) !== source.digest
                )
                  return yield* fail();
              if (
                expectedSources.size ||
                encoding.preferencesDigest !==
                  importProof.originalFiles.get(
                    path.join(selected.project, '.settings/org.eclipse.core.resources.prefs'),
                  )
              )
                return yield* fail();
              const sourceImage = javaSourceEncodingImage(
                EffectArray.map(encoding.sources, source => ({
                  name: EffectArray.join(
                    EffectString.split(path.sep)(path.relative(selected.project, source.file)),
                    '/',
                  ),
                  digest: source.digest,
                })),
              );
              if (
                observation.model.sourceEncoding.sourceCount !== sourceImage.sourceCount ||
                observation.model.sourceEncoding.sourceDigest !== sourceImage.sourceDigest
              )
                return yield* fail();
              const containers = EffectArray.filter(rawClasspath, entry => entry.kind === 5);
              if (
                containers.length !== 2 ||
                EffectArray.filter(containers, entry => entry.path === jre || entry.path === jre + '/').length !== 1 ||
                EffectArray.some(resolvedClasspath, entry => entry.kind === 5) ||
                !EffectArray.some(Array.from(sources.values()), Boolean)
              )
                return yield* fail();
              const referenced = new Set(
                EffectArray.map(
                  EffectArray.filter(resolvedClasspath, entry => entry.kind === 1),
                  entry => entry.path,
                ),
              );
              for (const item of sealed.values()) if (!referenced.has(item.file)) return yield* fail();
              const model = yield* Schema.decodeEffect(JavaPreparedModel, {onExcessProperty: 'error'})({
                format: 'threadnote-prepared-java-project-v2',
                provider: 'jdtls-1.63.0-202610191322',
                build: selected.build,
                project: selected.project,
                worktree: selected.worktree,
                sourceDigest: selected.sourceDigest,
                javaHome: selected.javaHome,
                javaSdkDigest: selected.javaSdkDigest,
                projectCharset: observation.model.projectCharset,
                sourceInputEncoding: 'utf8-original-inputs-v1',
                sourceEncoding: observation.model.sourceEncoding,
                compilerOptions: compiler,
                resourceFilters: observation.model.resourceFilters,
                output,
                rawClasspath,
                resolvedClasspath,
                libraries: Array.from(sealed.values()),
              });
              yield* verify;
              const verifySources = Effect.gen(function* () {
                for (const [name, exists] of sources) yield* verifySource(name, exists);
              });
              yield* verifySources;
              for (const [file, item] of sealed)
                if (
                  (yield* boundedFileDigest(file, 64 * 1024 * 1024)) !== item.digest ||
                  (yield* boundedFileDigest(item.file, 64 * 1024 * 1024)) !== item.digest
                )
                  return yield* fail();
              const metadata = javaPreparedModelJson(model);
              if (new TextEncoder().encode(metadata).length > 256 * 1024) return yield* fail();
              const metadataFile = path.join(artifactRoot, 'model.json');
              yield* artifactGuard;
              yield* fs.writeFileString(metadataFile, metadata, {flag: 'wx', mode: 0o600});
              const metadataDigest = sha256HexSync(metadata);
              if ((yield* boundedFileDigest(metadataFile, 256 * 1024)) !== metadataDigest) return yield* fail();
              artifactFiles.set(metadataFile, yield* fs.stat(metadataFile));
              yield* verify;
              yield* verifySources;
              yield* artifactGuard;
              if ((yield* boundedFileDigest(metadataFile, 256 * 1024)) !== metadataDigest) return yield* fail();
              for (const item of sealed.values())
                if ((yield* boundedFileDigest(item.file, 64 * 1024 * 1024)) !== item.digest) return yield* fail();
              const names = yield* fs.readDirectory(artifactRoot);
              if (names.length !== artifactFiles.size) return yield* fail();
              for (const name of names) {
                const file = path.join(artifactRoot, name);
                const initial = artifactFiles.get(file);
                const current = yield* fs.stat(file);
                if (
                  !initial ||
                  (yield* fs.realPath(file)) !== file ||
                  current.type !== 'File' ||
                  current.mode & 0o077 ||
                  !sameIdentity(initial, current) ||
                  initial.size !== current.size ||
                  Option.getOrUndefined(initial.mtime)?.getTime() !== Option.getOrUndefined(current.mtime)?.getTime()
                )
                  return yield* fail();
              }
              yield* artifactGuard;
              yield* healthy;
              return {model, directory: artifactRoot, metadataFile, metadataDigest};
            }),
          (owner, exit) =>
            Exit.isFailure(exit)
              ? Effect.gen(function* () {
                  const fiber = yield* artifactParentGuard.pipe(
                    Effect.andThen(owner.verify),
                    Effect.matchEffect({
                      onFailure: () => Effect.void,
                      onSuccess: () => fs.remove(owner.directory, {recursive: true}).pipe(Effect.orDie),
                    }),
                    Effect.timeoutOption(30000),
                    Effect.interruptible,
                    Effect.forkChild,
                  );
                  yield* Fiber.await(fiber);
                })
              : Effect.void,
        );
      });
    }),
    Effect.timeoutOption(45000),
    Effect.flatMap(result => (Option.isSome(result) ? Effect.succeed(result.value) : LspFault.make({code: 'timeout'}))),
  );
}
