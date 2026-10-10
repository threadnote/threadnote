// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {ManagerDialogProvider, useManagerDialogs, type ManagerDialogs} from '../../src/dialog.js';
import {requestGraphAdministrationAction} from '../../src/graph/index_action.js';
import type {GraphAdministrationAction, GraphIndexActionResponse} from '../../src/graph/model.js';

const target = {action: 'index', checkoutId: 'checkout', repositoryId: 'repository', worktreeId: 'worktree'} as const;
const selection = {
  scopeSelection: {
    expectedRevision: 'revision',
    projects: [
      {name: 'docs', roots: ['apps/docs']},
      {name: 'docs-mobile', roots: ['apps/docs-mobile']},
    ],
  },
};
let root: Root | undefined;
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('opens a scope dialog, requires an explicit choice, and forwards the exact Reindex intent', async () => {
  const request = vi
    .fn<
      (
        path: string,
        action: GraphAdministrationAction & {readonly confirm: boolean},
      ) => Promise<GraphIndexActionResponse>
    >()
    .mockResolvedValueOnce(selection)
    .mockResolvedValueOnce({output: 'ready'});
  const finish = vi.fn();
  function Harness() {
    const dialogs = useManagerDialogs();
    return (
      <button
        onClick={() => void requestGraphAdministrationAction({...target, full: true}, request, dialogs).then(finish)}
      >
        Reindex
      </button>
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ManagerDialogProvider>
        <Harness />
      </ManagerDialogProvider>,
    ),
  );
  await act(async () => document.querySelector<HTMLButtonElement>('button')?.click());
  expect(document.querySelector('dialog')?.open).toBe(true);
  expect(document.querySelector('dialog')?.textContent).toContain('Choose graph scope');
  expect(document.querySelector('dialog')?.textContent).toContain('apps/docs-mobile');
  const input = document.querySelector<HTMLInputElement>('dialog input')!;
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('');
  await act(async () =>
    document.querySelector('dialog form')?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
  );
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => input.click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    button => button.textContent === 'docs-mobile',
  )!;
  await act(async () => option.click());
  await act(async () =>
    document.querySelector('dialog form')?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
  );
  expect(request).toHaveBeenLastCalledWith('/api/graphs/action', {
    ...target,
    full: true,
    confirm: true,
    project: 'docs-mobile',
    expectedRevision: 'revision',
  });
  expect(finish).toHaveBeenCalledWith({output: 'ready'});
  expect(document.querySelector('dialog')).toBeNull();
});

it('preserves action identity and input bytes across bounded selection and cancellation sequences', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.boolean(),
      fc.boolean(),
      fc.integer({min: 0, max: 1}),
      fc.boolean(),
      async (full, cancel, chosen, explicitCwd) => {
        const action: GraphAdministrationAction = explicitCwd
          ? {...target, cwd: '/synthetic/worktree', full}
          : {...target, full};
        const before = JSON.stringify({action, selection});
        const request = vi
          .fn<
            (
              path: string,
              action: GraphAdministrationAction & {readonly confirm: boolean},
            ) => Promise<GraphIndexActionResponse>
          >()
          .mockResolvedValueOnce(selection)
          .mockResolvedValueOnce({output: 'ready'});
        const dialogs: ManagerDialogs = {
          confirm: vi.fn(),
          prompt: vi
            .fn()
            .mockResolvedValue(cancel ? undefined : {project: selection.scopeSelection.projects[chosen].name}),
        };
        const result = await requestGraphAdministrationAction(action, request, dialogs);
        expect(request).toHaveBeenCalledTimes(cancel ? 1 : 2);
        if (cancel) expect(result).toBeUndefined();
        else
          expect(request).toHaveBeenLastCalledWith('/api/graphs/action', {
            ...action,
            confirm: true,
            project: selection.scopeSelection.projects[chosen].name,
            expectedRevision: 'revision',
          });
        expect(JSON.stringify({action, selection})).toBe(before);
      },
    ),
    {numRuns: 40},
  );
});

it('cancels the native dialog with Escape without starting a scoped action', async () => {
  const request = vi.fn().mockResolvedValue(selection);
  const finish = vi.fn();
  function Harness() {
    const dialogs = useManagerDialogs();
    return (
      <button onClick={() => void requestGraphAdministrationAction(target, request, dialogs).then(finish)}>
        Index
      </button>
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <ManagerDialogProvider>
        <Harness />
      </ManagerDialogProvider>,
    ),
  );
  await act(async () => document.querySelector<HTMLButtonElement>('button')?.click());
  await act(async () =>
    document.querySelector('dialog')?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})),
  );
  expect(finish).toHaveBeenCalledWith(undefined);
  expect(request).toHaveBeenCalledTimes(1);
  expect(document.querySelector('dialog')).toBeNull();
});

it('keeps already-selected projects and unambiguous actions on the direct path', async () => {
  const request = vi.fn().mockResolvedValue({output: 'ready'});
  const dialogs: ManagerDialogs = {confirm: vi.fn(), prompt: vi.fn()};
  for (const action of [target, {action: 'index-project', project: 'docs', expectedRevision: 'revision'}] as const) {
    expect(await requestGraphAdministrationAction(action, request, dialogs)).toEqual({output: 'ready'});
    expect(request).toHaveBeenLastCalledWith('/api/graphs/action', {...action, confirm: true});
  }
  expect(dialogs.prompt).not.toHaveBeenCalled();
});

it('rejects typed unknown scopes and does not loop on a changed selection', async () => {
  const dialogs: ManagerDialogs = {confirm: vi.fn(), prompt: vi.fn().mockResolvedValue({project: 'other'})};
  const request = vi.fn().mockResolvedValue(selection);
  await expect(requestGraphAdministrationAction(target, request, dialogs)).rejects.toThrow('one of the configured');
  expect(request).toHaveBeenCalledTimes(1);
  vi.mocked(dialogs.prompt).mockResolvedValue({project: 'docs'});
  await expect(requestGraphAdministrationAction(target, request, dialogs)).rejects.toThrow('changed');
  expect(request).toHaveBeenCalledTimes(3);
});
