import {runNativePrWatchOperation} from '../../src/workflow_automation/task_pr_watch.js';
import {it as effectIt} from '@effect/vitest';
import {expect} from 'vitest';
import {Clock, Effect, FileSystem, Deferred, Fiber, Array as EffectArray, String as EffectString} from 'effect';
import {CommandExecutor, CommandTimedOut, runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {decodeNativeTaskActionRef, encodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import {recordNativeWatchLifecycle, nativeWatchEventLimit} from '@threadnote/workflow-automations/watch';
import {runNativeTaskCandidateWatch} from '../../src/workflow_automation/task_candidate_watch.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {
  readNativeWatch,
  writeNativeWatch,
  withNativeWatchControlLock,
  readNativeCandidateWatchInventory,
  bindNativeCandidateWatchBase,
  verifyNativeCandidateWatchOwner,
} from '../../src/workflow_automation/watch_store.js';
import {runNativeWatch, runNativeWatchCollector} from '../../src/workflow_automation/watch.js';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import {runNativeTaskAction} from '../../src/workflow_automation/task_actions.js';
import {readNativeTaskView} from '../../src/workflow_automation/task.js';
import {
  makeNativeWatchNotifier,
  nativeWatchCodexCandidatePaths,
} from '../../src/workflow_automation/watch_notification.js';
import {fixture, object, run} from './native-cycle-lifecycle-fixture.js';

const pr = 'https://github.com/example/project/pull/7';
const threadId = '11111111-1111-4111-8111-111111111111';
const receipt = '33333333-3333-4333-8333-333333333333';
const required = <A>(value: A | undefined | null): A => {
  if (value === undefined || value === null) throw new Error('Missing candidate fixture value.');
  return value;
};
const encoded = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Missing opaque candidate reference.');
  return value;
};

effectIt.effect(
  'keeps exact candidate ownership, maps opaque notices/events, gates ACK, and invalidates a sweep without losing pending evidence',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        ['one'],
        'pr',
        false,
        false,
        true,
        {one: {branch: 'feature/one', baseBranch: 'origin/main'}},
        repo =>
          Effect.gen(function* () {
            yield* runCommandEffect('git', [
              '-C',
              repo,
              'remote',
              'add',
              'origin',
              'https://github.com/example/project.git',
            ]);
            yield* runCommandEffect('git', ['-C', repo, 'update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);
          }),
      );
      yield* f.mutate('begin-phase', {phaseId: 'one'});
      yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "candidate";\n');
      yield* f.git(['add', 'source.ts']);
      yield* f.git(['commit', '-m', 'Candidate source']);
      yield* f.mutate('snapshot', {
        phaseId: 'one',
        snapshotId: 'candidate-source',
        acceptedHead: EffectString.trim((yield* f.git(['rev-parse', 'HEAD'])).stdout),
        reason: 'Inspect the clean committed descendant of the admitted phase baseline.',
      });
      const stored = required(yield* readNativeWorkflowState(f.config, 'native-run'));
      const runtime = required(stored.state.cycle);
      const snapshot = required(runtime.snapshots.at(-1)).snapshot;
      const baseline = required(runtime.baselines.one);
      const snapshotRef = encodeNativeTaskActionRef({
        version: 1,
        kind: 'snapshot',
        runId: stored.state.runId,
        generationHash: sha256HexSync(stored.state.generation),
        phaseId: 'one',
        phaseHash: snapshot.phaseHash,
        baselineHead: baseline.head,
        baselineTree: baseline.tree,
        baselineRef: baseline.pinnedRef,
        snapshotId: snapshot.snapshotId,
        sourceHead: snapshot.head,
        sourceTree: snapshot.tree,
      });
      const storeContext = yield* Effect.context<Effect.Services<ReturnType<typeof writeNativeWatch>>>();
      const commands = yield* CommandExecutor;
      const system = yield* SystemInfo;
      const fs = yield* FileSystem.FileSystem;
      const knownExecutables = nativeWatchCodexCandidatePaths('darwin', system.homeDirectory);
      let discoveryLookups = 0;
      const discoveringFileSystem = {
        ...fs,
        realPath: (candidate: string) => {
          if (!knownExecutables.includes(candidate)) return fs.realPath(candidate);
          discoveryLookups++;
          return Effect.succeed('/fixture/codex');
        },
      };
      let providerCalls = 0;
      let spawns = 0;
      let providerHead = snapshot.head;
      let providerUnavailable = false;
      let slowProvider = false;
      let emittedNotice: string | undefined;
      const providerEntered = yield* Deferred.make<void>();
      const testCommands = CommandExecutor.of({
        ...commands,
        execute: (executable, args, options) => {
          if (executable === 'git' && args.includes('--show-toplevel'))
            return commands
              .execute(executable, args, options)
              .pipe(Effect.map(result => ({...result, stdout: `${EffectString.trim(result.stdout)}/.\n`})));
          if (executable === '/fixture/codex') {
            if (args.includes('--help'))
              return Effect.succeed({
                exitCode: 0,
                stderr: '',
                stdout: 'Usage: codex queue [OPTIONS]\n  --thread <THREAD>\n  --message <TEXT>\n',
              });
            emittedNotice = required(args[args.indexOf('--message') + 1]);
            return Effect.succeed({
              exitCode: 0,
              stderr: '',
              stdout: `Queued message ${receipt} for thread ${threadId}.`,
            });
          }
          if (executable !== 'gh') return commands.execute(executable, args, options);
          providerCalls++;
          if (providerUnavailable) {
            providerUnavailable = false;
            return Effect.fail(
              CommandTimedOut.make({message: 'Temporary provider timeout', executable, args, timeoutMs: 15000}),
            );
          }
          const delayed = slowProvider;
          slowProvider = false;
          const result = {
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              number: 7,
              url: pr,
              baseRepository: 'example/project',
              baseBranch: 'main',
              headBranch: 'feature/one',
              headSha: providerHead,
              state: 'open',
              merged: false,
              mergeCommit: null,
            }),
          };
          return delayed
            ? Effect.gen(function* () {
                yield* Deferred.succeed(providerEntered, undefined);
                yield* Effect.sleep(2100);
                return result;
              })
            : Effect.succeed(result);
        },
        spawnDetached: (_executable, args) =>
          Effect.gen(function* () {
            spawns++;
            const id = required(args[args.indexOf('--watch-id') + 1]);
            const current = required(yield* readNativeWatch(f.config, id));
            yield* writeNativeWatch(
              f.config,
              {
                ...current.envelope,
                collector: {
                  ...required(current.envelope.collector),
                  pid: 12345,
                  startIdentity: 'candidate-fixture',
                  status: 'running',
                },
              },
              current.revision,
            );
            return true;
          }).pipe(Effect.provideContext(storeContext), Effect.orDie),
      });
      const scopedSystem = {
        ...system,
        platform: 'darwin' as const,
        currentDirectory: () => f.repo,
        processId: 12345,
        isProcessRunning: (pid: number) => pid === 12345,
        processStartIdentity: () => Effect.succeed('candidate-fixture'),
        canonicalProcessStartIdentity: () => Effect.succeed('candidate-fixture'),
      };
      yield* Effect.gen(function* () {
        const invoke = (request: Parameters<typeof runNativeTaskCandidateWatch>[1]) =>
          runNativeTaskCandidateWatch(f.config, request, stored, baseline.repo, runtime);
        const startRequest = {
          command: 'watch-candidate-pr' as const,
          runId: 'native-run',
          operation: 'start' as const,
          snapshotRef,
          pr,
          wakeup: {host: 'codex' as const, threadId},
        };
        const candidateSource = {
          phaseId: 'one',
          phaseHash: snapshot.phaseHash,
          head: snapshot.head,
          tree: snapshot.tree,
        };
        for (const comparisonRef of ['main', 'origin/main', 'refs/remotes/origin/main']) {
          const bound = yield* bindNativeCandidateWatchBase(baseline.repo, comparisonRef, candidateSource, pr);
          expect(bound.baseBranch).toBe('main');
          expect(bound.comparisonResolvedRef).toBe(
            comparisonRef === 'main' ? 'refs/heads/main' : 'refs/remotes/origin/main',
          );
        }
        yield* f.git(['tag', 'origin/main', 'main']);
        expect(
          (yield* bindNativeCandidateWatchBase(baseline.repo, 'origin/main', candidateSource, pr).pipe(Effect.result))
            ._tag,
        ).toBe('Failure');
        yield* f.git(['tag', '--delete', 'origin/main']);
        yield* f.git(['remote', 'set-url', 'origin', 'https://github.com/foreign/project.git']);
        expect(
          (yield* bindNativeCandidateWatchBase(baseline.repo, 'origin/main', candidateSource, pr).pipe(Effect.result))
            ._tag,
        ).toBe('Failure');
        yield* f.git(['remote', 'set-url', 'origin', 'https://github.com/example/project.git']);
        const sourceBytes = yield* f.fs.readFileString(f.path.join(f.repo, 'source.ts'));
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), sourceBytes + '// unadmitted bytes\n');
        expect((yield* invoke(startRequest).pipe(Effect.result))._tag).toBe('Failure');
        expect(discoveryLookups).toBe(0);
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), sourceBytes);
        const started = object(yield* invoke(startRequest));
        expect(discoveryLookups).toBeGreaterThan(0);
        const initialDiscoveryLookups = discoveryLookups;
        const candidateWatchRef = encoded(started.candidateWatchRef);
        const candidate = required(decodeNativeTaskActionRef(candidateWatchRef));
        const watchId = required(candidate.watchId);
        expect(candidate.kind).toBe('candidate-watch');
        expect(started.diagnosticOnly).toBe(true);
        expect(object(yield* invoke(startRequest)).candidateWatchRef).toBe(candidateWatchRef);
        expect(
          (yield* invoke({...startRequest, wakeup: {host: 'codex', threadId: receipt}}).pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(discoveryLookups).toBe(initialDiscoveryLookups);
        expect(spawns).toBe(1);
        expect(
          yield* invoke({
            command: 'watch-candidate-pr',
            runId: 'native-run',
            candidateWatchRef,
            operation: 'inspect',
            wakeup: {host: 'codex', threadId},
          }).pipe(Effect.result),
        ).toMatchObject({failure: {code: 'invalid-request'}});
        expect(discoveryLookups).toBe(initialDiscoveryLookups);
        const active = required(yield* readNativeWatch(f.config, watchId));
        const activeOwner = required(active.envelope.owner);
        const beforeTransient = active.revision;
        providerUnavailable = true;
        expect(
          (yield* invoke({
            command: 'watch-candidate-pr',
            runId: 'native-run',
            candidateWatchRef,
            operation: 'relay',
          }).pipe(Effect.result))._tag,
        ).toBe('Failure');
        const unavailable = required(yield* readNativeWatch(f.config, watchId));
        expect(unavailable.revision).toBe(beforeTransient);
        expect(unavailable.envelope.invalidation).toBeUndefined();
        yield* invoke({command: 'watch-candidate-pr', runId: 'native-run', candidateWatchRef, operation: 'relay'});
        const slowCalls = providerCalls;
        slowProvider = true;
        const slow = yield* invoke({
          command: 'watch-candidate-pr',
          runId: 'native-run',
          candidateWatchRef,
          operation: 'relay',
        }).pipe(Effect.forkChild);
        yield* Deferred.await(providerEntered);
        expect(
          yield* withNativeWatchControlLock(f.config, watchId, Effect.succeed(true)).pipe(Effect.timeout('1 second')),
        ).toBe(true);
        yield* Fiber.join(slow);
        expect(providerCalls - slowCalls).toBe(1);
        expect(activeOwner.kind).toBe('candidate-pr');
        const continuation = {command: 'watch-candidate-pr' as const, runId: 'native-run', candidateWatchRef};
        const foreign = encodeNativeTaskActionRef({...candidate, kind: 'delivery'});
        expect(
          (yield* invoke({...continuation, operation: 'inspect', candidateWatchRef: foreign}).pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(
          (yield* runNativeWatch(f.config, {
            protocolVersion: 1,
            executorVersion: 1,
            action: 'watch',
            command: 'inspect',
            watchId,
          }).pipe(Effect.result))._tag,
        ).toBe('Failure');
        const providerCallsBeforeTransportRefusal = providerCalls;
        const extractedTransport = yield* runNativePrWatchOperation(
          f.config,
          {operation: 'inspect'},
          required(yield* readNativeWatch(f.config, watchId)),
          {runId: stored.state.runId, generationHash: sha256HexSync(stored.state.generation)},
        ).pipe(Effect.result);
        expect(extractedTransport).toMatchObject({failure: {code: 'watch-owner-conflict'}});
        expect(providerCalls).toBe(providerCallsBeforeTransportRefusal);
        let watch = required(yield* readNativeWatch(f.config, watchId));
        const now = yield* Clock.currentTimeMillis;
        const state = recordNativeWatchLifecycle(watch.envelope.state, 'watcher_error', 'diagnostic', now);
        watch = yield* writeNativeWatch(f.config, {...watch.envelope, state}, watch.revision);
        const notifier = yield* makeNativeWatchNotifier(f.config, watchId, required(watch.envelope.collector).token);
        yield* notifier.tick();
        watch = required(yield* readNativeWatch(f.config, watchId));
        const actualNotice = required(emittedNotice);
        const locatorMatch = /Route=(\{.*\})\. Use workflow_task_watch_pr/u.exec(actualNotice);
        const locator = object(JSON.parse(required(locatorMatch?.[1])) as unknown);
        const {noticeRef: arrivingNoticeRef, ...resume} = object(locator.semantic);
        expect(resume.runId).toBe('native-run');
        expect(resume.callerCwd).toBe(baseline.repo);
        const inspectRequest = {...resume, command: 'watch-pr', operation: 'inspect'};
        const inspected = object(yield* runNativeTaskAction(f.config, inspectRequest));
        const noticeRef = encoded(arrivingNoticeRef);
        expect(inspected.noticeRef).toBe(noticeRef);
        const currentView = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: baseline.repo});
        expect(currentView.candidateWatches?.[0]?.candidateWatchRef).toBe(candidateWatchRef);
        const notice = required(decodeNativeTaskActionRef(noticeRef));
        expect(notice.kind).toBe('candidate-notice');
        const wrongAttempt = encodeNativeTaskActionRef({...notice, watchAttemptId: receipt});
        const bytesBefore = watch.revision;
        expect(
          (yield* runNativeTaskAction(f.config, {
            ...resume,
            command: 'watch-pr',
            operation: 'relay',
            noticeRef: wrongAttempt,
          }).pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(required(yield* readNativeWatch(f.config, watchId)).revision).toBe(bytesBefore);
        const relayed = object(
          yield* runNativeTaskAction(f.config, {...resume, command: 'watch-pr', operation: 'relay', noticeRef}),
        );
        const watchDeliveryRef = encoded(relayed.watchDeliveryRef);
        const eventRefs = relayed.eventRefs;
        if (!EffectArray.isArray(eventRefs)) throw new Error('Missing candidate event refs');
        const eventRef = encoded(eventRefs[0]);
        expect(required(decodeNativeTaskActionRef(eventRef)).watchEventId).toBe(state.events[0].id);
        expect(required(decodeNativeTaskActionRef(watchDeliveryRef)).watchDeliveryId).toBe(
          required(required(yield* readNativeWatch(f.config, watchId)).envelope.state.delivery).id,
        );
        expect(
          (yield* invoke({...continuation, operation: 'ack', watchDeliveryRef: noticeRef}).pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect((yield* invoke({...continuation, operation: 'ack', watchDeliveryRef}).pipe(Effect.result))._tag).toBe(
          'Failure',
        );
        yield* runNativeTaskAction(f.config, {
          ...resume,
          command: 'watch-pr',
          operation: 'disposition',
          watchDeliveryRef,
          dispositions: [
            {eventRef, status: 'open', reason: 'Investigate diagnostic', evidence: 'Exact source event retained'},
          ],
        });
        yield* runNativeTaskAction(f.config, {...resume, command: 'watch-pr', operation: 'ack', watchDeliveryRef});
        const work = object(object(object(yield* invoke({...continuation, operation: 'work'})).result).work);
        if (!EffectArray.isArray(work.items)) throw new Error('Missing retained work');
        const workRef = encoded(object(work.items[0]).eventRef);
        expect(required(decodeNativeTaskActionRef(workRef)).kind).toBe('candidate-work');
        const detail = object(
          object(yield* invoke({...continuation, operation: 'work-detail', workEventRef: workRef})).result,
        );
        expect(detail.workDetail).toBeDefined();
        watch = required(yield* readNativeWatch(f.config, watchId));
        const appended = recordNativeWatchLifecycle(
          watch.envelope.state,
          'watcher_error',
          'second-diagnostic',
          now + 1,
        );
        const pending = {
          ...appended,
          nextSequence: appended.acknowledged + nativeWatchEventLimit,
          events: EffectArray.makeBy(nativeWatchEventLimit - 1, index => ({
            ...required(appended.events[0]),
            sequence: appended.acknowledged + index + 1,
            id: `${watchId}:${appended.acknowledged + index + 1}`,
          })),
        };
        watch = yield* writeNativeWatch(
          f.config,
          {...watch.envelope, state: pending, collector: {...required(watch.envelope.collector), nextPollAt: 0}},
          watch.revision,
        );
        const oldOutbox = watch.envelope.notification?.outbox;
        const oldWork = watch.envelope.state.work;
        const oldEvents = watch.envelope.state.events;
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "drift";\n');
        const callsBeforeSweep = providerCalls;
        yield* runNativeWatchCollector(f.config, watchId, required(watch.envelope.collector).token);
        const invalid = required(yield* readNativeWatch(f.config, watchId));
        expect(providerCalls).toBe(callsBeforeSweep);
        expect(invalid.envelope.invalidation?.kind).toBe('candidate_invalidated');
        expect(invalid.envelope.collector?.status).toBe('stopped');
        expect(invalid.envelope.stopRequested).toBe(true);
        expect(invalid.envelope.state.events.slice(0, -1)).toEqual(oldEvents);
        expect(invalid.envelope.state.events.at(-1)?.kind).toBe('candidate_invalidated');
        expect(invalid.envelope.state.work).toEqual(oldWork);
        expect(invalid.envelope.notification?.outbox).toEqual(oldOutbox);
        const rediscovered = yield* readNativeTaskView(f.config, {runId: 'native-run', callerCwd: baseline.repo});
        expect(rediscovered.candidateWatches?.[0]?.invalidation?.kind).toBe('candidate_invalidated');
        const recoveredRef = required(rediscovered.candidateWatches?.[0]?.candidateWatchRef);
        expect(
          object(
            yield* runNativeTaskAction(f.config, {
              command: 'watch-pr',
              runId: 'native-run',
              callerCwd: baseline.repo,
              candidateWatchRef: recoveredRef,
              operation: 'inspect',
            }),
          ).status,
        ).toBe('candidate-watch-updated');
        expect(object(yield* invoke({...continuation, operation: 'work'})).status).toBe('candidate-watch-updated');
        expect(
          object(
            yield* runNativeTaskAction(f.config, {
              command: 'watch-pr',
              runId: 'native-run',
              callerCwd: baseline.repo,
              candidateWatchRef: recoveredRef,
              operation: 'stop',
            }),
          ).status,
        ).toBe('candidate-watch-updated');
        expect((yield* invoke({...continuation, operation: 'relay'}).pipe(Effect.result))._tag).toBe('Failure');
        expect(providerCalls).toBe(callsBeforeSweep);
        // A changed PR head also refuses a fresh start, without creating/rebinding a watch.
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "candidate";\n');
        yield* f.mutate('invalidate', {
          phaseId: 'one',
          reason: 'Repair iteration invalidates the retained snapshot without changing source.',
        });
        const retired = required(yield* readNativeWorkflowState(f.config, 'native-run'));
        const retirementCalls = providerCalls;
        if (activeOwner.kind !== 'candidate-pr') throw new Error('Expected candidate owner');
        const retiredCheck = yield* verifyNativeCandidateWatchOwner(f.config, activeOwner).pipe(Effect.result);
        expect(retiredCheck._tag).toBe('Failure');
        expect(retiredCheck).toMatchObject({failure: {code: 'candidate-binding-drift'}});
        expect(providerCalls).toBe(retirementCalls);
        const retiredInventory = yield* readNativeCandidateWatchInventory(f.config, retired, baseline.repo);
        expect(retiredInventory.rows[0]?.historical).toBe(true);
        expect((yield* invoke(startRequest).pipe(Effect.result))._tag).toBe('Failure');
        providerHead = EffectString.repeat(40)('b');
        expect((yield* invoke(startRequest).pipe(Effect.result))._tag).toBe('Failure');
        expect(spawns).toBe(1);
      }).pipe(
        Effect.provideService(CommandExecutor, testCommands),
        Effect.provideService(SystemInfo, scopedSystem),
        Effect.provideService(FileSystem.FileSystem, discoveringFileSystem),
      );
    }).pipe(run),
);
