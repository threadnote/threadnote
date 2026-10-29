import {Array as EffectArray} from 'effect';
// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Predicate, Schema} from 'effect';
import {LibraryArticle} from '../../src/library_article.js';
import type {MemoryMetadata, TreeNode} from '../../src/ui/contracts.js';
import {TopicExpansionPanel} from '../../src/attention/topic_expansion.js';
import type {
  ManagerTopicExpansionInspection,
  ManagerTopicExpansionPreview,
} from '../../src/attention/topic_expansion_contracts.js';
import {TOPIC_EXPANSION_KINDS, TOPIC_EXPANSION_PROVENANCES} from '@threadnote/memory/topic-maintenance-expansion';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

const hash = Effect.pipe('a', EffectString.repeat(64));
const uri = 'threadnote://user/tester/memories/durable/projects/fixture/topic.md';
const nextUri = Effect.pipe(uri, EffectString.replace('topic.md', 'next.md'));
const initial = (targetUri = uri, project = 'fixture'): ManagerTopicExpansionInspection => ({
  status: 'ready',
  sourceKind: 'code',
  targetUri,
  project,
  configDigest: hash,
  body: 'Accepted topic.\n\nKeep policy.',
  warning: 'Only the requested scope is evaluated.',
  currentScope: [],
  seeds: [{id: 'seed-main', label: 'Main source', path: 'src/main.ts', kind: 'file', citationId: 'tnc_main'}],
});
const discovery = (targetUri = uri, project = 'fixture'): ManagerTopicExpansionInspection => ({
  ...initial(targetUri, project),
  choices: {eligible: [{id: 'neighbor', path: 'src/dependency.ts', contentHash: hash}], omissions: []},
  coverage: [{seedId: 'seed-main', status: 'exhaustive', visitedNodes: 2, inspectedEdges: 1}],
});
let root: Root;
let gate: Promise<void> | undefined;
let discoveryError: boolean;
let applyError: boolean;
let expiredApply: boolean;
let restartError: boolean;
let wrongRecovery: boolean;
let readGate: Promise<void> | undefined;
const posted: Record<string, unknown>[] = [];
const prepared = vi.fn();
const changed = vi.fn();
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});

const selectionSchema = Schema.Struct({
  configDigest: Schema.String,
  configurationPaths: Schema.Array(Schema.String),
  depth: Schema.Literal(1),
  direction: Schema.optionalKey(Schema.Literals(['both', 'incoming', 'outgoing'])),
  edgeLimit: Schema.Int,
  kinds: Schema.Array(Schema.Literals(TOPIC_EXPANSION_KINDS)),
  minConfidence: Schema.Finite,
  nodeLimit: Schema.Int,
  provenances: Schema.Array(Schema.Literals(TOPIC_EXPANSION_PROVENANCES)),
  seeds: Schema.Array(Schema.String),
  selectedNodeIds: Schema.Array(Schema.String),
  version: Schema.Literal(1),
});
function selectionFrom(value: unknown): ManagerTopicExpansionPreview['selection'] {
  if (!Schema.is(selectionSchema)(value)) throw new Error('Expected an expansion selection');
  return value;
}
const button = (text: string) =>
  EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll<HTMLButtonElement>('button')],
      __effectArrayValue =>
        !!(item =>
          Effect.pipe(item.textContent, effectOptionalString =>
            effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.includes(text)),
          ))(__effectArrayValue),
    ),
  )!;
const checkbox = (text: string) =>
  EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll<HTMLLabelElement>('label')],
      __effectArrayValue =>
        !!(item =>
          Effect.pipe(item.textContent, effectOptionalString =>
            effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.includes(text)),
          ))(__effectArrayValue),
    ),
  )!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const input = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const click = (element: HTMLElement) => act(async () => element.click());
const changeInput = (element: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', {bubbles: true}));
    element.dispatchEvent(new Event('change', {bubbles: true}));
  });
const render = (targetUri = uri, project = 'fixture') =>
  act(async () =>
    root.render(
      <TopicExpansionPanel uri={targetUri} project={project} onChanged={changed} onPrepareGraph={prepared} />,
    ),
  );
async function inspect() {
  await render();
  await act(async () => {
    const details = document.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
}
async function selectNeighbor() {
  await inspect();
  await click(checkbox('Main source'));
  await click(button('Find one-hop sources'));
  await click(checkbox('src/dependency.ts'));
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  gate = undefined;
  readGate = undefined;
  discoveryError = false;
  applyError = false;
  expiredApply = false;
  restartError = false;
  wrongRecovery = false;
  posted.length = 0;
  prepared.mockClear();
  changed.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request), 'http://manager.test');
      if (!init?.method || init.method === 'GET') {
        if (url.pathname === '/api/attention/automatic-memory')
          return response({version: 1, project: url.searchParams.get('project'), items: [], omitted: 0});
        await readGate;
        return response(initial(url.searchParams.get('uri')!, url.searchParams.get('project')!));
      }
      const parsedBody: unknown = JSON.parse(String(init.body));
      if (!Predicate.isObject(parsedBody)) throw new Error('Unexpected expansion request body');
      const body = parsedBody;
      posted.push(body);
      if (body.action === 'discover') {
        await gate;
        return discoveryError
          ? response({error: 'This requested graph scope is incomplete. Prepare the project manually.'}, 409)
          : response(discovery(String(body.uri), String(body.project)));
      }
      if (body.action === 'preview' || body.action === 'restart') {
        await gate;
        if (body.action === 'restart' && restartError)
          return response({error: 'The source changed. Inspect again.'}, 409);
        const preview: ManagerTopicExpansionPreview = {
          status: 'preview',
          targetUri: String(body.uri),
          project: String(body.project),
          selection: selectionFrom(body.selection),
          revision: body.action === 'restart' ? Effect.pipe('c', EffectString.repeat(64)) : hash,
          approvalDigest:
            body.action === 'restart'
              ? Effect.pipe('d', EffectString.repeat(64))
              : Effect.pipe('b', EffectString.repeat(64)),
          ...(body.action === 'restart'
            ? {
                operation: {
                  id: '11111111-1111-4111-8111-111111111111',
                  generation: 1,
                  predecessorRevision: hash,
                  predecessorApprovalDigest: Effect.pipe('b', EffectString.repeat(64)),
                },
              }
            : {}),
          content: '---\ntopic_maintenance: reviewed\n---\nAccepted topic.\n\nKeep policy.',
          body: 'Accepted topic.\n\nKeep policy.',
          additions: [{kind: 'dependency', ref: 'neighbor', path: 'src/dependency.ts', citationId: 'tnc_neighbor'}],
          omissions: [],
          metadataDiff: [
            {field: 'topic_maintenance', beforeHash: hash, afterHash: Effect.pipe('b', EffectString.repeat(64))},
          ],
          coverage: [{seedId: 'seed-main', status: 'exhaustive', visitedNodes: 2, inspectedEdges: 1}],
        };
        return response(preview);
      }
      if (body.action === 'apply') {
        await gate;
        if (expiredApply)
          return response(
            {
              error: 'The previous dependency approval expired. Review a fresh preview before applying.',
              recovery: {
                action: 'restart',
                targetUri: body.uri,
                project: body.project,
                revision: wrongRecovery ? Effect.pipe('0', EffectString.repeat(64)) : body.revision,
                approvalDigest: body.approvalDigest,
              },
            },
            409,
          );
        return applyError
          ? response({error: 'The source, project or topic changed. Preview again.'}, 409)
          : response({status: 'expanded', targetUri: body.uri, reviewId: 'review-expansion', revision: hash});
      }
      throw new Error('Unexpected expansion request');
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('requires explicit seeds, exact source selections, full preview and separate exact approval', async () => {
  await inspect();
  expect(button('Find one-hop sources').disabled).toBe(true);
  expect(button('Preview selected additions').disabled).toBe(true);
  await click(checkbox('Main source'));
  await click(button('Find one-hop sources'));
  expect(checkbox('src/dependency.ts').checked).toBe(false);
  expect(button('Preview selected additions').disabled).toBe(true);
  await click(checkbox('src/dependency.ts'));
  await changeInput(input('Configuration file path'), 'config/app.json');
  await click(button('Add file choice'));
  expect(checkbox('config/app.json').checked).toBe(false);
  await click(checkbox('config/app.json'));
  await click(button('Preview selected additions'));
  expect(posted.at(-1)).toEqual(
    expect.objectContaining({
      action: 'preview',
      uri,
      project: 'fixture',
      selection: expect.objectContaining({
        seeds: ['seed-main'],
        selectedNodeIds: ['neighbor'],
        configurationPaths: ['config/app.json'],
        depth: 1,
      }),
    }),
  );
  expect(JSON.stringify(posted)).not.toMatch(/callerCwd|"root"/u);
  expect(document.body.textContent).toContain('Full proposed memory and metadata');
  expect(document.body.textContent).toContain('Keep policy.');
  expect(button('Approve dependency scope').disabled).toBe(true);
  expect(EffectArray.some(posted, item => item.action === 'apply')).toBe(false);
  await click(checkbox('I reviewed these exact additions'));
  await click(button('Approve dependency scope'));
  expect(posted.at(-1)).toEqual(
    expect.objectContaining({
      action: 'apply',
      revision: hash,
      approvalDigest: Effect.pipe('b', EffectString.repeat(64)),
      approved: true,
    }),
  );
  expect(changed).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('Dependency scope saved');
});

it('invalidates previews and approval for selection, configuration and filter edits', async () => {
  await selectNeighbor();
  await click(button('Preview selected additions'));
  await click(checkbox('I reviewed these exact additions'));
  await changeInput(input('Configuration file path'), 'settings.json');
  expect(document.querySelector('[aria-label="Exact dependency expansion preview"]')).toBeNull();
  expect(EffectArray.some(posted, item => item.action === 'apply')).toBe(false);
  await click(button('Preview selected additions'));
  expect(button('Approve dependency scope').disabled).toBe(true);
  await click(checkbox('src/dependency.ts'));
  expect(document.querySelector('[aria-label="Exact dependency expansion preview"]')).toBeNull();
  expect(button('Preview selected additions').disabled).toBe(true);
  await click(checkbox('src/dependency.ts'));
  await click(button('Preview selected additions'));
  await changeInput(input('Dependency source limit'), '8');
  expect(document.querySelector('[aria-label="Exact dependency expansion preview"]')).toBeNull();
  expect(document.querySelector('[aria-label="Dependency choices"]')).toBeNull();
  expect(button('Preview selected additions').disabled).toBe(true);
});

it('keeps incomplete requested bounds and offers explicit manual preparation without widening', async () => {
  await inspect();
  await click(checkbox('Main source'));
  await changeInput(input('Dependency source limit'), '1');
  await changeInput(input('Dependency relationship limit'), '1');
  discoveryError = true;
  await click(button('Find one-hop sources'));
  expect(document.body.textContent).toContain('requested graph scope is incomplete');
  expect(input('Dependency source limit').value).toBe('1');
  expect(input('Dependency relationship limit').value).toBe('1');
  expect(button('Preview selected additions').disabled).toBe(true);
  await click(button('Open project graph controls'));
  expect(prepared).toHaveBeenCalledTimes(1);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toEqual(
    expect.objectContaining({
      action: 'discover',
      selection: expect.objectContaining({nodeLimit: 1, edgeLimit: 1, selectedNodeIds: []}),
    }),
  );
});

it('fences double clicks, busy edits and stale source/project responses', async () => {
  await selectNeighbor();
  const pending = Promise.withResolvers<void>();
  gate = pending.promise;
  await act(async () => {
    button('Preview selected additions').click();
    button('Preview selected additions').click();
  });
  expect(EffectArray.filter(posted, item => item.action === 'preview')).toHaveLength(1);
  expect(checkbox('src/dependency.ts').disabled).toBe(true);
  expect(input('Dependency source limit').disabled).toBe(true);
  await render(nextUri, 'other');
  expect(document.body.textContent).not.toContain('src/dependency.ts');
  gate = undefined;
  await click(button('Inspect prepared project scope'));
  await click(checkbox('Main source'));
  await click(button('Find one-hop sources'));
  await click(checkbox('src/dependency.ts'));
  await act(async () => pending.resolve());
  expect(document.querySelector('[aria-label="Exact dependency expansion preview"]')).toBeNull();
  expect(checkbox('src/dependency.ts').checked).toBe(true);
  await click(button('Preview selected additions'));
  expect(posted.at(-1)).toEqual(
    expect.objectContaining({
      uri: nextUri,
      project: 'other',
      selection: expect.objectContaining({selectedNodeIds: ['neighbor']}),
    }),
  );
});

it('clears approval after a failed apply and requires a fresh preview', async () => {
  await selectNeighbor();
  await click(button('Preview selected additions'));
  await click(checkbox('I reviewed these exact additions'));
  applyError = true;
  await click(button('Approve dependency scope'));
  expect(document.body.textContent).toContain('source, project or topic changed');
  expect(document.querySelector('[aria-label="Exact dependency expansion preview"]')).toBeNull();
  expect(EffectArray.filter(posted, item => item.action === 'apply')).toHaveLength(1);
  expect(changed).not.toHaveBeenCalled();
});

const metadata: MemoryMetadata = {
  kind: 'durable',
  status: 'active',
  project: 'fixture',
  sourceAgentClient: 'test',
  timestamp: '2026-10-18T00:00:00.000Z',
};
const node: TreeNode = {
  isDir: false,
  isShared: false,
  isSystem: false,
  name: 'topic.md',
  relativePath: 'projects/fixture/topic.md',
  uri,
};
function expectOnlyAutomaticStatusRead() {
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    `/api/attention/automatic-memory?project=fixture&uri=${encodeURIComponent(uri)}`,
    expect.objectContaining({method: 'GET', body: undefined}),
  );
  expect(posted).toEqual([]);
}
it.each([
  {name: 'legacy code', topicMaintenance: {version: 1}, visible: true},
  {name: 'retained code', topicMaintenance: {version: 2}, visible: true},
  {name: 'expanded code', topicMaintenance: {version: 3, sourceKind: 'code'}, visible: true},
  {name: 'imported note', topicMaintenance: {version: 3, sourceKind: 'obsidian'}, visible: false},
  {name: 'unenrolled', visible: false},
] as const)('mounts dependency expansion only for eligible $name library topics', async item => {
  await act(async () =>
    root.render(
      <LibraryArticle
        node={node}
        metadata={{...metadata, ...('topicMaintenance' in item ? {topicMaintenance: item.topicMaintenance} : {})}}
        markdown="Accepted body."
        resource={false}
      />,
    ),
  );
  expect(
    Effect.pipe(document.body.textContent, effectOptionalString =>
      effectOptionalString == null
        ? undefined
        : Effect.pipe(effectOptionalString, EffectString.includes('Review code dependency scope')),
    ),
  ).toBe(item.visible);
  expect(document.body.textContent).toContain('Automatic memory care');
  expect(document.body.textContent).not.toContain('Topic updates from an Obsidian note');
  expectOnlyAutomaticStatusRead();
});
it.each([{isShared: true}, {isSystem: true}, {resource: true}, {archived: true}])(
  'withholds the expansion entrypoint for ineligible library state %j',
  async state => {
    await act(async () =>
      root.render(
        <LibraryArticle
          node={{...node, ...state}}
          metadata={{
            ...metadata,
            status: state.archived ? 'archived' : 'active',
            topicMaintenance: {version: 3, sourceKind: 'code'},
          }}
          markdown="Accepted body."
          resource={state.resource === true}
        />,
      ),
    );
    expect(document.body.textContent).not.toContain('Review code dependency scope');
    if (state.isShared) expectOnlyAutomaticStatusRead();
    else expect(fetch).not.toHaveBeenCalled();
  },
);

async function expireApprovedPreview() {
  await selectNeighbor();
  await click(button('Preview selected additions'));
  await click(checkbox('I reviewed these exact additions'));
  expiredApply = true;
  await click(button('Approve dependency scope'));
}
it('recovers an expired approval only through explicit restart then separate approval of the fresh full preview', async () => {
  await expireApprovedPreview();
  expect(document.querySelector('[aria-label="Exact dependency expansion preview"]')).toBeNull();
  expect(button('Start fresh dependency review').disabled).toBe(true);
  expect(EffectArray.filter(posted, item => item.action === 'restart')).toHaveLength(0);
  await click(checkbox('Replace the expired approval'));
  await click(button('Start fresh dependency review'));
  expect(posted.at(-1)).toEqual(
    expect.objectContaining({
      action: 'restart',
      revision: hash,
      approvalDigest: Effect.pipe('b', EffectString.repeat(64)),
      approved: true,
      selection: expect.objectContaining({selectedNodeIds: ['neighbor']}),
    }),
  );
  expect(document.body.textContent).toContain('Fresh dependency review');
  expect(button('Approve dependency scope').disabled).toBe(true);
  expect(EffectArray.filter(posted, item => item.action === 'apply')).toHaveLength(1);
  expiredApply = false;
  await click(checkbox('I reviewed these exact additions'));
  await click(button('Approve dependency scope'));
  expect(posted.at(-1)).toEqual(
    expect.objectContaining({
      action: 'apply',
      revision: Effect.pipe('c', EffectString.repeat(64)),
      approvalDigest: Effect.pipe('d', EffectString.repeat(64)),
      approved: true,
    }),
  );
  expect(changed).toHaveBeenCalledTimes(1);
});
it('invalidates restart recovery on edits and refuses unbound recovery identities', async () => {
  await expireApprovedPreview();
  await changeInput(input('Configuration file path'), 'settings.json');
  expect(button('Start fresh dependency review')).toBeUndefined();
  await click(button('Preview selected additions'));
  await click(checkbox('I reviewed these exact additions'));
  wrongRecovery = true;
  await click(button('Approve dependency scope'));
  expect(button('Start fresh dependency review')).toBeUndefined();
  expect(EffectArray.filter(posted, item => item.action === 'restart')).toHaveLength(0);
});
it('fences duplicate restart requests and ignores a delayed recovery response after changing target/project', async () => {
  await expireApprovedPreview();
  await click(checkbox('Replace the expired approval'));
  const pending = Promise.withResolvers<void>();
  gate = pending.promise;
  await act(async () => {
    button('Start fresh dependency review').click();
    button('Start fresh dependency review').click();
  });
  expect(EffectArray.filter(posted, item => item.action === 'restart')).toHaveLength(1);
  expect(checkbox('Replace the expired approval').disabled).toBe(true);
  expect(input('Dependency source limit').disabled).toBe(true);
  await render(nextUri, 'other');
  gate = undefined;
  await click(button('Inspect prepared project scope'));
  await click(checkbox('Main source'));
  await click(button('Find one-hop sources'));
  await click(checkbox('src/dependency.ts'));
  await act(async () => pending.resolve());
  expect(button('Start fresh dependency review')).toBeUndefined();
  expect(document.querySelector('[aria-label="Exact dependency expansion preview"]')).toBeNull();
  expect(checkbox('src/dependency.ts').checked).toBe(true);
});
it('preserves exact recovery identity after an interrupted restart but requires explicit retry approval', async () => {
  await expireApprovedPreview();
  await click(checkbox('Replace the expired approval'));
  restartError = true;
  await click(button('Start fresh dependency review'));
  expect(button('Start fresh dependency review').disabled).toBe(true);
  expect(checkbox('Replace the expired approval').checked).toBe(false);
  restartError = false;
  await click(checkbox('Replace the expired approval'));
  await click(button('Start fresh dependency review'));
  expect(EffectArray.filter(posted, item => item.action === 'restart')).toEqual([
    expect.objectContaining({revision: hash, approvalDigest: Effect.pipe('b', EffectString.repeat(64))}),
    expect.objectContaining({revision: hash, approvalDigest: Effect.pipe('b', EffectString.repeat(64))}),
  ]);
  expect(button('Approve dependency scope').disabled).toBe(true);
});
