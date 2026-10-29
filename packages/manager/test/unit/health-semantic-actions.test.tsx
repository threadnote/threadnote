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
import {Array as EffectArray, String as EffectString, pipe as EffectPipe, Option as EffectOption} from 'effect';

import {retryEvidenceRead} from '../../src/attention/evidence_refresh.js';
import {ManagerApiError} from '../../src/ui/support.js';
import type {ManagerContextMaintenanceStatusV2} from '../../src/attention/contracts.js';

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
  constraints: [],
};
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status});
function maintenanceStatus(cases: ManagerContextMaintenanceStatusV2['cases']): ManagerContextMaintenanceStatusV2 {
  return {
    version: 2,
    paused: false,
    state: 'needs-decision',
    generation: 'fixture-generation',
    projects: [],
    cases,
    receipts: [],
  };
}

let root: Root;
let host: HTMLDivElement;
const resolved = vi.fn();
const refresh = vi.fn();
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
  vi.useRealTimers();
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
  const button = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...host.querySelectorAll('button')],
      item =>
        EffectPipe(item.textContent, effectOptionalString =>
          effectOptionalString == null ? undefined : EffectPipe(effectOptionalString, EffectString.trim),
        ) === label,
    ),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
function requestBodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.');
  return init.body;
}

async function choose(value: string) {
  await act(async () => host.querySelector<HTMLInputElement>(`input[value="${value}"]`)!.click());
}

it('previews the exact chosen pair, requires whole-memory acknowledgement and confirms only that revision', async () => {
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    response(
      EffectPipe(path, EffectString.endsWith('/preview')) ? {preview} : {result: {status: 'applied', choice: 'left'}},
    ),
  );
  vi.stubGlobal('fetch', fetch);
  await render();
  const button = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...host.querySelectorAll('button')],
      item =>
        EffectPipe(item.textContent, effectOptionalString =>
          effectOptionalString == null ? undefined : EffectPipe(effectOptionalString, EffectString.trim),
        ) === 'Preview my choice',
    ),
  );
  expect(button?.disabled).toBe(true);
  await choose('left');
  expect(fetch).not.toHaveBeenCalled();
  await click('Preview my choice');
  expect(JSON.parse(requestBodyText(fetch.mock.calls[0][1]))).toEqual({
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
  const confirm = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...host.querySelectorAll('button')],
      __effectArrayValue =>
        !!(item =>
          EffectPipe(item.textContent, effectOptionalString =>
            effectOptionalString == null
              ? undefined
              : EffectPipe(effectOptionalString, EffectString.includes('Confirm and move memory B to history')),
          ))(__effectArrayValue),
    ),
  );
  expect(confirm?.disabled).toBe(true);
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click('Confirm and move memory B to history');
  expect(fetch.mock.calls[1][0]).toBe('/api/context-health/semantic/apply');
  expect(JSON.parse(requestBodyText(fetch.mock.calls[1][1]))).toEqual({
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
    EffectPipe(path, EffectString.endsWith('/preview'))
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
      EffectPipe(path, EffectString.endsWith('/preview'))
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
  const confirm = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...host.querySelectorAll('button')],
      __effectArrayValue =>
        !!(item =>
          EffectPipe(item.textContent, effectOptionalString =>
            effectOptionalString == null
              ? undefined
              : EffectPipe(effectOptionalString, EffectString.includes('Confirm and move')),
          ))(__effectArrayValue),
    ),
  );
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
  const button = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...host.querySelectorAll('button')],
      item =>
        EffectPipe(item.textContent, effectOptionalString =>
          effectOptionalString == null ? undefined : EffectPipe(effectOptionalString, EffectString.trim),
        ) === 'Preview my choice',
    ),
  );
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
  expect(
    EffectArray.every([...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')], input => !input.checked),
  ).toBe(true);
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
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    EffectString.endsWith('/semantic/preview')(path)
      ? response({preview: {...preview, choice: 'both', mode: 'keep-both'}})
      : EffectString.endsWith('/semantic/apply')(path)
        ? response({result: {status: 'applied', choice: 'both'}})
        : response({outcome: 'ready', evidence}),
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
  expect(EffectArray.filter(fetch.mock.calls, ([path]) => EffectString.endsWith('/semantic/apply')(path))).toHaveLength(
    1,
  );
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
    EffectString.endsWith('/semantic/preview')(path)
      ? response({preview: {...preview, choice: 'both', mode: 'keep-both'}})
      : EffectString.endsWith('/semantic/apply')(path)
        ? response({result: {status: 'applied', choice: 'both'}})
        : _init?.method === 'POST'
          ? response({
              outcome: 'ready',
              item: {...item, evidenceRevision: 'scan-two'},
              packet: {...packet, evidenceRevision: 'scan-two'},
            })
          : EffectString.includes('view=status')(path)
            ? response(maintenanceStatus([item]))
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
  expect(EffectArray.filter(fetch.mock.calls, ([path]) => EffectString.endsWith('/semantic/apply')(path))).toHaveLength(
    1,
  );
});

it('retains a URI choice after source changes and requires a fresh preview before confirmation', async () => {
  let revision = 'first';
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    EffectString.endsWith('/preview')(path)
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
  const applied = EffectArray.filter(fetch.mock.calls, ([path]) => EffectString.endsWith('/apply')(path));
  expect(applied).toHaveLength(1);
  expect(JSON.parse(String(applied[0][1]?.body)).revision).toBe('second');
});

it('preserves source identity through bounded arbitrary refresh and ordering sequences', () => {
  fc.assert(
    fc.property(fc.constantFrom('left', 'right', 'both'), fc.array(fc.boolean(), {maxLength: 24}), (initial, swaps) => {
      let current = evidence;
      let choice: 'left' | 'right' | 'both' | undefined = initial;
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
      : EffectString.includes('view=status')(path)
        ? response(maintenanceStatus([item]))
        : response({
            version: 2,
            project: 'threadnote',
            caseId: item.caseId,
            memoryUri: 'threadnote://memory/a',
            expectedContentHash: 'hash',
            evidenceRevision: 'scan',
            reason: item.reason,
            choices: [],
            allowedOperations: [],
            instructions: 'Compare the current statements.',
            family: item.family,
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
  expect(EffectArray.some(fetch.mock.calls, ([path]) => EffectString.endsWith('/semantic/apply')(path))).toBe(false);
});

it('revalidates a real duplicate finding through current health evidence despite its projected caseId', async () => {
  const health = buildContextHealthReport({
    project: 'threadnote',
    records: EffectArray.map(
      [record('duplicate-a', 'Identical retained advice.'), record('duplicate-b', 'Identical retained advice.')],
      value => ({
        ...value,
        uri:
          EffectString.replace(
            'threadnote://memory/',
            'threadnote://user/tester/memories/durable/projects/threadnote/',
          )(value.uri) + '.md',
        metadata: {...value.metadata, topic: 'same-advice'},
      }),
    ),
    now: new Date('2026-06-01'),
  });
  const duplicate = EffectOption.getOrUndefined(
    EffectArray.findFirst(health.findings, item => item.category === 'exact-duplicate'),
  )!;
  expect(duplicate.caseId).toBeTruthy();
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    EffectString.startsWith('/api/context-health?')(path)
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
  expect(EffectArray.some(fetch.mock.calls, ([path]) => path === '/api/attention/context-maintenance')).toBe(false);
});

it('keeps comparison DOM, scroll, choice and preview stable through busy retries and recovers automatically', async () => {
  vi.useFakeTimers();
  let attempts = 0;
  const fetch = vi.fn(async (path: string, _init?: RequestInit) =>
    EffectString.endsWith('/semantic/preview')(path)
      ? response({preview: {...preview, choice: 'both', mode: 'keep-both'}})
      : EffectString.endsWith('/semantic/refresh')(path)
        ? ++attempts < 3
          ? response({error: 'Timed out waiting for local lock /private/state.lock.'}, 503)
          : response({outcome: 'ready', evidence})
        : response({result: {status: 'applied', choice: 'both'}}),
  );
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
  const detail = (stale: boolean) => (
    <HealthDetail
      finding={finding}
      project="threadnote"
      repairsAvailable
      stale={stale}
      onOpenLibrary={() => {}}
      onChanged={resolved}
      onClose={() => {}}
    />
  );
  await act(async () => root.render(detail(false)));
  await choose('both');
  await click('Preview my choice');
  const card = host.querySelector('.semantic-memory-card');
  const dialog = host.querySelector('.detail-modal-body')!;
  const status = host.querySelector('.semantic-resolution-footer p');
  expect(status).not.toBeNull();
  dialog.scrollTop = 91;
  await act(async () => root.render(detail(true)));
  expect(host.querySelector('.semantic-memory-card')).toBe(card);
  expect(dialog.scrollTop).toBe(91);
  expect(host.textContent).not.toContain('/private/state.lock');
  const confirm = EffectOption.getOrUndefined(
    EffectArray.findFirst([...host.querySelectorAll('button')], button => button.textContent === 'Confirm both apply'),
  )!;
  expect(confirm.disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[value="both"]')!.checked).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(attempts).toBe(3);
  expect(host.querySelector('.semantic-memory-card')).toBe(card);
  expect(host.querySelector('.semantic-resolution-footer p')).toBe(status);
  expect(dialog.scrollTop).toBe(91);
  expect(confirm.disabled).toBe(false);
  expect(
    EffectArray.filter(fetch.mock.calls, ([path]) => EffectString.endsWith('/semantic/preview')(path)),
  ).toHaveLength(1);
  expect(EffectArray.some(fetch.mock.calls, ([path]) => EffectString.endsWith('/semantic/apply')(path))).toBe(false);
});

it.each([401, 403, 404])(
  'redacts a direct health comparison immediately after a permanent %s and does not retry',
  async status => {
    const fetch = vi.fn(async () => response({error: 'A selected source is unavailable.'}, status));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
    const detail = (stale: boolean) => (
      <HealthDetail
        finding={finding}
        project="threadnote"
        repairsAvailable
        stale={stale}
        onOpenLibrary={() => {}}
        onChanged={resolved}
        onClose={() => {}}
      />
    );
    await act(async () => root.render(detail(false)));
    await choose('both');
    await act(async () => root.render(detail(true)));
    expect(host.textContent).not.toContain(evidence.left.text);
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it('bounds observation retries across generated transient, success and permanent failure schedules', async () => {
  vi.useFakeTimers();
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom(200, 403, 404, 409, 422, 500, 503), {minLength: 1, maxLength: 6}),
      async schedule => {
        const attempted: number[] = [];
        const controller = new AbortController();
        const result = retryEvidenceRead(async () => {
          const status = schedule[Math.min(attempted.length, schedule.length - 1)];
          attempted.push(status);
          if (status !== 200) throw ManagerApiError.of('Unavailable', status);
          return true;
        }, controller.signal).then(
          () => true,
          () => false,
        );
        await vi.runAllTimersAsync();
        const observed = await result;
        const model: number[] = [];
        for (let index = 0; index < 3; index++) {
          const status = schedule[Math.min(index, schedule.length - 1)];
          model.push(status);
          if (status < 500) break;
        }
        expect(attempted).toEqual(model);
        expect(observed).toBe(model.at(-1) === 200);
      },
    ),
    {numRuns: 32, seed: 80405},
  );
});

it('cancels queued evidence retries on modal unmount without another source request', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => response({error: 'Busy'}, 503));
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
  await act(async () =>
    root.render(
      <HealthDetail
        finding={finding}
        project="threadnote"
        repairsAvailable
        stale
        onOpenLibrary={() => {}}
        onChanged={resolved}
        onClose={() => {}}
      />,
    ),
  );
  expect(fetch).toHaveBeenCalledOnce();
  await act(async () => root.render(null));
  await vi.runAllTimersAsync();
  expect(fetch).toHaveBeenCalledOnce();
});

it('retains a completed failure banner until a later current check succeeds without flashing or losing the preview', async () => {
  vi.useFakeTimers();
  let failed = true;
  const pending = Promise.withResolvers<Response>();
  const fetch = vi.fn(async (path: string) =>
    EffectString.endsWith('/semantic/preview')(path)
      ? response({preview: {...preview, choice: 'both', mode: 'keep-both'}})
      : failed
        ? response({error: 'Busy'}, 503)
        : pending.promise,
  );
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
  const detail = (stale: boolean) => (
    <HealthDetail
      finding={finding}
      project="threadnote"
      repairsAvailable
      stale={stale}
      onOpenLibrary={() => {}}
      onChanged={resolved}
      onClose={() => {}}
    />
  );
  await act(async () => root.render(detail(false)));
  await choose('both');
  await click('Preview my choice');
  await act(async () => root.render(detail(true)));
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  const banner = host.querySelector<HTMLElement>('[role="alert"]')!;
  expect(banner).not.toBeNull();
  const failure = banner.textContent;
  failed = false;
  await click('Check current evidence');
  expect(banner.textContent).toBe(failure);
  expect(banner.style.visibility).toBe('visible');
  expect(host.querySelector<HTMLInputElement>('input[value="both"]')!.checked).toBe(true);
  await act(async () => pending.resolve(response({outcome: 'ready', evidence})));
  expect(banner.isConnected).toBe(true);
  expect(banner.style.visibility).toBe('hidden');
  const confirm = EffectOption.getOrUndefined(
    EffectArray.findFirst([...host.querySelectorAll('button')], button => button.textContent === 'Confirm both apply'),
  )!;
  expect(confirm.disabled).toBe(false);
});

it('F007 preserves choice and preview through incomplete analysis while blocking confirmation and supports a current retry', async () => {
  let incomplete = true;
  let checks = 0;
  const reason =
    'The bounded comparison check could not review every statement. Your choice is saved; check current evidence after reviewing the source memories.';
  const changed = {...evidence, left: {...evidence.left, recordContentFingerprint: 'changed-source'}};
  const fetch = vi.fn(async (path: string) =>
    EffectString.endsWith('/semantic/preview')(path)
      ? response({preview: {...preview, choice: 'both', mode: 'keep-both'}})
      : (++checks,
        incomplete ? response({outcome: 'incomplete', reason}) : response({outcome: 'ready', evidence: changed})),
  );
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
  const detail = (stale: boolean) => (
    <HealthDetail
      finding={finding}
      project="threadnote"
      repairsAvailable
      stale={stale}
      onOpenLibrary={() => {}}
      onChanged={resolved}
      onClose={() => {}}
    />
  );
  await act(async () => root.render(detail(false)));
  await choose('both');
  await click('Preview my choice');
  const card = host.querySelector('.semantic-memory-card');
  await act(async () => root.render(detail(true)));
  expect(host.querySelector('.semantic-memory-card')).toBe(card);
  expect(host.querySelector<HTMLInputElement>('input[value="both"]')!.checked).toBe(true);
  expect(host.textContent).toContain(reason);
  expect(checks).toBe(1);
  const confirm = EffectOption.getOrUndefined(
    EffectArray.findFirst([...host.querySelectorAll('button')], button => button.textContent === 'Confirm both apply'),
  )!;
  expect(confirm.disabled).toBe(true);
  await click('Confirm both apply');
  expect(EffectArray.some(fetch.mock.calls, ([path]) => EffectString.endsWith('/semantic/apply')(path))).toBe(false);
  incomplete = false;
  await click('Check current evidence');
  expect(checks).toBe(2);
  expect(host.querySelector<HTMLInputElement>('input[value="both"]')!.checked).toBe(true);
  expect(host.textContent).not.toContain(reason);
  expect(host.textContent).not.toContain('Confirm both apply');
});

it.each(['body-limit', 'claim-limit', 'partial-unique'])(
  'F007 mounted retained comparison keeps its authorized choice and preview blocked on %s',
  async scenario => {
    const reason = `The bounded comparison check is incomplete (${scenario}). Check current evidence after reviewing the source memories.`;
    const item = {
      caseId: 'retained-case',
      project: 'threadnote',
      memoryId: 'a',
      family: 'semantic-contradiction',
      slot: 'pair',
      evidenceRevision: 'saved',
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
      evidenceRevision: 'saved',
      expectedContentHash: 'hash',
      reason: item.reason,
      choices: [],
      allowedOperations: [],
      instructions: 'Compare current statements.',
      semanticEvidence: evidence,
    };
    const adopted = vi.fn();
    let checks = 0;
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (EffectString.endsWith('/semantic/preview')(path))
        return response({preview: {...preview, choice: 'both', mode: 'keep-both'}});
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toMatchObject({
          action: 'refresh-case',
          project: 'threadnote',
          caseId: item.caseId,
        });
        checks++;
        return response({outcome: 'incomplete', reason});
      }
      return response(EffectString.includes('view=status')(path) ? maintenanceStatus([item]) : packet);
    });
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
      />
    );
    await act(async () => root.render(element(false)));
    await choose('both');
    await click('Preview my choice');
    adopted.mockClear();
    const card = host.querySelector('.semantic-memory-card');
    const body = host.querySelector('.detail-modal-body')!;
    body.scrollTop = 87;
    await act(async () => root.render(element(true)));
    expect(host.textContent).toContain(reason);
    expect(host.querySelector('.semantic-memory-card')).toBe(card);
    expect(body.scrollTop).toBe(87);
    expect(host.querySelector<HTMLInputElement>('input[value="both"]')!.checked).toBe(true);
    const confirm = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...host.querySelectorAll('button')],
        button => button.textContent === 'Confirm both apply',
      ),
    )!;
    expect(confirm.disabled).toBe(true);
    await click('Confirm both apply');
    expect(checks).toBe(1);
    expect(adopted).not.toHaveBeenCalled();
    expect(EffectArray.some(fetch.mock.calls, ([path]) => EffectString.endsWith('/semantic/apply')(path))).toBe(false);
    expect(host.textContent).not.toContain('no longer conflict');
  },
);
