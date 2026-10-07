import {mkdtemp, rm} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {testHttpFetch} from '@threadnote/testing/http-fetch';
import {Effect} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {startManagerTestServer, type ManagerTestServer} from '../helpers/manager-test-server.js';
import type {RuntimeUpdates} from '@threadnote/manager/update-contracts';

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
async function request(body?: Record<string, unknown>, statusOnly = false) {
  const result = await testHttpFetch(server.url + '/api/runtime/updates' + (statusOnly ? '?view=status' : ''), {
    method: body ? 'POST' : 'GET',
    headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  return {status: result.status, body: (await result.json()) as RuntimeUpdates & {error?: string}};
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
  expect(first.body.installedNotes.map(note => note.version)).toEqual(['5.1.0']);
  expect(first.body.availableNotes.map(note => note.version)).toEqual(['5.1.1', '5.1.2']);
  expect(first.body.updateAvailable).toBe(true);
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
  expect((await request({action: 'policy', policy: 'notify', confirm: true})).body.policy).toBe('notify');
  expect((await request(undefined, true)).body.policy).toBe('notify');
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
  expect(started.body.job?.status).toBe('running');
  await request({action: 'update', confirm: true});
  expect(mock.update).toHaveBeenCalledOnce();
  expect(mock.update.mock.calls[0]?.[1]).toEqual({yes: true});
  expect((await request(undefined, true)).body.job?.status).toBe('running');
  expect(mock.latest).not.toHaveBeenCalled();
  finish();
  await expect.poll(async () => (await request(undefined, true)).body.job?.status).toBe('completed');
  const completed = (await request(undefined, true)).body;
  expect(completed.installedVersion).toBe('5.1.2');
  expect(completed.runningVersion).toBe('5.1.0');
  expect(completed.restartRequired).toBe(true);
  expect(mock.latest).not.toHaveBeenCalled();
});

it('reports failed checks and installs without claiming success, and can retry', async () => {
  mock.latest.mockImplementation(() => Effect.fail(TestError.make({message: 'Release service unavailable'})));
  const failed = (await request()).body;
  expect(failed.checkError).toContain('Release service unavailable');
  expect(failed.updateAvailable).toBe(false);
  expect(failed.installedNotes).toHaveLength(1);
  mock.update.mockImplementation(() => Effect.fail(TestError.make({message: 'Download failed'})));
  await request({action: 'update', confirm: true});
  await expect.poll(async () => (await request(undefined, true)).body.job?.status).toBe('failed');
  expect((await request(undefined, true)).body.job?.message).toBe('Download failed');
  mock.latest.mockImplementation(() => Effect.succeed('5.1.2'));
  expect((await request({action: 'check'})).body.updateAvailable).toBe(true);
});

it('uses the beta channel and prevents replacing development installations', async () => {
  mock.running = mock.installed = '5.2.0-beta.1';
  await request();
  expect(mock.latest.mock.calls[0]?.[1]).toBe('beta');
  expect(mock.notes).toHaveBeenCalledWith({includePrereleases: true});
  mock.installed = '5.2.0-local.g' + 'a'.repeat(40);
  const development = (await request(undefined, true)).body;
  expect(development.developmentBuild).toBe(true);
  expect(development.updateAvailable).toBe(false);
  expect((await request({action: 'update', confirm: true})).status).toBe(409);
  expect(mock.update).not.toHaveBeenCalled();
});
