import {Array as EffectArray} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {runCommandEffect} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('Code Memory Link agent trial ledger lock', () => {
  effectIt.effect('holds one canonical lock across a delayed external execution and receipt write', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-memory-link-lock-'});
      const child = path.join(process.cwd(), 'apps/threadnote/test/helpers/code-memory-link-agent-lock-child.ts');
      const results = yield* Effect.all(
        [
          runCommandEffect(process.execPath, [child, root], {timeoutMs: 15_000}),
          runCommandEffect(process.execPath, [child, root], {timeoutMs: 15_000}),
        ],
        {concurrency: 2},
      );

      expect(EffectArray.map(results, result => result.exitCode)).toEqual([0, 0]);
      expect(
        EffectArray.filter(
          yield* fs.readDirectory(path.join(root, 'external-executions')),
          __effectArrayValue => !!(name => Effect2.pipe(name, EffectString.endsWith('.marker')))(__effectArrayValue),
        ),
      ).toHaveLength(1);
      expect(
        Effect2.pipe(
          yield* fs.readFileString(path.join(root, 'trials.jsonl')),
          EffectString.trim,
          EffectString.split(/\r?\n/u),
        ),
      ).toHaveLength(1);
      expect(yield* fs.exists(path.join(root, 'trials.jsonl.lock'))).toBe(false);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
});
