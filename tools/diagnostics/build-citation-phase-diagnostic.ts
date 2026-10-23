#!/usr/bin/env bun
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256Hex} from '@threadnote/platform/digest';
import {SystemInfo} from '@threadnote/platform/system';
import {ScriptSystemInfoLayer, ScriptCommandExecutorLayer} from '../../scripts/effect/system-layer.js';
import {provideScriptLayer, ScriptError} from '../../scripts/effect/errors.js';
import {parseDiagnosticArguments} from './citation-phase-contract.js';

const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const system = yield* SystemInfo;
    const args = system.processArguments.slice(2);
    if (args.includes('--built-artifact-sha256'))
      return yield* ScriptError.make({message: 'Diagnostic build digest is reserved for the wrapper.'});
    yield* Effect.try({
      try: () => parseDiagnosticArguments([...args, '--built-artifact-sha256', '0'.repeat(64)]),
      catch: cause => ScriptError.make({message: 'Invalid citation diagnostic arguments.', cause}),
    });
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-phase-diagnostic-build-'});
    const manifest = JSON.parse(yield* fs.readFileString('package.json')) as {version?: unknown};
    if (typeof manifest.version !== 'string')
      return yield* ScriptError.make({message: 'Candidate package version is unavailable.'});
    const entrypoint = yield* path.fromFileUrl(new URL('./citation-phase-diagnostic.ts', import.meta.url));
    const result = yield* Effect.tryPromise({
      try: () =>
        Bun.build({
          entrypoints: [entrypoint],
          outdir: root,
          naming: 'citation-phase-diagnostic.mjs',
          bytecode: false,
          define: {THREADNOTE_VERSION: JSON.stringify(manifest.version)},
          format: 'esm',
          minify: true,
          sourcemap: 'none',
          target: 'bun',
        }),
      catch: cause => ScriptError.make({message: 'Could not build citation diagnostic.', cause}),
    });
    if (!result.success) return yield* ScriptError.make({message: 'Citation diagnostic build failed.'});
    const bundle = path.join(root, 'citation-phase-diagnostic.mjs');
    const digest = yield* sha256Hex(yield* fs.readFile(bundle));
    yield* runCommandEffect(system.executablePath, [bundle, ...args, '--built-artifact-sha256', digest], {
      maxOutputBytes: 0,
      timeoutMs: 3 * 60 * 60 * 1_000,
    });
  }),
);
const system = ScriptSystemInfoLayer;
const platform = Layer.mergeAll(system, ScriptCommandExecutorLayer.pipe(Layer.provide(system))).pipe(
  Layer.provideMerge(BunServices.layer),
);
if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, platform));
