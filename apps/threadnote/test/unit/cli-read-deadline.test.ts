import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Console, Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {RecallEmbeddingWakePort} from '@threadnote/recall/background/demand';
import {RecallReadyReadBoundary, RecallReadyReadBoundaryError} from '@threadnote/recall/read_boundary';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {cliEffect} from '@threadnote/threadnote/threadnote';
import {provideTestLayer} from '../helpers/effect-layer.js';

describe('CLI read deadline diagnostics', () => {
  effectIt.effect('prints a safe actionable error and exits 1 when the baseline read exhausts its budget', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-cli-deadline-'});
      yield* fs.writeFileString(path.join(home, 'seed-manifest.yaml'), 'version: 1\nprojects: []\n');
      const errors: string[] = [];
      let exitCode = 0;
      let reads = 0;
      yield* captureConsole(
        Console.consoleWith(parent =>
          cliEffect([
            '--home',
            home,
            'recall',
            '--no-infer-scope',
            '--project',
            'threadnote',
            '--limit',
            '3',
            '--query',
            'private-fixture-query',
          ]).pipe(
            Effect.provideService(Console.Console, {
              ...parent,
              error: (...args: readonly unknown[]) =>
                void errors.push(EffectArray.join(EffectArray.map(args, String), ' ')),
            }),
            Effect.provideService(
              SystemInfo,
              SystemInfo.of({
                ...system,
                environment: () => ({
                  THREADNOTE_HOME: home,
                  THREADNOTE_USER: 'test',
                  THREADNOTE_ACCOUNT: 'local',
                  NO_COLOR: '1',
                }),
                setExitCode: code => {
                  exitCode = code;
                },
              }),
            ),
            Effect.provideService(RecallEmbeddingWakePort, () => Effect.void),
            Effect.provideService(RecallReadyReadBoundary, {
              read: request => {
                reads++;
                expect(request.operation).toBe('sections');
                if (request.operation === 'sections') expect(request.options.mode).toBe('baseline');
                return Effect.fail(RecallReadyReadBoundaryError.make({reason: 'budget-exhausted'}));
              },
            }),
          ),
        ),
      );
      expect(reads).toBe(1);
      expect(exitCode).toBe(1);
      expect(errors).toEqual(['The read time budget was exhausted. Retry the read shortly.']);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});
