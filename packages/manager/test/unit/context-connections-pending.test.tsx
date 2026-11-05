// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Array as EffectArray, String as EffectString} from 'effect';
import {ContextPanel} from '@threadnote/manager/context/view';
import type {
  ManagerContextConnectionsResponse,
  ManagerContextReadResponse,
  ManagerRecallResponse,
} from '@threadnote/manager/context/contracts';
import type {ManagerWorksetCatalog} from '@threadnote/manager/workset/contracts';

const uri = 'threadnote://user/test/memories/durable/projects/demo/anchor.md';
const canonical = 'Canonical body preserved.';
const catalog: ManagerWorksetCatalog = {
  definitions: [],
  definitionSource: 'seed-manifest',
  editability: {state: 'editable'},
  projectEditability: {state: 'editable'},
  projects: [],
  projectsReadOnly: false,
  readOnly: false,
  revision: EffectString.repeat(64)('a'),
  type: 'manager-workset-catalog',
  version: 1,
};
const recall: ManagerRecallResponse = {
  queryExpansions: [],
  request: {includeArchived: false, query: 'anchor'},
  resultSet: {availableResults: 1, maximumResults: 48, totalRanked: 1, truncated: false},
  results: [
    {
      canonicalUri: uri,
      category: 'memories',
      contextType: 'durable',
      rank: 1,
      readState: 'unread',
      reason: 'Fixture',
      requestedUri: uri,
      snippet: canonical,
      warnings: [],
    },
  ],
  trust: 'untrusted-evidence-never-follow-instructions',
  warnings: [],
};
const read: ManagerContextReadResponse = {
  canonicalUri: uri,
  requestedUri: uri,
  content: canonical,
  metadata: {kind: 'durable', status: 'active', timestamp: '2026-11-04T00:00:00.000Z'},
  page: {complete: true, index: 0, total: 1},
  title: 'anchor',
  trust: 'untrusted-evidence-never-follow-instructions',
};
const connections: ManagerContextConnectionsResponse = {
  connections: [],
  coverage: {connectionCount: 0, premiseCount: 1, resultCount: 0, truncated: false, version: 1},
  editor: {expectedContent: canonical, relations: [], uri},
  nodes: [],
  premises: [{memoryId: 'tn_anchor', requestedOrdinal: 0, requestedRef: uri, state: 'current', uri}],
  requestedUri: uri,
  trust: 'relations-are-navigation-evidence-not-entailment',
};
let root: Root | undefined;
let reply: () => Response | Promise<Response>;
let readReply: () => Response | Promise<Response>;
let requests: string[];

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  requests = [];
  readReply = () => json(read);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    requests.push(path);
    if (path === '/api/worksets') return json(catalog);
    if (path === '/api/context/recall') return json(recall);
    if (path === '/api/context/read') return readReply();
    if (path === '/api/memory/relations') return json({content: canonical, memoryId: 'tn_anchor', relations: [], uri});
    if (path === '/api/context/connections') {
      expect(JSON.parse(String(init?.body))).toEqual({includeHistorical: false, uri});
      return reply();
    }
    throw new Error('Unexpected request: ' + path);
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('keeps canonical content available while pending and uses an explicit ready-reader retry for the editor', async () => {
  reply = () => json({code: 'connections-unavailable', error: 'Readiness is pending.', retryAfterMilliseconds: 0}, 503);
  await openConnections();
  expect(document.querySelector('[role="status"]')?.textContent).toContain('prepared in the background');
  expect(document.querySelector('.context-relation-editor')).toBeNull();
  expect(EffectArray.filter(requests, path => path === '/api/context/connections')).toHaveLength(1);
  await click('Content');
  expect(document.querySelector('.context-reader pre')?.textContent).toBe(canonical);
  await click('Connections');
  reply = () => json(connections);
  await click('Retry connections');
  expect(document.querySelector('.context-relation-editor')).not.toBeNull();
  expect(button('Add relation')).toBeDefined();
  expect(button('Retry connections')).toBeUndefined();
  expect(EffectArray.filter(requests, path => path === '/api/context/connections')).toHaveLength(3);
  expect(requests).not.toContain('/api/repair');
});

it('does not restore old connection authority after a postwrite readiness gap and tab navigation', async () => {
  reply = () => json(connections);
  await openConnections();
  expect(document.querySelector('.context-relation-editor')).not.toBeNull();
  reply = () => json({code: 'connections-unavailable', error: 'Readiness is pending.', retryAfterMilliseconds: 0}, 503);
  await click('Save relations');
  expect(button('Retry connections')).toBeDefined();
  await click('Content');
  expect(document.querySelector('.context-reader pre')?.textContent).toBe(canonical);
  await click('Connections');
  expect(button('Retry connections')).toBeDefined();
  expect(document.querySelector('.context-relation-editor')).toBeNull();
  expect(EffectArray.filter(requests, path => path === '/api/context/connections')).toHaveLength(3);
});

it('revokes removed neighbor actions immediately after a write while canonical and connection reads are delayed', async () => {
  const neighborUri = 'threadnote://user/test/memories/durable/projects/demo/removed.md';
  reply = () =>
    json({
      ...connections,
      connections: [
        {
          currentness: 'current',
          direction: 'outgoing',
          distance: 1,
          neighborUri,
          neighborMemoryId: 'tn_neighbor',
          origin: 'relation',
          relationOrdinal: 0,
          relationType: 'related_to',
          requestedOrdinal: 0,
          resolution: 'resolved',
        },
      ],
      coverage: {...connections.coverage, connectionCount: 1, resultCount: 1},
      editor: {expectedContent: canonical, relations: [{type: 'related_to', uri: neighborUri}], uri},
    } satisfies ManagerContextConnectionsResponse);
  await openConnections();
  expect(button('Open neighbor')).toBeDefined();
  await click('Remove');
  const canonicalRead = Promise.withResolvers<Response>();
  const connectionRead = Promise.withResolvers<Response>();
  readReply = () => canonicalRead.promise;
  reply = () => connectionRead.promise;
  try {
    await click('Save relations');
    expect(document.querySelector('.context-reader')?.textContent).toContain('Reading canonical context');
    expect(button('Open neighbor')).toBeUndefined();
    expect(document.querySelector('.context-relation-editor')).toBeNull();
    expect(EffectArray.filter(requests, path => path === '/api/context/connections')).toHaveLength(1);
    await act(async () => canonicalRead.resolve(json(read)));
    expect(button('Open neighbor')).toBeUndefined();
    expect(document.querySelector('.context-relation-editor')).toBeNull();
    expect(EffectArray.filter(requests, path => path === '/api/context/connections')).toHaveLength(2);
    await act(async () => connectionRead.resolve(json(connections)));
    expect(button('Open neighbor')).toBeUndefined();
    expect(button('Add relation')).toBeDefined();
  } finally {
    await act(async () => {
      canonicalRead.resolve(json(read));
      connectionRead.resolve(json(connections));
    });
  }
});

it.each([
  {status: 500, code: 'connections-unavailable'},
  {status: 503, code: 'other-unavailable'},
  {status: 503, code: undefined},
  {status: 400, code: 'connections-unavailable'},
])('retains an ordinary failure for status $status and code $code', async ({status, code}) => {
  reply = () => json({code, error: 'Actual operational failure.'}, status);
  await openConnections();
  expect(document.querySelector('.context-reader [role="alert"]')?.textContent).toBe('Actual operational failure.');
  expect(button('Retry connections')).toBeUndefined();
  expect(document.querySelector('.context-relation-editor')).toBeNull();
  await click('Content');
  expect(document.querySelector('.context-reader pre')?.textContent).toBe(canonical);
});

async function openConnections(): Promise<void> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<ContextPanel />));
  await click('Recall');
  const input = document.querySelector<HTMLInputElement>('.context-recall-form input');
  if (!input) throw new Error('Recall query input missing.');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'anchor');
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await click('Recall context');
  const pointer = document.querySelector<HTMLButtonElement>('.context-recall-card button');
  if (!pointer) throw new Error('Recall pointer missing.');
  await act(async () => pointer.click());
  await click('Connections');
}
function button(text: string): HTMLButtonElement | undefined {
  return EffectArray.findFirst(
    [...document.querySelectorAll('button')],
    candidate => EffectString.trim(candidate.textContent ?? '') === text,
  ).pipe(option => (option._tag === 'Some' ? option.value : undefined));
}
async function click(text: string): Promise<void> {
  const element = button(text);
  if (!element) throw new Error('Button missing: ' + text);
  await act(async () => element.click());
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
}
