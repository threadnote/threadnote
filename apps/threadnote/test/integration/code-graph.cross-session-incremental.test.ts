import {TestError} from '@threadnote/testing/test-error';
import {Array as EffectArray} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import {Context, Effect, Layer, Option, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {CommandExecutor} from '@threadnote/platform/command';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {codeGraphCommittedFileContentHash} from '@threadnote/graph/content_identity';
import {inventoryRepositoryFromReusableCleanBase, worktreeBuildRequestObservation} from '@threadnote/graph/inventory';
import {inventoryRepositoryFromReusableCleanBaseSlice} from '@threadnote/graph/inventory/sparse';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {
  BUILTIN_LANGUAGE_PACK_REGISTRY,
  CodeGraphLanguagePackRegistry,
  createCodeGraphLanguagePackRegistry,
  type CodeGraphLanguagePackRegistryShape,
} from '@threadnote/graph/languages/registry';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {
  CodeGraphStore,
  materializedShardDerivationIdentity,
  type CodeGraphVisualizationCatalog,
} from '@threadnote/graph/store';
import {CODE_GRAPH_EXTRACTOR_GENERATION, type CodeGraphIndexSummary} from '@threadnote/graph/types';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '@threadnote/graph/index_scope';
import {CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES} from '@threadnote/graph/inventory/policy';
import {
  validateContextBriefFileCitation,
  validateContextBriefMemoryCitations,
} from '@threadnote/context/citation_validation';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {sha256HexSync} from '@threadnote/platform/sha256';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

describe('cross-session code graph increments', () => {
  it.effect('shares a clean structural root across divergent sibling worktrees', () => {
    let home: string | undefined;
    let fullHome: string | undefined;
    let root: string | undefined;
    let siblingRoot: string | undefined;
    return Effect.gen(function* () {
      root = createRepository(24);
      siblingRoot = `${root}-sibling`;
      git(root, ['branch', 'sibling']);
      git(root, ['worktree', 'add', '-q', siblingRoot, 'sibling']);
      writeFileSync(
        join(root, 'src/passive-0.ts'),
        'export function passive0(): number { return 0; }\n// first branch\n',
      );
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'first branch']);
      writeFileSync(
        join(siblingRoot, 'src/passive-1.ts'),
        'export function passive1(): number { return 1; }\n// sibling branch\n',
      );
      git(siblingRoot, ['add', '.']);
      git(siblingRoot, ['commit', '-qm', 'sibling branch']);
      home = mkdtempSync(join(tmpdir(), 'threadnote-sibling-structural-root-home-'));
      fullHome = mkdtempSync(join(tmpdir(), 'threadnote-sibling-structural-full-home-'));

      const first = yield* indexAndLoadEffect(root, home);
      const sibling = yield* indexAndLoadEffect(siblingRoot, home);
      const indexer = yield* CodeGraphIndexer;
      const fullSummary = yield* indexer.index({cwd: siblingRoot, incrementalOverlay: false, threadnoteHome: fullHome});
      const full = yield* loadGraphEffect(siblingRoot, fullHome, fullSummary);
      expect(sibling.summary.materialization?.mode).toBe('incremental-clean');
      expect(sibling.summary.snapshot.baseSnapshotId).toBe(first.summary.snapshot.id);
      expect(projectGraph(sibling.graph)).toEqual(projectGraph(full));
      const database = new Database(first.databasePath, {readonly: true});
      try {
        const rows = database
          .query<{component_surfaces_json: string | null; snapshot_id: string}, SQLQueryBindings[]>(
            'SELECT snapshot_id, component_surfaces_json FROM snapshot_reuse_receipts WHERE snapshot_id = ?',
          )
          .all(first.summary.snapshot.id);
        expect(rows[0]?.component_surfaces_json).not.toBeNull();
        const physical = requiredRow(
          database
            .query<{count: number}, SQLQueryBindings[]>('SELECT COUNT(*) AS count FROM symbols WHERE snapshot_id = ?')
            .get(sibling.summary.snapshot.id),
        );
        expect(physical.count).toBeLessThan(sibling.summary.snapshot.symbolCount);
      } finally {
        database.close();
      }
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [siblingRoot, root, home, fullHome])),
    );
  });

  it.effect('tries an older compatible sibling root after a newer root exceeds the overlay budget', () => {
    let home: string | undefined;
    let root: string | undefined;
    let recentRoot: string | undefined;
    let targetRoot: string | undefined;
    return Effect.gen(function* () {
      root = createRepository(24);
      recentRoot = `${root}-recent`;
      targetRoot = `${root}-target`;
      git(root, ['branch', 'recent']);
      git(root, ['branch', 'target']);
      git(root, ['worktree', 'add', '-q', recentRoot, 'recent']);
      git(root, ['worktree', 'add', '-q', targetRoot, 'target']);
      writeFileSync(join(root, 'src/passive-0.ts'), 'export function passive0(): number { return 0; }\n// older\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'older root']);
      for (let index = 0; index < 201; index += 1) {
        writeFileSync(
          join(recentRoot, 'src', `extra-${index}.ts`),
          `export function extra${index}(): number { return ${index}; }\n`,
        );
      }
      git(recentRoot, ['add', '.']);
      git(recentRoot, ['commit', '-qm', 'recent unrelated root']);
      writeFileSync(
        join(targetRoot, 'src/passive-1.ts'),
        'export function passive1(): number { return 1; }\n// target\n',
      );
      git(targetRoot, ['add', '.']);
      git(targetRoot, ['commit', '-qm', 'target root']);
      home = mkdtempSync(join(tmpdir(), 'threadnote-ranked-sibling-roots-home-'));

      const older = yield* indexAndLoadEffect(root, home);
      const indexer = yield* CodeGraphIndexer;
      const recent = yield* indexer.index({cwd: recentRoot, force: true, threadnoteHome: home});
      const target = yield* indexAndLoadEffect(targetRoot, home);
      expect(recent.snapshot.baseSnapshotId).toBeUndefined();
      expect(target.summary.materialization?.mode).toBe('incremental-clean');
      expect(target.summary.snapshot.baseSnapshotId).toBe(older.summary.snapshot.id);
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [targetRoot, recentRoot, root, home])),
    );
  });

  it.effect(
    'keeps one content identity when committed code is relocated through a dirty overlay',
    () => {
      let home: string | undefined;
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository();
        home = mkdtempSync(join(tmpdir(), 'threadnote-citation-dirty-relocation-home-'));
        const initial = yield* indexAndLoadEffect(root, home);
        const store = yield* CodeGraphStore;
        const originalPath = 'src/use.ts';
        const relocatedPath = 'src/relocated-use.ts';
        const initialEvidence = yield* store.effectiveSnapshotCitationEvidence(
          initial.databasePath,
          initial.summary.snapshot.id,
          {paths: [originalPath]},
        );
        const citedFile = initialEvidence.filesByPaths[0]?.file;
        expect(citedFile).toMatchObject({path: originalPath, source: 'commit'});
        const citedSymbol = Option.getOrUndefined(
          EffectArray.findFirst(
            initial.graph.symbols,
            symbol => symbol.path === originalPath && symbol.name === 'useHelper',
          ),
        );
        expect(citedSymbol).toBeDefined();
        const config = {
          account: 'test',
          agentContextHome: home,
          agentId: 'test-agent',
          manifestPath: join(home, 'seed-manifest.yaml'),
          user: 'test-user',
        } satisfies RuntimeConfig;
        const captured = yield* captureMemoryCodeCitations(config, {
          callerCwd: root,
          refs: [originalPath, citedSymbol!.id],
        });
        expect(captured).toHaveLength(2);
        expect(captured[0]).toMatchObject({
          fileContentHash: {value: citedFile!.contentHash},
          target: {kind: 'file'},
        });
        expect(captured[1]).toMatchObject({
          fileContentHash: {value: citedFile!.contentHash},
          target: {kind: 'symbol', nodeId: citedSymbol!.id},
        });

        git(root, ['mv', originalPath, relocatedPath]);
        const dirtyIdentity = yield* resolveRepositoryIdentity(root);
        const dirtyObservation = yield* worktreeBuildRequestObservation(dirtyIdentity, home);
        const relocatedBytes = readFileSync(join(root, relocatedPath));
        const normalizedHash = codeGraphCommittedFileContentHash(dirtyIdentity.objectFormat, relocatedBytes);
        const rawHash = sha256HexSync(relocatedBytes);
        expect(normalizedHash).not.toBe(rawHash);
        expect(dirtyObservation.overlay.files).toEqual([
          {contentHash: normalizedHash, path: relocatedPath, size: relocatedBytes.byteLength},
        ]);
        const legacyFingerprint = sha256HexSync(
          EffectArray.join(
            [
              'build-request-overlay-v1',
              `I\0${sha256HexSync('')}`,
              ...EffectArray.map(dirtyObservation.overlay.deletedPaths, relative => `D\0${relative}`),
              `F\0${relocatedPath}\0${rawHash}`,
            ],
            '\n',
          ),
        );
        expect(dirtyObservation.state.fingerprint).not.toBe(legacyFingerprint);
        const dirty = yield* indexAndLoadEffect(root, home);
        expect(dirty.summary.snapshot.dirty).toBe(true);
        const currentEvidence = yield* store.effectiveSnapshotCitationEvidence(
          dirty.databasePath,
          dirty.summary.snapshot.id,
          {
            contentHashes: [citedFile!.contentHash],
            paths: [originalPath, relocatedPath],
          },
        );
        expect(currentEvidence.filesByPaths).toEqual([
          {path: originalPath},
          {
            file: expect.objectContaining({
              contentHash: citedFile!.contentHash,
              path: relocatedPath,
              source: 'worktree',
            }),
            path: relocatedPath,
          },
        ]);
        expect(currentEvidence.filesByContentHashes[0]).toMatchObject({
          files: [{contentHash: citedFile!.contentHash, path: relocatedPath, source: 'worktree'}],
          truncated: false,
        });
        const legacyEvidence = yield* store.effectiveSnapshotCitationEvidence(
          dirty.databasePath,
          dirty.summary.snapshot.id,
          {
            contentHashes: [rawHash],
            paths: [relocatedPath, originalPath],
          },
        );
        expect(legacyEvidence.filesByPaths[0]?.file).toMatchObject({
          contentHash: citedFile!.contentHash,
          path: relocatedPath,
          rawContentHash: rawHash,
          source: 'worktree',
        });
        expect(legacyEvidence.filesByContentHashes[0]).toMatchObject({
          files: [
            {
              contentHash: citedFile!.contentHash,
              path: relocatedPath,
              rawContentHash: rawHash,
              source: 'worktree',
            },
          ],
          truncated: false,
        });
        const dirtyCaptured = yield* captureMemoryCodeCitations(config, {
          callerCwd: root,
          refs: [relocatedPath],
        });
        expect(dirtyCaptured).toEqual([
          expect.objectContaining({
            fileContentHash: expect.objectContaining({value: citedFile!.contentHash}),
            path: relocatedPath,
            sourceDirty: true,
            target: {kind: 'file'},
          }),
        ]);

        const citation = Option.getOrUndefined(EffectArray.findFirst(captured, item => item.target.kind === 'file'))!;
        expect(
          validateContextBriefFileCitation(
            citation,
            currentEvidence.filesByPaths[0],
            currentEvidence.filesByContentHashes[0],
            dirty.summary.snapshot,
            '2026-08-27T00:00:00.000Z',
            currentEvidence.fileInventoryCoverage,
          ),
        ).toMatchObject({observedPath: relocatedPath, reason: 'relocated', status: 'relocated'});

        const legacyCitation = (path: string) =>
          createMemoryCodeCitation({
            extractorSet: citation.extractorSet,
            fileContentHash: {algorithm: 'sha256', value: rawHash},
            path,
            repositoryId: citation.repositoryId,
            repositoryIdentityKind: citation.repositoryIdentityKind,
            sourceCommit: citation.sourceCommit,
            sourceDirty: true,
            sourceSnapshotId: citation.sourceSnapshotId,
            target: {kind: 'file'},
            version: 1,
          });
        expect(
          validateContextBriefFileCitation(
            legacyCitation(relocatedPath),
            legacyEvidence.filesByPaths[0],
            legacyEvidence.filesByContentHashes[0],
            dirty.summary.snapshot,
            '2026-08-27T00:00:00.000Z',
            legacyEvidence.fileInventoryCoverage,
          ),
        ).toMatchObject({observedPath: relocatedPath, reason: 'exact', status: 'exact'});
        expect(
          validateContextBriefFileCitation(
            legacyCitation(originalPath),
            legacyEvidence.filesByPaths[1],
            legacyEvidence.filesByContentHashes[0],
            dirty.summary.snapshot,
            '2026-08-27T00:00:00.000Z',
            legacyEvidence.fileInventoryCoverage,
          ),
        ).toMatchObject({observedPath: relocatedPath, reason: 'relocated', status: 'relocated'});

        const capturedSymbolCitation = Option.getOrUndefined(
          EffectArray.findFirst(captured, item => item.target.kind === 'symbol'),
        )!;
        const symbolValidations = yield* validateContextBriefMemoryCitations(
          config,
          {callerCwd: root, kind: 'repository'},
          [
            {
              citationErrorCount: 0,
              codeCitations: [capturedSymbolCitation],
              excerpt: 'The useHelper symbol calls helper.',
              kind: 'durable',
              project: 'threadnote',
              rank: 1,
              topic: 'citation-test',
              uri: 'threadnote://test/captured-symbol-relocation',
            },
          ],
        );
        expect(symbolValidations).toEqual([
          {
            receipts: [
              expect.objectContaining({
                citationId: capturedSymbolCitation.id,
                kind: 'symbol',
                observedPath: relocatedPath,
                reason: 'relocated',
                status: 'relocated',
              }),
            ],
            uri: 'threadnote://test/captured-symbol-relocation',
          },
        ]);

        git(root, ['add', '-A']);
        git(root, ['commit', '-qm', 'commit relocated use helper']);
        const committed = yield* indexAndLoadEffect(root, home);
        expect(committed.summary.snapshot.dirty).toBe(false);
        const committedLegacyEvidence = yield* store.effectiveSnapshotCitationEvidence(
          committed.databasePath,
          committed.summary.snapshot.id,
          {
            contentHashes: [rawHash],
            paths: [relocatedPath, originalPath],
          },
        );
        expect(committedLegacyEvidence.filesByPaths[0]?.file).toMatchObject({
          contentHash: citedFile!.contentHash,
          path: relocatedPath,
          rawContentHash: rawHash,
          source: 'commit',
        });
        expect(committedLegacyEvidence.filesByContentHashes[0]).toMatchObject({
          files: [
            {
              contentHash: citedFile!.contentHash,
              path: relocatedPath,
              rawContentHash: rawHash,
              source: 'commit',
            },
          ],
          truncated: false,
        });
        expect(
          validateContextBriefFileCitation(
            legacyCitation(relocatedPath),
            committedLegacyEvidence.filesByPaths[0],
            committedLegacyEvidence.filesByContentHashes[0],
            committed.summary.snapshot,
            '2026-08-27T00:00:00.000Z',
            committedLegacyEvidence.fileInventoryCoverage,
          ),
        ).toMatchObject({observedPath: relocatedPath, reason: 'exact', status: 'exact'});
        expect(
          validateContextBriefFileCitation(
            legacyCitation(originalPath),
            committedLegacyEvidence.filesByPaths[1],
            committedLegacyEvidence.filesByContentHashes[0],
            committed.summary.snapshot,
            '2026-08-27T00:00:00.000Z',
            committedLegacyEvidence.fileInventoryCoverage,
          ),
        ).toMatchObject({observedPath: relocatedPath, reason: 'relocated', status: 'relocated'});
      }).pipe(
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
        Effect.ensuring(removeTemporaryPaths(() => [root, home])),
      );
    },
    60_000,
  );

  it.effect(
    'falls back to an incomplete full snapshot when a cited path becomes skipped but still exists',
    () => {
      let home: string | undefined;
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository(8);
        mkdirSync(join(root, 'data'), {recursive: true});
        const citedPath = 'data/cited.json';
        writeFileSync(join(root, citedPath), '{"value":"cited"}\n');
        writeFileSync(join(root, 'data/keep.json'), '{"value":"keep"}\n');
        git(root, ['add', 'data']);
        git(root, ['commit', '--amend', '-qm', 'fixture with cited JSON']);
        home = mkdtempSync(join(tmpdir(), 'threadnote-skipped-citation-home-'));

        const initial = yield* indexAndLoadEffect(root, home);
        const store = yield* CodeGraphStore;
        const initialEvidence = yield* store.effectiveSnapshotCitationEvidence(
          initial.databasePath,
          initial.summary.snapshot.id,
          {paths: [citedPath]},
        );
        const citedFile = initialEvidence.filesByPaths[0]?.file;
        expect(citedFile).toBeDefined();
        expect(initialEvidence.fileInventoryCoverage).toBe('complete');

        // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
        const citedContent = JSON.stringify({value: 'x'.repeat(CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES)});
        writeFileSync(join(root, citedPath), citedContent);
        git(root, ['add', citedPath]);
        git(root, ['commit', '-qm', 'make cited JSON low-value']);
        expect(statSync(join(root, citedPath)).isFile()).toBe(true);

        const current = yield* indexAndLoadEffect(root, home);
        expect(current.summary.materialization).toMatchObject({fallbackReason: 'file-set-changed', mode: 'full'});
        const currentEvidence = yield* store.effectiveSnapshotCitationEvidence(
          current.databasePath,
          current.summary.snapshot.id,
          {
            contentHashes: [citedFile!.contentHash],
            paths: [citedPath],
          },
        );
        expect(currentEvidence.filesByPaths).toEqual([{path: citedPath}]);
        expect(currentEvidence.filesByContentHashes).toEqual([
          {contentHash: citedFile!.contentHash, files: [], truncated: false},
        ]);
        expect(currentEvidence.fileInventoryCoverage).toBe('incomplete');

        const citation = createMemoryCodeCitation({
          extractorSet: initial.summary.snapshot.extractorSet,
          fileContentHash: {algorithm: 'sha256', value: citedFile!.contentHash},
          path: citedPath,
          repositoryId: initial.summary.identity.repositoryId,
          repositoryIdentityKind: 'local',
          sourceCommit: initial.summary.snapshot.commit,
          sourceDirty: false,
          ...(initial.summary.snapshot.graphContentId === undefined
            ? {}
            : {sourceGraphContentId: initial.summary.snapshot.graphContentId}),
          sourceSnapshotId: initial.summary.snapshot.id,
          target: {kind: 'file'},
          version: 1,
        });
        expect(
          validateContextBriefFileCitation(
            citation,
            currentEvidence.filesByPaths[0],
            currentEvidence.filesByContentHashes[0],
            current.summary.snapshot,
            '2026-08-27T00:00:00.000Z',
            currentEvidence.fileInventoryCoverage,
          ),
        ).toMatchObject({coverage: 'incomplete', reason: 'graph-incomplete', status: 'unknown'});
      }).pipe(
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
        Effect.ensuring(removeTemporaryPaths(() => [root, home])),
      );
    },
    60_000,
  );

  it.effect(
    'persists current skipped-inventory coverage on a real clean incremental snapshot',
    () => {
      let home: string | undefined;
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository(8);
        mkdirSync(join(root, 'data'), {recursive: true});
        writeFileSync(join(root, 'data/keep.json'), '{"value":"keep"}\n');
        git(root, ['add', 'data/keep.json']);
        git(root, ['commit', '--amend', '-qm', 'fixture with JSON extractor context']);
        home = mkdtempSync(join(tmpdir(), 'threadnote-incremental-skipped-receipt-home-'));
        yield* indexAndLoadEffect(root, home);

        const skippedPath = 'data/skipped.json';
        writeFileSync(
          join(root, skippedPath),
          // oxlint-disable-next-line effecttsgo/prefer-effect-string -- The runtime count is not proven nonnegative; native repeat throws RangeError for negative counts while Effect String repeat returns an empty string.
          JSON.stringify({value: 'x'.repeat(CODE_GRAPH_GENERIC_JSON_EXCLUSION_BYTES)}),
        );
        writeUseFile(root, 'eligible change beside a skipped file');
        git(root, ['add', skippedPath, 'src/use.ts']);
        git(root, ['commit', '-qm', 'clean increment with skipped inventory']);

        const current = yield* indexAndLoadEffect(root, home);
        expect(current.summary.materialization).toMatchObject({mode: 'incremental-clean'});
        const store = yield* CodeGraphStore;
        const evidence = yield* store.effectiveSnapshotCitationEvidence(
          current.databasePath,
          current.summary.snapshot.id,
          {paths: [skippedPath]},
        );
        expect(evidence.filesByPaths).toEqual([{path: skippedPath}]);
        expect(evidence.fileInventoryCoverage).toBe('incomplete');
      }).pipe(
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
        Effect.ensuring(removeTemporaryPaths(() => [root, home])),
      );
    },
    60_000,
  );

  it.effect(
    're-promotes a recent clean increment after a dirty-to-clean round trip',
    () => {
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository(16);
        const home = join(root, '.threadnote-round-trip');
        const initial = yield* indexAndLoadEffect(root, home);
        expect(initial.summary.materialization?.mode).toBe('full');

        writeUseFile(root, 'committed clean revision');
        git(root, ['add', 'src/use.ts']);
        git(root, ['commit', '-qm', 'clean increment']);
        const committed = yield* indexAndLoadEffect(root, home);
        expect(committed.summary.materialization).toEqual({
          mode: 'incremental-clean',
          resolutionLookupKeyForm: 'typescript-path-unscoped',
          resolutionPublicationGate: 'own-path-local',
          stagedFiles: 1,
          totalFiles: 18,
        });

        writeUseFile(root, 'temporary dirty revision');
        const dirty = yield* indexAndLoadEffect(root, home);
        expect(dirty.summary.materialization?.mode).toBe('incremental-overlay');
        expect(
          persistedSnapshotState(committed.databasePath, committed.summary.snapshot.id),
          JSON.stringify(persistedSnapshotStates(committed.databasePath)),
        ).toBe('ready');

        git(root, ['checkout', '--', 'src/use.ts']);
        const restored = yield* indexAndLoadEffect(root, home);
        expect(restored.summary.snapshot.id).toBe(committed.summary.snapshot.id);
        expect(restored.summary.materialization).toEqual({
          mode: 'reused-snapshot',
          stagedFiles: 0,
          totalFiles: 18,
        });
        expect(projectGraph(restored.graph)).toEqual(projectGraph(committed.graph));
        expect(restored.health).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => (root === undefined ? undefined : rmSync(root, {force: true, recursive: true}))),
        ),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      );
    },
    60_000,
  );

  it.effect(
    'keeps an imported-symbol body edit incremental immediately after dirty-root alias promotion',
    () => {
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository(3);
        const home = join(root, '.threadnote-dirty-root-fresh-indexers');
        yield* indexWithFreshIndexerEffect(root, home);

        writeUseFile(root, 'dirty root committed verbatim');
        const dirtyRoot = yield* indexWithFreshIndexerEffect(root, home, {incrementalOverlay: false});
        expect(dirtyRoot.materialization).toMatchObject({fallbackReason: 'disabled', mode: 'full'});
        expect(dirtyRoot.snapshot).toMatchObject({baseSnapshotId: undefined, dirty: true});
        git(root, ['add', 'src/use.ts']);
        git(root, ['commit', '-qm', 'commit the indexed dirty root']);

        const committed = yield* indexWithFreshIndexerEffect(root, home);
        expect(committed.snapshot).toMatchObject({baseSnapshotId: dirtyRoot.snapshot.id, dirty: false});
        expect(committed.materialization).toEqual({mode: 'reused-snapshot', stagedFiles: 0, totalFiles: 5});
        expect(projectGraph(yield* loadGraphEffect(root, home, committed))).toEqual(
          projectGraph(yield* loadGraphEffect(root, home, dirtyRoot)),
        );

        // Keep the import/re-export evidence stable while changing only the
        // function body. This exercises persisted re-export lookup against the
        // leased dirty physical root behind the clean logical alias.
        writeUseFile(root, 'post-alias dirty revision');
        const next = yield* indexWithFreshIndexerEffect(root, home);
        expect(next.snapshot).toMatchObject({baseSnapshotId: dirtyRoot.snapshot.id, dirty: true});
        expect(next.materialization).toEqual({
          mode: 'incremental-overlay',
          resolutionLookupKeyForm: 'typescript-path-unscoped',
          resolutionPublicationGate: 'own-path-local',
          stagedFiles: 1,
          totalFiles: 5,
        });
        const nextGraph = yield* loadGraphEffect(root, home, next);
        const forced = yield* indexWithFreshIndexerEffect(root, home, {force: true});
        expect(projectGraph(nextGraph)).toEqual(projectGraph(yield* loadGraphEffect(root, home, forced)));
      }).pipe(
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
        Effect.ensuring(removeTemporaryPaths(() => [root])),
      );
    },
    60_000,
  );

  it.effect(
    'keeps disjoint sequential increments one-layered and graph-equivalent',
    () => {
      let fullHome: string | undefined;
      let incrementalHome: string | undefined;
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository(4);
        incrementalHome = mkdtempSync(join(tmpdir(), 'threadnote-sequential-incremental-home-'));
        fullHome = mkdtempSync(join(tmpdir(), 'threadnote-sequential-full-home-'));
        const indexer = yield* CodeGraphIndexer;
        const initial = yield* indexAndLoadEffect(root, incrementalHome);
        expect(initial.summary.materialization?.mode).toBe('full');

        writeUseFile(root, 'committed sequential revision');
        git(root, ['add', 'src/use.ts']);
        git(root, ['commit', '-qm', 'clean sequential increment']);
        const clean = yield* indexAndLoadEffect(root, incrementalHome);
        expect(clean.summary.materialization).toMatchObject({
          mode: 'incremental-clean',
          stagedFiles: 1,
        });
        expect(clean.summary.snapshot.baseSnapshotId).toBe(initial.summary.snapshot.id);
        expect(foldForwardProofStats(clean.databasePath, clean.summary.snapshot.id)).toMatchObject({
          paths: ['src/use.ts'],
          rootSnapshotId: initial.summary.snapshot.id,
        });

        writeFileSync(
          join(root, 'src/passive-0.ts'),
          'import {useHelper} from "./use.js";\nexport function passive0(): number { return useHelper().length + 100; }\n',
        );
        const dirty = yield* indexAndLoadEffect(root, incrementalHome);
        expect(dirty.summary.materialization).toMatchObject({
          carriedFiles: 1,
          freshStagedFiles: 1,
          mode: 'incremental-overlay',
          stagedFiles: 2,
        });
        expect(dirty.summary.incrementalWork).toMatchObject({
          changedFiles: 1,
          totalFiles: 6,
        });
        expect(dirty.summary.snapshot.baseSnapshotId).toBe(initial.summary.snapshot.id);
        expect(dirty.summary.snapshot.baseSnapshotId).not.toBe(clean.summary.snapshot.id);
        expect(persistedDeltaStats(dirty.databasePath, dirty.summary.snapshot.id)).toMatchObject({
          edgePaths: ['src/passive-0.ts', 'src/use.ts'],
          filePaths: ['src/passive-0.ts', 'src/use.ts'],
          symbolPaths: ['src/passive-0.ts', 'src/use.ts'],
        });

        const full = yield* indexer.index({
          cwd: root,
          incrementalOverlay: false,
          threadnoteHome: fullHome,
        });
        const rebuilt = yield* loadGraphEffect(root, fullHome, full);
        expect(projectGraph(dirty.graph)).toEqual(projectGraph(rebuilt));
        expect(yield* analysisDigestEffect(incrementalHome, dirty.summary)).toBe(
          yield* analysisDigestEffect(fullHome, full),
        );
        expect(normalizeCatalog(dirty.catalog)).toEqual(
          normalizeCatalog(yield* loadVisualizationCatalogEffect(fullHome, full)),
        );
        expect(dirty.health).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
      }).pipe(
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
        Effect.ensuring(removeTemporaryPaths(() => [root, incrementalHome, fullHome])),
      );
    },
    60_000,
  );

  it.effect(
    'replaces an overlapping prior delta without carrying stale rows',
    () => {
      let fullHome: string | undefined;
      let home: string | undefined;
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository(1);
        home = mkdtempSync(join(tmpdir(), 'threadnote-fold-forward-overlap-home-'));
        fullHome = mkdtempSync(join(tmpdir(), 'threadnote-fold-forward-overlap-full-home-'));
        const indexer = yield* CodeGraphIndexer;
        const initial = yield* indexAndLoadEffect(root, home);
        writeUseFile(root, 'committed overlapping revision');
        git(root, ['add', 'src/use.ts']);
        git(root, ['commit', '-qm', 'clean overlapping increment']);
        const clean = yield* indexAndLoadEffect(root, home);
        expect(foldForwardProofStats(clean.databasePath, clean.summary.snapshot.id)?.paths).toEqual(['src/use.ts']);

        writeUseFile(root, 'dirty overlapping revision');
        const overlapping = yield* indexAndLoadEffect(root, home);
        expect(overlapping.summary.materialization).toMatchObject({
          carriedFiles: 0,
          freshStagedFiles: 1,
          mode: 'incremental-overlay',
          stagedFiles: 1,
        });
        expect(overlapping.summary.incrementalWork).toMatchObject({changedFiles: 1, totalFiles: 3});
        expect(overlapping.summary.snapshot.baseSnapshotId).toBe(initial.summary.snapshot.id);
        expect(persistedDeltaStats(overlapping.databasePath, overlapping.summary.snapshot.id)).toMatchObject({
          edgePaths: ['src/use.ts'],
          filePaths: ['src/use.ts'],
          symbolPaths: ['src/use.ts'],
        });
        const full = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
        expect(projectGraph(overlapping.graph)).toEqual(projectGraph(yield* loadGraphEffect(root, fullHome, full)));
        expect(overlapping.health).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
      }).pipe(
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
        Effect.ensuring(removeTemporaryPaths(() => [root, home, fullHome])),
      );
    },
    60_000,
  );

  it.effect(
    'retains cumulative-root fallback when the layered fold proof is unavailable',
    () => {
      let fullHome: string | undefined;
      let home: string | undefined;
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository(1);
        home = mkdtempSync(join(tmpdir(), 'threadnote-fold-forward-proof-fallback-home-'));
        fullHome = mkdtempSync(join(tmpdir(), 'threadnote-fold-forward-proof-fallback-full-home-'));
        const indexer = yield* CodeGraphIndexer;
        const initial = yield* indexAndLoadEffect(root, home);
        writeUseFile(root, 'committed proof fallback revision');
        git(root, ['add', 'src/use.ts']);
        git(root, ['commit', '-qm', 'clean proof fallback increment']);
        const clean = yield* indexAndLoadEffect(root, home);
        expect(foldForwardProofStats(clean.databasePath, clean.summary.snapshot.id)).toBeDefined();
        deleteFoldForwardProof(clean.databasePath, clean.summary.snapshot.id);

        writeFileSync(join(root, 'src/passive-0.ts'), 'export function passive0(): number { return 200; }\n');
        const fallback = yield* indexAndLoadEffect(root, home);
        expect(fallback.summary.materialization).toMatchObject({mode: 'incremental-overlay', stagedFiles: 2});
        expect(fallback.summary.materialization).not.toHaveProperty('carriedFiles');
        expect(fallback.summary.incrementalWork).toMatchObject({changedFiles: 2, totalFiles: 3});
        expect(fallback.summary.snapshot.baseSnapshotId).toBe(initial.summary.snapshot.id);
        const full = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
        expect(projectGraph(fallback.graph)).toEqual(projectGraph(yield* loadGraphEffect(root, fullHome, full)));
        expect(fallback.health).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
      }).pipe(
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
        Effect.ensuring(removeTemporaryPaths(() => [root, home, fullHome])),
      );
    },
    60_000,
  );

  it.effect(
    'fails closed and preserves full-build equivalence for corrupt-but-present fold proofs',
    () => {
      const temporaryPaths: string[] = [];
      return Effect.gen(function* () {
        const indexer = yield* CodeGraphIndexer;
        for (const scenario of FOLD_FORWARD_PROOF_CORRUPTIONS) {
          const root = scenario.barrel ? createBarrelRepository() : createRepository(1);
          temporaryPaths.push(root);
          const incrementalHome = mkdtempSync(join(tmpdir(), `threadnote-fold-forward-${scenario.corruption}-home-`));
          temporaryPaths.push(incrementalHome);
          const fullHome = mkdtempSync(join(tmpdir(), `threadnote-fold-forward-${scenario.corruption}-full-home-`));
          temporaryPaths.push(fullHome);

          const initial = yield* indexAndLoadEffect(root, incrementalHome);
          if (scenario.barrel) {
            writeFileSync(
              join(root, 'src/index.ts'),
              '// Preserve the export surface while moving its evidence span.\nexport {decode, helper} from "./helper.js";\n',
            );
          } else {
            writeUseFile(root, `committed ${scenario.corruption} proof revision`);
          }
          git(root, ['add', '.']);
          git(root, ['commit', '-qm', `clean ${scenario.corruption} proof increment`]);
          const clean = yield* indexAndLoadEffect(root, incrementalHome);
          const proof = foldForwardProofIntegrityStats(clean.databasePath, clean.summary.snapshot.id);
          expect(proof, scenario.corruption).toMatchObject({paths: 1});
          expect(proof?.lookups, scenario.corruption).toBeGreaterThan(0);
          if (scenario.barrel) expect(proof?.reexports, scenario.corruption).toBeGreaterThan(0);

          corruptFoldForwardProof(clean.databasePath, clean.summary.snapshot.id, scenario.corruption);
          if (scenario.barrel) {
            writeBarrelConsumer(root, `dirty ${scenario.corruption} proof revision`);
          } else {
            writeFileSync(join(root, 'src/passive-0.ts'), 'export function passive0(): number { return 200; }\n');
          }
          const fallback = yield* indexAndLoadEffect(root, incrementalHome);
          if (scenario.corruption === 'staged-row-count') {
            expect(fallback.summary.materialization, scenario.corruption).toMatchObject({
              fallbackReason: 'staging-identity-mismatch',
              mode: 'full',
              stagedFiles: 3,
              totalFiles: 3,
            });
            expect(fallback.summary.snapshot.baseSnapshotId, scenario.corruption).toBeUndefined();
          } else {
            expect(fallback.summary.materialization, scenario.corruption).toMatchObject({
              mode: 'incremental-overlay',
              stagedFiles: 2,
            });
            expect(fallback.summary.incrementalWork, scenario.corruption).toMatchObject({
              changedFiles: 2,
              totalFiles: 3,
            });
            expect(fallback.summary.snapshot.baseSnapshotId, scenario.corruption).toBe(initial.summary.snapshot.id);
          }
          expect(fallback.summary.materialization, scenario.corruption).not.toHaveProperty('carriedFiles');

          const fullSummary = yield* indexer.index({
            cwd: root,
            incrementalOverlay: false,
            threadnoteHome: fullHome,
          });
          const rebuilt = yield* loadGraphEffect(root, fullHome, fullSummary);
          expect(projectGraph(fallback.graph), scenario.corruption).toEqual(projectGraph(rebuilt));
          expect(fallback.health, scenario.corruption).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
        }
      }).pipe(
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
        Effect.ensuring(removeTemporaryPaths(() => temporaryPaths)),
      );
    },
    120_000,
  );

  it.effect(
    'fails closed to full materialization for deletion and reintroduction',
    () => {
      let home: string | undefined;
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository(1);
        home = mkdtempSync(join(tmpdir(), 'threadnote-fold-forward-file-set-home-'));
        const initial = yield* indexAndLoadEffect(root, home);
        rmSync(join(root, 'src/passive-0.ts'));
        git(root, ['add', '-A']);
        git(root, ['commit', '-qm', 'delete passive file']);
        const deletion = yield* indexAndLoadEffect(root, home);
        expect(deletion.summary.materialization?.mode).toBe('full');
        expect(deletion.summary.snapshot.baseSnapshotId).toBeUndefined();
        expect(foldForwardProofStats(deletion.databasePath, deletion.summary.snapshot.id)).toBeUndefined();

        writeFileSync(join(root, 'src/passive-0.ts'), 'export function passive0(): number { return 0; }\n');
        const reintroduced = yield* indexAndLoadEffect(root, home);
        expect(reintroduced.summary.materialization).toMatchObject({
          fallbackReason: 'file-set-changed',
          mode: 'full',
        });
        expect(reintroduced.summary.snapshot.baseSnapshotId).toBeUndefined();
        expect(reintroduced.summary.materialization).not.toHaveProperty('carriedFiles');
        expect(projectGraph(reintroduced.graph)).toEqual(projectGraph(initial.graph));
        expect(reintroduced.health).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
      }).pipe(
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
        Effect.ensuring(removeTemporaryPaths(() => [root, home])),
      );
    },
    60_000,
  );

  it.effect('reuses a persisted clean base for a body-only dirty overlay', () => {
    let fullHome: string | undefined;
    let incrementalHome: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository(32);
      writeFileSync(join(root, 'package.json'), '{"name":"sparse-fixture","version":"1.0.0"}\n');
      git(root, ['add', 'package.json']);
      git(root, ['commit', '-qm', 'add attribution context']);
      incrementalHome = mkdtempSync(join(tmpdir(), 'threadnote-incremental-home-'));
      fullHome = mkdtempSync(join(tmpdir(), 'threadnote-full-home-'));
      const indexer = yield* CodeGraphIndexer;
      const clean = yield* indexer.index({cwd: root, threadnoteHome: incrementalHome});
      expect(clean.materialization?.mode).toBe('full');

      writeUseFile(root, 'second body-only revision');

      const identity = yield* resolveRepositoryIdentity(root);
      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const layout = codeGraphLayout(path, incrementalHome, identity.checkoutId, identity.worktreeId);
      deleteMaterializedShardCache(layout.databasePath);
      const observation = yield* worktreeBuildRequestObservation(identity, incrementalHome);
      const base = yield* store.reusableCleanBaseForCommit(
        layout.databasePath,
        identity.repositoryId,
        identity.headCommit,
      );
      expect(base).toBeDefined();
      const baseSlice = yield* store.reusableCleanBaseForCommitPaths!(
        layout.databasePath,
        identity.repositoryId,
        identity.headCommit,
        ['src/use.ts'],
      );
      expect(baseSlice).toMatchObject({
        files: [{path: 'src/use.ts', source: 'commit'}],
        snapshot: {fileCount: 35},
      });
      expect(
        yield* store.existingSnapshotFilePaths!(layout.databasePath, baseSlice!.snapshot.id, [
          'src/use.ts',
          'src/missing.ts',
        ]),
      ).toEqual(['src/use.ts']);
      expect(
        yield* store.snapshotProjectClosureFiles!(layout.databasePath, baseSlice!.snapshot.id, ['src']),
      ).toHaveLength(34);
      expect(
        yield* store.snapshotProjectClosureFiles!(layout.databasePath, baseSlice!.snapshot.id, ['']),
      ).toBeUndefined();
      const baseFacts = yield* store.loadSnapshotMaterializedFileShards!(
        layout.databasePath,
        baseSlice!.snapshot.id,
        baseSlice!.files,
      );
      expect(baseFacts.facts.size).toBe(0);
      expect(
        yield* store.reusableCleanBaseForCommitPaths!(layout.databasePath, identity.repositoryId, identity.headCommit, [
          'src/use.ts',
          'src/use.ts',
        ]),
      ).toBeUndefined();
      expect(
        yield* store.reusableCleanBaseForCommitPaths!(layout.databasePath, identity.repositoryId, identity.headCommit, [
          'src/missing.ts',
        ]),
      ).toBeUndefined();
      const command = yield* CommandExecutor;
      const gitCommands: string[] = [];
      const observedCommand = CommandExecutor.of({
        ...command,
        execute: (executable, args, options) => {
          if (executable === 'git') gitCommands.push(EffectArray.join(args, ' '));
          return command.execute(executable, args, options);
        },
      });
      const sparseInventory = yield* inventoryRepositoryFromReusableCleanBaseSlice(identity, baseSlice!, {
        overlayObservation: observation.overlay,
      }).pipe(Effect.provideService(CommandExecutor, observedCommand));
      expect(Option.isSome(sparseInventory)).toBe(true);
      if (Option.isSome(sparseInventory)) {
        expect(sparseInventory.value).toMatchObject({
          files: [{path: 'src/use.ts', source: 'worktree'}],
          base: {files: [{path: 'src/use.ts', source: 'commit'}], snapshot: {fileCount: 35}},
        });
      }
      const fastInventory = yield* inventoryRepositoryFromReusableCleanBase(identity, base!, {
        overlayObservation: observation.overlay,
      }).pipe(Effect.provideService(CommandExecutor, observedCommand));
      expect(Option.isSome(fastInventory)).toBe(true);
      expect(EffectArray.some(gitCommands, command => Effect2.pipe(command, EffectString.includes(' ls-tree ')))).toBe(
        false,
      );

      const incremental = yield* indexAndLoadEffect(root, incrementalHome);
      const full = yield* indexer.index({
        cwd: root,
        incrementalOverlay: false,
        threadnoteHome: fullHome,
      });
      const rebuilt = yield* loadGraphEffect(root, fullHome, full);

      expect(incremental.summary.materialization).toEqual({
        mode: 'incremental-overlay',
        resolutionLookupKeyForm: 'typescript-path-scoped',
        resolutionPublicationGate: 'own-path-local',
        stagedFiles: 1,
        totalFiles: 35,
      });
      expect(incremental.summary.incrementalWork).toMatchObject({
        attributionContextFiles: 1,
        baseFactsLoaded: 1,
        changedFiles: 1,
        inventoryFilesInspected: 1,
        probedDependencyPaths: expect.any(Number),
        totalFiles: 35,
      });
      expect(incremental.summary.incrementalWork!.probedDependencyPaths).toBeLessThanOrEqual(16);
      expect(incremental.summary.snapshot.graphContentId).toMatch(/^cgc_[0-9a-f]{40}$/u);
      expect(projectGraph(incremental.graph)).toEqual(projectGraph(rebuilt));
      expect(yield* analysisDigestEffect(incrementalHome, incremental.summary)).toBe(
        yield* analysisDigestEffect(fullHome, full),
      );
      expect(normalizeCatalog(incremental.catalog)).toEqual(
        normalizeCatalog(yield* loadVisualizationCatalogEffect(fullHome, full)),
      );
      expect(incremental.health).toMatchObject({foreignKeyViolations: 0, integrity: 'ok'});
      expect(
        EffectArray.some(
          incremental.graph.edges,
          edge => edge.sourceName === 'useHelper' && edge.relation === 'calls' && edge.targetName === 'helper',
        ),
      ).toBe(true);
      const delta = persistedDeltaStats(incremental.databasePath, incremental.summary.snapshot.id);
      expect(delta).toEqual({
        activeLeases: 0,
        edgePaths: ['src/use.ts'],
        filePaths: ['src/use.ts'],
        symbolPaths: ['src/use.ts'],
      });
      expect(incremental.summary.diagnostics).toContain(
        'Dirty overlay reused persisted clean base for 1 modified file(s).',
      );
      expect(incremental.summary.diagnostics).toContain(
        'Reused persisted clean inventory admission for 1 changed path(s) without hydrating the complete base.',
      );
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, incrementalHome, fullHome])),
    );
  });

  it.effect('reuses persisted admission for a deleted source and matches a full rebuild', () => {
    let fullHome: string | undefined;
    let incrementalHome: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository(8);
      incrementalHome = mkdtempSync(join(tmpdir(), 'threadnote-deleted-admission-home-'));
      fullHome = mkdtempSync(join(tmpdir(), 'threadnote-deleted-admission-full-home-'));
      yield* indexAndLoadEffect(root, incrementalHome);
      rmSync(join(root, 'src', 'passive-0.ts'));

      const incremental = yield* indexAndLoadEffect(root, incrementalHome);
      const indexer = yield* CodeGraphIndexer;
      const rebuiltSummary = yield* indexer.index({
        cwd: root,
        incrementalOverlay: false,
        threadnoteHome: fullHome,
      });
      const rebuilt = yield* loadGraphEffect(root, fullHome, rebuiltSummary);

      expect(incremental.summary.diagnostics).toContain(
        'Reused persisted clean inventory admission for 1 changed path(s).',
      );
      expect(projectGraph(incremental.graph)).toEqual(projectGraph(rebuilt));
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, incrementalHome, fullHome])),
    );
  });

  it.effect('falls back to full admission when the inventory receipt is absent', () => {
    let home: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository(8);
      home = mkdtempSync(join(tmpdir(), 'threadnote-missing-inventory-receipt-home-'));
      const clean = yield* indexAndLoadEffect(root, home);
      clearInventoryReuseReceipt(clean.databasePath, clean.summary.snapshot.id);
      writeUseFile(root, 'dirty without inventory receipt');

      const dirty = yield* indexAndLoadEffect(root, home);
      expect(dirty.summary.materialization?.mode).toBe('incremental-overlay');
      expect(dirty.summary.diagnostics).not.toContain(
        'Reused persisted clean inventory admission for 1 changed path(s).',
      );
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, home])),
    );
  });

  it.effect('falls back to full admission when ignore controls change', () => {
    let home: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository(8);
      writeFileSync(join(root, '.gitignore'), '# initial\n');
      git(root, ['add', '.gitignore']);
      git(root, ['commit', '--amend', '-qm', 'fixture with ignore policy']);
      home = mkdtempSync(join(tmpdir(), 'threadnote-changed-ignore-admission-home-'));
      yield* indexAndLoadEffect(root, home);
      writeFileSync(join(root, '.gitignore'), '# changed\n');
      writeUseFile(root, 'dirty with changed ignore policy');

      const dirty = yield* indexAndLoadEffect(root, home);
      expect(
        EffectArray.some(dirty.summary.diagnostics, diagnostic =>
          Effect2.pipe(diagnostic, EffectString.startsWith('Reused persisted clean inventory admission for ')),
        ),
      ).toBe(false);
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, home])),
    );
  });

  it.effect('does not union different-base clean increments into full-materialization shards', () => {
    let home: string | undefined;
    let root: string | undefined;
    let siblingRoot: string | undefined;
    return Effect.gen(function* () {
      const fixture = createConvergentIncrementalRepository();
      root = fixture.root;
      siblingRoot = fixture.siblingRoot;
      home = mkdtempSync(join(tmpdir(), 'threadnote-convergent-incremental-home-'));
      const indexer = yield* CodeGraphIndexer;
      const store = yield* CodeGraphStore;

      const baseA = yield* indexer.index({cwd: root, force: true, threadnoteHome: home});
      git(root, ['checkout', '-q', 'target-a']);
      const targetA = yield* indexAndLoadEffect(root, home);
      const baseB = yield* indexer.index({cwd: siblingRoot, force: true, threadnoteHome: home});
      git(siblingRoot, ['checkout', '-q', 'target-b']);
      const targetB = yield* indexAndLoadEffect(siblingRoot, home);

      expect(targetA.summary.materialization?.mode).toBe('incremental-clean');
      expect(targetB.summary.materialization?.mode).toBe('incremental-clean');
      expect(targetA.summary.snapshot.baseSnapshotId).toBe(baseA.snapshot.id);
      expect(targetB.summary.snapshot.baseSnapshotId).toBe(baseB.snapshot.id);
      expect(targetA.summary.snapshot.graphContentId).toBeDefined();
      expect(targetB.summary.snapshot.graphContentId).toBe(targetA.summary.snapshot.graphContentId);
      expect(projectGraph(targetB.graph)).toEqual(projectGraph(targetA.graph));
      const [receiptA, receiptB] = yield* Effect.all(
        [
          store.reusableBaseReceipt(targetA.databasePath, baseA.snapshot.id),
          store.reusableBaseReceipt(targetB.databasePath, baseB.snapshot.id),
        ],
        {concurrency: 1},
      );
      expect(receiptA).toBeDefined();
      expect(receiptB?.workspaceFingerprint).toBe(receiptA?.workspaceFingerprint);
      const targetDerivation = materializedShardDerivationIdentity(
        targetA.summary.snapshot.extractorSet,
        receiptA!.workspaceFingerprint,
        targetA.summary.snapshot.graphContentId!,
      );

      expect(materializedShardCount(targetA.databasePath, targetDerivation)).toBe(0);
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [siblingRoot, root, home])),
    );
  });

  it.effect('matches full rebuilds when changed-file relationships are added or deleted', () => {
    const temporaryPaths: string[] = [];
    return Effect.gen(function* () {
      const indexer = yield* CodeGraphIndexer;
      for (const operation of ['add', 'delete'] as const) {
        const root = createRepository();
        temporaryPaths.push(root);
        const incrementalHome = mkdtempSync(join(tmpdir(), `threadnote-${operation}-incremental-home-`));
        temporaryPaths.push(incrementalHome);
        const fullHome = mkdtempSync(join(tmpdir(), `threadnote-${operation}-full-home-`));
        temporaryPaths.push(fullHome);
        if (operation === 'add') writeUseFileWithoutCall(root, 'clean no-call revision');
        git(root, ['add', '.']);
        git(root, ['commit', '--amend', '-qm', 'fixture']);
        yield* indexAndLoadEffect(root, incrementalHome);
        if (operation === 'add') writeUseFile(root, 'dirty call revision');
        else writeUseFileWithoutCall(root, 'dirty no-call revision');

        const incremental = yield* indexAndLoadEffect(root, incrementalHome);
        const fullSummary = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
        const full = yield* loadGraphEffect(root, fullHome, fullSummary);
        expect(incremental.summary.materialization?.mode).toBe('incremental-overlay');
        expect(projectGraph(incremental.graph)).toEqual(projectGraph(full));
        expect(
          EffectArray.some(
            incremental.graph.edges,
            edge => edge.sourceName === 'useHelper' && edge.relation === 'calls' && edge.targetName === 'helper',
          ),
        ).toBe(operation === 'add');
      }
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => temporaryPaths)),
    );
  });

  it.effect('resolves changed consumers through persisted barrel aliases and declaration-only overloads', () => {
    let fullHome: string | undefined;
    let incrementalHome: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createBarrelRepository();
      incrementalHome = mkdtempSync(join(tmpdir(), 'threadnote-barrel-incremental-home-'));
      fullHome = mkdtempSync(join(tmpdir(), 'threadnote-barrel-full-home-'));
      const clean = yield* indexAndLoadEffect(root, incrementalHome);
      expect(reusableReceiptStats(clean.databasePath, clean.summary.snapshot.id)).toMatchObject({
        formatVersion: 2,
        inventoryReceipt: true,
        reexports: 2,
      });
      expect(reusableReceiptStats(clean.databasePath, clean.summary.snapshot.id).aliases).toBeGreaterThan(0);
      deleteMaterializedShardCache(clean.databasePath);
      writeBarrelConsumer(root, 'dirty');
      const incremental = yield* indexAndLoadEffect(root, incrementalHome);
      const indexer = yield* CodeGraphIndexer;
      const fullSummary = yield* indexer.index({cwd: root, incrementalOverlay: false, threadnoteHome: fullHome});
      const full = yield* loadGraphEffect(root, fullHome, fullSummary);

      expect(incremental.summary.materialization?.mode).toBe('incremental-overlay');
      expect(incremental.summary.incrementalWork).toMatchObject({
        baseFactsLoaded: 1,
        changedFiles: 1,
        inventoryFilesInspected: 1,
        totalFiles: 3,
      });
      expect(projectGraph(incremental.graph)).toEqual(projectGraph(full));
      const implementation = Option.getOrUndefined(
        EffectArray.findFirst(
          incremental.graph.symbols,
          __effectArrayValue =>
            !!(symbol =>
              symbol.name === 'helper' &&
              Effect2.pipe(symbol.signature, effectOptionalString =>
                effectOptionalString == null
                  ? undefined
                  : Effect2.pipe(effectOptionalString, EffectString.includes('string | number')),
              ))(__effectArrayValue),
        ),
      );
      const decodeDeclarations = EffectArray.filter(incremental.graph.symbols, symbol => symbol.name === 'decode');
      expect(implementation).toBeDefined();
      expect(
        EffectArray.some(
          incremental.graph.edges,
          edge => edge.relation === 'calls' && edge.sourceName === 'useHelper' && edge.targetId === implementation?.id,
        ),
      ).toBe(true);
      expect(
        new Set(
          EffectArray.map(
            EffectArray.filter(
              incremental.graph.edges,
              edge => edge.relation === 'calls' && edge.sourceName === 'useHelper' && edge.targetName === 'decode',
            ),
            edge => edge.targetId,
          ),
        ),
      ).toEqual(new Set(EffectArray.map(decodeDeclarations, symbol => symbol.id)));
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, incrementalHome, fullHome])),
    );
  });

  it.effect('falls back conservatively when the clean base predates reusable receipts', () => {
    let home: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository();
      home = mkdtempSync(join(tmpdir(), 'threadnote-old-base-home-'));
      const clean = yield* indexAndLoadEffect(root, home);
      deleteReusableReceipt(clean.databasePath, clean.summary.snapshot.id);
      writeUseFile(root, 'dirty revision after upgrade');

      const dirty = yield* indexAndLoadEffect(root, home);
      expect(dirty.summary.materialization).toEqual({
        fallbackReason: 'staging-unavailable',
        mode: 'full',
        stagedFiles: 2,
        totalFiles: 2,
      });
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, home])),
    );
  });

  it.effect(
    're-extracts only the changed language pack across a compatible extractor rollout',
    () => {
      let home: string | undefined;
      let referenceHome: string | undefined;
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository(6);
        writeFileSync(join(root, 'README.md'), '# Mixed language fixture\n');
        git(root, ['add', 'README.md']);
        git(root, ['commit', '--amend', '-qm', 'fixture']);
        home = mkdtempSync(join(tmpdir(), 'threadnote-pack-rollout-home-'));
        referenceHome = mkdtempSync(join(tmpdir(), 'threadnote-pack-rollout-reference-home-'));
        const initialRegistry = createCodeGraphLanguagePackRegistry(BUILTIN_LANGUAGE_PACK_REGISTRY.packs);
        const nextRegistry = createCodeGraphLanguagePackRegistry(
          EffectArray.map(BUILTIN_LANGUAGE_PACK_REGISTRY.packs, pack =>
            pack.id === 'typescript'
              ? {...pack, extractor: {...pack.extractor, version: `${pack.extractor.version}-compatible-next`}}
              : pack,
          ),
        );

        const initial = yield* indexWithRegistry(root, home, initialRegistry);
        expect(initial.materialization?.mode).toBe('full');
        const incremental = yield* indexWithRegistry(root, home, nextRegistry);
        const rebuilt = yield* indexWithRegistry(root, referenceHome, nextRegistry, true);
        expect(incremental.materialization).toEqual({
          mode: 'incremental-clean',
          resolutionLookupKeyForm: 'typescript-path-unscoped',
          resolutionPublicationGate: 'own-path-local',
          stagedFiles: 8,
          totalFiles: 9,
        });
        expect(projectGraph(yield* loadGraphEffect(root, home, incremental))).toEqual(
          projectGraph(yield* loadGraphEffect(root, referenceHome, rebuilt)),
        );
      }).pipe(
        Effect.ensuring(removeTemporaryPaths(() => [root, home, referenceHome])),
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
      );
    },
    60_000,
  );

  it.effect(
    'refreshes a clean ready snapshot when the current language pack accepts a previously omitted AXL source',
    () => {
      let home: string | undefined;
      let root: string | undefined;
      return Effect.gen(function* () {
        root = createRepository();
        home = mkdtempSync(join(tmpdir(), 'threadnote-axl-pack-upgrade-home-'));
        const axlPath = 'crates/aspect-cli/src/builtins/aspect/bazel.axl';
        mkdirSync(join(root, 'crates/aspect-cli/src/builtins/aspect'), {recursive: true});
        writeFileSync(join(root, 'BUILD.bazel'), 'exports_files(["package.json"])\n');
        writeFileSync(join(root, axlPath), 'UPGRADE_MARKER = 1\n');
        git(root, ['add', '.']);
        git(root, ['commit', '--amend', '-qm', 'fixture with AXL source']);

        const legacyRegistry = createCodeGraphLanguagePackRegistry(
          EffectArray.map(BUILTIN_LANGUAGE_PACK_REGISTRY.packs, pack =>
            pack.id === 'bazel'
              ? {...pack, files: EffectArray.filter(pack.files, matcher => matcher.value !== '.axl'), version: '1.0.0'}
              : pack,
          ),
        );
        const legacy = yield* indexWithRegistry(root, home, legacyRegistry);
        const query = yield* CodeGraphQueryService;
        const before = yield* query.status(home, root, {requestMaintenance: false});

        expect(legacy.snapshot.fileCount).toBe(3);
        expect(before).toMatchObject({freshness: 'stale', stale: true});

        const refreshed = yield* query.inspect({
          cwd: root,
          operation: 'query',
          query: axlPath,
          refresh: true,
          requestMaintenance: false,
          threadnoteHome: home,
        });

        expect(refreshed.freshness).toBe('current');
        expect(refreshed.snapshot.id).not.toBe(legacy.snapshot.id);
        expect(refreshed.nodes).toEqual(
          expect.arrayContaining([expect.objectContaining({language: 'starlark', path: axlPath})]),
        );
      }).pipe(
        provideTestLayer(ApplicationLayer),
        TestClock.withLive,
        Effect.ensuring(removeTemporaryPaths(() => [root, home])),
      );
    },
    60_000,
  );

  it.effect('fails closed when a global extractor change is not explained by pack provenance', () => {
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository(4);
      const home = join(root, '.threadnote-global-extractor');
      const initial = yield* indexAndLoadEffect(root, home);
      replaceSnapshotExtractorSet(initial.databasePath, initial.summary.snapshot.id, 'unexplained-global-change');
      writeUseFile(root, 'changed alongside a global extractor rollout');

      const next = yield* indexAndLoadEffect(root, home);
      expect(next.summary.materialization).toEqual({
        fallbackReason: 'extractor-context-changed',
        mode: 'full',
        stagedFiles: 6,
        totalFiles: 6,
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => (root === undefined ? undefined : rmSync(root, {force: true, recursive: true}))),
      ),
      provideTestLayer(ApplicationLayer),
    );
  });

  it.effect('does not let a stale peer failure poison an already-ready reusable base', () => {
    let home: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository();
      home = mkdtempSync(join(tmpdir(), 'threadnote-peer-failure-home-'));
      yield* indexAndLoadEffect(root, home);
      writeUseFile(root, 'dirty peer-failure revision');
      const dirty = yield* indexAndLoadEffect(root, home);
      const baseSnapshotId = dirty.summary.snapshot.baseSnapshotId;
      expect(baseSnapshotId).toBeDefined();

      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const layout = codeGraphLayout(path, home, dirty.summary.identity.checkoutId, dirty.summary.identity.worktreeId);
      yield* store.markFailed(layout.databasePath, baseSnapshotId!, 'late failure from a peer builder');
      const state = {
        receipt: yield* store.reusableBaseReceipt(layout.databasePath, baseSnapshotId!),
        snapshot: yield* store.readySnapshotById(layout.databasePath, baseSnapshotId!),
      };

      expect(state.snapshot?.state).toBe('ready');
      expect(state.receipt?.snapshotId).toBe(baseSnapshotId);
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, home])),
    );
  });

  it.effect('prevents an overlapping older extractor generation from replacing the active graph', () => {
    let home: string | undefined;
    let root: string | undefined;
    return Effect.gen(function* () {
      root = createRepository();
      home = mkdtempSync(join(tmpdir(), 'threadnote-extractor-generation-home-'));
      const current = yield* indexAndLoadEffect(root, home);
      const legacySnapshotId = 'cgsn_legacy_generation_8';
      insertLegacyReadySnapshot(current.databasePath, current.summary, legacySnapshotId);
      expect(() =>
        promoteLegacySnapshot(current.databasePath, current.summary.identity.worktreeId, legacySnapshotId),
      ).toThrow('older extractor generation');

      const path = yield* Path.Path;
      const store = yield* CodeGraphStore;
      const layout = codeGraphLayout(
        path,
        home,
        current.summary.identity.checkoutId,
        current.summary.identity.worktreeId,
      );
      const promotionError = yield* store
        .promote(layout.databasePath, current.summary.identity, legacySnapshotId)
        .pipe(Effect.flip);
      expect(promotionError.message).toContain('incompatible extractor generation');

      const state = yield* store.readySnapshot(layout.databasePath, current.summary.identity.worktreeId);
      expect(state?.id).toBe(current.summary.snapshot.id);
      expect(extractorGenerationState(current.databasePath, current.summary.snapshot.id)).toEqual({
        generation: CODE_GRAPH_EXTRACTOR_GENERATION,
        minimum: CODE_GRAPH_EXTRACTOR_GENERATION,
      });
    }).pipe(
      provideTestLayer(ApplicationLayer),
      TestClock.withLive,
      Effect.ensuring(removeTemporaryPaths(() => [root, home])),
    );
  });
});

const indexAndLoadEffect = Effect.fn('test.indexAndLoad')(function* (root: string, home: string) {
  const indexer = yield* CodeGraphIndexer;
  const summary = yield* indexer.index({cwd: root, threadnoteHome: home});
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
  const graph = yield* store.loadGraph(layout.databasePath, summary.snapshot.id);
  return {
    catalog: yield* store.loadVisualizationCatalog(layout.databasePath),
    databasePath: layout.databasePath,
    graph,
    health: yield* store.diagnose(layout.databasePath),
    summary,
  };
});

const indexWithFreshIndexerEffect = Effect.fn('test.indexWithFreshIndexer')(function* (
  root: string,
  home: string,
  options: {readonly force?: boolean; readonly incrementalOverlay?: boolean} = {},
) {
  const layer = Layer.fresh(CodeGraphIndexer.layer).pipe(Layer.provide(ApplicationLayer));
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      return yield* Context.get(context, CodeGraphIndexer).index({
        cwd: root,
        threadnoteHome: home,
        ...options,
      });
    }),
  );
});

const loadGraphEffect = Effect.fn('test.loadGraph')(function* (
  root: string,
  home: string,
  summary: CodeGraphIndexSummary,
) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
  return yield* store.loadGraph(layout.databasePath, summary.snapshot.id);
});

const analysisDigestEffect = Effect.fn('test.analysisDigest')(function* (home: string, summary: CodeGraphIndexSummary) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
  yield* store.ensureAnalysisSummary(layout.databasePath, summary.snapshot.id);
  return Option.map(
    yield* store.loadAnalysisSummary(layout.databasePath, summary.snapshot.id),
    value => value.digest,
  ).pipe(Option.getOrThrow);
});

const indexWithRegistry = Effect.fn('test.indexWithRegistry')(function* (
  root: string,
  home: string,
  registry: CodeGraphLanguagePackRegistryShape,
  force = false,
) {
  const layer = Layer.fresh(CodeGraphIndexer.layer).pipe(
    Layer.provide(Layer.succeed(CodeGraphLanguagePackRegistry, registry)),
    Layer.provide(ApplicationLayer),
  );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer);
      const indexer = Context.get(context, CodeGraphIndexer);
      return yield* indexer.index({cwd: root, force, threadnoteHome: home});
    }),
  );
});

const projectedGraphSchema = Schema.Struct({
  edges: Schema.Array(Schema.Unknown),
  symbols: Schema.Array(Schema.Unknown),
});
const isProjectedGraph = Schema.is(projectedGraphSchema);

function projectGraph(graph: {readonly edges: readonly unknown[]; readonly symbols: readonly unknown[]}) {
  const parsed: unknown = JSON.parse(JSON.stringify({edges: graph.edges, symbols: graph.symbols}));
  if (!isProjectedGraph(parsed)) throw new Error('Invalid projected graph fixture.');
  return parsed;
}

function persistedSnapshotState(databasePath: string, snapshotId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{state?: string} | null, SQLQueryBindings[]>('SELECT state FROM snapshots WHERE id = ?')
      .get(snapshotId)?.state;
  } finally {
    database.close(false);
  }
}

function persistedSnapshotStates(databasePath: string): readonly unknown[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query(
        'SELECT id, state, dirty, base_snapshot_id, commit_id, graph_content_id, completed_at FROM snapshots ORDER BY completed_at, id',
      )
      .all();
  } finally {
    database.close(false);
  }
}

function materializedShardCount(databasePath: string, derivationIdentity: string): number {
  const database = new Database(databasePath, {readonly: true});
  try {
    return Number(
      database
        .query<{readonly count: number}, [string]>(
          'SELECT COUNT(*) AS count FROM materialized_file_shards WHERE derivation_identity = ?',
        )
        .get(derivationIdentity)?.count ?? 0,
    );
  } finally {
    database.close();
  }
}

function normalizeCatalog(catalog: CodeGraphVisualizationCatalog | undefined): unknown {
  if (catalog === undefined) return undefined;
  const {activatedAt: _activatedAt, snapshot, ...stable} = catalog;
  const {
    baseSnapshotId: _baseSnapshotId,
    completedAt: _completedAt,
    graphContentId: _graphContentId,
    id: _id,
    ...stableSnapshot
  } = snapshot;
  return {...stable, snapshot: stableSnapshot};
}

const loadVisualizationCatalogEffect = Effect.fn('test.loadVisualizationCatalog')(function* (
  home: string,
  summary: CodeGraphIndexSummary,
) {
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const layout = codeGraphLayout(path, home, summary.identity.checkoutId, summary.identity.worktreeId);
  return yield* store.loadVisualizationCatalog(layout.databasePath);
});

function createRepository(passiveFiles = 0): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-cross-session-incremental-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(join(root, 'src', 'helper.ts'), 'export function helper(): string { return "ok"; }\n');
  writeUseFile(root, 'first revision');
  for (let index = 0; index < passiveFiles; index += 1) {
    writeFileSync(
      join(root, 'src', `passive-${index}.ts`),
      `export function passive${index}(): number { return ${index}; }\n`,
    );
  }
  git(root, ['init', '-q']);
  configureTestGitIdentity(root);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function createConvergentIncrementalRepository(): {readonly root: string; readonly siblingRoot: string} {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-convergent-incremental-'));
  const siblingRoot = `${root}-sibling`;
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(join(root, 'src/a.ts'), 'export const a = "old-a";\n');
  writeFileSync(join(root, 'src/b.ts'), 'export const b = "old-b";\n');
  git(root, ['init', '-q']);
  configureTestGitIdentity(root);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'common']);
  const common = Effect2.pipe(
    execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}),
    EffectString.trim,
  );

  git(root, ['checkout', '-qb', 'target-a', common]);
  writeFileSync(join(root, 'src/b.ts'), 'export const b = "final-b";\n');
  git(root, ['add', 'src/b.ts']);
  git(root, ['commit', '-qm', 'base a']);
  git(root, ['branch', 'base-a']);
  writeFileSync(join(root, 'src/a.ts'), 'export const a = "final-a";\n');
  git(root, ['add', 'src/a.ts']);
  git(root, ['commit', '-qm', 'target a']);

  git(root, ['checkout', '-qb', 'target-b', common]);
  writeFileSync(join(root, 'src/a.ts'), 'export const a = "final-a";\n');
  git(root, ['add', 'src/a.ts']);
  git(root, ['commit', '-qm', 'base b']);
  git(root, ['branch', 'base-b']);
  writeFileSync(join(root, 'src/b.ts'), 'export const b = "final-b";\n');
  git(root, ['add', 'src/b.ts']);
  git(root, ['commit', '-qm', 'target b']);

  git(root, ['checkout', '-q', 'base-a']);
  git(root, ['worktree', 'add', '-q', siblingRoot, 'base-b']);
  return {root, siblingRoot};
}

function createBarrelRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-cross-session-barrel-'));
  mkdirSync(join(root, 'src'), {recursive: true});
  writeFileSync(
    join(root, 'src', 'helper.ts'),
    EffectArray.join(
      [
        'export function helper(value: string): string;',
        'export function helper(value: number): number;',
        'export function helper(value: string | number): string | number { return value; }',
        'export declare function decode(): string;',
        'export declare function decode(left: string, right: string): string;',
        '',
      ],
      '\n',
    ),
  );
  writeFileSync(join(root, 'src', 'index.ts'), 'export {decode, helper} from "./helper.js";\n');
  writeBarrelConsumer(root, 'clean');
  git(root, ['init', '-q']);
  configureTestGitIdentity(root);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'barrel fixture']);
  return root;
}

function writeUseFile(root: string, revision: string): void {
  writeFileSync(
    join(root, 'src', 'use.ts'),
    EffectArray.join(
      [
        'import {helper} from "./helper.js";',
        'export function useHelper(): string {',
        `  const revision = ${JSON.stringify(revision)};`,
        '  return `${revision}:${helper()}`;',
        '}',
        '',
      ],
      '\n',
    ),
  );
}

function writeUseFileWithoutCall(root: string, revision: string): void {
  writeFileSync(
    join(root, 'src', 'use.ts'),
    EffectArray.join(
      [
        'import {helper} from "./helper.js";',
        'export function useHelper(): string {',
        `  const revision = ${JSON.stringify(revision)};`,
        '  void helper;',
        '  return revision;',
        '}',
        '',
      ],
      '\n',
    ),
  );
}

function writeBarrelConsumer(root: string, revision: string): void {
  writeFileSync(
    join(root, 'src', 'use.ts'),
    EffectArray.join(
      [
        'import {decode, helper} from "./index.js";',
        'export function useHelper(): string {',
        `  return helper(${JSON.stringify(revision)}) + decode() + decode("a", "b");`,
        '}',
        '',
      ],
      '\n',
    ),
  );
}

function persistedDeltaStats(databasePath: string, snapshotId: string) {
  const database = new Database(databasePath, {readonly: true});
  try {
    const paths = (table: 'edges' | 'snapshot_files' | 'symbols', column: 'evidence_path' | 'path') =>
      EffectArray.map(
        database
          .query<{readonly path: string}, [string]>(
            `SELECT DISTINCT ${column} AS path FROM ${table} WHERE snapshot_id = ? ORDER BY path`,
          )
          .all(snapshotId),
        row => row.path,
      );
    return {
      activeLeases: Number(
        database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM snapshot_leases').get()?.count ?? 0,
      ),
      edgePaths: paths('edges', 'evidence_path'),
      filePaths: paths('snapshot_files', 'path'),
      symbolPaths: paths('symbols', 'path'),
    };
  } finally {
    database.close();
  }
}

function foldForwardProofStats(
  databasePath: string,
  snapshotId: string,
): {readonly paths: readonly string[]; readonly rootSnapshotId: string} | undefined {
  const database = new Database(databasePath, {readonly: true});
  try {
    const receipt = database
      .query<{readonly rootSnapshotId: string}, [string]>(
        `SELECT root_snapshot_id AS rootSnapshotId
         FROM snapshot_fold_forward_receipts WHERE snapshot_id = ?`,
      )
      .get(snapshotId);
    if (!receipt) return undefined;
    return {
      paths: EffectArray.map(
        database
          .query<{readonly path: string}, [string]>(
            'SELECT path FROM snapshot_fold_forward_paths WHERE snapshot_id = ? ORDER BY path',
          )
          .all(snapshotId),
        row => row.path,
      ),
      rootSnapshotId: receipt.rootSnapshotId,
    };
  } finally {
    database.close();
  }
}

function deleteFoldForwardProof(databasePath: string, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.query('DELETE FROM snapshot_fold_forward_receipts WHERE snapshot_id = ?').run(snapshotId);
  } finally {
    database.close();
  }
}

const FOLD_FORWARD_PROOF_CORRUPTIONS = [
  {barrel: false, corruption: 'lookup-count'},
  {barrel: false, corruption: 'path-count'},
  {barrel: false, corruption: 'lookup-evidence-path'},
  {barrel: true, corruption: 'reexport-divergence'},
  {barrel: false, corruption: 'staged-row-count'},
] as const;

type FoldForwardProofCorruption = (typeof FOLD_FORWARD_PROOF_CORRUPTIONS)[number]['corruption'];

function foldForwardProofIntegrityStats(
  databasePath: string,
  snapshotId: string,
): {readonly lookups: number; readonly paths: number; readonly reexports: number} | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const receipt = database
      .query<{readonly lookupCount: number; readonly reexportCount: number}, [string]>(
        `SELECT lookup_count AS lookupCount, reexport_count AS reexportCount
         FROM snapshot_fold_forward_receipts WHERE snapshot_id = ?`,
      )
      .get(snapshotId);
    if (!receipt) return undefined;
    const paths = database
      .query<{readonly count: number}, [string]>(
        'SELECT COUNT(*) AS count FROM snapshot_fold_forward_paths WHERE snapshot_id = ?',
      )
      .get(snapshotId);
    return {
      lookups: Number(receipt.lookupCount),
      paths: Number(paths?.count ?? 0),
      reexports: Number(receipt.reexportCount),
    };
  } finally {
    database.close(false);
  }
}

function corruptFoldForwardProof(
  databasePath: string,
  snapshotId: string,
  corruption: FoldForwardProofCorruption,
): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const result = (() => {
      switch (corruption) {
        case 'lookup-count':
          return database
            .query('UPDATE snapshot_fold_forward_receipts SET lookup_count = lookup_count + 1 WHERE snapshot_id = ?')
            .run(snapshotId);
        case 'path-count':
          return database
            .query('INSERT INTO snapshot_fold_forward_paths (snapshot_id, path) VALUES (?, ?)')
            .run(snapshotId, 'src/corrupt-extra-path.ts');
        case 'lookup-evidence-path':
          return database
            .query(
              `UPDATE snapshot_fold_forward_symbol_lookup
               SET evidence_path = 'src/corrupt-lookup-path.ts'
               WHERE (snapshot_id, lookup_key, symbol_id) = (
                 SELECT snapshot_id, lookup_key, symbol_id
                 FROM snapshot_fold_forward_symbol_lookup
                 WHERE snapshot_id = ? ORDER BY lookup_key, symbol_id LIMIT 1
               )`,
            )
            .run(snapshotId);
        case 'reexport-divergence':
          return database
            .query(
              `UPDATE snapshot_reexport_provenance
               SET target_path = 'src/corrupt-reexport-target.ts'
               WHERE (snapshot_id, source_path, local_name, target_path, imported_name) = (
                 SELECT snapshot_id, source_path, local_name, target_path, imported_name
                 FROM snapshot_reexport_provenance
                 WHERE snapshot_id = ? ORDER BY source_path, local_name, target_path, imported_name LIMIT 1
               )`,
            )
            .run(snapshotId);
        case 'staged-row-count':
          return database
            .query(
              'UPDATE snapshot_fold_forward_receipts SET staged_row_count = staged_row_count + 1 WHERE snapshot_id = ?',
            )
            .run(snapshotId);
      }
    })();
    if (result.changes !== 1) {
      throw new Error(`Fold-forward ${corruption} corruption did not mutate exactly one proof row.`);
    }
  } finally {
    database.close(false);
  }
}

function reusableReceiptStats(
  databasePath: string,
  snapshotId: string,
): {
  readonly aliases: number;
  readonly formatVersion: number;
  readonly inventoryReceipt: boolean;
  readonly reexports: number;
} {
  const database = new Database(databasePath, {readonly: true});
  try {
    const aliases = database
      .query<{readonly aliases: number}, [string]>(
        "SELECT COUNT(*) AS aliases FROM snapshot_symbol_lookup WHERE snapshot_id = ? AND provenance = 'alias'",
      )
      .get(snapshotId);
    const receipt = database
      .query<{readonly formatVersion: number; readonly inventoryReceiptJson: string | null}, [string]>(
        `SELECT format_version AS formatVersion, inventory_receipt_json AS inventoryReceiptJson
         FROM snapshot_reuse_receipts WHERE snapshot_id = ?`,
      )
      .get(snapshotId);
    const reexports = database
      .query<{readonly reexports: number}, [string]>(
        'SELECT COUNT(*) AS reexports FROM snapshot_reexport_provenance WHERE snapshot_id = ?',
      )
      .get(snapshotId);
    return {
      aliases: Number(aliases?.aliases ?? 0),
      formatVersion: Number(receipt?.formatVersion ?? 0),
      inventoryReceipt: receipt?.inventoryReceiptJson !== null && receipt?.inventoryReceiptJson !== undefined,
      reexports: Number(reexports?.reexports ?? 0),
    };
  } finally {
    database.close();
  }
}

function deleteReusableReceipt(databasePath: string, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    database.query('DELETE FROM snapshot_reuse_receipts WHERE snapshot_id = ?').run(snapshotId);
  } finally {
    database.close();
  }
}

function deleteMaterializedShardCache(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.exec('DELETE FROM snapshot_file_shards; DELETE FROM materialized_file_shards');
  } finally {
    database.close();
  }
}

function clearInventoryReuseReceipt(databasePath: string, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    database
      .query('UPDATE snapshot_reuse_receipts SET inventory_receipt_json = NULL WHERE snapshot_id = ?')
      .run(snapshotId);
  } finally {
    database.close();
  }
}

function replaceSnapshotExtractorSet(databasePath: string, snapshotId: string, extractorSet: string): void {
  const database = new Database(databasePath);
  try {
    database.query('UPDATE snapshots SET extractor_set = ? WHERE id = ?').run(extractorSet, snapshotId);
  } finally {
    database.close();
  }
}

function insertLegacyReadySnapshot(databasePath: string, summary: CodeGraphIndexSummary, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    database
      .query(
        `INSERT INTO snapshots (
          id, repository_id, worktree_id, commit_id, base_snapshot_id, extractor_set,
          dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, NULL, ?, 0, NULL, 'ready', 0, 0, 0, ?, ?)`,
      )
      .run(
        snapshotId,
        summary.identity.repositoryId,
        summary.identity.worktreeId,
        summary.identity.headCommit,
        'native-code-graph-8-fixture',
        '2026-07-31T00:00:00.000Z',
        '2026-07-31T00:00:01.000Z',
      );
  } finally {
    database.close();
  }
}

function extractorGenerationState(
  databasePath: string,
  snapshotId: string,
): {readonly generation: number; readonly minimum: number} {
  const database = new Database(databasePath, {readonly: true});
  try {
    const generation = database
      .query<{readonly generation: number}, [string]>(
        'SELECT generation FROM snapshot_extractor_generations WHERE snapshot_id = ?',
      )
      .get(snapshotId);
    const minimum = database
      .query<{readonly minimum: string}, []>(
        "SELECT value AS minimum FROM schema_metadata WHERE key = 'minimum_extractor_generation'",
      )
      .get();
    return {generation: Number(generation?.generation ?? 0), minimum: Number(minimum?.minimum ?? 0)};
  } finally {
    database.close();
  }
}

function promoteLegacySnapshot(databasePath: string, worktreeId: string, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    database
      .query(
        `INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(worktree_id, scope_id) DO UPDATE SET
           snapshot_id = excluded.snapshot_id,
           activated_at = excluded.activated_at`,
      )
      .run(worktreeId, CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY, snapshotId, '2026-07-31T00:00:02.000Z');
  } finally {
    database.close();
  }
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe'});
}

function configureTestGitIdentity(cwd: string): void {
  git(cwd, ['config', 'user.name', 'Threadnote Test']);
  git(cwd, ['config', 'user.email', 'test@threadnote.local']);
}

function removeTemporaryPaths(paths: () => readonly (string | undefined)[]) {
  return Effect.sync(() => {
    for (const path of paths()) {
      if (path !== undefined) rmSync(path, {force: true, recursive: true});
    }
  });
}
