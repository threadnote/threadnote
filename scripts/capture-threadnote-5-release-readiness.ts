#!/usr/bin/env bun
import {Array as EffectArray} from 'effect';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Console, Effect, Path} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  canonicalizeThreadnote5CaptureOutputPathsV1,
  captureThreadnote5ReleaseCandidateV1,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-capture';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {atomicWrite, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const DEFAULT_FIXTURE = new URL(
  '../apps/threadnote/test/evaluation/fixtures/threadnote-5-task-loop-v1/fixture.json',
  import.meta.url,
);

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const args = yield* scriptArguments();
  if (args.includes('--help') || args.includes('-h')) {
    yield* Console.log(usage());
    return;
  }
  const options = parseArguments(args);
  const outputPaths = canonicalizeThreadnote5CaptureOutputPathsV1({
    canonicalReceiptsOutputPath: options.canonicalReceiptsOutputPath,
    evidenceOutputPath: options.evidenceOutputPath,
    resolvePath: path.resolve,
  });
  const fixturePath = options.fixturePath ?? (yield* path.fromFileUrl(DEFAULT_FIXTURE));
  const [fixture, candidate, retainedSubsystemReceipts, runtimeBoundaries, authorityManifest] = yield* Effect.all(
    [
      readJsonFile(fixturePath),
      readJsonFile(options.candidatePath),
      readJsonFile(options.retainedSubsystemReceiptsPath),
      readJsonFile(options.runtimeBoundariesPath),
      readJsonFile(options.authorityManifestPath),
    ],
    {concurrency: 5},
  );
  const captured = yield* Effect.try({
    try: () =>
      captureThreadnote5ReleaseCandidateV1({
        authorityManifest,
        candidate,
        expectedAuthorityManifestSha256: options.authorityManifestSha256,
        fixture,
        retainedSubsystemReceipts,
        runtimeBoundaries,
      }),
    catch: cause => ScriptError.make({message: 'Threadnote 5 release-readiness capture failed closed.', cause}),
  });
  yield* Effect.all(
    [
      atomicWrite(outputPaths.evidenceOutputPath, `${JSON.stringify(captured.evidence, undefined, 2)}\n`),
      atomicWrite(
        outputPaths.canonicalReceiptsOutputPath,
        `${JSON.stringify(captured.retainedSubsystemReceipts, undefined, 2)}\n`,
      ),
    ],
    {concurrency: 2},
  );
  yield* printJson({
    authorityManifestHash: captured.authorityManifestHash,
    captureManifestHash: captured.evidence.capture.manifestHash,
    evidenceHash: captured.evidence.evidenceHash,
    observationCount: captured.evidence.candidateObservations.length,
    receiptCount: captured.retainedSubsystemReceipts.length,
    version: captured.version,
  });
});

function parseArguments(args: readonly string[]): {
  readonly authorityManifestPath: string;
  readonly authorityManifestSha256: string;
  readonly candidatePath: string;
  readonly canonicalReceiptsOutputPath: string;
  readonly evidenceOutputPath: string;
  readonly fixturePath?: string;
  readonly retainedSubsystemReceiptsPath: string;
  readonly runtimeBoundariesPath: string;
} {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!OPTIONS.has(argument)) throw ScriptError.make({message: `Unknown Threadnote 5 capture option: ${argument}`});
    options[argument] = required(args[++index], argument);
  }
  const requiredOptions = [
    '--authority-manifest',
    '--authority-manifest-sha256',
    '--candidate',
    '--canonical-receipts-output',
    '--evidence-output',
    '--retained-subsystem-receipts',
    '--runtime-boundaries',
  ] as const;
  for (const option of requiredOptions) {
    if (options[option] === undefined) throw ScriptError.make({message: `Release capture requires ${option}.`});
  }
  return {
    authorityManifestPath: options['--authority-manifest'],
    authorityManifestSha256: options['--authority-manifest-sha256'],
    candidatePath: options['--candidate'],
    canonicalReceiptsOutputPath: options['--canonical-receipts-output'],
    evidenceOutputPath: options['--evidence-output'],
    ...(options['--fixture'] === undefined ? {} : {fixturePath: options['--fixture']}),
    retainedSubsystemReceiptsPath: options['--retained-subsystem-receipts'],
    runtimeBoundariesPath: options['--runtime-boundaries'],
  };
}

const OPTIONS = new Set([
  '--authority-manifest',
  '--authority-manifest-sha256',
  '--candidate',
  '--canonical-receipts-output',
  '--evidence-output',
  '--fixture',
  '--retained-subsystem-receipts',
  '--runtime-boundaries',
]);

function required(value: string | undefined, option: string): string {
  if (
    !Effect2.pipe(value, effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.trim),
    )
  )
    throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

function usage(): string {
  return EffectArray.join(
    [
      'Usage: bun run capture:threadnote-5-release-readiness -- [options]',
      '',
      'Captures bounded Threadnote 5 release-readiness evidence from supplied JSON inputs.',
      'Required options: --authority-manifest <json> --authority-manifest-sha256 <64-hex>',
      '  --candidate <json> --canonical-receipts-output <json> --evidence-output <json>',
      '  --retained-subsystem-receipts <json> --runtime-boundaries <json>',
      'Optional: --fixture <json>',
    ],
    '\n',
  );
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
