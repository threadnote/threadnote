import {CommandExecutor} from '@threadnote/platform/command';
import {assembleNativeInference} from '../../../../scripts/assemble-native-inference.js';
import {describe, expect} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path, String as EffectString} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {
  NATIVE_INFERENCE_LLAMA_COMMIT,
  publishNativeInferenceOverlay,
  stageNativeInferenceOverlay,
  verifyNativeInferenceOverlay,
} from '../../../../scripts/native-inference-payload.js';

describe('native inference overlay filesystem boundary', () => {
  effectIt.layer(BunServices.layer)(it => {
    it.effect('rejects cross-platform inference assembly before invoking build tools', () =>
      Effect.gen(function* () {
        const result = yield* assembleNativeInference({
          root: '/nonexistent',
          distributionRoot: '/nonexistent',
          bunTarget: 'unsupported',
        }).pipe(
          Effect.provideService(
            CommandExecutor,
            CommandExecutor.of({
              execute: () => Effect.die('Unexpected cross-target tool invocation'),
              executeStreaming: () => Effect.die('Unexpected cross-target streaming invocation'),
            }),
          ),
          Effect.exit,
        );
        expect(result._tag).toBe('Failure');
      }),
    );
    it.effect('binds a reusable closure and rejects altered or extra payload files', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-inference-overlay-'});
        const source = path.join(root, 'source');
        const destination = path.join(root, 'destination');
        yield* fs.makeDirectory(path.join(source, 'runtime', 'native'), {recursive: true});
        yield* fs.writeFileString(path.join(source, 'runtime', 'node-llama-cpp.js'), 'export const runtime = true;');
        yield* fs.writeFileString(path.join(source, 'runtime', 'native', 'llama.node'), 'fixture-native-bytes');
        const descriptor = yield* publishNativeInferenceOverlay(source, {
          bunVersion: '1.4.4',
          bunTarget: 'bun-darwin-arm64',
          packageVersion: '3.22.2',
          llamaCommit: NATIVE_INFERENCE_LLAMA_COMMIT,
          sourceInputDigest: EffectString.repeat(64)('a'),
          origin: 'locked-prebuilt',
          toolchain: {bun: '1.4.4'},
        });
        expect(yield* stageNativeInferenceOverlay(source, destination)).toEqual(descriptor);
        yield* fs.writeFileString(path.join(destination, 'runtime', 'native', 'extra.node'), 'unlisted');
        expect((yield* verifyNativeInferenceOverlay(destination).pipe(Effect.exit))._tag).toBe('Failure');
        yield* fs.writeFileString(path.join(source, 'runtime', 'native', 'llama.node'), 'changed');
        expect((yield* stageNativeInferenceOverlay(source, destination).pipe(Effect.exit))._tag).toBe('Failure');
      }),
    );
  });
});
