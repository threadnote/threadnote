import {it as effectIt} from '@effect/vitest';
import {expect} from 'vitest';
import {Clock, Effect, Array as EffectArray, String as EffectString} from 'effect';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {decodeNativeTaskActionRef, encodeNativeTaskActionRef} from '@threadnote/workflow-automations/task';
import {recordNativeWatchLifecycle, nativeWatchEventLimit} from '@threadnote/workflow-automations/watch';
import {runNativeTaskCandidateWatch} from '../../src/workflow_automation/task_candidate_watch.js';
import {readNativeWorkflowState} from '../../src/workflow_automation/store.js';
import {readNativeWatch, writeNativeWatch} from '../../src/workflow_automation/watch_store.js';
import {runNativeWatch, runNativeWatchCollector} from '../../src/workflow_automation/watch.js';
import {sha256HexSync} from '../../src/workflow_memory/native_digest.js';
import {fixture, object, run} from './native-cycle-lifecycle-fixture.js';

const pr = 'https://github.com/example/project/pull/7';
const threadId = '11111111-1111-4111-8111-111111111111';
const attemptId = '22222222-2222-4222-8222-222222222222';
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
      const f = yield* fixture(['one']);
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
      let providerCalls = 0;
      let spawns = 0;
      let providerHead = snapshot.head;
      const testCommands = CommandExecutor.of({
        ...commands,
        execute: (executable, args, options) => {
          if (executable !== 'gh') return commands.execute(executable, args, options);
          providerCalls++;
          return Effect.succeed({
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
          });
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
          wakeup: {
            host: 'cursor-cli' as const,
            executable: '/fixture/agent',
            sessionId: threadId,
            workspace: f.repo,
            exclusiveSession: true as const,
          },
        };
        const started = object(yield* invoke(startRequest));
        const candidateWatchRef = encoded(started.candidateWatchRef);
        const candidate = required(decodeNativeTaskActionRef(candidateWatchRef));
        const watchId = required(candidate.watchId);
        expect(candidate.kind).toBe('candidate-watch');
        expect(started.diagnosticOnly).toBe(true);
        expect(object(yield* invoke(startRequest)).candidateWatchRef).toBe(candidateWatchRef);
        expect(spawns).toBe(1);
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
        let watch = required(yield* readNativeWatch(f.config, watchId));
        const now = yield* Clock.currentTimeMillis;
        const state = recordNativeWatchLifecycle(watch.envelope.state, 'watcher_error', 'diagnostic', now);
        const notification = {
          ...required(watch.envelope.notification),
          target: {host: 'codex' as const, executable: '/fixture/codex', threadId},
          outbox: {
            key: `${watchId}:1:1`,
            first: 1,
            last: 1,
            createdAt: now,
            attempts: 1,
            nextAttemptAt: now + 60_000,
            attemptId,
            collectorToken: required(watch.envelope.collector).token,
            status: 'queued' as const,
            receipt,
            consumedThrough: 0,
          },
        };
        watch = yield* writeNativeWatch(f.config, {...watch.envelope, state, notification}, watch.revision);
        const inspected = object(yield* invoke({...continuation, operation: 'inspect'}));
        const noticeRef = encoded(inspected.noticeRef);
        const notice = required(decodeNativeTaskActionRef(noticeRef));
        expect(notice.kind).toBe('candidate-notice');
        const wrongAttempt = encodeNativeTaskActionRef({...notice, watchAttemptId: receipt});
        const bytesBefore = watch.revision;
        expect(
          (yield* invoke({...continuation, operation: 'relay', noticeRef: wrongAttempt}).pipe(Effect.result))._tag,
        ).toBe('Failure');
        expect(required(yield* readNativeWatch(f.config, watchId)).revision).toBe(bytesBefore);
        const relayed = object(yield* invoke({...continuation, operation: 'relay', noticeRef}));
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
        yield* invoke({
          ...continuation,
          operation: 'disposition',
          watchDeliveryRef,
          dispositions: [
            {eventRef, status: 'open', reason: 'Investigate diagnostic', evidence: 'Exact source event retained'},
          ],
        });
        yield* invoke({...continuation, operation: 'ack', watchDeliveryRef});
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
        expect(object(yield* invoke({...continuation, operation: 'inspect'})).status).toBe('candidate-watch-updated');
        expect(object(yield* invoke({...continuation, operation: 'work'})).status).toBe('candidate-watch-updated');
        expect(object(yield* invoke({...continuation, operation: 'stop'})).status).toBe('candidate-watch-updated');
        expect((yield* invoke({...continuation, operation: 'relay'}).pipe(Effect.result))._tag).toBe('Failure');
        expect(providerCalls).toBe(callsBeforeSweep);
        // A changed PR head also refuses a fresh start, without creating/rebinding a watch.
        yield* f.fs.writeFileString(f.path.join(f.repo, 'source.ts'), 'export const fixture = "candidate";\n');
        providerHead = EffectString.repeat(40)('b');
        expect((yield* invoke(startRequest).pipe(Effect.result))._tag).toBe('Failure');
        expect(spawns).toBe(1);
      }).pipe(Effect.provideService(CommandExecutor, testCommands), Effect.provideService(SystemInfo, scopedSystem));
    }).pipe(run),
);
