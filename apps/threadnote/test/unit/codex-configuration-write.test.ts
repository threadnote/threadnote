import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Deferred, Effect, Fiber, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {isFileLockTimeout} from '@threadnote/platform/file/lock';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {fromPromise} from '@threadnote/platform/errors';
import {runtimeLstat, SystemInfo} from '@threadnote/platform/system';
import {
  publishStagedCodexConfiguration,
  stageCodexConfiguration,
  withCodexConfigurationLock,
} from '../../src/mcp/codex_configuration_write.js';
import {TestCommandExecutorLayer, TestSystemInfoLayer} from '../helpers/system-layer.js';

const layer = Layer.merge(TestCommandExecutorLayer.pipe(Layer.provideMerge(TestSystemInfoLayer)), cryptoLayer).pipe(
  Layer.provideMerge(BunServices.layer),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({
    prefix: 'codex-config-write-',
  });
  return {fs, home, target: path.join(home, 'config.toml')};
});

effectIt.layer(layer)(it => {
  it.effect('serializes organization and local MCP configuration writers', () =>
    Effect.gen(function* () {
      const {fs, home, target} = yield* fixture;
      const locked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const organization = yield* withCodexConfigurationLock(
        home,
        Deferred.succeed(locked, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(fs.writeFileString(target, 'organization')),
        ),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(locked);
      const blocked = yield* withCodexConfigurationLock(home, fs.readFileString(target)).pipe(Effect.result);
      expect(Result.isFailure(blocked) && isFileLockTimeout(blocked.failure)).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(organization);
      expect(yield* withCodexConfigurationLock(home, fs.readFileString(target))).toBe('organization');
    }).pipe(TestClock.withLive),
  );

  it.effect('preserves an independently created or visibly changed configuration at publication', () =>
    Effect.gen(function* () {
      const {fs, home, target} = yield* fixture;
      const staged = yield* stageCodexConfiguration(home, target, undefined, 'local MCP update');
      yield* fs.writeFileString(target, 'external writer');
      expect(
        Result.isFailure(
          yield* publishStagedCodexConfiguration(target, staged, false, Effect.succeed(true)).pipe(Effect.result),
        ),
      ).toBe(true);
      const unchanged = fs.readFileString(target).pipe(Effect.map(text => text === 'original'));
      expect(yield* publishStagedCodexConfiguration(target, staged, true, unchanged)).toBe(false);
      expect(yield* fs.readFileString(target)).toBe('external writer');
    }),
  );

  it.effect('keeps file ownership, permissions and macOS ACLs when replacing a regular config', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      if (system.platform !== 'darwin' && system.platform !== 'linux') return;
      const {fs, home, target} = yield* fixture;
      yield* fs.writeFileString(target, 'original', {mode: 0o640});
      yield* fs.chmod(target, 0o640);
      if (system.platform === 'darwin') {
        expect((yield* runCommandEffect('/bin/chmod', ['+a', 'everyone allow read', target])).exitCode).toBe(0);
      }
      const before = yield* fromPromise('test.statOriginalCodexConfig', () => runtimeLstat(target));
      const staging = yield* stageCodexConfiguration(home, target, before, 'local MCP update');
      expect(yield* publishStagedCodexConfiguration(target, staging, true, Effect.succeed(true))).toBe(true);
      expect(yield* fs.readFileString(target)).toBe('local MCP update');
      const after = yield* fromPromise('test.statPublishedCodexConfig', () => runtimeLstat(target));
      expect(after).toMatchObject({mode: before.mode});
      expect(after).toHaveProperty('uid', 'uid' in before ? before.uid : undefined);
      expect(after).toHaveProperty('gid', 'gid' in before ? before.gid : undefined);
      if (system.platform === 'darwin') {
        expect((yield* runCommandEffect('/bin/ls', ['-le', target])).stdout).toContain('group:everyone allow read');
      }
    }).pipe(TestClock.withLive),
  );
  it.effect('classifies the Windows subprocess integrity-label exit without modifying the live config', () =>
    Effect.gen(function* () {
      const system = yield* SystemInfo;
      const executor = yield* CommandExecutor;
      const {fs, home, target} = yield* fixture;
      yield* fs.writeFileString(target, 'original');
      const before = yield* fromPromise('test.statOriginalCodexConfig', () => runtimeLstat(target));
      const result = yield* stageCodexConfiguration(home, target, before, 'replacement').pipe(
        Effect.provideService(SystemInfo, {...system, platform: 'win32'}),
        Effect.provideService(CommandExecutor, {
          ...executor,
          execute: (_executable, _arguments, options) =>
            executor.execute(system.executablePath, ['-e', 'process.exit(4)'], options),
        }),
        Effect.result,
      );
      expect(Result.isFailure(result) && result.failure.message).toBe(
        'Windows Codex configuration integrity labels differ.',
      );
      expect(yield* fs.readFileString(target)).toBe('original');
    }).pipe(TestClock.withLive),
  );

  for (const acl of ['plain', 'matching', 'mismatch']) {
    it.effect(`checks Linux configuration access when the ACL is ${acl}`, () =>
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        if (system.platform !== 'darwin' && system.platform !== 'linux') return;
        const executor = yield* CommandExecutor;
        const {fs, home, target} = yield* fixture;
        yield* fs.writeFileString(target, 'original');
        const before = yield* fromPromise('test.statOriginalCodexConfig', () => runtimeLstat(target));
        const result = yield* stageCodexConfiguration(home, target, before, 'local MCP update').pipe(
          Effect.provideService(SystemInfo, {...system, platform: 'linux'}),
          Effect.provideService(CommandExecutor, {
            ...executor,
            execute: (command, args, options) => {
              if (command === '/bin/cp') return executor.execute(command, ['-p', ...args.slice(1)], options);
              if (command === '/bin/ls') {
                const marker = acl === 'plain' ? '' : '+';
                return Effect.succeed({
                  stdout: `-rw-r--r--${marker} 1 1000 1000 ? 8 fixture\n`,
                  stderr: '',
                  exitCode: 0,
                });
              }
              expect(acl).not.toBe('plain');
              expect(EffectArray.contains(args, '-p')).toBe(true);
              const isStagedFile = args[args.length - 1] !== target;
              const stdout = isStagedFile && acl === 'mismatch' ? 'user:1001:rw-\n' : 'user:1001:r--\n';
              return Effect.succeed({stdout, stderr: '', exitCode: 0});
            },
          }),
          Effect.result,
        );
        if (acl === 'mismatch') {
          expect(Result.isFailure(result)).toBe(true);
        } else {
          if (Result.isFailure(result)) return yield* result.failure;
          const staging = result.success;
          expect(yield* publishStagedCodexConfiguration(target, staging, true, Effect.succeed(true))).toBe(true);
        }
        expect(yield* fs.readFileString(target)).toBe(acl === 'mismatch' ? 'original' : 'local MCP update');
      }).pipe(TestClock.withLive),
    );
  }
});
