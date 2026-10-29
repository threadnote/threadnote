import {Array as EffectArray} from 'effect';
import {isJsonObject} from '@threadnote/platform/json';
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
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';
import {Option as EffectOption} from 'effect';

function requireJsonObject(value: unknown): Record<string, unknown> {
  if (!isJsonObject(value)) throw new Error('Expected a JSON object.');
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string.');
  return value;
}

const hash = Effect.pipe('a', EffectString.repeat(64));
const uri = 'threadnote://user/test/memories/durable/projects/project/ordinary.md';
const reviewId = `review-${Effect.pipe('a', EffectString.repeat(24))}`;
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('retains the automatic card and model choice while checking, preserves failures until recovery, and pauses generation', async () => {
  const held = Promise.withResolvers<Response>();
  const retry = Promise.withResolvers<Response>();
  let reads = 0;
  const current = {version: 1, project: 'project', items: [item({canGenerate: true})], omitted: 0};
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://manager.test').pathname;
      if (path === '/api/attention/automatic-memory') {
        reads++;
        return reads === 1 ? Promise.resolve(json(current)) : reads === 2 ? held.promise : retry.promise;
      }
      if (path === '/api/consolidation-models')
        return Promise.resolve(
          json({
            models: [
              {id: 'first', label: 'First', isDefault: true},
              {id: 'chosen', label: 'Chosen', isDefault: false},
            ],
          }),
        );
      if (path === '/api/models/setup') return Promise.resolve(json({phase: 'ready', artifactReady: true}));
      throw new Error(`Unexpected request ${String(input)}`);
    }),
  );
  await render(<AutomaticMemoryPanel project="project" />);
  const card = document.querySelector<HTMLElement>('.automatic-memory-card')!;
  const disclosure = card.querySelector<HTMLDetailsElement>('details')!;
  await act(async () => {
    disclosure.open = true;
    disclosure.dispatchEvent(new Event('toggle'));
  });
  const model = document.querySelector<HTMLSelectElement>('[aria-label="Consolidation model"]')!;
  expect(model.value).toBe('first');
  await act(async () => {
    model.value = 'chosen';
    model.dispatchEvent(new Event('change', {bubbles: true}));
  });
  const generate = button('Generate now');
  expect(generate.disabled).toBe(false);
  const status = document.querySelector('.automatic-memory-refresh-status');
  model.focus();
  card.scrollTop = 160;
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh automatic updates"]')!.click());
  expect(document.querySelector('.automatic-memory-card')).toBe(card);
  expect(disclosure.open).toBe(true);
  expect(model.value).toBe('chosen');
  expect(document.activeElement).toBe(model);
  expect(model.disabled).toBe(false);
  expect(generate.disabled).toBe(true);
  expect(card.scrollTop).toBe(160);
  await act(async () => held.reject(new Error('Transient automatic read failure')));
  const alert = status?.querySelector('[role=alert]');
  expect(alert?.textContent).toContain('Transient automatic read failure');
  expect(generate.disabled).toBe(true);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh automatic updates"]')!.click());
  expect(status?.querySelector('[role=alert]')).toBe(alert);
  await act(async () => retry.resolve(json(current)));
  expect(status?.querySelector('[role=alert]')).toBeNull();
  expect(document.querySelector('.automatic-memory-refresh-status')).toBe(status);
  expect(document.querySelector('.automatic-memory-card')).toBe(card);
  expect(model.value).toBe('chosen');
  expect(document.activeElement).toBe(model);
  expect(generate.disabled).toBe(false);
});

it.each([403, 404, 409])('redacts automatic cards after a denied or invalid refresh (HTTP %s)', async code => {
  let denied = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      denied
        ? json({error: 'Automatic access ended'}, code)
        : json({version: 1, project: 'project', items: [item()], omitted: 0}),
    ),
  );
  await render(<AutomaticMemoryPanel project="project" />);
  expect(document.querySelector('.automatic-memory-card')).not.toBeNull();
  denied = true;
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh automatic updates"]')!.click());
  expect(document.querySelector('.automatic-memory-card')).toBeNull();
  expect(document.querySelector('[role=alert]')?.textContent).toContain('Automatic access ended');
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
  EffectOption.getOrUndefined(
    EffectArray.findFirst(
      [...document.querySelectorAll<HTMLButtonElement>('button')],
      __effectArrayValue =>
        !!(node =>
          Effect.pipe(node.textContent, effectOptionalString =>
            effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.includes(text)),
          ))(__effectArrayValue),
    ),
  )!;
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
        const items = EffectArray.map(rows, row =>
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
        expect(EffectArray.map([...output.coverage, ...output.items], row => row.uri).sort()).toEqual(
          EffectArray.map(items, row => row.uri).sort(),
        );
        expect(EffectArray.map(output.items, row => (row.state === 'ready' ? 0 : 1))).toEqual(
          EffectArray.map(output.items, row => (row.state === 'ready' ? 0 : 1)).sort(),
        );
      },
    ),
    {numRuns: 40},
  );
});

it('labels a no-update policy review as an assessment and retains update actions for active proposal routes', async () => {
  vi.stubGlobal('fetch', async () =>
    json({
      version: 1,
      project: 'project',
      omitted: 0,
      items: [
        item({state: 'policy', reviewId, reason: 'No update proposed. Waiting for sufficient evidence.'}),
        ...EffectArray.map(['ready', 'generating', 'queued'] as const, state =>
          item({
            uri: `${uri}/${state}`,
            state,
            reviewId: `${reviewId}-${state}`,
          }),
        ),
      ],
    }),
  );
  await render(<AutomaticMemoryPanel project="project" />);
  const assessment = document.querySelector('.automatic-memory-card[data-state=policy]');
  expect(assessment?.textContent).toContain('No update proposed. Waiting for sufficient evidence.');
  expect(assessment?.querySelector('button')?.textContent).toContain('View assessment');
  expect(assessment?.textContent).not.toContain('Review update');
  for (const state of ['ready', 'generating', 'queued'])
    expect(document.querySelector(`.automatic-memory-card[data-state=${state}] button`)?.textContent).toContain(
      'Review update',
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
    'preparing',
    'reviewed',
    'unknown',
    'deferred',
    'verification',
  ];
  vi.stubGlobal('fetch', async () =>
    json({
      version: 1,
      project: 'project',
      omitted: 0,
      items: [
        item({title: 'New ordinary memory', state: 'queued'}),
        item({uri: `${uri}/upgraded`, title: 'Upgraded ordinary memory', state: 'ready', reviewId}),
        ...EffectArray.map(states, state =>
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
  const tones = {
    preparing: 'info',
    queued: 'info',
    generating: 'info',
    ready: 'proposal',
    reviewed: 'info',
    'waiting-model': 'warning',
    'waiting-budget': 'neutral',
    paused: 'neutral',
    policy: 'warning',
    retry: 'warning',
    failed: 'danger',
    unknown: 'neutral',
    deferred: 'neutral',
    verification: 'warning',
  };
  for (const [state, tone] of EffectRecord.toEntries(tones)) {
    const card = document.querySelector(`.automatic-memory-card[data-state="${state}"]`)!;
    expect(card.getAttribute('data-tone')).toBe(tone);
    expect(card.querySelector('header .review-badge')?.getAttribute('data-tone')).toBe(tone);
    expect(card.querySelector('header .review-badge svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(card.querySelector('.automatic-memory-source-summary .review-badge')?.getAttribute('data-tone')).toBe(
      'neutral',
    );
  }
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
          evidenceRevision: sameEvidence ? hash : Effect.pipe('b', EffectString.repeat(64)),
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

it('automatically prepares the exact full preview and applies only on explicit click; HTTP200 incomplete is not completion', async () => {
  const applied = vi.fn();
  const close = vi.fn();
  const posts: Record<string, unknown>[] = [];
  let current = review();
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) {
      const body = requireJsonObject(JSON.parse(String(init.body)));
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
  expect(document.querySelector('.automatic-review-exact pre')?.textContent).toContain(
    'reviewed_support: exact-provenance',
  );
  expect(button('Apply update').disabled).toBe(false);
  await click('Apply update');
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

it.each(['insufficient-evidence', 'policy-conflict'] as const)(
  'shows %s as an assessment without preparing or presenting an unchanged rewrite',
  async outcome => {
    const initial = review();
    const assessment = review({
      coverage: {...coverage, outcome: 'partial', scope: 'recorded-only', omittedSources: 6},
      proposal: {
        ...initial.proposal,
        body: initial.acceptedBody,
        changedOrdinals: [],
        draft: {
          ...initial.proposal.draft,
          outcome,
          operations: [],
          paragraphDecisions: [{ordinal: 0, beforeHash: hash, role: 'unknown', support: 'unresolved', evidenceIds: []}],
          unresolvedQuestions: ['Which current evidence supports this claim?'],
        },
      },
    });
    const posts: unknown[] = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) posts.push(JSON.parse(String(init.body)));
      return json(assessment);
    });
    await render(<AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={() => undefined} />);
    expect(document.body.textContent).toContain('No update proposed');
    expect(document.body.textContent).toContain('accepted memory is unchanged');
    expect(document.body.textContent).toContain('Which current evidence supports this claim?');
    expect(document.querySelector('.review-proposal-preview')).toBeNull();
    expect(document.querySelector('.automatic-review-exact')).toBeNull();
    expect(document.querySelector('[role=alert]')).toBeNull();
    expect(button('Apply update')).toBeUndefined();
    expect(posts).toEqual([]);
    await render(<AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={() => undefined} />);
    expect(posts).toEqual([]);
  },
);

it('keeps the Library preview open and refreshes canonical content only after verified apply', async () => {
  const changed = vi.fn();
  const legacyChanged = vi.fn();
  let current = review();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (Effect.pipe(String(input), EffectString.includes('/automatic-memory?')))
      return json({version: 1, project: 'project', omitted: 0, items: [item({state: 'ready', reviewId})]});
    if (init?.body) {
      const body = requireJsonObject(JSON.parse(String(init.body)));
      current =
        body.action === 'preview'
          ? review({revision: 2, approval: approval(), canApply: true})
          : review({revision: 3, state: 'applied', approval: {...approval(), stage: 'written'}, verified: true});
    }
    return json(current);
  });
  await render(
    <LibraryArticle
      node={{name: 'ordinary.md', uri, relativePath: 'ordinary.md', isDir: false, isSystem: false, isShared: false}}
      metadata={{
        kind: 'durable',
        status: 'active',
        project: 'project',
        sourceAgentClient: 'user',
        timestamp: '2026-10-22T00:00:00Z',
      }}
      markdown="Accepted prose."
      resource={false}
      onChanged={legacyChanged}
      onVerifiedUpdate={changed}
    />,
  );
  await click('Review update');
  expect(document.querySelector('.automatic-review-exact pre')?.textContent).toContain('exact-provenance');
  expect(document.querySelector('dialog')).not.toBeNull();
  expect(changed).not.toHaveBeenCalled();
  expect(legacyChanged).not.toHaveBeenCalled();
  expect(button('Apply update').disabled).toBe(false);
  await click('Apply update');
  expect(changed).toHaveBeenCalledOnce();
  expect(legacyChanged).not.toHaveBeenCalled();
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
    return json(
      review({
        project: 'other',
        reviewId: `review-${Effect.pipe('b', EffectString.repeat(24))}`,
        targetUri: `${uri}/other`,
      }),
    );
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
  expect(calls).toHaveLength(1);
  expect(document.querySelector('.review-progress')?.textContent).toContain('Preparing the exact full preview');
  await render(
    <AutomaticMemoryReviewDialog
      project="other"
      reviewId={`review-${Effect.pipe('b', EffectString.repeat(24))}`}
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
  expect(button('Apply update')).toBeUndefined();
  expect(button('Preview exact update')).toBeUndefined();
});

it('removes verified updates immediately and keeps them resolved after reselect, refresh and full remount', async () => {
  let completed = false;
  const row = item({state: 'ready', reviewId, evidenceRevision: hash});
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (Effect.pipe(url.pathname, EffectString.endsWith('/automatic-memory')))
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
  await click('Apply update');
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
                Effect.pipe(content, EffectString.replace('Before.', 'After.')),
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
    posts.push(requireJsonObject(JSON.parse(String(init?.body))));
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
    desiredContent: Effect.pipe(content, EffectString.replace('Before.', 'After.')),
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
        <button
          onClick={() =>
            void edit.preview(memory, Effect.pipe(content, EffectString.replace('Before.', desired)), 'project')
          }
        >
          Save
        </button>
        <button onClick={() => setDesired('Revised edit.')}>Revise edit</button>
        {edit.dialog}
      </>
    );
  }
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = requireJsonObject(JSON.parse(String(init?.body)));
    posts.push(request);
    if (requireString(request.action) === 'reject') {
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
    desiredContent: Effect.pipe(content, EffectString.replace('Before.', 'Revised edit.')),
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
                Effect.pipe(content, EffectString.replace('Before.', 'After.')),
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
      posts.push(requireJsonObject(JSON.parse(String(init.body))));
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
    expect(button('Apply update')).toBeUndefined();
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
  const lateUri = Effect.pipe(uri, EffectString.replace('ordinary.md', 'late-139.md'));
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
  expect(document.body.textContent).toContain('Ready reviews appear first on each page');
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

it('shows a visible selected-review read state and stops loading after failure with a working retry', async () => {
  const read = Promise.withResolvers<Response>();
  vi.stubGlobal('fetch', () => read.promise);
  await render(<AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={() => undefined} />);
  expect(document.querySelector('.review-progress')?.textContent).toContain('Loading the selected review');
  expect(document.querySelector('.review-progress svg')?.getAttribute('width')).toBe('24');
  await act(async () => read.reject(new TypeError('Failed to fetch')));
  expect(document.body.textContent).toContain('Failed to fetch');
  expect(document.querySelector('.review-progress')).toBeNull();
  expect(document.body.textContent).not.toContain('Loading the selected review');
  expect(button('Reload exact review').disabled).toBe(false);
  vi.stubGlobal('fetch', async () => json(review()));
  await click('Reload exact review');
  expect(document.body.textContent).toContain('Accepted prose.');
  expect(document.querySelector('[role=alert]')?.textContent).toContain(
    'applicable exact approval preview is unavailable',
  );
});

it('shows preview progress at the action and focuses a ready preview with explicit apply controls', async () => {
  const preview = Promise.withResolvers<Response>();
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) {
      posts.push(requireJsonObject(JSON.parse(String(init.body))));
      return preview.promise;
    }
    return Promise.resolve(json(review()));
  });
  await render(<AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={() => undefined} />);
  expect(document.querySelector('.review-progress')?.textContent).toContain('Preparing the exact full preview');
  expect(posts).toHaveLength(1);
  await act(async () => preview.resolve(json(review({revision: 2, approval: approval(), canApply: true}))));
  const exact = document.querySelector('.automatic-review-exact');
  expect(document.activeElement).toBe(exact);
  expect(exact?.textContent).toContain('Preview ready');
  expect(exact?.querySelector('button')?.textContent).toBe('Apply update');
  expect(button('Apply update').disabled).toBe(false);
  expect(document.querySelector('.review-progress')).toBeNull();
  expect(posts).toHaveLength(1);
  expect(button('Apply update').disabled).toBe(false);
});

it('bounds an unresponsive selected-review read and enables retry without an endless loading label', async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
      const pending = Promise.withResolvers<Response>();
      init?.signal?.addEventListener('abort', () => pending.reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
      return pending.promise;
    });
    await render(<AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={() => undefined} />);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(document.body.textContent).toContain('timed out after 30000 ms');
    expect(document.querySelector('.review-progress')).toBeNull();
    expect(button('Reload exact review').disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('prepares once across StrictMode and same-selection renders without approving a write', async () => {
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) posts.push(requireJsonObject(JSON.parse(String(init.body))));
    return json(init?.body ? review({revision: 2, approval: approval(), canApply: true}) : review());
  });
  const view = () => (
    <React.StrictMode>
      <AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={() => undefined} />
    </React.StrictMode>
  );
  await render(view());
  await render(view());
  expect(posts).toEqual([{action: 'preview', project: 'project', reviewId, revision: 1}]);
  expect(button('Apply update').disabled).toBe(false);
  expect(button('Preview exact update')).toBeUndefined();
  expect(document.querySelector('input[type=checkbox]')).toBeNull();
});

it.each(['conflict', 'missing-preview', 'ineligible-preview'])(
  'stops after a bounded preparation reconciliation for %s and preserves the reason until retry succeeds',
  async failure => {
    const posts: Record<string, unknown>[] = [];
    let reads = 0;
    let recovered = false;
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body) {
        reads++;
        return json(recovered ? review({revision: 3, approval: approval(), canApply: true}) : review());
      }
      posts.push(requireJsonObject(JSON.parse(String(init.body))));
      return failure === 'conflict'
        ? json({error: 'Source changed before approval'}, 409)
        : json(review(failure === 'ineligible-preview' ? {approval: approval(), canApply: false} : {}));
    });
    await render(<AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={() => undefined} />);
    expect(reads).toBe(2);
    expect(posts).toHaveLength(1);
    expect(document.querySelector('[role=alert]')?.textContent).toContain(
      failure === 'conflict' ? 'Source changed before approval' : 'applicable exact approval preview is unavailable',
    );
    expect(button('Apply update')).toBeUndefined();
    await render(<AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={() => undefined} />);
    expect(posts).toHaveLength(1);
    expect(document.querySelector('[role=alert]')).not.toBeNull();
    recovered = true;
    await click('Reload exact review');
    expect(posts).toHaveLength(1);
    expect(button('Apply update').disabled).toBe(false);
    expect(document.querySelector('[role=alert]')).toBeNull();
  },
);

it('recovers an unknown preparation outcome by reusing canonical preview without replay', async () => {
  const posts: Record<string, unknown>[] = [];
  let reads = 0;
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.body)
      return json(++reads === 1 ? review() : review({revision: 2, approval: approval(), canApply: true}));
    posts.push(requireJsonObject(JSON.parse(String(init.body))));
    throw new TypeError('Connection closed after preparation');
  });
  await render(<AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={() => undefined} />);
  expect(reads).toBe(2);
  expect(posts).toHaveLength(1);
  expect(button('Apply update').disabled).toBe(false);
  expect(document.querySelector('[role=alert]')).toBeNull();
});

it('keeps failed Apply blocked until explicit reload and uses the newly displayed revision and digest', async () => {
  const posts: Record<string, unknown>[] = [];
  const nextDigest = Effect.pipe('b', EffectString.repeat(64));
  let current = review({revision: 2, approval: approval(), canApply: true});
  const close = vi.fn();
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.body) return json(current);
    posts.push(requireJsonObject(JSON.parse(String(init.body))));
    return json({error: 'Stale approval revision'}, 409);
  });
  await render(<AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={close} />);
  await act(async () => {
    button('Apply update').click();
    button('Apply update').click();
  });
  expect(posts).toEqual([
    {action: 'apply', project: 'project', reviewId, revision: 2, approvalDigest: hash, approved: true},
  ]);
  expect(document.querySelector('[role=alert]')?.textContent).toContain('Stale approval revision');
  expect(button('Apply update').disabled).toBe(true);
  expect(close).not.toHaveBeenCalled();
  current = review({revision: 7, approval: {...approval(), approvalDigest: nextDigest}, canApply: true});
  await click('Reload exact review');
  expect(posts).toHaveLength(1);
  await click('Apply update');
  expect(posts.at(-1)).toMatchObject({revision: 7, approvalDigest: nextDigest, approved: true});
});

it('aborts preparation on unmount and ignores its late result', async () => {
  const pending = Promise.withResolvers<Response>();
  let signal: AbortSignal | null | undefined;
  const read = vi.fn();
  vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.body) return Promise.resolve(json(review()));
    signal = init.signal;
    return pending.promise;
  });
  await render(
    <AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={() => undefined} onRead={read} />,
  );
  expect(signal?.aborted).toBe(false);
  await act(async () => root?.unmount());
  root = undefined;
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(json(review({revision: 2, approval: approval(), canApply: true}))));
  expect(read).toHaveBeenCalledTimes(1);
});

it('bounds preparation timeout and reuses its completed preview on the reconciliation read', async () => {
  vi.useFakeTimers();
  try {
    let reads = 0;
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body)
        return Promise.resolve(
          json(++reads === 1 ? review() : review({revision: 2, approval: approval(), canApply: true})),
        );
      posts.push(requireJsonObject(JSON.parse(String(init.body))));
      const pending = Promise.withResolvers<Response>();
      init.signal?.addEventListener('abort', () => pending.reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
      return pending.promise;
    });
    await render(<AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={() => undefined} />);
    expect(document.querySelector('.review-progress')?.textContent).toContain('Preparing the exact full preview');
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(posts).toHaveLength(1);
    expect(reads).toBe(2);
    expect(button('Apply update').disabled).toBe(false);
    expect(document.querySelector('.review-progress')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('uses in-app links for both previews and blocks navigation while an explicit write is owned', async () => {
  const open = vi.fn();
  const pending = Promise.withResolvers<Response>();
  const link = `[Related memory](<${uri}/related>)`;
  const initial = review({
    acceptedBody: link,
    proposal: {...review().proposal, body: link},
    approval: approval(),
    canApply: true,
  });
  vi.stubGlobal('fetch', () => pending.promise);
  await render(
    <AutomaticMemoryReviewDialog
      project="project"
      reviewId={reviewId}
      initialReview={initial}
      onClose={() => undefined}
      onOpenMemory={open}
    />,
  );
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.automatic-review-comparison a')];
  expect(EffectArray.map(links, node => node.getAttribute('href'))).toEqual([`${uri}/related`, `${uri}/related`]);
  for (const node of links)
    await act(async () => node.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true})));
  expect(open.mock.calls).toEqual([[`${uri}/related`], [`${uri}/related`]]);
  await act(async () => {
    button('Apply update').click();
    links[0].dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
  });
  expect(open).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve(json(initial)));
});

it('prepares a parked review only after explicit resume and uses its current revision', async () => {
  let current = review({state: 'deferred', approval: approval()});
  const posts: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) {
      const request = requireJsonObject(JSON.parse(String(init.body)));
      posts.push(request);
      current =
        request.action === 'resume'
          ? review({revision: 3})
          : review({revision: 4, approval: approval(), canApply: true});
    }
    return json(current);
  });
  await render(<AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={() => undefined} />);
  expect(posts).toEqual([]);
  expect(button('Apply update')).toBeUndefined();
  await click('Resume review');
  expect(posts).toEqual([
    {action: 'resume', project: 'project', reviewId, revision: 1},
    {action: 'preview', project: 'project', reviewId, revision: 3},
  ]);
  expect(button('Apply update').disabled).toBe(false);
});

it('refuses a recovery read that changes the selected target under the same review identity', async () => {
  let reads = 0;
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) throw new TypeError('Unknown prepare outcome');
    return json(
      ++reads === 1
        ? review()
        : review({
            targetUri: `${uri}/other`,
            acceptedBody: 'Wrong target private prose',
            approval: approval(),
            canApply: true,
          }),
    );
  });
  await render(<AutomaticMemoryReviewDialog project="project" reviewId={reviewId} onClose={() => undefined} />);
  expect(document.querySelector('[role=alert]')?.textContent).toContain('selected review changed');
  expect(document.body.textContent).not.toContain('Wrong target private prose');
  expect(button('Apply update')).toBeUndefined();
});
