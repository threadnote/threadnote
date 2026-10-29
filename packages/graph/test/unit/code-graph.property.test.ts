import {Array as EffectArray} from 'effect';
import {fcEffectProp, fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {
  codeGraphInventoryExclusionReason,
  parseGitCatFileBatch,
  parseGitTree,
  parseNameStatus,
  summarizeCodeGraphInventoryPreview,
} from '@threadnote/graph/inventory';
import {parsePorcelainV1Status} from '@threadnote/graph/inventory/porcelain';
import {
  CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES,
  CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES,
} from '@threadnote/graph/inventory/policy';
import type {CodeGraphLayout} from '@threadnote/graph/layout';
import {
  neighborQuery,
  traversalQuery,
  type CodeGraphTraversalQueryEmbedding,
  type CodeGraphTraversalQueryStore,
} from '@threadnote/graph/query';
import type {CodeGraphEdge, CodeGraphQueryNode, CodeGraphQueryResult} from '@threadnote/graph/types';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const pathSegmentArbitrary = FC.array(
  FC.constantFrom('a', 'Z', '0', ' ', '.', '-', '_', 'é', '漢', '🙂', '\\', '\t', '\n'),
  {maxLength: 14, minLength: 1},
).map(characters => EffectArray.join(characters, ''));

const repositoryPathArbitrary = FC.record({
  leadingDot: FC.boolean(),
  segments: FC.array(pathSegmentArbitrary, {maxLength: 4, minLength: 1}),
}).map(({leadingDot, segments}) => `${leadingDot ? './' : ''}${EffectArray.join(segments, '/')}`);

const objectIdArbitrary = FC.array(FC.constantFrom(...'0123456789abcdef'), {
  maxLength: 40,
  minLength: 40,
}).map(characters => EffectArray.join(characters, ''));

const gitTreeEntryArbitrary = FC.record({
  blobId: objectIdArbitrary,
  mode: FC.constantFrom('100644', '100755'),
  path: repositoryPathArbitrary,
  size: FC.integer({max: 16 * 1_048_576, min: 0}),
});

const inventoryPreviewEntryArbitrary = FC.record({
  path: FC.constantFrom(
    'src/application.ts',
    'package.json',
    'tsconfig.json',
    'assets/icon.svg',
    'test/__fixtures__/payload.json',
    'data/payload.json',
    'dist/generated.ts',
    'artifact.bin',
  ),
  size: FC.integer({max: CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES + 1, min: 0}),
});

type NameStatusChange =
  | {
      readonly kind: 'A' | 'D' | 'M';
      readonly path: string;
    }
  | {
      readonly from: string;
      readonly kind: 'C' | 'R';
      readonly score: number;
      readonly to: string;
    };

const nameStatusChangeArbitrary: FC.Arbitrary<NameStatusChange> = FC.oneof(
  FC.record({
    kind: FC.constantFrom('A' as const, 'D' as const, 'M' as const),
    path: repositoryPathArbitrary,
  }),
  FC.record({
    from: repositoryPathArbitrary,
    kind: FC.constantFrom('C' as const, 'R' as const),
    score: FC.integer({max: 100, min: 0}),
    to: repositoryPathArbitrary,
  }),
);

type PorcelainStatusChange =
  | NameStatusChange
  | {readonly kind: '?'; readonly path: string}
  | {
      readonly kind: 'U';
      readonly path: string;
      readonly status: 'AA' | 'AU' | 'DD' | 'DU' | 'UA' | 'UD' | 'UU';
    };

const porcelainStatusChangeArbitrary: FC.Arbitrary<PorcelainStatusChange> = FC.oneof(
  nameStatusChangeArbitrary,
  FC.record({kind: FC.constant('?' as const), path: repositoryPathArbitrary}),
  FC.record({
    kind: FC.constant('U' as const),
    path: repositoryPathArbitrary,
    status: FC.constantFrom(
      'AA' as const,
      'AU' as const,
      'DD' as const,
      'DU' as const,
      'UA' as const,
      'UD' as const,
      'UU' as const,
    ),
  }),
);

const graphCaseArbitrary = FC.record({
  depth: FC.integer({max: 8, min: 0}),
  nodeCount: FC.integer({max: 8, min: 1}),
  rawEdges: FC.array(FC.tuple(FC.integer({max: 31, min: 0}), FC.integer({max: 31, min: 0})), {maxLength: 32}),
  seedIndex: FC.integer({max: 31, min: 0}),
});

const boundedNeighborCaseArbitrary = FC.record({
  depth: FC.integer({max: 8, min: 0}),
  direction: FC.constantFrom<'both' | 'incoming' | 'outgoing'>('both', 'incoming', 'outgoing'),
  edgeLimit: FC.integer({max: 24, min: 1}),
  nodeCount: FC.integer({max: 8, min: 1}),
  nodeLimit: FC.integer({max: 8, min: 1}),
  rawEdges: FC.array(FC.tuple(FC.integer({max: 31, min: 0}), FC.integer({max: 31, min: 0})), {maxLength: 32}),
  seedIndex: FC.integer({max: 31, min: 0}),
});

const layout: CodeGraphLayout = {
  checkoutId: 'property-checkout',
  databaseWriteLockPath: '/property/database-write.lock',
  databasePath: '/property/graph.sqlite',
  lockPath: '/property/graph.lock',
  repositoryRoot: '/property',
  staleMarkerPath: '/property/stale',
  vectorRoot: '/property/vectors',
  worktreeLockRoot: '/property/worktree-locks',
  worktreeId: 'property-worktree',
};

const emptyEmbedding = {
  search: () => Effect.succeed(new Map<string, number>()),
} satisfies CodeGraphTraversalQueryEmbedding;

describe('native code graph parser properties', () => {
  fcProp(
    it,
    'matches the independent low-meaning admission model across size and path case',
    {
      kind: FC.constantFrom(
        'svg',
        'low-signal-json',
        'wrapped-fixture-json',
        'generated-json',
        'overlapping-low-signal-json',
        'generic-json',
        'high-signal-json',
        'source',
      ),
      size: FC.integer({max: CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES + 1, min: 0}),
      uppercase: FC.boolean(),
    },
    ({kind, size, uppercase}) => {
      const path = inventoryPolicyPath(kind, uppercase);
      const expected =
        kind === 'svg'
          ? 'svg'
          : kind === 'low-signal-json' ||
              kind === 'wrapped-fixture-json' ||
              kind === 'generated-json' ||
              kind === 'overlapping-low-signal-json'
            ? 'low-signal-json'
            : kind === 'generic-json' && size >= CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES
              ? 'generic-json-size'
              : kind === 'high-signal-json' && size >= CODE_GRAPH_HIGH_SIGNAL_JSON_HARD_CAP_BYTES
                ? 'high-signal-json-hard-cap'
                : undefined;

      expect(codeGraphInventoryExclusionReason(path, size)).toBe(expected);
    },
    {fastCheck: {numRuns: 300}},
  );

  fcProp(
    it,
    'round-trips ordinary Git tree records without interpreting repository filenames',
    {
      entries: FC.array(gitTreeEntryArbitrary, {maxLength: 24}),
    },
    ({entries}) => {
      const output = EffectArray.join(
        EffectArray.map(entries, entry => `${entry.mode} blob ${entry.blobId} ${entry.size}\t${entry.path}\0`),
        '',
      );

      expect(parseGitTree(output)).toEqual(
        EffectArray.map(entries, entry => ({
          ...entry,
          path: normalizeRepositoryPath(entry.path),
        })),
      );
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'round-trips byte-exact Git cat-file batches',
    {
      blobs: FC.array(FC.uint8Array({maxLength: 96}), {maxLength: 16}),
    },
    ({blobs}) => {
      const entries = EffectArray.map(blobs, (blob, index) => ({
        blobId: `${Effect2.pipe('0', EffectString.repeat(39))}${index.toString(16)}`,
        size: blob.byteLength,
      }));
      const chunks = EffectArray.flatMap(blobs, (blob, index) => [
        new TextEncoder().encode(`${entries[index].blobId} blob ${blob.byteLength}\n`),
        blob,
        Uint8Array.of(10),
      ]);

      expect(parseGitCatFileBatch(concatenateBytes(chunks), entries)).toEqual(blobs);
    },
    {fastCheck: {numRuns: 150}},
  );

  fcProp(
    it,
    'conserves files and bytes while inventory aggregation remains order-independent',
    {
      entries: FC.array(inventoryPreviewEntryArbitrary, {maxLength: 80}),
    },
    ({entries}) => {
      const forward = summarizeCodeGraphInventoryPreview(entries, {threadnoteIgnore: 'src/application.ts\n'});
      const reverse = summarizeCodeGraphInventoryPreview([...entries].reverse(), {
        threadnoteIgnore: 'src/application.ts\n',
      });
      const expectedBytes = EffectArray.reduce(entries, 0, (total, entry) => total + entry.size);

      expect(reverse).toEqual(forward);
      expect(forward.totals.repository).toEqual({bytes: expectedBytes, files: entries.length});
      expect(forward.totals.eligible.files + forward.totals.skipped.files).toBe(entries.length);
      expect(forward.totals.eligible.bytes + forward.totals.skipped.bytes).toBe(expectedBytes);
      expect(EffectArray.reduce(forward.groups, 0, (total, group) => total + group.files)).toBe(entries.length);
      expect(EffectArray.reduce(forward.groups, 0, (total, group) => total + group.bytes)).toBe(expectedBytes);
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'matches a reference model for arbitrary add, modify, delete, copy, and rename records',
    {
      changes: FC.array(nameStatusChangeArbitrary, {maxLength: 40}),
    },
    ({changes}) => {
      const actual = parseNameStatus(encodeNameStatus(changes));
      const expected = modelNameStatus(changes);

      expect([...actual.added].sort()).toEqual([...expected.added].sort());
      expect([...actual.changed].sort()).toEqual([...expected.changed].sort());
      expect([...actual.deleted].sort()).toEqual([...expected.deleted].sort());
    },
    {fastCheck: {numRuns: 200}},
  );

  fcProp(
    it,
    'matches a reference model for porcelain-v1 add, modify, delete, copy, rename, and untracked records',
    {
      changes: FC.array(porcelainStatusChangeArbitrary, {maxLength: 40}),
    },
    ({changes}) => {
      const actual = parsePorcelainV1Status(encodePorcelainStatus(changes));
      const expected = modelPorcelainStatus(changes);

      expect([...actual.added].sort()).toEqual([...expected.added].sort());
      expect([...actual.changed].sort()).toEqual([...expected.changed].sort());
      expect([...actual.deleted].sort()).toEqual([...expected.deleted].sort());
      expect([...actual.untracked].sort()).toEqual([...expected.untracked].sort());
    },
    {fastCheck: {numRuns: 200}},
  );
});

function inventoryPolicyPath(
  kind:
    | 'generated-json'
    | 'generic-json'
    | 'high-signal-json'
    | 'low-signal-json'
    | 'overlapping-low-signal-json'
    | 'source'
    | 'svg'
    | 'wrapped-fixture-json',
  uppercase: boolean,
): string {
  const path =
    kind === 'svg'
      ? 'assets/icons/generated.svg'
      : kind === 'low-signal-json'
        ? 'test/golden-data/payload.json'
        : kind === 'wrapped-fixture-json'
          ? 'test/__fixtures__/payload.json'
          : kind === 'generated-json'
            ? 'config/generated/runtime-config.json'
            : kind === 'overlapping-low-signal-json'
              ? 'configs/fixtures/runtime-config.json'
              : kind === 'generic-json'
                ? 'data/application.jsonc'
                : kind === 'high-signal-json'
                  ? 'apps/mobile/project.json'
                  : 'src/application.ts';
  return uppercase ? Effect2.pipe(path, EffectString.toUpperCase) : path;
}

describe('native code graph traversal properties', () => {
  fcEffectProp(
    it,
    'keeps exact impact selectors independent of fuzzy candidate order and score',
    {
      lowercaseQuery: FC.boolean(),
      noiseScores: FC.array(FC.integer({max: 100, min: 1}), {maxLength: 20}),
      position: FC.integer({max: 100, min: 0}),
    },
    ({lowercaseQuery, noiseScores, position}) => {
      const exact = {
        ...graphNode(0),
        id: 'exact-impact-target',
        name: 'TargetSelector',
        qualifiedName: 'TargetSelector',
        score: 0.01,
      };
      const candidates = EffectArray.map(noiseScores, (score, index) => ({
        ...graphNode(index + 1),
        id: `noise-${index}`,
        name: `TargetSelectorNoise${index}`,
        qualifiedName: `TargetSelectorNoise${index}`,
        score: score / 100,
      }));
      candidates.splice(position % (candidates.length + 1), 0, exact);
      const inspectedSeeds: string[][] = [];
      const store = {
        edgesForNodes: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
          Effect.sync(() => {
            inspectedSeeds.push([...ids]);
            return [];
          }),
        findSymbolsByPathAndName: () => Effect.succeed([]),
        searchSymbolsByPaths: () => Effect.succeed([]),
        searchSymbolsMany: () => Effect.succeed([candidates]),
        symbolsByIds: () => Effect.succeed([]),
        traversalEdgesForNodes: () => Effect.succeed([]),
      } satisfies CodeGraphTraversalQueryStore;

      return Effect.gen(function* () {
        const result = yield* traversalQuery(
          store,
          layout.databasePath,
          'snapshot',
          lowercaseQuery ? Effect2.pipe(exact.name, EffectString.toLocaleLowerCase('en-US')) : exact.name,
          'incoming',
          20,
          40,
          1,
          ['resolved'],
          emptyEmbedding,
          '/property/home',
          layout,
          true,
        );

        expect(inspectedSeeds).toEqual([[exact.id]]);
        expect(EffectArray.map(result.nodes, node => node.id)).toEqual([exact.id]);
      });
    },
    {fastCheck: {numRuns: 80}},
  );

  fcEffectProp(
    it,
    'matches breadth-first reachability and terminates on generated cyclic graphs',
    {
      graph: graphCaseArbitrary,
    },
    ({graph}) => {
      const nodes = Array.from({length: graph.nodeCount}, (_, index) => graphNode(index));
      const seed = nodes[graph.seedIndex % graph.nodeCount];
      const edges = graphEdges(graph.nodeCount, graph.rawEdges);
      const store = graphStore(nodes, seed, edges);
      const expected = referenceTraversal(seed.id, edges, graph.depth);

      return Effect.gen(function* () {
        const result = yield* traversalQuery(
          store,
          layout.databasePath,
          'snapshot',
          seed.name,
          'outgoing',
          graph.nodeCount,
          edges.length + 1,
          graph.depth,
          ['resolved'],
          emptyEmbedding,
          '/property/home',
          layout,
          false,
        );

        expect(new Set(EffectArray.map(result.nodes, node => node.id))).toEqual(expected.nodes);
        expect(new Set(EffectArray.map(result.edges, edge => edge.id))).toEqual(expected.edges);
        expect(new Set(EffectArray.map(result.nodes, node => node.id)).size).toBe(result.nodes.length);
        expect(new Set(EffectArray.map(result.edges, edge => edge.id)).size).toBe(result.edges.length);
        expect(EffectArray.every(result.nodes, node => Number.isFinite(node.score) && node.score > 0)).toBe(true);
      });
    },
    {fastCheck: {numRuns: 80}},
  );

  it.effect('reports complete one-hop neighbors at exact node and edge capacities', () =>
    Effect.gen(function* () {
      const nodes = [graphNode(0), graphNode(1)];
      const edges = graphEdges(2, []).slice(0, 1);
      const result: CodeGraphQuerySelection = yield* neighborQuery(
        graphStore(nodes, nodes[0], edges),
        'db',
        'snapshot',
        nodes[0].id,
        'outgoing',
        2,
        1,
        1,
        ['resolved'],
      );
      expect(result.searchCoverage).toMatchObject({
        status: 'exhaustive',
        limitsReached: [],
        visitedNodes: 2,
        inspectedEdges: 1,
      });
      expect(EffectArray.map(result.nodes, node => node.id)).toEqual(EffectArray.map(nodes, node => node.id));
    }),
  );

  it.effect('distinguishes incomplete neighbor edge and node budgets', () =>
    Effect.gen(function* () {
      const nodes = [graphNode(0), graphNode(1), graphNode(2)];
      const edges = graphEdges(3, [[0, 2]]);
      const store = graphStore(nodes, nodes[0], edges);
      const edgeBounded: CodeGraphQuerySelection = yield* neighborQuery(
        store,
        'db',
        'snapshot',
        nodes[0].id,
        'outgoing',
        3,
        1,
        1,
        ['resolved'],
      );
      const nodeBounded: CodeGraphQuerySelection = yield* neighborQuery(
        store,
        'db',
        'snapshot',
        nodes[0].id,
        'outgoing',
        2,
        5,
        1,
        ['resolved'],
      );
      expect(edgeBounded.searchCoverage).toMatchObject({status: 'bounded', limitsReached: ['edge-limit']});
      expect(nodeBounded.searchCoverage).toMatchObject({status: 'bounded', limitsReached: ['node-limit']});
    }),
  );

  it.effect('never reports complete neighbors when endpoint hydration or identity is missing', () =>
    Effect.gen(function* () {
      const seed = graphNode(0);
      const edge = graphEdges(2, [])[0];
      for (const candidate of [edge, {...edge, targetId: undefined}]) {
        const result: CodeGraphQuerySelection = yield* neighborQuery(
          graphStore([seed], seed, [candidate]),
          'db',
          'snapshot',
          seed.id,
          'outgoing',
          5,
          5,
          1,
          ['resolved'],
        );
        expect(result.searchCoverage?.status).toBe('unresolved');
      }
    }),
  );

  it.effect('records neighbor deadline exhaustion with the test clock', () =>
    Effect.gen(function* () {
      const seed = graphNode(0);
      const base = graphStore([seed], seed, []);
      const store: CodeGraphTraversalQueryStore = {
        ...base,
        edgesForNodes: (...args) => TestClock.adjust('2 seconds').pipe(Effect.andThen(base.edgesForNodes(...args))),
      };
      const result: CodeGraphQuerySelection = yield* neighborQuery(
        store,
        'db',
        'snapshot',
        seed.id,
        'outgoing',
        5,
        5,
        1,
        ['resolved'],
      );
      expect(result.searchCoverage).toMatchObject({status: 'timed-out', limitsReached: ['time-budget']});
    }),
  );

  fcEffectProp(
    it,
    'reports exhaustive one-hop coverage exactly when all requested neighbors fit',
    {graph: boundedNeighborCaseArbitrary},
    ({graph}) =>
      Effect.gen(function* () {
        const nodes = Array.from({length: graph.nodeCount}, (_, index) => graphNode(index));
        const seed = nodes[graph.seedIndex % graph.nodeCount];
        const edges = graphEdges(graph.nodeCount, graph.rawEdges);
        const result: CodeGraphQuerySelection = yield* neighborQuery(
          graphStore(nodes, seed, edges),
          'db',
          'snapshot',
          seed.id,
          graph.direction,
          nodes.length,
          Math.max(1, edges.length),
          1,
          ['resolved'],
        );
        expect(result.searchCoverage).toMatchObject({status: 'exhaustive', limitsReached: []});
        expect(new Set(EffectArray.map(result.nodes, node => node.id))).toEqual(
          referenceNeighborReachability(seed.id, edges, graph.direction, 1),
        );
      }),
    {fastCheck: {numRuns: 40}},
  );

  fcEffectProp(
    it,
    'keeps exact-ID neighbor traversal within direction, depth, node, and edge bounds',
    {
      graph: boundedNeighborCaseArbitrary,
    },
    ({graph}) => {
      const nodes = Array.from({length: graph.nodeCount}, (_, index) => graphNode(index));
      const seed = nodes[graph.seedIndex % graph.nodeCount];
      const edges = graphEdges(graph.nodeCount, graph.rawEdges);
      const store = graphStore(nodes, seed, edges);
      const reachable = referenceNeighborReachability(seed.id, edges, graph.direction, graph.depth);

      return Effect.gen(function* () {
        const result = yield* neighborQuery(
          store,
          layout.databasePath,
          'snapshot',
          seed.id,
          graph.direction,
          graph.nodeLimit,
          graph.edgeLimit,
          graph.depth,
          ['resolved'],
        );

        const visibleIds = new Set(EffectArray.map(result.nodes, node => node.id));
        expect(result.nodes[0]?.id).toBe(seed.id);
        expect(result.nodes.length).toBeLessThanOrEqual(graph.nodeLimit);
        expect(result.edges.length).toBeLessThanOrEqual(graph.edgeLimit);
        expect(visibleIds.size).toBe(result.nodes.length);
        expect(new Set(EffectArray.map(result.edges, edge => edge.id)).size).toBe(result.edges.length);
        expect(EffectArray.every(result.nodes, node => reachable.has(node.id))).toBe(true);
        expect(
          EffectArray.every(
            result.edges,
            edge =>
              edge.sourceId !== undefined &&
              visibleIds.has(edge.sourceId) &&
              edge.targetId !== undefined &&
              visibleIds.has(edge.targetId),
          ),
        ).toBe(true);
      });
    },
    {fastCheck: {numRuns: 120}},
  );
});

type CodeGraphQuerySelection = Pick<CodeGraphQueryResult, 'nodes' | 'edges' | 'searchCoverage'>;

function normalizeRepositoryPath(value: string): string {
  return Effect2.pipe(value, EffectString.replace(/^\.\/+/, ''));
}

function concatenateBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(EffectArray.reduce(chunks, 0, (total, chunk) => total + chunk.byteLength));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function encodeNameStatus(changes: readonly NameStatusChange[]): string {
  const fields: string[] = [];
  for (const change of changes) {
    if ('from' in change) {
      fields.push(`${change.kind}${change.score}`, change.from, change.to);
    } else {
      fields.push(change.kind, change.path);
    }
  }
  return `${EffectArray.join(fields, '\0')}\0`;
}

function encodePorcelainStatus(changes: readonly PorcelainStatusChange[]): string {
  const fields: string[] = [];
  for (const change of changes) {
    if ('from' in change) {
      fields.push(`${change.kind}  ${change.to}`, change.from);
    } else if (change.kind === '?') {
      fields.push(`?? ${change.path}`);
    } else if (change.kind === 'U') {
      fields.push(`${change.status} ${change.path}`);
    } else {
      const status = change.kind === 'M' ? ' M' : `${change.kind} `;
      fields.push(`${status} ${change.path}`);
    }
  }
  return `${EffectArray.join(fields, '\0')}\0`;
}

function modelNameStatus(changes: readonly NameStatusChange[]): {
  readonly added: Set<string>;
  readonly changed: Set<string>;
  readonly deleted: Set<string>;
} {
  const added = new Set<string>();
  const changed = new Set<string>();
  const deleted = new Set<string>();
  for (const change of changes) {
    if ('from' in change) {
      if (change.kind === 'R') deleted.add(normalizeRepositoryPath(change.from));
      const destination = normalizeRepositoryPath(change.to);
      added.add(destination);
      changed.add(destination);
      continue;
    }
    if (change.kind === 'D') {
      deleted.add(normalizeRepositoryPath(change.path));
    } else {
      const path = normalizeRepositoryPath(change.path);
      changed.add(path);
      if (change.kind === 'A') added.add(path);
    }
  }
  return {added, changed, deleted};
}

function modelPorcelainStatus(changes: readonly PorcelainStatusChange[]): {
  readonly added: Set<string>;
  readonly changed: Set<string>;
  readonly deleted: Set<string>;
  readonly untracked: Set<string>;
} {
  const tracked = modelNameStatus(
    EffectArray.filter(changes, (change): change is NameStatusChange => change.kind !== '?' && change.kind !== 'U'),
  );
  const untracked = new Set(
    EffectArray.map(
      EffectArray.filter(
        changes,
        (change): change is Extract<PorcelainStatusChange, {readonly kind: '?'}> => change.kind === '?',
      ),
      change => normalizeRepositoryPath(change.path),
    ),
  );
  for (const path of untracked) {
    tracked.added.add(path);
    tracked.changed.add(path);
  }
  for (const change of changes) {
    if (change.kind !== 'U') continue;
    const path = normalizeRepositoryPath(change.path);
    tracked.changed.add(path);
    if (Effect2.pipe(change.status, EffectString.includes('A'))) tracked.added.add(path);
  }
  return {...tracked, untracked};
}

function graphNode(index: number): CodeGraphQueryNode {
  const id = `node-${index}`;
  return {
    contentHash: `hash-${index}`,
    exported: true,
    id,
    kind: 'function',
    language: 'typescript',
    name: id,
    path: `src/${id}.ts`,
    qualifiedName: id,
    score: 1,
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function graphEdges(nodeCount: number, rawEdges: readonly (readonly [number, number])[]): readonly CodeGraphEdge[] {
  const pairs = new Map<string, readonly [number, number]>();
  for (let index = 0; index < nodeCount; index += 1) {
    const pair = [index, (index + 1) % nodeCount] as const;
    pairs.set(
      EffectArray.join(
        EffectArray.map(pair, item => (item === null || item === undefined ? '' : String(item))),
        ':',
      ),
      pair,
    );
  }
  for (const [rawSource, rawTarget] of rawEdges) {
    const pair = [rawSource % nodeCount, rawTarget % nodeCount] as const;
    pairs.set(
      EffectArray.join(
        EffectArray.map(pair, item => (item === null || item === undefined ? '' : String(item))),
        ':',
      ),
      pair,
    );
  }
  return EffectArray.map([...pairs.values()], ([source, target]) => ({
    confidence: 1,
    evidencePath: `src/node-${source}.ts`,
    evidenceSpan: {column: 1, endColumn: 2, endLine: 1, line: 1},
    id: `edge-${source}-${target}`,
    provenance: 'resolved',
    relation: 'calls',
    sourceId: `node-${source}`,
    sourceName: `node-${source}`,
    targetId: `node-${target}`,
    targetName: `node-${target}`,
  }));
}

function graphStore(
  nodes: readonly CodeGraphQueryNode[],
  seed: CodeGraphQueryNode,
  edges: readonly CodeGraphEdge[],
): CodeGraphTraversalQueryStore {
  const byId = new Map(EffectArray.map(nodes, node => [node.id, node]));
  const edgesForNodes = (
    _databasePath: string,
    _snapshotId: string,
    ids: readonly string[],
    direction: 'both' | 'incoming' | 'outgoing',
    limit: number,
  ) =>
    Effect.succeed(
      EffectArray.filter(edges, edge => {
        if (direction === 'incoming') return edge.targetId !== undefined && ids.includes(edge.targetId);
        if (direction === 'outgoing') return edge.sourceId !== undefined && ids.includes(edge.sourceId);
        return (
          (edge.sourceId !== undefined && ids.includes(edge.sourceId)) ||
          (edge.targetId !== undefined && ids.includes(edge.targetId))
        );
      }).slice(0, limit),
    );
  return {
    edgesForNodes,
    findSymbolsByPathAndName: () => Effect.succeed([]),
    searchSymbolsByPaths: () => Effect.succeed([]),
    traversalEdgesForNodes: edgesForNodes,
    searchSymbolsMany: () => Effect.succeed([[seed]]),
    symbolsByIds: (_databasePath: string, _snapshotId: string, ids: readonly string[]) =>
      Effect.succeed(EffectArray.flatMap(ids, id => (byId.has(id) ? [byId.get(id)!] : []))),
  } satisfies CodeGraphTraversalQueryStore;
}

function referenceTraversal(
  seedId: string,
  edges: readonly CodeGraphEdge[],
  depth: number,
): {readonly edges: Set<string>; readonly nodes: Set<string>} {
  const visited = new Set([seedId]);
  const inspectedEdges = new Set<string>();
  let frontier = new Set([seedId]);
  for (let currentDepth = 0; currentDepth < depth && frontier.size > 0; currentDepth += 1) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (!edge.sourceId || !edge.targetId || !frontier.has(edge.sourceId)) continue;
      inspectedEdges.add(edge.id);
      if (!visited.has(edge.targetId)) {
        visited.add(edge.targetId);
        next.add(edge.targetId);
      }
    }
    frontier = next;
  }
  return {edges: inspectedEdges, nodes: visited};
}

function referenceNeighborReachability(
  seedId: string,
  edges: readonly CodeGraphEdge[],
  direction: 'both' | 'incoming' | 'outgoing',
  depth: number,
): ReadonlySet<string> {
  const visited = new Set([seedId]);
  let frontier = new Set([seedId]);
  for (let currentDepth = 0; currentDepth < depth && frontier.size > 0; currentDepth += 1) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (!edge.sourceId || !edge.targetId) continue;
      if (
        (direction === 'outgoing' || direction === 'both') &&
        frontier.has(edge.sourceId) &&
        !visited.has(edge.targetId)
      ) {
        next.add(edge.targetId);
      }
      if (
        (direction === 'incoming' || direction === 'both') &&
        frontier.has(edge.targetId) &&
        !visited.has(edge.sourceId)
      ) {
        next.add(edge.sourceId);
      }
    }
    for (const nodeId of next) visited.add(nodeId);
    frontier = next;
  }
  return visited;
}
