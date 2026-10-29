import {Array as EffectArray} from 'effect';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem} from 'effect';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {SystemInfo} from '@threadnote/platform/system';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION,
  codeGraphWorksetCatalogDatabasePath,
} from '@threadnote/graph/workset_catalog/layout';
import {
  codeGraphWorksetCatalogGenerationIdentity,
  createCodeGraphWorksetRoutingProjection,
} from '@threadnote/graph/workset_catalog/projection';
import {
  codeGraphWorksetRoutingProjectionLogicalBytes,
  codeGraphWorksetRoutingProjectionLogicalBytesAppend,
} from '@threadnote/graph/workset_catalog/projection/storage';
import {
  ensureCodeGraphWorksetCatalog,
  inspectCodeGraphWorksetCatalog,
  maintainCodeGraphWorksetCatalog,
  appendCodeGraphWorksetCatalogProjectionPage,
  beginCodeGraphWorksetCatalogProjection,
  codeGraphWorksetCatalogProjectionContainsNode,
  completeCodeGraphWorksetCatalogProjection,
  publishCodeGraphWorksetCatalogGeneration,
  readCodeGraphWorksetCatalogRoutingSymbols,
  readPublishedCodeGraphWorksetCatalogGeneration,
  recoverCodeGraphWorksetCatalog,
  retireCodeGraphWorksetPublication,
  stageCodeGraphWorksetCatalogGeneration,
  stageCodeGraphWorksetCatalogGenerationFromReceipts,
  withCodeGraphWorksetCatalogWriter,
} from '@threadnote/graph/workset_catalog/store';
import {
  CODE_GRAPH_WORKSET_CATALOG_LIMITS,
  CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogGenerationInputV1,
  type CodeGraphWorksetCatalogGenerationMemberV1,
  type CodeGraphWorksetRoutingProjectionV1,
  type CodeGraphWorksetRoutingSymbolV1,
} from '@threadnote/graph/workset_catalog/types';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {join, pathService, mkdir, mkdtemp, readFile, rm, stat, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

describe('code graph workset catalog', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  it('uses an independent private schema with indexed normalized routing surfaces', async () => {
    const home = await temporaryHome(homes);
    await runEffect(ensureCodeGraphWorksetCatalog(home));
    const databasePath = catalogPath(home);

    expect(databasePath).toBe(
      join(home, 'indexes', 'code-graph', 'worksets', `catalog-v${CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION}.sqlite`),
    );
    if (process.platform !== 'win32') expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    expect(
      await runEffect(
        withCodeGraphWorksetCatalogWriter(home, sql =>
          sql
            .unsafe<{readonly max_page_count: number}>('PRAGMA max_page_count')
            .pipe(Effect.map(rows => rows[0]?.max_page_count)),
        ),
      ),
    ).toBe(1_048_576);

    const database = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(database.query<{readonly page_size: number}, []>('PRAGMA page_size').get()?.page_size).toBe(4_096);
      const symbolColumns = EffectArray.map(
        database.query<{readonly name: string}, []>('PRAGMA table_info(routing_symbols)').all(),
        row => row.name,
      );
      expect(symbolColumns).not.toEqual(expect.arrayContaining(['documentation', 'signature', 'source']));
      expect(
        EffectArray.map(
          database.query<{readonly name: string}, []>('PRAGMA table_info(routing_lookup_keys)').all(),
          row => row.name,
        ),
      ).toEqual(expect.arrayContaining(['lookup_key', 'node_id', 'projection_digest']));
      const exactPlan = database
        .query<{readonly detail: string}, [string]>(
          'EXPLAIN QUERY PLAN SELECT node_id FROM routing_lookup_keys WHERE lookup_key = ?',
        )
        .all('exact.lookup');
      expect(
        EffectArray.some(exactPlan, row =>
          Effect2.pipe(row.detail, EffectString.includes('routing_lookup_keys_exact')),
        ),
      ).toBe(true);
      expect(
        database
          .query<{readonly name: string}, []>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'workset_generations_%' ORDER BY name",
          )
          .all(),
      ).toEqual([{name: 'workset_generations_retirement'}]);
    } finally {
      database.close(false);
    }
  });

  it('detects and rebuilds a current-schema catalog persisted with a noncanonical SQLite page size', async () => {
    const home = await temporaryHome(homes);
    await mkdir(join(home, 'indexes', 'code-graph', 'worksets'), {recursive: true});
    const databasePath = catalogPath(home);
    const converted = new Database(databasePath, {strict: true});
    try {
      converted.exec('PRAGMA page_size = 8192');
      converted.exec('VACUUM');
      converted.exec(
        'CREATE TABLE catalog_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) WITHOUT ROWID',
      );
      converted
        .query('INSERT INTO catalog_metadata (key, value) VALUES (?, ?)')
        .run('schema_version', String(CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION));
      expect(converted.query<{readonly page_size: number}, []>('PRAGMA page_size').get()?.page_size).toBe(8_192);
    } finally {
      converted.close(false);
    }

    expect(await runEffect(inspectCodeGraphWorksetCatalog(home))).toEqual({
      schemaVersion: CODE_GRAPH_WORKSET_CATALOG_SCHEMA_VERSION,
      state: 'incompatible',
    });
    expect(await runEffect(recoverCodeGraphWorksetCatalog(home))).toEqual({
      previousState: 'incompatible',
      rebuilt: true,
    });
    expect(await runEffect(inspectCodeGraphWorksetCatalog(home))).toMatchObject({state: 'ok'});

    const rebuilt = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(rebuilt.query<{readonly page_size: number}, []>('PRAGMA page_size').get()?.page_size).toBe(4_096);
    } finally {
      rebuilt.close(false);
    }
  });

  it('removes the interim duplicate generation-state index during additive initialization', async () => {
    const home = await temporaryHome(homes);
    await runEffect(ensureCodeGraphWorksetCatalog(home));
    const databasePath = catalogPath(home);
    const interim = new Database(databasePath, {strict: true});
    try {
      interim.exec(`
        CREATE INDEX workset_generations_state_created
        ON workset_generations(state, created_at, id)
      `);
    } finally {
      interim.close(false);
    }

    await runEffect(ensureCodeGraphWorksetCatalog(home));
    const migrated = new Database(databasePath, {readonly: true, strict: true});
    try {
      expect(
        migrated
          .query<{readonly name: string}, []>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'workset_generations_%' ORDER BY name",
          )
          .all(),
      ).toEqual([{name: 'workset_generations_retirement'}]);
    } finally {
      migrated.close(false);
    }
  });

  it('fails projection disk admission before reserving catalog capacity', async () => {
    const home = await temporaryHome(homes);
    const candidate = projection(901);
    const receipt = projectionReceipt(candidate);
    const failure = await runEffect(
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        return yield* beginCodeGraphWorksetCatalogProjection(
          home,
          receipt,
          codeGraphWorksetRoutingProjectionLogicalBytes(candidate.symbols),
        ).pipe(
          Effect.provideService(SystemInfo, SystemInfo.of({...system, availableDiskBytes: () => Effect.succeed(0)})),
          Effect.flip,
        );
      }),
    );
    expect(failure).toMatchObject({reason: 'capacity'} satisfies Partial<CodeGraphWorksetCatalogError>);

    const database = new Database(catalogPath(home), {readonly: true, strict: true});
    try {
      expect(
        database.query<{readonly count: number}, []>('SELECT COUNT(*) AS count FROM repository_snapshots').get(),
      ).toEqual({count: 0});
      expect(
        database
          .query<{readonly projection_logical_bytes: number}, []>(
            'SELECT projection_logical_bytes FROM catalog_capacity WHERE singleton = 1',
          )
          .get(),
      ).toEqual({projection_logical_bytes: 0});
    } finally {
      database.close(false);
    }
  });

  it('keeps staged data invisible and swaps only a validated generation pointer', async () => {
    const home = await temporaryHome(homes);
    const first = generationInput('engineering', 'manifest-a', [member(1, 'producer')]);
    const firstStage = await runEffect(stageCodeGraphWorksetCatalogGeneration(home, first));

    expect(await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'engineering'))).toBeUndefined();
    await runEffect(
      publishCodeGraphWorksetCatalogGeneration(home, {
        generationId: firstStage.id,
        worksetName: 'engineering',
      }),
    );
    const publishedFirst = await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'engineering'));
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(publishedFirst?.members), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, entry => entry.repositoryKey),
        ),
      ),
    ).toEqual(['producer']);

    const second = generationInput('engineering', 'manifest-b', [member(2, 'consumer'), member(3, 'schema')]);
    const secondStage = await runEffect(stageCodeGraphWorksetCatalogGeneration(home, second));
    expect((await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'engineering')))?.id).toBe(
      firstStage.id,
    );

    await runEffect(
      publishCodeGraphWorksetCatalogGeneration(home, {
        generationId: secondStage.id,
        worksetName: 'engineering',
      }),
    );
    const publishedSecond = await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'engineering'));
    expect(publishedSecond).toMatchObject({id: secondStage.id, manifestDigest: digest('manifest-b')});
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(publishedSecond?.members), __effectArrayReceiver =>
          EffectArray.map(__effectArrayReceiver, entry => entry.repositoryKey),
        ),
      ),
    ).toEqual(['consumer', 'schema']);

    const firstPage = await runEffect(
      readCodeGraphWorksetCatalogRoutingSymbols(home, {limit: 1, worksetName: 'engineering'}),
    );
    expect(firstPage?.symbols).toHaveLength(1);
    expect(firstPage?.symbols[0]).toMatchObject({repositoryKey: 'consumer'});
    expect(firstPage?.symbols[0]?.terms).toEqual(expect.arrayContaining([{term: 'symbol-2', weight: 4}]));
    expect(firstPage?.symbols[0]?.lookupKeys).toEqual([`exact.symbol.2`, `symbol.2`]);
    const secondPage = await runEffect(
      readCodeGraphWorksetCatalogRoutingSymbols(home, {
        after: firstPage?.next,
        limit: 1,
        worksetName: 'engineering',
      }),
    );
    expect(secondPage?.symbols[0]?.repositoryKey).toBe('schema');
    expect(secondPage?.next).toBeUndefined();
  });

  it('checks a qualified node against one exact projection without scanning the generation', async () => {
    const home = await temporaryHome(homes);
    const input = generationInput('engineering', 'manifest-node-membership', [member(1, 'producer')]);
    await runEffect(stageCodeGraphWorksetCatalogGeneration(home, input));
    const projection = input.members[0].projection;

    expect(
      await runEffect(
        codeGraphWorksetCatalogProjectionContainsNode(home, {
          nodeId: projection.symbols[0].nodeId,
          projectionDigest: projection.projectionDigest,
        }),
      ),
    ).toBe(true);
    expect(
      await runEffect(
        codeGraphWorksetCatalogProjectionContainsNode(home, {
          nodeId: `cgs_${Effect2.pipe('f', EffectString.repeat(32))}`,
          projectionDigest: projection.projectionDigest,
        }),
      ),
    ).toBe(false);
  });

  it('refuses a corrupted staged projection without replacing the published generation', async () => {
    const home = await temporaryHome(homes);
    const first = await publish(home, generationInput('engineering', 'manifest-a', [member(1, 'producer')]));
    const secondInput = generationInput('engineering', 'manifest-b', [member(2, 'consumer')]);
    const second = await runEffect(stageCodeGraphWorksetCatalogGeneration(home, secondInput));
    const database = new Database(catalogPath(home), {strict: true});
    try {
      database
        .query('UPDATE routing_symbols SET name = ? WHERE projection_digest = ?')
        .run('tampered', secondInput.members[0].projection.projectionDigest);
    } finally {
      database.close(false);
    }

    await expect(
      runEffect(
        publishCodeGraphWorksetCatalogGeneration(home, {
          generationId: second.id,
          worksetName: 'engineering',
        }),
      ),
    ).rejects.toMatchObject({reason: 'corrupt'} satisfies Partial<CodeGraphWorksetCatalogError>);
    expect((await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'engineering')))?.id).toBe(first.id);
  });

  it('makes incremental publication converge to the same normalized catalog view as a clean rebuild', async () => {
    const cleanHome = await temporaryHome(homes);
    const incrementalHome = await temporaryHome(homes);
    const members = [member(3, 'schema'), member(1, 'producer'), member(2, 'consumer')];
    const full = generationInput('engineering', 'manifest-full', members);
    await publish(cleanHome, full);
    await publish(incrementalHome, generationInput('engineering', 'manifest-one', members.slice(0, 1)));
    await publish(incrementalHome, generationInput('engineering', 'manifest-two', members.slice(0, 2)));
    await publish(incrementalHome, full);

    expect(await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(incrementalHome, 'engineering'))).toEqual(
      await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(cleanHome, 'engineering')),
    );
    expect(await collectSymbols(incrementalHome, 'engineering')).toEqual(
      await collectSymbols(cleanHome, 'engineering'),
    );
  });

  it('streams bounded projection pages to the same generation and never publishes an incomplete stream', async () => {
    const wholeHome = await temporaryHome(homes);
    const streamedHome = await temporaryHome(homes);
    const input = generationInput('engineering', 'manifest-stream', [member(3, 'schema'), member(1, 'producer')]);
    const whole = await publish(wholeHome, input);

    await fc.assert(
      fc.asyncProperty(fc.integer({min: 1, max: 3}), async pageSize => {
        const propertyHome = await temporaryHome(homes);
        await runEffect(ensureCodeGraphWorksetCatalog(propertyHome));
        for (const entry of input.members) {
          const receipt = projectionReceipt(entry.projection);
          const begun = await runEffect(
            beginCodeGraphWorksetCatalogProjection(
              propertyHome,
              receipt,
              codeGraphWorksetRoutingProjectionLogicalBytes(entry.projection.symbols),
            ),
          );
          if (begun.state === 'staging') {
            for (let offset = 0; offset < entry.projection.symbols.length; offset += pageSize) {
              await runEffect(
                appendCodeGraphWorksetCatalogProjectionPage(propertyHome, {
                  projectionDigest: receipt.projectionDigest,
                  stagingToken: begun.stagingToken,
                  symbols: entry.projection.symbols.slice(offset, offset + pageSize),
                }),
              );
            }
            await runEffect(
              completeCodeGraphWorksetCatalogProjection(propertyHome, {
                projectionDigest: receipt.projectionDigest,
                stagingToken: begun.stagingToken,
              }),
            );
          }
        }
        const staged = await runEffect(
          stageCodeGraphWorksetCatalogGenerationFromReceipts(propertyHome, {
            manifestDigest: input.manifestDigest,
            members: EffectArray.map(input.members, entry => ({
              projectionDigest: entry.projection.projectionDigest,
              repositoryId: entry.projection.repositoryId,
              repositoryKey: entry.repositoryKey,
              snapshotId: entry.projection.snapshotId,
            })),
            worksetName: input.worksetName,
          }),
        );
        await runEffect(
          publishCodeGraphWorksetCatalogGeneration(propertyHome, {
            generationId: staged.id,
            worksetName: input.worksetName,
          }),
        );
        expect(staged.id).toBe(whole.id);
        expect(await collectSymbols(propertyHome, input.worksetName)).toEqual(
          await collectSymbols(wholeHome, input.worksetName),
        );
      }),
      {numRuns: 8},
    );

    const staged = await runEffect(stageCodeGraphWorksetCatalogGeneration(streamedHome, input));
    await runEffect(
      publishCodeGraphWorksetCatalogGeneration(streamedHome, {
        generationId: staged.id,
        worksetName: input.worksetName,
      }),
    );

    const previous = await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(streamedHome, 'engineering'));
    const incomplete = projection(99);
    const incompleteStage = await runEffect(
      beginCodeGraphWorksetCatalogProjection(
        streamedHome,
        projectionReceipt(incomplete),
        codeGraphWorksetRoutingProjectionLogicalBytes(incomplete.symbols),
      ),
    );
    if (incompleteStage.state !== 'staging') throw new Error('Expected incomplete staging projection.');
    await expect(
      runEffect(
        completeCodeGraphWorksetCatalogProjection(streamedHome, {
          projectionDigest: incomplete.projectionDigest,
          stagingToken: incompleteStage.stagingToken,
        }),
      ),
    ).rejects.toMatchObject({reason: 'corrupt'} satisfies Partial<CodeGraphWorksetCatalogError>);
    expect((await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(streamedHome, 'engineering')))?.id).toBe(
      previous?.id,
    );

    await runEffect(maintainCodeGraphWorksetCatalog(streamedHome, {generationLimit: 1, projectionLimit: 1}));
    await expect(
      runEffect(
        beginCodeGraphWorksetCatalogProjection(
          streamedHome,
          projectionReceipt(incomplete),
          codeGraphWorksetRoutingProjectionLogicalBytes(incomplete.symbols),
        ),
      ),
    ).rejects.toMatchObject({reason: 'capacity'} satisfies Partial<CodeGraphWorksetCatalogError>);
    for (let page = 0; page < 16; page += 1) {
      await runEffect(maintainCodeGraphWorksetCatalog(streamedHome, {generationLimit: 1, projectionLimit: 1}));
    }
    const restarted = await runEffect(
      beginCodeGraphWorksetCatalogProjection(
        streamedHome,
        projectionReceipt(incomplete),
        codeGraphWorksetRoutingProjectionLogicalBytes(incomplete.symbols),
      ),
    );
    if (restarted.state !== 'staging') throw new Error('Expected a new staging projection.');
    expect(restarted.stagingToken).not.toBe(incompleteStage.stagingToken);
    await expect(
      runEffect(
        appendCodeGraphWorksetCatalogProjectionPage(streamedHome, {
          projectionDigest: incomplete.projectionDigest,
          stagingToken: incompleteStage.stagingToken,
          symbols: incomplete.symbols,
        }),
      ),
    ).rejects.toMatchObject({reason: 'stale'} satisfies Partial<CodeGraphWorksetCatalogError>);
    await runEffect(
      appendCodeGraphWorksetCatalogProjectionPage(streamedHome, {
        projectionDigest: incomplete.projectionDigest,
        stagingToken: restarted.stagingToken,
        symbols: incomplete.symbols,
      }),
    );
    await runEffect(
      completeCodeGraphWorksetCatalogProjection(streamedHome, {
        projectionDigest: incomplete.projectionDigest,
        stagingToken: restarted.stagingToken,
      }),
    );
  });

  it('reclaims a ready projection interrupted before generation staging', async () => {
    const home = await temporaryHome(homes);
    const orphan = projection(700);
    const receipt = projectionReceipt(orphan);
    const begun = await runEffect(
      beginCodeGraphWorksetCatalogProjection(
        home,
        receipt,
        codeGraphWorksetRoutingProjectionLogicalBytes(orphan.symbols),
      ),
    );
    if (begun.state !== 'staging') throw new Error('Expected an orphan staging projection.');
    await runEffect(
      appendCodeGraphWorksetCatalogProjectionPage(home, {
        projectionDigest: receipt.projectionDigest,
        stagingToken: begun.stagingToken,
        symbols: orphan.symbols,
      }),
    );
    await runEffect(
      completeCodeGraphWorksetCatalogProjection(home, {
        projectionDigest: receipt.projectionDigest,
        stagingToken: begun.stagingToken,
      }),
    );

    for (let page = 0; page < 16; page += 1) {
      await runEffect(maintainCodeGraphWorksetCatalog(home, {generationLimit: 1, projectionLimit: 1}));
      const health = await runEffect(inspectCodeGraphWorksetCatalog(home));
      if (health.state === 'ok' && health.projectionCount === 0) break;
    }
    expect(await runEffect(inspectCodeGraphWorksetCatalog(home))).toMatchObject({projectionCount: 0, state: 'ok'});

    const restarted = await runEffect(
      beginCodeGraphWorksetCatalogProjection(
        home,
        receipt,
        codeGraphWorksetRoutingProjectionLogicalBytes(orphan.symbols),
      ),
    );
    expect(restarted).toMatchObject({state: 'staging'});
    if (restarted.state === 'staging') expect(restarted.stagingToken).not.toBe(begun.stagingToken);
  });

  it('retires old generations in bounded pages and rebuilds only the corrupt disposable catalog', async () => {
    const home = await temporaryHome(homes);
    await publish(home, generationInput('engineering', 'manifest-a', [member(1, 'producer')]));
    await publish(home, generationInput('engineering', 'manifest-b', [member(2, 'consumer')]));
    expect(await runEffect(inspectCodeGraphWorksetCatalog(home))).toMatchObject({
      projectionCount: 2,
      publishedWorksets: 1,
      readyGenerations: 1,
      state: 'ok',
    });

    expect(await runEffect(maintainCodeGraphWorksetCatalog(home, {generationLimit: 1, projectionLimit: 1}))).toEqual({
      projectionsDeleted: 0,
      retiredGenerationsDeleted: 0,
      stagingGenerationsRetired: 0,
    });
    for (let page = 0; page < 32; page += 1) {
      await runEffect(maintainCodeGraphWorksetCatalog(home, {generationLimit: 1, projectionLimit: 1}));
      const health = await runEffect(inspectCodeGraphWorksetCatalog(home));
      if (health.state === 'ok' && health.projectionCount === 1) break;
    }
    expect(await runEffect(inspectCodeGraphWorksetCatalog(home))).toMatchObject({projectionCount: 1, state: 'ok'});

    const repositorySentinel = join(home, 'indexes', 'code-graph', 'repositories', 'sentinel', 'graph-v3.sqlite');
    await mkdir(join(home, 'indexes', 'code-graph', 'repositories', 'sentinel'), {recursive: true});
    await writeFile(repositorySentinel, 'repository graph remains authoritative');
    const catalog = catalogPath(home);
    await rm(`${catalog}-wal`, {force: true});
    await rm(`${catalog}-shm`, {force: true});
    await rm(`${catalog}-journal`, {force: true});
    await rm(catalog, {force: true});
    await writeFile(catalog, 'not a sqlite catalog');

    expect(await runEffect(inspectCodeGraphWorksetCatalog(home))).toMatchObject({state: 'corrupt'});
    expect(await runEffect(recoverCodeGraphWorksetCatalog(home))).toEqual({previousState: 'corrupt', rebuilt: true});
    expect(await readFile(repositorySentinel, 'utf8')).toBe('repository graph remains authoritative');
    expect(await runEffect(inspectCodeGraphWorksetCatalog(home))).toMatchObject({
      projectionCount: 0,
      state: 'ok',
    });
  });

  it('retires only an exact named publication and reports deferred bounded cleanup idempotently', async () => {
    const home = await temporaryHome(homes);
    const engineering = await publish(home, generationInput('engineering', 'manifest-a', [member(11, 'api')]));
    await publish(home, generationInput('platform', 'manifest-b', [member(12, 'worker')]));

    expect(
      await runEffect(
        retireCodeGraphWorksetPublication(home, {generationId: engineering.id, worksetName: 'engineering'}),
      ),
    ).toEqual({
      cleanupPending: true,
      retired: true,
    });
    expect(await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'engineering'))).toBeUndefined();
    expect(await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'platform'))).toMatchObject({
      worksetName: 'platform',
    });

    const database = new Database(catalogPath(home), {readonly: true, strict: true});
    try {
      expect(
        database
          .query<{readonly state: string}, [string]>('SELECT state FROM workset_generations WHERE id = ?')
          .get(engineering.id)?.state,
      ).toBe('retired');
    } finally {
      database.close(false);
    }
    expect(
      await runEffect(
        retireCodeGraphWorksetPublication(home, {generationId: engineering.id, worksetName: 'engineering'}),
      ),
    ).toMatchObject({retired: false});
  });

  it('cannot retire a newer same-name publication with an obsolete generation fence', async () => {
    const home = await temporaryHome(homes);
    const old = await publish(home, generationInput('engineering', 'manifest-old', [member(21, 'old')]));
    const current = await publish(home, generationInput('engineering', 'manifest-current', [member(22, 'current')]));

    expect(
      await runEffect(retireCodeGraphWorksetPublication(home, {generationId: old.id, worksetName: 'engineering'})),
    ).toMatchObject({retired: false});
    expect(await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'engineering'))).toMatchObject({
      id: current.id,
    });
  });

  it('reclaims generation members in physical pages instead of a parent cascade', async () => {
    const home = await temporaryHome(homes);
    const shared = member(31, 'seed');
    await publish(home, generationInput('seed', 'seed-manifest', [shared]));
    const largeMembers = Array.from({length: 257}, (_, index) => ({
      projectionDigest: shared.projection.projectionDigest,
      repositoryId: shared.projection.repositoryId,
      repositoryKey: `member-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}`,
      snapshotId: shared.projection.snapshotId,
    }));
    const large = await runEffect(
      stageCodeGraphWorksetCatalogGenerationFromReceipts(home, {
        manifestDigest: digest('large-manifest'),
        members: largeMembers,
        worksetName: 'large',
      }),
    );
    await runEffect(publishCodeGraphWorksetCatalogGeneration(home, {generationId: large.id, worksetName: 'large'}));
    await publish(home, generationInput('large', 'replacement-manifest', [member(32, 'replacement')]));

    await runEffect(maintainCodeGraphWorksetCatalog(home, {generationLimit: 1, projectionLimit: 0}));
    const database = new Database(catalogPath(home), {readonly: true, strict: true});
    try {
      expect(
        database
          .query<{readonly count: number}, [string]>(
            'SELECT COUNT(*) AS count FROM workset_generation_members WHERE generation_id = ?',
          )
          .get(large.id)?.count,
      ).toBe(1);
    } finally {
      database.close(false);
    }
    await runEffect(maintainCodeGraphWorksetCatalog(home, {generationLimit: 1, projectionLimit: 0}));
    const afterSecondPage = new Database(catalogPath(home), {readonly: true, strict: true});
    try {
      expect(
        afterSecondPage
          .query<{readonly count: number}, [string]>(
            'SELECT COUNT(*) AS count FROM workset_generation_members WHERE generation_id = ?',
          )
          .get(large.id)?.count,
      ).toBe(0);
    } finally {
      afterSecondPage.close(false);
    }
  });

  it('never reclaims more than one routing child-row budget in a maintenance page', async () => {
    const home = await temporaryHome(homes);
    const base = projection(41);
    const {projectionDigest: _projectionDigest, symbols: _symbols, ...metadata} = base;
    const heavy = createCodeGraphWorksetRoutingProjection({
      ...metadata,
      symbols: [
        {
          ...base.symbols[0],
          lookupKeys: Array.from(
            {length: 64},
            (_, index) => `lookup.${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
          ),
          path: `${EffectArray.join(
            Array.from(
              {length: 96},
              (_, index) => `segment-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
            ),
            '/',
          )}/symbol.ts`,
          terms: Array.from({length: 64}, (_, index) => ({
            term: `term-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
            weight: 1,
          })),
        },
      ],
    });
    await publish(home, generationInput('heavy', 'heavy-manifest', [{projection: heavy, repositoryKey: 'heavy'}]));
    await publish(home, generationInput('heavy', 'replacement-manifest', [member(42, 'replacement')]));

    const countRoutingRows = () => {
      const database = new Database(catalogPath(home), {readonly: true, strict: true});
      try {
        return database
          .query<{readonly count: number}, [string, string, string, string]>(
            `SELECT
               (SELECT COUNT(*) FROM routing_exact_keys WHERE projection_digest = ?) +
               (SELECT COUNT(*) FROM routing_lookup_keys WHERE projection_digest = ?) +
               (SELECT COUNT(*) FROM routing_terms WHERE projection_digest = ?) +
               (SELECT COUNT(*) FROM routing_symbols WHERE projection_digest = ?) AS count`,
          )
          .get(heavy.projectionDigest, heavy.projectionDigest, heavy.projectionDigest, heavy.projectionDigest)!.count;
      } finally {
        database.close(false);
      }
    };
    let previous = countRoutingRows();
    let observedPayloadPage = false;
    for (let page = 0; page < 32; page += 1) {
      await runEffect(maintainCodeGraphWorksetCatalog(home, {generationLimit: 1, projectionLimit: 1}));
      const current = countRoutingRows();
      const deleted = previous - current;
      expect(deleted).toBeGreaterThanOrEqual(0);
      expect(deleted).toBeLessThanOrEqual(256);
      observedPayloadPage ||= deleted > 0;
      previous = current;
      if (current === 0) break;
    }
    expect(observedPayloadPage).toBe(true);
    expect(previous).toBe(0);
  });

  it('keeps generation identity and canonical repository order independent of input order', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({min: 0, max: 200}), {maxLength: 12}), seeds => {
        const members = EffectArray.map(seeds, seed => member(seed, `repository-${seed}`));
        const forward = codeGraphWorksetCatalogGenerationIdentity(
          generationInput('property-workset', 'property-manifest', members),
        );
        const reversed = codeGraphWorksetCatalogGenerationIdentity(
          generationInput('property-workset', 'property-manifest', [...members].reverse()),
        );

        expect(reversed.id).toBe(forward.id);
        expect(reversed.digest).toBe(forward.digest);
        expect(EffectArray.map(reversed.members, entry => entry.repositoryKey)).toEqual(
          [...EffectArray.map(forward.members, entry => entry.repositoryKey)].sort(compareText),
        );
      }),
      {numRuns: 100},
    );
  });

  it('keeps routing storage charge invariant across every streamed page partition', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({min: 0, max: 500}), {maxLength: 32, minLength: 1}),
        fc.integer({min: 1, max: 16}),
        (seeds, pageSize) => {
          const symbols = EffectArray.map(seeds, seed => projection(seed).symbols[0]);
          const full = codeGraphWorksetRoutingProjectionLogicalBytes(symbols);
          let streamed = 0;
          for (let offset = 0; offset < symbols.length; offset += pageSize) {
            streamed = codeGraphWorksetRoutingProjectionLogicalBytesAppend(
              streamed,
              symbols.slice(offset, offset + pageSize),
            );
          }
          expect(streamed).toBe(full);
        },
      ),
      {numRuns: 100},
    );
  });

  it('admits the observed ordinary 66k-symbol routing density inside the calibrated projection envelope', () => {
    const symbolCount = 66_067;
    let logicalBytes = 0;
    for (let offset = 0; offset < symbolCount; offset += 257) {
      const length = Math.min(257, symbolCount - offset);
      const page = Array.from({length}, (_, index) => calibratedProjectionSymbol(offset + index));
      logicalBytes = codeGraphWorksetRoutingProjectionLogicalBytesAppend(logicalBytes, page);
    }

    expect(logicalBytes).toBeGreaterThan(128 * 1_024 * 1_024);
    expect(logicalBytes).toBeLessThanOrEqual(CODE_GRAPH_WORKSET_CATALOG_LIMITS.projectionBytesMaximum);
  });

  it('accepts the exact projection limit and rejects an already-over-limit accumulator', () => {
    const maximum = CODE_GRAPH_WORKSET_CATALOG_LIMITS.projectionBytesMaximum;
    expect(codeGraphWorksetRoutingProjectionLogicalBytesAppend(maximum, [])).toBe(maximum);
    let failure: unknown;
    try {
      codeGraphWorksetRoutingProjectionLogicalBytesAppend(maximum + 1, []);
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toMatchObject({reason: 'capacity'} satisfies Partial<CodeGraphWorksetCatalogError>);
  });

  effectIt.effect('preserves the independent 4 GiB aggregate projection capacity guard', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const system = yield* SystemInfo;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-workset-aggregate-capacity-'});
        const projectionMaximum = CODE_GRAPH_WORKSET_CATALOG_LIMITS.projectionBytesMaximum;
        const projectionSlots = CODE_GRAPH_WORKSET_CATALOG_LIMITS.catalogPhysicalBytesMaximum / projectionMaximum;
        expect(Number.isSafeInteger(projectionSlots)).toBe(true);
        const ampleDisk = SystemInfo.of({
          ...system,
          availableDiskBytes: () => Effect.succeed(Number.MAX_SAFE_INTEGER),
        });

        for (let index = 0; index < projectionSlots; index += 1) {
          const begun = yield* beginCodeGraphWorksetCatalogProjection(
            home,
            projectionReceipt(projection(10_000 + index)),
            projectionMaximum,
          ).pipe(Effect.provideService(SystemInfo, ampleDisk));
          expect(begun.state).toBe('staging');
        }
        const failure = yield* beginCodeGraphWorksetCatalogProjection(
          home,
          projectionReceipt(projection(20_000)),
          projectionMaximum,
        ).pipe(Effect.provideService(SystemInfo, ampleDisk), Effect.flip);
        expect(failure).toMatchObject({reason: 'capacity'} satisfies Partial<CodeGraphWorksetCatalogError>);

        const capacity = yield* Effect.sync(() => {
          const database = new Database(catalogPath(home), {readonly: true, strict: true});
          try {
            return database
              .query<{readonly projection_logical_bytes: number}, []>(
                'SELECT projection_logical_bytes FROM catalog_capacity WHERE singleton = 1',
              )
              .get()?.projection_logical_bytes;
          } finally {
            database.close(false);
          }
        });
        expect(capacity).toBe(CODE_GRAPH_WORKSET_CATALOG_LIMITS.catalogPhysicalBytesMaximum);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function calibratedProjectionSymbol(index: number): CodeGraphWorksetRoutingSymbolV1 {
  const padded = Effect2.pipe(index.toString(), EffectString.padStart(5, '0'));
  const lookupCount = index % 5 < 3 ? 3 : 2;
  const termCount = index % 100 < 46 ? 11 : 10;
  return {
    exported: index % 3 === 0,
    kind: 'function',
    language: 'typescript',
    lookupKeys: Array.from({length: lookupCount}, (_, key) => `workset.catalog.${padded}.lookup-${key}`),
    name: `prepareRoutingProjection${padded}`,
    nodeId: `cgs_${Effect2.pipe(digest(`calibrated-node-${index}`), EffectString.slice(0, 32))}`,
    packageName: 'threadnote',
    path: `src/workset/routing-${padded}.ts`,
    qualifiedName: `WorksetCatalog.prepareRoutingProjection${padded}`,
    span: {column: 1, endColumn: 48, endLine: index + 2, line: index + 1},
    terms: Array.from({length: termCount}, (_, term) => ({
      term: `routing-projection-${padded}-term-${Effect2.pipe(term.toString(), EffectString.padStart(2, '0'))}`,
      weight: 5 - (term % 5),
    })),
  };
}

async function temporaryHome(homes: string[]): Promise<string> {
  const home = await mkdtemp('threadnote-workset-catalog-');
  homes.push(home);
  return home;
}

async function publish(home: string, input: CodeGraphWorksetCatalogGenerationInputV1) {
  const staged = await runEffect(stageCodeGraphWorksetCatalogGeneration(home, input));
  return runEffect(
    publishCodeGraphWorksetCatalogGeneration(home, {
      generationId: staged.id,
      worksetName: input.worksetName,
    }),
  );
}

async function collectSymbols(home: string, worksetName: string) {
  const symbols = [];
  let after: {readonly nodeId: string; readonly ordinal: number} | undefined;
  for (;;) {
    const page = await runEffect(readCodeGraphWorksetCatalogRoutingSymbols(home, {after, limit: 2, worksetName}));
    if (page === undefined) return symbols;
    symbols.push(...page.symbols);
    if (page.next === undefined) return symbols;
    after = page.next;
  }
}

function generationInput(
  worksetName: string,
  manifestSeed: string,
  members: readonly CodeGraphWorksetCatalogGenerationMemberV1[],
): CodeGraphWorksetCatalogGenerationInputV1 {
  return {manifestDigest: digest(manifestSeed), members, worksetName};
}

function member(seed: number, repositoryKey: string): CodeGraphWorksetCatalogGenerationMemberV1 {
  return {projection: projection(seed), repositoryKey};
}

function projection(seed: number): CodeGraphWorksetRoutingProjectionV1 {
  return createCodeGraphWorksetRoutingProjection({
    checkoutId: digest(`checkout-${seed}`),
    commitId: Effect2.pipe(digest(`commit-${seed}`), EffectString.slice(0, 40)),
    componentCount: seed % 3,
    extractorGeneration: 12,
    projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
    repositoryId: digest(`repository-${seed}`),
    snapshotDigest: digest(`snapshot-digest-${seed}`),
    snapshotId: `cgsn_${Effect2.pipe(digest(`snapshot-${seed}`), EffectString.slice(0, 40))}`,
    symbols: [
      {
        exported: seed % 2 === 0,
        kind: 'function',
        language: 'typescript',
        lookupKeys: [`symbol.${seed}`, `exact.symbol.${seed}`],
        name: `symbol${seed}`,
        nodeId: `cgs_${Effect2.pipe(digest(`node-${seed}`), EffectString.slice(0, 40))}`,
        packageName: `@fixture/repository-${seed}`,
        path: `src/symbol-${seed}.ts`,
        qualifiedName: `fixture.symbol${seed}`,
        span: {column: 0, endColumn: 12, endLine: 1, line: 1},
        terms: [
          {term: `symbol-${seed}`, weight: 4},
          {term: 'fixture', weight: 1},
        ],
      },
    ],
    worktreeId: digest(`worktree-${seed}`),
  });
}

function projectionReceipt(projection: CodeGraphWorksetRoutingProjectionV1) {
  const {symbols, ...receipt} = projection;
  return {...receipt, symbolCount: symbols.length};
}

function catalogPath(home: string): string {
  return codeGraphWorksetCatalogDatabasePath(pathService, home);
}

function digest(value: string): string {
  return sha256HexSync(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
