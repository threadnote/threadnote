// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ReviewDetail, HealthDetail} from '../../src/attention_details.js';
import {MemoryDetailModal} from '../../src/detail_modal.js';
import {ManagerHomePanel} from '../../src/home_view.js';
let root: Root;
const fetchMock = vi.fn();
beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {status});
}
async function render(node: React.ReactElement) {
  await act(async () => root.render(node));
}
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent === text);
  expect(button).toBeDefined();
  await act(async () => button?.click());
}
const base = {onClose: vi.fn(), onChanged: vi.fn(), onOpenLibrary: vi.fn(), project: 'threadnote'};
it('opens full candidate text and submits the exact preview revision only after a decision', async () => {
  fetchMock
    .mockResolvedValueOnce(
      response({
        review: {
          task: 'Task',
          revision: 7,
          candidates: [
            {
              candidateId: 'candidate-1',
              proposedText: 'Full body beyond list preview',
              kind: 'durable',
              topic: 'topic',
              evidence: [],
              state: 'pending',
            },
          ],
        },
        delta: {
          items: [
            {
              candidateId: 'candidate-1',
              mutationPreview: {bodyText: 'Full body beyond list preview', operation: 'create', truncated: false},
            },
          ],
        },
      }),
    )
    .mockResolvedValueOnce(response({message: 'Applied'}));
  await render(<ReviewDetail {...base} reviewId="review-example" candidateId="candidate-1" />);
  expect(document.querySelector('dialog')?.open).toBe(true);
  expect(document.body.textContent).toContain('Full body beyond list preview');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await click('Approve and apply');
  expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body)).toMatchObject({
    revision: 7,
    approved: true,
    action: 'approve',
    operation: 'create',
  });
});
it('refreshes legacy replacement safety in Manager without exposing an internal tool name', async () => {
  const candidate = {
    candidateId: 'candidate-legacy',
    proposedText: 'Updated decision',
    kind: 'durable',
    topic: 'topic',
    evidence: [],
    reason: 'Replace the previous decision',
    state: 'pending',
    targetUri: 'threadnote://memory/tn_existing',
  };
  fetchMock
    .mockResolvedValueOnce(
      response({
        review: {task: 'Task', revision: 3, candidates: [candidate]},
        delta: {
          items: [
            {
              candidateId: candidate.candidateId,
              mutationPreview: {
                operation: 'replace',
                replacementSafety: {
                  classification: 'review-required',
                  warning: 'Run review_session_context again before replacing the current target.',
                },
                truncated: false,
              },
            },
          ],
        },
      }),
    )
    .mockResolvedValueOnce(
      response({
        review: {task: 'Task', revision: 4, candidates: [candidate]},
        delta: {
          items: [
            {
              candidateId: candidate.candidateId,
              mutationPreview: {
                operation: 'replace',
                replacementSafety: {classification: 'preserving', requiresExplicitApproval: false},
                truncated: false,
              },
            },
          ],
        },
      }),
    );
  await render(<ReviewDetail {...base} reviewId="review-legacy" candidateId={candidate.candidateId} />);
  expect(document.body.textContent).not.toContain('review_session_context');
  expect(
    [...document.querySelectorAll('button')].find(item => item.textContent === 'Approve and apply')?.disabled,
  ).toBe(true);
  expect(document.body.textContent).toContain('This check does not change any memory.');
  await click('Check current memory');
  expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body)).toEqual({
    project: 'threadnote',
    reviewId: 'review-legacy',
    candidateId: 'candidate-legacy',
    revision: 3,
  });
  expect(document.body.textContent).not.toContain('review_session_context');
  expect(document.body.textContent).toContain('Replacement check passed');
  expect(
    [...document.querySelectorAll('button')].find(item => item.textContent === 'Approve and apply')?.disabled,
  ).toBe(false);
});
it('submits the reviewed replace operation when approving a safe replacement', async () => {
  const candidate = {
    candidateId: 'candidate-replace',
    proposedText: 'Updated decision',
    kind: 'durable',
    topic: 'topic',
    evidence: [],
    reason: 'Replace the previous decision',
    state: 'pending',
    targetUri: 'threadnote://memory/tn_existing',
  };
  fetchMock
    .mockResolvedValueOnce(
      response({
        review: {task: 'Task', revision: 4, candidates: [candidate]},
        delta: {
          items: [
            {
              candidateId: candidate.candidateId,
              mutationPreview: {
                operation: 'replace',
                replaceUri: candidate.targetUri,
                replacementSafety: {classification: 'preserving', requiresExplicitApproval: false},
                truncated: false,
              },
            },
          ],
        },
      }),
    )
    .mockResolvedValueOnce(response({message: 'Applied'}));

  await render(<ReviewDetail {...base} reviewId="review-replace" candidateId={candidate.candidateId} />);
  await click('Approve and apply');

  expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body)).toMatchObject({
    action: 'approve',
    operation: 'replace',
  });
});
it('submits the operation selected for an ambiguous candidate', async () => {
  const candidate = {
    candidateId: 'candidate-manual',
    proposedText: 'Reviewed decision',
    kind: 'durable',
    topic: 'topic',
    evidence: [],
    reason: 'Choose whether to replace or create',
    state: 'pending',
    targetUri: 'threadnote://memory/tn_existing',
  };
  fetchMock
    .mockResolvedValueOnce(
      response({
        review: {task: 'Task', revision: 5, candidates: [candidate]},
        delta: {
          items: [
            {
              candidateId: candidate.candidateId,
              mutationPreview: {operation: 'requires_explicit_operation', truncated: false},
            },
          ],
        },
      }),
    )
    .mockResolvedValueOnce(response({message: 'Applied'}));

  await render(<ReviewDetail {...base} reviewId="review-manual" candidateId={candidate.candidateId} />);
  expect(
    [...document.querySelectorAll('button')].find(item => item.textContent === 'Approve and apply')?.disabled,
  ).toBe(true);
  const select = document.querySelector<HTMLSelectElement>('select');
  await act(async () => {
    if (!select) return;
    select.value = 'replace';
    select.dispatchEvent(new Event('change', {bubbles: true}));
  });
  await click('Approve and apply');

  expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body)).toMatchObject({
    action: 'approve',
    operation: 'replace',
  });
});
it('lets the user create a reviewed replacement when its original target disappeared', async () => {
  const candidate = {
    candidateId: 'candidate-missing',
    proposedText: 'Current reviewed decision',
    kind: 'durable',
    topic: 'topic',
    evidence: [],
    reason: 'Replace the previous decision',
    state: 'pending',
    targetUri: 'threadnote://memory/tn_missing',
  };
  fetchMock
    .mockResolvedValueOnce(
      response({
        review: {task: 'Task', revision: 3, candidates: [candidate]},
        delta: {
          items: [
            {
              candidateId: candidate.candidateId,
              mutationPreview: {
                operation: 'replace',
                replacementSafety: {
                  classification: 'review-required',
                  requiresExplicitApproval: true,
                },
                truncated: false,
              },
            },
          ],
        },
      }),
    )
    .mockResolvedValueOnce(
      response(
        {
          code: 'replacement-target-missing',
          error:
            'The replacement target no longer exists. You can create the reviewed proposal as the current memory instead.',
        },
        409,
      ),
    )
    .mockResolvedValueOnce(response({message: 'Applied'}));

  await render(<ReviewDetail {...base} reviewId="review-missing" candidateId={candidate.candidateId} />);
  await click('Check current memory');
  expect(document.body.textContent).toContain('Previous memory no longer exists');
  expect(document.body.textContent).toContain('Creating the proposal now will not overwrite another memory');
  expect(document.body.textContent).toContain('Select the option above to enable creation.');
  expect(
    [...document.querySelectorAll('button')].find(item => item.textContent === 'Create current memory')?.disabled,
  ).toBe(true);
  const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
  await act(async () => checkbox?.click());
  expect(document.body.textContent).toContain('Ready to create. Use “Create current memory” below.');
  expect(
    [...document.querySelectorAll('button')].find(item => item.textContent === 'Create current memory')?.disabled,
  ).toBe(false);
  await click('Create current memory');
  expect(JSON.parse(fetchMock.mock.calls[2]?.[1]?.body)).toMatchObject({
    allowMissingReplacementCreate: true,
    operation: 'create',
  });
});
it('distinguishes a citation target from its existing source memory', async () => {
  const onOpenLibrary = vi.fn();
  const sourceUri = 'threadnote://user/tester/memories/example.md';
  const targetUri = `${sourceUri}#tncc_missing`;
  const replacement = {
    extractorSet: 'typescript',
    fileContentHash: {algorithm: 'sha256', value: '1'.repeat(64)},
    id: `tncc_${'2'.repeat(40)}`,
    path: 'packages/manager/src/attention_details.tsx',
    repositoryId: `repo_${'3'.repeat(40)}`,
    repositoryIdentityKind: 'local',
    sourceCommit: '4'.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${'5'.repeat(40)}-direct`,
    target: {
      fragmentCanonicalization: 'utf8-source-span-v1',
      fragmentHash: {algorithm: 'sha256', value: '6'.repeat(64)},
      kind: 'symbol',
      language: 'typescript',
      name: 'HealthDetail',
      nodeId: `cgs_${'7'.repeat(40)}`,
      qualifiedName: 'HealthDetail',
      span: {column: 1, endColumn: 2, endLine: 321, line: 206},
      symbolKind: 'function',
    },
    version: 1,
  } as const;
  fetchMock.mockResolvedValueOnce(
    response({
      proposal: {
        proposalId: 'citation-repair-example',
        revision: 'exact-hash',
        summary: 'Recapture citation against the current graph',
        mutation: {
          citationId: 'tncc_missing',
          kind: 'replace-citation',
          replacement,
          subjectUri: sourceUri,
          targetUri,
        },
        preconditions: [],
      },
    }),
  );
  await render(
    <HealthDetail
      {...base}
      repairsAvailable={true}
      onOpenLibrary={onOpenLibrary}
      finding={{
        id: 'finding-1',
        category: 'citation-changed',
        confidence: 'high',
        severity: 'high',
        summary: 'Source changed',
        repairability: 'reviewable',
        repair: {kind: 'repair-citation', subjectUri: sourceUri, summary: 'Check source', targetUri},
        uris: [sourceUri, targetUri],
      }}
    />,
  );
  expect(document.body.textContent).toContain('Preview a recapture');
  expect(document.body.textContent).toContain('Stored code reference');
  expect([...document.querySelectorAll('button')].filter(item => item.textContent?.includes('Library'))).toHaveLength(
    1,
  );
  await click('Open source memory in Library');
  expect(onOpenLibrary).toHaveBeenCalledWith(sourceUri);
  await click('Preview repair');
  expect(document.body.textContent).toContain('Recapture citation');
  expect(document.body.textContent).toContain('Proposed citation evidence');
  expect(document.body.textContent).not.toContain(replacement.repositoryId);
  expect(document.body.textContent).not.toContain('tncc_missing');
  expect(document.body.textContent).toContain(replacement.path);
  expect(document.body.textContent).toContain(replacement.sourceCommit);
  expect(document.body.textContent).toContain('HealthDetail');
  expect(document.body.textContent).toContain('206:1–321:2');
});
it('reads the canonical handoff only on opening its dialog', async () => {
  fetchMock.mockResolvedValue(response({content: '# Full handoff\nAll next steps.'}));
  await render(
    <MemoryDetailModal
      title="Handoff"
      uri="threadnote://user/tester/memories/handoff.md"
      onClose={() => undefined}
      onOpenLibrary={() => undefined}
    />,
  );
  expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/memory?uri=');
  expect(document.body.textContent).toContain('All next steps.');
});
it('renders an actionable live attention flow without fabricated trends', async () => {
  fetchMock.mockResolvedValue(
    response({
      project: 'threadnote',
      lanes: [
        {
          action: 'context-health',
          count: 9,
          detail: '9 findings need review.',
          id: 'health',
          status: 'attention',
          title: 'Context health',
        },
      ],
      handoffs: [],
      stats: {memories: 12, pending: 3, outcomes: 8},
    }),
  );
  await render(
    <ManagerHomePanel
      project="threadnote"
      projects={['threadnote']}
      onProjectChange={() => undefined}
      onOpen={() => undefined}
    />,
  );
  expect(document.body.textContent).toContain('12');
  expect(document.body.textContent).toContain('9');
  expect(document.body.textContent).not.toContain('Motion shows workflow direction, not volume');
  expect(document.body.textContent).not.toContain('Project Setup');
  expect(document.body.textContent).not.toContain('9 findings need review.');
  expect(document.querySelectorAll('.home-flow-node')).toHaveLength(4);
  expect(document.querySelector('.home-lanes')).toBeNull();
});

it('requires a repair preview before applying its exact revision', async () => {
  fetchMock
    .mockResolvedValueOnce(
      response({
        proposal: {
          proposalId: 'health-repair-example',
          revision: 'exact-hash',
          summary: 'Remove a broken relation',
          mutation: {kind: 'remove-relations', targetUri: 'threadnote://missing'},
          selector: {topic: 'workflow', findingCategory: 'relation-target-missing'},
          preconditions: [],
        },
      }),
    )
    .mockResolvedValueOnce(response({status: 'applied'}));
  await render(
    <HealthDetail
      {...base}
      repairsAvailable={true}
      finding={{
        id: 'finding-2',
        category: 'relation-target-missing',
        confidence: 'high',
        severity: 'high',
        summary: 'Missing relation',
        repairability: 'reviewable',
        repair: {kind: 'repair-relation', summary: 'Remove broken link'},
        uris: ['threadnote://user/tester/memories/example.md'],
      }}
    />,
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('Approve and apply repair');
  await click('Preview repair');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await click('Remove broken relation');
  expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body)).toMatchObject({
    proposalId: 'health-repair-example',
    revision: 'exact-hash',
    approved: true,
    topic: 'workflow',
  });
});

it('opens a home handoff row as full canonical content without embedding it in home data', async () => {
  fetchMock
    .mockResolvedValueOnce(
      response({
        project: 'threadnote',
        lanes: [],
        handoffs: [
          {
            uri: 'threadnote://user/tester/memories/handoff.md',
            topic: 'Resume work',
            timestamp: '2026-09-28T12:00:00Z',
          },
        ],
      }),
    )
    .mockResolvedValueOnce(response({content: '# Full handoff\nUnfinished steps to resume.'}));
  await render(
    <ManagerHomePanel
      project="threadnote"
      projects={['threadnote']}
      onProjectChange={() => undefined}
      onOpen={() => undefined}
    />,
  );
  expect(document.querySelector('dialog')).toBeNull();
  const row = document.querySelector<HTMLButtonElement>('.home-handoff-button');
  await act(async () => row?.click());
  expect(document.querySelector('dialog')?.open).toBe(true);
  expect(document.body.textContent).toContain('Unfinished steps to resume.');
});
