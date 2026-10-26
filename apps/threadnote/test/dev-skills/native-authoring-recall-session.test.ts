import {Database} from 'bun:sqlite';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it} from '@effect/vitest';
import {Effect, FileSystem, Layer} from 'effect';
import {TestClock} from 'effect/testing';
import {expect, vi} from 'vitest';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {makeWorkflowRecallRefresh} from '../../src/workflow_memory/recall_refresh.js';

const system = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'workflow-recall-session-test.ts'}),
      Layer.succeed(ChildEnvironmentPolicy, {
        preserveIntendedChild: environment => ({...environment}),
        sanitizeExternal: environment => ({...environment}),
      }),
    ),
  ),
);
const dependencies = Layer.mergeAll(
  BunServices.layer,
  system,
  Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}),
);
const provideServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(dependencies).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));

it.effect('retains through the normal flush and closes before failure cleanup begins', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'workflow-recall-session-'});
    const config = {account: 'local', agentContextHome: home, user: 'fixture'};
    const query = loadRecallIndexData(config, {includeInactive: false});
    yield* query;
    const close = vi.spyOn(Database.prototype, 'close');
    yield* Effect.gen(function* () {
      const batching = makeWorkflowRecallRefresh(() =>
        query.pipe(
          Effect.tap(() => Effect.sync(() => expect(close).toHaveBeenCalledTimes(0))),
          Effect.orDie,
        ),
      );
      yield* batching.withBatch(
        config,
        Effect.gen(function* () {
          yield* query;
          yield* query;
          yield* batching.refresh(config, ['normal']);
        }),
      );
      expect(close).toHaveBeenCalledTimes(1);
      close.mockClear();
      let cleanup = false;
      const failing = makeWorkflowRecallRefresh(() =>
        Effect.gen(function* () {
          // The request's retained connection has already closed. Cleanup gets
          // its ordinary fresh scope, which closes before this callback returns.
          expect(close).toHaveBeenCalledTimes(1);
          yield* query;
          expect(close).toHaveBeenCalledTimes(2);
          cleanup = true;
        }).pipe(Effect.orDie),
      );
      const exit = yield* failing
        .withBatch(
          config,
          Effect.gen(function* () {
            yield* query;
            yield* failing.track(config, ['failed']);
            return yield* Effect.fail('original');
          }),
        )
        .pipe(Effect.exit);
      expect(exit._tag).toBe('Failure');
      expect(cleanup).toBe(true);
    }).pipe(Effect.ensuring(Effect.sync(() => close.mockRestore())));
  }).pipe(TestClock.withLive, provideServices),
);
