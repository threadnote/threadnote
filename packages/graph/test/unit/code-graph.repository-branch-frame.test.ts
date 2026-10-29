import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {CommandExecutor, CommandFailed, runCommandEffect} from '@threadnote/platform/command';
import {
  parseRepositoryIdentityMetadata,
  resolveRepositoryIdentityDetail,
  type RepositoryIdentityMetadata,
} from '@threadnote/graph/repository';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'repository-branch-frame-'});
  const root = path.join(home, 'repo');
  yield* fs.makeDirectory(root);
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', root, ...args]);
  yield* git(['init', '--quiet', '--initial-branch=main']);
  yield* git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '--quiet',
    '-m',
    'fixture',
  ]);
  return {fs, path, home, root, git};
});

/** Force the independent legacy commands without changing their results or the repository. */
const observe = (cwd: string, mode: 'normal' | 'unsupported' | 'malformed' = 'normal', includeIndex = false) =>
  Effect.gen(function* () {
    const command = yield* CommandExecutor;
    let branchReads = 0;
    let frameReads = 0;
    let metadata: RepositoryIdentityMetadata | undefined;
    const observed = CommandExecutor.of({
      ...command,
      execute: (executable, args, options) => {
        if (args.includes('symbolic-ref')) branchReads++;
        return command.execute(executable, args, options);
      },
      executeBytes: (executable, args, options) => {
        if (!args.includes('--abbrev-ref=loose')) return command.executeBytes!(executable, args, options);
        frameReads++;
        if (mode === 'unsupported')
          return Effect.fail(
            CommandFailed.make({
              executable,
              args,
              exitCode: 129,
              stdout: '',
              stderr: 'Unsupported discovery frame.',
              message: 'Unsupported discovery frame.',
            }),
          );
        return command.executeBytes!(executable, args, options).pipe(
          Effect.map(result =>
            mode === 'malformed'
              ? {
                  ...result,
                  stdout: result.stdout.subarray(0, result.stdout.lastIndexOf(10, result.stdout.length - 2) + 1),
                }
              : result,
          ),
        );
      },
    });
    const detail = yield* resolveRepositoryIdentityDetail(
      cwd,
      includeIndex
        ? value =>
            Effect.sync(() => {
              metadata = value;
            })
        : undefined,
    ).pipe(Effect.provideService(CommandExecutor, observed));
    return {detail, branchReads, frameReads, metadata};
  });

describe('repository identity branch frame', () => {
  effectIt.layer(citationPlatformLayer)(test => {
    test.effect.prop(
      'matches independent legacy discovery across branch names, collisions, config and detached HEAD without writes',
      {
        suffix: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 9999})),
        collision: Schema.Literals(['tag', 'remote', 'none']),
        warnAmbiguousRefs: Schema.Boolean,
        detached: Schema.Boolean,
        includeIndex: Schema.Boolean,
      },
      ({suffix, collision, warnAmbiguousRefs, detached, includeIndex}) =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const branch = `feature/é-${suffix}`;
          yield* f.git(['branch', '-m', branch]);
          if (collision === 'tag') yield* f.git(['tag', branch]);
          if (collision === 'remote') yield* f.git(['update-ref', `refs/remotes/${branch}`, 'HEAD']);
          yield* f.git(['config', 'core.warnAmbiguousRefs', String(warnAmbiguousRefs)]);
          if (detached) yield* f.git(['checkout', '--quiet', '--detach']);
          const head = f.path.join(f.root, '.git', 'HEAD');
          const before = yield* f.fs.readFileString(head);
          const fast = yield* observe(f.root, 'normal', includeIndex);
          const legacy = yield* observe(f.root, 'unsupported', includeIndex);
          expect(fast.detail).toEqual(legacy.detail);
          expect(fast.branchReads).toBe(0);
          expect(legacy.branchReads).toBe(1);
          expect(fast.frameReads).toBe(1);
          expect(fast.detail.identity.branch).toBe(
            detached ? undefined : collision === 'tag' ? `heads/${branch}` : branch,
          );
          expect(yield* f.fs.readFileString(head)).toBe(before);
        }).pipe(TestClock.withLive),
      {arbitrary: {runs: 12, seed: 756848}},
    );

    test.effect('retains legacy loose branch shortening with a remote collision under both ambiguity settings', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.git(['update-ref', 'refs/remotes/main', 'HEAD']);
        for (const warn of ['true', 'false']) {
          yield* f.git(['config', 'core.warnAmbiguousRefs', warn]);
          expect(
            Effect2.pipe((yield* f.git(['rev-parse', '--abbrev-ref=strict', 'HEAD'])).stdout, EffectString.trim),
          ).toBe('heads/main');
          const fast = yield* observe(f.root);
          expect(fast.detail.identity.branch).toBe('main');
          expect(fast.detail).toEqual((yield* observe(f.root, 'unsupported')).detail);
          expect(fast.branchReads).toBe(0);
        }
      }).pipe(TestClock.withLive),
    );

    test.effect('falls back for incomplete frames and unborn HEAD, and binds linked worktree subdirectories', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const linked = f.path.join(f.home, 'linked');
        yield* f.git(['worktree', 'add', '--quiet', '-b', 'linked', linked]);
        const nested = f.path.join(linked, 'nested');
        yield* f.fs.makeDirectory(nested);
        const fast = yield* observe(nested, 'normal', true);
        const legacy = yield* observe(nested, 'malformed', true);
        expect(fast.detail).toEqual(legacy.detail);
        expect(fast.detail.identity.branch).toBe('linked');
        expect(fast.detail.identity.repoRoot).toBe(yield* f.fs.realPath(linked));
        expect(fast.branchReads).toBe(0);
        expect(legacy.branchReads).toBe(1);
        expect(legacy.metadata).toBeUndefined();
        const unborn = f.path.join(f.home, 'unborn');
        yield* f.fs.makeDirectory(unborn);
        yield* runCommandEffect('git', ['-C', unborn, 'init', '--quiet', '--initial-branch=unborn']);
        const initial = yield* observe(unborn, 'normal', true);
        expect(initial.detail).toEqual((yield* observe(unborn, 'unsupported', true)).detail);
        expect(initial.detail.identity.branch).toBe('unborn');
        expect(initial.detail.identity.headCommit).toMatch(/^0+$/u);
        expect(initial.branchReads).toBe(1);
        expect(initial.metadata).toBeUndefined();
      }).pipe(TestClock.withLive),
    );
  });

  it('rejects malformed branch frames without mutating input and preserves detached and bounded Unicode names', () => {
    const utf8 = new TextEncoder();
    const prefix = `/repo\n/common\n/git\nsha1\n${Effect2.pipe('a', EffectString.repeat(40))}\n`;
    for (const branch of ['main', 'feature/東🦉', Effect2.pipe('a', EffectString.repeat(1024)), 'HEAD']) {
      const bytes = utf8.encode(`${prefix}${branch}\n`);
      const before = bytes.slice();
      expect(parseRepositoryIdentityMetadata(bytes)?.branch).toEqual(
        branch === 'HEAD' ? {state: 'detached'} : {state: 'current', branch},
      );
      expect(bytes).toEqual(before);
    }
    for (const branch of [
      '',
      Effect2.pipe('a', EffectString.repeat(1025)),
      Effect2.pipe('東', EffectString.repeat(342)),
      ' main',
      'main ',
      'a\tb',
      'a\rb',
      'a\0b',
      'a\x7fb',
      'a\u202eb',
      'a\nb',
    ])
      expect(parseRepositoryIdentityMetadata(utf8.encode(`${prefix}${branch}\n`))).toBeUndefined();
    expect(parseRepositoryIdentityMetadata(utf8.encode(prefix))).toBeUndefined();
    expect(parseRepositoryIdentityMetadata(utf8.encode(`${prefix}main`))).toBeUndefined();
    expect(parseRepositoryIdentityMetadata(utf8.encode(`${prefix}main\nextra\n`))).toBeUndefined();
  });
});
