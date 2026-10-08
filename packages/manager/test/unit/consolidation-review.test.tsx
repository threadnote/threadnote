// @vitest-environment happy-dom
import React, {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import {ConsolidationDraftReview, consolidationReviewProblem} from '../../src/consolidation_review.js';
import type {ConsolidationReview, ConsolidationSource} from '@threadnote/memory/consolidation';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';

const citation = createMemoryCodeCitation({
  extractorSet: 'test',
  fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
  path: 'source.ts',
  repositoryId: 'b'.repeat(64),
  repositoryIdentityKind: 'local',
  sourceCommit: 'c'.repeat(40),
  sourceDirty: false,
  sourceSnapshotId: `cgsn_${'d'.repeat(40)}`,
  target: {kind: 'file'},
  version: 1,
});
const source: ConsolidationSource = {
  uri: 'threadnote://user/test/memories/durable/global/source.md',
  revision: 'e'.repeat(64),
  fragments: ['Claim.'],
  codeCitations: [citation],
  relations: [{type: 'depends_on', uri: 'threadnote://memory/tn_target'}],
};
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it('requires an explicit decision and individual evidence selections; textarea edits invalidate the review', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  const selections: (readonly ConsolidationReview[])[] = [];
  function Harness() {
    const [draft, setDraft] = useState('Claim.');
    const [reviews, setReviews] = useState<readonly ConsolidationReview[]>([]);
    return (
      <ConsolidationDraftReview
        draft={draft}
        sources={[source]}
        reviews={reviews}
        disabled={false}
        busy={false}
        onDraftChange={setDraft}
        onReviewChange={r => {
          selections.push(r);
          setReviews(r);
        }}
      />
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Harness />));
  expect(container.textContent).toContain('Support is unresolved.');
  const decision = container.querySelector<HTMLSelectElement>('select')!;
  await act(async () => {
    decision.value = 'direct';
    decision.dispatchEvent(new Event('change', {bubbles: true}));
  });
  const useFragment = container.querySelector<HTMLInputElement>('input')!;
  await act(async () => useFragment.click());
  expect(selections.at(-1)?.[0]?.supports[0]?.citationIds).toEqual([]);
  const code = container.querySelector<HTMLInputElement>('[aria-label="source.ts for paragraph 1 fragment 1"]')!;
  await act(async () => code.click());
  expect(selections.at(-1)?.[0]?.supports[0]?.citationIds).toEqual([citation.id]);
  expect(consolidationReviewProblem('Claim.', [source], selections.at(-1)!)).toBeUndefined();
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(textarea, 'Edited claim.');
    textarea.dispatchEvent(new Event('input', {bubbles: true}));
  });
  expect(selections.at(-1)).toEqual([]);
  expect(container.textContent).toContain('Support is unresolved.');
});

it('validates browser evidence without Node Buffer and preserves UTF-8 resource bounds', () => {
  vi.stubGlobal('Buffer', undefined);
  const reviews: readonly ConsolidationReview[] = [
    {
      section: 'Claim.',
      disposition: 'direct',
      supports: [{sourceUri: source.uri, fragment: 0, citationIds: [citation.id], relationIndexes: [0]}],
    },
  ];
  expect(consolidationReviewProblem('Claim.', [source], reviews)).toBeUndefined();
  const unicode = {...source, uri: `threadnote://memory/${encodeURIComponent(`${'é'.repeat(127)}a`)}`};
  const reviewed = [{...reviews[0], supports: [{...reviews[0].supports[0], sourceUri: unicode.uri}]}];
  expect(consolidationReviewProblem('Claim.', [unicode], reviewed)).toBeUndefined();
  const oversized = {...unicode, uri: `threadnote://memory/${encodeURIComponent('é'.repeat(128))}`};
  expect(
    consolidationReviewProblem(
      'Claim.',
      [oversized],
      [{...reviewed[0], supports: [{...reviewed[0].supports[0], sourceUri: oversized.uri}]}],
    ),
  ).toContain('255');
});
