import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Option, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {
  captureNativeCycleSource,
  pinNativeCycleTree,
  readNativeCycleTreeEntry,
} from '../../src/workflow_automation/cycle_git.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const run = <A, E, R>(program: Effect.Effect<A, E, R>) => program.pipe(TestClock.withLive, provideNative);
const git = (repo: string, ...args: string[]) =>
  runCommandEffect('git', ['--no-optional-locks', '-C', repo, ...args]).pipe(Effect.map(result => result.stdout));
const commit = (repo: string) =>
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture');

describe('native cycle Git snapshots', () => {
  effectIt.effect('accepts an alternate canonical spelling only when native directory identity matches', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* git(f.repo, 'add', 'source.ts');
      yield* commit(f.repo);
      const originalFs = f.fs;
      let realPathCalls = 0;
      const aliasFs = {
        ...originalFs,
        realPath: (path: string) =>
          originalFs.realPath(path).pipe(
            Effect.map(actual => {
              realPathCalls++;
              return realPathCalls === 1 ? `${actual}${f.path.sep}.` : actual;
            }),
          ),
      } satisfies FileSystem.FileSystem;
      const index = f.path.join(f.repo, '.git', 'index');
      const beforeIndex = yield* f.fs.readFile(index);
      const snapshot = yield* captureNativeCycleSource(f.repo, 'HEAD').pipe(
        Effect.provideService(FileSystem.FileSystem, aliasFs),
      );
      const gitRoot = Effect2.pipe(yield* git(f.repo, 'rev-parse', '--show-toplevel'), EffectString.trim);
      expect(snapshot.repo).toBe(yield* f.fs.realPath(gitRoot));
      expect(yield* f.fs.readFile(index)).toEqual(beforeIndex);
    }).pipe(run),
  );

  effectIt.effect('rejects subdirectory and sibling Git roots', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const subdirectory = f.path.join(f.repo, 'nested');
      yield* f.fs.makeDirectory(subdirectory);
      const sibling = f.path.join(f.root, 'sibling');
      yield* f.fs.makeDirectory(sibling);
      const subdirectoryResult = yield* captureNativeCycleSource(subdirectory, 'HEAD').pipe(Effect.result);
      const siblingResult = yield* captureNativeCycleSource(sibling, 'HEAD').pipe(Effect.result);
      expect(subdirectoryResult._tag).toBe('Failure');
      expect(siblingResult._tag).toBe('Failure');
      if (subdirectoryResult._tag === 'Failure')
        expect(subdirectoryResult.failure).toMatchObject({code: 'binding-drift'});
    }).pipe(run),
  );

  effectIt.effect('captures staged, unstaged, untracked and binary content without changing the real index', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* git(f.repo, 'add', 'source.ts');
      yield* commit(f.repo);
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'staged\n');
      yield* git(f.repo, 'add', 'source.ts');
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'working\n');
      const binary = new Uint8Array([0, 255, 1, 128]);
      yield* f.fs.writeFile(f.path.join(f.repo, 'new.bin'), binary);
      const indexPath = f.path.join(f.repo, '.git', 'index');
      const beforeIndex = yield* f.fs.readFile(indexPath);
      const beforeStatus = yield* git(f.repo, 'status', '--porcelain=v2', '-z');
      const snapshot = yield* captureNativeCycleSource(f.repo, 'HEAD');
      expect(EffectRecord.keys(snapshot.files).sort()).toEqual(['new.bin', 'source.ts']);
      expect(yield* git(f.repo, 'show', `${snapshot.tree}:source.ts`)).toBe('working\n');
      expect(yield* f.fs.readFile(indexPath)).toEqual(beforeIndex);
      expect(yield* git(f.repo, 'status', '--porcelain=v2', '-z')).toBe(beforeStatus);
      expect(Array.from(yield* f.fs.readFile(f.path.join(f.repo, 'new.bin')))).toEqual(Array.from(binary));
      const ref = yield* pinNativeCycleTree(
        f.repo,
        Effect2.pipe('a', EffectString.repeat(64)),
        'phase-review-1',
        snapshot.tree,
      );
      expect(ref.length).toBeLessThanOrEqual(100);
      expect(
        Effect2.pipe(
          ref,
          EffectString.slice(
            Effect2.pipe(
              ref,
              EffectString.lastIndexOf('/'),
              Effect2.Option.getOrElse(() => -1),
            ) + 1,
          ),
        ),
      ).toMatch(/^[a-f0-9]{64}$/u);
      const otherBinding = yield* pinNativeCycleTree(
        f.repo,
        Effect2.pipe('b', EffectString.repeat(64)),
        'phase-review-1',
        snapshot.tree,
      );
      const otherPurpose = yield* pinNativeCycleTree(
        f.repo,
        Effect2.pipe('a', EffectString.repeat(64)),
        'phase-review-1',
        snapshot.tree,
        'baseline',
      );
      expect(new Set([ref, otherBinding, otherPurpose]).size).toBe(3);
      expect(yield* git(f.repo, 'rev-parse', ref)).toBe(snapshot.tree + '\n');
      expect(
        yield* pinNativeCycleTree(f.repo, Effect2.pipe('a', EffectString.repeat(64)), 'phase-review-1', snapshot.tree),
      ).toBe(ref);
      const conflict = yield* pinNativeCycleTree(
        f.repo,
        Effect2.pipe('a', EffectString.repeat(64)),
        'phase-review-1',
        snapshot.baseTree,
      ).pipe(Effect.result);
      expect(Result.isFailure(conflict)).toBe(true);
      expect(yield* git(f.repo, 'rev-parse', ref)).toBe(snapshot.tree + '\n');
    }).pipe(run),
  );

  effectIt.effect('rehashes a same-size edit even when its original timestamps are restored', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const file = f.path.join(f.repo, 'source.ts');
      yield* git(f.repo, 'add', 'source.ts');
      yield* commit(f.repo);
      const stat = yield* f.fs.stat(file);
      const initial = yield* captureNativeCycleSource(f.repo, 'HEAD');
      yield* f.fs.writeFileString(file, 'export const fixture = null;\n');
      yield* f.fs.utimes(file, Option.getOrThrow(stat.atime), Option.getOrThrow(stat.mtime));
      const changed = yield* captureNativeCycleSource(f.repo, 'HEAD');
      expect(changed.tree).not.toBe(initial.tree);
      expect(yield* git(f.repo, 'show', `${changed.tree}:source.ts`)).toBe('export const fixture = null;\n');
      const indexPath = f.path.join(f.repo, '.git', 'index');
      const before = yield* f.fs.readFile(indexPath);
      expect((yield* captureNativeCycleSource(f.repo, 'HEAD')).tree).toBe(changed.tree);
      expect(yield* f.fs.readFile(indexPath)).toEqual(before);
    }).pipe(run),
  );

  effectIt.effect('captures Git tree mode identity for executable changes, additions, and deletions', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* git(f.repo, 'config', 'core.filemode', 'false');
      yield* f.fs.writeFileString(f.path.join(f.repo, 'script.sh'), '#!/bin/sh\necho ok\n');
      yield* git(f.repo, 'add', '--all');
      yield* commit(f.repo);
      const baseline = Effect2.pipe(yield* git(f.repo, 'rev-parse', 'HEAD'), EffectString.trim);
      const originalBlob = Effect2.pipe(yield* git(f.repo, 'rev-parse', `${baseline}:script.sh`), EffectString.trim);
      yield* git(f.repo, 'update-index', '--chmod=+x', '--', 'script.sh');
      yield* commit(f.repo);
      yield* f.fs.remove(f.path.join(f.repo, 'source.ts'));
      yield* f.fs.writeFileString(f.path.join(f.repo, 'new.txt'), 'new content\n');

      const snapshot = yield* captureNativeCycleSource(f.repo, baseline);
      expect(snapshot.entries).toMatchObject({
        'script.sh': {mode: '100755', blob: originalBlob},
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
        'source.ts': {mode: '000000', blob: '0'.repeat(snapshot.head.length)},
        'new.txt': {mode: '100644'},
      });
      expect(yield* readNativeCycleTreeEntry(f.repo, snapshot.tree, 'script.sh')).toEqual(
        snapshot.entries['script.sh'],
      );
      expect(yield* readNativeCycleTreeEntry(f.repo, snapshot.tree, 'source.ts')).toEqual({
        mode: '000000',
        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
        blob: '0'.repeat(snapshot.head.length),
      });
    }).pipe(run),
  );

  effectIt.effect('consumes porcelain-v2 rename source paths even when they resemble status records', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const original = '1 x S.M. note';
      yield* f.fs.writeFileString(f.path.join(f.repo, original), 'rename source\n');
      yield* git(f.repo, 'add', '--all');
      yield* commit(f.repo);
      yield* git(f.repo, 'mv', original, 'renamed note');
      const indexPath = f.path.join(f.repo, '.git', 'index');
      const beforeIndex = yield* f.fs.readFile(indexPath);
      const snapshot = yield* captureNativeCycleSource(f.repo, 'HEAD');
      expect(snapshot.files).toHaveProperty(original);
      expect(snapshot.files).toHaveProperty('renamed note');
      expect(yield* f.fs.readFile(indexPath)).toEqual(beforeIndex);
    }).pipe(run),
  );

  effectIt.effect('rejects dirty submodule content without changing contributor bytes', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const child = f.path.join(f.root, 'child');
      yield* f.fs.makeDirectory(child);
      yield* git(child, 'init', '--initial-branch=main');
      yield* f.fs.writeFileString(f.path.join(child, 'child.ts'), 'initial\n');
      yield* git(child, 'add', 'child.ts');
      yield* commit(child);
      yield* git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'module');
      yield* git(f.repo, 'add', '--all');
      yield* commit(f.repo);
      const changed = f.path.join(f.repo, 'module', 'child.ts');
      yield* f.fs.writeFileString(changed, 'dirty\n');
      const indexPath = f.path.join(f.repo, '.git', 'index');
      const before = yield* f.fs.readFile(indexPath);
      const result = yield* captureNativeCycleSource(f.repo, 'HEAD').pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toMatchObject({code: 'dirty-submodule'});
      expect(yield* f.fs.readFile(indexPath)).toEqual(before);
      expect(yield* f.fs.readFileString(changed)).toBe('dirty\n');
    }).pipe(run),
  );
});
