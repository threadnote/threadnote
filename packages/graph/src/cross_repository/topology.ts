import {Array as EffectArray} from 'effect';
import {isReadonlyArray} from '@threadnote/platform/readonly-array';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {compareCodeUnits} from '../ordering.js';
import {CODE_GRAPH_WORKSET_CATALOG_LIMITS} from '../workset_catalog/types.js';
import {
  CODE_GRAPH_CROSS_REPOSITORY_BRIDGE_VERSION,
  CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION,
  type CodeGraphBridgeEndpointV1,
  type CodeGraphCrossRepositoryBridgeReasonV1,
  type CodeGraphCrossRepositoryBridgeV1,
} from './resolver.js';
import type {CodeGraphMonikerV1} from './types.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const CODE_GRAPH_CROSS_REPOSITORY_TOPOLOGY_VERSION = 1 as const;

const GENERATION_ID = /^cgwg_[0-9a-f]{40}$/u;
const BRIDGE_ID = /^cgb_[0-9a-f]{64}$/u;
const BRIDGE_SET_DIGEST = /^[0-9a-f]{64}$/u;
const MONIKER_ID = /^cgm_[0-9a-f]{64}$/u;
const REPOSITORY_ID = /^[0-9a-f]{64}$/u;
const COMPONENT_ID = /^cgp_[0-9a-f]{32}$/u;
const QUALIFIED_REF = /^cgr_[0-9a-f]{40}$/u;
const MAX_REPOSITORY_KEY_BYTES = 4_096;
const MAX_SNAPSHOT_ID_BYTES = 256;
const MAX_WORKSET_NAME_BYTES = 256;

const DEFAULT_MAX_NODES = 128;
const DEFAULT_MAX_EDGES = 256;
const DEFAULT_MAX_EVIDENCE = 128;
const DEFAULT_MAX_EVIDENCE_PER_EDGE = 4;
const MAX_NODES = 16_384;
const MAX_EDGES = 16_384;
const MAX_EVIDENCE = 8_192;
const MAX_EVIDENCE_PER_EDGE = 32;

export interface CodeGraphCrossRepositoryTopologyRepositoryV1 {
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly snapshotId: string;
}

/**
 * A complete, generation-bound bridge set. Callers must assemble every bridge
 * page before projection; accepting a partial page would make an incomplete
 * topology look authoritative.
 */
export interface CodeGraphCrossRepositoryTopologyBridgeSetV1 {
  readonly bridgeSetDigest: string;
  readonly bridges: readonly CodeGraphCrossRepositoryBridgeV1[];
  readonly generationId: string;
  readonly resolverVersion: typeof CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION;
  readonly totalBridges: number;
  readonly worksetName: string;
}

export interface CodeGraphCrossRepositoryTopologyBudgetsV1 {
  readonly maxEdges?: number;
  readonly maxEvidence?: number;
  readonly maxEvidencePerEdge?: number;
  readonly maxNodes?: number;
}

export interface CodeGraphCrossRepositoryTopologyBudgetReceiptV1 {
  readonly maxEdges: number;
  readonly maxEvidence: number;
  readonly maxEvidencePerEdge: number;
  readonly maxNodes: number;
}

interface CodeGraphCrossRepositoryTopologyNodeBaseV1 {
  readonly generationId: string;
  readonly id: string;
  readonly incidentBridgeCount: number;
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly snapshotId: string;
}

export interface CodeGraphCrossRepositoryTopologyRepositoryNodeV1 extends CodeGraphCrossRepositoryTopologyNodeBaseV1 {
  readonly kind: 'repository';
}

export interface CodeGraphCrossRepositoryTopologyComponentNodeV1 extends CodeGraphCrossRepositoryTopologyNodeBaseV1 {
  readonly componentId: string;
  readonly componentKind: 'package';
  readonly kind: 'component';
  readonly packageIdentities: readonly string[];
}

export type CodeGraphCrossRepositoryTopologyNodeV1 =
  CodeGraphCrossRepositoryTopologyRepositoryNodeV1 | CodeGraphCrossRepositoryTopologyComponentNodeV1;

export interface CodeGraphCrossRepositoryTopologyCountV1 {
  readonly count: number;
  readonly value: string;
}

export interface CodeGraphCrossRepositoryTopologyProvenanceCountsV1 {
  readonly declared: number;
  readonly heuristic: number;
  readonly resolved: number;
  readonly syntactic: number;
}

export interface CodeGraphCrossRepositoryTopologyEvidenceEndpointV1 {
  readonly monikerId: string;
  readonly path: string;
  readonly span: CodeGraphBridgeEndpointV1['evidence']['span'];
}

export interface CodeGraphCrossRepositoryTopologyEvidenceV1 {
  readonly bridgeId: string;
  readonly confidence: 1;
  readonly identity: string;
  readonly kind: CodeGraphMonikerV1['kind'];
  readonly provenance: 'declared';
  readonly relation: CodeGraphCrossRepositoryBridgeV1['relation'];
  readonly resolutionDomain: CodeGraphMonikerV1['resolutionDomain'];
  readonly resolver: {
    readonly reason: CodeGraphCrossRepositoryBridgeReasonV1;
    readonly version: typeof CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION;
  };
  readonly source: CodeGraphCrossRepositoryTopologyEvidenceEndpointV1;
  readonly target: CodeGraphCrossRepositoryTopologyEvidenceEndpointV1;
}

export interface CodeGraphCrossRepositoryTopologyEdgeV1 {
  readonly bridgeCount: number;
  readonly edgeClass: 'declared-cross-repository-contract';
  readonly evidence: {
    readonly items: readonly CodeGraphCrossRepositoryTopologyEvidenceV1[];
    readonly omittedCount: number;
    readonly returnedCount: number;
    readonly totalCount: number;
    readonly truncated: boolean;
  };
  readonly generationId: string;
  readonly granularity: 'component' | 'repository';
  readonly id: string;
  readonly kinds: readonly CodeGraphCrossRepositoryTopologyCountV1[];
  readonly provenance: CodeGraphCrossRepositoryTopologyProvenanceCountsV1;
  readonly relations: readonly CodeGraphCrossRepositoryTopologyCountV1[];
  readonly resolutionDomains: readonly CodeGraphCrossRepositoryTopologyCountV1[];
  readonly resolverReasons: readonly CodeGraphCrossRepositoryTopologyCountV1[];
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
}

export type CodeGraphCrossRepositoryTopologyTruncationReasonV1 =
  'edge-limit' | 'evidence-limit' | 'evidence-per-edge-limit' | 'node-limit';

export interface CodeGraphCrossRepositoryTopologyCoverageV1 {
  readonly bridges: {
    readonly componentEligible: number;
    readonly componentOmitted: number;
    readonly componentRepresented: number;
    readonly input: number;
    readonly repositoryOmitted: number;
    readonly repositoryRepresented: number;
  };
  readonly budgets: CodeGraphCrossRepositoryTopologyBudgetReceiptV1;
  readonly complete: boolean;
  readonly edges: {
    readonly candidate: number;
    readonly componentCandidate: number;
    readonly omittedByEdgeLimit: number;
    readonly omittedByNodeLimit: number;
    readonly repositoryCandidate: number;
    readonly returned: number;
  };
  readonly evidence: {
    readonly candidateOccurrences: number;
    readonly omittedByTopology: number;
    readonly omittedByEvidenceBudget: number;
    readonly returned: number;
  };
  readonly evidenceComplete: boolean;
  readonly nodes: {
    readonly candidate: number;
    readonly componentCandidate: number;
    readonly omitted: number;
    readonly repositoryCandidate: number;
    readonly returned: number;
  };
  readonly structureComplete: boolean;
  readonly truncation: {
    readonly reasons: readonly CodeGraphCrossRepositoryTopologyTruncationReasonV1[];
    readonly truncated: boolean;
  };
}

export interface CodeGraphCrossRepositoryTopologyReceiptV1 {
  readonly bridgeSetDigest: string;
  readonly complete: boolean;
  readonly generationId: string;
  readonly repositoryCount: number;
  readonly resolverVersion: typeof CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION;
  readonly totalBridges: number;
  readonly version: typeof CODE_GRAPH_CROSS_REPOSITORY_TOPOLOGY_VERSION;
  readonly worksetName: string;
}

export interface CodeGraphCrossRepositoryTopologyV1 {
  readonly coverage: CodeGraphCrossRepositoryTopologyCoverageV1;
  readonly edges: readonly CodeGraphCrossRepositoryTopologyEdgeV1[];
  readonly nodes: readonly CodeGraphCrossRepositoryTopologyNodeV1[];
  readonly receipt: CodeGraphCrossRepositoryTopologyReceiptV1;
  readonly version: typeof CODE_GRAPH_CROSS_REPOSITORY_TOPOLOGY_VERSION;
}

interface MutableRepositoryNode {
  incidentBridgeCount: number;
  readonly generationId: string;
  readonly id: string;
  readonly kind: 'repository';
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly snapshotId: string;
}

interface MutableComponentNode {
  readonly componentId: string;
  readonly componentKind: 'package';
  readonly generationId: string;
  readonly id: string;
  incidentBridgeCount: number;
  readonly kind: 'component';
  readonly packageIdentities: Set<string>;
  readonly repositoryId: string;
  readonly repositoryKey: string;
  readonly snapshotId: string;
}

interface MutableAggregate {
  readonly bridges: CodeGraphCrossRepositoryBridgeV1[];
  readonly granularity: 'component' | 'repository';
  readonly id: string;
  readonly source: CodeGraphCrossRepositoryTopologyNodeV1;
  readonly target: CodeGraphCrossRepositoryTopologyNodeV1;
}

interface PreparedInput {
  readonly bridgeSet: Omit<CodeGraphCrossRepositoryTopologyBridgeSetV1, 'bridges'> & {
    readonly bridges: readonly CodeGraphCrossRepositoryBridgeV1[];
  };
  readonly budgets: CodeGraphCrossRepositoryTopologyBudgetReceiptV1;
  readonly repositories: readonly CodeGraphCrossRepositoryTopologyRepositoryV1[];
}

/**
 * Project one complete bridge generation into a deterministic bounded topology.
 * Repository nodes cover every supplied generation member, including isolated
 * members. Package component nodes are emitted only when both bridge endpoints
 * carry authoritative component identities. No source body is accepted or
 * returned; bounded evidence consists solely of declaration paths and spans.
 */
export function projectCodeGraphCrossRepositoryTopology(input: {
  readonly bridgeSet: CodeGraphCrossRepositoryTopologyBridgeSetV1;
  readonly budgets?: CodeGraphCrossRepositoryTopologyBudgetsV1;
  readonly repositories: readonly CodeGraphCrossRepositoryTopologyRepositoryV1[];
}): CodeGraphCrossRepositoryTopologyV1 {
  const prepared = prepareInput(input);
  const repositoryNodes = new Map<string, MutableRepositoryNode>();
  const componentNodes = new Map<string, MutableComponentNode>();

  for (const repository of prepared.repositories) {
    const id = topologyNodeId(prepared.bridgeSet.generationId, 'repository', repository);
    repositoryNodes.set(repositorySnapshotKey(repository), {
      generationId: prepared.bridgeSet.generationId,
      id,
      incidentBridgeCount: 0,
      kind: 'repository',
      ...repository,
    });
  }

  for (const bridge of prepared.bridgeSet.bridges) {
    const sourceRepository = repositoryNodes.get(repositorySnapshotKey(bridge.source))!;
    const targetRepository = repositoryNodes.get(repositorySnapshotKey(bridge.target))!;
    sourceRepository.incidentBridgeCount += 1;
    targetRepository.incidentBridgeCount += 1;
    registerComponentNode(componentNodes, prepared.bridgeSet.generationId, bridge, bridge.source);
    registerComponentNode(componentNodes, prepared.bridgeSet.generationId, bridge, bridge.target);
  }

  const allNodes: CodeGraphCrossRepositoryTopologyNodeV1[] = [
    ...EffectArray.map([...repositoryNodes.values()], finalizeRepositoryNode),
    ...EffectArray.map([...componentNodes.values()], finalizeComponentNode),
  ].sort(compareTopologyNodes);
  const selectedNodeIds = new Set(
    EffectArray.map(
      [...allNodes].sort(compareNodeSelectionPriority).slice(0, prepared.budgets.maxNodes),
      node => node.id,
    ),
  );
  const nodes = EffectArray.filter(
    allNodes,
    (node, __effectArrayIndex) => __effectArrayIndex in allNodes && selectedNodeIds.has(node.id),
  );
  const nodeById = new Map(EffectArray.map(allNodes, node => [node.id, node] as const));
  const aggregates = buildAggregates(prepared.bridgeSet.generationId, prepared.bridgeSet.bridges, nodeById);
  const nodeEligibleAggregates = EffectArray.filter(
    aggregates,
    (aggregate, __effectArrayIndex) =>
      __effectArrayIndex in aggregates &&
      selectedNodeIds.has(aggregate.source.id) &&
      selectedNodeIds.has(aggregate.target.id),
  );
  const selectedAggregates = [...nodeEligibleAggregates]
    .sort(compareAggregateSelectionPriority)
    .slice(0, prepared.budgets.maxEdges)
    .sort(compareAggregates);
  const evidenceAllocations = allocateEvidence(selectedAggregates, prepared.budgets);
  const edges = EffectArray.map(selectedAggregates, aggregate =>
    finalizeEdge(prepared.bridgeSet.generationId, aggregate, evidenceAllocations.get(aggregate.id) ?? []),
  );

  const repositoryCandidateEdges = EffectArray.filter(aggregates, aggregate => aggregate.granularity === 'repository');
  const componentCandidateEdges = EffectArray.filter(aggregates, aggregate => aggregate.granularity === 'component');
  const selectedRepositoryEdges = EffectArray.filter(
    selectedAggregates,
    aggregate => aggregate.granularity === 'repository',
  );
  const selectedComponentEdges = EffectArray.filter(
    selectedAggregates,
    aggregate => aggregate.granularity === 'component',
  );
  const componentEligible = sumBridgeCounts(componentCandidateEdges);
  const repositoryRepresented = sumBridgeCounts(selectedRepositoryEdges);
  const componentRepresented = sumBridgeCounts(selectedComponentEdges);
  const candidateEvidenceOccurrences = sumBridgeCounts(aggregates);
  const evidenceOnReturnedEdges = sumBridgeCounts(selectedAggregates);
  const returnedEvidence = EffectArray.reduce(
    [...evidenceAllocations.values()],
    0,
    (total, values) => total + values.length,
  );
  const omittedNodes = allNodes.length - nodes.length;
  const omittedEdgesByNodes = aggregates.length - nodeEligibleAggregates.length;
  const omittedEdgesByLimit = nodeEligibleAggregates.length - selectedAggregates.length;
  const evidencePerEdgeLimited = EffectArray.some(
    selectedAggregates,
    aggregate => aggregate.bridges.length > prepared.budgets.maxEvidencePerEdge,
  );
  const evidenceGloballyLimited =
    returnedEvidence < evidenceOnReturnedEdges &&
    EffectArray.some(
      selectedAggregates,
      aggregate =>
        (evidenceAllocations.get(aggregate.id)?.length ?? 0) <
        Math.min(aggregate.bridges.length, prepared.budgets.maxEvidencePerEdge),
    );
  const reasons: CodeGraphCrossRepositoryTopologyTruncationReasonV1[] = [];
  if (omittedNodes > 0) reasons.push('node-limit');
  if (omittedEdgesByLimit > 0) reasons.push('edge-limit');
  if (evidenceGloballyLimited) reasons.push('evidence-limit');
  if (evidencePerEdgeLimited) reasons.push('evidence-per-edge-limit');
  const structureComplete = omittedNodes === 0 && omittedEdgesByNodes === 0 && omittedEdgesByLimit === 0;
  const evidenceComplete = returnedEvidence === candidateEvidenceOccurrences;
  const complete = structureComplete && evidenceComplete;
  const coverage: CodeGraphCrossRepositoryTopologyCoverageV1 = {
    bridges: {
      componentEligible,
      componentOmitted: componentEligible - componentRepresented,
      componentRepresented,
      input: prepared.bridgeSet.bridges.length,
      repositoryOmitted: prepared.bridgeSet.bridges.length - repositoryRepresented,
      repositoryRepresented,
    },
    budgets: prepared.budgets,
    complete,
    edges: {
      candidate: aggregates.length,
      componentCandidate: componentCandidateEdges.length,
      omittedByEdgeLimit: omittedEdgesByLimit,
      omittedByNodeLimit: omittedEdgesByNodes,
      repositoryCandidate: repositoryCandidateEdges.length,
      returned: edges.length,
    },
    evidence: {
      candidateOccurrences: candidateEvidenceOccurrences,
      omittedByEvidenceBudget: evidenceOnReturnedEdges - returnedEvidence,
      omittedByTopology: candidateEvidenceOccurrences - evidenceOnReturnedEdges,
      returned: returnedEvidence,
    },
    evidenceComplete,
    nodes: {
      candidate: allNodes.length,
      componentCandidate: componentNodes.size,
      omitted: omittedNodes,
      repositoryCandidate: repositoryNodes.size,
      returned: nodes.length,
    },
    structureComplete,
    truncation: {reasons, truncated: reasons.length > 0},
  };

  return {
    coverage,
    edges,
    nodes,
    receipt: {
      bridgeSetDigest: prepared.bridgeSet.bridgeSetDigest,
      complete,
      generationId: prepared.bridgeSet.generationId,
      repositoryCount: prepared.repositories.length,
      resolverVersion: prepared.bridgeSet.resolverVersion,
      totalBridges: prepared.bridgeSet.totalBridges,
      version: CODE_GRAPH_CROSS_REPOSITORY_TOPOLOGY_VERSION,
      worksetName: prepared.bridgeSet.worksetName,
    },
    version: CODE_GRAPH_CROSS_REPOSITORY_TOPOLOGY_VERSION,
  };
}

function prepareInput(input: {
  readonly bridgeSet: CodeGraphCrossRepositoryTopologyBridgeSetV1;
  readonly budgets?: CodeGraphCrossRepositoryTopologyBudgetsV1;
  readonly repositories: readonly CodeGraphCrossRepositoryTopologyRepositoryV1[];
}): PreparedInput {
  if (typeof input !== 'object' || input === null) throw invalid('Topology input is required.');
  const bridgeSet = input.bridgeSet;
  if (typeof bridgeSet !== 'object' || bridgeSet === null) throw invalid('Topology bridge set is required.');
  if (!GENERATION_ID.test(bridgeSet.generationId)) throw invalid('Topology generation identity is invalid.');
  if (!BRIDGE_SET_DIGEST.test(bridgeSet.bridgeSetDigest)) throw invalid('Topology bridge-set digest is invalid.');
  if (bridgeSet.resolverVersion !== CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION) {
    throw invalid('Topology resolver version is unsupported.');
  }
  const worksetName = canonicalBoundedText(bridgeSet.worksetName, 'workset name', MAX_WORKSET_NAME_BYTES);
  if (
    !isReadonlyArray(input.repositories) ||
    input.repositories.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.membersPerGeneration
  ) {
    throw invalid('Topology repository scope exceeds the supported generation bound.');
  }
  if (
    !EffectArray.isArray(bridgeSet.bridges) ||
    bridgeSet.bridges.length > CODE_GRAPH_WORKSET_CATALOG_LIMITS.bridgesPerGeneration
  ) {
    throw invalid('Topology bridge set exceeds the supported generation bound.');
  }
  if (!Number.isSafeInteger(bridgeSet.totalBridges) || bridgeSet.totalBridges !== bridgeSet.bridges.length) {
    throw invalid('Topology projection requires the complete bridge set.');
  }

  const repositoryIds = new Set<string>();
  const repositoryKeys = new Set<string>();
  const repositories = EffectArray.map(input.repositories, repository => canonicalRepository(repository)).sort(
    compareRepositories,
  );
  const repositoryBySnapshot = new Map<string, CodeGraphCrossRepositoryTopologyRepositoryV1>();
  for (const repository of repositories) {
    if (repositoryIds.has(repository.repositoryId) || repositoryKeys.has(repository.repositoryKey)) {
      throw invalid('Topology generation repositories must be unique.');
    }
    repositoryIds.add(repository.repositoryId);
    repositoryKeys.add(repository.repositoryKey);
    repositoryBySnapshot.set(repositorySnapshotKey(repository), repository);
  }

  const bridgeIds = new Set<string>();
  const bridges = [...bridgeSet.bridges].sort((left, right) => compareCodeUnits(left.id, right.id));
  for (const bridge of bridges) {
    validateBridge(bridge, bridgeSet.resolverVersion);
    if (bridgeIds.has(bridge.id)) throw invalid('Topology bridge set contains a duplicate identity.');
    bridgeIds.add(bridge.id);
    for (const endpoint of [bridge.source, bridge.target]) {
      const member = repositoryBySnapshot.get(repositorySnapshotKey(endpoint));
      if (member === undefined || member.repositoryKey !== endpoint.repositoryKey) {
        throw invalid('Every topology bridge endpoint must match its generation repository snapshot.');
      }
    }
  }

  return {
    bridgeSet: {...bridgeSet, bridges, worksetName},
    budgets: {
      maxEdges: budget(input.budgets?.maxEdges, DEFAULT_MAX_EDGES, MAX_EDGES, 'edge'),
      maxEvidence: budget(input.budgets?.maxEvidence, DEFAULT_MAX_EVIDENCE, MAX_EVIDENCE, 'evidence'),
      maxEvidencePerEdge: budget(
        input.budgets?.maxEvidencePerEdge,
        DEFAULT_MAX_EVIDENCE_PER_EDGE,
        MAX_EVIDENCE_PER_EDGE,
        'per-edge evidence',
      ),
      maxNodes: budget(input.budgets?.maxNodes, DEFAULT_MAX_NODES, MAX_NODES, 'node'),
    },
    repositories,
  };
}

function canonicalRepository(
  repository: CodeGraphCrossRepositoryTopologyRepositoryV1,
): CodeGraphCrossRepositoryTopologyRepositoryV1 {
  if (typeof repository !== 'object' || repository === null || !REPOSITORY_ID.test(repository.repositoryId)) {
    throw invalid('Topology repository identity is invalid.');
  }
  return {
    repositoryId: repository.repositoryId,
    repositoryKey: canonicalBoundedText(repository.repositoryKey, 'repository key', MAX_REPOSITORY_KEY_BYTES),
    snapshotId: canonicalBoundedText(repository.snapshotId, 'snapshot identity', MAX_SNAPSHOT_ID_BYTES),
  };
}

function validateBridge(
  bridge: CodeGraphCrossRepositoryBridgeV1,
  resolverVersion: typeof CODE_GRAPH_CROSS_REPOSITORY_RESOLVER_VERSION,
): void {
  if (
    typeof bridge !== 'object' ||
    bridge === null ||
    bridge.version !== CODE_GRAPH_CROSS_REPOSITORY_BRIDGE_VERSION ||
    !BRIDGE_ID.test(bridge.id) ||
    bridge.confidence !== 1 ||
    bridge.provenance !== 'declared' ||
    bridge.resolver.name !== 'threadnote-native-moniker' ||
    bridge.resolver.version !== resolverVersion ||
    !bridge.identity ||
    bridge.source.identity !== bridge.identity ||
    bridge.target.identity !== bridge.identity ||
    bridge.source.role !== 'import' ||
    bridge.target.role !== 'export' ||
    bridge.source.repositoryId === bridge.target.repositoryId
  ) {
    throw invalid('Topology bridge is not a canonical cross-repository bridge.');
  }
  validateEndpoint(bridge.source);
  validateEndpoint(bridge.target);
  if (bridge.resolutionDomain === 'package:npm') {
    if (
      bridge.kind !== 'package' ||
      bridge.relation !== 'depends_on' ||
      bridge.resolver.reason !== 'declared-npm-package-compatible' ||
      bridge.source.reference.kind !== 'component' ||
      bridge.target.reference.kind !== 'component'
    ) {
      throw invalid('Topology package bridge is inconsistent.');
    }
  } else {
    if (
      !(['file', 'message', 'package', 'rpc', 'service'] as const).includes(bridge.kind) ||
      bridge.relation !== 'imports' ||
      bridge.resolutionDomain !== 'protobuf' ||
      bridge.resolver.reason !== 'exact-protobuf-identity' ||
      bridge.source.reference.kind !== 'qualified-ref' ||
      bridge.target.reference.kind !== 'qualified-ref'
    ) {
      throw invalid('Topology protobuf bridge is inconsistent.');
    }
  }
}

function validateEndpoint(endpoint: CodeGraphBridgeEndpointV1): void {
  if (
    !REPOSITORY_ID.test(endpoint.repositoryId) ||
    !MONIKER_ID.test(endpoint.monikerId) ||
    !endpoint.identity ||
    canonicalBoundedText(endpoint.repositoryKey, 'repository key', MAX_REPOSITORY_KEY_BYTES) !==
      endpoint.repositoryKey ||
    canonicalBoundedText(endpoint.snapshotId, 'snapshot identity', MAX_SNAPSHOT_ID_BYTES) !== endpoint.snapshotId ||
    !endpoint.evidence.path ||
    Effect.pipe(endpoint.evidence.path, EffectString.startsWith('/')) ||
    EffectArray.some(
      Effect.pipe(endpoint.evidence.path, EffectString.split('/')),
      segment => !segment || segment === '.' || segment === '..',
    )
  ) {
    throw invalid('Topology bridge endpoint is invalid.');
  }
  const span = endpoint.evidence.span;
  if (
    !EffectArray.every([span.line, span.column, span.endLine, span.endColumn], Number.isSafeInteger) ||
    span.line < 1 ||
    span.column < 1 ||
    span.endLine < span.line ||
    (span.endLine === span.line && span.endColumn < span.column)
  ) {
    throw invalid('Topology bridge evidence span is invalid.');
  }
  if (
    (endpoint.reference.kind === 'component' && !COMPONENT_ID.test(endpoint.reference.componentId)) ||
    (endpoint.reference.kind === 'qualified-ref' && !QUALIFIED_REF.test(endpoint.reference.ref))
  ) {
    throw invalid('Topology bridge endpoint reference is invalid.');
  }
}

function registerComponentNode(
  nodes: Map<string, MutableComponentNode>,
  generationId: string,
  bridge: CodeGraphCrossRepositoryBridgeV1,
  endpoint: CodeGraphBridgeEndpointV1,
): void {
  if (endpoint.reference.kind !== 'component') return;
  const key = componentSnapshotKey(endpoint, endpoint.reference.componentId);
  const existing = nodes.get(key);
  if (existing !== undefined) {
    existing.incidentBridgeCount += 1;
    existing.packageIdentities.add(bridge.identity);
    return;
  }
  const repository = {
    repositoryId: endpoint.repositoryId,
    repositoryKey: endpoint.repositoryKey,
    snapshotId: endpoint.snapshotId,
  };
  nodes.set(key, {
    componentId: endpoint.reference.componentId,
    componentKind: 'package',
    generationId,
    id: topologyNodeId(generationId, 'component', repository, endpoint.reference.componentId),
    incidentBridgeCount: 1,
    kind: 'component',
    packageIdentities: new Set([bridge.identity]),
    ...repository,
  });
}

function finalizeRepositoryNode(node: MutableRepositoryNode): CodeGraphCrossRepositoryTopologyRepositoryNodeV1 {
  return {...node};
}

function finalizeComponentNode(node: MutableComponentNode): CodeGraphCrossRepositoryTopologyComponentNodeV1 {
  return {...node, packageIdentities: [...node.packageIdentities].sort(compareCodeUnits)};
}

function buildAggregates(
  generationId: string,
  bridges: readonly CodeGraphCrossRepositoryBridgeV1[],
  nodeById: ReadonlyMap<string, CodeGraphCrossRepositoryTopologyNodeV1>,
): readonly MutableAggregate[] {
  const aggregates = new Map<string, MutableAggregate>();
  for (const bridge of bridges) {
    const sourceRepositoryId = topologyNodeId(generationId, 'repository', bridge.source);
    const targetRepositoryId = topologyNodeId(generationId, 'repository', bridge.target);
    addAggregate(aggregates, generationId, 'repository', sourceRepositoryId, targetRepositoryId, bridge, nodeById);
    if (bridge.source.reference.kind === 'component' && bridge.target.reference.kind === 'component') {
      const sourceComponentId = topologyNodeId(
        generationId,
        'component',
        bridge.source,
        bridge.source.reference.componentId,
      );
      const targetComponentId = topologyNodeId(
        generationId,
        'component',
        bridge.target,
        bridge.target.reference.componentId,
      );
      addAggregate(aggregates, generationId, 'component', sourceComponentId, targetComponentId, bridge, nodeById);
    }
  }
  return [...aggregates.values()].sort(compareAggregates);
}

function addAggregate(
  aggregates: Map<string, MutableAggregate>,
  generationId: string,
  granularity: 'component' | 'repository',
  sourceNodeId: string,
  targetNodeId: string,
  bridge: CodeGraphCrossRepositoryBridgeV1,
  nodeById: ReadonlyMap<string, CodeGraphCrossRepositoryTopologyNodeV1>,
): void {
  const id = topologyEdgeId(generationId, granularity, sourceNodeId, targetNodeId);
  const existing = aggregates.get(id);
  if (existing !== undefined) {
    existing.bridges.push(bridge);
    return;
  }
  const source = nodeById.get(sourceNodeId);
  const target = nodeById.get(targetNodeId);
  if (source === undefined || target === undefined) throw invalid('Topology aggregate endpoint is missing.');
  aggregates.set(id, {bridges: [bridge], granularity, id, source, target});
}

function allocateEvidence(
  aggregates: readonly MutableAggregate[],
  budgets: CodeGraphCrossRepositoryTopologyBudgetReceiptV1,
): ReadonlyMap<string, readonly CodeGraphCrossRepositoryBridgeV1[]> {
  const allocations = new Map<string, CodeGraphCrossRepositoryBridgeV1[]>();
  for (const aggregate of aggregates) allocations.set(aggregate.id, []);
  let allocated = 0;
  allocation: for (let ordinal = 0; ordinal < budgets.maxEvidencePerEdge; ordinal += 1) {
    for (const aggregate of aggregates) {
      if (allocated >= budgets.maxEvidence) break allocation;
      const bridge = aggregate.bridges[ordinal];
      if (bridge === undefined) continue;
      allocations.get(aggregate.id)!.push(bridge);
      allocated += 1;
    }
  }
  return allocations;
}

function finalizeEdge(
  generationId: string,
  aggregate: MutableAggregate,
  evidenceBridges: readonly CodeGraphCrossRepositoryBridgeV1[],
): CodeGraphCrossRepositoryTopologyEdgeV1 {
  const bridgeCount = aggregate.bridges.length;
  return {
    bridgeCount,
    edgeClass: 'declared-cross-repository-contract',
    evidence: {
      items: EffectArray.map(evidenceBridges, topologyEvidence),
      omittedCount: bridgeCount - evidenceBridges.length,
      returnedCount: evidenceBridges.length,
      totalCount: bridgeCount,
      truncated: evidenceBridges.length < bridgeCount,
    },
    generationId,
    granularity: aggregate.granularity,
    id: aggregate.id,
    kinds: countValues(EffectArray.map(aggregate.bridges, bridge => bridge.kind)),
    provenance: {declared: bridgeCount, heuristic: 0, resolved: 0, syntactic: 0},
    relations: countValues(EffectArray.map(aggregate.bridges, bridge => bridge.relation)),
    resolutionDomains: countValues(EffectArray.map(aggregate.bridges, bridge => bridge.resolutionDomain)),
    resolverReasons: countValues(EffectArray.map(aggregate.bridges, bridge => bridge.resolver.reason)),
    sourceNodeId: aggregate.source.id,
    targetNodeId: aggregate.target.id,
  };
}

function topologyEvidence(bridge: CodeGraphCrossRepositoryBridgeV1): CodeGraphCrossRepositoryTopologyEvidenceV1 {
  return {
    bridgeId: bridge.id,
    confidence: bridge.confidence,
    identity: bridge.identity,
    kind: bridge.kind,
    provenance: bridge.provenance,
    relation: bridge.relation,
    resolutionDomain: bridge.resolutionDomain,
    resolver: {reason: bridge.resolver.reason, version: bridge.resolver.version},
    source: evidenceEndpoint(bridge.source),
    target: evidenceEndpoint(bridge.target),
  };
}

function evidenceEndpoint(endpoint: CodeGraphBridgeEndpointV1): CodeGraphCrossRepositoryTopologyEvidenceEndpointV1 {
  return {
    monikerId: endpoint.monikerId,
    path: endpoint.evidence.path,
    span: endpoint.evidence.span,
  };
}

function countValues(values: readonly string[]): readonly CodeGraphCrossRepositoryTopologyCountV1[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return EffectArray.map(
    [...counts].sort(([left], [right]) => compareCodeUnits(left, right)),
    ([value, count]) => ({count, value}),
  );
}

function compareNodeSelectionPriority(
  left: CodeGraphCrossRepositoryTopologyNodeV1,
  right: CodeGraphCrossRepositoryTopologyNodeV1,
): number {
  return (
    nodeKindOrder(left.kind) - nodeKindOrder(right.kind) ||
    right.incidentBridgeCount - left.incidentBridgeCount ||
    compareTopologyNodes(left, right)
  );
}

function compareTopologyNodes(
  left: CodeGraphCrossRepositoryTopologyNodeV1,
  right: CodeGraphCrossRepositoryTopologyNodeV1,
): number {
  return (
    nodeKindOrder(left.kind) - nodeKindOrder(right.kind) ||
    compareCodeUnits(left.repositoryKey, right.repositoryKey) ||
    compareCodeUnits(left.repositoryId, right.repositoryId) ||
    compareCodeUnits(left.snapshotId, right.snapshotId) ||
    compareCodeUnits(
      left.kind === 'component' ? left.componentId : '',
      right.kind === 'component' ? right.componentId : '',
    ) ||
    compareCodeUnits(left.id, right.id)
  );
}

function compareAggregateSelectionPriority(left: MutableAggregate, right: MutableAggregate): number {
  return (
    granularityOrder(left.granularity) - granularityOrder(right.granularity) ||
    right.bridges.length - left.bridges.length ||
    compareAggregates(left, right)
  );
}

function compareAggregates(left: MutableAggregate, right: MutableAggregate): number {
  return (
    granularityOrder(left.granularity) - granularityOrder(right.granularity) ||
    compareTopologyNodes(left.source, right.source) ||
    compareTopologyNodes(left.target, right.target) ||
    compareCodeUnits(left.id, right.id)
  );
}

function compareRepositories(
  left: CodeGraphCrossRepositoryTopologyRepositoryV1,
  right: CodeGraphCrossRepositoryTopologyRepositoryV1,
): number {
  return (
    compareCodeUnits(left.repositoryKey, right.repositoryKey) ||
    compareCodeUnits(left.repositoryId, right.repositoryId) ||
    compareCodeUnits(left.snapshotId, right.snapshotId)
  );
}

function topologyNodeId(
  generationId: string,
  kind: 'component' | 'repository',
  repository: Pick<CodeGraphCrossRepositoryTopologyRepositoryV1, 'repositoryId' | 'snapshotId'>,
  componentId = '',
): string {
  return `cgtn_${sha256HexSync(
    EffectArray.join(
      [
        'threadnote-cross-repository-topology-node-v1',
        generationId,
        kind,
        repository.repositoryId,
        repository.snapshotId,
        componentId,
      ],
      '\0',
    ),
  )}`;
}

function topologyEdgeId(
  generationId: string,
  granularity: 'component' | 'repository',
  sourceNodeId: string,
  targetNodeId: string,
): string {
  return `cgte_${sha256HexSync(
    EffectArray.join(
      ['threadnote-cross-repository-topology-edge-v1', generationId, granularity, sourceNodeId, targetNodeId],
      '\0',
    ),
  )}`;
}

function repositorySnapshotKey(repository: {readonly repositoryId: string; readonly snapshotId: string}): string {
  return `${repository.repositoryId}\0${repository.snapshotId}`;
}

function componentSnapshotKey(
  repository: {readonly repositoryId: string; readonly snapshotId: string},
  componentId: string,
): string {
  return `${repositorySnapshotKey(repository)}\0${componentId}`;
}

function nodeKindOrder(kind: CodeGraphCrossRepositoryTopologyNodeV1['kind']): number {
  return kind === 'repository' ? 0 : 1;
}

function granularityOrder(granularity: CodeGraphCrossRepositoryTopologyEdgeV1['granularity']): number {
  return granularity === 'repository' ? 0 : 1;
}

function sumBridgeCounts(aggregates: readonly MutableAggregate[]): number {
  return EffectArray.reduce(aggregates, 0, (total, aggregate) => total + aggregate.bridges.length);
}

function budget(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > maximum) {
    throw invalid(`Topology ${label} budget is invalid.`);
  }
  return selected;
}

function canonicalBoundedText(value: string, label: string, maximumBytes: number): string {
  if (typeof value !== 'string') throw invalid(`Topology ${label} is invalid.`);
  const canonical = Effect.pipe(value, EffectString.normalize('NFC'), EffectString.trim);
  if (!canonical || Buffer.byteLength(canonical, 'utf8') > maximumBytes) {
    throw invalid(`Topology ${label} is invalid.`);
  }
  return canonical;
}

function invalid(message: string): Error {
  return new Error(message);
}
