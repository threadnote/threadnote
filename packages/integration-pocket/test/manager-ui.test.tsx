// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ManagerDialogProvider} from '@threadnote/manager/dialog';
import {IntegrationsPanel} from '@threadnote/manager/integrations-view';
import {pocketIntegration} from '../src/manager-ui/index.js';
import {PocketConnectionForm} from '../src/manager-ui/connection-form.js';

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
describe('Pocket connection', () => {
  it('does not show an empty state when Pocket is the only connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
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
    await render(
      <IntegrationsPanel
        integrations={[pocketIntegration]}
        onChanged={async () => undefined}
        onReviews={() => undefined}
      />,
    );
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
    await render(
      <IntegrationsPanel
        integrations={[pocketIntegration]}
        onChanged={async () => undefined}
        onReviews={() => undefined}
      />,
    );
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
