import {TestSystemInfoLayer} from './system-layer.js';
import {provideTestLayer} from './effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Clock, Effect, FileSystem, Layer, Path} from 'effect';
import {withCodeGraphDiskReservation} from '@threadnote/graph/disk/reservation';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const [
  ledgerRoot,
  ledgerLockPath,
  availableText,
  holdText,
  filesystemKey,
  mode = 'normal',
  iterationsText = '1',
  barrierReadyRoot = '-',
  barrierReleasePath = '-',
  barrierChildId = '-',
] = process.argv.slice(2);
const barrierDisabled = barrierReadyRoot === '-' && barrierReleasePath === '-' && barrierChildId === '-';
if (
  !ledgerRoot ||
  !ledgerLockPath ||
  !/^[0-9]+$/.test(availableText ?? '') ||
  !/^[0-9]+$/.test(holdText ?? '') ||
  !/^[0-9a-f]{64}$/.test(filesystemKey ?? '') ||
  (mode !== 'normal' && mode !== 'forever') ||
  !/^[1-9][0-9]*$/.test(iterationsText) ||
  (!barrierDisabled &&
    (!barrierReadyRoot ||
      Effect2.pipe(barrierReadyRoot, EffectString.includes('\0')) ||
      !barrierReleasePath ||
      Effect2.pipe(barrierReleasePath, EffectString.includes('\0')) ||
      !/^[0-9]+$/.test(barrierChildId)))
) {
  process.stderr.write('invalid disk-reservation child arguments\n');
  process.exit(2);
}

const availableBytes = Number(availableText);
const holdMilliseconds = Number(holdText);
const iterations = Number(iterationsText);
const layer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);
const options = {
  boundary: {finalFactBytes: 1, operation: 'stage persistent code graph facts' as const, rowCount: 1},
  ledgerLockPath,
  ledgerRoot,
  maintenance: Effect.void,
  observe: Effect.succeed({
    demand: {
      calibrationIdentity: 'child-load-v1',
      mainHighWaterBytes: 10,
      recoveryFloorBytes: 10,
      state: 'measured' as const,
      transientFilesystem: 'durable' as const,
      transientHighWaterBytes: 10,
    },
    durableAvailableBytes: availableBytes,
    durableFilesystemKey: filesystemKey,
    freelistBytes: 0,
    temporaryAvailableBytes: availableBytes,
    temporaryFilesystemKey: filesystemKey,
  }),
  onWaiting: Effect.sync(() => {
    process.stdout.write(`${JSON.stringify({event: 'waiting', processId: process.pid})}\n`);
  }),
};
const awaitFirstClaimBarrier = barrierDisabled
  ? Effect.void
  : Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(barrierReadyRoot, `${barrierChildId}.ready`), 'ready', {
        flag: 'wx',
        mode: 0o600,
      });
      while (!(yield* fs.exists(barrierReleasePath))) yield* Effect.sleep(5);
    });
const program = awaitFirstClaimBarrier.pipe(
  Effect.andThen(
    Effect.forEach(
      Array.from({length: iterations}, (_, iteration) => iteration),
      iteration => {
        const attemptStartedAt = Date.now();
        return withCodeGraphDiskReservation(
          options,
          Effect.gen(function* () {
            process.stdout.write(
              `${JSON.stringify({acquisitionMilliseconds: (yield* Clock.currentTimeMillis) - attemptStartedAt, at: yield* Clock.currentTimeMillis, event: 'acquired', iteration, mode, processId: process.pid})}\n`,
            );
            if (mode === 'forever') {
              while (true) yield* Effect.sleep(60_000);
            }
            yield* Effect.sleep(holdMilliseconds);
            process.stdout.write(
              `${JSON.stringify({at: yield* Clock.currentTimeMillis, event: 'leaving', iteration, processId: process.pid})}\n`,
            );
          }),
        );
      },
      {discard: true},
    ),
  ),
  Effect.andThen(
    Clock.currentTimeMillis.pipe(
      Effect.map(at => {
        process.stdout.write(`${JSON.stringify({at, event: 'complete', processId: process.pid})}\n`);
      }),
    ),
  ),
  provideTestLayer(layer),
);

Effect.runPromise(program).catch(cause => {
  process.stderr.write(`disk-reservation child failed: ${cause instanceof Error ? cause.name : 'unknown'}\n`);
  process.exitCode = 1;
});
