import * as BunServices from '@effect/platform-bun/BunServices';
import {it} from '@effect/vitest';
import {Effect, FileSystem, Layer, Schema} from 'effect';
import {expect} from 'vitest';
import {TestClock} from 'effect/testing';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {
  CurrentResourceRecallInvalidationObserver,
  ResourceRecallInvalidation,
  consumeResourceRecallInvalidationReceipt,
  makeResourceRecallInvalidationObservation,
} from '@threadnote/store/resource/recall-invalidation';
import {ResourceStore} from '@threadnote/store/resource-store';
import {Array as EffectArray} from 'effect';

function provideLayer<Services, E, R>(layer: Layer.Layer<Services, E, R>) {
  return <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}

const uri = 'threadnote://resources/receipt.md';
const location = {home: '/fixture', account: 'local', user: 'tester'};
const acknowledge = (
  observation: ReturnType<typeof makeResourceRecallInvalidationObservation>,
  generation: number,
  changes: {scope?: boolean; failed?: boolean; home?: string} = {},
) => {
  for (const scope of [false, true]) {
    if (changes.scope !== undefined && changes.scope !== scope) continue;
    observation.observer.begin(
      {...location, home: changes.home ?? location.home},
      [uri],
      {
        previousGeneration: `v1:${generation}`,
        currentGeneration: `v1:${generation + 1}`,
      },
      scope,
    )(!changes.failed);
  }
};

it.effect('requires matching counted verification and both terminal scope acknowledgements', () =>
  Effect.sync(() => {
    for (const variant of [
      'covered',
      'missing',
      'failed',
      'scope',
      'home',
      'unverified',
      'repeated',
      'extra',
      'outer-failure',
    ]) {
      const observation = makeResourceRecallInvalidationObservation(location);
      observation.expect([uri]);
      if (variant !== 'unverified') observation.verify([uri]);
      if (variant === 'repeated') {
        observation.expect([uri]);
        observation.verify([uri]);
      }
      if (variant !== 'missing')
        acknowledge(observation, 1, {
          ...(variant === 'failed' ? {failed: true} : {}),
          ...(variant === 'scope' ? {scope: false} : {}),
          ...(variant === 'home' ? {home: '/other'} : {}),
        });
      if (variant === 'extra') acknowledge(observation, 2);
      const receipt = observation.finish(variant !== 'outer-failure', [uri]);
      expect(consumeResourceRecallInvalidationReceipt(receipt, location, [uri]), variant).toBe(variant === 'covered');
      expect(consumeResourceRecallInvalidationReceipt(receipt, {...location, account: 'other'}, [uri])).toBe(false);
      expect(consumeResourceRecallInvalidationReceipt(receipt, location, ['unobserved'])).toBe(false);
    }
  }),
);

it.effect('revokes pending callbacks, isolates request tokens and counts repeated URI mutations', () =>
  Effect.sync(() => {
    const observation = makeResourceRecallInvalidationObservation(location);
    observation.expect([uri, uri]);
    observation.verify([uri, uri]);
    acknowledge(observation, 1);
    acknowledge(observation, 2);
    expect(consumeResourceRecallInvalidationReceipt(observation.finish(true, [uri]), location, [uri])).toBe(true);
    const revoked = makeResourceRecallInvalidationObservation(location);
    revoked.expect([uri]);
    revoked.verify([uri]);
    const late = revoked.observer.begin(
      location,
      [uri],
      {previousGeneration: 'before', currentGeneration: 'after'},
      false,
    );
    expect(revoked.finish(true, [uri])).toBeUndefined();
    late(true);
    acknowledge(revoked, 1);
    expect(revoked.finish(true, [uri])).toBeUndefined();
    const other = makeResourceRecallInvalidationObservation(location);
    other.expect([uri]);
    other.verify([uri]);
    acknowledge(observation, 3);
    expect(other.finish(true, [uri])).toBeUndefined();
  }),
);

const systemLayer = SystemInfo.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: 'resource-receipt-test.ts'}),
      Layer.succeed(ChildEnvironmentPolicy, {
        preserveIntendedChild: environment => ({...environment}),
        sanitizeExternal: environment => ({...environment}),
      }),
    ),
  ),
);
const dependencies = Layer.mergeAll(BunServices.layer, systemLayer);

it.effect('a prebuilt real store observes request-local retries and exhausted failure in either scope', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const failureScope of [false, true])
      for (const exhausted of [false, true]) {
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'store-recall-receipt-'});
        const actual = {...location, home};
        const attempts = new Map<boolean, number>();
        const store = yield* ResourceStore.pipe(
          provideLayer(
            ResourceStore.layer.pipe(
              Layer.provide(
                Layer.succeed(ResourceRecallInvalidation, {
                  expire: (_home, scope) =>
                    Effect.suspend(() => {
                      const count = (attempts.get(scope) ?? 0) + 1;
                      attempts.set(scope, count);
                      return scope === failureScope && (exhausted || count < 3)
                        ? Effect.fail('marker failure')
                        : Effect.void;
                    }),
                }),
              ),
            ),
          ),
        );
        // Build the store first; providing a decorated invalidator at request time
        // would leave its captured invalidator unchanged.
        const observation = makeResourceRecallInvalidationObservation(actual);
        observation.expect([uri]);
        yield* store
          .write(actual, uri, 'durable', {mode: 'create'})
          .pipe(Effect.provideService(CurrentResourceRecallInvalidationObserver, observation.observer));
        observation.verify([uri]);
        expect(yield* store.read(actual, uri)).toBe('durable');
        expect(attempts.get(failureScope)).toBe(3);
        expect(attempts.get(!failureScope)).toBe(1);
        expect(consumeResourceRecallInvalidationReceipt(observation.finish(true, [uri]), actual, [uri])).toBe(
          !exhausted,
        );
      }
  }).pipe(TestClock.withLive, provideLayer(dependencies)),
);

it.effect('observer defects cannot alter canonical write semantics', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'store-recall-observer-defect-'});
    const actual = {...location, home};
    const store = yield* ResourceStore.pipe(
      provideLayer(
        ResourceStore.layer.pipe(Layer.provide(Layer.succeed(ResourceRecallInvalidation, {expire: () => Effect.void}))),
      ),
    );
    for (const terminal of [false, true]) {
      yield* store.write(actual, uri, String(terminal), {mode: terminal ? 'replace' : 'create'}).pipe(
        Effect.provideService(CurrentResourceRecallInvalidationObserver, {
          begin: () => {
            if (!terminal) throw new Error('observer begin');
            return () => {
              throw new Error('observer completion');
            };
          },
        }),
      );
      expect(yield* store.read(actual, uri)).toBe(String(terminal));
    }
  }).pipe(TestClock.withLive, provideLayer(dependencies)),
);

it.effect.prop(
  'coverage requires every occurrence of a repeated URI mutation',
  {
    acknowledgements: Schema.Array(Schema.Boolean).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  },
  ({acknowledgements}) =>
    Effect.sync(() => {
      const observation = makeResourceRecallInvalidationObservation(location);
      for (const [index, acknowledged] of acknowledgements.entries()) {
        observation.expect([uri]);
        observation.verify([uri]);
        if (acknowledged) acknowledge(observation, index);
      }
      expect(consumeResourceRecallInvalidationReceipt(observation.finish(true, [uri]), location, [uri])).toBe(
        EffectArray.every(acknowledgements, Boolean),
      );
    }),
  {arbitrary: {runs: 30}},
);

it.effect('receipts are one-use and reject scope mismatch', () =>
  Effect.sync(() => {
    for (const actual of [
      location,
      {...location, home: '/elsewhere'},
      {...location, account: 'other'},
      {...location, user: 'other'},
    ]) {
      const observation = makeResourceRecallInvalidationObservation(location);
      observation.expect([uri]);
      observation.verify([uri]);
      acknowledge(observation, 1);
      const receipt = observation.finish(true, [uri]);
      expect(consumeResourceRecallInvalidationReceipt(receipt, actual, [uri])).toBe(actual === location);
      expect(consumeResourceRecallInvalidationReceipt(receipt, location, [uri])).toBe(false);
    }
  }),
);
