import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {succeedUndefined} from '@threadnote/platform/optional';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  runContextMaintenanceScheduler,
  setContextMaintenancePaused,
  readContextMaintenanceControl,
  wakeContextMaintenance,
} from '@threadnote/threadnote/memory/context/maintenance';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {CONTEXT_MAINTENANCE_WORKER_ARGUMENT} from '../../src/memory/context/maintenance_worker.js';

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
  effectIt.effect('defaults a fresh installation to off and does not start detached maintenance', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      expect((yield* readContextMaintenanceControl(config)).paused).toBe(true);
      const command = CommandExecutor.of({
        execute: unavailableCommand,
        executeStreaming: unavailableCommand,
        spawnDetached: () => Effect.die('Automatic maintenance must remain off until enabled.'),
      });
      expect(yield* wakeContextMaintenance(config).pipe(Effect.provideService(CommandExecutor, command))).toBe(false);
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );

  effectIt.effect('wakes the guarded worker immediately and every thirty seconds with the exact MCP owner', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      yield* setContextMaintenancePaused(config, false);
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
      expect(calls[0].args.at(-2)).toBe(CONTEXT_MAINTENANCE_WORKER_ARGUMENT);
      expect(JSON.parse(calls[0].args.at(-1)!)).toEqual({
        config,
        owner: {
          processId: system.processId,
          startIdentity: yield* system.canonicalProcessStartIdentity!(system.processId),
        },
      });
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
        spawnDetached: (_executable, args) =>
          Effect.sync(() => {
            expect(JSON.parse(args.at(-1)!)).toEqual({config});
            calls++;
            return true;
          }),
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

  effectIt.effect('does not launch MCP work with an unknown owner identity', () =>
    Effect.gen(function* () {
      const config = yield* fixture();
      yield* setContextMaintenancePaused(config, false);
      const system = yield* SystemInfo;
      expect(
        yield* wakeContextMaintenance(config, {bindToParent: true}).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            canonicalProcessStartIdentity: () => succeedUndefined,
          }),
          Effect.provideService(
            CommandExecutor,
            CommandExecutor.of({
              execute: unavailableCommand,
              executeStreaming: unavailableCommand,
              spawnDetached: () => Effect.die('Unknown MCP owner must not start a worker.'),
            }),
          ),
        ),
      ).toBe(false);
    }).pipe(provideTestLayer(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer))),
  );
});
