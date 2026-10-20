// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {MemoryObsidianEvidenceV1} from '@threadnote/memory/document';
import type {ManagerContextMaintenancePacketV2} from '../../src/attention/contracts.js';
import type {ManagerTopicReviewV1} from '../../src/attention/topic_contracts.js';
import {TopicReviewContent} from '../../src/attention/topic_review.js';
import {TopicEnrollmentPanel} from '../../src/attention/topic_enrollment.js';

const hash = 'a'.repeat(64);
const uri = 'threadnote://user/tester/memories/durable/projects/notes/decision.md';
const citation: MemoryObsidianEvidenceV1 = {
  version: 1,
  sourceId: 'notes',
  sourceInstanceId: '11111111-1111-4111-8111-111111111111',
  vaultHash: hash,
  accessHash: hash,
  noteId: '22222222-2222-4222-8222-222222222222',
  relativePath: 'Decision.md',
  revisionHash: hash,
  sanitizerVersion: 'scrubber-redact-v1',
  fragmentHash: hash,
  fragmentStart: 0,
  fragmentEnd: 12,
  pinId: '33333333-3333-4333-8333-333333333333',
  expiresAt: '2027-01-01T00:00:00.000Z',
};
const currentText = 'Intro.\n\n🙂 Exact supporting note.\nTrailing.';
function packet(reviewId?: string): ManagerContextMaintenancePacketV2 {
  return {
    version: 2,
    project: 'notes',
    caseId: 'case-note',
    ...(reviewId ? {reviewId} : {}),
    family: 'topic-maintenance',
    slot: 'declared-support',
    memoryUri: uri,
    evidenceRevision: hash,
    expectedContentHash: hash,
    reason: 'note changed',
    choices: [],
    allowedOperations: [],
    instructions: '',
    coverage: 'declared-only',
    topicEvidence: {
      version: 2,
      sourceKind: 'obsidian',
      outcome: 'ready',
      targetUri: uri,
      targetHash: hash,
      observationRevision: hash,
      coverage: 'declared-only',
      canDraft: false,
      body: 'Accepted private memory.',
      paragraphs: [],
      additionalDependencies: [],
      obsidian: {
        origin: {citation, historical: 'available', currentRevision: 'changed', fragment: 'Original private note.'},
        active: {citation, historical: 'available', currentRevision: 'changed', fragment: 'Accepted private note.'},
        current: {
          sourceId: citation.sourceId,
          sourceInstanceId: citation.sourceInstanceId,
          noteId: citation.noteId,
          relativePath: 'Renamed.md',
          revisionHash: hash,
          sanitizerVersion: citation.sanitizerVersion,
          accessHash: hash,
          vaultHash: hash,
          inspectionDigest: hash,
          content: currentText,
          startOffset: 0,
          endOffset: currentText.length,
          truncated: false,
        },
      },
    },
  };
}
const privateReview: ManagerTopicReviewV1 = {
  version: 1,
  kind: 'topic-maintenance',
  sourceKind: 'obsidian',
  project: 'notes',
  reviewId: 'review-note',
  revision: 2,
  state: 'pending',
  topic: 'Private note topic',
  caseId: 'case-note',
  caseObservationMatches: true,
  targetUri: uri,
  targetHash: hash,
  acceptedBody: 'Accepted private memory.',
  observationRevision: hash,
  coverage: 'declared-only',
  generation: {origin: 'manual', agent: 'user', model: 'manual', attempts: 1, usage: {status: 'unavailable'}},
  draft: {
    version: 1,
    targetHash: hash,
    observationRevision: hash,
    packetDigest: hash,
    outcome: 'propose-revalidation',
    operations: [],
    reviewedHandles: [],
    rationale: 'Checked note.',
    unresolvedQuestions: [],
    removedClaims: [],
  },
  proposal: {body: 'Proposed private memory.', finalBodyHash: hash, changedOrdinals: []},
  paragraphs: [{ordinal: 0, hash, role: 'historical', support: 'unresolved', citationIds: []}],
  additionalDependencies: [],
  support: [],
  warnings: [],
  approval: {
    stage: 'preview',
    reviewRevision: 2,
    approvalDigest: hash,
    content: 'Approved private full document.',
    contentHash: hash,
    metadataDiff: [],
  },
  canApply: true,
};
let root: Root;
let revoked: boolean;
let evidence: ManagerContextMaintenancePacketV2;
let captureGate: Promise<void> | undefined;
let readGate: Promise<void> | undefined;
let packetUnavailable: boolean;
let recoveryOnly: boolean;
let rejectedRecovery: boolean;
let rejectGate: Promise<void> | undefined;
const posted: Record<string, unknown>[] = [];
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  revoked = false;
  evidence = packet();
  captureGate = undefined;
  readGate = undefined;
  packetUnavailable = false;
  recoveryOnly = false;
  rejectedRecovery = false;
  rejectGate = undefined;
  posted.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://manager.test');
      if (url.pathname === '/api/consolidation-models')
        return response({models: [{id: 'model', label: 'Model', isDefault: true}]});
      if (url.pathname === '/api/attention/context-maintenance')
        return packetUnavailable ? response({error: 'Source evidence changed.'}, 409) : response(evidence);
      if (url.pathname === '/api/attention/topic-review' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(body);
        if (body.action === 'capture') {
          await captureGate;
          if (revoked) return response({error: 'Source access unavailable.'}, 409);
          if (evidence.topicEvidence?.version !== 2) throw new Error('Expected imported packet');
          evidence = {
            ...evidence,
            topicEvidence: {
              ...evidence.topicEvidence,
              canDraft: true,
              obsidian: {
                ...evidence.topicEvidence.obsidian,
                capture: {
                  reviewId: 'review-note',
                  revision: 1,
                  state: 'captured',
                  citation,
                  fragment: currentText.slice(Number(body.fragmentStart), Number(body.fragmentEnd)),
                },
              },
            },
          };
          return response(evidence);
        }
        if (body.action === 'reject' && recoveryOnly) {
          await rejectGate;
          rejectedRecovery = true;
          return response({
            version: 1,
            kind: 'topic-maintenance-recovery',
            project: 'notes',
            reviewId: 'review-note',
            revision: 3,
            caseId: 'case-note',
            state: 'rejected',
          });
        }
        return response(privateReview);
      }
      if (url.pathname === '/api/attention/topic-review' && url.searchParams.has('caseId'))
        return response({error: 'No qualified saved review for this case.'}, 404);
      if (url.pathname === '/api/attention/topic-review') {
        await readGate;
        if (recoveryOnly)
          return response({
            version: 1,
            kind: 'topic-maintenance-recovery',
            project: 'notes',
            reviewId: 'review-note',
            revision: rejectedRecovery ? 3 : 2,
            caseId: 'case-note',
            state: rejectedRecovery ? 'rejected' : 'pending',
            ...(rejectedRecovery ? {} : {recovery: {action: 'reject'}}),
          });
        return revoked ? response({error: 'Private review unavailable.'}, 404) : response(privateReview);
      }
      if (url.pathname === '/api/attention/topic-enrollment') {
        if (revoked) return response({error: 'Private source unavailable.'}, 409);
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          posted.push(body);
          return response(
            body.action === 'preview'
              ? {status: 'preview', body: 'Accepted private memory.', expectedContentHash: hash, revision: hash}
              : {status: 'enrolled', targetUri: uri},
          );
        }
        return response({
          status: 'not-enrolled',
          sourceKind: 'obsidian',
          targetUri: uri,
          project: 'notes',
          contentHash: hash,
          body: 'Accepted private memory.',
          paragraphs: ['Accepted private memory.', 'Keep this policy.'],
          citation: {id: 'tnob_test', relativePath: 'Decision.md'},
        });
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(text))!;
const renderReview = () =>
  act(async () =>
    root.render(
      <TopicReviewContent
        project="notes"
        caseId="case-note"
        onChanged={() => undefined}
        onOpenLibrary={() => undefined}
      />,
    ),
  );
async function selectExcerpt(start: number, end: number) {
  const editor = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Select current note excerpt"]')!;
  await act(async () => {
    editor.focus();
    editor.setSelectionRange(start, end);
    editor.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
    document.dispatchEvent(new Event('selectionchange'));
  });
}

it('requires an exact note selection and retention approval before capture and generation', async () => {
  await renderReview();
  expect(document.body.textContent).toContain('Private Obsidian note');
  expect(document.body.textContent).toContain('Original supporting excerpt');
  expect(document.body.textContent).toContain('Accepted supporting excerpt');
  expect(button('Generate draft').disabled).toBe(true);
  expect(button('Keep selected excerpt').disabled).toBe(true);
  const start = currentText.indexOf('🙂');
  const end = currentText.indexOf('\nTrailing');
  await selectExcerpt(start, end);
  expect(document.querySelector('[aria-label="Selected note excerpt"]')?.textContent).toBe(
    currentText.slice(start, end),
  );
  expect(button('Keep selected excerpt').disabled).toBe(true);
  await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(button('Keep selected excerpt').disabled).toBe(false);
  const gate = Promise.withResolvers<void>();
  captureGate = gate.promise;
  await act(async () => button('Keep selected excerpt').click());
  expect(button('Keep selected excerpt').disabled).toBe(true);
  expect(document.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
  await act(async () => gate.resolve());
  expect(posted).toEqual([
    expect.objectContaining({
      action: 'capture',
      project: 'notes',
      caseId: 'case-note',
      expectedContentHash: hash,
      observationRevision: hash,
      inspectionDigest: hash,
      fragmentStart: start,
      fragmentEnd: end,
      retentionDays: 90,
      approved: true,
    }),
  ]);
  expect(document.querySelector('[aria-label="Retained note excerpt"]')?.textContent).toBe(
    currentText.slice(start, end),
  );
  expect(button('Generate draft').disabled).toBe(false);
});

it('clears imported proposals, approvals and source excerpts immediately during a revoked refresh', async () => {
  evidence = packet('review-note');
  await renderReview();
  expect(document.body.textContent).toContain('Approved private full document.');
  expect(document.body.textContent).toContain('Proposed private memory.');
  const gate = Promise.withResolvers<void>();
  readGate = gate.promise;
  revoked = true;
  await act(async () => button('Refresh evidence').click());
  expect(document.body.textContent).not.toMatch(
    /Accepted private|Proposed private|Approved private|Original private|Private note topic/u,
  );
  await act(async () => gate.resolve());
  expect(document.body.textContent).toContain('Private review unavailable');
  expect(document.body.textContent).not.toMatch(/Accepted private|Proposed private|Approved private|Original private/u);
});

it('discards newly loaded private review text if the following evidence read fails', async () => {
  packetUnavailable = true;
  await act(async () =>
    root.render(
      <TopicReviewContent
        project="notes"
        reviewId="review-note"
        onChanged={() => undefined}
        onOpenLibrary={() => undefined}
      />,
    ),
  );
  expect(document.body.textContent).toContain('Source evidence changed.');
  expect(document.body.textContent).not.toMatch(
    /Accepted private|Proposed private|Approved private|Private note topic/u,
  );
});

it('offers only exact rejection recovery for a redacted imported review and accepts its redacted acknowledgement', async () => {
  recoveryOnly = true;
  await act(async () =>
    root.render(
      <TopicReviewContent
        project="notes"
        reviewId="review-note"
        onChanged={() => undefined}
        onOpenLibrary={() => undefined}
      />,
    ),
  );
  expect(button('Discard stale review')).toBeDefined();
  expect(document.body.textContent).not.toMatch(
    /Accepted private|Proposed private|Approved private|Original private|Generate draft|Accept update|Resume review/u,
  );
  const gate = Promise.withResolvers<void>();
  rejectGate = gate.promise;
  await act(async () => button('Discard stale review').click());
  expect(button('Discard stale review').disabled).toBe(true);
  await act(async () => button('Discard stale review').click());
  expect(posted).toHaveLength(1);
  await act(async () => gate.resolve());
  expect(posted).toEqual([
    {action: 'reject', project: 'notes', reviewId: 'review-note', revision: 2, caseId: 'case-note'},
  ]);
  expect(document.body.textContent).toContain('Review rejected.');
  expect(document.body.textContent).not.toMatch(/Accepted private|Proposed private|Approved private|Original private/u);
});

it('enrolls with explicit paragraph annotations and exact preview approval, then clears revoked inspection text', async () => {
  await act(async () => root.render(<TopicEnrollmentPanel uri={uri} />));
  await act(async () => {
    const details = document.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  expect(button('Preview topic enrollment').disabled).toBe(true);
  for (const select of document.querySelectorAll<HTMLSelectElement>('select')) {
    await act(async () => {
      select.value = select.getAttribute('aria-label')?.startsWith('Role') ? 'descriptive' : 'direct';
      select.dispatchEvent(new Event('change', {bubbles: true}));
    });
  }
  await act(async () => button('Preview topic enrollment').click());
  expect(posted[0]).toMatchObject({
    action: 'preview',
    project: 'notes',
    uri,
    input: {
      paragraphs: [
        {role: 'descriptive', support: 'direct', citationIds: ['tnob_test']},
        {role: 'descriptive', support: 'direct', citationIds: ['tnob_test']},
      ],
    },
  });
  await act(async () => button('Approve topic enrollment').click());
  expect(posted[1]).toMatchObject({action: 'apply', approved: true, expectedContentHash: hash, revision: hash});
  expect(document.body.textContent).toContain('This topic is enrolled.');
  revoked = true;
  await act(async () => button('Refresh source access').click());
  expect(document.body.textContent).not.toContain('Accepted private memory.');
  expect(document.body.textContent).not.toContain('Keep this policy.');
});
