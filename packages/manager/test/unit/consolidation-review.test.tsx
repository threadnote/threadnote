// @vitest-environment happy-dom
import React, {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import {
  ConsolidationDraftReview,
  ConsolidationPanel,
  consolidationReviewProblem,
} from '../../src/consolidation_review.js';
import type {SelectId} from '../../src/ui/contracts.js';
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
  localStorage.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each([true, false])('offers local generation with actionable model choices (installed=%s)', async installed => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  const catalogs: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const agent = new URL(String(input), 'http://localhost').searchParams.get('agent')!;
    catalogs.push(agent);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          models:
            agent === 'local-ai'
              ? installed
                ? [
                    {id: 'local-default', label: 'Local default', isDefault: true},
                    {id: 'local-small', label: 'Local small', isDefault: false},
                  ]
                : []
              : [{id: 'external-model', label: 'External', isDefault: true}],
        }),
        {headers: {'content-type': 'application/json'}},
      ),
    );
  });
  const drafts: {agent: string; model: string}[] = [];
  function Harness() {
    const [agent, setAgent] = useState('codex');
    const [openSelect, setOpenSelect] = useState<SelectId>();
    return (
      <ConsolidationPanel
        standalone
        disabled={false}
        busy={false}
        canResume={false}
        topic=""
        project=""
        onTopicChange={() => {}}
        onProjectChange={() => {}}
        agents={[
          {id: 'codex', label: 'Codex', available: true},
          {id: 'local-ai', label: 'Threadnote local AI', available: installed},
          {id: 'cursor', label: 'Cursor', available: true},
          {id: 'copilot', label: 'Copilot', available: false},
        ]}
        agent={agent}
        onAgentChange={setAgent}
        openSelect={openSelect}
        setOpenSelect={setOpenSelect}
        canDraft
        drafting={false}
        applying={false}
        draft=""
        sources={[]}
        reviews={[]}
        onDraftChange={() => {}}
        onReviewChange={() => {}}
        hasJob={false}
        onDraft={model => drafts.push({agent, model})}
        onApply={() => {}}
        onResume={() => {}}
      />
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Harness />));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!.click());
  const choices = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  expect(choices.map(item => item.textContent)).toEqual([
    'Codex',
    `Threadnote local AI${installed ? '' : ' (install a model)'}`,
  ]);
  const local = choices.find(item => item.textContent?.startsWith('Threadnote local AI'))!;
  expect(local.disabled).toBe(false);
  await act(async () => local.click());
  expect(catalogs).toEqual(['codex', 'local-ai']);
  const model = container.querySelector<HTMLSelectElement>('[aria-label="Consolidation model"]')!;
  const generate = () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Generate draft')!;
  if (!installed) {
    expect(model.disabled).toBe(true);
    expect(generate().disabled).toBe(true);
    expect(container.textContent).toContain('install a generation model with threadnote models install <model-id>');
    expect(drafts).toEqual([]);
    return;
  }
  expect(model.value).toBe('local-default');
  await act(async () => {
    model.value = 'local-small';
    model.dispatchEvent(new Event('change', {bubbles: true}));
  });
  await act(async () => generate().click());
  expect(drafts).toEqual([{agent: 'local-ai', model: 'local-small'}]);
  expect(container.textContent).toContain('Your selected memories are processed on this computer.');
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
  expect(container.textContent).toContain('Choose a support option above to continue.');
  expect(container.textContent).toContain('0 of 1 reviewed');
  expect(container.textContent).toContain('Background context');
  const decision = container.querySelector<HTMLSelectElement>('select')!;
  await act(async () => {
    decision.value = 'direct';
    decision.dispatchEvent(new Event('change', {bubbles: true}));
  });
  const useFragment = container.querySelector<HTMLInputElement>('input')!;
  await act(async () => useFragment.click());
  expect(selections.at(-1)?.[0]?.supports[0]?.citationIds).toEqual([]);
  expect(container.textContent).toContain('1 of 1 reviewed');
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
  expect(container.textContent).toContain('Choose a support option above to continue.');
  expect(container.textContent).toContain('0 of 1 reviewed');
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
