import {it as effectIt} from '@effect/vitest';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {succeedUndefined} from '@threadnote/platform/optional';
import {SystemInfo} from '@threadnote/platform/system';
import {runtimeConfigForTest} from '@threadnote/workspace/test/helpers/runtime-config';
import {
  Array as EffectArray,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Schema,
  Stdio,
  Terminal,
  String as EffectString,
} from 'effect';
import {Command} from 'effect/cli';
import {makeNativeTaskPrWatchCommand} from '../../src/effect/workflow_cli.js';
import * as Clock from 'effect/Clock';
import * as TestClock from 'effect/testing/TestClock';
import {SecureRandom} from 'effect/crypto';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerWorkflowTaskTool} from '../../src/mcp/server/workflow.js';
import {runNativeTaskAction} from '../../src/workflow_automation/task_actions.js';
import {runNativeWatch} from '../../src/workflow_automation/watch.js';
import {readNativeWatch, writeNativeWatch} from '../../src/workflow_automation/watch_store.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const cliLayer = Layer.mergeAll(
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      size: Effect.die('unused'),
      readInput: Effect.die('unused'),
      readLine: Effect.die('unused'),
      display: () => Effect.void,
    }),
  ),
);
const prUrl = 'https://github.com/example/repo/pull/42';
const head = EffectString.repeat(40)('a');
const wakeup = {host: 'codex' as const, executable: '/usr/bin/codex', threadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'};
const object = (value: unknown): Record<string, unknown> => {
  if (!Predicate.isObject(value)) throw new Error('Expected an object');
  return value;
};
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'standalone-pr-watch-'});
  const repo = path.join(home, 'repo');
  yield* fs.makeDirectory(repo);
  yield* runCommandEffect('git', ['init', '--initial-branch=unrelated-local-branch', repo]);
  yield* runCommandEffect('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
  // Neither local commits nor a clean checkout are required to monitor an existing PR.
  yield* fs.writeFileString(path.join(repo, 'untracked.ts'), 'uncommitted work');
  const config = runtimeConfigForTest({agentContextHome: home});
  const delegate = yield* CommandExecutor;
  const system = yield* SystemInfo;
  const processContext = yield* Effect.context<FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom>();
  let watchId = '';
  let spawns = 0;
  let spawnSucceeds = true;
  let remoteBase = 'main';
  let remoteRepository = 'example/repo';
  const commands = CommandExecutor.of({
    ...delegate,
    execute: (executable, args, options) => {
      if (executable === wakeup.executable)
        return Effect.succeed({
          exitCode: 0,
          stderr: '',
          stdout: 'Usage: codex queue [OPTIONS]\n --thread <THREAD>\n --message <MESSAGE>\n',
        });
      if (executable === 'gh') {
        const full = EffectArray.some(args, arg => EffectString.includes('headSha:')(arg));
        return Effect.succeed({
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            number: 42,
            url: prUrl,
            baseRepository: remoteRepository,
            baseBranch: remoteBase,
            headBranch: 'from-a-fork',
            ...(full ? {headSha: head, state: 'open', merged: false} : {}),
          }),
        });
      }
      return delegate.execute(executable, args, options);
    },
    spawnDetached: (_executable, args) =>
      Effect.gen(function* () {
        spawns++;
        const index = args.indexOf('--watch-id');
        watchId = args[index + 1];
        if (!spawnSucceeds) return false;
        const stored = yield* readNativeWatch(config, watchId);
        if (!stored?.envelope.collector) return false;
        yield* writeNativeWatch(
          config,
          {...stored.envelope, collector: {...stored.envelope.collector, pid: 77777, status: 'running'}},
          stored.revision,
        );
        return true;
      }).pipe(Effect.provide(processContext), Effect.orDie),
  });
  const fakeSystem = SystemInfo.of({
    ...system,
    isProcessRunning: pid => pid === 77777,
    processStartIdentity: () => succeedUndefined,
    canonicalProcessStartIdentity: () => succeedUndefined,
  });
  const call = (fields: Record<string, unknown>) =>
    runNativeTaskAction(config, {command: 'watch-pr', callerCwd: repo, ...fields}).pipe(
      Effect.provideService(CommandExecutor, commands),
      Effect.provideService(SystemInfo, fakeSystem),
    );
  return {
    fs,
    path,
    home,
    repo,
    config,
    call,
    getWatchId: () => watchId,
    spawns: () => spawns,
    setSpawnSucceeds: (succeeds: boolean) => {
      spawnSucceeds = succeeds;
    },
    setRemoteBase: (base: string) => {
      remoteBase = base;
    },
    setRemoteRepository: (repository: string) => {
      remoteRepository = repository;
    },
    commands,
    system: fakeSystem,
  };
});
const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(provideTestLayer(ApplicationLayer), TestClock.withLive);

const populateEvent = (f: Effect.Success<typeof setup>, terminal = false) =>
  Effect.gen(function* () {
    const stored = yield* readNativeWatch(f.config, f.getWatchId());
    if (!stored?.envelope.notification || !stored.envelope.collector) throw new Error('Expected started watch');
    const now = yield* Clock.currentTimeMillis;
    const event = {
      sequence: 1,
      id: f.getWatchId() + ':1',
      source: 'comments' as const,
      kind: 'comment' as const,
      key: 'comment-1',
      version: EffectString.repeat(64)('e'),
      at: now,
      removed: false,
    };
    yield* writeNativeWatch(
      f.config,
      {
        ...stored.envelope,
        state: {
          ...stored.envelope.state,
          head,
          prState: terminal ? 'merged' : 'open',
          nextSequence: 2,
          events: [event],
        },
        collector: {...stored.envelope.collector, status: terminal ? 'terminal' : 'running'},
        notification: {
          ...stored.envelope.notification,
          outbox: {
            key: f.getWatchId() + ':1:1',
            first: 1,
            last: 1,
            createdAt: now,
            attempts: 1,
            nextAttemptAt: now,
            status: 'queued',
            attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            collectorToken: stored.envelope.collector.token,
            receipt: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            consumedThrough: 0,
          },
        },
      },
      stored.revision,
    );
  });

describe('standalone PR watches', () => {
  effectIt.effect(
    'starts without workflow state, resumes the same host and refuses forged bindings or workflow delivery',
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        f.setRemoteRepository('other/repository');
        expect((yield* f.call({operation: 'start', prUrl, wakeup}).pipe(Effect.result))._tag).toBe('Failure');
        f.setRemoteRepository('example/repo');
        expect((yield* f.call({operation: 'start', wakeup}).pipe(Effect.result))._tag).toBe('Failure');
        const mcp = new EffectMcpServerAdapter('test', '1', 'fixture');
        registerWorkflowTaskTool(mcp, f.config);
        const envelope = yield* mcp
          .invokeTool('workflow_task_watch_pr', {operation: 'start', callerCwd: f.repo, prUrl, wakeup})
          .pipe(Effect.provideService(CommandExecutor, f.commands), Effect.provideService(SystemInfo, f.system));
        const started = object(object(envelope).structuredContent);
        const watchRef = String(started.watchRef);
        expect(started).toMatchObject({status: 'watching', authority: 'monitor-only', prUrl});
        expect(watchRef).toMatch(/^threadnote-standalone-watch-v1:/u);
        expect(f.spawns()).toBe(1);
        expect(yield* f.fs.exists(f.path.join(f.home, 'workflow-automations', 'native-v1'))).toBe(false);
        expect(object(yield* f.call({operation: 'start', prUrl, wakeup})).watchRef).toBe(watchRef);
        expect(object(yield* f.call({operation: 'start', watchRef})).watchRef).toBe(watchRef);
        let cliReadback: Record<string, unknown> | undefined;
        const cli = Command.make('workflow-automation').pipe(
          Command.withSubcommands([
            makeNativeTaskPrWatchCommand(options =>
              f
                .call({
                  operation: options.operation,
                  ...(options.prUrl === undefined ? {} : {prUrl: options.prUrl}),
                  ...(options.watchRef === undefined ? {} : {watchRef: options.watchRef}),
                  ...(options.wakeup === undefined ? {} : {wakeup: options.wakeup}),
                })
                .pipe(
                  Effect.tap(value =>
                    Effect.sync(() => {
                      cliReadback = object(value);
                    }),
                  ),
                  Effect.asVoid,
                ),
            ),
          ]),
        );
        yield* Command.runWith(cli, {version: 'fixture'})([
          'watch-pr',
          '--caller-cwd',
          f.repo,
          '--operation',
          'start',
          '--pr-url',
          prUrl,
          '--host',
          'codex',
          '--host-executable',
          wakeup.executable,
          '--host-reference',
          wakeup.threadId,
        ]);
        expect(cliReadback?.watchRef).toBe(watchRef);
        yield* Command.runWith(cli, {version: 'fixture'})([
          'watch-pr',
          '--caller-cwd',
          f.repo,
          '--operation',
          'inspect',
          '--watch-ref',
          watchRef,
        ]);
        expect(cliReadback?.watchId).toBe(started.watchId);
        const marker = 'threadnote-standalone-watch-v1:';
        const binding = object(
          JSON.parse(Buffer.from(EffectString.slice(marker.length)(watchRef), 'base64url').toString()),
        );
        const beforeTampering = yield* readNativeWatch(f.config, f.getWatchId());
        for (const changed of [
          {prUrl: 'https://github.com/example/repo/pull/43'},
          {baseBranch: 'foreign'},
          {headBranch: 'foreign'},
          {wakeup: {...wakeup, threadId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}},
          {version: 2},
        ]) {
          const forged = marker + Buffer.from(JSON.stringify({...binding, ...changed})).toString('base64url');
          expect((yield* f.call({operation: 'inspect', watchRef: forged}).pipe(Effect.result))._tag).toBe('Failure');
          expect((yield* readNativeWatch(f.config, f.getWatchId()))?.revision).toBe(beforeTampering?.revision);
        }
        expect(f.spawns()).toBe(1);
        for (const fields of [
          {operation: 'inspect', prUrl: 'https://github.com/example/repo/pull/43'},
          {operation: 'inspect', wakeup: {...wakeup, threadId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}},
          {operation: 'renew', takeover: true},
          {operation: 'complete'},
          {operation: 'inspect', runId: 'fake-run'},
          {operation: 'start', wakeup: {...wakeup, threadId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}},
        ]) {
          expect((yield* f.call({watchRef, ...fields}).pipe(Effect.result))._tag).toBe('Failure');
        }
        const foreign = f.path.join(f.home, 'foreign');
        yield* f.fs.makeDirectory(foreign);
        yield* runCommandEffect('git', ['init', foreign]);
        expect((yield* f.call({operation: 'inspect', callerCwd: foreign, watchRef}).pipe(Effect.result))._tag).toBe(
          'Failure',
        );
        f.setRemoteBase('other-base');
        expect((yield* f.call({operation: 'renew', watchRef}).pipe(Effect.result))._tag).toBe('Failure');
        f.setRemoteBase('main');
        expect(object(yield* f.call({operation: 'renew', watchRef})).status).toBe('watching');
        yield* f.call({operation: 'stop', watchRef});
        const stopped = object(yield* f.call({operation: 'start', prUrl, wakeup}));
        expect(stopped.status).toBe('watch-stopped');
        expect(object(stopped.result).stopRequested).toBe(true);
        expect(yield* f.call({operation: 'renew', watchRef}).pipe(Effect.result)).toMatchObject({
          failure: {code: 'watch-stopped'},
        });
        expect(f.spawns()).toBe(1);
      }).pipe(run, provideTestLayer(cliLayer)),
  );

  effectIt.effect(
    'routes exact notices and event dispositions before ACK, retains work, and drains terminal watches',
    () =>
      Effect.gen(function* () {
        const f = yield* setup;
        const started = object(yield* f.call({operation: 'start', prUrl, wakeup}));
        const watchRef = String(started.watchRef);
        yield* populateEvent(f, true);
        expect(object(yield* f.call({operation: 'start', prUrl, wakeup})).status).toBe('terminal');
        const inspected = object(yield* f.call({operation: 'inspect', watchRef}));
        const noticeRef = String(inspected.noticeRef);
        expect(noticeRef).toMatch(/^threadnote-standalone-event-v1:/u);
        const delivered = object(yield* f.call({operation: 'relay', watchRef, noticeRef}));
        const watchDeliveryRef = String(delivered.watchDeliveryRef);
        const eventRefs = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(delivered.eventRefs);
        expect(eventRefs).toHaveLength(1);
        expect(yield* f.call({operation: 'ack', watchRef, watchDeliveryRef}).pipe(Effect.result)).toMatchObject({
          failure: {code: 'invalid-watch'},
        });
        yield* f.call({
          operation: 'disposition',
          watchRef,
          watchDeliveryRef,
          dispositions: [
            {
              eventRef: eventRefs[0],
              status: 'open',
              reason: 'Needs a repair',
              evidence: 'Observed exact remote comment',
            },
          ],
        });
        yield* f.call({operation: 'ack', watchRef, watchDeliveryRef});
        const work = object(object(yield* f.call({operation: 'work', watchRef})).result);
        const items = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({eventRef: Schema.String})))(
          object(work.work).items,
        );
        expect(items).toHaveLength(1);
        const retainedRef = items[0].eventRef;
        const detail = object(yield* f.call({operation: 'work-detail', watchRef, workEventRef: retainedRef}));
        expect(object(detail.result).workDetail).toBeDefined();
        yield* f.call({
          operation: 'work-disposition',
          watchRef,
          dispositions: [
            {
              eventRef: retainedRef,
              status: 'resolved',
              reason: 'Repair verified',
              evidence: 'Focused current-head checks passed',
            },
          ],
        });
        expect(object(yield* f.call({operation: 'relay', watchRef})).status).toBe('terminal-empty');
        expect(object(yield* f.call({operation: 'renew', watchRef})).status).toBe('terminal-empty');
        expect(object(yield* f.call({operation: 'start', prUrl, wakeup})).status).toBe('terminal-empty');
        expect(f.spawns()).toBe(1);
      }).pipe(run),
  );

  effectIt.effect('retries an exact failed admission without reviving a later explicit stop', () =>
    Effect.gen(function* () {
      const f = yield* setup;
      f.setSpawnSucceeds(false);
      expect(yield* f.call({operation: 'start', prUrl, wakeup}).pipe(Effect.result)).toMatchObject({
        failure: {code: 'collector-startup-failed'},
      });
      const failed = yield* readNativeWatch(f.config, f.getWatchId());
      expect(failed?.envelope).toMatchObject({
        stopRequested: true,
        collector: {status: 'blocked', reason: 'collector-startup-failed', pid: 0},
      });
      f.setSpawnSucceeds(true);
      const recovered = object(yield* f.call({operation: 'start', prUrl, wakeup}));
      expect(recovered.status).toBe('watching');
      expect(object(recovered.result)).toMatchObject({stopRequested: false, collector: {alive: true}});
      expect((yield* readNativeWatch(f.config, f.getWatchId()))?.envelope.collector?.token).not.toBe(
        failed?.envelope.collector?.token,
      );
      expect(f.spawns()).toBe(2);

      const stoppedFixture = yield* setup;
      stoppedFixture.setSpawnSucceeds(false);
      yield* stoppedFixture.call({operation: 'start', prUrl, wakeup}).pipe(Effect.result);
      // Native stop may be issued by another local surface after admission failed.
      yield* runNativeWatch(stoppedFixture.config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: 'stop',
        watchId: stoppedFixture.getWatchId(),
      }).pipe(
        Effect.provideService(CommandExecutor, stoppedFixture.commands),
        Effect.provideService(SystemInfo, stoppedFixture.system),
      );
      stoppedFixture.setSpawnSucceeds(true);
      const stopped = object(yield* stoppedFixture.call({operation: 'start', prUrl, wakeup}));
      expect(stopped.status).toBe('watch-stopped');
      expect(object(stopped.result)).toMatchObject({
        stopRequested: true,
        collector: {alive: false, reason: 'explicit-stop'},
      });
      expect(stoppedFixture.spawns()).toBe(1);
    }).pipe(run),
  );

  effectIt.effect('reports a stop observed during setup inspection from the same fresh health result', () =>
    Effect.gen(function* () {
      const f = yield* setup;
      const started = object(yield* f.call({operation: 'start', prUrl, wakeup}));
      const watchFile = f.path.join(
        yield* f.fs.realPath(f.home),
        'workflow-automations',
        'native-watch-v1',
        f.getWatchId() + '.json',
      );
      const stop = runNativeWatch(f.config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: 'stop',
        watchId: f.getWatchId(),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, f.fs),
        Effect.provideService(CommandExecutor, f.commands),
        Effect.provideService(SystemInfo, f.system),
        Effect.asVoid,
      );
      const context = yield* Effect.context<Effect.Services<typeof stop>>();
      const ownedStop = stop.pipe(Effect.provide(context), Effect.orDie);
      let watchReads = 0;
      const racingFs = FileSystem.FileSystem.of({
        ...f.fs,
        readFileString: file =>
          Effect.gen(function* () {
            if (file === watchFile && ++watchReads === 2) yield* ownedStop;
            return yield* f.fs.readFileString(file);
          }),
      });
      const observed = object(
        yield* f
          .call({operation: 'start', watchRef: started.watchRef})
          .pipe(Effect.provideService(FileSystem.FileSystem, racingFs)),
      );
      expect(watchReads).toBeGreaterThanOrEqual(2);
      expect(observed.status).toBe('watch-stopped');
      expect(object(observed.result)).toMatchObject({
        stopRequested: true,
        collector: {alive: true, reason: 'explicit-stop'},
      });
      expect(f.spawns()).toBe(1);
    }).pipe(run),
  );

  effectIt.effect.prop(
    'rejects every altered notice scope without consuming its queued attempt',
    {
      field: Schema.Literals([
        'scope',
        'bindingDigest',
        'watchId',
        'consumerId',
        'wakeupId',
        'eventKey',
        'watchAttemptId',
      ]),
      suffix: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{1,10}$/u)),
    },
    ({field, suffix}) =>
      Effect.gen(function* () {
        const f = yield* setup;
        const watchRef = String(object(yield* f.call({operation: 'start', prUrl, wakeup})).watchRef);
        yield* populateEvent(f);
        const noticeRef = String(object(yield* f.call({operation: 'inspect', watchRef})).noticeRef);
        const prefix = 'threadnote-standalone-event-v1:';
        const raw = object(
          JSON.parse(Buffer.from(EffectString.slice(prefix.length)(noticeRef), 'base64url').toString()),
        );
        raw[field] =
          field === 'bindingDigest'
            ? EffectString.repeat(64)('f')
            : field === 'watchAttemptId'
              ? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
              : field === 'eventKey'
                ? `foreign-${suffix}:1:1`
                : `foreign-${suffix}`;
        const forged = prefix + Buffer.from(JSON.stringify(raw)).toString('base64url');
        const before = yield* readNativeWatch(f.config, f.getWatchId());
        expect((yield* f.call({operation: 'relay', watchRef, noticeRef: forged}).pipe(Effect.result))._tag).toBe(
          'Failure',
        );
        expect((yield* readNativeWatch(f.config, f.getWatchId()))?.revision).toBe(before?.revision);
      }).pipe(run),
    {arbitrary: {runs: 12}},
  );
});
