import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as SqlClient from 'effect/sql/SqlClient';
import {describe, expect} from 'vitest';
import * as FC from 'fast-check';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {CodeGraphStore} from '@threadnote/graph/store';
import type {
  CodeGraphInventoryFile,
  CodeGraphReference,
  CodeGraphSnapshot,
  CodeGraphSymbol,
  RepositoryIdentity,
} from '@threadnote/graph/types';
import {citationPlatformLayer} from '../helpers/citation-platform.js';

const layer = CodeGraphStore.layer.pipe(Layer.provideMerge(citationPlatformLayer));

describe('connection-private reference resolution transactions', () => {
  effectIt.layer(layer)(it => {
    it.effect('resolves temporary references while another connection owns the main writer', () =>
      temporaryResolution([7]).pipe(TestClock.withLive),
    );
    it.effect('resolves a persisted delta while another connection owns the main writer', () =>
      temporaryResolution([7], true).pipe(TestClock.withLive),
    );
    it.effect('seeds transitive temporary reexport aliases without acquiring the main writer', () =>
      temporaryResolution([7], false, true).pipe(TestClock.withLive),
    );
    fcEffectProp(
      it,
      'preserves exact resolution and inputs across temporary and delta reference sets',
      {
        ids: FC.uniqueArray(FC.integer({min: 0, max: 1000}), {minLength: 1, maxLength: 20}),
        delta: FC.boolean(),
      },
      ({ids, delta}) => temporaryResolution(ids, delta).pipe(TestClock.withLive),
      {fastCheck: {numRuns: 30}},
    );
  });
});

function temporaryResolution(ids: readonly number[], delta = false, reexport = false) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-temporary-resolution-'});
    const databasePath = path.join(directory, 'graph.sqlite');
    const store = yield* CodeGraphStore;
    yield* store.initialize(databasePath);
    const file: CodeGraphInventoryFile = {
      blobId: 'b'.repeat(40),
      contentHash: 'c'.repeat(64),
      language: 'typescript',
      mode: '100644',
      path: 'src/references.ts',
      size: 128,
      source: 'commit',
    };
    const input = [...ids];
    const caller = symbol('caller', file.path);
    const catalog = {...file, path: 'src/catalog.ts'};
    const targets = ids.map(id => symbol(`target${id}`, catalog.path));
    const references: CodeGraphReference[] = targets.map((target, index) => ({
      aliasLookupKeys: [`typescript:name:alias${index}`],
      edgeId: `unresolved-${index}`,
      evidencePath: file.path,
      evidenceSpan: caller.span,
      lookupTiers: [[reexport ? pathKey(file.path, 'exported') : `typescript:name:${target.name}`]],
      provenance: 'syntactic',
      relation: 'calls',
      resolutionDomain: 'typescript',
      sourceId: caller.id,
      sourceName: caller.name,
      targetName: target.name,
    }));
    return yield* store.withSession(
      databasePath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const edges = references.map(reference => ({
          confidence: 0.7,
          evidencePath: file.path,
          evidenceSpan: caller.span,
          id: reference.edgeId,
          provenance: 'syntactic' as const,
          relation: 'calls' as const,
          sourceId: caller.id,
          sourceName: caller.name,
          targetName: reference.targetName,
        }));
        if (delta) {
          const identity: RepositoryIdentity = {
            caseMode: 'sensitive',
            checkoutId: 'c'.repeat(64),
            displayName: 'temporary-resolution',
            gitCommonDirectory: directory,
            headCommit: '1'.repeat(40),
            objectFormat: 'sha1',
            repoRoot: directory,
            repositoryId: 'r'.repeat(64),
            worktreeId: 'w'.repeat(64),
          };
          const snapshot: CodeGraphSnapshot = {
            commit: identity.headCommit,
            dirty: false,
            edgeCount: 0,
            extractorSet: 'temporary-resolution-test',
            fileCount: 2,
            id: 'base',
            repositoryId: identity.repositoryId,
            state: 'ready',
            symbolCount: targets.length + 1,
            worktreeId: identity.worktreeId,
          };
          yield* store.prepareActivation(databasePath, [file, catalog]);
          yield* store.stageActivationFacts(databasePath, [caller, ...targets], []);
          yield* store.activateStaged(databasePath, identity, snapshot, {
            fileSetFingerprint: 'base-files',
            packProvenance: [],
            workspaceFingerprint: 'base-workspace',
          });
          expect(
            yield* store.preparePersistedIncrementalActivation(
              databasePath,
              snapshot.id,
              [file],
              [
                {
                  diagnostics: [],
                  edges,
                  path: file.path,
                  references,
                  symbols: [caller],
                },
              ],
            ),
          ).toBe(true);
        } else {
          yield* store.prepareActivation(databasePath, [file, catalog]);
          yield* store.stageActivationFacts(databasePath, [caller, ...targets], edges, references);
        }
        if (reexport) {
          yield* sql`INSERT INTO activation_reexport_provenance VALUES
          (${file.path}, 'exported', 'src/barrel.ts', 'intermediate'),
          ('src/barrel.ts', 'intermediate', ${catalog.path}, ${targets[0].name})`;
        }
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const writer = new Database(databasePath);
            writer.exec('BEGIN IMMEDIATE');
            return writer;
          }),
          writer =>
            Effect.gen(function* () {
              expect(writer.inTransaction).toBe(true);
              const summary = yield* store.resolveStagedReferences(databasePath);
              const edges = yield* sql<{
                readonly target_id: string;
                readonly provenance: string;
              }>`SELECT target_id, provenance FROM activation_edges ORDER BY target_id`;
              expect(summary.resolved).toBe(ids.length);
              expect(edges).toEqual(
                targets
                  .map(target => ({target_id: target.id, provenance: 'resolved'}))
                  .sort((left, right) => left.target_id.localeCompare(right.target_id)),
              );
              expect(ids).toEqual(input);
              if (reexport) {
                expect(
                  yield* sql<{
                    readonly symbol_id: string;
                  }>`SELECT symbol_id FROM activation_symbol_lookup WHERE lookup_key = ${`${pathKey(file.path, 'exported')}:implementation`}`,
                ).toEqual([{symbol_id: targets[0].id}]);
              }
              expect(writer.inTransaction).toBe(true);
              expect(writer.query('SELECT COUNT(*) AS count FROM edges').get()).toEqual({count: 0});
            }),
          writer =>
            Effect.sync(() => {
              writer.exec('ROLLBACK');
              writer.close();
            }),
        );
      }),
    );
  });
}

function symbol(name: string, path: string): CodeGraphSymbol {
  return {
    contentHash: `hash-${name}`,
    exported: true,
    id: name,
    kind: 'function',
    language: 'typescript',
    lookupKeys: [`typescript:name:${name}`, pathKey(path, name)],
    name,
    path,
    qualifiedName: name,
    resolutionDomain: 'typescript',
    span: {column: 1, endColumn: 2, endLine: 1, line: 1},
  };
}

function pathKey(path: string, name: string) {
  return `typescript:path:${encodeURIComponent(path)}:name:${encodeURIComponent(name)}`;
}
