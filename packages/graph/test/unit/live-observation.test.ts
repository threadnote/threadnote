import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {observeLiveWorktree} from '@threadnote/graph/live_observation';
import {citationPlatformLayer} from '../helpers/citation-platform.js';

const git = (root: string, args: readonly string[]) => runCommandEffect('git', ['-C', root, ...args]);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-live-observation-'});
  yield* git(root, ['init', '--quiet']);
  yield* git(root, ['config', 'user.name', 'Test']);
  yield* git(root, ['config', 'user.email', 'test@example.invalid']);
  yield* fs.writeFileString(path.join(root, 'source.ts'), 'first');
  yield* git(root, ['add', '.']);
  yield* git(root, ['commit', '--quiet', '-m', 'initial']);
  return {root, fs, path};
});

describe('passive live worktree observation', () => {
  effectIt.layer(citationPlatformLayer)(it => {
    it.effect('is stable when clean and changes for repeated edits with identical porcelain', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const {root, fs, path} = yield* fixture;
          const baseline = yield* observeLiveWorktree(root);
          const repeated = yield* observeLiveWorktree(root);
          expect(baseline.state).toBe('complete');
          expect(repeated).toEqual(baseline);
          yield* fs.writeFileString(path.join(root, 'source.ts'), 'second');
          const second = yield* observeLiveWorktree(root);
          yield* fs.writeFileString(path.join(root, 'source.ts'), 'third');
          const third = yield* observeLiveWorktree(root);
          expect(second.state).toBe('complete');
          expect(third.state).toBe('complete');
          if (baseline.state === 'complete' && second.state === 'complete' && third.state === 'complete') {
            expect(new Set([baseline.revision, second.revision, third.revision]).size).toBe(3);
            expect(third.headCommit).toBe(baseline.headCommit);
            expect(third.watchDirectories.length).toBeGreaterThanOrEqual(1);
          }
          expect((yield* git(root, ['status', '--porcelain=v1'])).stdout).toBe(' M source.ts\n');
        }),
      ),
    );

    it.effect('tracks untracked rename, staging, deletion and commit without mutating index', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const {root, fs, path} = yield* fixture;
          const first = yield* observeLiveWorktree(root);
          yield* fs.writeFileString(path.join(root, 'new.ts'), 'new');
          const added = yield* observeLiveWorktree(root);
          yield* fs.rename(path.join(root, 'new.ts'), path.join(root, 'renamed.ts'));
          const renamed = yield* observeLiveWorktree(root);
          yield* git(root, ['add', 'renamed.ts']);
          const staged = yield* observeLiveWorktree(root);
          yield* fs.remove(path.join(root, 'renamed.ts'));
          const deleted = yield* observeLiveWorktree(root);
          const states = [first, added, renamed, staged, deleted];
          expect(EffectArray.every(states, state => state.state === 'complete')).toBe(true);
          expect(
            new Set(EffectArray.map(states, state => (state.state === 'complete' ? state.revision : ''))).size,
          ).toBe(5);
          expect((yield* git(root, ['status', '--porcelain=v1'])).stdout).toBe('AD renamed.ts\n');
          yield* git(root, ['restore', 'renamed.ts']);
          yield* git(root, ['commit', '--quiet', '-m', 'added']);
          const committed = yield* observeLiveWorktree(root);
          expect(committed.state).toBe('complete');
          if (committed.state === 'complete' && first.state === 'complete')
            expect(committed.headCommit).not.toBe(first.headCommit);
        }),
      ),
    );

    it.effect('reports budget overflow instead of an unchanged revision', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const {root, fs, path} = yield* fixture;
          yield* fs.writeFileString(path.join(root, 'large.ts'), '123456789');
          expect(yield* observeLiveWorktree(root, {maxReadBytes: 4})).toEqual({state: 'unavailable', reason: 'budget'});
          expect(yield* observeLiveWorktree(root, {maxChangedFiles: 0})).toEqual({
            state: 'unavailable',
            reason: 'budget',
          });
          expect(yield* observeLiveWorktree(root, {maxGitOutputBytes: 1})).toEqual({
            state: 'unavailable',
            reason: 'budget',
          });
        }),
      ),
    );

    it.effect('refuses index flags that hide working source changes from Git status', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const {root, fs, path} = yield* fixture;
          for (const flag of ['assume-unchanged', 'skip-worktree']) {
            yield* git(root, ['update-index', `--${flag}`, 'source.ts']);
            yield* fs.writeFileString(path.join(root, 'source.ts'), 'hidden source change');
            expect((yield* git(root, ['status', '--porcelain=v1'])).stdout).toBe('');
            expect((yield* observeLiveWorktree(root)).state).toBe('unavailable');
            yield* git(root, ['update-index', `--no-${flag}`, 'source.ts']);
            yield* git(root, ['restore', 'source.ts']);
          }
        }),
      ),
    );

    it.effect('reports a missing repository without exposing command output', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const empty = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-live-missing-'});
          expect(yield* observeLiveWorktree(empty)).toEqual({state: 'unavailable', reason: 'missing'});
        }),
      ),
    );

    it.effect('declines a changed symbolic link instead of reading outside the worktree', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const {root, fs, path} = yield* fixture;
          const outside = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-live-outside-'});
          yield* fs.writeFileString(path.join(outside, 'source.ts'), 'outside');
          yield* fs.symlink(path.join(outside, 'source.ts'), path.join(root, 'link.ts'));
          expect(yield* observeLiveWorktree(root)).toEqual({state: 'unavailable', reason: 'unstable'});
        }),
      ),
    );

    it.effect('includes local ignore-rule edits even when Git porcelain is unchanged', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const {root, fs, path} = yield* fixture;
          const first = yield* observeLiveWorktree(root);
          yield* fs.writeFileString(path.join(root, '.threadnoteignore.local'), 'node_modules/\n');
          const second = yield* observeLiveWorktree(root);
          yield* fs.writeFileString(path.join(root, '.threadnoteignore.local'), 'build/\n');
          const third = yield* observeLiveWorktree(root);
          expect(EffectArray.every([first, second, third], state => state.state === 'complete')).toBe(true);
          expect(
            new Set(
              EffectArray.map([first, second, third], state => (state.state === 'complete' ? state.revision : '')),
            ).size,
          ).toBe(3);
        }),
      ),
    );

    it.effect.prop(
      'same dirty bytes yield the same revision without an index write',
      {content: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 1_000_000}))},
      ({content}) =>
        TestClock.withLive(
          Effect.gen(function* () {
            const {root, fs, path} = yield* fixture;
            yield* fs.writeFileString(path.join(root, 'source.ts'), String(content));
            const index = path.join(root, '.git', 'index');
            const before = yield* fs.stat(index);
            const first = yield* observeLiveWorktree(root);
            const second = yield* observeLiveWorktree(root);
            const after = yield* fs.stat(index);
            expect(first.state).toBe('complete');
            expect(second).toEqual(first);
            expect(after.mtime).toEqual(before.mtime);
          }),
        ),
      {timeout: 60_000, arbitrary: {runs: 24, seed: 10023}},
    );
  });
});
