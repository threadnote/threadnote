import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {compareCodeUnits} from '../ordering.js';
import type {
  CodeGraphBridgeEndpointReferenceV1,
  CodeGraphBridgeEndpointV1,
  CodeGraphCrossRepositoryBridgeV1,
} from './resolver.js';
import type {
  CodeGraphCrossRepositoryBridgeCursorV1,
  CodeGraphCrossRepositoryBridgePageV1,
  CodeGraphCrossRepositoryEndpointKeyV1,
} from './store.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const MAX_DEPTH = 16;
const MAX_EDGES = 1_000;
const MAX_DEADLINE_MILLISECONDS = 60_000;
const READ_PAGE_MAXIMUM = 128;
const MAX_CURSOR_BYTES = 4_096;
const BRIDGE_SET_DIGEST = /^[0-9a-f]{64}$/u;

export interface CodeGraphCrossRepositoryTraversalEndpointV1 extends CodeGraphCrossRepositoryEndpointKeyV1 {
  readonly repositoryKey: string;
}

export type CodeGraphLocalRelationshipProvenanceV1 = 'declared' | 'resolved' | 'syntactic';

export interface CodeGraphCrossRepositoryLocalEdgeV1 {
  readonly confidence: number;
  readonly id: string;
  readonly provenance: CodeGraphLocalRelationshipProvenanceV1;
  readonly relation: string;
  readonly source: CodeGraphCrossRepositoryTraversalEndpointV1;
  readonly target: CodeGraphCrossRepositoryTraversalEndpointV1;
}

export interface CodeGraphCrossRepositoryLocalPageV1 {
  readonly edges: readonly CodeGraphCrossRepositoryLocalEdgeV1[];
  readonly next?: string;
}

export interface CodeGraphCrossRepositoryEndpointAccessV1 {
  /** The exact snapshot is ready for graph reads. */
  readonly ready: boolean;
  /** The caller holds a live lease that fences cleanup for this snapshot. */
  readonly leased: boolean;
  readonly receipt?: string;
}

export interface CodeGraphCrossRepositoryTraversalDependencies {
  readonly monotonicMilliseconds?: () => number;
  readonly readBridgePage: (input: {
    readonly after?: CodeGraphCrossRepositoryBridgeCursorV1;
    readonly direction: 'incoming' | 'outgoing';
    readonly endpoint: CodeGraphCrossRepositoryEndpointKeyV1;
    readonly generationId: string;
    readonly limit: number;
  }) => Effect.Effect<CodeGraphCrossRepositoryBridgePageV1 | undefined, unknown>;
  readonly readLocalPage: (input: {
    readonly after?: string;
    readonly direction: 'incoming' | 'outgoing';
    readonly endpoint: CodeGraphCrossRepositoryTraversalEndpointV1;
    readonly limit: number;
  }) => Effect.Effect<CodeGraphCrossRepositoryLocalPageV1, unknown>;
  readonly validateEndpointAccess: (
    endpoint: CodeGraphCrossRepositoryTraversalEndpointV1,
  ) => Effect.Effect<CodeGraphCrossRepositoryEndpointAccessV1, unknown>;
}

export type CodeGraphCrossRepositoryTraversalStopReasonV1 =
  'cancelled' | 'deadline' | 'depth' | 'edge-limit' | 'exhaustion' | 'target-found' | 'unready-start';

export type CodeGraphCrossRepositoryTraversalEdgeV1 =
  | {
      readonly id: string;
      readonly provenance: {
        readonly confidence: number;
        readonly kind: 'local';
        readonly relationProvenance: CodeGraphLocalRelationshipProvenanceV1;
      };
      readonly relation: string;
      readonly source: CodeGraphCrossRepositoryTraversalEndpointV1;
      readonly target: CodeGraphCrossRepositoryTraversalEndpointV1;
    }
  | {
      readonly id: string;
      readonly provenance: {
        readonly bridgeId: string;
        readonly confidence: 1;
        readonly generationId: string;
        readonly kind: 'bridge';
        readonly reason: CodeGraphCrossRepositoryBridgeV1['resolver']['reason'];
        readonly resolverVersion: number;
        readonly sourceEvidence: CodeGraphBridgeEndpointV1['evidence'];
        readonly targetEvidence: CodeGraphBridgeEndpointV1['evidence'];
      };
      readonly relation: CodeGraphCrossRepositoryBridgeV1['relation'];
      readonly source: CodeGraphCrossRepositoryTraversalEndpointV1;
      readonly target: CodeGraphCrossRepositoryTraversalEndpointV1;
    };

export interface CodeGraphCrossRepositoryTraversalCoverageV1 {
  readonly acceptedBridgeEdges: number;
  readonly acceptedLocalEdges: number;
  readonly bridgePagesRead: number;
  readonly duplicateEdgesSkipped: number;
  readonly endpointAccessChecks: number;
  readonly endpointsExpanded: number;
  readonly endpointsVisited: number;
  readonly localPagesRead: number;
  readonly scannedEdges: number;
  readonly unreadyEndpointsSkipped: number;
}

export interface CodeGraphCrossRepositoryTraversalResultV1 {
  readonly coverage: CodeGraphCrossRepositoryTraversalCoverageV1;
  readonly direction: 'forward' | 'reverse';
  readonly edges: readonly CodeGraphCrossRepositoryTraversalEdgeV1[];
  readonly generationId: string;
  readonly reachedTarget: boolean;
  readonly stop: {
    readonly complete: boolean;
    readonly reason: CodeGraphCrossRepositoryTraversalStopReasonV1;
  };
  readonly visited: readonly CodeGraphCrossRepositoryTraversalEndpointV1[];
}

export interface CodeGraphCrossRepositoryTraversalBudgetsV1 {
  readonly deadlineMilliseconds?: number;
  readonly maxDepth?: number;
  readonly maxEdges?: number;
  readonly signal?: AbortSignal;
}

export interface CodeGraphCrossRepositoryTraversalBridgeFenceV1 {
  readonly digest: string;
  readonly totalBridges: number;
}

interface PreparedTraversalInput extends Required<Omit<CodeGraphCrossRepositoryTraversalBudgetsV1, 'signal'>> {
  readonly bridgeSet: CodeGraphCrossRepositoryTraversalBridgeFenceV1;
  readonly direction: 'incoming' | 'outgoing';
  readonly generationId: string;
  readonly mode: 'impact' | 'path';
  readonly signal?: AbortSignal;
  readonly start: CodeGraphCrossRepositoryTraversalEndpointV1;
  readonly target?: CodeGraphCrossRepositoryTraversalEndpointV1;
}

interface FrontierEntry {
  readonly depth: number;
  readonly endpoint: CodeGraphCrossRepositoryTraversalEndpointV1;
}

interface Predecessor {
  readonly edge: CodeGraphCrossRepositoryTraversalEdgeV1;
  readonly previous: string;
}

/** Find a deterministic shortest forward path across local and bridge edges. */
export const findCodeGraphCrossRepositoryPath = Effect.fn('codeGraphCrossRepository.findPath')(function* (
  dependencies: CodeGraphCrossRepositoryTraversalDependencies,
  input: CodeGraphCrossRepositoryTraversalBudgetsV1 & {
    readonly bridgeSet: CodeGraphCrossRepositoryTraversalBridgeFenceV1;
    readonly generationId: string;
    readonly start: CodeGraphCrossRepositoryTraversalEndpointV1;
    readonly target: CodeGraphCrossRepositoryTraversalEndpointV1;
  },
) {
  return yield* traverse(dependencies, prepareInput({...input, direction: 'outgoing', mode: 'path'}));
});

/** Trace deterministic reverse impact across local and bridge edges. */
export const traceCodeGraphCrossRepositoryImpact = Effect.fn('codeGraphCrossRepository.traceImpact')(function* (
  dependencies: CodeGraphCrossRepositoryTraversalDependencies,
  input: CodeGraphCrossRepositoryTraversalBudgetsV1 & {
    readonly bridgeSet: CodeGraphCrossRepositoryTraversalBridgeFenceV1;
    readonly generationId: string;
    readonly start: CodeGraphCrossRepositoryTraversalEndpointV1;
  },
) {
  return yield* traverse(dependencies, prepareInput({...input, direction: 'incoming', mode: 'impact'}));
});

function traverse(
  dependencies: CodeGraphCrossRepositoryTraversalDependencies,
  input: PreparedTraversalInput,
): Effect.Effect<CodeGraphCrossRepositoryTraversalResultV1, unknown> {
  return Effect.gen(function* () {
    const now = dependencies.monotonicMilliseconds ?? (() => performance.now());
    const deadline = now() + input.deadlineMilliseconds;
    const startKey = endpointKey(input.start);
    const targetKey = input.target === undefined ? undefined : endpointKey(input.target);
    const visited = new Map<string, CodeGraphCrossRepositoryTraversalEndpointV1>([[startKey, input.start]]);
    const predecessor = new Map<string, Predecessor>();
    const acceptedEdges: CodeGraphCrossRepositoryTraversalEdgeV1[] = [];
    const seenEdges = new Set<string>();
    const frontier: FrontierEntry[] = [{depth: 0, endpoint: input.start}];
    const coverage = mutableCoverage();
    let reachedTarget = targetKey === startKey;
    let stopReason: CodeGraphCrossRepositoryTraversalStopReasonV1 = reachedTarget ? 'target-found' : 'exhaustion';
    let depthLimited = false;

    if (reachedTarget) return result(input, coverage, visited, [], true, stopReason);
    const startAccess = yield* checkEndpointAccess(dependencies, input.start, coverage);
    if (!startAccess) return result(input, coverage, visited, [], false, 'unready-start');

    traversal: while (frontier.length > 0) {
      if (isCancelled(input.signal)) {
        stopReason = 'cancelled';
        break;
      }
      if (now() >= deadline) {
        stopReason = 'deadline';
        break;
      }
      if (coverage.scannedEdges >= input.maxEdges) {
        stopReason = 'edge-limit';
        break;
      }
      frontier.sort(compareFrontier);
      const current = frontier.shift()!;
      if (current.depth >= input.maxDepth) {
        depthLimited = true;
        continue;
      }
      if (!(yield* checkEndpointAccess(dependencies, current.endpoint, coverage))) continue;
      coverage.endpointsExpanded += 1;
      const remaining = input.maxEdges - coverage.scannedEdges;
      const adjacency = yield* readAdjacency(dependencies, input, current.endpoint, remaining, coverage);
      for (const edge of adjacency) {
        if (isCancelled(input.signal)) {
          stopReason = 'cancelled';
          break traversal;
        }
        if (now() >= deadline) {
          stopReason = 'deadline';
          break traversal;
        }
        if (coverage.scannedEdges >= input.maxEdges) {
          stopReason = 'edge-limit';
          break traversal;
        }
        coverage.scannedEdges += 1;
        validateTraversalEdge(edge, current.endpoint, input.direction);
        const edgeIdentity = traversalEdgeKey(edge);
        if (seenEdges.has(edgeIdentity)) {
          coverage.duplicateEdgesSkipped += 1;
          continue;
        }
        seenEdges.add(edgeIdentity);
        const destination = input.direction === 'outgoing' ? edge.target : edge.source;
        if (!(yield* checkEndpointAccess(dependencies, destination, coverage))) continue;
        acceptedEdges.push(edge);
        if (edge.provenance.kind === 'bridge') coverage.acceptedBridgeEdges += 1;
        else coverage.acceptedLocalEdges += 1;
        const destinationKey = endpointKey(destination);
        if (!visited.has(destinationKey)) {
          visited.set(destinationKey, destination);
          predecessor.set(destinationKey, {edge, previous: endpointKey(current.endpoint)});
          frontier.push({depth: current.depth + 1, endpoint: destination});
        }
        if (targetKey !== undefined && destinationKey === targetKey) {
          reachedTarget = true;
          stopReason = 'target-found';
          break traversal;
        }
      }
    }

    if (stopReason === 'exhaustion' && depthLimited) stopReason = 'depth';
    if (stopReason === 'exhaustion' && coverage.scannedEdges >= input.maxEdges) stopReason = 'edge-limit';
    const edges =
      input.mode === 'path' && reachedTarget && targetKey !== undefined
        ? reconstructPath(startKey, targetKey, predecessor)
        : acceptedEdges;
    return result(input, coverage, visited, edges, reachedTarget, stopReason);
  });
}

function readAdjacency(
  dependencies: CodeGraphCrossRepositoryTraversalDependencies,
  input: PreparedTraversalInput,
  endpoint: CodeGraphCrossRepositoryTraversalEndpointV1,
  remaining: number,
  coverage: MutableCoverage,
): Effect.Effect<readonly CodeGraphCrossRepositoryTraversalEdgeV1[], unknown> {
  return Effect.gen(function* () {
    const edges: CodeGraphCrossRepositoryTraversalEdgeV1[] = [];
    let localAfter: string | undefined;
    let bridgeAfter: CodeGraphCrossRepositoryBridgeCursorV1 | undefined;
    let localDone = false;
    let bridgeDone = false;
    while ((!localDone || !bridgeDone) && edges.length < remaining) {
      const limit = Math.min(READ_PAGE_MAXIMUM, Math.max(1, remaining - edges.length));
      const bridgePageRequested = !bridgeDone;
      const pages: readonly [
        CodeGraphCrossRepositoryLocalPageV1 | undefined,
        CodeGraphCrossRepositoryBridgePageV1 | undefined,
      ] = yield* Effect.all(
        [
          localDone
            ? succeedUndefined
            : dependencies.readLocalPage({
                ...(localAfter === undefined ? {} : {after: localAfter}),
                direction: input.direction,
                endpoint,
                limit,
              }),
          bridgeDone
            ? succeedUndefined
            : dependencies.readBridgePage({
                ...(bridgeAfter === undefined ? {} : {after: bridgeAfter}),
                direction: input.direction,
                endpoint: endpointKeyInput(endpoint),
                generationId: input.generationId,
                limit,
              }),
        ] as const,
        {concurrency: 2},
      );
      const localPage: CodeGraphCrossRepositoryLocalPageV1 | undefined = pages[0];
      const bridgePage: CodeGraphCrossRepositoryBridgePageV1 | undefined = pages[1];
      if (localPage !== undefined) {
        coverage.localPagesRead += 1;
        if (localPage.edges.length > limit) throw new Error('Local neighbor reader exceeded its requested bound.');
        edges.push(...EffectArray.map(localPage.edges, localTraversalEdge));
        const next = validateLocalCursor(localPage.next, localAfter);
        if (next !== undefined && localPage.edges.length === 0) {
          throw new Error('Local neighbor reader returned an empty nonterminal page.');
        }
        localAfter = next;
        localDone = next === undefined;
      }
      if (bridgePage !== undefined) {
        coverage.bridgePagesRead += 1;
        if (
          bridgePage.generationId !== input.generationId ||
          bridgePage.bridgeSetDigest !== input.bridgeSet.digest ||
          bridgePage.totalBridges !== input.bridgeSet.totalBridges ||
          bridgePage.coverage.state !== 'complete' ||
          bridgePage.bridges.length > limit
        ) {
          throw new Error('Bridge neighbor reader returned a stale or oversized page.');
        }
        if (bridgePage.next !== undefined && bridgePage.bridges.length === 0) {
          throw new Error('Bridge neighbor reader returned an empty nonterminal page.');
        }
        edges.push(...EffectArray.map(bridgePage.bridges, bridge => bridgeTraversalEdge(input.generationId, bridge)));
        bridgeAfter = bridgePage.next;
        bridgeDone = bridgeAfter === undefined;
      } else if (bridgePageRequested) {
        throw new Error('The fenced bridge set became unavailable during traversal.');
      }
      if (localPage === undefined) localDone = true;
    }
    return edges.sort(compareTraversalEdges).slice(0, remaining);
  });
}

function checkEndpointAccess(
  dependencies: CodeGraphCrossRepositoryTraversalDependencies,
  endpoint: CodeGraphCrossRepositoryTraversalEndpointV1,
  coverage: MutableCoverage,
): Effect.Effect<boolean, unknown> {
  return dependencies.validateEndpointAccess(endpoint).pipe(
    Effect.map(access => {
      coverage.endpointAccessChecks += 1;
      const available = access.ready && access.leased;
      if (!available) coverage.unreadyEndpointsSkipped += 1;
      return available;
    }),
  );
}

function localTraversalEdge(edge: CodeGraphCrossRepositoryLocalEdgeV1): CodeGraphCrossRepositoryTraversalEdgeV1 {
  if (!Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1) {
    throw new Error('Local relationship confidence is invalid.');
  }
  return {
    id: boundedRuntimeText(edge.id, 'local edge identity', 256),
    provenance: {
      confidence: edge.confidence,
      kind: 'local',
      relationProvenance: edge.provenance,
    },
    relation: boundedRuntimeText(edge.relation, 'local relationship', 128),
    source: canonicalEndpoint(edge.source),
    target: canonicalEndpoint(edge.target),
  };
}

function bridgeTraversalEdge(
  generationId: string,
  bridge: CodeGraphCrossRepositoryBridgeV1,
): CodeGraphCrossRepositoryTraversalEdgeV1 {
  return {
    id: bridge.id,
    provenance: {
      bridgeId: bridge.id,
      confidence: 1,
      generationId,
      kind: 'bridge',
      reason: bridge.resolver.reason,
      resolverVersion: bridge.resolver.version,
      sourceEvidence: bridge.source.evidence,
      targetEvidence: bridge.target.evidence,
    },
    relation: bridge.relation,
    source: endpointFromBridge(bridge.source),
    target: endpointFromBridge(bridge.target),
  };
}

function validateTraversalEdge(
  edge: CodeGraphCrossRepositoryTraversalEdgeV1,
  current: CodeGraphCrossRepositoryTraversalEndpointV1,
  direction: 'incoming' | 'outgoing',
): void {
  const touching = direction === 'outgoing' ? edge.source : edge.target;
  if (endpointKey(touching) !== endpointKey(current)) {
    throw new Error('Neighbor reader returned an edge outside the requested endpoint.');
  }
  if (edge.provenance.kind === 'local') {
    if (
      edge.source.repositoryId !== edge.target.repositoryId ||
      edge.source.snapshotId !== edge.target.snapshotId ||
      edge.source.repositoryKey !== edge.target.repositoryKey
    ) {
      throw new Error('A local edge cannot cross repository snapshots.');
    }
  } else if (edge.source.repositoryId === edge.target.repositoryId) {
    throw new Error('An authoritative bridge must cross repositories.');
  }
}

function reconstructPath(
  startKey: string,
  targetKey: string,
  predecessor: ReadonlyMap<string, Predecessor>,
): readonly CodeGraphCrossRepositoryTraversalEdgeV1[] {
  const reverse: CodeGraphCrossRepositoryTraversalEdgeV1[] = [];
  let cursor = targetKey;
  while (cursor !== startKey) {
    const entry = predecessor.get(cursor);
    if (entry === undefined) throw new Error('Cross-repository path predecessor chain is incomplete.');
    reverse.push(entry.edge);
    cursor = entry.previous;
  }
  return reverse.reverse();
}

function result(
  input: PreparedTraversalInput,
  coverage: MutableCoverage,
  visited: ReadonlyMap<string, CodeGraphCrossRepositoryTraversalEndpointV1>,
  edges: readonly CodeGraphCrossRepositoryTraversalEdgeV1[],
  reachedTarget: boolean,
  reason: CodeGraphCrossRepositoryTraversalStopReasonV1,
): CodeGraphCrossRepositoryTraversalResultV1 {
  const orderedVisited = [...visited.values()].sort(compareEndpoints);
  return {
    coverage: {...coverage, endpointsVisited: orderedVisited.length},
    direction: input.direction === 'outgoing' ? 'forward' : 'reverse',
    edges,
    generationId: input.generationId,
    reachedTarget,
    stop: {
      complete: reason === 'target-found' || (reason === 'exhaustion' && coverage.unreadyEndpointsSkipped === 0),
      reason,
    },
    visited: orderedVisited,
  };
}

interface MutableCoverage {
  acceptedBridgeEdges: number;
  acceptedLocalEdges: number;
  bridgePagesRead: number;
  duplicateEdgesSkipped: number;
  endpointAccessChecks: number;
  endpointsExpanded: number;
  endpointsVisited: number;
  localPagesRead: number;
  scannedEdges: number;
  unreadyEndpointsSkipped: number;
}

function mutableCoverage(): MutableCoverage {
  return {
    acceptedBridgeEdges: 0,
    acceptedLocalEdges: 0,
    bridgePagesRead: 0,
    duplicateEdgesSkipped: 0,
    endpointAccessChecks: 0,
    endpointsExpanded: 0,
    endpointsVisited: 0,
    localPagesRead: 0,
    scannedEdges: 0,
    unreadyEndpointsSkipped: 0,
  };
}

function prepareInput(
  input: CodeGraphCrossRepositoryTraversalBudgetsV1 & {
    readonly bridgeSet: CodeGraphCrossRepositoryTraversalBridgeFenceV1;
    readonly direction: 'incoming' | 'outgoing';
    readonly generationId: string;
    readonly mode: 'impact' | 'path';
    readonly start: CodeGraphCrossRepositoryTraversalEndpointV1;
    readonly target?: CodeGraphCrossRepositoryTraversalEndpointV1;
  },
): PreparedTraversalInput {
  if (!/^cgwg_[0-9a-f]{40}$/u.test(input.generationId)) throw new Error('Traversal generation identity is invalid.');
  if (!BRIDGE_SET_DIGEST.test(input.bridgeSet.digest)) throw new Error('Traversal bridge-set digest is invalid.');
  const totalBridges = boundedInteger(input.bridgeSet.totalBridges, 'total bridge count', 0, 250_000);
  const maxDepth = boundedInteger(input.maxDepth ?? 4, 'maximum depth', 0, MAX_DEPTH);
  const maxEdges = boundedInteger(input.maxEdges ?? 100, 'maximum edges', 1, MAX_EDGES);
  const deadlineMilliseconds = boundedInteger(
    input.deadlineMilliseconds ?? 2_000,
    'deadline',
    1,
    MAX_DEADLINE_MILLISECONDS,
  );
  const start = canonicalEndpoint(input.start);
  const target = input.target === undefined ? undefined : canonicalEndpoint(input.target);
  if (input.mode === 'path' && target === undefined) throw new Error('Forward path traversal requires a target.');
  return {
    bridgeSet: {digest: input.bridgeSet.digest, totalBridges},
    deadlineMilliseconds,
    direction: input.direction,
    generationId: input.generationId,
    maxDepth,
    maxEdges,
    mode: input.mode,
    ...(input.signal === undefined ? {} : {signal: input.signal}),
    start,
    ...(target === undefined ? {} : {target}),
  };
}

function canonicalEndpoint(
  endpoint: CodeGraphCrossRepositoryTraversalEndpointV1,
): CodeGraphCrossRepositoryTraversalEndpointV1 {
  const repositoryId = boundedRuntimeText(endpoint.repositoryId, 'repository identity', 64);
  if (!/^[0-9a-f]{64}$/u.test(repositoryId)) throw new Error('Traversal repository identity is invalid.');
  return {
    reference: canonicalReference(endpoint.reference),
    repositoryId,
    repositoryKey: boundedRuntimeText(endpoint.repositoryKey, 'repository key', 4_096),
    snapshotId: boundedRuntimeText(endpoint.snapshotId, 'snapshot identity', 256),
  };
}

function canonicalReference(reference: CodeGraphBridgeEndpointReferenceV1): CodeGraphBridgeEndpointReferenceV1 {
  if (reference.kind === 'component') {
    if (!/^cgp_[0-9a-f]{32}$/u.test(reference.componentId)) throw new Error('Traversal component identity is invalid.');
    return {componentId: reference.componentId, kind: 'component'};
  }
  if (!/^cgr_[0-9a-f]{40}$/u.test(reference.ref)) throw new Error('Traversal qualified reference is invalid.');
  return {kind: 'qualified-ref', ref: reference.ref};
}

function endpointFromBridge(endpoint: CodeGraphBridgeEndpointV1): CodeGraphCrossRepositoryTraversalEndpointV1 {
  return canonicalEndpoint({
    reference: endpoint.reference,
    repositoryId: endpoint.repositoryId,
    repositoryKey: endpoint.repositoryKey,
    snapshotId: endpoint.snapshotId,
  });
}

function endpointKeyInput(
  endpoint: CodeGraphCrossRepositoryTraversalEndpointV1,
): CodeGraphCrossRepositoryEndpointKeyV1 {
  return {reference: endpoint.reference, repositoryId: endpoint.repositoryId, snapshotId: endpoint.snapshotId};
}

function endpointKey(endpoint: CodeGraphCrossRepositoryTraversalEndpointV1): string {
  return EffectArray.join(
    [
      endpoint.repositoryId,
      endpoint.repositoryKey,
      endpoint.snapshotId,
      endpoint.reference.kind,
      endpoint.reference.kind === 'component' ? endpoint.reference.componentId : endpoint.reference.ref,
    ],
    '\0',
  );
}

function traversalEdgeKey(edge: CodeGraphCrossRepositoryTraversalEdgeV1): string {
  return EffectArray.join(
    [edge.provenance.kind, edge.id, endpointKey(edge.source), edge.relation, endpointKey(edge.target)],
    '\0',
  );
}

function compareTraversalEdges(
  left: CodeGraphCrossRepositoryTraversalEdgeV1,
  right: CodeGraphCrossRepositoryTraversalEdgeV1,
): number {
  return (
    compareCodeUnits(endpointKey(left.source), endpointKey(right.source)) ||
    compareCodeUnits(left.relation, right.relation) ||
    compareCodeUnits(endpointKey(left.target), endpointKey(right.target)) ||
    compareCodeUnits(left.provenance.kind, right.provenance.kind) ||
    compareCodeUnits(left.id, right.id)
  );
}

function compareEndpoints(
  left: CodeGraphCrossRepositoryTraversalEndpointV1,
  right: CodeGraphCrossRepositoryTraversalEndpointV1,
): number {
  return compareCodeUnits(endpointKey(left), endpointKey(right));
}

function compareFrontier(left: FrontierEntry, right: FrontierEntry): number {
  return left.depth - right.depth || compareEndpoints(left.endpoint, right.endpoint);
}

function validateLocalCursor(next: string | undefined, previous: string | undefined): string | undefined {
  if (next === undefined) return undefined;
  const canonical = boundedRuntimeText(next, 'local cursor', MAX_CURSOR_BYTES);
  if (canonical === previous) throw new Error('Local neighbor reader did not advance its cursor.');
  return canonical;
}

function boundedRuntimeText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    EffectArray.some(
      [...value],
      character =>
        Effect2.pipe(
          character,
          EffectString.codePointAt(0),
          Effect2.Option.getOrElse(() => undefined),
        )! < 32 ||
        Effect2.pipe(
          character,
          EffectString.codePointAt(0),
          Effect2.Option.getOrElse(() => undefined),
        ) === 127,
    )
  ) {
    throw new Error(`Traversal ${label} is invalid.`);
  }
  return value;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Traversal ${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
