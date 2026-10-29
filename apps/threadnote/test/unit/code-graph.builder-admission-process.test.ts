import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {codeGraphBuilderAdmissionSlotPath} from '@threadnote/graph/layout';

import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const testLayer = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));

describe('builder admission process boundary', () => {
  effectIt.effect(
    'admits an unrelated checkout next after two same-checkout owners, recovering killed slot metadata',
    () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-builder-process-'});
          const moduleUrl = new URL('../../../../packages/graph/src/builder/admission.ts', import.meta.url).href;
          const systemLayerUrl = new URL('../helpers/system-layer.ts', import.meta.url).href;
          const start = (name: string, checkoutId: string) =>
            Effect.acquireRelease(
              Effect.sync(() =>
                Bun.spawn({
                  cmd: [
                    process.execPath,
                    '--eval',
                    `
            import {Effect, FileSystem, Layer} from 'effect';
            import * as BunServices from '@effect/platform-bun/BunServices';
            import * as BunRuntime from '@effect/platform-bun/BunRuntime';
            import {withCodeGraphBuilderAdmission} from ${JSON.stringify(moduleUrl)};
            import {TestSystemInfoLayer} from ${JSON.stringify(systemLayerUrl)};
            BunRuntime.runMain(Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              yield* withCodeGraphBuilderAdmission({
                admissionClass: 'current-required',
                identity: {checkoutId: ${JSON.stringify(checkoutId)}, worktreeId: ${JSON.stringify(Effect2.pipe('e', EffectString.repeat(64)))}, requestKey: ${JSON.stringify(Effect2.pipe('f', EffectString.repeat(64)))}},
                onWaiting: fs.writeFileString(${JSON.stringify(path.join(home, `${name}.queued`))}, '').pipe(Effect.orDie),
                threadnoteHome: ${JSON.stringify(home)},
              }, fs.writeFileString(${JSON.stringify(path.join(home, `${name}.started`))}, '').pipe(Effect.andThen(Effect.never)));
            }).pipe(Effect.provide(Layer.merge(TestSystemInfoLayer, BunServices.layer))));
          `,
                  ],
                  stderr: 'inherit',
                  stdout: 'ignore',
                }),
              ),
              child =>
                Effect.sync(() => {
                  if (child.exitCode === null) child.kill('SIGKILL');
                }).pipe(Effect.andThen(Effect.promise(() => child.exited)), Effect.asVoid),
            );
          const wait = (name: string) =>
            Effect.gen(function* () {
              while (!(yield* fs.exists(path.join(home, name)))) yield* Effect.sleep(10);
            }).pipe(Effect.timeout('10 seconds'));

          const first = yield* start('first', Effect2.pipe('a', EffectString.repeat(64)));
          yield* wait('first.started');
          yield* start('second', Effect2.pipe('a', EffectString.repeat(64)));
          yield* wait('second.started');
          yield* start('same', Effect2.pipe('a', EffectString.repeat(64)));
          yield* wait('same.queued');
          yield* start('unrelated', Effect2.pipe('b', EffectString.repeat(64)));
          yield* wait('unrelated.queued');
          expect(yield* fs.exists(path.join(home, 'unrelated.started'))).toBe(false);
          first.kill('SIGKILL');
          yield* Effect.promise(() => first.exited);
          yield* wait('unrelated.started');
          expect(yield* fs.exists(path.join(home, 'same.started'))).toBe(false);
          const ownership = JSON.parse(
            yield* fs.readFileString(`${codeGraphBuilderAdmissionSlotPath(path, home, 0)}.owner.json`),
          );
          expect(ownership.checkoutId).toBe(Effect2.pipe('b', EffectString.repeat(64)));
          expect(ownership.processId).not.toBe(first.pid);
        }).pipe(provideTestLayer(testLayer)),
      ),
    {timeout: 30_000},
  );
});
