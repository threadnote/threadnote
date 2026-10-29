import {Array as EffectArray} from 'effect';
import {Database} from 'bun:sqlite';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {describe, expect} from 'vitest';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {formatMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import {memoryIdentityAlias} from '@threadnote/memory/identity-alias';
import {
  buildBoundedRecallMemoryLinkRawQuery,
  MAX_INDEXED_MEMORY_LINKS_PER_SOURCE,
  memoryLinkLocatorDigest,
} from '@threadnote/recall/memory/links';
import {
  clearRecallIndexMemoryCache,
  expireRecallIndexValidation,
  loadRecallIndexData,
  recallIndexDatabaseFilename,
} from '@threadnote/recall/index';
import {provideTestLayer} from '../helpers/effect-layer.js';

interface MemoryLinkRow {
  readonly relation_ordinal: number;
  readonly relation_origin: string;
  readonly relation_type: string;
  readonly source_memory_id: string;
  readonly source_uri: string;
  readonly target_locator_digest: string;
  readonly target_memory_id: string;
}

describe('recall memory links', () => {
  effectIt.effect('projects canonical origins into schema-v13 selectors with private source ordering', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-memory-links-'});
      const user = 'memory-link-user';
      const targetUri = memoryUri(user, 'legacy-target');
      yield* writeMemory(fs, path, home, user, 'legacy-target', 'tn_legacy_target');
      for (const id of ['tn_alias_target', 'tn_reference_target', 'tn_evidence_target', 'tn_superseded_target']) {
        yield* writeMemory(fs, path, home, user, id, id);
      }
      yield* writeMemory(fs, path, home, user, 'source', 'tn_source', {
        evidence: ['commit:abc123', memoryIdentityAlias('tn_evidence_target')],
        references: [memoryIdentityAlias('tn_reference_target')],
        relations: [
          {type: 'depends_on', uri: memoryIdentityAlias('tn_alias_target')},
          {type: 'related_to', uri: targetUri},
        ],
        supersedes: memoryIdentityAlias('tn_superseded_target'),
      });
      const sourceUri = memoryUri(user, 'source');
      yield* loadRecallIndexData(config(home, user), {forceRefresh: true, includeInactive: false});

      const rows = yield* Effect.sync(() => readMemoryLinks(home));
      expect(EffectArray.filter(rows, row => row.source_uri === sourceUri)).toEqual([
        {
          relation_ordinal: 1,
          relation_origin: 'evidence',
          relation_type: 'evidence_for',
          source_memory_id: 'tn_source',
          source_uri: sourceUri,
          target_locator_digest: '',
          target_memory_id: 'tn_evidence_target',
        },
        {
          relation_ordinal: 0,
          relation_origin: 'references',
          relation_type: 'references',
          source_memory_id: 'tn_source',
          source_uri: sourceUri,
          target_locator_digest: '',
          target_memory_id: 'tn_reference_target',
        },
        {
          relation_ordinal: 0,
          relation_origin: 'relation',
          relation_type: 'depends_on',
          source_memory_id: 'tn_source',
          source_uri: sourceUri,
          target_locator_digest: '',
          target_memory_id: 'tn_alias_target',
        },
        {
          relation_ordinal: 1,
          relation_origin: 'relation',
          relation_type: 'related_to',
          source_memory_id: 'tn_source',
          source_uri: sourceUri,
          target_locator_digest: memoryLinkLocatorDigest(targetUri),
          target_memory_id: 'tn_legacy_target',
        },
        {
          relation_ordinal: 0,
          relation_origin: 'supersedes',
          relation_type: 'supersedes',
          source_memory_id: 'tn_source',
          source_uri: sourceUri,
          target_locator_digest: '',
          target_memory_id: 'tn_superseded_target',
        },
      ]);

      const schema = yield* Effect.sync(() => inspectMemoryLinkSchema(home));
      expect(schema.columns).toEqual([
        'source_document_id',
        'source_uri',
        'source_memory_id',
        'target_memory_id',
        'target_locator_digest',
        'relation_type',
        'relation_origin',
        'relation_ordinal',
      ]);
      expect(schema.sourceIndex).toEqual([
        'source_memory_id',
        'relation_type',
        'source_uri',
        'relation_origin',
        'relation_ordinal',
        'target_memory_id',
        'target_locator_digest',
        'source_document_id',
      ]);
      expect(schema.targetIndex[0]).toBe('target_memory_id');
      expect(schema.locatorIndex[0]).toBe('target_locator_digest');
      const plans = yield* Effect.sync(() => inspectBoundedMemoryLinkPlans(home, user));
      expect(plans.incoming).toMatch(/SEARCH memory_link USING (?:COVERING )?INDEX memory_links_target/u);
      expect(plans.outgoing).toMatch(/SEARCH memory_link USING (?:COVERING )?INDEX memory_links_source/u);
      expect(plans.currentness).toMatch(/SEARCH memory_link USING (?:COVERING )?INDEX memory_links_target/u);
      expect(`${plans.incoming}\n${plans.outgoing}\n${plans.currentness}`).not.toMatch(
        /\bSCAN memory_link\b|ranked_links/u,
      );
      expect(plans.currentnessSql).toContain('AS source_valid_from');
      expect(plans.currentnessParams).not.toContain('2026-08-31T12:00:00.000Z');
      const storedSelectors = EffectArray.map(rows, ({source_uri: _sourceUri, ...row}) => row);
      expect(JSON.stringify(storedSelectors)).not.toContain('threadnote://');
      expect(JSON.stringify(storedSelectors)).not.toContain('source body');
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('re-resolves legacy targets and retires replaced or deleted source edges transactionally', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-memory-links-refresh-'});
      const user = 'memory-link-refresh-user';
      const targetUri = memoryUri(user, 'late-target');
      const sourcePath = yield* writeMemory(fs, path, home, user, 'source', 'tn_source', {
        relations: [{type: 'depends_on', uri: targetUri}],
      });
      const runtime = config(home, user);

      yield* loadRecallIndexData(runtime, {forceRefresh: true, includeInactive: false});
      expect(readMemoryLinks(home)).toEqual([
        expect.objectContaining({target_locator_digest: memoryLinkLocatorDigest(targetUri), target_memory_id: ''}),
      ]);

      const targetPath = yield* writeMemory(fs, path, home, user, 'late-target', 'tn_target_v1');
      yield* expireRecallIndexValidation(home, false, [targetUri]);
      yield* loadRecallIndexData(runtime, {includeInactive: false});
      expect(readMemoryLinks(home)[0]).toMatchObject({target_memory_id: 'tn_target_v1'});

      yield* writeMemory(fs, path, home, user, 'late-target', 'tn_target_v2');
      yield* expireRecallIndexValidation(home, false, [targetUri]);
      yield* loadRecallIndexData(runtime, {includeInactive: false});
      expect(readMemoryLinks(home)[0]).toMatchObject({target_memory_id: 'tn_target_v2'});

      yield* fs.remove(targetPath);
      yield* expireRecallIndexValidation(home, false, [targetUri]);
      yield* loadRecallIndexData(runtime, {includeInactive: false});
      const incremental = readMemoryLinks(home);
      expect(incremental[0]).toMatchObject({target_memory_id: ''});

      yield* fs.remove(path.join(home, 'indexes', 'lexical'), {force: true, recursive: true});
      yield* clearRecallIndexMemoryCache();
      yield* loadRecallIndexData(runtime, {forceRefresh: true, includeInactive: false});
      expect(readMemoryLinks(home)).toEqual(incremental);

      yield* writeMemory(fs, path, home, user, 'source', 'tn_source', {
        relations: [{type: 'evidence_for', uri: memoryIdentityAlias('tn_other_target')}],
      });
      yield* expireRecallIndexValidation(home, false, [memoryUri(user, 'source')]);
      yield* loadRecallIndexData(runtime, {includeInactive: false});
      expect(readMemoryLinks(home)).toEqual([
        expect.objectContaining({
          relation_type: 'evidence_for',
          target_locator_digest: '',
          target_memory_id: 'tn_other_target',
        }),
      ]);

      yield* fs.remove(sourcePath);
      yield* expireRecallIndexValidation(home, false, [memoryUri(user, 'source')]);
      yield* loadRecallIndexData(runtime, {includeInactive: false});
      expect(readMemoryLinks(home)).toEqual([]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('preserves stable alias edges when the target path moves', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-memory-links-move-'});
      const user = 'memory-link-move-user';
      const oldTargetUri = memoryUri(user, 'old-target');
      const oldTargetPath = yield* writeMemory(fs, path, home, user, 'old-target', 'tn_moving_target');
      yield* writeMemory(fs, path, home, user, 'alias-source', 'tn_alias_source', {
        relations: [{type: 'depends_on', uri: memoryIdentityAlias('tn_moving_target')}],
      });
      yield* writeMemory(fs, path, home, user, 'legacy-source', 'tn_legacy_source', {
        relations: [{type: 'depends_on', uri: oldTargetUri}],
      });
      const runtime = config(home, user);
      yield* loadRecallIndexData(runtime, {forceRefresh: true, includeInactive: false});

      const movedPath = memoryPath(path, home, user, 'moved-target');
      yield* fs.rename(oldTargetPath, movedPath);
      yield* expireRecallIndexValidation(home, false, [oldTargetUri, memoryUri(user, 'moved-target')]);
      yield* loadRecallIndexData(runtime, {includeInactive: false});

      expect(readMemoryLinks(home)).toEqual([
        expect.objectContaining({source_memory_id: 'tn_alias_source', target_memory_id: 'tn_moving_target'}),
        expect.objectContaining({
          source_memory_id: 'tn_legacy_source',
          target_locator_digest: memoryLinkLocatorDigest(oldTargetUri),
          target_memory_id: '',
        }),
      ]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('does not resolve legacy locators to inactive targets in the with-inactive index', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-memory-links-inactive-'});
      const user = 'memory-link-inactive-user';
      const targetUri = memoryUri(user, 'archived-target');
      yield* writeMemory(fs, path, home, user, 'archived-target', 'tn_archived_target', {status: 'archived'});
      yield* writeMemory(fs, path, home, user, 'source', 'tn_active_source', {
        relations: [{type: 'references', uri: targetUri}],
      });

      yield* loadRecallIndexData(config(home, user), {forceRefresh: true, includeInactive: true});

      expect(readMemoryLinks(home, true)).toEqual([
        expect.objectContaining({
          target_locator_digest: memoryLinkLocatorDigest(targetUri),
          target_memory_id: '',
        }),
      ]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('repairs out-of-band memory-link updates and deletes through the integrity sequence', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-memory-links-integrity-'});
      const user = 'memory-link-integrity-user';
      yield* writeMemory(fs, path, home, user, 'target', 'tn_integrity_target');
      yield* writeMemory(fs, path, home, user, 'source', 'tn_integrity_source', {
        relations: [{type: 'depends_on', uri: memoryIdentityAlias('tn_integrity_target')}],
      });
      const runtime = config(home, user);
      yield* loadRecallIndexData(runtime, {forceRefresh: true, includeInactive: false});
      const expected = readMemoryLinks(home);

      mutateMemoryLinks(home, "UPDATE memory_links SET relation_type = 'related_to'");
      expect(readMemoryLinks(home)[0]).toMatchObject({relation_type: 'related_to'});
      yield* loadRecallIndexData(runtime, {includeInactive: false});
      expect(readMemoryLinks(home)).toEqual(expected);

      mutateMemoryLinks(home, "UPDATE memory_links SET source_uri = 'threadnote://user/other/memories/source.md'");
      const query = buildBoundedRecallMemoryLinkRawQuery(
        'incoming',
        [{memoryId: 'tn_integrity_target', requestedOrdinal: 0}],
        {allowedUriScopes: [`threadnote://user/${user}/memories`]},
        5,
      )!;
      const selected = yield* Effect.acquireUseRelease(
        Effect.sync(
          () => new Database(`${home}/indexes/lexical/${recallIndexDatabaseFilename(false)}`, {readonly: true}),
        ),
        database => Effect.sync(() => database.query(query.sql).all(...query.params)),
        database => Effect.sync(() => database.close()),
      );
      expect(selected).toEqual([]);
      yield* loadRecallIndexData(runtime, {includeInactive: false});
      expect(readMemoryLinks(home)).toEqual(expected);

      mutateMemoryLinks(home, 'DELETE FROM memory_links');
      expect(readMemoryLinks(home)).toEqual([]);
      yield* loadRecallIndexData(runtime, {includeInactive: false});
      expect(readMemoryLinks(home)).toEqual(expected);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retains explicit supersession when lower-priority legacy fanout is truncated', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-recall-memory-links-cap-'});
      const user = 'memory-link-cap-user';
      yield* writeMemory(fs, path, home, user, 'source', 'tn_capped_source', {
        relations: Array.from({length: MAX_INDEXED_MEMORY_LINKS_PER_SOURCE}, (_, index) => ({
          type: 'references' as const,
          uri: memoryIdentityAlias(`tn_reference_${index}`),
        })),
        supersedes: memoryIdentityAlias('tn_explicit_history'),
      });

      yield* loadRecallIndexData(config(home, user), {forceRefresh: true, includeInactive: false});

      const rows = readMemoryLinks(home);
      expect(rows).toHaveLength(MAX_INDEXED_MEMORY_LINKS_PER_SOURCE);
      expect(rows).toContainEqual(
        expect.objectContaining({
          relation_origin: 'supersedes',
          target_memory_id: 'tn_explicit_history',
        }),
      );
      expect(readMemoryLinkTruncation(home)).toBe(1);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function config(home: string, user: string) {
  return {account: 'local', agentContextHome: home, user};
}

function memoryUri(user: string, topic: string): string {
  return `threadnote://user/${user}/memories/durable/projects/threadnote/${topic}.md`;
}

function memoryPath(path: Path.Path, home: string, user: string, topic: string): string {
  return path.join(home, 'data', 'local', 'user', user, 'memories', 'durable', 'projects', 'threadnote', `${topic}.md`);
}

const writeMemory = Effect.fn('test.writeMemoryLinkMemory')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  user: string,
  topic: string,
  memoryId: string,
  extra: Partial<MemoryMetadata> = {},
) {
  const target = memoryPath(path, home, user, topic);
  yield* fs.makeDirectory(path.dirname(target), {recursive: true});
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId,
    project: 'threadnote',
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-08-31T00:00:00.000Z',
    topic,
    ...extra,
  };
  yield* fs.writeFileString(target, formatMemoryDocument('MEMORY', metadata, `${topic} body`));
  return target;
});

function readMemoryLinks(home: string, includeInactive = false): readonly MemoryLinkRow[] {
  const database = new Database(`${home}/indexes/lexical/${recallIndexDatabaseFilename(includeInactive)}`, {
    readonly: true,
  });
  try {
    return database
      .query<MemoryLinkRow, []>(
        `SELECT
          link.source_uri,
          link.source_memory_id,
          link.target_memory_id,
          link.target_locator_digest,
          link.relation_type,
          link.relation_origin,
          link.relation_ordinal
        FROM memory_links AS link
        INNER JOIN documents AS source ON source.id = link.source_document_id
        ORDER BY source.uri, link.relation_origin, link.relation_ordinal, link.relation_type`,
      )
      .all();
  } finally {
    database.close();
  }
}

function inspectMemoryLinkSchema(home: string) {
  const database = new Database(`${home}/indexes/lexical/${recallIndexDatabaseFilename(false)}`, {readonly: true});
  const columns = (name: string) =>
    EffectArray.map(database.query<{readonly name: string}, []>(`PRAGMA index_info(${name})`).all(), row => row.name);
  try {
    return {
      columns: EffectArray.map(
        database.query<{readonly name: string}, []>('PRAGMA table_info(memory_links)').all(),
        row => row.name,
      ),
      locatorIndex: columns('memory_links_locator'),
      sourceIndex: columns('memory_links_source'),
      targetIndex: columns('memory_links_target'),
    };
  } finally {
    database.close();
  }
}

function inspectBoundedMemoryLinkPlans(home: string, user: string) {
  const options = {allowedUriScopes: [`threadnote://user/${user}/memories`], includeInactive: false};
  const incoming = buildBoundedRecallMemoryLinkRawQuery(
    'incoming',
    [
      {memoryId: 'tn_alias_target', requestedOrdinal: 0},
      {memoryId: 'tn_reference_target', requestedOrdinal: 1},
    ],
    options,
    5,
  );
  const outgoing = buildBoundedRecallMemoryLinkRawQuery(
    'outgoing',
    [
      {memoryId: 'tn_source', requestedOrdinal: 0},
      {memoryId: 'tn_legacy_target', requestedOrdinal: 1},
    ],
    options,
    5,
  );
  const currentness = buildBoundedRecallMemoryLinkRawQuery(
    'incoming',
    [{memoryId: 'tn_superseded_target', requestedOrdinal: 0}],
    {
      allowedUriScopes: [`threadnote://user/${user}/memories`],
      includeInactive: true,
      sourceCurrentAt: new Date('2026-08-31T12:00:00.000Z'),
    },
    3,
  );
  if (incoming === undefined || outgoing === undefined || currentness === undefined) {
    throw new Error('Bounded memory-link query was not built.');
  }
  const database = new Database(`${home}/indexes/lexical/${recallIndexDatabaseFilename(false)}`, {readonly: true});
  try {
    const plan = (query: NonNullable<typeof incoming>) =>
      EffectArray.join(
        EffectArray.map(
          database
            .query<{readonly detail: string}, Array<number | string>>(`EXPLAIN QUERY PLAN ${query.sql}`)
            .all(...query.params),
          row => row.detail,
        ),
        '\n',
      );
    return {
      currentness: plan(currentness),
      currentnessParams: currentness.params,
      currentnessSql: currentness.sql,
      incoming: plan(incoming),
      outgoing: plan(outgoing),
    };
  } finally {
    database.close();
  }
}

function readMemoryLinkTruncation(home: string): number {
  const database = new Database(`${home}/indexes/lexical/${recallIndexDatabaseFilename(false)}`, {readonly: true});
  try {
    return (
      database
        .query<{readonly memory_links_truncated: number}, []>(
          'SELECT memory_links_truncated FROM documents WHERE memory_links_truncated = 1',
        )
        .get()?.memory_links_truncated ?? 0
    );
  } finally {
    database.close();
  }
}

function mutateMemoryLinks(home: string, statement: string): void {
  const database = new Database(`${home}/indexes/lexical/${recallIndexDatabaseFilename(false)}`);
  try {
    database.run(statement);
  } finally {
    database.close();
  }
}
