import {Array as EffectArray} from 'effect';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {afterEach, describe, expect, it} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
  codeGraphEvidenceCardId,
  type CodeGraphEvidenceCardV1,
  type CodeGraphWorksetQueryResultV2,
} from '@threadnote/graph/workset/evidence';
import {codeGraphWorksetCatalogDatabasePath} from '@threadnote/graph/workset_catalog/layout';
import {createCodeGraphWorksetRoutingProjection} from '@threadnote/graph/workset_catalog/projection';
import {
  ensureCodeGraphWorksetCatalog,
  inspectCodeGraphWorksetCatalog,
  maintainCodeGraphWorksetCatalog,
  maintainCodeGraphWorksetResultSets,
  publishCodeGraphWorksetCatalogGeneration,
  readPublishedCodeGraphWorksetCatalogGeneration,
  readCodeGraphWorksetResultSetPage,
  registerCodeGraphQualifiedRef,
  registerCodeGraphWorksetResultSet,
  resolveCodeGraphQualifiedRef,
  stageCodeGraphWorksetCatalogGeneration,
} from '@threadnote/graph/workset_catalog/store';
import {
  CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
  CodeGraphWorksetCatalogError,
  type CodeGraphWorksetCatalogGenerationInputV1,
  type CodeGraphWorksetCatalogGenerationMemberV1,
  type CodeGraphWorksetResultSetPageV1,
  type CodeGraphWorksetRoutingProjectionV1,
} from '@threadnote/graph/workset_catalog/types';
import {pathService, mkdtemp, rm, stat} from '../helpers/effect-filesystem.js';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('code graph workset qualified refs and continuation', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(EffectArray.map(homes.splice(0), home => rm(home, {force: true, recursive: true})));
  });

  effectIt.effect('creates v4 before removing obsolete disposable v2 and v3 catalogs', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-workset-catalog-upgrade-'});
        const root = path.join(home, 'indexes', 'code-graph', 'worksets');
        yield* fs.makeDirectory(root, {recursive: true});
        const obsoleteDatabases = EffectArray.map([2, 3], version =>
          path.join(root, `catalog-v${String(version)}.sqlite`),
        );
        const obsoleteFiles = EffectArray.flatMap(obsoleteDatabases, databasePath => [
          databasePath,
          `${databasePath}-journal`,
          `${databasePath}-shm`,
          `${databasePath}-wal`,
        ]);

        for (const databasePath of obsoleteDatabases) {
          yield* Effect.sync(() => {
            const legacy = new Database(databasePath, {create: true, strict: true});
            try {
              legacy.exec('CREATE TABLE legacy_ready_projection (id TEXT PRIMARY KEY)');
              legacy.query('INSERT INTO legacy_ready_projection (id) VALUES (?)').run('pre-normalized-routing');
            } finally {
              legacy.close(false);
            }
          });
          for (const suffix of ['-journal', '-shm', '-wal']) {
            yield* fs.writeFile(`${databasePath}${suffix}`, new TextEncoder().encode('obsolete disposable sidecar'));
          }
        }

        yield* ensureCodeGraphWorksetCatalog(home);
        expect(catalogPath(home)).toBe(path.join(root, 'catalog-v4.sqlite'));
        for (const candidate of obsoleteFiles) expect(yield* fs.exists(candidate)).toBe(false);
        expect(yield* inspectCodeGraphWorksetCatalog(home)).toMatchObject({schemaVersion: 4, state: 'ok'});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('isolates cgr handles by repository while accepting every local node-id width', async () => {
    const home = await temporaryHome(homes);

    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({min: 0, max: 1_000_000}), {maxLength: 8, minLength: 1}),
        async seeds => {
          for (const seed of seeds) {
            const nodeHexLength = [32, 40, 64][seed % 3];
            const nodeId = `cgs_${Effect2.pipe(digest(`node:${seed}`), EffectString.slice(0, nodeHexLength))}`;
            const leftRepositoryId = digest(`left:${seed}`);
            const rightRepositoryId = digest(`right:${seed}`);
            const left = await runEffect(registerCodeGraphQualifiedRef(home, {nodeId, repositoryId: leftRepositoryId}));
            const repeated = await runEffect(
              registerCodeGraphQualifiedRef(home, {nodeId, repositoryId: leftRepositoryId}),
            );
            const right = await runEffect(
              registerCodeGraphQualifiedRef(home, {nodeId, repositoryId: rightRepositoryId}),
            );

            expect(repeated).toEqual(left);
            expect(right.ref).not.toBe(left.ref);
            expect(await runEffect(resolveCodeGraphQualifiedRef(home, {ref: left.ref}))).toMatchObject({
              nodeId,
              repositoryId: leftRepositoryId,
            });
            await expect(
              runEffect(resolveCodeGraphQualifiedRef(home, {ref: left.ref, repositoryId: rightRepositoryId})),
            ).rejects.toMatchObject({reason: 'missing'} satisfies Partial<CodeGraphWorksetCatalogError>);
          }
        },
      ),
      {numRuns: 12},
    );

    const productionWidthNode = `cgs_${Effect2.pipe(digest('production-width-node'), EffectString.slice(0, 32))}`;
    await publish(
      home,
      generationInput('node-width', 'node-width-manifest', [
        member({nodeId: productionWidthNode, repositoryKey: 'production-width', seed: 4}),
      ]),
    );

    if (process.platform !== 'win32') expect((await stat(catalogPath(home))).mode & 0o777).toBe(0o600);
  });

  it('runs the final publication fence before and not after the atomic pointer swap', async () => {
    const home = await temporaryHome(homes);
    const input = generationInput('engineering', 'manifest-fence', [member({repositoryKey: 'repository', seed: 5})]);
    const staged = await runEffect(stageCodeGraphWorksetCatalogGeneration(home, input));
    let calls = 0;

    await expect(
      runEffect(
        publishCodeGraphWorksetCatalogGeneration(home, {
          beforePointerSwap: () =>
            Effect.sync(() => {
              calls += 1;
            }).pipe(Effect.andThen(Effect.fail(CodeGraphWorksetCatalogError.of('stale', 'snapshot lease changed')))),
          generationId: staged.id,
          worksetName: 'engineering',
        }),
      ),
    ).rejects.toMatchObject({reason: 'stale'} satisfies Partial<CodeGraphWorksetCatalogError>);
    expect(calls).toBe(1);
    expect(await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'engineering'))).toBeUndefined();

    await runEffect(
      publishCodeGraphWorksetCatalogGeneration(home, {
        beforePointerSwap: () => Effect.sync(() => void (calls += 1)),
        generationId: staged.id,
        worksetName: 'engineering',
      }),
    );
    expect(calls).toBe(2);
    expect((await runEffect(readPublishedCodeGraphWorksetCatalogGeneration(home, 'engineering')))?.id).toBe(staged.id);
  });

  it('pages one pinned ranked sequence across a newer publication and reports exact cursor failures', async () => {
    const home = await temporaryHome(homes);
    const repositoryId = digest('shared-repository');
    const nodeId = `cgs_${Effect2.pipe(digest('shared-node'), EffectString.slice(0, 40))}`;
    const left = member({nodeId, repositoryId, repositoryKey: 'left', seed: 1});
    const right = member({nodeId, repositoryId, repositoryKey: 'right', seed: 2});
    const generation = await publish(home, generationInput('engineering', 'manifest-a', [left, right]));
    const qualified = await runEffect(registerCodeGraphQualifiedRef(home, {nodeId, repositoryId}));
    const cards = [evidenceCard(qualified.ref, left), evidenceCard(qualified.ref, right)];
    const registered = await runEffect(
      registerCodeGraphWorksetResultSet(home, {
        projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
        result: worksetResult(cards, generation, [left, right]),
      }),
    );

    const first = await runEffect(
      readCodeGraphWorksetResultSetPage(home, {cursor: registered.initialCursor, limit: 1}),
    );
    expect(first.cards).toEqual(cards.slice(0, 1));
    expect(first.result).toMatchObject({
      cards: cards.slice(0, 1),
      coverage: {requestedRepositories: 2},
      warnings: ['fixture envelope receipt'],
    });
    expect(EffectRecord.keys(first.result.repositories).sort()).toEqual(['left', 'right']);
    expect(first.next).toBe(registered.continuationForOffset(1));
    expect(first.continuationForOffset(2)).toBe(registered.continuationForOffset(2));
    const second = await runEffect(readCodeGraphWorksetResultSetPage(home, {cursor: first.next!, limit: 1}));
    expect(second.cards).toEqual(cards.slice(1));
    expect(second.next).toBeUndefined();

    const raw = new Database(catalogPath(home), {readonly: true, strict: true});
    try {
      const stored = raw
        .query<{readonly card_json: string}, []>('SELECT card_json FROM result_cards ORDER BY ordinal')
        .all();
      expect(stored).toHaveLength(2);
      expect(
        EffectArray.every(
          stored,
          row =>
            !Effect2.pipe(row.card_json, EffectString.includes('source')) &&
            !Effect2.pipe(row.card_json, EffectString.includes('documentation')),
        ),
      ).toBe(true);
    } finally {
      raw.close(false);
    }
    await expect(
      runEffect(
        registerCodeGraphWorksetResultSet(home, {
          projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
          // @ts-expect-error This rejection fixture deliberately gives a valid card the invalid source field to test input validation.
          result: worksetResult([{...cards[0], source: 'must never persist'}], generation, [left, right]),
        }),
      ),
    ).rejects.toMatchObject({reason: 'invalid-input'} satisfies Partial<CodeGraphWorksetCatalogError>);

    const replacement = await publish(
      home,
      generationInput('engineering', 'manifest-b', [member({repositoryKey: 'new', seed: 3})]),
    );
    for (let page = 0; page < 64; page += 1) {
      await runEffect(maintainCodeGraphWorksetCatalog(home, {generationLimit: 10, projectionLimit: 10}));
      const rawMaintenance = new Database(catalogPath(home), {readonly: true, strict: true});
      try {
        const memberCount = rawMaintenance
          .query<{readonly count: number}, [string]>(
            'SELECT COUNT(*) AS count FROM workset_generation_members WHERE generation_id = ?',
          )
          .get(generation.id)!.count;
        const projectionCount = rawMaintenance
          .query<{readonly count: number}, [string, string]>(
            'SELECT COUNT(*) AS count FROM repository_snapshots WHERE projection_digest IN (?, ?)',
          )
          .get(left.projection.projectionDigest, right.projection.projectionDigest)!.count;
        const storedMemberCount = rawMaintenance
          .query<{readonly member_count: number}, [string]>('SELECT member_count FROM workset_generations WHERE id = ?')
          .get(generation.id)!.member_count;
        if (memberCount === 0 && projectionCount === 0 && storedMemberCount === 0) break;
      } finally {
        rawMaintenance.close(false);
      }
    }
    const compacted = new Database(catalogPath(home), {readonly: true, strict: true});
    try {
      expect(
        compacted
          .query<{readonly member_count: number; readonly state: string}, [string]>(
            'SELECT member_count, state FROM workset_generations WHERE id = ?',
          )
          .get(generation.id),
      ).toEqual({member_count: 0, state: 'retired'});
      expect(
        compacted
          .query<{readonly count: number}, [string]>(
            'SELECT COUNT(*) AS count FROM workset_generation_members WHERE generation_id = ?',
          )
          .get(generation.id)?.count,
      ).toBe(0);
      expect(
        compacted
          .query<{readonly count: number}, [string, string]>(
            'SELECT COUNT(*) AS count FROM repository_snapshots WHERE projection_digest IN (?, ?)',
          )
          .get(left.projection.projectionDigest, right.projection.projectionDigest)?.count,
      ).toBe(0);
    } finally {
      compacted.close(false);
    }
    expect(
      (await runEffect(readCodeGraphWorksetResultSetPage(home, {cursor: registered.initialCursor}))).cards,
    ).toEqual(cards);
    await expect(
      runEffect(
        readCodeGraphWorksetResultSetPage(home, {
          cursor: registered.initialCursor,
          expectedGeneration: {digest: replacement.digest, id: replacement.id},
        }),
      ),
    ).rejects.toMatchObject({reason: 'stale'} satisfies Partial<CodeGraphWorksetCatalogError>);
    await expect(
      runEffect(
        readCodeGraphWorksetResultSetPage(home, {
          cursor: registered.initialCursor,
          expectedProjectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION + 1,
        }),
      ),
    ).rejects.toMatchObject({reason: 'incompatible'} satisfies Partial<CodeGraphWorksetCatalogError>);
    await expect(
      runEffect(
        readCodeGraphWorksetResultSetPage(home, {cursor: `cgwc_${Effect2.pipe('f', EffectString.repeat(40))}`}),
      ),
    ).rejects.toMatchObject({reason: 'missing'} satisfies Partial<CodeGraphWorksetCatalogError>);

    const database = new Database(catalogPath(home), {strict: true});
    try {
      const sequenceDigest = database
        .query<{readonly sequence_digest: string}, [string]>('SELECT sequence_digest FROM result_sets WHERE id = ?')
        .get(registered.id)!.sequence_digest;
      database
        .query('UPDATE result_sets SET sequence_digest = ? WHERE id = ?')
        .run(Effect2.pipe('0', EffectString.repeat(64)), registered.id);
      await expect(
        runEffect(readCodeGraphWorksetResultSetPage(home, {cursor: registered.initialCursor})),
      ).rejects.toMatchObject({reason: 'corrupt'} satisfies Partial<CodeGraphWorksetCatalogError>);
      database.query('UPDATE result_sets SET sequence_digest = ? WHERE id = ?').run(sequenceDigest, registered.id);
      database
        .query('UPDATE result_sets SET expires_at = ? WHERE id = ?')
        .run('2000-01-01T00:00:00.000Z', registered.id);
    } finally {
      database.close(false);
    }
    await expect(
      runEffect(readCodeGraphWorksetResultSetPage(home, {cursor: registered.initialCursor})),
    ).rejects.toMatchObject({reason: 'expired'} satisfies Partial<CodeGraphWorksetCatalogError>);
    await runEffect(maintainCodeGraphWorksetResultSets(home, {limit: 1, now: '2026-01-01T00:00:00.000Z'}));
    const afterExpiry = new Database(catalogPath(home), {readonly: true, strict: true});
    try {
      expect(
        afterExpiry
          .query<{readonly count: number}, [string]>('SELECT COUNT(*) AS count FROM workset_generations WHERE id = ?')
          .get(generation.id)?.count,
      ).toBe(0);
      expect(
        afterExpiry
          .query<{readonly count: number}, [string]>('SELECT COUNT(*) AS count FROM workset_generations WHERE id = ?')
          .get(replacement.id)?.count,
      ).toBe(1);
    } finally {
      afterExpiry.close(false);
    }
  });

  it('concatenates bounded keyset pages to the original globally ranked card order', async () => {
    const home = await temporaryHome(homes);
    const count = 36;
    const inputMember = member({repositoryKey: 'repository', seed: 20, symbolCount: count});
    const generation = await publish(home, generationInput('engineering', 'manifest-property', [inputMember]));
    const cards: CodeGraphEvidenceCardV1[] = [];
    for (let index = 0; index < count; index += 1) {
      const nodeId = inputMember.projection.symbols[index].nodeId;
      const qualified = await runEffect(
        registerCodeGraphQualifiedRef(home, {nodeId, repositoryId: inputMember.projection.repositoryId}),
      );
      cards.push(evidenceCard(qualified.ref, inputMember, index));
    }
    const registered = await runEffect(
      registerCodeGraphWorksetResultSet(home, {
        projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
        result: worksetResult(cards, generation, [inputMember]),
      }),
    );

    await fc.assert(
      fc.asyncProperty(fc.integer({min: 1, max: 17}), async limit => {
        const collected: CodeGraphEvidenceCardV1[] = [];
        let cursor: string | undefined = registered.initialCursor;
        while (cursor !== undefined) {
          const page: CodeGraphWorksetResultSetPageV1 = await runEffect(
            readCodeGraphWorksetResultSetPage(home, {cursor, limit}),
          );
          collected.push(...page.cards);
          cursor = page.next;
        }
        expect(collected).toEqual(cards);
      }),
      {numRuns: 30},
    );
  });

  it('prunes expired result sets in explicit bounded pages', async () => {
    const home = await temporaryHome(homes);
    const inputMember = member({repositoryKey: 'repository', seed: 50});
    const generation = await publish(home, generationInput('engineering', 'manifest-maintenance', [inputMember]));
    const qualified = await runEffect(
      registerCodeGraphQualifiedRef(home, {
        nodeId: inputMember.projection.symbols[0].nodeId,
        repositoryId: inputMember.projection.repositoryId,
      }),
    );
    const card = evidenceCard(qualified.ref, inputMember);
    const registrations = [];
    for (let index = 0; index < 3; index += 1) {
      registrations.push(
        await runEffect(
          registerCodeGraphWorksetResultSet(home, {
            projectorVersion: CODE_GRAPH_WORKSET_EVIDENCE_PROJECTOR_VERSION,
            result: worksetResult([{...card, reason: {...card.reason, summary: `rank receipt ${index}`}}], generation, [
              inputMember,
            ]),
          }),
        ),
      );
    }
    const database = new Database(catalogPath(home), {strict: true});
    try {
      database.query('UPDATE result_sets SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
    } finally {
      database.close(false);
    }

    expect(
      await runEffect(maintainCodeGraphWorksetResultSets(home, {limit: 1, now: '2026-01-01T00:00:00.000Z'})),
    ).toMatchObject({expiredResultSetsDeleted: 1, remainingResultSets: 2});
    await expect(
      runEffect(readCodeGraphWorksetResultSetPage(home, {cursor: registrations[0].initialCursor})),
    ).rejects.toMatchObject({reason: 'missing'} satisfies Partial<CodeGraphWorksetCatalogError>);
  });
});

async function temporaryHome(homes: string[]): Promise<string> {
  const home = await mkdtemp('threadnote-workset-continuation-');
  homes.push(home);
  return home;
}

async function publish(home: string, input: CodeGraphWorksetCatalogGenerationInputV1) {
  const staged = await runEffect(stageCodeGraphWorksetCatalogGeneration(home, input));
  await runEffect(
    publishCodeGraphWorksetCatalogGeneration(home, {generationId: staged.id, worksetName: input.worksetName}),
  );
  return {digest: staged.digest, id: staged.id};
}

function generationInput(
  worksetName: string,
  manifestSeed: string,
  members: readonly CodeGraphWorksetCatalogGenerationMemberV1[],
): CodeGraphWorksetCatalogGenerationInputV1 {
  return {manifestDigest: digest(manifestSeed), members, worksetName};
}

function member(options: {
  readonly nodeId?: string;
  readonly repositoryId?: string;
  readonly repositoryKey: string;
  readonly seed: number;
  readonly symbolCount?: number;
}): CodeGraphWorksetCatalogGenerationMemberV1 {
  return {projection: projection(options), repositoryKey: options.repositoryKey};
}

function projection(options: {
  readonly nodeId?: string;
  readonly repositoryId?: string;
  readonly seed: number;
  readonly symbolCount?: number;
}): CodeGraphWorksetRoutingProjectionV1 {
  const {seed} = options;
  return createCodeGraphWorksetRoutingProjection({
    checkoutId: digest(`checkout-${seed}`),
    commitId: Effect2.pipe(digest(`commit-${seed}`), EffectString.slice(0, 40)),
    componentCount: 1,
    extractorGeneration: 12,
    projectorVersion: CODE_GRAPH_WORKSET_CATALOG_PROJECTOR_VERSION,
    repositoryId: options.repositoryId ?? digest(`repository-${seed}`),
    snapshotDigest: digest(`snapshot-digest-${seed}`),
    snapshotId: `cgsn_${Effect2.pipe(digest(`snapshot-${seed}`), EffectString.slice(0, 40))}`,
    symbols: Array.from({length: options.symbolCount ?? 1}, (_, index) => ({
      exported: true,
      kind: 'function',
      language: 'typescript',
      lookupKeys: [`fixture.symbol.${seed}.${index}`],
      name: `symbol${seed}_${index}`,
      nodeId: options.nodeId ?? `cgs_${Effect2.pipe(digest(`node-${seed}-${index}`), EffectString.slice(0, 40))}`,
      packageName: '@fixture/package',
      path: `src/symbol-${seed}-${index}.ts`,
      qualifiedName: `fixture.symbol${seed}_${index}`,
      span: {column: 0, endColumn: 10, endLine: 1, line: 1},
      terms: [{term: `symbol-${seed}-${index}`, weight: 4}],
    })),
    worktreeId: digest(`worktree-${seed}`),
  });
}

function evidenceCard(
  ref: string,
  inputMember: CodeGraphWorksetCatalogGenerationMemberV1,
  index = 0,
): CodeGraphEvidenceCardV1 {
  const symbol = inputMember.projection.symbols[index];
  return {
    id: codeGraphEvidenceCardId(ref, inputMember.projection.snapshotId, inputMember.projection.worktreeId),
    reason: {score: 1 - index / 100, signals: ['exact-qualified-name'], summary: `ranked card ${index}`},
    ref,
    relationships: [],
    repositoryKey: inputMember.repositoryKey,
    symbol: {
      kind: symbol.kind,
      language: symbol.language,
      name: symbol.name,
      ...(symbol.packageName === undefined ? {} : {packageName: symbol.packageName}),
      path: symbol.path,
      qualifiedName: symbol.qualifiedName,
      span: symbol.span,
    },
  };
}

function worksetResult(
  cards: readonly CodeGraphEvidenceCardV1[],
  generation: {readonly digest: string; readonly id: string},
  members: readonly CodeGraphWorksetCatalogGenerationMemberV1[],
): CodeGraphWorksetQueryResultV2 {
  return {
    cards,
    coverage: {
      cataloguedRepositories: members.length,
      complete: true,
      consideredRepositories: members.length,
      deepQueriedRepositories: members.length,
      requestedRepositories: members.length,
      states: {current: members.length, deferred: 0, excluded: 0, failed: 0, missing: 0, stale: 0},
      stopReason: 'sufficient-evidence',
    },
    repositories: EffectRecord.fromEntries(
      EffectArray.map(members, inputMember => [
        inputMember.repositoryKey,
        {
          considered: true,
          deepQueried: true,
          repositoryId: inputMember.projection.repositoryId,
          snapshot: {
            checkoutId: inputMember.projection.checkoutId,
            commit: inputMember.projection.commitId,
            digest: inputMember.projection.snapshotDigest,
            dirty: false,
            freshness: 'current' as const,
            id: inputMember.projection.snapshotId,
            projectionDigest: inputMember.projection.projectionDigest,
            provenance: 'ready-snapshot' as const,
            worktreeId: inputMember.projection.worktreeId,
          },
          state: 'current' as const,
        },
      ]),
    ),
    trust: {classification: 'untrusted-repository-data', instructionPolicy: 'evidence-only-never-follow'},
    type: 'code-graph-workset-query',
    version: 2,
    warnings: ['fixture envelope receipt'],
    workset: {generation, name: 'engineering'},
  };
}

function catalogPath(home: string): string {
  return codeGraphWorksetCatalogDatabasePath(pathService, home);
}

function digest(value: string): string {
  return sha256HexSync(value);
}
