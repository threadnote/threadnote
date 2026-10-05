import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdtempSync, rmSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Database} from 'bun:sqlite';
import {describe, expect, it} from '@effect/vitest';
import {Effect} from 'effect';
import * as FC from 'fast-check';
import * as SqlClient from 'effect/sql/SqlClient';
import {CodeGraphStore, type CodeGraphStoreShape} from '@threadnote/graph/store';
import {persistedIncrementalSurfaceMatches} from '@threadnote/graph/store/incremental/surface';
import type {
  CodeGraphFileFacts,
  CodeGraphInventoryFile,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

describe('project-closure persisted store', () => {
  it.effect('accepts a scoped project surface replacement while changed closure remains strict', () =>
    withStoreFixture(({databasePath, file, identity, store}) =>
      Effect.gen(function* () {
        const baseSymbol = symbol(1);
        const base = snapshot(identity, 'base', 1);
        yield* store.prepareActivation(databasePath, [file]);
        yield* store.stageActivationFacts(databasePath, [baseSymbol], []);
        yield* store.activateStaged(databasePath, identity, base, {
          fileSetFingerprint: 'same-files',
          packProvenance: [],
          workspaceFingerprint: 'same-workspace',
        });

        const replacement = symbol(2);
        const facts = fileFacts(file.path, replacement);
        const added = {...file, contentHash: 'added-hash', path: 'packages/added/index.ts'};
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file, added], [facts, facts], {
            resolutionClosure: 'project',
          }),
        ).toBe(false);
        expect(
          yield* store.preparePersistedIncrementalActivation(
            databasePath,
            base.id,
            [added],
            [{...facts, path: added.path}],
            {resolutionClosure: 'project'},
          ),
        ).toBe(true);
        expect(
          yield* store.preparePersistedIncrementalActivation(
            databasePath,
            base.id,
            [{...file, mode: '100755'}],
            [facts],
            {resolutionClosure: 'project'},
          ),
        ).toBe(false);
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file], [facts], {
            deletedPaths: ['packages/deleted/index.ts'],
            resolutionClosure: 'project',
          }),
        ).toBe(false);
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [], [], {
            deletedPaths: [file.path],
            resolutionClosure: 'project',
          }),
        ).toBe(true);
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file], [facts], {
            deletedPaths: ['packages/deleted/index.ts'],
            resolutionClosure: 'full',
          }),
        ).toBe(true);
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file], [facts], {
            resolutionClosure: 'changed',
          }),
        ).toBe(false);
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file], [facts], {
            resolutionClosure: 'project',
          }),
        ).toBe(true);

        const ready = {...snapshot(identity, 'project', 1), baseSnapshotId: base.id};
        yield* store.resolveStagedReferences(databasePath);
        yield* store.activateStaged(databasePath, identity, ready);
        const graph = yield* store.loadGraph(databasePath, ready.id);
        expect(graph.symbols).toEqual([replacement]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('admits file-local symbol set changes but rejects published persisted surfaces', () =>
    withStoreFixture(({databasePath, file, identity, store}) =>
      Effect.gen(function* () {
        const published = symbol(1);
        const oldLocal = localSymbol('oldLocal');
        const newLocal = localSymbol('newLocal');
        const base = snapshot(identity, 'base', 2);
        yield* store.prepareActivation(databasePath, [file]);
        yield* store.stageActivationFacts(databasePath, [published, oldLocal], []);
        yield* store.activateStaged(databasePath, identity, base, {
          fileSetFingerprint: 'same-files',
          packProvenance: [],
          workspaceFingerprint: 'same-workspace',
        });

        expect(
          yield* store.preparePersistedIncrementalActivation(
            databasePath,
            base.id,
            [file],
            [fileFactsWithSymbols(file.path, [published])],
            {resolutionClosure: 'changed'},
          ),
        ).toBe(true);
        expect(
          yield* store.preparePersistedIncrementalActivation(
            databasePath,
            base.id,
            [file],
            [fileFactsWithSymbols(file.path, [published, newLocal])],
            {resolutionClosure: 'changed'},
          ),
        ).toBe(true);

        expect(
          yield* store.preparePersistedIncrementalActivation(
            databasePath,
            base.id,
            [file],
            [fileFactsWithSymbols(file.path, [published, {...newLocal, exported: true}])],
            {resolutionClosure: 'changed'},
          ),
        ).toBe(false);
        const foreignGlobal = {
          ...newLocal,
          lookupKeys: [...(newLocal.lookupKeys ?? []), 'global:name:foreign'],
        };
        expect(
          yield* store.preparePersistedIncrementalActivation(
            databasePath,
            base.id,
            [file],
            [fileFactsWithSymbols(file.path, [published, foreignGlobal])],
            {resolutionClosure: 'changed'},
          ),
        ).toBe(false);

        expect(
          yield* store.preparePersistedIncrementalActivation(
            databasePath,
            base.id,
            [file],
            [fileFactsWithSymbols(file.path, [published, newLocal])],
            {resolutionClosure: 'changed'},
          ),
        ).toBe(true);
        yield* store.resolveStagedReferences(databasePath);
        const ready = {...snapshot(identity, 'local-surface', 2), baseSnapshotId: base.id};
        yield* store.activateStaged(databasePath, identity, ready);
        const graph = yield* store.loadGraph(databasePath, ready.id);
        expect(graph.symbols.map(value => value.id).sort()).toEqual([newLocal.id, published.id].sort());
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('fails closed when a staged persisted symbol surface cannot be decoded', () =>
    withStoreFixture(({databasePath, file, identity, sql, store}) =>
      Effect.gen(function* () {
        const published = symbol(1);
        const base = snapshot(identity, 'base', 1);
        yield* store.prepareActivation(databasePath, [file]);
        yield* store.stageActivationFacts(databasePath, [published], []);
        yield* store.activateStaged(databasePath, identity, base, {
          fileSetFingerprint: 'same-files',
          packProvenance: [],
          workspaceFingerprint: 'same-workspace',
        });
        expect(
          yield* store.preparePersistedIncrementalActivation(
            databasePath,
            base.id,
            [file],
            [fileFacts(file.path, published)],
            {resolutionClosure: 'changed'},
          ),
        ).toBe(true);
        yield* store.resolveStagedReferences(databasePath);
        yield* sql`UPDATE activation_symbols SET lookup_keys_json = '{' WHERE id = ${published.id}`;

        const ready = {...snapshot(identity, 'malformed-surface', 1), baseSnapshotId: base.id};
        expect((yield* Effect.exit(store.activateStaged(databasePath, identity, ready)))._tag).toBe('Failure');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('requires exact changed-path re-export provenance in both directions', () =>
    withStoreFixture(({databasePath, file, identity, sql, store}) =>
      Effect.gen(function* () {
        const published = symbol(1);
        const base = snapshot(identity, 'base', 1);
        yield* store.prepareActivation(databasePath, [file]);
        yield* store.stageActivationFacts(databasePath, [published], []);
        yield* store.activateStaged(databasePath, identity, base, {
          fileSetFingerprint: 'same-files',
          packProvenance: [],
          workspaceFingerprint: 'same-workspace',
        });
        yield* store.prepareActivation(databasePath, [file]);
        yield* store.stageActivationFacts(databasePath, [published], []);
        yield* sql`INSERT INTO activation_incremental_paths (path) VALUES (${file.path})`;

        expect(yield* persistedIncrementalSurfaceMatches(sql, base.id)).toBe(true);
        yield* insertSnapshotSurfaceReexports(sql, base.id, [surfaceReexport(1)]);
        expect(yield* persistedIncrementalSurfaceMatches(sql, base.id)).toBe(false);
        yield* insertActivationSurfaceReexports(sql, [surfaceReexport(1)]);
        expect(yield* persistedIncrementalSurfaceMatches(sql, base.id)).toBe(true);
        yield* sql`DELETE FROM activation_reexport_provenance`;
        yield* insertActivationSurfaceReexports(sql, [surfaceReexport(2)]);
        expect(yield* persistedIncrementalSurfaceMatches(sql, base.id)).toBe(false);
        yield* sql`DELETE FROM snapshot_reexport_provenance WHERE snapshot_id = ${base.id}`;
        expect(yield* persistedIncrementalSurfaceMatches(sql, base.id)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  fcEffectProp(
    it,
    'matches exactly when arbitrary changed-path re-export sets are equal',
    {
      base: FC.uniqueArray(FC.integer({max: 12, min: 0}), {maxLength: 6}),
      current: FC.uniqueArray(FC.integer({max: 12, min: 0}), {maxLength: 6}),
    },
    ({base: baseValues, current: currentValues}) =>
      withStoreFixture(({databasePath, file, identity, sql, store}) =>
        Effect.gen(function* () {
          const published = symbol(1);
          const base = snapshot(identity, 'base', 1);
          yield* store.prepareActivation(databasePath, [file]);
          yield* store.stageActivationFacts(databasePath, [published], []);
          yield* store.activateStaged(databasePath, identity, base, {
            fileSetFingerprint: 'same-files',
            packProvenance: [],
            workspaceFingerprint: 'same-workspace',
          });
          yield* store.prepareActivation(databasePath, [file]);
          yield* store.stageActivationFacts(databasePath, [published], []);
          yield* sql`INSERT INTO activation_incremental_paths (path) VALUES (${file.path})`;
          yield* insertSnapshotSurfaceReexports(sql, base.id, baseValues.map(surfaceReexport));
          yield* insertActivationSurfaceReexports(sql, currentValues.map(surfaceReexport));

          const expected = [...baseValues].sort((left, right) => left - right).join(',');
          const actual = [...currentValues].sort((left, right) => left - right).join(',');
          expect(yield* persistedIncrementalSurfaceMatches(sql, base.id)).toBe(expected === actual);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 20}, timeout: 60_000},
  );

  it.effect('rejects a changed-file persisted overlay that contains a deletion-only path', () =>
    withStoreFixture(({databasePath, file, identity, store}) =>
      Effect.gen(function* () {
        const published = symbol(1);
        const deletedFile = {
          ...file,
          blobId: 'deleted-blob',
          contentHash: 'deleted-hash',
          path: 'packages/deleted/index.ts',
        };
        const deletedSymbol = {
          ...published,
          contentHash: deletedFile.contentHash,
          id: 'deleted-symbol',
          lookupKeys: ['typescript:project:path:packages%2Fdeleted%2Findex.ts:name:deleted'],
          name: 'deleted',
          path: deletedFile.path,
          qualifiedName: 'deleted',
        };
        const base = {...snapshot(identity, 'base', 2), fileCount: 2};
        yield* store.prepareActivation(databasePath, [file, deletedFile]);
        yield* store.stageActivationFacts(databasePath, [published, deletedSymbol], []);
        yield* store.activateStaged(databasePath, identity, base, {
          fileSetFingerprint: 'same-files',
          packProvenance: [],
          workspaceFingerprint: 'same-workspace',
        });

        expect(
          yield* store.preparePersistedIncrementalActivation(
            databasePath,
            base.id,
            [file],
            [fileFacts(file.path, published)],
            {deletedPaths: [deletedFile.path], resolutionClosure: 'changed'},
          ),
        ).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('bounds reusable exact-base reexport output without returning a partial closure', () =>
    withStoreFixture(({databasePath, file, identity, store}) =>
      Effect.gen(function* () {
        const base = snapshot(identity, 'reexports', 1);
        yield* store.prepareActivation(databasePath, [file]);
        yield* store.stageActivationFacts(databasePath, [symbol(1)], []);
        yield* store.activateStaged(databasePath, identity, base, {
          fileSetFingerprint: 'same-files',
          packProvenance: [],
          workspaceFingerprint: 'same-workspace',
        });
        yield* Effect.sync(() => insertReexports(databasePath, base.id, 10_001));

        expect(
          yield* store.reusableReexports(databasePath, base.id, [{name: 'foo', path: 'packages/barrel/index.ts'}], {
            maxRows: 10_000,
          }),
        ).toHaveLength(10_001);
        expect(
          yield* store.reusableReexports(databasePath, base.id, [{name: 'foo', path: 'packages/barrel/index.ts'}], {
            maxRows: 10_001,
          }),
        ).toHaveLength(10_001);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('does not hide later batched provenance behind overlapping prefix rows', () =>
    withStoreFixture(({databasePath, file, identity, store}) =>
      Effect.gen(function* () {
        const base = snapshot(identity, 'overlap', 1);
        yield* store.prepareActivation(databasePath, [file]);
        yield* store.stageActivationFacts(databasePath, [symbol(1)], []);
        yield* store.activateStaged(databasePath, identity, base, {
          fileSetFingerprint: 'same-files',
          packProvenance: [],
          workspaceFingerprint: 'same-workspace',
        });
        yield* Effect.sync(() => insertOverlappingReexports(databasePath, base.id));
        const seeds = [
          {name: 'foo', path: 'a'},
          ...Array.from({length: 199}, (_, index) => ({name: `missing-${index}`, path: 'missing'})),
          {name: 'foo', path: 'z'},
        ];

        expect(yield* store.reusableReexports(databasePath, base.id, seeds, {maxRows: 2})).toHaveLength(3);
        expect(yield* store.reusableReexports(databasePath, base.id, seeds, {maxRows: 3})).toEqual([
          {importedName: 'shared', localName: 'foo', sourcePath: 'a', targetPath: 'm'},
          {importedName: 'value', localName: 'shared', sourcePath: 'm', targetPath: 'q'},
          {importedName: 'shared', localName: 'foo', sourcePath: 'z', targetPath: 'm'},
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('rejects unknown persisted resolution closure tags at preparation and activation', () =>
    withStoreFixture(({databasePath, file, identity, sql, store}) =>
      Effect.gen(function* () {
        const base = snapshot(identity, 'closure-base', 1);
        yield* store.prepareActivation(databasePath, [file]);
        yield* store.stageActivationFacts(databasePath, [symbol(1)], []);
        yield* store.activateStaged(databasePath, identity, base, {
          fileSetFingerprint: 'same-files',
          packProvenance: [],
          workspaceFingerprint: 'same-workspace',
        });
        const facts = fileFacts(file.path, symbol(2));
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file], [facts], {
            resolutionClosure: 'unknown' as 'project',
          }),
        ).toBe(false);
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file], [facts], {
            resolutionClosure: 'project',
          }),
        ).toBe(true);
        yield* store.resolveStagedReferences(databasePath);
        yield* sql`UPDATE activation_state SET value = 'unknown' WHERE key = 'resolution_closure'`;
        const ready = {...snapshot(identity, 'closure-invalid', 1), baseSnapshotId: base.id};
        const activation = yield* Effect.exit(store.activateStaged(databasePath, identity, ready));

        expect(activation._tag).toBe('Failure');
        expect(
          yield* store.preparePersistedIncrementalActivation(databasePath, base.id, [file], [facts], {
            resolutionClosure: 'project',
          }),
        ).toBe(true);
        yield* sql`UPDATE activation_files SET mode = '100755' WHERE path = ${file.path}`;
        yield* store.resolveStagedReferences(databasePath);
        const mismatchedReady = {...snapshot(identity, 'closure-mode-invalid', 1), baseSnapshotId: base.id};
        expect((yield* Effect.exit(store.activateStaged(databasePath, identity, mismatchedReady)))._tag).toBe(
          'Failure',
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it.effect('reports raw cache bytes and rejects a payload whose path disagrees with its tuple', () =>
    withStoreFixture(({databasePath, file, store}) =>
      Effect.gen(function* () {
        yield* store.initialize(databasePath);
        const mismatched = JSON.stringify(fileFacts('packages/other/index.ts', symbol(1)));
        yield* Effect.sync(() => insertCachedFact(databasePath, file, 'extractor', mismatched));
        const decoded = yield* store.loadCachedFacts(databasePath, [file], 'extractor');
        expect(decoded.facts.size).toBe(0);

        const oversized = ' '.repeat(8 * 1_048_576 + 1);
        yield* Effect.sync(() => insertCachedFact(databasePath, file, 'extractor', oversized));
        const metadata = yield* store.loadCachedFacts(databasePath, [file], 'extractor', {decode: false});
        expect(metadata.bytes).toBe(oversized.length);
        expect(metadata.bytesByPath?.get(file.path)).toBe(oversized.length);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function withStoreFixture<A, E>(
  use: (fixture: {
    readonly databasePath: string;
    readonly file: CodeGraphInventoryFile;
    readonly identity: RepositoryIdentity;
    readonly sql: SqlClient.SqlClient;
    readonly store: CodeGraphStoreShape;
  }) => Effect.Effect<A, E>,
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), 'threadnote-project-closure-store-'))),
    root =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const databasePath = join(root, 'graph-v3.sqlite');
        const identity = repositoryIdentity(root);
        const file = inventoryFile();
        return yield* store.withSession(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* use({databasePath, file, identity, sql, store});
          }),
        );
      }),
    root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
  );
}

function repositoryIdentity(root: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: 'c'.repeat(64),
    displayName: 'project-closure-store',
    gitCommonDirectory: root,
    headCommit: '1'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: 'r'.repeat(64),
    worktreeId: 'w'.repeat(64),
  };
}

function inventoryFile(): CodeGraphInventoryFile {
  return {
    blobId: 'blob',
    contentHash: 'hash',
    language: 'typescript',
    mode: '100644',
    path: 'packages/barrel/index.ts',
    size: 1,
    source: 'commit',
  };
}

function symbol(arity: number): CodeGraphSymbol {
  return {
    arity,
    contentHash: `hash-${arity}`,
    exported: true,
    id: 'symbol',
    kind: 'function',
    language: 'typescript',
    lookupKeys: [`typescript:project:path:packages%2Fbarrel%2Findex.ts:name:foo:arity:${arity}`],
    name: 'foo',
    packageName: 'barrel',
    path: 'packages/barrel/index.ts',
    qualifiedName: 'foo',
    resolutionDomain: 'typescript',
    resolutionScopeId: 'project',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function localSymbol(name: string): CodeGraphSymbol {
  const path = 'packages/barrel/index.ts';
  const encodedName = encodeURIComponent(name);
  const encodedPath = encodeURIComponent(path);
  return {
    contentHash: `hash-${name}`,
    exported: false,
    id: `local:${name}`,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [
      `typescript:project:path:${encodedPath}:name:${encodedName}`,
      `typescript:project:path:${encodedPath}:qualified:${encodedName}`,
    ],
    name,
    packageName: 'barrel',
    path,
    qualifiedName: name,
    resolutionDomain: 'typescript',
    resolutionScopeId: 'project',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function fileFacts(path: string, value: CodeGraphSymbol): CodeGraphFileFacts {
  return {diagnostics: [], edges: [], path, references: [], symbols: [value]};
}

function fileFactsWithSymbols(path: string, symbols: readonly CodeGraphSymbol[]): CodeGraphFileFacts {
  return {diagnostics: [], edges: [], path, references: [], symbols};
}

interface SurfaceReexport {
  readonly importedName: string;
  readonly localName: string;
  readonly sourcePath: string;
  readonly targetPath: string;
}

function surfaceReexport(value: number): SurfaceReexport {
  return {
    importedName: `imported-${value}`,
    localName: `local-${value}`,
    sourcePath: 'packages/barrel/index.ts',
    targetPath: `packages/target-${value}/index.ts`,
  };
}

function insertSnapshotSurfaceReexports(
  sql: SqlClient.SqlClient,
  snapshotId: string,
  reexports: readonly SurfaceReexport[],
) {
  return Effect.forEach(
    reexports,
    reexport =>
      sql`
        INSERT INTO snapshot_reexport_provenance (
          snapshot_id, source_path, local_name, target_path, imported_name
        ) VALUES (
          ${snapshotId}, ${reexport.sourcePath}, ${reexport.localName},
          ${reexport.targetPath}, ${reexport.importedName}
        )
      `,
    {discard: true},
  );
}

function insertActivationSurfaceReexports(sql: SqlClient.SqlClient, reexports: readonly SurfaceReexport[]) {
  return Effect.forEach(
    reexports,
    reexport =>
      sql`
        INSERT INTO activation_reexport_provenance (
          source_path, local_name, target_path, imported_name
        ) VALUES (
          ${reexport.sourcePath}, ${reexport.localName}, ${reexport.targetPath}, ${reexport.importedName}
        )
      `,
    {discard: true},
  );
}

function snapshot(identity: RepositoryIdentity, suffix: string, symbolCount: number): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    dirty: !['base', 'closure-base', 'overlap', 'reexports'].includes(suffix),
    edgeCount: 0,
    extractorSet: 'extractor',
    fileCount: 1,
    id: `snapshot-${suffix}`,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount,
    worktreeId: identity.worktreeId,
  };
}

function insertReexports(databasePath: string, snapshotId: string, count: number): void {
  const database = new Database(databasePath);
  try {
    const insert = database.prepare(
      `INSERT INTO snapshot_reexport_provenance (
        snapshot_id, source_path, local_name, target_path, imported_name
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    database.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        insert.run(
          snapshotId,
          'packages/barrel/index.ts',
          'foo',
          `packages/target-${String(index).padStart(5, '0')}.ts`,
          `target${index}`,
        );
      }
    })();
  } finally {
    database.close(false);
  }
}

function insertOverlappingReexports(databasePath: string, snapshotId: string): void {
  const database = new Database(databasePath);
  try {
    const insert = database.prepare(
      `INSERT INTO snapshot_reexport_provenance (
        snapshot_id, source_path, local_name, target_path, imported_name
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    database.transaction(() => {
      insert.run(snapshotId, 'a', 'foo', 'm', 'shared');
      insert.run(snapshotId, 'm', 'shared', 'q', 'value');
      insert.run(snapshotId, 'z', 'foo', 'm', 'shared');
    })();
  } finally {
    database.close(false);
  }
}

function insertCachedFact(
  databasePath: string,
  file: CodeGraphInventoryFile,
  extractorSet: string,
  factsJson: string,
): void {
  const database = new Database(databasePath);
  try {
    database.run(
      `INSERT INTO file_blobs (content_hash, extractor_set, path_hint, facts_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(content_hash, extractor_set, path_hint) DO UPDATE SET facts_json = excluded.facts_json`,
      [file.contentHash, extractorSet, file.path, factsJson, new Date().toISOString()],
    );
  } finally {
    database.close(false);
  }
}
