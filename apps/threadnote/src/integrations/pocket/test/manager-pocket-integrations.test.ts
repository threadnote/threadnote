import {mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {testHttpFetch} from '@threadnote/testing/http-fetch';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {startManagerTestServer, type ManagerTestServer} from '../../../../test/helpers/manager-test-server.js';
import {parseSourceConfiguration} from '@threadnote/threadnote/integrations/config';
import type {RuntimeConfig} from '@threadnote/workspace/config';

let home: string;
let server: ManagerTestServer;
const auth = 'manager-pocket-test-auth';
const envName = 'TEST_POCKET_MANAGER_API_KEY';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'manager-pocket-'));
  const config: RuntimeConfig = {
    agentContextHome: home,
    account: 'local',
    agentId: 'threadnote',
    user: 'tester',
    manifestPath: join(home, 'seed-manifest.yaml'),
  };
  server = await startManagerTestServer(config, auth);
});
afterEach(async () => {
  await server?.close();
  if (home) await rm(home, {recursive: true, force: true});
  delete process.env[envName];
});

async function request(path: string, body?: Record<string, unknown>, authorized = true) {
  const response = await testHttpFetch(server.url + path, {
    method: body ? 'POST' : 'GET',
    headers: {...(authorized ? {authorization: `Bearer ${auth}`} : {}), 'content-type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  return {status: response.status, body: (await response.json()) as Record<string, unknown>};
}

describe('Manager Pocket integration HTTP boundary', () => {
  it('lists every provider offline without exposing API key material', async () => {
    await mkdir(join(home, 'threadnote'), {recursive: true});
    await writeFile(
      join(home, 'threadnote', 'sources.yaml'),
      JSON.stringify({
        version: 2,
        sources: [
          {type: 'obsidian', id: 'vault', vault: home, include: ['**/*.md'], exclude: []},
          {type: 'pocket', id: 'recordings', project: null, credential_env: envName},
        ],
        projections: [],
      }),
    );
    const cacheRoot = join(home, 'data', 'local', 'resources', 'external', 'pocket', 'recordings');
    const nextAttemptAt = Date.now() + 60_000;
    await mkdir(cacheRoot, {recursive: true});
    await writeFile(
      join(cacheRoot, '.access.json'),
      JSON.stringify({
        version: 1,
        provider: 'pocket',
        sourceId: 'recordings',
        accessEpoch: 'a'.repeat(64),
        status: 'active',
        nextAttemptAt,
      }),
    );
    expect((await request('/api/integrations', undefined, false)).status).toBe(401);
    const response = await request('/api/integrations');
    expect(response.status).toBe(200);
    expect((response.body.obsidian as {sources: {id: string}[]}).sources.map(source => source.id)).toEqual(['vault']);
    expect((response.body.pocket as {sources: Record<string, unknown>[]}).sources[0]).toMatchObject({
      id: 'recordings',
      credentialConfigured: false,
      recordings: 0,
      status: 'needs-attention',
      nextAttemptAt,
    });
    expect(JSON.stringify(response.body)).not.toContain('synthetic-secret-api-key');
    expect((await request('/api/integrations/pocket')).status).toBe(200);
  });

  it('requires confirmation and pauses and removes only the Pocket connection', async () => {
    await mkdir(join(home, 'threadnote'), {recursive: true});
    const configPath = join(home, 'threadnote', 'sources.yaml');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        sources: [
          {type: 'obsidian', id: 'vault', vault: home, include: ['**/*.md'], exclude: []},
          {type: 'pocket', id: 'recordings', project: null, credential_env: envName},
        ],
        projections: [],
      }),
    );
    expect(
      (
        await request('/api/integrations/pocket', {
          action: 'set-enabled',
          id: 'recordings',
          enabled: false,
          apply: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/api/integrations/pocket', {
          action: 'set-enabled',
          id: 'recordings',
          enabled: false,
          apply: true,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    expect(
      parseSourceConfiguration(await readFile(configPath, 'utf8')).sources.find(source => source.id === 'recordings')
        ?.enabled,
    ).toBe(false);
    expect(
      (
        await request('/api/integrations/pocket', {
          action: 'remove-source',
          id: 'recordings',
          apply: true,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    expect(parseSourceConfiguration(await readFile(configPath, 'utf8')).sources.map(source => source.id)).toEqual([
      'vault',
    ]);
  });

  it('returns static errors without echoing a submitted key', async () => {
    const response = await request('/api/integrations/pocket', {
      action: 'save-source',
      id: 'recordings',
      token: 'synthetic-secret-api-key',
      credentialEnv: envName,
      project: null,
      refreshIntervalMinutes: 15,
      maxStaleHours: 24,
      apply: true,
      confirm: true,
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('synthetic-secret-api-key');
  });
});
