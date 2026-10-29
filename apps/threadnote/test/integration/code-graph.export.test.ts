import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {it as effectIt} from '@effect/vitest';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdtempSync, rmSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Effect, Layer, Schema} from 'effect';
import {afterEach, describe, expect} from 'vitest';
import {exportCodeGraph} from '@threadnote/graph/export';
import {CodeGraphStore} from '@threadnote/graph/store';

import type {
  CodeGraphEdge,
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '@threadnote/graph/types';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0).reverse()) rmSync(root, {force: true, recursive: true});
});

describe('SQLite code graph export integration', () => {
  effectIt.effect('reads deterministic bounded pages from a ready snapshot for JSON and GraphML', () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), 'threadnote-graph-export-'));
      temporaryRoots.push(root);
      const databasePath = join(root, 'graph.sqlite');
      const identity = repositoryIdentity(root);
      const snapshot = readySnapshot(identity);
      const symbols = storedSymbols();
      const edges = storedEdges();
      const files = storedFiles();

      const result = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, identity, snapshot, files, symbols, edges);
        const firstJson = yield* capture(databasePath, snapshot, 'json', 1);
        const secondJson = yield* capture(databasePath, snapshot, 'json', 2);
        const graphml = yield* capture(databasePath, snapshot, 'graphml', 1);
        return {firstJson, graphml, secondJson};
      }).pipe(provideTestLayer(codeGraphStoreLayer));

      expect(result.firstJson.output).toBe(result.secondJson.output);
      const graphExportSchema = Schema.Struct({
        edges: Schema.Array(Schema.Struct({id: Schema.String})),
        nodes: Schema.Array(Schema.Struct({path: Schema.String, qualifiedName: Schema.String})),
        summary: Schema.Struct({
          edges: Schema.Struct({written: Schema.Finite}),
          nodes: Schema.Struct({written: Schema.Finite}),
        }),
      });
      const json = yield* Schema.decodeUnknownEffect(graphExportSchema)(JSON.parse(result.firstJson.output));
      expect(EffectArray.map(json.nodes, node => `${node.path}#${node.qualifiedName}`)).toEqual([
        'src/a.ts#Alpha',
        'src/z.ts#Zeta <&>',
      ]);
      expect(EffectArray.map(json.edges, edge => edge.id)).toEqual(['edge-alpha', 'edge-zeta', 'edge-unresolved']);
      expect(json.summary).toMatchObject({edges: {written: 3}, nodes: {written: 2}});

      expect(result.graphml.output).toContain('<node id="node-alpha">');
      expect(result.graphml.output).toContain('Zeta &lt;&amp;&gt;');
      expect(result.graphml.output).toContain('<edge id="edge-alpha" source="node-alpha" target="node-zeta">');
      expect(result.graphml.output).toContain('<edge id="edge-zeta" source="node-zeta" target="node-alpha">');
      expect(result.graphml.output).toContain(
        '<edge id="edge-unresolved" source="node-zeta" target="tn-unresolved-target-3">',
      );
      expect(result.graphml.summary.edges).toMatchObject({omitted: 0, scanned: 3, written: 3});
      expect(result.graphml.summary.nodes).toMatchObject({supplemental: 1, written: 2});
    }),
  );

  effectIt.effect('renews only an active SQLite snapshot lease', () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), 'threadnote-graph-export-lease-'));
      temporaryRoots.push(root);
      const databasePath = join(root, 'graph.sqlite');
      const identity = repositoryIdentity(root);
      const snapshot = readySnapshot(identity);

      const result = yield* Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        yield* store.activate(databasePath, identity, snapshot, storedFiles(), storedSymbols(), storedEdges());
        const lease = yield* store.acquireSnapshotLease(databasePath, snapshot.id, 1_000);
        yield* store.renewSnapshotLease(databasePath, lease, 5_000);
        yield* store.releaseSnapshotLease(databasePath, lease);
        return yield* store.renewSnapshotLease(databasePath, lease, 5_000).pipe(Effect.result);
      }).pipe(provideTestLayer(codeGraphStoreLayer));

      expect(result._tag).toBe('Failure');
    }),
  );
});

const codeGraphStoreLayer = CodeGraphStore.layer.pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);

function capture(databasePath: string, snapshot: CodeGraphSnapshot, format: 'graphml' | 'json', pageSize: number) {
  const chunks: string[] = [];
  return exportCodeGraph({
    databasePath,
    edgeLimit: 10,
    format,
    nodeLimit: 10,
    pageSize,
    repository: {displayName: 'acme/<portable>', repositoryId: snapshot.repositoryId},
    snapshotId: snapshot.id,
    write: chunk => Effect.sync(() => void chunks.push(chunk)),
  }).pipe(Effect.map(summary => ({output: EffectArray.join(chunks, ''), summary})));
}

function repositoryIdentity(root: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: 'checkout-export',
    displayName: 'acme/portable',
    gitCommonDirectory: join(root, '.git'),
    headCommit: '0123456789abcdef0123456789abcdef01234567',
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: 'repository-export',
    worktreeId: 'worktree-export',
  };
}

function readySnapshot(identity: RepositoryIdentity): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    completedAt: '2026-07-31T00:00:00.000Z',
    dirty: false,
    edgeCount: 3,
    extractorSet: 'integration-export',
    fileCount: 2,
    id: 'snapshot-export',
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 2,
    worktreeId: identity.worktreeId,
  };
}

function storedFiles(): readonly CodeGraphInventoryFile[] {
  return [
    {
      blobId: 'blob-zeta',
      contentHash: 'hash-zeta',
      language: 'typescript',
      mode: '100644',
      path: 'src/z.ts',
      size: 1,
      source: 'commit',
    },
    {
      blobId: 'blob-alpha',
      contentHash: 'hash-alpha',
      language: 'typescript',
      mode: '100644',
      path: 'src/a.ts',
      size: 1,
      source: 'commit',
    },
  ];
}

function storedSymbols(): readonly CodeGraphSymbol[] {
  return [
    {
      contentHash: 'hash-zeta',
      documentation: 'Zeta documentation',
      exported: true,
      id: 'node-zeta',
      kind: 'function',
      language: 'typescript',
      name: 'Zeta <&>',
      path: 'src/z.ts',
      qualifiedName: 'Zeta <&>',
      signature: 'function Zeta(): void',
      span: {column: 1, endColumn: 2, endLine: 1, line: 1},
    },
    {
      contentHash: 'hash-alpha',
      documentation: 'Alpha documentation',
      exported: true,
      id: 'node-alpha',
      kind: 'function',
      language: 'typescript',
      name: 'Alpha',
      path: 'src/a.ts',
      qualifiedName: 'Alpha',
      signature: 'function Alpha(): void',
      span: {column: 1, endColumn: 2, endLine: 1, line: 1},
    },
  ];
}

function storedEdges(): readonly CodeGraphEdge[] {
  return [
    relationship('edge-zeta', 'node-zeta', 'Zeta', 'node-alpha', 'Alpha', 'resolved'),
    relationship('edge-unresolved', 'node-zeta', 'Zeta', undefined, 'External', 'syntactic'),
    relationship('edge-alpha', 'node-alpha', 'Alpha', 'node-zeta', 'Zeta', 'declared'),
  ];
}

function relationship(
  id: string,
  sourceId: string,
  sourceName: string,
  targetId: string | undefined,
  targetName: string,
  provenance: CodeGraphEdge['provenance'],
): CodeGraphEdge {
  return {
    confidence: provenance === 'syntactic' ? 0.6 : 1,
    evidencePath: sourceId === 'node-zeta' ? 'src/z.ts' : 'src/a.ts',
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
