import {Array as EffectArray, Option as EffectOption, Schema} from 'effect';
// @vitest-environment happy-dom
import React, {act} from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import type {TreeNode} from '../../src/ui/contracts.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

vi.mock('../../src/memory_editor.js', () => ({
  MemoryEditor: (props: {content: string; disabled: boolean; onChange: (value: string) => void}) => (
    <textarea
      aria-label="Test Markdown editor"
      disabled={props.disabled}
      value={props.content}
      onChange={event => props.onChange(event.target.value)}
    />
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('wires hidden folder descendants to bulk results, keeps failures selected, and saves a Home draft as the user', async () => {
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
  const rootUri = 'threadnote://user/test/memories';
  const leaf = (name: string): TreeNode => ({
    name,
    uri: `${rootUri}/durable/projects/project/${name}`,
    relativePath: `durable/projects/project/${name}`,
    isDir: false,
    isSystem: false,
    isShared: false,
    metadata: {
      kind: 'durable',
      status: 'active',
      project: 'project',
      sourceAgentClient: 'user',
      timestamp: '2026-10-07T00:00:00Z',
      topic: name,
    },
  });
  let leaves = [leaf('one.md'), leaf('two.md')];
  const posts: {path: string; body: Record<string, unknown>}[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    // Exercise the explicit REST compatibility path in this library fixture.
    if (url.pathname === '/api/live-session')
      return new Response(JSON.stringify({error: 'Live unavailable in this REST fixture'}), {status: 404});
    const body = init?.body
      ? Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(String(init.body)))
      : {};
    if (init?.body) posts.push({path: url.pathname, body});
    if (url.pathname === '/api/processes') return json({processes: [], schemaVersion: 1, truncated: false});
    if (url.pathname === '/api/state')
      return json({
        agents: [],
        config: {user: 'test', account: 'local', agentContextHome: '/tmp/threadnote-test'},
        autoUpdate: {effectivePolicy: 'notify'},
        updateAvailable: false,
        version: 'fixture',
      });
    if (url.pathname === '/api/tree')
      return json({
        resourcesTree: {
          name: 'resources',
          uri: 'threadnote://resources',
          relativePath: '',
          isDir: true,
          isSystem: true,
          isShared: false,
          children: [],
        },
        tree: {
          ...leaf('memories'),
          uri: rootUri,
          relativePath: '',
          isDir: true,
          children: [{...leaf('project'), relativePath: 'durable/projects/project', isDir: true, children: leaves}],
        },
      });
    if (url.pathname === '/api/graphs')
      return json({repositories: [], builds: [], diagnostics: [], waiterCount: 0, waiters: []});
    if (url.pathname === '/api/shares') return json({shares: []});
    if (url.pathname === '/api/home')
      return json({
        version: 1,
        project: url.searchParams.get('project') ?? '',
        lanes: [],
        handoffs: [],
        stats: {memories: leaves.length},
      });
    if (url.pathname === '/api/bulk') {
      const before = leaves;
      leaves = leaves.slice(1);
      return json({
        results: EffectArray.map(before, (node, index) => ({
          uri: node.uri,
          ok: index === 0,
          ...(index ? {error: 'synthetic failure'} : {}),
        })),
      });
    }
    if (url.pathname === '/api/memory/save') {
      leaves = [...leaves, leaf('new-memory.md')];
      return json({output: `Stored ${leaves.at(-1)!.uri}`});
    }
    if (url.pathname === '/api/memory') {
      const node = EffectOption.getOrUndefined(
        EffectArray.findFirst(leaves, item => item.uri === url.searchParams.get('uri')),
      );
      const content = 'MEMORY\nkind: durable\n\nSaved body';
      return json({node, content, record: {metadata: node?.metadata, body: content, content, uri: node?.uri}});
    }
    return json({});
  });
  const container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  await act(async () => {
    (await import('../../src/ui.js')).mountManager({integrations: []});
  });
  const projectSelector = container.querySelector<HTMLSelectElement>('[aria-label="Workspace project"]')!;
  expect(projectSelector.value).toBe('');
  expect(projectSelector.selectedOptions[0]?.textContent).toBe('All');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh manager"]')!.click());
  expect(projectSelector.value).toBe('');
  await act(async () => {
    projectSelector.value = 'project';
    projectSelector.dispatchEvent(new Event('change', {bubbles: true}));
  });
  const button = (label: string) =>
    EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...document.querySelectorAll<HTMLButtonElement>('button')],
        item =>
          Effect.pipe(item.textContent, effectOptionalString =>
            effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
          ) === label || item.querySelector('strong')?.textContent === label,
      ),
    )!;
  await act(async () => button('Library').click());
  expect(container.textContent).toContain('Your private memory library');
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('[aria-label="Select folder project and all descendant memories"]')!
      .click(),
  );
  const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await fill(search, 'one.md');
  expect(container.textContent).toContain('2 memories selected');
  await act(async () => button('Forget…').click());
  expect(document.querySelector('dialog')?.textContent).toContain('two.md');
  await act(async () => document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!.click());
  expect(
    EffectOption.getOrUndefined(EffectArray.findFirst(posts, post => post.path === '/api/bulk'))?.body.uris,
  ).toEqual([`${rootUri}/durable/projects/project/one.md`, `${rootUri}/durable/projects/project/two.md`]);
  expect(container.textContent).toContain('1 memory selected');
  expect(container.textContent).toContain('synthetic failure');
  await act(async () => button('Home').click());
  await act(async () => button('New memory').click());
  expect(container.querySelector<HTMLInputElement>('input[placeholder="project"]')?.value).toBe('project');
  await fill(container.querySelector<HTMLInputElement>('[aria-label="Memory title"]')!, 'New memory');
  const savedBody = '# Saved body\n\n```mermaid\nflowchart LR\n A-->B\n```';
  await fill(container.querySelector<HTMLTextAreaElement>('[aria-label="Test Markdown editor"]')!, savedBody);
  await act(async () => button('Save memory').click());
  expect(
    EffectOption.getOrUndefined(EffectArray.findFirst(posts, post => post.path === '/api/memory/save'))?.body,
  ).toMatchObject({
    text: savedBody,
    topic: 'New memory',
    project: 'project',
    sourceAgentClient: 'user',
  });
  expect(container.textContent).toContain('new-memory.md');
  expect(container.textContent).toContain('Saved local memory');
  await act(async () => button('Resources').click());
  expect(container.textContent).toContain('Browse your source material');
  expect(container.textContent).not.toContain('Saved body');
});

it('preserves an independent unsaved draft when an automatic update is applied and verified', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
  vi.spyOn(window, 'setInterval').mockImplementation(() => setTimeout(() => undefined, 0));
  const rootUri = 'threadnote://user/test/memories';
  const uri = `${rootUri}/durable/projects/project/ordinary.md`;
  const hash = Effect.pipe('a', EffectString.repeat(64));
  const reviewId = `review-${Effect.pipe('a', EffectString.repeat(24))}`;
  const node: TreeNode = {
    name: 'ordinary.md',
    uri,
    relativePath: 'durable/projects/project/ordinary.md',
    isDir: false,
    isSystem: false,
    isShared: false,
    metadata: {
      kind: 'durable',
      status: 'active',
      project: 'project',
      topic: 'Ordinary memory',
      sourceAgentClient: 'user',
      timestamp: '2026-10-22T00:00:00Z',
    },
  };
  const accepted = 'MEMORY\nkind: durable\n\nAccepted prose.';
  const updated = 'MEMORY\nkind: durable\nreviewed_support: exact-provenance\n\nAutomatically updated prose.';
  const authored = 'My independent unsaved authored draft.';
  let canonical = accepted;
  const coverage = {outcome: 'unknown', scope: 'none', searchedScopes: [], omittedSources: 1, omittedParagraphs: 0};
  const pendingReview = {
    version: 1,
    kind: 'automatic-memory-review',
    project: 'project',
    reviewId,
    revision: 1,
    state: 'pending',
    targetUri: uri,
    targetHash: hash,
    evidenceRevision: hash,
    purpose: 'automatic',
    acceptedBody: 'Accepted prose.',
    proposal: {
      version: 2,
      kind: 'automatic',
      body: updated,
      finalBodyHash: hash,
      changedOrdinals: [],
      draft: {
        version: 2,
        kind: 'automatic',
        purpose: 'automatic',
        paragraphDecisions: [],
        targetHash: hash,
        observationRevision: hash,
        packetDigest: hash,
        outcome: 'propose-update',
        operations: [],
        reviewedHandles: [],
        rationale: 'Updated source.',
        unresolvedQuestions: [],
        removedClaims: [],
      },
    },
    sourceEvidence: [],
    coverage,
    canApply: false,
    canFinishVerification: false,
    verified: false,
  };
  const approval = {
    stage: 'preview',
    reviewRevision: 2,
    approvalDigest: hash,
    content: updated,
    contentHash: hash,
    metadataDiff: [],
    reviewedSupport: {
      type: 'reviewed-memory-support',
      version: 1,
      active: {
        bodyHash: hash,
        paragraphs: [],
        sources: [],
        acceptance: {
          reviewId,
          approvedAt: '2026-10-22T00:00:00Z',
          targetBeforeHash: hash,
          preparationDigest: hash,
          sourceVectorDigest: hash,
        },
        digest: hash,
      },
    },
  };
  let current: Record<string, unknown> = pendingReview;
  const actions: Record<string, unknown>[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    // Exercise the explicit REST compatibility path in this library fixture.
    if (url.pathname === '/api/live-session')
      return new Response(JSON.stringify({error: 'Live unavailable in this REST fixture'}), {status: 404});
    if (url.pathname === '/api/processes') return json({processes: [], schemaVersion: 1, truncated: false});
    if (url.pathname === '/api/state')
      return json({
        agents: [],
        config: {user: 'test', account: 'local', agentContextHome: '/tmp/threadnote-test'},
        autoUpdate: {effectivePolicy: 'notify'},
        updateAvailable: false,
        version: 'fixture',
      });
    if (url.pathname === '/api/tree')
      return json({
        resourcesTree: {
          name: 'resources',
          uri: 'threadnote://resources',
          relativePath: '',
          isDir: true,
          isSystem: true,
          isShared: false,
          children: [],
        },
        tree: {...node, name: 'memories', uri: rootUri, relativePath: '', isDir: true, children: [node]},
      });
    if (url.pathname === '/api/graphs')
      return json({repositories: [], builds: [], diagnostics: [], waiterCount: 0, waiters: []});
    if (url.pathname === '/api/shares') return json({shares: []});
    if (url.pathname === '/api/home')
      return json({version: 1, project: '', lanes: [], handoffs: [], stats: {memories: 1}});
    if (url.pathname === '/api/memory')
      return json({
        node,
        content: canonical,
        record: {metadata: node.metadata, body: canonical, content: canonical, uri: node.uri},
      });
    if (url.pathname === '/api/attention/automatic-memory')
      return json({
        version: 1,
        project: 'project',
        omitted: 0,
        items:
          canonical === accepted
            ? [
                {
                  uri,
                  title: 'Ordinary memory',
                  targetHash: hash,
                  state: 'ready',
                  coverage,
                  paragraphs: [],
                  route: 'personal-review',
                  legacyUncited: false,
                  reviewId,
                },
              ]
            : [],
      });
    if (url.pathname === '/api/attention/automatic-review') {
      if (init?.body) {
        const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
          JSON.parse(String(init.body)),
        );
        actions.push(body);
        if (body.action === 'preview') current = {...pendingReview, revision: 2, approval, canApply: true};
        if (body.action === 'apply') {
          canonical = updated;
          current = {
            ...pendingReview,
            revision: 3,
            state: 'applied',
            approval: {...approval, stage: 'written'},
            verified: true,
          };
        }
      }
      return json(current);
    }
    return json({});
  });
  const container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  await act(async () => (await import('../../src/ui.js')).mountManager({integrations: []}));
  const button = (label: string) =>
    EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...container.querySelectorAll<HTMLButtonElement>('button')],
        item =>
          Effect.pipe(item.textContent, effectOptionalString =>
            effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
          ) === label || item.querySelector('strong')?.textContent === label,
      ),
    )!;
  const click = async (label: string) => {
    await act(async () => button(label).click());
  };
  await click('Library');
  await click('Ordinary memory');
  await click('Edit');
  await fill(container.querySelector<HTMLTextAreaElement>('[aria-label="Test Markdown editor"]')!, authored);
  await click('Back to Library');
  await click('Review update');
  await act(async () => {
    for (
      let attempt = 0;
      attempt < 100 && container.querySelector('.automatic-review-exact pre')?.textContent !== updated;
      attempt++
    )
      await Effect.Effect.runPromise(Effect.Effect.sleep('1 millis'));
  });
  expect(container.querySelector('.automatic-review-exact pre')?.textContent).toBe(updated);
  expect(canonical).toBe(accepted);
  expect(button('Apply update').disabled).toBe(false);
  await click('Apply update');
  await act(async () => {
    for (
      let attempt = 0;
      attempt < 100 && container.querySelector('.manager-draft-reconcile pre')?.textContent !== updated;
      attempt++
    )
      await Effect.Effect.runPromise(Effect.Effect.sleep('1 millis'));
  });
  expect(actions).toEqual([
    {action: 'preview', project: 'project', reviewId, revision: 1},
    {action: 'apply', project: 'project', reviewId, revision: 2, approvalDigest: hash, approved: true},
  ]);
  expect(canonical).toBe(updated);
  expect(container.textContent).toContain('Memory update saved and verified');
  expect(container.querySelector('.manager-draft-reconcile pre')?.textContent).toBe(updated);
  expect(button('Keep my draft')).toBeDefined();
  expect(button('Load reloaded record')).toBeDefined();
  expect(container.querySelector('.library-article')?.textContent).toContain(authored);
  await click('Keep my draft');
  expect(container.querySelector('.manager-draft-reconcile')).toBeNull();
  await click('Edit');
  expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Test Markdown editor"]')?.value).toBe(authored);
});

async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}
