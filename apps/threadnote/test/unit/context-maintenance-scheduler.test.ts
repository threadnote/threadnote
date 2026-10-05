import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  runContextMaintenanceScheduler,
  setContextMaintenancePaused,
  wakeContextMaintenance,
} from '@threadnote/threadnote/memory/context/maintenance';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';

function fixture() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scheduler-'});
    const config: RuntimeConfig = {
      account: 'local',
      agentContextHome: home,
      agentId: 'scheduler-test',
      manifestPath: path.join(home, 'manifest.yaml'),
      user: 'tester',
    };
    return config;
  });
}

const unavailableCommand = () => Effect.die(new Error('Only detached maintenance is allowed in this test.'));

describe('context maintenance scheduler containment', () => {
  effectIt.effect('starts a detached tick immediately and repeats after thirty seconds', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      const system = yield* SystemInfo;
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const calls: Array<{
        readonly args: readonly string[];
        readonly cwd?: string;
        readonly env?: NodeJS.ProcessEnv;
        readonly intendedChild?: string;
      }> = [];
      const command = CommandExecutor.of({
        execute: unavailableCommand,
        executeStreaming: unavailableCommand,
        spawnDetached: (_executable, args, options) =>
          Effect.gen(function* () {
            calls.push({args, cwd: options?.cwd, env: options?.env, intendedChild: options?.intendedChild});
            if (calls.length === 1) yield* Deferred.succeed(first, undefined);
            if (calls.length === 2) yield* Deferred.succeed(second, undefined);
            return true;
          }),
      });
      yield* runContextMaintenanceScheduler(config).pipe(
        Effect.provideService(CommandExecutor, command),
        Effect.forkScoped,
      );
      yield* Deferred.await(first);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({intendedChild: 'context-maintenance'});
      expect(calls[0].args.slice(-5)).toEqual(['context', 'maintain', '--max-records', '16', '--json']);
      expect(calls[0].args).toContain(config.agentContextHome);
      expect(calls[0].args).toContain(config.manifestPath);
      expect(calls[0].cwd).toBe(system.currentDirectory());
      expect(calls[0].env).toMatchObject({
        THREADNOTE_ACCOUNT: config.account,
        THREADNOTE_USER: config.user,
        THREADNOTE_AGENT_ID: config.agentId,
      });
      yield* TestClock.adjust('29 seconds');
      expect(calls).toHaveLength(1);
      yield* TestClock.adjust('1 second');
      yield* Deferred.await(second);
      expect(calls).toHaveLength(2);
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('does not spawn while paused and coalesces concurrent wakes', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      let calls = 0;
      const command = CommandExecutor.of({
        execute: unavailableCommand,
        executeStreaming: unavailableCommand,
        spawnDetached: () => Effect.sync(() => (calls++, true)),
      });
      yield* setContextMaintenancePaused(config, true);
      expect(yield* wakeContextMaintenance(config).pipe(Effect.provideService(CommandExecutor, command))).toBe(false);
      expect(calls).toBe(0);
      yield* setContextMaintenancePaused(config, false);
      const results = yield* Effect.all([wakeContextMaintenance(config), wakeContextMaintenance(config)], {
        concurrency: 2,
      }).pipe(Effect.provideService(CommandExecutor, command), TestClock.withLive);
      expect(results.sort()).toEqual([false, true]);
      expect(calls).toBe(1);
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );
});
