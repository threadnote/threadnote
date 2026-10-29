import type {CodeGraphRelation, CodeGraphSymbol} from '../types.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function documentLookupTiers(targetName: string): readonly (readonly string[])[] {
  return Effect.pipe(targetName, EffectString.includes('/'))
    ? [[`global:path:${lookupComponent(targetName)}`]]
    : [[`global:qualified:${lookupComponent(targetName)}`], [`global:name:${lookupComponent(lastName(targetName))}`]];
}

export function resolveLegacyDocumentReference(
  targetName: string,
  byLookupKey: ReadonlyMap<string, readonly CodeGraphSymbol[]>,
): CodeGraphSymbol | undefined {
  return resolveLookupTiers(documentLookupTiers(targetName), 'global', byLookupKey, 'documents');
}

export function resolveLookupTiers(
  lookupTiers: readonly (readonly string[])[],
  resolutionDomain: string,
  byLookupKey: ReadonlyMap<string, readonly CodeGraphSymbol[]>,
  relation: CodeGraphRelation,
  sourceId?: string,
  exportedOnly = false,
): CodeGraphSymbol | undefined {
  for (const tier of lookupTiers) {
    const candidates = new Map<string, CodeGraphSymbol>();
    for (const key of tier) {
      for (const symbol of byLookupKey.get(key) ?? []) {
        if (relation === 'overrides' && symbol.id === sourceId) continue;
        if (exportedOnly && !symbol.exported) continue;
        if (lookupKeyResolutionDomain(key, symbol.resolutionDomain) === resolutionDomain) {
          candidates.set(symbol.id, symbol);
        }
      }
    }
    if (candidates.size === 1) return candidates.values().next().value;
    if (candidates.size > 1) return undefined;
  }
  return undefined;
}

function lookupKeyResolutionDomain(key: string, fallback: string | undefined): string {
  const separator = Effect.pipe(
    key,
    EffectString.indexOf(':'),
    Effect.Option.getOrElse(() => -1),
  );
  return separator > 0 ? Effect.pipe(key, EffectString.slice(0, separator)) : (fallback ?? 'generic');
}

function lookupComponent(value: string): string {
  return encodeURIComponent(value);
}

function lastName(value: string): string {
  return Effect.pipe(value, EffectString.split('.')).at(-1) ?? value;
}
