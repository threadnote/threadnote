#!/usr/bin/env bun
import {Array as EffectArray} from 'effect';
import {ScriptCommandExecutorLayer} from './effect/system-layer.js';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Layer, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256Hex} from '@threadnote/platform/digest';
import {SystemInfo} from '@threadnote/platform/system';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {hasScriptHelpFlag, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const TARGET = new URL('./benchmark-code-memory-link-scale-target.ts', import.meta.url);

export interface CodeMemoryLinkScaleBuiltTarget {
  readonly executablePath: string;
  readonly sha256: string;
  readonly sourceVersion: string;
}

/** Build the exact benchmark program whose bytes are bound into release-scale evidence. */
export const buildCodeMemoryLinkScaleTarget = Effect.fn('codeMemoryLinkScale.buildTarget')(function* (
  outputDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = yield* path.fromFileUrl(TARGET);
  const packageManifest: unknown = JSON.parse(
    yield* fs.readFileString(path.join(path.dirname(target), '..', 'package.json')),
  );
  if (
    typeof packageManifest !== 'object' ||
    packageManifest === null ||
    EffectArray.isArray(packageManifest) ||
    !('version' in packageManifest) ||
    typeof packageManifest.version !== 'string' ||
    packageManifest.version.length === 0
  ) {
    return yield* ScriptError.make({message: 'package.json does not declare a scale benchmark source version.'});
  }
  const executablePath = path.join(outputDirectory, 'code-memory-link-inverse-scale.mjs');
  const result = yield* Effect.tryPromise({
    try: () =>
      Bun.build({
        bytecode: false,
        define: {THREADNOTE_VERSION: JSON.stringify(packageManifest.version)},
        entrypoints: [target],
        format: 'esm',
        minify: true,
        naming: path.basename(executablePath),
        outdir: outputDirectory,
        sourcemap: 'none',
        target: 'bun',
      }),
    catch: cause => ScriptError.make({message: 'Could not build the inverse-selector scale benchmark target.', cause}),
  });
  if (!result.success) {
    return yield* ScriptError.make({
      message:
        EffectArray.join(
          EffectArray.filter(
            EffectArray.map(result.logs, log => log.message),
            Boolean,
          ),
          '\n',
        ) || 'Benchmark build failed.',
    });
  }
  return {
    executablePath,
    sha256: yield* sha256Hex(yield* fs.readFile(executablePath)),
    sourceVersion: packageManifest.version,
  } satisfies CodeMemoryLinkScaleBuiltTarget;
});

export const rebuildCodeMemoryLinkScaleTargetDigest = Effect.fn('codeMemoryLinkScale.rebuildTargetDigest')(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-memory-link-scale-verify-'});
    return (yield* buildCodeMemoryLinkScaleTarget(root)).sha256;
  },
);

/** Build one immutable target and bind its digest into retained scale evidence. */
const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const system = yield* SystemInfo;
    const args = yield* scriptArguments();
    if (hasScriptHelpFlag(args)) {
      yield* Console.log(usage());
      return;
    }
    if (args.includes('--built-artifact-sha256')) {
      return yield* ScriptError.make({message: '--built-artifact-sha256 is reserved for the benchmark wrapper.'});
    }
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-code-memory-link-scale-build-'});
    const built = yield* buildCodeMemoryLinkScaleTarget(root);
    const child = yield* runCommandEffect(
      system.executablePath,
      [built.executablePath, ...args, '--built-artifact-sha256', built.sha256],
      {maxOutputBytes: 0, timeoutMs: 3 * 60 * 60 * 1_000},
    );
    if (Effect2.pipe(child.stdout, EffectString.trim))
      yield* Console.log(Effect2.pipe(child.stdout, EffectString.trimEnd));
  }),
);

const systemLayer = ScriptSystemInfoLayer;
const commandLayer = ScriptCommandExecutorLayer.pipe(Layer.provide(systemLayer));
const wrapperLayer = Layer.mergeAll(systemLayer, commandLayer).pipe(Layer.provideMerge(BunServices.layer));

function usage(): string {
  return EffectArray.join(
    [
      'Usage: bun run bench:code-memory-link-scale -- [options]',
      '',
      'Builds and runs the code-memory-link inverse-selector scale benchmark.',
      'Required: --candidate-commit <40-hex>',
      'Optional: --budget <json> --output <json> --development-smoke',
      '  --memory-candidates <count> --samples <count> --warmups <count>',
    ],
    '\n',
  );
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, wrapperLayer));
