import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp, fcProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {succeedUndefined} from '@threadnote/platform/optional';
import {mkdtemp, readFile, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import * as BunServices from '@effect/platform-bun/BunServices';
import {expect, it} from '@effect/vitest';
import {Clock, Deferred, Duration, Effect, Fiber, FileSystem, PlatformError, Queue} from 'effect';
import {TestClock, TestConsole} from 'effect/testing';
import * as FC from 'fast-check';
import {afterEach, beforeEach, describe} from 'vitest';
import {SystemInfo} from '@threadnote/platform/system';
import {CODE_GRAPH_COMPACTION_WORKER_ARGUMENT} from '@threadnote/threadnote/worker_protocol';
import {
  readManageableThreadnoteProcessDiagnostics,
  readThreadnoteProcessDiagnostics,
  legacyProcessDoctorCheck,
  renderProcessDiagnosticsTable,
  terminateThreadnoteProcess,
  ThreadnoteProcessTerminationError,
  threadnoteHomeForProcess,
  withThreadnoteProcessActivity,
  withThreadnoteProcessRegistration,
} from '@threadnote/threadnote/process/diagnostics';

let temporaryRoot: string | undefined;
let installationTemporaryRoot: string | undefined;
let previousInstallationRoot: string | undefined;

beforeEach(async () => {
  previousInstallationRoot = process.env.THREADNOTE_INSTALL_ROOT;
  installationTemporaryRoot = await mkdtemp(join(tmpdir(), 'threadnote-process-installation-'));
  process.env.THREADNOTE_INSTALL_ROOT = installationTemporaryRoot;
});

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, {force: true, recursive: true});
  if (installationTemporaryRoot) await rm(installationTemporaryRoot, {force: true, recursive: true});
  if (previousInstallationRoot === undefined) delete process.env.THREADNOTE_INSTALL_ROOT;
  else process.env.THREADNOTE_INSTALL_ROOT = previousInstallationRoot;
  temporaryRoot = undefined;
  installationTemporaryRoot = undefined;
  previousInstallationRoot = undefined;
});

function testRegistration(
  processId: number,
  role: 'graph-parser-worker' | 'mcp',
  processStartIdentity: string,
  token: string,
) {
  return {
    baseRole: role,
    currentOperation: role === 'mcp' ? 'mcp-server' : 'parser-stdio',
    parentProcessId: 42,
    processId,
    processStartIdentity,
    role,
    schemaVersion: 1,
    startedAt: '2026-08-12T00:00:00.000Z',
    token,
    updatedAt: '2026-08-12T00:00:00.000Z',
  } as const;
}

describe('process diagnostics', () => {
  it.effect('warns once on repeated unsupported publication and repairs when support returns', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-registration-unsupported-'});
      const file = join(home, 'runtime', 'processes', `${process.pid}.json`);
      const attempts = yield* Queue.unbounded<void>();
      let supported = false;
      const flaky = FileSystem.FileSystem.of({
        ...fs,
        link: (from, to) =>
          supported
            ? fs.link(from, to)
            : Effect.fail(
                PlatformError.systemError({
                  _tag: 'Unknown',
                  module: 'FileSystem',
                  method: 'link',
                  description: 'ENOTSUP',
                }),
              ),
        remove: (path, options) =>
          fs
            .remove(path, options)
            .pipe(Effect.tap(() => (path.endsWith('.tmp') ? Queue.offer(attempts, undefined) : Effect.void))),
      });
      yield* withThreadnoteProcessRegistration(
        home,
        'mcp',
        Effect.gen(function* () {
          // Initial publication is attempt one; a failed startup still retains the repair loop.
          yield* Queue.take(attempts);
          for (let attempt = 0; attempt < 2; attempt += 1) {
            yield* TestClock.adjust(30_000);
            yield* Queue.take(attempts);
          }
          expect(yield* TestConsole.errorLines).toEqual([expect.stringContaining('process registration')]);
          supported = true;
          yield* TestClock.adjust(30_000);
          yield* Queue.take(attempts);
          expect(JSON.parse(yield* fs.readFileString(file))).toMatchObject({processId: process.pid, role: 'mcp'});
          yield* fs.remove(file);
          supported = false;
          for (let attempt = 0; attempt < 4; attempt += 1) {
            yield* TestClock.adjust(30_000);
            yield* Queue.take(attempts);
          }
          expect(yield* TestConsole.errorLines).toHaveLength(1);
          supported = true;
          yield* TestClock.adjust(30_000);
          yield* Queue.take(attempts);
          expect(yield* fs.exists(file)).toBe(true);
        }),
      ).pipe(Effect.provideService(FileSystem.FileSystem, flaky));
      expect(yield* fs.exists(file)).toBe(false);
    }).pipe(
      provideTestLayer(TestSystemInfoLayer),
      provideTestLayer(BunServices.layer),
      provideTestLayer(TestConsole.layer),
    ),
  );

  it.effect('binds a process reference to the same registration snapshot as the displayed row', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-process-snapshot-'});
      const processId = 1_234_501;
      const registrationPath = join(home, 'runtime', 'processes', `${processId}.json`);
      const first = testRegistration(processId, 'mcp', 'identity-a', 'first-registration-token');
      const replacement = testRegistration(processId, 'graph-parser-worker', 'identity-a', 'replacement-token-value');
      yield* fileSystem.makeDirectory(join(home, 'runtime', 'processes'), {recursive: true});
      yield* fileSystem.writeFileString(registrationPath, `${JSON.stringify(first)}\n`);
      let replaced = false;
      let signals = 0;
      const replacingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        readFileString: (file, encoding) =>
          fileSystem.readFileString(file, encoding).pipe(
            Effect.tap(() => {
              if (file !== registrationPath || replaced) return Effect.void;
              replaced = true;
              return fileSystem.writeFileString(registrationPath, `${JSON.stringify(replacement)}\n`);
            }),
          ),
      });
      const testSystem = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: id => id === processId,
        processStartIdentity: () => Effect.succeed('identity-a'),
        signalProcess: () => {
          signals += 1;
        },
      });

      const listed = yield* readManageableThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
        Effect.provideService(FileSystem.FileSystem, replacingFileSystem),
        Effect.provideService(SystemInfo, testSystem),
      );
      expect(listed.processes[0]).toMatchObject({processId, role: 'mcp', terminable: true});
      expect(listed.processes[0]?.processRef).toMatch(/^tnp_[0-9a-f]{64}$/u);
      const outcome = yield* terminateThreadnoteProcess(
        {agentContextHome: home},
        {processId, processRef: listed.processes[0].processRef!},
        {forceWaitMilliseconds: 0, gracefulWaitMilliseconds: 0},
      ).pipe(
        Effect.provideService(SystemInfo, testSystem),
        Effect.match({onFailure: error => ({error}), onSuccess: value => ({value})}),
      );
      expect('error' in outcome ? outcome.error : undefined).toMatchObject({code: 'process-stale'});
      expect(signals).toBe(0);
      expect(JSON.stringify(listed)).not.toContain(first.token);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('does not signal when process identity changes between target resolution and signal', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-process-signal-race-'});
      const processId = 1_234_502;
      const registration = testRegistration(processId, 'mcp', 'identity-a', 'signal-race-token-value');
      yield* fileSystem.makeDirectory(join(home, 'runtime', 'processes'), {recursive: true});
      yield* fileSystem.writeFileString(
        join(home, 'runtime', 'processes', `${processId}.json`),
        `${JSON.stringify(registration)}\n`,
      );
      let terminating = false;
      let identityReads = 0;
      let signals = 0;
      const testSystem = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: id => id === processId,
        processStartIdentity: () => {
          identityReads += 1;
          return Effect.succeed(terminating && identityReads >= 2 ? 'replacement-identity' : 'identity-a');
        },
        signalProcess: () => {
          signals += 1;
        },
      });
      const listed = yield* readManageableThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
        Effect.provideService(SystemInfo, testSystem),
      );
      identityReads = 0;
      terminating = true;
      const outcome = yield* terminateThreadnoteProcess(
        {agentContextHome: home},
        {processId, processRef: listed.processes[0].processRef!},
        {forceWaitMilliseconds: 0, gracefulWaitMilliseconds: 0},
      ).pipe(
        Effect.provideService(SystemInfo, testSystem),
        Effect.match({onFailure: error => ({error}), onSuccess: value => ({value})}),
      );
      expect('error' in outcome ? outcome.error : undefined).toBeInstanceOf(ThreadnoteProcessTerminationError);
      expect('error' in outcome ? outcome.error : undefined).toMatchObject({code: 'process-stale'});
      expect(signals).toBe(0);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('does not force-signal a replacement that appears after the graceful signal', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-process-force-race-'});
      const processId = 1_234_503;
      const registration = testRegistration(processId, 'mcp', 'identity-a', 'force-race-token-value');
      yield* fileSystem.makeDirectory(join(home, 'runtime', 'processes'), {recursive: true});
      yield* fileSystem.writeFileString(
        join(home, 'runtime', 'processes', `${processId}.json`),
        `${JSON.stringify(registration)}\n`,
      );
      let terminating = false;
      let identityReads = 0;
      const signals: NodeJS.Signals[] = [];
      const testSystem = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: id => id === processId,
        processStartIdentity: () => {
          identityReads += 1;
          return Effect.succeed(terminating && identityReads >= 5 ? 'replacement-identity' : 'identity-a');
        },
        signalProcess: (_id, signal) => {
          signals.push(signal);
        },
      });
      const listed = yield* readManageableThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
        Effect.provideService(SystemInfo, testSystem),
      );
      identityReads = 0;
      terminating = true;
      const outcome = yield* terminateThreadnoteProcess(
        {agentContextHome: home},
        {processId, processRef: listed.processes[0].processRef!},
        {forceWaitMilliseconds: 0, gracefulWaitMilliseconds: 0},
      ).pipe(
        Effect.provideService(SystemInfo, testSystem),
        Effect.match({onFailure: error => ({error}), onSuccess: value => ({value})}),
      );
      expect('error' in outcome ? outcome.error : undefined).toMatchObject({code: 'process-stale'});
      expect(signals).toEqual(['SIGTERM']);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('protects the current Manager process before reading or signaling a target', () =>
    Effect.gen(function* () {
      const nativeSystem = yield* SystemInfo;
      let signals = 0;
      const processId = 1_234_504;
      const testSystem = SystemInfo.of({
        ...nativeSystem,
        processId,
        signalProcess: () => {
          signals += 1;
        },
      });
      const outcome = yield* terminateThreadnoteProcess(
        {agentContextHome: '/unused'},
        {processId, processRef: `tnp_${'a'.repeat(64)}`},
      ).pipe(
        Effect.provideService(SystemInfo, testSystem),
        Effect.match({onFailure: error => ({error}), onSuccess: value => ({value})}),
      );
      expect('error' in outcome ? outcome.error : undefined).toMatchObject({code: 'current-manager'});
      expect(signals).toBe(0);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  it.effect(
    'keeps a live MCP registration when the observer locale no longer matches the stored Darwin start string',
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const nativeSystem = yield* SystemInfo;
        const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-process-locale-keep-'});
        const processId = 1_234_510;
        const registrationPath = join(home, 'runtime', 'processes', `${processId}.json`);
        const stored = testRegistration(processId, 'mcp', 'darwin:Thu Sep 10 16:44:09 2026', 'locale-keep-token-value');
        yield* fileSystem.makeDirectory(join(home, 'runtime', 'processes'), {recursive: true});
        yield* fileSystem.writeFileString(registrationPath, `${JSON.stringify(stored)}\n`);
        const testSystem = SystemInfo.of({
          ...nativeSystem,
          isProcessRunning: id => id === processId,
          canonicalProcessStartIdentity: () => Effect.succeed('darwin-v2:Thu Sep 10 14:44:09 2026'),
          processStartIdentity: () => Effect.succeed('darwin:Thu 10 Sep 16:44:09 2026'),
        });
        const listed = yield* readThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
          Effect.provideService(SystemInfo, testSystem),
        );
        expect(listed.processes).toEqual([expect.objectContaining({processId, role: 'mcp'})]);
        expect(yield* fileSystem.exists(registrationPath)).toBe(true);
        expect(JSON.parse(yield* fileSystem.readFileString(registrationPath))).toMatchObject({
          processId,
          processStartIdentity: 'darwin-v2:Thu Sep 10 14:44:09 2026',
        });
      }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('keeps a live MCP registration when canonical observation is unread and locale observation disagrees', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-process-canonical-unread-keep-'});
      const processId = 1_234_512;
      const registrationPath = join(home, 'runtime', 'processes', `${processId}.json`);
      const stored = testRegistration(
        processId,
        'mcp',
        'darwin-v2:Thu Sep 10 16:19:47 2026',
        'canonical-unread-keep-token',
      );
      yield* fileSystem.makeDirectory(join(home, 'runtime', 'processes'), {recursive: true});
      yield* fileSystem.writeFileString(registrationPath, `${JSON.stringify(stored)}\n`);
      const testSystem = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: id => id === processId,
        canonicalProcessStartIdentity: () => succeedUndefined,
        processStartIdentity: () => Effect.succeed('darwin:Thu 10 Sep 18:19:47 2026'),
      });
      const listed = yield* readThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
        Effect.provideService(SystemInfo, testSystem),
      );
      expect(listed.processes).toEqual([expect.objectContaining({processId, role: 'mcp'})]);
      expect(yield* fileSystem.exists(registrationPath)).toBe(true);
      expect(JSON.parse(yield* fileSystem.readFileString(registrationPath))).toMatchObject({
        processId,
        processStartIdentity: 'darwin:Thu 10 Sep 18:19:47 2026',
      });
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('restores a live registration file without activity after inventory garbage-collected it', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-process-restore-registration-'});
      const config = {agentContextHome: home};
      const registrationPath = join(home, 'runtime', 'processes', `${process.pid}.json`);
      const publications = yield* Queue.unbounded<void>();
      const observedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        link: (source, destination) =>
          fileSystem
            .link(source, destination)
            .pipe(
              Effect.tap(() => (destination === registrationPath ? Queue.offer(publications, undefined) : Effect.void)),
            ),
      });
      yield* withThreadnoteProcessRegistration(
        home,
        'mcp',
        Effect.gen(function* () {
          yield* Queue.take(publications);
          expect(yield* fileSystem.exists(registrationPath)).toBe(true);
          yield* fileSystem.remove(registrationPath);
          expect(yield* fileSystem.exists(registrationPath)).toBe(false);
          yield* TestClock.adjust(30_000);
          yield* Queue.take(publications);
          expect(yield* fileSystem.exists(registrationPath)).toBe(true);
          const listed = yield* readThreadnoteProcessDiagnostics(config);
          expect(listed.processes).toEqual([expect.objectContaining({processId: process.pid, role: 'mcp'})]);
        }),
        'mcp-server',
      ).pipe(Effect.provideService(FileSystem.FileSystem, observedFileSystem));
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('preserves a foreign registration during idle repair, activity changes, and cleanup', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-process-foreign-registration-'});
      const file = join(home, 'runtime', 'processes', `${process.pid}.json`);
      let foreign = '';
      yield* withThreadnoteProcessRegistration(
        home,
        'mcp',
        Effect.gen(function* () {
          foreign = JSON.stringify({
            ...JSON.parse(yield* fs.readFileString(file)),
            token: 'foreign-registration-token',
          });
          yield* fs.writeFileString(file, foreign);
          yield* TestClock.adjust(30_000);
          yield* withThreadnoteProcessActivity('graph-builder', 'build', Effect.void);
          expect(yield* fs.readFileString(file)).toBe(foreign);
        }),
      );
      expect(yield* fs.readFileString(file)).toBe(foreign);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  it.effect.each([false, true])('does not reacquire a removed foreign or invalid registration (%s)', invalid =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-registration-lost-'});
      const file = join(home, 'runtime', 'processes', `${process.pid}.json`);
      const observed = yield* Deferred.make<void>();
      let watching = false;
      const observedFs = FileSystem.FileSystem.of({
        ...fs,
        readFileString: (path, encoding) =>
          fs
            .readFileString(path, encoding)
            .pipe(Effect.tap(() => (path === file && watching ? Deferred.succeed(observed, undefined) : Effect.void))),
      });
      yield* withThreadnoteProcessRegistration(
        home,
        'mcp',
        Effect.gen(function* () {
          const original = JSON.parse(yield* fs.readFileString(file));
          yield* fs.writeFileString(file, invalid ? '{}' : JSON.stringify({...original, token: 'foreign-owner-token'}));
          watching = true;
          yield* TestClock.adjust(30_000);
          yield* Deferred.await(observed);
          yield* fs.remove(file);
          for (let tick = 0; tick < 3; tick += 1) {
            yield* TestClock.adjust(30_000);
            yield* withThreadnoteProcessActivity('graph-builder', 'build', Effect.void);
            expect(yield* fs.exists(file)).toBe(false);
          }
        }),
      ).pipe(Effect.provideService(FileSystem.FileSystem, observedFs));
      expect(yield* fs.exists(file)).toBe(false);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  it.effect('reclaims a startup row only when its process identity is provably stale', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-registration-stale-startup-'});
      const file = join(home, 'runtime', 'processes', `${process.pid}.json`);
      yield* fs.makeDirectory(join(home, 'runtime', 'processes'), {recursive: true});
      yield* fs.writeFileString(
        file,
        JSON.stringify(testRegistration(process.pid, 'mcp', 'old-instance', 'old-instance-token')),
      );
      const system = SystemInfo.of({
        ...nativeSystem,
        canonicalProcessStartIdentity: () => Effect.succeed('current-instance'),
        processStartIdentity: () => Effect.succeed('current-instance'),
      });
      yield* withThreadnoteProcessRegistration(
        home,
        'mcp',
        Effect.gen(function* () {
          const restored = JSON.parse(yield* fs.readFileString(file));
          expect(restored.processStartIdentity).toBe('current-instance');
          expect(restored.token).not.toBe('old-instance-token');
        }),
      ).pipe(Effect.provideService(SystemInfo, system));
      expect(yield* fs.exists(file)).toBe(false);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  it.effect.each(['current-instance', undefined])(
    'preserves startup ownership with same or unknown identity (%s)',
    identity =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const nativeSystem = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-registration-owned-startup-'});
        const file = join(home, 'runtime', 'processes', `${process.pid}.json`);
        const foreign = JSON.stringify(
          testRegistration(process.pid, 'mcp', 'current-instance', 'foreign-instance-token'),
        );
        yield* fs.makeDirectory(join(home, 'runtime', 'processes'), {recursive: true});
        yield* fs.writeFileString(file, foreign);
        const system = SystemInfo.of({
          ...nativeSystem,
          canonicalProcessStartIdentity: () => Effect.succeed(identity),
          processStartIdentity: () => Effect.succeed(identity),
        });
        yield* withThreadnoteProcessRegistration(
          home,
          'mcp',
          Effect.gen(function* () {
            yield* withThreadnoteProcessActivity('graph-builder', 'build', Effect.void);
            expect(yield* fs.readFileString(file)).toBe(foreign);
            yield* fs.remove(file);
            yield* TestClock.adjust(60_000);
            yield* withThreadnoteProcessActivity('graph-builder', 'build', Effect.void);
            expect(yield* fs.exists(file)).toBe(false);
          }),
        ).pipe(Effect.provideService(SystemInfo, system));
      }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  fcEffectProp(
    it,
    'does not overwrite a foreign row replacing the stale startup inode during reclamation',
    {foreignToken: FC.string({maxLength: 60, minLength: 16})},
    ({foreignToken}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const nativeSystem = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-registration-startup-race-'});
        const file = join(home, 'runtime', 'processes', `${process.pid}.json`);
        const displaced = `${file}.displaced`;
        const foreign = JSON.stringify(testRegistration(process.pid, 'mcp', 'current-instance', foreignToken));
        yield* fs.makeDirectory(join(home, 'runtime', 'processes'), {recursive: true});
        yield* fs.writeFileString(
          file,
          JSON.stringify(testRegistration(process.pid, 'mcp', 'old-instance', 'old-instance-token')),
        );
        const interlocked = FileSystem.FileSystem.of({
          ...fs,
          rename: (oldPath, newPath) =>
            Effect.gen(function* () {
              if (oldPath === file) {
                yield* fs.rename(oldPath, displaced);
                yield* fs.writeFileString(oldPath, foreign);
              }
              yield* fs.rename(oldPath, newPath);
            }),
        });
        const system = SystemInfo.of({
          ...nativeSystem,
          canonicalProcessStartIdentity: () => Effect.succeed('current-instance'),
          processStartIdentity: () => Effect.succeed('current-instance'),
        });
        yield* withThreadnoteProcessRegistration(
          home,
          'mcp',
          Effect.gen(function* () {
            expect(yield* fs.readFileString(file)).toBe(foreign);
            yield* fs.remove(file);
            yield* TestClock.adjust(60_000);
            yield* withThreadnoteProcessActivity('graph-builder', 'build', Effect.void);
            expect(yield* fs.exists(file)).toBe(false);
          }),
        ).pipe(Effect.provideService(SystemInfo, system), Effect.provideService(FileSystem.FileSystem, interlocked));
      }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
    {fastCheck: {numRuns: 20}},
  );

  it.effect('does not publish after the captured startup quarantine disappears', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-registration-missing-quarantine-'});
      const file = join(home, 'runtime', 'processes', `${process.pid}.json`);
      let removedQuarantine = false;
      yield* fs.makeDirectory(join(home, 'runtime', 'processes'), {recursive: true});
      yield* fs.writeFileString(
        file,
        JSON.stringify(testRegistration(process.pid, 'mcp', 'old-instance', 'old-instance-token')),
      );
      const interlocked = FileSystem.FileSystem.of({
        ...fs,
        readFileString: (path, encoding) =>
          Effect.gen(function* () {
            if (path.endsWith('.reclaim')) {
              removedQuarantine = true;
              yield* fs.remove(path);
            }
            return yield* fs.readFileString(path, encoding);
          }),
      });
      const system = SystemInfo.of({
        ...nativeSystem,
        canonicalProcessStartIdentity: () => Effect.succeed('current-instance'),
        processStartIdentity: () => Effect.succeed('current-instance'),
      });
      yield* withThreadnoteProcessRegistration(
        home,
        'mcp',
        Effect.gen(function* () {
          expect(removedQuarantine).toBe(true);
          expect(yield* fs.exists(file)).toBe(false);
          yield* withThreadnoteProcessActivity('graph-builder', 'build', Effect.void);
          expect(yield* fs.exists(file)).toBe(false);
        }),
      ).pipe(Effect.provideService(SystemInfo, system), Effect.provideService(FileSystem.FileSystem, interlocked));
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  it.effect('retries idle registration repair after a transient filesystem failure', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const clock = yield* Clock.Clock;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-process-registration-retry-'});
      const file = join(home, 'runtime', 'processes', `${process.pid}.json`);
      let fail = false;
      const attempts = yield* Queue.unbounded<'failed' | 'published'>();
      const reconcileSleeps = yield* Queue.unbounded<void>();
      const observedClock: Clock.Clock = {
        ...clock,
        sleep: duration =>
          Effect.gen(function* () {
            const fiber = yield* clock.sleep(duration).pipe(Effect.forkChild({startImmediately: true}));
            if (Duration.toMillis(duration) === 30_000) yield* Queue.offer(reconcileSleeps, undefined);
            yield* Fiber.join(fiber);
          }),
      };
      const flaky = FileSystem.FileSystem.of({
        ...fs,
        makeDirectory: (directory, options) => {
          if (fail) {
            return Queue.offer(attempts, 'failed').pipe(
              Effect.andThen(fs.makeDirectory(`${file}/missing`, {recursive: false})),
            );
          }
          return fs.makeDirectory(directory, options);
        },
        link: (source, destination) =>
          fs
            .link(source, destination)
            .pipe(Effect.tap(() => (destination === file ? Queue.offer(attempts, 'published') : Effect.void))),
      });
      yield* withThreadnoteProcessRegistration(
        home,
        'mcp',
        Effect.gen(function* () {
          expect(yield* Queue.take(attempts)).toBe('published');
          yield* Queue.take(reconcileSleeps);
          yield* fs.remove(file);
          fail = true;
          yield* TestClock.adjust(30_000);
          expect(yield* Queue.take(attempts)).toBe('failed');
          fail = false;
          yield* Queue.take(reconcileSleeps);
          yield* TestClock.adjust(30_000);
          expect(yield* Queue.take(attempts)).toBe('published');
          expect(JSON.parse(yield* fs.readFileString(file))).toMatchObject({processId: process.pid, role: 'mcp'});
        }),
      ).pipe(Effect.provideService(Clock.Clock, observedClock), Effect.provideService(FileSystem.FileSystem, flaky));
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  it.effect('removes a registration when the canonical process instance has been replaced', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-process-canonical-stale-'});
      const processId = 1_234_511;
      const registrationPath = join(home, 'runtime', 'processes', `${processId}.json`);
      const stored = testRegistration(
        processId,
        'mcp',
        'darwin-v2:Thu Sep 10 14:44:09 2026',
        'canonical-stale-token-value',
      );
      yield* fileSystem.makeDirectory(join(home, 'runtime', 'processes'), {recursive: true});
      yield* fileSystem.writeFileString(registrationPath, `${JSON.stringify(stored)}\n`);
      const testSystem = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: id => id === processId,
        canonicalProcessStartIdentity: () => Effect.succeed('darwin-v2:Thu Sep 10 15:00:00 2026'),
        processStartIdentity: () => Effect.succeed('darwin:Thu Sep 10 16:44:09 2026'),
      });
      const listed = yield* readThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
        Effect.provideService(SystemInfo, testSystem),
      );
      expect(listed.processes).toEqual([]);
      expect(yield* fileSystem.exists(registrationPath)).toBe(false);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('reports termination after the exact registered process exits on SIGTERM', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-process-terminate-'});
      const processId = 1_234_505;
      const registration = testRegistration(processId, 'mcp', 'identity-a', 'terminate-token-value');
      yield* fileSystem.makeDirectory(join(home, 'runtime', 'processes'), {recursive: true});
      yield* fileSystem.writeFileString(
        join(home, 'runtime', 'processes', `${processId}.json`),
        `${JSON.stringify(registration)}\n`,
      );
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
      const listed = yield* readManageableThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
        Effect.provideService(SystemInfo, testSystem),
      );
      const result = yield* terminateThreadnoteProcess(
        {agentContextHome: home},
        {processId, processRef: listed.processes[0].processRef!},
        {gracefulWaitMilliseconds: 0},
      ).pipe(Effect.provideService(SystemInfo, testSystem));
      expect(result).toEqual({processId, state: 'terminated'});
      expect(signals).toEqual(['SIGTERM']);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.live('registers the signal-transparent compaction worker under its Manager parent', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-compaction-process-'});
      yield* withThreadnoteProcessRegistration(
        home,
        'manager',
        Effect.acquireUseRelease(
          Effect.sync(() =>
            Bun.spawn({
              cmd: [process.execPath, 'apps/threadnote/src/standalone.ts', CODE_GRAPH_COMPACTION_WORKER_ARGUMENT],
              cwd: process.cwd(),
              env: {...process.env, THREADNOTE_HOME: home},
              stderr: 'pipe',
              stdin: 'pipe',
              stdout: 'pipe',
            }),
          ),
          child =>
            Effect.gen(function* () {
              const registrationPath = join(home, 'runtime', 'processes', `${child.pid}.json`);
              // Startup can include process identity probes with five-second deadlines.
              const deadline = (yield* Clock.currentTimeMillis) + 15_000;
              while (!(yield* fileSystem.exists(registrationPath)) && (yield* Clock.currentTimeMillis) < deadline) {
                expect(child.exitCode, 'Compaction worker exited before registration').toBeNull();
                yield* Effect.sleep(25);
              }
              expect(yield* fileSystem.exists(registrationPath)).toBe(true);
              const diagnostics = yield* readThreadnoteProcessDiagnostics({agentContextHome: home});
              expect(diagnostics.processes).toContainEqual(
                expect.objectContaining({
                  currentOperation: 'compact-graph-storage',
                  parentProcessId: process.pid,
                  parentRole: 'manager',
                  processId: child.pid,
                  role: 'graph-compaction-worker',
                }),
              );
              child.kill('SIGTERM');
              yield* Effect.promise(() => child.exited);
            }),
          child =>
            Effect.sync(() => {
              if (child.exitCode === null) child.kill('SIGKILL');
            }),
        ),
        'manager-ui',
      );
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it('aligns operation values with their header when preceding cells have different widths', () => {
    expect(
      renderProcessDiagnosticsTable([
        {
          ageMilliseconds: (12 * 60 * 60 + 55 * 60) * 1_000,
          currentOperation: 'mcp-server',
          parentProcessId: 42_478,
          processId: 79_155,
          releaseVersion: '4.0.3',
          role: 'mcp',
          rssBytes: 138.2 * 1024 * 1024,
          startedAt: '2026-08-04T00:00:00.000Z',
        },
        {
          ageMilliseconds: (44 * 60 + 23) * 1_000,
          currentOperation: 'repair',
          parentProcessId: 1_100,
          processId: 71_873,
          releaseVersion: '4.0.3',
          role: 'cli',
          rssBytes: 78 * 1024 * 1024,
          startedAt: '2026-08-05T00:00:00.000Z',
        },
      ]),
    ).toBe(
      [
        'PID    PPID   ROLE  VERSION  AGE     RSS        OPERATION',
        '79155  42478  mcp   4.0.3    12h55m  138.2 MiB  mcp-server',
        '71873  1100   cli   4.0.3    44m23s  78.0 MiB   repair',
      ].join('\n'),
    );
  });

  it('qualifies a process identity with the graph activity it is currently performing', () => {
    expect(
      renderProcessDiagnosticsTable([
        {
          activityRole: 'graph-builder',
          ageMilliseconds: (5 * 60 * 60 + 3 * 60) * 1_000,
          currentOperation: 'index-repository',
          parentProcessId: 23_265,
          processId: 27_543,
          releaseVersion: '4.0.6',
          role: 'cli',
          rssBytes: 746.4 * 1024 * 1024,
          startedAt: '2026-08-05T00:00:00.000Z',
        },
        {
          activityRole: 'graph-waiter',
          ageMilliseconds: 12 * 1_000,
          currentOperation: 'repository-lock',
          parentProcessId: 36_027,
          processId: 37_407,
          releaseVersion: '4.0.6',
          role: 'mcp',
          rssBytes: 685 * 1024 * 1024,
          startedAt: '2026-08-05T00:00:01.000Z',
        },
        {
          ageMilliseconds: 30 * 1_000,
          currentOperation: 'embed-many',
          parentProcessId: 27_543,
          processId: 51_730,
          releaseVersion: '4.0.6',
          role: 'local-model-worker',
          rssBytes: 634.1 * 1024 * 1024,
          startedAt: '2026-08-05T00:00:02.000Z',
        },
      ]),
    ).toBe(
      [
        'PID    PPID   ROLE                 VERSION  AGE   RSS        OPERATION',
        '27543  23265  cli (graph-builder)  4.0.6    5h3m  746.4 MiB  index-repository',
        '37407  36027  mcp (graph-waiter)   4.0.6    12s   685.0 MiB  repository-lock',
        '51730  27543  local-model-worker   4.0.6    30s   634.1 MiB  embed-many',
      ].join('\n'),
    );
  });

  fcProp(
    it,
    'keeps every operation value under its header for arbitrary preceding column widths',
    {
      processes: FC.array(
        FC.record({
          activityRole: FC.option(FC.constantFrom('graph-builder' as const, 'graph-waiter' as const), {nil: undefined}),
          ageMilliseconds: FC.integer({max: 14 * 24 * 60 * 60 * 1_000, min: 0}),
          currentOperation: FC.option(
            FC.constantFrom('diagnostics', 'index-repository', 'mcp-server', 'repair', 'repository-lock'),
            {nil: undefined},
          ),
          parentProcessId: FC.integer({max: 9_999_999, min: 0}),
          processId: FC.integer({max: 9_999_999, min: 1}),
          releaseVersion: FC.option(
            FC.constantFrom('4.0.3', '4.0.3-local.g0123456789abcdef0123456789abcdef01234567', 'unknown-build'),
            {nil: undefined},
          ),
          role: FC.constantFrom(
            'cli' as const,
            'graph-builder' as const,
            'graph-parser-worker' as const,
            'graph-waiter' as const,
            'legacy' as const,
            'local-model-worker' as const,
            'manager' as const,
            'mcp' as const,
          ),
          rssBytes: FC.option(FC.integer({max: 8 * 1024 * 1024 * 1024, min: 0}), {nil: undefined}),
          startedAt: FC.constant('2026-08-05T00:00:00.000Z'),
        }),
        {maxLength: 30, minLength: 1},
      ),
    },
    ({processes}) => {
      const lines = renderProcessDiagnosticsTable(processes).split('\n');
      const operationColumn = lines[0].indexOf('OPERATION');
      const roleColumn = lines[0].indexOf('ROLE');

      expect(operationColumn).toBeGreaterThan(0);
      expect(lines).toHaveLength(processes.length + 1);
      for (const [index, process] of processes.entries()) {
        expect(lines[index + 1].slice(operationColumn)).toBe(process.currentOperation ?? '-');
        // A nested activity qualifies the identity it runs under; it never replaces it.
        expect(lines[index + 1].slice(roleColumn)).toMatch(new RegExp(`^${process.role}(?: \\(|\\s|$)`));
      }
    },
    {fastCheck: {numRuns: 200}},
  );

  it.effect('reports a validated pre-registry release lease without exposing its private fields', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-legacy-process-home-'});
      const legacyProcessId = 1_234_567;
      const legacyVersion = '4.0.0-beta.19';
      const leasePath = join(installationTemporaryRoot!, 'leases', legacyVersion, `${legacyProcessId}.json`);
      yield* fileSystem.makeDirectory(join(installationTemporaryRoot!, 'leases', legacyVersion), {recursive: true});
      yield* fileSystem.writeFileString(
        leasePath,
        `${JSON.stringify({
          executable: '/private/repository/path/threadnote',
          parentProcessId: 7654,
          processId: legacyProcessId,
          processStartIdentity: 'matching-process-identity',
          startedAt: '2026-08-01T00:00:00.000Z',
          token: 'private-ownership-token',
          version: legacyVersion,
        })}\n`,
      );
      const olderVersion = '4.0.0-beta.18';
      const olderLeaseDirectory = join(installationTemporaryRoot!, 'leases', olderVersion);
      yield* fileSystem.makeDirectory(olderLeaseDirectory, {recursive: true});
      yield* fileSystem.writeFileString(
        join(olderLeaseDirectory, `${legacyProcessId}.json`),
        `${JSON.stringify({
          processId: legacyProcessId,
          processStartIdentity: 'matching-process-identity',
          startedAt: '2026-08-01T00:00:00.000Z',
          token: 'older-private-ownership-token',
          version: olderVersion,
        })}\n`,
      );
      const forgedRegistryPath = join(home, 'runtime', 'processes', `${legacyProcessId}.json`);
      yield* fileSystem.makeDirectory(join(home, 'runtime', 'processes'), {recursive: true});
      yield* fileSystem.writeFileString(
        forgedRegistryPath,
        `${JSON.stringify({
          baseRole: 'legacy',
          parentProcessId: 7654,
          processId: legacyProcessId,
          role: 'legacy',
          schemaVersion: 1,
          startedAt: '2026-08-01T00:00:00.000Z',
          token: 'not-a-valid-current-registry-role',
          updatedAt: '2026-08-01T00:00:00.000Z',
        })}\n`,
      );
      const testSystem = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: processId => processId === legacyProcessId,
        processStartIdentity: processId =>
          Effect.succeed(processId === legacyProcessId ? 'matching-process-identity' : undefined),
      });

      const diagnostics = yield* readThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
        Effect.provideService(SystemInfo, testSystem),
      );
      const doctor = yield* legacyProcessDoctorCheck({agentContextHome: home}).pipe(
        Effect.provideService(SystemInfo, testSystem),
      );
      expect(diagnostics.processes).toEqual([
        expect.objectContaining({
          parentProcessId: 7654,
          processId: legacyProcessId,
          releaseVersion: legacyVersion,
          role: 'legacy',
        }),
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain('private-ownership-token');
      expect(JSON.stringify(diagnostics)).not.toContain('/private/repository/path');
      expect(doctor).toMatchObject({status: 'warn'});
      expect(doctor.detail).toContain(legacyVersion);
      expect(yield* fileSystem.exists(forgedRegistryPath)).toBe(false);

      const reusedPidSystem = SystemInfo.of({
        ...testSystem,
        processStartIdentity: () => Effect.succeed('replacement-process-identity'),
      });
      expect(
        (yield* readThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
          Effect.provideService(SystemInfo, reusedPidSystem),
        )).processes,
      ).toEqual([]);
      expect(yield* fileSystem.exists(leasePath)).toBe(false);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('does not report a process that registers while its release lease snapshot is being read', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nativeSystem = yield* SystemInfo;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-registering-process-home-'});
      const processId = 1_234_568;
      const version = '4.4.1-local.g0123456789abcdef0123456789abcdef01234567';
      const leaseDirectory = join(installationTemporaryRoot!, 'leases', version);
      const registrationDirectory = join(home, 'runtime', 'processes');
      const registrationPath = join(registrationDirectory, `${processId}.json`);
      yield* fileSystem.makeDirectory(leaseDirectory, {recursive: true});
      yield* fileSystem.makeDirectory(registrationDirectory, {recursive: true});
      yield* fileSystem.writeFileString(
        join(leaseDirectory, `${processId}.json`),
        `${JSON.stringify({
          parentProcessId: 7654,
          processId,
          processStartIdentity: 'matching-process-identity',
          startedAt: '2026-08-27T00:00:00.000Z',
          token: 'private-ownership-token',
          version,
        })}\n`,
      );

      let registrationWritten = false;
      const registeringFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        readDirectory: directory =>
          fileSystem.readDirectory(directory).pipe(
            Effect.tap(() => {
              if (directory !== leaseDirectory || registrationWritten) return Effect.void;
              registrationWritten = true;
              return fileSystem.writeFileString(
                registrationPath,
                `${JSON.stringify(
                  testRegistration(processId, 'mcp', 'matching-process-identity', 'registry-token-value'),
                )}\n`,
              );
            }),
          ),
      });
      const testSystem = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: candidate => candidate === processId,
        processStartIdentity: candidate =>
          Effect.succeed(candidate === processId ? 'matching-process-identity' : undefined),
      });

      const diagnostics = yield* readThreadnoteProcessDiagnostics({agentContextHome: home}).pipe(
        Effect.provideService(FileSystem.FileSystem, registeringFileSystem),
        Effect.provideService(SystemInfo, testSystem),
      );

      expect(registrationWritten).toBe(true);
      expect(diagnostics.processes).toEqual([
        expect.objectContaining({
          processId,
          releaseVersion: version,
          role: 'mcp',
        }),
      ]);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('keeps process identity as ROLE while nested activities update OPERATION and title', () =>
    Effect.gen(function* () {
      temporaryRoot = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-process-diagnostics-')));
      const config = {agentContextHome: temporaryRoot};
      const originalTitle = process.title;

      yield* withThreadnoteProcessRegistration(
        temporaryRoot,
        'mcp',
        Effect.gen(function* () {
          expect(process.title).toBe('threadnote:mcp');
          const base = yield* readThreadnoteProcessDiagnostics(config);
          expect(base.processes).toEqual([
            expect.objectContaining({
              parentProcessId: process.ppid,
              processId: process.pid,
              role: 'mcp',
              rssBytes: expect.any(Number),
            }),
          ]);
          const serialized = JSON.stringify(base);
          expect(serialized).not.toContain(temporaryRoot);
          expect(serialized).not.toContain(process.cwd());
          expect(serialized).not.toContain('token');
          const privateRegistration = yield* Effect.promise(() =>
            readFile(join(temporaryRoot!, 'runtime', 'processes', `${process.pid}.json`), 'utf8'),
          );
          expect(privateRegistration).not.toContain(temporaryRoot);
          expect(privateRegistration).not.toContain(process.cwd());

          expect(base.processes[0]).not.toHaveProperty('activityRole');

          yield* withThreadnoteProcessActivity(
            'graph-waiter',
            'repository-lock',
            Effect.gen(function* () {
              expect(process.title).toBe('threadnote:graph-waiter');
              const waiting = yield* readThreadnoteProcessDiagnostics(config);
              expect(waiting.processes[0]).toMatchObject({
                activityRole: 'graph-waiter',
                currentOperation: 'repository-lock',
                role: 'mcp',
              });

              yield* withThreadnoteProcessActivity(
                'graph-builder',
                'index-repository',
                Effect.gen(function* () {
                  expect(process.title).toBe('threadnote:graph-builder');
                  const building = yield* readThreadnoteProcessDiagnostics(config);
                  expect(building.processes[0]).toMatchObject({
                    activityRole: 'graph-builder',
                    currentOperation: 'index-repository',
                    role: 'mcp',
                  });
                }),
              );

              const waitingAgain = yield* readThreadnoteProcessDiagnostics(config);
              expect(process.title).toBe('threadnote:graph-waiter');
              expect(waitingAgain.processes[0]).toMatchObject({
                activityRole: 'graph-waiter',
                currentOperation: 'repository-lock',
                role: 'mcp',
              });
            }),
          );
        }),
      );

      expect(process.title).toBe(originalTitle);
      expect((yield* readThreadnoteProcessDiagnostics(config)).processes).toEqual([]);
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  it.effect('reports a dedicated CLI graph build as a graph activity owned by a CLI process', () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-process-cli-builder-'});
      const config = {agentContextHome: home};

      yield* withThreadnoteProcessRegistration(
        home,
        'cli',
        withThreadnoteProcessActivity(
          'graph-builder',
          'index-repository',
          Effect.gen(function* () {
            const diagnostics = yield* readThreadnoteProcessDiagnostics(config);
            expect(diagnostics.processes[0]).toMatchObject({
              activityRole: 'graph-builder',
              currentOperation: 'index-repository',
              role: 'cli',
            });
            expect(renderProcessDiagnosticsTable(diagnostics.processes)).toContain('cli (graph-builder)');
          }),
        ),
        'graph',
      );
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.effect('resolves explicit process homes without leaking command arguments into diagnostics', () =>
    Effect.gen(function* () {
      const absoluteHome = join(tmpdir(), 'threadnote-home');
      expect(yield* threadnoteHomeForProcess(['--home', './private-home', 'processes'], {})).toBe(
        join(process.cwd(), 'private-home'),
      );
      expect(yield* threadnoteHomeForProcess(['processes', `--home=${absoluteHome}`], {})).toBe(absoluteHome);
      expect(
        yield* threadnoteHomeForProcess(['--home', './private-home', 'processes'], {
          THREADNOTE_CALLER_CWD: join(process.cwd(), 'caller-worktree'),
        }),
      ).toBe(join(process.cwd(), 'caller-worktree', 'private-home'));
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  it.effect('falls back to runtime RSS when the host process query is unavailable', () =>
    Effect.gen(function* () {
      const nativeSystem = yield* SystemInfo;
      const expectedRssBytes = 42_000_000;
      const unavailableProcessId = 2_000_000_000;
      const systemWithoutPs = SystemInfo.of({
        ...nativeSystem,
        isProcessRunning: processId => processId === unavailableProcessId,
        memoryUsage: () => ({external: 0, heapUsed: 0, rss: expectedRssBytes}),
        processId: unavailableProcessId,
        processStartIdentity: () => succeedUndefined,
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-process-rss-'});

      yield* withThreadnoteProcessRegistration(
        home,
        'cli',
        Effect.gen(function* () {
          const diagnostics = yield* readThreadnoteProcessDiagnostics({agentContextHome: home});
          expect(diagnostics.processes).toEqual([
            expect.objectContaining({processId: unavailableProcessId, rssBytes: expectedRssBytes}),
          ]);
        }),
      ).pipe(Effect.provideService(SystemInfo, systemWithoutPs));
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer), Effect.scoped),
  );

  it.live('coalesces consecutive model batches while preserving operation and idle transitions', () =>
    Effect.gen(function* () {
      temporaryRoot = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'threadnote-process-diagnostics-')));
      const fileSystem = yield* FileSystem.FileSystem;
      const registryRoot = join(temporaryRoot, 'runtime', 'processes');
      let registryWrites = 0;
      const countingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFileString: (file, data, options) => {
          if (file.startsWith(registryRoot) && file.endsWith('.tmp')) registryWrites += 1;
          return fileSystem.writeFileString(file, data, options);
        },
      });
      const config = {agentContextHome: temporaryRoot};
      const burstOptions = {idleTransitionDelayMilliseconds: 60_000} as const;

      yield* withThreadnoteProcessRegistration(
        temporaryRoot,
        'local-model-worker',
        Effect.gen(function* () {
          expect(registryWrites).toBe(1);
          for (let index = 0; index < 100; index += 1) {
            yield* withThreadnoteProcessActivity('local-model-worker', 'embed-many', Effect.void, burstOptions);
          }

          expect(registryWrites).toBe(2);
          expect((yield* readThreadnoteProcessDiagnostics(config)).processes[0]).toMatchObject({
            currentOperation: 'embed-many',
            role: 'local-model-worker',
          });

          yield* withThreadnoteProcessActivity('local-model-worker', 'rerank', Effect.void, burstOptions);
          expect(registryWrites).toBe(3);
          expect((yield* readThreadnoteProcessDiagnostics(config)).processes[0]).toMatchObject({
            currentOperation: 'rerank',
            role: 'local-model-worker',
          });

          yield* withThreadnoteProcessActivity(
            'local-model-worker',
            'diagnostics',
            Effect.gen(function* () {
              expect(registryWrites).toBe(4);
              expect((yield* readThreadnoteProcessDiagnostics(config)).processes[0]).toMatchObject({
                currentOperation: 'diagnostics',
                role: 'local-model-worker',
              });
            }),
            {idleTransitionDelayMilliseconds: 1},
          );
          yield* Effect.sleep('50 millis');
          expect(registryWrites).toBe(5);
          expect((yield* readThreadnoteProcessDiagnostics(config)).processes[0]).toMatchObject({
            currentOperation: 'model-stdio',
            role: 'local-model-worker',
          });
        }),
        'model-stdio',
      ).pipe(Effect.provideService(FileSystem.FileSystem, countingFileSystem));
    }).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
  );

  fcEffectProp(
    it,
    'writes one registry transition per adjacent model-operation run',
    {
      operations: FC.array(FC.constantFrom('diagnostics', 'embed-many', 'generate', 'rerank'), {
        maxLength: 50,
        minLength: 1,
      }),
    },
    ({operations}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const home = yield* fileSystem.makeTempDirectoryScoped({prefix: 'threadnote-process-diagnostics-property-'});
          const registryRoot = join(home, 'runtime', 'processes');
          let registryWrites = 0;
          const countingFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            writeFileString: (file, data, options) => {
              if (file.startsWith(registryRoot) && file.endsWith('.tmp')) registryWrites += 1;
              return fileSystem.writeFileString(file, data, options);
            },
          });

          yield* withThreadnoteProcessRegistration(
            home,
            'local-model-worker',
            Effect.forEach(
              operations,
              operation =>
                withThreadnoteProcessActivity('local-model-worker', operation, Effect.void, {
                  idleTransitionDelayMilliseconds: 60_000,
                }),
              {concurrency: 1, discard: true},
            ).pipe(
              Effect.tap(() => {
                const operationRuns = operations.reduce(
                  (runs, operation, index) => runs + (index === 0 || operations[index - 1] !== operation ? 1 : 0),
                  0,
                );
                return Effect.sync(() => expect(registryWrites).toBe(1 + operationRuns));
              }),
            ),
            'model-stdio',
          ).pipe(Effect.provideService(FileSystem.FileSystem, countingFileSystem));
        }),
      ).pipe(provideTestLayer(TestSystemInfoLayer), provideTestLayer(BunServices.layer)),
    {fastCheck: {numRuns: 30}},
  );
});
