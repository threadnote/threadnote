import {Array as EffectArray} from 'effect';
import {Crypto, Effect, FileSystem, Option, Path} from 'effect';
import {sha256Hex} from '@threadnote/platform/digest';
import {globToRegExp} from '@threadnote/platform/glob';
import {expandPath} from '@threadnote/platform/paths';
import {SEED_STATE_FILE} from '@threadnote/workspace/constants';
import {parseSeedManifest} from '@threadnote/workspace/manifest';
import type {ProjectManifest} from '@threadnote/workspace/config';
import {SystemInfo} from '@threadnote/platform/system';
import type {CanonicalResourcePolicy} from './refresh.js';
import {stripRecallAnchor} from './lexical.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const SEED_FILE_MTIME_TOLERANCE_MILLISECONDS = 1;

interface SeedStateEntry {
  readonly mtimeMs: number;
  readonly size: number;
}

export function loadCanonicalResourcePolicy<E>(
  config: {readonly agentContextHome: string; readonly manifestPath?: string},
  makeError: (input: {readonly cause: unknown; readonly message: string}) => E,
): Effect.Effect<CanonicalResourcePolicy, never, Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo> {
  const manifestPath = config.manifestPath;
  if (!manifestPath) {
    return Effect.succeed({entryKeyByUri: new Map(), sourcePathByUri: new Map()});
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const manifestRaw = yield* fs.readFileString(manifestPath);
    const manifest = yield* Effect.try({
      try: () => parseSeedManifest(manifestRaw, manifestPath),
      catch: cause => makeError({cause, message: cause instanceof Error ? cause.message : String(cause)}),
    });
    const seedStateRaw = yield* fs.readFileString(pathService.join(config.agentContextHome, SEED_STATE_FILE));
    const seedState = yield* Effect.try({
      try: () => parseSeedState(seedStateRaw),
      catch: cause => makeError({cause, message: cause instanceof Error ? cause.message : String(cause)}),
    });
    const entryKeyByUri = new Map<string, string>();
    const sourcePathByUri = new Map<string, string>();
    for (const [uri, recorded] of [...seedState].sort(([left], [right]) =>
      Effect2.pipe(left, EffectString.localeCompare(right)),
    )) {
      const source = yield* resolveSeededResourceSource(fs, manifest.projects, uri, recorded);
      if (!source) {
        continue;
      }
      const match = seededResourceMatch(manifest.projects, uri);
      if (!match) {
        continue;
      }
      sourcePathByUri.set(uri, source);
      entryKeyByUri.set(
        uri,
        yield* sha256Hex(
          JSON.stringify({
            project: {
              path: yield* expandPath(match.project.path),
              seed: [...match.project.seed],
              uri: normalizedResourceRoot(match.project.uri),
            },
            recorded,
            source,
            uri,
          }),
        ),
      );
    }
    return {entryKeyByUri, sourcePathByUri};
  }).pipe(
    Effect.orElseSucceed(() => ({
      entryKeyByUri: new Map<string, string>(),
      sourcePathByUri: new Map<string, string>(),
    })),
  );
}

function parseSeedState(raw: string): ReadonlyMap<string, SeedStateEntry> {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('files' in value) ||
    typeof value.files !== 'object' ||
    value.files === null
  ) {
    return new Map();
  }
  const entries: Array<[string, SeedStateEntry]> = [];
  // oxlint-disable-next-line effecttsgo/prefer-effect-record -- Persisted cache records are heterogeneous decoded JSON.
  for (const [uri, entry] of Object.entries(value.files)) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'mtimeMs' in entry &&
      typeof entry.mtimeMs === 'number' &&
      Number.isFinite(entry.mtimeMs) &&
      'size' in entry &&
      typeof entry.size === 'number' &&
      Number.isFinite(entry.size)
    ) {
      entries.push([uri, {mtimeMs: entry.mtimeMs, size: entry.size}]);
    }
  }
  return new Map(entries);
}

function resolveSeededResourceSource(
  fs: FileSystem.FileSystem,
  projects: readonly ProjectManifest[],
  uri: string,
  recorded: SeedStateEntry,
): Effect.Effect<string | undefined, never, Path.Path | SystemInfo> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const match = seededResourceMatch(projects, uri);
    if (!match) {
      return undefined;
    }
    const projectRoot = yield* expandPath(match.project.path);
    const sourcePath = pathService.join(projectRoot, ...Effect2.pipe(match.relativePath, EffectString.split('/')));
    const relativeSourcePath = pathService.relative(projectRoot, sourcePath);
    if (
      relativeSourcePath === '' ||
      Effect2.pipe(relativeSourcePath, EffectString.startsWith(`..${pathService.sep}`)) ||
      relativeSourcePath === '..' ||
      pathService.isAbsolute(relativeSourcePath)
    ) {
      return undefined;
    }
    const [realProjectRoot, realSourcePath, info] = yield* Effect.all([
      fs.realPath(projectRoot),
      fs.realPath(sourcePath),
      fs.stat(sourcePath),
    ]);
    const realRelativePath = pathService.relative(realProjectRoot, realSourcePath);
    if (
      Effect2.pipe(realRelativePath, EffectString.startsWith(`..${pathService.sep}`)) ||
      realRelativePath === '..' ||
      pathService.isAbsolute(realRelativePath) ||
      info.type !== 'File' ||
      Number(info.size) !== recorded.size
    ) {
      return undefined;
    }
    const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime();
    if (modifiedAt === undefined || Math.abs(modifiedAt - recorded.mtimeMs) > SEED_FILE_MTIME_TOLERANCE_MILLISECONDS) {
      return undefined;
    }
    return sourcePath;
  }).pipe(Effect.orElseSucceed(() => undefined));
}

function seededResourceMatch(
  projects: readonly ProjectManifest[],
  uri: string,
): {readonly project: ProjectManifest; readonly relativePath: string} | undefined {
  for (const project of projects) {
    const root = normalizedResourceRoot(project.uri);
    if (!Effect2.pipe(uri, EffectString.startsWith(`${root}/`))) {
      continue;
    }
    const relativePath = Effect2.pipe(uri, EffectString.slice(root.length + 1), EffectString.replaceAll('\\', '/'));
    if (
      relativePath.length === 0 ||
      Effect2.pipe(relativePath, EffectString.startsWith('/')) ||
      EffectArray.some(
        Effect2.pipe(relativePath, EffectString.split('/')),
        segment => segment === '' || segment === '.' || segment === '..',
      ) ||
      !EffectArray.some(project.seed, pattern =>
        globToRegExp(Effect2.pipe(pattern, EffectString.replaceAll('\\', '/'))).test(relativePath),
      )
    ) {
      continue;
    }
    return {project, relativePath};
  }
  return undefined;
}

function normalizedResourceRoot(uri: string): string {
  return Effect2.pipe(stripRecallAnchor(uri), EffectString.replace(/\/+$/, ''));
}

export function verifyCanonicalResource(
  fs: FileSystem.FileSystem,
  uri: string,
  indexedContent: string,
  policy: CanonicalResourcePolicy,
): Effect.Effect<boolean, never> {
  const sourcePath = policy.sourcePathByUri.get(uri);
  if (!sourcePath) {
    return Effect.succeed(false);
  }
  return fs.readFileString(sourcePath).pipe(
    Effect.map(sourceContent => sourceContent === indexedContent),
    Effect.orElseSucceed(() => false),
  );
}
