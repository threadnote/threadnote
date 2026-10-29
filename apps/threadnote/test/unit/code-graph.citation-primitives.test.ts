import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import * as FC from 'fast-check';
import {
  codeGraphEffectiveFilesByContentHashesQueryStatement,
  codeGraphEffectiveFilesByPathsQueryStatement,
  codeGraphEffectiveSymbolsBySemanticLocatorsQueryStatement,
  codeGraphSourceSpanFragment,
  CodeGraphStore,
  createCodeGraphSourceSpanCanonicalizer,
  selectCodeGraphCitationContentHashTargets,
  type CodeGraphSymbolSemanticLocatorV1,
} from '@threadnote/graph/store';
import {
  codeGraphCommittedFileContentHash,
  codeGraphFileContentHashMatchesBytes,
  createCodeGraphCommittedFileContentHasher,
} from '@threadnote/graph/content_identity';
import type {CodeGraphInventoryFile, CodeGraphSnapshot, RepositoryIdentity} from '@threadnote/graph/types';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {encodeCodeGraphInventoryReuseReceipt} from '@threadnote/graph/inventory/reuse';
import {CODE_GRAPH_INVENTORY_EXCLUSION_REASONS} from '@threadnote/graph/inventory/policy';
import {
  CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
  CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
} from '@threadnote/graph/store/models';
import {mergeCodeGraphWorkspaces} from '@threadnote/graph/workspace';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {validateContextBriefFileCitation} from '@threadnote/context/citation_validation';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const baseSnapshotId = 'citation-base';
const currentSnapshotId = 'citation-current';
const oldHash = Effect2.pipe('1', EffectString.repeat(64));
const newHash = Effect2.pipe('2', EffectString.repeat(64));
const keepHash = Effect2.pipe('3', EffectString.repeat(64));
const deletedHash = Effect2.pipe('4', EffectString.repeat(64));
const duplicateHash = Effect2.pipe('5', EffectString.repeat(64));
const legacyRawHash = Effect2.pipe('8', EffectString.repeat(64));

const targetLocator = {
  kind: 'function',
  language: 'typescript',
  name: 'target',
  qualifiedName: 'target',
  version: 1,
} as const satisfies CodeGraphSymbolSemanticLocatorV1;

const inheritedLocator = {
  kind: 'function',
  language: 'typescript',
  name: 'inherited',
  qualifiedName: 'inherited',
  version: 1,
} as const satisfies CodeGraphSymbolSemanticLocatorV1;

describe('code graph citation query primitives', () => {
  fcProp(
    effectIt,
    'queries eager hashes and only missing-path relocation fallbacks in first-seen order',
    {
      eagerContentHashes: FC.array(
        FC.integer({max: 5, min: 0}).map(value => Effect2.pipe(String(value), EffectString.repeat(64))),
        {
          maxLength: 8,
        },
      ),
      fallbacks: FC.array(
        FC.record({
          contentHash: FC.integer({max: 5, min: 0}).map(value => Effect2.pipe(String(value), EffectString.repeat(64))),
          path: FC.integer({max: 5, min: 0}).map(value => `src/${value}.ts`),
        }),
        {maxLength: 12},
      ),
      presentPaths: FC.uniqueArray(
        FC.integer({max: 5, min: 0}).map(value => `src/${value}.ts`),
        {
          maxLength: 6,
        },
      ),
    },
    ({eagerContentHashes, fallbacks, presentPaths}) => {
      const potential = [
        ...new Set([...eagerContentHashes, ...EffectArray.map(fallbacks, fallback => fallback.contentHash)]),
      ];
      const present = new Set(presentPaths);
      const selected = selectCodeGraphCitationContentHashTargets([...new Set(eagerContentHashes)], fallbacks, present);
      const expected = [
        ...new Set([
          ...eagerContentHashes,
          ...EffectArray.map(
            EffectArray.filter(fallbacks, fallback => !present.has(fallback.path)),
            fallback => fallback.contentHash,
          ),
        ]),
      ];
      expect(selected).toEqual(expected);
      expect(EffectArray.every(selected, contentHash => potential.includes(contentHash))).toBe(true);
    },
    {fastCheck: {numRuns: 100}},
  );

  fcProp(
    effectIt,
    'matches current Git-blob envelopes and legacy raw hashes to the same source bytes',
    {
      bytes: FC.uint8Array({maxLength: 1_024}),
      chunkWidths: FC.array(FC.integer({max: 256, min: 0}), {maxLength: 32}),
      objectFormat: FC.constantFrom('sha1' as const, 'sha256' as const),
    },
    ({bytes, chunkWidths, objectFormat}) => {
      const rawHash = sha256HexSync(bytes);
      const committedHash = codeGraphCommittedFileContentHash(objectFormat, bytes);
      expect(codeGraphFileContentHashMatchesBytes(rawHash, objectFormat, bytes)).toBe(true);
      expect(codeGraphFileContentHashMatchesBytes(committedHash, objectFormat, bytes)).toBe(true);

      const changed = new Uint8Array(bytes.byteLength + 1);
      changed.set(bytes);
      expect(codeGraphFileContentHashMatchesBytes(rawHash, objectFormat, changed)).toBe(false);
      expect(codeGraphFileContentHashMatchesBytes(committedHash, objectFormat, changed)).toBe(false);

      const streaming = createCodeGraphCommittedFileContentHasher(objectFormat, bytes.byteLength);
      let offset = 0;
      for (const width of chunkWidths) {
        const end = Math.min(bytes.byteLength, offset + width);
        streaming.update(bytes.subarray(offset, end));
        offset = end;
      }
      streaming.update(bytes.subarray(offset));
      expect(streaming.digest()).toBe(committedHash);
    },
    {fastCheck: {numRuns: 100}},
  );

  effectIt.effect('merges clean/base/dirty files and symbols while suppressing overrides and deletions', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-primitives-'});
        const databasePath = path.join(root, 'graph.sqlite');
        yield* store.initialize(databasePath);
        yield* withCitationDatabase(databasePath, seedCitationDatabase);

        const clean = yield* store.effectiveSnapshotFilesByPaths(databasePath, baseSnapshotId, ['src/override.ts']);
        expect(clean).toEqual([
          {
            file: expect.objectContaining({contentHash: oldHash, path: 'src/override.ts', source: 'commit'}),
            path: 'src/override.ts',
          },
        ]);

        const effective = yield* store.effectiveSnapshotFilesByPaths(databasePath, currentSnapshotId, [
          'src/keep.ts',
          'src/override.ts',
          'src/deleted.ts',
        ]);
        expect(effective).toEqual([
          {
            file: expect.objectContaining({contentHash: keepHash, path: 'src/keep.ts', source: 'commit'}),
            path: 'src/keep.ts',
          },
          {
            file: expect.objectContaining({contentHash: newHash, path: 'src/override.ts', source: 'worktree'}),
            path: 'src/override.ts',
          },
          {path: 'src/deleted.ts'},
        ]);

        const replacedBytes = yield* store.effectiveSnapshotFilesByContentHashes(
          databasePath,
          currentSnapshotId,
          [oldHash],
          8,
        );
        expect(replacedBytes).toEqual([{contentHash: oldHash, files: [], truncated: false}]);

        const ambiguousFiles = yield* store.effectiveSnapshotFilesByContentHashes(
          databasePath,
          currentSnapshotId,
          [duplicateHash],
          8,
        );
        expect(
          Effect2.Option.getOrUndefined(
            Effect2.Option.map(Effect2.Option.fromNullishOr(ambiguousFiles[0]?.files), __effectOptionalArrayReceiver =>
              EffectArray.map(__effectOptionalArrayReceiver, file => file.path),
            ),
          ),
        ).toEqual(['src/base-copy.ts', 'src/current-copy.ts']);
        expect(ambiguousFiles[0]?.truncated).toBe(false);
        const boundedFiles = yield* store.effectiveSnapshotFilesByContentHashes(
          databasePath,
          currentSnapshotId,
          [duplicateHash],
          1,
        );
        expect(boundedFiles[0]?.files).toHaveLength(1);
        expect(boundedFiles[0]?.truncated).toBe(true);

        const legacyEvidence = yield* store.effectiveSnapshotCitationEvidence(databasePath, currentSnapshotId, {
          contentHashes: [legacyRawHash],
          paths: ['src/extra.ts', 'src/legacy-location.ts'],
        });
        expect(legacyEvidence.filesByContentHashes[0]).toMatchObject({
          files: [
            {
              contentHash: Effect2.pipe('7', EffectString.repeat(64)),
              path: 'src/extra.ts',
              rawContentHash: legacyRawHash,
            },
          ],
          truncated: false,
        });
        const legacyCitation = (citationPath: string, contentHash = legacyRawHash) =>
          createMemoryCodeCitation({
            extractorSet: 'native-code-graph-13',
            fileContentHash: {algorithm: 'sha256', value: contentHash},
            path: citationPath,
            repositoryId: Effect2.pipe('9', EffectString.repeat(64)),
            repositoryIdentityKind: 'local',
            sourceCommit: Effect2.pipe('a', EffectString.repeat(40)),
            sourceDirty: true,
            sourceSnapshotId: `cgsn_${Effect2.pipe('a', EffectString.repeat(40))}`,
            target: {kind: 'file'},
            version: 1,
          });
        expect(
          validateContextBriefFileCitation(
            legacyCitation('src/extra.ts'),
            legacyEvidence.filesByPaths[0],
            legacyEvidence.filesByContentHashes[0],
            currentSnapshot(),
            '2026-08-27T00:00:00.000Z',
          ),
        ).toMatchObject({reason: 'exact', status: 'exact'});
        expect(
          validateContextBriefFileCitation(
            legacyCitation('src/legacy-location.ts'),
            legacyEvidence.filesByPaths[1],
            legacyEvidence.filesByContentHashes[0],
            currentSnapshot(),
            '2026-08-27T00:00:00.000Z',
          ),
        ).toMatchObject({observedPath: 'src/extra.ts', reason: 'relocated', status: 'relocated'});
        expect(
          validateContextBriefFileCitation(
            legacyCitation('src/extra.ts', Effect2.pipe('f', EffectString.repeat(64))),
            legacyEvidence.filesByPaths[0],
            undefined,
            currentSnapshot(),
            '2026-08-27T00:00:00.000Z',
          ),
        ).toMatchObject({reason: 'source-changed', status: 'changed'});

        const byIds = yield* store.symbolsByIds(databasePath, currentSnapshotId, [
          'symbol-inherited',
          'symbol-overridden',
          'symbol-deleted',
        ]);
        expect(EffectArray.map(byIds, symbol => [symbol.id, symbol.path, symbol.signature])).toEqual([
          ['symbol-inherited', 'src/keep.ts', 'function inherited(): void'],
          ['symbol-overridden', 'src/override.ts', 'function overridden(value: string): void'],
        ]);

        const semanticMatches = yield* store.effectiveSnapshotSymbolsBySemanticLocators(
          databasePath,
          currentSnapshotId,
          [targetLocator, inheritedLocator],
          8,
        );
        expect(
          Effect2.Option.getOrUndefined(
            Effect2.Option.map(
              Effect2.Option.fromNullishOr(semanticMatches[0]?.symbols),
              __effectOptionalArrayReceiver => EffectArray.map(__effectOptionalArrayReceiver, symbol => symbol.path),
            ),
          ),
        ).toEqual(['src/current-copy-2.ts', 'src/current-copy.ts']);
        expect(semanticMatches[0]?.truncated).toBe(false);
        expect(
          Effect2.Option.getOrUndefined(
            Effect2.Option.map(
              Effect2.Option.fromNullishOr(semanticMatches[1]?.symbols),
              __effectOptionalArrayReceiver => EffectArray.map(__effectOptionalArrayReceiver, symbol => symbol.id),
            ),
          ),
        ).toEqual(['symbol-inherited']);
        const boundedSymbols = yield* store.effectiveSnapshotSymbolsBySemanticLocators(
          databasePath,
          currentSnapshotId,
          [targetLocator],
          1,
        );
        expect(boundedSymbols[0]?.symbols).toHaveLength(1);
        expect(boundedSymbols[0]?.truncated).toBe(true);

        const combined = yield* store.effectiveSnapshotCitationEvidence(databasePath, currentSnapshotId, {
          contentHashes: [duplicateHash],
          limitPerContentHash: 1,
          limitPerSemanticLocator: 1,
          paths: ['src/keep.ts', 'src/deleted.ts'],
          semanticLocators: [targetLocator],
          symbolIds: ['symbol-inherited', 'symbol-deleted'],
        });
        expect(combined.fileInventoryCoverage).toBe('incomplete');
        const cleanCombined = yield* store.effectiveSnapshotCitationEvidence(databasePath, baseSnapshotId, {});
        expect(cleanCombined.fileInventoryCoverage).toBe('complete');
        expect(
          EffectArray.map(combined.filesByPaths, observation => [observation.path, observation.file?.contentHash]),
        ).toEqual([
          ['src/keep.ts', keepHash],
          ['src/deleted.ts', undefined],
        ]);
        expect(combined.filesByContentHashes[0]).toEqual(
          expect.objectContaining({contentHash: duplicateHash, truncated: true}),
        );
        expect(EffectArray.map(combined.symbolsByIds, symbol => symbol.id)).toEqual(['symbol-inherited']);
        expect(combined.symbolsBySemanticLocators[0]).toEqual(
          expect.objectContaining({truncated: true, symbols: [expect.objectContaining({id: 'symbol-new-target-b'})]}),
        );

        const exactPathFallback = yield* store.effectiveSnapshotCitationEvidence(databasePath, currentSnapshotId, {
          fileRelocationFallbacks: [{contentHash: keepHash, path: 'src/keep.ts'}],
        });
        expect(exactPathFallback.filesByPaths).toEqual([
          {file: expect.objectContaining({contentHash: keepHash}), path: 'src/keep.ts'},
        ]);
        expect(exactPathFallback.filesByContentHashes).toEqual([]);

        const duplicateMaximumFallback = yield* store.effectiveSnapshotCitationEvidence(
          databasePath,
          currentSnapshotId,
          {
            fileRelocationFallbacks: Array.from({length: 400}, () => ({
              contentHash: keepHash,
              path: 'src/keep.ts',
            })),
            paths: Array.from({length: 400}, () => 'src/keep.ts'),
          },
        );
        expect(duplicateMaximumFallback.filesByPaths).toHaveLength(1);
        expect(duplicateMaximumFallback.filesByContentHashes).toEqual([]);

        const missingPathFallback = yield* store.effectiveSnapshotCitationEvidence(databasePath, currentSnapshotId, {
          fileRelocationFallbacks: [{contentHash: duplicateHash, path: 'src/missing.ts'}],
        });
        expect(missingPathFallback.filesByPaths).toEqual([{path: 'src/missing.ts'}]);
        expect(
          Effect2.Option.getOrUndefined(
            Effect2.Option.map(
              Effect2.Option.fromNullishOr(missingPathFallback.filesByContentHashes[0]?.files),
              __effectOptionalArrayReceiver => EffectArray.map(__effectOptionalArrayReceiver, file => file.path),
            ),
          ),
        ).toEqual(['src/base-copy.ts', 'src/current-copy.ts']);

        yield* withCitationDatabase(databasePath, database => {
          const pathPlan = queryPlan(
            database,
            codeGraphEffectiveFilesByPathsQueryStatement(currentSnapshotId, baseSnapshotId, ['src/keep.ts']),
          );
          expect(pathPlan).toMatch(/SEARCH current_files USING PRIMARY KEY \(snapshot_id=\? AND path=\?\)/u);
          expect(pathPlan).not.toMatch(/SCAN current_files/u);

          const hashPlan = queryPlan(
            database,
            codeGraphEffectiveFilesByContentHashesQueryStatement(currentSnapshotId, baseSnapshotId, [duplicateHash], 2),
          );
          expect(hashPlan).toMatch(
            /SEARCH current_files USING INDEX snapshot_files_content_hash \(content_hash=\? AND snapshot_id=\?\)/u,
          );
          expect(hashPlan).toMatch(/SEARCH current_files USING INDEX snapshot_files_raw_content_hash/u);
          expect(hashPlan).not.toMatch(/SCAN current_files/u);

          const locatorPlan = queryPlan(
            database,
            codeGraphEffectiveSymbolsBySemanticLocatorsQueryStatement(
              currentSnapshotId,
              baseSnapshotId,
              [targetLocator],
              2,
            ),
          );
          expect(locatorPlan).toMatch(
            /SEARCH current_symbols USING INDEX symbols_qualified_nocase \(snapshot_id=\? AND qualified_name=\?\)/u,
          );
          expect(locatorPlan).not.toMatch(/SCAN current_symbols/u);
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('requires a current-snapshot receipt for authoritative inventory coverage', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* CodeGraphStore;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-citation-inventory-coverage-'});
        const databasePath = path.join(root, 'graph.sqlite');
        const identity: RepositoryIdentity = {
          caseMode: 'sensitive',
          checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
          displayName: 'citation-inventory-coverage',
          gitCommonDirectory: path.join(root, '.git'),
          headCommit: Effect2.pipe('1', EffectString.repeat(40)),
          objectFormat: 'sha1',
          repoRoot: root,
          repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
          worktreeId: Effect2.pipe('c', EffectString.repeat(64)),
        };
        const keep: CodeGraphInventoryFile = {
          blobId: Effect2.pipe('2', EffectString.repeat(40)),
          contentHash: Effect2.pipe('d', EffectString.repeat(64)),
          language: 'typescript',
          mode: '100644',
          path: 'src/keep.ts',
          size: 16,
          source: 'commit',
        };
        const removed: CodeGraphInventoryFile = {
          ...keep,
          blobId: Effect2.pipe('3', EffectString.repeat(40)),
          contentHash: Effect2.pipe('e', EffectString.repeat(64)),
          path: 'src/removed.ts',
        };
        const base = citationSnapshot(identity, {
          commit: Effect2.pipe('1', EffectString.repeat(40)),
          fileCount: 2,
          id: `cgsn_${Effect2.pipe('4', EffectString.repeat(40))}`,
        });
        const alias = citationSnapshot(identity, {
          baseSnapshotId: base.id,
          commit: Effect2.pipe('2', EffectString.repeat(40)),
          fileCount: 2,
          id: `cgsn_${Effect2.pipe('5', EffectString.repeat(40))}`,
        });
        const incremental = citationSnapshot(identity, {
          baseSnapshotId: base.id,
          commit: Effect2.pipe('3', EffectString.repeat(40)),
          fileCount: 1,
          id: `cgsn_${Effect2.pipe('6', EffectString.repeat(40))}`,
        });
        const independent = citationSnapshot(identity, {
          commit: incremental.commit,
          fileCount: 1,
          id: `cgsn_${Effect2.pipe('7', EffectString.repeat(40))}`,
        });
        const inventory = completeInventoryReuseReceipt();
        const reusableReceipt = {
          fileSetFingerprint: Effect2.pipe('f', EffectString.repeat(64)),
          inventory,
          packProvenance: [],
          workspaceFingerprint: inventory.workspace.fingerprint,
        } as const;
        const skippedReceipt = {
          ...reusableReceipt,
          inventory: {...inventory, skipped: 1},
        } as const;
        const activate = (
          files: readonly CodeGraphInventoryFile[],
          snapshot: CodeGraphSnapshot,
          receipt: typeof reusableReceipt | typeof skippedReceipt | undefined,
        ) =>
          Effect.gen(function* () {
            yield* store.prepareActivation(databasePath, files);
            yield* store.stageActivationFacts(databasePath, [], []);
            yield* store.resolveStagedReferences(databasePath);
            yield* store.activateStaged(databasePath, identity, snapshot, receipt);
          });

        yield* store.initialize(databasePath);
        yield* store.withSession(
          databasePath,
          Effect.gen(function* () {
            yield* activate([keep, removed], base, reusableReceipt);
            yield* store.activateCleanSnapshotAlias!(databasePath, identity, alias, base.id, reusableReceipt);
            yield* activate([keep], incremental, skippedReceipt);
            yield* activate([keep], independent, reusableReceipt);

            const request = {
              contentHashes: [keep.contentHash, removed.contentHash],
              paths: [keep.path, removed.path],
            };
            const baseEvidence = yield* store.effectiveSnapshotCitationEvidence(databasePath, base.id, request);
            const aliasEvidence = yield* store.effectiveSnapshotCitationEvidence(databasePath, alias.id, request);
            const incrementalEvidence = yield* store.effectiveSnapshotCitationEvidence(
              databasePath,
              incremental.id,
              request,
            );
            const independentEvidence = yield* store.effectiveSnapshotCitationEvidence(
              databasePath,
              independent.id,
              request,
            );

            expect(baseEvidence.fileInventoryCoverage).toBe('complete');
            expect(aliasEvidence.fileInventoryCoverage).toBe('complete');
            expect(incrementalEvidence.fileInventoryCoverage).toBe('incomplete');
            expect(independentEvidence.fileInventoryCoverage).toBe('complete');
            expect(incrementalEvidence.filesByPaths).toEqual(independentEvidence.filesByPaths);
            expect(incrementalEvidence.filesByContentHashes).toEqual(independentEvidence.filesByContentHashes);
            expect(incrementalEvidence.filesByPaths).toEqual([
              {file: expect.objectContaining({contentHash: keep.contentHash}), path: keep.path},
              {path: removed.path},
            ]);
            const removedCitation = createMemoryCodeCitation({
              extractorSet: base.extractorSet,
              fileContentHash: {algorithm: 'sha256', value: removed.contentHash},
              path: removed.path,
              repositoryId: identity.repositoryId,
              repositoryIdentityKind: 'local',
              sourceCommit: base.commit,
              sourceDirty: false,
              sourceSnapshotId: base.id,
              target: {kind: 'file'},
              version: 1,
            });
            expect(
              validateContextBriefFileCitation(
                removedCitation,
                incrementalEvidence.filesByPaths[1],
                incrementalEvidence.filesByContentHashes[1],
                incremental,
                '2026-08-27T00:00:00.000Z',
                incrementalEvidence.fileInventoryCoverage,
              ),
            ).toMatchObject({coverage: 'incomplete', reason: 'graph-incomplete', status: 'unknown'});
          }),
        );
      }).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );
});

describe('versioned code graph source-span hashing', () => {
  effectIt('canonicalizes recognized line endings and UTF-8 encodes Unicode source', () => {
    const source = 'const value = "😀";\r\nreturn value;\u2028done';
    const span = {
      column: 1,
      endColumn: 5,
      endLine: 3,
      line: 1,
    };
    const result = codeGraphSourceSpanFragment(source, span);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fragment.text).toBe('const value = "😀";\nreturn value;\ndone');
    expect(new TextDecoder().decode(result.fragment.bytes)).toBe(result.fragment.text);
    expect(result.fragment.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(createCodeGraphSourceSpanCanonicalizer(source).fragment(span)).toEqual(result);
  });

  effectIt('rejects coordinates that split a Unicode surrogate pair', () => {
    expect(codeGraphSourceSpanFragment('a😀b', {column: 3, endColumn: 4, endLine: 1, line: 1})).toEqual({
      ok: false,
      reason: 'split-surrogate',
    });
    expect(codeGraphSourceSpanFragment('a😀b', {column: 2, endColumn: 4, endLine: 1, line: 1})).toEqual(
      expect.objectContaining({ok: true}),
    );
  });

  effectIt('rejects zero-based fixture coordinates because extractor spans are one-based', () => {
    expect(codeGraphSourceSpanFragment('value', {column: 0, endColumn: 5, endLine: 1, line: 1})).toEqual({
      ok: false,
      reason: 'invalid-coordinate',
    });
  });

  effectIt('does not conflate canonically equivalent but byte-distinct Unicode', () => {
    const composed = codeGraphSourceSpanFragment('é', {column: 1, endColumn: 2, endLine: 1, line: 1});
    const decomposed = codeGraphSourceSpanFragment('e\u0301', {column: 1, endColumn: 3, endLine: 1, line: 1});
    expect(composed.ok && decomposed.ok && composed.fragment.sha256).not.toBe(
      composed.ok && decomposed.ok ? decomposed.fragment.sha256 : undefined,
    );
  });

  fcProp(
    effectIt,
    'produces identical fragments for LF and CRLF spellings of the same logical source',
    {
      lines: FC.array(
        FC.array(FC.constantFrom('a', 'Z', '0', ' ', '\t', 'é', '中', '😀'), {maxLength: 30}).map(value =>
          EffectArray.join(value, ''),
        ),
        {maxLength: 12, minLength: 1},
      ),
    },
    ({lines}) => {
      const endColumn = (lines.at(-1)?.length ?? 0) + 1;
      const span = {column: 1, endColumn, endLine: lines.length, line: 1};
      const lf = codeGraphSourceSpanFragment(EffectArray.join(lines, '\n'), span);
      const crlf = codeGraphSourceSpanFragment(EffectArray.join(lines, '\r\n'), span);
      expect(lf.ok).toBe(true);
      expect(crlf.ok).toBe(true);
      if (!lf.ok || !crlf.ok) return;
      expect(crlf.fragment.text).toBe(lf.fragment.text);
      expect(crlf.fragment.bytes).toEqual(lf.fragment.bytes);
      expect(crlf.fragment.sha256).toBe(lf.fragment.sha256);
    },
    {fastCheck: {numRuns: 150}},
  );
});

function withCitationDatabase<A>(databasePath: string, use: (database: Database) => A): Effect.Effect<A> {
  return Effect.acquireUseRelease(
    Effect.sync(() => new Database(databasePath, {strict: true})),
    database => Effect.sync(() => use(database)),
    database => Effect.sync(() => database.close(false)),
  );
}

function queryPlan(
  database: Database,
  statement: {readonly parameters: readonly (number | string)[]; readonly text: string},
): string {
  return EffectArray.join(
    EffectArray.map(
      database
        .query<
          {
            readonly detail: string;
          },
          SQLQueryBindings[]
        >(`EXPLAIN QUERY PLAN ${statement.text}`)
        .all(...statement.parameters),
      row => row.detail,
    ),
    '\n',
  );
}

function seedCitationDatabase(database: Database): void {
  database.exec('PRAGMA foreign_keys = ON');
  database
    .query(
      `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
       VALUES ('citation-repository', 'citation-repository', 'sha1', '2026-08-26T00:00:00.000Z',
         '2026-08-26T00:00:00.000Z')`,
    )
    .run();
  const insertSnapshot = database.query(
    `INSERT INTO snapshots (
      id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
      dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at
    ) VALUES (?, 'citation-repository', 'citation-worktree', ?, ?, ?, 'native-code-graph-13',
      ?, ?, 'ready', ?, ?, 0, '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:01.000Z')`,
  );
  insertSnapshot.run(baseSnapshotId, Effect2.pipe('a', EffectString.repeat(40)), 'base-content', null, 0, null, 5, 5);
  insertSnapshot.run(
    currentSnapshotId,
    Effect2.pipe('b', EffectString.repeat(40)),
    'current-content',
    baseSnapshotId,
    1,
    'overlay-fingerprint',
    4,
    5,
  );
  const workspace = mergeCodeGraphWorkspaces([]);
  const inventoryReceipt = encodeCodeGraphInventoryReuseReceipt(completeInventoryReuseReceipt(workspace));
  database
    .query(
      `INSERT INTO snapshot_reuse_receipts (
        snapshot_id, format_version, resolution_surface_version, extractor_set, workspace_fingerprint,
        file_set_fingerprint, lookup_count, alias_count, reexport_count, inventory_receipt_json, created_at
      ) VALUES (?, ?, 1, 'native-code-graph-13', ?, ?, 0, 0, 0, ?, '2026-08-26T00:00:01.000Z')`,
    )
    .run(
      baseSnapshotId,
      CODE_GRAPH_REUSABLE_BASE_RECEIPT_VERSION,
      workspace.fingerprint,
      Effect2.pipe('a', EffectString.repeat(64)),
      inventoryReceipt,
    );

  const insertFile = database.query(
    `INSERT INTO snapshot_files (snapshot_id, path, content_hash, language, mode, size, source)
     VALUES (?, ?, ?, 'typescript', '100644', 16, ?)`,
  );
  insertFile.run(baseSnapshotId, 'src/keep.ts', keepHash, 'commit');
  insertFile.run(baseSnapshotId, 'src/override.ts', oldHash, 'commit');
  insertFile.run(baseSnapshotId, 'src/deleted.ts', deletedHash, 'commit');
  insertFile.run(baseSnapshotId, 'src/base-copy.ts', duplicateHash, 'commit');
  insertFile.run(baseSnapshotId, 'src/old-target.ts', duplicateHash, 'commit');
  insertFile.run(currentSnapshotId, 'src/override.ts', newHash, 'worktree');
  insertFile.run(currentSnapshotId, 'src/current-copy.ts', duplicateHash, 'worktree');
  insertFile.run(currentSnapshotId, 'src/current-copy-2.ts', Effect2.pipe('6', EffectString.repeat(64)), 'worktree');
  insertFile.run(currentSnapshotId, 'src/extra.ts', Effect2.pipe('7', EffectString.repeat(64)), 'worktree');
  database
    .query('UPDATE snapshot_files SET raw_content_hash = ? WHERE snapshot_id = ? AND path = ?')
    .run(legacyRawHash, currentSnapshotId, 'src/extra.ts');
  database
    .query('INSERT INTO snapshot_file_deletions (snapshot_id, path) VALUES (?, ?)')
    .run(currentSnapshotId, 'src/deleted.ts');
  database
    .query('INSERT INTO snapshot_file_deletions (snapshot_id, path) VALUES (?, ?)')
    .run(currentSnapshotId, 'src/old-target.ts');

  insertSymbol(database, baseSnapshotId, {
    id: 'symbol-inherited',
    name: inheritedLocator.name,
    path: 'src/keep.ts',
    qualifiedName: inheritedLocator.qualifiedName,
    signature: 'function inherited(): void',
  });
  insertSymbol(database, baseSnapshotId, {
    id: 'symbol-overridden',
    name: 'overridden',
    path: 'src/override.ts',
    qualifiedName: 'overridden',
    signature: 'function overridden(): void',
  });
  insertSymbol(database, baseSnapshotId, {
    id: 'symbol-deleted',
    name: 'deleted',
    path: 'src/deleted.ts',
    qualifiedName: 'deleted',
    signature: 'function deleted(): void',
  });
  insertSymbol(database, baseSnapshotId, {
    id: 'symbol-old-target',
    name: targetLocator.name,
    path: 'src/old-target.ts',
    qualifiedName: targetLocator.qualifiedName,
    signature: 'function target(): void',
  });
  insertSymbol(database, baseSnapshotId, {
    id: 'symbol-base-copy',
    name: 'baseCopy',
    path: 'src/base-copy.ts',
    qualifiedName: 'baseCopy',
    signature: 'function baseCopy(): void',
  });
  insertSymbol(database, currentSnapshotId, {
    id: 'symbol-overridden',
    name: 'overridden',
    path: 'src/override.ts',
    qualifiedName: 'overridden',
    signature: 'function overridden(value: string): void',
  });
  insertSymbol(database, currentSnapshotId, {
    id: 'symbol-new-target-a',
    name: targetLocator.name,
    path: 'src/current-copy.ts',
    qualifiedName: targetLocator.qualifiedName,
    signature: 'function target(): void',
  });
  insertSymbol(database, currentSnapshotId, {
    id: 'symbol-new-target-b',
    name: targetLocator.name,
    path: 'src/current-copy-2.ts',
    qualifiedName: targetLocator.qualifiedName,
    signature: 'function target(): void',
  });
  insertSymbol(database, currentSnapshotId, {
    id: 'symbol-extra',
    name: 'extra',
    path: 'src/extra.ts',
    qualifiedName: 'extra',
    signature: 'function extra(): void',
  });
  insertSymbol(database, currentSnapshotId, {
    id: 'symbol-unrelated',
    name: 'unrelated',
    path: 'src/override.ts',
    qualifiedName: 'unrelated',
    signature: 'function unrelated(): void',
  });
  const insertSymbolDeletion = database.query(
    'INSERT INTO snapshot_symbol_deletions (snapshot_id, symbol_id) VALUES (?, ?)',
  );
  insertSymbolDeletion.run(currentSnapshotId, 'symbol-deleted');
  insertSymbolDeletion.run(currentSnapshotId, 'symbol-old-target');
}

function completeInventoryReuseReceipt(workspace = mergeCodeGraphWorkspaces([])) {
  return {
    attributionFiles: [],
    contract: Effect2.pipe('8', EffectString.repeat(64)),
    diagnostics: [],
    environmentFingerprint: Effect2.pipe('9', EffectString.repeat(64)),
    includeOpaqueCorpusAssets: true,
    policyExclusions: {
      bytes: 0,
      files: 0,
      policyVersion: 2 as const,
      reasons: EffectArray.map(CODE_GRAPH_INVENTORY_EXCLUSION_REASONS, reason => ({bytes: 0, files: 0, reason})),
    },
    skipped: 0,
    version: CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
    workspace,
  };
}

function currentSnapshot(): CodeGraphSnapshot {
  return {
    baseSnapshotId,
    commit: Effect2.pipe('b', EffectString.repeat(40)),
    dirty: true,
    edgeCount: 0,
    extractorSet: 'native-code-graph-13',
    fileCount: 4,
    id: currentSnapshotId,
    overlayFingerprint: 'overlay-fingerprint',
    repositoryId: 'citation-repository',
    state: 'ready',
    symbolCount: 5,
    worktreeId: 'citation-worktree',
  };
}

function citationSnapshot(
  identity: RepositoryIdentity,
  input: {
    readonly baseSnapshotId?: string;
    readonly commit: string;
    readonly fileCount: number;
    readonly id: string;
  },
): CodeGraphSnapshot {
  return {
    ...(input.baseSnapshotId === undefined ? {} : {baseSnapshotId: input.baseSnapshotId}),
    commit: input.commit,
    dirty: false,
    edgeCount: 0,
    extractorSet: 'citation-inventory-coverage-v1',
    fileCount: input.fileCount,
    id: input.id,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 0,
    worktreeId: identity.worktreeId,
  };
}

function insertSymbol(
  database: Database,
  snapshotId: string,
  input: {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly qualifiedName: string;
    readonly signature: string;
  },
): void {
  database
    .query(
      `INSERT INTO symbols (
        snapshot_id, id, content_hash, kind, name, qualified_name, path, language, arity,
        lookup_keys_json, resolution_domain, resolution_scope_id, package_name, exported,
        signature, documentation, span_json
      ) VALUES (?, ?, ?, 'function', ?, ?, ?, 'typescript', 0, '[]', NULL, NULL, NULL, 1, ?, NULL, ?)`,
    )
    .run(
      snapshotId,
      input.id,
      snapshotId === baseSnapshotId ? keepHash : newHash,
      input.name,
      input.qualifiedName,
      input.path,
      input.signature,
      JSON.stringify({column: 1, endColumn: 2, endLine: 1, line: 1}),
    );
}
