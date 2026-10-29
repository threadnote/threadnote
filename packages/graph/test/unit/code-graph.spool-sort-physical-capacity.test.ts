import {mkdtempSync, rmSync, statSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import {codeGraphPersistentCapacityDemand} from '@threadnote/graph/disk/capacity';
import {configureCodeGraphMaterializationSpoolDatabase} from '@threadnote/graph/materialization/spool';
import {observeCodeGraphSpoolSortCapacity} from '@threadnote/graph/materialization/spool/capacity';
import {
  CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES,
  initializeCodeGraphMaterializationSpoolSurfaces,
  recordCodeGraphMaterializationSpoolSurfaceCapacity,
  sortCodeGraphMaterializationSpoolSurface,
} from '@threadnote/graph/materialization/spool/surfaces';
import {codeGraphSqliteGet} from '@threadnote/graph/sqlite_statement';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('code graph spool sort physical capacity', () => {
  for (const fixture of [
    {name: 'unique long terms', symbolBytes: 16, termBytes: 120},
    {name: 'long symbol IDs', symbolBytes: 240, termBytes: 12},
  ]) {
    it(`covers ordered SQLite pages and the rollback journal for ${fixture.name}`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'threadnote-spool-sort-capacity-'));
      const path = join(directory, 'spool.sqlite');
      const database = new Database(path, {create: true, strict: true});
      try {
        configureCodeGraphMaterializationSpoolDatabase(database);
        initializeCodeGraphMaterializationSpoolSurfaces(database);
        const insert = database.prepare(
          'INSERT INTO materialization_raw_symbol_terms (term, symbol_id, weight) VALUES (?, ?, ?)',
        );
        database.transaction(() => {
          for (let index = 0; index < 10_000; index += 1) {
            insert.run(
              `t${Effect.pipe(String(index), EffectString.padStart(fixture.termBytes - 1, '0'))}`,
              `s${Effect.pipe(String(10_000 - index), EffectString.padStart(fixture.symbolBytes - 1, '0'))}`,
              1.0,
            );
          }
          recordCodeGraphMaterializationSpoolSurfaceCapacity(database, 'symbol_terms', 0, 10_000);
        })();
        insert.finalize();

        const boundary = observeCodeGraphSpoolSortCapacity(database);
        const demand = codeGraphPersistentCapacityDemand({
          boundary,
          lexicalFormatVersion: 1,
          pageSize: 8192,
          walAutoCheckpointPages: 1_000,
        });
        expect(demand.state).toBe('measured');
        if (demand.state !== 'measured') return;

        let orderedBytes = 0;
        let journalBytes = 0;
        database.transaction(() => {
          sortCodeGraphMaterializationSpoolSurface(database, CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.at(-1)!);
          orderedBytes =
            codeGraphSqliteGet<{readonly bytes: number}>(
              database,
              `SELECT SUM(pgsize) AS bytes FROM dbstat
               WHERE name IN ('materialization_ordered_terms', 'materialization_ordered_symbol_terms')
                 AND aggregate = TRUE`,
            )?.bytes ?? 0;
          journalBytes = statSync(`${path}-journal`).size;
        })();

        expect(orderedBytes).toBeGreaterThan(boundary.finalFactBytes);
        expect(demand.mainHighWaterBytes).toBeGreaterThanOrEqual(orderedBytes);
        expect(demand.recoveryFloorBytes).toBeGreaterThanOrEqual(journalBytes);
      } finally {
        database.close(true);
        rmSync(directory, {force: true, recursive: true});
      }
    });
  }
});
