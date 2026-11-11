import {describe, expect} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, String as EffectString} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {NATIVE_VECTOR_READER_FILES} from '@threadnote/recall/vector/native-reader-payload';
import {nativeReaderBuildInputs, nativeReaderGit} from '../../../../scripts/native-vector-reader-payload.js';

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'native-reader-build-'});
  const crate = path.join(root, 'packages', 'recall', 'native-vector-reader');
  yield* fs.makeDirectory(path.join(crate, 'src'), {recursive: true});
  for (const name of NATIVE_VECTOR_READER_FILES) yield* fs.writeFileString(path.join(crate, name), `fixture:${name}`);
  yield* fs.writeFileString(path.join(root, '.gitignore'), '/dist/\n');
  yield* Effect.sync(() => {
    nativeReaderGit(root, ['init', '--quiet']);
    nativeReaderGit(root, ['add', '.']);
    nativeReaderGit(root, [
      '-c',
      'user.name=Native Reader Test',
      '-c',
      'user.email=native-reader@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);
  });
  yield* fs.makeDirectory(path.join(root, 'dist'));
  return {fs, path, root, crate};
});

describe('native vector build identity', () => {
  effectIt.layer(BunServices.layer)(it => {
    it.effect('binds actual dirty development inputs to the base Git identity', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const before = yield* Effect.promise(() => nativeReaderBuildInputs(f.root, 'bun-darwin-arm64', true));
        yield* f.fs.writeFileString(f.path.join(f.crate, 'src', 'lib.rs'), 'changed native input');
        const after = yield* Effect.promise(() => nativeReaderBuildInputs(f.root, 'bun-darwin-arm64', true));
        expect(after?.sourceCommit).toBe(before?.sourceCommit);
        expect(after?.sourceTree).toBe(before?.sourceTree);
        expect(after?.sourceSha256).not.toBe(before?.sourceSha256);
        expect(after?.lockSha256).toBe(before?.lockSha256);
        yield* Effect.promise(() =>
          expect(nativeReaderBuildInputs(f.root, 'bun-darwin-arm64', false)).rejects.toThrow(
            'clean committed checkout',
          ),
        );
      }),
    );
    it.effect('requires the JavaScript distribution identity to match clean HEAD and target', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const source = yield* Effect.promise(() => nativeReaderBuildInputs(f.root, 'bun-darwin-arm64', true));
        if (!source) throw new Error('Fixture target is unavailable.');
        const release = {
          target: 'bun-darwin-arm64',
          sourceIdentity: {commit: source.sourceCommit, tree: source.sourceTree, target: 'bun-darwin-arm64'},
        };
        const releasePath = f.path.join(f.root, 'dist', 'release.json');
        yield* f.fs.writeFileString(
          releasePath,
          JSON.stringify({
            ...release,
            sourceIdentity: {...release.sourceIdentity, commit: EffectString.repeat(40)('0')},
          }),
        );
        yield* Effect.promise(() =>
          expect(nativeReaderBuildInputs(f.root, 'bun-darwin-arm64', false)).rejects.toThrow('source identity'),
        );
        yield* f.fs.writeFileString(releasePath, JSON.stringify(release));
        expect(yield* Effect.promise(() => nativeReaderBuildInputs(f.root, 'bun-darwin-arm64', false))).toEqual(source);
      }),
    );
  });
});
