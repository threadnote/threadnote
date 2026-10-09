// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ManagerDialogProvider} from '@threadnote/manager/dialog';
import {IntegrationsPanel} from '@threadnote/manager/integrations-view';
import {obsidianIntegration} from '../src/manager-ui/index.js';

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
describe('Obsidian integrations', () => {
  it.each([
    {label: 'Preview import', action: 'sync-source', id: 'notes', title: 'Preview vault import'},
    {label: 'Export memories', action: 'sync-projection', id: 'library', title: 'Export results'},
  ])('handles $label with the intended confirmation flow', async ({label, action, id, title}) => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        if (!init.body)
          return new Response(
            JSON.stringify({
              obsidian: {
                sources: [
                  {id: 'notes', vault: '/vault', include: ['**/*.md'], exclude: [], enabled: true, watch: false},
                ],
                projections: [
                  {
                    id: 'library',
                    vault: '/vault',
                    folder: 'Threadnote',
                    enabled: true,
                    kinds: ['durable'],
                    statuses: ['active'],
                    includeShared: false,
                  },
                ],
              },
            }),
          );
        const body = JSON.parse(init.body);
        calls.push(body);
        return new Response(
          JSON.stringify({
            applied: body.apply === true,
            output: '',
            entries: [
              {action: 'add', relativePath: 'Engineering/Architecture.md'},
              ...(body.action === 'sync-projection' ? [{action: 'drift', relativePath: 'Edited note.md'}] : []),
            ],
          }),
        );
      }),
    );
    await render(
      <IntegrationsPanel
        integrations={[obsidianIntegration]}
        onChanged={async () => undefined}
        onReviews={() => undefined}
      />,
    );
    await act(async () => {
      const action = [...document.querySelectorAll<HTMLButtonElement>('.integration-row-actions button')].find(item =>
        item.textContent?.trim().startsWith(label),
      );
      if (!action) throw new Error('Connection action not found: ' + label);
      action.click();
    });
    expect(document.body.textContent).toContain(title);
    if (action === 'sync-source') {
      expect(calls).toEqual([{action, id, apply: false}]);
      expect(document.body.textContent).toContain('Preview only.');
      expect(document.body.textContent).toContain('Engineering/Architecture.md');
      await act(async () => button('Apply changes').click());
      expect(calls).toEqual([
        {action, id, apply: false},
        {action, id, apply: true, confirm: true},
      ]);
    } else {
      expect(calls).toEqual([{action, id, apply: true, confirm: true}]);
      expect(document.body.textContent).not.toContain('Preview only.');
    }
    expect(Array.from(document.querySelectorAll('button')).some(item => item.textContent === 'Apply changes')).toBe(
      false,
    );
    expect(document.body.textContent).toContain('Engineering/Architecture.md');
    expect(button('Done').disabled).toBe(false);
    expect(document.body.textContent).toContain('Completed.');
    if (action === 'sync-projection') expect(document.body.textContent).toContain('1 edited file was left untouched.');
  });
});
