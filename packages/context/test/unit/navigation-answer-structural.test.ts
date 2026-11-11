import * as EffectString from 'effect/String';
import {Option as EffectOption} from 'effect';
import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Clock, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path, Result} from 'effect';
import {TestClock} from 'effect/testing';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import {describe, expect, vi} from 'vitest';
import fc from 'fast-check';
import manifest from '../fixtures/navigation-answers/v1/manifest.json' with {type: 'json'};
import {CodeGraphEmbeddingIndex} from '@threadnote/graph/embedding';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService, observationFromCodeGraphStatus} from '@threadnote/graph/query';
import {CodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphMaintenanceCoordinator} from '@threadnote/graph/maintenance/coordinator';
import {CodeGraphParserPool} from '@threadnote/graph/parser_worker';
import {CodeGraphObservability, CodeGraphProcessActivity} from '@threadnote/graph/runtime_ports';
import {CodeGraphStore} from '@threadnote/graph/store';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import type {CodeGraphIndexSummary, CodeGraphProjectCoverage} from '@threadnote/graph/types';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {makeReadDeadline, ReadDeadlineExceeded} from '@threadnote/platform/read_deadline';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import * as extractionRuntime from '@threadnote/graph/typescript_runtime';
import {retrieveNavigationSourceProofs, navigationProofSpansInspected} from '../../src/navigation/source_facts.js';
import * as sourceEvidence from '../../src/graph/source_evidence.js';
import {assembleStructuralNavigationAnswer} from '../../src/navigation/structural.js';
import {projectNavigationAnswer, projectStructuralNavigationAnswer} from '../../src/navigation/project.js';
import {fromRepositoryQuery} from '../../src/graph/evidence.js';
import {planContextBrief} from '../../src/planner.js';
import {selectContextBriefNavigationMemory} from '../../src/memory-evidence.js';
import type {ContextBriefMemoryCandidateV1, ContextBriefMemoryRetrievalV1} from '../../src/types.js';
import * as navigationFacts from '@threadnote/graph/query/navigation_facts';

effectIt.layer(citationPlatformLayer)(it => {
  describe('navigation caller-owned acquisition deadline', () => {
    const identity = {
      caseMode: 'sensitive',
      checkoutId: 'fixture',
      displayName: 'fixture',
      gitCommonDirectory: '/fixture/.git',
      headCommit: 'commit',
      objectFormat: 'sha1',
      repoRoot: '/fixture',
      repositoryId: 'repository',
      worktreeId: 'worktree',
    } as const;
    const input = {
      databasePath: '/unused',
      identity,
      result: {
        version: 1,
        operation: 'query',
        repository: {displayName: 'fixture', repositoryId: identity.repositoryId},
        snapshot: {commit: identity.headCommit, dirty: false, id: 'snapshot', worktreeId: identity.worktreeId},
        freshness: 'current',
        nodes: [],
        edges: [],
        warnings: [],
        trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
      },
      selectors: [],
      repositoryKey: 'fixture',
      maximumContentBytes: 8192,
    } as const;

    it.effect('refuses an expired caller deadline before admission or fact acquisition', () =>
      Effect.gen(function* () {
        const facts = vi.spyOn(navigationFacts, 'readCodeGraphNavigationFacts');
        yield* Effect.addFinalizer(() => Effect.sync(() => facts.mockRestore()));
        const deadline = yield* makeReadDeadline(10);
        yield* TestClock.adjust(10);
        const result = yield* retrieveNavigationSourceProofs({
          ...input,
          deadline,
          acquireRead: Effect.die('Expired caller cannot pay another stage'),
        }).pipe(Effect.result);
        expect(result).toEqual(Result.fail(ReadDeadlineExceeded.make({})));
        expect(facts).not.toHaveBeenCalled();
      }),
    );

    it.effect('does not pay another stage after synchronous acquisition crosses the inherited deadline', () =>
      Effect.gen(function* () {
        const empty = yield* navigationFacts.readCodeGraphNavigationFacts({
          ...input,
          acquireRead: Effect.succeed(true),
        });
        const clock = yield* Clock.Clock;
        let now = 0n;
        let admissions = 0;
        const facts = vi.spyOn(navigationFacts, 'readCodeGraphNavigationFacts').mockImplementation(() =>
          Effect.sync(() => {
            now = 10_000_000n;
            return empty;
          }),
        );
        const source = vi.spyOn(sourceEvidence, 'retrieveContextBriefSourceEvidence');
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            facts.mockRestore();
            source.mockRestore();
          }),
        );
        const acquisition = retrieveNavigationSourceProofs({
          ...input,
          deadline: {expiresAtNanos: 10_000_000n},
          acquireRead: Effect.sync(() => {
            admissions++;
            return true;
          }),
        }).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            monotonicTimeNanosUnsafe: () => now,
            monotonicTimeNanos: Effect.sync(() => now),
          }),
        );
        const result = yield* acquisition.pipe(Effect.result);
        expect(result).toEqual(Result.fail(ReadDeadlineExceeded.make({})));
        expect(admissions).toBe(0);
        expect(source).not.toHaveBeenCalled();
        now = 0n;
        facts.mockReturnValue(Effect.succeed(empty));
        source.mockReturnValue(
          Effect.sync(() => {
            now = 10_000_000n;
            return {excerpts: [], gaps: []};
          }),
        );
        const lateSource = yield* acquisition.pipe(Effect.result);
        expect(lateSource).toEqual(Result.fail(ReadDeadlineExceeded.make({})));
        expect(admissions).toBe(1);
        expect(source).toHaveBeenCalledOnce();
      }),
    );

    it.effect('interrupts late optional source work at the original deadline and propagates caller cancellation', () =>
      Effect.gen(function* () {
        const empty = yield* navigationFacts.readCodeGraphNavigationFacts({
          ...input,
          acquireRead: Effect.succeed(true),
        });
        const facts = vi.spyOn(navigationFacts, 'readCodeGraphNavigationFacts').mockReturnValue(Effect.succeed(empty));
        const source = vi.spyOn(sourceEvidence, 'retrieveContextBriefSourceEvidence');
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            facts.mockRestore();
            source.mockRestore();
          }),
        );
        for (const cancel of [false, true]) {
          const entered = yield* Deferred.make<void>();
          let cleaned = false;
          let completed = false;
          let admissions = 0;
          source.mockReturnValue(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Effect.sleep(20);
              completed = true;
              return {excerpts: [], gaps: []};
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  cleaned = true;
                }),
              ),
            ),
          );
          const deadline = yield* makeReadDeadline(10);
          // Earlier parent work has already used six milliseconds of this same deadline.
          yield* TestClock.adjust(6);
          const fiber = yield* retrieveNavigationSourceProofs({
            ...input,
            deadline,
            acquireRead: Effect.sync(() => {
              admissions++;
              return true;
            }),
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          if (cancel) {
            yield* Fiber.interrupt(fiber);
            expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
          } else {
            yield* TestClock.adjust(4);
            const result = yield* Fiber.join(fiber).pipe(Effect.result);
            expect(result).toEqual(Result.fail(ReadDeadlineExceeded.make({})));
          }
          yield* TestClock.adjust(20);
          expect(admissions).toBe(1);
          expect(completed).toBe(false);
          expect(cleaned).toBe(true);
        }
      }),
    );
  });
});
const platform = Layer.effect(
  SystemInfo,
  Effect.gen(function* () {
    const system = yield* SystemInfo;
    const path = yield* Path.Path;
    return SystemInfo.of({
      ...system,
      developmentEntrypoint: yield* path.fromFileUrl(
        new URL('../../../../apps/threadnote/src/standalone.ts', import.meta.url),
      ),
      environment: () => ({...system.environment(), THREADNOTE_CODE_GRAPH_PARSER_WORKERS: '1'}),
    });
  }),
).pipe(Layer.provideMerge(citationPlatformLayer));
const ports = Layer.mergeAll(
  Layer.succeed(CodeGraphProcessActivity, {withActivity: (_role, _operation, program) => program}),
  Layer.succeed(CodeGraphObservability, {
    makeBuildReporter: () =>
      Effect.succeed({
        observeExtractedFactBytes: () => Effect.void,
        observeInventory: () => Effect.void,
        observeOverlay: () => Effect.void,
        progress: () => Effect.void,
        terminal: () => Effect.void,
      }),
    makeWorksetReporter: Effect.succeed({
      failure: () => Effect.void,
      progress: () => Effect.void,
      terminal: () => Effect.void,
    }),
    backgroundFailure: () => Effect.void,
  }),
  Layer.succeed(CodeGraphEmbeddingIndex, {
    check: () => Effect.succeed({state: 'unavailable' as const, reason: 'fixture vectors disabled'}),
    ensure: () => Effect.die('No model in source proof fixture'),
    search: () => Effect.succeed(new Map()),
  }),
  FetchHttpClient.layer,
);
const base = Layer.mergeAll(platform, ports);
const storeLayer = CodeGraphStore.layer.pipe(Layer.provideMerge(base));
const dependencies = Layer.mergeAll(
  CodeGraphMaintenanceCoordinator.layer.pipe(Layer.provideMerge(storeLayer)),
  CodeGraphParserPool.layer.pipe(Layer.provideMerge(base)),
  TreeSitterRuntime.layer.pipe(Layer.provideMerge(base)),
  CodeGraphLanguagePackRegistry.layer,
);
const physicalFixture = (operationContent = manifest.sources[0].content) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({prefix: 'navigation-source-proof-'});
    const cwd = path.join(root, 'repository');
    const home = path.join(root, 'home');
    yield* fs.makeDirectory(cwd);
    yield* fs.makeDirectory(home);
    const git = (args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
    yield* git(['init', '--quiet']);
    for (const source of manifest.sources) {
      expect(sha256HexSync(source.content)).toBe(source.sha256);
      yield* fs.writeFileString(
        path.join(cwd, source.path),
        source.path === 'operation.ts' ? operationContent : source.content,
      );
    }
    yield* git(['add', '.']);
    yield* git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'authored fixture',
    ]);
    const indexerContext = yield* Layer.build(CodeGraphIndexer.layer);
    const indexer = Context.get(indexerContext, CodeGraphIndexer);
    const summary = yield* indexer.index({cwd, threadnoteHome: home, sourceOnly: true, vectorPolicy: 'off'});
    const queryContext = yield* Layer.build(CodeGraphQueryService.layer).pipe(
      Effect.provideService(CodeGraphIndexer, indexer),
    );
    const query = Context.get(queryContext, CodeGraphQueryService);
    const store = yield* CodeGraphStore;
    const fullGraph = vi
      .spyOn(store, 'loadGraph')
      .mockImplementation(() => Effect.die('No whole graph hydration in acquisition'));
    yield* Effect.addFinalizer(() => Effect.sync(() => fullGraph.mockRestore()));
    const prepare = (summary: CodeGraphIndexSummary, preparedHome: string) =>
      Effect.gen(function* () {
        const layout = codeGraphLayout(path, preparedHome, summary.identity.checkoutId, summary.identity.worktreeId);
        const status = yield* query.status(preparedHome, cwd, {requestMaintenance: false});
        const result = yield* query.inspect({
          cwd,
          threadnoteHome: preparedHome,
          operation: 'query',
          query: 'saveNote',
          nodeLimit: 16,
          edgeLimit: 32,
          refresh: false,
          requestMaintenance: false,
          strictFreshness: false,
          statusObservation: observationFromCodeGraphStatus(status),
        });
        const graph = {symbols: result.nodes, edges: result.edges};
        expect(result.nodes.length).toBeLessThanOrEqual(16);
        expect(result.edges.length).toBeLessThanOrEqual(32);
        expect(fullGraph).not.toHaveBeenCalled();
        const operation = EffectOption.getOrUndefined(
          EffectArray.findFirst(graph.symbols, symbol => symbol.name === 'saveNote'),
        );
        if (!operation) return yield* Effect.die('Authored behavior missing from prepared graph');
        return {
          summary,
          graph,
          result,
          databasePath: layout.databasePath,
          selectors: [{path: operation.path, contentHash: operation.contentHash}],
          identity: summary.identity,
          repositoryKey: 'fixture',
          maximumContentBytes: 8192,
        };
      });
    return {fs, path, cwd, home, indexer, prepare, ...(yield* prepare(summary, home))};
  });
const fixture = physicalFixture();
effectIt.layer(dependencies)(it => {
  describe('actual navigation source proof feasibility', () => {
    it.effect('acquires the authored conditional persistence proof and direct route from a prepared graph', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const f = yield* fixture;
          const entry = EffectOption.getOrUndefined(
            EffectArray.findFirst(f.graph.symbols, symbol => symbol.name === 'saveCommand'),
          );
          const behavior = EffectOption.getOrUndefined(
            EffectArray.findFirst(f.graph.symbols, symbol => symbol.name === 'saveNote'),
          );
          const test = EffectOption.getOrUndefined(
            EffectArray.findFirst(f.graph.symbols, symbol => symbol.name === 'testSaveNote'),
          );
          expect(entry?.span.line).toBe(14);
          expect(behavior?.span.line).toBe(6);
          expect(test?.span.line).toBe(4);
          expect(
            EffectArray.some(
              f.graph.edges,
              edge => edge.relation === 'calls' && edge.sourceId === entry?.id && edge.targetId === behavior?.id,
            ),
          ).toBe(true);
          const testCall = EffectOption.getOrUndefined(
            EffectArray.findFirst(
              f.graph.edges,
              edge =>
                edge.relation === 'calls' && edge.evidencePath === 'operation.test.ts' && edge.evidenceSpan.line === 5,
            ),
          );
          expect(testCall?.targetId).toBe(behavior?.id);
          expect(
            EffectArray.some(
              f.graph.edges,
              edge =>
                edge.relation === 'contains' && edge.sourceId === test?.id && edge.targetId === testCall?.sourceId,
            ),
          ).toBe(true);
          const extraction = vi.spyOn(extractionRuntime, 'loadTypeScriptExtractionRuntime');
          const indexing = vi.spyOn(f.indexer, 'index');
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              extraction.mockRestore();
              indexing.mockRestore();
            }),
          );
          let remaining = 3;
          const deadline = yield* makeReadDeadline(10_000);
          const acquired = yield* retrieveNavigationSourceProofs({
            ...f,
            deadline,
            acquireRead: Effect.sync(() => remaining-- > 0),
          });
          expect(remaining).toBe(0);
          expect(extraction).not.toHaveBeenCalled();
          expect(indexing).not.toHaveBeenCalled();
          expect(acquired.facts.counters).toMatchObject({metadataReads: 1, payloadReads: 1, payloadRows: 1});
          expect(acquired.proofs).toHaveLength(1);
          expect(acquired.proofs[0]).toMatchObject({
            basis: 'source-syntactic',
            path: 'operation.ts',
            proof: {
              importSpan: {line: 1},
              ownerSpan: {line: 6, endLine: 12},
              callSpan: {line: 9},
              targetSpan: {line: 9},
              guard: {span: {line: 8}, branch: 'then'},
            },
          });
          expect(acquired.gaps).toEqual([]);
          const scope = {
            repository: f.result.repository.repositoryId,
            worktree: f.result.snapshot.worktreeId,
            project: 'fixture',
            view: {kind: 'disk' as const, id: 'fixture-disk', owner: 'fixture-caller', epoch: 0},
          };
          if (!behavior || !entry || !test || !testCall?.sourceId)
            return yield* Effect.die('Authored route is incomplete');
          const request = {
            result: f.result,
            acquired,
            scope,
            target: {kind: 'anchors' as const, candidateIds: [behavior.id]},
          };
          const before = JSON.stringify(request);
          const structural = assembleStructuralNavigationAnswer(request);
          expect(JSON.stringify(request)).toBe(before);
          expect(assembleStructuralNavigationAnswer(request)).toEqual(structural);
          // Compose raw canonical citations with the actual physical route, without further acquisition.
          const observedAt = '2026-11-07T00:00:00.000Z';
          const memoryProjects = {mode: 'allow-projects-and-projectless', projects: ['memory-fixture']} as const;
          const target = {
            kind: 'symbol',
            nodeId: behavior.id,
            language: behavior.language,
            name: behavior.name,
            qualifiedName: behavior.qualifiedName,
            symbolKind: behavior.kind,
            span: behavior.span,
            fragmentCanonicalization: 'utf8-source-span-v1',
            fragmentHash: {algorithm: 'sha256', value: behavior.contentHash},
          } as const;
          const citation = createMemoryCodeCitation({
            version: 1,
            extractorSet: 'fixture',
            repositoryId: scope.repository,
            repositoryIdentityKind: 'local',
            path: behavior.path,
            target,
            fileContentHash: {algorithm: 'sha256', value: behavior.contentHash},
            sourceCommit: f.result.snapshot.commit,
            sourceDirty: false,
            sourceSnapshotId: f.result.snapshot.id,
          });
          const candidate = (
            name: string,
            pin = citation,
            changes: Partial<ContextBriefMemoryCandidateV1> = {},
          ): ContextBriefMemoryCandidateV1 => ({
            uri: `threadnote://memory/tn_${name}`,
            kind: 'durable',
            project: 'memory-fixture',
            rank: 0,
            authority: 'user_approved',
            trust: 'approved',
            excerpt: name,
            citationErrorCount: 0,
            codeCitations: [pin],
            codeLinkMatches: [
              {
                anchorNodeId: behavior.id,
                anchorPath: behavior.path,
                anchorOrdinal: 0,
                citationId: pin.id,
                matchKind: pin.target.kind === 'file' ? 'file-path' : 'symbol-node',
              },
            ],
            actionCard: {appliesTo: 'saveNote', invariant: name},
            ...changes,
          });
          const {id: _citationId, ...citationInput} = citation;
          const current = candidate('current');
          const stale = candidate(
            'stale',
            createMemoryCodeCitation({
              ...citationInput,
              fileContentHash: {algorithm: 'sha256', value: EffectString.repeat(64)('0')},
            }),
          );
          const proposed = candidate('proposed', citation, {authority: 'agent_generated', trust: 'inferred'});
          const file = candidate('file', createMemoryCodeCitation({...citationInput, target: {kind: 'file'}}), {
            project: undefined,
          });
          const unrelated = candidate(
            'unrelated',
            createMemoryCodeCitation({
              ...citationInput,
              target: {
                ...target,
                nodeId: `cgs_${EffectString.repeat(32)('f')}`,
                name: 'writeLookingPure',
                qualifiedName: 'writeLookingPure',
              },
            }),
          );
          const excluded = [
            unrelated,
            candidate('foreign', citation, {project: 'foreign'}),
            candidate(
              'foreign_repository',
              createMemoryCodeCitation({...citationInput, repositoryId: EffectString.repeat(64)('a')}),
            ),
            candidate(
              'foreign_identity',
              createMemoryCodeCitation({...citationInput, repositoryIdentityKind: 'remote'}),
            ),
            candidate('missing_citation', citation, {codeCitations: []}),
          ];
          const rawMemory = (candidates: readonly ContextBriefMemoryCandidateV1[]): ContextBriefMemoryRetrievalV1 => ({
            candidates,
            consideredCandidates: candidates.length,
            codeAnchorCoverage: {
              complete: false,
              matchedMemories: candidates.length,
              requested: 2,
              resolved: 1,
              unresolvedOrdinals: [1],
            },
            gaps: ['code-anchors-unresolved'],
            trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
            citationValidations: EffectArray.map(candidates, memory => ({
              uri: memory.uri,
              receipts: EffectArray.map(memory.codeCitations, pin => ({
                citationId: pin.id,
                candidateCount: 1,
                coverage: 'current-complete',
                kind: pin.target.kind,
                observedAt,
                observedPath: behavior.path,
                observedNodeId: behavior.id,
                reason: memory.uri === stale.uri ? 'source-changed' : 'exact',
                status: memory.uri === stale.uri ? 'changed' : 'exact',
                strategy: 'node-id',
                validatorVersion: 1,
              })),
            })),
          });
          const composition = {
            structural,
            graph: fromRepositoryQuery(f.result),
            observedAt,
            memoryProjects,
            plan: planContextBrief({
              budgetTokens: 1500,
              mode: 'brief',
              task: 'saveNote',
              scope: {kind: 'repository', callerCwd: f.cwd},
            }),
            repositoryIdentityKind: 'local' as const,
          };
          const noMemory = projectStructuralNavigationAnswer(composition, 1500);
          expect(noMemory).toEqual(projectNavigationAnswer(structural, 1500));
          expect(EffectArray.map(noMemory.structuredContent.roles, role => role[1])).toEqual([
            'supported',
            'supported',
            'supported',
            'supported',
          ]);
          for (const [applicable, freshness, authority, memoryTrust] of [
            [current, 'fresh', 'user_approved', 'approved'],
            [stale, 'stale', 'user_approved', 'approved'],
            [proposed, 'fresh', 'agent_generated', 'inferred'],
            [file, 'fresh', 'user_approved', 'approved'],
          ] as const) {
            const memory = rawMemory([applicable, ...excluded]);
            const immutable = JSON.stringify({composition, memory});
            const projected = projectStructuralNavigationAnswer({...composition, memory}, 1500);
            expect(projected.structuredContent.memory).toEqual([
              expect.objectContaining({uri: applicable.uri, freshness, authority, memoryTrust}),
            ]);
            expect(projected.structuredContent.memory[0].actionCard !== undefined).toBe(freshness === 'fresh');
            expect(projected.structuredContent.omissions.memory).toBe(0);
            expect(projected.structuredContent.nodes).toEqual(noMemory.structuredContent.nodes);
            expect(projected.structuredContent.roles).toEqual(noMemory.structuredContent.roles);
            expect(projected.structuredContent.effects).toEqual(noMemory.structuredContent.effects);
            expect(projected.structuredContent.gaps).toContain('code-anchors-unresolved');
            expect(projected.structuredContent.gaps).toContain('navigation-memory-coverage-incomplete');
            expect(JSON.stringify({composition, memory})).toBe(immutable);
          }
          const mixed = rawMemory([current, stale, proposed, file, ...excluded]);
          const selected = selectContextBriefNavigationMemory({
            memory: mixed,
            memoryProjects,
            repositoryIdentityKind: 'local',
            anchors: [{nodeId: behavior.id, path: behavior.path, repositoryId: scope.repository}],
          });
          expect(selected.candidates).toHaveLength(4);
          expect(selected.codeAnchorCoverage).toEqual({...mixed.codeAnchorCoverage, matchedMemories: 4});
          expect(selected.citationValidations).toBe(mixed.citationValidations);
          const mixedProjection = projectStructuralNavigationAnswer({...composition, memory: mixed}, 1500);
          expect(
            mixedProjection.structuredContent.memory.length + mixedProjection.structuredContent.omissions.memory,
          ).toBe(4);
          expect(
            EffectArray.every(
              mixedProjection.structuredContent.memory,
              memory => !EffectArray.some(excluded, entry => entry.uri === memory.uri),
            ),
          ).toBe(true);
          const unresolvedProject = projectStructuralNavigationAnswer(
            {...composition, memory: mixed, memoryProjects: undefined},
            1500,
          );
          expect(unresolvedProject.structuredContent.memory).toEqual([]);
          expect(unresolvedProject.structuredContent.gaps).toContain('memory-project-scope-unavailable');
          const empty = projectStructuralNavigationAnswer({...composition, memory: rawMemory([])}, 1500);
          expect(empty.structuredContent.roles).toEqual(noMemory.structuredContent.roles);
          expect(empty.structuredContent.effects).toEqual(noMemory.structuredContent.effects);
          // Reuse the real acquired observation: project metadata changes must never relabel its evidence.
          const projectCoverage: CodeGraphProjectCoverage = {
            project: 'selected-project-a',
            kind: 'project',
            configuredRoots: ['operation.ts'],
            rootComponents: 1,
            dependencyComponents: 0,
            completeness: 'partial',
            negativeProof: 'unavailable',
            observedWorktreeCommit: f.result.snapshot.commit,
            reusedEquivalentSnapshot: false,
          };
          const projectRequest = (coverage: CodeGraphProjectCoverage) => ({
            ...request,
            scope: {...scope, project: coverage.project},
            result: {...f.result, projectCoverage: coverage},
            acquired: {
              ...acquired,
              facts: {...acquired.facts, observation: {...acquired.facts.observation, projectCoverage: coverage}},
            },
          });
          const partialRequest = projectRequest(projectCoverage);
          const mismatched = assembleStructuralNavigationAnswer({
            ...partialRequest,
            scope: {...scope, project: 'requested-project-b'},
          });
          expect(mismatched.answer.coverage.status).toBe('unavailable');
          expect(mismatched.answer.gaps).toContain('navigation-project-observation-conflict');
          expect(mismatched.answer.sources).toEqual([]);
          expect(mismatched.answer.nodes).toEqual([]);
          expect(mismatched.proofLocators).toEqual([]);
          expect(EffectArray.every(mismatched.answer.roles, role => role.status === 'unavailable')).toBe(true);
          const partialProject = assembleStructuralNavigationAnswer(partialRequest);
          expect(partialProject.answer.roles).toEqual(structural.answer.roles);
          expect(partialProject.proofLocators).toHaveLength(1);
          expect(partialProject.answer.coverage.status).toBe('partial');
          expect(partialProject.answer.gaps).toEqual(
            expect.arrayContaining([
              'navigation-project-coverage-partial',
              'navigation-project-negative-proof-unavailable',
            ]),
          );
          expect(
            EffectArray.every(partialProject.answer.sources, source => source.project === 'selected-project-a'),
          ).toBe(true);
          const completeRequest = projectRequest({
            ...projectCoverage,
            completeness: 'complete',
            negativeProof: 'selected-graph-only',
          });
          const completeProject = assembleStructuralNavigationAnswer(completeRequest);
          expect(completeProject.answer.roles).toEqual(partialProject.answer.roles);
          expect(completeProject.proofLocators).toHaveLength(1);
          expect(completeProject.answer.coverage.status).toBe('partial');
          expect(completeProject.answer.gaps).not.toContain('navigation-project-coverage-partial');
          expect(completeProject.answer.gaps).not.toContain('navigation-project-negative-proof-unavailable');
          expect(completeProject.answer).not.toEqual(partialProject.answer);
          for (const foreignObservation of [
            {
              ...partialRequest,
              acquired: {
                ...partialRequest.acquired,
                facts: {
                  ...partialRequest.acquired.facts,
                  observation: {
                    ...partialRequest.acquired.facts.observation,
                    projectCoverage: {...projectCoverage, project: 'foreign-project'},
                  },
                },
              },
            },
            {...partialRequest, acquired: completeRequest.acquired},
            {...partialRequest, acquired},
            {...request, acquired: partialRequest.acquired},
          ]) {
            const rejected = assembleStructuralNavigationAnswer(foreignObservation);
            expect(rejected.answer.coverage.status).toBe('unavailable');
            expect(rejected.answer.gaps).toContain('navigation-project-observation-conflict');
            expect(rejected.answer.nodes).toEqual([]);
            expect(rejected.answer.sources).toEqual([]);
            expect(rejected.proofLocators).toEqual([]);
          }
          expect(structural.answer.roles).toEqual([
            expect.objectContaining({role: 'entrypoint', status: 'supported'}),
            expect.objectContaining({role: 'implementation', status: 'supported'}),
            expect.objectContaining({role: 'effects', status: 'supported', nodeIds: [behavior.id]}),
            expect.objectContaining({role: 'tests', status: 'supported', nodeIds: [test.id]}),
          ]);
          expect(structural.answer.nodes).toContainEqual(
            expect.objectContaining({
              id: entry.id,
              startLine: 14,
              endLine: 14,
              roles: ['entrypoint'],
            }),
          );
          const owner = EffectOption.getOrUndefined(
            EffectArray.findFirst(structural.answer.nodes, node => node.id === behavior.id),
          );
          expect(owner).toMatchObject({
            startLine: 6,
            endLine: 12,
            roles: ['implementation', 'effects'],
            possibleEffect: {kind: 'durable-write', target: 'path', condition: 'then branch of (persist)'},
            basis: ['inspected-source', 'structural'],
            freshness: 'verified-current',
          });
          expect(
            EffectOption.getOrUndefined(
              EffectArray.findFirst(structural.answer.sources, source => source.id === owner?.sourceId),
            ),
          ).toMatchObject({
            ...scope,
            path: 'operation.ts',
            contentHash: behavior.contentHash,
            snapshot: f.result.snapshot.id,
            freshness: 'verified-current',
          });
          expect(structural.proofLocators).toEqual([
            expect.objectContaining({
              sourceId: owner?.sourceId,
              target: 'path',
              condition: 'then branch of (persist)',
              accepted: acquired.proofs[0],
              scope,
              snapshot: f.result.snapshot,
            }),
          ]);
          expect(structural.proofLocators[0].accepted.proof).toMatchObject({
            callSpan: {line: 9},
            guard: {span: {line: 8}},
          });
          expect(structural.answer.nodes).toContainEqual(
            expect.objectContaining({
              id: test.id,
              startLine: 4,
              endLine: 7,
              testAssociation: 'source-supported',
            }),
          );
          expect(structural.answer.links).toContainEqual(
            expect.objectContaining({
              from: test.id,
              to: testCall.sourceId,
              relation: 'contains',
              basis: 'structural',
            }),
          );
          expect(structural.answer.links).toContainEqual(
            expect.objectContaining({
              from: testCall.sourceId,
              to: behavior.id,
              relation: 'calls',
              basis: 'structural',
            }),
          );
          expect(
            EffectArray.some(structural.answer.links, link => link.from === test.id && link.to === behavior.id),
          ).toBe(false);
          expect(structural.answer.nodes).toContainEqual(
            expect.objectContaining({startLine: 15, roles: ['entrypoint']}),
          );
          expect(structural.input.candidates).toContainEqual(
            expect.objectContaining({
              startLine: 9,
              endLine: 11,
              roles: ['tests'],
              support: 'candidate',
              testAssociation: 'name-only',
            }),
          );
          expect(
            EffectArray.some(structural.answer.nodes, node => node.startLine === 9 && node.roles.includes('effects')),
          ).toBe(false);
          // Weakening source/proof support never promotes a possible write or claims purity.
          for (const weakened of [
            {...request, acquired: {...acquired, proofs: []}},
            {...request, acquired: {...acquired, source: {...acquired.source, excerpts: []}}},
            {...request, result: {...f.result, freshness: 'stale' as const}},
            {...request, scope: {...scope, view: {...scope.view, kind: 'editor' as const}}},
            {
              ...request,
              acquired: {
                ...acquired,
                facts: {
                  ...acquired.facts,
                  observation: {
                    ...acquired.facts.observation,
                    snapshot: {...acquired.facts.observation.snapshot, id: 'other-snapshot'},
                  },
                },
              },
            },
          ]) {
            const answer = assembleStructuralNavigationAnswer(weakened);
            expect(answer.proofLocators).toEqual([]);
            expect(
              EffectOption.getOrUndefined(EffectArray.findFirst(answer.answer.roles, role => role.role === 'effects'))
                ?.status,
            ).toBe('unknown');
            expect(EffectArray.every(answer.answer.nodes, node => node.possibleEffect === undefined)).toBe(true);
          }
          expect(extraction).not.toHaveBeenCalled();
          expect(indexing).not.toHaveBeenCalled();
          expect(remaining).toBe(0);
          fc.assert(
            fc.property(fc.integer({min: 0, max: 1024}), fc.integer({min: 0, max: 1024}), (left, right) => {
              const crop = (limit: number) =>
                EffectArray.map(acquired.source.excerpts, excerpt => ({
                  ...excerpt,
                  content: EffectString.slice(0, limit)(excerpt.content),
                }));
              const smaller = navigationProofSpansInspected(acquired.proofs[0].proof, crop(Math.min(left, right)));
              const larger = navigationProofSpansInspected(acquired.proofs[0].proof, crop(Math.max(left, right)));
              expect(!smaller || larger).toBe(true);
            }),
            {numRuns: 80},
          );

          const sourceRead = vi
            .spyOn(sourceEvidence, 'retrieveContextBriefSourceEvidence')
            .mockImplementation(() => Effect.die('no source acquisition after cap refusal'));
          yield* Effect.addFinalizer(() => Effect.sync(() => sourceRead.mockRestore()));
          for (const allowance of [1, 2]) {
            let remaining = allowance;
            const stopped = yield* retrieveNavigationSourceProofs({
              ...f,
              deadline,
              acquireRead: Effect.sync(() => {
                if (remaining === 0) return false;
                remaining--;
                return true;
              }),
            });
            expect(remaining).toBe(0);
            expect(stopped.facts.counters).toMatchObject({metadataReads: 1, payloadReads: allowance - 1});
            expect(stopped.proofs).toEqual([]);
            expect(stopped.gaps).toContain('navigation-read-budget-exhausted');
            expect(sourceRead).not.toHaveBeenCalled();
          }
          const noEnumeration = <A>(values: A[]) =>
            new Proxy(values, {
              get(target, key) {
                if (key !== 'length') throw new Error('no rejected-array enumeration');
                return Reflect.get(target, key);
              },
            });
          for (const input of [
            {...f, result: {...f.result, nodes: noEnumeration(Array.from({length: 25}, () => f.result.nodes[0]))}},
            {...f, result: {...f.result, edges: noEnumeration(Array.from({length: 65}, () => f.result.edges[0]))}},
            {...f, selectors: noEnumeration(Array.from({length: 25}, () => f.selectors[0]))},
          ]) {
            const denied = yield* retrieveNavigationSourceProofs({
              ...input,
              acquireRead: Effect.die('no allowance after cap refusal'),
            });
            expect(denied.proofs).toEqual([]);
            expect(denied.gaps.length).toBeGreaterThan(0);
            expect(sourceRead).not.toHaveBeenCalled();
          }
          let deniedReads = 0;
          const exhausted = yield* retrieveNavigationSourceProofs({
            ...f,
            acquireRead: Effect.sync(() => {
              deniedReads++;
              return false;
            }),
          });
          expect(exhausted.gaps).toContain('navigation-read-budget-exhausted');
          expect(deniedReads).toBe(1);
          expect(sourceRead).not.toHaveBeenCalled();
          sourceRead.mockRestore();

          yield* Effect.log(
            'NAV02_GAP02_PHYSICAL',
            JSON.stringify({
              variant: 'canonical',
              snapshot: f.result.snapshot,
              query: {nodes: f.result.nodes.length, edges: f.result.edges.length},
              counters: acquired.facts.counters,
              proofs: acquired.proofs,
              source: EffectArray.map(acquired.source.excerpts, excerpt => ({
                path: excerpt.path,
                startLine: excerpt.startLine,
                endLine: excerpt.endLine,
                bytes: Buffer.byteLength(excerpt.content),
              })),
            }),
          );
          for (const span of [
            acquired.proofs[0].proof.importSpan,
            acquired.proofs[0].proof.callSpan,
            acquired.proofs[0].proof.calleeSpan,
            acquired.proofs[0].proof.targetSpan,
            acquired.proofs[0].proof.guard.span,
          ]) {
            const cropped = EffectArray.map(
              EffectArray.filter(acquired.source.excerpts, excerpt => excerpt.path === 'operation.ts'),
              excerpt => {
                if (span.line < excerpt.startLine || span.line > excerpt.endLine) return excerpt;
                const lines = EffectString.split('\n')(excerpt.content);
                const offset = span.line - excerpt.startLine;
                return {
                  ...excerpt,
                  content: EffectArray.join(
                    [...lines.slice(0, offset), EffectString.slice(0, span.endColumn - 2)(lines[offset])],
                    '\n',
                  ),
                  endLine: span.line,
                  truncated: true,
                };
              },
            );
            expect(navigationProofSpansInspected(acquired.proofs[0].proof, cropped)).toBe(false);
            const weakened = assembleStructuralNavigationAnswer({
              ...request,
              acquired: {...acquired, source: {...acquired.source, excerpts: cropped}},
            });
            expect(weakened.proofLocators).toEqual([]);
            expect(
              EffectOption.getOrUndefined(EffectArray.findFirst(weakened.answer.roles, role => role.role === 'effects'))
                ?.status,
            ).toBe('unknown');
          }
          expect(acquired.source.excerpts.length).toBeLessThanOrEqual(6);
          expect(new Set(EffectArray.map(acquired.source.excerpts, excerpt => excerpt.path)).size).toBeLessThanOrEqual(
            3,
          );
          for (const excerpt of acquired.source.excerpts)
            expect(excerpt.endLine - excerpt.startLine + 1).toBeLessThanOrEqual(24);
          const omitted = yield* retrieveNavigationSourceProofs({
            ...f,
            maximumContentBytes: 0,
            acquireRead: Effect.succeed(true),
          });
          expect(omitted.proofs).toEqual([]);
          expect(omitted.gaps).toContain('navigation-proof-source-incomplete');
          yield* f.fs.writeFileString(
            f.path.join(f.cwd, 'operation.ts'),
            manifest.sources[0].content + '\n// hash drift\n',
          );
          const drift = yield* retrieveNavigationSourceProofs({...f, acquireRead: Effect.succeed(true)});
          expect(drift.proofs).toEqual([]);
          expect(drift.gaps).toContain('graph-source-snapshot-not-current');
        }),
      ),
    );
  });
  it.effect('acquires a far import and owner through supplemental production source range selection', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const multiWrite = EffectString.replace(
          '    await writeFile(path, normalized);\n  }',
          '    await writeFile(path, normalized);\n  } else {\n    await writeBackup(text, normalized);\n  }',
        )(EffectString.replace('{writeFile}', '{writeFile, writeFile as writeBackup}')(manifest.sources[0].content));
        const lines = EffectString.split('\n')(multiWrite);
        const content =
          EffectString.repeat(80)('// padding\n') +
          lines[0] +
          '\n' +
          EffectString.repeat(80)('\n') +
          EffectArray.join(lines.slice(1), '\n');
        const f = yield* physicalFixture(content);
        const ordinary = sourceEvidence.selectContextBriefSourceRanges(
          sourceEvidence.contextBriefSourceRangeCandidates(f.result),
        );
        expect(
          EffectArray.some(
            ordinary,
            range => range.path === 'operation.ts' && range.startLine <= 81 && range.endLine >= 81,
          ),
        ).toBe(false);
        let remaining = 3;
        const acquired = yield* retrieveNavigationSourceProofs({...f, acquireRead: Effect.sync(() => remaining-- > 0)});
        expect(acquired.proofs).toHaveLength(2);
        expect(acquired.proofs[0].proof.importSpan.line).toBe(81);
        expect(acquired.proofs[0].proof.ownerSpan.line).toBe(166);
        expect(EffectArray.filter(acquired.source.excerpts, excerpt => excerpt.path === 'operation.ts')).toHaveLength(
          2,
        );
        expect(remaining).toBe(0);
        const structural = assembleStructuralNavigationAnswer({
          result: f.result,
          acquired,
          scope: {
            repository: f.result.repository.repositoryId,
            worktree: f.result.snapshot.worktreeId,
            project: 'fixture',
            view: {kind: 'disk', id: 'fixture-disk', owner: 'fixture-caller', epoch: 0},
          },
          target: {kind: 'anchors', candidateIds: [acquired.proofs[0].proof.ownerId]},
        });
        const owner = EffectOption.getOrUndefined(
          EffectArray.findFirst(structural.answer.nodes, node => node.id === acquired.proofs[0].proof.ownerId),
        );
        expect(owner).toMatchObject({roles: ['implementation', 'effects'], startLine: 166, endLine: 174});
        expect(owner?.possibleEffect).toBeUndefined();
        expect(
          EffectOption.getOrUndefined(EffectArray.findFirst(structural.answer.roles, role => role.role === 'effects')),
        ).toMatchObject({
          status: 'supported',
          nodeIds: [owner?.id],
        });
        expect(EffectArray.map(structural.proofLocators, locator => [locator.target, locator.condition])).toEqual([
          ['path', 'then branch of (persist)'],
          ['text', 'else branch of (persist)'],
        ]);
        expect(EffectArray.map(structural.proofLocators, locator => locator.accepted)).toEqual(acquired.proofs);
        // The graph's existing same-callee edge identity can retain only one call site.
        // Its finite closure must expose the missing branch instead of upgrading the one accepted proof.
        const sameCalleeContent = EffectString.replace(
          'writeBackup(text',
          'writeFile(text',
        )(EffectString.replace('{writeFile, writeFile as writeBackup}', '{writeFile}')(content));
        const sameCallee = yield* physicalFixture(sameCalleeContent);
        let sameRemaining = 3;
        const partial = yield* retrieveNavigationSourceProofs({
          ...sameCallee,
          acquireRead: Effect.sync(() => sameRemaining-- > 0),
        });
        expect(sameRemaining).toBe(0);
        expect(partial.proofs).toHaveLength(1);
        expect(partial.facts.files[0]).toMatchObject({state: 'omitted', facts: {omitted: true}});
        expect(partial.gaps).toContain('navigation-ready-closure-missing');
        const incomplete = assembleStructuralNavigationAnswer({
          result: sameCallee.result,
          acquired: partial,
          scope: {
            ...structural.input.scope,
            repository: sameCallee.result.repository.repositoryId,
            worktree: sameCallee.result.snapshot.worktreeId,
          },
          target: {kind: 'anchors', candidateIds: [partial.proofs[0].proof.ownerId]},
        });
        expect(incomplete.answer.outcome).toBe('partial');
        expect(incomplete.answer.coverage.status).toBe('partial');
        expect(incomplete.answer.gaps).toEqual(
          expect.arrayContaining(['navigation-ready-closure-missing', 'navigation-facts-omitted']),
        );
        expect(incomplete.proofLocators).toHaveLength(1);
        const omitted = yield* retrieveNavigationSourceProofs({
          ...f,
          maximumContentBytes: 0,
          acquireRead: Effect.succeed(true),
        });
        expect(omitted.proofs).toEqual([]);
        expect(omitted.gaps).toContain('navigation-proof-source-incomplete');
      }),
    ),
  );
  for (const shadow of [false, true])
    it.effect(`physical incremental ready proofs match clean rebuild: ${shadow ? 'shadow' : 'direct alias'}`, () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const f = yield* fixture;
          const local = shadow ? 'persistFileB' : 'persistFileA';
          let changed = EffectString.replace(
            'await writeFile(path, normalized)',
            `await ${local}(path, normalized)`,
          )(EffectString.replace('{writeFile}', `{writeFile as ${local}}`)(manifest.sources[0].content));
          if (shadow)
            changed = EffectString.replace('persist: boolean)', `persist: boolean, ${local}: Function)`)(changed);
          yield* f.fs.writeFileString(f.path.join(f.cwd, 'operation.ts'), changed);
          const incrementalSummary = yield* f.indexer.index({
            cwd: f.cwd,
            threadnoteHome: f.home,
            sourceOnly: true,
            vectorPolicy: 'off',
            incrementalOverlay: true,
          });
          const incremental = yield* f.prepare(incrementalSummary, f.home);
          const cleanHome = f.path.join(f.path.dirname(f.home), 'clean-home');
          yield* f.fs.makeDirectory(cleanHome);
          const cleanSummary = yield* f.indexer.index({
            cwd: f.cwd,
            threadnoteHome: cleanHome,
            sourceOnly: true,
            vectorPolicy: 'off',
            incrementalOverlay: false,
          });
          const clean = yield* f.prepare(cleanSummary, cleanHome);
          const left = yield* retrieveNavigationSourceProofs({...incremental, acquireRead: Effect.succeed(true)});
          const right = yield* retrieveNavigationSourceProofs({...clean, acquireRead: Effect.succeed(true)});
          for (const acquired of [left, right]) {
            expect(acquired.facts.files[0].state).toBe('available');
            expect(acquired.facts.files[0].facts?.version).toBe(1);
            expect(acquired.facts.files[0].facts?.proofs).toHaveLength(shadow ? 0 : 1);
            expect(acquired.facts.counters).toMatchObject({metadataReads: 1, payloadReads: 1, payloadRows: 1});
            expect(acquired.gaps).toEqual([]);
          }
          expect(left.facts.files[0].facts).toEqual(right.facts.files[0].facts);
          expect(left.proofs).toEqual(right.proofs);
          expect(left.proofs).toHaveLength(shadow ? 0 : 1);
          yield* Effect.log(
            'NAV02_GAP02_PHYSICAL',
            JSON.stringify({
              variant: shadow ? 'shadow' : 'alias',
              incremental: {
                snapshot: incremental.result.snapshot,
                query: {nodes: incremental.result.nodes.length, edges: incremental.result.edges.length},
                counters: left.facts.counters,
                proofs: left.proofs,
              },
              clean: {
                snapshot: clean.result.snapshot,
                query: {nodes: clean.result.nodes.length, edges: clean.result.edges.length},
                counters: right.facts.counters,
                proofs: right.proofs,
              },
            }),
          );
        }),
      ),
    );
});
