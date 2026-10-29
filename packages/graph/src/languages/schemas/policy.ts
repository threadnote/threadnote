import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const LOW_SIGNAL_STRUCTURED_PATH =
  /(?:^|\/)_*(?:snapshots?|golden[-_]data|goldens?|fixtures?|oplogs?|evaluations?|evals?|datasets?|test[-_]?data|animations?)_*(?:\/|$)|(?:^|\/)[^/]*(?:snapshot|golden|fixture|oplog|evaluation|dataset|animation)[^/]*\.(?:jsonc?|ya?ml)$/i;

const RECOGNIZED_STRUCTURED_PATH =
  /(?:^|\/)(?:configs?|configuration|schemas?|settings|openapi|swagger|specifications?)(?:\/|$)|(?:^|\/)[^/]*(?:config|schema|settings|openapi|swagger|specification)[^/]*\.(?:jsonc?|ya?ml)$/i;

export function isLowSignalStructuredPath(path: string): boolean {
  return LOW_SIGNAL_STRUCTURED_PATH.test(path);
}

export function isRecognizedStructuredPath(path: string): boolean {
  return RECOGNIZED_STRUCTURED_PATH.test(path);
}

export const GENERIC_STRUCTURED_DECLARATION_LIMIT = 256;
export const RECOGNIZED_STRUCTURED_DECLARATION_LIMIT = 2_048;
export const RESOURCE_STRUCTURED_DECLARATION_LIMIT = 512;

export interface StructuredObjectDeclarationBudget {
  readonly maximumDepth: number;
  /** Excludes the always-present file module symbol. */
  readonly maximumDeclarations: number;
  readonly policy: 'generic' | 'recognized' | 'resource';
}

/**
 * Generic JSON/YAML is useful as a bounded shape, not as an exhaustive leaf-property database.
 * Recognized configs and resource wiring retain a larger declaration surface.
 */
export function structuredObjectDeclarationBudget(path: string): StructuredObjectDeclarationBudget {
  if (isXcodeAssetContentsPath(path)) {
    return {maximumDeclarations: RESOURCE_STRUCTURED_DECLARATION_LIMIT, maximumDepth: 16, policy: 'resource'};
  }
  if (isRecognizedStructuredPath(path)) {
    return {maximumDeclarations: RECOGNIZED_STRUCTURED_DECLARATION_LIMIT, maximumDepth: 32, policy: 'recognized'};
  }
  return {maximumDeclarations: GENERIC_STRUCTURED_DECLARATION_LIMIT, maximumDepth: 8, policy: 'generic'};
}

export function isXcodeAssetContentsPath(path: string): boolean {
  const segments = Effect.pipe(path, EffectString.split('/'));
  if (
    segments.length < 3 ||
    Effect.pipe(segments.at(-1), effectOptionalString =>
      effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.toLowerCase),
    ) !== 'contents.json'
  )
    return false;
  return EffectArray.some(segments.slice(0, -2), segment =>
    Effect.pipe(segment, EffectString.toLowerCase, EffectString.endsWith('.xcassets')),
  );
}
