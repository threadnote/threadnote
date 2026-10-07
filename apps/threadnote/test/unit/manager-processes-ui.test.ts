// @vitest-environment happy-dom

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import FC from 'fast-check';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ManagerDialogProvider} from '@threadnote/manager/dialog';
import {orderManagerProcessesForPresentation, ProcessesPanel} from '@threadnote/manager/processes_view';
import type {ManageableThreadnoteProcessDiagnostic} from '@threadnote/threadnote/process/diagnostics';
import {readFile} from '@threadnote/testing/node-fs-promises';
import {join} from '@threadnote/testing/node-path';

let reactRoot: Root | undefined;
let fetchOriginal: typeof fetch;
let requests: Array<{readonly body?: Record<string, unknown>; readonly path: string}>;

beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  fetchOriginal = globalThis.fetch;
  requests = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    requests.push({body, path});
    if (path === '/api/processes/terminate') {
      return Promise.resolve(jsonResponse({processId: 80297, state: 'terminated'}));
    }
    return Promise.resolve(
      jsonResponse({
        processes: [
          {
            ageMilliseconds: 86_400_000,
            parentProcessId: 1,
            processId: 80100,
            releaseVersion: '4.3.8',
            role: 'legacy',
            startedAt: '2026-08-11T00:00:00.000Z',
            terminable: false,
            terminationBlockedReason: 'legacy-process',
          },
          {
            ageMilliseconds: 540_000,
            currentOperation: 'compact-graph-storage',
            parentProcessId: 80276,
            parentRole: 'manager',
            processId: 80297,
            processRef: `tnp_${'a'.repeat(64)}`,
            role: 'graph-compaction-worker',
            rssBytes: 100 * 1_024 * 1_024,
            startedAt: '2026-08-12T00:00:00.000Z',
            terminable: true,
          },
          {
            activityRole: 'graph-builder',
            ageMilliseconds: 10_000,
            currentOperation: 'index-repository',
            parentProcessId: 1,
            processId: 80300,
            processRef: `tnp_${'b'.repeat(64)}`,
            role: 'mcp',
            startedAt: '2026-08-12T00:00:00.000Z',
            terminable: true,
          },
          {
            ageMilliseconds: 1_000,
            currentOperation: 'impact-query',
            parentProcessId: 80_300,
            parentRole: 'mcp',
            processId: 80_301,
            processRef: `tnp_${'c'.repeat(64)}`,
            role: 'graph-query-worker',
            startedAt: '2026-08-12T00:00:00.000Z',
            terminable: true,
          },
          {
            ageMilliseconds: 5_000,
            currentOperation: 'manager-ui',
            parentProcessId: 1,
            processId: 80276,
            role: 'manager',
            startedAt: '2026-08-12T00:00:00.000Z',
            terminable: false,
            terminationBlockedReason: 'current-manager',
          },
        ],
        schemaVersion: 1,
        truncated: false,
      }),
    );
  }) as typeof fetch;
});

afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot?.unmount());
  document.body.replaceChildren();
  globalThis.fetch = fetchOriginal;
  reactRoot = undefined;
});

describe('Manager Processes panel', () => {
  it('shows compaction and activity roles without exposing opaque control data as text', async () => {
    await renderProcesses();
    const processList = document.querySelector('[aria-label="Threadnote process inventory"]');
    expect(processList?.getAttribute('role')).toBe('list');
    expect(processList?.querySelectorAll('[role="listitem"]')).toHaveLength(5);
    expect(document.body.textContent).toContain('Graph compaction worker');
    expect(document.body.textContent).toContain('Compact graph storage');
    expect(document.body.textContent).toContain('This session · Verified runtime');
    expect(document.body.textContent).toContain('MCP server');
    expect(document.body.textContent).toContain('Graph builder activity');
    expect(document.body.textContent).toContain('Graph query worker');
    expect(document.body.textContent).toContain('Impact query');
    expect(document.body.textContent).not.toContain(`tnp_${'a'.repeat(64)}`);

    const stop = document.querySelector<HTMLButtonElement>(
      '[aria-label="Terminate Graph compaction worker process 80297"]',
    );
    const managerStop = document.querySelector<HTMLButtonElement>('[aria-label="Terminate Manager process 80276"]');
    expect(stop?.title).toBe('Terminate Graph compaction worker');
    expect(stop?.disabled).toBe(false);
    expect(managerStop).toBeNull();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Inspect Manager process 80276"]')?.click(),
    );
    expect(document.querySelector('dialog')?.textContent).toContain('80276');
  });

  it('puts active work ahead of idle registered and legacy runtimes', async () => {
    await renderProcesses();
    const titles = [...document.querySelectorAll('.process-row .row-copy strong')].map(element => element.textContent);
    expect(titles).toEqual(['Compact graph storage', 'Index repository', 'Impact query', 'Manager', 'Legacy runtime']);
    expect(document.body.textContent).toContain('Active operations');
    expect(document.body.textContent).toContain('Other runtimes');
  });

  it('orders every process by attention rank without mutating the API response', () => {
    FC.assert(
      FC.property(
        FC.uniqueArray(processDiagnosticArbitrary, {
          maxLength: 140,
          minLength: 101,
          selector: process => process.processId,
        }),
        processes => {
          const before = [...processes];
          const ordered = orderManagerProcessesForPresentation(processes);
          expect(processes).toEqual(before);
          expect(ordered).toHaveLength(processes.length);
          expect(new Set(ordered.map(process => process.processId))).toEqual(
            new Set(processes.map(process => process.processId)),
          );
          expect(orderManagerProcessesForPresentation(processes)).toEqual(ordered);
          for (let index = 1; index < ordered.length; index += 1) {
            expect(presentationRank(ordered[index - 1])).toBeLessThanOrEqual(presentationRank(ordered[index]));
          }
          expect(presentationRank(ordered[99])).toBeLessThanOrEqual(presentationRank(ordered[100]));
        },
      ),
      {numRuns: 100},
    );
  });

  it('keeps idle service baselines behind active work even when the services are older', () => {
    const process = (
      processId: number,
      role: ManageableThreadnoteProcessDiagnostic['role'],
      currentOperation: string,
    ): ManageableThreadnoteProcessDiagnostic => ({
      ageMilliseconds: 1,
      currentOperation,
      parentProcessId: 1,
      processId,
      role,
      startedAt: `2026-08-0${processId}T00:00:00.000Z`,
      terminable: true,
    });
    const ordered = orderManagerProcessesForPresentation([
      process(1, 'mcp', 'mcp-server'),
      process(2, 'mcp-broker', 'mcp-broker'),
      process(3, 'local-model-worker', 'model-stdio'),
      process(4, 'graph-parser-worker', 'parser-stdio'),
      process(5, 'cli', 'index-repository'),
    ]);
    expect(ordered.map(value => value.processId)).toEqual([5, 1, 2, 3, 4]);
  });

  it('confirms termination and posts the exact opaque process reference with the PID', async () => {
    await renderProcesses();
    const stop = document.querySelector<HTMLButtonElement>(
      '[aria-label="Terminate Graph compaction worker process 80297"]',
    )!;
    await act(async () => stop.click());
    const confirm = await waitForElement<HTMLButtonElement>('dialog.manager-dialog button.danger');
    expect(document.querySelector('dialog.manager-dialog')?.textContent).toContain('PID 80297');
    await act(async () => confirm.click());
    await flush();
    expect(requests.find(request => request.path === '/api/processes/terminate')?.body).toEqual({
      confirm: true,
      processId: 80297,
      processRef: `tnp_${'a'.repeat(64)}`,
    });
  });

  it('keeps process rows content-sized and lets metadata wrap responsively', async () => {
    const css = await readFile(join(process.cwd(), 'packages', 'manager', 'static', 'app.css'), 'utf8');
    expect(css).toMatch(
      /\.process-workspace\s*\{[\s\S]*?align-content: start;[\s\S]*?grid-auto-rows: max-content;[\s\S]*?min-height: 0;/u,
    );
    expect(css).toMatch(
      /\.process-list\s*\{[\s\S]*?align-content: start;[\s\S]*?grid-auto-rows: max-content;[\s\S]*?min-height: 0;/u,
    );
    expect(css).toMatch(/\.process-card dl\s*\{[\s\S]*?repeat\(auto-fit, minmax\(min\(140px, 100%\), 1fr\)\)/u);
    expect(css).toMatch(/\.process-card dd\s*\{[\s\S]*?overflow-wrap: anywhere;/u);
  });
});

async function renderProcesses(): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  reactRoot = createRoot(container);
  await act(async () => {
    reactRoot?.render(React.createElement(ManagerDialogProvider, undefined, React.createElement(ProcessesPanel)));
  });
  await waitForElement('[aria-label="Terminate Graph compaction worker process 80297"]');
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise(resolve => window.setTimeout(resolve, 0));
  });
}

async function waitForElement<T extends Element>(selector: string): Promise<T> {
  for (let index = 0; index < 20; index += 1) {
    const element = document.querySelector<T>(selector);
    if (element) return element;
    await flush();
  }
  throw new Error(`Element did not render: ${selector}`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}, status});
}

const processDiagnosticArbitrary: FC.Arbitrary<ManageableThreadnoteProcessDiagnostic> = FC.record({
  activityRole: FC.option(FC.constant('graph-builder' as const), {nil: undefined}),
  ageMilliseconds: FC.nat(),
  currentOperation: FC.option(
    FC.constantFrom(
      'index-repository',
      'manager-ui',
      'mcp-server',
      'mcp-broker',
      'model-stdio',
      'parser-stdio',
      'embed-many',
    ),
    {nil: undefined},
  ),
  parentProcessId: FC.nat(),
  processId: FC.integer({min: 1, max: 1_000_000}),
  role: FC.constantFrom(
    'cli' as const,
    'manager' as const,
    'mcp' as const,
    'mcp-broker' as const,
    'local-model-worker' as const,
    'graph-parser-worker' as const,
    'legacy' as const,
  ),
  startedAt: FC.date({
    max: new Date('2030-01-01T00:00:00.000Z'),
    min: new Date('2020-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  }).map(value => value.toISOString()),
  terminable: FC.boolean(),
});

function presentationRank(process: ManageableThreadnoteProcessDiagnostic): number {
  if (process.role === 'legacy') return 2;
  return process.activityRole !== undefined ||
    (process.currentOperation !== undefined && !isBaselineOperationForRole(process.role, process.currentOperation))
    ? 0
    : 1;
}

function isBaselineOperationForRole(role: ManageableThreadnoteProcessDiagnostic['role'], operation: string): boolean {
  return (
    (role === 'manager' && operation === 'manager-ui') ||
    (role === 'mcp' && operation === 'mcp-server') ||
    (role === 'mcp-broker' && operation === 'mcp-broker') ||
    (role === 'local-model-worker' && operation === 'model-stdio') ||
    (role === 'graph-parser-worker' && operation === 'parser-stdio')
  );
}
