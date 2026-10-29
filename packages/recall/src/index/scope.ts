import {Array as EffectArray} from 'effect';
import {stripRecallAnchor} from './lexical.js';
import {trimTrailingCharacters} from '@threadnote/platform/string-boundaries';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export interface RecallSqlPredicate {
  readonly params: readonly string[];
  readonly restricted: boolean;
  readonly sql: string;
}

export type RecallWorkspaceScopeMode = 'hierarchy' | 'sibling';

export function combineRecallSqlPredicates(...predicates: readonly RecallSqlPredicate[]): RecallSqlPredicate {
  return {
    params: EffectArray.flatMap(predicates, predicate => predicate.params),
    restricted: EffectArray.some(predicates, predicate => predicate.restricted),
    sql: EffectArray.join(
      EffectArray.map(predicates, predicate => `(${predicate.sql})`),
      ' AND ',
    ),
  };
}

export function recallUriMatchesScopes(uri: string, scopes: readonly string[] | undefined): boolean {
  if (scopes === undefined || scopes.length === 0) return true;
  const documentUri = stripRecallAnchor(uri);
  return EffectArray.some(
    normalizeRecallUriScopes(scopes),
    scope => documentUri === scope || Effect.pipe(documentUri, EffectString.startsWith(`${scope}/`)),
  );
}

export function recallUriScopePredicate(
  alias: string,
  allowedUriScopes: readonly string[] | undefined,
): RecallSqlPredicate {
  return recallUriColumnScopePredicate(`${alias}.uri`, allowedUriScopes);
}

/** Keep stable-identity SQL bounded when authorized owned-memory scopes grow with history. */
export function recallIdentityUriScopePredicate(
  alias: string,
  allowedUriScopes: readonly string[] | undefined,
): RecallSqlPredicate {
  if (allowedUriScopes === undefined || allowedUriScopes.length === 0) {
    return {params: [], restricted: false, sql: '1 = 1'};
  }
  const scopes = normalizeRecallUriScopes(allowedUriScopes);
  if (scopes.length === 0) return {params: [], restricted: true, sql: '0 = 1'};
  // Preserve direct SQL binding of malformed UTF-16; its transport can differ from JSON decoding.
  if (EffectArray.some(scopes, scope => /[\uD800-\uDFFF]/u.test(scope)))
    return recallUriScopePredicate(alias, allowedUriScopes);
  return {
    params: [JSON.stringify(scopes)],
    restricted: true,
    sql: `EXISTS (
      SELECT 1 FROM json_each(?) AS identity_scope
      WHERE ${alias}.uri = identity_scope.value
         OR (${alias}.uri >= (identity_scope.value || '/') AND ${alias}.uri < (identity_scope.value || '0'))
    )`,
  };
}

/** Apply a canonical URI boundary to a denormalized URI column before a physical scan limit. */
export function recallUriColumnScopePredicate(
  column: string,
  allowedUriScopes: readonly string[] | undefined,
): RecallSqlPredicate {
  if (allowedUriScopes === undefined || allowedUriScopes.length === 0) {
    return {params: [], restricted: false, sql: '1 = 1'};
  }
  const scopes = normalizeRecallUriScopes(allowedUriScopes);
  if (scopes.length === 0) return {params: [], restricted: true, sql: '0 = 1'};
  const params: string[] = [];
  const clauses = EffectArray.map(scopes, scope => {
    const prefix = `${scope}/`;
    params.push(scope, prefix, `${scope}0`);
    return `(${column} = ? OR (${column} >= ? AND ${column} < ?))`;
  });
  return {params, restricted: true, sql: `(${EffectArray.join(clauses, ' OR ')})`};
}

export function recallWorkspaceScopeMatches(
  currentWorkspaceScope: string | undefined,
  candidateWorkspaceScope: string | undefined,
  mode: RecallWorkspaceScopeMode = 'hierarchy',
): boolean {
  if (currentWorkspaceScope === undefined) return true;
  const hierarchy = recallWorkspaceScopeHierarchy(currentWorkspaceScope);
  if (hierarchy.length === 0) return false;
  if (candidateWorkspaceScope === undefined) return mode === 'hierarchy';
  const candidate = normalizeRecallWorkspaceScope(candidateWorkspaceScope);
  if (candidate === undefined) return false;
  return mode === 'sibling' ? !hierarchy.includes(candidate) : hierarchy.includes(candidate);
}

export function recallWorkspaceScopePredicate(
  alias: string,
  currentWorkspaceScope: string | undefined,
  mode: RecallWorkspaceScopeMode = 'hierarchy',
): RecallSqlPredicate {
  if (currentWorkspaceScope === undefined) return {params: [], restricted: false, sql: '1 = 1'};
  const hierarchy = recallWorkspaceScopeHierarchy(currentWorkspaceScope);
  if (hierarchy.length === 0) return {params: [], restricted: true, sql: '0 = 1'};
  if (mode === 'sibling') {
    return {
      params: hierarchy,
      restricted: true,
      sql: `(${alias}.workspace_scope IS NOT NULL AND ${alias}.workspace_scope NOT IN (${EffectArray.join(
        EffectArray.map(hierarchy, () => '?'),
        ', ',
      )}))`,
    };
  }
  return {
    params: hierarchy,
    restricted: true,
    sql: `(${alias}.workspace_scope IS NULL OR ${alias}.workspace_scope IN (${EffectArray.join(
      EffectArray.map(hierarchy, () => '?'),
      ', ',
    )}))`,
  };
}

export function normalizeRecallWorkspaceScope(scope: string | undefined): string | undefined {
  if (scope === undefined) return undefined;
  const segments = EffectArray.filter(
    Effect.pipe(scope, EffectString.trim, EffectString.replaceAll('\\', '/'), EffectString.split('/')),
    segment => segment.length > 0 && segment !== '.',
  );
  if (segments.length === 0 || segments.includes('..')) return undefined;
  return Effect.pipe(EffectArray.join(segments, '/'), EffectString.toLowerCase);
}

export function normalizeRecallUriScopes(scopes: readonly string[]): readonly string[] {
  return [
    ...new Set(
      EffectArray.filter(
        EffectArray.map(scopes, scope =>
          Effect.pipe(trimTrailingCharacters(stripRecallAnchor(scope), '/'), EffectString.trim),
        ),
        Boolean,
      ),
    ),
  ];
}

function recallWorkspaceScopeHierarchy(scope: string | undefined): readonly string[] {
  const normalized = normalizeRecallWorkspaceScope(scope);
  if (!normalized) return [];
  const segments = Effect.pipe(normalized, EffectString.split('/'));
  return EffectArray.map(segments, (_segment, index) => EffectArray.join(segments.slice(0, index + 1), '/'));
}
