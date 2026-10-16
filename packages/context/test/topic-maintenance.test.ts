import fc from 'fast-check';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {proposeTopicMaintenanceEnrollment} from '@threadnote/memory/topic-maintenance';
import {recordVerifiedCodeGraphLocalAssociation} from '@threadnote/graph/local_provenance';
import {CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {CodeGraphStatus} from '@threadnote/graph/types';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  boundTopicMaintenanceEvidencePacket,
  buildTopicMaintenanceEvidencePacket,
  observeTopicMaintenanceEvidence,
  projectTopicMaintenanceObservation,
} from '../src/topic_maintenance.js';
import {citationPlatformLayer} from './helpers/citation-platform.js';

const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/topic.md';
const citation = createMemoryCodeCitation({
  evidenceRetention: 'capsule-retained',
  extractorSet: 'native-code-graph-13',
  fileContentHash: {algorithm: 'sha256', value: 'a'.repeat(64)},
  path: 'src/source.ts',
  repositoryId: '1'.repeat(64),
  repositoryIdentityKind: 'remote',
  sourceCommit: '2'.repeat(40),
  sourceDirty: false,
  sourceSnapshotId: `cgsn_${'4'.repeat(40)}`,
  target: {kind: 'file'},
  version: 1,
});

const source = parseMemoryDocument(
  uri,
  formatMemoryDocument(
    'MEMORY',
    {
      codeCitations: [citation],
      kind: 'durable',
      memoryId: 'tn_topic_fixture',
      project: 'threadnote',
      schemaVersion: 8,
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-10-16T00:00:00.000Z',
    },
    'Claim.\n\nClaim.',
  ),
)!;
const enrolled = parseMemoryDocument(
  uri,
  proposeTopicMaintenanceEnrollment(source, {
    paragraphs: [
      {role: 'descriptive', support: 'direct', citationIds: [citation.id]},
      {role: 'historical', support: 'contextual', citationIds: [citation.id]},
    ],
  }).content,
)!;

const currentWithHash = (original: typeof citation, hash: string) => {
  if (hash === original.fileContentHash.value) return original;
  const {id: _id, ...input} = original;
  return createMemoryCodeCitation({...input, fileContentHash: {algorithm: 'sha256' as const, value: hash}});
};
const evidence = (hash: string) => ({
  citationId: citation.id,
  status: 'exact' as const,
  reason: 'exact' as const,
  historicalAvailable: true,
  current: currentWithHash(citation, hash),
  currentFileBytesHash: hash,
});

describe('topic maintenance evidence projection', () => {
  it('coalesces unrelated commits and timestamps when relevant bytes stay equal', () => {
    const baseline = projectTopicMaintenanceObservation(enrolled, [evidence('a'.repeat(64))]);
    const repeated = projectTopicMaintenanceObservation(enrolled, [evidence('a'.repeat(64))]);
    expect(repeated.revision).toBe(baseline.revision);
    expect(repeated.outcome).toBe('unchanged');
    expect(repeated.canDraft).toBe(false);
    const revalidated = projectTopicMaintenanceObservation(enrolled, [
      {
        ...evidence('a'.repeat(64)),
        status: 'relocated',
        observedNodeId: `cgs_${'f'.repeat(40)}`,
      },
    ]);
    expect(revalidated.revision).toBe(baseline.revision);
    expect(revalidated.outcome).toBe('unchanged');
  });

  it('marks changed support for review but never drafts without recovered history or current capture', () => {
    const changed = {...evidence('b'.repeat(64)), status: 'changed' as const};
    const review = projectTopicMaintenanceObservation(enrolled, [changed]);
    expect(review.outcome).toBe('review-required');
    expect(review.canDraft).toBe(true);
    const lost = projectTopicMaintenanceObservation(enrolled, [{...changed, historicalAvailable: false}]);
    expect(lost.outcome).toBe('unavailable');
    expect(lost.canDraft).toBe(false);
    expect(lost.revision).not.toBe(review.revision);
    const truncated = projectTopicMaintenanceObservation(enrolled, [{...changed, excerptTruncated: true}]);
    expect(truncated.outcome).toBe('unavailable');
    expect(truncated.canDraft).toBe(false);
    const noCurrent = projectTopicMaintenanceObservation(enrolled, [
      {citationId: citation.id, status: 'unknown', reason: 'graph-stale', historicalAvailable: true},
    ]);
    expect(noCurrent.outcome).toBe('unavailable');
    expect(noCurrent.canDraft).toBe(false);
    const {id: _id, ...input} = citation;
    const unretained = createMemoryCodeCitation({...input, evidenceRetention: 'unavailable'});
    expect(() => projectTopicMaintenanceObservation(enrolled, [{...changed, current: unretained}])).toThrow(
      /retention/,
    );
  });

  it('changes revision only for relevant content, support state or target content', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...'0123456789abcdef'), {minLength: 64, maxLength: 64}), digits => {
        const hash = digits.join('');
        const first = projectTopicMaintenanceObservation(enrolled, [evidence(hash)]);
        const second = projectTopicMaintenanceObservation(enrolled, [evidence(hash)]);
        expect(first.revision).toBe(second.revision);
        if (hash !== 'a'.repeat(64))
          expect(first.revision).not.toBe(
            projectTopicMaintenanceObservation(enrolled, [evidence('a'.repeat(64))]).revision,
          );
      }),
      {numRuns: 40},
    );
  });

  it('orders declared sources independently of receipt arrival order', () => {
    const {id: _id, ...secondInput} = citation;
    const second = createMemoryCodeCitation({
      ...secondInput,
      path: 'src/other.ts',
      fileContentHash: {algorithm: 'sha256', value: 'c'.repeat(64)},
    });
    const withTwo = parseMemoryDocument(
      uri,
      formatMemoryDocument('MEMORY', {...source.metadata, codeCitations: [citation, second]}, 'Claim.'),
    )!;
    const dual = parseMemoryDocument(
      uri,
      proposeTopicMaintenanceEnrollment(withTwo, {
        paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [citation.id, second.id]}],
      }).content,
    )!;
    const firstSource = evidence('a'.repeat(64));
    const secondSource = {...evidence('c'.repeat(64)), citationId: second.id, current: second};
    expect(projectTopicMaintenanceObservation(dual, [firstSource, secondSource]).revision).toBe(
      projectTopicMaintenanceObservation(dual, [secondSource, firstSource]).revision,
    );
  });

  it('includes additional declared dependencies in coverage without inferring undeclared code', () => {
    const {id: _id, ...secondInput} = citation;
    const dependency = createMemoryCodeCitation({
      ...secondInput,
      path: 'src/config.ts',
      fileContentHash: {algorithm: 'sha256', value: 'd'.repeat(64)},
    });
    const withDependency = parseMemoryDocument(
      uri,
      formatMemoryDocument('MEMORY', {...source.metadata, codeCitations: [citation, dependency]}, 'Claim.'),
    )!;
    const declared = parseMemoryDocument(
      uri,
      proposeTopicMaintenanceEnrollment(withDependency, {
        paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [citation.id]}],
        additionalDependencies: [{kind: 'configuration', citationId: dependency.id}],
      }).content,
    )!;
    const dependencyEvidence = {...evidence('d'.repeat(64)), citationId: dependency.id, current: dependency};
    expect(() => projectTopicMaintenanceObservation(declared, [evidence('a'.repeat(64))])).toThrow(/every declared/);
    const baseline = projectTopicMaintenanceObservation(declared, [evidence('a'.repeat(64)), dependencyEvidence]);
    expect(baseline.sources.map(item => item.citationId)).toContain(dependency.id);
    expect(
      projectTopicMaintenanceObservation(declared, [
        evidence('a'.repeat(64)),
        {
          ...dependencyEvidence,
          current: currentWithHash(dependency, 'e'.repeat(64)),
          currentFileBytesHash: 'e'.repeat(64),
        },
      ]).revision,
    ).not.toBe(baseline.revision);
  });

  it('rejects aggregate packet overflow without silently trimming the accepted body', () => {
    const base = {
      version: 1 as const,
      outcome: 'ready' as const,
      targetUri: uri,
      targetHash: 'a'.repeat(64),
      observationRevision: 'b'.repeat(64),
      coverage: 'declared-only' as const,
      body: 'x'.repeat(31 * 1024),
      paragraphs: [
        {
          ordinal: 0,
          hash: 'c'.repeat(64),
          role: 'descriptive' as const,
          support: 'direct' as const,
          citationIds: [citation.id],
        },
      ],
      sources: [],
    };
    expect(boundTopicMaintenanceEvidencePacket(base).outcome).toBe('ready');
    const oversized = boundTopicMaintenanceEvidencePacket({
      ...base,
      paragraphs: Array.from({length: 64}, (_, ordinal) => ({
        ...base.paragraphs[0],
        ordinal,
        scope: 's'.repeat(512),
      })),
    });
    expect(oversized.outcome).toBe('unavailable');
    expect(oversized.reason).toBe('packet-overflow');
    expect(oversized.body).toBeUndefined();
  });

  it('coalesces unrelated file edits around a symbol, but detects a changed symbol fragment', () => {
    const {id: _id, ...input} = citation;
    const symbol = createMemoryCodeCitation({
      ...input,
      target: {
        fragmentCanonicalization: 'utf8-source-span-v1',
        fragmentHash: {algorithm: 'sha256', value: 'f'.repeat(64)},
        kind: 'symbol',
        language: 'typescript',
        name: 'value',
        qualifiedName: 'value',
        nodeId: `cgs_${'a'.repeat(32)}`,
        span: {line: 1, column: 1, endLine: 1, endColumn: 20},
        symbolKind: 'variable',
      },
    });
    const symbolSource = parseMemoryDocument(
      uri,
      formatMemoryDocument('MEMORY', {...source.metadata, codeCitations: [symbol]}, 'Claim.'),
    )!;
    const symbolRecord = parseMemoryDocument(
      uri,
      proposeTopicMaintenanceEnrollment(symbolSource, {
        paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [symbol.id]}],
      }).content,
    )!;
    const sourceEvidence = {
      citationId: symbol.id,
      status: 'exact' as const,
      reason: 'exact',
      historicalAvailable: true,
      current: symbol,
      currentFileBytesHash: '1'.repeat(64),
      observedPath: symbol.path,
      observedNodeId: symbol.target.kind === 'symbol' ? symbol.target.nodeId : undefined,
    };
    const baseline = projectTopicMaintenanceObservation(symbolRecord, [sourceEvidence]);
    if (symbol.target.kind !== 'symbol') throw new Error('Expected a symbol citation.');
    const {id: _currentId, ...currentInput} = symbol;
    const moved = createMemoryCodeCitation({
      ...currentInput,
      fileContentHash: {algorithm: 'sha256', value: 'b'.repeat(64)},
      target: {...symbol.target, nodeId: `cgs_${'b'.repeat(32)}`},
    });
    const unrelated = projectTopicMaintenanceObservation(symbolRecord, [
      {
        ...sourceEvidence,
        status: 'relocated',
        current: moved,
        currentFileBytesHash: '2'.repeat(64),
        observedNodeId: moved.target.kind === 'symbol' ? moved.target.nodeId : undefined,
      },
    ]);
    expect(unrelated.outcome).toBe('unchanged');
    expect(unrelated.revision).toBe(baseline.revision);
    const edited = createMemoryCodeCitation({
      ...currentInput,
      target: {
        ...symbol.target,
        fragmentHash: {algorithm: 'sha256', value: 'e'.repeat(64)},
      },
    });
    const changed = projectTopicMaintenanceObservation(symbolRecord, [
      {
        ...sourceEvidence,
        status: 'changed',
        current: edited,
      },
    ]);
    expect(changed.outcome).toBe('review-required');
    expect(changed.revision).not.toBe(baseline.revision);
  });
});

describe('topic maintenance current evidence', () => {
  effectIt.layer(
    Layer.merge(
      citationPlatformLayer,
      Layer.succeed(CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry([])),
    ),
  )(it => {
    it.effect('keeps a committed file unchanged across unrelated commits and reviews changed file bytes', () =>
      TestClock.withLive(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-topic-evidence-'});
            const repo = path.join(root, 'repo');
            const home = path.join(root, 'home');
            yield* fs.makeDirectory(repo);
            yield* fs.makeDirectory(home);
            const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repo, ...args]);
            yield* git(['init', '--quiet']);
            yield* git(['config', 'user.name', 'Test']);
            yield* git(['config', 'user.email', 'test@example.invalid']);
            yield* fs.writeFileString(path.join(repo, 'source.ts'), 'export const value = 1;\n');
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'first']);
            let identity = yield* resolveRepositoryIdentity(repo);
            yield* recordVerifiedCodeGraphLocalAssociation(home, identity);
            const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
            const symbolId = `cgs_${'d'.repeat(40)}`;
            const declaration = 'export const stable = 1;';
            let symbolContent: string | undefined;
            let status: CodeGraphStatus = {
              databasePath: layout.databasePath,
              freshness: 'current',
              identity,
              languagePacks: [],
              stale: false,
              readySnapshot: {
                commit: identity.headCommit,
                dirty: false,
                edgeCount: 0,
                extractorSet: 'test',
                fileCount: 1,
                id: `cgsn_${identity.headCommit}`,
                repositoryId: identity.repositoryId,
                state: 'ready',
                symbolCount: 0,
                worktreeId: identity.worktreeId,
              },
            };
            const query = CodeGraphQueryService.of({
              status: () => Effect.succeed(status),
              statusForPublishedIdentity: () => Effect.succeed(status),
            } as unknown as CodeGraphQueryService['Service']);
            const store = CodeGraphStore.of({
              acquireSnapshotLease: () => Effect.succeed('lease'),
              releaseSnapshotLease: () => Effect.void,
              readySnapshotById: () => Effect.void,
              readySnapshotForCommit: () => Effect.void,
              effectiveSnapshotCitationEvidence: () =>
                Effect.gen(function* () {
                  const bytes = yield* fs.readFile(path.join(repo, 'source.ts'));
                  const symbolBytes = symbolContent === undefined ? undefined : new TextEncoder().encode(symbolContent);
                  const symbolHash = symbolBytes === undefined ? undefined : sha256HexSync(symbolBytes);
                  const symbol =
                    symbolHash === undefined
                      ? undefined
                      : {
                          contentHash: symbolHash,
                          exported: true,
                          id: symbolId,
                          kind: 'variable' as const,
                          language: 'typescript',
                          name: 'stable',
                          path: 'symbol.ts',
                          qualifiedName: 'stable',
                          span: {line: 1, column: 1, endLine: 2, endColumn: 1},
                        };
                  return {
                    fileInventoryCoverage: 'complete',
                    filesByContentHashes: [],
                    filesByPaths: [
                      {
                        path: 'source.ts',
                        file: {
                          blobId: '',
                          contentHash: sha256HexSync(bytes),
                          language: 'typescript',
                          mode: '100644',
                          path: 'source.ts',
                          size: bytes.byteLength,
                          source: 'commit',
                        },
                      },
                      ...(symbolHash === undefined
                        ? []
                        : [
                            {
                              path: 'symbol.ts',
                              file: {
                                blobId: '',
                                contentHash: symbolHash,
                                language: 'typescript',
                                mode: '100644',
                                path: 'symbol.ts',
                                size: symbolBytes!.byteLength,
                                source: 'commit' as const,
                              },
                            },
                          ]),
                    ],
                    symbolsByIds: symbol === undefined ? [] : [symbol],
                    symbolsBySemanticLocators: [],
                  };
                }),
            } as unknown as CodeGraphStore['Service']);
            const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              effect.pipe(
                Effect.provideService(CodeGraphQueryService, query),
                Effect.provideService(CodeGraphStore, store),
              );
            const config = {
              agentContextHome: home,
              manifestPath: path.join(home, 'threadnote.toml'),
              manifestSource: 'bundled-example',
            } as RuntimeConfig;
            const [captured] = yield* provide(
              captureMemoryCodeCitations(config, {callerCwd: repo, refs: ['source.ts']}),
            );
            expect(captured?.evidenceRetention).toBe('capsule-retained');
            const memory = parseMemoryDocument(
              uri,
              formatMemoryDocument(
                'MEMORY',
                {
                  ...source.metadata,
                  codeCitations: [captured],
                },
                'The value comes from source.ts.',
              ),
            )!;
            const enrolledRecord = parseMemoryDocument(
              uri,
              proposeTopicMaintenanceEnrollment(memory, {
                paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [captured.id]}],
              }).content,
            )!;
            const observe = (
              previous?: ReturnType<typeof projectTopicMaintenanceObservation>,
              options?: {readonly allowCapture?: boolean},
            ) => provide(observeTopicMaintenanceEvidence(config, enrolledRecord, repo, previous, options));
            const initial = yield* observe();
            expect(initial.outcome).toBe('unchanged');
            expect(initial.sources[0]?.historicalAvailable).toBe(true);
            const readOnlyInitial = yield* observe(initial, {allowCapture: false});
            expect(readOnlyInitial.revision).toBe(initial.revision);
            expect((yield* observe(undefined, {allowCapture: false})).outcome).toBe('unavailable');
            const updateStatus = () =>
              Effect.gen(function* () {
                identity = yield* resolveRepositoryIdentity(repo);
                status = {
                  ...status,
                  identity,
                  readySnapshot: {
                    ...status.readySnapshot!,
                    commit: identity.headCommit,
                    id: `cgsn_${identity.headCommit}`,
                  },
                };
              });
            yield* fs.writeFileString(path.join(repo, 'unrelated.ts'), 'export const other = 2;\n');
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'unrelated']);
            yield* updateStatus();
            const unrelated = yield* observe(initial);
            expect(unrelated.outcome).toBe('unchanged');
            expect(unrelated.revision).toBe(initial.revision);
            expect((yield* observe(initial, {allowCapture: false})).revision).toBe(initial.revision);
            status = {
              ...status,
              readySnapshot: {
                ...status.readySnapshot!,
                extractorSet: 'test-v2',
                id: `cgsn_${sha256HexSync('new extractor set').slice(0, 40)}`,
              },
            };
            const changedExtractorReadOnly = yield* observe(unrelated, {allowCapture: false});
            expect(changedExtractorReadOnly.outcome).toBe('unavailable');
            const reextracted = yield* observe(unrelated);
            expect(reextracted.outcome).toBe('unchanged');
            expect(reextracted.revision).toBe(initial.revision);
            expect(reextracted.sources[0]?.current?.extractorSet).toBe('test-v2');
            expect(reextracted.sources[0]?.current?.id).not.toBe(captured.id);
            expect(reextracted.sources[0]?.historicalAvailable).toBe(true);
            expect((yield* observe(reextracted, {allowCapture: false})).sources[0]?.current?.id).toBe(
              reextracted.sources[0]?.current?.id,
            );
            yield* fs.writeFileString(path.join(repo, 'source.ts'), 'export const value = 2;\n');
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'changed']);
            yield* updateStatus();
            const changedReadOnly = yield* observe(unrelated, {allowCapture: false});
            expect(changedReadOnly.outcome).toBe('unavailable');
            expect(changedReadOnly.sources[0]?.current).toBeUndefined();
            const changed = yield* observe(unrelated);
            expect(changed.outcome).toBe('review-required');
            expect(changed.revision).not.toBe(initial.revision);
            expect(changed.sources[0]?.historicalAvailable).toBe(true);
            yield* fs.writeFileString(
              path.join(repo, 'source.ts'),
              [...Array.from({length: 10}, (_, index) => `// context ${index}`), 'export const value = 3;', ''].join(
                '\n',
              ),
            );
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'changed lower line']);
            yield* updateStatus();
            const lowerLine = yield* observe(changed);
            expect(lowerLine.sources[0]?.excerptTruncated).toBe(true);
            expect(lowerLine.outcome).toBe('unavailable');
            expect(lowerLine.canDraft).toBe(false);
            const packet = yield* provide(buildTopicMaintenanceEvidencePacket(config, enrolledRecord, repo, lowerLine));
            expect(packet).toMatchObject({outcome: 'unavailable', reason: 'excerpt-truncated', truncatedExcerpts: 1});

            symbolContent = [declaration, ...Array.from({length: 12}, (_, index) => `// sibling ${index}`), ''].join(
              '\n',
            );
            yield* fs.writeFileString(path.join(repo, 'symbol.ts'), symbolContent);
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'symbol']);
            yield* updateStatus();
            const [symbolCitation] = yield* provide(
              captureMemoryCodeCitations(config, {callerCwd: repo, refs: [symbolId]}),
            );
            expect(symbolCitation?.target.kind).toBe('symbol');
            const symbolMemory = parseMemoryDocument(
              uri,
              formatMemoryDocument(
                'MEMORY',
                {...source.metadata, codeCitations: [symbolCitation]},
                'The stable value comes from symbol.ts.',
              ),
            )!;
            const symbolRecord = parseMemoryDocument(
              uri,
              proposeTopicMaintenanceEnrollment(symbolMemory, {
                paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [symbolCitation.id]}],
                additionalDependencies: [{kind: 'configuration', citationId: symbolCitation.id}],
              }).content,
            )!;
            const symbolInitial = yield* provide(observeTopicMaintenanceEvidence(config, symbolRecord, repo));
            expect(symbolInitial.outcome).toBe('unchanged');
            expect(symbolInitial.sources[0]?.excerptTruncated).toBe(false);
            symbolContent = symbolContent.replace('// sibling 10', '// sibling edited');
            yield* fs.writeFileString(path.join(repo, 'symbol.ts'), symbolContent);
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'sibling edit']);
            yield* updateStatus();
            const symbolSibling = yield* provide(
              observeTopicMaintenanceEvidence(config, symbolRecord, repo, symbolInitial),
            );
            expect(symbolSibling.outcome).toBe('unchanged');
            expect(symbolSibling.revision).toBe(symbolInitial.revision);
            expect(symbolSibling.sources[0]?.current?.id).not.toBe(symbolCitation.id);
            expect(symbolSibling.sources[0]?.excerptTruncated).toBe(false);
            symbolContent = symbolContent.replace('stable = 1', 'stable = 2');
            yield* fs.writeFileString(path.join(repo, 'symbol.ts'), symbolContent);
            yield* git(['add', '.']);
            yield* git(['commit', '--quiet', '-m', 'symbol edit']);
            yield* updateStatus();
            const symbolChanged = yield* provide(
              observeTopicMaintenanceEvidence(config, symbolRecord, repo, symbolSibling),
            );
            expect(symbolChanged.outcome).toBe('review-required');
            expect(symbolChanged.sources[0]?.excerptTruncated).toBe(false);
            const symbolPacket = yield* provide(
              buildTopicMaintenanceEvidencePacket(config, symbolRecord, repo, symbolChanged),
            );
            expect(symbolPacket.outcome).toBe('ready');
            expect(symbolPacket.additionalDependencies).toEqual([
              {kind: 'configuration', citationId: symbolCitation.id},
            ]);
            expect(symbolPacket.sources?.[0]?.oldExcerpt).toMatchObject({endLine: 1, truncated: false});
            expect(symbolPacket.sources?.[0]?.newExcerpt).toMatchObject({endLine: 1, truncated: false});
          }),
        ),
      ),
    );
  });
});
