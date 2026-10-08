import {mkdir, mkdtemp, readFile, rm, writeFile} from '@threadnote/testing/node-fs-promises';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {testHttpFetch} from '@threadnote/testing/http-fetch';
import {Redacted} from 'effect';
import fc from 'fast-check';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  mergeResolvedSuperhumanSelections,
  resolveSuperhumanBrowserLinks,
} from '@threadnote/threadnote/manager/superhuman-integrations';
import {parseSourceConfiguration} from '@threadnote/threadnote/obsidian/config';
import {startManagerTestServer, type ManagerTestServer} from '../helpers/manager-test-server.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';

const credential = Redacted.make('synthetic-manager-token');
const json = (value: unknown) => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
const resolved = (type: 'doc' | 'page', documentId: string, pageId?: string, name?: string) => ({
  type: 'apiLink',
  resource: {
    type,
    id: pageId ?? documentId,
    href: `https://docs.superhuman.com/apis/v1/docs/${documentId}${pageId ? `/pages/${pageId}` : ''}`,
    name,
  },
});

describe('Superhuman Docs link resolution', () => {
  it('uses only validated API resource IDs, preserving underscores and whole-document selection', async () => {
    const calls: URL[] = [];
    const result = await resolveSuperhumanBrowserLinks(
      [
        'https://docs.superhuman.com/d/a-browser-slug_d_fake#heading',
        'https://docs.superhuman.com/d/another-browser-slug',
      ],
      credential,
      {
        fetch: async url => {
          calls.push(url);
          return json(
            calls.length === 1
              ? resolved('page', 'doc_01', 'page_a', 'First page')
              : resolved('doc', 'doc_01', undefined, 'Full document'),
          );
        },
      },
    );
    expect(result.documents).toEqual([{id: 'doc_01'}]);
    expect(result.selections).toEqual([{documentId: 'doc_01', name: 'Full document'}]);
    expect(calls.map(url => url.pathname)).toEqual(['/apis/v1/resolveBrowserLink', '/apis/v1/resolveBrowserLink']);
    expect(calls[0]?.searchParams.get('url')).toBe('https://docs.superhuman.com/d/a-browser-slug_d_fake#heading');
  });

  it('rejects cross-origin browser URLs and resource hrefs without echoing either token or provider reply', async () => {
    const fetch = async () =>
      json({
        type: 'apiLink',
        resource: {
          type: 'page',
          id: 'page_1',
          href: 'https://evil.example/apis/v1/docs/doc_1/pages/page_1',
          name: 'private',
        },
      });
    await expect(resolveSuperhumanBrowserLinks(['https://evil.example/d/a'], credential, {fetch})).rejects.toThrow(
      /Superhuman Docs/,
    );
    await expect(
      resolveSuperhumanBrowserLinks(['https://docs.superhuman.com/d/a'], credential, {fetch}),
    ).rejects.toThrow(/out-of-scope/);
    await expect(
      resolveSuperhumanBrowserLinks(['https://docs.superhuman.com/d/a'], credential, {
        fetch: async () =>
          json({
            type: 'apiLink',
            resource: {
              type: 'page',
              id: 'page_wrong',
              href: 'https://docs.superhuman.com/apis/v1/docs/doc_1/pages/page_right',
            },
          }),
      }),
    ).rejects.toThrow(/invalid/);
    await expect(
      resolveSuperhumanBrowserLinks(['https://docs.superhuman.com/d/a'], credential, {
        fetch: async () => json(resolved('page', 'doc_1', 'page_1', 'synthetic-manager-token')),
      }),
    ).rejects.toThrow(/sensitive/);
  });

  it('merges duplicate page selections independently of order and whole-doc links subsume pages', () => {
    const arb = fc.array(
      fc.record({
        documentId: fc.constantFrom('doc_one', 'doc_Two'),
        pageId: fc.option(fc.constantFrom('page_one', 'page_Two'), {nil: undefined}),
        name: fc.constantFrom('Alpha', 'Beta'),
      }),
      {minLength: 1, maxLength: 12},
    );
    fc.assert(
      fc.property(arb, selections => {
        const left = mergeResolvedSuperhumanSelections(selections);
        const right = mergeResolvedSuperhumanSelections([...selections].reverse());
        expect(left).toEqual(right);
        expect(mergeResolvedSuperhumanSelections(left.selections)).toEqual(left);
        expect(new Set(left.documents.map(document => document.id)).size).toBe(left.documents.length);
      }),
      {numRuns: 100},
    );
  });
});

let home: string;
let server: ManagerTestServer;
const authToken = 'manager-superhuman-test-token';
const credentialEnvName = 'TEST_SUPERHUMAN_MANAGER_TOKEN';
beforeEach(async () => {
  process.env[credentialEnvName] = 'synthetic-manager-token';
  home = await mkdtemp(join(tmpdir(), 'manager-superhuman-'));
  const config: RuntimeConfig = {
    agentContextHome: home,
    account: 'local',
    agentId: 'threadnote',
    user: 'tester',
    manifestPath: join(home, 'seed-manifest.yaml'),
  };
  server = await startManagerTestServer(config, authToken);
});
afterEach(async () => {
  await server?.close();
  if (home) await rm(home, {recursive: true, force: true});
  delete process.env[credentialEnvName];
});

async function request(path: string, body?: Record<string, unknown>, authorized = true) {
  const response = await testHttpFetch(server.url + path, {
    method: body ? 'POST' : 'GET',
    headers: {...(authorized ? {authorization: `Bearer ${authToken}`} : {}), 'content-type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
  return {status: response.status, body: (await response.json()) as Record<string, unknown>};
}

describe('Manager Superhuman integration HTTP boundary', () => {
  it('rejects unsafe resolver input with a static response that omits the submitted credential', async () => {
    const response = await request('/api/integrations/superhuman', {
      action: 'resolve-links',
      links: ['https://other.example/d/a'],
      token: 'synthetic-manager-token',
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('synthetic-manager-token');
    expect(JSON.stringify(response.body)).not.toContain('other.example');
  });

  it('keeps both provider lists offline, protected by Manager auth, and hides credentials', async () => {
    const configPath = join(home, 'threadnote', 'sources.yaml');
    await mkdir(join(home, 'threadnote'), {recursive: true});
    await writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        sources: [
          {type: 'obsidian', id: 'vault', vault: home, include: ['**/*.md'], exclude: []},
          {
            type: 'superhuman',
            id: 'docs',
            project: 'demo',
            credential_env: 'SYNTHETIC_SECRET_ENV',
            documents: [{id: 'doc_1'}],
          },
        ],
        projections: [],
      }),
    );
    expect((await request('/api/integrations', undefined, false)).status).toBe(401);
    const response = await request('/api/integrations');
    expect(response.status).toBe(200);
    expect((response.body.obsidian as {sources: {id: string}[]}).sources.map(source => source.id)).toEqual(['vault']);
    const source = (response.body.superhuman as {sources: Record<string, unknown>[]}).sources[0];
    expect(source).toMatchObject({id: 'docs', credentialConfigured: false, status: 'needs-attention', chunks: 0});
    expect(JSON.stringify(response.body)).not.toContain('synthetic-manager-token');
    expect((await request('/api/integrations/superhuman')).status).toBe(200);
    expect((await request('/api/integrations/obsidian')).status).toBe(200);
  });

  it('requires explicit confirmation and preserves Obsidian while pausing and removing a Superhuman source', async () => {
    const configPath = join(home, 'threadnote', 'sources.yaml');
    await mkdir(join(home, 'threadnote'), {recursive: true});
    await writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        sources: [
          {type: 'obsidian', id: 'vault', vault: home, include: ['**/*.md'], exclude: []},
          {
            type: 'superhuman',
            id: 'docs',
            project: 'demo',
            credential_env: 'SYNTHETIC_SECRET_ENV',
            documents: [{id: 'doc_1'}],
          },
        ],
        projections: [],
      }),
    );
    expect(
      (await request('/api/integrations/superhuman', {action: 'set-enabled', id: 'docs', enabled: false, apply: true}))
        .status,
    ).toBe(400);
    expect(
      (
        await request('/api/integrations/superhuman', {
          action: 'set-enabled',
          id: 'docs',
          enabled: false,
          apply: true,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    let sources = parseSourceConfiguration(await readFile(configPath, 'utf8')).sources;
    expect(sources.find(source => source.id === 'docs')?.enabled).toBe(false);
    expect(sources.find(source => source.id === 'vault')?.type).toBe('obsidian');
    expect((await request('/api/integrations/superhuman', {action: 'remove-source', id: 'docs'})).status).toBe(200);
    expect(parseSourceConfiguration(await readFile(configPath, 'utf8')).sources).toHaveLength(2);
    expect(
      (await request('/api/integrations/superhuman', {action: 'remove-source', id: 'docs', apply: true, confirm: true}))
        .status,
    ).toBe(200);
    sources = parseSourceConfiguration(await readFile(configPath, 'utf8')).sources;
    expect(sources.map(source => source.id)).toEqual(['vault']);
  });

  it('creates and edits a local-token source while retaining its paused state and page selections', async () => {
    const create = await request('/api/integrations/superhuman', {
      action: 'save-source',
      id: 'docs',
      editing: false,
      token: 'synthetic-manager-token',
      documents: [{id: 'doc_1', pages: ['page_one', 'page_Two']}],
      project: 'demo',
      includeHidden: false,
      refreshIntervalMinutes: 15,
      maxStaleHours: 24,
      apply: true,
      confirm: true,
    });
    expect(create.status).toBe(200);
    expect(JSON.stringify(create.body)).not.toContain('synthetic-manager-token');
    const configPath = join(home, 'threadnote', 'sources.yaml');
    let configured = parseSourceConfiguration(await readFile(configPath, 'utf8')).sources[0];
    expect(configured).toMatchObject({
      type: 'superhuman',
      id: 'docs',
      credentialStorage: 'local',
      documents: [{id: 'doc_1', pages: ['page_one', 'page_Two']}],
    });
    expect(await readFile(join(home, 'threadnote', 'credentials', 'superhuman', 'docs'), 'utf8')).toBe(
      'synthetic-manager-token',
    );
    expect(
      (
        await request('/api/integrations/superhuman', {
          action: 'set-enabled',
          id: 'docs',
          enabled: false,
          apply: true,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    const edited = await request('/api/integrations/superhuman', {
      action: 'save-source',
      id: 'docs',
      editing: true,
      token: '',
      documents: [{id: 'doc_2', pages: ['page_Two']}],
      project: null,
      includeHidden: true,
      refreshIntervalMinutes: 30,
      maxStaleHours: 48,
      apply: true,
      confirm: true,
    });
    expect(edited.status).toBe(200);
    configured = parseSourceConfiguration(await readFile(configPath, 'utf8')).sources[0];
    expect(configured).toMatchObject({
      enabled: false,
      project: null,
      credentialStorage: 'local',
      documents: [{id: 'doc_2', pages: ['page_Two']}],
    });
    expect(await readFile(join(home, 'threadnote', 'credentials', 'superhuman', 'docs'), 'utf8')).toBe(
      'synthetic-manager-token',
    );
  });

  it('supports explicit environment credentials and rejects missing variables without storing a token', async () => {
    const base = {
      action: 'save-source',
      id: 'docs',
      editing: false,
      documents: [{id: 'doc_env'}],
      project: null,
      includeHidden: false,
      refreshIntervalMinutes: 15,
      maxStaleHours: 24,
      apply: true,
      confirm: true,
    };
    const missing = await request('/api/integrations/superhuman', {
      ...base,
      credentialEnv: 'TEST_SUPERHUMAN_MANAGER_MISSING',
    });
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).not.toContain('TEST_SUPERHUMAN_MANAGER_MISSING');
    const saved = await request('/api/integrations/superhuman', {...base, credentialEnv: credentialEnvName});
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain('synthetic-manager-token');
    const configPath = join(home, 'threadnote', 'sources.yaml');
    const source = parseSourceConfiguration(await readFile(configPath, 'utf8')).sources[0];
    expect(source).toMatchObject({type: 'superhuman', credentialEnv: credentialEnvName});
    expect(source).not.toHaveProperty('credentialStorage');
    const listed = await request('/api/integrations/superhuman');
    expect((listed.body.sources as Record<string, unknown>[])[0]).toMatchObject({credentialConfigured: true});
    const resolvedWithEnvironment = await request('/api/integrations/superhuman', {
      action: 'resolve-links',
      links: ['https://other.example/d/a'],
      credentialEnv: credentialEnvName,
    });
    expect(resolvedWithEnvironment.status).toBe(400);
    expect(resolvedWithEnvironment.body).toEqual({error: 'Choose a Superhuman Docs document link.'});
    await expect(readFile(join(home, 'threadnote', 'credentials', 'superhuman', 'docs'), 'utf8')).rejects.toMatchObject(
      {code: 'ENOENT'},
    );
    expect(
      (await request('/api/integrations/superhuman', {...base, editing: true, token: 'synthetic-manager-token'}))
        .status,
    ).toBe(200);
    expect(await readFile(join(home, 'threadnote', 'credentials', 'superhuman', 'docs'), 'utf8')).toBe(
      'synthetic-manager-token',
    );
    expect(
      (await request('/api/integrations/superhuman', {...base, editing: true, credentialEnv: credentialEnvName}))
        .status,
    ).toBe(200);
    expect(parseSourceConfiguration(await readFile(configPath, 'utf8')).sources[0]).not.toHaveProperty(
      'credentialStorage',
    );
    await expect(readFile(join(home, 'threadnote', 'credentials', 'superhuman', 'docs'), 'utf8')).rejects.toMatchObject(
      {code: 'ENOENT'},
    );
  });
});
