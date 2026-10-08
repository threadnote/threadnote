// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ManagerDialogProvider} from '../../src/dialog.js';
import {ConflictResolver} from '../../src/sharing_conflicts.js';
import {IntegrationsPanel} from '../../src/integrations_view.js';

vi.mock('../../src/memory_editor.js', () => ({
  MemoryEditor: ({content, onChange}: {content: string; onChange: (value: string) => void}) => (
    <>
      <textarea aria-label="Resolution draft" value={content} readOnly />
      <button onClick={() => onChange(content + '\nMerged edit')}>Edit draft</button>
    </>
  ),
}));
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function render(node: React.ReactNode) {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<ManagerDialogProvider>{node}</ManagerDialogProvider>));
}
function button(label: string) {
  const match = Array.from(document.querySelectorAll('button')).find(item =>
    item.textContent?.trim().startsWith(label),
  );
  if (!match) throw new Error('Button not found: ' + label);
  return match;
}
const conflict = {
  id: 'team:durable/projects/demo/note.md',
  team: 'team',
  relativePath: 'durable/projects/demo/note.md',
  uri: 'threadnote://user/test/memories/shared/team/durable/projects/demo/note.md',
  revision: 'reviewed-revision',
  status: 'modified',
  reason: 'Changed',
  hasLocalContent: true,
  hasSharedContent: true,
  localContent: 'MEMORY\nkind: durable\nstatus: active\n\nLocal version.',
  sharedContent: 'MEMORY\nkind: durable\nstatus: active\n\nShared version.',
  diff: '-Local version.\n+Shared version.',
  canKeepLocal: true,
  canUseShared: true,
  canMerge: true,
  readOnly: false,
};
describe('Sharing conflict resolution', () => {
  it('shows both versions and applies only an explicit choice bound to the reviewed revision', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        if (init.body) calls.push(JSON.parse(init.body));
        return new Response(JSON.stringify(init.body ? {} : conflict));
      }),
    );
    const resolved = vi.fn(async () => undefined);
    await render(<ConflictResolver id={conflict.id} onClose={() => undefined} onResolved={resolved} />);
    expect(document.body.textContent).toContain('Local version.');
    expect(document.body.textContent).toContain('Shared version.');
    expect(button('Choose a resolution').disabled).toBe(true);
    expect(calls).toHaveLength(0);
    await act(async () => button('Keep local').click());
    await act(async () => button('Keep local and share').click());
    expect(calls).toEqual([{id: conflict.id, revision: 'reviewed-revision', resolution: 'local', confirm: true}]);
    expect(resolved).toHaveBeenCalledOnce();
  });
  it('keeps the manual draft visible when a newer version blocks resolution', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url, init) =>
          new Response(JSON.stringify(init.body ? {error: 'This conflict changed after you opened it.'} : conflict), {
            status: init.body ? 409 : 200,
          }),
      ),
    );
    const resolved = vi.fn(async () => undefined);
    await render(<ConflictResolver id={conflict.id} onClose={() => undefined} onResolved={resolved} />);
    await act(async () => button('Edit resolution').click());
    await act(async () => button('Edit draft').click());
    await act(async () => button('Save and share resolution').click());
    expect(document.body.textContent).toContain('changed after you opened it');
    expect((document.querySelector('[aria-label="Resolution draft"]') as HTMLTextAreaElement).value).toBe(
      conflict.localContent + '\nMerged edit',
    );
    expect(resolved).not.toHaveBeenCalled();
    expect(button('Reload versions')).toBeDefined();
  });
  it('disables accepting a different memory identity and editing read-only teams', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...conflict,
              identityConflict: 'changed',
              canUseShared: false,
              canKeepLocal: false,
              canMerge: false,
              readOnly: true,
            }),
          ),
      ),
    );
    await render(<ConflictResolver id={conflict.id} onClose={() => undefined} onResolved={async () => undefined} />);
    expect(button('Use shared').disabled).toBe(true);
    expect(button('Keep local').disabled).toBe(true);
    expect(button('Edit resolution').disabled).toBe(true);
    expect(document.body.textContent).toContain('different memory identities');
  });
});
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
              superhuman: {sources: []},
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
    await render(<IntegrationsPanel onChanged={async () => undefined} onReviews={() => undefined} />);
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
