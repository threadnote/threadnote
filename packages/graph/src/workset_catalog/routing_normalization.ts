import type {CodeGraphWorksetRoutingSymbolV1} from './types.js';
import {normalizedTerms} from '../store/utilities.js';
import {compareCodeUnits} from '../ordering.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_GRAPH_WORKSET_ROUTING_EXACT_KEY_KINDS = [
  'lookup-key',
  'qualified-name',
  'name',
  'path',
  'path-suffix',
  'package',
] as const;

export type CodeGraphWorksetRoutingExactKeyKindV1 = (typeof CODE_GRAPH_WORKSET_ROUTING_EXACT_KEY_KINDS)[number];

export interface CodeGraphWorksetRoutingExactKeyV1 {
  readonly exactKey: string;
  readonly kind: CodeGraphWorksetRoutingExactKeyKindV1;
}

export interface CodeGraphWorksetRoutingTermsV1 {
  readonly terms: readonly string[];
  readonly truncated: boolean;
}

/** Keep this normalization identical to the router's exact-match comparison. */
export function normalizeCodeGraphWorksetRoutingExactKey(value: string): string {
  return Effect.pipe(
    value,
    EffectString.normalize('NFKC'),
    EffectString.trim,
    EffectString.replace(/\s+/gu, ' '),
    EffectString.toLowerCase,
  );
}

/**
 * Apply the graph store's index-time tokenizer while retaining query-specific
 * byte/count receipts. Splitting only at characters the tokenizer discards
 * avoids its per-call cap hiding later bounded query terms.
 */
export function normalizeCodeGraphWorksetRoutingTerms(
  value: string,
  options: {readonly maximumTermBytes: number; readonly maximumTerms: number},
): CodeGraphWorksetRoutingTermsV1 {
  const accepted = new Set<string>();
  let truncated = false;
  const lexicalChunks =
    Effect.pipe(value, __effectPipeInput => {
      const __effectPipeStage0 = Effect.pipe(__effectPipeInput, EffectString.normalize('NFKC'));
      const __effectPipeStage1 = Effect.pipe(
        __effectPipeStage0,
        EffectString.match(/[\p{L}\p{N}_$.-]+/gu),
        Effect.Option.getOrElse(() => null),
      );
      return __effectPipeStage1;
    }) ?? [];
  for (const chunk of lexicalChunks) {
    const terms = normalizedTerms(chunk);
    // normalizedTerms itself has the catalog's 32-term per-value storage cap.
    if (terms.length === 32) truncated = true;
    for (const term of terms) {
      if (Buffer.byteLength(term, 'utf8') > options.maximumTermBytes) {
        truncated = true;
        continue;
      }
      if (accepted.has(term)) continue;
      if (accepted.size >= options.maximumTerms) {
        truncated = true;
        continue;
      }
      accepted.add(term);
    }
  }
  return {terms: [...accepted], truncated};
}

/**
 * Build the index-only exact surface for one routing symbol. Path suffixes are
 * materialized at slash boundaries so suffix matching never needs `%...` SQL.
 */
export function codeGraphWorksetRoutingExactKeys(
  symbol: Pick<CodeGraphWorksetRoutingSymbolV1, 'lookupKeys' | 'name' | 'packageName' | 'path' | 'qualifiedName'>,
): readonly CodeGraphWorksetRoutingExactKeyV1[] {
  const keys = new Map<string, CodeGraphWorksetRoutingExactKeyV1>();
  const add = (kind: CodeGraphWorksetRoutingExactKeyKindV1, value: string | undefined): void => {
    if (value === undefined) return;
    const exactKey = normalizeCodeGraphWorksetRoutingExactKey(value);
    if (exactKey.length === 0) return;
    keys.set(`${kind}\0${exactKey}`, {exactKey, kind});
  };

  for (const lookupKey of symbol.lookupKeys) add('lookup-key', lookupKey);
  add('qualified-name', symbol.qualifiedName);
  add('name', symbol.name);
  add('package', symbol.packageName);
  const path = normalizeCodeGraphWorksetRoutingExactKey(symbol.path);
  add('path', path);
  for (
    let offset = Effect.pipe(
      path,
      EffectString.indexOf('/'),
      Effect.Option.getOrElse(() => -1),
    );
    offset >= 0;
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The native search position argument changes the search origin; Effect String has no position parameter.
    offset = path.indexOf('/', offset + 1)
  ) {
    add('path-suffix', Effect.pipe(path, EffectString.slice(offset + 1)));
  }

  return [...keys.values()].sort(
    (left, right) => compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.exactKey, right.exactKey),
  );
}
