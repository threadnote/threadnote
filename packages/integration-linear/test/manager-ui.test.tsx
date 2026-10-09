// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ManagerDialogProvider} from '@threadnote/manager/dialog';
import {IntegrationsPanel} from '@threadnote/manager/integrations-view';
import {linearIntegration} from '../src/manager-ui/index.js';
import {LinearConnectionForm, parseLinearIds} from '../src/manager-ui/connection-form.js';
import fc from 'fast-check';
import type {LinearSource} from '../src/manager-contracts.js';

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
              linear: {sources: [linearSource]},
            }),
          ),
      ),
    );
    await render(
      <IntegrationsPanel
        integrations={[linearIntegration]}
        onChanged={async () => undefined}
        onReviews={() => undefined}
      />,
    );
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
    await render(
      <IntegrationsPanel
        integrations={[linearIntegration]}
        onChanged={async () => undefined}
        onReviews={() => undefined}
      />,
    );
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
    await render(
      <IntegrationsPanel
        integrations={[linearIntegration]}
        onChanged={async () => undefined}
        onReviews={() => undefined}
      />,
    );
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
