import {it as effectIt} from '@effect/vitest';
import {Context, Deferred, Effect, Fiber, FileSystem, Layer, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ResourceRecallInvalidation} from '@threadnote/store/resource/recall-invalidation';
import {SystemInfo} from '@threadnote/platform/system';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import {inspectWorkflowJournal} from '../../src/workflow_memory/journal.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const Initialized = Schema.Struct({
  bindingId: Schema.String,
  naming: Schema.Struct({slug: Schema.String, ordinal: Schema.Finite}),
});

effectIt.effect('allocates distinct native families while another initializer atomically commits its manifest', () =>
  Effect.gen(function* () {
    const f = yield* nativeFixture();
    const system = yield* SystemInfo;
    const inventoryDirectory = f.path.join(
      yield* f.fs.realPath(f.home),
      'data/local/user/tester/memories/handoffs/active/fixture',
    );
    const ready = yield* Deferred.make<void>();
    const listed = yield* Deferred.make<void>();
    const committed = yield* Deferred.make<void>();
    let temporary = '';
    let synchronized = false;
    const fs = {
      ...f.fs,
      link: (source: string, target: string) =>
        Effect2.pipe(source, EffectString.endsWith('.tmp')) &&
        f.path.dirname(source) === inventoryDirectory &&
        !synchronized
          ? Effect.gen(function* () {
              synchronized = true;
              temporary = source;
              yield* Deferred.succeed(ready, undefined);
              yield* Deferred.await(listed).pipe(Effect.timeout('5 seconds'), Effect.orDie);
              return yield* f.fs.link(source, target);
            })
          : f.fs.link(source, target),
      remove: (target: string, options: Parameters<typeof f.fs.remove>[1]) =>
        f.fs
          .remove(target, options)
          .pipe(Effect.tap(() => (target === temporary ? Deferred.succeed(committed, undefined) : Effect.void))),
      readDirectory: (directory: string, options: Parameters<typeof f.fs.readDirectory>[1]) =>
        f.fs.readDirectory(directory, options).pipe(
          Effect.tap(names =>
            directory === inventoryDirectory && names.includes(f.path.basename(temporary))
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(listed, undefined);
                  yield* Deferred.await(committed).pipe(Effect.timeout('5 seconds'), Effect.orDie);
                  return;
                })
              : Effect.void,
          ),
        ),
    };
    const context = yield* Layer.build(ResourceStore.layerWith()).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(ResourceRecallInvalidation, {expire: () => Effect.void}),
    );
    const store = Context.get(context, ResourceStore);
    const initialize = (runId: string) =>
      f
        .call({
          ...f.base('init', runId),
          project: 'fixture',
          featureId: 'feature',
          profile: 'desktop',
          title: 'Shared Roadmap',
        })
        .pipe(Effect.provideService(ResourceStore, store), Effect.flatMap(Schema.decodeUnknownEffect(Initialized)));
    const firstFiber = yield* Effect.forkChild(initialize('inventory-a'));
    yield* Deferred.await(ready).pipe(Effect.timeout('5 seconds'), Effect.orDie);
    const second = yield* initialize('inventory-b');
    const first = yield* Fiber.join(firstFiber);
    expect(synchronized).toBe(true);
    expect(first.bindingId).not.toBe(second.bindingId);
    expect([first.naming.ordinal, second.naming.ordinal]).toEqual([1, 2]);
    expect(first.naming.slug).toBe('shared-roadmap');
    expect(second.naming.slug).toBe('shared-roadmap');
    for (const [runId, initialized] of [
      ['inventory-a', first],
      ['inventory-b', second],
    ] as const) {
      expect(yield* f.call(f.base('inspect', runId))).toMatchObject({status: 'ok', bindingId: initialized.bindingId});
      const journal = yield* inspectWorkflowJournal(f.config, initialized.bindingId).pipe(
        Effect.provideService(SystemInfo, {...system, currentDirectory: () => f.repo, environment: () => ({})}),
      );
      expect(yield* store.read(f.location, journal.state.manifestUri)).toBe(journal.state.manifestContent);
      expect(journal.state.binding.bindingId).toBe(initialized.bindingId);
      expect(journal.state.manifestCommitted).toBe(true);
    }
  }).pipe(TestClock.withLive, provideNative),
);
