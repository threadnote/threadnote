import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Option, Path, Schema} from 'effect';
import {observeRepositoryBranch} from '@threadnote/graph/repository';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {platformPathFor, SystemInfo} from '@threadnote/platform/system';
import type {ProjectManifest} from '@threadnote/workspace/config';
import {expandPath} from '@threadnote/platform/paths';
import {portablePath} from '../../utils.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const UTF8 = new TextEncoder();
const PATH_BYTES_MAXIMUM = 4_096;

export class ManagerProjectRootError extends Schema.TaggedError<
  ManagerProjectRootError,
  {readonly brand: unique symbol}
>()('ManagerProjectRootError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

export interface ManagerProjectRootValidation {
  readonly fingerprint: string;
  readonly path: string;
}

export interface ManagerObservedProjectSummary {
  readonly branch?: string;
  readonly branchState: 'current' | 'detached' | 'missing' | 'not-observed';
  readonly folder: string;
  readonly name: string;
  readonly path: string;
}

interface ObservedRoot {
  readonly key: string;
  readonly path: string;
  readonly receipt: string;
}

/**
 * Canonicalize one candidate and bind the validation receipt to the other
 * manifest roots. Several graph-scoped projects may intentionally share one
 * monorepo root; their names, resource URIs, and graph definitions remain the
 * distinct routing identities. Missing/foreign paths remain byte-preserved.
 */
export const validateManagerProjectRoots = Effect.fn('managerProjectRoots.validate')(function* (
  projects: readonly ProjectManifest[],
  candidate: ProjectManifest,
) {
  return yield* Effect.gen(function* () {
    const candidateRoot = yield* observeRoot(candidate);
    const observed = yield* Effect.forEach(projects, observeCheapRoot, {concurrency: 16});
    const confirmed: ObservedRoot[] = [];
    for (let index = 0; index < observed.length; index += 1) {
      const cheap = observed[index];
      const root = rootsCanCollide(cheap, candidateRoot) ? yield* observeRoot(projects[index]) : cheap;
      confirmed.push(root);
    }
    return {
      fingerprint: sha256HexSync(
        EffectArray.join(
          EffectArray.map([...confirmed, candidateRoot], root => root.receipt),
          '\n',
        ),
      ),
      path: candidateRoot.path,
    } satisfies ManagerProjectRootValidation;
  }).pipe(
    Effect.timeoutOrElse({
      duration: 10_000,
      orElse: () =>
        Effect.fail(ManagerProjectRootError.make({message: 'Project root validation timed out. Retry shortly.'})),
    }),
  );
});

export const observeManagerManifestProjects = Effect.fn('managerProjectRoots.observeManifestProjects')(function* (
  projects: readonly ProjectManifest[],
  branchObservationMaximum: number,
) {
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  return yield* Effect.forEach(
    projects,
    (project, index) =>
      Effect.gen(function* () {
        if (managerProjectPathIsForeign(project.path, system.platform)) {
          const foreignPath = platformPathFor(system.platform === 'win32' ? 'linux' : 'win32');
          return {
            branchState: 'not-observed' as const,
            folder: foreignPath.basename(project.path) || safeProjectLabel(project.name),
            name: safeProjectLabel(project.name),
            path: safeProjectPath(project.path),
          } satisfies ManagerObservedProjectSummary;
        }
        const localPath = yield* expandPath(project.path);
        const base = {
          folder: path.basename(localPath) || safeProjectLabel(project.name),
          name: safeProjectLabel(project.name),
          path: safeProjectPath(localPath),
        };
        if (index >= branchObservationMaximum) {
          return {...base, branchState: 'not-observed' as const} satisfies ManagerObservedProjectSummary;
        }
        const branch = yield* observeRepositoryBranch(localPath);
        return {
          ...base,
          ...(branch.state === 'current' ? {branch: branch.branch} : {}),
          branchState: branch.state,
        } satisfies ManagerObservedProjectSummary;
      }),
    {concurrency: 16},
  );
});

const observeCheapRoot = Effect.fn('managerProjectRoots.observeCheap')(function* (project: ProjectManifest) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  if (managerProjectPathIsForeign(project.path, system.platform)) return foreignRoot(project.path, system.platform);
  const expanded = yield* expandPath(project.path);
  const info = yield* fs.stat(expanded).pipe(
    Effect.asSome,
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.succeedNone,
    ),
    Effect.mapError(() =>
      ManagerProjectRootError.make({message: 'A configured project root could not be observed safely.'}),
    ),
  );
  if (Option.isNone(info)) return yield* missingRoot(fs, path, project.path, expanded, system.platform);
  if (info.value.type !== 'Directory') {
    return yield* ManagerProjectRootError.make({message: 'Project path must identify a directory when it exists.'});
  }
  const canonical = yield* fs
    .realPath(expanded)
    .pipe(
      Effect.mapError(() =>
        ManagerProjectRootError.make({message: 'A configured project root changed while it was observed.'}),
      ),
    );
  return presentRoot(project.path, canonical, info.value, system.platform);
});

const observeRoot = Effect.fn('managerProjectRoots.observe')(function* (project: ProjectManifest) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const cheap = yield* observeCheapRoot(project);
  if (!Effect2.pipe(cheap.key, EffectString.startsWith('present:'))) return cheap;
  const expanded = yield* expandPath(project.path);
  const result = yield* runCommandEffect(
    'git',
    ['-C', expanded, 'rev-parse', '--path-format=absolute', '--show-toplevel'],
    {allowFailure: true, maxOutputBytes: PATH_BYTES_MAXIMUM, timeoutMs: 5_000},
  ).pipe(
    Effect.mapError(() =>
      ManagerProjectRootError.make({message: 'A configured project root could not be observed safely.'}),
    ),
  );
  if (result.exitCode === 124 || result.exitCode === 127) {
    return yield* ManagerProjectRootError.make({message: 'Git could not inspect the configured project root safely.'});
  }
  const rawRoot = result.exitCode === 0 ? Effect2.pipe(result.stdout, EffectString.replace(/\r?\n$/u, '')) : expanded;
  if (
    rawRoot.length === 0 ||
    Effect2.pipe(rawRoot, EffectString.includes('\n')) ||
    Effect2.pipe(rawRoot, EffectString.includes('\r')) ||
    !path.isAbsolute(rawRoot) ||
    UTF8.encode(rawRoot).byteLength > PATH_BYTES_MAXIMUM
  ) {
    return yield* ManagerProjectRootError.make({message: 'A configured project root is invalid.'});
  }
  const canonical = yield* fs
    .realPath(rawRoot)
    .pipe(Effect.mapError(() => ManagerProjectRootError.make({message: 'A configured project root disappeared.'})));
  const info = yield* fs
    .stat(canonical)
    .pipe(Effect.mapError(() => ManagerProjectRootError.make({message: 'A configured project root disappeared.'})));
  if (info.type !== 'Directory') {
    return yield* ManagerProjectRootError.make({message: 'Project path must identify a repository directory.'});
  }
  const root = presentRoot(project.path, canonical, info, system.platform);
  const storedPath = yield* portablePath(canonical);
  if (!managerProjectStoredPathIsSafe(storedPath)) {
    return yield* ManagerProjectRootError.make({message: 'The canonical project root cannot be stored safely.'});
  }
  return {...root, path: storedPath};
});

function rootsCanCollide(left: ObservedRoot, right: ObservedRoot): boolean {
  if (left.key === right.key) return true;
  if (
    !Effect2.pipe(left.key, EffectString.startsWith('present:')) ||
    !Effect2.pipe(right.key, EffectString.startsWith('present:'))
  )
    return false;
  const leftPath = Effect2.pipe(left.key, EffectString.slice('present:'.length));
  const rightPath = Effect2.pipe(right.key, EffectString.slice('present:'.length));
  return (
    Effect2.pipe(leftPath, EffectString.startsWith(`${rightPath}/`)) ||
    Effect2.pipe(leftPath, EffectString.startsWith(`${rightPath}\\`)) ||
    Effect2.pipe(rightPath, EffectString.startsWith(`${leftPath}/`)) ||
    Effect2.pipe(rightPath, EffectString.startsWith(`${leftPath}\\`))
  );
}

function foreignRoot(value: string, platform: NodeJS.Platform): ObservedRoot {
  const foreignPath = platformPathFor(platform === 'win32' ? 'linux' : 'win32');
  const raw = foreignPath.normalize(value);
  const normalized = platform === 'win32' ? raw : Effect2.pipe(raw, EffectString.toLowerCase);
  return {key: `foreign:${normalized}`, path: value, receipt: `foreign:${normalized}`};
}

const missingRoot = Effect.fn('managerProjectRoots.missing')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  value: string,
  expanded: string,
  platform: NodeJS.Platform,
) {
  let current = expanded;
  const suffix: string[] = [];
  let ancestorInfo: FileSystem.File.Info | undefined;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) break;
    const info = yield* fs.stat(current).pipe(
      Effect.asSome,
      Effect.catchIf(
        error => error.reason._tag === 'NotFound',
        () => Effect.succeedNone,
      ),
      Effect.mapError(() =>
        ManagerProjectRootError.make({message: 'A configured project ancestor could not be observed safely.'}),
      ),
    );
    if (Option.isSome(info)) {
      ancestorInfo = info.value;
      break;
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
  if (ancestorInfo === undefined) {
    ancestorInfo = yield* fs
      .stat(current)
      .pipe(
        Effect.mapError(() =>
          ManagerProjectRootError.make({message: 'A configured project ancestor could not be observed safely.'}),
        ),
      );
  }
  if (ancestorInfo.type !== 'Directory') {
    return yield* ManagerProjectRootError.make({message: 'Project path must identify a directory when it exists.'});
  }
  const realAncestor = yield* fs
    .realPath(current)
    .pipe(
      Effect.mapError(() =>
        ManagerProjectRootError.make({message: 'A configured project ancestor could not be observed safely.'}),
      ),
    );
  const canonicalInfo = yield* fs
    .stat(realAncestor)
    .pipe(
      Effect.mapError(() =>
        ManagerProjectRootError.make({message: 'A configured project ancestor changed while it was observed.'}),
      ),
    );
  if (canonicalInfo.type !== 'Directory' || fileIdentity(canonicalInfo) !== fileIdentity(ancestorInfo)) {
    return yield* ManagerProjectRootError.make({
      message: 'A configured project ancestor changed while it was observed.',
    });
  }
  const normalized = rootKey(path.join(realAncestor, ...suffix), platform);
  return {
    key: `missing:${normalized}`,
    path: value,
    receipt: `missing:${normalized}:${rootKey(realAncestor, platform)}:${fileIdentity(canonicalInfo)}`,
  } satisfies ObservedRoot;
});

function presentRoot(
  value: string,
  canonical: string,
  info: FileSystem.File.Info,
  platform: NodeJS.Platform,
): ObservedRoot {
  const key = rootKey(canonical, platform);
  return {
    key: `present:${key}`,
    path: value,
    receipt: `present:${key}:${fileIdentity(info)}`,
  };
}

function fileIdentity(info: FileSystem.File.Info): string {
  const inode = Option.getOrUndefined(info.ino);
  return `${String(info.dev)}:${inode === undefined ? 'unknown' : String(inode)}`;
}

function rootKey(value: string, platform: NodeJS.Platform): string {
  const normalized = Effect2.pipe(platformPathFor(platform).normalize(value), EffectString.replace(/[\\/]+$/u, ''));
  return platform === 'win32' ? Effect2.pipe(normalized, EffectString.toLowerCase) : normalized;
}

export function managerProjectPathIsForeign(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? Effect2.pipe(value, EffectString.startsWith('/'))
    : /^[a-z]:[\\/]/iu.test(value) || /^\\\\/u.test(value) || Effect2.pipe(value, EffectString.startsWith('~\\'));
}

function managerProjectStoredPathIsSafe(value: string): boolean {
  if (value.length === 0 || UTF8.encode(value).byteLength > PATH_BYTES_MAXIMUM) return false;
  for (const character of value) {
    const codePoint = Effect2.pipe(
      character,
      EffectString.codePointAt(0),
      Effect2.Option.getOrElse(() => undefined),
    )!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  return true;
}

function safeProjectLabel(value: string): string {
  return (
    Effect2.pipe(value, EffectString.replace(/[\r\n\t\0]/gu, ' '), EffectString.trim, EffectString.slice(0, 256)) ||
    'unknown'
  );
}

function safeProjectPath(value: string): string {
  return Effect2.pipe(
    value,
    EffectString.replace(/[\r\n\t\0]/gu, ' '),
    EffectString.trim,
    EffectString.slice(0, PATH_BYTES_MAXIMUM),
  );
}
