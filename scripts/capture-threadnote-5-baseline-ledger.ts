#!/usr/bin/env bun

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Effect, Path} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  threadnote5BaselineTrialLedger,
  threadnote5BaselineTrialLedgerHash,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-baseline-ledger';
import {
  parseThreadnote5ReleaseEvidenceV1,
  parseThreadnote5ReleaseReadinessFixtureV1,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-contract';
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
  const options = parseArguments(yield* scriptArguments());
  const fixturePath = options.fixturePath ?? (yield* path.fromFileUrl(DEFAULT_FIXTURE));
  const [fixtureValue, evidenceValue] = yield* Effect.all([
    readJsonFile(fixturePath),
    readJsonFile(options.evidencePath),
  ]);
  const ledger = yield* Effect.try({
    try: () => {
      const fixture = parseThreadnote5ReleaseReadinessFixtureV1(fixtureValue);
      const evidence = parseThreadnote5ReleaseEvidenceV1(evidenceValue, fixture);
      if (evidence.baseline.state !== 'available') throw new Error('Threadnote 4.7.8 observations are unavailable.');
      return threadnote5BaselineTrialLedger(evidence.baseline.source, evidence.baseline.observations);
    },
    catch: cause => ScriptError.make({message: 'Could not capture the Threadnote 4.7.8 comparison ledger.', cause}),
  });
  const result = {ledger, ledgerHash: threadnote5BaselineTrialLedgerHash(ledger), version: 1} as const;
  yield* atomicWrite(options.outputPath, `${JSON.stringify(result, undefined, 2)}\n`);
  yield* printJson(result);
});

function parseArguments(args: readonly string[]): {
  readonly evidencePath: string;
  readonly fixturePath?: string;
  readonly outputPath: string;
} {
  let evidencePath: string | undefined;
  let fixturePath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--evidence') evidencePath = required(args[++index], argument);
    else if (argument === '--fixture') fixturePath = required(args[++index], argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else throw ScriptError.make({message: `Unknown Threadnote 4.7.8 comparison-ledger option: ${argument}`});
  }
  if (evidencePath === undefined || outputPath === undefined) {
    throw ScriptError.make({message: 'Baseline capture requires --evidence <json> and --output <json>.'});
  }
  return {evidencePath, ...(fixturePath === undefined ? {} : {fixturePath}), outputPath};
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

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
