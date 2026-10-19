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
    paragraphDispositions: {
      version: 1,
      entries: [
        {
          ordinal: 0,
          beforeHash: hash,
          disposition: 'update',
          supportHandles: [`current:${citationId}`],
          rationale: 'Source changed.',
        },
      ],
    },
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
let applyFailure = false;
let rejectTerminalPacket = false;
let generationRecovery: unknown;
let preparedAfterWrite = false;
let deferredReadGate: Promise<void> | undefined;
let previewGate: Promise<void> | undefined;
let generationGate: Promise<void> | undefined;
let packetFailure = false;
let mismatchedApplyDigest = false;
let inboxRefreshFailure = false;
let inboxReads = 0;
const posted: Record<string, unknown>[] = [];
beforeEach(() => {
  current = review();
  evidencePacket = packet;
  previewFailure = false;
  applyFailure = false;
  rejectTerminalPacket = false;
  generationRecovery = undefined;
  preparedAfterWrite = false;
  deferredReadGate = undefined;
  previewGate = undefined;
  generationGate = undefined;
  packetFailure = false;
  mismatchedApplyDigest = false;
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
      else if (url.pathname === '/api/attention/context-maintenance') {
        if (packetFailure)
          return new Response(
            JSON.stringify({
              error: 'The selected source evidence changed or is unavailable. Refresh maintenance and source access.',
            }),
            {status: 409},
          );
        if (rejectTerminalPacket && current.state === 'applied')
          return new Response(JSON.stringify({error: 'The subject case is stale after acceptance.'}), {
            status: 409,
            headers: {'content-type': 'application/json'},
          });
        result = evidencePacket;
      } else if (url.pathname === '/api/attention/topic-review' && init?.method === 'POST') {
        const action = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(action);
        if (action.action === 'generate' || action.action === 'regenerate') await generationGate;
        if ((action.action === 'generate' || action.action === 'regenerate') && generationRecovery)
          return new Response(
            JSON.stringify({
              error: 'This topic has a recoverable review conflict.',
              code: 'topic-draft-review-blocked',
              recovery: generationRecovery,
            }),
            {status: 409, headers: {'content-type': 'application/json'}},
          );
        if (action.action === 'preview' && previewFailure)
          return new Response(JSON.stringify({error: 'The source changed. Refresh this review.'}), {
            status: 409,
            headers: {'content-type': 'application/json'},
          });
        if (action.action === 'apply' && applyFailure)
          return new Response(JSON.stringify({error: 'The source changed. Refresh this review.'}), {
            status: 409,
            headers: {'content-type': 'application/json'},
          });
        if (action.action === 'preview') {
          await previewGate;
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
            approval: {
              ...current.approval!,
              stage: 'written',
              ...(mismatchedApplyDigest ? {approvalDigest: 'b'.repeat(64)} : {}),
            },
            warnings: preparedAfterWrite ? ['The approved document was already written.'] : [],
          });
        if (action.action === 'defer')
          current = review({...current, revision: current.revision + 1, state: 'deferred', canApply: false});
        if (action.action === 'resume')
          current = review({...current, revision: current.revision + 1, state: 'pending', canApply: false});
        if (action.action === 'reject')
          current = review({...current, revision: current.revision + 1, state: 'rejected', canApply: false});
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

it('keeps blockers prominent and technical review notes behind closed disclosures', async () => {
  current = review({
    blockingReason: 'Refresh the source evidence before accepting.',
    warnings: ['Advisory analyzer uncertainty: unsupported-extraction (1).'],
  });
  await render(
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  const disclosure = (label: string) =>
    [...document.querySelectorAll<HTMLDetailsElement>('details')].find(item =>
      item.querySelector('summary')?.textContent?.includes(label),
    );
  expect(disclosure('Generation details')?.open).toBe(false);
  expect(disclosure('Review notes')?.open).toBe(false);
  expect(disclosure('Review notes')?.textContent).toContain('unsupported-extraction');
  const blocker = [...document.querySelectorAll('[role="status"]')].find(item =>
    item.textContent?.includes('Refresh the source evidence before accepting.'),
  );
  expect(blocker).toBeTruthy();
  expect(blocker?.closest('details')).toBeNull();
  expect(document.querySelector('blockquote')?.textContent).toContain('Observed behavior.');
  expect(document.querySelector('textarea[aria-label="Proposed descriptive paragraph 1"]')).toHaveProperty(
    'value',
    'Updated behavior.',
  );
});

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
  const onClose = vi.fn();
  const onApplied = vi.fn();
  await render(
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      onChanged={() => undefined}
      onClose={onClose}
      onApplied={onApplied}
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
  expect(onClose).toHaveBeenCalledOnce();
  expect(onApplied).toHaveBeenCalledWith({
    project: 'threadnote',
    caseId: 'case-1',
    evidenceRevision: hash,
    targetUri: 'threadnote://memory/topic',
    targetHash: hash,
  });
});

it('shows primary generation progress for the pending request without starting another draft', async () => {
  const gate = Promise.withResolvers<void>();
  generationGate = gate.promise;
  evidencePacket = {...packet, reviewId: undefined};
  await render(
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  const generate = button('Generate draft');
  expect(generate.classList.contains('primary')).toBe(true);
  await act(async () => generate.click());
  expect(button('Generating draft…').disabled).toBe(true);
  expect(document.querySelector('.topic-review-progress[role="status"]')?.textContent).toContain(
    'Waiting for the model',
  );
  expect(document.querySelector('.topic-review-progress .spinner')).not.toBeNull();
  expect(posted).toHaveLength(1);
  await act(async () => gate.resolve());
  expect(document.querySelector('.topic-review-progress')).toBeNull();
  expect(document.body.textContent).toContain('Draft ready to review.');
  expect(posted).toHaveLength(1);
});

it('keeps a failed apply open and never acknowledges a resolved case', async () => {
  const onClose = vi.fn();
  const onApplied = vi.fn();
  await render(
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      onChanged={() => undefined}
      onClose={onClose}
      onApplied={onApplied}
      onOpenLibrary={() => undefined}
    />,
  );
  await click('Preview exact final document');
  applyFailure = true;
  await click('Accept update');
  expect(document.querySelector('dialog[open]')).not.toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('The source changed');
  expect(onClose).not.toHaveBeenCalled();
  expect(onApplied).not.toHaveBeenCalled();
  expect(button('Refresh evidence').disabled).toBe(false);
});

it('recovers a failed post-generation evidence read explicitly without another model request', async () => {
  const gate = Promise.withResolvers<void>();
  generationGate = gate.promise;
  evidencePacket = {...packet, reviewId: undefined};
  const onClose = vi.fn();
  await render(
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      onChanged={() => undefined}
      onClose={onClose}
      onOpenLibrary={() => undefined}
    />,
  );
  await act(async () => button('Generate draft').click());
  packetFailure = true;
  await act(async () => gate.resolve());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('selected source evidence changed');
  expect(document.querySelector('dialog[open]')).not.toBeNull();
  expect(button('Accept update').disabled).toBe(true);
  expect(posted.map(item => item.action)).toEqual(['generate']);
  packetFailure = false;
  await click('Refresh evidence');
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(button('Preview exact final document').disabled).toBe(false);
  expect(posted.map(item => item.action)).toEqual(['generate']);
  expect(onClose).not.toHaveBeenCalled();
});

it('refuses to close or clear a case when the returned written approval digest differs', async () => {
  const onClose = vi.fn();
  const onApplied = vi.fn();
  await render(
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      onChanged={() => undefined}
      onClose={onClose}
      onApplied={onApplied}
      onOpenLibrary={() => undefined}
    />,
  );
  await click('Preview exact final document');
  mismatchedApplyDigest = true;
  await click('Accept update');
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('does not match this exact approval');
  expect(onClose).not.toHaveBeenCalled();
  expect(onApplied).not.toHaveBeenCalled();
});

it('freezes paragraph decisions, text and support while an exact preview is pending', async () => {
  const gate = Promise.withResolvers<void>();
  previewGate = gate.promise;
  await render(
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  await click('Preview exact final document');
  const decision = document.querySelector<HTMLSelectElement>('select[aria-label="Review decision for paragraph 1"]')!;
  const editor = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Proposed descriptive paragraph 1"]',
  )!;
  const support = document.querySelector<HTMLFieldSetElement>('.topic-support-choices')!;
  expect(decision.disabled).toBe(true);
  expect(editor.disabled).toBe(true);
  expect(support.disabled).toBe(true);
  await act(async () => {
    decision.value = 'unresolved';
    decision.dispatchEvent(new Event('change', {bubbles: true}));
  });
  await act(async () => gate.resolve());
  expect(decision.value).toBe('update');
  expect(decision.disabled).toBe(false);
  expect(button('Accept update').disabled).toBe(false);
  await act(async () => {
    decision.value = 'unresolved';
    decision.dispatchEvent(new Event('change', {bubbles: true}));
  });
  expect(button('Accept update').disabled).toBe(true);
  expect(button('Preview exact final document').disabled).toBe(true);
  expect(posted.map(action => action.action)).toEqual(['preview']);
});

it.each(['model', 'manual'] as const)(
  'keeps contextual descriptive text read-only for %s reviews as appropriate',
  async origin => {
    current = review({
      generation: {...review().generation, origin},
      paragraphs: [
        ...review().paragraphs,
        {ordinal: 2, hash, role: 'descriptive', support: 'contextual', citationIds: [citationId]},
      ],
      acceptedBody: `${acceptedBody}\n\nContextual observation.`,
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
    const editor = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Proposed descriptive paragraph 3"]',
    );
    expect(Boolean(editor)).toBe(origin === 'manual');
    expect(document.body.textContent).toContain('Contextual observation.');
  },
);

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

it('retains a learned review identity after acceptance instead of reloading its stale subject case', async () => {
  rejectTerminalPacket = true;
  await render(
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      initialPacket={{...packet, reviewId: undefined}}
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  await click('Preview exact final document');
  await click('Accept update');
  await click('Refresh evidence');
  expect(current.state).toBe('applied');
  expect(document.body.textContent).toContain('Saved final document');
  expect(document.body.textContent).not.toContain('The subject case is stale after acceptance.');
  expect(document.body.textContent).not.toContain('Acceptance paused');
});

it('opens the exact blocked review for explicit recovery without generating or closing it automatically', async () => {
  const reviewId = `review-${'b'.repeat(24)}`;
  current = review({reviewId, state: 'conflict'});
  evidencePacket = {...packet, reviewId: undefined};
  generationRecovery = {action: 'open-review', reviewId, state: 'conflict'};
  await render(
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  await click('Generate draft');
  expect(posted.map(action => action.action)).toEqual(['generate']);
  expect(document.body.textContent).toContain('recoverable review conflict');
  await click('Open existing review');
  expect(button('Close conflicted review')).toBeTruthy();
  expect(posted.map(action => action.action)).toEqual(['generate']);
  await click('Close conflicted review');
  expect(posted[1]).toMatchObject({action: 'reject', reviewId, revision: 3, caseId: 'case-1'});
});

it('ignores a malformed review recovery selector', async () => {
  evidencePacket = {...packet, reviewId: undefined};
  generationRecovery = {action: 'open-review', reviewId: '../../another-review', state: 'conflict'};
  await render(
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  await click('Generate draft');
  expect(document.body.textContent).toContain('recoverable review conflict');
  expect(
    [...document.querySelectorAll('button')].some(item => item.textContent?.includes('Open existing review')),
  ).toBe(false);
});

it('finishes verification of a legacy already-written update through its exact saved approval', async () => {
  current = review({
    state: 'applying',
    revision: 5,
    canApply: false,
    canFinishVerification: true,
    draft: {...review().draft, paragraphDispositions: undefined},
    approval: {
      stage: 'prepared',
      reviewRevision: 4,
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
  expect(button('Finish saved update verification').disabled).toBe(false);
  await click('Finish saved update verification');
  expect(posted[0]).toMatchObject({action: 'apply', revision: 4, approvalDigest: hash, approved: true});
});

it('requires a new exact preview after an acceptance refusal even when a refresh returns the old approval', async () => {
  await render(
    <TopicReviewDialog
      project="threadnote"
      reviewId="review-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  await click('Preview exact final document');
  applyFailure = true;
  await click('Accept update');
  expect(button('Accept update').disabled).toBe(true);
  await click('Refresh evidence');
  expect(button('Accept update').disabled).toBe(true);
  expect(document.body.textContent).toContain('Previous exact preview');
  applyFailure = false;
  await click('Preview exact final document');
  expect(button('Accept update').disabled).toBe(false);
});

it('requires an explicit supported disposition for every eligible paragraph in a legacy model draft', async () => {
  current = review({
    draft: {...review().draft, paragraphDispositions: undefined},
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
  expect(button('Preview exact final document').disabled).toBe(true);
  expect(document.body.textContent).toContain('Paragraph review incomplete');
  const decision = document.querySelector<HTMLSelectElement>('select[aria-label="Review decision for paragraph 1"]')!;
  await act(async () => {
    decision.value = 'update';
    decision.dispatchEvent(new Event('change', {bubbles: true}));
  });
  expect(button('Preview exact final document').disabled).toBe(false);
  await click('Preview exact final document');
  expect(JSON.parse(String(posted[0].editedDraftJson)).paragraphDispositions.entries).toEqual([
    expect.objectContaining({
      ordinal: 0,
      beforeHash: hash,
      disposition: 'update',
      supportHandles: [`current:${citationId}`],
    }),
  ]);
});

it('keeps an unresolved paragraph blocked until its unchanged decision has explicit current support', async () => {
  current = review({
    draft: {
      ...review().draft,
      operations: [],
      outcome: 'insufficient-evidence',
      reviewedHandles: [],
      paragraphDispositions: {
        version: 1,
        entries: [
          {
            ordinal: 0,
            beforeHash: hash,
            disposition: 'unresolved',
            supportHandles: [],
            rationale: 'Needs manual review.',
          },
        ],
      },
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
  expect(button('Preview exact final document').disabled).toBe(true);
  const decision = document.querySelector<HTMLSelectElement>('select[aria-label="Review decision for paragraph 1"]')!;
  await act(async () => {
    decision.value = 'revalidate';
    decision.dispatchEvent(new Event('change', {bubbles: true}));
  });
  expect(button('Preview exact final document').disabled).toBe(true);
  const support = [...document.querySelectorAll('fieldset')]
    .find(item => item.querySelector('legend')?.textContent?.includes('paragraph 1'))!
    .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(support.checked).toBe(false);
  await act(async () => support.click());
  expect(button('Preview exact final document').disabled).toBe(false);
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
      paragraphDispositions: {
        version: 1,
        entries: [
          {
            ordinal: 0,
            beforeHash: hash,
            disposition: 'update',
            supportHandles: [`current:${citationId}`],
            rationale: 'First source changed.',
          },
          {
            ordinal: 1,
            beforeHash: hash,
            disposition: 'revalidate',
            supportHandles: [`current:${citationId}`],
            rationale: 'Second source still supports its text.',
          },
        ],
      },
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
  expect(document.body.textContent).not.toContain('This draft needs fresh evidence');
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
  expect(document.body.textContent).toContain('The source case is unavailable.');
  expect(document.body.textContent).not.toContain('This draft needs fresh evidence');
  expect(button('Preview exact final document').disabled).toBe(true);
  expect(button('Defer').disabled).toBe(false);
  await click('Defer');
  expect(posted[0]).toMatchObject({action: 'defer', caseId: 'case-1'});
  expect(button('Resume review').disabled).toBe(true);
});
