import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Deferred, Fiber, Array as EffectArray, Option} from 'effect';
import * as EffectString from 'effect/String';
import * as BunServices from '@effect/platform-bun/BunServices';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {SystemInfo} from '@threadnote/platform/system';
import {
  readManageableThreadnoteProcessDiagnostics,
  sanitizeThreadnoteProcessClientInfo,
  withThreadnoteProcessRegistration,
  withThreadnoteProcessRequestContext,
  withThreadnoteProcessActivity,
} from '@threadnote/threadnote/process/diagnostics';
import {describe} from 'vitest';
import {CommandExecutor} from '@threadnote/platform/command';
import {TestClock} from 'effect/testing';
import {workerOperationLabel} from '../../src/effect/ai/isolated-local-model-runtime.js';

describe('process display context', () => {
  it.effect('keeps escaped long display paths inside the encoded registration budget', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-display-budget-'});
      const native = yield* SystemInfo;
      const longPath = '/' + EffectString.repeat(4090)('"');
      expect(longPath.length).toBe(4091);
      const mocked = FileSystem.FileSystem.of({
        ...fs,
        realPath: value => (value === '/virtual-launch' ? Effect.succeed(longPath) : fs.realPath(value)),
        stat: value => (value === longPath ? fs.stat(home) : fs.stat(value)),
      });
      yield* withThreadnoteProcessRegistration(
        home,
        'mcp',
        withThreadnoteProcessActivity(
          'mcp',
          'context-brief',
          Effect.gen(function* () {
            const file = `${home}/runtime/processes/${native.processId}.json`;
            expect(new TextEncoder().encode(yield* fs.readFileString(file)).byteLength).toBeLessThanOrEqual(16 * 1024);
            const result = yield* readManageableThreadnoteProcessDiagnostics({agentContextHome: home});
            const row = Option.getOrThrow(
              EffectArray.findFirst(result.processes, value => value.processId === native.processId),
            );
            expect(row.displayContext?.workspace).toMatchObject({state: 'active', path: longPath});
            expect(yield* fs.exists(file)).toBe(true);
          }),
          {workingDirectory: longPath},
        ),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, mocked),
        Effect.provideService(SystemInfo, {
          ...native,
          currentDirectory: () => '/virtual-launch',
          environment: () => ({}),
        }),
      );
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );
  it.effect('inherits context only across the captured live parent instance and refreshes branch state', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-display-owner-'});
      const directory = `${home}/runtime/processes`;
      yield* fs.makeDirectory(directory, {recursive: true});
      const native = yield* SystemInfo;
      let parentIdentity: string | undefined = 'parent-instance';
      let childIdentity: string | undefined = 'child-instance';
      let branch = 'feature/a';
      let commands = 0;
      const parent = {
        baseRole: 'mcp',
        role: 'mcp',
        processId: 1234501,
        parentProcessId: 0,
        processStartIdentity: 'parent-instance',
        schemaVersion: 1,
        startedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        token: 'parent-private-token',
        displayContext: {
          client: {name: 'Codex'},
          workspace: {state: 'active', path: '/example/worktree', observedAt: '2026-01-01T00:00:00Z'},
        },
      };
      const child = {
        ...parent,
        baseRole: 'local-model-worker',
        role: 'local-model-worker',
        processId: 1234502,
        parentProcessId: parent.processId,
        processStartIdentity: 'child-instance',
        parentProcessStartIdentity: 'parent-instance',
        token: 'child-private-token',
        displayContext: undefined,
      };
      yield* fs.writeFileString(`${directory}/${parent.processId}.json`, JSON.stringify(parent));
      yield* fs.writeFileString(`${directory}/${child.processId}.json`, JSON.stringify(child));
      const command = CommandExecutor.of({
        execute: (_executable, args, options) =>
          Effect.sync(() => {
            commands++;
            expect(options).toMatchObject({cwd: '/example/worktree', timeoutMs: 250, maxOutputBytes: 1024});
            return args[0] === 'symbolic-ref'
              ? {exitCode: branch ? 0 : 1, stdout: branch, stderr: ''}
              : {exitCode: 0, stdout: 'abcdef123456', stderr: ''};
          }),
        executeStreaming: () => Effect.die('unexpected streaming command'),
      });
      const system = SystemInfo.of({
        ...native,
        isProcessRunning: id => id === parent.processId || id === child.processId,
        canonicalProcessStartIdentity: id => Effect.succeed(id === parent.processId ? parentIdentity : childIdentity),
        processStartIdentity: id => Effect.succeed(id === parent.processId ? parentIdentity : childIdentity),
      });
      const read = readManageableThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
        Effect.map(result =>
          Option.getOrThrow(EffectArray.findFirst(result.processes, row => row.processId === child.processId)),
        ),
      );
      yield* Effect.gen(function* () {
        const inherited = yield* read;
        expect(inherited.displayContext).toMatchObject({
          client: {name: 'Codex'},
          owner: {processId: parent.processId, role: 'mcp'},
          branch: {state: 'branch', name: 'feature/a'},
        });
        expect(JSON.stringify(inherited)).not.toContain('private-token');
        yield* read;
        expect(commands).toBe(1);
        childIdentity = undefined;
        expect((yield* read).displayContext).toBeUndefined();
        childIdentity = 'child-instance';
        branch = '';
        yield* TestClock.adjust(2_001);
        expect((yield* read).displayContext?.branch).toEqual({state: 'detached', commit: 'abcdef123456'});
        parentIdentity = undefined;
        expect((yield* read).displayContext).toBeUndefined();
        parentIdentity = 'reused-parent';
        expect((yield* read).displayContext).toBeUndefined();
        expect(yield* fs.exists(`${directory}/${child.processId}.json`)).toBe(true);
      }).pipe(Effect.provideService(SystemInfo, system), Effect.provideService(CommandExecutor, command));
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  it.effect('labels every model worker protocol operation with a registry-safe descriptive activity', () =>
    Effect.sync(() => {
      for (const operation of [
        'diagnostics',
        'embedMany',
        'embedManyIdleV1',
        'embedManyCapacityV2',
        'generate',
        'rerank',
      ]) {
        const label = workerOperationLabel(operation);
        expect(label).toMatch(/^[a-z][a-z0-9-]{0,47}$/u);
        expect(label).not.toBe('unknown');
      }
      expect(workerOperationLabel('embedManyIdleV1')).toBe('embed-many-idle');
      expect(workerOperationLabel('embedManyCapacityV2')).toBe('embed-many-capacity');
    }),
  );
  it.effect('publishes validated concurrent workspaces, restores the active one and retains last provenance', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-display-'});
      const first = yield* fs
        .makeTempDirectoryScoped({prefix: 'threadnote-workspace-a-'})
        .pipe(Effect.flatMap(fs.realPath));
      const second = yield* fs
        .makeTempDirectoryScoped({prefix: 'threadnote-workspace-b-'})
        .pipe(Effect.flatMap(fs.realPath));
      const system = yield* SystemInfo;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const read = readManageableThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
        Effect.map(value =>
          Option.getOrThrow(EffectArray.findFirst(value.processes, row => row.processId === system.processId)),
        ),
      );
      yield* withThreadnoteProcessRegistration(
        home,
        'mcp',
        Effect.gen(function* () {
          const initial = yield* read;
          const active = yield* withThreadnoteProcessRequestContext(
            {
              transport: 'stdio',
              operation: 'context_brief',
              callerCwd: first,
              clientInfo: {name: 'Example host', version: '1'},
            },
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          expect((yield* read).displayContext).toMatchObject({
            client: {name: 'Example host'},
            workspace: {state: 'active', path: first},
          });
          yield* withThreadnoteProcessRequestContext(
            {transport: 'stdio', operation: 'recall_context', callerCwd: second},
            Effect.gen(function* () {
              expect((yield* read).displayContext?.workspace?.state).toBe('multiple');
            }),
          );
          expect((yield* read).displayContext?.workspace).toMatchObject({state: 'active', path: first});
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(active);
          const completed = yield* read;
          expect(completed.displayContext?.workspace).toMatchObject({state: 'last', path: first});
          expect(completed.processRef).toBe(initial.processRef);
          yield* withThreadnoteProcessRequestContext(
            {transport: 'http', operation: 'recall_context', callerCwd: second, clientInfo: {name: 'Another client'}},
            Effect.void,
          );
          expect((yield* read).displayContext?.client?.name).toBe('Example host');
        }),
      );
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  it.effect('ignores malformed display metadata without removing a valid process', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-display-malformed-'});
      const system = yield* SystemInfo;
      yield* withThreadnoteProcessRegistration(
        home,
        'mcp',
        Effect.gen(function* () {
          const file = `${home}/runtime/processes/${system.processId}.json`;
          const value = JSON.parse(yield* fs.readFileString(file));
          yield* fs.writeFileString(
            file,
            JSON.stringify({
              ...value,
              displayContext: {
                launchDirectory: '/bad\npath',
                client: {name: 42},
                workspace: {state: 'active', path: '/fake', observedAt: 'bad'},
              },
            }),
          );
          const result = yield* readManageableThreadnoteProcessDiagnostics({agentContextHome: home});
          const registered = EffectArray.filter(result.processes, row => row.role !== 'legacy');
          expect(registered).toHaveLength(1);
          expect(registered[0].processId).toBe(system.processId);
          expect(registered[0].displayContext?.client).toBeUndefined();
          expect(registered[0].displayContext?.workspace).toBeUndefined();
          expect(registered[0].displayContext?.launchDirectory).toBeUndefined();
          expect(registered[0].displayContext?.processDirectory).toBe(yield* fs.realPath(process.cwd()));
          expect(yield* fs.exists(file)).toBe(true);
        }),
      );
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  it.effect('accepts only bounded client display fields', () =>
    Effect.sync(() => {
      expect(sanitizeThreadnoteProcessClientInfo({name: 'Codex', version: '1', token: 'not-copied'})).toEqual({
        name: 'Codex',
        version: '1',
      });
      for (const name of ['unknown', '', 'bad\nname', EffectString.repeat(129)('x'), 12])
        expect(sanitizeThreadnoteProcessClientInfo({name})).toBeUndefined();
    }),
  );
});
