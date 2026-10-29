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

const TARGET = new URL('./benchmark-context-brief-citations-target.ts', import.meta.url);

/** Build one self-contained Bun target, then retain its digest in the benchmark artifact. */
const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const args = yield* scriptArguments();
    if (hasScriptHelpFlag(args)) {
      yield* Console.log(usage());
      return;
    }
    if (args.includes('--built-artifact-sha256')) {
      return yield* ScriptError.make({message: '--built-artifact-sha256 is reserved for the benchmark wrapper.'});
    }
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-context-brief-citation-benchmark-build-'});
    const target = yield* path.fromFileUrl(TARGET);
    const packageManifest: unknown = JSON.parse(
      yield* fs.readFileString(path.join(path.dirname(target), '..', 'package.json')),
    );
    if (
      typeof packageManifest !== 'object' ||
      packageManifest === null ||
      !('version' in packageManifest) ||
      typeof packageManifest.version !== 'string' ||
      packageManifest.version.length === 0
    ) {
      return yield* ScriptError.make({message: 'package.json does not declare a benchmark source version.'});
    }
    const outfile = path.join(root, 'context-brief-citation-scale-benchmark.mjs');
    const result = yield* Effect.tryPromise({
      try: () =>
        Bun.build({
          bytecode: false,
          define: {THREADNOTE_VERSION: JSON.stringify(packageManifest.version)},
          entrypoints: [target],
          format: 'esm',
          minify: true,
          naming: path.basename(outfile),
          outdir: root,
          sourcemap: 'none',
          target: 'bun',
        }),
      catch: cause =>
        ScriptError.make({message: 'Could not build the Context Brief citation scale benchmark target.', cause}),
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
    const digest = yield* sha256Hex(yield* fs.readFile(outfile));
    const child = yield* runCommandEffect(
      system.executablePath,
      [outfile, ...args, '--built-artifact-sha256', digest],
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
      'Usage: bun run bench:context-brief-citations -- [options]',
      '',
      'Builds and runs the Context Brief citation scale benchmark.',
      'Options: --candidate-commit <40-hex> --output <json> --budget <json> --fail-on-budget',
      '  --profiles <local-100k,workset-50,workset-128> --memory-candidates <count>',
      '  --samples <count> --warmups <count>',
    ],
    '\n',
  );
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, wrapperLayer));
