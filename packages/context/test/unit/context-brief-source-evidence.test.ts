import * as BunServices from '@effect/platform-bun/BunServices';
import {fcProp} from '@threadnote/testing/fast-check-property';
import fc from 'fast-check';
import {describe, expect, it} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {codeGraphCitationSourceKey} from '@threadnote/graph/citation/source';
import type {CodeGraphQueryResult, RepositoryIdentity} from '@threadnote/graph/types';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {CommandExecutor} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {compileContextBriefWith} from '../../src/compiler.js';
import {planContextBrief} from '../../src/planner.js';
import {projectContextBriefAgentView} from '../../src/projector.js';
import {parseContextBriefRequestV1, type ContextBriefGraphEvidenceV1} from '../../src/types.js';
import {
  CONTEXT_BRIEF_SOURCE_MAXIMUM_FILES,
  CONTEXT_BRIEF_SOURCE_MAXIMUM_LINES_PER_RANGE,
  CONTEXT_BRIEF_SOURCE_MAXIMUM_RANGES_PER_FILE,
  materializeContextBriefSourceExcerpts,
  retrieveContextBriefSourceEvidence,
  selectContextBriefSourceRanges,
  type ContextBriefSourceRangeCandidateV1,
} from '../../src/graph/source_evidence.js';

const SourceReadTestLayer = Layer.mergeAll(
  BunServices.layer,
  Layer.succeed(CommandExecutor, {execute: () => Effect.die('commit fallback must stay disabled')} as never),
  Layer.succeed(SystemInfo, {environment: () => process.env, platform: process.platform} as never),
);

describe('Context Brief source evidence', () => {
  it('parses source detail as an explicit closed option while preserving the compact default', () => {
    const base = request();
    expect(parseContextBriefRequestV1(base)).not.toHaveProperty('detail');
    expect(parseContextBriefRequestV1({...base, detail: 'source'}).detail).toBe('source');
    expect(() => parseContextBriefRequestV1({...base, detail: 'live'})).toThrow('detail must be compact or source');
  });

  it.effect('projects bounded source in both channels and keeps explicit compact byte-compatible', () =>
    Effect.gen(function* () {
      const compile = (detail: 'compact' | 'source' | undefined, graph: ContextBriefGraphEvidenceV1) =>
        compileContextBriefWith(
          {
            graphEvidence: () => Effect.succeed(graph),
            memoryEvidence: () => Effect.succeed(emptyMemoryEvidence()),
          },
          {...request(), ...(detail === undefined ? {} : {detail})},
        );
      const compactImplicit = yield* compile(undefined, graphEvidence());
      const compactExplicit = yield* compile('compact', graphEvidence());
      expect(compactExplicit).toEqual(compactImplicit);

      const source = yield* compile('source', graphEvidence(true));
      expect(source.measurement.estimatedTokens).toBeLessThanOrEqual(1_250);
      expect(source.structuredContent.graph.sources).toEqual([
        expect.objectContaining({
          content: 'export const answer = 42;',
          freshness: 'fresh',
          path: 'src/answer.ts',
          startLine: 1,
        }),
      ]);
      const agent = projectContextBriefAgentView(source.structuredContent, true);
      expect(agent.graph?.sources).toEqual(source.structuredContent.graph.sources);
      expect(agent.answer).toContain('already read');
    }),
  );

  it('merges overlapping ranges, enforces file/range/line bounds, and preserves stable citations', () => {
    const selected = selectContextBriefSourceRanges([
      candidate(2, 'src/b.ts', 1, 80, 'b'),
      candidate(0, 'src/a.ts', 10, 20, 'a'),
      candidate(1, 'src/a.ts', 18, 30, 'c'),
      candidate(3, 'src/a.ts', 50, 52, 'd'),
      candidate(4, 'src/a.ts', 70, 72, 'e'),
      candidate(5, 'src/c.ts', 1, 2, 'f'),
      candidate(6, 'src/d.ts', 1, 2, 'g'),
    ]);

    expect(new Set(selected.map(range => range.path)).size).toBeLessThanOrEqual(CONTEXT_BRIEF_SOURCE_MAXIMUM_FILES);
    expect(selected.filter(range => range.path === 'src/a.ts')).toHaveLength(
      CONTEXT_BRIEF_SOURCE_MAXIMUM_RANGES_PER_FILE,
    );
    expect(
      selected.every(range => range.endLine - range.startLine + 1 <= CONTEXT_BRIEF_SOURCE_MAXIMUM_LINES_PER_RANGE),
    ).toBe(true);
    expect(selected[0]).toMatchObject({coveredGraphRefs: ['cgs_a', 'cgs_c'], endLine: 30, path: 'src/a.ts'});
  });

  it('merges in source order before ranking disjoint ranges', () => {
    const selected = selectContextBriefSourceRanges([
      candidate(0, 'src/a.ts', 50, 52, 'later'),
      candidate(1, 'src/a.ts', 10, 12, 'earlier'),
    ]);

    expect(selected).toEqual([
      expect.objectContaining({coveredGraphRefs: ['cgs_later'], rank: 0, startLine: 50}),
      expect.objectContaining({coveredGraphRefs: ['cgs_earlier'], rank: 1, startLine: 10}),
    ]);
  });

  it.layer(SourceReadTestLayer)(layerIt => {
    layerIt.effect('omits snapshot bytes when the indexed file changes before the exact-current read', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporaryRoot = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-context-source-'});
        const repositoryRoot = yield* fs.realPath(temporaryRoot);
        yield* fs.makeDirectory(path.join(repositoryRoot, 'src'), {recursive: true});
        const indexed = new TextEncoder().encode('export const answer = 42;\n');
        const file = path.join(repositoryRoot, 'src/answer.ts');
        yield* fs.writeFile(file, indexed);
        const result = sourceQueryResult(sha256HexSync(indexed));
        const identity = sourceRepositoryIdentity(repositoryRoot);

        const exact = yield* retrieveContextBriefSourceEvidence({
          identity,
          maximumContentBytes: 256,
          repositoryKey: 'owner/repo',
          result,
        });
        expect(exact.excerpts, JSON.stringify(exact)).toHaveLength(1);

        yield* fs.writeFile(file, new TextEncoder().encode('export const answer = 7;\n'));
        const changed = yield* retrieveContextBriefSourceEvidence({
          identity,
          maximumContentBytes: 256,
          repositoryKey: 'owner/repo',
          result,
        });
        expect(changed.excerpts).toEqual([]);
        expect(changed.gaps).toContain('graph-source-snapshot-not-current');
      }),
    );
  });

  it.effect('retains a line-bounded cited source at the maximum agent and dual budgets', () =>
    Effect.gen(function* () {
      const graph = largeSourceGraphEvidence();
      for (const responseFormat of ['agent', 'dual'] as const) {
        const projected = yield* compileContextBriefWith(
          {
            graphEvidence: () => Effect.succeed(graph),
            memoryEvidence: () => Effect.succeed(emptyMemoryEvidence()),
          },
          {...request(), budgetTokens: 1_500, detail: 'source', responseFormat},
        );
        const source = projected.structuredContent.graph.sources?.[0];
        expect(source).toBeDefined();
        expect(source?.coveredGraphRefs).toEqual([graph.cards[0].ref]);
        expect(source?.content.split('\n').length).toBeLessThanOrEqual(24);
        expect(source?.endLine).toBe(source!.startLine + source!.content.split('\n').length - 1);
        if (responseFormat === 'dual') expect(source?.truncated).toBe(true);
        expect(projected.measurement.estimatedTokens).toBeLessThanOrEqual(1_500);
      }
    }),
  );

  it.effect('reports an explicit source gap when an exact-current source line cannot fit the minimum dual budget', () =>
    Effect.gen(function* () {
      const graph = graphEvidence(true);
      const source = graph.sourceExcerpts![0];
      const projected = yield* compileContextBriefWith(
        {
          graphEvidence: () =>
            Effect.succeed({
              ...graph,
              sourceExcerpts: [{...source, content: 'x'.repeat(8_192), endLine: 1}],
            }),
          memoryEvidence: () => Effect.succeed(emptyMemoryEvidence()),
        },
        {...request(), budgetTokens: 800, detail: 'source', responseFormat: 'dual'},
      );

      expect(projected.structuredContent.graph.sources).toBeUndefined();
      expect(projected.structuredContent.coverage.gaps).toContain('graph-source-excerpt-omitted-for-budget');
      expect(projected.structuredContent.output.truncated).toBe(true);
    }),
  );

  it('allocates source bytes according to response-channel duplication', () => {
    const agent = planContextBrief({...request(), budgetTokens: 1_500, detail: 'source', responseFormat: 'agent'});
    const dual = planContextBrief({...request(), budgetTokens: 1_500, detail: 'source', responseFormat: 'dual'});
    expect(agent.graph.sourceMaximumBytes).toBe(dual.graph.sourceMaximumBytes * 2);
  });

  it('fails closed when source bytes cannot be resolved', () => {
    const ranges = selectContextBriefSourceRanges([candidate(0, 'src/a.ts', 1, 2, 'a')]);
    const result = materializeContextBriefSourceExcerpts({
      dirty: false,
      maximumContentBytes: 100,
      ranges,
      repositoryId: 'repository',
      repositoryKey: 'owner/repo',
      resolved: new Map(),
    });

    expect(result.excerpts).toEqual([]);
    expect(result.gaps).toEqual(['graph-source-evidence-unavailable', 'graph-source-resolution-incomplete']);
  });

  it('binds line-correct source to the selected hash and respects the content budget', () => {
    const ranges = selectContextBriefSourceRanges([candidate(0, 'src/a.ts', 2, 4, 'a')]);
    const source = {expectedContentHash: 'hash', repositoryPath: 'src/a.ts'};
    const result = materializeContextBriefSourceExcerpts({
      dirty: true,
      maximumContentBytes: 11,
      ranges,
      repositoryId: 'repository',
      repositoryKey: 'owner/repo',
      resolved: new Map([
        [codeGraphCitationSourceKey(source), new TextEncoder().encode('zero\none\ntwo\nthree\nfour')],
      ]),
    });

    expect(result.excerpts).toEqual([
      expect.objectContaining({
        content: 'one\ntwo',
        coveredGraphRefs: ['cgs_a'],
        endLine: 3,
        evidenceKind: 'current-dirty-overlay',
        freshness: 'fresh',
        path: 'src/a.ts',
        snapshotIdentity: 'current-dirty-overlay',
        startLine: 2,
        truncated: true,
      }),
    ]);
    expect(new TextEncoder().encode(result.excerpts[0].content).byteLength).toBeLessThanOrEqual(11);
  });

  fcProp(
    it,
    'selection is permutation invariant and idempotent',
    {seed: fc.array(fc.tuple(fc.integer({min: 1, max: 80}), fc.integer({min: 1, max: 24})), {maxLength: 24})},
    ({seed}) => {
      const candidates = seed.map(([start, length], rank) =>
        candidate(rank, `src/${String(rank % 5)}.ts`, start, start + length - 1, String(rank)),
      );
      const reversed = selectContextBriefSourceRanges([...candidates].reverse());
      const selected = selectContextBriefSourceRanges(candidates);
      expect(reversed).toEqual(selected);
      expect(selectContextBriefSourceRanges(selected)).toEqual(selected);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'disjoint source ranges retain their own citations regardless of relevance order',
    {
      seed: fc.record({
        earlierLength: fc.integer({min: 1, max: 24}),
        earlierStart: fc.integer({min: 1, max: 50}),
        gap: fc.integer({min: 1, max: 20}),
        laterLength: fc.integer({min: 1, max: 24}),
      }),
    },
    ({seed}) => {
      const earlierEnd = seed.earlierStart + seed.earlierLength - 1;
      const laterStart = earlierEnd + seed.gap;
      const selected = selectContextBriefSourceRanges([
        candidate(0, 'src/a.ts', laterStart, laterStart + seed.laterLength - 1, 'later'),
        candidate(1, 'src/a.ts', seed.earlierStart, earlierEnd, 'earlier'),
      ]);
      expect(selected).toHaveLength(2);
      expect(selected.find(range => range.coveredGraphRefs.includes('cgs_later'))?.startLine).toBe(laterStart);
      expect(selected.find(range => range.coveredGraphRefs.includes('cgs_earlier'))?.startLine).toBe(seed.earlierStart);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    it,
    'materialized content is monotone under larger budgets',
    {
      large: fc.integer({min: 1, max: 256}),
      small: fc.integer({min: 0, max: 255}),
    },
    ({large, small}) => {
      const lower = Math.min(small, large);
      const ranges = selectContextBriefSourceRanges([candidate(0, 'src/a.ts', 1, 24, 'a')]);
      const source = {expectedContentHash: 'hash', repositoryPath: 'src/a.ts'};
      const resolved = new Map([
        [
          codeGraphCitationSourceKey(source),
          new TextEncoder().encode(Array.from({length: 32}, (_, i) => `line-${i}`).join('\n')),
        ],
      ]);
      const smaller = materializeContextBriefSourceExcerpts({
        dirty: false,
        maximumContentBytes: lower,
        ranges,
        repositoryId: 'repository',
        repositoryKey: 'owner/repo',
        resolved,
      });
      const larger = materializeContextBriefSourceExcerpts({
        dirty: false,
        maximumContentBytes: large,
        ranges,
        repositoryId: 'repository',
        repositoryKey: 'owner/repo',
        resolved,
      });
      const smallerBytes = new TextEncoder().encode(smaller.excerpts[0]?.content ?? '').byteLength;
      const largerBytes = new TextEncoder().encode(larger.excerpts[0]?.content ?? '').byteLength;
      expect(smallerBytes).toBeLessThanOrEqual(largerBytes);
      expect(largerBytes).toBeLessThanOrEqual(large);
    },
    {fastCheck: {numRuns: 100}},
  );
});

function candidate(
  rank: number,
  path: string,
  startLine: number,
  endLine: number,
  ref: string,
): ContextBriefSourceRangeCandidateV1 {
  return {
    contentHash: 'hash',
    coveredGraphRefs: [`cgs_${ref}`],
    endLine,
    path,
    rank,
    startLine,
  };
}

function request() {
  return {
    budgetTokens: 1_250,
    mode: 'locate',
    responseFormat: 'agent',
    scope: {callerCwd: '/workspace/repository', kind: 'repository'},
    task: 'Locate the answer.',
  } as const;
}

function emptyMemoryEvidence() {
  return {
    candidates: [],
    consideredCandidates: 0,
    gaps: [],
    trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
  } as const;
}

function graphEvidence(withSource = false): ContextBriefGraphEvidenceV1 {
  const ref = `cgs_${'a'.repeat(32)}`;
  return {
    cards: [
      {
        id: 'cbgc_answer',
        rank: 0,
        reason: 'Indexed symbol match (1.000).',
        ref,
        repositoryKey: 'owner/repo',
        symbol: {
          kind: 'variable',
          language: 'typescript',
          line: 1,
          name: 'answer',
          path: 'src/answer.ts',
          qualifiedName: 'answer',
        },
      },
    ],
    contracts: [],
    coverage: {
      complete: true,
      consideredRepositories: 1,
      readyRepositories: 1,
      requestedRepositories: 1,
      states: {current: 1},
    },
    gaps: [],
    resolvedSnapshots: [
      {
        commit: 'b'.repeat(40),
        dirty: false,
        freshness: 'fresh',
        repositoryId: 'c'.repeat(64),
        repositoryKey: 'owner/repo',
        snapshotId: `cgsn_${'d'.repeat(40)}`,
      },
    ],
    ...(withSource
      ? {
          sourceExcerpts: [
            {
              content: 'export const answer = 42;',
              coveredGraphRefs: [ref],
              endLine: 1,
              evidenceKind: 'graph-snapshot' as const,
              freshness: 'fresh' as const,
              id: 'cbsx_answer',
              path: 'src/answer.ts',
              repositoryKey: 'owner/repo',
              snapshotIdentity: 'current-clean' as const,
              startLine: 1,
              truncated: false,
            },
          ],
        }
      : {}),
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    warnings: [],
  };
}

function largeSourceGraphEvidence(): ContextBriefGraphEvidenceV1 {
  const base = graphEvidence();
  const source = Array.from(
    {length: 24},
    (_, index) => `export const sourceLine${index.toString().padStart(2, '0')} = '${'x'.repeat(42)}';`,
  ).join('\n');
  return {
    ...base,
    sourceExcerpts: [
      {
        content: source,
        coveredGraphRefs: [base.cards[0].ref],
        endLine: 24,
        evidenceKind: 'graph-snapshot',
        freshness: 'fresh',
        id: 'cbsx_realistic_source',
        path: 'src/answer.ts',
        repositoryKey: 'owner/repo',
        snapshotIdentity: 'current-clean',
        startLine: 1,
        truncated: false,
      },
    ],
  };
}

function sourceQueryResult(contentHash: string): CodeGraphQueryResult {
  const ref = `cgs_${'a'.repeat(32)}`;
  return {
    edges: [],
    freshness: 'current',
    nodes: [
      {
        contentHash,
        exported: true,
        id: ref,
        kind: 'variable',
        language: 'typescript',
        name: 'answer',
        path: 'src/answer.ts',
        qualifiedName: 'answer',
        score: 1,
        span: {column: 1, endColumn: 26, endLine: 1, line: 1},
      },
    ],
    operation: 'query',
    repository: {displayName: 'owner/repo', repositoryId: 'c'.repeat(64)},
    snapshot: {commit: 'b'.repeat(40), dirty: true, id: `cgsn_${'d'.repeat(40)}`, worktreeId: 'e'.repeat(64)},
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    version: 1,
    warnings: [],
  };
}

function sourceRepositoryIdentity(repositoryRoot: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: 'a'.repeat(64),
    displayName: 'owner/repo',
    gitCommonDirectory: `${repositoryRoot}/.git`,
    headCommit: 'b'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: repositoryRoot,
    repositoryId: 'c'.repeat(64),
    worktreeId: 'e'.repeat(64),
  };
}
