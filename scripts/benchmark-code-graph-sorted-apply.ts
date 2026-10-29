import {Array as EffectArray} from 'effect';
import {Database} from 'bun:sqlite';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

// Focused admission screen for the largest materialized lookup surface. It
// compares today's locally sorted multirow inserts with an unindexed durable
// spool, one global external sort, and bounded rowid-ordered final apply. This
// does not establish an end-to-end product claim; exact output and storage
// evidence decide whether the design is worth integrating and governing.
const [outputDirectory, rowCountText = '652441', symbolCountText = '111794'] = Bun.argv.slice(2);
if (!outputDirectory) {
  throw new Error('usage: bun scripts/benchmark-code-graph-sorted-apply.ts <empty-output-directory> [rows] [symbols]');
}

const rowCount = positiveInteger(rowCountText, 'row count');
const symbolCount = positiveInteger(symbolCountText, 'symbol count');
const logicalBatchRows = 4_000;
const transactionBatches = 4;
const applyPageRows = 50_000;
const directPath = `${outputDirectory}/direct.sqlite`;
const spoolPath = `${outputDirectory}/spool.sqlite`;
const sortedPath = `${outputDirectory}/sorted-final.sqlite`;
const resultPath = `${outputDirectory}/result.json`;

for (const path of [directPath, spoolPath, sortedPath, resultPath]) {
  if (await Bun.file(path).exists()) throw new Error(`refusing to overwrite ${path}`);
}

const inputStep = coprimeStep(rowCount);
const lookupVariants = Math.max(1, Math.ceil(rowCount / symbolCount));
const rows = function* () {
  for (let inputIndex = 0; inputIndex < rowCount; inputIndex += 1) {
    const canonical = (inputIndex * inputStep) % rowCount;
    const symbolOrdinal = canonical % symbolCount;
    const variant = Math.floor(canonical / symbolCount);
    const lookupOrdinal = (symbolOrdinal * 2_654_435_761 + variant * 40_503) % (symbolCount * 2);
    yield {
      exported: canonical % 7 === 0 ? 1 : 0,
      lookupKey: `lookup-${Effect.pipe(String(variant), EffectString.padStart(2, '0'))}-${Effect.pipe(String(lookupOrdinal), EffectString.padStart(9, '0'))}`,
      resolutionDomain: `domain-${canonical % 97}`,
      symbolId: `symbol-${Effect.pipe(String(symbolOrdinal), EffectString.padStart(8, '0'))}`,
    };
  }
};

const direct = new Database(directPath, {strict: true});
configure(direct, 'wal');
createFinalTable(direct);
const directStartedAt = performance.now();
let directBatch: LookupRow[] = [];
let directPending: LookupRow[][] = [];
for (const row of rows()) {
  directBatch.push(row);
  if (directBatch.length < logicalBatchRows) continue;
  directPending.push(sortRows(directBatch));
  directBatch = [];
  if (directPending.length >= transactionBatches) {
    insertDirectTransaction(direct, directPending);
    directPending = [];
  }
}
if (directBatch.length > 0) directPending.push(sortRows(directBatch));
if (directPending.length > 0) insertDirectTransaction(direct, directPending);
const directMilliseconds = performance.now() - directStartedAt;
const directRows = countRows(direct, 'snapshot_symbol_lookup');
const directDigest = digestRows(direct);
const directHighWater = await sqliteStorage(directPath);
direct.exec('PRAGMA wal_checkpoint(TRUNCATE)');
direct.close();

const spool = new Database(spoolPath, {strict: true});
configure(spool, 'delete');
spool.exec(`
  CREATE TABLE raw_lookup (
    lookup_key TEXT NOT NULL,
    symbol_id TEXT NOT NULL,
    resolution_domain TEXT NOT NULL,
    exported INTEGER NOT NULL,
    provenance TEXT NOT NULL,
    evidence_edge_id TEXT,
    evidence_path TEXT
  )
`);
const appendStartedAt = performance.now();
let appendBatch: LookupRow[] = [];
let appendPending: LookupRow[][] = [];
for (const row of rows()) {
  appendBatch.push(row);
  if (appendBatch.length < logicalBatchRows) continue;
  appendPending.push(appendBatch);
  appendBatch = [];
  if (appendPending.length >= transactionBatches) {
    insertSpoolTransaction(spool, appendPending);
    appendPending = [];
  }
}
if (appendBatch.length > 0) appendPending.push(appendBatch);
if (appendPending.length > 0) insertSpoolTransaction(spool, appendPending);
const appendMilliseconds = performance.now() - appendStartedAt;
const spoolAfterAppend = await sqliteStorage(spoolPath);

const sortStartedAt = performance.now();
spool.exec(`
  CREATE TABLE ordered_lookup AS
  SELECT lookup_key, symbol_id, resolution_domain, exported, provenance, evidence_edge_id, evidence_path
  FROM raw_lookup
  ORDER BY lookup_key, symbol_id
`);
const sortMilliseconds = performance.now() - sortStartedAt;
const spoolRows = countRows(spool, 'ordered_lookup');
const spoolAfterSort = await sqliteStorage(spoolPath);
spool.exec('PRAGMA wal_checkpoint(TRUNCATE)');
spool.close();

const sorted = new Database(sortedPath, {strict: true});
configure(sorted, 'wal');
createFinalTable(sorted);
sorted.exec(`ATTACH DATABASE '${sqlString(spoolPath)}' AS spool`);
const applyStartedAt = performance.now();
let cursor = 0;
const applyPage = sorted.transaction((afterRowid: number) => {
  sorted
    .prepare(
      `INSERT INTO snapshot_symbol_lookup (
         snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
         provenance, evidence_edge_id, evidence_path
       )
       SELECT 'snapshot', lookup_key, symbol_id, resolution_domain, exported,
         provenance, evidence_edge_id, evidence_path
       FROM spool.ordered_lookup
       WHERE rowid > ?
       ORDER BY rowid
       LIMIT ${applyPageRows}`,
    )
    .run(afterRowid);
});
while (cursor < rowCount) {
  applyPage(cursor);
  cursor = Math.min(rowCount, cursor + applyPageRows);
}
const applyMilliseconds = performance.now() - applyStartedAt;
const sortedRows = countRows(sorted, 'snapshot_symbol_lookup');
const sortedDigest = digestRows(sorted);
const sortedHighWater = await sqliteStorage(sortedPath);
sorted.exec('DETACH DATABASE spool');
sorted.exec('PRAGMA wal_checkpoint(TRUNCATE)');
sorted.close();

if (directRows !== rowCount || spoolRows !== rowCount || sortedRows !== rowCount) {
  throw new Error(`row-count mismatch: direct=${directRows}, spool=${spoolRows}, sorted=${sortedRows}`);
}
if (directDigest !== sortedDigest) throw new Error('direct and globally sorted outputs differ');

const output = {
  version: 1,
  workload: {applyPageRows, inputStep, logicalBatchRows, lookupVariants, rowCount, symbolCount, transactionBatches},
  exactOutputParity: true,
  outputSha256: directDigest,
  direct: {
    highWater: directHighWater,
    milliseconds: directMilliseconds,
    rows: directRows,
    storage: await sqliteStorage(directPath),
  },
  sorted: {
    appendMilliseconds,
    applyMilliseconds,
    milliseconds: appendMilliseconds + sortMilliseconds + applyMilliseconds,
    rows: sortedRows,
    sortMilliseconds,
    highWater: {final: sortedHighWater, spoolAfterAppend, spoolAfterSort},
    storage: {
      final: await sqliteStorage(sortedPath),
      spool: await sqliteStorage(spoolPath),
    },
  },
};
await Bun.write(resultPath, `${JSON.stringify(output, null, 2)}\n`);
await Bun.write(Bun.stdout, `${JSON.stringify(output)}\n`);

interface LookupRow {
  readonly exported: number;
  readonly lookupKey: string;
  readonly resolutionDomain: string;
  readonly symbolId: string;
}

function configure(database: Database, journalMode: 'delete' | 'wal'): void {
  database.exec('PRAGMA page_size = 8192');
  database.exec(`PRAGMA journal_mode = ${journalMode}`);
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA cache_size = -32768');
  database.exec('PRAGMA temp_store = FILE');
}

function createFinalTable(database: Database): void {
  database.exec(`
    CREATE TABLE snapshot_symbol_lookup (
      snapshot_id TEXT NOT NULL,
      lookup_key TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      resolution_domain TEXT NOT NULL,
      exported INTEGER NOT NULL CHECK (exported IN (0, 1)),
      provenance TEXT NOT NULL CHECK (provenance IN ('alias', 'symbol')),
      evidence_edge_id TEXT,
      evidence_path TEXT,
      PRIMARY KEY (snapshot_id, lookup_key, symbol_id)
    ) WITHOUT ROWID
  `);
}

function insertDirectTransaction(database: Database, batches: readonly (readonly LookupRow[])[]): void {
  database.transaction(() => {
    for (const batch of batches) insertRows(database, 'snapshot_symbol_lookup', batch, true);
  })();
}

function insertSpoolTransaction(database: Database, batches: readonly (readonly LookupRow[])[]): void {
  database.transaction(() => {
    for (const batch of batches) insertRows(database, 'raw_lookup', batch, false);
  })();
}

function insertRows(database: Database, table: string, batch: readonly LookupRow[], final: boolean): void {
  const columns = final
    ? 'snapshot_id, lookup_key, symbol_id, resolution_domain, exported, provenance, evidence_edge_id, evidence_path'
    : 'lookup_key, symbol_id, resolution_domain, exported, provenance, evidence_edge_id, evidence_path';
  const values = EffectArray.join(
    EffectArray.map(batch, () => (final ? '(?, ?, ?, ?, ?, ?, ?, ?)' : '(?, ?, ?, ?, ?, ?, ?)')),
    ', ',
  );
  const parameters = EffectArray.flatMap(batch, row =>
    final
      ? ['snapshot', row.lookupKey, row.symbolId, row.resolutionDomain, row.exported, 'symbol', null, null]
      : [row.lookupKey, row.symbolId, row.resolutionDomain, row.exported, 'symbol', null, null],
  );
  database.prepare(`INSERT INTO ${table} (${columns}) VALUES ${values}`).run(...parameters);
}

function sortRows(rows: readonly LookupRow[]): LookupRow[] {
  return [...rows].sort(
    (left, right) => compareText(left.lookupKey, right.lookupKey) || compareText(left.symbolId, right.symbolId),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function countRows(database: Database, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  if (typeof row !== 'object' || row === null || !('count' in row)) {
    throw new Error(`COUNT query for ${table} returned an invalid row.`);
  }
  return Number(row.count);
}

function isSqlRecord(value: unknown): value is Readonly<Record<string, string | number | null>> {
  return (
    isRecord(value) &&
    EffectArray.every(
      EffectRecord.values(value),
      entry => entry === null || typeof entry === 'string' || typeof entry === 'number',
    )
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !EffectArray.isArray(value);
}

function digestRows(database: Database): string {
  const hash = new Bun.CryptoHasher('sha256');
  const rows = database
    .prepare(
      `SELECT snapshot_id, lookup_key, symbol_id, resolution_domain, exported,
         provenance, evidence_edge_id, evidence_path
       FROM snapshot_symbol_lookup
       ORDER BY snapshot_id, lookup_key, symbol_id`,
    )
    .iterate();
  for (const row of rows) {
    if (!isSqlRecord(row)) throw new Error('Lexical lookup query returned an invalid row.');
    for (const value of EffectRecord.values(row)) hash.update(`${value === null ? '\\N' : value}\0`);
    hash.update('\n');
  }
  return hash.digest('hex');
}

async function sqliteStorage(path: string): Promise<{databaseBytes: number; totalBytes: number}> {
  const sizes = await Promise.all(
    EffectArray.map([path, `${path}-wal`, `${path}-shm`], async file =>
      (await Bun.file(file).exists()) ? Bun.file(file).size : 0,
    ),
  );
  return {databaseBytes: sizes[0], totalBytes: EffectArray.reduce(sizes, 0, (total, size) => total + size)};
}

function positiveInteger(value: string, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${description} must be a positive integer`);
  return parsed;
}

function coprimeStep(modulus: number): number {
  let candidate = Math.max(1, Math.floor(modulus / 2) | 1);
  while (greatestCommonDivisor(candidate, modulus) !== 1) candidate += 2;
  return candidate;
}

function greatestCommonDivisor(left: number, right: number): number {
  while (right !== 0) [left, right] = [right, left % right];
  return left;
}

function sqlString(value: string): string {
  return Effect.pipe(value, EffectString.replaceAll("'", "''"));
}
