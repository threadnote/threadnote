import {Effect, FileSystem} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {recallCandidateIsEligible, type RecallEligibilityPolicy} from './eligibility.js';
import {recallEligibilityPredicate} from './index/eligibility.js';
import {
  combineRecallSqlPredicates,
  normalizeRecallUriScopes,
  recallUriMatchesScopes,
  recallUriScopePredicate,
  recallWorkspaceScopeMatches,
  recallWorkspaceScopePredicate,
  type RecallWorkspaceScopeMode,
} from './index/scope.js';
import {recallProjectMatches, recallProjectPredicate} from './index/selection.js';

export const MAX_RECALL_CODE_LINK_ANCHORS = 8;
export const MAX_RECALL_CODE_LINK_RESULTS = 24;
const RECALL_CODE_LINK_CANONICAL_BACKFILL_FACTOR = 4;

export type RecallCodeLinkAnchor = MemoryCodeCitationV1;

export type RecallCodeLinkMatchKind = 'file-content' | 'file-path' | 'symbol-locator' | 'symbol-node';

export interface RecallCodeLinkMatch {
  /** Zero-based ordinal in the caller's bounded anchor list. */
  readonly anchorOrdinal: number;
  /** Stable ID recovered from the selected memory's canonical source document. */
  readonly citationId: string;
  readonly citationOrdinal: number;
  readonly matchKind: RecallCodeLinkMatchKind;
  readonly uri: string;
}

export interface RecallCodeLinkQueryOptions {
  readonly allowedUriScopes?: readonly string[];
  readonly anchors: readonly RecallCodeLinkAnchor[];
  readonly eligibility?: RecallEligibilityPolicy;
  readonly includeInactive?: boolean;
  readonly limit?: number;
  /** @internal Lets the loader repair a canonical/index race exactly once. */
  readonly onCanonicalMismatch?: (count: number) => void;
  /** Reports selector lanes that deliberately abstained after the bounded raw scan could not fill their lane. */
  readonly onSearchTruncated?: (selectorCount: number) => void;
  readonly project?: string;
  readonly workspaceScope?: string;
  readonly workspaceScopeMode?: RecallWorkspaceScopeMode;
}

export interface IndexedRecallCodeLink {
  readonly citationOrdinal: number;
  readonly selectorDigest: string;
  readonly selectorKind: RecallCodeLinkMatchKind;
}

export interface RecallCodeLinkQuerySelector {
  readonly anchorId: string;
  readonly anchorOrdinal: number;
  readonly selectorDigest: string;
  readonly selectorKind: RecallCodeLinkMatchKind;
}

/**
 * Opaque selector material shared by local and remote derived backlink indexes.
 * The inputs are only used to derive the digest; callers must never persist them
 * alongside the result.
 */
export interface RecallCodeLinkSelectorInput {
  readonly repositoryId: string;
  readonly repositoryIdentityKind: MemoryCodeCitationV1['repositoryIdentityKind'];
  readonly selectorKind: RecallCodeLinkMatchKind;
  readonly value: unknown;
}

interface RecallCodeLinkSelectionRow {
  readonly anchor_id: string;
  readonly anchor_ordinal: number;
  readonly citation_ordinal: number;
  readonly match_kind: RecallCodeLinkMatchKind;
  readonly selector_digest: string;
  readonly source_path: string;
  readonly uri: string;
}

interface RecallCodeLinkRawSelectionRow {
  readonly citation_ordinal: number;
  readonly document_id: number;
  readonly document_uri: string;
}

export interface RecallCodeLinkRawSelectionQuery {
  readonly params: readonly (number | string)[];
  readonly sql: string;
}

interface RecallCodeLinkFairSelectionRow extends RecallCodeLinkSelectionRow {
  readonly anchor_rank: number;
  readonly match_rank: number;
}

const MATCH_KIND_RANK: Readonly<Record<RecallCodeLinkMatchKind, number>> = {
  'symbol-node': 0,
  'symbol-locator': 1,
  'file-path': 2,
  'file-content': 3,
};

/**
 * Project citation metadata into opaque, repository-scoped selectors. Raw
 * paths, graph IDs, symbol names, and content hashes never enter the index.
 */
export function deriveIndexedRecallCodeLinks(
  citations: readonly MemoryCodeCitationV1[],
): readonly IndexedRecallCodeLink[] {
  return citations.flatMap((citation, citationOrdinal) =>
    selectorsForCitation(citation).map(selector => ({citationOrdinal, ...selector})),
  );
}

/** Anchor permutations produce the same selector kind/digest set. */
export function deriveRecallCodeLinkQuerySelectors(
  anchors: readonly RecallCodeLinkAnchor[],
): readonly RecallCodeLinkQuerySelector[] {
  const selected = new Map<string, RecallCodeLinkQuerySelector>();
  for (const [anchorOrdinal, anchor] of anchors.slice(0, MAX_RECALL_CODE_LINK_ANCHORS).entries()) {
    for (const selector of selectorsForCitation(anchor)) {
      const key = `${selector.selectorKind}:${selector.selectorDigest}`;
      const current = selected.get(key);
      if (
        !current ||
        anchorOrdinal < current.anchorOrdinal ||
        (anchorOrdinal === current.anchorOrdinal && compareText(anchor.id, current.anchorId) < 0)
      ) {
        selected.set(key, {anchorId: anchor.id, anchorOrdinal, ...selector});
      }
    }
  }
  return [...selected.values()].sort(compareQuerySelectors);
}

export const selectRecallCodeLinks = Effect.fn('recall.selectCodeLinks')(function* (
  sql: SqlClient.SqlClient,
  options: RecallCodeLinkQueryOptions,
) {
  const selectors = deriveRecallCodeLinkQuerySelectors(options.anchors);
  const limit = boundedRecallCodeLinkLimit(options.limit);
  if (selectors.length === 0 || limit === 0) return [] satisfies readonly RecallCodeLinkMatch[];
  const scanLimit = limit * RECALL_CODE_LINK_CANONICAL_BACKFILL_FACTOR;

  const scope = combineRecallSqlPredicates(
    recallUriScopePredicate('document', options.allowedUriScopes),
    recallEligibilityPredicate('document', options.eligibility),
    recallProjectPredicate('document', options.project),
    recallWorkspaceScopePredicate('document', options.workspaceScope, options.workspaceScopeMode),
  );
  const selectorParameters = selectors.flatMap(selector => [
    selector.selectorKind,
    selector.selectorDigest,
    selector.anchorId,
    selector.anchorOrdinal,
    MATCH_KIND_RANK[selector.selectorKind],
  ]);
  const rowsByAnchor = new Map<number, RecallCodeLinkSelectionRow[]>();
  let truncatedSelectorCount = 0;
  for (const selector of selectors) {
    const anchorRows = rowsByAnchor.get(selector.anchorOrdinal) ?? [];
    const remaining = scanLimit - anchorRows.length;
    if (remaining <= 0) continue;
    const rawRows = yield* selectBoundedRawCodeLinkRows(sql, selector, options.allowedUriScopes, scanLimit + 1);
    const rawSearchHasMore = rawRows.length > scanLimit;
    const boundedRawRows = rawRows.slice(0, scanLimit);
    if (boundedRawRows.length === 0) continue;
    const selectorRows = yield* sql.unsafe<RecallCodeLinkSelectionRow>(
      `WITH query_selectors(selector_kind, selector_digest, anchor_id, anchor_ordinal, match_rank) AS (
         VALUES ${selectors.map(() => '(?, ?, ?, ?, ?)').join(', ')}
       ),
       current_selector(selector_kind, selector_digest, anchor_id, anchor_ordinal, match_rank) AS (
         VALUES (?, ?, ?, ?, ?)
       ),
       candidate_links(document_id, document_uri, citation_ordinal) AS (
         VALUES ${boundedRawRows.map(() => '(?, ?, ?)').join(', ')}
       )
       SELECT
         document.uri,
         document.source_path,
         code_link.citation_ordinal,
         current.anchor_id,
         current.anchor_ordinal,
         current.selector_kind AS match_kind,
         current.selector_digest
       FROM current_selector AS current
       INNER JOIN candidate_links AS code_link ON 1 = 1
       INNER JOIN documents AS document
         ON document.id = code_link.document_id
        AND document.uri = code_link.document_uri
       WHERE ${scope.sql}
         AND json_extract(document.candidate_json, '$.kind') IN ('durable', 'handoff')
         AND ${options.includeInactive === true ? '1 = 1' : "COALESCE(json_extract(document.candidate_json, '$.status'), 'active') = 'active'"}
         AND NOT EXISTS (
           SELECT 1
           FROM code_links AS better_link
           INNER JOIN query_selectors AS better
             ON better.selector_kind = better_link.selector_kind
            AND better.selector_digest = better_link.selector_digest
           WHERE better_link.document_id = code_link.document_id
             AND (
               better.match_rank < current.match_rank
               OR (better.match_rank = current.match_rank AND better_link.citation_ordinal < code_link.citation_ordinal)
               OR (
                 better.match_rank = current.match_rank
                 AND better_link.citation_ordinal = code_link.citation_ordinal
                 AND better.anchor_ordinal < current.anchor_ordinal
               )
               OR (
                 better.match_rank = current.match_rank
                 AND better_link.citation_ordinal = code_link.citation_ordinal
                 AND better.anchor_ordinal = current.anchor_ordinal
                 AND better.anchor_id COLLATE BINARY < current.anchor_id COLLATE BINARY
               )
               OR (
                 better.match_rank = current.match_rank
                 AND better_link.citation_ordinal = code_link.citation_ordinal
                 AND better.anchor_ordinal = current.anchor_ordinal
                 AND better.anchor_id = current.anchor_id
                 AND better.selector_digest COLLATE BINARY < current.selector_digest COLLATE BINARY
               )
             )
         )
       ORDER BY document.uri COLLATE BINARY, code_link.citation_ordinal, document.id
       LIMIT ?`,
      [
        ...selectorParameters,
        selector.selectorKind,
        selector.selectorDigest,
        selector.anchorId,
        selector.anchorOrdinal,
        MATCH_KIND_RANK[selector.selectorKind],
        ...boundedRawRows.flatMap(row => [row.document_id, row.document_uri, row.citation_ordinal]),
        ...scope.params,
        remaining,
      ],
    );
    if (rawSearchHasMore && selectorRows.length < remaining) truncatedSelectorCount += 1;
    anchorRows.push(...selectorRows);
    rowsByAnchor.set(selector.anchorOrdinal, anchorRows);
  }
  if (truncatedSelectorCount > 0) options.onSearchTruncated?.(truncatedSelectorCount);
  const rows = [...rowsByAnchor.values()]
    .flatMap(rowsForAnchor =>
      rowsForAnchor.map((row, anchorRank): RecallCodeLinkFairSelectionRow => ({
        ...row,
        anchor_rank: anchorRank + 1,
        match_rank: MATCH_KIND_RANK[row.match_kind],
      })),
    )
    .sort(compareFairSelectionRows)
    .slice(0, scanLimit);
  const fs = yield* FileSystem.FileSystem;
  const matches = yield* Effect.forEach(
    rows,
    row =>
      fs.readFileString(row.source_path).pipe(
        Effect.map(content => {
          const record = parseMemoryDocument(row.uri, content);
          if (!canonicalRecordMatchesQuery(row.uri, record, options)) return undefined;
          const citation = record.metadata.codeCitations?.[row.citation_ordinal];
          const citationStillMatches =
            citation !== undefined &&
            deriveIndexedRecallCodeLinks([citation]).some(
              selector => selector.selectorKind === row.match_kind && selector.selectorDigest === row.selector_digest,
            );
          return citationStillMatches
            ? ({
                anchorOrdinal: row.anchor_ordinal,
                citationId: citation.id,
                citationOrdinal: row.citation_ordinal,
                matchKind: row.match_kind,
                uri: row.uri,
              } satisfies RecallCodeLinkMatch)
            : undefined;
        }),
        Effect.orElseSucceed(() => undefined),
      ),
    {concurrency: 4},
  );
  const selected = matches.filter((match): match is RecallCodeLinkMatch => match !== undefined);
  const canonicalMismatchCount = matches.length - selected.length;
  if (canonicalMismatchCount > 0) options.onCanonicalMismatch?.(canonicalMismatchCount);
  return selected.slice(0, limit);
});

const selectBoundedRawCodeLinkRows = Effect.fn('recall.selectBoundedRawCodeLinkRows')(function* (
  sql: SqlClient.SqlClient,
  selector: RecallCodeLinkQuerySelector,
  allowedUriScopes: readonly string[] | undefined,
  queryLimit: number,
) {
  const pages = yield* Effect.forEach(
    buildBoundedRecallCodeLinkRawQueries(selector, allowedUriScopes, queryLimit),
    query => sql.unsafe<RecallCodeLinkRawSelectionRow>(query.sql, query.params),
    {concurrency: 1},
  );
  const selected = new Map<string, RecallCodeLinkRawSelectionRow>();
  for (const row of pages.flat()) {
    selected.set(`${row.document_id}:${row.citation_ordinal}`, row);
  }
  return [...selected.values()].sort(compareRawSelectionRows).slice(0, queryLimit);
});

/** @internal Build separately seekable exact/descendant URI lanes for the bounded raw selector scan. */
export function buildBoundedRecallCodeLinkRawQueries(
  selector: RecallCodeLinkQuerySelector,
  allowedUriScopes: readonly string[] | undefined,
  queryLimit: number,
): readonly RecallCodeLinkRawSelectionQuery[] {
  const boundedLimit = Math.max(0, Math.floor(queryLimit));
  if (!Number.isSafeInteger(boundedLimit) || boundedLimit === 0) return [];
  const select = `SELECT code_link.document_id, code_link.document_uri, code_link.citation_ordinal
    FROM code_links AS code_link INDEXED BY code_links_selector_uri
    WHERE code_link.selector_kind = ? AND code_link.selector_digest = ?`;
  const order = `ORDER BY code_link.document_uri COLLATE BINARY, code_link.citation_ordinal, code_link.document_id
    LIMIT ?`;
  if (allowedUriScopes === undefined || allowedUriScopes.length === 0) {
    return [
      {
        params: [selector.selectorKind, selector.selectorDigest, boundedLimit],
        sql: `${select}\n    ${order}`,
      },
    ];
  }
  const scopes = minimalRecallUriScopes(normalizeRecallUriScopes(allowedUriScopes));
  return scopes.flatMap(scope => [
    {
      params: [selector.selectorKind, selector.selectorDigest, scope, boundedLimit],
      sql: `${select}\n      AND code_link.document_uri = ?\n    ${order}`,
    },
    {
      params: [selector.selectorKind, selector.selectorDigest, `${scope}/`, `${scope}0`, boundedLimit],
      sql: `${select}\n      AND code_link.document_uri >= ? AND code_link.document_uri < ?\n    ${order}`,
    },
  ]);
}

function canonicalRecordMatchesQuery(
  uri: string,
  record: ReturnType<typeof parseMemoryDocument>,
  options: RecallCodeLinkQueryOptions,
): record is NonNullable<ReturnType<typeof parseMemoryDocument>> {
  return (
    record !== undefined &&
    (record.metadata.kind === 'durable' || record.metadata.kind === 'handoff') &&
    (options.includeInactive === true || record.metadata.status === 'active') &&
    recallUriMatchesScopes(uri, options.allowedUriScopes) &&
    recallProjectMatches(options.project, record.metadata.project) &&
    recallWorkspaceScopeMatches(options.workspaceScope, record.metadata.workspaceScope, options.workspaceScopeMode) &&
    (options.eligibility === undefined || recallCandidateIsEligible(options.eligibility, record.metadata))
  );
}

function selectorsForCitation(
  citation: MemoryCodeCitationV1,
): readonly Omit<IndexedRecallCodeLink, 'citationOrdinal'>[] {
  const selectorInputs: Array<readonly [RecallCodeLinkMatchKind, unknown]> = [
    ['file-path', citation.path],
    ['file-content', citation.fileContentHash.value],
  ];
  if (citation.target.kind === 'symbol') {
    selectorInputs.push(
      ['symbol-node', citation.target.nodeId],
      [
        'symbol-locator',
        {
          kind: citation.target.symbolKind,
          language: citation.target.language,
          name: citation.target.name,
          qualifiedName: citation.target.qualifiedName,
          version: 1,
        },
      ],
    );
  }
  return selectorInputs
    .map(([selectorKind, value]) => ({
      selectorDigest: deriveRecallCodeLinkSelectorDigest({
        repositoryId: citation.repositoryId,
        repositoryIdentityKind: citation.repositoryIdentityKind,
        selectorKind,
        value,
      }),
      selectorKind,
    }))
    .sort(compareIndexedSelectors);
}

/** Derive the stable opaque selector digest used by rebuildable backlink indexes. */
export function deriveRecallCodeLinkSelectorDigest(input: RecallCodeLinkSelectorInput): string {
  return sha256HexSync(
    JSON.stringify({
      repositoryId: input.repositoryId,
      repositoryIdentityKind: input.repositoryIdentityKind,
      selector: {kind: input.selectorKind, value: input.value},
      version: 1,
    }),
  );
}

function boundedRecallCodeLinkLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_RECALL_CODE_LINK_RESULTS;
  if (!Number.isFinite(limit)) return 0;
  return Math.min(MAX_RECALL_CODE_LINK_RESULTS, Math.max(0, Math.floor(limit)));
}

function minimalRecallUriScopes(scopes: readonly string[]): readonly string[] {
  const ordered = [...scopes].sort((left, right) => left.length - right.length || compareText(left, right));
  return ordered.filter(
    scope => !ordered.some(candidate => candidate.length < scope.length && scope.startsWith(`${candidate}/`)),
  );
}

function compareRawSelectionRows(left: RecallCodeLinkRawSelectionRow, right: RecallCodeLinkRawSelectionRow): number {
  return (
    compareText(left.document_uri, right.document_uri) ||
    left.citation_ordinal - right.citation_ordinal ||
    left.document_id - right.document_id
  );
}

function compareIndexedSelectors(
  left: Omit<IndexedRecallCodeLink, 'citationOrdinal'>,
  right: Omit<IndexedRecallCodeLink, 'citationOrdinal'>,
): number {
  return (
    MATCH_KIND_RANK[left.selectorKind] - MATCH_KIND_RANK[right.selectorKind] ||
    compareText(left.selectorDigest, right.selectorDigest)
  );
}

function compareQuerySelectors(left: RecallCodeLinkQuerySelector, right: RecallCodeLinkQuerySelector): number {
  return (
    MATCH_KIND_RANK[left.selectorKind] - MATCH_KIND_RANK[right.selectorKind] ||
    compareText(left.selectorDigest, right.selectorDigest) ||
    left.anchorOrdinal - right.anchorOrdinal ||
    compareText(left.anchorId, right.anchorId)
  );
}

function compareFairSelectionRows(left: RecallCodeLinkFairSelectionRow, right: RecallCodeLinkFairSelectionRow): number {
  return (
    left.anchor_rank - right.anchor_rank ||
    left.match_rank - right.match_rank ||
    left.anchor_ordinal - right.anchor_ordinal ||
    compareText(left.uri, right.uri) ||
    left.citation_ordinal - right.citation_ordinal ||
    compareText(left.anchor_id, right.anchor_id)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
