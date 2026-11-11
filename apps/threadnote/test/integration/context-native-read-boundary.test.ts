import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, Fiber, FileSystem, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {planContextBrief} from '@threadnote/context/planner';
import {projectContextBrief} from '@threadnote/context/projector';
import {CommandExecutor, CommandSpawnFailed, runCommandEffect} from '@threadnote/platform/command';
import {makeReadDeadline, ReadDeadlineExceeded} from '@threadnote/platform/read_deadline';
import {SystemInfo} from '@threadnote/platform/system';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {ReadyRecallReadWorkerAdmission} from '../../src/recall/ready_read_boundary.js';
import {
  contextBriefNativeReadBinding,
  ContextBriefNativeReadFailed,
  withNativeContextBriefReadSources,
  type ContextBriefNativeReadRequest,
} from '../../src/context_brief/native_read_boundary.js';
import {nativeContextReadCommands} from '../../src/context_brief/native_read_worker.js';
import type {ContextBriefRuntimeCompilerSources} from '../../src/context_brief/index.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {withProductionLogging, withProductionPhaseTiming} from '../../src/effect/production_log.js';

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
  const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-native-context-'});
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
        const budget = {remaining: 2, primaryRemaining: 17, deadline: yield* makeReadDeadline(5000)};
        const graph = yield* native.graphEvidence(plan.graph, budget);
        expect(graph.cards.length).toBeGreaterThan(0);
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
        const verified = yield* native.citationValidation(
          plan.scope,
          [candidate],
          graph.citationValidationFence,
          yield* makeReadDeadline(5000),
        );
        expect(verified[0]?.receipts[0]?.status).toBe('exact');
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
        const deadline = yield* makeReadDeadline(1600);
        const start = yield* Clock.monotonicTimeNanos;
        const result = yield* withProductionLogging(
          f.home,
          {component: 'cli', operation: 'context.brief'},
          withProductionPhaseTiming(
            'context.brief.graph',
            native.graphEvidence(plan.graph, {remaining: 2, primaryRemaining: 17, deadline}),
          ),
        ).pipe(Effect.result);
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') expect(Schema.is(ReadDeadlineExceeded)(result.failure)).toBe(true);
        expect(Number((yield* Clock.monotonicTimeNanos) - start) / 1_000_000).toBeLessThan(1600);
        const second = yield* native.citationValidation(plan.scope, [], undefined, deadline).pipe(Effect.result);
        expect(second._tag).toBe('Failure');
        expect(invocations).toBe(1);
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
          `#!${system.executablePath}\nimport {writeFileSync} from 'node:fs'; import {Database} from 'bun:sqlite'; writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); const db=new Database(':memory:'); db.query('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n').get();\n`,
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
