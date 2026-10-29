import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdtemp, readFile, readdir, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {fileURLToPath} from '@threadnote/testing/node-url';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Clock, Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {parseCodeGraphBenchmarkRunCheckpoint, startExternalSampler} from '../../../../scripts/benchmark-code-graph.js';
import {parseCodeGraphBenchmarkSamplerCheckpoint} from '../../../../scripts/code-graph-benchmark-sampler.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('production-large benchmark failure telemetry', () => {
  it('accepts only structured run lifecycle checkpoints', () => {
    expect(
      parseCodeGraphBenchmarkRunCheckpoint({
        phase: 'incremental-index',
        state: 'running',
        updatedAt: '2026-07-31T12:00:00.000Z',
        version: 1,
      }),
    ).toMatchObject({phase: 'incremental-index', state: 'running'});

    for (const malformed of [
      undefined,
      {},
      {phase: '../escape', state: 'running', updatedAt: '2026-07-31T12:00:00.000Z', version: 1},
      {phase: 'cold-index', state: 'unknown', updatedAt: '2026-07-31T12:00:00.000Z', version: 1},
      {phase: 'cold-index', state: 'running', updatedAt: 'not-a-date', version: 1},
      {phase: 'cold-index', state: 'running', updatedAt: '2026-07-31T12:00:00.000Z', version: 2},
    ]) {
      expect(() => parseCodeGraphBenchmarkRunCheckpoint(malformed)).toThrow('Benchmark run checkpoint');
    }
  });

  it.skipIf(process.platform === 'win32')(
    'retains a parseable upload checkpoint when the benchmark parent is killed after sampler readiness',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'threadnote-benchmark-parent-crash-'));
      const artifactRoot = join(root, 'artifacts');
      const checkpoint = join(artifactRoot, 'code-graph-production-large-n1-test.json.bootstrap.sampler.json');
      const ready = join(root, 'parent.ready');
      const parent = Bun.spawn({
        cmd: [
          process.execPath,
          fileURLToPath(new URL('../helpers/code-graph-benchmark-parent.ts', import.meta.url)),
          root,
          checkpoint,
          ready,
        ],
        stderr: 'pipe',
        stdout: 'ignore',
      });
      try {
        await waitFor(() => Bun.file(ready).exists(), 10_000);
        expect(parseCodeGraphBenchmarkSamplerCheckpoint(JSON.parse(await readFile(checkpoint, 'utf8')))).toMatchObject({
          state: 'running',
        });

        parent.kill(9);
        expect(await parent.exited).not.toBe(0);
        const terminal = await waitFor(async () => {
          try {
            const parsed = parseCodeGraphBenchmarkSamplerCheckpoint(JSON.parse(await readFile(checkpoint, 'utf8')));
            return parsed.state === 'parent-exited' ? parsed : undefined;
          } catch {
            return undefined;
          }
        }, 10_000);

        expect(terminal).toMatchObject({state: 'parent-exited'});
        expect(
          EffectArray.filter(await readdir(artifactRoot), name =>
            Effect2.pipe(name, EffectString.startsWith('code-graph-production-large-n1-')),
          ),
        ).toEqual(['code-graph-production-large-n1-test.json.bootstrap.sampler.json']);
      } finally {
        if (parent.exitCode === null) parent.kill(9);
        await parent.exited.catch(() => undefined);
        await rm(root, {force: true, recursive: true});
      }
    },
    20_000,
  );

  effectIt.effect('terminates within a bound and preserves the last checkpoint when stop signaling fails', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-benchmark-stop-failure-'});
        const checkpoint = path.join(
          root,
          'artifacts',
          'code-graph-production-large-n1-stop-failure.bootstrap.sampler.json',
        );
        const failingFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          writeFileString: (file, data, options) =>
            Effect2.pipe(file, EffectString.endsWith('.stop'))
              ? Effect.die(TestError.make({message: 'injected stop-write failure'}))
              : fileSystem.writeFileString(file, data, options),
        });
        const sampler = yield* startExternalSampler(
          failingFileSystem,
          path,
          path.join(root, 'sampler'),
          path.join(root, 'sqlite-temp'),
          path.join(root, 'not-created.sqlite'),
          checkpoint,
          'bootstrap',
        );
        const before = parseCodeGraphBenchmarkSamplerCheckpoint(
          JSON.parse(yield* fileSystem.readFileString(checkpoint)),
        );
        const startedAt = yield* Clock.currentTimeMillis;
        const exit = yield* Effect.exit(sampler.stop());
        const elapsedMilliseconds = (yield* Clock.currentTimeMillis) - startedAt;
        const after = parseCodeGraphBenchmarkSamplerCheckpoint(
          JSON.parse(yield* fileSystem.readFileString(checkpoint)),
        );
        yield* Effect.promise(() => Bun.sleep(100));
        const stable = parseCodeGraphBenchmarkSamplerCheckpoint(
          JSON.parse(yield* fileSystem.readFileString(checkpoint)),
        );

        expect(before.state).toBe('running');
        expect(exit._tag).toBe('Failure');
        expect(elapsedMilliseconds).toBeLessThan(3_000);
        expect(stable.sampler.samples).toBe(after.sampler.samples);
      }).pipe(provideTestLayer(BunServices.layer), TestClock.withLive),
    ),
  );
});

async function waitFor<A>(observe: () => A | Promise<A>, timeoutMilliseconds: number): Promise<NonNullable<A>> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    const value = await observe();
    if (value !== undefined && value !== false && value !== null) return value;
    if (Date.now() >= deadline) throw TestError.make({message: `Timed out after ${timeoutMilliseconds} ms.`});
    await Bun.sleep(20);
  }
}
