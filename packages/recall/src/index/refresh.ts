import {Crypto, Effect, FileSystem, Option, Path, Schema} from 'effect';
import {SEED_STATE_FILE} from '@threadnote/workspace/constants';
import {sha256Hex} from '@threadnote/platform/digest';
import {SystemInfo} from '@threadnote/platform/system';
import {parseSeedManifest} from '@threadnote/workspace/manifest';
import type {ProjectManifest} from '@threadnote/workspace/config';
import {globToRegExp} from '@threadnote/platform/glob';
import {expandPath} from '@threadnote/platform/paths';
import * as SqlClient from 'effect/sql/SqlClient';
import {forEachFileWithinBoundary} from '@threadnote/platform/safe_scan';
import {uriSegment} from '@threadnote/workspace/manifest';
import {canonicalResourceUri, parseResourceId} from '@threadnote/store/resource-id';
import {
  isExternalResourceUri,
  loadExternalResourceAccess,
  parseExternalResourceIdentity,
  readExternalDocumentManifest,
} from '@threadnote/store/external-resource';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {indexCandidate} from './candidate.js';
import type {IndexedRecallCodeLink} from '../code_links.js';
import {memoryLinkLocatorDigest, type IndexedRecallMemoryLink} from '../memory/links.js';
import {recallIndexScopeProject} from '../eligibility.js';
import {recallApprovedAuthoritative} from './eligibility.js';
import type {RecallIndexPosting} from './lexical.js';
import {stripRecallAnchor} from './lexical.js';
import {normalizeRecallWorkspaceScope} from './scope.js';
import {normalizedRecallRecordedAt} from './selection.js';
import {recallCandidateLogicalCorpusKey, type RecallCandidate} from '../rank.js';

export interface RecallIndexSource {
  readonly modifiedAt?: string;
  readonly path: string;
  readonly size: number;
  readonly uri: string;
}

export interface CanonicalResourcePolicy {
  readonly entryKeyByUri: ReadonlyMap<string, string>;
  readonly sourcePathByUri: ReadonlyMap<string, string>;
}

export interface IndexedRecallSource {
  readonly candidate: RecallCandidate;
  readonly codeLinks: readonly IndexedRecallCodeLink[];
  readonly documentLength: number;
  readonly exactSearchText: string;
  readonly memoryLinks: readonly IndexedRecallMemoryLink[];
  readonly memoryLinksTruncated: boolean;
  readonly postings: ReadonlyMap<string, RecallIndexPosting>;
  readonly source: RecallIndexSource;
}

interface RecallRefreshSourceInsert extends RecallIndexSource {
  readonly authorityPolicyKey: string | null;
  readonly invalidated: boolean;
  readonly uriLocatorDigest: string;
}

interface RecallRefreshSourceRow {
  readonly source_modified_at: string | null;
  readonly source_path: string;
  readonly source_size: number;
  readonly uri: string;
}

interface RecallRefreshIndexedGenerationRow {
  readonly candidate_json: string;
  readonly memory_links_json: string;
  readonly uri: string;
}

interface RecallRefreshIndexedCodeLinkGenerationRow {
  readonly citation_ordinal: number;
  readonly selector_digest: string;
  readonly selector_kind: string;
  readonly uri: string;
}

export interface RecallRefreshConfig {
  readonly manifestPath?: string;
  readonly account: string;
  readonly agentContextHome: string;
  readonly user: string;
}

// Keep decoded source text, candidate JSON, exact-search text, and postings
// comfortably below the scale gate even when every file reaches the 512 KiB
// indexing limit. Source metadata is cheap enough to use a larger scan batch.
const RECALL_REFRESH_INDEX_PAGE_SIZE = 8;
const RECALL_REFRESH_GENERATION_PAGE_SIZE = 16;
const RECALL_REFRESH_CODE_LINK_GENERATION_PAGE_SIZE = 256;
const RECALL_REFRESH_SOURCE_PAGE_SIZE = 256;
const RECALL_REFRESH_SOURCE_GC_INTERVAL = RECALL_REFRESH_SOURCE_PAGE_SIZE * 32;
const MAX_INDEXED_FILE_BYTES = 512 * 1_024;
const TEXT_EXTENSIONS = new Set(['.json', '.md', '.mdx', '.txt', '.yaml', '.yml']);

export const RECALL_REFRESH_AFFECTED_TERM_TABLE = 'recall_refresh_affected_terms';
export const RECALL_REFRESH_INDEXED_CODE_LINK_TABLE = 'recall_refresh_indexed_code_links';
export const RECALL_REFRESH_INDEXED_DOCUMENT_TABLE = 'recall_refresh_indexed_documents';
export const RECALL_REFRESH_INDEXED_MEMORY_LINK_TABLE = 'recall_refresh_indexed_memory_links';
export const RECALL_REFRESH_INDEXED_POSTING_TABLE = 'recall_refresh_indexed_postings';
export const RECALL_REFRESH_REPLACED_DOCUMENT_TABLE = 'recall_refresh_replaced_documents';
export const RECALL_REFRESH_SOURCE_TABLE = 'recall_refresh_sources';

export const scanRecallSources = Effect.fn('recall.scanSources')(function* (
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RecallRefreshConfig,
  includeInactive: boolean,
  canonicalResourcePolicy: CanonicalResourcePolicy,
  invalidatedUris: ReadonlySet<string>,
  projection: RecallSourceProjection = 'lexical',
) {
  yield* prepareRecallSourceScan(sql, projection);
  const externalAccess = yield* loadExternalResourceAccess({
    home: config.agentContextHome,
    account: config.account,
    user: config.user,
  });
  let pendingSources: RecallRefreshSourceInsert[] = [];
  let scannedSourceCount = 0;
  let skippedOversizedDocumentCount = 0;
  const flushPendingSources = () => {
    if (pendingSources.length === 0) return Effect.void;
    const batch = pendingSources;
    pendingSources = [];
    return sql.unsafe(
      `INSERT INTO ${RECALL_REFRESH_SOURCE_TABLE} (
        uri, uri_locator_digest, source_path, source_modified_at, source_size, authority_policy_key, invalidated
      ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      batch.flatMap(source => [
        source.uri,
        source.uriLocatorDigest,
        source.path,
        source.modifiedAt ?? null,
        source.size,
        source.authorityPolicyKey,
        source.invalidated ? 1 : 0,
      ]),
    );
  };
  for (const root of recallIndexRoots(config, path)) {
    const rootId = parseResourceId(root.uri);
    yield* forEachFileWithinBoundary(
      fs,
      root.path,
      root.path,
      {
        includeDirectory: candidate => !excludedDirectory(candidate, includeInactive),
        includeFile: candidate => !excludedFile(candidate),
      },
      file =>
        Effect.gen(function* () {
          if (file.size > MAX_INDEXED_FILE_BYTES) {
            skippedOversizedDocumentCount += 1;
            return;
          }
          const relativeSegments = path
            .relative(root.path, file.path)
            .split(path.sep)
            .map(segment => segment.normalize('NFC'));
          const uri = canonicalResourceUri(rootId.namespace, [...rootId.segments, ...relativeSegments]);
          if (isExternalResourceUri(uri) && externalAccess[uri] === undefined) return;
          pendingSources.push({
            authorityPolicyKey: canonicalResourcePolicy.entryKeyByUri.get(uri) ?? null,
            invalidated: invalidatedUris.has(uri),
            modifiedAt: file.modifiedAt?.toISOString(),
            path: file.path,
            size: file.size,
            uri,
            uriLocatorDigest: memoryLinkLocatorDigest(uri),
          });
          scannedSourceCount += 1;
          if (pendingSources.length >= RECALL_REFRESH_SOURCE_PAGE_SIZE) {
            yield* flushPendingSources();
            // A 100k-source validation otherwise allocates faster than JSC's
            // normal collection cadence and retains an avoidable RSS spike.
            if (scannedSourceCount % RECALL_REFRESH_SOURCE_GC_INTERVAL === 0) {
              Bun.gc(true);
              yield* Effect.yieldNow;
            }
          }
        }),
    );
  }
  yield* flushPendingSources();
  yield* sql.unsafe(
    `CREATE INDEX temp.${RECALL_REFRESH_SOURCE_TABLE}_locator_digest
     ON ${RECALL_REFRESH_SOURCE_TABLE}(uri_locator_digest, uri)`,
  );
  return {scannedSourceCount, skippedOversizedDocumentCount};
});

export type RecallSourceProjection = 'lexical' | 'identity';

function sourceRelation(projection: RecallSourceProjection) {
  return projection === 'identity' ? 'identity_documents' : 'documents';
}

export function countRecallSourceChanges(
  sql: SqlClient.SqlClient,
  forceRefresh: boolean,
  projection: RecallSourceProjection = 'lexical',
) {
  return sql
    .unsafe<{readonly changed_source_count: number; readonly removed_source_count: number}>(
      `SELECT
        (SELECT COUNT(*) FROM temp.${RECALL_REFRESH_SOURCE_TABLE} AS source
         LEFT JOIN ${sourceRelation(projection)} AS document ON document.uri = source.uri
         WHERE (? = 1 OR source.invalidated = 1 OR document.id IS NULL
           OR document.source_path <> source.source_path
           OR document.source_modified_at IS NOT source.source_modified_at
           OR document.source_size <> source.source_size
           OR document.authority_policy_key IS NOT source.authority_policy_key)) AS changed_source_count,
        (SELECT COUNT(*) FROM ${sourceRelation(projection)} AS document
         LEFT JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS source ON source.uri = document.uri
         WHERE source.uri IS NULL) AS removed_source_count`,
      [forceRefresh ? 1 : 0],
    )
    .pipe(
      Effect.map(rows => ({
        changedSourceCount: rows[0]?.changed_source_count ?? 0,
        removedSourceCount: rows[0]?.removed_source_count ?? 0,
      })),
    );
}

export function forEachChangedRecallSourcePage<A, E, R>(
  sql: SqlClient.SqlClient,
  forceRefresh: boolean,
  visitPage: (page: readonly RecallIndexSource[]) => Effect.Effect<A, E, R>,
  projection: RecallSourceProjection = 'lexical',
) {
  return Effect.gen(function* () {
    let cursor: string | undefined;
    while (true) {
      const cursorPredicate = cursor === undefined ? '' : 'AND source.uri COLLATE BINARY > ? COLLATE BINARY';
      const rows = yield* sql.unsafe<RecallRefreshSourceRow>(
        `SELECT source.uri, source.source_path, source.source_modified_at, source.source_size
         FROM temp.${RECALL_REFRESH_SOURCE_TABLE} AS source
         LEFT JOIN ${sourceRelation(projection)} AS document ON document.uri = source.uri
         WHERE (? = 1 OR source.invalidated = 1 OR document.id IS NULL
           OR document.source_path <> source.source_path
           OR document.source_modified_at IS NOT source.source_modified_at
           OR document.source_size <> source.source_size
           OR document.authority_policy_key IS NOT source.authority_policy_key)
         ${cursorPredicate}
         ORDER BY source.uri COLLATE BINARY LIMIT ?`,
        cursor === undefined
          ? [forceRefresh ? 1 : 0, RECALL_REFRESH_INDEX_PAGE_SIZE]
          : [forceRefresh ? 1 : 0, cursor, RECALL_REFRESH_INDEX_PAGE_SIZE],
      );
      if (rows.length === 0) break;
      yield* visitPage(
        rows.map(row => ({
          modifiedAt: row.source_modified_at ?? undefined,
          path: row.source_path,
          size: row.source_size,
          uri: row.uri,
        })),
      );
      cursor = rows.at(-1)?.uri;
      if (rows.length < RECALL_REFRESH_INDEX_PAGE_SIZE) break;
    }
  });
}

/** Lexical-refresh scope project: delegates to the shared index-scope rule. */
export function recallIndexedProject(candidate: RecallCandidate): string | null {
  return recallIndexScopeProject(candidate.kind, candidate.fields?.project);
}

export function insertIndexedRecallSources(sql: SqlClient.SqlClient, indexedSources: readonly IndexedRecallSource[]) {
  return Effect.gen(function* () {
    if (indexedSources.length === 0) return;
    yield* sql.unsafe(
      `INSERT INTO temp.${RECALL_REFRESH_INDEXED_DOCUMENT_TABLE} (
        uri, project, approved_authoritative, workspace_scope, recorded_at,
        candidate_json, logical_key, document_length, exact_search_text,
        memory_links_json, memory_links_truncated
      ) VALUES ${indexedSources.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      indexedSources.flatMap(indexed => [
        stripRecallAnchor(indexed.candidate.uri),
        recallIndexedProject(indexed.candidate),
        recallApprovedAuthoritative(indexed.candidate.authority, indexed.candidate.trust) ? 1 : 0,
        normalizeRecallWorkspaceScope(indexed.candidate.fields?.workspaceScope) ?? null,
        normalizedRecallRecordedAt(indexed.candidate.timestamp),
        JSON.stringify(indexed.candidate),
        recallCandidateLogicalCorpusKey(indexed.candidate),
        indexed.documentLength,
        indexed.exactSearchText,
        JSON.stringify({links: indexed.memoryLinks, truncated: indexed.memoryLinksTruncated}),
        indexed.memoryLinksTruncated ? 1 : 0,
      ]),
    );
    const codeLinks = indexedSources.flatMap(indexed =>
      indexed.codeLinks.map(
        link => [indexed.source.uri, link.citationOrdinal, link.selectorKind, link.selectorDigest] as const,
      ),
    );
    for (let index = 0; index < codeLinks.length; index += 400) {
      const batch = codeLinks.slice(index, index + 400);
      yield* sql.unsafe(
        `INSERT INTO temp.${RECALL_REFRESH_INDEXED_CODE_LINK_TABLE} (
          uri, citation_ordinal, selector_kind, selector_digest
        ) VALUES ${batch.map(() => '(?, ?, ?, ?)').join(', ')}`,
        batch.flat(),
      );
    }
    const memoryLinks = indexedSources.flatMap(indexed =>
      indexed.memoryLinks.map(
        link =>
          [
            indexed.source.uri,
            link.sourceMemoryId,
            link.targetMemoryId,
            link.targetLocatorDigest,
            link.relationType,
            link.relationOrigin,
            link.relationOrdinal,
          ] as const,
      ),
    );
    for (let index = 0; index < memoryLinks.length; index += 200) {
      const batch = memoryLinks.slice(index, index + 200);
      yield* sql.unsafe(
        `INSERT INTO temp.${RECALL_REFRESH_INDEXED_MEMORY_LINK_TABLE} (
          uri, source_memory_id, target_memory_id, target_locator_digest,
          relation_type, relation_origin, relation_ordinal
        ) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        batch.flat(),
      );
    }
    let postingBatch: Array<readonly [string, string, number, number]> = [];
    const flushPostings = () => {
      if (postingBatch.length === 0) return Effect.void;
      const current = postingBatch;
      postingBatch = [];
      return sql.unsafe(
        `INSERT INTO temp.${RECALL_REFRESH_INDEXED_POSTING_TABLE} (
          uri, term, field_weight, term_frequency
        ) VALUES ${current.map(() => '(?, ?, ?, ?)').join(', ')}`,
        current.flat(),
      );
    };
    for (const indexed of indexedSources) {
      for (const [term, posting] of indexed.postings) {
        postingBatch.push([indexed.source.uri, term, posting.fieldWeight, posting.termFrequency]);
        if (postingBatch.length >= 400) yield* flushPostings();
      }
    }
    yield* flushPostings();
  });
}

export function hashRecallRefreshGeneration(sql: SqlClient.SqlClient, previousContentGeneration: string | undefined) {
  return Effect.gen(function* () {
    const hash = new Bun.CryptoHasher('sha256');
    hash.update('{"changed":[');
    let first = true;
    let cursor: string | undefined;
    let codeLinkCursor: RecallRefreshIndexedCodeLinkGenerationRow | undefined;
    let codeLinkPage: readonly RecallRefreshIndexedCodeLinkGenerationRow[] = [];
    let codeLinkPageOffset = 0;
    let codeLinksExhausted = false;
    const peekCodeLink = Effect.fn('recall.peekGenerationCodeLink')(function* () {
      while (codeLinkPageOffset >= codeLinkPage.length && !codeLinksExhausted) {
        const predicate =
          codeLinkCursor === undefined
            ? ''
            : `WHERE
                 uri COLLATE BINARY > ? COLLATE BINARY
                 OR (uri = ? AND citation_ordinal > ?)
                 OR (uri = ? AND citation_ordinal = ? AND selector_kind COLLATE BINARY > ? COLLATE BINARY)
                 OR (
                   uri = ?
                   AND citation_ordinal = ?
                   AND selector_kind = ?
                   AND selector_digest COLLATE BINARY > ? COLLATE BINARY
                 )`;
        const parameters =
          codeLinkCursor === undefined
            ? [RECALL_REFRESH_CODE_LINK_GENERATION_PAGE_SIZE]
            : [
                codeLinkCursor.uri,
                codeLinkCursor.uri,
                codeLinkCursor.citation_ordinal,
                codeLinkCursor.uri,
                codeLinkCursor.citation_ordinal,
                codeLinkCursor.selector_kind,
                codeLinkCursor.uri,
                codeLinkCursor.citation_ordinal,
                codeLinkCursor.selector_kind,
                codeLinkCursor.selector_digest,
                RECALL_REFRESH_CODE_LINK_GENERATION_PAGE_SIZE,
              ];
        codeLinkPage = yield* sql.unsafe<RecallRefreshIndexedCodeLinkGenerationRow>(
          `SELECT uri, citation_ordinal, selector_kind, selector_digest
           FROM temp.${RECALL_REFRESH_INDEXED_CODE_LINK_TABLE}
           ${predicate}
           ORDER BY uri COLLATE BINARY, citation_ordinal, selector_kind COLLATE BINARY, selector_digest COLLATE BINARY
           LIMIT ?`,
          parameters,
        );
        codeLinkPageOffset = 0;
        codeLinkCursor = codeLinkPage.at(-1);
        codeLinksExhausted = codeLinkPage.length < RECALL_REFRESH_CODE_LINK_GENERATION_PAGE_SIZE;
      }
      return codeLinkPage[codeLinkPageOffset];
    });
    while (true) {
      const predicate = cursor === undefined ? '' : 'WHERE uri COLLATE BINARY > ? COLLATE BINARY';
      const rows = yield* sql.unsafe<RecallRefreshIndexedGenerationRow>(
        `SELECT uri, candidate_json, memory_links_json FROM temp.${RECALL_REFRESH_INDEXED_DOCUMENT_TABLE}
         ${predicate} ORDER BY uri COLLATE BINARY LIMIT ?`,
        cursor === undefined ? [RECALL_REFRESH_GENERATION_PAGE_SIZE] : [cursor, RECALL_REFRESH_GENERATION_PAGE_SIZE],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const codeLinks: IndexedRecallCodeLink[] = [];
        while (true) {
          const codeLink = yield* peekCodeLink();
          if (codeLink === undefined || codeLink.uri > row.uri) break;
          codeLinkPageOffset += 1;
          if (codeLink.uri < row.uri) continue;
          if (
            codeLink.selector_kind !== 'file-content' &&
            codeLink.selector_kind !== 'file-path' &&
            codeLink.selector_kind !== 'symbol-locator' &&
            codeLink.selector_kind !== 'symbol-node'
          ) {
            continue;
          }
          codeLinks.push({
            citationOrdinal: codeLink.citation_ordinal,
            selectorDigest: codeLink.selector_digest,
            selectorKind: codeLink.selector_kind,
          });
        }
        hash.update(
          `${first ? '' : ','}{"candidate":${row.candidate_json},"codeLinks":${JSON.stringify(codeLinks)},"memoryLinks":${row.memory_links_json},"uri":${JSON.stringify(row.uri)}}`,
        );
        first = false;
      }
      cursor = rows.at(-1)?.uri;
      if (rows.length < RECALL_REFRESH_GENERATION_PAGE_SIZE) break;
    }
    hash.update(`],"previous":${JSON.stringify(previousContentGeneration ?? null)},"removed":[`);
    first = true;
    cursor = undefined;
    while (true) {
      const predicate: string = cursor === undefined ? '' : 'AND document.uri COLLATE BINARY > ? COLLATE BINARY';
      const rows: readonly {readonly uri: string}[] = yield* sql.unsafe<{readonly uri: string}>(
        `SELECT document.uri FROM documents AS document
         LEFT JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS source ON source.uri = document.uri
         WHERE source.uri IS NULL ${predicate}
         ORDER BY document.uri COLLATE BINARY LIMIT ?`,
        cursor === undefined ? [RECALL_REFRESH_SOURCE_PAGE_SIZE] : [cursor, RECALL_REFRESH_SOURCE_PAGE_SIZE],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        hash.update(`${first ? '' : ','}${JSON.stringify(row.uri)}`);
        first = false;
      }
      cursor = rows.at(-1)?.uri;
      if (rows.length < RECALL_REFRESH_SOURCE_PAGE_SIZE) break;
    }
    hash.update(']}');
    return hash.digest('hex');
  });
}

export function stageRecallRefreshAffectedTerms(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    yield* sql.unsafe(`
      INSERT INTO temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE} (document_id)
      SELECT document.id FROM documents AS document
      LEFT JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS source ON source.uri = document.uri
      LEFT JOIN temp.${RECALL_REFRESH_INDEXED_DOCUMENT_TABLE} AS indexed ON indexed.uri = document.uri
      WHERE source.uri IS NULL OR indexed.uri IS NOT NULL
    `);
    yield* sql.unsafe(`
      INSERT OR IGNORE INTO temp.${RECALL_REFRESH_AFFECTED_TERM_TABLE} (term)
      SELECT posting.term FROM postings AS posting
      INNER JOIN temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE} AS replaced
        ON replaced.document_id = posting.document_id
    `);
    yield* sql.unsafe(`
      INSERT OR IGNORE INTO temp.${RECALL_REFRESH_AFFECTED_TERM_TABLE} (term)
      SELECT term FROM temp.${RECALL_REFRESH_INDEXED_POSTING_TABLE}
    `);
  });
}

export function dropRecallSourceScan(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    for (const table of [
      RECALL_REFRESH_REPLACED_DOCUMENT_TABLE,
      RECALL_REFRESH_AFFECTED_TERM_TABLE,
      RECALL_REFRESH_INDEXED_POSTING_TABLE,
      RECALL_REFRESH_INDEXED_CODE_LINK_TABLE,
      RECALL_REFRESH_INDEXED_MEMORY_LINK_TABLE,
      RECALL_REFRESH_INDEXED_DOCUMENT_TABLE,
      RECALL_REFRESH_SOURCE_TABLE,
    ]) {
      yield* sql.unsafe(`DROP TABLE IF EXISTS temp.${table}`);
    }
  });
}

function prepareRecallSourceScan(sql: SqlClient.SqlClient, projection: RecallSourceProjection) {
  return Effect.gen(function* () {
    yield* sql.unsafe('PRAGMA temp_store = FILE');
    yield* dropRecallSourceScan(sql);
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_SOURCE_TABLE} (
      uri TEXT PRIMARY KEY NOT NULL,
      uri_locator_digest TEXT NOT NULL CHECK (
        length(uri_locator_digest) = 64 AND uri_locator_digest NOT GLOB '*[^0-9a-f]*'
      ),
      source_path TEXT NOT NULL, source_modified_at TEXT,
      source_size INTEGER NOT NULL CHECK (source_size >= 0), authority_policy_key TEXT,
      invalidated INTEGER NOT NULL CHECK (invalidated IN (0, 1))) WITHOUT ROWID`);
    if (projection === 'identity') return;
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_INDEXED_DOCUMENT_TABLE} (
      uri TEXT PRIMARY KEY NOT NULL, project TEXT,
      approved_authoritative INTEGER NOT NULL CHECK (approved_authoritative IN (0, 1)),
      workspace_scope TEXT, recorded_at TEXT, candidate_json TEXT NOT NULL, logical_key TEXT NOT NULL,
      document_length INTEGER NOT NULL CHECK (document_length >= 0), exact_search_text TEXT NOT NULL,
      memory_links_json TEXT NOT NULL,
      memory_links_truncated INTEGER NOT NULL CHECK (memory_links_truncated IN (0, 1))) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_INDEXED_POSTING_TABLE} (
      uri TEXT NOT NULL, term TEXT NOT NULL, field_weight REAL NOT NULL CHECK (field_weight >= 0),
      term_frequency INTEGER NOT NULL CHECK (term_frequency > 0), PRIMARY KEY (uri, term)) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_INDEXED_CODE_LINK_TABLE} (
      uri TEXT NOT NULL, citation_ordinal INTEGER NOT NULL CHECK (citation_ordinal >= 0),
      selector_kind TEXT NOT NULL, selector_digest TEXT NOT NULL CHECK (length(selector_digest) = 64),
      PRIMARY KEY (uri, citation_ordinal, selector_kind, selector_digest)) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_INDEXED_MEMORY_LINK_TABLE} (
      uri TEXT NOT NULL,
      source_memory_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL,
      target_locator_digest TEXT NOT NULL CHECK (
        target_locator_digest = '' OR (
          length(target_locator_digest) = 64 AND target_locator_digest NOT GLOB '*[^0-9a-f]*'
        )
      ),
      relation_type TEXT NOT NULL,
      relation_origin TEXT NOT NULL,
      relation_ordinal INTEGER NOT NULL CHECK (relation_ordinal >= 0),
      CHECK (target_memory_id <> '' OR target_locator_digest <> ''),
      PRIMARY KEY (
        uri, relation_origin, relation_ordinal, relation_type, target_memory_id, target_locator_digest
      )) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_AFFECTED_TERM_TABLE} (
      term TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE} (
      document_id INTEGER PRIMARY KEY NOT NULL) WITHOUT ROWID`);
  });
}

function recallIndexRoots(config: RecallRefreshConfig, path: Path.Path) {
  const storageRoot = path.join(config.agentContextHome, 'data', config.account);
  return [
    {path: path.join(storageRoot, 'resources'), uri: 'threadnote://resources'},
    {
      path: path.join(storageRoot, 'user', uriSegment(config.user), 'memories'),
      uri: `threadnote://user/${uriSegment(config.user)}/memories`,
    },
  ];
}

function excludedDirectory(path: string, includeInactive: boolean): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.includes('/agent-artifacts/packs/')) return true;
  return (
    !includeInactive &&
    (normalized.includes('/archived/') || normalized.includes('/expired/') || normalized.includes('/superseded/'))
  );
}

function excludedFile(path: string): boolean {
  const extensionIndex = path.lastIndexOf('.');
  const extension = extensionIndex === -1 ? '' : path.slice(extensionIndex).toLowerCase();
  const normalized = path.replaceAll('\\', '/');
  return (
    !TEXT_EXTENSIONS.has(extension) ||
    /\/\.(?:abstract|overview)\.md$/.test(normalized) ||
    normalized.includes('/agent-artifacts/packs/')
  );
}

/** Both projections read and authorize the same full candidate; only lexical derives search/link rows. */
export const assembleRecallSourceCandidate = Effect.fn('recall.assembleSourceCandidate')(function* (
  fs: FileSystem.FileSystem,
  config: RecallRefreshConfig,
  source: RecallIndexSource,
  policy: CanonicalResourcePolicy,
) {
  const content = yield* fs.readFileString(source.path);
  const sourcePath = policy.sourcePathByUri.get(source.uri);
  const canonicalResource =
    sourcePath === undefined
      ? false
      : yield* fs.readFileString(sourcePath).pipe(
          Effect.map(sourceContent => sourceContent === content),
          Effect.orElseSucceed(() => false),
        );
  const memory = isExternalResourceUri(source.uri) ? undefined : parseMemoryDocument(source.uri, content);
  const externalIdentity = parseExternalResourceIdentity(source.uri);
  const externalManifest =
    externalIdentity === undefined
      ? undefined
      : yield* readExternalDocumentManifest(
          {home: config.agentContextHome, account: config.account, user: config.user},
          externalIdentity.sourceId,
          externalIdentity.documentId,
        );
  return {
    candidate: indexCandidate(source.uri, content, canonicalResource, memory, externalManifest?.fetchedAt),
    memory,
  };
});

/** Compare the observed source postimage with the peer baseline, never invalidate merely for force-selected rows. */
export function recallProjectionObservedChanges(sql: SqlClient.SqlClient, projection: RecallSourceProjection) {
  const ownRelation = sourceRelation(projection);
  const peerRelation = sourceRelation(projection === 'identity' ? 'lexical' : 'identity');
  const staged = projection === 'identity' ? 'recall_identity_candidates' : RECALL_REFRESH_INDEXED_DOCUMENT_TABLE;
  return sql
    .unsafe<{readonly changed: number}>(
      `SELECT EXISTS (
    SELECT 1 FROM temp.${RECALL_REFRESH_SOURCE_TABLE} AS source
    LEFT JOIN ${peerRelation} AS document ON document.uri = source.uri
    LEFT JOIN ${ownRelation} AS baseline ON baseline.uri = source.uri
    LEFT JOIN temp.${staged} AS indexed ON indexed.uri = source.uri
    WHERE document.id IS NULL OR document.source_path <> source.source_path
      OR document.source_modified_at IS NOT source.source_modified_at
      OR document.source_size <> source.source_size
      OR document.authority_policy_key IS NOT source.authority_policy_key
      OR COALESCE(indexed.candidate_json, baseline.candidate_json) IS NOT document.candidate_json
    UNION ALL SELECT 1 FROM ${peerRelation} AS document
    LEFT JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS source ON source.uri = document.uri
    WHERE source.uri IS NULL
  ) AS changed`,
    )
    .pipe(Effect.map(rows => rows[0]?.changed === 1));
}

export class RecallIndexOperationError extends Schema.TaggedError<RecallIndexOperationError>()(
  'RecallIndexOperationError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

interface SeedStateEntry {
  readonly mtimeMs: number;
  readonly size: number;
}

const SEED_FILE_MTIME_TOLERANCE_MILLISECONDS = 1;

export function loadCanonicalResourcePolicy(
  config: RecallRefreshConfig,
): Effect.Effect<CanonicalResourcePolicy, never, Crypto.Crypto | FileSystem.FileSystem | Path.Path | SystemInfo> {
  const manifestPath = config.manifestPath;
  if (!manifestPath) {
    return Effect.succeed({entryKeyByUri: new Map(), sourcePathByUri: new Map()});
  }
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const manifestRaw = yield* fs.readFileString(manifestPath);
    const manifest = yield* Effect.try({
      try: () => parseSeedManifest(manifestRaw, manifestPath),
      catch: cause =>
        RecallIndexOperationError.make({cause, message: cause instanceof Error ? cause.message : String(cause)}),
    });
    const seedStateRaw = yield* fs.readFileString(pathService.join(config.agentContextHome, SEED_STATE_FILE));
    const seedState = yield* Effect.try({
      try: () => parseSeedState(seedStateRaw),
      catch: cause =>
        RecallIndexOperationError.make({cause, message: cause instanceof Error ? cause.message : String(cause)}),
    });
    const entryKeyByUri = new Map<string, string>();
    const sourcePathByUri = new Map<string, string>();
    for (const [uri, recorded] of [...seedState].sort(([left], [right]) => left.localeCompare(right))) {
      const source = yield* resolveSeededResourceSource(fs, manifest.projects, uri, recorded);
      if (!source) {
        continue;
      }
      const match = seededResourceMatch(manifest.projects, uri);
      if (!match) {
        continue;
      }
      sourcePathByUri.set(uri, source);
      entryKeyByUri.set(
        uri,
        yield* sha256Hex(
          JSON.stringify({
            project: {
              path: yield* expandPath(match.project.path),
              seed: [...match.project.seed],
              uri: normalizedResourceRoot(match.project.uri),
            },
            recorded,
            source,
            uri,
          }),
        ),
      );
    }
    return {entryKeyByUri, sourcePathByUri};
  }).pipe(
    Effect.orElseSucceed(() => ({
      entryKeyByUri: new Map<string, string>(),
      sourcePathByUri: new Map<string, string>(),
    })),
  );
}

function parseSeedState(raw: string): ReadonlyMap<string, SeedStateEntry> {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('files' in value) ||
    typeof value.files !== 'object' ||
    value.files === null
  ) {
    return new Map();
  }
  const entries: Array<[string, SeedStateEntry]> = [];
  for (const [uri, entry] of Object.entries(value.files)) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'mtimeMs' in entry &&
      typeof entry.mtimeMs === 'number' &&
      Number.isFinite(entry.mtimeMs) &&
      'size' in entry &&
      typeof entry.size === 'number' &&
      Number.isFinite(entry.size)
    ) {
      entries.push([uri, {mtimeMs: entry.mtimeMs, size: entry.size}]);
    }
  }
  return new Map(entries);
}

function resolveSeededResourceSource(
  fs: FileSystem.FileSystem,
  projects: readonly ProjectManifest[],
  uri: string,
  recorded: SeedStateEntry,
): Effect.Effect<string | undefined, never, Path.Path | SystemInfo> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    const match = seededResourceMatch(projects, uri);
    if (!match) {
      return undefined;
    }
    const projectRoot = yield* expandPath(match.project.path);
    const sourcePath = pathService.join(projectRoot, ...match.relativePath.split('/'));
    const relativeSourcePath = pathService.relative(projectRoot, sourcePath);
    if (
      relativeSourcePath === '' ||
      relativeSourcePath.startsWith(`..${pathService.sep}`) ||
      relativeSourcePath === '..' ||
      pathService.isAbsolute(relativeSourcePath)
    ) {
      return undefined;
    }
    const [realProjectRoot, realSourcePath, info] = yield* Effect.all([
      fs.realPath(projectRoot),
      fs.realPath(sourcePath),
      fs.stat(sourcePath),
    ]);
    const realRelativePath = pathService.relative(realProjectRoot, realSourcePath);
    if (
      realRelativePath.startsWith(`..${pathService.sep}`) ||
      realRelativePath === '..' ||
      pathService.isAbsolute(realRelativePath) ||
      info.type !== 'File' ||
      Number(info.size) !== recorded.size
    ) {
      return undefined;
    }
    const modifiedAt = Option.getOrUndefined(info.mtime)?.getTime();
    if (modifiedAt === undefined || Math.abs(modifiedAt - recorded.mtimeMs) > SEED_FILE_MTIME_TOLERANCE_MILLISECONDS) {
      return undefined;
    }
    return sourcePath;
  }).pipe(Effect.orElseSucceed(() => undefined));
}

function seededResourceMatch(
  projects: readonly ProjectManifest[],
  uri: string,
): {readonly project: ProjectManifest; readonly relativePath: string} | undefined {
  for (const project of projects) {
    const root = normalizedResourceRoot(project.uri);
    if (!uri.startsWith(`${root}/`)) {
      continue;
    }
    const relativePath = uri.slice(root.length + 1).replaceAll('\\', '/');
    if (
      relativePath.length === 0 ||
      relativePath.startsWith('/') ||
      relativePath.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ||
      !project.seed.some(pattern => globToRegExp(pattern.replaceAll('\\', '/')).test(relativePath))
    ) {
      continue;
    }
    return {project, relativePath};
  }
  return undefined;
}

function normalizedResourceRoot(uri: string): string {
  return stripRecallAnchor(uri).replace(/\/+$/, '');
}
