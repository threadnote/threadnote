import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  workflowArchiveStem,
  workflowFamilyStem,
  workflowMemoryStem,
  workflowNamingPolicyVersion,
  workflowTitleSlug,
  type WorkflowNameFamily,
} from '../src/naming.js';

const caught = (run: () => unknown): unknown => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

const family = (title: string, ordinal = 1): WorkflowNameFamily => ({
  policyVersion: workflowNamingPolicyVersion,
  slug: workflowTitleSlug(title),
  ordinal,
});

describe('native workflow naming policy', () => {
  it('creates readable stems for common document families, roles, versions, and archives', () => {
    const examples = [
      ['Workflow spec', 'workflow-workflow-spec'],
      ['Plan: Caffè', 'workflow-plan-caffe'],
      ['Architecture — current', 'workflow-architecture-current'],
      ['Decisions & alternatives', 'workflow-decisions-alternatives'],
      ['State / transitions', 'workflow-state-transitions'],
    ] as const;
    for (const [title, expected] of examples) {
      const group = family(title);
      expect(workflowFamilyStem(group)).toBe(expected);
      expect(workflowMemoryStem(group, 'root')).toBe(`${expected}-root`);
    }
    const group = family('Workflow spec', 3);
    expect(workflowFamilyStem(group)).toBe('workflow-workflow-spec-3');
    expect(workflowMemoryStem(group, 'phase', 7)).toBe('workflow-workflow-spec-3-phase-v7');
    expect(workflowArchiveStem(group, 'phase', 7, 2)).toBe('workflow-workflow-spec-3-phase-v7-archive-2');
  });

  it('normalizes case, accents, compatibility characters, and unsafe title punctuation', () => {
    expect(workflowTitleSlug('  CAFÉ  ')).toBe('cafe');
    expect(workflowTitleSlug('Cafe\u0301')).toBe('cafe');
    expect(workflowTitleSlug('Ｐｌａｎ １２')).toBe('plan-12');
    expect(workflowTitleSlug('../../CON:$DATA. ')).toBe('con-data');
    expect(workflowFamilyStem(family('CON'))).toBe('workflow-con');
    expect(workflowMemoryStem(family('../CON. '), 'root')).toBe('workflow-con-root');
    expect(workflowTitleSlug('🧭🌊')).toBe('untitled');
    expect(workflowTitleSlug('世界 計画')).toBe('untitled');
  });

  it('resolves lossy and truncation collisions with explicit family ordinals', () => {
    expect(workflowTitleSlug('Café plan')).toBe(workflowTitleSlug('Cafe plan'));
    expect(workflowTitleSlug('a'.repeat(200))).toBe('a'.repeat(80));
    expect(workflowFamilyStem(family('Café plan', 1))).not.toBe(workflowFamilyStem(family('Cafe plan', 2)));
  });

  it('rejects malformed titles, noncanonical families, unsafe roles, and invalid ordinals', () => {
    for (const title of ['', ' \t\n ', 'bad\u0000title', 'x'.repeat(4097), '\ud800'])
      expect(caught(() => workflowTitleSlug(title))).toMatchObject({code: 'invalid-name'});
    for (const invalid of [
      {policyVersion: 2, slug: 'plan', ordinal: 1},
      {policyVersion: 1, slug: 'Plan', ordinal: 1},
      {policyVersion: 1, slug: 'plan..draft', ordinal: 1},
      {policyVersion: 1, slug: 'a'.repeat(81), ordinal: 1},
      {policyVersion: 1, slug: 'plan', ordinal: 0},
      {policyVersion: 1, slug: 'plan', ordinal: 1_000_001},
      {policyVersion: 1, slug: 'plan', ordinal: Number.MAX_SAFE_INTEGER + 1},
    ])
      expect(caught(() => workflowFamilyStem(invalid as WorkflowNameFamily))).toMatchObject({code: 'invalid-name'});
    for (const role of ['../outside', 'Root', 'root/path', 'a..b', 'a--b', 'a-'])
      expect(caught(() => workflowMemoryStem(family('Plan'), role))).toMatchObject({code: 'invalid-name'});
    expect(caught(() => workflowMemoryStem(family('Plan'), 'root', 0))).toMatchObject({code: 'invalid-name'});
    expect(caught(() => workflowArchiveStem(family('Plan'), 'root', 1, 1_000_001))).toMatchObject({
      code: 'invalid-name',
    });
  });

  it('keeps generated stems canonical, distinct by ordinal, and within filename byte limits', () => {
    const token = fc.constantFrom('A', 'a', 'é', 'e\u0301', 'ø', '世界', 'Ж', 'م', '🧭', ' ', '/', '-', '_');
    fc.assert(
      fc.property(
        fc.array(token, {maxLength: 90}).map(parts => parts.join('')),
        fc.integer({min: 1, max: 1_000_000}),
        fc.integer({min: 1, max: 1_000_000}),
        (title, ordinal, revision) => {
          const slug = workflowTitleSlug(title.trim().length === 0 ? 'Generated' : title);
          const currentFamily = {policyVersion: 1 as const, slug, ordinal};
          const familyStem = workflowFamilyStem(currentFamily);
          const memoryStem = workflowMemoryStem(currentFamily, 'architecture-current', revision);
          const archivedStem = workflowArchiveStem(currentFamily, 'architecture-current', revision, ordinal);
          expect(new TextEncoder().encode(slug).byteLength).toBeLessThanOrEqual(80);
          expect(workflowTitleSlug(slug)).toBe(slug);
          expect(workflowFamilyStem(currentFamily)).toBe(familyStem);
          expect(workflowFamilyStem({...currentFamily, ordinal: ordinal === 1 ? 2 : 1})).not.toBe(familyStem);
          for (const stem of [familyStem, memoryStem, archivedStem]) {
            expect(stem).not.toMatch(/[\\/:*?"<>|. ]/u);
            expect(new TextEncoder().encode(`${stem}.json`).byteLength).toBeLessThanOrEqual(200);
          }
        },
      ),
      {numRuns: 100},
    );
  });
});
