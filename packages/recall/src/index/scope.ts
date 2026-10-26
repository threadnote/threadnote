import {stripRecallAnchor} from './lexical.js';
import {trimTrailingCharacters} from '@threadnote/platform/string-boundaries';

export interface RecallSqlPredicate {
  readonly params: readonly string[];
  readonly restricted: boolean;
  readonly sql: string;
}

export type RecallWorkspaceScopeMode = 'hierarchy' | 'sibling';

export function combineRecallSqlPredicates(...predicates: readonly RecallSqlPredicate[]): RecallSqlPredicate {
  return {
    params: predicates.flatMap(predicate => predicate.params),
    restricted: predicates.some(predicate => predicate.restricted),
    sql: predicates.map(predicate => `(${predicate.sql})`).join(' AND '),
  };
}

export function recallUriMatchesScopes(uri: string, scopes: readonly string[] | undefined): boolean {
  if (scopes === undefined || scopes.length === 0) return true;
  const documentUri = stripRecallAnchor(uri);
  return normalizeRecallUriScopes(scopes).some(scope => documentUri === scope || documentUri.startsWith(`${scope}/`));
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
  if (scopes.some(scope => /[\uD800-\uDFFF]/u.test(scope))) return recallUriScopePredicate(alias, allowedUriScopes);
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
  const clauses = scopes.map(scope => {
    const prefix = `${scope}/`;
    params.push(scope, prefix, `${scope}0`);
    return `(${column} = ? OR (${column} >= ? AND ${column} < ?))`;
  });
  return {params, restricted: true, sql: `(${clauses.join(' OR ')})`};
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
      sql: `(${alias}.workspace_scope IS NOT NULL AND ${alias}.workspace_scope NOT IN (${hierarchy.map(() => '?').join(', ')}))`,
    };
  }
  return {
    params: hierarchy,
    restricted: true,
    sql: `(${alias}.workspace_scope IS NULL OR ${alias}.workspace_scope IN (${hierarchy.map(() => '?').join(', ')}))`,
  };
}

export function normalizeRecallWorkspaceScope(scope: string | undefined): string | undefined {
  if (scope === undefined) return undefined;
  const segments = scope
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .filter(segment => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return undefined;
  return segments.join('/').toLowerCase();
}

export function normalizeRecallUriScopes(scopes: readonly string[]): readonly string[] {
  return [
    ...new Set(scopes.map(scope => trimTrailingCharacters(stripRecallAnchor(scope), '/').trim()).filter(Boolean)),
  ];
}

function recallWorkspaceScopeHierarchy(scope: string | undefined): readonly string[] {
  const normalized = normalizeRecallWorkspaceScope(scope);
  if (!normalized) return [];
  const segments = normalized.split('/');
  return segments.map((_segment, index) => segments.slice(0, index + 1).join('/'));
}
