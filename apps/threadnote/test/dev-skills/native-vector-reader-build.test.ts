import {describe, expect} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Context, Effect, FileSystem, Layer, Path, Result, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import * as BunServices from '@effect/platform-bun/BunServices';
import {CommandExecutor, type CommandOptions} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {NATIVE_VECTOR_READER_FILES} from '@threadnote/recall/vector/native-reader-payload';
import {nativeReaderBuildInputs, nativeReaderGit} from '../../../../scripts/native-vector-reader-payload.js';
import {buildNativeVectorReaderCargo} from '../../../../scripts/assemble-native-vector-reader.js';
import {ScriptCommandExecutorLayer} from '../../../../scripts/effect/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';

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

describe('native vector Cargo command cleanup', () => {
  const commandFixture = Effect.fn(function* (platform: 'win32' | 'linux', leaderRunning?: boolean) {
    const native = yield* SystemInfo;
    let groupProbes = 0;
    const system = SystemInfo.of({
      ...native,
      platform,
      isProcessRunning: leaderRunning === undefined ? native.isProcessRunning : () => leaderRunning,
      isProcessGroupRunning: () => {
        groupProbes += 1;
        return platform === 'win32' ? undefined : false;
      },
    });
    const context = yield* Layer.build(
      ScriptCommandExecutorLayer.pipe(Layer.provide(Layer.succeed(SystemInfo, system))),
    );
    return {system, command: Context.get(context, CommandExecutor), groupProbes: () => groupProbes};
  });
  const invokeCargo = (f: Effect.Success<ReturnType<typeof commandFixture>>, program: string) => {
    const command = CommandExecutor.of({
      ...f.command,
      execute: (executable, args, options: CommandOptions = {}) => {
        expect(executable).toBe('cargo');
        expect(args).toEqual([
          'build',
          '--locked',
          '--release',
          '--target',
          'fixture-target',
          '--target-dir',
          'fixture-output',
        ]);
        expect(options.timeoutMs).toBe(20 * 60_000);
        expect(options.maxOutputBytes).toBe(4 * 1024 * 1024);
        expect(options.detached).toBe(true);
        return f.command.execute(process.execPath, ['-e', program], {...options, cwd: process.cwd()});
      },
    });
    return buildNativeVectorReaderCargo({
      cargo: 'cargo',
      crateRoot: process.cwd(),
      target: 'fixture-target',
      targetDirectory: 'fixture-output',
      env: {},
    }).pipe(Effect.provideService(SystemInfo, f.system), Effect.provideService(CommandExecutor, command));
  };

  effectIt.layer(Layer.merge(BunServices.layer, TestSystemInfoLayer))(it => {
    it.effect('reproduces successful-child masking when Windows cannot observe a POSIX group', () =>
      Effect.gen(function* () {
        const f = yield* commandFixture('win32');
        const result = yield* f.command
          .execute(process.execPath, ['-e', 'process.stdout.write("compiled")'], {
            timeoutMs: 5_000,
            detached: true,
            verifyOwnedProcessExit: 'group',
          })
          .pipe(Effect.result);
        expect(Result.isFailure(result) && result.failure._tag).toBe('CommandCleanupUnconfirmed');
        expect(f.groupProbes()).toBe(1);
      }).pipe(TestClock.withLive),
    );
    it.effect('confirms Windows leader exit while retaining POSIX group verification and Cargo bounds', () =>
      Effect.gen(function* () {
        for (const platform of ['win32', 'linux'] as const) {
          const f = yield* commandFixture(platform);
          const result = yield* invokeCargo(f, 'process.stdout.write("compiled")');
          expect(result).toEqual({exitCode: 0, stdout: 'compiled', stderr: ''});
          expect(f.groupProbes()).toBe(platform === 'win32' ? 0 : 1);
        }
      }).pipe(TestClock.withLive),
    );
    it.effect('preserves original Windows child errors and rejects unconfirmed leader exit', () =>
      Effect.gen(function* () {
        const f = yield* commandFixture('win32');
        const failed = yield* invokeCargo(f, 'process.stderr.write("compiler failed"); process.exit(7)').pipe(
          Effect.result,
        );
        expect(Result.isFailure(failed) && failed.failure._tag).toBe('CommandFailed');
        if (Result.isFailure(failed) && failed.failure._tag === 'CommandFailed') {
          expect(failed.failure.exitCode).toBe(7);
          expect(failed.failure.stderr).toBe('compiler failed');
        }
        const unconfirmed = yield* commandFixture('win32', true);
        const result = yield* invokeCargo(unconfirmed, 'process.stdout.write("compiled")').pipe(Effect.result);
        expect(Result.isFailure(result) && result.failure._tag).toBe('CommandCleanupUnconfirmed');
      }).pipe(TestClock.withLive),
    );
  });
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
        yield* Effect.promise(() =>
          expect(nativeReaderBuildInputs(f.root, 'bun-darwin-arm64', false)).rejects.toThrow(
            'packages/recall/native-vector-reader/src/lib.rs',
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
