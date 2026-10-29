import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'fast-check';
import {codeGraphMaintenanceIntentPath} from '@threadnote/graph/layout';
import {codeGraphMaintenanceIntentActive} from '@threadnote/graph/maintenance/gate';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const replacementToken = FC.stringMatching(/^[A-Za-z0-9_-]{1,80}$/).map(value => `replacement:${value}`);

describe('code graph maintenance-gate properties', () => {
  fcEffectProp(
    it,
    'never removes a marker that replaced the stale owner while process identity was inspected',
    {replacementToken},
    ({replacementToken}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-maintenance-gate-property-'});
          const intent = codeGraphMaintenanceIntentPath(path, home);
          const staleToken = JSON.stringify({
            processId: 42,
            processStartIdentity: 'original-process-instance',
            token: 'stale-owner-token',
          });
          yield* fs.makeDirectory(path.dirname(intent), {recursive: true});
          yield* fs.writeFileString(intent, `${staleToken}\n`, {mode: 0o600});

          const active = yield* codeGraphMaintenanceIntentActive(home).pipe(
            Effect.provideService(
              SystemInfo,
              SystemInfo.of({
                ...system,
                isProcessRunning: processId => processId === 42,
                processStartIdentity: () =>
                  fs
                    .writeFileString(intent, `${replacementToken}\n`, {flag: 'w', mode: 0o600})
                    .pipe(Effect.orDie, Effect.as('replacement-process-instance')),
              }),
            ),
          );

          expect(active).toBe(false);
          expect(Effect2.pipe(yield* fs.readFileString(intent), EffectString.trim)).toBe(replacementToken);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 50}},
  );
});
