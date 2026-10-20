// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {
  ConsolidationModelPicker,
  reconcileConsolidationModelChoice,
  useConsolidationModels,
} from '../../src/consolidation_models.js';
import type {ConsolidationModelOption} from '../../src/ui/contracts.js';
import {consolidationAgent} from '../../src/request_inputs.js';
import {isAgentClient} from '../../src/ui/support.js';

it('accepts local AI at the consolidation request boundary', () => {
  expect(consolidationAgent('local-ai')).toBe('local-ai');
  expect(isAgentClient('local-ai')).toBe(true);
  expect(() => consolidationAgent('unknown-provider')).toThrow();
});

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  localStorage.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Harness({agent, storageKey}: {readonly agent: string; readonly storageKey?: string}) {
  const selection = useConsolidationModels(agent, true, storageKey);
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
  const setupRequests: {readonly resolve: (response: Response) => void; readonly signal?: AbortSignal | null}[] = [];
  const methods: string[] = [];
  const requests: {
    readonly agent: string | null;
    readonly signal: AbortSignal | undefined | null;
    readonly resolve: (response: Response) => void;
  }[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const {promise, resolve} = Promise.withResolvers<Response>();
    methods.push(init?.method ?? 'GET');
    if (String(input) === '/api/models/setup') {
      setupRequests.push({resolve, signal: init?.signal});
      return promise;
    }
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
  const render = (agent: string, storageKey?: string) =>
    act(async () => root?.render(<Harness agent={agent} storageKey={storageKey} />));
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
  const reload = () => act(async () => container.querySelectorAll<HTMLButtonElement>('button')[1].click());
  const respondSetup = (index: number, status: Record<string, unknown>) =>
    act(async () => {
      setupRequests[index].resolve(
        new Response(JSON.stringify(status), {headers: {'content-type': 'application/json'}}),
      );
    });
  return {requests, setupRequests, methods, container, render, respond, respondSetup, select, generate, choose, reload};
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

it('retains unavailable explicit choices until explicit reselection and validates them after reload', async () => {
  localStorage.setItem('threadnote.manager.consolidationModel.codex', 'unavailable-model');
  const ui = setup();
  await ui.render('codex');
  await ui.respond(0, [option('recommended'), option('fast', false)]);
  expect(ui.select().value).toBe('unavailable-model');
  expect(ui.container.textContent).toContain('unavailable');
  expect(ui.generate().disabled).toBe(true);
  expect(localStorage.getItem('threadnote.manager.consolidationModel.codex')).toBe('unavailable-model');
  await ui.choose('fast');
  expect(localStorage.getItem('threadnote.manager.consolidationModel.codex')).toBe('fast');
  await ui.reload();
  expect(ui.generate().disabled).toBe(true);
  await ui.respond(1, [option('recommended'), option('fast', false)]);
  expect(ui.select().value).toBe('fast');
  await ui.reload();
  expect(ui.generate().disabled).toBe(true);
  await ui.respond(2, [option('new-recommended')]);
  expect(ui.select().value).toBe('fast');
  expect(ui.generate().disabled).toBe(true);
  expect(localStorage.getItem('threadnote.manager.consolidationModel.codex')).toBe('fast');
  await ui.choose('new-recommended');
  expect(ui.generate().disabled).toBe(false);
});

it('keeps topic model selection separate from consolidation selection', async () => {
  localStorage.setItem('threadnote.manager.consolidationModel.local-ai', 'consolidation-choice');
  const ui = setup();
  await ui.render('local-ai', 'topicModel');
  await ui.respond(0, [option('consolidation-choice'), option('topic-choice', false)]);
  await ui.choose('topic-choice');
  expect(localStorage.getItem('threadnote.manager.topicModel.local-ai')).toBe('topic-choice');
  expect(localStorage.getItem('threadnote.manager.consolidationModel.local-ai')).toBe('consolidation-choice');
});

it('keeps explicit choices through temporarily empty catalogs and provider switches', async () => {
  const ui = setup();
  await ui.render('codex');
  await ui.respond(0, [option('first'), option('chosen', false)]);
  await ui.choose('chosen');
  await ui.reload();
  await ui.respond(1, []);
  expect(ui.select().value).toBe('chosen');
  expect(ui.generate().disabled).toBe(true);
  await ui.render('claude');
  await ui.respond(2, [option('sonnet')]);
  await ui.choose('sonnet');
  await ui.render('codex');
  await ui.respond(3, [option('replacement')]);
  expect(ui.select().value).toBe('chosen');
  expect(ui.generate().disabled).toBe(true);
  await ui.reload();
  await ui.respond(4, [option('chosen', false), option('replacement')]);
  expect(ui.select().value).toBe('chosen');
  expect(ui.generate().disabled).toBe(false);
  expect(ui.methods.every(method => method === 'GET')).toBe(true);
});

it('preserves every explicit identity across arbitrary catalog changes without mutating inputs', () => {
  fc.assert(
    fc.property(
      fc.string({minLength: 1, maxLength: 60}),
      fc.uniqueArray(fc.string({minLength: 1, maxLength: 60}), {maxLength: 20}),
      (id, ids) => {
        const preferred = Object.freeze({id, explicit: true});
        const models = Object.freeze(ids.map(value => Object.freeze(option(value))));
        expect(reconcileConsolidationModelChoice(preferred, models)).toBe(preferred);
        expect(preferred.id).toBe(id);
        expect(models.map(model => model.id)).toEqual(ids);
      },
    ),
    {numRuns: 75},
  );
});

const setupStatus = (phase: 'pending' | 'ready') => ({
  version: 1,
  intentEpoch: 1,
  modelId: 'gemma-fixture',
  totalBytes: 4_590_807_392,
  policy: 'automatic',
  phase,
  bytes: phase === 'ready' ? 4_590_807_392 : 0,
  attempts: 1,
  artifactReady: phase === 'ready',
  effectiveDefault: phase === 'ready',
  environmentOff: false,
});

it('refreshes local choices on readiness without replacing an explicit model or generating', async () => {
  vi.useFakeTimers();
  localStorage.setItem('threadnote.manager.consolidationModel.local-ai', 'chosen-local');
  const ui = setup();
  await ui.render('local-ai');
  await ui.respondSetup(0, setupStatus('pending'));
  await ui.respond(0, [option('chosen-local', false)]);
  expect(ui.generate().disabled).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  await ui.respondSetup(1, setupStatus('ready'));
  expect(ui.requests).toHaveLength(2);
  expect(ui.generate().disabled).toBe(true);
  await ui.respond(1, [option('gemma-fixture')]);
  expect(ui.select().value).toBe('chosen-local');
  expect(ui.container.textContent).toContain('unavailable');
  expect(ui.generate().disabled).toBe(true);
  expect(localStorage.getItem('threadnote.manager.consolidationModel.local-ai')).toBe('chosen-local');
  expect(ui.methods.every(method => method === 'GET')).toBe(true);
  await ui.choose('gemma-fixture');
  expect(ui.generate().disabled).toBe(false);
  expect(ui.methods.every(method => method === 'GET')).toBe(true);
});

it('adopts the arriving recommendation only when never chosen, and rejects superseded catalog responses', async () => {
  vi.useFakeTimers();
  const ui = setup();
  await ui.render('local-ai');
  await ui.respondSetup(0, setupStatus('pending'));
  await ui.respond(0, []);
  expect(ui.generate().disabled).toBe(true);
  await ui.reload();
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  await ui.respondSetup(1, setupStatus('ready'));
  expect(ui.requests).toHaveLength(3);
  expect(ui.requests[1].signal?.aborted).toBe(true);
  await ui.respond(2, [option('gemma-fixture')]);
  expect(ui.select().value).toBe('gemma-fixture');
  expect(localStorage.getItem('threadnote.manager.consolidationModel.local-ai')).toBeNull();
  await ui.respond(1, [option('stale-local')]);
  expect(ui.select().value).toBe('gemma-fixture');
  expect(ui.container.textContent).not.toContain('stale-local');
  expect(ui.methods.every(method => method === 'GET')).toBe(true);
});
