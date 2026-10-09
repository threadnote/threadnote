// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ManagerDialogProvider} from '@threadnote/manager/dialog';
import {IntegrationsPanel} from '@threadnote/manager/integrations-view';
import fc from 'fast-check';
import {filteredIntegrationProducts} from '@threadnote/manager/integration-catalog';
import {managerIntegrations} from '../../src/manager/integrations_ui.js';
import {MANAGER_STATIC_FILES} from '../../src/manager/static-files.js';
import type {SuperhumanSource} from '@threadnote/integration-superhuman/manager-contracts';

const integrationProducts = managerIntegrations.map(integration => integration.product);
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
    expect(MANAGER_STATIC_FILES['/integrations/obsidian.svg']?.sourceDirectory).toBe(
      'packages/integration-obsidian/static',
    );
    expect(MANAGER_STATIC_FILES['/integrations/superhuman-docs.png']?.contentType).toBe('image/png');
    expect(MANAGER_STATIC_FILES['/integrations/pocket.png']?.contentType).toBe('image/png');
    expect(MANAGER_STATIC_FILES['/integrations/linear.svg']?.contentType).toBe('image/svg+xml');
    expect(MANAGER_STATIC_FILES['/integrations/github.svg']?.sourceDirectory).toBe(
      'packages/integration-github/static',
    );
    expect(filteredIntegrationProducts(integrationProducts, 'recordings').map(product => product.id)).toEqual([
      'pocket',
    ]);
    expect(filteredIntegrationProducts(integrationProducts, 'canvas').map(product => product.id)).toEqual([
      'superhuman',
    ]);
    expect(filteredIntegrationProducts(integrationProducts, 'repositories').map(product => product.id)).toEqual([
      'github',
    ]);
    expect(filteredIntegrationProducts(integrationProducts, 'export').map(product => product.id)).toEqual(['obsidian']);
    expect(filteredIntegrationProducts(integrationProducts, 'issues').map(product => product.id)).toEqual([
      'linear',
      'github',
    ]);
  });
  it('is invariant to query case and surrounding whitespace', () => {
    fc.assert(
      fc.property(fc.constantFrom('Obsidian', 'Superhuman', 'canvas', 'export', 'read only'), query => {
        expect(filteredIntegrationProducts(integrationProducts, query)).toEqual(
          filteredIntegrationProducts(integrationProducts, `  ${query.toUpperCase()}  `),
        );
        expect(
          filteredIntegrationProducts(integrationProducts, query).every(product =>
            integrationProducts.includes(product),
          ),
        ).toBe(true);
      }),
      {numRuns: 30},
    );
  });
  it('shows a mixed connection list and narrows catalog and connections by product', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(mixed))),
    );
    await render(
      <IntegrationsPanel
        integrations={managerIntegrations}
        onChanged={async () => undefined}
        onReviews={() => undefined}
      />,
    );
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
    await render(
      <IntegrationsPanel
        integrations={managerIntegrations}
        onChanged={async () => undefined}
        onReviews={() => undefined}
      />,
    );
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
