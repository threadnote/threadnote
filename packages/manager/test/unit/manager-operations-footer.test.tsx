import {Array as EffectArray} from 'effect';
// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, it, vi} from 'vitest';
import {ManagerOperationsFooter} from '../../src/operations_footer.js';
import {ManagerProcessesProvider} from '../../src/process/live.js';
import {ProcessesPanel} from '../../src/processes_view.js';
import {ManagerDialogProvider} from '../../src/dialog.js';
import type {ManageableManagerProcess} from '../../src/process/contracts.js';

const process = (operation: string, processId = 1): ManageableManagerProcess => ({
  ageMilliseconds: 1_000,
  currentOperation: operation,
  parentProcessId: 0,
  processId,
  role: 'mcp',
  startedAt: '2026-10-09T12:00:00Z',
  terminable: false,
});

it('polls operations across page changes, shares the inventory, handles failures and stops on unmount', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  vi.useFakeTimers();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let processes = [process('mcp-server')];
  let failed = false;
  const fetch = vi.fn(async () => {
    if (failed) throw new Error('synthetic offline');
    return new Response(JSON.stringify({processes, schemaVersion: 1, truncated: false}));
  });
  vi.stubGlobal('fetch', fetch);
  const open = vi.fn();
  const render = (page: boolean) => (
    <ManagerDialogProvider>
      <ManagerProcessesProvider>
        {page ? <ProcessesPanel /> : <p>Another page</p>}
        <ManagerOperationsFooter onOpen={open} />
      </ManagerProcessesProvider>
    </ManagerDialogProvider>
  );
  const tick = () => act(async () => vi.advanceTimersByTimeAsync(2_000));
  try {
    await act(async () => root.render(render(false)));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.footer-operations')?.getAttribute('aria-hidden')).toBe('true');
    processes = [process('mcp-server'), process('graph', 2), process('context', 3)];
    await tick();
    expect(container.querySelector('.footer-operations.is-visible')).not.toBeNull();
    expect(container.querySelector('.footer-operations [role="status"]')?.textContent).toBe('2 active operations');
    expect(EffectArray.map([...container.querySelectorAll('.footer-operations li')], item => item.textContent)).toEqual(
      ['graph', 'context'],
    );
    await act(async () => container.querySelector<HTMLButtonElement>('.footer-operations-summary')!.click());
    expect(open).toHaveBeenCalledOnce();
    await act(async () => root.render(render(true)));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.process-workspace')?.textContent).toContain('Context');
    await tick();
    expect(fetch).toHaveBeenCalledTimes(3);
    await act(async () => root.render(render(false)));
    failed = true;
    await tick();
    expect(container.querySelector('.footer-operations')?.textContent).toContain('Operation status unavailable');
    failed = false;
    processes = [];
    await tick();
    expect(container.querySelector('.footer-operations')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.footer-operations')?.hasAttribute('inert')).toBe(true);
    processes = [process('graph', 4)];
    await tick();
    expect(container.querySelector('.footer-operations [role="status"]')?.textContent).toBe('1 active operation');
    await act(async () => root.unmount());
    const requests = fetch.mock.calls.length;
    await tick();
    expect(fetch).toHaveBeenCalledTimes(requests);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
