import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import type {CodeGraphQueryResult} from '@threadnote/graph/types';
import {UNAVAILABLE_IMPACT_BASE_WARNING} from '@threadnote/graph/query/impact_base';
import {
  MAXIMUM_CONTEXT_CHECK_CAPTURE_ADVISORIES,
  citedDocumentCitationUris,
  selectContextCheckGraphImpact,
} from '@threadnote/threadnote/context_check/graph_impact';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import type {MemoryRecord} from '@threadnote/memory/document';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const repositoryId = Effect.pipe('a', EffectString.repeat(64));

describe('Context Check graph impact selection', () => {
  it('selects indirectly impacted cited memories and suppresses covered capture advisories', () => {
    const dependent = record('dependent', 'src/dependent.ts');
    const changed = record('changed', 'src/changed.ts');
    const impact = selectContextCheckGraphImpact(
      result(['src/dependent.ts', 'src/changed.ts']),
      [dependent, changed],
      repositoryId,
      ['src/changed.ts'],
      [changed.uri],
    );

    expect(impact).toEqual({captureAdvisoryIds: [], impactedMemoryUris: [dependent.uri], status: 'complete'});
  });

  it('fails closed on stale or partial graph evidence', () => {
    expect(selectContextCheckGraphImpact(undefined, [], repositoryId, ['src/changed.ts'], [])).toEqual({
      reason: 'graph-impact-evidence-unavailable',
      status: 'unknown',
    });
    expect(
      selectContextCheckGraphImpact(
        {...result(['src/dependent.ts']), warnings: ['results are partial']},
        [],
        repositoryId,
        ['src/changed.ts'],
        [],
      ),
    ).toEqual({reason: 'graph-impact-evidence-incomplete', status: 'unknown'});
  });

  it('does not require a historical base snapshot when every changed path resolves in the current graph', () => {
    const currentOnly = {...result(['src/changed.ts']), warnings: [UNAVAILABLE_IMPACT_BASE_WARNING]};
    expect(selectContextCheckGraphImpact(currentOnly, [], repositoryId, ['src/changed.ts'], [])).toMatchObject({
      status: 'complete',
    });
    expect(selectContextCheckGraphImpact(currentOnly, [], repositoryId, ['src/missing.ts'], [])).toEqual({
      reason: 'graph-impact-evidence-incomplete',
      status: 'unknown',
    });
  });

  it('recognizes affected documentation citations without exposing their paths', () => {
    const documentation = record('documentation', 'docs/architecture.md');
    expect(citedDocumentCitationUris([documentation], repositoryId, [documentation.uri])).toEqual([
      `${documentation.uri}#${documentation.metadata.codeCitations?.[0]?.id}`,
    ]);
  });

  it('bounds and deterministically orders capture advisories (property)', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z]{1,12}$/u), {maxLength: 40}), names => {
        const paths = EffectArray.map(names, name => `src/${name}.ts`);
        const forward = selectContextCheckGraphImpact(result(paths), [], repositoryId, [], []);
        const reverse = selectContextCheckGraphImpact(result([...paths].reverse()), [], repositoryId, [], []);
        expect(forward).toEqual(reverse);
        expect(forward.status).toBe('complete');
        if (forward.status === 'complete') {
          expect(forward.captureAdvisoryIds.length).toBeLessThanOrEqual(MAXIMUM_CONTEXT_CHECK_CAPTURE_ADVISORIES);
        }
      }),
      {numRuns: 50},
    );
  });
});

function result(paths: readonly string[]): CodeGraphQueryResult {
  return {
    edges: [],
    freshness: 'current',
    nodes: EffectArray.map(paths, path => ({
      contentHash: sha256HexSync(path),
      exported: false,
      id: `cgs_${Effect.pipe(sha256HexSync(path), EffectString.slice(0, 32))}`,
      kind: 'function',
      language: 'typescript',
      name: path,
      path,
      qualifiedName: `test.${path}`,
      score: 1,
      span: {column: 1, endColumn: 2, endLine: 1, line: 1},
    })),
    operation: 'impact',
    repository: {displayName: 'example/repository', repositoryId},
    snapshot: {
      commit: Effect.pipe('b', EffectString.repeat(40)),
      dirty: true,
      id: `cgsn_${Effect.pipe('c', EffectString.repeat(40))}`,
      worktreeId: Effect.pipe('d', EffectString.repeat(64)),
    },
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    version: 1,
    warnings: [],
  };
}

function record(name: string, path: string): MemoryRecord {
  return {
    body: '',
    content: '',
    headerTitle: 'MEMORY',
    metadata: {
      codeCitations: [
        createMemoryCodeCitation({
          extractorSet: 'test',
          fileContentHash: {algorithm: 'sha256', value: Effect.pipe('e', EffectString.repeat(64))},
          path,
          repositoryId,
          repositoryIdentityKind: 'remote',
          sourceCommit: Effect.pipe('b', EffectString.repeat(40)),
          sourceDirty: false,
          sourceSnapshotId: `cgsn_${Effect.pipe('c', EffectString.repeat(40))}`,
          target: {kind: 'file'},
          version: 1,
        }),
      ],
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-09-17T00:00:00.000Z',
      topic: name,
    },
    uri: `threadnote://memory/${name}`,
  };
}
