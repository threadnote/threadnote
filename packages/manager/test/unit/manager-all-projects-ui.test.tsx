// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ManagerHomePanel} from '../../src/home_view.js';
import {ContextHealthPanel, ReviewsPanel} from '../../src/attention_view.js';

vi.mock('../../src/attention_details.js', () => ({
  ReviewDetail: (props: {project: string; reviewId: string}) => (
    <div role="dialog" data-project={props.project}>
      {props.reviewId}
    </div>
  ),
  HealthDetail: () => null,
}));
let root: Root | undefined;
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('loads All Home as a bounded read and makes project health scope explicit', async () => {
  const fetch = vi.fn(async () =>
    json({
      version: 1,
      project: '',
      stats: {memories: 3, pending: 2},
      lanes: [],
      handoffs: [
        {
          timestamp: '2026-10-09T10:00:00Z',
          topic: 'Resume beta',
          project: 'beta',
          uri: 'threadnote://memory/synthetic',
        },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetch);
  await render(
    <ManagerHomePanel
      project=""
      projects={['alpha', 'beta']}
      onProjectChange={() => undefined}
      onOpen={() => undefined}
    />,
  );
  expect(fetch).toHaveBeenCalledWith('/api/home?project=', expect.objectContaining({signal: expect.any(AbortSignal)}));
  expect(document.querySelector<HTMLSelectElement>('select')?.selectedOptions[0]?.textContent).toBe('All');
  expect(document.body.textContent).toContain('Saved context across all projects');
  expect(document.body.textContent).toContain('By project');
  expect(document.body.textContent).toContain('beta ·');
});

it.each([{memories: 3, pending: 0}, {memories: 0, pending: 2}, {pending: 0}])(
  'keeps unassigned records, candidate-only projects, and incomplete inventory visible: %j',
  async stats => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({version: 1, project: '', stats, lanes: [], handoffs: []})),
    );
    await render(
      <ManagerHomePanel project="" projects={[]} onProjectChange={() => undefined} onOpen={() => undefined} />,
    );
    expect(document.querySelector('[aria-label="All projects overview"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('No project records yet');
  },
);

it('shows project inspection destinations in All Health without issuing scans or mutations', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const onProjectChange = vi.fn();
  await render(
    <ContextHealthPanel
      project=""
      projects={['alpha', 'beta']}
      onProjectChange={onProjectChange}
      onOpenLibrary={() => undefined}
      refreshGeneration={0}
    />,
  );
  expect(document.body.textContent).toContain('Context health across projects');
  expect(document.body.textContent).toContain('Health checks and repairs are scoped to one project.');
  const tiles = document.querySelectorAll<HTMLButtonElement>('.health-project-grid > button');
  expect([...tiles].map(tile => tile.getAttribute('aria-label'))).toEqual(['Inspect alpha', 'Inspect beta']);
  expect(tiles[1].querySelector('strong')?.textContent).toBe('beta');
  expect(tiles[1].querySelector('button')).toBeNull();
  const inspect = tiles[1];
  await act(async () => inspect.click());
  expect(onProjectChange).toHaveBeenCalledWith('beta');
  expect(fetch).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('Repair all');
});

it('keeps each All review detail pinned to its actual project', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({version: 1, project: '', pendingCount: 2, items: [review('alpha'), review('beta')]})),
  );
  await render(reviews(''));
  expect(document.body.textContent).toContain('alpha ·');
  expect(document.body.textContent).toContain('beta ·');
  const buttons = document.querySelectorAll<HTMLButtonElement>('.attention-review-button');
  await act(async () => buttons[1].click());
  expect(document.querySelector('[role="dialog"]')?.getAttribute('data-project')).toBe('beta');
});

it('aborts an old review request and rejects its delayed result after switching to All', async () => {
  const delayed = Promise.withResolvers<Response>();
  let oldSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('project=alpha')) {
        oldSignal = init?.signal ?? undefined;
        return delayed.promise;
      }
      return Promise.resolve(json({version: 1, project: '', pendingCount: 1, items: [review('beta')]}));
    }),
  );
  await render(reviews('alpha'));
  await render(reviews(''));
  expect(oldSignal?.aborted).toBe(true);
  await act(async () =>
    delayed.resolve(json({version: 1, project: 'alpha', pendingCount: 1, items: [review('alpha')]})),
  );
  expect(document.body.textContent).toContain('beta task');
  expect(document.body.textContent).not.toContain('alpha task');
});

function reviews(project: string) {
  return (
    <ReviewsPanel
      project={project}
      projects={['alpha', 'beta']}
      onProjectChange={() => undefined}
      onOpenLibrary={() => undefined}
      refreshGeneration={0}
    />
  );
}
function review(project: string) {
  return {
    reviewId: `review-${project}`,
    project,
    createdAt: '2026-10-09T10:00:00Z',
    revision: 1,
    topic: 'synthetic',
    task: `${project} task`,
    candidates: [
      {
        candidateId: 'one',
        state: 'pending',
        recommendation: 'create',
        confidence: 0.9,
        proposedText: 'Synthetic proposal',
        reason: 'Synthetic evidence',
      },
    ],
  };
}
function json(body: unknown) {
  return new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
}
async function render(element: React.ReactElement) {
  if (!root) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(element));
}
