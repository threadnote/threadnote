import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {worktreeOverlayState} from '@threadnote/graph/inventory';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {citationPlatformLayer} from '../helpers/citation-platform.js';

describe('committed overlay basis reuse', () => {
  effectIt.layer(citationPlatformLayer)(it => {
    it.effect(
      'reuses one HEAD basis while checking changed bytes, untracked paths, and local ignore rules afresh',
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-overlay-basis-'});
            const git = (args: readonly string[]) => runCommandEffect('git', ['-C', root, ...args]);
            yield* git(['init', '--quiet']);
            yield* git(['config', 'user.name', 'Test']);
            yield* git(['config', 'user.email', 'test@example.invalid']);
            yield* fs.makeDirectory(path.join(root, 'src'));
            yield* fs.writeFileString(path.join(root, 'package.json'), '{"name":"overlay-basis"}\n');
            yield* fs.writeFileString(path.join(root, '.threadnoteignore'), 'src/ignored.ts\n');
            yield* fs.writeFileString(path.join(root, 'src/index.ts'), 'export const value = 0;\n');
            yield* fs.writeFileString(path.join(root, 'src/ignored.ts'), 'export const ignored = 0;\n');
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'first']);

            let identity = yield* resolveRepositoryIdentity(root);
            const command = yield* CommandExecutor;
            let treeReads = 0;
            let committedContextReads = 0;
            const observed = CommandExecutor.of({
              ...command,
              execute: (executable, args, options) => {
                if (executable === 'git' && args.includes('ls-tree')) treeReads++;
                return command.execute(executable, args, options);
              },
              executeBytes: (executable, args, options) => {
                if (executable === 'git' && args.includes('cat-file')) committedContextReads++;
                return command.executeBytes!(executable, args, options);
              },
            });
            const observe = () => worktreeOverlayState(identity).pipe(Effect.provideService(CommandExecutor, observed));

            yield* fs.writeFileString(path.join(root, 'src/index.ts'), 'export const value = 1;\n');
            const first = yield* observe();
            expect(first).toMatchObject({dirty: true, fingerprint: expect.any(String)});
            expect(yield* observe()).toEqual(first);
            expect(treeReads).toBe(1);
            expect(committedContextReads).toBe(1);

            yield* fs.writeFileString(path.join(root, 'src/index.ts'), 'export const value = 2;\n');
            const changedBytes = yield* observe();
            expect(changedBytes.fingerprint).not.toBe(first.fingerprint);
            yield* fs.writeFileString(path.join(root, 'src/new.ts'), 'export const fresh = true;\n');
            const untracked = yield* observe();
            expect(untracked.fingerprint).not.toBe(changedBytes.fingerprint);
            yield* fs.writeFileString(path.join(root, '.threadnoteignore.local'), 'src/new.ts\n');
            const locallyIgnored = yield* observe();
            expect(locallyIgnored.fingerprint).not.toBe(untracked.fingerprint);
            expect(treeReads).toBe(1);
            expect(committedContextReads).toBe(1);

            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'second']);
            yield* fs.writeFileString(path.join(root, 'src/index.ts'), 'export const value = 3;\n');
            identity = yield* resolveRepositoryIdentity(root);
            expect((yield* observe()).dirty).toBe(true);
            expect(treeReads).toBe(2);
            expect(committedContextReads).toBe(2);
          }),
        ),
    );
  });
});
