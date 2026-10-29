import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import type {TreeNode} from '../../src/ui/contracts.js';
import {
  descendantMemoryUris,
  libraryScopeTree,
  librarySearchTree,
  memoryDocumentParts,
  reconcileMemorySelection,
  replaceMemoryBody,
  toggleMemorySelection,
} from '../../src/library_model.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const node = (name: string, children?: readonly TreeNode[], team?: string): TreeNode => ({
  name,
  uri: `threadnote://user/test/memories/${name}`,
  relativePath: name,
  isDir: children !== undefined,
  children,
  isSystem: Effect.pipe(name, EffectString.startsWith('.')),
  isShared: !!team,
  sharedTeam: team,
});

describe('Library recursive selection', () => {
  it('retains semantic and authored title matches with every ancestor while preserving the original tree', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.nat({max: 1000}), {minLength: 1, maxLength: 30}), ids => {
        const leaves = EffectArray.map(ids, id => node(`folder/nested/${id}.md`));
        const original = node('root', [node('folder', [node('folder/nested', leaves)])]);
        const selected = EffectArray.filter(leaves, (_, index) => index % 2 === 0);
        const recalled = new Set(EffectArray.map(selected, leaf => leaf.uri));
        const before = JSON.stringify(original);
        const result = librarySearchTree(original, 'unrelated query', recalled, false);
        expect(descendantMemoryUris(result!)).toEqual(EffectArray.map(selected, leaf => leaf.uri));
        expect(JSON.stringify(original)).toBe(before);
        expect(librarySearchTree(result, 'unrelated query', recalled, false)).toEqual(result);
      }),
      {numRuns: 60},
    );
    const titled = {
      ...node('opaque.md'),
      metadata: {
        kind: 'durable',
        sourceAgentClient: 'threadnote-test',
        status: 'active',
        timestamp: '2026-01-01T00:00:00.000Z',
        topic: 'Authored title',
      } satisfies TreeNode['metadata'],
    };
    expect(librarySearchTree(titled, 'authored', new Set(), false)).toBe(titled);
    expect(librarySearchTree(node('.system.md'), 'system', new Set(), false)).toBeUndefined();
  });
  it('selects collapsed descendants and preserves unrelated siblings when toggled', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.nat({max: 999}), {minLength: 1, maxLength: 30}), ids => {
        const leaves = EffectArray.map(ids, id => node(`folder/${id}.md`));
        const folder = node(
          'folder',
          EffectArray.map(leaves, (leaf, index) => node(`folder/nested-${index}`, [leaf])),
        );
        const original = new Set(['sibling.md']);
        const selected = toggleMemorySelection(original, folder, true);
        expect([...selected].sort()).toEqual(
          ['sibling.md', ...EffectArray.map(ids, id => `threadnote://user/test/memories/folder/${id}.md`)].sort(),
        );
        expect(toggleMemorySelection(selected, folder, true)).toEqual(selected);
        expect(toggleMemorySelection(selected, folder, false)).toEqual(original);
        expect(original).toEqual(new Set(['sibling.md']));
      }),
      {numRuns: 60},
    );
  });

  it('omits empty storage folders from a memory scope', () => {
    expect(libraryScopeTree(node('empty', []), 'local')).toBeUndefined();
    expect(libraryScopeTree(node('shared-empty', [], 'engineering'), 'team:engineering')).toBeUndefined();
  });

  it('drops removed records, excludes generated system files, and keeps surviving selections', () => {
    const one = node('one.md');
    const two = node('two.md');
    const tree = node('root', [one, node('.abstract.md')]);
    expect(descendantMemoryUris(tree)).toEqual([one.uri]);
    expect(reconcileMemorySelection(new Set([one.uri, two.uri]), tree)).toEqual(new Set([one.uri]));
    expect(reconcileMemorySelection(new Set([one.uri]), undefined).size).toBe(0);
  });

  it('separates local and individual team records without modifying the canonical tree', () => {
    const personal = node('local.md');
    const alpha = node('alpha.md', undefined, 'alpha');
    const beta = node('beta.md', undefined, 'beta');
    const tree = node('', [
      personal,
      node('shared', [node('shared/alpha', [alpha], 'alpha'), node('shared/beta', [beta], 'beta')]),
    ]);
    const before = JSON.stringify(tree);
    expect(descendantMemoryUris(libraryScopeTree(tree, 'local')!)).toEqual([personal.uri]);
    expect(descendantMemoryUris(libraryScopeTree(tree, 'team:alpha')!)).toEqual([alpha.uri]);
    expect(descendantMemoryUris(libraryScopeTree(tree, 'team:beta')!)).toEqual([beta.uri]);
    expect(JSON.stringify(tree)).toBe(before);
  });
});

describe('Markdown authoring boundary', () => {
  it('round trips original bytes and preserves headers and legacy fields across arbitrary body edits', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (body, replacement) => {
        const header =
          'MEMORY\nkind: durable\nmemory_id: stable-id\nrelation: references threadnote://memory/other\n\n';
        const trailer = '\n\n<!-- MEMORY_FIELDS\n{"version":1}\n-->\n';
        const content = header + body + trailer;
        expect(EffectArray.join(EffectRecord.values(memoryDocumentParts(content)), '')).toBe(content);
        expect(replaceMemoryBody(content, replacement)).toBe(header + replacement + trailer);
      }),
      {numRuns: 80},
    );
  });

  it('preserves a CRLF header and leaves ordinary Markdown unwrapped', () => {
    expect(replaceMemoryBody('HANDOFF\r\nkind: handoff\r\n\r\nold', '# New')).toBe(
      'HANDOFF\r\nkind: handoff\r\n\r\n# New',
    );
    expect(replaceMemoryBody('# Original', '- New')).toBe('- New');
  });
});
