import {describe, expect, it} from 'vitest';
import {
  createMemoryCodeCitation,
  formatMemoryCodeCitation,
  MAX_MEMORY_CODE_CITATIONS,
  MEMORY_SCHEMA_VERSION,
} from '@threadnote/memory/code/citation';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {contextBriefMemoryCandidate} from '../../src/memory-evidence.js';
import {assembleContextBriefLogicalResult, planContextBrief} from '../../src/planner.js';
import type {ContextBriefGraphEvidenceV1} from '../../src/types.js';

describe('Context Brief citation metadata diagnostics', () => {
  it('keeps valid supported citations free of metadata warnings', () => {
    const {logical} = diagnostic([citationLine(0)], MEMORY_SCHEMA_VERSION);
    expect(logical.stalenessAndConflicts.some(issue => issue.kind === 'invalid-code-citation')).toBe(false);
    expect(logical.activeHandoffs[0].preciseStatus).toBe('exact');
  });

  it('reports a document schema mismatch without claiming its valid citation line was malformed', () => {
    const {logical, record} = diagnostic([citationLine(0)], MEMORY_SCHEMA_VERSION + 1);
    expect(record.metadata.citationErrors).toEqual([{reason: 'schema-version-mismatch'}]);
    expect(record.metadata.codeCitations).toHaveLength(1);
    expectMetadataWarning(logical, 1);
    expect(logical.activeHandoffs[0].citationSummary).toMatchObject({exact: 1, unknown: 1});
  });

  it('reports a citation count limit without claiming the individually valid lines were malformed', () => {
    const lines = Array.from({length: MAX_MEMORY_CODE_CITATIONS + 1}, (_, index) => citationLine(index));
    const {logical, record} = diagnostic(lines, MEMORY_SCHEMA_VERSION);
    expect(record.metadata.citationErrors).toEqual([{index: MAX_MEMORY_CODE_CITATIONS, reason: 'too-many-citations'}]);
    expect(record.metadata.codeCitations).toHaveLength(MAX_MEMORY_CODE_CITATIONS);
    expectMetadataWarning(logical, 1);
  });

  it('still reports an actual invalid citation line and preserves unknown coverage', () => {
    const {logical, record} = diagnostic(['{malformed'], MEMORY_SCHEMA_VERSION);
    expect(record.metadata.citationErrors).toEqual([{index: 0, reason: 'invalid-json'}]);
    expectMetadataWarning(logical, 1);
  });
});

function expectMetadataWarning(logical: ReturnType<typeof assembleContextBriefLogicalResult>, count: number) {
  expect(logical.stalenessAndConflicts.find(issue => issue.kind === 'invalid-code-citation')?.summary).toBe(
    `${count} code citation metadata error(s) were detected for synthetic-citation-diagnostic.`,
  );
  expect(logical.activeHandoffs[0].preciseStatus).toBe('unknown');
  expect(logical.coverage.memory.unknown).toBe(1);
  expect(logical.coverage.gaps).toContain('memory-code-citations-invalid');
}

function citationLine(index: number): string {
  return formatMemoryCodeCitation(
    createMemoryCodeCitation({
      extractorSet: 'native-code-graph-13',
      fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
      path: `src/citation-${index}.ts`,
      repositoryId: '1'.repeat(64),
      repositoryIdentityKind: 'remote',
      sourceCommit: '2'.repeat(40),
      sourceDirty: false,
      sourceGraphContentId: `cgc_${'3'.repeat(40)}`,
      sourceSnapshotId: `cgsn_${'4'.repeat(40)}`,
      target: {kind: 'file'},
      version: 1,
    }),
  );
}

function diagnostic(lines: readonly string[], schemaVersion: number) {
  const uri = 'threadnote://user/tester/memories/handoffs/active/synthetic/synthetic-citation-diagnostic.md';
  const record = parseMemoryDocument(
    uri,
    [
      'MEMORY',
      'kind: handoff',
      'status: active',
      'topic: synthetic-citation-diagnostic',
      `schema_version: ${schemaVersion}`,
      ...lines.map(line => `code_citation: ${line}`),
      '',
      'Synthetic diagnostic evidence.',
    ].join('\n'),
  )!;
  const candidate = contextBriefMemoryCandidate(record, 0, undefined);
  const graph: ContextBriefGraphEvidenceV1 = {
    cards: [],
    contracts: [],
    coverage: {complete: true, consideredRepositories: 0, readyRepositories: 0, requestedRepositories: 0, states: {}},
    gaps: [],
    resolvedSnapshots: [],
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    warnings: [],
  };
  const observedAt = '2026-10-08T00:00:00.000Z';
  const logical = assembleContextBriefLogicalResult({
    graph,
    memory: {
      candidates: [candidate],
      citationValidations: [
        {
          uri,
          receipts: candidate.codeCitations.map(citation => ({
            candidateCount: 1,
            citationId: citation.id,
            coverage: 'current-complete' as const,
            kind: 'file' as const,
            observedAt,
            reason: 'exact' as const,
            status: 'exact' as const,
            strategy: 'file-path' as const,
            validatorVersion: 1 as const,
          })),
        },
      ],
      consideredCandidates: 1,
      gaps: [],
      trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
    },
    observedAt,
    plan: planContextBrief({
      budgetTokens: 1250,
      mode: 'brief',
      scope: {callerCwd: '/synthetic/repository', kind: 'repository'},
      task: 'Synthetic citation diagnostic',
    }),
  });
  return {logical, record};
}
