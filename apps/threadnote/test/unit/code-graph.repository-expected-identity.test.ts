import {Array as EffectArray} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect's symlink API lacks the junction type required for unprivileged Windows fixtures.
import {symlinkSync} from 'node:fs';
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import fc from 'fast-check';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {
  parseRepositoryIdentityWorktreeObservation,
  parseRepositoryReadFenceSetupObservation,
  resolveRepositoryIdentity,
  resolveRepositoryIdentityForExpectation,
  resolveRepositoryIdentityForExpectationAndWorktree,
  resolvePublishedRepositoryReadFence,
  revalidateRepositoryIdentityFence,
} from '@threadnote/graph/repository';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

describe('code graph expected repository identity', () => {
  effectIt.layer(ApplicationLayer)(it => {
    it.effect('matches full discovery and rejects a changed remote identity', () =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* Effect.acquireRelease(
              fs.makeTempDirectory({prefix: 'threadnote-expected-identity-'}),
              directory => fs.remove(directory, {force: true, recursive: true}).pipe(Effect.orDie),
            );
            yield* git(root, ['init', '-q']);
            yield* git(root, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '--allow-empty',
              '-qm',
              'fixture',
            ]);
            const sourceDirectory = path.join(root, 'src');
            yield* fs.makeDirectory(sourceDirectory);
            const local = yield* resolveRepositoryIdentity(root);
            const localExpected = {
              checkoutId: local.checkoutId,
              repositoryId: local.repositoryId,
              worktreeId: local.worktreeId,
            };
            expect(yield* resolveRepositoryIdentityForExpectation(sourceDirectory, localExpected)).toEqual(local);
            expect(yield* resolveRepositoryIdentityForExpectationAndWorktree(sourceDirectory, localExpected)).toEqual({
              identity: local,
              worktreeChanged: false,
            });
            yield* fs.writeFileString(path.join(sourceDirectory, 'dirty.ts'), 'export const dirty = true;\n');
            expect(
              (yield* resolveRepositoryIdentityForExpectationAndWorktree(sourceDirectory, localExpected))
                .worktreeChanged,
            ).toBe(true);
            yield* fs.remove(path.join(sourceDirectory, 'dirty.ts'));

            yield* git(root, ['remote', 'add', 'origin', 'https://github.com/example/original.git']);
            const localFailure = yield* resolveRepositoryIdentityForExpectation(root, localExpected).pipe(Effect.flip);
            expect(localFailure.message).toBe('Repository identity does not match the published workset.');

            const remote = yield* resolveRepositoryIdentity(root);
            const remoteExpected = {
              checkoutId: remote.checkoutId,
              repositoryId: remote.repositoryId,
              worktreeId: remote.worktreeId,
            };
            expect(yield* resolveRepositoryIdentityForExpectation(root, remoteExpected)).toEqual(remote);

            yield* git(root, ['remote', 'set-url', 'origin', 'https://github.com/example/replaced.git']);
            const failure = yield* resolveRepositoryIdentityForExpectation(root, remoteExpected).pipe(Effect.flip);
            expect(failure.message).toBe('Repository identity does not match the published workset.');
          }),
        ),
      ),
    );

    it.effect('revalidates code-bearing identity fields and observes a changed HEAD', () =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const root = yield* Effect.acquireRelease(
              fs.makeTempDirectory({prefix: 'threadnote-identity-fence-'}),
              directory => fs.remove(directory, {force: true, recursive: true}).pipe(Effect.orDie),
            );
            yield* git(root, ['init', '-q']);
            yield* git(root, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '--allow-empty',
              '-qm',
              'fixture',
            ]);
            const before = yield* resolveRepositoryIdentity(root);
            expect(yield* revalidateRepositoryIdentityFence(root, before)).toEqual(before);

            yield* git(root, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '--allow-empty',
              '-qm',
              'next',
            ]);
            const after = yield* revalidateRepositoryIdentityFence(root, before);
            expect(after.headCommit).not.toBe(before.headCommit);
            expect(after.repositoryId).toBe(before.repositoryId);
            expect(after.worktreeId).toBe(before.worktreeId);

            yield* git(root, ['remote', 'add', 'origin', 'https://github.com/example/replaced.git']);
            const failure = yield* revalidateRepositoryIdentityFence(root, before).pipe(Effect.flip);
            expect(failure.message).toBe('Repository identity changed during the graph read.');
          }),
        ),
      ),
    );

    it.effect('closes a clean published read across caller-path, worktree, and HEAD observations', () =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const parent = yield* Effect.acquireRelease(
              fs.makeTempDirectory({prefix: 'threadnote-published-read-fence-'}),
              directory => fs.remove(directory, {force: true, recursive: true}).pipe(Effect.orDie),
            );
            const first = path.join(parent, 'first');
            const second = path.join(parent, 'second');
            const caller = path.join(parent, 'caller');
            yield* fs.makeDirectory(first);
            yield* git(first, ['init', '-q']);
            yield* fs.writeFileString(path.join(first, 'tracked.ts'), 'export const tracked = 1;\n');
            yield* git(first, ['add', 'tracked.ts']);
            yield* git(first, [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '--allow-empty',
              '-qm',
              'fixture',
            ]);
            yield* git(first, ['remote', 'add', 'origin', 'https://github.com/example/read-fence.git']);
            yield* git(parent, ['clone', '--quiet', first, second]);
            yield* git(second, ['remote', 'set-url', 'origin', 'https://github.com/example/read-fence.git']);
            yield* fs.symlink(first, caller);
            const identity = yield* resolveRepositoryIdentity(caller);
            const expected = {
              checkoutId: identity.checkoutId,
              repositoryId: identity.repositoryId,
              worktreeId: identity.worktreeId,
            };
            const command = yield* CommandExecutor;
            const invocations: string[][] = [];
            const recording = CommandExecutor.of({
              ...command,
              execute: (executable, args, options) =>
                Effect.sync(() => {
                  if (executable === 'git') invocations.push([...args]);
                }).pipe(Effect.andThen(command.execute(executable, args, options))),
            });
            expect(
              yield* resolvePublishedRepositoryReadFence(caller, expected).pipe(
                Effect.provideService(CommandExecutor, recording),
              ),
            ).toEqual({
              ...expected,
              headCommit: identity.headCommit,
              worktreeChanged: false,
            });
            expect(invocations).toHaveLength(3);
            expect(
              EffectArray.filter(
                invocations,
                __effectArrayValue => !!(args => args.includes('status'))(__effectArrayValue),
              ),
            ).toHaveLength(1);
            expect(
              EffectArray.map(invocations, args =>
                EffectOption.getOrUndefined(
                  EffectArray.findFirst(
                    args,
                    __effectArrayValue =>
                      !!(argument => ['remote', 'rev-parse', 'status'].includes(argument))(__effectArrayValue),
                  ),
                ),
              ),
            ).toEqual(['rev-parse', 'remote', 'status']);

            const failure = yield* resolvePublishedRepositoryReadFence(caller, expected, {
              afterInitialIdentity: () => fs.remove(caller).pipe(Effect.andThen(fs.symlink(second, caller))),
            }).pipe(Effect.flip);
            expect(failure).toBeInstanceOf(Error);
            expect(failure).toHaveProperty('message', 'Repository identity changed during the graph read.');

            yield* fs.remove(caller);
            yield* fs.symlink(first, caller);
            const remoteFailure = yield* resolvePublishedRepositoryReadFence(caller, expected, {
              afterInitialIdentity: () =>
                git(first, ['remote', 'set-url', 'origin', 'https://github.com/example/replaced.git']).pipe(
                  Effect.asVoid,
                ),
            }).pipe(Effect.flip);
            expect(remoteFailure).toBeInstanceOf(Error);
            expect(remoteFailure).toHaveProperty('message', 'Repository identity changed during the graph read.');
            yield* git(first, ['remote', 'set-url', 'origin', 'https://github.com/example/read-fence.git']);

            const lateRetargetFailure = yield* resolvePublishedRepositoryReadFence(caller, expected, {
              beforeClosingWorktreeObservation: () =>
                fs.remove(caller).pipe(Effect.andThen(fs.symlink(second, caller))),
            }).pipe(Effect.flip);
            expect(lateRetargetFailure).toBeInstanceOf(Error);
            expect(lateRetargetFailure).toHaveProperty('message', 'Repository identity changed during the graph read.');

            yield* fs.remove(caller);
            yield* fs.symlink(first, caller);
            const changed = yield* resolvePublishedRepositoryReadFence(caller, expected, {
              beforeClosingWorktreeObservation: () =>
                fs.writeFileString(path.join(first, 'tracked.ts'), 'export const tracked = 2;\n'),
            });
            expect(changed).toEqual({...expected, headCommit: identity.headCommit, worktreeChanged: true});
            yield* fs.writeFileString(path.join(first, 'tracked.ts'), 'export const tracked = 1;\n');

            const firstGitDirectory = path.join(first, '.git');
            const savedFirstGitDirectory = path.join(first, '.git-before-retarget');
            const commonDirectoryFailure = yield* resolvePublishedRepositoryReadFence(caller, expected, {
              beforeClosingWorktreeObservation: () =>
                fs
                  .rename(firstGitDirectory, savedFirstGitDirectory)
                  .pipe(
                    Effect.andThen(fs.writeFileString(firstGitDirectory, `gitdir: ${path.join(second, '.git')}\n`)),
                  ),
            }).pipe(
              Effect.ensuring(
                fs
                  .remove(firstGitDirectory, {force: true})
                  .pipe(Effect.andThen(fs.rename(savedFirstGitDirectory, firstGitDirectory)), Effect.orDie),
              ),
              Effect.flip,
            );
            expect(commonDirectoryFailure).toBeInstanceOf(Error);
            expect(commonDirectoryFailure).toHaveProperty(
              'message',
              'Repository identity changed during the graph read.',
            );

            const headFailure = yield* resolvePublishedRepositoryReadFence(caller, expected, {
              beforeClosingWorktreeObservation: () =>
                git(first, [
                  '-c',
                  'user.name=Threadnote Test',
                  '-c',
                  'user.email=test@threadnote.local',
                  'commit',
                  '--allow-empty',
                  '-qm',
                  'interlocked next head',
                ]).pipe(Effect.asVoid),
            }).pipe(Effect.flip);
            expect(headFailure).toBeInstanceOf(Error);
            expect(headFailure).toHaveProperty('message', 'Repository identity changed during the graph read.');
          }),
        ),
      ),
    );
  });

  effectIt.effect('binds expected identity observations to one checkout across same-HEAD caller retargets', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const command = yield* CommandExecutor;
      const parent = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-expected-route-'});
      const first = path.join(parent, 'first with spaces');
      const clone = path.join(parent, 'clone');
      const caller = path.join(parent, 'caller');
      yield* fs.makeDirectory(first);
      yield* git(first, ['init', '-q']);
      yield* fs.writeFileString(path.join(first, 'tracked.ts'), 'original');
      yield* git(first, ['add', '.']);
      yield* git(first, [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Threadnote Test',
        '-c',
        'user.email=test@threadnote.local',
        'commit',
        '-qm',
        'fixture',
      ]);
      yield* git(first, ['remote', 'add', 'origin', 'https://example.invalid/original.git']);
      yield* git(first, ['config', 'core.ignorecase', 'false']);
      yield* git(parent, ['clone', '--quiet', first, clone]);
      yield* git(clone, ['remote', 'set-url', 'origin', 'https://example.invalid/original.git']);
      yield* git(clone, ['config', 'core.ignorecase', 'false']);
      yield* directoryLink(first, caller);
      const identity = yield* resolveRepositoryIdentity(caller);
      const expected = {
        checkoutId: identity.checkoutId,
        repositoryId: identity.repositoryId,
        worktreeId: identity.worktreeId,
      };
      const canonicalFirst = yield* fs.realPath(first);
      for (const mode of ['unchanged', 'retarget', 'aba-remote', 'aba-config'] as const) {
        let metadataCompleted = false;
        const invocations: string[][] = [];
        const recording = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) =>
            Effect.gen(function* () {
              const metadata = args.includes('--show-toplevel');
              const status = args.includes('status');
              invocations.push([...args]);
              if (!metadata) {
                expect(metadataCompleted).toBe(true);
                expect(args[args.indexOf('-C') + 1]).toBe(status ? caller : canonicalFirst);
              }
              if (status && (mode === 'aba-remote' || mode === 'aba-config')) {
                yield* fs.remove(caller);
                yield* directoryLink(first, caller);
              }
              const result = yield* command.execute(executable, args, options);
              if (metadata) {
                metadataCompleted = true;
                if (mode !== 'unchanged') {
                  yield* fs.remove(caller);
                  yield* directoryLink(clone, caller);
                  if (mode === 'retarget') yield* fs.writeFileString(path.join(first, 'tracked.ts'), 'dirty original');
                  if (mode === 'aba-config')
                    yield* command.execute('git', ['-C', first, 'config', 'core.ignorecase', 'true']);
                  if (mode === 'aba-remote')
                    yield* command.execute('git', [
                      '-C',
                      first,
                      'remote',
                      'set-url',
                      'origin',
                      'https://example.invalid/replaced.git',
                    ]);
                }
              }
              return result;
            }).pipe(Effect.orDie),
        });
        const observation = resolveRepositoryIdentityForExpectationAndWorktree(caller, expected).pipe(
          Effect.provideService(CommandExecutor, recording),
        );
        if (mode === 'unchanged') expect(yield* observation).toEqual({identity, worktreeChanged: false});
        else if (mode === 'aba-config')
          expect(yield* observation).toEqual({
            identity: {...identity, caseMode: 'insensitive'},
            worktreeChanged: false,
          });
        else expect(yield* observation.pipe(Effect.flip)).toBeInstanceOf(Error);
        expect(invocations).toHaveLength(4);
        expect(invocations[0]).toContain('--show-toplevel');
        expect(
          EffectArray.filter(
            invocations,
            __effectArrayValue => !!(args => args.includes('status'))(__effectArrayValue),
          ),
        ).toHaveLength(1);
        yield* fs.remove(caller);
        yield* directoryLink(first, caller);
        yield* fs.writeFileString(path.join(first, 'tracked.ts'), 'original');
        yield* git(first, ['remote', 'set-url', 'origin', 'https://example.invalid/original.git']);
        yield* git(first, ['config', 'core.ignorecase', 'false']);
      }
      for (const corrupt of ['missing', 'duplicate', 'control', 'bidi', 'wrong-root', 'wrong-common'] as const) {
        const recording = CommandExecutor.of({
          ...command,
          execute: (executable, args, options) =>
            command.execute(executable, args, options).pipe(
              Effect.map(result => {
                if (!args.includes('status')) return result;
                const prefix = '00:00:00.000000 trace.c:1 setup: ';
                const stderr =
                  corrupt === 'missing'
                    ? ''
                    : corrupt === 'duplicate'
                      ? result.stderr + result.stderr
                      : `${prefix}git_common_dir: ${corrupt === 'wrong-common' ? path.join(clone, '.git') : identity.gitCommonDirectory}\n${prefix}worktree: ${corrupt === 'wrong-root' ? clone : canonicalFirst + (corrupt === 'control' ? '\0' : corrupt === 'bidi' ? '\u202e' : '')}\n`;
                return {...result, stderr};
              }),
            ),
        });
        expect(
          yield* resolveRepositoryIdentityForExpectationAndWorktree(caller, expected).pipe(
            Effect.provideService(CommandExecutor, recording),
            Effect.flip,
          ),
        ).toBeInstanceOf(Error);
      }
    }).pipe(provideTestLayer(expectedIdentityPlatformLayer), TestClock.withLive),
  );

  it('never classifies a porcelain-v2 change record as a clean worktree', () => {
    const head = Effect2.pipe('a', EffectString.repeat(40));
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9._/-]{1,64}$/u), repositoryPath => {
        const output = `# branch.oid ${head}\0# branch.head main\0? ${repositoryPath}\0`;
        expect(parseRepositoryIdentityWorktreeObservation(output, 'sha1')).toMatchObject({
          changed: true,
          headCommit: head,
        });
      }),
      {numRuns: 100},
    );
  });

  it('parses one bounded setup identity and rejects missing, duplicate, or unsafe fields', () => {
    const prefix = '00:00:00.000000 trace.c:1 setup: ';
    expect(
      parseRepositoryReadFenceSetupObservation(
        `${prefix}git_common_dir: /repo/.git\n${prefix}worktree: /repo with spaces\n`,
      ),
    ).toEqual({gitCommonDirectory: '/repo/.git', worktree: '/repo with spaces'});
    for (const root of ['/repo with spaces', 'C:\\work tree\\repo', '//server/share/repo']) {
      expect(
        parseRepositoryReadFenceSetupObservation(`${prefix}git_common_dir: ${root}/.git\n${prefix}worktree: ${root}\n`),
      ).toEqual({gitCommonDirectory: `${root}/.git`, worktree: root});
    }
    expect(parseRepositoryReadFenceSetupObservation(`${prefix}worktree: /repo\n`)).toBeUndefined();
    expect(
      parseRepositoryReadFenceSetupObservation(
        `${prefix}git_common_dir: /repo/.git\n${prefix}worktree: /repo\n${prefix}worktree: /other\n`,
      ),
    ).toBeUndefined();
    expect(
      parseRepositoryReadFenceSetupObservation(
        `${prefix}git_common_dir: /repo/.git\n${prefix}worktree: /repo\u0000other\n`,
      ),
    ).toBeUndefined();
  });

  it('rejects every duplicated setup identity field', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9._-]{1,32}$/u),
        fc.constantFrom('git_common_dir', 'worktree'),
        (segment, duplicate) => {
          const prefix = '00:00:00.000000 trace.c:1 setup: ';
          const gitCommonDirectory = `/repo/${segment}/.git`;
          const worktree = `/repo/${segment}`;
          const base = `${prefix}git_common_dir: ${gitCommonDirectory}\n${prefix}worktree: ${worktree}\n`;
          const repeated = duplicate === 'git_common_dir' ? gitCommonDirectory : worktree;
          expect(
            parseRepositoryReadFenceSetupObservation(`${base}${prefix}${duplicate}: ${repeated}\n`),
          ).toBeUndefined();
        },
      ),
      {numRuns: 100},
    );
  });
});

const git = Effect.fn('codeGraphExpectedIdentityTest.git')((cwd: string, args: readonly string[]) =>
  runCommandEffect('git', ['-C', cwd, ...args], {maxOutputBytes: 1_048_576, timeoutMs: 30_000}),
);

const expectedIdentityPlatformLayer = Layer.mergeAll(
  TestSystemInfoLayer,
  TestCommandExecutorLayer.pipe(Layer.provide(TestSystemInfoLayer)),
).pipe(Layer.provideMerge(BunServices.layer));

function directoryLink(target: string, link: string) {
  return Effect.sync(() => symlinkSync(target, link, 'junction'));
}
