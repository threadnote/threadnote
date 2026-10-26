// @vitest-environment happy-dom
import fc from 'fast-check';
import {retainSemanticChoice, semanticEvidenceIdentity} from '../../src/attention/semantic_recovery.js';
import {MaintenanceCaseDialog} from '../../src/attention/maintenance_dialogs.js';
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
    'Checking the current statements. Your choice is retained; review the refreshed outcome before confirming.',
  );
  expect(host.textContent).not.toContain('ResourceConflict');
  expect(host.textContent).not.toContain('threadnote://user/test/');
  expect(host.textContent).not.toContain('fresh evidence');
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(host.textContent).not.toContain('Confirm and move');
  expect(host.querySelector<HTMLInputElement>('input[value="left"]')?.checked).toBe(true);
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

it('revalidates a stale finding in place and retains the human choice', async () => {
  const item = {
    caseId: finding.caseId!,
    project: 'threadnote',
    memoryId: 'a',
    family: 'semantic-contradiction',
    slot: 'pair',
    evidenceRevision: 'new-corpus',
    disposition: 'needs-decision',
    reason: 'opposing-canonical-claims',
    firstSeen: 'now',
    lastSeen: 'now',
    lastChecked: 'now',
    attemptCount: 1,
    events: [],
  };
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    path.endsWith('/semantic/preview')
      ? response({preview: {...preview, choice: 'both', mode: 'keep-both'}})
      : path.endsWith('/semantic/apply')
        ? response({result: {status: 'applied', choice: 'both'}})
        : response({
            outcome: 'ready',
            item,
            packet: {
              version: 2,
              project: 'threadnote',
              caseId: finding.caseId,
              evidenceRevision: 'new-corpus',
              semanticEvidence: evidence,
            },
          }),
  );
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(() => {});
  const close = vi.fn();
  const detail = (stale: boolean) => (
    <HealthDetail
      finding={finding}
      project="threadnote"
      repairsAvailable
      stale={stale}
      onOpenLibrary={() => {}}
      onChanged={resolved}
      onRefresh={refresh}
      onClose={close}
    />
  );
  await act(async () => root.render(detail(false)));
  await choose('both');
  await click('Preview my choice');
  await act(async () => root.render(detail(true)));
  expect(host.querySelector<HTMLInputElement>('input[value="both"]')?.checked).toBe(true);
  expect(host.textContent).not.toContain('paused because');
  expect(host.textContent).toContain('Keep memory A current');
  await click('Confirm both apply');
  expect(fetch.mock.calls.filter(([path]) => path.endsWith('/semantic/apply'))).toHaveLength(1);
  expect(resolved).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it('keeps a retained semantic preview through unrelated invalidation and adopts the new scan revision', async () => {
  const item = {
    caseId: 'case-one',
    project: 'threadnote',
    memoryId: 'a',
    family: 'semantic-contradiction',
    slot: 'pair',
    evidenceRevision: 'scan-one',
    disposition: 'needs-decision' as const,
    reason: 'opposing-canonical-claims',
    firstSeen: 'now',
    lastSeen: 'now',
    lastChecked: 'now',
    attemptCount: 1,
    events: [],
  };
  const packet = {
    version: 2,
    project: 'threadnote',
    caseId: item.caseId,
    evidenceRevision: 'scan-one',
    expectedContentHash: 'hash',
    reason: item.reason,
    choices: [],
    allowedOperations: [],
    instructions: 'Compare.',
    semanticEvidence: evidence,
  };
  const adopted = vi.fn();
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    path.endsWith('/semantic/preview')
      ? response({preview: {...preview, choice: 'both', mode: 'keep-both'}})
      : path.endsWith('/semantic/apply')
        ? response({result: {status: 'applied', choice: 'both'}})
        : _init?.method === 'POST'
          ? response({
              outcome: 'ready',
              item: {...item, evidenceRevision: 'scan-two'},
              packet: {...packet, evidenceRevision: 'scan-two'},
            })
          : path.includes('view=status')
            ? response({version: 2, cases: [item]})
            : response(packet),
  );
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
  const element = (stale: boolean) => (
    <MaintenanceCaseDialog
      project="threadnote"
      caseId={item.caseId}
      initialCase={item}
      stale={stale}
      onEvidenceUpdated={adopted}
      onOpenLibrary={() => {}}
      onTask={() => {}}
      onClose={() => {}}
      onChanged={resolved}
    />
  );
  await act(async () => root.render(element(false)));
  await choose('both');
  await click('Preview my choice');
  await act(async () => root.render(element(true)));
  expect(host.querySelector<HTMLInputElement>('input[value="both"]')?.checked).toBe(true);
  expect(adopted).toHaveBeenLastCalledWith(expect.objectContaining({evidenceRevision: 'scan-two'}), 'case-one');
  await click('Confirm both apply');
  expect(resolved).toHaveBeenCalledOnce();
  expect(fetch.mock.calls.filter(([path]) => path.endsWith('/semantic/apply'))).toHaveLength(1);
});

it('retains a URI choice after source changes and requires a fresh preview before confirmation', async () => {
  let revision = 'first';
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    path.endsWith('/preview')
      ? response({preview: {...preview, choice: 'both', mode: 'keep-both', revision}})
      : response({result: {status: 'applied', choice: 'both'}}),
  );
  vi.stubGlobal('fetch', fetch);
  await render();
  await choose('both');
  await click('Preview my choice');
  const changed = {
    ...evidence,
    left: {...evidence.left, text: 'Timeout is 90 seconds.', recordContentFingerprint: 'new-source'},
  };
  revision = 'second';
  await act(async () =>
    root.render(
      <SemanticResolutionReview
        project="threadnote"
        evidence={changed}
        onOpenLibrary={() => {}}
        onResolved={resolved}
        onRefresh={refresh}
      />,
    ),
  );
  expect(host.querySelector<HTMLInputElement>('input[value="both"]')?.checked).toBe(true);
  expect(host.textContent).toContain('Timeout is 90 seconds.');
  expect(host.textContent).not.toContain('Confirm both apply');
  await click('Preview my choice');
  await click('Confirm both apply');
  const applied = fetch.mock.calls.filter(([path]) => path.endsWith('/apply'));
  expect(applied).toHaveLength(1);
  expect(JSON.parse(String(applied[0][1]?.body)).revision).toBe('second');
});

it('preserves source identity through bounded arbitrary refresh and ordering sequences', () => {
  fc.assert(
    fc.property(fc.constantFrom('left', 'right', 'both'), fc.array(fc.boolean(), {maxLength: 24}), (initial, swaps) => {
      let current = evidence;
      let choice = initial as 'left' | 'right' | 'both' | undefined;
      const selectedUri = initial === 'both' ? undefined : evidence[initial].recordUri;
      for (const swap of swaps) {
        const next = swap ? {...current, left: current.right, right: current.left} : {...current};
        expect(semanticEvidenceIdentity(next)).toBe(semanticEvidenceIdentity(current));
        choice = retainSemanticChoice(choice, current, next);
        expect(choice === 'both' ? initial : next[choice!].recordUri).toBe(initial === 'both' ? 'both' : selectedUri);
        current = next;
      }
      expect(
        retainSemanticChoice(choice, current, {...current, left: {...current.left, recordUri: 'threadnote://other'}}),
      ).toBeUndefined();
    }),
    {numRuns: 32},
  );
});

it('redacts selected semantic evidence after source access is revoked and sends no confirmation', async () => {
  const item = {
    caseId: 'private-case',
    project: 'threadnote',
    memoryId: 'a',
    family: 'semantic-contradiction',
    slot: 'pair',
    evidenceRevision: 'scan',
    disposition: 'needs-decision' as const,
    reason: 'opposing-canonical-claims',
    firstSeen: 'now',
    lastSeen: 'now',
    lastChecked: 'now',
    attemptCount: 1,
    events: [],
  };
  const fetch = vi.fn(async (path: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? response({error: 'Source access is unavailable.'}, 403)
      : path.includes('view=status')
        ? response({version: 2, cases: [item]})
        : response({
            version: 2,
            project: 'threadnote',
            caseId: item.caseId,
            evidenceRevision: 'scan',
            semanticEvidence: evidence,
          }),
  );
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
  const element = (stale: boolean) => (
    <MaintenanceCaseDialog
      project="threadnote"
      caseId={item.caseId}
      initialCase={item}
      stale={stale}
      onOpenLibrary={() => {}}
      onTask={() => {}}
      onClose={() => {}}
    />
  );
  await act(async () => root.render(element(false)));
  await choose('both');
  expect(host.textContent).toContain(evidence.left.text);
  await act(async () => root.render(element(true)));
  expect(host.textContent).not.toContain(evidence.left.text);
  expect(host.textContent).not.toContain('Confirm both apply');
  expect(fetch.mock.calls.some(([path]) => path.endsWith('/semantic/apply'))).toBe(false);
});

it('revalidates a real duplicate finding through current health evidence despite its projected caseId', async () => {
  const health = buildContextHealthReport({
    project: 'threadnote',
    records: [
      record('duplicate-a', 'Identical retained advice.'),
      record('duplicate-b', 'Identical retained advice.'),
    ].map(value => ({
      ...value,
      uri:
        value.uri.replace('threadnote://memory/', 'threadnote://user/tester/memories/durable/projects/threadnote/') +
        '.md',
      metadata: {...value.metadata, topic: 'same-advice'},
    })),
    now: new Date('2026-06-01'),
  });
  const duplicate = health.findings.find(item => item.category === 'exact-duplicate')!;
  expect(duplicate.caseId).toBeTruthy();
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    path.startsWith('/api/context-health?')
      ? response({...health, recordPreviews: [], repositoryEvidence: {state: 'available'}})
      : path === '/api/context-health/preview'
        ? response({
            proposal: {
              proposalId: 'repair',
              revision: 'revision',
              summary: 'Archive the duplicate.',
              mutation: {kind: 'archive-memory'},
              preconditions: [],
            },
          })
        : response({outcome: 'unavailable', reason: 'Unsupported family.'}),
  );
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
  const element = (stale: boolean) => (
    <HealthDetail
      finding={duplicate}
      project="threadnote"
      repairsAvailable
      stale={stale}
      onOpenLibrary={() => {}}
      onChanged={() => {}}
      onClose={() => {}}
    />
  );
  await act(async () => root.render(element(false)));
  await act(async () => root.render(element(true)));
  await act(async () => root.render(element(false)));
  await click('Preview repair');
  expect(host.textContent).toContain('Archive the duplicate.');
  expect(fetch.mock.calls.some(([path]) => path === '/api/attention/context-maintenance')).toBe(false);
});
