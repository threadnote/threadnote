import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Option, Path} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runCommandEffect, type CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {inspectContainedStableRegularFile, materializeContainedStableRegularFile} from './inventory/contained_file.js';
import {parsePorcelainV1Status} from './inventory/porcelain.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export interface LiveWorktreeObservationLimits {
  readonly timeoutMs?: number;
  readonly maxGitOutputBytes?: number;
  readonly maxChangedFiles?: number;
  readonly maxReadBytes?: number;
}

export type LiveWorktreeObservation =
  | {
      readonly state: 'complete';
      readonly revision: string;
      readonly headCommit: string;
      readonly watchDirectories: readonly string[];
    }
  | {readonly state: 'unavailable'; readonly reason: 'budget' | 'missing' | 'unstable' | 'error'};

const DEFAULTS = {
  timeoutMs: 10_000,
  maxGitOutputBytes: 1_048_576,
  maxChangedFiles: 256,
  maxReadBytes: 64 * 1_048_576,
} as const;
type ObservationUnavailable = {
  readonly _tag: 'ObservationUnavailable';
  readonly reason: 'budget' | 'missing' | 'unstable' | 'error';
};
const unavailable = (reason: ObservationUnavailable['reason']): ObservationUnavailable => ({
  _tag: 'ObservationUnavailable',
  reason,
});
const validRelative = (value: string) =>
  value.length > 0 &&
  !Effect2.pipe(value, EffectString.startsWith('/')) &&
  !Effect2.pipe(value, EffectString.includes('\\')) &&
  EffectArray.every(
    Effect2.pipe(value, EffectString.split('/')),
    segment => segment !== '' && segment !== '.' && segment !== '..' && segment !== '.git',
  ) &&
  !Effect2.pipe(value, EffectString.includes('\0'));

/** Passive, bounded observation of one registered worktree. It never prepares a graph. */
export const observeLiveWorktree = (
  cwd: string,
  requested: LiveWorktreeObservationLimits = {},
): Effect.Effect<LiveWorktreeObservation, never, FileSystem.FileSystem | Path.Path | CommandExecutor | SystemInfo> => {
  const limits = {
    timeoutMs: Math.min(requested.timeoutMs ?? DEFAULTS.timeoutMs, DEFAULTS.timeoutMs),
    maxGitOutputBytes: Math.min(requested.maxGitOutputBytes ?? DEFAULTS.maxGitOutputBytes, DEFAULTS.maxGitOutputBytes),
    maxChangedFiles: Math.min(requested.maxChangedFiles ?? DEFAULTS.maxChangedFiles, DEFAULTS.maxChangedFiles),
    maxReadBytes: Math.min(requested.maxReadBytes ?? DEFAULTS.maxReadBytes, DEFAULTS.maxReadBytes),
  };
  if (EffectArray.some(EffectRecord.values(limits), value => !Number.isSafeInteger(value) || value <= 0))
    return Effect.succeed({state: 'unavailable', reason: 'budget'});

  const probe = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = (args: readonly string[]) =>
      runCommandEffect('git', ['--no-optional-locks', '-C', cwd, ...args], {
        maxOutputBytes: limits.maxGitOutputBytes,
        timeoutMs: limits.timeoutMs,
      }).pipe(
        Effect.mapBoth({
          onSuccess: result => result.stdout,
          onFailure: error =>
            unavailable(
              error._tag === 'CommandOutputLimitExceeded' || error._tag === 'CommandTimedOut' ? 'budget' : 'error',
            ),
        }),
      );
    const metadata = Effect2.pipe(
      yield* git([
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-dir',
        '--git-common-dir',
        'HEAD',
      ]).pipe(Effect.mapError(error => (error.reason === 'error' ? unavailable('missing') : error))),
      EffectString.trimEnd,
      EffectString.split('\n'),
    );
    if (
      metadata.length !== 4 ||
      Boolean(EffectArray.some(metadata, value => !value)) ||
      !/^[0-9a-f]{40,64}$/.test(metadata[3])
    )
      return yield* Effect.fail(unavailable('missing'));
    const [rawRoot, rawGitDir, rawCommonDir, headCommit] = metadata;
    const root = yield* fs.realPath(rawRoot).pipe(Effect.mapError(() => unavailable('missing')));
    const gitDir = yield* fs
      .realPath(path.resolve(root, rawGitDir))
      .pipe(Effect.mapError(() => unavailable('missing')));
    const commonDir = yield* fs
      .realPath(path.resolve(root, rawCommonDir))
      .pipe(Effect.mapError(() => unavailable('missing')));
    const canonicalCwd = yield* fs.realPath(cwd).pipe(Effect.mapError(() => unavailable('missing')));
    if (canonicalCwd !== root && !Effect2.pipe(canonicalCwd, EffectString.startsWith(root + path.sep)))
      return yield* Effect.fail(unavailable('missing'));
    const statusArgs = [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--renames',
      '--ignore-submodules=none',
    ] as const;
    const stageArgs = ['diff', '--cached', '--raw', '-z', '--no-ext-diff'] as const;
    const configArgs = ['config', '--list', '--show-origin', '-z'] as const;
    const indexFlagsArgs = ['ls-files', '-v', '-z'] as const;
    const excludes = yield* runCommandEffect(
      'git',
      ['--no-optional-locks', '-C', cwd, 'config', '--path', '--get', 'core.excludesFile'],
      {
        allowFailure: true,
        maxOutputBytes: limits.maxGitOutputBytes,
        timeoutMs: limits.timeoutMs,
      },
    ).pipe(Effect.mapError(() => unavailable('error')));
    if (excludes.exitCode > 1) return yield* Effect.fail(unavailable('error'));
    const externalExcludes = excludes.exitCode === 0 ? Effect2.pipe(excludes.stdout, EffectString.trimEnd) : undefined;
    if (externalExcludes !== undefined && !path.isAbsolute(externalExcludes))
      return yield* Effect.fail(unavailable('error'));
    const controlPaths = [
      path.join(root, '.threadnoteignore.local'),
      path.join(commonDir, 'info', 'exclude'),
      ...(externalExcludes === undefined ? [] : [externalExcludes]),
    ];
    let spentBytes = 0;
    const controlRows = Effect.gen(function* () {
      const rows: string[] = [];
      for (const target of controlPaths) {
        if (!(yield* fs.exists(target))) {
          rows.push(`${target}\0missing`);
          continue;
        }
        const link = yield* fs.readLink(target).pipe(Effect.option);
        if (link._tag === 'Some') return yield* Effect.fail(unavailable('error'));
        const before = yield* fs.stat(target).pipe(Effect.mapError(() => unavailable('unstable')));
        if (before.type !== 'File' || before.size > BigInt(limits.maxReadBytes - spentBytes))
          return yield* Effect.fail(unavailable('budget'));
        const size = Number(before.size);
        const hash = yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(target, {flag: 'r'}).pipe(Effect.mapError(() => unavailable('unstable')));
            const opened = yield* file.stat;
            if (opened.type !== 'File' || opened.size !== before.size)
              return yield* Effect.fail(unavailable('unstable'));
            const bytes = new Uint8Array(size + 1);
            let offset = 0;
            while (offset < bytes.length) {
              const count = Number(yield* file.read(bytes.subarray(offset)));
              if (count === 0) break;
              offset += count;
            }
            const after = yield* file.stat;
            if (
              offset !== size ||
              after.size !== before.size ||
              Option.getOrUndefined(after.mtime)?.getTime() !== Option.getOrUndefined(before.mtime)?.getTime()
            )
              return yield* Effect.fail(unavailable('unstable'));
            return sha256HexSync(bytes.subarray(0, size));
          }),
        );
        const after = yield* fs.stat(target).pipe(Effect.mapError(() => unavailable('unstable')));
        if (
          after.size !== before.size ||
          Option.getOrUndefined(after.mtime)?.getTime() !== Option.getOrUndefined(before.mtime)?.getTime()
        )
          return yield* Effect.fail(unavailable('unstable'));
        spentBytes += size;
        rows.push(`${target}\0${hash}`);
      }
      return rows;
    });
    const config = yield* git(configArgs);
    const indexFlags = yield* git(indexFlagsArgs);
    // Git deliberately hides these paths from status. Without inspecting their
    // entire content set we cannot claim complete passive source coverage.
    if (
      EffectArray.some(Effect2.pipe(indexFlags, EffectString.split('\0')), row =>
        Boolean(row && (row[0] === 'S' || row[0] === Effect2.pipe(row[0], EffectString.toLowerCase))),
      )
    )
      return yield* Effect.fail(unavailable('error'));
    const controls = yield* controlRows;
    const status = yield* git(statusArgs);
    const staged = yield* git(stageArgs);
    const overlay = parsePorcelainV1Status(status);
    const absent = new Set(overlay.deleted);
    for (const record of Effect2.pipe(status, EffectString.split('\0'))) {
      if (record.length >= 4 && record[2] === ' ' && record[1] === 'D' && record[0] !== 'U')
        absent.add(Effect2.pipe(record, EffectString.slice(3)));
    }
    const changed = EffectArray.filter([...overlay.changed], relative => !absent.has(relative)).sort();
    const listed = new Set([...changed, ...absent]);
    if (listed.size > limits.maxChangedFiles) return yield* Effect.fail(unavailable('budget'));
    if (EffectArray.some([...listed], relative => !validRelative(relative)))
      return yield* Effect.fail(unavailable('error'));

    // Metadata admission is separate from reads, so a large dirty set fails before any content work.
    let total = 0;
    const sizes = new Map<string, number>();
    for (const relative of changed) {
      const metadata = yield* inspectContainedStableRegularFile(fs, path, root, relative).pipe(
        Effect.mapError(() => unavailable('unstable')),
      );
      total += metadata.size;
      if (total + spentBytes > limits.maxReadBytes) return yield* Effect.fail(unavailable('budget'));
      sizes.set(relative, metadata.size);
    }
    const readRows = Effect.gen(function* () {
      const rows: string[] = [];
      for (const relative of changed) {
        const size = sizes.get(relative)!;
        if (spentBytes + size > limits.maxReadBytes) return yield* Effect.fail(unavailable('budget'));
        const file = yield* materializeContainedStableRegularFile(
          fs,
          path,
          root,
          relative,
          () => true,
          sizes.get(relative),
        ).pipe(Effect.mapError(() => unavailable('unstable')));
        spentBytes += size;
        rows.push(`${relative}\0${file.contentHash}`);
      }
      return rows;
    });
    const first = yield* readRows;
    const second = yield* readRows;
    if (EffectArray.some(first, (row, index) => row !== second[index]))
      return yield* Effect.fail(unavailable('unstable'));
    const finalStatus = yield* git(statusArgs);
    const finalStaged = yield* git(stageArgs);
    const finalConfig = yield* git(configArgs);
    const finalIndexFlags = yield* git(indexFlagsArgs);
    const finalExcludes = yield* runCommandEffect(
      'git',
      ['--no-optional-locks', '-C', cwd, 'config', '--path', '--get', 'core.excludesFile'],
      {
        allowFailure: true,
        maxOutputBytes: limits.maxGitOutputBytes,
        timeoutMs: limits.timeoutMs,
      },
    ).pipe(Effect.mapError(() => unavailable('error')));
    const finalControls = yield* controlRows;
    const finalMetadata = Effect2.pipe(
      yield* git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir', 'HEAD']),
      EffectString.trimEnd,
    );
    if (
      status !== finalStatus ||
      staged !== finalStaged ||
      config !== finalConfig ||
      indexFlags !== finalIndexFlags ||
      excludes.exitCode !== finalExcludes.exitCode ||
      excludes.stdout !== finalExcludes.stdout ||
      EffectArray.some(controls, (row, index) => row !== finalControls[index]) ||
      EffectArray.join(metadata, '\n') !== finalMetadata
    )
      return yield* Effect.fail(unavailable('unstable'));
    return {
      state: 'complete' as const,
      revision: sha256HexSync(
        EffectArray.join(
          ['live-worktree-v1', root, gitDir, commonDir, headCommit, status, staged, config, ...controls, ...first],
          '\0',
        ),
      ),
      headCommit,
      watchDirectories: [...new Set([gitDir, commonDir])],
    };
  });
  return probe.pipe(
    Effect.timeout(limits.timeoutMs),
    Effect.catch(error =>
      Effect.succeed({
        state: 'unavailable' as const,
        reason:
          typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'ObservationUnavailable'
            ? error.reason
            : 'budget',
      }),
    ),
    Effect.catchCause(() => Effect.succeed({state: 'unavailable' as const, reason: 'error' as const})),
  );
};
