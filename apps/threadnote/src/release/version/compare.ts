import * as EffectString from 'effect/String';
import * as Effect from 'effect';
/**
 * Compare two semver-ish / PEP 440 versions. Returns positive if `left > right`,
 * negative if `left < right`, and zero if they are equivalent. This module is
 * intentionally dependency-free so process leases can be inspected without
 * evaluating the full application utility graph.
 */
export function compareVersions(leftVersion: string, rightVersion: string): number {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  for (let index = 0; index < 3; index += 1) {
    const difference = left.numbers[index] - right.numbers[index];
    if (difference !== 0) return difference;
  }
  const rankDelta = suffixRank(left.suffix) - suffixRank(right.suffix);
  if (rankDelta !== 0) return rankDelta;
  if (left.suffix === right.suffix) return 0;
  return Effect.pipe(left.suffix ?? '', EffectString.localeCompare(right.suffix ?? '', ['en'], {numeric: true}));
}

const DEVELOPMENT_BUILD_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-(?:[0-9A-Za-z-]+\.)*local\.g[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function isDevelopmentBuildVersion(version: string): boolean {
  return DEVELOPMENT_BUILD_VERSION_PATTERN.test(version);
}

function suffixRank(suffix: string | undefined): number {
  if (suffix === undefined) return 0;
  return /^post/i.test(suffix) ? 1 : -1;
}

function parseVersion(version: string): {
  readonly numbers: readonly [number, number, number];
  readonly suffix?: string;
} {
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native split limit truncates results; Effect String split has no limit parameter.
  const normalized = Effect.pipe(version, EffectString.trim, EffectString.replace(/^v/, '')).split('+', 1)[0];
  const core =
    Effect.pipe(
      normalized,
      EffectString.match(/^\d+(?:\.\d+){0,2}/),
      Effect.Option.getOrElse(() => null),
    )?.[0] ?? '';
  const rawSuffix = Effect.pipe(normalized, EffectString.slice(core.length), EffectString.replace(/^[-_.]/, ''));
  const suffix = core.length > 0 && rawSuffix.length > 0 ? rawSuffix : undefined;
  const parts = Effect.pipe(core, EffectString.split('.'));
  return {
    numbers: [
      safeVersionNumber(Number.parseInt(parts[0] ?? '', 10)),
      safeVersionNumber(Number.parseInt(parts[1] ?? '', 10)),
      safeVersionNumber(Number.parseInt(parts[2] ?? '', 10)),
    ],
    suffix,
  };
}

function safeVersionNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}
