import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {Cause, Effect, Exit, FileSystem, Layer} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {describe, expect, it, vi} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {CodeGraphEvidenceCardV1} from '@threadnote/graph/workset/evidence';
import {
  normalizeCodeGraphWorksetRouterQuery,
  type CodeGraphWorksetRouterResultV1,
} from '@threadnote/graph/workset/router';
import {
  attachCodeGraphWorksetBridgeRelationships,
  expandCodeGraphWorksetRouterWithBridges,
  readCodeGraphWorksetQueryBridgeExpansion,
} from '@threadnote/graph/cross_repository/query_expansion';
import type {
  CodeGraphBridgeEndpointV1,
  CodeGraphCrossRepositoryBridgeV1,
} from '@threadnote/graph/cross_repository/resolver';
import type {
  CodeGraphCrossRepositoryBridgeCoverageV1,
  CodeGraphCrossRepositoryBridgePageV1,
} from '@threadnote/graph/cross_repository/store';
import {
  findCodeGraphCrossRepositoryPath,
  type CodeGraphCrossRepositoryTraversalDependencies,
  type CodeGraphCrossRepositoryTraversalEndpointV1,
} from '@threadnote/graph/cross_repository/traversal';
import {findCodeGraphWorksetPath, inspectCodeGraphWorksetTopology} from '@threadnote/graph/cross_repository/runtime';
import type {ApplicationServices} from '@threadnote/threadnote/effect/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const mocks = vi.hoisted(() => ({
  expandPath: vi.fn(),
  generationMatches: vi.fn(),
  manifestDigest: vi.fn(),
  acquireLease: vi.fn(),
  readBridgeGenerationPage: vi.fn(),
  readBridgePage: vi.fn(),
  readRepositoryBridgePage: vi.fn(),
  readBridgeSummary: vi.fn(),
  readPublishedGeneration: vi.fn(),
  projectionContainsNode: vi.fn(),
  registerQualifiedRef: vi.fn(),
  releaseLease: vi.fn(),
  requireWorkset: vi.fn(),
  resolveQualifiedRef: vi.fn(),
  status: vi.fn(),
}));

vi.mock('@threadnote/workspace/manifest', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/workspace/manifest')>()),
  requireWorkset: mocks.requireWorkset,
}));

vi.mock('@threadnote/platform/paths', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/platform/paths')>()),
  expandPath: mocks.expandPath,
}));

vi.mock('@threadnote/graph/workset_catalog/workset', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/graph/workset_catalog/workset')>()),
  codeGraphWorksetCatalogGenerationMatches: mocks.generationMatches,
  codeGraphWorksetManifestDigest: mocks.manifestDigest,
}));

vi.mock('@threadnote/graph/workset_catalog/store', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/graph/workset_catalog/store')>()),
  readPublishedCodeGraphWorksetCatalogGeneration: mocks.readPublishedGeneration,
  codeGraphWorksetCatalogProjectionContainsNode: mocks.projectionContainsNode,
  registerCodeGraphQualifiedRef: mocks.registerQualifiedRef,
  resolveCodeGraphQualifiedRef: mocks.resolveQualifiedRef,
}));

vi.mock('@threadnote/graph/cross_repository/store', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/graph/cross_repository/store')>()),
  readCodeGraphWorksetCatalogBridgeGenerationPage: mocks.readBridgeGenerationPage,
  readCodeGraphWorksetCatalogBridgePage: mocks.readBridgePage,
  readCodeGraphWorksetCatalogRepositoryBridgePage: mocks.readRepositoryBridgePage,
  readPublishedCodeGraphWorksetCatalogBridgeSetSummary: mocks.readBridgeSummary,
}));

const generationId = `cgwg_${Effect2.pipe('a', EffectString.repeat(40))}`;
const span = {column: 1, endColumn: 8, endLine: 1, line: 1} as const;

describe('cross-repository graph runtime safety', () => {
  it('fails closed instead of treating incomplete bridge coverage as complete adjacency', async () => {
    const bridge = packageBridge('orders');
    const partialCoverage: CodeGraphCrossRepositoryBridgeCoverageV1 = {
      diagnostics: ['moniker-read-failed'],
      failedRepositoryCount: 1,
      rejectionCount: 0,
      repositoriesRead: 1,
      repositoryCount: 2,
      state: 'partial',
    };
    const dependencies = traversalDependencies(() =>
      Effect.succeed(bridgePage({bridges: [], coverage: partialCoverage, digest: digest('partial'), totalBridges: 0})),
    );

    await expect(
      runEffect(
        findCodeGraphCrossRepositoryPath(dependencies, {
          bridgeSet: {digest: digest('partial'), totalBridges: 0},
          generationId,
          maxDepth: 4,
          maxEdges: 16,
          start: traversalEndpoint(bridge.source),
          target: traversalEndpoint(bridge.target),
        }),
      ),
    ).rejects.toThrow(/bridge|coverage|complete/iu);
  });

  it.each([
    {
      label: 'digest',
      secondDigest: digest('replacement'),
      secondTotalBridges: 2,
    },
    {
      label: 'count',
      secondDigest: digest('original'),
      secondTotalBridges: 3,
    },
  ])('rejects $label drift across bridge pages in one traversal', async ({secondDigest, secondTotalBridges}) => {
    const first = packageBridge('orders');
    const second = packageBridge('billing', first.source);
    let page = 0;
    const dependencies = traversalDependencies(() => {
      page += 1;
      return page === 1
        ? Effect.succeed(
            bridgePage({
              bridges: [first],
              digest: digest('original'),
              next: {bridgeId: first.id, ordinal: 0},
              totalBridges: 2,
            }),
          )
        : Effect.succeed(
            bridgePage({
              bridges: [second],
              digest: secondDigest,
              totalBridges: secondTotalBridges,
            }),
          );
    });

    await expect(
      runEffect(
        findCodeGraphCrossRepositoryPath(dependencies, {
          bridgeSet: {digest: digest('original'), totalBridges: 2},
          generationId,
          maxDepth: 4,
          maxEdges: 16,
          start: traversalEndpoint(first.source),
          target: traversalEndpoint(first.target),
        }),
      ),
    ).rejects.toThrow(/bridge|changed|count|digest|receipt/iu);
  });

  effectIt.effect('rejects ambiguous or unknown component selectors before reading graph adjacency', () =>
    Effect.gen(function* () {
      const fixture = runtimeFixture(2);
      configureRuntimeMocks(fixture);

      const ambiguous = yield* runRuntime(
        findCodeGraphWorksetPath(config, {
          from: `cgp_${Effect2.pipe('a', EffectString.repeat(32))}`,
          to: `${fixture.members[0].repositoryKey}:cgp_${Effect2.pipe('b', EffectString.repeat(32))}`,
          worksetName: 'engineering',
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(ambiguous)).toBe(true);
      if (Exit.isFailure(ambiguous)) expect(Cause.pretty(ambiguous.cause)).toMatch(/multi-repository workset/iu);

      const unknown = yield* runRuntime(
        findCodeGraphWorksetPath(config, {
          from: `unknown:cgp_${Effect2.pipe('a', EffectString.repeat(32))}`,
          to: `${fixture.members[0].repositoryKey}:cgp_${Effect2.pipe('b', EffectString.repeat(32))}`,
          worksetName: 'engineering',
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(unknown)).toBe(true);
      if (Exit.isFailure(unknown)) expect(Cause.pretty(unknown.cause)).toMatch(/unknown generation member/iu);
      expect(mocks.readBridgePage).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect('rejects a qualified reference whose repository is outside the published generation', () =>
    Effect.gen(function* () {
      const fixture = runtimeFixture(2);
      configureRuntimeMocks(fixture);
      const ref = `cgr_${Effect2.pipe('c', EffectString.repeat(40))}`;
      mocks.resolveQualifiedRef.mockReturnValue(
        Effect.succeed({
          nodeId: `cgs_${Effect2.pipe('d', EffectString.repeat(32))}`,
          ref,
          repositoryId: digest('outside-generation'),
        }),
      );

      const result = yield* runRuntime(
        findCodeGraphWorksetPath(config, {
          from: ref,
          to: `${fixture.members[0].repositoryKey}:cgp_${Effect2.pipe('b', EffectString.repeat(32))}`,
          worksetName: 'engineering',
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toMatch(/not in this workset generation/iu);
      expect(mocks.readBridgePage).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect('rejects a historical qualified reference missing from the published snapshot projection', () =>
    Effect.gen(function* () {
      const fixture = runtimeFixture(2);
      configureRuntimeMocks(fixture);
      const ref = `cgr_${Effect2.pipe('c', EffectString.repeat(40))}`;
      mocks.resolveQualifiedRef.mockReturnValue(
        Effect.succeed({
          nodeId: `cgs_${Effect2.pipe('d', EffectString.repeat(32))}`,
          ref,
          repositoryId: fixture.members[0].repositoryId,
        }),
      );
      mocks.projectionContainsNode.mockReturnValue(Effect.succeed(false));

      const result = yield* runRuntime(
        findCodeGraphWorksetPath(config, {
          from: ref,
          to: `${fixture.members[1].repositoryKey}:cgp_${Effect2.pipe('b', EffectString.repeat(32))}`,
          worksetName: 'engineering',
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toMatch(/not present|published snapshot|stale/iu);
      expect(mocks.readBridgePage).not.toHaveBeenCalled();
    }),
  );

  it('withholds query neighbor expansion when the published bridge receipt is incomplete', async () => {
    const fixture = runtimeFixture(2);
    configureRuntimeMocks(fixture);
    mocks.readBridgeSummary.mockReturnValue(
      Effect.succeed({
        ...completeBridgeSummary(0),
        coverage: {
          diagnostics: ['moniker-read-failed'],
          failedRepositoryCount: 1,
          rejectionCount: 0,
          repositoriesRead: 1,
          repositoryCount: 2,
          state: 'partial',
        },
      }),
    );

    const expansion = await runEffect(
      readCodeGraphWorksetQueryBridgeExpansion('/threadnote-home', fixture.published, routerFixture(fixture)),
    );
    expect(expansion).toMatchObject({bridges: [], complete: false});
    expect(expansion.warnings).toEqual([expect.stringMatching(/incomplete/iu)]);
    expect(mocks.readRepositoryBridgePage).not.toHaveBeenCalled();
  });

  it('rejects a drifted query-neighbor bridge page instead of degrading it into evidence', async () => {
    const fixture = runtimeFixture(2);
    configureRuntimeMocks(fixture);
    const bridge = packageBridgeForMembers('orders', fixture.members[0], fixture.members[1]);
    mocks.readBridgeSummary.mockReturnValue(Effect.succeed(completeBridgeSummary(1)));
    mocks.readRepositoryBridgePage.mockReturnValue(
      Effect.succeed(bridgePage({bridges: [bridge], digest: digest('replacement-runtime-set'), totalBridges: 1})),
    );

    await expect(
      runEffect(
        readCodeGraphWorksetQueryBridgeExpansion('/threadnote-home', fixture.published, routerFixture(fixture)),
      ),
    ).rejects.toThrow(/changed|incomplete/iu);
  });

  it('rejects injected query-expansion bridges whose endpoint is outside the generation', () => {
    const fixture = runtimeFixture(2);
    const router = routerFixture(fixture);
    expect(() =>
      expandCodeGraphWorksetRouterWithBridges(router, fixture.published, {
        bridgeSet: {digest: digest('runtime-set'), generationId, totalBridges: 1},
        bridges: [packageBridge('outside')],
        complete: true,
        seededRepositories: 1,
        warnings: [],
      }),
    ).toThrow(/outside the published generation/iu);
  });

  it('suppresses a protobuf bridge relationship when either endpoint snapshot is unusable', () => {
    const fixture = runtimeFixture(2);
    const bridge = protobufBridgeForMembers(fixture.members[0], fixture.members[1]);
    if (bridge.source.reference.kind !== 'qualified-ref')
      throw TestError.make({message: 'Invalid protobuf fixture source.'});
    const card = evidenceCard(bridge.source.reference.ref, fixture.members[0].repositoryKey);

    expect(
      attachCodeGraphWorksetBridgeRelationships([card], [bridge], new Set([fixture.members[0].repositoryKey]))[0]
        ?.relationships,
    ).toEqual([]);
    expect(
      attachCodeGraphWorksetBridgeRelationships(
        [card],
        [bridge],
        new Set(EffectArray.map(fixture.members, member => member.repositoryKey)),
      )[0]?.relationships,
    ).toEqual([expect.objectContaining({provenance: 'declared', relation: 'imports'})]);
  });

  effectIt.effect('withholds topology on incomplete coverage without reading any bridge page', () =>
    Effect.gen(function* () {
      const fixture = runtimeFixture(2);
      configureRuntimeMocks(fixture);
      mocks.readBridgeSummary.mockReturnValue(
        Effect.succeed({
          bridgeCount: 0,
          coverage: {
            diagnostics: ['moniker-read-failed'],
            failedRepositoryCount: 1,
            rejectionCount: 0,
            repositoriesRead: 1,
            repositoryCount: 2,
            state: 'partial',
          },
          digest: digest('partial-runtime'),
          generationId,
          resolverVersion: 1,
          worksetName: 'engineering',
        }),
      );

      const result = yield* runRuntime(inspectCodeGraphWorksetTopology(config, {worksetName: 'engineering'}));
      expect(result).toMatchObject({state: 'unavailable', warnings: [expect.stringMatching(/incomplete/iu)]});
      expect(mocks.readBridgeGenerationPage).not.toHaveBeenCalled();
      expect(mocks.status).toHaveBeenCalledTimes(2);
      expect(EffectArray.every(mocks.status.mock.calls, call => call[2]?.requestMaintenance === false)).toBe(true);
    }),
  );

  effectIt.effect('fences topology assembly against a changed page receipt', () =>
    Effect.gen(function* () {
      const fixture = runtimeFixture(2);
      configureRuntimeMocks(fixture);
      const first = packageBridge('orders');
      const second = packageBridge('billing', first.source);
      mocks.readBridgeSummary.mockReturnValue(Effect.succeed(completeBridgeSummary(2)));
      mocks.readBridgeGenerationPage
        .mockReturnValueOnce(
          Effect.succeed(
            bridgePage({
              bridges: [first],
              digest: digest('runtime-set'),
              next: {bridgeId: first.id, ordinal: 0},
              totalBridges: 2,
            }),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(bridgePage({bridges: [second], digest: digest('replacement-runtime-set'), totalBridges: 2})),
        );

      const result = yield* runRuntime(inspectCodeGraphWorksetTopology(config, {worksetName: 'engineering'})).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toMatch(/changed|unavailable/iu);
    }),
  );
});

const config: RuntimeConfig = {
  account: 'test',
  agentContextHome: '/threadnote-home',
  agentId: 'test-agent',
  manifestPath: '/manifest.yaml',
  user: 'test-user',
};

interface RuntimeFixture {
  readonly members: readonly ReturnType<typeof publishedMember>[];
  readonly published: {
    readonly digest: string;
    readonly id: string;
    readonly manifestDigest: string;
    readonly members: readonly ReturnType<typeof publishedMember>[];
    readonly worksetName: string;
  };
  readonly statuses: ReadonlyMap<string, ReturnType<typeof memberStatus>>;
  readonly workset: {
    readonly name: string;
    readonly projects: readonly {readonly name: string; readonly path: string; readonly uri: string}[];
    readonly unresolvedProjects: readonly string[];
  };
}

function runtimeFixture(memberCount: number): RuntimeFixture {
  const members = Array.from({length: memberCount}, (_, index) => publishedMember(index));
  const projects = EffectArray.map(members, (member, index) => ({
    name: member.repositoryKey,
    path: `/repositories/${index}`,
    uri: `threadnote://resources/repos/${index}`,
  }));
  return {
    members,
    published: {
      digest: digest('published-generation'),
      id: generationId,
      manifestDigest: digest('manifest'),
      members,
      worksetName: 'engineering',
    },
    statuses: new Map(EffectArray.map(projects, (project, index) => [project.path, memberStatus(members[index])])),
    workset: {name: 'engineering', projects, unresolvedProjects: []},
  };
}

function configureRuntimeMocks(fixture: RuntimeFixture): void {
  vi.clearAllMocks();
  mocks.requireWorkset.mockReturnValue(Effect.succeed(fixture.workset));
  mocks.expandPath.mockImplementation((value: string) => Effect.succeed(value));
  mocks.manifestDigest.mockReturnValue(digest('manifest'));
  mocks.generationMatches.mockReturnValue(true);
  mocks.readPublishedGeneration.mockReturnValue(Effect.succeed(fixture.published));
  mocks.projectionContainsNode.mockReturnValue(Effect.succeed(true));
  mocks.readBridgeSummary.mockReturnValue(Effect.succeed(completeBridgeSummary(0)));
  mocks.readBridgeGenerationPage.mockReturnValue(
    Effect.succeed(bridgePage({bridges: [], digest: digest('runtime-set'), totalBridges: 0})),
  );
  mocks.readBridgePage.mockReturnValue(
    Effect.succeed(bridgePage({bridges: [], digest: digest('runtime-set'), totalBridges: 0})),
  );
  mocks.readRepositoryBridgePage.mockReturnValue(
    Effect.succeed(bridgePage({bridges: [], digest: digest('runtime-set'), totalBridges: 0})),
  );
  mocks.registerQualifiedRef.mockReturnValue(Effect.void);
  mocks.resolveQualifiedRef.mockReturnValue(
    Effect.fail(TestError.make({message: 'Qualified reference not registered.'})),
  );
  mocks.status.mockImplementation((_home: string, cwd: string) => {
    const status = fixture.statuses.get(cwd);
    return status === undefined
      ? Effect.fail(TestError.make({message: 'Unknown fixture path.'}))
      : Effect.succeed(status);
  });
  mocks.acquireLease.mockReturnValue(Effect.succeed('lease-token'));
  mocks.releaseLease.mockReturnValue(Effect.void);
}

function runRuntime<A, E>(effect: Effect.Effect<A, E, ApplicationServices>): Effect.Effect<A, unknown, never> {
  const fs = FileSystem.makeNoop({exists: () => Effect.succeed(true)});
  const graphServices = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fs),
    Layer.mock(CodeGraphQueryService, {status: mocks.status}),
    Layer.mock(CodeGraphStore, {
      acquireSnapshotLease: mocks.acquireLease,
      releaseSnapshotLease: mocks.releaseLease,
    }),
  );
  return effect.pipe(provideTestLayer(Layer.merge(ApplicationLayer, graphServices)));
}

function publishedMember(index: number) {
  const seed = String(index);
  return {
    checkoutId: digest(`checkout:${seed}`),
    commitId: Effect2.pipe(digest(`commit:${seed}`), EffectString.slice(0, 40)),
    ordinal: index,
    projectionDigest: digest(`projection:${seed}`),
    repositoryId: digest(`runtime-repository:${seed}`),
    repositoryKey: `repository-${index}`,
    snapshotDigest: digest(`snapshot-digest:${seed}`),
    snapshotId: `cgsn_${Effect2.pipe(digest(`runtime-snapshot:${seed}`), EffectString.slice(0, 40))}`,
    symbolCount: 1,
    worktreeId: digest(`worktree:${seed}`),
  } as const;
}

function memberStatus(member: ReturnType<typeof publishedMember>) {
  return {
    databasePath: `/databases/${member.ordinal}.sqlite`,
    freshness: 'current' as const,
    identity: {
      checkoutId: member.checkoutId,
      repositoryId: member.repositoryId,
      worktreeId: member.worktreeId,
    },
    languagePacks: [],
    readySnapshot: {
      commit: member.commitId,
      id: member.snapshotId,
      state: 'ready' as const,
    },
    stale: false,
  };
}

function completeBridgeSummary(bridgeCount: number) {
  return {
    bridgeCount,
    coverage: {
      diagnostics: [],
      failedRepositoryCount: 0,
      rejectionCount: 0,
      repositoriesRead: 2,
      repositoryCount: 2,
      state: 'complete' as const,
    },
    digest: digest('runtime-set'),
    generationId,
    resolverVersion: 1 as const,
    worksetName: 'engineering',
  };
}

function routerFixture(fixture: RuntimeFixture): CodeGraphWorksetRouterResultV1 {
  const repositories = EffectArray.map(fixture.members, (member, index) => ({
    bestSymbolKey: `symbol-${index}`,
    exactSymbolCount: 0,
    matchingSymbolCount: 1,
    projectionDigest: member.projectionDigest,
    rank: index + 1,
    repositoryId: member.repositoryId,
    repositoryKey: member.repositoryKey,
    score: 100 - index,
    scoreReceipt: {
      bestSymbolContribution: 100 - index,
      exactMatchContribution: 0,
      supportingSymbolContribution: 0,
      total: 100 - index,
      version: 1 as const,
    },
    snapshotId: member.snapshotId,
  }));
  return {
    coverage: {
      consideredMemberCount: repositories.length,
      eligibleMemberCount: repositories.length,
      source: 'catalog-index',
      state: 'complete',
    },
    expansion: {exhausted: true, repositories, requestedBatchSize: 16},
    generationId,
    query: normalizeCodeGraphWorksetRouterQuery('service'),
    repositories,
    retrieval: {
      candidateLimitPerLane: 128,
      exactHits: 0,
      exactLaneExhausted: true,
      lexicalHits: repositories.length,
      lexicalLaneExhausted: true,
    },
    symbols: [],
    uncertainty: {reasons: [], shouldExpand: false, state: 'confident'},
    version: 1,
    worksetName: 'engineering',
  };
}

function packageBridgeForMembers(
  seed: string,
  sourceMember: ReturnType<typeof publishedMember>,
  targetMember: ReturnType<typeof publishedMember>,
): CodeGraphCrossRepositoryBridgeV1 {
  const identity = `package:npm:@acme/${seed}`;
  return {
    confidence: 1,
    id: `cgb_${digest(`runtime-bridge:${seed}`)}`,
    identity,
    kind: 'package',
    provenance: 'declared',
    relation: 'depends_on',
    resolutionDomain: 'package:npm',
    resolver: {name: 'threadnote-native-moniker', reason: 'declared-npm-package-compatible', version: 1},
    source: endpoint(seed, 'import', sourceMember, identity, {
      componentId: `cgp_${Effect2.pipe(digest(`runtime-component:${sourceMember.repositoryId}`), EffectString.slice(0, 32))}`,
      kind: 'component',
    }),
    target: endpoint(seed, 'export', targetMember, identity, {
      componentId: `cgp_${Effect2.pipe(digest(`runtime-component:${targetMember.repositoryId}`), EffectString.slice(0, 32))}`,
      kind: 'component',
    }),
    version: 1,
  };
}

function protobufBridgeForMembers(
  sourceMember: ReturnType<typeof publishedMember>,
  targetMember: ReturnType<typeof publishedMember>,
): CodeGraphCrossRepositoryBridgeV1 {
  const identity = 'protobuf:service:fixture.SessionService';
  const seed = 'session-service';
  return {
    confidence: 1,
    id: `cgb_${digest(`runtime-bridge:${seed}`)}`,
    identity,
    kind: 'service',
    provenance: 'declared',
    relation: 'imports',
    resolutionDomain: 'protobuf',
    resolver: {name: 'threadnote-native-moniker', reason: 'exact-protobuf-identity', version: 1},
    source: endpoint(seed, 'import', sourceMember, identity, {
      kind: 'qualified-ref',
      ref: `cgr_${Effect2.pipe(digest('runtime-source-ref'), EffectString.slice(0, 40))}`,
    }),
    target: endpoint(seed, 'export', targetMember, identity, {
      kind: 'qualified-ref',
      ref: `cgr_${Effect2.pipe(digest('runtime-target-ref'), EffectString.slice(0, 40))}`,
    }),
    version: 1,
  };
}

function evidenceCard(ref: string, repositoryKey: string): CodeGraphEvidenceCardV1 {
  return {
    id: `cge_${Effect2.pipe(digest(`card:${ref}`), EffectString.slice(0, 40))}`,
    reason: {score: 1, signals: ['exact-name'], summary: 'Exact symbol match.'},
    ref,
    relationships: [],
    repositoryKey,
    symbol: {
      kind: 'service',
      language: 'protobuf',
      name: 'SessionService',
      path: 'proto/session.proto',
      qualifiedName: 'fixture.SessionService',
      span,
    },
  };
}

function traversalDependencies(
  readBridgePage: CodeGraphCrossRepositoryTraversalDependencies['readBridgePage'],
): CodeGraphCrossRepositoryTraversalDependencies {
  return {
    monotonicMilliseconds: () => 0,
    readBridgePage,
    readLocalPage: () => Effect.succeed({edges: []}),
    validateEndpointAccess: () => Effect.succeed({leased: true, ready: true}),
  };
}

function bridgePage(input: {
  readonly bridges: readonly CodeGraphCrossRepositoryBridgeV1[];
  readonly coverage?: CodeGraphCrossRepositoryBridgeCoverageV1;
  readonly digest: string;
  readonly next?: {readonly bridgeId: string; readonly ordinal: number};
  readonly totalBridges: number;
}): CodeGraphCrossRepositoryBridgePageV1 {
  return {
    bridgeSetDigest: input.digest,
    bridges: input.bridges,
    coverage:
      input.coverage ??
      ({
        diagnostics: [],
        failedRepositoryCount: 0,
        rejectionCount: 0,
        repositoriesRead: 2,
        repositoryCount: 2,
        state: 'complete',
      } as const),
    generationId,
    ...(input.next === undefined ? {} : {next: input.next}),
    resolverVersion: 1,
    totalBridges: input.totalBridges,
    worksetName: 'engineering',
  };
}

function packageBridge(seed: string, sourceOverride?: CodeGraphBridgeEndpointV1): CodeGraphCrossRepositoryBridgeV1 {
  const consumer = repository('consumer', 'apps/consumer');
  const producer = repository(seed, `packages/${seed}`);
  const identity = `package:npm:@acme/${seed}`;
  return {
    confidence: 1,
    id: `cgb_${digest(`bridge:${seed}`)}`,
    identity,
    kind: 'package',
    provenance: 'declared',
    relation: 'depends_on',
    resolutionDomain: 'package:npm',
    resolver: {name: 'threadnote-native-moniker', reason: 'declared-npm-package-compatible', version: 1},
    source:
      sourceOverride ??
      endpoint(seed, 'import', consumer, identity, {
        componentId: `cgp_${Effect2.pipe(digest('component:consumer'), EffectString.slice(0, 32))}`,
        kind: 'component',
      }),
    target: endpoint(seed, 'export', producer, identity, {
      componentId: `cgp_${Effect2.pipe(digest(`component:${seed}`), EffectString.slice(0, 32))}`,
      kind: 'component',
    }),
    version: 1,
  };
}

function endpoint(
  seed: string,
  role: 'export' | 'import',
  repositoryValue: ReturnType<typeof repository>,
  identity: string,
  reference: CodeGraphBridgeEndpointV1['reference'],
): CodeGraphBridgeEndpointV1 {
  return {
    evidence: {path: `${role}/${seed}.contract`, span},
    identity,
    monikerId: `cgm_${digest(`moniker:${role}:${seed}`)}`,
    reference,
    ...repositoryValue,
    role,
  };
}

function traversalEndpoint(endpointValue: CodeGraphBridgeEndpointV1): CodeGraphCrossRepositoryTraversalEndpointV1 {
  return {
    reference: endpointValue.reference,
    repositoryId: endpointValue.repositoryId,
    repositoryKey: endpointValue.repositoryKey,
    snapshotId: endpointValue.snapshotId,
  };
}

function repository(seed: string, repositoryKey: string) {
  return {
    repositoryId: digest(`repository:${seed}`),
    repositoryKey,
    snapshotId: `cgsn_${Effect2.pipe(digest(`snapshot:${seed}`), EffectString.slice(0, 40))}`,
  } as const;
}

function digest(value: string): string {
  return sha256HexSync(value);
}
