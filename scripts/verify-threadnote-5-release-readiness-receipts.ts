#!/usr/bin/env bun
import {Array as EffectArray} from 'effect';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Console, Effect, Path} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  parseThreadnote5ReleaseEvidenceV1,
  parseThreadnote5ReleaseReadinessFixtureV1,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-contract';
import {
  threadnote5LocalReceiptVerificationArtifact,
  verifyThreadnote5LocalSubsystemReceipts,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-receipts';
import {atomicWrite, hasScriptHelpFlag, printJson, readJsonFile, scriptArguments} from './effect/script.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const DEFAULT_FIXTURE = new URL(
  '../apps/threadnote/test/evaluation/fixtures/threadnote-5-task-loop-v1/fixture.json',
  import.meta.url,
);

const program = Effect.gen(function* () {
  const path = yield* Path.Path;
  const args = yield* scriptArguments();
  if (hasScriptHelpFlag(args)) {
    yield* Console.log(usage());
    return;
  }
  const options = parseArguments(args);
  const fixturePath = options.fixturePath ?? (yield* path.fromFileUrl(DEFAULT_FIXTURE));
  const [fixtureValue, evidenceValue, retainedRecords, authorityManifest] = yield* Effect.all(
    [
      readJsonFile(fixturePath),
      readJsonFile(options.evidencePath),
      readJsonFile(options.retainedRecordsPath),
      options.authorityManifestPath === undefined ? Effect.void : readJsonFile(options.authorityManifestPath),
    ],
    {concurrency: 3},
  );
  const verification = yield* Effect.try({
    try: () => {
      const fixture = parseThreadnote5ReleaseReadinessFixtureV1(fixtureValue);
      const evidence = parseThreadnote5ReleaseEvidenceV1(evidenceValue, fixture);
      if (evidence.capture.manifest.mode !== 'release-candidate') {
        throw new Error('Only release-candidate evidence can be verified against local subsystem records.');
      }
      return verifyThreadnote5LocalSubsystemReceipts({
        authorityManifest,
        candidate: evidence.candidate,
        expectedAuthorityManifestSha256: options.authorityManifestSha256,
        observations: evidence.candidateObservations,
        retainedRecords,
      });
    },
    catch: cause => ScriptError.make({message: 'Threadnote 5 local receipt verification could not run.', cause}),
  });
  const result = threadnote5LocalReceiptVerificationArtifact(verification);
  if (options.outputPath !== undefined)
    yield* atomicWrite(options.outputPath, `${JSON.stringify(result, undefined, 2)}\n`);
  yield* printJson(result);
  if (verification.state !== 'verified') {
    return yield* ScriptError.make({message: `Local subsystem receipts are ${verification.reason}.`});
  }
});

function parseArguments(args: readonly string[]): {
  readonly authorityManifestPath?: string;
  readonly authorityManifestSha256?: string;
  readonly evidencePath: string;
  readonly fixturePath?: string;
  readonly outputPath?: string;
  readonly retainedRecordsPath: string;
} {
  let authorityManifestPath: string | undefined;
  let authorityManifestSha256: string | undefined;
  let evidencePath: string | undefined;
  let fixturePath: string | undefined;
  let outputPath: string | undefined;
  let retainedRecordsPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--authority-manifest') authorityManifestPath = required(args[++index], argument);
    else if (argument === '--authority-manifest-sha256') authorityManifestSha256 = required(args[++index], argument);
    else if (argument === '--evidence') evidencePath = required(args[++index], argument);
    else if (argument === '--fixture') fixturePath = required(args[++index], argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--retained-subsystem-receipts') retainedRecordsPath = required(args[++index], argument);
    else throw ScriptError.make({message: `Unknown Threadnote 5 receipt-verification option: ${argument}`});
  }
  if (evidencePath === undefined || retainedRecordsPath === undefined) {
    throw ScriptError.make({
      message: 'Receipt verification requires --evidence <json> and --retained-subsystem-receipts <json>.',
    });
  }
  if ((authorityManifestPath === undefined) !== (authorityManifestSha256 === undefined)) {
    throw ScriptError.make({
      message: 'Authority verification requires --authority-manifest and --authority-manifest-sha256 together.',
    });
  }
  return {
    ...(authorityManifestPath === undefined ? {} : {authorityManifestPath}),
    ...(authorityManifestSha256 === undefined ? {} : {authorityManifestSha256}),
    evidencePath,
    ...(fixturePath === undefined ? {} : {fixturePath}),
    ...(outputPath === undefined ? {} : {outputPath}),
    retainedRecordsPath,
  };
}

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
      'Usage: bun run verify:threadnote-5-release-readiness-receipts -- [options]',
      '',
      'Verifies local subsystem receipts against Threadnote 5 release-readiness evidence.',
      'Required: --evidence <json> --retained-subsystem-receipts <json>',
      'Optional: --fixture <json> --output <json>',
      'Authority verification: --authority-manifest <json> --authority-manifest-sha256 <64-hex>',
    ],
    '\n',
  );
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
