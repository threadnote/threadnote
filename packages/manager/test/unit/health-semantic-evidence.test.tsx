// @vitest-environment happy-dom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {buildContextHealthReport} from '@threadnote/context/health';
import type {MemoryRecord} from '@threadnote/memory/document';
import {HealthDetail} from '../../src/attention_details.js';
import {SemanticComparisonEvidence} from '../../src/attention/semantic_comparison.js';

function semanticFinding() {
  const memory = (name: string, body: string): MemoryRecord => ({
    body,
    content: body,
    headerTitle: 'MEMORY',
    uri: `threadnote://memory/${name}`,
    metadata: {
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-01-01',
    },
  });
  const records = [
    memory('a', '# Production\nTimeout is 60 seconds.'),
    memory('b', '# Production\nTimeout must be 30 seconds.'),
  ];
  return buildContextHealthReport({project: 'threadnote', records, now: new Date('2026-06-01')}).findings[0];
}

it('guides comparison with both original claims, applicability and collapsed revision evidence', () => {
  const finding = semanticFinding();
  const html = renderToStaticMarkup(
    <HealthDetail
      finding={finding}
      project="threadnote"
      repairsAvailable
      onClose={() => {}}
      onChanged={() => {}}
      onOpenLibrary={() => {}}
    />,
  );
  expect(html).toContain('Timeout is 60 seconds.');
  expect(html).toContain('Timeout must be 30 seconds.');
  expect(html).toContain('policy conflict');
  expect(html).toContain('uncertain comparison');
  expect(html).toContain('unknown validity');
  expect(html).toContain('Production');
  expect(html).toContain(finding.semanticEvidence!.left.recordContentFingerprint);
  expect(html).toContain('Compare conflicting memories');
  expect(html).toContain('Possible conflict · context needed');
  expect(html).toContain('Memory A');
  expect(html).toContain('Memory B');
  expect(html).toContain('Open memory A');
  expect(html).toContain('Open memory B');
  expect(html).toContain('Unknown');
  expect(html).toContain('How to review');
  expect(html).not.toContain('Preview repair');
  expect(html).not.toContain('What this means');
  expect(html).not.toContain('This memory has a quality issue');
  const host = document.createElement('div');
  host.innerHTML = html;
  for (const card of host.querySelectorAll('.semantic-memory-card')) {
    expect(card.querySelector('blockquote')).not.toBeNull();
    expect(card.querySelector('details')?.open).toBe(false);
    expect(card.querySelector('details')?.textContent).toContain('Source revision');
  }
});

it('distinguishes an established incompatibility and preserves known context and source identity', () => {
  const initial = semanticFinding().semanticEvidence!;
  const evidence = {
    ...initial,
    classification: 'incompatibility' as const,
    reason: 'incompatible-values' as const,
    uncertainty: [],
    left: {
      ...initial.left,
      recordUri: 'threadnote://user/test/memories/durable/projects/threadnote/production-timeout.md',
      context: {
        ...initial.left.context,
        workspaceScope: 'packages/runtime',
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
      },
    },
  };
  const html = renderToStaticMarkup(<SemanticComparisonEvidence evidence={evidence} onOpenLibrary={() => {}} />);
  expect(html).toContain('Conflict to review');
  expect(html).not.toContain('context needed');
  expect(html).not.toContain('Missing context');
  expect(html).toContain('production-timeout.md');
  expect(html).toContain('production timeout');
  expect(html).toContain('packages/runtime');
  expect(html).toContain('2026-01-01');
  expect(html).toContain('2026-12-31');
  expect(html).toContain('Observed behavior');
  expect(html).toContain('Required behavior');
});

it('opens each exact memory through its own action without a repair request or mutation', async () => {
  const finding = semanticFinding();
  const open = vi.fn();
  const changed = vi.fn();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(() => {});
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(() => {});
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <HealthDetail
          finding={finding}
          project="threadnote"
          repairsAvailable
          onClose={() => {}}
          onChanged={changed}
          onOpenLibrary={open}
        />,
      );
    });
    for (const label of ['A', 'B']) {
      const button = [...host.querySelectorAll('button')].find(
        value => value.textContent?.trim() === `Open memory ${label}`,
      );
      expect(button).toBeDefined();
      await act(async () => button!.click());
    }
    expect(open.mock.calls).toEqual([
      [finding.semanticEvidence!.left.recordUri],
      [finding.semanticEvidence!.right.recordUri],
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it('preserves arbitrary source quotations verbatim and leaves comparison evidence unchanged', () => {
  const original = semanticFinding().semanticEvidence!;
  fc.assert(
    fc.property(fc.string({minLength: 1, maxLength: 160}), fc.string({minLength: 1, maxLength: 160}), (left, right) => {
      const evidence = {...original, left: {...original.left, text: left}, right: {...original.right, text: right}};
      const snapshot = JSON.stringify(evidence);
      const host = document.createElement('div');
      host.innerHTML = renderToStaticMarkup(
        <SemanticComparisonEvidence evidence={evidence} onOpenLibrary={() => {}} />,
      );
      expect([...host.querySelectorAll('blockquote')].map(quote => quote.textContent)).toEqual([left, right]);
      expect(JSON.stringify(evidence)).toBe(snapshot);
    }),
    {numRuns: 30},
  );
});

it('offers accessible A/B and both-context choices without selecting a winner or writing memories', async () => {
  const evidence = semanticFinding().semanticEvidence!;
  const choose = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <SemanticComparisonEvidence evidence={evidence} onOpenLibrary={() => {}} selection={{onChoose: choose}} />,
      ),
    );
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Which memory is correct?');
    const inputs = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(inputs.map(input => input.value)).toEqual(['left', 'right', 'both']);
    expect(inputs.every(input => !input.checked)).toBe(true);
    expect(new Set(inputs.map(input => input.name)).size).toBe(1);
    for (const input of inputs) await act(async () => input.click());
    expect(choose.mock.calls).toEqual([['left'], ['right'], ['both']]);
    await act(async () =>
      root.render(
        <SemanticComparisonEvidence
          evidence={evidence}
          onOpenLibrary={() => {}}
          selection={{choice: 'right', onChoose: choose, disabled: true}}
        />,
      ),
    );
    expect(host.querySelector<HTMLInputElement>('input[value="right"]')?.checked).toBe(true);
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].every(input => input.disabled)).toBe(
      true,
    );
    expect(host.textContent).toContain('does not change anything');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
