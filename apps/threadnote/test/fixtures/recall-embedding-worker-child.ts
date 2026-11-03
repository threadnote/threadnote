import {Cause, Clock, Effect, Exit, Layer, String as EffectString} from 'effect';
import {
  makeBackgroundInferenceAdmission,
  BackgroundInferenceAdmission,
} from '@threadnote/inference/background/admission';
import {SystemInfo} from '@threadnote/platform/system';
import {getThreadnoteVersion} from '@threadnote/workspace/runtime-version';
import {fixtureLayer, record, spawnModel} from './code-graph-embedding-worker-child.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {isolatedLocalModelRuntimeLayer} from '../../src/effect/ai/isolated-local-model-runtime.js';
import {
  recallEmbeddingWorkerHomeProgram,
  wakeRecallEmbeddingWorker,
} from '../../src/recall/embedding_worker_process.js';
import {RECALL_EMBEDDING_WORKER_ARGUMENT, RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION} from '../../src/worker_protocol.js';

const argument = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const program = Effect.gen(function* () {
  const home = argument('--home');
  if (process.argv.includes('--wake')) {
    const result = yield* wakeRecallEmbeddingWorker(home);
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (
    !process.argv.includes(RECALL_EMBEDDING_WORKER_ARGUMENT) ||
    argument('--protocol') !== String(RECALL_EMBEDDING_WORKER_PROTOCOL_VERSION) ||
    argument('--version') !== (yield* getThreadnoteVersion())
  )
    return;
  const nonce = argument('--launch-nonce');
  if (!/^[a-f0-9-]{36}$/u.test(nonce)) return;
  record(home, {event: 'recall-worker-start'});
  const runtime = yield* Layer.build(
    isolatedLocalModelRuntimeLayer({
      spawnWorker: () => spawnModel(home),
      background: true,
      requestDeadlineMs: 1500,
      maximumRequestAttempts: 1,
      idleTimeoutMs: 0,
    }),
  );
  yield* recallEmbeddingWorkerHomeProgram(home, nonce, {
    onUnitResult: (scope, result) =>
      Effect.sync(() =>
        record(home, {
          event: 'recall-unit',
          user: scope.user,
          state: result._tag === 'Success' ? result.success.state : 'failed',
          reason:
            result._tag === 'Success' ? result.success.reason : EffectString.slice(0, 200)(String(result.failure)),
        }),
      ),
  }).pipe(Effect.provide(runtime));
});

if (import.meta.main)
  await Effect.runPromise(
    Effect.gen(function* () {
      const actual = yield* SystemInfo;
      const system = SystemInfo.of({
        ...actual,
        developmentEntrypoint: import.meta.filename,
        cpuTimes: Clock.currentTimeMillis.pipe(
          Effect.map(now => ({
            logicalCpus: 4,
            totalMilliseconds: now * 4,
            idleMilliseconds: now * 4,
          })),
        ),
      });
      const admission = yield* makeBackgroundInferenceAdmission.pipe(Effect.provideService(SystemInfo, system));
      return yield* program.pipe(
        Effect.onExit(exit =>
          Effect.sync(() => {
            if (!process.argv.includes('--wake'))
              record(argument('--home'), {
                event: 'recall-worker-exit',
                success: Exit.isSuccess(exit),
                ...(Exit.isFailure(exit) ? {failure: EffectString.slice(0, 1200)(Cause.pretty(exit.cause))} : {}),
              });
          }),
        ),
        Effect.provideService(SystemInfo, system),
        Effect.provideService(BackgroundInferenceAdmission, admission),
      );
    }).pipe(provideTestLayer(fixtureLayer)),
  );
