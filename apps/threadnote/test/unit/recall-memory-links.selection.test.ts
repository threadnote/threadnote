import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {Database} from 'bun:sqlite';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import * as FC from 'fast-check';
import {describe, expect} from 'vitest';

import {formatMemoryDocument, MEMORY_RELATION_TYPES} from '@threadnote/memory/document';
import {memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {loadRecallIndexData, recallIndexDatabaseFilename} from '@threadnote/recall/index';
import {buildBoundedRecallMemoryLinkRawQuery} from '@threadnote/recall/memory/links';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Option as EffectOption} from 'effect';

const RecallIndexTestLayer = Layer.merge(BunServices.layer, TestSystemInfoLayer);
const user = 'ordered-memory-selector';
const prefix = `threadnote://user/${user}/memories/durable/projects/threadnote`;
interface Source {
  readonly active: boolean;
  readonly allowed: boolean;
  readonly relation: (typeof MEMORY_RELATION_TYPES)[number];
}
interface SelectedRow {
  readonly relation_ordinal: number;
  readonly relation_origin: string;
  readonly relation_type: string;
  readonly source_uri: string;
  readonly target_memory_id: string;
}
interface PlanRow {
  readonly detail: string;
  readonly id: number;
  readonly parent: number;
}
const source = FC.record({
  active: FC.boolean(),
  allowed: FC.boolean(),
  relation: FC.constantFrom(...MEMORY_RELATION_TYPES),
});

describe('bounded memory-link selector order', () => {
  effectIt.effect(
    'limits dense incoming and outgoing neighborhoods before the final bounded sort',
    () =>
      Effect.gen(function* () {
        const sources = Array.from({length: 320}, () => ({
          active: true,
          allowed: true,
          relation: 'related_to' as const,
        }));
        const home = yield* createFixture(sources);
        yield* withDatabase(home, database => {
          // Reassign cache row IDs without changing any source or link. URI order
          // must not accidentally depend on insertion order or integer IDs.
          database.transaction(() => {
            database.exec('UPDATE documents SET id = 10000 - id');
            database.exec('UPDATE memory_links SET source_document_id = 10000 - source_document_id');
          })();
          for (const direction of ['incoming', 'outgoing'] as const) {
            const query = buildBoundedRecallMemoryLinkRawQuery(
              direction,
              [{memoryId: direction === 'incoming' ? 'tn_hub' : 'tn_shared_source', requestedOrdinal: 0}],
              {allowedUriScopes: [prefix], includeInactive: true},
              257,
            )!;
            const plan = database
              .query<PlanRow, Array<number | string>>(`EXPLAIN QUERY PLAN ${query.sql}`)
              .all(...query.params);
            const selector = EffectOption.getOrUndefined(
              EffectArray.findFirst(
                plan,
                __effectArrayValue =>
                  !!(row =>
                    Effect2.pipe(
                      row.detail,
                      EffectString.includes(`INDEX memory_links_${direction === 'incoming' ? 'target' : 'source'}`),
                    ))(__effectArrayValue),
              ),
            );
            expect(selector).toBeDefined();
            expect(
              EffectArray.every(
                EffectArray.filter(plan, row => Effect2.pipe(row.detail, EffectString.includes('TEMP B-TREE'))),
                row => row.parent === 0,
              ),
            ).toBe(true);
            expect(
              EffectArray.some(plan, row => Effect2.pipe(row.detail, EffectString.startsWith('SCAN memory_link'))),
            ).toBe(false);
            const rows = database.query<SelectedRow, Array<number | string>>(query.sql).all(...query.params);
            expect(rows).toHaveLength(257);
            expect(EffectArray.map(rows, row => row.source_uri)).toEqual(
              EffectArray.map(sources.slice(0, 257), (_, index) => uri(index)),
            );
          }
        });
      }).pipe(provideTestLayer(RecallIndexTestLayer)),
    30_000,
  );

  fcEffectProp(
    effectIt,
    'matches an independent filtered and ordered model before each per-seed limit',
    {
      sources: FC.array(source, {minLength: 1, maxLength: 20}),
      includeInactive: FC.boolean(),
      limit: FC.integer({min: 1, max: 8}),
      relationTypes: FC.subarray([...MEMORY_RELATION_TYPES]),
    },
    ({sources, includeInactive, limit, relationTypes}) =>
      Effect.gen(function* () {
        const home = yield* createFixture(sources);
        yield* withDatabase(home, database => {
          const allowedUriScopes = [
            `${prefix}/missing.md`,
            ...EffectArray.flatMap(sources, (entry, index) => (entry.allowed ? [uri(index)] : [])),
          ];
          for (const direction of ['incoming', 'outgoing'] as const) {
            const query = buildBoundedRecallMemoryLinkRawQuery(
              direction,
              [{memoryId: direction === 'incoming' ? 'tn_hub' : 'tn_shared_source', requestedOrdinal: 0}],
              {allowedUriScopes, includeInactive, relationTypes},
              limit,
            )!;
            const actual = EffectArray.map(
              database.query<SelectedRow, Array<number | string>>(query.sql).all(...query.params),
              projectRow,
            );
            const expected = EffectArray.flatMap(sources, (entry, index) =>
              entry.allowed &&
              (includeInactive || entry.active) &&
              (relationTypes.length === 0 || relationTypes.includes(entry.relation))
                ? [
                    {
                      relation_ordinal: 0,
                      relation_origin: 'relation',
                      relation_type: entry.relation,
                      source_uri: uri(index),
                      target_memory_id: 'tn_hub',
                    },
                  ]
                : [],
            )
              .sort(
                (a, b) => compareBinary(a.relation_type, b.relation_type) || compareBinary(a.source_uri, b.source_uri),
              )
              .slice(0, limit);
            expect(actual).toEqual(expected);
          }
        });
      }).pipe(provideTestLayer(RecallIndexTestLayer)),
    {fastCheck: {numRuns: 32}, timeout: 30_000},
  );
});

function compareBinary(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function projectRow(row: SelectedRow): SelectedRow {
  return {
    relation_ordinal: row.relation_ordinal,
    relation_origin: row.relation_origin,
    relation_type: row.relation_type,
    source_uri: row.source_uri,
    target_memory_id: row.target_memory_id,
  };
}

function uri(index: number): string {
  return `${prefix}/source-${Effect2.pipe(String(index), EffectString.padStart(4, '0'))}.md`;
}

const createFixture = Effect.fn('test.createOrderedMemoryLinkFixture')(function* (sources: readonly Source[]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-memory-link-order-'});
  const directory = path.join(home, 'data', 'local', 'user', user, 'memories', 'durable', 'projects', 'threadnote');
  yield* fs.makeDirectory(directory, {recursive: true});
  for (const [index, entry] of sources.entries()) {
    const topic = `source-${Effect2.pipe(String(index), EffectString.padStart(4, '0'))}`;
    yield* fs.writeFileString(
      path.join(directory, `${topic}.md`),
      formatMemoryDocument(
        'MEMORY',
        {
          kind: 'durable',
          memoryId: 'tn_shared_source',
          project: 'threadnote',
          relations: [{type: entry.relation, uri: memoryIdentityAlias('tn_hub')}],
          sourceAgentClient: 'test',
          status: entry.active ? 'active' : 'archived',
          timestamp: '2026-09-08T00:00:00.000Z',
          topic,
        },
        `${topic} body`,
      ),
    );
  }
  yield* loadRecallIndexData(
    {account: 'local', agentContextHome: home, user},
    {forceRefresh: true, includeInactive: true},
  );
  return home;
});

function withDatabase<A>(home: string, use: (database: Database) => A) {
  return Effect.acquireUseRelease(
    Effect.sync(() => new Database(`${home}/indexes/lexical/${recallIndexDatabaseFilename(true)}`)),
    database => Effect.sync(() => use(database)),
    database => Effect.sync(() => database.close()),
  );
}
