import {Array as EffectArray, Option as EffectOption} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {evaluateCodeMemoryLinkBenchRuntime} from '@threadnote/threadnote/evaluation/code-memory-link-bench';
import {
  CODE_MEMORY_LINK_BENCH_APPROVED_FIXTURE_HASH,
  codeMemoryLinkBenchFixtureHash,
  parseCodeMemoryLinkBenchFixtureV1,
} from '@threadnote/threadnote/evaluation/code-memory-link-bench-contract';
import {provideTestLayer} from '../helpers/effect-layer.js';

const FIXTURE = new URL('../evaluation/fixtures/code-memory-link-bench-v1/fixture.json', import.meta.url);

describe('CodeMemoryLinkBench runtime', () => {
  effectIt.effect('passes the frozen code-to-memory retrieval, safety, latency, and budget gate', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture: unknown = JSON.parse(yield* fs.readFileString(yield* path.fromFileUrl(FIXTURE)));
      const result = yield* evaluateCodeMemoryLinkBenchRuntime(fixture);

      expect(codeMemoryLinkBenchFixtureHash(parseCodeMemoryLinkBenchFixtureV1(fixture))).toBe(
        CODE_MEMORY_LINK_BENCH_APPROVED_FIXTURE_HASH,
      );
      expect(result.gate).toEqual({failures: [], passed: true});
      expect(result.metrics.exactCleanRecallAt3).toBe(1);
      expect(result.metrics.relocationInclusiveRecallAt3).toBe(1);
      expect(result.metrics.falseCurrentCount).toBe(0);
      expect(result.metrics.coverageAccuracy).toBe(1);
      expect(result.metrics.warmIncrementalMilliseconds?.samples).toBe(25);
      expect(
        EffectOption.getOrUndefined(
          EffectArray.findFirst(result.queries, query => query.id === 'relocated-symbol-locator'),
        ),
      ).toMatchObject({
        rankedUris: [
          'threadnote://user/code-memory-bench/memories/durable/projects/threadnote/relocated-symbol-locator-gold.md',
        ],
        recallAt3: 1,
      });
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects an unreviewed fixture mutation before executing runtime scenarios', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parsed = parseCodeMemoryLinkBenchFixtureV1(
        JSON.parse(yield* fs.readFileString(yield* path.fromFileUrl(FIXTURE))),
      );
      const fixture = {
        ...parsed,
        queries: EffectArray.map(parsed.queries, (query, index) =>
          index === 0 ? {...query, task: `${query.task} unreviewed`} : query,
        ),
      };

      const exit = yield* Effect.exit(evaluateCodeMemoryLinkBenchRuntime(fixture));
      expect(String(exit)).toContain('is not the approved');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});
