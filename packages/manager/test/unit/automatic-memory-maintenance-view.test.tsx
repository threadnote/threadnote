// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {
  AutomaticMemoryPanel,
  automaticMemoryGroups,
  reconcileAutomaticMemoryItems,
} from '../../src/attention/automatic_memory.js';
import {AutomaticMemoryReviewDialog} from '../../src/attention/automatic_review.js';
import {useManualSupportEdit} from '../../src/attention/manual_edit.js';
import {LibraryArticle} from '../../src/library_article.js';
import type {ManagerAutomaticMemoryItem, ManagerAutomaticReview} from '../../src/attention/topic_contracts.js';
import type {MemoryResponse} from '../../src/ui/contracts.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {canonicalMemoryDocumentContent} from '@threadnote/memory/document';

const hash = 'a'.repeat(64);
const uri = 'threadnote://user/test/memories/durable/projects/project/ordinary.md';
const reviewId = `review-${'a'.repeat(24)}`;
const coverage = {
  outcome: 'unknown' as const,
  scope: 'none' as const,
  searchedScopes: [],
  omittedSources: 1,
  omittedParagraphs: 0,
};
const item = (overrides: Partial<ManagerAutomaticMemoryItem> = {}): ManagerAutomaticMemoryItem => ({
  uri,
  title: 'Ordinary memory',
  targetHash: hash,
  state: 'preparing',
  coverage,
  paragraphs: [{ordinal: 0, role: 'unknown', authority: 'provisional', support: 'unresolved'}],
  route: 'personal-review',
  legacyUncited: false,
  ...overrides,
});
const review = (overrides: Partial<ManagerAutomaticReview> = {}): ManagerAutomaticReview => ({
  version: 1,
  kind: 'automatic-memory-review',
  project: 'project',
  reviewId,
  revision: 1,
  state: 'pending',
  targetUri: uri,
  targetHash: hash,
  evidenceRevision: hash,
  purpose: 'automatic',
  acceptedBody: 'Accepted prose.',
  proposal: {
    version: 2,
    kind: 'automatic',
    body: 'Proposed prose.',
    finalBodyHash: hash,
    changedOrdinals: [0],
    draft: {
      version: 2,
      kind: 'automatic',
      purpose: 'automatic',
      targetHash: hash,
      observationRevision: hash,
      packetDigest: hash,
      outcome: 'propose-update',
      operations: [],
      reviewedHandles: [],
      rationale: 'Updated source.',
      unresolvedQuestions: [],
      removedClaims: [],
      paragraphDecisions: [{ordinal: 0, beforeHash: hash, role: 'descriptive', support: 'direct', evidenceIds: []}],
    },
  },
  sourceEvidence: [],
  coverage,
  canApply: false,
  canFinishVerification: false,
  verified: false,
  ...overrides,
});
const approval = () => ({
  stage: 'preview' as const,
  reviewRevision: 2,
  approvalDigest: hash,
  content: 'MEMORY\nkind: durable\nreviewed_support: exact-provenance\n\nProposed prose.',
  contentHash: hash,
  metadataDiff: [{field: 'reviewed_support', beforeHash: hash, afterHash: hash}],
  reviewedSupport: {
    type: 'reviewed-memory-support' as const,
    version: 1 as const,
    active: {
      bodyHash: hash,
      paragraphs: [],
      sources: [],
      acceptance: {
        reviewId,
        approvedAt: '2026-10-22T00:00:00Z',
        targetBeforeHash: hash,
        preparationDigest: hash,
        sourceVectorDigest: hash,
      },
      digest: hash,
    },
    initialApproval: {
      bodyHash: hash,
      paragraphs: [],
      sources: [],
      acceptance: {
        reviewId,
        approvedAt: '2026-10-22T00:00:00Z',
        targetBeforeHash: hash,
        preparationDigest: hash,
        sourceVectorDigest: hash,
      },
      digest: hash,
    },
  },
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
let root: Root | undefined;
beforeEach(() => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(element: React.ReactElement) {
  if (!root) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root?.render(element));
}
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes(text))!;
async function click(text: string) {
  await act(async () => button(text).click());
}

it('groups uncited legacy coverage once, sorts ready reviews first, and never mutates input across permutations', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(
        fc.record({name: fc.stringMatching(/^[a-z]{1,10}$/u), ready: fc.boolean(), legacy: fc.boolean()}),
        {selector: row => row.name, maxLength: 30},
      ),
      rows => {
        const items = rows.map(row =>
          item({
            uri: `${uri}/${row.name}`,
            state: row.ready ? 'ready' : 'unknown',
            legacyUncited: row.legacy,
            ...(row.ready ? {reviewId: row.name} : {}),
          }),
        );
        const before = JSON.stringify(items);
        const output = automaticMemoryGroups(items);
        expect(automaticMemoryGroups([...items].reverse())).toEqual(output);
        expect(JSON.stringify(items)).toBe(before);
        expect([...output.coverage, ...output.items].map(row => row.uri).sort()).toEqual(
          items.map(row => row.uri).sort(),
        );
        expect(output.items.map(row => (row.state === 'ready' ? 0 : 1))).toEqual(
          output.items.map(row => (row.state === 'ready' ? 0 : 1)).sort(),
        );
      },
    ),
    {numRuns: 40},
  );
});

it('shows ordinary new and upgraded unenrolled memories with truthful progress and ready Review', async () => {
  const states: ManagerAutomaticMemoryItem['state'][] = [
    'queued',
    'generating',
    'waiting-model',
    'waiting-budget',
    'paused',
    'policy',
    'retry',
    'failed',
  ];
  vi.stubGlobal('fetch', async () =>
    json({
      version: 1,
      project: 'project',
      omitted: 0,
      items: [
        item({title: 'New ordinary memory', state: 'queued'}),
        item({uri: `${uri}/upgraded`, title: 'Upgraded ordinary memory', state: 'ready', reviewId}),
        ...states.map(state =>
          item({uri: `${uri}/${state}`, title: state, state, nextEligibleAt: 1_790_000_000_000, retryCount: 1}),
        ),
        item({uri: `${uri}/legacy`, legacyUncited: true}),
        item({uri: `${uri}/legacy2`, legacyUncited: true}),
      ],
    }),
  );
  await render(<AutomaticMemoryPanel project="project" />);
  expect(document.querySelector('.automatic-memory-card h4')?.textContent).toBe('Upgraded ordinary memory');
  expect(button('Review update')).toBeDefined();
  for (const text of [
    'Queued',
    'Generating draft',
    'Model setup needed',
    'Waiting for generation budget',
    'paused',
    'Waiting for policy',
    'bounded retry',
    'stopped',
    '2 older or uncited',
    'provisional unknown',
    'Next eligible',
  ])
    expect(document.body.textContent).toContain(text);
  expect(document.body.textContent).not.toMatch(/\d+%|Generate|Enroll|up to date/u);
  expect(document.querySelectorAll('.automatic-memory-coverage')).toHaveLength(1);
});

it('reconciles only the exact verified project, review, target and evidence, idempotently', () => {
  const completed = review({state: 'applied', verified: true, approval: {...approval(), stage: 'written'}});
  fc.assert(
    fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      fc.boolean(),
      (sameProject, sameReview, sameTarget, sameEvidence) => {
        const row = item({
          reviewId: sameReview ? reviewId : 'other-review',
          uri: sameTarget ? uri : `${uri}/other`,
          evidenceRevision: sameEvidence ? hash : 'b'.repeat(64),
        });
        const project = sameProject ? 'project' : 'other';
        const result = reconcileAutomaticMemoryItems([row], project, [completed]);
        expect(result).toHaveLength(sameProject && sameReview && sameTarget && sameEvidence ? 0 : 1);
        expect(reconcileAutomaticMemoryItems(result, project, [completed])).toEqual(result);
        expect(reconcileAutomaticMemoryItems([row], project, [{...completed, verified: false}])).toEqual([row]);
      },
    ),
    {numRuns: 40},
  );
});

it.each(['durable', 'preference', 'incident'] as const)(
  'replaces normal %s Library enrollment with automatic coverage and preserves shared owner guidance',
  async kind => {
    vi.stubGlobal('fetch', async () =>
      json({version: 1, project: 'project', omitted: 0, items: [item({route: 'shared-owner-review'})]}),
    );
    await render(
      <LibraryArticle
        node={{uri, name: 'ordinary.md', relativePath: 'ordinary.md', isDir: false, isShared: true, isSystem: false}}
        metadata={{
          kind,
          project: 'project',
          status: 'active',
          sourceAgentClient: 'user',
          timestamp: '2026-10-22',
        }}
        markdown="Ordinary body"
        resource={false}
      />,
    );
    expect(document.body.textContent).toContain('Assessment & support');
    expect(document.body.textContent).toContain('authorized team owner');
    expect(document.body.textContent).not.toContain('Enroll');
  },
);

it('requires the exact full preview and explicit confirmation; HTTP200 incomplete is not completion', async () => {
  const applied = vi.fn();
  const close = vi.fn();
  const posts: Record<string, unknown>[] = [];
  let current = review();
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      current =
        body.action === 'preview'
          ? review({revision: 2, approval: approval(), canApply: true})
          : review({
              revision: 3,
              state: 'applying',
              approval: {...approval(), stage: 'prepared'},
              canApply: true,
              canFinishVerification: true,
            });
    }
    return json(current);
  });
  await render(
    <AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={close} onApplied={applied} />,
  );
  expect(document.body.textContent).toContain('Accepted prose.');
  await click('Preview exact update');
  expect(document.querySelector('.automatic-review-exact pre')?.textContent).toContain(
    'reviewed_support: exact-provenance',
  );
  expect(button('Confirm and apply').disabled).toBe(true);
  await act(async () => {
    const checkbox = document.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    checkbox.click();
  });
  await click('Confirm and apply');
  expect(posts.at(-1)).toMatchObject({action: 'apply', revision: 2, approved: true, approvalDigest: hash});
  expect(applied).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('not yet verified');
  expect(button('Finish verification')).toBeDefined();
  current = review({state: 'applied', revision: 3, approval: {...approval(), stage: 'written'}, verified: true});
  vi.stubGlobal('fetch', async () => json(current));
  await click('Finish verification');
  expect(applied).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it('keeps the Library preview open and refreshes canonical content only after verified apply', async () => {
  const changed = vi.fn();
  let current = review();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/automatic-memory?'))
      return json({version: 1, project: 'project', omitted: 0, items: [item({state: 'ready', reviewId})]});
    if (init?.body) {
      const body = JSON.parse(String(init.body)) as {action: string};
      current =
        body.action === 'preview'
          ? review({revision: 2, approval: approval(), canApply: true})
          : review({revision: 3, state: 'applied', approval: {...approval(), stage: 'written'}, verified: true});
    }
    return json(current);
  });
  await render(<AutomaticMemoryPanel project="project" uri={uri} onChanged={changed} />);
  await click('Review update');
  await click('Preview exact update');
  expect(document.querySelector('.automatic-review-exact pre')?.textContent).toContain('exact-provenance');
  expect(document.querySelector('dialog')).not.toBeNull();
  expect(changed).not.toHaveBeenCalled();
  expect(button('Confirm and apply').disabled).toBe(true);
  await act(async () => document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await click('Confirm and apply');
  expect(changed).toHaveBeenCalledOnce();
  expect(document.querySelector('dialog')).toBeNull();
});

it('freezes preview controls synchronously and ignores a delayed response after target selection changes', async () => {
  const delayed = Promise.withResolvers<Response>();
  const applied = vi.fn();
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) {
      calls.push(String(init.body));
      return delayed.promise;
    }
    return json(review({project: 'other', reviewId: `review-${'b'.repeat(24)}`, targetUri: `${uri}/other`}));
  });
  const first = review();
  await render(
    <AutomaticMemoryReviewDialog
      project="project"
      reviewId={reviewId}
      initialReview={first}
      onClose={() => undefined}
      onApplied={applied}
    />,
  );
  await act(async () => {
    button('Preview exact update').click();
    button('Preview exact update').click();
  });
  expect(calls).toHaveLength(1);
  expect(button('Preview exact update').disabled).toBe(true);
  await render(
    <AutomaticMemoryReviewDialog
      project="other"
      reviewId={`review-${'b'.repeat(24)}`}
      onClose={() => undefined}
      onApplied={applied}
    />,
  );
  await act(async () => delayed.resolve(json(review({approval: approval(), canApply: true}))));
  expect(document.body.textContent).not.toContain('exact-provenance');
  expect(applied).not.toHaveBeenCalled();
});

it('keeps shared read-only proposals on the owner route without an apply control', async () => {
  const initial = review({
    ownerProposal: {
      instructions: 'An authorized team owner must review. Publication requires separate approval.',
      publicationApprovalRequired: true,
    },
  });
  await render(
    <AutomaticMemoryReviewDialog
      project="project"
      reviewId={reviewId}
      initialReview={initial}
      onClose={() => undefined}
    />,
  );
  expect(document.body.textContent).toContain('Publication requires separate approval');
  expect(button('Confirm and apply')).toBeUndefined();
  expect(button('Preview exact update')).toBeUndefined();
});

it('removes verified updates immediately and keeps them resolved after reselect, refresh and full remount', async () => {
  let completed = false;
  const row = item({state: 'ready', reviewId, evidenceRevision: hash});
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/automatic-memory'))
      return json({version: 1, project: url.searchParams.get('project'), omitted: 0, items: completed ? [] : [row]});
    if (init?.body) completed = true;
    return json(
      completed
        ? review({state: 'applied', verified: true, approval: {...approval(), stage: 'written'}})
        : review({canApply: true, revision: 2, approval: approval()}),
    );
  });
  await render(<AutomaticMemoryPanel project="project" />);
  await click('Review update');
  await act(async () => document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await click('Confirm and apply');
  expect(document.querySelector('dialog')).toBeNull();
  expect(document.querySelector('.automatic-memory-card')).toBeNull();
  expect(document.body.textContent).toContain('Update saved and verified');
  await render(<AutomaticMemoryPanel project="other" />);
  await render(<AutomaticMemoryPanel project="project" />);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh automatic updates"]')!.click());
  expect(document.querySelector('.automatic-memory-card')).toBeNull();
  await act(async () => root?.unmount());
  root = undefined;
  await render(<AutomaticMemoryPanel project="project" />);
  expect(document.querySelector('.automatic-memory-card')).toBeNull();
});

it('ignores late status responses after project reselection', async () => {
  const delayed = Promise.withResolvers<Response>();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const project = new URL(String(input), 'http://localhost').searchParams.get('project');
    return project === 'project'
      ? delayed.promise
      : json({version: 1, project, items: [item({title: 'Other project memory'})], omitted: 0});
  });
  await render(<AutomaticMemoryPanel project="project" />);
  await render(<AutomaticMemoryPanel project="other" />);
  await act(async () =>
    delayed.resolve(
      json({
        version: 1,
        project: 'project',
        items: [item({title: 'Late stale update', state: 'ready', reviewId})],
        omitted: 0,
      }),
    ),
  );
  expect(document.body.textContent).toContain('Other project memory');
  expect(document.body.textContent).not.toContain('Late stale update');
});

it('routes approved-support Save through manual preview with a full-content hash while ordinary Save stays available', async () => {
  const posts: Record<string, unknown>[] = [];
  const saved = vi.fn();
  const content =
    'MEMORY\nkind: durable\nreviewed_support: synthetic\n\nBefore.\n\n<!-- MEMORY_FIELDS\nlegacy indexing\n-->\n';
  const memory: MemoryResponse = {
    content,
    node: {uri, name: 'ordinary.md', relativePath: '', isDir: false, isShared: false, isSystem: false},
  };
  function Harness({supported}: {supported: boolean}) {
    const edit = useManualSupportEdit({selectedUri: uri, onError: () => undefined, onApplied: saved});
    return (
      <>
        <button
          onClick={() =>
            void edit
              .preview(
                supported ? memory : {...memory, content: 'MEMORY\nkind: durable\n\nBefore.'},
                content.replace('Before.', 'After.'),
                'project',
              )
              .then(handled => {
                if (!handled) saved();
              })
          }
        >
          Save
        </button>
        {edit.dialog}
      </>
    );
  }
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return json(
      review({
        purpose: 'manual-edit',
        targetHash: sha256HexSync(canonicalMemoryDocumentContent(content)),
        approval: approval(),
        canApply: true,
      }),
    );
  });
  await render(<Harness supported />);
  await click('Save');
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    action: 'manual-preview',
    expectedContentHash: sha256HexSync(canonicalMemoryDocumentContent(content)),
    desiredContent: content.replace('Before.', 'After.'),
  });
  expect(saved).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Affected support will be invalidated');
  await click('Close');
  await render(<Harness supported={false} />);
  await click('Save');
  expect(posts).toHaveLength(1);
  expect(saved).toHaveBeenCalledOnce();
});

it.each([1, 7, 101])('retains rejected manual review revision %s for the next revised Save', async revision => {
  const posts: Record<string, unknown>[] = [];
  const onError = vi.fn();
  const saved = vi.fn();
  const content = 'MEMORY\nkind: durable\nreviewed_support: synthetic\n\nBefore.';
  const memory: MemoryResponse = {
    content,
    node: {uri, name: 'ordinary.md', relativePath: '', isDir: false, isShared: false, isSystem: false},
  };
  function Harness() {
    const [desired, setDesired] = React.useState('First edit.');
    const edit = useManualSupportEdit({selectedUri: uri, onError, onApplied: saved});
    return (
      <>
        <button onClick={() => void edit.preview(memory, content.replace('Before.', desired), 'project')}>Save</button>
        <button onClick={() => setDesired('Revised edit.')}>Revise edit</button>
        {edit.dialog}
      </>
    );
  }
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posts.push(request);
    if (request.action === 'reject') {
      expect(request).toMatchObject({project: 'project', reviewId, revision});
      return json({
        version: 1,
        kind: 'topic-maintenance-recovery',
        project: 'project',
        reviewId,
        revision: revision + 1,
        state: 'rejected',
      });
    }
    if (posts.length > 1 && request.revision !== revision + 1) return json({error: 'Stale review revision'}, 409);
    return json(
      review({
        purpose: 'manual-edit',
        revision: posts.length === 1 ? revision : revision + 2,
        targetHash: sha256HexSync(canonicalMemoryDocumentContent(content)),
        approval: approval(),
        canApply: true,
      }),
    );
  });
  await render(<Harness />);
  await click('Save');
  await click('Reject');
  expect(document.querySelector('.automatic-review-dialog')).toBeNull();
  await click('Revise edit');
  await click('Save');
  expect(posts[2]).toMatchObject({
    action: 'manual-preview',
    project: 'project',
    reviewId,
    revision: revision + 1,
    desiredContent: content.replace('Before.', 'Revised edit.'),
  });
  expect(onError).not.toHaveBeenCalled();
  expect(saved).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Review your memory edit');
});

it.each(['reviewed_support: example', '```yaml\nreviewed_support: example\n```'])(
  'keeps ordinary Save available for a reviewed_support declaration in body prose: %s',
  async example => {
    const saved = vi.fn();
    const onError = vi.fn();
    const fetch = vi.fn();
    const content = `MEMORY\nkind: durable\n\nBefore.\n\n${example}`;
    vi.stubGlobal('fetch', fetch);
    function Harness() {
      const edit = useManualSupportEdit({selectedUri: uri, onError, onApplied: saved});
      return (
        <button
          onClick={() =>
            void edit
              .preview(
                {
                  content,
                  node: {uri, name: 'ordinary.md', relativePath: '', isDir: false, isShared: false, isSystem: false},
                },
                content.replace('Before.', 'After.'),
                'project',
              )
              .then(handled => {
                if (!handled) saved();
              })
          }
        >
          Save
        </button>
      );
    }
    await render(<Harness />);
    await click('Save');
    expect(saved).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  },
);

it.each(['pending', 'conflict'] as const)(
  'shows metadata-only %s recovery and rejects the exact obsolete review without applying',
  async state => {
    const close = vi.fn();
    const changed = vi.fn();
    const applied = vi.fn();
    const read = vi.fn();
    const posts: Record<string, unknown>[] = [];
    const recovery = {
      version: 1,
      kind: 'topic-maintenance-recovery',
      project: 'project',
      reviewId,
      revision: 5,
      state,
      recovery: {action: 'reject'},
    };
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body) return json(recovery);
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return json({...recovery, revision: 6, state: 'rejected', recovery: undefined});
    });
    await render(
      <AutomaticMemoryReviewDialog
        project="project"
        reviewId={reviewId}
        onClose={close}
        onChanged={changed}
        onApplied={applied}
        onRead={read}
      />,
    );
    expect(document.body.textContent).toContain('Private memory and source text are withheld');
    expect(document.querySelector('.automatic-review-comparison')).toBeNull();
    expect(button('Confirm and apply')).toBeUndefined();
    expect(button('Preview exact update')).toBeUndefined();
    await click('Reject obsolete review');
    expect(posts).toEqual([{action: 'reject', project: 'project', reviewId, revision: 5}]);
    expect(close).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce();
    expect(applied).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  },
);

it('navigates bounded pages to a late ready review and resets the cursor when the project changes', async () => {
  const lateUri = uri.replace('ordinary.md', 'late-139.md');
  const calls: URL[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    calls.push(url);
    const project = url.searchParams.get('project')!;
    const later = url.searchParams.has('afterUri');
    return json({
      version: 1,
      project,
      items: [
        item({
          uri: later ? lateUri : uri,
          title: later ? 'Late ready proposal' : 'First page memory',
          state: later ? 'ready' : 'unknown',
          ...(later ? {reviewId} : {}),
        }),
      ],
      omitted: 139,
      incomplete: true,
      ...(!later ? {nextCursor: uri} : {}),
    });
  });
  const summary = vi.fn();
  await render(<AutomaticMemoryPanel project="project" onSummaryChange={summary} />);
  expect(document.body.textContent).toContain('Coverage is still being assessed');
  expect(document.body.textContent).toContain('ready reviews appear first on each page');
  await click('Next memories');
  expect(calls.at(-1)?.searchParams.get('afterUri')).toBe(uri);
  expect(document.body.textContent).toContain('Late ready proposal');
  expect(button('Review update')).toBeDefined();
  expect(button('Next memories').disabled).toBe(true);
  await click('Previous memories');
  expect(calls.at(-1)?.searchParams.has('afterUri')).toBe(false);
  await click('Next memories');
  await render(<AutomaticMemoryPanel project="other-project" onSummaryChange={summary} />);
  expect(calls.at(-1)?.searchParams.get('project')).toBe('other-project');
  expect(calls.at(-1)?.searchParams.has('afterUri')).toBe(false);
  expect(summary).toHaveBeenLastCalledWith('other-project', {ready: 0, pending: true});
});
