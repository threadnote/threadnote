import {describe, expect, it} from 'vitest';
import * as FC from 'fast-check';
import {
  graphEmbeddingDocumentInput,
  graphEmbeddingMinimumScore,
  graphEmbeddingQueryPrefix,
  graphEmbeddingTemplateVersion,
} from '@threadnote/graph/embedding';

describe('code graph embedding profiles', () => {
  it('uses Gemma full-dimension instructions, dynamic symbol titles, and a bumped recipe identity', () => {
    const gemma = {
      dimensions: 768,
      id: 'embeddinggemma-2-q8',
      promptPrefixes: {document: 'title: none | text: ', query: 'task: search result | query: '},
    } as const;
    expect(gemma.dimensions).toBe(768);
    expect(graphEmbeddingQueryPrefix(gemma)).toBe('task: search result | query: ');
    expect(graphEmbeddingMinimumScore(gemma)).toBe(0.7313320191591935);
    expect(graphEmbeddingTemplateVersion(gemma)).toBe(2);
    expect(
      graphEmbeddingDocumentInput(
        gemma.id,
        'graph.lookup',
        'function graph.lookup\npath: src/a.ts',
        gemma.promptPrefixes.document,
      ),
    ).toBe('title: graph.lookup | text: function graph.lookup\npath: src/a.ts');
  });

  it('preserves non-Gemma graph prompts, threshold, and index identity', () => {
    const bge = {id: 'bge-small-en-v1.5-q8', promptPrefixes: {document: '', query: ''}};
    expect(graphEmbeddingQueryPrefix(bge)).toBe('');
    expect(graphEmbeddingDocumentInput(bge.id, 'ignored', 'kind symbol', bge.promptPrefixes.document)).toBe(
      'kind symbol',
    );
    expect(graphEmbeddingMinimumScore(bge)).toBe(0.64);
    expect(graphEmbeddingTemplateVersion(bge)).toBe(1);
  });

  it('adds one dynamic Gemma title prefix for every qualified name and projected text', () => {
    FC.assert(
      FC.property(FC.string({minLength: 1, maxLength: 120}), FC.string({maxLength: 500}), (qualifiedName, text) => {
        const document = graphEmbeddingDocumentInput(
          'embeddinggemma-2-q8',
          qualifiedName,
          text,
          'title: none | text: ',
        );
        expect(document).toBe(`title: ${qualifiedName} | text: ${text}`);
      }),
      {numRuns: 100},
    );
  });
});
