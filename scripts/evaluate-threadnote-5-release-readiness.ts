#!/usr/bin/env bun
import {Array as EffectArray} from 'effect';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Console, Effect, Path} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  THREADNOTE_5_BASELINE_COMMIT,
  THREADNOTE_5_BASELINE_VERSION,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-contract';
import {evaluateThreadnote5ReleaseReadiness} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness';
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
  const fixturePath = options.fixturePath ?? (yield* path.fromFileUrl(DEFAULT_FIXTURE));
  const [fixture, evidence, retainedSubsystemReceiptRecords, baselineTrialLedger, localAuthorityManifest] =
    yield* Effect.all(
      [
        readJsonFile(fixturePath),
        readJsonFile(options.evidencePath),
        options.retainedSubsystemReceiptRecordsPath === undefined
          ? Effect.void
          : readJsonFile(options.retainedSubsystemReceiptRecordsPath),
        options.baselineTrialLedgerPath === undefined ? Effect.void : readJsonFile(options.baselineTrialLedgerPath),
        options.localAuthorityManifestPath === undefined
          ? Effect.void
          : readJsonFile(options.localAuthorityManifestPath),
      ],
      {
        concurrency: 2,
      },
    );
  const result = yield* Effect.try({
    try: () =>
      evaluateThreadnote5ReleaseReadiness({
        evidence,
        expectedBaselineSource: options.baselineSource,
        expectedBaselineTrialLedgerSha256: options.baselineTrialLedgerSha256,
        expectedCandidateCommit: options.candidateCommit,
        expectedCandidateExecutableSha256: options.candidateExecutableSha256,
        expectedCaptureManifestSha256: options.captureManifestSha256,
        expectedLocalAuthorityManifestSha256: options.localAuthorityManifestSha256,
        fixture,
        baselineTrialLedger,
        localAuthorityManifest,
        retainedSubsystemReceiptRecords,
      }),
    catch: cause => ScriptError.make({message: 'Threadnote 5 release-readiness evidence is invalid.', cause}),
  });
  if (options.outputPath !== undefined) {
    yield* atomicWrite(options.outputPath, `${JSON.stringify(result, undefined, 2)}\n`);
  }
  yield* printJson(result);
  if (result.gate.status !== 'passed') {
    return yield* ScriptError.make({
      message: EffectArray.join([...result.gate.qualityFailures, ...result.gate.insufficiencies], '\n'),
    });
  }
});

function parseArguments(args: readonly string[]): {
  readonly candidateCommit: string;
  readonly candidateExecutableSha256: string;
  readonly captureManifestSha256: string;
  readonly evidencePath: string;
  readonly fixturePath?: string;
  readonly outputPath?: string;
  readonly retainedSubsystemReceiptRecordsPath?: string;
  readonly localAuthorityManifestPath?: string;
  readonly localAuthorityManifestSha256?: string;
  readonly baselineTrialLedgerPath?: string;
  readonly baselineTrialLedgerSha256?: string;
  readonly baselineSource?: {
    readonly commit: string;
    readonly executableSha256: string;
    readonly id: 'threadnote-4.7.x';
    readonly version: string;
  };
} {
  let baselineCommit: string | undefined;
  let baselineExecutableSha256: string | undefined;
  let baselineVersion: string | undefined;
  let candidateCommit: string | undefined;
  let candidateExecutableSha256: string | undefined;
  let captureManifestSha256: string | undefined;
  let evidencePath: string | undefined;
  let fixturePath: string | undefined;
  let outputPath: string | undefined;
  let retainedSubsystemReceiptRecordsPath: string | undefined;
  let baselineTrialLedgerPath: string | undefined;
  let baselineTrialLedgerSha256: string | undefined;
  let localAuthorityManifestPath: string | undefined;
  let localAuthorityManifestSha256: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--baseline-commit') baselineCommit = required(args[++index], argument);
    else if (argument === '--baseline-executable-sha256') {
      baselineExecutableSha256 = required(args[++index], argument);
    } else if (argument === '--baseline-version') baselineVersion = required(args[++index], argument);
    else if (argument === '--candidate-commit') candidateCommit = required(args[++index], argument);
    else if (argument === '--candidate-executable-sha256') {
      candidateExecutableSha256 = required(args[++index], argument);
    } else if (argument === '--capture-manifest-sha256') {
      captureManifestSha256 = required(args[++index], argument);
    } else if (argument === '--evidence') evidencePath = required(args[++index], argument);
    else if (argument === '--fixture') fixturePath = required(args[++index], argument);
    else if (argument === '--output') outputPath = required(args[++index], argument);
    else if (argument === '--retained-subsystem-receipts') {
      retainedSubsystemReceiptRecordsPath = required(args[++index], argument);
    } else if (argument === '--baseline-trial-ledger') baselineTrialLedgerPath = required(args[++index], argument);
    else if (argument === '--baseline-trial-ledger-sha256') {
      baselineTrialLedgerSha256 = required(args[++index], argument);
    } else if (argument === '--authority-manifest') {
      localAuthorityManifestPath = required(args[++index], argument);
    } else if (argument === '--authority-manifest-sha256') {
      localAuthorityManifestSha256 = required(args[++index], argument);
    } else throw ScriptError.make({message: `Unknown Threadnote 5 release-readiness option: ${argument}`});
  }
  if (
    candidateCommit === undefined ||
    candidateExecutableSha256 === undefined ||
    captureManifestSha256 === undefined ||
    evidencePath === undefined
  ) {
    throw ScriptError.make({
      message:
        'Release-readiness evaluation requires --candidate-commit <40-hex>, --candidate-executable-sha256 <64-hex>, --capture-manifest-sha256 <64-hex>, and --evidence <json>.',
    });
  }
  const baselineValues = EffectArray.filter(
    [baselineCommit, baselineExecutableSha256, baselineVersion, baselineTrialLedgerPath, baselineTrialLedgerSha256],
    value => value !== undefined,
  ).length;
  if (baselineValues !== 0 && baselineValues !== 5) {
    throw ScriptError.make({
      message:
        'Trusted 4.7.8 comparison requires --baseline-version, --baseline-commit, --baseline-executable-sha256, --baseline-trial-ledger, and --baseline-trial-ledger-sha256 together.',
    });
  }
  if (
    baselineValues === 5 &&
    (baselineVersion !== THREADNOTE_5_BASELINE_VERSION || baselineCommit !== THREADNOTE_5_BASELINE_COMMIT)
  ) {
    throw ScriptError.make({
      message: `Trusted baseline comparison is fixed to Threadnote ${THREADNOTE_5_BASELINE_VERSION} at ${THREADNOTE_5_BASELINE_COMMIT}.`,
    });
  }
  if ((localAuthorityManifestPath === undefined) !== (localAuthorityManifestSha256 === undefined)) {
    throw ScriptError.make({
      message: 'Local authority verification requires --authority-manifest and --authority-manifest-sha256 together.',
    });
  }
  return {
    candidateCommit,
    candidateExecutableSha256,
    captureManifestSha256,
    evidencePath,
    ...(baselineValues === 5
      ? {
          baselineSource: {
            commit: baselineCommit!,
            executableSha256: baselineExecutableSha256!,
            id: 'threadnote-4.7.x' as const,
            version: baselineVersion!,
          },
        }
      : {}),
    ...(fixturePath === undefined ? {} : {fixturePath}),
    ...(outputPath === undefined ? {} : {outputPath}),
    ...(retainedSubsystemReceiptRecordsPath === undefined ? {} : {retainedSubsystemReceiptRecordsPath}),
    ...(baselineTrialLedgerPath === undefined ? {} : {baselineTrialLedgerPath}),
    ...(baselineTrialLedgerSha256 === undefined ? {} : {baselineTrialLedgerSha256}),
    ...(localAuthorityManifestPath === undefined ? {} : {localAuthorityManifestPath}),
    ...(localAuthorityManifestSha256 === undefined ? {} : {localAuthorityManifestSha256}),
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
      'Usage: bun run eval:threadnote-5-release-readiness -- [options]',
      '',
      'Evaluates bounded Threadnote 5 release-readiness evidence and emits a release gate result.',
      'Required options: --candidate-commit <40-hex> --candidate-executable-sha256 <64-hex>',
      '  --capture-manifest-sha256 <64-hex> --evidence <json>',
      'Optional:',
      '  --fixture <json> --output <json> --retained-subsystem-receipts <json>',
      '  Trusted baseline comparison (all five together):',
      '    --baseline-version <version> --baseline-commit <40-hex>',
      '    --baseline-executable-sha256 <64-hex> --baseline-trial-ledger <json>',
      '    --baseline-trial-ledger-sha256 <64-hex>',
      '  Local authority verification (both together):',
      '    --authority-manifest <json> --authority-manifest-sha256 <64-hex>',
    ],
    '\n',
  );
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
