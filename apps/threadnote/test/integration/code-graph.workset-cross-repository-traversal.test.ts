import {Array as EffectArray, Option as EffectOption} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {appendFile} from '@threadnote/testing/node-fs-promises';
import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {
  codeGraphWorksetRuntimeConfig,
  indexPreparedCodeGraphWorksetFixture,
  publishIndexedCodeGraphWorksetCatalog,
} from '../../../../scripts/support/code-graph-workset-harness.js';
import {
  prepareCodeGraphWorksetFixture,
  removePreparedCodeGraphWorksetFixture,
  type PreparedCodeGraphWorksetFixture,
} from '../../../../scripts/support/code-graph-workset-fixture.js';
import type {
  CodeGraphBridgeEndpointV1,
  CodeGraphCrossRepositoryBridgeV1,
} from '@threadnote/graph/cross_repository/resolver';
import {findCodeGraphWorksetPath, traceCodeGraphWorksetImpact} from '@threadnote/graph/cross_repository/runtime';
import {
  readCodeGraphWorksetCatalogBridgeGenerationPage,
  readPublishedCodeGraphWorksetCatalogBridgeSetSummary,
} from '@threadnote/graph/cross_repository/store';
import {readPublishedCodeGraphWorksetCatalogGeneration} from '@threadnote/graph/workset_catalog/store';
import {executeCodeGraphWorksetV2} from '@threadnote/graph/workset/query_v2';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

const WORKSET_NAME = 'code-graph-workset-four-member-traversal';
const MEMBER_COUNT = 4;

describe('workset cross-repository traversal integration', () => {
  it.effect(
    'fences package and Protobuf path/impact to the published exact bridge generation',
    () =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: prepareFourMemberWorksetFixture,
          catch: cause => TestError.make({message: 'Could not prepare the four-member workset fixture.', cause}),
        }),
        fixture =>
          Effect.gen(function* () {
            expect(fixture.repositories).toHaveLength(MEMBER_COUNT);
            expect(EffectArray.every(fixture.repositories, repository => repository.state === 'clean')).toBe(true);

            yield* indexPreparedCodeGraphWorksetFixture(fixture);
            yield* publishIndexedCodeGraphWorksetCatalog(fixture, [WORKSET_NAME]);

            const published = yield* readPublishedCodeGraphWorksetCatalogGeneration(fixture.home, WORKSET_NAME);
            expect(published).toBeDefined();
            if (published === undefined) return yield* TestError.make({message: 'Fixture workset was not published.'});
            expect(EffectArray.map(published.members, member => member.repositoryKey)).toEqual([
              'workset-repo-000',
              'workset-repo-001',
              'workset-repo-002',
              'workset-repo-003',
            ]);

            const summary = yield* readPublishedCodeGraphWorksetCatalogBridgeSetSummary(fixture.home, published.id);
            expect(summary).toMatchObject({
              coverage: {
                diagnostics: [],
                failedRepositoryCount: 0,
                rejectionCount: 0,
                repositoriesRead: MEMBER_COUNT,
                repositoryCount: MEMBER_COUNT,
                state: 'complete',
              },
              generationId: published.id,
              worksetName: WORKSET_NAME,
            });
            expect(summary?.bridgeCount).toBeGreaterThanOrEqual(1);
            expect(summary?.digest).toMatch(/^[0-9a-f]{64}$/u);
            if (summary === undefined)
              return yield* TestError.make({message: 'Published bridge receipt is unavailable.'});

            const page = yield* readCodeGraphWorksetCatalogBridgeGenerationPage(fixture.home, {
              generationId: published.id,
            });
            expect(page).toMatchObject({
              bridgeSetDigest: summary.digest,
              generationId: published.id,
              totalBridges: summary.bridgeCount,
              worksetName: WORKSET_NAME,
            });
            const packageBridge = EffectOption.getOrUndefined(
              EffectOption.map(EffectOption.fromNullishOr(page?.bridges), __effectArrayReceiver =>
                EffectOption.getOrUndefined(
                  EffectArray.findFirst(
                    __effectArrayReceiver,
                    candidate =>
                      candidate.identity === 'package:npm:@threadnote-fixture/session-contract' &&
                      candidate.source.repositoryKey === 'workset-repo-001' &&
                      candidate.target.repositoryKey === 'workset-repo-000',
                  ),
                ),
              ),
            );
            expect(packageBridge).toMatchObject({
              confidence: 1,
              provenance: 'declared',
              relation: 'depends_on',
              resolver: {reason: 'declared-npm-package-compatible'},
              source: {
                evidence: {path: 'packages/session-client/package.json'},
                reference: {kind: 'component'},
                role: 'import',
              },
              target: {
                evidence: {path: 'package.json'},
                reference: {kind: 'component'},
                role: 'export',
              },
            });
            if (
              packageBridge === undefined ||
              packageBridge.source.reference.kind !== 'component' ||
              packageBridge.target.reference.kind !== 'component'
            ) {
              return yield* TestError.make({message: 'Fixture exact npm package bridge is not component-qualified.'});
            }
            const bridge = EffectOption.getOrUndefined(
              EffectOption.map(EffectOption.fromNullishOr(page?.bridges), __effectArrayReceiver =>
                EffectOption.getOrUndefined(
                  EffectArray.findFirst(
                    __effectArrayReceiver,
                    candidate =>
                      candidate.identity === 'protobuf:file:threadnote/session/v1/session.proto' &&
                      candidate.source.repositoryKey === 'workset-repo-003' &&
                      candidate.target.repositoryKey === 'workset-repo-000',
                  ),
                ),
              ),
            );
            expect(bridge).toMatchObject({
              confidence: 1,
              provenance: 'declared',
              relation: 'imports',
              resolver: {reason: 'exact-protobuf-identity'},
              source: {
                evidence: {path: 'proto/session_client.proto'},
                reference: {kind: 'qualified-ref'},
                role: 'import',
              },
              target: {
                evidence: {path: 'threadnote/session/v1/session.proto'},
                reference: {kind: 'qualified-ref'},
                role: 'export',
              },
            });
            const sourceReference = bridge?.source.reference;
            const targetReference = bridge?.target.reference;
            if (
              bridge === undefined ||
              sourceReference?.kind !== 'qualified-ref' ||
              targetReference?.kind !== 'qualified-ref'
            ) {
              return yield* TestError.make({message: 'Fixture exact Protobuf bridge is not qualified.'});
            }

            const config = codeGraphWorksetRuntimeConfig(fixture);
            const packagePath = yield* findCodeGraphWorksetPath(config, {
              deadlineMilliseconds: 10_000,
              from: traversalSelector(packageBridge.source),
              maxDepth: 1,
              maxEdges: 16,
              to: traversalSelector(packageBridge.target),
              worksetName: WORKSET_NAME,
            });
            expect(packagePath).toMatchObject({
              coverage: {acceptedBridgeEdges: 1, unreadyEndpointsSkipped: 0},
              generationId: published.id,
              reachedTarget: true,
              stop: {complete: true, reason: 'target-found'},
            });
            expect(packagePath.edges).toEqual([expectedTraversalBridge(packageBridge, published.id)]);

            const packageImpact = yield* traceCodeGraphWorksetImpact(config, {
              deadlineMilliseconds: 10_000,
              maxDepth: 1,
              maxEdges: 16,
              query: traversalSelector(packageBridge.target),
              worksetName: WORKSET_NAME,
            });
            expect(packageImpact).toMatchObject({
              coverage: {unreadyEndpointsSkipped: 0},
              generationId: published.id,
              stop: {complete: false, reason: 'depth'},
            });
            expect(packageImpact.edges).toEqual(
              expect.arrayContaining([expectedTraversalBridge(packageBridge, published.id)]),
            );

            const protobufQuery = EffectOption.getOrUndefined(
              EffectArray.findFirst(fixture.plan.queries, query => query.id === 'protobuf-session-directory'),
            );
            expect(protobufQuery).toMatchObject({
              expectedEdges: [
                {
                  provenance: 'declared',
                  relation: 'imports',
                  source: {repositoryId: 'repo-003', symbol: 'proto/session_client.proto#session.proto'},
                  target: {
                    repositoryId: 'repo-000',
                    symbol: 'threadnote/session/v1/session.proto#session.proto',
                  },
                },
              ],
              text: 'threadnote.session.v1.SessionDirectory ResolveTenantSession',
            });
            if (protobufQuery === undefined) {
              return yield* TestError.make({message: 'Fixture Protobuf query is unavailable.'});
            }
            const query = yield* executeCodeGraphWorksetV2(config, {
              deadlineMilliseconds: 10_000,
              query: protobufQuery.text,
              worksetName: WORKSET_NAME,
            });
            expect(query.instrumentation).toMatchObject({
              bridgeExpansionComplete: true,
              deepQueryFailures: 0,
            });
            expect(query.instrumentation.bridgeEdgesConsidered).toBeGreaterThanOrEqual(1);
            expect(query.instrumentation.relationships).toBeGreaterThanOrEqual(1);
            expect(
              EffectArray.map(
                EffectArray.filter(
                  query.logicalResult.cards,
                  card => card.ref === sourceReference.ref || card.ref === targetReference.ref,
                ),
                card => ({
                  name: card.symbol.name,
                  path: card.symbol.path,
                  ref: card.ref,
                  repositoryKey: card.repositoryKey,
                }),
              ),
            ).toEqual(
              expect.arrayContaining([
                {
                  name: 'session.proto',
                  path: 'proto/session_client.proto',
                  ref: sourceReference.ref,
                  repositoryKey: 'workset-repo-003',
                },
                {
                  name: 'session.proto',
                  path: 'threadnote/session/v1/session.proto',
                  ref: targetReference.ref,
                  repositoryKey: 'workset-repo-000',
                },
              ]),
            );
            expect(EffectArray.flatMap(query.logicalResult.cards, card => card.relationships)).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  authority: 'authoritative',
                  confidence: 1,
                  evidence: expect.objectContaining({
                    path: 'proto/session_client.proto',
                    repositoryKey: 'workset-repo-003',
                  }),
                  provenance: 'declared',
                  relation: 'imports',
                  source: {ref: sourceReference.ref, repositoryKey: 'workset-repo-003'},
                  target: {ref: targetReference.ref, repositoryKey: 'workset-repo-000'},
                }),
              ]),
            );

            const path = yield* findCodeGraphWorksetPath(config, {
              deadlineMilliseconds: 10_000,
              from: sourceReference.ref,
              maxDepth: 1,
              maxEdges: 16,
              to: targetReference.ref,
              worksetName: WORKSET_NAME,
            });
            expect(path).toMatchObject({
              coverage: {
                acceptedBridgeEdges: 1,
                unreadyEndpointsSkipped: 0,
              },
              direction: 'forward',
              generationId: published.id,
              reachedTarget: true,
              stop: {complete: true, reason: 'target-found'},
            });
            expect(path.edges).toEqual([expectedTraversalBridge(bridge, published.id)]);
            expect(path.visited).toEqual(
              expect.arrayContaining([
                expectedTraversalEndpoint(bridge.source),
                expectedTraversalEndpoint(bridge.target),
              ]),
            );

            const impact = yield* traceCodeGraphWorksetImpact(config, {
              deadlineMilliseconds: 10_000,
              maxDepth: 1,
              maxEdges: 16,
              query: targetReference.ref,
              worksetName: WORKSET_NAME,
            });
            expect(impact).toMatchObject({
              coverage: {
                acceptedBridgeEdges: 1,
                unreadyEndpointsSkipped: 0,
              },
              direction: 'reverse',
              generationId: published.id,
              reachedTarget: false,
              stop: {complete: false, reason: 'depth'},
            });
            expect(impact.edges).toEqual([expectedTraversalBridge(bridge, published.id)]);
            expect(impact.visited).toEqual(
              expect.arrayContaining([
                expectedTraversalEndpoint(bridge.source),
                expectedTraversalEndpoint(bridge.target),
              ]),
            );
          }),
        fixture =>
          Effect.tryPromise({
            try: () => removePreparedCodeGraphWorksetFixture(fixture),
            catch: cause => TestError.make({message: 'Could not remove the four-member workset fixture.', cause}),
          }),
      ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
    {timeout: 300_000},
  );
});

async function prepareFourMemberWorksetFixture(): Promise<PreparedCodeGraphWorksetFixture> {
  const fixture = await prepareCodeGraphWorksetFixture({size: 8, stateProfile: 'all-clean'});
  try {
    const repositories = fixture.repositories.slice(0, MEMBER_COUNT);
    if (repositories.length !== MEMBER_COUNT)
      throw TestError.make({message: 'Fixture does not contain the four-member prefix.'});
    await appendFile(
      fixture.manifestPath,
      `  - name: ${WORKSET_NAME}\n` +
        '    description: "Deterministic four-repository traversal integration workset"\n' +
        '    projects:\n' +
        EffectArray.join(
          EffectArray.map(repositories, repository => `      - ${repository.projectName}\n`),
          '',
        ),
      'utf8',
    );
    return {...fixture, repositories};
  } catch (error) {
    await removePreparedCodeGraphWorksetFixture(fixture);
    throw error;
  }
}

function expectedTraversalEndpoint(endpoint: CodeGraphBridgeEndpointV1) {
  return {
    reference: endpoint.reference,
    repositoryId: endpoint.repositoryId,
    repositoryKey: endpoint.repositoryKey,
    snapshotId: endpoint.snapshotId,
  };
}

function traversalSelector(endpoint: CodeGraphBridgeEndpointV1): string {
  return endpoint.reference.kind === 'component'
    ? `${endpoint.repositoryKey}:${endpoint.reference.componentId}`
    : endpoint.reference.ref;
}

function expectedTraversalBridge(bridge: CodeGraphCrossRepositoryBridgeV1, generationId: string) {
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
    source: expectedTraversalEndpoint(bridge.source),
    target: expectedTraversalEndpoint(bridge.target),
  };
}
