import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Effect, FileSystem, Path, Result, Schema} from 'effect';
import {succeedUndefined} from '@threadnote/platform/optional';
import {requireWorkset} from '@threadnote/workspace/manifest';
import type {ResolvedWorkset, RuntimeConfig} from '@threadnote/workspace/config';
import {expandPath} from '@threadnote/platform/paths';
import {CodeGraphQueryService} from '../query.js';
import {CodeGraphStore} from '../store.js';
import type {CodeGraphEdge, CodeGraphStatus} from '../types.js';
import {
  codeGraphWorksetCatalogProjectionContainsNode,
  readPublishedCodeGraphWorksetCatalogGeneration,
  registerCodeGraphQualifiedRef,
  resolveCodeGraphQualifiedRef,
} from '../workset_catalog/store.js';
import type {
  CodeGraphWorksetCatalogPublishedGenerationV1,
  CodeGraphWorksetCatalogPublishedMemberV1,
} from '../workset_catalog/types.js';
import {codeGraphWorksetCatalogGenerationMatches, codeGraphWorksetManifestDigest} from '../workset_catalog/workset.js';
import {codeGraphQualifiedRefHandle} from '../workset/evidence.js';
import {
  readCodeGraphWorksetCatalogBridgeGenerationPage,
  readCodeGraphWorksetCatalogBridgePage,
  readPublishedCodeGraphWorksetCatalogBridgeSetSummary,
  type CodeGraphCrossRepositoryBridgeSetSummaryV1,
} from './store.js';
import {
  projectCodeGraphCrossRepositoryTopology,
  type CodeGraphCrossRepositoryTopologyBudgetsV1,
  type CodeGraphCrossRepositoryTopologyV1,
} from './topology.js';
import {
  findCodeGraphCrossRepositoryPath,
  traceCodeGraphCrossRepositoryImpact,
  type CodeGraphCrossRepositoryLocalEdgeV1,
  type CodeGraphCrossRepositoryLocalPageV1,
  type CodeGraphCrossRepositoryTraversalBudgetsV1,
  type CodeGraphCrossRepositoryTraversalEndpointV1,
} from './traversal.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

class CodeGraphCrossRepositoryRuntimeError extends Schema.TaggedError<
  CodeGraphCrossRepositoryRuntimeError,
  {readonly brand: unique symbol}
>()('CodeGraphCrossRepositoryRuntimeError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

const SNAPSHOT_LEASE_MILLISECONDS = 2 * 60_000;
const LOCAL_ADJACENCY_SCAN_MAXIMUM = 5_000;
const TOPOLOGY_BRIDGES_MAXIMUM_DEFAULT = 20_000;
const TOPOLOGY_BRIDGE_PAGE_SIZE = 256;
const COMPONENT_ID = /^cgp_[0-9a-f]{32}$/u;
const QUALIFIED_REF = /^cgr_[0-9a-f]{40}$/u;

export interface CodeGraphWorksetPathOptionsV1 extends CodeGraphCrossRepositoryTraversalBudgetsV1 {
  readonly from: string;
  readonly to: string;
  readonly worksetName: string;
}

export interface CodeGraphWorksetImpactOptionsV1 extends CodeGraphCrossRepositoryTraversalBudgetsV1 {
  readonly query: string;
  readonly worksetName: string;
}

export interface CodeGraphWorksetTopologyOptionsV1 extends CodeGraphCrossRepositoryTopologyBudgetsV1 {
  readonly maximumBridges?: number;
  readonly worksetName: string;
}

export interface CodeGraphWorksetTopologyResultV1 {
  readonly bridgeSet?: CodeGraphCrossRepositoryBridgeSetSummaryV1;
  readonly state: 'ready' | 'unavailable';
  readonly topology?: CodeGraphCrossRepositoryTopologyV1;
  readonly warnings: readonly string[];
  readonly workset: string;
}

interface RuntimeMember {
  readonly databasePath: string;
  readonly lease: string;
  readonly published: CodeGraphWorksetCatalogPublishedMemberV1;
  readonly status: CodeGraphStatus;
}

interface PreparedRuntime {
  readonly availableByRepositorySnapshot: ReadonlyMap<string, RuntimeMember>;
  readonly published: CodeGraphWorksetCatalogPublishedGenerationV1;
  readonly workset: ResolvedWorkset;
}

/** Find a bounded authoritative path through local graph edges and generation-bound bridges. */
export const findCodeGraphWorksetPath = Effect.fn('codeGraphCrossRepository.findWorksetPath')(function* (
  config: RuntimeConfig,
  options: CodeGraphWorksetPathOptionsV1,
) {
  return yield* findCodeGraphWorksetPathScoped(config, options).pipe(Effect.scoped);
});

/** Trace bounded reverse impact through local graph edges and reversible bridge relations. */
export const traceCodeGraphWorksetImpact = Effect.fn('codeGraphCrossRepository.traceWorksetImpact')(function* (
  config: RuntimeConfig,
  options: CodeGraphWorksetImpactOptionsV1,
) {
  return yield* traceCodeGraphWorksetImpactScoped(config, options).pipe(Effect.scoped);
});

/** Project a bounded repository/component topology from a complete published bridge set. */
export const inspectCodeGraphWorksetTopology = Effect.fn('codeGraphCrossRepository.inspectWorksetTopology')(function* (
  config: RuntimeConfig,
  options: CodeGraphWorksetTopologyOptionsV1,
) {
  return yield* inspectCodeGraphWorksetTopologyScoped(config, options).pipe(Effect.scoped);
});

const findCodeGraphWorksetPathScoped = Effect.fn('codeGraphCrossRepository.findWorksetPathScoped')(function* (
  config: RuntimeConfig,
  options: CodeGraphWorksetPathOptionsV1,
) {
  const runtime = yield* prepareRuntime(config, options.worksetName);
  const bridgeSet = yield* requireCompleteBridgeSet(config, runtime);
  const start = yield* resolveTraversalEndpoint(config, runtime, options.from);
  const target = yield* resolveTraversalEndpoint(config, runtime, options.to);
  const traversal = yield* traversalDependencies(config, runtime);
  const result = yield* findCodeGraphCrossRepositoryPath(traversal.dependencies, {
    ...(options.deadlineMilliseconds === undefined ? {} : {deadlineMilliseconds: options.deadlineMilliseconds}),
    bridgeSet: {digest: bridgeSet.digest, totalBridges: bridgeSet.bridgeCount},
    generationId: runtime.published.id,
    ...(options.maxDepth === undefined ? {} : {maxDepth: options.maxDepth}),
    ...(options.maxEdges === undefined ? {} : {maxEdges: options.maxEdges}),
    ...(options.signal === undefined ? {} : {signal: options.signal}),
    start,
    target,
  });
  yield* registerTraversalQualifiedRefs(config.agentContextHome, traversal.qualifiedRefs);
  return result;
});

const traceCodeGraphWorksetImpactScoped = Effect.fn('codeGraphCrossRepository.traceWorksetImpactScoped')(function* (
  config: RuntimeConfig,
  options: CodeGraphWorksetImpactOptionsV1,
) {
  const runtime = yield* prepareRuntime(config, options.worksetName);
  const bridgeSet = yield* requireCompleteBridgeSet(config, runtime);
  const start = yield* resolveTraversalEndpoint(config, runtime, options.query);
  const traversal = yield* traversalDependencies(config, runtime);
  const result = yield* traceCodeGraphCrossRepositoryImpact(traversal.dependencies, {
    ...(options.deadlineMilliseconds === undefined ? {} : {deadlineMilliseconds: options.deadlineMilliseconds}),
    bridgeSet: {digest: bridgeSet.digest, totalBridges: bridgeSet.bridgeCount},
    generationId: runtime.published.id,
    ...(options.maxDepth === undefined ? {} : {maxDepth: options.maxDepth}),
    ...(options.maxEdges === undefined ? {} : {maxEdges: options.maxEdges}),
    ...(options.signal === undefined ? {} : {signal: options.signal}),
    start,
  });
  yield* registerTraversalQualifiedRefs(config.agentContextHome, traversal.qualifiedRefs);
  return result;
});

const inspectCodeGraphWorksetTopologyScoped = Effect.fn('codeGraphCrossRepository.inspectWorksetTopologyScoped')(
  function* (config: RuntimeConfig, options: CodeGraphWorksetTopologyOptionsV1) {
    const runtime = yield* prepareRuntime(config, options.worksetName);
    const bridgeSet = yield* readPublishedCodeGraphWorksetCatalogBridgeSetSummary(
      config.agentContextHome,
      runtime.published.id,
    );
    if (bridgeSet === undefined) {
      return {
        state: 'unavailable',
        warnings: ['The published generation has no cross-repository bridge receipt; run workset prepare.'],
        workset: runtime.workset.name,
      } satisfies CodeGraphWorksetTopologyResultV1;
    }
    if (bridgeSet.coverage.state !== 'complete') {
      return {
        bridgeSet,
        state: 'unavailable',
        warnings: ['Cross-repository bridge coverage is incomplete; topology was withheld.'],
        workset: runtime.workset.name,
      } satisfies CodeGraphWorksetTopologyResultV1;
    }
    if (runtime.availableByRepositorySnapshot.size !== runtime.published.members.length) {
      return {
        bridgeSet,
        state: 'unavailable',
        warnings: ['One or more generation snapshots are no longer ready and leased; topology was withheld.'],
        workset: runtime.workset.name,
      } satisfies CodeGraphWorksetTopologyResultV1;
    }
    const maximumBridges = boundedInteger(
      options.maximumBridges ?? TOPOLOGY_BRIDGES_MAXIMUM_DEFAULT,
      'topology bridge limit',
      1,
      250_000,
    );
    if (bridgeSet.bridgeCount > maximumBridges) {
      return {
        bridgeSet,
        state: 'unavailable',
        warnings: [
          `The bridge set has ${bridgeSet.bridgeCount} entries, above the bounded topology input limit of ${maximumBridges}.`,
        ],
        workset: runtime.workset.name,
      } satisfies CodeGraphWorksetTopologyResultV1;
    }
    const bridges = [];
    let after: {readonly bridgeId: string; readonly ordinal: number} | undefined;
    do {
      const page = yield* readCodeGraphWorksetCatalogBridgeGenerationPage(config.agentContextHome, {
        ...(after === undefined ? {} : {after}),
        generationId: runtime.published.id,
        limit: TOPOLOGY_BRIDGE_PAGE_SIZE,
      });
      if (
        page === undefined ||
        page.generationId !== runtime.published.id ||
        page.bridgeSetDigest !== bridgeSet.digest ||
        page.totalBridges !== bridgeSet.bridgeCount ||
        page.coverage.state !== 'complete'
      ) {
        throw CodeGraphCrossRepositoryRuntimeError.make({
          message: 'The published bridge set changed or became unavailable during topology assembly.',
        });
      }
      bridges.push(...page.bridges);
      after = page.next;
    } while (after !== undefined);
    if (bridges.length !== bridgeSet.bridgeCount) {
      throw CodeGraphCrossRepositoryRuntimeError.make({
        message: 'The complete bridge topology page sequence does not match its receipt.',
      });
    }
    const topology = projectCodeGraphCrossRepositoryTopology({
      bridgeSet: {
        bridgeSetDigest: bridgeSet.digest,
        bridges,
        generationId: runtime.published.id,
        resolverVersion: bridgeSet.resolverVersion,
        totalBridges: bridgeSet.bridgeCount,
        worksetName: runtime.workset.name,
      },
      budgets: {
        ...(options.maxEdges === undefined ? {} : {maxEdges: options.maxEdges}),
        ...(options.maxEvidence === undefined ? {} : {maxEvidence: options.maxEvidence}),
        ...(options.maxEvidencePerEdge === undefined ? {} : {maxEvidencePerEdge: options.maxEvidencePerEdge}),
        ...(options.maxNodes === undefined ? {} : {maxNodes: options.maxNodes}),
      },
      repositories: EffectArray.map(runtime.published.members, member => ({
        repositoryId: member.repositoryId,
        repositoryKey: member.repositoryKey,
        snapshotId: member.snapshotId,
      })),
    });
    return {
      bridgeSet,
      state: 'ready',
      topology,
      warnings: topology.coverage.complete ? [] : ['Topology output was truncated to its requested budgets.'],
      workset: runtime.workset.name,
    } satisfies CodeGraphWorksetTopologyResultV1;
  },
);

function prepareRuntime(config: RuntimeConfig, worksetName: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const query = yield* CodeGraphQueryService;
    const store = yield* CodeGraphStore;
    const workset = yield* requireWorkset(config.manifestPath, worksetName);
    const manifestDigest = codeGraphWorksetManifestDigest(workset);
    const published = yield* readPublishedCodeGraphWorksetCatalogGeneration(config.agentContextHome, workset.name);
    if (published === undefined) {
      return yield* CodeGraphCrossRepositoryRuntimeError.make({
        message: `No published workset catalog exists for ${workset.name}; run \`threadnote workset prepare\`.`,
      });
    }
    if (!codeGraphWorksetCatalogGenerationMatches(workset, manifestDigest, published)) {
      return yield* CodeGraphCrossRepositoryRuntimeError.make({
        message: `The published workset catalog for ${workset.name} is stale; run \`threadnote workset prepare\`.`,
      });
    }
    const projectsByKey = new Map(
      EffectArray.map(workset.projects, project => [safeLabel(project.name), project] as const),
    );
    const candidates = yield* Effect.forEach(
      published.members,
      member => {
        const project = projectsByKey.get(member.repositoryKey);
        if (project === undefined) return succeedUndefined;
        return Effect.gen(function* () {
          const cwd = yield* expandPath(project.path);
          if (!(yield* fs.exists(cwd))) return undefined;
          const status = yield* query.status(config.agentContextHome, cwd, {
            requestMaintenance: false,
            project: project.name,
            manifestPath: config.manifestPath,
          });
          if (!statusMatchesPublished(status, member)) return undefined;
          const lease = yield* Effect.acquireRelease(
            store.acquireSnapshotLease(status.databasePath, member.snapshotId, SNAPSHOT_LEASE_MILLISECONDS),
            token => store.releaseSnapshotLease(status.databasePath, token).pipe(Effect.ignore),
          );
          return {databasePath: status.databasePath, lease, published: member, status} satisfies RuntimeMember;
        }).pipe(Effect.orElseSucceed(() => undefined));
      },
      {concurrency: 4},
    );
    const availableByRepositorySnapshot = new Map(
      EffectArray.flatMap(candidates, member =>
        member === undefined ? [] : [[repositorySnapshotKey(member.published), member] as const],
      ),
    );
    return {availableByRepositorySnapshot, published, workset} satisfies PreparedRuntime;
  });
}

function requireCompleteBridgeSet(config: RuntimeConfig, runtime: PreparedRuntime) {
  if (
    EffectArray.some(
      [...runtime.availableByRepositorySnapshot.values()],
      member => member.status.projectCoverage?.completeness === 'partial',
    )
  ) {
    return Effect.fail(
      CodeGraphCrossRepositoryRuntimeError.make({
        message:
          'Project dependency coverage is partial; complete cross-repository path and impact traversal cannot be established.',
      }),
    );
  }
  return readPublishedCodeGraphWorksetCatalogBridgeSetSummary(config.agentContextHome, runtime.published.id).pipe(
    Effect.flatMap(bridgeSet => {
      if (bridgeSet === undefined) {
        return Effect.fail(
          CodeGraphCrossRepositoryRuntimeError.make({
            message: 'The published workset generation has no cross-repository bridge receipt; run workset prepare.',
          }),
        );
      }
      if (bridgeSet.coverage.state !== 'complete') {
        return Effect.fail(
          CodeGraphCrossRepositoryRuntimeError.make({
            message: 'Cross-repository bridge coverage is incomplete; path and impact were withheld.',
          }),
        );
      }
      return Effect.succeed(bridgeSet);
    }),
  );
}

function traversalDependencies(config: RuntimeConfig, runtime: PreparedRuntime) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* CodeGraphStore;
    const qualifiedRefs = new Map<string, {readonly nodeId: string; readonly repositoryId: string}>();
    const resolveNodeId = (endpoint: CodeGraphCrossRepositoryTraversalEndpointV1) =>
      Effect.gen(function* () {
        if (endpoint.reference.kind !== 'qualified-ref') return undefined;
        const cached = qualifiedRefs.get(endpoint.reference.ref);
        if (cached !== undefined) return cached.nodeId;
        const record = yield* resolveCodeGraphQualifiedRef(config.agentContextHome, {
          ref: endpoint.reference.ref,
          repositoryId: endpoint.repositoryId,
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));
        qualifiedRefs.set(record.ref, {nodeId: record.nodeId, repositoryId: record.repositoryId});
        return record.nodeId;
      });
    const dependencies = {
      readBridgePage: (input: Parameters<typeof readCodeGraphWorksetCatalogBridgePage>[1]) =>
        readCodeGraphWorksetCatalogBridgePage(config.agentContextHome, input).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      readLocalPage: (input: {
        readonly after?: string;
        readonly direction: 'incoming' | 'outgoing';
        readonly endpoint: CodeGraphCrossRepositoryTraversalEndpointV1;
        readonly limit: number;
      }) => {
        const member = runtime.availableByRepositorySnapshot.get(repositorySnapshotKey(input.endpoint));
        if (member === undefined || input.endpoint.reference.kind === 'component') {
          return Effect.succeed({edges: []} satisfies CodeGraphCrossRepositoryLocalPageV1);
        }
        return Effect.gen(function* () {
          const nodeId = yield* resolveNodeId(input.endpoint);
          if (nodeId === undefined) return {edges: []} satisfies CodeGraphCrossRepositoryLocalPageV1;
          return yield* readLocalAdjacencyPage(
            store,
            member,
            input.endpoint,
            nodeId,
            input.direction,
            input.after,
            input.limit,
            qualifiedRefs,
          );
        }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));
      },
      validateEndpointAccess: (endpoint: CodeGraphCrossRepositoryTraversalEndpointV1) => {
        const member = runtime.availableByRepositorySnapshot.get(repositorySnapshotKey(endpoint));
        if (member === undefined || member.published.repositoryKey !== endpoint.repositoryKey) {
          return Effect.succeed({leased: false, ready: false});
        }
        return Effect.gen(function* () {
          const renewed = yield* Effect.result(
            store.renewSnapshotLease(member.databasePath, member.lease, SNAPSHOT_LEASE_MILLISECONDS),
          );
          if (Result.isFailure(renewed)) return {leased: false, ready: false};
          const ready = yield* store.readySnapshot(
            member.databasePath,
            member.published.worktreeId,
            member.status.readySnapshot?.scopeId,
          );
          return {
            leased: true,
            ready:
              ready?.id === member.published.snapshotId &&
              ready.repositoryId === member.published.repositoryId &&
              ready.state === 'ready',
          };
        }).pipe(Effect.orElseSucceed(() => ({leased: false, ready: false})));
      },
    } as const;
    return {dependencies, qualifiedRefs};
  });
}

function readLocalAdjacencyPage(
  store: typeof CodeGraphStore.Service,
  member: RuntimeMember,
  endpoint: CodeGraphCrossRepositoryTraversalEndpointV1,
  nodeId: string,
  direction: 'incoming' | 'outgoing',
  cursor: string | undefined,
  limit: number,
  qualifiedRefs: Map<string, {readonly nodeId: string; readonly repositoryId: string}>,
) {
  return Effect.gen(function* () {
    const offset = localOffset(cursor);
    let requested = Math.min(LOCAL_ADJACENCY_SCAN_MAXIMUM, offset + limit + 1);
    for (;;) {
      const rows = yield* store.edgesForNodes(
        member.databasePath,
        member.published.snapshotId,
        [nodeId],
        direction,
        requested,
        ['declared', 'resolved', 'syntactic'],
      );
      const selected: Array<{readonly edge: CodeGraphCrossRepositoryLocalEdgeV1; readonly rawIndex: number}> = [];
      for (let index = offset; index < rows.length && selected.length < limit; index += 1) {
        const edge = localTraversalEdge(member.published, rows[index], nodeId, direction);
        if (edge !== undefined) selected.push({edge, rawIndex: index});
      }
      const lastRawIndex = selected.at(-1)?.rawIndex;
      const hasUnseenRows = lastRawIndex !== undefined && lastRawIndex + 1 < rows.length;
      const sourceMayHaveMore = rows.length === requested;
      if (selected.length >= limit || !sourceMayHaveMore || requested === LOCAL_ADJACENCY_SCAN_MAXIMUM) {
        if (selected.length === 0 && sourceMayHaveMore && requested === LOCAL_ADJACENCY_SCAN_MAXIMUM) {
          throw CodeGraphCrossRepositoryRuntimeError.make({
            message: 'Local adjacency exceeded the bounded scan before yielding a traversable edge.',
          });
        }
        for (const {edge} of selected) {
          for (const candidate of [edge.source, edge.target]) {
            if (candidate.reference.kind !== 'qualified-ref') continue;
            const localNodeId = edgeNodeId(candidate.reference.ref, member.published.repositoryId, rows);
            if (localNodeId !== undefined) {
              qualifiedRefs.set(candidate.reference.ref, {
                nodeId: localNodeId,
                repositoryId: member.published.repositoryId,
              });
            }
          }
        }
        const nextOffset = lastRawIndex === undefined ? undefined : lastRawIndex + 1;
        return {
          edges: EffectArray.map(selected, value => value.edge),
          ...(nextOffset !== undefined && (hasUnseenRows || sourceMayHaveMore) ? {next: String(nextOffset)} : {}),
        } satisfies CodeGraphCrossRepositoryLocalPageV1;
      }
      requested = Math.min(LOCAL_ADJACENCY_SCAN_MAXIMUM, requested + Math.max(limit, 64));
    }
  });
}

function registerTraversalQualifiedRefs(
  threadnoteHome: string,
  qualifiedRefs: ReadonlyMap<string, {readonly nodeId: string; readonly repositoryId: string}>,
) {
  return Effect.forEach(
    EffectArray.map([...qualifiedRefs], ([ref, value]) => ({...value, ref})).sort((left, right) =>
      compareText(left.ref, right.ref),
    ),
    candidate => registerCodeGraphQualifiedRef(threadnoteHome, candidate),
    {concurrency: 1, discard: true},
  );
}

function localTraversalEdge(
  member: CodeGraphWorksetCatalogPublishedMemberV1,
  edge: CodeGraphEdge,
  nodeId: string,
  direction: 'incoming' | 'outgoing',
): CodeGraphCrossRepositoryLocalEdgeV1 | undefined {
  if (
    edge.sourceId === undefined ||
    edge.targetId === undefined ||
    (direction === 'outgoing' ? edge.sourceId !== nodeId : edge.targetId !== nodeId) ||
    !isEdgeProvenance(edge.provenance)
  ) {
    return undefined;
  }
  const endpoint = (candidate: string): CodeGraphCrossRepositoryTraversalEndpointV1 => ({
    reference: {
      kind: 'qualified-ref',
      ref: codeGraphQualifiedRefHandle({nodeId: candidate, repositoryId: member.repositoryId}),
    },
    repositoryId: member.repositoryId,
    repositoryKey: member.repositoryKey,
    snapshotId: member.snapshotId,
  });
  return {
    confidence: edge.confidence,
    id: edge.id,
    provenance: edge.provenance,
    relation: edge.relation,
    source: endpoint(edge.sourceId),
    target: endpoint(edge.targetId),
  };
}

function isEdgeProvenance(value: string): value is 'declared' | 'resolved' | 'syntactic' {
  return value === 'declared' || value === 'resolved' || value === 'syntactic';
}

function edgeNodeId(ref: string, repositoryId: string, rows: readonly CodeGraphEdge[]): string | undefined {
  for (const edge of rows) {
    for (const nodeId of [edge.sourceId, edge.targetId]) {
      if (nodeId !== undefined && codeGraphQualifiedRefHandle({nodeId, repositoryId}) === ref) return nodeId;
    }
  }
  return undefined;
}

function resolveTraversalEndpoint(config: RuntimeConfig, runtime: PreparedRuntime, selector: string) {
  return Effect.gen(function* () {
    const normalized = Effect2.pipe(selector, EffectString.trim);
    if (QUALIFIED_REF.test(normalized)) {
      const record = yield* resolveCodeGraphQualifiedRef(config.agentContextHome, {ref: normalized});
      const member = EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.published.members, candidate => candidate.repositoryId === record.repositoryId),
      );
      if (member === undefined)
        throw CodeGraphCrossRepositoryRuntimeError.make({
          message: 'The qualified reference repository is not in this workset generation.',
        });
      const present = yield* codeGraphWorksetCatalogProjectionContainsNode(config.agentContextHome, {
        nodeId: record.nodeId,
        projectionDigest: member.projectionDigest,
      });
      if (!present)
        throw CodeGraphCrossRepositoryRuntimeError.make({
          message: 'The qualified reference is not present in the published snapshot projection.',
        });
      return traversalEndpoint(member, {kind: 'qualified-ref', ref: normalized});
    }
    if (COMPONENT_ID.test(normalized)) {
      if (runtime.published.members.length !== 1) {
        throw CodeGraphCrossRepositoryRuntimeError.make({
          message: 'A component selector in a multi-repository workset must use <repository>:<cgp_...>.',
        });
      }
      return traversalEndpoint(runtime.published.members[0], {componentId: normalized, kind: 'component'});
    }
    const marker = Effect2.pipe(
      normalized,
      EffectString.lastIndexOf(':cgp_'),
      Effect2.Option.getOrElse(() => -1),
    );
    if (marker > 0) {
      const repositoryKey = Effect2.pipe(normalized, EffectString.slice(0, marker));
      const componentId = Effect2.pipe(normalized, EffectString.slice(marker + 1));
      if (!COMPONENT_ID.test(componentId))
        throw CodeGraphCrossRepositoryRuntimeError.make({message: 'Workset component selector is invalid.'});
      const member = EffectOption.getOrUndefined(
        EffectArray.findFirst(runtime.published.members, candidate => candidate.repositoryKey === repositoryKey),
      );
      if (member === undefined)
        throw CodeGraphCrossRepositoryRuntimeError.make({
          message: 'Workset component selector names an unknown generation member.',
        });
      return traversalEndpoint(member, {componentId, kind: 'component'});
    }
    throw CodeGraphCrossRepositoryRuntimeError.make({
      message: 'Workset path/impact requires a cgr_ handle or <repository>:<cgp_...> component selector.',
    });
  });
}

function traversalEndpoint(
  member: CodeGraphWorksetCatalogPublishedMemberV1,
  reference: CodeGraphCrossRepositoryTraversalEndpointV1['reference'],
): CodeGraphCrossRepositoryTraversalEndpointV1 {
  return {
    reference,
    repositoryId: member.repositoryId,
    repositoryKey: member.repositoryKey,
    snapshotId: member.snapshotId,
  };
}

function statusMatchesPublished(status: CodeGraphStatus, published: CodeGraphWorksetCatalogPublishedMemberV1): boolean {
  return (
    status.identity.repositoryId === published.repositoryId &&
    status.identity.checkoutId === published.checkoutId &&
    status.identity.worktreeId === published.worktreeId &&
    status.readySnapshot?.id === published.snapshotId &&
    status.readySnapshot.commit === published.commitId &&
    status.readySnapshot.state === 'ready'
  );
}

function repositorySnapshotKey(value: {readonly repositoryId: string; readonly snapshotId: string}): string {
  return `${value.repositoryId}\0${value.snapshotId}`;
}

function localOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(?:0|[1-9]\d{0,3})$/u.test(cursor))
    throw CodeGraphCrossRepositoryRuntimeError.make({message: 'Local traversal cursor is invalid.'});
  return boundedInteger(Number(cursor), 'local traversal cursor', 0, LOCAL_ADJACENCY_SCAN_MAXIMUM);
}

function safeLabel(value: string): string {
  const normalized = Effect2.pipe(value, EffectString.replace(/[\r\n\t\0]/gu, ' '), EffectString.trim);
  return Effect2.pipe(normalized, EffectString.slice(0, 256)) || 'unknown';
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw CodeGraphCrossRepositoryRuntimeError.make({
      message: `${label} must be an integer from ${minimum} to ${maximum}.`,
    });
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
