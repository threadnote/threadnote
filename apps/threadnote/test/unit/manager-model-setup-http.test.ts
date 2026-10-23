import {it as effectIt} from '@effect/vitest';
import {BunCrypto, BunFileSystem, BunPath} from '@effect/platform-bun';
import {Context, Crypto, Effect, FileSystem, Layer, Path, Schema} from 'effect';
import {describe, expect, it} from 'vitest';
import {mkdtemp, readdir, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {testHttpFetch} from '@threadnote/testing/http-fetch';
import {CommandExecutor} from '@threadnote/platform/command';
import {HttpService} from '@threadnote/platform/http';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {BUILTIN_MODEL_MANIFESTS, CORE_GENERATION_MODEL_ID} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {
  initialModelSetupState,
  modelSetupFileIdentity,
  modelSetupJob,
  sameModelSetupFile,
} from '@threadnote/inference/models/setup';
import {handleManagerModelSetupRequest} from '../../src/manager/model_setup.js';
import {discoverLocalConsolidationModels} from '../../src/manager/consolidation_models.js';
import {readModelSetupStatus, runModelSetupCommand} from '../../src/models/setup.js';
import {makeManagerLiveConsumerObservation} from '../../src/manager/live_consumer_observation.js';
import {captureConsole} from '../../src/effect/console.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {startManagerTestServer} from '../helpers/manager-test-server.js';

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layer, TestSystemInfoLayer);
function providePlatform<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.scoped(Layer.build(platform).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
}
const fixture = (environment: NodeJS.ProcessEnv = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-setup-api-'});
    const home = path.join(yield* fs.realPath(temporary), 'home');
    const manifest = {...BUILTIN_MODEL_MANIFESTS.find(model => model.id === CORE_GENERATION_MODEL_ID)!, size: 4};
    const baseSystem = yield* SystemInfo;
    const system = SystemInfo.of({
      ...baseSystem,
      environment: () => environment,
      executablePath: '/fixture/threadnote',
      hardwareInfo: Effect.succeed({
        effectiveMemoryBytes: Number.MAX_SAFE_INTEGER,
        cpuModel: 'fixture',
        memoryBytes: Number.MAX_SAFE_INTEGER,
        operatingSystem: 'fixture',
      }),
    });
    let launches = 0;
    const forbidden = () => Effect.die('Unexpected network or command operation');
    const context = (yield* Effect.context<Crypto.Crypto | FileSystem.FileSystem | Path.Path>()).pipe(
      Context.add(SystemInfo, system),
      Context.add(
        HttpService,
        HttpService.of({getJson: forbidden, getText: forbidden, getStatus: forbidden, downloadToFile: forbidden}),
      ),
      Context.add(
        CommandExecutor,
        CommandExecutor.of({
          execute: forbidden,
          executeStreaming: forbidden,
          spawnDetached: () =>
            Effect.sync(() => {
              launches += 1;
              return true;
            }),
        }),
      ),
    );
    const catalog = Context.get(yield* Layer.build(LocalModelCatalog.layer([manifest])), LocalModelCatalog);
    const store = Context.get(yield* Layer.build(LocalModelStore.layer).pipe(Effect.provide(context)), LocalModelStore);
    const services = context.pipe(Context.add(LocalModelCatalog, catalog), Context.add(LocalModelStore, store));
    const request = (
      method = 'GET',
      body: Effect.Effect<Record<string, unknown>, unknown> = Effect.succeed({}),
      authorized = true,
    ) =>
      handleManagerModelSetupRequest(home, {method, body, url: '/api/models/setup', headers: {}}, authorized).pipe(
        Effect.provide(services),
      );
    const ready = Effect.gen(function* () {
      yield* fs.makeDirectory(path.join(home, 'models'), {recursive: true});
      const file = store.path(home, manifest);
      yield* fs.makeDirectory(path.dirname(file), {recursive: true});
      yield* fs.writeFileString(file, 'tiny');
      const identity = yield* modelSetupFileIdentity(file);
      const state = {
        ...initialModelSetupState(modelSetupJob(home, manifest)),
        phase: 'ready',
        receipt: {sha256: manifest.sha256, fileIdentity: identity},
      };
      yield* fs.writeFileString(path.join(home, 'models/setup.json'), JSON.stringify(state));
    });
    return {
      fs,
      path,
      home,
      manifest,
      artifact: store.path(home, manifest),
      services,
      request,
      ready,
      launches: () => launches,
    };
  });

describe('Manager setup adapter', () => {
  effectIt.effect('invalidates ready setup when artifact ctime changes without mtime or size changing', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.ready;
      const before = yield* modelSetupFileIdentity(f.artifact);
      expect(before).toBeDefined();
      expect((yield* readModelSetupStatus(f.home).pipe(Effect.provide(f.services))).artifactReady).toBe(true);
      const revisions: string[] = [];
      const broker = yield* makeManagerLiveConsumerObservation(
        {agentContextHome: f.home} as RuntimeConfig,
        {
          onInvalidate: (_resource, revision) =>
            Effect.sync(() => {
              revisions.push(revision);
            }),
          onAvailability: () => Effect.void,
        },
        {
          modelPaths: [
            f.path.join(f.home, 'models', 'setup.json'),
            f.path.join(f.home, 'models', 'selection.json'),
            f.artifact,
          ],
        },
      ).pipe(Effect.provide(f.services));
      const resource = {topic: 'model-setup' as const, scope: 'account' as const};
      expect(yield* broker.subscribe('setup', [resource])).toEqual([]);
      yield* Effect.addFinalizer(() => f.fs.chmod(f.artifact, 0o600).pipe(Effect.orDie));
      yield* f.fs.chmod(f.artifact, 0o444);
      const after = yield* modelSetupFileIdentity(f.artifact);
      expect(after?.modifiedAtNs).toBe(before?.modifiedAtNs);
      expect(before && after && sameModelSetupFile(before, after)).toBe(false);
      const status = yield* readModelSetupStatus(f.home).pipe(Effect.provide(f.services));
      expect(status).toMatchObject({artifactReady: false, effectiveDefault: false, reason: 'artifact-changed'});
      yield* broker.reconcileNow;
      expect(revisions).toHaveLength(1);
    }).pipe(providePlatform),
  );
  effectIt.effect('authenticates before evaluating even a malformed body or touching a missing home', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let reads = 0;
      const body = Effect.sync(() => {
        reads += 1;
        return {action: 'setup', confirm: true, expectedEpoch: 0};
      });
      expect(yield* f.request('POST', body, false)).toEqual({status: 401, body: {error: 'Unauthorized'}});
      expect(yield* f.request('GET', Effect.die('GET body read'), false)).toEqual({
        status: 401,
        body: {error: 'Unauthorized'},
      });
      expect(reads).toBe(0);
      expect(yield* f.fs.exists(f.home)).toBe(false);
      expect(f.launches()).toBe(0);
    }).pipe(providePlatform),
  );
  effectIt.effect('GET is offline, side-effect-free and identical to CLI JSON for missing and redacted state', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const config = {
        agentContextHome: f.home,
        account: 'local',
        user: 'tester',
        agentId: 'threadnote',
        manifestPath: '/unused',
      };
      const check = Effect.gen(function* () {
        const api = yield* f.request();
        const cli = yield* captureConsole(runModelSetupCommand(config, {status: true, json: true})).pipe(
          Effect.provide(f.services),
        );
        expect(api).toEqual({status: 200, body: JSON.parse(cli.output)});
        expect(JSON.stringify(api.body)).not.toContain(f.home);
        expect(JSON.stringify(api.body)).not.toContain('private-secret');
      });
      yield* check;
      expect(yield* f.fs.exists(f.home)).toBe(false);
      yield* f.fs.makeDirectory(f.path.join(f.home, 'models'), {recursive: true});
      const state = {
        ...initialModelSetupState(modelSetupJob(f.home, f.manifest)),
        phase: 'action-required',
        reason: 'private-secret',
      };
      yield* f.fs.writeFileString(f.path.join(f.home, 'models/setup.json'), JSON.stringify(state));
      yield* check;
      expect((yield* f.request()).body).toMatchObject({reason: 'setup-failed'});
      expect(f.launches()).toBe(0);
    }).pipe(providePlatform),
  );
  effectIt.effect('rejects malformed actions and parser failures without creating state', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const invalid = [
        {},
        {action: 'setup'},
        {action: 'setup', confirm: true},
        {action: 'unknown', confirm: true, expectedEpoch: 0},
        {action: 'policy', policy: 'on', confirm: true, expectedEpoch: 0},
        {action: 'retry', confirm: true, expectedEpoch: -1},
        {action: 'retry', confirm: true, expectedEpoch: 0.5},
        {action: 'setup', policy: 'automatic', confirm: true, expectedEpoch: 0},
        {action: 'setup', confirm: true, expectedEpoch: 0, secret: 'unexpected'},
      ];
      for (const body of invalid) expect((yield* f.request('POST', Effect.succeed(body))).status).toBe(400);
      expect((yield* f.request('POST', Effect.fail('invalid JSON'))).status).toBe(400);
      expect((yield* f.request('DELETE')).status).toBe(405);
      expect(yield* f.fs.exists(f.home)).toBe(false);
      expect(f.launches()).toBe(0);
    }).pipe(providePlatform),
  );
  effectIt.effect('environment force-off rejects every mutation without changing durable intent', () =>
    Effect.gen(function* () {
      const f = yield* fixture({THREADNOTE_MODEL_SETUP: 'off'});
      for (const body of [
        {action: 'setup'},
        {action: 'retry'},
        {action: 'policy', policy: 'automatic'},
        {action: 'policy', policy: 'off'},
      ])
        expect((yield* f.request('POST', Effect.succeed({...body, confirm: true, expectedEpoch: 0}))).status).toBe(409);
      expect((yield* f.request()).body).toMatchObject({environmentOff: true, policy: 'automatic'});
      expect(yield* f.fs.exists(f.home)).toBe(false);
    }).pipe(providePlatform),
  );
  effectIt.effect('shares one job, rejects stale intent, and retry cannot override off', () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const post = (body: Record<string, unknown>) => f.request('POST', Effect.succeed({confirm: true, ...body}));
      const first = yield* post({action: 'setup', expectedEpoch: 0});
      expect(first.status).toBe(200);
      const current = yield* readModelSetupStatus(f.home).pipe(Effect.provide(f.services));
      expect(current.intentEpoch).toBeGreaterThan(0);
      expect((yield* post({action: 'retry', expectedEpoch: 0})).status).toBe(409);
      expect((yield* post({action: 'setup', expectedEpoch: current.intentEpoch})).status).toBe(200);
      expect(f.launches()).toBe(1);
      const off = yield* post({action: 'policy', policy: 'off', expectedEpoch: current.intentEpoch});
      expect(off.status).toBe(200);
      const offStatus = yield* readModelSetupStatus(f.home).pipe(Effect.provide(f.services));
      expect(offStatus.policy).toBe('off');
      expect((yield* post({action: 'retry', expectedEpoch: offStatus.intentEpoch})).body).toMatchObject({
        policy: 'off',
      });
      expect((yield* post({action: 'policy', policy: 'automatic', expectedEpoch: current.intentEpoch})).status).toBe(
        409,
      );
      expect(f.launches()).toBe(1);
    }).pipe(providePlatform),
  );
  effectIt.effect.prop(
    'arbitrary unknown actions never mutate a home',
    [Schema.String],
    ([action]) =>
      Effect.gen(function* () {
        if (['setup', 'retry', 'policy'].includes(action)) return;
        const f = yield* fixture();
        expect((yield* f.request('POST', Effect.succeed({action, confirm: true, expectedEpoch: 0}))).status).toBe(400);
        expect(yield* f.fs.exists(f.home)).toBe(false);
        expect(f.launches()).toBe(0);
      }).pipe(providePlatform),
    {arbitrary: {runs: 12}},
  );
  effectIt.effect(
    'catalog recommends only the shared effective choice and preserves missing or malformed explicit choices',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const catalog = discoverLocalConsolidationModels(f.home).pipe(Effect.provide(f.services));
        expect(yield* catalog).toEqual([]);
        yield* f.ready;
        expect(yield* catalog).toEqual([{id: f.manifest.id, label: f.manifest.id, isDefault: true}]);
        yield* f.fs.remove(f.path.join(f.home, 'models/setup.json'));
        expect(yield* catalog).toEqual([{id: f.manifest.id, label: f.manifest.id, isDefault: false}]);
        yield* f.ready;
        const selectionFile = f.path.join(f.home, 'models/selection.json');
        for (const selection of ['{"version":1,"roles":{"generation":"unavailable-explicit"}}', '{malformed']) {
          yield* f.fs.writeFileString(selectionFile, selection);
          expect(yield* catalog).toEqual([{id: f.manifest.id, label: f.manifest.id, isDefault: false}]);
          expect(yield* f.fs.readFileString(selectionFile)).toBe(selection);
        }
        yield* f.fs.remove(selectionFile);
        expect(
          (yield* f.request('POST', Effect.succeed({action: 'policy', policy: 'off', confirm: true, expectedEpoch: 0})))
            .status,
        ).toBe(200);
        expect(yield* catalog).toEqual([{id: f.manifest.id, label: f.manifest.id, isDefault: false}]);
        yield* f.fs.writeFileString(selectionFile, JSON.stringify({version: 1, roles: {generation: f.manifest.id}}));
        expect(yield* catalog).toEqual([{id: f.manifest.id, label: f.manifest.id, isDefault: true}]);
        expect(f.launches()).toBe(0);
      }).pipe(providePlatform),
  );
});

// Actual Manager HTTP callback boundary; no model, worker, or native inference is invoked.
it('routes authenticated GET and rejects invalid or oversized HTTP bodies without creating model state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'threadnote-setup-http-'));
  const token = 'setup-test-token';
  const server = await startManagerTestServer(
    {
      agentContextHome: home,
      account: 'local',
      agentId: 'threadnote',
      user: 'tester',
      manifestPath: join(home, 'manifest.yaml'),
    },
    token,
  );
  try {
    const request = async (method: string, body?: string, authorized = true) => {
      const response = await testHttpFetch(server.url + '/api/models/setup', {
        method,
        headers: {'content-type': 'application/json', ...(authorized ? {authorization: `Bearer ${token}`} : {})},
        ...(body === undefined ? {} : {body}),
      });
      return {status: response.status, body: await response.json()};
    };
    expect((await request('POST', '{invalid', false)).status).toBe(401);
    expect((await request('GET', undefined, false)).status).toBe(401);
    expect(await request('GET')).toMatchObject({status: 200, body: {phase: 'not-requested', intentEpoch: 0}});
    for (const body of [
      '{invalid',
      'null',
      '[]',
      '"text"',
      ' '.repeat(5000) + JSON.stringify({action: 'policy', policy: 'off', confirm: true, expectedEpoch: 0}),
    ])
      expect((await request('POST', body)).status).toBe(400);
    expect(await readdir(home)).not.toContain('models');
  } finally {
    await server.close();
    await rm(home, {recursive: true, force: true});
  }
});
