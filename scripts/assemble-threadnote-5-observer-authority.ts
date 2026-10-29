#!/usr/bin/env bun
import {Array as EffectArray} from 'effect';

import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import {Console, Effect, FileSystem, Stream} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  previewThreadnote5ReviewedAuthorityManifestV1,
  reviewedAuthorityBundleArtifact,
  verifyThreadnote5ReviewedAuthorityManifestV1,
} from '@threadnote/threadnote/evaluation/threadnote-5-release-readiness-observer-authority';
import {printJson, scriptArguments} from './effect/script.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const CANDIDATE_MAX_BYTES = 64 * 1024;
const PRIVATE_EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;

const program = Effect.gen(function* () {
  const args = yield* scriptArguments();
  if (args.includes('--help') || args.includes('-h')) return yield* Console.log(usage());
  const options = parseArguments(args);
  const [candidate, retainedRecords, reviews, bundle] = yield* Effect.all([
    readBoundedJsonFile(options.candidatePath, CANDIDATE_MAX_BYTES, 'candidate'),
    readBoundedJsonFile(options.retainedRecordsPath, PRIVATE_EVIDENCE_MAX_BYTES, 'retained records'),
    readBoundedJsonFile(options.reviewsPath, PRIVATE_EVIDENCE_MAX_BYTES, 'private reviews'),
    options.mode === 'verify'
      ? readBoundedJsonFile(options.bundlePath!, PRIVATE_EVIDENCE_MAX_BYTES, 'reviewed bundle')
      : Effect.void,
  ]);
  const preview = yield* Effect.try({
    try: () => previewThreadnote5ReviewedAuthorityManifestV1({candidate, retainedRecords, reviews}),
    catch: cause => ScriptError.make({message: 'Observer authority preview failed closed.', cause}),
  });
  if (options.mode === 'preview') return yield* printJson(preview);
  if (options.mode === 'assemble') return yield* printJson(reviewedAuthorityBundleArtifact(preview));
  const verified = yield* Effect.try({
    try: () =>
      verifyThreadnote5ReviewedAuthorityManifestV1({
        bundle,
        candidate,
        expectedBindingSha256: options.expectedBindingSha256!,
        expectedManifestSha256: options.expectedManifestSha256!,
        expectedReviewArtifactSetSha256: options.expectedReviewArtifactSetSha256!,
        retainedRecords,
        reviews,
      }),
    catch: cause => ScriptError.make({message: 'Observer authority verification failed closed.', cause}),
  });
  yield* printJson(verified.manifest);
});

function parseArguments(args: readonly string[]): {
  readonly candidatePath: string;
  readonly bundlePath?: string;
  readonly expectedManifestSha256?: string;
  readonly expectedBindingSha256?: string;
  readonly expectedReviewArtifactSetSha256?: string;
  readonly mode: 'assemble' | 'preview' | 'verify';
  readonly retainedRecordsPath: string;
  readonly reviewsPath: string;
} {
  const values: Record<string, string> = {};
  let mode: 'assemble' | 'preview' | 'verify' | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--preview' || option === '--assemble' || option === '--verify') {
      if (mode !== undefined) throw ScriptError.make({message: 'Observer authority accepts exactly one mode flag.'});
      mode = option === '--preview' ? 'preview' : option === '--assemble' ? 'assemble' : 'verify';
    } else if (OPTIONS.has(option)) {
      if (values[option] !== undefined)
        throw ScriptError.make({message: `Observer authority option may appear only once: ${option}`});
      values[option] = required(args[++index], option);
    } else throw ScriptError.make({message: `Unknown observer authority option: ${option}`});
  }
  if (mode === undefined)
    throw ScriptError.make({message: 'Observer authority requires one of --preview, --assemble, or --verify.'});
  for (const option of ['--candidate', '--retained-records', '--reviews'] as const) {
    if (values[option] === undefined) throw ScriptError.make({message: `Observer authority requires ${option}.`});
  }
  if (
    mode === 'verify' &&
    (values['--bundle'] === undefined ||
      values['--manifest-sha256'] === undefined ||
      values['--review-artifact-set-sha256'] === undefined ||
      values['--binding-sha256'] === undefined)
  ) {
    throw ScriptError.make({
      message: 'Observer authority verification requires --bundle and all independently supplied hashes.',
    });
  }
  if (
    mode !== 'verify' &&
    (values['--bundle'] !== undefined ||
      values['--manifest-sha256'] !== undefined ||
      values['--review-artifact-set-sha256'] !== undefined ||
      values['--binding-sha256'] !== undefined)
  )
    throw ScriptError.make({message: 'Verification options are only valid with --verify.'});
  return {
    ...(values['--bundle'] === undefined ? {} : {bundlePath: values['--bundle']}),
    candidatePath: values['--candidate'],
    ...(values['--manifest-sha256'] === undefined ? {} : {expectedManifestSha256: values['--manifest-sha256']}),
    ...(values['--binding-sha256'] === undefined ? {} : {expectedBindingSha256: values['--binding-sha256']}),
    ...(values['--review-artifact-set-sha256'] === undefined
      ? {}
      : {expectedReviewArtifactSetSha256: values['--review-artifact-set-sha256']}),
    mode,
    retainedRecordsPath: values['--retained-records'],
    reviewsPath: values['--reviews'],
  };
}

const OPTIONS = new Set([
  '--candidate',
  '--binding-sha256',
  '--bundle',
  '--manifest-sha256',
  '--review-artifact-set-sha256',
  '--retained-records',
  '--reviews',
]);

function required(value: string | undefined, option: string): string {
  if (value === undefined) throw ScriptError.make({message: `${option} requires a value`});
  if (!Effect2.pipe(value, EffectString.trim)) throw ScriptError.make({message: `${option} requires a value`});
  return value;
}

const readBoundedJsonFile = Effect.fn('releaseReadiness.readBoundedObserverAuthorityJson')(function* (
  file: string,
  maximumBytes: number,
  label: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = Buffer.concat(yield* Stream.runCollect(fs.stream(file, {bytesToRead: maximumBytes + 1})));
  if (bytes.byteLength > maximumBytes)
    return yield* ScriptError.make({message: `Observer authority ${label} exceeds its raw-byte limit.`});
  return yield* Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: cause => ScriptError.make({message: `Could not parse observer authority ${label} JSON.`, cause}),
  });
});

function usage(): string {
  return EffectArray.join(
    [
      'Usage: bun run assemble:threadnote-5-observer-authority -- --preview|--assemble|--verify [options]',
      'Common: --candidate <json> --retained-records <json> --reviews <json>',
      'Preview: --preview',
      'Assemble: --assemble (emits one reviewed bundle to stdout)',
      'Verify: --verify --bundle <json> --manifest-sha256 <64-lowercase-hex>',
      '        --review-artifact-set-sha256 <64-lowercase-hex> --binding-sha256 <64-lowercase-hex>',
      'Verify emits the replayed raw authority manifest to stdout.',
    ],
    '\n',
  );
}

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, ApplicationLayer));
