import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from './system-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from './effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer} from 'effect';
import {runCodeGraphOrdinaryVectorMaintenanceUnit} from '@threadnote/graph/vector/maintenance';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const [threadnoteHome, checkoutId, markerPath] = process.argv.slice(2);
const validPath = (value: string | undefined) =>
  value !== undefined && value.length > 0 && !Effect2.pipe(value, EffectString.includes('\0'));
if (!validPath(threadnoteHome) || !validPath(markerPath) || !/^[0-9a-f]{64}$/u.test(checkoutId ?? '')) {
  process.stderr.write('invalid vector-retirement child arguments\n');
  process.exit(2);
}

const childLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const observations: string[] = [];
  for (let unit = 0; unit < 16; unit += 1) {
    const startedAt = performance.now();
    const result = yield* runCodeGraphOrdinaryVectorMaintenanceUnit(
      {checkoutId: checkoutId, threadnoteHome: threadnoteHome},
      {
        afterModelCommitBeforeFinalCursorCas: () =>
          Effect.gen(function* () {
            const marker = JSON.stringify({event: 'vector-page-committed', processId: process.pid});
            yield* fs.writeFileString(markerPath, marker, {flag: 'wx', mode: 0o600});
            process.stdout.write(`${marker}\n`);
            // Retain a real event-loop handle until the parent performs SIGKILL.
            for (;;) yield* Effect.sleep(60_000);
          }),
        availableDiskBytes: () => Effect.succeed(Number.MAX_SAFE_INTEGER),
        deadlineMonotonicMilliseconds: startedAt + 250,
        // The parent kills this helper only after the durable commit barrier.
        // Keep that crash-recovery interlock independent of hosted-runner load;
        // live deadline behavior belongs to the vector load suite.
        monotonicMilliseconds: () => startedAt,
        reservationMode: 'nonblocking-one-attempt',
      },
    );
    observations.push(result.state === 'deferred' ? `${result.state}:${result.blockedCode}` : result.state);
    if (result.state === 'complete') break;
  }
  return yield* TestError.make({
    message: `Vector child completed without a database commit barrier: ${EffectArray.join(observations, ',')}`,
  });
}).pipe(provideTestLayer(childLayer));

Effect.runPromise(program).catch(cause => {
  process.stderr.write(
    `vector-retirement child failed: ${cause instanceof Error ? Effect2.pipe(cause.message, EffectString.slice(0, 512)) : 'unknown'}\n`,
  );
  process.exitCode = 1;
});
