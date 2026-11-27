import {Array as EffectArray, Effect, FileSystem, Option, Path} from 'effect';
import * as EffectString from 'effect/String';
import {ReadDeadlineExceeded, readDeadlineRemaining, type ReadDeadline} from '@threadnote/platform/read_deadline';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {
  parseNavigationFacts,
  type NavigationProofEdge,
  type NavigationProofSymbol,
} from '@threadnote/graph/navigation_facts';
import type {TaskDiscoveryBudget} from '@threadnote/graph/query/task_discovery';
import type {
  CodeGraphEdge,
  CodeGraphQueryNode,
  CodeGraphQueryResult,
  CodeGraphStatus,
  RepositoryIdentity,
} from '@threadnote/graph/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ContextBriefNavigationMemoryProjects} from '../memory-evidence.js';
import type {ContextBriefMemoryRetrievalV1, ContextBriefScopeV1} from '../types.js';
import {navigationRelativePath, type NavigationEffectsLocator} from './continuation.js';
import {retrieveTaskNavigationAnswer} from './discovery.js';
import {
  NAVIGATION_INPUT_LIMITS,
  navigationScopeKey,
  withNavigationGaps,
  type NavigationInput,
  type NavigationScope,
} from './model.js';
import type {NavigationSemanticAnchorV1} from './semantic.js';
import type {NavigationProofLocator} from './structural.js';

/** The structural read of one navigate request. Worksets are not supported by the v1 lane. */
export interface NavigationReadRequestV1 {
  readonly scope: Extract<ContextBriefScopeV1, {readonly kind: 'repository'}>;
  readonly task: string;
  readonly codeRefs: readonly string[];
  readonly maximumEstimatedTokens: number;
  /** Warm write-boundary follow-up: re-read only these effect nodes; task discovery does not run. */
  readonly followUp?: readonly NavigationEffectsLocator[];
  /**
   * Wall-clock epoch milliseconds at which the semantic step must start to keep its floor. When the application
   * finds that semantic can run and this time is not past, the memory step ends before it; otherwise memory keeps
   * only its own cap. Wall clock, because the worker's monotonic clock has a different origin.
   */
  readonly semanticFloorAt?: number;
}

export interface NavigationReadEvidenceV1 {
  readonly status: 'ok';
  readonly identity: RepositoryIdentity;
  readonly observation: Pick<CodeGraphQueryResult, 'repository' | 'snapshot' | 'freshness'>;
  readonly repositoryIdentityKind: 'local' | 'remote';
  readonly input: NavigationInput;
  readonly proofLocators: readonly NavigationProofLocator[];
  /** Only the owner-symbol and call-edge fields the proofs are closed against, so the parent can re-validate them. */
  readonly proofContext: {
    readonly symbols: readonly (NavigationProofSymbol & Pick<CodeGraphQueryNode, 'path' | 'contentHash'>)[];
    readonly edges: readonly NavigationProofEdge[];
  };
  readonly anchors: readonly NavigationSemanticAnchorV1[];
  /** Code-linked memory for the route candidates. The application reads it in the same worker read. */
  readonly memory?: NavigationMemoryReadV1;
}

export type NavigationMemoryReadV1 =
  | {
      readonly status: 'ok';
      /** Citation validations are against the navigation snapshot. */
      readonly memory: ContextBriefMemoryRetrievalV1;
      /** The project boundary the read applied; absent when it could not be resolved. */
      readonly memoryProjects?: ContextBriefNavigationMemoryProjects;
      readonly observedAt: string;
    }
  | {readonly status: 'unavailable'; readonly gaps: readonly string[]};

export type NavigationReadResultV1 =
  NavigationReadEvidenceV1 | {readonly status: 'unavailable'; readonly gaps: readonly string[]};

const LEASE_WAIT_MILLISECONDS = 250;
/** Anchors offered to the semantic step for one answer. */
export const NAVIGATION_SEMANTIC_ANCHORS = 2;
const REPOSITORY_PROJECT = 'repository';
/** Accounting bound for discovery plus the one source-proof batch; the worker reply limit is separate. */
const DISCOVERY_BYTES = 16 * 1024 * 1024;
const DISK_VIEW: NavigationScope['view'] = {kind: 'disk', id: 'saved', owner: 'graph', epoch: 0};
const unavailable = (gap: string): NavigationReadResultV1 => ({status: 'unavailable', gaps: [gap]});

/** The worker reply has no key for an absent optional field: a repository without a remote has no `remoteIdentity`. */
function replyIdentity(identity: RepositoryIdentity): RepositoryIdentity {
  const {branch, remoteIdentity, ...required} = identity;
  return {
    ...required,
    ...(branch === undefined ? {} : {branch}),
    ...(remoteIdentity === undefined ? {} : {remoteIdentity}),
  };
}

/**
 * Read the structural navigation evidence from the shared READY graph snapshot only. It never indexes, refreshes,
 * requests maintenance or extends the caller's deadline. The native worker and the in-process fallback both call it.
 */
export const readNavigationEvidence = Effect.fn('navigation.readEvidence')(function* (
  config: RuntimeConfig,
  request: NavigationReadRequestV1,
  deadline: ReadDeadline,
) {
  if ((yield* readDeadlineRemaining(deadline)) <= 0) return yield* ReadDeadlineExceeded.make({});
  const query = yield* CodeGraphQueryService;
  const scopeOptions = {project: request.scope.project, manifestPath: config.manifestPath};
  let status: CodeGraphStatus = yield* query.status(config.agentContextHome, request.scope.callerCwd, {
    ...scopeOptions,
    requestMaintenance: false,
  });
  if (status.readySnapshot === undefined)
    status = yield* query.attachSharedReadySnapshot(config.agentContextHome, status.identity, status, {
      allowBorrowedStale: false,
      requestMaintenance: false,
    });
  const ready = status.readySnapshot;
  if (ready === undefined) return unavailable('navigation-graph-ready-snapshot-missing');
  const store = yield* CodeGraphStore;
  const remaining = yield* readDeadlineRemaining(deadline);
  if (remaining <= 0) return yield* ReadDeadlineExceeded.make({});
  return yield* Effect.acquireUseRelease(
    store
      .acquireSnapshotLease(status.databasePath, ready.id, remaining + 15_000, {
        waitTimeoutMilliseconds: LEASE_WAIT_MILLISECONDS,
      })
      .pipe(Effect.option),
    lease =>
      Option.isNone(lease)
        ? Effect.succeed(unavailable('navigation-graph-snapshot-lease-unavailable'))
        : readLeased(config, request, deadline, status, ready),
    lease =>
      Option.isSome(lease)
        ? store
            .releaseSnapshotLease(status.databasePath, lease.value, {waitTimeoutMilliseconds: LEASE_WAIT_MILLISECONDS})
            .pipe(Effect.ignore)
        : Effect.void,
  );
});

const readLeased = Effect.fn('navigation.readLeased')(function* (
  config: RuntimeConfig,
  request: NavigationReadRequestV1,
  deadline: ReadDeadline,
  status: CodeGraphStatus,
  ready: NonNullable<CodeGraphStatus['readySnapshot']>,
) {
  const {identity} = status;
  const observation = {
    repository: {repositoryId: identity.repositoryId, displayName: identity.displayName},
    snapshot: {id: ready.id, commit: ready.commit, worktreeId: ready.worktreeId, dirty: ready.dirty},
    freshness: status.freshness,
    ...(status.projectCoverage === undefined ? {} : {projectCoverage: status.projectCoverage}),
  };
  const scope: NavigationScope = {
    repository: identity.repositoryId,
    worktree: identity.worktreeId,
    // The structural adapter requires this to equal the coverage project. The assembler admits only nonempty
    // identities, so a graph with no project coverage uses a fixed name.
    project: status.projectCoverage?.project ?? REPOSITORY_PROJECT,
    view: DISK_VIEW,
  };
  const staleGaps = status.freshness === 'current' ? [] : [`navigation-graph-${status.freshness}`];
  const paths = EffectArray.filter(request.codeRefs, ref => !EffectString.startsWith('cgs_')(ref));
  const nodeIds = request.followUp
    ? EffectArray.map(request.followUp, locator => locator.nodeId)
    : EffectArray.filter(request.codeRefs, EffectString.startsWith('cgs_'));
  let anchoredResult: CodeGraphQueryResult | undefined;
  const readGaps: string[] = [];
  if (request.followUp !== undefined) {
    // A follow-up never repeats task discovery, so it needs at least one effect node to re-read.
    if (request.followUp.length === 0) return unavailable('navigation-follow-up-unresolved');
    const contained = yield* followUpPathsContained(identity.repoRoot, request.followUp);
    if (!contained) return unavailable('navigation-continuation-path-rejected');
  }
  if (nodeIds.length > 0) {
    const anchored = yield* readAnchors(config, request, status, nodeIds, request.followUp === undefined ? 1 : 0);
    if (anchored === undefined)
      return unavailable(request.followUp ? 'navigation-follow-up-unresolved' : 'navigation-anchor-unresolved');
    anchoredResult = anchored.result;
    if (anchored.truncated) readGaps.push('navigation-anchor-budget');
    if (
      request.followUp !== undefined &&
      !EffectArray.every(request.followUp, locator =>
        EffectArray.some(anchoredResult!.nodes, node => node.id === locator.nodeId && node.path === locator.path),
      )
    )
      return unavailable('navigation-follow-up-unresolved');
  }
  // The source-proof stage reserves its worst case before it reads: 2 MiB of facts, up to 64 edges at 128 KiB,
  // 1.5 MiB of retained source and the excerpt. 4 MiB never covers that, so proofs were always skipped.
  const budget: TaskDiscoveryBudget = {
    remainingReads: 17,
    remainingBytes: DISCOVERY_BYTES,
    remainingNodes: 12,
    remainingEdges: 2,
    deadline,
  };
  const answer = yield* retrieveTaskNavigationAnswer({
    databasePath: status.databasePath,
    observation,
    task: request.task,
    budget,
    identity,
    repositoryKey: identity.displayName,
    scope,
    maximumEstimatedTokens: request.maximumEstimatedTokens,
    ...(anchoredResult === undefined ? {} : {anchoredResult, anchorIds: nodeIds}),
    ...(anchoredResult === undefined && paths.length > 0 ? {paths} : {}),
  });
  const result = anchoredResult ?? answer.discovery!.result;
  const {input, proofLocators} = answer.structural;
  const ownerIds = new Set(EffectArray.map(proofLocators, locator => locator.accepted.proof.ownerId));
  const callEdgeIds = new Set(EffectArray.map(proofLocators, locator => locator.accepted.proof.callEdgeId));
  return {
    status: 'ok',
    identity: replyIdentity(identity),
    observation: {repository: observation.repository, snapshot: observation.snapshot, freshness: observation.freshness},
    repositoryIdentityKind: identity.remoteIdentity === undefined ? 'local' : 'remote',
    input: withNavigationGaps(input, [...staleGaps, ...readGaps]),
    proofLocators,
    proofContext: {
      symbols: EffectArray.map(
        EffectArray.filter(result.nodes, node => ownerIds.has(node.id)),
        ({id, kind, span, path, contentHash}) => ({id, kind, span, path, contentHash}),
      ),
      edges: EffectArray.map(
        EffectArray.filter(result.edges, edge => callEdgeIds.has(edge.id)),
        ({id, sourceId, relation, targetName}) => ({
          id,
          relation,
          targetName,
          ...(sourceId === undefined ? {} : {sourceId}),
        }),
      ),
    },
    anchors: semanticAnchors(input, result),
  } satisfies NavigationReadResultV1;
});

/** Read each anchor's neighbourhood. Every anchor node is kept; neighbours fill the remaining limits. */
const readAnchors = Effect.fn('navigation.readAnchors')(function* (
  config: RuntimeConfig,
  request: NavigationReadRequestV1,
  status: CodeGraphStatus,
  nodeIds: readonly string[],
  depth: 0 | 1,
) {
  const query = yield* CodeGraphQueryService;
  const results: CodeGraphQueryResult[] = [];
  for (const nodeId of nodeIds.slice(0, NAVIGATION_INPUT_LIMITS.anchors)) {
    const result = yield* query
      .inspect({
        project: request.scope.project,
        manifestPath: config.manifestPath,
        cwd: request.scope.callerCwd,
        depth,
        direction: 'both',
        edgeLimit: NAVIGATION_INPUT_LIMITS.links,
        nodeLimit: NAVIGATION_INPUT_LIMITS.candidates,
        operation: 'neighbors',
        nodeId,
        refresh: false,
        requestMaintenance: false,
        statusObservation: observationFromCodeGraphStatus(status),
        strictFreshness: false,
        threadnoteHome: config.agentContextHome,
      })
      .pipe(Effect.option);
    if (
      Option.isNone(result) ||
      !EffectArray.some(result.value.nodes, node => node.id === nodeId) ||
      result.value.repository.repositoryId !== status.identity.repositoryId ||
      result.value.snapshot.id !== status.readySnapshot?.id
    )
      return undefined;
    results.push(result.value);
  }
  const first = results[0];
  if (first === undefined) return undefined;
  const anchors = new Set(nodeIds);
  const nodes = new Map<string, CodeGraphQueryNode>();
  for (const result of results) for (const node of result.nodes) if (anchors.has(node.id)) nodes.set(node.id, node);
  let truncated = false;
  for (const result of results)
    for (const node of result.nodes)
      if (nodes.has(node.id)) continue;
      else if (nodes.size < NAVIGATION_INPUT_LIMITS.candidates) nodes.set(node.id, node);
      else truncated = true;
  const edges = new Map<string, CodeGraphEdge>();
  for (const result of results)
    for (const edge of result.edges)
      if (
        edge.sourceId !== undefined &&
        edge.targetId !== undefined &&
        nodes.has(edge.sourceId) &&
        nodes.has(edge.targetId) &&
        !edges.has(edge.id)
      )
        if (edges.size < NAVIGATION_INPUT_LIMITS.links) edges.set(edge.id, edge);
        else truncated = true;
  return {result: {...first, nodes: [...nodes.values()], edges: [...edges.values()]}, truncated};
});

/** Every follow-up path must stay inside the repository root after links are resolved. */
const followUpPathsContained = Effect.fn('navigation.followUpPathsContained')(function* (
  repoRoot: string,
  locators: readonly NavigationEffectsLocator[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(repoRoot).pipe(Effect.option);
  if (Option.isNone(root)) return false;
  for (const locator of locators) {
    if (!navigationRelativePath(locator.path)) return false;
    const real = yield* fs.realPath(path.join(root.value, locator.path)).pipe(Effect.option);
    if (Option.isNone(real)) return false;
    const relative = path.relative(root.value, real.value);
    if (
      relative === '' ||
      relative === '..' ||
      EffectString.startsWith(`..${path.sep}`)(relative) ||
      path.isAbsolute(relative)
    )
      return false;
  }
  return true;
});

/** Entry point and implementation candidates first; at most two, each with its graph declaration. */
function semanticAnchors(input: NavigationInput, result: CodeGraphQueryResult): readonly NavigationSemanticAnchorV1[] {
  const nodes = new Map(EffectArray.map(result.nodes, node => [node.id, node] as const));
  const rank = (roles: readonly string[]) =>
    roles.includes('entrypoint') ? 0 : roles.includes('implementation') ? 1 : roles.includes('effects') ? 2 : 3;
  const candidates = EffectArray.filter(
    input.candidates,
    candidate =>
      nodes.has(candidate.id) && !candidate.roles.includes('tests') && nodes.get(candidate.id)!.kind !== 'module',
  );
  const ordered = [...candidates].sort(
    (left, right) => rank(left.roles) - rank(right.roles) || right.relevance - left.relevance,
  );
  return EffectArray.map(ordered.slice(0, NAVIGATION_SEMANTIC_ANCHORS), candidate => {
    const node = nodes.get(candidate.id)!;
    return {
      candidateId: candidate.id,
      path: node.path,
      contentHash: node.contentHash,
      name: node.name,
      span: node.span,
    };
  });
}

/**
 * Parent-side admission of a read reply from the native worker. The reply is untrusted: identities must agree with
 * each other and with the request scope, every path must be repository-relative, every anchor must name a candidate
 * and its source bytes, and every proof is re-validated against its own source, owner symbol and call edge. The
 * caller checks separately that the request cwd lies inside `identity.repoRoot`. Any violation throws.
 */
export function admitNavigationRead(result: NavigationReadResultV1): NavigationReadResultV1 {
  if (result.status !== 'ok') return result;
  const {identity, observation, input} = result;
  if (
    observation.repository.repositoryId !== identity.repositoryId ||
    observation.snapshot.worktreeId !== identity.worktreeId ||
    input.scope.repository !== identity.repositoryId ||
    input.scope.worktree !== identity.worktreeId
  )
    throw new Error('Navigation read identity conflict.');
  const sources = new Map(EffectArray.map(input.sources, source => [source.id, source] as const));
  if (!EffectArray.every(input.sources, source => navigationRelativePath(source.path)))
    throw new Error('Navigation read source path rejected.');
  for (const anchor of result.anchors) {
    const candidate = EffectArray.findFirst(input.candidates, item => item.id === anchor.candidateId);
    const source = Option.isSome(candidate) ? sources.get(candidate.value.sourceId) : undefined;
    if (source === undefined || source.path !== anchor.path || source.contentHash !== anchor.contentHash)
      throw new Error('Navigation read anchor rejected.');
  }
  const scopeKey = navigationScopeKey(input.scope);
  const byPath = new Map<string, NavigationProofLocator[]>();
  for (const locator of result.proofLocators) {
    const source = sources.get(locator.sourceId);
    if (
      navigationScopeKey(locator.scope) !== scopeKey ||
      locator.snapshot.id !== observation.snapshot.id ||
      source === undefined ||
      source.path !== locator.accepted.path ||
      source.contentHash !== locator.accepted.contentHash
    )
      throw new Error('Navigation read proof locator rejected.');
    byPath.set(locator.accepted.path, [...(byPath.get(locator.accepted.path) ?? []), locator]);
  }
  for (const [path, locators] of byPath) {
    const hash = locators[0].accepted.contentHash;
    const symbols = EffectArray.filter(
      result.proofContext.symbols,
      symbol => symbol.path === path && symbol.contentHash === hash,
    );
    const proofs = EffectArray.map(locators, locator => locator.accepted.proof);
    const facts = parseNavigationFacts({version: 1, omitted: false, proofs}, symbols, result.proofContext.edges);
    if (facts.proofs.length !== proofs.length) throw new Error('Navigation read proof rejected.');
  }
  return result;
}

/** The request cwd must lie inside the repository root the worker reported. */
export const navigationReadContainsCwd = Effect.fn('navigation.readContainsCwd')(function* (
  result: NavigationReadResultV1,
  callerCwd: string,
) {
  if (result.status !== 'ok') return true;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const real = yield* Effect.option(Effect.all([fs.realPath(result.identity.repoRoot), fs.realPath(callerCwd)]));
  if (Option.isNone(real)) return false;
  const [root, cwd] = real.value;
  const relative = path.relative(root, cwd);
  return (
    relative === '' ||
    (relative !== '..' && !EffectString.startsWith(`..${path.sep}`)(relative) && !path.isAbsolute(relative))
  );
});
