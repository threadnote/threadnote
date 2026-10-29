import {Array as EffectArray} from 'effect';
import type {Database} from 'bun:sqlite';
import type {CodeGraphDirectPersistentCapacityBoundary} from '../../disk/capacity.js';
import {saturatingCapacityAdd} from '../../disk/capacity.js';
import {codeGraphSqliteAll} from '../../sqlite_statement.js';
import {readCodeGraphMaterializationSpoolSurfaceCapacities} from './surfaces.js';

export interface CodeGraphSpoolSortSurfaceLoad {
  readonly bytes: number;
  /** Raw term bytes bound the additional DISTINCT term dictionary for symbol_terms. */
  readonly lexicalTermBytesUpperBound?: number;
  readonly rows: number;
}

/** Sorting commits one surface at a time, so only the largest pending surface is live. */
export function codeGraphSpoolSortCapacityBoundary(
  loads: readonly CodeGraphSpoolSortSurfaceLoad[],
): CodeGraphDirectPersistentCapacityBoundary {
  return {
    finalFactBytes: EffectArray.reduce(loads, 0, (largest, load) => Math.max(largest, load.bytes)),
    mainSortPayloadBytes: EffectArray.reduce(loads, 0, (largest, load) =>
      Math.max(largest, saturatingCapacityAdd(load.bytes, load.lexicalTermBytesUpperBound ?? 0)),
    ),
    operation: 'sort persistent code graph materialization spool',
    rowCount: EffectArray.reduce(loads, 0, (largest, load) => Math.max(largest, load.rows)),
    transientFilesystem: 'temporary',
  };
}

/** Read the append-time counters for the raw surfaces that have not been sorted yet. */
export function observeCodeGraphSpoolSortCapacity(database: Database): CodeGraphDirectPersistentCapacityBoundary {
  const pending = new Set(
    EffectArray.map(
      codeGraphSqliteAll<{readonly name: string}>(
        database,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'materialization_raw_%'",
      ),
      row => row.name,
    ),
  );
  const loads = EffectArray.flatMap(readCodeGraphMaterializationSpoolSurfaceCapacities(database), surface =>
    pending.has(`materialization_raw_${surface.name}`)
      ? [{bytes: surface.bytes, lexicalTermBytesUpperBound: surface.lexicalTermBytes, rows: surface.rows}]
      : [],
  );
  return codeGraphSpoolSortCapacityBoundary(loads);
}
