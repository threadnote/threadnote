import {Array as EffectArray} from 'effect';
import {Database} from 'bun:sqlite';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphPackageMoniker, codeGraphProtobufMoniker} from '@threadnote/graph/cross_repository/monikers';
import {
  CodeGraphSnapshotMonikerError,
  readCodeGraphSnapshotMonikers,
} from '@threadnote/graph/cross_repository/snapshot_monikers';
import type {CodeGraphMonikerV1} from '@threadnote/graph/cross_repository/types';
import {join, mkdtemp, rm} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const snapshotId = `cgsn_${Effect.pipe('1', EffectString.repeat(40))}`;
const repositoryId = sha256HexSync('snapshot-moniker-repository');
const span = {column: 1, endColumn: 20, endLine: 1, line: 1} as const;

describe('cross-repository snapshot moniker reader', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      EffectArray.map(temporaryDirectories.splice(0), path => rm(path, {force: true, recursive: true})),
    );
  });

  it('keyset-pages canonical rows from the exact ready repository snapshot', async () => {
    const databasePath = await databaseWithMonikers(temporaryDirectories, fixtureMonikers());

    const result = await runEffect(
      readCodeGraphSnapshotMonikers(databasePath, {pageSize: 1, repositoryId, snapshotId}),
    );

    expect(result).toEqual(
      [...fixtureMonikers()].sort((left, right) => Effect.pipe(left.id, EffectString.localeCompare(right.id))),
    );
  });

  it('accepts an authoritative direct-persistent snapshot identity', async () => {
    const databasePath = await databaseWithMonikers(temporaryDirectories, fixtureMonikers());
    const directSnapshotId = `${snapshotId}-direct`;
    const database = new Database(databasePath, {strict: true});
    database.query('UPDATE snapshots SET id = ? WHERE id = ?').run(directSnapshotId, snapshotId);
    database
      .query('UPDATE code_graph_monikers SET snapshot_id = ? WHERE snapshot_id = ?')
      .run(directSnapshotId, snapshotId);
    database.close(false);

    await expect(
      runEffect(readCodeGraphSnapshotMonikers(databasePath, {repositoryId, snapshotId: directSnapshotId})),
    ).resolves.toHaveLength(fixtureMonikers().length);
  });

  it('fails closed when the bounded bridge surface has another row', async () => {
    const databasePath = await databaseWithMonikers(temporaryDirectories, fixtureMonikers());

    await expect(
      runEffect(
        readCodeGraphSnapshotMonikers(databasePath, {
          maximumMonikers: 1,
          pageSize: 1,
          repositoryId,
          snapshotId,
        }),
      ),
    ).rejects.toMatchObject({code: 'limit-exceeded', name: 'CodeGraphSnapshotMonikerError'});
  });

  it('rejects a missing, non-ready, or wrong-repository snapshot without returning rows', async () => {
    const databasePath = await databaseWithMonikers(temporaryDirectories, fixtureMonikers());
    const database = new Database(databasePath, {strict: true});
    database.query('UPDATE snapshots SET state = ? WHERE id = ?').run('retired', snapshotId);
    database.close(false);

    await expect(
      runEffect(readCodeGraphSnapshotMonikers(databasePath, {repositoryId, snapshotId})),
    ).rejects.toBeInstanceOf(CodeGraphSnapshotMonikerError);
  });

  it('rejects a noncanonical persisted moniker instead of repairing it implicitly', async () => {
    const databasePath = await databaseWithMonikers(temporaryDirectories, fixtureMonikers());
    const database = new Database(databasePath, {strict: true});
    database
      .query('UPDATE code_graph_monikers SET package_name = ? WHERE scheme = ? LIMIT 1')
      .run('@ACME/SHARED', 'package');
    database.close(false);

    await expect(
      runEffect(readCodeGraphSnapshotMonikers(databasePath, {repositoryId, snapshotId})),
    ).rejects.toMatchObject({code: 'corrupt'});
  });

  it('returns the same canonical sequence for every allowed page boundary', async () => {
    const databasePath = await databaseWithMonikers(temporaryDirectories, fixtureMonikers());
    const expected = await runEffect(
      readCodeGraphSnapshotMonikers(databasePath, {pageSize: 8, repositoryId, snapshotId}),
    );

    await fc.assert(
      fc.asyncProperty(fc.integer({max: 4, min: 1}), async pageSize => {
        const actual = await runEffect(
          readCodeGraphSnapshotMonikers(databasePath, {pageSize, repositoryId, snapshotId}),
        );
        expect(actual).toEqual(expected);
      }),
      {numRuns: 20},
    );
  });
});

function fixtureMonikers(): readonly CodeGraphMonikerV1[] {
  return [
    codeGraphPackageMoniker({
      componentId: `cgp_${Effect.pipe('2', EffectString.repeat(32))}`,
      evidence: {path: 'package.json', span},
      packageName: '@acme/shared',
      packageVersion: '1.4.0',
      role: 'export',
    }),
    codeGraphProtobufMoniker({
      evidence: {path: 'contracts/orders.proto', span},
      kind: 'service',
      packageName: 'acme.orders.v1',
      qualifiedName: 'acme.orders.v1.Orders',
      role: 'export',
      symbolId: `cgs_${Effect.pipe('3', EffectString.repeat(32))}`,
    }),
  ];
}

async function databaseWithMonikers(
  temporaryDirectories: string[],
  monikers: readonly CodeGraphMonikerV1[],
): Promise<string> {
  const root = await mkdtemp('threadnote-snapshot-monikers-');
  temporaryDirectories.push(root);
  const databasePath = join(root, 'graph.sqlite');
  const database = new Database(databasePath, {strict: true});
  try {
    database.exec(`
      CREATE TABLE snapshots (
        id TEXT PRIMARY KEY NOT NULL,
        repository_id TEXT NOT NULL,
        state TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE code_graph_monikers (
        snapshot_id TEXT NOT NULL,
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        scheme TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        resolution_domain TEXT NOT NULL,
        identity TEXT NOT NULL,
        package_name TEXT,
        package_version TEXT,
        import_path TEXT,
        qualified_name TEXT,
        component_id TEXT,
        symbol_id TEXT,
        dependency_kind TEXT,
        evidence_path TEXT NOT NULL,
        evidence_span_json TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, id)
      ) WITHOUT ROWID;
    `);
    database
      .query('INSERT INTO snapshots (id, repository_id, state) VALUES (?, ?, ?)')
      .run(snapshotId, repositoryId, 'ready');
    const insert = database.query(`
      INSERT INTO code_graph_monikers (
        snapshot_id, id, version, scheme, role, kind, resolution_domain, identity,
        package_name, package_version, import_path, qualified_name, component_id,
        symbol_id, dependency_kind, evidence_path, evidence_span_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const moniker of monikers) {
      insert.run(
        snapshotId,
        moniker.id,
        moniker.version,
        moniker.scheme,
        moniker.role,
        moniker.kind,
        moniker.resolutionDomain,
        moniker.identity,
        moniker.scheme === 'package' ? moniker.packageName : (moniker.packageName ?? null),
        moniker.scheme === 'package' ? (moniker.packageVersion ?? null) : null,
        moniker.scheme === 'protobuf' ? (moniker.importPath ?? null) : null,
        moniker.scheme === 'protobuf' ? (moniker.qualifiedName ?? null) : null,
        moniker.scheme === 'package' ? moniker.componentId : null,
        moniker.scheme === 'protobuf' ? moniker.symbolId : null,
        moniker.scheme === 'package' ? (moniker.dependencyKind ?? null) : null,
        moniker.evidence.path,
        JSON.stringify(moniker.evidence.span),
      );
    }
  } finally {
    database.close(false);
  }
  return databasePath;
}
