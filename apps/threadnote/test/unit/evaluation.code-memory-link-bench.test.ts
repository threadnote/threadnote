import {Array as EffectArray, Option as EffectOption} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Cause, Console, Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock, TestConsole} from 'effect/testing';
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {runtimeCurrentPlatform} from '@threadnote/platform/system';
import {
  evaluateCodeMemoryLinkBenchRuntime,
  makeCodeMemoryLinkBenchDiagnosticRecorder,
  type CodeMemoryLinkBenchDiagnostic,
} from '@threadnote/threadnote/evaluation/code-memory-link-bench';
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

/** Test-only output boundary: no overwrite, bounded JSON, private mode, durable readback. */
const retainBenchmarkDiagnosticArtifact = (output: string, payload: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!path.isAbsolute(output)) throw new Error('Diagnostic output must be an explicitly supplied absolute path');
    const serialized = JSON.stringify(payload) + '\n';
    if (new TextEncoder().encode(serialized).byteLength > 65536) throw new Error('Diagnostic output exceeds64KiB');
    yield* fs.writeFileString(output, serialized, {flag: 'wx', mode: 0o600});
    const retained = yield* fs.readFileString(output);
    expect(retained).toBe(serialized);
  });

// Explicit opt-in only: an instrumented observation is not a qualification result.
effectIt.effect.runIf(Bun.env.THREADNOTE_CODE_MEMORY_BENCH_DIAGNOSTIC === '1')(
  'emits one bounded instrumented benchmark observation',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const output = Bun.env.THREADNOTE_CODE_MEMORY_BENCH_DIAGNOSTIC_OUTPUT;
      if (!output || !path.isAbsolute(output)) throw new Error('Explicit absolute diagnostic output is required');
      if (yield* fs.exists(output)) throw new Error('Diagnostic output already exists; refusing benchmark execution');
      if ((yield* fs.stat(path.dirname(output))).type !== 'Directory')
        throw new Error('Diagnostic output parent must exist');
      const fixture: unknown = JSON.parse(yield* fs.readFileString(yield* path.fromFileUrl(FIXTURE)));
      const diagnostics: CodeMemoryLinkBenchDiagnostic[] = [];
      const exit = yield* Effect.exit(evaluateCodeMemoryLinkBenchRuntime(fixture, value => diagnostics.push(value)));
      yield* retainBenchmarkDiagnosticArtifact(output, {
        kind: 'instrumented-code-memory-link-observation',
        qualification: false,
        outcome: exit._tag,
        ...(exit._tag === 'Success'
          ? {fixture: exit.value.fixture, gate: exit.value.gate, metrics: exit.value.metrics}
          : {}),
        diagnostics,
      });
      if (exit._tag === 'Failure') return yield* Effect.failCause(exit.cause);
      const result = exit.value;
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].runs).toHaveLength(31);
      expect(diagnostics[0].measuredMilliseconds).toHaveLength(25);
      expect(diagnostics[0].droppedRuns).toBe(0);
      expect(result.gate).toEqual({failures: [], passed: true});
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

describe('CodeMemoryLinkBench diagnostic controls', () => {
  effectIt.effect(
    'retains synthetic diagnostics outside the observed program despite TestConsole and refuses overwrite',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* fs.makeTempDirectoryScoped({prefix: 'bench-diagnostic-emission-control-'});
        const output =
          Bun.env.THREADNOTE_CODE_MEMORY_BENCH_DIAGNOSTIC_CONTROL_OUTPUT ?? path.join(folder, 'observation.json');
        const diagnostics: CodeMemoryLinkBenchDiagnostic[] = [];
        let tick = 0;
        const recorder = makeCodeMemoryLinkBenchDiagnosticRecorder(
          value => diagnostics.push(value),
          () => tick++,
        );
        recorder.samples([3, 5]);
        const result = yield* recorder.finish(
          recorder.run(observe => observe('memoryEvidence', () => Effect.succeed({privateBody: 'excluded'}))),
        );
        expect(result).toEqual({privateBody: 'excluded'});
        yield* Console.log('captured control marker');
        expect(yield* TestConsole.logLines).toContain('captured control marker');
        const payload = {kind: 'synthetic-code-memory-link-emission-control', qualification: false, diagnostics};
        // The measured program has returned. Exercise the real file boundary separately.
        yield* retainBenchmarkDiagnosticArtifact(output, payload);
        const retained = yield* fs.readFileString(output);
        expect(JSON.parse(retained)).toEqual(payload);
        expect(retained).not.toContain('privateBody');
        // POSIX mode bits do not prove Windows DACL privacy; keep all IO/overwrite controls on both hosts.
        if (runtimeCurrentPlatform() !== 'win32') expect((yield* fs.stat(output)).mode & 0o777).toBe(0o600);
        const overwrite = yield* Effect.exit(retainBenchmarkDiagnosticArtifact(output, {replacement: true}));
        expect(overwrite._tag).toBe('Failure');
        expect(yield* fs.readFileString(output)).toBe(retained);
      }).pipe(provideTestLayer(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  );

  effectIt.effect.prop(
    'preserves generated callback values, failures, order and exactly-once execution',
    [
      Schema.Array(
        Schema.Struct({
          name: Schema.Literals(['graphEvidence', 'memoryEvidence', 'codeLinkedMemoryEvidence', 'citationValidation']),
          fails: Schema.Boolean,
        }),
      ).check(Schema.isMaxLength(16)),
    ],
    ([cases]) =>
      Effect.gen(function* () {
        const emitted: CodeMemoryLinkBenchDiagnostic[] = [];
        const calls: string[] = [];
        let time = 0;
        const recorder = makeCodeMemoryLinkBenchDiagnosticRecorder(
          value => emitted.push(value),
          () => time++,
        );
        const result = {privateBody: 'must not enter diagnostics'};
        const failure = {privatePath: '/must/not/enter/diagnostics'};
        yield* recorder.finish(
          recorder.run(observe =>
            Effect.gen(function* () {
              for (const item of cases) {
                const program = Effect.suspend(() => {
                  calls.push(item.name);
                  return item.fails ? Effect.fail(failure) : Effect.succeed(result);
                });
                if (item.fails) expect(yield* Effect.flip(observe(item.name, () => program))).toBe(failure);
                else expect(yield* observe(item.name, () => program)).toBe(result);
                expect(emitted).toEqual([]);
              }
              return result;
            }),
          ),
        );
        expect(calls).toEqual(EffectArray.map(cases, item => item.name));
        expect(emitted).toHaveLength(1);
        expect(emitted[0].outcome).toBe('success');
        expect(emitted[0].runs[0].completed).toBe(true);
        for (const name of [
          'graphEvidence',
          'memoryEvidence',
          'codeLinkedMemoryEvidence',
          'citationValidation',
        ] as const) {
          const expected = EffectArray.filter(cases, item => item.name === name);
          expect(emitted[0].runs[0].callbacks[name].calls).toBe(expected.length);
          expect(emitted[0].runs[0].callbacks[name].failures).toBe(
            EffectArray.filter(expected, item => item.fails).length,
          );
          expect(emitted[0].runs[0].callbacks[name].milliseconds).toBe(expected.length);
        }
        const serialized = JSON.stringify(emitted);
        expect(serialized).not.toContain('privateBody');
        expect(serialized).not.toContain('privatePath');
        expect(serialized).not.toContain('/must/not');
      }),
    {arbitrary: {runs: 32}},
  );

  effectIt.effect('retains the original failed outcome even when the diagnostic sink throws', () =>
    Effect.gen(function* () {
      const failure = {sentinel: 'original failure'};
      const emitted: CodeMemoryLinkBenchDiagnostic[] = [];
      let finished = false;
      const recorder = makeCodeMemoryLinkBenchDiagnosticRecorder(value => {
        expect(finished).toBe(true);
        emitted.push(value);
        throw new Error('observer failure');
      });
      const program = recorder
        .run(observe => observe('citationValidation', () => Effect.fail(failure)))
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finished = true;
            }),
          ),
        );
      expect(yield* Effect.flip(recorder.finish(program))).toBe(failure);
      expect(emitted).toHaveLength(1);
      expect(emitted[0].outcome).toBe('failure');
      expect(emitted[0].runs[0].completed).toBe(false);
      expect(emitted[0].runs[0].callbacks.citationValidation).toMatchObject({calls: 1, failures: 1});
    }),
  );

  effectIt.effect('records a synchronous callback defect without replacing it', () =>
    Effect.gen(function* () {
      const defect = new Error('private callback defect');
      const emitted: CodeMemoryLinkBenchDiagnostic[] = [];
      const recorder = makeCodeMemoryLinkBenchDiagnosticRecorder(value => emitted.push(value));
      const exit = yield* Effect.exit(
        recorder.finish(
          recorder.run(observe =>
            observe('graphEvidence', (): Effect.Effect<never> => {
              throw defect;
            }),
          ),
        ),
      );
      expect(exit._tag).toBe('Failure');
      if (exit._tag === 'Failure') expect(Cause.squash(exit.cause)).toBe(defect);
      expect(emitted[0].runs[0].callbacks.graphEvidence).toMatchObject({calls: 1, failures: 1});
      expect(JSON.stringify(emitted)).not.toContain('private callback defect');
    }),
  );

  effectIt.effect('bounds observations without suppressing additional programs or mutating sample input', () =>
    Effect.gen(function* () {
      const emitted: CodeMemoryLinkBenchDiagnostic[] = [];
      const values = Object.freeze(Array.from({length: 40}, (_, index) => index));
      const recorder = makeCodeMemoryLinkBenchDiagnosticRecorder(value => emitted.push(value));
      let calls = 0;
      recorder.samples(values);
      yield* recorder.finish(
        Effect.gen(function* () {
          for (let index = 0; index < 40; index++)
            yield* recorder.run(observe =>
              observe('memoryEvidence', () =>
                Effect.sync(() => {
                  calls++;
                }),
              ),
            );
        }),
      );
      expect(calls).toBe(40);
      expect(emitted[0].runs).toHaveLength(31);
      expect(emitted[0].droppedRuns).toBe(9);
      expect(emitted[0].measuredMilliseconds).toEqual(Array.from({length: 25}, (_, index) => index));
      expect(values).toEqual(Array.from({length: 40}, (_, index) => index));
    }),
  );
});
