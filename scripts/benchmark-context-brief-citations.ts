#!/usr/bin/env bun
import {Array as EffectArray} from 'effect';
import {ScriptCommandExecutorLayer} from './effect/system-layer.js';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Layer, Option, Path, Schema} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256Hex} from '@threadnote/platform/digest';
import {SystemInfo} from '@threadnote/platform/system';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {hasScriptHelpFlag, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const TARGET = new URL('./benchmark-context-brief-citations-target.ts', import.meta.url);
const DIAGNOSTIC_PREFIX = '{"kind":"context-brief-citation-scale-disposable-diagnostic",';
const MAXIMUM_DIAGNOSTIC_INPUT_CHARACTERS = 8 * 1_024 * 1_024;
const MAXIMUM_DIAGNOSTIC_LINE_CHARACTERS = 8 * 1_024;
const MAXIMUM_DIAGNOSTIC_RECORDS = 640;
const diagnosticCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const diagnosticCode = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,127}$/u));
const diagnosticSchema = Schema.Struct({
  kind: Schema.Literal('context-brief-citation-scale-disposable-diagnostic'),
  version: Schema.Literal(1),
  releaseQualification: Schema.Literal(false),
  profile: Schema.Literals(['local-100k', 'workset-50', 'workset-128']),
  fixtureRunOrdinal: diagnosticCount,
  taskToken: Schema.String.check(Schema.isPattern(/^tnscale(?:local100k|workset50|workset128)run[0-9]{3}$/u)),
  memoryReadState: Schema.Literals(['not-started', 'running', 'completed', 'interrupted', 'failed']),
  projection: Schema.Struct({
    gaps: Schema.Array(diagnosticCode).check(Schema.isMaxLength(64)),
    memory: Schema.Struct({
      consideredCandidates: diagnosticCount,
      durableCandidates: diagnosticCount,
      handoffCandidates: diagnosticCount,
      fresh: diagnosticCount,
      stale: diagnosticCount,
      unknown: diagnosticCount,
    }),
    durableDecisions: diagnosticCount,
    activeHandoffs: diagnosticCount,
  }),
  selectedMemories: diagnosticCount,
  validationReceipts: diagnosticCount,
  contextBriefMilliseconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Disposable metadata only: never relay arbitrary successful-child stderr or pretty error payloads. */
export const forwardContextBriefCitationDiagnostics = Effect.fn('contextBriefCitationScale.forwardDiagnostics')(
  function* (stderr: string) {
    let forwarded = 0;
    let rejected = 0;
    let recordLimitReached = false;
    const bounded = EffectString.slice(0, MAXIMUM_DIAGNOSTIC_INPUT_CHARACTERS)(stderr);
    for (const line of EffectString.split(/\r?\n/u)(bounded)) {
      if (!EffectString.startsWith(DIAGNOSTIC_PREFIX)(line)) continue;
      if (forwarded >= MAXIMUM_DIAGNOSTIC_RECORDS) {
        recordLimitReached = true;
        break;
      }
      let diagnostic: Option.Option<typeof diagnosticSchema.Type> = Option.none();
      if (line.length <= MAXIMUM_DIAGNOSTIC_LINE_CHARACTERS) {
        diagnostic = yield* Effect.try(() => JSON.parse(line)).pipe(
          Effect.map(Schema.decodeUnknownOption(diagnosticSchema)),
          Effect.orElseSucceed(() => Option.none()),
        );
      }
      if (Option.isNone(diagnostic)) {
        rejected += 1;
        continue;
      }
      yield* Console.error(JSON.stringify(diagnostic.value));
      forwarded += 1;
    }
    const inputTruncated = stderr.length > MAXIMUM_DIAGNOSTIC_INPUT_CHARACTERS;
    if (rejected > 0 || recordLimitReached || inputTruncated) {
      yield* Console.error(
        JSON.stringify({
          kind: 'context-brief-citation-scale-diagnostic-transport',
          rejected,
          recordLimitReached,
          inputTruncated,
        }),
      );
    }
  },
);

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
    yield* forwardContextBriefCitationDiagnostics(child.stderr);
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
