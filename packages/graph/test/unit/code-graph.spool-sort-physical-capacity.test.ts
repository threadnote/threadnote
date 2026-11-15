import {discoveryTerms} from '@threadnote/graph/languages/body_discovery';
import fc from 'fast-check';
import {Array as EffectArray} from 'effect';
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

describe('code graph spool sort physical capacity', () => {
  for (const fixture of [
    {name: 'unique long terms', symbolBytes: 16, termBytes: 120, factored: false},
    {name: 'long symbol IDs', symbolBytes: 240, termBytes: 12, factored: false},
    {name: 'resumed V2 dictionary', symbolBytes: 16, termBytes: 120, factored: true},
    {name: 'resumed V2 4KiB metadata dictionary', symbolBytes: 16, termBytes: 4096, factored: true},
  ]) {
    it(`covers ordered SQLite pages and the rollback journal for ${fixture.name}`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'threadnote-spool-sort-capacity-'));
      const path = join(directory, 'spool.sqlite');
      const database = new Database(path, {create: true, strict: true});
      try {
        configureCodeGraphMaterializationSpoolDatabase(database);
        initializeCodeGraphMaterializationSpoolSurfaces(database);
        const count = fixture.termBytes > 256 ? 512 : 10_000;
        if (fixture.factored) {
          database.transaction(() => {
            for (let index = 0; index < count; index++) {
              const term = `t${EffectString.padStart(fixture.termBytes - 1, '0')(String(index))}`;
              expect(discoveryTerms(term)).toEqual([term]);
              database.query('INSERT INTO materialization_raw_lexical_owners VALUES(?,1,0,?,5)').run(term, index);
              if (fixture.termBytes <= 256)
                database.query('INSERT INTO materialization_raw_lexical_shared VALUES(?,0)').run(term);
            }
            recordCodeGraphMaterializationSpoolSurfaceCapacity(database, 'lexical_owners', 0, count);
            if (fixture.termBytes <= 256)
              recordCodeGraphMaterializationSpoolSurfaceCapacity(database, 'lexical_shared', 0, count);
            for (const surface of CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.slice(0, -1))
              sortCodeGraphMaterializationSpoolSurface(database, surface);
          })();
        } else {
          const insert = database.prepare(
            'INSERT INTO materialization_raw_symbol_terms(term,symbol_id,weight) VALUES(?,?,?)',
          );
          database.transaction(() => {
            for (let index = 0; index < 10_000; index++)
              insert.run(
                `t${EffectString.padStart(fixture.termBytes - 1, '0')(String(index))}`,
                `s${EffectString.padStart(fixture.symbolBytes - 1, '0')(String(10_000 - index))}`,
                1,
              );
            recordCodeGraphMaterializationSpoolSurfaceCapacity(database, 'symbol_terms', 0, 10_000);
          })();
          insert.finalize();
        }

        const boundary = observeCodeGraphSpoolSortCapacity(database);
        if (fixture.factored) {
          expect(boundary.finalFactBytes).toBeGreaterThanOrEqual(count * fixture.termBytes);
          expect(boundary.mainSortPayloadBytes).toBeGreaterThanOrEqual(count * fixture.termBytes);
          expect(boundary.rowCount).toBeGreaterThanOrEqual(count);
        }
        const demand = codeGraphPersistentCapacityDemand({
          boundary,
          lexicalFormatVersion: fixture.factored ? 2 : 1,
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

        if (!fixture.factored) expect(orderedBytes).toBeGreaterThan(boundary.finalFactBytes);
        else {
          // Dictionary payload is independently known, independent of its
          // SQLite leaf/overflow page layout or capacity estimator internals.
          const payload = count * fixture.termBytes;
          expect(orderedBytes).toBeGreaterThanOrEqual(payload);
          expect(demand.transientHighWaterBytes).toBeGreaterThanOrEqual(payload);
        }
        expect(demand.mainHighWaterBytes).toBeGreaterThanOrEqual(orderedBytes);
        expect(demand.recoveryFloorBytes).toBeGreaterThanOrEqual(journalBytes);
      } finally {
        database.close(true);
        rmSync(directory, {force: true, recursive: true});
      }
    });
  }
});

it('retains exact dictionary demand across every factored interruption and releases it only after sort', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.integer({min: 0, max: 9999}), {minLength: 1, maxLength: 48}),
      fc.constantFrom(9, 10, 11),
      fc.constantFrom(300, 4096),
      (values, prefix, width) => {
        const database = new Database(':memory:');
        try {
          initializeCodeGraphMaterializationSpoolSurfaces(database);
          const owners = EffectArray.map(values, value => `m${EffectString.padStart(width - 1, '0')(String(value))}`);
          const shared = EffectArray.map(values, value => `shared${value}`);
          for (const [index, term] of owners.entries()) {
            expect(discoveryTerms(term)).toEqual([term]);
            database.query('INSERT INTO materialization_raw_lexical_owners VALUES(?,1,0,?,5)').run(term, index);
          }
          for (const term of shared)
            database.query('INSERT INTO materialization_raw_lexical_shared VALUES(?,0)').run(term);
          recordCodeGraphMaterializationSpoolSurfaceCapacity(database, 'lexical_owners', 0, owners.length);
          recordCodeGraphMaterializationSpoolSurfaceCapacity(database, 'lexical_shared', 0, shared.length);
          for (const surface of CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.slice(0, prefix))
            sortCodeGraphMaterializationSpoolSurface(database, surface);
          const bound = observeCodeGraphSpoolSortCapacity(database);
          const expectedBytes = EffectArray.reduce(
            [...owners, ...shared],
            0,
            (total, term) => total + Buffer.byteLength(term),
          );
          expect(bound.finalFactBytes).toBeGreaterThanOrEqual(expectedBytes);
          expect(bound.mainSortPayloadBytes).toBeGreaterThanOrEqual(expectedBytes);
          const demand = codeGraphPersistentCapacityDemand({
            boundary: bound,
            lexicalFormatVersion: 2,
            pageSize: 8192,
            walAutoCheckpointPages: 1000,
          });
          expect(demand.state).toBe('measured');
          if (demand.state !== 'measured') return;
          expect(demand.transientHighWaterBytes).toBeGreaterThanOrEqual(expectedBytes);
          expect(demand.mainHighWaterBytes).toBeGreaterThanOrEqual(expectedBytes);
          expect(bound.rowCount).toBeGreaterThanOrEqual(owners.length + shared.length);
          expect(observeCodeGraphSpoolSortCapacity(database)).toEqual(bound);
          for (const surface of CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.slice(prefix))
            sortCodeGraphMaterializationSpoolSurface(database, surface);
          const dictionary = database
            .query<{term: string}, []>('SELECT term FROM materialization_ordered_terms ORDER BY term')
            .all();
          expect(EffectArray.map(dictionary, row => row.term)).toEqual([...new Set([...owners, ...shared])].sort());
          expect(observeCodeGraphSpoolSortCapacity(database)).toMatchObject({
            finalFactBytes: 0,
            mainSortPayloadBytes: 0,
            rowCount: 0,
          });
        } finally {
          database.close();
        }
      },
    ),
    {numRuns: 35},
  );
});

it('keeps a single-source legacy dictionary unique while retaining every owner posting', () => {
  const database = new Database(':memory:');
  try {
    database.exec(
      "CREATE TABLE materialization_raw_symbol_terms(term TEXT,symbol_id TEXT,weight REAL); INSERT INTO materialization_raw_symbol_terms VALUES('shared','owner-a',3),('shared','owner-b',3),('unique','owner-b',5)",
    );
    sortCodeGraphMaterializationSpoolSurface(database, CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.at(-1)!);
    expect(database.query('SELECT term FROM materialization_ordered_terms ORDER BY term').all()).toEqual([
      {term: 'shared'},
      {term: 'unique'},
    ]);
    expect(database.query('SELECT COUNT(*) AS count FROM materialization_ordered_symbol_terms').get()).toEqual({
      count: 3,
    });
  } finally {
    database.close();
  }
});
