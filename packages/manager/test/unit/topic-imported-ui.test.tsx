// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {topicMaintenanceObsidianCitationId} from '@threadnote/memory/topic-maintenance';
import {isJsonObject} from '@threadnote/platform/json';
import type {MemoryObsidianEvidenceV1} from '@threadnote/memory/document';
import type {
  ManagerContextMaintenancePacketV2,
  ManagerContextMaintenanceStatusV2,
} from '../../src/attention/contracts.js';
import type {ManagerTopicReviewV1} from '../../src/attention/topic_contracts.js';
import {TopicReviewContent} from '../../src/attention/topic_review.js';
import {MaintenanceCaseDialog} from '../../src/attention/maintenance_dialogs.js';
import {TopicEnrollmentPanel} from '../../src/attention/topic_enrollment.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';

function requireJsonObject(value: unknown): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error('Expected a JSON request object.');
  return value;
}

const hash = Effect.pipe('a', EffectString.repeat(64));
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

let activePrivateReview = privateReview;
let root: Root;
let revoked: boolean;
let evidence: ManagerContextMaintenancePacketV2;
let captureGate: Promise<void> | undefined;
let readGate: Promise<void> | undefined;
let packetUnavailable: boolean;
let recoveryOnly: boolean;
let rejectedRecovery: boolean;
let maintenanceReadDenied: boolean;
let maintenanceReadUnavailable: boolean;
let rejectGate: Promise<void> | undefined;
const posted: Record<string, unknown>[] = [];
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  activePrivateReview = privateReview;
  revoked = false;
  evidence = packet();
  captureGate = undefined;
  readGate = undefined;
  packetUnavailable = false;
  recoveryOnly = false;
  rejectedRecovery = false;
  maintenanceReadDenied = false;
  maintenanceReadUnavailable = false;
  rejectGate = undefined;
  posted.length = 0;
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
      if (url.pathname === '/api/consolidation-models')
        return response({models: [{id: 'model', label: 'Model', isDefault: true}]});
      if (url.pathname === '/api/attention/context-maintenance') {
        if (url.searchParams.get('view') === 'status')
          return response(
            maintenanceStatus([
              {
                caseId: 'case-note',
                project: 'notes',
                memoryId: 'memory-note',
                family: 'topic-maintenance',
                slot: 'declared-support',
                evidenceRevision: hash,
                disposition: 'needs-decision',
                reason: 'note changed',
                firstSeen: 'now',
                lastSeen: 'now',
                lastChecked: 'now',
                attemptCount: 1,
                events: [],
              },
            ]),
          );
        if (maintenanceReadDenied) return response({error: 'Private source access denied.'}, 403);
        const selectedPacket =
          maintenanceReadUnavailable && evidence.topicEvidence?.version === 2
            ? {
                ...evidence,
                topicEvidence: {...evidence.topicEvidence, outcome: 'unavailable', body: undefined, obsidian: {}},
              }
            : evidence;
        if (init?.method === 'POST')
          return response({
            outcome: 'ready',
            item: {
              caseId: 'case-note',
              project: 'notes',
              memoryId: 'memory-note',
              family: 'topic-maintenance',
              slot: 'declared-support',
              evidenceRevision: selectedPacket.evidenceRevision,
              disposition: maintenanceReadUnavailable ? 'waiting-evidence' : 'needs-decision',
              reason: 'note changed',
              firstSeen: 'now',
              lastSeen: 'now',
              lastChecked: 'now',
              attemptCount: 1,
              events: [],
            },
            packet: selectedPacket,
          });
        return packetUnavailable ? response({error: 'Source evidence changed.'}, 409) : response(selectedPacket);
      }
      if (url.pathname === '/api/attention/topic-review' && init?.method === 'POST') {
        const body = requireJsonObject(JSON.parse(String(init.body)));
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
                  fragment: Effect.pipe(
                    currentText,
                    EffectString.slice(Number(body.fragmentStart), Number(body.fragmentEnd)),
                  ),
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
        return response(activePrivateReview);
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
        return revoked ? response({error: 'Private review unavailable.'}, 404) : response(activePrivateReview);
      }
      if (url.pathname === '/api/attention/topic-enrollment') {
        if (revoked) return response({error: 'Private source unavailable.'}, 409);
        if (init?.method === 'POST') {
          const body = requireJsonObject(JSON.parse(String(init.body)));
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
const renderMaintenanceReview = (stale: boolean) =>
  act(async () =>
    root.render(
      <MaintenanceCaseDialog
        project="notes"
        caseId="case-note"
        initialCase={{
          caseId: 'case-note',
          project: 'notes',
          memoryId: 'memory-note',
          family: 'topic-maintenance',
          slot: 'declared-support',
          evidenceRevision: hash,
          disposition: 'needs-decision',
          reason: 'note changed',
          firstSeen: 'now',
          lastSeen: 'now',
          lastChecked: 'now',
          attemptCount: 1,
          events: [],
        }}
        stale={stale}
        onChanged={() => undefined}
        onClose={() => undefined}
        onOpenLibrary={() => undefined}
        onTask={() => undefined}
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
  const start = Effect.pipe(
    currentText,
    EffectString.indexOf('🙂'),
    Effect.Option.getOrElse(() => -1),
  );
  const end = Effect.pipe(
    currentText,
    EffectString.indexOf('\nTrailing'),
    Effect.Option.getOrElse(() => -1),
  );
  await selectExcerpt(start, end);
  expect(document.querySelector('[aria-label="Selected note excerpt"]')?.textContent).toBe(
    Effect.pipe(currentText, EffectString.slice(start, end)),
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
    Effect.pipe(currentText, EffectString.slice(start, end)),
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

it.each(['denied', 'unavailable'] as const)(
  'redacts a private topic packet without a review ID after %s revalidation',
  async outcome => {
    await renderMaintenanceReview(false);
    const dialog = document.querySelector('dialog');
    expect(dialog?.textContent).toContain('Original private note.');
    expect(dialog?.textContent).toContain('Accepted private note.');
    expect(dialog?.textContent).toContain('🙂 Exact supporting note.');
    if (outcome === 'denied') maintenanceReadDenied = true;
    else maintenanceReadUnavailable = true;
    await renderMaintenanceReview(true);
    await renderMaintenanceReview(false);
    expect(document.querySelector('dialog')).toBe(dialog);
    expect(dialog?.textContent).not.toMatch(/Original private|Accepted private|Exact supporting note/u);
    expect(dialog?.textContent).not.toContain('Keep selected excerpt');
    expect(posted).toHaveLength(0);
  },
);

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
    /Accepted private|Proposed private|Approved private|Original private|Generate draft|Apply update|Resume review/u,
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
      select.value = Effect.pipe(select.getAttribute('aria-label'), effectOptionalString =>
        effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.startsWith('Role')),
      )
        ? 'descriptive'
        : 'direct';
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

it.each(['manual', 'dirty'] as const)(
  'immediately hides ready-parent %s private review while fresh authorization is pending',
  async mode => {
    evidence = packet('review-note');
    if (mode === 'dirty') activePrivateReview = editablePrivateReview();
    await renderMaintenanceReview(false);
    expect(document.body.textContent).toContain('Approved private full document.');
    if (mode === 'dirty') {
      const editor = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Proposed descriptive paragraph 1"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          editor,
          'Unsaved private edit.',
        );
        editor.dispatchEvent(new Event('input', {bubbles: true}));
      });
      expect(editor.value).toBe('Unsaved private edit.');
    }
    const gate = Promise.withResolvers<void>();
    readGate = gate.promise;
    revoked = true;
    await act(async () => button('Refresh evidence').click());
    expect(document.body.textContent).not.toMatch(
      /Accepted private|Proposed private|Approved private|Original private|Private note topic|Unsaved private edit/u,
    );
    await act(async () => gate.resolve());
    expect(document.body.textContent).not.toMatch(
      /Accepted private|Proposed private|Approved private|Original private|Unsaved private edit/u,
    );
    expect(posted).toHaveLength(0);
  },
);

function editablePrivateReview(): ManagerTopicReviewV1 {
  return {
    ...privateReview,
    generation: {...privateReview.generation, origin: 'model'},
    paragraphs: [
      {
        ordinal: 0,
        hash,
        role: 'descriptive',
        support: 'direct',
        citationIds: [topicMaintenanceObsidianCitationId(citation)],
      },
    ],
    support: [
      {
        handleId: `current:${topicMaintenanceObsidianCitationId(citation)}`,
        citationId: topicMaintenanceObsidianCitationId(citation),
        variant: 'current',
        path: 'Decision.md',
        provenance: 'current-verified',
      },
    ],
    draft: {
      ...privateReview.draft,
      outcome: 'propose-update',
      operations: [
        {
          ordinal: 0,
          beforeHash: hash,
          text: 'Proposed private memory.',
          supportHandles: [`current:${topicMaintenanceObsidianCitationId(citation)}`],
          rationale: 'Selected note changed.',
        },
      ],
    },
  };
}

it('restores an unsaved private draft only after the ready-parent refresh authorizes it again', async () => {
  evidence = packet('review-note');
  activePrivateReview = editablePrivateReview();
  await renderMaintenanceReview(false);
  const editor = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Proposed descriptive paragraph 1"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'Unsaved private edit.');
    editor.dispatchEvent(new Event('input', {bubbles: true}));
  });
  const gate = Promise.withResolvers<void>();
  readGate = gate.promise;
  await act(async () => button('Refresh evidence').click());
  expect(document.body.textContent).not.toMatch(
    /Accepted private|Proposed private|Approved private|Original private|Unsaved private edit/u,
  );
  await act(async () => gate.resolve());
  expect(
    document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Proposed descriptive paragraph 1"]')?.value,
  ).toBe('Unsaved private edit.');
  expect(button('Apply update').disabled).toBe(true);
  expect(posted).toHaveLength(0);
});
