import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect's symlink API lacks the junction type required for unprivileged Windows fixtures.
import {symlinkSync} from 'node:fs';
import {it as effectIt} from '@effect/vitest';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {parseRepositoryIdentityMetadata, resolveRepositoryIdentityDetail} from '@threadnote/graph/repository';
import {
  CommandExecutor,
  CommandOutputLimitExceeded,
  CommandSpawnFailed,
  CommandTimedOut,
  runCommandEffect,
} from '@threadnote/platform/command';

import {provideTestLayer} from '../helpers/effect-layer.js';

const utf8 = new TextEncoder();
const rootLimit = 2 * 1_048_576;
const directoryLimit = 16 * 1_024;
const branchLimit = 1_024;
const captureLimit = rootLimit + directoryLimit + branchLimit + 129;
type Commands = Parameters<typeof CommandExecutor.of>[0];
type Invocation = {readonly kind: 'text' | 'bytes'; readonly args: readonly string[]};
const platformLayer = Layer.mergeAll(
  TestSystemInfoLayer,
  TestCommandExecutorLayer.pipe(Layer.provide(TestSystemInfoLayer)),
).pipe(Layer.provideMerge(BunServices.layer));

describe('repository metadata batching', () => {
  it('round-trips complete byte frames without changing their fields or input bytes', () => {
    const segment = fc
      .array(fc.constantFrom('a', 'Z', '0', ' ', '.', '-', '_', 'é', '東', '🦉', '\\'), {
        minLength: 1,
        maxLength: 40,
      })
      .map(characters => characters.join(''));
    fc.assert(
      fc.property(
        segment,
        segment,
        fc.constantFrom('sha1' as const, 'sha256' as const),
        fc.boolean(),
        (root, admin, format, detached) => {
          const expected = {
            repoRoot: `/repository/${root}/root`,
            commonDirectory: `/metadata/${admin}/common`,
            gitDirectory: `/metadata/${admin}/linked`,
            objectFormat: format,
            headCommit: 'a'.repeat(format === 'sha1' ? 40 : 64),
            branch: detached
              ? {state: 'detached' as const}
              : {state: 'current' as const, branch: `feature/${format}-${root.replaceAll(' ', '_')}`},
          };
          const bytes = frame(expected);
          const before = bytes.slice();
          expect(parseRepositoryIdentityMetadata(bytes)).toEqual(expected);
          expect(bytes).toEqual(before);
        },
      ),
      {numRuns: 100},
    );
  });

  it('declines malformed, partial, ambiguous, and format-mismatched frames', () => {
    const base = ['/repo', '/common', '/git', 'sha1', 'a'.repeat(40), 'main'];
    const malformed = [
      '',
      base.join('\n'),
      `${base.join('\n')}\nextra\n`,
      `${base.slice(0, -1).join('\n')}\n`,
      `${base.map((value, index) => (index === 1 ? '' : value)).join('\n')}\n`,
      `${base.join('\r\n')}\r\n`,
      `${base.join('\n')}\n\0`,
      `${[' /repo', ...base.slice(1)].join('\n')}\n`,
      `${['/repo ', ...base.slice(1)].join('\n')}\n`,
      `${['/repo', '/common\0suffix', ...base.slice(2)].join('\n')}\n`,
      `${[...base.slice(0, 3), 'sha512', base[4], base[5]].join('\n')}\n`,
      `${[...base.slice(0, 4), 'A'.repeat(40), base[5]].join('\n')}\n`,
      `${[...base.slice(0, 3), 'sha256', base[4], base[5]].join('\n')}\n`,
      `${[...base.slice(0, 4), 'HEAD', base[5]].join('\n')}\n`,
      ...['', ' main', 'main ', 'a\tb', 'a\0b', 'a\nb', 'a\u007fb', 'a\u202eb', 'a'.repeat(branchLimit + 1)].map(
        branch => `${[...base.slice(0, 5), branch].join('\n')}\n`,
      ),
    ];
    for (const output of malformed) expect(parseRepositoryIdentityMetadata(utf8.encode(output))).toBeUndefined();
    const invalidUtf8 = utf8.encode(`${base.join('\n')}\n`);
    invalidUtf8[1] = 255;
    expect(parseRepositoryIdentityMetadata(invalidUtf8)).toBeUndefined();
  });

  it('preserves each legacy component byte ceiling including line separators', () => {
    const base = {
      repoRoot: '/repo',
      commonDirectory: '/common',
      gitDirectory: '/git',
      objectFormat: 'sha1' as const,
      headCommit: 'a'.repeat(40),
      branch: {state: 'current' as const, branch: 'main'},
    };
    const exactRoot = {...base, repoRoot: '/' + 'r'.repeat(rootLimit - 2)};
    expect(parseRepositoryIdentityMetadata(frame(exactRoot))).toEqual(exactRoot);
    expect(parseRepositoryIdentityMetadata(frame({...exactRoot, repoRoot: exactRoot.repoRoot + 'r'}))).toBeUndefined();
    const commonDirectory = '/' + '東'.repeat(2_000);
    const gitDirectory = '/' + 'g'.repeat(directoryLimit - utf8.encode(commonDirectory).byteLength - 3);
    const exactDirectories = {...base, commonDirectory, gitDirectory};
    expect(parseRepositoryIdentityMetadata(frame(exactDirectories))).toEqual(exactDirectories);
    expect(
      parseRepositoryIdentityMetadata(frame({...exactDirectories, gitDirectory: gitDirectory + 'g'})),
    ).toBeUndefined();
    const exactBranch = {...base, branch: {state: 'current' as const, branch: '東'.repeat(341) + 'a'}};
    expect(utf8.encode(exactBranch.branch.branch)).toHaveLength(branchLimit);
    expect(parseRepositoryIdentityMetadata(frame(exactBranch))).toEqual(exactBranch);
    expect(
      parseRepositoryIdentityMetadata(
        frame({...exactBranch, branch: {state: 'current', branch: exactBranch.branch.branch + 'a'}}),
      ),
    ).toBeUndefined();
    expect(parseRepositoryIdentityMetadata(new Uint8Array(captureLimit + 1))).toBeUndefined();
  });

  effectIt.effect('matches complete legacy discovery for live, detached, unborn, nested and linked repositories', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const command = yield* CommandExecutor;
      const temporary = yield* tempDirectory('threadnote-metadata-parity-');
      for (const format of ['sha1', 'sha256'] as const) {
        const root = path.join(temporary, `repo ${format}`);
        yield* fs.makeDirectory(root);
        yield* git(root, ['init', '-q', '--object-format=' + format, '-b', 'main']);
        const unborn = yield* compareDiscovery(root, command);
        expect(unborn.identity.branch).toBe('main');
        expect(unborn.identity.headCommit).toBe('0'.repeat(format === 'sha1' ? 40 : 64));
        yield* git(root, ['config', 'commit.gpgsign', 'false']);
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
        yield* git(root, ['remote', 'add', 'origin', 'https://github.com/example/metadata-parity.git']);
        yield* git(root, ['config', 'core.ignorecase', 'true']);
        const nested = path.join(root, 'nested directory');
        yield* fs.makeDirectory(nested);
        const calls: Invocation[] = [];
        const initial = yield* resolveRepositoryIdentityDetail(nested).pipe(
          Effect.provideService(CommandExecutor, counted(command, calls)),
        );
        expect(calls).toHaveLength(3);
        expect(calls[0].kind).toBe('bytes');
        expect(calls[0].args.slice(2)).toEqual([
          'rev-parse',
          '--path-format=absolute',
          '--show-toplevel',
          '--git-common-dir',
          '--git-dir',
          '--show-object-format',
          'HEAD',
          '--abbrev-ref=loose',
          'HEAD',
        ]);
        expect(calls.slice(1).every(call => call.args[1] === initial.identity.repoRoot)).toBe(true);
        expect(initial.identity).not.toHaveProperty('gitDirectory');
        expect(initial.identity.caseMode).toBe('insensitive');
        expect(yield* compareDiscovery(nested, command)).toEqual(initial);
        yield* git(root, ['checkout', '--detach', '-q']);
        expect((yield* compareDiscovery(nested, command)).identity.branch).toBeUndefined();
        const linked = path.join(temporary, `linked ${format}`);
        yield* git(root, ['worktree', 'add', '-q', '-b', 'linked-' + format, linked]);
        const linkedDetail = yield* compareDiscovery(linked, command);
        expect(linkedDetail.gitDirectory).not.toBe(linkedDetail.identity.gitCommonDirectory);
        expect(linkedDetail.identity.checkoutId).toBe(initial.identity.checkoutId);
        expect(linkedDetail.identity.worktreeId).not.toBe(initial.identity.worktreeId);
      }
    }).pipe(provideTestLayer(platformLayer), TestClock.withLive),
  );

  effectIt.effect('keeps successful metadata bound to its canonical root when the caller retargets', () =>
    Effect.gen(function* () {
      const {first, second, caller, command} = yield* routedRepositories();
      const fs = yield* FileSystem.FileSystem;
      const initial = yield* resolveRepositoryIdentityDetail(first);
      const calls: Invocation[] = [];
      const delegate = counted(command, calls);
      const routed = CommandExecutor.of({
        ...delegate,
        executeBytes: (executable, args, options) =>
          delegate.executeBytes!(executable, args, options).pipe(
            Effect.tap(() =>
              isBatch(args)
                ? fs.remove(caller).pipe(Effect.orDie, Effect.andThen(directoryLink(second, caller)))
                : Effect.void,
            ),
          ),
      });
      const observed = yield* resolveRepositoryIdentityDetail(caller).pipe(
        Effect.provideService(CommandExecutor, routed),
      );
      expect(observed).toEqual(initial);
      expect(calls).toHaveLength(3);
      expect(calls.slice(1).every(call => call.args[1] === initial.identity.repoRoot)).toBe(true);
    }).pipe(provideTestLayer(platformLayer), TestClock.withLive),
  );

  effectIt.effect('discards every partial field before fresh discovery at a retargeted caller', () =>
    Effect.gen(function* () {
      const {first, second, caller, command} = yield* routedRepositories();
      const fs = yield* FileSystem.FileSystem;
      const expected = yield* resolveRepositoryIdentityDetail(second);
      const initial = yield* resolveRepositoryIdentityDetail(first);
      const calls: Invocation[] = [];
      const delegate = counted(command, calls);
      const routed = CommandExecutor.of({
        ...delegate,
        executeBytes: (executable, args, options) =>
          delegate.executeBytes!(executable, args, options).pipe(
            Effect.filterOrElse(
              () => !isBatch(args),
              result =>
                fs.remove(caller).pipe(
                  Effect.orDie,
                  Effect.andThen(directoryLink(second, caller)),
                  Effect.as({
                    ...result,
                    stdout: utf8.encode(`${initial.identity.repoRoot}\n${initial.identity.gitCommonDirectory}\n`),
                  }),
                ),
            ),
          ),
      });
      const observed = yield* resolveRepositoryIdentityDetail(caller).pipe(
        Effect.provideService(CommandExecutor, routed),
      );
      expect(observed).toEqual(expected);
      expect(calls).toHaveLength(8);
      expect(calls[1]).toEqual({kind: 'text', args: ['-C', caller, 'rev-parse', '--show-toplevel']});
      expect(calls.slice(2).every(call => call.args[1] === expected.identity.repoRoot)).toBe(true);
    }).pipe(provideTestLayer(platformLayer), TestClock.withLive),
  );

  effectIt.effect('does not retry infrastructure failures or exceed a configured capture bound', () =>
    Effect.gen(function* () {
      const command = yield* CommandExecutor;
      const base = {args: [], executable: 'git', message: 'fixture command error'};
      for (const failure of [
        CommandTimedOut.make({...base, timeoutMs: 30_000}),
        CommandOutputLimitExceeded.make({...base, maxOutputBytes: captureLimit}),
        CommandSpawnFailed.make({...base, cause: new Error('fixture spawn error')}),
      ]) {
        let calls = 0;
        const failing = CommandExecutor.of({
          ...command,
          execute: () =>
            Effect.sync(() => {
              calls += 1;
            }).pipe(Effect.andThen(Effect.fail(failure))),
          executeBytes: (_executable, _args, options) =>
            Effect.sync(() => {
              calls += 1;
              expect(options?.maxOutputBytes).toBe(captureLimit);
              expect(options?.timeoutMs).toBe(30_000);
            }).pipe(Effect.andThen(Effect.fail(failure))),
        });
        expect(
          yield* resolveRepositoryIdentityDetail('/unused').pipe(
            Effect.provideService(CommandExecutor, failing),
            Effect.flip,
          ),
        ).toMatchObject({
          _tag: 'CodeGraphRepositoryError',
          message: `Not a Git repository: ${failure.message}`,
        });
        expect(calls).toBe(1);
      }
    }).pipe(provideTestLayer(platformLayer), TestClock.withLive),
  );
});

function frame(value: {
  readonly repoRoot: string;
  readonly commonDirectory: string;
  readonly gitDirectory: string;
  readonly objectFormat: string;
  readonly headCommit: string;
  readonly branch: {readonly state: 'current'; readonly branch: string} | {readonly state: 'detached'};
}) {
  return utf8.encode(
    [
      value.repoRoot,
      value.commonDirectory,
      value.gitDirectory,
      value.objectFormat,
      value.headCommit,
      value.branch.state === 'detached' ? 'HEAD' : value.branch.branch,
    ].join('\n') + '\n',
  );
}

function isBatch(args: readonly string[]) {
  return args.includes('--show-toplevel') && args.includes('--git-dir');
}

function counted(command: Commands, calls: Invocation[]): Commands {
  return CommandExecutor.of({
    ...command,
    execute: (executable, args, options) =>
      Effect.sync(() => {
        calls.push({kind: 'text', args});
      }).pipe(Effect.andThen(command.execute(executable, args, options))),
    executeBytes: (executable, args, options) =>
      Effect.sync(() => {
        calls.push({kind: 'bytes', args});
      }).pipe(Effect.andThen(command.executeBytes!(executable, args, options))),
  });
}

const compareDiscovery = Effect.fn('repositoryMetadataBatchTest.compareDiscovery')(function* (
  cwd: string,
  command: Commands,
) {
  const actual = yield* resolveRepositoryIdentityDetail(cwd);
  const legacy = CommandExecutor.of({
    ...command,
    executeBytes: (executable, args, options) =>
      isBatch(args)
        ? Effect.succeed({exitCode: 128, stdout: new Uint8Array(), stderr: 'force complete legacy discovery'})
        : command.executeBytes!(executable, args, options),
  });
  expect(yield* resolveRepositoryIdentityDetail(cwd).pipe(Effect.provideService(CommandExecutor, legacy))).toEqual(
    actual,
  );
  return actual;
});

const routedRepositories = Effect.fn('repositoryMetadataBatchTest.routedRepositories')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const command = yield* CommandExecutor;
  const temporary = yield* tempDirectory('threadnote-metadata-routing-');
  const first = path.join(temporary, 'first');
  const second = path.join(temporary, 'second');
  const caller = path.join(temporary, 'caller');
  yield* fs.makeDirectory(first);
  yield* git(first, ['init', '-q', '-b', 'main']);
  yield* git(first, [
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Threadnote Test',
    '-c',
    'user.email=test@threadnote.local',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  yield* git(temporary, ['clone', '-q', first, second]);
  yield* git(first, ['remote', 'add', 'origin', 'https://github.com/example/first.git']);
  yield* git(second, ['remote', 'set-url', 'origin', 'https://github.com/example/second.git']);
  yield* git(first, ['config', 'core.ignorecase', 'true']);
  yield* git(second, ['config', 'core.ignorecase', 'false']);
  yield* directoryLink(first, caller);
  return {first, second, caller, command};
});

const tempDirectory = Effect.fn('repositoryMetadataBatchTest.tempDirectory')(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.acquireRelease(fs.makeTempDirectory({prefix}), directory =>
    fs.remove(directory, {recursive: true, force: true}).pipe(Effect.orDie),
  );
});

const git = Effect.fn('repositoryMetadataBatchTest.git')((cwd: string, args: readonly string[]) =>
  runCommandEffect('git', ['-C', cwd, ...args], {maxOutputBytes: 1_048_576, timeoutMs: 30_000}),
);

function directoryLink(target: string, link: string) {
  return Effect.sync(() => symlinkSync(target, link, 'junction'));
}
