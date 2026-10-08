import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Result} from 'effect';
import {describe, expect} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {TestSystemInfoLayer} from '../../../../test/helpers/system-layer.js';
import {runSlackPilotProbe} from '../command.js';

const layer = Layer.merge(BunServices.layer, TestSystemInfoLayer);
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));

describe('Slack probe private-file boundary', () => {
  effectIt.effect('rejects world-readable, symlinked and malformed inputs without disclosing their contents', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-slack-test-'});
      const file = path.join(directory, 'input.json');
      const link = path.join(directory, 'link.json');
      yield* fs.writeFileString(file, 'private malformed input', {mode: 0o600});
      if (system.platform !== 'win32') yield* fs.symlink(file, link);
      for (const selected of [file, ...(system.platform === 'win32' ? [] : [link]), 'relative.json']) {
        const result = yield* runSlackPilotProbe(selected).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) expect(result.failure.code).toBe('invalid-input');
      }
      yield* fs.chmod(file, 0o644);
      const result = yield* runSlackPilotProbe(file).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.code).toBe('invalid-input');
    }).pipe(provide),
  );

  effectIt.effect('reports a missing credential before making a provider request', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const system = yield* SystemInfo;
      if (system.platform === 'win32' || system.userId === undefined) return;
      const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-slack-input-'});
      const file = path.join(directory, 'input.json');
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          project: 'threadnote',
          teamId: 'T000001',
          userId: 'U000001',
          channelIds: ['C000001'],
          question: 'Why live recall?',
          keywords: 'live recall',
        }),
        {mode: 0o600},
      );
      const result = yield* runSlackPilotProbe(file).pipe(
        Effect.provideService(SystemInfo, {...system, environment: () => ({})}),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.code).toBe('missing-credential');
    }).pipe(provide),
  );
});
