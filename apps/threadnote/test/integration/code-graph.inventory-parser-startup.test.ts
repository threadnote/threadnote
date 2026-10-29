import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it} from '@effect/vitest';
import {Deferred, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {vi} from 'vitest';
import {inventoryRepository} from '@threadnote/graph/inventory';
import {CODE_GRAPH_CAT_FILE_BATCH_BYTES} from '@threadnote/graph/inventory/batching';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';

import {provideTestLayer} from '../helpers/effect-layer.js';

const testLayer = TestCommandExecutorLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, TestSystemInfoLayer)),
);

describe('inventory parser preparation', () => {
  it.effect('prepares once alongside the first read without accumulating later batch read time', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const command = yield* CommandExecutor;
      const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-inventory-parser-startup-'});
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
      yield* fs.writeFileString(path.join(root, '000-large.ts'), 'a'.repeat(CODE_GRAPH_CAT_FILE_BATCH_BYTES));
      for (let index = 0; index < 4; index += 1) {
        yield* fs.writeFileString(path.join(root, `100-source-${index}.ts`), `export const source${index} = true;\n`);
      }
      yield* runCommandEffect('git', ['init', '-q', root]);
      yield* runCommandEffect('git', ['-C', root, 'add', '.']);
      yield* runCommandEffect('git', [
        '-C',
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'fixture',
      ]);
      const identity = yield* resolveRepositoryIdentity(root);
      const events: string[] = [];
      const parserStarted = yield* Deferred.make<void>();
      const parserMayFinish = yield* Deferred.make<void>();
      let readBatches = 0;
      let parserFileCount = 0;
      let milliseconds = 0;
      let readingMilliseconds = -1;
      yield* Effect.acquireUseRelease(
        Effect.sync(() => vi.spyOn(performance, 'now').mockImplementation(() => milliseconds)),
        () =>
          inventoryRepository(identity, {
            onContentBatch: (_files, context) =>
              Effect.sync(() => {
                events.push('extract');
                readingMilliseconds = context.readingMilliseconds;
              }),
            onParserWorkPlanned: fileCount =>
              Effect.sync(() => {
                parserFileCount = fileCount;
                events.push('prepare-start');
                milliseconds += 1_000;
              }).pipe(
                Effect.andThen(Deferred.succeed(parserStarted, undefined)),
                Effect.andThen(Deferred.await(parserMayFinish)),
                Effect.andThen(
                  Effect.sync(() => {
                    events.push('prepare-end');
                  }),
                ),
              ),
          }).pipe(
            Effect.provideService(CommandExecutor, {
              ...command,
              executeBytes: (executable, args, options) =>
                command.executeBytes!(executable, args, options).pipe(
                  Effect.tap(() =>
                    Effect.gen(function* () {
                      if (args.includes('cat-file') && args.includes('--batch')) {
                        readBatches += 1;
                        events.push('read');
                        milliseconds += 7;
                        if (readBatches === 1) {
                          yield* Deferred.await(parserStarted);
                          yield* Deferred.succeed(parserMayFinish, undefined);
                        }
                      }
                    }),
                  ),
                ),
            }),
          ),
        spy => Effect.sync(() => spy.mockRestore()),
      );
      expect(events).toEqual(['prepare-start', 'read', 'prepare-end', 'extract', 'read', 'extract']);
      expect(parserFileCount).toBe(5);
      expect(readingMilliseconds).toBe(7);
    }).pipe(provideTestLayer(testLayer), TestClock.withLive),
  );
});
