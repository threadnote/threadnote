import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  validateContextBriefMemoryCitations,
  validateContextHealthMemoryCitations,
} from '@threadnote/context/citation_validation';
import {
  codeGraphCitationEvidenceCapsuleId,
  readRetainedCodeGraphCitationEvidence,
} from '@threadnote/graph/citation/capsule';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry} from '@threadnote/graph/languages/registry';
import {CODE_GRAPH_SCHEMA_VERSION, type CodeGraphStatus, type CodeGraphSymbol} from '@threadnote/graph/types';
import type {ContextBriefMemoryCandidateV1} from '@threadnote/context/types';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {createMemoryCodeCitation, type MemoryCodeCitationInputV1} from '@threadnote/memory/code/citation';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {CommandExecutor, runCommandEffect} from '@threadnote/platform/command';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {recordVerifiedCodeGraphLocalAssociation} from '@threadnote/graph/local_provenance';
import {SystemInfo} from '@threadnote/platform/system';
import {sha256HexSync} from '@threadnote/platform/sha256';

const policy = Layer.mergeAll(
  Layer.succeed(ChildEnvironmentPolicy, {
    preserveIntendedChild: environment => environment,
    sanitizeExternal: environment => environment,
  }),
  Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: '/test/threadnote.ts'}),
);
const system = SystemInfo.layer.pipe(Layer.provide(policy));
const platform = Layer.mergeAll(
  system,
  CommandExecutor.layer.pipe(Layer.provideMerge(system), Layer.provide(policy)),
  Layer.succeed(CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry([])),
).pipe(Layer.provideMerge(BunServices.layer));

describe('complete health evidence validation', () => {
  effectIt.layer(platform)(it => {
    it.effect('validates the 97th valid citation and preserves historical source through graph/worktree removal', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-health-citations-'});
          const root = yield* fs.realPath(temporary);
          const home = path.join(root, 'home');
          yield* fs.makeDirectory(home);
          const repository = path.join(root, 'repository');
          yield* fs.makeDirectory(repository);
          const bytes = new TextEncoder().encode('export const supported = true;\n');
          yield* fs.writeFile(path.join(repository, 'source.ts'), bytes);
          const git = (args: readonly string[]) => runCommandEffect('git', ['-C', repository, ...args]);
          yield* git(['init', '--quiet']);
          yield* git(['config', 'user.name', 'Test']);
          yield* git(['config', 'user.email', 'test@example.invalid']);
          yield* git(['add', '.']);
          yield* git(['commit', '--quiet', '-m', 'original source']);
          yield* git(['remote', 'add', 'origin', 'https://example.invalid/old/repository.git']);
          const originalIdentity = yield* resolveRepositoryIdentity(repository);
          yield* recordVerifiedCodeGraphLocalAssociation(home, originalIdentity);
          const contentHash = sha256HexSync(bytes);
          let observedContentHash = contentHash;
          let observedSymbols: readonly CodeGraphSymbol[] = [];
          const citationInput: MemoryCodeCitationInputV1 = {
            extractorSet: 'test',
            fileContentHash: {algorithm: 'sha256', value: contentHash},
            path: 'source.ts',
            repositoryId: originalIdentity.repositoryId,
            repositoryIdentityKind: 'remote',
            sourceCommit: originalIdentity.headCommit,
            sourceDirty: false,
            sourceSnapshotId: `cgsn_${'c'.repeat(40)}`,
            target: {kind: 'file'},
            version: 1,
          };
          const citation = createMemoryCodeCitation(citationInput);
          const database = path.join(
            home,
            'indexes',
            'code-graph',
            'repositories',
            originalIdentity.checkoutId,
            `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
          );
          let available = true;
          let status: CodeGraphStatus = {
            databasePath: database,
            freshness: 'current',
            identity: originalIdentity,
            languagePacks: [],
            readySnapshot: {
              commit: citation.sourceCommit,
              dirty: false,
              edgeCount: 0,
              extractorSet: citation.extractorSet,
              fileCount: 1,
              id: citation.sourceSnapshotId,
              repositoryId: citation.repositoryId,
              state: 'ready',
              symbolCount: 0,
              worktreeId: originalIdentity.worktreeId,
            },
            stale: false,
          };
          const query = CodeGraphQueryService.of({
            status: () => (available ? Effect.succeed(status) : Effect.fail('unavailable')),
            statusForPublishedIdentity: () => Effect.succeed(status),
          } as unknown as CodeGraphQueryService['Service']);
          const store = CodeGraphStore.of({
            acquireSnapshotLease: () => Effect.succeed('lease'),
            releaseSnapshotLease: () => Effect.void,
            readySnapshotById: () => Effect.void,
            readySnapshotForCommit: () => Effect.void,
            effectiveSnapshotCitationEvidence: () =>
              Effect.succeed({
                fileInventoryCoverage: 'complete',
                filesByContentHashes: [],
                filesByPaths: [
                  {
                    path: citation.path,
                    file: {
                      blobId: 'f'.repeat(40),
                      contentHash: observedContentHash,
                      language: 'typescript',
                      mode: '100644',
                      path: citation.path,
                      size: bytes.byteLength,
                      source: 'worktree',
                    },
                  },
                ],
                symbolsByIds: [],
                symbolsBySemanticLocators: observedSymbols.map(symbol => ({
                  locator: {
                    kind: symbol.kind,
                    language: symbol.language,
                    name: symbol.name,
                    qualifiedName: symbol.qualifiedName,
                    version: 1,
                  },
                  symbols: [symbol],
                  truncated: false,
                })),
              }),
          } as unknown as CodeGraphStore['Service']);
          const config = {agentContextHome: home, manifestPath: path.join(home, 'threadnote.toml')} as RuntimeConfig;
          const candidates: ContextBriefMemoryCandidateV1[] = Array.from({length: 97}, (_, index) => ({
            citationErrorCount: 0,
            codeCitations: [citation],
            excerpt: '',
            kind: 'durable',
            rank: index,
            uri: `threadnote://memory/${index.toString().padStart(3, '0')}`,
          }));
          const scope = {callerCwd: repository, kind: 'repository' as const};
          const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.provideService(CodeGraphQueryService, query),
              Effect.provideService(CodeGraphStore, store),
            );
          const brief = yield* provide(validateContextBriefMemoryCitations(config, scope, candidates));
          expect(
            brief.flatMap(value => value.receipts).filter(value => value.reason === 'citation-limit'),
          ).toHaveLength(1);
          const unavailable = {
            ...candidates[0],
            uri: 'threadnote://memory/zz-unavailable',
            codeCitations: [createMemoryCodeCitation({...citationInput, repositoryId: 'f'.repeat(64)})],
          };
          const boundedHealth = yield* provide(
            validateContextHealthMemoryCitations(config, scope, [...candidates, unavailable]),
          );
          expect(boundedHealth.flatMap(value => value.receipts)).toHaveLength(96);
          expect(boundedHealth.find(value => value.uri === candidates[96]?.uri)).toBeUndefined();
          const complete = yield* provide(
            validateContextHealthMemoryCitations(config, scope, [...candidates, unavailable], {fullScan: true}),
          );
          expect(complete.flatMap(value => value.receipts)).toHaveLength(98);
          expect(
            complete
              .filter(value => value.uri !== unavailable.uri)
              .every(value =>
                value.receipts.every(
                  receipt => receipt.status === 'exact' && receipt.provenance === 'current-verified',
                ),
              ),
          ).toBe(true);
          expect(complete.find(value => value.uri === unavailable.uri)?.receipts[0]?.status).toBe('unknown');
          expect(
            yield* readRetainedCodeGraphCitationEvidence(home, status.identity.checkoutId, {
              extractorSet: citation.extractorSet,
              fileContentHash: contentHash,
              path: citation.path,
              repositoryId: citation.repositoryId,
              sourceCommit: citation.sourceCommit,
              sourceDirty: false,
              sourceSnapshotId: citation.sourceSnapshotId,
            }),
          ).toBeDefined();
          yield* git(['remote', 'set-url', 'origin', 'https://example.invalid/new/repository.git']);
          const currentIdentity = yield* resolveRepositoryIdentity(repository);
          status = {
            ...status,
            identity: currentIdentity,
            readySnapshot: {
              ...status.readySnapshot!,
              id: `cgsn_${'1'.repeat(40)}`,
              repositoryId: currentIdentity.repositoryId,
            },
          };
          const aliasBrief = yield* provide(
            validateContextBriefMemoryCitations(config, scope, candidates, {
              kind: 'repository',
              repositoryId: currentIdentity.repositoryId,
              snapshotId: status.readySnapshot!.id,
            }),
          );
          expect(
            aliasBrief.flatMap(value => value.receipts).filter(receipt => receipt.provenance === 'current-verified'),
          ).toHaveLength(96);
          expect(
            aliasBrief.flatMap(value => value.receipts).filter(receipt => receipt.reason === 'citation-limit'),
          ).toHaveLength(1);
          expect(aliasBrief[0]?.receipts[0]?.recovery?.aliasProof).toMatchObject({
            sourceRepositoryId: originalIdentity.repositoryId,
            targetRepositoryId: currentIdentity.repositoryId,
          });
          const fenced = yield* provide(
            validateContextBriefMemoryCitations(config, scope, candidates.slice(0, 1), {
              kind: 'repository',
              repositoryId: currentIdentity.repositoryId,
              snapshotId: `cgsn_${'2'.repeat(40)}`,
            }),
          );
          expect(fenced[0]?.receipts[0]?.status).toBe('unknown');
          const originalSource = {
            extractorSet: citation.extractorSet,
            fileContentHash: contentHash,
            path: citation.path,
            repositoryId: citation.repositoryId,
            sourceCommit: citation.sourceCommit,
            sourceDirty: false,
            sourceSnapshotId: citation.sourceSnapshotId,
          };
          yield* fs.remove(
            path.join(
              path.dirname(database),
              'local-context',
              'citation-evidence',
              `${codeGraphCitationEvidenceCapsuleId(originalSource)}.json`,
            ),
          );
          const changedBytes = new TextEncoder().encode(`${new TextDecoder().decode(bytes)}export const other = 1;\n`);
          observedContentHash = sha256HexSync(changedBytes);
          yield* fs.writeFile(path.join(repository, 'source.ts'), changedBytes);
          yield* git(['add', '.']);
          yield* git(['commit', '--quiet', '-m', 'changed surrounding file']);
          const changedIdentity = yield* resolveRepositoryIdentity(repository);
          const fragment = new TextDecoder().decode(bytes).trimEnd();
          const target = {
            fragmentCanonicalization: 'utf8-source-span-v1' as const,
            fragmentHash: {algorithm: 'sha256' as const, value: sha256HexSync(fragment)},
            kind: 'symbol' as const,
            language: 'typescript',
            name: 'supported',
            nodeId: `cgs_${'3'.repeat(32)}`,
            qualifiedName: 'supported',
            span: {column: 1, endColumn: fragment.length + 1, endLine: 1, line: 1},
            symbolKind: 'variable',
          };
          const symbolCitation = createMemoryCodeCitation({...citationInput, target});
          observedSymbols = [
            {
              contentHash: observedContentHash,
              exported: true,
              id: `cgs_${'4'.repeat(32)}`,
              kind: target.symbolKind,
              language: target.language,
              name: target.name,
              path: citation.path,
              qualifiedName: target.qualifiedName,
              span: target.span,
            },
          ];
          status = {
            ...status,
            identity: changedIdentity,
            readySnapshot: {
              ...status.readySnapshot!,
              commit: changedIdentity.headCommit,
              id: `cgsn_${'5'.repeat(40)}`,
            },
          };
          const preservedSymbol = yield* provide(
            validateContextHealthMemoryCitations(config, scope, [{...candidates[0], codeCitations: [symbolCitation]}]),
          );
          expect(preservedSymbol[0]?.receipts[0]).toMatchObject({
            provenance: 'current-verified',
            status: 'relocated',
          });
          expect(
            (yield* readRetainedCodeGraphCitationEvidence(home, changedIdentity.checkoutId, originalSource))?.bytes,
          ).toEqual(bytes);
          yield* fs.remove(repository, {recursive: true});
          available = false;
          yield* fs.writeFileString(database, '');
          const historical = yield* provide(
            validateContextHealthMemoryCitations(config, scope, candidates.slice(0, 1)),
          );
          expect(historical[0]?.receipts[0]).toMatchObject({
            coverage: 'incomplete',
            provenance: 'historical-verified',
            repositoryId: citation.repositoryId,
            snapshotId: citation.sourceSnapshotId,
            status: 'unknown',
          });
        }),
      ),
    );
  });
});
