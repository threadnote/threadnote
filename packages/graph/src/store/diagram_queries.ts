import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {type CodeGraphRelation} from '../types.js';
import {configureConnection} from './session.js';
import {
  codeGraphDiagramAdjacentCandidatesStatement,
  codeGraphDiagramAdjacentPageStatement,
  codeGraphDiagramExactSubjectPageStatement,
  effectiveSnapshotParameters,
  effectiveSymbolsCte,
  selectBaseSnapshotId,
} from './query/core.js';
import {boundedPageLimit} from './utilities.js';
import {type EdgeRow, type SymbolRow} from './internal_models.js';
import {edgeFromRow, symbolFromRow} from './rows.js';

const selectDiagramAdjacentPage = Effect.fn('codeGraph.selectDiagramAdjacentPage')(function* (
  snapshotId: string,
  nodeId: string,
  direction: 'incoming' | 'outgoing',
  relations: readonly CodeGraphRelation[],
  afterId: string,
  limit: number,
) {
  if (!relations.length) return {edges: []};
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const statement = codeGraphDiagramAdjacentPageStatement(
    snapshotId,
    baseSnapshotId,
    nodeId,
    direction,
    relations,
    afterId,
    boundedPageLimit(limit),
  );
  type PageRow = {readonly cursor_id: string} & (EdgeRow | {readonly id: null});
  const rows = yield* sql.unsafe<PageRow>(statement.text, statement.parameters);
  const last = rows.at(-1);
  return {
    edges: EffectArray.flatMap(rows, row => (row.id === null ? [] : [edgeFromRow(row)])),
    ...(last && rows.length === boundedPageLimit(limit) ? {nextCursor: last.cursor_id} : {}),
  };
});

const selectDiagramAdjacentCandidates = Effect.fn('codeGraph.selectDiagramAdjacentCandidates')(function* (
  snapshotId: string,
  nodeIds: readonly string[],
  direction: 'incoming' | 'outgoing',
  relations: readonly CodeGraphRelation[],
) {
  if (!nodeIds.length || !relations.length) return [];
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  const {text, parameters} = codeGraphDiagramAdjacentCandidatesStatement(
    snapshotId,
    baseSnapshotId,
    nodeIds,
    direction,
    relations,
  );
  return EffectArray.map(yield* sql.unsafe<{readonly id: string}>(text, parameters), ({id}) => id);
});

const selectDiagramSubjectPage = Effect.fn('codeGraph.selectDiagramSubjectPage')(function* (
  snapshotId: string,
  terms: readonly string[],
  afterId: string,
  limit: number,
  match: 'exact' | 'fuzzy',
  packageName?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* configureConnection(sql);
  const baseSnapshotId = yield* selectBaseSnapshotId(sql, snapshotId);
  if (match === 'exact') {
    const statement = codeGraphDiagramExactSubjectPageStatement(
      snapshotId,
      baseSnapshotId,
      terms,
      afterId,
      boundedPageLimit(limit),
      packageName,
    );
    type PageRow = {readonly cursor_id: string} & (SymbolRow | {readonly id: null});
    const rows = yield* sql.unsafe<PageRow>(statement.text, statement.parameters);
    const last = rows.at(-1);
    return {
      symbols: EffectArray.flatMap(rows, row => (row.id === null ? [] : [symbolFromRow(row)])),
      ...(last && rows.length === boundedPageLimit(limit) ? {nextCursor: last.cursor_id} : {}),
    };
  }
  const rows = yield* sql.unsafe<SymbolRow>(
    `${effectiveSymbolsCte()}
     SELECT * FROM effective_symbols AS symbol
     WHERE symbol.id > ? AND (? IS NULL OR symbol.package_name = ?)
       AND EXISTS (
         SELECT 1 FROM json_each(?) AS term
         WHERE symbol.id = term.value
           OR symbol.name = term.value
           OR symbol.qualified_name = term.value
           OR symbol.path = term.value
           OR instr(lower(symbol.name), substr(term.value, 1,
              CASE WHEN length(term.value) < 5 THEN length(term.value) ELSE 5 END)) > 0
           OR instr(lower(symbol.qualified_name), term.value) > 0
           OR instr(lower(symbol.path), term.value) > 0
           OR lower(symbol.package_name) = term.value
       )
     ORDER BY symbol.id
     LIMIT ?`,
    [
      ...effectiveSnapshotParameters(snapshotId, baseSnapshotId),
      afterId,
      packageName ?? null,
      packageName ?? null,
      JSON.stringify(terms),
      boundedPageLimit(limit),
    ],
  );
  const last = rows.at(-1);
  return {
    symbols: EffectArray.map(rows, symbolFromRow),
    ...(last && rows.length === boundedPageLimit(limit) ? {nextCursor: last.id} : {}),
  };
});

export {selectDiagramAdjacentCandidates, selectDiagramAdjacentPage, selectDiagramSubjectPage};
