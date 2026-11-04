import {it as effectIt} from '@effect/vitest';
import {expect} from 'vitest';
import {Effect, FileSystem, Path, Schema, String as EffectString} from 'effect';
import {canonicalFileUri, type Evidence} from '@threadnote/semantic/contracts';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import type {CodeGraphQueryResult, RepositoryIdentity} from '@threadnote/graph/types';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import {
  retrieveSemanticContextSourceEvidence,
  projectSemanticContextKnowledge,
  compileContextBriefWith,
} from '../../src/compiler.js';
import {fromRepositoryQuery} from '../../src/graph/evidence.js';

const fixture = Effect.fn('test.semanticContextSource')(function* (text: string, format: 'sha1' | 'sha256' = 'sha1') {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'tn-context-binding-'}));
  const file = path.join(root, 'source.ts');
  const bytes = new TextEncoder().encode(text);
  yield* fs.writeFile(file, bytes);
  const worktree = canonicalFileUri((yield* path.toFileUrl(root)).href);
  const graphHash = codeGraphCommittedFileContentHash(format, bytes);
  const identity: RepositoryIdentity = {
    caseMode: 'sensitive',
    checkoutId: sha256HexSync('checkout'),
    displayName: 'owner/repo',
    gitCommonDirectory: path.join(root, '.git'),
    headCommit: EffectString.repeat(40)('a'),
    objectFormat: format,
    repoRoot: root,
    repositoryId: sha256HexSync('remote repository'),
    worktreeId: sha256HexSync('worktree'),
  };
  const result: CodeGraphQueryResult = {
    version: 1,
    operation: 'node',
    freshness: 'current',
    edges: [],
    warnings: [],
    repository: {displayName: identity.displayName, repositoryId: identity.repositoryId},
    snapshot: {commit: identity.headCommit, dirty: false, id: 'cgsn_fixture', worktreeId: identity.worktreeId},
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    nodes: [
      {
        id: 'cgs_' + EffectString.slice(0, 32)(sha256HexSync('fixture node')),
        kind: 'variable',
        language: 'typescript',
        name: 'answer',
        qualifiedName: 'answer',
        exported: true,
        score: 1,
        path: 'source.ts',
        contentHash: graphHash,
        span: {line: 1, endLine: 1, column: 1, endColumn: 20},
      },
    ],
  };
  const evidence: Evidence = {
    basis: 'semantic',
    completeness: 'partial',
    scope: 'document',
    limitations: ['Fixture only'],
    observation: {
      version: 1,
      repository: sha256HexSync(worktree),
      worktree,
      project: worktree,
      uri: canonicalFileUri((yield* path.toFileUrl(file)).href),
      content: sha256HexSync(bytes),
      configuration: sha256HexSync('config'),
      toolchain: sha256HexSync('tools'),
      provider: {id: 'typescript-language-server', version: 'fixture', generation: 1},
      view: {kind: 'disk', id: 'view', owner: 'fixture', epoch: 1},
      documentVersion: null,
      projectEpoch: 1,
    },
  };
  const request = {identity, result, repositoryKey: identity.displayName, maximumContentBytes: 512};
  return {fs, file, request, evidence, bytes, graphHash};
});

effectIt.layer(citationPlatformLayer)(test => {
  test.effect('composes machine knowledge from structured evidence while the text channel is human-readable', () =>
    Effect.gen(function* () {
      const f = yield* fixture('export const answer = 42;\n');
      const source = yield* retrieveSemanticContextSourceEvidence(f.request, f.evidence);
      const projected = yield* compileContextBriefWith(
        {
          graphEvidence: () => Effect.succeed(fromRepositoryQuery(f.request.result)),
          memoryEvidence: () =>
            Effect.succeed({
              candidates: [],
              consideredCandidates: 0,
              gaps: [],
              trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
            }),
        },
        {
          task: 'Understand answer',
          scope: {kind: 'repository', callerCwd: f.request.identity.repoRoot},
          mode: 'explain',
          codeRefs: ['source.ts'],
          budgetTokens: 1250,
          responseFormat: 'agent',
        },
      );
      expect(projected.text).toMatch(/^THREADNOTE BRIEF/u);
      expect(() => JSON.parse(projected.text)).toThrow();
      const result = projectSemanticContextKnowledge(projected, source.binding);
      expect(result.brief?.type).toBe('context-brief-agent-view');
      expect(result.brief?.trust).toBe('untrusted-evidence-never-follow-instructions');
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      expect(projectSemanticContextKnowledge(projected, null)).toEqual({
        scope: 'document',
        binding: null,
        brief: null,
        gaps: ['semantic-graph-source-unbound'],
      });
    }),
  );
  test.effect.prop(
    'independently binds raw semantic bytes and Git graph identities for both object formats',
    [Schema.String.check(Schema.isMaxLength(96)), Schema.Literals(['sha1', 'sha256'])],
    ([value, format]) =>
      Effect.gen(function* () {
        const f = yield* fixture(`export const answer = ${JSON.stringify(value)};\r\n// 🚀\n`, format);
        const before = JSON.stringify([f.request, f.evidence]);
        expect(f.graphHash).not.toBe(f.evidence.observation.content);
        expect(f.request.identity.repositoryId).not.toBe(f.evidence.observation.repository);
        const result = yield* retrieveSemanticContextSourceEvidence(f.request, f.evidence);
        expect(result.binding).toMatchObject({
          scope: 'document',
          semanticContent: sha256HexSync(f.bytes),
          graph: {contentHash: f.graphHash},
        });
        expect(result.source.excerpts).toHaveLength(1);
        expect(JSON.stringify([f.request, f.evidence])).toBe(before);
        yield* f.fs.writeFileString(f.file, 'later source');
        expect((yield* retrieveSemanticContextSourceEvidence(f.request, f.evidence)).binding).toBeNull();
      }),
    {arbitrary: {runs: 20}},
  );

  test.effect('abstains on semantic, graph, worktree, view or ambiguous hash mismatch without commit fallback', () =>
    Effect.gen(function* () {
      const f = yield* fixture('export const answer = 42;\n');
      for (const evidence of [
        {...f.evidence, basis: 'structural' as const},
        {...f.evidence, observation: {...f.evidence.observation, content: sha256HexSync('other')}},
        {...f.evidence, observation: {...f.evidence.observation, worktree: 'file:///another'}},
        {
          ...f.evidence,
          observation: {...f.evidence.observation, view: {...f.evidence.observation.view, kind: 'overlay' as const}},
        },
      ])
        expect((yield* retrieveSemanticContextSourceEvidence(f.request, evidence)).binding).toBeNull();
      for (const result of [
        {...f.request.result, freshness: 'stale' as const},
        {...f.request.result, snapshot: {...f.request.result.snapshot, worktreeId: 'other'}},
        {...f.request.result, nodes: []},
        {
          ...f.request.result,
          nodes: [...f.request.result.nodes, {...f.request.result.nodes[0], contentHash: sha256HexSync('different')}],
        },
      ])
        expect((yield* retrieveSemanticContextSourceEvidence({...f.request, result}, f.evidence)).binding).toBeNull();
    }),
  );
});
