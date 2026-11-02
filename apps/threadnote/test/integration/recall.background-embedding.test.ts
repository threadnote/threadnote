import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, Exit, FileSystem, Path, Predicate, String as EffectString} from 'effect';
import {TestClock} from 'effect/testing';
import {expect} from 'vitest';
import {makeBackgroundInferenceAdmission} from '@threadnote/inference/background/admission';
import {
  readRecallEmbeddingDemand,
  readRecallEmbeddingScope,
  requestRecallEmbeddings,
} from '@threadnote/recall/background/demand';
import {loadRecallIndexData, recallIndexStatus} from '@threadnote/recall/index';
import {vectorIndexGenerationReadiness} from '@threadnote/recall/vector-index';
import {SystemInfo} from '@threadnote/platform/system';
import {fixtureLayer, lanes, manifest, seed} from '../fixtures/code-graph-embedding-worker-child.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  recallEmbeddingWorkerControlState,
  recallEmbeddingWorkerPaths,
} from '../../src/recall/embedding_worker_process.js';
import {codeGraphEmbeddingWorkerReceiptPath} from '@threadnote/graph/layout';

const recallChild = new URL('../fixtures/recall-embedding-worker-child.ts', import.meta.url).pathname;
const graphChild = new URL('../fixtures/code-graph-embedding-worker-child.ts', import.meta.url).pathname;
const records = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(home + '/events.jsonl').pipe(Effect.orElseSucceed(() => ''));
    return EffectArray.map(EffectArray.filter(EffectString.split('\n')(EffectString.trim(text)), Boolean), line => {
      const value: unknown = JSON.parse(line);
      if (!Predicate.isObject(value) || typeof value.event !== 'string' || typeof value.pid !== 'number')
        throw new Error('Malformed owned fixture event.');
      return value;
    });
  });
const until = <R>(condition: Effect.Effect<boolean, unknown, R>, label: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 600; attempt++) {
      if (yield* condition) return;
      yield* Effect.sleep(25);
    }
    return yield* Effect.die(new Error('Recall fixture did not reach ' + label));
  });
const producer = (filename: string, home: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      Bun.spawn({cmd: [process.execPath, filename, '--wake', '--home', home], stdout: 'pipe', stderr: 'pipe'}),
    ),
    child =>
      Effect.promise(async () => ({
        code: await child.exited,
        output: await new Response(child.stdout).text(),
        error: await new Response(child.stderr).text(),
      })),
    child =>
      Effect.sync(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }),
  );

effectIt.effect(
  'separate home workers defer behind foreground, share native capacity and survive producer exit',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-paired-idle-workers-'});
      const receiptPaths = [
        codeGraphEmbeddingWorkerReceiptPath(path, home),
        recallEmbeddingWorkerPaths(path, home).receiptPath,
      ];
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const filename of receiptPaths) {
            const text = yield* fs.readFileString(filename).pipe(Effect.orElseSucceed(() => ''));
            if (!text) continue;
            const owner = JSON.parse(text);
            if (owner.processId === process.pid || typeof owner.processId !== 'number') continue;
            if ((yield* system.processStartIdentity(owner.processId)) !== owner.processStartIdentity) continue;
            yield* Effect.sync(() => {
              try {
                process.kill(owner.processId, 'SIGKILL');
              } catch {
                /* Already exited. */
              }
            });
          }
        }),
      );
      yield* seed(home, 2);
      const resource = path.join(home, 'data/local/resources/repos/threadnote/document.md');
      yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
      yield* fs.writeFileString(resource, 'Synthetic shared-home recall source.');
      const scopes = EffectArray.map(['one', 'two'], user => ({account: 'local', agentContextHome: home, user}));
      for (const scope of scopes) yield* requestRecallEmbeddings(scope);
      for (const filename of yield* fs.readDirectory(path.join(home, 'recall/embedding-demand-v1')))
        if (EffectString.endsWith('.json')(filename))
          expect(yield* readRecallEmbeddingScope(home, filename)).toBeDefined();
      const admission = yield* makeBackgroundInferenceAdmission;
      yield* admission.withForeground(
        home,
        Effect.gen(function* () {
          const hosts = yield* Effect.all([producer(recallChild, home), producer(graphChild, home)], {concurrency: 2});
          for (const host of hosts) {
            expect(host.code).toBe(0);
            expect(host.error).toBe('');
          }
          yield* until(
            records(home).pipe(Effect.map(rows => EffectArray.some(rows, row => row.event === 'worker-ready'))),
            'graph owner',
          );
          yield* until(
            recallEmbeddingWorkerControlState(home).pipe(Effect.map(value => value.state === 'active')),
            'recall owner',
          );
          yield* Effect.sleep(600);
          expect(
            EffectArray.some(
              yield* records(home),
              row => row.event === 'model-spawn' || row.event === 'inference' || row.event === 'claimed',
            ),
          ).toBe(false);
          for (const scope of scopes) {
            expect((yield* recallIndexStatus(scope, false)).ready).toBe(false);
            expect((yield* readRecallEmbeddingDemand(scope))?.desired).toBeDefined();
          }
        }),
      );
      const convergence = yield* until(
        Effect.gen(function* () {
          for (const scope of scopes) if ((yield* readRecallEmbeddingDemand(scope))?.desired) return false;
          return (yield* lanes(home))[0]?.state === 'ready';
        }),
        'both domains current after their producers exited',
      ).pipe(Effect.exit);
      if (Exit.isFailure(convergence)) {
        const demand = yield* Effect.forEach(scopes, readRecallEmbeddingDemand);
        const diagnostics = JSON.stringify({demand, graph: yield* lanes(home), records: yield* records(home)});
        yield* Effect.sync(() => process.stderr.write(diagnostics + '\n'));
        return yield* Effect.failCause(convergence.cause);
      }
      const observed = yield* records(home);
      const calls = EffectArray.filter(observed, row => row.event === 'inference');
      expect(calls).toHaveLength(3);
      expect(EffectArray.every(calls, row => row.inputs === 1 && row.pool === 1)).toBe(true);
      let active = 0;
      for (const row of observed) {
        if (row.event === 'inference') {
          active++;
          expect(active).toBe(1);
        }
        if (row.event === 'inference-finished') active--;
      }
      expect(active).toBe(0);
      for (const scope of scopes) {
        const lexical = yield* loadRecallIndexData(scope, {includeInactive: false});
        expect(yield* vectorIndexGenerationReadiness(home, manifest, lexical.generation)).toBe('current');
      }
      yield* until(
        Effect.gen(function* () {
          for (const filename of receiptPaths) if (yield* fs.exists(filename)) return false;
          return true;
        }),
        'normal worker exits',
      );
      yield* fs.writeFileString(resource, 'A later source event after all original producers and workers exited.');
      yield* loadRecallIndexData(scopes[0], {forceRefresh: true, includeInactive: false});
      yield* requestRecallEmbeddings(scopes[0]);
      expect((yield* producer(recallChild, home)).code).toBe(0);
      yield* until(
        readRecallEmbeddingDemand(scopes[0]).pipe(Effect.map(value => value?.desired === undefined)),
        'fresh worker recovery',
      );
      expect(EffectArray.filter(yield* records(home), row => row.event === 'recall-worker-start')).toHaveLength(2);
      const lexical = yield* loadRecallIndexData(scopes[0], {includeInactive: false});
      expect(lexical.candidates[0]?.text).toContain('A later source event');
      expect(yield* vectorIndexGenerationReadiness(home, manifest, lexical.generation)).toBe('current');
    }).pipe(provideTestLayer(fixtureLayer), TestClock.withLive),
  30_000,
);
