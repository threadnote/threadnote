import {
  createPackageAttributorFromIndex,
  createResolutionAttributorFromIndex,
  discoverPackages,
  discoverResolutionAliases,
} from './extractor.js';
import {compareCodeUnits} from './ordering.js';
import {Array as EffectArray, pipe as EffectPipe} from 'effect';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from './types.js';

export interface RepositoryFactAttributionContext {
  readonly attribute: (
    existingPaths: ReadonlySet<string>,
  ) => (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[];
  readonly candidatePaths: (facts: readonly CodeGraphFileFacts[]) => readonly string[];
}

/** Exact manifest paths consumed by repository-level fact attribution. */
export function isRepositoryFactAttributionContextPath(path: string): boolean {
  return /package\.json$/i.test(path) || /(?:^|\/)tsconfig\.json$/i.test(path);
}

/** Attribute changed facts from bounded context plus exact path-membership evidence. */
export function createRepositoryFactAttributorFromContext(
  contextFiles: readonly CodeGraphInventoryFile[],
  existingPaths: ReadonlySet<string>,
): (facts: readonly CodeGraphFileFacts[]) => readonly CodeGraphFileFacts[] {
  return createRepositoryFactAttributionContext(contextFiles).attribute(existingPaths);
}

/**
 * Parse package and resolution manifests once, then reuse that immutable
 * context for both candidate discovery and exact path-backed attribution.
 */
export function createRepositoryFactAttributionContext(
  contextFiles: readonly CodeGraphInventoryFile[],
): RepositoryFactAttributionContext {
  const attributionFiles = EffectPipe(contextFiles, values =>
    EffectArray.filter<CodeGraphInventoryFile>(
      values,
      (file, index) => index in values && isRepositoryFactAttributionContextPath(file.path),
    ),
  );
  const packages = discoverPackages(attributionFiles);
  const aliases = discoverResolutionAliases(attributionFiles, {});
  const attributePackages = createPackageAttributorFromIndex(packages);
  const attribute = (existingPaths: ReadonlySet<string>) => {
    const attributeResolution = createResolutionAttributorFromIndex(attributionFiles, packages, existingPaths, aliases);
    return (facts: readonly CodeGraphFileFacts[]) => attributeResolution(attributePackages(facts));
  };
  return {
    attribute,
    candidatePaths: (facts: readonly CodeGraphFileFacts[]) => {
      const candidates = new RecordingExistingPaths();
      attribute(candidates)(facts);
      return [...candidates].sort(compareCodeUnits);
    },
  };
}

/** Record every repository-membership dependency for one exact batch probe. */
export function repositoryFactCandidatePaths(
  contextFiles: readonly CodeGraphInventoryFile[],
  facts: readonly CodeGraphFileFacts[],
): readonly string[] {
  return createRepositoryFactAttributionContext(contextFiles).candidatePaths(facts);
}

class RecordingExistingPaths extends Set<string> {
  override has(value: string): boolean {
    this.add(value);
    return false;
  }
}
