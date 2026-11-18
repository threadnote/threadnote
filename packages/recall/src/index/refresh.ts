import {Array as EffectArray} from 'effect';
import {Effect, FileSystem, Option, Order, Path} from 'effect';
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
import {captureRecallSourceInput, recallRefreshSuperseded} from './refresh_cut.js';

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
export const MAX_INDEXED_FILE_BYTES = 512 * 1_024;
const TEXT_EXTENSIONS = new Set(['.json', '.md', '.mdx', '.txt', '.yaml', '.yml']);

export const RECALL_REFRESH_AFFECTED_TERM_TABLE = 'recall_refresh_affected_terms';
export const RECALL_REFRESH_INDEXED_CODE_LINK_TABLE = 'recall_refresh_indexed_code_links';
export const RECALL_REFRESH_INDEXED_DOCUMENT_TABLE = 'recall_refresh_indexed_documents';
export const RECALL_REFRESH_INDEXED_MEMORY_LINK_TABLE = 'recall_refresh_indexed_memory_links';
export const RECALL_REFRESH_INDEXED_POSTING_TABLE = 'recall_refresh_indexed_postings';
export const RECALL_REFRESH_OVERSIZED_SOURCE_TABLE = 'recall_refresh_oversized_sources';
export const RECALL_REFRESH_REPLACED_DOCUMENT_TABLE = 'recall_refresh_replaced_documents';
export const RECALL_REFRESH_SOURCE_TABLE = 'recall_refresh_sources';
export const RECALL_REFRESH_LINK_IDENTITY_TABLE = 'recall_refresh_link_identities';
export const RECALL_REFRESH_LINK_TARGET_TABLE = 'recall_refresh_link_targets';

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
  const omittedSourceInputs = new Map<string, string>();
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
          const relativeSegments = EffectArray.map(
            Effect2.pipe(path.relative(root.path, file.path), EffectString.split(path.sep)),
            segment => Effect2.pipe(segment, EffectString.normalize('NFC')),
          );
          const uri = canonicalResourceUri(rootId.namespace, [...rootId.segments, ...relativeSegments]);
          if (file.size > MAX_INDEXED_FILE_BYTES) {
            const input = yield* captureRecallSourceInput(file.path);
            if (!input.info || Number(input.info.size) !== file.size) return yield* recallRefreshSuperseded();
            omittedSourceInputs.set(file.path, input.key);
            yield* stageRecallOversizedSource(sql, uri);
            skippedOversizedDocumentCount += 1;
            return;
          }
          if (isExternalResourceUri(uri) && externalAccess[uri] === undefined) {
            omittedSourceInputs.set(file.path, (yield* captureRecallSourceInput(file.path)).key);
            return;
          }
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
  return {scannedSourceCount, skippedOversizedDocumentCount, omittedSourceInputs};
});

const queueRecallReplacedDocumentByUri = Effect.fn('recall.queueReplacedDocumentByUri')(function* (
  sql: SqlClient.SqlClient,
  uri: string,
) {
  yield* sql.unsafe(
    `INSERT OR IGNORE INTO temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE} (document_id)
     SELECT id FROM documents WHERE uri = ?`,
    [uri],
  );
});

function stageRecallOversizedSource(sql: SqlClient.SqlClient, uri: string) {
  return sql.unsafe(`INSERT OR IGNORE INTO temp.${RECALL_REFRESH_OVERSIZED_SOURCE_TABLE} (uri) VALUES (?)`, [uri]);
}

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

/** Touched staging proves only the invalidated set; full staging still inventories every permitted source. */
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
    const touched = yield* tryStageTouchedRecallSources(sql, fs, path, config, options, options.mode.contentGeneration);
    if (touched) return {...touched, mode: 'touched' as const};
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
  };
});

/** An uncertain mapping leaves the caller free to load complete policy before one full scan. */
export const tryStageTouchedRecallSources = Effect.fn('recall.tryStageTouchedSources')(function* (
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
  yield* prepareRecallSourceScan(sql);
  return yield* sql
    .withTransaction(stageTouchedRecallSources(sql, fs, path, config, options, contentGeneration))
    .pipe(Effect.provideService(SqlClient.BeginTransaction, 'BEGIN DEFERRED'));
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
  // Complement ranges keep the foreign-row probe on the URI index instead of a negated full scan.
  const foreignRanges: (readonly [string, string])[] = [];
  let covered = '';
  for (const prefix of EffectArray.sort(
    EffectArray.map(roots, root => `${root.uri}/`),
    Order.String,
  )) {
    if (prefix > covered) foreignRanges.push([covered, prefix]);
    const high = `${prefix}\u{10ffff}`;
    if (high > covered) covered = high;
  }
  const foreignInventory = yield* sql.unsafe<{readonly uri: string}>(
    `SELECT uri FROM documents
     WHERE ${EffectArray.join([...EffectArray.map(foreignRanges, () => '(uri >= ? AND uri < ?)'), 'uri >= ?'], ' OR ')}
     LIMIT 1`,
    [...EffectArray.flatten(foreignRanges), covered],
  );
  if (foreignInventory.length > 0) return undefined;
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
    if (segments.length === 0 || excludedFile(filename)) return undefined;
    // A compatible active baseline contains no lifecycle-pruned paths; an archive target adds no active row.
    if (excludedDirectory(filename, options.includeInactive)) continue;
    const key = EffectString.toLowerCase(id.value.canonicalUri);
    if (folded.has(key) && folded.get(key) !== id.value.canonicalUri) return undefined;
    folded.set(key, id.value.canonicalUri);
    selected.set(id.value.canonicalUri, {root: root.value, segments});
  }
  const previous = new Map<string, RetainedRecallSourceRow>();
  const ambiguousTargets = new Set<string>();
  const targets = [...selected];
  for (let i = 0; i < targets.length; i++)
    for (let j = i + 1; j < targets.length; j++) {
      const [leftUri, left] = targets[i];
      const [rightUri, right] = targets[j];
      if (left.root.uri === right.root.uri && recallSourcePathsMayAlias(left.segments, right.segments)) {
        ambiguousTargets.add(leftUri);
        ambiguousTargets.add(rightUri);
      }
    }
  const selectedUriList = [...selected.keys()];
  for (let index = 0; index < selectedUriList.length; index += RECALL_REFRESH_SOURCE_PAGE_SIZE) {
    const batch = selectedUriList.slice(index, index + RECALL_REFRESH_SOURCE_PAGE_SIZE);
    const priorRows = yield* sql.unsafe<RetainedRecallSourceRow>(
      `SELECT uri, source_path, source_modified_at, source_size, authority_policy_key
       FROM documents WHERE uri IN (${EffectArray.join(
         EffectArray.map(batch, () => '?'),
         ', ',
       )})`,
      batch,
    );
    for (const prior of priorRows) {
      if (!selected.has(prior.uri) || previous.has(prior.uri)) return undefined;
      previous.set(prior.uri, prior);
    }
  }
  // Oversized files have no documents row; touching one, or an ASCII case alias of one, needs the
  // full scan to recount it. The persisted set is small and must match the published count.
  const unknownUris = EffectArray.filter(selectedUriList, uri => !previous.has(uri));
  if (skipped > 0 && unknownUris.length > 0) {
    const persisted = yield* sql.unsafe<{readonly count: number}>('SELECT COUNT(*) AS count FROM oversized_sources');
    if (persisted[0]?.count !== skipped) return undefined;
    for (const batch of EffectArray.chunksOf(unknownUris, RECALL_REFRESH_SOURCE_PAGE_SIZE)) {
      const oversized = yield* sql.unsafe<{readonly present: number}>(
        `SELECT 1 AS present FROM oversized_sources WHERE uri COLLATE NOCASE IN (${EffectArray.join(
          EffectArray.map(batch, () => '?'),
          ', ',
        )}) LIMIT 1`,
        batch,
      );
      if (oversized.length > 0) return undefined;
    }
  }
  const aliasProbeTargets = EffectArray.filter(
    targets,
    ([uri, target]) =>
      !previous.has(uri) ||
      recallTouchedSourceNeedsCorpusAliasProbe(target.segments) ||
      EffectArray.some(
        targets,
        ([otherUri, other]) =>
          otherUri !== uri &&
          other.root.uri === target.root.uri &&
          recallSourcePathsMayAlias(target.segments, other.segments),
      ),
  );
  if (aliasProbeTargets.length > 0) {
    const aliasProbeOk = yield* probeTouchedRecallSourceCorpusAliases(
      sql,
      roots,
      aliasProbeTargets,
      folded,
      ambiguousTargets,
    );
    if (!aliasProbeOk) return undefined;
  }
  for (const [uri, target] of selected)
    if (
      !previous.has(uri) &&
      (ambiguousTargets.has(uri) || EffectArray.some(target.segments, segment => /\P{ASCII}/u.test(segment)))
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
  const omittedSourceInputs = new Map<string, string>();
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
      if (prior && info.failure.reason._tag === 'NotFound') {
        const input = yield* captureRecallSourceInput(filename);
        if (input.info !== undefined) return yield* recallRefreshSuperseded();
        yield* queueRecallReplacedDocumentByUri(sql, uri);
        omittedSourceInputs.set(filename, input.key);
        continue;
      }
      return undefined;
    }
    if (info.success.type !== 'File') return undefined;
    if (Number(info.success.size) > MAX_INDEXED_FILE_BYTES) {
      const input = yield* captureRecallSourceInput(filename);
      if (!input.info || input.info.size !== info.success.size) return yield* recallRefreshSuperseded();
      if (prior) yield* queueRecallReplacedDocumentByUri(sql, uri);
      omittedSourceInputs.set(filename, input.key);
      yield* stageRecallOversizedSource(sql, uri);
      skippedOversizedDocumentCount++;
      continue;
    }
    if (isExternalResourceUri(uri) && access[uri] === undefined) {
      omittedSourceInputs.set(filename, (yield* captureRecallSourceInput(filename)).key);
      continue;
    }
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
  return {scannedSourceCount, skippedOversizedDocumentCount, omittedSourceInputs};
});

function recallTouchedSourceNeedsCorpusAliasProbe(segments: readonly string[]) {
  return EffectArray.some(
    segments,
    segment => /\P{ASCII}/u.test(segment) || EffectString.toLowerCase(segment) !== segment,
  );
}

interface RecallCaseAliasBranch {
  readonly exact: boolean;
  readonly index: number;
  readonly prefix: string;
}

interface RecallCaseAliasProbe {
  readonly high: string;
  readonly hit: (uri: string) => void;
  readonly low: string;
}

const RECALL_CASE_ALIAS_BRANCH_LIMIT = 64;
const RECALL_CASE_ALIAS_PROBE_BATCH = 256;

/**
 * Stored URIs that may name `uri` on a case-insensitive filesystem. Canonical URIs are
 * percent-encoded ASCII, so the walk follows ASCII case spellings of the encoded target over the
 * binary URI index and keeps a branch only while some stored URI starts with it. Probes therefore
 * scale with case-variant prefixes present in the corpus, not with directory or root size. A
 * stored URI that leaves a case-matching prefix through an encoded non-ASCII byte (`%C`..`%F`) is
 * returned too, because its filesystem folding is unknown. A branch reports its first stored URI
 * when it completes a segment, which proves an aliased directory or file. Too many live branches
 * return undefined so the caller falls back to a full scan.
 */
const findRecallCaseAliasUris = Effect.fn('recall.findCaseAliasUris')(function* (
  sql: SqlClient.SqlClient,
  rootUri: string,
  uri: string,
) {
  const base = `${rootUri}/`;
  const rest = EffectString.slice(base.length)(uri);
  const aliases = new Set<string>();
  const probesFor = (branch: RecallCaseAliasBranch, next: RecallCaseAliasBranch[]) => {
    const probes: RecallCaseAliasProbe[] = [];
    if (branch.index === rest.length) return probes;
    const char = rest[branch.index];
    if (char !== '%')
      probes.push({low: `${branch.prefix}%C`, high: `${branch.prefix}%G`, hit: alias => aliases.add(alias)});
    const spellings: readonly string[] = /^[A-Za-z]$/.test(char)
      ? [EffectString.toLowerCase(char), EffectString.toUpperCase(char)]
      : [char];
    for (const spelling of spellings) {
      if (branch.exact && spelling === char) continue;
      const prefix = `${branch.prefix}${spelling}`;
      const index = branch.index + 1;
      probes.push({
        low: prefix,
        high: `${prefix}\u{10ffff}`,
        hit: alias => {
          next.push({exact: false, index, prefix});
          if (spelling === '/' || index === rest.length) aliases.add(alias);
        },
      });
    }
    return probes;
  };
  let branches: RecallCaseAliasBranch[] = [];
  let probes: RecallCaseAliasProbe[] = [];
  for (let index = 0; index < rest.length; index++)
    probes.push(...probesFor({exact: true, index, prefix: `${base}${EffectString.slice(0, index)(rest)}`}, branches));
  while (probes.length > 0) {
    for (const batch of EffectArray.chunksOf(probes, RECALL_CASE_ALIAS_PROBE_BATCH)) {
      const rows = yield* sql.unsafe<{readonly id: number; readonly uri: string | null}>(
        `WITH probe(id, low, high) AS (VALUES ${EffectArray.join(
          EffectArray.map(batch, () => '(?, ?, ?)'),
          ', ',
        )})
         SELECT probe.id AS id,
           (SELECT uri FROM documents WHERE uri >= probe.low AND uri < probe.high ORDER BY uri LIMIT 1) AS uri
         FROM probe`,
        EffectArray.flatMap(batch, (probe, id) => [id, probe.low, probe.high]),
      );
      for (const row of rows) if (row.uri !== null) batch[row.id].hit(row.uri);
    }
    if (branches.length > RECALL_CASE_ALIAS_BRANCH_LIMIT) return undefined;
    const current = branches;
    branches = [];
    probes = EffectArray.flatMap(current, branch => probesFor(branch, branches));
  }
  return aliases;
});

const probeTouchedRecallSourceCorpusAliases = Effect.fn('recall.probeTouchedCorpusAliases')(function* (
  sql: SqlClient.SqlClient,
  roots: readonly {readonly uri: string; readonly id: {readonly segments: readonly string[]}}[],
  targets: readonly [string, {readonly root: {readonly uri: string}; readonly segments: readonly string[]}][],
  folded: ReadonlyMap<string, string>,
  ambiguousTargets: Set<string>,
) {
  for (const [uri, target] of targets) {
    const aliases = yield* findRecallCaseAliasUris(sql, target.root.uri, uri);
    if (aliases === undefined) return false;
    for (const alias of aliases) {
      const foldedTarget = folded.get(EffectString.toLowerCase(alias));
      if (foldedTarget !== undefined && foldedTarget !== alias) return false;
      const root = EffectArray.findFirst(roots, candidate => EffectString.startsWith(candidate.uri + '/')(alias));
      if (Option.isNone(root)) return false;
      const id = yield* Effect.try(() => parseResourceId(alias)).pipe(Effect.option);
      if (Option.isNone(id)) return false;
      const segments = id.value.segments.slice(root.value.id.segments.length);
      if (target.root.uri === root.value.uri && recallSourcePathsMayAlias(segments, target.segments))
        ambiguousTargets.add(uri);
    }
  }
  return true;
});

/** Only a differing ASCII branch proves that two filesystem paths cannot alias. */
function recallSourcePathsMayAlias(left: readonly string[], right: readonly string[]): boolean {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    return (
      /\P{ASCII}/u.test(left[i]) ||
      /\P{ASCII}/u.test(right[i]) ||
      EffectString.toLowerCase(left[i]) === EffectString.toLowerCase(right[i])
    );
  }
  return true;
}

export function countRecallSourceChanges(sql: SqlClient.SqlClient, forceRefresh: boolean, inventoryComplete: boolean) {
  return sql
    .unsafe<{readonly changed_source_count: number; readonly removed_source_count: number}>(
      `SELECT
        (SELECT COUNT(*) FROM temp.${RECALL_REFRESH_SOURCE_TABLE} AS source
         LEFT JOIN documents AS document ON document.uri = source.uri
         WHERE (? = 1 OR source.invalidated = 1 OR document.id IS NULL
           OR document.source_path <> source.source_path
           OR document.source_modified_at IS NOT source.source_modified_at
           OR document.source_size <> source.source_size
           OR document.authority_policy_key IS NOT source.authority_policy_key)
         ) + (SELECT COUNT(*) FROM temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE}) AS changed_source_count,
        (SELECT COUNT(*) FROM documents AS document
         LEFT JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS source ON source.uri = document.uri
         WHERE source.uri IS NULL AND ? = 1)
         + (SELECT COUNT(*) FROM temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE} AS replaced
            CROSS JOIN documents AS document ON document.id = replaced.document_id) AS removed_source_count`,
      [forceRefresh ? 1 : 0, inventoryComplete ? 1 : 0],
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
        memory_id, content_hash, candidate_json, logical_key, document_length, exact_search_text,
        memory_links_json, memory_links_truncated
      ) VALUES ${EffectArray.join(
        EffectArray.map(indexedSources, () => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
        ', ',
      )}`,
      EffectArray.flatMap(indexedSources, indexed => [
        stripRecallAnchor(indexed.candidate.uri),
        recallIndexedProject(indexed.candidate),
        recallApprovedAuthoritative(indexed.candidate.authority, indexed.candidate.trust) ? 1 : 0,
        normalizeRecallWorkspaceScope(indexed.candidate.fields?.workspaceScope) ?? null,
        normalizedRecallRecordedAt(indexed.candidate.timestamp),
        typeof indexed.candidate.memoryId === 'string' ? indexed.candidate.memoryId : null,
        typeof indexed.candidate.contentHash === 'string' ? indexed.candidate.contentHash : null,
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

export function hashRecallRefreshGeneration(
  sql: SqlClient.SqlClient,
  previousContentGeneration: string | undefined,
  inventoryComplete: boolean,
) {
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
    let tombstoneCursor: string | undefined;
    for (;;) {
      const tombstones = yield* sql.unsafe<{readonly uri: string}>(
        `SELECT document.uri FROM temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE} AS replaced
         CROSS JOIN documents AS document ON document.id = replaced.document_id
         ${tombstoneCursor === undefined ? '' : 'WHERE document.uri COLLATE BINARY > ? COLLATE BINARY'}
         ORDER BY document.uri COLLATE BINARY LIMIT ?`,
        tombstoneCursor === undefined
          ? [RECALL_REFRESH_SOURCE_PAGE_SIZE]
          : [tombstoneCursor, RECALL_REFRESH_SOURCE_PAGE_SIZE],
      );
      if (tombstones.length === 0) break;
      for (const row of tombstones) {
        hash.update(`${first ? '' : ','}${JSON.stringify(row.uri)}`);
        first = false;
      }
      tombstoneCursor = tombstones.at(-1)?.uri;
      if (tombstones.length < RECALL_REFRESH_SOURCE_PAGE_SIZE) break;
    }
    if (inventoryComplete) {
      cursor = undefined;
      while (true) {
        const predicate: string = cursor === undefined ? '' : 'AND document.uri COLLATE BINARY > ? COLLATE BINARY';
        const rows: readonly {readonly uri: string}[] = yield* sql.unsafe<{readonly uri: string}>(
          `SELECT document.uri FROM documents AS document
           LEFT JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS source ON source.uri = document.uri
           LEFT JOIN temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE} AS replaced ON replaced.document_id = document.id
           WHERE source.uri IS NULL AND replaced.document_id IS NULL ${predicate}
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
    }
    hash.update(']}');
    return hash.digest('hex');
  });
}

export function stageRecallRefreshAffectedTerms(sql: SqlClient.SqlClient, inventoryComplete: boolean) {
  return Effect.gen(function* () {
    yield* sql.unsafe(
      `
      INSERT INTO temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE} (document_id)
      SELECT document.id FROM documents AS document
      LEFT JOIN temp.${RECALL_REFRESH_SOURCE_TABLE} AS source ON source.uri = document.uri
      LEFT JOIN temp.${RECALL_REFRESH_INDEXED_DOCUMENT_TABLE} AS indexed ON indexed.uri = document.uri
      WHERE ${inventoryComplete ? 'source.uri IS NULL OR indexed.uri IS NOT NULL' : 'indexed.uri IS NOT NULL'}
    `,
    );
    yield* sql.unsafe(`
      INSERT OR IGNORE INTO temp.${RECALL_REFRESH_AFFECTED_TERM_TABLE} (term)
      SELECT posting.term FROM temp.${RECALL_REFRESH_REPLACED_DOCUMENT_TABLE} AS replaced
      CROSS JOIN postings AS posting ON posting.document_id = replaced.document_id
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
      RECALL_REFRESH_LINK_IDENTITY_TABLE,
      RECALL_REFRESH_LINK_TARGET_TABLE,
      RECALL_REFRESH_OVERSIZED_SOURCE_TABLE,
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
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_LINK_IDENTITY_TABLE} (
      memory_id TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_LINK_TARGET_TABLE} (
      uri_locator_digest TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_OVERSIZED_SOURCE_TABLE} (
      uri TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID`);
    yield* sql.unsafe(`CREATE TEMP TABLE ${RECALL_REFRESH_INDEXED_DOCUMENT_TABLE} (
      uri TEXT PRIMARY KEY NOT NULL, project TEXT,
      approved_authoritative INTEGER NOT NULL CHECK (approved_authoritative IN (0, 1)),
      workspace_scope TEXT, recorded_at TEXT, memory_id TEXT, content_hash TEXT,
      candidate_json TEXT NOT NULL, logical_key TEXT NOT NULL,
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

/** The caller supplies canonical paths; a URI alone cannot prove physical account membership. */
export function recallSourceIsWithinIndexRoots(
  config: RecallRefreshConfig,
  path: Path.Path,
  uri: string,
  filename: string,
): boolean {
  return EffectArray.some(recallIndexRoots(config, path), root => {
    const relative = path.relative(root.path, filename);
    return (
      EffectString.startsWith(root.uri + '/')(uri) &&
      relative !== '' &&
      relative !== '..' &&
      !EffectString.startsWith('..' + path.sep)(relative) &&
      !path.isAbsolute(relative)
    );
  });
}

export function recallSourceIsIntentionallyExcluded(
  config: RecallRefreshConfig,
  path: Path.Path,
  includeInactive: boolean,
  uri: string,
  filename: string,
): boolean {
  return (
    !EffectArray.some(recallIndexRoots(config, path), root => EffectString.startsWith(root.uri + '/')(uri)) ||
    excludedDirectory(filename, includeInactive) ||
    excludedFile(filename)
  );
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
