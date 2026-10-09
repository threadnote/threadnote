// @vitest-environment happy-dom

import React, {act} from 'react';
import {describe, expect, it, vi} from 'vitest';

vi.mock('../../src/memory_editor.js', () => ({
  MemoryEditor: (props: {content: string; disabled: boolean; onChange: (value: string) => void}) =>
    React.createElement('textarea', {
      value: props.content,
      disabled: props.disabled,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange(event.target.value),
    }),
}));

const firstUri = 'threadnote://user/test/memories/handoffs/active/threadnote/first.md';
const secondUri = 'threadnote://user/test/memories/handoffs/active/threadnote/second.md';
const firstAliasUri = 'threadnote://memory/tn_first';

describe('Manager disconnect recovery', () => {
  it('preserves new and selected drafts, then gates a changed canonical record until reviewed', async () => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true, writable: true});
    const originalFetch = globalThis.fetch;
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
    let online = true;
    let firstContent = 'Original handoff';
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        if (!online) throw new TypeError('Manager is unavailable');
        const url = new URL(String(input), 'http://localhost');
        const path = url.pathname;
        if (path === '/api/state')
          return json({
            agents: [],
            autoUpdate: {effectivePolicy: 'notify'},
            config: {account: 'local', agentContextHome: '/tmp/threadnote-test', user: 'test'},
            updateAvailable: false,
            version: 'test',
          });
        if (path === '/api/tree')
          return json({
            resourcesTree: node('resources', 'threadnote://resources', true),
            tree: {
              ...node('memories', 'threadnote://user/test/memories', true),
              children: [node('first.md', firstUri), node('second.md', secondUri)],
            },
          });
        if (path === '/api/memory') {
          const requestedUri = url.searchParams.get('uri');
          const uri = requestedUri === firstAliasUri ? firstUri : requestedUri;
          const content = uri === firstUri ? firstContent : 'Second handoff';
          const selected = node(uri === firstUri ? 'first.md' : 'second.md', uri ?? '');
          return json({content, node: selected, record: {content, body: content, metadata: selected.metadata, uri}});
        }
        if (path === '/api/reviews')
          return json({
            items: [
              {
                candidates: [
                  {
                    candidateId: 'candidate-1',
                    categories: [],
                    comparison: 'new',
                    confidence: 1,
                    proposedText: 'Updated handoff',
                    reason: 'Review the current handoff',
                    recommendation: 'replace',
                    state: 'pending',
                    targetUri: firstAliasUri,
                  },
                ],
                createdAt: '2026-09-28T00:00:00Z',
                project: 'threadnote',
                reviewId: 'review-1',
                revision: 1,
                task: 'Review alias navigation',
                topic: 'manager',
              },
            ],
            pendingCount: 1,
            project: 'threadnote',
            version: 1,
          });
        if (path === '/api/reviews/preview')
          return json({
            delta: {
              items: [
                {
                  candidateId: 'candidate-1',
                  mutationPreview: {operation: 'replace', truncated: false},
                },
              ],
            },
            review: {
              candidates: [
                {
                  applyBodyText: 'Updated handoff',
                  candidateId: 'candidate-1',
                  evidence: [],
                  kind: 'handoff',
                  proposedText: 'Updated handoff',
                  reason: 'Review the current handoff',
                  state: 'pending',
                  targetUri: firstAliasUri,
                  topic: 'manager',
                },
              ],
              revision: 1,
              task: 'Review alias navigation',
            },
          });
        if (path === '/api/home')
          return json({
            handoffs: [],
            lanes: [],
            project: 'threadnote',
            stats: {memories: 2, outcomes: 0, pending: 1},
          });
        if (path === '/api/shares') return json({shares: []});
        if (path === '/api/graphs') return json({repositories: [], builds: [], diagnostics: [], views: []});
        if (path === '/api/graphs/diagnostics')
          return new Response(JSON.stringify({error: 'Diagnostics unavailable in this fixture'}), {status: 503});
        if (path === '/api/graphs/status') return json({builds: [], catalogRevision: 'test'});
        return json({});
      },
      writable: true,
    });
    try {
      await act(async () => {
        (await import('@threadnote/manager/ui')).mountManager({integrations: []});
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await flush();
        if (!document.querySelector<HTMLButtonElement>('.primary-nav button:nth-child(4)')?.disabled) break;
      }
      expect(
        document.querySelector<HTMLButtonElement>('.primary-nav button:nth-child(4)')?.disabled,
        root.textContent ?? '',
      ).toBe(false);
      await clickButton('Reviews');
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await flush();
        if (root.textContent?.includes('Review and decide')) break;
      }
      await clickButton('Review and decide →');
      await flush();
      await clickButton('Inspect existing memory in Library');
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await flush();
        if (actionButton('Edit')?.disabled === false) break;
      }
      expect(root.querySelector(`.tree-file[title="${firstUri}"]`)).not.toBeNull();
      expect(root.querySelector(`.tree-file[title="${firstAliasUri}"]`)).toBeNull();
      expect(actionButton('Edit')?.disabled).toBe(false);
      await clickButton('Library');
      await flush();
      await clickButton('New memory');
      await editTextarea('Unsaved new memory');
      online = false;
      await refresh();
      expect(root.textContent).toContain('Manager disconnected');
      online = true;
      await refresh();
      expect(editor()?.value).toBe('Unsaved new memory');

      await selectMemory(firstUri);
      expect(editor()?.value).toBe('Original handoff');
      await editTextarea('Unsaved handoff edit');
      online = false;
      await refresh();
      firstContent = 'Changed on disk';
      online = true;
      await refresh();
      expect(root.textContent).toContain('Unsaved handoff edit');
      expect(root.textContent).toContain('Your unsaved draft is preserved');
      expect(root.textContent).toContain('Review the reloaded record');
      expect(actionButton('Save')?.disabled ?? true).toBe(true);

      await clickButton('Load reloaded record');
      await clickButton('Edit');
      expect(editor()?.value).toBe('Changed on disk');
      await selectMemory(secondUri);
      expect(editor()?.value).toBe('Second handoff');
      expect(actionButton('Save')?.disabled).toBe(false);
      await openSelectedMenu();
      await clickButton('Forget…');
      await clickButton('Forget memory');
      expect(editor()).toBeNull();
      await selectMemory(firstUri);
      expect(root.textContent).not.toContain('Your unsaved draft is preserved');
      expect(editor()?.value).toBe('Changed on disk');
      await openSelectedMenu();
      await clickButton('Forget…');
      await clickButton('Forget memory');
      expect(editor()).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      document.body.replaceChildren();
    }
  });
});

function node(name: string, uri: string, isDir = false) {
  return {
    isDir,
    isShared: false,
    isSystem: false,
    metadata: {
      kind: 'handoff',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-09-14T00:00:00Z',
    },
    name,
    relativePath: name,
    uri,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function clickButton(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')].find(
    candidate => candidate.textContent?.trim() === label || candidate.querySelector('strong')?.textContent === label,
  );
  expect(
    button,
    `${label}: ${[...document.querySelectorAll('button')].map(candidate => candidate.textContent?.trim()).join(' | ')}`,
  ).toBeDefined();
  await act(async () => button?.click());
  await flush();
}

async function refresh(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>('[aria-label="Refresh manager"]');
  expect(button?.disabled).toBe(false);
  await act(async () => button?.click());
  await flush();
}

async function selectMemory(uri: string, edit = true): Promise<void> {
  if (!document.querySelector(`.tree-file[title="${uri}"]`)) {
    await clickButton('Back to Library');
    if (document.querySelector('dialog')?.textContent?.includes('Discard unsaved changes?'))
      await clickButton('Discard changes');
  }
  const button = document.querySelector<HTMLButtonElement>(`.tree-file[title="${uri}"]`);
  expect(button).not.toBeNull();
  await act(async () => button?.click());
  await flush();
  if (document.querySelector('dialog')?.textContent?.includes('Discard unsaved changes?'))
    await clickButton('Discard changes');
  if (edit) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await flush();
      if (!actionButton('Edit')?.disabled) break;
    }
    await clickButton('Edit');
  } else {
    await flush();
  }
}

async function editTextarea(value: string): Promise<void> {
  const textarea = editor();
  expect(textarea).not.toBeNull();
  await act(async () => {
    if (textarea) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
      textarea.dispatchEvent(new Event('input', {bubbles: true}));
    }
  });
}

function editor(): HTMLTextAreaElement | null {
  return document.querySelector('.editor-pane textarea');
}

function actionButton(label: string): HTMLButtonElement | undefined {
  return [
    ...document.querySelectorAll<HTMLButtonElement>('.editor-pane .action-row button, .topbar .action-row button'),
  ].find(button => button.textContent?.trim() === label);
}

async function openSelectedMenu(): Promise<void> {
  await act(async () => document.querySelector<HTMLButtonElement>('.pane-head [aria-haspopup="menu"]')?.click());
}
