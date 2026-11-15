import {Effect, Array as EffectArray, String as EffectString} from 'effect';
import * as Clock from 'effect/Clock';
import {initializeNativeWatch, attachNativeWatchConsumer} from '@threadnote/workflow-automations/watch';
import {decodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import {writeNativeWatch, withNativeWatchControlLock} from '../../src/workflow_automation/watch_store.js';
import {it as effectIt} from '@effect/vitest';
import {describe, expect} from 'vitest';
import {CommandExecutor} from '@threadnote/platform/command';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerWorkflowTaskTool} from '../../src/mcp/server/workflow.js';
import {runNativeTaskAction} from '../../src/workflow_automation/task_actions.js';
import {readNativeTaskView} from '../../src/workflow_automation/task.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {fixture, object, run, windowsCycleFixtureTimeout} from './native-cycle-lifecycle-fixture.js';

const completed = Effect.gen(function* () {
  const f = yield* fixture(['one'], 'local');
  yield* f.git(['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  yield* f.mutate('begin-phase', {phaseId: 'one'});
  yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "publication";\n');
  yield* f.git(['add', 'source.ts']);
  yield* f.git(['commit', '-m', 'Prepared local source']);
  const captured = object(
    yield* f.mutate('snapshot', {
      phaseId: 'one',
      snapshotId: 'publication-source',
      acceptedHead: EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout),
      reason: 'Record the prepared clean descendant source commit.',
    }),
  );
  const snapshot = object(object(captured.snapshot).snapshot);
  yield* f.mutate('validate-review', {
    snapshotId: snapshot.snapshotId,
    attemptId: 'publication-review',
    report: {
      snapshotId: snapshot.snapshotId,
      phaseHash: snapshot.phaseHash,
      snapshotTree: snapshot.tree,
      status: 'complete',
      mode: 'full',
      selected: ['correctness', 'simplicity'],
      lanes: [
        {name: 'correctness', status: 'complete'},
        {name: 'simplicity', status: 'complete'},
      ],
      findings: [],
    },
  });
  yield* f.mutate('ready', {
    phaseId: 'one',
    snapshotId: snapshot.snapshotId,
    validation: {
      snapshotTree: snapshot.tree,
      reviewTree: snapshot.tree,
      status: 'passed',
      productState: 'working',
      checks: [{command: 'private source smoke', result: 'passed', evidence: 'Exact source exercised.'}],
      acceptance: [{criterion: 'one works', result: 'passed', evidence: 'Exact local proof.'}],
    },
  });
  yield* f.mutate('record-delivery', {
    phaseId: 'one',
    delivery: {
      phaseId: 'one',
      phaseHash: snapshot.phaseHash,
      delivery: 'local',
      headSha: snapshot.head,
      validatedTree: snapshot.tree,
    },
  });
  const view = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo});
  const pr = {
    url: 'https://github.com/example/repo/pull/1',
    headSha: String(snapshot.head),
    branch: 'feature/one',
    baseBranch: 'main',
    state: 'open' as const,
  };
  return {f, view, pr};
});

describe('completed-local supplemental publication', () => {
  effectIt.effect(
    'attaches through the typed MCP surface, replays exact requests and appends actual merge proof while preserving original evidence',
    () =>
      Effect.gen(function* () {
        const {f, view, pr} = yield* completed;
        const before = yield* readNativeWorkflowState(f.config, 'native-run');
        if (!before?.state.cycle) throw new Error('Expected completed cycle.');
        const commands = yield* CommandExecutor;
        let merged = false;
        let providerHead = pr.headSha;
        let providerBase = pr.baseBranch;
        let providerCalls = 0;
        const provider = CommandExecutor.of({
          ...commands,
          execute: (executable, args, options) => {
            if (executable !== 'gh') return commands.execute(executable, args, options);
            expect(args.slice(0, 6)).toEqual([
              'api',
              '--hostname',
              'github.com',
              '--method',
              'GET',
              'repos/example/repo/pulls/1',
            ]);
            providerCalls++;
            return Effect.succeed({
              exitCode: 0,
              stderr: '',
              stdout: JSON.stringify({
                number: 1,
                url: pr.url,
                baseRepository: 'example/repo',
                baseBranch: providerBase,
                headBranch: pr.branch,
                headSha: providerHead,
                state: merged ? 'closed' : 'open',
                merged,
                mergeCommit: merged ? EffectString.repeat(40)('a') : null,
              }),
            });
          },
        });
        const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
        registerWorkflowTaskTool(mcp, f.config);
        const delivery = {
          command: 'supplemental',
          taskRef: view.taskRef,
          phaseId: 'one',
          pr,
          userAuthority: 'Attach this existing authorized PR to this completed local phase.',
        };
        const attach = () =>
          mcp
            .invokeTool('workflow_task_deliver', {runId: 'native-run', callerCwd: f.repo, delivery})
            .pipe(Effect.provideService(CommandExecutor, provider));
        const attached = object(object(yield* attach()).structuredContent);
        expect(attached).toMatchObject({
          status: 'supplemental-publication-updated',
          replayed: false,
          completed: false,
          records: 1,
        });
        const bytes = yield* f.fs.readFileString(f.statePath());
        expect(object(object(yield* attach()).structuredContent)).toMatchObject({
          replayed: true,
          supplementalRef: attached.supplementalRef,
        });
        expect(yield* f.fs.readFileString(f.statePath())).toBe(bytes);
        const after = yield* readNativeWorkflowState(f.config, 'native-run');
        expect({...after!.state, cycle: before.state.cycle}).toEqual(before.state);
        expect({...after!.state.cycle, state: before.state.cycle.state}).toEqual(before.state.cycle);
        const {version: _version, supplementalPublications: _publications, ...original} = after!.state.cycle!.state;
        const {version: _oldVersion, ...oldState} = before.state.cycle.state;
        expect(original).toEqual(oldState);
        merged = true;
        expect(object(object(yield* attach()).structuredContent)).toMatchObject({
          replayed: true,
          records: 1,
          supplementalRef: attached.supplementalRef,
        });
        expect(yield* f.fs.readFileString(f.statePath())).toBe(bytes);
        const complete = () =>
          runNativeTaskAction(f.config, {
            command: 'watch-pr',
            runId: 'native-run',
            callerCwd: f.repo,
            operation: 'complete',
            supplementalRef: attached.supplementalRef,
          }).pipe(Effect.provideService(CommandExecutor, provider));
        const done = object(yield* complete());
        expect(done).toMatchObject({completed: true, records: 3, replayed: false});
        expect(object(yield* complete())).toMatchObject({
          completed: true,
          replayed: true,
          supplementalRef: done.supplementalRef,
        });
        const final = yield* readNativeWorkflowState(f.config, 'native-run');
        expect(
          EffectArray.map(final!.state.cycle!.state.supplementalPublications![0].records, record => record.event.kind),
        ).toEqual(['provider-verified', 'merged', 'completed']);
        expect(final!.state.cycle!.state.phases).toEqual(before.state.cycle.state.phases);
        expect((yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: f.repo})).status).toBe('complete');
        const finalBytes = yield* f.fs.readFileString(f.statePath());
        expect(object(object(yield* attach()).structuredContent)).toMatchObject({
          replayed: true,
          completed: true,
          records: 3,
          publicationId: attached.publicationId,
          supplementalRef: done.supplementalRef,
        });
        const replay = (overrides: object = {}) =>
          runNativeTaskAction(f.config, {
            ...delivery,
            command: 'supplemental-publication',
            operation: 'attach',
            runId: 'native-run',
            callerCwd: f.repo,
            ...overrides,
          }).pipe(Effect.provideService(CommandExecutor, provider), Effect.result);
        expect(yield* replay({pr: {...pr, baseBranch: 'different'}})).toMatchObject({
          failure: {code: 'supplemental-replay-conflict'},
        });
        providerHead = EffectString.repeat(40)('f');
        expect(yield* replay()).toMatchObject({failure: {code: 'watch-binding-drift'}});
        providerHead = pr.headSha;
        providerBase = 'different';
        expect(yield* replay()).toMatchObject({failure: {code: 'watch-binding-drift'}});
        providerBase = pr.baseBranch;
        merged = false;
        expect(yield* replay()).toMatchObject({failure: {code: 'supplemental-lifecycle-drift'}});
        merged = true;
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'dirty after merge');
        expect(yield* replay()).toMatchObject({failure: {code: 'supplemental-source-drift'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(finalBytes);
        expect(providerCalls).toBe(9);
      }).pipe(run),
    windowsCycleFixtureTimeout ?? {timeout: 60000},
  );

  effectIt.effect(
    'refuses missing authority, foreign refs, wrong provider head, dirty source and concurrent run CAS without mutation',
    () =>
      Effect.gen(function* () {
        const {f, view, pr} = yield* completed;
        const original = yield* f.fs.readFileString(f.statePath());
        const commands = yield* CommandExecutor;
        let wrongHead = true;
        let casConflict = false;
        const provider = CommandExecutor.of({
          ...commands,
          execute: (executable, args, options) => {
            if (executable !== 'gh') return commands.execute(executable, args, options);
            return Effect.gen(function* () {
              if (casConflict) yield* f.fs.writeFileString(f.statePath(), original + ' ').pipe(Effect.orDie);
              return {
                exitCode: 0,
                stderr: '',
                stdout: JSON.stringify({
                  number: 1,
                  url: pr.url,
                  baseRepository: 'example/repo',
                  baseBranch: 'main',
                  headBranch: pr.branch,
                  headSha: wrongHead ? EffectString.repeat(40)('f') : pr.headSha,
                  state: 'open',
                  merged: false,
                }),
              };
            });
          },
        });
        const request = {
          command: 'supplemental-publication',
          operation: 'attach',
          runId: 'native-run',
          callerCwd: f.repo,
          taskRef: view.taskRef,
          phaseId: 'one',
          pr,
          userAuthority: 'Attach the existing authorized PR.',
        };
        const act = (overrides: object = {}) =>
          runNativeTaskAction(f.config, {...request, ...overrides}).pipe(
            Effect.provideService(CommandExecutor, provider),
            Effect.result,
          );
        expect(yield* act({userAuthority: ' '})).toMatchObject({failure: {code: 'invalid-supplemental-authority'}});
        expect(yield* act({taskRef: 'foreign'})).toMatchObject({failure: {code: 'invalid-supplemental-authority'}});
        expect(yield* act()).toMatchObject({failure: {code: 'watch-binding-drift'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(original);
        wrongHead = false;
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'dirty');
        expect(yield* act()).toMatchObject({failure: {code: 'supplemental-source-drift'}});
        yield* f.git(['restore', 'source.ts']);
        expect(yield* f.fs.readFileString(f.statePath())).toBe(original);
        casConflict = true;
        expect(yield* act()).toMatchObject({failure: {code: 'state-conflict'}});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(original + ' ');
      }).pipe(run),
    windowsCycleFixtureTimeout ?? {timeout: 60000},
  );
  effectIt.effect(
    'records a distinct active watch, later appends merge observation, and retains historical inspection after source drift',
    () =>
      Effect.gen(function* () {
        const {f, view, pr} = yield* completed;
        const commands = yield* CommandExecutor;
        let merged = false;
        const provider = CommandExecutor.of({
          ...commands,
          execute: (executable, args, options) =>
            executable !== 'gh'
              ? commands.execute(executable, args, options)
              : Effect.succeed({
                  exitCode: 0,
                  stderr: '',
                  stdout: JSON.stringify({
                    number: 1,
                    url: pr.url,
                    baseRepository: 'example/repo',
                    baseBranch: 'main',
                    headBranch: pr.branch,
                    headSha: pr.headSha,
                    state: merged ? 'closed' : 'open',
                    merged,
                    mergeCommit: merged ? EffectString.repeat(40)('a') : null,
                  }),
                }),
        });
        const act = (request: object) =>
          runNativeTaskAction(f.config, {runId: 'native-run', callerCwd: f.repo, ...request}).pipe(
            Effect.provideService(CommandExecutor, provider),
          );
        const attached = object(
          yield* act({
            command: 'supplemental-publication',
            operation: 'attach',
            taskRef: view.taskRef,
            phaseId: 'one',
            pr,
            userAuthority: 'Attach this authorized existing PR.',
          }),
        );
        const current = yield* readNativeWorkflowState(f.config, 'native-run');
        const publication = current!.state.cycle!.state.supplementalPublications![0];
        const identity = EffectString.slice(0, 48)(sha256HexSync(`native-run\n${publication.publicationId}`));
        const watchId = `sup-${identity}`,
          consumerId = `sup-task-${identity}`;
        const now = yield* Clock.currentTimeMillis;
        const token = '12345678-1234-4123-8123-123456789012';
        const initialized = attachNativeWatchConsumer(
          initializeNativeWatch(watchId, pr.url, now),
          {id: consumerId, wakeupId: consumerId},
          now,
        );
        const event = {
          sequence: 1,
          id: watchId + ':1',
          source: 'comments' as const,
          kind: 'comment' as const,
          key: 'comment',
          version: EffectString.repeat(64)('e'),
          url: pr.url,
          at: now,
          removed: false,
        };
        const envelope = {
          format: 'threadnote-native-watch-runtime' as const,
          version: 1 as const,
          state: {
            ...initialized,
            head: pr.headSha,
            nextSequence: 2,
            events: [event],
            sources: EffectArray.map(['comments', 'reviews', 'threads', 'checks', 'statuses'] as const, source => ({
              source,
              items: [],
              lastCompleteAt: now,
            })),
          },
          owner: {
            kind: 'supplemental-publication' as const,
            runId: 'native-run',
            generationHash: sha256HexSync(current!.state.generation),
            publicationId: publication.publicationId,
            head: pr.headSha,
            tree: publication.initialization.tree,
            phaseId: 'one',
            prUrl: pr.url,
          },
          provider: {pages: []},
          collector: {
            token,
            pid: 404040,
            startedAt: now,
            lastSeenAt: now,
            nextPollAt: now,
            status: 'running' as const,
            consecutiveErrors: 0,
          },
          stopRequested: false,
          notification: {
            consumerId,
            wakeupId: consumerId,
            target: {host: 'codex' as const, executable: '/tmp/codex', threadId: token},
            notifiedThrough: 0,
            lastConsumerAt: now,
            outbox: {
              key: watchId + ':1:1',
              first: 1,
              last: 1,
              createdAt: now,
              attempts: 1,
              nextAttemptAt: now,
              attemptId: token,
              collectorToken: token,
              status: 'queued' as const,
              receipt: token,
              consumedThrough: 0,
            },
          },
          metrics: {
            requests: 0,
            notModified: 0,
            responseBytes: 0,
            graphqlCost: 0,
            providerMilliseconds: 0,
            sweeps: 0,
            consumerReads: 0,
          },
        };
        yield* withNativeWatchControlLock(f.config, watchId, writeNativeWatch(f.config, envelope, null));
        const done = object(
          yield* act({command: 'watch-pr', operation: 'complete', supplementalRef: attached.supplementalRef}),
        );
        expect(done).toMatchObject({completed: true, records: 3});
        expect(decodeNativeTaskActionRef(String(done.supplementalRef))?.kind).toBe('supplemental-publication');
        merged = true;
        expect(
          yield* act({command: 'watch-pr', operation: 'complete', supplementalRef: done.supplementalRef}),
        ).toMatchObject({completed: true, records: 4});
        const final = yield* readNativeWorkflowState(f.config, 'native-run');
        expect(
          EffectArray.map(final!.state.cycle!.state.supplementalPublications![0].records, record => record.event.kind),
        ).toEqual(['provider-verified', 'watch', 'completed', 'merged']);
        const nativeBytes = yield* f.fs.readFileString(f.statePath());
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'drift');
        const inspected = object(
          yield* act({command: 'watch-pr', operation: 'inspect', supplementalRef: attached.supplementalRef}),
        );
        expect(inspected).toMatchObject({watchId, noticeRef: expect.any(String)});
        expect(yield* f.fs.readFileString(f.statePath())).toBe(nativeBytes);
      }).pipe(run),
    windowsCycleFixtureTimeout ?? {timeout: 60000},
  );
});
