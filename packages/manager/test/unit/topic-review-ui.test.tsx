import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ReviewsPanel} from '@threadnote/manager/attention-view';
import type {
  ManagerContextMaintenancePacketV2,
  ManagerContextMaintenanceStatusV2,
} from '@threadnote/manager/attention/contracts';
import type {ManagerTopicReviewV1} from '@threadnote/manager/attention/topic-contracts';
import {TopicReviewDialog} from '../../src/attention/topic_review.js';
import {MaintenanceCaseDialog} from '../../src/attention/maintenance_dialogs.js';
import {
  Array as EffectArray,
  Predicate,
  String as EffectString,
  pipe as EffectPipe,
  Option as EffectOption,
} from 'effect';

function parseTopicReviewAction(value: unknown): Record<string, unknown> {
  if (!Predicate.isObject(value) || typeof value.action !== 'string')
    throw new Error('Expected a topic review action with a string action name.');
  return value;
}

function parseEditedTopicDraft(value: unknown, baseline: ManagerTopicReviewV1['draft']): ManagerTopicReviewV1['draft'] {
  if (!Predicate.isObject(value) || !EffectArray.isArray(value.operations))
    throw new Error('Expected the edited topic draft to retain an operation list.');
  const seenOrdinals = new Set<number>();
  const operations = EffectArray.map(value.operations, operation => {
    if (
      !Predicate.isObject(operation) ||
      typeof operation.ordinal !== 'number' ||
      !Number.isSafeInteger(operation.ordinal) ||
      typeof operation.beforeHash !== 'string' ||
      typeof operation.text !== 'string' ||
      !EffectArray.isArray(operation.supportHandles) ||
      !EffectArray.every(operation.supportHandles, handle => typeof handle === 'string') ||
      typeof operation.rationale !== 'string'
    )
      throw new Error('Expected edited topic operations to retain their typed fields.');
    if (seenOrdinals.has(operation.ordinal)) throw new Error('Expected edited topic operation ordinals to be unique.');
    seenOrdinals.add(operation.ordinal);
    const disposition = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        baseline.paragraphDispositions?.entries ?? [],
        candidate => candidate.ordinal === operation.ordinal,
      ),
    );
    const original = EffectOption.getOrUndefined(
      EffectArray.findFirst(baseline.operations, candidate => candidate.ordinal === operation.ordinal),
    );
    if (disposition === undefined && original === undefined)
      throw new Error('Edited topic operation is outside the source draft.');
    const expected = original ?? {
      ordinal: operation.ordinal,
      beforeHash: disposition!.beforeHash,
      supportHandles: disposition!.supportHandles,
      rationale: disposition!.rationale,
      text: operation.text,
    };
    if (operation.beforeHash !== expected.beforeHash)
      throw new Error('Edited topic operation changed its source identity.');
    return {
      ...expected,
      rationale: operation.rationale,
      supportHandles: operation.supportHandles,
      text: operation.text,
    };
  });
  if (seenOrdinals.size !== operations.length)
    throw new Error('Expected edited topic operation ordinals to be unique.');
  return {...baseline, operations};
}

function parseEditedTopicOperationTexts(value: unknown): string[] {
  if (!Predicate.isObject(value) || !EffectArray.isArray(value.operations))
    throw new Error('Expected a topic draft with an operation list.');
  return EffectArray.map(value.operations, operation => {
    if (!Predicate.isObject(operation) || typeof operation.text !== 'string')
      throw new Error('Expected a topic draft operation with text.');
    return operation.text;
  });
}

const maintenanceStatus = (cases: ManagerContextMaintenanceStatusV2['cases']): ManagerContextMaintenanceStatusV2 => ({
  version: 2,
  state: 'idle',
  generation: 'fixture-generation',
  paused: false,
  projects: [],
  cases,
  receipts: [],
});
const hash = EffectPipe('a', EffectString.repeat(64));
const citationId = `tncc_${EffectPipe('1', EffectString.repeat(40))}`;
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
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
        if (init?.method === 'POST')
          return new Response(
            JSON.stringify(
              packetFailure
                ? {outcome: 'unavailable', reason: 'Source evidence is unavailable.'}
                : {
                    outcome: 'ready',
                    item: {
                      caseId: packet.caseId,
                      project: packet.project,
                      memoryId: 'memory-1',
                      family: packet.family,
                      slot: packet.slot,
                      evidenceRevision: evidencePacket.evidenceRevision,
                      disposition: 'needs-decision',
                      reason: packet.reason,
                      firstSeen: 'now',
                      lastSeen: 'now',
                      lastChecked: 'now',
                      attemptCount: 1,
                      events: [],
                    },
                    packet: evidencePacket,
                  },
            ),
          );
        if (url.searchParams.get('view') === 'status') {
          if (packet.family === undefined || packet.slot === undefined)
            throw new Error('The topic maintenance packet fixture must retain its case family and slot.');
          return new Response(
            JSON.stringify(
              maintenanceStatus([
                {
                  caseId: packet.caseId,
                  project: packet.project,
                  memoryId: 'memory-1',
                  family: packet.family,
                  slot: packet.slot,
                  evidenceRevision: evidencePacket.evidenceRevision,
                  disposition: 'needs-decision',
                  reason: packet.reason,
                  firstSeen: 'now',
                  lastSeen: 'now',
                  lastChecked: 'now',
                  attemptCount: 1,
                  events: [],
                },
              ]),
            ),
            {status: 200, headers: {'content-type': 'application/json'}},
          );
        }
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
        const action = parseTopicReviewAction(JSON.parse(String(init.body)));
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
          const draft = parseEditedTopicDraft(JSON.parse(String(action.editedDraftJson)), current.draft);
          const paragraphs = EffectPipe(current.acceptedBody, EffectString.split(/\n\n/u));
          for (const operation of draft.operations) paragraphs[operation.ordinal] = operation.text;
          const body = EffectArray.join(paragraphs, '\n\n');
          const revision = current.revision + 1;
          current = review({
            ...current,
            revision,
            canApply: true,
            draft,
            proposal: {
              body,
              finalBodyHash: hash,
              changedOrdinals: EffectArray.map(draft.operations, operation => operation.ordinal),
            },
            approval: {
              stage: 'preview',
              reviewRevision: revision,
              approvalDigest: hash,
              content: `MEMORY\nkind: durable\nmemory_id: tn_preview_fixture\n\n# Topic\n\n${body}`,
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
              ...(mismatchedApplyDigest ? {approvalDigest: EffectPipe('b', EffectString.repeat(64))} : {}),
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
      } else if (url.pathname === '/api/attention/topic-review' && url.searchParams.has('caseId')) {
        return new Response(JSON.stringify({error: 'No qualified saved review for this case.'}), {
          status: 404,
          headers: {'content-type': 'application/json'},
        });
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
                  categories: ['decision'],
                  comparison: 'new',
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
  vi.useRealTimers();
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
  EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll<HTMLButtonElement>('button')],
      __effectArrayValue =>
        !!(item =>
          EffectPipe(item.textContent, effectOptionalString =>
            effectOptionalString == null ? undefined : EffectPipe(effectOptionalString, EffectString.includes(label)),
          ) ?? false)(__effectArrayValue),
    ),
  )!;

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
    EffectOption.getOrUndefined(
      EffectArray.findFirst(
        [...document.querySelectorAll<HTMLDetailsElement>('details')],
        __effectArrayValue =>
          !!(item =>
            EffectPipe(item.querySelector('summary')?.textContent, effectOptionalString =>
              effectOptionalString == null ? undefined : EffectPipe(effectOptionalString, EffectString.includes(label)),
            ))(__effectArrayValue),
      ),
    );
  expect(disclosure('Generation details')?.open).toBe(false);
  expect(disclosure('Review notes')?.open).toBe(false);
  expect(disclosure('Review notes')?.textContent).toContain('unsupported-extraction');
  const blocker = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll('[role="status"]')],
      __effectArrayValue =>
        !!(item =>
          EffectPipe(item.textContent, effectOptionalString =>
            effectOptionalString == null
              ? undefined
              : EffectPipe(
                  effectOptionalString,
                  EffectString.includes('Refresh the source evidence before accepting.'),
                ),
          ))(__effectArrayValue),
    ),
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
  const target = EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll<HTMLButtonElement>('button')],
      item =>
        EffectPipe(item.textContent, effectOptionalString =>
          effectOptionalString == null ? undefined : EffectPipe(effectOptionalString, EffectString.trim),
        ) === label,
    ),
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

it('retains a dirty topic draft through unchanged evidence revalidation and freezes changed evidence', async () => {
  const dialog = (stale: boolean) => (
    <MaintenanceCaseDialog
      project="threadnote"
      caseId="case-1"
      stale={stale}
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
      onTask={() => undefined}
    />
  );
  await render(dialog(false));
  await edit(0, 'Dirty current behavior.');
  const editor = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Proposed descriptive paragraph 1"]');
  expect(editor?.value).toBe('Dirty current behavior.');
  await act(async () => root?.render(dialog(true)));
  await act(async () => root?.render(dialog(false)));
  expect(button('Save draft').disabled).toBe(false);
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Proposed descriptive paragraph 1"]')).toBe(
    editor,
  );
  expect(editor?.value).toBe('Dirty current behavior.');
  evidencePacket = {
    ...packet,
    evidenceRevision: 'changed-revision',
    topicEvidence: {...packet.topicEvidence!, observationRevision: 'changed-source'},
  };
  await act(async () => root?.render(dialog(true)));
  await act(async () => root?.render(dialog(false)));
  expect(
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Proposed descriptive paragraph 1"]')?.value,
  ).toBe('Dirty current behavior.');
  expect(button('Save draft')?.disabled ?? true).toBe(true);
  expect(EffectArray.map(posted, action => action.action)).toEqual(['preview']);
  packetFailure = true;
  await act(async () => root?.render(dialog(true)));
  expect(document.body.textContent).not.toContain('Dirty current behavior.');
  expect(button('Save draft')?.disabled ?? true).toBe(true);
});

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
  expect(button('Apply update').disabled).toBe(false);
  expect(document.body.textContent).toContain('Policy requirement');
  await edit(0, 'Edited current behavior.');
  expect(button('Apply update').disabled).toBe(true);
  await click('Save draft');
  expect(posted[1].action).toBe('preview');
  expect(JSON.parse(String(posted[1].editedDraftJson)).operations[0]).toMatchObject({
    ordinal: 0,
    text: 'Edited current behavior.',
  });
  expect(button('Apply update').disabled).toBe(false);
  await click('Apply update');
  expect(posted[2]).toMatchObject({
    action: 'apply',
    reviewId: 'review-1',
    revision: 5,
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
  expect(document.body.textContent).toContain('Exact final document prepared for review.');
  expect(EffectArray.map(posted, action => action.action)).toEqual(['generate', 'preview']);
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
  applyFailure = true;
  await click('Apply update');
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
  expect(button('Apply update').disabled).toBe(true);
  expect(EffectArray.map(posted, item => item.action)).toEqual(['generate']);
  packetFailure = false;
  await click('Refresh evidence');
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(button('Apply update').disabled).toBe(false);
  expect(EffectArray.map(posted, item => item.action)).toEqual(['generate', 'preview']);
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
  mismatchedApplyDigest = true;
  await click('Apply update');
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
  expect(button('Apply update').disabled).toBe(false);
  await act(async () => {
    decision.value = 'unresolved';
    decision.dispatchEvent(new Event('change', {bubbles: true}));
  });
  expect(button('Save draft')?.disabled ?? true).toBe(true);
  expect(button('Apply update').disabled).toBe(true);
  expect(EffectArray.map(posted, action => action.action)).toEqual(['preview']);
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
  expect(
    EffectArray.some(vi.mocked(globalThis.fetch).mock.calls, ([input]) =>
      EffectPipe(String(input), EffectString.includes('/api/reviews/preview')),
    ),
  ).toBe(false);
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
  expect(document.querySelector('dialog[open]')).toBeTruthy();
  expect(document.body.textContent).toContain('Exact final document to save');
  expect(document.body.textContent).toContain('Updated behavior.');
  const finalDocument = document.querySelector('[aria-label="Exact final document"]')!;
  expect(finalDocument.querySelector('article')?.textContent).toContain('Updated behavior.');
  expect(finalDocument.querySelector('article')?.textContent).not.toContain('memory_id:');
  expect(finalDocument.querySelector('details')?.open).toBe(false);
  expect(finalDocument.querySelector('details pre')?.textContent).toBe(current.approval?.content);
  expect(button('Apply update').disabled).toBe(false);
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
  await click('Apply update');
  await click('Refresh evidence');
  expect(current.state).toBe('applied');
  expect(document.body.textContent).toContain('Saved final document');
  expect(document.body.textContent).not.toContain('The subject case is stale after acceptance.');
  expect(document.body.textContent).not.toContain('Acceptance paused');
});

it('opens the exact blocked review for explicit recovery without generating or closing it automatically', async () => {
  const reviewId = `review-${EffectPipe('b', EffectString.repeat(24))}`;
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
  expect(EffectArray.map(posted, action => action.action)).toEqual(['generate']);
  expect(document.body.textContent).toContain('recoverable review conflict');
  await click('Open existing review');
  expect(button('Close conflicted review')).toBeTruthy();
  expect(EffectArray.map(posted, action => action.action)).toEqual(['generate']);
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
    EffectArray.some(
      [...document.querySelectorAll('button')],
      item =>
        EffectPipe(item.textContent, effectOptionalString =>
          effectOptionalString == null
            ? undefined
            : EffectPipe(effectOptionalString, EffectString.includes('Open existing review')),
        ) ?? false,
    ),
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
  applyFailure = true;
  await click('Apply update');
  expect(button('Apply update').disabled).toBe(true);
  await click('Refresh evidence');
  expect(button('Apply update').disabled).toBe(true);
  expect(document.body.textContent).toContain('Previous exact preview');
  applyFailure = false;
  await click('Retry preparing document');
  expect(button('Apply update').disabled).toBe(false);
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
  expect(button('Save draft')?.disabled ?? true).toBe(true);
  expect(document.body.textContent).toContain('Paragraph review incomplete');
  const decision = document.querySelector<HTMLSelectElement>('select[aria-label="Review decision for paragraph 1"]')!;
  await act(async () => {
    decision.value = 'update';
    decision.dispatchEvent(new Event('change', {bubbles: true}));
  });
  expect(button('Save draft').disabled).toBe(false);
  await click('Save draft');
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
  expect(button('Save draft')?.disabled ?? true).toBe(true);
  const decision = document.querySelector<HTMLSelectElement>('select[aria-label="Review decision for paragraph 1"]')!;
  await act(async () => {
    decision.value = 'revalidate';
    decision.dispatchEvent(new Event('change', {bubbles: true}));
  });
  expect(button('Save draft')?.disabled ?? true).toBe(true);
  let supportField: HTMLFieldSetElement | undefined;
  for (const fieldset of document.querySelectorAll<HTMLFieldSetElement>('fieldset')) {
    const label = fieldset.querySelector('legend')?.textContent ?? '';
    if (EffectString.includes('paragraph 1')(label)) {
      supportField = fieldset;
      break;
    }
  }
  const support = supportField?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!support) throw new Error('Expected the paragraph support checkbox.');
  expect(support.checked).toBe(false);
  await act(async () => support.click());
  expect(button('Save draft').disabled).toBe(false);
  expect(button('Apply update').disabled).toBe(true);
  expect(posted).toHaveLength(0);
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
  await click('Save draft');
  expect(current.draft.operations[0]?.text).toBe('First edited.');
  expect(generatedDraft.operations[0]?.text).toBe('First proposed.');
  await edit(1, 'Second edited.');
  expect(button('Apply update').disabled).toBe(true);
  await click('Save draft');
  expect(parseEditedTopicOperationTexts(JSON.parse(String(posted[2].editedDraftJson)))).toEqual([
    'First edited.',
    'Second edited.',
  ]);
  expect(document.body.textContent).toContain('First edited.');
  expect(document.body.textContent).toContain('Second edited.');
  expect(button('Apply update').disabled).toBe(false);
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
        targetHash: EffectPipe('b', EffectString.repeat(64)),
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
  expect(button('Apply update').disabled).toBe(true);
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
  expect(posted[1]).toMatchObject({action: 'defer', reviewId: 'review-1', revision: 4});
  expect(button('Resume review')).toBeTruthy();
  await click('Resume review');
  expect(posted[2]).toMatchObject({action: 'resume', reviewId: 'review-1', revision: 5});
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
  expect(EffectArray.map(posted, action => action.action)).toEqual(['preview', 'defer']);
  await act(async () => gate.resolve());
  expect(button('Resume review').disabled).toBe(false);
  await click('Resume review');
  expect(posted[2]).toMatchObject({action: 'resume', reviewId: 'review-1', revision: 5, caseId: 'case-1'});
  expect(document.body.textContent).toContain('Exact final document prepared for review.');
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
  await click('Save draft');
  expect(button('Apply update').disabled).toBe(false);
  await clickExact('Defer');
  expect(document.body.textContent).toContain('Reviewed current behavior.');
  await click('Resume review');
  expect(
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Proposed descriptive paragraph 1"]')?.value,
  ).toBe('Reviewed current behavior.');
  expect(button('Apply update').disabled).toBe(false);
  expect(parseEditedTopicOperationTexts(JSON.parse(String(posted.at(-1)?.editedDraftJson)))[0]).toBe(
    'Reviewed current behavior.',
  );
  expect(button('Apply update').disabled).toBe(false);
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
  expect(document.body.textContent).not.toContain('The source case is unavailable.');
  expect(document.body.textContent).toContain('This draft needs fresh evidence');
  expect(button('Save draft')?.disabled ?? true).toBe(true);
  expect(button('Defer').disabled).toBe(false);
  await click('Defer');
  expect(posted[0]).toMatchObject({action: 'defer', caseId: 'case-1'});
  expect(button('Resume review').disabled).toBe(true);
});

function privatePacket(outcome: 'ready' | 'unavailable'): ManagerContextMaintenancePacketV2 {
  return {
    ...packet,
    reviewId: undefined,
    evidenceRevision: outcome === 'ready' ? 'authorized' : 'revoked',
    topicEvidence: {
      version: 2,
      sourceKind: 'obsidian',
      outcome,
      targetUri: packet.memoryUri!,
      targetHash: hash,
      observationRevision: outcome,
      coverage: 'declared-only',
      canDraft: outcome === 'ready',
      ...(outcome === 'ready'
        ? {
            body: 'Private accepted prose.',
            paragraphs: [],
            obsidian: {
              current: {
                sourceId: 'source',
                sourceInstanceId: 'instance',
                noteId: 'note',
                relativePath: 'private.md',
                revisionHash: hash,
                sanitizerVersion: 'v1',
                accessHash: hash,
                vaultHash: hash,
                inspectionDigest: hash,
                content: 'Private imported excerpt.',
                startOffset: 0 as const,
                endOffset: 25,
                truncated: false,
              },
            },
          }
        : {reason: 'Source access was revoked.', obsidian: {}}),
      additionalDependencies: [],
    },
  };
}

it('adopts an unavailable imported observation without a generated review and discards old private text', async () => {
  let selected = privatePacket('ready');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      EffectString.startsWith('/api/consolidation-models')(input)
        ? new Response(JSON.stringify({models: []}))
        : EffectString.startsWith('/api/attention/topic-review')(input)
          ? new Response(JSON.stringify({error: 'No saved review.'}), {status: 404})
          : new Response(JSON.stringify(selected)),
    ),
  );
  const element = () => (
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      initialPacket={selected}
      onChanged={() => {}}
      onClose={() => {}}
      onOpenLibrary={() => {}}
    />
  );
  await render(element());
  expect(document.body.textContent).toContain('Private imported excerpt.');
  selected = privatePacket('unavailable');
  await act(async () => root?.render(element()));
  expect(document.body.textContent).not.toContain('Private imported excerpt.');
  expect(document.body.textContent).not.toContain('Private accepted prose.');
  expect(document.body.textContent).toContain('Source access was revoked.');
  expect(
    EffectArray.some([...document.querySelectorAll('button')], value =>
      Boolean(
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(value.textContent), EffectString.includes('Apply update')),
        ),
      ),
    ),
  ).toBe(false);
});

it.each(['unavailable', 'not-ready', '403'] as const)(
  'redacts a mounted imported topic after parent refresh returns %s with no generated review',
  async failure => {
    const selected = privatePacket('ready');
    const item = {
      caseId: 'case-1',
      project: 'threadnote',
      memoryId: 'memory-1',
      subjectUri: packet.memoryUri,
      family: 'topic-maintenance',
      slot: 'declared-support',
      evidenceRevision: 'authorized',
      disposition: 'needs-decision' as const,
      reason: 'source-changed',
      firstSeen: 'now',
      lastSeen: 'now',
      lastChecked: 'now',
      attemptCount: 1,
      events: [],
    };
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (EffectString.startsWith('/api/consolidation-models')(input))
        return new Response(JSON.stringify({models: []}));
      if (EffectString.startsWith('/api/attention/topic-review')(input))
        return new Response(JSON.stringify({error: 'No saved review.'}), {status: 404});
      if (init?.method === 'POST')
        return failure === '403'
          ? new Response(JSON.stringify({error: 'Source access was revoked.'}), {status: 403})
          : new Response(
              JSON.stringify(
                failure === 'not-ready'
                  ? {outcome: 'unavailable', reason: 'Source access was revoked.'}
                  : {
                      outcome: 'ready',
                      item: {...item, disposition: 'waiting-evidence'},
                      packet: privatePacket('unavailable'),
                    },
              ),
            );
      return new Response(
        JSON.stringify(EffectString.includes('view=status')(input) ? maintenanceStatus([item]) : selected),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const element = (stale: boolean) => (
      <MaintenanceCaseDialog
        project="threadnote"
        caseId="case-1"
        memoryUri={packet.memoryUri}
        initialCase={item}
        stale={stale}
        onTask={() => {}}
        onClose={() => {}}
        onOpenLibrary={() => {}}
      />
    );
    await render(element(false));
    expect(document.body.textContent).toContain('Private imported excerpt.');
    await act(async () => root?.render(element(true)));
    expect(document.body.textContent).not.toContain('Private imported excerpt.');
    expect(document.body.textContent).not.toContain('Private accepted prose.');
    expect(
      EffectArray.every(
        EffectArray.filter(fetch.mock.calls, ([, init]) => init?.method === 'POST'),
        ([, init]) => JSON.parse(String(init?.body)).action === 'refresh-case',
      ),
    ).toBe(true);
  },
);

it('adopts the exact refreshed code-topic observation without a generated review', async () => {
  const citation = createMemoryCodeCitation({
    version: 1,
    repositoryId: EffectString.repeat(64)('b'),
    repositoryIdentityKind: 'local',
    sourceCommit: EffectString.repeat(40)('c'),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${EffectString.repeat(40)('d')}`,
    extractorSet: 'test',
    path: 'source.ts',
    fileContentHash: {algorithm: 'sha256', value: hash},
    target: {kind: 'file'},
  });
  const excerpt = (content: string) => ({
    content,
    startLine: 1,
    endLine: 1,
    excerptHash: hash,
    fileBytesHash: hash,
    provenance: 'current-verified' as const,
    supportsCitation: false,
    truncated: false,
    source: {
      extractorSet: 'test',
      fileContentHash: hash,
      path: 'source.ts',
      repositoryId: EffectString.repeat(64)('b'),
      sourceCommit: EffectString.repeat(40)('c'),
      sourceDirty: false,
      sourceSnapshotId: `cgsn_${EffectString.repeat(40)('d')}`,
    },
  });
  const initial: ManagerContextMaintenancePacketV2 = {
    ...packet,
    reviewId: undefined,
    topicEvidence: {
      ...packet.topicEvidence!,
      version: 1,
      sources: [
        {
          citationId: citation.id,
          status: 'changed',
          original: citation,
          current: citation,
          oldExcerpt: excerpt('Original source.'),
          newExcerpt: excerpt('Previously observed source.'),
        },
      ],
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) =>
      EffectString.startsWith('/api/consolidation-models')(input)
        ? new Response(JSON.stringify({models: []}))
        : EffectString.startsWith('/api/attention/topic-review')(input)
          ? new Response(JSON.stringify({error: 'No saved review.'}), {status: 404})
          : new Response(JSON.stringify(initial)),
    ),
  );
  const element = (selected: ManagerContextMaintenancePacketV2) => (
    <TopicReviewDialog
      project="threadnote"
      caseId="case-1"
      initialPacket={selected}
      onChanged={() => {}}
      onClose={() => {}}
      onOpenLibrary={() => {}}
    />
  );
  await render(element(initial));
  expect(document.body.textContent).toContain('Previously observed source.');
  const refreshed = {
    ...initial,
    evidenceRevision: 'fresh-observation',
    topicEvidence: {
      ...initial.topicEvidence!,
      version: 1 as const,
      sources: [
        {
          citationId: citation.id,
          status: 'changed' as const,
          original: citation,
          current: citation,
          oldExcerpt: excerpt('Original source.'),
          newExcerpt: excerpt('Freshly observed source.'),
        },
      ],
      observationRevision: 'fresh-observation',
    },
  };
  await act(async () => root?.render(element(refreshed)));
  expect(document.body.textContent).toContain('Freshly observed source.');
  expect(document.body.textContent).not.toContain('Previously observed source.');
});

it('refreshes the selected topic observation from the visible control without a parent stale transition', async () => {
  const item = {
    caseId: 'case-1',
    project: 'threadnote',
    memoryId: 'memory-1',
    subjectUri: packet.memoryUri,
    family: 'topic-maintenance',
    slot: 'declared-support',
    evidenceRevision: 'old',
    disposition: 'needs-decision' as const,
    reason: 'source-changed',
    firstSeen: 'now',
    lastSeen: 'now',
    lastChecked: 'now',
    attemptCount: 1,
    events: [],
  };
  let changed = false;
  let refreshed = false;
  const fresh: ManagerContextMaintenancePacketV2 = {
    ...packet,
    reviewId: undefined,
    evidenceRevision: 'fresh',
    topicEvidence: {
      ...packet.topicEvidence!,
      outcome: 'unavailable',
      reason: 'Fresh selected source could not be verified.',
      observationRevision: 'fresh',
    },
  };
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    if (EffectString.startsWith('/api/consolidation-models')(input)) return new Response(JSON.stringify({models: []}));
    if (EffectString.startsWith('/api/attention/topic-review')(input))
      return new Response(JSON.stringify({error: 'No saved review.'}), {status: 404});
    if (init?.method === 'POST') {
      refreshed = true;
      expect(JSON.parse(String(init.body))).toMatchObject({
        action: 'refresh-case',
        project: 'threadnote',
        caseId: item.caseId,
      });
      return new Response(
        JSON.stringify({outcome: 'ready', item: {...item, evidenceRevision: 'fresh'}, packet: fresh}),
      );
    }
    if (EffectString.includes('view=status')(input)) return new Response(JSON.stringify(maintenanceStatus([item])));
    return changed && !refreshed
      ? new Response(JSON.stringify({error: 'Saved source observation is stale.'}), {status: 409})
      : new Response(JSON.stringify(refreshed ? fresh : {...packet, reviewId: undefined}));
  });
  vi.stubGlobal('fetch', fetch);
  await render(
    <MaintenanceCaseDialog
      project="threadnote"
      caseId={item.caseId}
      memoryUri={packet.memoryUri}
      initialCase={item}
      stale={false}
      onChanged={() => {}}
      onClose={() => {}}
      onOpenLibrary={() => {}}
      onTask={() => {}}
    />,
  );
  changed = true;
  await click('Refresh evidence');
  expect(refreshed).toBe(true);
  expect(document.body.textContent).toContain('Fresh selected source could not be verified.');
  expect(document.body.textContent).not.toContain('Saved source observation is stale.');
  expect(EffectArray.filter(fetch.mock.calls, ([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it.each(['reviews', 'case'] as const)(
  'adopts fresh selected evidence for a stale draft through the %s entry',
  async entry => {
    if (entry === 'reviews') {
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
    } else
      await render(
        <TopicReviewDialog
          project="threadnote"
          caseId="case-1"
          reviewId="review-1"
          onChanged={() => undefined}
          onClose={() => undefined}
          onOpenLibrary={() => undefined}
        />,
      );
    current = review({...current, caseObservationMatches: false});
    const citation = createMemoryCodeCitation({
      version: 1,
      repositoryId: EffectString.repeat(64)('b'),
      repositoryIdentityKind: 'local',
      sourceCommit: EffectString.repeat(40)('c'),
      sourceDirty: false,
      sourceSnapshotId: `cgsn_${EffectString.repeat(40)('d')}`,
      extractorSet: 'test',
      path: 'source.ts',
      fileContentHash: {algorithm: 'sha256', value: hash},
      target: {kind: 'file'},
    });
    const excerpt = (content: string) => ({
      content,
      startLine: 1,
      endLine: 1,
      excerptHash: hash,
      fileBytesHash: hash,
      provenance: 'current-verified' as const,
      supportsCitation: false,
      truncated: false,
      source: {
        repositoryId: EffectString.repeat(64)('b'),
        extractorSet: 'test',
        fileContentHash: hash,
        path: 'source.ts',
        sourceCommit: EffectString.repeat(40)('c'),
        sourceDirty: false,
        sourceSnapshotId: `cgsn_${EffectString.repeat(40)('d')}`,
      },
    });
    evidencePacket = {
      ...packet,
      evidenceRevision: 'fresh',
      topicEvidence: {
        ...packet.topicEvidence!,
        version: 1,
        observationRevision: 'fresh',
        body: 'Current source observation.',
        sources: [
          {
            citationId: citation.id,
            status: 'changed',
            original: citation,
            current: citation,
            oldExcerpt: excerpt('Recorded source evidence.'),
            newExcerpt: excerpt('Current source evidence after selected refresh.'),
          },
        ],
      },
    };
    await click('Refresh evidence');
    expect(document.body.textContent).toContain('Current source evidence after selected refresh.');
    expect(document.body.textContent).toContain('Recorded source evidence.');
    expect(button('Regenerate draft').disabled).toBe(false);
    expect(button('Apply update').disabled).toBe(true);
    expect(document.body.textContent).toContain('This draft needs fresh evidence');
    expect(
      EffectArray.filter(
        vi.mocked(globalThis.fetch).mock.calls,
        ([input, init]) =>
          EffectString.startsWith('/api/attention/context-maintenance')(String(input)) && init?.method === 'POST',
      ),
    ).toHaveLength(1);
  },
);

it.each(['reviews', 'case'] as const)(
  'prepares the canonical document once on open through %s, then accepts one explicit apply',
  async entry => {
    if (entry === 'reviews') {
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
    } else
      await render(
        <TopicReviewDialog
          project="threadnote"
          caseId="case-1"
          reviewId="review-1"
          onChanged={() => undefined}
          onClose={() => undefined}
          onOpenLibrary={() => undefined}
        />,
      );
    expect(document.querySelector('[aria-label="Exact final document"] details pre')?.textContent).toBe(
      current.approval?.content,
    );
    expect(button('Preview exact final document')).toBeUndefined();
    expect(button('Save draft')).toBeUndefined();
    expect(button('Apply update').disabled).toBe(false);
    expect(EffectArray.map(posted, action => action.action)).toEqual(['preview']);
    const gate = Promise.withResolvers<void>();
    const base = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST' && JSON.parse(String(init.body)).action === 'apply') await gate.promise;
        return base(input, init);
      }),
    );
    const apply = button('Apply update');
    await act(async () => {
      apply.click();
      apply.click();
    });
    expect(button('Saving update…').disabled).toBe(true);
    expect(EffectArray.map(posted, action => action.action)).toEqual(['preview']);
    await act(async () => gate.resolve());
    expect(EffectArray.map(posted, action => action.action)).toEqual(['preview', 'apply']);
    expect(posted[1]).toMatchObject({revision: 4, approvalDigest: hash, approved: true});
  },
);

it.each([false, true])('reconciles an unknown automatic preparation with GETs only (saved: %s)', async saved => {
  const base = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && JSON.parse(String(init.body)).action === 'preview') {
        if (saved) await base(input, init);
        else posted.push(JSON.parse(String(init.body)));
        throw new Error('Preparation response disconnected.');
      }
      return base(input, init);
    }),
  );
  await render(
    <TopicReviewDialog
      project="threadnote"
      reviewId="review-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  expect(EffectArray.map(posted, action => action.action)).toEqual(['preview']);
  expect(button('Apply update').disabled).toBe(true);
  expect(!!document.querySelector('[aria-label="Exact final document"]')).toBe(saved);
  expect(
    EffectArray.filter(vi.mocked(globalThis.fetch).mock.calls, ([, init]) => init?.method === 'POST'),
  ).toHaveLength(1);
  await click('Refresh evidence');
  // Only the human's explicit selected-observation refresh adds a POST; preparation is not replayed.
  expect(EffectArray.map(posted, action => action.action)).toEqual(['preview']);
  expect(button('Apply update').disabled).toBe(!saved);
});

it.each(['read-only', 'unresolved'] as const)('does not prepare a %s proposal automatically', async mode => {
  if (mode === 'unresolved')
    current = review({draft: {...review().draft, outcome: 'insufficient-evidence', operations: []}});
  await render(
    <TopicReviewDialog
      project="threadnote"
      reviewId="review-1"
      writesDisabled={mode === 'read-only'}
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  expect(posted).toHaveLength(0);
  expect(button('Apply update').disabled).toBe(true);
});

it('bounds automatic preparation at 30 seconds and performs no mutation replay after timeout', async () => {
  vi.useFakeTimers();
  const base = globalThis.fetch;
  let preparationSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && JSON.parse(String(init.body)).action === 'preview') {
        posted.push(JSON.parse(String(init.body)));
        preparationSignal = init.signal!;
        const response = Promise.withResolvers<Response>();
        preparationSignal.addEventListener('abort', () => response.reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
        return response.promise;
      }
      return base(input, init);
    }),
  );
  await render(
    <TopicReviewDialog
      project="threadnote"
      reviewId="review-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  await act(async () => vi.advanceTimersByTimeAsync(29_999));
  expect(preparationSignal?.aborted).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(preparationSignal?.aborted).toBe(true);
  expect(document.body.textContent).toContain('timed out after 30000 ms');
  expect(EffectArray.map(posted, action => action.action)).toEqual(['preview']);
  expect(button('Apply update').disabled).toBe(true);
});

it('aborts a pending automatic preparation on selection change and ignores its late result', async () => {
  const gate = Promise.withResolvers<void>();
  previewGate = gate.promise;
  await render(
    <TopicReviewDialog
      project="threadnote"
      reviewId="review-1"
      onChanged={() => undefined}
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  const request = EffectOption.getOrUndefined(
    EffectArray.findFirst(vi.mocked(globalThis.fetch).mock.calls, ([, init]) => init?.method === 'POST'),
  );
  const signal = request?.[1]?.signal;
  await act(async () =>
    root?.render(
      <TopicReviewDialog
        project="other"
        reviewId="review-other"
        onChanged={() => undefined}
        onClose={() => undefined}
        onOpenLibrary={() => undefined}
      />,
    ),
  );
  expect(signal?.aborted).toBe(true);
  await act(async () => gate.resolve());
  expect(document.querySelector('[aria-label="Exact final document"]')).toBeNull();
  expect(document.body.textContent).not.toContain('Updated behavior.');
  expect(EffectArray.map(posted, action => action.action)).toEqual(['preview']);
});
