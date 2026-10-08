// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import {ConsolidationModelPicker, useConsolidationModels} from '../../src/consolidation_models.js';
import type {ConsolidationModelOption} from '../../src/ui/contracts.js';

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  localStorage.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function Harness({agent}: {readonly agent: string}) {
  const selection = useConsolidationModels(agent, true);
  return (
    <>
      <ConsolidationModelPicker selection={selection} disabled={false} />
      <button disabled={!selection.model || selection.loading}>Generate</button>
      <button onClick={selection.reload}>Reload</button>
    </>
  );
}

function setup() {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  const requests: {
    readonly agent: string | null;
    readonly signal: AbortSignal | undefined | null;
    readonly resolve: (response: Response) => void;
  }[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const {promise, resolve} = Promise.withResolvers<Response>();
    requests.push({
      agent: new URL(String(input), 'http://localhost').searchParams.get('agent'),
      signal: init?.signal,
      resolve,
    });
    return promise;
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const render = (agent: string) => act(async () => root?.render(<Harness agent={agent} />));
  const respond = (index: number, models: readonly ConsolidationModelOption[]) =>
    act(async () => {
      requests[index].resolve(new Response(JSON.stringify({models}), {headers: {'content-type': 'application/json'}}));
    });
  const select = () => container.querySelector<HTMLSelectElement>('select')!;
  const generate = () => container.querySelector<HTMLButtonElement>('button')!;
  const choose = (id: string) =>
    act(async () => {
      select().value = id;
      select().dispatchEvent(new Event('change', {bubbles: true}));
    });
  return {requests, container, render, respond, select, generate, choose};
}

const option = (id: string, isDefault = true): ConsolidationModelOption => ({id, label: id, isDefault});

it('aborts the previous agent catalog and never exposes its models after switching agents', async () => {
  const ui = setup();
  await ui.render('codex');
  expect(ui.generate().disabled).toBe(true);
  await ui.render('claude');
  expect(ui.requests.map(request => request.agent)).toEqual(['codex', 'claude']);
  expect(ui.requests[0].signal?.aborted).toBe(true);
  await ui.respond(1, [option('sonnet')]);
  expect(ui.select().value).toBe('sonnet');
  expect(ui.generate().disabled).toBe(false);
  await ui.respond(0, [option('stale-codex')]);
  expect(ui.select().value).toBe('sonnet');
  expect(ui.container.textContent).not.toContain('stale-codex');
  await ui.render('codex');
  expect(ui.generate().disabled).toBe(true);
  expect(ui.select().value).toBe('');
  await ui.respond(2, [option('fresh-codex')]);
  expect(ui.select().value).toBe('fresh-codex');
});

it('restores only listed choices and disables generation until a refreshed catalog validates the model', async () => {
  localStorage.setItem('threadnote.manager.consolidationModel.codex', 'unavailable-model');
  const ui = setup();
  await ui.render('codex');
  await ui.respond(0, [option('recommended'), option('fast', false)]);
  expect(ui.select().value).toBe('recommended');
  await ui.choose('fast');
  expect(localStorage.getItem('threadnote.manager.consolidationModel.codex')).toBe('fast');
  const reload = () => act(async () => ui.container.querySelectorAll<HTMLButtonElement>('button')[1].click());
  await reload();
  expect(ui.generate().disabled).toBe(true);
  await ui.respond(1, [option('recommended'), option('fast', false)]);
  expect(ui.select().value).toBe('fast');
  await reload();
  expect(ui.generate().disabled).toBe(true);
  await ui.respond(2, [option('new-recommended')]);
  expect(ui.select().value).toBe('new-recommended');
  expect(ui.generate().disabled).toBe(false);
});
