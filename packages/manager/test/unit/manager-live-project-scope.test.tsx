// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {Array as EffectArray} from 'effect';
import {ManagerLiveProjectScope, ManagerLiveProvider, useManagerLiveQuery} from '../../src/live/provider.js';
import type {ManagerLiveResource} from '../../src/live/contracts.js';
import {FakeManagerSocket} from './live-consumer-fixture.js';

let root: Root;
let host: HTMLDivElement;
function Probe({resource, label}: {readonly resource: ManagerLiveResource; readonly label: string}) {
  const query = useManagerLiveQuery(
    resource,
    '',
    async () => ({ok: true}),
    (value): value is {ok: boolean} =>
      typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean',
  );
  return <output data-probe={label} data-active={String(query.active)} />;
}
async function flush() {
  await act(async () => {
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  });
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeManagerSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeManagerSocket);
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ticket: 'synthetic-ticket'})));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// React/WebSocket subscription boundary, with no Effect program or real transport.
it('keeps every emitted project within current membership while preserving account queries across changes', async () => {
  const names = fc.uniqueArray(fc.constantFrom('alpha', 'beta', 'gamma', 'delta'), {minLength: 1, maxLength: 4});
  await fc.assert(
    fc.asyncProperty(
      names,
      fc.array(fc.option(names, {nil: undefined}), {minLength: 2, maxLength: 5}),
      async (requested, changes) => {
        for (const allowed of changes) {
          const before = [...requested];
          const membership = allowed === undefined ? undefined : [...allowed];
          const sentBefore = FakeManagerSocket.instances[0]?.sent.length ?? 0;
          await act(async () => {
            root.render(
              <ManagerLiveProvider account="synthetic">
                <ManagerLiveProjectScope projects={allowed}>
                  <Probe resource={{topic: 'home', scope: 'account'}} label="account" />
                  {EffectArray.map(requested, project => (
                    <Probe key={project} resource={{topic: 'automatic-memory', project}} label={project} />
                  ))}
                </ManagerLiveProjectScope>
              </ManagerLiveProvider>,
            );
          });
          await flush();
          const socket = FakeManagerSocket.instances[0];
          await act(async () => {
            if (socket.readyState === 0) socket.open(['home', 'automatic-memory']);
            socket.ack();
          });
          await flush();
          const subscription = EffectArray.filter(socket.sent, frame => frame.type === 'subscribe').at(-1);
          expect(subscription?.resources).toContainEqual({topic: 'home', scope: 'account'});
          for (const frame of EffectArray.filter(socket.sent.slice(sentBefore), frame => frame.type === 'subscribe')) {
            const emitted = frame.resources;
            expect(EffectArray.isArray(emitted)).toBe(true);
            if (!EffectArray.isArray(emitted)) throw new Error('Expected subscription resources');
            for (const resource of emitted) {
              if (typeof resource === 'object' && resource !== null && 'project' in resource)
                expect(allowed ?? []).toContain(resource.project);
            }
          }
          for (const project of requested)
            expect(host.querySelector(`[data-probe="${project}"]`)?.getAttribute('data-active')).toBe(
              String(allowed?.includes(project) ?? false),
            );
          expect(host.querySelector('[data-probe="account"]')?.getAttribute('data-active')).toBe('true');
          expect(requested).toEqual(before);
          expect(allowed).toEqual(membership);
          expect(FakeManagerSocket.instances).toHaveLength(1);
        }
      },
    ),
    {
      numRuns: 12,
      examples: [
        [
          ['alpha', 'beta'],
          [['alpha', 'beta'], []],
        ],
      ],
    },
  );
});
