// @vitest-environment happy-dom
import React, {act} from 'react';
import type {Root} from 'react-dom/client';
import * as EffectString from 'effect/String';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {TreeNode} from '../../src/ui/contracts.js';
import {FakeManagerSocket, liveFrame} from './live-consumer-fixture.js';
import {
  MANAGER_LIVE_SUPPORTED_TOPICS,
  ManagerLiveClientFrame,
  type ManagerLiveResource,
} from '../../src/live/contracts.js';
import {Array as EffectArray, Schema} from 'effect';

class AutomaticManagerSocket extends FakeManagerSocket {
  sequence = 0;
  generation = 0;
  closeCalls = 0;
  constructor(url: string) {
    super(url);
    queueMicrotask(() => this.open([...MANAGER_LIVE_SUPPORTED_TOPICS], ['processes']));
  }
  override close() {
    this.closeCalls++;
    super.close();
  }
  override send(value: string) {
    super.send(value);
    const frame = Schema.decodeUnknownSync(ManagerLiveClientFrame)(JSON.parse(value));
    if (frame.type !== 'subscribe') return;
    this.generation = frame.generation;
    queueMicrotask(() => {
      if (this.readyState !== 1 || !this.onmessage) return;
      this.emit(
        liveFrame('subscribed', {epoch: 'epoch-one', generation: frame.generation, startingSequence: this.sequence}),
      );
      for (const resource of frame.resources)
        if (resource.topic === 'processes') {
          this.emit(
            liveFrame('snapshot', {
              epoch: 'epoch-one',
              generation: frame.generation,
              sequence: ++this.sequence,
              resource,
              data: {processes: [], schemaVersion: 1, truncated: false},
            }),
          );
        }
    });
  }
  availability(resource: ManagerLiveResource, available: boolean) {
    this.emit(
      liveFrame('availability', {
        epoch: 'epoch-one',
        generation: this.generation,
        sequence: ++this.sequence,
        resource,
        available,
      }),
    );
  }
}

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
let pathReads: Map<string, number>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeManagerSocket.instances = [];
  vi.stubGlobal('WebSocket', AutomaticManagerSocket);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  reads = [];
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
      return json({
        version: 1,
        project: url.searchParams.get('project') ?? '',
        lanes: [],
        handoffs: [],
        stats: {memories: 1},
      });
    if (url.pathname === '/api/models/setup')
      return json({
        version: 1,
        intentEpoch: 1,
        modelId: 'synthetic',
        totalBytes: 0,
        policy: 'off',
        phase: 'off',
        bytes: 0,
        attempts: 0,
        artifactReady: false,
        effectiveDefault: false,
        environmentOff: false,
      });
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
    if (
      EffectString.trim(item.textContent ?? '') === label ||
      item.querySelector('strong')?.textContent === label ||
      item.getAttribute('aria-label') === label
    )
      return item;
  }
  throw new Error('Missing synthetic UI button: ' + label);
}
// React/Promise/WebSocket boundary: real shell/editor, no Effect program or actual transport.
it('keeps the full mounted shell and real editor stable across ACK, availability and focus revalidation', async () => {
  await act(async () => (await import('../../src/ui.js')).mountManager({integrations: []}));
  await flush();
  await flush();
  const socket = FakeManagerSocket.instances[0];
  expect(socket).toBeInstanceOf(AutomaticManagerSocket);
  if (!(socket instanceof AutomaticManagerSocket)) throw new Error('Expected automatic synthetic socket');
  expect(FakeManagerSocket.instances).toHaveLength(1);
  expect(pathReads.get('/api/live-session')).toBe(1);
  const subscriptions = EffectArray.filter(
    EffectArray.map(socket.sent, frame => Schema.decodeUnknownSync(ManagerLiveClientFrame)(frame)),
    frame => frame.type === 'subscribe',
  );
  const resources = EffectArray.flatMap(subscriptions, frame => frame.resources);
  expect([...new Set(EffectArray.map(resources, resource => resource.topic))]).toEqual(
    expect.arrayContaining(['processes', 'home', 'share-conflicts']),
  );
  await act(async () => button('Library').click());
  const selection = host.querySelector<HTMLButtonElement>(`button[title="${selected.uri}"]`);
  expect(selection).not.toBeNull();
  await act(async () => selection!.click());
  await flush();
  expect(reads.length).toBeGreaterThan(0);
  await act(async () => {
    for (const read of reads) read.resolve(memory('Mounted real editor body'));
  });
  await flush();
  await act(async () => button('Edit').click());
  await flush();
  const editor = host.querySelector('[contenteditable="true"]');
  expect(editor).not.toBeNull();
  expect(host.textContent).toContain('Mounted real editor body');
  const before = EffectArray.filter(socket.sent, frame => frame.type === 'subscribe').length;
  await act(async () => {
    socket.availability({topic: 'share-conflicts', scope: 'account'}, false);
  });
  await flush();
  expect(host.querySelector('[contenteditable="true"]')).toBe(editor);
  expect(host.textContent).toContain('Mounted real editor body');
  expect(socket.closeCalls).toBe(0);
  await act(async () => {
    socket.availability({topic: 'share-conflicts', scope: 'account'}, true);
  });
  await flush();
  expect(host.querySelector('[contenteditable="true"]')).toBe(editor);
  expect(host.textContent).toContain('Mounted real editor body');
  await act(async () => window.dispatchEvent(new Event('focus')));
  await flush();
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  await flush();
  expect(EffectArray.filter(socket.sent, frame => frame.type === 'subscribe').length).toBeGreaterThan(before);
  expect(FakeManagerSocket.instances).toHaveLength(1);
  expect(pathReads.get('/api/live-session')).toBe(1);
  expect(socket.closeCalls).toBe(0);
  expect(host.textContent).not.toContain('Manager disconnected');
  expect(host.querySelector('[contenteditable="true"]')).toBe(editor);
  expect(host.textContent).toContain('Mounted real editor body');
});
