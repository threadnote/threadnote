import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
// @vitest-environment happy-dom
import React, {act} from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import type {TreeNode} from '../../src/ui/contracts.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

vi.mock('../../src/memory_editor.js', () => ({MemoryEditor: () => <div>Editor</div>}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('keeps failed agent output out of the draft, then retries and saves to a separate result topic', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  vi.spyOn(window, 'setInterval').mockImplementation(() => setTimeout(() => undefined, 0));
  const prefix = 'threadnote://user/test/memories';
  const leaf = (name: string): TreeNode => ({
    name,
    uri: `${prefix}/durable/projects/project/${name}.md`,
    relativePath: `durable/projects/project/${name}.md`,
    isDir: false,
    isSystem: false,
    isShared: false,
    metadata: {
      kind: 'durable',
      status: 'active',
      project: 'project',
      topic: name,
      sourceAgentClient: 'test',
      timestamp: '2026-10-08T00:00:00Z',
    },
  });
  const leaves = [leaf('source-a'), leaf('source-b'), leaf('source-c')];
  let memoryReads = 0;
  const posts: {path: string; body: Record<string, unknown>}[] = [];
  let failDraft = true;
  let failModels = true;
  const json = (value: unknown) => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    // Exercise the explicit REST compatibility path in this consolidation fixture.
    if (url.pathname === '/api/live-session')
      return Promise.resolve(
        new Response(JSON.stringify({error: 'Live unavailable in this REST fixture'}), {status: 404}),
      );
    const body = init?.body
      ? Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(String(init.body)))
      : {};
    if (init?.body) posts.push({path: url.pathname, body});
    if (url.pathname === '/api/state')
      return Promise.resolve(
        json({
          agents: [{id: 'codex', label: 'Codex', available: true}],
          config: {user: 'test', account: 'local', agentContextHome: '/tmp/threadnote-context'},
          autoUpdate: {effectivePolicy: 'notify'},
          updateAvailable: false,
          version: 'fixture',
        }),
      );
    if (url.pathname === '/api/tree')
      return Promise.resolve(
        json({
          resourcesTree: {
            ...leaf('memories'),
            uri: prefix,
            relativePath: '',
            isDir: true,
            children: [{...leaf('project'), relativePath: 'durable/projects/project', isDir: true, children: leaves}],
          },
          tree: {
            ...leaf('memories'),
            uri: prefix,
            relativePath: '',
            isDir: true,
            children: [{...leaf('project'), relativePath: 'durable/projects/project', isDir: true, children: leaves}],
          },
        }),
      );
    if (url.pathname === '/api/shares/conflicts') return Promise.resolve(json({conflicts: []}));
    if (url.pathname === '/api/attention/context-maintenance')
      return Promise.resolve(
        json({version: 2, paused: false, state: 'idle', generation: 'fixture', projects: [], cases: [], receipts: []}),
      );
    if (url.pathname === '/api/graphs')
      return Promise.resolve(
        json({repositories: [], builds: [], diagnostics: [], views: [], waiterCount: 0, waiters: []}),
      );
    if (url.pathname === '/api/processes')
      return Promise.resolve(json({processes: [], schemaVersion: 1, truncated: false}));
    if (url.pathname === '/api/consolidation-models')
      return Promise.resolve(
        failModels
          ? new Response(JSON.stringify({error: 'Model catalog temporarily unavailable'}), {status: 503})
          : json({
              models: [
                {id: 'test-standard', label: 'Test standard', isDefault: true},
                {id: 'test-fast', label: 'Test fast', isDefault: false},
              ],
            }),
      );
    if (url.pathname === '/api/shares') return Promise.resolve(json({shares: []}));
    if (url.pathname === '/api/home')
      return Promise.resolve(json({version: 1, project: 'project', lanes: [], handoffs: [], stats: {memories: 2}}));
    if (url.pathname === '/api/memory') {
      memoryReads++;
      const node = EffectOption.getOrUndefined(
        EffectArray.findFirst(leaves, l => l.uri === url.searchParams.get('uri')),
      );
      return Promise.resolve(
        json({
          node,
          content: 'MEMORY\nkind: durable\n\nClaim.',
          record: {metadata: node?.metadata, body: 'Claim.', uri: node?.uri},
        }),
      );
    }
    if (url.pathname === '/api/consolidations') {
      const sourceUris = Schema.decodeUnknownSync(Schema.Array(Schema.String))(body.uris);
      return Promise.resolve(
        json({
          ...(failDraft
            ? {
                job: {
                  id: 'failed-job',
                  agent: 'codex',
                  sourceUris,
                  status: 'failed',
                  error: 'Codex model is not supported.\n\nERROR: generation failed.',
                },
              }
            : {
                job: {
                  id: 'job',
                  agent: 'codex',
                  status: 'completed',
                  draft: 'Final claim.',
                  sourceUris,
                  sources: EffectArray.map(
                    EffectArray.filter(leaves, l => sourceUris.includes(l.uri)),
                    l => ({
                      uri: l.uri,
                      revision: Effect.pipe('a', EffectString.repeat(64)),
                      fragments: ['Claim.'],
                      codeCitations: [],
                      relations: [],
                    }),
                  ),
                },
              }),
        }),
      );
    }
    if (url.pathname === '/api/consolidations/job/apply')
      return Promise.resolve(
        json({output: 'Applied', resultUri: `${prefix}/durable/projects/project/consolidation-job.md`}),
      );
    return Promise.resolve(json({}));
  });
  const container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  await act(async () => {
    (await import('../../src/ui.js')).mountManager({integrations: []});
  });
  const project = container.querySelector<HTMLSelectElement>('[aria-label="Workspace project"]')!;
  await act(async () => {
    project.value = 'project';
    project.dispatchEvent(new Event('change', {bubbles: true}));
  });
  const button = (text: string) =>
    EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...document.querySelectorAll<HTMLButtonElement>('button')],
        b =>
          Effect.pipe(b.textContent, effectOptionalString =>
            effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
          ) === text || b.querySelector('strong')?.textContent === text,
      ),
    )!;
  await act(async () => button('Library').click());
  const selectSource = async (name: string) =>
    act(async () => container.querySelector<HTMLInputElement>(`[aria-label="Select ${name}"]`)!.click());
  await selectSource('source-a');
  expect(button('Consolidate')).toBeDefined();
  expect(button('Consolidate').disabled).toBe(true);
  await selectSource('source-b');
  expect(button('Consolidate').disabled).toBe(false);
  await act(async () => button('Consolidate').click());
  expect(container.querySelector('dialog[open] h2')?.textContent).toBe('Consolidate memories');
  expect(container.querySelector('dialog[open] details.consolidation-details')).toBeNull();
  expect(button('Generate draft')).toBeDefined();
  expect(button('Generate draft').disabled).toBe(true);
  expect(container.textContent).toContain('Could not load models');
  failModels = false;
  await act(async () => button('Reload models').click());
  const model = container.querySelector<HTMLSelectElement>('[aria-label="Consolidation model"]')!;
  expect(model.value).toBe('test-standard');
  await act(async () => {
    model.value = 'test-fast';
    model.dispatchEvent(new Event('change', {bubbles: true}));
  });
  expect(button('Generate draft').disabled).toBe(false);
  expect(memoryReads).toBe(0);
  expect(container.querySelector<HTMLInputElement>('[aria-label="Consolidated memory topic"]')?.value).toBe('');
  await act(async () => button('Generate draft').click());
  expect(container.querySelector('[aria-label="Consolidation draft"]')).toBeNull();
  expect(container.querySelectorAll('fieldset')).toHaveLength(0);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Codex model is not supported.');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Choose another model');
  expect(EffectArray.filter(posts, p => p.path === '/api/consolidations').at(-1)?.body.model).toBe('test-fast');
  expect(button('Save memory')).toBeUndefined();
  failDraft = false;
  await act(async () => button('Generate draft').click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close details"]')!.click());
  await selectSource('source-b');
  await selectSource('source-c');
  await act(async () => button('Consolidate').click());
  expect(container.querySelector('[aria-label="Consolidation draft"]')).toBeNull();
  expect(button('Save memory')).toBeUndefined();
  await act(async () => button('Generate draft').click());
  expect(EffectArray.filter(posts, p => p.path === '/api/consolidations').at(-1)?.body.uris).toEqual([
    leaves[0].uri,
    leaves[2].uri,
  ]);
  const editDraft = async (value: string) =>
    act(async () => {
      const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="Consolidation draft"]')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
      textarea.dispatchEvent(new Event('input', {bubbles: true}));
    });
  await editDraft('');
  expect(container.querySelector('[aria-label="Consolidation draft"]')).not.toBeNull();
  expect(button('Save memory').disabled).toBe(true);
  await editDraft('Final claim.');
  expect(
    EffectOption.getOrUndefined(EffectArray.findFirst(posts, p => p.path === '/api/consolidations'))?.body,
  ).toMatchObject({
    topic: '',
    kind: 'durable',
    status: 'active',
  });
  const decision = container.querySelector<HTMLSelectElement>('[aria-label="Support for paragraph 1"]')!;
  await act(async () => {
    decision.value = 'unsupported';
    decision.dispatchEvent(new Event('change', {bubbles: true}));
  });
  await act(async () => button('Save memory').click());
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('dialog button[type="submit"]')].at(-1)!.click(),
  );
  const applied = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      posts,
      __effectArrayValue => !!(p => Effect.pipe(p.path, EffectString.endsWith('/apply')))(__effectArrayValue),
    ),
  )?.body;
  expect(applied).toMatchObject({
    topic: '',
    project: 'project',
    reviews: [{section: 'Final claim.', disposition: 'unsupported', supports: []}],
  });
  expect(applied?.topic).not.toBe('source-a');
});
