import {Array as EffectArray} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Path, Schema, Stream} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  makeManagerSourceObservation,
  managerSourceDirectoryFiles,
  managerSourceFilesProbe,
} from '../../src/manager/live_source_observation.js';
import {nextManagerWindowChange} from '../../src/manager/live_consumer_sources.js';

const withLayer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const resource = {topic: 'home', scope: 'account'} as const;

describe('Manager bounded source observation', () => {
  effectIt.effect(
    'reconciles dropped notifications, idles unchanged, recovers source errors and releases shared watches',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'manager-source-live-'});
        const file = path.join(root, 'source.json');
        const changes: string[] = [];
        const availability: boolean[] = [];
        let readable = true;
        const observer = yield* makeManagerSourceObservation(
          ['home'],
          {
            onInvalidate: (_resource, revision) =>
              Effect.sync(() => {
                changes.push(revision);
              }),
            onAvailability: (_resource, available) =>
              Effect.sync(() => {
                availability.push(available);
              }),
          },
          () => (readable ? managerSourceFilesProbe([file]) : Effect.void),
        ).pipe(Effect.provideService(FileSystem.FileSystem, {...fs, watch: () => Stream.never}));
        expect(yield* observer.subscribe('one', [resource])).toEqual([]);
        expect(yield* observer.subscribe('two', [resource])).toEqual([]);
        expect((yield* observer.diagnostics).resources).toBe(1);
        yield* observer.reconcileNow;
        expect(changes).toEqual([]);
        yield* fs.writeFileString(file + '.tmp', '{}');
        yield* fs.rename(file + '.tmp', file);
        yield* observer.reconcileNow;
        expect(changes).toHaveLength(1);
        yield* observer.reconcileNow;
        expect(changes).toHaveLength(1);
        readable = false;
        yield* observer.reconcileNow;
        expect(availability).toEqual([true, false]);
        readable = true;
        yield* observer.reconcileNow;
        expect(availability).toEqual([true, false, true]);
        yield* observer.release('one');
        expect((yield* observer.diagnostics).resources).toBe(1);
        yield* observer.release('two');
        expect(yield* observer.diagnostics).toEqual({resources: 0, connections: 0, watches: 0});
      }).pipe(withLayer),
  );

  effectIt.effect('performs no invalidations during sixty seconds of unchanged observed metadata', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let changes = 0;
      const observer = yield* makeManagerSourceObservation(
        ['home'],
        {
          onInvalidate: () =>
            Effect.sync(() => {
              changes++;
            }),
          onAvailability: () => Effect.void,
        },
        () => Effect.succeed({revision: 'unchanged', directories: []}),
      ).pipe(Effect.provideService(FileSystem.FileSystem, {...fs, watch: () => Stream.never}));
      yield* observer.subscribe('one', [resource]);
      yield* TestClock.adjust('60 seconds');
      expect(changes).toBe(0);
    }).pipe(withLayer),
  );

  effectIt.effect('keeps excess watch demand unavailable without flapping supported resources', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const availability: Array<[string, boolean]> = [];
      const observer = yield* makeManagerSourceObservation(
        ['home'],
        {
          onInvalidate: () => Effect.void,
          onAvailability: (resource, supported) =>
            Effect.sync(() => {
              availability.push(['project' in resource ? resource.project : '', supported]);
            }),
        },
        resource =>
          Effect.succeed({
            revision: 'unchanged',
            directories: Array.from({length: 65}, (_, i) => `/${'project' in resource ? resource.project : ''}/${i}`),
          }),
      ).pipe(Effect.provideService(FileSystem.FileSystem, {...fs, watch: () => Stream.never}));
      const alpha = {topic: 'home', project: 'alpha'} as const;
      const beta = {topic: 'home', project: 'beta'} as const;
      expect(yield* observer.subscribe('one', [alpha])).toEqual([]);
      expect(yield* observer.subscribe('two', [beta])).toEqual([beta]);
      yield* observer.reconcileNow;
      yield* TestClock.adjust('60 seconds');
      expect(availability).toEqual([['alpha', true]]);
      expect((yield* observer.diagnostics).watches).toBe(65);
      yield* observer.release('one');
      yield* observer.reconcileNow;
      expect(availability).toEqual([
        ['alpha', true],
        ['beta', true],
      ]);
      expect((yield* observer.diagnostics).watches).toBe(65);
    }).pipe(withLayer),
  );

  effectIt.effect('invalidates once at a finite deadline even when durable files are unchanged', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const now = yield* Clock.currentTimeMillis;
      let changes = 0;
      const observer = yield* makeManagerSourceObservation(
        ['home'],
        {
          onInvalidate: () =>
            Effect.sync(() => {
              changes++;
            }),
          onAvailability: () => Effect.void,
        },
        () => Effect.succeed({revision: 'unchanged', directories: [], nextChangeAt: now + 1000}),
      ).pipe(Effect.provideService(FileSystem.FileSystem, {...fs, watch: () => Stream.never}));
      yield* observer.subscribe('one', [resource]);
      yield* TestClock.adjust('1025 millis');
      yield* observer.reconcileNow;
      expect(changes).toBe(1);
      yield* TestClock.adjust('60 seconds');
      yield* observer.reconcileNow;
      expect(changes).toBe(1);
    }).pipe(withLayer),
  );

  effectIt.effect('rejects directory overflow before selecting names and tracks missing ancestors', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'manager-source-budget-'});
      for (let i = 0; i < 4; i++) yield* fs.writeFileString(path.join(root, `${i}.json`), '{}');
      const overflow = yield* managerSourceDirectoryFiles(root, () => false, 3).pipe(Effect.result);
      expect(overflow._tag).toBe('Failure');
      const probe = yield* managerSourceFilesProbe([path.join(root, 'missing', 'deep', 'source.json')]);
      expect(probe.directories).toContain(root);
    }).pipe(withLayer),
  );

  effectIt.effect.prop(
    'rolling-window deadlines equal the next independent membership transition',
    {
      now: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 20})),
      stamps: Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 25}))).check(Schema.isMaxLength(20)),
    },
    ({now, stamps}) =>
      Effect.sync(() => {
        const member = (stamp: number, time: number) => stamp >= time - 10 && stamp <= time;
        const before = EffectArray.map(stamps, stamp => member(stamp, now));
        let expected: number | undefined;
        for (let time = now + 1; time <= 36; time++)
          if (EffectArray.some(stamps, (stamp, index) => member(stamp, time) !== before[index])) {
            expected = time;
            break;
          }
        expect(nextManagerWindowChange(now, 10, stamps)).toBe(expected);
        expect(nextManagerWindowChange(now, 10, [...stamps].reverse())).toBe(expected);
      }),
    {arbitrary: {runs: 24}},
  );
});
