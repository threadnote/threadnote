// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {buildContextHealthReport} from '@threadnote/context/health';
import type {MemoryRecord} from '@threadnote/memory/document';
import {SemanticResolutionReview} from '../../src/attention/semantic_comparison.js';
import {HealthDetail} from '../../src/attention_details.js';

const record = (name: string, body: string): MemoryRecord => ({
  uri: `threadnote://memory/${name}`,
  body,
  content: body,
  headerTitle: 'MEMORY',
  metadata: {
    kind: 'durable',
    project: 'threadnote',
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-01-01',
  },
});
const finding = buildContextHealthReport({
  project: 'threadnote',
  records: [
    record('a', '# Production\nTimeout is 60 seconds.'),
    record('b', '# Production\nTimeout must be 30 seconds.'),
  ],
  now: new Date('2026-06-01'),
}).findings[0];
const evidence = finding.semanticEvidence!;
const preview = {
  previewId: 'preview-one',
  revision: 'revision-one',
  choice: 'left',
  mode: 'archive-other',
  summary: 'Keep memory A current; move memory B to history.',
  keptUri: evidence.left.recordUri,
  archivedUri: evidence.right.recordUri,
  archivedContent: '# Timeout policy\nTimeout must be 30 seconds.\n\nOther important advice stays in history.',
};
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status});
let root: Root;
let host: HTMLDivElement;
const resolved = vi.fn();
const refresh = vi.fn();
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  resolved.mockReset();
  refresh.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <SemanticResolutionReview
        project="threadnote"
        evidence={evidence}
        onOpenLibrary={() => {}}
        onResolved={resolved}
        onRefresh={refresh}
      />,
    ),
  );
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function choose(value: string) {
  await act(async () => host.querySelector<HTMLInputElement>(`input[value="${value}"]`)!.click());
}

it('previews the exact chosen pair, requires whole-memory acknowledgement and confirms only that revision', async () => {
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    response(path.endsWith('/preview') ? {preview} : {result: {status: 'applied'}}),
  );
  vi.stubGlobal('fetch', fetch);
  await render();
  const button = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Preview my choice');
  expect(button?.disabled).toBe(true);
  await choose('left');
  expect(fetch).not.toHaveBeenCalled();
  await click('Preview my choice');
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({
    project: 'threadnote',
    contradictionId: evidence.contradictionId,
    left: {
      recordUri: evidence.left.recordUri,
      recordContentFingerprint: evidence.left.recordContentFingerprint,
      claimFingerprint: evidence.left.claimFingerprint,
    },
    right: {
      recordUri: evidence.right.recordUri,
      recordContentFingerprint: evidence.right.recordContentFingerprint,
      claimFingerprint: evidence.right.claimFingerprint,
    },
    choice: 'left',
  });
  expect(host.textContent).toContain('whole memory');
  expect(host.textContent).toContain('Other important advice stays in history.');
  const confirm = [...host.querySelectorAll('button')].find(item =>
    item.textContent?.includes('Confirm and move memory B to history'),
  );
  expect(confirm?.disabled).toBe(true);
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click('Confirm and move memory B to history');
  expect(fetch.mock.calls[1][0]).toBe('/api/context-health/semantic/apply');
  expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toEqual({
    project: 'threadnote',
    previewId: 'preview-one',
    revision: 'revision-one',
    approved: true,
  });
  expect(resolved).toHaveBeenCalledOnce();
});

it('invalidates a prepared choice before another option can be confirmed and supports a keep-both review', async () => {
  const fetch = vi.fn(async () =>
    response({
      preview: {
        ...preview,
        choice: 'both',
        mode: 'keep-both',
        summary: 'Keep both memories current.',
        archivedUri: undefined,
        archivedContent: undefined,
      },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  await render();
  await choose('both');
  await click('Preview my choice');
  expect(host.textContent).toContain('Keep both memories current.');
  await choose('right');
  expect(host.textContent).not.toContain('Keep both memories current.');
  expect(host.textContent).not.toContain('Confirm both apply');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(resolved).not.toHaveBeenCalled();
});

it('shows an honest review-only reason with no approval control', async () => {
  const fetch = vi.fn(async () =>
    response({
      preview: {
        ...preview,
        mode: 'review-only',
        summary: 'Review the observed behavior and required policy.',
        reason: 'An observation and a requirement can both be true. Update the source advice explicitly.',
      },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  await render();
  await choose('left');
  await click('Preview my choice');
  expect(host.textContent).toContain('An observation and a requirement can both be true.');
  expect(host.textContent).toContain('Open memory A');
  expect(host.textContent).not.toContain('Confirm and move');
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('clears a stale preview and offers refresh without reporting a successful change', async () => {
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    path.endsWith('/preview')
      ? response({preview})
      : response(
          {
            error: 'ResourceConflict: threadnote://user/test/memories/durable/projects/threadnote/policy.md',
            code: 'semantic-evidence-stale',
          },
          409,
        ),
  );
  vi.stubGlobal('fetch', fetch);
  await render();
  await choose('left');
  await click('Preview my choice');
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click('Confirm and move memory B to history');
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    'This comparison is out of date. Refresh to review the latest memories, then choose again.',
  );
  expect(host.textContent).not.toContain('ResourceConflict');
  expect(host.textContent).not.toContain('threadnote://user/test/');
  expect(host.textContent).not.toContain('fresh evidence');
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(host.textContent).not.toContain('Confirm and move');
  await click('Refresh comparison');
  expect(refresh).toHaveBeenCalledOnce();
  expect(resolved).not.toHaveBeenCalled();
});

it('confirms keep-both without an archive acknowledgment and accepts an idempotent result', async () => {
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    response(
      path.endsWith('/preview')
        ? {preview: {...preview, choice: 'both', mode: 'keep-both', summary: 'Keep both memories current.'}}
        : {result: {status: 'already-applied', choice: 'both'}},
    ),
  );
  vi.stubGlobal('fetch', fetch);
  await render();
  await choose('both');
  await click('Preview my choice');
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  await click('Confirm both apply');
  expect(fetch.mock.calls[1][0]).toBe('/api/context-health/semantic/apply');
  expect(resolved).toHaveBeenCalledOnce();
});

it('blocks confirmation when an archive preview is incomplete or names the wrong source', async () => {
  const fetch = vi.fn(async () => response({preview: {...preview, archivedUri: 'threadnote://memory/unrelated'}}));
  vi.stubGlobal('fetch', fetch);
  await render();
  await choose('left');
  await click('Preview my choice');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('preview is incomplete');
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  const confirm = [...host.querySelectorAll('button')].find(item => item.textContent?.includes('Confirm and move'));
  expect(confirm?.disabled).toBe(true);
  await act(async () => confirm!.click());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(resolved).not.toHaveBeenCalled();
});

it('ignores a late preview after the comparison changes', async () => {
  const pending = Promise.withResolvers<Response>();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => pending.promise),
  );
  await render();
  await choose('left');
  const button = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Preview my choice');
  await act(async () => button!.click());
  await act(async () =>
    root.render(
      <SemanticResolutionReview
        project="another-project"
        evidence={evidence}
        onOpenLibrary={() => {}}
        onResolved={resolved}
        onRefresh={refresh}
      />,
    ),
  );
  await act(async () => pending.resolve(response({preview})));
  expect(host.textContent).not.toContain('Keep memory A current');
  expect([...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every(input => !input.checked)).toBe(true);
  expect(resolved).not.toHaveBeenCalled();
});

it('keeps a non-conflict operational error retryable without claiming that the memories changed', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response({error: 'The review could not be completed. Please try again.'}, 503))
    .mockResolvedValueOnce(response({preview}));
  vi.stubGlobal('fetch', fetch);
  await render();
  await choose('left');
  await click('Preview my choice');
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    'The review could not be completed. Please try again.',
  );
  expect(host.textContent).not.toContain('out of date');
  expect(host.textContent).not.toContain('Refresh comparison');
  expect(host.querySelector<HTMLInputElement>('input[value="left"]')?.disabled).toBe(false);
  await click('Preview my choice');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain('Keep memory A current; move memory B to history.');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(resolved).not.toHaveBeenCalled();
});

it('refreshes a stale finding without reporting a saved change', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({error: 'Comparison changed'}, 409)),
  );
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(() => {});
  const close = vi.fn();
  await act(async () =>
    root.render(
      <HealthDetail
        finding={finding}
        project="threadnote"
        repairsAvailable
        onOpenLibrary={() => {}}
        onChanged={resolved}
        onRefresh={refresh}
        onClose={close}
      />,
    ),
  );
  await choose('left');
  await click('Preview my choice');
  await click('Refresh comparison');
  expect(refresh).toHaveBeenCalledOnce();
  expect(resolved).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
