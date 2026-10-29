import {Array as EffectArray} from 'effect';
import {it} from '@effect/vitest';
import {Cause, Context, Deferred, Effect, Fiber, Result, Schema} from 'effect';
import {expect} from 'vitest';
import {TestClock} from 'effect/testing';
import {
  CurrentResourceRecallInvalidationObserver,
  consumeResourceRecallInvalidationReceipt,
} from '@threadnote/store/resource/recall-invalidation';
import {makeWorkflowRecallRefresh} from '../../src/workflow_memory/recall_refresh.js';

const config = {
  account: 'local',
  user: 'fixture',
  agentContextHome: '/private/fixture',
  manifestPath: '/private/fixture/manifest.json',
};
const fixture = () => {
  const calls: (readonly string[])[] = [];
  const batching = makeWorkflowRecallRefresh((_config, uris) =>
    Effect.sync(() => {
      calls.push([...uris]);
    }),
  );
  return {...batching, calls};
};

it.effect.prop(
  'flushes the deduplicated URI union exactly once before a request returns',
  {
    writes: Schema.Array(
      Schema.Array(
        Schema.Literals([
          'threadnote://user/fixture/memories/durable/a.md',
          'threadnote://user/fixture/memories/durable/b.md',
          'threadnote://user/fixture/memories/durable/c.md',
        ]),
      ).check(Schema.isMaxLength(8)),
    ).check(Schema.isMaxLength(8)),
  },
  ({writes}) =>
    Effect.gen(function* () {
      const f = fixture();
      const result = yield* f.withBatch(
        config,
        Effect.gen(function* () {
          for (const uris of writes) yield* f.refresh(config, uris);
          expect(f.calls).toHaveLength(0);
          return 'saved';
        }),
      );
      expect(result).toBe('saved');
      const expected = [...new Set(writes.flat())];
      expect(f.calls).toEqual(expected.length ? [expected] : []);
    }),
  {arbitrary: {runs: 30}},
);

it.effect('keeps two requests and nested scopes independent', () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.withBatch(
      config,
      Effect.gen(function* () {
        yield* f.refresh(config, ['outer']);
        yield* f.withBatch(config, f.refresh(config, ['inner']));
        expect(f.calls).toEqual([['inner']]);
        yield* f.refresh(config, ['outer', 'later']);
      }),
    );
    yield* f.withBatch(config, f.refresh(config, ['second']));
    expect(f.calls).toEqual([['inner'], ['outer', 'later'], ['second']]);
  }),
);

it.effect('refreshes direct and mismatched configuration writes immediately', () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.refresh(config, ['direct']);
    yield* f.withBatch(
      config,
      Effect.gen(function* () {
        for (const different of [
          {...config, account: 'other'},
          {...config, user: 'other'},
          {...config, agentContextHome: '/other'},
          {...config, manifestPath: '/other/manifest.json'},
        ])
          yield* f.refresh(different, ['different']);
        expect(f.calls).toHaveLength(5);
        yield* f.refresh({...config}, ['matching']);
        expect(f.calls).toHaveLength(5);
      }),
    );
    expect(f.calls).toHaveLength(6);
    expect(f.calls.at(-1)).toEqual(['matching']);
  }),
);

it.effect('does not let an inherited closed token swallow a later detached write', () =>
  Effect.gen(function* () {
    const f = fixture();
    const gate = yield* Deferred.make<void>();
    const child = yield* f.withBatch(
      config,
      Effect.gen(function* () {
        yield* f.refresh(config, ['before']);
        return yield* Effect.forkDetach(Deferred.await(gate).pipe(Effect.andThen(f.refresh(config, ['after']))));
      }),
    );
    expect(f.calls).toEqual([['before']]);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(child);
    expect(f.calls).toEqual([['before'], ['after']]);
  }),
);

it.effect('flushes durable writes on failure and interruption while retaining the original exit', () =>
  Effect.gen(function* () {
    const f = fixture();
    const failed = yield* f
      .withBatch(config, f.refresh(config, ['failed']).pipe(Effect.andThen(Effect.fail('original'))))
      .pipe(Effect.result);
    expect(failed).toEqual(Result.fail('original'));
    let inherited: Context.Context<never> | undefined;
    const interrupted = yield* f
      .withBatch(
        config,
        Effect.gen(function* () {
          inherited = yield* Effect.context<never>();
          yield* f.refresh(config, ['interrupted']);
          return yield* Effect.interrupt;
        }),
      )
      .pipe(Effect.exit);
    expect(interrupted._tag).toBe('Failure');
    if (interrupted._tag === 'Failure') expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
    if (!inherited) throw new Error('Expected inherited batch context');
    yield* f.refresh(config, ['after-interruption']).pipe(Effect.provide(inherited));
    expect(f.calls).toEqual([['failed'], ['interrupted'], ['after-interruption']]);
  }),
);

it.effect('does not replace the original failure when optional refresh defects', () =>
  Effect.gen(function* () {
    const f = makeWorkflowRecallRefresh(() => Effect.die('optional refresh defect'));
    const result = yield* f
      .withBatch(config, f.refresh(config, ['written']).pipe(Effect.andThen(Effect.fail('original'))))
      .pipe(Effect.result);
    expect(result).toEqual(Result.fail('original'));
  }),
);

it.effect('tracks potential writes without adding work outside an active matching batch', () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.track(config, ['direct-potential']);
    expect(f.calls).toHaveLength(0);
    const failed = yield* f
      .withBatch(
        config,
        Effect.gen(function* () {
          yield* f.track({...config, user: 'other'}, ['unrelated']);
          yield* f.track(config, ['committed-prefix']);
          return yield* Effect.fail('readback-failed');
        }),
      )
      .pipe(Effect.result);
    expect(failed).toEqual(Result.fail('readback-failed'));
    expect(f.calls).toEqual([['committed-prefix']]);
  }),
);

it.effect('allocates fresh state for a reused Effect and concurrent requests', () =>
  Effect.gen(function* () {
    const f = fixture();
    const reused = f.withBatch(config, f.refresh(config, ['reused']));
    yield* reused;
    yield* reused;
    const firstEntered = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    yield* Effect.all(
      [
        f.withBatch(
          config,
          Effect.gen(function* () {
            yield* f.refresh(config, ['first']);
            yield* Deferred.succeed(firstEntered, undefined);
            yield* Deferred.await(secondEntered);
            yield* f.refresh(config, ['first-tail']);
          }),
        ),
        f.withBatch(
          config,
          Effect.gen(function* () {
            yield* Deferred.await(firstEntered);
            yield* f.refresh(config, ['second']);
            yield* Deferred.succeed(secondEntered, undefined);
          }),
        ),
      ],
      {concurrency: 'unbounded'},
    );
    expect(f.calls.slice(0, 2)).toEqual([['reused'], ['reused']]);
    expect(EffectArray.map(f.calls.slice(2), uris => EffectArray.join(uris, ',')).sort()).toEqual([
      'first,first-tail',
      'second',
    ]);
  }),
);

it.effect('bounds stalled failure cleanup and retains the original failure or interruption', () =>
  Effect.gen(function* () {
    for (const interrupted of [false, true]) {
      const entered = yield* Deferred.make<void>();
      let attempts = 0;
      const f = makeWorkflowRecallRefresh(() =>
        Effect.gen(function* () {
          attempts++;
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }),
      );
      const child = yield* f
        .withBatch(
          config,
          f.track(config, ['written']).pipe(Effect.andThen(interrupted ? Effect.interrupt : Effect.fail('original'))),
        )
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust('5 seconds');
      const exit = yield* Fiber.join(child);
      expect(exit._tag).toBe('Failure');
      if (exit._tag === 'Failure') {
        if (interrupted) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        else expect(Cause.findError(exit.cause)).toEqual(Result.succeed('original'));
      }
      expect(attempts).toBe(1);
    }
  }),
);

it.effect('does not impose a timeout on normal complete refresh or retry after its interruption', () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const complete = yield* Deferred.make<void>();
    const nextEntered = yield* Deferred.make<void>();
    const blocked = yield* Deferred.make<void>();
    let attempts = 0;
    const f = makeWorkflowRecallRefresh(() =>
      Effect.gen(function* () {
        attempts++;
        if (attempts === 1) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(complete);
        } else {
          yield* Deferred.succeed(nextEntered, undefined);
          yield* Deferred.await(blocked);
        }
      }),
    );
    const child = yield* f.withBatch(config, f.refresh(config, ['written'])).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* TestClock.adjust('6 seconds');
    expect(attempts).toBe(1);
    yield* Deferred.succeed(complete, undefined);
    yield* Fiber.join(child);
    expect(attempts).toBe(1);
    const stopped = yield* f.withBatch(config, f.refresh(config, ['next'])).pipe(Effect.forkChild);
    yield* Deferred.await(nextEntered);
    const stopping = yield* Fiber.interrupt(stopped).pipe(Effect.forkChild);
    yield* TestClock.adjust('5 seconds');
    yield* Fiber.join(stopping);
    expect(attempts).toBe(2);
  }),
);

it.effect('only reuses lexical markers after fully covered artifact and manifest verification', () =>
  Effect.gen(function* () {
    for (const variant of [
      'covered',
      'missing-manifest',
      'failed-manifest',
      'missing-verification',
      'outer-failure',
      'custom-store',
      'wrong-scope',
      'repeated-uri',
    ]) {
      const calls: {uris: readonly string[]; covered: boolean}[] = [];
      const location = {home: config.agentContextHome, account: config.account, user: config.user};
      const f = makeWorkflowRecallRefresh((_config, uris, receipt) =>
        Effect.sync(() => {
          calls.push({uris, covered: consumeResourceRecallInvalidationReceipt(receipt, location, uris)});
        }),
      );
      const result = yield* f
        .withBatch(
          config,
          Effect.gen(function* () {
            const observer = yield* CurrentResourceRecallInvalidationObserver;
            for (const [index, uri] of ['artifact', 'manifest'].entries()) {
              yield* f.track(config, [uri]);
              if (variant !== 'custom-store' && !(variant === 'missing-manifest' && uri === 'manifest')) {
                for (const scope of [false, true])
                  observer!.begin(
                    {...location, ...(variant === 'wrong-scope' ? {account: 'other'} : {})},
                    [uri],
                    {previousGeneration: `generation-${index}`, currentGeneration: `generation-${index + 1}`},
                    scope,
                  )(!(variant === 'failed-manifest' && uri === 'manifest' && scope));
              }
              if (!(variant === 'missing-verification' && uri === 'artifact')) yield* f.verified(config, [uri]);
            }
            if (variant === 'repeated-uri') {
              yield* f.track(config, ['artifact']);
              yield* f.verified(config, ['artifact']);
            }
            if (variant === 'outer-failure') return yield* Effect.fail('native-state-commit-failed');
          }),
        )
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(variant === 'outer-failure');
      expect(calls).toEqual([{uris: ['artifact', 'manifest'], covered: variant === 'covered'}]);
    }
  }),
);

it.effect('deduplicates aliases within a hook while counting repeated mutations across hooks', () =>
  Effect.gen(function* () {
    const location = {home: config.agentContextHome, account: config.account, user: config.user};
    for (const [calls, transitions] of [
      [1, 1],
      [2, 1],
      [2, 2],
    ]) {
      let covered = false;
      const f = makeWorkflowRecallRefresh((_config, uris, receipt) =>
        Effect.sync(() => {
          expect(uris).toEqual(['root']);
          covered = consumeResourceRecallInvalidationReceipt(receipt, location, uris);
        }),
      );
      yield* f.withBatch(
        config,
        Effect.gen(function* () {
          const observer = yield* CurrentResourceRecallInvalidationObserver;
          for (let index = 0; index < calls; index++) {
            yield* f.track(config, ['root', 'root']);
            if (index < transitions)
              for (const scope of [false, true])
                observer!.begin(
                  location,
                  ['root'],
                  {
                    previousGeneration: `before-${index}`,
                    currentGeneration: `after-${index}`,
                  },
                  scope,
                )(true);
            yield* f.refresh(config, ['root', 'root']);
          }
        }),
      );
      expect(covered).toBe(transitions === calls);
    }
  }),
);
