import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Clock, Deferred, Effect, Fiber, FileSystem, Option, Path, Schema} from 'effect';
import * as EffectString from 'effect/String';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {canonicalFileUri, type Evidence} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {loadRecallCodeLinks} from '@threadnote/recall/index';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {planContextBrief} from '@threadnote/context/planner';
import {projectContextBrief} from '@threadnote/context/projector';
import {compileContextBriefWith} from '@threadnote/context/compiler';
import {
  CommandCleanupUnconfirmed,
  CommandExecutor,
  CommandSpawnFailed,
  CommandTimedOut,
  runCommandEffect,
} from '@threadnote/platform/command';
import {makeReadDeadline, ReadDeadlineExceeded} from '@threadnote/platform/read_deadline';
import {SystemInfo} from '@threadnote/platform/system';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {ReadyRecallReadWorkerAdmission} from '../../src/recall/ready_read_boundary.js';
import {
  CONTEXT_BRIEF_NATIVE_READ_STATUS_PROGRESS,
  contextBriefNativeReadBinding,
  contextBriefNativeReadRequestSchema,
  ContextBriefNativeReadFailed,
  encodeContextBriefScopedReadyProgress,
  withNativeContextBriefReadSources,
  ContextBriefNativeReadWorkers,
  prestartContextBriefNativeReadWorkers,
  type ContextBriefNativeReadRequest,
} from '../../src/context_brief/native_read_boundary.js';
import {nativeContextReadCommands} from '../../src/context_brief/native_read_worker.js';
import {
  compileSemanticContextKnowledge,
  type ContextBriefRuntimeCompilerSources,
} from '../../src/context_brief/index.js';
import type {ContextBriefGraphReadBudget} from '@threadnote/context/graph/evidence';
import type {ContextBriefGraphEvidenceV1} from '@threadnote/context/types';
import {provideTestLayer} from '../helpers/effect-layer.js';
import type {CommandOptions} from '@threadnote/platform/command';

/** A worker answers only after its request arrives; a prestarted one receives it later through `deferredInput`. */
const requestInput = (options?: CommandOptions) =>
  options?.deferredInput === undefined
    ? Effect.succeed(options?.input)
    : Effect.map(Deferred.await(options.deferredInput), deferred => deferred.input);
import {withProductionLogging, withProductionPhaseTiming} from '../../src/effect/production_log.js';
import {native} from '@threadnote/graph/test/helpers/native-typescript-session';

const sources: ContextBriefRuntimeCompilerSources = {
  graphEvidence: () => Effect.die('Native graph reads must not fall back in process.'),
  citationValidation: () => Effect.die('Native citation reads must not fall back in process.'),
  memoryEvidence: () =>
    Effect.succeed({
      candidates: [],
      consideredCandidates: 0,
      gaps: [],
      trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
    }),
  projection: (logical, budget, format) => Effect.sync(() => projectContextBrief(logical, budget, format)),
};

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-context-'}));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  yield* fs.makeDirectory(path.join(repo, 'src'), {recursive: true});
  yield* fs.makeDirectory(home, {recursive: true});
  yield* fs.writeFileString(path.join(home, 'layout.json'), JSON.stringify({createdBy: 'threadnote', version: 2}));
  const file = path.join(repo, 'src', 'module.ts');
  yield* fs.writeFileString(file, 'export function boundedAnswer() { return 42; }\n');
  const git = (args: readonly string[]) => runCommandEffect('git', args, {cwd: repo});
  yield* git(['init', '-q']);
  yield* git(['add', '.']);
  yield* git(['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'fixture']);
  const config = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    manifestPath: path.join(home, 'manifest.json'),
    user: 'test',
  };
  yield* fs.writeFileString(
    config.manifestPath,
    JSON.stringify({
      version: 1,
      projects: [{name: 'fixture', path: repo, uri: 'threadnote://projects/fixture', seed: []}],
    }),
  );
  return {fs, path, root, repo, home, file, config};
});

describe('whole native Context Brief read boundary', () => {
  it('binds a closed request independently of object insertion order', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 80}), task => {
        const config = {
          account: 'local',
          agentContextHome: '/private/fixture',
          agentId: 'test',
          manifestPath: '/private/fixture/manifest.json',
          user: 'test',
        };
        const request: ContextBriefNativeReadRequest = {
          protocol: 1,
          config,
          remainingMilliseconds: 3000,
          operation: 'procedures',
          task,
        };
        expect(contextBriefNativeReadBinding(request)).toBe(
          contextBriefNativeReadBinding({
            task,
            operation: 'procedures',
            remainingMilliseconds: 3000,
            config: {...config},
            protocol: 1,
          }),
        );
      }),
      {numRuns: 24},
    );
  });

  it('binds composite proof to candidate content, scope, limits and graph fence', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 80}), excerpt => {
        const plan = planContextBrief({
          scope: {kind: 'repository', callerCwd: '/fixture'},
          codeRefs: ['src/module.ts'],
          task: 'answer',
        });
        const candidate = {
          kind: 'durable' as const,
          uri: 'threadnote://fixture/memory',
          excerpt,
          rank: 0,
          citationErrorCount: 0,
          codeCitations: [],
        };
        const request: ContextBriefNativeReadRequest = {
          protocol: 1,
          operation: 'memory',
          remainingMilliseconds: 3000,
          config: {
            account: 'local',
            agentContextHome: '/fixture/home',
            agentId: 'test',
            manifestPath: '/fixture/manifest.json',
            user: 'test',
          },
          plan: plan.codeAnchors,
          candidateLimit: plan.memory.candidateLimit,
          lexicalMemory: {
            candidates: [candidate],
            consideredCandidates: 1,
            gaps: [],
            trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
          },
          fence: {kind: 'repository', repositoryId: 'repo', snapshotId: 'snapshot'},
        };
        const binding = contextBriefNativeReadBinding(request);
        for (const changed of [
          {...request, lexicalMemory: {...request.lexicalMemory, candidates: [{...candidate, excerpt: excerpt + '!'}]}},
          {...request, lexicalMemory: {...request.lexicalMemory, candidates: []}},
          {...request, candidateLimit: request.candidateLimit + 1},
          {...request, plan: {...request.plan, scope: {kind: 'repository' as const, callerCwd: '/foreign'}}},
          {...request, fence: {kind: 'repository' as const, repositoryId: 'repo', snapshotId: 'changed'}},
        ])
          expect(contextBriefNativeReadBinding(changed)).not.toBe(binding);
      }),
      {numRuns: 24},
    );
  });

  effectIt.effect(
    'real ready graph and citation reads retain the current snapshot fence, then detect source drift',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* (yield* CodeGraphIndexer).index({
          cwd: f.repo,
          threadnoteHome: f.home,
          ensureVectors: false,
          sourceOnly: true,
        });
        const citations = yield* captureMemoryCodeCitations(f.config, {callerCwd: f.repo, refs: ['src/module.ts']});
        const native = yield* withNativeContextBriefReadSources(f.config, sources);
        const plan = planContextBrief({
          scope: {kind: 'repository', callerCwd: f.repo, project: 'fixture'},
          codeRefs: ['src/module.ts'],
          detail: 'source',
          mode: 'locate',
          task: 'boundedAnswer',
        });
        const budget: ContextBriefGraphReadBudget = {
          remaining: 2,
          primaryRemaining: 17,
          deadline: yield* makeReadDeadline(5000),
        };
        const graph = yield* native.graphEvidence(plan.graph, budget);
        expect(graph.cards.length).toBeGreaterThan(0);
        expect(budget.statusObserved).toBe(true);
        expect(graph.resolvedSnapshots[0]?.dirty).toBe(false);
        expect(graph.citationValidationFence?.kind).toBe('repository');
        expect(graph.sourceExcerpts?.[0]?.content).toContain('boundedAnswer');
        const candidate = {
          citationErrorCount: 0,
          codeCitations: citations,
          excerpt: 'Bounded answer contract.',
          kind: 'durable' as const,
          project: 'fixture',
          rank: 0,
          uri: 'threadnote://user/test/memories/durable/answer.md',
        };
        const linkedFile = f.path.join(f.home, 'data/local/user/test/memories/durable/projects/fixture/linked.md');
        yield* f.fs.makeDirectory(f.path.dirname(linkedFile), {recursive: true});
        yield* f.fs.writeFileString(
          linkedFile,
          formatMemoryDocument(
            'MEMORY',
            {
              codeCitations: citations,
              kind: 'durable',
              project: 'fixture',
              schemaVersion: MEMORY_SCHEMA_VERSION,
              sourceAgentClient: 'codex',
              status: 'active',
              timestamp: '2026-11-01T00:00:00.000Z',
              topic: 'linked',
            },
            'Canonical linked contract.',
          ),
        );
        const linkedUri = 'threadnote://user/test/memories/durable/projects/fixture/linked.md';
        yield* loadRecallCodeLinks(f.config, {
          anchors: citations,
          forceRefresh: true,
          includeInactive: false,
          limit: 24,
          project: 'fixture',
        });
        const lexicalMemory = {
          ...(yield* sources.memoryEvidence(plan.memory)),
          candidates: [
            candidate,
            {...candidate, uri: linkedUri, excerpt: 'Lexical duplicate must yield to linked canonical data.'},
          ],
          consideredCandidates: 2,
        };
        const verified = yield* native.memoryEvidenceAfterGraph!(
          plan,
          lexicalMemory,
          graph.citationValidationFence,
          yield* makeReadDeadline(5000),
        );
        expect(EffectArray.map(verified.candidates, candidate => candidate.uri)).toEqual([linkedUri, candidate.uri]);
        expect(verified.candidates[0]?.excerpt).toContain('Canonical linked contract.');
        expect(verified.candidates[0]?.lexicallySelected).toBe(true);
        expect(EffectArray.map(verified.citationValidations ?? [], validation => validation.uri)).toEqual([
          linkedUri,
          candidate.uri,
        ]);
        expect(
          EffectArray.every(
            verified.citationValidations ?? [],
            validation => validation.receipts[0]?.status === 'exact',
          ),
        ).toBe(true);
        yield* f.fs.writeFileString(f.file, 'export function boundedAnswer() { return 43; }\n');
        const drift = yield* native.citationValidation(
          plan.scope,
          [candidate],
          graph.citationValidationFence,
          yield* makeReadDeadline(5000),
        );
        expect(drift[0]?.receipts[0]?.coverage).toBe('incomplete');
        expect(drift[0]?.receipts[0]?.status).not.toBe('exact');
      }).pipe(
        Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      ),
    {timeout: 20000},
  );

  native(effectIt.effect)(
    'native semantic reads bind the exact document and target, then abstain on foreign project or source drift',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* (yield* CodeGraphIndexer).index({
          cwd: f.repo,
          threadnoteHome: f.home,
          ensureVectors: false,
          sourceOnly: true,
        });
        const nodes = yield* (yield* CodeGraphQueryService).inspect({
          cwd: f.repo,
          threadnoteHome: f.home,
          operation: 'query',
          query: 'boundedAnswer',
          nodeLimit: 10,
          edgeLimit: 1,
          refresh: false,
          requestMaintenance: false,
        });
        const node = Option.getOrUndefined(EffectArray.findFirst(nodes.nodes, item => item.name === 'boundedAnswer'));
        if (!node) throw new Error('Fixture target is missing');
        const worktree = canonicalFileUri((yield* f.path.toFileUrl(f.repo)).href);
        const uri = canonicalFileUri((yield* f.path.toFileUrl(f.file)).href);
        const evidence: Evidence = {
          basis: 'semantic',
          scope: 'document',
          completeness: 'partial',
          limitations: [],
          observation: {
            version: 1,
            repository: sha256HexSync(worktree),
            worktree,
            project: worktree,
            configuration: sha256HexSync('configuration'),
            toolchain: sha256HexSync('toolchain'),
            provider: {id: 'fixture', version: '1', generation: 1},
            view: {kind: 'disk', id: 'fixture', owner: 'fixture', epoch: 0},
            uri,
            content: sha256HexSync(yield* f.fs.readFile(f.file)),
            documentVersion: null,
            projectEpoch: 1,
          },
        };
        const target = {
          evidence,
          uri,
          range: {
            start: {line: node.span.line - 1, character: node.span.column - 1},
            end: {line: node.span.endLine - 1, character: node.span.endColumn - 1},
          },
        };
        const input = {
          scope: {kind: 'repository' as const, callerCwd: f.repo, project: 'fixture'},
          codeRefs: ['src/module.ts'],
          mode: 'explain' as const,
          task: 'Understand boundedAnswer',
          budgetTokens: 1500,
        };
        const knowledge = yield* compileSemanticContextKnowledge(f.config, input, evidence, target);
        expect(knowledge.binding?.semanticContent).toBe(evidence.observation.content);
        expect(knowledge.memorySelection?.nodeId).toBe(node.id);
        expect(knowledge.brief?.graph?.sources?.[0]?.content).toContain('boundedAnswer');
        expect(knowledge.gaps).toContain('semantic-symbol-memory-coverage-incomplete');
        const foreign = {
          ...evidence,
          observation: {
            ...evidence.observation,
            project: canonicalFileUri((yield* f.path.toFileUrl(f.path.join(f.repo, 'foreign'))).href),
          },
        };
        const unbound = yield* compileSemanticContextKnowledge(f.config, input, foreign, {
          ...target,
          evidence: foreign,
        });
        expect(unbound.binding).toBeNull();
        expect(unbound.memorySelection).toBeNull();
        expect(unbound.brief).toBeNull();
        expect(unbound.gaps).toContain('semantic-graph-source-unbound');
        yield* f.fs.writeFileString(f.file, 'export function boundedAnswer() { return 43; }\n');
        const drifted = yield* compileSemanticContextKnowledge(f.config, input, evidence, target);
        expect(drifted.binding).toBeNull();
        expect(drifted.memorySelection).toBeNull();
        expect(drifted.brief).toBeNull();
        expect(drifted.gaps).toContain('semantic-graph-source-unbound');
      }).pipe(
        Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      ),
    {timeout: 20000},
  );

  native(effectIt.effect)(
    'keeps compatible stale scoped graph cards when exact applicability stalls',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const project = {
          name: 'fixture',
          path: f.repo,
          uri: 'threadnote://projects/fixture',
          seed: [],
          graph: {closure: 'dependencies' as const, roots: ['src']},
        };
        const writeProjects = (projects: readonly (typeof project)[]) =>
          f.fs.writeFileString(f.config.manifestPath, JSON.stringify({version: 1, projects}));
        yield* f.fs.writeFileString(f.path.join(f.repo, 'src', 'package.json'), '{"name":"fixture-src"}');
        yield* f.fs.makeDirectory(f.path.join(f.repo, 'other'));
        yield* f.fs.writeFileString(f.path.join(f.repo, 'other', 'package.json'), '{"name":"fixture-other"}');
        yield* runCommandEffect('git', ['add', '.'], {cwd: f.repo});
        yield* runCommandEffect(
          'git',
          ['-c', 'user.name=Threadnote Test', '-c', 'user.email=test@threadnote.local', 'commit', '-qm', 'components'],
          {cwd: f.repo},
        );
        yield* writeProjects([project]);
        yield* (yield* CodeGraphIndexer).index({
          cwd: f.repo,
          project,
          threadnoteHome: f.home,
          ensureVectors: false,
          sourceOnly: true,
        });
        const readGraph = (
          native: ContextBriefRuntimeCompilerSources,
          selection: {project?: string} = {project: 'fixture'},
          anchored = true,
        ) =>
          Effect.gen(function* () {
            const plan = planContextBrief({
              scope: {kind: 'repository', callerCwd: f.repo, ...selection},
              codeRefs: anchored ? ['src/module.ts'] : [],
              detail: 'source',
              mode: 'locate',
              task: anchored ? 'boundedAnswer' : 'Find boundedAnswer in the selected project',
            });
            return yield* native.graphEvidence(plan.graph, {
              remaining: 2,
              primaryRemaining: 17,
              deadline: yield* makeReadDeadline(3500),
            });
          });
        const regular = yield* withNativeContextBriefReadSources(f.config, sources);
        const current = yield* readGraph(regular);
        expect(current.resolvedSnapshots[0]?.freshness).toBe('fresh');
        expect(current.citationValidationFence).toBeDefined();
        expect(current.sourceExcerpts?.[0]?.content).toContain('boundedAnswer');

        const bin = f.path.join(f.root, 'bin');
        yield* f.fs.makeDirectory(bin);
        const gitPath = f.path.join(bin, 'git');
        const realGit = EffectString.trim((yield* runCommandEffect('which', ['git'])).stdout);
        yield* f.fs.writeFileString(
          gitPath,
          `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "ls-tree" ]; then exec ${JSON.stringify(system.executablePath)} -e 'for (;;) {}'; fi\ndone\nexec ${JSON.stringify(realGit)} "$@"\n`,
        );
        yield* f.fs.chmod(gitPath, 0o700);
        const slow = yield* withNativeContextBriefReadSources(f.config, sources).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            environment: () => ({...system.environment(), PATH: `${bin}:${system.environment().PATH ?? ''}`}),
          }),
        );
        yield* f.fs.writeFileString(f.file, 'export function changedAnswer() { return 43; }\n');
        const stale = yield* readGraph(slow);
        expect(stale.resolvedSnapshots[0]).toMatchObject({
          freshness: 'stale',
          snapshotId: current.resolvedSnapshots[0]?.snapshotId,
        });
        expect(EffectArray.some(stale.cards, card => card.symbol.path === 'src/module.ts')).toBe(true);
        expect(stale.projectCoverage).toMatchObject({
          project: 'fixture',
          completeness: 'partial',
          negativeProof: 'unavailable',
        });
        expect(stale.coverage).toMatchObject({complete: false, readyRepositories: 1, states: {stale: 1}});
        expect(stale.gaps).toContain('graph-source-snapshot-not-current');
        expect(stale.citationValidationFence).toBeUndefined();
        expect(stale.sourceExcerpts).toBeUndefined();
        const unanchored = yield* readGraph(slow, {project: 'fixture'}, false);
        expect(unanchored.resolvedSnapshots[0]?.freshness).toBe('stale');
        expect(unanchored.cards[0]?.symbol.name).toBe('boundedAnswer');

        yield* writeProjects([{...project, graph: {...project.graph, roots: ['other']}}]);
        const changed = yield* readGraph(slow).pipe(Effect.flip);
        expect(Schema.is(ReadDeadlineExceeded)(changed)).toBe(true);
        yield* writeProjects([
          project,
          {...project, name: 'other', uri: 'threadnote://projects/other', graph: {...project.graph, roots: ['other']}},
        ]);
        const ambiguous = yield* readGraph(slow, {}).pipe(Effect.flip);
        expect(ambiguous).toMatchObject({_tag: 'CodeGraphScopeRoutingError'});
      }).pipe(
        Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      ),
    {timeout: 15000},
  );

  effectIt.effect(
    'reaps a synchronous native stall and refuses a later pass on the original deadline',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const system = yield* SystemInfo;
        const script = f.path.join(f.root, 'stall.ts');
        yield* f.fs.writeFileString(
          script,
          "import {Database} from 'bun:sqlite'; const db=new Database(':memory:'); db.query('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n').get();",
        );
        const command = yield* CommandExecutor;
        let invocations = 0;
        const native = yield* withNativeContextBriefReadSources(f.config, sources).pipe(
          Effect.provideService(SystemInfo, {...system, developmentEntrypoint: script}),
          Effect.provideService(CommandExecutor, {
            ...command,
            execute: (...args) => {
              invocations += 1;
              return command.execute(...args);
            },
          }),
        );
        const plan = planContextBrief({scope: {kind: 'repository', callerCwd: f.repo}, mode: 'locate', task: 'answer'});
        const empty = yield* native.citationValidation(plan.scope, [], undefined, yield* makeReadDeadline(5000));
        expect(empty).toEqual([]);
        // A read without candidates starts no worker.
        expect(invocations).toBe(0);
        const deadline = yield* makeReadDeadline(1600);
        const budget: ContextBriefGraphReadBudget = {remaining: 2, primaryRemaining: 17, deadline};
        const start = yield* Clock.monotonicTimeNanos;
        const result = yield* withProductionLogging(
          f.home,
          {component: 'cli', operation: 'context.brief'},
          withProductionPhaseTiming('context.brief.graph', native.graphEvidence(plan.graph, budget)),
        ).pipe(Effect.result);
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') expect(Schema.is(ReadDeadlineExceeded)(result.failure)).toBe(true);
        expect(budget.statusObserved).toBeUndefined();
        expect(Number((yield* Clock.monotonicTimeNanos) - start) / 1_000_000).toBeLessThan(1600);
        const second = yield* native.citationValidation(plan.scope, [], undefined, deadline).pipe(Effect.result);
        expect(second._tag).toBe('Failure');
        // The graph read started its worker and one spare; the expired read started none.
        expect(invocations).toBe(2);
        const log = yield* f.fs.readFileString(f.path.join(f.home, 'logs', 'threadnote.log'));
        expect(log).toContain('"phase":"context.brief.graph"');
        expect(log).toContain('"outcome":"timed-out"');
        expect(log).toContain('ReadDeadlineExceeded');
        expect(log).not.toContain(f.repo);
        expect(log).not.toContain(plan.task);
      }).pipe(
        Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      ),
    {timeout: 10000},
  );

  effectIt.effect(
    'a real worker that prints progress and then stalls inside a large response reports inspection expiry',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const system = yield* SystemInfo;
        const script = f.path.join(f.root, 'progress-then-stall.ts');
        yield* f.fs.writeFileString(
          script,
          `process.stdout.write(${JSON.stringify(`${CONTEXT_BRIEF_NATIVE_READ_STATUS_PROGRESS}\n`)}); process.stdout.write('{"protocol":1,"value":"' + 'x'.repeat(1024 * 1024)); setTimeout(() => undefined, 10000);`,
        );
        const native = yield* withNativeContextBriefReadSources(f.config, sources).pipe(
          Effect.provideService(SystemInfo, {...system, developmentEntrypoint: script}),
        );
        const brief = yield* compileContextBriefWith(native, {
          mode: 'locate',
          responseFormat: 'dual',
          scope: {kind: 'repository', callerCwd: f.repo},
          task: 'answer',
        });
        expect(brief.structuredContent.coverage.gaps).toContain('graph-read-budget-exhausted');
        expect(brief.structuredContent.coverage.gaps).not.toContain('graph-status-deadline-exceeded');
      }).pipe(
        Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      ),
    {timeout: 10000},
  );

  effectIt.effect('a worker timeout reports the status gap unless it printed the exact progress line', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const command = yield* CommandExecutor;
      const progress = CONTEXT_BRIEF_NATIVE_READ_STATUS_PROGRESS;
      const gapsFor = (lines: readonly string[]) =>
        Effect.gen(function* () {
          const native = yield* withNativeContextBriefReadSources(f.config, sources).pipe(
            Effect.provideService(CommandExecutor, {
              ...command,
              execute: (_executable, _args, options) =>
                requestInput(options).pipe(
                  Effect.andThen(() => {
                    for (const line of lines) options?.onStdoutLine?.(line);
                    return Effect.fail(
                      CommandTimedOut.make({args: [], executable: '<test>', message: 'worker timed out', timeoutMs: 1}),
                    );
                  }),
                ),
            }),
          );
          const brief = yield* compileContextBriefWith(native, {
            mode: 'locate',
            responseFormat: 'dual',
            scope: {kind: 'repository', callerCwd: f.repo},
            task: 'answer',
          });
          return brief.structuredContent.coverage.gaps;
        });
      expect(yield* gapsFor([progress])).toContain('graph-read-budget-exhausted');
      for (const lines of [[], [''], ['{"protocol":1}'], [`${progress} `]]) {
        const gaps = yield* gapsFor(lines);
        expect(gaps).toContain('graph-status-deadline-exceeded');
        expect(gaps).not.toContain('graph-read-budget-exhausted');
      }
    }).pipe(Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}), provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('Windows retains scoped preview only with a bound joined deadline response', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const command = yield* CommandExecutor;
      const system = yield* SystemInfo;
      const value: ContextBriefGraphEvidenceV1 = {
        cards: [
          {
            id: 'node',
            rank: 0,
            reason: 'Lexical match',
            ref: 'node',
            repositoryKey: 'fixture',
            symbol: {
              kind: 'function',
              language: 'TypeScript',
              line: 1,
              name: 'answer',
              path: 'src/module.ts',
              qualifiedName: 'answer',
            },
          },
        ],
        contracts: [],
        coverage: {
          complete: false,
          consideredRepositories: 1,
          readyRepositories: 1,
          requestedRepositories: 1,
          states: {stale: 1},
        },
        gaps: ['graph-scoped-applicability-unverified'],
        projectCoverage: {
          project: 'fixture',
          kind: 'project',
          configuredRoots: ['src'],
          completeness: 'partial',
          negativeProof: 'unavailable',
          rootComponents: 1,
          dependencyComponents: 0,
          observedWorktreeCommit: 'commit',
          reusedEquivalentSnapshot: false,
        },
        resolvedSnapshots: [
          {
            commit: 'commit',
            dirty: false,
            freshness: 'stale',
            repositoryId: 'repo',
            repositoryKey: 'fixture',
            snapshotId: 'snapshot',
          },
        ],
        trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
        warnings: [],
      };
      const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(contextBriefNativeReadRequestSchema));
      const run = (outcome: 'watchdog' | 'joined' | 'cleanup-unconfirmed') =>
        Effect.gen(function* () {
          const native = yield* withNativeContextBriefReadSources(f.config, sources).pipe(
            Effect.provideService(SystemInfo, {...system, platform: 'win32'}),
            Effect.provideService(CommandExecutor, {
              ...command,
              execute: (_executable, _args, options) =>
                Effect.gen(function* () {
                  expect(options?.verifyOwnedProcessExit).toBe('leader');
                  const request = yield* decode(new TextDecoder().decode(yield* requestInput(options))).pipe(
                    Effect.orDie,
                  );
                  const progress = new TextDecoder().decode(encodeContextBriefScopedReadyProgress(request, value));
                  for (const line of EffectString.split('\n')(EffectString.trimEnd(progress)))
                    options?.onStdoutLine?.(line);
                  const error = {args: [], executable: '<test>', message: 'worker deadline'};
                  if (outcome === 'watchdog') return yield* CommandTimedOut.make({...error, timeoutMs: 1});
                  if (outcome === 'cleanup-unconfirmed') return yield* CommandCleanupUnconfirmed.make(error);
                  const final = JSON.stringify({
                    protocol: 1,
                    operation: 'graph',
                    binding: contextBriefNativeReadBinding(request),
                    commandsJoined: true,
                    ok: false,
                    failure: 'budget-exhausted',
                  });
                  options?.onStdoutLine?.(final);
                  return {exitCode: 0, stdout: progress + final + '\n', stderr: ''};
                }),
            }),
          );
          const plan = planContextBrief({
            scope: {kind: 'repository', callerCwd: f.repo},
            mode: 'locate',
            task: 'answer',
          });
          return yield* native
            .graphEvidence(plan.graph, {
              deadline: yield* makeReadDeadline(5000),
              remaining: 2,
              primaryRemaining: 17,
            })
            .pipe(Effect.result);
        });
      expect(yield* run('watchdog')).toMatchObject({_tag: 'Failure', failure: {_tag: 'ReadDeadlineExceeded'}});
      expect(yield* run('cleanup-unconfirmed')).toMatchObject({
        _tag: 'Failure',
        failure: {reason: 'cleanup-unconfirmed'},
      });
      expect(yield* run('joined')).toMatchObject({_tag: 'Success', success: value});
    }).pipe(Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}), provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'an actual status Git child inherits the owned group and is gone after request cancellation',
    () =>
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        if (system.platform === 'win32') return;
        const f = yield* fixture;
        const shim = f.path.join(f.root, 'bin');
        const pidFile = f.path.join(f.root, 'git.pid');
        yield* f.fs.makeDirectory(shim);
        const gitFile = f.path.join(shim, 'git');
        yield* f.fs.writeFileString(
          gitFile,
          `#!${system.executablePath}\nimport {renameSync,writeFileSync} from 'node:fs'; import {Database} from 'bun:sqlite'; const pidFile=${JSON.stringify(pidFile)}; writeFileSync(pidFile+'.tmp',String(process.pid)); renameSync(pidFile+'.tmp',pidFile); const db=new Database(':memory:'); db.query('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n').get();\n`,
        );
        yield* f.fs.chmod(gitFile, 0o700);
        const native = yield* withNativeContextBriefReadSources(f.config, sources).pipe(
          Effect.provideService(SystemInfo, {
            ...system,
            environment: () => ({...system.environment(), PATH: `${shim}:${system.environment().PATH ?? ''}`}),
          }),
        );
        const plan = planContextBrief({scope: {kind: 'repository', callerCwd: f.repo}, mode: 'locate', task: 'answer'});
        // The deadline is a watchdog; cancellation is triggered only by the real child's acknowledgement.
        yield* Effect.acquireUseRelease(
          native
            .graphEvidence(plan.graph, {remaining: 2, primaryRemaining: 17, deadline: yield* makeReadDeadline(8000)})
            .pipe(Effect.interruptible, Effect.forkChild),
          worker =>
            Effect.gen(function* () {
              yield* Effect.gen(function* () {
                while (!(yield* f.fs.exists(pidFile))) yield* Effect.sleep('10 millis');
              }).pipe(Effect.timeout('5 seconds'));
              const pid = Number(yield* f.fs.readFileString(pidFile));
              expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
              expect(system.isProcessRunning(pid)).toBe(true);
              const start = yield* Clock.monotonicTimeNanos;
              yield* Fiber.interrupt(worker);
              expect(system.isProcessRunning(pid)).toBe(false);
              expect(Number((yield* Clock.monotonicTimeNanos) - start) / 1_000_000).toBeLessThan(2200);
            }),
          worker =>
            Effect.gen(function* () {
              yield* Fiber.interrupt(worker);
              if (yield* f.fs.exists(pidFile)) {
                const pid = Number(yield* f.fs.readFileString(pidFile));
                expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
                expect(system.isProcessRunning(pid)).toBe(false);
              }
            }).pipe(Effect.orDie),
        );
      }).pipe(
        Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      ),
    {timeout: 10000},
  );

  effectIt.effect('gives concurrent reads separate single-use workers and stops the unused spare at scope close', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const command = yield* CommandExecutor;
      const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(contextBriefNativeReadRequestSchema));
      const workers: {started: boolean; served: number; stopped: boolean}[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const native = yield* withNativeContextBriefReadSources(f.config, sources).pipe(
            Effect.provideService(CommandExecutor, {
              ...command,
              execute: (_executable, _args, options) => {
                const worker = {started: false, served: 0, stopped: false};
                workers.push(worker);
                return Effect.gen(function* () {
                  worker.started = true;
                  const request = yield* decode(new TextDecoder().decode(yield* requestInput(options))).pipe(
                    Effect.orDie,
                  );
                  worker.served += 1;
                  const reply = {
                    protocol: 1,
                    operation: 'graph',
                    binding: contextBriefNativeReadBinding(request),
                    commandsJoined: true,
                    ok: false,
                    failure: 'worker-failed',
                  };
                  return {exitCode: 0, stdout: JSON.stringify(reply) + '\n', stderr: ''};
                }).pipe(Effect.onInterrupt(() => Effect.sync(() => (worker.stopped = true))));
              },
            }),
          );
          const plan = planContextBrief({
            scope: {kind: 'repository', callerCwd: f.repo},
            mode: 'locate',
            task: 'answer',
          });
          const deadline = yield* makeReadDeadline(5000);
          // Separate budgets: a graph read reserves its own budget's counters.
          const read = Effect.suspend(() =>
            native.graphEvidence(plan.graph, {remaining: 2, primaryRemaining: 17, deadline}).pipe(Effect.flip),
          );
          const failures = yield* Effect.all([read, read], {concurrency: 2});
          for (const failure of failures)
            expect(failure, JSON.stringify(failure)).toMatchObject({
              _tag: 'ContextBriefNativeReadFailed',
              reason: 'worker-failed',
            });
        }),
      );
      // Each request had its own process. One spare never served; the scope stopped it if it had started at all.
      expect(EffectArray.map(workers, worker => worker.served).sort()).toEqual([0, 1, 1]);
      expect(EffectArray.every(workers, worker => worker.served === 1 || !worker.started || worker.stopped)).toBe(true);
    }).pipe(Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}), provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('a prestarted executor loads its worker before the brief and serves the first read', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const command = yield* CommandExecutor;
      const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(contextBriefNativeReadRequestSchema));
      const workers: {served: number}[] = [];
      const fake = {
        ...command,
        execute: (_executable: string, _args: readonly string[], options?: CommandOptions) => {
          const worker = {served: 0};
          workers.push(worker);
          return Effect.gen(function* () {
            const request = yield* decode(new TextDecoder().decode(yield* requestInput(options))).pipe(Effect.orDie);
            worker.served += 1;
            const reply = {
              protocol: 1,
              operation: 'graph',
              binding: contextBriefNativeReadBinding(request),
              commandsJoined: true,
              ok: false,
              failure: 'worker-failed',
            };
            return {exitCode: 0, stdout: JSON.stringify(reply) + '\n', stderr: ''};
          });
        },
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const shared = yield* prestartContextBriefNativeReadWorkers(f.config.agentContextHome).pipe(
            Effect.provideService(CommandExecutor, fake),
          );
          // Started before any brief exists: the worker loads while the caller does other work.
          expect(workers).toEqual([{served: 0}]);
          const native = yield* withNativeContextBriefReadSources(f.config, sources).pipe(
            Effect.provideService(ContextBriefNativeReadWorkers, shared!),
          );
          const plan = planContextBrief({
            scope: {kind: 'repository', callerCwd: f.repo},
            mode: 'locate',
            task: 'answer',
          });
          yield* native
            .graphEvidence(plan.graph, {remaining: 2, primaryRemaining: 17, deadline: yield* makeReadDeadline(5000)})
            .pipe(Effect.flip);
        }),
      );
      // The first read used the prestarted worker and started one new spare.
      expect(workers).toEqual([{served: 1}, {served: 0}]);
    }).pipe(Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}), provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('an unexpected Windows worker failure explicitly refuses to claim descendant cleanup', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const system = yield* SystemInfo;
      const command = yield* CommandExecutor;
      const native = yield* withNativeContextBriefReadSources(f.config, sources).pipe(
        Effect.provideService(SystemInfo, {...system, platform: 'win32'}),
        Effect.provideService(CommandExecutor, {
          ...command,
          execute: () =>
            Effect.fail(
              CommandSpawnFailed.make({args: [], executable: '<test>', message: 'worker exited', cause: undefined}),
            ),
        }),
      );
      const plan = planContextBrief({scope: {kind: 'repository', callerCwd: f.repo}, mode: 'locate', task: 'answer'});
      const result = yield* native
        .graphEvidence(plan.graph, {remaining: 2, primaryRemaining: 17, deadline: yield* makeReadDeadline(5000)})
        .pipe(Effect.result);
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure')
        expect(Schema.is(ContextBriefNativeReadFailed)(result.failure) && result.failure.reason).toBe(
          'cleanup-unconfirmed',
        );
    }).pipe(Effect.provideService(ReadyRecallReadWorkerAdmission, {enabled: true}), provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'keeps nested Git in its owned group, limits existing unbounded commands, and refuses fsmonitor daemons',
    () =>
      Effect.gen(function* () {
        const seen: Array<{args: readonly string[]; options?: import('@threadnote/platform/command').CommandOptions}> =
          [];
        const inner = CommandExecutor.of({
          execute: (_executable, args, options) => {
            seen.push({args, options});
            return Effect.succeed({stdout: '', stderr: '', exitCode: 0});
          },
          executeStreaming: () => Effect.die('unused'),
        });
        const owned = nativeContextReadCommands(inner, yield* makeReadDeadline(3000));
        yield* owned.execute('git', ['-c', 'core.fsmonitor=true', 'status'], {detached: true, timeoutMs: 0});
        expect(seen[0]?.options).toMatchObject({
          detached: false,
          forceKillAfterMilliseconds: 0,
          sensitiveOutput: true,
          verifyOwnedProcessExit: 'leader',
        });
        expect(seen[0]?.options?.timeoutMs).toBeLessThanOrEqual(3000);
        expect(seen[0]?.options?.timeoutMs).toBeGreaterThan(0);
        expect(seen[0]?.args).not.toContain('core.fsmonitor=true');
        expect((yield* owned.execute('git', ['fsmonitor--daemon', 'start']).pipe(Effect.result))._tag).toBe('Failure');
        expect(seen).toHaveLength(1);
        expect(yield* owned.spawnDetached!('git', ['status'])).toBe(false);
      }),
  );
});
