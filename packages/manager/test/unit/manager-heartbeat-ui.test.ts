// @vitest-environment happy-dom

import {act} from 'react';
import {expect, it, vi} from 'vitest';

it('checks Manager health on connected heartbeat ticks without repeating runtime state requests', async () => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let heartbeat: (() => void) | undefined;
  const setInterval = vi.spyOn(window, 'setInterval').mockImplementation((handler, milliseconds) => {
    if (milliseconds === 3_000 && typeof handler === 'function') heartbeat = handler;
    return setTimeout(() => undefined, 0);
  });
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  globalThis.fetch = (async input => {
    const path = new URL(String(input), 'http://localhost').pathname;
    requests.push(path);
    if (path === '/api/state')
      return json({
        agents: [],
        autoUpdate: {effectivePolicy: 'notify'},
        config: {account: 'local', agentContextHome: '/tmp/threadnote-test', user: 'test'},
        updateAvailable: false,
        version: 'test',
      });
    if (path === '/api/health') return json({status: 'ok'});
    if (path === '/api/graphs/status') return json({builds: [], catalogRevision: 'test'});
    if (path === '/api/graphs/diagnostics') return new Response('{}', {status: 503});
    if (path === '/api/graphs') return json({repositories: [], builds: [], diagnostics: [], views: []});
    if (path === '/api/tree') return json({tree: undefined, resourcesTree: undefined});
    if (path === '/api/shares') return json({shares: []});
    return json({});
  }) as typeof fetch;

  try {
    await act(async () => {
      (await import('@threadnote/manager/ui')).mountManager({integrations: []});
    });
    expect(heartbeat).toBeDefined();
    const initialStateRequests = requests.filter(path => path === '/api/state').length;
    expect(initialStateRequests).toBe(1);

    await act(async () => {
      heartbeat?.();
      heartbeat?.();
    });
    expect(requests.filter(path => path === '/api/health')).toHaveLength(2);
    expect(requests.filter(path => path === '/api/state')).toHaveLength(initialStateRequests);
  } finally {
    globalThis.fetch = originalFetch;
    setInterval.mockRestore();
    document.body.replaceChildren();
  }
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
}
