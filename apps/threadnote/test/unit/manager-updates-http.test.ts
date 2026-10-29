import {Array as EffectArray} from 'effect';
import {mkdtemp, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {testHttpFetch} from '@threadnote/testing/http-fetch';
import {Effect, Schema, Scope} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {TestError} from '@threadnote/testing/test-error';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {startManagerTestServer, type ManagerTestServer} from '../helpers/manager-test-server.js';
import type {RuntimeUpdates} from '@threadnote/manager/update-contracts';
import {handleManagerUpdateRequest} from '../../src/manager/updates.js';
import {ManagerLiveConsumerChangeHints} from '../../src/manager/live_consumer_observation.js';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const mock = vi.hoisted(() => ({
  running: '5.1.0',
  installed: '5.1.0',
  policy: 'automatic',
  managed: false,
  latest: vi.fn(),
  notes: vi.fn(),
  update: vi.fn(),
  setPolicy: vi.fn(),
}));
vi.mock('@threadnote/threadnote/release/update', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/threadnote/release/update')>()),
  currentPackageVersion: () => Effect.succeed(mock.running),
  fetchLatestVersion: (...args: unknown[]) => mock.latest(...args),
  runUpdate: (...args: unknown[]) => mock.update(...args),
}));
vi.mock('@threadnote/threadnote/release/auto_update', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/threadnote/release/auto_update')>()),
  readAutoUpdateStatus: () =>
    Effect.succeed({
      version: 1,
      policy: mock.policy,
      effectivePolicy: mock.policy,
      policySource: mock.managed ? 'environment' : 'file',
    }),
  runAutoUpdatePolicyCommand: (policy: string) =>
    Effect.sync(() => {
      mock.setPolicy(policy);
      mock.policy = policy;
    }),
}));
vi.mock('@threadnote/threadnote/release/notes', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/threadnote/release/notes')>()),
  fetchThreadnoteReleaseNotes: (...args: unknown[]) => mock.notes(...args),
}));
vi.mock('@threadnote/threadnote/installations', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/threadnote/installations')>()),
  activeInstalledVersion: () => Effect.succeed(mock.installed),
  executingInstalledRelease: () => Effect.succeed({version: mock.running}),
}));
vi.mock('@threadnote/workspace/runtime-version', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/workspace/runtime-version')>()),
  isStandaloneThreadnoteBuild: () => true,
}));
let home: string;
let server: ManagerTestServer;
const token = 'manager-updates-test-token';
const releases = [
  {version: '5.1.2', title: 'Latest', body: 'New capabilities'},
  {version: '5.1.0', title: 'Installed', body: 'Existing capabilities'},
  {version: '5.1.1', title: 'Intermediate', body: 'Bug fixes'},
  {version: '5.0.0', title: 'Old', body: 'Older changes'},
];
beforeEach(async () => {
  vi.clearAllMocks();
  mock.running = mock.installed = '5.1.0';
  mock.policy = 'automatic';
  mock.managed = false;
  mock.latest.mockImplementation(() => Effect.succeed('5.1.2'));
  mock.notes.mockImplementation(() => Effect.succeed(releases));
  mock.update.mockImplementation(() => Effect.void);
  home = await mkdtemp(join(tmpdir(), 'manager-updates-'));
  server = await startManagerTestServer(
    {
      agentContextHome: home,
      account: 'local',
      agentId: 'threadnote',
      user: 'tester',
      manifestPath: join(home, 'manifest.yaml'),
    },
    token,
  );
});
afterEach(async () => {
  await server?.close();
  if (home) await rm(home, {recursive: true, force: true});
});
const runtimeNotesSchema = Schema.Struct({body: Schema.String, title: Schema.String, version: Schema.String});
const runtimeUpdatesSchema = Schema.Struct({
  installedVersion: Schema.String,
  runningVersion: Schema.String,
  channel: Schema.Literals(['latest', 'beta']),
  developmentBuild: Schema.Boolean,
  restartRequired: Schema.Boolean,
  policy: Schema.Literals(['automatic', 'notify']),
  policyManaged: Schema.Boolean,
  automaticRunning: Schema.Boolean,
  automaticFailure: Schema.optional(Schema.String),
  latestVersion: Schema.optional(Schema.String),
  updateAvailable: Schema.Boolean,
  checkedAt: Schema.optional(Schema.String),
  checkError: Schema.optional(Schema.String),
  notesError: Schema.optional(Schema.String),
  installedNotes: Schema.Array(runtimeNotesSchema),
  availableNotes: Schema.Array(runtimeNotesSchema),
  job: Schema.optional(
    Schema.Struct({
      status: Schema.Literals(['running', 'completed', 'failed']),
      message: Schema.String,
      output: Schema.optional(Schema.String),
    }),
  ),
});
const runtimeUpdateErrorSchema = Schema.Struct({error: Schema.String});

function parseRuntimeUpdates(value: unknown): RuntimeUpdates {
  if (!Schema.is(runtimeUpdatesSchema)(value))
    throw TestError.make({message: 'Expected a validated runtime update response.'});
  return value;
}

async function request(body?: Record<string, unknown>, statusOnly = false) {
  const result = await testHttpFetch(server.url + '/api/runtime/updates' + (statusOnly ? '?view=status' : ''), {
    method: body ? 'POST' : 'GET',
    headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  const response: unknown = await result.json();
  if (!Schema.is(runtimeUpdatesSchema)(response) && !Schema.is(runtimeUpdateErrorSchema)(response))
    throw TestError.make({message: 'Expected a runtime update success or error response.'});
  return {status: result.status, body: response};
}

// These exercise the authenticated HTTP boundary. Release discovery and installation
// are isolated, so no test can change the developer's global installation or policy.
it('uses CLI note selectors, caches tab reads, and keeps status polls offline', async () => {
  const unauthorized = await testHttpFetch(server.url + '/api/runtime/updates');
  expect(unauthorized.status).toBe(401);
  expect(mock.latest).not.toHaveBeenCalled();
  await request(undefined, true);
  expect(mock.latest).not.toHaveBeenCalled();
  const first = await request();
  expect(EffectArray.map(parseRuntimeUpdates(first.body).installedNotes, note => note.version)).toEqual(['5.1.0']);
  expect(EffectArray.map(parseRuntimeUpdates(first.body).availableNotes, note => note.version)).toEqual([
    '5.1.1',
    '5.1.2',
  ]);
  expect(parseRuntimeUpdates(first.body).updateAvailable).toBe(true);
  await request();
  await request(undefined, true);
  expect(mock.latest).toHaveBeenCalledOnce();
  expect(mock.notes).toHaveBeenCalledWith({includePrereleases: false});
  await request({action: 'check'});
  expect(mock.latest).toHaveBeenCalledTimes(2);
  expect(mock.setPolicy).not.toHaveBeenCalled();
  expect(mock.update).not.toHaveBeenCalled();
});

it('persists explicit policy choices and respects environment-managed policy', async () => {
  expect((await request({action: 'policy', policy: 'notify'})).status).toBe(400);
  expect(mock.setPolicy).not.toHaveBeenCalled();
  expect(parseRuntimeUpdates((await request({action: 'policy', policy: 'notify', confirm: true})).body).policy).toBe(
    'notify',
  );
  expect(parseRuntimeUpdates((await request(undefined, true)).body).policy).toBe('notify');
  mock.managed = true;
  expect((await request({action: 'policy', policy: 'automatic', confirm: true})).status).toBe(409);
  expect(mock.setPolicy).toHaveBeenCalledExactlyOnceWith('notify');
});

it('retains a single update job across requests and reports the actual installed version', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => {
    finish = resolve;
  });
  mock.update.mockImplementation(() =>
    Effect.promise(() => gate).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          mock.installed = '5.1.2';
        }),
      ),
    ),
  );
  expect((await request({action: 'update'})).status).toBe(400);
  const started = await request({action: 'update', confirm: true});
  expect(started.status).toBe(202);
  expect(parseRuntimeUpdates(started.body).job?.status).toBe('running');
  await request({action: 'update', confirm: true});
  expect(mock.update).toHaveBeenCalledOnce();
  expect(mock.update.mock.calls[0]?.[1]).toEqual({yes: true});
  expect(parseRuntimeUpdates((await request(undefined, true)).body).job?.status).toBe('running');
  expect(mock.latest).not.toHaveBeenCalled();
  finish();
  await expect
    .poll(async () => parseRuntimeUpdates((await request(undefined, true)).body).job?.status)
    .toBe('completed');
  const completed = parseRuntimeUpdates((await request(undefined, true)).body);
  expect(completed.installedVersion).toBe('5.1.2');
  expect(completed.runningVersion).toBe('5.1.0');
  expect(completed.restartRequired).toBe(true);
  expect(mock.latest).not.toHaveBeenCalled();
});

it('reports failed checks and installs without claiming success, and can retry', async () => {
  mock.latest.mockImplementation(() => Effect.fail(TestError.make({message: 'Release service unavailable'})));
  const failed = parseRuntimeUpdates((await request()).body);
  expect(failed.checkError).toContain('Release service unavailable');
  expect(failed.updateAvailable).toBe(false);
  expect(failed.installedNotes).toHaveLength(1);
  mock.update.mockImplementation(() => Effect.fail(TestError.make({message: 'Download failed'})));
  await request({action: 'update', confirm: true});
  await expect.poll(async () => parseRuntimeUpdates((await request(undefined, true)).body).job?.status).toBe('failed');
  expect(parseRuntimeUpdates((await request(undefined, true)).body).job?.message).toBe('Download failed');
  mock.latest.mockImplementation(() => Effect.succeed('5.1.2'));
  expect(parseRuntimeUpdates((await request({action: 'check'})).body).updateAvailable).toBe(true);
});

it('uses the beta channel and prevents replacing development installations', async () => {
  mock.running = mock.installed = '5.2.0-beta.1';
  await request();
  expect(mock.latest.mock.calls[0]?.[1]).toBe('beta');
  expect(mock.notes).toHaveBeenCalledWith({includePrereleases: true});
  mock.installed = '5.2.0-local.g' + Effect2.pipe('a', EffectString.repeat(40));
  const development = parseRuntimeUpdates((await request(undefined, true)).body);
  expect(development.developmentBuild).toBe(true);
  expect(development.updateAvailable).toBe(false);
  expect((await request({action: 'update', confirm: true})).status).toBe(409);
  expect(mock.update).not.toHaveBeenCalled();
});

effectIt.effect('publishes runtime policy, check, and both update terminal transitions after state changes', () =>
  Effect.gen(function* () {
    const config = {
      account: 'local',
      agentContextHome: home,
      agentId: 'threadnote',
      user: 'tester',
      manifestPath: join(home, 'manifest.yaml'),
    } satisfies RuntimeConfig;
    const scope = yield* Scope.make();
    const key = {};
    const observed: Array<{job?: string; policy: string; checked: boolean}> = [];
    const call = (method: 'GET' | 'POST', body: Record<string, unknown> = {}) =>
      handleManagerUpdateRequest({
        body: Effect.succeed(body),
        config,
        jobContext: {key, scope},
        method,
        url: new URL('http://manager.test/api/runtime/updates' + (method === 'GET' ? '?view=status' : '')),
      });
    const hints = ManagerLiveConsumerChangeHints.of({
      publish: resource =>
        Effect.gen(function* () {
          expect(resource).toEqual({topic: 'runtime-updates', scope: 'account'});
          const result = yield* call('GET').pipe(provideTestLayer(ApplicationLayer), Effect.orDie);
          const status = parseRuntimeUpdates(result?.body);
          observed.push({job: status.job?.status, policy: status.policy, checked: status.checkedAt !== undefined});
        }),
    });
    yield* Effect.gen(function* () {
      expect((yield* call('POST', {action: 'policy', policy: 'notify', confirm: true}))?.status).toBe(200);
      expect(observed.at(-1)).toMatchObject({policy: 'notify'});
      expect((yield* call('POST', {action: 'check'}))?.status).toBe(200);
      expect(observed.at(-1)).toMatchObject({checked: true});
      expect((yield* call('POST', {action: 'update', confirm: true}))?.status).toBe(202);
      expect(EffectArray.some(observed, item => item.job === 'running')).toBe(true);
      for (let attempt = 0; attempt < 50 && !EffectArray.some(observed, item => item.job === 'completed'); attempt++)
        yield* Effect.yieldNow;
      expect(observed.at(-1)?.job).toBe('completed');
      mock.update.mockImplementation(() => Effect.fail(TestError.make({message: 'simulated update failure'})));
      expect((yield* call('POST', {action: 'update', confirm: true}))?.status).toBe(202);
      for (let attempt = 0; attempt < 50 && !EffectArray.some(observed, item => item.job === 'failed'); attempt++)
        yield* Effect.yieldNow;
      expect(observed.at(-1)?.job).toBe('failed');
    }).pipe(Effect.provideService(ManagerLiveConsumerChangeHints, hints));
  }).pipe(provideTestLayer(ApplicationLayer)),
);
