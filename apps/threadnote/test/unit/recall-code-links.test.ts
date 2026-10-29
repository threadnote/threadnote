import {Array as EffectArray} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {
  createMemoryCodeCitation,
  MEMORY_SCHEMA_VERSION,
  type MemoryCodeCitationV1,
} from '@threadnote/memory/code/citation';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {
  buildBoundedRecallCodeLinkRawQueries,
  deriveRecallCodeLinkQuerySelectors,
  type RecallCodeLinkQuerySelector,
} from '@threadnote/recall/code_links';
import {loadRecallCodeLinks, loadRecallIndexData, recallIndexDatabaseFilename} from '@threadnote/recall/index';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

describe('recall code links', () => {
  effectIt.effect('queries opaque selectors with deterministic bounds and document authorization', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-code-links-'});
      const user = 'link-user';
      const repositoryId = Effect2.pipe('a', EffectString.repeat(64));
      const symbol = citation({repositoryId, symbolSeed: '1'});
      const file = citation({repositoryId, symbolSeed: undefined});
      const foreignRepository = citation({repositoryId: Effect2.pipe('b', EffectString.repeat(64)), symbolSeed: '1'});

      yield* writeMemory(fs, path, home, user, 'threadnote', 'symbol-memory', [symbol]);
      yield* writeMemory(fs, path, home, user, 'threadnote', 'file-memory', [file]);
      yield* writeMemory(fs, path, home, user, 'other-project', 'other-memory', [symbol]);
      yield* writeMemory(fs, path, home, user, 'threadnote', 'foreign-repository', [foreignRepository]);
      yield* writeMemory(fs, path, home, user, 'threadnote', 'archived-memory', [symbol], true);

      const config = {account: 'local', agentContextHome: home, user};
      const first = yield* loadRecallCodeLinks(config, {
        anchors: [symbol],
        forceRefresh: true,
        includeInactive: false,
        limit: 24,
        project: 'threadnote',
      });
      const second = yield* loadRecallCodeLinks(config, {
        anchors: [symbol],
        includeInactive: false,
        limit: 24,
        project: 'threadnote',
      });

      expect(second).toEqual(first);
      expect(EffectArray.map(first, match => [match.matchKind, match.uri])).toEqual([
        ['symbol-node', `threadnote://user/${user}/memories/durable/projects/threadnote/symbol-memory.md`],
        ['file-path', `threadnote://user/${user}/memories/durable/projects/threadnote/file-memory.md`],
      ]);
      expect(
        yield* loadRecallCodeLinks(config, {
          anchors: [symbol],
          includeInactive: false,
          limit: 1,
          project: 'threadnote',
        }),
      ).toEqual(first.slice(0, 1));

      const rows = yield* Effect.sync(() => {
        const database = new Database(path.join(home, 'indexes', 'lexical', recallIndexDatabaseFilename(false)), {
          readonly: true,
        });
        try {
          return database
            .query<{readonly selector_digest: string; readonly selector_kind: string}, SQLQueryBindings[]>(
              'SELECT selector_kind, selector_digest FROM code_links ORDER BY selector_kind, selector_digest',
            )
            .all();
        } finally {
          database.close();
        }
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(EffectArray.every(rows, row => /^[0-9a-f]{64}$/u.test(row.selector_digest))).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(symbol.repositoryId);
      expect(JSON.stringify(rows)).not.toContain(symbol.path);
      expect(JSON.stringify(rows)).not.toContain(symbol.target.kind === 'symbol' ? symbol.target.nodeId : '');
      expect(
        yield* Effect.sync(() => {
          const database = new Database(path.join(home, 'indexes', 'lexical', recallIndexDatabaseFilename(false)), {
            readonly: true,
          });
          try {
            return EffectArray.map(
              database.query<{readonly name: string}, []>('PRAGMA index_info(code_links_selector_uri)').all(),
              row => row.name,
            );
          } finally {
            database.close();
          }
        }),
      ).toEqual(['selector_kind', 'selector_digest', 'document_uri', 'citation_ordinal', 'document_id']);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('transactionally replaces and removes inverse selectors during incremental refresh', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-code-links-refresh-'});
      const user = 'refresh-user';
      const repositoryId = Effect2.pipe('c', EffectString.repeat(64));
      const original = citation({repositoryId, symbolSeed: '2'});
      const replacement = citation({repositoryId, path: 'src/replacement.ts', symbolSeed: '3'});
      const memoryPath = yield* writeMemory(fs, path, home, user, 'threadnote', 'replace-me', [original]);
      const config = {account: 'local', agentContextHome: home, user};

      expect(
        yield* loadRecallCodeLinks(config, {
          anchors: [original],
          forceRefresh: true,
          includeInactive: false,
        }),
      ).toHaveLength(1);

      yield* writeMemory(fs, path, home, user, 'threadnote', 'replace-me', [replacement]);
      expect(
        yield* loadRecallCodeLinks(config, {
          anchors: [original],
          forceRefresh: true,
          includeInactive: false,
        }),
      ).toEqual([]);
      expect(
        yield* loadRecallCodeLinks(config, {
          anchors: [replacement],
          includeInactive: false,
        }),
      ).toEqual([
        expect.objectContaining({
          citationId: replacement.id,
          matchKind: 'symbol-node',
        }),
      ]);

      yield* fs.remove(memoryPath);
      expect(
        yield* loadRecallCodeLinks(config, {
          anchors: [replacement],
          forceRefresh: true,
          includeInactive: false,
        }),
      ).toEqual([]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('hashes citation generations identically across cursor pages and source insertion order', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const roots = yield* Effect.all(
        [
          fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-code-links-generation-a-'}),
          fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-code-links-generation-b-'}),
        ],
        {concurrency: 2},
      );
      const user = 'generation-user';
      const anchor = citation({repositoryId: Effect2.pipe('1', EffectString.repeat(64)), symbolSeed: 'a'});
      const documentIndexes = Array.from({length: 70}, (_, index) => index);
      for (const [rootIndex, home] of roots.entries()) {
        const order = rootIndex === 0 ? documentIndexes : [...documentIndexes].reverse();
        yield* Effect.forEach(
          order,
          index =>
            writeMemory(
              fs,
              path,
              home,
              user,
              'threadnote',
              `generation-${Effect2.pipe(String(index), EffectString.padStart(3, '0'))}`,
              [anchor],
            ),
          {concurrency: 8, discard: true},
        );
      }

      const generations = yield* Effect.forEach(
        roots,
        home =>
          loadRecallIndexData(
            {account: 'local', agentContextHome: home, user},
            {forceRefresh: true, includeInactive: false},
          ).pipe(Effect.map(index => index.generation)),
        {concurrency: 2},
      );
      expect(generations[0]).toBe(generations[1]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('applies URI authorization before the bounded reverse-link window', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-code-links-scope-'});
      const user = 'scope-user';
      const anchor = citation({repositoryId: Effect2.pipe('4', EffectString.repeat(64)), symbolSeed: '4'});
      for (let index = 0; index < 8; index += 1) {
        yield* writeResourceMemory(fs, path, home, `resource-${index}`, anchor);
      }
      yield* writeMemory(fs, path, home, user, 'threadnote', 'zzz-user-memory', [anchor]);
      const config = {account: 'local', agentContextHome: home, user};

      const unscoped = yield* loadRecallCodeLinks(config, {
        anchors: [anchor],
        forceRefresh: true,
        includeInactive: false,
        limit: 1,
        project: 'threadnote',
      });
      const scoped = yield* loadRecallCodeLinks(config, {
        allowedUriScopes: [`threadnote://user/${user}/memories`],
        anchors: [anchor],
        includeInactive: false,
        limit: 1,
        project: 'threadnote',
      });

      expect(unscoped[0]?.uri).toMatch(/^threadnote:\/\/resources\//u);
      expect(scoped).toEqual([
        expect.objectContaining({
          uri: `threadnote://user/${user}/memories/durable/projects/threadnote/zzz-user-memory.md`,
        }),
      ]);

      const selector = deriveRecallCodeLinkQuerySelectors([anchor])[0];
      const queries = buildBoundedRecallCodeLinkRawQueries(selector, [`threadnote://user/${user}/memories`], 5);
      const plans = yield* Effect.sync(() => {
        const database = new Database(path.join(home, 'indexes', 'lexical', recallIndexDatabaseFilename(false)), {
          readonly: true,
        });
        try {
          return EffectArray.map(queries, query =>
            EffectArray.join(
              EffectArray.map(
                database
                  .query<{readonly detail: string}, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${query.sql}`)
                  .all(...query.params),
                row => row.detail,
              ),
              '\n',
            ),
          );
        } finally {
          database.close();
        }
      });
      expect(plans).toHaveLength(2);
      expect(plans[0]).toMatch(/code_links_selector_uri .*document_uri=\?/u);
      expect(plans[1]).toMatch(/code_links_selector_uri .*document_uri>\? AND document_uri<\?/u);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refreshes once when citation order changes after index validation', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-code-links-race-'});
      const user = 'race-user';
      const repositoryId = Effect2.pipe('9', EffectString.repeat(64));
      const firstCitation = citation({repositoryId, path: 'src/first.ts', symbolSeed: '5'});
      const secondCitation = citation({repositoryId, path: 'src/second.ts', symbolSeed: '6'});
      yield* writeMemory(fs, path, home, user, 'threadnote', 'reordered', [firstCitation, secondCitation]);
      const config = {account: 'local', agentContextHome: home, user};

      expect(
        yield* loadRecallCodeLinks(config, {
          anchors: [firstCitation],
          forceRefresh: true,
          includeInactive: false,
        }),
      ).toEqual([expect.objectContaining({citationId: firstCitation.id, citationOrdinal: 0})]);

      yield* writeMemory(fs, path, home, user, 'threadnote', 'reordered', [secondCitation, firstCitation]);
      expect(
        yield* loadRecallCodeLinks(config, {
          anchors: [firstCitation],
          includeInactive: false,
        }),
      ).toEqual([expect.objectContaining({citationId: firstCitation.id, citationOrdinal: 1})]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('round-robins bounded results across anchors before admitting additional matches', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-code-links-fairness-'});
      const user = 'fairness-user';
      const repositoryId = Effect2.pipe('8', EffectString.repeat(64));
      const anchors = Array.from({length: 8}, (_, index) =>
        citation({repositoryId, symbolSeed: Effect2.pipe((index + 1).toString(16), EffectString.padStart(2, '0'))}),
      );
      for (let index = 0; index < 8; index += 1) {
        yield* writeMemory(fs, path, home, user, 'threadnote', `anchor-zero-${index}`, [anchors[0]]);
      }
      for (let index = 1; index < anchors.length; index += 1) {
        yield* writeMemory(fs, path, home, user, 'threadnote', `anchor-${index}`, [anchors[index]]);
      }
      const config = {account: 'local', agentContextHome: home, user};

      const matches = yield* loadRecallCodeLinks(config, {
        anchors,
        forceRefresh: true,
        includeInactive: false,
        limit: 8,
        project: 'threadnote',
      });

      expect(matches).toHaveLength(8);
      expect(new Set(EffectArray.map(matches, match => match.anchorOrdinal))).toEqual(
        new Set([0, 1, 2, 3, 4, 5, 6, 7]),
      );
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('bounds shadowed raw prefixes and reports abstention instead of scanning for a deep winner', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-code-links-shadow-'});
      const user = 'shadow-user';
      const repositoryId = Effect2.pipe('3', EffectString.repeat(64));
      const fileAnchor = citation({repositoryId, symbolSeed: undefined});
      const symbolAnchor = citation({repositoryId, symbolSeed: 'e'});
      for (let index = 0; index < 12; index += 1) {
        yield* writeMemory(
          fs,
          path,
          home,
          user,
          'threadnote',
          `aaa-symbol-shadow-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
          [symbolAnchor],
        );
      }
      yield* writeMemory(fs, path, home, user, 'threadnote', 'zzz-file-only', [fileAnchor]);

      let truncatedSelectorCount = 0;
      const bounded = yield* loadRecallCodeLinks(
        {account: 'local', agentContextHome: home, user},
        {
          anchors: [fileAnchor, symbolAnchor],
          forceRefresh: true,
          includeInactive: false,
          limit: 2,
          onSearchTruncated: count => {
            truncatedSelectorCount += count;
          },
          project: 'threadnote',
        },
      );

      expect(bounded).toEqual([
        expect.objectContaining({anchorOrdinal: 1, matchKind: 'symbol-node'}),
        expect.objectContaining({anchorOrdinal: 1, matchKind: 'symbol-node'}),
      ]);
      expect(
        EffectArray.some(bounded, match => Effect2.pipe(match.uri, EffectString.endsWith('/zzz-file-only.md'))),
      ).toBe(false);
      expect(truncatedSelectorCount).toBe(2);

      let expandedTruncatedSelectorCount = 0;
      const expanded = yield* loadRecallCodeLinks(
        {account: 'local', agentContextHome: home, user},
        {
          anchors: [fileAnchor, symbolAnchor],
          includeInactive: false,
          limit: 24,
          onSearchTruncated: count => {
            expandedTruncatedSelectorCount += count;
          },
          project: 'threadnote',
        },
      );
      expect(expanded).toContainEqual(
        expect.objectContaining({
          anchorOrdinal: 0,
          matchKind: 'file-path',
          uri: `threadnote://user/${user}/memories/durable/projects/threadnote/zzz-file-only.md`,
        }),
      );
      expect(expandedTruncatedSelectorCount).toBe(0);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('backfills a bounded result when a stale index row fails canonical reread', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-code-links-backfill-'});
      const user = 'backfill-user';
      const repositoryId = Effect2.pipe('7', EffectString.repeat(64));
      const anchor = citation({repositoryId, symbolSeed: '7'});
      const replacement = citation({repositoryId, path: 'src/replacement.ts', symbolSeed: '8'});
      yield* writeMemory(fs, path, home, user, 'threadnote', 'aaa-stale', [anchor]);
      yield* writeMemory(fs, path, home, user, 'threadnote', 'zzz-valid', [anchor]);
      const config = {account: 'local', agentContextHome: home, user};

      expect(
        yield* loadRecallCodeLinks(config, {
          anchors: [anchor],
          forceRefresh: true,
          includeInactive: false,
          limit: 1,
          project: 'threadnote',
        }),
      ).toHaveLength(1);

      yield* writeMemory(fs, path, home, user, 'threadnote', 'aaa-stale', [replacement]);
      expect(
        yield* loadRecallCodeLinks(config, {
          anchors: [anchor],
          includeInactive: false,
          limit: 1,
          project: 'threadnote',
        }),
      ).toEqual([
        expect.objectContaining({
          uri: `threadnote://user/${user}/memories/durable/projects/threadnote/zzz-valid.md`,
        }),
      ]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refreshes past more stale citations than the bounded scan window', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-code-links-deep-backfill-'});
      const user = 'deep-backfill-user';
      const repositoryId = Effect2.pipe('6', EffectString.repeat(64));
      const anchor = citation({repositoryId, symbolSeed: '6'});
      const replacement = citation({repositoryId, path: 'src/replacement.ts', symbolSeed: '5'});
      for (let index = 0; index < 5; index += 1) {
        yield* writeMemory(fs, path, home, user, 'threadnote', `aaa-stale-${index}`, [anchor]);
      }
      yield* writeMemory(fs, path, home, user, 'threadnote', 'zzz-valid', [anchor]);
      const config = {account: 'local', agentContextHome: home, user};
      expect(
        yield* loadRecallCodeLinks(config, {
          anchors: [anchor],
          forceRefresh: true,
          includeInactive: false,
          limit: 1,
          project: 'threadnote',
        }),
      ).toHaveLength(1);

      for (let index = 0; index < 5; index += 1) {
        yield* writeMemory(fs, path, home, user, 'threadnote', `aaa-stale-${index}`, [replacement]);
      }
      expect(
        yield* loadRecallCodeLinks(config, {
          anchors: [anchor],
          includeInactive: false,
          limit: 1,
          project: 'threadnote',
        }),
      ).toEqual([
        expect.objectContaining({
          uri: `threadnote://user/${user}/memories/durable/projects/threadnote/zzz-valid.md`,
        }),
      ]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('refreshes stale lifecycle state and reports a bounded inactive-prefix abstention', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-code-links-lifecycle-race-'});
      const user = 'lifecycle-race-user';
      const repositoryId = Effect2.pipe('5', EffectString.repeat(64));
      const anchor = citation({repositoryId, symbolSeed: '4'});
      const stalePaths = yield* Effect.forEach(
        Array.from({length: 5}),
        (_, index) => writeMemory(fs, path, home, user, 'threadnote', `aaa-inactive-${index}`, [anchor]),
        {concurrency: 1},
      );
      yield* writeMemory(fs, path, home, user, 'threadnote', 'zzz-active', [anchor]);
      const config = {account: 'local', agentContextHome: home, user};
      expect(
        yield* loadRecallCodeLinks(config, {
          anchors: [anchor],
          forceRefresh: true,
          includeInactive: false,
          limit: 1,
          project: 'threadnote',
        }),
      ).toHaveLength(1);

      yield* Effect.forEach(
        stalePaths,
        stalePath =>
          fs
            .readFileString(stalePath)
            .pipe(
              Effect.flatMap(content =>
                fs.writeFileString(
                  stalePath,
                  Effect2.pipe(content, EffectString.replace('status: active', 'status: archived')),
                ),
              ),
            ),
        {concurrency: 1, discard: true},
      );
      let truncatedSelectorCount = 0;
      expect(
        yield* loadRecallCodeLinks(config, {
          anchors: [anchor],
          includeInactive: false,
          limit: 1,
          onSearchTruncated: count => {
            truncatedSelectorCount += count;
          },
          project: 'threadnote',
        }),
      ).toEqual([]);
      expect(truncatedSelectorCount).toBe(4);

      let expandedTruncatedSelectorCount = 0;
      expect(
        yield* loadRecallCodeLinks(config, {
          anchors: [anchor],
          includeInactive: false,
          limit: 2,
          onSearchTruncated: count => {
            expandedTruncatedSelectorCount += count;
          },
          project: 'threadnote',
        }),
      ).toEqual([
        expect.objectContaining({
          uri: `threadnote://user/${user}/memories/durable/projects/threadnote/zzz-active.md`,
        }),
      ]);
      expect(expandedTruncatedSelectorCount).toBe(0);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  it('derives an order-invariant selector set and repository-isolated digests (properties)', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({max: 31, min: 0}), {maxLength: 8, minLength: 1}), seeds => {
        const anchors = EffectArray.map(seeds, seed =>
          citation({
            repositoryId: Effect2.pipe('d', EffectString.repeat(64)),
            symbolSeed: Effect2.pipe(seed.toString(16), EffectString.padStart(2, '0')),
          }),
        );
        expect(selectorProjection(deriveRecallCodeLinkQuerySelectors(anchors))).toEqual(
          selectorProjection(deriveRecallCodeLinkQuerySelectors([...anchors].reverse())),
        );
      }),
      {numRuns: 48},
    );
    fc.assert(
      fc.property(
        fc.tuple(hexCharacter, hexCharacter).filter(([left, right]) => left !== right),
        ([left, right]) => {
          const leftSelectors = selectorProjection(
            deriveRecallCodeLinkQuerySelectors([
              citation({repositoryId: Effect2.pipe(left, EffectString.repeat(64)), symbolSeed: '4'}),
            ]),
          );
          const rightSelectors = new Set(
            selectorProjection(
              deriveRecallCodeLinkQuerySelectors([
                citation({repositoryId: Effect2.pipe(right, EffectString.repeat(64)), symbolSeed: '4'}),
              ]),
            ),
          );
          expect(EffectArray.every(leftSelectors, selector => !rightSelectors.has(selector))).toBe(true);
        },
      ),
      {numRuns: 48},
    );
  });

  fcEffectProp(
    effectIt,
    'matches an independent bounded citation-winner and round-robin reference model (property)',
    {
      documents: fc.array(fc.uniqueArray(fc.integer({max: 2, min: 0}), {maxLength: 3, minLength: 1}), {
        maxLength: 10,
        minLength: 1,
      }),
      limit: fc.integer({max: 8, min: 1}),
    },
    ({documents, limit}) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-code-links-model-'});
        const user = 'model-user';
        const repositoryId = Effect2.pipe('2', EffectString.repeat(64));
        const anchors = Array.from({length: 3}, (_, index) =>
          citation({path: `src/target-${index}.ts`, repositoryId, symbolSeed: String(index + 1)}),
        );
        const modeled: Array<RecallCodeLinkReferenceRow & {readonly assignments: readonly number[]}> = [];
        for (const [documentIndex, assignments] of documents.entries()) {
          const topic = `document-${Effect2.pipe(String(documentIndex), EffectString.padStart(2, '0'))}`;
          yield* writeMemory(
            fs,
            path,
            home,
            user,
            'threadnote',
            topic,
            EffectArray.map(assignments, anchorOrdinal => anchors[anchorOrdinal]),
          );
          modeled.push({
            anchorOrdinal: assignments[0],
            assignments,
            citationId: anchors[assignments[0]].id,
            citationOrdinal: 0,
            matchKind: 'symbol-node',
            uri: `threadnote://user/${user}/memories/durable/projects/threadnote/${topic}.md`,
          });
        }
        const scanLimit = limit * 4;
        const boundedModeled = EffectArray.flatMap(anchors, (_, anchorOrdinal) =>
          EffectArray.filter(
            EffectArray.filter(modeled, row => row.assignments.includes(anchorOrdinal)).slice(0, scanLimit),
            row => row.anchorOrdinal === anchorOrdinal,
          ),
        );
        const anchorRanks = new Map<number, number>();
        const expected = EffectArray.map(
          EffectArray.map(
            boundedModeled.sort(
              (left, right) => left.anchorOrdinal - right.anchorOrdinal || compareReferenceText(left.uri, right.uri),
            ),
            row => {
              const anchorRank = (anchorRanks.get(row.anchorOrdinal) ?? 0) + 1;
              anchorRanks.set(row.anchorOrdinal, anchorRank);
              return {...row, anchorRank};
            },
          )
            .sort(
              (left, right) =>
                left.anchorRank - right.anchorRank ||
                left.anchorOrdinal - right.anchorOrdinal ||
                compareReferenceText(left.uri, right.uri),
            )
            .slice(0, limit),
          ({anchorRank: _anchorRank, assignments: _assignments, ...row}) => row,
        );
        const actual = yield* loadRecallCodeLinks(
          {account: 'local', agentContextHome: home, user},
          {anchors, forceRefresh: true, includeInactive: false, limit, project: 'threadnote'},
        );
        expect(actual).toEqual(expected);
      }).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 16}},
  );
});

interface RecallCodeLinkReferenceRow {
  readonly anchorOrdinal: number;
  readonly citationId: string;
  readonly citationOrdinal: number;
  readonly matchKind: 'symbol-node';
  readonly uri: string;
}

const hexCharacter = fc.constantFrom(...'0123456789abcdef');

function compareReferenceText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function citation(input: {
  readonly path?: string;
  readonly repositoryId: string;
  readonly symbolSeed: string | undefined;
}): MemoryCodeCitationV1 {
  const path = input.path ?? 'src/target.ts';
  const contentHashSeed =
    Effect2.pipe(input.symbolSeed, effectOptionalString =>
      effectOptionalString == null
        ? undefined
        : Effect2.pipe(
            effectOptionalString,
            EffectString.at(-1),
            Effect2.Option.getOrElse(() => undefined),
          ),
    ) ?? 'e';
  return createMemoryCodeCitation({
    extractorSet: 'native-code-graph-test',
    fileContentHash: {algorithm: 'sha256', value: Effect2.pipe(contentHashSeed, EffectString.repeat(64))},
    path,
    repositoryId: input.repositoryId,
    repositoryIdentityKind: 'remote',
    sourceCommit: Effect2.pipe('f', EffectString.repeat(40)),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${Effect2.pipe('0', EffectString.repeat(40))}`,
    target:
      input.symbolSeed === undefined
        ? {kind: 'file'}
        : {
            fragmentCanonicalization: 'utf8-source-span-v1',
            fragmentHash: {algorithm: 'sha256', value: Effect2.pipe(input.symbolSeed, EffectString.padEnd(64, '0'))},
            kind: 'symbol',
            language: 'typescript',
            name: `target${input.symbolSeed}`,
            nodeId: `cgs_${Effect2.pipe(input.symbolSeed, EffectString.padEnd(32, '0'))}`,
            qualifiedName: `target${input.symbolSeed}`,
            span: {column: 1, endColumn: 2, endLine: 1, line: 1},
            symbolKind: 'function',
          },
    version: 1,
  });
}

function selectorProjection(selectors: readonly RecallCodeLinkQuerySelector[]): readonly string[] {
  return EffectArray.map(selectors, selector => `${selector.selectorKind}:${selector.selectorDigest}`).sort();
}

function writeMemory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  user: string,
  project: string,
  topic: string,
  citations: readonly MemoryCodeCitationV1[],
  archived = false,
) {
  return Effect.gen(function* () {
    const filePath = path.join(
      home,
      'data',
      'local',
      'user',
      user,
      'memories',
      'durable',
      ...(archived ? ['archived'] : ['projects']),
      project,
      `${topic}.md`,
    );
    yield* fs.makeDirectory(path.dirname(filePath), {recursive: true});
    yield* fs.writeFileString(
      filePath,
      formatMemoryDocument(
        'MEMORY',
        {
          codeCitations: citations,
          kind: 'durable',
          project,
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'codex',
          status: archived ? 'archived' : 'active',
          timestamp: '2026-08-28T00:00:00.000Z',
          topic,
        },
        `Memory body for ${topic}.`,
      ),
    );
    return filePath;
  });
}

function writeResourceMemory(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  topic: string,
  citation: MemoryCodeCitationV1,
) {
  return Effect.gen(function* () {
    const filePath = path.join(home, 'data', 'local', 'resources', 'repos', 'threadnote', `${topic}.md`);
    yield* fs.makeDirectory(path.dirname(filePath), {recursive: true});
    yield* fs.writeFileString(
      filePath,
      formatMemoryDocument(
        'MEMORY',
        {
          codeCitations: [citation],
          kind: 'durable',
          project: 'threadnote',
          schemaVersion: MEMORY_SCHEMA_VERSION,
          sourceAgentClient: 'resource-fixture',
          status: 'active',
          timestamp: '2026-08-28T00:00:00.000Z',
          topic,
        },
        `Resource record for ${topic}.`,
      ),
    );
  });
}
