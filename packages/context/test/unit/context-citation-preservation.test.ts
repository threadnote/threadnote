import {Array as EffectArray, Option as EffectOption} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path, Schema, Tracer} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {
  readContextHealthCitationEvidence,
  validateContextHealthMemoryCitations,
} from '@threadnote/context/citation_validation';
import {citationSourceExcerpt, historicalSnapshotCitationMatches} from '../../src/citation/evidence_excerpt.js';
import {createMemoryCodeCitation, type MemoryCodeCitationV1} from '@threadnote/memory/code/citation';
import {codeGraphCitationEvidenceCapsuleId} from '@threadnote/graph/citation/capsule';
import {
  BUILTIN_LANGUAGE_PACK_REGISTRY,
  CodeGraphLanguagePackRegistry,
  createCodeGraphLanguagePackRegistry,
} from '@threadnote/graph/languages/registry';
import {TreeSitterRuntime} from '@threadnote/graph/tree_sitter/runtime';
import {
  createCodeGraphSourceSpanCanonicalizer,
  type CodeGraphEffectiveSnapshotCitationEvidence,
} from '@threadnote/graph/citation/primitives';
import {
  cleanupMissingCodeGraphLocalProvenance,
  recordVerifiedCodeGraphLocalAssociation,
} from '@threadnote/graph/local_provenance';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {CodeGraphStatus, CodeGraphSymbol} from '@threadnote/graph/types';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';

import {citationPlatformLayer} from '../helpers/citation-platform.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {runtimeConfigForTest} from '@threadnote/workspace/test/helpers/runtime-config';

const platform = Layer.merge(
  citationPlatformLayer,
  Layer.succeed(CodeGraphLanguagePackRegistry, createCodeGraphLanguagePackRegistry([])),
);
const source = 'export const supported = true;\n';
const git = (cwd: string, args: readonly string[]) => runCommandEffect('git', ['-C', cwd, ...args]);
const fixture = (dirty = false, capturedSource?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporary = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-preservation-'});
    const root = yield* fs.realPath(temporary);
    const repository = path.join(root, 'repository');
    const worktree = path.join(root, 'worktree');
    const home = path.join(root, 'home');
    yield* fs.makeDirectory(repository);
    yield* fs.makeDirectory(home);
    yield* git(repository, ['init', '--quiet']);
    yield* git(repository, ['config', 'user.name', 'Test']);
    yield* git(repository, ['config', 'user.email', 'test@example.invalid']);
    yield* fs.writeFileString(path.join(repository, 'source.ts'), dirty ? source : (capturedSource ?? source));
    yield* git(repository, ['add', '.']);
    yield* git(repository, ['commit', '--quiet', '-m', 'source']);
    const main = yield* resolveRepositoryIdentity(repository);
    yield* recordVerifiedCodeGraphLocalAssociation(home, main);
    if (dirty) yield* git(repository, ['worktree', 'add', '--quiet', '--detach', worktree]);
    const cwd = dirty ? worktree : repository;
    const bytes = new TextEncoder().encode(capturedSource ?? (dirty ? 'export const supported = false;\n' : source));
    yield* fs.writeFile(path.join(cwd, 'source.ts'), bytes);
    const identity = yield* resolveRepositoryIdentity(cwd);
    yield* recordVerifiedCodeGraphLocalAssociation(home, identity);
    const layout = codeGraphLayout(path, home, identity.checkoutId, identity.worktreeId);
    let status: CodeGraphStatus = {
      databasePath: layout.databasePath,
      freshness: 'current',
      identity,
      languagePacks: [],
      stale: false,
      readySnapshot: {
        commit: identity.headCommit,
        dirty,
        edgeCount: 0,
        extractorSet: 'test',
        fileCount: 1,
        id: `cgsn_${Effect2.pipe('c', EffectString.repeat(40))}`,
        repositoryId: identity.repositoryId,
        state: 'ready',
        symbolCount: 0,
        worktreeId: identity.worktreeId,
      },
    };
    let available = true;
    let historicalSnapshotAvailable = false;
    let historicalFileHash: string | undefined;
    let historicalSymbols: readonly CodeGraphSymbol[] = [];
    let leases = 0;
    let releases = 0;
    const reads = {status: 0, historicalSnapshot: 0, capsule: 0, historicalGit: 0};
    let changeSnapshotAt: number | undefined;
    const readStatus = () =>
      Effect.suspend(() => {
        reads.status++;
        if (reads.status === changeSnapshotAt)
          status = {
            ...status,
            readySnapshot: {...status.readySnapshot!, id: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`},
          };
        return available ? Effect.succeed(status) : Effect.fail('unavailable');
      });
    const tracer = Tracer.make({
      span(options) {
        if (options.name === 'codeGraph.readRetainedCitationEvidence') reads.capsule++;
        if (options.name === 'contextHealth.readHistoricalGitCitationBytes') reads.historicalGit++;
        return new Tracer.NativeSpan(options);
      },
    });
    const queryMock = Layer.mock(CodeGraphQueryService, {
      status: readStatus,
      statusForPublishedIdentity: readStatus,
    });
    const queryLayer = Layer.effect(
      CodeGraphQueryService,
      Effect.gen(function* () {
        const mockService = yield* CodeGraphQueryService;
        const {withStatusSession: _unusedSessionHook, ...fallbackService} = mockService;
        return fallbackService;
      }),
    ).pipe(Layer.provide(queryMock));
    const mockServices = Layer.merge(
      queryLayer,
      Layer.mock(CodeGraphStore, {
        acquireSnapshotLease: () => Effect.sync(() => `lease-${++leases}`),
        releaseSnapshotLease: () =>
          Effect.sync(() => {
            releases++;
          }),
        readySnapshotById: () =>
          Effect.sync(() => {
            reads.historicalSnapshot++;
            return historicalSnapshotAvailable ? status.readySnapshot : undefined;
          }),
        readySnapshotForCommit: () => Effect.as(Effect.void, undefined),
        effectiveSnapshotCitationEvidence: () =>
          Effect.sync(() => {
            if (historicalSnapshotAvailable) expect(leases).toBeGreaterThan(releases);
            return {
              fileInventoryCoverage: 'complete',
              filesByContentHashes: [],
              filesByPaths: [
                {
                  path: 'source.ts',
                  file: {
                    blobId: '',
                    contentHash: historicalFileHash ?? sha256HexSync(bytes),
                    language: 'typescript',
                    mode: '100644',
                    path: 'source.ts',
                    size: bytes.byteLength,
                    source: 'worktree',
                  },
                },
              ],
              symbolsByIds: historicalSymbols,
              symbolsBySemanticLocators: [],
            };
          }),
      }),
    );
    const config = runtimeConfigForTest({
      agentContextHome: home,
      manifestPath: path.join(home, 'threadnote.toml'),
      manifestSource: 'bundled-example',
    });
    const citationInput = {
      extractorSet: 'test',
      fileContentHash: {algorithm: 'sha256' as const, value: sha256HexSync(bytes)},
      path: 'source.ts',
      repositoryId: identity.repositoryId,
      repositoryIdentityKind: 'local' as const,
      sourceCommit: identity.headCommit,
      sourceDirty: dirty,
      sourceSnapshotId: status.readySnapshot!.id,
      target: {kind: 'file' as const},
      version: 1 as const,
    };
    const citation = createMemoryCodeCitation(citationInput);
    const mockContext = yield* Layer.build(mockServices);
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideContext(effect, mockContext).pipe(Effect.withTracer(tracer));
    const check = (anchor: MemoryCodeCitationV1) =>
      provide(
        validateContextHealthMemoryCitations(config, {callerCwd: cwd, kind: 'repository'}, [
          {
            codeCitations: [anchor],
            uri: 'threadnote://memory/proof',
          },
        ]),
      );
    const evidenceSource = {
      extractorSet: citation.extractorSet,
      fileContentHash: citation.fileContentHash.value,
      path: citation.path,
      repositoryId: citation.repositoryId,
      sourceCommit: citation.sourceCommit,
      sourceDirty: citation.sourceDirty,
      sourceSnapshotId: citation.sourceSnapshotId,
    };
    return {
      bytes,
      check,
      citation,
      citationInput,
      config,
      cwd,
      evidenceSource,
      fs,
      home,
      identity,
      layout,
      path,
      provide,
      repository,
      retainSnapshot: (fileHash?: string, symbols: readonly CodeGraphSymbol[] = []) => {
        historicalSnapshotAvailable = true;
        historicalFileHash = fileHash;
        historicalSymbols = symbols;
      },
      unavailable: () => {
        available = false;
      },
      leaseCounts: () => ({leases, releases}),
      readCounts: () => ({...reads}),
      resetReadCounts: () => {
        for (const key of EffectRecord.keys(reads)) reads[key] = 0;
      },
      changeSnapshotOnRead: (ordinal: number) => {
        changeSnapshotAt = ordinal;
      },
    };
  });

describe('citation proof before source retirement', () => {
  effectIt.layer(platform)(it => {
    it.effect.prop(
      'projects requested evidence exactly from default-both reads without executing the other provenance',
      {
        maximumBytes: Schema.Int.check(Schema.isBetween({minimum: 32, maximum: 128})),
        maximumLines: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 3})),
        startLine: Schema.Int.check(Schema.isBetween({minimum: 1, maximum: 2})),
        dirty: Schema.Boolean,
      },
      ({dirty, ...options}) =>
        Effect.gen(function* () {
          const data = yield* fixture(dirty, source + '// supporting detail 🌱\n');
          yield* data.provide(captureMemoryCodeCitations(data.config, {callerCwd: data.cwd, refs: ['source.ts']}));
          const scope = {callerCwd: data.cwd, kind: 'repository' as const};
          const read = (purpose?: 'both' | 'historical' | 'current') =>
            data.provide(readContextHealthCitationEvidence(data.config, scope, data.citation, {...options, purpose}));
          const both = yield* read();
          expect(yield* read('both')).toEqual(both);
          for (const purpose of ['historical', 'current'] as const) {
            data.resetReadCounts();
            const selected = yield* read(purpose);
            const expected = EffectArray.filter(both.excerpts, item => item.provenance === `${purpose}-verified`);
            expect(selected.excerpts).toEqual(expected);
            expect(selected.excerpts.length).toBeGreaterThan(0);
            expect(selected).toMatchObject({
              citationId: both.citationId,
              generation: both.generation,
              routesComplete: both.routesComplete,
              coverage: 'available',
            });
            if (purpose === 'historical') {
              expect(data.readCounts().status).toBe(0);
              expect(selected.attemptedSteps).not.toContain('current-source');
            } else {
              expect(data.readCounts()).toEqual({status: 2, historicalSnapshot: 0, capsule: 0, historicalGit: 0});
              expect(selected.attemptedSteps).not.toContain('retained-capsule');
            }
            expect(data.leaseCounts().leases).toBe(data.leaseCounts().releases);
          }
        }).pipe(TestClock.withLive),
      {arbitrary: {runs: 8, seed: 756013}},
    );

    it.effect('keeps requested-provenance failures separate and closes the current snapshot fence', () =>
      Effect.gen(function* () {
        const data = yield* fixture();
        const scope = {callerCwd: data.cwd, kind: 'repository' as const};
        const forged = createMemoryCodeCitation({
          ...data.citationInput,
          fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('f', EffectString.repeat(64))},
        });
        const missing = yield* data.provide(
          readContextHealthCitationEvidence(data.config, scope, forged, {purpose: 'historical'}),
        );
        expect(missing.coverage).toBe('unavailable');
        expect(missing.excerpts).toEqual([]);
        expect(data.readCounts().status).toBe(0);
        data.resetReadCounts();
        data.changeSnapshotOnRead(2);
        const raced = yield* data.provide(
          readContextHealthCitationEvidence(data.config, scope, data.citation, {purpose: 'current'}),
        );
        expect(raced.excerpts).toEqual([]);
        expect(raced.coverage).toBe('unavailable');
        expect(data.readCounts()).toEqual({status: 2, historicalSnapshot: 0, capsule: 0, historicalGit: 0});
        expect(data.leaseCounts().leases).toBe(data.leaseCounts().releases);
      }).pipe(TestClock.withLive),
    );

    it.effect('reads fenced current bytes and refuses false-current source after a byte race', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const data = yield* fixture();
          const scope = {callerCwd: data.cwd, kind: 'repository' as const};
          const current = yield* data.provide(readContextHealthCitationEvidence(data.config, scope, data.citation));
          expect(
            EffectOption.getOrUndefined(
              EffectArray.findFirst(current.excerpts, value => value.provenance === 'current-verified'),
            ),
          ).toMatchObject({
            content: source,
            fileBytesHash: sha256HexSync(data.bytes),
            supportsCitation: true,
          });
          yield* data.fs.writeFileString(data.path.join(data.repository, 'source.ts'), 'changed during read\n');
          const raced = yield* data.provide(readContextHealthCitationEvidence(data.config, scope, data.citation));
          expect(EffectArray.every(raced.excerpts, value => value.provenance === 'historical-verified')).toBe(true);
          expect(data.leaseCounts().leases).toBe(data.leaseCounts().releases);
        }),
      ),
    );
    it.effect('recovers exact clean Git bytes without any graph snapshot and never makes them current', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const data = yield* fixture();
          data.unavailable();
          yield* data.fs.writeFileString(data.path.join(data.repository, 'source.ts'), 'export const supported = 2;\n');
          const checked = yield* data.check(data.citation);
          expect(checked[0]?.receipts[0]).toMatchObject({
            status: 'unknown',
            provenance: 'historical-verified',
            snapshotCommit: data.citation.sourceCommit,
            snapshotId: data.citation.sourceSnapshotId,
          });
          const read = yield* data.provide(
            readContextHealthCitationEvidence(data.config, {callerCwd: data.cwd, kind: 'repository'}, data.citation),
          );
          expect(read.excerpts).toHaveLength(1);
          expect(read.excerpts[0]).toMatchObject({
            content: source,
            provenance: 'historical-verified',
            source: data.evidenceSource,
            supportsCitation: true,
            fileBytesHash: sha256HexSync(data.bytes),
          });
          expect(data.leaseCounts()).toEqual({leases: 0, releases: 0});
        }),
      ),
    );

    it.effect('requires old snapshot membership before verifying self-consistent current bytes as history', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const data = yield* fixture();
          data.unavailable();
          data.retainSnapshot();
          const current = 'export const supported = false;\n';
          yield* data.fs.writeFileString(data.path.join(data.repository, 'source.ts'), current);
          const imported = createMemoryCodeCitation({
            ...data.citationInput,
            fileContentHash: {algorithm: 'sha256', value: sha256HexSync(current)},
          });
          const scope = {callerCwd: data.cwd, kind: 'repository' as const};
          const invalid = yield* data.provide(readContextHealthCitationEvidence(data.config, scope, imported));
          expect(invalid.coverage).toBe('unavailable');
          expect(invalid.excerpts).toEqual([]);
          expect(invalid.attemptedSteps).toContain('exact-snapshot');
          expect(invalid.attemptedSteps).toContain('exact-clean-git');
          const honest = yield* data.provide(readContextHealthCitationEvidence(data.config, scope, data.citation));
          expect(honest.excerpts).toHaveLength(1);
          expect(honest.excerpts[0]).toMatchObject({content: source, provenance: 'historical-verified'});
          expect(data.leaseCounts().leases).toBe(data.leaseCounts().releases);
        }),
      ),
    );

    it.effect('requires exact dirty snapshot symbol membership even when its file and fragment match', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const data = yield* fixture(true);
          data.unavailable();
          data.retainSnapshot();
          const content = Effect2.pipe(new TextDecoder().decode(data.bytes), EffectString.trimEnd);
          const imported = createMemoryCodeCitation({
            ...data.citationInput,
            target: {
              fragmentCanonicalization: 'utf8-source-span-v1',
              fragmentHash: {algorithm: 'sha256', value: sha256HexSync(content)},
              kind: 'symbol',
              language: 'typescript',
              name: 'supported',
              nodeId: `cgs_${Effect2.pipe('a', EffectString.repeat(32))}`,
              qualifiedName: 'supported',
              span: {line: 1, column: 1, endLine: 1, endColumn: content.length + 1},
              symbolKind: 'variable',
            },
          });
          const scope = {callerCwd: data.cwd, kind: 'repository' as const};
          const invalid = yield* data.provide(readContextHealthCitationEvidence(data.config, scope, imported));
          expect(invalid.coverage).toBe('unavailable');
          expect(invalid.excerpts).toEqual([]);
          if (imported.target.kind !== 'symbol') return yield* Effect.die('Expected imported symbol target.');
          data.retainSnapshot(undefined, [
            {
              contentHash: imported.fileContentHash.value,
              exported: true,
              id: imported.target.nodeId,
              kind: imported.target.symbolKind,
              language: imported.target.language,
              name: imported.target.name,
              path: imported.path,
              qualifiedName: imported.target.qualifiedName,
              span: imported.target.span,
            },
          ]);
          const proved = yield* data.provide(readContextHealthCitationEvidence(data.config, scope, imported));
          expect(proved.excerpts[0]).toMatchObject({content: `${content}\n`, provenance: 'historical-verified'});
          const honest = yield* data.provide(readContextHealthCitationEvidence(data.config, scope, data.citation));
          expect(honest.excerpts[0]).toMatchObject({content: `${content}\n`, provenance: 'historical-verified'});
          expect(data.leaseCounts().leases).toBe(data.leaseCounts().releases);
        }),
      ),
    );

    it.effect('reads clean historical snapshots from their commit even when graph facts match current bytes', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const data = yield* fixture();
          data.unavailable();
          const current = 'export const supported = false;\n';
          const hash = sha256HexSync(current);
          data.retainSnapshot(hash);
          yield* data.fs.writeFileString(data.path.join(data.repository, 'source.ts'), current);
          const imported = createMemoryCodeCitation({
            ...data.citationInput,
            fileContentHash: {algorithm: 'sha256', value: hash},
          });
          const read = yield* data.provide(
            readContextHealthCitationEvidence(data.config, {callerCwd: data.cwd, kind: 'repository'}, imported),
          );
          expect(read.coverage).toBe('unavailable');
          expect(read.excerpts).toEqual([]);
          expect(data.leaseCounts()).toEqual({leases: 1, releases: 1});
        }),
      ),
    );

    it.effect(
      'preserves dirty bytes at capture before the first health tick, even after worktree and graph removal',
      () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const data = yield* fixture(true);
            const [captured] = yield* data.provide(
              captureMemoryCodeCitations(data.config, {callerCwd: data.cwd, refs: ['source.ts']}),
            );
            expect(captured?.id).toBe(data.citation.id);
            expect(captured.evidenceRetention).toBe('capsule-retained');
            expect(data.leaseCounts()).toEqual({leases: 1, releases: 1});
            yield* git(data.repository, ['worktree', 'remove', '--force', data.cwd]);
            const system = yield* SystemInfo;
            expect(
              (yield* cleanupMissingCodeGraphLocalProvenance(data.home, data.identity).pipe(
                Effect.provideService(SystemInfo, {
                  ...system,
                  developmentEntrypoint: data.path.resolve('apps/threadnote/src/standalone.ts'),
                }),
              )).state,
            ).toBe('removed');
            data.unavailable();
            const checked = yield* data.check(captured);
            expect(checked[0]?.receipts[0]).toMatchObject({status: 'unknown', provenance: 'historical-verified'});
            const read = yield* data.provide(
              readContextHealthCitationEvidence(data.config, {callerCwd: data.cwd, kind: 'repository'}, captured),
            );
            expect(read.excerpts[0]?.content).toBe(new TextDecoder().decode(data.bytes));
            expect(read.excerpts[0]?.source.sourceDirty).toBe(true);
            expect(EffectArray.every(read.excerpts, value => value.provenance === 'historical-verified')).toBe(true);
            yield* data.fs.remove(
              data.path.join(
                data.layout.repositoryRoot,
                'local-context',
                'citation-evidence',
                `${codeGraphCitationEvidenceCapsuleId(data.evidenceSource)}.json`,
              ),
            );
            expect((yield* data.check(captured))[0]?.receipts[0]?.provenance).toBe('unverified');
            expect(captured.evidenceRetention).toBe('capsule-retained');
            expect(
              (yield* data.provide(
                readContextHealthCitationEvidence(data.config, {callerCwd: data.cwd, kind: 'repository'}, captured),
              )).coverage,
            ).toBe('unavailable');
          }),
        ),
    );

    it.effect('rejects mismatched file, span and signature proofs when only clean Git history remains', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const data = yield* fixture();
          data.unavailable();
          const input = {
            extractorSet: data.citation.extractorSet,
            fileContentHash: data.citation.fileContentHash,
            path: data.citation.path,
            repositoryId: data.citation.repositoryId,
            repositoryIdentityKind: data.citation.repositoryIdentityKind,
            sourceCommit: data.citation.sourceCommit,
            sourceDirty: data.citation.sourceDirty,
            sourceSnapshotId: data.citation.sourceSnapshotId,
            version: 1 as const,
            target: {
              fragmentCanonicalization: 'utf8-source-span-v1' as const,
              fragmentHash: {
                algorithm: 'sha256' as const,
                value: sha256HexSync(Effect2.pipe(source, EffectString.trimEnd)),
              },
              kind: 'symbol' as const,
              language: 'typescript',
              name: 'supported',
              nodeId: `cgs_${Effect2.pipe('a', EffectString.repeat(32))}`,
              qualifiedName: 'supported',
              span: {line: 1, column: 1, endLine: 1, endColumn: Effect2.pipe(source, EffectString.trimEnd).length + 1},
              symbolKind: 'variable',
            },
          };
          const valid = createMemoryCodeCitation(input);
          expect((yield* data.check(valid))[0]?.receipts[0]?.provenance).toBe('historical-verified');
          const invalid = [
            createMemoryCodeCitation({
              ...input,
              fileContentHash: {algorithm: 'sha256', value: Effect2.pipe('f', EffectString.repeat(64))},
            }),
            createMemoryCodeCitation({...input, target: {...input.target, span: {...input.target.span, endLine: 2}}}),
            createMemoryCodeCitation({
              ...input,
              target: {
                ...input.target,
                signatureHash: {algorithm: 'sha256', value: Effect2.pipe('f', EffectString.repeat(64))},
              },
            }),
          ];
          for (const anchor of invalid)
            expect((yield* data.check(anchor))[0]?.receipts[0]?.provenance).toBe('unverified');
        }),
      ),
    );

    it.effect('keeps capture usable when capsule caps are exceeded and exposes lost dirty evidence', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const oversized = source + Effect2.pipe('// padding\n', EffectString.repeat(30_000));
          for (const dirty of [false, true]) {
            const data = yield* fixture(dirty, oversized);
            const [captured] = yield* data.provide(
              captureMemoryCodeCitations(data.config, {callerCwd: data.cwd, refs: ['source.ts']}),
            );
            expect(captured?.evidenceRetention).toBe('unavailable');
            expect(captured?.id).toBe(data.citation.id);
            expect(Object.isFrozen(captured)).toBe(true);
            data.unavailable();
            if (dirty) yield* git(data.repository, ['worktree', 'remove', '--force', data.cwd]);
            else yield* data.fs.writeFileString(data.path.join(data.repository, 'source.ts'), 'changed\n');
            const checked = yield* data.check(captured);
            expect(checked[0]?.receipts[0]?.provenance).toBe(dirty ? 'unverified' : 'historical-verified');
            const read = yield* data.provide(
              readContextHealthCitationEvidence(data.config, {callerCwd: data.cwd, kind: 'repository'}, captured, {
                maximumBytes: 128,
                maximumLines: 2,
              }),
            );
            expect(read.coverage).toBe(dirty ? 'unavailable' : 'available');
            if (!dirty)
              expect(read.excerpts[0]).toMatchObject({
                content: `${source}// padding`,
                provenance: 'historical-verified',
                truncated: true,
              });
          }
        }),
      ),
    );

    it.effect('independently extracts and verifies a required historical symbol signature', () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const data = yield* fixture();
          data.unavailable();
          const treeRuntime = TreeSitterRuntime.of({
            withParsedSource: () => Effect.die('TypeScript extraction must use its own parser.'),
          });
          const facts = yield* BUILTIN_LANGUAGE_PACK_REGISTRY.extractFile({
            blobId: '',
            content: source,
            contentHash: data.citation.fileContentHash.value,
            language: 'typescript',
            mode: '100644',
            path: 'source.ts',
            size: data.bytes.byteLength,
            source: 'commit',
          }).pipe(Effect.provideService(TreeSitterRuntime, treeRuntime));
          const symbol = EffectOption.getOrUndefined(
            EffectArray.findFirst(facts.symbols, value => value.name === 'supported'),
          );
          if (symbol === undefined) return yield* Effect.die('Expected exact TypeScript declaration.');
          const fragment = createCodeGraphSourceSpanCanonicalizer(source).fragment(symbol.span);
          if (!fragment.ok || symbol.signature === undefined)
            return yield* Effect.die('Expected exact TypeScript declaration.');
          const anchor = createMemoryCodeCitation({
            version: 1,
            extractorSet: data.citation.extractorSet,
            fileContentHash: data.citation.fileContentHash,
            path: data.citation.path,
            repositoryId: data.citation.repositoryId,
            repositoryIdentityKind: data.citation.repositoryIdentityKind,
            sourceCommit: data.citation.sourceCommit,
            sourceDirty: false,
            sourceSnapshotId: data.citation.sourceSnapshotId,
            target: {
              kind: 'symbol',
              fragmentCanonicalization: 'utf8-source-span-v1',
              fragmentHash: {algorithm: 'sha256', value: fragment.fragment.sha256},
              language: symbol.language,
              name: symbol.name,
              nodeId: symbol.id,
              qualifiedName: symbol.qualifiedName,
              signatureHash: {algorithm: 'sha256', value: sha256HexSync(symbol.signature)},
              span: symbol.span,
              symbolKind: symbol.kind,
            },
          });
          const checked = yield* data
            .check(anchor)
            .pipe(
              Effect.provideService(CodeGraphLanguagePackRegistry, BUILTIN_LANGUAGE_PACK_REGISTRY),
              Effect.provideService(TreeSitterRuntime, treeRuntime),
            );
          expect(checked[0]?.receipts[0]?.provenance).toBe('historical-verified');
        }),
      ),
    );

    it('keeps evidence excerpts bounded and hash exact for arbitrary Unicode sources', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({maxLength: 100}), {minLength: 1, maxLength: 80}),
          fc.integer({min: 1, max: 128}),
          fc.integer({min: 1, max: 100}),
          (lines, maximumBytes, maximumLines) => {
            const content = EffectArray.join(lines, '\n');
            const bytes = new TextEncoder().encode(content);
            const evidenceSource = {
              extractorSet: 'test',
              fileContentHash: sha256HexSync(bytes),
              path: 'source.ts',
              repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
              sourceCommit: Effect2.pipe('b', EffectString.repeat(40)),
              sourceDirty: true,
              sourceSnapshotId: `cgsn_${Effect2.pipe('c', EffectString.repeat(40))}`,
            };
            const excerpt = citationSourceExcerpt(bytes, evidenceSource, 'historical-verified', true, {
              maximumBytes,
              maximumLines,
            });
            if (excerpt === undefined) return;
            expect(new TextEncoder().encode(excerpt.content).byteLength).toBeLessThanOrEqual(maximumBytes);
            expect(excerpt.endLine - excerpt.startLine + 1).toBeLessThanOrEqual(Math.min(64, maximumLines));
            expect(excerpt.excerptHash).toBe(sha256HexSync(excerpt.content));
            expect(excerpt.fileBytesHash).toBe(sha256HexSync(bytes));
            expect(excerpt.provenance).toBe('historical-verified');
            expect(excerpt.source).toEqual(evidenceSource);
            expect(
              Effect2.pipe(content, __effectPipeInput => {
                const __effectPipeStage0 = Effect2.pipe(
                  __effectPipeInput,
                  EffectString.replace(/\r\n|\r|\u2028|\u2029/gu, '\n'),
                );
                const __effectPipeStage1 = Effect2.pipe(__effectPipeStage0, EffectString.startsWith(excerpt.content));
                return __effectPipeStage1;
              }),
            ).toBe(true);
          },
        ),
        {numRuns: 100},
      );
    });

    it('requires every original snapshot file and symbol identity component with raw-hash migration aliases', () => {
      fc.assert(
        fc.property(
          fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/u),
          fc.integer({min: 1, max: 1_000}),
          fc.integer({min: 1, max: 200}),
          fc.boolean(),
          (name, line, column, legacyRawHash) => {
            const fileHash = sha256HexSync(`graph:${name}`);
            const rawHash = sha256HexSync(`raw:${name}`);
            const symbol: CodeGraphSymbol = {
              contentHash: fileHash,
              exported: true,
              id: `cgs_${Effect2.pipe(sha256HexSync(name), EffectString.slice(0, 40))}`,
              kind: 'variable',
              language: 'typescript',
              name,
              path: 'source.ts',
              qualifiedName: `module.${name}`,
              signature: `const ${name}: boolean`,
              span: {line, column, endLine: line, endColumn: column + 1},
            };
            const signature = symbol.signature;
            if (signature === undefined) throw new Error('Symbol fixture is missing its signature.');
            const anchor = createMemoryCodeCitation({
              version: 1,
              extractorSet: 'test',
              fileContentHash: {algorithm: 'sha256', value: legacyRawHash ? rawHash : fileHash},
              path: symbol.path,
              repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
              repositoryIdentityKind: 'local',
              sourceCommit: Effect2.pipe('b', EffectString.repeat(40)),
              sourceDirty: true,
              sourceSnapshotId: `cgsn_${Effect2.pipe('c', EffectString.repeat(40))}`,
              target: {
                fragmentCanonicalization: 'utf8-source-span-v1',
                fragmentHash: {algorithm: 'sha256', value: sha256HexSync(name)},
                kind: 'symbol',
                language: symbol.language,
                name,
                nodeId: symbol.id,
                qualifiedName: symbol.qualifiedName,
                signatureHash: {algorithm: 'sha256', value: sha256HexSync(signature)},
                span: symbol.span,
                symbolKind: symbol.kind,
              },
            });
            const evidence: CodeGraphEffectiveSnapshotCitationEvidence = {
              fileInventoryCoverage: 'incomplete',
              filesByContentHashes: [],
              filesByPaths: [
                {
                  path: symbol.path,
                  file: {
                    blobId: '',
                    contentHash: fileHash,
                    rawContentHash: rawHash,
                    language: 'typescript',
                    mode: '100644',
                    path: symbol.path,
                    size: 1,
                    source: 'worktree',
                  },
                },
              ],
              symbolsByIds: [symbol],
              symbolsBySemanticLocators: [],
            };
            expect(historicalSnapshotCitationMatches(anchor, evidence)).toBe(true);
            expect(historicalSnapshotCitationMatches(anchor, {...evidence, filesByPaths: []})).toBe(false);
            expect(historicalSnapshotCitationMatches(anchor, {...evidence, symbolsByIds: []})).toBe(false);
            expect(historicalSnapshotCitationMatches(anchor, {...evidence, symbolsByIds: [symbol, symbol]})).toBe(
              false,
            );
            const mutations: readonly Partial<CodeGraphSymbol>[] = [
              {id: `cgs_${Effect2.pipe('f', EffectString.repeat(32))}`},
              {contentHash: Effect2.pipe('f', EffectString.repeat(64))},
              {path: 'other.ts'},
              {kind: 'function'},
              {language: 'javascript'},
              {name: `${name}Changed`},
              {qualifiedName: `other.${name}`},
              {signature: 'different signature'},
              {span: {...symbol.span, line: line + 1}},
              {span: {...symbol.span, column: column + 1}},
              {span: {...symbol.span, endLine: line + 1}},
              {span: {...symbol.span, endColumn: column + 2}},
            ];
            for (const mutation of mutations)
              expect(
                historicalSnapshotCitationMatches(anchor, {
                  ...evidence,
                  symbolsByIds: [{...symbol, ...mutation}],
                }),
              ).toBe(false);
          },
        ),
        {numRuns: 100},
      );
    });
  });
});
