import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Effect, FileSystem, Layer, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {sha256HexSync as hash} from '@threadnote/platform/sha256';

import {codeGraphWorksetCatalogDatabasePath} from '@threadnote/graph/workset_catalog/layout';
import {
  createCodeGraphWorksetRoutingProjection,
  validateCodeGraphWorksetRoutingProjection,
} from '@threadnote/graph/workset_catalog/projection';
import {
  ensureCodeGraphWorksetCatalog,
  inspectCodeGraphWorksetCatalog,
  publishCodeGraphWorksetCatalogGeneration,
  readPublishedCodeGraphWorksetCatalogGeneration,
  stageCodeGraphWorksetCatalogGeneration,
  stageCodeGraphWorksetCatalogGenerationFromReceipts,
  withCodeGraphWorksetCatalogWriter,
} from '@threadnote/graph/workset_catalog/store';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const layer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);
const scope = (name: string) => ({
  closureDigest: hash(`closure:${name}`),
  completeness: 'partial' as const,
  definitionDigest: hash(`definition:${name}`),
  scopeId: `code-graph-scope:${hash(name)}`,
});
const draft = {
  checkoutId: hash('checkout'),
  commitId: Effect2.pipe('a', EffectString.repeat(40)),
  componentCount: 1,
  extractorGeneration: 1,
  projectorVersion: 2 as const,
  repositoryId: hash('repository'),
  snapshotDigest: hash('snapshot'),
  snapshotId: 'snapshot-a',
  symbols: [],
  worktreeId: hash('worktree'),
};

describe('persisted Workset scope receipts', () => {
  it('binds every scoped receipt dimension and preserves the legacy full projection digest', () => {
    const full = createCodeGraphWorksetRoutingProjection(draft);
    expect(full.projectionDigest).toBe('d7a39ad6bfca750076e4ce7c00f76ecc65556da2957e81cb6ffd0626040bcaf3');
    expect(createCodeGraphWorksetRoutingProjection({...draft, scopeId: 'full-repository'})).toEqual(full);
    expect(full).toMatchObject({scopeId: 'full-repository', completeness: 'legacy-full'});
    const scoped = createCodeGraphWorksetRoutingProjection({...draft, ...scope('a')});
    expect(scoped.projectionDigest).not.toBe(full.projectionDigest);
    for (const mutation of [
      {scopeId: scope('b').scopeId},
      {definitionDigest: hash('changed')},
      {closureDigest: hash('changed')},
      {completeness: 'complete' as const},
    ]) {
      expect(() => validateCodeGraphWorksetRoutingProjection({...scoped, ...mutation})).toThrow();
    }
    expect(() => createCodeGraphWorksetRoutingProjection({...draft, scopeId: scope('a').scopeId})).toThrow();
  });

  it('isolates each receipt dimension for arbitrary scope identities', () => {
    fc.assert(
      fc.property(fc.string({maxLength: 40}), fc.string({maxLength: 40}), (a, b) => {
        fc.pre(a !== b);
        const original = createCodeGraphWorksetRoutingProjection({...draft, ...scope(a)});
        for (const key of ['scopeId', 'definitionDigest', 'closureDigest'] as const) {
          expect(() => validateCodeGraphWorksetRoutingProjection({...original, [key]: scope(b)[key]})).toThrow();
        }
      }),
      {numRuns: 30},
    );
  });

  effectIt.effect(
    'round-trips two scopes of one repository and rejects replayed or incomplete generation receipts',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped();
        const a = createCodeGraphWorksetRoutingProjection({...draft, ...scope('a')});
        const b = createCodeGraphWorksetRoutingProjection({...draft, snapshotId: 'snapshot-b', ...scope('b')});
        const staged = yield* stageCodeGraphWorksetCatalogGeneration(home, {
          manifestDigest: hash('manifest'),
          members: [
            {projection: a, repositoryKey: 'a'},
            {projection: b, repositoryKey: 'b'},
          ],
          worksetName: 'scopes',
        });
        yield* publishCodeGraphWorksetCatalogGeneration(home, {generationId: staged.id, worksetName: 'scopes'});
        const result = yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'scopes');
        expect(result?.members).toMatchObject([
          {...scope('a'), repositoryKey: 'a'},
          {...scope('b'), repositoryKey: 'b'},
        ]);
        for (const receiptScope of [
          {},
          scope('b'),
          {...scope('a'), definitionDigest: hash('drift')},
          {...scope('a'), closureDigest: hash('drift')},
        ]) {
          const failure = yield* stageCodeGraphWorksetCatalogGenerationFromReceipts(home, {
            manifestDigest: hash('replay'),
            members: [
              {
                projectionDigest: a.projectionDigest,
                repositoryId: a.repositoryId,
                repositoryKey: 'a',
                snapshotId: a.snapshotId,
                ...receiptScope,
              },
            ],
            worksetName: 'replay',
          }).pipe(Effect.flip);
          expect(failure.reason).toBe('missing');
        }
        yield* withCodeGraphWorksetCatalogWriter(home, sql =>
          sql.unsafe('UPDATE repository_snapshots SET closure_digest = ? WHERE projection_digest = ?', [
            hash('changed persisted closure'),
            a.projectionDigest,
          ]),
        );
        expect(yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'scopes').pipe(Effect.flip)).toMatchObject({
          reason: 'corrupt',
        });
      }).pipe(provideTestLayer(layer)),
  );

  effectIt.effect('migrates a legacy catalog to canonical full receipts without changing published identity', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const full = createCodeGraphWorksetRoutingProjection(draft);
      const staged = yield* stageCodeGraphWorksetCatalogGeneration(home, {
        manifestDigest: hash('manifest'),
        members: [{projection: full, repositoryKey: 'full'}],
        worksetName: 'legacy',
      });
      yield* publishCodeGraphWorksetCatalogGeneration(home, {generationId: staged.id, worksetName: 'legacy'});
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new Database(codeGraphWorksetCatalogDatabasePath(path, home))),
        database =>
          Effect.sync(() => {
            for (const column of ['scope_id', 'definition_digest', 'closure_digest', 'completeness']) {
              database.exec(`ALTER TABLE repository_snapshots DROP COLUMN ${column}`);
            }
            database.exec("DELETE FROM catalog_metadata WHERE key = 'scope_receipt_version'");
          }),
        database => Effect.sync(() => database.close()),
      );
      const legacy = yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'legacy');
      expect(legacy?.digest).toBe(staged.digest);
      expect(legacy?.members[0]).toMatchObject({scopeId: 'full-repository', completeness: 'legacy-full'});
      yield* ensureCodeGraphWorksetCatalog(home);
      yield* ensureCodeGraphWorksetCatalog(home);
      const result = yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'legacy');
      expect(result?.digest).toBe(staged.digest);
      expect(result?.members[0]).toMatchObject({
        scopeId: 'full-repository',
        completeness: 'legacy-full',
        projectionDigest: full.projectionDigest,
      });
      yield* withCodeGraphWorksetCatalogWriter(home, sql =>
        sql.unsafe('ALTER TABLE repository_snapshots DROP COLUMN closure_digest'),
      );
      expect(yield* readPublishedCodeGraphWorksetCatalogGeneration(home, 'legacy').pipe(Effect.flip)).toMatchObject({
        reason: 'corrupt',
      });
      expect(yield* ensureCodeGraphWorksetCatalog(home).pipe(Effect.flip)).toMatchObject({reason: 'corrupt'});
      expect(yield* inspectCodeGraphWorksetCatalog(home)).toMatchObject({state: 'corrupt'});
    }).pipe(provideTestLayer(layer)),
  );
});
