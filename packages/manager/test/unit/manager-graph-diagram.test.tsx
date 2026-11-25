// @vitest-environment happy-dom
import type {CodeGraphDiagramResult} from '@threadnote/graph/query/diagram_contract';
import {Array as Arr} from 'effect';
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {GraphDiagramQuestion, GraphDiagramResult} from '../../src/graph/diagram_result.js';
import {renderMermaid} from '../../src/mermaid_renderer.js';
import type {GraphDiagramLoader} from '../../src/graph/model.js';

const scope = {repositoryId: 'repo', repositoryName: 'Repo', snapshotId: 'snapshot', viewKey: 'view'};
const source = 'flowchart LR\n  A --> B\n';
const diagram = {
  status: 'diagram',
  diagramType: 'flowchart',
  inferred: false,
  scope,
  source,
  freshness: 'unknown',
  limits: [],
  evidence: {nodes: [], edges: [], groups: []},
} satisfies CodeGraphDiagramResult;

let root: Root;
beforeEach(() => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  const target = document.createElement('div');
  document.body.append(target);
  root = createRoot(target);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('copies plain source, confirms success, and exposes selectable code on denial', async () => {
  const writeText = vi
    .fn<(text: string) => Promise<void>>()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('Denied'));
  vi.stubGlobal('navigator', {clipboard: {writeText}});
  await act(async () => root.render(<GraphDiagramResult result={diagram} />));
  const copy = document.querySelector<HTMLButtonElement>('button');
  expect(copy?.textContent).toBe('Copy Mermaid code');
  await act(async () => copy?.click());
  expect(writeText).toHaveBeenCalledWith(source);
  expect(document.body.textContent).toContain('Mermaid code copied.');
  await act(async () => copy?.click());
  expect(document.querySelector('[role=alert]')?.textContent).toContain('Clipboard access failed');
  expect(document.querySelector('textarea')?.value).toBe(source);
  expect(copy?.isConnected).toBe(true);
});

it('keeps source and the copy action when the renderer fails', async () => {
  vi.useFakeTimers();
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', {clipboard: {writeText}});
  await act(async () => root.render(<GraphDiagramResult result={diagram} />));
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(document.querySelector('iframe')).toBeNull();
  expect(document.body.textContent).toContain('Unable to render this diagram');
  expect(document.querySelector('pre code')?.textContent).toBe(source);
  const copy = document.querySelector('button');
  expect(copy?.textContent).toBe('Copy Mermaid code');
  await act(async () => copy?.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
  expect(document.body.textContent).toContain('Mermaid code copied.');
});

it('rejects 501 parsed architecture connections before layout', async () => {
  const architecture = Arr.join(
    [
      'architecture-beta',
      ...Arr.makeBy(502, index => `  service s${index}[Service ${index}]`),
      ...Arr.makeBy(501, index => `  s${index}:R --> L:s${index + 1}`),
    ],
    '\n',
  );
  const host = document.createElement('div');
  await expect(renderMermaid(architecture, 'mermaid-architecture', 'light', host)).rejects.toThrow(
    'Diagram has too many connections.',
  );
  expect(host.childNodes).toHaveLength(0);
});

it('shows incomplete coverage and copies all available source', async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', {clipboard: {writeText}});
  const span = {line: 13, column: 1, endLine: 13, endColumn: 8};
  const coverage = {
    completeness: 'incomplete',
    subject: {id: 'auth', label: 'Authenticate', kind: 'function', path: 'src/auth.ts', span},
    boundaries: [{kind: 'external', label: 'Session provider', path: 'src/auth.ts', span}],
    gaps: [{kind: 'interrupted', label: 'The evidence read stopped.'}],
  } as const;
  await act(async () =>
    root.render(
      <GraphDiagramResult
        result={{
          status: 'incomplete',
          diagram,
          scope,
          freshness: 'unknown',
          limits: [],
          coverage,
          message: 'The graph read could not complete.',
          nextAction: 'Retry the question.',
        }}
      />,
    ),
  );
  expect(document.body.textContent).toContain('Coverage incomplete');
  expect(document.body.textContent).toContain('Subject Authenticate');
  expect(document.body.textContent).toContain('External · Session provider');
  expect(document.body.textContent).toContain('Interrupted read');
  expect(document.body.textContent).toContain('Retry the question.');
  await act(async () => document.querySelector('button')?.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
});

it('accepts the structured alternative on an incomplete result', async () => {
  const onSuggest = vi.fn();
  const result = {
    status: 'incomplete',
    scope,
    freshness: 'unknown',
    coverage: {completeness: 'incomplete', boundaries: [], gaps: []},
    limits: [],
    message: 'Static evidence does not establish a single ordered call path.',
    nextAction: 'Choose a diagram that can show branching calls.',
    suggestedType: 'flowchart',
  } as const;
  await act(async () => root.render(<GraphDiagramResult result={result} onSuggest={onSuggest} />));
  const action = document.querySelector('button');
  expect(action?.textContent).toBe('Show Flowchart');
  await act(async () => action?.click());
  expect(onSuggest).toHaveBeenCalledExactlyOnceWith('flowchart');
});

it('discards late results after a type change and rejects a mismatched snapshot', async () => {
  const delayed = Promise.withResolvers<CodeGraphDiagramResult>();
  const load = vi
    .fn<GraphDiagramLoader>()
    .mockReturnValueOnce(delayed.promise)
    .mockResolvedValueOnce({
      ...diagram,
      scope: {...scope, snapshotId: 'stale'},
    });
  await act(async () =>
    root.render(<GraphDiagramQuestion repositoryId="repo" viewId="view" snapshotId="snapshot" load={load} />),
  );
  const input = document.querySelector('input')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'Show the call path');
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  const form = document.querySelector('form')!;
  await act(async () => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  const select = document.querySelector('select')!;
  await act(async () => {
    select.value = 'sequence';
    select.dispatchEvent(new Event('change', {bubbles: true}));
    delayed.resolve(diagram);
  });
  expect(load.mock.calls[0]?.[4].aborted).toBe(true);
  expect(document.querySelector('.graph-diagram-result')).toBeNull();
  await act(async () => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(document.querySelector('[role=alert]')?.textContent).toContain('different graph view or snapshot');
});

it('runs the chosen source location in the same view, snapshot, and diagram type', async () => {
  const retryQuery = 'Show the sequence diagram for cgs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const load = vi
    .fn<GraphDiagramLoader>()
    .mockResolvedValueOnce({
      scope,
      status: 'clarification',
      freshness: 'current',
      limits: [],
      message: 'Which source location is the subject of this diagram?',
      candidates: [
        {
          id: 'route',
          label: 'Load',
          path: 'src/route.ts',
          kind: 'function',
          span: {line: 7, column: 1, endLine: 7, endColumn: 10},
          retryQuery,
        },
      ],
    })
    .mockResolvedValueOnce({...diagram, diagramType: 'sequence', source: 'sequenceDiagram\n  A->>B: load'});
  await act(async () =>
    root.render(<GraphDiagramQuestion repositoryId="repo" viewId="view" snapshotId="snapshot" load={load} />),
  );
  const input = document.querySelector('input')!;
  const select = document.querySelector('select')!;
  const form = document.querySelector('form')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'How does Load work?');
    input.dispatchEvent(new Event('input', {bubbles: true}));
    select.value = 'sequence';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  });
  await act(async () => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  const action = document.querySelector<HTMLButtonElement>('.graph-diagram-result button');
  expect(action?.textContent).toBe('Use Load · src/route.ts:7');
  await act(async () => action?.click());
  expect(load).toHaveBeenNthCalledWith(2, 'view', 'snapshot', retryQuery, 'sequence', expect.any(AbortSignal));
  expect(input.value).toBe(retryQuery);
  expect(document.querySelector('.graph-diagram-result h3')?.textContent).toBe('Sequence diagram');
});
