import {Array as EffectArray} from 'effect';
import {ScriptSystemInfoLayer} from './effect/system-layer.js';
import {provideScriptLayer, ScriptError} from './effect/errors.js';
import {printJson, scriptArguments} from './effect/script.js';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Console, Effect, FileSystem, Layer, Path, Schema} from 'effect';

import {
  parseStableReleaseVersion,
  releaseHeadlineFromSummary,
  summarizeReleaseNote,
} from '@threadnote/website/release-notes';
import {isSupportedReleaseVersion} from './release-version.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export {isSupportedReleaseVersion} from './release-version.js';

const ROOT_URL = new URL('..', import.meta.url);
const RELEASE_NOTES_HEADING = "## What's new";

export interface PrepareReleaseOptions {
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly version: string | undefined;
  readonly patch: boolean;
}

export interface PreparedReleasePlan {
  readonly dryRun: boolean;
  readonly notesPath: string;
  readonly nextSteps: readonly string[];
  readonly previousVersion: string;
  readonly version: string;
  readonly wrotePackageVersion: boolean;
}

function releaseVersionExpectation(): string {
  return 'a canonical safe-integer stable X.Y.Z or numbered beta X.Y.Z-beta.N (N >= 1)';
}

export function parsePrepareReleaseArguments(arguments_: readonly string[]): PrepareReleaseOptions {
  let dryRun = false;
  let json = false;
  let patch = false;
  let version: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--') continue;
    if (argument === '--dry-run') dryRun = true;
    else if (argument === '--json') json = true;
    else if (argument === '--patch') patch = true;
    else if (argument === '--version') {
      const value = arguments_[index + 1];
      if (value === undefined || Effect2.pipe(value, EffectString.startsWith('--'))) {
        throw ScriptError.make({message: `--version requires ${releaseVersionExpectation()}.`});
      }
      version = value;
      index += 1;
    } else throw ScriptError.make({message: `Unknown prepare-release option: ${argument}`});
  }
  if (patch === (version !== undefined)) {
    throw ScriptError.make({message: 'Pass exactly one of --patch or --version <X.Y.Z | X.Y.Z-beta.N>.'});
  }
  return {dryRun, json, patch, version};
}

export function nextPatchVersion(version: string): string {
  const parsed = parseStableReleaseVersion(`v${version}`);
  if (parsed === undefined) {
    throw ScriptError.make({
      message: `Cannot increment patch from ${version}; use --version with a stable X.Y.Z.`,
    });
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function releaseNotesPathForVersion(version: string): string {
  return `.github/release-notes/v${version}.md`;
}

export function replacePackageVersion(manifest: unknown, version: string): {readonly source: string} {
  if (typeof manifest !== 'object' || manifest === null || EffectArray.isArray(manifest)) {
    throw ScriptError.make({message: 'package.json must be a JSON object.'});
  }
  if (!('version' in manifest) || typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw ScriptError.make({message: 'package.json does not declare a version.'});
  }
  return {source: `${JSON.stringify({...manifest, version}, undefined, 2)}\n`};
}

export function validateReleaseNotes(
  markdown: string,
  version: string,
): {readonly headline: string; readonly summary: string} {
  if (!isSupportedReleaseVersion(version)) {
    throw ScriptError.make({message: `Release version must be ${releaseVersionExpectation()}, got ${version}.`});
  }
  const normalized = Effect2.pipe(markdown, EffectString.replace(/\r\n?/g, '\n'));
  if (!Effect2.pipe(normalized, EffectString.startsWith(`${RELEASE_NOTES_HEADING}\n`))) {
    throw ScriptError.make({
      message: `${releaseNotesPathForVersion(version)} must start with ${RELEASE_NOTES_HEADING}.`,
    });
  }
  const {summary} = summarizeReleaseNote(normalized);
  if (!summary) {
    throw ScriptError.make({message: `${releaseNotesPathForVersion(version)} needs an introductory release summary.`});
  }
  return {headline: releaseHeadlineFromSummary(summary), summary};
}

export const prepareRelease = Effect.fn('prepareRelease.run')(function* (
  options: PrepareReleaseOptions,
  sourceRoot?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = sourceRoot ?? (yield* path.fromFileUrl(ROOT_URL));
  const packageFile = path.join(root, 'package.json');
  const manifest = yield* fs.readFileString(packageFile).pipe(
    Effect.flatMap(source =>
      Effect.try({
        try: (): unknown => JSON.parse(source),
        catch: cause => ScriptError.make({message: 'Could not parse package.json.', cause}),
      }),
    ),
  );
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string' ||
    manifest.version.length === 0
  ) {
    return yield* ScriptError.make({message: 'package.json does not declare a version.'});
  }
  const version = options.patch ? nextPatchVersion(manifest.version) : options.version;
  if (version === undefined) {
    return yield* ScriptError.make({message: 'Pass exactly one of --patch or --version <X.Y.Z | X.Y.Z-beta.N>.'});
  }
  if (!isSupportedReleaseVersion(version)) {
    return yield* ScriptError.make({
      message: `Release version must be ${releaseVersionExpectation()}, got ${version}.`,
    });
  }
  const notesPath = releaseNotesPathForVersion(version);
  const notesFile = path.join(root, notesPath);
  if (!(yield* fs.exists(notesFile))) {
    return yield* ScriptError.make({
      message: `${notesPath} is missing. Write the curated notes first, then rerun prepare-release.`,
    });
  }
  const markdown = yield* fs.readFileString(notesFile);
  yield* Effect.try({
    try: () => validateReleaseNotes(markdown, version),
    catch: cause =>
      Schema.is(ScriptError)(cause) ? cause : ScriptError.make({cause, message: 'Release notes failed validation.'}),
  });
  const nextManifest = replacePackageVersion(manifest, version);
  if (!options.dryRun && manifest.version !== version) {
    yield* fs.writeFileString(packageFile, nextManifest.source);
  }
  const plan = {
    dryRun: options.dryRun,
    notesPath,
    nextSteps: [
      'Commit package.json and the release notes on the release PR.',
      'Open or update the PR and let CI run the full suite.',
      'After merge onto protected main, tag v' + version + ' on that exact commit and push the tag immediately.',
      'Do not create the GitHub Release manually; wait for Publish standalone release.',
    ],
    previousVersion: manifest.version,
    version,
    wrotePackageVersion: !options.dryRun && manifest.version !== version,
  } satisfies PreparedReleasePlan;
  return plan;
});

const systemLayer = ScriptSystemInfoLayer;
const prepareLayer = systemLayer.pipe(Layer.provideMerge(BunServices.layer));
const program = Effect.gen(function* () {
  const options = parsePrepareReleaseArguments(yield* scriptArguments());
  const plan = yield* prepareRelease(options);
  if (options.json) {
    yield* printJson(plan);
    return plan;
  }
  yield* Console.log(
    plan.wrotePackageVersion
      ? `Prepared Threadnote ${plan.version} (was ${plan.previousVersion}).`
      : plan.dryRun
        ? `Would prepare Threadnote ${plan.version} from ${plan.previousVersion}.`
        : `Threadnote ${plan.version} is already set in package.json.`,
  );
  yield* Console.log(`Release notes: ${plan.notesPath}`);
  for (const step of plan.nextSteps) yield* Console.log(`Next: ${step}`);
  return plan;
});

if (import.meta.main) BunRuntime.runMain(provideScriptLayer(program, prepareLayer));
