// @vitest-environment happy-dom

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  CONTEXT_BRIEF_MAXIMUM_CODE_REFS,
  CONTEXT_BRIEF_PROJECTOR_VERSION,
  CONTEXT_BRIEF_VERSION,
  type ProjectedContextBriefV1,
} from '@threadnote/context/types';
import type {
  ManagerContextConnectionsResponse,
  ManagerContextReadResponse,
  ManagerRecallResponse,
} from '@threadnote/threadnote/manager/context';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {ContextBriefResult, ContextPanel, parseCodeRefs} from '@threadnote/manager/context/view';

const MEMORY_URI = 'threadnote://memory/tn_manager_context';
const RELOCATED_URI = 'threadnote://user/tester/memories/durable/projects/product/context-brief.md';
const GRAPH_REF = `cgs_${'a'.repeat(32)}`;

let reactRoot: Root | undefined;
let originalFetch: typeof fetch;
let requests: Array<{readonly body: Record<string, unknown>; readonly path: string}>;
let canonicalMemoryBody: string;

beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch;
  requests = [];
  canonicalMemoryBody = 'Canonical memory body';
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const path =
        typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (path === '/api/worksets') {
        return Promise.resolve(
          jsonResponse({
            definitions: [{memberCount: 1, name: 'platform'}],
            definitionSource: 'seed-manifest',
            editability: {state: 'editable'},
            projectEditability: {state: 'editable'},
            projects: [
              {
                branchState: 'current',
                folder: 'threadnote',
                name: 'threadnote',
                path: '/private/threadnote',
                worksetCount: 1,
                worksets: ['platform'],
              },
              {
                branchState: 'current',
                folder: 'other',
                name: 'other-project',
                path: '/private/other-repository',
                worksetCount: 0,
                worksets: [],
              },
              {
                branchState: 'current',
                folder: 'changed',
                name: 'changed-project',
                path: '/private/changed',
                worksetCount: 0,
                worksets: [],
              },
            ],
            projectsReadOnly: false,
            readOnly: false,
            revision: 'a'.repeat(64),
            type: 'manager-workset-catalog',
            version: 1,
          }),
        );
      }
      requests.push({body, path});
      if (path === '/api/context/brief') {
        return Promise.resolve(
          jsonResponse(
            projectedBrief(GRAPH_REF, body.workset ? 'workset' : 'repository', {
              staleAnchorRecovery: body.task === 'Recover this Context Brief graph',
            }),
          ),
        );
      }
      if (path === '/api/graphs/action') {
        return Promise.resolve(
          jsonResponse({output: 'Ready in an isolated process · 12 files · 40 symbols · 21 edges'}),
        );
      }
      if (path === '/api/worksets/prepare') {
        return Promise.resolve(
          jsonResponse({
            job: {
              createdAt: '2026-08-31T00:00:00.000Z',
              id: 'cgwj_context_recovery',
              progress: {message: 'Ready.', phase: 'completed', total: 1},
              result: {state: 'ready'},
              status: 'completed',
              workset: body.workset,
            },
          }),
        );
      }
      if (path === '/api/context/recall') {
        const explicitProject = typeof body.project === 'string' ? body.project : undefined;
        return Promise.resolve(
          jsonResponse(recallResponse(String(body.query ?? ''), explicitProject ?? 'threadnote', explicitProject)),
        );
      }
      if (path === '/api/context/feedback') {
        return Promise.resolve(jsonResponse({action: body.action, recorded: true, uri: body.uri}));
      }
      if (path === '/api/context/connections') {
        return Promise.resolve(jsonResponse(connectionsResponse(String(body.uri ?? ''))));
      }
      if (path === '/api/memory/relations') {
        canonicalMemoryBody = 'Updated canonical memory body';
        return Promise.resolve(
          jsonResponse({
            content: 'updated canonical content',
            memoryId: 'tn_manager_context',
            relations: body.relations,
            uri: RELOCATED_URI,
          }),
        );
      }
      if (path === '/api/context/read') return Promise.resolve(jsonResponse(readResponse(Number(body.page ?? 0))));
      throw new Error(`Unexpected Manager Context request: ${path}`);
    },
    {preconnect: originalFetch.preconnect},
  );
});

afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot?.unmount());
  reactRoot = undefined;
  document.body.replaceChildren();
  globalThis.fetch = originalFetch;
});

describe('Manager Context workspace', () => {
  it('offers resume in the Context Brief mode selector', async () => {
    await renderContext();

    expect([...selectWithLabel('Mode').options].map(option => option.value)).toContain('resume');
  });

  it('surfaces the local value workspace beside Context Brief and Recall', async () => {
    await renderContext();
    await clickButton('Value');

    expect(document.body.textContent).toContain('Load value report');
    expect(document.body.textContent).toContain('Retention');
    expect(document.body.textContent).toContain('Delete local value data');
  });

  it('keeps memory-only projects available in the Context memory selector', async () => {
    await renderContext(['memory-only-project']);

    expect([...selectWithLabel('Memory project').options].map(option => option.value)).toContain('memory-only-project');
    expect([...selectWithLabel('Memory project').options].map(option => option.value)).toContain('threadnote');
  });

  it('composes a full brief, opens canonical memory, and reruns from an exact graph ref', async () => {
    await renderContext();
    await changeSelect(selectWithLabel('Repository'), '/private/threadnote');
    await changeSelect(selectWithLabel('Evidence detail'), 'source');
    await changeTextArea(textareaWithLabel('Task'), 'Trace the Context Brief Manager contract');
    await changeTextArea(textareaWithLabel('Code anchors'), 'apps/threadnote/src/manager/context.ts\n' + GRAPH_REF);

    await clickButton('Build brief');
    await waitForText('Context Brief evidence is projected here');

    expect(requests[0]).toEqual({
      body: {
        budgetTokens: 1_250,
        callerCwd: '/private/threadnote',
        codeRefs: ['apps/threadnote/src/manager/context.ts', GRAPH_REF],
        detail: 'source',
        mode: 'brief',
        task: 'Trace the Context Brief Manager contract',
      },
      path: '/api/context/brief',
    });
    expect(document.body.textContent).toContain('1/1 ready');
    expect(document.body.textContent).toContain('1 decisions · 1 handoffs · 5 considered');
    expect(document.body.textContent).toContain('ContextPanel');
    expect(document.body.textContent).toContain('depends_on');
    expect(document.body.textContent).toContain('Graph snapshot is partial.');
    expect(document.body.textContent).toContain('stale-link');
    expect(document.body.textContent).toContain('Recommended follow-ups');
    expect(document.body.textContent).toContain('selected by code-citation');
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');

    await clickButton('Rerun from this ref');
    await waitForRequestCount('/api/context/brief', 2);
    expect(requests.filter(request => request.path === '/api/context/brief')[1]?.body).toMatchObject({
      codeRefs: [GRAPH_REF],
      mode: 'explain',
    });

    await clickButton('Open memory');
    await waitForText('Canonical memory body page 1.');
    expect(requests.at(-1)).toEqual({body: {page: 0, uri: MEMORY_URI}, path: '/api/context/read'});
    expect(document.body.textContent).toContain('Resolved the requested pointer to its canonical memory.');
    expect(document.body.textContent).toContain(RELOCATED_URI);
    await clickButton('Next page');
    await waitForText('Canonical memory body page 2.');
    expect(requests.at(-1)?.body).toEqual({page: 1, uri: MEMORY_URI});
  });

  it('keeps every entered anchor visible and disables compilation above the server bound', async () => {
    await renderContext();
    await changeSelect(selectWithLabel('Repository'), '/private/threadnote');
    await changeTextArea(textareaWithLabel('Task'), 'Bound the selected anchors');
    const refs = Array.from({length: CONTEXT_BRIEF_MAXIMUM_CODE_REFS + 1}, (_, index) => `src/${index}.ts`);
    await changeTextArea(textareaWithLabel('Code anchors'), refs.join('\n'));

    expect(parseCodeRefs(refs.join('\n'))).toEqual(refs);
    expect(document.body.textContent).toContain(`${refs.length}/${CONTEXT_BRIEF_MAXIMUM_CODE_REFS}`);
    expect(document.body.textContent).toContain(
      `codeRefs may contain at most ${CONTEXT_BRIEF_MAXIMUM_CODE_REFS} entries`,
    );
    expect(findButton('Build brief')?.disabled).toBe(true);
  });

  it('indexes an explicitly selected repository graph and recompiles without losing the Context form or result', async () => {
    await renderContext();
    await changeSelect(selectWithLabel('Repository'), '/private/threadnote');
    await changeTextArea(textareaWithLabel('Task'), 'Recover this Context Brief graph');
    await changeTextArea(textareaWithLabel('Code anchors'), 'apps/threadnote/src/manager/context.ts');
    await clickButton('Build brief');
    await waitForText('Context Brief evidence is projected here');

    expect(document.body.textContent).toContain('stale');
    expect(document.body.textContent).toContain('0/1 resolved');
    expect(document.body.textContent).toContain('Code anchor resolution is incomplete.');

    await clickButton('Index graph and rerun');
    await waitForRequestCount('/api/context/brief', 2);

    expect(requests.filter(request => request.path === '/api/graphs/action')).toEqual([
      {body: {action: 'index-cwd', cwd: '/private/threadnote'}, path: '/api/graphs/action'},
    ]);
    expect(selectWithLabel('Repository').value).toBe('/private/threadnote');
    expect(textareaWithLabel('Task').value).toBe('Recover this Context Brief graph');
    expect(textareaWithLabel('Code anchors').value).toBe('apps/threadnote/src/manager/context.ts');
    expect(document.body.textContent).toContain('Context Brief recompiled with the refreshed graph.');
    expect(document.body.textContent).toContain('Context Brief evidence is projected here');
  });

  it('does not index a different workspace after the displayed brief inputs change', async () => {
    await renderContext();
    await changeSelect(selectWithLabel('Repository'), '/private/threadnote');
    await changeTextArea(textareaWithLabel('Task'), 'Recover only the displayed scope');
    await clickButton('Build brief');
    await waitForText('Context Brief evidence is projected here');
    await changeSelect(selectWithLabel('Repository'), '/private/other-repository');

    await clickButton('Index graph and rerun');
    await waitForText('The Context Brief inputs changed. Rerun the brief before preparing its graph scope.');

    expect(requests.filter(request => request.path === '/api/graphs/action')).toHaveLength(0);
    expect(requests.filter(request => request.path === '/api/context/brief')).toHaveLength(1);
  });

  it('prepares an explicitly selected Workset and recompiles its Context Brief in place', async () => {
    await renderContext();
    await clickButton('Workset');
    await changeSelect(selectWithLabel('Prepared Workset'), 'platform');
    await changeTextArea(textareaWithLabel('Task'), 'Recover the prepared Workset graph');
    await clickButton('Build brief');
    await waitForText('Context Brief evidence is projected here');

    await clickButton('Prepare Workset and rerun');
    await waitForRequestCount('/api/context/brief', 2);

    expect(requests.filter(request => request.path === '/api/worksets/prepare')).toEqual([
      {body: {concurrency: 2, workset: 'platform'}, path: '/api/worksets/prepare'},
    ]);
    expect(selectWithLabel('Prepared Workset').value).toBe('platform');
    expect(document.body.textContent).toContain('Workset platform is ready. Context Brief recompiled');
  });

  it('returns the brief composer to an interactive state after cancellation', async () => {
    globalThis.fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const path =
          typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
        if (path === '/api/worksets') {
          return Promise.resolve(
            jsonResponse({
              definitions: [{memberCount: 1, name: 'platform'}],
              projects: [
                {
                  branchState: 'current',
                  folder: 'threadnote',
                  name: 'threadnote',
                  path: '/private/threadnote',
                  worksetCount: 1,
                  worksets: ['platform'],
                },
              ],
            }),
          );
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), {
            once: true,
          });
        });
      },
      {preconnect: originalFetch.preconnect},
    );
    await renderContext();
    await changeSelect(selectWithLabel('Repository'), '/private/threadnote');
    await changeTextArea(textareaWithLabel('Task'), 'Cancel this bounded compile');
    await clickButton('Build brief');
    expect(document.querySelector('.context-compose')?.getAttribute('aria-busy')).toBe('true');

    await clickButton('Cancel');

    expect(document.querySelector('.context-compose')?.getAttribute('aria-busy')).toBe('false');
    expect(findButton('Build brief')?.disabled).toBe(false);
    expect(document.body.textContent).not.toContain('Compiling bounded graph and memory evidence');
  });

  it('turns repository-qualified Workset refs into an honest task-only narrow rerun', async () => {
    const reruns: Array<{readonly codeRefs?: readonly string[]; readonly mode?: string}> = [];
    const container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    await act(async () =>
      reactRoot?.render(
        React.createElement(ContextBriefResult, {
          brief: projectedBrief(`cgr_${'c'.repeat(40)}`).structuredContent,
          onOpenMemory: () => undefined,
          onRecoverGraph: () => undefined,
          onRerun: overrides => {
            reruns.push(overrides);
          },
          recoveryBusy: false,
        }),
      ),
    );

    await clickButton('Narrow Workset and rerun');

    expect(reruns).toHaveLength(1);
    expect(reruns[0]).toMatchObject({mode: 'explain'});
    expect(reruns[0]).not.toHaveProperty('codeRefs');
  });

  it('uses the returned exact selector when rerunning omitted graph evidence', async () => {
    const reruns: Array<{readonly codeRefs?: readonly string[]; readonly mode?: string; readonly task?: string}> = [];
    const container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    await act(async () =>
      reactRoot?.render(
        React.createElement(ContextBriefResult, {
          brief: projectedBrief(GRAPH_REF).structuredContent,
          onOpenMemory: () => undefined,
          onRecoverGraph: () => undefined,
          onRerun: overrides => reruns.push(overrides),
          recoveryBusy: false,
        }),
      ),
    );

    await clickButton('Rerun from exact ref');

    expect(reruns).toHaveLength(1);
    expect(reruns[0]).toMatchObject({codeRefs: [GRAPH_REF], mode: 'explain'});
    expect(reruns[0]?.task).toContain(GRAPH_REF);
  });

  it('refreshes a stale graph before continuing omitted anchor evidence', async () => {
    const recoveries: string[] = [];
    const reruns: unknown[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    await act(async () =>
      reactRoot?.render(
        React.createElement(ContextBriefResult, {
          brief: projectedBrief(GRAPH_REF, 'repository', {staleAnchorRecovery: true}).structuredContent,
          onOpenMemory: () => undefined,
          onRecoverGraph: scope => recoveries.push(scope),
          onRerun: overrides => reruns.push(overrides),
          recoveryBusy: false,
        }),
      ),
    );

    const continuationButton = document.querySelector<HTMLButtonElement>('.context-continuation button');
    expect(continuationButton?.textContent).toBe('Index graph and rerun');
    await act(async () => continuationButton?.click());

    expect(recoveries).toEqual(['repository']);
    expect(reruns).toHaveLength(0);
    expect(document.querySelector('.context-continuation')?.textContent).toContain('refresh it before');
  });

  it('pages ranked structured recall rows and reads the selected canonical source', async () => {
    await renderContext();
    await clickButton('Recall');
    await changeInput(inputWithLabel('Recall query'), 'Manager Context Brief decision');
    await clickButton('Recall context');
    await waitForText('9 ranked pointers');

    expect(requests.at(-1)).toEqual({
      body: {includeArchived: false, query: 'Manager Context Brief decision'},
      path: '/api/context/recall',
    });
    expect(document.body.textContent).toContain('unread · memories · durable');
    expect(document.body.textContent).toContain('High-confidence code-linked result');
    expect(document.body.textContent).toContain('Evaluated query expansions');
    expect(document.body.textContent).toContain('Recall may be incomplete');
    expect(document.body.textContent).toContain('Useful');
    expect(document.body.textContent).toContain('Applied');

    await clickButton('Applied');
    await waitForRequestCount('/api/context/feedback', 1);
    expect(requests.find(request => request.path === '/api/context/feedback')).toEqual({
      body: {
        action: 'applied',
        project: 'threadnote',
        query: 'Manager Context Brief decision',
        uri: MEMORY_URI,
      },
      path: '/api/context/feedback',
    });
    await waitForText('Recorded: applied');

    await clickButton('Next');
    await waitForText('Second page result');
    expect(requests.filter(request => request.path === '/api/context/recall')).toHaveLength(1);

    const row = document.querySelector<HTMLButtonElement>('.context-recall-card > button');
    expect(row).not.toBeNull();
    await act(async () => row?.click());
    await waitForText('Canonical memory body page 1.');
    expect(requests.at(-1)?.path).toBe('/api/context/read');
  });

  it('lazily lists direct connections, opens neighbors, and saves only through the structured relation editor', async () => {
    await renderContext();
    await changeSelect(selectWithLabel('Repository'), '/private/threadnote');
    await clickButton('Recall');
    await changeInput(inputWithLabel('Recall query'), 'connected memory');
    await clickButton('Recall context');
    await waitForText('9 ranked pointers');
    const row = document.querySelector<HTMLButtonElement>('.context-recall-card > button');
    await act(async () => row?.click());
    await waitForText('Canonical memory body page 1.');

    expect(requests.filter(request => request.path === '/api/context/connections')).toHaveLength(0);
    await clickButton('Connections');
    await waitForText('relations are navigation evidence not entailment');

    expect(requests.filter(request => request.path === '/api/context/connections')).toEqual([
      {body: {includeHistorical: false, uri: MEMORY_URI}, path: '/api/context/connections'},
    ]);
    expect(document.body.textContent).toContain('Outgoing');
    expect(document.body.textContent).toContain('depends_on');
    expect(document.body.textContent).toContain('current');
    expect(document.body.textContent).toContain('Structured relations');
    expect(document.body.textContent).toContain('Inspect ContextPanel');

    await changeInput(inputWithLabel('Target memory'), 'threadnote://memory/tn_neighbor_updated');
    await clickButton('Save relations');
    await waitForRequestCount('/api/memory/relations', 1);
    expect(requests.find(request => request.path === '/api/memory/relations')?.body).toMatchObject({
      expectedContent: 'canonical source content',
      relations: [{type: 'depends_on', uri: 'threadnote://memory/tn_neighbor_updated'}],
      uri: RELOCATED_URI,
    });
    await waitForRequestCount('/api/context/connections', 2);
    await waitForRequestCount('/api/context/read', 2);

    await clickButton('Content');
    await waitForText('Updated canonical memory body page 1.');
    await clickButton('Connections');

    await clickButton('Open neighbor');
    await waitForRequestCount('/api/context/read', 3);
    expect(requests.at(-1)).toMatchObject({
      body: {uri: expect.stringContaining('neighbor.md')},
      path: '/api/context/read',
    });
  });

  it('does not let a delayed relation refresh override newer reader navigation', async () => {
    const routedFetch = globalThis.fetch;
    let refreshAborted = false;
    globalThis.fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const path =
          typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (path !== '/api/context/read' || body.uri !== RELOCATED_URI) return routedFetch(input, init);
        requests.push({body, path});
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              refreshAborted = true;
              reject(new DOMException('Cancelled', 'AbortError'));
            },
            {once: true},
          );
        });
      },
      {preconnect: originalFetch.preconnect},
    );
    await renderContext();
    await clickButton('Recall');
    await changeInput(inputWithLabel('Recall query'), 'relation refresh race');
    await clickButton('Recall context');
    await waitForText('9 ranked pointers');
    const row = document.querySelector<HTMLButtonElement>('.context-recall-card > button');
    await act(async () => row?.click());
    await waitForText('Canonical memory body page 1.');
    await clickButton('Connections');
    await waitForText('Structured relations');

    await clickButton('Save relations');
    await waitForRequestCount('/api/context/read', 2);
    await clickButton('Open neighbor');
    await waitForRequestCount('/api/context/read', 3);
    await flush();

    expect(refreshAborted).toBe(true);
    expect(requests.filter(request => request.path === '/api/context/connections')).toHaveLength(1);
    expect(requests.at(-1)).toMatchObject({
      body: {uri: expect.stringContaining('neighbor.md')},
      path: '/api/context/read',
    });
  });

  it('cancels an in-flight connection lookup when the reader returns to content', async () => {
    const routedFetch = globalThis.fetch;
    let aborted = false;
    globalThis.fetch = Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const path =
          typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
        if (path !== '/api/context/connections') return routedFetch(input, init);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new DOMException('Cancelled', 'AbortError'));
            },
            {once: true},
          );
        });
      },
      {preconnect: originalFetch.preconnect},
    );
    await renderContext();
    await clickButton('Recall');
    await changeInput(inputWithLabel('Recall query'), 'cancel connection lookup');
    await clickButton('Recall context');
    await waitForText('9 ranked pointers');
    const row = document.querySelector<HTMLButtonElement>('.context-recall-card > button');
    await act(async () => row?.click());
    await waitForText('Canonical memory body page 1.');

    await clickButton('Connections');
    await clickButton('Content');

    expect(aborted).toBe(true);
    expect(document.body.textContent).not.toContain('Cancelled');
    expect(document.body.textContent).toContain('Canonical memory body page 1.');
  });

  it('invalidates the stable recall snapshot when any search criterion changes', async () => {
    await renderContext();
    await clickButton('Recall');
    await changeInput(inputWithLabel('Recall query'), 'first criteria');
    await clickButton('Recall context');
    await waitForText('9 ranked pointers');
    await clickButton('Next');
    await waitForText('Second page result');

    await changeInput(inputWithLabel('Recall query'), 'changed criteria');

    expect(document.body.textContent).not.toContain('Second page result');
    expect(document.body.textContent).toContain('Recall returns pointers, not evidence');
    expect(findButton('Next')).toBeUndefined();

    await clickButton('Recall context');
    await waitForText('manager-context-brief');
    expect(requests.filter(request => request.path === '/api/context/recall')).toHaveLength(2);
    expect(requests.at(-1)?.body).toEqual({includeArchived: false, query: 'changed criteria'});

    await changeSelect(selectWithLabel('Memory project'), 'changed-project');
    expect(document.body.textContent).toContain('Recall returns pointers, not evidence');
  });

  it('renders a bounded API error without leaking its cause', async () => {
    globalThis.fetch = Object.assign(
      () =>
        Promise.resolve(
          jsonResponse(
            {code: 'context-operation-failed', error: 'Threadnote could not complete this context operation.'},
            500,
          ),
        ),
      {preconnect: originalFetch.preconnect},
    );
    await renderContext();
    await clickButton('Recall');
    await changeInput(inputWithLabel('Recall query'), 'error state');
    await clickButton('Recall context');
    await waitForText('Threadnote could not complete this context operation.');

    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('/private/');
    expect(document.body.textContent).not.toContain('stack');
  });
});

async function renderContext(projectOptions: readonly string[] = []): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  reactRoot = createRoot(container);
  await act(async () => reactRoot?.render(React.createElement(ContextPanel, {projectOptions})));
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}

async function changeSelect(input: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('change', {bubbles: true}));
  });
}

async function changeTextArea(input: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}

function inputWithLabel(label: string): HTMLInputElement {
  const element = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find(candidate => candidate.textContent?.includes(label))
    ?.querySelector('input');
  if (!element) throw new Error(`Input did not render: ${label}`);
  return element;
}

function selectWithLabel(label: string): HTMLSelectElement {
  const element = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find(candidate => candidate.textContent?.includes(label))
    ?.querySelector('select');
  if (!element) throw new Error(`Select did not render: ${label}`);
  return element;
}

function textareaWithLabel(label: string): HTMLTextAreaElement {
  const element = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find(candidate => candidate.textContent?.includes(label))
    ?.querySelector('textarea');
  if (!element) throw new Error(`Textarea did not render: ${label}`);
  return element;
}

async function clickButton(label: string): Promise<void> {
  const button = findButton(label);
  if (!button) throw new Error(`Button did not render: ${label}`);
  await act(async () => button.click());
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    candidate => candidate.textContent?.trim() === label,
  );
}

async function waitForText(text: string): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    if (document.body.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Text did not render: ${text}`);
}

async function waitForRequestCount(path: string, count: number): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    if (requests.filter(request => request.path === path).length >= count) return;
    await flush();
  }
  throw new Error(
    `Expected ${count} requests to ${path}; observed ${requests.filter(request => request.path === path).length}. Requests: ${JSON.stringify(requests)}`,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}, status});
}

function projectedBrief(
  graphRef = GRAPH_REF,
  recoveryScope: 'repository' | 'workset' = 'repository',
  options: {readonly staleAnchorRecovery?: boolean} = {},
): ProjectedContextBriefV1 {
  const staleAnchorRecovery = options.staleAnchorRecovery === true;
  return {
    maximumBytes: 3_750,
    measurement: {estimatedTokens: 500, structuredBytes: 900, textBytes: 600, totalBytes: 1_500},
    structuredContent: {
      activeHandoffs: [
        {
          excerpt: 'Browser validation remains.',
          freshness: 'unknown',
          freshnessBasis: 'source-commit',
          kind: 'handoff',
          rank: 1,
          topic: 'manager-handoff',
          uri: 'threadnote://user/tester/memories/handoffs/active/threadnote/manager-handoff.md',
        },
      ],
      coverage: {
        gaps: ['Graph snapshot is partial.', ...(staleAnchorRecovery ? ['Code anchor resolution is incomplete.'] : [])],
        graph: {
          complete: true,
          consideredRepositories: 1,
          readyRepositories: 1,
          requestedRepositories: 1,
          states: staleAnchorRecovery ? {stale: 1} : {current: 1},
        },
        memory: {
          codeAnchors: staleAnchorRecovery
            ? {complete: false, matchedMemories: 0, requested: 1, resolved: 0, unresolvedOrdinals: [0]}
            : {complete: true, matchedMemories: 1, requested: 2, resolved: 2},
          consideredCandidates: 5,
          durableCandidates: 2,
          fresh: 1,
          handoffCandidates: 1,
          stale: 1,
          unknown: 1,
        },
        omissions: {
          activeHandoffs: 0,
          coverageGaps: 0,
          durableDecisions: 0,
          graphCards: 1,
          graphContracts: 0,
          recommendedFollowUps: 0,
          stalenessAndConflicts: 0,
        },
      },
      durableDecisions: [
        {
          citationSummary: {
            coverage: 'current-complete',
            exact: 1,
            relocated: 0,
            stale: 0,
            unknown: 0,
            validatorVersion: 1,
          },
          codeRelations: [{anchorOrdinal: 0, citationId: 'tnc_fixture', kind: 'file', status: 'exact'}],
          excerpt: 'Context Brief evidence is projected here. <img src=x onerror=alert(1)>',
          freshness: 'fresh',
          freshnessBasis: 'code-citations',
          kind: 'durable',
          project: 'threadnote',
          rank: 0,
          selectionBasis: 'code-citation',
          topic: 'manager-context-brief',
          uri: MEMORY_URI,
        },
      ],
      evidenceState: 'partial',
      graph: {
        cards: [
          {
            id: 'card-manager-context',
            rank: 0,
            reason: 'Exact Manager Context surface.',
            ref: graphRef,
            repositoryKey: 'threadnote',
            symbol: {
              kind: 'function',
              language: 'typescript',
              line: 20,
              name: 'ContextPanel',
              path: 'src/manager/context/view.tsx',
              qualifiedName: 'manager.ContextPanel',
            },
          },
        ],
        continuation: {omittedCards: 1, state: 'rerun-required', upstreamRemainingEstimate: 2},
        contracts: [
          {
            authority: 'authoritative',
            evidence: {line: 40, path: 'apps/threadnote/src/manager/context.ts', repositoryKey: 'threadnote'},
            id: 'contract-manager-context',
            provenance: 'resolved',
            rank: 0,
            relation: 'depends_on',
            sourceRef: graphRef,
            targetRef: `cgs_${'b'.repeat(32)}`,
          },
        ],
      },
      mode: 'brief',
      output: {
        omittedItems: 1,
        projectorVersion: CONTEXT_BRIEF_PROJECTOR_VERSION,
        returnedItems: 6,
        truncated: true,
      },
      recommendedFollowUps: [
        {
          arguments: {uri: MEMORY_URI},
          id: 'follow-read',
          operation: 'read-memory',
          rank: 0,
          tool: 'read_context',
          uri: MEMORY_URI,
        },
        {
          arguments: {
            budgetTokens: 800,
            callerCwd: '/private/threadnote',
            edgeLimit: 12,
            nodeId: graphRef,
            nodeLimit: 8,
            operation: 'node',
          },
          id: 'follow-inspect',
          operation: 'inspect-node',
          rank: 1,
          ref: graphRef,
          tool: 'inspect_code_graph',
        },
        {
          arguments:
            recoveryScope === 'repository'
              ? {
                  budgetTokens: 800,
                  callerCwd: '/private/threadnote',
                  edgeLimit: 12,
                  nodeLimit: 8,
                  operation: 'query',
                  query: 'code graph readiness',
                }
              : {
                  budgetTokens: 800,
                  edgeLimit: 12,
                  nodeLimit: 8,
                  operation: 'query',
                  query: 'code graph readiness',
                  workset: 'platform',
                },
          id: 'follow-graph-status',
          operation: 'graph-status',
          rank: 2,
          scope: recoveryScope,
          tool: 'inspect_code_graph',
          ...(recoveryScope === 'workset' ? {workset: 'platform'} : {}),
        },
      ],
      scope: {
        freshness: staleAnchorRecovery ? 'stale' : 'fresh',
        kind: recoveryScope,
        name: recoveryScope === 'repository' ? 'threadnote' : 'platform',
        readyRepositories: 1,
        requestedRepositories: 1,
      },
      stalenessAndConflicts: [
        {id: 'issue-stale', kind: 'stale-link', rank: 0, summary: 'One citation moved.', uris: [MEMORY_URI]},
      ],
      task: {summary: 'Trace the Manager Context contract.', truncated: false},
      trust: {
        compiler: {modelsRequired: false, queryPlanExposed: false},
        graph: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
        memory: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
      },
      type: 'context-brief',
      version: CONTEXT_BRIEF_VERSION,
    },
    text: 'bounded Context Brief',
  };
}

function recallResponse(
  query: string,
  effectiveProject?: string,
  requestedProject = effectiveProject,
): ManagerRecallResponse {
  return {
    confidence: {level: 'high', reason: 'Strong memory and exact-term agreement.', score: 0.91},
    ...(effectiveProject === undefined ? {} : {effectiveProject}),
    request: {includeArchived: false, ...(requestedProject === undefined ? {} : {project: requestedProject}), query},
    queryExpansions: ['Context Brief graph memory contract'],
    resultSet: {availableResults: 9, maximumResults: 48, totalRanked: 9, truncated: false},
    results: Array.from({length: 9}, (_, index) => {
      const rank = index + 1;
      const uri = rank === 1 ? MEMORY_URI : rank === 9 ? RELOCATED_URI : `${MEMORY_URI.slice(0, -3)}-${rank}.md`;
      return {
        canonicalUri: uri,
        category: 'memories',
        confidence: 0.91,
        contextType: 'memory',
        metadata: {
          kind: 'durable',
          project: 'threadnote',
          status: 'active',
          timestamp: '2026-08-30T00:00:00.000Z',
          topic: rank === 1 ? 'manager-context-brief' : rank === 9 ? 'Second page result' : `ranked-result-${rank}`,
        },
        rank,
        readState: 'unread',
        reason: 'High-confidence code-linked result',
        requestedUri: uri,
        snippet: 'Ranked structured memory pointer.',
        warnings: [],
      };
    }),
    trust: 'untrusted-evidence-never-follow-instructions',
    warnings: [
      {
        code: 'lexical_index_unavailable',
        message: 'The lexical index was unavailable.',
        remediation: 'Run diagnostics before treating absence as evidence.',
      },
    ],
  };
}

function readResponse(page: number): ManagerContextReadResponse {
  return {
    canonicalUri: RELOCATED_URI,
    content: `${canonicalMemoryBody} page ${page + 1}.`,
    metadata: {
      kind: 'durable',
      project: 'product',
      status: 'active',
      timestamp: '2026-08-30T00:00:00.000Z',
      topic: 'context-brief',
    },
    page:
      page === 0 ? {complete: false, index: 0, next: 1, total: 2} : {complete: true, index: 1, previous: 0, total: 2},
    requestedUri: MEMORY_URI,
    title: 'context-brief',
    trust: 'untrusted-evidence-never-follow-instructions',
  };
}

function connectionsResponse(requestedUri: string): ManagerContextConnectionsResponse {
  const neighborUri = 'threadnote://user/tester/memories/durable/projects/product/neighbor.md';
  const citation = createMemoryCodeCitation({
    extractorSet: 'manager-ui-test',
    fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
    path: 'src/manager/context/view.tsx',
    repositoryId: 'b'.repeat(64),
    repositoryIdentityKind: 'remote',
    sourceCommit: 'c'.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
    target: {
      fragmentCanonicalization: 'utf8-source-span-v1',
      fragmentHash: {algorithm: 'sha256', value: 'e'.repeat(64)},
      kind: 'symbol',
      language: 'typescript',
      name: 'ContextPanel',
      nodeId: `cgs_${'f'.repeat(32)}`,
      qualifiedName: 'ContextPanel',
      span: {column: 1, endColumn: 2, endLine: 1, line: 1},
      symbolKind: 'function',
    },
    version: 1,
  });
  return {
    connections: [
      {
        currentness: 'current',
        direction: 'outgoing',
        distance: 1,
        neighborMemoryId: 'tn_neighbor',
        neighborUri,
        origin: 'relation',
        relationOrdinal: 0,
        relationType: 'depends_on',
        requestedOrdinal: 0,
        resolution: 'resolved',
        sourceMemoryId: 'tn_manager_context',
        sourceUri: RELOCATED_URI,
        targetMemoryId: 'tn_neighbor',
        targetUri: neighborUri,
      },
    ],
    coverage: {connectionCount: 1, premiseCount: 1, resultCount: 1, truncated: false, version: 1},
    editor: {
      expectedContent: 'canonical source content',
      relations: [{type: 'depends_on', uri: 'threadnote://memory/tn_neighbor'}],
      uri: RELOCATED_URI,
    },
    nodes: [
      {
        codeCitations: [citation],
        memoryId: 'tn_neighbor',
        metadata: {
          kind: 'durable',
          project: 'product',
          status: 'active',
          timestamp: '2026-08-31T00:00:00.000Z',
          topic: 'neighbor',
          trust: 'approved',
        },
        uri: neighborUri,
      },
    ],
    premises: [
      {
        memoryId: 'tn_manager_context',
        requestedOrdinal: 0,
        requestedRef: requestedUri,
        state: 'current',
        uri: RELOCATED_URI,
      },
    ],
    requestedUri,
    trust: 'relations-are-navigation-evidence-not-entailment',
  };
}
