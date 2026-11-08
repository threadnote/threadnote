import * as BunFileSystem from '@effect/platform-bun/BunFileSystem';
import * as BunPath from '@effect/platform-bun/BunPath';
import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {CommandExecutor} from '@threadnote/platform/command';
import {canonicalFileUri} from '@threadnote/semantic/contracts';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {runSemanticDoctor} from '../../src/semantic/doctor.js';
import {writeSemanticHostProfile} from '../../src/semantic/host_profile.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {makeSemanticAdmission, semanticSessionLimits} from '../../src/semantic/coordinator.js';
import {semanticTreeDigest} from '../../src/semantic/fingerprint.js';

const layer = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  cryptoLayer,
  TestSystemInfoLayer,
  Layer.succeed(CommandExecutor, {
    execute: () => Effect.die('Disabled or missing semantics must never run a process'),
    executeStreaming: () => Effect.die('Operational checks never stream a process'),
  }),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'semantic-operations-'}));
  const home = path.join(directory, 'home');
  const root = path.join(directory, 'worktree');
  yield* fs.makeDirectory(home, {mode: 0o700});
  yield* fs.makeDirectory(root, {mode: 0o700});
  const config: RuntimeConfig = {
    account: 'local',
    user: 'test',
    agentId: 'test',
    agentContextHome: home,
    manifestPath: path.join(directory, 'manifest.json'),
  };
  const worktree = canonicalFileUri((yield* path.toFileUrl(root)).href);
  return {fs, path, home, root, worktree, config, request: {version: 1, callerCwd: root}};
});

describe('semantic operational inspection', () => {
  effectIt.effect('keeps missing and disabled semantics independent without creating an admission service', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(yield* runSemanticDoctor(f.config, f.request)).toMatchObject({
        state: 'missing',
        graphAndMemory: 'available-independently',
      });
      expect(yield* f.fs.exists(f.path.join(f.home, 'semantic'))).toBe(false);
      yield* writeSemanticHostProfile(f.config, f.worktree, {
        version: 1,
        enabled: false,
        worktree: f.worktree,
        catalog: {},
      });
      expect(yield* runSemanticDoctor(f.config, f.request, 'status')).toMatchObject({state: 'disabled'});
      expect(yield* f.fs.exists(f.path.join(f.home, 'semantic', 'admission-v1'))).toBe(false);
    }).pipe(provideTestLayer(layer)),
  );
  effectIt.effect('previews pinned setup, resumes the exact profile and requires the observed digest for disable', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const runtime = f.path.join(f.home, 'node');
      const serverDirectory = f.path.join(f.home, 'server');
      const sdkDirectory = f.path.join(f.home, 'sdk');
      yield* f.fs.writeFileString(runtime, 'trusted-runtime-image');
      for (const [directory, version] of [
        [serverDirectory, '6.0.2'],
        [sdkDirectory, '6.0.3'],
      ] as const) {
        yield* f.fs.makeDirectory(directory);
        yield* f.fs.writeFileString(f.path.join(directory, 'package.json'), JSON.stringify({version}));
      }
      const profile = {
        version: 1,
        enabled: true,
        worktree: f.worktree,
        catalog: {
          candidate: {
            runtime,
            runtimeDigest: sha256HexSync('trusted-runtime-image'),
            runtimeVersion: '24.19.0',
            serverDirectory,
            serverTreeDigest: yield* semanticTreeDigest(serverDirectory),
            sdkDirectory,
            sdkTreeDigest: yield* semanticTreeDigest(sdkDirectory),
          },
        },
      };
      let checks = 0;
      const run = (input: unknown, action: 'setup' | 'disable' | 'status') =>
        runSemanticDoctor(f.config, input, action).pipe(
          Effect.provideService(CommandExecutor, {
            executeStreaming: () => Effect.die('Operational checks never stream a process'),
            execute: (file, args, options) =>
              Effect.sync(() => {
                expect(file).toBe(runtime);
                expect(args).toEqual(['--version']);
                expect(options).toMatchObject({env: {}, timeoutMs: 2000, maxOutputBytes: 128});
                checks++;
                return {exitCode: 0, stdout: 'v24.19.0\n', stderr: 'PRIVATE_PROVIDER_TEXT'};
              }),
          }),
        );
      expect(yield* run({...f.request, profile}, 'setup')).toMatchObject({state: 'preview'});
      expect(yield* f.fs.exists(f.path.join(f.home, 'semantic'))).toBe(false);
      const first = yield* run({...f.request, profile, apply: true}, 'setup');
      expect(first).toMatchObject({state: 'configured', changed: true});
      expect(yield* run({...f.request, profile, apply: true}, 'setup')).toMatchObject({
        state: 'configured',
        changed: false,
      });
      expect(yield* run({...f.request, apply: true, expectedDigest: 'stale'}, 'disable')).toMatchObject({
        state: 'incompatible',
      });
      const status = yield* run(f.request, 'status');
      const digest = 'profileDigest' in status ? status.profileDigest : undefined;
      expect(yield* run({...f.request, apply: true, expectedDigest: digest}, 'disable')).toMatchObject({
        state: 'disabled',
        changed: true,
      });
      expect(checks).toBe(3);
      expect(JSON.stringify(status)).not.toContain('PRIVATE_PROVIDER_TEXT');
      expect(JSON.stringify(status)).not.toContain(runtime);
      expect(yield* f.fs.exists(f.path.join(f.home, 'semantic', 'admission-v1'))).toBe(false);
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );

  effectIt.effect(
    'reports pinned provider faults and omits private payloads and repository-supplied execution policy',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* writeSemanticHostProfile(f.config, f.worktree, {
          version: 1,
          enabled: true,
          worktree: f.worktree,
          catalog: {
            go: {
              executable: '/PRIVATE_SOURCE/token-secret',
              executableDigest: sha256HexSync('incorrect'),
              sdkDirectory: '/PRIVATE_SOURCE/sdk',
              sdkTreeDigest: sha256HexSync('sdk'),
            },
          },
        });
        const report = yield* runSemanticDoctor(f.config, {...f.request, language: 'go'});
        expect(report).toMatchObject({
          state: 'unavailable',
          providers: [{id: 'gopls', state: 'unavailable', cause: 'incompatible', productionQualified: false}],
        });
        expect(JSON.stringify(report)).not.toContain('PRIVATE_SOURCE');
        expect(JSON.stringify(report)).not.toContain('token-secret');
        expect(yield* runSemanticDoctor(f.config, {...f.request, build: true, download: true})).toMatchObject({
          state: 'invalid-request',
          policy: {repositoryBuildPermission: false, automaticDownload: false},
        });
      }).pipe(provideTestLayer(layer), TestClock.withLive),
  );
});

describe.skipIf(process.platform === 'win32')('semantic resource admission', () => {
  effectIt.effect(
    'queues under measured leader RSS pressure, removes expired tickets and preserves read-only state',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const system = yield* SystemInfo;
        let rss = semanticSessionLimits.providerLeaderRssBytesPerHome;
        const host = {
          ...system,
          isProcessRunning: () => true,
          canonicalProcessStartIdentity: (pid: number) => Effect.succeed('instance-' + pid),
          processResourceCounters: (pids: readonly number[]) =>
            Effect.succeed(
              new Map(
                EffectArray.map(pids, pid => [
                  pid,
                  {
                    processId: pid,
                    processStartIdentity: 'numeric-counter-instance',
                    cpuMilliseconds: 0,
                    rssBytes: rss,
                  },
                ]),
              ),
            ),
        };
        const directory = f.path.join(f.home, 'admission');
        const make = (readOnly = false) =>
          makeSemanticAdmission({directory, readOnly}).pipe(Effect.provideService(SystemInfo, host));
        const first = yield* make();
        const held = yield* first.acquire(sha256HexSync('one'), 2000);
        yield* held.bindProvider(999999);
        yield* held.finishImport;
        const file = f.path.join(directory, 'admission-v1.json');
        const original = yield* f.fs.readFileString(file);
        const status = yield* (yield* make(true)).status;
        expect(status).toMatchObject({
          providers: 1,
          pressure: {state: 'pressured', rssBytes: rss, observedProviders: 1},
        });
        expect(yield* f.fs.readFileString(file)).toBe(original);
        // A caller cannot mutate a status object to bypass the cached admission decision.
        Reflect.set(status.pressure, 'state', 'normal');
        const blocked = yield* make();
        expect(yield* blocked.acquire(sha256HexSync('two'), 50).pipe(Effect.flip)).toMatchObject({code: 'timeout'});
        expect(yield* blocked.status).toMatchObject({providers: 1, queued: 0, pressure: {state: 'pressured'}});
        rss = 1;
        const healthy = yield* make();
        const admitted = yield* healthy.acquire(sha256HexSync('three'), 2000);
        yield* admitted.release(true);
        yield* held.release(true);
        expect(yield* healthy.status).toMatchObject({providers: 0, queued: 0});
      }).pipe(provideTestLayer(layer), TestClock.withLive),
  );

  effectIt.effect('keeps incomplete process observations explicitly unknown while enforcing count limits', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const system = yield* SystemInfo;
      const admission = yield* makeSemanticAdmission({directory: f.path.join(f.home, 'admission')}).pipe(
        Effect.provideService(SystemInfo, {
          ...system,
          isProcessRunning: () => true,
          canonicalProcessStartIdentity: () => Effect.succeed('known'),
          processResourceCounters: () => Effect.succeed(new Map()),
        }),
      );
      const held = yield* admission.acquire(sha256HexSync('one'), 2000);
      yield* held.bindProvider(999999);
      expect(yield* admission.status).toMatchObject({
        providers: 1,
        pressure: {state: 'unknown', rssBytes: null, observedProviders: 0, expectedProviders: 1},
      });
      yield* held.release(false);
      expect(yield* admission.status).toMatchObject({providers: 1, quarantined: 1});
    }).pipe(provideTestLayer(layer), TestClock.withLive),
  );
});
