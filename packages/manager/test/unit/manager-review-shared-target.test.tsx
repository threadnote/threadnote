// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {ReviewDetail} from '../../src/attention_details.js';

let root: Root;
const fetchMock = vi.fn();
const onClose = vi.fn();
const onChanged = vi.fn();
const sharedUri = 'threadnote://user/tester/memories/shared/team/durable/projects/example/decision.md';
const props = {
  project: 'example',
  reviewId: 'review-synthetic',
  candidateId: 'candidate-synthetic',
  onClose,
  onChanged,
  onOpenLibrary: vi.fn(),
};

beforeEach(() => {
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', fetchMock);
  vi.clearAllMocks();
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

type Safety = 'preserving' | 'review-required' | 'destructive-loss-risk';
function preview(
  options: {
    targetUri?: string;
    operation?: 'replace' | 'requires_explicit_operation' | 'no_action';
    safety?: Safety;
    truncated?: boolean;
  } = {},
) {
  const operation = options.operation ?? 'replace';
  const safety = options.safety ?? 'preserving';
  return {
    review: {
      task: 'Synthetic candidate review',
      revision: 9,
      candidates: [
        {
          candidateId: props.candidateId,
          proposedText: 'Synthetic reviewed decision.',
          kind: 'durable',
          topic: 'synthetic',
          reason: 'An existing memory has this identity.',
          evidence: [],
          state: 'pending',
          targetUri: options.targetUri ?? sharedUri,
        },
      ],
    },
    delta: {
      items: [
        {
          candidateId: props.candidateId,
          mutationPreview: {
            operation,
            replacementSafety: {
              classification: safety,
              requiresExplicitApproval: safety !== 'preserving',
              warning: safety === 'preserving' ? undefined : 'Synthetic replacement warning.',
            },
            truncated: options.truncated ?? false,
          },
        },
      ],
    },
  };
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {status});
}
async function render(value: ReturnType<typeof preview>, key = 'review') {
  fetchMock.mockResolvedValueOnce(response(value)).mockResolvedValueOnce(response({message: 'Applied'}));
  await act(async () => root.render(<ReviewDetail key={key} {...props} />));
}
function approveButton() {
  const button = [...document.querySelectorAll('button')].find(
    item => item.textContent === 'Approve and create personal copy',
  );
  expect(button).toBeDefined();
  return button!;
}
async function chooseCreate() {
  const select = document.querySelector<HTMLSelectElement>('select');
  expect(select).not.toBeNull();
  expect([...select!.options].map(option => option.value)).toEqual(['', 'create']);
  await act(async () => {
    select!.value = 'create';
    select!.dispatchEvent(new Event('change', {bubbles: true}));
  });
}

it.each<Safety>(['preserving', 'review-required', 'destructive-loss-risk'])(
  'requires a personal-copy choice for shared targets with %s replacement safety',
  async safety => {
    await render(preview({safety}));
    expect(document.body.textContent).toContain('The shared source will stay unchanged.');
    expect(document.body.textContent).not.toContain('Replacement check passed');
    expect(document.body.textContent).not.toContain('Check current memory');
    expect(document.body.textContent).toContain('Choose the personal-copy option before approving.');
    expect(document.body.textContent).not.toContain('replacement warning');
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(approveButton().disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await chooseCreate();
    expect(approveButton().disabled).toBe(false);
    await act(async () => approveButton().click());
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body)).toMatchObject({
      revision: 9,
      action: 'approve',
      approved: true,
      operation: 'create',
      allowDestructiveReplacement: false,
      allowMissingReplacementCreate: false,
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledOnce();
  },
);

it('keeps shared duplicate confirmation as a no-write decision', async () => {
  await render(preview({operation: 'no_action'}));
  expect(document.querySelector('select')).toBeNull();
  const button = [...document.querySelectorAll('button')].find(item => item.textContent === 'Confirm no change needed');
  expect(button?.disabled).toBe(false);
  await act(async () => button?.click());
  expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body)).not.toHaveProperty('operation');
});

it('shows decision failures beside the action controls and keeps the review open', async () => {
  const personal = 'threadnote://user/tester/memories/durable/projects/example/decision.md';
  fetchMock
    .mockResolvedValueOnce(response(preview({targetUri: personal})))
    .mockResolvedValueOnce(response({error: 'Synthetic review changed; reopen it.'}, 409));
  await act(async () => root.render(<ReviewDetail {...props} />));
  const button = [...document.querySelectorAll('button')].find(item => item.textContent === 'Approve and apply');
  await act(async () => button?.click());
  const alert = document.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe('Synthetic review changed; reopen it.');
  expect(alert?.nextElementSibling).toBe(document.querySelector('dialog footer'));
  expect(onClose).not.toHaveBeenCalled();
  expect(onChanged).not.toHaveBeenCalled();
  expect(document.querySelector('dialog')?.open).toBe(true);
});

it('never submits a shared replacement or approves a truncated copy across bounded preview combinations', async () => {
  let sample = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        user: fc.integer({min: 0, max: 8}),
        team: fc.integer({min: 0, max: 8}),
        operation: fc.constantFrom('replace' as const, 'requires_explicit_operation' as const),
        safety: fc.constantFrom<Safety>('preserving', 'review-required', 'destructive-loss-risk'),
        truncated: fc.boolean(),
      }),
      async generated => {
        fetchMock.mockReset();
        onClose.mockClear();
        onChanged.mockClear();
        const targetUri = `threadnote://user/user${generated.user}/memories/shared/team${generated.team}/durable/projects/example/decision.md`;
        await render(preview({...generated, targetUri}), String(sample++));
        expect(approveButton().disabled).toBe(true);
        await act(async () => approveButton().click());
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await chooseCreate();
        expect(approveButton().disabled).toBe(generated.truncated);
        await act(async () => approveButton().click());
        if (generated.truncated) {
          expect(fetchMock).toHaveBeenCalledTimes(1);
          expect(onClose).not.toHaveBeenCalled();
        } else {
          expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body)).toMatchObject({
            operation: 'create',
            approved: true,
            revision: 9,
            allowDestructiveReplacement: false,
            allowMissingReplacementCreate: false,
          });
          expect(onClose).toHaveBeenCalledOnce();
        }
      },
    ),
    {numRuns: 40},
  );
});
