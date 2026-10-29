import {Console, Effect, Result, Schema} from 'effect';
import {heading, info, keyValue, success, warning, withSpinnerEffect} from '../../cli_ui.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {VersionOptions} from '../../types.js';
import {currentPackageVersion, fetchLatestVersion, latestUpdateVersionLabel, resolveReleaseSource} from '../index.js';
import {selectUpdateChannel} from '../channel.js';
import {compareVersions} from '../../utils.js';
import {errorMessage} from '@threadnote/platform/errors';
import {whatsNewLinesForVersion, whatsNewLinesForVersionRange} from '../notes.js';
import {SystemInfo} from '@threadnote/platform/system';

class VersionCommandError extends Schema.TaggedError<VersionCommandError, {readonly brand: unique symbol}>()(
  'VersionCommandError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

export const runVersion = Effect.fn('runVersion')(function* (config: RuntimeConfig, options: VersionOptions) {
  const currentVersion = yield* currentPackageVersion();
  const channel = selectUpdateChannel(currentVersion);
  const system = yield* SystemInfo;
  const source = yield* Effect.try({
    try: () => resolveReleaseSource(options.source, options.allowUntrustedSource, system.environment()),
    catch: cause => VersionCommandError.make({cause, message: 'Could not resolve the release source.'}),
  });
  const latest = yield* withSpinnerEffect(
    'Checking GitHub for the latest standalone Threadnote release',
    fetchLatestVersion(source, channel),
  ).pipe(Effect.match({onFailure: Result.fail, onSuccess: Result.succeed}));
  const latestVersion = Result.isSuccess(latest) ? latest.success : undefined;
  const latestWarning = Result.isFailure(latest) ? errorMessage(latest.failure) : undefined;

  yield* Console.log(keyValue('Current version', info(currentVersion)));
  yield* Console.log(
    keyValue(latestUpdateVersionLabel(channel), latestVersion ? info(latestVersion) : warning('unavailable')),
  );
  if (latestWarning) {
    yield* Console.log(warning(`Warning: ${latestWarning}`));
  }

  if (!latestVersion) {
    return;
  }
  const comparison = compareVersions(currentVersion, latestVersion);
  if (comparison >= 0) {
    yield* Console.log(
      success(
        comparison > 0
          ? `Current version is newer than the published ${channel} release.`
          : 'Threadnote is up to date.',
      ),
    );
    yield* Console.log('');
    const whatsNew = yield* withSpinnerEffect(
      'Fetching GitHub release notes',
      whatsNewLinesForVersion(currentVersion, {includePrereleases: channel === 'beta'}),
    );
    yield* printWhatsNew(whatsNew);
    return;
  }

  yield* Console.log('');
  const whatsNew = yield* withSpinnerEffect(
    'Fetching GitHub release notes',
    whatsNewLinesForVersionRange(currentVersion, latestVersion, {includePrereleases: channel === 'beta'}),
  );
  yield* printWhatsNew(whatsNew);
});

const printWhatsNew = Effect.fn('printWhatsNew')(function* (whatsNew: readonly string[]) {
  for (const line of whatsNew) {
    yield* Console.log(line === "What's new:" ? heading(line) : line);
  }
});
