import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Option, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {forEachFileWithinBoundary} from '@threadnote/platform/safe_scan';
import {uriSegment} from '@threadnote/workspace/manifest';
import {canonicalResourceUri, parseResourceId} from '@threadnote/store/resource-id';
import {isExternalResourceUri, loadExternalResourceAccess} from '@threadnote/store/external-resource';
import type {IndexedRecallCodeLink} from '../code_links.js';
import {memoryLinkLocatorDigest, type IndexedRecallMemoryLink} from '../memory/links.js';
import {recallIndexScopeProject} from '../eligibility.js';
import {recallApprovedAuthoritative} from './eligibility.js';
import type {RecallIndexPosting} from './lexical.js';
import {stripRecallAnchor} from './lexical.js';
import {normalizeRecallWorkspaceScope} from './scope.js';
import {normalizedRecallRecordedAt} from './selection.js';
import {recallCandidateLogicalCorpusKey, type RecallCandidate} from '../rank.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

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
interface RetainedRecallSourceRow extends RecallRefreshSourceRow {
  readonly authority_policy_key: string | null;
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

interface RecallRefreshConfig {
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
) {
  yield* prepareRecallSourceScan(sql);
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
    return insertRecallSourceMetadata(sql, batch);
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
          const relativeSegments = EffectArray.map(
            Effect2.pipe(path.relative(root.path, file.path), EffectString.split(path.sep)),
            segment => Effect2.pipe(segment, EffectString.normalize('NFC')),
          );
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
  yield* indexRecallSourceLocators(sql);
  return {scannedSourceCount, skippedOversizedDocumentCount};
});

function insertRecallSourceMetadata(sql: SqlClient.SqlClient, sources: readonly RecallRefreshSourceInsert[]) {
  if (sources.length === 0) return Effect.void;
  return sql.unsafe(
    `INSERT INTO ${RECALL_REFRESH_SOURCE_TABLE} (
        uri, uri_locator_digest, source_path, source_modified_at, source_size, authority_policy_key, invalidated
      ) VALUES ${EffectArray.join(
        EffectArray.map(sources, () => '(?, ?, ?, ?, ?, ?, ?)'),
        ', ',
      )}`,
    EffectArray.flatMap(sources, source => [
      source.uri,
      source.uriLocatorDigest,
      source.path,
      source.modifiedAt ?? null,
      source.size,
      source.authorityPolicyKey,
      source.invalidated ? 1 : 0,
    ]),
  );
}
function indexRecallSourceLocators(sql: SqlClient.SqlClient) {
  return sql.unsafe(
    `CREATE INDEX temp.${RECALL_REFRESH_SOURCE_TABLE}_locator_digest
     ON ${RECALL_REFRESH_SOURCE_TABLE}(uri_locator_digest, uri)`,
  );
}

/** A touched pass still stages a complete inventory for deletion and legacy-link joins. */
export const stageRecallSources = Effect.fn('recall.stageSources')(function* (
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RecallRefreshConfig,
  options: {
    readonly includeInactive: boolean;
    readonly canonicalResourcePolicy: CanonicalResourcePolicy;
    readonly invalidatedUris: ReadonlySet<string>;
    /** The caller proves mutation continuity and unchanged scope/policy before choosing touched mode. */
    readonly mode: {readonly kind: 'full'} | {readonly kind: 'touched'; readonly contentGeneration: string};
  },
) {
  if (options.mode.kind === 'touched') {
    yield* prepareRecallSourceScan(sql);
    const touched = yield* sql
      .withTransaction(stageTouchedRecallSources(sql, fs, path, config, options, options.mode.contentGeneration))
      .pipe(Effect.provideService(SqlClient.BeginTransaction, 'BEGIN DEFERRED'));
    if (touched) return {...touched, mode: 'touched' as const, forceAllSources: false};
  }
  return {
    ...(yield* scanRecallSources(
      sql,
      fs,
      path,
      config,
      options.includeInactive,
      options.canonicalResourcePolicy,
      options.invalidatedUris,
    )),
    mode: 'full' as const,
    forceAllSources: options.mode.kind === 'touched',
  };
});

const stageTouchedRecallSources = Effect.fn('recall.stageTouchedSources')(function* (
  sql: SqlClient.SqlClient,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  config: RecallRefreshConfig,
  options: {
    readonly includeInactive: boolean;
    readonly canonicalResourcePolicy: CanonicalResourcePolicy;
    readonly invalidatedUris: ReadonlySet<string>;
  },
  contentGeneration: string,
) {
  if (options.invalidatedUris.size === 0 || options.invalidatedUris.size > 1024) return undefined;
  const metadata = yield* sql.unsafe<{readonly key: string; readonly value: string}>(
    "SELECT key, value FROM metadata WHERE key IN ('content_generation', 'oversized_document_count')",
  );
  const values = new Map(EffectArray.map(metadata, row => [row.key, row.value]));
  const skipped = Number(values.get('oversized_document_count'));
  if (
    values.get('content_generation') !== contentGeneration ||
    !Number.isSafeInteger(skipped) ||
    skipped < 0 ||
    String(skipped) !== values.get('oversized_document_count')
  )
    return undefined;
  const roots = EffectArray.map(recallIndexRoots(config, path), root => {
    const id = parseResourceId(root.uri);
    return {...root, uri: id.canonicalUri, id};
  });
  const selected = new Map<string, {readonly root: (typeof roots)[number]; readonly segments: readonly string[]}>();
  const folded = new Map<string, string>();
  for (const raw of options.invalidatedUris) {
    const id = yield* Effect.try(() => parseResourceId(stripRecallAnchor(raw))).pipe(Effect.option);
    if (Option.isNone(id)) return undefined;
    const root = EffectArray.findFirst(
      roots,
      root =>
        root.id.namespace === id.value.namespace &&
        EffectArray.every(root.id.segments, (segment, i) => id.value.segments[i] === segment),
    );
    if (Option.isNone(root)) return undefined;
    const segments = id.value.segments.slice(root.value.id.segments.length);
    const filename = path.join(root.value.path, ...segments);
    if (segments.length === 0 || excludedFile(filename) || excludedDirectory(filename, options.includeInactive))
      return undefined;
    const key = EffectString.toLowerCase(id.value.canonicalUri);
    if (folded.has(key) && folded.get(key) !== id.value.canonicalUri) return undefined;
    folded.set(key, id.value.canonicalUri);
    selected.set(id.value.canonicalUri, {root: root.value, segments});
  }
  const previous = new Map<string, RetainedRecallSourceRow>();
  const nonAsciiRoots = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const rows = yield* sql.unsafe<RetainedRecallSourceRow>(
      `SELECT uri, source_path, source_modified_at, source_size, authority_policy_key FROM documents
       ${cursor === undefined ? '' : 'WHERE uri COLLATE BINARY > ? COLLATE BINARY'}
       ORDER BY uri COLLATE BINARY LIMIT ?`,
      cursor === undefined ? [RECALL_REFRESH_SOURCE_PAGE_SIZE] : [cursor, RECALL_REFRESH_SOURCE_PAGE_SIZE],
    );
    const retained: RecallRefreshSourceInsert[] = [];
    for (const row of rows) {
      const alias = folded.get(EffectString.toLowerCase(row.uri));
      if (alias !== undefined && alias !== row.uri) return undefined;
      const root = EffectArray.findFirst(roots, root => EffectString.startsWith(root.uri + '/')(row.uri));
      if (Option.isNone(root)) return undefined;
      if (/[\u0080-\uFFFF]|%[c-f][\da-f]/iu.test(EffectString.slice(root.value.uri.length)(row.uri)))
        nonAsciiRoots.add(root.value.uri);
      if (selected.has(row.uri)) previous.set(row.uri, row);
      else
        retained.push({
          uri: row.uri,
          path: row.source_path,
          size: row.source_size,
          modifiedAt: row.source_modified_at ?? undefined,
          authorityPolicyKey: row.authority_policy_key,
          invalidated: false,
          uriLocatorDigest: memoryLinkLocatorDigest(row.uri),
        });
    }
    yield* insertRecallSourceMetadata(sql, retained);
    cursor = rows.at(-1)?.uri;
    if (rows.length < RECALL_REFRESH_SOURCE_PAGE_SIZE) break;
  }
  // Oversized files have no documents row; unknown prior membership requires a full count.
  if (skipped > 0 && EffectArray.some([...selected.keys()], uri => !previous.has(uri))) return undefined;
  for (const [uri, target] of selected)
    if (
      !previous.has(uri) &&
      (nonAsciiRoots.has(target.root.uri) || EffectArray.some(target.segments, segment => /\P{ASCII}/u.test(segment)))
    )
      return undefined;
  const access = EffectArray.some([...selected.keys()], isExternalResourceUri)
    ? yield* loadExternalResourceAccess({
        home: config.agentContextHome,
        account: config.account,
        user: config.user,
      })
    : {};
  const home = yield* fs.realPath(config.agentContextHome);
  const checkedDirectories = new Set<string>();
  const checkedRoots = new Map<string, string>();
  let skippedOversizedDocumentCount = skipped;
  let scannedSourceCount = 0;
  for (const [uri, target] of selected) {
    const prior = previous.get(uri);
    const canonicalFilename = path.join(target.root.path, ...target.segments);
    const filename = prior?.source_path ?? canonicalFilename;
    const relative = path.relative(target.root.path, filename);
    if (relative === '..' || EffectString.startsWith('..' + path.sep)(relative) || path.isAbsolute(relative))
      return undefined;
    const relativeSegments = EffectArray.map(EffectString.split(path.sep)(relative), segment =>
      EffectString.normalize('NFC')(segment),
    );
    if (canonicalResourceUri(target.root.id.namespace, [...target.root.id.segments, ...relativeSegments]) !== uri)
      return undefined;
    let realRoot = checkedRoots.get(target.root.uri);
    if (!realRoot) {
      realRoot = yield* fs.realPath(target.root.path).pipe(Effect.orElseSucceed(() => undefined));
      if (!realRoot || realRoot !== path.join(home, path.relative(config.agentContextHome, target.root.path)))
        return undefined;
      checkedRoots.set(target.root.uri, realRoot);
    }
    let parent = target.root.path;
    for (const segment of ['', ...EffectString.split(path.sep)(path.dirname(relative))]) {
      if (segment && segment !== '.') parent = path.join(parent, segment);
      if (checkedDirectories.has(parent)) continue;
      if (Option.isSome(yield* fs.readLink(parent).pipe(Effect.option))) return undefined;
      const info = yield* fs.stat(parent).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== 'Directory') return undefined;
      checkedDirectories.add(parent);
    }
    if (Option.isSome(yield* fs.readLink(filename).pipe(Effect.option))) return undefined;
    const currentPath = yield* fs.realPath(filename).pipe(Effect.option);
    let verifiedFilename = filename;
    if (filename !== canonicalFilename) {
      const canonicalPath = yield* fs.realPath(canonicalFilename).pipe(Effect.option);
      if (Option.isNone(currentPath) || Option.isNone(canonicalPath) || currentPath.value !== canonicalPath.value)
        return undefined;
    }
    if (Option.isSome(currentPath)) {
      const currentRelative = path.relative(realRoot, currentPath.value);
      if (
        currentRelative === '..' ||
        EffectString.startsWith('..' + path.sep)(currentRelative) ||
        path.isAbsolute(currentRelative)
      )
        return undefined;
      const actual = EffectArray.map(EffectString.split(path.sep)(currentRelative), segment =>
        EffectString.normalize('NFC')(segment),
      );
      if (canonicalResourceUri(target.root.id.namespace, [...target.root.id.segments, ...actual]) !== uri)
        return undefined;
      verifiedFilename = path.join(target.root.path, currentRelative);
    }
    const info = yield* fs.stat(filename).pipe(Effect.result);
    if (info._tag === 'Failure') {
      if (prior && info.failure.reason._tag === 'NotFound') continue;
      return undefined;
    }
    if (info.success.type !== 'File') return undefined;
    if (Number(info.success.size) > MAX_INDEXED_FILE_BYTES) {
      skippedOversizedDocumentCount++;
      continue;
    }
    if (isExternalResourceUri(uri) && access[uri] === undefined) continue;
    yield* insertRecallSourceMetadata(sql, [
      {
        uri,
        path: verifiedFilename,
        size: Number(info.success.size),
        modifiedAt: Option.getOrUndefined(info.success.mtime)?.toISOString(),
        authorityPolicyKey: options.canonicalResourcePolicy.entryKeyByUri.get(uri) ?? null,
        invalidated: true,
        uriLocatorDigest: memoryLinkLocatorDigest(uri),
      },
    ]);
    scannedSourceCount++;
  }
  yield* indexRecallSourceLocators(sql);
  return {scannedSourceCount, skippedOversizedDocumentCount};
});

export function countRecallSourceChanges(sql: SqlClient.SqlClient, forceRefresh: boolean) {
  return sql
    .unsafe<{readonly changed_source_count: number; readonly removed_source_count: number}>(
      `SELECT
        (SELECT COUNT(*) FROM temp.${RECALL_REFRESH_SOURCE_TABLE} AS source
         LEFT JOIN documents AS document ON document.uri = source.uri
         WHERE (? = 1 OR source.invalidated = 1 OR document.id IS NULL
           OR document.source_path <> source.source_path
           OR document.source_modified_at IS NOT source.source_modified_at
           OR document.source_size <> source.source_size
           OR document.authority_policy_key IS NOT source.authority_policy_key)) AS changed_source_count,
        (SELECT COUNT(*) FROM documents AS document
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
) {
  return Effect.gen(function* () {
    let cursor: string | undefined;
    while (true) {
      const cursorPredicate = cursor === undefined ? '' : 'AND source.uri COLLATE BINARY > ? COLLATE BINARY';
      const rows = yield* sql.unsafe<RecallRefreshSourceRow>(
        `SELECT source.uri, source.source_path, source.source_modified_at, source.source_size
         FROM temp.${RECALL_REFRESH_SOURCE_TABLE} AS source
         LEFT JOIN documents AS document ON document.uri = source.uri
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
        EffectArray.map(rows, row => ({
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
      ) VALUES ${EffectArray.join(
        EffectArray.map(indexedSources, () => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
        ', ',
      )}`,
      EffectArray.flatMap(indexedSources, indexed => [
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
    const codeLinks = EffectArray.flatMap(indexedSources, indexed =>
      EffectArray.map(
        indexed.codeLinks,
        link => [indexed.source.uri, link.citationOrdinal, link.selectorKind, link.selectorDigest] as const,
      ),
    );
    for (let index = 0; index < codeLinks.length; index += 400) {
      const batch = codeLinks.slice(index, index + 400);
      yield* sql.unsafe(
        `INSERT INTO temp.${RECALL_REFRESH_INDEXED_CODE_LINK_TABLE} (
          uri, citation_ordinal, selector_kind, selector_digest
        ) VALUES ${EffectArray.join(
          EffectArray.map(batch, () => '(?, ?, ?, ?)'),
          ', ',
        )}`,
        batch.flat(),
      );
    }
    const memoryLinks = EffectArray.flatMap(indexedSources, indexed =>
      EffectArray.map(
        indexed.memoryLinks,
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
        ) VALUES ${EffectArray.join(
          EffectArray.map(batch, () => '(?, ?, ?, ?, ?, ?, ?)'),
          ', ',
        )}`,
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
        ) VALUES ${EffectArray.join(
          EffectArray.map(current, () => '(?, ?, ?, ?)'),
          ', ',
        )}`,
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

function prepareRecallSourceScan(sql: SqlClient.SqlClient) {
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
  const normalized = Effect2.pipe(path, EffectString.replaceAll('\\', '/')) + '/';
  if (Effect2.pipe(normalized, EffectString.includes('/agent-artifacts/packs/'))) return true;
  return (
    !includeInactive &&
    (Effect2.pipe(normalized, EffectString.includes('/archived/')) ||
      Effect2.pipe(normalized, EffectString.includes('/expired/')) ||
      Effect2.pipe(normalized, EffectString.includes('/superseded/')))
  );
}

function excludedFile(path: string): boolean {
  const extensionIndex = Effect2.pipe(
    path,
    EffectString.lastIndexOf('.'),
    Effect2.Option.getOrElse(() => -1),
  );
  const extension =
    extensionIndex === -1 ? '' : Effect2.pipe(path, EffectString.slice(extensionIndex), EffectString.toLowerCase);
  const normalized = Effect2.pipe(path, EffectString.replaceAll('\\', '/'));
  return (
    !TEXT_EXTENSIONS.has(extension) ||
    /\/\.(?:abstract|overview)\.md$/.test(normalized) ||
    Effect2.pipe(normalized, EffectString.includes('/agent-artifacts/packs/'))
  );
}
