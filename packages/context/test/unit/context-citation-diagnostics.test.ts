import {Array as EffectArray, Option as EffectOption} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  createMemoryCodeCitation,
  formatMemoryCodeCitation,
  MAX_MEMORY_CODE_CITATIONS,
  MEMORY_SCHEMA_VERSION,
  MAX_SUPPORTED_MEMORY_SCHEMA_VERSION,
} from '@threadnote/memory/code/citation';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {contextBriefMemoryCandidate} from '../../src/memory-evidence.js';
import {codeCitationFileEligibility} from '../../src/citation/capture.js';
import {assembleContextBriefLogicalResult, planContextBrief} from '../../src/planner.js';
import type {ContextBriefGraphEvidenceV1, ContextBriefCitationValidationReasonV2} from '../../src/types.js';
import {projectContextBrief, projectContextBriefAgentView} from '../../src/projector.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('Context Brief citation metadata diagnostics', () => {
  it('uses the public graph registry to distinguish unsupported source files', () => {
    expect(codeCitationFileEligibility('src/module.ts')).toBe('supported');
    expect(codeCitationFileEligibility('assets/unknown-filetype.zzz')).toBe('unsupported');
  });

  it('keeps valid supported citations free of metadata warnings', () => {
    const {logical} = diagnostic([citationLine(0)], MEMORY_SCHEMA_VERSION);
    expect(EffectArray.some(logical.stalenessAndConflicts, issue => issue.kind === 'invalid-code-citation')).toBe(
      false,
    );
    expect(logical.activeHandoffs[0].preciseStatus).toBe('exact');
  });

  it.each(['citation-limit', 'graph-stale', 'validation-error'] as const)(
    'preserves the displayed unknown citation reason %s within public response bounds',
    reason => {
      const {logical, record} = diagnostic([citationLine(0)], MEMORY_SCHEMA_VERSION, {
        linked: [0],
        unknown: [0],
        reason,
      });
      const memory = logical.activeHandoffs[0];
      expect(memory.codeRelations).toMatchObject([
        {citationId: record.metadata.codeCitations![0].id, status: 'unknown'},
      ]);
      expect(memory.citationReceipts).toEqual([
        {citationId: record.metadata.codeCitations![0].id, status: 'unknown', reason},
      ]);
      for (const format of ['dual', 'agent'] as const) {
        const projected = projectContextBrief(logical, 1250, format);
        expect(projected.measurement.estimatedTokens).toBeLessThanOrEqual(1250);
        const view = projectContextBriefAgentView(projected.structuredContent, true);
        expect(view.activeHandoffs?.[0].citationActions).toEqual([{count: 1, reason, status: 'unknown'}]);
        const serialized = JSON.stringify(projected);
        for (const privateValue of ['/private/source.ts', 'private-repository', 'private-snapshot']) {
          expect(serialized).not.toContain(privateValue);
        }
      }
    },
  );

  it('retains only one associated unknown and never substitutes unrelated unknown evidence', () => {
    const lines = [citationLine(0), citationLine(1), citationLine(2)];
    const unrelated = diagnostic(lines, MEMORY_SCHEMA_VERSION, {linked: [1], unknown: [0]});
    expect(unrelated.logical.activeHandoffs[0].citationReceipts).toBeUndefined();
    expect(unrelated.logical.activeHandoffs[0].codeRelations).toMatchObject([{status: 'exact'}]);
    const undisplayed = diagnostic(lines, MEMORY_SCHEMA_VERSION, {linked: [0, 1], unknown: [1]});
    expect(undisplayed.logical.activeHandoffs[0].codeRelations).toMatchObject([{status: 'exact'}]);
    expect(undisplayed.logical.activeHandoffs[0].citationReceipts).toBeUndefined();
    const associated = diagnostic(lines, MEMORY_SCHEMA_VERSION, {linked: [1, 2], unknown: [0, 1, 2]});
    expect(associated.logical.activeHandoffs[0].citationReceipts).toEqual([
      {citationId: associated.record.metadata.codeCitations![1].id, reason: 'graph-stale', status: 'unknown'},
    ]);
  });

  it('preserves relocation audit priority over unknown diagnostics and compacts exact receipts', () => {
    const audited = diagnostic([citationLine(0), citationLine(1)], MEMORY_SCHEMA_VERSION, {
      linked: [0, 1],
      unknown: [0],
      relocated: [1],
    });
    expect(audited.logical.activeHandoffs[0].citationReceipts).toMatchObject([
      {citationId: audited.record.metadata.codeCitations![1].id, status: 'relocated', relocationHint: 'src/moved.ts'},
    ]);
    expect(audited.logical.activeHandoffs[0].citationReceipts).toHaveLength(1);
    const exact = diagnostic([citationLine(0)], MEMORY_SCHEMA_VERSION, {linked: [0]});
    expect(exact.logical.activeHandoffs[0].citationReceipts).toBeUndefined();
  });

  it('reports a document schema mismatch without claiming its valid citation line was malformed', () => {
    const {logical, record} = diagnostic([citationLine(0)], MAX_SUPPORTED_MEMORY_SCHEMA_VERSION + 1);
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
  expect(
    EffectOption.getOrUndefined(
      EffectArray.findFirst(logical.stalenessAndConflicts, issue => issue.kind === 'invalid-code-citation'),
    )?.summary,
  ).toBe(`${count} code citation metadata error(s) were detected for synthetic-citation-diagnostic.`);
  expect(logical.activeHandoffs[0].preciseStatus).toBe('unknown');
  expect(logical.coverage.memory.unknown).toBe(1);
  expect(logical.coverage.gaps).toContain('memory-code-citations-invalid');
}

function citationLine(index: number): string {
  return formatMemoryCodeCitation(
    createMemoryCodeCitation({
      extractorSet: 'native-code-graph-13',
      fileContentHash: {algorithm: 'sha256', value: Effect.pipe('a', EffectString.repeat(64))},
      path: `src/citation-${index}.ts`,
      repositoryId: Effect.pipe('1', EffectString.repeat(64)),
      repositoryIdentityKind: 'remote',
      sourceCommit: Effect.pipe('2', EffectString.repeat(40)),
      sourceDirty: false,
      sourceGraphContentId: `cgc_${Effect.pipe('3', EffectString.repeat(40))}`,
      sourceSnapshotId: `cgsn_${Effect.pipe('4', EffectString.repeat(40))}`,
      target: {kind: 'file'},
      version: 1,
    }),
  );
}

function diagnostic(
  lines: readonly string[],
  schemaVersion: number,
  options: {
    readonly linked?: readonly number[];
    readonly unknown?: readonly number[];
    readonly relocated?: readonly number[];
    readonly reason?: ContextBriefCitationValidationReasonV2;
  } = {},
) {
  const uri = 'threadnote://user/tester/memories/handoffs/active/synthetic/synthetic-citation-diagnostic.md';
  const record = parseMemoryDocument(
    uri,
    EffectArray.join(
      [
        'MEMORY',
        'kind: handoff',
        'status: active',
        'topic: synthetic-citation-diagnostic',
        `schema_version: ${schemaVersion}`,
        ...EffectArray.map(lines, line => `code_citation: ${line}`),
        '',
        'Synthetic diagnostic evidence.',
      ],
      '\n',
    ),
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
      candidates: [
        {
          ...candidate,
          ...(options.linked === undefined
            ? {}
            : {
                codeLinkMatches: EffectArray.map(options.linked, index => ({
                  anchorOrdinal: index,
                  anchorPath: candidate.codeCitations[index].path,
                  citationId: candidate.codeCitations[index].id,
                  matchKind: 'file-path' as const,
                })),
              }),
        },
      ],
      citationValidations: [
        {
          uri,
          receipts: EffectArray.map(candidate.codeCitations, (citation, index) => ({
            candidateCount: 1,
            citationId: citation.id,
            coverage: 'current-complete' as const,
            kind: 'file' as const,
            observedAt,
            reason: options.unknown?.includes(index)
              ? (options.reason ?? 'graph-stale')
              : options.relocated?.includes(index)
                ? ('relocated' as const)
                : ('exact' as const),
            status: options.unknown?.includes(index)
              ? ('unknown' as const)
              : options.relocated?.includes(index)
                ? ('relocated' as const)
                : ('exact' as const),
            ...(options.unknown?.includes(index)
              ? {}
              : {observedPath: options.relocated?.includes(index) ? 'src/moved.ts' : citation.path}),
            sourcePath: '/private/source.ts',
            repositoryId: 'private-repository',
            snapshotId: 'private-snapshot',
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
