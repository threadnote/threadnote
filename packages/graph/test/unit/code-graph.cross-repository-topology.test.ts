import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import * as FC from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {CodeGraphCrossRepositoryBridgeV1} from '@threadnote/graph/cross_repository/resolver';
import {
  projectCodeGraphCrossRepositoryTopology,
  type CodeGraphCrossRepositoryTopologyRepositoryV1,
} from '@threadnote/graph/cross_repository/topology';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const generationId = `cgwg_${Effect.pipe(sha256HexSync('topology-generation'), EffectString.slice(0, 40))}`;
const span = {column: 1, endColumn: 12, endLine: 1, line: 1} as const;

describe('cross-repository topology projection', () => {
  it('aggregates repository contracts, adds authoritative package components, and retains isolated members', () => {
    const fixture = representativeFixture();

    const result = projectCodeGraphCrossRepositoryTopology({
      bridgeSet: bridgeSet(fixture.bridges),
      budgets: {maxEdges: 16, maxEvidence: 32, maxEvidencePerEdge: 8, maxNodes: 16},
      repositories: fixture.repositories,
    });

    expect(result.receipt).toMatchObject({
      complete: true,
      generationId,
      repositoryCount: 4,
      totalBridges: 3,
      version: 1,
      worksetName: 'product-suite',
    });
    expect(EffectArray.filter(result.nodes, node => node.kind === 'repository')).toHaveLength(4);
    expect(EffectArray.filter(result.nodes, node => node.kind === 'component')).toHaveLength(2);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.nodes, node => node.repositoryKey === 'tools/isolated')),
    ).toMatchObject({
      incidentBridgeCount: 0,
      kind: 'repository',
    });
    const repositoryEdges = EffectArray.filter(result.edges, edge => edge.granularity === 'repository');
    const componentEdges = EffectArray.filter(result.edges, edge => edge.granularity === 'component');
    expect(EffectArray.map(repositoryEdges, edge => edge.bridgeCount).sort((left, right) => right - left)).toEqual([
      2, 1,
    ]);
    expect(componentEdges).toHaveLength(1);
    expect(componentEdges[0]).toMatchObject({
      bridgeCount: 2,
      edgeClass: 'declared-cross-repository-contract',
      evidence: {omittedCount: 0, returnedCount: 2, totalCount: 2, truncated: false},
      kinds: [{count: 2, value: 'package'}],
      provenance: {declared: 2, heuristic: 0, resolved: 0, syntactic: 0},
      relations: [{count: 2, value: 'depends_on'}],
      resolutionDomains: [{count: 2, value: 'package:npm'}],
    });
    expect(componentEdges[0].evidence.items[0]).toEqual(
      expect.objectContaining({
        source: expect.objectContaining({monikerId: expect.stringMatching(/^cgm_/u), path: expect.any(String), span}),
        target: expect.objectContaining({monikerId: expect.stringMatching(/^cgm_/u), path: expect.any(String), span}),
      }),
    );
    expect(EffectRecord.keys(componentEdges[0].evidence.items[0].source).sort()).toEqual(['monikerId', 'path', 'span']);
    expect(result.coverage).toMatchObject({
      bridges: {
        componentEligible: 2,
        componentOmitted: 0,
        componentRepresented: 2,
        input: 3,
        repositoryOmitted: 0,
        repositoryRepresented: 3,
      },
      complete: true,
      evidenceComplete: true,
      structureComplete: true,
      truncation: {reasons: [], truncated: false},
    });
    expect(EffectArray.every(result.nodes, node => /^cgtn_[0-9a-f]{64}$/u.test(node.id))).toBe(true);
    expect(EffectArray.every(result.edges, edge => /^cgte_[0-9a-f]{64}$/u.test(edge.id))).toBe(true);
  });

  it('reports exactly what node and evidence truncation omitted', () => {
    const fixture = representativeFixture();

    const result = projectCodeGraphCrossRepositoryTopology({
      bridgeSet: bridgeSet(fixture.bridges),
      budgets: {maxEdges: 1, maxEvidence: 1, maxEvidencePerEdge: 1, maxNodes: 2},
      repositories: fixture.repositories,
    });

    expect(EffectArray.map(result.nodes, node => node.repositoryKey)).toEqual(['apps/gateway', 'packages/shared']);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      bridgeCount: 2,
      evidence: {omittedCount: 1, returnedCount: 1, totalCount: 2, truncated: true},
      granularity: 'repository',
    });
    expect(result.coverage).toMatchObject({
      bridges: {
        componentEligible: 2,
        componentOmitted: 2,
        componentRepresented: 0,
        input: 3,
        repositoryOmitted: 1,
        repositoryRepresented: 2,
      },
      complete: false,
      edges: {candidate: 3, omittedByEdgeLimit: 0, omittedByNodeLimit: 2, returned: 1},
      evidence: {
        candidateOccurrences: 5,
        omittedByEvidenceBudget: 1,
        omittedByTopology: 3,
        returned: 1,
      },
      evidenceComplete: false,
      nodes: {candidate: 6, omitted: 4, returned: 2},
      structureComplete: false,
      truncation: {reasons: ['node-limit', 'evidence-per-edge-limit'], truncated: true},
    });
    expect(result.receipt.complete).toBe(false);
  });

  it('fails closed for partial pages and bridges outside the generation snapshot set', () => {
    const fixture = representativeFixture();
    expect(() =>
      projectCodeGraphCrossRepositoryTopology({
        bridgeSet: {...bridgeSet(fixture.bridges), totalBridges: fixture.bridges.length + 1},
        repositories: fixture.repositories,
      }),
    ).toThrow('complete bridge set');

    expect(() =>
      projectCodeGraphCrossRepositoryTopology({
        bridgeSet: bridgeSet(fixture.bridges),
        repositories: EffectArray.map(fixture.repositories, (repository, index) =>
          index === 0 ? {...repository, snapshotId: 'replacement-snapshot'} : repository,
        ),
      }),
    ).toThrow('generation repository snapshot');
  });

  fcProp(
    effectIt,
    'is invariant under complete bridge and repository permutations',
    {
      bridgeOrder: FC.shuffledSubarray([0, 1, 2], {maxLength: 3, minLength: 3}),
      repositoryOrder: FC.shuffledSubarray([0, 1, 2, 3], {maxLength: 4, minLength: 4}),
    },
    ({bridgeOrder, repositoryOrder}) => {
      const fixture = representativeFixture();
      const baseline = projectCodeGraphCrossRepositoryTopology({
        bridgeSet: bridgeSet(fixture.bridges),
        budgets: {maxEdges: 16, maxEvidence: 32, maxEvidencePerEdge: 8, maxNodes: 16},
        repositories: fixture.repositories,
      });
      const bridges = EffectArray.map(bridgeOrder, index => fixture.bridges[index]);
      const repositories = EffectArray.map(repositoryOrder, index => fixture.repositories[index]);

      expect(
        projectCodeGraphCrossRepositoryTopology({
          bridgeSet: bridgeSet(bridges),
          budgets: {maxEdges: 16, maxEvidence: 32, maxEvidencePerEdge: 8, maxNodes: 16},
          repositories,
        }),
      ).toEqual(baseline);
    },
    {fastCheck: {numRuns: 60}},
  );

  fcProp(
    effectIt,
    'truncates deterministically for bounded node, edge, and evidence budgets',
    {
      maxEdges: FC.integer({max: 3, min: 0}),
      maxEvidence: FC.integer({max: 5, min: 0}),
      maxEvidencePerEdge: FC.integer({max: 3, min: 0}),
      maxNodes: FC.integer({max: 6, min: 0}),
      reverseBridges: FC.boolean(),
      reverseRepositories: FC.boolean(),
    },
    ({maxEdges, maxEvidence, maxEvidencePerEdge, maxNodes, reverseBridges, reverseRepositories}) => {
      const fixture = representativeFixture();
      const budgets = {maxEdges, maxEvidence, maxEvidencePerEdge, maxNodes};
      const baseline = projectCodeGraphCrossRepositoryTopology({
        bridgeSet: bridgeSet(fixture.bridges),
        budgets,
        repositories: fixture.repositories,
      });
      const bridges = reverseBridges ? [...fixture.bridges].reverse() : fixture.bridges;
      const repositories = reverseRepositories ? [...fixture.repositories].reverse() : fixture.repositories;
      const repeated = projectCodeGraphCrossRepositoryTopology({
        bridgeSet: bridgeSet(bridges),
        budgets,
        repositories,
      });

      expect(repeated).toEqual(baseline);
      expect(repeated.nodes.length).toBeLessThanOrEqual(maxNodes);
      expect(repeated.edges.length).toBeLessThanOrEqual(maxEdges);
      expect(repeated.coverage.evidence.returned).toBeLessThanOrEqual(maxEvidence);
      expect(EffectArray.every(repeated.edges, edge => edge.evidence.returnedCount <= maxEvidencePerEdge)).toBe(true);
      const nodeIds = new Set(EffectArray.map(repeated.nodes, node => node.id));
      expect(
        EffectArray.every(repeated.edges, edge => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)),
      ).toBe(true);
    },
    {fastCheck: {numRuns: 80}},
  );

  fcProp(
    effectIt,
    'conserves every bridge in repository aggregates and every package bridge in component aggregates',
    {
      packageCount: FC.integer({max: 12, min: 1}),
      protobufCount: FC.integer({max: 12, min: 0}),
    },
    ({packageCount, protobufCount}) => {
      const consumer = repository('property-consumer', 'apps/consumer');
      const producer = repository('property-producer', 'packages/producer');
      const packageBridges = Array.from({length: packageCount}, (_, index) =>
        packageBridge(`property-package-${index}`, consumer, producer),
      );
      const protobufBridges = Array.from({length: protobufCount}, (_, index) =>
        protobufBridge(`property-protobuf-${index}`, consumer, producer),
      );
      const bridges = [...packageBridges, ...protobufBridges];
      const result = projectCodeGraphCrossRepositoryTopology({
        bridgeSet: bridgeSet(bridges),
        budgets: {maxEdges: 8, maxEvidence: 128, maxEvidencePerEdge: 32, maxNodes: 8},
        repositories: [consumer, producer],
      });
      const repositoryEdges = EffectArray.filter(result.edges, edge => edge.granularity === 'repository');
      const componentEdges = EffectArray.filter(result.edges, edge => edge.granularity === 'component');

      expect(sum(EffectArray.map(repositoryEdges, edge => edge.bridgeCount))).toBe(bridges.length);
      expect(sum(EffectArray.map(componentEdges, edge => edge.bridgeCount))).toBe(packageCount);
      for (const edge of result.edges) {
        expect(sum(EffectArray.map(edge.kinds, entry => entry.count))).toBe(edge.bridgeCount);
        expect(sum(EffectArray.map(edge.relations, entry => entry.count))).toBe(edge.bridgeCount);
        expect(sum(EffectArray.map(edge.resolutionDomains, entry => entry.count))).toBe(edge.bridgeCount);
        expect(sum(EffectArray.map(edge.resolverReasons, entry => entry.count))).toBe(edge.bridgeCount);
        expect(sum(EffectRecord.values(edge.provenance))).toBe(edge.bridgeCount);
      }
      expect(result.coverage.bridges).toEqual({
        componentEligible: packageCount,
        componentOmitted: 0,
        componentRepresented: packageCount,
        input: bridges.length,
        repositoryOmitted: 0,
        repositoryRepresented: bridges.length,
      });
      expect(result.coverage.complete).toBe(true);
    },
    {fastCheck: {numRuns: 80}},
  );
});

function representativeFixture(): {
  readonly bridges: readonly CodeGraphCrossRepositoryBridgeV1[];
  readonly repositories: readonly CodeGraphCrossRepositoryTopologyRepositoryV1[];
} {
  const consumer = repository('gateway', 'apps/gateway');
  const producer = repository('shared', 'packages/shared');
  const schema = repository('schema', 'contracts/schema');
  const isolated = repository('isolated', 'tools/isolated');
  return {
    bridges: [
      packageBridge('shared-runtime', consumer, producer),
      packageBridge('shared-logging', consumer, producer),
      protobufBridge('orders-contract', consumer, schema, 'package'),
    ],
    repositories: [schema, isolated, producer, consumer],
  };
}

function bridgeSet(bridges: readonly CodeGraphCrossRepositoryBridgeV1[]) {
  return {
    bridgeSetDigest: sha256HexSync(
      EffectArray.join(['topology-bridge-set', ...EffectArray.map([...bridges], bridge => bridge.id).sort()], '\n'),
    ),
    bridges,
    generationId,
    resolverVersion: 1 as const,
    totalBridges: bridges.length,
    worksetName: 'product-suite',
  };
}

function repository(seed: string, repositoryKey: string): CodeGraphCrossRepositoryTopologyRepositoryV1 {
  return {
    repositoryId: sha256HexSync(`repository:${seed}`),
    repositoryKey,
    snapshotId: `snapshot-${seed}`,
  };
}

function packageBridge(
  seed: string,
  sourceRepository: CodeGraphCrossRepositoryTopologyRepositoryV1,
  targetRepository: CodeGraphCrossRepositoryTopologyRepositoryV1,
): CodeGraphCrossRepositoryBridgeV1 {
  const identity = `package:npm:@acme/${seed}`;
  return {
    confidence: 1,
    id: `cgb_${sha256HexSync(`bridge:${seed}`)}`,
    identity,
    kind: 'package',
    provenance: 'declared',
    relation: 'depends_on',
    resolutionDomain: 'package:npm',
    resolver: {name: 'threadnote-native-moniker', reason: 'declared-npm-package-compatible', version: 1},
    source: endpoint(seed, 'import', sourceRepository, identity, {
      componentId: `cgp_${Effect.pipe(sha256HexSync(`component:${sourceRepository.repositoryId}`), EffectString.slice(0, 32))}`,
      kind: 'component',
    }),
    target: endpoint(seed, 'export', targetRepository, identity, {
      componentId: `cgp_${Effect.pipe(sha256HexSync(`component:${targetRepository.repositoryId}`), EffectString.slice(0, 32))}`,
      kind: 'component',
    }),
    version: 1,
  };
}

function protobufBridge(
  seed: string,
  sourceRepository: CodeGraphCrossRepositoryTopologyRepositoryV1,
  targetRepository: CodeGraphCrossRepositoryTopologyRepositoryV1,
  kind: 'file' | 'message' | 'package' | 'rpc' | 'service' = 'service',
): CodeGraphCrossRepositoryBridgeV1 {
  const identity = `protobuf:${kind}:acme.${seed}`;
  return {
    confidence: 1,
    id: `cgb_${sha256HexSync(`bridge:${seed}`)}`,
    identity,
    kind,
    provenance: 'declared',
    relation: 'imports',
    resolutionDomain: 'protobuf',
    resolver: {name: 'threadnote-native-moniker', reason: 'exact-protobuf-identity', version: 1},
    source: endpoint(seed, 'import', sourceRepository, identity, {
      kind: 'qualified-ref',
      ref: `cgr_${Effect.pipe(sha256HexSync(`source-ref:${seed}`), EffectString.slice(0, 40))}`,
    }),
    target: endpoint(seed, 'export', targetRepository, identity, {
      kind: 'qualified-ref',
      ref: `cgr_${Effect.pipe(sha256HexSync(`target-ref:${seed}`), EffectString.slice(0, 40))}`,
    }),
    version: 1,
  };
}

function endpoint(
  seed: string,
  role: 'export' | 'import',
  repositoryValue: CodeGraphCrossRepositoryTopologyRepositoryV1,
  identity: string,
  reference: CodeGraphCrossRepositoryBridgeV1['source']['reference'],
): CodeGraphCrossRepositoryBridgeV1['source'] {
  return {
    evidence: {path: `${role}/${seed}.contract`, span},
    identity,
    monikerId: `cgm_${sha256HexSync(`moniker:${role}:${seed}`)}`,
    reference,
    ...repositoryValue,
    role,
  };
}

function sum(values: readonly number[]): number {
  return EffectArray.reduce(values, 0, (total, value) => total + value);
}
