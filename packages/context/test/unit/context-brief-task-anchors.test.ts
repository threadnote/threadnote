import {it as effectIt} from '@effect/vitest';
import {describe, expect, it} from 'vitest';
import {Effect, Fiber, Layer} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {SystemInfo} from '@threadnote/platform/system';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {CodeGraphStoreTransientIoError} from '@threadnote/graph/types';
import {contextBriefTaskGraphAnchors} from '../../src/memory-evidence.js';
import {fromRepositoryQuery} from '../../src/graph/evidence.js';
import {planContextBrief} from '../../src/planner.js';
import type {ContextBriefSourceEvidenceRequest} from '../../src/graph/source_evidence.js';
import {CodeGraphQueryService, type CodeGraphInspectOptions} from '@threadnote/graph/query';
import type {CodeGraphEdge, CodeGraphQueryNode, CodeGraphQueryResult, CodeGraphStatus} from '@threadnote/graph/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {compileContextBriefWith} from '../../src/compiler.js';
import {retrieveContextBriefGraphEvidence} from '../../src/graph/evidence.js';
import type {
  ContextBriefCitationValidationFenceV2,
  ContextBriefMemoryCandidateV1,
  ContextBriefLogicalResultV1,
} from '../../src/types.js';
import {projectContextBrief} from '../../src/projector.js';

const REPOSITORY_ID = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const SNAPSHOT_ID = `cgsn_${'c'.repeat(40)}`;
const WORKFLOW = 'packages/context/src/native-workflow.ts';
const INCIDENTAL = 'scripts/finalize-matched-continuation-study.ts';
const TASK = 'Verify installed native workflow foundation contracts and source replacement baseline.';
const TRUST = {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'} as const;

function provideFixtureServices<A, E, R>(effect: Effect.Effect<A, E, R>) {
  const layer = Layer.merge(
    BunServices.layer,
    Layer.succeed(SystemInfo, {environment: () => process.env, platform: process.platform} as never),
  );
  return Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}

function candidate(): ContextBriefMemoryCandidateV1 {
  return {
    kind: 'durable',
    topic: 'native-workflow-foundation',
    rank: 0,
    uri: 'threadnote://user/test/memories/durable/projects/threadnote/native-workflow.md',
    excerpt: 'Historical workflow foundation contracts.',
    citationErrorCount: 0,
    sourceCommit: '1'.repeat(40),
    codeCitations: [
      {
        version: 1,
        id: 'workflow-citation',
        path: WORKFLOW,
        repositoryId: REPOSITORY_ID,
        repositoryIdentityKind: 'remote',
        sourceCommit: '1'.repeat(40),
        sourceDirty: false,
        sourceSnapshotId: 'cgsn_old',
        extractorSet: 'test',
        fileContentHash: {algorithm: 'sha256', value: 'd'.repeat(64)},
        target: {kind: 'file'},
      },
    ],
  };
}

interface FixtureOptions {
  mode?: 'brief' | 'explain';
  codeRefs?: readonly string[];
  budgetTokens?: number;
  detail?: 'source' | 'compact';
  missing?: boolean;
  deleted?: boolean;
  foreign?: boolean;
  foreignSnapshot?: boolean;
  advanceGeneration?: boolean;
  validateCitations?: boolean;
  fail?: (call: CodeGraphInspectOptions, attempts: number) => boolean;
}
function compile(candidates: readonly ContextBriefMemoryCandidateV1[], options: FixtureOptions = {}) {
  const calls: CodeGraphInspectOptions[] = [];
  const sourceRequests: ContextBriefSourceEvidenceRequest[] = [];
  const validationFences: Array<ContextBriefCitationValidationFenceV2 | undefined> = [];
  let statusReads = 0;
  let currentStatus = STATUS;
  let logicalResult: ContextBriefLogicalResultV1 | undefined;
  const query = CodeGraphQueryService.of({
    attachSharedReadySnapshot: () => Effect.die('No attach/index expected'),
    inspect: call =>
      Effect.suspend(() => {
        calls.push(call);
        if (options.fail?.(call, calls.length))
          return Effect.fail(CodeGraphStoreTransientIoError.of('fixture contention'));
        const path = call.operation === 'query' ? INCIDENTAL : (call.query ?? WORKFLOW);
        const initial = queryResult({
          edges: [],
          nodes:
            options.missing && call.operation !== 'query'
              ? []
              : [sourceNode(`cgs_${'d'.repeat(32)}`, path, path, 'module')],
          operation: call.operation ?? 'query',
        });
        const result = {
          ...initial,
          snapshot: {
            ...initial.snapshot,
            commit: currentStatus.readySnapshot!.commit,
            id: currentStatus.readySnapshot!.id,
          },
        };
        if (options.foreignSnapshot && call.operation !== 'query')
          return Effect.succeed({...result, snapshot: {...result.snapshot, id: 'cgsn_foreign'}});
        return Effect.succeed(
          options.foreign && call.operation !== 'query'
            ? {...result, repository: {...result.repository, repositoryId: 'f'.repeat(64)}}
            : result,
        );
      }),
    purge: () => Effect.die('No purge'),
    status: () =>
      Effect.sync(() => {
        statusReads += 1;
        currentStatus =
          options.advanceGeneration && statusReads === 2
            ? {
                ...STATUS,
                identity: {...STATUS.identity, headCommit: '2'.repeat(40)},
                readySnapshot: {...STATUS.readySnapshot!, commit: '2'.repeat(40), id: `cgsn_${'2'.repeat(40)}`},
              }
            : STATUS;
        return currentStatus;
      }),
    statusForIdentity: () => Effect.die('No status'),
    statusForPublishedIdentity: () => Effect.die('No status'),
  });
  return compileContextBriefWith(
    {
      ...(options.validateCitations
        ? {
            citationValidation: (
              _scope: unknown,
              memories: readonly ContextBriefMemoryCandidateV1[],
              fence: ContextBriefCitationValidationFenceV2 | undefined,
            ) =>
              Effect.sync(() => {
                validationFences.push(fence);
                const changed = fence?.kind === 'repository' && fence.snapshotId !== SNAPSHOT_ID;
                return memories.map(memory => ({
                  uri: memory.uri,
                  receipts: memory.codeCitations.map(citation => ({
                    candidateCount: 1,
                    citationId: citation.id,
                    coverage: 'current-complete' as const,
                    kind: 'file' as const,
                    observedAt: '2026-10-25T00:00:00.000Z',
                    observedPath: citation.path,
                    reason: changed ? ('source-changed' as const) : ('exact' as const),
                    status: changed ? ('changed' as const) : ('exact' as const),
                    strategy: 'file-path' as const,
                    validatorVersion: 1 as const,
                    repositoryId: REPOSITORY_ID,
                    snapshotId: fence?.kind === 'repository' ? fence.snapshotId : undefined,
                  })),
                }));
              }),
          }
        : {}),
      projection: (logical, budget, format) =>
        Effect.sync(() => {
          logicalResult = logical;
          return projectContextBrief(logical, budget, format);
        }),
      graphEvidence: (plan, budget) =>
        retrieveContextBriefGraphEvidence(
          CONFIG,
          plan,
          request =>
            Effect.sync(() => {
              sourceRequests.push(request);
              return {
                excerpts:
                  options.deleted && request.result.nodes[0]?.path !== INCIDENTAL
                    ? []
                    : request.result.nodes.map(node => ({
                        content:
                          request.result.snapshot.id === SNAPSHOT_ID
                            ? 'export const workflow = true;'
                            : 'export const workflow = 2;',
                        coveredGraphRefs: [node.id],
                        endLine: 1,
                        evidenceKind: 'graph-snapshot' as const,
                        freshness: 'fresh' as const,
                        id: `source-${node.path}`,
                        path: node.path,
                        repositoryKey: 'Effect-TS/effect',
                        snapshotIdentity: 'current-clean' as const,
                        startLine: 1,
                        truncated: false,
                      })),
                gaps: options.deleted ? ['graph-source-snapshot-not-current'] : [],
              };
            }),
          budget,
        ),
      memoryEvidence: () =>
        Effect.succeed({candidates, consideredCandidates: candidates.length, gaps: [], trust: TRUST}),
    },
    {
      task: TASK,
      scope: {kind: 'repository', callerCwd: '/workspace/effect'},
      budgetTokens: options.budgetTokens ?? 1500,
      mode: options.mode,
      codeRefs: options.codeRefs,
      detail: options.detail ?? 'source',
    },
  ).pipe(
    Effect.provideService(CodeGraphQueryService, query),
    provideFixtureServices,
    Effect.map(result => ({result, calls, sourceRequests, validationFences, logical: logicalResult!})),
  );
}

describe('task-aligned ordinary Context Brief anchors', () => {
  effectIt.effect('grounds the reported ordinary task in cited current workflow source', () =>
    Effect.gen(function* () {
      const relevant = {...candidate(), rank: 10};
      const incidental = {
        ...candidate(),
        rank: 0,
        topic: 'matched-continuation-study',
        excerpt: 'expectedSourceTask: verify installed native workflow foundation contracts',
        uri: 'threadnote://user/test/memories/durable/projects/threadnote/incidental.md',
      };
      const {result, calls, logical, sourceRequests} = yield* compile([incidental, relevant]);
      expect(result.structuredContent.graph.cards[0]?.symbol.path).toBe(WORKFLOW);
      expect(calls.map(call => call.operation)).toEqual(['query', 'impact', 'neighbors']);
      expect(sourceRequests).toHaveLength(2);
      expect(
        sourceRequests.every(
          request =>
            request.maximumContentBytes ===
            planContextBrief({
              task: TASK,
              detail: 'source',
              budgetTokens: 1500,
              scope: {kind: 'repository', callerCwd: '/workspace/effect'},
            }).graph.sourceMaximumBytes,
        ),
      ).toBe(true);
      expect(result.structuredContent.graph.sources?.[0]?.path).toBe(WORKFLOW);
      // Resolving current source does not validate the historical memory claim.
      expect(logical.durableDecisions.find(memory => memory.uri === relevant.uri)?.freshness).toBe('unknown');
      expect(calls.every(call => call.refresh === false && call.requestMaintenance === false)).toBe(true);
    }),
  );
  effectIt.effect('revalidates initial exact receipts before adopting a new current source generation', () =>
    Effect.gen(function* () {
      const base = candidate();
      const memory = {
        ...base,
        sourceCommit: COMMIT,
        codeCitations: base.codeCitations.map(citation => ({
          ...citation,
          sourceCommit: COMMIT,
          sourceSnapshotId: SNAPSHOT_ID,
        })),
      };
      const {result, logical, validationFences, sourceRequests, calls} = yield* compile([memory], {
        advanceGeneration: true,
        validateCitations: true,
      });
      const secondSnapshot = `cgsn_${'2'.repeat(40)}`;
      expect(validationFences).toEqual([
        {kind: 'repository', repositoryId: REPOSITORY_ID, snapshotId: SNAPSHOT_ID},
        {kind: 'repository', repositoryId: REPOSITORY_ID, snapshotId: secondSnapshot},
      ]);
      expect(sourceRequests.map(request => request.result.snapshot.id)).toEqual([SNAPSHOT_ID, secondSnapshot]);
      expect(logical.graph.citationValidationFence).toEqual(validationFences[1]);
      expect(logical.graph.resolvedSnapshots[0]).toMatchObject({
        snapshotId: secondSnapshot,
        commit: '2'.repeat(40),
        freshness: 'fresh',
      });
      expect(result.structuredContent.graph.sources?.[0]).toMatchObject({
        path: WORKFLOW,
        content: 'export const workflow = 2;',
        freshness: 'fresh',
      });
      expect(logical.durableDecisions.find(decision => decision.uri === memory.uri)).toMatchObject({
        freshness: 'stale',
        preciseStatus: 'changed',
      });
      expect(
        logical.stalenessAndConflicts.some(issue => issue.kind === 'stale-memory' && issue.uris.includes(memory.uri)),
      ).toBe(true);
      expect(calls.map(call => call.operation)).toEqual(['query', 'impact', 'neighbors']);

      const stable = yield* compile([memory], {validateCitations: true});
      expect(stable.validationFences).toHaveLength(1);
      expect(stable.logical.durableDecisions.find(decision => decision.uri === memory.uri)).toMatchObject({
        freshness: 'fresh',
        preciseStatus: 'exact',
      });
    }),
  );

  effectIt.effect('honors explicit paths in brief/explain, including unresolved refs without widening', () =>
    Effect.gen(function* () {
      for (const mode of ['brief', 'explain'] as const) {
        const exact = yield* compile([candidate()], {mode, codeRefs: [WORKFLOW]});
        expect(exact.calls.map(call => call.operation)).toEqual(['impact', 'neighbors']);
        expect(exact.calls.every(call => call.query !== TASK)).toBe(true);
        const missing = yield* compile([candidate()], {mode, codeRefs: ['missing.ts'], missing: true});
        expect(missing.calls).toHaveLength(1);
        expect(missing.result.structuredContent.graph.cards).toEqual([]);
      }
    }),
  );

  effectIt.effect('retains truthful lexical fallback for missing/deleted/foreign locators', () =>
    Effect.gen(function* () {
      for (const options of [{missing: true}, {deleted: true}, {foreign: true}, {foreignSnapshot: true}]) {
        const {result, calls} = yield* compile([candidate()], options);
        expect(result.structuredContent.graph.cards[0]?.symbol.path).toBe(INCIDENTAL);
        expect(result.structuredContent.graph.sources?.[0]?.path).toBe(INCIDENTAL);
        expect(calls.length).toBeLessThanOrEqual(3);
      }
    }),
  );

  effectIt.effect('does not follow unrelated, generic-only, foreign, missing or malformed candidates', () =>
    Effect.gen(function* () {
      const base = candidate();
      for (const item of [
        {...base, topic: 'matched-continuation-study'},
        {...base, topic: 'verify installed contracts source replacement baseline'},
        {...base, codeCitations: base.codeCitations.map(citation => ({...citation, repositoryId: 'f'.repeat(64)}))},
        {...base, codeCitations: []},
        ...['../outside.ts', '/absolute.ts', 'src/./file.ts', 'src\\file.ts', ' c.ts', 'src//file.ts'].map(path => ({
          ...base,
          codeCitations: base.codeCitations.map(citation => ({...citation, path})),
        })),
      ]) {
        const {result, calls} = yield* compile([item]);
        expect(calls.map(call => call.operation)).toEqual(['query']);
        expect(result.structuredContent.graph.cards[0]?.symbol.path).toBe(INCIDENTAL);
      }
    }),
  );

  effectIt.effect('retains bounded evidence for brief/explain at 800 and 1500 tokens', () =>
    Effect.gen(function* () {
      for (const mode of ['brief', 'explain'] as const)
        for (const budgetTokens of [800, 1500]) {
          const {result} = yield* compile([candidate()], {mode, budgetTokens});
          expect(result.measurement.estimatedTokens).toBeLessThanOrEqual(budgetTokens);
          if (budgetTokens === 1500) expect(result.structuredContent.graph.cards[0]?.symbol.path).toBe(WORKFLOW);
          expect(JSON.stringify(result.structuredContent)).not.toContain(INCIDENTAL);
        }
    }),
  );

  effectIt.effect('shares only two retries across initial and follow-up reads', () =>
    Effect.gen(function* () {
      // First lexical attempt fails once; each exact phase fails its first attempt.
      const attempts = new Map<string, number>();
      const program = compile([candidate()], {
        fail: call => {
          const key = call.operation ?? 'query';
          const count = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, count);
          return count === 1;
        },
      });
      const fiber = yield* program.pipe(Effect.forkChild);
      yield* TestClock.adjust(24);
      expect(attempts.get('query')).toBe(1);
      yield* TestClock.adjust(1);
      expect(attempts.get('query')).toBe(2);
      expect(attempts.get('impact')).toBe(1);
      yield* TestClock.adjust(25);
      const {calls, result} = yield* Fiber.join(fiber);
      expect(calls.map(call => call.operation)).toEqual(['query', 'query', 'impact', 'impact', 'neighbors']);
      // The exhausted relationship read preserves the exact resolved module.
      expect(result.structuredContent.graph.cards[0]?.symbol.path).toBe(WORKFLOW);
      expect(attempts.get('neighbors')).toBe(1);
    }),
  );

  effectIt.effect('abstains when the shared primary budget is exhausted', () =>
    Effect.gen(function* () {
      const query = CodeGraphQueryService.of({
        attachSharedReadySnapshot: () => Effect.die('No attach'),
        inspect: () => Effect.die('Budget must prevent inspect'),
        purge: () => Effect.die('No purge'),
        status: () => Effect.succeed(STATUS),
        statusForIdentity: () => Effect.die('No status'),
        statusForPublishedIdentity: () => Effect.die('No status'),
      });
      const plan = planContextBrief({
        task: TASK,
        scope: {kind: 'repository', callerCwd: '/workspace/effect'},
        codeRefs: [WORKFLOW],
        mode: 'brief',
      });
      const evidence = yield* retrieveContextBriefGraphEvidence(CONFIG, plan.graph, undefined, {
        remaining: 0,
        primaryRemaining: 0,
      }).pipe(Effect.provideService(CodeGraphQueryService, query), provideFixtureServices);
      expect(evidence.cards).toEqual([]);
      expect(evidence.coverage.complete).toBe(false);
      expect(evidence.gaps).toContain('graph-read-budget-exhausted');
    }),
  );

  it('breaks positive candidate ties deterministically and selects only one memory', () => {
    const graph = fromRepositoryQuery(queryResult({edges: [], nodes: [], operation: 'query'}));
    const a = {
      ...candidate(),
      uri: 'threadnote://a',
      codeCitations: candidate().codeCitations.map(citation => ({...citation, path: 'src/a.ts'})),
    };
    const b = {
      ...candidate(),
      uri: 'threadnote://b',
      codeCitations: candidate().codeCitations.map(citation => ({...citation, path: 'src/b.ts'})),
    };
    for (const candidates of [
      [a, b],
      [b, a],
    ]) {
      expect(
        contextBriefTaskGraphAnchors(TASK, {candidates, consideredCandidates: 2, gaps: [], trust: TRUST}, graph, 8),
      ).toEqual(['src/a.ts']);
    }
  });

  effectIt.effect('limits initial plus eight paths and one-hops to 17 primary reads', () =>
    Effect.gen(function* () {
      const base = candidate();
      const many = {
        ...base,
        codeCitations: Array.from({length: 12}, (_, index) => ({
          ...base.codeCitations[0],
          id: `c-${index}`,
          path: `src/workflow-${index}.ts`,
        })),
      };
      const {calls} = yield* compile([many], {detail: 'compact'});
      expect(calls).toHaveLength(17);
      expect(calls.filter(call => call.operation === 'impact')).toHaveLength(8);
      expect(calls.filter(call => call.operation === 'neighbors')).toHaveLength(8);
    }),
  );

  it('candidate order, duplicate paths and unrelated evidence do not change locators', () =>
    fc.assert(
      fc.property(fc.array(fc.integer({min: 0, max: 20}), {maxLength: 12}), values => {
        const base = candidate();
        const graph = fromRepositoryQuery(queryResult({edges: [], nodes: [], operation: 'query'}));
        const selected = {...base, codeCitations: [...base.codeCitations, ...values.map(() => base.codeCitations[0])]};
        const noise = values.map((value, index) => ({
          ...base,
          uri: `${base.uri}/${index}`,
          rank: value,
          topic: index % 2 === 0 ? base.topic : 'unrelated remote telemetry',
          codeCitations: base.codeCitations.map(citation => ({
            ...citation,
            repositoryId: index % 2 === 0 ? 'e'.repeat(64) : REPOSITORY_ID,
          })),
        }));
        const memory = (candidates: readonly ContextBriefMemoryCandidateV1[]) => ({
          candidates,
          consideredCandidates: candidates.length,
          gaps: [],
          trust: TRUST,
        });
        expect(contextBriefTaskGraphAnchors(TASK, memory([selected, ...noise]), graph, 8)).toEqual([WORKFLOW]);
        expect(contextBriefTaskGraphAnchors(TASK, memory([...noise.slice().reverse(), selected]), graph, 8)).toEqual([
          WORKFLOW,
        ]);
      }),
      {numRuns: 30},
    ));
});

function queryResult(input: {
  readonly edges: readonly CodeGraphEdge[];
  readonly nodes: readonly CodeGraphQueryNode[];
  readonly operation: CodeGraphQueryResult['operation'];
}): CodeGraphQueryResult {
  return {
    edges: input.edges,
    freshness: 'current',
    nodes: input.nodes,
    operation: input.operation,
    repository: {displayName: 'Effect-TS/effect', repositoryId: REPOSITORY_ID},
    snapshot: {commit: COMMIT, dirty: false, id: SNAPSHOT_ID, worktreeId: 'effect-worktree'},
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    version: 1,
    warnings: [],
  };
}

function sourceNode(id: string, name: string, path: string, kind: string, language = 'typescript'): CodeGraphQueryNode {
  return {
    contentHash: '0'.repeat(64),
    exported: true,
    id,
    kind,
    language,
    name,
    path,
    qualifiedName: name,
    score: 1,
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

const STATUS: CodeGraphStatus = {
  databasePath: '/threadnote/graph.sqlite',
  freshness: 'current',
  identity: {
    caseMode: 'sensitive',
    checkoutId: 'effect-checkout',
    displayName: 'Effect-TS/effect',
    gitCommonDirectory: '/workspace/effect/.git',
    headCommit: COMMIT,
    objectFormat: 'sha1',
    repoRoot: '/workspace/effect',
    repositoryId: REPOSITORY_ID,
    worktreeId: 'effect-worktree',
  },
  languagePacks: [],
  readySnapshot: {
    commit: COMMIT,
    dirty: false,
    edgeCount: 4,
    extractorSet: 'test-extractor',
    fileCount: 4,
    id: SNAPSHOT_ID,
    repositoryId: REPOSITORY_ID,
    state: 'ready',
    symbolCount: 4,
    worktreeId: 'effect-worktree',
  },
  stale: false,
};

const CONFIG: RuntimeConfig = {
  account: 'local',
  agentContextHome: '/threadnote',
  agentId: 'test-agent',
  manifestPath: '/threadnote/manifest.yaml',
  user: 'tester',
};
