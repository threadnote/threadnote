// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ManagerLiveProvider} from '../../src/live/provider.js';
import {AutomaticMemoryPanel} from '../../src/attention/automatic_memory.js';
import {FakeManagerSocket} from './live-consumer-fixture.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray} from 'effect';
import {Option as EffectOption} from 'effect';

let root: Root | undefined;
let reads: string[];
async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}
async function render(uri?: string) {
  if (!root) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () =>
    root?.render(
      <ManagerLiveProvider account="one">
        <AutomaticMemoryPanel project="one" uri={uri} />
      </ManagerLiveProvider>,
    ),
  );
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeManagerSocket.instances = [];
  reads = [];
  vi.stubGlobal('WebSocket', FakeManagerSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/live-session') return new Response(JSON.stringify({ticket: 'fixture'}));
      if (Effect.pipe(url, EffectString.startsWith('/api/attention/automatic-memory'))) {
        reads.push(url);
        const after = new URL(url, 'http://localhost').searchParams.get('afterUri');
        return new Response(
          JSON.stringify({
            version: 1,
            project: 'one',
            items: [],
            omitted: 0,
            incomplete: false,
            nextCursor: after ? undefined : 'cursor-one',
          }),
        );
      }
      throw new Error(`Unexpected ${url}`);
    }),
  );
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('uses local cursor and URI query keys with no idle polling and bounded broad invalidation reads', async () => {
  await render();
  await flush();
  const socket = FakeManagerSocket.instances[0];
  await act(async () => {
    socket.open(['automatic-memory']);
    socket.ack();
  });
  await flush();
  expect(reads.length).toBeLessThanOrEqual(2);
  const initial = reads.length;
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(reads).toHaveLength(initial);
  await act(async () => {
    for (let sequence = 1; sequence <= 100; sequence++)
      socket.invalidate(sequence, {topic: 'automatic-memory', project: 'one'});
  });
  await flush();
  expect(reads.length).toBeLessThanOrEqual(initial + 2);
  const next = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll<HTMLButtonElement>('button')],
      __effectArrayValue =>
        !!(button =>
          Effect.pipe(button.textContent, effectOptionalString =>
            effectOptionalString == null
              ? undefined
              : Effect.pipe(effectOptionalString, EffectString.includes('Next memories')),
          ))(__effectArrayValue),
    ),
  )!;
  await act(async () => next.click());
  await flush();
  await act(async () => socket.ack());
  await flush();
  expect(reads.at(-1)).toContain('afterUri=cursor-one');
  await render('memory-one');
  await flush();
  await act(async () => socket.ack());
  await flush();
  expect(reads.at(-1)).toContain('uri=memory-one');
  expect(reads.at(-1)).not.toContain('afterUri=');
  expect(EffectArray.filter(socket.sent, item => item.type === 'subscribe').at(-1)?.resources).toEqual([
    {topic: 'automatic-memory', project: 'one'},
  ]);
});

it('shows a supported read failure and recovers through the existing refresh action', async () => {
  await render();
  await flush();
  const socket = FakeManagerSocket.instances[0];
  vi.mocked(fetch).mockImplementationOnce(async () => {
    throw new Error('temporary automatic read failure');
  });
  await act(async () => {
    socket.open(['automatic-memory']);
    socket.ack();
  });
  await flush();
  expect(document.querySelector('[role=alert]')?.textContent).toContain('temporary automatic read failure');
  expect(document.body.textContent).not.toContain('Loading automatic assessment');
  const refresh = document.querySelector<HTMLButtonElement>('[aria-label="Refresh automatic updates"]')!;
  await act(async () => refresh.click());
  await flush();
  expect(document.querySelector('[role=alert]')).toBeNull();
  expect(reads).toHaveLength(1);
});
