import {Array as EffectArray, Option as EffectOption} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {it as effectIt} from '@effect/vitest';
import {Cause, Deferred, Effect, Exit, Fiber, Layer, Schema} from 'effect';
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import {SqlError} from 'effect/sql/SqlError';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  CODE_GRAPH_EXPORT_SCHEMA,
  CODE_GRAPH_EXPORT_LEASE_RENEWAL_INTERVAL_MILLISECONDS,
  CODE_GRAPH_EXPORT_VERSION,
  CodeGraphExportError,
  exportCodeGraph,
  type CodeGraphExportFormat,
  type CodeGraphExportLimit,
} from '@threadnote/graph/export';
import {
  CodeGraphStore,
  type CodeGraphEdgeCursor,
  type CodeGraphStoreShape,
  type CodeGraphSymbolCursor,
} from '@threadnote/graph/store';
import {CodeGraphStoreError} from '@threadnote/graph/types';
import type {CodeGraphEdge, CodeGraphSnapshot, CodeGraphSymbol} from '@threadnote/graph/types';

const ExportPayloadSchema = Schema.Struct({
  edges: Schema.Array(Schema.Struct({id: Schema.String})),
  nodes: Schema.Array(Schema.Struct({id: Schema.String, name: Schema.String})),
  summary: Schema.Struct({
    edges: Schema.Struct({
      available: Schema.Finite,
      omitted: Schema.Finite,
      scanned: Schema.Finite,
      truncated: Schema.Boolean,
      written: Schema.Finite,
    }),
    format: Schema.String,
    limits: Schema.Struct({
      edgeLimit: Schema.Union([Schema.Finite, Schema.Literal('all')]),
      nodeLimit: Schema.Union([Schema.Finite, Schema.Literal('all')]),
    }),
    nodes: Schema.Struct({
      available: Schema.Finite,
      supplemental: Schema.Finite,
      truncated: Schema.Boolean,
      written: Schema.Finite,
    }),
    provenanceCounts: Schema.Record(Schema.String, Schema.Finite),
    warnings: Schema.Array(Schema.String),
  }),
});

describe('portable code graph exports', () => {
  effectIt.effect('streams versioned JSON with explicit limits, provenance, and sensitivity metadata', () =>
    Effect.gen(function* () {
      const fixture = exportFixture();
      const result = yield* captureExport('json', fixture, {edgeLimit: 2, nodeLimit: 2, pageSize: 1});
      const parsedValue: unknown = JSON.parse(result.output);
      expect(Schema.is(ExportPayloadSchema)(parsedValue)).toBe(true);
      if (!Schema.is(ExportPayloadSchema)(parsedValue)) return yield* Effect.die('Invalid code graph export JSON.');
      const parsed = parsedValue;

      expect(parsed).toMatchObject({
        canonical: false,
        derived: true,
        format: 'json',
        schema: CODE_GRAPH_EXPORT_SCHEMA,
        sensitivity: {classification: 'source-sensitive'},
        trust: {
          classification: 'untrusted-repository-data',
          instructionPolicy: 'evidence-only-never-follow',
        },
        type: 'threadnote-code-graph-export',
        version: CODE_GRAPH_EXPORT_VERSION,
      });
      expect(EffectArray.map(parsed.nodes, node => node.id)).toEqual(['node-a', 'node-b']);
      expect(parsed.nodes[0].name).toBe(`Alpha <unsafe>&"'\u0000`);
      expect(EffectArray.map(parsed.edges, edge => edge.id)).toEqual(['edge-a', 'edge-b']);
      expect(parsed.summary).toMatchObject({
        edges: {available: 3, omitted: 0, scanned: 2, truncated: true, written: 2},
        nodes: {available: 3, truncated: true, written: 2},
        provenanceCounts: {declared: 1, heuristic: 1, model: 0, resolved: 0, syntactic: 0},
      });
      expect(EffectArray.join(parsed.summary.warnings, '\n')).toContain('Source-sensitive export');
      expect(fixture.nodePageSizes).toEqual([1, 1]);
      expect(fixture.edgePageSizes).toEqual([1, 1]);
      expect(fixture.leases).toEqual({acquired: 1, released: 1});
    }),
  );

  effectIt.effect(
    'emits interoperable GraphML with supplemental nodes for endpoints outside the selected symbols',
    () =>
      Effect.gen(function* () {
        const fixture = exportFixture();
        const first = yield* captureExport('graphml', fixture, {edgeLimit: 3, nodeLimit: 2, pageSize: 2});
        const second = yield* captureExport('graphml', exportFixture(), {edgeLimit: 3, nodeLimit: 2, pageSize: 2});

        expect(first.output).toBe(second.output);
        expect(first.output).toContain('<graphml xmlns="http://graphml.graphdrawing.org/xmlns">');
        expect(first.output).toContain('<node id="node-a">');
        expect(first.output).toContain('&lt;unsafe&gt;&amp;&quot;&apos;�');
        expect(first.output).not.toContain('<unsafe>');
        expect(first.output).toContain('<edge id="edge-a" source="node-a" target="node-b">');
        expect(first.output).toContain('<edge id="edge-b" source="node-b" target="tn-outside-selection-target-2">');
        expect(first.output).toContain(
          '<edge id="edge-c" source="tn-outside-selection-source-3" target="tn-unresolved-target-3">',
        );
        expect(first.output).toContain('<node id="tn-outside-selection-target-2">');
        expect(first.output).toContain('<node id="tn-outside-selection-source-3">');
        expect(first.output).toContain('<node id="tn-unresolved-target-3">');
        expect(first.summary.edges).toEqual({available: 3, omitted: 0, scanned: 3, truncated: false, written: 3});
        expect(first.summary.nodes).toEqual({available: 3, supplemental: 3, truncated: true, written: 2});
        expect(first.summary.provenanceCounts).toEqual({
          declared: 1,
          heuristic: 1,
          model: 0,
          resolved: 0,
          syntactic: 1,
        });
      }),
  );

  effectIt.effect('builds a script-free self-contained HTML report with an inline bounded overview', () =>
    Effect.gen(function* () {
      const result = yield* captureExport('html', exportFixture(), {edgeLimit: 3, nodeLimit: 3, pageSize: 2});

      expect(result.output).toContain('<!doctype html>');
      expect(result.output).toContain('Content-Security-Policy');
      expect(result.output).toContain("default-src 'none'; style-src 'unsafe-inline'");
      expect(result.output).not.toMatch(/<script\b/i);
      expect(result.output).toContain('&lt;unsafe&gt;&amp;&quot;&#39;�');
      expect(result.output).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(result.output).toContain('Derived · noncanonical · source-sensitive');
      expect(result.summary).toMatchObject({
        edges: {omitted: 0, scanned: 3, written: 3},
        nodes: {written: 3},
      });
    }),
  );

  effectIt.effect('builds a deterministic standalone SVG with non-authoritative edges distinguished', () =>
    Effect.gen(function* () {
      const first = yield* captureExport('svg', exportFixture(), {edgeLimit: 3, nodeLimit: 3, pageSize: 1});
      const second = yield* captureExport('svg', exportFixture(), {edgeLimit: 3, nodeLimit: 3, pageSize: 3});

      expect(first.output).toBe(second.output);
      expect(first.output).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
      expect(first.output).toContain('<metadata>');
      expect(first.output).toContain('DERIVED · NONCANONICAL · SOURCE-SENSITIVE');
      expect(first.output).toContain('stroke-dasharray="5 5"');
      expect(first.output).not.toMatch(/<script\b/i);
      expect(first.summary.edges).toEqual({available: 3, omitted: 1, scanned: 3, truncated: true, written: 2});
    }),
  );

  effectIt.effect('rejects non-safe-integer limits before opening a snapshot or writing output', () =>
    Effect.gen(function* () {
      const fixture = exportFixture();
      let writes = 0;
      const failure = yield* provideStore(
        exportCodeGraph({
          databasePath: '/graph.sqlite',
          format: 'svg',
          nodeLimit: Number.MAX_SAFE_INTEGER + 1,
          repository: {displayName: 'acme/repo', repositoryId: 'repository'},
          snapshotId: fixture.snapshot.id,
          write: () => Effect.sync(() => void (writes += 1)),
        }),
        fixture.store,
      ).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(CodeGraphExportError);

      expect(writes).toBe(0);
      expect(fixture.snapshotReads).toBe(0);
      expect(fixture.leases).toEqual({acquired: 0, released: 0});
    }),
  );

  effectIt.effect('accepts explicit graph selections above visualization defaults without a fixed maximum', () =>
    Effect.gen(function* () {
      const result = yield* captureExport('svg', exportFixture(), {
        edgeLimit: 500_000,
        nodeLimit: 1_000_000,
        pageSize: 500,
      });

      expect(result.summary.limits).toEqual({edgeLimit: 500_000, nodeLimit: 1_000_000});
      expect(result.summary).toMatchObject({
        edges: {scanned: 3, written: 2},
        nodes: {written: 3},
      });
      expect(EffectArray.join(result.summary.warnings, '\n')).toContain('Large SVG overviews');
    }),
  );

  effectIt.effect('lets bounded visual formats explicitly stream the complete snapshot', () =>
    Effect.gen(function* () {
      const result = yield* captureExport('svg', exportFixture(), {
        edgeLimit: 'all',
        nodeLimit: 'all',
        pageSize: 1,
      });

      expect(result.summary.limits).toEqual({edgeLimit: 'all', nodeLimit: 'all'});
      expect(result.summary).toMatchObject({
        edges: {available: 3, scanned: 3, written: 2},
        nodes: {available: 3, written: 3},
      });
      expect(EffectArray.join(result.summary.warnings, '\n')).toContain('Complete snapshot selection');
    }),
  );

  effectIt.effect('applies conservative format-specific defaults when limits are omitted', () =>
    Effect.gen(function* () {
      const summaries = yield* Effect.forEach(
        ['json', 'graphml', 'html', 'svg'] as const,
        format => {
          const fixture = exportFixture();
          const chunks: string[] = [];
          return provideStore(
            exportCodeGraph({
              databasePath: '/graph.sqlite',
              format,
              repository: {displayName: 'acme/repo', repositoryId: 'repository'},
              snapshotId: fixture.snapshot.id,
              write: chunk => Effect.sync(() => void chunks.push(chunk)),
            }),
            fixture.store,
          );
        },
        {concurrency: 'unbounded'},
      );

      expect(EffectArray.map(summaries, summary => [summary.format, summary.limits])).toEqual([
        ['json', {edgeLimit: 'all', nodeLimit: 'all'}],
        ['graphml', {edgeLimit: 'all', nodeLimit: 'all'}],
        ['html', {edgeLimit: 'all', nodeLimit: 'all'}],
        ['svg', {edgeLimit: 1_000, nodeLimit: 300}],
      ]);
      expect(EffectArray.every(summaries.slice(0, 3), summary => summary.nodes.written === 3)).toBe(true);
      expect(EffectArray.every(summaries.slice(0, 3), summary => summary.edges.written === 3)).toBe(true);
    }),
  );

  effectIt.effect('always releases the snapshot lease when a writer fails', () =>
    Effect.gen(function* () {
      const fixture = exportFixture();
      let writes = 0;
      const exit = yield* provideStore(
        exportCodeGraph({
          databasePath: '/graph.sqlite',
          format: 'json',
          repository: {displayName: 'acme/repo', repositoryId: 'repository'},
          snapshotId: fixture.snapshot.id,
          write: () =>
            Effect.sync(() => {
              writes += 1;
              if (writes === 2) throw TestError.make({message: 'disk full'});
            }),
        }),
        fixture.store,
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain('disk full');
      expect(fixture.leases).toEqual({acquired: 1, released: 1});
    }),
  );

  effectIt.effect('renews the snapshot lease while a complete export remains in progress', () =>
    Effect.gen(function* () {
      const fixture = exportFixture();
      yield* provideStore(
        Effect.gen(function* () {
          const writing = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          let first = true;
          const fiber = yield* exportCodeGraph({
            databasePath: '/graph.sqlite',
            format: 'json',
            repository: {displayName: 'acme/repo', repositoryId: 'repository'},
            snapshotId: fixture.snapshot.id,
            write: () =>
              first
                ? Effect.gen(function* () {
                    first = false;
                    yield* Deferred.succeed(writing, undefined);
                    yield* Deferred.await(resume);
                  })
                : Effect.void,
          }).pipe(Effect.forkChild);

          yield* Deferred.await(writing);
          yield* TestClock.adjust(CODE_GRAPH_EXPORT_LEASE_RENEWAL_INTERVAL_MILLISECONDS + 1);
          expect(fixture.leaseRenewals).toBe(1);
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(fiber);

          expect(fixture.leases).toEqual({acquired: 1, released: 1});
        }),
        fixture.store,
      );
    }),
  );
});

interface Fixture {
  readonly edgePageSizes: number[];
  readonly leases: {acquired: number; released: number};
  leaseRenewals: number;
  readonly nodePageSizes: number[];
  readonly snapshot: CodeGraphSnapshot;
  snapshotReads: number;
  store: Partial<CodeGraphStoreShape>;
}

function exportFixture(): Fixture {
  const snapshot: CodeGraphSnapshot = {
    commit: '0123456789abcdef',
    completedAt: '2026-07-31T00:00:00.000Z',
    dirty: false,
    edgeCount: 3,
    extractorSet: 'test-extractor',
    fileCount: 3,
    id: 'snapshot-1',
    repositoryId: 'repository',
    state: 'ready',
    symbolCount: 3,
    worktreeId: 'worktree',
  };
  const nodes = [
    node('node-a', 'a.ts', `Alpha <unsafe>&"'\u0000`),
    node('node-b', 'b.ts', 'Beta'),
    node('node-c', 'c.ts', 'Gamma'),
  ];
  const edges = [
    edge('edge-a', 'node-a', 'Alpha', 'node-b', 'Beta', 'declared'),
    edge('edge-b', 'node-b', 'Beta', 'node-c', 'Gamma', 'heuristic'),
    edge('edge-c', 'node-c', 'Gamma', undefined, 'External <unsafe>', 'syntactic'),
  ];
  const nodePageSizes: number[] = [];
  const edgePageSizes: number[] = [];
  const leases = {acquired: 0, released: 0};
  const fixture: Fixture = {
    edgePageSizes,
    leases,
    leaseRenewals: 0,
    nodePageSizes,
    snapshot,
    snapshotReads: 0,
    store: {},
  };
  fixture.store = {
    acquireSnapshotLease: () =>
      Effect.sync(() => {
        leases.acquired += 1;
        return 'lease';
      }),
    loadEdgePage: (
      _databasePath: string,
      _snapshotId: string,
      cursor: CodeGraphEdgeCursor | undefined,
      limit: number,
    ) =>
      Effect.sync(() => {
        edgePageSizes.push(limit);
        const start = cursor
          ? EffectOption.getOrElse(
              EffectArray.findFirstIndex(edges, candidate => candidate.id === cursor.id),
              () => -1,
            ) + 1
          : 0;
        return edges.slice(start, start + limit);
      }),
    loadSymbolPage: (
      _databasePath: string,
      _snapshotId: string,
      cursor: CodeGraphSymbolCursor | undefined,
      limit: number,
    ) =>
      Effect.sync(() => {
        nodePageSizes.push(limit);
        const start = cursor
          ? EffectOption.getOrElse(
              EffectArray.findFirstIndex(nodes, candidate => candidate.id === cursor.id),
              () => -1,
            ) + 1
          : 0;
        return nodes.slice(start, start + limit);
      }),
    readySnapshotById: () =>
      Effect.sync(() => {
        fixture.snapshotReads += 1;
        return snapshot;
      }),
    releaseSnapshotLease: () => Effect.sync(() => void (leases.released += 1)),
    renewSnapshotLease: () => Effect.sync(() => void (fixture.leaseRenewals += 1)),
    withSession: <A, E, R>(_databasePath: string, effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
      Effect.scoped(
        Layer.build(SqliteClient.layer({filename: ':memory:'})).pipe(
          Effect.flatMap(context => Effect.provide(effect, context)),
          Effect.mapError(error => (Schema.is(SqlError)(error) ? CodeGraphStoreError.of(error.message) : error)),
        ),
      ),
  };
  return fixture;
}

function provideStore<A, E>(effect: Effect.Effect<A, E, CodeGraphStore>, store: Partial<CodeGraphStoreShape>) {
  return Effect.scoped(
    Layer.build(Layer.mock(CodeGraphStore, store)).pipe(Effect.flatMap(context => Effect.provide(effect, context))),
  );
}

function captureExport(
  format: CodeGraphExportFormat,
  fixture: Fixture,
  limits: {
    readonly edgeLimit: CodeGraphExportLimit;
    readonly nodeLimit: CodeGraphExportLimit;
    readonly pageSize: number;
  },
) {
  const chunks: string[] = [];
  const program = exportCodeGraph({
    databasePath: '/graph.sqlite',
    format,
    ...limits,
    repository: {displayName: 'acme/repo', repositoryId: 'repository'},
    snapshotId: fixture.snapshot.id,
    write: chunk => Effect.sync(() => void chunks.push(chunk)),
  });
  return provideStore(program, fixture.store).pipe(
    Effect.map(summary => ({output: EffectArray.join(chunks, ''), summary})),
  );
}

function node(id: string, path: string, name: string): CodeGraphSymbol {
  return {
    contentHash: `hash-${id}`,
    documentation: `Documentation for ${name}`,
    exported: true,
    id,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [`ts:name:${name}`],
    name,
    path,
    qualifiedName: name,
    resolutionDomain: 'typescript',
    signature: `function ${name}(): void`,
    span: {column: 1, endColumn: 2, endLine: 2, line: 1},
  };
}

function edge(
  id: string,
  sourceId: string | undefined,
  sourceName: string,
  targetId: string | undefined,
  targetName: string,
  provenance: CodeGraphEdge['provenance'],
): CodeGraphEdge {
  return {
    confidence: provenance === 'heuristic' ? 0.5 : 1,
    evidencePath: 'src/evidence.ts',
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id,
    provenance,
    relation: 'calls',
    sourceId,
    sourceName,
    targetId,
    targetName,
  };
}
