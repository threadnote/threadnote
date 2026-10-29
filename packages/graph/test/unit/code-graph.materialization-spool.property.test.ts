import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS,
  beginCodeGraphMaterializationSpoolSort,
  codeGraphMaterializationApplyPages,
  codeGraphMaterializationSpoolPath,
  commitCodeGraphMaterializationSpoolBatch,
  commitCodeGraphMaterializationSpoolSortedSurface,
  configureCodeGraphMaterializationSpoolDatabase,
  finishCodeGraphMaterializationSpoolSort,
  initializeCodeGraphMaterializationSpoolDatabase,
  readCodeGraphMaterializationSpoolState,
  sealCodeGraphMaterializationSpool,
  sortCodeGraphMaterializationSpoolSurfaces,
} from '@threadnote/graph/materialization/spool';
import {CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES} from '@threadnote/graph/materialization/spool/surfaces';
import {codeGraphPersistentCapacityDemand, evaluateCodeGraphDiskCapacity} from '@threadnote/graph/disk/capacity';
import {
  codeGraphSpoolSortCapacityBoundary,
  observeCodeGraphSpoolSortCapacity,
} from '@threadnote/graph/materialization/spool/capacity';
import {appendCodeGraphMaterializationSpoolFactBatch} from '@threadnote/graph/materialization/spool/writer';
import {codeGraphSqliteAll, codeGraphSqliteGet, codeGraphSqliteRun} from '@threadnote/graph/sqlite_statement';
import type {CodeGraphLayout} from '@threadnote/graph/layout';
import type {Path as EffectPath} from 'effect/Path';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('code graph materialization spool', () => {
  fcProp(
    it,
    'bounds sequential sorting by the largest surface regardless of order',
    {
      loads: FC.array(
        FC.record({
          bytes: FC.integer({max: 1_000_000, min: 0}),
          lexicalTermBytesUpperBound: FC.integer({max: 1_000_000, min: 0}),
          rows: FC.integer({max: 10_000, min: 0}),
        }),
        {maxLength: CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length},
      ),
    },
    ({loads}) => {
      const boundary = codeGraphSpoolSortCapacityBoundary(loads);
      expect(boundary.finalFactBytes).toBe(
        EffectArray.reduce(loads, 0, (maximum, load) => Math.max(maximum, load.bytes)),
      );
      expect(boundary.mainSortPayloadBytes).toBe(
        EffectArray.reduce(loads, 0, (maximum, load) =>
          Math.max(maximum, load.bytes + load.lexicalTermBytesUpperBound),
        ),
      );
      expect(boundary.rowCount).toBe(EffectArray.reduce(loads, 0, (maximum, load) => Math.max(maximum, load.rows)));
      expect(codeGraphSpoolSortCapacityBoundary([...loads].reverse())).toEqual(boundary);
      for (const load of loads) {
        expect(boundary.finalFactBytes).toBeGreaterThanOrEqual(load.bytes);
        expect(boundary.rowCount).toBeGreaterThanOrEqual(load.rows);
      }
    },
    {fastCheck: {numRuns: 100}},
  );

  it('persists exact pending surface capacity across append replay and spool resume', () => {
    const database = new Database(':memory:', {strict: true});
    const header = {
      checkoutId: Effect.pipe('a', EffectString.repeat(64)),
      extractorSet: 'extractor-v1',
      graphContentId: `cgc_${Effect.pipe('b', EffectString.repeat(40))}`,
      repositoryId: Effect.pipe('c', EffectString.repeat(64)),
      snapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}-direct`,
    };
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      initializeCodeGraphMaterializationSpoolDatabase(database, header);
      const firstBatch = {
        edges: [],
        lookup: [],
        monikers: [],
        references: [],
        reexports: [{importedName: 'x', localName: 'α', sourcePath: 'src/é.ts', targetPath: 'lib.ts'}],
        rowCount: 3,
        symbolTerms: [
          {symbolId: 'symbol-1', term: 'δ', weight: 1},
          {symbolId: 'symbol-2', term: 'δ', weight: 0.5},
        ],
        symbols: [],
      };
      const firstReceipt = spoolReceipt({reexportCount: 1, rowCount: 3, termCount: 2});
      expect(
        commitCodeGraphMaterializationSpoolBatch(database, firstReceipt, () =>
          appendCodeGraphMaterializationSpoolFactBatch(database, firstBatch),
        ),
      ).toBe('appended');
      expect(
        commitCodeGraphMaterializationSpoolBatch(database, firstReceipt, () => {
          throw new Error('exact replay writer must not run');
        }),
      ).toBe('resumed');
      const boundary = observeCodeGraphSpoolSortCapacity(database);
      expect(boundary).toEqual(directCodeGraphSpoolSortCapacity(database));
      expect(boundary).toEqual({
        finalFactBytes: 26,
        mainSortPayloadBytes: 30,
        operation: 'sort persistent code graph materialization spool',
        rowCount: 2,
        transientFilesystem: 'temporary',
      });
      expect(initializeCodeGraphMaterializationSpoolDatabase(database, header)).toBe('resumed');
      const secondReceipt = spoolReceipt({
        batchId: Effect.pipe('f', EffectString.repeat(64)),
        batchIndex: 1,
        reexportCount: 1,
        rowCount: 1,
      });
      expect(
        commitCodeGraphMaterializationSpoolBatch(database, secondReceipt, () =>
          appendCodeGraphMaterializationSpoolFactBatch(database, {
            edges: [],
            lookup: [],
            monikers: [],
            references: [],
            reexports: [
              {
                importedName: 'imported',
                localName: 'name',
                sourcePath: "src/x'); DROP TABLE materialization_raw_symbol_terms; --",
                targetPath: 'target',
              },
            ],
            rowCount: 1,
            symbolTerms: [],
            symbols: [],
          }),
        ),
      ).toBe('appended');
      const resumedBoundary = observeCodeGraphSpoolSortCapacity(database);
      expect(resumedBoundary).toEqual(directCodeGraphSpoolSortCapacity(database));
      expect(resumedBoundary.finalFactBytes).toBeGreaterThan(boundary.finalFactBytes);
      expect(
        codeGraphSqliteGet<{readonly count: number}>(
          database,
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'materialization_raw_symbol_terms'",
        ),
      ).toEqual({count: 1});
      sealCodeGraphMaterializationSpool(database, 2);
      sortCodeGraphMaterializationSpoolSurfaces(database);
      expect(observeCodeGraphSpoolSortCapacity(database)).toEqual({
        ...boundary,
        finalFactBytes: 0,
        mainSortPayloadBytes: 0,
        rowCount: 0,
      });
    } finally {
      database.close();
    }
  });

  it('admits a sequential sidecar sort when aggregate facts would falsely exceed available space', () => {
    const gib = 1024 ** 3;
    const loads = Array.from({length: 4}, () => ({bytes: 5 * gib, rows: 1_000_000}));
    const capacity = (finalFactBytes: number) =>
      evaluateCodeGraphDiskCapacity({
        demand: codeGraphPersistentCapacityDemand({
          boundary: {
            ...codeGraphSpoolSortCapacityBoundary(loads),
            finalFactBytes,
            mainSortPayloadBytes: finalFactBytes,
          },
          lexicalFormatVersion: 1,
          pageSize: 8192,
          walAutoCheckpointPages: 1000,
        }),
        durableAvailableBytes: 50 * gib,
        filesystemsShared: true,
        freelistBytes: 0,
        reservedDurableBytes: 0,
        reservedTemporaryBytes: 0,
        temporaryAvailableBytes: 50 * gib,
      });
    expect(capacity(codeGraphSpoolSortCapacityBoundary(loads).finalFactBytes).state).toBe('healthy');
    expect(capacity(EffectArray.reduce(loads, 0, (sum, load) => sum + load.bytes)).state).toBe('pressure');
  });

  fcProp(
    it,
    'releases successful and failed prepared statements before strong close',
    {values: FC.array(FC.integer(), {maxLength: 64})},
    ({values}) => {
      const database = new Database(':memory:', {strict: true});
      try {
        database.exec('CREATE TABLE statement_ownership (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');
        codeGraphSqliteRun(database, 'INSERT INTO statement_ownership (id, value) VALUES (?, ?)', -1, 0);
        for (const [id, value] of values.entries()) {
          codeGraphSqliteRun(database, 'INSERT INTO statement_ownership (id, value) VALUES (?, ?)', id, value);
        }
        expect(() =>
          codeGraphSqliteRun(database, 'INSERT INTO statement_ownership (id, value) VALUES (?, ?)', -1, 1),
        ).toThrow();
        expect(
          codeGraphSqliteAll<{readonly id: number; readonly value: number}>(
            database,
            'SELECT id, value FROM statement_ownership WHERE id >= 0 ORDER BY id',
          ),
        ).toEqual(EffectArray.map(values, (value, id) => ({id, value})));
        expect(
          codeGraphSqliteGet<{readonly count: number}>(database, 'SELECT COUNT(*) AS count FROM statement_ownership'),
        ).toEqual({count: values.length + 1});
      } finally {
        expect(() => database.close(true)).not.toThrow();
      }
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'covers every ordered row once with median-block bounded cursors',
    {
      pageRows: FC.integer({max: CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS, min: 1}),
      rowCount: FC.integer({max: 100_000, min: 0}),
    },
    ({pageRows, rowCount}) => {
      const pages = codeGraphMaterializationApplyPages(rowCount, pageRows);
      expect(EffectArray.reduce(pages, 0, (total, page) => total + page.rowCount)).toBe(rowCount);
      expect(EffectArray.every(pages, page => page.rowCount > 0 && page.rowCount <= pageRows)).toBe(true);
      expect(EffectArray.map(pages, page => page.afterRowid).sort((left, right) => left - right)).toEqual(
        Array.from({length: pages.length}, (_, index) => index * pageRows),
      );
      expect(new Set(EffectArray.map(pages, page => page.afterRowid)).size).toBe(pages.length);
      if (pages.length > 0) {
        expect(pages[0].afterRowid).toBe(Math.floor(pages.length / 2) * pageRows);
      }
    },
    {fastCheck: {numRuns: 100}},
  );

  it('uses the breadth-first median schedule retained by the storage screen', () => {
    expect(EffectArray.map(codeGraphMaterializationApplyPages(50, 10), page => page.afterRowid)).toEqual([
      20, 10, 40, 0, 30,
    ]);
  });

  it('uses a closed snapshot grammar for a repository-contained sibling path', () => {
    const layout = {repositoryRoot: '/threadnote/code-graph/repository'} satisfies Pick<
      CodeGraphLayout,
      'repositoryRoot'
    >;
    const path = {join: (...parts: readonly string[]) => EffectArray.join(parts, '/')} satisfies Pick<
      EffectPath,
      'join'
    >;
    expect(
      codeGraphMaterializationSpoolPath(path, layout, `cgsn_${Effect.pipe('a', EffectString.repeat(40))}-direct`),
    ).toBe(
      `/threadnote/code-graph/repository/materialization-spool-v2-cgsn_${Effect.pipe('a', EffectString.repeat(40))}-direct.sqlite`,
    );
    for (const invalid of [
      '',
      '../escape',
      `cgsn_${Effect.pipe('a', EffectString.repeat(39))}`,
      `cgsn_${Effect.pipe('a', EffectString.repeat(40))}-full-xyz`,
    ]) {
      expect(() => codeGraphMaterializationSpoolPath(path, layout, invalid)).toThrow(
        'Code graph materialization spool snapshot identity is invalid.',
      );
    }
  });

  it('fails closed for malformed row and page bounds', () => {
    for (const rowCount of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => codeGraphMaterializationApplyPages(rowCount)).toThrow(
        'Code graph materialization spool row count is invalid.',
      );
    }
    for (const pageRows of [-1, 0, 0.5, CODE_GRAPH_MATERIALIZATION_APPLY_PAGE_ROWS + 1]) {
      expect(() => codeGraphMaterializationApplyPages(1, pageRows)).toThrow(
        'Code graph materialization spool page bound is invalid.',
      );
    }
  });

  it('resumes only the exact immutable sidecar identity', () => {
    const database = new Database(':memory:', {strict: true});
    const header = {
      checkoutId: Effect.pipe('a', EffectString.repeat(64)),
      extractorSet: 'extractor-v1',
      graphContentId: `cgc_${Effect.pipe('b', EffectString.repeat(40))}`,
      repositoryId: Effect.pipe('c', EffectString.repeat(64)),
      snapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}-direct`,
    };
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      expect(initializeCodeGraphMaterializationSpoolDatabase(database, header)).toBe('created');
      expect(initializeCodeGraphMaterializationSpoolDatabase(database, header)).toBe('resumed');
      for (const [field, replacement] of [
        ['checkoutId', Effect.pipe('e', EffectString.repeat(64))],
        ['extractorSet', 'extractor-v2'],
        ['graphContentId', `cgc_${Effect.pipe('e', EffectString.repeat(40))}`],
        ['repositoryId', Effect.pipe('e', EffectString.repeat(64))],
        ['snapshotId', `cgsn_${Effect.pipe('e', EffectString.repeat(40))}-direct`],
      ] as const) {
        expect(() =>
          initializeCodeGraphMaterializationSpoolDatabase(database, {...header, [field]: replacement}),
        ).toThrow('Code graph materialization spool identity does not match the persistent build.');
      }
      database.exec('DROP TABLE materialization_raw_edges');
      expect(() => initializeCodeGraphMaterializationSpoolDatabase(database, header)).toThrow(
        'Code graph materialization spool fact surfaces are missing or corrupt.',
      );
    } finally {
      database.close();
    }
  });

  it('atomically sorts every raw fact surface and resumes the ready state', () => {
    const database = new Database(':memory:', {strict: true});
    const header = {
      checkoutId: Effect.pipe('a', EffectString.repeat(64)),
      extractorSet: 'extractor-v1',
      graphContentId: `cgc_${Effect.pipe('b', EffectString.repeat(40))}`,
      repositoryId: Effect.pipe('c', EffectString.repeat(64)),
      snapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}-direct`,
    };
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      initializeCodeGraphMaterializationSpoolDatabase(database, header);
      database.exec(`
        INSERT INTO materialization_raw_lookup (
          lookup_key, symbol_id, resolution_domain, exported, provenance, evidence_edge_id, evidence_path
        ) VALUES
          ('zeta', 'symbol-2', 'generic', 0, 'symbol', NULL, 'src/zeta.ts'),
          ('alpha', 'symbol-3', 'generic', 1, 'symbol', NULL, 'src/alpha.ts'),
          ('alpha', 'symbol-1', 'generic', 1, 'symbol', NULL, 'src/alpha.ts')
      `);
      sealCodeGraphMaterializationSpool(database, 0);
      sortCodeGraphMaterializationSpoolSurfaces(database);
      expect(readCodeGraphMaterializationSpoolState(database)).toEqual({
        appendedBatchCount: 0,
        expectedBatchCount: 0,
        expectedSurfaceCount: CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length,
        sortedSurfaceCount: CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES.length,
        stage: 'ready',
      });
      expect(
        database.prepare('SELECT lookup_key, symbol_id FROM materialization_ordered_lookup ORDER BY rowid').all(),
      ).toEqual([
        {lookup_key: 'alpha', symbol_id: 'symbol-1'},
        {lookup_key: 'alpha', symbol_id: 'symbol-3'},
        {lookup_key: 'zeta', symbol_id: 'symbol-2'},
      ]);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'materialization_raw_%'",
          )
          .get(),
      ).toEqual({count: 0});
      expect(() => sortCodeGraphMaterializationSpoolSurfaces(database)).not.toThrow();
      expect(initializeCodeGraphMaterializationSpoolDatabase(database, header)).toBe('resumed');
    } finally {
      database.close();
    }
  });

  it('rejects malformed sidecar headers before creating schema', () => {
    const database = new Database(':memory:', {strict: true});
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      expect(() =>
        initializeCodeGraphMaterializationSpoolDatabase(database, {
          checkoutId: '../escape',
          extractorSet: 'extractor-v1',
          graphContentId: `cgc_${Effect.pipe('b', EffectString.repeat(40))}`,
          repositoryId: Effect.pipe('c', EffectString.repeat(64)),
          snapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}-direct`,
        }),
      ).toThrow('Code graph materialization spool header is invalid.');
      expect(
        database
          .query<{readonly count: number}, []>("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'")
          .get(),
      ).toEqual({count: 0});
    } finally {
      database.close();
    }
  });

  fcProp(
    it,
    'records a contiguous exact append prefix and seals it once',
    {batchIds: FC.uniqueArray(FC.stringMatching(/^[0-9a-f]{64}$/u), {maxLength: 24})},
    ({batchIds}) => {
      const database = new Database(':memory:', {strict: true});
      try {
        configureCodeGraphMaterializationSpoolDatabase(database);
        initializeCodeGraphMaterializationSpoolDatabase(database, {
          checkoutId: Effect.pipe('a', EffectString.repeat(64)),
          extractorSet: 'extractor-v1',
          graphContentId: `cgc_${Effect.pipe('b', EffectString.repeat(40))}`,
          repositoryId: Effect.pipe('c', EffectString.repeat(64)),
          snapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}-direct`,
        });
        for (const [batchIndex, batchId] of batchIds.entries()) {
          const receipt = spoolReceipt({
            batchId,
            batchIndex,
            candidateCount: batchIndex,
            edgeCount: batchIndex * 2,
            factBytes: batchIndex * 3,
            lookupCount: batchIndex * 4,
            referenceCount: batchIndex * 5,
            reexportCount: batchIndex * 6,
            rowCount: batchIndex * 7,
            symbolCount: batchIndex * 8,
            termCount: batchIndex * 9,
          });
          expect(commitCodeGraphMaterializationSpoolBatch(database, receipt, () => undefined)).toBe('appended');
          expect(commitCodeGraphMaterializationSpoolBatch(database, receipt, () => undefined)).toBe('resumed');
        }
        expect(readCodeGraphMaterializationSpoolState(database)).toEqual({
          appendedBatchCount: batchIds.length,
          stage: 'appending',
        });
        expect(sealCodeGraphMaterializationSpool(database, batchIds.length)).toBe('sealed');
        expect(sealCodeGraphMaterializationSpool(database, batchIds.length)).toBe('resumed');
        expect(readCodeGraphMaterializationSpoolState(database)).toEqual({
          appendedBatchCount: batchIds.length,
          expectedBatchCount: batchIds.length,
          stage: 'sealed',
        });
      } finally {
        database.close();
      }
    },
    {fastCheck: {numRuns: 50}},
  );

  it('fails closed for gaps, receipt changes, premature seals, and appends after sealing', () => {
    const database = new Database(':memory:', {strict: true});
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      initializeCodeGraphMaterializationSpoolDatabase(database, {
        checkoutId: Effect.pipe('a', EffectString.repeat(64)),
        extractorSet: 'extractor-v1',
        graphContentId: `cgc_${Effect.pipe('b', EffectString.repeat(40))}`,
        repositoryId: Effect.pipe('c', EffectString.repeat(64)),
        snapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}-direct`,
      });
      const receipt = spoolReceipt({rowCount: 5});
      expect(() =>
        commitCodeGraphMaterializationSpoolBatch(database, {...receipt, batchIndex: 1}, () => undefined),
      ).toThrow('Code graph materialization spool batch sequence is not contiguous.');
      expect(() => sealCodeGraphMaterializationSpool(database, 1)).toThrow(
        'Code graph materialization spool cannot seal before every expected batch is committed.',
      );
      expect(commitCodeGraphMaterializationSpoolBatch(database, receipt, () => undefined)).toBe('appended');
      expect(() =>
        commitCodeGraphMaterializationSpoolBatch(database, {...receipt, rowCount: 6}, () => undefined),
      ).toThrow('Code graph materialization spool batch identity does not match the committed receipt.');
      expect(sealCodeGraphMaterializationSpool(database, 1)).toBe('sealed');
      expect(() => sealCodeGraphMaterializationSpool(database, 2)).toThrow(
        'Code graph materialization spool sealed batch count does not match.',
      );
      expect(() =>
        commitCodeGraphMaterializationSpoolBatch(
          database,
          {
            batchId: Effect.pipe('f', EffectString.repeat(64)),
            batchIndex: 1,
            candidateCount: 0,
            edgeCount: 0,
            factBytes: 0,
            lookupCount: 0,
            referenceCount: 0,
            reexportCount: 0,
            rowCount: 0,
            sourceBytes: 0,
            symbolCount: 0,
            termCount: 0,
          },
          () => undefined,
        ),
      ).toThrow('Code graph materialization spool is already sealed.');
    } finally {
      database.close();
    }
  });

  it('rejects a corrupt durable receipt ledger during exact-identity resume', () => {
    const database = new Database(':memory:', {strict: true});
    const header = {
      checkoutId: Effect.pipe('a', EffectString.repeat(64)),
      extractorSet: 'extractor-v1',
      graphContentId: `cgc_${Effect.pipe('b', EffectString.repeat(40))}`,
      repositoryId: Effect.pipe('c', EffectString.repeat(64)),
      snapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}-direct`,
    };
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      initializeCodeGraphMaterializationSpoolDatabase(database, header);
      commitCodeGraphMaterializationSpoolBatch(database, spoolReceipt({rowCount: 5}), () => undefined);
      database
        .prepare('UPDATE materialization_spool_batches SET batch_id = ? WHERE batch_index = 0')
        .run(Effect.pipe('z', EffectString.repeat(64)));
      expect(() => initializeCodeGraphMaterializationSpoolDatabase(database, header)).toThrow(
        'Code graph materialization spool batch ledger is corrupt.',
      );
    } finally {
      database.close();
    }
  });

  it('commits raw rows and their receipt atomically and skips an exact replay writer', () => {
    const database = new Database(':memory:', {strict: true});
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      initializeCodeGraphMaterializationSpoolDatabase(database, {
        checkoutId: Effect.pipe('a', EffectString.repeat(64)),
        extractorSet: 'extractor-v1',
        graphContentId: `cgc_${Effect.pipe('b', EffectString.repeat(40))}`,
        repositoryId: Effect.pipe('c', EffectString.repeat(64)),
        snapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}-direct`,
      });
      database.exec('CREATE TABLE raw_test (value TEXT NOT NULL)');
      const receipt = spoolReceipt({rowCount: 1});
      expect(() =>
        commitCodeGraphMaterializationSpoolBatch(database, receipt, () => {
          database.prepare('INSERT INTO raw_test (value) VALUES (?)').run('rolled-back');
          throw new Error('injected append failure');
        }),
      ).toThrow('injected append failure');
      expect(database.prepare('SELECT value FROM raw_test').all()).toEqual([]);
      expect(readCodeGraphMaterializationSpoolState(database)).toEqual({appendedBatchCount: 0, stage: 'appending'});

      expect(
        commitCodeGraphMaterializationSpoolBatch(database, receipt, () => {
          database.prepare('INSERT INTO raw_test (value) VALUES (?)').run('committed');
        }),
      ).toBe('appended');
      expect(
        commitCodeGraphMaterializationSpoolBatch(database, receipt, () => {
          throw new Error('exact replay writer must not run');
        }),
      ).toBe('resumed');
      expect(database.prepare('SELECT value FROM raw_test').all()).toEqual([{value: 'committed'}]);
    } finally {
      database.close();
    }
  });

  fcProp(
    it,
    'sorts a registered surface plan in a contiguous atomic prefix',
    {surfaceCount: FC.integer({max: 16, min: 1})},
    ({surfaceCount}) => {
      const database = new Database(':memory:', {strict: true});
      try {
        configureCodeGraphMaterializationSpoolDatabase(database);
        initializeCodeGraphMaterializationSpoolDatabase(database, {
          checkoutId: Effect.pipe('a', EffectString.repeat(64)),
          extractorSet: 'extractor-v1',
          graphContentId: `cgc_${Effect.pipe('b', EffectString.repeat(40))}`,
          repositoryId: Effect.pipe('c', EffectString.repeat(64)),
          snapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}-direct`,
        });
        sealCodeGraphMaterializationSpool(database, 0);
        expect(beginCodeGraphMaterializationSpoolSort(database, surfaceCount)).toBe('sorting');
        for (let surfaceIndex = 0; surfaceIndex < surfaceCount; surfaceIndex += 1) {
          expect(commitCodeGraphMaterializationSpoolSortedSurface(database, surfaceIndex, () => undefined)).toBe(
            'sorted',
          );
          expect(commitCodeGraphMaterializationSpoolSortedSurface(database, surfaceIndex, () => undefined)).toBe(
            'resumed',
          );
        }
        expect(finishCodeGraphMaterializationSpoolSort(database)).toBe('ready');
        expect(finishCodeGraphMaterializationSpoolSort(database)).toBe('resumed');
        expect(sealCodeGraphMaterializationSpool(database, 0)).toBe('resumed');
        expect(readCodeGraphMaterializationSpoolState(database)).toEqual({
          appendedBatchCount: 0,
          expectedBatchCount: 0,
          expectedSurfaceCount: surfaceCount,
          sortedSurfaceCount: surfaceCount,
          stage: 'ready',
        });
      } finally {
        database.close();
      }
    },
    {fastCheck: {numRuns: 50}},
  );

  it('rolls a failed surface back without advancing and rejects gaps or early readiness', () => {
    const database = new Database(':memory:', {strict: true});
    try {
      configureCodeGraphMaterializationSpoolDatabase(database);
      initializeCodeGraphMaterializationSpoolDatabase(database, {
        checkoutId: Effect.pipe('a', EffectString.repeat(64)),
        extractorSet: 'extractor-v1',
        graphContentId: `cgc_${Effect.pipe('b', EffectString.repeat(40))}`,
        repositoryId: Effect.pipe('c', EffectString.repeat(64)),
        snapshotId: `cgsn_${Effect.pipe('d', EffectString.repeat(40))}-direct`,
      });
      sealCodeGraphMaterializationSpool(database, 0);
      beginCodeGraphMaterializationSpoolSort(database, 2);
      database.exec('CREATE TABLE sorted_test (value TEXT NOT NULL)');
      expect(() =>
        commitCodeGraphMaterializationSpoolSortedSurface(database, 0, () => {
          database.prepare('INSERT INTO sorted_test (value) VALUES (?)').run('rolled-back');
          throw new Error('injected sort failure');
        }),
      ).toThrow('injected sort failure');
      expect(database.prepare('SELECT value FROM sorted_test').all()).toEqual([]);
      expect(() => commitCodeGraphMaterializationSpoolSortedSurface(database, 1, () => undefined)).toThrow(
        'Code graph materialization spool sorted surface sequence is not contiguous.',
      );
      expect(() => finishCodeGraphMaterializationSpoolSort(database)).toThrow(
        'Code graph materialization spool cannot become ready before every surface is sorted.',
      );
    } finally {
      database.close();
    }
  });
});

function spoolReceipt(overrides: Partial<Parameters<typeof commitCodeGraphMaterializationSpoolBatch>[1]> = {}) {
  return {
    batchId: Effect.pipe('e', EffectString.repeat(64)),
    batchIndex: 0,
    candidateCount: 0,
    edgeCount: 0,
    factBytes: 3,
    lookupCount: 0,
    referenceCount: 0,
    reexportCount: 0,
    rowCount: 0,
    sourceBytes: 7,
    symbolCount: 0,
    termCount: 0,
    ...overrides,
  };
}

function directCodeGraphSpoolSortCapacity(database: Database) {
  const pending = new Set(
    EffectArray.map(
      codeGraphSqliteAll<{readonly name: string}>(
        database,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'materialization_raw_%'",
      ),
      row => row.name,
    ),
  );
  return codeGraphSpoolSortCapacityBoundary(
    EffectArray.flatMap(CODE_GRAPH_MATERIALIZATION_SPOOL_SURFACES, surface => {
      if (!pending.has(`materialization_raw_${surface.name}`)) return [];
      const payload = EffectArray.join(
        EffectArray.map(surface.columns, column => `COALESCE(LENGTH(CAST(${column} AS BLOB)), 0)`),
        ' + ',
      );
      const lexicalTermBytes = surface.name === 'symbol_terms' ? 'COALESCE(SUM(LENGTH(CAST(term AS BLOB))), 0)' : '0';
      const row = codeGraphSqliteGet<{
        readonly bytes: bigint | number;
        readonly lexicalTermBytes: bigint | number;
        readonly rows: bigint | number;
      }>(
        database,
        `SELECT COALESCE(SUM(${payload}), 0) AS bytes,
           ${lexicalTermBytes} AS lexicalTermBytes, COUNT(*) AS rows
         FROM materialization_raw_${surface.name}`,
      );
      if (row === null) throw new Error('Direct spool capacity measurement is unavailable.');
      return [
        {
          bytes: Number(row.bytes),
          lexicalTermBytesUpperBound: Number(row.lexicalTermBytes),
          rows: Number(row.rows),
        },
      ];
    }),
  );
}
