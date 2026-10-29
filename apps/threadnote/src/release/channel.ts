import * as EffectString from 'effect/String';
import * as Effect from 'effect';
export type UpdateChannel = 'beta' | 'latest';

const DEVELOPMENT_VERSION_SUFFIX = /(?:^|[.-])local\.g[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu;

export function isPrereleaseVersion(version: string): boolean {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  const normalized = Effect.pipe(version, EffectString.trim, EffectString.replace(/^v/i, '')).split('+', 1)[0] ?? '';
  const releaseVersion = Effect.pipe(normalized, EffectString.replace(DEVELOPMENT_VERSION_SUFFIX, ''));
  return /^\d+\.\d+\.\d+-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/u.test(releaseVersion);
}

/** Compatibility name retained for callers that predate the inclusive preview-channel contract. */
export function isBetaVersion(version: string): boolean {
  return isPrereleaseVersion(version);
}

export function selectUpdateChannel(currentVersion: string, requestedChannel?: UpdateChannel): UpdateChannel {
  return requestedChannel ?? (isBetaVersion(currentVersion) ? 'beta' : 'latest');
}
