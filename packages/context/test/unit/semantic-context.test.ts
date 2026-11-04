import {it as effectIt} from '@effect/vitest';
import {expect} from 'vitest';
import {Array as EffectArray, Effect, FileSystem, Layer, Path, Schema, String as EffectString} from 'effect';
import {canonicalFileUri, type Evidence} from '@threadnote/semantic/contracts';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import type {CodeGraphQueryResult, RepositoryIdentity} from '@threadnote/graph/types';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import {
  retrieveSemanticContextSourceEvidence,
  projectSemanticContextKnowledge,
  compileContextBriefWith,
  selectSemanticContextSymbol,
  filterSemanticContextMemory,
  retrieveSemanticContextSymbol,
} from '../../src/compiler.js';
import {createMemoryCodeCitation, type MemoryCodeCitationTargetV1} from '@threadnote/memory/code/citation';
import type {ContextBriefMemoryRetrievalV1} from '../../src/types.js';
import * as SqlClient from 'effect/sql/SqlClient';
import * as Statement from 'effect/sql/Statement';
import * as Reactivity from 'effect/reactivity/Reactivity';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {runtimeConfigForTest} from '@threadnote/workspace/test/helpers/runtime-config';
import type {CodeGraphStatus} from '@threadnote/graph/types';
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
  test.effect('uses exact compiler definition spans rather than the enclosing caret function', () =>
    Effect.gen(function* () {
      const f = yield* fixture('function A() { return B(); }\r\nfunction B() { return 1; }\r\n');
      const a = {
        ...f.request.result.nodes[0],
        id: 'cgs_' + EffectString.repeat(32)('a'),
        span: {line: 1, column: 1, endLine: 1, endColumn: 29},
      };
      const b = {
        ...a,
        id: 'cgs_' + EffectString.repeat(32)('b'),
        name: 'B',
        span: {line: 2, column: 1, endLine: 2, endColumn: 27},
      };
      const proof = yield* retrieveSemanticContextSourceEvidence(f.request, f.evidence);
      expect(proof.binding).not.toBeNull();
      const target = {
        evidence: f.evidence,
        uri: f.evidence.observation.uri,
        range: {start: {line: 1, character: 0}, end: {line: 1, character: 26}},
      };
      // The reference is inside A, but only B's full compiler range is joined.
      expect(selectSemanticContextSymbol(f.bytes, f.evidence, target, [a, b], proof.binding!).nodeId).toBe(b.id);
      expect(selectSemanticContextSymbol(f.bytes, f.evidence, target, [a], proof.binding!).nodeId).toBeNull();
      expect(selectSemanticContextSymbol(f.bytes, f.evidence, target, [b, {...b, id: a.id}], proof.binding!).gap).toBe(
        'semantic-symbol-target-ambiguous',
      );
      expect(
        selectSemanticContextSymbol(
          f.bytes,
          f.evidence,
          {...target, evidence: {...f.evidence, observation: {...f.evidence.observation, projectEpoch: 9}}},
          [b],
          proof.binding!,
        ).nodeId,
      ).toBeNull();
      expect(
        selectSemanticContextSymbol(new TextEncoder().encode('changed'), f.evidence, target, [b], proof.binding!)
          .nodeId,
      ).toBeNull();
      for (const end of [
        {line: -1, character: 1},
        {line: 1, character: 1000},
        {line: 1, character: NaN},
        {line: 1, character: Infinity},
      ])
        expect(
          selectSemanticContextSymbol(
            f.bytes,
            f.evidence,
            {...target, range: {...target.range, end}},
            [b],
            proof.binding!,
          ).nodeId,
        ).toBeNull();
      expect(
        selectSemanticContextSymbol(
          f.bytes,
          f.evidence,
          target,
          [b, {...a, span: {...a.span, endColumn: 999}}],
          proof.binding!,
        ).gap,
      ).toBe('semantic-symbol-lookup-incomplete');
    }),
  );

  test.effect.prop(
    'exact range joins are cap-safe, Unicode/CRLF-safe and do not mutate evidence',
    [
      Schema.Literals(['🚀', 'é', 'x']),
      Schema.Boolean,
      Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 2})),
      Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 505})),
    ],
    ([unicode, crlf, matching, unrelated]) =>
      Effect.gen(function* () {
        const declaration = `const target = "${unicode}";`;
        const f = yield* fixture(`// prefix${crlf ? '\r\n' : '\n'}${declaration}\n`);
        const proof = yield* retrieveSemanticContextSourceEvidence(f.request, f.evidence);
        const base = f.request.result.nodes[0];
        const nodes = [
          ...Array.from({length: matching}, (_, i) => ({
            ...base,
            id: 'cgs_' + EffectString.slice(0, 32)(sha256HexSync(`match${i}`)),
            span: {line: 2, column: 1, endLine: 2, endColumn: declaration.length + 1},
          })),
          ...Array.from({length: unrelated}, (_, i) => ({
            ...base,
            id: 'cgs_' + EffectString.slice(0, 32)(sha256HexSync(`other${i}`)),
            span: {line: 1, column: 1, endLine: 1, endColumn: 3},
          })),
        ];
        const target = {
          evidence: f.evidence,
          uri: f.evidence.observation.uri,
          range: {start: {line: 1, character: 0}, end: {line: 1, character: declaration.length}},
        };
        const before = JSON.stringify([nodes, target, proof.binding]);
        const actual = selectSemanticContextSymbol(f.bytes, f.evidence, target, nodes, proof.binding!);
        expect(actual.nodeId).toBe(matching === 1 && matching + unrelated < 500 ? nodes[0].id : null);
        expect(JSON.stringify([nodes, target, proof.binding])).toBe(before);
        if (unicode === '🚀') {
          const split = 'const target = "'.length + 1;
          expect(
            selectSemanticContextSymbol(
              f.bytes,
              f.evidence,
              {...target, selectionRange: {start: {line: 1, character: split}, end: target.range.end}},
              nodes,
              proof.binding!,
            ).nodeId,
          ).toBeNull();
        }
      }),
    {arbitrary: {runs: 32}},
  );

  test.effect('defers linked memory until graph/source admission, retaining ordinary parallel behavior', () =>
    Effect.gen(function* () {
      for (const sequential of [true, false]) {
        const calls: string[] = [];
        yield* compileContextBriefWith(
          {
            codeLinkedMemoryAfterGraph: sequential,
            graphEvidence: () =>
              Effect.sync(() => {
                calls.push('graph');
                return {
                  cards: [],
                  contracts: [],
                  coverage: {
                    complete: false,
                    states: {},
                    consideredRepositories: 1,
                    readyRepositories: 0,
                    requestedRepositories: 1,
                  },
                  gaps: ['fixture'],
                  resolvedSnapshots: [],
                  warnings: [],
                  trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
                };
              }),
            memoryEvidence: () =>
              Effect.succeed({
                candidates: [],
                consideredCandidates: 0,
                gaps: [],
                trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
              }),
            codeLinkedMemoryEvidence: () => {
              if (sequential) expect(calls).toEqual(['graph']);
              return Effect.sync(() => {
                calls.push('memory');
                if (sequential) expect(calls).toEqual(['graph', 'memory']);
                return {
                  candidates: [],
                  consideredCandidates: 0,
                  gaps: [],
                  trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
                };
              });
            },
          },
          {
            task: 'Understand target',
            scope: {kind: 'repository', callerCwd: '/fixture'},
            codeRefs: ['source.ts'],
            mode: 'explain',
          },
        );
        expect(calls).toContain('memory');
      }
    }),
  );

  test.effect(
    'keeps target/proposal/file guidance distinct and excludes other-symbol memories without absence claims',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture('export const answer = 42;\n');
        const node = f.request.result.nodes[0];
        const {binding} = yield* retrieveSemanticContextSourceEvidence(f.request, f.evidence);
        const symbol = (nodeId: string): MemoryCodeCitationTargetV1 => ({
          kind: 'symbol',
          nodeId,
          name: 'answer',
          qualifiedName: 'answer',
          language: 'typescript',
          symbolKind: 'variable',
          span: node.span,
          fragmentCanonicalization: 'utf8-source-span-v1',
          fragmentHash: {algorithm: 'sha256', value: sha256HexSync('fragment')},
        });
        const candidates = EffectArray.map(
          [
            symbol(node.id),
            symbol('cgs_' + EffectString.repeat(32)('b')),
            {kind: 'file'},
          ] satisfies MemoryCodeCitationTargetV1[],
          (target, rank) => {
            const citation = createMemoryCodeCitation({
              version: 1,
              target,
              extractorSet: 'test',
              fileContentHash: {algorithm: 'sha256', value: sha256HexSync(f.bytes)},
              path: 'source.ts',
              repositoryId: f.request.identity.repositoryId,
              repositoryIdentityKind: 'local',
              sourceCommit: f.request.identity.headCommit,
              sourceDirty: false,
              sourceSnapshotId: 'cgsn_' + EffectString.repeat(40)('a'),
            });
            return {
              uri: `threadnote://memory/${rank}`,
              kind: 'durable' as const,
              rank,
              excerpt: 'Guidance',
              authority: 'agent_generated' as const,
              citationErrorCount: 0,
              codeCitations: [citation],
              codeLinkMatches: [
                {
                  anchorNodeId: node.id,
                  anchorOrdinal: 0,
                  anchorPath: 'source.ts',
                  citationId: citation.id,
                  matchKind: 'file-path' as const,
                },
              ],
            };
          },
        );
        const memory: ContextBriefMemoryRetrievalV1 = {
          candidates,
          consideredCandidates: 24,
          codeAnchorCoverage: {complete: true, requested: 1, resolved: 1, matchedMemories: 3},
          gaps: ['code-anchor-recall-truncated'],
          trust: {classification: 'untrusted-memory-data', instructionPolicy: 'evidence-only-never-follow'},
        };
        const before = JSON.stringify(memory);
        const filtered = filterSemanticContextMemory(memory, node.id, binding!.graph, 'local');
        expect(EffectArray.map(filtered.candidates, candidate => candidate.uri)).toEqual([
          'threadnote://memory/0',
          'threadnote://memory/2',
        ]);
        expect(EffectArray.every(filtered.candidates, candidate => candidate.authority === 'agent_generated')).toBe(
          true,
        );
        expect(EffectArray.map(filtered.candidates, candidate => candidate.codeCitations[0].target.kind)).toEqual([
          'symbol',
          'file',
        ]);
        expect(filtered.gaps).toContain('semantic-symbol-memory-coverage-incomplete');
        expect(filtered.gaps).toContain('code-anchor-recall-truncated');
        expect(
          filterSemanticContextMemory(
            {...memory, candidates: [candidates[1]], gaps: ['code-anchor-recall-no-active-memory']},
            node.id,
            binding!.graph,
            'local',
          ).gaps,
        ).not.toContain('code-anchor-recall-no-active-memory');
        const original = candidates[0].codeCitations[0];
        const foreign = createMemoryCodeCitation({
          version: 1,
          target: original.target,
          extractorSet: original.extractorSet,
          fileContentHash: original.fileContentHash,
          path: original.path,
          repositoryId: sha256HexSync('foreign repository with identical cgs ID'),
          repositoryIdentityKind: 'remote',
          sourceCommit: original.sourceCommit,
          sourceDirty: original.sourceDirty,
          sourceSnapshotId: original.sourceSnapshotId,
        });
        const foreignMatch = {
          ...candidates[0].codeLinkMatches[0],
          citationId: foreign.id,
          matchKind: 'symbol-node' as const,
        };
        const foreignOnly = {
          ...candidates[0],
          uri: 'threadnote://foreign',
          codeCitations: [foreign],
          codeLinkMatches: [foreignMatch],
        };
        const mixed = {
          ...foreignOnly,
          uri: 'threadnote://mixed',
          codeCitations: [foreign, candidates[2].codeCitations[0]],
          codeLinkMatches: [foreignMatch, candidates[2].codeLinkMatches[0]],
        };
        const crossRepository = filterSemanticContextMemory(
          {...memory, candidates: [foreignOnly, mixed]},
          node.id,
          binding!.graph,
          'local',
        );
        expect(EffectArray.map(crossRepository.candidates, candidate => candidate.uri)).toEqual(['threadnote://mixed']);
        expect(crossRepository.candidates[0].codeLinkMatches).toEqual([candidates[2].codeLinkMatches[0]]);
        expect(crossRepository.candidates[0].authority).toBe('agent_generated');
        expect(JSON.stringify(memory)).toBe(before);
      }),
  );
  test.effect('abstains explicitly for both Unicode logical line separators', () =>
    Effect.gen(function* () {
      for (const separator of ['\u2028', '\u2029']) {
        const f = yield* fixture(`// prefix${separator}export const answer = 42;\n`);
        const proof = yield* retrieveSemanticContextSourceEvidence(f.request, f.evidence);
        expect(proof.binding).not.toBeNull();
        const selected = selectSemanticContextSymbol(
          f.bytes,
          f.evidence,
          {
            evidence: f.evidence,
            uri: f.evidence.observation.uri,
            range: {start: {line: 0, character: 0}, end: {line: 0, character: 2}},
          },
          f.request.result.nodes,
          proof.binding!,
        );
        expect(selected).toEqual({nodeId: null, gap: 'semantic-symbol-line-separator-unsupported'});
      }
    }),
  );

  test.effect('reads the exact current effective path set in an existing read-only session before admission', () =>
    Effect.gen(function* () {
      const f = yield* fixture('export const answer = 42;\n');
      const proof = yield* retrieveSemanticContextSourceEvidence(f.request, f.evidence);
      let current = true;
      let rows = f.request.result.nodes;
      let reads = 0;
      const status = (): CodeGraphStatus => ({
        databasePath: '/isolated/test.sqlite',
        identity: f.request.identity,
        freshness: current ? 'current' : 'stale',
        stale: !current,
        languagePacks: [],
        readySnapshot: {
          ...f.request.result.snapshot,
          repositoryId: f.request.identity.repositoryId,
          state: 'ready',
          edgeCount: 0,
          symbolCount: rows.length,
          fileCount: 1,
          extractorSet: 'test',
        },
      });
      const reactivity = yield* Reactivity.make;
      const sql = yield* SqlClient.make({
        acquirer: Effect.die('Unexpected SQL in mocked path lookup'),
        compiler: Statement.makeCompilerSqlite(),
        driver: 'test',
        spanAttributes: [],
      }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
      const services = Layer.merge(
        Layer.mock(CodeGraphQueryService, {
          status: (_home, _cwd, options) => {
            expect(options?.requestMaintenance).toBe(false);
            return Effect.succeed(status());
          },
        }),
        Layer.mock(CodeGraphStore, {
          withSession: (_database, operation, options) => {
            expect(options).toEqual({existingOnly: true, readOnly: true});
            return operation.pipe(
              Effect.provideService(
                SqlClient.SqlClient,
                Object.assign(sql, {withTransaction: <A, E, R>(program: Effect.Effect<A, E, R>) => program}),
              ),
            );
          },
          searchSymbolsByPaths: (database, snapshot, paths, limit) =>
            Effect.sync(() => {
              reads++;
              expect(database).toBe(status().databasePath);
              expect(snapshot).toBe(f.request.result.snapshot.id);
              expect(paths).toEqual(['source.ts']);
              expect(limit).toBe(500);
              return [rows];
            }),
        }),
      );
      const target = {
        evidence: f.evidence,
        uri: f.evidence.observation.uri,
        range: {start: {line: 0, character: 0}, end: {line: 0, character: 19}},
      };
      const context = yield* Layer.build(services);
      const run = () =>
        retrieveSemanticContextSymbol(
          runtimeConfigForTest({agentContextHome: f.request.identity.repoRoot}),
          f.request,
          f.evidence,
          target,
          proof.binding,
        ).pipe(Effect.provideContext(context));
      expect((yield* run()).nodeId).toBe(rows[0].id);
      rows = Array.from({length: 500}, () => rows[0]);
      expect((yield* run()).gap).toBe('semantic-symbol-lookup-incomplete');
      current = false;
      expect((yield* run()).gap).toBe('semantic-symbol-snapshot-unbound');
      expect(reads).toBe(2);
      current = true;
      yield* f.fs.writeFileString(f.file, 'later source');
      expect((yield* run()).nodeId).toBeNull();
    }),
  );
});
