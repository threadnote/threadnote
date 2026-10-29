import {isLowSignalStructuredPath, isRecognizedStructuredPath} from '../languages/schemas/policy.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

/**
 * Bump this whenever repository admission changes. The extractor generation is
 * bumped alongside it so facts produced under an older admission policy cannot
 * be reused by a new snapshot.
 */
export const CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION = 2 as const;

/** Generic JSON at or above this boundary is low-value graph input. */
export const CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES = 256 * 1_024;

/** Even recognized configuration files must stay below the shallow-scan ceiling. */
export const CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES = 1_048_576;

export type CodeGraphInventoryExclusionReason =
  'generic-json-size' | 'high-signal-json-hard-cap' | 'low-signal-json' | 'svg';

export const CODE_GRAPH_INVENTORY_EXCLUSION_REASONS = [
  'svg',
  'low-signal-json',
  'generic-json-size',
  'high-signal-json-hard-cap',
] as const satisfies readonly CodeGraphInventoryExclusionReason[];

/**
 * Classify files that are deliberately absent from graph inventory. This check
 * uses only tree/stat metadata so callers can apply it before reading, hashing,
 * caching, or extracting repository content.
 */
export function codeGraphInventoryExclusionReason(
  repositoryPath: string,
  size: number,
): CodeGraphInventoryExclusionReason | undefined {
  if (!Number.isSafeInteger(size) || size < 0) return undefined;
  const normalizedPath = Effect.pipe(repositoryPath, EffectString.replace(/^\.\/+/, ''));
  const lowerPath = Effect.pipe(normalizedPath, EffectString.toLowerCase);
  if (Effect.pipe(lowerPath, EffectString.endsWith('.svg'))) return 'svg';
  if (
    !Effect.pipe(lowerPath, EffectString.endsWith('.json')) &&
    !Effect.pipe(lowerPath, EffectString.endsWith('.jsonc'))
  )
    return undefined;

  if (isLowSignalStructuredPath(lowerPath) || isGeneratedOrMinifiedJsonPath(lowerPath)) {
    return 'low-signal-json';
  }
  if (isHighSignalJsonPath(lowerPath)) {
    return size >= CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES ? 'high-signal-json-hard-cap' : undefined;
  }
  return size >= CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES ? 'generic-json-size' : undefined;
}

function isGeneratedOrMinifiedJsonPath(path: string): boolean {
  return /(?:^|\/)(?:gen|generated)(?:\/|$)/.test(path) || /(?:^|\/)[^/]+\.(?:generated|min)\.jsonc?$/.test(path);
}

function isHighSignalJsonPath(path: string): boolean {
  const name = Effect.pipe(path, EffectString.split('/')).at(-1) ?? '';
  return (
    name === 'package.json' ||
    name === 'project.json' ||
    name === 'workspace.json' ||
    name === 'nx.json' ||
    name === 'angular.json' ||
    /^tsconfig(?:\.[^/]*)?\.jsonc?$/.test(name) ||
    isRecognizedStructuredPath(path)
  );
}
