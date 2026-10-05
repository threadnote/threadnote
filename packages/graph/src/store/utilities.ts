import {DateTime, Effect, Option} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {isFileLockTimeout} from '@threadnote/platform/file/lock';
import {compareCodeUnits} from '../ordering.js';
import {
  classifyCodeGraphStoreFailure,
  codeGraphStoreBusyFailure,
  sanitizeCodeGraphStoreDiagnostic as sanitizeStoreDiagnostic,
} from './failure.js';
import {
  type CodeGraphSymbol,
  type RepositoryIdentity,
  isCodeGraphStoreError,
  type CodeGraphStoreFailure,
} from '../types.js';

const upsertRepository = Effect.fn('codeGraph.upsertRepository')(function* (
  sql: SqlClient.SqlClient,
  identity: RepositoryIdentity,
) {
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
    VALUES (${identity.repositoryId}, ${identity.displayName}, ${identity.objectFormat}, ${now}, ${now})
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      object_format = excluded.object_format,
      last_used_at = excluded.last_used_at
  `;
});

function symbolTerms(symbol: CodeGraphSymbol): readonly (readonly [string, number])[] {
  const weighted = new Map<string, number>();
  addTerms(weighted, symbol.name, 5);
  addTerms(weighted, symbol.qualifiedName, 4);
  addTerms(weighted, symbol.path, 3);
  addTerms(weighted, symbol.packageName ?? '', 3);
  addTerms(weighted, symbol.signature ?? '', 2);
  addTerms(weighted, symbol.documentation ?? '', 1);
  return [...weighted].sort(([left], [right]) => compareCodeUnits(left, right));
}

function addTerms(target: Map<string, number>, value: string, weight: number): void {
  for (const term of normalizedTerms(value)) {
    target.set(term, Math.max(target.get(term) ?? 0, weight));
  }
}

export function normalizedTerms(value: string): readonly string[] {
  const expanded = value
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  return [...new Set(expanded.match(/[\p{L}\p{N}_$.-]{2,}/gu) ?? [])].slice(0, 32);
}

/** Preserve explicit code identities embedded in a longer natural-language query. */
export function codeGraphIdentitySelectors(value: string): readonly string[] {
  const candidates =
    value
      .normalize('NFKC')
      .replaceAll('\\', '/')
      .match(/[\p{L}\p{N}_$@./:-]{2,}/gu) ?? [];
  const selectors = candidates.flatMap(candidate => {
    if (candidate.includes('/')) return [];
    const identityBearing =
      /[\p{L}\p{N}_$][.:][\p{L}\p{N}_$]/u.test(candidate) ||
      /[_$]/u.test(candidate) ||
      /[\p{Ll}\p{N}][\p{Lu}]/u.test(candidate);
    if (!identityBearing) return [];
    const leaf = candidate.split(/[.:]/u).at(-1);
    return leaf && leaf !== candidate && /[_$]|[\p{Ll}\p{N}][\p{Lu}]/u.test(leaf) ? [candidate, leaf] : [candidate];
  });
  return [...new Set(selectors)].slice(0, 8);
}

function sqlTextOption(value: unknown): Option.Option<string> {
  return typeof value === 'string' ? Option.some(value) : Option.none();
}

function boundedPageLimit(value: number): number {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(2_000, value)) : 500;
}

function boundedVisualizationCatalogLimit(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined || !Number.isSafeInteger(value)
    ? fallback
    : Math.max(1, Math.min(maximum, Math.floor(value)));
}

function boundedVisualizationCatalogOffset(value: number | undefined): number {
  return value === undefined || !Number.isSafeInteger(value) ? 0 : Math.max(0, Math.min(1_000_000, Math.floor(value)));
}

function boundedVisualizationCatalogQuery(value: Option.Option<string> | undefined): string {
  return Option.getOrElse(value ?? Option.none(), () => '')
    .trim()
    .slice(0, 256);
}

function boundedAggregatePageLimit(value: number): number {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(250_000, value)) : 50_000;
}

function* chunk<const Value>(values: readonly Value[], size: number): Generator<readonly Value[]> {
  for (let index = 0; index < values.length; index += size) yield values.slice(index, index + size);
}

function sortedBy<Value>(values: readonly Value[], key: (value: Value) => string): readonly Value[] {
  return [...values].sort((left, right) => compareCodeUnits(key(left), key(right)));
}

function uniqueBy<Value>(values: readonly Value[], key: (value: Value) => string): readonly Value[] {
  const output = new Map<string, Value>();
  for (const value of values) {
    const identity = key(value);
    if (!output.has(identity)) output.set(identity, value);
  }
  return [...output.values()];
}

function parseLookupKeys(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 4_096))]
      : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 100) : [];
  } catch {
    return [];
  }
}

function lookupDomain(key: string, fallback: string | undefined): string {
  const separator = key.indexOf(':');
  return separator > 0 ? key.slice(0, separator) : (fallback ?? 'generic');
}

function activationEdgeId(
  sourceId: string | undefined,
  sourceName: string,
  relation: string,
  targetId: string | undefined,
  targetName: string,
  provenance: string,
  path: string,
): string {
  return `cge_${sha256HexSync(
    `edge-v1\n${sourceId ?? sourceName}\n${relation}\n${targetId ?? targetName}\n${provenance}\n${path}`,
  ).slice(0, 32)}`;
}

function storeError(operation: string, cause: unknown): CodeGraphStoreFailure {
  if (isCodeGraphStoreError(cause)) return cause;
  return isFileLockTimeout(cause)
    ? codeGraphStoreBusyFailure(operation)
    : classifyCodeGraphStoreFailure(operation, cause);
}

/** Keep SQLite diagnostics useful without persisting paths, statement values, or unbounded native output. */
export function sanitizeCodeGraphStoreDiagnostic(value: string): string {
  return sanitizeStoreDiagnostic(value);
}

export {
  chunk,
  sqlTextOption,
  sortedBy,
  uniqueBy,
  upsertRepository,
  boundedPageLimit,
  lookupDomain,
  boundedVisualizationCatalogLimit,
  boundedVisualizationCatalogOffset,
  boundedVisualizationCatalogQuery,
  boundedAggregatePageLimit,
  parseLookupKeys,
  addTerms,
  symbolTerms,
  parseStringArray,
  activationEdgeId,
  storeError,
};
