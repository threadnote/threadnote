// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import fc from 'fast-check';
import * as EffectString from 'effect/String';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ManagerLiveProvider} from '../../src/live/provider.js';
import {useManagerRuntimeConnection} from '../../src/ui/live.js';
import type {TreeNode} from '../../src/ui/contracts.js';
import {FakeManagerSocket} from './live-consumer-fixture.js';

const roots: Root[] = [];
vi.mock('react-dom/client', async importOriginal => {
  const original = await importOriginal<typeof import('react-dom/client')>();
  return {
    ...original,
    createRoot: (...args: Parameters<typeof original.createRoot>) => {
      const root = original.createRoot(...args);
      roots.push(root);
      return root;
    },
  };
});
vi.mock('../../src/memory_editor.js', () => ({
  MemoryEditor: (props: {content: string; disabled: boolean; onChange: (value: string) => void}) => (
    <>
      <textarea
        aria-label="Test editor"
        value={props.content}
        disabled={props.disabled}
        onChange={event => props.onChange(event.target.value)}
      />
      <button disabled={props.disabled} onClick={() => props.onChange('Unsaved local draft')}>
        Synthetic draft
      </button>
    </>
  ),
}));

const base = 'threadnote://user/test/memories';
const selected: TreeNode = {
  name: 'Selected.md',
  uri: base + '/durable/projects/demo/selected.md',
  relativePath: 'durable/projects/demo/selected.md',
  isDir: false,
  isSystem: false,
  isShared: false,
  metadata: {
    kind: 'durable',
    status: 'active',
    project: 'demo',
    topic: 'Selected',
    sourceAgentClient: 'user',
    timestamp: '2026-11-01T00:00:00.000Z',
  },
};
const resource: TreeNode = {
  name: 'source.md',
  uri: 'threadnote://resources/source.md',
  relativePath: 'source.md',
  isDir: false,
  isSystem: false,
  isShared: false,
};
const other: TreeNode = {
  ...selected,
  name: 'Other.md',
  uri: base + '/durable/projects/demo/other.md',
  relativePath: 'durable/projects/demo/other.md',
  metadata: {...selected.metadata!, topic: 'Other'},
};
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
}
function trees() {
  return {
    tree: {...selected, name: 'memories', uri: base, relativePath: '', isDir: true, children: [selected, other]},
    resourcesTree: {
      name: 'resources',
      uri: 'threadnote://resources',
      relativePath: '',
      isDir: true,
      isSystem: false,
      isShared: false,
      children: [resource],
    },
  };
}
function memory(body: string, node: TreeNode = selected): Response {
  return json({
    node,
    content: body,
    record: {body, content: body, metadata: node.metadata, uri: node.uri},
  });
}
function deferred<T>() {
  return Promise.withResolvers<T>();
}
let host: HTMLDivElement;
let reads: ReturnType<typeof deferred<Response>>[];
let holdTree: boolean;
let heldTrees: ReturnType<typeof deferred<Response>>[];
let pathReads: Map<string, number>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeManagerSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeManagerSocket);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  reads = [];
  heldTrees = [];
  holdTree = false;
  pathReads = new Map();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    pathReads.set(url.pathname, (pathReads.get(url.pathname) ?? 0) + 1);
    if (url.pathname === '/api/live-session') return json({ticket: 'synthetic-ticket'});
    if (url.pathname === '/api/state')
      return json({
        agents: [],
        config: {user: 'test', account: 'local', agentContextHome: '/tmp/threadnote-reconnect'},
        autoUpdate: {effectivePolicy: 'notify'},
        updateAvailable: false,
        version: 'fixture',
      });
    if (url.pathname === '/api/tree') {
      if (holdTree) {
        const pending = deferred<Response>();
        heldTrees.push(pending);
        return pending.promise;
      }
      return json(trees());
    }
    if (url.pathname === '/api/memory' || url.pathname === '/api/read') {
      const pending = deferred<Response>();
      reads.push(pending);
      return pending.promise;
    }
    if (url.pathname === '/api/memory/save') return json({output: 'Synthetic save complete'});
    if (url.pathname === '/api/graphs')
      return json({repositories: [], builds: [], diagnostics: [], views: [], waiterCount: 0, waiters: []});
    if (url.pathname === '/api/shares') return json({shares: []});
    if (url.pathname === '/api/shares/conflicts') return json({conflicts: []});
    if (url.pathname === '/api/processes') return json({processes: [], schemaVersion: 1, truncated: false});
    if (url.pathname === '/api/home')
      return json({version: 1, project: '', lanes: [], handoffs: [], stats: {memories: 1}});
    return json({});
  });
  host = document.createElement('div');
  host.id = 'root';
  document.body.append(host);
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
async function flush() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
function button(label: string): HTMLButtonElement {
  for (const item of host.querySelectorAll<HTMLButtonElement>('button')) {
    if (EffectString.trim(item.textContent ?? '') === label || item.querySelector('strong')?.textContent === label)
      return item;
  }
  throw new Error('Missing synthetic UI button: ' + label);
}
async function connect(socket: FakeManagerSocket) {
  await act(async () => {
    socket.open(['processes']);
    socket.ack();
  });
  await flush();
}
async function mountAndSelect(kind: 'memory' | 'resource' = 'memory'): Promise<FakeManagerSocket> {
  await act(async () => {
    (await import('../../src/ui.js')).mountManager({integrations: []});
  });
  await flush();
  const socket = FakeManagerSocket.instances.at(-1)!;
  expect(socket).toBeDefined();
  await connect(socket);
  await act(async () => button('Library').click());
  if (kind === 'resource') await act(async () => button('Resources').click());
  const selection = host.querySelector<HTMLButtonElement>(
    `button[title="${kind === 'memory' ? selected.uri : resource.uri}"]`,
  );
  expect(selection).not.toBeNull();
  await act(async () => selection!.click());
  await flush();
  expect(reads).toHaveLength(1);
  return socket;
}
async function loseAndReconnect(socket: FakeManagerSocket) {
  await act(async () => {
    socket.close();
    socket.onclose?.(new CloseEvent('close'));
  });
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await flush();
  const next = FakeManagerSocket.instances.at(-1)!;
  expect(next).not.toBe(socket);
  await connect(next);
  return next;
}

it('reacquires the selected record after live reconnect and waits for its fresh read', async () => {
  const socket = await mountAndSelect();
  await act(async () => reads[0].resolve(memory('Original readable body')));
  await flush();
  expect(host.textContent).toContain('Original readable body');
  await loseAndReconnect(socket);
  expect(host.textContent).not.toContain('Original readable body');
  expect(reads).toHaveLength(2);
  await act(async () => reads[1].resolve(memory('Fresh recovered body')));
  await flush();
  expect(host.textContent).toContain('Fresh recovered body');
});

it('rejects a pre-loss selected REST completion after ACK while fresh recovery is pending', async () => {
  const socket = await mountAndSelect();
  holdTree = true;
  await loseAndReconnect(socket);
  await act(async () => reads[0].resolve(memory('Obsolete pre-loss body')));
  await flush();
  expect(host.textContent).not.toContain('Obsolete pre-loss body');
  expect(heldTrees).toHaveLength(1);
  holdTree = false;
  await act(async () => heldTrees[0].resolve(json(trees())));
  await flush();
  expect(reads).toHaveLength(2);
  expect(host.textContent).not.toContain('Obsolete pre-loss body');
  await act(async () => reads[1].resolve(memory('Owned post-loss body')));
  await flush();
  expect(host.textContent).toContain('Owned post-loss body');
});

it('keeps actions unavailable on a failed current read and recovers in the next episode', async () => {
  let socket = await mountAndSelect();
  socket = await loseAndReconnect(socket);
  await act(async () => reads[1].resolve(json({error: 'Access denied'}, 403)));
  await flush();
  expect(host.textContent).toContain('Could not load record. Refresh to retry.');
  expect(host.textContent).toContain('Record unavailable until it loads.');
  await act(async () => reads[0].resolve(memory('Old unauthorized-to-publish body')));
  await flush();
  expect(host.textContent).not.toContain('Old unauthorized-to-publish body');
  await loseAndReconnect(socket);
  expect(reads).toHaveLength(3);
  await act(async () => reads[2].resolve(memory('Fresh allowed body')));
  await flush();
  expect(host.textContent).toContain('Fresh allowed body');
});

it('ignores an obsolete failed read after a fresh current read has succeeded', async () => {
  const socket = await mountAndSelect();
  await loseAndReconnect(socket);
  await act(async () => reads[1].resolve(memory('Current body stays readable')));
  await flush();
  await act(async () => reads[0].resolve(json({error: 'Old failure'}, 403)));
  await flush();
  expect(host.textContent).toContain('Current body stays readable');
  expect(host.textContent).not.toContain('Could not load record. Refresh to retry.');
});

it('fences the resource reader across loss and waits for its fresh result', async () => {
  const socket = await mountAndSelect('resource');
  holdTree = true;
  await loseAndReconnect(socket);
  await act(async () => reads[0].resolve(json({content: 'Old resource', output: 'Old resource'})));
  await flush();
  expect(host.textContent).not.toContain('Old resource');
  expect(host.textContent).toContain('Record unavailable until it loads.');
  holdTree = false;
  await act(async () => heldTrees[0].resolve(json(trees())));
  await flush();
  expect(reads).toHaveLength(2);
  await act(async () => reads[1].resolve(json({content: 'Fresh resource', output: 'Fresh resource'})));
  await flush();
  expect(host.textContent).toContain('Fresh resource');
});

it('redacts every copy of an already-readable resource until its fresh read succeeds', async () => {
  const socket = await mountAndSelect('resource');
  await act(async () => reads[0].resolve(json({content: 'Readable resource body', output: 'Readable resource body'})));
  await flush();
  expect(host.textContent).toContain('Readable resource body');
  await loseAndReconnect(socket);
  expect(host.textContent).not.toContain('Readable resource body');
  await act(async () => reads[1].resolve(json({content: 'Reacquired resource', output: 'Reacquired resource'})));
  await flush();
  expect(host.textContent).toContain('Reacquired resource');
});

it('does not let a previous selection publish over a newly selected record', async () => {
  await mountAndSelect();
  const next = host.querySelector<HTMLButtonElement>(`button[title="${other.uri}"]`);
  expect(next).not.toBeNull();
  await act(async () => next!.click());
  await flush();
  expect(reads).toHaveLength(2);
  await act(async () => reads[0].resolve(memory('Previous selection body')));
  await flush();
  expect(host.textContent).not.toContain('Previous selection body');
  expect(host.textContent).toContain('Record unavailable until it loads.');
  await act(async () => reads[1].resolve(memory('New selection body', other)));
  await flush();
  expect(host.textContent).toContain('New selection body');
});

it('preserves a dirty draft for explicit comparison after recovery', async () => {
  const socket = await mountAndSelect();
  await act(async () => reads[0].resolve(memory('Original draft base')));
  await flush();
  await act(async () => button('Edit').click());
  await act(async () => button('Synthetic draft').click());
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Unsaved local draft');
  await loseAndReconnect(socket);
  expect(host.querySelector('textarea')).toBeNull();
  await act(async () => reads[1].resolve(memory('Changed canonical body')));
  await flush();
  expect(host.textContent).toContain('The saved record changed. Your unsaved draft is preserved.');
  expect(host.textContent).toContain('Changed canonical body');
  await act(async () => button('Keep my draft').click());
  await act(async () => button('Edit').click());
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Unsaved local draft');
});

it('keeps the reconciled dirty draft in the editor after an unchanged canonical reconnect read', async () => {
  const socket = await mountAndSelect();
  await act(async () => reads[0].resolve(memory('Original draft base')));
  await flush();
  await act(async () => button('Edit').click());
  await act(async () => button('Synthetic draft').click());
  await loseAndReconnect(socket);
  await act(async () => reads[1].resolve(memory('Changed canonical body')));
  await flush();
  expect(host.textContent).toContain('The saved record changed. Your unsaved draft is preserved.');
  await act(async () => button('Keep my draft').click());
  await act(async () => button('Edit').click());
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Unsaved local draft');

  const recoveredSocket = FakeManagerSocket.instances.at(-1)!;
  await loseAndReconnect(recoveredSocket);
  expect(reads).toHaveLength(3);
  await act(async () => reads[2].resolve(memory('Changed canonical body')));
  await flush();
  const editor = host.querySelector<HTMLTextAreaElement>('textarea');
  expect(editor).not.toBeNull();
  expect(editor?.disabled).toBe(false);
  expect(editor?.value).toBe('Unsaved local draft');
});

it('keeps editor intent and dirty draft idempotent across repeated unchanged canonical reads', async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({minLength: 1, maxLength: 32}), fc.integer({min: 1, max: 4}), async (body, repeats) => {
      reads = [];
      heldTrees = [];
      holdTree = false;
      pathReads = new Map();
      FakeManagerSocket.instances = [];
      host.replaceChildren();
      try {
        let socket = await mountAndSelect();
        await act(async () => reads[0].resolve(memory('Original draft base')));
        await flush();
        await act(async () => button('Edit').click());
        await act(async () => button('Synthetic draft').click());
        socket = await loseAndReconnect(socket);
        await act(async () => reads[1].resolve(memory(`Changed canonical ${body}`)));
        await flush();
        await act(async () => button('Keep my draft').click());
        await act(async () => button('Edit').click());
        expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Unsaved local draft');

        for (let repeat = 0; repeat < repeats; repeat++) {
          socket = await loseAndReconnect(socket);
          const currentRead = reads.at(-1)!;
          await act(async () => currentRead.resolve(memory(`Changed canonical ${body}`)));
          await flush();
          const editor = host.querySelector<HTMLTextAreaElement>('textarea');
          expect(editor).not.toBeNull();
          expect(editor?.disabled).toBe(false);
          expect(editor?.value).toBe('Unsaved local draft');
        }
      } finally {
        await act(async () => {
          for (const root of roots.splice(0)) root.unmount();
        });
        host.replaceChildren();
      }
    }),
    {numRuns: 8, seed: 974756},
  );
});

it.each(['loss', 'selection'] as const)(
  'rejects an action-triggered reload after %s transfers read authority',
  async transfer => {
    const socket = await mountAndSelect();
    await act(async () => reads[0].resolve(memory('Before save')));
    await flush();
    await act(async () => button('Edit').click());
    await act(async () => button('Synthetic draft').click());
    await act(async () => button('Save').click());
    await flush();
    expect(pathReads.get('/api/memory/save')).toBe(1);
    expect(reads.length).toBeGreaterThan(1);
    const oldReads = reads.slice(1);
    if (transfer === 'loss') await loseAndReconnect(socket);
    else {
      const next = host.querySelector<HTMLButtonElement>(`button[title="${other.uri}"]`);
      expect(next).not.toBeNull();
      await act(async () => next!.click());
      await flush();
    }
    const fresh = reads.at(-1)!;
    expect(oldReads).not.toContain(fresh);
    await act(async () =>
      fresh.resolve(memory('Authoritative recovered body', transfer === 'loss' ? selected : other)),
    );
    await flush();
    expect(host.textContent).toContain('Authoritative recovered body');
    await act(async () => {
      for (const read of oldReads) read.resolve(memory('Obsolete action reload'));
    });
    await flush();
    expect(host.textContent).not.toContain('Obsolete action reload');
    expect(host.textContent).toContain('Authoritative recovered body');
  },
);

it('redacts a pending canonical comparison and its controls during a later loss', async () => {
  let socket = await mountAndSelect();
  await act(async () => reads[0].resolve(memory('Original draft base')));
  await flush();
  await act(async () => button('Edit').click());
  await act(async () => button('Synthetic draft').click());
  socket = await loseAndReconnect(socket);
  await act(async () => reads[1].resolve(memory('Previous comparison body')));
  await flush();
  expect(host.textContent).toContain('Previous comparison body');
  holdTree = true;
  await loseAndReconnect(socket);
  expect(host.textContent).not.toContain('Previous comparison body');
  expect(host.textContent).not.toContain('Keep my draft');
  expect(host.textContent).not.toContain('Load reloaded record');
  holdTree = false;
  await act(async () => heldTrees[0].resolve(json(trees())));
  await flush();
  await act(async () => reads[2].resolve(memory('Current comparison body')));
  await flush();
  expect(host.textContent).toContain('Current comparison body');
  expect(host.textContent).toContain('Your unsaved draft is preserved.');
});

function ConnectionProbe({
  onRecovery,
  onLost,
  onReady,
  runtime = 'connected',
}: {
  onRecovery: () => void;
  onLost: () => void;
  onReady: () => void;
  runtime?: 'connected' | 'disconnected';
}) {
  useManagerRuntimeConnection({runtime, onRecovery, onLost, onReady});
  return null;
}

it('recovers exactly once per observed loss-to-connected episode without idle polling', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom('ack', 'loss', 'connect'), {minLength: 1, maxLength: 15}),
      async events => {
        const container = document.createElement('div');
        host.append(container);
        const root = createRoot(container);
        try {
          let recoveries = 0;
          let expectedRecoveries = 0;
          let lost = false;
          let connected = true;
          await act(async () =>
            root.render(
              <ManagerLiveProvider account="property-account">
                <ConnectionProbe onRecovery={() => recoveries++} onLost={() => undefined} onReady={() => undefined} />
              </ManagerLiveProvider>,
            ),
          );
          await flush();
          let socket = FakeManagerSocket.instances.at(-1)!;
          await connect(socket);
          expect(recoveries).toBe(0);
          for (const event of events) {
            if (event === 'loss') {
              await act(async () => {
                socket.close();
                socket.onclose?.(new CloseEvent('close'));
              });
              await flush();
              await act(async () => vi.advanceTimersToNextTimerAsync());
              await flush();
              socket = FakeManagerSocket.instances.at(-1)!;
              connected = false;
              lost = true;
            } else if (event === 'connect' && !connected) {
              await connect(socket);
              if (lost) expectedRecoveries++;
              lost = false;
              connected = true;
            } else if (connected) {
              await act(async () => socket.ack());
              await flush();
            }
            expect(recoveries).toBe(expectedRecoveries);
          }
          if (!connected) {
            await connect(socket);
            expectedRecoveries++;
          }
          expect(recoveries).toBe(expectedRecoveries);
          const before = new Map(pathReads);
          await act(async () => vi.advanceTimersByTimeAsync(60_000));
          expect(pathReads).toEqual(before);
          expect(recoveries).toBe(expectedRecoveries);
        } finally {
          await act(async () => root.unmount());
          roots.splice(roots.indexOf(root), 1);
          container.remove();
        }
      },
    ),
    {numRuns: 24, seed: 974},
  );
});

it('only grants selected read authority to the current post-loss acquisition regardless of completion order', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom<'memory' | 'resource'>('memory', 'resource'),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      async (kind, oldSucceeds, currentSucceeds, oldFirst) => {
        reads = [];
        try {
          const socket = await mountAndSelect(kind);
          await loseAndReconnect(socket);
          expect(reads).toHaveLength(2);
          const response = (body: string, succeeds: boolean) =>
            !succeeds
              ? json({error: 'Synthetic denied read'}, 403)
              : kind === 'memory'
                ? memory(body)
                : json({content: body, output: body});
          const finish = async (index: number) => {
            await act(async () =>
              reads[index].resolve(
                response(
                  index === 0 ? 'Model obsolete body' : 'Model current body',
                  index === 0 ? oldSucceeds : currentSucceeds,
                ),
              ),
            );
            await flush();
          };
          if (oldFirst) {
            await finish(0);
            expect(host.textContent).not.toContain('Model obsolete body');
            expect(host.textContent).toContain('Record unavailable until it loads.');
          }
          await finish(1);
          if (!oldFirst) await finish(0);
          expect(host.textContent).not.toContain('Model obsolete body');
          if (currentSucceeds) {
            expect(host.textContent).toContain('Model current body');
            expect(host.textContent).not.toContain('Record unavailable until it loads.');
          } else {
            expect(host.textContent).not.toContain('Model current body');
            expect(host.textContent).toContain('Record unavailable until it loads.');
          }
        } finally {
          await act(async () => {
            for (const root of roots.splice(0)) root.unmount();
          });
          vi.clearAllTimers();
        }
      },
    ),
    {numRuns: 24, seed: 975},
  );
});

it.each(['unsupported', 'stopped'] as const)('preserves the three-second %s health fallback', async connection => {
  const recovery = vi.fn();
  const lost = vi.fn();
  let healthy = true;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    if (String(input) === '/api/live-session') return json({error: 'Unsupported'}, 404);
    expect(String(input)).toBe('/api/health');
    return healthy ? json({status: 'ok'}) : json({error: 'Unavailable'}, 503);
  });
  const root = createRoot(host);
  const probe = (
    <ConnectionProbe runtime="disconnected" onRecovery={recovery} onLost={lost} onReady={() => undefined} />
  );
  await act(async () =>
    root.render(
      connection === 'unsupported' ? <ManagerLiveProvider account="fallback">{probe}</ManagerLiveProvider> : probe,
    ),
  );
  await flush();
  await act(async () => vi.advanceTimersByTimeAsync(2_999));
  expect(recovery).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(recovery).toHaveBeenCalledTimes(1);
  healthy = false;
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(lost).toHaveBeenCalledTimes(1);
});
