import {describe, expect, it} from 'vitest';
import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Path} from 'effect';
import {javascriptStringLiteral, optionalNativePackageFallbackModule} from '../../../../scripts/effect/javascript.js';

describe('build-time JavaScript string serialization', () => {
  it('preserves the value without emitting script-breaking characters', () => {
    const value = '</script> "quoted" \\\nline\u2028separator\u2029paragraph';
    const literal = javascriptStringLiteral(value);

    expect(literal).not.toMatch(/[<>\u2028\u2029]/);
    expect(JSON.parse(literal)).toBe(value);
  });

  it('executes the optional native package fallback with a self-contained error', async () => {
    const source = optionalNativePackageFallbackModule();
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    const fallback: unknown = await import(moduleUrl);
    if (!isNativePackageFallback(fallback)) throw new Error('Optional native package fallback was invalid.');

    expect(() => fallback.getBinsDir()).toThrowError(
      new Error('Optional native package is not included in this Threadnote artifact.'),
    );
  });
});

function isNativePackageFallback(value: unknown): value is {readonly getBinsDir: () => unknown} {
  return typeof value === 'object' && value !== null && 'getBinsDir' in value && typeof value.getBinsDir === 'function';
}

effectIt.effect('pins the portable llama.cpp source clone to local Git transports', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-source-clone-protocol-'}));
    // No request is sent: Git refuses this transport before attempting the unreachable URL.
    const denied = yield* Effect.sync(() =>
      Bun.spawnSync({
        cmd: ['git', 'clone', 'https://127.0.0.1:9/forbidden', path.join(root, 'never-cloned')],
        env: {
          ...process.env,
          GIT_ALLOW_PROTOCOL: 'file',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: path.join(root, 'absent-config'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    );
    expect(denied.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(denied.stderr)).toContain("transport 'https' not allowed");
    // Every portable-local-build target clones the bundled llama.cpp source through the assembler with this pin.
    const assembler = yield* fs.readFileString(path.join(process.cwd(), 'scripts/assemble-native-inference.ts'));
    expect(assembler).toContain("env: {...Bun.env, GIT_ALLOW_PROTOCOL: 'file'}");
  }).pipe(provideTestLayer(BunServices.layer)),
);
