import {Array as EffectArray} from 'effect';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Directory junctions keep caller-retarget fixtures usable without Windows symlink privilege.
import {symlinkSync} from 'node:fs';
import {it as effectIt} from '@effect/vitest';
import {DateTime, Deferred, Effect, Fiber, FileSystem, Option, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {makeIdempotentFixtureTempDirectoryScoped} from '@threadnote/testing/fixture-temp-directory';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {
  parseRepositoryUntrackedStatusRecords,
  resolveRepositoryIdentity,
  resolveRepositoryIdentityForExpectationAndWorktree,
  startRepositoryWorktreeObservation,
} from '@threadnote/graph/repository';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const mutations = ['untracked', 'nested', 'edit', 'delete', 'stage', 'ignore', 'gitignore', 'reset'] as const;
type Mutation = (typeof mutations)[number];

const makeFixture = (format: 'sha1' | 'sha256' = 'sha1') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* makeIdempotentFixtureTempDirectoryScoped(fs, 'threadnote-untracked-cache-');
    const root = path.join(parent, 'repo');
    const home = path.join(parent, 'home');
    yield* fs.makeDirectory(path.join(root, 'src'), {recursive: true});
    yield* fs.makeDirectory(home);
    yield* fs.writeFileString(path.join(root, 'src/tracked.ts'), 'export const value = 1;\n');
    const git = (args: readonly string[]) =>
      runCommandEffect('git', ['-C', root, ...args], {maxOutputBytes: 65_536, timeoutMs: 10_000});
    yield* git(['init', '-q', `--object-format=${format}`]);
    yield* git(['add', '.']);
    yield* git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    const identity = yield* resolveRepositoryIdentity(root);
    const index = Effect2.pipe(
      (yield* git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout,
      EffectString.trim,
    );
    return {fs, path, root, home, git, identity, index};
  });

const fixture = makeFixture();

const observeInitialComposite = (
  f: Effect.Success<typeof fixture>,
  cwd = f.root,
  identity = f.identity,
  minimumIndexBytes = 0,
) =>
  Effect.gen(function* () {
    const bind = yield* startRepositoryWorktreeObservation(cwd, {
      cache: {threadnoteHome: f.home, minimumIndexBytes},
      metadata: Effect.succeed({
        repoRoot: identity.repoRoot,
        commonDirectory: identity.gitCommonDirectory,
        gitDirectory: f.path.dirname(f.index),
        objectFormat: identity.objectFormat,
        headCommit: identity.headCommit,
        sourceIndex: f.index,
      }),
    });
    return {identity, worktreeChanged: yield* bind(identity)};
  });

const scenario = (changes: readonly Mutation[], minimumIndexBytes = 0) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const command = yield* CommandExecutor;
    const privateIndexes: string[] = [];
    const statuses: {readonly stdout: string; readonly private: boolean; readonly tracked: boolean}[] = [];
    const observed = CommandExecutor.of({
      ...command,
      execute: (executable, args, options) =>
        command.execute(executable, args, options).pipe(
          Effect.tap(result =>
            Effect.sync(() => {
              expect(args).not.toContain('fsmonitor--daemon');
              if (args.includes('status')) {
                statuses.push({
                  stdout: result.stdout,
                  private: options?.trustedGitIndexFile !== undefined,
                  tracked: args.includes('--untracked-files=no'),
                });
                if (options?.trustedGitIndexFile !== undefined) privateIndexes.push(options.trustedGitIndexFile);
              }
            }),
          ),
        ),
    });
    const cache = {threadnoteHome: f.home, minimumIndexBytes};
    const check = Effect.gen(function* () {
      const before = sha256HexSync(yield* f.fs.readFile(f.index));
      const objects = (yield* f.git(['count-objects', '-v'])).stdout;
      statuses.length = 0;
      const raw = yield* f.git([
        '--no-optional-locks',
        'status',
        '--porcelain=v2',
        '-z',
        '--branch',
        '--untracked-files=normal',
      ]);
      const bind = yield* startRepositoryWorktreeObservation(f.root);
      const initial = yield* bind(f.identity);
      const final = yield* resolveRepositoryIdentityForExpectationAndWorktree(f.root, f.identity, cache);
      const changed = EffectArray.some(
        Effect2.pipe(raw.stdout, EffectString.split('\0')),
        record => record.length > 0 && !Effect2.pipe(record, EffectString.startsWith('# ')),
      );
      expect(initial).toBe(changed);
      expect((yield* observeInitialComposite(f, f.root, f.identity, minimumIndexBytes)).worktreeChanged).toBe(changed);
      expect(final.worktreeChanged).toBe(changed);
      const privateStatus = Option.getOrUndefined(EffectArray.findFirst(statuses, status => status.private));
      if (privateStatus !== undefined) {
        const tracked = Option.getOrUndefined(EffectArray.findFirst(statuses, status => status.tracked))!;
        const untracked = parseRepositoryUntrackedStatusRecords(privateStatus.stdout)!;
        expect(
          tracked.stdout +
            EffectArray.join(
              EffectArray.map(untracked, record => `${record}\0`),
              '',
            ),
        ).toBe(raw.stdout);
      }
      expect((yield* f.git(['count-objects', '-v'])).stdout).toBe(objects);
      expect(sha256HexSync(yield* f.fs.readFile(f.index))).toBe(before);
    }).pipe(Effect.provideService(CommandExecutor, observed));
    yield* check;
    for (const [ordinal, mutation] of changes.entries()) {
      const name = `untracked-${ordinal}.ts`;
      if (mutation === 'reset') {
        yield* f.git(['reset', '--hard', '-q', 'HEAD']);
        yield* f.git(['clean', '-fdxq']);
        yield* f.fs.writeFileString(f.path.join(f.root, '.git/info/exclude'), '');
      }
      if (mutation === 'untracked') yield* f.fs.writeFileString(f.path.join(f.root, 'src', name), name);
      if (mutation === 'nested') {
        yield* f.fs.makeDirectory(f.path.join(f.root, name));
        yield* f.fs.writeFileString(f.path.join(f.root, name, 'new.ts'), name);
      }
      if (mutation === 'edit') yield* f.fs.writeFileString(f.path.join(f.root, 'src/tracked.ts'), name);
      if (mutation === 'delete') yield* f.fs.remove(f.path.join(f.root, 'src/tracked.ts'), {force: true});
      if (mutation === 'stage') {
        yield* f.fs.writeFileString(f.path.join(f.root, 'src/tracked.ts'), name);
        yield* f.git(['add', '.']);
      }
      if (mutation === 'ignore') {
        yield* f.fs.writeFileString(f.path.join(f.root, '.git/info/exclude'), 'untracked-*\n');
        yield* f.fs.writeFileString(f.path.join(f.root, 'src', name), name);
      }
      if (mutation === 'gitignore') {
        yield* f.fs.writeFileString(f.path.join(f.root, '.gitignore'), 'untracked-*\n');
        yield* f.fs.writeFileString(f.path.join(f.root, 'src', name), name);
      }
      yield* check;
    }
    if (minimumIndexBytes === 0) expect(privateIndexes.length).toBeGreaterThan(0);
    else expect(privateIndexes).toEqual([]);
  }).pipe(TestClock.withLive);

const unsupportedCases = [
  'split',
  'sparse',
  'gitlink',
  'assume-unchanged',
  'skip-worktree',
  'symlink',
  'lock',
] as const;
const fallbackScenario = (kind: (typeof unsupportedCases)[number]) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const command = yield* CommandExecutor;
    const indexes: string[] = [];
    const observed = CommandExecutor.of({
      ...command,
      execute: (executable, args, options) => {
        if (options?.trustedGitIndexFile !== undefined) indexes.push(options.trustedGitIndexFile);
        return command.execute(executable, args, options);
      },
    });
    const cache = {threadnoteHome: f.home, minimumIndexBytes: 0};
    const check = resolveRepositoryIdentityForExpectationAndWorktree(f.root, f.identity, cache).pipe(
      Effect.provideService(CommandExecutor, observed),
    );
    if (['symlink', 'lock'].includes(kind)) {
      yield* check;
      expect(indexes.length).toBeGreaterThan(0);
    }
    if (kind === 'split') yield* f.git(['update-index', '--split-index']);
    if (kind === 'sparse') yield* f.fs.writeFileString(f.path.join(f.root, '.git/info/sparse-checkout'), '/*\n');
    if (kind === 'gitlink')
      yield* f.git(['update-index', '--add', '--cacheinfo', `160000,${f.identity.headCommit},submodule`]);
    if (kind === 'assume-unchanged') yield* f.git(['update-index', '--assume-unchanged', 'src/tracked.ts']);
    if (kind === 'skip-worktree') yield* f.git(['update-index', '--skip-worktree', 'src/tracked.ts']);
    const canonicalDirectoryMode = (yield* f.fs.stat(f.path.dirname(f.index))).mode;
    if (kind === 'symlink') {
      const privateIndex = indexes.at(-1)!;
      yield* f.fs.remove(privateIndex);
      yield* Effect.sync(() => symlinkSync(f.path.dirname(f.index), privateIndex, 'junction'));
    }
    const lock = indexes.length === 0 ? undefined : f.path.join(f.path.dirname(indexes.at(-1)!), '.status.lock');
    if (kind === 'lock') yield* f.fs.writeFileString(lock!, 'busy');
    indexes.length = 0;
    const before = sha256HexSync(yield* f.fs.readFile(f.index));
    const expected = EffectArray.some(
      Effect2.pipe(
        (yield* f.git([
          '--no-optional-locks',
          'status',
          '--porcelain=v2',
          '-z',
          '--branch',
          '--untracked-files=normal',
        ])).stdout,
        EffectString.split('\0'),
      ),
      record => record.length > 0 && !Effect2.pipe(record, EffectString.startsWith('# ')),
    );
    expect((yield* check).worktreeChanged).toBe(expected);
    expect(indexes).toEqual([]);
    expect(sha256HexSync(yield* f.fs.readFile(f.index))).toBe(before);
    expect((yield* f.fs.stat(f.path.dirname(f.index))).mode).toBe(canonicalDirectoryMode);
    if (kind === 'lock') expect(yield* f.fs.readFileString(lock!)).toBe('busy');
  }).pipe(TestClock.withLive);

const ignoreRefreshScenario = (relaxed: boolean, nested: boolean, ignoreName = '.gitignore') =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const directory = nested ? f.path.join(f.root, 'nested scope [x]') : f.root;
    yield* f.fs.makeDirectory(directory, {recursive: true});
    const ignore = f.path.join(directory, ignoreName);
    yield* f.fs.writeFileString(ignore, '*.ignored\n');
    yield* f.fs.writeFileString(f.path.join(directory, 'marker.txt'), 'tracked marker');
    yield* f.git(['add', '.']);
    yield* f.git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'ignore fixture']);
    const identity = yield* resolveRepositoryIdentity(f.root);
    const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe('2000-01-01T00:00:00Z'));
    if (relaxed) {
      yield* f.git(['config', 'core.trustctime', 'false']);
      yield* f.git(['config', 'core.checkStat', 'minimal']);
      yield* f.fs.utimes(ignore, timestamp, timestamp);
      yield* f.git(['update-index', '--refresh']);
    }
    yield* f.fs.writeFileString(f.path.join(directory, 'example.ignored'), 'ignored before warming');
    yield* f.fs.utimes(directory, timestamp, timestamp);
    const command = yield* CommandExecutor;
    let privateIndex: string | undefined;
    let privateOutput: string | undefined;
    let trackedOutput: string | undefined;
    let initializations = 0;
    let rawOutput: string | undefined;
    const observed = CommandExecutor.of({
      ...command,
      execute: (executable, args, options) =>
        command.execute(executable, args, options).pipe(
          Effect.tap(result =>
            Effect.sync(() => {
              if (args.includes('--really-refresh')) initializations += 1;
              if (args.includes('status')) {
                if (options?.trustedGitIndexFile !== undefined) {
                  privateIndex = options.trustedGitIndexFile;
                  privateOutput = result.stdout;
                } else if (args.includes('--untracked-files=no')) trackedOutput = result.stdout;
                else rawOutput = result.stdout;
              }
            }),
          ),
        ),
    });
    const indexBefore = sha256HexSync(yield* f.fs.readFile(f.index));
    const directoryMode = (yield* f.fs.stat(f.path.dirname(f.index))).mode;
    const indexMode = (yield* f.fs.stat(f.index)).mode;
    const check = Effect.gen(function* () {
      const raw = (yield* f.git([
        '--no-optional-locks',
        'status',
        '--porcelain=v2',
        '-z',
        '--branch',
        '--untracked-files=normal',
      ])).stdout;
      privateOutput = undefined;
      trackedOutput = undefined;
      const result = yield* resolveRepositoryIdentityForExpectationAndWorktree(f.root, identity, {
        threadnoteHome: f.home,
        minimumIndexBytes: 0,
      }).pipe(Effect.provideService(CommandExecutor, observed));
      const initial = yield* observeInitialComposite(f, f.root, identity).pipe(
        Effect.provideService(CommandExecutor, observed),
      );
      expect(initial.worktreeChanged).toBe(result.worktreeChanged);
      expect(privateOutput).toBeUndefined();
      expect(trackedOutput).toBeUndefined();
      expect(rawOutput).toBe(raw);
      expect(result.worktreeChanged).toBe(
        EffectArray.some(Effect2.pipe(raw, EffectString.split('\0')), record =>
          Boolean(record && !Effect2.pipe(record, EffectString.startsWith('# '))),
        ),
      );
      expect(sha256HexSync(yield* f.fs.readFile(f.index))).toBe(indexBefore);
      expect((yield* f.fs.stat(f.path.dirname(f.index))).mode).toBe(directoryMode);
      expect((yield* f.fs.stat(f.index)).mode).toBe(indexMode);
    });
    yield* check;
    yield* check;
    if (relaxed) {
      yield* f.fs.writeFileString(ignore, '*.allowed\n');
      yield* f.fs.utimes(ignore, timestamp, timestamp);
    } else {
      yield* f.fs.writeFileString(ignore, '*.ts\n');
      yield* f.fs.writeFileString(f.path.join(directory, 'new.ts'), 'new source');
      yield* f.fs.utimes(directory, timestamp, timestamp);
      yield* check;
      yield* check;
      yield* f.fs.writeFileString(ignore, '*.ignored\n');
    }
    yield* check;
    yield* check;
    expect(initializations).toBe(0);
    expect(privateIndex).toBeUndefined();
    expect(yield* f.fs.exists(f.path.join(f.home, 'indexes'))).toBe(false);
  }).pipe(TestClock.withLive);

describe('bounded repository untracked cache', () => {
  effectIt.layer(citationPlatformLayer)(it => {
    it.effect(
      'matches fresh raw Git across working tree, index and ignore changes without changing the real index',
      () => scenario(['untracked', 'reset', 'edit', 'reset', ...mutations]),
    );
    for (const relaxed of [false, true])
      for (const nested of [false, true])
        it.effect(
          `falls back for ${nested ? 'nested' : 'root'} ignore rules across ${relaxed ? 'restored timestamp edits' : 'dirty then clean restoration'}`,
          () => ignoreRefreshScenario(relaxed, nested),
        );
    for (const nested of [false, true])
      it.effect(`rejects ${nested ? 'nested' : 'root'} uppercase tracked ignore spelling`, () =>
        ignoreRefreshScenario(false, nested, '.GITIGNORE'),
      );
    it.effect('rejects a newly staged nested ignore file before reusing a positive cache receipt', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const cache = {threadnoteHome: f.home, minimumIndexBytes: 0};
        yield* resolveRepositoryIdentityForExpectationAndWorktree(f.root, f.identity, cache);
        yield* f.fs.writeFileString(f.path.join(f.root, 'src/.gitignore'), '*.ignored\n');
        yield* f.git(['add', '.']);
        const command = yield* CommandExecutor;
        let privateReads = 0;
        const observed = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) => {
            if (options?.trustedGitIndexFile !== undefined) privateReads += 1;
            return command.execute(executable, args, options);
          },
        });
        const before = sha256HexSync(yield* f.fs.readFile(f.index));
        expect(
          (yield* resolveRepositoryIdentityForExpectationAndWorktree(f.root, f.identity, cache).pipe(
            Effect.provideService(CommandExecutor, observed),
          )).worktreeChanged,
        ).toBe(true);
        expect(privateReads).toBe(0);
        expect(sha256HexSync(yield* f.fs.readFile(f.index))).toBe(before);
      }).pipe(TestClock.withLive),
    );
    it.effect('keeps small indexes on the raw path', () => scenario(['untracked'], 1_048_576));
    for (const kind of unsupportedCases)
      it.effect(`falls back without private writes for ${kind}`, () => fallbackScenario(kind));
    it.effect('resolves the linked worktree index instead of the common index', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const linked = f.path.join(f.path.dirname(f.root), 'linked');
        yield* f.git(['worktree', 'add', '-q', '--detach', linked]);
        const identity = yield* resolveRepositoryIdentity(linked);
        yield* f.fs.writeFileString(f.path.join(linked, 'src/tracked.ts'), 'export const value = 2;\n');
        const before = sha256HexSync(yield* f.fs.readFile(f.index));
        const observed = yield* resolveRepositoryIdentityForExpectationAndWorktree(linked, identity, {
          threadnoteHome: f.home,
          minimumIndexBytes: 0,
        });
        expect(observed.worktreeChanged).toBe(true);
        expect(sha256HexSync(yield* f.fs.readFile(f.index))).toBe(before);
      }).pipe(TestClock.withLive),
    );
    it.effect('supports SHA-256 repositories without changing their canonical index', () =>
      Effect.gen(function* () {
        const f = yield* makeFixture('sha256');
        const before = sha256HexSync(yield* f.fs.readFile(f.index));
        const check = resolveRepositoryIdentityForExpectationAndWorktree(f.root, f.identity, {
          threadnoteHome: f.home,
          minimumIndexBytes: 0,
        });
        expect((yield* check).worktreeChanged).toBe(false);
        yield* f.fs.writeFileString(f.path.join(f.root, 'src/new.ts'), 'untracked');
        expect((yield* check).worktreeChanged).toBe(true);
        expect(sha256HexSync(yield* f.fs.readFile(f.index))).toBe(before);
      }).pipe(TestClock.withLive),
    );
    it.effect('keeps cache setup and fallback inside the ten-second read budget and releases its lock', () =>
      Effect.gen(function* () {
        const f = yield* fixture.pipe(TestClock.withLive);
        const command = yield* CommandExecutor;
        const entered = yield* Deferred.make<void>();
        let privateIndex: string | undefined;
        const observed = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) => {
            if (args.includes('status') && options?.trustedGitIndexFile !== undefined) {
              privateIndex = options.trustedGitIndexFile;
              return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
            }
            return command.execute(executable, args, options);
          },
        });
        const waiting = yield* resolveRepositoryIdentityForExpectationAndWorktree(f.root, f.identity, {
          threadnoteHome: f.home,
          minimumIndexBytes: 0,
        }).pipe(Effect.provideService(CommandExecutor, observed), Effect.result, Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* TestClock.adjust('10 seconds');
        expect((yield* Fiber.join(waiting))._tag).toBe('Failure');
        expect(privateIndex).toBeDefined();
        expect(yield* f.fs.exists(f.path.join(f.path.dirname(privateIndex!), '.status.lock'))).toBe(false);
      }),
    );
    it.effect('observes timestamp-restoring edits after a clean private stat refresh', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const file = f.path.join(f.root, 'src/tracked.ts');
        const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe('2000-01-01T00:00:00Z'));
        const atime = Option.getOrThrow((yield* f.fs.stat(file)).atime);
        const check = resolveRepositoryIdentityForExpectationAndWorktree(f.root, f.identity, {
          threadnoteHome: f.home,
          minimumIndexBytes: 0,
        });
        yield* f.fs.utimes(file, atime, timestamp);
        expect((yield* check).worktreeChanged).toBe(false);
        const before = sha256HexSync(yield* f.fs.readFile(f.index));
        yield* f.fs.writeFileString(file, 'export const value = 2;\n');
        yield* f.fs.utimes(file, atime, timestamp);
        const privateChanged = (yield* check).worktreeChanged;
        const raw = (yield* f.git(['--no-optional-locks', 'status', '--porcelain'])).stdout;
        expect(raw).toContain(' M src/tracked.ts');
        expect(privateChanged).toBe(true);
        expect(sha256HexSync(yield* f.fs.readFile(f.index))).toBe(before);
      }).pipe(TestClock.withLive),
    );
    it.effect('preserves canonical tracked semantics when user stat configuration changes after warming', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const command = yield* CommandExecutor;
        let privateReads = 0;
        const observed = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) => {
            if (args.includes('status') && options?.trustedGitIndexFile !== undefined) privateReads += 1;
            return command.execute(executable, args, options);
          },
        });
        const check = resolveRepositoryIdentityForExpectationAndWorktree(f.root, f.identity, {
          threadnoteHome: f.home,
          minimumIndexBytes: 0,
        }).pipe(Effect.provideService(CommandExecutor, observed));
        expect((yield* check).worktreeChanged).toBe(false);
        for (const [key, value] of [
          ['core.trustctime', 'false'],
          ['core.checkStat', 'minimal'],
          ['core.ignoreStat', 'true'],
        ]) {
          yield* f.git(['config', key, value]);
          yield* f.fs.writeFileString(f.path.join(f.root, 'src/tracked.ts'), 'export const value = 2;\n');
          const raw = (yield* f.git(['--no-optional-locks', 'status', '--porcelain'])).stdout;
          expect((yield* check).worktreeChanged).toBe(raw.length > 0);
          yield* f.git(['restore', 'src/tracked.ts']);
        }
        expect(privateReads).toBe(4);
      }).pipe(TestClock.withLive),
    );
    it.effect('observes restored directory timestamps and changed tracked ignore rules', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.fs.writeFileString(f.path.join(f.root, '.gitignore'), '*.ignored\n');
        yield* f.git(['add', '.']);
        yield* f.git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'ignore']);
        const identity = yield* resolveRepositoryIdentity(f.root);
        const check = resolveRepositoryIdentityForExpectationAndWorktree(f.root, identity, {
          threadnoteHome: f.home,
          minimumIndexBytes: 0,
        });
        expect((yield* check).worktreeChanged).toBe(false);
        const directory = f.path.join(f.root, 'src');
        const stat = yield* f.fs.stat(directory);
        yield* f.fs.writeFileString(f.path.join(directory, 'new.ts'), 'untracked');
        yield* f.fs.utimes(directory, Option.getOrThrow(stat.atime), Option.getOrThrow(stat.mtime));
        expect((yield* check).worktreeChanged).toBe(true);
        yield* f.fs.remove(f.path.join(directory, 'new.ts'));
        yield* f.fs.writeFileString(f.path.join(directory, 'new.ignored'), 'ignored');
        expect((yield* check).worktreeChanged).toBe(false);
        yield* f.fs.writeFileString(f.path.join(f.root, '.gitignore'), '');
        expect((yield* check).worktreeChanged).toBe(true);
        yield* f.git(['restore', '.gitignore']);
        expect((yield* check).worktreeChanged).toBe(false);
        yield* f.git(['mv', 'src/tracked.ts', 'src/renamed.ts']);
        expect((yield* check).worktreeChanged).toBe(true);
      }).pipe(TestClock.withLive),
    );
    it.effect('retains the warmed untracked cache across canonical stat-only index refreshes', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const command = yield* CommandExecutor;
        let initializations = 0;
        const observed = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) => {
            if (args.includes('update-index') && options?.trustedGitIndexFile !== undefined) initializations += 1;
            return command.execute(executable, args, options);
          },
        });
        const check = resolveRepositoryIdentityForExpectationAndWorktree(f.root, f.identity, {
          threadnoteHome: f.home,
          minimumIndexBytes: 0,
        }).pipe(Effect.provideService(CommandExecutor, observed));
        expect((yield* check).worktreeChanged).toBe(false);
        const beforeRefresh = sha256HexSync(yield* f.fs.readFile(f.index));
        const file = f.path.join(f.root, 'src/tracked.ts');
        const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe('2000-01-01T00:00:00Z'));
        yield* f.fs.utimes(file, timestamp, timestamp);
        yield* f.git(['update-index', '--refresh']);
        const afterRefresh = sha256HexSync(yield* f.fs.readFile(f.index));
        expect(afterRefresh).not.toBe(beforeRefresh);
        expect((yield* check).worktreeChanged).toBe(false);
        yield* f.fs.writeFileString(f.path.join(f.root, 'src/new.ts'), 'untracked');
        expect((yield* check).worktreeChanged).toBe(true);
        expect(initializations).toBe(1);
        expect(sha256HexSync(yield* f.fs.readFile(f.index))).toBe(afterRefresh);
      }).pipe(TestClock.withLive),
    );
    it.effect('rejects HEAD movement after the shared closing metadata read', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const command = yield* CommandExecutor;
        let moved = false;
        const observed = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) =>
            Effect.gen(function* () {
              if (args.includes('status') && options?.trustedGitIndexFile !== undefined && !moved) {
                moved = true;
                yield* f.git([
                  '-c',
                  'user.name=Test',
                  '-c',
                  'user.email=test@example.invalid',
                  'commit',
                  '--allow-empty',
                  '-qm',
                  'moved',
                ]);
              }
              return yield* command.execute(executable, args, options);
            }).pipe(Effect.provideService(CommandExecutor, command), Effect.orDie),
        });
        const result = yield* resolveRepositoryIdentityForExpectationAndWorktree(f.root, f.identity, {
          threadnoteHome: f.home,
          minimumIndexBytes: 0,
        }).pipe(Effect.provideService(CommandExecutor, observed), Effect.result);
        expect(moved).toBe(true);
        expect(result._tag).toBe('Failure');
      }).pipe(TestClock.withLive),
    );
    it.effect('initial observation rejects HEAD movement after metadata discovery', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const command = yield* CommandExecutor;
        let moved = false;
        const observed = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) =>
            Effect.gen(function* () {
              if (args.includes('status') && options?.trustedGitIndexFile !== undefined && !moved) {
                moved = true;
                yield* f.git([
                  '-c',
                  'user.name=Test',
                  '-c',
                  'user.email=test@example.invalid',
                  'commit',
                  '--allow-empty',
                  '-qm',
                  'moved',
                ]);
              }
              return yield* command.execute(executable, args, options);
            }).pipe(Effect.provideService(CommandExecutor, command), Effect.orDie),
        });
        const result = yield* observeInitialComposite(f).pipe(
          Effect.provideService(CommandExecutor, observed),
          Effect.result,
        );
        expect(moved).toBe(true);
        expect(result._tag).toBe('Failure');
      }).pipe(TestClock.withLive),
    );
    it.effect('falls back to a fresh raw observation when the source index changes during private status', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const command = yield* CommandExecutor;
        let mutated = false;
        let rawReads = 0;
        let stagedIndex: string | undefined;
        const observed = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) =>
            Effect.gen(function* () {
              if (args.includes('status')) {
                if (options?.trustedGitIndexFile === undefined) rawReads += 1;
                else if (!mutated) {
                  mutated = true;
                  yield* f.fs.writeFileString(f.path.join(f.root, 'src/tracked.ts'), 'export const staged = 2;\n');
                  yield* f.git(['add', '.']);
                  stagedIndex = sha256HexSync(yield* f.fs.readFile(f.index));
                }
              }
              return yield* command.execute(executable, args, options);
            }).pipe(Effect.provideService(CommandExecutor, command), Effect.orDie),
        });
        const result = yield* resolveRepositoryIdentityForExpectationAndWorktree(f.root, f.identity, {
          threadnoteHome: f.home,
          minimumIndexBytes: 0,
        }).pipe(Effect.provideService(CommandExecutor, observed));
        expect(result.worktreeChanged).toBe(true);
        expect(rawReads).toBe(2);
        expect(sha256HexSync(yield* f.fs.readFile(f.index))).toBe(stagedIndex);
      }).pipe(TestClock.withLive),
    );
    it.effect(
      'initial observation: falls back to a fresh raw observation when the source index changes during private status',
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const command = yield* CommandExecutor;
          let mutated = false;
          let rawReads = 0;
          let stagedIndex: string | undefined;
          const observed = CommandExecutor.of({
            ...command,
            execute: (executable, args, options) =>
              Effect.gen(function* () {
                if (args.includes('status')) {
                  if (options?.trustedGitIndexFile === undefined) rawReads += 1;
                  else if (!mutated) {
                    mutated = true;
                    yield* f.fs.writeFileString(f.path.join(f.root, 'src/tracked.ts'), 'export const staged = 2;\n');
                    yield* f.git(['add', '.']);
                    stagedIndex = sha256HexSync(yield* f.fs.readFile(f.index));
                  }
                }
                return yield* command.execute(executable, args, options);
              }).pipe(Effect.provideService(CommandExecutor, command), Effect.orDie),
          });
          const result = yield* observeInitialComposite(f, f.root).pipe(
            Effect.provideService(CommandExecutor, observed),
          );
          expect(result.worktreeChanged).toBe(true);
          expect(rawReads).toBe(2);
          expect(sha256HexSync(yield* f.fs.readFile(f.index))).toBe(stagedIndex);
        }).pipe(TestClock.withLive),
    );
    it.effect('discards a private result from an ABA-retargeted caller before the final identity check', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const trackedFinished = yield* Deferred.make<void>();
        const linked = f.path.join(f.path.dirname(f.root), 'linked');
        const caller = f.path.join(f.path.dirname(f.root), 'caller');
        yield* f.git(['worktree', 'add', '-q', '--detach', linked]);
        yield* Effect.sync(() => symlinkSync(f.root, caller, 'junction'));
        yield* f.fs.writeFileString(f.path.join(linked, 'src/tracked.ts'), 'export const different = 2;\n');
        const command = yield* CommandExecutor;
        let switched = false;
        let rawReads = 0;
        const observed = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) =>
            Effect.gen(function* () {
              if (!args.includes('status')) return yield* command.execute(executable, args, options);
              if (options?.trustedGitIndexFile === undefined) {
                rawReads += 1;
                return yield* command
                  .execute(executable, args, options)
                  .pipe(Effect.ensuring(Deferred.succeed(trackedFinished, undefined)));
              }
              // Retarget only the private read, not the concurrent canonical read's cwd lookup.
              yield* Deferred.await(trackedFinished);
              switched = true;
              yield* f.fs.remove(caller);
              yield* Effect.sync(() => symlinkSync(linked, caller, 'junction'));
              return yield* command
                .execute(executable, args, options)
                .pipe(
                  Effect.ensuring(
                    f.fs
                      .remove(caller)
                      .pipe(Effect.andThen(Effect.sync(() => symlinkSync(f.root, caller, 'junction'))), Effect.orDie),
                  ),
                );
            }).pipe(Effect.provideService(CommandExecutor, command), Effect.orDie),
        });
        const before = sha256HexSync(yield* f.fs.readFile(f.index));
        const result = yield* resolveRepositoryIdentityForExpectationAndWorktree(caller, f.identity, {
          threadnoteHome: f.home,
          minimumIndexBytes: 0,
        }).pipe(Effect.provideService(CommandExecutor, observed));
        expect(switched).toBe(true);
        expect(rawReads).toBe(2);
        expect(result.worktreeChanged).toBe(false);
        expect(sha256HexSync(yield* f.fs.readFile(f.index))).toBe(before);
      }).pipe(TestClock.withLive),
    );
    it.effect(
      'initial observation: discards a private result from an ABA-retargeted caller before the final identity check',
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const trackedFinished = yield* Deferred.make<void>();
          const linked = f.path.join(f.path.dirname(f.root), 'linked');
          const caller = f.path.join(f.path.dirname(f.root), 'caller');
          yield* f.git(['worktree', 'add', '-q', '--detach', linked]);
          yield* Effect.sync(() => symlinkSync(f.root, caller, 'junction'));
          yield* f.fs.writeFileString(f.path.join(linked, 'src/tracked.ts'), 'export const different = 2;\n');
          const command = yield* CommandExecutor;
          let switched = false;
          let rawReads = 0;
          const observed = CommandExecutor.of({
            ...command,
            execute: (executable, args, options) =>
              Effect.gen(function* () {
                if (!args.includes('status')) return yield* command.execute(executable, args, options);
                if (options?.trustedGitIndexFile === undefined) {
                  rawReads += 1;
                  return yield* command
                    .execute(executable, args, options)
                    .pipe(Effect.ensuring(Deferred.succeed(trackedFinished, undefined)));
                }
                // Retarget only the private read, not the concurrent canonical read's cwd lookup.
                yield* Deferred.await(trackedFinished);
                switched = true;
                yield* f.fs.remove(caller);
                yield* Effect.sync(() => symlinkSync(linked, caller, 'junction'));
                return yield* command
                  .execute(executable, args, options)
                  .pipe(
                    Effect.ensuring(
                      f.fs
                        .remove(caller)
                        .pipe(Effect.andThen(Effect.sync(() => symlinkSync(f.root, caller, 'junction'))), Effect.orDie),
                    ),
                  );
              }).pipe(Effect.provideService(CommandExecutor, command), Effect.orDie),
          });
          const before = sha256HexSync(yield* f.fs.readFile(f.index));
          const result = yield* observeInitialComposite(f, caller).pipe(
            Effect.provideService(CommandExecutor, observed),
          );
          expect(switched).toBe(true);
          expect(rawReads).toBe(2);
          expect(result.worktreeChanged).toBe(false);
          expect(sha256HexSync(yield* f.fs.readFile(f.index))).toBe(before);
        }).pipe(TestClock.withLive),
    );
    fcEffectProp(
      it,
      'matches raw Git after bounded mutation sequences at both observation boundaries',
      {changes: fc.array(fc.constantFrom(...mutations), {maxLength: 5, minLength: 1})},
      ({changes}) => scenario(changes),
      {fastCheck: {numRuns: 6}},
    );
  });
});

const framedPath = fc
  .string({minLength: 1, maxLength: 30})
  .filter(value => !Effect2.pipe(value, EffectString.includes('\0')));
it('selects only framed untracked entries, including rename sources resembling status records', () => {
  fc.assert(
    fc.property(framedPath, framedPath, fc.array(framedPath, {maxLength: 6}), (source, target, paths) => {
      const prefix = `# branch.oid ${Effect2.pipe('a', EffectString.repeat(40))}\0# branch.head main\0`;
      const rename = `2 R. N... 100644 100644 100644 ${Effect2.pipe('a', EffectString.repeat(40))} ${Effect2.pipe('b', EffectString.repeat(40))} R100 ${target}\0? ${source}\0`;
      const output =
        prefix +
        rename +
        EffectArray.join(
          EffectArray.map(paths, path => `? ${path}\0`),
          '',
        );
      expect(parseRepositoryUntrackedStatusRecords(output)).toEqual(EffectArray.map(paths, path => `? ${path}`));
      expect(parseRepositoryUntrackedStatusRecords(Effect2.pipe(output, EffectString.slice(0, -1)))).toBeUndefined();
      expect(parseRepositoryUntrackedStatusRecords(prefix + rename + '? \0')).toBeUndefined();
      expect(parseRepositoryUntrackedStatusRecords(prefix + '2 broken\0')).toBeUndefined();
    }),
    {numRuns: 50},
  );
});
