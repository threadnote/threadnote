import {isJsonObject} from '@threadnote/platform/json';
import * as EffectArray from 'effect/Array';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import {Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {parse as parseJsonc, type ParseError} from 'jsonc-parser';
import {parse as parseToml} from 'smol-toml';
import {Digest, Identifier} from '@threadnote/semantic/contracts';
import {boundedFileDigest, readBoundedText, semanticTreeDigest} from '../fingerprint.js';
import {LspFault} from '../lsp_transport.js';
export const PythonEnvironment = Schema.Struct({id: Identifier, metadataFile: Schema.String, metadataDigest: Digest});
export type PythonEnvironment = typeof PythonEnvironment.Type;
const Metadata = Schema.Struct({
  format: Schema.Literal('threadnote-static-python-environment-v1'),
  version: Schema.Tuple([Schema.Literal(3), Schema.Literal(12), Schema.Literal(13)]),
  prefix: Schema.String,
  // Supplied by the trusted host qualification, never inferred by executing an interpreter or importing a package.
  provenance: Identifier,
  roots: Schema.Array(Schema.Struct({directory: Schema.String, digest: Digest})).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
});
const fail = () => LspFault.make({code: 'prerequisite'});
const staticPath = (value: string) =>
  value.length > 0 && value.length <= 8192 && !/[\p{Cc}:\\$]/u.test(value) && !EffectString.startsWith('~')(value);
const inside = (root: string, file: string, separator: string) =>
  file === root || EffectString.startsWith(root + separator)(file);
const pathProbe = 'd8a7c87965c4ad49200fda06dd4fb09f6229e65c4a188553889562c01c615510';
const versionProbe = '5811c668ec7eb72ffad07fa10823ada5a40e9392137033a876850ac30ebd1230';
const quote = (value: string) => "'" + EffectString.replaceAll("'", "'\\''")(value) + "'";
/** Only the two intrinsic FullAccessHost probes in basedpyright 1.40.2 are supported. No Python code runs. */
export function pythonMetadataResponder(metadata: {
  path: readonly string[];
  prefix: string;
  version: readonly number[];
}) {
  return `import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const a=process.argv.slice(2), m=${JSON.stringify(metadata)};
let kind;
if(a.length===2&&a[0]==='-c'&&createHash('sha256').update(a[1]).digest('hex')==='${pathProbe}')kind='paths';
if(a.length===3&&a[0]==='-I'&&a[1]==='-c'&&createHash('sha256').update(a[2]).digest('hex')==='${versionProbe}')kind='version';
if(!kind)process.exit(64);
const value=kind==='paths'?{path:m.path,prefix:m.prefix}:[...m.version,'final',0];
writeFileSync(new URL('./'+kind+'.ok',import.meta.url),JSON.stringify(value),{mode:0o600});
process.stdout.write(JSON.stringify(value));
`;
}
/** Conservative static profile. Unsupported config/import-hook environments fail explicitly, without guessing. */
export const makePythonProject = Effect.fn('semantic.makePythonProject')(function* (options: {
  readonly project: string;
  readonly worktree: string;
  readonly privateDirectory: string;
  readonly runtime: string;
  readonly environment: PythonEnvironment;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  if (!staticPath(options.runtime) || !staticPath(options.privateDirectory)) return yield* fail();
  const selected = yield* Schema.decodeEffect(PythonEnvironment)(options.environment);
  if (
    !staticPath(selected.metadataFile) ||
    !path.isAbsolute(selected.metadataFile) ||
    (yield* fs.realPath(selected.metadataFile)) !== selected.metadataFile ||
    inside(options.worktree, selected.metadataFile, path.sep) ||
    (yield* boundedFileDigest(selected.metadataFile, 64 * 1024)) !== selected.metadataDigest
  )
    return yield* fail();
  const metadata = yield* readBoundedText(selected.metadataFile, 64 * 1024).pipe(
    Effect.flatMap(text => Effect.try({try: () => JSON.parse(text) as unknown, catch: fail})),
    Effect.flatMap(Schema.decodeUnknownEffect(Metadata)),
  );
  const roots = EffectArray.map(metadata.roots, root => root.directory);
  if (
    new Set(roots).size !== roots.length ||
    !staticPath(metadata.prefix) ||
    !path.isAbsolute(metadata.prefix) ||
    (yield* fs.realPath(metadata.prefix)) !== metadata.prefix ||
    inside(options.worktree, metadata.prefix, path.sep)
  )
    return yield* fail();
  const canonicalDirectory = (directory: string) =>
    Effect.gen(function* () {
      if (
        EffectString.split(path.sep)(directory).includes('.git') ||
        !staticPath(directory) ||
        !path.isAbsolute(directory) ||
        (yield* fs.realPath(directory)) !== directory ||
        (yield* fs.stat(directory)).type !== 'Directory'
      )
        return yield* fail();
    });
  const validatePth = (root: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const pending = [root];
      let count = 0;
      while (pending.length) {
        const directory = pending.pop()!;
        for (const name of yield* fs.readDirectory(directory)) {
          if (name === '.git') continue;
          if (++count > 20000) return yield* fail();
          const file = path.join(directory, name);
          if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return yield* fail();
          const stat = yield* fs.stat(file);
          if (stat.type === 'Directory') pending.push(file);
          else if (EffectString.endsWith('.pth')(name)) {
            for (const raw of EffectString.split(/\r?\n/u)(yield* readBoundedText(file, 64 * 1024))) {
              const line = EffectString.trim(raw);
              if (!line || EffectString.startsWith('#')(line)) continue;
              if (/^import(?:\s|$)/u.test(line)) return yield* fail();
              if (!staticPath(line)) return yield* fail();
              const target = path.resolve(directory, line);
              if (!EffectArray.some([options.worktree, ...roots], base => inside(base, target, path.sep)))
                return yield* fail();
              yield* canonicalDirectory(target);
            }
          }
        }
      }
    });
  let versionFromConfiguration = false;
  const verify = Effect.gen(function* () {
    const configurations = new Set<string>();
    const activeConfigurations = new Set<string>();
    const explicitVersions = new Set<string>();
    const validateConfig = (file: string): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        if (activeConfigurations.has(file)) return yield* fail();
        if (configurations.has(file)) return;
        if (
          configurations.size + activeConfigurations.size >= 64 ||
          EffectString.split(path.sep)(file).includes('.git') ||
          !inside(options.worktree, file, path.sep) ||
          (yield* fs.realPath(file)) !== file
        )
          return yield* fail();
        activeConfigurations.add(file);
        const text = yield* readBoundedText(file, 1024 * 1024);
        const raw = yield* Effect.try({
          try: () => {
            if (EffectString.endsWith('.toml')(file)) {
              const toml = parseToml(text);
              const tool = isJsonObject(toml.tool) ? toml.tool : undefined;
              if (tool?.basedpyright && tool?.pyright) throw new Error('Conflicting analysis sections');
              return tool?.basedpyright ?? tool?.pyright ?? {};
            }
            const errors: ParseError[] = [];
            const json = parseJsonc(text, errors, {allowTrailingComma: true});
            if (errors.length) throw new Error('Invalid configuration');
            return json as unknown;
          },
          catch: fail,
        });
        const config = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(raw);
        for (const [key, value] of EffectRecord.toEntries(config)) {
          if (key === 'extends') {
            if (typeof value !== 'string' || !staticPath(value)) return yield* fail();
            const base = path.resolve(path.dirname(file), value);
            yield* validateConfig(base);
            if (explicitVersions.has(base)) explicitVersions.add(file);
          } else if (['extraPaths', 'stubPath', 'typeshedPath'].includes(key)) {
            const values = key === 'extraPaths' ? value : [value];
            if (!EffectArray.isArray(values) || values.length > 64) return yield* fail();
            for (const item of values) {
              if (
                typeof item !== 'string' ||
                !staticPath(item) ||
                EffectArray.some([...item], character => EffectString.includes(character)('*?[]{}'))
              )
                return yield* fail();
              const target = path.resolve(path.dirname(file), item);
              if (!inside(options.project, target, path.sep)) return yield* fail();
              yield* canonicalDirectory(target);
            }
          } else if (['include', 'exclude', 'ignore', 'strict'].includes(key)) {
            if (
              !EffectArray.isArray(value) ||
              value.length > 256 ||
              EffectArray.some(
                value,
                item =>
                  typeof item !== 'string' ||
                  !staticPath(item) ||
                  path.isAbsolute(item) ||
                  EffectString.split('/')(item).includes('..') ||
                  (['include', 'strict'].includes(key) && EffectString.split('/')(item).includes('.git')),
              )
            )
              return yield* fail();
          } else if (key === 'pythonVersion') {
            if (value !== '3.12') return yield* fail();
            explicitVersions.add(file);
          } else if (key === 'pythonPlatform') {
            if (!['Darwin', 'Linux', 'Windows', 'All'].includes(String(value))) return yield* fail();
          } else if (key === 'typeCheckingMode') {
            if (!['off', 'basic', 'standard', 'strict', 'recommended', 'all'].includes(String(value)))
              return yield* fail();
          } else if (
            EffectString.startsWith('report')(key) ||
            [
              'analyzeUnannotatedFunctions',
              'strictListInference',
              'strictSetInference',
              'strictDictionaryInference',
              'enableTypeIgnoreComments',
              'deprecateTypingAliases',
              'disableBytesTypePromotions',
              'useLibraryCodeForTypes',
              'enableExperimentalFeatures',
            ].includes(key)
          ) {
            if (typeof value !== 'boolean' && !['none', 'information', 'warning', 'error'].includes(String(value)))
              return yield* fail();
          } else return yield* fail();
        }
        activeConfigurations.delete(file);
        configurations.add(file);
      });
    yield* semanticTreeDigest(options.worktree);
    yield* canonicalDirectory(metadata.prefix);
    if ((yield* fs.realPath(selected.metadataFile)) !== selected.metadataFile) return yield* fail();
    if ((yield* boundedFileDigest(selected.metadataFile, 64 * 1024)) !== selected.metadataDigest) return yield* fail();
    for (const root of metadata.roots) {
      yield* canonicalDirectory(root.directory);
      if (
        inside(options.worktree, root.directory, path.sep) ||
        (yield* semanticTreeDigest(root.directory)) !== root.digest
      )
        return yield* fail();
      yield* validatePth(root.directory);
    }
    // basedpyright can fall back above a packaging-only pyproject.toml. No configuration outside this worktree is qualified.
    let ancestor = path.dirname(options.worktree);
    for (;;) {
      for (const name of ['pyrightconfig.json', 'pyproject.toml'])
        if (yield* fs.exists(path.join(ancestor, name))) return yield* fail();
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    // Include nested project configurations; the provider may discover these for imported files.
    const pending = [options.worktree];
    let entries = 0;
    while (pending.length) {
      const directory = pending.pop()!;
      yield* canonicalDirectory(directory);
      for (const name of yield* fs.readDirectory(directory)) {
        if (name === '.git') continue;
        if (++entries > 20000) return yield* fail();
        const file = path.join(directory, name);
        if (Option.isSome(yield* fs.readLink(file).pipe(Effect.option))) return yield* fail();
        if ((yield* fs.stat(file)).type === 'Directory') pending.push(file);
        else if (['pyrightconfig.json', 'pyproject.toml'].includes(name)) yield* validateConfig(file);
      }
    }
    const rootConfig = path.join(
      options.project,
      (yield* fs.exists(path.join(options.project, 'pyrightconfig.json'))) ? 'pyrightconfig.json' : 'pyproject.toml',
    );
    versionFromConfiguration = explicitVersions.has(rootConfig);
    yield* validatePth(options.worktree);
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(Crypto.Crypto, crypto),
  );
  yield* verify;
  yield* fs.makeDirectory(options.privateDirectory, {recursive: true, mode: 0o700});
  if (
    (yield* fs.realPath(options.privateDirectory)) !== path.resolve(options.privateDirectory) ||
    (yield* fs.stat(options.privateDirectory)).mode & 0o077
  )
    return yield* fail();
  const directory = yield* fs.makeTempDirectoryScoped({directory: options.privateDirectory, prefix: 'python-'});
  yield* fs.chmod(directory, 0o700);
  if ((yield* fs.realPath(directory)) !== directory) return yield* fail();
  const responder = path.join(directory, 'metadata.mjs');
  const launcher = path.join(directory, 'python-static');
  const payload = {path: roots, prefix: metadata.prefix, version: metadata.version};
  yield* fs.writeFileString(responder, pythonMetadataResponder(payload), {flag: 'wx', mode: 0o600});
  yield* fs.writeFileString(
    launcher,
    '#!/bin/sh\nexec ' + quote(options.runtime) + ' ' + quote(responder) + ' "$@"\n',
    {flag: 'wx', mode: 0o700},
  );
  // The actual server must successfully consume this responder; unsupported probes never become an empty-path ready state.
  const ready = Effect.gen(function* () {
    const actual = yield* readBoundedText(path.join(directory, 'paths.ok'), 64 * 1024);
    if (actual !== JSON.stringify({path: roots, prefix: metadata.prefix})) return yield* fail();
    if (
      !versionFromConfiguration &&
      (yield* readBoundedText(path.join(directory, 'version.ok'), 256)) !==
        JSON.stringify([...metadata.version, 'final', 0])
    )
      return yield* fail();
  });
  return {
    verify,
    ready,
    roots,
    settings: {
      python: {pythonPath: launcher},
      basedpyright: {
        analysis: {
          autoSearchPaths: false,
          diagnosticMode: 'openFilesOnly',
          baselineMode: 'discard',
          useLibraryCodeForTypes: true,
        },
      },
    } satisfies Schema.Json,
    profile: {
      kind: 'static' as const,
      environment: selected.id,
      version: metadata.version,
      provenance: metadata.provenance,
      prefix: metadata.prefix,
      roots,
      interpreterExecution: false as const,
    },
  };
});
