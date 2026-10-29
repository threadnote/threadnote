import {Array as EffectArray} from 'effect';
import type {Database} from 'bun:sqlite';
import type {CodeGraphMonikerV1} from '../../cross_repository/types.js';
import {
  codeGraphMaterializationEdgeRows,
  codeGraphMaterializationMonikerRows,
  codeGraphMaterializationReferenceRows,
  codeGraphMaterializationReexportRows,
  codeGraphMaterializationSymbolLookupRows,
  codeGraphMaterializationSymbolRows,
  codeGraphMaterializationSymbolTermRows,
  type CodeGraphMaterializationEdgeRow,
  type CodeGraphMaterializationMonikerRow,
  type CodeGraphMaterializationReferenceRow,
  type CodeGraphMaterializationSymbolLookupRow,
  type CodeGraphMaterializationSymbolRow,
  type CodeGraphMaterializationSymbolTermRow,
} from '../rows.js';
import type {CodeGraphReusableReexport} from '../../store/models.js';
import {codeGraphSqliteGet, codeGraphSqliteRun} from '../../sqlite_statement.js';
import type {CodeGraphEdge, CodeGraphReference, CodeGraphSymbol} from '../../types.js';
import {recordCodeGraphMaterializationSpoolSurfaceCapacity} from './surfaces.js';
import * as EffectRecord from 'effect/Record';

const SPOOL_INSERT_PARAMETER_MAXIMUM = 32_000;
const SPOOL_INSERT_ROW_MAXIMUM = 4_000;

export interface CodeGraphMaterializationSpoolFactBatch {
  readonly directEdges: readonly CodeGraphEdge[];
  readonly monikers: readonly CodeGraphMonikerV1[];
  readonly referenceEdges: ReadonlyMap<string, CodeGraphEdge>;
  readonly references: readonly CodeGraphReference[];
  readonly symbols: readonly CodeGraphSymbol[];
  readonly termsBySymbol: ReadonlyMap<CodeGraphSymbol, readonly (readonly [string, number])[]>;
}

export interface PreparedCodeGraphMaterializationSpoolFactBatch {
  readonly edges: readonly CodeGraphMaterializationEdgeRow[];
  readonly lookup: readonly CodeGraphMaterializationSymbolLookupRow[];
  readonly monikers: readonly CodeGraphMaterializationMonikerRow[];
  readonly references: readonly CodeGraphMaterializationReferenceRow[];
  readonly reexports: readonly CodeGraphReusableReexport[];
  readonly rowCount: number;
  readonly symbolTerms: readonly CodeGraphMaterializationSymbolTermRow[];
  readonly symbols: readonly CodeGraphMaterializationSymbolRow[];
}

export function prepareCodeGraphMaterializationSpoolFactBatch(
  batch: CodeGraphMaterializationSpoolFactBatch,
): PreparedCodeGraphMaterializationSpoolFactBatch {
  const prepared = {
    edges: codeGraphMaterializationEdgeRows(batch.directEdges),
    lookup: codeGraphMaterializationSymbolLookupRows(batch.symbols),
    monikers: codeGraphMaterializationMonikerRows(batch.monikers),
    references: codeGraphMaterializationReferenceRows(batch.references, batch.referenceEdges),
    reexports: codeGraphMaterializationReexportRows(batch.references),
    symbolTerms: codeGraphMaterializationSymbolTermRows(batch.symbols, batch.termsBySymbol),
    symbols: codeGraphMaterializationSymbolRows(batch.symbols),
  };
  return {
    ...prepared,
    rowCount: EffectArray.reduce(EffectRecord.values(prepared), 0, (total, rows) => total + rows.length),
  };
}

export function appendCodeGraphMaterializationSpoolFactBatch(
  database: Database,
  batch: PreparedCodeGraphMaterializationSpoolFactBatch,
): void {
  insertRows(database, 'symbols', 16, batch.symbols, row => [
    row.id,
    row.contentHash,
    row.kind,
    row.name,
    row.qualifiedName,
    row.path,
    row.language,
    row.arity,
    row.lookupKeysJson,
    row.resolutionDomain,
    row.resolutionScopeId,
    row.packageName,
    row.exported,
    row.signature,
    row.documentation,
    row.spanJson,
  ]);
  insertRows(database, 'lookup', 7, batch.lookup, row => [
    row.lookupKey,
    row.symbolId,
    row.resolutionDomain,
    row.exported,
    row.provenance,
    row.evidenceEdgeId ?? null,
    row.evidencePath,
  ]);
  insertRows(database, 'edges', 10, batch.edges, row => [
    row.id,
    row.sourceId,
    row.sourceName,
    row.relation,
    row.targetId,
    row.targetName,
    row.provenance,
    row.confidence,
    row.evidencePath,
    row.evidenceSpanJson,
  ]);
  insertRows(database, 'references', 15, batch.references, row => [
    row.edgeId,
    row.resolutionDomain,
    row.exportedOnly,
    row.aliasLookupKeysJson,
    row.lookupTiersJson,
    row.candidateCount,
    row.candidatePayloadBytes,
    row.sourceId,
    row.sourceName,
    row.relation,
    row.targetName,
    row.provenance,
    row.confidence,
    row.evidencePath,
    row.evidenceSpanJson,
  ]);
  insertRows(database, 'reexports', 4, batch.reexports, row => [
    row.sourcePath,
    row.localName,
    row.targetPath,
    row.importedName,
  ]);
  insertRows(database, 'monikers', 16, batch.monikers, row => [
    row.id,
    row.version,
    row.scheme,
    row.role,
    row.kind,
    row.resolutionDomain,
    row.identity,
    row.packageName,
    row.packageVersion,
    row.importPath,
    row.qualifiedName,
    row.componentId,
    row.symbolId,
    row.dependencyKind,
    row.evidencePath,
    row.evidenceSpanJson,
  ]);
  insertRows(database, 'symbol_terms', 3, batch.symbolTerms, row => [row.term, row.symbolId, row.weight]);
}

function insertRows<Row>(
  database: Database,
  surface: string,
  columnCount: number,
  rows: readonly Row[],
  parameters: (row: Row) => readonly (number | string | null)[],
): void {
  if (rows.length === 0) return;
  const previous = codeGraphSqliteGet<{readonly rowid: bigint | number}>(
    database,
    `SELECT COALESCE(MAX(rowid), 0) AS rowid FROM materialization_raw_${surface}`,
  );
  const afterRowid = Number(previous?.rowid ?? 0);
  if (!Number.isSafeInteger(afterRowid) || afterRowid < 0) {
    throw new Error('Code graph materialization spool surface rowid is invalid.');
  }
  const pageRows = Math.min(SPOOL_INSERT_ROW_MAXIMUM, Math.floor(SPOOL_INSERT_PARAMETER_MAXIMUM / columnCount));
  for (let offset = 0; offset < rows.length; offset += pageRows) {
    const page = rows.slice(offset, offset + pageRows);
    const placeholders = `(${EffectArray.join(
      Array.from({length: columnCount}, () => '?'),
      ', ',
    )})`;
    codeGraphSqliteRun(
      database,
      `INSERT INTO materialization_raw_${surface} VALUES ${EffectArray.join(
        EffectArray.map(page, () => placeholders),
        ', ',
      )}`,
      ...EffectArray.flatMap(page, row => [...parameters(row)]),
    );
  }
  recordCodeGraphMaterializationSpoolSurfaceCapacity(database, surface, afterRowid, rows.length);
}
