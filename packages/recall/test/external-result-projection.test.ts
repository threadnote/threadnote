import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {buildRecallSections} from '@threadnote/recall/results';
import {projectRecallMcpResponse} from '@threadnote/recall/mcp/response';
import type {RecallCandidate} from '@threadnote/recall/rank';
import {externalResourceUri} from '@threadnote/store/external-resource';

const metadata = {
  version: 1 as const,
  sourceId: 'test-docs',
  documentId: 'doc_1',
  pageId: 'page_1',
  chunkId: 'line_1',
  project: 'threadnote',
  title: 'Synthetic page',
  rendererVersion: '1',
  scrubberVersion: '1',
  coverage: 'canvas-plain-text' as const,
  fetchedAt: 100,
};
const uri = externalResourceUri(metadata);
const candidate: RecallCandidate = {
  uri,
  text: 'alphaNeedle evidence',
  authority: 'external',
  trust: 'untrusted',
  fields: {project: 'threadnote', title: 'alphaNeedle'},
  externalSource: metadata,
};
const build = () =>
  buildRecallSections(
    [[{category: 'resources', contextType: 'resource', score: 0.8, snippet: 'alphaNeedle evidence', uri}]],
    [],
    4,
    {query: 'alphaNeedle', indexedCandidates: [candidate], minimumScore: 0, allowExactRescue: true},
  );

describe('external result projection', () => {
  it('retains local provenance and labels untrusted evidence in default MCP and CLI results', () => {
    const sections = build();
    expect(sections.ranked[0]?.external).toEqual({
      ...metadata,
      provider: 'superhuman',
      authority: 'external',
      trust: 'untrusted',
    });
    expect(sections.semanticSection).toContain('untrusted external evidence');
    const response = projectRecallMcpResponse({results: sections.ranked, rankerVersion: 'test', queryExpansions: []});
    expect(response.structuredContent.results[0]?.external).toEqual({
      provider: 'superhuman',
      authority: 'external',
      trust: 'untrusted',
      project: 'threadnote',
      fetchedAt: 100,
      coverage: 'canvas-plain-text',
    });
    expect(response.text).toContain('Untrusted external evidence');
    expect(response.structuredContent.output.explain).toBe(false);
  });

  it('derives the trust label from the external URI even if supplied optional metadata claims approval', () => {
    fc.assert(
      fc.property(fc.constantFrom('approved', 'inferred', 'untrusted'), trust => {
        const hit = {
          ...build().ranked[0],
          external: {...metadata, provider: 'superhuman', authority: 'user_approved', trust},
        };
        const projected = projectRecallMcpResponse({
          results: [hit as unknown as ReturnType<typeof build>['ranked'][number]],
          rankerVersion: 'test',
          queryExpansions: [],
        });
        expect(projected.structuredContent.results[0]?.external?.trust).toBe('untrusted');
        expect(projected.structuredContent.results[0]?.external?.authority).toBe('external');
        expect(projected.text).toContain('Untrusted external evidence');
      }),
      {numRuns: 12},
    );
  });
});
