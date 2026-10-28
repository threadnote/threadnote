import {it as effectIt} from '@effect/vitest';
import {Arbitrary, Effect, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CommandExecutor, CommandTimedOut, runCommandEffect} from '@threadnote/platform/command';
import {captureNativeCycleSource} from '../../src/workflow_automation/cycle_git.js';
import {verifyNativeCloseoutSource} from '../../src/workflow_automation/closeout.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const run = <A, E, R>(program: Effect.Effect<A, E, R>) => program.pipe(TestClock.withLive, provideNative);
const git = (repo: string, ...args: string[]) =>
  runCommandEffect('git', ['--no-optional-locks', '-C', repo, ...args]).pipe(Effect.map(result => result.stdout));
const fixtureGitIdentity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];
const commit = (repo: string, ...args: string[]) =>
  git(repo, ...fixtureGitIdentity, 'commit', '-m', 'Fixture', ...args);
const initialObjects = (args: readonly string[]) => args.includes('HEAD^{commit}') && !args.includes('--verify');
const refused = <A, E>(result: Result.Result<A, E>, code: string) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure).toMatchObject({code});
};

describe('native Git observations', () => {
  effectIt.effect('captures both Git object formats with one initial frame and an independent closing HEAD', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const commands = yield* CommandExecutor;
      const binary = commands.executeBytes;
      if (!binary) throw new Error('Expected binary command support.');
      for (const format of ['sha1', 'sha256']) {
        const ordinary = f.path.join(f.root, format + ' ordinary space');
        const linked = f.path.join(f.root, format + ' linked space');
        yield* f.fs.makeDirectory(ordinary);
        yield* git(ordinary, 'init', '--initial-branch=main', `--object-format=${format}`);
        yield* f.fs.writeFileString(f.path.join(ordinary, 'source.ts'), 'source\n');
        yield* git(ordinary, 'add', '.');
        yield* commit(ordinary);
        yield* git(ordinary, 'checkout', '--detach');
        yield* git(ordinary, 'worktree', 'add', '--detach', linked, 'HEAD');
        for (const repo of [ordinary, linked]) {
          const root = yield* f.fs.realPath(repo);
          const head = (yield* git(repo, 'rev-parse', 'HEAD')).trim();
          const tree = (yield* git(repo, 'rev-parse', 'HEAD^{tree}')).trim();
          const index = (yield* git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).trim();
          const before = yield* f.fs.readFile(index);
          expect(yield* captureNativeCycleSource(repo, 'HEAD')).toMatchObject({head, tree, baseTree: tree, files: {}});
          const observed: (readonly string[])[] = [];
          const snapshot = yield* captureNativeCycleSource(repo, 'HEAD').pipe(
            Effect.provideService(CommandExecutor, {
              ...commands,
              executeBytes: (executable, args, options) => {
                observed.push(args);
                return binary(executable, args, options).pipe(
                  Effect.map(result =>
                    initialObjects(args)
                      ? {
                          ...result,
                          // Alter only the framing EOLs; never normalize bytes inside a root path.
                          stdout: new TextEncoder().encode(`${root}\r\n${head}\r\n${tree}\r\n`),
                        }
                      : result,
                  ),
                );
              },
            }),
          );
          expect(snapshot).toMatchObject({head, tree, baseTree: tree, files: {}});
          expect(head).toHaveLength(format === 'sha1' ? 40 : 64);
          expect(observed.filter(initialObjects)).toHaveLength(1);
          expect(observed.filter(args => args.includes('rev-parse'))).toHaveLength(3);
          expect(observed[0]).toContain('--show-toplevel');
          expect(observed.findIndex(args => args.includes('--git-path'))).toBeGreaterThan(
            observed.findIndex(args => args.includes('status')),
          );
          expect(observed.filter(args => args.includes('add'))).toHaveLength(2);
          expect(observed.some(args => args.includes('--renormalize'))).toBe(true);
          expect(observed.at(-1)).toContain('HEAD^{commit}');
          expect(observed.at(-1)).toContain('--verify');
          expect(yield* f.fs.readFile(index)).toEqual(before);
          yield* verifyNativeCloseoutSource(repo, head);
        }
      }
    }).pipe(run),
  );

  effectIt.effect('retains internal LF, CRLF and object-looking root lines in real ordinary and linked captures', () =>
    Effect.gen(function* () {
      // Win32 filenames cannot contain CR/LF; the same ordinary/linked matrix above runs there.
      if (process.platform === 'win32') return;
      const f = yield* nativeFixture();
      for (const format of ['sha1', 'sha256']) {
        const width = format === 'sha1' ? 40 : 64;
        const ordinary = f.path.join(f.root, `${format} ordinary\n${'a'.repeat(width)}\r\nspace end`);
        const linked = f.path.join(f.root, `${format} linked\r\n${'b'.repeat(width)}\nspace end`);
        yield* f.fs.makeDirectory(ordinary);
        yield* git(ordinary, 'init', '--initial-branch=main', `--object-format=${format}`);
        yield* f.fs.writeFileString(f.path.join(ordinary, 'source.ts'), 'source\n');
        yield* git(ordinary, 'add', '.');
        yield* commit(ordinary);
        yield* git(ordinary, 'worktree', 'add', '--detach', linked, 'HEAD');
        for (const repo of [ordinary, linked]) {
          const root = yield* f.fs.realPath(repo);
          const head = (yield* git(repo, 'rev-parse', 'HEAD')).trim();
          const tree = (yield* git(repo, 'rev-parse', 'HEAD^{tree}')).trim();
          const snapshot = yield* captureNativeCycleSource(repo, 'HEAD');
          expect(snapshot).toMatchObject({repo: root, head, tree, baseTree: tree, files: {}});
        }
      }
    }).pipe(run),
  );

  effectIt.effect('rejects partial or malformed initial objects before touching the private index', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* git(f.repo, 'add', '.');
      yield* commit(f.repo);
      const commands = yield* CommandExecutor;
      const binary = commands.executeBytes;
      if (!binary) throw new Error('Expected binary command support.');
      const hash = 'a'.repeat(40);
      const index = f.path.join(f.repo, '.git', 'index');
      const before = yield* f.fs.readFile(index);
      for (const stdout of [
        '',
        `${f.repo}\n${hash}\n`,
        `${f.repo}\n${hash}\n${hash}`,
        `${f.repo}\n${hash}\n${hash}\nextra\n`,
        `${f.repo}\n${hash.toUpperCase()}\n${hash}\n`,
        `${f.repo}\n${hash}\n${'a'.repeat(64)}\n`,
        `${f.repo}\n ${hash}\n${hash}\n`,
        `${f.repo}\n${hash}\r\r\n${hash}\n`,
        `${f.repo}\n${hash}\nHEAD^{tree}\n`,
        `${f.repo}\n${hash}\n${hash}\n\n`,
        `\n${hash}\n${hash}\n`,
        new Uint8Array([0xff]),
      ]) {
        let indexWrites = 0;
        const result = yield* captureNativeCycleSource(f.repo, 'HEAD').pipe(
          Effect.provideService(CommandExecutor, {
            ...commands,
            executeBytes: (executable, args, options) => {
              if (args.includes('add')) indexWrites++;
              return initialObjects(args)
                ? Effect.succeed({
                    exitCode: 0,
                    stderr: '',
                    stdout: typeof stdout === 'string' ? new TextEncoder().encode(stdout) : stdout,
                  })
                : binary(executable, args, options);
            },
          }),
          Effect.result,
        );
        refused(result, 'invalid-snapshot');
        expect(indexWrites).toBe(0);
        expect(yield* f.fs.readFile(index)).toEqual(before);
      }
    }).pipe(run),
  );

  effectIt.effect('requires complete equal-format lowercase object tails without trimming their fields', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const root = yield* f.fs.realPath(f.repo);
      const commands = yield* CommandExecutor;
      const result = yield* Arbitrary.checkEffect(
        Arbitrary.schema(
          Schema.Struct({
            headWidth: Schema.Literals([40, 64]),
            treeWidth: Schema.Literals([40, 64]),
            uppercase: Schema.Boolean,
            separator: Schema.Literals(['\n', '\r\n']),
            ending: Schema.Literals(['\n', '\r\n', '', '\n\n']),
          }),
        ),
        ({headWidth, treeWidth, uppercase, separator, ending}) =>
          Effect.gen(function* () {
            const observed: (readonly string[])[] = [];
            const head = (uppercase ? 'A' : 'a').repeat(headWidth);
            const result = yield* captureNativeCycleSource(f.repo, 'HEAD').pipe(
              Effect.provideService(CommandExecutor, {
                ...commands,
                executeBytes: (_executable, args) => {
                  observed.push(args);
                  return Effect.succeed({
                    exitCode: 0,
                    stderr: '',
                    stdout: new TextEncoder().encode(
                      initialObjects(args)
                        ? `${root}${separator}${head}${separator}${'b'.repeat(treeWidth)}${ending}`
                        : 'u conflict\0',
                    ),
                  });
                },
              }),
              Effect.result,
            );
            const valid = !uppercase && headWidth === treeWidth && (ending === '\n' || ending === '\r\n');
            refused(result, valid ? 'unmerged-index' : 'invalid-snapshot');
            expect(observed.some(args => args.includes('status'))).toBe(valid);
            expect(observed.some(args => args.includes('add') || args.includes('--git-path'))).toBe(false);
            return true;
          }),
        {runs: 24},
      );
      expect(result).toMatchObject({_tag: 'Passed', runs: 24});
    }).pipe(run),
  );

  effectIt.effect('checks root authority and documents early base refusal before index or status work', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* git(f.repo, 'add', '.');
      yield* commit(f.repo);
      const other = f.path.join(f.root, 'other directory');
      yield* f.fs.makeDirectory(other);
      const root = yield* f.fs.realPath(f.repo);
      const hash = 'a'.repeat(40);
      const commands = yield* CommandExecutor;
      const binary = commands.executeBytes;
      if (!binary) throw new Error('Expected binary command support.');
      const before = yield* f.fs.readFile(f.path.join(f.repo, '.git', 'index'));
      for (const sample of [
        {base: 'HEAD', prefix: other, code: 'binding-drift', status: false},
        // The extra OID is a path prefix, not an excuse to accept a three-line projection.
        {base: 'HEAD', prefix: `${root}\n${hash}`, code: undefined, status: false},
        {base: 'HEAD', prefix: ` \t${root} \t`, code: 'unmerged-index', status: true},
        {base: 'HEAD\nHEAD', prefix: other, code: 'invalid-snapshot', status: false},
      ]) {
        const observed: (readonly string[])[] = [];
        const result = yield* captureNativeCycleSource(f.repo, sample.base).pipe(
          Effect.provideService(CommandExecutor, {
            ...commands,
            executeBytes: (executable, args, options) => {
              observed.push(args);
              if (initialObjects(args))
                return Effect.succeed({
                  exitCode: 0,
                  stderr: '',
                  stdout: new TextEncoder().encode(`${sample.prefix}\r\n${hash}\r\n${hash}\r\n`),
                });
              if (args.includes('status'))
                return Effect.succeed({exitCode: 0, stderr: '', stdout: new TextEncoder().encode('u conflict\0')});
              return binary(executable, args, options);
            },
          }),
          Effect.result,
        );
        if (sample.code) refused(result, sample.code);
        else expect(Result.isFailure(result)).toBe(true);
        expect(observed.some(args => args.includes('status'))).toBe(sample.status);
        expect(observed.some(args => args.includes('add') || args.includes('--git-path'))).toBe(false);
        if (sample.base !== 'HEAD') expect(observed).toHaveLength(0);
        expect(yield* f.fs.readFile(f.path.join(f.repo, '.git', 'index'))).toEqual(before);
      }
    }).pipe(run),
  );

  effectIt.effect(
    'rejects unborn, missing and injected revisions and retains external HEAD and index drift checks',
    () =>
      Effect.gen(function* () {
        const f = yield* nativeFixture();
        expect(Result.isFailure(yield* captureNativeCycleSource(f.repo, 'HEAD').pipe(Effect.result))).toBe(true);
        refused(yield* verifyNativeCloseoutSource(f.repo, 'a'.repeat(40)).pipe(Effect.result), 'closeout-source-drift');
        yield* git(f.repo, 'add', '.');
        yield* commit(f.repo);
        for (const base of ['HEAD\nHEAD', '', ' '.repeat(2), 'a'.repeat(513)])
          refused(yield* captureNativeCycleSource(f.repo, base).pipe(Effect.result), 'invalid-snapshot');
        for (const base of ['missing-ref', '--show-toplevel'])
          expect(Result.isFailure(yield* captureNativeCycleSource(f.repo, base).pipe(Effect.result))).toBe(true);
        const commands = yield* CommandExecutor;
        const binary = commands.executeBytes;
        if (!binary) throw new Error('Expected binary command support.');
        for (const mutation of [
          commit(f.repo, '--allow-empty'),
          git(f.repo, 'update-index', '--assume-unchanged', 'source.ts'),
        ]) {
          let moved = false;
          const result = yield* captureNativeCycleSource(f.repo, 'HEAD').pipe(
            Effect.provideService(CommandExecutor, {
              ...commands,
              executeBytes: (executable, args, options) =>
                binary(executable, args, options).pipe(
                  Effect.tap(() => {
                    if (!args.includes('diff') || moved) return Effect.void;
                    moved = true;
                    return mutation.pipe(Effect.provideService(CommandExecutor, commands));
                  }),
                ),
            }),
            Effect.result,
          );
          expect(moved).toBe(true);
          refused(result, 'source-drift');
        }
      }).pipe(run),
  );

  effectIt.effect('reobserves real clean, dirty, detached and moved HEAD states without sharing freshness', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* git(f.repo, 'add', '.');
      yield* commit(f.repo);
      yield* git(f.repo, 'branch', 'upstream');
      yield* git(f.repo, 'branch', '--set-upstream-to=upstream', 'main');
      yield* commit(f.repo, '--allow-empty', '-m', 'main divergence');
      yield* git(f.repo, 'checkout', 'upstream');
      yield* commit(f.repo, '--allow-empty', '-m', 'upstream divergence');
      yield* git(f.repo, 'checkout', 'main');
      expect((yield* git(f.repo, 'rev-list', '--left-right', '--count', 'HEAD...upstream')).trim()).toBe('1\t1');
      const head = (yield* git(f.repo, 'rev-parse', 'HEAD')).trim();
      const commands = yield* CommandExecutor;
      const observed: (readonly string[])[] = [];
      const frames: string[] = [];
      const verify = verifyNativeCloseoutSource(f.repo, head).pipe(
        Effect.provideService(CommandExecutor, {
          ...commands,
          execute: (executable, args, options) => {
            observed.push(args);
            return commands
              .execute(executable, args, options)
              .pipe(Effect.tap(result => Effect.sync(() => frames.push(result.stdout))));
          },
        }),
      );
      yield* verify;
      expect(frames[0]).toContain(`# branch.oid ${head}\0`);
      expect(frames[0]).toContain('# branch.upstream upstream\0');
      expect(frames[0]).toContain('# branch.ab +? -?\0');
      yield* f.fs.writeFileString(f.path.join(f.repo, 'untracked'), 'untracked\n');
      refused(yield* verify.pipe(Effect.result), 'closeout-source-drift');
      yield* f.fs.remove(f.path.join(f.repo, 'untracked'));
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'changed\n');
      refused(yield* verify.pipe(Effect.result), 'closeout-source-drift');
      yield* git(f.repo, 'checkout', '--', 'source.ts');
      yield* git(f.repo, 'checkout', '--detach');
      yield* verify;
      yield* commit(f.repo, '--allow-empty');
      refused(yield* verify.pipe(Effect.result), 'closeout-source-drift');
      expect(observed).toHaveLength(5);
      expect(
        observed.every(
          args => args.includes('status') && args.includes('--branch') && args.includes('--no-ahead-behind'),
        ),
      ).toBe(true);
    }).pipe(run),
  );

  effectIt.effect('accepts only complete clean status frames and fails closed on unknown or duplicate metadata', () =>
    Effect.gen(function* () {
      const commands = yield* CommandExecutor;
      for (const length of [40, 64]) {
        const hash = 'a'.repeat(length);
        const clean = `# branch.oid ${hash}\0# branch.head main\0`;
        const verify = (stdout: string) =>
          verifyNativeCloseoutSource('/unused', hash).pipe(
            Effect.provideService(CommandExecutor, {
              ...commands,
              execute: () => Effect.succeed({exitCode: 0, stderr: '', stdout}),
            }),
            Effect.result,
          );
        for (const stdout of [
          clean,
          clean.replace('main', '(detached)'),
          `${clean}# branch.upstream origin/main\0# branch.ab +1 -0\0`,
          `${clean}# branch.upstream origin/main\0# branch.ab +? -?\0`,
        ])
          expect(Result.isSuccess(yield* verify(stdout))).toBe(true);
        for (const stdout of [
          '',
          clean.slice(0, -1),
          clean.replace(hash, '(initial)'),
          clean.replace(hash, hash.slice(1)),
          clean.replace(hash, hash.toUpperCase()),
          clean.replace(hash, `${hash}\r\n`),
          `# branch.oid ${hash}\0`,
          `${clean}# branch.oid ${hash}\0`,
          `${clean}# branch.head other\0`,
          `${clean}# branch.future unknown\0`,
          clean.replace('main', 'main\tinvalid'),
          `${clean}# branch.ab invalid\0`,
          `${clean}# branch.ab +? -1\0`,
          `${clean}# branch.ab +1 -?\0`,
          `${clean}# branch.ab +?? -?\0`,
          `${clean}# branch.ab +? -?\0# branch.ab +? -?\0`,
          `${clean}\0`,
          `${clean}? untracked\0`,
          `${clean}1 .M N... changed\0`,
          `${clean}2 R. N... renamed\0# branch.oid ${hash}\0`,
        ])
          refused(yield* verify(stdout), 'closeout-source-drift');
      }
    }).pipe(run),
  );

  effectIt.effect('propagates command timeouts from both observations without retry or partial authority', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const commands = yield* CommandExecutor;
      const binary = commands.executeBytes;
      if (!binary) throw new Error('Expected binary command support.');
      const timeout = CommandTimedOut.make({
        executable: 'git',
        args: [],
        timeoutMs: 30_000,
        message: 'fixture timeout',
      });
      const result = yield* captureNativeCycleSource(f.repo, 'HEAD').pipe(
        Effect.provideService(CommandExecutor, {
          ...commands,
          executeBytes: (executable, args, options) =>
            initialObjects(args) ? Effect.fail(timeout) : binary(executable, args, options),
        }),
        Effect.result,
      );
      expect(Result.isFailure(result) && result.failure).toBe(timeout);
      const closed = yield* verifyNativeCloseoutSource(f.repo, 'a'.repeat(40)).pipe(
        Effect.provideService(CommandExecutor, {...commands, execute: () => Effect.fail(timeout)}),
        Effect.result,
      );
      expect(Result.isFailure(closed) && closed.failure).toBe(timeout);
    }).pipe(run),
  );

  effectIt.effect('rejects a real unmerged index from status before any private-index write', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* git(f.repo, 'add', '.');
      yield* commit(f.repo);
      yield* git(f.repo, 'branch', 'conflict-side');
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'main content\n');
      yield* git(f.repo, 'add', '.');
      yield* commit(f.repo);
      yield* git(f.repo, 'checkout', 'conflict-side');
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'side content\n');
      yield* git(f.repo, 'add', '.');
      yield* commit(f.repo);
      const merge = yield* runCommandEffect('git', ['-C', f.repo, ...fixtureGitIdentity, 'merge', 'main'], {
        allowFailure: true,
      });
      expect(merge.exitCode).toBe(1);
      expect(yield* git(f.repo, 'status', '--porcelain=v2', '-z')).toMatch(/^u /u);
      const index = f.path.join(f.repo, '.git', 'index');
      const before = yield* f.fs.readFile(index);
      const source = yield* f.fs.readFileString(f.path.join(f.repo, 'source.ts'));
      const commands = yield* CommandExecutor;
      const binary = commands.executeBytes;
      if (!binary) throw new Error('Expected binary command support.');
      const observed: (readonly string[])[] = [];
      const result = yield* captureNativeCycleSource(f.repo, 'HEAD').pipe(
        Effect.provideService(CommandExecutor, {
          ...commands,
          executeBytes: (executable, args, options) => {
            observed.push(args);
            return binary(executable, args, options);
          },
        }),
        Effect.result,
      );
      refused(result, 'unmerged-index');
      expect(observed.filter(args => args.includes('status'))).toHaveLength(1);
      expect(
        observed.some(args => args.includes('ls-files') || args.includes('add') || args.includes('--git-path')),
      ).toBe(false);
      expect(yield* f.fs.readFile(index)).toEqual(before);
      expect(yield* f.fs.readFileString(f.path.join(f.repo, 'source.ts'))).toBe(source);
    }).pipe(run),
  );

  effectIt.effect('does not mistake a rename original path beginning with u for an unmerged status record', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const original = 'u conflict-looking name';
      yield* f.fs.writeFileString(f.path.join(f.repo, original), 'rename content\n');
      yield* git(f.repo, 'add', '.');
      yield* commit(f.repo);
      yield* git(f.repo, 'mv', original, 'renamed.txt');
      const status = yield* git(f.repo, 'status', '--porcelain=v2', '-z');
      expect(status).toContain(`renamed.txt\0${original}\0`);
      const index = f.path.join(f.repo, '.git', 'index');
      const before = yield* f.fs.readFile(index);
      const snapshot = yield* captureNativeCycleSource(f.repo, 'HEAD');
      expect(snapshot.files).toHaveProperty(original);
      expect(snapshot.files).toHaveProperty('renamed.txt');
      expect(yield* f.fs.readFile(index)).toEqual(before);
    }).pipe(run),
  );
});
