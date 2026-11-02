import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, FileSystem, String as EffectString} from 'effect';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {BackgroundInferenceAdmission} from '@threadnote/inference/background/admission';
import {SystemInfo} from '@threadnote/platform/system';
import {runHandoffSaveWorker} from '../../src/memory/handoff_save_operation.js';

Object.assign(globalThis, {
  THREADNOTE_RUNTIME_SOURCE_IDENTITY: {
    version: 1,
    commit: EffectString.repeat(40)('a'),
    tree: EffectString.repeat(40)('b'),
    bun: Bun.version,
    target: 'fixture',
  },
});
const program = Effect.gen(function* () {
  const system = yield* SystemInfo;
  const home = system.environment().THREADNOTE_HANDOFF_SAVE_HOME;
  const hold = system.environment().THREADNOTE_TEST_HANDOFF_HOLD_STAGE;
  if (!home) return;
  const fs = yield* FileSystem.FileSystem;
  const held = (stage: string) =>
    fs.writeFileString(home + '/fixture-held-stage', stage).pipe(Effect.andThen(Effect.never));
  const controlled = FileSystem.FileSystem.of({
    ...fs,
    writeFileString: (file, content, options) => {
      if (hold === 'uri-lock' && EffectString.includes('/threadnote/memory-locks/')(file)) return held('uri-lock');
      if (
        EffectString.includes('/memory-operations/handoff-save-v1/')(file) &&
        /(?:^|\/)[a-f0-9-]{36}\.json\.[a-f0-9-]{36}\.tmp$/u.test(EffectString.replaceAll('\\', '/')(file))
      ) {
        const receipt: unknown = JSON.parse(content);
        if (typeof receipt === 'object' && receipt !== null && 'stage' in receipt && 'sequence' in receipt) {
          const stage = receipt.stage;
          if (
            (hold === 'journal' && stage === 'preparing' && receipt.sequence === 0) ||
            (hold === 'metadata' && stage === 'preparing' && receipt.sequence !== 0) ||
            (hold === stage && stage !== 'preparing')
          )
            return held(String(hold));
        }
      }
      return fs.writeFileString(file, content, options);
    },
  });
  yield* (yield* BackgroundInferenceAdmission).withForeground(
    home,
    runHandoffSaveWorker().pipe(Effect.provideService(FileSystem.FileSystem, controlled)),
    {existingHomeOnly: true},
  );
});
// oxlint-disable-next-line effecttsgo/strict-effect-provide -- This private test executable is the application entry point.
BunRuntime.runMain(program.pipe(Effect.provide(ApplicationLayer)), {disableErrorReporting: false});
