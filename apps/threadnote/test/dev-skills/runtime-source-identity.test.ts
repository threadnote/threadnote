import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, String as EffectString} from 'effect';
import {expect} from 'vitest';
import {runtimeSourceIdentity, assertRuntimeSourceIdentity} from '../../../../scripts/runtime-source-identity.js';

effectIt.layer(BunServices.layer)(it => {
  it.effect('qualifies only exact clean committed source and rejects changes during compilation', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'runtime-source-identity-'});
      const git = (...args: string[]) =>
        Effect.sync(() => {
          const result = Bun.spawnSync({cmd: ['git', '-C', root, ...args], stdout: 'pipe', stderr: 'pipe'});
          expect(result.exitCode, result.stderr.toString()).toBe(0);
          return EffectString.trim(result.stdout.toString());
        });
      yield* git('init', '--initial-branch=main');
      yield* git('config', 'user.name', 'Source Identity');
      yield* git('config', 'user.email', 'source@example.invalid');
      const source = path.join(root, 'source.ts');
      yield* fs.writeFileString(source, 'export const value = true;\n');
      yield* git('add', 'source.ts');
      yield* git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Committed source');
      const identity = yield* runtimeSourceIdentity(root, 'bun-darwin-arm64');
      expect(identity).toEqual({
        version: 1,
        commit: yield* git('rev-parse', 'HEAD'),
        tree: yield* git('rev-parse', 'HEAD^{tree}'),
        bun: Bun.version,
        target: 'bun-darwin-arm64',
      });
      yield* assertRuntimeSourceIdentity(root, 'bun-darwin-arm64', identity);
      expect((yield* runtimeSourceIdentity(root, 'bun-linux-x64'))?.target).toBe('bun-linux-x64');
      yield* fs.writeFileString(source, 'export const value = false;\n');
      expect(yield* runtimeSourceIdentity(root, 'bun-darwin-arm64')).toBeUndefined();
      expect((yield* assertRuntimeSourceIdentity(root, 'bun-darwin-arm64', identity).pipe(Effect.result))._tag).toBe(
        'Failure',
      );
      yield* fs.writeFileString(source, 'export const value = true;\n');
      expect(yield* runtimeSourceIdentity(root, 'bun-darwin-arm64')).toEqual(identity);
      const untracked = path.join(root, 'untracked.ts');
      yield* fs.writeFileString(untracked, 'unknown source');
      expect(yield* runtimeSourceIdentity(root, 'bun-darwin-arm64')).toBeUndefined();
      yield* fs.remove(untracked);
      expect(yield* runtimeSourceIdentity(root, 'bun-darwin-arm64')).toEqual(identity);
    }),
  );
});
