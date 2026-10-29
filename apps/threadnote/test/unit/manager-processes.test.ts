import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {join} from '@threadnote/testing/node-path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {expect, it} from '@effect/vitest';
import {Effect, FileSystem, Schema} from 'effect';
import {describe} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {handleManagerProcessRequest} from '@threadnote/threadnote/manager/processes';
import {readThreadnoteProcessDiagnostics} from '@threadnote/threadnote/process/diagnostics';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const ProcessListSchema = Schema.Struct({
  processes: Schema.Array(
    Schema.Struct({
      processId: Schema.Finite,
      processRef: Schema.optionalKey(Schema.String),
    }),
  ),
  truncated: Schema.optionalKey(Schema.Boolean),
});

function parseProcessList(value: unknown): {
  readonly processes: readonly {readonly processId: number; readonly processRef?: string}[];
  readonly truncated?: boolean;
} {
  if (!Schema.is(ProcessListSchema)(value)) throw new Error('Invalid Manager process list response.');
  return value;
}

describe('Manager process API', () => {
  it.effect('requires explicit confirmation before process termination', () =>
    Effect.gen(function* () {
      const response = yield* handleManagerProcessRequest({
        body: Effect.succeed({processId: 123, processRef: `tnp_${Effect2.pipe('a', EffectString.repeat(64))}`}),
        config: testConfig('/unused'),
        method: 'POST',
        url: new URL('http://localhost/api/processes/terminate'),
      });
      expect(response).toEqual({
        body: {
          code: 'confirmation-required',
          error: 'Confirm termination of the selected Threadnote process.',
          retryAfterMilliseconds: 0,
        },
        status: 400,
      });
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  it.effect('maps a stale opaque process target to a typed conflict without signaling', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-manager-process-stale-'});
      const processId = 1_234_601;
      yield* writeRegistration(fileSystem, home, processId, 'private-registration-token');
      let signals = 0;
      const testSystem = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: id => id === processId,
        processStartIdentity: () => Effect.succeed('identity-a'),
        signalProcess: () => {
          signals += 1;
        },
      });
      const response = yield* handleManagerProcessRequest({
        body: Effect.succeed({
          confirm: true,
          processId,
          processRef: `tnp_${Effect2.pipe('a', EffectString.repeat(64))}`,
        }),
        config: testConfig(home),
        method: 'POST',
        url: new URL('http://localhost/api/processes/terminate'),
      }).pipe(Effect.provideService(SystemInfo, testSystem));
      expect(response).toMatchObject({body: {code: 'process-stale'}, status: 409});
      expect(signals).toBe(0);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('returns a privacy-safe inventory and a successful exact-instance termination response', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-manager-process-success-'});
      const processId = 1_234_602;
      const token = 'private-success-registration-token';
      yield* writeRegistration(fileSystem, home, processId, token);
      let running = true;
      const signals: NodeJS.Signals[] = [];
      const testSystem = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: id => id === processId && running,
        processStartIdentity: () => Effect.succeed('identity-a'),
        signalProcess: (_id, signal) => {
          signals.push(signal);
          running = false;
        },
      });
      const config = testConfig(home);
      const listed = yield* handleManagerProcessRequest({
        body: Effect.succeed({}),
        config,
        method: 'GET',
        url: new URL('http://localhost/api/processes'),
      }).pipe(Effect.provideService(SystemInfo, testSystem));
      expect(listed).toBeDefined();
      expect(listed!.status).toBe(200);
      const serialized = JSON.stringify(listed!.body);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(home);
      const listBody = parseProcessList(listed!.body);
      const process = listBody.processes[0];
      expect(process).toMatchObject({processId, processRef: expect.stringMatching(/^tnp_[0-9a-f]{64}$/u)});

      const terminated = yield* handleManagerProcessRequest({
        body: Effect.succeed({confirm: true, processId, processRef: process.processRef}),
        config,
        method: 'POST',
        url: new URL('http://localhost/api/processes/terminate'),
      }).pipe(Effect.provideService(SystemInfo, testSystem));
      expect(terminated).toEqual({body: {processId, state: 'terminated'}, status: 200});
      expect(signals).toEqual(['SIGTERM']);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('retains active work when more than 100 older idle services truncate the Manager inventory', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-manager-process-attention-'});
      const idleProcessIds = Array.from({length: 100}, (_, index) => 1_235_000 + index);
      const activeProcessId = 1_235_100;
      yield* Effect.forEach(
        idleProcessIds,
        processId => writeRegistration(fileSystem, home, processId, `idle-token-${processId}`),
        {concurrency: 8},
      );
      yield* writeRegistration(fileSystem, home, activeProcessId, 'active-process-token', {
        baseRole: 'cli',
        currentOperation: 'index-repository',
        role: 'cli',
        startedAt: '2026-08-27T00:00:00.000Z',
      });
      const liveProcessIds = new Set([...idleProcessIds, activeProcessId]);
      const testSystem = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: processId => liveProcessIds.has(processId),
        processStartIdentity: () => Effect.succeed('identity-a'),
      });
      const config = testConfig(home);
      const listed = yield* handleManagerProcessRequest({
        body: Effect.succeed({}),
        config,
        method: 'GET',
        url: new URL('http://localhost/api/processes'),
      }).pipe(Effect.provideService(SystemInfo, testSystem));
      const managerInventory = parseProcessList(listed!.body);
      expect(managerInventory.truncated).toBe(true);
      expect(managerInventory.processes).toHaveLength(100);
      expect(managerInventory.processes[0]?.processId).toBe(activeProcessId);
      expect(EffectArray.some(managerInventory.processes, process => process.processId === activeProcessId)).toBe(true);

      const chronological = yield* readThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
        Effect.provideService(SystemInfo, testSystem),
      );
      expect(chronological.truncated).toBe(true);
      expect(chronological.processes).toHaveLength(100);
      expect(EffectArray.some(chronological.processes, process => process.processId === activeProcessId)).toBe(false);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );
});

function writeRegistration(
  fileSystem: FileSystem.FileSystem,
  home: string,
  processId: number,
  token: string,
  options: {
    readonly baseRole?: 'cli' | 'mcp';
    readonly currentOperation?: string;
    readonly role?: 'cli' | 'mcp';
    readonly startedAt?: string;
  } = {},
) {
  const startedAt = options.startedAt ?? '2026-08-12T00:00:00.000Z';
  return Effect.gen(function* () {
    const directory = join(home, 'runtime', 'processes');
    yield* fileSystem.makeDirectory(directory, {recursive: true});
    yield* fileSystem.writeFileString(
      join(directory, `${processId}.json`),
      `${JSON.stringify({
        baseRole: options.baseRole ?? 'mcp',
        currentOperation: options.currentOperation ?? 'mcp-server',
        parentProcessId: 42,
        processId,
        processStartIdentity: 'identity-a',
        role: options.role ?? 'mcp',
        schemaVersion: 1,
        startedAt,
        token,
        updatedAt: startedAt,
      })}\n`,
    );
  });
}

function testConfig(agentContextHome: string): RuntimeConfig {
  return {
    account: 'local',
    agentContextHome,
    agentId: 'threadnote',
    manifestPath: join(agentContextHome, 'manifest.yaml'),
    user: 'test',
  };
}
