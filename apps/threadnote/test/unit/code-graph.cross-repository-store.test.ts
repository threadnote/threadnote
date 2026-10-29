import {Array as EffectArray, Option as EffectOption} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {Database} from 'bun:sqlite';
import {Effect} from 'effect';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphPackageMoniker, codeGraphProtobufMoniker} from '@threadnote/graph/cross_repository/monikers';
import {
  resolveCodeGraphCrossRepositoryBridges,
  type CodeGraphBridgeRepositoryV1,
  type CodeGraphCrossRepositoryBridgeV1,
} from '@threadnote/graph/cross_repository/resolver';
import {
  codeGraphCrossRepositoryBridgeReplacementRequiredFreeBytes,
  readCodeGraphWorksetCatalogBridgeGenerationPage,
  readCodeGraphWorksetCatalogBridgePage,
  readCodeGraphWorksetCatalogRepositoryBridgePage,
  readPublishedCodeGraphWorksetCatalogBridgeSetSummary,
  replaceCodeGraphWorksetCatalogBridgeSet,
  type CodeGraphCrossRepositoryBridgeCursorV1,
  type CodeGraphCrossRepositoryBridgePageV1,
} from '@threadnote/graph/cross_repository/store';
import {codeGraphWorksetCatalogDatabasePath} from '@threadnote/graph/workset_catalog/layout';
import {createCodeGraphWorksetRoutingProjection} from '@threadnote/graph/workset_catalog/projection';
import {
  maintainCodeGraphWorksetCatalog,
  publishCodeGraphWorksetCatalogGeneration,
  stageCodeGraphWorksetCatalogGeneration,
} from '@threadnote/graph/workset_catalog/store';
import {
  CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogGenerationMemberV1,
} from '@threadnote/graph/workset_catalog/types';
import type {CodeGraphMonikerV1} from '@threadnote/graph/cross_repository/types';
import {pathService, mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const span = {column: 1, endColumn: 12, endLine: 1, line: 1} as const;

describe('cross-repository bridge catalog', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  it('publishes bounded npm and protobuf bridge rows with indexed forward and reverse endpoint reads', async () => {
    const home = await temporaryHome(homes);
    const fixture = bridgeFixture('indexed');
    const staged = await stage(home, fixture);
    const receipt = await runEffect(
      replaceCodeGraphWorksetCatalogBridgeSet(home, {bridges: fixture.bridges, generationId: staged.id}),
    );

    expect(receipt).toMatchObject({bridgeCount: 3, generationId: staged.id, state: 'staged'});
    expect(
      await runEffect(
        readCodeGraphWorksetCatalogBridgePage(home, {
          direction: 'outgoing',
          endpoint: endpointKey(fixture.packageBridges[0].source),
          generationId: staged.id,
        }),
      ),
    ).toBeUndefined();

    await publish(home, fixture.worksetName, staged.id);
    expect(await runEffect(readPublishedCodeGraphWorksetCatalogBridgeSetSummary(home, staged.id))).toMatchObject({
      bridgeCount: 3,
      coverage: {diagnostics: [], repositoriesRead: 4, repositoryCount: 4, state: 'complete'},
      digest: receipt.digest,
      generationId: staged.id,
    });
    const topologyFirst = await runEffect(
      readCodeGraphWorksetCatalogBridgeGenerationPage(home, {generationId: staged.id, limit: 2}),
    );
    const topologySecond = await runEffect(
      readCodeGraphWorksetCatalogBridgeGenerationPage(home, {
        after: topologyFirst?.next,
        generationId: staged.id,
        limit: 2,
      }),
    );
    expect([...(topologyFirst?.bridges ?? []), ...(topologySecond?.bridges ?? [])]).toEqual(fixture.bridges);
    expect(topologySecond?.next).toBeUndefined();
    const first = await runEffect(
      readCodeGraphWorksetCatalogBridgePage(home, {
        direction: 'outgoing',
        endpoint: endpointKey(fixture.packageBridges[0].source),
        generationId: staged.id,
        limit: 1,
      }),
    );
    expect(first?.bridges).toHaveLength(1);
    expect(first?.next).toBeDefined();
    const second = await runEffect(
      readCodeGraphWorksetCatalogBridgePage(home, {
        after: first?.next,
        direction: 'outgoing',
        endpoint: endpointKey(fixture.packageBridges[0].source),
        generationId: staged.id,
        limit: 1,
      }),
    );
    expect([...(first?.bridges ?? []), ...(second?.bridges ?? [])]).toEqual(fixture.packageBridges);
    expect(second?.next).toBeUndefined();

    const repositoryPage = await runEffect(
      readCodeGraphWorksetCatalogRepositoryBridgePage(home, {
        direction: 'outgoing',
        generationId: staged.id,
        repository: {
          repositoryId: fixture.packageBridges[0].source.repositoryId,
          snapshotId: fixture.packageBridges[0].source.snapshotId,
        },
      }),
    );
    expect(repositoryPage?.bridges).toEqual(fixture.bridges);

    const protobuf = EffectOption.getOrUndefined(
      EffectArray.findFirst(fixture.bridges, bridge => bridge.resolutionDomain === 'protobuf'),
    )!;
    const incoming = await runEffect(
      readCodeGraphWorksetCatalogBridgePage(home, {
        direction: 'incoming',
        endpoint: endpointKey(protobuf.target),
        generationId: staged.id,
      }),
    );
    expect(incoming?.bridges).toEqual([protobuf]);
    expect(incoming?.bridges[0]).toMatchObject({
      source: {evidence: {path: expect.stringContaining('.proto')}, monikerId: expect.stringMatching(/^cgm_/u)},
      target: {evidence: {path: expect.stringContaining('.proto')}, monikerId: expect.stringMatching(/^cgm_/u)},
    });

    const database = new Database(catalogPath(home), {readonly: true, strict: true});
    try {
      const columns = EffectArray.map(
        database.query<{readonly name: string}, []>('PRAGMA table_info(cross_repository_bridges)').all(),
        row => row.name,
      );
      expect(columns).toEqual(
        expect.arrayContaining([
          'source_repository_id',
          'source_snapshot_id',
          'source_moniker_id',
          'source_reference',
          'source_evidence_path',
          'target_repository_id',
          'target_snapshot_id',
          'target_moniker_id',
          'target_reference',
          'target_evidence_path',
          'resolver_reason',
        ]),
      );
      expect(columns).not.toEqual(expect.arrayContaining(['source_body', 'documentation', 'signature']));
      const plan = database
        .query<{readonly detail: string}, [string, string, string, string, string]>(
          `EXPLAIN QUERY PLAN
           SELECT bridge_id FROM cross_repository_bridges
           WHERE generation_id = ? AND source_repository_id = ? AND source_snapshot_id = ?
             AND source_reference_kind = ? AND source_reference = ?`,
        )
        .all(
          staged.id,
          fixture.packageBridges[0].source.repositoryId,
          fixture.packageBridges[0].source.snapshotId,
          'component',
          fixture.packageBridges[0].source.reference.kind === 'component'
            ? fixture.packageBridges[0].source.reference.componentId
            : '',
        );
      expect(
        EffectArray.some(plan, row =>
          Effect2.pipe(row.detail, EffectString.includes('cross_repository_bridges_source_endpoint')),
        ),
      ).toBe(true);
      const repositoryPlan = database
        .query<{readonly detail: string}, [string, string, string]>(
          `EXPLAIN QUERY PLAN
           SELECT bridge_id FROM cross_repository_bridges
           WHERE generation_id = ? AND source_repository_id = ? AND source_snapshot_id = ?`,
        )
        .all(staged.id, fixture.packageBridges[0].source.repositoryId, fixture.packageBridges[0].source.snapshotId);
      expect(
        EffectArray.some(repositoryPlan, row =>
          Effect2.pipe(row.detail, EffectString.includes('cross_repository_bridges_source_endpoint')),
        ),
      ).toBe(true);
    } finally {
      database.close(false);
    }
  });

  it('publishes an empty pathless coverage receipt instead of admitting an incomplete resolver subset', async () => {
    const home = await temporaryHome(homes);
    const fixture = bridgeFixture('partial');
    const staged = await stage(home, fixture);
    const partialCoverage = {
      diagnostics: ['moniker-read-failed'] as const,
      failedRepositoryCount: 1,
      rejectionCount: 0,
      repositoriesRead: 3,
      state: 'partial' as const,
    };

    await expect(
      runEffect(
        replaceCodeGraphWorksetCatalogBridgeSet(home, {
          bridges: fixture.bridges.slice(0, 1),
          coverage: partialCoverage,
          generationId: staged.id,
        }),
      ),
    ).rejects.toMatchObject({reason: 'invalid-input'});
    await runEffect(
      replaceCodeGraphWorksetCatalogBridgeSet(home, {
        bridges: [],
        coverage: partialCoverage,
        generationId: staged.id,
      }),
    );
    await publish(home, fixture.worksetName, staged.id);

    expect(await runEffect(readPublishedCodeGraphWorksetCatalogBridgeSetSummary(home, staged.id))).toMatchObject({
      bridgeCount: 0,
      coverage: {
        diagnostics: ['moniker-read-failed'],
        failedRepositoryCount: 1,
        repositoriesRead: 3,
        repositoryCount: 4,
        state: 'partial',
      },
    });
  });

  it('rejects endpoint drift atomically and leaves a changed published generation without copied bridges', async () => {
    const home = await temporaryHome(homes);
    const fixture = bridgeFixture('invalidation');
    const staged = await stage(home, fixture);
    await runEffect(replaceCodeGraphWorksetCatalogBridgeSet(home, {bridges: fixture.bridges, generationId: staged.id}));
    await publish(home, fixture.worksetName, staged.id);

    const drifted = bridgeFixture('invalidation', {consumerSnapshot: snapshotId('invalidation-consumer-next')});
    await expect(
      runEffect(replaceCodeGraphWorksetCatalogBridgeSet(home, {bridges: drifted.bridges, generationId: staged.id})),
    ).rejects.toMatchObject({reason: 'invalid-input'} satisfies Partial<CodeGraphWorksetCatalogError>);
    expect(
      (
        await runEffect(
          readCodeGraphWorksetCatalogBridgePage(home, {
            direction: 'outgoing',
            endpoint: endpointKey(fixture.packageBridges[0].source),
            generationId: staged.id,
          }),
        )
      )?.totalBridges,
    ).toBe(fixture.bridges.length);

    const next = await stage(home, drifted);
    await publish(home, drifted.worksetName, next.id);
    expect(
      await runEffect(
        readCodeGraphWorksetCatalogBridgePage(home, {
          direction: 'outgoing',
          endpoint: endpointKey(drifted.packageBridges[0].source),
          generationId: next.id,
        }),
      ),
    ).toBeUndefined();
    expect(
      await runEffect(
        readCodeGraphWorksetCatalogBridgePage(home, {
          direction: 'outgoing',
          endpoint: endpointKey(fixture.packageBridges[0].source),
          generationId: staged.id,
        }),
      ),
    ).toBeUndefined();
    for (let page = 0; page < 8; page += 1) {
      await runEffect(maintainCodeGraphWorksetCatalog(home, {generationLimit: 8, projectionLimit: 0}));
    }
    const database = new Database(catalogPath(home), {readonly: true, strict: true});
    try {
      expect(
        database
          .query<{readonly count: number}, [string]>(
            'SELECT COUNT(*) AS count FROM cross_repository_bridge_sets WHERE generation_id = ?',
          )
          .get(staged.id)?.count,
      ).toBe(0);
    } finally {
      database.close(false);
    }
  });

  it('fails disk preflight before replacement and preserves the prior bridge set', async () => {
    const home = await temporaryHome(homes);
    const fixture = bridgeFixture('capacity');
    const staged = await stage(home, fixture);
    const first = await runEffect(
      replaceCodeGraphWorksetCatalogBridgeSet(home, {bridges: fixture.bridges, generationId: staged.id}),
    );

    await expect(
      runEffect(
        replaceCodeGraphWorksetCatalogBridgeSet(home, {
          bridges: fixture.bridges.slice(0, 1),
          diskCapacityAvailableBytes: () => Effect.succeed(0),
          generationId: staged.id,
        }),
      ),
    ).rejects.toMatchObject({reason: 'capacity'} satisfies Partial<CodeGraphWorksetCatalogError>);
    await publish(home, fixture.worksetName, staged.id);
    expect(await runEffect(readPublishedCodeGraphWorksetCatalogBridgeSetSummary(home, staged.id))).toMatchObject({
      bridgeCount: fixture.bridges.length,
      digest: first.digest,
    });
  });

  it('computes monotone bounded replacement headroom without payload-sized allocations', () => {
    fc.assert(
      fc.property(
        fc.nat({max: 64 * 1_024 * 1_024 - 1}),
        fc.nat({max: 20_000}),
        fc.nat({max: 64 * 1_024 * 1_024}),
        fc.nat({max: 20_000}),
        (existingBridgeBytes, existingBridgeCount, replacementBridgeBytes, replacementBridgeCount) => {
          const baseline = codeGraphCrossRepositoryBridgeReplacementRequiredFreeBytes({
            existingBridgeBytes,
            existingBridgeCount,
            replacementBridgeBytes,
            replacementBridgeCount,
          });
          const larger = codeGraphCrossRepositoryBridgeReplacementRequiredFreeBytes({
            existingBridgeBytes: existingBridgeBytes + 1,
            existingBridgeCount,
            replacementBridgeBytes,
            replacementBridgeCount,
          });
          expect(larger).toBeGreaterThan(baseline);
        },
      ),
      {numRuns: 100},
    );
    expect(() =>
      codeGraphCrossRepositoryBridgeReplacementRequiredFreeBytes({
        existingBridgeBytes: 0,
        existingBridgeCount: 0,
        replacementBridgeBytes: 64 * 1_024 * 1_024 + 1,
        replacementBridgeCount: 1,
      }),
    ).toThrowError(/footprint exceeds the supported bound/u);
  });

  it('makes clean and incremental bridge replacement deterministic under input order and invalidates snapshots', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({max: 10_000, min: 1}), fc.boolean(), async (seed, reverse) => {
        const cleanHome = await temporaryHome(homes);
        const incrementalHome = await temporaryHome(homes);
        const fixture = bridgeFixture(`property-${seed}`);
        const ordered = reverse ? [...fixture.bridges].reverse() : [...fixture.bridges];
        const [cleanStage, incrementalStage] = await Promise.all([
          stage(cleanHome, fixture),
          stage(incrementalHome, fixture),
        ]);
        const cleanReceipt = await runEffect(
          replaceCodeGraphWorksetCatalogBridgeSet(cleanHome, {
            bridges: ordered,
            generationId: cleanStage.id,
          }),
        );
        expect(cleanReceipt.digest).toBe(
          sha256HexSync(
            EffectArray.join(
              [
                'threadnote-cross-repository-bridge-set-v1',
                ...EffectArray.map(fixture.bridges, bridge => JSON.stringify(bridge)),
              ],
              '\n',
            ),
          ),
        );
        await runEffect(
          replaceCodeGraphWorksetCatalogBridgeSet(incrementalHome, {
            bridges: ordered.slice(0, 1),
            generationId: incrementalStage.id,
          }),
        );
        const incrementalReceipt = await runEffect(
          replaceCodeGraphWorksetCatalogBridgeSet(incrementalHome, {
            bridges: [...ordered].reverse(),
            generationId: incrementalStage.id,
          }),
        );
        expect(incrementalReceipt.digest).toBe(cleanReceipt.digest);
        await Promise.all([
          publish(cleanHome, fixture.worksetName, cleanStage.id),
          publish(incrementalHome, fixture.worksetName, incrementalStage.id),
        ]);
        expect(await collectEndpoint(cleanHome, cleanStage.id, fixture.packageBridges[0])).toEqual(
          await collectEndpoint(incrementalHome, incrementalStage.id, fixture.packageBridges[0]),
        );

        const changed = bridgeFixture(`property-${seed}`, {
          consumerSnapshot: snapshotId(`property-${seed}-next`),
        });
        const changedStage = await stage(cleanHome, changed);
        await expect(
          runEffect(
            replaceCodeGraphWorksetCatalogBridgeSet(cleanHome, {
              bridges: fixture.bridges,
              generationId: changedStage.id,
            }),
          ),
        ).rejects.toMatchObject({reason: 'invalid-input'});
      }),
      {numRuns: 8},
    );
  });
});

interface BridgeFixture {
  readonly bridges: readonly CodeGraphCrossRepositoryBridgeV1[];
  readonly members: readonly CodeGraphWorksetCatalogGenerationMemberV1[];
  readonly packageBridges: readonly CodeGraphCrossRepositoryBridgeV1[];
  readonly worksetName: string;
}

function bridgeFixture(seed: string, options: {readonly consumerSnapshot?: string} = {}): BridgeFixture {
  const consumerComponent = componentId(`${seed}:consumer`);
  const consumer = repository(
    `${seed}:consumer`,
    'apps/consumer',
    [
      packageMoniker('import', '@acme/alpha', '^1.0.0', `${seed}:alpha-import`, consumerComponent),
      packageMoniker('import', '@acme/beta', '^2.0.0', `${seed}:beta-import`, consumerComponent),
      codeGraphProtobufMoniker({
        evidence: {path: `proto/${seed}-consumer.proto`, span},
        kind: 'service',
        packageName: 'acme.orders.v1',
        qualifiedName: 'acme.orders.v1.Orders',
        role: 'import',
        symbolId: symbolId(`${seed}:proto-import`),
      }),
    ],
    options.consumerSnapshot,
  );
  const alpha = repository(`${seed}:alpha`, 'packages/alpha', [
    packageMoniker('export', '@acme/alpha', '1.5.0', `${seed}:alpha-export`),
  ]);
  const beta = repository(`${seed}:beta`, 'packages/beta', [
    packageMoniker('export', '@acme/beta', '2.1.0', `${seed}:beta-export`),
  ]);
  const protobuf = repository(`${seed}:protobuf`, 'services/orders', [
    codeGraphProtobufMoniker({
      evidence: {path: `proto/${seed}-producer.proto`, span},
      kind: 'service',
      packageName: 'acme.orders.v1',
      qualifiedName: 'acme.orders.v1.Orders',
      role: 'export',
      symbolId: symbolId(`${seed}:proto-export`),
    }),
  ]);
  const repositories = [consumer, alpha, beta, protobuf];
  const resolution = resolveCodeGraphCrossRepositoryBridges(repositories);
  if (resolution.rejections.length > 0 || resolution.bridges.length !== 3)
    throw TestError.make({message: 'Invalid test fixture.'});
  return {
    bridges: resolution.bridges,
    members: EffectArray.map(repositories, (repository, index) => member(repository, index)),
    packageBridges: EffectArray.filter(resolution.bridges, bridge => bridge.resolutionDomain === 'package:npm'),
    worksetName: `engineering-${seed}`,
  };
}

function repository(
  seed: string,
  repositoryKey: string,
  monikers: readonly CodeGraphMonikerV1[],
  snapshot = snapshotId(seed),
): CodeGraphBridgeRepositoryV1 {
  return {monikers, repositoryId: digest(`repository:${seed}`), repositoryKey, snapshotId: snapshot};
}

function packageMoniker(
  role: 'export' | 'import',
  packageName: string,
  packageVersion: string,
  seed: string,
  component = componentId(seed),
) {
  return codeGraphPackageMoniker({
    componentId: component,
    ...(role === 'import' ? {dependencyKind: 'runtime' as const} : {}),
    evidence: {path: `packages/${seed}/package.json`, span},
    packageName,
    packageVersion,
    role,
  });
}

function member(repository: CodeGraphBridgeRepositoryV1, ordinal: number): CodeGraphWorksetCatalogGenerationMemberV1 {
  return {
    projection: createCodeGraphWorksetRoutingProjection({
      checkoutId: digest(`checkout:${repository.repositoryKey}:${repository.snapshotId}`),
      commitId: Effect2.pipe(
        digest(`commit:${repository.repositoryKey}:${repository.snapshotId}`),
        EffectString.slice(0, 40),
      ),
      componentCount: 1,
      extractorGeneration: 13,
      projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
      repositoryId: repository.repositoryId,
      snapshotDigest: digest(`snapshot-digest:${repository.snapshotId}`),
      snapshotId: repository.snapshotId,
      symbols: [
        {
          exported: true,
          kind: 'function',
          language: 'typescript',
          lookupKeys: [`fixture.${ordinal}`],
          name: `fixture${ordinal}`,
          nodeId: symbolId(`routing:${repository.repositoryKey}:${repository.snapshotId}`),
          path: `src/fixture-${ordinal}.ts`,
          qualifiedName: `fixture.${ordinal}`,
          span: {column: 0, endColumn: 7, endLine: 1, line: 1},
          terms: [{term: `fixture-${ordinal}`, weight: 1}],
        },
      ],
      worktreeId: digest(`worktree:${repository.repositoryKey}:${repository.snapshotId}`),
    }),
    repositoryKey: repository.repositoryKey,
  };
}

async function stage(home: string, fixture: BridgeFixture) {
  return runEffect(
    stageCodeGraphWorksetCatalogGeneration(home, {
      manifestDigest: digest(
        `manifest:${fixture.worksetName}:${EffectArray.join(
          EffectArray.map(fixture.members, entry => entry.projection.snapshotId),
          ':',
        )}`,
      ),
      members: fixture.members,
      worksetName: fixture.worksetName,
    }),
  );
}

async function publish(home: string, worksetName: string, generationId: string) {
  await runEffect(publishCodeGraphWorksetCatalogGeneration(home, {generationId, worksetName}));
}

async function collectEndpoint(home: string, generationId: string, bridge: CodeGraphCrossRepositoryBridgeV1) {
  const collected: CodeGraphCrossRepositoryBridgeV1[] = [];
  let after: CodeGraphCrossRepositoryBridgeCursorV1 | undefined;
  for (;;) {
    const page: CodeGraphCrossRepositoryBridgePageV1 | undefined = await runEffect(
      readCodeGraphWorksetCatalogBridgePage(home, {
        ...(after === undefined ? {} : {after}),
        direction: 'outgoing',
        endpoint: endpointKey(bridge.source),
        generationId,
        limit: 1,
      }),
    );
    if (page === undefined) return collected;
    collected.push(...page.bridges);
    if (page.next === undefined) return collected;
    after = page.next;
  }
}

function endpointKey(endpoint: CodeGraphCrossRepositoryBridgeV1['source']) {
  return {reference: endpoint.reference, repositoryId: endpoint.repositoryId, snapshotId: endpoint.snapshotId};
}

async function temporaryHome(homes: string[]): Promise<string> {
  const home = await mkdtemp('threadnote-cross-repository-store-');
  homes.push(home);
  return home;
}

function catalogPath(home: string): string {
  return codeGraphWorksetCatalogDatabasePath(pathService, home);
}

function componentId(seed: string): string {
  return `cgp_${Effect2.pipe(digest(`component:${seed}`), EffectString.slice(0, 32))}`;
}

function symbolId(seed: string): string {
  return `cgs_${Effect2.pipe(digest(`symbol:${seed}`), EffectString.slice(0, 32))}`;
}

function snapshotId(seed: string): string {
  return `cgsn_${Effect2.pipe(digest(`snapshot:${seed}`), EffectString.slice(0, 40))}`;
}

function digest(value: string): string {
  return sha256HexSync(value);
}
