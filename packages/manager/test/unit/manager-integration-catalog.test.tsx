// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import fc from 'fast-check';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ManagerDialogProvider} from '../../src/dialog.js';
import {filteredIntegrationProducts, integrationProducts} from '../../src/integration_catalog.js';
import {IntegrationsPanel} from '../../src/integrations_view.js';
import {SuperhumanConnectionForm} from '../../src/superhuman_connection_form.js';
import {PocketConnectionForm} from '../../src/pocket_connection_form.js';
import {LinearConnectionForm, parseLinearIds} from '../../src/linear_connection_form.js';
import {GitHubConnectionForm} from '../../src/github_connection_form.js';
import {MANAGER_STATIC_FILES} from '../../src/server.js';
import type {LinearSource, SuperhumanSource} from '../../src/integrations_contracts.js';

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function render(node: React.ReactNode): Promise<void> {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<ManagerDialogProvider>{node}</ManagerDialogProvider>));
}
function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(item => item.textContent?.trim().startsWith(label));
  if (!match) throw new Error('Button not found: ' + label);
  return match;
}
async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}
async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', {bubbles: true}));
  });
}
const source: SuperhumanSource = {
  id: 'team-docs',
  enabled: true,
  project: 'team',
  documents: [{id: 'Doc_Inner_S', pages: ['Page_1']}],
  credentialEnv: 'SUPERHUMAN_DOCS_API_TOKEN',
  credentialStorage: 'local',
  credentialConfigured: true,
  includeHidden: false,
  refreshIntervalMinutes: 15,
  maxStaleHours: 24,
  status: 'needs-sync',
  chunks: 0,
};
const savedSelection = {
  documents: source.documents,
  selections: [
    {
      documentId: 'Doc_Inner_S',
      pageId: 'Page_1',
      name: 'Selected page',
      browserLink: 'https://docs.superhuman.com/d/synthetic/page-one',
    },
  ],
};
const mixed = {
  obsidian: {
    sources: [{id: 'notes', vault: '/vault', include: ['**/*.md'], exclude: [], enabled: true, watch: false}],
    projections: [],
  },
  superhuman: {sources: [source]},
  pocket: {sources: []},
  linear: {
    sources: [
      {
        id: 'linear-example',
        enabled: true,
        organizationId: 'org',
        principalId: 'user',
        teamIds: ['team'],
        projectIds: ['project'],
        issueIds: [],
        project: null,
        credentialEnv: 'THREADNOTE_LINEAR_API_KEY',
        credentialConfigured: true,
        refreshIntervalMinutes: 15,
        maxStaleHours: 24,
        status: 'active',
        issues: 1,
        documents: 0,
        updates: 0,
        chunks: 1,
      },
    ],
  },
  github: {
    sources: [
      {
        id: 'repo-discussions',
        enabled: true,
        project: null,
        repositories: ['openai/threadnote'],
        credentialEnv: 'THREADNOTE_GITHUB_TOKEN',
        credentialStorage: 'local' as const,
        credentialConfigured: true,
        refreshIntervalMinutes: 15,
        maxStaleHours: 24,
        status: 'active' as const,
        conversations: 12,
        chunks: 18,
        lastReconciledAt: 1_800_000_000_000,
      },
    ],
  },
};

describe('Integration catalog', () => {
  it('registers official product images and filters by product or capability', () => {
    expect(MANAGER_STATIC_FILES['/integrations/obsidian.svg']?.sourceDirectory).toBe('packages/manager/static');
    expect(MANAGER_STATIC_FILES['/integrations/superhuman-docs.png']?.contentType).toBe('image/png');
    expect(MANAGER_STATIC_FILES['/integrations/pocket.png']?.contentType).toBe('image/png');
    expect(MANAGER_STATIC_FILES['/integrations/linear.svg']?.contentType).toBe('image/svg+xml');
    expect(MANAGER_STATIC_FILES['/integrations/github.svg']?.sourceDirectory).toBe('packages/manager/static');
    expect(filteredIntegrationProducts('recordings').map(product => product.id)).toEqual(['pocket']);
    expect(filteredIntegrationProducts('canvas').map(product => product.id)).toEqual(['superhuman']);
    expect(filteredIntegrationProducts('repositories').map(product => product.id)).toEqual(['github']);
    expect(filteredIntegrationProducts('export').map(product => product.id)).toEqual(['obsidian']);
    expect(filteredIntegrationProducts('issues').map(product => product.id)).toEqual(['linear', 'github']);
  });
  it('is invariant to query case and surrounding whitespace', () => {
    fc.assert(
      fc.property(fc.constantFrom('Obsidian', 'Superhuman', 'canvas', 'export', 'read only'), query => {
        expect(filteredIntegrationProducts(query)).toEqual(filteredIntegrationProducts(`  ${query.toUpperCase()}  `));
        expect(filteredIntegrationProducts(query).every(product => integrationProducts.includes(product))).toBe(true);
      }),
      {numRuns: 30},
    );
  });
  it('shows a mixed connection list and narrows catalog and connections by product', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(mixed))),
    );
    await render(<IntegrationsPanel onChanged={async () => undefined} onReviews={() => undefined} />);
    expect(document.body.textContent).toContain('Available integrations');
    expect(document.body.textContent).toContain('Your connections');
    expect(document.body.textContent).toContain('notes');
    expect(document.body.textContent).toContain('team-docs');
    expect(document.body.textContent).toContain('repo-discussions');
    expect(
      document.querySelector<HTMLButtonElement>('#integration-connections-tab')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(document.querySelectorAll('.integration-product')).toHaveLength(0);
    await act(async () => {
      document
        .querySelector<HTMLElement>('#integration-connections-tab')!
        .dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
    });
    expect(document.querySelector<HTMLButtonElement>('#integration-catalog-tab')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    await act(async () => button('Your connections').click());
    await act(async () => button('Superhuman Docs').click());
    expect(document.body.textContent).toContain('team-docs');
    expect(document.body.textContent).not.toContain('/vault');
    expect(document.querySelectorAll('img[src="/integrations/superhuman-docs.png"]').length).toBeGreaterThan(0);
    await act(async () => button('Add integration').click());
    expect(document.querySelector<HTMLButtonElement>('#integration-catalog-tab')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(document.querySelectorAll('.integration-product')).toHaveLength(5);
    expect(document.querySelectorAll('.integration-row')).toHaveLength(0);
    await act(async () => button('Your connections').click());
    await act(async () => button('All').click());
    await fill(document.querySelector<HTMLInputElement>('input[aria-label="Search your connections"]')!, 'notes');
    expect(document.body.textContent).toContain('/vault');
    expect(document.body.textContent).not.toContain('team-docs');
    await act(async () => button('All').click());
    await act(async () => button('GitHub').click());
    await fill(document.querySelector<HTMLInputElement>('input[aria-label="Search your connections"]')!, '');
    expect(document.body.textContent).toContain('openai/threadnote');
    expect(document.body.textContent).toContain('Discussions checked');
  });
  it('opens the catalog from an empty state and returns to connections after setup', async () => {
    let configured = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init: RequestInit) => {
        if (path === '/api/integrations')
          return new Response(
            JSON.stringify(
              configured
                ? mixed
                : {
                    obsidian: {sources: [], projections: []},
                    superhuman: {sources: []},
                    pocket: {sources: []},
                    linear: {sources: []},
                    github: {sources: []},
                  },
            ),
          );
        const body = JSON.parse(String(init.body));
        if (body.action === 'resolve-links')
          return new Response(
            JSON.stringify({
              documents: [{id: 'Doc_Inner_S', pages: ['Page_1']}],
              selections: [{documentId: 'Doc_Inner_S', pageId: 'Page_1', name: 'Selected page'}],
            }),
          );
        if (body.action === 'save-source') configured = true;
        return new Response('{}');
      }),
    );
    await render(<IntegrationsPanel onChanged={async () => undefined} onReviews={() => undefined} />);
    expect(
      document.querySelector<HTMLButtonElement>('#integration-connections-tab')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(document.body.textContent).toContain('No connections yet');
    await act(async () => button('Browse integrations').click());
    expect(document.querySelectorAll('.integration-product')).toHaveLength(5);
    await act(async () => button('Connect Superhuman Docs').click());
    await fill(document.querySelector<HTMLInputElement>('input[placeholder="team-docs"]')!, 'team-docs');
    await fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-token');
    await fill(
      document.querySelector<HTMLTextAreaElement>('textarea')!,
      'https://docs.superhuman.com/d/synthetic/page',
    );
    await choose(document.querySelector<HTMLSelectElement>('select')!, 'projectless');
    await act(async () => button('Add links').click());
    await act(async () => button('Create connection').click());
    expect(
      document.querySelector<HTMLButtonElement>('#integration-connections-tab')?.getAttribute('aria-selected'),
    ).toBe('true');
    expect(document.querySelectorAll('.integration-product')).toHaveLength(0);
    expect(document.body.textContent).toContain('team-docs');
  });
});

describe('Superhuman Docs connection', () => {
  it('requires checked links, invalidates scope on edits, and saves only resolved IDs with an explicit project', async () => {
    const calls: {path: string; body: Record<string, unknown>}[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push({path, body});
        return new Response(
          JSON.stringify(
            body.action === 'resolve-links'
              ? {
                  documents: [{id: 'Doc_Inner_S', pages: ['Page_1']}],
                  selections: [{documentId: 'Doc_Inner_S', pageId: 'Page_1', name: 'Selected page'}],
                }
              : {},
          ),
        );
      }),
    );
    await render(<SuperhumanConnectionForm onClose={() => undefined} onSaved={async () => undefined} />);
    await fill(document.querySelector<HTMLInputElement>('input[placeholder="team-docs"]')!, 'team-docs');
    await fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-token');
    const links = document.querySelector<HTMLTextAreaElement>('textarea')!;
    await fill(links, 'https://docs.superhuman.com/d/synthetic/page-one');
    expect(button('Create connection').disabled).toBe(true);
    await act(async () => button('Add links').click());
    expect(calls[0]).toEqual({
      path: '/api/integrations/superhuman',
      body: {
        action: 'resolve-links',
        links: ['https://docs.superhuman.com/d/synthetic/page-one'],
        token: 'synthetic-token',
      },
    });
    expect(document.body.textContent).toContain('1 selected page');
    await fill(links, 'https://docs.superhuman.com/d/synthetic/page-two');
    expect(button('Create connection').disabled).toBe(true);
    await act(async () => button('Add links').click());
    await fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'replacement-token');
    expect(button('Create connection').disabled).toBe(true);
    await act(async () => button('Check links').click());
    await choose(document.querySelector<HTMLSelectElement>('select')!, 'project');
    await fill(document.querySelector<HTMLInputElement>('input[placeholder="my-project"]')!, 'team');
    await act(async () => button('Create connection').click());
    expect(calls.at(-1)?.body).toEqual({
      action: 'save-source',
      id: 'team-docs',
      editing: false,
      token: 'replacement-token',
      documents: [{id: 'Doc_Inner_S', pages: ['Page_1']}],
      project: 'team',
      includeHidden: false,
      refreshIntervalMinutes: 15,
      maxStaleHours: 24,
      apply: true,
      confirm: true,
    });
    expect(localStorage.length).toBe(0);
  });
  it('keeps the existing scope and credential without putting a token in settings', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.action === 'describe-selection') return new Response(JSON.stringify(savedSelection));
        calls.push(body);
        return new Response('{}');
      }),
    );
    await render(
      <SuperhumanConnectionForm source={source} onClose={() => undefined} onSaved={async () => undefined} />,
    );
    expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
    expect(document.querySelector('.integration-link-chip')?.textContent).toContain('Selected page');
    await act(async () => button('Save settings').click());
    expect(calls).toEqual([
      {
        action: 'save-source',
        id: 'team-docs',
        editing: true,
        documents: [{id: 'Doc_Inner_S', pages: ['Page_1']}],
        project: 'team',
        includeHidden: false,
        refreshIntervalMinutes: 15,
        maxStaleHours: 24,
        apply: true,
        confirm: true,
      },
    ]);
  });
  it('rotates an existing token without re-entering the retained scope', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.action === 'describe-selection') return new Response(JSON.stringify(savedSelection));
        calls.push(body);
        return new Response('{}');
      }),
    );
    await render(
      <SuperhumanConnectionForm source={source} onClose={() => undefined} onSaved={async () => undefined} />,
    );
    await fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'replacement-token');
    expect(button('Save settings').disabled).toBe(false);
    expect(document.querySelector('.integration-link-chip')?.textContent).toContain('Selected page');
    await act(async () => button('Save settings').click());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      action: 'save-source',
      id: 'team-docs',
      editing: true,
      token: 'replacement-token',
      documents: [{id: 'Doc_Inner_S', pages: ['Page_1']}],
      project: 'team',
      apply: true,
      confirm: true,
    });
    expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
  });
  it('binds a new connection to an environment variable without sending a token', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push(body);
        return new Response(
          JSON.stringify(
            body.action === 'resolve-links'
              ? {
                  documents: [{id: 'Doc_Inner_S'}],
                  selections: [{documentId: 'Doc_Inner_S', name: 'Selected document'}],
                }
              : {},
          ),
        );
      }),
    );
    await render(<SuperhumanConnectionForm onClose={() => undefined} onSaved={async () => undefined} />);
    await fill(document.querySelector<HTMLInputElement>('input[placeholder="team-docs"]')!, 'team-docs');
    await act(async () => document.querySelector<HTMLElement>('.integration-advanced summary')!.click());
    const envRadio = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1];
    await act(async () => envRadio.click());
    await fill(document.querySelector<HTMLInputElement>('input[pattern="[A-Z_][A-Z0-9_]*"]')!, 'DOCS_READ_TOKEN');
    await fill(document.querySelector<HTMLTextAreaElement>('textarea')!, 'https://docs.superhuman.com/d/synthetic');
    await choose(document.querySelector<HTMLSelectElement>('select')!, 'projectless');
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await act(async () => button('Add links').click());
    expect(calls[0]).toEqual({
      action: 'resolve-links',
      links: ['https://docs.superhuman.com/d/synthetic'],
      credentialEnv: 'DOCS_READ_TOKEN',
    });
    await fill(document.querySelector<HTMLInputElement>('input[pattern="[A-Z_][A-Z0-9_]*"]')!, 'DOCS_NEW_TOKEN');
    expect(button('Create connection').disabled).toBe(true);
    await act(async () => button('Check links').click());
    await act(async () => button('Create connection').click());
    expect(calls[2]).toEqual({
      action: 'save-source',
      id: 'team-docs',
      editing: false,
      credentialEnv: 'DOCS_NEW_TOKEN',
      documents: [{id: 'Doc_Inner_S'}],
      project: null,
      includeHidden: false,
      refreshIntervalMinutes: 15,
      maxStaleHours: 24,
      apply: true,
      confirm: true,
    });
  });
  it('shows an existing environment binding and keeps scope on credential-name edit', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.action === 'describe-selection') return new Response(JSON.stringify(savedSelection));
        calls.push(body);
        return new Response('{}');
      }),
    );
    await render(
      <SuperhumanConnectionForm
        source={{...source, credentialStorage: undefined, credentialEnv: 'DOCS_READ_TOKEN'}}
        onClose={() => undefined}
        onSaved={async () => undefined}
      />,
    );
    expect(document.querySelector('input[type="password"]')).toBeNull();
    const name = document.querySelector<HTMLInputElement>('input[pattern="[A-Z_][A-Z0-9_]*"]')!;
    expect(name.value).toBe('DOCS_READ_TOKEN');
    await fill(name, 'DOCS_REPLACEMENT_TOKEN');
    expect(button('Save settings').disabled).toBe(false);
    await act(async () => button('Save settings').click());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      action: 'save-source',
      id: 'team-docs',
      credentialEnv: 'DOCS_REPLACEMENT_TOKEN',
      documents: [{id: 'Doc_Inner_S', pages: ['Page_1']}],
      apply: true,
      confirm: true,
    });
    expect(calls[0]).not.toHaveProperty('token');
  });
  it('syncs, pauses, and disconnects using explicit confirmed local actions', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        if (!init.body) return new Response(JSON.stringify(mixed));
        const body = JSON.parse(String(init.body));
        calls.push(body);
        return new Response(
          JSON.stringify({
            applied: true,
            output: '1 selected document(s) refreshed.',
            entries: [],
            warnings: ['One page was skipped.'],
          }),
        );
      }),
    );
    await render(<IntegrationsPanel onChanged={async () => undefined} onReviews={() => undefined} />);
    await act(async () => button('Sync now').click());
    expect(calls[0]).toEqual({action: 'sync-source', id: 'team-docs', apply: true, confirm: true});
    expect(document.body.textContent).toContain('One page was skipped.');
    expect(document.body.textContent).toContain('Some documents could not be imported.');
    expect(document.body.textContent).toContain('Sync finished with warnings.');
    expect(document.body.textContent).toContain('1 selected document(s) refreshed.');
    expect(document.body.textContent).not.toContain('No local changes needed.');
    await act(async () => button('Done').click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Actions for Superhuman Docs team-docs"]')!.click(),
    );
    await act(async () => button('Pause connection').click());
    expect(calls[1]).toEqual({action: 'set-enabled', id: 'team-docs', enabled: false, apply: true, confirm: true});
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Actions for Superhuman Docs team-docs"]')!.click(),
    );
    await act(async () => button('Disconnect…').click());
    expect(calls).toHaveLength(2);
    await act(async () => button('Disconnect').click());
    expect(calls[2]).toEqual({action: 'remove-source', id: 'team-docs', apply: true, confirm: true});
  });
});

describe('GitHub connection', () => {
  it('saves only explicitly selected repositories with a protected local token and project choice', async () => {
    let saved: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        saved = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response('{}');
      }),
    );
    await render(<GitHubConnectionForm onClose={() => undefined} onSaved={async () => undefined} />);
    await fill(document.querySelector<HTMLInputElement>('input[placeholder="engineering"]')!, 'eng');
    await fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-token');
    await fill(
      document.querySelector<HTMLTextAreaElement>('textarea')!,
      'openai/threadnote\nhttps://github.com/openai/codex',
    );
    await choose(document.querySelector<HTMLSelectElement>('select')!, 'projectless');
    await act(async () => button('Connect and sync').click());
    expect(saved).toMatchObject({
      action: 'save-source',
      id: 'eng',
      repositories: ['openai/threadnote', 'https://github.com/openai/codex'],
      token: 'synthetic-token',
      project: null,
      apply: true,
      confirm: true,
    });
    expect(saved?.credentialEnv).toBeUndefined();
  });
});

describe('Pocket connection', () => {
  it('does not show an empty state when Pocket is the only connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              obsidian: {sources: [], projections: []},
              superhuman: {sources: []},
              github: {sources: []},
              pocket: {
                sources: [
                  {
                    id: 'only-pocket',
                    enabled: true,
                    project: null,
                    credentialEnv: 'POCKET_API_KEY',
                    credentialStorage: 'local',
                    credentialConfigured: true,
                    refreshIntervalMinutes: 15,
                    maxStaleHours: 24,
                    status: 'needs-sync',
                    recordings: 0,
                    chunks: 0,
                  },
                ],
              },
            }),
          ),
      ),
    );
    await render(<IntegrationsPanel onChanged={async () => undefined} onReviews={() => undefined} />);
    expect(document.body.textContent).toContain('only-pocket');
    expect(document.body.textContent).not.toContain('No matching connections');
    expect(document.body.textContent).not.toContain('No connections yet');
  });
  it('shows a Pocket connection and sends confirmed sync and pause actions', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        if (!init.body)
          return new Response(
            JSON.stringify({
              ...mixed,
              pocket: {
                sources: [
                  {
                    id: 'my-pocket',
                    enabled: true,
                    project: null,
                    credentialEnv: 'POCKET_API_KEY',
                    credentialStorage: 'local',
                    credentialConfigured: true,
                    refreshIntervalMinutes: 15,
                    maxStaleHours: 24,
                    status: 'active',
                    recordings: 2,
                    chunks: 4,
                  },
                ],
              },
            }),
          );
        calls.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({applied: true, output: '2 recording(s) refreshed.', entries: []}));
      }),
    );
    await render(<IntegrationsPanel onChanged={async () => undefined} onReviews={() => undefined} />);
    expect(document.body.textContent).toContain('my-pocket');
    expect(document.body.textContent).toContain('2 recordings');
    await act(async () => button('Pocket').click());
    expect(document.body.textContent).not.toContain('team-docs');
    await act(async () => button('Sync now').click());
    expect(calls[0]).toEqual({action: 'sync-source', id: 'my-pocket', apply: true, confirm: true});
    await act(async () => button('Done').click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Actions for Pocket my-pocket"]')!.click(),
    );
    await act(async () => button('Pause connection').click());
    expect(calls[1]).toEqual({action: 'set-enabled', id: 'my-pocket', enabled: false, apply: true, confirm: true});
  });
  it('saves a key and projectless scope without a recording picker', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)));
        return new Response('{}');
      }),
    );
    await render(<PocketConnectionForm onClose={() => undefined} onSaved={async () => undefined} />);
    expect(document.body.textContent).toContain('All recordings accessible to this API key are imported automatically');
    expect(document.querySelector('textarea')).toBeNull();
    await fill(document.querySelector<HTMLInputElement>('input[placeholder="my-pocket"]')!, 'my-pocket');
    await fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-pocket-key');
    await choose(document.querySelector<HTMLSelectElement>('select')!, 'projectless');
    await act(async () => button('Connect and sync').click());
    expect(calls).toEqual([
      {
        action: 'save-source',
        id: 'my-pocket',
        editing: false,
        token: 'synthetic-pocket-key',
        project: null,
        refreshIntervalMinutes: 15,
        maxStaleHours: 24,
        apply: true,
        confirm: true,
      },
    ]);
    expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
  });
  it('retains the local key on a blank settings edit', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)));
        return new Response('{}');
      }),
    );
    await render(
      <PocketConnectionForm
        source={{
          id: 'my-pocket',
          enabled: true,
          project: 'team',
          credentialEnv: 'POCKET_API_KEY',
          credentialStorage: 'local',
          credentialConfigured: true,
          refreshIntervalMinutes: 15,
          maxStaleHours: 24,
          status: 'active',
          recordings: 2,
          chunks: 4,
        }}
        onClose={() => undefined}
        onSaved={async () => undefined}
      />,
    );
    expect(button('Save settings').disabled).toBe(false);
    await act(async () => button('Save settings').click());
    expect(calls[0]).toMatchObject({action: 'save-source', id: 'my-pocket', editing: true, project: 'team'});
    expect(calls[0]).not.toHaveProperty('token');
    expect(document.body.textContent).toContain('leave blank to keep the saved key');
  });
});

describe('Linear connection', () => {
  const teamId = '11111111-1111-4111-8111-111111111111';
  const projectId = '22222222-2222-4222-8222-222222222222';
  const issueId = '33333333-3333-4333-8333-333333333333';
  const organizationId = '44444444-4444-4444-8444-444444444444';
  const principalId = '55555555-5555-4555-8555-555555555555';
  const linearSource: LinearSource = {
    id: 'my-linear',
    enabled: true,
    organizationId,
    principalId,
    teamIds: [teamId],
    projectIds: [projectId],
    issueIds: [issueId],
    project: 'team',
    credentialEnv: 'THREADNOTE_LINEAR_API_KEY',
    credentialStorage: 'local',
    credentialConfigured: true,
    refreshIntervalMinutes: 60,
    maxStaleHours: 24,
    status: 'active',
    issues: 1,
    documents: 2,
    updates: 1,
    chunks: 4,
  };

  it('normalizes explicit IDs without adding scope', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.uuid(), {minLength: 1, maxLength: 8}), ids => {
        const normalized = ids.map(id => id.toLowerCase());
        expect(parseLinearIds(ids.join(',\n') + '\n' + ids[0])).toEqual(normalized);
        expect(parseLinearIds(parseLinearIds(ids.join(' ')).join('\n'))).toEqual(normalized);
      }),
      {numRuns: 40},
    );
  });

  it('marks Beta in catalog, connection card, and settings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              obsidian: {sources: [], projections: []},
              superhuman: {sources: []},
              pocket: {sources: []},
              linear: {sources: [linearSource]},
            }),
          ),
      ),
    );
    await render(<IntegrationsPanel onChanged={async () => undefined} onReviews={() => undefined} />);
    const row = document.querySelector('.integration-row')!;
    expect(row.textContent).toContain('Beta');
    expect(row.textContent).toContain('Inline comments and project update comments are unavailable');
    await act(async () => button('Add integration').click());
    const catalog = [...document.querySelectorAll('.integration-product')].find(item =>
      item.textContent?.includes('Linear'),
    )!;
    expect(catalog.textContent).toContain('Beta');
    await act(async () => button('Connect Linear').click());
    expect(document.querySelector('.integration-form-product')?.textContent).toContain('Beta');
  });

  it('verifies explicit scope before saving and clears verification after a scope edit', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push(body);
        return new Response(
          JSON.stringify(
            body.action === 'resolve-selection'
              ? {
                  organizationId,
                  principalId,
                  teams: [{id: teamId, name: 'Engineering'}],
                  projects: [{id: projectId, name: 'Planner'}],
                  issues: [
                    {
                      id: issueId,
                      identifier: 'ENG-1',
                      title: 'Scope task',
                      url: 'https://linear.app/example/issue/ENG-1',
                      teamId,
                      projectId,
                    },
                  ],
                }
              : {},
          ),
        );
      }),
    );
    await render(<LinearConnectionForm onClose={() => undefined} onSaved={async () => undefined} />);
    await fill(document.querySelector<HTMLInputElement>('input[placeholder="my-linear"]')!, 'my-linear');
    await fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-linear-key');
    await fill(document.querySelector<HTMLTextAreaElement>('textarea[placeholder="One team UUID per line"]')!, teamId);
    await fill(
      document.querySelector<HTMLTextAreaElement>('textarea[placeholder="One project UUID per line"]')!,
      projectId,
    );
    await fill(document.querySelector<HTMLInputElement>('input[placeholder="my-project"]')!, 'team');
    expect(button('Connect').disabled).toBe(true);
    await act(async () => button('Verify selection').click());
    expect(calls[0]).toMatchObject({
      action: 'resolve-selection',
      id: 'my-linear',
      teamIds: [teamId],
      projectIds: [projectId],
      token: 'synthetic-linear-key',
    });
    expect(button('Connect').disabled).toBe(false);
    await fill(
      document.querySelector<HTMLTextAreaElement>('textarea[placeholder="One issue UUID per line"]')!,
      issueId,
    );
    expect(button('Connect').disabled).toBe(true);
    await act(async () => button('Verify selection').click());
    await act(async () => button('Connect').click());
    expect(calls[2]).toMatchObject({
      action: 'save-source',
      id: 'my-linear',
      organizationId,
      principalId,
      teamIds: [teamId],
      projectIds: [projectId],
      issueIds: [issueId],
      project: 'team',
      token: 'synthetic-linear-key',
      apply: true,
      confirm: true,
    });
    expect((document.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('');
  });

  it('saves a new connection without starting sync and names the next action', async () => {
    let connected = false;
    const actions: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        if (path === '/api/integrations')
          return new Response(
            JSON.stringify({
              obsidian: {sources: [], projections: []},
              superhuman: {sources: []},
              pocket: {sources: []},
              linear: {sources: connected ? [linearSource] : []},
            }),
          );
        const body = JSON.parse(String(init?.body)) as {action: string};
        actions.push(body.action);
        if (body.action === 'resolve-selection')
          return new Response(
            JSON.stringify({
              organizationId,
              principalId,
              teams: [{id: teamId, name: 'Engineering'}],
              projects: [{id: projectId, name: 'Planner'}],
              issues: [],
            }),
          );
        if (body.action === 'save-source') connected = true;
        return new Response(JSON.stringify({applied: true, output: 'done', entries: []}));
      }),
    );
    await render(<IntegrationsPanel onChanged={async () => undefined} onReviews={() => undefined} />);
    await act(async () => button('Browse integrations').click());
    await act(async () => button('Connect Linear').click());
    await fill(document.querySelector<HTMLInputElement>('input[placeholder="my-linear"]')!, 'my-linear');
    await fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-linear-key');
    await fill(document.querySelector<HTMLTextAreaElement>('textarea[placeholder="One team UUID per line"]')!, teamId);
    await fill(
      document.querySelector<HTMLTextAreaElement>('textarea[placeholder="One project UUID per line"]')!,
      projectId,
    );
    await fill(document.querySelector<HTMLInputElement>('input[placeholder="my-project"]')!, 'team');
    await act(async () => button('Verify selection').click());
    const submit = document.querySelector<HTMLButtonElement>('.integration-form button[type="submit"]')!;
    expect(submit.textContent?.trim()).toBe('Connect');
    await act(async () => submit.click());
    expect(actions).toEqual(['resolve-selection', 'save-source']);
    expect(document.body.textContent).toContain(
      'Linear connection saved. Choose Sync now to import selected evidence.',
    );
    await act(async () => button('Sync now').click());
    expect(actions).toEqual(['resolve-selection', 'save-source', 'sync-source']);
  });

  it('uses the saved key when editing and sends confirmed sync and pause actions', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init: RequestInit) => {
        if (path === '/api/integrations')
          return new Response(
            JSON.stringify({
              obsidian: {sources: [], projections: []},
              superhuman: {sources: []},
              pocket: {sources: []},
              linear: {sources: [linearSource]},
            }),
          );
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push(body);
        return new Response(
          JSON.stringify(
            body.action === 'resolve-selection'
              ? {
                  organizationId,
                  principalId,
                  teams: [{id: teamId, name: 'Engineering'}],
                  projects: [{id: projectId, name: 'Planner'}],
                  issues: [
                    {
                      id: issueId,
                      identifier: 'ENG-1',
                      title: 'Scope task',
                      url: 'https://linear.app/example/issue/ENG-1',
                      teamId,
                      projectId,
                    },
                  ],
                }
              : {applied: true, output: 'done', entries: []},
          ),
        );
      }),
    );
    await render(<IntegrationsPanel onChanged={async () => undefined} onReviews={() => undefined} />);
    await act(async () => button('Sync now').click());
    expect(calls[0]).toEqual({action: 'sync-source', id: 'my-linear', apply: true, confirm: true});
    await act(async () => button('Done').click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Actions for Linear my-linear"]')!.click(),
    );
    await act(async () => button('Pause connection').click());
    expect(calls[1]).toEqual({action: 'set-enabled', id: 'my-linear', enabled: false, apply: true, confirm: true});
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Actions for Linear my-linear"]')!.click(),
    );
    await act(async () => button('Connection settings').click());
    await act(async () => button('Verify selection').click());
    await act(async () => button('Save settings').click());
    expect(calls[2]).toMatchObject({action: 'resolve-selection', id: 'my-linear'});
    expect(calls[2]).not.toHaveProperty('token');
    expect(calls[3]).toMatchObject({action: 'save-source', id: 'my-linear', editing: true});
    expect(calls[3]).not.toHaveProperty('token');
  });
});
