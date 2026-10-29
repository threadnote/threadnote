import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Clock, DateTime, Deferred, Effect, Fiber, FileSystem, Layer, Path, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, vi} from 'vitest';
import {FileLockTimeout} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import {succeedUndefined} from '@threadnote/platform/optional';
import {contextHealthCaseIdV2} from '@threadnote/context/health_maintenance';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {captureConsole} from '../../src/effect/console.js';
import {EffectMcpServerAdapter} from '../../src/effect/ai/mcp.js';
import {registerContextMaintenanceTools} from '../../src/mcp/server/context/maintenance.js';
import {handleManagerAttentionAction} from '../../src/manager/attention_actions.js';
import * as maintenance from '../../src/memory/context/maintenance.js';
import * as selectedRefresh from '../../src/memory/context/maintenance_refresh.js';
import {runContextMaintainCommand} from '../../src/memory/context/maintenance_commands.js';
import {
  refreshContextMaintenanceCase,
  withMaintenanceOperationLock,
} from '../../src/memory/context/maintenance_refresh.js';
import {
  ContextMaintenanceBusy,
  MaintenancePauseFenceBusy,
  contextMaintenanceBusyResult,
  type ContextMaintenanceCaseV2,
  type MaintenanceState,
} from '../../src/memory/context/maintenance_contracts.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const TEST_LAYER = TestSystemInfoLayer.pipe(Layer.provideMerge(BunServices.layer));
const NOW = '2026-10-03T15:00:00.000Z';

function fixture() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'maintenance-contention-'});
    const config = {
      account: 'local',
      agentContextHome: home,
      agentId: 'test',
      manifestPath: path.join(home, 'manifest.yaml'),
      user: 'tester',
    };
    yield* fs.writeFileString(config.manifestPath, 'version: 1\nprojects: []\n');
    const statePath = yield* maintenance.contextMaintenanceStatePath(config);
    yield* fs.makeDirectory(path.dirname(statePath), {recursive: true});
    const state: MaintenanceState = {
      version: 2,
      paused: false,
      state: 'idle',
      generation: 'fixture',
      projects: [],
      cases: [],
      receipts: [],
      checkpoints: {},
    };
    yield* maintenance.writeState(config, state);
    return {fs, path, home, config, state, statePath, lockPath: `${statePath}.lock`};
  });
}

function withHolder<A, E, R>(
  config: Effect.Success<ReturnType<typeof fixture>>['config'],
  use: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const acquired = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* maintenance
      .withStateLock(config, Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))))
      .pipe(Effect.forkScoped);
    yield* Deferred.await(acquired);
    return yield* use.pipe(
      Effect.ensuring(
        Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(holder)), Effect.orDie, Effect.asVoid),
      ),
    );
  });
}

function expectBusy(result: Result.Result<unknown, unknown>) {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(Schema.is(ContextMaintenanceBusy)(result.failure)).toBe(true);
}

function successor(value: number): ContextMaintenanceCaseV2 {
  const identity = {project: 'fixture', memoryId: 'tn_successor', family: 'semantic-contradiction', slot: 'left:right'};
  return {
    ...identity,
    caseId: contextHealthCaseIdV2(identity),
    evidenceRevision: String(value),
    disposition: 'needs-decision',
    reason: 'fixture-successor',
    firstSeen: NOW,
    lastSeen: NOW,
    lastChecked: NOW,
    attemptCount: 0,
    events: [],
  };
}

describe('maintenance-state contention boundary', () => {
  effectIt.effect(
    'reports actual live-holder contention after the unchanged50ms wait without entering or changing its token',
    () =>
      Effect.gen(function* () {
        const data = yield* fixture();
        let entered = 0;
        yield* withHolder(
          data.config,
          Effect.gen(function* () {
            const token = yield* data.fs.readFileString(data.lockPath);
            const before = yield* Clock.currentTimeMillis;
            const result = yield* withMaintenanceOperationLock(
              data.config,
              Effect.sync(() => ++entered),
            ).pipe(Effect.result);
            const elapsed = (yield* Clock.currentTimeMillis) - before;
            expectBusy(result);
            expect(elapsed).toBeGreaterThanOrEqual(50);
            expect(entered).toBe(0);
            expect(yield* data.fs.readFileString(data.lockPath)).toBe(token);
            const publicResult = JSON.stringify(contextMaintenanceBusyResult());
            expect(publicResult).not.toContain(data.lockPath);
            expect(publicResult).not.toContain(JSON.parse(token).token);
            expect(publicResult).not.toMatch(/remove|delete|deadlock|dead owner/iu);
          }),
        );
        expect(yield* data.fs.exists(data.lockPath)).toBe(false);
      }).pipe(TestClock.withLive, provideTestLayer(TEST_LAYER)),
  );

  effectIt.effect(
    'does not turn a different lock timeout before entry or a nested timeout after entry into maintenance busy',
    () =>
      Effect.gen(function* () {
        const data = yield* fixture();
        const nested = FileLockTimeout.of(data.path.join(data.home, 'different-uri.lock'));
        const spy = vi.spyOn(maintenance, 'withStateLock').mockReturnValue(Effect.fail(nested));
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        const before = yield* withMaintenanceOperationLock(data.config, Effect.void).pipe(Effect.result);
        expect(Result.isFailure(before)).toBe(true);
        if (Result.isFailure(before)) expect(before.failure).toBe(nested);
        spy.mockRestore();
        const after = yield* withMaintenanceOperationLock(data.config, Effect.fail(nested)).pipe(Effect.result);
        expect(Result.isFailure(after)).toBe(true);
        if (Result.isFailure(after)) expect(after.failure).toBe(nested);
        expect(yield* data.fs.exists(data.lockPath)).toBe(false);
      }).pipe(TestClock.withLive, provideTestLayer(TEST_LAYER)),
  );

  effectIt.effect(
    'resets protected-entry tracking for every execution of the same Effect and preserves the pause fence mapping',
    () =>
      Effect.gen(function* () {
        const data = yield* fixture();
        const nested = FileLockTimeout.of(data.lockPath);
        const operation = withMaintenanceOperationLock(data.config, Effect.fail(nested));
        const first = yield* operation.pipe(Effect.result);
        if (Result.isFailure(first)) expect(first.failure).toBe(nested);
        yield* withHolder(
          data.config,
          Effect.gen(function* () {
            expectBusy(yield* operation.pipe(Effect.result));
            const pause = yield* maintenance.withMaintenancePauseFence(data.config, Effect.void).pipe(Effect.result);
            expect(Result.isFailure(pause)).toBe(true);
            if (Result.isFailure(pause)) expect(Schema.is(MaintenancePauseFenceBusy)(pause.failure)).toBe(true);
          }),
        );
        const nestedPause = yield* maintenance
          .withMaintenancePauseFence(data.config, Effect.fail(nested))
          .pipe(Effect.result);
        if (Result.isFailure(nestedPause)) expect(nestedPause.failure).toBe(nested);
      }).pipe(TestClock.withLive, provideTestLayer(TEST_LAYER)),
  );

  effectIt.effect(
    'keeps unavailable live-owner identity and unreadable owner evidence unknown, preserving their tokens',
    () =>
      Effect.gen(function* () {
        const data = yield* fixture();
        const system = yield* SystemInfo;
        const unknown = SystemInfo.of({
          ...system,
          isProcessRunning: () => true,
          processStartIdentity: () => succeedUndefined,
        });
        const token = JSON.stringify({
          version: 1,
          processId: process.pid,
          processStartIdentity: 'unverifiable-owner',
          token: 'synthetic-owner',
        });
        for (const content of [token, 'x'.repeat(4_097)]) {
          yield* data.fs.writeFileString(data.lockPath, content);
          const old = DateTime.toDateUtc(DateTime.subtract(yield* DateTime.now, {seconds: 120}));
          yield* data.fs.utimes(data.lockPath, old, old);
          const result = yield* withMaintenanceOperationLock(data.config, Effect.void).pipe(
            Effect.provideService(SystemInfo, unknown),
            Effect.result,
          );
          expectBusy(result);
          expect(yield* data.fs.readFileString(data.lockPath)).toBe(content);
        }
      }).pipe(TestClock.withLive, provideTestLayer(TEST_LAYER)),
  );

  effectIt.effect(
    'retains existing recovery for an aged stable malformed token rather than treating unknown as permanently unrecoverable',
    () =>
      Effect.gen(function* () {
        const data = yield* fixture();
        yield* data.fs.writeFileString(data.lockPath, 'not-a-process-owner');
        const old = DateTime.toDateUtc(DateTime.subtract(yield* DateTime.now, {seconds: 120}));
        yield* data.fs.utimes(data.lockPath, old, old);
        expect(yield* withMaintenanceOperationLock(data.config, Effect.succeed('entered'))).toBe('entered');
        expect(yield* data.fs.exists(data.lockPath)).toBe(false);
      }).pipe(TestClock.withLive, provideTestLayer(TEST_LAYER)),
  );

  effectIt.effect(
    'interruption of a contender preserves the holder, and interruption of the owner releases only its own token',
    () =>
      Effect.gen(function* () {
        const data = yield* fixture();
        const acquired = yield* Deferred.make<void>();
        const owner = yield* withMaintenanceOperationLock(
          data.config,
          Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(acquired);
        const token = yield* data.fs.readFileString(data.lockPath);
        const attempted = yield* Deferred.make<void>();
        const contenderFs = FileSystem.FileSystem.of({
          ...data.fs,
          writeFileString: (file, content, options) =>
            data.fs
              .writeFileString(file, content, options)
              .pipe(
                Effect.tapError(() => (file === data.lockPath ? Deferred.succeed(attempted, undefined) : Effect.void)),
              ),
        });
        const contender = yield* withMaintenanceOperationLock(
          data.config,
          Effect.die('A cancelled contender entered.'),
        ).pipe(Effect.provideService(FileSystem.FileSystem, contenderFs), Effect.forkScoped);
        yield* Deferred.await(attempted);
        yield* Fiber.interrupt(contender);
        expect(yield* data.fs.readFileString(data.lockPath)).toBe(token);
        yield* Fiber.interrupt(owner);
        expect(yield* data.fs.exists(data.lockPath)).toBe(false);
        expect(yield* withMaintenanceOperationLock(data.config, Effect.succeed('next'))).toBe('next');
      }).pipe(TestClock.withLive, provideTestLayer(TEST_LAYER)),
  );

  effectIt.effect.prop(
    'serialized state operations retain independent receipts, successor cases and topic checkpoints',
    [Schema.Literals([-3, -1, 0, 1, 4]), Schema.Literals([-2, 0, 2, 5])],
    ([left, right]) =>
      Effect.gen(function* () {
        const data = yield* fixture();
        const item = successor(left);
        const receipt = {
          receiptId: `maintenance-${'a'.repeat(40)}`,
          project: 'fixture',
          subjectUri: 'threadnote://user/tester/memories/durable/projects/fixture/source.md',
          postHash: 'a'.repeat(64),
          timestamp: NOW,
          state: 'applied' as const,
        };
        const checkpoint = {
          targetHash: 'a'.repeat(64),
          revision: 'b'.repeat(64),
          outcome: 'unavailable' as const,
          deferredAt: NOW,
          checkedAt: NOW,
          coverage: 'declared-only' as const,
        };
        const acquired = yield* Deferred.make<void>();
        const publish = yield* Deferred.make<void>();
        const first = yield* withMaintenanceOperationLock(
          data.config,
          Effect.gen(function* () {
            const current = yield* maintenance.readState(data.config);
            yield* Deferred.succeed(acquired, undefined);
            yield* Deferred.await(publish);
            yield* maintenance.writeState(data.config, {
              ...current,
              cases: [item],
              receipts: [receipt],
              topicCheckpoints: {[item.caseId]: checkpoint},
              policyOverrides: {sum: String(left)},
            });
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(acquired);
        let secondEntries = 0;
        const second = withMaintenanceOperationLock(
          data.config,
          Effect.gen(function* () {
            secondEntries++;
            const latest = yield* maintenance.readState(data.config);
            yield* maintenance.writeState(data.config, {
              ...latest,
              policyOverrides: {...latest.policyOverrides, sum: String(Number(latest.policyOverrides?.sum) + right)},
            });
          }),
        );
        expectBusy(yield* second.pipe(Effect.result));
        expect(secondEntries).toBe(0);
        yield* Deferred.succeed(publish, undefined);
        yield* Fiber.join(first);
        yield* second;
        const latest = yield* maintenance.readState(data.config);
        expect(secondEntries).toBe(1);
        expect(latest.cases).toEqual([item]);
        expect(latest.receipts).toEqual([receipt]);
        expect(latest.topicCheckpoints).toEqual({[item.caseId]: checkpoint});
        expect(latest.policyOverrides?.sum).toBe(String(left + right));
      }).pipe(TestClock.withLive, provideTestLayer(TEST_LAYER)),
    {arbitrary: {runs: 16}},
  );

  effectIt.effect('keeps actual selected observation inside the state lock across evidence reads', () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const uri = 'threadnote://user/tester/memories/durable/projects/fixture/source.md';
      const file = data.path.join(
        data.home,
        'data',
        'local',
        'user',
        'tester',
        'memories',
        'durable',
        'projects',
        'fixture',
        'source.md',
      );
      yield* data.fs.makeDirectory(data.path.dirname(file), {recursive: true});
      const target = 'threadnote://user/tester/memories/durable/projects/fixture/missing.md';
      const content = formatMemoryDocument(
        'MEMORY',
        {
          schemaVersion: 2,
          memoryId: 'tn_source',
          kind: 'durable',
          status: 'active',
          project: 'fixture',
          topic: 'source',
          timestamp: NOW,
          sourceAgentClient: 'test',
          relations: [{type: 'references', uri: target}],
        },
        'Synthetic selected subject.',
      );
      yield* data.fs.writeFileString(file, content);
      const identity = {project: 'fixture', memoryId: 'tn_source', family: 'relation', slot: target};
      const selected = {
        ...successor(1),
        ...identity,
        caseId: contextHealthCaseIdV2(identity),
        subjectContentHashes: [{uri, hash: 'old'}],
      };
      yield* maintenance.writeState(data.config, {...data.state, cases: [selected, successor(2)]});
      const canonicalFile = yield* data.fs.realPath(file);
      const observing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reads = 0;
      const blocked = FileSystem.FileSystem.of({
        ...data.fs,
        open: (path, options) =>
          Effect.gen(function* () {
            if (path === canonicalFile && reads++ === 0) {
              yield* Deferred.succeed(observing, undefined);
              yield* Deferred.await(release);
            }
            return yield* data.fs.open(path, options);
          }),
      });
      const refresh = yield* refreshContextMaintenanceCase(data.config, {
        project: 'fixture',
        caseId: selected.caseId,
        cwd: data.home,
      }).pipe(Effect.provideService(FileSystem.FileSystem, blocked), Effect.forkScoped);
      yield* Deferred.await(observing);
      expectBusy(
        yield* withMaintenanceOperationLock(data.config, Effect.die('An observer competitor entered.')).pipe(
          Effect.result,
        ),
      );
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(refresh)).outcome).toBe('ready');
      expect((yield* maintenance.readState(data.config)).cases).toContainEqual(successor(2));
      expect(yield* data.fs.readFileString(file)).toBe(content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'projects busy consistently through actual run/refresh/retire, CLI, MCP and Manager without scheduling work',
    () =>
      Effect.gen(function* () {
        const data = yield* fixture();
        const system = yield* SystemInfo;
        const exitCodes: number[] = [];
        const withExitCapture = SystemInfo.of({
          ...system,
          setExitCode: code => {
            exitCodes.push(code);
          },
        });
        const stateBefore = yield* data.fs.readFileString(data.statePath);
        yield* withHolder(
          data.config,
          Effect.gen(function* () {
            expectBusy(yield* maintenance.runContextMaintenance(data.config, {cwd: data.home}).pipe(Effect.result));
            expectBusy(
              yield* refreshContextMaintenanceCase(data.config, {
                project: 'fixture',
                caseId: 'selected',
                cwd: data.home,
              }).pipe(Effect.result),
            );
            expectBusy(
              yield* maintenance
                .retireContextMaintenanceAnchor(data.config, {
                  caseId: 'selected',
                  evidenceRevision: 'reviewed',
                  expectedContentHash: 'reviewed',
                })
                .pipe(Effect.result),
            );
            const cli = yield* captureConsole(runContextMaintainCommand(data.config, {action: 'run', json: true})).pipe(
              Effect.provideService(SystemInfo, withExitCapture),
            );
            expect(JSON.parse(cli.output)).toEqual(contextMaintenanceBusyResult());
            expect(exitCodes).toEqual([1]);
            const server = new EffectMcpServerAdapter('contention-test', '0', 'Synthetic contention control.');
            registerContextMaintenanceTools(server, data.config);
            const mcp = yield* server.invokeTool('context_maintain', {action: 'run', callerCwd: data.home});
            expect(mcp.isError).toBe(true);
            expect(mcp.structuredContent).toEqual(contextMaintenanceBusyResult());
            const manager = yield* handleManagerAttentionAction({
              config: data.config,
              method: 'POST',
              url: new URL('http://localhost/api/attention/context-maintenance'),
              body: Effect.succeed({action: 'refresh-case', project: 'fixture', caseId: 'selected'}),
            });
            expect(manager).toEqual({status: 503, body: contextMaintenanceBusyResult()});
            expect(yield* data.fs.readFileString(data.statePath)).toBe(stateBefore);
          }),
        );
      }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('adapters preserve an after-entry failure rather than reporting retryable no-progress busy', () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      const nested = FileLockTimeout.of(data.path.join(data.home, 'nested-uri.lock'));
      const spy = vi.spyOn(selectedRefresh, 'refreshContextMaintenanceCase').mockReturnValue(Effect.fail(nested));
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      const cli = yield* runContextMaintainCommand(data.config, {
        action: 'refresh',
        project: 'fixture',
        caseId: 'selected',
        sourceCwd: data.home,
        json: true,
      }).pipe(Effect.result);
      expect(Result.isFailure(cli)).toBe(true);
      if (Result.isFailure(cli)) expect(cli.failure).toBe(nested);
      const server = new EffectMcpServerAdapter('nested-test', '0', 'Synthetic nested failure.');
      registerContextMaintenanceTools(server, data.config);
      const mcp = yield* server.invokeTool('context_maintain', {
        action: 'refresh',
        project: 'fixture',
        caseId: 'selected',
        callerCwd: data.home,
      });
      expect(mcp.isError).toBe(true);
      expect(JSON.stringify(mcp)).not.toContain('context-maintenance-busy');
      const manager = yield* handleManagerAttentionAction({
        config: data.config,
        method: 'POST',
        url: new URL('http://localhost/api/attention/context-maintenance'),
        body: Effect.succeed({action: 'refresh-case', project: 'fixture', caseId: 'selected'}),
      }).pipe(Effect.result);
      expect(Result.isFailure(manager)).toBe(true);
      if (Result.isFailure(manager)) expect(manager.failure).toBe(nested);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('run does not mask a nested timeout after protected work with a status-only success', () =>
    Effect.gen(function* () {
      const data = yield* fixture();
      yield* maintenance.writeState(data.config, {...data.state, paused: true});
      const nested = FileLockTimeout.of(data.path.join(data.home, 'nested-after-entry.lock'));
      let completed = 0;
      const spy = vi.spyOn(selectedRefresh, 'withMaintenanceOperationLock').mockImplementation((_config, operation) =>
        operation.pipe(
          Effect.tap(() => Effect.sync(() => completed++)),
          Effect.andThen(Effect.fail(nested)),
        ),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      const result = yield* maintenance.runContextMaintenance(data.config, {cwd: data.home}).pipe(Effect.result);
      expect(completed).toBe(1);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toBe(nested);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});
