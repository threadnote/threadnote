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
const auth = 'manager-github-test-auth';
const envName = 'TEST_GITHUB_MANAGER_API_KEY';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'manager-github-'));
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

describe('Manager GitHub integration HTTP boundary', () => {
  it('lists every provider offline without exposing API key material', async () => {
    await mkdir(join(home, 'threadnote'), {recursive: true});
    await writeFile(
      join(home, 'threadnote', 'sources.yaml'),
      JSON.stringify({
        version: 2,
        sources: [
          {type: 'obsidian', id: 'vault', vault: home, include: ['**/*.md'], exclude: []},
          {type: 'github', id: 'recordings', repositories: ['owner/repo'], project: null, credential_env: envName},
        ],
        projections: [],
      }),
    );
    const cacheRoot = join(home, 'data', 'local', 'resources', 'external', 'github', 'recordings');
    const nextAttemptAt = Date.now() + 60_000;
    await mkdir(cacheRoot, {recursive: true});
    await writeFile(
      join(cacheRoot, '.access.json'),
      JSON.stringify({
        version: 1,
        provider: 'github',
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
    expect((response.body.github as {sources: Record<string, unknown>[]}).sources[0]).toMatchObject({
      id: 'recordings',
      credentialConfigured: false,
      conversations: 0,
      status: 'needs-attention',
      nextAttemptAt,
    });
    expect(JSON.stringify(response.body)).not.toContain('synthetic-secret-api-key');
    expect((await request('/api/integrations/github')).status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('ghp_synthetic_token');
  });

  it('requires confirmation and pauses and removes only the GitHub connection', async () => {
    await mkdir(join(home, 'threadnote'), {recursive: true});
    const configPath = join(home, 'threadnote', 'sources.yaml');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        sources: [
          {type: 'obsidian', id: 'vault', vault: home, include: ['**/*.md'], exclude: []},
          {type: 'github', id: 'recordings', repositories: ['owner/repo'], project: null, credential_env: envName},
        ],
        projections: [],
      }),
    );
    expect(
      (
        await request('/api/integrations/github', {
          action: 'set-enabled',
          id: 'recordings',
          enabled: false,
          apply: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/api/integrations/github', {
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
        await request('/api/integrations/github', {
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

  it('previews a new source or token edit without persisting a submitted token', async () => {
    const save = {
      action: 'save-source',
      id: 'recordings',
      repositories: ['owner/repo'],
      project: null,
      refreshIntervalMinutes: 15,
      maxStaleHours: 24,
      token: 'ghp_synthetic_token',
      apply: false,
    };
    expect((await request('/api/integrations/github', save)).status).toBe(200);
    expect((await request('/api/integrations/github', {...save, editing: true})).status).toBe(409);
    await mkdir(join(home, 'threadnote'), {recursive: true});
    await writeFile(
      join(home, 'threadnote', 'sources.yaml'),
      JSON.stringify({
        version: 2,
        sources: [
          {type: 'github', id: 'recordings', repositories: ['owner/repo'], project: null, credential_env: envName},
        ],
        projections: [],
      }),
    );
    const edited = await request('/api/integrations/github', {...save, editing: true});
    expect(edited.status).toBe(200);
    expect(JSON.stringify(edited.body)).not.toContain('ghp_synthetic_token');
    expect(await readFile(join(home, 'threadnote', 'sources.yaml'), 'utf8')).not.toContain('ghp_synthetic_token');
  });
  it('returns static errors without echoing a submitted key', async () => {
    const response = await request('/api/integrations/github', {
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
