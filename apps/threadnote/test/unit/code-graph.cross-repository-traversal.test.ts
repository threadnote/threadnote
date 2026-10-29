import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {it as effectIt} from '@effect/vitest';
import * as FC from 'fast-check';
import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphPackageMoniker} from '@threadnote/graph/cross_repository/monikers';
import {
  resolveCodeGraphCrossRepositoryBridges,
  type CodeGraphBridgeRepositoryV1,
  type CodeGraphCrossRepositoryBridgeV1,
} from '@threadnote/graph/cross_repository/resolver';
import type {CodeGraphCrossRepositoryBridgePageV1} from '@threadnote/graph/cross_repository/store';
import {
  findCodeGraphCrossRepositoryPath,
  traceCodeGraphCrossRepositoryImpact,
  type CodeGraphCrossRepositoryLocalEdgeV1,
  type CodeGraphCrossRepositoryTraversalDependencies,
  type CodeGraphCrossRepositoryTraversalEndpointV1,
} from '@threadnote/graph/cross_repository/traversal';
import type {CodeGraphMonikerV1} from '@threadnote/graph/cross_repository/types';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const span = {column: 1, endColumn: 8, endLine: 1, line: 1} as const;
const generationId = `cgwg_${Effect2.pipe('a', EffectString.repeat(40))}`;
const bridgeSet = {digest: digest('bridge-set'), totalBridges: 2} as const;

describe('cross-repository graph traversal', () => {
  it('finds a forward path through two authoritative bridges and preserves provenance on every edge', async () => {
    const fixture = traversalFixture();
    const result = await runEffect(
      findCodeGraphCrossRepositoryPath(dependencies(fixture), {
        bridgeSet,
        generationId,
        maxDepth: 8,
        maxEdges: 32,
        start: fixture.start,
        target: fixture.end,
      }),
    );

    expect(result.reachedTarget).toBe(true);
    expect(result.stop).toEqual({complete: true, reason: 'target-found'});
    expect(EffectArray.map(result.edges, edge => edge.provenance.kind)).toEqual([
      'local',
      'bridge',
      'local',
      'bridge',
      'local',
    ]);
    expect(EffectArray.filter(result.edges, edge => edge.provenance.kind === 'bridge')).toHaveLength(2);
    expect(
      EffectArray.every(
        result.edges,
        edge =>
          edge.provenance.kind !== 'bridge' ||
          (edge.provenance.generationId === generationId && edge.provenance.sourceEvidence.path.length > 0),
      ),
    ).toBe(true);
    expect(result.coverage).toMatchObject({acceptedBridgeEdges: 2, acceptedLocalEdges: 3});
  });

  it('traces reverse impact across both bridges and refuses an unready or unleased endpoint', async () => {
    const fixture = traversalFixture();
    const complete = await runEffect(
      traceCodeGraphCrossRepositoryImpact(dependencies(fixture), {
        bridgeSet,
        generationId,
        maxDepth: 8,
        maxEdges: 32,
        start: fixture.end,
      }),
    );
    expect(complete.direction).toBe('reverse');
    expect(complete.stop).toEqual({complete: true, reason: 'exhaustion'});
    expect(EffectArray.map(complete.edges, edge => edge.provenance.kind)).toEqual([
      'local',
      'bridge',
      'local',
      'bridge',
      'local',
    ]);
    expect(complete.visited).toEqual(expect.arrayContaining([fixture.start, fixture.end]));

    const blockedKey = endpointKey(fixture.bridges[0].source);
    const blocked = await runEffect(
      traceCodeGraphCrossRepositoryImpact(dependencies(fixture, {blockedKey}), {
        bridgeSet,
        generationId,
        maxDepth: 8,
        maxEdges: 32,
        start: fixture.end,
      }),
    );
    expect(blocked.visited).not.toContainEqual(fixture.start);
    expect(blocked.coverage.unreadyEndpointsSkipped).toBeGreaterThan(0);
    expect(EffectArray.every(blocked.edges, edge => endpointKey(edge.source) !== blockedKey)).toBe(true);
    expect(blocked.stop).toEqual({complete: false, reason: 'exhaustion'});
  });

  it('returns explicit edge, depth, deadline, and cancellation stop receipts', async () => {
    const fixture = traversalFixture();
    const edgeLimited = await runEffect(
      findCodeGraphCrossRepositoryPath(dependencies(fixture), {
        bridgeSet,
        generationId,
        maxDepth: 8,
        maxEdges: 2,
        start: fixture.start,
        target: fixture.end,
      }),
    );
    expect(edgeLimited.stop).toEqual({complete: false, reason: 'edge-limit'});
    expect(edgeLimited.coverage.scannedEdges).toBe(2);

    const depthLimited = await runEffect(
      findCodeGraphCrossRepositoryPath(dependencies(fixture), {
        bridgeSet,
        generationId,
        maxDepth: 2,
        maxEdges: 32,
        start: fixture.start,
        target: fixture.end,
      }),
    );
    expect(depthLimited.stop).toEqual({complete: false, reason: 'depth'});

    let ticks = 0;
    const deadline = await runEffect(
      findCodeGraphCrossRepositoryPath(
        {...dependencies(fixture), monotonicMilliseconds: () => (ticks++ === 0 ? 0 : 2)},
        {
          bridgeSet,
          deadlineMilliseconds: 1,
          generationId,
          maxDepth: 8,
          maxEdges: 32,
          start: fixture.start,
          target: fixture.end,
        },
      ),
    );
    expect(deadline.stop).toEqual({complete: false, reason: 'deadline'});

    const controller = new AbortController();
    controller.abort();
    const cancelled = await runEffect(
      findCodeGraphCrossRepositoryPath(dependencies(fixture), {
        bridgeSet,
        generationId,
        maxDepth: 8,
        maxEdges: 32,
        signal: controller.signal,
        start: fixture.start,
        target: fixture.end,
      }),
    );
    expect(cancelled.stop).toEqual({complete: false, reason: 'cancelled'});
  });

  it('is deterministic under local order and concurrent local/bridge completion order', async () => {
    await FC.assert(
      FC.asyncProperty(
        FC.record({bridgeFirst: FC.boolean(), reverseLocal: FC.boolean()}),
        async ({bridgeFirst, reverseLocal}) => {
          const fixture = traversalFixture();
          const baseline = await runEffect(
            findCodeGraphCrossRepositoryPath(dependencies(fixture), {
              bridgeSet,
              generationId,
              maxDepth: 8,
              maxEdges: 32,
              start: fixture.start,
              target: fixture.end,
            }),
          );
          const reordered = await runEffect(
            findCodeGraphCrossRepositoryPath(dependencies(fixture, {bridgeFirst, reverseLocal}), {
              bridgeSet,
              generationId,
              maxDepth: 8,
              maxEdges: 32,
              start: fixture.start,
              target: fixture.end,
            }),
          );
          expect(reordered).toEqual(baseline);
        },
      ),
      {numRuns: 30},
    );
  });

  fcEffectProp(
    effectIt,
    'continues arbitrary local pagination after the bridge lane reaches its terminal page',
    {pageCount: FC.integer({max: 6, min: 2})},
    ({pageCount}) =>
      Effect.gen(function* () {
        const fixture = traversalFixture();
        const pagedEdges = Array.from({length: pageCount}, (_, index) =>
          localEdge(`paged-${index}`, fixture.start, {
            ...fixture.start,
            reference: {kind: 'qualified-ref', ref: qualifiedRef(`paged-target-${index}`)},
          }),
        );
        let bridgeReads = 0;
        const result = yield* findCodeGraphCrossRepositoryPath(
          {
            monotonicMilliseconds: () => 0,
            readBridgePage: () => {
              bridgeReads += 1;
              return Effect.succeed({
                bridgeSetDigest: bridgeSet.digest,
                bridges: [],
                coverage: {
                  diagnostics: [],
                  failedRepositoryCount: 0,
                  rejectionCount: 0,
                  repositoriesRead: 3,
                  repositoryCount: 3,
                  state: 'complete' as const,
                },
                generationId,
                resolverVersion: 1,
                totalBridges: bridgeSet.totalBridges,
                worksetName: 'engineering',
              });
            },
            readLocalPage: request => {
              const index =
                request.after === undefined
                  ? 0
                  : Number(Effect2.pipe(request.after, EffectString.slice('page:'.length)));
              return Effect.succeed({
                edges: [pagedEdges[index]],
                ...(index + 1 < pagedEdges.length ? {next: `page:${index + 1}`} : {}),
              });
            },
            validateEndpointAccess: () => Effect.succeed({leased: true, ready: true}),
          },
          {
            bridgeSet,
            generationId,
            maxDepth: 1,
            maxEdges: pageCount + 1,
            start: fixture.start,
            target: fixture.end,
          },
        );

        expect(bridgeReads).toBe(1);
        expect(result.coverage).toMatchObject({bridgePagesRead: 1, localPagesRead: pageCount});
        expect(result.edges).toHaveLength(pageCount);
        expect(result.stop).toEqual({complete: false, reason: 'depth'});
      }),
    {fastCheck: {numRuns: 20}},
  );
});

interface TraversalFixture {
  readonly bridges: readonly CodeGraphCrossRepositoryBridgeV1[];
  readonly end: CodeGraphCrossRepositoryTraversalEndpointV1;
  readonly localEdges: readonly CodeGraphCrossRepositoryLocalEdgeV1[];
  readonly start: CodeGraphCrossRepositoryTraversalEndpointV1;
}

function traversalFixture(): TraversalFixture {
  const consumer = repository('consumer', 'apps/consumer', [
    packageMoniker('import', '@acme/middle', '^1.0.0', 'consumer-middle'),
  ]);
  const middle = repository('middle', 'packages/middle', [
    packageMoniker('export', '@acme/middle', '1.2.0', 'middle-export'),
    packageMoniker('import', '@acme/terminal', '^2.0.0', 'middle-terminal'),
  ]);
  const terminal = repository('terminal', 'packages/terminal', [
    packageMoniker('export', '@acme/terminal', '2.4.0', 'terminal-export'),
  ]);
  const resolution = resolveCodeGraphCrossRepositoryBridges([terminal, consumer, middle]);
  if (resolution.rejections.length > 0 || resolution.bridges.length !== 2)
    throw TestError.make({message: 'Invalid fixture.'});
  const first = EffectOption.getOrUndefined(
    EffectArray.findFirst(resolution.bridges, bridge => bridge.source.repositoryId === consumer.repositoryId),
  )!;
  const second = EffectOption.getOrUndefined(
    EffectArray.findFirst(resolution.bridges, bridge => bridge.source.repositoryId === middle.repositoryId),
  )!;
  const start = endpoint(consumer, {kind: 'qualified-ref', ref: qualifiedRef('start')});
  const end = endpoint(terminal, {kind: 'qualified-ref', ref: qualifiedRef('end')});
  const localEdges = [
    localEdge('consumer-local', start, endpointFromBridge(first.source)),
    localEdge('middle-local', endpointFromBridge(first.target), endpointFromBridge(second.source)),
    localEdge('terminal-local', endpointFromBridge(second.target), end),
  ];
  return {bridges: [first, second], end, localEdges, start};
}

function dependencies(
  fixture: TraversalFixture,
  options: {readonly blockedKey?: string; readonly bridgeFirst?: boolean; readonly reverseLocal?: boolean} = {},
): CodeGraphCrossRepositoryTraversalDependencies {
  return {
    monotonicMilliseconds: () => 0,
    readBridgePage: request => {
      const endpoint = endpointLookupKey(request.endpoint);
      const matches = EffectArray.filter(fixture.bridges, bridge =>
        request.direction === 'outgoing'
          ? endpointLookupKey(bridge.source) === endpoint
          : endpointLookupKey(bridge.target) === endpoint,
      );
      const page: CodeGraphCrossRepositoryBridgePageV1 = {
        bridgeSetDigest: digest('bridge-set'),
        bridges: matches,
        coverage: {
          diagnostics: [],
          failedRepositoryCount: 0,
          rejectionCount: 0,
          repositoriesRead: 3,
          repositoryCount: 3,
          state: 'complete',
        },
        generationId,
        resolverVersion: 1,
        totalBridges: fixture.bridges.length,
        worksetName: 'engineering',
      };
      const effect = Effect.succeed(page);
      return options.bridgeFirst === false ? Effect.sleep(1).pipe(Effect.andThen(effect)) : effect;
    },
    readLocalPage: request => {
      const endpoint = endpointKey(request.endpoint);
      const matches = EffectArray.filter(fixture.localEdges, edge =>
        request.direction === 'outgoing'
          ? endpointKey(edge.source) === endpoint
          : endpointKey(edge.target) === endpoint,
      );
      const edges = options.reverseLocal === true ? [...matches].reverse() : matches;
      const effect = Effect.succeed({edges});
      return options.bridgeFirst === true ? Effect.sleep(1).pipe(Effect.andThen(effect)) : effect;
    },
    validateEndpointAccess: candidate =>
      Effect.succeed({leased: endpointKey(candidate) !== options.blockedKey, ready: true}),
  };
}

function repository(seed: string, repositoryKey: string, monikers: readonly CodeGraphMonikerV1[]) {
  return {
    monikers,
    repositoryId: digest(`repository:${seed}`),
    repositoryKey,
    snapshotId: `cgsn_${Effect2.pipe(digest(`snapshot:${seed}`), EffectString.slice(0, 40))}`,
  } satisfies CodeGraphBridgeRepositoryV1;
}

function packageMoniker(role: 'export' | 'import', packageName: string, packageVersion: string, seed: string) {
  return codeGraphPackageMoniker({
    componentId: `cgp_${Effect2.pipe(digest(`component:${seed}`), EffectString.slice(0, 32))}`,
    ...(role === 'import' ? {dependencyKind: 'runtime' as const} : {}),
    evidence: {path: `${seed}/package.json`, span},
    packageName,
    packageVersion,
    role,
  });
}

function localEdge(
  seed: string,
  source: CodeGraphCrossRepositoryTraversalEndpointV1,
  target: CodeGraphCrossRepositoryTraversalEndpointV1,
): CodeGraphCrossRepositoryLocalEdgeV1 {
  return {confidence: 1, id: `local:${seed}`, provenance: 'resolved', relation: 'connects', source, target};
}

function endpoint(
  repository: Pick<CodeGraphBridgeRepositoryV1, 'repositoryId' | 'repositoryKey' | 'snapshotId'>,
  reference: CodeGraphCrossRepositoryTraversalEndpointV1['reference'],
): CodeGraphCrossRepositoryTraversalEndpointV1 {
  return {
    reference,
    repositoryId: repository.repositoryId,
    repositoryKey: repository.repositoryKey,
    snapshotId: repository.snapshotId,
  };
}

function endpointFromBridge(
  bridgeEndpoint: CodeGraphCrossRepositoryBridgeV1['source'],
): CodeGraphCrossRepositoryTraversalEndpointV1 {
  return {
    reference: bridgeEndpoint.reference,
    repositoryId: bridgeEndpoint.repositoryId,
    repositoryKey: bridgeEndpoint.repositoryKey,
    snapshotId: bridgeEndpoint.snapshotId,
  };
}

function endpointKey(
  value:
    | CodeGraphCrossRepositoryTraversalEndpointV1
    | {
        readonly reference: CodeGraphCrossRepositoryTraversalEndpointV1['reference'];
        readonly repositoryId: string;
        readonly snapshotId: string;
      },
): string {
  return EffectArray.join(
    [
      value.repositoryId,
      'repositoryKey' in value ? value.repositoryKey : '',
      value.snapshotId,
      value.reference.kind,
      value.reference.kind === 'component' ? value.reference.componentId : value.reference.ref,
    ],
    '\0',
  );
}

function endpointLookupKey(value: {
  readonly reference: CodeGraphCrossRepositoryTraversalEndpointV1['reference'];
  readonly repositoryId: string;
  readonly snapshotId: string;
}): string {
  return EffectArray.join(
    [
      value.repositoryId,
      value.snapshotId,
      value.reference.kind,
      value.reference.kind === 'component' ? value.reference.componentId : value.reference.ref,
    ],
    '\0',
  );
}

function qualifiedRef(seed: string): string {
  return `cgr_${Effect2.pipe(digest(`qualified:${seed}`), EffectString.slice(0, 40))}`;
}

function digest(value: string): string {
  return sha256HexSync(value);
}
