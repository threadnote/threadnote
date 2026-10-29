import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  readNativeCloseoutJournal,
  withNativeCloseoutLock,
  writeNativeCloseoutJournal,
} from '../../src/workflow_automation/closeout_store.js';
import {nativeCloseoutJournalPath, withNativeWorkflowLock} from '../../src/workflow_automation/store.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';

const stateSchema = Schema.Struct({format: Schema.Literal('fixture-closeout'), revision: Schema.Int});
const decodeState = (value: unknown) => Schema.decodeUnknownSync(stateSchema, {onExcessProperty: 'error'})(value);
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.result);

describe('native closeout receipt store', () => {
  effectIt.effect('uses a fixed path and reads absence without creating state', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const absent = yield* failure(readNativeCloseoutJournal(f.config, 'native-run', decodeState));
      expect(Result.isFailure(absent)).toBe(true);
      expect(yield* f.fs.exists(f.path.join(f.home, 'workflow-automations'))).toBe(false);

      yield* f.init();
      const file = yield* nativeCloseoutJournalPath(f.config, 'native-run');
      expect(file).toBe((yield* f.fs.realPath(f.statePath())) + '.closeout.json');
      expect(yield* readNativeCloseoutJournal(f.config, 'native-run', decodeState)).toBeUndefined();
      expect(yield* f.fs.exists(file)).toBe(false);
    }).pipe(provideNative),
  );

  effectIt.effect('round trips, compares exact bytes, and preserves malformed receipts', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
      const config = f.config;
      const first = yield* writeNativeCloseoutJournal(
        config,
        'native-run',
        {format: 'fixture-closeout', revision: 1},
        null,
        decodeState,
      );
      const read = yield* readNativeCloseoutJournal(config, 'native-run', decodeState);
      expect(read).toEqual(first);

      const second = yield* writeNativeCloseoutJournal(
        config,
        'native-run',
        {format: 'fixture-closeout', revision: 2},
        first.revision,
        decodeState,
      );
      const file = yield* nativeCloseoutJournalPath(config, 'native-run');
      const beforeConflict = yield* f.fs.readFile(file);
      const conflict = yield* failure(
        writeNativeCloseoutJournal(
          config,
          'native-run',
          {format: 'fixture-closeout', revision: 3},
          first.revision,
          decodeState,
        ),
      );
      expect(Result.isFailure(conflict)).toBe(true);
      expect(yield* f.fs.readFile(file)).toEqual(beforeConflict);
      expect((yield* readNativeCloseoutJournal(config, 'native-run', decodeState))?.revision).toBe(second.revision);

      const malformed = '{"format":"threadnote-native-closeout-state-gzip-v1","payload":"broken"}';
      yield* f.fs.writeFileString(file, malformed);
      const corruptRead = yield* failure(readNativeCloseoutJournal(config, 'native-run', decodeState));
      expect(Result.isFailure(corruptRead)).toBe(true);
      const corruptWrite = yield* failure(
        writeNativeCloseoutJournal(
          config,
          'native-run',
          {format: 'fixture-closeout', revision: 4},
          sha256HexSync(malformed),
          decodeState,
        ),
      );
      expect(Result.isFailure(corruptWrite)).toBe(true);
      expect(yield* f.fs.readFileString(file)).toBe(malformed);
    }).pipe(provideNative),
  );

  effectIt.effect('rejects symlink journals and keeps the external file intact', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
      const config = f.config;
      const file = yield* nativeCloseoutJournalPath(config, 'native-run');
      const outside = f.path.join(f.home, 'outside.json');
      const bytes = '{"format":"fixture-closeout","revision":9}';
      yield* f.fs.writeFileString(outside, bytes);
      yield* f.fs.symlink(outside, file);

      const read = yield* failure(readNativeCloseoutJournal(config, 'native-run', decodeState));
      const write = yield* failure(
        writeNativeCloseoutJournal(config, 'native-run', {format: 'fixture-closeout', revision: 10}, null, decodeState),
      );
      expect(Result.isFailure(read)).toBe(true);
      expect(Result.isFailure(write)).toBe(true);
      expect(yield* f.fs.readFileString(outside)).toBe(bytes);
    }).pipe(provideNative),
  );

  effectIt.effect('keeps closeout locking independent and reports bounded contention', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
      const config = f.config;
      const nested = yield* withNativeCloseoutLock(
        config,
        'native-run',
        withNativeCloseoutLock(config, 'native-run', Effect.void).pipe(Effect.result),
      );
      expect(Result.isFailure(nested)).toBe(true);
      if (Result.isFailure(nested)) expect(nested.failure).toMatchObject({code: 'closeout-busy', retryable: true});

      const independent = yield* withNativeWorkflowLock(
        config,
        'native-run',
        false,
        withNativeCloseoutLock(config, 'native-run', Effect.void),
      );
      expect(independent).toBeUndefined();
    }).pipe(provideNative, TestClock.withLive),
  );

  effectIt.effect('allows only one writer for a shared expected revision', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* f.init();
      const config = f.config;
      const initial = yield* writeNativeCloseoutJournal(
        config,
        'native-run',
        {format: 'fixture-closeout', revision: 1},
        null,
        decodeState,
      );
      const outcomes = yield* Effect.forEach(
        [2, 3],
        revision =>
          withNativeCloseoutLock(
            config,
            'native-run',
            writeNativeCloseoutJournal(
              config,
              'native-run',
              {format: 'fixture-closeout', revision},
              initial.revision,
              decodeState,
            ),
          ).pipe(Effect.result),
        {concurrency: 'unbounded'},
      );
      expect(EffectArray.filter(outcomes, Result.isSuccess)).toHaveLength(1);
      expect(EffectArray.filter(outcomes, Result.isFailure)).toHaveLength(1);
    }).pipe(provideNative, TestClock.withLive),
  );
});
