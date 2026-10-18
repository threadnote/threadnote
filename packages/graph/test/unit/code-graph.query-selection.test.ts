import {describe, expect, it} from '@effect/vitest';
import {fcProp} from '@threadnote/testing/fast-check-property';
import fc from 'fast-check';
import type {CodeGraphQueryNode, CodeGraphQueryResult} from '@threadnote/graph/types';
import {sanitizeSelection} from '../../src/query/selection.js';

const node = (index: number, characters: number): CodeGraphQueryNode => ({
  contentHash: 'a'.repeat(64),
  documentation: '漢'.repeat(characters),
  exported: true,
  id: `node-${index}`,
  kind: 'function',
  language: 'typescript',
  name: `node${index}`,
  path: `src/node${index}.ts`,
  qualifiedName: `node${index}`,
  score: 1,
  span: {column: 1, endColumn: 2, endLine: 1, line: 1},
});
const coverage = (
  status: 'exhaustive' | 'found' | 'timed-out',
): NonNullable<CodeGraphQueryResult['searchCoverage']> => ({
  status,
  limitsReached: status === 'timed-out' ? ['time-budget'] : [],
  visitedNodes: 200,
  inspectedEdges: 0,
  directEdgeChecked: false,
});

describe('graph selection coverage', () => {
  it('marks byte-clipped complete and found results bounded while preserving timeout evidence', () => {
    for (const status of ['exhaustive', 'found', 'timed-out'] as const) {
      const input = {
        nodes: Array.from({length: 200}, (_, index) => node(index, 4096)),
        edges: [],
        warnings: [],
        searchCoverage: coverage(status),
      };
      const result = sanitizeSelection(input);
      expect(result.nodes.length).toBeLessThan(input.nodes.length);
      expect(result.searchCoverage?.status).toBe(status === 'timed-out' ? 'timed-out' : 'bounded');
      expect(result.searchCoverage?.limitsReached).toContain('output-bytes');
      expect(input.searchCoverage.limitsReached).not.toContain('output-bytes');
    }
  });

  fcProp(
    it,
    'never reports complete coverage after clipping or mutates the original evidence',
    {
      count: fc.integer({min: 1, max: 200}),
      characters: fc.integer({min: 0, max: 4096}),
    },
    ({count, characters}) => {
      const input = {
        nodes: Array.from({length: count}, (_, index) => node(index, characters)),
        edges: [],
        warnings: [],
        searchCoverage: coverage('exhaustive'),
      };
      const before = JSON.stringify(input);
      const result = sanitizeSelection(input);
      const bytes = result.nodes.reduce(
        (total, item) => total + new TextEncoder().encode(JSON.stringify(item)).byteLength,
        0,
      );
      expect(bytes).toBeLessThanOrEqual(256 * 1024);
      expect(JSON.stringify(input)).toBe(before);
      expect(result.nodes.every(item => input.nodes.some(original => original.id === item.id))).toBe(true);
      if (result.nodes.length < input.nodes.length) {
        expect(result.searchCoverage?.status).toBe('bounded');
        expect(result.searchCoverage?.limitsReached).toContain('output-bytes');
      } else expect(result.searchCoverage).toEqual(input.searchCoverage);
    },
    {fastCheck: {numRuns: 25}},
  );
});
