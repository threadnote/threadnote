// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {ModelSetupIndicator, ModelSetupPanel, useModelSetup} from '../../src/model_setup.js';
import type {ModelSetupStatus} from '../../src/model_setup_contracts.js';

let root: Root | undefined;
let state: ModelSetupStatus;
let calls: {body?: Record<string, unknown>; signal?: AbortSignal | null}[];
let failure = false;
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  state = {
    version: 1,
    intentEpoch: 7,
    modelId: 'gemma-4',
    totalBytes: 4_000_000_000,
    policy: 'automatic',
    phase: 'not-requested',
    bytes: 0,
    attempts: 0,
    artifactReady: false,
    effectiveDefault: false,
    environmentOff: false,
  };
  calls = [];
  failure = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({body, signal: init.signal});
      if (failure) throw new Error('private unsafe network diagnostic');
      if (body?.action === 'policy')
        state = {
          ...state,
          intentEpoch: state.intentEpoch + 1,
          policy: body.policy as 'automatic' | 'off',
          phase: body.policy === 'off' ? 'off' : 'pending',
        };
      if (body?.action === 'setup' || body?.action === 'retry') state = {...state, phase: 'pending'};
      return new Response(JSON.stringify(state));
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
async function render(children: React.ReactNode): Promise<void> {
  if (!root) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root?.render(children));
}
function button(text: string): HTMLButtonElement {
  const result = [...document.querySelectorAll('button')].find(item => item.textContent?.includes(text));
  if (!result) throw new Error(`Missing button ${text}`);
  return result;
}
function Probe({enabled = true}: {enabled?: boolean}) {
  const {readyVersion, refresh} = useModelSetup(enabled);
  return (
    <>
      <output>{readyVersion}</output>
      <button onClick={() => void refresh()}>Read setup</button>
    </>
  );
}
const token = () => Number(document.querySelector('output')?.textContent);

it('shares one GET loop across surfaces, never POSTs on mount, and stops on ready/unmount', async () => {
  state = {...state, phase: 'downloading', bytes: 2_000_000_000};
  await render(
    <>
      <ModelSetupPanel />
      <ModelSetupIndicator />
      <Probe />
    </>,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toBeUndefined();
  expect(document.querySelector('progress')?.value).toBe(2_000_000_000);
  const initialToken = token();
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(calls).toHaveLength(2);
  state = {...state, phase: 'ready', artifactReady: true};
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(token()).toBe(initialToken + 1);
  expect(document.body.textContent).toContain('Model files are verified');
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(calls).toHaveLength(3);
  await act(async () => button('Read setup').click());
  expect(token()).toBe(initialToken + 1);
  await render(<ModelSetupIndicator enabled={false} />);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps polling until the last subscriber leaves and aborts in-flight work', async () => {
  state = {...state, phase: 'pending'};
  await render(
    <>
      <ModelSetupPanel />
      <ModelSetupIndicator key="indicator" />
    </>,
  );
  await render(<ModelSetupIndicator key="indicator" />);
  const deferred = Promise.withResolvers<Response>();
  vi.mocked(fetch).mockImplementationOnce((_url, init) => {
    calls.push({signal: init?.signal});
    return deferred.promise;
  });
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(calls).toHaveLength(2);
  const signal = calls.at(-1)?.signal;
  await render(null);
  expect(signal?.aborted).toBe(true);
  await act(async () =>
    deferred.resolve(new Response(JSON.stringify({...state, phase: 'ready', artifactReady: true}))),
  );
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(calls).toHaveLength(2);
});

it('makes no request for disabled local-generation surfaces', async () => {
  await render(
    <>
      <ModelSetupIndicator enabled={false} />
      <Probe enabled={false} />
    </>,
  );
  expect(calls).toHaveLength(0);
  expect(document.querySelector('[role=status]')).toBeNull();
});

it('uses explicit epoch-fenced actions and exposes durable off and environment-managed off', async () => {
  await render(<ModelSetupPanel />);
  await act(async () => button('Set up local model').click());
  expect(calls[1]?.body).toEqual({action: 'setup', confirm: true, expectedEpoch: 7});
  const toggle = document.querySelector('[role=switch]') as HTMLButtonElement;
  // Stop remains available while a transfer is active.
  expect(toggle.disabled).toBe(false);
  await act(async () => toggle.click());
  expect(calls[2]?.body).toEqual({action: 'policy', policy: 'off', confirm: true, expectedEpoch: 7});
  expect(document.body.textContent).toContain('Automatic setup is off');
  expect(button('Enable automatic').disabled).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => toggle.click());
  expect(calls[3]?.body).toEqual({action: 'policy', policy: 'automatic', confirm: true, expectedEpoch: 8});
  state = {...state, environmentOff: true, phase: 'off'};
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(toggle.disabled).toBe(true);
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(document.body.textContent).toContain('Managed by an environment setting');
});

it.each([
  ['not-requested', 'Local model is not set up', 'Set up local model'],
  ['pending', 'Preparing local model', 'Setting up…'],
  ['verifying', 'Verifying local model', 'Setting up…'],
  ['retry-wait', 'Setup will retry', 'Retry setup'],
  ['action-required', 'Model setup needs attention', 'Retry setup'],
] as const)('presents %s with an accessible status and primary action', async (phase, text, primary) => {
  state = {...state, phase, reason: 'insufficient-disk', nextAttemptAt: Date.now() + 60_000};
  await render(<ModelSetupPanel />);
  expect(document.querySelector('[role=status]')?.textContent).toBe(text);
  expect(button(primary).classList.contains('primary')).toBe(true);
  expect(document.querySelector('details')?.textContent).toContain('Free disk space');
  if (phase === 'retry-wait' || phase === 'action-required') {
    await act(async () => button(primary).click());
    expect(calls.at(-1)?.body?.action).toBe('retry');
  }
});

it('uses bounded error backoff and recovers without displaying raw diagnostics', async () => {
  failure = true;
  await render(<ModelSetupPanel />);
  expect(calls).toHaveLength(1);
  expect(document.querySelector('[role=alert]')?.textContent).toContain('status is unavailable');
  expect(document.body.textContent).not.toContain('private unsafe');
  for (const delay of [1500, 3000, 6000, 12000, 24000, 30000, 30000]) {
    const count = calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
    expect(calls).toHaveLength(count);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(calls).toHaveLength(count + 1);
  }
  failure = false;
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(document.querySelector('[role=alert]')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it('fences duplicate action clicks and refreshes after a rejected stale action', async () => {
  await render(<ModelSetupPanel />);
  const deferred = Promise.withResolvers<Response>();
  vi.mocked(fetch).mockImplementationOnce((_url, init) => {
    calls.push({body: JSON.parse(String(init?.body)) as Record<string, unknown>, signal: init?.signal});
    return deferred.promise;
  });
  await act(async () => {
    button('Set up local model').click();
    button('Set up local model').click();
  });
  expect(calls).toHaveLength(2);
  await act(async () => deferred.resolve(new Response(JSON.stringify({error: 'Changed elsewhere'}), {status: 409})));
  expect(document.querySelector('[role=alert]')?.textContent).toContain('Refreshing its current status');
  state = {...state, intentEpoch: 10, phase: 'off', policy: 'off'};
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(document.body.textContent).toContain('Automatic setup is off');
});

it('increments readiness only on false-to-true transitions for arbitrary response sequences', async () => {
  await render(<Probe />);
  await fc.assert(
    fc.asyncProperty(fc.array(fc.boolean(), {maxLength: 12}), async values => {
      state = {...state, phase: 'not-requested', artifactReady: false};
      await act(async () => button('Read setup').click());
      let expected = token();
      let previous = false;
      for (const ready of values) {
        state = {...state, phase: ready ? 'ready' : 'not-requested', artifactReady: ready};
        if (ready && !previous) expected++;
        previous = ready;
        await act(async () => button('Read setup').click());
        expect(token()).toBe(expected);
      }
    }),
    {numRuns: 20},
  );
});
