import {Array as EffectArray} from 'effect';
import {describe, expect, test} from 'vitest';
import {augmentRationaleFacts, captureRationaleInputs} from '@threadnote/graph/rationale';
import {parseCodeGraphRationaleCacheSnapshot} from '../helpers/rationale-cache.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile, CodeGraphSymbol} from '@threadnote/graph/types';

describe('code graph rationale extraction', () => {
  test('promotes explicit rationale comments and design references into provenance-tagged nodes', () => {
    const content = EffectArray.join(
      [
        'export function retry() {',
        '  // WHY: Jitter prevents coordinated retry storms.',
        '  // See ADR-104 for the bounded delay contract.',
        '}',
      ],
      '\n',
    );
    const file: CodeGraphInventoryFile = {
      blobId: 'blob',
      content,
      contentHash: 'hash',
      language: 'typescript',
      mode: '100644',
      path: 'src/retry.ts',
      size: content.length,
      source: 'commit',
    };
    const owner = symbol('retry', 1, 4);
    const facts: CodeGraphFileFacts = {diagnostics: [], edges: [], path: file.path, symbols: [owner]};

    const result = augmentRationaleFacts(file, facts);

    expect(EffectArray.map(result.symbols, value => [value.kind, value.name])).toEqual(
      expect.arrayContaining([
        ['rationale', 'WHY: Jitter prevents coordinated retry storms.'],
        ['rationale', 'ADR-104'],
      ]),
    );
    expect(result.edges).toHaveLength(2);
    expect(
      EffectArray.every(result.edges, edge => edge.relation === 'documents' && edge.provenance === 'declared'),
    ).toBe(true);
    expect(EffectArray.every(result.edges, edge => edge.targetId === owner.id)).toBe(true);
  });

  test('does not interpret binary asset bytes as rationale', () => {
    const file: CodeGraphInventoryFile = {
      blobId: 'blob',
      bytes: new Uint8Array([0, 1, 2]),
      contentHash: 'hash',
      language: 'image',
      mode: '100644',
      path: 'diagram.png',
      size: 3,
      source: 'commit',
    };
    const facts: CodeGraphFileFacts = {diagnostics: [], edges: [], path: file.path, symbols: []};
    expect(augmentRationaleFacts(file, facts)).toBe(facts);
  });

  test('derives rationale from compact cached inputs after full source content is released', () => {
    const content = 'export function retry() {\n  // WHY: Backoff prevents coordinated retries.\n}\n';
    const file: CodeGraphInventoryFile = {
      blobId: 'blob',
      content,
      contentHash: 'hash',
      language: 'typescript',
      mode: '100644',
      path: 'src/retry.ts',
      size: content.length,
      source: 'commit',
    };
    const facts: CodeGraphFileFacts = {diagnostics: [], edges: [], path: file.path, symbols: [symbol('retry', 1, 3)]};
    const cached = parseCodeGraphRationaleCacheSnapshot(JSON.stringify(captureRationaleInputs(file, facts)));
    const retainedFile: CodeGraphInventoryFile = {...file, content: undefined};

    const fresh = augmentRationaleFacts(file, cached);
    const rehydrated = augmentRationaleFacts(retainedFile, cached);

    expect(rehydrated.symbols).toEqual(fresh.symbols);
    expect(rehydrated.edges).toEqual(fresh.edges);
    expect(rehydrated.symbols).toEqual(
      expect.arrayContaining([expect.objectContaining({kind: 'rationale', path: 'src/retry.ts'})]),
    );
  });
});

function symbol(name: string, line: number, endLine: number): CodeGraphSymbol {
  return {
    contentHash: 'hash',
    exported: true,
    id: `symbol:${name}`,
    kind: 'function',
    language: 'typescript',
    name,
    path: 'src/retry.ts',
    qualifiedName: name,
    span: {column: 1, endColumn: 1, endLine, line},
  };
}
