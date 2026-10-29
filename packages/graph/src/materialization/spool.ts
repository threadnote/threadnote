import {Array as EffectArray} from 'effect';
import type {Database} from 'bun:sqlite';
import type {Path} from 'effect';
import type {CodeGraphLayout} from '../layout.js';
import {
  assertCodeGraphMaterializationSpoolSurfaceState,
  CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES,
  initializeCodeGraphMaterializationSpoolSurfaces,
  readCodeGraphMaterializationSpoolSurfaceCapacities,
  sortCodeGraphMaterializationSpoolSurface,
} from './spool/surfaces.js';
import {codeGraphSqliteAll, codeGraphSqliteGet, codeGraphSqliteRun} from '../sqlite_statement.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_GRAPH_MATERIALIZATION_SPOOL_FORMAT_VERSION = 2 as const;
export const CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS = 50_000;
export const CODE_GRAPH_MATERIALIZATION_SORT_SURFACES_MAXIMUM = 32;

const PERSISTENT_SNAPSHOT_ID = /^cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?$/u;

export interface CodeGraphMaterializationApplyPage {
  readonly afterRowid: number;
  readonly rowCount: number;
}

export interface CodeGraphMaterializationSpoolHeader {
  readonly checkoutId: string;
  readonly extractorSet: string;
  readonly graphContentId: string;
  readonly repositoryId: string;
  readonly snapshotId: string;
}

export interface CodeGraphMaterializationSpoolBatchReceipt {
  readonly batchId: string;
  readonly batchIndex: number;
  readonly candidateCount: number;
  readonly edgeCount: number;
  readonly factBytes: number;
  readonly lookupCount: number;
  readonly referenceCount: number;
  readonly reexportCount: number;
  readonly rowCount: number;
  readonly sourceBytes: number;
  readonly symbolCount: number;
  readonly termCount: number;
}

export interface CodeGraphMaterializationSpoolState {
  readonly appendedBatchCount: number;
  readonly expectedBatchCount?: number;
  readonly expectedSurfaceCount?: number;
  readonly sortedSurfaceCount?: number;
  readonly stage: 'appending' | 'ready' | 'sealed' | 'sorting';
}

export interface CodeGraphMaterializationSpoolReadyPlan {
  readonly batches: readonly CodeGraphMaterializationSpoolBatchReceipt[];
  readonly lexicalTermCount: number;
  readonly spoolIdentity: string;
  readonly surfaces: readonly {readonly name: string; readonly rowCount: number}[];
}

interface CodeGraphMaterializationSpoolHeaderRow {
  readonly checkout_id: string;
  readonly extractor_set: string;
  readonly format_version: number;
  readonly graph_content_id: string;
  readonly repository_id: string;
  readonly snapshot_id: string;
}

interface CodeGraphMaterializationSpoolBatchReceiptRow {
  readonly batch_id: string;
  readonly batch_index: number;
  readonly candidate_count: number;
  readonly edge_count: number;
  readonly fact_bytes: number;
  readonly lookup_count: number;
  readonly reference_count: number;
  readonly reexport_count: number;
  readonly row_count: number;
  readonly source_bytes: number;
  readonly symbol_count: number;
  readonly term_count: number;
}

interface CodeGraphMaterializationSpoolStateRow {
  readonly appended_batch_count: number;
  readonly expected_batch_count: number | null;
  readonly expected_surface_count: number | null;
  readonly sorted_surface_count: number;
  readonly stage: 'appending' | 'ready' | 'sealed' | 'sorting';
}

interface CodeGraphMaterializationSpoolCountRow {
  readonly count: number | bigint;
}

/**
 * A sidecar belongs to one opaque persistent snapshot and lives beside its
 * main database so capacity accounting observes one durable filesystem.
 */
export function codeGraphMaterializationSpoolPath(
  path: Pick<Path.Path, 'join'>,
  layout: Pick<CodeGraphLayout, 'repositoryRoot'>,
  snapshotId: string,
): string {
  if (!PERSISTENT_SNAPSHOT_ID.test(snapshotId)) {
    throw new Error('Code graph materialization spool snapshot identity is invalid.');
  }
  return path.join(
    layout.repositoryRoot,
    `materialization-spool-v${CODE_GRAPH_MATERIALIZATION_SPOOL_FORMAT_VERSION}-${snapshotId}.sqlite`,
  );
}

/**
 * Stable median-block rowid pages let the main database commit final rows and
 * its resume cursor atomically while preserving B-tree fill without retaining
 * a repository-sized decoded page.
 */
export function codeGraphMaterializationApplyPages(
  rowCount: number,
  pageRows = CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS,
): readonly CodeGraphMaterializationApplyPage[] {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error('Code graph materialization spool row count is invalid.');
  }
  if (!Number.isSafeInteger(pageRows) || pageRows <= 0 || pageRows > CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS) {
    throw new Error('Code graph materialization spool page bound is invalid.');
  }
  const blockCount = Math.ceil(rowCount / pageRows);
  const pages: CodeGraphMaterializationApplyPage[] = [];
  const pending: Array<readonly [number, number]> = [[0, blockCount]];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const [start, end] = pending[cursor];
    if (start >= end) continue;
    const block = Math.floor((start + end) / 2);
    const afterRowid = block * pageRows;
    pages.push({afterRowid, rowCount: Math.min(pageRows, rowCount - afterRowid)});
    pending.push([start, block], [block + 1, end]);
  }
  return pages;
}

/**
 * The spool is reconstructible but each append/sort stage must remain atomic
 * across interruption. Rollback journaling keeps that guarantee without a
 * second long-lived WAL competing with the final graph database.
 */
export function configureCodeGraphMaterializationSpoolDatabase(database: Database): void {
  database.exec('PRAGMA page_size = 8192');
  database.exec('PRAGMA journal_mode = DELETE');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA temp_store = FILE');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
}

/**
 * Creates or verifies the immutable identity header. A stale sidecar from any
 * other repository, snapshot, extractor, or graph content fails closed.
 */
export function initializeCodeGraphMaterializationSpoolDatabase(
  database: Database,
  expected: CodeGraphMaterializationSpoolHeader,
): 'created' | 'resumed' {
  validateCodeGraphMaterializationSpoolHeader(expected);
  return database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS materialization_spool_header (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
        format_version INTEGER NOT NULL CHECK (format_version = ${CODE_GRAPH_MATERIALIZATION_SPOOL_FORMAT_VERSION}),
        checkout_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        graph_content_id TEXT NOT NULL,
        extractor_set TEXT NOT NULL
      ) WITHOUT ROWID
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS materialization_spool_state (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
        stage TEXT NOT NULL CHECK (stage IN ('appending', 'sealed', 'sorting', 'ready')),
        appended_batch_count INTEGER NOT NULL CHECK (appended_batch_count >= 0),
        expected_batch_count INTEGER CHECK (expected_batch_count >= 0),
        sorted_surface_count INTEGER NOT NULL CHECK (sorted_surface_count >= 0),
        expected_surface_count INTEGER CHECK (
          expected_surface_count > 0 AND expected_surface_count <= ${CODE_GRAPH_MATERIALIZATION_SORT_SURFACES_MAXIMUM}
        ),
        CHECK (
          (stage = 'appending' AND expected_batch_count IS NULL
            AND sorted_surface_count = 0 AND expected_surface_count IS NULL) OR
          (stage = 'sealed' AND expected_batch_count = appended_batch_count
            AND sorted_surface_count = 0 AND expected_surface_count IS NULL) OR
          (stage = 'sorting' AND expected_batch_count = appended_batch_count
            AND sorted_surface_count <= expected_surface_count) OR
          (stage = 'ready' AND expected_batch_count = appended_batch_count
            AND sorted_surface_count = expected_surface_count)
        )
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS materialization_spool_batches (
        batch_index INTEGER PRIMARY KEY NOT NULL CHECK (batch_index >= 0),
        batch_id TEXT NOT NULL CHECK (length(batch_id) = 64),
        fact_bytes INTEGER NOT NULL CHECK (fact_bytes >= 0),
        source_bytes INTEGER NOT NULL CHECK (source_bytes >= 0),
        row_count INTEGER NOT NULL CHECK (row_count >= 0),
        symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0),
        edge_count INTEGER NOT NULL CHECK (edge_count >= 0),
        term_count INTEGER NOT NULL CHECK (term_count >= 0),
        lookup_count INTEGER NOT NULL CHECK (lookup_count >= 0),
        reference_count INTEGER NOT NULL CHECK (reference_count >= 0),
        candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
        reexport_count INTEGER NOT NULL CHECK (reexport_count >= 0)
      ) WITHOUT ROWID
    `);
    const current = codeGraphSqliteAll<CodeGraphMaterializationSpoolHeaderRow>(
      database,
      `SELECT format_version, checkout_id, repository_id, snapshot_id, graph_content_id, extractor_set
       FROM materialization_spool_header
       WHERE singleton = 1
       LIMIT 2`,
    );
    if (current.length === 0) {
      codeGraphSqliteRun(
        database,
        `INSERT INTO materialization_spool_header (
           singleton, format_version, checkout_id, repository_id, snapshot_id, graph_content_id, extractor_set
         ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
        CODE_GRAPH_MATERIALIZATION_SPOOL_FORMAT_VERSION,
        expected.checkoutId,
        expected.repositoryId,
        expected.snapshotId,
        expected.graphContentId,
        expected.extractorSet,
      );
      database.exec(`
        INSERT INTO materialization_spool_state (
          singleton, stage, appended_batch_count, expected_batch_count,
          sorted_surface_count, expected_surface_count
        ) VALUES (1, 'appending', 0, NULL, 0, NULL)
      `);
      initializeCodeGraphMaterializationSpoolSurfaces(database);
      return 'created';
    }
    if (current.length !== 1 || !codeGraphMaterializationSpoolHeaderMatches(current[0], expected)) {
      throw new Error('Code graph materialization spool identity does not match the persistent build.');
    }
    assertCodeGraphMaterializationSpoolLedger(database);
    const state = readCodeGraphMaterializationSpoolState(database);
    assertCodeGraphMaterializationSpoolSurfaceState(database, state.stage, state.sortedSurfaceCount ?? 0);
    readCodeGraphMaterializationSpoolSurfaceCapacities(database);
    return 'resumed';
  })();
}

/**
 * Commits one deterministic append receipt. Exact replay is idempotent, while
 * gaps or different content at an already committed index fail closed.
 */
export function commitCodeGraphMaterializationSpoolBatch(
  database: Database,
  receipt: CodeGraphMaterializationSpoolBatchReceipt,
  writeBatch: () => void,
  observeTransaction?: () => void,
): 'appended' | 'resumed' {
  validateCodeGraphMaterializationSpoolBatchReceipt(receipt);
  return database.transaction(() => {
    const state = readCodeGraphMaterializationSpoolState(database);
    const current = codeGraphSqliteGet<CodeGraphMaterializationSpoolBatchReceiptRow>(
      database,
      `SELECT batch_index, batch_id, fact_bytes, source_bytes, row_count,
         symbol_count, edge_count, term_count, lookup_count, reference_count,
         candidate_count, reexport_count
       FROM materialization_spool_batches
       WHERE batch_index = ?`,
      receipt.batchIndex,
    );
    if (current !== null) {
      if (!codeGraphMaterializationSpoolBatchReceiptMatches(current, receipt)) {
        throw new Error('Code graph materialization spool batch identity does not match the committed receipt.');
      }
      return 'resumed';
    }
    if (state.stage !== 'appending') {
      throw new Error('Code graph materialization spool is already sealed.');
    }
    if (receipt.batchIndex !== state.appendedBatchCount) {
      throw new Error('Code graph materialization spool batch sequence is not contiguous.');
    }
    writeBatch();
    codeGraphSqliteRun(
      database,
      `INSERT INTO materialization_spool_batches (
         batch_index, batch_id, fact_bytes, source_bytes, row_count,
         symbol_count, edge_count, term_count, lookup_count, reference_count,
         candidate_count, reexport_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      receipt.batchIndex,
      receipt.batchId,
      receipt.factBytes,
      receipt.sourceBytes,
      receipt.rowCount,
      receipt.symbolCount,
      receipt.edgeCount,
      receipt.termCount,
      receipt.lookupCount,
      receipt.referenceCount,
      receipt.candidateCount,
      receipt.reexportCount,
    );
    codeGraphSqliteRun(
      database,
      `UPDATE materialization_spool_state
       SET appended_batch_count = appended_batch_count + 1
       WHERE singleton = 1 AND stage = 'appending' AND appended_batch_count = ?`,
      state.appendedBatchCount,
    );
    observeTransaction?.();
    return 'appended';
  })();
}

/** Seals the append surface only when every expected contiguous batch exists. */
export function sealCodeGraphMaterializationSpool(
  database: Database,
  expectedBatchCount: number,
): 'sealed' | 'resumed' {
  validateNonNegativeSafeInteger(expectedBatchCount, 'expected batch count');
  return database.transaction(() => {
    const state = readCodeGraphMaterializationSpoolState(database);
    if (state.stage !== 'appending') {
      if (state.expectedBatchCount !== expectedBatchCount) {
        throw new Error('Code graph materialization spool sealed batch count does not match.');
      }
      return 'resumed';
    }
    if (state.appendedBatchCount !== expectedBatchCount) {
      throw new Error('Code graph materialization spool cannot seal before every expected batch is committed.');
    }
    codeGraphSqliteRun(
      database,
      `UPDATE materialization_spool_state
       SET stage = 'sealed', expected_batch_count = ?
       WHERE singleton = 1 AND stage = 'appending' AND appended_batch_count = ?`,
      expectedBatchCount,
      expectedBatchCount,
    );
    return 'sealed';
  })();
}

export function beginCodeGraphMaterializationSpoolSort(
  database: Database,
  expectedSurfaceCount: number,
): 'sorting' | 'resumed' {
  validatePositiveSurfaceCount(expectedSurfaceCount);
  return database.transaction(() => {
    const state = readCodeGraphMaterializationSpoolState(database);
    if (state.stage === 'sorting' || state.stage === 'ready') {
      if (state.expectedSurfaceCount !== expectedSurfaceCount) {
        throw new Error('Code graph materialization spool sorted surface count does not match.');
      }
      return 'resumed';
    }
    if (state.stage !== 'sealed') {
      throw new Error('Code graph materialization spool must be sealed before sorting.');
    }
    codeGraphSqliteRun(
      database,
      `UPDATE materialization_spool_state
       SET stage = 'sorting', expected_surface_count = ?
       WHERE singleton = 1 AND stage = 'sealed'`,
      expectedSurfaceCount,
    );
    return 'sorting';
  })();
}

/** Commits one CTAS/drop surface and its contiguous resume cursor together. */
export function commitCodeGraphMaterializationSpoolSortedSurface(
  database: Database,
  surfaceIndex: number,
  writeSurface: () => void,
  observeTransaction?: () => void,
): 'sorted' | 'resumed' {
  validateNonNegativeSafeInteger(surfaceIndex, 'surface index');
  return database.transaction(() => {
    const state = readCodeGraphMaterializationSpoolState(database);
    const sortedSurfaceCount = state.sortedSurfaceCount ?? 0;
    if ((state.stage === 'sorting' || state.stage === 'ready') && surfaceIndex < sortedSurfaceCount) return 'resumed';
    if (state.stage !== 'sorting') {
      throw new Error('Code graph materialization spool is not sorting.');
    }
    if (surfaceIndex !== sortedSurfaceCount || surfaceIndex >= (state.expectedSurfaceCount ?? 0)) {
      throw new Error('Code graph materialization spool sorted surface sequence is not contiguous.');
    }
    writeSurface();
    codeGraphSqliteRun(
      database,
      `UPDATE materialization_spool_state
       SET sorted_surface_count = sorted_surface_count + 1
       WHERE singleton = 1 AND stage = 'sorting' AND sorted_surface_count = ?`,
      surfaceIndex,
    );
    observeTransaction?.();
    return 'sorted';
  })();
}

export function finishCodeGraphMaterializationSpoolSort(database: Database): 'ready' | 'resumed' {
  return database.transaction(() => {
    const state = readCodeGraphMaterializationSpoolState(database);
    if (state.stage === 'ready') return 'resumed';
    if (
      state.stage !== 'sorting' ||
      state.expectedSurfaceCount === undefined ||
      state.sortedSurfaceCount !== state.expectedSurfaceCount
    ) {
      throw new Error('Code graph materialization spool cannot become ready before every surface is sorted.');
    }
    codeGraphSqliteRun(
      database,
      `UPDATE materialization_spool_state
       SET stage = 'ready'
       WHERE singleton = 1 AND stage = 'sorting' AND sorted_surface_count = expected_surface_count`,
    );
    return 'ready';
  })();
}

export function sortCodeGraphMaterializationSpoolSurfaces(database: Database, observeTransaction?: () => void): void {
  beginCodeGraphMaterializationSpoolSort(database, CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length);
  for (let index = 0; index < CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length; index += 1) {
    const surface = CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES[index];
    commitCodeGraphMaterializationSpoolSortedSurface(
      database,
      index,
      () => sortCodeGraphMaterializationSpoolSurface(database, surface),
      observeTransaction,
    );
  }
  finishCodeGraphMaterializationSpoolSort(database);
}

export function readCodeGraphMaterializationSpoolReadyPlan(database: Database): CodeGraphMaterializationSpoolReadyPlan {
  const state = readCodeGraphMaterializationSpoolState(database);
  if (state.stage !== 'ready') {
    throw new Error('Code graph materialization spool is not ready to apply.');
  }
  assertCodeGraphMaterializationSpoolLedger(database);
  assertCodeGraphMaterializationSpoolSurfaceState(database, state.stage, state.sortedSurfaceCount ?? 0);
  const headers = codeGraphSqliteAll<CodeGraphMaterializationSpoolHeaderRow>(
    database,
    `SELECT format_version, checkout_id, repository_id, snapshot_id, graph_content_id, extractor_set
     FROM materialization_spool_header
     WHERE singleton = 1
     LIMIT 2`,
  );
  if (headers.length !== 1) {
    throw new Error('Code graph materialization spool header is missing or corrupt.');
  }
  const receipts = codeGraphSqliteAll<CodeGraphMaterializationSpoolBatchReceiptRow>(
    database,
    `SELECT batch_index, batch_id, fact_bytes, source_bytes, row_count,
       symbol_count, edge_count, term_count, lookup_count, reference_count,
       candidate_count, reexport_count
     FROM materialization_spool_batches
     ORDER BY batch_index`,
  );
  const surfaces = EffectArray.map(CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES, surface => {
    const row = codeGraphSqliteGet<CodeGraphMaterializationSpoolCountRow>(
      database,
      `SELECT COUNT(*) AS count FROM materialization_ordered_${surface.name}`,
    );
    if (row === null) throw new Error('Code graph materialization spool surface row count is missing.');
    const rowCount = Number(row.count);
    if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
      throw new Error('Code graph materialization spool surface row count is invalid.');
    }
    return {name: surface.name, rowCount};
  });
  const lexicalTermCountRow = codeGraphSqliteGet<CodeGraphMaterializationSpoolCountRow>(
    database,
    'SELECT COUNT(*) AS count FROM materialization_ordered_terms',
  );
  if (lexicalTermCountRow === null) {
    throw new Error('Code graph materialization spool lexical term count is missing.');
  }
  const lexicalTermCount = Number(lexicalTermCountRow.count);
  if (!Number.isSafeInteger(lexicalTermCount) || lexicalTermCount < 0) {
    throw new Error('Code graph materialization spool lexical term count is invalid.');
  }
  const digest = new Bun.CryptoHasher('sha256');
  digest.update(
    JSON.stringify({
      header: headers[0],
      lexicalTermCount,
      receipts,
      surfaces,
      version: CODE_GRAPH_MATERIALIZATION_SPOOL_FORMAT_VERSION,
    }),
  );
  return {
    batches: EffectArray.map(receipts, materializationSpoolBatchReceiptFromRow),
    lexicalTermCount,
    spoolIdentity: digest.digest('hex'),
    surfaces,
  };
}

export function readCodeGraphMaterializationSpoolState(database: Database): CodeGraphMaterializationSpoolState {
  const rows = codeGraphSqliteAll<CodeGraphMaterializationSpoolStateRow>(
    database,
    `SELECT stage, appended_batch_count, expected_batch_count,
       sorted_surface_count, expected_surface_count
     FROM materialization_spool_state
     WHERE singleton = 1
     LIMIT 2`,
  );
  if (rows.length !== 1) {
    throw new Error('Code graph materialization spool state is missing or corrupt.');
  }
  const row = rows[0];
  if (
    !Number.isSafeInteger(row.appended_batch_count) ||
    row.appended_batch_count < 0 ||
    !Number.isSafeInteger(row.sorted_surface_count) ||
    row.sorted_surface_count < 0 ||
    (row.stage === 'appending' &&
      (row.expected_batch_count !== null || row.expected_surface_count !== null || row.sorted_surface_count !== 0)) ||
    (row.stage === 'sealed' &&
      (row.expected_batch_count !== row.appended_batch_count ||
        row.expected_surface_count !== null ||
        row.sorted_surface_count !== 0)) ||
    ((row.stage === 'sorting' || row.stage === 'ready') &&
      (row.expected_batch_count !== row.appended_batch_count ||
        row.expected_surface_count === null ||
        !Number.isSafeInteger(row.expected_surface_count) ||
        row.expected_surface_count <= 0 ||
        row.expected_surface_count > CODE_GRAPH_MATERIALIZATION_SORT_SURFACES_MAXIMUM ||
        row.sorted_surface_count > row.expected_surface_count ||
        (row.stage === 'ready' && row.sorted_surface_count !== row.expected_surface_count)))
  ) {
    throw new Error('Code graph materialization spool state is missing or corrupt.');
  }
  return {
    appendedBatchCount: row.appended_batch_count,
    ...(row.expected_batch_count === null ? {} : {expectedBatchCount: row.expected_batch_count}),
    ...(row.expected_surface_count === null
      ? {}
      : {expectedSurfaceCount: row.expected_surface_count, sortedSurfaceCount: row.sorted_surface_count}),
    stage: row.stage,
  };
}

function assertCodeGraphMaterializationSpoolLedger(database: Database): void {
  const state = readCodeGraphMaterializationSpoolState(database);
  const receipts = codeGraphSqliteAll<CodeGraphMaterializationSpoolBatchReceiptRow>(
    database,
    `SELECT batch_index, batch_id, fact_bytes, source_bytes, row_count,
       symbol_count, edge_count, term_count, lookup_count, reference_count,
       candidate_count, reexport_count
     FROM materialization_spool_batches
     ORDER BY batch_index`,
  );
  if (
    receipts.length !== state.appendedBatchCount ||
    EffectArray.some(
      receipts,
      (receipt, index) => receipt.batch_index !== index || !/^[0-9a-f]{64}$/u.test(receipt.batch_id),
    )
  ) {
    throw new Error('Code graph materialization spool batch ledger is corrupt.');
  }
}

function codeGraphMaterializationSpoolHeaderMatches(
  current: CodeGraphMaterializationSpoolHeaderRow,
  expected: CodeGraphMaterializationSpoolHeader,
): boolean {
  return (
    current.format_version === CODE_GRAPH_MATERIALIZATION_SPOOL_FORMAT_VERSION &&
    current.checkout_id === expected.checkoutId &&
    current.repository_id === expected.repositoryId &&
    current.snapshot_id === expected.snapshotId &&
    current.graph_content_id === expected.graphContentId &&
    current.extractor_set === expected.extractorSet
  );
}

function codeGraphMaterializationSpoolBatchReceiptMatches(
  current: CodeGraphMaterializationSpoolBatchReceiptRow,
  expected: CodeGraphMaterializationSpoolBatchReceipt,
): boolean {
  return (
    current.batch_index === expected.batchIndex &&
    current.batch_id === expected.batchId &&
    current.fact_bytes === expected.factBytes &&
    current.source_bytes === expected.sourceBytes &&
    current.row_count === expected.rowCount &&
    current.symbol_count === expected.symbolCount &&
    current.edge_count === expected.edgeCount &&
    current.term_count === expected.termCount &&
    current.lookup_count === expected.lookupCount &&
    current.reference_count === expected.referenceCount &&
    current.candidate_count === expected.candidateCount &&
    current.reexport_count === expected.reexportCount
  );
}

function materializationSpoolBatchReceiptFromRow(
  row: CodeGraphMaterializationSpoolBatchReceiptRow,
): CodeGraphMaterializationSpoolBatchReceipt {
  return {
    batchId: row.batch_id,
    batchIndex: row.batch_index,
    candidateCount: row.candidate_count,
    edgeCount: row.edge_count,
    factBytes: row.fact_bytes,
    lookupCount: row.lookup_count,
    referenceCount: row.reference_count,
    reexportCount: row.reexport_count,
    rowCount: row.row_count,
    sourceBytes: row.source_bytes,
    symbolCount: row.symbol_count,
    termCount: row.term_count,
  };
}

function validateCodeGraphMaterializationSpoolBatchReceipt(receipt: CodeGraphMaterializationSpoolBatchReceipt): void {
  if (!/^[0-9a-f]{64}$/u.test(receipt.batchId)) {
    throw new Error('Code graph materialization spool batch receipt is invalid.');
  }
  for (const [value, field] of [
    [receipt.batchIndex, 'batch index'],
    [receipt.candidateCount, 'candidate count'],
    [receipt.edgeCount, 'edge count'],
    [receipt.factBytes, 'fact bytes'],
    [receipt.lookupCount, 'lookup count'],
    [receipt.referenceCount, 'reference count'],
    [receipt.reexportCount, 'reexport count'],
    [receipt.sourceBytes, 'source bytes'],
    [receipt.rowCount, 'row count'],
    [receipt.symbolCount, 'symbol count'],
    [receipt.termCount, 'term count'],
  ] as const) {
    validateNonNegativeSafeInteger(value, field);
  }
}

function validateNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Code graph materialization spool ${field} is invalid.`);
  }
}

function validatePositiveSurfaceCount(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > CODE_GRAPH_MATERIALIZATION_SORT_SURFACES_MAXIMUM) {
    throw new Error('Code graph materialization spool expected surface count is invalid.');
  }
}

function validateCodeGraphMaterializationSpoolHeader(header: CodeGraphMaterializationSpoolHeader): void {
  if (
    !/^[0-9a-f]{64}$/u.test(header.checkoutId) ||
    !/^[0-9a-f]{64}$/u.test(header.repositoryId) ||
    !PERSISTENT_SNAPSHOT_ID.test(header.snapshotId) ||
    !/^(?:cgc_[0-9a-f]{40}|cgsn_[0-9a-f]{40}(?:-direct|-full-[0-9a-f]{16})?)$/u.test(header.graphContentId) ||
    header.extractorSet.length === 0 ||
    header.extractorSet.length > 4_096 ||
    Effect.pipe(header.extractorSet, EffectString.includes('\0'))
  ) {
    throw new Error('Code graph materialization spool header is invalid.');
  }
}
