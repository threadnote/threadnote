// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ReviewsPanel} from '@threadnote/manager/attention-view';
import type {ManagerContextMaintenancePacketV2} from '@threadnote/manager/attention/contracts';
import type {ManagerTopicReviewV1} from '@threadnote/manager/attention/topic-contracts';
import {TopicReviewDialog} from '../../src/attention/topic_review.js';

const hash = 'a'.repeat(64);
const citationId = `tncc_${'1'.repeat(40)}`;
const acceptedBody = 'Observed behavior.\n\nPolicy requirement.';
const packet: ManagerContextMaintenancePacketV2 = {
  version: 2,
  project: 'threadnote',
  caseId: 'case-1',
  reviewId: 'review-1',
  family: 'topic-maintenance',
  slot: 'declared-support',
  memoryUri: 'threadnote://memory/topic',
  evidenceRevision: hash,
  expectedContentHash: hash,
  reason: 'source changed',
  choices: [],
  allowedOperations: [],
  instructions: '',
  coverage: 'declared-only',
  topicEvidence: {
    version: 1,
    outcome: 'ready',
    targetUri: 'threadnote://memory/topic',
    targetHash: hash,
    observationRevision: hash,
    coverage: 'declared-only',
    body: acceptedBody,
    paragraphs: [],
    additionalDependencies: [],
    sources: [],
  },
};
const review = (overrides: Partial<ManagerTopicReviewV1> = {}): ManagerTopicReviewV1 => ({
  version: 1,
  kind: 'topic-maintenance',
  project: 'threadnote',
  reviewId: 'review-1',
  revision: 3,
  state: 'pending',
  topic: 'Topic',
  caseId: 'case-1',
  targetUri: 'threadnote://memory/topic',
  targetHash: hash,
  observationRevision: hash,
  coverage: 'declared-only',
  caseObservationMatches: true,
  acceptedBody,
  generation: {origin: 'model', agent: 'local-ai', model: 'local-model', attempts: 1, usage: {status: 'unavailable'}},
  draft: {
    version: 1,
    targetHash: hash,
    observationRevision: hash,
    packetDigest: hash,
    outcome: 'propose-update',
    operations: [
      {
        ordinal: 0,
        beforeHash: hash,
        text: 'Updated behavior.',
        supportHandles: [`current:${citationId}`],
        rationale: 'Source changed.',
      },
    ],
    reviewedHandles: [`current:${citationId}`],
    rationale: 'Source changed.',
    unresolvedQuestions: [],
    removedClaims: [],
  },
  proposal: {body: 'Updated behavior.\n\nPolicy requirement.', finalBodyHash: hash, changedOrdinals: [0]},
  paragraphs: [
    {ordinal: 0, hash, role: 'descriptive', support: 'direct', citationIds: [citationId]},
    {ordinal: 1, hash, role: 'normative', support: 'unresolved', citationIds: []},
  ],
  additionalDependencies: [],
  support: [
    {
      handleId: `current:${citationId}`,
      citationId,
      variant: 'current',
      path: 'src/topic.ts',
      provenance: 'current-verified',
    },
  ],
  warnings: [],
  canApply: false,
  ...overrides,
});

let root: Root | undefined;
let current = review();
let evidencePacket = packet;
let previewFailure = false;
let preparedAfterWrite = false;
let deferredReadGate: Promise<void> | undefined;
let inboxRefreshFailure = false;
let inboxReads = 0;
const posted: Record<string, unknown>[] = [];
beforeEach(() => {
  current = review();
  evidencePacket = packet;
  previewFailure = false;
  preparedAfterWrite = false;
  deferredReadGate = undefined;
  inboxRefreshFailure = false;
  inboxReads = 0;
  posted.length = 0;
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://manager.test');
      let result: unknown;
      if (url.pathname === '/api/consolidation-models')
        result = {models: [{id: 'local-model', label: 'Local model', isDefault: true}]};
      else if (url.pathname === '/api/attention/context-maintenance') result = evidencePacket;
      else if (url.pathname === '/api/attention/topic-review' && init?.method === 'POST') {
        const action = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(action);
        if (action.action === 'preview' && previewFailure)
          return new Response(JSON.stringify({error: 'The source changed. Refresh this review.'}), {
            status: 409,
            headers: {'content-type': 'application/json'},
          });
        if (action.action === 'preview') {
          const draft = JSON.parse(String(action.editedDraftJson)) as ManagerTopicReviewV1['draft'];
          const paragraphs = current.acceptedBody.split(/\n\n/u);
          for (const operation of draft.operations) paragraphs[operation.ordinal] = operation.text;
          const body = paragraphs.join('\n\n');
          const revision = current.revision + 1;
          current = review({
            ...current,
            revision,
            canApply: true,
            draft,
            proposal: {
              body,
              finalBodyHash: hash,
              changedOrdinals: draft.operations.map(operation => operation.ordinal),
            },
            approval: {
              stage: 'preview',
              reviewRevision: revision,
              approvalDigest: hash,
              content: `# Topic\n\n${body}`,
              contentHash: hash,
              metadataDiff: [],
            },
          });
        }
        if (action.action === 'apply')
          current = review({
            revision: current.revision + 1,
            state: 'applied',
            canApply: false,
            approval: {...current.approval!, stage: 'written'},
            warnings: preparedAfterWrite ? ['The approved document was already written.'] : [],
          });
        if (action.action === 'defer')
          current = review({...current, revision: current.revision + 1, state: 'deferred', canApply: false});
        if (action.action === 'resume')
          current = review({...current, revision: current.revision + 1, state: 'pending', canApply: false});
        result = current;
      } else if (url.pathname === '/api/attention/topic-review') {
        if (current.state === 'deferred') await deferredReadGate;
        result = current;
      } else if (url.pathname === '/api/reviews') {
        inboxReads += 1;
        if (inboxRefreshFailure && inboxReads > 1)
          return new Response(JSON.stringify({error: 'Inbox refresh is unavailable.'}), {
            status: 503,
            headers: {'content-type': 'application/json'},
          });
        result = {
          version: 1,
          project: url.searchParams.get('project') ?? 'threadnote',
          pendingCount: 1,
          items: [
            {
              kind: 'topic-maintenance',
              project: 'threadnote',
              reviewId: 'review-1',
              revision: 3,
              topic: 'Topic',
              task: 'Review topic',
              createdAt: '2026-01-01',
              candidates: [
                {
                  candidateId: 'candidate-1',
                  state: 'pending',
                  recommendation: 'replace',
                  confidence: 0.7,
                  proposedText: 'Updated behavior.',
                  reason: 'Source changed.',
                },
              ],
            },
          ],
        };
      } else throw new Error(`Unexpected request ${url.pathname}`);
      return new Response(JSON.stringify(result), {status: 200, headers: {'content-type': 'application/json'}});
    }),
  );
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
}
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(label))!;
async function click(label: string) {
  await act(async () => button(label).click());
}
async function clickExact(label: string) {
  const target = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    item => item.textContent?.trim() === label,
  )!;
  await act(async () => target.click());
}
async function edit(ordinal: number, value: string) {
  const editor = document.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="Proposed descriptive paragraph ${ordinal + 1}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, value);
    editor.dispatchEvent(new Event('input', {bubbles: true}));
  });
}

it('previews a closed edited draft and applies only its exact revision and digest', async () => {
  await render(
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  expect(button('Accept update').disabled).toBe(true);
  expect(document.body.textContent).toContain('Policy requirement');
  await edit(0, 'Edited current behavior.');
  expect(button('Accept update').disabled).toBe(true);
  await click('Preview exact final document');
  expect(posted[0].action).toBe('preview');
  expect(JSON.parse(String(posted[0].editedDraftJson)).operations[0]).toMatchObject({
    ordinal: 0,
    text: 'Edited current behavior.',
  });
  expect(button('Accept update').disabled).toBe(false);
  await click('Accept update');
  expect(posted[1]).toMatchObject({
    action: 'apply',
    reviewId: 'review-1',
    revision: 4,
    approvalDigest: hash,
    approved: true,
  });
});

it.each(['threadnote', ''])('routes topic inbox items to their project from scope %s', async project => {
  await render(
    <ReviewsPanel
      project={project}
      projects={['threadnote']}
      refreshGeneration={0}
      onOpenLibrary={() => undefined}
      onProjectChange={() => undefined}
    />,
  );
  await click('Review and decide');
  expect(document.body.textContent).toContain('Review topic update');
  expect(document.body.textContent).not.toContain('Check the memory being replaced');
  expect(vi.mocked(globalThis.fetch).mock.calls.some(([input]) => String(input).includes('/api/reviews/preview'))).toBe(
    false,
  );
});

it('keeps an inbox review open through preview and shows its exact final document', async () => {
  await render(
    <ReviewsPanel
      project="threadnote"
      projects={['threadnote']}
      refreshGeneration={0}
      onOpenLibrary={() => undefined}
      onProjectChange={() => undefined}
    />,
  );
  const trigger = button('Review and decide');
  trigger.focus();
  await click('Review and decide');
  await click('Preview exact final document');
  expect(document.querySelector('dialog[open]')).toBeTruthy();
  expect(document.body.textContent).toContain('Exact final document to save');
  expect(document.body.textContent).toContain('Updated behavior.');
  expect(button('Accept update').disabled).toBe(false);
  await act(async () => {
    document.querySelector('dialog')!.dispatchEvent(new Event('cancel', {cancelable: true}));
  });
  expect(document.querySelector('dialog')).toBeNull();
  expect(document.activeElement).toBe(button('Review and decide'));
});

it('keeps a failed inbox preview visible for recovery', async () => {
  previewFailure = true;
  await render(
    <ReviewsPanel
      project="threadnote"
      projects={['threadnote']}
      refreshGeneration={0}
      onOpenLibrary={() => undefined}
      onProjectChange={() => undefined}
    />,
  );
  await click('Review and decide');
  await click('Preview exact final document');
  expect(document.querySelector('dialog[open]')).toBeTruthy();
  expect(document.body.textContent).toContain('The source changed. Refresh this review.');
});

it('retains the first edited paragraph while previewing a second edit', async () => {
  const accepted = 'First observed.\n\nSecond observed.\n\nPolicy requirement.';
  evidencePacket = {...packet, topicEvidence: {...packet.topicEvidence!, body: accepted}};
  current = review({
    acceptedBody: accepted,
    paragraphs: [
      {ordinal: 0, hash, role: 'descriptive', support: 'direct', citationIds: [citationId]},
      {ordinal: 1, hash, role: 'descriptive', support: 'direct', citationIds: [citationId]},
      {ordinal: 2, hash, role: 'normative', support: 'unresolved', citationIds: []},
    ],
    draft: {
      ...review().draft,
      operations: [
        {
          ordinal: 0,
          beforeHash: hash,
          text: 'First proposed.',
          supportHandles: [`current:${citationId}`],
          rationale: 'Source changed.',
        },
      ],
    },
  });
  const generatedDraft = current.draft;
  await render(
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  await edit(0, 'First edited.');
  await click('Preview exact final document');
  expect(current.draft.operations[0]?.text).toBe('First edited.');
  expect(generatedDraft.operations[0]?.text).toBe('First proposed.');
  await edit(1, 'Second edited.');
  expect(button('Accept update').disabled).toBe(true);
  await click('Preview exact final document');
  expect(
    (JSON.parse(String(posted[1].editedDraftJson)) as ManagerTopicReviewV1['draft']).operations.map(
      operation => operation.text,
    ),
  ).toEqual(['First edited.', 'Second edited.']);
  expect(document.body.textContent).toContain('First edited.');
  expect(document.body.textContent).toContain('Second edited.');
  expect(button('Accept update').disabled).toBe(false);
});

it.each([false, true])(
  'resumes a prepared approved update with exact saved approval fields (already written: %s)',
  async alreadyWritten => {
    preparedAfterWrite = alreadyWritten;
    evidencePacket = {
      ...packet,
      topicEvidence: {
        ...packet.topicEvidence!,
        outcome: 'unavailable',
        targetHash: 'b'.repeat(64),
        reason: 'source changed',
      },
    };
    current = review({
      revision: 5,
      state: 'applying',
      canApply: true,
      approval: {
        stage: 'prepared',
        reviewRevision: 4,
        approvalDigest: hash,
        content: '# Topic\n\nUpdated behavior.',
        contentHash: hash,
        metadataDiff: [],
      },
    });
    await render(
      <TopicReviewDialog
        project="threadnote"
        reviewId="review-1"
        onChanged={() => undefined}
        onClose={() => undefined}
        onOpenLibrary={() => undefined}
      />,
    );
    expect(button('Resume approved update').disabled).toBe(false);
    await click('Resume approved update');
    expect(posted[0]).toMatchObject({action: 'apply', revision: 4, approvalDigest: hash, approved: true});
    expect(document.body.textContent).toContain('The reviewed topic update was saved.');
  },
);

it('blocks acceptance when the source packet is unavailable even with a persisted preview', async () => {
  evidencePacket = {
    ...packet,
    topicEvidence: {...packet.topicEvidence!, outcome: 'unavailable', reason: 'source changed during review'},
  };
  current = review({
    canApply: true,
    approval: {
      stage: 'preview',
      reviewRevision: 3,
      approvalDigest: hash,
      content: '# Topic',
      contentHash: hash,
      metadataDiff: [],
    },
  });
  await render(
    <TopicReviewDialog
      project="threadnote"
      reviewId="review-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  expect(document.body.textContent).toContain('Current source evidence is unavailable');
  expect(button('Accept update').disabled).toBe(true);
});

it('persists defer and resume through the topic action route', async () => {
  await render(
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  await click('Defer');
  expect(posted[0]).toMatchObject({action: 'defer', reviewId: 'review-1', revision: 3});
  expect(button('Resume review')).toBeTruthy();
  await click('Resume review');
  expect(posted[1]).toMatchObject({action: 'resume', reviewId: 'review-1', revision: 4});
});

it('holds resume while the deferred revision reloads, then submits that revision', async () => {
  const gate = Promise.withResolvers<void>();
  deferredReadGate = gate.promise;
  await render(
    <TopicReviewDialog
      project="threadnote"
      reviewId="review-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  await click('Defer');
  expect(document.body.textContent).toContain('Review deferred.');
  expect(document.body.textContent).toContain('Loading topic and review…');
  expect(button('Resume review').disabled).toBe(true);
  await click('Resume review');
  expect(posted.map(action => action.action)).toEqual(['defer']);
  await act(async () => gate.resolve());
  expect(button('Resume review').disabled).toBe(false);
  await click('Resume review');
  expect(posted[1]).toMatchObject({action: 'resume', reviewId: 'review-1', revision: 4, caseId: 'case-1'});
  expect(document.body.textContent).toContain('Review resumed.');
});

it('keeps the edited draft through defer and resume, then requires a new exact preview', async () => {
  await render(
    <TopicReviewDialog
      project="threadnote"
      reviewId="review-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  await edit(0, 'Reviewed current behavior.');
  await click('Preview exact final document');
  expect(button('Accept update').disabled).toBe(false);
  await clickExact('Defer');
  expect(document.body.textContent).toContain('Reviewed current behavior.');
  await click('Resume review');
  expect(
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Proposed descriptive paragraph 1"]')?.value,
  ).toBe('Reviewed current behavior.');
  expect(button('Accept update').disabled).toBe(true);
  await click('Preview exact final document');
  expect(
    (JSON.parse(String(posted.at(-1)?.editedDraftJson)) as ManagerTopicReviewV1['draft']).operations[0]?.text,
  ).toBe('Reviewed current behavior.');
  expect(button('Accept update').disabled).toBe(false);
});

it('retains a completed decision and its dialog when the inbox refresh fails', async () => {
  await render(
    <ReviewsPanel
      project="threadnote"
      projects={['threadnote']}
      refreshGeneration={0}
      onOpenLibrary={() => undefined}
      onProjectChange={() => undefined}
    />,
  );
  await click('Review and decide');
  inboxRefreshFailure = true;
  await clickExact('Defer');
  expect(document.body.textContent).toContain('Review topic update');
  expect(document.querySelector('dialog[open]')).toBeTruthy();
  expect(document.body.textContent).toContain('Review deferred.');
  expect(document.body.textContent).toContain('Inbox refresh is unavailable.');
  expect(button('Resume review')).toBeTruthy();
});

it('allows closing a stale pending case while blocking preview and stale resume', async () => {
  current = review({caseObservationMatches: false});
  await render(
    <TopicReviewDialog
      project="threadnote"
      reviewId="review-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  expect(button('Preview exact final document').disabled).toBe(true);
  expect(button('Defer').disabled).toBe(false);
  await click('Defer');
  expect(posted[0]).toMatchObject({action: 'defer', caseId: 'case-1'});
  expect(button('Resume review').disabled).toBe(true);
});
