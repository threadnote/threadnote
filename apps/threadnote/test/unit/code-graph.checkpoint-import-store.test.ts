import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import * as SqlClient from 'effect/sql/SqlClient';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {
  CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
  CodeGraphStore,
  codeGraphPackageMoniker,
  hydrateCodeGraphCheckpointReusableBaseReceipt,
  materializedFileShardIdentity,
  type CodeGraphCheckpointImportBuildInput,
  type CodeGraphCheckpointImportReceiptInput,
  type CodeGraphStoreShape,
} from '@threadnote/graph/store';
import {
  checkpointStoredFactMatches,
  validateCodeGraphCheckpointImportReceiptInput,
} from '@threadnote/graph/store/checkpoint_import';
import {codeGraphCheckpointFileFactCacheIdentity} from '@threadnote/graph/checkpoint/file_fact_identity';
import type {CodeGraphFileFacts, CodeGraphSnapshot, RepositoryIdentity} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {claimPersistentBuildForTest} from '@threadnote/graph/test/helpers/code-graph-build';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdtempSync, rmSync, writeFileSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {Database} from 'bun:sqlite';
import {runCommandEffect} from '@threadnote/platform/command';
import {codeGraphCommittedContentHash} from '@threadnote/graph/content_identity';
import {
  CODE_GRAPH_CHECKPOINT_COMPRESSION_PROFILE,
  CODE_GRAPH_CHECKPOINT_FORMAT_VERSION,
  CODE_GRAPH_CHECKPOINT_MEDIA_TYPE,
  CODE_GRAPH_CHECKPOINT_PATH_POLICY,
  CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION,
  CODE_GRAPH_CHECKPOINT_SCHEMA,
  CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION,
  emptyCodeGraphCheckpointCounts,
  type CodeGraphCheckpointHeaderV1,
} from '@threadnote/graph/checkpoint/schema';
import {CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION} from '@threadnote/graph/inventory/policy';
import {CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION} from '@threadnote/graph/store/schema/revision';
import {legacyCodeGraphAuthorityStatements} from '@threadnote/graph/test/helpers/code-graph-legacy-authority';

describe('code graph checkpoint import store', () => {
  effectIt.effect('keeps staged records unreachable and atomically publishes an immutable receipt', () =>
    TestClock.withLive(
      withFixture(({databasePath, identity, snapshot, store}) =>
        Effect.gen(function* () {
          const ownerToken = yield* claimPersistentBuildForTest(store, databasePath, identity, snapshot);
          const input = checkpointBuildInput();
          expect(yield* store.bindCheckpointImportBuild(databasePath, snapshot.id, input)).toEqual({state: 'bound'});
          expect(yield* store.bindCheckpointImportBuild(databasePath, snapshot.id, input)).toEqual({
            state: 'already-bound',
          });

          const page = {
            batchIndex: 0,
            digest: {algorithm: 'sha256' as const, digest: 'd'.repeat(64)},
            records: [
              {
                blobId: 'b'.repeat(40),
                contentHash: 'c'.repeat(64),
                kind: 'file' as const,
                language: 'typescript',
                mode: '100644',
                path: 'src/value.ts',
                size: 12,
                source: 'commit' as const,
              },
              {
                buildSystem: 'node',
                diagnostics: [],
                id: 'workspace-root',
                kind: 'workspace-scope' as const,
                name: 'checkpoint-import',
                provenance: 'declared' as const,
                root: '',
              },
            ],
          };
          expect(yield* store.stageCheckpointImportRecordPage(databasePath, snapshot.id, ownerToken, page)).toEqual({
            records: 2,
            state: 'staged',
          });
          expect(yield* store.stageCheckpointImportRecordPage(databasePath, snapshot.id, ownerToken, page)).toEqual({
            records: 2,
            state: 'already-staged',
          });
          expect(yield* store.readySnapshotById(databasePath, snapshot.id)).toBeUndefined();

          const conflict = yield* Effect.exit(
            store.stageCheckpointImportRecordPage(databasePath, snapshot.id, ownerToken, {
              ...page,
              digest: {...page.digest, digest: 'e'.repeat(64)},
            }),
          );
          expect(conflict._tag).toBe('Failure');
          expect(yield* store.readySnapshotById(databasePath, snapshot.id)).toBeUndefined();

          const emptyPage = yield* Effect.exit(
            store.stageCheckpointImportRecordPage(databasePath, snapshot.id, ownerToken, {
              batchIndex: 1,
              digest: {...page.digest, digest: '0'.repeat(64)},
              records: [],
            }),
          );
          expect(emptyPage._tag).toBe('Failure');

          yield* store.finalizeCheckpointImport(databasePath, identity, snapshot, ownerToken, input);
          expect(yield* store.readySnapshotById(databasePath, snapshot.id)).toMatchObject({
            id: snapshot.id,
            state: 'ready',
          });
          const receipt = yield* store.checkpointImportReceipt(databasePath, snapshot.id);
          expect(receipt).toMatchObject({
            artifact: input.artifact,
            logical: input.logical,
            snapshotId: snapshot.id,
            trust: 'local-unverified',
          });
          expect(yield* store.recordCheckpointImportReceipt(databasePath, snapshot.id, input)).toMatchObject({
            state: 'already-recorded',
          });
          expect(
            yield* store.readySnapshotByLogicalDigest(
              databasePath,
              identity.repositoryId,
              input.logical.digest,
              input.abi.digest,
            ),
          ).toMatchObject({id: snapshot.id});

          const conflictingReceipt = yield* Effect.exit(
            store.recordCheckpointImportReceipt(databasePath, snapshot.id, {
              ...input,
              artifact: {...input.artifact, digest: 'f'.repeat(64)},
            }),
          );
          expect(conflictingReceipt._tag).toBe('Failure');
          const remaining = yield* store.withSession(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql.unsafe<{
                readonly batches: number;
                readonly builds: number;
                readonly workspace_root: string;
              }>(
                `SELECT
                (SELECT COUNT(*) FROM checkpoint_import_builds WHERE snapshot_id = ?) AS builds,
                (SELECT COUNT(*) FROM checkpoint_import_batches WHERE snapshot_id = ?) AS batches,
                (SELECT root FROM workspace_scopes WHERE snapshot_id = ? AND id = 'workspace-root') AS workspace_root`,
                [snapshot.id, snapshot.id, snapshot.id],
              );
            }),
          );
          expect(remaining).toEqual([{batches: 0, builds: 0, workspace_root: ''}]);
          // A legacy receipt cannot authorize a scope relabel, even if every
          // other source identity and the artifact digest still match.
          yield* store.withSession(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE snapshots SET scope_id = ${`code-graph-scope:${'f'.repeat(64)}`} WHERE id = ${snapshot.id}`;
            }),
          );
          expect(yield* store.checkpointImportReceipt(databasePath, snapshot.id)).toBeUndefined();
          expect(
            yield* store.readySnapshotByLogicalDigest(
              databasePath,
              identity.repositoryId,
              input.logical.digest,
              input.abi.digest,
            ),
          ).toBeUndefined();
          expect(
            String(yield* store.recordCheckpointImportReceipt(databasePath, snapshot.id, input).pipe(Effect.flip)),
          ).toContain('only the full repository graph');
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  fcEffectProp(
    effectIt,
    'refuses legacy import bindings and receipts for every project scope without writing authority',
    {
      scopeHex: fc
        .array(fc.constantFrom(...'0123456789abcdef'), {minLength: 64, maxLength: 64})
        .map(chars => chars.join('')),
    },
    ({scopeHex}) =>
      TestClock.withLive(
        withFixture(({databasePath, identity, snapshot, store}) =>
          Effect.gen(function* () {
            const scoped = {...snapshot, scopeId: `code-graph-scope:${scopeHex}`};
            yield* claimPersistentBuildForTest(store, databasePath, identity, scoped);
            const bindingError = yield* store
              .bindCheckpointImportBuild(databasePath, scoped.id, checkpointBuildInput())
              .pipe(Effect.flip);
            expect(String(bindingError)).toContain('only the full repository graph');
            const receiptError = yield* store
              .recordCheckpointImportReceipt(databasePath, scoped.id, checkpointReceiptInput())
              .pipe(Effect.flip);
            expect(String(receiptError)).toContain('only the full repository graph');
            expect(yield* store.checkpointImportReceipt(databasePath, scoped.id)).toBeUndefined();
            const rows = yield* store.withSession(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                return yield* sql`SELECT COUNT(*) AS count FROM checkpoint_import_builds`;
              }),
            );
            expect(rows).toEqual([{count: 0}]);
          }),
        ).pipe(provideTestLayer(ApplicationLayer)),
      ),
    {fastCheck: {numRuns: 8}},
  );

  fcEffectProp(
    effectIt,
    'accepts exactly lowercase sha256 receipt identities (property)',
    {
      artifactSize: fc.integer({min: 0, max: 10_000_000}),
      digest: fc
        .array(fc.constantFrom(...'0123456789abcdef'), {minLength: 64, maxLength: 64})
        .map(value => value.join('')),
    },
    ({artifactSize, digest}) =>
      Effect.sync(() => {
        const receipt = checkpointReceiptInput(digest, artifactSize);
        expect(() => validateCodeGraphCheckpointImportReceiptInput(receipt)).not.toThrow();
        expect(() =>
          validateCodeGraphCheckpointImportReceiptInput({
            ...receipt,
            artifact: {...receipt.artifact, digest: `A${digest.slice(1)}`},
          }),
        ).toThrow('checkpoint import receipt is invalid');
      }),
    {fastCheck: {numRuns: 32}},
  );

  effectIt.effect('rejects internally inconsistent receipt coverage', () =>
    Effect.sync(() => {
      const receipt = checkpointReceiptInput();
      expect(() =>
        validateCodeGraphCheckpointImportReceiptInput({
          ...receipt,
          coverage: {eligibleFiles: 1, excludedFiles: 1, reasons: [], state: 'partial'},
        }),
      ).toThrow(/coverage totals/u);
      expect(() =>
        validateCodeGraphCheckpointImportReceiptInput({
          ...receipt,
          coverage: {
            eligibleFiles: 1,
            excludedFiles: 0,
            reasons: [{bytes: 0, code: 'excluded', files: 0}],
            state: 'partial',
          },
        }),
      ).toThrow(/coverage totals/u);
    }),
  );

  effectIt.effect('binds staged pack provenance to the immutable import plan', () =>
    TestClock.withLive(
      withFixture(({databasePath, identity, snapshot, store}) =>
        Effect.gen(function* () {
          const ownerToken = yield* claimPersistentBuildForTest(store, databasePath, identity, snapshot);
          const pack = {
            cacheIdentity: '4'.repeat(64),
            derivationIdentity: '5'.repeat(64),
            id: 'typescript',
            resolutionDomain: 'typescript',
            resolutionVersion: 'v1',
          };
          const counts = emptyCodeGraphCheckpointCounts();
          counts['pack-provenance'] = 1;
          const input = {...checkpointReceiptInput(), batchCount: 1, packProvenance: [pack], recordCounts: counts};
          yield* store.bindCheckpointImportBuild(databasePath, snapshot.id, input);
          const staged = yield* Effect.exit(
            store.stageCheckpointImportRecordPage(databasePath, snapshot.id, ownerToken, {
              batchIndex: 0,
              digest: {algorithm: 'sha256', digest: 'd'.repeat(64)},
              records: [{...pack, kind: 'pack-provenance', resolutionVersion: 'forged'}],
            }),
          );
          expect(staged._tag).toBe('Failure');
          expect(yield* store.readySnapshotById(databasePath, snapshot.id)).toBeUndefined();
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('rejects checkpoint import when a moniker evidence path is not inventoried', () =>
    TestClock.withLive(
      withFixture(({databasePath, identity, snapshot, store}) =>
        Effect.gen(function* () {
          const ownerToken = yield* claimPersistentBuildForTest(store, databasePath, identity, snapshot);
          const counts = emptyCodeGraphCheckpointCounts();
          counts.file = 1;
          counts['workspace-scope'] = 1;
          counts['workspace-component'] = 1;
          counts.moniker = 1;
          const input = {...checkpointReceiptInput(), batchCount: 1, packProvenance: [], recordCounts: counts};
          yield* store.bindCheckpointImportBuild(databasePath, snapshot.id, input);
          const componentId = `cgp_${'1'.repeat(32)}`;
          const moniker = codeGraphPackageMoniker({
            componentId,
            evidence: {
              path: 'scratchpad/package.json',
              span: {column: 1, endColumn: 1, endLine: 1, line: 1},
            },
            packageName: 'scratchpad',
            role: 'export',
          });
          expect(
            yield* store.stageCheckpointImportRecordPage(databasePath, snapshot.id, ownerToken, {
              batchIndex: 0,
              digest: {algorithm: 'sha256', digest: 'd'.repeat(64)},
              records: [
                {
                  blobId: 'b'.repeat(40),
                  contentHash: 'c'.repeat(64),
                  kind: 'file',
                  language: 'typescript',
                  mode: '100644',
                  path: 'src/value.ts',
                  size: 12,
                  source: 'commit',
                },
                {
                  buildSystem: 'node',
                  diagnostics: [],
                  id: 'workspace-root',
                  kind: 'workspace-scope',
                  name: 'checkpoint-import',
                  provenance: 'declared',
                  root: '',
                },
                {
                  buildSystem: 'node',
                  componentKind: 'package',
                  diagnostics: [],
                  id: componentId,
                  kind: 'workspace-component',
                  languages: ['typescript'],
                  name: 'scratchpad',
                  provenance: 'declared',
                  resolutionDomain: 'typescript',
                  root: 'scratchpad',
                  sourceRoots: ['scratchpad'],
                  workspaceId: 'workspace-root',
                  workspaceRoots: [''],
                },
                {
                  componentId: moniker.componentId,
                  evidencePath: moniker.evidence.path,
                  evidenceSpan: moniker.evidence.span,
                  id: moniker.id,
                  identity: moniker.identity,
                  kind: 'moniker',
                  monikerKind: moniker.kind,
                  packageName: moniker.packageName,
                  resolutionDomain: moniker.resolutionDomain,
                  role: moniker.role,
                  scheme: moniker.scheme,
                  version: moniker.version,
                },
              ],
            }),
          ).toEqual({records: 4, state: 'staged'});
          const failed = yield* Effect.flip(
            store.finalizeCheckpointImport(databasePath, identity, snapshot, ownerToken, input),
          );
          expect(failed.message).toBe('Checkpoint import contains dangling relational endpoints.');
          expect(yield* store.readySnapshotById(databasePath, snapshot.id)).toBeUndefined();
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('reuses semantic cached facts across JSON key order but rejects changed payloads', () =>
    TestClock.withLive(
      withFixture(({databasePath, identity, snapshot, store}) =>
        Effect.gen(function* () {
          const path = 'src/value.ts';
          const contentHash = 'c'.repeat(64);
          const existingJson = JSON.stringify({path, symbols: [], edges: [], diagnostics: []});
          const file = {
            blobId: 'b'.repeat(40),
            contentHash,
            kind: 'file' as const,
            language: 'typescript',
            mode: '100644',
            path,
            size: 12,
            source: 'commit' as const,
          };
          const facts = {diagnostics: [], edges: [], path, symbols: []};
          const cacheIdentity = codeGraphCheckpointFileFactCacheIdentity(facts);
          const fact = {
            cacheIdentity,
            factRole: 'materialized' as const,
            facts,
            kind: 'file-fact' as const,
            path,
          };
          const ownerToken = yield* claimPersistentBuildForTest(store, databasePath, identity, snapshot);
          yield* store.withSession(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`
                INSERT INTO materialized_file_shards (
                  id, content_hash, extractor_set, derivation_identity, path_hint, facts_json,
                  created_at, last_used_at
                ) VALUES (
                  ${materializedFileShardIdentity(contentHash, snapshot.extractorSet, cacheIdentity, path)},
                  ${contentHash}, ${snapshot.extractorSet}, ${cacheIdentity}, ${path}, ${existingJson},
                  ${'2026-01-01T00:00:00.000Z'}, ${'2026-01-01T00:00:00.000Z'}
                )
              `;
            }),
          );
          const input = checkpointFactBuildInput();
          yield* store.bindCheckpointImportBuild(databasePath, snapshot.id, input);
          expect(
            yield* store.stageCheckpointImportRecordPage(databasePath, snapshot.id, ownerToken, {
              batchIndex: 0,
              digest: {algorithm: 'sha256', digest: 'd'.repeat(64)},
              records: [file, fact],
            }),
          ).toEqual({records: 2, state: 'staged'});
          expect(
            yield* store.withSession(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const rows = yield* sql<{readonly facts_json: string}>`
                  SELECT facts_json FROM materialized_file_shards
                  WHERE content_hash = ${contentHash} AND path_hint = ${path}
                `;
                return rows[0]?.facts_json;
              }),
            ),
          ).toBe(existingJson);

          yield* store.withSession(
            databasePath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`
                UPDATE materialized_file_shards
                SET facts_json = ${JSON.stringify({...facts, diagnostics: ['forged']})}
                WHERE content_hash = ${contentHash} AND path_hint = ${path}
              `;
            }),
          );

          const conflictingSnapshot = {
            ...snapshot,
            id: `cgsn_${'0'.repeat(40)}-full-${'5'.repeat(16)}`,
          };
          const conflictingOwner = yield* claimPersistentBuildForTest(
            store,
            databasePath,
            identity,
            conflictingSnapshot,
          );
          yield* store.bindCheckpointImportBuild(databasePath, conflictingSnapshot.id, input);
          const conflict = yield* Effect.flip(
            store.stageCheckpointImportRecordPage(databasePath, conflictingSnapshot.id, conflictingOwner, {
              batchIndex: 0,
              digest: {algorithm: 'sha256', digest: 'e'.repeat(64)},
              records: [file, fact],
            }),
          );
          expect(conflict.message).toBe(`Checkpoint file fact ${path} conflicts with cached content.`);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  fcEffectProp(
    effectIt,
    'reuses valid cached facts under recursive object-key permutations (property)',
    {facts: semanticFactArbitrary},
    ({facts}) =>
      Effect.sync(() => {
        const incoming = JSON.stringify(facts);
        const existing = JSON.stringify(reverseObjectKeys(facts));
        const reordered = reverseObjectKeys(facts) as CodeGraphFileFacts;
        expect(existing).not.toBe(incoming);
        expect(codeGraphCheckpointFileFactCacheIdentity(reordered)).toBe(
          codeGraphCheckpointFileFactCacheIdentity(facts),
        );
        expect(checkpointStoredFactMatches(existing, incoming, facts, facts.path)).toBe(true);
      }),
    {fastCheck: {numRuns: 32}},
  );

  effectIt.effect('adds revision-17 checkpoint tables without retiring revision-16 building snapshots', () =>
    TestClock.withLive(
      withFixture(({databasePath, identity, snapshot, store}) =>
        Effect.gen(function* () {
          yield* claimPersistentBuildForTest(store, databasePath, identity, snapshot);
          yield* Effect.sync(() => {
            const database = new Database(databasePath, {strict: true});
            try {
              for (const statement of legacyCodeGraphAuthorityStatements) database.exec(statement);
              database.exec('DROP TABLE checkpoint_import_receipts');
              database.exec('DROP TABLE checkpoint_import_batches');
              database.exec('DROP TABLE checkpoint_import_builds');
              database
                .query("UPDATE schema_metadata SET value = '16' WHERE key = 'persistent_extension_schema_revision'")
                .run();
            } finally {
              database.close(false);
            }
          });

          yield* store.initialize(databasePath);

          expect(yield* store.resumableBuildById(databasePath, snapshot.id)).toMatchObject({
            id: snapshot.id,
            state: 'building',
          });
          const observation = yield* Effect.sync(() => {
            const database = new Database(databasePath, {readonly: true, strict: true});
            try {
              return {
                revision: database
                  .query("SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision'")
                  .get(),
                tables: database
                  .query(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'checkpoint_import_%' ORDER BY name",
                  )
                  .all(),
              };
            } finally {
              database.close(false);
            }
          });
          expect(observation.revision).toEqual({value: String(CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION)});
          expect(observation.tables).toEqual([
            {name: 'checkpoint_import_batches'},
            {name: 'checkpoint_import_builds'},
            {name: 'checkpoint_import_receipts'},
          ]);
        }),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );

  effectIt.effect('hydrates reusable attribution only from verified local Git blobs', () =>
    TestClock.withLive(
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), 'threadnote-checkpoint-reuse-'))),
        root =>
          Effect.gen(function* () {
            yield* runCommandEffect('git', ['init', '--quiet', root], {timeoutMs: 0});
            const content = '{"name":"checkpoint-demo"}\n';
            const compactContent = '{"name":"checkpoint-demo"}';
            const attributionPath = join(root, 'package.json');
            yield* Effect.sync(() => writeFileSync(attributionPath, content));
            const hashed = yield* runCommandEffect('git', ['-C', root, 'hash-object', '-w', 'package.json'], {
              timeoutMs: 0,
            });
            const blobId = hashed.stdout.trim();
            const identity = repositoryIdentity(root);
            const header = reusableHeader(
              identity,
              blobId,
              Buffer.byteLength(compactContent),
              Buffer.byteLength(content),
            );

            const admission = {environmentFingerprint: 'a'.repeat(64)};
            const hydrated = yield* hydrateCodeGraphCheckpointReusableBaseReceipt(identity, header, admission);

            expect(hydrated?.inventory?.attributionFiles).toEqual([
              expect.objectContaining({blobId, content: compactContent, path: 'package.json', source: 'commit'}),
            ]);
            expect(hydrated?.inventory?.environmentFingerprint).toBe(admission.environmentFingerprint);

            const mismatch = yield* Effect.exit(
              hydrateCodeGraphCheckpointReusableBaseReceipt(
                identity,
                {
                  ...header,
                  reuse: {
                    ...header.reuse!,
                    inventory: {
                      ...header.reuse!.inventory!,
                      attributionFiles: [
                        {...header.reuse!.inventory!.attributionFiles[0], contentHash: 'f'.repeat(64)},
                      ],
                    },
                  },
                },
                admission,
              ),
            );
            expect(mismatch._tag).toBe('Failure');

            const sourceSizeMismatch = yield* Effect.exit(
              hydrateCodeGraphCheckpointReusableBaseReceipt(
                identity,
                {
                  ...header,
                  reuse: {
                    ...header.reuse!,
                    inventory: {
                      ...header.reuse!.inventory!,
                      attributionFiles: [
                        {
                          ...header.reuse!.inventory!.attributionFiles[0],
                          blobSize: header.reuse!.inventory!.attributionFiles[0].blobSize + 1,
                        },
                      ],
                    },
                  },
                },
                admission,
              ),
            );
            expect(sourceSizeMismatch._tag).toBe('Failure');
          }),
        root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
      ).pipe(provideTestLayer(ApplicationLayer)),
    ),
  );
});

function withFixture<A, E>(
  use: (fixture: {
    readonly databasePath: string;
    readonly identity: RepositoryIdentity;
    readonly snapshot: CodeGraphSnapshot;
    readonly store: CodeGraphStoreShape;
  }) => Effect.Effect<A, E>,
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), 'threadnote-checkpoint-import-'))),
    root =>
      Effect.gen(function* () {
        const store = yield* CodeGraphStore;
        const identity = repositoryIdentity(root);
        return yield* use({
          databasePath: join(root, 'graph-v3.sqlite'),
          identity,
          snapshot: checkpointSnapshot(identity),
          store,
        });
      }),
    root => Effect.sync(() => rmSync(root, {force: true, recursive: true})),
  );
}

function repositoryIdentity(root: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId: 'c'.repeat(64),
    displayName: 'checkpoint-import',
    gitCommonDirectory: root,
    headCommit: '1'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: 'a'.repeat(64),
    worktreeId: '2'.repeat(64),
  };
}

function checkpointSnapshot(identity: RepositoryIdentity): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    dirty: false,
    edgeCount: 0,
    extractorSet: 'native-code-graph-13',
    fileCount: 1,
    graphContentId: `cgc_${'3'.repeat(40)}`,
    id: `cgsn_${'0'.repeat(40)}-full-${'4'.repeat(16)}`,
    repositoryId: identity.repositoryId,
    state: 'building',
    symbolCount: 0,
    worktreeId: identity.worktreeId,
  };
}

function checkpointReceiptInput(digest = '5'.repeat(64), artifactSize = 1_024): CodeGraphCheckpointImportReceiptInput {
  return {
    abi: {algorithm: 'sha256', digest: '6'.repeat(64)},
    artifact: {
      algorithm: 'sha256',
      digest,
      mediaType: 'application/vnd.threadnote.code-graph-checkpoint.v1',
      size: artifactSize,
    },
    baseLogicalDigest: null,
    coverage: {eligibleFiles: 1, excludedFiles: 0, reasons: [], state: 'complete'},
    formatVersion: 1,
    logical: {algorithm: 'sha256', digest: '7'.repeat(64)},
    source: {
      commit: '1'.repeat(40),
      graphContentId: `cgc_${'3'.repeat(40)}`,
      repositoryId: 'a'.repeat(64),
    },
    trust: 'local-unverified',
  };
}

function checkpointBuildInput(): CodeGraphCheckpointImportBuildInput {
  const recordCounts = emptyCodeGraphCheckpointCounts();
  recordCounts.file = 1;
  recordCounts['workspace-scope'] = 1;
  return {...checkpointReceiptInput(), batchCount: 1, packProvenance: [], recordCounts};
}

function checkpointFactBuildInput(): CodeGraphCheckpointImportBuildInput {
  const recordCounts = emptyCodeGraphCheckpointCounts();
  recordCounts.file = 1;
  recordCounts['file-fact'] = 1;
  return {...checkpointReceiptInput(), batchCount: 1, packProvenance: [], recordCounts};
}

const boundedText = fc.string({maxLength: 24, unit: fc.constantFrom(...'abc XYZ-_.')});
const boundedNonEmptyText = fc.string({minLength: 1, maxLength: 16, unit: fc.constantFrom(...'abcXYZ-_.')});
const semanticFactArbitrary = fc
  .record({
    diagnostics: fc.array(boundedText, {maxLength: 4}),
    rationale: fc.array(
      fc.record({
        documentation: boundedText,
        line: fc.integer({min: 1, max: 10_000}),
        marker: boundedNonEmptyText,
        name: boundedNonEmptyText,
      }),
      {maxLength: 4},
    ),
  })
  .map(({diagnostics, rationale}): CodeGraphFileFacts => ({
    derivationInputs: {rationale},
    diagnostics,
    edges: [],
    path: 'src/value.ts',
    symbols: [],
  }));

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
  );
}

function reusableHeader(
  identity: RepositoryIdentity,
  blobId: string,
  size: number,
  blobSize: number,
): CodeGraphCheckpointHeaderV1 {
  const counts = emptyCodeGraphCheckpointCounts();
  return {
    abi: {
      algorithm: 'sha256',
      digest: '8'.repeat(64),
      input: {
        checkpointSemanticVersion: CODE_GRAPH_CHECKPOINT_SEMANTIC_VERSION,
        graphSchemaVersion: 3,
        inventoryPolicyVersion: CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
        languagePacks: [],
        lexicalLogicalFormatVersion: 1,
        pathPolicy: CODE_GRAPH_CHECKPOINT_PATH_POLICY,
        referenceResolutionVersion: 'references-v1',
        workspaceModelVersion: 'workspace-v1',
      },
    },
    chunks: [],
    compressionProfile: CODE_GRAPH_CHECKPOINT_COMPRESSION_PROFILE,
    counts,
    coverage: {eligibleFiles: 0, excludedFiles: 0, reasons: [], state: 'complete'},
    formatVersion: CODE_GRAPH_CHECKPOINT_FORMAT_VERSION,
    logical: {algorithm: 'sha256', digest: '9'.repeat(64)},
    mediaType: CODE_GRAPH_CHECKPOINT_MEDIA_TYPE,
    recordSchemaVersion: CODE_GRAPH_CHECKPOINT_RECORD_SCHEMA_VERSION,
    repository: {
      caseMode: identity.caseMode,
      displayName: identity.displayName,
      objectFormat: identity.objectFormat,
      repositoryId: identity.repositoryId,
    },
    reuse: {
      fileSetFingerprint: 'files',
      formatVersion: 2,
      inventory: {
        attributionFiles: [
          {
            blobId,
            blobSize,
            contentHash: codeGraphCommittedContentHash(identity.objectFormat, blobId),
            language: 'json',
            mode: '100644',
            path: 'package.json',
            size,
            source: 'commit',
          },
        ],
        contract: 'a'.repeat(64),
        includeOpaqueCorpusAssets: false,
        policyExclusions: {
          bytes: 0,
          files: 0,
          policyVersion: CODE_GRAPH_INVENTORY_ADMISSION_POLICY_VERSION,
          reasons: [],
        },
        skipped: 0,
        version: CODE_GRAPH_INVENTORY_REUSE_RECEIPT_VERSION,
        workspace: {diagnostics: [], fingerprint: 'workspace', projects: [], workspaces: []},
      },
      resolutionSurfaceVersion: 1,
      workspaceFingerprint: 'workspace',
    },
    schema: CODE_GRAPH_CHECKPOINT_SCHEMA,
    source: {
      commit: identity.headCommit,
      extractorSet: 'native-code-graph-13',
      graphContentId: `cgc_${'3'.repeat(40)}`,
    },
  };
}
