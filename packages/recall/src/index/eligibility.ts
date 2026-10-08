import type {MemoryAuthority, MemoryTrust} from '@threadnote/memory/document';
import {normalizeRecallProject, recallAuthorityIsEligible, type RecallEligibilityPolicy} from '../eligibility.js';
import type {RecallSqlPredicate} from './scope.js';

export function recallApprovedAuthoritative(
  authority: MemoryAuthority | undefined,
  trust: MemoryTrust | undefined,
): boolean {
  return recallAuthorityIsEligible('approved-authoritative', authority, trust);
}

/**
 * Builds the lexical-index predicate used before posting, exact-match, sample,
 * and corpus-statistics limits. Pinned recall remains governed by its separate
 * URI predicate and deliberately adds no metadata restriction here.
 */
export function recallEligibilityPredicate(
  alias: string,
  policy: RecallEligibilityPolicy | undefined,
  externalHashExpression: string | false = `json_extract(${alias}.candidate_json, '$.contentHash')`,
): RecallSqlPredicate {
  const root = 'threadnote://resources/external/superhuman';
  const outside = `(${alias}.uri <> ? AND (${alias}.uri < ? OR ${alias}.uri >= ?))`;
  const access = policy?.externalResources ?? {};
  const externalPredicate =
    Object.keys(access).length === 0
      ? outside
      : `(${outside} OR EXISTS (SELECT 1 FROM json_each(?) AS external_access WHERE external_access.key = ${alias}.uri ${externalHashExpression === false ? '' : `AND external_access.value = ${externalHashExpression}`}))`;
  const externalParams = [
    root,
    `${root}/`,
    `${root}0`,
    ...(Object.keys(access).length === 0 ? [] : [JSON.stringify(access)]),
  ];
  if (policy === undefined || policy.kind === 'pinned-hard-uri-bypass') {
    return {params: externalParams, restricted: true, sql: externalPredicate};
  }
  if (policy.projects.mode === 'deny-all') {
    return {params: [], restricted: true, sql: '0 = 1'};
  }

  const predicates: string[] = [externalPredicate];
  const params: string[] = externalParams;
  if (policy.projects.mode === 'projectless-only') {
    predicates.push(`${alias}.project IS NULL`);
  } else if (policy.projects.mode === 'allow-projects-and-projectless') {
    const projects = policy.projects.projects
      .map(normalizeRecallProject)
      .filter((project): project is string => project !== undefined);
    if (projects.length === 0) {
      return {params: [], restricted: true, sql: '0 = 1'};
    }
    predicates.push(`(${alias}.project IS NULL OR ${alias}.project IN (${projects.map(() => '?').join(', ')}))`);
    params.push(...projects);
  }
  if (policy.authority === 'approved-authoritative') {
    predicates.push(`${alias}.approved_authoritative = 1`);
  }
  return predicates.length === 0
    ? {params: [], restricted: false, sql: '1 = 1'}
    : {params, restricted: true, sql: predicates.join(' AND ')};
}
