const CANONICAL_STABLE_RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CANONICAL_BETA_RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/;

function hasOnlySafeIntegerComponents(match: RegExpExecArray | null): boolean {
  if (match === null) return false;
  // This release validator runs before dependencies are installed.
  for (let index = 1; index < match.length; index++) {
    if (!Number.isSafeInteger(Number(match[index]))) return false;
  }
  return true;
}

export function isSupportedReleaseVersion(version: string): boolean {
  return (
    hasOnlySafeIntegerComponents(CANONICAL_STABLE_RELEASE_VERSION.exec(version)) ||
    hasOnlySafeIntegerComponents(CANONICAL_BETA_RELEASE_VERSION.exec(version))
  );
}
